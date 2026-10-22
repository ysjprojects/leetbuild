import type {Step} from '@/lib/types';

export const assignmentStateStep: Step = {
  id: 'state',
  title: 'Redis assignment leases with expiry and return',
  concept: 'redis',
  file: 'state',
  focus: ['service', 'redis', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: one annotator clicks next
item, the queue hands out an item, the demo looks healthy, and every flaw in it is invisible until a
second annotator or a closed tab shows up. It marks work *assigned* instead of *leasing* it, claims
with three separate Redis commands, has no way back for work nobody finished, and reports depth from
a counter it maintains itself. Review it like the queue owner, fix it, and prove the fix with the
checks below.

Implement the Redis assignment pool behind \`claim\`:

- Four keys per task: \`pool:{task_id}\` (sorted set of item ids, score = queue order),
  \`lease:{task_id}\` (sorted set, score = the lease deadline in unix milliseconds),
  \`assign:{task_id}:{item_id}\` (hash with \`annotator\` and \`leased_until_ms\`) and
  \`items:{task_id}\` (hash of item id → \`available\` | \`leased\`). Every key is per task: one pool
  shared by two tasks hands an annotator another task's questions.
- \`LEASE_TTL_S = 900\` — an assignment is a **lease that expires after 15 minutes of inactivity**,
  never a flag: the deadline is written into the lease score *and* the assignment hash, and an
  expired lease returns the item to the pool. The draft writes \`HSET … assigned_at=<timestamp>\`
  with no expiry at all, so an annotator who closes the tab strands their item forever.
- \`claim(task_id, annotator)\` is **one atomic Lua \`EVAL\`** (\`CLAIM_LUA\`): reclaim expired
  leases, \`ZPOPMIN\` the next item out of the pool, \`ZADD\` the lease with score
  \`now_ms + 900_000\`, write the assignment record and return the item id — an empty pool returns
  nil, which the route answers **204**. The draft claims with \`SISMEMBER\` then \`SADD\` then
  \`SREM\` from the client, so two concurrent annotators both see the item free and receive the same
  one.
- \`renew(task_id, item_id, annotator)\` extends the lease **for the holder only**: the script reads
  \`HGET assign:{task_id}:{item_id} annotator\` inside the same atomic step, refuses a caller the
  record does not name (\`false\` → **409**) and leaves the lease exactly as it was. \`release\` (the
  annotator hands the item back early) obeys the same holder rule. The draft has no renew or release
  path at all.
- \`reclaim_expired(task_id)\` puts **every** lease whose deadline has passed back into
  \`pool:{task_id}\`, deletes its assignment record and flips the item state back to \`available\`.
  It runs inside the claim script — so a claim rescues abandoned work — and is exposed for the
  sweeper that visits idle tasks.
- \`queue_depth(task_id)\` returns \`{"available": ZCARD pool, "leased": ZCARD lease, "total": HLEN
  items}\` read in one atomic step, so \`available + leased == total\` cannot drift. The draft
  answers from an \`INCR\`ed counter, which disagrees with the pool the first time a claim fails
  after the counter was bumped.

**Failure mode the checks target.** Every flaw here is one flaw: the draft treats an assignment as
an event instead of a lease with a deadline. A flag with no expiry is work that disappears — the
item is in neither the pool nor any claimable state, and the queue silently shrinks with every
closed tab until someone reconciles the hashes by hand. A client-side read-check-write never
collides in a demo and always collides under real traffic, handing one item to two annotators who
answer the same question twice. And a depth read from a counter agrees with the pool only until the
first partial failure — depth is the number the dashboard uses to decide whether the queue needs
another annotator.
`,
  sequence: {
    participants: ['Annotator', 'Service', 'Redis', 'Sweeper'],
    messages: [
      {from: 'Annotator', to: 'Service', label: 'POST /v1/tasks/{id}/claim · X-Annotator-Id', kind: 'sync'},
      {from: 'Service', to: 'Redis', label: 'EVALSHA CLAIM_LUA 3 pool:{t} lease:{t} items:{t} · now_ms', kind: 'sync'},
      {
        from: 'Redis',
        to: 'Redis',
        label: 'ZRANGEBYSCORE lease -inf now → ZREM + DEL assign + ZADD pool',
        kind: 'sync',
      },
      {
        from: 'Redis',
        to: 'Redis',
        label: 'ZPOPMIN pool → ZADD lease now+900000 · HSET assign annotator',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Service', label: 'item_id', kind: 'reply'},
      {
        from: 'Service',
        to: 'Annotator',
        label: '200 {item_id, leased_until_ms} · 204 when the pool is empty',
        kind: 'reply',
      },
      {from: 'Annotator', to: 'Service', label: 'renew(item_id) · release(item_id)', kind: 'sync'},
      {
        from: 'Service',
        to: 'Redis',
        label: 'EVALSHA RENEW_LUA · HGET assign annotator → mismatch → 0',
        kind: 'sync',
      },
      {
        from: 'Service',
        to: 'Annotator',
        label: '200 {leased_until_ms} · 409 when the caller is not the holder',
        kind: 'reply',
      },
      {from: 'Sweeper', to: 'Redis', label: 'EVALSHA RECLAIM_LUA for idle tasks', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'lease-expiry',
      title: 'Claims carry a 15-minute lease',
      detail:
        'Every claim writes a deadline — `leased_until_ms`, the TTL added to the current time in milliseconds — into the assignment hash and uses the same number as the lease score, so an idle assignment expires and the item returns to the pool. The draft writes `assigned_at` and no deadline at all, so a closed tab strands the item forever.',
      match: {
        python: {
          all: [
            /LEASE_TTL_S\s*=\s*900/,
            /LEASE_TTL_MS\s*=\s*LEASE_TTL_S\s*\*\s*1000/,
            /leased_until_ms/,
            /claim_script\(/,
          ],
        },
        typescript: {
          all: [
            /LEASE_TTL_S\s*=\s*900/,
            /LEASE_TTL_MS\s*=\s*LEASE_TTL_S\s*\*\s*1000/,
            /leased_until_ms/,
            /redis\.claim\(/,
          ],
        },
        go: {
          all: [
            /leaseTtl\s*=\s*15\s*\*\s*time\.Minute/,
            /leaseTtl\.Milliseconds\(\)/,
            /leased_until_ms/,
            /claimScript\.Run\(/,
          ],
        },
        scala: {
          all: [
            /LeaseTtlSeconds\s*=\s*900L/,
            /LeaseTtlMs\s*=\s*LeaseTtlSeconds\s*\*\s*1000/,
            /leased_until_ms/,
            /evalsha\(claimSha/,
          ],
        },
        cpp: {all: [/kLeaseTtl\{900\}/, /kLeaseTtl\.count\(\)\s*\*\s*1000/, /leased_until_ms/, /kClaimSha/]},
      },
    },
    {
      id: 'atomic-claim',
      title: 'One atomic script claims the next item',
      detail:
        'The next item leaves the pool inside `CLAIM_LUA`, run by the server as one step — reclaim, `ZPOPMIN`, `ZADD` the lease, `HSET` the assignment record — so a concurrent claim cannot see the same item free. The draft reads the pool and marks the item with `SISMEMBER`, `SADD` and `SREM` from the client, so two annotators pass the same check and open the same item.',
      match: {
        python: {
          all: [/CLAIM_LUA/, /register_script\(CLAIM_LUA\)/, /redis\.call\(\s*'ZPOPMIN'/, /redis\.call\(\s*'HSET'/],
          none: [/sismember/i, /sadd/i],
        },
        typescript: {
          all: [/CLAIM_LUA/, /numberOfKeys:\s*3,\s*lua:\s*CLAIM_LUA/, /'ZPOPMIN'/, /'HSET'/],
          none: [/sismember/i, /sadd/i],
        },
        go: {all: [/claimLua/, /redis\.NewScript\(claimLua\)/, /'ZPOPMIN'/, /'HSET'/], none: [/SIsMember/, /SAdd\(/]},
        scala: {all: [/ClaimLua/, /scriptLoad\(ClaimLua\)/, /'ZPOPMIN'/, /'HSET'/], none: [/sismember/i, /sadd/i]},
        cpp: {all: [/kClaimLua/, /script_load\(kClaimLua\)/, /'ZPOPMIN'/, /'HSET'/], none: [/sismember/i, /sadd/i]},
      },
    },
    {
      id: 'expired-return',
      title: 'Expired leases return items to the pool',
      detail:
        '`reclaim_expired` finds leases past their deadline with `ZRANGEBYSCORE` (`-inf` → `now_ms`), `ZREM`s each one, deletes its assignment record and `ZADD`s the item back into the pool — and the claim script runs that reclaim before it pops, so even a claim rescues abandoned work. The draft has no reclaim path: an expired item never comes back.',
      match: {
        python: {
          all: [/reclaim_expired/, /reclaim_script\(/, /ZRANGEBYSCORE/, /'-inf'/, /redis\.call\(\s*'ZREM'/],
          order: [/reclaim\(KEYS\[2\]/, /'ZPOPMIN'/],
        },
        typescript: {
          all: [/reclaimExpired/, /defineCommand\('reclaim'/, /ZRANGEBYSCORE/, /'-inf'/, /redis\.call\(\s*'ZREM'/],
          order: [/reclaim\(KEYS\[2\]/, /'ZPOPMIN'/],
        },
        go: {
          all: [/reclaimExpired/, /reclaimScript\.Run\(/, /ZRANGEBYSCORE/, /'-inf'/, /'ZREM'/],
          order: [/reclaim\(KEYS\[2\]/, /'ZPOPMIN'/],
        },
        scala: {
          all: [/reclaimExpired/, /reclaimSha/, /ZRANGEBYSCORE/, /'-inf'/, /'ZREM'/],
          order: [/reclaim\(KEYS\[2\]/, /'ZPOPMIN'/],
        },
        cpp: {
          all: [/reclaim_expired/, /kReclaimLua/, /ZRANGEBYSCORE/, /'-inf'/, /'ZREM'/],
          order: [/reclaim\(KEYS\[2\]/, /'ZPOPMIN'/],
        },
      },
    },
    {
      id: 'renew-holder',
      title: 'Only the lease holder can renew or release it',
      detail:
        '`renew` (and the early `release`) reads the holder out of `assign:{task}:{item}` inside its own script, refuses a caller the record does not name before anything is written, and only then moves `leased_until_ms` and the lease score — so a second annotator can neither steal an item nor extend someone else’s lease. The draft has no renew path, so a stolen item could only be overwritten, never refused.',
      match: {
        python: {
          all: [
            /def renew\(task_id: str, item_id: str, annotator: str\)/,
            /renew_script\(/,
            /redis\.call\(\s*'HGET'/,
            /holder\s*~=\s*ARGV\[1\]/,
          ],
          order: [/redis\.call\(\s*'HGET'/, /return 0/, /'leased_until_ms'/],
        },
        typescript: {
          all: [/export async function renew\(/, /defineCommand\('renew'/, /'HGET'/, /holder\s*~=\s*ARGV\[1\]/],
          order: [/redis\.call\(\s*'HGET'/, /return 0/, /'leased_until_ms'/],
        },
        go: {
          all: [/func renew\(/, /renewScript\.Run\(/, /'HGET'/, /holder\s*~=\s*ARGV\[1\]/],
          order: [/redis\.call\(\s*'HGET'/, /return 0/, /'leased_until_ms'/],
        },
        scala: {
          all: [/def renew\(/, /renewSha/, /'HGET'/, /holder\s*~=\s*ARGV\[1\]/],
          order: [/redis\.call\(\s*'HGET'/, /return 0/, /'leased_until_ms'/],
        },
        cpp: {
          all: [/bool renew\(/, /kRenewLua/, /'HGET'/, /holder\s*~=\s*ARGV\[1\]/],
          order: [/redis\.call\(\s*'HGET'/, /return 0/, /'leased_until_ms'/],
        },
      },
    },
    {
      id: 'pool-depth',
      title: 'Pool depth stays consistent with the item records',
      detail:
        '`queue_depth` derives `available`, `leased` and `total` from `ZCARD pool:{task}`, `ZCARD lease:{task}` and `HLEN items:{task}` in one atomic read, so `available + leased == total` holds and a partial failure cannot make the answer disagree with the pool. The draft reports an `INCR`ed counter instead, which drifts away from the keys it claims to describe.',
      match: {
        python: {
          all: [
            /def queue_depth\(/,
            /redis\.call\(\s*'ZCARD'/,
            /redis\.call\(\s*'HLEN'/,
            /"available": available/,
            /"leased": leased/,
            /"total": total/,
          ],
        },
        typescript: {
          all: [
            /export async function queueDepth\(/,
            /redis\.call\(\s*'ZCARD'/,
            /redis\.call\(\s*'HLEN'/,
            /interface QueueDepth/,
            /available,\s*leased,\s*total/,
          ],
        },
        go: {all: [/func queueDepth\(/, /'ZCARD'/, /'HLEN'/, /json:"available"/, /json:"leased"/, /json:"total"/]},
        scala: {all: [/def queueDepth\(/, /'ZCARD'/, /'HLEN'/, /case class QueueDepth\(available/, /counts\.get\(2\)/]},
        cpp: {all: [/QueueDepth queue_depth\(/, /'ZCARD'/, /'HLEN'/, /counts\.at\(0\)/, /counts\.at\(2\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

# TODO: this draft marks an item assigned with HSET ... assigned_at=<unix seconds> and never
# expires it, so an annotator who closes the tab strands the item forever. It claims with SISMEMBER,
# SADD and SREM from the client, so two concurrent annotators both see the item free and open the
# same one. It has no reclaim path for work nobody renewed, and it reports queue depth from an
# INCR'd counter that drifts away from the pool the first time a claim fails halfway.


def pool_key(task_id: str) -> str:
    return f"pool:{task_id}"


def taken_key(task_id: str) -> str:
    return f"taken:{task_id}"


def assign_key(task_id: str, item_id: str) -> str:
    return f"assign:{task_id}:{item_id}"


def depth_key(task_id: str) -> str:
    return f"depth:{task_id}"


def claim(task_id: str, annotator: str) -> str | None:
    """Hand the next queued item to annotator; None when the pool is empty."""
    for item_id in r.smembers(pool_key(task_id)):
        if r.sismember(taken_key(task_id), item_id):
            continue
        r.sadd(taken_key(task_id), item_id)
        r.srem(pool_key(task_id), item_id)
        r.hset(assign_key(task_id, item_id), mapping={"annotator": annotator, "assigned_at": int(time.time())})
        return item_id
    return None


def renew(task_id: str, item_id: str, annotator: str) -> bool:
    """Keep the item for a while longer."""
    # TODO: nothing here expires, so there is no lease to renew: a second annotator just overwrites
    # the assignment instead of being refused.
    return False


def queue_depth(task_id: str) -> dict:
    """How much work is waiting for the task."""
    available = int(r.get(depth_key(task_id)) or 0)
    return {"available": available, "leased": 0, "total": available}
`,
      solution: `import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

LEASE_TTL_S = 900
LEASE_TTL_MS = LEASE_TTL_S * 1000

# Shared by the claim script and the sweeper: an expired lease goes back to the pool with its item
# id, so depth never drifts away from the pool.
RECLAIM_FN = """
local function reclaim(lease, pool, items, prefix, now_ms)
  local expired = redis.call('ZRANGEBYSCORE', lease, '-inf', now_ms, 'LIMIT', 0, 100)
  for _, item_id in ipairs(expired) do
    redis.call('ZREM', lease, item_id)
    redis.call('DEL', prefix .. item_id)
    redis.call('ZADD', pool, now_ms, item_id)
    redis.call('HSET', items, item_id, 'available')
  end
  return #expired
end
"""

# KEYS[1] = pool:{task_id}   KEYS[2] = lease:{task_id}   KEYS[3] = items:{task_id}
# ARGV[1] = "assign:{task_id}:" prefix   ARGV[2] = annotator   ARGV[3] = now_ms   ARGV[4] = ttl_ms
CLAIM_LUA = (
    RECLAIM_FN
    + """
reclaim(KEYS[2], KEYS[1], KEYS[3], ARGV[1], tonumber(ARGV[3]))
local item_id = redis.call('ZPOPMIN', KEYS[1], 1)[1]
if not item_id then
  return false
end
local deadline = tonumber(ARGV[3]) + tonumber(ARGV[4])
redis.call('ZADD', KEYS[2], deadline, item_id)
redis.call('HSET', KEYS[3], item_id, 'leased')
redis.call('HSET', ARGV[1] .. item_id, 'annotator', ARGV[2], 'leased_until_ms', deadline)
return item_id
"""
)

# KEYS[1] = pool:{task_id}   KEYS[2] = lease:{task_id}   KEYS[3] = items:{task_id}
# ARGV[1] = assign prefix   ARGV[2] = now_ms
RECLAIM_LUA = (
    RECLAIM_FN
    + """
return reclaim(KEYS[2], KEYS[1], KEYS[3], ARGV[1], tonumber(ARGV[2]))
"""
)

# KEYS[1] = lease:{task_id}   KEYS[2] = assign:{task_id}:{item_id}
# ARGV[1] = annotator   ARGV[2] = now_ms   ARGV[3] = ttl_ms   ARGV[4] = item_id
RENEW_LUA = """
local holder = redis.call('HGET', KEYS[2], 'annotator')
if holder ~= ARGV[1] then
  return 0
end
local deadline = tonumber(ARGV[2]) + tonumber(ARGV[3])
redis.call('HSET', KEYS[2], 'annotator', ARGV[1], 'leased_until_ms', deadline)
redis.call('ZADD', KEYS[1], deadline, ARGV[4])
return 1
"""

# KEYS[1] = pool:{task_id}   KEYS[2] = lease:{task_id}   KEYS[3] = assign:{task_id}:{item_id}
# KEYS[4] = items:{task_id}
# ARGV[1] = annotator   ARGV[2] = item_id   ARGV[3] = now_ms
RELEASE_LUA = """
if redis.call('HGET', KEYS[3], 'annotator') ~= ARGV[1] then
  return 0
end
redis.call('DEL', KEYS[3])
redis.call('ZREM', KEYS[2], ARGV[2])
redis.call('ZADD', KEYS[1], ARGV[3], ARGV[2])
redis.call('HSET', KEYS[4], ARGV[2], 'available')
return 1
"""

# KEYS[1] = pool:{task_id}   KEYS[2] = lease:{task_id}   KEYS[3] = items:{task_id}
DEPTH_LUA = """
local available = redis.call('ZCARD', KEYS[1])
local leased = redis.call('ZCARD', KEYS[2])
local total = redis.call('HLEN', KEYS[3])
return {available, leased, total}
"""

# Registered once: every call is an EVALSHA, never a script upload.
claim_script = r.register_script(CLAIM_LUA)
reclaim_script = r.register_script(RECLAIM_LUA)
renew_script = r.register_script(RENEW_LUA)
release_script = r.register_script(RELEASE_LUA)
depth_script = r.register_script(DEPTH_LUA)


def now_ms() -> int:
    return int(time.time() * 1000)


def pool_key(task_id: str) -> str:
    return f"pool:{task_id}"


def lease_key(task_id: str) -> str:
    return f"lease:{task_id}"


def items_key(task_id: str) -> str:
    return f"items:{task_id}"


def assign_prefix(task_id: str) -> str:
    return f"assign:{task_id}:"


def assign_key(task_id: str, item_id: str) -> str:
    return f"assign:{task_id}:{item_id}"


def claim(task_id: str, annotator: str) -> str | None:
    """Lease the next queued item to annotator; None means the pool is empty (the route: 204)."""
    item_id = claim_script(
        keys=[pool_key(task_id), lease_key(task_id), items_key(task_id)],
        args=[assign_prefix(task_id), annotator, now_ms(), LEASE_TTL_MS],
    )
    return item_id or None


def renew(task_id: str, item_id: str, annotator: str) -> bool:
    """Extend the holder's lease; False refuses the caller (the route: 409)."""
    renewed = renew_script(
        keys=[lease_key(task_id), assign_key(task_id, item_id)],
        args=[annotator, now_ms(), LEASE_TTL_MS, item_id],
    )
    return renewed == 1


def release(task_id: str, item_id: str, annotator: str) -> bool:
    """Hand the item back early; only the holder may do it (False -> 409)."""
    released = release_script(
        keys=[pool_key(task_id), lease_key(task_id), assign_key(task_id, item_id), items_key(task_id)],
        args=[annotator, item_id, now_ms()],
    )
    return released == 1


def reclaim_expired(task_id: str) -> int:
    """Return every expired lease to the pool; the sweeper calls this for idle tasks."""
    reclaimed = reclaim_script(
        keys=[pool_key(task_id), lease_key(task_id), items_key(task_id)],
        args=[assign_prefix(task_id), now_ms()],
    )
    return int(reclaimed)


def queue_depth(task_id: str) -> dict:
    """Depth derived from the keys in one atomic read, so available + leased == total."""
    available, leased, total = depth_script(
        keys=[pool_key(task_id), lease_key(task_id), items_key(task_id)],
        args=[],
    )
    return {"available": available, "leased": leased, "total": total}
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

export const redis = new Redis({host: 'redis', port: 6379});

// TODO: this draft marks an item assigned with HSET ... assigned_at=<unix seconds> and never
// expires it, so an annotator who closes the tab strands the item forever. It claims with
// sismember, sadd and srem from the client, so two concurrent annotators both see the item free and
// open the same one. It has no reclaim path for work nobody renewed, and it reports queue depth
// from an INCR'd counter that drifts away from the pool the first time a claim fails halfway.

const poolKey = (taskId: string): string => \`pool:\${taskId}\`;
const takenKey = (taskId: string): string => \`taken:\${taskId}\`;
const assignKey = (taskId: string, itemId: string): string => \`assign:\${taskId}:\${itemId}\`;
const depthKey = (taskId: string): string => \`depth:\${taskId}\`;

/** Hands the next queued item to annotator; null when the pool is empty. */
export async function claim(taskId: string, annotator: string): Promise<string | null> {
  for (const itemId of await redis.smembers(poolKey(taskId))) {
    if (await redis.sismember(takenKey(taskId), itemId)) continue;
    await redis.sadd(takenKey(taskId), itemId);
    await redis.srem(poolKey(taskId), itemId);
    await redis.hset(assignKey(taskId, itemId), {annotator, assigned_at: Math.floor(Date.now() / 1000)});
    return itemId;
  }
  return null;
}

/** Keeps the item for a while longer. */
export async function renew(taskId: string, itemId: string, annotator: string): Promise<boolean> {
  // TODO: nothing here expires, so there is no lease to renew: a second annotator just overwrites
  // the assignment instead of being refused.
  return false;
}

/** How much work is waiting for the task. */
export async function queueDepth(taskId: string): Promise<{available: number; leased: number; total: number}> {
  const available = Number((await redis.get(depthKey(taskId))) ?? 0);
  return {available, leased: 0, total: available};
}
`,
      solution: `import Redis from 'ioredis';

export const LEASE_TTL_S = 900;
const LEASE_TTL_MS = LEASE_TTL_S * 1000;

/** One clock for every deadline: milliseconds since the unix epoch. */
export const nowMs = (): number => Date.now();

/** Shared by the claim script and the sweeper: expired work goes back to the pool. */
const RECLAIM_FN = \`
local function reclaim(lease, pool, items, prefix, now_ms)
  local expired = redis.call('ZRANGEBYSCORE', lease, '-inf', now_ms, 'LIMIT', 0, 100)
  for _, item_id in ipairs(expired) do
    redis.call('ZREM', lease, item_id)
    redis.call('DEL', prefix .. item_id)
    redis.call('ZADD', pool, now_ms, item_id)
    redis.call('HSET', items, item_id, 'available')
  end
  return #expired
end
\`;

// KEYS[1] = pool:{task_id}   KEYS[2] = lease:{task_id}   KEYS[3] = items:{task_id}
// ARGV[1] = "assign:{task_id}:" prefix   ARGV[2] = annotator   ARGV[3] = now_ms   ARGV[4] = ttl_ms
export const CLAIM_LUA = \`\${RECLAIM_FN}
reclaim(KEYS[2], KEYS[1], KEYS[3], ARGV[1], tonumber(ARGV[3]))
local item_id = redis.call('ZPOPMIN', KEYS[1], 1)[1]
if not item_id then
  return false
end
local deadline = tonumber(ARGV[3]) + tonumber(ARGV[4])
redis.call('ZADD', KEYS[2], deadline, item_id)
redis.call('HSET', KEYS[3], item_id, 'leased')
redis.call('HSET', ARGV[1] .. item_id, 'annotator', ARGV[2], 'leased_until_ms', deadline)
return item_id
\`;

// KEYS[1] = pool:{task_id}   KEYS[2] = lease:{task_id}   KEYS[3] = items:{task_id}
// ARGV[1] = assign prefix   ARGV[2] = now_ms
const RECLAIM_LUA = \`\${RECLAIM_FN}
return reclaim(KEYS[2], KEYS[1], KEYS[3], ARGV[1], tonumber(ARGV[2]))
\`;

// KEYS[1] = lease:{task_id}   KEYS[2] = assign:{task_id}:{item_id}
// ARGV[1] = annotator   ARGV[2] = now_ms   ARGV[3] = ttl_ms   ARGV[4] = item_id
const RENEW_LUA = \`
local holder = redis.call('HGET', KEYS[2], 'annotator')
if holder ~= ARGV[1] then
  return 0
end
local deadline = tonumber(ARGV[2]) + tonumber(ARGV[3])
redis.call('HSET', KEYS[2], 'annotator', ARGV[1], 'leased_until_ms', deadline)
redis.call('ZADD', KEYS[1], deadline, ARGV[4])
return 1
\`;

// KEYS[1] = pool:{task_id}   KEYS[2] = lease:{task_id}   KEYS[3] = assign:{task_id}:{item_id}
// KEYS[4] = items:{task_id}
// ARGV[1] = annotator   ARGV[2] = item_id   ARGV[3] = now_ms
const RELEASE_LUA = \`
if redis.call('HGET', KEYS[3], 'annotator') ~= ARGV[1] then
  return 0
end
redis.call('DEL', KEYS[3])
redis.call('ZREM', KEYS[2], ARGV[2])
redis.call('ZADD', KEYS[1], ARGV[3], ARGV[2])
redis.call('HSET', KEYS[4], ARGV[2], 'available')
return 1
\`;

// KEYS[1] = pool:{task_id}   KEYS[2] = lease:{task_id}   KEYS[3] = items:{task_id}
const DEPTH_LUA = \`
local available = redis.call('ZCARD', KEYS[1])
local leased = redis.call('ZCARD', KEYS[2])
local total = redis.call('HLEN', KEYS[3])
return {available, leased, total}
\`;

/** The pool as commands: each script is loaded once, so calls go out as EVALSHA. */
interface LeaseRedis extends Redis {
  claim(
    poolKey: string,
    leaseKey: string,
    itemsKey: string,
    prefix: string,
    annotator: string,
    nowMs: number,
    ttlMs: number,
  ): Promise<string | null>;
  reclaim(poolKey: string, leaseKey: string, itemsKey: string, prefix: string, nowMs: number): Promise<number>;
  renew(leaseKey: string, assignKey: string, annotator: string, nowMs: number, ttlMs: number, itemId: string): Promise<number>;
  release(
    poolKey: string,
    leaseKey: string,
    assignKey: string,
    itemsKey: string,
    annotator: string,
    itemId: string,
    nowMs: number,
  ): Promise<number>;
  poolDepth(poolKey: string, leaseKey: string, itemsKey: string): Promise<[number, number, number]>;
}

export const redis = new Redis({host: 'redis', port: 6379}) as LeaseRedis;
redis.defineCommand('claim', {numberOfKeys: 3, lua: CLAIM_LUA});
redis.defineCommand('reclaim', {numberOfKeys: 3, lua: RECLAIM_LUA});
redis.defineCommand('renew', {numberOfKeys: 2, lua: RENEW_LUA});
redis.defineCommand('release', {numberOfKeys: 4, lua: RELEASE_LUA});
redis.defineCommand('poolDepth', {numberOfKeys: 3, lua: DEPTH_LUA});

export const poolKey = (taskId: string): string => \`pool:\${taskId}\`;
export const leaseKey = (taskId: string): string => \`lease:\${taskId}\`;
export const itemsKey = (taskId: string): string => \`items:\${taskId}\`;
export const assignKey = (taskId: string, itemId: string): string => \`assign:\${taskId}:\${itemId}\`;
const assignPrefix = (taskId: string): string => \`assign:\${taskId}:\`;

/** Leases the next queued item to annotator; null means the pool is empty (the route: 204). */
export async function claim(taskId: string, annotator: string): Promise<string | null> {
  const itemId = await redis.claim(
    poolKey(taskId),
    leaseKey(taskId),
    itemsKey(taskId),
    assignPrefix(taskId),
    annotator,
    nowMs(),
    LEASE_TTL_MS,
  );
  return itemId ?? null;
}

/** Extends the holder's lease; false refuses the caller (the route: 409). */
export async function renew(taskId: string, itemId: string, annotator: string): Promise<boolean> {
  const renewed = await redis.renew(leaseKey(taskId), assignKey(taskId, itemId), annotator, nowMs(), LEASE_TTL_MS, itemId);
  return renewed === 1;
}

/** Hands the item back early; only the holder may do it (false -> 409). */
export async function release(taskId: string, itemId: string, annotator: string): Promise<boolean> {
  const released = await redis.release(
    poolKey(taskId),
    leaseKey(taskId),
    assignKey(taskId, itemId),
    itemsKey(taskId),
    annotator,
    itemId,
    nowMs(),
  );
  return released === 1;
}

/** The sweeper's entry point: every expired lease returns to the pool. */
export async function reclaimExpired(taskId: string): Promise<number> {
  return redis.reclaim(poolKey(taskId), leaseKey(taskId), itemsKey(taskId), assignPrefix(taskId), nowMs());
}

export interface QueueDepth {
  available: number;
  leased: number;
  total: number;
}

/** Depth derived from the keys in one atomic read, so available + leased === total. */
export async function queueDepth(taskId: string): Promise<QueueDepth> {
  const [available, leased, total] = await redis.poolDepth(poolKey(taskId), leaseKey(taskId), itemsKey(taskId));
  return {available, leased, total};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// TODO: this draft marks an item assigned with HSET ... assigned_at=<unix seconds> and never
// expires it, so an annotator who closes the tab strands the item forever. It claims with SIsMember
// then SAdd then SRem from the client, so two concurrent annotators both see the item free and open
// the same one. It has no reclaim path for work nobody renewed, and it reports queue depth from an
// INCR'd counter that drifts away from the pool the first time a claim fails halfway.

func poolKey(taskID string) string { return "pool:" + taskID }
func takenKey(taskID string) string { return "taken:" + taskID }
func assignKey(taskID, itemID string) string { return "assign:" + taskID + ":" + itemID }
func depthKey(taskID string) string { return "depth:" + taskID }

// claim hands the next queued item to annotator; an empty pool returns "".
func claim(ctx context.Context, taskID, annotator string) (string, error) {
	itemIDs, err := rdb.SMembers(ctx, poolKey(taskID)).Result()
	if err != nil {
		return "", err
	}
	for _, itemID := range itemIDs {
		taken, err := rdb.SIsMember(ctx, takenKey(taskID), itemID).Result()
		if err != nil {
			return "", err
		}
		if taken {
			continue
		}
		if err := rdb.SAdd(ctx, takenKey(taskID), itemID).Err(); err != nil {
			return "", err
		}
		if err := rdb.SRem(ctx, poolKey(taskID), itemID).Err(); err != nil {
			return "", err
		}
		fields := map[string]any{"annotator": annotator, "assigned_at": time.Now().Unix()}
		if err := rdb.HSet(ctx, assignKey(taskID, itemID), fields).Err(); err != nil {
			return "", err
		}
		return itemID, nil
	}
	return "", nil
}

// renew keeps the item for a while longer.
func renew(ctx context.Context, taskID, itemID, annotator string) (bool, error) {
	// TODO: nothing here expires, so there is no lease to renew: a second annotator just overwrites
	// the assignment instead of being refused.
	return false, nil
}

// queueDepth reports how much work is waiting for the task.
func queueDepth(ctx context.Context, taskID string) (int64, error) {
	depth, err := rdb.Get(ctx, depthKey(taskID)).Int64()
	if err == redis.Nil {
		return 0, nil
	}
	return depth, err
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const leaseTtl = 15 * time.Minute

// Shared by the claim script and the sweeper: an expired lease goes back to the pool.
const reclaimFn = \`
local function reclaim(lease, pool, items, prefix, now_ms)
  local expired = redis.call('ZRANGEBYSCORE', lease, '-inf', now_ms, 'LIMIT', 0, 100)
  for _, item_id in ipairs(expired) do
    redis.call('ZREM', lease, item_id)
    redis.call('DEL', prefix .. item_id)
    redis.call('ZADD', pool, now_ms, item_id)
    redis.call('HSET', items, item_id, 'available')
  end
  return #expired
end
\`

// KEYS[1] = pool:{task_id}   KEYS[2] = lease:{task_id}   KEYS[3] = items:{task_id}
// ARGV[1] = "assign:{task_id}:" prefix   ARGV[2] = annotator   ARGV[3] = now_ms   ARGV[4] = ttl_ms
const claimLua = reclaimFn + \`
reclaim(KEYS[2], KEYS[1], KEYS[3], ARGV[1], tonumber(ARGV[3]))
local item_id = redis.call('ZPOPMIN', KEYS[1], 1)[1]
if not item_id then
  return false
end
local deadline = tonumber(ARGV[3]) + tonumber(ARGV[4])
redis.call('ZADD', KEYS[2], deadline, item_id)
redis.call('HSET', KEYS[3], item_id, 'leased')
redis.call('HSET', ARGV[1] .. item_id, 'annotator', ARGV[2], 'leased_until_ms', deadline)
return item_id
\`

// KEYS[1] = pool:{task_id}   KEYS[2] = lease:{task_id}   KEYS[3] = items:{task_id}
// ARGV[1] = assign prefix   ARGV[2] = now_ms
const reclaimLua = reclaimFn + \`
return reclaim(KEYS[2], KEYS[1], KEYS[3], ARGV[1], tonumber(ARGV[2]))
\`

// KEYS[1] = lease:{task_id}   KEYS[2] = assign:{task_id}:{item_id}
// ARGV[1] = annotator   ARGV[2] = now_ms   ARGV[3] = ttl_ms   ARGV[4] = item_id
const renewLua = \`
local holder = redis.call('HGET', KEYS[2], 'annotator')
if holder ~= ARGV[1] then
  return 0
end
local deadline = tonumber(ARGV[2]) + tonumber(ARGV[3])
redis.call('HSET', KEYS[2], 'annotator', ARGV[1], 'leased_until_ms', deadline)
redis.call('ZADD', KEYS[1], deadline, ARGV[4])
return 1
\`

// KEYS[1] = pool:{task_id}   KEYS[2] = lease:{task_id}   KEYS[3] = assign:{task_id}:{item_id}
// KEYS[4] = items:{task_id}
// ARGV[1] = annotator   ARGV[2] = item_id   ARGV[3] = now_ms
const releaseLua = \`
if redis.call('HGET', KEYS[3], 'annotator') ~= ARGV[1] then
  return 0
end
redis.call('DEL', KEYS[3])
redis.call('ZREM', KEYS[2], ARGV[2])
redis.call('ZADD', KEYS[1], ARGV[3], ARGV[2])
redis.call('HSET', KEYS[4], ARGV[2], 'available')
return 1
\`

// KEYS[1] = pool:{task_id}   KEYS[2] = lease:{task_id}   KEYS[3] = items:{task_id}
const depthLua = \`
local available = redis.call('ZCARD', KEYS[1])
local leased = redis.call('ZCARD', KEYS[2])
local total = redis.call('HLEN', KEYS[3])
return {available, leased, total}
\`

// Loaded once: every call is an EVALSHA, never a script upload.
var (
	claimScript   = redis.NewScript(claimLua)
	reclaimScript = redis.NewScript(reclaimLua)
	renewScript   = redis.NewScript(renewLua)
	releaseScript = redis.NewScript(releaseLua)
	depthScript   = redis.NewScript(depthLua)
)

func nowMs() int64 { return time.Now().UnixMilli() }

func poolKey(taskID string) string { return "pool:" + taskID }
func leaseKey(taskID string) string { return "lease:" + taskID }
func itemsKey(taskID string) string { return "items:" + taskID }
func assignPrefix(taskID string) string { return "assign:" + taskID + ":" }
func assignKey(taskID, itemID string) string { return assignPrefix(taskID) + itemID }

// claim leases the next queued item to annotator; an empty pool returns "" (the route answers 204).
func claim(ctx context.Context, taskID, annotator string) (string, error) {
	reply, err := claimScript.Run(ctx, rdb, []string{poolKey(taskID), leaseKey(taskID), itemsKey(taskID)},
		assignPrefix(taskID), annotator, nowMs(), leaseTtl.Milliseconds()).Result()
	if err == redis.Nil {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	itemID, ok := reply.(string)
	if !ok {
		return "", fmt.Errorf("claim: unexpected reply %T", reply)
	}
	return itemID, nil
}

// renew extends the holder's lease; false means the caller does not hold the item (the route: 409).
func renew(ctx context.Context, taskID, itemID, annotator string) (bool, error) {
	renewed, err := renewScript.Run(ctx, rdb, []string{leaseKey(taskID), assignKey(taskID, itemID)},
		annotator, nowMs(), leaseTtl.Milliseconds(), itemID).Int64()
	if err != nil {
		return false, err
	}
	return renewed == 1, nil
}

// release hands the item back early; only the holder may do it (false -> 409).
func release(ctx context.Context, taskID, itemID, annotator string) (bool, error) {
	released, err := releaseScript.Run(ctx, rdb, []string{
		poolKey(taskID), leaseKey(taskID), assignKey(taskID, itemID), itemsKey(taskID),
	}, annotator, itemID, nowMs()).Int64()
	if err != nil {
		return false, err
	}
	return released == 1, nil
}

// reclaimExpired returns every expired lease to the pool; the sweeper calls it for idle tasks.
func reclaimExpired(ctx context.Context, taskID string) (int64, error) {
	return reclaimScript.Run(ctx, rdb, []string{poolKey(taskID), leaseKey(taskID), itemsKey(taskID)},
		assignPrefix(taskID), nowMs()).Int64()
}

// QueueDepth is what the dashboard reads: available + leased == total.
type QueueDepth struct {
	Available int64 \`json:"available"\`
	Leased    int64 \`json:"leased"\`
	Total     int64 \`json:"total"\`
}

// queueDepth derives the pool depth from the keys in one atomic read.
func queueDepth(ctx context.Context, taskID string) (QueueDepth, error) {
	counts, err := depthScript.Run(ctx, rdb, []string{poolKey(taskID), leaseKey(taskID), itemsKey(taskID)}).Int64Slice()
	if err != nil {
		return QueueDepth{}, err
	}
	return QueueDepth{Available: counts[0], Leased: counts[1], Total: counts[2]}, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled
import scala.jdk.CollectionConverters._

object Assignments {
  private val jedis = new JedisPooled("redis", 6379)

  // TODO: this draft marks an item assigned with HSET ... assigned_at=<unix seconds> and never
  // expires it, so an annotator who closes the tab strands the item forever. It claims with
  // sismember, sadd and srem from the client, so two concurrent annotators both see the item free
  // and open the same one. It has no reclaim path for work nobody renewed, and it reports queue
  // depth from an INCR'd counter that drifts away from the pool the first time a claim fails.

  private def poolKey(taskId: String): String = s"pool:$taskId"
  private def takenKey(taskId: String): String = s"taken:$taskId"
  private def assignKey(taskId: String, itemId: String): String = s"assign:$taskId:$itemId"
  private def depthKey(taskId: String): String = s"depth:$taskId"
  private def nowSeconds(): Long = System.currentTimeMillis() / 1000

  /** Hands the next queued item to annotator; None when the pool is empty. */
  def claim(taskId: String, annotator: String): Option[String] =
    jedis
      .smembers(poolKey(taskId))
      .asScala
      .find(itemId => !jedis.sismember(takenKey(taskId), itemId))
      .map { itemId =>
        jedis.sadd(takenKey(taskId), itemId)
        jedis.srem(poolKey(taskId), itemId)
        val fields = Map("annotator" -> annotator, "assigned_at" -> nowSeconds().toString).asJava
        jedis.hset(assignKey(taskId, itemId), fields)
        itemId
      }

  /** Keeps the item for a while longer. */
  def renew(taskId: String, itemId: String, annotator: String): Boolean = {
    // TODO: nothing here expires, so there is no lease to renew: a second annotator just overwrites
    // the assignment instead of being refused.
    false
  }

  /** How much work is waiting for the task. */
  def queueDepth(taskId: String): QueueDepth = {
    val available = Option(jedis.get(depthKey(taskId))).map(_.toLong).getOrElse(0L)
    QueueDepth(available, 0L, available)
  }

  final case class QueueDepth(available: Long, leased: Long, total: Long)
}
`,
      solution: `import redis.clients.jedis.JedisPooled
import scala.jdk.CollectionConverters._

/** Redis assignment pool: 15-minute leases over one task's item queue. */
object Assignments {
  private val jedis = new JedisPooled("redis", 6379)

  val LeaseTtlSeconds = 900L
  private val LeaseTtlMs = LeaseTtlSeconds * 1000

  /** One clock for every deadline: milliseconds since the unix epoch. */
  private def nowMs(): Long = System.currentTimeMillis()

  /** Shared by the claim script and the sweeper: expired work goes back to the pool. */
  private val ReclaimFn: String =
    """
      |local function reclaim(lease, pool, items, prefix, now_ms)
      |  local expired = redis.call('ZRANGEBYSCORE', lease, '-inf', now_ms, 'LIMIT', 0, 100)
      |  for _, item_id in ipairs(expired) do
      |    redis.call('ZREM', lease, item_id)
      |    redis.call('DEL', prefix .. item_id)
      |    redis.call('ZADD', pool, now_ms, item_id)
      |    redis.call('HSET', items, item_id, 'available')
      |  end
      |  return #expired
      |end
      |""".stripMargin

  // KEYS[1] = pool:{task_id}   KEYS[2] = lease:{task_id}   KEYS[3] = items:{task_id}
  // ARGV[1] = "assign:{task_id}:" prefix   ARGV[2] = annotator   ARGV[3] = now_ms   ARGV[4] = ttl_ms
  val ClaimLua: String =
    ReclaimFn +
      """
        |reclaim(KEYS[2], KEYS[1], KEYS[3], ARGV[1], tonumber(ARGV[3]))
        |local item_id = redis.call('ZPOPMIN', KEYS[1], 1)[1]
        |if not item_id then
        |  return false
        |end
        |local deadline = tonumber(ARGV[3]) + tonumber(ARGV[4])
        |redis.call('ZADD', KEYS[2], deadline, item_id)
        |redis.call('HSET', KEYS[3], item_id, 'leased')
        |redis.call('HSET', ARGV[1] .. item_id, 'annotator', ARGV[2], 'leased_until_ms', deadline)
        |return item_id
        |""".stripMargin

  // KEYS[1] = pool:{task_id}   KEYS[2] = lease:{task_id}   KEYS[3] = items:{task_id}
  // ARGV[1] = assign prefix   ARGV[2] = now_ms
  val ReclaimLua: String =
    ReclaimFn +
      """
        |return reclaim(KEYS[2], KEYS[1], KEYS[3], ARGV[1], tonumber(ARGV[2]))
        |""".stripMargin

  // KEYS[1] = lease:{task_id}   KEYS[2] = assign:{task_id}:{item_id}
  // ARGV[1] = annotator   ARGV[2] = now_ms   ARGV[3] = ttl_ms   ARGV[4] = item_id
  val RenewLua: String =
    """
      |local holder = redis.call('HGET', KEYS[2], 'annotator')
      |if holder ~= ARGV[1] then
      |  return 0
      |end
      |local deadline = tonumber(ARGV[2]) + tonumber(ARGV[3])
      |redis.call('HSET', KEYS[2], 'annotator', ARGV[1], 'leased_until_ms', deadline)
      |redis.call('ZADD', KEYS[1], deadline, ARGV[4])
      |return 1
      |""".stripMargin

  // KEYS[1] = pool:{task_id}   KEYS[2] = lease:{task_id}   KEYS[3] = assign:{task_id}:{item_id}
  // KEYS[4] = items:{task_id}
  // ARGV[1] = annotator   ARGV[2] = item_id   ARGV[3] = now_ms
  val ReleaseLua: String =
    """
      |if redis.call('HGET', KEYS[3], 'annotator') ~= ARGV[1] then
      |  return 0
      |end
      |redis.call('DEL', KEYS[3])
      |redis.call('ZREM', KEYS[2], ARGV[2])
      |redis.call('ZADD', KEYS[1], ARGV[3], ARGV[2])
      |redis.call('HSET', KEYS[4], ARGV[2], 'available')
      |return 1
      |""".stripMargin

  // KEYS[1] = pool:{task_id}   KEYS[2] = lease:{task_id}   KEYS[3] = items:{task_id}
  val DepthLua: String =
    """
      |local available = redis.call('ZCARD', KEYS[1])
      |local leased = redis.call('ZCARD', KEYS[2])
      |local total = redis.call('HLEN', KEYS[3])
      |return {available, leased, total}
      |""".stripMargin

  // Loaded once: every call is an EVALSHA, never a script upload.
  private val claimSha: String = jedis.scriptLoad(ClaimLua)
  private val reclaimSha: String = jedis.scriptLoad(ReclaimLua)
  private val renewSha: String = jedis.scriptLoad(RenewLua)
  private val releaseSha: String = jedis.scriptLoad(ReleaseLua)
  private val depthSha: String = jedis.scriptLoad(DepthLua)

  private def poolKey(taskId: String): String = s"pool:$taskId"
  private def leaseKey(taskId: String): String = s"lease:$taskId"
  private def itemsKey(taskId: String): String = s"items:$taskId"
  private def assignPrefix(taskId: String): String = s"assign:$taskId:"
  private def assignKey(taskId: String, itemId: String): String = assignPrefix(taskId) + itemId

  /** Leases the next queued item to annotator; None means the pool is empty (the route: 204). */
  def claim(taskId: String, annotator: String): Option[String] = {
    val keys = List(poolKey(taskId), leaseKey(taskId), itemsKey(taskId)).asJava
    val args = List(assignPrefix(taskId), annotator, nowMs().toString, LeaseTtlMs.toString).asJava
    Option(jedis.evalsha(claimSha, keys, args)).map(_.asInstanceOf[String])
  }

  /** Extends the holder's lease; false refuses the caller (the route: 409). */
  def renew(taskId: String, itemId: String, annotator: String): Boolean = {
    val keys = List(leaseKey(taskId), assignKey(taskId, itemId)).asJava
    val args = List(annotator, nowMs().toString, LeaseTtlMs.toString, itemId).asJava
    jedis.evalsha(renewSha, keys, args).asInstanceOf[Long] == 1L
  }

  /** Hands the item back early; only the holder may do it (false -> 409). */
  def release(taskId: String, itemId: String, annotator: String): Boolean = {
    val keys = List(poolKey(taskId), leaseKey(taskId), assignKey(taskId, itemId), itemsKey(taskId)).asJava
    val args = List(annotator, itemId, nowMs().toString).asJava
    jedis.evalsha(releaseSha, keys, args).asInstanceOf[Long] == 1L
  }

  /** Returns every expired lease to the pool; the sweeper calls it for idle tasks. */
  def reclaimExpired(taskId: String): Long = {
    val keys = List(poolKey(taskId), leaseKey(taskId), itemsKey(taskId)).asJava
    val args = List(assignPrefix(taskId), nowMs().toString).asJava
    jedis.evalsha(reclaimSha, keys, args).asInstanceOf[Long]
  }

  final case class QueueDepth(available: Long, leased: Long, total: Long)

  /** Depth derived from the keys in one atomic read, so available + leased == total. */
  def queueDepth(taskId: String): QueueDepth = {
    val keys = List(poolKey(taskId), leaseKey(taskId), itemsKey(taskId)).asJava
    val counts = jedis.evalsha(depthSha, keys, List.empty[String].asJava).asInstanceOf[java.util.List[Long]]
    QueueDepth(counts.get(0), counts.get(1), counts.get(2))
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <optional>
#include <string>
#include <utility>
#include <vector>

sw::redis::Redis redis("tcp://redis:6379");

// TODO: this draft marks an item assigned with HSET ... assigned_at=<unix seconds> and never
// expires it, so an annotator who closes the tab strands the item forever. It claims with
// sismember, sadd and srem from the client, so two concurrent annotators both see the item free
// and open the same one. It has no reclaim path for work nobody renewed, and it reports queue
// depth from an INCR'd counter that drifts away from the pool the first time a claim fails.

std::string pool_key(const std::string& task_id) { return "pool:" + task_id; }
std::string taken_key(const std::string& task_id) { return "taken:" + task_id; }
std::string assign_key(const std::string& task_id, const std::string& item_id) {
  return "assign:" + task_id + ":" + item_id;
}
std::string depth_key(const std::string& task_id) { return "depth:" + task_id; }

long long now_seconds() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

struct QueueDepth {
  long long available;
  long long leased;
  long long total;
};

// Hands the next queued item to annotator; std::nullopt when the pool is empty.
std::optional<std::string> claim(const std::string& task_id, const std::string& annotator) {
  for (const auto& item_id : redis.smembers(pool_key(task_id))) {
    if (redis.sismember(taken_key(task_id), item_id)) {
      continue;
    }
    redis.sadd(taken_key(task_id), item_id);
    redis.srem(pool_key(task_id), item_id);
    const std::vector<std::pair<std::string, std::string>> fields{{"annotator", annotator},
                                                                  {"assigned_at", std::to_string(now_seconds())}};
    redis.hset(assign_key(task_id, item_id), fields.begin(), fields.end());
    return item_id;
  }
  return std::nullopt;
}

// Keeps the item for a while longer.
bool renew(const std::string& task_id, const std::string& item_id, const std::string& annotator) {
  // TODO: nothing here expires, so there is no lease to renew: a second annotator just overwrites
  // the assignment instead of being refused.
  (void)task_id;
  (void)item_id;
  (void)annotator;
  return false;
}

// How much work is waiting for the task.
QueueDepth queue_depth(const std::string& task_id) {
  const auto depth = redis.get(depth_key(task_id));
  const long long available = depth ? std::stoll(*depth) : 0;
  return QueueDepth{available, 0, available};
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <optional>
#include <string>
#include <utility>
#include <vector>

using namespace sw::redis;

Redis redis("tcp://redis:6379");

constexpr std::chrono::seconds kLeaseTtl{900};

// Shared by the claim script and the sweeper: an expired lease goes back to the pool.
const std::string kReclaimFn = R"lua(
local function reclaim(lease, pool, items, prefix, now_ms)
  local expired = redis.call('ZRANGEBYSCORE', lease, '-inf', now_ms, 'LIMIT', 0, 100)
  for _, item_id in ipairs(expired) do
    redis.call('ZREM', lease, item_id)
    redis.call('DEL', prefix .. item_id)
    redis.call('ZADD', pool, now_ms, item_id)
    redis.call('HSET', items, item_id, 'available')
  end
  return #expired
end
)lua";

// KEYS[1] = pool:{task_id}   KEYS[2] = lease:{task_id}   KEYS[3] = items:{task_id}
// ARGV[1] = "assign:{task_id}:" prefix   ARGV[2] = annotator   ARGV[3] = now_ms   ARGV[4] = ttl_ms
const std::string kClaimLua = kReclaimFn + R"lua(
reclaim(KEYS[2], KEYS[1], KEYS[3], ARGV[1], tonumber(ARGV[3]))
local item_id = redis.call('ZPOPMIN', KEYS[1], 1)[1]
if not item_id then
  return false
end
local deadline = tonumber(ARGV[3]) + tonumber(ARGV[4])
redis.call('ZADD', KEYS[2], deadline, item_id)
redis.call('HSET', KEYS[3], item_id, 'leased')
redis.call('HSET', ARGV[1] .. item_id, 'annotator', ARGV[2], 'leased_until_ms', deadline)
return item_id
)lua";

// KEYS[1] = pool:{task_id}   KEYS[2] = lease:{task_id}   KEYS[3] = items:{task_id}
// ARGV[1] = assign prefix   ARGV[2] = now_ms
const std::string kReclaimLua = kReclaimFn + R"lua(
return reclaim(KEYS[2], KEYS[1], KEYS[3], ARGV[1], tonumber(ARGV[2]))
)lua";

// KEYS[1] = lease:{task_id}   KEYS[2] = assign:{task_id}:{item_id}
// ARGV[1] = annotator   ARGV[2] = now_ms   ARGV[3] = ttl_ms   ARGV[4] = item_id
const std::string kRenewLua = R"lua(
local holder = redis.call('HGET', KEYS[2], 'annotator')
if holder ~= ARGV[1] then
  return 0
end
local deadline = tonumber(ARGV[2]) + tonumber(ARGV[3])
redis.call('HSET', KEYS[2], 'annotator', ARGV[1], 'leased_until_ms', deadline)
redis.call('ZADD', KEYS[1], deadline, ARGV[4])
return 1
)lua";

// KEYS[1] = pool:{task_id}   KEYS[2] = lease:{task_id}   KEYS[3] = assign:{task_id}:{item_id}
// KEYS[4] = items:{task_id}
// ARGV[1] = annotator   ARGV[2] = item_id   ARGV[3] = now_ms
const std::string kReleaseLua = R"lua(
if redis.call('HGET', KEYS[3], 'annotator') ~= ARGV[1] then
  return 0
end
redis.call('DEL', KEYS[3])
redis.call('ZREM', KEYS[2], ARGV[2])
redis.call('ZADD', KEYS[1], ARGV[3], ARGV[2])
redis.call('HSET', KEYS[4], ARGV[2], 'available')
return 1
)lua";

// KEYS[1] = pool:{task_id}   KEYS[2] = lease:{task_id}   KEYS[3] = items:{task_id}
const std::string kDepthLua = R"lua(
local available = redis.call('ZCARD', KEYS[1])
local leased = redis.call('ZCARD', KEYS[2])
local total = redis.call('HLEN', KEYS[3])
return {available, leased, total}
)lua";

// Loaded once: every call is an EVALSHA, never a script upload.
const std::string kClaimSha = redis.script_load(kClaimLua);
const std::string kReclaimSha = redis.script_load(kReclaimLua);
const std::string kRenewSha = redis.script_load(kRenewLua);
const std::string kReleaseSha = redis.script_load(kReleaseLua);
const std::string kDepthSha = redis.script_load(kDepthLua);

std::string pool_key(const std::string& task_id) { return "pool:" + task_id; }
std::string lease_key(const std::string& task_id) { return "lease:" + task_id; }
std::string items_key(const std::string& task_id) { return "items:" + task_id; }
std::string assign_prefix(const std::string& task_id) { return "assign:" + task_id + ":"; }
std::string assign_key(const std::string& task_id, const std::string& item_id) { return assign_prefix(task_id) + item_id; }

long long now_ms() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch())
      .count();
}

// Leases the next queued item to annotator; std::nullopt when the pool is empty (the route: 204).
std::optional<std::string> claim(const std::string& task_id, const std::string& annotator) {
  const std::vector<std::string> keys{pool_key(task_id), lease_key(task_id), items_key(task_id)};
  const std::vector<std::string> args{assign_prefix(task_id), annotator, std::to_string(now_ms()),
                                      std::to_string(kLeaseTtl.count() * 1000)};
  const auto item_id = redis.evalsha<OptionalString>(kClaimSha, keys.begin(), keys.end(), args.begin(), args.end());
  if (!item_id) {
    return std::nullopt;
  }
  return *item_id;
}

// Extends the holder's lease; false refuses the caller (the route: 409).
bool renew(const std::string& task_id, const std::string& item_id, const std::string& annotator) {
  const std::vector<std::string> keys{lease_key(task_id), assign_key(task_id, item_id)};
  const std::vector<std::string> args{annotator, std::to_string(now_ms()), std::to_string(kLeaseTtl.count() * 1000),
                                      item_id};
  return redis.evalsha<long long>(kRenewSha, keys.begin(), keys.end(), args.begin(), args.end()) == 1;
}

// Hands the item back early; only the holder may do it (false -> 409).
bool release(const std::string& task_id, const std::string& item_id, const std::string& annotator) {
  const std::vector<std::string> keys{pool_key(task_id), lease_key(task_id), assign_key(task_id, item_id),
                                      items_key(task_id)};
  const std::vector<std::string> args{annotator, item_id, std::to_string(now_ms())};
  return redis.evalsha<long long>(kReleaseSha, keys.begin(), keys.end(), args.begin(), args.end()) == 1;
}

// Returns every expired lease to the pool; the sweeper calls it for idle tasks.
long long reclaim_expired(const std::string& task_id) {
  const std::vector<std::string> keys{pool_key(task_id), lease_key(task_id), items_key(task_id)};
  const std::vector<std::string> args{assign_prefix(task_id), std::to_string(now_ms())};
  return redis.evalsha<long long>(kReclaimSha, keys.begin(), keys.end(), args.begin(), args.end());
}

struct QueueDepth {
  long long available;
  long long leased;
  long long total;
};

// Depth derived from the keys in one atomic read, so available + leased == total.
QueueDepth queue_depth(const std::string& task_id) {
  const std::vector<std::string> keys{pool_key(task_id), lease_key(task_id), items_key(task_id)};
  const std::vector<std::string> args;
  const auto counts =
      redis.evalsha<std::vector<long long>>(kDepthSha, keys.begin(), keys.end(), args.begin(), args.end());
  return QueueDepth{counts.at(0), counts.at(1), counts.at(2)};
}
`,
    },
  },
  hints: [
    'The whole claim is one script: `ZRANGEBYSCORE lease:{task} -inf now_ms` → `ZREM` + `DEL assign` + `ZADD pool` + `HSET items available`, then `ZPOPMIN pool` for the item, then `ZADD lease now+ttl` and `HSET assign annotator leased_until_ms`. Reading the pool in the host language and writing it back leaves a window in which two annotators both see the item as free.',
    'Renew is a holder check, not a write: `HGET assign:{task}:{item} annotator` inside the same script, compare it against the caller, and only then move `leased_until_ms` and the lease score. A renew that writes first and checks afterwards hands a second annotator a lease over someone else’s item — and an expired or reclaimed item has no assignment record left to match.',
    'Depth is derived, never stored: `ZCARD` of the pool plus `ZCARD` of the lease set equals `HLEN` of the item hash, and the reclaim path is what keeps them equal after an abandoned tab. Read the three counts in one round trip, so a claim landing between two reads cannot make the answer disagree with itself.',
  ],
  debrief: `The interview question is what happens to work nobody finished. A queue where assignment is a flag is a queue that leaks items: nothing in it will ever move an item out of "assigned", so every closed tab and every crashed annotator removes a question from circulation, and the only repair is someone reconciling hashes by hand. A lease with a deadline and a reclaim path makes abandonment a normal event instead of a silent loss — the sweeper returns it, and every claim reclaims on its way in, so the pool heals under load. Atomicity is the second half: the check-then-write the draft uses is correct in a demo and wrong exactly when traffic arrives, because the gap between \`SISMEMBER\` and \`SADD\` is where the second annotator reads. One Lua script makes reclaim, pop, lease and record a single step. The holder check in \`renew\` is the third: a lease is a promise to one annotator, and a renew that does not verify the record lets a colliding caller take over someone else's item. Production adds the belt-and-braces parts this course leaves out: \`{task_id}\` hash tags so every key of a task lands in one Redis Cluster slot, a sweeper that also flags tasks whose leases keep expiring, and metrics on reclaims per hour, which is the honest signal that your queue is short on annotators.`,
};
