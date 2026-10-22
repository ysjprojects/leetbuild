import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis lease per fire window with atomic acquisition',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis', 'clock'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: one instance fires the job,
the window is recorded, and the demo looks correct. It breaks the moment two scheduler instances
run, and it forgets every fire that dies. Review it like the owner of the scheduler, fix it, and
prove the fix with the checks below.

Implement the fire path that decides, per window, whether **this** instance may run the job.

- A window is the minute bucket of the fire time: \`window = floor(fire_time / 60) * 60\`
  (\`WINDOW_S = 60\`). Every (schedule, window) pair is fired **exactly once** by the whole fleet.
- Acquisition must be **one atomic command**: \`SET lease:{schedule_id}:{window} <owner> NX EX
  LEASE_TTL_S\` (or the stack's equivalent single round trip). A read of a last-run timestamp
  followed by a write is not a lease: during a rolling deploy both instances read the same old
  value, both decide they may fire, and the job runs twice in the same window.
- The lease **expires**: \`LEASE_TTL_S = 30\`, strictly shorter than \`WINDOW_S\`, so a lease
  outlives its window only briefly and can never bleed into the next one. A lease without an
  expiry becomes a permanent lock after one crash.
- The instance that **loses** the race returns without touching the job. Only a winner calls
  \`job.trigger(schedule_id, window)\`.
- **Record an outcome for the window** as soon as the fire resolves: \`record_outcome(schedule_id,
  window, "fired")\` on success and \`record_outcome(schedule_id, window, "error")\` when the fire
  raises. The draft writes nothing on failure, so a crashed fire leaves the window with no record
  and the next tick tries the same window again — forever.

**Failure mode the checks target.** \`GET\` then \`SET\` is a check-then-act race, and a rolling
deploy is exactly the schedule that runs two instances. A lease with no TTL is a deadlock waiting
for one crash. And a fire path that records only successes turns a permanently failing window into
an infinite retry loop that no history read can ever explain.`,
  sequence: {
    participants: ['Scheduler API (A)', 'Scheduler API (B)', 'Redis', 'Job service'],
    messages: [
      {from: 'Scheduler API (A)', to: 'Redis', label: 'SET lease:{id}:{window} owner=A NX EX 30', kind: 'sync'},
      {from: 'Scheduler API (B)', to: 'Redis', label: 'SET lease:{id}:{window} owner=B NX EX 30', kind: 'sync'},
      {from: 'Redis', to: 'Scheduler API (A)', label: 'OK — A owns the window', kind: 'reply'},
      {from: 'Redis', to: 'Scheduler API (B)', label: 'nil — already leased, return', kind: 'reply'},
      {from: 'Scheduler API (A)', to: 'Job service', label: 'trigger(schedule_id, window)', kind: 'sync'},
      {from: 'Scheduler API (A)', to: 'Redis', label: 'HSET outcome:{id} {window} = fired | error', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'atomic-acquire',
      title: 'Acquires the window lease in one atomic command',
      detail:
        'The lease is taken with a single `SET ... NX EX` (or `SetNX`, `SetParams.nx().ex()`, `UpdateType::NOT_EXIST`): one round trip that only one instance can win. The draft reads a last-run timestamp and then writes it, two steps with a window in between.',
      match: {
        python: {all: [/nx=True/, /ex=LEASE_TTL_S/, /lease:\{schedule_id\}:\{window\}/]},
        typescript: {all: [/'NX'/, /LEASE_TTL_S/, /lease:\$\{scheduleId\}:\$\{window\}/]},
        go: {all: [/SetNX/, /leaseTTLS/, /lease:%s:%d/]},
        scala: {all: [/\.nx\(\)/, /\.ex\(LeaseTtlS\)/, /lease:\$scheduleId:\$window/]},
        cpp: {all: [/kLeaseTtlS/, /UpdateType::NOT_EXIST/, /"lease:"/]},
      },
    },
    {
      id: 'window-key',
      title: 'Keys the lease by schedule and fire window',
      detail:
        'The key is `lease:{schedule_id}:{window}` with the window being the `WINDOW_S = 60` bucket of the fire time. A schedule-wide key serialises every window into one; a window-less key lets the same window be retried by a second instance.',
      match: {
        python: {all: [/lease:\{schedule_id\}:\{window\}/, /WINDOW_S/]},
        typescript: {all: [/lease:\$\{scheduleId\}:\$\{window\}/, /WINDOW_S/]},
        go: {all: [/lease:%s:%d/, /windowSeconds/]},
        scala: {all: [/lease:\$scheduleId:\$window/, /WindowSeconds/]},
        cpp: {all: [/"lease:"/, /kWindowSeconds/]},
      },
    },
    {
      id: 'lease-ttl',
      title: 'Lease expires shortly after its window',
      detail:
        '`LEASE_TTL_S = 30` and the lease is asserted to be shorter than the window, so it expires just after the window it guards and never bleeds into the next one. The draft leaves no expiry at all.',
      match: {
        python: {all: [/LEASE_TTL_S\s*=\s*30/, /LEASE_TTL_S\s*[<>=]+\s*WINDOW_S/]},
        typescript: {all: [/LEASE_TTL_S\s*=\s*30/, /LEASE_TTL_S\s*[<>=]+\s*WINDOW_S/]},
        go: {all: [/leaseTTLS\s*=\s*30/, /leaseTTLS\s*[<>=]+\s*windowSeconds/]},
        scala: {all: [/LeaseTtlS\s*=\s*30/, /LeaseTtlS\s*[<>=]+\s*WindowSeconds/]},
        cpp: {all: [/kLeaseTtlS\s*=\s*30/, /kLeaseTtlS\s*[<>=]+\s*kWindowSeconds/]},
      },
    },
    {
      id: 'crash-outcome',
      title: 'Records an outcome for the window, including failures',
      detail:
        'The fire path writes `record_outcome(schedule_id, window, ...)`: `fired` on success and `error` when the trigger raises, so a crashed window has a record instead of being retried forever. The draft records nothing at all.',
      match: {
        python: {all: [/record_outcome\(/, /"error"/, /except\s+/]},
        typescript: {all: [/recordOutcome\(/, /'error'/, /catch\s*\(/]},
        go: {all: [/RecordOutcome\(/, /"error"/, /err != nil/]},
        scala: {all: [/recordOutcome\(/, /"error"/, /catch\s*\{/]},
        cpp: {all: [/recordOutcome\(/, /"error"/, /catch\s*\(/]},
      },
    },
    {
      id: 'single-winner',
      title: 'Only the lease winner fires the job',
      detail:
        'The lease is acquired **before** the job is triggered, and the losing instance returns without firing; nothing reads a last-run timestamp to decide. The draft triggers the job and only afterwards writes that it ran.',
      match: {
        python: {order: [/acquire_lease\(/, /\.trigger\(/], none: [/last_run/]},
        typescript: {order: [/acquireLease\(/, /\.trigger\(/], none: [/lastRun/]},
        go: {order: [/AcquireLease\(/, /\.Trigger\(/], none: [/lastRun/]},
        scala: {order: [/acquireLease\(/, /\.trigger\(/], none: [/lastRun/]},
        cpp: {order: [/acquireLease\(/, /trigger\(/], none: [/last_run/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)
logger = logging.getLogger("scheduler")


def fire_window(job, schedule_id: str, window: int, owner: str) -> str:
    # TODO: this draft reads the last-run timestamp and then writes it as two separate commands, so
    # a rolling deploy lets two instances fire the same window, and it records nothing when a fire
    # crashes, so the window is retried forever. Review both.
    last = r.get(f"last_run:{schedule_id}")
    if last is not None and int(last) >= window:
        return "skipped"
    job.trigger(schedule_id, window)
    r.set(f"last_run:{schedule_id}", window)
    return "fired"
`,
      solution: `import logging

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)
logger = logging.getLogger("scheduler")

LEASE_TTL_S = 30
WINDOW_S = 60
assert LEASE_TTL_S < WINDOW_S, "the lease must expire inside its window"


def window_of(fire_time: int) -> int:
    """The fire window a fire time belongs to: the minute bucket that owns it."""
    return fire_time // WINDOW_S * WINDOW_S


def acquire_lease(schedule_id: str, window: int, owner: str) -> bool:
    """One instance wins the window: SET NX with the TTL in a single round trip."""
    key = f"lease:{schedule_id}:{window}"
    return bool(r.set(key, owner, nx=True, ex=LEASE_TTL_S))


def record_outcome(schedule_id: str, window: int, outcome: str) -> None:
    """Record the outcome of a window so a crashed fire is not retried forever."""
    r.hset(f"outcome:{schedule_id}", str(window), outcome)


def fire_window(job, schedule_id: str, window: int, owner: str) -> str:
    if not acquire_lease(schedule_id, window, owner):
        logger.info("window leased elsewhere schedule=%s window=%d", schedule_id, window)
        return "leased-elsewhere"
    try:
        job.trigger(schedule_id, window)
    except Exception:
        record_outcome(schedule_id, window, "error")
        raise
    record_outcome(schedule_id, window, "fired")
    return "fired"
`,
    },
    typescript: {
      starter: `/** A model-generated draft that tracks the last run instead of leasing the window. */
import {Redis} from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export async function fireWindow(
  job: JobTrigger,
  scheduleId: string,
  window: number,
  owner: string,
): Promise<string> {
  // TODO: this draft reads the last-run timestamp and then writes it as two separate commands, so
  // a rolling deploy lets two instances fire the same window, and it records nothing when a fire
  // crashes, so the window is retried forever. Review both.
  const last = await redis.get(\`lastRun:\${scheduleId}\`);
  if (last !== null && Number(last) >= window) return 'skipped';
  await job.trigger(scheduleId, window);
  await redis.set(\`lastRun:\${scheduleId}\`, String(window));
  return 'fired';
}
`,
      solution: `/** One lease per (schedule, fire window): exactly one instance fires each window. */
import {Redis} from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

const LEASE_TTL_S = 30;
const WINDOW_S = 60;

if (LEASE_TTL_S >= WINDOW_S) throw new Error('the lease must expire inside its window');

/** The fire window a fire time belongs to: the minute bucket that owns it. */
export function windowOf(fireTime: number): number {
  return Math.floor(fireTime / WINDOW_S) * WINDOW_S;
}

/** One instance wins the window: SET key owner EX ttl NX in a single round trip. */
export async function acquireLease(scheduleId: string, window: number, owner: string): Promise<boolean> {
  const key = \`lease:\${scheduleId}:\${window}\`;
  const reply = await redis.set(key, owner, 'EX', LEASE_TTL_S, 'NX');
  return reply === 'OK';
}

export async function recordOutcome(scheduleId: string, window: number, outcome: string): Promise<void> {
  await redis.hset(\`outcome:\${scheduleId}\`, String(window), outcome);
}

export async function fireWindow(
  job: JobTrigger,
  scheduleId: string,
  window: number,
  owner: string,
): Promise<string> {
  if (!(await acquireLease(scheduleId, window, owner))) return 'leased-elsewhere';
  try {
    await job.trigger(scheduleId, window);
  } catch (err) {
    await recordOutcome(scheduleId, window, 'error');
    throw err;
  }
  await recordOutcome(scheduleId, window, 'fired');
  return 'fired';
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

var (
	rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})
	ctx = context.Background()
)

func FireWindow(job JobTrigger, scheduleID string, window int64, owner string) (string, error) {
	// TODO: this draft reads the last-run timestamp and then writes it as two separate commands, so
	// a rolling deploy lets two instances fire the same window, and it records nothing when a fire
	// crashes, so the window is retried forever. Review both.
	key := fmt.Sprintf("lastRun:%s", scheduleID)
	last, err := rdb.Get(ctx, key).Int64()
	if err == nil && last >= window {
		return "skipped", nil
	}
	if err := job.Trigger(scheduleID, window); err != nil {
		return "", err
	}
	rdb.Set(ctx, key, window, 0)
	return "fired", nil
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	leaseTTLS     = 30
	windowSeconds = 60
)

var (
	rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})
	ctx = context.Background()
)

func init() {
	if leaseTTLS >= windowSeconds {
		panic("the lease must expire inside its window")
	}
}

// windowOf is the minute bucket a fire time belongs to.
func windowOf(fireTime int64) int64 {
	return fireTime / windowSeconds * windowSeconds
}

// AcquireLease wins the window in one round trip: SET key owner NX EX ttl.
func AcquireLease(scheduleID string, window int64, owner string) (bool, error) {
	key := fmt.Sprintf("lease:%s:%d", scheduleID, window)
	return rdb.SetNX(ctx, key, owner, time.Duration(leaseTTLS)*time.Second).Result()
}

// RecordOutcome keeps a per-window record so a crashed fire is not retried forever.
func RecordOutcome(scheduleID string, window int64, outcome string) error {
	return rdb.HSet(ctx, fmt.Sprintf("outcome:%s", scheduleID), window, outcome).Err()
}

func FireWindow(job JobTrigger, scheduleID string, window int64, owner string) (string, error) {
	won, err := AcquireLease(scheduleID, window, owner)
	if err != nil {
		return "", err
	}
	if !won {
		return "leased-elsewhere", nil
	}
	if err := job.Trigger(scheduleID, window); err != nil {
		RecordOutcome(scheduleID, window, "error")
		return "", err
	}
	if err := RecordOutcome(scheduleID, window, "fired"); err != nil {
		return "", err
	}
	return "fired", nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.Jedis

object FireWindows {
  val redis = new Jedis("redis", 6379)

  def fireWindow(job: JobTrigger, scheduleId: String, window: Long, owner: String): String = {
    // TODO: this draft reads the last-run timestamp and then writes it as two separate commands, so
    // a rolling deploy lets two instances fire the same window, and it records nothing when a fire
    // crashes, so the window is retried forever. Review both.
    val key = s"lastRun:$scheduleId"
    val last = Option(redis.get(key)).flatMap(_.toLongOption)
    if (last.exists(_ >= window)) return "skipped"
    job.trigger(scheduleId, window)
    redis.set(key, window.toString)
    "fired"
  }
}
`,
      solution: `import redis.clients.jedis.{Jedis, SetParams}

object FireWindows {
  val LeaseTtlS = 30
  val WindowSeconds = 60
  require(LeaseTtlS < WindowSeconds, "the lease must expire inside its window")

  val redis = new Jedis("redis", 6379)

  /** The minute bucket a fire time belongs to. */
  def windowOf(fireTime: Long): Long = fireTime / WindowSeconds * WindowSeconds

  /** One instance wins the window: SET key owner NX EX ttl in a single round trip. */
  def acquireLease(scheduleId: String, window: Long, owner: String): Boolean = {
    val key = s"lease:$scheduleId:$window"
    redis.set(key, owner, SetParams.setParams().nx().ex(LeaseTtlS)) == "OK"
  }

  /** Record the outcome of a window so a crashed fire is not retried forever. */
  def recordOutcome(scheduleId: String, window: Long, outcome: String): Unit = {
    redis.hset(s"outcome:$scheduleId", window.toString, outcome)
  }

  def fireWindow(job: JobTrigger, scheduleId: String, window: Long, owner: String): String = {
    if (!acquireLease(scheduleId, window, owner)) return "leased-elsewhere"
    try {
      job.trigger(scheduleId, window)
    } catch {
      case error: Exception =>
        recordOutcome(scheduleId, window, "error")
        throw error
    }
    recordOutcome(scheduleId, window, "fired")
    "fired"
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <optional>
#include <string>

using sw::redis::Redis;

Redis redis("tcp://redis:6379");

std::string fireWindow(JobTrigger& job, const std::string& scheduleId, long window,
                       const std::string& owner) {
  // TODO: this draft reads the last-run timestamp and then writes it as two separate commands, so a
  // rolling deploy lets two instances fire the same window, and it records nothing when a fire
  // crashes, so the window is retried forever. Review both.
  const auto key = "last_run:" + scheduleId;
  const auto last = redis.get(key);
  if (last.has_value() && std::stol(*last) >= window) return "skipped";
  job.trigger(scheduleId, window);
  redis.set(key, std::to_string(window));
  return "fired";
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <optional>
#include <string>

using sw::redis::Redis;

constexpr int kLeaseTtlS = 30;
constexpr int kWindowSeconds = 60;
static_assert(kLeaseTtlS < kWindowSeconds, "the lease must expire inside its window");

Redis redis("tcp://redis:6379");

/** The minute bucket a fire time belongs to. */
long windowOf(long fireTime) {
  return fireTime / kWindowSeconds * kWindowSeconds;
}

/** One instance wins the window: SET key owner NX EX ttl in a single round trip. */
bool acquireLease(const std::string& scheduleId, long window, const std::string& owner) {
  const auto key = "lease:" + scheduleId + ":" + std::to_string(window);
  return redis.set(key, owner, std::chrono::seconds(kLeaseTtlS), sw::redis::UpdateType::NOT_EXIST);
}

/** Record the outcome of a window so a crashed fire is not retried forever. */
void recordOutcome(const std::string& scheduleId, long window, const std::string& outcome) {
  redis.hset("outcome:" + scheduleId, std::to_string(window), outcome);
}

std::string fireWindow(JobTrigger& job, const std::string& scheduleId, long window,
                       const std::string& owner) {
  if (!acquireLease(scheduleId, window, owner)) return "leased-elsewhere";
  try {
    job.trigger(scheduleId, window);
  } catch (const std::exception&) {
    recordOutcome(scheduleId, window, "error");
    throw;
  }
  recordOutcome(scheduleId, window, "fired");
  return "fired";
}
`,
    },
  },
  hints: [
    'A lease is one command, not two. `SET key owner NX EX ttl` (or `SetNX` with a TTL, `SetParams.nx().ex(...)`) either wins or returns nil in a single round trip; a `GET` followed by a `SET` has a window in which the other instance reads the same old value and decides the same thing.',
    'Include the fire window in the key and give the key a TTL. `lease:{schedule_id}:{window}` is what makes the next window independent, and a TTL shorter than the window means a crashed lease clears long before the window comes round again.',
    'The loser must not touch the job, and the winner must always leave a record: return before the trigger when the lease was not won, and write `fired` or `error` for the window after it resolves. A window with no record is a window the fleet will keep retrying.',
  ],
  debrief: `The interviewer is testing the fire path for mutual exclusion. The draft passes because the demo runs one instance and never crashes. Four defects are checked: check-then-act acquisition that a rolling deploy defeats, a key that lumps every window together, a lease with no expiry that becomes a permanent lock, and a fire path that records only successes so a failing window retries forever. Real schedulers add a fencing token to the lease so a paused process cannot act on a stale grant, keep the outcome record separate from the lease so the history survives the TTL, and derive the window from a single clock source rather than each node's wall clock.`,
};
