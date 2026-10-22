import type {Step} from '@/lib/types';

/**
 * Step 2 — the ballot. One feedback write per (tenant, user, request), reserved with a single
 * set-if-absent in Redis that carries its own 30-day expiry.
 */
export const stateStep: Step = {
  id: 'state',
  title: 'Redis dedupe so one user cannot stuff the ballot',
  concept: 'redis',
  file: 'state',
  focus: ['collector', 'redis'],
  sequence: {
    participants: ['Feedback Collector', 'Redis', 'feedback store'],
    messages: [
      {
        from: 'Feedback Collector',
        to: 'Feedback Collector',
        label: 'dedupeKey(tenant, user_id, request_id)',
        kind: 'sync',
      },
      {from: 'Feedback Collector', to: 'Redis', label: 'EVAL DEDUPE_SCRIPT 1 key 1 2592000', kind: 'sync'},
      {
        from: 'Redis',
        to: 'Feedback Collector',
        label: '1 — this caller claimed the slot, TTL set in the same step',
        kind: 'reply',
      },
      {
        from: 'Feedback Collector',
        to: 'feedback store',
        label: 'insert the feedback row (exactly once)',
        kind: 'async',
      },
      {from: 'Feedback Collector', to: 'Redis', label: 'EVAL again → 0 — the slot is already taken', kind: 'sync'},
      {from: 'Feedback Collector', to: 'Feedback Collector', label: 'answer duplicate, store nothing', kind: 'sync'},
    ],
  },
  task: `## Task

**Review premise.** You are the AI platform engineer on call. A double-clicked thumbs-up produced two
ratings on the same answer, a scripted client flipped a score from \`-1\` to \`1\` by posting twice, and
a support team found that "alice" on one tenant was blocking "alice" on another because the dedupe key
dropped the tenant. The model-generated module below checks membership and then adds in two separate
round trips, so two concurrent submits both read "not seen" and both write.

Review \`state\` and make the ballot reservation impossible to race, then make it prove the fix.

- The check and the add must be one atomic operation. Express it as a Lua script and run it with
  \`EVAL\` — a \`SISMEMBER\` read followed by an \`SADD\` write is the bug, not the fix.
- The dedupe key must be scoped by tenant, user and request id, so the same user id on two tenants
  cannot collide and one user cannot re-vote on the same request.
- The reservation must carry its own 30-day expiry. Set it with the set-if-absent (\`NX\` + \`EX\`) inside
  the script, so a crash between "add" and "expire" cannot leave an immortal key.
- The module must report whether *this* caller claimed the slot, so the caller writes exactly one row.
- A second submit for the same key must be answered as a duplicate without storing another rating.

**Failure mode the checks target.** A two-step "is it there? then add" lets concurrent duplicate submits
store two ratings, and a key without the tenant lets user ids from different tenants block each other.
The checks below require the one-script reservation, the tenant-scoped key, the atomic 30-day TTL, and a
claim result the caller can branch on.`,
  hints: [
    'Two commands are not one operation. Write the reservation as a Lua script that does the set-if-absent and the expiry together, and run it with `redis.eval` / `script.Run` in a single round trip.',
    'Build the key from all three parts — `feedback:dedupe:{tenant}:{user_id}:{request_id}` — so a user id means nothing without its tenant, and keep the key builder in its own named function so the scope is visible in review.',
    'The script should answer `1` when it claimed the slot and `0` when the slot was already taken. `SET key value NX EX 2592000` gives you both the atomicity and the 30-day TTL; `claim` should return that result so the endpoint stores a row only on `1`.',
  ],
  checks: [
    {
      id: 'lua-script',
      title: 'Check and add happen in one atomic script',
      detail:
        'Reserve the slot with a single Lua script run through `EVAL`, so two concurrent submits cannot both read "not seen" and both write.',
      match: {
        python: {all: [/DEDUPE_SCRIPT/, /\.eval\(/]},
        typescript: {all: [/DEDUPE_SCRIPT/, /\.eval\(/]},
        go: {all: [/dedupeScript/, /\.Run\(/]},
        scala: {all: [/DedupeScript/, /\.eval\(/]},
        cpp: {all: [/kDedupeScript/, /EVAL/]},
      },
    },
    {
      id: 'tenant-key',
      title: 'The dedupe key is scoped by tenant, user and request',
      detail:
        'Name the key `feedback:dedupe:{tenant}:{user_id}:{request_id}` so user ids cannot collide across tenants and one user cannot re-vote on the same request.',
      match: {
        python: {all: [/dedupe_key\(/, /\{tenant\}/]},
        typescript: {all: [/dedupeKey\(/, /\$\{tenant\}/]},
        go: {all: [/dedupeKey\(/, /\btenant\b/]},
        scala: {all: [/dedupeKey\(/, /\$tenant/]},
        cpp: {all: [/dedupeKey\(/, /\btenant\b/]},
      },
    },
    {
      id: 'ttl',
      title: 'The reservation carries a 30-day TTL set with the add',
      detail:
        'Set the expiry inside the same script that reserves the slot (`NX` + `EX` with `30 * 24 * 60 * 60` seconds), so the key can never outlive its window.',
      match: {
        python: {all: [/'NX'/, /'EX'/, /TTL_SECONDS/]},
        typescript: {all: [/'NX'/, /'EX'/, /TTL_SECONDS/]},
        go: {all: [/'NX'/, /'EX'/, /ttlSeconds/]},
        scala: {all: [/'NX'/, /'EX'/, /TtlSeconds/]},
        cpp: {all: [/'NX'/, /'EX'/, /kTtlSeconds/]},
      },
    },
    {
      id: 'no-two-step',
      title: 'The SISMEMBER-then-SADD draft is gone',
      detail:
        'A membership read followed by a separate add is exactly the race the fix removes; the reservation must come back from the one script instead of two commands.',
      match: {
        python: {all: [/redis\.eval\(/], none: [/sismember/i, /\bsadd\(/i]},
        typescript: {all: [/\.eval\(/], none: [/\bsismember\b/i, /\.sadd\(/]},
        go: {all: [/\.Run\(/], none: [/\bSIsMember\b/i, /\.SAdd\(/]},
        scala: {all: [/\.eval\(/], none: [/\bsismember\b/i, /\.sadd\(/]},
        cpp: {all: [/EVAL/], none: [/\bSISMEMBER\b/, /\bSADD\b/]},
      },
    },
    {
      id: 'claim-result',
      title: 'The module reports whether this caller claimed the slot',
      detail:
        'Return `true` only when the script claimed the slot, so the endpoint can write one row on a fresh ballot and refuse a duplicate without a second read.',
      match: {
        python: {all: [/def claim\(/, /return claimed\s*==\s*1/]},
        typescript: {all: [/claim\(tenant/, /return claimed\s*===\s*1/]},
        go: {all: [/func \(d \*Dedupe\) claim\(/, /return claimed\s*==\s*1/]},
        scala: {all: [/def claim\(/, /claimed\s*==\s*1/]},
        cpp: {all: [/claim\(/, /claimed\s*==\s*1/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

import redis as redis_client

logger = logging.getLogger("feedback")

TTL_SECONDS = 30 * 24 * 60 * 60
SEEN_KEY = "feedback:seen"


class Dedupe:
    """Keeps one feedback write per (tenant, user, request)."""

    def __init__(self, redis: "redis_client.Redis") -> None:
        self.redis = redis

    def is_duplicate(self, tenant: str, user_id: str, request_id: str) -> bool:
        # TODO: this draft checks membership and then adds in two round trips, so a double click
        # lands two ratings, and the key forgets the tenant so user ids collide across tenants.
        key = f"feedback:{user_id}:{request_id}"
        if self.redis.sismember(SEEN_KEY, key):
            return True
        self.redis.sadd(SEEN_KEY, key)
        self.redis.expire(SEEN_KEY, TTL_SECONDS)
        return False
`,
      solution: `import logging

import redis as redis_client

logger = logging.getLogger("feedback")

TTL_SECONDS = 30 * 24 * 60 * 60

# Set-if-absent with its expiry in one round trip: 1 when this caller claimed the slot, 0 when it
# was already taken. A separate SISMEMBER then SADD lets a double submit land two ratings.
DEDUPE_SCRIPT = """
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2]) then
  return 1
end
return 0
"""


def dedupe_key(tenant: str, user_id: str, request_id: str) -> str:
    return f"feedback:dedupe:{tenant}:{user_id}:{request_id}"


class Dedupe:
    """Keeps one feedback write per (tenant, user, request)."""

    def __init__(self, redis: "redis_client.Redis") -> None:
        self.redis = redis

    def claim(self, tenant: str, user_id: str, request_id: str) -> bool:
        key = dedupe_key(tenant, user_id, request_id)
        claimed = self.redis.eval(DEDUPE_SCRIPT, 1, key, "1", str(TTL_SECONDS))
        logger.info("dedupe tenant=%s request=%s claimed=%s", tenant, request_id, claimed)
        return claimed == 1
`,
    },
    typescript: {
      starter: `/** Redis dedupe for the feedback ballot. */
import Redis from 'ioredis';

const TTL_SECONDS = 30 * 24 * 60 * 60;
const SEEN_KEY = 'feedback:seen';

export class Dedupe {
  constructor(private readonly redis: Redis) {}

  async isDuplicate(tenant: string, userId: string, requestId: string): Promise<boolean> {
    // TODO: this draft checks membership and then adds in two round trips, so a double click
    // lands two ratings, and the key forgets the tenant so user ids collide across tenants.
    const key = \`feedback:\${userId}:\${requestId}\`;
    if (await this.redis.sismember(SEEN_KEY, key)) return true;
    await this.redis.sadd(SEEN_KEY, key);
    await this.redis.expire(SEEN_KEY, TTL_SECONDS);
    return false;
  }
}
`,
      solution: `/** Redis dedupe for the feedback ballot. */
import Redis from 'ioredis';

const TTL_SECONDS = 30 * 24 * 60 * 60;

// Set-if-absent with its expiry in one round trip: 1 when this caller claimed the slot, 0 when it
// was already taken. A separate SISMEMBER then SADD lets a double submit land two ratings.
const DEDUPE_SCRIPT = \`
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2]) then
  return 1
end
return 0
\`;

function dedupeKey(tenant: string, userId: string, requestId: string): string {
  return \`feedback:dedupe:\${tenant}:\${userId}:\${requestId}\`;
}

export class Dedupe {
  constructor(private readonly redis: Redis) {}

  async claim(tenant: string, userId: string, requestId: string): Promise<boolean> {
    const key = dedupeKey(tenant, userId, requestId);
    const claimed = (await this.redis.eval(DEDUPE_SCRIPT, 1, key, '1', String(TTL_SECONDS))) as number;
    return claimed === 1;
  }
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"github.com/redis/go-redis/v9"
)

const ttlSeconds = 30 * 24 * 60 * 60

const seenKey = "feedback:seen"

// Dedupe keeps one feedback write per (tenant, user, request).
type Dedupe struct {
	redis *redis.Client
}

func NewDedupe(client *redis.Client) *Dedupe {
	return &Dedupe{redis: client}
}

func (d *Dedupe) isDuplicate(ctx context.Context, tenant, userID, requestID string) bool {
	// TODO: this draft checks membership and then adds in two round trips, so a double click
	// lands two ratings, and the key forgets the tenant so user ids collide across tenants.
	key := "feedback:" + userID + ":" + requestID
	if d.redis.SIsMember(ctx, seenKey, key).Val() {
		return true
	}
	d.redis.SAdd(ctx, seenKey, key)
	d.redis.Expire(ctx, seenKey, ttlSeconds)
	return false
}
`,
      solution: `package main

import (
	"context"

	"github.com/redis/go-redis/v9"
)

const ttlSeconds = 30 * 24 * 60 * 60

// Set-if-absent with its expiry in one round trip: 1 when this caller claimed the slot, 0 when it
// was already taken. A separate SIsMember then SAdd lets a double submit land two ratings.
const dedupeScript = \`
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2]) then
  return 1
end
return 0
\`

func dedupeKey(tenant, userID, requestID string) string {
	return "feedback:dedupe:" + tenant + ":" + userID + ":" + requestID
}

// Dedupe keeps one feedback write per (tenant, user, request).
type Dedupe struct {
	redis  *redis.Client
	script *redis.Script
}

func NewDedupe(client *redis.Client) *Dedupe {
	return &Dedupe{redis: client, script: redis.NewScript(dedupeScript)}
}

func (d *Dedupe) claim(ctx context.Context, tenant, userID, requestID string) (bool, error) {
	key := dedupeKey(tenant, userID, requestID)
	claimed, err := d.script.Run(ctx, d.redis, []string{key}, "1", ttlSeconds).Int()
	if err != nil {
		return false, err
	}
	return claimed == 1, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.Jedis

object Dedupe {
  val TtlSeconds: Long = 30L * 24 * 60 * 60
  val SeenKey: String = "feedback:seen"

  def dedupeKey(userId: String, requestId: String): String =
    s"feedback:$userId:$requestId"
}

final class Dedupe(jedis: Jedis) {
  import Dedupe._

  /** True when this (user, request) already voted. */
  def isDuplicate(tenant: String, userId: String, requestId: String): Boolean = {
    // TODO: this draft checks membership and then adds in two round trips, so a double click
    // lands two ratings, and the key forgets the tenant so user ids collide across tenants.
    val key = dedupeKey(userId, requestId)
    if (jedis.sismember(SeenKey, key)) {
      true
    } else {
      jedis.sadd(SeenKey, key)
      jedis.expire(SeenKey, TtlSeconds)
      false
    }
  }
}
`,
      solution: `import java.util

import redis.clients.jedis.Jedis

object Dedupe {
  val TtlSeconds: Long = 30L * 24 * 60 * 60

  /** Set-if-absent with its expiry in one round trip: 1 when this caller claimed the slot. */
  val DedupeScript: String =
    """if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2]) then
      |  return 1
      |end
      |return 0""".stripMargin

  def dedupeKey(tenant: String, userId: String, requestId: String): String =
    s"feedback:dedupe:$tenant:$userId:$requestId"
}

final class Dedupe(jedis: Jedis) {
  import Dedupe._

  /** True when this caller claimed the ballot slot, false when it was already taken. */
  def claim(tenant: String, userId: String, requestId: String): Boolean = {
    val key = dedupeKey(tenant, userId, requestId)
    val claimed = jedis
      .eval(DedupeScript, util.Arrays.asList(key), util.Arrays.asList("1", TtlSeconds.toString))
      .asInstanceOf[Long]
    claimed == 1
  }
}
`,
    },
    cpp: {
      starter: `#include <hiredis/hiredis.h>

#include <string>

constexpr long long kTtlSeconds = 30LL * 24 * 60 * 60;
const std::string kSeenKey = "feedback:seen";

std::string keyFor(const std::string& userId, const std::string& requestId) {
  return "feedback:" + userId + ":" + requestId;
}

// Dedupe keeps one feedback write per (tenant, user, request).
class Dedupe {
 public:
  explicit Dedupe(redisContext* ctx) : ctx_(ctx) {}

  bool isDuplicate(const std::string& tenant, const std::string& userId, const std::string& requestId) {
    // TODO: this draft checks membership and then adds in two round trips, so a double click
    // lands two ratings, and the key forgets the tenant so user ids collide across tenants.
    const std::string key = keyFor(userId, requestId);
    auto* member = redisCommand(ctx_, "SISMEMBER %s %s", kSeenKey.c_str(), key.c_str());
    const long long seen = member->integer;
    freeReplyObject(member);
    if (seen == 1) {
      return true;
    }
    auto* added = redisCommand(ctx_, "SADD %s %s", kSeenKey.c_str(), key.c_str());
    freeReplyObject(added);
    auto* expiry = redisCommand(ctx_, "EXPIRE %s %lld", kSeenKey.c_str(), kTtlSeconds);
    freeReplyObject(expiry);
    return false;
  }

 private:
  redisContext* ctx_;
};
`,
      solution: `#include <hiredis/hiredis.h>

#include <string>

constexpr long long kTtlSeconds = 30LL * 24 * 60 * 60;

// Set-if-absent with its expiry in one round trip: 1 when this caller claimed the slot, 0 when it
// was already taken. A separate SISMEMBER then SADD lets a double submit land two ratings.
const char* kDedupeScript =
    "if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2]) then return 1 end return 0";

std::string dedupeKey(const std::string& tenant, const std::string& userId, const std::string& requestId) {
  return "feedback:dedupe:" + tenant + ":" + userId + ":" + requestId;
}

// Dedupe keeps one feedback write per (tenant, user, request).
class Dedupe {
 public:
  explicit Dedupe(redisContext* ctx) : ctx_(ctx) {}

  bool claim(const std::string& tenant, const std::string& userId, const std::string& requestId) {
    const std::string key = dedupeKey(tenant, userId, requestId);
    auto* reply = redisCommand(ctx_, "EVAL %s 1 %s 1 %lld", kDedupeScript, key.c_str(), kTtlSeconds);
    const long long claimed = reply->integer;
    freeReplyObject(reply);
    return claimed == 1;
  }

 private:
  redisContext* ctx_;
};
`,
    },
  },
  debrief: `The ballot has to be reserved in one operation: \`SET key value NX EX ttl\` inside a script is a
single atomic step, while \`SISMEMBER\` followed by \`SADD\` is two steps with a gap where a double click
wins. Folding the expiry into the same step removes the other race — a key added but never expired —
and scoping the key by tenant keeps "alice" on one tenant from silencing "alice" on another.

Real systems keep the reservation result as the single source of truth: the endpoint writes a row only
when the script answered \`1\`, so retries and duplicate submits are answered without a second read. The
30-day TTL bounds how long the memory of a vote lasts; anything longer is a privacy decision, not a
dedupe decision.`,
};
