import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis queue claims with lease expiry',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis', 'console'],
  task: `## Task

The starter is a plausible model-generated draft: a moderator asks for work and gets an item, so the
demo passes. The claim hides a race, a stranded item and two counters that move apart. Find them,
fix them, and prove the fix.

Implement the queue that hands reported items to moderators:

- Items wait in a pending sorted set; a claim pops one **and** records the holder in the same
  atomic Lua \`EVAL\`. A client-side \`ZPOPMIN\` followed by a separate write leaves a window where
  the item is in neither the queue nor anyone's hands, and two moderators can pop and both think
  they own it.
- A claim takes a **10-minute lease** (\`LEASE_S = 600\`): the lease deadline is written next to the
  item and the holder's session key carries the same \`EXPIRE\`, so a moderator who walks away does
  not hold the item forever.
- The lease is **renewed while the session is active**: \`renew(item, moderator)\` extends the
  deadline and re-\`EXPIRE\`s the session key, and it **refuses** when another moderator owns the
  item.
- \`pending\` and \`in_review\` are two fields of one counters hash, moved by \`HINCRBY\` **inside the
  same script**. The draft moves them with two separate client calls, so a crash between them
  leaves the queue length wrong forever.
- \`requeue_expired(now)\` scans the leases sorted set for deadlines in the past and puts those items
  back in the pending set, clearing the owner — an abandoned claim returns to the queue instead of
  being stranded.

**Failure mode the checks target.** Claim without a lease strands an item when the reviewer
disappears; two counters updated apart drift from reality; and a pop outside a script is a race, not
a claim. The draft fails all three because the demo never crashes and never has two moderators.`,
  sequence: {
    participants: ['Moderator console', 'Redis', 'Moderation API'],
    messages: [
      {from: 'Moderator console', to: 'Redis', label: 'EVAL claim · ZPOPMIN moderation:pending', kind: 'sync'},
      {from: 'Redis', to: 'Moderator console', label: 'item · lease 600 s', kind: 'reply'},
      {from: 'Moderator console', to: 'Redis', label: 'EVAL renew · ZADD leases · EXPIRE session', kind: 'sync'},
      {from: 'Redis', to: 'Moderator console', label: '1 renewed · 0 someone else holds it', kind: 'reply'},
      {from: 'Moderation API', to: 'Redis', label: 'EVAL requeue · ZRANGEBYSCORE leases -inf now', kind: 'sync'},
      {from: 'Redis', to: 'Moderation API', label: 'item back in moderation:pending', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'claim-atomic',
      title: 'Claims with one atomic Lua script',
      detail:
        'The pop, the lease write and the holder record happen inside one `EVAL`/`NewScript`. A client-side `ZPOPMIN` followed by a separate write races: two moderators can both take the same item, or the item can end up in neither the queue nor anyone’s hands.',
      match: {
        python: {all: [/CLAIM_LUA/, /\.eval\(/, /ZPOPMIN/, /HSET/]},
        typescript: {all: [/CLAIM_LUA/, /\.eval\(/, /ZPOPMIN/, /HSET/]},
        go: {all: [/(claimScript|NewScript)/, /\.Run\(/, /ZPOPMIN/, /HSET/]},
        scala: {all: [/ClaimLua/, /\.eval\(/, /ZPOPMIN/, /HSET/]},
        cpp: {all: [/kClaimLua/, /\.eval/, /ZPOPMIN/, /HSET/]},
      },
    },
    {
      id: 'lease-expiry',
      title: 'A claim carries a lease that can expire',
      detail:
        'The claim writes a **600-second** lease deadline and an `EXPIRE` on the holder’s session key, so an abandoned claim is reclaimable. The draft marks the item in-review with no lease at all, so a crashed moderator strands it forever.',
      match: {
        python: {all: [/LEASE_S/, /EXPIRE/]},
        typescript: {all: [/LEASE_S/, /EXPIRE/]},
        go: {all: [/leaseS/, /EXPIRE/]},
        scala: {all: [/LeaseS/, /EXPIRE/]},
        cpp: {all: [/kLeaseS/, /EXPIRE/]},
      },
    },
    {
      id: 'renew-lease',
      title: 'Renews the lease while the session is active',
      detail:
        '`renew(item, moderator)` extends the deadline and re-`EXPIRE`s the session key, and it refuses when the item is held by someone else. Without it a long review silently loses its claim mid-session.',
      match: {
        python: {all: [/def renew\(/, /EXPIRE/]},
        typescript: {all: [/function renew\(|const renew =/, /EXPIRE/]},
        go: {all: [/func renew\(/, /EXPIRE/]},
        scala: {all: [/def renew\(/, /EXPIRE/]},
        cpp: {all: [/renew\(/, /EXPIRE/]},
      },
    },
    {
      id: 'counters-atomic',
      title: 'Moves pending and in-review in one script',
      detail:
        '`pending` and `in_review` are fields of one counters hash updated by `HINCRBY` inside the claim script. The draft decrements one counter and increments the other in two separate calls, so a crash between them corrupts the queue metrics.',
      match: {
        python: {all: [/HINCRBY/, /pending/, /in_review/]},
        typescript: {all: [/HINCRBY/, /pending/, /in_review/]},
        go: {all: [/HINCRBY/, /pending/, /in_review/]},
        scala: {all: [/HINCRBY/, /pending/, /in_review/]},
        cpp: {all: [/HINCRBY/, /pending/, /in_review/]},
      },
    },
    {
      id: 'requeue-expired',
      title: 'Returns expired claims to the queue',
      detail:
        '`requeueExpired(now)` scans the leases for deadlines in the past and `ZADD`s those items back into the pending set. Without it a dead moderator’s item is invisible to every other reviewer.',
      match: {
        python: {all: [/requeue_expired\(/, /ZADD/]},
        typescript: {all: [/requeueExpired\(/, /ZADD/]},
        go: {all: [/requeueExpired\(/, /ZADD/]},
        scala: {all: [/requeueExpired\(/, /ZADD/]},
        cpp: {all: [/requeueExpired\(/, /ZADD/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

QUEUE = "moderation:pending"
ACTIVE = "moderation:active"
COUNTERS = "moderation:counters"


def claim(moderator: str) -> str | None:
    # TODO: this draft pops an item and marks it in-review with no lease, so a crashed moderator
    # strands it forever, and it moves the pending and in-review counters in two separate calls.
    popped = r.zpopmin(QUEUE, 1)
    if not popped:
        return None
    item = popped[0][0]
    r.hset(ACTIVE, item, moderator)
    r.hincrby(COUNTERS, "in_review", 1)
    r.hincrby(COUNTERS, "pending", -1)
    return item
`,
      solution: `import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

QUEUE = "moderation:pending"
LEASES = "moderation:leases"
OWNERS = "moderation:owners"
COUNTERS = "moderation:counters"
SESSION_PREFIX = "moderation:session:"
LEASE_S = 600

CLAIM_LUA = """
local popped = redis.call('ZPOPMIN', KEYS[1])
if #popped == 0 then
  return {}
end
local item = popped[1]
redis.call('ZADD', KEYS[2], ARGV[1], item)
redis.call('HSET', KEYS[3], item, ARGV[2])
redis.call('HINCRBY', KEYS[4], 'pending', -1)
redis.call('HINCRBY', KEYS[4], 'in_review', 1)
return {item}
"""

RENEW_LUA = """
if redis.call('HGET', KEYS[2], ARGV[2]) ~= ARGV[3] then
  return 0
end
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
redis.call('SET', KEYS[3], ARGV[2])
redis.call('EXPIRE', KEYS[3], ARGV[4])
return 1
"""

REQUEUE_LUA = """
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
for _, item in ipairs(expired) do
  redis.call('ZREM', KEYS[1], item)
  redis.call('HDEL', KEYS[2], item)
  redis.call('ZADD', KEYS[3], ARGV[1], item)
  redis.call('HINCRBY', KEYS[4], 'in_review', -1)
  redis.call('HINCRBY', KEYS[4], 'pending', 1)
end
return #expired
"""


def session_key(moderator: str) -> str:
    return f"{SESSION_PREFIX}{moderator}"


def claim(moderator: str) -> str | None:
    deadline = int(time.time()) + LEASE_S
    popped = r.eval(CLAIM_LUA, 4, QUEUE, LEASES, OWNERS, COUNTERS, deadline, moderator)
    if not popped:
        return None
    return popped[0]


def renew(item: str, moderator: str) -> bool:
    deadline = int(time.time()) + LEASE_S
    ok = r.eval(RENEW_LUA, 3, LEASES, OWNERS, session_key(moderator), deadline, item, moderator, LEASE_S)
    return bool(ok)


def requeue_expired(now: int | None = None) -> int:
    cutoff = int(time.time()) if now is None else now
    return int(r.eval(REQUEUE_LUA, 4, LEASES, OWNERS, QUEUE, COUNTERS, cutoff))
`,
    },
    typescript: {
      starter: `/** Moderation queue: a model-generated draft that claims without a lease. */
import {Redis} from 'ioredis';

export const r = new Redis('redis://redis:6379');

const QUEUE = 'moderation:pending';
const ACTIVE = 'moderation:active';
const COUNTERS = 'moderation:counters';

export async function claim(moderator: string): Promise<string | null> {
  // TODO: this draft pops an item and marks it in-review with no lease, so a crashed moderator
  // strands it forever, and it moves the pending and in-review counters in two separate calls.
  const popped = await r.zpopmin(QUEUE, 1);
  if (popped.length === 0) return null;
  const item = popped[0];
  await r.hset(ACTIVE, item, moderator);
  await r.hincrby(COUNTERS, 'in_review', 1);
  await r.hincrby(COUNTERS, 'pending', -1);
  return item;
}
`,
      solution: `/** Moderation queue: atomic claim, renewable lease, requeue of abandoned items. */
import {Redis} from 'ioredis';

export const r = new Redis('redis://redis:6379');

const QUEUE = 'moderation:pending';
const LEASES = 'moderation:leases';
const OWNERS = 'moderation:owners';
const COUNTERS = 'moderation:counters';
const SESSION_PREFIX = 'moderation:session:';
const LEASE_S = 600;

const CLAIM_LUA = \`
local popped = redis.call('ZPOPMIN', KEYS[1])
if #popped == 0 then
  return {}
end
local item = popped[1]
redis.call('ZADD', KEYS[2], ARGV[1], item)
redis.call('HSET', KEYS[3], item, ARGV[2])
redis.call('HINCRBY', KEYS[4], 'pending', -1)
redis.call('HINCRBY', KEYS[4], 'in_review', 1)
return {item}
\`;

const RENEW_LUA = \`
if redis.call('HGET', KEYS[2], ARGV[2]) ~= ARGV[3] then
  return 0
end
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
redis.call('SET', KEYS[3], ARGV[2])
redis.call('EXPIRE', KEYS[3], ARGV[4])
return 1
\`;

const REQUEUE_LUA = \`
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
for _, item in ipairs(expired) do
  redis.call('ZREM', KEYS[1], item)
  redis.call('HDEL', KEYS[2], item)
  redis.call('ZADD', KEYS[3], ARGV[1], item)
  redis.call('HINCRBY', KEYS[4], 'in_review', -1)
  redis.call('HINCRBY', KEYS[4], 'pending', 1)
end
return #expired
\`;

const sessionKey = (moderator: string): string => \`\${SESSION_PREFIX}\${moderator}\`;

export async function claim(moderator: string): Promise<string | null> {
  const deadline = Math.floor(Date.now() / 1000) + LEASE_S;
  const popped = (await r.eval(CLAIM_LUA, 4, QUEUE, LEASES, OWNERS, COUNTERS, deadline, moderator)) as string[];
  return popped.length === 0 ? null : popped[0];
}

export async function renew(item: string, moderator: string): Promise<boolean> {
  const deadline = Math.floor(Date.now() / 1000) + LEASE_S;
  const ok = await r.eval(RENEW_LUA, 3, LEASES, OWNERS, sessionKey(moderator), deadline, item, moderator, LEASE_S);
  return Number(ok) === 1;
}

export async function requeueExpired(now = Math.floor(Date.now() / 1000)): Promise<number> {
  return Number(await r.eval(REQUEUE_LUA, 4, LEASES, OWNERS, QUEUE, COUNTERS, now));
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

const (
	queueKey    = "moderation:pending"
	activeKey   = "moderation:active"
	countersKey = "moderation:counters"
)

func claim(ctx context.Context, rdb *redis.Client, moderator string) (string, error) {
	// TODO: this draft pops an item and marks it in-review with no lease, so a crashed moderator
	// strands it forever, and it moves the pending and in-review counters in two separate calls.
	popped, err := rdb.ZPopMin(ctx, queueKey, 1).Result()
	if err != nil || len(popped) == 0 {
		return "", err
	}
	item := popped[0].Member.(string)
	rdb.HSet(ctx, activeKey, item, moderator)
	rdb.HIncrBy(ctx, countersKey, "in_review", 1)
	rdb.HIncrBy(ctx, countersKey, "pending", -1)
	_ = time.Now()
	return item, nil
}
`,
      solution: `package main

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	queueKey      = "moderation:pending"
	leasesKey     = "moderation:leases"
	ownersKey     = "moderation:owners"
	countersKey   = "moderation:counters"
	sessionPrefix = "moderation:session:"
	leaseS        = 600
)

var claimScript = redis.NewScript(\`
local popped = redis.call('ZPOPMIN', KEYS[1])
if #popped == 0 then
  return {}
end
local item = popped[1]
redis.call('ZADD', KEYS[2], ARGV[1], item)
redis.call('HSET', KEYS[3], item, ARGV[2])
redis.call('HINCRBY', KEYS[4], 'pending', -1)
redis.call('HINCRBY', KEYS[4], 'in_review', 1)
return {item}
\`)

var renewScript = redis.NewScript(\`
if redis.call('HGET', KEYS[2], ARGV[2]) ~= ARGV[3] then
  return 0
end
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
redis.call('SET', KEYS[3], ARGV[2])
redis.call('EXPIRE', KEYS[3], ARGV[4])
return 1
\`)

var requeueScript = redis.NewScript(\`
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
for _, item in ipairs(expired) do
  redis.call('ZREM', KEYS[1], item)
  redis.call('HDEL', KEYS[2], item)
  redis.call('ZADD', KEYS[3], ARGV[1], item)
  redis.call('HINCRBY', KEYS[4], 'in_review', -1)
  redis.call('HINCRBY', KEYS[4], 'pending', 1)
end
return #expired
\`)

func claim(ctx context.Context, rdb *redis.Client, moderator string) (string, error) {
	deadline := time.Now().Unix() + leaseS
	out, err := claimScript.Run(ctx, rdb, []string{queueKey, leasesKey, ownersKey, countersKey},
		deadline, moderator).Slice()
	if err != nil || len(out) == 0 {
		return "", err
	}
	return out[0].(string), nil
}

func renew(ctx context.Context, rdb *redis.Client, item, moderator string) (bool, error) {
	deadline := time.Now().Unix() + leaseS
	ok, err := renewScript.Run(ctx, rdb,
		[]string{leasesKey, ownersKey, sessionPrefix + moderator},
		deadline, item, moderator, leaseS).Int()
	if err != nil {
		return false, err
	}
	return ok == 1, nil
}

func requeueExpired(ctx context.Context, rdb *redis.Client, now int64) (int64, error) {
	return requeueScript.Run(ctx, rdb, []string{leasesKey, ownersKey, queueKey, countersKey}, now).Int64()
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.Jedis

object ModerationQueue {
  val QueueKey = "moderation:pending"
  val ActiveKey = "moderation:active"
  val CountersKey = "moderation:counters"

  val redis = new Jedis("redis", 6379)

  def claim(moderator: String): Option[String] = {
    // TODO: this draft pops an item and marks it in-review with no lease, so a crashed moderator
    // strands it forever, and it moves the pending and in-review counters in two separate calls.
    val popped = redis.zpopmin(QueueKey)
    if (popped == null) None
    else {
      val item = popped.getElement
      redis.hset(ActiveKey, item, moderator)
      redis.hincrBy(CountersKey, "in_review", 1)
      redis.hincrBy(CountersKey, "pending", -1)
      Some(item)
    }
  }
}
`,
      solution: `import redis.clients.jedis.Jedis

object ModerationQueue {
  val QueueKey = "moderation:pending"
  val LeasesKey = "moderation:leases"
  val OwnersKey = "moderation:owners"
  val CountersKey = "moderation:counters"
  val SessionPrefix = "moderation:session:"
  val LeaseS = 600

  val ClaimLua =
    """
local popped = redis.call('ZPOPMIN', KEYS[1])
if #popped == 0 then
  return {}
end
local item = popped[1]
redis.call('ZADD', KEYS[2], ARGV[1], item)
redis.call('HSET', KEYS[3], item, ARGV[2])
redis.call('HINCRBY', KEYS[4], 'pending', -1)
redis.call('HINCRBY', KEYS[4], 'in_review', 1)
return {item}
"""

  val RenewLua =
    """
if redis.call('HGET', KEYS[2], ARGV[2]) ~= ARGV[3] then
  return 0
end
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
redis.call('SET', KEYS[3], ARGV[2])
redis.call('EXPIRE', KEYS[3], ARGV[4])
return 1
"""

  val RequeueLua =
    """
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
for _, item in ipairs(expired) do
  redis.call('ZREM', KEYS[1], item)
  redis.call('HDEL', KEYS[2], item)
  redis.call('ZADD', KEYS[3], ARGV[1], item)
  redis.call('HINCRBY', KEYS[4], 'in_review', -1)
  redis.call('HINCRBY', KEYS[4], 'pending', 1)
end
return #expired
"""

  val redis = new Jedis("redis", 6379)

  def claim(moderator: String): Option[String] = {
    val deadline = System.currentTimeMillis() / 1000 + LeaseS
    val out = redis.eval(
      ClaimLua,
      java.util.List.of(QueueKey, LeasesKey, OwnersKey, CountersKey),
      java.util.List.of(deadline.toString, moderator)
    )
    out.asInstanceOf[java.util.List[String]].size() match {
      case 0 => None
      case _ => Some(out.asInstanceOf[java.util.List[String]].get(0))
    }
  }

  def renew(item: String, moderator: String): Boolean = {
    val deadline = System.currentTimeMillis() / 1000 + LeaseS
    val ok = redis.eval(
      RenewLua,
      java.util.List.of(LeasesKey, OwnersKey, SessionPrefix + moderator),
      java.util.List.of(deadline.toString, item, moderator, LeaseS.toString)
    )
    ok.asInstanceOf[java.lang.Long].longValue() == 1L
  }

  def requeueExpired(now: Long): Long = {
    val out = redis.eval(
      RequeueLua,
      java.util.List.of(LeasesKey, OwnersKey, QueueKey, CountersKey),
      java.util.List.of(now.toString)
    )
    out.asInstanceOf[java.lang.Long].longValue()
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <iostream>
#include <string>

const std::string kQueueKey = "moderation:pending";
const std::string kActiveKey = "moderation:active";
const std::string kCountersKey = "moderation:counters";

std::optional<std::string> claim(sw::redis::Redis& redis, const std::string& moderator) {
  // TODO: this draft pops an item and marks it in-review with no lease, so a crashed moderator
  // strands it forever, and it moves the pending and in-review counters in two separate calls.
  auto popped = redis.zpopmin(kQueueKey);
  if (!popped) return std::nullopt;
  const auto item = popped->first;
  redis.hset(kActiveKey, item, moderator);
  redis.hincrby(kCountersKey, "in_review", 1);
  redis.hincrby(kCountersKey, "pending", -1);
  return item;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <iostream>
#include <optional>
#include <string>
#include <vector>

const std::string kQueueKey = "moderation:pending";
const std::string kLeasesKey = "moderation:leases";
const std::string kOwnersKey = "moderation:owners";
const std::string kCountersKey = "moderation:counters";
const std::string kSessionPrefix = "moderation:session:";
constexpr int kLeaseS = 600;

const std::string kClaimLua = R"lua(
local popped = redis.call('ZPOPMIN', KEYS[1])
if #popped == 0 then
  return {}
end
local item = popped[1]
redis.call('ZADD', KEYS[2], ARGV[1], item)
redis.call('HSET', KEYS[3], item, ARGV[2])
redis.call('HINCRBY', KEYS[4], 'pending', -1)
redis.call('HINCRBY', KEYS[4], 'in_review', 1)
return {item}
)lua";

const std::string kRenewLua = R"lua(
if redis.call('HGET', KEYS[2], ARGV[2]) ~= ARGV[3] then
  return 0
end
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
redis.call('SET', KEYS[3], ARGV[2])
redis.call('EXPIRE', KEYS[3], ARGV[4])
return 1
)lua";

const std::string kRequeueLua = R"lua(
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
for _, item in ipairs(expired) do
  redis.call('ZREM', KEYS[1], item)
  redis.call('HDEL', KEYS[2], item)
  redis.call('ZADD', KEYS[3], ARGV[1], item)
  redis.call('HINCRBY', KEYS[4], 'in_review', -1)
  redis.call('HINCRBY', KEYS[4], 'pending', 1)
end
return #expired
)lua";

long nowSeconds() { return std::chrono::system_clock::now().time_since_epoch().count() / 1000000000; }

std::optional<std::string> claim(sw::redis::Redis& redis, const std::string& moderator) {
  const auto deadline = std::to_string(nowSeconds() + kLeaseS);
  auto out = redis.eval<std::vector<std::string>>(kClaimLua, {kQueueKey, kLeasesKey, kOwnersKey, kCountersKey},
                                                  {deadline, moderator});
  if (out.empty()) return std::nullopt;
  return out.front();
}

bool renew(sw::redis::Redis& redis, const std::string& item, const std::string& moderator) {
  const auto deadline = std::to_string(nowSeconds() + kLeaseS);
  auto ok = redis.eval<long long>(kRenewLua, {kLeasesKey, kOwnersKey, kSessionPrefix + moderator},
                                  {deadline, item, moderator, std::to_string(kLeaseS)});
  return ok == 1;
}

long long requeueExpired(sw::redis::Redis& redis, long long now) {
  return redis.eval<long long>(kRequeueLua, {kLeasesKey, kOwnersKey, kQueueKey, kCountersKey},
                               {std::to_string(now)});
}
`,
    },
  },
  hints: [
    'There is no safe way to pop and record in two round trips. Put `ZPOPMIN`, the lease `ZADD`, the owner `HSET` and both `HINCRBY`s in one Lua script: either a moderator walks away with the item and its lease, or the queue is untouched.',
    'A lease is two things: a deadline in a sorted set (so a reaper can find expired claims) and a session key with `EXPIRE` (so the holder record dies with the lease). Renewing re-`ZADD`s a later deadline and re-`EXPIRE`s the session, and it checks `HGET owners == moderator` first so it cannot steal someone else’s item.',
    'Atomicity applies to the counters too. `pending` and `in_review` are two fields of one hash: move them with `HINCRBY` inside the same script, so the queue never reports one item as both pending and in-review, or as neither.',
  ],
  debrief: `The interviewer is testing whether you can review a queue that is claimed, not just read. The draft looks fine because in the demo one moderator claims one item and finishes. Three defects are being checked: the claim must be one atomic script (a pop followed by a write is a race, and the "lost" item lives in neither the queue nor any moderator's hands), a claim needs a lease so an abandoned item returns to the queue rather than being stranded, and the two counters must move together so the queue's own metrics stay consistent. Real queues add a heartbeat thread that renews the lease, a reaper on a schedule, a per-moderator in-flight cap, and a WATCH-free design because Lua already gives them the atomicity they would otherwise build with optimistic locking.`,
};
