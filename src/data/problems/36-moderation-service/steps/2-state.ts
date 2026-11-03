import type {Step} from '@/lib/types';

const CLAIM_LUA = `local popped = redis.call('ZPOPMIN', KEYS[1])
if #popped == 0 then return '' end
local case_id = popped[1]
redis.call('ZADD', KEYS[2], ARGV[2], case_id)
redis.call('HSET', KEYS[3], case_id, ARGV[1])
redis.call('HINCRBY', KEYS[4], 'pending', -1)
redis.call('HINCRBY', KEYS[4], 'in_review', 1)
return case_id`;

const RENEW_LUA = `if redis.call('HGET', KEYS[2], ARGV[1]) ~= ARGV[2] then return 0 end
redis.call('ZADD', KEYS[1], ARGV[3], ARGV[1])
return 1`;

const REQUEUE_LUA = `local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', '(' .. ARGV[1])
for _, case_id in ipairs(expired) do
  redis.call('ZREM', KEYS[1], case_id)
  redis.call('HDEL', KEYS[2], case_id)
  redis.call('ZADD', KEYS[3], 0, case_id)
  redis.call('HINCRBY', KEYS[4], 'in_review', -1)
  redis.call('HINCRBY', KEYS[4], 'pending', 1)
end
return #expired`;

/** A Lua script as the lines of a Scala `stripMargin` literal. */
const scalaLua = (lua: string): string => lua.split('\n').join('\n      |');

