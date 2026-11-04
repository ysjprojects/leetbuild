import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis lease per fire window, claimed in one command',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis', 'clock'],
  task: `## Task

**Starting point.** The starter is \`fire_window(schedule_id, tick, owner, trigger)\`, which every
scheduler instance calls when its ticker fires: it uses \`tick\` as the window, \`GET\`s
\`lease:{schedule_id}:{window}\` and returns \`taken\` when it exists, otherwise \`SET\`s it to \`owner\`,
calls \`trigger(schedule_id, window)\`, records \`fired\` with \`store.record_run\` and returns \`fired\`.
It serves the demo, where one instance runs, and hides 4 flaws.

**Failure mode the checks target.** Two instances whose tickers land in the same minute, two clocks a
few seconds apart, a Redis that keeps one lease per schedule per minute forever, and a job service
that is down.

- The window is the minute the tick falls in: \`window_of(tick)\`. Every tick of one minute claims the
  same lease, and \`trigger\` receives that window.
- The claim is **one command**: \`SET lease:{schedule_id}:{window} owner NX EX 300\`
  (\`LEASE_TTL_S = 300\`). Only the instance that set it fires; the others return \`taken\`.
- The lease expires after \`LEASE_TTL_S\`.
- A trigger that raises is recorded: \`record_run(schedule_id, window, "error", "trigger_failed")\`,
  and \`fire_window\` returns \`error\` instead of raising.`,
  sequence: {
    participants: ['Scheduler A', 'Scheduler B', 'Redis', 'Job service'],
    messages: [
      {from: 'Scheduler A', to: 'Redis', label: 'SET lease:{id}:{window} A NX EX 300', kind: 'sync'},
      {from: 'Scheduler B', to: 'Redis', label: 'SET lease:{id}:{window} B NX EX 300', kind: 'sync'},
      {from: 'Redis', to: 'Scheduler A', label: 'OK: A owns the window', kind: 'reply'},
      {from: 'Redis', to: 'Scheduler B', label: 'nil: taken', kind: 'reply'},
      {from: 'Scheduler A', to: 'Job service', label: 'trigger(schedule_id, window)', kind: 'sync'},
      {from: 'Scheduler A', to: 'Redis', label: 'HSET runs:{id} {window} fired | error:trigger_failed', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'atomic-claim',
      title: 'Lets exactly one of two racing instances fire',
      detail:
        'A second instance claiming the window right after the first command on the lease leaves the job run once. The starter reads the lease with `GET` and writes it with a later `SET`.',
      match: {
        python: {all: [/\.set\([^\n]*nx\s*=\s*True/], none: [/\br\.get\(|\.exists\(/]},
        typescript: {all: [/\.set\([^\n]*['"]NX['"]/], none: [/redis\.get\(|redis\.exists\(/]},
        go: {all: [/\.SetNX\(|Mode:\s*"NX"/], none: [/rdb\.Get\(|rdb\.Exists\(/]},
        scala: {all: [/\.nx\(\)/], none: [/jedis\.get\(|jedis\.exists\(/]},
        cpp: {all: [/UpdateType::NOT_EXIST/], none: [/\.(get|exists)\(\s*(key|cronsched::LeaseKey)/]},
      },
    },
    {
      id: 'window-bucket',
      title: 'Claims the minute, not the tick',
      detail:
        'Ticks 2 s and 7 s into the 09:00 minute claim one lease, `lease:s1:{09:00}`, and the job runs once with that window. The starter uses the tick itself as the window.',
      match: {
        python: {all: [/window_of\(\s*tick\s*\)|tick\s*\/\/\s*(WINDOW_S|60)\b/]},
        typescript: {all: [/windowOf\(\s*tick\s*\)|Math\.floor\(\s*tick\s*\/\s*(WINDOW_S|60)\b/]},
        go: {all: [/cron\.WindowOf\(\s*tick\s*\)|tick\s*\/\s*(cron\.WindowS|60)\s*\*/]},
        scala: {all: [/Cron\.windowOf\(\s*tick\s*\)|floorDiv\(\s*tick\s*,/]},
        cpp: {all: [/cron::WindowOf\(\s*tick\s*\)|FloorDiv\(\s*tick\s*,/]},
      },
    },
    {
      id: 'lease-ttl',
      title: 'Expires the lease after 300 s',
      detail:
        'After a fire the lease has a TTL of at most 300 s and is gone once it passes. The starter writes a lease that never expires.',
      match: {
        python: {all: [/ex\s*=\s*(LEASE_TTL_S|300)\b/]},
        typescript: {all: [/['"]EX['"]\s*,\s*(LEASE_TTL_S|300)\b/]},
        go: {
          all: [/SetNX\([^\n]*,\s*(leaseTTL|300\s*\*\s*time\.Second)\s*\)|TTL:\s*(leaseTTL|300\s*\*\s*time\.Second)/],
        },
        scala: {all: [/\.ex\(\s*(LeaseTtlS|300L?)\s*\)/]},
        cpp: {all: [/std::chrono::seconds\(\s*(kLeaseTtlS|300)\s*\)/]},
      },
    },
    {
      id: 'error-recorded',
      title: 'Records a failed trigger and returns error',
      detail:
        'A trigger that raises leaves `runs:s1` holding the window as `error:trigger_failed`, and `fire_window` returns `error`. The starter records only successes.',
      match: {
        python: {all: [/["']error["']\s*,\s*["']trigger_failed["']/]},
        typescript: {all: [/['"]error['"]\s*,\s*['"]trigger_failed['"]/]},
        go: {all: [/"error",\s*"trigger_failed"/]},
        scala: {all: [/"error",\s*"trigger_failed"/]},
        cpp: {all: [/"error",\s*"trigger_failed"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

from cronsched.store import lease_key, store

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def fire_window(schedule_id: str, tick: int, owner: str, trigger) -> str:
    """Fire the window \`tick\` falls in, once across every instance: fired, error or taken."""
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    window = int(tick)
    key = lease_key(schedule_id, window)
    if r.get(key) is not None:
        return "taken"
    r.set(key, owner)
    trigger(schedule_id, window)
    store.record_run(schedule_id, window, "fired", "")
    return "fired"
`,
      solution: `import redis

from cronsched.cron import window_of
from cronsched.store import lease_key, store

LEASE_TTL_S = 300  # the minute, plus room for clock skew between instances; then Redis forgets it

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def fire_window(schedule_id: str, tick: int, owner: str, trigger) -> str:
    """Fire the window \`tick\` falls in, once across every instance: fired, error or taken."""
    window = window_of(tick)
    # One command decides the winner: no other instance can land between the check and the claim.
    if not r.set(lease_key(schedule_id, window), owner, nx=True, ex=LEASE_TTL_S):
        return "taken"
    try:
        trigger(schedule_id, window)
    except Exception:
        # The ledger says the window was attempted and failed: the history shows an error, not a gap.
        store.record_run(schedule_id, window, "error", "trigger_failed")
        return "error"
    store.record_run(schedule_id, window, "fired", "")
    return "fired"
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import {leaseKey, store} from 'cronsched/store';

const redis = new Redis({host: 'redis', port: 6379});

/** Fire the window \`tick\` falls in, once across every instance: fired, error or taken. */
export async function fireWindow(
  scheduleId: string,
  tick: number,
  owner: string,
  trigger: (scheduleId: string, window: number) => Promise<void>,
): Promise<string> {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const window = tick;
  const key = leaseKey(scheduleId, window);
  if ((await redis.get(key)) !== null) return 'taken';
  await redis.set(key, owner);
  await trigger(scheduleId, window);
  await store.recordRun(scheduleId, window, 'fired', '');
  return 'fired';
}
`,
      solution: `import Redis from 'ioredis';

import {windowOf} from 'cronsched/cron';
import {leaseKey, store} from 'cronsched/store';

/** The minute, plus room for clock skew between instances; then Redis forgets it. */
export const LEASE_TTL_S = 300;

const redis = new Redis({host: 'redis', port: 6379});

/** Fire the window \`tick\` falls in, once across every instance: fired, error or taken. */
export async function fireWindow(
  scheduleId: string,
  tick: number,
  owner: string,
  trigger: (scheduleId: string, window: number) => Promise<void>,
): Promise<string> {
  const window = windowOf(tick);
  // One command decides the winner: no other instance can land between the check and the claim.
  const claimed = await redis.set(leaseKey(scheduleId, window), owner, 'EX', LEASE_TTL_S, 'NX');
  if (claimed !== 'OK') return 'taken';
  try {
    await trigger(scheduleId, window);
  } catch {
    // The ledger says the window was attempted and failed: the history shows an error, not a gap.
    await store.recordRun(scheduleId, window, 'error', 'trigger_failed');
    return 'error';
  }
  await store.recordRun(scheduleId, window, 'fired', '');
  return 'fired';
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"github.com/redis/go-redis/v9"

	"cronsched/store"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// fireWindow fires the window tick falls in, once across every instance: fired, error or taken.
func fireWindow(ctx context.Context, scheduleID string, tick int64, owner string, trigger func(scheduleID string, window int64) error) (string, error) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	window := tick
	key := store.LeaseKey(scheduleID, window)
	n, err := rdb.Exists(ctx, key).Result()
	if err != nil {
		return "", err
	}
	if n > 0 {
		return "taken", nil
	}
	if err := rdb.Set(ctx, key, owner, 0).Err(); err != nil {
		return "", err
	}
	if err := trigger(scheduleID, window); err != nil {
		return "", err
	}
	return "fired", store.RecordRun(ctx, scheduleID, window, "fired", "")
}
`,
      solution: `package main

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"

	"cronsched/cron"
	"cronsched/store"
)

// leaseTTL is the minute, plus room for clock skew between instances; then Redis forgets it.
const leaseTTL = 300 * time.Second

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// fireWindow fires the window tick falls in, once across every instance: fired, error or taken.
func fireWindow(ctx context.Context, scheduleID string, tick int64, owner string, trigger func(scheduleID string, window int64) error) (string, error) {
	window := cron.WindowOf(tick)
	// One command decides the winner: no other instance can land between the check and the claim.
	claimed, err := rdb.SetNX(ctx, store.LeaseKey(scheduleID, window), owner, leaseTTL).Result()
	if err != nil {
		return "", err
	}
	if !claimed {
		return "taken", nil
	}
	if err := trigger(scheduleID, window); err != nil {
		// The ledger says the window was attempted and failed: the history shows an error, not a gap.
		return "error", store.RecordRun(ctx, scheduleID, window, "error", "trigger_failed")
	}
	return "fired", store.RecordRun(ctx, scheduleID, window, "fired", "")
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

import cronsched.Store

object Leases {
  private val jedis = new JedisPooled("redis", 6379)

  /** Fire the window \`tick\` falls in, once across every instance: fired, error or taken. */
  def fireWindow(scheduleId: String, tick: Long, owner: String, trigger: (String, Long) => Unit): String = {
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    val window = tick
    val key = Store.leaseKey(scheduleId, window)
    if (jedis.get(key) != null) "taken"
    else {
      jedis.set(key, owner)
      trigger(scheduleId, window)
      Store.recordRun(scheduleId, window, "fired", "")
      "fired"
    }
  }
}
`,
      solution: `import scala.util.Try

import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

import cronsched.{Cron, Store}

object Leases {
  /** The minute, plus room for clock skew between instances; then Redis forgets it. */
  val LeaseTtlS = 300L

  private val jedis = new JedisPooled("redis", 6379)

  /** Fire the window \`tick\` falls in, once across every instance: fired, error or taken. */
  def fireWindow(scheduleId: String, tick: Long, owner: String, trigger: (String, Long) => Unit): String = {
    val window = Cron.windowOf(tick)
    // One command decides the winner: no other instance can land between the check and the claim.
    val claimed = jedis.set(Store.leaseKey(scheduleId, window), owner, SetParams.setParams().nx().ex(LeaseTtlS))
    if (claimed == null) "taken"
    else if (Try(trigger(scheduleId, window)).isFailure) {
      // The ledger says the window was attempted and failed: the history shows an error, not a gap.
      Store.recordRun(scheduleId, window, "error", "trigger_failed")
      "error"
    } else {
      Store.recordRun(scheduleId, window, "fired", "")
      "fired"
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <cstdint>
#include <functional>
#include <string>

#include "cronsched/store.h"

sw::redis::Redis& leases() {
  static sw::redis::Redis redis("tcp://redis:6379");
  return redis;
}

// Fire the window tick falls in, once across every instance: fired, error or taken.
std::string fireWindow(const std::string& schedule_id, int64_t tick, const std::string& owner,
                       const std::function<bool(const std::string&, int64_t)>& trigger) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const int64_t window = tick;
  const std::string key = cronsched::LeaseKey(schedule_id, window);
  if (leases().get(key)) return "taken";
  leases().set(key, owner);
  if (!trigger(schedule_id, window)) return "error";
  cronsched::store::RecordRun(schedule_id, window, "fired", "");
  return "fired";
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <cstdint>
#include <functional>
#include <string>

#include "cronsched/cron.h"
#include "cronsched/store.h"

// The minute, plus room for clock skew between instances; then Redis forgets it.
constexpr int kLeaseTtlS = 300;

sw::redis::Redis& leases() {
  static sw::redis::Redis redis("tcp://redis:6379");
  return redis;
}

// Fire the window tick falls in, once across every instance: fired, error or taken.
std::string fireWindow(const std::string& schedule_id, int64_t tick, const std::string& owner,
                       const std::function<bool(const std::string&, int64_t)>& trigger) {
  const int64_t window = cronsched::cron::WindowOf(tick);
  // One command decides the winner: no other instance can land between the check and the claim.
  const bool claimed = leases().set(cronsched::LeaseKey(schedule_id, window), owner, std::chrono::seconds(kLeaseTtlS),
                                    sw::redis::UpdateType::NOT_EXIST);
  if (!claimed) return "taken";
  if (!trigger(schedule_id, window)) {
    // The ledger says the window was attempted and failed: the history shows an error, not a gap.
    cronsched::store::RecordRun(schedule_id, window, "error", "trigger_failed");
    return "error";
  }
  cronsched::store::RecordRun(schedule_id, window, "fired", "");
  return "fired";
}
`,
    },
  },
  harness: {
    python: `from cronsched.store import lease_key, store

S = "s1"
W = 1773133200  # 2026-03-10T09:00:00Z: a fire window, the start of a minute


def _trigger(fired):
    def trigger(schedule_id, window):
        fired.append((schedule_id, window))

    return trigger


def check_atomic_claim(ctx):
    m = ctx.load("state")
    fired = []

    # Instance b's ticker lands right after instance a's first command on the lease: b claims the
    # window if it can, and fires if it did.
    def instance_b():
        if ctx.redis.set(lease_key(S, W), "b", nx=True, ex=300):
            fired.append((S, W))
            return True
        return False

    probe = ctx.redis_after(lease_key(S, W), instance_b)
    outcome = m.fire_window(S, W, "a", _trigger(fired))
    assert probe.fired, f"fire_window never touched {lease_key(S, W)}"
    assert len(fired) == 1, f"two instances ticked on the 09:00 window and the job ran {len(fired)} times: instance b claimed the lease between your check and your write, so the check and the claim must be one command (SET ... NX)"
    expected = "taken" if probe.result else "fired"
    assert outcome == expected, f"fire_window returned {outcome!r}, expected {expected!r}"


def check_window_bucket(ctx):
    m = ctx.load("state")
    fired = []
    a = m.fire_window(S, W + 2, "a", _trigger(fired))
    b = m.fire_window(S, W + 7, "b", _trigger(fired))
    leases = sorted(ctx.redis.keys("lease:*"))
    assert len(fired) == 1, f"instances a and b ticked 2 s and 7 s into the 09:00 minute and the job ran {len(fired)} times (leases {leases}): both ticks belong to window {W}, so both claim {lease_key(S, W)}"
    assert fired[0][1] == W, f"the trigger received window {fired[0][1]}, expected the start of the minute, {W}"
    assert (a, b) == ("fired", "taken"), f"fire_window returned {a!r} then {b!r}, expected 'fired' then 'taken'"
    runs = store.runs(S)
    assert runs == [{"window": W, "outcome": "fired", "reason": ""}], f"the ledger runs:s1 holds {runs}, expected one fired row for window {W}"


def check_lease_ttl(ctx):
    m = ctx.load("state")
    m.fire_window(S, W, "a", _trigger([]))
    ttl = ctx.redis.ttl(lease_key(S, W))
    assert 0 < ttl <= 300, f"{lease_key(S, W)} has TTL {ttl}, expected at most 300 s: a lease that never expires is one key per schedule per minute, kept forever"
    ctx.clock.advance(301)
    assert ctx.redis.exists(lease_key(S, W)) == 0, f"{lease_key(S, W)} still exists 301 s after the fire"


def check_error_recorded(ctx):
    m = ctx.load("state")

    def failing(schedule_id, window):
        raise RuntimeError("job service unreachable")

    try:
        outcome = m.fire_window(S, W, "a", failing)
    except RuntimeError:
        outcome = None
    assert outcome == "error", f"a trigger that raised made fire_window {'raise' if outcome is None else f'return {outcome!r}'}, expected it to return 'error'"
    runs = store.runs(S)
    assert runs == [{"window": W, "outcome": "error", "reason": "trigger_failed"}], f"after a failed trigger the ledger runs:s1 holds {runs}, expected window {W} as error with reason trigger_failed: without the row the window reads as never attempted"
    assert m.fire_window(S, W + 60, "a", _trigger([])) == "fired", "the next window, with the job service back, must fire"
    assert [row["outcome"] for row in store.runs(S)] == ["error", "fired"], f"the ledger runs:s1 holds {store.runs(S)}, expected error then fired"
`,
    typescript: `import {leaseKey, store} from 'cronsched/store';

const S = 's1';
const W = 1773133200; // 2026-03-10T09:00:00Z: a fire window, the start of a minute

const trigger = (fired: [string, number][]) => async (scheduleId: string, window: number) => {
  fired.push([scheduleId, window]);
};

export async function check_atomic_claim(ctx) {
  const m = ctx.load('state');
  const fired: [string, number][] = [];
  // Instance b's ticker lands right after instance a's first command on the lease: b claims the
  // window if it can, and fires if it did.
  const probe = ctx.redisAfter(leaseKey(S, W), () => {
    const won = ctx.redis.set(leaseKey(S, W), 'b', 'NX', 'EX', 300) === 'OK';
    if (won) fired.push([S, W]);
    return won;
  });
  const outcome = await m.fireWindow(S, W, 'a', trigger(fired));
  assert(probe.fired, \`fireWindow never touched \${leaseKey(S, W)}\`);
  assert.equal(fired.length, 1, \`two instances ticked on the 09:00 window and the job ran \${fired.length} times: instance b claimed the lease between your check and your write, so the check and the claim must be one command (SET ... NX)\`);
  const expected = probe.result ? 'taken' : 'fired';
  assert.equal(outcome, expected, \`fireWindow resolved \${JSON.stringify(outcome)}, expected \${expected}\`);
}

export async function check_window_bucket(ctx) {
  const m = ctx.load('state');
  const fired: [string, number][] = [];
  const a = await m.fireWindow(S, W + 2, 'a', trigger(fired));
  const b = await m.fireWindow(S, W + 7, 'b', trigger(fired));
  const leases = ctx.redis.keys('lease:*').sort();
  assert.equal(fired.length, 1, \`instances a and b ticked 2 s and 7 s into the 09:00 minute and the job ran \${fired.length} times (leases \${JSON.stringify(leases)}): both ticks belong to window \${W}, so both claim \${leaseKey(S, W)}\`);
  assert.equal(fired[0][1], W, \`the trigger received window \${fired[0][1]}, expected the start of the minute, \${W}\`);
  assert.deepEqual([a, b], ['fired', 'taken'], \`fireWindow resolved \${a} then \${b}, expected fired then taken\`);
  const runs = await store.runs(S);
  assert.deepEqual(runs, [{window: W, outcome: 'fired', reason: ''}], \`the ledger runs:s1 holds \${JSON.stringify(runs)}, expected one fired row for window \${W}\`);
}

export async function check_lease_ttl(ctx) {
  const m = ctx.load('state');
  await m.fireWindow(S, W, 'a', trigger([]));
  const ttl = ctx.redis.ttl(leaseKey(S, W));
  assert(0 < ttl && ttl <= 300, \`\${leaseKey(S, W)} has TTL \${ttl}, expected at most 300 s: a lease that never expires is one key per schedule per minute, kept forever\`);
  ctx.clock.advance(301);
  assert.equal(ctx.redis.exists(leaseKey(S, W)), 0, \`\${leaseKey(S, W)} still exists 301 s after the fire\`);
}

export async function check_error_recorded(ctx) {
  const m = ctx.load('state');
  let outcome: string | null = null;
  try {
    outcome = await m.fireWindow(S, W, 'a', async () => {
      throw new Error('job service unreachable');
    });
  } catch {
    outcome = null;
  }
  assert.equal(outcome, 'error', \`a trigger that rejected made fireWindow \${outcome === null ? 'reject' : \`resolve \${JSON.stringify(outcome)}\`}, expected it to resolve 'error'\`);
  const runs = await store.runs(S);
  assert.deepEqual(runs, [{window: W, outcome: 'error', reason: 'trigger_failed'}], \`after a failed trigger the ledger runs:s1 holds \${JSON.stringify(runs)}, expected window \${W} as error with reason trigger_failed: without the row the window reads as never attempted\`);
  assert.equal(await m.fireWindow(S, W + 60, 'a', trigger([])), 'fired', 'the next window, with the job service back, must fire');
  const outcomes = (await store.runs(S)).map(row => row.outcome);
  assert.deepEqual(outcomes, ['error', 'fired'], \`the ledger runs:s1 holds \${JSON.stringify(outcomes)}, expected error then fired\`);
}
`,
    go: `package main

import (
	"context"
	"errors"

	"leetbuild/harness"

	"cronsched/store"
)

const stateSchedule = "s1"

// stateWindow is 2026-03-10T09:00:00Z: a fire window, the start of a minute.
const stateWindow int64 = 1773133200

type stateFire struct {
	scheduleID string
	window     int64
}

func stateTrigger(fired *[]stateFire) func(string, int64) error {
	return func(scheduleID string, window int64) error {
		*fired = append(*fired, stateFire{scheduleID, window})
		return nil
	}
}

func stateRuns(ctx *harness.Ctx) []store.Run {
	runs, err := store.Runs(context.Background(), stateSchedule)
	ctx.NoError(err, "reading the ledger")
	return runs
}

func CheckAtomicClaim(ctx *harness.Ctx) {
	var fired []stateFire
	key := store.LeaseKey(stateSchedule, stateWindow)
	// Instance b's ticker lands right after instance a's first command on the lease: b claims the
	// window if it can, and fires if it did.
	won := false
	probe := ctx.Redis.After(key, func() any {
		won = ctx.Redis.Set(key, "b", "NX", "EX", 300)
		if won {
			fired = append(fired, stateFire{stateSchedule, stateWindow})
		}
		return won
	})
	outcome, err := fireWindow(context.Background(), stateSchedule, stateWindow, "a", stateTrigger(&fired))
	ctx.NoError(err, "fireWindow")
	ctx.Assert(probe.Fired, "fireWindow never touched %s", key)
	ctx.Assert(len(fired) == 1, "two instances ticked on the 09:00 window and the job ran %d times: instance b claimed the lease between your check and your write, so the check and the claim must be one command (SET ... NX)", len(fired))
	expected := "fired"
	if won {
		expected = "taken"
	}
	ctx.Equal(outcome, expected, "fireWindow's outcome")
}

func CheckWindowBucket(ctx *harness.Ctx) {
	var fired []stateFire
	a, err := fireWindow(context.Background(), stateSchedule, stateWindow+2, "a", stateTrigger(&fired))
	ctx.NoError(err, "fireWindow")
	b, err := fireWindow(context.Background(), stateSchedule, stateWindow+7, "b", stateTrigger(&fired))
	ctx.NoError(err, "fireWindow")
	ctx.Assert(len(fired) == 1, "instances a and b ticked 2 s and 7 s into the 09:00 minute and the job ran %d times (leases %q): both ticks belong to window %d, so both claim %s", len(fired), ctx.Redis.Keys("lease:*"), stateWindow, store.LeaseKey(stateSchedule, stateWindow))
	ctx.Equal(fired[0].window, stateWindow, "the window the trigger received (the start of the minute)")
	ctx.Assert(a == "fired" && b == "taken", "fireWindow returned %q then %q, expected fired then taken", a, b)
	ctx.Equal(stateRuns(ctx), []store.Run{{Window: stateWindow, Outcome: "fired", Reason: ""}}, "the ledger runs:s1 (one fired row for the window)")
}

func CheckLeaseTtl(ctx *harness.Ctx) {
	var fired []stateFire
	_, err := fireWindow(context.Background(), stateSchedule, stateWindow, "a", stateTrigger(&fired))
	ctx.NoError(err, "fireWindow")
	key := store.LeaseKey(stateSchedule, stateWindow)
	ttl := ctx.Redis.TTL(key)
	ctx.Assert(0 < ttl && ttl <= 300, "%s has TTL %d, expected at most 300 s: a lease that never expires is one key per schedule per minute, kept forever", key, ttl)
	ctx.Clock.Advance(301)
	ctx.Equal(ctx.Redis.Exists(key), int64(0), "%s 301 s after the fire", key)
}

func CheckErrorRecorded(ctx *harness.Ctx) {
	failing := func(string, int64) error { return errors.New("job service unreachable") }
	outcome, err := fireWindow(context.Background(), stateSchedule, stateWindow, "a", failing)
	ctx.Assert(err == nil && outcome == "error", "a trigger that failed made fireWindow return (%q, %v), expected (\\"error\\", nil)", outcome, err)
	ctx.Equal(stateRuns(ctx), []store.Run{{Window: stateWindow, Outcome: "error", Reason: "trigger_failed"}}, "the ledger runs:s1 after a failed trigger (without the row the window reads as never attempted)")
	var fired []stateFire
	outcome, err = fireWindow(context.Background(), stateSchedule, stateWindow+60, "a", stateTrigger(&fired))
	ctx.NoError(err, "fireWindow")
	ctx.Equal(outcome, "fired", "the next window, with the job service back")
	ctx.Equal(len(stateRuns(ctx)), 2, "the ledger rows after an error and a fire")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <cstdint>
#include <string>
#include <utility>
#include <vector>

#include "cronsched/store.h"

namespace {

const std::string kStateSchedule = "s1";
constexpr int64_t kStateWindow = 1773133200;  // 2026-03-10T09:00:00Z: a fire window, the start of a minute

std::function<bool(const std::string&, int64_t)> stateTrigger(std::vector<std::pair<std::string, int64_t>>& fired) {
  return [&fired](const std::string& schedule_id, int64_t window) {
    fired.emplace_back(schedule_id, window);
    return true;
  };
}

std::string stateRuns() {
  std::string out;
  for (const auto& run : cronsched::store::Runs(kStateSchedule)) {
    out += std::to_string(run.window) + "=" + run.outcome + ":" + run.reason + ";";
  }
  return out;
}

}  // namespace

void CheckAtomicClaim(harness::Ctx& ctx) {
  std::vector<std::pair<std::string, int64_t>> fired;
  const std::string key = cronsched::LeaseKey(kStateSchedule, kStateWindow);
  // Instance b's ticker lands right after instance a's first command on the lease: b claims the
  // window if it can, and fires if it did.
  bool probed = false;
  bool won = false;
  ctx.Redis.After(key, [&] {
    probed = true;
    won = ctx.Redis.Set(key, "b", "NX", "EX", 300);
    if (won) fired.emplace_back(kStateSchedule, kStateWindow);
  });
  const std::string outcome = fireWindow(kStateSchedule, kStateWindow, "a", stateTrigger(fired));
  ctx.Assert(probed, "fireWindow never touched %s", key);
  ctx.Assert(fired.size() == 1,
             "two instances ticked on the 09:00 window and the job ran %d times: instance b claimed the lease between your check "
             "and your write, so the check and the claim must be one command (SET ... NX)",
             fired.size());
  ctx.Equal(outcome, std::string(won ? "taken" : "fired"), "fireWindow's outcome");
}

void CheckWindowBucket(harness::Ctx& ctx) {
  std::vector<std::pair<std::string, int64_t>> fired;
  const std::string a = fireWindow(kStateSchedule, kStateWindow + 2, "a", stateTrigger(fired));
  const std::string b = fireWindow(kStateSchedule, kStateWindow + 7, "b", stateTrigger(fired));
  ctx.Assert(fired.size() == 1,
             "instances a and b ticked 2 s and 7 s into the 09:00 minute and the job ran %d times (leases %q): both ticks belong to "
             "window %d, so both claim %s",
             fired.size(), ctx.Redis.Keys("lease:*"), kStateWindow, cronsched::LeaseKey(kStateSchedule, kStateWindow));
  ctx.Equal(fired[0].second, kStateWindow, "the window the trigger received (the start of the minute)");
  ctx.Assert(a == "fired" && b == "taken", "fireWindow returned %s then %s, expected fired then taken", a, b);
  ctx.Equal(stateRuns(), std::to_string(kStateWindow) + "=fired:;", "the ledger runs:s1 (one fired row for the window)");
}

void CheckLeaseTtl(harness::Ctx& ctx) {
  std::vector<std::pair<std::string, int64_t>> fired;
  fireWindow(kStateSchedule, kStateWindow, "a", stateTrigger(fired));
  const std::string key = cronsched::LeaseKey(kStateSchedule, kStateWindow);
  const long long ttl = ctx.Redis.TTL(key);
  ctx.Assert(0 < ttl && ttl <= 300,
             "%s has TTL %d, expected at most 300 s: a lease that never expires is one key per schedule per minute, kept forever", key,
             ttl);
  ctx.Clock.Advance(301);
  ctx.Equal(ctx.Redis.Exists(key), 0, "%s 301 s after the fire", key);
}

void CheckErrorRecorded(harness::Ctx& ctx) {
  const std::string outcome = fireWindow(kStateSchedule, kStateWindow, "a", [](const std::string&, int64_t) { return false; });
  ctx.Equal(outcome, "error", "fireWindow's outcome for a trigger that failed");
  ctx.Equal(stateRuns(), std::to_string(kStateWindow) + "=error:trigger_failed;",
            "the ledger runs:s1 after a failed trigger (without the row the window reads as never attempted)");
  std::vector<std::pair<std::string, int64_t>> fired;
  ctx.Equal(fireWindow(kStateSchedule, kStateWindow + 60, "a", stateTrigger(fired)), "fired", "the next window, with the job service back");
  ctx.Equal(cronsched::store::Runs(kStateSchedule).size(), 2, "the ledger rows after an error and a fire");
}
`,
  },
  hints: [
    'After a rolling deploy the nightly invoice job runs twice; on some nights it runs twice even with one deploy, and the run history has no row for the night the job service was down.',
    'Between the `GET` and the `SET` the other instance runs the same `GET`; and two instances whose clocks are 5 s apart hold different ticks, so with the tick as the window they claim two different leases.',
    'Compute `window = window_of(tick)`; claim with `SET lease:{id}:{window} owner NX EX LEASE_TTL_S` and fire only if it was set; wrap the trigger and record `error`/`trigger_failed` when it raises.',
  ],
  debrief: `The lease is a single \`SET NX EX\` because "is anyone firing this window, and if not, I am" has to be answered by one command that nothing can interleave with. Keying it by the minute rather than the tick is what makes instances with slightly different clocks agree on what they are racing for. The TTL is sized to outlive the window plus any plausible clock skew and then free Redis, since a lease that never expires is a key per schedule per minute, forever. Recording the error is what keeps the run history honest: a failed window and a window nobody tried look the same without it. Production schedulers also fence the lease with a token checked by the job service, so an instance that paused after claiming cannot fire late.`,
};
