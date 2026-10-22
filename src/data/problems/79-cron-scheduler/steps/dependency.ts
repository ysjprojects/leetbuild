import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Job trigger calls with misfire decisions',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'job'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: when nothing was missed it
calls the job and the job runs, so the demo passes. Its failure path is a storm. Review it like the
owner of the scheduler, fix it, and prove the fix with the checks below.

Implement the fire path that turns **missed windows** into calls against the target job service.

- Triggering goes over gRPC with a **3-second deadline** on every attempt
  (\`DEADLINE_S = 3\` / \`DEADLINE_MS = 3000\` / \`withDeadlineAfter\` / \`set_deadline\`). A call
  with no deadline lets one wedged job hold a scheduler tick open for the rest of the day.
- The **misfire policy decides**, it is not a retry problem. \`decide(policy, windows)\` returns the
  windows to fire now plus a reason:
  - \`skip\` — fire nothing, record the skipped windows with the policy as the reason.
  - \`fire_once_now\` — fire **at most one** window immediately: \`MAX_IMMEDIATE_FIRES = 1\`, and it
    is the most recent missed window, not the oldest.
  - \`catch_up\` — replay the missed windows, rate-limited to \`CATCH_UP_PER_SECOND = 1\` (one fire
    per \`CATCH_UP_INTERVAL_MS = 1000\`).
- **The trigger itself is never retried.** One attempt per window per tick: if the deadline
  expires or the job returns an error, the policy and the next tick decide what happens, not a
  \`while True\`.
- **Every decision is recorded**, including the ones that fire nothing:
  \`record_decision(schedule_id, window, "skipped", reason)\`, \`"fired"\` or \`"error"\` with the
  reason that produced it.

**Failure mode the checks target.** After a ten-minute pause a minutely job has **200** missed
windows. The draft loops over them and retries each one until it succeeds, which is a catch-up
burst fired as fast as the network allows — the target database gets 200 executions in seconds. The
policy is the thing that is supposed to cap that; a retry loop that ignores it turns a scheduler
pause into a self-inflicted DDoS.`,
  sequence: {
    participants: ['Scheduler API', 'schedule store', 'Job service'],
    messages: [
      {from: 'Scheduler API', to: 'Scheduler API', label: 'decide(policy, missed windows)', kind: 'sync'},
      {from: 'Scheduler API', to: 'schedule store', label: 'record skipped windows + reason', kind: 'async'},
      {from: 'Scheduler API', to: 'Job service', label: 'Trigger · deadline 3 s · window W', kind: 'sync'},
      {from: 'Job service', to: 'Scheduler API', label: 'error / ok', kind: 'reply'},
      {from: 'Scheduler API', to: 'Scheduler API', label: 'fire_once_now → at most 1 window', kind: 'sync'},
      {from: 'Scheduler API', to: 'Job service', label: 'catch_up → next window after 1000 ms', kind: 'async'},
      {from: 'Scheduler API', to: 'schedule store', label: 'record fired | error + reason', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every trigger carries a 3-second deadline',
      detail:
        'The trigger call is created with a 3-second deadline — a call timeout, a context with timeout, `withDeadlineAfter`, or `set_deadline`. Without it one wedged job holds a scheduler tick open indefinitely.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*3/, /timeout=DEADLINE_S/, /\.Trigger\(/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*3000/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/, /\.Trigger\(/]},
        go: {all: [/deadlineS\s*=\s*3/, /context\.WithTimeout/, /\.Trigger\(/]},
        scala: {all: [/DeadlineS\s*=\s*3/, /withDeadlineAfter/, /\.trigger\(/]},
        cpp: {all: [/kDeadlineS\s*=\s*3/, /set_deadline\(/, /->Trigger\(/]},
      },
    },
    {
      id: 'policy-decide',
      title: 'The misfire policy decides, with a reason',
      detail:
        'A `decide(policy, windows)` decision maps `skip`, `fire_once_now` and `catch_up` onto the windows to fire now and the reason to record. The draft has no policy at all and treats every missed window as owed.',
      match: {
        python: {all: [/def decide\(/, /"skip"/, /"fire_once_now"/, /"catch_up"/]},
        typescript: {all: [/function decide\(/, /'skip'/, /'fire_once_now'/, /'catch_up'/]},
        go: {all: [/func decide\(/, /"skip"/, /"fire_once_now"/, /"catch_up"/]},
        scala: {all: [/def decide\(/, /"skip"/, /"fire_once_now"/, /"catch_up"/]},
        cpp: {all: [/decide\(/, /"skip"/, /"fire_once_now"/, /"catch_up"/]},
      },
    },
    {
      id: 'burst-collapse',
      title: 'fire_once_now collapses a burst into at most one fire',
      detail:
        '`MAX_IMMEDIATE_FIRES = 1` and the fire-once decision selects only the **latest** missed window, so ten minutes of pause is one execution, not two hundred. The draft fires every missed window as fast as it can.',
      match: {
        python: {all: [/MAX_IMMEDIATE_FIRES\s*=\s*1/, /windows\[-1:\]/]},
        typescript: {all: [/MAX_IMMEDIATE_FIRES\s*=\s*1/, /windows\.slice\(-1\)/]},
        go: {all: [/maxImmediateFires\s*=\s*1/, /windows\[len\(windows\)-maxImmediateFires:\]/]},
        scala: {all: [/MaxImmediateFires\s*=\s*1/, /windows\.takeRight\(MaxImmediateFires\)/]},
        cpp: {all: [/kMaxImmediateFires\s*=\s*1/, /windows\.back\(\)/]},
      },
    },
    {
      id: 'catchup-rate',
      title: 'catch_up is rate limited to one fire per second',
      detail:
        '`CATCH_UP_PER_SECOND = 1` sets `CATCH_UP_INTERVAL_MS = 1000`, and the replay waits between windows (`time.sleep` / `setTimeout` / `time.Sleep` / `Thread.sleep` / `sleep_for`). The draft replays as fast as the loop allows.',
      match: {
        python: {all: [/CATCH_UP_PER_SECOND\s*=\s*1/, /CATCH_UP_INTERVAL_MS\s*=\s*1000/, /time\.sleep\(/]},
        typescript: {all: [/CATCH_UP_PER_SECOND\s*=\s*1/, /CATCH_UP_INTERVAL_MS\s*=\s*1000/, /setTimeout\(/]},
        go: {all: [/catchUpPerSecond\s*=\s*1/, /catchUpIntervalMS\s*=\s*1000/, /time\.Sleep\(/]},
        scala: {all: [/CatchUpPerSecond\s*=\s*1/, /CatchUpIntervalMS\s*=\s*1000/, /Thread\.sleep\(/]},
        cpp: {all: [/kCatchUpPerSecond\s*=\s*1/, /kCatchUpIntervalMS\s*=\s*1000/, /sleep_for\(/]},
      },
    },
    {
      id: 'record-decision',
      title: 'Records every misfire decision, skips included',
      detail:
        'Each outcome is written with its reason: `record_decision(schedule_id, window, "skipped", reason)` when the policy fires nothing, and `fired` or `error` otherwise. The draft records nothing, so a paused schedule leaves no trace.',
      match: {
        python: {all: [/record_decision\(/, /"skipped"/, /reason/]},
        typescript: {all: [/recordDecision\(/, /'skipped'/, /reason/]},
        go: {all: [/RecordDecision\(/, /"skipped"/, /Reason/]},
        scala: {all: [/recordDecision\(/, /"skipped"/, /reason/]},
        cpp: {all: [/recordDecision\(/, /"skipped"/, /reason/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import jobs_pb2
import jobs_pb2_grpc

stub = jobs_pb2_grpc.JobServiceStub(grpc.insecure_channel("jobs:9000"))


def run_misfire(schedule: dict, windows: list[int], owner: str) -> list[int]:
    # TODO: this draft treats every missed window as owed and retries the trigger itself until it
    # succeeds, so a scheduler pause becomes a catch-up burst; it has no misfire policy, no
    # deadline and no decision record. Review all three.
    fired = []
    for window in windows:
        while True:
            try:
                stub.Trigger(
                    jobs_pb2.TriggerRequest(job_ref=schedule["job_ref"], window=window)
                )
                fired.append(window)
                break
            except grpc.RpcError:
                continue
    return fired
`,
      solution: `import logging
import time

import grpc

import jobs_pb2
import jobs_pb2_grpc

logger = logging.getLogger("scheduler")

DEADLINE_S = 3
MAX_IMMEDIATE_FIRES = 1
CATCH_UP_PER_SECOND = 1
CATCH_UP_INTERVAL_MS = 1000 // CATCH_UP_PER_SECOND

stub = jobs_pb2_grpc.JobServiceStub(grpc.insecure_channel("jobs:9000"))


class Decision:
    def __init__(self, windows: list[int], reason: str) -> None:
        self.windows = windows
        self.reason = reason


def decide(policy: str, windows: list[int]) -> Decision:
    """What a pause owes the target job: the windows to fire now, and why."""
    if not windows:
        return Decision([], "up-to-date")
    if policy == "skip":
        return Decision([], "skip")
    if policy == "fire_once_now":
        return Decision(windows[-1:], "fire_once_now")
    if policy == "catch_up":
        return Decision(windows, "catch_up")
    return Decision([], "unknown-policy")


def trigger(job_ref: str, window: int) -> None:
    """Every attempt carries the deadline; one wedged job cannot pin a scheduler tick."""
    stub.Trigger(
        jobs_pb2.TriggerRequest(job_ref=job_ref, window=window),
        timeout=DEADLINE_S,
    )


def record_decision(schedule_id: str, window: int, decision: str, reason: str) -> None:
    """Record every decision, skips included, so a pause is explainable from the history."""
    logger.info(
        "misfire schedule=%s window=%d decision=%s reason=%s",
        schedule_id,
        window,
        decision,
        reason,
    )
    events.publish(schedule_id, window, decision, reason)


def run_misfire(schedule: dict, windows: list[int], owner: str) -> list[int]:
    decision = decide(schedule["misfire_policy"], windows)
    if not decision.windows:
        for window in windows:
            record_decision(schedule["id"], window, "skipped", decision.reason)
        return []
    fired: list[int] = []
    for index, window in enumerate(decision.windows):
        if index > 0:
            time.sleep(CATCH_UP_INTERVAL_MS / 1000)
        try:
            trigger(schedule["job_ref"], window)
        except grpc.RpcError:
            record_decision(schedule["id"], window, "error", "trigger failed")
            break
        fired.append(window)
        record_decision(schedule["id"], window, "fired", decision.reason)
    return fired
`,
    },
    typescript: {
      starter: `/** A model-generated draft that treats every missed window as owed. */
export async function runMisfire(schedule: Schedule, windows: number[]): Promise<number[]> {
  // TODO: this draft treats every missed window as owed and retries the trigger itself until it
  // succeeds, so a scheduler pause becomes a catch-up burst; it has no misfire policy, no deadline
  // and no decision record. Review all three.
  const fired: number[] = [];
  for (const window of windows) {
    for (;;) {
      try {
        await stub.Trigger({job_ref: schedule.job_ref, window});
        fired.push(window);
        break;
      } catch {
        continue;
      }
    }
  }
  return fired;
}
`,
      solution: `/** Misfire policy over gRPC: a deadline per attempt, no burst, every decision recorded. */
const DEADLINE_MS = 3000;
const MAX_IMMEDIATE_FIRES = 1;
const CATCH_UP_PER_SECOND = 1;
const CATCH_UP_INTERVAL_MS = 1000 / CATCH_UP_PER_SECOND;

interface Decision {
  windows: number[];
  reason: string;
}

/** What a pause owes the target job: the windows to fire now, and why. */
function decide(policy: string, windows: number[]): Decision {
  if (windows.length === 0) return {windows: [], reason: 'up-to-date'};
  if (policy === 'skip') return {windows: [], reason: 'skip'};
  if (policy === 'fire_once_now') return {windows: windows.slice(-1), reason: 'fire_once_now'};
  if (policy === 'catch_up') return {windows, reason: 'catch_up'};
  return {windows: [], reason: 'unknown-policy'};
}

/** Every attempt carries the deadline; one wedged job cannot pin a scheduler tick. */
async function trigger(jobRef: string, window: number): Promise<void> {
  await stub.Trigger({job_ref: jobRef, window}, {deadline: Date.now() + DEADLINE_MS});
}

function recordDecision(scheduleId: string, window: number, decision: string, reason: string): void {
  events.publish(scheduleId, window, decision, reason);
}

/** The gap between catch-up fires: CATCH_UP_PER_SECOND fixes the rate. */
function sleep(ms: number): Promise<void> {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

export async function runMisfire(schedule: Schedule, windows: number[]): Promise<number[]> {
  const decision = decide(schedule.misfire_policy, windows);
  if (decision.windows.length === 0) {
    for (const window of windows) recordDecision(schedule.id, window, 'skipped', decision.reason);
    return [];
  }
  const fired: number[] = [];
  for (const [index, window] of decision.windows.entries()) {
    if (index > 0) await sleep(CATCH_UP_INTERVAL_MS);
    try {
      await trigger(schedule.job_ref, window);
    } catch {
      recordDecision(schedule.id, window, 'error', 'trigger failed');
      break;
    }
    fired.push(window);
    recordDecision(schedule.id, window, 'fired', decision.reason);
  }
  return fired;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
)

func RunMisfire(schedule Schedule, windows []int64) []int64 {
	// TODO: this draft treats every missed window as owed and retries the trigger itself until it
	// succeeds, so a scheduler pause becomes a catch-up burst; it has no misfire policy, no
	// deadline and no decision record. Review all three.
	fired := make([]int64, 0, len(windows))
	for _, window := range windows {
		for {
			if _, err := stub.Trigger(ctx, &jobs.TriggerRequest{JobRef: schedule.JobRef, Window: window}); err != nil {
				continue
			}
			fired = append(fired, window)
			break
		}
	}
	return fired
}
`,
      solution: `package main

import (
	"context"
	"time"
)

const (
	deadlineS         = 3
	maxImmediateFires = 1
	catchUpPerSecond  = 1
	catchUpIntervalMS = 1000 / catchUpPerSecond
)

type Decision struct {
	Windows []int64
	Reason  string
}

// decide is what a pause owes the target job: the windows to fire now, and why.
func decide(policy string, windows []int64) Decision {
	if len(windows) == 0 {
		return Decision{Reason: "up-to-date"}
	}
	switch policy {
	case "skip":
		return Decision{Reason: "skip"}
	case "fire_once_now":
		return Decision{Windows: windows[len(windows)-maxImmediateFires:], Reason: "fire_once_now"}
	case "catch_up":
		return Decision{Windows: windows, Reason: "catch_up"}
	}
	return Decision{Reason: "unknown-policy"}
}

// trigger carries the deadline: one wedged job cannot pin a scheduler tick.
func trigger(jobRef string, window int64) error {
	ctx, cancel := context.WithTimeout(ctx, deadlineS*time.Second)
	defer cancel()
	_, err := stub.Trigger(ctx, &jobs.TriggerRequest{JobRef: jobRef, Window: window})
	return err
}

// RecordDecision records every decision, skips included, so a pause is explainable.
func RecordDecision(scheduleID string, window int64, decision, reason string) {
	events.Publish(scheduleID, window, decision, reason)
}

func RunMisfire(schedule Schedule, windows []int64) []int64 {
	decision := decide(schedule.MisfirePolicy, windows)
	if len(decision.Windows) == 0 {
		for _, window := range windows {
			RecordDecision(schedule.ID, window, "skipped", decision.Reason)
		}
		return nil
	}
	fired := make([]int64, 0, len(decision.Windows))
	for i, window := range decision.Windows {
		if i > 0 {
			time.Sleep(time.Duration(catchUpIntervalMS) * time.Millisecond)
		}
		if err := trigger(schedule.JobRef, window); err != nil {
			RecordDecision(schedule.ID, window, "error", "trigger failed")
			break
		}
		fired = append(fired, window)
		RecordDecision(schedule.ID, window, "fired", decision.Reason)
	}
	return fired
}
`,
    },
    scala: {
      starter: `import scala.collection.mutable.ListBuffer

object Misfire {
  def runMisfire(schedule: Schedule, windows: List[Long]): List[Long] = {
    // TODO: this draft treats every missed window as owed and retries the trigger itself until it
    // succeeds, so a scheduler pause becomes a catch-up burst; it has no misfire policy, no
    // deadline and no decision record. Review all three.
    val fired = ListBuffer.empty[Long]
    for (window <- windows) {
      var done = false
      while (!done) {
        try {
          stub.trigger(TriggerRequest(jobRef = schedule.jobRef, window = window))
          fired += window
          done = true
        } catch {
          case _: RuntimeException => ()
        }
      }
    }
    fired.toList
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import scala.collection.mutable.ListBuffer

import io.grpc.StatusRuntimeException

object Misfire {
  val DeadlineS = 3
  val MaxImmediateFires = 1
  val CatchUpPerSecond = 1
  val CatchUpIntervalMS = 1000 / CatchUpPerSecond

  final case class Decision(windows: List[Long], reason: String)

  /** What a pause owes the target job: the windows to fire now, and why. */
  def decide(policy: String, windows: List[Long]): Decision =
    if (windows.isEmpty) Decision(Nil, "up-to-date")
    else
      policy match {
        case "skip" => Decision(Nil, "skip")
        case "fire_once_now" => Decision(windows.takeRight(MaxImmediateFires), "fire_once_now")
        case "catch_up" => Decision(windows, "catch_up")
        case _ => Decision(Nil, "unknown-policy")
      }

  /** Every attempt carries the deadline; one wedged job cannot pin a scheduler tick. */
  def trigger(jobRef: String, window: Long): Unit = {
    val stub = JobServiceGrpc.newBlockingStub(channel).withDeadlineAfter(DeadlineS, TimeUnit.SECONDS)
    stub.trigger(TriggerRequest(jobRef = jobRef, window = window))
  }

  def recordDecision(scheduleId: String, window: Long, decision: String, reason: String): Unit = {
    events.publish(scheduleId, window, decision, reason)
  }

  def runMisfire(schedule: Schedule, windows: List[Long]): List[Long] = {
    val decision = decide(schedule.misfirePolicy, windows)
    if (decision.windows.isEmpty) {
      windows.foreach(window => recordDecision(schedule.id, window, "skipped", decision.reason))
      return Nil
    }
    val fired = ListBuffer.empty[Long]
    for ((window, index) <- decision.windows.zipWithIndex) {
      if (index > 0) Thread.sleep(CatchUpIntervalMS)
      try {
        trigger(schedule.jobRef, window)
      } catch {
        case _: StatusRuntimeException =>
          recordDecision(schedule.id, window, "error", "trigger failed")
          return fired.toList
      }
      fired += window
      recordDecision(schedule.id, window, "fired", decision.reason)
    }
    fired.toList
  }
}
`,
    },
    cpp: {
      starter: `#include <string>
#include <vector>

std::vector<long> runMisfire(const Schedule& schedule, const std::vector<long>& windows) {
  // TODO: this draft treats every missed window as owed and retries the trigger itself until it
  // succeeds, so a scheduler pause becomes a catch-up burst; it has no misfire policy, no deadline
  // and no decision record. Review all three.
  std::vector<long> fired;
  for (const long window : windows) {
    for (;;) {
      grpc::ClientContext context;
      TriggerRequest request;
      request.set_job_ref(schedule.job_ref);
      request.set_window(window);
      TriggerReply reply;
      if (!stub->Trigger(&context, request, &reply).ok()) continue;
      fired.push_back(window);
      break;
    }
  }
  return fired;
}
`,
      solution: `#include <chrono>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

constexpr int kDeadlineS = 3;
constexpr int kMaxImmediateFires = 1;
constexpr int kCatchUpPerSecond = 1;
constexpr int kCatchUpIntervalMS = 1000 / kCatchUpPerSecond;

struct Decision {
  std::vector<long> windows;
  std::string reason;
};

/** What a pause owes the target job: the windows to fire now, and why. */
Decision decide(const std::string& policy, const std::vector<long>& windows) {
  if (windows.empty()) return {{}, "up-to-date"};
  if (policy == "skip") return {{}, "skip"};
  if (policy == "fire_once_now") return {{windows.back()}, "fire_once_now"};
  if (policy == "catch_up") return {windows, "catch_up"};
  return {{}, "unknown-policy"};
}

/** Every attempt carries the deadline; one wedged job cannot pin a scheduler tick. */
void trigger(const std::string& jobRef, long window) {
  grpc::ClientContext context;
  context.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(kDeadlineS));
  TriggerRequest request;
  request.set_job_ref(jobRef);
  request.set_window(window);
  TriggerReply reply;
  const auto status = stub->Trigger(&context, request, &reply);
  if (!status.ok()) throw std::runtime_error(status.error_message());
}

void recordDecision(const std::string& scheduleId, long window, const std::string& decision,
                    const std::string& reason) {
  events.publish(scheduleId, window, decision, reason);
}

std::vector<long> runMisfire(const Schedule& schedule, const std::vector<long>& windows) {
  const auto decision = decide(schedule.misfire_policy, windows);
  if (decision.windows.empty()) {
    for (const long window : windows) recordDecision(schedule.id, window, "skipped", decision.reason);
    return {};
  }
  std::vector<long> fired;
  for (std::size_t index = 0; index < decision.windows.size(); ++index) {
    if (index > 0) std::this_thread::sleep_for(std::chrono::milliseconds(kCatchUpIntervalMS));
    try {
      trigger(schedule.job_ref, decision.windows[index]);
    } catch (const std::exception&) {
      recordDecision(schedule.id, decision.windows[index], "error", "trigger failed");
      break;
    }
    fired.push_back(decision.windows[index]);
    recordDecision(schedule.id, decision.windows[index], "fired", decision.reason);
  }
  return fired;
}
`,
    },
  },
  hints: [
    'Put the deadline on the call itself — `timeout=`, `deadline:`, `context.WithTimeout`, `withDeadlineAfter`, `set_deadline` — and keep it in one constant (`DEADLINE_S = 3`). Then delete the retry loop: one attempt per window per tick is the whole contract, and the policy, not the loop, decides what happens to windows that did not fire.',
    'The decision is data: `decide(policy, windows)` returns the windows to fire now plus a reason. For `fire_once_now` that is exactly the latest window (`windows[-1:]`), which is what turns ten minutes of pause into one execution instead of two hundred.',
    'Catch-up is a rate, not a loop: `CATCH_UP_PER_SECOND = 1` gives `CATCH_UP_INTERVAL_MS = 1000`, and every catch-up window after the first waits that long. Record the decision either way — a skip with a reason is the only way on-call can tell a deliberate ignore from a lost run.',
  ],
  debrief: `The interviewer is testing whether the failure path is a policy or a retry loop. The draft passes because the demo never pauses the scheduler. Four defects are checked: a trigger with no deadline, no policy at all, a fire-once decision that does not collapse the burst, and a catch-up replay with no rate limit. The burst is the one that takes down a database: after a ten-minute pause a minutely job owes 200 executions and the draft delivers them as fast as the network allows. Real schedulers also persist a cursor per schedule so catch-up resumes after a crash, cap the catch-up window by wall-clock age rather than count, and skip anything older than the retention the target can tolerate.`,
};
