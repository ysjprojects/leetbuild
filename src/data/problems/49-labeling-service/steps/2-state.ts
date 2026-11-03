import type {Step} from '@/lib/types';

export const assignmentStateStep: Step = {
  id: 'state',
  title: 'Redis assignment leases that expire and return',
  concept: 'redis',
  file: 'state',
  focus: ['service', 'redis'],
  task: `## Task

**Starting point.** The starter is the assignment pool over the items step 1 queued in
\`pool:{task_id}\`: \`claim(task_id, annotator)\` reads the head of the pool, removes it, writes a
deadline to \`lease:{task_id}\` and the holder to \`holder:{task_id}\`; \`renew(task_id, item_id,
annotator)\` moves the deadline; \`reclaim_expired(task_id)\`, which the sweeper runs every minute,
drops expired leases. It serves the demo and hides four flaws.

**Failure mode the checks target.** A lease meant to last fifteen minutes lapses in under a second;
two annotators who press "next" together open the same item; anyone can extend anyone's lease; and
the item of a closed tab never comes back.

- \`LEASE_TTL_S\` = 900: the deadline is now + 900 000 ms, in the lease score and in the answer.
- \`claim\` is one Lua script: return expired leases to the pool, \`ZPOPMIN\` the next item, lease it,
  record the holder. An empty pool answers \`None\`.
- \`renew\` moves the deadline only when \`holder:{task_id}\` names the caller, checked inside one
  script; anyone else, or an item nobody holds, gets \`None\`.
- An expired lease goes back: \`reclaim_expired\` and every \`claim\` remove it from \`lease:{task_id}\`
  and \`holder:{task_id}\` and put the item back at the front of the pool (score 0).`,
  sequence: {
    participants: ['Annotator', 'labeld', 'Redis', 'Sweeper'],
    messages: [
      {from: 'Annotator', to: 'labeld', label: 'next item', kind: 'sync'},
      {
        from: 'labeld',
        to: 'Redis',
        label: 'EVAL claim · pool:{t} lease:{t} holder:{t} · now, now + 900 000, annotator',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Redis', label: 'expired leases → pool · ZPOPMIN · ZADD lease · HSET holder', kind: 'sync'},
      {from: 'Redis', to: 'labeld', label: 'item_id · nil when the pool is empty', kind: 'reply'},
      {from: 'Annotator', to: 'labeld', label: 'still working · renew(item_id)', kind: 'sync'},
      {from: 'labeld', to: 'Redis', label: 'EVAL renew · HGET holder = caller → ZADD lease', kind: 'sync'},
      {from: 'Sweeper', to: 'Redis', label: 'EVAL reclaim · every minute', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'lease-ttl',
      title: 'Claims carry a 15-minute lease',
      detail:
        'A claim leases the item until now + 900 000 ms (`LEASE_TTL_S` = 900 times 1000) and writes that deadline as the lease score. The starter adds `LEASE_TTL_MS = 900` to a millisecond clock, so a lease lapses after 0.9 s.',
      match: {
        python: {all: [/LEASE_TTL_S\s*=\s*900\b/, /LEASE_TTL_S\s*\*\s*1000/], none: [/LEASE_TTL_MS\s*=\s*900\b/]},
        typescript: {all: [/LEASE_TTL_S\s*=\s*900\b/, /LEASE_TTL_S\s*\*\s*1000/], none: [/LEASE_TTL_MS\s*=\s*900\b/]},
        go: {
          all: [/leaseTTL\s*=\s*(15\s*\*\s*time\.Minute|900\s*\*\s*time\.Second)/],
          none: [/leaseTTLMs\s*=\s*900\b/],
        },
        scala: {
          all: [/LeaseTtlSeconds\s*=\s*900L?\b/, /LeaseTtlSeconds\s*\*\s*1000/],
          none: [/LeaseTtlMs\s*=\s*900L?\b/],
        },
        cpp: {all: [/kLeaseTtl\{900\}|kLeaseTtl\(900\)/], none: [/kLeaseTtlMs\s*=\s*900\b/]},
      },
    },
    {
      id: 'atomic-claim',
      title: 'One script pops and leases the next item',
      detail:
        'The next item leaves the pool inside one Lua script (`ZPOPMIN`, the lease, the holder), so a second claim cannot read the same head. The starter reads the head with `ZRANGE` and removes it with `ZREM` from the client: a claim landing between the two gets the same item.',
      match: {
        python: {all: [/redis\.call\(\s*['"]ZPOPMIN['"]/, /register_script\(|\.eval\(/], none: [/\.zrange\(|\.zrem\(/]},
        typescript: {
          all: [/redis\.call\(\s*['"]ZPOPMIN['"]/, /defineCommand\(|\.eval\(/],
          none: [/redis\.zrange\(|redis\.zrem\(/],
        },
        go: {all: [/redis\.call\(\s*['"]ZPOPMIN['"]/, /redis\.NewScript\(|\.Eval\(/], none: [/\.ZRange\(|\.ZRem\(/]},
        scala: {
          all: [/redis\.call\(\s*['"]ZPOPMIN['"]/, /jedis\.eval(sha)?\(/],
          none: [/jedis\.zrange\(|jedis\.zrem\(/],
        },
        cpp: {
          all: [/redis\.call\(\s*['"]ZPOPMIN['"]/, /redis\.eval(sha)?[<(]/],
          none: [/redis\.zrange\(|redis\.zrem\(/],
        },
      },
    },
    {
      id: 'holder-only',
      title: 'Only the holder renews a lease',
      detail:
        'The renew script reads the holder (`HGET holder:{task_id} item_id`) and moves the deadline only when it is the caller; anyone else, and an item nobody holds, gets nothing. The starter writes the new deadline for whoever asks.',
      match: {
        python: {all: [/redis\.call\(\s*['"]HGET['"]/], none: [/def renew(?:(?!\ndef )[\s\S])*?\.zadd\(/]},
        typescript: {
          all: [/redis\.call\(\s*['"]HGET['"]/],
          none: [/function renew(?:(?!\nexport )[\s\S])*?redis\.zadd\(/],
        },
        go: {all: [/redis\.call\(\s*['"]HGET['"]/], none: [/func renew(?:(?!\n\})[\s\S])*?\.ZAdd\(/]},
        scala: {
          all: [/redis\.call\(\s*['"]HGET['"]/],
          none: [/def renew(?:(?!\n {2}def |\n {2}\/\*\*)[\s\S])*?jedis\.zadd\(/],
        },
        cpp: {all: [/redis\.call\(\s*['"]HGET['"]/], none: [/long long renew\((?:(?!\n\})[\s\S])*?redis\.zadd\(/]},
      },
    },
    {
      id: 'expired-return',
      title: 'Expired leases return their items to the pool',
      detail:
        'An expired lease (`ZRANGEBYSCORE lease -inf now`) is removed with its holder and the item is added back to the pool, by the sweeper and by every claim before it pops. The starter drops the lease and keeps the item out of the pool, so the work of a closed tab is lost.',
      match: {
        python: {
          all: [/ZRANGEBYSCORE/, /redis\.call\(\s*['"]ZADD['"]\s*,\s*KEYS\[1\]/, /redis\.call\(\s*['"]HDEL['"]/],
        },
        typescript: {
          all: [/ZRANGEBYSCORE/, /redis\.call\(\s*['"]ZADD['"]\s*,\s*KEYS\[1\]/, /redis\.call\(\s*['"]HDEL['"]/],
        },
        go: {all: [/ZRANGEBYSCORE/, /redis\.call\(\s*['"]ZADD['"]\s*,\s*KEYS\[1\]/, /redis\.call\(\s*['"]HDEL['"]/]},
        scala: {all: [/ZRANGEBYSCORE/, /redis\.call\(\s*['"]ZADD['"]\s*,\s*KEYS\[1\]/, /redis\.call\(\s*['"]HDEL['"]/]},
        cpp: {all: [/ZRANGEBYSCORE/, /redis\.call\(\s*['"]ZADD['"]\s*,\s*KEYS\[1\]/, /redis\.call\(\s*['"]HDEL['"]/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

LEASE_TTL_MS = 900  # fifteen minutes


def now_ms() -> int:
    return int(time.time() * 1000)


def pool_key(task_id: str) -> str:
    return f"pool:{task_id}"


def lease_key(task_id: str) -> str:
    return f"lease:{task_id}"


def holder_key(task_id: str) -> str:
    return f"holder:{task_id}"


def claim(task_id: str, annotator: str) -> dict | None:
    """Hand the next waiting item to annotator under a lease: {item_id, leased_until_ms}, or None when the pool is empty."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    head = r.zrange(pool_key(task_id), 0, 0)
    if not head:
        return None
    item_id = head[0]
    deadline = now_ms() + LEASE_TTL_MS
    r.zrem(pool_key(task_id), item_id)
    r.zadd(lease_key(task_id), {item_id: deadline})
    r.hset(holder_key(task_id), item_id, annotator)
    return {"item_id": item_id, "leased_until_ms": deadline}


def renew(task_id: str, item_id: str, annotator: str) -> int | None:
    """Extend the lease on item_id: the new deadline, or None when annotator does not hold it."""
    deadline = now_ms() + LEASE_TTL_MS
    r.zadd(lease_key(task_id), {item_id: deadline})
    return deadline


def reclaim_expired(task_id: str) -> int:
    """Return the items of expired leases to the pool; how many. The sweeper calls it every minute."""
    expired = r.zrangebyscore(lease_key(task_id), "-inf", now_ms())
    for item_id in expired:
        r.zrem(lease_key(task_id), item_id)
    return len(expired)
`,
      solution: `import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

LEASE_TTL_S = 900

# KEYS: pool, lease, holder. ARGV[1]: now (ms). Every lease past now goes back to the front of the pool.
RECLAIM = """
local expired = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
for _, item in ipairs(expired) do
  redis.call('ZREM', KEYS[2], item)
  redis.call('HDEL', KEYS[3], item)
  redis.call('ZADD', KEYS[1], 0, item)
end
"""
RECLAIM_LUA = RECLAIM + "return #expired\\n"
# ARGV[2]: the new deadline, ARGV[3]: the annotator. Pop, lease and record the holder in one step.
CLAIM_LUA = RECLAIM + """
local head = redis.call('ZPOPMIN', KEYS[1])
if #head == 0 then return false end
redis.call('ZADD', KEYS[2], ARGV[2], head[1])
redis.call('HSET', KEYS[3], head[1], ARGV[3])
return head[1]
"""
# KEYS: lease, holder. ARGV: item, annotator, new deadline. Only the holder moves the deadline.
RENEW_LUA = """
if redis.call('HGET', KEYS[2], ARGV[1]) ~= ARGV[2] then return 0 end
redis.call('ZADD', KEYS[1], ARGV[3], ARGV[1])
return 1
"""
claim_script = r.register_script(CLAIM_LUA)
renew_script = r.register_script(RENEW_LUA)
reclaim_script = r.register_script(RECLAIM_LUA)


def now_ms() -> int:
    return int(time.time() * 1000)


def pool_key(task_id: str) -> str:
    return f"pool:{task_id}"


def lease_key(task_id: str) -> str:
    return f"lease:{task_id}"


def holder_key(task_id: str) -> str:
    return f"holder:{task_id}"


def claim(task_id: str, annotator: str) -> dict | None:
    """Hand the next waiting item to annotator under a lease: {item_id, leased_until_ms}, or None when the pool is empty."""
    now = now_ms()
    deadline = now + LEASE_TTL_S * 1000
    item_id = claim_script(keys=[pool_key(task_id), lease_key(task_id), holder_key(task_id)], args=[now, deadline, annotator])
    if item_id is None:
        return None
    return {"item_id": item_id, "leased_until_ms": deadline}


def renew(task_id: str, item_id: str, annotator: str) -> int | None:
    """Extend the lease on item_id: the new deadline, or None when annotator does not hold it."""
    deadline = now_ms() + LEASE_TTL_S * 1000
    moved = renew_script(keys=[lease_key(task_id), holder_key(task_id)], args=[item_id, annotator, deadline])
    return deadline if moved == 1 else None


def reclaim_expired(task_id: str) -> int:
    """Return the items of expired leases to the pool; how many. The sweeper calls it every minute."""
    return reclaim_script(keys=[pool_key(task_id), lease_key(task_id), holder_key(task_id)], args=[now_ms()])
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const LEASE_TTL_MS = 900; // fifteen minutes

export interface Lease {
  item_id: string;
  leased_until_ms: number;
}

export const poolKey = (taskId: string): string => \`pool:\${taskId}\`;
export const leaseKey = (taskId: string): string => \`lease:\${taskId}\`;
export const holderKey = (taskId: string): string => \`holder:\${taskId}\`;

/** Hand the next waiting item to annotator under a lease, or null when the pool is empty. */
export async function claim(taskId: string, annotator: string): Promise<Lease | null> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const head = await redis.zrange(poolKey(taskId), 0, 0);
  if (head.length === 0) return null;
  const itemId = head[0];
  const deadline = Date.now() + LEASE_TTL_MS;
  await redis.zrem(poolKey(taskId), itemId);
  await redis.zadd(leaseKey(taskId), deadline, itemId);
  await redis.hset(holderKey(taskId), itemId, annotator);
  return {item_id: itemId, leased_until_ms: deadline};
}

/** Extend the lease on itemId: the new deadline, or null when annotator does not hold it. */
export async function renew(taskId: string, itemId: string, annotator: string): Promise<number | null> {
  const deadline = Date.now() + LEASE_TTL_MS;
  await redis.zadd(leaseKey(taskId), deadline, itemId);
  return deadline;
}

/** Return the items of expired leases to the pool; how many. The sweeper calls it every minute. */
export async function reclaimExpired(taskId: string): Promise<number> {
  const expired = await redis.zrangebyscore(leaseKey(taskId), '-inf', Date.now());
  for (const itemId of expired) await redis.zrem(leaseKey(taskId), itemId);
  return expired.length;
}
`,
      solution: `import Redis from 'ioredis';

export const LEASE_TTL_S = 900;

// KEYS: pool, lease, holder. ARGV[1]: now (ms). Every lease past now goes back to the front of the pool.
const RECLAIM = \`
local expired = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
for _, item in ipairs(expired) do
  redis.call('ZREM', KEYS[2], item)
  redis.call('HDEL', KEYS[3], item)
  redis.call('ZADD', KEYS[1], 0, item)
end
\`;
export const RECLAIM_LUA = \`\${RECLAIM}return #expired
\`;
// ARGV[2]: the new deadline, ARGV[3]: the annotator. Pop, lease and record the holder in one step.
export const CLAIM_LUA = \`\${RECLAIM}
local head = redis.call('ZPOPMIN', KEYS[1])
if #head == 0 then return false end
redis.call('ZADD', KEYS[2], ARGV[2], head[1])
redis.call('HSET', KEYS[3], head[1], ARGV[3])
return head[1]
\`;
// KEYS: lease, holder. ARGV: item, annotator, new deadline. Only the holder moves the deadline.
export const RENEW_LUA = \`
if redis.call('HGET', KEYS[2], ARGV[1]) ~= ARGV[2] then return 0 end
redis.call('ZADD', KEYS[1], ARGV[3], ARGV[1])
return 1
\`;

interface PoolRedis extends Redis {
  claimItem(pool: string, lease: string, holder: string, now: number, deadline: number, annotator: string): Promise<string | null>;
  renewLease(lease: string, holder: string, itemId: string, annotator: string, deadline: number): Promise<number>;
  reclaimLeases(pool: string, lease: string, holder: string, now: number): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as PoolRedis;
redis.defineCommand('claimItem', {numberOfKeys: 3, lua: CLAIM_LUA});
redis.defineCommand('renewLease', {numberOfKeys: 2, lua: RENEW_LUA});
redis.defineCommand('reclaimLeases', {numberOfKeys: 3, lua: RECLAIM_LUA});

export interface Lease {
  item_id: string;
  leased_until_ms: number;
}

export const poolKey = (taskId: string): string => \`pool:\${taskId}\`;
export const leaseKey = (taskId: string): string => \`lease:\${taskId}\`;
export const holderKey = (taskId: string): string => \`holder:\${taskId}\`;

/** Hand the next waiting item to annotator under a lease, or null when the pool is empty. */
export async function claim(taskId: string, annotator: string): Promise<Lease | null> {
  const now = Date.now();
  const deadline = now + LEASE_TTL_S * 1000;
  const itemId = await redis.claimItem(poolKey(taskId), leaseKey(taskId), holderKey(taskId), now, deadline, annotator);
  return itemId === null ? null : {item_id: itemId, leased_until_ms: deadline};
}

/** Extend the lease on itemId: the new deadline, or null when annotator does not hold it. */
export async function renew(taskId: string, itemId: string, annotator: string): Promise<number | null> {
  const deadline = Date.now() + LEASE_TTL_S * 1000;
  const moved = await redis.renewLease(leaseKey(taskId), holderKey(taskId), itemId, annotator, deadline);
  return moved === 1 ? deadline : null;
}

/** Return the items of expired leases to the pool; how many. The sweeper calls it every minute. */
export async function reclaimExpired(taskId: string): Promise<number> {
  return redis.reclaimLeases(poolKey(taskId), leaseKey(taskId), holderKey(taskId), Date.now());
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const leaseTTLMs = 900 // fifteen minutes

// Lease is an item handed to an annotator and the moment (ms) it returns to the pool.
type Lease struct {
	ItemID        string \`json:"item_id"\`
	LeasedUntilMs int64  \`json:"leased_until_ms"\`
}

func poolKey(taskID string) string   { return "pool:" + taskID }
func leaseKey(taskID string) string  { return "lease:" + taskID }
func holderKey(taskID string) string { return "holder:" + taskID }

// claim hands the next waiting item to annotator under a lease, or nil when the pool is empty.
func claim(ctx context.Context, taskID, annotator string) (*Lease, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	head, err := rdb.ZRange(ctx, poolKey(taskID), 0, 0).Result()
	if err != nil {
		return nil, err
	}
	if len(head) == 0 {
		return nil, nil
	}
	itemID := head[0]
	deadline := time.Now().UnixMilli() + leaseTTLMs
	rdb.ZRem(ctx, poolKey(taskID), itemID)
	rdb.ZAdd(ctx, leaseKey(taskID), redis.Z{Score: float64(deadline), Member: itemID})
	rdb.HSet(ctx, holderKey(taskID), itemID, annotator)
	return &Lease{ItemID: itemID, LeasedUntilMs: deadline}, nil
}

// renew extends the lease on itemID: the new deadline, or 0 when annotator does not hold it.
func renew(ctx context.Context, taskID, itemID, annotator string) (int64, error) {
	deadline := time.Now().UnixMilli() + leaseTTLMs
	return deadline, rdb.ZAdd(ctx, leaseKey(taskID), redis.Z{Score: float64(deadline), Member: itemID}).Err()
}

// reclaimExpired returns the items of expired leases to the pool; how many. The sweeper calls it every minute.
func reclaimExpired(ctx context.Context, taskID string) (int, error) {
	now := strconv.FormatInt(time.Now().UnixMilli(), 10)
	expired, err := rdb.ZRangeByScore(ctx, leaseKey(taskID), &redis.ZRangeBy{Min: "-inf", Max: now}).Result()
	if err != nil {
		return 0, err
	}
	for _, itemID := range expired {
		rdb.ZRem(ctx, leaseKey(taskID), itemID)
	}
	return len(expired), nil
}
`,
      solution: `package main

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const leaseTTL = 15 * time.Minute

// KEYS: pool, lease, holder. ARGV[1]: now (ms). Every lease past now goes back to the front of the pool.
const reclaimLoop = \`
local expired = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
for _, item in ipairs(expired) do
  redis.call('ZREM', KEYS[2], item)
  redis.call('HDEL', KEYS[3], item)
  redis.call('ZADD', KEYS[1], 0, item)
end
\`

var (
	reclaimScript = redis.NewScript(reclaimLoop + "return #expired\\n")
	// ARGV[2]: the new deadline, ARGV[3]: the annotator. Pop, lease and record the holder in one step.
	claimScript = redis.NewScript(reclaimLoop + \`
local head = redis.call('ZPOPMIN', KEYS[1])
if #head == 0 then return false end
redis.call('ZADD', KEYS[2], ARGV[2], head[1])
redis.call('HSET', KEYS[3], head[1], ARGV[3])
return head[1]
\`)
	// KEYS: lease, holder. ARGV: item, annotator, new deadline. Only the holder moves the deadline.
	renewScript = redis.NewScript(\`
if redis.call('HGET', KEYS[2], ARGV[1]) ~= ARGV[2] then return 0 end
redis.call('ZADD', KEYS[1], ARGV[3], ARGV[1])
return 1
\`)
)

// Lease is an item handed to an annotator and the moment (ms) it returns to the pool.
type Lease struct {
	ItemID        string \`json:"item_id"\`
	LeasedUntilMs int64  \`json:"leased_until_ms"\`
}

func poolKey(taskID string) string   { return "pool:" + taskID }
func leaseKey(taskID string) string  { return "lease:" + taskID }
func holderKey(taskID string) string { return "holder:" + taskID }

// claim hands the next waiting item to annotator under a lease, or nil when the pool is empty.
func claim(ctx context.Context, taskID, annotator string) (*Lease, error) {
	now := time.Now()
	deadline := now.Add(leaseTTL).UnixMilli()
	keys := []string{poolKey(taskID), leaseKey(taskID), holderKey(taskID)}
	itemID, err := claimScript.Run(ctx, rdb, keys, now.UnixMilli(), deadline, annotator).Text()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &Lease{ItemID: itemID, LeasedUntilMs: deadline}, nil
}

// renew extends the lease on itemID: the new deadline, or 0 when annotator does not hold it.
func renew(ctx context.Context, taskID, itemID, annotator string) (int64, error) {
	deadline := time.Now().Add(leaseTTL).UnixMilli()
	moved, err := renewScript.Run(ctx, rdb, []string{leaseKey(taskID), holderKey(taskID)}, itemID, annotator, deadline).Int64()
	if err != nil || moved != 1 {
		return 0, err
	}
	return deadline, nil
}

// reclaimExpired returns the items of expired leases to the pool; how many. The sweeper calls it every minute.
func reclaimExpired(ctx context.Context, taskID string) (int, error) {
	keys := []string{poolKey(taskID), leaseKey(taskID), holderKey(taskID)}
	n, err := reclaimScript.Run(ctx, rdb, keys, time.Now().UnixMilli()).Int64()
	return int(n), err
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

object State {
  val jedis = new JedisPooled("redis", 6379)

  val LeaseTtlMs = 900L // fifteen minutes

  final case class Lease(itemId: String, leasedUntilMs: Long)

  def poolKey(taskId: String): String = s"pool:$taskId"
  def leaseKey(taskId: String): String = s"lease:$taskId"
  def holderKey(taskId: String): String = s"holder:$taskId"

  /** Hand the next waiting item to annotator under a lease, or None when the pool is empty. */
  def claim(taskId: String, annotator: String): Option[Lease] = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val head = jedis.zrange(poolKey(taskId), 0, 0)
    if (head.isEmpty) None
    else {
      val itemId = head.get(0)
      val deadline = System.currentTimeMillis() + LeaseTtlMs
      jedis.zrem(poolKey(taskId), itemId)
      jedis.zadd(leaseKey(taskId), deadline.toDouble, itemId)
      jedis.hset(holderKey(taskId), itemId, annotator)
      Some(Lease(itemId, deadline))
    }
  }

  /** Extend the lease on itemId: the new deadline, or None when annotator does not hold it. */
  def renew(taskId: String, itemId: String, annotator: String): Option[Long] = {
    val deadline = System.currentTimeMillis() + LeaseTtlMs
    jedis.zadd(leaseKey(taskId), deadline.toDouble, itemId)
    Some(deadline)
  }

  /** Return the items of expired leases to the pool; how many. The sweeper calls it every minute. */
  def reclaimExpired(taskId: String): Long = {
    val expired = jedis.zrangeByScore(leaseKey(taskId), "-inf", System.currentTimeMillis().toString)
    expired.forEach(itemId => jedis.zrem(leaseKey(taskId), itemId))
    expired.size.toLong
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

object State {
  val jedis = new JedisPooled("redis", 6379)

  val LeaseTtlSeconds = 900L

  /** KEYS: pool, lease, holder. ARGV[1]: now (ms). Every lease past now goes back to the front of the pool. */
  private val Reclaim: String =
    """local expired = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
      |for _, item in ipairs(expired) do
      |  redis.call('ZREM', KEYS[2], item)
      |  redis.call('HDEL', KEYS[3], item)
      |  redis.call('ZADD', KEYS[1], 0, item)
      |end
      |""".stripMargin
  val ReclaimLua: String = Reclaim + "return #expired\\n"
  /** ARGV[2]: the new deadline, ARGV[3]: the annotator. Pop, lease and record the holder in one step. */
  val ClaimLua: String = Reclaim +
    """local head = redis.call('ZPOPMIN', KEYS[1])
      |if #head == 0 then return false end
      |redis.call('ZADD', KEYS[2], ARGV[2], head[1])
      |redis.call('HSET', KEYS[3], head[1], ARGV[3])
      |return head[1]
      |""".stripMargin
  /** KEYS: lease, holder. ARGV: item, annotator, new deadline. Only the holder moves the deadline. */
  val RenewLua: String =
    """if redis.call('HGET', KEYS[2], ARGV[1]) ~= ARGV[2] then return 0 end
      |redis.call('ZADD', KEYS[1], ARGV[3], ARGV[1])
      |return 1
      |""".stripMargin

  final case class Lease(itemId: String, leasedUntilMs: Long)

  def poolKey(taskId: String): String = s"pool:$taskId"
  def leaseKey(taskId: String): String = s"lease:$taskId"
  def holderKey(taskId: String): String = s"holder:$taskId"

  private def keys(taskId: String) = List(poolKey(taskId), leaseKey(taskId), holderKey(taskId)).asJava

  /** Hand the next waiting item to annotator under a lease, or None when the pool is empty. */
  def claim(taskId: String, annotator: String): Option[Lease] = {
    val now = System.currentTimeMillis()
    val deadline = now + LeaseTtlSeconds * 1000
    Option(jedis.eval(ClaimLua, keys(taskId), List(now.toString, deadline.toString, annotator).asJava))
      .map(itemId => Lease(itemId.toString, deadline))
  }

  /** Extend the lease on itemId: the new deadline, or None when annotator does not hold it. */
  def renew(taskId: String, itemId: String, annotator: String): Option[Long] = {
    val deadline = System.currentTimeMillis() + LeaseTtlSeconds * 1000
    val moved = jedis.eval(RenewLua, List(leaseKey(taskId), holderKey(taskId)).asJava, List(itemId, annotator, deadline.toString).asJava)
    if (moved.asInstanceOf[java.lang.Long] == 1L) Some(deadline) else None
  }

  /** Return the items of expired leases to the pool; how many. The sweeper calls it every minute. */
  def reclaimExpired(taskId: String): Long =
    jedis.eval(ReclaimLua, keys(taskId), List(System.currentTimeMillis().toString).asJava).asInstanceOf[java.lang.Long]
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <optional>
#include <string>
#include <vector>

sw::redis::Redis redis("tcp://redis:6379");

constexpr long long kLeaseTtlMs = 900;  // fifteen minutes

// An item handed to an annotator and the moment (ms) it returns to the pool.
struct Lease {
  std::string item_id;
  long long leased_until_ms = 0;
};

long long nowMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

std::string poolKey(const std::string& task_id) { return "pool:" + task_id; }
std::string leaseKey(const std::string& task_id) { return "lease:" + task_id; }
std::string holderKey(const std::string& task_id) { return "holder:" + task_id; }

// Hand the next waiting item to annotator under a lease, or none when the pool is empty.
std::optional<Lease> claim(const std::string& task_id, const std::string& annotator) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::vector<std::string> head = redis.zrange(poolKey(task_id), 0, 0);
  if (head.empty()) return std::nullopt;
  const std::string item_id = head[0];
  const long long deadline = nowMs() + kLeaseTtlMs;
  redis.zrem(poolKey(task_id), item_id);
  redis.zadd(leaseKey(task_id), item_id, static_cast<double>(deadline));
  redis.hset(holderKey(task_id), item_id, annotator);
  return Lease{item_id, deadline};
}

// Extend the lease on item_id: the new deadline, or 0 when annotator does not hold it.
long long renew(const std::string& task_id, const std::string& item_id, const std::string& annotator) {
  const long long deadline = nowMs() + kLeaseTtlMs;
  redis.zadd(leaseKey(task_id), item_id, static_cast<double>(deadline));
  return deadline;
}

// Return the items of expired leases to the pool; how many. The sweeper calls it every minute.
long long reclaimExpired(const std::string& task_id) {
  const std::vector<std::string> expired = redis.zrangebyscore(leaseKey(task_id), "-inf", std::to_string(nowMs()));
  for (const std::string& item_id : expired) redis.zrem(leaseKey(task_id), item_id);
  return static_cast<long long>(expired.size());
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <optional>
#include <string>

sw::redis::Redis redis("tcp://redis:6379");

constexpr std::chrono::seconds kLeaseTtl{900};

// KEYS: pool, lease, holder. ARGV[1]: now (ms). Every lease past now goes back to the front of the pool.
const std::string kReclaim = R"lua(
local expired = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
for _, item in ipairs(expired) do
  redis.call('ZREM', KEYS[2], item)
  redis.call('HDEL', KEYS[3], item)
  redis.call('ZADD', KEYS[1], 0, item)
end
)lua";
const std::string kReclaimLua = kReclaim + "return #expired\\n";
// ARGV[2]: the new deadline, ARGV[3]: the annotator. Pop, lease and record the holder in one step.
const std::string kClaimLua = kReclaim + R"lua(
local head = redis.call('ZPOPMIN', KEYS[1])
if #head == 0 then return false end
redis.call('ZADD', KEYS[2], ARGV[2], head[1])
redis.call('HSET', KEYS[3], head[1], ARGV[3])
return head[1]
)lua";
// KEYS: lease, holder. ARGV: item, annotator, new deadline. Only the holder moves the deadline.
const std::string kRenewLua = R"lua(
if redis.call('HGET', KEYS[2], ARGV[1]) ~= ARGV[2] then return 0 end
redis.call('ZADD', KEYS[1], ARGV[3], ARGV[1])
return 1
)lua";

// An item handed to an annotator and the moment (ms) it returns to the pool.
struct Lease {
  std::string item_id;
  long long leased_until_ms = 0;
};

long long nowMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

long long leaseDeadline() { return nowMs() + std::chrono::duration_cast<std::chrono::milliseconds>(kLeaseTtl).count(); }

std::string poolKey(const std::string& task_id) { return "pool:" + task_id; }
std::string leaseKey(const std::string& task_id) { return "lease:" + task_id; }
std::string holderKey(const std::string& task_id) { return "holder:" + task_id; }

// Hand the next waiting item to annotator under a lease, or none when the pool is empty.
std::optional<Lease> claim(const std::string& task_id, const std::string& annotator) {
  const long long now = nowMs();
  const long long deadline = leaseDeadline();
  const auto item = redis.eval<std::string>(kClaimLua, {poolKey(task_id), leaseKey(task_id), holderKey(task_id)},
                                            {std::to_string(now), std::to_string(deadline), annotator});
  if (!item) return std::nullopt;
  return Lease{*item, deadline};
}

// Extend the lease on item_id: the new deadline, or 0 when annotator does not hold it.
long long renew(const std::string& task_id, const std::string& item_id, const std::string& annotator) {
  const long long deadline = leaseDeadline();
  const long long moved = redis.eval<long long>(kRenewLua, {leaseKey(task_id), holderKey(task_id)}, {item_id, annotator, std::to_string(deadline)});
  return moved == 1 ? deadline : 0;
}

// Return the items of expired leases to the pool; how many. The sweeper calls it every minute.
long long reclaimExpired(const std::string& task_id) {
  return redis.eval<long long>(kReclaimLua, {poolKey(task_id), leaseKey(task_id), holderKey(task_id)}, {std::to_string(nowMs())});
}
`,
    },
  },
  harness: {
    python: `from labeling import store

TTL_MS = 900_000


def _task(items=("a cat", "a dog")):
    return store.create_task("t1", "2026-10", 1, list(items))["task_id"]


def _now(ctx):
    return int(ctx.clock.time() * 1000)


def check_lease_ttl(ctx):
    m = ctx.load("state")
    task_id = _task()
    lease = m.claim(task_id, "ana")
    assert lease is not None and lease.get("item_id") == "i-1", f"the first claim on a fresh pool returned {lease}, expected item i-1"
    want = _now(ctx) + TTL_MS
    got = lease["leased_until_ms"]
    assert got == want, f"the lease runs until {got}, {got - _now(ctx)} ms from now: expected now + 900 000 ms (LEASE_TTL_S = 900)"
    score = ctx.redis.zscore(f"lease:{task_id}", "i-1")
    assert score == want, f"lease:{task_id} scores i-1 at {score}, expected the deadline {want}"
    ctx.clock.advance(600)
    assert m.reclaim_expired(task_id) == 0, "ten minutes into a fifteen-minute lease nothing has expired, yet reclaim_expired found an expired lease"
    assert ctx.redis.hget(f"holder:{task_id}", "i-1") == "ana", "a live lease must stay with its holder"


def check_atomic_claim(ctx):
    m = ctx.load("state")
    task_id = _task()
    # Bo presses "next" while Ana's claim is between its first and second command on the pool.
    rival = ctx.redis_after(f"pool:{task_id}", lambda: m.claim(task_id, "bo"))
    mine = m.claim(task_id, "ana")
    assert rival.fired, f"claim never touched pool:{task_id}"
    if rival.error is not None:
        raise rival.error
    theirs = rival.result
    assert mine is not None and theirs is not None, f"two annotators claimed from a pool of two items and got {mine} and {theirs}"
    assert mine["item_id"] != theirs["item_id"], f"ana and bo were both handed {mine['item_id']}: a claim landing between another claim's read of the pool and its removal takes the same item. Pop and lease in one script"
    holders = ctx.redis.hgetall(f"holder:{task_id}")
    assert holders == {mine["item_id"]: "ana", theirs["item_id"]: "bo"}, f"holder:{task_id} is {holders}, expected each item with the annotator who got it"
    assert m.claim(task_id, "cy") is None, "with both items leased the pool is empty: claim must answer None"


def check_holder_only(ctx):
    m = ctx.load("state")
    task_id = _task()
    lease = m.claim(task_id, "ana")
    before = ctx.redis.zscore(f"lease:{task_id}", "i-1")
    ctx.clock.advance(60)
    stolen = m.renew(task_id, "i-1", "bo")
    assert stolen is None, f"bo renewed ana's lease on i-1 (renew answered {stolen}): only the holder may extend a lease"
    assert ctx.redis.zscore(f"lease:{task_id}", "i-1") == before, "bo's renew moved the deadline of ana's lease"
    assert ctx.redis.hget(f"holder:{task_id}", "i-1") == "ana", "bo's renew changed the holder of i-1"
    ghost = m.renew(task_id, "i-2", "bo")
    assert ghost is None and ctx.redis.zscore(f"lease:{task_id}", "i-2") is None, f"renewing i-2, which nobody holds, answered {ghost} and left lease score {ctx.redis.zscore(f'lease:{task_id}', 'i-2')}: a renew must not lease an item still in the pool"
    renewed = m.renew(task_id, "i-1", "ana")
    assert renewed is not None and renewed > lease["leased_until_ms"], f"ana's own renew answered {renewed}, expected a deadline later than {lease['leased_until_ms']}"
    assert ctx.redis.zscore(f"lease:{task_id}", "i-1") == renewed, "the renewed deadline must be the lease score"


def check_expired_return(ctx):
    m = ctx.load("state")
    task_id = _task(["a cat"])
    m.claim(task_id, "ana")
    ctx.clock.advance(901)  # ana closed the tab
    returned = m.reclaim_expired(task_id)
    assert returned == 1, f"reclaim_expired answered {returned} after ana's lease expired, expected 1"
    assert ctx.redis.zscore(f"pool:{task_id}", "i-1") is not None, f"the expired lease on i-1 was dropped but the item never went back to pool:{task_id}: abandoned work is lost"
    assert ctx.redis.hget(f"holder:{task_id}", "i-1") is None, "an expired lease must lose its holder"
    again = m.claim(task_id, "bo")
    assert again is not None and again["item_id"] == "i-1", f"after the sweeper ran bo's claim returned {again}, expected the returned item i-1"
    ctx.clock.advance(901)  # bo leaves too, and no sweeper runs
    third = m.claim(task_id, "cy")
    assert third is not None and third["item_id"] == "i-1", f"bo's lease expired and no sweeper ran: cy's claim returned {third}. A claim must return expired leases before it pops"
    assert ctx.redis.hget(f"holder:{task_id}", "i-1") == "cy", "i-1 must now be held by cy"
`,
    typescript: `const TTL_MS = 900_000;

function setup(ctx, items = ['a cat', 'a dog']) {
  const m = ctx.load('state');
  const store = ctx.load('/support/labeling/store.ts');
  return {m, task: store.createTask('t1', '2026-10', 1, items).then(t => t.task_id)};
}

const score = (ctx, key: string, member: string): number | null => {
  const s = ctx.redis.zscore(key, member);
  return s === null || s === undefined ? null : Number(s);
};

export async function check_lease_ttl(ctx) {
  const {m, task} = setup(ctx);
  const taskId = await task;
  const lease = await m.claim(taskId, 'ana');
  assert(lease !== null && lease.item_id === 'i-1', \`the first claim on a fresh pool returned \${JSON.stringify(lease)}, expected item i-1\`);
  const want = ctx.clock.now() + TTL_MS;
  assert.equal(lease.leased_until_ms, want, \`the lease runs until \${lease.leased_until_ms}, \${lease.leased_until_ms - ctx.clock.now()} ms from now: expected now + 900 000 ms (LEASE_TTL_S = 900)\`);
  assert.equal(score(ctx, \`lease:\${taskId}\`, 'i-1'), want, \`lease:\${taskId} must score i-1 at the deadline \${want}\`);
  ctx.clock.advance(600);
  assert.equal(await m.reclaimExpired(taskId), 0, 'ten minutes into a fifteen-minute lease nothing has expired, yet reclaimExpired found an expired lease');
  assert.equal(ctx.redis.hget(\`holder:\${taskId}\`, 'i-1'), 'ana', 'a live lease must stay with its holder');
}

export async function check_atomic_claim(ctx) {
  const {m, task} = setup(ctx);
  const taskId = await task;
  // Bo presses "next" while Ana's claim is between its first and second command on the pool.
  const rival = ctx.redisAfter(\`pool:\${taskId}\`, () => m.claim(taskId, 'bo'));
  const mine = await m.claim(taskId, 'ana');
  assert(rival.fired, \`claim never touched pool:\${taskId}\`);
  if (rival.error !== undefined) throw rival.error;
  const theirs = await rival.result;
  assert(mine !== null && theirs !== null, \`two annotators claimed from a pool of two items and got \${JSON.stringify(mine)} and \${JSON.stringify(theirs)}\`);
  assert.notEqual(mine.item_id, theirs.item_id, \`ana and bo were both handed \${mine.item_id}: a claim landing between another claim's read of the pool and its removal takes the same item. Pop and lease in one script\`);
  assert.deepEqual(ctx.redis.hgetall(\`holder:\${taskId}\`), {[mine.item_id]: 'ana', [theirs.item_id]: 'bo'}, 'each item must be held by the annotator who got it');
  assert.equal(await m.claim(taskId, 'cy'), null, 'with both items leased the pool is empty: claim must answer null');
}

export async function check_holder_only(ctx) {
  const {m, task} = setup(ctx);
  const taskId = await task;
  const lease = await m.claim(taskId, 'ana');
  const before = score(ctx, \`lease:\${taskId}\`, 'i-1');
  ctx.clock.advance(60);
  const stolen = await m.renew(taskId, 'i-1', 'bo');
  assert.equal(stolen, null, \`bo renewed ana's lease on i-1 (renew answered \${stolen}): only the holder may extend a lease\`);
  assert.equal(score(ctx, \`lease:\${taskId}\`, 'i-1'), before, "bo's renew moved the deadline of ana's lease");
  assert.equal(ctx.redis.hget(\`holder:\${taskId}\`, 'i-1'), 'ana', "bo's renew changed the holder of i-1");
  const ghost = await m.renew(taskId, 'i-2', 'bo');
  assert(ghost === null && score(ctx, \`lease:\${taskId}\`, 'i-2') === null, \`renewing i-2, which nobody holds, answered \${ghost}: a renew must not lease an item still in the pool\`);
  const renewed = await m.renew(taskId, 'i-1', 'ana');
  assert(renewed !== null && renewed > lease.leased_until_ms, \`ana's own renew answered \${renewed}, expected a deadline later than \${lease.leased_until_ms}\`);
  assert.equal(score(ctx, \`lease:\${taskId}\`, 'i-1'), renewed, 'the renewed deadline must be the lease score');
}

export async function check_expired_return(ctx) {
  const {m, task} = setup(ctx, ['a cat']);
  const taskId = await task;
  await m.claim(taskId, 'ana');
  ctx.clock.advance(901); // ana closed the tab
  const returned = await m.reclaimExpired(taskId);
  assert.equal(returned, 1, \`reclaimExpired answered \${returned} after ana's lease expired, expected 1\`);
  assert.notEqual(score(ctx, \`pool:\${taskId}\`, 'i-1'), null, \`the expired lease on i-1 was dropped but the item never went back to pool:\${taskId}: abandoned work is lost\`);
  assert.equal(ctx.redis.hget(\`holder:\${taskId}\`, 'i-1'), null, 'an expired lease must lose its holder');
  const again = await m.claim(taskId, 'bo');
  assert(again !== null && again.item_id === 'i-1', \`after the sweeper ran bo's claim returned \${JSON.stringify(again)}, expected the returned item i-1\`);
  ctx.clock.advance(901); // bo leaves too, and no sweeper runs
  const third = await m.claim(taskId, 'cy');
  assert(third !== null && third.item_id === 'i-1', \`bo's lease expired and no sweeper ran: cy's claim returned \${JSON.stringify(third)}. A claim must return expired leases before it pops\`);
  assert.equal(ctx.redis.hget(\`holder:\${taskId}\`, 'i-1'), 'cy', 'i-1 must now be held by cy');
}
`,
    go: `package main

import (
	"context"

	"labeling/store"

	"leetbuild/harness"
)

const ttlMs = 900_000

var stateBg = context.Background()

func poolTask(items ...string) string {
	if len(items) == 0 {
		items = []string{"a cat", "a dog"}
	}
	return store.CreateTask(stateBg, "t1", "2026-10", 1, items).TaskID
}

func mustClaim(ctx *harness.Ctx, taskID, annotator string) *Lease {
	lease, err := claim(stateBg, taskID, annotator)
	ctx.NoError(err, "claim(%s, %s) failed", taskID, annotator)
	return lease
}

func mustRenew(ctx *harness.Ctx, taskID, itemID, annotator string) int64 {
	deadline, err := renew(stateBg, taskID, itemID, annotator)
	ctx.NoError(err, "renew(%s, %s, %s) failed", taskID, itemID, annotator)
	return deadline
}

func mustReclaim(ctx *harness.Ctx, taskID string) int {
	n, err := reclaimExpired(stateBg, taskID)
	ctx.NoError(err, "reclaimExpired(%s) failed", taskID)
	return n
}

func holderOf(ctx *harness.Ctx, taskID, itemID string) string {
	h, _ := ctx.Redis.HGet("holder:"+taskID, itemID)
	return h
}

func CheckLeaseTtl(ctx *harness.Ctx) {
	taskID := poolTask()
	lease := mustClaim(ctx, taskID, "ana")
	ctx.Assert(lease != nil && lease.ItemID == "i-1", "the first claim on a fresh pool returned %+v, expected item i-1", lease)
	want := ctx.Clock.Now() + ttlMs
	ctx.Assert(lease.LeasedUntilMs == want, "the lease runs until %d, %d ms from now: expected now + 900 000 ms (leaseTTL = 15 minutes)", lease.LeasedUntilMs, lease.LeasedUntilMs-ctx.Clock.Now())
	score, _ := ctx.Redis.ZScore("lease:"+taskID, "i-1")
	ctx.Equal(int64(score), want, "lease:%s must score i-1 at the deadline", taskID)
	ctx.Clock.Advance(600)
	ctx.Equal(mustReclaim(ctx, taskID), 0, "ten minutes into a fifteen-minute lease nothing has expired; reclaimExpired")
	ctx.Equal(holderOf(ctx, taskID, "i-1"), "ana", "a live lease must stay with its holder")
}

func CheckAtomicClaim(ctx *harness.Ctx) {
	taskID := poolTask()
	// Bo presses "next" while Ana's claim is between its first and second command on the pool.
	rival := ctx.Redis.After("pool:"+taskID, func() any {
		lease, err := claim(stateBg, taskID, "bo")
		ctx.NoError(err, "bo's claim failed")
		return lease
	})
	mine := mustClaim(ctx, taskID, "ana")
	ctx.Assert(rival.Fired, "claim never touched pool:%s", taskID)
	ctx.Assert(rival.Err == nil, "bo's claim failed: %v", rival.Err)
	theirs, _ := rival.Result.(*Lease)
	ctx.Assert(mine != nil && theirs != nil, "two annotators claimed from a pool of two items and got %+v and %+v", mine, theirs)
	ctx.Assert(mine.ItemID != theirs.ItemID, "ana and bo were both handed %s: a claim landing between another claim's read of the pool and its removal takes the same item. Pop and lease in one script", mine.ItemID)
	ctx.Equal(ctx.Redis.HGetAll("holder:"+taskID), map[string]string{mine.ItemID: "ana", theirs.ItemID: "bo"}, "each item must be held by the annotator who got it; holder:%s", taskID)
	ctx.Assert(mustClaim(ctx, taskID, "cy") == nil, "with both items leased the pool is empty: claim must answer nil")
}

func CheckHolderOnly(ctx *harness.Ctx) {
	taskID := poolTask()
	lease := mustClaim(ctx, taskID, "ana")
	before, _ := ctx.Redis.ZScore("lease:"+taskID, "i-1")
	ctx.Clock.Advance(60)
	stolen := mustRenew(ctx, taskID, "i-1", "bo")
	ctx.Equal(stolen, int64(0), "bo renewed ana's lease on i-1: only the holder may extend a lease; renew's answer")
	after, _ := ctx.Redis.ZScore("lease:"+taskID, "i-1")
	ctx.Equal(after, before, "bo's renew moved the deadline of ana's lease")
	ctx.Equal(holderOf(ctx, taskID, "i-1"), "ana", "bo's renew changed the holder of i-1")
	ghost := mustRenew(ctx, taskID, "i-2", "bo")
	_, leased := ctx.Redis.ZScore("lease:"+taskID, "i-2")
	ctx.Assert(ghost == 0 && !leased, "renewing i-2, which nobody holds, answered %d: a renew must not lease an item still in the pool", ghost)
	renewed := mustRenew(ctx, taskID, "i-1", "ana")
	ctx.Assert(renewed > lease.LeasedUntilMs, "ana's own renew answered %d, expected a deadline later than %d", renewed, lease.LeasedUntilMs)
	score, _ := ctx.Redis.ZScore("lease:"+taskID, "i-1")
	ctx.Equal(int64(score), renewed, "the renewed deadline must be the lease score")
}

func CheckExpiredReturn(ctx *harness.Ctx) {
	taskID := poolTask("a cat")
	mustClaim(ctx, taskID, "ana")
	ctx.Clock.Advance(901) // ana closed the tab
	ctx.Equal(mustReclaim(ctx, taskID), 1, "after ana's lease expired, reclaimExpired")
	_, inPool := ctx.Redis.ZScore("pool:"+taskID, "i-1")
	ctx.Assert(inPool, "the expired lease on i-1 was dropped but the item never went back to pool:%s: abandoned work is lost", taskID)
	ctx.Equal(holderOf(ctx, taskID, "i-1"), "", "an expired lease must lose its holder")
	again := mustClaim(ctx, taskID, "bo")
	ctx.Assert(again != nil && again.ItemID == "i-1", "after the sweeper ran bo's claim returned %+v, expected the returned item i-1", again)
	ctx.Clock.Advance(901) // bo leaves too, and no sweeper runs
	third := mustClaim(ctx, taskID, "cy")
	ctx.Assert(third != nil && third.ItemID == "i-1", "bo's lease expired and no sweeper ran: cy's claim returned %+v. A claim must return expired leases before it pops", third)
	ctx.Equal(holderOf(ctx, taskID, "i-1"), "cy", "i-1 must now be held by cy")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <map>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "labeling/store.h"

namespace {

constexpr long long kTtlMs = 900000;

std::string poolTask(const std::vector<std::string>& items = {"a cat", "a dog"}) {
  return store::createTask("t1", "2026-10", 1, items).task_id;
}

std::string holderOf(harness::Ctx& ctx, const std::string& task_id, const std::string& item_id) {
  return ctx.Redis.HGet("holder:" + task_id, item_id).value_or("");
}

}  // namespace

void CheckLeaseTtl(harness::Ctx& ctx) {
  const std::string task_id = poolTask();
  const auto lease = claim(task_id, "ana");
  ctx.Assert(lease && lease->item_id == "i-1", "the first claim on a fresh pool returned %q, expected item i-1", lease ? lease->item_id : "nothing");
  const long long want = ctx.Clock.Now() + kTtlMs;
  ctx.Assert(lease->leased_until_ms == want, "the lease runs until %d, %d ms from now: expected now + 900 000 ms (kLeaseTtl = 900 s)", lease->leased_until_ms, lease->leased_until_ms - ctx.Clock.Now());
  ctx.Equal(static_cast<long long>(ctx.Redis.ZScore("lease:" + task_id, "i-1").value_or(0)), want, "lease:%s must score i-1 at the deadline", task_id);
  ctx.Clock.Advance(600);
  ctx.Equal(reclaimExpired(task_id), 0LL, "ten minutes into a fifteen-minute lease nothing has expired; reclaimExpired");
  ctx.Equal(holderOf(ctx, task_id, "i-1"), "ana", "a live lease must stay with its holder");
}

void CheckAtomicClaim(harness::Ctx& ctx) {
  const std::string task_id = poolTask();
  // Bo presses "next" while Ana's claim is between its first and second command on the pool.
  auto fired = std::make_shared<bool>(false);
  auto theirs = std::make_shared<std::optional<Lease>>();
  auto error = std::make_shared<std::string>();
  ctx.Redis.After("pool:" + task_id, [=] {
    *fired = true;
    try {
      *theirs = claim(task_id, "bo");
    } catch (const std::exception& e) {
      *error = e.what();
    }
  });
  const auto mine = claim(task_id, "ana");
  ctx.Assert(*fired, "claim never touched pool:%s", task_id);
  ctx.Assert(error->empty(), "bo's claim failed: %s", *error);
  ctx.Assert(mine && theirs->has_value(), "two annotators claimed from a pool of two items and got %q and %q", mine ? mine->item_id : "nothing", theirs->has_value() ? (*theirs)->item_id : "nothing");
  ctx.Assert(mine->item_id != (*theirs)->item_id, "ana and bo were both handed %s: a claim landing between another claim's read of the pool and its removal takes the same item. Pop and lease in one script", mine->item_id);
  const std::map<std::string, std::string> want = {{mine->item_id, "ana"}, {(*theirs)->item_id, "bo"}};
  ctx.Equal(ctx.Redis.HGetAll("holder:" + task_id), want, "each item must be held by the annotator who got it; holder:%s", task_id);
  ctx.Assert(!claim(task_id, "cy"), "with both items leased the pool is empty: claim must answer nothing");
}

void CheckHolderOnly(harness::Ctx& ctx) {
  const std::string task_id = poolTask();
  const auto lease = claim(task_id, "ana");
  const auto before = ctx.Redis.ZScore("lease:" + task_id, "i-1");
  ctx.Clock.Advance(60);
  const long long stolen = renew(task_id, "i-1", "bo");
  ctx.Equal(stolen, 0LL, "bo renewed ana's lease on i-1: only the holder may extend a lease; renew's answer");
  ctx.Equal(ctx.Redis.ZScore("lease:" + task_id, "i-1"), before, "bo's renew moved the deadline of ana's lease");
  ctx.Equal(holderOf(ctx, task_id, "i-1"), "ana", "bo's renew changed the holder of i-1");
  const long long ghost = renew(task_id, "i-2", "bo");
  ctx.Assert(ghost == 0 && !ctx.Redis.ZScore("lease:" + task_id, "i-2"), "renewing i-2, which nobody holds, answered %d: a renew must not lease an item still in the pool", ghost);
  const long long renewed = renew(task_id, "i-1", "ana");
  ctx.Assert(renewed > lease->leased_until_ms, "ana's own renew answered %d, expected a deadline later than %d", renewed, lease->leased_until_ms);
  ctx.Equal(static_cast<long long>(ctx.Redis.ZScore("lease:" + task_id, "i-1").value_or(0)), renewed, "the renewed deadline must be the lease score");
}

void CheckExpiredReturn(harness::Ctx& ctx) {
  const std::string task_id = poolTask({"a cat"});
  claim(task_id, "ana");
  ctx.Clock.Advance(901);  // ana closed the tab
  ctx.Equal(reclaimExpired(task_id), 1LL, "after ana's lease expired, reclaimExpired");
  ctx.Assert(ctx.Redis.ZScore("pool:" + task_id, "i-1").has_value(), "the expired lease on i-1 was dropped but the item never went back to pool:%s: abandoned work is lost", task_id);
  ctx.Equal(holderOf(ctx, task_id, "i-1"), "", "an expired lease must lose its holder");
  const auto again = claim(task_id, "bo");
  ctx.Assert(again && again->item_id == "i-1", "after the sweeper ran bo's claim returned %q, expected the returned item i-1", again ? again->item_id : "nothing");
  ctx.Clock.Advance(901);  // bo leaves too, and no sweeper runs
  const auto third = claim(task_id, "cy");
  ctx.Assert(third && third->item_id == "i-1", "bo's lease expired and no sweeper ran: cy's claim returned %q. A claim must return expired leases before it pops", third ? third->item_id : "nothing");
  ctx.Equal(holderOf(ctx, task_id, "i-1"), "cy", "i-1 must now be held by cy");
}
`,
  },
  hints: [
    'Claim an item and check the lease a second later: it has already lapsed. Two annotators pressing "next" together open the same item, and an item whose lease expired is not in the pool any more.',
    '`LEASE_TTL_MS = 900` is seconds added to a millisecond clock. `ZRANGE` then `ZREM` are two commands another claim can land between; `renew` writes for anyone; the reclaim drops the lease but never re-adds the item.',
    'One Lua claim script: move expired leases back (`ZREM` lease, `HDEL` holder, `ZADD` pool 0), `ZPOPMIN`, `ZADD` lease at now + 900 000, `HSET` holder. Renew: `HGET` holder must equal the caller. Reclaim runs the same loop.',
  ],
  debrief: `The lease is the queue's memory of who is working on what, so every change to it has to happen where no other claim can interleave: inside one script that reclaims, pops, leases and records the holder. Running the reclaim inside the claim means abandoned work comes back even when the sweeper is late, and the sweeper only keeps the pool honest between claims. The holder check belongs in the same script as the deadline write for the same reason the pop does. Production queues also cap how many items one annotator may hold, count how often an item has expired so a poisoned one goes to review instead of cycling forever, and let an annotator release an item explicitly when they skip it.`,
};
