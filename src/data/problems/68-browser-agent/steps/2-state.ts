import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'One atomic step transition with a lease that expires',
  concept: 'redis',
  guides: ['leases', 'atomic-state'],
  file: 'state',
  focus: ['worker', 'redis'],
  task: `## Task

**Starting point.** The starter is the transition every driver worker runs before it acts:
\`begin_step(session_id, worker)\` reads the session's lease (\`lease_key\`, \`browser:lease:{id}\`),
refuses another worker's with \`LEASE_HELD\`, writes the caller as the holder and charges one step
on \`browser:session:{id}\` (\`budget_remaining\` down, \`step_index\` up), returning the new index.
It serves the demo and hides three flaws.

**Failure mode the checks target.** Two workers that pick up the same session at once both read an
empty lease and both act; a worker that crashes holds its session for good; a session out of
budget keeps taking steps.

- The transition is **one Lua script** (\`register_script\`/\`EVAL\`): read the lease, refuse
  another holder, check the budget, take the lease, charge the step.
- The lease expires **\`LEASE_TTL_MS\` = 45 000 ms** after the holder's last step (\`SET … PX\`);
  the holder's next step refreshes it.
- At \`budget_remaining\` 0 the script sets \`status\` to \`budget_exhausted\` and returns
  \`BUDGET_EXHAUSTED\` without charging anything.`,
  sequence: {
    participants: ['Worker A', 'Worker B', 'Redis'],
    messages: [
      {
        from: 'Worker A',
        to: 'Redis',
        label: 'EVAL begin_step KEYS session, lease · ARGV worker-a, 45000',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Worker A', label: 'step 1 · lease worker-a PX 45000', kind: 'reply'},
      {from: 'Worker B', to: 'Redis', label: 'EVAL begin_step … worker-b', kind: 'sync'},
      {from: 'Redis', to: 'Worker B', label: 'LEASE_HELD', kind: 'reply'},
      {from: 'Worker B', to: 'Redis', label: '45 s after A’s last step: EVAL begin_step … worker-b', kind: 'sync'},
      {from: 'Redis', to: 'Worker B', label: 'step 2 · or BUDGET_EXHAUSTED at 0', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'lease-guard',
      title: 'Takes the lease and charges the step in one script',
      detail:
        'The lease is read, compared and taken inside one Lua script (`register_script`/`defineCommand`/`NewScript`/`eval`) that also charges the step, so a second worker cannot land between the read and the write; the starter reads the lease with a client `GET` and writes it later.',
      match: {
        python: {
          all: [/register_script\(|\.eval\(/, /redis\.call\(\s*['"]GET['"]/],
          none: [/\br\.get\(\s*lease_key\(/],
        },
        typescript: {
          all: [/defineCommand\(|\.eval\(/, /redis\.call\(\s*['"]GET['"]/],
          none: [/redis\.get\(\s*leaseKey\(/],
        },
        go: {
          all: [/redis\.NewScript\(|\.Eval\(/, /redis\.call\(\s*['"]GET['"]/],
          none: [/rdb\.Get\(\s*ctx,\s*leaseKey\(/],
        },
        scala: {all: [/jedis\.eval(sha)?\(/, /redis\.call\(\s*['"]GET['"]/], none: [/jedis\.get\(\s*leaseKey\(/]},
        cpp: {all: [/redis\.eval(sha)?[<(]/, /redis\.call\(\s*['"]GET['"]/], none: [/redis\.get\(\s*leaseKey\(/]},
      },
    },
    {
      id: 'lease-ttl',
      title: 'The lease expires 45 seconds after the last step',
      detail:
        'The command that writes the lease gives it its `LEASE_TTL_MS` expiry (`SET … PX`), refreshed by each step of its holder, so a crashed worker’s session is free 45 seconds later; the starter’s lease never expires.',
      match: {
        python: {all: [/['"]PX['"]|\bpx\s*=|pexpire/i, /LEASE_TTL_MS\s*=\s*45_?000\b/]},
        typescript: {all: [/['"]PX['"]|pexpire/i, /LEASE_TTL_MS\s*=\s*45_?000\b/]},
        go: {all: [/['"]PX['"]|PExpire/i, /leaseTTLMs\s*=\s*45_?000\b/]},
        scala: {all: [/['"]PX['"]|pexpire/i, /LeaseTtlMs\s*=\s*45_?000L?\b/]},
        cpp: {all: [/['"]PX['"]|pexpire/i, /kLeaseTtlMs\s*=\s*45'?000\b/]},
      },
    },
    {
      id: 'budget',
      title: 'An exhausted budget refuses the step and records it',
      detail:
        'Before charging, the script compares `budget_remaining` with zero; at zero it sets `status` to `budget_exhausted` and returns `BUDGET_EXHAUSTED`, so two steps at once on the last unit of budget take exactly one. The starter charges every step and lets the budget go negative.',
      match: {
        python: {all: [/['"]budget_exhausted['"]/, /<=\s*0\b|<\s*1\b/]},
        typescript: {all: [/['"]budget_exhausted['"]/, /<=\s*0\b|<\s*1\b/]},
        go: {all: [/['"]budget_exhausted['"]/, /<=\s*0\b|<\s*1\b/]},
        scala: {all: [/['"]budget_exhausted['"]/, /<=\s*0\b|<\s*1\b/]},
        cpp: {all: [/['"]budget_exhausted['"]/, /<=\s*0\b|<\s*1\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

from browser.sessions import session_key

r = redis.Redis(host="redis", port=6379, decode_responses=True)

LEASE_TTL_MS = 45_000
LEASE_HELD = -1
BUDGET_EXHAUSTED = -2
NO_SESSION = -3


def lease_key(session_id: str) -> str:
    return f"browser:lease:{session_id}"


def begin_step(session_id: str, worker: str) -> int:
    """Take or refresh worker's lease and charge one step: the new step index, LEASE_HELD, BUDGET_EXHAUSTED or NO_SESSION."""
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    key = session_key(session_id)
    if not r.exists(key):
        return NO_SESSION
    owner = r.get(lease_key(session_id))
    if owner is not None and owner != worker:
        return LEASE_HELD
    r.set(lease_key(session_id), worker)
    r.hincrby(key, "budget_remaining", -1)
    return r.hincrby(key, "step_index", 1)
`,
      solution: `import redis

from browser.sessions import session_key

r = redis.Redis(host="redis", port=6379, decode_responses=True)

LEASE_TTL_MS = 45_000
LEASE_HELD = -1
BUDGET_EXHAUSTED = -2
NO_SESSION = -3

# KEYS[1] the session hash, KEYS[2] its lease; ARGV[1] the worker, ARGV[2] the lease TTL in ms.
BEGIN_STEP_LUA = """
if redis.call('EXISTS', KEYS[1]) == 0 then return -3 end
local owner = redis.call('GET', KEYS[2])
if owner and owner ~= ARGV[1] then return -1 end
if tonumber(redis.call('HGET', KEYS[1], 'budget_remaining')) <= 0 then
  redis.call('HSET', KEYS[1], 'status', 'budget_exhausted')
  return -2
end
redis.call('SET', KEYS[2], ARGV[1], 'PX', ARGV[2])
redis.call('HINCRBY', KEYS[1], 'budget_remaining', -1)
return redis.call('HINCRBY', KEYS[1], 'step_index', 1)
"""
begin = r.register_script(BEGIN_STEP_LUA)


def lease_key(session_id: str) -> str:
    return f"browser:lease:{session_id}"


def begin_step(session_id: str, worker: str) -> int:
    """Take or refresh worker's lease and charge one step: the new step index, LEASE_HELD, BUDGET_EXHAUSTED or NO_SESSION."""
    # One script: no other worker runs between reading the lease and taking it.
    return int(begin(keys=[session_key(session_id), lease_key(session_id)], args=[worker, LEASE_TTL_MS]))
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import {sessionKey} from 'browser/sessions';

const redis = new Redis({host: 'redis', port: 6379});

export const LEASE_TTL_MS = 45_000;
export const LEASE_HELD = -1;
export const BUDGET_EXHAUSTED = -2;
export const NO_SESSION = -3;

export const leaseKey = (sessionId: string): string => \`browser:lease:\${sessionId}\`;

/** Take or refresh worker's lease and charge one step: the new step index, LEASE_HELD, BUDGET_EXHAUSTED or NO_SESSION. */
export async function beginStep(sessionId: string, worker: string): Promise<number> {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const key = sessionKey(sessionId);
  if ((await redis.exists(key)) === 0) return NO_SESSION;
  const owner = await redis.get(leaseKey(sessionId));
  if (owner !== null && owner !== worker) return LEASE_HELD;
  await redis.set(leaseKey(sessionId), worker);
  await redis.hincrby(key, 'budget_remaining', -1);
  return redis.hincrby(key, 'step_index', 1);
}
`,
      solution: `import Redis from 'ioredis';

import {sessionKey} from 'browser/sessions';

export const LEASE_TTL_MS = 45_000;
export const LEASE_HELD = -1;
export const BUDGET_EXHAUSTED = -2;
export const NO_SESSION = -3;

// KEYS[1] the session hash, KEYS[2] its lease; ARGV[1] the worker, ARGV[2] the lease TTL in ms.
export const BEGIN_STEP_LUA = \`
if redis.call('EXISTS', KEYS[1]) == 0 then return -3 end
local owner = redis.call('GET', KEYS[2])
if owner and owner ~= ARGV[1] then return -1 end
if tonumber(redis.call('HGET', KEYS[1], 'budget_remaining')) <= 0 then
  redis.call('HSET', KEYS[1], 'status', 'budget_exhausted')
  return -2
end
redis.call('SET', KEYS[2], ARGV[1], 'PX', ARGV[2])
redis.call('HINCRBY', KEYS[1], 'budget_remaining', -1)
return redis.call('HINCRBY', KEYS[1], 'step_index', 1)
\`;

interface LeaseRedis extends Redis {
  beginStep(session: string, lease: string, worker: string, ttlMs: number): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as LeaseRedis;
redis.defineCommand('beginStep', {numberOfKeys: 2, lua: BEGIN_STEP_LUA});

export const leaseKey = (sessionId: string): string => \`browser:lease:\${sessionId}\`;

/** Take or refresh worker's lease and charge one step: the new step index, LEASE_HELD, BUDGET_EXHAUSTED or NO_SESSION. */
export async function beginStep(sessionId: string, worker: string): Promise<number> {
  // One script: no other worker runs between reading the lease and taking it.
  return Number(await redis.beginStep(sessionKey(sessionId), leaseKey(sessionId), worker, LEASE_TTL_MS));
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"github.com/redis/go-redis/v9"

	"browser/sessions" // sessions.SessionKey
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	leaseTTLMs      = 45000
	leaseHeld       = -1
	budgetExhausted = -2
	noSession       = -3
)

func leaseKey(sessionID string) string { return "browser:lease:" + sessionID }

// beginStep takes or refreshes worker's lease and charges one step: the new step index, leaseHeld,
// budgetExhausted or noSession.
func beginStep(ctx context.Context, sessionID, worker string) (int, error) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	key := sessions.SessionKey(sessionID)
	if rdb.Exists(ctx, key).Val() == 0 {
		return noSession, nil
	}
	owner, err := rdb.Get(ctx, leaseKey(sessionID)).Result()
	if err != nil && err != redis.Nil {
		return 0, err
	}
	if err == nil && owner != worker {
		return leaseHeld, nil
	}
	if err := rdb.Set(ctx, leaseKey(sessionID), worker, 0).Err(); err != nil {
		return 0, err
	}
	rdb.HIncrBy(ctx, key, "budget_remaining", -1)
	step, err := rdb.HIncrBy(ctx, key, "step_index", 1).Result()
	return int(step), err
}
`,
      solution: `package main

import (
	"context"

	"github.com/redis/go-redis/v9"

	"browser/sessions" // sessions.SessionKey
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	leaseTTLMs      = 45000
	leaseHeld       = -1
	budgetExhausted = -2
	noSession       = -3
)

// KEYS[1] the session hash, KEYS[2] its lease; ARGV[1] the worker, ARGV[2] the lease TTL in ms.
var beginStepScript = redis.NewScript(\`
if redis.call('EXISTS', KEYS[1]) == 0 then return -3 end
local owner = redis.call('GET', KEYS[2])
if owner and owner ~= ARGV[1] then return -1 end
if tonumber(redis.call('HGET', KEYS[1], 'budget_remaining')) <= 0 then
  redis.call('HSET', KEYS[1], 'status', 'budget_exhausted')
  return -2
end
redis.call('SET', KEYS[2], ARGV[1], 'PX', ARGV[2])
redis.call('HINCRBY', KEYS[1], 'budget_remaining', -1)
return redis.call('HINCRBY', KEYS[1], 'step_index', 1)
\`)

func leaseKey(sessionID string) string { return "browser:lease:" + sessionID }

// beginStep takes or refreshes worker's lease and charges one step: the new step index, leaseHeld,
// budgetExhausted or noSession.
func beginStep(ctx context.Context, sessionID, worker string) (int, error) {
	// One script: no other worker runs between reading the lease and taking it.
	return beginStepScript.Run(ctx, rdb, []string{sessions.SessionKey(sessionID), leaseKey(sessionID)}, worker, leaseTTLMs).Int()
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

import browser.Sessions // Sessions.sessionKey

object State {
  val jedis = new JedisPooled("redis", 6379)

  val LeaseTtlMs = 45000L
  val LeaseHeld = -1L
  val BudgetExhausted = -2L
  val NoSession = -3L

  def leaseKey(sessionId: String): String = s"browser:lease:$sessionId"

  /** Take or refresh worker's lease and charge one step: the new step index, LeaseHeld, BudgetExhausted or NoSession. */
  def beginStep(sessionId: String, worker: String): Long = {
    // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    val key = Sessions.sessionKey(sessionId)
    if (!jedis.exists(key)) NoSession
    else
      Option(jedis.get(leaseKey(sessionId))) match {
        case Some(owner) if owner != worker => LeaseHeld
        case _ =>
          jedis.set(leaseKey(sessionId), worker)
          jedis.hincrBy(key, "budget_remaining", -1)
          jedis.hincrBy(key, "step_index", 1)
      }
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import browser.Sessions // Sessions.sessionKey

object State {
  val jedis = new JedisPooled("redis", 6379)

  val LeaseTtlMs = 45000L
  val LeaseHeld = -1L
  val BudgetExhausted = -2L
  val NoSession = -3L

  /** KEYS[1] the session hash, KEYS[2] its lease; ARGV[1] the worker, ARGV[2] the lease TTL in ms. */
  val BeginStepLua: String =
    """if redis.call('EXISTS', KEYS[1]) == 0 then return -3 end
      |local owner = redis.call('GET', KEYS[2])
      |if owner and owner ~= ARGV[1] then return -1 end
      |if tonumber(redis.call('HGET', KEYS[1], 'budget_remaining')) <= 0 then
      |  redis.call('HSET', KEYS[1], 'status', 'budget_exhausted')
      |  return -2
      |end
      |redis.call('SET', KEYS[2], ARGV[1], 'PX', ARGV[2])
      |redis.call('HINCRBY', KEYS[1], 'budget_remaining', -1)
      |return redis.call('HINCRBY', KEYS[1], 'step_index', 1)
      |""".stripMargin

  def leaseKey(sessionId: String): String = s"browser:lease:$sessionId"

  /** Take or refresh worker's lease and charge one step: the new step index, LeaseHeld, BudgetExhausted or NoSession. */
  def beginStep(sessionId: String, worker: String): Long =
    // One script: no other worker runs between reading the lease and taking it.
    jedis.eval(BeginStepLua, List(Sessions.sessionKey(sessionId), leaseKey(sessionId)).asJava, List(worker, LeaseTtlMs.toString).asJava)
      .asInstanceOf[java.lang.Long]
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <string>

#include "browser/sessions.h"  // sessions::sessionKey

sw::redis::Redis redis("tcp://redis:6379");

constexpr long kLeaseTtlMs = 45000;
constexpr long kLeaseHeld = -1;
constexpr long kBudgetExhausted = -2;
constexpr long kNoSession = -3;

std::string leaseKey(const std::string& session_id) { return "browser:lease:" + session_id; }

// Take or refresh worker's lease and charge one step: the new step index, kLeaseHeld,
// kBudgetExhausted or kNoSession.
long beginStep(const std::string& session_id, const std::string& worker) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const std::string key = sessions::sessionKey(session_id);
  if (!redis.exists(key)) return kNoSession;
  const auto owner = redis.get(leaseKey(session_id));
  if (owner && *owner != worker) return kLeaseHeld;
  redis.set(leaseKey(session_id), worker);
  redis.hincrby(key, "budget_remaining", -1);
  return static_cast<long>(redis.hincrby(key, "step_index", 1));
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <string>

#include "browser/sessions.h"  // sessions::sessionKey

sw::redis::Redis redis("tcp://redis:6379");

constexpr long kLeaseTtlMs = 45000;
constexpr long kLeaseHeld = -1;
constexpr long kBudgetExhausted = -2;
constexpr long kNoSession = -3;

// KEYS[1] the session hash, KEYS[2] its lease; ARGV[1] the worker, ARGV[2] the lease TTL in ms.
const std::string kBeginStepLua = R"lua(
if redis.call('EXISTS', KEYS[1]) == 0 then return -3 end
local owner = redis.call('GET', KEYS[2])
if owner and owner ~= ARGV[1] then return -1 end
if tonumber(redis.call('HGET', KEYS[1], 'budget_remaining')) <= 0 then
  redis.call('HSET', KEYS[1], 'status', 'budget_exhausted')
  return -2
end
redis.call('SET', KEYS[2], ARGV[1], 'PX', ARGV[2])
redis.call('HINCRBY', KEYS[1], 'budget_remaining', -1)
return redis.call('HINCRBY', KEYS[1], 'step_index', 1)
)lua";

std::string leaseKey(const std::string& session_id) { return "browser:lease:" + session_id; }

// Take or refresh worker's lease and charge one step: the new step index, kLeaseHeld,
// kBudgetExhausted or kNoSession.
long beginStep(const std::string& session_id, const std::string& worker) {
  // One script: no other worker runs between reading the lease and taking it.
  return static_cast<long>(
      redis.eval<long long>(kBeginStepLua, {sessions::sessionKey(session_id), leaseKey(session_id)}, {worker, std::to_string(kLeaseTtlMs)}));
}
`,
    },
  },
  harness: {
    python: `from browser import sessions


def _session(max_steps=10):
    return sessions.create_session("acme", "public-web", "buy a kettle", max_steps, "https://www.example.com/")["session_id"]


def check_lease_guard(ctx):
    m = ctx.load("state")
    sid = _session()
    # Worker B picks the session up right after worker A's first command on its lease.
    rival = ctx.redis_after(f"browser:lease:{sid}", lambda: m.begin_step(sid, "worker-b"))
    mine = m.begin_step(sid, "worker-a")
    assert rival.fired, f"begin_step never touched browser:lease:{sid}"
    if rival.error is not None:
        raise rival.error
    assert sorted([mine, rival.result]) == [m.LEASE_HELD, 1], f"two workers began a step on one session at the same moment and got {mine} and {rival.result}: exactly one may win (step 1), the other must get LEASE_HELD ({m.LEASE_HELD})"
    session = sessions.load_session(sid)
    assert session["step_index"] == 1 and session["budget_remaining"] == 9, f"after one won step the session holds step_index {session['step_index']}, budget_remaining {session['budget_remaining']}, expected 1 and 9"
    winner, loser = ("worker-a", "worker-b") if mine == 1 else ("worker-b", "worker-a")
    assert m.begin_step(sid, winner) == 2, "the lease holder must be able to take the next step (2)"
    assert m.begin_step(sid, loser) == m.LEASE_HELD, "the other worker must still get LEASE_HELD"
    # The command that takes the lease charges the step: no crash or rival lands between the two.
    other = _session()
    lease = f"browser:lease:{other}"
    seen = ctx.redis_after(lease, lambda: (ctx.redis.exists(lease), sessions.load_session(other)))
    assert m.begin_step(other, "worker-a") == 1, "the first step of a fresh session must be 1"
    assert seen.fired, f"begin_step never touched {lease}"
    held, snapshot = seen.result
    assert not held or (snapshot["step_index"] == 1 and snapshot["budget_remaining"] == 9), f"right after the command that took {lease} the session held step_index {snapshot['step_index']}, budget_remaining {snapshot['budget_remaining']}: take the lease and charge the step in the same script"


def check_lease_ttl(ctx):
    m = ctx.load("state")
    sid = _session()
    lease = f"browser:lease:{sid}"
    written = ctx.redis_after(lease, lambda: ctx.redis.pttl(lease))
    assert m.begin_step(sid, "worker-a") == 1, "the first step of a fresh session must be 1"
    assert written.result == -2 or 44_000 <= written.result <= 45_000, f"right after the command that wrote {lease} its TTL was {written.result} ms: the command that writes the lease gives it its LEASE_TTL_MS (45000 ms) expiry (SET … PX)"
    ttl = ctx.redis.pttl(lease)
    assert 44_000 <= ttl <= 45_000, f"{lease} has a TTL of {ttl} ms: a lease that never expires keeps a crashed worker's session stuck. It must expire LEASE_TTL_MS (45000 ms) after the holder's last step"
    assert m.begin_step(sid, "worker-b") == m.LEASE_HELD, "while worker-a's lease is live worker-b must get LEASE_HELD"
    ctx.clock.advance(30)
    assert m.begin_step(sid, "worker-a") == 2, "the holder's next step (30 s later) must go through and refresh its lease"
    ctx.clock.advance(30)
    assert m.begin_step(sid, "worker-b") == m.LEASE_HELD, "30 s after the holder's last step its lease is still live: worker-b must get LEASE_HELD"
    ctx.clock.advance(16)
    got = m.begin_step(sid, "worker-b")
    assert got == 3, f"46 s after worker-a's last step its lease has expired, yet worker-b got {got}: the next worker must resume the session at step 3"


def check_budget(ctx):
    m = ctx.load("state")
    sid = _session(max_steps=2)
    assert [m.begin_step(sid, "worker-a"), m.begin_step(sid, "worker-a")] == [1, 2], "a 2-step session must take steps 1 and 2"
    third = m.begin_step(sid, "worker-a")
    assert third == m.BUDGET_EXHAUSTED, f"a third step on a 2-step budget answered {third}: it must be refused with BUDGET_EXHAUSTED ({m.BUDGET_EXHAUSTED})"
    session = sessions.load_session(sid)
    assert session["step_index"] == 2 and session["budget_remaining"] == 0, f"the refused step was charged: step_index {session['step_index']}, budget_remaining {session['budget_remaining']}, expected 2 and 0"
    assert session["status"] == "budget_exhausted", f"the session's status is {session['status']!r} after its budget ran out, expected budget_exhausted"
    assert m.begin_step("s-404", "worker-a") == m.NO_SESSION, "a step on a session that does not exist must answer NO_SESSION"
    # The same worker's two steps on the last unit of budget: exactly one is charged.
    last = _session(max_steps=1)
    rival = ctx.redis_after(sessions.session_key(last), lambda: m.begin_step(last, "worker-a"))
    mine = m.begin_step(last, "worker-a")
    assert rival.fired, f"begin_step never touched {sessions.session_key(last)}"
    if rival.error is not None:
        raise rival.error
    session = sessions.load_session(last)
    assert sorted([mine, rival.result]) == [m.BUDGET_EXHAUSTED, 1] and session["budget_remaining"] == 0, f"two steps at once on a 1-step budget got {mine} and {rival.result} and left budget_remaining {session['budget_remaining']}: compare the budget in the script that charges it, so exactly one step is taken"
`,
    typescript: `async function session(ctx, maxSteps = 10): Promise<string> {
  const sessions = ctx.load('/support/browser/sessions.ts');
  return (await sessions.createSession('acme', 'public-web', 'buy a kettle', maxSteps, 'https://www.example.com/')).session_id;
}

export async function check_lease_guard(ctx) {
  const m = ctx.load('state');
  const sessions = ctx.load('/support/browser/sessions.ts');
  const sid = await session(ctx);
  // Worker B picks the session up right after worker A's first command on its lease.
  const rival = ctx.redisAfter(\`browser:lease:\${sid}\`, () => m.beginStep(sid, 'worker-b'));
  const mine = await m.beginStep(sid, 'worker-a');
  assert(rival.fired, \`beginStep never touched browser:lease:\${sid}\`);
  if (rival.error !== undefined) throw rival.error;
  const theirs = await rival.result;
  assert.deepStrictEqual([mine, theirs].sort((a, b) => a - b), [m.LEASE_HELD, 1], \`two workers began a step on one session at the same moment and got \${mine} and \${theirs}: exactly one may win (step 1), the other must get LEASE_HELD (\${m.LEASE_HELD})\`);
  const s = await sessions.loadSession(sid);
  assert(s.step_index === 1 && s.budget_remaining === 9, \`after one won step the session holds step_index \${s.step_index}, budget_remaining \${s.budget_remaining}, expected 1 and 9\`);
  const [winner, loser] = mine === 1 ? ['worker-a', 'worker-b'] : ['worker-b', 'worker-a'];
  assert.equal(await m.beginStep(sid, winner), 2, 'the lease holder must be able to take the next step (2)');
  assert.equal(await m.beginStep(sid, loser), m.LEASE_HELD, 'the other worker must still get LEASE_HELD');
  // The command that takes the lease charges the step: no crash or rival lands between the two.
  const other = await session(ctx);
  const lease = \`browser:lease:\${other}\`;
  const seen = ctx.redisAfter(lease, () => ({held: ctx.redis.exists(lease), snapshot: ctx.redis.hgetall(\`browser:session:\${other}\`)}));
  assert.equal(await m.beginStep(other, 'worker-a'), 1, 'the first step of a fresh session must be 1');
  assert(seen.fired, \`beginStep never touched \${lease}\`);
  const {held, snapshot} = seen.result;
  assert(!held || (Number(snapshot.step_index) === 1 && Number(snapshot.budget_remaining) === 9), \`right after the command that took \${lease} the session held step_index \${snapshot.step_index}, budget_remaining \${snapshot.budget_remaining}: take the lease and charge the step in the same script\`);
}

export async function check_lease_ttl(ctx) {
  const m = ctx.load('state');
  const sid = await session(ctx);
  const lease = \`browser:lease:\${sid}\`;
  const written = ctx.redisAfter(lease, () => ctx.redis.pttl(lease));
  assert.equal(await m.beginStep(sid, 'worker-a'), 1, 'the first step of a fresh session must be 1');
  assert(written.result === -2 || (written.result >= 44_000 && written.result <= 45_000), \`right after the command that wrote \${lease} its TTL was \${written.result} ms: the command that writes the lease gives it its LEASE_TTL_MS (45000 ms) expiry (SET … PX)\`);
  const ttl = ctx.redis.pttl(lease);
  assert(ttl >= 44_000 && ttl <= 45_000, \`\${lease} has a TTL of \${ttl} ms: a lease that never expires keeps a crashed worker's session stuck. It must expire LEASE_TTL_MS (45000 ms) after the holder's last step\`);
  assert.equal(await m.beginStep(sid, 'worker-b'), m.LEASE_HELD, "while worker-a's lease is live worker-b must get LEASE_HELD");
  ctx.clock.advance(30);
  assert.equal(await m.beginStep(sid, 'worker-a'), 2, "the holder's next step (30 s later) must go through and refresh its lease");
  ctx.clock.advance(30);
  assert.equal(await m.beginStep(sid, 'worker-b'), m.LEASE_HELD, "30 s after the holder's last step its lease is still live: worker-b must get LEASE_HELD");
  ctx.clock.advance(16);
  const got = await m.beginStep(sid, 'worker-b');
  assert.equal(got, 3, \`46 s after worker-a's last step its lease has expired, yet worker-b got \${got}: the next worker must resume the session at step 3\`);
}

export async function check_budget(ctx) {
  const m = ctx.load('state');
  const sessions = ctx.load('/support/browser/sessions.ts');
  const sid = await session(ctx, 2);
  assert.deepStrictEqual([await m.beginStep(sid, 'worker-a'), await m.beginStep(sid, 'worker-a')], [1, 2], 'a 2-step session must take steps 1 and 2');
  const third = await m.beginStep(sid, 'worker-a');
  assert.equal(third, m.BUDGET_EXHAUSTED, \`a third step on a 2-step budget answered \${third}: it must be refused with BUDGET_EXHAUSTED (\${m.BUDGET_EXHAUSTED})\`);
  const s = await sessions.loadSession(sid);
  assert(s.step_index === 2 && s.budget_remaining === 0, \`the refused step was charged: step_index \${s.step_index}, budget_remaining \${s.budget_remaining}, expected 2 and 0\`);
  assert.equal(s.status, 'budget_exhausted', \`the session's status is \${s.status} after its budget ran out, expected budget_exhausted\`);
  assert.equal(await m.beginStep('s-404', 'worker-a'), m.NO_SESSION, 'a step on a session that does not exist must answer NO_SESSION');
  // The same worker's two steps on the last unit of budget: exactly one is charged.
  const last = await session(ctx, 1);
  const rival = ctx.redisAfter(\`browser:session:\${last}\`, () => m.beginStep(last, 'worker-a'));
  const mine = await m.beginStep(last, 'worker-a');
  assert(rival.fired, \`beginStep never touched browser:session:\${last}\`);
  if (rival.error !== undefined) throw rival.error;
  const theirs = await rival.result;
  const after = await sessions.loadSession(last);
  assert(
    [mine, theirs].sort((a, b) => a - b).join() === [m.BUDGET_EXHAUSTED, 1].join() && after.budget_remaining === 0,
    \`two steps at once on a 1-step budget got \${mine} and \${theirs} and left budget_remaining \${after.budget_remaining}: compare the budget in the script that charges it, so exactly one step is taken\`,
  );
}
`,
    go: `package main

import (
	"context"

	"browser/sessions"

	"leetbuild/harness"
)

var hStateBg = context.Background()

func hNewSession(maxSteps int) string {
	return sessions.CreateSession(hStateBg, "acme", "public-web", "buy a kettle", maxSteps, "https://www.example.com/").ID
}

func hStep(ctx *harness.Ctx, sid, worker string) int {
	n, err := beginStep(hStateBg, sid, worker)
	ctx.NoError(err, "beginStep(%s, %s) failed", sid, worker)
	return n
}

func CheckLeaseGuard(ctx *harness.Ctx) {
	sid := hNewSession(10)
	// Worker B picks the session up right after worker A's first command on its lease.
	rival := ctx.Redis.After("browser:lease:"+sid, func() any {
		n, err := beginStep(hStateBg, sid, "worker-b")
		ctx.NoError(err, "worker-b's beginStep failed")
		return n
	})
	mine := hStep(ctx, sid, "worker-a")
	ctx.Assert(rival.Fired, "beginStep never touched browser:lease:%s", sid)
	ctx.NoError(rival.Err, "worker-b's beginStep")
	theirs := rival.Result.(int)
	ctx.Assert((mine == 1 && theirs == leaseHeld) || (mine == leaseHeld && theirs == 1), "two workers began a step on one session at the same moment and got %d and %d: exactly one may win (step 1), the other must get leaseHeld (%d)", mine, theirs, leaseHeld)
	s := sessions.LoadSession(hStateBg, sid)
	ctx.Assert(s.StepIndex == 1 && s.BudgetRemaining == 9, "after one won step the session holds step_index %d, budget_remaining %d, expected 1 and 9", s.StepIndex, s.BudgetRemaining)
	winner, loser := "worker-a", "worker-b"
	if mine != 1 {
		winner, loser = loser, winner
	}
	ctx.Equal(hStep(ctx, sid, winner), 2, "the lease holder must be able to take the next step")
	ctx.Equal(hStep(ctx, sid, loser), leaseHeld, "the other worker must still get leaseHeld")
	// The command that takes the lease charges the step: no crash or rival lands between the two.
	other := hNewSession(10)
	lease := "browser:lease:" + other
	seen := ctx.Redis.After(lease, func() any {
		if ctx.Redis.Exists(lease) == 0 {
			return map[string]string(nil)
		}
		return ctx.Redis.HGetAll(sessions.SessionKey(other))
	})
	ctx.Equal(hStep(ctx, other, "worker-a"), 1, "the first step of a fresh session")
	ctx.Assert(seen.Fired, "beginStep never touched %s", lease)
	ctx.NoError(seen.Err, "reading the session after the lease was taken")
	if snapshot := seen.Result.(map[string]string); snapshot != nil {
		ctx.Assert(snapshot["step_index"] == "1" && snapshot["budget_remaining"] == "9", "right after the command that took %s the session held step_index %s, budget_remaining %s: take the lease and charge the step in the same script", lease, snapshot["step_index"], snapshot["budget_remaining"])
	}
}

func CheckLeaseTtl(ctx *harness.Ctx) {
	sid := hNewSession(10)
	lease := "browser:lease:" + sid
	written := ctx.Redis.After(lease, func() any { return ctx.Redis.PTTL(lease) })
	ctx.Equal(hStep(ctx, sid, "worker-a"), 1, "the first step of a fresh session")
	ctx.NoError(written.Err, "reading the lease's TTL")
	first, _ := written.Result.(int64)
	ctx.Assert(first == -2 || (first >= 44000 && first <= 45000), "right after the command that wrote %s its TTL was %d ms: the command that writes the lease gives it its leaseTTLMs (45000 ms) expiry (SET … PX)", lease, first)
	ttl := ctx.Redis.PTTL(lease)
	ctx.Assert(ttl >= 44000 && ttl <= 45000, "%s has a TTL of %d ms: a lease that never expires keeps a crashed worker's session stuck. It must expire leaseTTLMs (45000 ms) after the holder's last step", lease, ttl)
	ctx.Equal(hStep(ctx, sid, "worker-b"), leaseHeld, "while worker-a's lease is live worker-b must get leaseHeld")
	ctx.Clock.Advance(30)
	ctx.Equal(hStep(ctx, sid, "worker-a"), 2, "the holder's next step (30 s later) must go through and refresh its lease")
	ctx.Clock.Advance(30)
	ctx.Equal(hStep(ctx, sid, "worker-b"), leaseHeld, "30 s after the holder's last step its lease is still live: worker-b must get leaseHeld")
	ctx.Clock.Advance(16)
	ctx.Equal(hStep(ctx, sid, "worker-b"), 3, "46 s after worker-a's last step its lease has expired: the next worker must resume the session at step 3")
}

func CheckBudget(ctx *harness.Ctx) {
	sid := hNewSession(2)
	ctx.Equal([]int{hStep(ctx, sid, "worker-a"), hStep(ctx, sid, "worker-a")}, []int{1, 2}, "a 2-step session must take steps 1 and 2")
	ctx.Equal(hStep(ctx, sid, "worker-a"), budgetExhausted, "a third step on a 2-step budget must be refused with budgetExhausted")
	s := sessions.LoadSession(hStateBg, sid)
	ctx.Assert(s.StepIndex == 2 && s.BudgetRemaining == 0, "the refused step was charged: step_index %d, budget_remaining %d, expected 2 and 0", s.StepIndex, s.BudgetRemaining)
	ctx.Equal(s.Status, "budget_exhausted", "the session's status after its budget ran out")
	ctx.Equal(hStep(ctx, "s-404", "worker-a"), noSession, "a step on a session that does not exist")
	// The same worker's two steps on the last unit of budget: exactly one is charged.
	last := hNewSession(1)
	rival := ctx.Redis.After(sessions.SessionKey(last), func() any {
		n, err := beginStep(hStateBg, last, "worker-a")
		ctx.NoError(err, "the concurrent beginStep failed")
		return n
	})
	mine := hStep(ctx, last, "worker-a")
	ctx.Assert(rival.Fired, "beginStep never touched %s", sessions.SessionKey(last))
	ctx.NoError(rival.Err, "the concurrent beginStep")
	theirs := rival.Result.(int)
	after := sessions.LoadSession(hStateBg, last)
	ctx.Assert(((mine == 1 && theirs == budgetExhausted) || (mine == budgetExhausted && theirs == 1)) && after.BudgetRemaining == 0, "two steps at once on a 1-step budget got %d and %d and left budget_remaining %d: compare the budget in the script that charges it, so exactly one step is taken", mine, theirs, after.BudgetRemaining)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <map>
#include <memory>
#include <optional>
#include <string>

#include "browser/sessions.h"

namespace {

std::string hNewSession(long max_steps) {
  return sessions::createSession("acme", "public-web", "buy a kettle", max_steps, "https://www.example.com/").session_id;
}

struct HRival {
  bool fired = false;
  long result = 0;
  std::optional<std::string> err;
};

// A second step of worker on sid, run inside the probe on key.
std::shared_ptr<HRival> hRaceOn(harness::Ctx& ctx, const std::string& key, const std::string& sid, const std::string& worker) {
  auto rival = std::make_shared<HRival>();
  ctx.Redis.After(key, [rival, sid, worker] {
    rival->fired = true;
    try {
      rival->result = beginStep(sid, worker);
    } catch (const std::exception& e) {
      rival->err = e.what();
    }
  });
  return rival;
}

struct HSnapshot {
  bool fired = false;
  std::optional<std::map<std::string, std::string>> session;
};

}  // namespace

void CheckLeaseGuard(harness::Ctx& ctx) {
  const std::string sid = hNewSession(10);
  // Worker B picks the session up right after worker A's first command on its lease.
  const auto rival = hRaceOn(ctx, "browser:lease:" + sid, sid, "worker-b");
  const long mine = beginStep(sid, "worker-a");
  ctx.Assert(rival->fired, "beginStep never touched browser:lease:%s", sid);
  ctx.Assert(!rival->err, "worker-b's beginStep failed: %s", rival->err.value_or(""));
  const long theirs = rival->result;
  ctx.Assert((mine == 1 && theirs == kLeaseHeld) || (mine == kLeaseHeld && theirs == 1), "two workers began a step on one session at the same moment and got %d and %d: exactly one may win (step 1), the other must get kLeaseHeld (%d)", mine, theirs, kLeaseHeld);
  const auto s = sessions::loadSession(sid);
  ctx.Assert(s->step_index == 1 && s->budget_remaining == 9, "after one won step the session holds step_index %d, budget_remaining %d, expected 1 and 9", s->step_index, s->budget_remaining);
  const std::string winner = mine == 1 ? "worker-a" : "worker-b";
  const std::string loser = mine == 1 ? "worker-b" : "worker-a";
  ctx.Equal(beginStep(sid, winner), 2, "the lease holder must be able to take the next step");
  ctx.Equal(beginStep(sid, loser), kLeaseHeld, "the other worker must still get kLeaseHeld");
  // The command that takes the lease charges the step: no crash or rival lands between the two.
  const std::string other = hNewSession(10);
  const std::string lease = "browser:lease:" + other;
  const auto seen = std::make_shared<HSnapshot>();
  ctx.Redis.After(lease, [&ctx, seen, lease, other] {
    seen->fired = true;
    if (ctx.Redis.Exists(lease) != 0) seen->session = ctx.Redis.HGetAll(sessions::sessionKey(other));
  });
  ctx.Equal(beginStep(other, "worker-a"), 1, "the first step of a fresh session");
  ctx.Assert(seen->fired, "beginStep never touched %s", lease);
  if (seen->session) {
    auto snapshot = *seen->session;
    ctx.Assert(snapshot["step_index"] == "1" && snapshot["budget_remaining"] == "9", "right after the command that took %s the session held step_index %s, budget_remaining %s: take the lease and charge the step in the same script", lease, snapshot["step_index"], snapshot["budget_remaining"]);
  }
}

void CheckLeaseTtl(harness::Ctx& ctx) {
  const std::string sid = hNewSession(10);
  const std::string lease = "browser:lease:" + sid;
  const auto written = std::make_shared<std::optional<long long>>();
  ctx.Redis.After(lease, [&ctx, written, lease] { *written = ctx.Redis.PTTL(lease); });
  ctx.Equal(beginStep(sid, "worker-a"), 1, "the first step of a fresh session");
  const long long first = written->value_or(-2);
  ctx.Assert(first == -2 || (first >= 44000 && first <= 45000), "right after the command that wrote %s its TTL was %d ms: the command that writes the lease gives it its kLeaseTtlMs (45000 ms) expiry (SET … PX)", lease, first);
  const long long ttl = ctx.Redis.PTTL(lease);
  ctx.Assert(ttl >= 44000 && ttl <= 45000, "%s has a TTL of %d ms: a lease that never expires keeps a crashed worker's session stuck. It must expire kLeaseTtlMs (45000 ms) after the holder's last step", lease, ttl);
  ctx.Equal(beginStep(sid, "worker-b"), kLeaseHeld, "while worker-a's lease is live worker-b must get kLeaseHeld");
  ctx.Clock.Advance(30);
  ctx.Equal(beginStep(sid, "worker-a"), 2, "the holder's next step (30 s later) must go through and refresh its lease");
  ctx.Clock.Advance(30);
  ctx.Equal(beginStep(sid, "worker-b"), kLeaseHeld, "30 s after the holder's last step its lease is still live: worker-b must get kLeaseHeld");
  ctx.Clock.Advance(16);
  ctx.Equal(beginStep(sid, "worker-b"), 3, "46 s after worker-a's last step its lease has expired: the next worker must resume the session at step 3");
}

void CheckBudget(harness::Ctx& ctx) {
  const std::string sid = hNewSession(2);
  const long first = beginStep(sid, "worker-a");
  const long second = beginStep(sid, "worker-a");
  ctx.Assert(first == 1 && second == 2, "a 2-step session must take steps 1 and 2, got %d and %d", first, second);
  ctx.Equal(beginStep(sid, "worker-a"), kBudgetExhausted, "a third step on a 2-step budget must be refused with kBudgetExhausted");
  const auto s = sessions::loadSession(sid);
  ctx.Assert(s->step_index == 2 && s->budget_remaining == 0, "the refused step was charged: step_index %d, budget_remaining %d, expected 2 and 0", s->step_index, s->budget_remaining);
  ctx.Equal(s->status, "budget_exhausted", "the session's status after its budget ran out");
  ctx.Equal(beginStep("s-404", "worker-a"), kNoSession, "a step on a session that does not exist");
  // The same worker's two steps on the last unit of budget: exactly one is charged.
  const std::string last = hNewSession(1);
  const auto rival = hRaceOn(ctx, sessions::sessionKey(last), last, "worker-a");
  const long mine = beginStep(last, "worker-a");
  ctx.Assert(rival->fired, "beginStep never touched %s", sessions::sessionKey(last));
  ctx.Assert(!rival->err, "the concurrent beginStep failed: %s", rival->err.value_or(""));
  const long theirs = rival->result;
  const auto after = sessions::loadSession(last);
  ctx.Assert(((mine == 1 && theirs == kBudgetExhausted) || (mine == kBudgetExhausted && theirs == 1)) && after->budget_remaining == 0, "two steps at once on a 1-step budget got %d and %d and left budget_remaining %d: compare the budget in the script that charges it, so exactly one step is taken", mine, theirs, after->budget_remaining);
}
`,
  },
  hints: [
    'Run two workers on one session at the same moment: both get a step and the index jumps by two. Stop a worker mid-session: nobody can ever resume it. A two-step session happily takes a third step.',
    'The lease is read with a GET and written with a SET in a later command, so another worker fits between them; that SET has no expiry; and nothing compares `budget_remaining` with zero before charging.',
    'One script over KEYS[1] (session) and KEYS[2] (lease): return LEASE_HELD if another owner holds it; at budget 0, HSET status budget_exhausted and return BUDGET_EXHAUSTED; else SET the lease PX 45000 and HINCRBY both counters.',
  ],
  debrief: `A lease is only a lease if taking it and acting under it are one decision, which is why the read, the budget check and the write share a script: Redis runs it while nothing else runs. The TTL is the crash story. Nobody has to notice a dead worker: its key disappears 45 seconds after its last step and the next worker resumes the same counters. Charging the budget in the same script means a retried transition cannot buy free steps. Production schedulers add a fencing token, the lease's generation sent with every driver call, so a worker paused past its TTL cannot act on a session someone else now holds.`,
};
