import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'The node ledger: one script books, one script releases',
  concept: 'redis',
  guides: ['atomic-state', 'leases'],
  file: 'state',
  focus: ['scheduler', 'redis'],
  task: `## Task

**Starting point.** The starter is the node ledger every other step calls: \`register_node\`
writes \`node:{id}\` and \`heartbeat:{id}\`, \`allocate\` books GPUs for a placement, \`release\`
returns them. It places the demo job and hides four flaws.

**Failure mode the checks target.** Two placements race for the last GPU and both win, because the
free count is read on the client and moved in a second round trip; a machine that died keeps its
place in the scheduling set because its heartbeat has no TTL; a retried release returns GPUs twice;
a refused placement leaves its record behind.

- \`node:{id}\` holds \`gpu_type\`, \`capacity\` and \`allocated\`; \`nodes\` is the set of ids.
- \`heartbeat:{id}\` is set with a TTL of \`HEARTBEAT_TTL_S\` on registration and on every
  \`heartbeat\`; while it exists the node is alive.
- \`allocate(node_id, placement_id, count)\` is **one Lua script**: refuse with \`NO_HEARTBEAT\`
  when the heartbeat lapsed, with \`NO_CAPACITY\` when \`allocated + count > capacity\`, otherwise
  move \`allocated\`, write \`placement:{pid}\` (\`node_id\`, \`count\`, \`status\`), add the id to
  \`node:{id}:placements\` and return \`ALLOCATED\`. A refused placement writes nothing.
- \`release(node_id, placement_id)\` is one script keyed by the placement id: it moves the counters
  only when the id is still in \`node:{id}:placements\`, and reports whether it did. The same key
  makes \`allocate\` safe to retry: an id already in the set is \`ALLOCATED\` without booking again.`,
  sequence: {
    participants: ['gpusched', 'Redis'],
    messages: [
      {
        from: 'gpusched',
        to: 'Redis',
        label: 'HSET node:gpu-1 … · SADD nodes · SET heartbeat:gpu-1 1 EX 30',
        kind: 'sync',
      },
      {
        from: 'gpusched',
        to: 'Redis',
        label: 'EVAL allocate · KEYS node:gpu-1 heartbeat:gpu-1 placement:p-1 node:gpu-1:placements',
        kind: 'sync',
      },
      {from: 'Redis', to: 'gpusched', label: 'ALLOCATED (allocated 0 → 4, placement:p-1 written)', kind: 'reply'},
      {from: 'gpusched', to: 'Redis', label: 'EVAL allocate · p-2 wants 6', kind: 'sync'},
      {from: 'Redis', to: 'gpusched', label: 'NO_CAPACITY (nothing written)', kind: 'reply'},
      {from: 'gpusched', to: 'Redis', label: 'EVAL release · p-1, twice', kind: 'sync'},
      {from: 'Redis', to: 'gpusched', label: '1, then 0', kind: 'reply'},
    ],
  },
  hints: [
    'Under load two placements on one node both answer ALLOCATED and the node ends up over capacity; a node that was powered off yesterday still gets placements; a retried release leaves `allocated` negative.',
    'The starter reads the counters with one command and moves them with another, so a second request lands between them and sees the same free count. SET without EX means the heartbeat never lapses; release does not ask whether the placement is still open.',
    'Put the heartbeat check, the capacity compare, HINCRBY, HSET and SADD in one EVAL with the placement id in ARGV; SET heartbeat with EX HEARTBEAT_TTL_S; make release SISMEMBER the placement set first and return 0 when it is gone.',
  ],
  checks: [
    {
      id: 'node-ledger-keys',
      title: 'Registration writes node:{id}, nodes and the heartbeat',
      detail:
        'The counters live under the node’s own key: `node:{id}` with `gpu_type`, `capacity` and `allocated`, the id in `nodes`, and `heartbeat:{id}` beside it. Allocation writes `placement:{pid}` and adds the id to `node:{id}:placements`. The starter keys per node already.',
      match: {
        python: {
          all: [
            /f["']node:\{node_id\}["']/,
            /["']nodes["']/,
            /f["']heartbeat:\{node_id\}["']/,
            /f["']placement:\{placement_id\}["']/,
          ],
        },
        typescript: {
          all: [/`node:\$\{nodeId\}`/, /['"]nodes['"]/, /`heartbeat:\$\{nodeId\}`/, /`placement:\$\{placementId\}`/],
        },
        go: {
          all: [/"node:"\s*\+\s*nodeID/, /"nodes"/, /"heartbeat:"\s*\+\s*nodeID/, /"placement:"\s*\+\s*placementID/],
        },
        scala: {all: [/s"node:\$nodeId"/, /"nodes"/, /s"heartbeat:\$nodeId"/, /s"placement:\$placementId"/]},
        cpp: {
          all: [/"node:"\s*\+\s*node_id/, /"nodes"/, /"heartbeat:"\s*\+\s*node_id/, /"placement:"\s*\+\s*placement_id/],
        },
      },
    },
    {
      id: 'atomic-allocation',
      title: 'One script compares and moves the counters',
      detail:
        'Allocation is one `EVAL`: the script reads `capacity` and `allocated`, compares and runs `HINCRBY` in the same call. The starter reads with `HMGET` on the client and moves with a second round trip, so two placements both see the last GPU free.',
      match: {
        python: {
          all: [
            /redis\.call\(\s*['"]HM?GET['"]/,
            /redis\.call\(\s*['"]HINCRBY['"]/,
            /register_script\(|\.eval\(|\.evalsha\(/,
          ],
          none: [/\br\.hincrby\(/, /\br\.hmget\(/],
        },
        typescript: {
          all: [
            /redis\.call\(\s*['"]HM?GET['"]/,
            /redis\.call\(\s*['"]HINCRBY['"]/,
            /defineCommand\(|\.eval\(|\.evalsha\(/,
          ],
          none: [/redis\.hincrby\(/, /redis\.hmget\(/],
        },
        go: {
          all: [
            /redis\.call\(\s*['"]HM?GET['"]/,
            /redis\.call\(\s*['"]HINCRBY['"]/,
            /redis\.NewScript\(|\.Eval\(|\.EvalSha\(/,
          ],
          none: [/rdb\.HIncrBy\(/, /rdb\.HMGet\(/],
        },
        scala: {
          all: [/redis\.call\(\s*['"]HM?GET['"]/, /redis\.call\(\s*['"]HINCRBY['"]/, /jedis\.eval(sha)?\(/],
          none: [/jedis\.hincrBy\(/, /jedis\.hmget\(/],
        },
        cpp: {
          all: [/redis\.call\(\s*['"]HM?GET['"]/, /redis\.call\(\s*['"]HINCRBY['"]/, /redis\.eval(sha)?[<(]/],
          none: [/redis\.hincrby\(/, /redis\.hmget\(/],
        },
      },
    },
    {
      id: 'heartbeat-liveness',
      title: 'A node whose heartbeat lapsed is refused',
      detail:
        '`heartbeat:{id}` is set with `EX HEARTBEAT_TTL_S` and the script refuses the node with `NO_HEARTBEAT` when the key is gone. The starter sets the key without a TTL, so a dead node stays schedulable.',
      match: {
        python: {
          all: [
            /HEARTBEAT_TTL_S/,
            /\bex\s*=\s*HEARTBEAT_TTL_S|["']EX["']\s*,\s*HEARTBEAT_TTL_S/,
            /redis\.call\(\s*['"]EXISTS['"]\s*,\s*KEYS\[2\]\s*\)/,
            /NO_HEARTBEAT/,
          ],
        },
        typescript: {
          all: [
            /HEARTBEAT_TTL_S/,
            /['"]EX['"]\s*,\s*HEARTBEAT_TTL_S/,
            /redis\.call\(\s*['"]EXISTS['"]\s*,\s*KEYS\[2\]\s*\)/,
            /NO_HEARTBEAT/,
          ],
        },
        go: {
          all: [
            /config\.HeartbeatTTL/,
            /\.Set\([^\n]*config\.HeartbeatTTL\s*\)|\.SetEx\([^\n]*config\.HeartbeatTTL/,
            /redis\.call\(\s*['"]EXISTS['"]\s*,\s*KEYS\[2\]\s*\)/,
            /NO_HEARTBEAT/,
          ],
        },
        scala: {
          all: [
            /HeartbeatTtlS/,
            /\.setex\([^\n]*HeartbeatTtlS|\.ex\(\s*HeartbeatTtlS/,
            /redis\.call\(\s*['"]EXISTS['"]\s*,\s*KEYS\[2\]\s*\)/,
            /NO_HEARTBEAT/,
          ],
        },
        cpp: {
          all: [
            /kHeartbeatTtlS/,
            /\.set\([^\n]*kHeartbeatTtlS|\.setex\([^\n]*kHeartbeatTtlS/,
            /redis\.call\(\s*['"]EXISTS['"]\s*,\s*KEYS\[2\]\s*\)/,
            /NO_HEARTBEAT/,
          ],
        },
      },
    },
    {
      id: 'idempotent-release',
      title: 'Release moves the counters once per placement id',
      detail:
        'The release script checks `SISMEMBER node:{id}:placements` first and returns 0 when the id is gone; the counters move only on the first call. The starter decrements on every call, so a retry inflates free capacity.',
      match: {
        python: {all: [/redis\.call\(\s*['"]SISMEMBER['"]/, /redis\.call\(\s*['"]SREM['"]/]},
        typescript: {all: [/redis\.call\(\s*['"]SISMEMBER['"]/, /redis\.call\(\s*['"]SREM['"]/]},
        go: {all: [/redis\.call\(\s*['"]SISMEMBER['"]/, /redis\.call\(\s*['"]SREM['"]/]},
        scala: {all: [/redis\.call\(\s*['"]SISMEMBER['"]/, /redis\.call\(\s*['"]SREM['"]/]},
        cpp: {all: [/redis\.call\(\s*['"]SISMEMBER['"]/, /redis\.call\(\s*['"]SREM['"]/]},
      },
    },
    {
      id: 'honest-contention',
      title: 'A refused placement writes nothing',
      detail:
        'The script compares before it writes: `NO_CAPACITY` comes back with `allocated`, `placement:{pid}` and `node:{id}:placements` untouched. The starter writes the placement record on the client before it decides.',
      match: {
        python: {
          all: [/NO_CAPACITY/, /redis\.call\(\s*['"]HSET['"]\s*,\s*KEYS\[3\]/],
          none: [/\br\.hset\(\s*f?["']placement:/],
        },
        typescript: {
          all: [/NO_CAPACITY/, /redis\.call\(\s*['"]HSET['"]\s*,\s*KEYS\[3\]/],
          none: [/redis\.hset\(\s*`placement:/],
        },
        go: {
          all: [/NO_CAPACITY/, /redis\.call\(\s*['"]HSET['"]\s*,\s*KEYS\[3\]/],
          none: [/rdb\.HSet\([^\n]*"placement:"/],
        },
        scala: {
          all: [/NO_CAPACITY/, /redis\.call\(\s*['"]HSET['"]\s*,\s*KEYS\[3\]/],
          none: [/jedis\.hset\([^\n]*s"placement:/],
        },
        cpp: {
          all: [/NO_CAPACITY/, /redis\.call\(\s*['"]HSET['"]\s*,\s*KEYS\[3\]/],
          none: [/redis\.hset\([^\n]*"placement:"/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

from gpusched.config import HEARTBEAT_TTL_S

r = redis.Redis(host="redis", port=6379, decode_responses=True)

# TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.


def register_node(node_id: str, gpu_type: str, capacity: int) -> None:
    """A node joins the fleet (or re-registers after a reboot) with its GPU type and capacity."""
    r.hset(f"node:{node_id}", mapping={"gpu_type": gpu_type, "capacity": capacity})
    r.hsetnx(f"node:{node_id}", "allocated", 0)
    r.sadd("nodes", node_id)
    r.set(f"heartbeat:{node_id}", "1")


def heartbeat(node_id: str) -> None:
    """The node agent reports in."""
    r.set(f"heartbeat:{node_id}", "1")


def allocate(node_id: str, placement_id: str, count: int) -> str:
    """Book count GPUs of the node for the placement: ALLOCATED, NO_CAPACITY or NO_HEARTBEAT."""
    r.hset(f"placement:{placement_id}", mapping={"node_id": node_id, "count": count, "status": "allocated"})
    capacity, allocated = r.hmget(f"node:{node_id}", "capacity", "allocated")
    if int(allocated or 0) + count > int(capacity or 0):
        return "NO_CAPACITY"
    r.hincrby(f"node:{node_id}", "allocated", count)
    r.sadd(f"node:{node_id}:placements", placement_id)
    return "ALLOCATED"


def release(node_id: str, placement_id: str) -> bool:
    """Return the placement's GPUs to the node; True when the counters moved."""
    count = int(r.hget(f"placement:{placement_id}", "count") or 0)
    r.hincrby(f"node:{node_id}", "allocated", -count)
    r.hset(f"placement:{placement_id}", "status", "released")
    r.srem(f"node:{node_id}:placements", placement_id)
    return True
`,
      solution: `import redis

from gpusched.config import HEARTBEAT_TTL_S

r = redis.Redis(host="redis", port=6379, decode_responses=True)

# KEYS: node:{id}, heartbeat:{id}, placement:{pid}, node:{id}:placements · ARGV: placement_id, node_id, count
ALLOCATE_LUA = """
if redis.call('EXISTS', KEYS[2]) == 0 then
  return 'NO_HEARTBEAT'
end
if redis.call('SISMEMBER', KEYS[4], ARGV[1]) == 1 then
  return 'ALLOCATED'
end
local node = redis.call('HMGET', KEYS[1], 'capacity', 'allocated')
local capacity, allocated, count = tonumber(node[1]) or 0, tonumber(node[2]) or 0, tonumber(ARGV[3])
if allocated + count > capacity then
  return 'NO_CAPACITY'
end
redis.call('HINCRBY', KEYS[1], 'allocated', count)
redis.call('HSET', KEYS[3], 'node_id', ARGV[2], 'count', ARGV[3], 'status', 'allocated')
redis.call('SADD', KEYS[4], ARGV[1])
return 'ALLOCATED'
"""

# KEYS: node:{id}, placement:{pid}, node:{id}:placements · ARGV: placement_id
RELEASE_LUA = """
if redis.call('SISMEMBER', KEYS[3], ARGV[1]) == 0 then
  return 0
end
local count = tonumber(redis.call('HGET', KEYS[2], 'count')) or 0
redis.call('HINCRBY', KEYS[1], 'allocated', -count)
redis.call('HSET', KEYS[2], 'status', 'released')
redis.call('SREM', KEYS[3], ARGV[1])
return 1
"""

allocate_script = r.register_script(ALLOCATE_LUA)
release_script = r.register_script(RELEASE_LUA)


def register_node(node_id: str, gpu_type: str, capacity: int) -> None:
    """A node joins the fleet (or re-registers after a reboot) with its GPU type and capacity."""
    r.hset(f"node:{node_id}", mapping={"gpu_type": gpu_type, "capacity": capacity})
    r.hsetnx(f"node:{node_id}", "allocated", 0)
    r.sadd("nodes", node_id)
    r.set(f"heartbeat:{node_id}", "1", ex=HEARTBEAT_TTL_S)


def heartbeat(node_id: str) -> None:
    """The node agent reports in."""
    r.set(f"heartbeat:{node_id}", "1", ex=HEARTBEAT_TTL_S)


def allocate(node_id: str, placement_id: str, count: int) -> str:
    """Book count GPUs of the node for the placement: ALLOCATED, NO_CAPACITY or NO_HEARTBEAT."""
    keys = [f"node:{node_id}", f"heartbeat:{node_id}", f"placement:{placement_id}", f"node:{node_id}:placements"]
    return str(allocate_script(keys=keys, args=[placement_id, node_id, count]))


def release(node_id: str, placement_id: str) -> bool:
    """Return the placement's GPUs to the node; True when the counters moved."""
    keys = [f"node:{node_id}", f"placement:{placement_id}", f"node:{node_id}:placements"]
    return int(release_script(keys=keys, args=[placement_id])) == 1
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import {HEARTBEAT_TTL_S} from 'gpusched/config';

const redis = new Redis({host: 'redis', port: 6379});

// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.

/** A node joins the fleet (or re-registers after a reboot) with its GPU type and capacity. */
export async function registerNode(nodeId: string, gpuType: string, capacity: number): Promise<void> {
  await redis.hset(\`node:\${nodeId}\`, 'gpu_type', gpuType, 'capacity', capacity);
  await redis.hsetnx(\`node:\${nodeId}\`, 'allocated', 0);
  await redis.sadd('nodes', nodeId);
  await redis.set(\`heartbeat:\${nodeId}\`, '1');
}

/** The node agent reports in. */
export async function heartbeat(nodeId: string): Promise<void> {
  await redis.set(\`heartbeat:\${nodeId}\`, '1');
}

/** Book count GPUs of the node for the placement: ALLOCATED, NO_CAPACITY or NO_HEARTBEAT. */
export async function allocate(nodeId: string, placementId: string, count: number): Promise<string> {
  await redis.hset(\`placement:\${placementId}\`, 'node_id', nodeId, 'count', count, 'status', 'allocated');
  const [capacity, allocated] = await redis.hmget(\`node:\${nodeId}\`, 'capacity', 'allocated');
  if (Number(allocated ?? 0) + count > Number(capacity ?? 0)) return 'NO_CAPACITY';
  await redis.hincrby(\`node:\${nodeId}\`, 'allocated', count);
  await redis.sadd(\`node:\${nodeId}:placements\`, placementId);
  return 'ALLOCATED';
}

/** Return the placement's GPUs to the node; true when the counters moved. */
export async function release(nodeId: string, placementId: string): Promise<boolean> {
  const count = Number((await redis.hget(\`placement:\${placementId}\`, 'count')) ?? 0);
  await redis.hincrby(\`node:\${nodeId}\`, 'allocated', -count);
  await redis.hset(\`placement:\${placementId}\`, 'status', 'released');
  await redis.srem(\`node:\${nodeId}:placements\`, placementId);
  return true;
}
`,
      solution: `import Redis from 'ioredis';

import {HEARTBEAT_TTL_S} from 'gpusched/config';

// KEYS: node:{id}, heartbeat:{id}, placement:{pid}, node:{id}:placements · ARGV: placement_id, node_id, count
const ALLOCATE_LUA = \`
if redis.call('EXISTS', KEYS[2]) == 0 then
  return 'NO_HEARTBEAT'
end
if redis.call('SISMEMBER', KEYS[4], ARGV[1]) == 1 then
  return 'ALLOCATED'
end
local node = redis.call('HMGET', KEYS[1], 'capacity', 'allocated')
local capacity, allocated, count = tonumber(node[1]) or 0, tonumber(node[2]) or 0, tonumber(ARGV[3])
if allocated + count > capacity then
  return 'NO_CAPACITY'
end
redis.call('HINCRBY', KEYS[1], 'allocated', count)
redis.call('HSET', KEYS[3], 'node_id', ARGV[2], 'count', ARGV[3], 'status', 'allocated')
redis.call('SADD', KEYS[4], ARGV[1])
return 'ALLOCATED'
\`;

// KEYS: node:{id}, placement:{pid}, node:{id}:placements · ARGV: placement_id
const RELEASE_LUA = \`
if redis.call('SISMEMBER', KEYS[3], ARGV[1]) == 0 then
  return 0
end
local count = tonumber(redis.call('HGET', KEYS[2], 'count')) or 0
redis.call('HINCRBY', KEYS[1], 'allocated', -count)
redis.call('HSET', KEYS[2], 'status', 'released')
redis.call('SREM', KEYS[3], ARGV[1])
return 1
\`;

interface LedgerRedis extends Redis {
  allocateScript(node: string, heartbeat: string, placement: string, placements: string, placementId: string, nodeId: string, count: number): Promise<string>;
  releaseScript(node: string, placement: string, placements: string, placementId: string): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as LedgerRedis;
redis.defineCommand('allocateScript', {numberOfKeys: 4, lua: ALLOCATE_LUA});
redis.defineCommand('releaseScript', {numberOfKeys: 3, lua: RELEASE_LUA});

/** A node joins the fleet (or re-registers after a reboot) with its GPU type and capacity. */
export async function registerNode(nodeId: string, gpuType: string, capacity: number): Promise<void> {
  await redis.hset(\`node:\${nodeId}\`, 'gpu_type', gpuType, 'capacity', capacity);
  await redis.hsetnx(\`node:\${nodeId}\`, 'allocated', 0);
  await redis.sadd('nodes', nodeId);
  await redis.set(\`heartbeat:\${nodeId}\`, '1', 'EX', HEARTBEAT_TTL_S);
}

/** The node agent reports in. */
export async function heartbeat(nodeId: string): Promise<void> {
  await redis.set(\`heartbeat:\${nodeId}\`, '1', 'EX', HEARTBEAT_TTL_S);
}

/** Book count GPUs of the node for the placement: ALLOCATED, NO_CAPACITY or NO_HEARTBEAT. */
export async function allocate(nodeId: string, placementId: string, count: number): Promise<string> {
  return redis.allocateScript(\`node:\${nodeId}\`, \`heartbeat:\${nodeId}\`, \`placement:\${placementId}\`, \`node:\${nodeId}:placements\`, placementId, nodeId, count);
}

/** Return the placement's GPUs to the node; true when the counters moved. */
export async function release(nodeId: string, placementId: string): Promise<boolean> {
  const moved = await redis.releaseScript(\`node:\${nodeId}\`, \`placement:\${placementId}\`, \`node:\${nodeId}:placements\`, placementId);
  return moved === 1;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"strconv"

	"github.com/redis/go-redis/v9"

	"gpusched/config"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.

// registerNode: a node joins the fleet (or re-registers after a reboot) with its GPU type and capacity.
func registerNode(ctx context.Context, nodeID, gpuType string, capacity int) error {
	if err := rdb.HSet(ctx, "node:"+nodeID, "gpu_type", gpuType, "capacity", capacity).Err(); err != nil {
		return err
	}
	rdb.HSetNX(ctx, "node:"+nodeID, "allocated", 0)
	rdb.SAdd(ctx, "nodes", nodeID)
	_ = config.HeartbeatTTL
	return rdb.Set(ctx, "heartbeat:"+nodeID, "1", 0).Err()
}

// heartbeat: the node agent reports in.
func heartbeat(ctx context.Context, nodeID string) error {
	return rdb.Set(ctx, "heartbeat:"+nodeID, "1", 0).Err()
}

// allocate books count GPUs of the node for the placement: ALLOCATED, NO_CAPACITY or NO_HEARTBEAT.
func allocate(ctx context.Context, nodeID, placementID string, count int) (string, error) {
	if err := rdb.HSet(ctx, "placement:"+placementID, "node_id", nodeID, "count", count, "status", "allocated").Err(); err != nil {
		return "", err
	}
	fields, err := rdb.HMGet(ctx, "node:"+nodeID, "capacity", "allocated").Result()
	if err != nil {
		return "", err
	}
	capacity, _ := strconv.Atoi(text(fields[0]))
	allocated, _ := strconv.Atoi(text(fields[1]))
	if allocated+count > capacity {
		return "NO_CAPACITY", nil
	}
	if err := rdb.HIncrBy(ctx, "node:"+nodeID, "allocated", int64(count)).Err(); err != nil {
		return "", err
	}
	rdb.SAdd(ctx, "node:"+nodeID+":placements", placementID)
	return "ALLOCATED", nil
}

// release returns the placement's GPUs to the node; true when the counters moved.
func release(ctx context.Context, nodeID, placementID string) (bool, error) {
	count, _ := rdb.HGet(ctx, "placement:"+placementID, "count").Int()
	if err := rdb.HIncrBy(ctx, "node:"+nodeID, "allocated", -int64(count)).Err(); err != nil {
		return false, err
	}
	rdb.HSet(ctx, "placement:"+placementID, "status", "released")
	rdb.SRem(ctx, "node:"+nodeID+":placements", placementID)
	return true, nil
}

// text is a hash field as HMGET returns it: a string, or "" for a missing field.
func text(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}
`,
      solution: `package main

import (
	"context"

	"github.com/redis/go-redis/v9"

	"gpusched/config"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// KEYS: node:{id}, heartbeat:{id}, placement:{pid}, node:{id}:placements · ARGV: placement_id, node_id, count
var allocateScript = redis.NewScript(\`
if redis.call('EXISTS', KEYS[2]) == 0 then
  return 'NO_HEARTBEAT'
end
if redis.call('SISMEMBER', KEYS[4], ARGV[1]) == 1 then
  return 'ALLOCATED'
end
local node = redis.call('HMGET', KEYS[1], 'capacity', 'allocated')
local capacity, allocated, count = tonumber(node[1]) or 0, tonumber(node[2]) or 0, tonumber(ARGV[3])
if allocated + count > capacity then
  return 'NO_CAPACITY'
end
redis.call('HINCRBY', KEYS[1], 'allocated', count)
redis.call('HSET', KEYS[3], 'node_id', ARGV[2], 'count', ARGV[3], 'status', 'allocated')
redis.call('SADD', KEYS[4], ARGV[1])
return 'ALLOCATED'
\`)

// KEYS: node:{id}, placement:{pid}, node:{id}:placements · ARGV: placement_id
var releaseScript = redis.NewScript(\`
if redis.call('SISMEMBER', KEYS[3], ARGV[1]) == 0 then
  return 0
end
local count = tonumber(redis.call('HGET', KEYS[2], 'count')) or 0
redis.call('HINCRBY', KEYS[1], 'allocated', -count)
redis.call('HSET', KEYS[2], 'status', 'released')
redis.call('SREM', KEYS[3], ARGV[1])
return 1
\`)

// registerNode: a node joins the fleet (or re-registers after a reboot) with its GPU type and capacity.
func registerNode(ctx context.Context, nodeID, gpuType string, capacity int) error {
	if err := rdb.HSet(ctx, "node:"+nodeID, "gpu_type", gpuType, "capacity", capacity).Err(); err != nil {
		return err
	}
	rdb.HSetNX(ctx, "node:"+nodeID, "allocated", 0)
	rdb.SAdd(ctx, "nodes", nodeID)
	return rdb.Set(ctx, "heartbeat:"+nodeID, "1", config.HeartbeatTTL).Err()
}

// heartbeat: the node agent reports in.
func heartbeat(ctx context.Context, nodeID string) error {
	return rdb.Set(ctx, "heartbeat:"+nodeID, "1", config.HeartbeatTTL).Err()
}

// allocate books count GPUs of the node for the placement: ALLOCATED, NO_CAPACITY or NO_HEARTBEAT.
func allocate(ctx context.Context, nodeID, placementID string, count int) (string, error) {
	keys := []string{"node:" + nodeID, "heartbeat:" + nodeID, "placement:" + placementID, "node:" + nodeID + ":placements"}
	return allocateScript.Run(ctx, rdb, keys, placementID, nodeID, count).Text()
}

// release returns the placement's GPUs to the node; true when the counters moved.
func release(ctx context.Context, nodeID, placementID string) (bool, error) {
	keys := []string{"node:" + nodeID, "placement:" + placementID, "node:" + nodeID + ":placements"}
	moved, err := releaseScript.Run(ctx, rdb, keys, placementID).Int()
	return moved == 1, err
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

import scala.jdk.CollectionConverters._

import gpusched.Config.HeartbeatTtlS

object State {
  val jedis = new JedisPooled("redis", 6379)

  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.

  /** A node joins the fleet (or re-registers after a reboot) with its GPU type and capacity. */
  def registerNode(nodeId: String, gpuType: String, capacity: Int): Unit = {
    jedis.hset(s"node:$nodeId", Map("gpu_type" -> gpuType, "capacity" -> capacity.toString).asJava)
    jedis.hsetnx(s"node:$nodeId", "allocated", "0")
    jedis.sadd("nodes", nodeId)
    jedis.set(s"heartbeat:$nodeId", "1")
  }

  /** The node agent reports in. */
  def heartbeat(nodeId: String): Unit = jedis.set(s"heartbeat:$nodeId", "1")

  /** Book count GPUs of the node for the placement: ALLOCATED, NO_CAPACITY or NO_HEARTBEAT. */
  def allocate(nodeId: String, placementId: String, count: Int): String = {
    jedis.hset(s"placement:$placementId", Map("node_id" -> nodeId, "count" -> count.toString, "status" -> "allocated").asJava)
    val fields = jedis.hmget(s"node:$nodeId", "capacity", "allocated").asScala
    val capacity = Option(fields(0)).map(_.toInt).getOrElse(0)
    val allocated = Option(fields(1)).map(_.toInt).getOrElse(0)
    if (allocated + count > capacity) return "NO_CAPACITY"
    jedis.hincrBy(s"node:$nodeId", "allocated", count.toLong)
    jedis.sadd(s"node:$nodeId:placements", placementId)
    "ALLOCATED"
  }

  /** Return the placement's GPUs to the node; true when the counters moved. */
  def release(nodeId: String, placementId: String): Boolean = {
    val count = Option(jedis.hget(s"placement:$placementId", "count")).map(_.toLong).getOrElse(0L)
    jedis.hincrBy(s"node:$nodeId", "allocated", -count)
    jedis.hset(s"placement:$placementId", "status", "released")
    jedis.srem(s"node:$nodeId:placements", placementId)
    true
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

import scala.jdk.CollectionConverters._

import gpusched.Config.HeartbeatTtlS

object State {
  val jedis = new JedisPooled("redis", 6379)

  // KEYS: node:{id}, heartbeat:{id}, placement:{pid}, node:{id}:placements · ARGV: placement_id, node_id, count
  val AllocateLua: String =
    """if redis.call('EXISTS', KEYS[2]) == 0 then
      |  return 'NO_HEARTBEAT'
      |end
      |if redis.call('SISMEMBER', KEYS[4], ARGV[1]) == 1 then
      |  return 'ALLOCATED'
      |end
      |local node = redis.call('HMGET', KEYS[1], 'capacity', 'allocated')
      |local capacity, allocated, count = tonumber(node[1]) or 0, tonumber(node[2]) or 0, tonumber(ARGV[3])
      |if allocated + count > capacity then
      |  return 'NO_CAPACITY'
      |end
      |redis.call('HINCRBY', KEYS[1], 'allocated', count)
      |redis.call('HSET', KEYS[3], 'node_id', ARGV[2], 'count', ARGV[3], 'status', 'allocated')
      |redis.call('SADD', KEYS[4], ARGV[1])
      |return 'ALLOCATED'
      |""".stripMargin

  // KEYS: node:{id}, placement:{pid}, node:{id}:placements · ARGV: placement_id
  val ReleaseLua: String =
    """if redis.call('SISMEMBER', KEYS[3], ARGV[1]) == 0 then
      |  return 0
      |end
      |local count = tonumber(redis.call('HGET', KEYS[2], 'count')) or 0
      |redis.call('HINCRBY', KEYS[1], 'allocated', -count)
      |redis.call('HSET', KEYS[2], 'status', 'released')
      |redis.call('SREM', KEYS[3], ARGV[1])
      |return 1
      |""".stripMargin

  /** A node joins the fleet (or re-registers after a reboot) with its GPU type and capacity. */
  def registerNode(nodeId: String, gpuType: String, capacity: Int): Unit = {
    jedis.hset(s"node:$nodeId", Map("gpu_type" -> gpuType, "capacity" -> capacity.toString).asJava)
    jedis.hsetnx(s"node:$nodeId", "allocated", "0")
    jedis.sadd("nodes", nodeId)
    jedis.setex(s"heartbeat:$nodeId", HeartbeatTtlS, "1")
  }

  /** The node agent reports in. */
  def heartbeat(nodeId: String): Unit = jedis.setex(s"heartbeat:$nodeId", HeartbeatTtlS, "1")

  /** Book count GPUs of the node for the placement: ALLOCATED, NO_CAPACITY or NO_HEARTBEAT. */
  def allocate(nodeId: String, placementId: String, count: Int): String = {
    val keys = List(s"node:$nodeId", s"heartbeat:$nodeId", s"placement:$placementId", s"node:$nodeId:placements").asJava
    val args = List(placementId, nodeId, count.toString).asJava
    jedis.eval(AllocateLua, keys, args).toString
  }

  /** Return the placement's GPUs to the node; true when the counters moved. */
  def release(nodeId: String, placementId: String): Boolean = {
    val keys = List(s"node:$nodeId", s"placement:$placementId", s"node:$nodeId:placements").asJava
    jedis.eval(ReleaseLua, keys, List(placementId).asJava).asInstanceOf[java.lang.Long] == 1L
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <string>

#include "gpusched/config.h"
#include "state.h"

sw::redis::Redis redis("tcp://redis:6379");

// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.

// A node joins the fleet (or re-registers after a reboot) with its GPU type and capacity.
void register_node(const std::string& node_id, const std::string& gpu_type, int capacity) {
  redis.hset("node:" + node_id, "gpu_type", gpu_type, "capacity", std::to_string(capacity));
  redis.hsetnx("node:" + node_id, "allocated", "0");
  redis.sadd("nodes", node_id);
  redis.set("heartbeat:" + node_id, "1");
}

// The node agent reports in.
void heartbeat(const std::string& node_id) { redis.set("heartbeat:" + node_id, "1"); }

// Books count GPUs of the node for the placement: ALLOCATED, NO_CAPACITY or NO_HEARTBEAT.
std::string allocate(const std::string& node_id, const std::string& placement_id, int count) {
  redis.hset("placement:" + placement_id, "node_id", node_id, "count", std::to_string(count), "status", "allocated");
  std::vector<sw::redis::OptionalString> fields;
  redis.hmget("node:" + node_id, {"capacity", "allocated"}, std::back_inserter(fields));
  const int capacity = fields[0] ? std::stoi(*fields[0]) : 0;
  const int allocated = fields[1] ? std::stoi(*fields[1]) : 0;
  if (allocated + count > capacity) return "NO_CAPACITY";
  redis.hincrby("node:" + node_id, "allocated", count);
  redis.sadd("node:" + node_id + ":placements", placement_id);
  return "ALLOCATED";
}

// Returns the placement's GPUs to the node; true when the counters moved.
bool release(const std::string& node_id, const std::string& placement_id) {
  const auto count = redis.hget("placement:" + placement_id, "count");
  redis.hincrby("node:" + node_id, "allocated", -(count ? std::stoi(*count) : 0));
  redis.hset("placement:" + placement_id, "status", "released");
  redis.srem("node:" + node_id + ":placements", placement_id);
  return true;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <string>

#include "gpusched/config.h"
#include "state.h"

sw::redis::Redis redis("tcp://redis:6379");

// KEYS: node:{id}, heartbeat:{id}, placement:{pid}, node:{id}:placements · ARGV: placement_id, node_id, count
const std::string kAllocateLua = R"lua(
if redis.call('EXISTS', KEYS[2]) == 0 then
  return 'NO_HEARTBEAT'
end
if redis.call('SISMEMBER', KEYS[4], ARGV[1]) == 1 then
  return 'ALLOCATED'
end
local node = redis.call('HMGET', KEYS[1], 'capacity', 'allocated')
local capacity, allocated, count = tonumber(node[1]) or 0, tonumber(node[2]) or 0, tonumber(ARGV[3])
if allocated + count > capacity then
  return 'NO_CAPACITY'
end
redis.call('HINCRBY', KEYS[1], 'allocated', count)
redis.call('HSET', KEYS[3], 'node_id', ARGV[2], 'count', ARGV[3], 'status', 'allocated')
redis.call('SADD', KEYS[4], ARGV[1])
return 'ALLOCATED'
)lua";

// KEYS: node:{id}, placement:{pid}, node:{id}:placements · ARGV: placement_id
const std::string kReleaseLua = R"lua(
if redis.call('SISMEMBER', KEYS[3], ARGV[1]) == 0 then
  return 0
end
local count = tonumber(redis.call('HGET', KEYS[2], 'count')) or 0
redis.call('HINCRBY', KEYS[1], 'allocated', -count)
redis.call('HSET', KEYS[2], 'status', 'released')
redis.call('SREM', KEYS[3], ARGV[1])
return 1
)lua";

// A node joins the fleet (or re-registers after a reboot) with its GPU type and capacity.
void register_node(const std::string& node_id, const std::string& gpu_type, int capacity) {
  redis.hset("node:" + node_id, "gpu_type", gpu_type, "capacity", std::to_string(capacity));
  redis.hsetnx("node:" + node_id, "allocated", "0");
  redis.sadd("nodes", node_id);
  redis.set("heartbeat:" + node_id, "1", gpusched::kHeartbeatTtlS);
}

// The node agent reports in.
void heartbeat(const std::string& node_id) { redis.set("heartbeat:" + node_id, "1", gpusched::kHeartbeatTtlS); }

// Books count GPUs of the node for the placement: ALLOCATED, NO_CAPACITY or NO_HEARTBEAT.
std::string allocate(const std::string& node_id, const std::string& placement_id, int count) {
  const auto result = redis.eval<std::string>(
      kAllocateLua, {"node:" + node_id, "heartbeat:" + node_id, "placement:" + placement_id, "node:" + node_id + ":placements"},
      {placement_id, node_id, std::to_string(count)});
  return result ? *result : "";
}

// Returns the placement's GPUs to the node; true when the counters moved.
bool release(const std::string& node_id, const std::string& placement_id) {
  return redis.eval<long long>(kReleaseLua, {"node:" + node_id, "placement:" + placement_id, "node:" + node_id + ":placements"},
                               {placement_id}) == 1;
}
`,
    },
  },
  harness: {
    python: `NODE = "node:gpu-1"


def _ledger(ctx):
    m = ctx.load("state")
    m.register_node("gpu-1", "a100", 8)
    return m


def _allocated(ctx, node="gpu-1"):
    return int(ctx.redis.hget(f"node:{node}", "allocated") or 0)


def check_node_ledger_keys(ctx):
    m = _ledger(ctx)
    assert ctx.redis.sismember("nodes", "gpu-1"), f"register_node must add the id to the nodes set (keys: {sorted(ctx.redis.keys('*'))})"
    node = ctx.redis.hgetall(NODE)
    assert node.get("gpu_type") == "a100" and node.get("capacity") == "8" and node.get("allocated") == "0", f"node:gpu-1 is {node}, expected gpu_type a100, capacity 8, allocated 0"
    assert ctx.redis.exists("heartbeat:gpu-1"), "register_node must set heartbeat:gpu-1"
    assert m.allocate("gpu-1", "p-1", 4) == "ALLOCATED", "4 of 8 GPUs on an idle node must be ALLOCATED"
    assert _allocated(ctx) == 4, f"allocated is {_allocated(ctx)} after booking 4, expected 4"
    record = ctx.redis.hgetall("placement:p-1")
    assert record.get("node_id") == "gpu-1" and record.get("count") == "4" and record.get("status") == "allocated", f"placement:p-1 is {record}, expected node_id gpu-1, count 4, status allocated"
    assert ctx.redis.smembers("node:gpu-1:placements") == {"p-1"}, f"node:gpu-1:placements is {ctx.redis.smembers('node:gpu-1:placements')}, expected {{p-1}}"
    assert m.release("gpu-1", "p-1") is True, "the first release of p-1 moves the counters and reports True"
    assert _allocated(ctx) == 0, f"allocated is {_allocated(ctx)} after the release, expected 0"
    assert ctx.redis.hget("placement:p-1", "status") == "released", "release must mark placement:p-1 released"


def check_atomic_allocation(ctx):
    m = _ledger(ctx)

    def rival():
        """Another scheduler replica books the whole node the instant the first command on node:gpu-1 lands."""
        if _allocated(ctx) + 8 > 8:
            return "no room"
        ctx.redis.hincrby(NODE, "allocated", 8)
        ctx.redis.hset("placement:rival", mapping={"node_id": "gpu-1", "count": 8, "status": "allocated"})
        ctx.redis.sadd("node:gpu-1:placements", "rival")
        return "booked"

    probe = ctx.redis_after(NODE, rival)
    result = m.allocate("gpu-1", "p-1", 8)
    assert probe.fired, "allocate never touched node:gpu-1"
    assert probe.error is None, f"the rival's booking failed: {probe.error!r}"
    allocated = _allocated(ctx)
    assert allocated <= 8, f"node:gpu-1 has {allocated} GPUs allocated of 8: a rival replica booked the node between your read of the counters and your write ({probe.result}), and your request answered {result}. Compare and HINCRBY inside one EVAL"
    if probe.result == "booked":
        assert result == "NO_CAPACITY", f"the rival booked the node first, so the request must answer NO_CAPACITY, got {result}"
    assert m.allocate("gpu-1", "p-2", 1) == "NO_CAPACITY", "with the node full the next placement is NO_CAPACITY"


def check_heartbeat_liveness(ctx):
    m = _ledger(ctx)
    ttl = ctx.redis.ttl("heartbeat:gpu-1")
    assert 0 < ttl <= 30, f"heartbeat:gpu-1 has TTL {ttl}: register_node must set it with EX HEARTBEAT_TTL_S (30), or a dead node stays schedulable"
    ctx.clock.advance(31)
    assert not ctx.redis.exists("heartbeat:gpu-1"), "31 s after registration the heartbeat must have lapsed"
    result = m.allocate("gpu-1", "p-1", 2)
    assert result == "NO_HEARTBEAT", f"a node whose heartbeat lapsed answered {result}, expected NO_HEARTBEAT"
    assert _allocated(ctx) == 0 and not ctx.redis.exists("placement:p-1"), "a refused placement must write nothing"
    m.heartbeat("gpu-1")
    ttl = ctx.redis.ttl("heartbeat:gpu-1")
    assert 0 < ttl <= 30, f"heartbeat() left TTL {ttl} on heartbeat:gpu-1, expected EX HEARTBEAT_TTL_S"
    assert m.allocate("gpu-1", "p-1", 2) == "ALLOCATED", "once the agent reports in again the node takes placements"


def check_idempotent_release(ctx):
    m = _ledger(ctx)
    assert m.allocate("gpu-1", "p-1", 4) == "ALLOCATED"
    assert m.release("gpu-1", "p-1") is True, "the first release reports True"
    second = m.release("gpu-1", "p-1")
    assert _allocated(ctx) == 0, f"allocated is {_allocated(ctx)} after releasing p-1 twice, expected 0: a retried release must not move the counters again"
    assert second is False, f"the second release of p-1 reported {second!r}, expected False"
    assert m.release("gpu-1", "ghost") is False and _allocated(ctx) == 0, "releasing an unknown placement moves nothing"
    assert m.allocate("gpu-1", "p-2", 8) == "ALLOCATED", "the node has all 8 GPUs free after one real release"


def check_honest_contention(ctx):
    m = _ledger(ctx)
    assert m.allocate("gpu-1", "p-1", 6) == "ALLOCATED"
    result = m.allocate("gpu-1", "p-2", 4)
    assert result == "NO_CAPACITY", f"4 GPUs on a node with 2 free answered {result}, expected NO_CAPACITY"
    assert _allocated(ctx) == 6, f"allocated is {_allocated(ctx)} after a refused placement, expected 6"
    assert not ctx.redis.exists("placement:p-2"), "a refused placement must leave no placement:p-2 record"
    assert ctx.redis.smembers("node:gpu-1:placements") == {"p-1"}, f"node:gpu-1:placements is {ctx.redis.smembers('node:gpu-1:placements')}, expected only p-1"
    assert m.allocate("gpu-1", "p-1", 6) == "ALLOCATED" and _allocated(ctx) == 6, "a retried allocation of the same placement id is ALLOCATED without booking twice"
`,
    typescript: `const NODE = 'node:gpu-1';

async function ledger(ctx) {
  const m = ctx.load('state');
  await m.registerNode('gpu-1', 'a100', 8);
  return m;
}

const allocated = (ctx, node = 'gpu-1'): number => Number(ctx.redis.hget(\`node:\${node}\`, 'allocated') ?? 0);

export async function check_node_ledger_keys(ctx) {
  const m = await ledger(ctx);
  assert.equal(ctx.redis.sismember('nodes', 'gpu-1'), 1, \`registerNode must add the id to the nodes set (keys: \${JSON.stringify(ctx.redis.keys('*').sort())})\`);
  const node = ctx.redis.hgetall(NODE);
  assert(node.gpu_type === 'a100' && node.capacity === '8' && node.allocated === '0', \`node:gpu-1 is \${JSON.stringify(node)}, expected gpu_type a100, capacity 8, allocated 0\`);
  assert.equal(ctx.redis.exists('heartbeat:gpu-1'), 1, 'registerNode must set heartbeat:gpu-1');
  assert.equal(await m.allocate('gpu-1', 'p-1', 4), 'ALLOCATED', '4 of 8 GPUs on an idle node must be ALLOCATED');
  assert.equal(allocated(ctx), 4, 'allocated after booking 4');
  const record = ctx.redis.hgetall('placement:p-1');
  assert(record.node_id === 'gpu-1' && record.count === '4' && record.status === 'allocated', \`placement:p-1 is \${JSON.stringify(record)}, expected node_id gpu-1, count 4, status allocated\`);
  assert.deepEqual(ctx.redis.smembers('node:gpu-1:placements'), ['p-1'], 'node:gpu-1:placements after one allocation');
  assert.equal(await m.release('gpu-1', 'p-1'), true, 'the first release of p-1 moves the counters and reports true');
  assert.equal(allocated(ctx), 0, 'allocated after the release');
  assert.equal(ctx.redis.hget('placement:p-1', 'status'), 'released', 'release must mark placement:p-1 released');
}

export async function check_atomic_allocation(ctx) {
  const m = await ledger(ctx);
  // Another scheduler replica books the whole node the instant the first command on node:gpu-1 lands.
  const probe = ctx.redisAfter(NODE, () => {
    if (allocated(ctx) + 8 > 8) return 'no room';
    ctx.redis.hincrby(NODE, 'allocated', 8);
    ctx.redis.hset('placement:rival', 'node_id', 'gpu-1', 'count', 8, 'status', 'allocated');
    ctx.redis.sadd('node:gpu-1:placements', 'rival');
    return 'booked';
  });
  const result = await m.allocate('gpu-1', 'p-1', 8);
  assert(probe.fired, 'allocate never touched node:gpu-1');
  assert(probe.error === undefined, \`the rival's booking failed: \${probe.error}\`);
  assert(allocated(ctx) <= 8, \`node:gpu-1 has \${allocated(ctx)} GPUs allocated of 8: a rival replica booked the node between your read of the counters and your write (\${probe.result}), and your request answered \${result}. Compare and HINCRBY inside one EVAL\`);
  if (probe.result === 'booked') assert.equal(result, 'NO_CAPACITY', 'the rival booked the node first, so the request must answer NO_CAPACITY');
  assert.equal(await m.allocate('gpu-1', 'p-2', 1), 'NO_CAPACITY', 'with the node full the next placement is NO_CAPACITY');
}

export async function check_heartbeat_liveness(ctx) {
  const m = await ledger(ctx);
  let ttl = ctx.redis.ttl('heartbeat:gpu-1');
  assert(0 < ttl && ttl <= 30, \`heartbeat:gpu-1 has TTL \${ttl}: registerNode must set it with EX HEARTBEAT_TTL_S (30), or a dead node stays schedulable\`);
  ctx.clock.advance(31);
  assert.equal(ctx.redis.exists('heartbeat:gpu-1'), 0, '31 s after registration the heartbeat must have lapsed');
  const result = await m.allocate('gpu-1', 'p-1', 2);
  assert.equal(result, 'NO_HEARTBEAT', 'a node whose heartbeat lapsed');
  assert(allocated(ctx) === 0 && ctx.redis.exists('placement:p-1') === 0, 'a refused placement must write nothing');
  await m.heartbeat('gpu-1');
  ttl = ctx.redis.ttl('heartbeat:gpu-1');
  assert(0 < ttl && ttl <= 30, \`heartbeat() left TTL \${ttl} on heartbeat:gpu-1, expected EX HEARTBEAT_TTL_S\`);
  assert.equal(await m.allocate('gpu-1', 'p-1', 2), 'ALLOCATED', 'once the agent reports in again the node takes placements');
}

export async function check_idempotent_release(ctx) {
  const m = await ledger(ctx);
  assert.equal(await m.allocate('gpu-1', 'p-1', 4), 'ALLOCATED');
  assert.equal(await m.release('gpu-1', 'p-1'), true, 'the first release reports true');
  const second = await m.release('gpu-1', 'p-1');
  assert.equal(allocated(ctx), 0, 'allocated after releasing p-1 twice (a retried release must not move the counters again)');
  assert.equal(second, false, 'the second release of p-1');
  assert((await m.release('gpu-1', 'ghost')) === false && allocated(ctx) === 0, 'releasing an unknown placement moves nothing');
  assert.equal(await m.allocate('gpu-1', 'p-2', 8), 'ALLOCATED', 'the node has all 8 GPUs free after one real release');
}

export async function check_honest_contention(ctx) {
  const m = await ledger(ctx);
  assert.equal(await m.allocate('gpu-1', 'p-1', 6), 'ALLOCATED');
  assert.equal(await m.allocate('gpu-1', 'p-2', 4), 'NO_CAPACITY', '4 GPUs on a node with 2 free');
  assert.equal(allocated(ctx), 6, 'allocated after a refused placement');
  assert.equal(ctx.redis.exists('placement:p-2'), 0, 'a refused placement must leave no placement:p-2 record');
  assert.deepEqual(ctx.redis.smembers('node:gpu-1:placements'), ['p-1'], 'node:gpu-1:placements after a refused placement');
  assert((await m.allocate('gpu-1', 'p-1', 6)) === 'ALLOCATED' && allocated(ctx) === 6, 'a retried allocation of the same placement id is ALLOCATED without booking twice');
}
`,
    go: `package main

import (
	"context"
	"sort"
	"strconv"

	"leetbuild/harness"
)

const stateNode = "node:gpu-1"

func stateLedger(ctx *harness.Ctx) {
	ctx.NoError(registerNode(context.Background(), "gpu-1", "a100", 8), "registerNode")
}

func stateAllocated(ctx *harness.Ctx) int {
	v, _ := ctx.Redis.HGet(stateNode, "allocated")
	n, _ := strconv.Atoi(v)
	return n
}

func stateAllocate(ctx *harness.Ctx, pid string, count int) string {
	result, err := allocate(context.Background(), "gpu-1", pid, count)
	ctx.NoError(err, "allocate(%s, %d)", pid, count)
	return result
}

func stateRelease(ctx *harness.Ctx, pid string) bool {
	moved, err := release(context.Background(), "gpu-1", pid)
	ctx.NoError(err, "release(%s)", pid)
	return moved
}

func statePlacements(ctx *harness.Ctx) []string {
	members := ctx.Redis.SMembers("node:gpu-1:placements")
	sort.Strings(members)
	return members
}

func CheckNodeLedgerKeys(ctx *harness.Ctx) {
	stateLedger(ctx)
	ctx.Assert(ctx.Redis.SIsMember("nodes", "gpu-1"), "registerNode must add the id to the nodes set (keys: %v)", ctx.Redis.Keys("*"))
	node := ctx.Redis.HGetAll(stateNode)
	ctx.Assert(node["gpu_type"] == "a100" && node["capacity"] == "8" && node["allocated"] == "0", "node:gpu-1 is %v, expected gpu_type a100, capacity 8, allocated 0", node)
	ctx.Equal(ctx.Redis.Exists("heartbeat:gpu-1"), 1, "registerNode must set heartbeat:gpu-1; its existence")
	ctx.Equal(stateAllocate(ctx, "p-1", 4), "ALLOCATED", "4 of 8 GPUs on an idle node")
	ctx.Equal(stateAllocated(ctx), 4, "allocated after booking 4")
	record := ctx.Redis.HGetAll("placement:p-1")
	ctx.Assert(record["node_id"] == "gpu-1" && record["count"] == "4" && record["status"] == "allocated", "placement:p-1 is %v, expected node_id gpu-1, count 4, status allocated", record)
	ctx.Equal(statePlacements(ctx), []string{"p-1"}, "node:gpu-1:placements after one allocation")
	ctx.Equal(stateRelease(ctx, "p-1"), true, "the first release of p-1 moves the counters and reports true")
	ctx.Equal(stateAllocated(ctx), 0, "allocated after the release")
	status, _ := ctx.Redis.HGet("placement:p-1", "status")
	ctx.Equal(status, "released", "release must mark placement:p-1 released; its status")
}

func CheckAtomicAllocation(ctx *harness.Ctx) {
	stateLedger(ctx)
	// Another scheduler replica books the whole node the instant the first command on node:gpu-1 lands.
	var rival string
	ctx.Redis.After(stateNode, func() any {
		if stateAllocated(ctx)+8 > 8 {
			rival = "no room"
			return nil
		}
		ctx.Redis.Do("HINCRBY", stateNode, "allocated", 8)
		ctx.Redis.Do("HSET", "placement:rival", "node_id", "gpu-1", "count", 8, "status", "allocated")
		ctx.Redis.Do("SADD", "node:gpu-1:placements", "rival")
		rival = "booked"
		return nil
	})
	result := stateAllocate(ctx, "p-1", 8)
	ctx.Assert(rival != "", "allocate never touched node:gpu-1")
	ctx.Assert(stateAllocated(ctx) <= 8, "node:gpu-1 has %d GPUs allocated of 8: a rival replica booked the node between your read of the counters and your write (%s), and your request answered %s. Compare and HINCRBY inside one EVAL", stateAllocated(ctx), rival, result)
	if rival == "booked" {
		ctx.Equal(result, "NO_CAPACITY", "the rival booked the node first, so the request")
	}
	ctx.Equal(stateAllocate(ctx, "p-2", 1), "NO_CAPACITY", "with the node full the next placement")
}

func CheckHeartbeatLiveness(ctx *harness.Ctx) {
	stateLedger(ctx)
	ttl := ctx.Redis.TTL("heartbeat:gpu-1")
	ctx.Assert(0 < ttl && ttl <= 30, "heartbeat:gpu-1 has TTL %d: registerNode must set it with config.HeartbeatTTL (30 s), or a dead node stays schedulable", ttl)
	ctx.Clock.Advance(31)
	ctx.Equal(ctx.Redis.Exists("heartbeat:gpu-1"), 0, "31 s after registration the heartbeat must have lapsed; its existence")
	ctx.Equal(stateAllocate(ctx, "p-1", 2), "NO_HEARTBEAT", "a node whose heartbeat lapsed")
	ctx.Assert(stateAllocated(ctx) == 0 && ctx.Redis.Exists("placement:p-1") == 0, "a refused placement must write nothing")
	ctx.NoError(heartbeat(context.Background(), "gpu-1"), "heartbeat")
	ttl = ctx.Redis.TTL("heartbeat:gpu-1")
	ctx.Assert(0 < ttl && ttl <= 30, "heartbeat() left TTL %d on heartbeat:gpu-1, expected config.HeartbeatTTL", ttl)
	ctx.Equal(stateAllocate(ctx, "p-1", 2), "ALLOCATED", "once the agent reports in again the node takes placements")
}

func CheckIdempotentRelease(ctx *harness.Ctx) {
	stateLedger(ctx)
	ctx.Equal(stateAllocate(ctx, "p-1", 4), "ALLOCATED", "booking 4")
	ctx.Equal(stateRelease(ctx, "p-1"), true, "the first release")
	second := stateRelease(ctx, "p-1")
	ctx.Equal(stateAllocated(ctx), 0, "allocated after releasing p-1 twice (a retried release must not move the counters again)")
	ctx.Equal(second, false, "the second release of p-1")
	ctx.Assert(!stateRelease(ctx, "ghost") && stateAllocated(ctx) == 0, "releasing an unknown placement moves nothing")
	ctx.Equal(stateAllocate(ctx, "p-2", 8), "ALLOCATED", "the node has all 8 GPUs free after one real release")
}

func CheckHonestContention(ctx *harness.Ctx) {
	stateLedger(ctx)
	ctx.Equal(stateAllocate(ctx, "p-1", 6), "ALLOCATED", "booking 6")
	ctx.Equal(stateAllocate(ctx, "p-2", 4), "NO_CAPACITY", "4 GPUs on a node with 2 free")
	ctx.Equal(stateAllocated(ctx), 6, "allocated after a refused placement")
	ctx.Equal(ctx.Redis.Exists("placement:p-2"), 0, "a refused placement must leave no placement:p-2 record; its existence")
	ctx.Equal(statePlacements(ctx), []string{"p-1"}, "node:gpu-1:placements after a refused placement")
	ctx.Assert(stateAllocate(ctx, "p-1", 6) == "ALLOCATED" && stateAllocated(ctx) == 6, "a retried allocation of the same placement id is ALLOCATED without booking twice")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <algorithm>
#include <string>
#include <vector>

namespace {

const std::string kStateNode = "node:gpu-1";

void stateLedger() { register_node("gpu-1", "a100", 8); }

int stateAllocated(harness::Ctx& ctx) {
  const auto v = ctx.Redis.HGet(kStateNode, "allocated");
  return v ? std::stoi(*v) : 0;
}

std::vector<std::string> statePlacements(harness::Ctx& ctx) {
  auto members = ctx.Redis.SMembers("node:gpu-1:placements");
  std::sort(members.begin(), members.end());
  return members;
}

}  // namespace

void CheckNodeLedgerKeys(harness::Ctx& ctx) {
  stateLedger();
  ctx.Assert(ctx.Redis.SIsMember("nodes", "gpu-1"), "register_node must add the id to the nodes set (keys: %v)", ctx.Redis.Keys("*"));
  const auto node = ctx.Redis.HGetAll(kStateNode);
  ctx.Assert(node.count("gpu_type") && node.at("gpu_type") == "a100" && node.count("capacity") && node.at("capacity") == "8" &&
                 node.count("allocated") && node.at("allocated") == "0",
             "node:gpu-1 is %v, expected gpu_type a100, capacity 8, allocated 0", node);
  ctx.Equal(ctx.Redis.Exists("heartbeat:gpu-1"), 1, "register_node must set heartbeat:gpu-1; its existence");
  ctx.Equal(allocate("gpu-1", "p-1", 4), "ALLOCATED", "4 of 8 GPUs on an idle node");
  ctx.Equal(stateAllocated(ctx), 4, "allocated after booking 4");
  const auto record = ctx.Redis.HGetAll("placement:p-1");
  ctx.Assert(record.count("node_id") && record.at("node_id") == "gpu-1" && record.count("count") && record.at("count") == "4" &&
                 record.count("status") && record.at("status") == "allocated",
             "placement:p-1 is %v, expected node_id gpu-1, count 4, status allocated", record);
  ctx.Equal(statePlacements(ctx), {"p-1"}, "node:gpu-1:placements after one allocation");
  ctx.Equal(release("gpu-1", "p-1"), true, "the first release of p-1 moves the counters and reports true");
  ctx.Equal(stateAllocated(ctx), 0, "allocated after the release");
  ctx.Equal(ctx.Redis.HGet("placement:p-1", "status"), "released", "release must mark placement:p-1 released; its status");
}

void CheckAtomicAllocation(harness::Ctx& ctx) {
  stateLedger();
  // Another scheduler replica books the whole node the instant the first command on node:gpu-1 lands.
  std::string rival;
  ctx.Redis.After(kStateNode, [&] {
    if (stateAllocated(ctx) + 8 > 8) {
      rival = "no room";
      return;
    }
    ctx.Redis.Do("HINCRBY", kStateNode, "allocated", 8);
    ctx.Redis.Do("HSET", "placement:rival", "node_id", "gpu-1", "count", 8, "status", "allocated");
    ctx.Redis.Do("SADD", "node:gpu-1:placements", "rival");
    rival = "booked";
  });
  const std::string result = allocate("gpu-1", "p-1", 8);
  ctx.Assert(!rival.empty(), "allocate never touched node:gpu-1");
  ctx.Assert(stateAllocated(ctx) <= 8,
             "node:gpu-1 has %d GPUs allocated of 8: a rival replica booked the node between your read of the counters and "
             "your write (%s), and your request answered %s. Compare and HINCRBY inside one EVAL",
             stateAllocated(ctx), rival, result);
  if (rival == "booked") ctx.Equal(result, "NO_CAPACITY", "the rival booked the node first, so the request");
  ctx.Equal(allocate("gpu-1", "p-2", 1), "NO_CAPACITY", "with the node full the next placement");
}

void CheckHeartbeatLiveness(harness::Ctx& ctx) {
  stateLedger();
  long long ttl = ctx.Redis.TTL("heartbeat:gpu-1");
  ctx.Assert(0 < ttl && ttl <= 30, "heartbeat:gpu-1 has TTL %d: register_node must set it with kHeartbeatTtlS (30), or a dead node stays schedulable", ttl);
  ctx.Clock.Advance(31);
  ctx.Equal(ctx.Redis.Exists("heartbeat:gpu-1"), 0, "31 s after registration the heartbeat must have lapsed; its existence");
  ctx.Equal(allocate("gpu-1", "p-1", 2), "NO_HEARTBEAT", "a node whose heartbeat lapsed");
  ctx.Assert(stateAllocated(ctx) == 0 && ctx.Redis.Exists("placement:p-1") == 0, "a refused placement must write nothing");
  heartbeat("gpu-1");
  ttl = ctx.Redis.TTL("heartbeat:gpu-1");
  ctx.Assert(0 < ttl && ttl <= 30, "heartbeat() left TTL %d on heartbeat:gpu-1, expected kHeartbeatTtlS", ttl);
  ctx.Equal(allocate("gpu-1", "p-1", 2), "ALLOCATED", "once the agent reports in again the node takes placements");
}

void CheckIdempotentRelease(harness::Ctx& ctx) {
  stateLedger();
  ctx.Equal(allocate("gpu-1", "p-1", 4), "ALLOCATED", "booking 4");
  ctx.Equal(release("gpu-1", "p-1"), true, "the first release");
  const bool second = release("gpu-1", "p-1");
  ctx.Equal(stateAllocated(ctx), 0, "allocated after releasing p-1 twice (a retried release must not move the counters again)");
  ctx.Equal(second, false, "the second release of p-1");
  ctx.Assert(!release("gpu-1", "ghost") && stateAllocated(ctx) == 0, "releasing an unknown placement moves nothing");
  ctx.Equal(allocate("gpu-1", "p-2", 8), "ALLOCATED", "the node has all 8 GPUs free after one real release");
}

void CheckHonestContention(harness::Ctx& ctx) {
  stateLedger();
  ctx.Equal(allocate("gpu-1", "p-1", 6), "ALLOCATED", "booking 6");
  ctx.Equal(allocate("gpu-1", "p-2", 4), "NO_CAPACITY", "4 GPUs on a node with 2 free");
  ctx.Equal(stateAllocated(ctx), 6, "allocated after a refused placement");
  ctx.Equal(ctx.Redis.Exists("placement:p-2"), 0, "a refused placement must leave no placement:p-2 record; its existence");
  ctx.Equal(statePlacements(ctx), {"p-1"}, "node:gpu-1:placements after a refused placement");
  ctx.Assert(allocate("gpu-1", "p-1", 6) == "ALLOCATED" && stateAllocated(ctx) == 6, "a retried allocation of the same placement id is ALLOCATED without booking twice");
}
`,
  },
  debrief: `The ledger is two Lua scripts because the decision and the write must be one event: Redis runs a script alone, so the compare and the \`HINCRBY\` cannot be split by another replica, and the placement record and the set membership land in the same instant as the counter. Keying both scripts by the placement id is what makes a retry safe: a second \`allocate\` finds the id in the set and answers \`ALLOCATED\` without booking again, a second \`release\` finds it gone and moves nothing. The heartbeat is a key with a TTL rather than a timestamp the scheduler compares, so liveness needs no clock agreement between machines. Production ledgers keep a per-node version so a reconcile can tell a late write from a lost one, and expire placement records once a release is older than any possible retry.`,
};
