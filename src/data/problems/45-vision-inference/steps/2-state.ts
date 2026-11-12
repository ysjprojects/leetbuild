import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'A GPU pool per tenant: one script to admit, a lease, an owner to release',
  concept: 'redis',
  guides: ['leases', 'atomic-state'],
  file: 'state',
  focus: ['api', 'redis'],
  task: `## Task

**Starting point.** The starter keeps a tenant's GPU slots in the sorted set \`vision/config\` names
(\`gpu_key(tenant)\`): \`admit(tenant)\` counts the members with \`ZCARD\`, refuses with
\`{ticket: None, retry_after: RETRY_AFTER_S}\` at \`GPU_TOKENS\`, otherwise \`ZADD\`s a fresh ticket
scored with the current time and answers \`{ticket, retry_after: 0}\`; \`release(tenant, ticket)\`
removes the lowest-ranked member. The demo admits and releases one request at a time. It hides four
flaws.

**Failure mode the checks target.** Count-then-add is two round trips, so two workers that both read
9 both add, and the GPU runs 11 jobs. A worker that crashes holding a slot holds it for good: nothing
in the set ever ages out. Removing by rank frees whichever worker came first, not the caller. And a
one-second \`Retry-After\` against a five-minute lease turns every refused client into a polling loop.

Requirements:

- \`admit\` is **one Lua script** (\`register_script\` / \`defineCommand\` / \`NewScript\` / \`eval\`):
  drop expired leases (\`ZREMRANGEBYSCORE\` up to now), refuse at \`GPU_TOKENS\`, else \`ZADD\` the ticket
  scored with its lease expiry (now + \`LEASE_S\`) and refresh the key's expiry to \`LEASE_S\`.
- A refusal's \`retry_after\` is the seconds until the **earliest lease ends** (at least 1).
- \`release\` removes **only the caller's ticket** (\`ZREM\`) and answers whether it was held.`,
  sequence: {
    participants: ['Worker', 'Redis'],
    messages: [
      {
        from: 'Worker',
        to: 'Redis',
        label: 'EVALSHA admit · vision:gpu:{tenant} · now lease limit ticket',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Redis', label: 'ZREMRANGEBYSCORE -inf now · ZCARD < 10', kind: 'sync'},
      {from: 'Redis', to: 'Redis', label: 'ZADD now+300 ticket · EXPIRE 300', kind: 'sync'},
      {from: 'Redis', to: 'Worker', label: '{ticket, 0} · or {"", seconds to the earliest lease end}', kind: 'reply'},
      {from: 'Worker', to: 'Redis', label: 'ZREM vision:gpu:{tenant} ticket', kind: 'sync'},
      {from: 'Redis', to: 'Worker', label: '1 held · 0 not held', kind: 'reply'},
    ],
  },
  hints: [
    "Symptom: under a burst one tenant runs 11 jobs on a 10-slot pool, a crashed worker leaves the tenant one slot short for good, and a finished job frees somebody else's slot.",
    'Mechanism: ZCARD and ZADD are separate round trips, so a second worker lands between them; scores are admission times nothing compares to the clock; release takes the lowest-ranked member; the refusal answers a constant.',
    'Change: one script per admit (`ZREMRANGEBYSCORE pool -inf now`, `ZCARD` against the limit, `ZADD pool now+LEASE_S ticket`, `EXPIRE`, or `ZRANGE pool 0 0 WITHSCORES` for the wait), and `ZREM pool ticket` to release.',
  ],
  checks: [
    {
      id: 'atomic-admit',
      title: 'Admits in one Lua script',
      detail:
        'The expiry sweep, the count against GPU_TOKENS and the ZADD run inside one EVAL/EVALSHA, so a second worker cannot land between the count and the add. The starter counts with ZCARD and adds with a separate ZADD.',
      match: {
        python: {all: [/register_script\(|\.eval\(|\.evalsha\(/, /redis\.call\(\s*['"]ZADD['"]/], none: [/\.zcard\(/]},
        typescript: {
          all: [/defineCommand\(|\.eval\(|\.evalsha\(/, /redis\.call\(\s*['"]ZADD['"]/],
          none: [/\.zcard\(/],
        },
        go: {all: [/redis\.NewScript\(|\.Eval\(|\.EvalSha\(/, /redis\.call\(\s*['"]ZADD['"]/], none: [/\.ZCard\(/]},
        scala: {all: [/jedis\.eval(sha)?\(/, /redis\.call\(\s*['"]ZADD['"]/], none: [/\.zcard\(/]},
        cpp: {all: [/redis\.eval(sha)?[<(]/, /redis\.call\(\s*['"]ZADD['"]/], none: [/\.zcard\(/]},
      },
    },
    {
      id: 'lease-expiry',
      title: "A crashed holder's slot comes back after its lease",
      detail:
        'Each ticket is scored with its lease expiry (now + LEASE_S) and admission drops expired tickets first, so ten workers that crashed holding slots stop blocking the tenant once their leases end. The starter scores the admission time and never sweeps.',
      match: {
        python: {all: [/ZREMRANGEBYSCORE/, /LEASE_S/]},
        typescript: {all: [/ZREMRANGEBYSCORE/, /LEASE_S/]},
        go: {all: [/ZREMRANGEBYSCORE/, /LeaseSeconds/]},
        scala: {all: [/ZREMRANGEBYSCORE/, /LeaseSeconds/]},
        cpp: {all: [/ZREMRANGEBYSCORE/, /kLeaseSeconds/]},
      },
    },
    {
      id: 'owner-release',
      title: "Releases only the caller's ticket",
      detail:
        'release removes the ticket it was given and answers true only when that ticket held a slot; a second release, or an unknown ticket, changes nothing. The starter removes the lowest-ranked member, whoever holds it.',
      match: {
        python: {all: [/\.zrem\(|['"]ZREM['"]/], none: [/zremrangebyrank/i]},
        typescript: {all: [/\.zrem\(|['"]ZREM['"]/], none: [/zremrangebyrank/i]},
        go: {all: [/\.ZRem\(|['"]ZREM['"]/], none: [/zremrangebyrank/i]},
        scala: {all: [/\.zrem\(|['"]ZREM['"]/], none: [/zremrangebyrank/i]},
        cpp: {all: [/\.zrem\(|['"]ZREM['"]/], none: [/zremrangebyrank/i]},
      },
    },
    {
      id: 'retry-after',
      title: 'Answers a refusal with the wait until the earliest lease ends',
      detail:
        "A refused admission's retry_after is the seconds until the oldest lease expires (read with ZRANGE … WITHSCORES), at least 1. The starter answers a constant 1 second.",
      match: {
        python: {all: [/WITHSCORES|withscores/], none: [/RETRY_AFTER_S/]},
        typescript: {all: [/WITHSCORES|withscores/i], none: [/RETRY_AFTER_S/]},
        go: {all: [/WITHSCORES|WithScores/], none: [/retryAfterSeconds/]},
        scala: {all: [/WITHSCORES|WithScores/], none: [/RetryAfterSeconds/]},
        cpp: {all: [/WITHSCORES|withscores/i], none: [/kRetryAfterSeconds/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time
import uuid

import redis

from vision.config import GPU_TOKENS, gpu_key

r = redis.Redis(host="redis", port=6379, decode_responses=True)

RETRY_AFTER_S = 1


def admit(tenant: str) -> dict:
    """Take one of the tenant's GPU slots: {ticket, retry_after}; ticket None when the pool is full."""
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    pool = gpu_key(tenant)
    if r.zcard(pool) >= GPU_TOKENS:
        return {"ticket": None, "retry_after": RETRY_AFTER_S}
    ticket = str(uuid.uuid4())
    r.zadd(pool, {ticket: int(time.time())})
    return {"ticket": ticket, "retry_after": 0}


def release(tenant: str, ticket: str) -> bool:
    """Give the slot back: True when this ticket held one."""
    return r.zremrangebyrank(gpu_key(tenant), 0, 0) == 1
`,
      solution: `import time
import uuid

import redis

from vision.config import GPU_TOKENS, LEASE_S, gpu_key

r = redis.Redis(host="redis", port=6379, decode_responses=True)

ADMIT = """
local pool = KEYS[1]
local now, lease, limit, ticket = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3]), ARGV[4]
redis.call('ZREMRANGEBYSCORE', pool, '-inf', now)
if redis.call('ZCARD', pool) >= limit then
  local oldest = redis.call('ZRANGE', pool, 0, 0, 'WITHSCORES')
  local wait = tonumber(oldest[2]) - now
  if wait < 1 then wait = 1 end
  return {'', tostring(wait)}
end
redis.call('ZADD', pool, now + lease, ticket)
redis.call('EXPIRE', pool, lease)
return {ticket, '0'}
"""

admit_slot = r.register_script(ADMIT)


def admit(tenant: str) -> dict:
    """Take one of the tenant's GPU slots: {ticket, retry_after}; ticket None when the pool is full."""
    ticket, retry_after = admit_slot(keys=[gpu_key(tenant)], args=[int(time.time()), LEASE_S, GPU_TOKENS, str(uuid.uuid4())])
    return {"ticket": ticket or None, "retry_after": int(float(retry_after))}


def release(tenant: str, ticket: str) -> bool:
    """Give the slot back: True when this ticket held one."""
    return r.zrem(gpu_key(tenant), ticket) == 1
`,
    },
    typescript: {
      starter: `import {randomUUID} from 'node:crypto';

import Redis from 'ioredis';

import {GPU_TOKENS, gpuKey} from 'vision/config';

export const redis = new Redis({host: 'redis', port: 6379});

export const RETRY_AFTER_S = 1;

/** admit's answer: the ticket that holds a slot (null when the pool is full) and the seconds to wait. */
export interface Admission {
  ticket: string | null;
  retryAfter: number;
}

/** Take one of the tenant's GPU slots. */
export async function admit(tenant: string): Promise<Admission> {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const pool = gpuKey(tenant);
  if ((await redis.zcard(pool)) >= GPU_TOKENS) return {ticket: null, retryAfter: RETRY_AFTER_S};
  const ticket = randomUUID();
  await redis.zadd(pool, Math.floor(Date.now() / 1000), ticket);
  return {ticket, retryAfter: 0};
}

/** Give the slot back: true when this ticket held one. */
export async function release(tenant: string, ticket: string): Promise<boolean> {
  void ticket;
  return (await redis.zremrangebyrank(gpuKey(tenant), 0, 0)) === 1;
}
`,
      solution: `import {randomUUID} from 'node:crypto';

import Redis from 'ioredis';

import {GPU_TOKENS, LEASE_S, gpuKey} from 'vision/config';

const ADMIT = \`
local pool = KEYS[1]
local now, lease, limit, ticket = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3]), ARGV[4]
redis.call('ZREMRANGEBYSCORE', pool, '-inf', now)
if redis.call('ZCARD', pool) >= limit then
  local oldest = redis.call('ZRANGE', pool, 0, 0, 'WITHSCORES')
  local wait = tonumber(oldest[2]) - now
  if wait < 1 then wait = 1 end
  return {'', tostring(wait)}
end
redis.call('ZADD', pool, now + lease, ticket)
redis.call('EXPIRE', pool, lease)
return {ticket, '0'}
\`;

interface PoolRedis extends Redis {
  admitSlot(pool: string, now: number, lease: number, limit: number, ticket: string): Promise<[string, string]>;
}

export const redis = new Redis({host: 'redis', port: 6379}) as PoolRedis;
redis.defineCommand('admitSlot', {numberOfKeys: 1, lua: ADMIT});

/** admit's answer: the ticket that holds a slot (null when the pool is full) and the seconds to wait. */
export interface Admission {
  ticket: string | null;
  retryAfter: number;
}

/** Take one of the tenant's GPU slots. */
export async function admit(tenant: string): Promise<Admission> {
  const now = Math.floor(Date.now() / 1000);
  const [ticket, retryAfter] = await redis.admitSlot(gpuKey(tenant), now, LEASE_S, GPU_TOKENS, randomUUID());
  return {ticket: ticket === '' ? null : ticket, retryAfter: Math.floor(Number(retryAfter))};
}

/** Give the slot back: true when this ticket held one. */
export async function release(tenant: string, ticket: string): Promise<boolean> {
  return (await redis.zrem(gpuKey(tenant), ticket)) === 1;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"

	"vision/config" // config.GPUTokens, config.LeaseSeconds, config.GPUKey(tenant) — provided
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const retryAfterSeconds = 1

// Admission is admit's answer: the ticket that holds a slot ("" when the pool is full) and the seconds to wait.
type Admission struct {
	Ticket     string
	RetryAfter int64
}

// admit takes one of the tenant's GPU slots.
func admit(ctx context.Context, tenant string) (Admission, error) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	pool := config.GPUKey(tenant)
	held, err := rdb.ZCard(ctx, pool).Result()
	if err != nil {
		return Admission{}, err
	}
	if held >= config.GPUTokens {
		return Admission{RetryAfter: retryAfterSeconds}, nil
	}
	ticket := uuid.NewString()
	if err := rdb.ZAdd(ctx, pool, redis.Z{Score: float64(time.Now().Unix()), Member: ticket}).Err(); err != nil {
		return Admission{}, err
	}
	return Admission{Ticket: ticket}, nil
}

// release gives the slot back: true when this ticket held one.
func release(ctx context.Context, tenant, ticket string) (bool, error) {
	removed, err := rdb.ZRemRangeByRank(ctx, config.GPUKey(tenant), 0, 0).Result()
	return removed == 1, err
}

func main() {
	a, err := admit(context.Background(), "demo")
	fmt.Println(a, err)
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"

	"vision/config" // config.GPUTokens, config.LeaseSeconds, config.GPUKey(tenant) — provided
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var admitSlot = redis.NewScript(\`
local pool = KEYS[1]
local now, lease, limit, ticket = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3]), ARGV[4]
redis.call('ZREMRANGEBYSCORE', pool, '-inf', now)
if redis.call('ZCARD', pool) >= limit then
  local oldest = redis.call('ZRANGE', pool, 0, 0, 'WITHSCORES')
  local wait = tonumber(oldest[2]) - now
  if wait < 1 then wait = 1 end
  return {'', tostring(wait)}
end
redis.call('ZADD', pool, now + lease, ticket)
redis.call('EXPIRE', pool, lease)
return {ticket, '0'}
\`)

// Admission is admit's answer: the ticket that holds a slot ("" when the pool is full) and the seconds to wait.
type Admission struct {
	Ticket     string
	RetryAfter int64
}

// admit takes one of the tenant's GPU slots.
func admit(ctx context.Context, tenant string) (Admission, error) {
	args := []any{time.Now().Unix(), config.LeaseSeconds, config.GPUTokens, uuid.NewString()}
	reply, err := admitSlot.Run(ctx, rdb, []string{config.GPUKey(tenant)}, args...).Slice()
	if err != nil {
		return Admission{}, err
	}
	wait, _ := strconv.ParseFloat(fmt.Sprint(reply[1]), 64)
	return Admission{Ticket: fmt.Sprint(reply[0]), RetryAfter: int64(wait)}, nil
}

// release gives the slot back: true when this ticket held one.
func release(ctx context.Context, tenant, ticket string) (bool, error) {
	removed, err := rdb.ZRem(ctx, config.GPUKey(tenant), ticket).Result()
	return removed == 1, err
}

func main() {
	a, err := admit(context.Background(), "demo")
	fmt.Println(a, err)
}
`,
    },
    scala: {
      starter: `import java.util.UUID

import redis.clients.jedis.JedisPooled

import vision.Config

/** admit's answer: the ticket that holds a slot (None when the pool is full) and the seconds to wait. */
final case class Admission(ticket: Option[String], retryAfter: Long)

object GpuPool {
  val jedis = new JedisPooled("redis", 6379)
  val RetryAfterSeconds = 1L

  /** Take one of the tenant's GPU slots. */
  def admit(tenant: String): Admission = {
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    val pool = Config.gpuKey(tenant)
    if (jedis.zcard(pool) >= Config.GpuTokens) {
      Admission(None, RetryAfterSeconds)
    } else {
      val ticket = UUID.randomUUID().toString
      jedis.zadd(pool, (System.currentTimeMillis() / 1000).toDouble, ticket)
      Admission(Some(ticket), 0)
    }
  }

  /** Give the slot back: true when this ticket held one. */
  def release(tenant: String, ticket: String): Boolean =
    jedis.zremrangeByRank(Config.gpuKey(tenant), 0, 0) == 1L
}
`,
      solution: `import java.util.UUID

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import vision.Config

/** admit's answer: the ticket that holds a slot (None when the pool is full) and the seconds to wait. */
final case class Admission(ticket: Option[String], retryAfter: Long)

object GpuPool {
  val jedis = new JedisPooled("redis", 6379)

  val Admit: String =
    """local pool = KEYS[1]
      |local now, lease, limit, ticket = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3]), ARGV[4]
      |redis.call('ZREMRANGEBYSCORE', pool, '-inf', now)
      |if redis.call('ZCARD', pool) >= limit then
      |  local oldest = redis.call('ZRANGE', pool, 0, 0, 'WITHSCORES')
      |  local wait = tonumber(oldest[2]) - now
      |  if wait < 1 then wait = 1 end
      |  return {'', tostring(wait)}
      |end
      |redis.call('ZADD', pool, now + lease, ticket)
      |redis.call('EXPIRE', pool, lease)
      |return {ticket, '0'}
      |""".stripMargin

  /** Take one of the tenant's GPU slots. */
  def admit(tenant: String): Admission = {
    val args = List((System.currentTimeMillis() / 1000).toString, Config.LeaseSeconds.toString, Config.GpuTokens.toString, UUID.randomUUID().toString)
    val reply = jedis.eval(Admit, List(Config.gpuKey(tenant)).asJava, args.asJava).asInstanceOf[java.util.List[AnyRef]].asScala.map(_.toString)
    Admission(Some(reply(0)).filter(_.nonEmpty), reply(1).toDouble.toLong)
  }

  /** Give the slot back: true when this ticket held one. */
  def release(tenant: String, ticket: String): Boolean = jedis.zrem(Config.gpuKey(tenant), ticket) == 1L
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>

#include "ids.h"            // new_uuid() — provided
#include "vision/config.h"  // config::kGpuTokens, config::kLeaseSeconds, config::gpu_key(tenant) — provided

sw::redis::Redis redis("tcp://redis:6379");

constexpr long long kRetryAfterSeconds = 1;

// admit's answer: the ticket that holds a slot ("" when the pool is full) and the seconds to wait.
struct Admission {
  std::string ticket;
  long long retry_after = 0;
};

long long now_s() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

// Take one of the tenant's GPU slots.
Admission admit(const std::string& tenant) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const std::string pool = config::gpu_key(tenant);
  if (redis.zcard(pool) >= config::kGpuTokens) return {"", kRetryAfterSeconds};
  const std::string ticket = new_uuid();
  redis.zadd(pool, ticket, static_cast<double>(now_s()));
  return {ticket, 0};
}

// Give the slot back: true when this ticket held one.
bool release(const std::string& tenant, const std::string& ticket) {
  (void)ticket;
  return redis.zremrangebyrank(config::gpu_key(tenant), 0, 0) == 1;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>
#include <tuple>

#include "ids.h"            // new_uuid() — provided
#include "vision/config.h"  // config::kGpuTokens, config::kLeaseSeconds, config::gpu_key(tenant) — provided

sw::redis::Redis redis("tcp://redis:6379");

const std::string kAdmit = R"lua(
local pool = KEYS[1]
local now, lease, limit, ticket = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3]), ARGV[4]
redis.call('ZREMRANGEBYSCORE', pool, '-inf', now)
if redis.call('ZCARD', pool) >= limit then
  local oldest = redis.call('ZRANGE', pool, 0, 0, 'WITHSCORES')
  local wait = tonumber(oldest[2]) - now
  if wait < 1 then wait = 1 end
  return {'', tostring(wait)}
end
redis.call('ZADD', pool, now + lease, ticket)
redis.call('EXPIRE', pool, lease)
return {ticket, '0'}
)lua";

// admit's answer: the ticket that holds a slot ("" when the pool is full) and the seconds to wait.
struct Admission {
  std::string ticket;
  long long retry_after = 0;
};

long long now_s() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

// Take one of the tenant's GPU slots.
Admission admit(const std::string& tenant) {
  const auto [ticket, wait] = redis.eval<std::string, std::string>(
      kAdmit, {config::gpu_key(tenant)},
      {std::to_string(now_s()), std::to_string(config::kLeaseSeconds), std::to_string(config::kGpuTokens), new_uuid()});
  return {ticket, static_cast<long long>(std::stod(wait))};
}

// Give the slot back: true when this ticket held one.
bool release(const std::string& tenant, const std::string& ticket) { return redis.zrem(config::gpu_key(tenant), ticket) == 1; }
`,
    },
  },
  harness: {
    python: `import time

POOL = "vision:gpu:t1"


def _held(ctx):
    return ctx.redis.zcard(POOL)


def check_atomic_admit(ctx):
    m = ctx.load("state")
    now = int(time.time())
    for i in range(9):
        ctx.redis.zadd(POOL, {f"other-{i}": now + 300})  # nine slots other workers hold

    def other_worker():
        # another worker admitting into the last slot, landing between two of this worker's commands
        if ctx.redis.zcard(POOL) < 10:
            ctx.redis.zadd(POOL, {"other-racer": now + 300})
            return "admitted"
        return "refused"

    probe = ctx.redis_after(POOL, other_worker)
    mine = m.admit("t1")
    assert probe.fired, "admit never touched the pool"
    outcomes = sorted(["admitted" if mine.get("ticket") else "refused", probe.result])
    assert outcomes == ["admitted", "refused"], f"two workers raced for the last slot and the outcomes were {outcomes}: the count and the add must run in one script, so exactly one of them gets it"
    assert _held(ctx) == 10, f"a 10-slot pool holds {_held(ctx)} tickets after the race"


def check_lease_expiry(ctx):
    m = ctx.load("state")
    tickets = [m.admit("t1").get("ticket") for _ in range(10)]
    assert all(tickets), f"ten admissions into an empty 10-slot pool must all get a ticket: {tickets}"
    assert m.admit("t1").get("ticket") is None, "the eleventh admission must be refused"
    ctx.clock.advance(301)  # the ten holders crashed without releasing
    again = m.admit("t1")
    assert again.get("ticket"), f"five minutes after ten holders crashed the tenant is still locked out ({again}): a lease must end on its own"
    assert _held(ctx) == 1, f"the expired leases must be gone: the pool holds {_held(ctx)} tickets"
    score = ctx.redis.zscore(POOL, again["ticket"])
    assert score is not None and abs(score - (time.time() + 300)) <= 1, f"a ticket is scored with its lease expiry (now + LEASE_S), got {score}"


def check_owner_release(ctx):
    m = ctx.load("state")
    a, b, c = (m.admit("t1")["ticket"] for _ in range(3))
    assert m.release("t1", b) is True, "releasing a held ticket must answer True"
    held = set(ctx.redis.zrange(POOL, 0, -1))
    assert held == {a, c}, f"release(b) freed the wrong slot: the pool holds {sorted(held)}, expected a and c"
    assert m.release("t1", b) is False, "a second release of the same ticket must answer False"
    assert m.release("t1", "forged-ticket") is False, "an unknown ticket must answer False"
    assert set(ctx.redis.zrange(POOL, 0, -1)) == {a, c}, f"a stale or unknown release must free nothing: the pool holds {sorted(ctx.redis.zrange(POOL, 0, -1))}"


def check_retry_after(ctx):
    m = ctx.load("state")
    for _ in range(10):
        assert m.admit("t1").get("ticket")
    ctx.clock.advance(100)
    refused = m.admit("t1")
    assert refused.get("ticket") is None, f"a full pool must refuse: {refused}"
    wait = refused.get("retry_after")
    assert isinstance(wait, int) and 199 <= wait <= 201, f"the earliest lease ends in 200 s, retry_after says {wait!r}: a client told to come back in 1 s polls 200 times"
`,
    typescript: `const POOL = 'vision:gpu:t1';
const nowS = ctx => Math.floor(ctx.clock.now() / 1000);
const held = ctx => Number(ctx.redis.zcard(POOL));

export async function check_atomic_admit(ctx) {
  const m = ctx.load('state');
  const now = nowS(ctx);
  for (let i = 0; i < 9; i++) ctx.redis.zadd(POOL, now + 300, \`other-\${i}\`); // nine slots other workers hold
  // another worker admitting into the last slot, landing between two of this worker's commands
  const probe = ctx.redisAfter(POOL, () => {
    if (Number(ctx.redis.zcard(POOL)) < 10) {
      ctx.redis.zadd(POOL, now + 300, 'other-racer');
      return 'admitted';
    }
    return 'refused';
  });
  const mine = await m.admit('t1');
  assert(probe.fired, 'admit never touched the pool');
  const outcomes = [mine.ticket ? 'admitted' : 'refused', probe.result].sort();
  assert.deepEqual(outcomes, ['admitted', 'refused'], \`two workers raced for the last slot and the outcomes were \${JSON.stringify(outcomes)}: the count and the add must run in one script, so exactly one of them gets it\`);
  assert.equal(held(ctx), 10, \`a 10-slot pool holds \${held(ctx)} tickets after the race\`);
}

export async function check_lease_expiry(ctx) {
  const m = ctx.load('state');
  const tickets: (string | null)[] = [];
  for (let i = 0; i < 10; i++) tickets.push((await m.admit('t1')).ticket);
  assert(tickets.every(Boolean), \`ten admissions into an empty 10-slot pool must all get a ticket: \${JSON.stringify(tickets)}\`);
  assert.equal((await m.admit('t1')).ticket, null, 'the eleventh admission must be refused');
  ctx.clock.advance(301); // the ten holders crashed without releasing
  const again = await m.admit('t1');
  assert(again.ticket, \`five minutes after ten holders crashed the tenant is still locked out (\${JSON.stringify(again)}): a lease must end on its own\`);
  assert.equal(held(ctx), 1, \`the expired leases must be gone: the pool holds \${held(ctx)} tickets\`);
  const score = Number(ctx.redis.zscore(POOL, again.ticket));
  assert(Math.abs(score - (nowS(ctx) + 300)) <= 1, \`a ticket is scored with its lease expiry (now + LEASE_S), got \${score}\`);
}

export async function check_owner_release(ctx) {
  const m = ctx.load('state');
  const [a, b, c] = [(await m.admit('t1')).ticket, (await m.admit('t1')).ticket, (await m.admit('t1')).ticket];
  assert.equal(await m.release('t1', b), true, 'releasing a held ticket must answer true');
  const members = () => [...ctx.redis.zrange(POOL, 0, -1)].sort();
  assert.deepEqual(members(), [a, c].sort(), \`release(b) freed the wrong slot: the pool holds \${JSON.stringify(members())}, expected a and c\`);
  assert.equal(await m.release('t1', b), false, 'a second release of the same ticket must answer false');
  assert.equal(await m.release('t1', 'forged-ticket'), false, 'an unknown ticket must answer false');
  assert.deepEqual(members(), [a, c].sort(), \`a stale or unknown release must free nothing: the pool holds \${JSON.stringify(members())}\`);
}

export async function check_retry_after(ctx) {
  const m = ctx.load('state');
  for (let i = 0; i < 10; i++) assert((await m.admit('t1')).ticket);
  ctx.clock.advance(100);
  const refused = await m.admit('t1');
  assert.equal(refused.ticket, null, \`a full pool must refuse: \${JSON.stringify(refused)}\`);
  const wait = refused.retryAfter;
  assert(Number.isInteger(wait) && wait >= 199 && wait <= 201, \`the earliest lease ends in 200 s, retryAfter says \${wait}: a client told to come back in 1 s polls 200 times\`);
}
`,
    go: `package main

import (
	"context"
	"math"
	"sort"

	"leetbuild/harness"
)

const statePool = "vision:gpu:t1"

func stateAdmit(ctx *harness.Ctx) Admission {
	a, err := admit(context.Background(), "t1")
	ctx.NoError(err, "admit")
	return a
}

func stateRelease(ctx *harness.Ctx, ticket string) bool {
	ok, err := release(context.Background(), "t1", ticket)
	ctx.NoError(err, "release")
	return ok
}

func stateHeld(ctx *harness.Ctx) []string {
	var out []string
	for _, z := range ctx.Redis.ZRangeWithScores(statePool, 0, -1) {
		out = append(out, z.Member)
	}
	sort.Strings(out)
	return out
}

func CheckAtomicAdmit(ctx *harness.Ctx) {
	now := ctx.Clock.Now() / 1000
	for i := 0; i < 9; i++ {
		ctx.Redis.Do("ZADD", statePool, now+300, "other-"+string(rune('a'+i))) // nine slots other workers hold
	}
	other := ""
	// another worker admitting into the last slot, landing between two of this worker's commands
	ctx.Redis.After(statePool, func() any {
		if ctx.Redis.ZCard(statePool) < 10 {
			ctx.Redis.Do("ZADD", statePool, now+300, "other-racer")
			other = "admitted"
			return nil
		}
		other = "refused"
		return nil
	})
	mine := stateAdmit(ctx)
	ctx.Assert(other != "", "admit never touched the pool")
	outcomes := []string{other, "refused"}
	if mine.Ticket != "" {
		outcomes[1] = "admitted"
	}
	sort.Strings(outcomes)
	ctx.Equal(outcomes, []string{"admitted", "refused"}, "two workers raced for the last slot: the count and the add must run in one script, so exactly one of them gets it; the outcomes")
	ctx.Equal(ctx.Redis.ZCard(statePool), 10, "a 10-slot pool after the race; tickets held")
}

func CheckLeaseExpiry(ctx *harness.Ctx) {
	for i := 0; i < 10; i++ {
		ctx.Assert(stateAdmit(ctx).Ticket != "", "ten admissions into an empty 10-slot pool must all get a ticket (admission %d did not)", i+1)
	}
	ctx.Equal(stateAdmit(ctx).Ticket, "", "the eleventh admission must be refused; its ticket")
	ctx.Clock.Advance(301) // the ten holders crashed without releasing
	again := stateAdmit(ctx)
	ctx.Assert(again.Ticket != "", "five minutes after ten holders crashed the tenant is still locked out (%+v): a lease must end on its own", again)
	ctx.Equal(ctx.Redis.ZCard(statePool), 1, "the expired leases must be gone; tickets held")
	score, ok := ctx.Redis.ZScore(statePool, again.Ticket)
	ctx.Assert(ok && math.Abs(score-float64(ctx.Clock.Now()/1000+300)) <= 1, "a ticket is scored with its lease expiry (now + LeaseSeconds), got %v", score)
}

func CheckOwnerRelease(ctx *harness.Ctx) {
	a, b, c := stateAdmit(ctx).Ticket, stateAdmit(ctx).Ticket, stateAdmit(ctx).Ticket
	want := []string{a, c}
	sort.Strings(want)
	ctx.Assert(stateRelease(ctx, b), "releasing a held ticket must answer true")
	ctx.Equal(stateHeld(ctx), want, "release(b) must free b's slot only; the pool holds")
	ctx.Assert(!stateRelease(ctx, b), "a second release of the same ticket must answer false")
	ctx.Assert(!stateRelease(ctx, "forged-ticket"), "an unknown ticket must answer false")
	ctx.Equal(stateHeld(ctx), want, "a stale or unknown release must free nothing; the pool holds")
}

func CheckRetryAfter(ctx *harness.Ctx) {
	for i := 0; i < 10; i++ {
		ctx.Assert(stateAdmit(ctx).Ticket != "", "admission %d into an empty pool", i+1)
	}
	ctx.Clock.Advance(100)
	refused := stateAdmit(ctx)
	ctx.Equal(refused.Ticket, "", "a full pool must refuse; the ticket")
	ctx.Assert(refused.RetryAfter >= 199 && refused.RetryAfter <= 201, "the earliest lease ends in 200 s, RetryAfter says %d: a client told to come back in 1 s polls 200 times", refused.RetryAfter)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <algorithm>
#include <cmath>
#include <string>
#include <vector>

namespace {

const std::string kPool = "vision:gpu:t1";

std::vector<std::string> held(harness::Ctx& ctx) {
  std::vector<std::string> out;
  for (const auto& z : ctx.Redis.ZRangeWithScores(kPool, 0, -1)) out.push_back(z.Member);
  std::sort(out.begin(), out.end());
  return out;
}

}  // namespace

void CheckAtomicAdmit(harness::Ctx& ctx) {
  const long long now = ctx.Clock.Now() / 1000;
  for (int i = 0; i < 9; i++) ctx.Redis.Do("ZADD", kPool, now + 300, "other-" + std::to_string(i));  // nine slots other workers hold
  std::string other;
  // another worker admitting into the last slot, landing between two of this worker's commands
  ctx.Redis.After(kPool, [&] {
    if (ctx.Redis.ZCard(kPool) < 10) {
      ctx.Redis.Do("ZADD", kPool, now + 300, "other-racer");
      other = "admitted";
      return;
    }
    other = "refused";
  });
  const Admission mine = admit("t1");
  ctx.Assert(!other.empty(), "admit never touched the pool");
  std::vector<std::string> outcomes = {mine.ticket.empty() ? "refused" : "admitted", other};
  std::sort(outcomes.begin(), outcomes.end());
  ctx.Equal(outcomes, {"admitted", "refused"}, "two workers raced for the last slot: the count and the add must run in one script, so exactly one of them gets it; the outcomes");
  ctx.Equal(ctx.Redis.ZCard(kPool), 10, "a 10-slot pool after the race; tickets held");
}

void CheckLeaseExpiry(harness::Ctx& ctx) {
  for (int i = 0; i < 10; i++) ctx.Assert(!admit("t1").ticket.empty(), "ten admissions into an empty 10-slot pool must all get a ticket (admission %d did not)", i + 1);
  ctx.Equal(admit("t1").ticket, "", "the eleventh admission must be refused; its ticket");
  ctx.Clock.Advance(301);  // the ten holders crashed without releasing
  const Admission again = admit("t1");
  ctx.Assert(!again.ticket.empty(), "five minutes after ten holders crashed the tenant is still locked out (retry_after %d): a lease must end on its own", again.retry_after);
  ctx.Equal(ctx.Redis.ZCard(kPool), 1, "the expired leases must be gone; tickets held");
  const auto score = ctx.Redis.ZScore(kPool, again.ticket);
  ctx.Assert(score && std::abs(*score - static_cast<double>(ctx.Clock.Now() / 1000 + 300)) <= 1, "a ticket is scored with its lease expiry (now + kLeaseSeconds), got %v", score.value_or(-1));
}

void CheckOwnerRelease(harness::Ctx& ctx) {
  const std::string a = admit("t1").ticket;
  const std::string b = admit("t1").ticket;
  const std::string c = admit("t1").ticket;
  std::vector<std::string> want = {a, c};
  std::sort(want.begin(), want.end());
  ctx.Assert(release("t1", b), "releasing a held ticket must answer true");
  ctx.Equal(held(ctx), want, "release(b) must free b's slot only; the pool holds");
  ctx.Assert(!release("t1", b), "a second release of the same ticket must answer false");
  ctx.Assert(!release("t1", "forged-ticket"), "an unknown ticket must answer false");
  ctx.Equal(held(ctx), want, "a stale or unknown release must free nothing; the pool holds");
}

void CheckRetryAfter(harness::Ctx& ctx) {
  for (int i = 0; i < 10; i++) ctx.Assert(!admit("t1").ticket.empty(), "admission %d into an empty pool", i + 1);
  ctx.Clock.Advance(100);
  const Admission refused = admit("t1");
  ctx.Equal(refused.ticket, "", "a full pool must refuse; the ticket");
  ctx.Assert(refused.retry_after >= 199 && refused.retry_after <= 201, "the earliest lease ends in 200 s, retry_after says %d: a client told to come back in 1 s polls 200 times", refused.retry_after);
}
`,
  },
  debrief: `The pool is a lease table, not a counter, which is what gives the fix its shape. A sorted set scored by lease expiry answers three questions in one script: which holders are still alive (\`ZREMRANGEBYSCORE\` up to now), whether there is room, and when the next slot frees (the lowest score). Doing it server-side is what keeps two workers from both seeing nine. Release by ticket makes the holder the only one who can give a slot back, and a crashed holder needs no one to clean up after it. Production schedulers renew a lease from a heartbeat while the job runs, so a long inference does not lose its slot mid-flight, and weight slots by model size, since a large model takes more GPU memory than a small one.`,
};
