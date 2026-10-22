import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis node capacity with atomic allocation',
  concept: 'redis',
  file: 'state',
  focus: ['scheduler', 'registry', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: one allocation on an idle node
succeeds, the demo job is placed and the counters look right. It hides four defects. Review it like
the owner of the node ledger, fix it, and prove the fix with the checks below.

The ledger the placement path calls lives in Redis:

- Each node owns the hash \`node:{id}\` with \`capacity_gpus\`, \`capacity_memory_gb\`,
  \`allocated_gpus\` and \`allocated_memory_gb\`. Registration writes the two capacity fields; every
  allocation and release moves the two \`allocated_*\` counters. A request is admitted only while
  \`allocated + wanted\` still fits under capacity — the counters the scheduler reads are the ones it
  has to move.
- Allocation must be **one atomic server-side operation**: a Lua \`EVAL\` that reads capacity and
  allocated, refuses the request when it does not fit, and moves \`allocated_*\` in the same call. A
  client-side \`HGET\` followed by a separate \`HINCRBY\` leaves a window in which two placements both
  read the same free count and both decide they fit.
- The counter move and the placement record \`placement:{id}\` are **one decision**. The draft writes
  the record first and moves the counters afterwards, so a second placement can claim the GPUs the
  first one already promised while the counters still agree with the first request.
- \`heartbeat:{id}\` is a TTL marker set to \`HEARTBEAT_TTL_S\` (**30** seconds). While it exists the
  node is schedulable; when it lapses the node is dead. The handler checks the node is alive before
  it selects it. The draft never sets a TTL, so a machine that died hours ago stays in the scheduling
  set forever and keeps being handed work.
- Release is **idempotent** and keyed by the placement id: \`released:{placement_id}\` is set with
  \`SET ... NX EX\`, and the release script moves \`allocated_*\` only when the marker was newly set. A
  doubled release that simply decrements again inflates free capacity and lets the next placement
  oversubscribe the node.
- The loser of a race is reported honestly: the script returns \`NO_CAPACITY\` and the handler answers
  **409** instead of granting capacity it could not move. The draft's client-side check looks fine
  serially, but under load it grants what the ledger cannot back.

**What each check looks for.**

1. \`node-ledger-keys\` — the counters live under the node's own key: \`node:{id}\` with the
   \`capacity_gpus\` and \`allocated_gpus\` fields, moved by allocation and release. The draft already
   keys per node, so this check passes on it; the four below are where it fails.
2. \`atomic-allocation\` — one \`EVAL\` of \`NODE_ALLOCATE_LUA\` reads capacity and allocated, compares
   and moves the counters in the same script, and the draft's client-side \`HINCRBY\` is gone.
3. \`heartbeat-liveness\` — \`HEARTBEAT_TTL_S\`, the \`heartbeat:{id}\` key and a \`node_alive\` check
   gate every allocation, so a node whose heartbeat lapsed is refused before it is selected.
4. \`idempotent-release\` — \`RELEASE_LUA\` moves the counters only behind a \`released:{placement_id}\`
   marker set with \`SET ... NX\`, so a doubled release cannot inflate capacity.
5. \`honest-contention\` — the script's \`NO_CAPACITY\` result is mapped to **409** rather than a grant,
   so the loser of a race is told it lost instead of being handed GPUs the ledger cannot back.

**Failure mode the checks target.** The client-side check and the post-record counter move are the
same bug seen twice: both leave a gap between reading the free count and claiming it, and both are
invisible until two placements race. A heartbeat that never expires keeps dead machines in the
scheduling set, and a release that is not keyed by the placement id turns a retried release into
capacity the fleet does not have.`,
  sequence: {
    participants: ['Node agent', 'GPU Scheduler', 'Redis'],
    messages: [
      {
        from: 'Node agent',
        to: 'GPU Scheduler',
        label: 'POST /v1/nodes/gpu-7/register · {capacity_gpus: 8, capacity_memory_gb: 320}',
        kind: 'sync',
      },
      {
        from: 'GPU Scheduler',
        to: 'Redis',
        label: 'HSET node:gpu-7 capacity_gpus · SET heartbeat:gpu-7 1 EX 30',
        kind: 'sync',
      },
      {
        from: 'GPU Scheduler',
        to: 'Redis',
        label: 'EVAL NODE_ALLOCATE_LUA · KEYS[node:gpu-7, heartbeat:gpu-7, placement:p-1]',
        kind: 'sync',
      },
      {
        from: 'Redis',
        to: 'GPU Scheduler',
        label: '{1, allocated_gpus, allocated_memory_gb} — the record and the counters land together',
        kind: 'reply',
      },
      {
        from: 'GPU Scheduler',
        to: 'GPU Scheduler',
        label: '{-2} → 409 NO_HEARTBEAT when heartbeat:gpu-7 has lapsed',
        kind: 'sync',
      },
      {
        from: 'GPU Scheduler',
        to: 'GPU Scheduler',
        label: '{-1} → 409 NO_CAPACITY when the node cannot fit the request',
        kind: 'sync',
      },
      {
        from: 'GPU Scheduler',
        to: 'Redis',
        label: 'EVAL RELEASE_LUA · KEYS[node:gpu-7, released:p-1]',
        kind: 'sync',
      },
      {
        from: 'Redis',
        to: 'GPU Scheduler',
        label: '{0} — released:p-1 already existed, so nothing moved',
        kind: 'reply',
      },
    ],
  },
  hints: [
    'Do the whole decision in one script: `HGET capacity_gpus`, `HGET allocated_gpus`, compare, then `HINCRBY allocated_gpus` inside the same `EVAL`, so no placement can read the free count between the check and the move. A client-side `HGET` followed by a separate `HINCRBY` is the race — two placements both read the same number and both believe they fit. Move the counters in that script rather than after the placement record is written.',
    'A node is schedulable only while `heartbeat:{id}` still has a TTL. Set it with `HEARTBEAT_TTL_S` seconds when the node registers, check the key exists before the node is selected, and let the script refuse the request when the heartbeat has lapsed — a node that died hours ago must not keep taking work.',
    'Make release idempotent: `SET released:{placement_id} 1 NX EX ...` and move the counters only when the marker was newly set, so a doubled release cannot inflate capacity. And map the script’s `NO_CAPACITY` result to **409** — the loser of a race must be told it lost, not granted GPUs the ledger cannot back.',
  ],
  checks: [
    {
      id: 'node-ledger-keys',
      title: 'Per-node counters live under the node key',
      detail:
        'The counters live in Redis under the node’s own key: `node:{id}` carries the `capacity_gpus` and `allocated_gpus` fields, written by registration and moved by allocation and release. The draft already keys per node — this check passes on it — but the four below are where it fails: a shared key or a key without the node id would let one machine spend another’s capacity.',
      match: {
        python: {all: [/def node_key\(/, /node:\{node_id\}/, /capacity_gpus/, /allocated_gpus/]},
        typescript: {all: [/function nodeKey\(/, /node:\$\{nodeId\}/, /capacity_gpus/, /allocated_gpus/]},
        go: {all: [/func nodeKey\(/, /"node:"\s*\+/, /capacity_gpus/, /allocated_gpus/]},
        scala: {all: [/def nodeKey\(/, /node:\$nodeId/, /capacity_gpus/, /allocated_gpus/]},
        cpp: {all: [/std::string nodeKey\(/, /"node:"\s*\+/, /capacity_gpus/, /allocated_gpus/]},
      },
    },
    {
      id: 'atomic-allocation',
      title: 'One atomic script admits and moves the counters',
      detail:
        'Allocation is one `EVAL` of `NODE_ALLOCATE_LUA`: the script reads capacity and allocated, compares, and `HINCRBY`s `allocated_gpus` in the same call, writing the placement record in the same transaction. The draft reads the counters from the client and moves them only after the record is written, so two placements can both pass the same check and both be granted the same GPUs. A client-side `HINCRBY` of `allocated_gpus` is the flawed order.',
      match: {
        python: {
          all: [/NODE_ALLOCATE_LUA/, /\.eval\(/, /HINCRBY/, /HSET/],
          none: [/r\.hincrby\([^\n]*['"]allocated_gpus['"]/],
        },
        typescript: {
          all: [/NODE_ALLOCATE_LUA/, /\.eval\(/, /HINCRBY/, /HSET/],
          none: [/r\.hincrby\([^\n]*['"]allocated_gpus['"]/],
        },
        go: {
          all: [/(nodeAllocateScript|NewScript)/, /\.Run\(/, /HINCRBY/, /HSET/],
          none: [/rdb\.HIncrBy\([^\n]*"allocated_gpus"/],
        },
        scala: {
          all: [/NodeAllocateLua/, /\.eval\(\s*NodeAllocateLua/, /HINCRBY/, /HSET/],
          none: [/jedis\.hincrBy\([^\n]*"allocated_gpus"/],
        },
        cpp: {
          all: [/kNodeAllocateLua/, /\.eval</, /HINCRBY/, /HSET/],
          none: [/redis\.hincrby\([^\n]*"allocated_gpus"/],
        },
      },
    },
    {
      id: 'heartbeat-liveness',
      title: 'A node without a live heartbeat is refused',
      detail:
        '`heartbeat:{id}` carries a TTL of `HEARTBEAT_TTL_S` seconds, set when the node registers, and the `node_alive` check runs before the node is selected — the script refuses a node whose heartbeat key has lapsed with `NO_HEARTBEAT`. The draft never sets a TTL, so a node that died hours ago stays schedulable forever and keeps being handed placements.',
      match: {
        python: {all: [/HEARTBEAT_TTL_S/, /def heartbeat_key\(/, /def node_alive\(/]},
        typescript: {all: [/HEARTBEAT_TTL_S/, /function heartbeatKey\(/, /function nodeAlive\(/]},
        go: {all: [/heartbeatTtlSeconds/, /func heartbeatKey\(/, /func nodeAlive\(/]},
        scala: {all: [/HeartbeatTtlSeconds/, /def heartbeatKey\(/, /def nodeAlive\(/]},
        cpp: {all: [/kHeartbeatTtlSeconds/, /std::string heartbeatKey\(/, /nodeAlive\(/]},
      },
    },
    {
      id: 'idempotent-release',
      title: 'Release is idempotent, keyed by the placement id',
      detail:
        'Release runs `RELEASE_LUA`, which sets `released:{placement_id}` with `SET ... NX EX` and moves `allocated_*` only when the marker was newly set. The draft decrements the counters on every call, so a doubled release inflates free capacity and the next placement oversubscribes the node.',
      match: {
        python: {all: [/RELEASE_LUA/, /def released_key\(/, /\.eval\(\s*RELEASE_LUA/, /NX/]},
        typescript: {all: [/RELEASE_LUA/, /function releasedKey\(/, /\.eval\(\s*RELEASE_LUA/, /NX/]},
        go: {all: [/releaseScript/, /func releasedKey\(/, /\.Run\(/, /NX/]},
        scala: {all: [/ReleaseLua/, /def releasedKey\(/, /\.eval\(\s*ReleaseLua/, /NX/]},
        cpp: {all: [/kReleaseLua/, /std::string releasedKey\(/, /\.eval</, /NX/]},
      },
    },
    {
      id: 'honest-contention',
      title: 'The loser of a race gets NO_CAPACITY, not a grant',
      detail:
        'The atomic script returns `NO_CAPACITY` when the request does not fit and the handler answers **409** — the loser of a race is told it lost instead of being granted capacity the ledger could not move. The draft decides on the client, so under contention both requests see the same free count and both are granted.',
      match: {
        python: {all: [/LUA_NO_CAPACITY/, /result\[0\]/, /status_code\s*=\s*409/]},
        typescript: {all: [/LUA_NO_CAPACITY/, /result\[0\]/, /code\(\s*409\s*\)/]},
        go: {all: [/luaNoCapacity/, /values\[0\]/, /StatusConflict|\b409\b/]},
        scala: {all: [/LuaNoCapacity/, /result\.get\(0\)/, /StatusCodes\.Conflict|\b409\b/]},
        cpp: {all: [/kLuaNoCapacity/, /result\[0\]/, /status\s*=\s*409/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class RegisterRequest(BaseModel):
    capacity_gpus: int
    capacity_memory_gb: int


class AllocationRequest(BaseModel):
    placement_id: str
    gpu_count: int
    memory_gb: int


def node_key(node_id: str) -> str:
    return f"node:{node_id}"


def placement_key(placement_id: str) -> str:
    return f"placement:{placement_id}"


@app.post("/v1/nodes/{node_id}/register")
def register(node_id: str, body: RegisterRequest) -> dict:
    r.hset(node_key(node_id), mapping={"capacity_gpus": body.capacity_gpus, "capacity_memory_gb": body.capacity_memory_gb})
    return {"node_id": node_id, "state": "registered"}


@app.post("/v1/nodes/{node_id}/allocations")
def allocate(node_id: str, body: AllocationRequest) -> dict:
    # TODO: this draft reads the counters, decides client-side, writes the placement record and only
    # then moves the counters. Two allocations can pass the same check, there is no heartbeat TTL and
    # release is not idempotent. Review all four.
    capacity = int(r.hget(node_key(node_id), "capacity_gpus") or 0)
    capacity_mem = int(r.hget(node_key(node_id), "capacity_memory_gb") or 0)
    held = int(r.hget(node_key(node_id), "allocated_gpus") or 0)
    held_mem = int(r.hget(node_key(node_id), "allocated_memory_gb") or 0)
    if held + body.gpu_count > capacity or held_mem + body.memory_gb > capacity_mem:
        raise HTTPException(status_code=409, detail="NO_CAPACITY")
    r.hset(placement_key(body.placement_id), mapping={"node_id": node_id, "gpu_count": body.gpu_count, "memory_gb": body.memory_gb})
    r.hincrby(node_key(node_id), "allocated_gpus", body.gpu_count)
    r.hincrby(node_key(node_id), "allocated_memory_gb", body.memory_gb)
    return {"placement_id": body.placement_id, "node_id": node_id, "state": "allocated"}


@app.post("/v1/placements/{placement_id}/release")
def release(placement_id: str) -> dict:
    record = r.hgetall(placement_key(placement_id))
    if not record:
        return {"placement_id": placement_id, "state": "released"}
    r.hincrby(node_key(record["node_id"]), "allocated_gpus", -int(record["gpu_count"]))
    r.hincrby(node_key(record["node_id"]), "allocated_memory_gb", -int(record["memory_gb"]))
    return {"placement_id": placement_id, "state": "released"}
`,
      solution: `import redis
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

HEARTBEAT_TTL_S = 30
RELEASED_TTL_S = 3600
LUA_ALLOCATED = 1
LUA_NO_CAPACITY = -1
LUA_NO_HEARTBEAT = -2

NODE_ALLOCATE_LUA = """
local capacity_gpus = tonumber(redis.call('HGET', KEYS[1], 'capacity_gpus')) or 0
local capacity_mem = tonumber(redis.call('HGET', KEYS[1], 'capacity_memory_gb')) or 0
local held = tonumber(redis.call('HGET', KEYS[1], 'allocated_gpus')) or 0
local held_mem = tonumber(redis.call('HGET', KEYS[1], 'allocated_memory_gb')) or 0
local want_gpus = tonumber(ARGV[1])
local want_mem = tonumber(ARGV[2])
if redis.call('EXISTS', KEYS[2]) == 0 then
  return {-2, held, held_mem}
end
if held + want_gpus > capacity_gpus or held_mem + want_mem > capacity_mem then
  return {-1, held, held_mem}
end
redis.call('HINCRBY', KEYS[1], 'allocated_gpus', want_gpus)
redis.call('HINCRBY', KEYS[1], 'allocated_memory_gb', want_mem)
redis.call('HSET', KEYS[3], 'node_id', ARGV[3], 'gpu_count', want_gpus, 'memory_gb', want_mem)
return {1, held + want_gpus, held_mem + want_mem}
"""

RELEASE_LUA = """
if redis.call('SET', KEYS[2], '1', 'NX', 'EX', tonumber(ARGV[3])) == false then
  return {0}
end
redis.call('HINCRBY', KEYS[1], 'allocated_gpus', -tonumber(ARGV[1]))
redis.call('HINCRBY', KEYS[1], 'allocated_memory_gb', -tonumber(ARGV[2]))
return {1}
"""


class RegisterRequest(BaseModel):
    capacity_gpus: int
    capacity_memory_gb: int


class AllocationRequest(BaseModel):
    placement_id: str
    gpu_count: int
    memory_gb: int


def node_key(node_id: str) -> str:
    return f"node:{node_id}"


def heartbeat_key(node_id: str) -> str:
    return f"heartbeat:{node_id}"


def placement_key(placement_id: str) -> str:
    return f"placement:{placement_id}"


def released_key(placement_id: str) -> str:
    return f"released:{placement_id}"


def node_alive(node_id: str) -> bool:
    """Schedulable only while the heartbeat key still has a TTL."""
    return bool(r.exists(heartbeat_key(node_id)))


@app.post("/v1/nodes/{node_id}/register")
def register(node_id: str, body: RegisterRequest) -> dict:
    r.hset(node_key(node_id), mapping={"capacity_gpus": body.capacity_gpus, "capacity_memory_gb": body.capacity_memory_gb})
    r.set(heartbeat_key(node_id), "1", ex=HEARTBEAT_TTL_S)
    return {"node_id": node_id, "state": "registered"}


@app.post("/v1/nodes/{node_id}/allocations")
def allocate(node_id: str, body: AllocationRequest) -> JSONResponse:
    if not node_alive(node_id):
        return JSONResponse({"error": "NO_HEARTBEAT"}, status_code=409)
    result = r.eval(
        NODE_ALLOCATE_LUA,
        3,
        node_key(node_id),
        heartbeat_key(node_id),
        placement_key(body.placement_id),
        body.gpu_count,
        body.memory_gb,
        node_id,
    )
    if int(result[0]) == LUA_NO_HEARTBEAT:
        return JSONResponse({"error": "NO_HEARTBEAT"}, status_code=409)
    if int(result[0]) == LUA_NO_CAPACITY:
        return JSONResponse({"error": "NO_CAPACITY"}, status_code=409)
    return JSONResponse({"placement_id": body.placement_id, "node_id": node_id, "state": "allocated"}, status_code=201)


@app.post("/v1/placements/{placement_id}/release")
def release(placement_id: str) -> dict:
    record = r.hgetall(placement_key(placement_id))
    if not record:
        return {"placement_id": placement_id, "state": "released"}
    result = r.eval(
        RELEASE_LUA,
        2,
        node_key(record["node_id"]),
        released_key(placement_id),
        record["gpu_count"],
        record["memory_gb"],
        RELEASED_TTL_S,
    )
    return {"placement_id": placement_id, "state": "released", "applied": int(result[0])}
`,
    },
    typescript: {
      starter: `/** Node ledger: a model-generated draft that decides on the client and moves the counters last. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

interface RegisterBody {
  capacity_gpus: number;
  capacity_memory_gb: number;
}

interface AllocationBody {
  placement_id: string;
  gpu_count: number;
  memory_gb: number;
}

function nodeKey(nodeId: string): string {
  return \`node:\${nodeId}\`;
}

function placementKey(placementId: string): string {
  return \`placement:\${placementId}\`;
}

app.post('/v1/nodes/:nodeId/register', async (request, reply) => {
  const {nodeId} = request.params as {nodeId: string};
  const body = request.body as RegisterBody;
  await r.hset(nodeKey(nodeId), {
    capacity_gpus: String(body.capacity_gpus),
    capacity_memory_gb: String(body.capacity_memory_gb),
  });
  return reply.code(201).send({node_id: nodeId, state: 'registered'});
});

app.post('/v1/nodes/:nodeId/allocations', async (request, reply) => {
  const {nodeId} = request.params as {nodeId: string};
  const body = request.body as AllocationBody;
  // TODO: this draft reads the counters, decides on the client, writes the placement record and only
  // then moves the counters. Two allocations can pass the same check, there is no heartbeat TTL and
  // release is not idempotent. Review all four.
  const capacity = Number((await r.hget(nodeKey(nodeId), 'capacity_gpus')) ?? 0);
  const capacityMem = Number((await r.hget(nodeKey(nodeId), 'capacity_memory_gb')) ?? 0);
  const held = Number((await r.hget(nodeKey(nodeId), 'allocated_gpus')) ?? 0);
  const heldMem = Number((await r.hget(nodeKey(nodeId), 'allocated_memory_gb')) ?? 0);
  if (held + body.gpu_count > capacity || heldMem + body.memory_gb > capacityMem) {
    return reply.code(409).send({error: 'NO_CAPACITY'});
  }
  await r.hset(placementKey(body.placement_id), {
    node_id: nodeId,
    gpu_count: String(body.gpu_count),
    memory_gb: String(body.memory_gb),
  });
  await r.hincrby(nodeKey(nodeId), 'allocated_gpus', body.gpu_count);
  await r.hincrby(nodeKey(nodeId), 'allocated_memory_gb', body.memory_gb);
  return reply.code(201).send({placement_id: body.placement_id, node_id: nodeId, state: 'allocated'});
});

app.post('/v1/placements/:placementId/release', async (request, reply) => {
  const {placementId} = request.params as {placementId: string};
  const record = await r.hgetall(placementKey(placementId));
  if (Object.keys(record).length === 0) {
    return reply.code(200).send({placement_id: placementId, state: 'released'});
  }
  await r.hincrby(nodeKey(record.node_id), 'allocated_gpus', -Number(record.gpu_count));
  await r.hincrby(nodeKey(record.node_id), 'allocated_memory_gb', -Number(record.memory_gb));
  return reply.code(200).send({placement_id: placementId, state: 'released'});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** Node ledger: one atomic script owns node:{id} — admission, heartbeat gate and idempotent release. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const HEARTBEAT_TTL_S = 30;
const RELEASED_TTL_S = 3600;
const LUA_ALLOCATED = 1;
const LUA_NO_CAPACITY = -1;
const LUA_NO_HEARTBEAT = -2;

const NODE_ALLOCATE_LUA = \`
local capacity_gpus = tonumber(redis.call('HGET', KEYS[1], 'capacity_gpus')) or 0
local capacity_mem = tonumber(redis.call('HGET', KEYS[1], 'capacity_memory_gb')) or 0
local held = tonumber(redis.call('HGET', KEYS[1], 'allocated_gpus')) or 0
local held_mem = tonumber(redis.call('HGET', KEYS[1], 'allocated_memory_gb')) or 0
local want_gpus = tonumber(ARGV[1])
local want_mem = tonumber(ARGV[2])
if redis.call('EXISTS', KEYS[2]) == 0 then
  return {-2, held, held_mem}
end
if held + want_gpus > capacity_gpus or held_mem + want_mem > capacity_mem then
  return {-1, held, held_mem}
end
redis.call('HINCRBY', KEYS[1], 'allocated_gpus', want_gpus)
redis.call('HINCRBY', KEYS[1], 'allocated_memory_gb', want_mem)
redis.call('HSET', KEYS[3], 'node_id', ARGV[3], 'gpu_count', want_gpus, 'memory_gb', want_mem)
return {1, held + want_gpus, held_mem + want_mem}
\`;

const RELEASE_LUA = \`
if redis.call('SET', KEYS[2], '1', 'NX', 'EX', tonumber(ARGV[3])) == false then
  return {0}
end
redis.call('HINCRBY', KEYS[1], 'allocated_gpus', -tonumber(ARGV[1]))
redis.call('HINCRBY', KEYS[1], 'allocated_memory_gb', -tonumber(ARGV[2]))
return {1}
\`;

interface RegisterBody {
  capacity_gpus: number;
  capacity_memory_gb: number;
}

interface AllocationBody {
  placement_id: string;
  gpu_count: number;
  memory_gb: number;
}

function nodeKey(nodeId: string): string {
  return \`node:\${nodeId}\`;
}

function heartbeatKey(nodeId: string): string {
  return \`heartbeat:\${nodeId}\`;
}

function placementKey(placementId: string): string {
  return \`placement:\${placementId}\`;
}

function releasedKey(placementId: string): string {
  return \`released:\${placementId}\`;
}

async function nodeAlive(nodeId: string): Promise<boolean> {
  return (await r.exists(heartbeatKey(nodeId))) === 1;
}

app.post('/v1/nodes/:nodeId/register', async (request, reply) => {
  const {nodeId} = request.params as {nodeId: string};
  const body = request.body as RegisterBody;
  await r.hset(nodeKey(nodeId), {
    capacity_gpus: String(body.capacity_gpus),
    capacity_memory_gb: String(body.capacity_memory_gb),
  });
  await r.set(heartbeatKey(nodeId), '1', 'EX', HEARTBEAT_TTL_S);
  return reply.code(201).send({node_id: nodeId, state: 'registered'});
});

app.post('/v1/nodes/:nodeId/allocations', async (request, reply) => {
  const {nodeId} = request.params as {nodeId: string};
  const body = request.body as AllocationBody;
  if (!(await nodeAlive(nodeId))) {
    return reply.code(409).send({error: 'NO_HEARTBEAT'});
  }
  const result = (await r.eval(
    NODE_ALLOCATE_LUA,
    3,
    nodeKey(nodeId),
    heartbeatKey(nodeId),
    placementKey(body.placement_id),
    String(body.gpu_count),
    String(body.memory_gb),
    nodeId,
  )) as number[];
  if (result[0] === LUA_NO_HEARTBEAT) {
    return reply.code(409).send({error: 'NO_HEARTBEAT'});
  }
  if (result[0] === LUA_NO_CAPACITY) {
    return reply.code(409).send({error: 'NO_CAPACITY'});
  }
  return reply.code(201).send({placement_id: body.placement_id, node_id: nodeId, state: 'allocated'});
});

app.post('/v1/placements/:placementId/release', async (request, reply) => {
  const {placementId} = request.params as {placementId: string};
  const record = await r.hgetall(placementKey(placementId));
  if (Object.keys(record).length === 0) {
    return reply.code(200).send({placement_id: placementId, state: 'released'});
  }
  await r.eval(
    RELEASE_LUA,
    2,
    nodeKey(record.node_id),
    releasedKey(placementId),
    record.gpu_count,
    record.memory_gb,
    String(RELEASED_TTL_S),
  );
  return reply.code(200).send({placement_id: placementId, state: 'released'});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb *redis.Client

type registerBody struct {
	CapacityGpus     int64 \`json:"capacity_gpus"\`
	CapacityMemoryGb int64 \`json:"capacity_memory_gb"\`
}

type allocationBody struct {
	PlacementID string \`json:"placement_id"\`
	GpuCount    int64  \`json:"gpu_count"\`
	MemoryGb    int64  \`json:"memory_gb"\`
}

func nodeKey(nodeID string) string {
	return "node:" + nodeID
}

func placementKey(placementID string) string {
	return "placement:" + placementID
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func register(w http.ResponseWriter, r *http.Request) {
	nodeID := r.PathValue("nodeID")
	var body registerBody
	_ = json.NewDecoder(r.Body).Decode(&body)
	rdb.HSet(r.Context(), nodeKey(nodeID), "capacity_gpus", body.CapacityGpus, "capacity_memory_gb", body.CapacityMemoryGb)
	writeJSON(w, http.StatusCreated, map[string]any{"node_id": nodeID, "state": "registered"})
}

func allocate(w http.ResponseWriter, r *http.Request) {
	nodeID := r.PathValue("nodeID")
	var body allocationBody
	_ = json.NewDecoder(r.Body).Decode(&body)
	// TODO: this draft reads the counters, decides in the handler, writes the placement record and
	// only then moves the counters. Two allocations can pass the same check, there is no heartbeat
	// TTL and release is not idempotent. Review all four.
	capacity, _ := rdb.HGet(r.Context(), nodeKey(nodeID), "capacity_gpus").Int64()
	capacityMem, _ := rdb.HGet(r.Context(), nodeKey(nodeID), "capacity_memory_gb").Int64()
	held, _ := rdb.HGet(r.Context(), nodeKey(nodeID), "allocated_gpus").Int64()
	heldMem, _ := rdb.HGet(r.Context(), nodeKey(nodeID), "allocated_memory_gb").Int64()
	if held+body.GpuCount > capacity || heldMem+body.MemoryGb > capacityMem {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "NO_CAPACITY"})
		return
	}
	rdb.HSet(r.Context(), placementKey(body.PlacementID), "node_id", nodeID, "gpu_count", body.GpuCount, "memory_gb", body.MemoryGb)
	rdb.HIncrBy(r.Context(), nodeKey(nodeID), "allocated_gpus", body.GpuCount)
	rdb.HIncrBy(r.Context(), nodeKey(nodeID), "allocated_memory_gb", body.MemoryGb)
	writeJSON(w, http.StatusCreated, map[string]any{"placement_id": body.PlacementID, "node_id": nodeID, "state": "allocated"})
}

func release(w http.ResponseWriter, r *http.Request) {
	placementID := r.PathValue("placementID")
	record, _ := rdb.HGetAll(r.Context(), placementKey(placementID)).Result()
	if len(record) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"placement_id": placementID, "state": "released"})
		return
	}
	gpuCount, _ := strconv.ParseInt(record["gpu_count"], 10, 64)
	memoryGb, _ := strconv.ParseInt(record["memory_gb"], 10, 64)
	rdb.HIncrBy(r.Context(), nodeKey(record["node_id"]), "allocated_gpus", -gpuCount)
	rdb.HIncrBy(r.Context(), nodeKey(record["node_id"]), "allocated_memory_gb", -memoryGb)
	writeJSON(w, http.StatusOK, map[string]any{"placement_id": placementID, "state": "released"})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/nodes/{nodeID}/register", register)
	mux.HandleFunc("POST /v1/nodes/{nodeID}/allocations", allocate)
	mux.HandleFunc("POST /v1/placements/{placementID}/release", release)
	_ = http.ListenAndServe(":8443", mux)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb *redis.Client

const (
	heartbeatTtlSeconds = 30
	releasedTtlSeconds  = 3600
	luaAllocated        = 1
	luaNoCapacity       = -1
	luaNoHeartbeat      = -2
)

var nodeAllocateScript = redis.NewScript(\`
local capacity_gpus = tonumber(redis.call('HGET', KEYS[1], 'capacity_gpus')) or 0
local capacity_mem = tonumber(redis.call('HGET', KEYS[1], 'capacity_memory_gb')) or 0
local held = tonumber(redis.call('HGET', KEYS[1], 'allocated_gpus')) or 0
local held_mem = tonumber(redis.call('HGET', KEYS[1], 'allocated_memory_gb')) or 0
local want_gpus = tonumber(ARGV[1])
local want_mem = tonumber(ARGV[2])
if redis.call('EXISTS', KEYS[2]) == 0 then
  return {-2, held, held_mem}
end
if held + want_gpus > capacity_gpus or held_mem + want_mem > capacity_mem then
  return {-1, held, held_mem}
end
redis.call('HINCRBY', KEYS[1], 'allocated_gpus', want_gpus)
redis.call('HINCRBY', KEYS[1], 'allocated_memory_gb', want_mem)
redis.call('HSET', KEYS[3], 'node_id', ARGV[3], 'gpu_count', want_gpus, 'memory_gb', want_mem)
return {1, held + want_gpus, held_mem + want_mem}
\`)

var releaseScript = redis.NewScript(\`
if redis.call('SET', KEYS[2], '1', 'NX', 'EX', tonumber(ARGV[3])) == false then
  return {0}
end
redis.call('HINCRBY', KEYS[1], 'allocated_gpus', -tonumber(ARGV[1]))
redis.call('HINCRBY', KEYS[1], 'allocated_memory_gb', -tonumber(ARGV[2]))
return {1}
\`)

type registerBody struct {
	CapacityGpus     int64 \`json:"capacity_gpus"\`
	CapacityMemoryGb int64 \`json:"capacity_memory_gb"\`
}

type allocationBody struct {
	PlacementID string \`json:"placement_id"\`
	GpuCount    int64  \`json:"gpu_count"\`
	MemoryGb    int64  \`json:"memory_gb"\`
}

func nodeKey(nodeID string) string {
	return "node:" + nodeID
}

func heartbeatKey(nodeID string) string {
	return "heartbeat:" + nodeID
}

func placementKey(placementID string) string {
	return "placement:" + placementID
}

func releasedKey(placementID string) string {
	return "released:" + placementID
}

func nodeAlive(ctx context.Context, nodeID string) bool {
	exists, _ := rdb.Exists(ctx, heartbeatKey(nodeID)).Result()
	return exists == 1
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func register(w http.ResponseWriter, r *http.Request) {
	nodeID := r.PathValue("nodeID")
	var body registerBody
	_ = json.NewDecoder(r.Body).Decode(&body)
	rdb.HSet(r.Context(), nodeKey(nodeID), "capacity_gpus", body.CapacityGpus, "capacity_memory_gb", body.CapacityMemoryGb)
	rdb.Set(r.Context(), heartbeatKey(nodeID), "1", time.Duration(heartbeatTtlSeconds)*time.Second)
	writeJSON(w, http.StatusCreated, map[string]any{"node_id": nodeID, "state": "registered"})
}

func allocate(w http.ResponseWriter, r *http.Request) {
	nodeID := r.PathValue("nodeID")
	var body allocationBody
	_ = json.NewDecoder(r.Body).Decode(&body)
	if !nodeAlive(r.Context(), nodeID) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "NO_HEARTBEAT"})
		return
	}
	values, err := nodeAllocateScript.Run(
		r.Context(),
		rdb,
		[]string{nodeKey(nodeID), heartbeatKey(nodeID), placementKey(body.PlacementID)},
		body.GpuCount,
		body.MemoryGb,
		nodeID,
	).Int64Slice()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "LEDGER_UNAVAILABLE"})
		return
	}
	if values[0] == luaNoHeartbeat {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "NO_HEARTBEAT"})
		return
	}
	if values[0] == luaNoCapacity {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "NO_CAPACITY"})
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"placement_id": body.PlacementID, "node_id": nodeID, "state": "allocated"})
}

func release(w http.ResponseWriter, r *http.Request) {
	placementID := r.PathValue("placementID")
	record, _ := rdb.HGetAll(r.Context(), placementKey(placementID)).Result()
	if len(record) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"placement_id": placementID, "state": "released"})
		return
	}
	gpuCount, _ := strconv.ParseInt(record["gpu_count"], 10, 64)
	memoryGb, _ := strconv.ParseInt(record["memory_gb"], 10, 64)
	_, err := releaseScript.Run(
		r.Context(),
		rdb,
		[]string{nodeKey(record["node_id"]), releasedKey(placementID)},
		gpuCount,
		memoryGb,
		releasedTtlSeconds,
	).Result()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "LEDGER_UNAVAILABLE"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"placement_id": placementID, "state": "released"})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/nodes/{nodeID}/register", register)
	mux.HandleFunc("POST /v1/nodes/{nodeID}/allocations", allocate)
	mux.HandleFunc("POST /v1/placements/{placementID}/release", release)
	_ = http.ListenAndServe(":8443", mux)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class RegisterBody(capacity_gpus: Long, capacity_memory_gb: Long)
final case class AllocationBody(placement_id: String, gpu_count: Long, memory_gb: Long)

object NodeLedger {
  implicit val system: ActorSystem = ActorSystem("gpu-scheduler")
  implicit val registerFormat: RootJsonFormat[RegisterBody] = jsonFormat2(RegisterBody)
  implicit val allocationFormat: RootJsonFormat[AllocationBody] = jsonFormat3(AllocationBody)

  val jedis = new Jedis("redis", 6379)

  def nodeKey(nodeId: String): String = s"node:$nodeId"
  def placementKey(placementId: String): String = s"placement:$placementId"

  val route: Route =
    concat(
      path("v1" / "nodes" / Segment / "register") { nodeId =>
        post {
          entity(as[RegisterBody]) { body =>
            jedis.hset(nodeKey(nodeId), "capacity_gpus", body.capacity_gpus.toString)
            jedis.hset(nodeKey(nodeId), "capacity_memory_gb", body.capacity_memory_gb.toString)
            complete(StatusCodes.Created, HttpEntity(ContentTypes.\`application/json\`, """{"node_id":"$nodeId","state":"registered"}"""))
          }
        }
      },
      path("v1" / "nodes" / Segment / "allocations") { nodeId =>
        post {
          entity(as[AllocationBody]) { body =>
            // TODO: this draft reads the counters, decides in the handler, writes the placement record
            // and only then moves the counters. Two allocations can pass the same check, there is no
            // heartbeat TTL and release is not idempotent. Review all four.
            val capacity = Option(jedis.hget(nodeKey(nodeId), "capacity_gpus")).map(_.toLong).getOrElse(0L)
            val capacityMem = Option(jedis.hget(nodeKey(nodeId), "capacity_memory_gb")).map(_.toLong).getOrElse(0L)
            val held = Option(jedis.hget(nodeKey(nodeId), "allocated_gpus")).map(_.toLong).getOrElse(0L)
            val heldMem = Option(jedis.hget(nodeKey(nodeId), "allocated_memory_gb")).map(_.toLong).getOrElse(0L)
            if (held + body.gpu_count > capacity || heldMem + body.memory_gb > capacityMem) {
              complete(StatusCodes.Conflict, HttpEntity(ContentTypes.\`application/json\`, """{"error":"NO_CAPACITY"}"""))
            } else {
              val placementId = body.placement_id
              jedis.hset(placementKey(placementId), "node_id", nodeId)
              jedis.hset(placementKey(placementId), "gpu_count", body.gpu_count.toString)
              jedis.hset(placementKey(placementId), "memory_gb", body.memory_gb.toString)
              jedis.hincrBy(nodeKey(nodeId), "allocated_gpus", body.gpu_count)
              jedis.hincrBy(nodeKey(nodeId), "allocated_memory_gb", body.memory_gb)
              complete(StatusCodes.Created, HttpEntity(ContentTypes.\`application/json\`, """{"placement_id":"$placementId","state":"allocated"}"""))
            }
          }
        }
      },
      path("v1" / "placements" / Segment / "release") { placementId =>
        post {
          val record = jedis.hgetAll(placementKey(placementId))
          if (record.isEmpty) {
            complete(StatusCodes.OK, HttpEntity(ContentTypes.\`application/json\`, """{"placement_id":"$placementId","state":"released"}"""))
          } else {
            val nodeId = record.get("node_id")
            jedis.hincrBy(nodeKey(nodeId), "allocated_gpus", -record.get("gpu_count").toLong)
            jedis.hincrBy(nodeKey(nodeId), "allocated_memory_gb", -record.get("memory_gb").toLong)
            complete(StatusCodes.OK, HttpEntity(ContentTypes.\`application/json\`, """{"placement_id":"$placementId","state":"released"}"""))
          }
        }
      }
    )

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class RegisterBody(capacity_gpus: Long, capacity_memory_gb: Long)
final case class AllocationBody(placement_id: String, gpu_count: Long, memory_gb: Long)

object NodeLedger {
  implicit val system: ActorSystem = ActorSystem("gpu-scheduler")
  implicit val registerFormat: RootJsonFormat[RegisterBody] = jsonFormat2(RegisterBody)
  implicit val allocationFormat: RootJsonFormat[AllocationBody] = jsonFormat3(AllocationBody)

  val HeartbeatTtlSeconds = 30L
  val ReleasedTtlSeconds = 3600L
  val LuaAllocated = 1L
  val LuaNoCapacity = -1L
  val LuaNoHeartbeat = -2L

  val NodeAllocateLua =
    """
      |local capacity_gpus = tonumber(redis.call('HGET', KEYS[1], 'capacity_gpus')) or 0
      |local capacity_mem = tonumber(redis.call('HGET', KEYS[1], 'capacity_memory_gb')) or 0
      |local held = tonumber(redis.call('HGET', KEYS[1], 'allocated_gpus')) or 0
      |local held_mem = tonumber(redis.call('HGET', KEYS[1], 'allocated_memory_gb')) or 0
      |local want_gpus = tonumber(ARGV[1])
      |local want_mem = tonumber(ARGV[2])
      |if redis.call('EXISTS', KEYS[2]) == 0 then
      |  return {-2, held, held_mem}
      |end
      |if held + want_gpus > capacity_gpus or held_mem + want_mem > capacity_mem then
      |  return {-1, held, held_mem}
      |end
      |redis.call('HINCRBY', KEYS[1], 'allocated_gpus', want_gpus)
      |redis.call('HINCRBY', KEYS[1], 'allocated_memory_gb', want_mem)
      |redis.call('HSET', KEYS[3], 'node_id', ARGV[3], 'gpu_count', want_gpus, 'memory_gb', want_mem)
      |return {1, held + want_gpus, held_mem + want_mem}
      |""".stripMargin

  val ReleaseLua =
    """
      |if redis.call('SET', KEYS[2], '1', 'NX', 'EX', tonumber(ARGV[3])) == false then
      |  return {0}
      |end
      |redis.call('HINCRBY', KEYS[1], 'allocated_gpus', -tonumber(ARGV[1]))
      |redis.call('HINCRBY', KEYS[1], 'allocated_memory_gb', -tonumber(ARGV[2]))
      |return {1}
      |""".stripMargin

  val jedis = new Jedis("redis", 6379)

  def nodeKey(nodeId: String): String = s"node:$nodeId"
  def heartbeatKey(nodeId: String): String = s"heartbeat:$nodeId"
  def placementKey(placementId: String): String = s"placement:$placementId"
  def releasedKey(placementId: String): String = s"released:$placementId"

  def nodeAlive(nodeId: String): Boolean = jedis.exists(heartbeatKey(nodeId))

  val route: Route =
    concat(
      path("v1" / "nodes" / Segment / "register") { nodeId =>
        post {
          entity(as[RegisterBody]) { body =>
            jedis.hset(nodeKey(nodeId), "capacity_gpus", body.capacity_gpus.toString)
            jedis.hset(nodeKey(nodeId), "capacity_memory_gb", body.capacity_memory_gb.toString)
            jedis.setex(heartbeatKey(nodeId), HeartbeatTtlSeconds, "1")
            complete(StatusCodes.Created, HttpEntity(ContentTypes.\`application/json\`, """{"node_id":"$nodeId","state":"registered"}"""))
          }
        }
      },
      path("v1" / "nodes" / Segment / "allocations") { nodeId =>
        post {
          entity(as[AllocationBody]) { body =>
            val placementId = body.placement_id
            if (!nodeAlive(nodeId)) {
              complete(StatusCodes.Conflict, HttpEntity(ContentTypes.\`application/json\`, """{"error":"NO_HEARTBEAT"}"""))
            } else {
              val result = jedis
                .eval(
                  NodeAllocateLua,
                  3,
                  nodeKey(nodeId),
                  heartbeatKey(nodeId),
                  placementKey(placementId),
                  body.gpu_count.toString,
                  body.memory_gb.toString,
                  nodeId
                )
                .asInstanceOf[java.util.List[Long]]
              if (result.get(0) == LuaNoHeartbeat) {
                complete(StatusCodes.Conflict, HttpEntity(ContentTypes.\`application/json\`, """{"error":"NO_HEARTBEAT"}"""))
              } else if (result.get(0) == LuaNoCapacity) {
                complete(StatusCodes.Conflict, HttpEntity(ContentTypes.\`application/json\`, """{"error":"NO_CAPACITY"}"""))
              } else {
                complete(StatusCodes.Created, HttpEntity(ContentTypes.\`application/json\`, """{"placement_id":"$placementId","state":"allocated"}"""))
              }
            }
          }
        }
      },
      path("v1" / "placements" / Segment / "release") { placementId =>
        post {
          val record = jedis.hgetAll(placementKey(placementId))
          if (record.isEmpty) {
            complete(StatusCodes.OK, HttpEntity(ContentTypes.\`application/json\`, """{"placement_id":"$placementId","state":"released"}"""))
          } else {
            val nodeId = record.get("node_id")
            jedis
              .eval(
                ReleaseLua,
                2,
                nodeKey(nodeId),
                releasedKey(placementId),
                record.get("gpu_count"),
                record.get("memory_gb"),
                ReleasedTtlSeconds.toString
              )
              .asInstanceOf[java.util.List[Long]]
            complete(StatusCodes.OK, HttpEntity(ContentTypes.\`application/json\`, """{"placement_id":"$placementId","state":"released"}"""))
          }
        }
      }
    )

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <string>

using json = nlohmann::json;

std::string nodeKey(const std::string& node_id) { return "node:" + node_id; }

std::string placementKey(const std::string& placement_id) { return "placement:" + placement_id; }

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;

  svr.Post(R"(/v1/nodes/([^/]+)/register)", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto node_id = req.matches[1];
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    redis.hset(nodeKey(node_id), "capacity_gpus", std::to_string(body.value("capacity_gpus", 0LL)));
    redis.hset(nodeKey(node_id), "capacity_memory_gb", std::to_string(body.value("capacity_memory_gb", 0LL)));
    res.status = 201;
    res.set_content(json{{"node_id", node_id}, {"state", "registered"}}.dump(), "application/json");
  });

  svr.Post(R"(/v1/nodes/([^/]+)/allocations)", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto node_id = req.matches[1];
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    const auto placement_id = body.value("placement_id", std::string());
    const long long gpus = body.value("gpu_count", 0LL);
    const long long memory = body.value("memory_gb", 0LL);
    // TODO: this draft reads the counters, decides in the handler, writes the placement record and
    // only then moves the counters. Two allocations can pass the same check, there is no heartbeat
    // TTL and release is not idempotent. Review all four.
    const auto raw_capacity = redis.hget(nodeKey(node_id), "capacity_gpus");
    const long long capacity = raw_capacity ? std::stoll(*raw_capacity) : 0;
    const auto raw_capacity_mem = redis.hget(nodeKey(node_id), "capacity_memory_gb");
    const long long capacity_mem = raw_capacity_mem ? std::stoll(*raw_capacity_mem) : 0;
    const auto raw_held = redis.hget(nodeKey(node_id), "allocated_gpus");
    const long long held = raw_held ? std::stoll(*raw_held) : 0;
    const auto raw_held_mem = redis.hget(nodeKey(node_id), "allocated_memory_gb");
    const long long held_mem = raw_held_mem ? std::stoll(*raw_held_mem) : 0;
    if (held + gpus > capacity || held_mem + memory > capacity_mem) {
      res.status = 409;
      res.set_content(R"({"error":"NO_CAPACITY"})", "application/json");
      return;
    }
    redis.hset(placementKey(placement_id), "node_id", node_id);
    redis.hset(placementKey(placement_id), "gpu_count", std::to_string(gpus));
    redis.hset(placementKey(placement_id), "memory_gb", std::to_string(memory));
    redis.hincrby(nodeKey(node_id), "allocated_gpus", gpus);
    redis.hincrby(nodeKey(node_id), "allocated_memory_gb", memory);
    res.status = 201;
    res.set_content(
        json{{"placement_id", placement_id}, {"node_id", node_id}, {"state", "allocated"}}.dump(),
        "application/json");
  });

  svr.Post(R"(/v1/placements/([^/]+)/release)", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto placement_id = req.matches[1];
    const auto record = redis.hgetall(placementKey(placement_id));
    if (record.empty()) {
      res.status = 200;
      res.set_content(json{{"placement_id", placement_id}, {"state", "released"}}.dump(), "application/json");
      return;
    }
    const auto node_id = record.at("node_id");
    redis.hincrby(nodeKey(node_id), "allocated_gpus", -std::stoll(record.at("gpu_count")));
    redis.hincrby(nodeKey(node_id), "allocated_memory_gb", -std::stoll(record.at("memory_gb")));
    res.status = 200;
    res.set_content(json{{"placement_id", placement_id}, {"state", "released"}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <string>
#include <vector>

using json = nlohmann::json;

constexpr long long kHeartbeatTtlSeconds = 30;
constexpr long long kReleasedTtlSeconds = 3600;
constexpr long long kLuaAllocated = 1;
constexpr long long kLuaNoCapacity = -1;
constexpr long long kLuaNoHeartbeat = -2;

const char* kNodeAllocateLua = R"LUA(
local capacity_gpus = tonumber(redis.call('HGET', KEYS[1], 'capacity_gpus')) or 0
local capacity_mem = tonumber(redis.call('HGET', KEYS[1], 'capacity_memory_gb')) or 0
local held = tonumber(redis.call('HGET', KEYS[1], 'allocated_gpus')) or 0
local held_mem = tonumber(redis.call('HGET', KEYS[1], 'allocated_memory_gb')) or 0
local want_gpus = tonumber(ARGV[1])
local want_mem = tonumber(ARGV[2])
if redis.call('EXISTS', KEYS[2]) == 0 then
  return {-2, held, held_mem}
end
if held + want_gpus > capacity_gpus or held_mem + want_mem > capacity_mem then
  return {-1, held, held_mem}
end
redis.call('HINCRBY', KEYS[1], 'allocated_gpus', want_gpus)
redis.call('HINCRBY', KEYS[1], 'allocated_memory_gb', want_mem)
redis.call('HSET', KEYS[3], 'node_id', ARGV[3], 'gpu_count', want_gpus, 'memory_gb', want_mem)
return {1, held + want_gpus, held_mem + want_mem}
)LUA";

const char* kReleaseLua = R"LUA(
if redis.call('SET', KEYS[2], '1', 'NX', 'EX', tonumber(ARGV[3])) == false then
  return {0}
end
redis.call('HINCRBY', KEYS[1], 'allocated_gpus', -tonumber(ARGV[1]))
redis.call('HINCRBY', KEYS[1], 'allocated_memory_gb', -tonumber(ARGV[2]))
return {1}
)LUA";

std::string nodeKey(const std::string& node_id) { return "node:" + node_id; }

std::string heartbeatKey(const std::string& node_id) { return "heartbeat:" + node_id; }

std::string placementKey(const std::string& placement_id) { return "placement:" + placement_id; }

std::string releasedKey(const std::string& placement_id) { return "released:" + placement_id; }

bool nodeAlive(sw::redis::Redis& redis, const std::string& node_id) {
  return redis.exists(heartbeatKey(node_id)) == 1;
}

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;

  svr.Post(R"(/v1/nodes/([^/]+)/register)", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto node_id = req.matches[1];
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    redis.hset(nodeKey(node_id), "capacity_gpus", std::to_string(body.value("capacity_gpus", 0LL)));
    redis.hset(nodeKey(node_id), "capacity_memory_gb", std::to_string(body.value("capacity_memory_gb", 0LL)));
    redis.setex(heartbeatKey(node_id), kHeartbeatTtlSeconds, "1");
    res.status = 201;
    res.set_content(json{{"node_id", node_id}, {"state", "registered"}}.dump(), "application/json");
  });

  svr.Post(R"(/v1/nodes/([^/]+)/allocations)", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto node_id = req.matches[1];
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    const auto placement_id = body.value("placement_id", std::string());
    const long long gpus = body.value("gpu_count", 0LL);
    const long long memory = body.value("memory_gb", 0LL);
    if (!nodeAlive(redis, node_id)) {
      res.status = 409;
      res.set_content(R"({"error":"NO_HEARTBEAT"})", "application/json");
      return;
    }
    const auto result = redis.eval<std::vector<long long>>(
        kNodeAllocateLua,
        {nodeKey(node_id), heartbeatKey(node_id), placementKey(placement_id)},
        {std::to_string(gpus), std::to_string(memory), node_id});
    if (result[0] == kLuaNoHeartbeat) {
      res.status = 409;
      res.set_content(R"({"error":"NO_HEARTBEAT"})", "application/json");
      return;
    }
    if (result[0] == kLuaNoCapacity) {
      res.status = 409;
      res.set_content(R"({"error":"NO_CAPACITY"})", "application/json");
      return;
    }
    res.status = 201;
    res.set_content(
        json{{"placement_id", placement_id}, {"node_id", node_id}, {"state", "allocated"}}.dump(),
        "application/json");
  });

  svr.Post(R"(/v1/placements/([^/]+)/release)", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto placement_id = req.matches[1];
    const auto record = redis.hgetall(placementKey(placement_id));
    if (record.empty()) {
      res.status = 200;
      res.set_content(json{{"placement_id", placement_id}, {"state", "released"}}.dump(), "application/json");
      return;
    }
    redis.eval<std::vector<long long>>(
        kReleaseLua,
        {nodeKey(record.at("node_id")), releasedKey(placement_id)},
        {record.at("gpu_count"), record.at("memory_gb"), std::to_string(kReleasedTtlSeconds)});
    res.status = 200;
    res.set_content(json{{"placement_id", placement_id}, {"state", "released"}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The interviewer is testing three properties of a ledger that hands out a scarce resource. **Atomicity**: the admission test and the counter move must be one server-side step, because a read-then-write pair is correct in every serial test and wrong exactly when two placements race — and the race is the only time the answer matters. **Order**: the counter move and the placement record are one decision; the draft commits the record first and moves the counters afterwards, so the record promises GPUs the ledger has not yet claimed, and the fix puts both in the same script. **Liveness**: the heartbeat key’s TTL is what removes a dead machine from the scheduling set. Without it the fleet keeps offering capacity that no longer exists, and the scheduler keeps handing work to a node that will never report back. **Idempotency** is the fourth: release keyed by the placement id, guarded by a \`SET NX\` marker, so a retried release cannot manufacture capacity. The honest 409 is what makes the loser of a race observable rather than a silent oversubscription. Real schedulers add per-resource-request queues with FIFO fairness, leases with a reaper for allocations whose owner vanished, and a reconciliation pass that rebuilds the counters from the placement ledger after a Redis failover.`,
};
