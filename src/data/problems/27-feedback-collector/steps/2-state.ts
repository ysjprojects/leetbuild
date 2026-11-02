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

**Starting point.** \`state\` exposes \`Dedupe.is_duplicate(tenant, user_id, request_id)\`: it builds
a \`feedback:{user_id}:{request_id}\` member, runs \`SISMEMBER\` on the shared \`feedback:seen\` set,
then \`SADD\` and \`EXPIRE\` in separate round trips. It serves the demo and hides five flaws.

**Failure mode the checks target.** A double-clicked thumbs-up lands two ratings because both
submits read "not seen" before either writes, and the same user id on two tenants blocks the other
tenant's vote because the key drops the tenant.

- The check and the add are one atomic operation: a Lua script \`DEDUPE_SCRIPT\` run with
  \`redis.eval\`, no \`SISMEMBER\` or \`SADD\`.
- The key comes from \`dedupe_key(tenant, user_id, request_id)\` and reads
  \`feedback:dedupe:{tenant}:{user_id}:{request_id}\`.
- The script sets the key with \`'NX'\` and \`'EX'\` \`TTL_SECONDS\` (30 days), so a crash between add
  and expire cannot leave an immortal key.
- Rename the method to \`claim\` and \`return claimed == 1\`, so the endpoint writes a row only when
  this caller took the slot and answers a repeat as a duplicate without another read.`,
  hints: [
    'Two users double-click a thumbs-up and the dashboard shows two votes on one answer; a tenant reports that its user "alice" cannot rate because another tenant has an "alice".',
    '`SISMEMBER` and `SADD` are separate round trips, so both concurrent submits read "not seen" before either writes; the key `feedback:{user_id}:{request_id}` has no tenant in it.',
    'Put `SET key value NX EX ttl` in `DEDUPE_SCRIPT`, run it with `redis.eval`, key by `dedupe_key(tenant, user_id, request_id)`, and have `claim` return `claimed == 1`. The checks cover the rest.',
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
      title: 'The SISMEMBER-then-SADD version is gone',
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
        # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
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
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
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
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
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
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
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
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
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
wins. Folding the expiry into the same step removes the other race, a key added but not expired,
and scoping the key by tenant keeps "alice" on one tenant from silencing "alice" on another.

Production collectors treat the script's answer as the only source of truth: the endpoint writes a
row when the script returned \`1\` and answers a retry from the \`0\` without a second read. The 30-day
TTL bounds how long the memory of a vote lasts; keeping it longer is a retention decision that lives
outside this module.`,
};
