import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Job triggers after a pause, as the misfire policy says',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'job', 'redis'],
  task: `## Task

**Starting point.** The starter is \`run_missed(schedule, windows, owner)\`, which the scheduler calls
after a pause with the windows it missed: it fires every one of them, oldest first, through
\`fire_window\` from the state step, and \`trigger_job(schedule, window)\` sends \`JobRunner.Trigger\` to
\`jobs:9000\`, calling again until a call succeeds. It serves the demo and hides 5 flaws.

**Failure mode the checks target.** A job service that hangs, one that is restarting, and a scheduler
that comes back from a pause to a pile of missed windows.

\`\`\`proto
service JobRunner {
  rpc Trigger(TriggerRequest) returns (TriggerReply);  // schedule_id, job_ref, window (ISO-8601)
}
\`\`\`

- Every Trigger carries a **3 s** deadline (\`DEADLINE_S = 3\`), and a window gets **one** attempt: the
  job service runs every Trigger it receives, so a failed call is recorded by \`fire_window\` as
  \`error\` and the next pass decides.
- The schedule's \`misfire_policy\` decides what the missed windows get:
  - \`skip\`: no fire; each window \`record_run(…, "skipped", "policy_skip")\`.
  - \`fire_once_now\`: only the newest window fires; the older ones are \`skipped\` with \`coalesced\`.
  - \`catch_up\`: the oldest \`MAX_CATCH_UP = 5\` fire; the rest get no row and stay owed.
- Return each window's outcome.`,
  sequence: {
    participants: ['Scheduler', 'Redis', 'Job service'],
    messages: [
      {from: 'Scheduler', to: 'Scheduler', label: 'misfire_policy → windows to fire, windows to skip', kind: 'sync'},
      {from: 'Scheduler', to: 'Redis', label: 'HSET runs:{id} {window} skipped:policy_skip | coalesced', kind: 'async'},
      {from: 'Scheduler', to: 'Redis', label: 'fire_window: SET lease NX EX 300', kind: 'sync'},
      {
        from: 'Scheduler',
        to: 'Job service',
        label: 'Trigger(schedule_id, job_ref, window) · 3 s deadline',
        kind: 'sync',
      },
      {from: 'Job service', to: 'Scheduler', label: 'run_id / DEADLINE_EXCEEDED / UNAVAILABLE', kind: 'reply'},
      {from: 'Scheduler', to: 'Redis', label: 'HSET runs:{id} {window} fired | error:trigger_failed', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Bounds every Trigger with a 3 s deadline',
      detail:
        'A job service that answers in 2 s fires the window; one that takes 10 s ends it as `error` after about 3 s. The starter waits as long as the job service does.',
      match: {
        python: {all: [/stub\.Trigger\([^\n]*timeout\s*=\s*(DEADLINE_S|3(\.0)?)\b/]},
        typescript: {all: [/\.Trigger\([\s\S]{0,200}?deadline:\s*Date\.now\(\)\s*\+\s*(DEADLINE_MS|3000)\b/]},
        go: {
          all: [/context\.WithTimeout\([^\n]*(triggerDeadline|3\s*\*\s*time\.Second|3000\s*\*\s*time\.Millisecond)/],
        },
        scala: {all: [/withDeadlineAfter\(\s*(DeadlineMs|3000L?|3L?\s*,\s*TimeUnit\.SECONDS)/]},
        cpp: {
          all: [
            /set_deadline\([^\n]*(kTriggerDeadline|std::chrono::seconds[({]\s*3\s*[)}]|std::chrono::milliseconds[({]\s*3000\s*[)}])/,
          ],
        },
      },
    },
    {
      id: 'single-attempt',
      title: 'Sends one Trigger per window and records the failure',
      detail:
        'Against a job service that answers UNAVAILABLE, one window gets exactly one Trigger and its ledger row is `error:trigger_failed`. The starter calls again until a call succeeds.',
      match: {
        python: {all: [/stub\.Trigger\(/], none: [/while\s+True/]},
        typescript: {all: [/\.Trigger\(/], none: [/while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\)/]},
        go: {all: [/stub\.Trigger\(/], none: [/for\s*\{/]},
        scala: {all: [/\.trigger\(/], none: [/while\s*\(\s*true\s*\)/]},
        cpp: {all: [/->Trigger\(/], none: [/while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\)/]},
      },
    },
    {
      id: 'policy-skip',
      title: 'skip fires nothing and records every window',
      detail:
        'Four missed windows of a `skip` schedule send no Trigger and leave four `skipped:policy_skip` rows. The starter fires them all.',
      match: {
        python: {all: [/["']policy_skip["']/]},
        typescript: {all: [/['"]policy_skip['"]/]},
        go: {all: [/"policy_skip"/]},
        scala: {all: [/"policy_skip"/]},
        cpp: {all: [/"policy_skip"/]},
      },
    },
    {
      id: 'fire-once',
      title: 'fire_once_now fires the newest window only',
      detail:
        'Four missed windows of a `fire_once_now` schedule send one Trigger, for the newest window, and record the other three as `skipped:coalesced`. The starter fires all four.',
      match: {
        python: {all: [/["']fire_once_now["']/, /["']coalesced["']/]},
        typescript: {all: [/['"]fire_once_now['"]/, /['"]coalesced['"]/]},
        go: {all: [/"fire_once_now"/, /"coalesced"/]},
        scala: {all: [/"fire_once_now"/, /"coalesced"/]},
        cpp: {all: [/"fire_once_now"/, /"coalesced"/]},
      },
    },
    {
      id: 'catch-up-cap',
      title: 'catch_up replays at most five windows per pass',
      detail:
        'Eight missed windows of a `catch_up` schedule fire the five oldest, in order; the three newest get no row. The starter fires all eight.',
      match: {
        python: {all: [/MAX_CATCH_UP/]},
        typescript: {all: [/MAX_CATCH_UP/]},
        go: {all: [/maxCatchUp/]},
        scala: {all: [/MaxCatchUp/]},
        cpp: {all: [/kMaxCatchUp/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import cron_scheduler_pb2
import cron_scheduler_pb2_grpc
from cronsched.cron import format_instant
from state import fire_window  # step 2: one fire per window across the fleet

channel = grpc.insecure_channel("jobs:9000")
stub = cron_scheduler_pb2_grpc.JobRunnerStub(channel)


def trigger_job(schedule: dict, window: int) -> None:
    """Run the schedule's job for one window; raises grpc.RpcError when it fails."""
    request = cron_scheduler_pb2.TriggerRequest(schedule_id=schedule["id"], job_ref=schedule["job_ref"], window=format_instant(window))
    while True:
        try:
            stub.Trigger(request)
            return
        except grpc.RpcError:
            continue


def run_missed(schedule: dict, windows: list[int], owner: str) -> dict[int, str]:
    """Settle the windows a pause missed; returns each window's outcome."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    outcomes = {}
    for window in sorted(windows):
        outcomes[window] = fire_window(schedule["id"], window, owner, lambda _id, w: trigger_job(schedule, w))
    return outcomes
`,
      solution: `import grpc

import cron_scheduler_pb2
import cron_scheduler_pb2_grpc
from cronsched.cron import format_instant
from cronsched.store import store
from state import fire_window  # step 2: one fire per window across the fleet

DEADLINE_S = 3
MAX_CATCH_UP = 5

channel = grpc.insecure_channel("jobs:9000")
stub = cron_scheduler_pb2_grpc.JobRunnerStub(channel)


def trigger_job(schedule: dict, window: int) -> None:
    """Run the schedule's job for one window; raises grpc.RpcError when it fails."""
    request = cron_scheduler_pb2.TriggerRequest(schedule_id=schedule["id"], job_ref=schedule["job_ref"], window=format_instant(window))
    # One attempt: the job service runs every Trigger it gets, so a retry after a timeout can run the
    # job twice. fire_window records the failure and the next pass decides.
    stub.Trigger(request, timeout=DEADLINE_S)


def run_missed(schedule: dict, windows: list[int], owner: str) -> dict[int, str]:
    """Settle the windows a pause missed, as the schedule's misfire policy says; returns each window's outcome."""
    missed = sorted(windows)
    policy = schedule["misfire_policy"]
    if policy == "skip":
        fire, skipped, reason = [], missed, "policy_skip"
    elif policy == "fire_once_now":
        fire, skipped, reason = missed[-1:], missed[:-1], "coalesced"
    else:  # catch_up: the oldest first, a bounded number per pass; the rest stay owed
        fire, skipped, reason = missed[:MAX_CATCH_UP], [], ""
    outcomes = {}
    for window in skipped:
        store.record_run(schedule["id"], window, "skipped", reason)
        outcomes[window] = "skipped"
    for window in fire:
        outcomes[window] = fire_window(schedule["id"], window, owner, lambda _id, w: trigger_job(schedule, w))
    return outcomes
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {formatInstant} from 'cronsched/cron';
import {type Schedule} from 'cronsched/store';
import {fireWindow} from './state'; // step 2: one fire per window across the fleet

interface TriggerRequest {
  schedule_id: string;
  job_ref: string;
  window: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('cron_scheduler.proto')) as unknown as {
  cronjobs: {JobRunner: grpc.ServiceClientConstructor};
};
const stub = new pkg.cronjobs.JobRunner('jobs:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Trigger(request: TriggerRequest, options: grpc.CallOptions): Promise<{run_id: string}>;
};

/** Run the schedule's job for one window; rejects when it fails. */
export async function triggerJob(schedule: Schedule, window: number): Promise<void> {
  const request = {schedule_id: schedule.id, job_ref: schedule.job_ref, window: formatInstant(window)};
  while (true) {
    try {
      await stub.Trigger(request, {});
      return;
    } catch {
      continue;
    }
  }
}

/** Settle the windows a pause missed; resolves to each window's outcome. */
export async function runMissed(schedule: Schedule, windows: number[], owner: string): Promise<Map<number, string>> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const outcomes = new Map<number, string>();
  for (const window of [...windows].sort((a, b) => a - b)) {
    outcomes.set(window, await fireWindow(schedule.id, window, owner, (_id, w) => triggerJob(schedule, w)));
  }
  return outcomes;
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {formatInstant} from 'cronsched/cron';
import {type Schedule, store} from 'cronsched/store';
import {fireWindow} from './state'; // step 2: one fire per window across the fleet

export const DEADLINE_MS = 3000;
export const MAX_CATCH_UP = 5;

interface TriggerRequest {
  schedule_id: string;
  job_ref: string;
  window: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('cron_scheduler.proto')) as unknown as {
  cronjobs: {JobRunner: grpc.ServiceClientConstructor};
};
const stub = new pkg.cronjobs.JobRunner('jobs:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Trigger(request: TriggerRequest, options: grpc.CallOptions): Promise<{run_id: string}>;
};

/** Run the schedule's job for one window; rejects when it fails. */
export async function triggerJob(schedule: Schedule, window: number): Promise<void> {
  const request = {schedule_id: schedule.id, job_ref: schedule.job_ref, window: formatInstant(window)};
  // One attempt: the job service runs every Trigger it gets, so a retry after a timeout can run the
  // job twice. fireWindow records the failure and the next pass decides.
  await stub.Trigger(request, {deadline: Date.now() + DEADLINE_MS});
}

/** Settle the windows a pause missed, as the schedule's misfire policy says; resolves to each window's outcome. */
export async function runMissed(schedule: Schedule, windows: number[], owner: string): Promise<Map<number, string>> {
  const missed = [...windows].sort((a, b) => a - b);
  let fire: number[] = [];
  let skipped: number[] = [];
  let reason = '';
  if (schedule.misfire_policy === 'skip') {
    [skipped, reason] = [missed, 'policy_skip'];
  } else if (schedule.misfire_policy === 'fire_once_now') {
    [fire, skipped, reason] = [missed.slice(-1), missed.slice(0, -1), 'coalesced'];
  } else {
    // catch_up: the oldest first, a bounded number per pass; the rest stay owed.
    fire = missed.slice(0, MAX_CATCH_UP);
  }
  const outcomes = new Map<number, string>();
  for (const window of skipped) {
    await store.recordRun(schedule.id, window, 'skipped', reason);
    outcomes.set(window, 'skipped');
  }
  for (const window of fire) {
    outcomes.set(window, await fireWindow(schedule.id, window, owner, (_id, w) => triggerJob(schedule, w)));
  }
  return outcomes;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"sort"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"cronsched/cron"
	pb "cronsched/gen/cron_scheduler"
	"cronsched/store"
)

// Built in step 2 (state.go): one fire per window across the fleet.
var fireWindow = func(ctx context.Context, scheduleID string, tick int64, owner string, trigger func(scheduleID string, window int64) error) (string, error) {
	panic("not implemented")
}

var conn, _ = grpc.NewClient("jobs:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewJobRunnerClient(conn)

// triggerJob runs the schedule's job for one window; an error when it fails.
func triggerJob(ctx context.Context, s *store.Schedule, window int64) error {
	req := &pb.TriggerRequest{ScheduleId: s.ID, JobRef: s.JobRef, Window: cron.FormatInstant(window)}
	for {
		if _, err := stub.Trigger(ctx, req); err == nil {
			return nil
		}
	}
}

// runMissed settles the windows a pause missed and returns each window's outcome.
func runMissed(ctx context.Context, s *store.Schedule, windows []int64, owner string) (map[int64]string, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	missed := append([]int64(nil), windows...)
	sort.Slice(missed, func(i, j int) bool { return missed[i] < missed[j] })
	outcomes := map[int64]string{}
	for _, w := range missed {
		outcome, err := fireWindow(ctx, s.ID, w, owner, func(_ string, window int64) error { return triggerJob(ctx, s, window) })
		if err != nil {
			return nil, err
		}
		outcomes[w] = outcome
	}
	return outcomes, nil
}
`,
      solution: `package main

import (
	"context"
	"sort"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"cronsched/cron"
	pb "cronsched/gen/cron_scheduler"
	"cronsched/store"
)

const (
	triggerDeadline = 3 * time.Second
	maxCatchUp      = 5
)

// Built in step 2 (state.go): one fire per window across the fleet.
var fireWindow = func(ctx context.Context, scheduleID string, tick int64, owner string, trigger func(scheduleID string, window int64) error) (string, error) {
	panic("not implemented")
}

var conn, _ = grpc.NewClient("jobs:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewJobRunnerClient(conn)

// triggerJob runs the schedule's job for one window; an error when it fails. One attempt: the job
// service runs every Trigger it gets, so a retry after a timeout can run the job twice. fireWindow
// records the failure and the next pass decides.
func triggerJob(ctx context.Context, s *store.Schedule, window int64) error {
	ctx, cancel := context.WithTimeout(ctx, triggerDeadline)
	defer cancel()
	_, err := stub.Trigger(ctx, &pb.TriggerRequest{ScheduleId: s.ID, JobRef: s.JobRef, Window: cron.FormatInstant(window)})
	return err
}

// runMissed settles the windows a pause missed, as the schedule's misfire policy says, and returns
// each window's outcome.
func runMissed(ctx context.Context, s *store.Schedule, windows []int64, owner string) (map[int64]string, error) {
	missed := append([]int64(nil), windows...)
	sort.Slice(missed, func(i, j int) bool { return missed[i] < missed[j] })
	var fire, skipped []int64
	reason := ""
	switch s.MisfirePolicy {
	case "skip":
		skipped, reason = missed, "policy_skip"
	case "fire_once_now":
		if len(missed) > 0 {
			fire, skipped, reason = missed[len(missed)-1:], missed[:len(missed)-1], "coalesced"
		}
	default: // catch_up: the oldest first, a bounded number per pass; the rest stay owed
		fire = missed[:min(len(missed), maxCatchUp)]
	}
	outcomes := map[int64]string{}
	for _, w := range skipped {
		if err := store.RecordRun(ctx, s.ID, w, "skipped", reason); err != nil {
			return nil, err
		}
		outcomes[w] = "skipped"
	}
	for _, w := range fire {
		outcome, err := fireWindow(ctx, s.ID, w, owner, func(_ string, window int64) error { return triggerJob(ctx, s, window) })
		if err != nil {
			return nil, err
		}
		outcomes[w] = outcome
	}
	return outcomes, nil
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import cronjobs.cron_scheduler.{JobRunnerGrpc, TriggerRequest}
import cronsched.{Cron, Schedule}

object JobTrigger {
  private val stub = JobRunnerGrpc.blockingStub(ManagedChannelBuilder.forAddress("jobs", 9000).usePlaintext().build())

  /** Run the schedule's job for one window; throws when it fails. */
  def triggerJob(schedule: Schedule, window: Long): Unit = {
    val request = TriggerRequest(scheduleId = schedule.id, jobRef = schedule.job_ref, window = Cron.formatInstant(window))
    while (true) {
      try {
        stub.trigger(request)
        return
      } catch {
        case _: StatusRuntimeException => ()
      }
    }
  }

  /** Settle the windows a pause missed; returns each window's outcome. */
  def runMissed(schedule: Schedule, windows: Seq[Long], owner: String): Map[Long, String] = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    windows.sorted.map(w => w -> Leases.fireWindow(schedule.id, w, owner, (_, window) => triggerJob(schedule, window))).toMap // step 2
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.ManagedChannelBuilder

import cronjobs.cron_scheduler.{JobRunnerGrpc, TriggerRequest}
import cronsched.{Cron, Schedule, Store}

object JobTrigger {
  val DeadlineMs = 3000L
  val MaxCatchUp = 5

  private val stub = JobRunnerGrpc.blockingStub(ManagedChannelBuilder.forAddress("jobs", 9000).usePlaintext().build())

  /**
   * Run the schedule's job for one window; throws when it fails. One attempt: the job service runs
   * every Trigger it gets, so a retry after a timeout can run the job twice. fireWindow records the
   * failure and the next pass decides.
   */
  def triggerJob(schedule: Schedule, window: Long): Unit = {
    val request = TriggerRequest(scheduleId = schedule.id, jobRef = schedule.job_ref, window = Cron.formatInstant(window))
    stub.withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS).trigger(request)
    ()
  }

  /** Settle the windows a pause missed, as the schedule's misfire policy says; returns each window's outcome. */
  def runMissed(schedule: Schedule, windows: Seq[Long], owner: String): Map[Long, String] = {
    val missed = windows.sorted
    val (fire, skipped, reason) = schedule.misfire_policy match {
      case "skip" => (Seq.empty[Long], missed, "policy_skip")
      case "fire_once_now" => (missed.takeRight(1), missed.dropRight(1), "coalesced")
      case _ => (missed.take(MaxCatchUp), Seq.empty[Long], "") // catch_up: the oldest first; the rest stay owed
    }
    val skippedOutcomes = skipped.map { w =>
      Store.recordRun(schedule.id, w, "skipped", reason)
      w -> "skipped"
    }
    val fired = fire.map(w => w -> Leases.fireWindow(schedule.id, w, owner, (_, window) => triggerJob(schedule, window))) // step 2
    (skippedOutcomes ++ fired).toMap
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <algorithm>
#include <cstdint>
#include <functional>
#include <map>
#include <string>
#include <vector>

#include "cron_scheduler.grpc.pb.h"
#include "cronsched/cron.h"
#include "cronsched/store.h"

// Built in step 2 (state.cpp): one fire per window across the fleet.
std::string fireWindow(const std::string& schedule_id, int64_t tick, const std::string& owner,
                       const std::function<bool(const std::string&, int64_t)>& trigger);

auto channel = grpc::CreateChannel("jobs:9000", grpc::InsecureChannelCredentials());
auto stub = cronjobs::JobRunner::NewStub(channel);

// Run the schedule's job for one window; false when it fails.
bool triggerJob(const cronsched::Schedule& s, int64_t window) {
  cronjobs::TriggerRequest request;
  request.set_schedule_id(s.id);
  request.set_job_ref(s.job_ref);
  request.set_window(cronsched::cron::FormatInstant(window));
  while (true) {
    grpc::ClientContext ctx;
    cronjobs::TriggerReply reply;
    if (stub->Trigger(&ctx, request, &reply).ok()) return true;
  }
}

// Settle the windows a pause missed; returns each window's outcome.
std::map<int64_t, std::string> runMissed(const cronsched::Schedule& s, std::vector<int64_t> windows, const std::string& owner) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  std::sort(windows.begin(), windows.end());
  std::map<int64_t, std::string> outcomes;
  for (const int64_t w : windows) {
    outcomes[w] = fireWindow(s.id, w, owner, [&s](const std::string&, int64_t window) { return triggerJob(s, window); });
  }
  return outcomes;
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <functional>
#include <map>
#include <string>
#include <vector>

#include "cron_scheduler.grpc.pb.h"
#include "cronsched/cron.h"
#include "cronsched/store.h"

constexpr std::chrono::seconds kTriggerDeadline{3};
constexpr size_t kMaxCatchUp = 5;

// Built in step 2 (state.cpp): one fire per window across the fleet.
std::string fireWindow(const std::string& schedule_id, int64_t tick, const std::string& owner,
                       const std::function<bool(const std::string&, int64_t)>& trigger);

auto channel = grpc::CreateChannel("jobs:9000", grpc::InsecureChannelCredentials());
auto stub = cronjobs::JobRunner::NewStub(channel);

// Run the schedule's job for one window; false when it fails. One attempt: the job service runs every
// Trigger it gets, so a retry after a timeout can run the job twice. fireWindow records the failure
// and the next pass decides.
bool triggerJob(const cronsched::Schedule& s, int64_t window) {
  cronjobs::TriggerRequest request;
  request.set_schedule_id(s.id);
  request.set_job_ref(s.job_ref);
  request.set_window(cronsched::cron::FormatInstant(window));
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kTriggerDeadline);
  cronjobs::TriggerReply reply;
  return stub->Trigger(&ctx, request, &reply).ok();
}

// Settle the windows a pause missed, as the schedule's misfire policy says; returns each window's outcome.
std::map<int64_t, std::string> runMissed(const cronsched::Schedule& s, std::vector<int64_t> windows, const std::string& owner) {
  std::sort(windows.begin(), windows.end());
  std::vector<int64_t> fire;
  std::vector<int64_t> skipped;
  std::string reason;
  if (s.misfire_policy == "skip") {
    skipped = windows;
    reason = "policy_skip";
  } else if (s.misfire_policy == "fire_once_now") {
    if (!windows.empty()) {
      fire = {windows.back()};
      skipped.assign(windows.begin(), windows.end() - 1);
    }
    reason = "coalesced";
  } else {
    // catch_up: the oldest first, a bounded number per pass; the rest stay owed.
    fire.assign(windows.begin(), windows.begin() + static_cast<std::ptrdiff_t>(std::min(windows.size(), kMaxCatchUp)));
  }
  std::map<int64_t, std::string> outcomes;
  for (const int64_t w : skipped) {
    cronsched::store::RecordRun(s.id, w, "skipped", reason);
    outcomes[w] = "skipped";
  }
  for (const int64_t w : fire) {
    outcomes[w] = fireWindow(s.id, w, owner, [&s](const std::string&, int64_t window) { return triggerJob(s, window); });
  }
  return outcomes;
}
`,
    },
  },
  harness: {
    python: `import grpc

import cron_scheduler_pb2
import cron_scheduler_pb2_grpc
from cronsched.cron import format_instant
from cronsched.store import store

W = 1773133200  # 2026-03-10T09:00:00Z
SCHEDULE = {
    "id": "s1",
    "tenant": "t1",
    "cron": "*/5 * * * *",
    "timezone": "UTC",
    "job_ref": "billing.invoice",
    "misfire_policy": "catch_up",
    "next_fire": "",
}


class FakeJobs(cron_scheduler_pb2_grpc.JobRunnerServicer):
    """Runs every Trigger it receives."""

    def __init__(self):
        self.runs = []

    def Trigger(self, request, context):
        self.runs.append(request.window)
        return cron_scheduler_pb2.TriggerReply(run_id=f"run-{len(self.runs)}")


def _world(ctx, policy):
    ctx.grpc.serve(cron_scheduler_pb2_grpc.add_JobRunnerServicer_to_server, FakeJobs())
    schedule = dict(SCHEDULE, misfire_policy=policy)
    store.put(schedule)
    return ctx.load("client"), schedule


def _missed(n):
    """n consecutive windows of a five-minute schedule, from 09:00."""
    return [W + 300 * k for k in range(n)]


def _run(ctx, m, schedule, windows):
    result = ctx.drain(m.run_missed, dict(schedule), list(windows), "a")
    assert result is not None, "run_missed never returned: it kept calling Trigger until the runtime stopped it"
    return result


def _triggered(ctx):
    return [call.request.window for call in ctx.grpc.calls_to("Trigger")]


def _ledger():
    return {row["window"]: (row["outcome"], row["reason"]) for row in store.runs("s1")}


def check_deadline(ctx):
    m, schedule = _world(ctx, "catch_up")
    ctx.grpc.set_latency("Trigger", 2.0)
    out = _run(ctx, m, schedule, [W])
    assert out.get(W) == "fired", f"a job service that answers in 2 s ended the window {out.get(W)!r}, expected fired"
    call = ctx.grpc.calls_to("Trigger")[0]
    assert call.timeout is not None, "the Trigger call carries no deadline: a job service that hangs holds the scheduler's pass with it"
    assert 2.5 <= call.timeout <= 3.5, f"the Trigger deadline is {call.timeout} s, expected about 3 s"
    ctx.grpc.set_latency("Trigger", 10.0)
    out = _run(ctx, m, schedule, [W + 300])
    assert out.get(W + 300) == "error", f"a job service that takes 10 s ended the window {out.get(W + 300)!r}, expected error once the 3 s deadline passed"
    assert _ledger().get(W + 300) == ("error", "trigger_failed"), f"the ledger row for the timed-out window is {_ledger().get(W + 300)}, expected error/trigger_failed"


def check_single_attempt(ctx):
    m, schedule = _world(ctx, "catch_up")
    ctx.grpc.fail("Trigger", grpc.StatusCode.UNAVAILABLE, "job service restarting", times=10)
    out = _run(ctx, m, schedule, [W])
    calls = len(ctx.grpc.calls_to("Trigger"))
    assert calls == 1, f"one window against a job service that answers UNAVAILABLE got {calls} Trigger calls, expected 1: the job service runs every Trigger it receives, so the window is recorded as error and the next pass decides"
    assert out.get(W) == "error", f"run_missed returned {out} for the failed window, expected error"
    assert _ledger() == {W: ("error", "trigger_failed")}, f"the ledger runs:s1 holds {_ledger()}, expected the window as error/trigger_failed"


def check_policy_skip(ctx):
    m, schedule = _world(ctx, "skip")
    missed = _missed(4)
    out = _run(ctx, m, schedule, missed)
    assert _triggered(ctx) == [], f"a skip schedule with 4 missed windows sent {len(_triggered(ctx))} Trigger calls ({_triggered(ctx)}), expected none"
    expected = {w: ("skipped", "policy_skip") for w in missed}
    assert _ledger() == expected, f"the ledger runs:s1 holds {_ledger()}, expected every missed window as skipped/policy_skip: a window with no row reads as a misfire nobody decided"
    assert out == {w: "skipped" for w in missed}, f"run_missed returned {out}, expected skipped for every window"


def check_fire_once(ctx):
    m, schedule = _world(ctx, "fire_once_now")
    missed = _missed(4)
    out = _run(ctx, m, schedule, list(reversed(missed)))
    newest = format_instant(missed[-1])
    assert _triggered(ctx) == [newest], f"a fire_once_now schedule with 4 missed windows triggered {_triggered(ctx)}, expected one Trigger for the newest window {newest}"
    expected = {w: ("skipped", "coalesced") for w in missed[:-1]}
    expected[missed[-1]] = ("fired", "")
    assert _ledger() == expected, f"the ledger runs:s1 holds {_ledger()}, expected the 3 older windows skipped/coalesced and the newest fired"
    assert out.get(missed[-1]) == "fired", f"run_missed returned {out}, expected the newest window fired"


def check_catch_up_cap(ctx):
    m, schedule = _world(ctx, "catch_up")
    missed = _missed(8)
    _run(ctx, m, schedule, missed)
    expected = [format_instant(w) for w in missed[:5]]
    assert _triggered(ctx) == expected, f"a catch_up schedule with 8 missed windows triggered {_triggered(ctx)}, expected the 5 oldest in order: an unbounded catch-up turns one pause into a burst on the job's database"
    assert _ledger() == {w: ("fired", "") for w in missed[:5]}, f"the ledger runs:s1 holds {_ledger()}, expected the 5 oldest fired and the 3 newest without a row, owed to the next pass"
`,
    typescript: `import {formatInstant} from 'cronsched/cron';
import {store} from 'cronsched/store';

const W = 1773133200; // 2026-03-10T09:00:00Z
const SCHEDULE = {
  id: 's1',
  tenant: 't1',
  cron: '*/5 * * * *',
  timezone: 'UTC',
  job_ref: 'billing.invoice',
  misfire_policy: 'catch_up',
  next_fire: '',
};

/** The job service the harness serves: it runs every Trigger it receives. */
async function world(ctx, policy: string) {
  const pkg = ctx.proto('cron_scheduler.proto');
  let runs = 0;
  ctx.grpc.serve(pkg.cronjobs.JobRunner.service, {
    Trigger(call, callback) {
      runs += 1;
      callback(null, {run_id: \`run-\${runs}\`});
    },
  });
  const schedule = {...SCHEDULE, misfire_policy: policy};
  await store.put(schedule);
  return {m: ctx.load('client'), schedule};
}

/** n consecutive windows of a five-minute schedule, from 09:00. */
const missedWindows = (n: number): number[] => Array.from({length: n}, (_, k) => W + 300 * k);

async function run(ctx, m, schedule, windows: number[]): Promise<Map<number, string>> {
  const result = await ctx.drain(m.runMissed({...schedule}, [...windows], 'a'));
  assert(result !== undefined, 'runMissed never resolved: it kept calling Trigger until the runtime stopped it');
  return result;
}

const triggered = (ctx): string[] => ctx.grpc.callsTo('Trigger').map(call => call.request.window);

async function ledger(): Promise<Record<string, string>> {
  return Object.fromEntries((await store.runs('s1')).map(row => [String(row.window), \`\${row.outcome}:\${row.reason}\`]));
}

export async function check_deadline(ctx) {
  const {m, schedule} = await world(ctx, 'catch_up');
  ctx.grpc.setLatency('Trigger', 2.0);
  let out = await run(ctx, m, schedule, [W]);
  assert.equal(out.get(W), 'fired', \`a job service that answers in 2 s ended the window \${JSON.stringify(out.get(W))}, expected fired\`);
  const call = ctx.grpc.callsTo('Trigger')[0];
  assert(call.timeout !== null, "the Trigger call carries no deadline: a job service that hangs holds the scheduler's pass with it");
  assert(2.5 <= call.timeout && call.timeout <= 3.5, \`the Trigger deadline is \${call.timeout} s, expected about 3 s\`);
  ctx.grpc.setLatency('Trigger', 10.0);
  out = await run(ctx, m, schedule, [W + 300]);
  assert.equal(out.get(W + 300), 'error', \`a job service that takes 10 s ended the window \${JSON.stringify(out.get(W + 300))}, expected error once the 3 s deadline passed\`);
  assert.equal((await ledger())[String(W + 300)], 'error:trigger_failed', 'the ledger row for the timed-out window must be error/trigger_failed');
}

export async function check_single_attempt(ctx) {
  const {m, schedule} = await world(ctx, 'catch_up');
  ctx.grpc.fail('Trigger', ctx.grpc.status.UNAVAILABLE, 'job service restarting', 10);
  const out = await run(ctx, m, schedule, [W]);
  const calls = ctx.grpc.callsTo('Trigger').length;
  assert.equal(calls, 1, \`one window against a job service that answers UNAVAILABLE got \${calls} Trigger calls, expected 1: the job service runs every Trigger it receives, so the window is recorded as error and the next pass decides\`);
  assert.equal(out.get(W), 'error', \`runMissed resolved \${JSON.stringify([...out])} for the failed window, expected error\`);
  assert.deepEqual(await ledger(), {[String(W)]: 'error:trigger_failed'}, \`the ledger runs:s1 holds \${JSON.stringify(await ledger())}, expected the window as error/trigger_failed\`);
}

export async function check_policy_skip(ctx) {
  const {m, schedule} = await world(ctx, 'skip');
  const missed = missedWindows(4);
  const out = await run(ctx, m, schedule, missed);
  assert.deepEqual(triggered(ctx), [], \`a skip schedule with 4 missed windows sent \${triggered(ctx).length} Trigger calls (\${JSON.stringify(triggered(ctx))}), expected none\`);
  const expected = Object.fromEntries(missed.map(w => [String(w), 'skipped:policy_skip']));
  assert.deepEqual(await ledger(), expected, \`the ledger runs:s1 holds \${JSON.stringify(await ledger())}, expected every missed window as skipped/policy_skip: a window with no row reads as a misfire nobody decided\`);
  assert(missed.every(w => out.get(w) === 'skipped'), \`runMissed resolved \${JSON.stringify([...out])}, expected skipped for every window\`);
}

export async function check_fire_once(ctx) {
  const {m, schedule} = await world(ctx, 'fire_once_now');
  const missed = missedWindows(4);
  const out = await run(ctx, m, schedule, [...missed].reverse());
  const newest = formatInstant(missed[3]);
  assert.deepEqual(triggered(ctx), [newest], \`a fire_once_now schedule with 4 missed windows triggered \${JSON.stringify(triggered(ctx))}, expected one Trigger for the newest window \${newest}\`);
  const expected = Object.fromEntries(missed.map((w, i) => [String(w), i === 3 ? 'fired:' : 'skipped:coalesced']));
  assert.deepEqual(await ledger(), expected, \`the ledger runs:s1 holds \${JSON.stringify(await ledger())}, expected the 3 older windows skipped/coalesced and the newest fired\`);
  assert.equal(out.get(missed[3]), 'fired', \`runMissed resolved \${JSON.stringify([...out])}, expected the newest window fired\`);
}

export async function check_catch_up_cap(ctx) {
  const {m, schedule} = await world(ctx, 'catch_up');
  const missed = missedWindows(8);
  await run(ctx, m, schedule, missed);
  const expected = missed.slice(0, 5).map(formatInstant);
  assert.deepEqual(triggered(ctx), expected, \`a catch_up schedule with 8 missed windows triggered \${JSON.stringify(triggered(ctx))}, expected the 5 oldest in order: an unbounded catch-up turns one pause into a burst on the job's database\`);
  const rows = Object.fromEntries(missed.slice(0, 5).map(w => [String(w), 'fired:']));
  assert.deepEqual(await ledger(), rows, \`the ledger runs:s1 holds \${JSON.stringify(await ledger())}, expected the 5 oldest fired and the 3 newest without a row, owed to the next pass\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"time"

	"google.golang.org/grpc/codes"

	"leetbuild/harness"

	"cronsched/cron"
	pb "cronsched/gen/cron_scheduler"
	"cronsched/store"
)

// clientWindow is 2026-03-10T09:00:00Z.
const clientWindow int64 = 1773133200

// jobsPeer runs every Trigger it receives.
type jobsPeer struct {
	pb.UnimplementedJobRunnerServer
	runs int
}

func (j *jobsPeer) Trigger(_ context.Context, _ *pb.TriggerRequest) (*pb.TriggerReply, error) {
	j.runs++
	return &pb.TriggerReply{RunId: fmt.Sprintf("run-%d", j.runs)}, nil
}

// clientWorld is a stored schedule, the job service the harness serves, and step 2's fireWindow,
// which the harness stands in for: SET NX EX 300 on the lease, the trigger, the ledger row.
func clientWorld(ctx *harness.Ctx, policy string) *store.Schedule {
	pb.RegisterJobRunnerServer(ctx.GRPC.Server(""), &jobsPeer{})
	s := &store.Schedule{ID: "s1", Tenant: "t1", Cron: "*/5 * * * *", Timezone: "UTC", JobRef: "billing.invoice", MisfirePolicy: policy}
	ctx.NoError(store.Put(context.Background(), s), "storing the schedule")
	fireWindow = func(c context.Context, scheduleID string, tick int64, owner string, trigger func(string, int64) error) (string, error) {
		window := cron.WindowOf(tick)
		if !ctx.Redis.Set(store.LeaseKey(scheduleID, window), owner, "NX", "EX", 300) {
			return "taken", nil
		}
		if err := trigger(scheduleID, window); err != nil {
			return "error", store.RecordRun(c, scheduleID, window, "error", "trigger_failed")
		}
		return "fired", store.RecordRun(c, scheduleID, window, "fired", "")
	}
	return s
}

// clientMissed is n consecutive windows of a five-minute schedule, from 09:00.
func clientMissed(n int) []int64 {
	out := make([]int64, n)
	for k := range out {
		out[k] = clientWindow + int64(300*k)
	}
	return out
}

func clientRun(ctx *harness.Ctx, s *store.Schedule, windows []int64) map[int64]string {
	var out map[int64]string
	var err error
	returned := ctx.Drain(func() {
		copied := *s
		out, err = runMissed(context.Background(), &copied, append([]int64(nil), windows...), "a")
	})
	ctx.Assert(returned, "runMissed never returned: it kept calling Trigger until the runtime stopped it")
	ctx.NoError(err, "runMissed")
	return out
}

func clientTriggered(ctx *harness.Ctx) []string {
	out := []string{}
	for _, c := range ctx.GRPC.CallsTo("Trigger", "") {
		req, _ := c.Request.(*pb.TriggerRequest)
		out = append(out, req.GetWindow())
	}
	return out
}

func clientLedger(ctx *harness.Ctx) map[int64]string {
	runs, err := store.Runs(context.Background(), "s1")
	ctx.NoError(err, "reading the ledger")
	out := map[int64]string{}
	for _, r := range runs {
		out[r.Window] = r.Outcome + ":" + r.Reason
	}
	return out
}

func CheckDeadline(ctx *harness.Ctx) {
	s := clientWorld(ctx, "catch_up")
	ctx.GRPC.SetLatency("Trigger", 2.0, "")
	out := clientRun(ctx, s, []int64{clientWindow})
	ctx.Equal(out[clientWindow], "fired", "a job service that answers in 2 s must fire the window; the outcome")
	call := ctx.GRPC.CallsTo("Trigger", "")[0]
	ctx.Assert(call.HasDeadline(), "the Trigger call carries no deadline: a job service that hangs holds the scheduler's pass with it")
	ctx.Assert(2500*time.Millisecond <= call.Timeout && call.Timeout <= 3500*time.Millisecond, "the Trigger deadline is %v, expected about 3 s", call.Timeout)
	ctx.GRPC.SetLatency("Trigger", 10.0, "")
	out = clientRun(ctx, s, []int64{clientWindow + 300})
	ctx.Equal(out[clientWindow+300], "error", "a job service that takes 10 s must end the window as error once the 3 s deadline passed; the outcome")
	ctx.Equal(clientLedger(ctx)[clientWindow+300], "error:trigger_failed", "the ledger row for the timed-out window")
}

func CheckSingleAttempt(ctx *harness.Ctx) {
	s := clientWorld(ctx, "catch_up")
	ctx.GRPC.Fail("Trigger", codes.Unavailable, "job service restarting", 10, "")
	out := clientRun(ctx, s, []int64{clientWindow})
	calls := len(ctx.GRPC.CallsTo("Trigger", ""))
	ctx.Assert(calls == 1, "one window against a job service that answers UNAVAILABLE got %d Trigger calls, expected 1: the job service runs every Trigger it receives, so the window is recorded as error and the next pass decides", calls)
	ctx.Equal(out[clientWindow], "error", "runMissed's outcome for the failed window")
	ctx.Equal(clientLedger(ctx), map[int64]string{clientWindow: "error:trigger_failed"}, "the ledger runs:s1")
}

func CheckPolicySkip(ctx *harness.Ctx) {
	s := clientWorld(ctx, "skip")
	missed := clientMissed(4)
	out := clientRun(ctx, s, missed)
	ctx.Assert(len(clientTriggered(ctx)) == 0, "a skip schedule with 4 missed windows sent %d Trigger calls (%q), expected none", len(clientTriggered(ctx)), clientTriggered(ctx))
	expected := map[int64]string{}
	outcomes := map[int64]string{}
	for _, w := range missed {
		expected[w] = "skipped:policy_skip"
		outcomes[w] = "skipped"
	}
	ctx.Equal(clientLedger(ctx), expected, "the ledger runs:s1 (every missed window as skipped/policy_skip: a window with no row reads as a misfire nobody decided)")
	ctx.Equal(out, outcomes, "runMissed's outcomes")
}

func CheckFireOnce(ctx *harness.Ctx) {
	s := clientWorld(ctx, "fire_once_now")
	missed := clientMissed(4)
	out := clientRun(ctx, s, []int64{missed[3], missed[2], missed[1], missed[0]})
	newest := cron.FormatInstant(missed[3])
	ctx.Assert(len(clientTriggered(ctx)) == 1 && clientTriggered(ctx)[0] == newest, "a fire_once_now schedule with 4 missed windows triggered %q, expected one Trigger for the newest window %s", clientTriggered(ctx), newest)
	expected := map[int64]string{missed[0]: "skipped:coalesced", missed[1]: "skipped:coalesced", missed[2]: "skipped:coalesced", missed[3]: "fired:"}
	ctx.Equal(clientLedger(ctx), expected, "the ledger runs:s1 (the 3 older windows skipped/coalesced, the newest fired)")
	ctx.Equal(out[missed[3]], "fired", "runMissed's outcome for the newest window")
}

func CheckCatchUpCap(ctx *harness.Ctx) {
	s := clientWorld(ctx, "catch_up")
	missed := clientMissed(8)
	clientRun(ctx, s, missed)
	expected := []string{}
	rows := map[int64]string{}
	for _, w := range missed[:5] {
		expected = append(expected, cron.FormatInstant(w))
		rows[w] = "fired:"
	}
	ctx.Assert(fmt.Sprint(clientTriggered(ctx)) == fmt.Sprint(expected), "a catch_up schedule with 8 missed windows triggered %q, expected the 5 oldest in order: an unbounded catch-up turns one pause into a burst on the job's database", clientTriggered(ctx))
	ctx.Equal(clientLedger(ctx), rows, "the ledger runs:s1 (the 5 oldest fired, the 3 newest without a row, owed to the next pass)")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <chrono>
#include <cstdint>
#include <map>
#include <string>
#include <vector>

#include "cron_scheduler.grpc.pb.h"
#include "cronsched/cron.h"
#include "cronsched/store.h"
#include "state.cpp"

namespace {

constexpr int64_t kClientWindow = 1773133200;  // 2026-03-10T09:00:00Z

// Runs every Trigger it receives.
class JobsPeer final : public cronjobs::JobRunner::Service {
 public:
  int runs = 0;

  grpc::Status Trigger(grpc::ServerContext*, const cronjobs::TriggerRequest*, cronjobs::TriggerReply* reply) override {
    runs++;
    reply->set_run_id("run-" + std::to_string(runs));
    return grpc::Status::OK;
  }
};

// A stored schedule and the job service the harness serves.
cronsched::Schedule clientWorld(harness::Ctx& ctx, const std::string& policy) {
  static JobsPeer* jobs = nullptr;
  delete jobs;
  jobs = new JobsPeer;
  ctx.GRPC.Server("")->RegisterService(jobs);
  const cronsched::Schedule s{"s1", "t1", "*/5 * * * *", "UTC", "billing.invoice", policy, ""};
  cronsched::store::Put(s);
  return s;
}

// n consecutive windows of a five-minute schedule, from 09:00.
std::vector<int64_t> clientMissed(int n) {
  std::vector<int64_t> out;
  for (int k = 0; k < n; k++) out.push_back(kClientWindow + 300 * k);
  return out;
}

std::map<int64_t, std::string> clientRun(harness::Ctx& ctx, const cronsched::Schedule& s, const std::vector<int64_t>& windows) {
  std::map<int64_t, std::string> out;
  const bool returned = ctx.Drain([&] { out = runMissed(s, windows, "a"); });
  ctx.Assert(returned, "runMissed never returned: it kept calling Trigger until the runtime stopped it");
  return out;
}

std::vector<std::string> clientTriggered(harness::Ctx& ctx) {
  std::vector<std::string> out;
  for (const auto& c : ctx.GRPC.CallsTo("Trigger")) out.push_back(c.Request<cronjobs::TriggerRequest>().window());
  return out;
}

std::map<int64_t, std::string> clientLedger() {
  std::map<int64_t, std::string> out;
  for (const auto& r : cronsched::store::Runs("s1")) out[r.window] = r.outcome + ":" + r.reason;
  return out;
}

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  const auto s = clientWorld(ctx, "catch_up");
  ctx.GRPC.SetLatency("Trigger", 2.0);
  auto out = clientRun(ctx, s, {kClientWindow});
  ctx.Equal(out[kClientWindow], "fired", "a job service that answers in 2 s must fire the window; the outcome");
  const auto call = ctx.GRPC.CallsTo("Trigger")[0];
  ctx.Assert(call.HasDeadline(), "the Trigger call carries no deadline: a job service that hangs holds the scheduler's pass with it");
  ctx.Assert(2.5 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 3.5, "the Trigger deadline is %vs, expected about 3 s", call.TimeoutSeconds());
  ctx.GRPC.SetLatency("Trigger", 10.0);
  out = clientRun(ctx, s, {kClientWindow + 300});
  ctx.Equal(out[kClientWindow + 300], "error",
            "a job service that takes 10 s must end the window as error once the 3 s deadline passed; the outcome");
  ctx.Equal(clientLedger()[kClientWindow + 300], "error:trigger_failed", "the ledger row for the timed-out window");
}

void CheckSingleAttempt(harness::Ctx& ctx) {
  const auto s = clientWorld(ctx, "catch_up");
  ctx.GRPC.Fail("Trigger", grpc::StatusCode::UNAVAILABLE, "job service restarting", 10);
  auto out = clientRun(ctx, s, {kClientWindow});
  const size_t calls = ctx.GRPC.CallsTo("Trigger").size();
  ctx.Assert(calls == 1,
             "one window against a job service that answers UNAVAILABLE got %d Trigger calls, expected 1: the job service runs every "
             "Trigger it receives, so the window is recorded as error and the next pass decides",
             calls);
  ctx.Equal(out[kClientWindow], "error", "runMissed's outcome for the failed window");
  ctx.Equal(clientLedger(), std::map<int64_t, std::string>{{kClientWindow, "error:trigger_failed"}}, "the ledger runs:s1");
}

void CheckPolicySkip(harness::Ctx& ctx) {
  const auto s = clientWorld(ctx, "skip");
  const auto missed = clientMissed(4);
  const auto out = clientRun(ctx, s, missed);
  ctx.Assert(clientTriggered(ctx).empty(), "a skip schedule with 4 missed windows sent %d Trigger calls (%q), expected none",
             clientTriggered(ctx).size(), clientTriggered(ctx));
  std::map<int64_t, std::string> expected;
  std::map<int64_t, std::string> outcomes;
  for (const int64_t w : missed) {
    expected[w] = "skipped:policy_skip";
    outcomes[w] = "skipped";
  }
  ctx.Equal(clientLedger(), expected,
            "the ledger runs:s1 (every missed window as skipped/policy_skip: a window with no row reads as a misfire nobody decided)");
  ctx.Equal(out, outcomes, "runMissed's outcomes");
}

void CheckFireOnce(harness::Ctx& ctx) {
  const auto s = clientWorld(ctx, "fire_once_now");
  const auto missed = clientMissed(4);
  auto out = clientRun(ctx, s, {missed[3], missed[2], missed[1], missed[0]});
  const std::string newest = cronsched::cron::FormatInstant(missed[3]);
  ctx.Equal(clientTriggered(ctx), std::vector<std::string>{newest},
            "a fire_once_now schedule with 4 missed windows must send one Trigger, for the newest window; the windows triggered");
  const std::map<int64_t, std::string> expected = {
      {missed[0], "skipped:coalesced"}, {missed[1], "skipped:coalesced"}, {missed[2], "skipped:coalesced"}, {missed[3], "fired:"}};
  ctx.Equal(clientLedger(), expected, "the ledger runs:s1 (the 3 older windows skipped/coalesced, the newest fired)");
  ctx.Equal(out[missed[3]], "fired", "runMissed's outcome for the newest window");
}

void CheckCatchUpCap(harness::Ctx& ctx) {
  const auto s = clientWorld(ctx, "catch_up");
  const auto missed = clientMissed(8);
  clientRun(ctx, s, missed);
  std::vector<std::string> expected;
  std::map<int64_t, std::string> rows;
  for (int k = 0; k < 5; k++) {
    expected.push_back(cronsched::cron::FormatInstant(missed[k]));
    rows[missed[k]] = "fired:";
  }
  ctx.Equal(clientTriggered(ctx), expected,
            "a catch_up schedule with 8 missed windows must trigger the 5 oldest in order (an unbounded catch-up turns one pause into a "
            "burst on the job's database); the windows triggered");
  ctx.Equal(clientLedger(), rows, "the ledger runs:s1 (the 5 oldest fired, the 3 newest without a row, owed to the next pass)");
}
`,
  },
  hints: [
    "After a ten-minute scheduler pause the reporting database takes a burst of queries in seconds; on the day the job service restarted, one window's Trigger was sent dozens of times.",
    "The starter treats every missed window as owed and every failed call as worth repeating: nothing reads the schedule's policy, nothing bounds the replay, and a call with no deadline waits as long as the job service does.",
    'Send one `Trigger` per window with `timeout=DEADLINE_S` and no loop; then branch on `misfire_policy`: `skip` records `policy_skip`, `fire_once_now` fires `windows[-1]` and records `coalesced` for the rest, `catch_up` fires `windows[:MAX_CATCH_UP]`.',
  ],
  debrief: `A pause is the one time a scheduler has more work than it was built for, so the code that runs after it is where bounds matter. The misfire policy is the owner's statement of what a missed window is worth: nothing for a cache warmer, the latest state for a report, every window for billing. Even the full replay is paced per pass, because the job's dependencies were sized for one fire per window. The single attempt follows from the job service's contract: it runs what it is told, so a retry after a timeout may be a second run, and an error row the next pass can see is the honest record. Production schedulers add a misfire threshold, so a fire a few seconds late is not a misfire, and a run key the job service deduplicates on, which makes a retry safe.`,
};
