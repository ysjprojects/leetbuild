import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/nodes/{id}: capacity that cannot double-count',
  concept: 'http',
  file: 'read',
  focus: ['operator', 'scheduler', 'redis', 'registry'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: the console shows a capacity
line, the numbers look plausible, and the demo never reboots a node. It computes \`free\` from a
snapshot of \`allocated\` taken up to five minutes ago, and it serves any node to any caller. Review
it like the service owner, fix it, and prove the fix with the checks below.

Implement \`GET /v1/nodes/{id}\`, the read the operator console and the on-call runbook both quote:

- The view is an **operator surface**, not a tenant surface: it requires \`X-Operator-Id\` and
  \`X-Operator-Token\`, and the credential's scope claim (\`X-Scope\`) must be \`operator\`. Anything
  else is **403**, including a request with no credential at all — and the refusal names nothing
  about the node. The draft serves any node to any caller, so a tenant token is enough to enumerate
  the fleet it is bidding against.
- \`capacity\`, \`allocated\` and \`free\` are computed through the **same atomic path the scheduler
  writes**: one \`NODE_CAPACITY_LUA\` script owns the \`node:{id}\` hash, and allocation, release,
  resync and read all run it (the read passes \`op=read\`). The draft computes
  \`free = capacity - allocated\` from an in-process cache refreshed every five minutes, so the read
  and the placement that was refused a second ago disagree by exactly the placements that happened
  since the last refresh.
- \`free\` can never exceed what a placement attempt would grant: \`free_gpus(capacity, allocated)\`
  is \`max(capacity - allocated, 0)\`, and \`can_place(capacity, allocated, want_gpus)\` is the same
  admission test the scheduler runs before it reserves. \`?want_gpus=n\` answers whether a placement
  of \`n\` would be granted now — \`placeable\` is true only when \`n ≥ 1\` and \`free ≥ n\`.
- A node that **rebooted** re-registers: \`POST /v1/nodes/{id}/register\` takes the node's capacity
  and recomputes \`allocated\` from the placement ledger (\`ledger.active_gpus_for(node_id)\`, every
  open allocation summed) instead of trusting whatever the agent reports, then writes both counters
  through the same script. The draft never reconciles, so after a reboot its counters keep whatever
  they held before, forever.
- Log the read with the operator id, the node id and the three counts — never the operator token.

**Failure mode the checks target.** Each of these is a reconciliation bug rather than a display bug.
A cached \`allocated\` promises GPUs the scheduler has already handed out, and the number an operator
reads while draining a node is the number a placement is refused against. A negative \`free\` is the
signature of two writers and no single owner of the counters. And a fleet view open to any caller is
how a tenant learns the shape of the capacity it is competing for — the same read that must be
honest must also be scoped.`,
  sequence: {
    participants: ['Operator', 'GPU Scheduler', 'Redis', 'Node registry'],
    messages: [
      {
        from: 'Operator',
        to: 'GPU Scheduler',
        label: 'GET /v1/nodes/gpu-7 · X-Operator-Id · X-Operator-Token · X-Scope: operator',
        kind: 'sync',
      },
      {from: 'GPU Scheduler', to: 'GPU Scheduler', label: 'scope ≠ operator → 403', kind: 'sync'},
      {
        from: 'GPU Scheduler',
        to: 'Redis',
        label: 'EVAL node capacity · KEYS[node:gpu-7] · ARGV[read, 0]',
        kind: 'sync',
      },
      {
        from: 'Redis',
        to: 'GPU Scheduler',
        label: '{capacity, allocated} — the same script the reservation runs',
        kind: 'reply',
      },
      {
        from: 'GPU Scheduler',
        to: 'GPU Scheduler',
        label: 'free = max(capacity - allocated, 0) · placeable = can_place(…, want_gpus)',
        kind: 'sync',
      },
      {
        from: 'GPU Scheduler',
        to: 'Operator',
        label: '200 {capacity, allocated, free, placeable}',
        kind: 'reply',
      },
      {
        from: 'GPU Scheduler',
        to: 'Node registry',
        label: 'active_gpus_for(gpu-7) after the agent re-registers',
        kind: 'sync',
      },
      {from: 'Node registry', to: 'GPU Scheduler', label: 'every open allocation, summed', kind: 'reply'},
      {
        from: 'GPU Scheduler',
        to: 'Redis',
        label: 'EVAL node capacity · ARGV[sync, capacity, allocated]',
        kind: 'async',
      },
      {
        from: 'Redis',
        to: 'GPU Scheduler',
        label: '{capacity, allocated} — counters rebuilt from the ledger',
        kind: 'reply',
      },
    ],
  },
  hints: [
    'Compute `free` where the scheduler computes it: one `NODE_CAPACITY_LUA` script owns `node:{id}`, and allocation, release, resync and read all run it. The draft’s five-minute `allocated` snapshot is a second owner of the same number — the read and the reservation then disagree by exactly the placements that happened since the last refresh.',
    'Clamp, and answer the admission question: `free_gpus(capacity, allocated)` is `max(capacity - allocated, 0)` and `can_place(...)` is the test the scheduler runs before it reserves, so `placeable` can never be true on a node where a placement would be refused. A negative free count is the signature of two writers and no single owner of the counters.',
    'Two things the happy path never shows: the view is an operator surface (`X-Operator-Id` and `X-Operator-Token` with `X-Scope: operator`, **403** otherwise), and a rebooted node re-registers — recompute `allocated` from the ledger (`active_gpus_for`) instead of trusting the agent, then write both counters through the same script. Log the operator id and the counts, never the token.',
  ],
  checks: [
    {
      id: 'node-route',
      title: 'Serves GET /v1/nodes/{id} with capacity, allocated and free',
      detail:
        'The node read is registered on `GET /v1/nodes/{id}` (the language’s path-parameter route) and its response carries `capacity`, `allocated` and `free` for that node. The draft already answers this route, so this check passes on it — the four below are where it fails.',
      match: {
        python: {
          all: [/@app\.get\(\s*["']\/v1\/nodes\/\{/, /["']capacity["']/, /["']allocated["']/, /["']free["']/],
        },
        typescript: {all: [/app\.get\(\s*['"]\/v1\/nodes\/:/, /capacity\b/, /allocated\b/, /free\b/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/nodes\/\{/, /"capacity"/, /"allocated"/, /"free"/]},
        scala: {
          all: [/path\(\s*"v1"\s*\/\s*"nodes"\s*\/\s*Segment/, /capacity\b/, /allocated\b/, /free\b/],
        },
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/nodes\//, /"capacity"/, /"allocated"/, /"free"/]},
      },
    },
    {
      id: 'atomic-capacity',
      title: 'Computes free through the same atomic path the scheduler writes',
      detail:
        'One `NODE_CAPACITY_LUA` script owns `node:{id}` and allocation, release, resync and read all run it (`EVAL` / `NewScript.Run` / `redis.eval`), through a shared `readCapacity`/`freeGpus` helper. A five-minute `allocated` snapshot (`CACHE_TTL`, `allocatedCache`, `refreshEveryMs`, `cachedAllocated`) is a second owner of the counter, so the read and the reservation disagree by exactly the placements since the refresh.',
      match: {
        python: {
          all: [/NODE_CAPACITY_LUA/, /def node_capacity\(/, /\.eval\(/, /read_capacity\(node_id\)/],
          none: [/CACHE_TTL|allocated_cache|cached_allocated|refresh_every_ms/],
        },
        typescript: {
          all: [/NODE_CAPACITY_LUA/, /async function nodeCapacity\(/, /readCapacity\(nodeId\)/, /\.eval\(/],
          none: [/CACHE_TTL|allocatedCache|cachedAllocated|refreshEveryMs/],
        },
        go: {
          all: [/nodeCapacityScript/, /func nodeCapacity\(/, /func readCapacity\(/, /\.Run\(/],
          none: [/CACHE_TTL|allocatedCache|cachedAllocated|refreshEveryMs/],
        },
        scala: {
          all: [/NodeCapacityLua/, /def nodeCapacity\(/, /\.eval\(/, /def readCapacity\(/],
          none: [/CacheTtl|allocatedCache|cachedAllocated|refreshEveryMs/],
        },
        cpp: {
          all: [/kNodeCapacityLua/, /nodeCapacity\(/, /readCapacity\(/, /\.eval</],
          none: [/kCacheTtl|cached_allocated|allocated_cache|refresh_every_ms/],
        },
      },
    },
    {
      id: 'free-clamp',
      title: 'Free never exceeds what a placement would grant',
      detail:
        '`free_gpus(capacity, allocated)` clamps to `max(capacity - allocated, 0)` and `can_place(capacity, allocated, want_gpus)` is the same admission test the scheduler runs, so `free` and `placeable` can never promise a GPU a placement would refuse. The draft subtracts the cached number and will happily return a negative free count.',
      match: {
        python: {
          all: [
            /def free_gpus\(/,
            /max\(capacity\s*-\s*allocated,\s*0\)/,
            /can_place\(capacity, allocated, want_gpus\)/,
          ],
        },
        typescript: {
          all: [
            /function freeGpus\(/,
            /Math\.max\(capacity - allocated, 0\)/,
            /canPlace\(capacity, allocated, wantGpus\)/,
          ],
        },
        go: {all: [/func freeGpus\(/, /if free < 0/, /canPlace\(capacity, allocated, wantGpus\)/]},
        scala: {
          all: [/def freeGpus\(/, /math\.max\(capacity - allocated, 0L\)/, /canPlace\(capacity, allocated, wantGpus/],
        },
        cpp: {
          all: [
            /long long freeGpus\(/,
            /std::max\(capacity - allocated, 0LL\)/,
            /canPlace\(capacity, allocated, want_gpus\)/,
          ],
        },
      },
    },
    {
      id: 'reconcile',
      title: 'Recomputes allocated from the ledger when a node re-registers',
      detail:
        'A node that rebooted re-registers, and `reconcileNode`/`reconcile_node` recomputes `allocated` by summing the open allocations in the ledger (`active_gpus_for`/`activeGpusFor`) before writing both counters through the same script. The draft never reconciles, so a rebooted node keeps pre-reboot counters forever.',
      match: {
        python: {
          all: [
            /def reconcile_node\(/,
            /ledger\.active_gpus_for\(/,
            /@app\.post\(\s*["']\/v1\/nodes\/\{node_id\}\/register["']/,
          ],
        },
        typescript: {
          all: [
            /function reconcileNode\(/,
            /ledger\.activeGpusFor\(/,
            /app\.post\(\s*['"]\/v1\/nodes\/:nodeId\/register['"]/,
          ],
        },
        go: {
          all: [
            /func reconcileNode\(/,
            /ledger\.ActiveGpusFor\(/,
            /HandleFunc\(\s*"POST \/v1\/nodes\/\{id\}\/register"/,
          ],
        },
        scala: {
          all: [
            /def reconcileNode\(/,
            /ledger\.activeGpusFor\(/,
            /path\(\s*"v1"\s*\/\s*"nodes"\s*\/\s*Segment\s*\/\s*"register"\s*\)/,
          ],
        },
        cpp: {all: [/long long reconcileNode\(/, /ledger\.active_gpus_for\(/, /svr\.Post\(\s*R"\(\/v1\/nodes\//]},
      },
    },
    {
      id: 'operator-scope',
      title: 'Scopes the node view to operators',
      detail:
        'The read requires an operator credential — `X-Operator-Id` plus `X-Operator-Token` with the scope claim `operator` — and answers **403** for anyone else. The draft serves any node to any caller, so a tenant token is enough to enumerate the fleet.',
      match: {
        python: {
          all: [
            /X-Operator-Id/,
            /X-Operator-Token/,
            /def require_operator\(/,
            /OPERATOR_SCOPE/,
            /status_code\s*=\s*403/,
          ],
        },
        typescript: {
          all: [/x-operator-id/, /x-operator-token/, /function isOperator\(/, /OPERATOR_SCOPE/, /code\(\s*403\s*\)/],
        },
        go: {all: [/X-Operator-Id/, /X-Operator-Token/, /func requireOperator\(/, /operatorScope/, /StatusForbidden/]},
        scala: {
          all: [
            /X-Operator-Id/,
            /X-Operator-Token/,
            /def requireOperator\(/,
            /OperatorScope/,
            /StatusCodes\.Forbidden/,
          ],
        },
        cpp: {all: [/X-Operator-Id/, /X-Operator-Token/, /requireOperator\(/, /kOperatorScope/, /\b403\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import redis
from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

# A five-minute snapshot of what is allocated, refreshed by a background task.
CACHE_TTL_S = 300
allocated_cache: dict[str, tuple[float, int]] = {}


def cached_allocated(node_id: str) -> int:
    """The allocated count from the last refresh, at most five minutes behind the ledger."""
    refreshed_at, allocated = allocated_cache.get(node_id, (0.0, 0))
    if time.time() - refreshed_at > CACHE_TTL_S:
        allocated_cache[node_id] = (time.time(), allocated)
    return allocated


@app.get("/v1/nodes/{node_id}")
def read_node(node_id: str) -> JSONResponse:
    # TODO: this draft computes free from a five-minute snapshot of the allocated count and serves
    # any node to any caller. Recompute free through the same atomic path the scheduler writes,
    # clamp it so the read can never promise a GPU a placement would refuse, resync a node that
    # rebooted, and scope the view to operators.
    capacity = int(r.hget(f"node:{node_id}", "capacity") or 0)
    allocated = cached_allocated(node_id)
    return JSONResponse(
        {
            "node_id": node_id,
            "capacity": capacity,
            "allocated": allocated,
            "free": capacity - allocated,
        },
        status_code=200,
    )
`,
      solution: `import logging

import redis
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("gpusched")
r = redis.Redis(host="redis", port=6379, decode_responses=True)

OPERATOR_SCOPE = "operator"
DEFAULT_WANT_GPUS = 1

# Allocate, release, resync and read all run this script: capacity and allocated are only ever
# touched here, so a read cannot see half a reservation and can never promise a GPU the
# scheduler's next reservation would refuse.
NODE_CAPACITY_LUA = """
local capacity = tonumber(redis.call('HGET', KEYS[1], 'capacity')) or 0
local allocated = tonumber(redis.call('HGET', KEYS[1], 'allocated')) or 0
local op = ARGV[1]
local gpus = tonumber(ARGV[2])
if op == 'reserve' then
  if allocated + gpus > capacity then
    return {capacity, allocated, 0}
  end
  allocated = allocated + gpus
elseif op == 'release' then
  allocated = math.max(allocated - gpus, 0)
elseif op == 'sync' then
  capacity = gpus
  allocated = tonumber(ARGV[3])
end
redis.call('HSET', KEYS[1], 'capacity', capacity, 'allocated', allocated)
return {capacity, allocated, 1}
"""


class NodeRegistration(BaseModel):
    capacity: int


class PlacementLedger:
    def active_gpus_for(self, node_id: str) -> int:
        """Every open allocation on this node, summed: the ledger, not the agent's claim."""
        raise NotImplementedError


ledger = PlacementLedger()


def node_key(node_id: str) -> str:
    return f"node:{node_id}"


def node_capacity(node_id: str, op: str, gpus: int = 0, allocated: int = 0) -> tuple[int, int, bool]:
    """The one path to capacity and allocated; the scheduler reserves through it too."""
    capacity, held, ok = r.eval(NODE_CAPACITY_LUA, 1, node_key(node_id), op, gpus, allocated)
    return int(capacity), int(held), bool(ok)


def read_capacity(node_id: str) -> tuple[int, int]:
    """The read runs the same script with op=read, so it sees what a reservation sees."""
    capacity, allocated, _ = node_capacity(node_id, "read")
    return capacity, allocated


def free_gpus(capacity: int, allocated: int) -> int:
    """What a placement attempt would actually be granted: never a negative number of GPUs."""
    return max(capacity - allocated, 0)


def can_place(capacity: int, allocated: int, want_gpus: int) -> bool:
    """The admission test the scheduler runs before it reserves."""
    return 0 < want_gpus <= free_gpus(capacity, allocated)


def require_operator(operator_id: str | None, token: str | None, scope: str | None) -> str:
    """The fleet view is an operator surface: a tenant credential is not a fleet credential."""
    if operator_id is None or operator_id == "" or token is None or token == "" or scope != OPERATOR_SCOPE:
        raise HTTPException(status_code=403, detail="operator scope required")
    return operator_id


def reconcile_node(node_id: str, capacity: int) -> int:
    """A node that rebooted re-registers: allocated is rebuilt from the ledger, not trusted."""
    allocated = ledger.active_gpus_for(node_id)
    node_capacity(node_id, "sync", capacity, allocated)
    return allocated


@app.get("/v1/nodes/{node_id}")
def read_node(
    node_id: str,
    want_gpus: int = DEFAULT_WANT_GPUS,
    operator_id: str | None = Header(default=None, alias="X-Operator-Id"),
    token: str | None = Header(default=None, alias="X-Operator-Token"),
    scope: str | None = Header(default=None, alias="X-Scope"),
) -> JSONResponse:
    require_operator(operator_id, token, scope)
    capacity, allocated = read_capacity(node_id)
    free = free_gpus(capacity, allocated)
    logger.info(
        "node read operator=%s node=%s capacity=%d allocated=%d free=%d", operator_id, node_id, capacity, allocated, free
    )
    return JSONResponse(
        {
            "node_id": node_id,
            "capacity": capacity,
            "allocated": allocated,
            "free": free,
            "placeable": can_place(capacity, allocated, want_gpus),
        },
        status_code=200,
    )


@app.post("/v1/nodes/{node_id}/register")
def register_node(
    node_id: str,
    body: NodeRegistration,
    operator_id: str | None = Header(default=None, alias="X-Operator-Id"),
    token: str | None = Header(default=None, alias="X-Operator-Token"),
    scope: str | None = Header(default=None, alias="X-Scope"),
) -> JSONResponse:
    require_operator(operator_id, token, scope)
    allocated = reconcile_node(node_id, body.capacity)
    return JSONResponse(
        {"node_id": node_id, "capacity": body.capacity, "allocated": allocated}, status_code=200
    )
`,
    },
    typescript: {
      starter: `/** GET /v1/nodes/{id}: a model-generated draft that reports a five-minute-old free count. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const CACHE_TTL_MS = 5 * 60 * 1000;
const allocatedCache = new Map<string, {refreshedAt: number; allocated: number}>();

/** The allocated count from the last refresh, at most five minutes behind the ledger. */
function cachedAllocated(nodeId: string): number {
  const hit = allocatedCache.get(nodeId) ?? {refreshedAt: 0, allocated: 0};
  if (Date.now() - hit.refreshedAt > CACHE_TTL_MS) {
    allocatedCache.set(nodeId, {refreshedAt: Date.now(), allocated: hit.allocated});
  }
  return hit.allocated;
}

app.get('/v1/nodes/:nodeId', async (request, reply) => {
  // TODO: this draft computes free from a five-minute snapshot of the allocated count and serves
  // any node to any caller. Recompute free through the same atomic path the scheduler writes,
  // clamp it so the read can never promise a GPU a placement would refuse, resync a node that
  // rebooted, and scope the view to operators.
  const {nodeId} = request.params as {nodeId: string};
  const capacity = Number((await r.hget(\`node:\${nodeId}\`, 'capacity')) ?? 0);
  const allocated = cachedAllocated(nodeId);
  return reply.code(200).send({node_id: nodeId, capacity, allocated, free: capacity - allocated});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/nodes/{id}: capacity that cannot double-count, scoped to operators. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const OPERATOR_SCOPE = 'operator';
const DEFAULT_WANT_GPUS = 1;

/**
 * Allocate, release, resync and read all run this script: capacity and allocated are only ever
 * touched here, so a read cannot see half a reservation.
 */
const NODE_CAPACITY_LUA = \`
local capacity = tonumber(redis.call('HGET', KEYS[1], 'capacity')) or 0
local allocated = tonumber(redis.call('HGET', KEYS[1], 'allocated')) or 0
local op = ARGV[1]
local gpus = tonumber(ARGV[2])
if op == 'reserve' then
  if allocated + gpus > capacity then
    return {capacity, allocated, 0}
  end
  allocated = allocated + gpus
elseif op == 'release' then
  allocated = math.max(allocated - gpus, 0)
elseif op == 'sync' then
  capacity = gpus
  allocated = tonumber(ARGV[3])
end
redis.call('HSET', KEYS[1], 'capacity', capacity, 'allocated', allocated)
return {capacity, allocated, 1}
\`;

interface NodeRegistration {
  capacity: number;
}

const ledger = {
  /** Every open allocation on this node, summed: the ledger, not the agent's claim. */
  activeGpusFor(nodeId: string): number {
    throw new Error(\`no ledger row for \${nodeId}\`);
  },
};

export function nodeKey(nodeId: string): string {
  return \`node:\${nodeId}\`;
}

/** The one path to capacity and allocated; the scheduler reserves through it too. */
export async function nodeCapacity(
  nodeId: string,
  op: string,
  gpus = 0,
  allocated = 0,
): Promise<[number, number, boolean]> {
  const [capacity, held, ok] = (await r.eval(
    NODE_CAPACITY_LUA,
    1,
    nodeKey(nodeId),
    op,
    String(gpus),
    String(allocated),
  )) as [number, number, number];
  return [capacity, held, ok === 1];
}

/** The read runs the same script with op=read, so it sees what a reservation sees. */
export async function readCapacity(nodeId: string): Promise<[number, number]> {
  const [capacity, allocated] = await nodeCapacity(nodeId, 'read');
  return [capacity, allocated];
}

/** What a placement attempt would actually be granted: never a negative number of GPUs. */
export function freeGpus(capacity: number, allocated: number): number {
  return Math.max(capacity - allocated, 0);
}

/** The admission test the scheduler runs before it reserves. */
export function canPlace(capacity: number, allocated: number, wantGpus: number): boolean {
  return wantGpus > 0 && wantGpus <= freeGpus(capacity, allocated);
}

/** The fleet view is an operator surface: a tenant credential is not a fleet credential. */
function isOperator(operatorId: unknown, token: unknown, scope: unknown): operatorId is string {
  return (
    typeof operatorId === 'string' && operatorId !== '' &&
    typeof token === 'string' && token !== '' &&
    scope === OPERATOR_SCOPE
  );
}

/** A node that rebooted re-registers: allocated is rebuilt from the ledger, not trusted. */
export async function reconcileNode(nodeId: string, capacity: number): Promise<number> {
  const allocated = ledger.activeGpusFor(nodeId);
  await nodeCapacity(nodeId, 'sync', capacity, allocated);
  return allocated;
}

app.get('/v1/nodes/:nodeId', async (request, reply) => {
  const operatorId = request.headers['x-operator-id'];
  const token = request.headers['x-operator-token'];
  const scope = request.headers['x-scope'];
  if (!isOperator(operatorId, token, scope)) return reply.code(403).send({error: 'operator scope required'});
  const {nodeId} = request.params as {nodeId: string};
  const [capacity, allocated] = await readCapacity(nodeId);
  const free = freeGpus(capacity, allocated);
  const wantGpus = Number((request.query as {want_gpus?: string}).want_gpus ?? DEFAULT_WANT_GPUS);
  request.log.info({operator: operatorId, node: nodeId, capacity, allocated, free}, 'node read');
  return reply.code(200).send({
    node_id: nodeId,
    capacity,
    allocated,
    free,
    placeable: canPlace(capacity, allocated, wantGpus),
  });
});

app.post('/v1/nodes/:nodeId/register', async (request, reply) => {
  const operatorId = request.headers['x-operator-id'];
  const token = request.headers['x-operator-token'];
  const scope = request.headers['x-scope'];
  if (!isOperator(operatorId, token, scope)) return reply.code(403).send({error: 'operator scope required'});
  const {nodeId} = request.params as {nodeId: string};
  const body = request.body as NodeRegistration;
  const allocated = await reconcileNode(nodeId, body.capacity);
  return reply.code(200).send({node_id: nodeId, capacity: body.capacity, allocated});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"
)

const cacheTtlMs = 5 * 60 * 1000

type cachedAllocated struct {
	refreshedAtMs int64
	allocated     int64
}

var (
	rdb            = redis.NewClient(&redis.Options{Addr: "redis:6379"})
	allocatedCache = map[string]cachedAllocated{}
)

// cachedAllocatedFor is the allocated count from the last refresh, at most five minutes old.
func cachedAllocatedFor(nodeID string) int64 {
	hit := allocatedCache[nodeID]
	if time.Now().UnixMilli()-hit.refreshedAtMs > cacheTtlMs {
		hit.refreshedAtMs = time.Now().UnixMilli()
		allocatedCache[nodeID] = hit
	}
	return hit.allocated
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func readNode(rw http.ResponseWriter, r *http.Request) {
	// TODO: this draft computes free from a five-minute snapshot of the allocated count and serves
	// any node to any caller. Recompute free through the same atomic path the scheduler writes,
	// clamp it so the read can never promise a GPU a placement would refuse, resync a node that
	// rebooted, and scope the view to operators.
	nodeID := r.PathValue("id")
	raw, _ := rdb.HGet(r.Context(), "node:"+nodeID, "capacity").Int64()
	capacity := raw
	allocated := cachedAllocatedFor(nodeID)
	writeJSON(rw, http.StatusOK, map[string]any{
		"node_id":   nodeID,
		"capacity":  capacity,
		"allocated": allocated,
		"free":      capacity - allocated,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/nodes/{id}", readNode)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strconv"

	"github.com/redis/go-redis/v9"
)

const (
	operatorScope   = "operator"
	defaultWantGpus = 1
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// nodeCapacityScript is the one owner of the node:{id} counters: allocate, release, resync and
// read all run it, so a read cannot see half a reservation.
var nodeCapacityScript = redis.NewScript(\`
local capacity = tonumber(redis.call('HGET', KEYS[1], 'capacity')) or 0
local allocated = tonumber(redis.call('HGET', KEYS[1], 'allocated')) or 0
local op = ARGV[1]
local gpus = tonumber(ARGV[2])
if op == 'reserve' then
  if allocated + gpus > capacity then
    return {capacity, allocated, 0}
  end
  allocated = allocated + gpus
elseif op == 'release' then
  allocated = math.max(allocated - gpus, 0)
elseif op == 'sync' then
  capacity = gpus
  allocated = tonumber(ARGV[3])
end
redis.call('HSET', KEYS[1], 'capacity', capacity, 'allocated', allocated)
return {capacity, allocated, 1}
\`)

type placementLedger struct{}

// ActiveGpusFor sums every open allocation on this node: the ledger, not the agent's claim.
func (l *placementLedger) ActiveGpusFor(nodeID string) int64 {
	panic("no ledger row for " + nodeID)
}

var ledger = &placementLedger{}

type nodeRegistration struct {
	Capacity int64 \`json:"capacity"\`
}

func nodeKey(nodeID string) string {
	return "node:" + nodeID
}

// nodeCapacity is the one path to capacity and allocated; the scheduler reserves through it too.
func nodeCapacity(ctx context.Context, nodeID, op string, gpus, allocated int64) (int64, int64, bool) {
	values, err := nodeCapacityScript.Run(ctx, rdb, []string{nodeKey(nodeID)}, op, gpus, allocated).Int64Slice()
	if err != nil {
		panic(err)
	}
	return values[0], values[1], values[2] == 1
}

// readCapacity runs the same script with op=read, so it sees what a reservation sees.
func readCapacity(ctx context.Context, nodeID string) (int64, int64) {
	capacity, allocated, _ := nodeCapacity(ctx, nodeID, "read", 0, 0)
	return capacity, allocated
}

// freeGpus is what a placement attempt would actually be granted: never negative.
func freeGpus(capacity, allocated int64) int64 {
	free := capacity - allocated
	if free < 0 {
		free = 0
	}
	return free
}

// canPlace is the admission test the scheduler runs before it reserves.
func canPlace(capacity, allocated, wantGpus int64) bool {
	return wantGpus > 0 && wantGpus <= freeGpus(capacity, allocated)
}

// requireOperator: the fleet view is an operator surface, not a tenant surface.
func requireOperator(operatorID, token, scope string) bool {
	return operatorID != "" && token != "" && scope == operatorScope
}

// reconcileNode rebuilds allocated from the ledger when a node re-registers after a reboot.
func reconcileNode(ctx context.Context, nodeID string, capacity int64) int64 {
	allocated := ledger.ActiveGpusFor(nodeID)
	nodeCapacity(ctx, nodeID, "sync", capacity, allocated)
	return allocated
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func requireOperatorOrForbidden(rw http.ResponseWriter, r *http.Request) string {
	operatorID := r.Header.Get("X-Operator-Id")
	if !requireOperator(operatorID, r.Header.Get("X-Operator-Token"), r.Header.Get("X-Scope")) {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "operator scope required"})
		return ""
	}
	return operatorID
}

func readNode(rw http.ResponseWriter, r *http.Request) {
	operatorID := requireOperatorOrForbidden(rw, r)
	if operatorID == "" {
		return
	}
	nodeID := r.PathValue("id")
	capacity, allocated := readCapacity(r.Context(), nodeID)
	free := freeGpus(capacity, allocated)
	wantGpus := int64(defaultWantGpus)
	if raw := r.URL.Query().Get("want_gpus"); raw != "" {
		if parsed, err := strconv.ParseInt(raw, 10, 64); err == nil {
			wantGpus = parsed
		}
	}
	log.Printf("node read operator=%s node=%s capacity=%d allocated=%d free=%d", operatorID, nodeID, capacity, allocated, free)
	writeJSON(rw, http.StatusOK, map[string]any{
		"node_id":   nodeID,
		"capacity":  capacity,
		"allocated": allocated,
		"free":      free,
		"placeable": canPlace(capacity, allocated, wantGpus),
	})
}

func registerNode(rw http.ResponseWriter, r *http.Request) {
	operatorID := requireOperatorOrForbidden(rw, r)
	if operatorID == "" {
		return
	}
	nodeID := r.PathValue("id")
	var body nodeRegistration
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	allocated := reconcileNode(r.Context(), nodeID, body.Capacity)
	writeJSON(rw, http.StatusOK, map[string]any{
		"node_id":   nodeID,
		"capacity":  body.Capacity,
		"allocated": allocated,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/nodes/{id}", readNode)
	mux.HandleFunc("POST /v1/nodes/{id}/register", registerNode)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
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

final case class NodeView(node_id: String, capacity: Long, allocated: Long, free: Long)

object NodeRead {
  implicit val system: ActorSystem = ActorSystem("gpusched")
  implicit val nodeViewFormat: RootJsonFormat[NodeView] = jsonFormat4(NodeView)

  val CacheTtlMs = 5 * 60 * 1000L
  val allocatedCache = scala.collection.mutable.Map.empty[String, (Long, Long)]
  val jedis = new Jedis("redis", 6379)

  // The allocated count from the last refresh, at most five minutes behind the ledger.
  def cachedAllocated(nodeId: String): Long = {
    val (refreshedAt, allocated) = allocatedCache.getOrElse(nodeId, (0L, 0L))
    if (System.currentTimeMillis() - refreshedAt > CacheTtlMs) {
      allocatedCache(nodeId) = (System.currentTimeMillis(), allocated)
    }
    allocated
  }

  val route: Route =
    path("v1" / "nodes" / Segment) { nodeId =>
      get {
        // TODO: this draft computes free from a five-minute snapshot of the allocated count and
        // serves any node to any caller. Recompute free through the same atomic path the scheduler
        // writes, clamp it, resync a node that rebooted, and scope the view to operators.
        val capacity =
          Option(jedis.hget(s"node:" + nodeId, "capacity")).map(_.toLong).getOrElse(0L)
        val allocated = cachedAllocated(nodeId)
        val free = capacity - allocated
        complete(StatusCodes.OK, NodeView(nodeId, capacity, allocated, free))
      }
    }

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

final case class NodeView(
    node_id: String,
    capacity: Long,
    allocated: Long,
    free: Long,
    placeable: Boolean
)
final case class NodeRegistration(capacity: Long)

object NodeRead {
  implicit val system: ActorSystem = ActorSystem("gpusched")
  implicit val nodeViewFormat: RootJsonFormat[NodeView] = jsonFormat5(NodeView)
  implicit val registrationFormat: RootJsonFormat[NodeRegistration] = jsonFormat1(NodeRegistration)

  val OperatorScope = "operator"
  val DefaultWantGpus = 1L

  val jedis = new Jedis("redis", 6379)

  // Allocate, release, resync and read all run this script: capacity and allocated are only ever
  // touched here, so a read cannot see half a reservation.
  val NodeCapacityLua =
    """
      |local capacity = tonumber(redis.call('HGET', KEYS[1], 'capacity')) or 0
      |local allocated = tonumber(redis.call('HGET', KEYS[1], 'allocated')) or 0
      |local op = ARGV[1]
      |local gpus = tonumber(ARGV[2])
      |if op == 'reserve' then
      |  if allocated + gpus > capacity then
      |    return {capacity, allocated, 0}
      |  end
      |  allocated = allocated + gpus
      |elseif op == 'release' then
      |  allocated = math.max(allocated - gpus, 0)
      |elseif op == 'sync' then
      |  capacity = gpus
      |  allocated = tonumber(ARGV[3])
      |end
      |redis.call('HSET', KEYS[1], 'capacity', capacity, 'allocated', allocated)
      |return {capacity, allocated, 1}
      |""".stripMargin

  object ledger {
    /** Every open allocation on this node, summed: the ledger, not the agent's claim. */
    def activeGpusFor(nodeId: String): Long = throw new UnsupportedOperationException("no ledger row for " + nodeId)
  }

  def nodeKey(nodeId: String): String = "node:" + nodeId

  /** The one path to capacity and allocated; the scheduler reserves through it too. */
  def nodeCapacity(nodeId: String, op: String, gpus: Long = 0L, allocated: Long = 0L): (Long, Long, Boolean) = {
    val result = jedis
      .eval(NodeCapacityLua, 1, nodeKey(nodeId), op, gpus.toString, allocated.toString)
      .asInstanceOf[java.util.List[Long]]
    (result.get(0), result.get(1), result.get(2) == 1L)
  }

  /** The read runs the same script with op=read, so it sees what a reservation sees. */
  def readCapacity(nodeId: String): (Long, Long) = {
    val (capacity, allocated, _) = nodeCapacity(nodeId, "read")
    (capacity, allocated)
  }

  /** What a placement attempt would actually be granted: never a negative number of GPUs. */
  def freeGpus(capacity: Long, allocated: Long): Long = math.max(capacity - allocated, 0L)

  /** The admission test the scheduler runs before it reserves. */
  def canPlace(capacity: Long, allocated: Long, wantGpus: Long): Boolean =
    wantGpus > 0 && wantGpus <= freeGpus(capacity, allocated)

  /** The fleet view is an operator surface: a tenant credential is not a fleet credential. */
  def requireOperator(operatorId: String, token: String, scope: String): Boolean =
    operatorId.nonEmpty && token.nonEmpty && scope == OperatorScope

  /** A node that rebooted re-registers: allocated is rebuilt from the ledger, not trusted. */
  def reconcileNode(nodeId: String, capacity: Long): Long = {
    val allocated = ledger.activeGpusFor(nodeId)
    nodeCapacity(nodeId, "sync", capacity, allocated)
    allocated
  }

  def operatorOf(operatorId: Option[String], token: Option[String], scope: Option[String]): Option[String] =
    if (requireOperator(operatorId.getOrElse(""), token.getOrElse(""), scope.getOrElse(""))) operatorId else None

  val route: Route =
    path("v1" / "nodes" / Segment) { nodeId =>
      get {
        optionalHeaderValueByName("X-Operator-Id") { operatorIdOpt =>
          optionalHeaderValueByName("X-Operator-Token") { tokenOpt =>
            optionalHeaderValueByName("X-Scope") { scopeOpt =>
              operatorOf(operatorIdOpt, tokenOpt, scopeOpt) match {
                case None =>
                  complete(StatusCodes.Forbidden, """{"error":"operator scope required"}""")
                case Some(operatorId) =>
                  parameter("want_gpus".as[Long].?) { wantGpusOpt =>
                    val (capacity, allocated) = readCapacity(nodeId)
                    val free = freeGpus(capacity, allocated)
                    system.log.info(
                      s"node read operator=" + operatorId + " node=" + nodeId + " capacity=" + capacity +
                        " allocated=" + allocated + " free=" + free
                    )
                    complete(
                      StatusCodes.OK,
                      NodeView(nodeId, capacity, allocated, free, canPlace(capacity, allocated, wantGpusOpt.getOrElse(DefaultWantGpus)))
                    )
                  }
              }
            }
          }
        }
      }
    } ~
      path("v1" / "nodes" / Segment / "register") { nodeId =>
        post {
          optionalHeaderValueByName("X-Operator-Id") { operatorIdOpt =>
            optionalHeaderValueByName("X-Operator-Token") { tokenOpt =>
              optionalHeaderValueByName("X-Scope") { scopeOpt =>
                operatorOf(operatorIdOpt, tokenOpt, scopeOpt) match {
                  case None =>
                    complete(StatusCodes.Forbidden, """{"error":"operator scope required"}""")
                  case Some(_) =>
                    entity(as[NodeRegistration]) { body =>
                      val allocated = reconcileNode(nodeId, body.capacity)
                      complete(StatusCodes.OK, NodeView(nodeId, body.capacity, allocated, freeGpus(body.capacity, allocated), false))
                    }
                }
              }
            }
          }
        }
      }

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

#include <chrono>
#include <string>
#include <unordered_map>

using json = nlohmann::json;

constexpr long long kCacheTtlMs = 5 * 60 * 1000;

struct CachedAllocated {
  long long refreshed_at_ms = 0;
  long long allocated = 0;
};

sw::redis::Redis redis("tcp://redis:6379");
std::unordered_map<std::string, CachedAllocated> allocated_cache;

// cached_allocated is the allocated count from the last refresh, at most five minutes behind.
long long cached_allocated(const std::string& node_id) {
  auto& hit = allocated_cache[node_id];
  const auto now = std::chrono::duration_cast<std::chrono::milliseconds>(
                       std::chrono::system_clock::now().time_since_epoch())
                       .count();
  if (now - hit.refreshed_at_ms > kCacheTtlMs) hit.refreshed_at_ms = now;
  return hit.allocated;
}

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/nodes/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft computes free from a five-minute snapshot of the allocated count and serves
    // any node to any caller. Recompute free through the same atomic path the scheduler writes,
    // clamp it so the read can never promise a GPU a placement would refuse, resync a node that
    // rebooted, and scope the view to operators.
    const auto node_id = req.matches[1];
    const auto raw = redis.hget("node:" + node_id, "capacity");
    const long long capacity = raw ? std::stoll(*raw) : 0;
    const long long allocated = cached_allocated(node_id);
    res.status = 200;
    res.set_content(
        json{{"node_id", node_id},
             {"capacity", capacity},
             {"allocated", allocated},
             {"free", capacity - allocated}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <iostream>
#include <string>
#include <tuple>
#include <utility>
#include <vector>

using json = nlohmann::json;
using sw::redis::Redis;

Redis redis("tcp://redis:6379");

const std::string kOperatorScope = "operator";
constexpr long long kDefaultWantGpus = 1;

// Allocate, release, resync and read all run this script: capacity and allocated are only ever
// touched here, so a read cannot see half a reservation.
const char* kNodeCapacityLua = R"LUA(
local capacity = tonumber(redis.call('HGET', KEYS[1], 'capacity')) or 0
local allocated = tonumber(redis.call('HGET', KEYS[1], 'allocated')) or 0
local op = ARGV[1]
local gpus = tonumber(ARGV[2])
if op == 'reserve' then
  if allocated + gpus > capacity then
    return {capacity, allocated, 0}
  end
  allocated = allocated + gpus
elseif op == 'release' then
  allocated = math.max(allocated - gpus, 0)
elseif op == 'sync' then
  capacity = gpus
  allocated = tonumber(ARGV[3])
end
redis.call('HSET', KEYS[1], 'capacity', capacity, 'allocated', allocated)
return {capacity, allocated, 1}
)LUA";

struct PlacementLedger {
  /** Every open allocation on this node, summed: the ledger, not the agent's claim. */
  long long active_gpus_for(const std::string& node_id);
};

PlacementLedger ledger;

std::string nodeKey(const std::string& node_id) { return "node:" + node_id; }

// nodeCapacity is the one path to capacity and allocated; the scheduler reserves through it too.
std::tuple<long long, long long, bool> nodeCapacity(
    const std::string& node_id, const std::string& op, long long gpus = 0, long long allocated = 0) {
  const auto values = redis.eval<std::vector<long long>>(
      kNodeCapacityLua, {nodeKey(node_id)}, {op, std::to_string(gpus), std::to_string(allocated)});
  return {values[0], values[1], values[2] == 1};
}

// readCapacity runs the same script with op=read, so it sees what a reservation sees.
std::pair<long long, long long> readCapacity(const std::string& node_id) {
  const auto [capacity, allocated, ok] = nodeCapacity(node_id, "read");
  return {capacity, allocated};
}

// freeGpus is what a placement attempt would actually be granted: never negative.
long long freeGpus(long long capacity, long long allocated) { return std::max(capacity - allocated, 0LL); }

// canPlace is the admission test the scheduler runs before it reserves.
bool canPlace(long long capacity, long long allocated, long long want_gpus) {
  return want_gpus > 0 && want_gpus <= freeGpus(capacity, allocated);
}

// requireOperator: the fleet view is an operator surface, not a tenant surface.
bool requireOperator(
    const std::string& operator_id, const std::string& token, const std::string& scope) {
  return !operator_id.empty() && !token.empty() && scope == kOperatorScope;
}

// reconcileNode rebuilds allocated from the ledger when a node re-registers after a reboot.
long long reconcileNode(const std::string& node_id, long long capacity) {
  const long long allocated = ledger.active_gpus_for(node_id);
  nodeCapacity(node_id, "sync", capacity, allocated);
  return allocated;
}

int main() {
  httplib::Server svr;

  const auto forbidden = [](httplib::Response& res) {
    res.status = 403;
    res.set_content(R"({"error":"operator scope required"})", "application/json");
  };

  const auto operator_of = [](const httplib::Request& req) {
    return requireOperator(
        req.get_header_value("X-Operator-Id"),
        req.get_header_value("X-Operator-Token"),
        req.get_header_value("X-Scope"));
  };

  svr.Get(R"(/v1/nodes/([^/]+))", [&forbidden, &operator_of](const httplib::Request& req, httplib::Response& res) {
    if (!operator_of(req)) {
      forbidden(res);
      return;
    }
    const auto node_id = req.matches[1];
    const auto [capacity, allocated] = readCapacity(node_id);
    const long long free = freeGpus(capacity, allocated);
    const auto raw_want = req.get_param_value("want_gpus");
    const long long want_gpus = raw_want.empty() ? kDefaultWantGpus : std::stoll(raw_want);
    std::cerr << "node read node=" << node_id << " operator=" << req.get_header_value("X-Operator-Id")
              << " capacity=" << capacity << " allocated=" << allocated << " free=" << free << "\\n";
    res.status = 200;
    res.set_content(
        json{{"node_id", node_id},
             {"capacity", capacity},
             {"allocated", allocated},
             {"free", free},
             {"placeable", canPlace(capacity, allocated, want_gpus)}}
            .dump(),
        "application/json");
  });

  svr.Post(R"(/v1/nodes/([^/]+)/register)", [&forbidden, &operator_of](const httplib::Request& req, httplib::Response& res) {
    if (!operator_of(req)) {
      forbidden(res);
      return;
    }
    const auto node_id = req.matches[1];
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    const long long capacity = body.value("capacity", 0LL);
    const long long allocated = reconcileNode(node_id, capacity);
    res.status = 200;
    res.set_content(
        json{{"node_id", node_id}, {"capacity", capacity}, {"allocated", allocated}}.dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The interviewer is testing the read side of a scarce resource: not “does it return numbers” but “is it the same number the scheduler acted on”. Three properties are checked. Ownership of the counters: one script owns \`node:{id}\` for allocation, release, resync and read, so the read and the reservation meet in the same place — a five-minute snapshot is a second owner, and its \`free\` count promises GPUs that are already handed out. Honesty of the number: \`free_gpus\` clamps at zero and \`can_place\` is the same admission test the reservation runs, so the read can never advertise more than a placement would grant, and an operator never drains a node that is already full. Scope and recovery are the parts a demo never exercises: the fleet view is an operator surface (**403** for a tenant credential), and a node that reboots re-registers, rebuilding \`allocated\` from the placement ledger instead of trusting the agent or the counters that survived the reboot. Real schedulers add per-metric capacity (MIG profiles, GPU memory, per-type counts), a drain mode that reports what preemption would free, and a reconciliation loop that compares the ledger against each agent's own device inventory on every heartbeat.`,
};
