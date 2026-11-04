import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis attempt counters and one active case per applicant',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis'],
  task: `## Task

**Starting point.** The starter is the intake state step 1 calls (provided there as \`kyc.intake\`):
\`reserve_attempt(tenant, applicant)\` counts submissions in \`kyc:attempts:{tenant}:{applicant}\` and
answers \`(allowed, retry_after_s)\`; \`open_case(tenant, applicant, documents)\` finds or opens the
applicant's case and answers \`(case_id, created)\`, writing it through \`cases.create\`. It serves the
demo and hides four flaws.

**Failure mode the checks target.** Two submissions landing together both pass a cap of four; a
refused applicant is told to retry in a minute and stays refused forever; two submissions open two
cases; and an applicant reference reused by another tenant lands on the first tenant's case.

- **One Lua script** reserves: read the count, compare it with \`MAX_ATTEMPTS = 4\`, \`INCR\`, and
  \`EXPIRE\` the key for \`ATTEMPT_WINDOW_S = 3600\` on the first attempt.
- A refusal answers the **seconds left in the window** (the key's \`TTL\`), and the window ends.
- The active case lives at \`kyc:active:{tenant}:{applicant}\`, claimed with \`SET NX\` before
  \`cases.create\`: a submission that loses the claim answers the winner's case with \`created\` false.`,
  sequence: {
    participants: ['KYC API', 'Redis'],
    messages: [
      {
        from: 'KYC API',
        to: 'Redis',
        label: 'EVAL reserve · KEYS[kyc:attempts:{tenant}:{applicant}] · 4, 3600',
        kind: 'sync',
      },
      {from: 'Redis', to: 'KYC API', label: '{1, ttl} reserved · {0, ttl} refused', kind: 'reply'},
      {from: 'KYC API', to: 'Redis', label: 'SET kyc:active:{tenant}:{applicant} c-7 NX', kind: 'sync'},
      {from: 'Redis', to: 'KYC API', label: 'OK → cases.create · nil → the open case', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'atomic-attempts',
      title: 'Reserves an attempt in one Lua script',
      detail:
        'The count is read, compared with the cap and incremented inside one script (`register_script`, `defineCommand`, `NewScript`, `eval`); a client-side `GET` followed by `INCR` lets a second submission land between the two and pass the cap.',
      match: {
        python: {
          all: [/register_script\(|\.eval\(/, /redis\.call\(\s*['"]INCR['"]/, /redis\.call\(\s*['"]GET['"]/],
          none: [/\br\.incr\(/],
        },
        typescript: {
          all: [/defineCommand\(|\.eval\(/, /redis\.call\(\s*['"]INCR['"]/, /redis\.call\(\s*['"]GET['"]/],
          none: [/\.incr\(/],
        },
        go: {
          all: [/redis\.NewScript\(/, /redis\.call\(\s*['"]INCR['"]/, /redis\.call\(\s*['"]GET['"]/],
          none: [/rdb\.Incr\(/],
        },
        scala: {
          all: [/jedis\.eval(sha)?\(/, /redis\.call\(\s*['"]INCR['"]/, /redis\.call\(\s*['"]GET['"]/],
          none: [/jedis\.incr\(/],
        },
        cpp: {all: [/\.eval</, /redis\.call\(\s*['"]INCR['"]/, /redis\.call\(\s*['"]GET['"]/], none: [/\.incr\(/]},
      },
    },
    {
      id: 'attempt-window',
      title: 'The window expires and the refusal says when',
      detail:
        'The script gives the counter its `EXPIRE` on the first attempt and answers its `TTL`, and a refusal returns that TTL as the retry delay; a constant delay tells the client the wrong time, and a counter without an expiry never lets the applicant back in.',
      match: {
        python: {all: [/redis\.call\(\s*['"]EXPIRE['"]/, /redis\.call\(\s*['"]TTL['"]/], none: [/RETRY_AFTER_S/]},
        typescript: {all: [/redis\.call\(\s*['"]EXPIRE['"]/, /redis\.call\(\s*['"]TTL['"]/], none: [/RETRY_AFTER_S/]},
        go: {all: [/redis\.call\(\s*['"]EXPIRE['"]/, /redis\.call\(\s*['"]TTL['"]/], none: [/retryAfterS\b/]},
        scala: {all: [/redis\.call\(\s*['"]EXPIRE['"]/, /redis\.call\(\s*['"]TTL['"]/], none: [/RetryAfterS\b/]},
        cpp: {all: [/redis\.call\(\s*['"]EXPIRE['"]/, /redis\.call\(\s*['"]TTL['"]/], none: [/kRetryAfterS\b/]},
      },
    },
    {
      id: 'single-case',
      title: 'Claims the active case with SET NX before creating it',
      detail:
        'The active-case key is claimed with `SET … NX` and the case is created only by the claim’s winner; a `GET` then `SET` lets two submissions both see no case and both create one.',
      match: {
        python: {all: [/\.set\([^\n]*nx=True/], order: [/nx=True/, /cases\.create\(/]},
        typescript: {all: [/\.set\([^\n]*'NX'/], order: [/'NX'/, /cases\.create\(/]},
        go: {all: [/\.SetNX\(/], order: [/\.SetNX\(/, /cases\.Create\(/]},
        scala: {all: [/SetParams\.setParams\(\)\.nx\(\)/], order: [/\.nx\(\)/, /Cases\.create\(/]},
        cpp: {all: [/UpdateType::NOT_EXIST/], order: [/UpdateType::NOT_EXIST/, /cases::create\(/]},
      },
    },
    {
      id: 'case-scope',
      title: 'Scopes the active case by tenant and applicant',
      detail:
        'The active-case key is `kyc:active:{tenant}:{applicant}`: applicant references are the tenant’s own, so the same reference in another tenant is another person.',
      match: {
        python: {all: [/kyc:active:\{tenant\}:\{applicant\}/]},
        typescript: {all: [/kyc:active:\$\{tenant\}:\$\{applicant\}/]},
        go: {all: [/"kyc:active:"\s*\+\s*tenant\s*\+\s*":"\s*\+\s*applicant/]},
        scala: {all: [/s"kyc:active:\$tenant:\$applicant"/]},
        cpp: {all: [/"kyc:active:"\s*\+\s*tenant\s*\+\s*":"\s*\+\s*applicant/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

from kyc import cases  # cases.new_id, cases.create

r = redis.Redis(host="redis", port=6379, decode_responses=True)

MAX_ATTEMPTS = 4
ATTEMPT_WINDOW_S = 3600
RETRY_AFTER_S = 60


def reserve_attempt(tenant: str, applicant: str) -> tuple[bool, int]:
    """(True, 0) when the attempt is reserved; (False, seconds to wait) past the cap."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    key = f"kyc:attempts:{tenant}:{applicant}"
    count = int(r.get(key) or 0)
    if count >= MAX_ATTEMPTS:
        return False, RETRY_AFTER_S
    r.incr(key)
    return True, 0


def open_case(tenant: str, applicant: str, documents: list[dict]) -> tuple[str, bool]:
    """The applicant's open case: (case_id, True) when this call opened it, (case_id, False) when one was open."""
    key = f"kyc:active:{applicant}"
    existing = r.get(key)
    if existing is not None:
        return existing, False
    case_id = cases.new_id()
    r.set(key, case_id)
    cases.create(case_id, tenant, applicant, documents)
    return case_id, True
`,
      solution: `import redis

from kyc import cases  # cases.new_id, cases.create

r = redis.Redis(host="redis", port=6379, decode_responses=True)

MAX_ATTEMPTS = 4
ATTEMPT_WINDOW_S = 3600

# Read, compare, count and start the window in one step: no other client runs in between.
RESERVE_LUA = """
local n = tonumber(redis.call('GET', KEYS[1]) or '0')
if n >= tonumber(ARGV[1]) then return {0, redis.call('TTL', KEYS[1])} end
n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
return {1, redis.call('TTL', KEYS[1])}
"""
reserve = r.register_script(RESERVE_LUA)


def reserve_attempt(tenant: str, applicant: str) -> tuple[bool, int]:
    """(True, 0) when the attempt is reserved; (False, seconds until the window ends) past the cap."""
    allowed, ttl = reserve(keys=[f"kyc:attempts:{tenant}:{applicant}"], args=[MAX_ATTEMPTS, ATTEMPT_WINDOW_S])
    return (True, 0) if allowed == 1 else (False, max(int(ttl), 1))


def open_case(tenant: str, applicant: str, documents: list[dict]) -> tuple[str, bool]:
    """The applicant's open case: (case_id, True) when this call opened it, (case_id, False) when one was open."""
    key = f"kyc:active:{tenant}:{applicant}"
    case_id = cases.new_id()
    # The claim is the decision: only the submission whose SET NX won creates the case.
    if not r.set(key, case_id, nx=True):
        return r.get(key), False
    cases.create(case_id, tenant, applicant, documents)
    return case_id, True
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import * as cases from 'kyc/cases'; // cases.newId, cases.create

const redis = new Redis({host: 'redis', port: 6379});

export const MAX_ATTEMPTS = 4;
export const ATTEMPT_WINDOW_S = 3600;
const RETRY_AFTER_S = 60;

/** allowed when the attempt is reserved; past the cap, the seconds to wait. */
export async function reserveAttempt(tenant: string, applicant: string): Promise<{allowed: boolean; retryAfterS: number}> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const key = \`kyc:attempts:\${tenant}:\${applicant}\`;
  const count = Number((await redis.get(key)) ?? 0);
  if (count >= MAX_ATTEMPTS) return {allowed: false, retryAfterS: RETRY_AFTER_S};
  await redis.incr(key);
  return {allowed: true, retryAfterS: 0};
}

/** The applicant's open case: created when this call opened it, not when one was open. */
export async function openCase(tenant: string, applicant: string, documents: cases.Document[]): Promise<{caseId: string; created: boolean}> {
  const key = \`kyc:active:\${applicant}\`;
  const existing = await redis.get(key);
  if (existing !== null) return {caseId: existing, created: false};
  const caseId = await cases.newId();
  await redis.set(key, caseId);
  await cases.create(caseId, tenant, applicant, documents);
  return {caseId, created: true};
}
`,
      solution: `import Redis from 'ioredis';

import * as cases from 'kyc/cases'; // cases.newId, cases.create

export const MAX_ATTEMPTS = 4;
export const ATTEMPT_WINDOW_S = 3600;

// Read, compare, count and start the window in one step: no other client runs in between.
const RESERVE_LUA = \`
local n = tonumber(redis.call('GET', KEYS[1]) or '0')
if n >= tonumber(ARGV[1]) then return {0, redis.call('TTL', KEYS[1])} end
n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
return {1, redis.call('TTL', KEYS[1])}
\`;

interface IntakeRedis extends Redis {
  reserve(key: string, cap: number, windowS: number): Promise<[number, number]>;
}

const redis = new Redis({host: 'redis', port: 6379}) as IntakeRedis;
redis.defineCommand('reserve', {numberOfKeys: 1, lua: RESERVE_LUA});

/** allowed when the attempt is reserved; past the cap, the seconds until the window ends. */
export async function reserveAttempt(tenant: string, applicant: string): Promise<{allowed: boolean; retryAfterS: number}> {
  const [allowed, ttl] = await redis.reserve(\`kyc:attempts:\${tenant}:\${applicant}\`, MAX_ATTEMPTS, ATTEMPT_WINDOW_S);
  return allowed === 1 ? {allowed: true, retryAfterS: 0} : {allowed: false, retryAfterS: Math.max(Number(ttl), 1)};
}

/** The applicant's open case: created when this call opened it, not when one was open. */
export async function openCase(tenant: string, applicant: string, documents: cases.Document[]): Promise<{caseId: string; created: boolean}> {
  const key = \`kyc:active:\${tenant}:\${applicant}\`;
  const caseId = await cases.newId();
  // The claim is the decision: only the submission whose SET NX won creates the case.
  if ((await redis.set(key, caseId, 'NX')) === null) return {caseId: (await redis.get(key)) as string, created: false};
  await cases.create(caseId, tenant, applicant, documents);
  return {caseId, created: true};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"github.com/redis/go-redis/v9"

	"kyc/cases" // cases.NewID, cases.Create, cases.Document
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	maxAttempts    = 4
	attemptWindowS = 3600
	retryAfterS    = 60
)

// reserveAttempt is (true, 0) when the attempt is reserved; past the cap, (false, seconds to wait).
func reserveAttempt(ctx context.Context, tenant, applicant string) (bool, int64, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	key := "kyc:attempts:" + tenant + ":" + applicant
	count, err := rdb.Get(ctx, key).Int64()
	if err != nil && err != redis.Nil {
		return false, 0, err
	}
	if count >= maxAttempts {
		return false, retryAfterS, nil
	}
	if err := rdb.Incr(ctx, key).Err(); err != nil {
		return false, 0, err
	}
	return true, 0, nil
}

// openCase is the applicant's open case: created when this call opened it, not when one was open.
func openCase(ctx context.Context, tenant, applicant string, documents []cases.Document) (string, bool, error) {
	key := "kyc:active:" + applicant
	existing, err := rdb.Get(ctx, key).Result()
	if err == nil {
		return existing, false, nil
	}
	if err != redis.Nil {
		return "", false, err
	}
	caseID := cases.NewID(ctx)
	if err := rdb.Set(ctx, key, caseID, 0).Err(); err != nil {
		return "", false, err
	}
	cases.Create(ctx, caseID, tenant, applicant, documents)
	return caseID, true, nil
}
`,
      solution: `package main

import (
	"context"

	"github.com/redis/go-redis/v9"

	"kyc/cases" // cases.NewID, cases.Create, cases.Document
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	maxAttempts    = 4
	attemptWindowS = 3600
)

// reserve reads, compares, counts and starts the window in one step: no other client runs in between.
var reserve = redis.NewScript(\`
local n = tonumber(redis.call('GET', KEYS[1]) or '0')
if n >= tonumber(ARGV[1]) then return {0, redis.call('TTL', KEYS[1])} end
n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
return {1, redis.call('TTL', KEYS[1])}
\`)

// reserveAttempt is (true, 0) when the attempt is reserved; past the cap, (false, seconds until the window ends).
func reserveAttempt(ctx context.Context, tenant, applicant string) (bool, int64, error) {
	reply, err := reserve.Run(ctx, rdb, []string{"kyc:attempts:" + tenant + ":" + applicant}, maxAttempts, attemptWindowS).Int64Slice()
	if err != nil {
		return false, 0, err
	}
	if reply[0] == 1 {
		return true, 0, nil
	}
	return false, max(reply[1], 1), nil
}

// openCase is the applicant's open case: created when this call opened it, not when one was open.
func openCase(ctx context.Context, tenant, applicant string, documents []cases.Document) (string, bool, error) {
	key := "kyc:active:" + tenant + ":" + applicant
	caseID := cases.NewID(ctx)
	// The claim is the decision: only the submission whose SET NX won creates the case.
	claimed, err := rdb.SetNX(ctx, key, caseID, 0).Result()
	if err != nil {
		return "", false, err
	}
	if !claimed {
		existing, err := rdb.Get(ctx, key).Result()
		return existing, false, err
	}
	cases.Create(ctx, caseID, tenant, applicant, documents)
	return caseID, true, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

import kyc.Cases // Cases.newId, Cases.create, Cases.Document

object State {
  val MaxAttempts = 4
  val AttemptWindowS = 3600
  val RetryAfterS = 60L

  private val jedis = new JedisPooled("redis", 6379)

  /** (true, 0) when the attempt is reserved; past the cap, (false, seconds to wait). */
  def reserveAttempt(tenant: String, applicant: String): (Boolean, Long) = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val key = s"kyc:attempts:$tenant:$applicant"
    val count = Option(jedis.get(key)).map(_.toLong).getOrElse(0L)
    if (count >= MaxAttempts) (false, RetryAfterS)
    else {
      jedis.incr(key)
      (true, 0L)
    }
  }

  /** The applicant's open case: created when this call opened it, not when one was open. */
  def openCase(tenant: String, applicant: String, documents: Seq[Cases.Document]): (String, Boolean) = {
    val key = s"kyc:active:$applicant"
    Option(jedis.get(key)) match {
      case Some(existing) => (existing, false)
      case None =>
        val caseId = Cases.newId()
        jedis.set(key, caseId)
        Cases.create(caseId, tenant, applicant, documents)
        (caseId, true)
    }
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

import scala.jdk.CollectionConverters._

import kyc.Cases // Cases.newId, Cases.create, Cases.Document

object State {
  val MaxAttempts = 4
  val AttemptWindowS = 3600

  // Read, compare, count and start the window in one step: no other client runs in between.
  val ReserveLua: String =
    """local n = tonumber(redis.call('GET', KEYS[1]) or '0')
      |if n >= tonumber(ARGV[1]) then return {0, redis.call('TTL', KEYS[1])} end
      |n = redis.call('INCR', KEYS[1])
      |if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
      |return {1, redis.call('TTL', KEYS[1])}
      |""".stripMargin

  private val jedis = new JedisPooled("redis", 6379)

  /** (true, 0) when the attempt is reserved; past the cap, (false, seconds until the window ends). */
  def reserveAttempt(tenant: String, applicant: String): (Boolean, Long) = {
    val reply = jedis.eval(ReserveLua, List(s"kyc:attempts:$tenant:$applicant").asJava, List(MaxAttempts.toString, AttemptWindowS.toString).asJava)
      .asInstanceOf[java.util.List[java.lang.Long]].asScala.map(_.longValue)
    if (reply.head == 1L) (true, 0L) else (false, math.max(reply(1), 1L))
  }

  /** The applicant's open case: created when this call opened it, not when one was open. */
  def openCase(tenant: String, applicant: String, documents: Seq[Cases.Document]): (String, Boolean) = {
    val key = s"kyc:active:$tenant:$applicant"
    val caseId = Cases.newId()
    // The claim is the decision: only the submission whose SET NX won creates the case.
    if (jedis.set(key, caseId, SetParams.setParams().nx()) == null) (jedis.get(key), false)
    else {
      Cases.create(caseId, tenant, applicant, documents)
      (caseId, true)
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <string>
#include <vector>

#include "kyc/cases.h"  // cases::newId, cases::create, cases::Document

constexpr long kMaxAttempts = 4;
constexpr long kAttemptWindowS = 3600;
constexpr long long kRetryAfterS = 60;

struct Reservation {
  bool allowed = false;
  long long retry_after_s = 0;
};

struct Opened {
  std::string case_id;
  bool created = false;
};

sw::redis::Redis redis("tcp://redis:6379");

// {true, 0} when the attempt is reserved; past the cap, {false, seconds to wait}.
Reservation reserveAttempt(const std::string& tenant, const std::string& applicant) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string key = "kyc:attempts:" + tenant + ":" + applicant;
  const auto count = redis.get(key);
  if (count && std::stol(*count) >= kMaxAttempts) return {false, kRetryAfterS};
  redis.incr(key);
  return {true, 0};
}

// The applicant's open case: created when this call opened it, not when one was open.
Opened openCase(const std::string& tenant, const std::string& applicant, const std::vector<cases::Document>& documents) {
  const std::string key = "kyc:active:" + applicant;
  if (const auto existing = redis.get(key)) return {*existing, false};
  const std::string case_id = cases::newId();
  redis.set(key, case_id);
  cases::create(case_id, tenant, applicant, documents);
  return {case_id, true};
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <algorithm>
#include <chrono>
#include <string>
#include <vector>

#include "kyc/cases.h"  // cases::newId, cases::create, cases::Document

constexpr long kMaxAttempts = 4;
constexpr long kAttemptWindowS = 3600;

// Read, compare, count and start the window in one step: no other client runs in between.
const std::string kReserveLua = R"lua(
local n = tonumber(redis.call('GET', KEYS[1]) or '0')
if n >= tonumber(ARGV[1]) then return {0, redis.call('TTL', KEYS[1])} end
n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
return {1, redis.call('TTL', KEYS[1])}
)lua";

struct Reservation {
  bool allowed = false;
  long long retry_after_s = 0;
};

struct Opened {
  std::string case_id;
  bool created = false;
};

sw::redis::Redis redis("tcp://redis:6379");

// {true, 0} when the attempt is reserved; past the cap, {false, seconds until the window ends}.
Reservation reserveAttempt(const std::string& tenant, const std::string& applicant) {
  const auto reply = redis.eval<std::vector<long long>>(kReserveLua, {"kyc:attempts:" + tenant + ":" + applicant},
                                                        {std::to_string(kMaxAttempts), std::to_string(kAttemptWindowS)});
  if (reply.at(0) == 1) return {true, 0};
  return {false, std::max(reply.at(1), 1LL)};
}

// The applicant's open case: created when this call opened it, not when one was open.
Opened openCase(const std::string& tenant, const std::string& applicant, const std::vector<cases::Document>& documents) {
  const std::string key = "kyc:active:" + tenant + ":" + applicant;
  const std::string case_id = cases::newId();
  // The claim is the decision: only the submission whose SET NX won creates the case.
  if (!redis.set(key, case_id, std::chrono::milliseconds(0), sw::redis::UpdateType::NOT_EXIST)) return {redis.get(key).value_or(""), false};
  cases::create(case_id, tenant, applicant, documents);
  return {case_id, true};
}
`,
    },
  },
  harness: {
    python: `from kyc import cases

DOCS = [{"type": "passport", "ref": "documents/t-a/passport-1.jpg", "digest": "sha256:5e1f0c"}]


def _settled(probe, what):
    assert probe.fired, f"nothing touched {what}"
    if probe.error is not None:
        raise probe.error
    return probe.result


def check_atomic_attempts(ctx):
    m = ctx.load("state")
    for n in range(1, 4):
        allowed, _ = m.reserve_attempt("t-a", "a-1")
        assert allowed, f"attempt {n} of 4 was refused"
    # A second submission of the same applicant lands while this one is reserving the 4th attempt.
    rival = ctx.redis_after("kyc:attempts:t-a:a-1", lambda: m.reserve_attempt("t-a", "a-1"))
    mine = m.reserve_attempt("t-a", "a-1")
    theirs = _settled(rival, "kyc:attempts:t-a:a-1")
    granted = [mine[0], theirs[0]].count(True)
    assert granted == 1, f"two submissions racing for the 4th attempt were both granted ({mine}, {theirs}): five attempts passed a cap of four. Read, compare and INCR in one script"
    count = int(ctx.redis.get("kyc:attempts:t-a:a-1") or 0)
    assert count == 4, f"kyc:attempts:t-a:a-1 holds {count} after the race, expected 4"


def check_attempt_window(ctx):
    m = ctx.load("state")
    for _ in range(4):
        m.reserve_attempt("t-a", "a-1")
    ttl = ctx.redis.ttl("kyc:attempts:t-a:a-1")
    assert 0 < ttl <= 3600, f"kyc:attempts:t-a:a-1 has TTL {ttl}: the counter must expire ATTEMPT_WINDOW_S after the first attempt"
    ctx.clock.advance(600)
    allowed, retry_after = m.reserve_attempt("t-a", "a-1")
    assert not allowed, "the 5th attempt inside the window was reserved"
    assert 2990 <= retry_after <= 3000, f"600 s into a 3600 s window the refusal says retry in {retry_after} s, expected the ~3000 s left (the key's TTL)"
    ctx.clock.advance(3001)
    allowed, _ = m.reserve_attempt("t-a", "a-1")
    assert allowed, "after the window ended the applicant was still refused: the counter never expires"


def check_single_case(ctx):
    m = ctx.load("state")
    # A second submission of the same applicant lands right after this one first touches the active-case key.
    probes = [ctx.redis_after(key, lambda: m.open_case("t-a", "a-1", DOCS)) for key in ("kyc:active:t-a:a-1", "kyc:active:a-1")]
    mine = m.open_case("t-a", "a-1", DOCS)
    fired = [p for p in probes if p.fired]
    assert fired, "open_case never touched the active-case key"
    theirs = _settled(fired[0], "the active-case key")
    assert mine[0] == theirs[0], f"two submissions of one applicant opened two cases: {mine} and {theirs}. Claim the key with SET NX and create the case only when the claim won"
    assert [mine[1], theirs[1]].count(True) == 1, f"exactly one of two racing submissions may report created, got {mine} and {theirs}"
    opened = ctx.redis.keys("kyc:case:c-*")
    assert len(opened) == 1, f"the race left {sorted(opened)} in the case store, expected one case"


def check_case_scope(ctx):
    m = ctx.load("state")
    first = m.open_case("t-a", "a-1", DOCS)
    assert first[1] is True, f"the first submission must open a case, got {first}"
    again = m.open_case("t-a", "a-1", DOCS)
    assert again == (first[0], False), f"a second submission in t-a must answer the open case {first[0]} with created False, got {again}"
    other = m.open_case("t-b", "a-1", DOCS)
    assert other[1] is True and other[0] != first[0], f"applicant a-1 of tenant t-b was handed t-a's case {other}: the active case key must name the tenant"
    assert cases.load(other[0])["tenant"] == "t-b", f"t-b's case belongs to {cases.load(other[0])['tenant']}"
    assert ctx.redis.get("kyc:active:t-a:a-1") == first[0], f"kyc:active:t-a:a-1 holds {ctx.redis.get('kyc:active:t-a:a-1')!r}, expected {first[0]}"
`,
    typescript: `const DOCS = [{type: 'passport', ref: 'documents/t-a/passport-1.jpg', digest: 'sha256:5e1f0c'}];

async function settled(probe, what: string) {
  assert(probe.fired, \`nothing touched \${what}\`);
  if (probe.error !== undefined) throw probe.error;
  return await probe.result;
}

export async function check_atomic_attempts(ctx) {
  const m = ctx.load('state');
  for (let n = 1; n <= 3; n += 1) assert((await m.reserveAttempt('t-a', 'a-1')).allowed, \`attempt \${n} of 4 was refused\`);
  // A second submission of the same applicant lands while this one is reserving the 4th attempt.
  const rival = ctx.redisAfter('kyc:attempts:t-a:a-1', () => m.reserveAttempt('t-a', 'a-1'));
  const mine = await m.reserveAttempt('t-a', 'a-1');
  const theirs = await settled(rival, 'kyc:attempts:t-a:a-1');
  const granted = [mine.allowed, theirs.allowed].filter(Boolean).length;
  assert.equal(granted, 1, \`two submissions racing for the 4th attempt were both granted (\${JSON.stringify(mine)}, \${JSON.stringify(theirs)}): five attempts passed a cap of four. Read, compare and INCR in one script\`);
  assert.equal(Number(ctx.redis.get('kyc:attempts:t-a:a-1')), 4, 'kyc:attempts:t-a:a-1 must hold 4 after the race');
}

export async function check_attempt_window(ctx) {
  const m = ctx.load('state');
  for (let n = 0; n < 4; n += 1) await m.reserveAttempt('t-a', 'a-1');
  const ttl = Number(ctx.redis.ttl('kyc:attempts:t-a:a-1'));
  assert(ttl > 0 && ttl <= 3600, \`kyc:attempts:t-a:a-1 has TTL \${ttl}: the counter must expire ATTEMPT_WINDOW_S after the first attempt\`);
  ctx.clock.advance(600);
  const refused = await m.reserveAttempt('t-a', 'a-1');
  assert(!refused.allowed, 'the 5th attempt inside the window was reserved');
  assert(refused.retryAfterS >= 2990 && refused.retryAfterS <= 3000, \`600 s into a 3600 s window the refusal says retry in \${refused.retryAfterS} s, expected the ~3000 s left (the key's TTL)\`);
  ctx.clock.advance(3001);
  assert((await m.reserveAttempt('t-a', 'a-1')).allowed, 'after the window ended the applicant was still refused: the counter never expires');
}

export async function check_single_case(ctx) {
  const m = ctx.load('state');
  // A second submission of the same applicant lands right after this one first touches the active-case key.
  const probes = ['kyc:active:t-a:a-1', 'kyc:active:a-1'].map(key => ctx.redisAfter(key, () => m.openCase('t-a', 'a-1', DOCS)));
  const mine = await m.openCase('t-a', 'a-1', DOCS);
  const fired = probes.filter(p => p.fired);
  assert(fired.length > 0, 'openCase never touched the active-case key');
  const theirs = await settled(fired[0], 'the active-case key');
  assert.equal(mine.caseId, theirs.caseId, \`two submissions of one applicant opened two cases: \${JSON.stringify(mine)} and \${JSON.stringify(theirs)}. Claim the key with SET NX and create the case only when the claim won\`);
  assert.equal([mine.created, theirs.created].filter(Boolean).length, 1, \`exactly one of two racing submissions may report created, got \${JSON.stringify(mine)} and \${JSON.stringify(theirs)}\`);
  const opened = ctx.redis.keys('kyc:case:c-*');
  assert.equal(opened.length, 1, \`the race left \${JSON.stringify(opened)} in the case store, expected one case\`);
}

export async function check_case_scope(ctx) {
  const m = ctx.load('state');
  const cases = ctx.load('/support/kyc/cases.ts');
  const first = await m.openCase('t-a', 'a-1', DOCS);
  assert.equal(first.created, true, \`the first submission must open a case, got \${JSON.stringify(first)}\`);
  const again = await m.openCase('t-a', 'a-1', DOCS);
  assert.deepStrictEqual(again, {caseId: first.caseId, created: false}, \`a second submission in t-a must answer the open case \${first.caseId} with created false, got \${JSON.stringify(again)}\`);
  const other = await m.openCase('t-b', 'a-1', DOCS);
  assert(other.created && other.caseId !== first.caseId, \`applicant a-1 of tenant t-b was handed t-a's case \${JSON.stringify(other)}: the active case key must name the tenant\`);
  assert.equal((await cases.load(other.caseId)).tenant, 't-b', "t-b's case must belong to t-b");
  assert.equal(ctx.redis.get('kyc:active:t-a:a-1'), first.caseId, \`kyc:active:t-a:a-1 must hold \${first.caseId}\`);
}
`,
    go: `package main

import (
	"context"

	"kyc/cases"

	"leetbuild/harness"
)

var (
	stateBg = context.Background()
	docs    = []cases.Document{{Type: "passport", Ref: "documents/t-a/passport-1.jpg", Digest: "sha256:5e1f0c"}}
)

type opened struct {
	caseID  string
	created bool
	err     error
}

func mustReserve(ctx *harness.Ctx) (bool, int64) {
	allowed, retryAfter, err := reserveAttempt(stateBg, "t-a", "a-1")
	ctx.NoError(err, "reserveAttempt(t-a, a-1) failed")
	return allowed, retryAfter
}

func mustOpen(ctx *harness.Ctx, tenant string) opened {
	caseID, created, err := openCase(stateBg, tenant, "a-1", docs)
	ctx.NoError(err, "openCase(%s, a-1) failed", tenant)
	return opened{caseID, created, nil}
}

func CheckAtomicAttempts(ctx *harness.Ctx) {
	for n := 1; n <= 3; n++ {
		allowed, _ := mustReserve(ctx)
		ctx.Assert(allowed, "attempt %d of 4 was refused", n)
	}
	// A second submission of the same applicant lands while this one is reserving the 4th attempt.
	rival := ctx.Redis.After("kyc:attempts:t-a:a-1", func() any {
		allowed, _, err := reserveAttempt(stateBg, "t-a", "a-1")
		ctx.NoError(err, "the rival reservation failed")
		return allowed
	})
	mine, _ := mustReserve(ctx)
	ctx.Assert(rival.Fired, "nothing touched kyc:attempts:t-a:a-1")
	theirs, _ := rival.Result.(bool)
	ctx.Assert(!(mine && theirs), "two submissions racing for the 4th attempt were both granted: five attempts passed a cap of four. Read, compare and INCR in one script")
	ctx.Assert(mine || theirs, "of two submissions racing for the 4th attempt neither was granted")
	count, _ := ctx.Redis.Get("kyc:attempts:t-a:a-1")
	ctx.Equal(count, "4", "kyc:attempts:t-a:a-1 after the race")
}

func CheckAttemptWindow(ctx *harness.Ctx) {
	for n := 0; n < 4; n++ {
		mustReserve(ctx)
	}
	ttl := ctx.Redis.TTL("kyc:attempts:t-a:a-1")
	ctx.Assert(ttl > 0 && ttl <= 3600, "kyc:attempts:t-a:a-1 has TTL %d: the counter must expire attemptWindowS after the first attempt", ttl)
	ctx.Clock.Advance(600)
	allowed, retryAfter := mustReserve(ctx)
	ctx.Assert(!allowed, "the 5th attempt inside the window was reserved")
	ctx.Assert(retryAfter >= 2990 && retryAfter <= 3000, "600 s into a 3600 s window the refusal says retry in %d s, expected the ~3000 s left (the key's TTL)", retryAfter)
	ctx.Clock.Advance(3001)
	allowed, _ = mustReserve(ctx)
	ctx.Assert(allowed, "after the window ended the applicant was still refused: the counter never expires")
}

func CheckSingleCase(ctx *harness.Ctx) {
	// A second submission of the same applicant lands right after this one first touches the active-case key.
	var theirs *opened
	for _, key := range []string{"kyc:active:t-a:a-1", "kyc:active:a-1"} {
		ctx.Redis.After(key, func() any {
			if theirs == nil {
				caseID, created, err := openCase(stateBg, "t-a", "a-1", docs)
				theirs = &opened{caseID, created, err}
			}
			return nil
		})
	}
	mine := mustOpen(ctx, "t-a")
	ctx.Assert(theirs != nil, "openCase never touched the active-case key")
	ctx.NoError(theirs.err, "the rival openCase failed")
	ctx.Assert(mine.caseID == theirs.caseID, "two submissions of one applicant opened two cases: %s and %s. Claim the key with SET NX and create the case only when the claim won", mine.caseID, theirs.caseID)
	ctx.Assert(mine.created != theirs.created, "exactly one of two racing submissions may report created, got %v and %v", mine.created, theirs.created)
	ctx.Equal(len(ctx.Redis.Keys("kyc:case:c-*")), 1, "the race must leave one case in the store (%q)", ctx.Redis.Keys("kyc:case:c-*"))
}

func CheckCaseScope(ctx *harness.Ctx) {
	first := mustOpen(ctx, "t-a")
	ctx.Assert(first.created, "the first submission must open a case")
	again := mustOpen(ctx, "t-a")
	ctx.Assert(again.caseID == first.caseID && !again.created, "a second submission in t-a must answer the open case %s with created false, got %s %v", first.caseID, again.caseID, again.created)
	other := mustOpen(ctx, "t-b")
	ctx.Assert(other.created && other.caseID != first.caseID, "applicant a-1 of tenant t-b was handed t-a's case %s: the active case key must name the tenant", other.caseID)
	ctx.Equal(cases.Load(stateBg, other.caseID).Tenant, "t-b", "t-b's case must belong to t-b; its tenant")
	active, _ := ctx.Redis.Get("kyc:active:t-a:a-1")
	ctx.Equal(active, first.caseID, "kyc:active:t-a:a-1")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "kyc/cases.h"

namespace {

const std::vector<cases::Document> kDocs = {{"passport", "documents/t-a/passport-1.jpg", "sha256:5e1f0c"}};

struct Rival {
  bool fired = false;
  bool allowed = false;
  Opened opened;
  std::optional<std::string> err;
};

void settled(harness::Ctx& ctx, const Rival& r, const std::string& what) {
  ctx.Assert(r.fired, "nothing touched %s", what);
  ctx.Assert(!r.err, "the parallel call failed: %s", r.err.value_or(""));
}

}  // namespace

void CheckAtomicAttempts(harness::Ctx& ctx) {
  for (int n = 1; n <= 3; n++) ctx.Assert(reserveAttempt("t-a", "a-1").allowed, "attempt %d of 4 was refused", n);
  // A second submission of the same applicant lands while this one is reserving the 4th attempt.
  auto rival = std::make_shared<Rival>();
  ctx.Redis.After("kyc:attempts:t-a:a-1", [rival] {
    rival->fired = true;
    try {
      rival->allowed = reserveAttempt("t-a", "a-1").allowed;
    } catch (const std::exception& e) {
      rival->err = e.what();
    }
  });
  const bool mine = reserveAttempt("t-a", "a-1").allowed;
  settled(ctx, *rival, "kyc:attempts:t-a:a-1");
  ctx.Assert(!(mine && rival->allowed), "two submissions racing for the 4th attempt were both granted: five attempts passed a cap of four. Read, compare and INCR in one script");
  ctx.Assert(mine || rival->allowed, "of two submissions racing for the 4th attempt neither was granted");
  ctx.Equal(ctx.Redis.Get("kyc:attempts:t-a:a-1"), std::optional<std::string>("4"), "kyc:attempts:t-a:a-1 after the race");
}

void CheckAttemptWindow(harness::Ctx& ctx) {
  for (int n = 0; n < 4; n++) reserveAttempt("t-a", "a-1");
  const long long ttl = ctx.Redis.TTL("kyc:attempts:t-a:a-1");
  ctx.Assert(ttl > 0 && ttl <= 3600, "kyc:attempts:t-a:a-1 has TTL %d: the counter must expire kAttemptWindowS after the first attempt", ttl);
  ctx.Clock.Advance(600);
  const Reservation refused = reserveAttempt("t-a", "a-1");
  ctx.Assert(!refused.allowed, "the 5th attempt inside the window was reserved");
  ctx.Assert(refused.retry_after_s >= 2990 && refused.retry_after_s <= 3000, "600 s into a 3600 s window the refusal says retry in %d s, expected the ~3000 s left (the key's TTL)", refused.retry_after_s);
  ctx.Clock.Advance(3001);
  ctx.Assert(reserveAttempt("t-a", "a-1").allowed, "after the window ended the applicant was still refused: the counter never expires");
}

void CheckSingleCase(harness::Ctx& ctx) {
  // A second submission of the same applicant lands right after this one first touches the active-case key.
  auto rival = std::make_shared<Rival>();
  for (const std::string key : {"kyc:active:t-a:a-1", "kyc:active:a-1"}) {
    ctx.Redis.After(key, [rival] {
      if (rival->fired) return;
      rival->fired = true;
      try {
        rival->opened = openCase("t-a", "a-1", kDocs);
      } catch (const std::exception& e) {
        rival->err = e.what();
      }
    });
  }
  const Opened mine = openCase("t-a", "a-1", kDocs);
  settled(ctx, *rival, "the active-case key");
  ctx.Assert(mine.case_id == rival->opened.case_id, "two submissions of one applicant opened two cases: %s and %s. Claim the key with SET NX and create the case only when the claim won", mine.case_id, rival->opened.case_id);
  ctx.Assert(mine.created != rival->opened.created, "exactly one of two racing submissions may report created, got %t and %t", mine.created, rival->opened.created);
  ctx.Equal(ctx.Redis.Keys("kyc:case:c-*").size(), 1, "the race must leave one case in the store (%q)", ctx.Redis.Keys("kyc:case:c-*"));
}

void CheckCaseScope(harness::Ctx& ctx) {
  const Opened first = openCase("t-a", "a-1", kDocs);
  ctx.Assert(first.created, "the first submission must open a case");
  const Opened again = openCase("t-a", "a-1", kDocs);
  ctx.Assert(again.case_id == first.case_id && !again.created, "a second submission in t-a must answer the open case %s with created false, got %s %t", first.case_id, again.case_id, again.created);
  const Opened other = openCase("t-b", "a-1", kDocs);
  ctx.Assert(other.created && other.case_id != first.case_id, "applicant a-1 of tenant t-b was handed t-a's case %s: the active case key must name the tenant", other.case_id);
  ctx.Equal(cases::load(other.case_id)->tenant, "t-b", "t-b's case must belong to t-b; its tenant");
  ctx.Equal(ctx.Redis.Get("kyc:active:t-a:a-1"), std::optional<std::string>(first.case_id), "kyc:active:t-a:a-1");
}
`,
  },
  hints: [
    'Fire two submissions of one applicant at once after three attempts: both pass. After the 4th, the applicant is told to retry in 60 s, retries, and is refused for good.',
    'A `GET` then `INCR` from the client leaves a gap another submission lands in, and nothing ever sets an expiry. The case claim has the same gap, under a key without the tenant.',
    'One Lua script: `GET`, compare with `ARGV[1]`, `INCR`, `EXPIRE` on the first, return `{allowed, TTL}`. For the case: `SET kyc:active:{tenant}:{applicant} <id> NX`, and `cases.create` only when it won.',
  ],
  debrief: `Both fixes move a decision into Redis so it happens once. The attempt script reads and writes the counter in one step, and the window starts with the first attempt inside the same script, so the TTL it returns is the true time to wait. The case claim uses \`SET NX\` because the key itself is the lock: whoever sets it owns the case, and everyone else reads the winner's id. Putting the tenant in the key is a data-model decision, not a check: applicant references are each tenant's own. Production intake also caps attempts per document and per device fingerprint, because a determined fraudster rotates applicant references faster than any per-applicant counter fills.`,
};