export const stateStep: Step = {
  id: 'state',
  title: 'Redis queue claims with a lease that expires',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis', 'console'],
  task: `## Task

**Starting point.** The starter is the claim side of the review queue \`queue.enqueue\` fills:
\`claim(moderator, now)\` reads the head of \`moderation:pending\`, removes it, records the holder in
\`moderation:owners\` and moves the \`pending\` and \`in_review\` fields of \`moderation:counters\`, one
command each; \`renew(case_id, moderator, now)\` pushes the case's deadline in \`moderation:leases\`;
\`requeue_expired(now)\` puts every case whose deadline passed back in the queue. It serves the demo
and hides five flaws.

**Failure mode the checks target.** Two moderators open the same case; a moderator whose browser
crashed holds a case forever; one moderator extends a case another holds; a dashboard counts four
cases in a queue of three; and a swept case is swept again on every pass.

- \`claim\` is one Lua script: pop the head, write the deadline \`now + LEASE_S\` (**600 s**) to
  \`moderation:leases\` and the owner to \`moderation:owners\`, move both counters.
- \`renew\` is one script that extends the deadline only for the moderator who holds the case, and
  answers false otherwise.
- \`requeue_expired\` is one script: a case whose deadline is before \`now\` leaves the leases and the
  owners, goes back to the head of the queue (score 0) and moves the counters back; it returns how
  many.`,
  sequence: {
    participants: ['Moderator console', 'Redis', 'Sweeper'],
    messages: [
      {from: 'Moderator console', to: 'Redis', label: 'EVAL claim · ZPOPMIN pending · lease now + 600', kind: 'sync'},
      {from: 'Redis', to: 'Moderator console', label: 'case-7 · counters moved in the same step', kind: 'reply'},
      {from: 'Moderator console', to: 'Redis', label: 'EVAL renew · owner == caller? · ZADD leases', kind: 'sync'},
      {from: 'Redis', to: 'Moderator console', label: '1 renewed · 0 held by someone else', kind: 'reply'},
      {from: 'Sweeper', to: 'Redis', label: 'EVAL requeue · ZRANGEBYSCORE leases -inf (now', kind: 'sync'},
      {from: 'Redis', to: 'Sweeper', label: 'expired cases back at the head of pending', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'claim-atomic',
      title: 'Claims with one atomic Lua script',
      detail:
        'The pop happens inside one Lua script, so two moderators claiming at once get two cases. The starter reads the head and removes it in separate commands, and a second claim lands between them.',
      match: {
        python: {
          all: [/register_script\(|\.eval\(/, /redis\.call\(\s*['"](ZPOPMIN|ZREM)['"]/],
          none: [/\br\.zrem\(/, /\br\.zrange\(/],
        },
        typescript: {
          all: [/\.eval\(|defineCommand\(/, /redis\.call\(\s*['"](ZPOPMIN|ZREM)['"]/],
          none: [/redis\.zrem\(/, /redis\.zrange\(/],
        },
        go: {
          all: [/redis\.NewScript\(|\.Eval\(/, /redis\.call\(\s*['"](ZPOPMIN|ZREM)['"]/],
          none: [/rdb\.ZRem\(/, /rdb\.ZRange\(/],
        },
        scala: {
          all: [/jedis\.eval(sha)?\(/, /redis\.call\(\s*['"](ZPOPMIN|ZREM)['"]/],
          none: [/jedis\.zrem\(/, /jedis\.zrange\(/],
        },
        cpp: {
          all: [/redis\.eval(sha)?</, /redis\.call\(\s*['"](ZPOPMIN|ZREM)['"]/],
          none: [/redis\.zrem\(/, /redis\.zrange\(/],
        },
      },
    },
    {
      id: 'lease-deadline',
      title: 'A claim writes a deadline that can expire',
      detail:
        'The claim writes `now + LEASE_S` (600 s) for the case to `moderation:leases` in the same script, so an abandoned claim can be swept. The starter records the owner and no deadline.',
      match: {
        python: {all: [/def claim\((?:(?!\ndef )[\s\S])*?LEASE_S/, /redis\.call\(\s*['"]ZADD['"]/]},
        typescript: {all: [/function claim\((?:(?!\nexport )[\s\S])*?LEASE_S/, /redis\.call\(\s*['"]ZADD['"]/]},
        go: {all: [/func claim\((?:(?!\n\})[\s\S])*?leaseS/, /redis\.call\(\s*['"]ZADD['"]/]},
        scala: {all: [/def claim\((?:(?!\n {2}def )[\s\S])*?LeaseS/, /redis\.call\(\s*['"]ZADD['"]/]},
        cpp: {all: [/claim\(const std::string& moderator(?:(?!\n\})[\s\S])*?kLeaseS/, /redis\.call\(\s*['"]ZADD['"]/]},
      },
    },
    {
      id: 'renew-owner',
      title: 'Renews only the holder’s lease',
      detail:
        'The renewal compares the owner in `moderation:owners` with the caller inside a script and refuses (false) when they differ; the starter extends whatever case it is given.',
      match: {
        python: {all: [/redis\.call\(\s*['"]HGET['"]/, /[~=]=\s*ARGV\[\d\]/]},
        typescript: {all: [/redis\.call\(\s*['"]HGET['"]/, /[~=]=\s*ARGV\[\d\]/]},
        go: {all: [/redis\.call\(\s*['"]HGET['"]/, /[~=]=\s*ARGV\[\d\]/]},
        scala: {all: [/redis\.call\(\s*['"]HGET['"]/, /[~=]=\s*ARGV\[\d\]/]},
        cpp: {all: [/redis\.call\(\s*['"]HGET['"]/, /[~=]=\s*ARGV\[\d\]/]},
      },
    },
    {
      id: 'counters',
      title: 'Moves pending and in_review in the same step',
      detail:
        'The `pending` and `in_review` fields move with `HINCRBY` inside the scripts, so a reader never sees a case counted twice; the starter moves them with two client commands.',
      match: {
        python: {all: [/redis\.call\(\s*['"]HINCRBY['"]/], none: [/\.hincrby\(/]},
        typescript: {all: [/redis\.call\(\s*['"]HINCRBY['"]/], none: [/redis\.hincrby\(/]},
        go: {all: [/redis\.call\(\s*['"]HINCRBY['"]/], none: [/rdb\.HIncrBy\(/]},
        scala: {all: [/redis\.call\(\s*['"]HINCRBY['"]/], none: [/jedis\.hincrBy\(/]},
        cpp: {all: [/redis\.call\(\s*['"]HINCRBY['"]/], none: [/redis\.hincrby\(/]},
      },
    },
    {
      id: 'requeue-expired',
      title: 'Returns expired claims to the queue once',
      detail:
        'The sweep finds past deadlines and, in one script, removes the lease and the owner (`HDEL`) as it puts the case back, so the next pass finds nothing and the old holder can no longer renew; the starter only re-adds the case.',
      match: {
        python: {all: [/ZRANGEBYSCORE|BYSCORE/, /redis\.call\(\s*['"]HDEL['"]/], none: [/\.zrangebyscore\(/]},
        typescript: {all: [/ZRANGEBYSCORE|BYSCORE/, /redis\.call\(\s*['"]HDEL['"]/], none: [/redis\.zrangebyscore\(/]},
        go: {all: [/ZRANGEBYSCORE|BYSCORE/, /redis\.call\(\s*['"]HDEL['"]/], none: [/rdb\.ZRangeByScore\(/]},
        scala: {all: [/ZRANGEBYSCORE|BYSCORE/, /redis\.call\(\s*['"]HDEL['"]/], none: [/jedis\.zrangeByScore\(/]},
        cpp: {all: [/ZRANGEBYSCORE|BYSCORE/, /redis\.call\(\s*['"]HDEL['"]/], none: [/redis\.zrangebyscore\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

PENDING = "moderation:pending"
LEASES = "moderation:leases"
OWNERS = "moderation:owners"
COUNTERS = "moderation:counters"
LEASE_S = 600


def claim(moderator: str, now: int) -> str | None:
    """Take the oldest pending case for review; None when the queue is empty."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    head = r.zrange(PENDING, 0, 0)
    if not head:
        return None
    case_id = head[0]
    r.zrem(PENDING, case_id)
    r.hset(OWNERS, case_id, moderator)
    r.hincrby(COUNTERS, "in_review", 1)
    r.hincrby(COUNTERS, "pending", -1)
    return case_id


def renew(case_id: str, moderator: str, now: int) -> bool:
    """Extend the moderator's lease on the case while the review session is active."""
    r.zadd(LEASES, {case_id: now + LEASE_S})
    return True


def requeue_expired(now: int) -> int:
    """Put every case whose lease ran out back in the queue; how many."""
    expired = r.zrangebyscore(LEASES, "-inf", f"({now}")
    for case_id in expired:
        r.zadd(PENDING, {case_id: 0})
    return len(expired)
`,
      solution: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

PENDING = "moderation:pending"
LEASES = "moderation:leases"
OWNERS = "moderation:owners"
COUNTERS = "moderation:counters"
LEASE_S = 600

# Pop the head, write its deadline and owner, move the counters: one step for every other client.
CLAIM_LUA = """
${CLAIM_LUA}
"""
# Extend the deadline only for the moderator who holds the case.
RENEW_LUA = """
${RENEW_LUA}
"""
# Every case past its deadline goes back to the head of the queue, once.
REQUEUE_LUA = """
${REQUEUE_LUA}
"""
claim_script = r.register_script(CLAIM_LUA)
renew_script = r.register_script(RENEW_LUA)
requeue_script = r.register_script(REQUEUE_LUA)


def claim(moderator: str, now: int) -> str | None:
    """Take the oldest pending case for review; None when the queue is empty."""
    case_id = claim_script(keys=[PENDING, LEASES, OWNERS, COUNTERS], args=[moderator, now + LEASE_S])
    return case_id or None


def renew(case_id: str, moderator: str, now: int) -> bool:
    """Extend the moderator's lease on the case while the review session is active."""
    return renew_script(keys=[LEASES, OWNERS], args=[case_id, moderator, now + LEASE_S]) == 1


def requeue_expired(now: int) -> int:
    """Put every case whose lease ran out back in the queue; how many."""
    return int(requeue_script(keys=[LEASES, OWNERS, PENDING, COUNTERS], args=[now]))
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const PENDING = 'moderation:pending';
export const LEASES = 'moderation:leases';
export const OWNERS = 'moderation:owners';
export const COUNTERS = 'moderation:counters';
export const LEASE_S = 600;

/** Take the oldest pending case for review; null when the queue is empty. */
export async function claim(moderator: string, now: number): Promise<string | null> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const head = await redis.zrange(PENDING, 0, 0);
  if (head.length === 0) return null;
  const caseId = head[0];
  await redis.zrem(PENDING, caseId);
  await redis.hset(OWNERS, caseId, moderator);
  await redis.hincrby(COUNTERS, 'in_review', 1);
  await redis.hincrby(COUNTERS, 'pending', -1);
  return caseId;
}

/** Extend the moderator's lease on the case while the review session is active. */
export async function renew(caseId: string, moderator: string, now: number): Promise<boolean> {
  await redis.zadd(LEASES, now + LEASE_S, caseId);
  return true;
}

/** Put every case whose lease ran out back in the queue; how many. */
export async function requeueExpired(now: number): Promise<number> {
  const expired = await redis.zrangebyscore(LEASES, '-inf', \`(\${now}\`);
  for (const caseId of expired) await redis.zadd(PENDING, 0, caseId);
  return expired.length;
}
`,
      solution: `import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const PENDING = 'moderation:pending';
export const LEASES = 'moderation:leases';
export const OWNERS = 'moderation:owners';
export const COUNTERS = 'moderation:counters';
export const LEASE_S = 600;

/** Pop the head, write its deadline and owner, move the counters: one step for every other client. */
export const CLAIM_LUA = \`
${CLAIM_LUA}
\`;
/** Extend the deadline only for the moderator who holds the case. */
export const RENEW_LUA = \`
${RENEW_LUA}
\`;
/** Every case past its deadline goes back to the head of the queue, once. */
export const REQUEUE_LUA = \`
${REQUEUE_LUA}
\`;

/** Take the oldest pending case for review; null when the queue is empty. */
export async function claim(moderator: string, now: number): Promise<string | null> {
  const caseId = (await redis.eval(CLAIM_LUA, 4, PENDING, LEASES, OWNERS, COUNTERS, moderator, now + LEASE_S)) as string;
  return caseId === '' ? null : caseId;
}

/** Extend the moderator's lease on the case while the review session is active. */
export async function renew(caseId: string, moderator: string, now: number): Promise<boolean> {
  return (await redis.eval(RENEW_LUA, 2, LEASES, OWNERS, caseId, moderator, now + LEASE_S)) === 1;
}

/** Put every case whose lease ran out back in the queue; how many. */
export async function requeueExpired(now: number): Promise<number> {
  return Number(await redis.eval(REQUEUE_LUA, 4, LEASES, OWNERS, PENDING, COUNTERS, now));
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"fmt"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	pending  = "moderation:pending"
	leases   = "moderation:leases"
	owners   = "moderation:owners"
	counters = "moderation:counters"
	leaseS   = 600
)

// claim takes the oldest pending case for review; "" when the queue is empty.
func claim(ctx context.Context, moderator string, now int64) (string, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	head, err := rdb.ZRange(ctx, pending, 0, 0).Result()
	if err != nil || len(head) == 0 {
		return "", err
	}
	caseID := head[0]
	rdb.ZRem(ctx, pending, caseID)
	rdb.HSet(ctx, owners, caseID, moderator)
	rdb.HIncrBy(ctx, counters, "in_review", 1)
	rdb.HIncrBy(ctx, counters, "pending", -1)
	return caseID, nil
}

// renew extends the moderator's lease on the case while the review session is active.
func renew(ctx context.Context, caseID, moderator string, now int64) (bool, error) {
	err := rdb.ZAdd(ctx, leases, redis.Z{Score: float64(now + leaseS), Member: caseID}).Err()
	return err == nil, err
}

// requeueExpired puts every case whose lease ran out back in the queue and reports how many.
func requeueExpired(ctx context.Context, now int64) (int, error) {
	expired, err := rdb.ZRangeByScore(ctx, leases, &redis.ZRangeBy{Min: "-inf", Max: fmt.Sprintf("(%d", now)}).Result()
	if err != nil {
		return 0, err
	}
	for _, caseID := range expired {
		rdb.ZAdd(ctx, pending, redis.Z{Score: 0, Member: caseID})
	}
	return len(expired), nil
}
`,
      solution: `package main

import (
	"context"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	pending  = "moderation:pending"
	leases   = "moderation:leases"
	owners   = "moderation:owners"
	counters = "moderation:counters"
	leaseS   = 600
)

// claimScript pops the head, writes its deadline and owner and moves the counters: one step for every other client.
var claimScript = redis.NewScript(\`
${CLAIM_LUA}
\`)

// renewScript extends the deadline only for the moderator who holds the case.
var renewScript = redis.NewScript(\`
${RENEW_LUA}
\`)

// requeueScript puts every case past its deadline back at the head of the queue, once.
var requeueScript = redis.NewScript(\`
${REQUEUE_LUA}
\`)

// claim takes the oldest pending case for review; "" when the queue is empty.
func claim(ctx context.Context, moderator string, now int64) (string, error) {
	return claimScript.Run(ctx, rdb, []string{pending, leases, owners, counters}, moderator, now+leaseS).Text()
}

// renew extends the moderator's lease on the case while the review session is active.
func renew(ctx context.Context, caseID, moderator string, now int64) (bool, error) {
	renewed, err := renewScript.Run(ctx, rdb, []string{leases, owners}, caseID, moderator, now+leaseS).Int64()
	return renewed == 1, err
}

// requeueExpired puts every case whose lease ran out back in the queue and reports how many.
func requeueExpired(ctx context.Context, now int64) (int, error) {
	n, err := requeueScript.Run(ctx, rdb, []string{leases, owners, pending, counters}, now).Int64()
	return int(n), err
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

object State {
  val jedis = new JedisPooled("redis", 6379)

  val Pending = "moderation:pending"
  val Leases = "moderation:leases"
  val Owners = "moderation:owners"
  val Counters = "moderation:counters"
  val LeaseS = 600L

  /** Take the oldest pending case for review; None when the queue is empty. */
  def claim(moderator: String, now: Long): Option[String] = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    jedis.zrange(Pending, 0, 0).asScala.headOption.map { caseId =>
      jedis.zrem(Pending, caseId)
      jedis.hset(Owners, caseId, moderator)
      jedis.hincrBy(Counters, "in_review", 1L)
      jedis.hincrBy(Counters, "pending", -1L)
      caseId
    }
  }

  /** Extend the moderator's lease on the case while the review session is active. */
  def renew(caseId: String, moderator: String, now: Long): Boolean = {
    jedis.zadd(Leases, (now + LeaseS).toDouble, caseId)
    true
  }

  /** Put every case whose lease ran out back in the queue; how many. */
  def requeueExpired(now: Long): Long = {
    val expired = jedis.zrangeByScore(Leases, "-inf", s"($now").asScala
    expired.foreach(caseId => jedis.zadd(Pending, 0.0, caseId))
    expired.size.toLong
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

object State {
  val jedis = new JedisPooled("redis", 6379)

  val Pending = "moderation:pending"
  val Leases = "moderation:leases"
  val Owners = "moderation:owners"
  val Counters = "moderation:counters"
  val LeaseS = 600L

  /** Pop the head, write its deadline and owner, move the counters: one step for every other client. */
  val ClaimLua: String =
    """${scalaLua(CLAIM_LUA)}
      |""".stripMargin

  /** Extend the deadline only for the moderator who holds the case. */
  val RenewLua: String =
    """${scalaLua(RENEW_LUA)}
      |""".stripMargin

  /** Every case past its deadline goes back to the head of the queue, once. */
  val RequeueLua: String =
    """${scalaLua(REQUEUE_LUA)}
      |""".stripMargin

  /** Take the oldest pending case for review; None when the queue is empty. */
  def claim(moderator: String, now: Long): Option[String] = {
    val caseId = jedis.eval(ClaimLua, List(Pending, Leases, Owners, Counters).asJava, List(moderator, (now + LeaseS).toString).asJava)
    Option(caseId).map(_.toString).filter(_.nonEmpty)
  }

  /** Extend the moderator's lease on the case while the review session is active. */
  def renew(caseId: String, moderator: String, now: Long): Boolean =
    jedis.eval(RenewLua, List(Leases, Owners).asJava, List(caseId, moderator, (now + LeaseS).toString).asJava).asInstanceOf[java.lang.Long] == 1L

  /** Put every case whose lease ran out back in the queue; how many. */
  def requeueExpired(now: Long): Long =
    jedis.eval(RequeueLua, List(Leases, Owners, Pending, Counters).asJava, List(now.toString).asJava).asInstanceOf[java.lang.Long]
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <iterator>
#include <optional>
#include <string>
#include <vector>

sw::redis::Redis redis("tcp://redis:6379");

const std::string kPending = "moderation:pending";
const std::string kLeases = "moderation:leases";
const std::string kOwners = "moderation:owners";
const std::string kCounters = "moderation:counters";
constexpr long long kLeaseS = 600;

// Take the oldest pending case for review; none when the queue is empty.
std::optional<std::string> claim(const std::string& moderator, long long now) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  std::vector<std::string> head;
  redis.zrange(kPending, 0, 0, std::back_inserter(head));
  if (head.empty()) return std::nullopt;
  const std::string case_id = head[0];
  redis.zrem(kPending, case_id);
  redis.hset(kOwners, case_id, moderator);
  redis.hincrby(kCounters, "in_review", 1);
  redis.hincrby(kCounters, "pending", -1);
  return case_id;
}

// Extend the moderator's lease on the case while the review session is active.
bool renew(const std::string& case_id, const std::string& moderator, long long now) {
  redis.zadd(kLeases, case_id, static_cast<double>(now + kLeaseS));
  return true;
}

// Put every case whose lease ran out back in the queue; how many.
long long requeueExpired(long long now) {
  const std::vector<std::string> expired = redis.zrangebyscore(kLeases, "-inf", "(" + std::to_string(now));
  for (const std::string& case_id : expired) redis.zadd(kPending, case_id, 0);
  return static_cast<long long>(expired.size());
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <optional>
#include <string>

sw::redis::Redis redis("tcp://redis:6379");

const std::string kPending = "moderation:pending";
const std::string kLeases = "moderation:leases";
const std::string kOwners = "moderation:owners";
const std::string kCounters = "moderation:counters";
constexpr long long kLeaseS = 600;

// Pop the head, write its deadline and owner, move the counters: one step for every other client.
const std::string kClaimLua = R"lua(
${CLAIM_LUA}
)lua";

// Extend the deadline only for the moderator who holds the case.
const std::string kRenewLua = R"lua(
${RENEW_LUA}
)lua";

// Every case past its deadline goes back to the head of the queue, once.
const std::string kRequeueLua = R"lua(
${REQUEUE_LUA}
)lua";

// Take the oldest pending case for review; none when the queue is empty.
std::optional<std::string> claim(const std::string& moderator, long long now) {
  const std::string case_id =
      redis.eval<std::string>(kClaimLua, {kPending, kLeases, kOwners, kCounters}, {moderator, std::to_string(now + kLeaseS)});
  if (case_id.empty()) return std::nullopt;
  return case_id;
}

// Extend the moderator's lease on the case while the review session is active.
bool renew(const std::string& case_id, const std::string& moderator, long long now) {
  return redis.eval<long long>(kRenewLua, {kLeases, kOwners}, {case_id, moderator, std::to_string(now + kLeaseS)}) == 1;
}

// Put every case whose lease ran out back in the queue; how many.
long long requeueExpired(long long now) {
  return redis.eval<long long>(kRequeueLua, {kLeases, kOwners, kPending, kCounters}, {std::to_string(now)});
}
`,
    },
  },
  harness: {
    python: `from moderation import queue

PENDING = "moderation:pending"
LEASES = "moderation:leases"
OWNERS = "moderation:owners"
COUNTERS = "moderation:counters"


def _seed(*case_ids):
    for case_id in case_ids:
        queue.enqueue(case_id)


def _settled(probe, what):
    assert probe.fired, f"nothing touched {what}"
    if probe.error is not None:
        raise probe.error
    return probe.result


def check_claim_atomic(ctx):
    m = ctx.load("state")
    _seed("case-1", "case-2")
    rival = ctx.redis_after(PENDING, lambda: m.claim("bob", 0))
    mine = m.claim("alice", 0)
    theirs = _settled(rival, PENDING)
    assert mine is not None and theirs is not None, f"two moderators claiming from a queue of two got {mine!r} and {theirs!r}"
    assert mine != theirs, f"alice and bob both claimed {mine}: between the read of the queue head and its removal, the other claim read the same head"
    owners = ctx.redis.hgetall(OWNERS)
    assert owners == {mine: "alice", theirs: "bob"}, f"moderation:owners holds {owners}, expected {mine}: alice and {theirs}: bob"
    assert m.claim("carol", 0) is None, "a claim on an empty queue must answer None"


def check_lease_deadline(ctx):
    m = ctx.load("state")
    _seed("case-1")
    assert m.claim("alice", 1000) == "case-1", "alice must claim case-1"
    deadline = ctx.redis.zscore(LEASES, "case-1")
    assert deadline == 1600, f"the lease on case-1 claimed at 1000 is {deadline!r} in moderation:leases, expected 1600 (now + LEASE_S): without a deadline a crashed moderator holds the case forever"
    assert ctx.redis.hget(OWNERS, "case-1") == "alice", f"moderation:owners names {ctx.redis.hget(OWNERS, 'case-1')!r} for case-1"


def check_renew_owner(ctx):
    m = ctx.load("state")
    _seed("case-1")
    m.claim("alice", 0)
    assert m.renew("case-1", "bob", 300) is False, "bob renewed the lease on alice's case: renew must answer False for a case the caller does not hold"
    assert ctx.redis.zscore(LEASES, "case-1") == 600, f"bob's refused renewal moved the deadline to {ctx.redis.zscore(LEASES, 'case-1')!r}, expected 600"
    assert m.renew("case-1", "alice", 500) is True, "alice must be able to renew her own case"
    assert ctx.redis.zscore(LEASES, "case-1") == 1100, f"alice's renewal at 500 left the deadline at {ctx.redis.zscore(LEASES, 'case-1')!r}, expected 1100"
    assert m.renew("case-9", "alice", 500) is False, "renewing a case nobody claimed must answer False"
    assert ctx.redis.zscore(LEASES, "case-9") is None, "a refused renewal must not create a lease"


def check_counters(ctx):
    m = ctx.load("state")
    _seed("case-1", "case-2", "case-3")
    seen = ctx.redis_after(COUNTERS, lambda: ctx.redis.hgetall(COUNTERS))
    m.claim("alice", 0)
    mid = _settled(seen, COUNTERS)
    total = int(mid.get("pending", 0)) + int(mid.get("in_review", 0))
    assert total == 3, f"a dashboard reading the counters during a claim saw {mid}: {total} cases in a queue of 3. Move both counters in the claim's script"
    for moderator in ("bob", "carol", "dave"):
        m.claim(moderator, 0)
    final = ctx.redis.hgetall(COUNTERS)
    assert final == {"pending": "0", "in_review": "3"}, f"after three claims (and one on an empty queue) the counters are {final}, expected pending 0 and in_review 3"


def check_requeue_expired(ctx):
    m = ctx.load("state")
    _seed("case-1", "case-2")
    assert m.claim("alice", 0) == "case-1" and m.claim("bob", 300) == "case-2", "alice and bob must claim case-1 and case-2"
    assert m.requeue_expired(600) == 0, "a lease that ends at 600 has not expired at 600"
    swept = m.requeue_expired(700)
    assert swept == 1, f"at 700 alice's lease (600) has run out and bob's (900) has not: the sweep returned {swept}, expected 1"
    assert ctx.redis.zrange(PENDING, 0, -1) == ["case-1"], f"moderation:pending holds {ctx.redis.zrange(PENDING, 0, -1)}, expected case-1 back in the queue"
    assert ctx.redis.hget(OWNERS, "case-1") is None and ctx.redis.zscore(LEASES, "case-1") is None, f"the swept case still has owner {ctx.redis.hget(OWNERS, 'case-1')!r} and lease {ctx.redis.zscore(LEASES, 'case-1')!r}"
    assert ctx.redis.hgetall(COUNTERS) == {"pending": "1", "in_review": "1"}, f"after the sweep the counters are {ctx.redis.hgetall(COUNTERS)}, expected pending 1 and in_review 1"
    assert m.requeue_expired(800) == 0, "the next sweep found case-1 again: the sweep must remove the lease it acted on"
    assert m.renew("case-1", "alice", 800) is False, "alice's lease ran out and the case went back to the queue: her renewal must be refused"
    assert m.claim("carol", 800) == "case-1", "the swept case must be the next one claimed"
`,
    typescript: `const PENDING = 'moderation:pending';
const LEASES = 'moderation:leases';
const OWNERS = 'moderation:owners';
const COUNTERS = 'moderation:counters';

async function state(ctx, ...caseIds: string[]) {
  const queue = ctx.load('/support/moderation/queue.ts');
  for (const caseId of caseIds) await queue.enqueue(caseId);
  return ctx.load('state');
}

async function settled(probe, what: string) {
  assert(probe.fired, \`nothing touched \${what}\`);
  if (probe.error !== undefined) throw probe.error;
  return await probe.result;
}

const score = (ctx, caseId: string): number | null => {
  const s = ctx.redis.zscore(LEASES, caseId);
  return s === null ? null : Number(s);
};

export async function check_claim_atomic(ctx) {
  const m = await state(ctx, 'case-1', 'case-2');
  const rival = ctx.redisAfter(PENDING, () => m.claim('bob', 0));
  const mine = await m.claim('alice', 0);
  const theirs = await settled(rival, PENDING);
  assert(mine !== null && theirs !== null, \`two moderators claiming from a queue of two got \${mine} and \${theirs}\`);
  assert.notEqual(mine, theirs, \`alice and bob both claimed \${mine}: between the read of the queue head and its removal, the other claim read the same head\`);
  const owners = ctx.redis.hgetall(OWNERS);
  assert.deepStrictEqual(owners, {[mine]: 'alice', [theirs]: 'bob'}, \`moderation:owners holds \${JSON.stringify(owners)}\`);
  assert.equal(await m.claim('carol', 0), null, 'a claim on an empty queue must answer null');
}

export async function check_lease_deadline(ctx) {
  const m = await state(ctx, 'case-1');
  assert.equal(await m.claim('alice', 1000), 'case-1', 'alice must claim case-1');
  assert.equal(score(ctx, 'case-1'), 1600, \`the lease on case-1 claimed at 1000 is \${score(ctx, 'case-1')} in moderation:leases, expected 1600 (now + LEASE_S): without a deadline a crashed moderator holds the case forever\`);
  assert.equal(ctx.redis.hget(OWNERS, 'case-1'), 'alice', \`moderation:owners names \${ctx.redis.hget(OWNERS, 'case-1')} for case-1\`);
}

export async function check_renew_owner(ctx) {
  const m = await state(ctx, 'case-1');
  await m.claim('alice', 0);
  assert.equal(await m.renew('case-1', 'bob', 300), false, "bob renewed the lease on alice's case: renew must answer false for a case the caller does not hold");
  assert.equal(score(ctx, 'case-1'), 600, \`bob's refused renewal moved the deadline to \${score(ctx, 'case-1')}, expected 600\`);
  assert.equal(await m.renew('case-1', 'alice', 500), true, 'alice must be able to renew her own case');
  assert.equal(score(ctx, 'case-1'), 1100, \`alice's renewal at 500 left the deadline at \${score(ctx, 'case-1')}, expected 1100\`);
  assert.equal(await m.renew('case-9', 'alice', 500), false, 'renewing a case nobody claimed must answer false');
  assert.equal(score(ctx, 'case-9'), null, 'a refused renewal must not create a lease');
}

export async function check_counters(ctx) {
  const m = await state(ctx, 'case-1', 'case-2', 'case-3');
  const seen = ctx.redisAfter(COUNTERS, () => ctx.redis.hgetall(COUNTERS));
  await m.claim('alice', 0);
  const mid = await settled(seen, COUNTERS);
  const total = Number(mid.pending ?? 0) + Number(mid.in_review ?? 0);
  assert.equal(total, 3, \`a dashboard reading the counters during a claim saw \${JSON.stringify(mid)}: \${total} cases in a queue of 3. Move both counters in the claim's script\`);
  for (const moderator of ['bob', 'carol', 'dave']) await m.claim(moderator, 0);
  const final = ctx.redis.hgetall(COUNTERS);
  assert.deepStrictEqual(final, {pending: '0', in_review: '3'}, \`after three claims (and one on an empty queue) the counters are \${JSON.stringify(final)}, expected pending 0 and in_review 3\`);
}

export async function check_requeue_expired(ctx) {
  const m = await state(ctx, 'case-1', 'case-2');
  assert((await m.claim('alice', 0)) === 'case-1' && (await m.claim('bob', 300)) === 'case-2', 'alice and bob must claim case-1 and case-2');
  assert.equal(await m.requeueExpired(600), 0, 'a lease that ends at 600 has not expired at 600');
  const swept = await m.requeueExpired(700);
  assert.equal(swept, 1, \`at 700 alice's lease (600) has run out and bob's (900) has not: the sweep returned \${swept}, expected 1\`);
  assert.deepStrictEqual(ctx.redis.zrange(PENDING, 0, -1), ['case-1'], \`moderation:pending holds \${JSON.stringify(ctx.redis.zrange(PENDING, 0, -1))}, expected case-1 back in the queue\`);
  assert(ctx.redis.hget(OWNERS, 'case-1') === null && score(ctx, 'case-1') === null, \`the swept case still has owner \${ctx.redis.hget(OWNERS, 'case-1')} and lease \${score(ctx, 'case-1')}\`);
  assert.deepStrictEqual(ctx.redis.hgetall(COUNTERS), {pending: '1', in_review: '1'}, \`after the sweep the counters are \${JSON.stringify(ctx.redis.hgetall(COUNTERS))}, expected pending 1 and in_review 1\`);
  assert.equal(await m.requeueExpired(800), 0, 'the next sweep found case-1 again: the sweep must remove the lease it acted on');
  assert.equal(await m.renew('case-1', 'alice', 800), false, "alice's lease ran out and the case went back to the queue: her renewal must be refused");
  assert.equal(await m.claim('carol', 800), 'case-1', 'the swept case must be the next one claimed');
}
`,
    go: `package main

import (
	"context"
	"strconv"

	"moderation/queue"

	"leetbuild/harness"
)

var stateBg = context.Background()

func stateSeed(caseIDs ...string) {
	for _, caseID := range caseIDs {
		queue.Enqueue(stateBg, caseID)
	}
}

func stateClaim(ctx *harness.Ctx, moderator string, now int64) string {
	caseID, err := claim(stateBg, moderator, now)
	ctx.NoError(err, "claim(%s, %d)", moderator, now)
	return caseID
}

func stateRenew(ctx *harness.Ctx, caseID, moderator string, now int64) bool {
	renewed, err := renew(stateBg, caseID, moderator, now)
	ctx.NoError(err, "renew(%s, %s, %d)", caseID, moderator, now)
	return renewed
}

func stateSweep(ctx *harness.Ctx, now int64) int {
	n, err := requeueExpired(stateBg, now)
	ctx.NoError(err, "requeueExpired(%d)", now)
	return n
}

func stateLease(ctx *harness.Ctx, caseID string) float64 {
	deadline, _ := ctx.Redis.ZScore("moderation:leases", caseID)
	return deadline
}

func CheckClaimAtomic(ctx *harness.Ctx) {
	stateSeed("case-1", "case-2")
	rival := ctx.Redis.After("moderation:pending", func() any {
		caseID, err := claim(stateBg, "bob", 0)
		ctx.NoError(err, "bob's claim")
		return caseID
	})
	mine := stateClaim(ctx, "alice", 0)
	ctx.Assert(rival.Fired, "nothing touched moderation:pending")
	ctx.Assert(rival.Err == nil, "bob's claim failed: %v", rival.Err)
	theirs, _ := rival.Result.(string)
	ctx.Assert(mine != "" && theirs != "", "two moderators claiming from a queue of two got %q and %q", mine, theirs)
	ctx.Assert(mine != theirs, "alice and bob both claimed %s: between the read of the queue head and its removal, the other claim read the same head", mine)
	ctx.Equal(ctx.Redis.HGetAll("moderation:owners"), map[string]string{mine: "alice", theirs: "bob"}, "moderation:owners")
	ctx.Equal(stateClaim(ctx, "carol", 0), "", "a claim on an empty queue must answer \\"\\"")
}

func CheckLeaseDeadline(ctx *harness.Ctx) {
	stateSeed("case-1")
	ctx.Equal(stateClaim(ctx, "alice", 1000), "case-1", "alice must claim case-1")
	deadline, ok := ctx.Redis.ZScore("moderation:leases", "case-1")
	ctx.Assert(ok && deadline == 1600, "the lease on case-1 claimed at 1000 is %v (present: %v) in moderation:leases, expected 1600 (now + leaseS): without a deadline a crashed moderator holds the case forever", deadline, ok)
	owner, _ := ctx.Redis.HGet("moderation:owners", "case-1")
	ctx.Equal(owner, "alice", "the owner of case-1 in moderation:owners")
}

func CheckRenewOwner(ctx *harness.Ctx) {
	stateSeed("case-1")
	stateClaim(ctx, "alice", 0)
	ctx.Equal(stateRenew(ctx, "case-1", "bob", 300), false, "bob renewed the lease on alice's case: renew must answer false for a case the caller does not hold; renewed")
	ctx.Equal(stateLease(ctx, "case-1"), 600.0, "bob's refused renewal must leave the deadline")
	ctx.Equal(stateRenew(ctx, "case-1", "alice", 500), true, "alice must be able to renew her own case; renewed")
	ctx.Equal(stateLease(ctx, "case-1"), 1100.0, "alice's renewal at 500; the deadline")
	ctx.Equal(stateRenew(ctx, "case-9", "alice", 500), false, "renewing a case nobody claimed; renewed")
	_, ok := ctx.Redis.ZScore("moderation:leases", "case-9")
	ctx.Assert(!ok, "a refused renewal must not create a lease")
}

func CheckCounters(ctx *harness.Ctx) {
	stateSeed("case-1", "case-2", "case-3")
	seen := ctx.Redis.After("moderation:counters", func() any { return ctx.Redis.HGetAll("moderation:counters") })
	stateClaim(ctx, "alice", 0)
	ctx.Assert(seen.Fired, "nothing touched moderation:counters")
	mid, _ := seen.Result.(map[string]string)
	waiting, _ := strconv.Atoi(mid["pending"])
	held, _ := strconv.Atoi(mid["in_review"])
	total := waiting + held
	ctx.Equal(total, 3, "a dashboard reading the counters during a claim saw %v; move both counters in the claim's script; the cases counted", mid)
	for _, moderator := range []string{"bob", "carol", "dave"} {
		stateClaim(ctx, moderator, 0)
	}
	ctx.Equal(ctx.Redis.HGetAll("moderation:counters"), map[string]string{"pending": "0", "in_review": "3"}, "after three claims (and one on an empty queue) the counters")
}

func CheckRequeueExpired(ctx *harness.Ctx) {
	stateSeed("case-1", "case-2")
	ctx.Assert(stateClaim(ctx, "alice", 0) == "case-1" && stateClaim(ctx, "bob", 300) == "case-2", "alice and bob must claim case-1 and case-2")
	ctx.Equal(stateSweep(ctx, 600), 0, "a lease that ends at 600 has not expired at 600; swept")
	ctx.Equal(stateSweep(ctx, 700), 1, "at 700 alice's lease (600) has run out and bob's (900) has not; swept")
	var queued []string
	for _, z := range ctx.Redis.ZRangeWithScores("moderation:pending", 0, -1) {
		queued = append(queued, z.Member)
	}
	ctx.Equal(queued, []string{"case-1"}, "moderation:pending must hold case-1 again")
	_, owned := ctx.Redis.HGet("moderation:owners", "case-1")
	_, leased := ctx.Redis.ZScore("moderation:leases", "case-1")
	ctx.Assert(!owned && !leased, "the swept case still has an owner (%v) or a lease (%v)", owned, leased)
	ctx.Equal(ctx.Redis.HGetAll("moderation:counters"), map[string]string{"pending": "1", "in_review": "1"}, "after the sweep the counters")
	ctx.Equal(stateSweep(ctx, 800), 0, "the next sweep found case-1 again: the sweep must remove the lease it acted on; swept")
	ctx.Equal(stateRenew(ctx, "case-1", "alice", 800), false, "alice's lease ran out and the case went back to the queue: her renewal must be refused; renewed")
	ctx.Equal(stateClaim(ctx, "carol", 800), "case-1", "the swept case must be the next one claimed")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <map>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "moderation/queue.h"

namespace {

const std::string kStatePending = "moderation:pending";
const std::string kStateLeases = "moderation:leases";
const std::string kStateOwners = "moderation:owners";
const std::string kStateCounters = "moderation:counters";

void stateSeed(const std::vector<std::string>& case_ids) {
  for (const auto& case_id : case_ids) queue::enqueue(case_id);
}

std::string claimed(const std::optional<std::string>& case_id) { return case_id.value_or(""); }

long long count(const std::map<std::string, std::string>& h, const std::string& field) {
  return h.count(field) && !h.at(field).empty() ? std::stoll(h.at(field)) : 0;
}

}  // namespace

void CheckClaimAtomic(harness::Ctx& ctx) {
  stateSeed({"case-1", "case-2"});
  auto rival = std::make_shared<std::optional<std::string>>();
  auto fired = std::make_shared<bool>(false);
  ctx.Redis.After(kStatePending, [rival, fired] {
    *fired = true;
    *rival = claim("bob", 0);
  });
  const std::string mine = claimed(claim("alice", 0));
  ctx.Assert(*fired, "nothing touched moderation:pending");
  const std::string theirs = claimed(*rival);
  ctx.Assert(!mine.empty() && !theirs.empty(), "two moderators claiming from a queue of two got %q and %q", mine, theirs);
  ctx.Assert(mine != theirs, "alice and bob both claimed %s: between the read of the queue head and its removal, the other claim read the same head", mine);
  ctx.Equal(ctx.Redis.HGetAll(kStateOwners), std::map<std::string, std::string>{{mine, "alice"}, {theirs, "bob"}}, "moderation:owners");
  ctx.Equal(claimed(claim("carol", 0)), "", "a claim on an empty queue must answer none");
}

void CheckLeaseDeadline(harness::Ctx& ctx) {
  stateSeed({"case-1"});
  ctx.Equal(claimed(claim("alice", 1000)), "case-1", "alice must claim case-1");
  const auto deadline = ctx.Redis.ZScore(kStateLeases, "case-1");
  ctx.Assert(deadline && *deadline == 1600,
             "the lease on case-1 claimed at 1000 is %v in moderation:leases, expected 1600 (now + kLeaseS): without a deadline a crashed moderator holds the case forever",
             deadline.value_or(-1));
  ctx.Equal(ctx.Redis.HGet(kStateOwners, "case-1").value_or(""), "alice", "the owner of case-1 in moderation:owners");
}

void CheckRenewOwner(harness::Ctx& ctx) {
  stateSeed({"case-1"});
  claim("alice", 0);
  ctx.Equal(renew("case-1", "bob", 300), false, "bob renewed the lease on alice's case: renew must answer false for a case the caller does not hold; renewed");
  ctx.Equal(ctx.Redis.ZScore(kStateLeases, "case-1").value_or(-1), 600.0, "bob's refused renewal must leave the deadline");
  ctx.Equal(renew("case-1", "alice", 500), true, "alice must be able to renew her own case; renewed");
  ctx.Equal(ctx.Redis.ZScore(kStateLeases, "case-1").value_or(-1), 1100.0, "alice's renewal at 500; the deadline");
  ctx.Equal(renew("case-9", "alice", 500), false, "renewing a case nobody claimed; renewed");
  ctx.Assert(!ctx.Redis.ZScore(kStateLeases, "case-9"), "a refused renewal must not create a lease");
}

void CheckCounters(harness::Ctx& ctx) {
  stateSeed({"case-1", "case-2", "case-3"});
  auto mid = std::make_shared<std::map<std::string, std::string>>();
  auto fired = std::make_shared<bool>(false);
  ctx.Redis.After(kStateCounters, [&ctx, mid, fired] {
    *fired = true;
    *mid = ctx.Redis.HGetAll(kStateCounters);
  });
  claim("alice", 0);
  ctx.Assert(*fired, "nothing touched moderation:counters");
  const long long total = count(*mid, "pending") + count(*mid, "in_review");
  ctx.Equal(total, 3, "a dashboard reading the counters during a claim saw %v; move both counters in the claim's script; the cases counted", *mid);
  for (const std::string moderator : {"bob", "carol", "dave"}) claim(moderator, 0);
  ctx.Equal(ctx.Redis.HGetAll(kStateCounters), std::map<std::string, std::string>{{"pending", "0"}, {"in_review", "3"}},
            "after three claims (and one on an empty queue) the counters");
}

void CheckRequeueExpired(harness::Ctx& ctx) {
  stateSeed({"case-1", "case-2"});
  ctx.Assert(claimed(claim("alice", 0)) == "case-1" && claimed(claim("bob", 300)) == "case-2", "alice and bob must claim case-1 and case-2");
  ctx.Equal(requeueExpired(600), 0, "a lease that ends at 600 has not expired at 600; swept");
  ctx.Equal(requeueExpired(700), 1, "at 700 alice's lease (600) has run out and bob's (900) has not; swept");
  std::vector<std::string> pending;
  for (const auto& z : ctx.Redis.ZRangeWithScores(kStatePending, 0, -1)) pending.push_back(z.Member);
  ctx.Equal(pending, std::vector<std::string>{"case-1"}, "moderation:pending must hold case-1 again");
  ctx.Assert(!ctx.Redis.HGet(kStateOwners, "case-1") && !ctx.Redis.ZScore(kStateLeases, "case-1"), "the swept case still has an owner or a lease");
  ctx.Equal(ctx.Redis.HGetAll(kStateCounters), std::map<std::string, std::string>{{"pending", "1"}, {"in_review", "1"}}, "after the sweep the counters");
  ctx.Equal(requeueExpired(800), 0, "the next sweep found case-1 again: the sweep must remove the lease it acted on; swept");
  ctx.Equal(renew("case-1", "alice", 800), false, "alice's lease ran out and the case went back to the queue: her renewal must be refused; renewed");
  ctx.Equal(claimed(claim("carol", 800)), "case-1", "the swept case must be the next one claimed");
}
`,
  },
  hints: [
    'Have two moderators claim at the same moment: both open the same case. Claim a case and close the tab: it never returns to the queue, and any moderator can renew it.',
    'Between the read of the queue head and its `ZREM`, another claim reads the same head. The counters are two commands a reader can land between. The claim writes no deadline, so the sweep finds nothing, and `renew` never asks who holds the case.',
    'Claim in one Lua script: `ZPOPMIN`, `ZADD` the deadline, `HSET` the owner, two `HINCRBY`. Renew: `HGET` the owner and compare it with the caller before the `ZADD`. Sweep: `ZRANGEBYSCORE` past deadlines, then `ZREM`, `HDEL`, `ZADD` to pending at 0 and the counters.',
  ],
  debrief: `A claim moves ownership, and Redis runs a Lua script as one step, so nothing observes a case in two places or in none: the pop, the deadline, the owner and the counters move together. The lease turns a claim into a promise that expires, which is what lets the sweep recover cases from moderators who closed the tab; renewal checks the owner so a stale session cannot extend a case someone else now holds. Requeueing at score 0 puts the abandoned case first, since it has waited longest. Production queues add priority lanes so a self-harm report overtakes the spam backlog, cap how many cases one moderator holds at once, and log every claim and expiry so a lead can see who held what.`,
};
