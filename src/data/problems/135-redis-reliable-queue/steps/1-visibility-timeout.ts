import type {Step} from '@/lib/types';

export const visibilityTimeoutStep: Step = {
  id: 'visibility-timeout',
  title: 'Claim, ack, requeue: three scripts and a deadline',
  concept: 'redis',
  file: 'work_queue',
  focus: ['worker', 'redis'],
  task: `## Task

Implement a work queue \`q:{name}\` in which a claimed job is **invisible** to other workers for
\`visibility_s\` seconds and comes back if the worker never acks. Four keys per queue:
\`q:{name}:jobs\` (hash, job id → payload), \`q:{name}:ready\` (list, head = next job),
\`q:{name}:inflight\` (sorted set, score = deadline) and \`q:{name}:owner\` (hash, job id → worker).

- \`enqueue(name, job_id, payload) -> bool\`: \`HSETNX q:{name}:jobs job_id payload\`; an id that already
  exists is refused (**False**, nothing else written); otherwise \`RPUSH q:{name}:ready job_id\` and **True**.
- \`claim(name, worker, visibility_s, now) -> (job_id, payload) | None\`: **one Lua script** — \`LPOP\` the
  ready list; nothing there → \`None\`. Otherwise \`ZADD q:{name}:inflight\` with score \`now + visibility_s\`,
  \`HSET q:{name}:owner job_id worker\`, and return the id with its payload from \`q:{name}:jobs\`. The
  pop, the deadline and the owner land together or not at all.
- \`ack(name, job_id, worker) -> bool\`: **one Lua script** — only the recorded owner may ack: another
  worker, an unknown id or a second ack answers **False** and changes nothing. The owner's ack does
  \`ZREM\` inflight, \`HDEL\` jobs, \`HDEL\` owner → **True**.
- \`requeue_expired(name, now) -> int\`: **one Lua script** — every inflight member with score \`<= now\`
  goes back to the **head** of ready (\`LPUSH\`), leaves inflight (\`ZREM\`) and loses its owner (\`HDEL\`);
  members with a later deadline stay. Returns how many were requeued.
- \`stats(name) -> {ready, inflight}\`: \`LLEN\` of ready and \`ZCARD\` of inflight.
- Register each script once (\`register_script\` / \`defineCommand\` / \`NewScript\` / \`scriptLoad\` /
  \`script_load\`); \`claim\`, \`ack\` and \`requeue_expired\` send nothing but that script.

> A job is never nowhere: at every instant it is in exactly one of \`ready\` or \`inflight\`. That is
> what the script buys — a \`LPOP\` followed by a \`ZADD\` from the client has a gap in which a crash
> loses the job for good.`,
  sequence: {
    participants: ['worker A', 'worker B', 'Redis'],
    messages: [
      {from: 'worker A', to: 'Redis', label: 'EVALSHA claim · ready inflight owner jobs · A · now+30', kind: 'sync'},
      {from: 'Redis', to: 'Redis', label: 'LPOP → j1 · ZADD inflight 130 j1 · HSET owner j1 A', kind: 'sync'},
      {from: 'Redis', to: 'worker A', label: '[j1, payload]', kind: 'reply'},
      {from: 'worker B', to: 'Redis', label: 'EVALSHA requeue_expired · now = 131', kind: 'sync'},
      {
        from: 'Redis',
        to: 'Redis',
        label: 'ZRANGEBYSCORE -inf 131 → j1 · ZREM · HDEL owner · LPUSH ready',
        kind: 'sync',
      },
      {from: 'Redis', to: 'worker B', label: '1', kind: 'reply'},
      {from: 'worker B', to: 'Redis', label: 'EVALSHA claim · B · now+30', kind: 'sync'},
      {from: 'Redis', to: 'worker B', label: '[j1, payload]', kind: 'reply'},
      {from: 'worker A', to: 'Redis', label: 'EVALSHA ack · j1 · A (late)', kind: 'sync'},
      {from: 'Redis', to: 'worker A', label: '0 — owner is B now', kind: 'reply'},
    ],
  },
  hints: [
    'Write the three scripts first, with the four keys in a fixed order (`ready`, `inflight`, `owner`, `jobs`) and the worker and deadline as ARGV; the client functions only build key names and pass arguments.',
    "`LPOP` on an empty list gives Lua `false`: `if not id then return nil end`. Return the pair as a Lua table `{id, redis.call('HGET', KEYS[4], id)}` — a nested table comes back as an array.",
    '`ZRANGEBYSCORE inflight -inf now` is the expired set; loop it with `ipairs`, do the three writes per id, and `return #expired`. Compare the owner inside `ack` with `~=`; a missing owner is `false`, which is also not the worker.',
  ],
  checks: [
    {
      id: 'claim-inflight',
      title: 'Claim pops the head into inflight with its deadline',
      detail:
        'The claimed id leaves `q:{name}:ready` and appears in `q:{name}:inflight` with score `now + visibility_s`, `q:{name}:owner` records the worker, the payload comes back with the id and the job stays in `q:{name}:jobs`; an empty queue answers `None`.',
      match: {
        python: {
          all: [
            /'LPOP',\s*KEYS\[1\]/,
            /'ZADD',\s*KEYS\[2\],\s*ARGV\[2\]/,
            /'HSET',\s*KEYS\[3\]/,
            /'HGET',\s*KEYS\[4\]/,
          ],
        },
        typescript: {
          all: [
            /'LPOP',\s*KEYS\[1\]/,
            /'ZADD',\s*KEYS\[2\],\s*ARGV\[2\]/,
            /'HSET',\s*KEYS\[3\]/,
            /'HGET',\s*KEYS\[4\]/,
          ],
        },
        go: {
          all: [
            /'LPOP',\s*KEYS\[1\]/,
            /'ZADD',\s*KEYS\[2\],\s*ARGV\[2\]/,
            /'HSET',\s*KEYS\[3\]/,
            /'HGET',\s*KEYS\[4\]/,
          ],
        },
        scala: {
          all: [
            /'LPOP',\s*KEYS\[1\]/,
            /'ZADD',\s*KEYS\[2\],\s*ARGV\[2\]/,
            /'HSET',\s*KEYS\[3\]/,
            /'HGET',\s*KEYS\[4\]/,
          ],
        },
        cpp: {
          all: [
            /'LPOP',\s*KEYS\[1\]/,
            /'ZADD',\s*KEYS\[2\],\s*ARGV\[2\]/,
            /'HSET',\s*KEYS\[3\]/,
            /'HGET',\s*KEYS\[4\]/,
          ],
        },
      },
    },
    {
      id: 'fifo-dedupe',
      title: 'Jobs come out in enqueue order; an id is enqueued once',
      detail:
        'Five enqueues are claimed first-in first-out and the sixth claim is `None`; enqueueing an id that exists returns `False`, leaves the payload as it was and does not push a second entry on `q:{name}:ready`.',
      match: {
        python: {order: [/r\.hsetnx\(/, /r\.rpush\(/]},
        typescript: {order: [/redis\.hsetnx\(/, /redis\.rpush\(/]},
        go: {order: [/rdb\.HSetNX\(/, /rdb\.RPush\(/]},
        scala: {order: [/jedis\.hsetnx\(/, /jedis\.rpush\(/]},
        cpp: {order: [/redis\.hsetnx\(/, /redis\.rpush\(/]},
      },
    },
    {
      id: 'ack-owner',
      title: 'Only the owner can ack; the ack removes everything',
      detail:
        'An ack from a worker other than the recorded owner, for an unknown id, or a second time answers `False` and leaves `inflight`, `owner` and `jobs` untouched; the owner’s ack answers `True` and removes the id from all three.',
      match: {
        python: {
          all: [/'HGET',\s*KEYS\[2\],\s*ARGV\[1\]\)\s*~=\s*ARGV\[2\]/, /'ZREM',\s*KEYS\[1\]/, /'HDEL',\s*KEYS\[3\]/],
        },
        typescript: {
          all: [/'HGET',\s*KEYS\[2\],\s*ARGV\[1\]\)\s*~=\s*ARGV\[2\]/, /'ZREM',\s*KEYS\[1\]/, /'HDEL',\s*KEYS\[3\]/],
        },
        go: {
          all: [/'HGET',\s*KEYS\[2\],\s*ARGV\[1\]\)\s*~=\s*ARGV\[2\]/, /'ZREM',\s*KEYS\[1\]/, /'HDEL',\s*KEYS\[3\]/],
        },
        scala: {
          all: [/'HGET',\s*KEYS\[2\],\s*ARGV\[1\]\)\s*~=\s*ARGV\[2\]/, /'ZREM',\s*KEYS\[1\]/, /'HDEL',\s*KEYS\[3\]/],
        },
        cpp: {
          all: [/'HGET',\s*KEYS\[2\],\s*ARGV\[1\]\)\s*~=\s*ARGV\[2\]/, /'ZREM',\s*KEYS\[1\]/, /'HDEL',\s*KEYS\[3\]/],
        },
      },
    },
    {
      id: 'visibility-timeout',
      title: 'An unacked job reappears after its visibility timeout',
      detail:
        '`requeue_expired` before the deadline returns 0 and moves nothing; at or after it the job is back at the head of `ready` with no owner, can be claimed by another worker with a fresh deadline, and the original worker’s late ack is refused.',
      match: {
        python: {order: [/'ZRANGEBYSCORE',\s*KEYS\[1\],\s*'-inf',\s*ARGV\[1\]/, /'LPUSH',\s*KEYS\[3\]/]},
        typescript: {order: [/'ZRANGEBYSCORE',\s*KEYS\[1\],\s*'-inf',\s*ARGV\[1\]/, /'LPUSH',\s*KEYS\[3\]/]},
        go: {order: [/'ZRANGEBYSCORE',\s*KEYS\[1\],\s*'-inf',\s*ARGV\[1\]/, /'LPUSH',\s*KEYS\[3\]/]},
        scala: {order: [/'ZRANGEBYSCORE',\s*KEYS\[1\],\s*'-inf',\s*ARGV\[1\]/, /'LPUSH',\s*KEYS\[3\]/]},
        cpp: {order: [/'ZRANGEBYSCORE',\s*KEYS\[1\],\s*'-inf',\s*ARGV\[1\]/, /'LPUSH',\s*KEYS\[3\]/]},
      },
    },
    {
      id: 'requeue-only-expired',
      title: 'Requeue moves exactly the expired members and counts them',
      detail:
        'With three jobs inflight at different deadlines, `requeue_expired(now)` returns how many had `score <= now`, puts those back on `ready`, clears their owners, and leaves the later one inflight with its owner.',
      match: {
        python: {all: [/for\s+_,\s*\w+\s+in\s+ipairs\(/, /return\s+#\w+/]},
        typescript: {all: [/for\s+_,\s*\w+\s+in\s+ipairs\(/, /return\s+#\w+/]},
        go: {all: [/for\s+_,\s*\w+\s+in\s+ipairs\(/, /return\s+#\w+/]},
        scala: {all: [/for\s+_,\s*\w+\s+in\s+ipairs\(/, /return\s+#\w+/]},
        cpp: {all: [/for\s+_,\s*\w+\s+in\s+ipairs\(/, /return\s+#\w+/]},
      },
    },
    {
      id: 'atomic-claim',
      title: 'A claim is one script: no instant with the job nowhere',
      detail:
        'A probe that fires right after the first command touching `q:{name}:ready` finds the popped job already in `inflight` with its owner, and a second worker claiming at that instant gets a different job — a client-side `LPOP` then `ZADD` leaves a window where the job is in neither key.',
      match: {
        python: {all: [/r\.register_script\(\s*CLAIM_LUA\s*\)/], none: [/r\.lpop\(/, /r\.lindex\(/, /r\.zadd\(/]},
        typescript: {all: [/defineCommand\(\s*'claim'/], none: [/redis\.lpop\(/, /redis\.lindex\(/, /redis\.zadd\(/]},
        go: {all: [/redis\.NewScript\(\s*claimLua\s*\)/], none: [/rdb\.LPop\(/, /rdb\.LIndex\(/, /rdb\.ZAdd\(/]},
        scala: {
          all: [/jedis\.scriptLoad\(\s*ClaimLua\s*\)/],
          none: [/jedis\.lpop\(/, /jedis\.lindex\(/, /jedis\.zadd\(/],
        },
        cpp: {
          all: [/redis\.script_load\(\s*kClaimLua\s*\)/],
          none: [/redis\.lpop\(/, /redis\.lindex\(/, /redis\.zadd\(/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `"""A work queue with visibility timeouts: ready -> inflight under a deadline, back to ready if nobody acks."""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

# KEYS[1] = q:{name}:ready   KEYS[2] = q:{name}:inflight   KEYS[3] = q:{name}:owner   KEYS[4] = q:{name}:jobs
# ARGV[1] = worker   ARGV[2] = deadline (now + visibility_s)
CLAIM_LUA = """
return nil
"""

# KEYS[1] = q:{name}:inflight   KEYS[2] = q:{name}:owner   KEYS[3] = q:{name}:jobs
# ARGV[1] = job_id   ARGV[2] = worker
ACK_LUA = """
return 0
"""

# KEYS[1] = q:{name}:inflight   KEYS[2] = q:{name}:owner   KEYS[3] = q:{name}:ready
# ARGV[1] = now
REQUEUE_LUA = """
return 0
"""

# TODO: register the three scripts once so every call is an EVALSHA


def key(name: str, part: str) -> str:
    return f"q:{name}:{part}"


def enqueue(name: str, job_id: str, payload: str) -> bool:
    """HSETNX the payload; an existing id is refused. Otherwise RPUSH the id on ready."""
    # TODO
    raise NotImplementedError


def claim(name: str, worker: str, visibility_s: int, now: float) -> tuple[str, str] | None:
    """One script: LPOP ready; ZADD inflight now + visibility_s; HSET owner; return (id, payload). Empty -> None."""
    # TODO
    raise NotImplementedError


def ack(name: str, job_id: str, worker: str) -> bool:
    """One script: only the owner may ack; ZREM inflight, HDEL jobs, HDEL owner."""
    # TODO
    raise NotImplementedError


def requeue_expired(name: str, now: float) -> int:
    """One script: every inflight member with score <= now goes to the head of ready; returns the count."""
    # TODO
    raise NotImplementedError


def stats(name: str) -> dict:
    """{"ready": LLEN ready, "inflight": ZCARD inflight}."""
    # TODO
    raise NotImplementedError
`,
      solution: `"""A work queue with visibility timeouts: ready -> inflight under a deadline, back to ready if nobody acks."""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

# KEYS[1] = q:{name}:ready   KEYS[2] = q:{name}:inflight   KEYS[3] = q:{name}:owner   KEYS[4] = q:{name}:jobs
# ARGV[1] = worker   ARGV[2] = deadline (now + visibility_s)
CLAIM_LUA = """
local id = redis.call('LPOP', KEYS[1])
if not id then
  return nil
end
redis.call('ZADD', KEYS[2], ARGV[2], id)
redis.call('HSET', KEYS[3], id, ARGV[1])
return {id, redis.call('HGET', KEYS[4], id)}
"""

# KEYS[1] = q:{name}:inflight   KEYS[2] = q:{name}:owner   KEYS[3] = q:{name}:jobs
# ARGV[1] = job_id   ARGV[2] = worker
ACK_LUA = """
if redis.call('HGET', KEYS[2], ARGV[1]) ~= ARGV[2] then
  return 0
end
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('HDEL', KEYS[3], ARGV[1])
redis.call('HDEL', KEYS[2], ARGV[1])
return 1
"""

# KEYS[1] = q:{name}:inflight   KEYS[2] = q:{name}:owner   KEYS[3] = q:{name}:ready
# ARGV[1] = now
REQUEUE_LUA = """
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
for _, id in ipairs(expired) do
  redis.call('ZREM', KEYS[1], id)
  redis.call('HDEL', KEYS[2], id)
  redis.call('LPUSH', KEYS[3], id)
end
return #expired
"""

claim_script = r.register_script(CLAIM_LUA)
ack_script = r.register_script(ACK_LUA)
requeue_script = r.register_script(REQUEUE_LUA)


def key(name: str, part: str) -> str:
    return f"q:{name}:{part}"


def enqueue(name: str, job_id: str, payload: str) -> bool:
    """HSETNX the payload; an existing id is refused. Otherwise RPUSH the id on ready."""
    if not r.hsetnx(key(name, "jobs"), job_id, payload):
        return False
    r.rpush(key(name, "ready"), job_id)
    return True


def claim(name: str, worker: str, visibility_s: int, now: float) -> tuple[str, str] | None:
    """One script: LPOP ready; ZADD inflight now + visibility_s; HSET owner; return (id, payload). Empty -> None."""
    keys = [key(name, "ready"), key(name, "inflight"), key(name, "owner"), key(name, "jobs")]
    got = claim_script(keys=keys, args=[worker, now + visibility_s])
    if not got:
        return None
    return got[0], got[1]


def ack(name: str, job_id: str, worker: str) -> bool:
    """One script: only the owner may ack; ZREM inflight, HDEL jobs, HDEL owner."""
    keys = [key(name, "inflight"), key(name, "owner"), key(name, "jobs")]
    return ack_script(keys=keys, args=[job_id, worker]) == 1


def requeue_expired(name: str, now: float) -> int:
    """One script: every inflight member with score <= now goes to the head of ready; returns the count."""
    keys = [key(name, "inflight"), key(name, "owner"), key(name, "ready")]
    return int(requeue_script(keys=keys, args=[now]))


def stats(name: str) -> dict:
    """{"ready": LLEN ready, "inflight": ZCARD inflight}."""
    return {"ready": r.llen(key(name, "ready")), "inflight": r.zcard(key(name, "inflight"))}
`,
    },
    typescript: {
      starter: `/** A work queue with visibility timeouts: ready -> inflight under a deadline, back to ready if nobody acks. */
import Redis from 'ioredis';

// KEYS[1] = q:{name}:ready   KEYS[2] = q:{name}:inflight   KEYS[3] = q:{name}:owner   KEYS[4] = q:{name}:jobs
// ARGV[1] = worker   ARGV[2] = deadline (now + visibilityS)
const CLAIM_LUA = \`
return nil
\`;

// KEYS[1] = q:{name}:inflight   KEYS[2] = q:{name}:owner   KEYS[3] = q:{name}:jobs
// ARGV[1] = jobId   ARGV[2] = worker
const ACK_LUA = \`
return 0
\`;

// KEYS[1] = q:{name}:inflight   KEYS[2] = q:{name}:owner   KEYS[3] = q:{name}:ready
// ARGV[1] = now
const REQUEUE_LUA = \`
return 0
\`;

/** The client with the three scripts registered as commands. */
interface QueueRedis extends Redis {
  claim(ready: string, inflight: string, owner: string, jobs: string, worker: string, deadline: number): Promise<[string, string] | null>;
  ack(inflight: string, owner: string, jobs: string, jobId: string, worker: string): Promise<number>;
  requeueExpired(inflight: string, owner: string, ready: string, now: number): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as QueueRedis;
// TODO: defineCommand the three scripts once so every call is an EVALSHA

export const key = (name: string, part: string): string => \`q:\${name}:\${part}\`;

/** HSETNX the payload; an existing id is refused. Otherwise RPUSH the id on ready. */
export async function enqueue(name: string, jobId: string, payload: string): Promise<boolean> {
  // TODO
  throw new Error('not implemented');
}

/** One script: LPOP ready; ZADD inflight now + visibilityS; HSET owner; return [id, payload]. Empty -> null. */
export async function claim(name: string, worker: string, visibilityS: number, now: number): Promise<[string, string] | null> {
  // TODO
  throw new Error('not implemented');
}

/** One script: only the owner may ack; ZREM inflight, HDEL jobs, HDEL owner. */
export async function ack(name: string, jobId: string, worker: string): Promise<boolean> {
  // TODO
  throw new Error('not implemented');
}

/** One script: every inflight member with score <= now goes to the head of ready; returns the count. */
export async function requeueExpired(name: string, now: number): Promise<number> {
  // TODO
  throw new Error('not implemented');
}

/** {ready: LLEN ready, inflight: ZCARD inflight}. */
export async function stats(name: string): Promise<{ready: number; inflight: number}> {
  // TODO
  throw new Error('not implemented');
}
`,
      solution: `/** A work queue with visibility timeouts: ready -> inflight under a deadline, back to ready if nobody acks. */
import Redis from 'ioredis';

// KEYS[1] = q:{name}:ready   KEYS[2] = q:{name}:inflight   KEYS[3] = q:{name}:owner   KEYS[4] = q:{name}:jobs
// ARGV[1] = worker   ARGV[2] = deadline (now + visibilityS)
const CLAIM_LUA = \`
local id = redis.call('LPOP', KEYS[1])
if not id then
  return nil
end
redis.call('ZADD', KEYS[2], ARGV[2], id)
redis.call('HSET', KEYS[3], id, ARGV[1])
return {id, redis.call('HGET', KEYS[4], id)}
\`;

// KEYS[1] = q:{name}:inflight   KEYS[2] = q:{name}:owner   KEYS[3] = q:{name}:jobs
// ARGV[1] = jobId   ARGV[2] = worker
const ACK_LUA = \`
if redis.call('HGET', KEYS[2], ARGV[1]) ~= ARGV[2] then
  return 0
end
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('HDEL', KEYS[3], ARGV[1])
redis.call('HDEL', KEYS[2], ARGV[1])
return 1
\`;

// KEYS[1] = q:{name}:inflight   KEYS[2] = q:{name}:owner   KEYS[3] = q:{name}:ready
// ARGV[1] = now
const REQUEUE_LUA = \`
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
for _, id in ipairs(expired) do
  redis.call('ZREM', KEYS[1], id)
  redis.call('HDEL', KEYS[2], id)
  redis.call('LPUSH', KEYS[3], id)
end
return #expired
\`;

/** The client with the three scripts registered as commands. */
interface QueueRedis extends Redis {
  claim(ready: string, inflight: string, owner: string, jobs: string, worker: string, deadline: number): Promise<[string, string] | null>;
  ack(inflight: string, owner: string, jobs: string, jobId: string, worker: string): Promise<number>;
  requeueExpired(inflight: string, owner: string, ready: string, now: number): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as QueueRedis;
redis.defineCommand('claim', {numberOfKeys: 4, lua: CLAIM_LUA});
redis.defineCommand('ack', {numberOfKeys: 3, lua: ACK_LUA});
redis.defineCommand('requeueExpired', {numberOfKeys: 3, lua: REQUEUE_LUA});

export const key = (name: string, part: string): string => \`q:\${name}:\${part}\`;

/** HSETNX the payload; an existing id is refused. Otherwise RPUSH the id on ready. */
export async function enqueue(name: string, jobId: string, payload: string): Promise<boolean> {
  if ((await redis.hsetnx(key(name, 'jobs'), jobId, payload)) === 0) return false;
  await redis.rpush(key(name, 'ready'), jobId);
  return true;
}

/** One script: LPOP ready; ZADD inflight now + visibilityS; HSET owner; return [id, payload]. Empty -> null. */
export async function claim(name: string, worker: string, visibilityS: number, now: number): Promise<[string, string] | null> {
  const got = await redis.claim(key(name, 'ready'), key(name, 'inflight'), key(name, 'owner'), key(name, 'jobs'), worker, now + visibilityS);
  if (got === null) return null;
  return [got[0], got[1]];
}

/** One script: only the owner may ack; ZREM inflight, HDEL jobs, HDEL owner. */
export async function ack(name: string, jobId: string, worker: string): Promise<boolean> {
  return (await redis.ack(key(name, 'inflight'), key(name, 'owner'), key(name, 'jobs'), jobId, worker)) === 1;
}

/** One script: every inflight member with score <= now goes to the head of ready; returns the count. */
export async function requeueExpired(name: string, now: number): Promise<number> {
  return redis.requeueExpired(key(name, 'inflight'), key(name, 'owner'), key(name, 'ready'), now);
}

/** {ready: LLEN ready, inflight: ZCARD inflight}. */
export async function stats(name: string): Promise<{ready: number; inflight: number}> {
  const [ready, inflight] = await Promise.all([redis.llen(key(name, 'ready')), redis.zcard(key(name, 'inflight'))]);
  return {ready, inflight};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"errors"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// KEYS[1] = q:{name}:ready   KEYS[2] = q:{name}:inflight   KEYS[3] = q:{name}:owner   KEYS[4] = q:{name}:jobs
// ARGV[1] = worker   ARGV[2] = deadline (now + visibility)
const claimLua = \`
return nil
\`

// KEYS[1] = q:{name}:inflight   KEYS[2] = q:{name}:owner   KEYS[3] = q:{name}:jobs
// ARGV[1] = jobID   ARGV[2] = worker
const ackLua = \`
return 0
\`

// KEYS[1] = q:{name}:inflight   KEYS[2] = q:{name}:owner   KEYS[3] = q:{name}:ready
// ARGV[1] = now
const requeueLua = \`
return 0
\`

// TODO: redis.NewScript each of the three, once; Run then uses EVALSHA
var (
	claimScript   *redis.Script
	ackScript     *redis.Script
	requeueScript *redis.Script
)

type Stats struct {
	Ready    int64
	Inflight int64
}

func key(name, part string) string { return "q:" + name + ":" + part }

// enqueue HSETNXs the payload; an existing id is refused. Otherwise RPUSH the id on ready.
func enqueue(ctx context.Context, name, jobID, payload string) (bool, error) {
	// TODO
	return false, errors.New("not implemented")
}

// claim runs one script: LPOP ready; ZADD inflight now + visibility; HSET owner; returns id and payload. Empty -> ok false.
func claim(ctx context.Context, name, worker string, visibility int64, now int64) (jobID, payload string, ok bool, err error) {
	// TODO
	return "", "", false, errors.New("not implemented")
}

// ack runs one script: only the owner may ack; ZREM inflight, HDEL jobs, HDEL owner.
func ack(ctx context.Context, name, jobID, worker string) (bool, error) {
	// TODO
	return false, errors.New("not implemented")
}

// requeueExpired runs one script: every inflight member with score <= now goes to the head of ready; returns the count.
func requeueExpired(ctx context.Context, name string, now int64) (int64, error) {
	// TODO
	return 0, errors.New("not implemented")
}

// stats is LLEN ready and ZCARD inflight.
func stats(ctx context.Context, name string) (Stats, error) {
	// TODO
	return Stats{}, errors.New("not implemented")
}
`,
      solution: `package main

import (
	"context"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// KEYS[1] = q:{name}:ready   KEYS[2] = q:{name}:inflight   KEYS[3] = q:{name}:owner   KEYS[4] = q:{name}:jobs
// ARGV[1] = worker   ARGV[2] = deadline (now + visibility)
const claimLua = \`
local id = redis.call('LPOP', KEYS[1])
if not id then
  return nil
end
redis.call('ZADD', KEYS[2], ARGV[2], id)
redis.call('HSET', KEYS[3], id, ARGV[1])
return {id, redis.call('HGET', KEYS[4], id)}
\`

// KEYS[1] = q:{name}:inflight   KEYS[2] = q:{name}:owner   KEYS[3] = q:{name}:jobs
// ARGV[1] = jobID   ARGV[2] = worker
const ackLua = \`
if redis.call('HGET', KEYS[2], ARGV[1]) ~= ARGV[2] then
  return 0
end
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('HDEL', KEYS[3], ARGV[1])
redis.call('HDEL', KEYS[2], ARGV[1])
return 1
\`

// KEYS[1] = q:{name}:inflight   KEYS[2] = q:{name}:owner   KEYS[3] = q:{name}:ready
// ARGV[1] = now
const requeueLua = \`
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
for _, id in ipairs(expired) do
  redis.call('ZREM', KEYS[1], id)
  redis.call('HDEL', KEYS[2], id)
  redis.call('LPUSH', KEYS[3], id)
end
return #expired
\`

var (
	claimScript   = redis.NewScript(claimLua)
	ackScript     = redis.NewScript(ackLua)
	requeueScript = redis.NewScript(requeueLua)
)

type Stats struct {
	Ready    int64
	Inflight int64
}

func key(name, part string) string { return "q:" + name + ":" + part }

// enqueue HSETNXs the payload; an existing id is refused. Otherwise RPUSH the id on ready.
func enqueue(ctx context.Context, name, jobID, payload string) (bool, error) {
	fresh, err := rdb.HSetNX(ctx, key(name, "jobs"), jobID, payload).Result()
	if err != nil || !fresh {
		return false, err
	}
	if err := rdb.RPush(ctx, key(name, "ready"), jobID).Err(); err != nil {
		return false, err
	}
	return true, nil
}

// claim runs one script: LPOP ready; ZADD inflight now + visibility; HSET owner; returns id and payload. Empty -> ok false.
func claim(ctx context.Context, name, worker string, visibility int64, now int64) (jobID, payload string, ok bool, err error) {
	keys := []string{key(name, "ready"), key(name, "inflight"), key(name, "owner"), key(name, "jobs")}
	got, err := claimScript.Run(ctx, rdb, keys, worker, now+visibility).Result()
	if err == redis.Nil {
		return "", "", false, nil
	}
	if err != nil {
		return "", "", false, err
	}
	pair := got.([]interface{})
	return pair[0].(string), pair[1].(string), true, nil
}

// ack runs one script: only the owner may ack; ZREM inflight, HDEL jobs, HDEL owner.
func ack(ctx context.Context, name, jobID, worker string) (bool, error) {
	keys := []string{key(name, "inflight"), key(name, "owner"), key(name, "jobs")}
	n, err := ackScript.Run(ctx, rdb, keys, jobID, worker).Int()
	if err != nil {
		return false, err
	}
	return n == 1, nil
}

// requeueExpired runs one script: every inflight member with score <= now goes to the head of ready; returns the count.
func requeueExpired(ctx context.Context, name string, now int64) (int64, error) {
	keys := []string{key(name, "inflight"), key(name, "owner"), key(name, "ready")}
	return requeueScript.Run(ctx, rdb, keys, now).Int64()
}

// stats is LLEN ready and ZCARD inflight.
func stats(ctx context.Context, name string) (Stats, error) {
	ready, err := rdb.LLen(ctx, key(name, "ready")).Result()
	if err != nil {
		return Stats{}, err
	}
	inflight, err := rdb.ZCard(ctx, key(name, "inflight")).Result()
	if err != nil {
		return Stats{}, err
	}
	return Stats{Ready: ready, Inflight: inflight}, nil
}
`,
    },
    scala: {
      starter: `import scala.jdk.CollectionConverters._

import redis.clients.jedis.JedisPooled

/** A work queue with visibility timeouts: ready -> inflight under a deadline, back to ready if nobody acks. */
object WorkQueue {
  val jedis = new JedisPooled("redis", 6379)

  // KEYS[1] = q:{name}:ready   KEYS[2] = q:{name}:inflight   KEYS[3] = q:{name}:owner   KEYS[4] = q:{name}:jobs
  // ARGV[1] = worker   ARGV[2] = deadline (now + visibilitySeconds)
  val ClaimLua: String =
    """
      |return nil
      |""".stripMargin

  // KEYS[1] = q:{name}:inflight   KEYS[2] = q:{name}:owner   KEYS[3] = q:{name}:jobs
  // ARGV[1] = jobId   ARGV[2] = worker
  val AckLua: String =
    """
      |return 0
      |""".stripMargin

  // KEYS[1] = q:{name}:inflight   KEYS[2] = q:{name}:owner   KEYS[3] = q:{name}:ready
  // ARGV[1] = now
  val RequeueLua: String =
    """
      |return 0
      |""".stripMargin

  // TODO: scriptLoad the three scripts once and keep the SHAs; every call is then an EVALSHA

  case class Stats(ready: Long, inflight: Long)

  def key(name: String, part: String): String = s"q:$name:$part"

  /** HSETNX the payload; an existing id is refused. Otherwise RPUSH the id on ready. */
  def enqueue(name: String, jobId: String, payload: String): Boolean = {
    // TODO
    false
  }

  /** One script: LPOP ready; ZADD inflight now + visibilitySeconds; HSET owner; (id, payload). Empty -> None. */
  def claim(name: String, worker: String, visibilitySeconds: Long, now: Long): Option[(String, String)] = {
    // TODO
    None
  }

  /** One script: only the owner may ack; ZREM inflight, HDEL jobs, HDEL owner. */
  def ack(name: String, jobId: String, worker: String): Boolean = {
    // TODO
    false
  }

  /** One script: every inflight member with score <= now goes to the head of ready; returns the count. */
  def requeueExpired(name: String, now: Long): Long = {
    // TODO
    0L
  }

  /** LLEN ready and ZCARD inflight. */
  def stats(name: String): Stats = {
    // TODO
    Stats(0L, 0L)
  }
}
`,
      solution: `import scala.jdk.CollectionConverters._

import redis.clients.jedis.JedisPooled

/** A work queue with visibility timeouts: ready -> inflight under a deadline, back to ready if nobody acks. */
object WorkQueue {
  val jedis = new JedisPooled("redis", 6379)

  // KEYS[1] = q:{name}:ready   KEYS[2] = q:{name}:inflight   KEYS[3] = q:{name}:owner   KEYS[4] = q:{name}:jobs
  // ARGV[1] = worker   ARGV[2] = deadline (now + visibilitySeconds)
  val ClaimLua: String =
    """
      |local id = redis.call('LPOP', KEYS[1])
      |if not id then
      |  return nil
      |end
      |redis.call('ZADD', KEYS[2], ARGV[2], id)
      |redis.call('HSET', KEYS[3], id, ARGV[1])
      |return {id, redis.call('HGET', KEYS[4], id)}
      |""".stripMargin

  // KEYS[1] = q:{name}:inflight   KEYS[2] = q:{name}:owner   KEYS[3] = q:{name}:jobs
  // ARGV[1] = jobId   ARGV[2] = worker
  val AckLua: String =
    """
      |if redis.call('HGET', KEYS[2], ARGV[1]) ~= ARGV[2] then
      |  return 0
      |end
      |redis.call('ZREM', KEYS[1], ARGV[1])
      |redis.call('HDEL', KEYS[3], ARGV[1])
      |redis.call('HDEL', KEYS[2], ARGV[1])
      |return 1
      |""".stripMargin

  // KEYS[1] = q:{name}:inflight   KEYS[2] = q:{name}:owner   KEYS[3] = q:{name}:ready
  // ARGV[1] = now
  val RequeueLua: String =
    """
      |local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
      |for _, id in ipairs(expired) do
      |  redis.call('ZREM', KEYS[1], id)
      |  redis.call('HDEL', KEYS[2], id)
      |  redis.call('LPUSH', KEYS[3], id)
      |end
      |return #expired
      |""".stripMargin

  private val claimSha: String = jedis.scriptLoad(ClaimLua)
  private val ackSha: String = jedis.scriptLoad(AckLua)
  private val requeueSha: String = jedis.scriptLoad(RequeueLua)

  case class Stats(ready: Long, inflight: Long)

  def key(name: String, part: String): String = s"q:$name:$part"

  /** HSETNX the payload; an existing id is refused. Otherwise RPUSH the id on ready. */
  def enqueue(name: String, jobId: String, payload: String): Boolean = {
    if (jedis.hsetnx(key(name, "jobs"), jobId, payload) == 0L) return false
    jedis.rpush(key(name, "ready"), jobId)
    true
  }

  /** One script: LPOP ready; ZADD inflight now + visibilitySeconds; HSET owner; (id, payload). Empty -> None. */
  def claim(name: String, worker: String, visibilitySeconds: Long, now: Long): Option[(String, String)] = {
    val keys = List(key(name, "ready"), key(name, "inflight"), key(name, "owner"), key(name, "jobs")).asJava
    val args = List(worker, (now + visibilitySeconds).toString).asJava
    jedis.evalsha(claimSha, keys, args) match {
      case null => None
      case pair: java.util.List[_] => Some((pair.get(0).toString, pair.get(1).toString))
    }
  }

  /** One script: only the owner may ack; ZREM inflight, HDEL jobs, HDEL owner. */
  def ack(name: String, jobId: String, worker: String): Boolean = {
    val keys = List(key(name, "inflight"), key(name, "owner"), key(name, "jobs")).asJava
    jedis.evalsha(ackSha, keys, List(jobId, worker).asJava).asInstanceOf[Long] == 1L
  }

  /** One script: every inflight member with score <= now goes to the head of ready; returns the count. */
  def requeueExpired(name: String, now: Long): Long = {
    val keys = List(key(name, "inflight"), key(name, "owner"), key(name, "ready")).asJava
    jedis.evalsha(requeueSha, keys, List(now.toString).asJava).asInstanceOf[Long]
  }

  /** LLEN ready and ZCARD inflight. */
  def stats(name: String): Stats =
    Stats(jedis.llen(key(name, "ready")), jedis.zcard(key(name, "inflight")))
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <optional>
#include <string>
#include <utility>
#include <vector>

// A work queue with visibility timeouts: ready -> inflight under a deadline, back to ready if nobody acks.
sw::redis::Redis redis("tcp://redis:6379");

// KEYS[1] = q:{name}:ready   KEYS[2] = q:{name}:inflight   KEYS[3] = q:{name}:owner   KEYS[4] = q:{name}:jobs
// ARGV[1] = worker   ARGV[2] = deadline (now + visibility_s)
const std::string kClaimLua = R"lua(
return nil
)lua";

// KEYS[1] = q:{name}:inflight   KEYS[2] = q:{name}:owner   KEYS[3] = q:{name}:jobs
// ARGV[1] = job_id   ARGV[2] = worker
const std::string kAckLua = R"lua(
return 0
)lua";

// KEYS[1] = q:{name}:inflight   KEYS[2] = q:{name}:owner   KEYS[3] = q:{name}:ready
// ARGV[1] = now
const std::string kRequeueLua = R"lua(
return 0
)lua";

// TODO: script_load the three scripts once and keep the SHAs; every call is then an EVALSHA

struct Stats {
  long long ready;
  long long inflight;
};

std::string key(const std::string& name, const std::string& part) { return "q:" + name + ":" + part; }

// HSETNX the payload; an existing id is refused. Otherwise RPUSH the id on ready.
bool enqueue(const std::string& name, const std::string& job_id, const std::string& payload) {
  // TODO
  return false;
}

// One script: LPOP ready; ZADD inflight now + visibility_s; HSET owner; (id, payload). Empty -> nullopt.
std::optional<std::pair<std::string, std::string>> claim(const std::string& name, const std::string& worker,
                                                         long long visibility_s, long long now) {
  // TODO
  return std::nullopt;
}

// One script: only the owner may ack; ZREM inflight, HDEL jobs, HDEL owner.
bool ack(const std::string& name, const std::string& job_id, const std::string& worker) {
  // TODO
  return false;
}

// One script: every inflight member with score <= now goes to the head of ready; returns the count.
long long requeue_expired(const std::string& name, long long now) {
  // TODO
  return 0;
}

// LLEN ready and ZCARD inflight.
Stats stats(const std::string& name) {
  // TODO
  return Stats{0, 0};
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <optional>
#include <string>
#include <utility>
#include <vector>

// A work queue with visibility timeouts: ready -> inflight under a deadline, back to ready if nobody acks.
sw::redis::Redis redis("tcp://redis:6379");

// KEYS[1] = q:{name}:ready   KEYS[2] = q:{name}:inflight   KEYS[3] = q:{name}:owner   KEYS[4] = q:{name}:jobs
// ARGV[1] = worker   ARGV[2] = deadline (now + visibility_s)
const std::string kClaimLua = R"lua(
local id = redis.call('LPOP', KEYS[1])
if not id then
  return nil
end
redis.call('ZADD', KEYS[2], ARGV[2], id)
redis.call('HSET', KEYS[3], id, ARGV[1])
return {id, redis.call('HGET', KEYS[4], id)}
)lua";

// KEYS[1] = q:{name}:inflight   KEYS[2] = q:{name}:owner   KEYS[3] = q:{name}:jobs
// ARGV[1] = job_id   ARGV[2] = worker
const std::string kAckLua = R"lua(
if redis.call('HGET', KEYS[2], ARGV[1]) ~= ARGV[2] then
  return 0
end
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('HDEL', KEYS[3], ARGV[1])
redis.call('HDEL', KEYS[2], ARGV[1])
return 1
)lua";

// KEYS[1] = q:{name}:inflight   KEYS[2] = q:{name}:owner   KEYS[3] = q:{name}:ready
// ARGV[1] = now
const std::string kRequeueLua = R"lua(
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
for _, id in ipairs(expired) do
  redis.call('ZREM', KEYS[1], id)
  redis.call('HDEL', KEYS[2], id)
  redis.call('LPUSH', KEYS[3], id)
end
return #expired
)lua";

const std::string claim_sha = redis.script_load(kClaimLua);
const std::string ack_sha = redis.script_load(kAckLua);
const std::string requeue_sha = redis.script_load(kRequeueLua);

struct Stats {
  long long ready;
  long long inflight;
};

std::string key(const std::string& name, const std::string& part) { return "q:" + name + ":" + part; }

// HSETNX the payload; an existing id is refused. Otherwise RPUSH the id on ready.
bool enqueue(const std::string& name, const std::string& job_id, const std::string& payload) {
  if (!redis.hsetnx(key(name, "jobs"), job_id, payload)) return false;
  redis.rpush(key(name, "ready"), job_id);
  return true;
}

// One script: LPOP ready; ZADD inflight now + visibility_s; HSET owner; (id, payload). Empty -> nullopt.
std::optional<std::pair<std::string, std::string>> claim(const std::string& name, const std::string& worker,
                                                         long long visibility_s, long long now) {
  const std::vector<std::string> keys{key(name, "ready"), key(name, "inflight"), key(name, "owner"), key(name, "jobs")};
  const std::vector<std::string> args{worker, std::to_string(now + visibility_s)};
  std::vector<std::string> pair;
  redis.evalsha(claim_sha, keys.begin(), keys.end(), args.begin(), args.end(), std::back_inserter(pair));
  if (pair.size() < 2) return std::nullopt;
  return std::make_pair(pair[0], pair[1]);
}

// One script: only the owner may ack; ZREM inflight, HDEL jobs, HDEL owner.
bool ack(const std::string& name, const std::string& job_id, const std::string& worker) {
  const std::vector<std::string> keys{key(name, "inflight"), key(name, "owner"), key(name, "jobs")};
  const std::vector<std::string> args{job_id, worker};
  return redis.evalsha<long long>(ack_sha, keys.begin(), keys.end(), args.begin(), args.end()) == 1;
}

// One script: every inflight member with score <= now goes to the head of ready; returns the count.
long long requeue_expired(const std::string& name, long long now) {
  const std::vector<std::string> keys{key(name, "inflight"), key(name, "owner"), key(name, "ready")};
  const std::vector<std::string> args{std::to_string(now)};
  return redis.evalsha<long long>(requeue_sha, keys.begin(), keys.end(), args.begin(), args.end());
}

// LLEN ready and ZCARD inflight.
Stats stats(const std::string& name) {
  return Stats{redis.llen(key(name, "ready")), redis.zcard(key(name, "inflight"))};
}
`,
    },
  },
  harness: {
    python: `Q = "emails"
READY = "q:emails:ready"
INFLIGHT = "q:emails:inflight"
OWNER = "q:emails:owner"
JOBS = "q:emails:jobs"


def _queue(ctx, n=0):
    m = ctx.load("work_queue")
    for i in range(1, n + 1):
        assert m.enqueue(Q, f"j{i}", f"p{i}") is True, f"enqueue of a fresh id j{i} must return True"
    return m


def check_claim_inflight(ctx):
    m = _queue(ctx, 2)
    assert ctx.redis.lrange(READY, 0, -1) == ["j1", "j2"], f"ready is {ctx.redis.lrange(READY, 0, -1)} after two enqueues, expected [j1, j2] (RPUSH)"
    got = m.claim(Q, "A", 30, 100)
    assert got is not None and tuple(got) == ("j1", "p1"), f"claim returned {got!r}, expected ('j1', 'p1'): the head of ready with its payload"
    assert ctx.redis.lrange(READY, 0, -1) == ["j2"], f"ready is {ctx.redis.lrange(READY, 0, -1)} after the claim, expected [j2]: the claimed id must leave the list"
    score = ctx.redis.zscore(INFLIGHT, "j1")
    assert score is not None, f"inflight is {ctx.redis.zrange(INFLIGHT, 0, -1)}, expected j1: the claimed id must be ZADDed"
    assert score == 130, f"j1's inflight score is {score}, expected now + visibility_s = 100 + 30 = 130"
    assert ctx.redis.hget(OWNER, "j1") == "A", f"owner of j1 is {ctx.redis.hget(OWNER, 'j1')!r}, expected 'A'"
    assert ctx.redis.hget(JOBS, "j1") == "p1", "the payload must stay in q:emails:jobs until the ack"
    assert m.stats(Q) == {"ready": 1, "inflight": 1}, f"stats are {m.stats(Q)}, expected ready 1 / inflight 1"
    assert tuple(m.claim(Q, "B", 30, 101)) == ("j2", "p2"), "the second claim gets j2"
    assert m.claim(Q, "B", 30, 102) is None, "a claim on an empty ready list must return None"
    assert m.stats(Q) == {"ready": 0, "inflight": 2}, f"stats are {m.stats(Q)}, expected ready 0 / inflight 2"


def check_fifo_dedupe(ctx):
    m = _queue(ctx, 5)
    order = [m.claim(Q, "A", 30, 100)[0] for _ in range(5)]
    assert order == ["j1", "j2", "j3", "j4", "j5"], f"claims came out as {order}, expected j1..j5 in enqueue order (RPUSH in, LPOP out)"
    assert m.claim(Q, "A", 30, 100) is None, "the sixth claim must be None"
    assert m.enqueue(Q, "j6", "p6") is True
    assert m.enqueue(Q, "j6", "other") is False, "enqueue of an id that already exists must return False"
    assert ctx.redis.hget(JOBS, "j6") == "p6", f"a refused enqueue overwrote the payload: {ctx.redis.hget(JOBS, 'j6')!r}, expected 'p6'"
    assert ctx.redis.lrange(READY, 0, -1) == ["j6"], f"ready is {ctx.redis.lrange(READY, 0, -1)}: a refused enqueue must not push a second entry"
    assert m.claim(Q, "A", 30, 100)[0] == "j6"
    assert m.enqueue(Q, "j6", "again") is False, "an id that is inflight still exists and must be refused"
    assert ctx.redis.llen(READY) == 0


def check_ack_owner(ctx):
    m = _queue(ctx, 2)
    m.claim(Q, "A", 30, 100)
    assert m.ack(Q, "j1", "B") is False, "ack from a worker that does not own the job must return False"
    assert ctx.redis.zscore(INFLIGHT, "j1") == 130 and ctx.redis.hget(OWNER, "j1") == "A" and ctx.redis.hget(JOBS, "j1") == "p1", "a refused ack must change nothing"
    assert m.ack(Q, "j2", "A") is False, "ack of a job that is not inflight (j2 is still ready) must return False"
    assert ctx.redis.lrange(READY, 0, -1) == ["j2"] and ctx.redis.hget(JOBS, "j2") == "p2", "a refused ack must leave the ready job alone"
    assert m.ack(Q, "ghost", "A") is False, "ack of an unknown id must return False"
    assert m.ack(Q, "j1", "A") is True, "the owner's ack must return True"
    assert ctx.redis.zscore(INFLIGHT, "j1") is None, "after the ack j1 must leave inflight"
    assert ctx.redis.hexists(OWNER, "j1") == 0, "after the ack j1 must have no owner"
    assert ctx.redis.hexists(JOBS, "j1") == 0, "after the ack the payload must be deleted from jobs"
    assert m.ack(Q, "j1", "A") is False, "a second ack must return False"
    assert m.stats(Q) == {"ready": 1, "inflight": 0}
    assert m.enqueue(Q, "j1", "p1-again") is True, "once acked, the id is free to be enqueued again"


def check_visibility_timeout(ctx):
    m = _queue(ctx, 2)
    assert tuple(m.claim(Q, "A", 30, 100)) == ("j1", "p1")
    assert m.requeue_expired(Q, 129) == 0, "before the deadline (130) nothing is expired: expected 0"
    assert ctx.redis.zscore(INFLIGHT, "j1") == 130 and ctx.redis.lrange(READY, 0, -1) == ["j2"], "requeue_expired before the deadline must move nothing"
    assert m.claim(Q, "B", 30, 129)[0] == "j2", "while j1 is inflight, another worker gets the next job, never j1"
    n = m.requeue_expired(Q, 130)
    assert n == 1, f"requeue_expired(130) returned {n}, expected 1: j1's deadline is 130 and score <= now counts as expired"
    assert ctx.redis.lrange(READY, 0, -1) == ["j1"], f"ready is {ctx.redis.lrange(READY, 0, -1)}, expected [j1]: the expired job goes back to the head (LPUSH)"
    assert ctx.redis.zscore(INFLIGHT, "j1") is None, "a requeued job must leave inflight"
    assert ctx.redis.hexists(OWNER, "j1") == 0, "a requeued job must have no owner"
    assert ctx.redis.hget(JOBS, "j1") == "p1", "requeue keeps the payload"
    assert m.ack(Q, "j1", "A") is False, "the worker that lost the job cannot ack it any more"
    got = m.claim(Q, "B", 60, 131)
    assert tuple(got) == ("j1", "p1"), f"after the requeue another worker claims j1 again, got {got!r}"
    assert ctx.redis.zscore(INFLIGHT, "j1") == 191, f"the re-claimed job's deadline is {ctx.redis.zscore(INFLIGHT, 'j1')}, expected 131 + 60 = 191"
    assert ctx.redis.hget(OWNER, "j1") == "B"
    assert m.ack(Q, "j1", "A") is False, "A's late ack must be refused: B owns j1 now"
    assert m.ack(Q, "j1", "B") is True


def check_requeue_only_expired(ctx):
    m = _queue(ctx, 4)
    m.claim(Q, "A", 10, 100)
    m.claim(Q, "B", 20, 100)
    m.claim(Q, "C", 30, 100)
    assert m.requeue_expired(Q, 120) == 2, "at 120 two deadlines (110, 120) have passed: expected 2"
    assert set(ctx.redis.lrange(READY, 0, -1)) == {"j1", "j2", "j4"} and ctx.redis.lindex(READY, -1) == "j4", f"ready is {ctx.redis.lrange(READY, 0, -1)}: j1 and j2 must be back ahead of the never-claimed j4"
    assert ctx.redis.zrange(INFLIGHT, 0, -1) == ["j3"], f"inflight is {ctx.redis.zrange(INFLIGHT, 0, -1)}, expected only j3 (deadline 130)"
    assert ctx.redis.hgetall(OWNER) == {"j3": "C"}, f"owner is {ctx.redis.hgetall(OWNER)}, expected only j3 -> C"
    assert m.stats(Q) == {"ready": 3, "inflight": 1}
    assert m.requeue_expired(Q, 120) == 0, "a second sweep at the same instant has nothing left: expected 0"
    assert m.requeue_expired(Q, 1000) == 1
    assert ctx.redis.zcard(INFLIGHT) == 0 and ctx.redis.hlen(OWNER) == 0
    assert ctx.redis.llen(READY) == 4


def check_atomic_claim(ctx):
    m = _queue(ctx, 2)
    seen = {}

    def other_worker():
        seen["ready"] = ctx.redis.lrange(READY, 0, -1)
        seen["inflight"] = ctx.redis.zrange(INFLIGHT, 0, -1)
        seen["owner"] = ctx.redis.hgetall(OWNER)
        return m.claim(Q, "B", 30, 100)

    probe = ctx.redis_after(READY, other_worker)
    got_a = m.claim(Q, "A", 30, 100)
    assert probe.fired, "claim never touched q:emails:ready"
    assert probe.error is None, f"worker B's claim raised {probe.error!r}"
    assert tuple(got_a) == ("j1", "p1"), f"worker A got {got_a!r}, expected j1"
    assert "j1" not in seen["ready"], "at the instant ready was touched j1 should already have been popped"
    assert "j1" in seen["inflight"] and seen["owner"].get("j1") == "A", f"right after ready was touched, inflight is {seen['inflight']} and owner {seen['owner']}: j1 was popped but not yet inflight — a crash here loses the job; pop, ZADD and HSET must be one script"
    got_b = probe.result
    assert got_b is not None and tuple(got_b) == ("j2", "p2"), f"worker B, claiming at that instant, got {got_b!r}, expected j2: two workers must never hold the same job"
    assert ctx.redis.hgetall(OWNER) == {"j1": "A", "j2": "B"}, f"owners are {ctx.redis.hgetall(OWNER)}, expected j1 -> A, j2 -> B"
    assert ctx.redis.zcard(INFLIGHT) == 2 and ctx.redis.llen(READY) == 0
`,
    typescript: `const Q = 'emails';
const READY = 'q:emails:ready';
const INFLIGHT = 'q:emails:inflight';
const OWNER = 'q:emails:owner';
const JOBS = 'q:emails:jobs';

async function queue(ctx, n = 0) {
  const m = ctx.load('work_queue');
  for (let i = 1; i <= n; i++) assert.equal(await m.enqueue(Q, \`j\${i}\`, \`p\${i}\`), true, \`enqueue of a fresh id j\${i} must return true\`);
  return m;
}

const score = (ctx, id: string): number | null => {
  const raw = ctx.redis.zscore(INFLIGHT, id);
  return raw === null ? null : Number(raw);
};

export async function check_claim_inflight(ctx) {
  const m = await queue(ctx, 2);
  assert.deepEqual(ctx.redis.lrange(READY, 0, -1), ['j1', 'j2'], \`ready is \${JSON.stringify(ctx.redis.lrange(READY, 0, -1))} after two enqueues, expected [j1, j2] (RPUSH)\`);
  const got = await m.claim(Q, 'A', 30, 100);
  assert.deepEqual(got, ['j1', 'p1'], \`claim returned \${JSON.stringify(got)}, expected ['j1', 'p1']: the head of ready with its payload\`);
  assert.deepEqual(ctx.redis.lrange(READY, 0, -1), ['j2'], \`ready is \${JSON.stringify(ctx.redis.lrange(READY, 0, -1))} after the claim, expected [j2]: the claimed id must leave the list\`);
  assert(score(ctx, 'j1') !== null, \`inflight is \${JSON.stringify(ctx.redis.zrange(INFLIGHT, 0, -1))}, expected j1: the claimed id must be ZADDed\`);
  assert.equal(score(ctx, 'j1'), 130, \`j1's inflight score is \${score(ctx, 'j1')}, expected now + visibilityS = 100 + 30 = 130\`);
  assert.equal(ctx.redis.hget(OWNER, 'j1'), 'A', \`owner of j1 is \${JSON.stringify(ctx.redis.hget(OWNER, 'j1'))}, expected 'A'\`);
  assert.equal(ctx.redis.hget(JOBS, 'j1'), 'p1', 'the payload must stay in q:emails:jobs until the ack');
  assert.deepEqual(await m.stats(Q), {ready: 1, inflight: 1}, \`stats are \${JSON.stringify(await m.stats(Q))}, expected ready 1 / inflight 1\`);
  assert.deepEqual(await m.claim(Q, 'B', 30, 101), ['j2', 'p2'], 'the second claim gets j2');
  assert.equal(await m.claim(Q, 'B', 30, 102), null, 'a claim on an empty ready list must return null');
  assert.deepEqual(await m.stats(Q), {ready: 0, inflight: 2}, \`stats are \${JSON.stringify(await m.stats(Q))}, expected ready 0 / inflight 2\`);
}

export async function check_fifo_dedupe(ctx) {
  const m = await queue(ctx, 5);
  const order: string[] = [];
  for (let i = 0; i < 5; i++) order.push((await m.claim(Q, 'A', 30, 100))[0]);
  assert.deepEqual(order, ['j1', 'j2', 'j3', 'j4', 'j5'], \`claims came out as \${JSON.stringify(order)}, expected j1..j5 in enqueue order (RPUSH in, LPOP out)\`);
  assert.equal(await m.claim(Q, 'A', 30, 100), null, 'the sixth claim must be null');
  assert.equal(await m.enqueue(Q, 'j6', 'p6'), true);
  assert.equal(await m.enqueue(Q, 'j6', 'other'), false, 'enqueue of an id that already exists must return false');
  assert.equal(ctx.redis.hget(JOBS, 'j6'), 'p6', \`a refused enqueue overwrote the payload: \${JSON.stringify(ctx.redis.hget(JOBS, 'j6'))}, expected 'p6'\`);
  assert.deepEqual(ctx.redis.lrange(READY, 0, -1), ['j6'], \`ready is \${JSON.stringify(ctx.redis.lrange(READY, 0, -1))}: a refused enqueue must not push a second entry\`);
  assert.equal((await m.claim(Q, 'A', 30, 100))[0], 'j6');
  assert.equal(await m.enqueue(Q, 'j6', 'again'), false, 'an id that is inflight still exists and must be refused');
  assert.equal(ctx.redis.llen(READY), 0);
}

export async function check_ack_owner(ctx) {
  const m = await queue(ctx, 2);
  await m.claim(Q, 'A', 30, 100);
  assert.equal(await m.ack(Q, 'j1', 'B'), false, 'ack from a worker that does not own the job must return false');
  assert(score(ctx, 'j1') === 130 && ctx.redis.hget(OWNER, 'j1') === 'A' && ctx.redis.hget(JOBS, 'j1') === 'p1', 'a refused ack must change nothing');
  assert.equal(await m.ack(Q, 'j2', 'A'), false, 'ack of a job that is not inflight (j2 is still ready) must return false');
  assert(ctx.redis.lrange(READY, 0, -1)[0] === 'j2' && ctx.redis.hget(JOBS, 'j2') === 'p2', 'a refused ack must leave the ready job alone');
  assert.equal(await m.ack(Q, 'ghost', 'A'), false, 'ack of an unknown id must return false');
  assert.equal(await m.ack(Q, 'j1', 'A'), true, "the owner's ack must return true");
  assert.equal(score(ctx, 'j1'), null, 'after the ack j1 must leave inflight');
  assert.equal(ctx.redis.hexists(OWNER, 'j1'), 0, 'after the ack j1 must have no owner');
  assert.equal(ctx.redis.hexists(JOBS, 'j1'), 0, 'after the ack the payload must be deleted from jobs');
  assert.equal(await m.ack(Q, 'j1', 'A'), false, 'a second ack must return false');
  assert.deepEqual(await m.stats(Q), {ready: 1, inflight: 0});
  assert.equal(await m.enqueue(Q, 'j1', 'p1-again'), true, 'once acked, the id is free to be enqueued again');
}

export async function check_visibility_timeout(ctx) {
  const m = await queue(ctx, 2);
  assert.deepEqual(await m.claim(Q, 'A', 30, 100), ['j1', 'p1']);
  assert.equal(await m.requeueExpired(Q, 129), 0, 'before the deadline (130) nothing is expired: expected 0');
  assert(score(ctx, 'j1') === 130 && ctx.redis.lrange(READY, 0, -1)[0] === 'j2', 'requeueExpired before the deadline must move nothing');
  assert.equal((await m.claim(Q, 'B', 30, 129))[0], 'j2', 'while j1 is inflight, another worker gets the next job, never j1');
  const n = await m.requeueExpired(Q, 130);
  assert.equal(n, 1, \`requeueExpired(130) returned \${n}, expected 1: j1's deadline is 130 and score <= now counts as expired\`);
  assert.deepEqual(ctx.redis.lrange(READY, 0, -1), ['j1'], \`ready is \${JSON.stringify(ctx.redis.lrange(READY, 0, -1))}, expected [j1]: the expired job goes back to the head (LPUSH)\`);
  assert.equal(score(ctx, 'j1'), null, 'a requeued job must leave inflight');
  assert.equal(ctx.redis.hexists(OWNER, 'j1'), 0, 'a requeued job must have no owner');
  assert.equal(ctx.redis.hget(JOBS, 'j1'), 'p1', 'requeue keeps the payload');
  assert.equal(await m.ack(Q, 'j1', 'A'), false, 'the worker that lost the job cannot ack it any more');
  const got = await m.claim(Q, 'B', 60, 131);
  assert.deepEqual(got, ['j1', 'p1'], \`after the requeue another worker claims j1 again, got \${JSON.stringify(got)}\`);
  assert.equal(score(ctx, 'j1'), 191, \`the re-claimed job's deadline is \${score(ctx, 'j1')}, expected 131 + 60 = 191\`);
  assert.equal(ctx.redis.hget(OWNER, 'j1'), 'B');
  assert.equal(await m.ack(Q, 'j1', 'A'), false, "A's late ack must be refused: B owns j1 now");
  assert.equal(await m.ack(Q, 'j1', 'B'), true);
}

export async function check_requeue_only_expired(ctx) {
  const m = await queue(ctx, 4);
  await m.claim(Q, 'A', 10, 100);
  await m.claim(Q, 'B', 20, 100);
  await m.claim(Q, 'C', 30, 100);
  assert.equal(await m.requeueExpired(Q, 120), 2, 'at 120 two deadlines (110, 120) have passed: expected 2');
  const ready = ctx.redis.lrange(READY, 0, -1);
  assert([...ready].sort().join() === 'j1,j2,j4' && ready[2] === 'j4', \`ready is \${JSON.stringify(ready)}: j1 and j2 must be back ahead of the never-claimed j4\`);
  assert.deepEqual(ctx.redis.zrange(INFLIGHT, 0, -1), ['j3'], \`inflight is \${JSON.stringify(ctx.redis.zrange(INFLIGHT, 0, -1))}, expected only j3 (deadline 130)\`);
  assert.deepEqual(ctx.redis.hgetall(OWNER), {j3: 'C'}, \`owner is \${JSON.stringify(ctx.redis.hgetall(OWNER))}, expected only j3 -> C\`);
  assert.deepEqual(await m.stats(Q), {ready: 3, inflight: 1});
  assert.equal(await m.requeueExpired(Q, 120), 0, 'a second sweep at the same instant has nothing left: expected 0');
  assert.equal(await m.requeueExpired(Q, 1000), 1);
  assert(ctx.redis.zcard(INFLIGHT) === 0 && ctx.redis.hlen(OWNER) === 0);
  assert.equal(ctx.redis.llen(READY), 4);
}

export async function check_atomic_claim(ctx) {
  const m = await queue(ctx, 2);
  const seen: {ready?: string[]; inflight?: string[]; owner?: Record<string, string>} = {};
  const probe = ctx.redisAfter(READY, () => {
    seen.ready = ctx.redis.lrange(READY, 0, -1);
    seen.inflight = ctx.redis.zrange(INFLIGHT, 0, -1);
    seen.owner = ctx.redis.hgetall(OWNER);
    return m.claim(Q, 'B', 30, 100);
  });
  const gotA = await m.claim(Q, 'A', 30, 100);
  assert(probe.fired, 'claim never touched q:emails:ready');
  assert.equal(probe.error, undefined, \`worker B's claim raised \${String(probe.error)}\`);
  assert.deepEqual(gotA, ['j1', 'p1'], \`worker A got \${JSON.stringify(gotA)}, expected j1\`);
  assert(!seen.ready!.includes('j1'), 'at the instant ready was touched j1 should already have been popped');
  assert(seen.inflight!.includes('j1') && seen.owner!.j1 === 'A', \`right after ready was touched, inflight is \${JSON.stringify(seen.inflight)} and owner \${JSON.stringify(seen.owner)}: j1 was popped but not yet inflight — a crash here loses the job; pop, ZADD and HSET must be one script\`);
  const gotB = await probe.result;
  assert.deepEqual(gotB, ['j2', 'p2'], \`worker B, claiming at that instant, got \${JSON.stringify(gotB)}, expected j2: two workers must never hold the same job\`);
  assert.deepEqual(ctx.redis.hgetall(OWNER), {j1: 'A', j2: 'B'}, \`owners are \${JSON.stringify(ctx.redis.hgetall(OWNER))}, expected j1 -> A, j2 -> B\`);
  assert(ctx.redis.zcard(INFLIGHT) === 2 && ctx.redis.llen(READY) === 0);
}
`,
  },
  debrief: `The queue is three scripts because each one is a multi-key state transition that must be all-or-nothing. \`claim\` is the one that matters most: a client-side \`LPOP\` followed by \`ZADD\` has a window — a crash, a network blip, a deploy — in which the job exists in no key, and a queue that can lose a job silently is not a queue. Putting the pop, the deadline and the owner in one script makes "every job is in exactly one of ready or inflight" an invariant Redis enforces, which is also why \`requeue_expired\` can be a dumb sweep: whatever it finds past its deadline is, by construction, a job whose worker went quiet. The owner hash is the fencing token: once the sweep has given the job to someone else, the first worker's late \`ack\` is refused instead of deleting work the second worker is halfway through. Real systems add a retry counter and a dead-letter list for jobs that expire too many times (so a poison job cannot cycle forever), \`BLPOP\`-style blocking or Streams with consumer groups (\`XREADGROUP\` / \`XAUTOCLAIM\` is this exact protocol built into the server), a heartbeat that extends the deadline for long jobs, and per-queue metrics on the age of the oldest inflight member.`,
};
