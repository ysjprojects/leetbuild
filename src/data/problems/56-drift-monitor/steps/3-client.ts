import type {Step} from '@/lib/types';

export const alertClientStep: Step = {
  id: 'dependency',
  title: 'Alerting calls that page once and carry their evidence',
  concept: 'grpc',
  file: 'client',
  focus: ['monitor', 'alerting', 'evaluator'],
  task: `## Task

**Starting point.** The starter is \`raise_alert(monitor, window, distance, sample_count,
baseline_sample_count)\`, which the evaluator calls when a window's distance crossed the monitor's
threshold: it sends \`Raise\` to the alerting service over gRPC with the monitor id, the metric and
the distance, logs a failure and returns whether the page went out. With alerting healthy it pages,
and it hides five flaws.

**Failure mode the checks target.** One drifting window pages on every evaluator tick, and two
evaluators that see it at once both page; a stalled alerting service holds the evaluator open; the
page cannot tell 20 samples from 20 000; and one failed call drops the page that mattered.

\`\`\`proto
service Alerting { rpc Raise(AlertRequest) returns (AlertReply); }  // UNAVAILABLE while it restarts
\`\`\`

- Every attempt carries a **\`DEADLINE_S\` = 1 s** deadline.
- Claim \`alert_key(monitor_id, window)\` (\`alert:{monitor_id}:{window}\`) with **\`SET … NX EX
  COOLDOWN_S\`** (300 s) **before** the call; when the claim exists, return \`False\` without a call.
- The request carries the threshold, \`window_start\`, \`window_end\` (\`window + window_s\`),
  \`sample_count\` and \`baseline_sample_count\`.
- A failed call is retried, at most \`MAX_ATTEMPTS\` = 3 attempts, sleeping \`BACKOFF_S\` (0.2 s)
  doubled each time; after the last one, delete the claim and raise \`AlertUnavailable\`.`,
  sequence: {
    participants: ['Window evaluator', 'Drift Monitor', 'Redis', 'Alerting'],
    messages: [
      {
        from: 'Window evaluator',
        to: 'Drift Monitor',
        label: 'raise_alert(monitor, 900, 0.31, 640, 5000)',
        kind: 'sync',
      },
      {from: 'Drift Monitor', to: 'Redis', label: 'SET alert:m-1:900 1 NX EX 300', kind: 'sync'},
      {from: 'Redis', to: 'Drift Monitor', label: 'OK · nil → already paged, return False', kind: 'reply'},
      {from: 'Drift Monitor', to: 'Alerting', label: 'Raise(evidence) · deadline 1 s', kind: 'sync'},
      {
        from: 'Alerting',
        to: 'Drift Monitor',
        label: 'AlertReply · UNAVAILABLE → retry after 0.2 s, 0.4 s',
        kind: 'reply',
      },
      {from: 'Drift Monitor', to: 'Redis', label: 'DEL alert:m-1:900 after the last attempt', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every attempt carries a one-second deadline',
      detail:
        'Each `Raise` is made with `DEADLINE_S` = 1 s (`timeout=`, `deadline:`, `context.WithTimeout`, `withDeadlineAfter`, `set_deadline`); without one a stalled alerting service holds the evaluator open.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*1(\.0)?\b/, /Raise\([^)]*timeout\s*=\s*DEADLINE_S/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*1000\b/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/]},
        go: {all: [/deadline\s*=\s*(1\s*\*\s*)?time\.Second/, /context\.WithTimeout\([^\n]*deadline\)/]},
        scala: {all: [/DeadlineMs\s*=\s*1000L?\b/, /withDeadlineAfter\(\s*DeadlineMs/]},
        cpp: {all: [/kDeadlineMs\s*=\s*1000\b/, /set_deadline\([^\n]*kDeadlineMs/]},
      },
    },
    {
      id: 'dedupe-cooldown',
      title: 'Pages once per (monitor, window) and cooldown',
      detail:
        'The page is claimed under `alert:{monitor_id}:{window}` with a set-if-absent that expires after `COOLDOWN_S` = 300 s; a second evaluation of the same window finds the claim and does not call.',
      match: {
        python: {all: [/COOLDOWN_S\s*=\s*300\b/, /nx\s*=\s*True/, /ex\s*=\s*COOLDOWN_S/]},
        typescript: {all: [/COOLDOWN_S\s*=\s*300\b/, /['"]NX['"]/, /['"]EX['"],\s*COOLDOWN_S/]},
        go: {all: [/cooldown\s*=\s*300\s*\*\s*time\.Second/, /SetNX\([^\n]*cooldown\)/]},
        scala: {all: [/CooldownS\s*=\s*300L?\b/, /\.nx\(\)/, /\.ex\(\s*CooldownS/]},
        cpp: {all: [/kCooldownS\s*=\s*300\b/, /UpdateType::NOT_EXIST/]},
      },
    },
    {
      id: 'claim-before-call',
      title: 'Claims the page before calling alerting',
      detail:
        'The claim is written before `Raise`, so a second evaluator that sees the same window while the first is paging finds it; a claim written after the call leaves both evaluators free to page.',
      match: {
        python: {order: [/nx\s*=\s*True/, /alerting\.Raise\(/]},
        typescript: {order: [/['"]NX['"]/, /alerting\.Raise\(/]},
        go: {order: [/SetNX\(/, /alerting\.Raise\(/]},
        scala: {order: [/\.nx\(\)/, /\.raise\(/]},
        cpp: {order: [/UpdateType::NOT_EXIST/, /alerting->Raise\(/]},
      },
    },
    {
      id: 'payload-evidence',
      title: 'Sends the threshold, the window and the sample counts',
      detail:
        'The request carries the threshold, both window boundaries and the sample counts on each side, so the on-call can tell a crossing on 20 samples from one on 20 000.',
      match: {
        python: {all: [/threshold\s*=/, /window_end\s*=/, /baseline_sample_count\s*=/]},
        typescript: {all: [/threshold:/, /window_end:/, /baseline_sample_count:/]},
        go: {all: [/Threshold:/, /WindowEnd:/, /BaselineSampleCount:/]},
        scala: {all: [/threshold\s*=/, /windowEnd\s*=/, /baselineSampleCount\s*=/]},
        cpp: {all: [/set_threshold\(/, /set_window_end\(/, /set_baseline_sample_count\(/]},
      },
    },
    {
      id: 'retry-backoff',
      title: 'Retries with backoff, then releases the claim',
      detail:
        'A failed `Raise` is retried up to `MAX_ATTEMPTS` with a doubling backoff; when every attempt failed the claim is deleted and `AlertUnavailable` raised, so the next evaluation pages instead of finding a claim nobody acted on.',
      match: {
        python: {all: [/MAX_ATTEMPTS/, /BACKOFF_S/, /time\.sleep\(/, /raise AlertUnavailable/]},
        typescript: {all: [/MAX_ATTEMPTS/, /BACKOFF_MS/, /setTimeout\(/, /throw new AlertUnavailable/]},
        go: {all: [/maxAttempts/, /\bbackoff\b/, /time\.Sleep\(/, /fmt\.Errorf\([^\n]*ErrAlertUnavailable/]},
        scala: {all: [/MaxAttempts/, /BackoffMs/, /Thread\.sleep\(/, /throw new AlertUnavailable/]},
        cpp: {all: [/kMaxAttempts/, /kBackoffMs/, /sleep_for\(/, /throw AlertUnavailable/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

import grpc

import drift_monitor_pb2
import drift_monitor_pb2_grpc

log = logging.getLogger("alerts")

alerting = drift_monitor_pb2_grpc.AlertingStub(grpc.insecure_channel("alerting:9000"))


class AlertUnavailable(Exception):
    """Alerting did not take the page after every attempt: the next evaluation pages again."""


def raise_alert(monitor: dict, window: int, distance: float, sample_count: int, baseline_sample_count: int) -> bool:
    """Page for a window whose distance crossed the monitor's threshold; True when this call raised the page."""
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    request = drift_monitor_pb2.AlertRequest(monitor_id=monitor["monitor_id"], metric=monitor["metric"], distance=distance)
    try:
        alerting.Raise(request)
    except grpc.RpcError as exc:
        log.warning("alert failed monitor=%s: %s", monitor["monitor_id"], exc.code())
        return False
    return True
`,
      solution: `import logging
import time

import grpc
import redis

import drift_monitor_pb2
import drift_monitor_pb2_grpc

log = logging.getLogger("alerts")
r = redis.Redis(host="redis", port=6379, decode_responses=True)

alerting = drift_monitor_pb2_grpc.AlertingStub(grpc.insecure_channel("alerting:9000"))

DEADLINE_S = 1.0
COOLDOWN_S = 300
MAX_ATTEMPTS = 3
BACKOFF_S = 0.2


class AlertUnavailable(Exception):
    """Alerting did not take the page after every attempt: the next evaluation pages again."""


def alert_key(monitor_id: str, window: int) -> str:
    return f"alert:{monitor_id}:{window}"


def raise_alert(monitor: dict, window: int, distance: float, sample_count: int, baseline_sample_count: int) -> bool:
    """Page for a window whose distance crossed the monitor's threshold; True when this call raised the page."""
    key = alert_key(monitor["monitor_id"], window)
    # The claim is the decision: whoever sets it pages, every other evaluation in the cooldown stays quiet.
    if not r.set(key, "1", nx=True, ex=COOLDOWN_S):
        return False
    request = drift_monitor_pb2.AlertRequest(
        monitor_id=monitor["monitor_id"],
        metric=monitor["metric"],
        distance=distance,
        threshold=monitor["threshold"],
        window_start=window,
        window_end=window + monitor["window_s"],
        sample_count=sample_count,
        baseline_sample_count=baseline_sample_count,
    )
    for attempt in range(MAX_ATTEMPTS):
        if attempt > 0:
            time.sleep(BACKOFF_S * 2 ** (attempt - 1))
        try:
            alerting.Raise(request, timeout=DEADLINE_S)
            return True
        except grpc.RpcError as exc:
            log.warning("alert attempt %d failed monitor=%s: %s", attempt + 1, monitor["monitor_id"], exc.code())
    r.delete(key)  # nobody was paged: release the claim so the next evaluation tries again
    raise AlertUnavailable(f"alerting did not take the page for {key}")
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import type {Monitor} from 'drift/store';

interface AlertRequest {
  monitor_id: string;
  metric: string;
  distance: number;
  threshold?: number;
  window_start?: number;
  window_end?: number;
  sample_count?: number;
  baseline_sample_count?: number;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('drift_monitor.proto')) as unknown as {
  driftmon: {Alerting: grpc.ServiceClientConstructor};
};
const alerting = new pkg.driftmon.Alerting('alerting:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Raise(request: AlertRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{alert_id: string}>;
};

/** Alerting did not take the page after every attempt: the next evaluation pages again. */
export class AlertUnavailable extends Error {}

/** Page for a window whose distance crossed the monitor's threshold; true when this call raised the page. */
export async function raiseAlert(monitor: Monitor, window: number, distance: number, sampleCount: number, baselineSampleCount: number): Promise<boolean> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  try {
    await alerting.Raise({monitor_id: monitor.monitor_id, metric: monitor.metric, distance}, new grpc.Metadata(), {});
    return true;
  } catch (e) {
    console.warn(\`alert failed monitor=\${monitor.monitor_id}: \${grpc.status[(e as grpc.ServiceError).code]}\`);
    return false;
  }
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Redis from 'ioredis';

import type {Monitor} from 'drift/store';

export const DEADLINE_MS = 1000;
export const COOLDOWN_S = 300;
export const MAX_ATTEMPTS = 3;
export const BACKOFF_MS = 200;

interface AlertRequest {
  monitor_id: string;
  metric: string;
  distance: number;
  threshold?: number;
  window_start?: number;
  window_end?: number;
  sample_count?: number;
  baseline_sample_count?: number;
}

const redis = new Redis({host: 'redis', port: 6379});

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('drift_monitor.proto')) as unknown as {
  driftmon: {Alerting: grpc.ServiceClientConstructor};
};
const alerting = new pkg.driftmon.Alerting('alerting:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Raise(request: AlertRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{alert_id: string}>;
};

/** Alerting did not take the page after every attempt: the next evaluation pages again. */
export class AlertUnavailable extends Error {}

export const alertKey = (monitorId: string, window: number): string => \`alert:\${monitorId}:\${window}\`;

const sleep = (ms: number): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

/** Page for a window whose distance crossed the monitor's threshold; true when this call raised the page. */
export async function raiseAlert(monitor: Monitor, window: number, distance: number, sampleCount: number, baselineSampleCount: number): Promise<boolean> {
  const key = alertKey(monitor.monitor_id, window);
  // The claim is the decision: whoever sets it pages, every other evaluation in the cooldown stays quiet.
  if ((await redis.set(key, '1', 'EX', COOLDOWN_S, 'NX')) !== 'OK') return false;
  const request: AlertRequest = {
    monitor_id: monitor.monitor_id,
    metric: monitor.metric,
    distance,
    threshold: monitor.threshold,
    window_start: window,
    window_end: window + monitor.window_s,
    sample_count: sampleCount,
    baseline_sample_count: baselineSampleCount,
  };
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(BACKOFF_MS * 2 ** (attempt - 1));
    try {
      await alerting.Raise(request, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
      return true;
    } catch (e) {
      console.warn(\`alert attempt \${attempt + 1} failed monitor=\${monitor.monitor_id}: \${grpc.status[(e as grpc.ServiceError).code]}\`);
    }
  }
  await redis.del(key); // nobody was paged: release the claim so the next evaluation tries again
  throw new AlertUnavailable(\`alerting did not take the page for \${key}\`);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"errors"
	"log"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "drift/gen/drift_monitor"
	"drift/store" // store.Monitor
)

var (
	alertingConn, _ = grpc.NewClient("alerting:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	alerting        = pb.NewAlertingClient(alertingConn)
)

// ErrAlertUnavailable: alerting did not take the page after every attempt, the next evaluation pages again.
var ErrAlertUnavailable = errors.New("alerting did not take the page")

// raiseAlert pages for a window whose distance crossed the monitor's threshold; true when this call raised the page.
func raiseAlert(ctx context.Context, monitor store.Monitor, window int64, distance float64, sampleCount, baselineSampleCount int64) (bool, error) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	_, err := alerting.Raise(ctx, &pb.AlertRequest{MonitorId: monitor.MonitorID, Metric: monitor.Metric, Distance: distance})
	if err != nil {
		log.Printf("alert failed monitor=%s: %v", monitor.MonitorID, err)
		return false, nil
	}
	return true, nil
}
`,
      solution: `package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "drift/gen/drift_monitor"
	"drift/store" // store.Monitor
)

const (
	deadline    = 1 * time.Second
	cooldown    = 300 * time.Second
	maxAttempts = 3
	backoff     = 200 * time.Millisecond
)

var (
	rdb             = redis.NewClient(&redis.Options{Addr: "redis:6379"})
	alertingConn, _ = grpc.NewClient("alerting:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	alerting        = pb.NewAlertingClient(alertingConn)
)

// ErrAlertUnavailable: alerting did not take the page after every attempt, the next evaluation pages again.
var ErrAlertUnavailable = errors.New("alerting did not take the page")

func alertKey(monitorID string, window int64) string {
	return fmt.Sprintf("alert:%s:%d", monitorID, window)
}

// raiseAlert pages for a window whose distance crossed the monitor's threshold; true when this call raised the page.
func raiseAlert(ctx context.Context, monitor store.Monitor, window int64, distance float64, sampleCount, baselineSampleCount int64) (bool, error) {
	key := alertKey(monitor.MonitorID, window)
	// The claim is the decision: whoever sets it pages, every other evaluation in the cooldown stays quiet.
	claimed, err := rdb.SetNX(ctx, key, "1", cooldown).Result()
	if err != nil || !claimed {
		return false, err
	}
	request := &pb.AlertRequest{
		MonitorId:           monitor.MonitorID,
		Metric:              monitor.Metric,
		Distance:            distance,
		Threshold:           monitor.Threshold,
		WindowStart:         window,
		WindowEnd:           window + monitor.WindowS,
		SampleCount:         sampleCount,
		BaselineSampleCount: baselineSampleCount,
	}
	for attempt := 0; attempt < maxAttempts; attempt++ {
		if attempt > 0 {
			time.Sleep(backoff * time.Duration(1<<(attempt-1)))
		}
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		_, err = alerting.Raise(callCtx, request)
		cancel()
		if err == nil {
			return true, nil
		}
		log.Printf("alert attempt %d failed monitor=%s: %v", attempt+1, monitor.MonitorID, err)
	}
	rdb.Del(ctx, key) // nobody was paged: release the claim so the next evaluation tries again
	return false, fmt.Errorf("%w for %s: %v", ErrAlertUnavailable, key, err)
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import drift.Store // Store.Monitor
import driftmon.drift_monitor.{AlertRequest, AlertingGrpc}

/** Alerting did not take the page after every attempt: the next evaluation pages again. */
final class AlertUnavailable(message: String) extends Exception(message)

object Client {
  private val alerting = AlertingGrpc.blockingStub(ManagedChannelBuilder.forAddress("alerting", 9000).usePlaintext().build())

  /** Page for a window whose distance crossed the monitor's threshold; true when this call raised the page. */
  def raiseAlert(monitor: Store.Monitor, window: Long, distance: Double, sampleCount: Long, baselineSampleCount: Long): Boolean = {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    try {
      alerting.raise(AlertRequest(monitorId = monitor.monitorId, metric = monitor.metric, distance = distance))
      true
    } catch {
      case e: StatusRuntimeException =>
        System.err.println(s"alert failed monitor=\${monitor.monitorId}: \${e.getStatus.getCode}")
        false
    }
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}
import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

import drift.Store // Store.Monitor
import driftmon.drift_monitor.{AlertRequest, AlertingGrpc}

/** Alerting did not take the page after every attempt: the next evaluation pages again. */
final class AlertUnavailable(message: String) extends Exception(message)

object Client {
  val DeadlineMs = 1000L
  val CooldownS = 300L
  val MaxAttempts = 3
  val BackoffMs = 200L

  private val jedis = new JedisPooled("redis", 6379)
  private val alerting = AlertingGrpc.blockingStub(ManagedChannelBuilder.forAddress("alerting", 9000).usePlaintext().build())

  def alertKey(monitorId: String, window: Long): String = s"alert:$monitorId:$window"

  /** Page for a window whose distance crossed the monitor's threshold; true when this call raised the page. */
  def raiseAlert(monitor: Store.Monitor, window: Long, distance: Double, sampleCount: Long, baselineSampleCount: Long): Boolean = {
    val key = alertKey(monitor.monitorId, window)
    // The claim is the decision: whoever sets it pages, every other evaluation in the cooldown stays quiet.
    if (jedis.set(key, "1", SetParams.setParams().nx().ex(CooldownS)) == null) return false
    val request = AlertRequest(
      monitorId = monitor.monitorId,
      metric = monitor.metric,
      distance = distance,
      threshold = monitor.threshold,
      windowStart = window,
      windowEnd = window + monitor.windowS,
      sampleCount = sampleCount,
      baselineSampleCount = baselineSampleCount)
    for (attempt <- 0 until MaxAttempts) {
      if (attempt > 0) Thread.sleep(BackoffMs << (attempt - 1))
      try {
        alerting.withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS).raise(request)
        return true
      } catch {
        case e: StatusRuntimeException => System.err.println(s"alert attempt \${attempt + 1} failed monitor=\${monitor.monitorId}: \${e.getStatus.getCode}")
      }
    }
    jedis.del(key) // nobody was paged: release the claim so the next evaluation tries again
    throw new AlertUnavailable(s"alerting did not take the page for $key")
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <iostream>
#include <stdexcept>
#include <string>

#include "drift/store.h"  // store::Monitor
#include "drift_monitor.grpc.pb.h"

auto alerting = driftmon::Alerting::NewStub(grpc::CreateChannel("alerting:9000", grpc::InsecureChannelCredentials()));

// Alerting did not take the page after every attempt: the next evaluation pages again.
struct AlertUnavailable : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// Page for a window whose distance crossed the monitor's threshold; true when this call raised the page.
bool raiseAlert(const store::Monitor& monitor, long window, double distance, long sample_count, long baseline_sample_count) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  driftmon::AlertRequest request;
  request.set_monitor_id(monitor.monitor_id);
  request.set_metric(monitor.metric);
  request.set_distance(distance);
  grpc::ClientContext ctx;
  driftmon::AlertReply reply;
  const grpc::Status status = alerting->Raise(&ctx, request, &reply);
  if (!status.ok()) {
    std::cerr << "alert failed monitor=" << monitor.monitor_id << ": " << status.error_message() << "\\n";
    return false;
  }
  return true;
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <iostream>
#include <stdexcept>
#include <string>
#include <thread>

#include "drift/store.h"  // store::Monitor
#include "drift_monitor.grpc.pb.h"

constexpr int kDeadlineMs = 1000;
constexpr int kCooldownS = 300;
constexpr int kMaxAttempts = 3;
constexpr int kBackoffMs = 200;

sw::redis::Redis redis("tcp://redis:6379");
auto alerting = driftmon::Alerting::NewStub(grpc::CreateChannel("alerting:9000", grpc::InsecureChannelCredentials()));

// Alerting did not take the page after every attempt: the next evaluation pages again.
struct AlertUnavailable : std::runtime_error {
  using std::runtime_error::runtime_error;
};

std::string alertKey(const std::string& monitor_id, long window) { return "alert:" + monitor_id + ":" + std::to_string(window); }

// Page for a window whose distance crossed the monitor's threshold; true when this call raised the page.
bool raiseAlert(const store::Monitor& monitor, long window, double distance, long sample_count, long baseline_sample_count) {
  const std::string key = alertKey(monitor.monitor_id, window);
  // The claim is the decision: whoever sets it pages, every other evaluation in the cooldown stays quiet.
  if (!redis.set(key, "1", std::chrono::seconds(kCooldownS), sw::redis::UpdateType::NOT_EXIST)) return false;
  driftmon::AlertRequest request;
  request.set_monitor_id(monitor.monitor_id);
  request.set_metric(monitor.metric);
  request.set_distance(distance);
  request.set_threshold(monitor.threshold);
  request.set_window_start(window);
  request.set_window_end(window + monitor.window_s);
  request.set_sample_count(sample_count);
  request.set_baseline_sample_count(baseline_sample_count);
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    if (attempt > 0) std::this_thread::sleep_for(std::chrono::milliseconds(kBackoffMs << (attempt - 1)));
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kDeadlineMs));
    driftmon::AlertReply reply;
    const grpc::Status status = alerting->Raise(&ctx, request, &reply);
    if (status.ok()) return true;
    std::cerr << "alert attempt " << attempt + 1 << " failed monitor=" << monitor.monitor_id << ": " << status.error_message() << "\\n";
  }
  redis.del(key);  // nobody was paged: release the claim so the next evaluation tries again
  throw AlertUnavailable("alerting did not take the page for " + key);
}
`,
    },
  },
  harness: {
    python: `import grpc

import drift_monitor_pb2
import drift_monitor_pb2_grpc

MONITOR = {"monitor_id": "m-1", "tenant": "t1", "model_version": "v3", "metric": "input_distribution", "window_s": 300, "baseline": "baseline:v3:2026-10-01", "threshold": 0.2}


class Alerting(drift_monitor_pb2_grpc.AlertingServicer):
    """Takes every page and notes whether alert:m-1:900 was claimed when the page arrived."""

    def __init__(self, ctx):
        self.ctx = ctx
        self.claimed = []

    def Raise(self, request, context):
        self.claimed.append(self.ctx.redis.exists("alert:m-1:900"))
        return drift_monitor_pb2.AlertReply(alert_id=f"a-{len(self.claimed)}")


def _client(ctx):
    alerting = Alerting(ctx)
    ctx.grpc.serve(drift_monitor_pb2_grpc.add_AlertingServicer_to_server, alerting)
    return ctx.load("client"), alerting


def _page(m, window):
    return m.raise_alert(MONITOR, window, 0.31, 640, 5000)


def _unavailable(m, window, why):
    try:
        outcome = _page(m, window)
    except m.AlertUnavailable:
        return
    except Exception as exc:
        raise AssertionError(f"{why}: raise_alert raised {type(exc).__name__}: {exc}, expected AlertUnavailable")
    raise AssertionError(f"{why}: raise_alert returned {outcome!r} instead of raising AlertUnavailable")


def check_deadline(ctx):
    m, _ = _client(ctx)
    assert _page(m, 900) is True, "with alerting healthy the page must go out"
    for call in ctx.grpc.calls_to("Raise"):
        assert call.timeout is not None, "a Raise call carries no deadline: a stalled alerting service would hold the evaluator open"
        assert 0.5 <= call.timeout <= 1.5, f"a Raise call carries a {call.timeout} s deadline, expected DEADLINE_S = 1"
    ctx.grpc.set_latency("Raise", 30.0)
    before = ctx.clock.time()
    _unavailable(m, 1200, "with alerting stalled for 30 s")
    waited = ctx.clock.time() - before
    assert waited <= 5, f"raise_alert spent {waited:.1f} s on a stalled alerting service, expected about 3 attempts of 1 s"


def check_dedupe_cooldown(ctx):
    m, _ = _client(ctx)
    assert _page(m, 900) is True, "the first evaluation of window 900 must page"
    again = _page(m, 900)
    calls = len(ctx.grpc.calls_to("Raise"))
    assert again is False and calls == 1, f"a second evaluation of window 900 returned {again!r} after {calls} Raise calls, expected False and 1 call: one drifting window pages on every evaluator tick"
    ttl = ctx.redis.ttl("alert:m-1:900")
    assert 290 <= ttl <= 300, f"alert:m-1:900 expires in {ttl} s, expected the 300 s cooldown"
    assert _page(m, 1200) is True and len(ctx.grpc.calls_to("Raise")) == 2, "window 1200 is a new window and must page"


def check_claim_before_call(ctx):
    m, alerting = _client(ctx)
    assert _page(m, 900) is True, "with alerting healthy the page must go out"
    assert alerting.claimed == [1], f"alert:m-1:900 was not claimed when each page reached alerting (claimed per call: {alerting.claimed}): a second evaluator seeing window 900 during the call would page too. Claim before calling"


def check_payload_evidence(ctx):
    m, _ = _client(ctx)
    _page(m, 900)
    calls = ctx.grpc.calls_to("Raise")
    assert calls, "no Raise call was made"
    request = calls[0].request
    seen = {name: getattr(request, name) for name in ("monitor_id", "metric", "distance", "threshold", "window_start", "window_end", "sample_count", "baseline_sample_count")}
    want = {"monitor_id": "m-1", "metric": "input_distribution", "distance": 0.31, "threshold": 0.2, "window_start": 900, "window_end": 1200, "sample_count": 640, "baseline_sample_count": 5000}
    assert seen == want, f"the page carries {seen}, expected {want}: without the counts and the window nobody can judge it"


def check_retry_backoff(ctx):
    m, _ = _client(ctx)
    ctx.grpc.fail("Raise", grpc.StatusCode.UNAVAILABLE, "alerting is restarting", times=2)
    paged = _page(m, 900)
    calls = ctx.grpc.calls_to("Raise")
    assert paged is True and len(calls) == 3, f"with two UNAVAILABLE answers raise_alert returned {paged!r} after {len(calls)} calls, expected True after 3: the page that mattered was dropped"
    gaps = [b.started - a.started for a, b in zip(calls, calls[1:])]
    assert gaps[0] > 0 and gaps[1] > gaps[0], f"the retries came {gaps} s apart, expected a growing backoff (0.2 s, then 0.4 s)"
    ctx.grpc.fail("Raise", grpc.StatusCode.UNAVAILABLE, "alerting is down", times=3)
    _unavailable(m, 1200, "with alerting down for every attempt")
    assert ctx.redis.exists("alert:m-1:1200") == 0, "every attempt failed but alert:m-1:1200 is still claimed: the next evaluation will not page for 300 s. Delete the claim"
`,
    typescript: `const MONITOR = {monitor_id: 'm-1', tenant: 't1', model_version: 'v3', metric: 'input_distribution', window_s: 300, baseline: 'baseline:v3:2026-10-01', threshold: 0.2};

/** Alerting takes every page and notes whether alert:m-1:900 was claimed when the page arrived. */
function client(ctx) {
  const pkg = ctx.proto('drift_monitor.proto');
  const claimed: number[] = [];
  ctx.grpc.serve(pkg.driftmon.Alerting.service, {
    Raise(call, callback) {
      claimed.push(ctx.redis.exists('alert:m-1:900'));
      callback(null, {alert_id: \`a-\${claimed.length}\`});
    },
  });
  return {m: ctx.load('client'), claimed};
}

const page = (m, window: number) => m.raiseAlert(MONITOR, window, 0.31, 640, 5000);

async function unavailable(m, window: number, why: string): Promise<void> {
  let outcome;
  try {
    outcome = await page(m, window);
  } catch (e) {
    if (e instanceof m.AlertUnavailable) return;
    assert.fail(\`\${why}: raiseAlert threw \${(e as Error).constructor.name}: \${(e as Error).message}, expected AlertUnavailable\`);
  }
  assert.fail(\`\${why}: raiseAlert returned \${outcome} instead of throwing AlertUnavailable\`);
}

export async function check_deadline(ctx) {
  const {m} = client(ctx);
  assert.equal(await page(m, 900), true, 'with alerting healthy the page must go out');
  for (const call of ctx.grpc.callsTo('Raise')) {
    assert(call.timeout !== null, 'a Raise call carries no deadline: a stalled alerting service would hold the evaluator open');
    assert(call.timeout >= 0.5 && call.timeout <= 1.5, \`a Raise call carries a \${call.timeout} s deadline, expected DEADLINE_MS = 1000\`);
  }
  ctx.grpc.setLatency('Raise', 30.0);
  const before = ctx.clock.now();
  await unavailable(m, 1200, 'with alerting stalled for 30 s');
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 5, \`raiseAlert spent \${waited.toFixed(1)} s on a stalled alerting service, expected about 3 attempts of 1 s\`);
}

export async function check_dedupe_cooldown(ctx) {
  const {m} = client(ctx);
  assert.equal(await page(m, 900), true, 'the first evaluation of window 900 must page');
  const again = await page(m, 900);
  const calls = ctx.grpc.callsTo('Raise').length;
  assert(again === false && calls === 1, \`a second evaluation of window 900 returned \${again} after \${calls} Raise calls, expected false and 1 call: one drifting window pages on every evaluator tick\`);
  const ttl = ctx.redis.ttl('alert:m-1:900');
  assert(ttl >= 290 && ttl <= 300, \`alert:m-1:900 expires in \${ttl} s, expected the 300 s cooldown\`);
  assert((await page(m, 1200)) === true && ctx.grpc.callsTo('Raise').length === 2, 'window 1200 is a new window and must page');
}

export async function check_claim_before_call(ctx) {
  const {m, claimed} = client(ctx);
  assert.equal(await page(m, 900), true, 'with alerting healthy the page must go out');
  assert.deepStrictEqual(claimed, [1], \`alert:m-1:900 was not claimed when each page reached alerting (claimed per call: \${JSON.stringify(claimed)}): a second evaluator seeing window 900 during the call would page too. Claim before calling\`);
}

export async function check_payload_evidence(ctx) {
  const {m} = client(ctx);
  await page(m, 900);
  const calls = ctx.grpc.callsTo('Raise');
  assert(calls.length > 0, 'no Raise call was made');
  const request = calls[0].request;
  const seen = {
    monitor_id: request.monitor_id,
    metric: request.metric,
    distance: Number(request.distance),
    threshold: Number(request.threshold ?? 0),
    window_start: Number(request.window_start ?? 0),
    window_end: Number(request.window_end ?? 0),
    sample_count: Number(request.sample_count ?? 0),
    baseline_sample_count: Number(request.baseline_sample_count ?? 0),
  };
  const want = {monitor_id: 'm-1', metric: 'input_distribution', distance: 0.31, threshold: 0.2, window_start: 900, window_end: 1200, sample_count: 640, baseline_sample_count: 5000};
  assert.deepStrictEqual(seen, want, \`the page carries \${JSON.stringify(seen)}, expected \${JSON.stringify(want)}: without the counts and the window nobody can judge it\`);
}

export async function check_retry_backoff(ctx) {
  const {m} = client(ctx);
  ctx.grpc.fail('Raise', ctx.grpc.status.UNAVAILABLE, 'alerting is restarting', 2);
  const paged = await page(m, 900);
  const calls = ctx.grpc.callsTo('Raise');
  assert(paged === true && calls.length === 3, \`with two UNAVAILABLE answers raiseAlert returned \${paged} after \${calls.length} calls, expected true after 3: the page that mattered was dropped\`);
  const gaps = [calls[1].started - calls[0].started, calls[2].started - calls[1].started];
  assert(gaps[0] > 0 && gaps[1] > gaps[0], \`the retries came \${JSON.stringify(gaps)} ms apart, expected a growing backoff (200 ms, then 400 ms)\`);
  ctx.grpc.fail('Raise', ctx.grpc.status.UNAVAILABLE, 'alerting is down', 3);
  await unavailable(m, 1200, 'with alerting down for every attempt');
  assert.equal(ctx.redis.exists('alert:m-1:1200'), 0, 'every attempt failed but alert:m-1:1200 is still claimed: the next evaluation will not page for 300 s. Delete the claim');
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"time"

	"google.golang.org/grpc/codes"

	pb "drift/gen/drift_monitor"
	"drift/store"

	"leetbuild/harness"
)

var monitor = store.Monitor{MonitorID: "m-1", Tenant: "t1", ModelVersion: "v3", Metric: "input_distribution", WindowS: 300, Baseline: "baseline:v3:2026-10-01", Threshold: 0.2}

// alertingPeer takes every page and notes whether alert:m-1:900 was claimed when the page arrived.
type alertingPeer struct {
	pb.UnimplementedAlertingServer
	ctx     *harness.Ctx
	claimed []int64
}

func (p *alertingPeer) Raise(_ context.Context, _ *pb.AlertRequest) (*pb.AlertReply, error) {
	p.claimed = append(p.claimed, p.ctx.Redis.Exists("alert:m-1:900"))
	return &pb.AlertReply{AlertId: fmt.Sprintf("a-%d", len(p.claimed))}, nil
}

func client(ctx *harness.Ctx) *alertingPeer {
	peer := &alertingPeer{ctx: ctx}
	pb.RegisterAlertingServer(ctx.GRPC.Server(""), peer)
	return peer
}

func page(window int64) (bool, error) {
	return raiseAlert(context.Background(), monitor, window, 0.31, 640, 5000)
}

func paged(ctx *harness.Ctx, window int64, why string) bool {
	ok, err := page(window)
	ctx.NoError(err, "%s: raiseAlert failed", why)
	return ok
}

func unavailable(ctx *harness.Ctx, window int64, why string) {
	ok, err := page(window)
	ctx.Assert(err != nil, "%s: raiseAlert returned %v and no error, expected one wrapping ErrAlertUnavailable", why, ok)
	ctx.ErrorIs(err, ErrAlertUnavailable, "%s: raiseAlert returned %v", why, err)
}

func CheckDeadline(ctx *harness.Ctx) {
	client(ctx)
	ctx.Equal(paged(ctx, 900, "with alerting healthy"), true, "with alerting healthy the page must go out; paged")
	for _, call := range ctx.GRPC.CallsTo("Raise", "") {
		ctx.Assert(call.HasDeadline(), "a Raise call carries no deadline: a stalled alerting service would hold the evaluator open")
		ctx.Assert(call.Timeout >= 500*time.Millisecond && call.Timeout <= 1500*time.Millisecond, "a Raise call carries a %v deadline, expected 1 s", call.Timeout)
	}
	ctx.GRPC.SetLatency("Raise", 30.0, "")
	before := ctx.Clock.Now()
	unavailable(ctx, 1200, "with alerting stalled for 30 s")
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 5, "raiseAlert spent %.1f s on a stalled alerting service, expected about 3 attempts of 1 s", waited)
}

func CheckDedupeCooldown(ctx *harness.Ctx) {
	client(ctx)
	ctx.Equal(paged(ctx, 900, "the first evaluation"), true, "the first evaluation of window 900 must page; paged")
	again := paged(ctx, 900, "the second evaluation")
	calls := len(ctx.GRPC.CallsTo("Raise", ""))
	ctx.Assert(!again && calls == 1, "a second evaluation of window 900 returned %v after %d Raise calls, expected false and 1 call: one drifting window pages on every evaluator tick", again, calls)
	ttl := ctx.Redis.TTL("alert:m-1:900")
	ctx.Assert(ttl >= 290 && ttl <= 300, "alert:m-1:900 expires in %d s, expected the 300 s cooldown", ttl)
	ctx.Assert(paged(ctx, 1200, "window 1200") && len(ctx.GRPC.CallsTo("Raise", "")) == 2, "window 1200 is a new window and must page")
}

func CheckClaimBeforeCall(ctx *harness.Ctx) {
	peer := client(ctx)
	ctx.Equal(paged(ctx, 900, "with alerting healthy"), true, "with alerting healthy the page must go out; paged")
	ctx.Equal(peer.claimed, []int64{1}, "when the page reached alerting, alert:m-1:900 must exist (a second evaluator seeing window 900 during the call would page too; claim before calling); claimed at each call")
}

func CheckPayloadEvidence(ctx *harness.Ctx) {
	client(ctx)
	page(900)
	calls := ctx.GRPC.CallsTo("Raise", "")
	ctx.Assert(len(calls) > 0, "no Raise call was made")
	r := calls[0].Request.(*pb.AlertRequest)
	seen := map[string]any{"monitor_id": r.GetMonitorId(), "metric": r.GetMetric(), "distance": r.GetDistance(), "threshold": r.GetThreshold(), "window_start": r.GetWindowStart(), "window_end": r.GetWindowEnd(), "sample_count": r.GetSampleCount(), "baseline_sample_count": r.GetBaselineSampleCount()}
	want := map[string]any{"monitor_id": "m-1", "metric": "input_distribution", "distance": 0.31, "threshold": 0.2, "window_start": 900, "window_end": 1200, "sample_count": 640, "baseline_sample_count": 5000}
	ctx.Equal(seen, want, "the page must carry the counts and the window, or nobody can judge it")
}

func CheckRetryBackoff(ctx *harness.Ctx) {
	client(ctx)
	ctx.GRPC.Fail("Raise", codes.Unavailable, "alerting is restarting", 2, "")
	ok := paged(ctx, 900, "with two UNAVAILABLE answers")
	calls := ctx.GRPC.CallsTo("Raise", "")
	ctx.Assert(ok && len(calls) == 3, "with two UNAVAILABLE answers raiseAlert returned %v after %d calls, expected true after 3: the page that mattered was dropped", ok, len(calls))
	first, second := calls[1].Started.Sub(calls[0].Started), calls[2].Started.Sub(calls[1].Started)
	ctx.Assert(first > 0 && second > first, "the retries came %v and %v apart, expected a growing backoff (200 ms, then 400 ms)", first, second)
	ctx.GRPC.Fail("Raise", codes.Unavailable, "alerting is down", 3, "")
	unavailable(ctx, 1200, "with alerting down for every attempt")
	ctx.Equal(ctx.Redis.Exists("alert:m-1:1200"), 0, "every attempt failed, so alert:m-1:1200 must be released (or the next evaluation will not page for 300 s); exists")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <chrono>
#include <string>
#include <vector>

#include "drift/store.h"
#include "drift_monitor.grpc.pb.h"

namespace {

const store::Monitor kMonitor{"m-1", "t1", "v3", "input_distribution", 300, "baseline:v3:2026-10-01", 0.2};

// Takes every page and notes whether alert:m-1:900 was claimed when the page arrived.
class AlertingPeer final : public driftmon::Alerting::Service {
 public:
  harness::Ctx* ctx = nullptr;
  std::vector<long long> claimed;
  grpc::Status Raise(grpc::ServerContext*, const driftmon::AlertRequest*, driftmon::AlertReply* out) override {
    claimed.push_back(ctx->Redis.Exists("alert:m-1:900"));
    out->set_alert_id("a-" + std::to_string(claimed.size()));
    return grpc::Status::OK;
  }
};

AlertingPeer& client(harness::Ctx& ctx) {
  static AlertingPeer* peer = nullptr;
  delete peer;
  peer = new AlertingPeer;
  peer->ctx = &ctx;
  ctx.GRPC.Server("")->RegisterService(peer);
  return *peer;
}

bool paged(harness::Ctx& ctx, long window, const std::string& why) {
  try {
    return raiseAlert(kMonitor, window, 0.31, 640, 5000);
  } catch (const std::exception& e) {
    ctx.Fatalf("%s: raiseAlert threw %s: %s", why, harness::CurrentExceptionType(), e.what());
  }
}

void unavailable(harness::Ctx& ctx, long window, const std::string& why) {
  bool outcome = false;
  try {
    outcome = raiseAlert(kMonitor, window, 0.31, 640, 5000);
  } catch (const AlertUnavailable&) {
    return;
  } catch (const std::exception& e) {
    ctx.Fatalf("%s: raiseAlert threw %s: %s, expected AlertUnavailable", why, harness::CurrentExceptionType(), e.what());
  }
  ctx.Fatalf("%s: raiseAlert returned %t instead of throwing AlertUnavailable", why, outcome);
}

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  client(ctx);
  ctx.Equal(paged(ctx, 900, "with alerting healthy"), true, "with alerting healthy the page must go out; paged");
  for (const auto& call : ctx.GRPC.CallsTo("Raise")) {
    ctx.Assert(call.HasDeadline(), "a Raise call carries no deadline: a stalled alerting service would hold the evaluator open");
    ctx.Assert(call.TimeoutSeconds() >= 0.5 && call.TimeoutSeconds() <= 1.5, "a Raise call carries a %v s deadline, expected kDeadlineMs = 1000", call.TimeoutSeconds());
  }
  ctx.GRPC.SetLatency("Raise", 30.0);
  const int64_t before = ctx.Clock.Now();
  unavailable(ctx, 1200, "with alerting stalled for 30 s");
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 5, "raiseAlert spent %.1f s on a stalled alerting service, expected about 3 attempts of 1 s", waited);
}

void CheckDedupeCooldown(harness::Ctx& ctx) {
  client(ctx);
  ctx.Equal(paged(ctx, 900, "the first evaluation"), true, "the first evaluation of window 900 must page; paged");
  const bool again = paged(ctx, 900, "the second evaluation");
  const size_t calls = ctx.GRPC.CallsTo("Raise").size();
  ctx.Assert(!again && calls == 1, "a second evaluation of window 900 returned %t after %d Raise calls, expected false and 1 call: one drifting window pages on every evaluator tick", again, calls);
  const long long ttl = ctx.Redis.TTL("alert:m-1:900");
  ctx.Assert(ttl >= 290 && ttl <= 300, "alert:m-1:900 expires in %d s, expected the 300 s cooldown", ttl);
  ctx.Assert(paged(ctx, 1200, "window 1200") && ctx.GRPC.CallsTo("Raise").size() == 2, "window 1200 is a new window and must page");
}

void CheckClaimBeforeCall(harness::Ctx& ctx) {
  AlertingPeer& peer = client(ctx);
  ctx.Equal(paged(ctx, 900, "with alerting healthy"), true, "with alerting healthy the page must go out; paged");
  ctx.Equal(peer.claimed, std::vector<long long>{1}, "when the page reached alerting, alert:m-1:900 must exist (a second evaluator seeing window 900 during the call would page too; claim before calling); claimed at each call");
}

void CheckPayloadEvidence(harness::Ctx& ctx) {
  client(ctx);
  try {
    raiseAlert(kMonitor, 900, 0.31, 640, 5000);
  } catch (const std::exception&) {
  }
  const auto calls = ctx.GRPC.CallsTo("Raise");
  ctx.Assert(!calls.empty(), "no Raise call was made");
  const auto& r = calls[0].Request<driftmon::AlertRequest>();
  const nlohmann::json seen = {{"monitor_id", r.monitor_id()}, {"metric", r.metric()}, {"distance", r.distance()}, {"threshold", r.threshold()},
                               {"window_start", r.window_start()}, {"window_end", r.window_end()}, {"sample_count", r.sample_count()},
                               {"baseline_sample_count", r.baseline_sample_count()}};
  const nlohmann::json want = {{"monitor_id", "m-1"}, {"metric", "input_distribution"}, {"distance", 0.31}, {"threshold", 0.2},
                               {"window_start", 900}, {"window_end", 1200}, {"sample_count", 640}, {"baseline_sample_count", 5000}};
  ctx.Equal(seen, want, "the page must carry the counts and the window, or nobody can judge it");
}

void CheckRetryBackoff(harness::Ctx& ctx) {
  client(ctx);
  ctx.GRPC.Fail("Raise", grpc::StatusCode::UNAVAILABLE, "alerting is restarting", 2);
  const bool ok = paged(ctx, 900, "with two UNAVAILABLE answers");
  const auto calls = ctx.GRPC.CallsTo("Raise");
  ctx.Assert(ok && calls.size() == 3, "with two UNAVAILABLE answers raiseAlert returned %t after %d calls, expected true after 3: the page that mattered was dropped", ok, calls.size());
  const double first = std::chrono::duration<double>(calls[1].Started - calls[0].Started).count();
  const double second = std::chrono::duration<double>(calls[2].Started - calls[1].Started).count();
  ctx.Assert(first > 0 && second > first, "the retries came %v s and %v s apart, expected a growing backoff (0.2 s, then 0.4 s)", first, second);
  ctx.GRPC.Fail("Raise", grpc::StatusCode::UNAVAILABLE, "alerting is down", 3);
  unavailable(ctx, 1200, "with alerting down for every attempt");
  ctx.Equal(ctx.Redis.Exists("alert:m-1:1200"), 0, "every attempt failed, so alert:m-1:1200 must be released (or the next evaluation will not page for 300 s); exists");
}
`,
  },
  hints: [
    'Evaluate one drifting window on three ticks: three pages arrive, and none says how many samples it rests on. Stall alerting and the evaluator waits with it; fail one call and the page is gone.',
    'Nothing records that window 900 already paged, so every tick calls `Raise`. The call has no deadline, carries only the distance, and its one `except` returns `False` and forgets the page.',
    'Claim `alert:{monitor_id}:{window}` with `SET NX EX COOLDOWN_S` first and return `False` when it exists; send the full evidence with `timeout=DEADLINE_S`; retry `MAX_ATTEMPTS` times sleeping `BACKOFF_S * 2**n`; then delete the claim and raise `AlertUnavailable`.',
  ],
  debrief: `The claim goes before the call because it is the decision, not a record of it: a set-if-absent lets exactly one evaluator own the page, and the cooldown bounds how often a window that keeps drifting can page again. Releasing the claim after the last failed attempt keeps that ownership honest, since a claim nobody acted on would silence the next evaluation for five minutes. The deadline caps one attempt and the backoff spaces the attempts, so a dead alerting service costs the evaluator about three seconds. The counts and both window boundaries travel with the page because a distance alone cannot be judged. Production alerting adds a stable dedup key on the alerting side too, so a retried Raise that did land is not shown twice.`,
};
