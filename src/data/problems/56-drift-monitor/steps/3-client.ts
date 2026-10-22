import type {Step} from '@/lib/types';

export const alertClientStep: Step = {
  id: 'dependency',
  title: 'Alert evaluation calls that include the evidence',
  concept: 'grpc',
  file: 'client',
  focus: ['monitor', 'alerting', 'evaluator'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: a threshold is crossed, an alert
is raised and the on-call is paged. It hides three flaws, and the first one is why the page storm
happened. Review it, fix it, and prove the fix.

When an evaluated window crosses the alert threshold, the monitor raises an alert over **gRPC**:

- Every attempt carries a **1-second deadline** (\`DEADLINE_S = 1.0\` / \`DEADLINE_MS = 1000\`), so one
  slow alerting service cannot pin the evaluator or the queue behind it.
- The alert is **deduplicated per (monitor, window) with a cooldown**: the key
  \`alert:{monitor_id}:{window}\` is claimed with a **write-once** set carrying \`COOLDOWN_S = 300\`
  seconds of expiry, and the claim happens **before** the call. The draft raises one alert per batch
  tick above the threshold, which is 400 pages an hour from one monitor.
- The payload carries the **evidence**: the metric, the distance, the threshold, **both window
  boundaries** and the **sample counts** on each side (\`sample_count\`, \`baseline_sample_count\`). The
  draft sends the distance alone, so a responder cannot judge significance.
- A failed call is **retried with backoff** (\`MAX_ATTEMPTS = 3\`, exponential from \`BACKOFF_MS\`),
  never dropped silently: after the attempts are exhausted the claim is released and a
  \`alert:pending:{monitor_id}\` marker records the alert for the next evaluation. The draft calls once
  and logs the failure.

**Failure mode the checks target.** An alert storm is a monitor that is technically correct and
operationally useless; a call without a deadline takes the evaluator down with the alerting service;
and a payload without counts turns every page into an argument about whether the number is even
significant. The dedupe key is per (monitor, window), so two windows of the same monitor can both
alert — it throttles ticks, not drift.`,
  sequence: {
    participants: ['Window evaluator', 'Drift Monitor', 'Redis', 'Alerting'],
    messages: [
      {
        from: 'Window evaluator',
        to: 'Drift Monitor',
        label: 'evaluate(monitor, window, distance, counts)',
        kind: 'sync',
      },
      {from: 'Drift Monitor', to: 'Redis', label: 'SET alert:{monitor_id}:{window} NX EX 300', kind: 'sync'},
      {from: 'Redis', to: 'Drift Monitor', label: 'OK / nil (cooldown already running)', kind: 'reply'},
      {from: 'Drift Monitor', to: 'Alerting', label: 'Raise(metric, distance, boundaries, counts) · 1 s', kind: 'sync'},
      {from: 'Alerting', to: 'Drift Monitor', label: 'RaiseReply{accepted}', kind: 'reply'},
      {from: 'Drift Monitor', to: 'Alerting', label: 'retry with backoff · at most MAX_ATTEMPTS', kind: 'async'},
      {
        from: 'Drift Monitor',
        to: 'Redis',
        label: 'alert:pending:{monitor_id} when retries are exhausted',
        kind: 'async',
      },
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every attempt carries a one-second deadline',
      detail:
        'The call is created with a 1-second deadline — `timeout=DEADLINE_S`, `deadline: Date.now() + DEADLINE_MS`, `context.WithTimeout`, `withDeadlineAfter` or `set_deadline`. The draft has none, so a stalled alerting service holds the evaluator open indefinitely.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*1\.0/, /timeout=DEADLINE_S/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*1000/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/]},
        go: {all: [/deadlineMS\s*=\s*1000/, /context\.WithTimeout/]},
        scala: {all: [/DeadlineMs\s*=\s*1000/, /withDeadlineAfter/]},
        cpp: {all: [/kDeadlineMs\s*=\s*1000/, /set_deadline\(/]},
      },
    },
    {
      id: 'dedupe-cooldown',
      title: 'Claims one alert per (monitor, window) with a cooldown',
      detail:
        'The dedupe key `alert:{monitor_id}:{window}` is claimed with a write-once set that also carries the `COOLDOWN_S` expiry (`nx=True`, `NX`, `SetNX`, `SetParams…nx()`, `UpdateType::NOT_EXIST`). The draft alerts on every tick, so one crossing pages forever.',
      match: {
        python: {all: [/COOLDOWN_S/, /nx=True/, /alert_key\(/]},
        typescript: {all: [/COOLDOWN_S/, /['"]NX['"]/, /alertKey\(/]},
        go: {all: [/cooldownS/, /SetNX\(/, /alertKey\(/]},
        scala: {all: [/CooldownS/, /SetParams/, /alertKey\(/]},
        cpp: {all: [/kCooldownS/, /UpdateType::NOT_EXIST/, /alertKey\(/]},
      },
    },
    {
      id: 'payload-evidence',
      title: 'Sends the counts and both window boundaries',
      detail:
        'The request carries `sample_count`, `baseline_sample_count`, `window_start` and `window_end` alongside the distance and threshold. The draft sends the distance alone, so nobody can tell 20 samples from 20 000.',
      match: {
        python: {all: [/sample_count/, /baseline_sample_count/, /window_start/, /window_end/]},
        typescript: {all: [/sample_count/, /baseline_sample_count/, /window_start/, /window_end/]},
        go: {all: [/SampleCount/, /BaselineSampleCount/, /WindowStart/, /WindowEnd/]},
        scala: {all: [/sampleCount/, /baselineSampleCount/, /windowStart/, /windowEnd/]},
        cpp: {all: [/sample_count/, /baseline_sample_count/, /window_start/, /window_end/]},
      },
    },
    {
      id: 'retry-backoff',
      title: 'Retries the failed alert with backoff instead of dropping it',
      detail:
        'Attempts are bounded by `MAX_ATTEMPTS = 3` and spaced by an exponential backoff built from `BACKOFF_MS`/`BACKOFF_S`. The draft makes exactly one call, logs the failure and loses the alert that mattered.',
      match: {
        python: {all: [/MAX_ATTEMPTS/, /BACKOFF_S/, /time\.sleep\(/]},
        typescript: {all: [/MAX_ATTEMPTS/, /BACKOFF_MS/, /setTimeout\(/]},
        go: {all: [/maxAttempts/, /backoffMS/, /time\.Sleep\(/]},
        scala: {all: [/MaxAttempts/, /BackoffMs/, /Thread\.sleep\(/]},
        cpp: {all: [/kMaxAttempts/, /kBackoffMs/, /sleep_for\(/]},
      },
    },
    {
      id: 'claim-before-call',
      title: 'Claims the dedupe key before raising the alert',
      detail:
        'The key is claimed before the alert call, so a second tick that sees the claim skips the page; claiming after the call leaves a window where two concurrent ticks both alert. The draft has no claim at all.',
      match: {
        python: {order: [/alert_key\(/, /alerting\.Raise\(/]},
        typescript: {order: [/alertKey\(/, /alerting\.Raise\(/]},
        go: {order: [/alertKey\(/, /alerting\.Raise\(/]},
        scala: {order: [/alertKey\(/, /\.raise\(/]},
        cpp: {order: [/alertKey\(/, /alerting->Raise\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

import grpc

import alerting_pb2
import alerting_pb2_grpc

logger = logging.getLogger("drift-monitor")

channel = grpc.insecure_channel("alerting:9000")
alerting = alerting_pb2_grpc.AlertingStub(channel)

THRESHOLD = 0.2


def evaluate(
    monitor_id: str,
    metric: str,
    distance: float,
    window_start: int,
    window_end: int,
    counts: dict[str, int],
) -> bool:
    # TODO: this draft alerts on every batch tick above the threshold with no dedupe and no cooldown,
    # sends a payload without the sample counts, and drops the alert when the call fails. Review all
    # three.
    if distance < THRESHOLD:
        return False
    request = alerting_pb2.AlertRequest(monitor_id=monitor_id, metric=metric, distance=distance)
    try:
        alerting.Raise(request)
    except grpc.RpcError as exc:
        logger.warning("alert failed monitor=%s status=%s", monitor_id, exc.code())
        return False
    return True
`,
      solution: `import logging
import time

import grpc
import redis

import alerting_pb2
import alerting_pb2_grpc

logger = logging.getLogger("drift-monitor")
r = redis.Redis(host="redis", port=6379, decode_responses=True)

channel = grpc.insecure_channel("alerting:9000")
alerting = alerting_pb2_grpc.AlertingStub(channel)

DEADLINE_S = 1.0
COOLDOWN_S = 300
MAX_ATTEMPTS = 3
BACKOFF_S = 0.2


def alert_key(monitor_id: str, window: int) -> str:
    return f"alert:{monitor_id}:{window}"


def claim_alert(monitor_id: str, window: int) -> bool:
    """Claim the alert slot for (monitor, window); False when a cooldown is already running."""
    return bool(r.set(alert_key(monitor_id, window), "1", nx=True, ex=COOLDOWN_S))


def raise_alert(
    monitor: dict,
    window: int,
    distance: float,
    sample_count: int,
    baseline_sample_count: int,
) -> bool:
    window_start = window
    window_end = window + monitor["window_s"]
    if not claim_alert(monitor["monitor_id"], window):
        logger.info("alert suppressed monitor=%s window=%d", monitor["monitor_id"], window)
        return False
    request = alerting_pb2.AlertRequest(
        monitor_id=monitor["monitor_id"],
        metric=monitor["metric"],
        distance=distance,
        threshold=monitor["threshold"],
        window_start=window_start,
        window_end=window_end,
        sample_count=sample_count,
        baseline_sample_count=baseline_sample_count,
    )
    for attempt in range(MAX_ATTEMPTS):
        try:
            alerting.Raise(request, timeout=DEADLINE_S)
            return True
        except grpc.RpcError as exc:
            logger.warning(
                "alert attempt failed monitor=%s attempt=%d status=%s",
                monitor["monitor_id"],
                attempt,
                exc.code(),
            )
            time.sleep(BACKOFF_S * 2**attempt)
    r.delete(alert_key(monitor["monitor_id"], window))
    r.set(f"alert:pending:{monitor['monitor_id']}", "1")
    raise RuntimeError("alerting service unavailable after retries")
`,
    },
    typescript: {
      starter: `/** Alert evaluation over gRPC: a model-generated draft. */
import {alerting, type AlertRequest} from './alerting';

const THRESHOLD = 0.2;

export async function evaluate(
  monitorId: string,
  metric: string,
  distance: number,
  window_start: number,
  window_end: number,
  counts: Record<string, number>,
): Promise<boolean> {
  // TODO: this draft alerts on every batch tick above the threshold with no dedupe and no cooldown,
  // sends a payload without the sample counts, and drops the alert when the call fails. Review all
  // three.
  if (distance < THRESHOLD) return false;
  const request: AlertRequest = {monitor_id: monitorId, metric, distance};
  try {
    await alerting.Raise(request);
  } catch (error) {
    console.warn({monitor: monitorId, error}, 'alert failed');
    return false;
  }
  return true;
}
`,
      solution: `/** Alert evaluation over gRPC: evidence in the payload, a cooldown in front of the pager. */
import Redis from 'ioredis';

import {alerting, type AlertRequest} from './alerting';

const r = new Redis({host: 'redis', port: 6379});

const DEADLINE_MS = 1000;
const COOLDOWN_S = 300;
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = 200;

interface Monitor {
  monitor_id: string;
  metric: string;
  threshold: number;
  window_s: number;
}

function alertKey(monitorId: string, window: number): string {
  return 'alert:' + monitorId + ':' + window;
}

async function claimAlert(monitorId: string, window: number): Promise<boolean> {
  const reply = await r.set(alertKey(monitorId, window), '1', 'EX', COOLDOWN_S, 'NX');
  return reply === 'OK';
}

export async function raiseAlert(
  monitor: Monitor,
  window: number,
  distance: number,
  sample_count: number,
  baseline_sample_count: number,
): Promise<boolean> {
  const window_start = window;
  const window_end = window + monitor.window_s;
  if (!(await claimAlert(monitor.monitor_id, window))) {
    return false;
  }
  const request: AlertRequest = {
    monitor_id: monitor.monitor_id,
    metric: monitor.metric,
    distance,
    threshold: monitor.threshold,
    window_start,
    window_end,
    sample_count,
    baseline_sample_count,
  };
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      await alerting.Raise(request, {deadline: Date.now() + DEADLINE_MS});
      return true;
    } catch {
      const {promise, resolve} = Promise.withResolvers<void>();
      setTimeout(resolve, BACKOFF_MS * 2 ** attempt);
      await promise;
    }
  }
  await r.del(alertKey(monitor.monitor_id, window));
  await r.set('alert:pending:' + monitor.monitor_id, '1');
  throw new Error('alerting service unavailable after retries');
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"log"

	pb "monitor/alertingpb"
)

const threshold = 0.2

var alerting pb.AlertingClient

func evaluate(ctx context.Context, monitorID, metric string, distance float64, window int64, counts map[string]int64) bool {
	// TODO: this draft alerts on every batch tick above the threshold with no dedupe and no cooldown,
	// sends a payload without the sample counts, and drops the alert when the call fails. Review all
	// three.
	if distance < threshold {
		return false
	}
	request := &pb.AlertRequest{MonitorId: monitorID, Metric: metric, Distance: distance}
	if _, err := alerting.Raise(ctx, request); err != nil {
		log.Printf("alert failed monitor=%s err=%v", monitorID, err)
		return false
	}
	return true
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "monitor/alertingpb"
)

const (
	deadlineMS  = 1000
	cooldownS   = 300
	maxAttempts = 3
	backoffMS   = 200
)

var (
	rdb      *redis.Client
	alerting pb.AlertingClient
)

type Monitor struct {
	MonitorID string
	Metric    string
	Threshold float64
	WindowS   int64
}

func alertKey(monitorID string, window int64) string {
	return fmt.Sprintf("alert:%s:%d", monitorID, window)
}

func claimAlert(ctx context.Context, monitorID string, window int64) bool {
	ok, err := rdb.SetNX(ctx, alertKey(monitorID, window), "1", cooldownS*time.Second).Result()
	if err != nil {
		return false
	}
	return ok
}

func raiseAlert(
	ctx context.Context,
	monitor Monitor,
	window int64,
	distance float64,
	sampleCount int64,
	baselineSampleCount int64,
) (bool, error) {
	windowStart := window
	windowEnd := window + monitor.WindowS
	if !claimAlert(ctx, monitor.MonitorID, window) {
		log.Printf("alert suppressed monitor=%s window=%d", monitor.MonitorID, window)
		return false, nil
	}
	request := &pb.AlertRequest{
		MonitorId:           monitor.MonitorID,
		Metric:              monitor.Metric,
		Distance:            distance,
		Threshold:           monitor.Threshold,
		WindowStart:         windowStart,
		WindowEnd:           windowEnd,
		SampleCount:         sampleCount,
		BaselineSampleCount: baselineSampleCount,
	}
	for attempt := 0; attempt < maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadlineMS*time.Millisecond)
		_, err := alerting.Raise(callCtx, request)
		cancel()
		if err == nil {
			return true, nil
		}
		log.Printf("alert attempt failed monitor=%s attempt=%d code=%s", monitor.MonitorID, attempt, status.Code(err))
		time.Sleep(time.Duration(backoffMS*(1<<attempt)) * time.Millisecond)
	}
	rdb.Del(ctx, alertKey(monitor.MonitorID, window))
	rdb.Set(ctx, "alert:pending:"+monitor.MonitorID, "1", 0)
	return false, status.Error(codes.Unavailable, "alerting service unavailable after retries")
}
`,
    },
    scala: {
      starter: `import io.grpc.ManagedChannelBuilder
import io.grpc.StatusRuntimeException

object AlertClient {
  val Threshold = 0.2

  val alerting = AlertingGrpc.stub(ManagedChannelBuilder.forAddress("alerting", 9000).usePlaintext().build())

  def evaluate(
      monitorId: String,
      metric: String,
      distance: Double,
      windowStart: Long,
      windowEnd: Long,
      counts: Map[String, Long],
  ): Boolean = {
    // TODO: this draft alerts on every batch tick above the threshold with no dedupe and no cooldown,
    // sends a payload without the sample counts, and drops the alert when the call fails. Review all
    // three.
    if (distance < Threshold) {
      return false
    }
    val request = AlertRequest(monitorId = monitorId, metric = metric, distance = distance)
    try {
      alerting.raise(request)
    } catch {
      case _: StatusRuntimeException =>
        return false
    }
    true
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.ManagedChannelBuilder
import io.grpc.StatusRuntimeException
import redis.clients.jedis.Jedis
import redis.clients.jedis.params.SetParams

final case class Monitor(monitorId: String, metric: String, threshold: Double, windowS: Long)

object AlertClient {
  val DeadlineMs = 1000L
  val CooldownS = 300L
  val MaxAttempts = 3
  val BackoffMs = 200L

  val jedis = new Jedis("redis", 6379)
  val alerting = AlertingGrpc.stub(ManagedChannelBuilder.forAddress("alerting", 9000).usePlaintext().build())

  def alertKey(monitorId: String, window: Long): String = s"alert:$monitorId:$window"

  def claimAlert(monitorId: String, window: Long): Boolean =
    jedis.set(alertKey(monitorId, window), "1", SetParams.setParams().nx().ex(CooldownS)) == "OK"

  def raiseAlert(
      monitor: Monitor,
      window: Long,
      distance: Double,
      sampleCount: Long,
      baselineSampleCount: Long,
  ): Boolean = {
    val windowStart = window
    val windowEnd = window + monitor.windowS
    if (!claimAlert(monitor.monitorId, window)) {
      return false
    }
    val request = AlertRequest(
      monitorId = monitor.monitorId,
      metric = monitor.metric,
      distance = distance,
      threshold = monitor.threshold,
      windowStart = windowStart,
      windowEnd = windowEnd,
      sampleCount = sampleCount,
      baselineSampleCount = baselineSampleCount,
    )
    var attempt = 0
    while (attempt < MaxAttempts) {
      try {
        alerting.withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS).raise(request)
        return true
      } catch {
        case _: StatusRuntimeException =>
          Thread.sleep(BackoffMs * (1 << attempt))
      }
      attempt += 1
    }
    jedis.del(alertKey(monitor.monitorId, window))
    jedis.set("alert:pending:" + monitor.monitorId, "1")
    throw new IllegalStateException("alerting service unavailable after retries")
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <iostream>
#include <map>
#include <memory>
#include <string>

#include "alerting.grpc.pb.h"

constexpr double kThreshold = 0.2;

std::unique_ptr<Alerting::Stub> alerting =
    Alerting::NewStub(grpc::CreateChannel("alerting:9000", grpc::InsecureChannelCredentials()));

bool evaluate(const std::string& monitorId,
              const std::string& metric,
              double distance,
              long window,
              const std::map<std::string, long>& counts) {
  // TODO: this draft alerts on every batch tick above the threshold with no dedupe and no cooldown,
  // sends a payload without the sample counts, and drops the alert when the call fails. Review all
  // three.
  if (distance < kThreshold) return false;
  AlertRequest request;
  request.set_monitor_id(monitorId);
  request.set_metric(metric);
  request.set_distance(distance);
  AlertReply reply;
  grpc::ClientContext ctx;
  if (!alerting->Raise(&ctx, request, &reply).ok()) {
    std::cerr << "alert failed monitor=" << monitorId << "\\n";
    return false;
  }
  return true;
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <memory>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>

#include "alerting.grpc.pb.h"

constexpr int kDeadlineMs = 1000;
constexpr int kCooldownS = 300;
constexpr int kMaxAttempts = 3;
constexpr int kBackoffMs = 200;

sw::redis::Redis redis("tcp://redis:6379");
std::unique_ptr<Alerting::Stub> alerting =
    Alerting::NewStub(grpc::CreateChannel("alerting:9000", grpc::InsecureChannelCredentials()));

std::string alertKey(const std::string& monitorId, long window) {
  return "alert:" + monitorId + ":" + std::to_string(window);
}

bool claimAlert(const std::string& monitorId, long window) {
  return redis.set(alertKey(monitorId, window), "1", std::chrono::seconds(kCooldownS),
                   sw::redis::UpdateType::NOT_EXIST);
}

bool raiseAlert(const Monitor& monitor,
                long window,
                double distance,
                long sample_count,
                long baseline_sample_count) {
  const long window_start = window;
  const long window_end = window + monitor.window_s();
  if (!claimAlert(monitor.monitor_id(), window)) return false;
  AlertRequest request;
  request.set_monitor_id(monitor.monitor_id());
  request.set_metric(monitor.metric());
  request.set_distance(distance);
  request.set_threshold(monitor.threshold());
  request.set_window_start(window_start);
  request.set_window_end(window_end);
  request.set_sample_count(sample_count);
  request.set_baseline_sample_count(baseline_sample_count);
  AlertReply reply;
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kDeadlineMs));
    if (alerting->Raise(&ctx, request, &reply).ok()) return true;
    std::this_thread::sleep_for(std::chrono::milliseconds(kBackoffMs * (1 << attempt)));
  }
  redis.del(alertKey(monitor.monitor_id(), window));
  redis.set("alert:pending:" + monitor.monitor_id(), "1");
  throw std::runtime_error("alerting service unavailable after retries");
}
`,
    },
  },
  hints: [
    'Claim before you call: `SET alert:{monitor_id}:{window} 1 NX EX 300` returns nil when a cooldown is already running, and that nil is the whole storm fix. Do it first so two evaluator ticks racing on one window cannot both page.',
    'A page without evidence gets argued about. Send the metric, the distance, the threshold, both boundaries and the counts on each side; `sample_count` vs `baseline_sample_count` is what lets a responder say "20 samples, ignore" or "20 000 samples, wake someone".',
    'The retry loop is bounded and spaced: `MAX_ATTEMPTS = 3` with an exponential backoff, and it must not swallow the last failure. Release the dedupe claim and leave an `alert:pending:{monitor_id}` marker so the next evaluation picks the alert back up.',
  ],
  debrief: `This step is where a correct detector becomes a usable one. Three habits are being tested. First,
deduplicate at the point of decision with a key that names the thing you are deduplicating —
(monitor, window) — and claim it before the call, because a claim after the call still lets a race
through. Second, put the evidence in the payload: distance, threshold, both boundaries and both sample
counts, so the page is actionable instead of a debate. Third, treat the alerting service like any
other dependency: a deadline, a bounded retry with backoff, and a durable marker when the retries run
out, so an alert is delayed rather than lost. Real systems add alert grouping across monitors, a
silence API for operators, per-severity cooldowns, and a synthetic canary alert that keeps the pager
path honest.`,
};
