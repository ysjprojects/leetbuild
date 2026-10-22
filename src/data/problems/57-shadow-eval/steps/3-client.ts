import type {Step} from '@/lib/types';

export const shadowClientStep: Step = {
  id: 'dependency',
  title: 'Candidate calls that can never block production',
  concept: 'grpc',
  file: 'client',
  focus: ['shadow', 'candidate', 'prodmodel'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it calls the candidate and
handles failures. It compiles and the demo returns. What it does to the production request when the
candidate is slow, or retries without limit, is the flaw. Review it, fix it, and prove the fix.

Implement the client that the request path uses to run a shadow beside production.

- The candidate is called over **gRPC** with a hard **300 ms deadline** per call. A candidate that
  hangs must be abandoned at the deadline, not waited on.
- There is a **hard concurrency cap per instance** (\`MAX_SHADOW_INFLIGHT\`). The caller tries to
  take a slot **without blocking**; when the cap is reached the shadow is **dropped**, never queued —
  queueing converts a candidate outage into unbounded latency and memory.
- Every dropped shadow increments a **dropped counter** (\`shadow.dropped\`), so an overloaded
  candidate is observable instead of silent.
- **Retries are disabled**: exactly one attempt per shadow (\`SHADOW_MAX_ATTEMPTS = 1\`). Retrying a
  shadow adds load proportional to the outage and can outlive the traffic window.
- The shadow is dispatched **off the request path** (a background task, \`setImmediate\`, a
  goroutine, a \`Future\`, a detached thread). The production response is written without waiting for
  the candidate, so an unresponsive candidate adds **zero** latency to it.

**Failure mode the checks target.** The draft runs the candidate call inline on the request thread
with **no deadline**, so an unresponsive candidate doubles production latency; it has no concurrency
cap, so a burst of shadow traffic amplifies the outage; it has no dropped counter, so the overload is
invisible; and it **retries** every failure, multiplying the load exactly when the candidate is
already down.`,
  sequence: {
    participants: ['Client', 'Shadow Service', 'Candidate model'],
    messages: [
      {from: 'Client', to: 'Shadow Service', label: 'POST /v1/... · production request', kind: 'sync'},
      {from: 'Shadow Service', to: 'Shadow Service', label: 'tryAcquire shadow slot (non-blocking)', kind: 'sync'},
      {from: 'Shadow Service', to: 'Shadow Service', label: 'cap reached → shadow.dropped', kind: 'async'},
      {from: 'Shadow Service', to: 'Candidate model', label: 'Complete · deadline 300 ms · 1 attempt', kind: 'sync'},
      {from: 'Candidate model', to: 'Shadow Service', label: 'reply / DEADLINE_EXCEEDED (dropped)', kind: 'reply'},
      {from: 'Shadow Service', to: 'Client', label: '200 production response · never waits', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Calls the candidate with a 300 ms deadline',
      detail:
        'Every candidate call carries a 300 ms deadline. The draft calls the candidate with no deadline, so one unresponsive candidate blocks the production request until gRPC gives up on its own.',
      match: {
        python: {all: [/SHADOW_DEADLINE_MS\s*=\s*300/, /timeout=/]},
        typescript: {all: [/SHADOW_DEADLINE_MS\s*=\s*300/, /\bdeadline\b/]},
        go: {all: [/shadowDeadlineMs\s*=\s*300/, /WithTimeout/]},
        scala: {all: [/ShadowDeadlineMs\s*=\s*300/, /deadline/]},
        cpp: {all: [/kShadowDeadlineMs\s*=\s*300/, /deadline/]},
      },
    },
    {
      id: 'inflight',
      title: 'Hard per-instance concurrency cap, admitted without blocking',
      detail:
        'At most `MAX_SHADOW_INFLIGHT` candidate calls run at once, and a full cap drops the shadow instead of waiting. The draft has no cap, so a burst of shadow traffic multiplies the load on a struggling candidate.',
      match: {
        python: {all: [/MAX_SHADOW_INFLIGHT/, /self\.inflight\s*>=/]},
        typescript: {all: [/MAX_SHADOW_INFLIGHT/, /inflight\s*>=/]},
        go: {all: [/maxShadowInflight/, /default:/]},
        scala: {all: [/MaxShadowInflight/, /compareAndSet/]},
        cpp: {all: [/kMaxShadowInflight/, /fetch_add/]},
      },
    },
    {
      id: 'dropped',
      title: 'Counts dropped shadows',
      detail:
        'An overloaded or timed-out shadow increments the `shadow.dropped` counter, so the overload is observable. The draft drops nothing and counts nothing, so the failure is silent.',
      match: {
        python: {all: [/DROPPED_METRIC/, /shadow\.dropped/]},
        typescript: {all: [/DROPPED_METRIC/, /shadow\.dropped/]},
        go: {all: [/droppedMetric/, /shadow\.dropped/]},
        scala: {all: [/DroppedMetric/, /shadow\.dropped/]},
        cpp: {all: [/kDroppedMetric/, /shadow\.dropped/]},
      },
    },
    {
      id: 'off-path',
      title: 'Runs the shadow off the request path',
      detail:
        'The shadow is dispatched so the production response never waits for the candidate (`asyncio.create_task`, `setImmediate`, a goroutine, a `Future`, a detached thread). The draft awaits the candidate inline.',
      match: {
        python: {all: [/asyncio\.create_task\(/]},
        typescript: {all: [/setImmediate\(/]},
        go: {all: [/\bgo s\.observe\(/]},
        scala: {all: [/Future\s*\{/]},
        cpp: {all: [/std::thread\(/]},
      },
    },
    {
      id: 'no-retry',
      title: 'Disables retries on the shadow path',
      detail:
        'A shadow is attempted exactly once (`SHADOW_MAX_ATTEMPTS = 1`). The draft retries every failure, so a candidate outage multiplies the load against the candidate exactly when it can least take it.',
      match: {
        python: {all: [/SHADOW_MAX_ATTEMPTS\s*=\s*1/]},
        typescript: {all: [/SHADOW_MAX_ATTEMPTS\s*=\s*1/]},
        go: {all: [/shadowMaxAttempts\s*=\s*1/]},
        scala: {all: [/ShadowMaxAttempts\s*=\s*1/]},
        cpp: {all: [/kShadowMaxAttempts\s*=\s*1/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

logger = logging.getLogger("shadow.client")

CANDIDATE_RETRIES = 3


class ShadowClient:
    def __init__(self, channel):
        self.channel = channel

    async def observe(self, config_id: str, request) -> None:
        # TODO: the draft calls the candidate inline on the request thread, with no deadline, no
        # concurrency cap and no dropped counter, and it retries every failure. A stuck candidate
        # doubles production latency. Review all four.
        for _ in range(CANDIDATE_RETRIES):
            try:
                await self.channel.Complete(request)
                return
            except Exception:
                continue
        logger.warning("shadow.candidate_failed config=%s", config_id)


def observe_inline(client: ShadowClient, config_id: str, request) -> None:
    return client.observe(config_id, request)
`,
      solution: `import asyncio
import logging

logger = logging.getLogger("shadow.client")

SHADOW_DEADLINE_MS = 300
MAX_SHADOW_INFLIGHT = 8
SHADOW_MAX_ATTEMPTS = 1
DROPPED_METRIC = "shadow.dropped"


class ShadowClient:
    """Calls the candidate beside production: bounded, never blocking, never retrying."""

    def __init__(self, channel, dropped):
        self.channel = channel
        self.dropped = dropped
        self.inflight = 0
        self.gate = asyncio.Lock()

    async def observe(self, config_id: str, request) -> None:
        # Overload is dropped and counted, never queued: check the cap without waiting.
        async with self.gate:
            if self.inflight >= MAX_SHADOW_INFLIGHT:
                self.dropped.inc(DROPPED_METRIC, 1)
                return
            self.inflight += 1
        try:
            # One attempt with one deadline: a retry would add load proportional to the outage.
            for _ in range(SHADOW_MAX_ATTEMPTS):
                try:
                    await self.channel.Complete(request, timeout=SHADOW_DEADLINE_MS / 1000)
                except Exception as exc:
                    logger.warning("shadow.candidate_failed config=%s err=%s", config_id, exc)
        finally:
            async with self.gate:
                self.inflight -= 1


def schedule_shadow(client: ShadowClient, config_id: str, request) -> None:
    """Fire the shadow beside the request thread; the production response never waits for it."""
    asyncio.create_task(client.observe(config_id, request))
`,
    },
    typescript: {
      starter: `/** Candidate calls: a model-generated draft that awaits the candidate inline. */
import * as grpc from '@grpc/grpc-js';

const CANDIDATE_RETRIES = 3;

interface CandidateStub {
  Complete(request: unknown, options: grpc.CallOptions, callback: (error: grpc.ServiceError | null) => void): void;
}

export class ShadowClient {
  constructor(private readonly client: CandidateStub) {}

  async observe(configId: string, request: unknown): Promise<void> {
    // TODO: the draft calls the candidate inline on the request thread, with no deadline, no
    // concurrency cap and no dropped counter, and it retries every failure. A stuck candidate
    // doubles production latency. Review all four.
    for (let attempt = 0; attempt < CANDIDATE_RETRIES; attempt += 1) {
      try {
        await this.call(configId, request);
        return;
      } catch {
        continue;
      }
    }
    console.warn('shadow.candidate_failed', configId);
  }

  private call(configId: string, request: unknown): Promise<unknown> {
    const {promise, resolve, reject} = Promise.withResolvers<unknown>();
    this.client.Complete(request, {}, (error: grpc.ServiceError | null) =>
      error === null ? resolve(null) : reject(error),
    );
    return promise;
  }
}

export async function observeInline(client: ShadowClient, configId: string, request: unknown): Promise<void> {
  await client.observe(configId, request);
}
`,
      solution: `/** Candidate calls: bounded, off the request path, and never retried. */
import * as grpc from '@grpc/grpc-js';

export const SHADOW_DEADLINE_MS = 300;
export const MAX_SHADOW_INFLIGHT = 8;
export const SHADOW_MAX_ATTEMPTS = 1;
export const DROPPED_METRIC = 'shadow.dropped';

interface Counter {
  inc(name: string, value: number): void;
}

interface CandidateStub {
  Complete(request: unknown, options: grpc.CallOptions, callback: (error: grpc.ServiceError | null) => void): void;
}

export class ShadowClient {
  private inflight = 0;

  constructor(
    private readonly client: CandidateStub,
    private readonly dropped: Counter,
  ) {}

  async observe(configId: string, request: unknown): Promise<void> {
    // Overload is dropped and counted, never queued: check the cap without waiting.
    if (this.inflight >= MAX_SHADOW_INFLIGHT) {
      this.dropped.inc(DROPPED_METRIC, 1);
      return;
    }
    this.inflight += 1;
    try {
      const deadline = new Date(Date.now() + SHADOW_DEADLINE_MS);
      // One attempt with one deadline: a retry would add load proportional to the outage.
      for (let attempt = 0; attempt < SHADOW_MAX_ATTEMPTS; attempt += 1) await this.call(configId, request, deadline);
    } finally {
      this.inflight -= 1;
    }
  }

  private call(configId: string, request: unknown, deadline: Date): Promise<unknown> {
    const {promise, resolve} = Promise.withResolvers<unknown>();
    this.client.Complete(request, {deadline}, (error: grpc.ServiceError | null) => {
      if (error !== null) console.warn('shadow.candidate_failed', configId, error.message);
      resolve(null);
    });
    return promise;
  }
}

/** Fire the shadow beside the request; the production response never waits for it. */
export function scheduleShadow(client: ShadowClient, configId: string, request: unknown): void {
  setImmediate(() => void client.observe(configId, request));
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"log"
)

const candidateRetries = 3

type ShadowClient struct {
	client pb.CandidateClient
}

func NewShadowClient(client pb.CandidateClient) *ShadowClient {
	return &ShadowClient{client: client}
}

func (s *ShadowClient) observe(configID string, request *pb.Request) {
	// TODO: the draft calls the candidate inline on the request thread, with no deadline, no
	// concurrency cap and no dropped counter, and it retries every failure. A stuck candidate
	// doubles production latency. Review all four.
	for attempt := 0; attempt < candidateRetries; attempt++ {
		if _, err := s.client.Complete(context.Background(), request); err == nil {
			return
		}
	}
	log.Printf("shadow.candidate_failed config=%s", configID)
}

func (s *ShadowClient) observeInline(configID string, request *pb.Request) {
	s.observe(configID, request)
}
`,
      solution: `package main

import (
	"context"
	"log"
	"time"

	pb "example.com/shadow/candidatepb"
)

const (
	shadowDeadlineMs  = 300
	maxShadowInflight = 8
	shadowMaxAttempts = 1
	droppedMetric     = "shadow.dropped"
)

type Counter interface {
	Inc(name string)
}

type ShadowClient struct {
	client  pb.CandidateClient
	dropped Counter
	gate    chan struct{}
}

func NewShadowClient(client pb.CandidateClient, dropped Counter) *ShadowClient {
	return &ShadowClient{client: client, dropped: dropped, gate: make(chan struct{}, maxShadowInflight)}
}

func (s *ShadowClient) observe(configID string, request *pb.Request) {
	// Overload is dropped and counted, never queued: a non-blocking send to the semaphore.
	select {
	case s.gate <- struct{}{}:
	default:
		s.dropped.Inc(droppedMetric)
		return
	}
	defer func() { <-s.gate }()
	// One attempt with one deadline: a retry would add load proportional to the outage.
	for attempt := 0; attempt < shadowMaxAttempts; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), shadowDeadlineMs*time.Millisecond)
		_, err := s.client.Complete(ctx, request)
		cancel()
		if err != nil {
			log.Printf("shadow.candidate_failed config=%s err=%v", configID, err)
		}
	}
}

// scheduleShadow fires the shadow beside the request; production never waits for it.
func (s *ShadowClient) scheduleShadow(configID string, request *pb.Request) {
	go s.observe(configID, request)
}
`,
    },
    scala: {
      starter: `final class ShadowClient(channel: CandidateGrpc.Channel) {
  private val candidateRetries = 3

  def observe(configId: String, request: Request): Unit = {
    // TODO: the draft calls the candidate inline on the request thread, with no deadline, no
    // concurrency cap and no dropped counter, and it retries every failure. A stuck candidate
    // doubles production latency. Review all four.
    var attempt = 0
    while (attempt < candidateRetries) {
      try {
        channel.complete(request)
        return
      } catch {
        case error: Throwable => println(s"shadow.candidate_failed config=$configId err=$error")
      }
      attempt += 1
    }
  }

  def observeInline(configId: String, request: Request): Unit = observe(configId, request)
}
`,
      solution: `import java.util.concurrent.atomic.AtomicInteger

import scala.concurrent.{ExecutionContext, Future}

object ShadowClient {
  val ShadowDeadlineMs = 300
  val MaxShadowInflight = 8
  val ShadowMaxAttempts = 1
  val DroppedMetric = "shadow.dropped"
}

final class ShadowClient(channel: CandidateGrpc.Channel, dropped: Counter)(implicit ec: ExecutionContext) {
  import ShadowClient._

  private val inflight = new AtomicInteger(0)

  def observe(configId: String, request: Request): Unit = {
    // Overload is dropped and counted, never queued: a CAS that fails drops the call.
    val current = inflight.get()
    if (current >= MaxShadowInflight || !inflight.compareAndSet(current, current + 1)) {
      dropped.inc(DroppedMetric)
      return
    }
    // Fire the shadow beside the request; production never waits for it.
    Future {
      try {
        // One attempt with one deadline: a retry would add load proportional to the outage.
        for (_ <- 0 until ShadowMaxAttempts) {
          try {
            val deadline = System.currentTimeMillis() + ShadowDeadlineMs
            channel.complete(request, deadline)
          } catch {
            case error: Throwable => println(s"shadow.candidate_failed config=$configId err=$error")
          }
        }
      } finally {
        inflight.decrementAndGet()
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <iostream>
#include <memory>
#include <string>

constexpr int kCandidateRetries = 3;

class ShadowClient {
 public:
  explicit ShadowClient(std::shared_ptr<grpc::Channel> channel)
      : stub_(Candidate::NewStub(channel)) {}

  void observe(const std::string& configId, const Request& request) {
    // TODO: the draft calls the candidate inline on the request thread, with no deadline, no
    // concurrency cap and no dropped counter, and it retries every failure. A stuck candidate
    // doubles production latency. Review all four.
    for (int attempt = 0; attempt < kCandidateRetries; ++attempt) {
      grpc::ClientContext context;
      Response response;
      if (stub_->Complete(&context, request, &response).ok()) return;
    }
    std::cerr << "shadow.candidate_failed config=" << configId << "\\n";
  }

  void observeInline(const std::string& configId, const Request& request) { observe(configId, request); }

 private:
  std::unique_ptr<Candidate::Stub> stub_;
};
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <atomic>
#include <chrono>
#include <iostream>
#include <memory>
#include <string>
#include <thread>

constexpr int kShadowDeadlineMs = 300;
constexpr int kMaxShadowInflight = 8;
constexpr int kShadowMaxAttempts = 1;
const char* const kDroppedMetric = "shadow.dropped";

class ShadowClient {
 public:
  ShadowClient(std::shared_ptr<grpc::Channel> channel, Counter& dropped)
      : stub_(Candidate::NewStub(channel)), dropped_(dropped) {}

  void observe(const std::string& configId, const Request& request) {
    // Overload is dropped and counted, never queued: try to take one of the fixed slots.
    const int used = inflight_.fetch_add(1);
    if (used >= kMaxShadowInflight) {
      inflight_.fetch_sub(1);
      dropped_.inc(kDroppedMetric);
      return;
    }
    // One attempt with one deadline: a retry would add load proportional to the outage.
    for (int attempt = 0; attempt < kShadowMaxAttempts; ++attempt) {
      grpc::ClientContext context;
      context.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kShadowDeadlineMs));
      Response response;
      const auto status = stub_->Complete(&context, request, &response);
      if (!status.ok())
        std::cerr << "shadow.candidate_failed config=" << configId << " err=" << status.error_message() << "\\n";
    }
    inflight_.fetch_sub(1);
  }

  // Fire the shadow beside the request; production never waits for it.
  void scheduleShadow(const std::string& configId, const Request& request) {
    std::thread([this, configId, request] { observe(configId, request); }).detach();
  }

 private:
  std::unique_ptr<Candidate::Stub> stub_;
  Counter& dropped_;
  std::atomic<int> inflight_{0};
};
`,
    },
  },
  hints: [
    'The deadline is not optional: `timeout=0.3` (Python), a `deadline` option (Node), `context.WithTimeout` (Go), an explicit deadline (Scala), `set_deadline` (C++). Without it a hung candidate holds the production request until the transport gives up.',
    'The cap is a semaphore you try to take, not one you wait on. Python `acquire_nowait`, Go `select` with `default:`, Scala `compareAndSet`, C++ `fetch_add` — all let you drop instead of queue, and all let you count the drop.',
    'Dispatch, do not await. The shadow belongs in a background task (`asyncio.create_task`), a `setImmediate`, a goroutine, a `Future` or a detached thread, so the production response is written without ever observing candidate latency.',
  ],
  debrief: `The interviewer is testing one number: how much latency a candidate can add to a production request. The correct answer is zero, and it comes from four decisions, not one. First, the deadline bounds a single call so a hung candidate cannot hold the request. Second, the in-flight cap with a non-blocking acquire bounds the *number* of concurrent shadows, so a burst cannot amplify the load. Third, the drop counter makes the resulting overload visible instead of silent. Fourth, dispatching off the request path means the response is written before the candidate is even called. The retry is the subtle one: retrying a shadow looks like robustness, but it adds load proportional to the outage and can outlive the traffic window — on the shadow path, one attempt is the whole policy. Real runners add an adaptive share that shrinks when the drop rate rises.`,
};
