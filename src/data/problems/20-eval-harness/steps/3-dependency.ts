import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Scorer calls with a deadline and a cost cap',
  concept: 'grpc',
  file: 'client',
  focus: ['harness', 'judge', 'fallback'],
  task: `## Task

The starter is a plausible model-generated draft: while the judge is healthy every sample gets a
score and the dashboard moves. Every failure path is wrong. Find them, fix them, and prove the fix.

Implement \`score_sample(sample)\`, the judge call the workers make for one golden sample:

- Each attempt carries an **800 ms** deadline. A call without one lets one slow judge pin a worker
  for the whole run.
- At most **3 attempts**, and only \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` are retryable. A
  malformed sample — \`INVALID_ARGUMENT\` — is returned to the caller immediately: retrying it three
  times wastes the budget and still fails.
- When the attempts are exhausted, the sample is scored by the **deterministic string metric**
  (\`fallbackExactMatch\`: 1.0 when the output matches the label, 0.0 otherwise) instead of failing
  the run. A judge outage must degrade the score, not lose the sample.
- A **circuit breaker** opens after **5** retryable failures and stays open for **30 s**; while it
  is open, skip the judge and go straight to the fallback.
- The fallback result is marked as such in the run record, so a report built mostly from fallbacks
  can be rejected later.

**Failure mode the checks target.** The draft catches every error and loops forever: a permanent
\`INVALID_ARGUMENT\` spins the worker, a judge deployment gone bad becomes a hot loop against the
service that is already down, and there is no fallback at all, so every sample of the run fails with
it. Each of those is silent in a demo and loud during a release eval.`,
  sequence: {
    participants: ['Eval worker', 'Judge model', 'String metric'],
    messages: [
      {from: 'Eval worker', to: 'Eval worker', label: 'breaker.allow() · open → fallback', kind: 'sync'},
      {from: 'Eval worker', to: 'Judge model', label: 'Score · deadline 800 ms · attempt ≤ 3', kind: 'sync'},
      {from: 'Judge model', to: 'Eval worker', label: 'score / UNAVAILABLE / INVALID_ARGUMENT', kind: 'reply'},
      {from: 'Eval worker', to: 'Eval worker', label: 'retry only UNAVAILABLE / DEADLINE_EXCEEDED', kind: 'sync'},
      {from: 'Eval worker', to: 'String metric', label: 'fallbackExactMatch(input, expected)', kind: 'sync'},
      {from: 'String metric', to: 'Eval worker', label: '1.0 / 0.0', kind: 'reply'},
      {
        from: 'Eval worker',
        to: 'Eval worker',
        label: 'fallback result marked so the report can reject a fallback-heavy run',
        kind: 'sync',
      },
    ],
  },
  hints: [
    'The deadline belongs on the call itself — `timeout=`, `deadline:`, `WithTimeout`, `withDeadlineAfter`, `set_deadline` — not around it. Bound the attempts with a constant and a counted loop; the draft’s `while True` has no exit for a permanent error like `INVALID_ARGUMENT`.',
    'Retryability is a property of the status, not of “it threw”: capture the error, compare its code, and return anything outside `UNAVAILABLE` / `DEADLINE_EXCEEDED` at once. A malformed sample will never succeed on the third try, so those two retries are pure spend.',
    'The breaker is a failure counter per dependency: record only retryable failures, check `allow()` before each attempt, and open it for 30 s after five. When it is open — or the attempts run out — call the deterministic metric, so the run finishes with a real, reproducible number instead of an outage.',
  ],
  checks: [
    {
      id: 'deadline',
      title: 'Every attempt carries an 800 ms deadline',
      detail:
        'The call is created with an 800 ms deadline — a call timeout, a context with timeout, `withDeadlineAfter`, `set_deadline` or `deadline: Date.now() + DEADLINE_MS`. Without it one stuck judge holds the worker open until the run is abandoned.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*0\.8/, /timeout=DEADLINE_S/, /\.Score\(/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*800/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/, /\.Score\(/]},
        go: {all: [/deadlineMS\s*=\s*800/, /context\.WithTimeout|context\.WithDeadline/, /\.Score\(/]},
        scala: {all: [/DeadlineMs\s*=\s*800/, /withDeadlineAfter/, /\.score\(/]},
        cpp: {all: [/kDeadlineMs\s*=\s*800/, /set_deadline\(/, /->Score\(/]},
      },
    },
    {
      id: 'retry-policy',
      title: 'At most three attempts, only the two retryable codes',
      detail:
        'Attempts are bounded by `MAX_ATTEMPTS = 3` and only `UNAVAILABLE` and `DEADLINE_EXCEEDED` are retried; there is no unbounded retry loop. The draft retries every error forever.',
      match: {
        python: {
          all: [
            /MAX_ATTEMPTS\s*=\s*3/,
            /range\(MAX_ATTEMPTS\)/,
            /StatusCode\.UNAVAILABLE/,
            /StatusCode\.DEADLINE_EXCEEDED/,
          ],
          none: [/while\s+True/],
        },
        typescript: {
          all: [/MAX_ATTEMPTS\s*=\s*3/, /attempt\s*<\s*MAX_ATTEMPTS/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/],
          none: [/while\s*\(\s*true\s*\)/, /for\s*\(\s*;\s*;\s*\)/],
        },
        go: {
          all: [/maxAttempts\s*=\s*3/, /attempt\s*<\s*maxAttempts/, /codes\.Unavailable/, /codes\.DeadlineExceeded/],
          none: [/for\s*\{\s*\n/],
        },
        scala: {
          all: [/MaxAttempts\s*=\s*3/, /attempt\s*<\s*MaxAttempts/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/],
          none: [/while\s*\(\s*true\s*\)/],
        },
        cpp: {
          all: [
            /kMaxAttempts\s*=\s*3/,
            /attempt\s*<\s*kMaxAttempts/,
            /StatusCode::UNAVAILABLE/,
            /StatusCode::DEADLINE_EXCEEDED/,
          ],
          none: [/while\s*\(\s*true\s*\)/],
        },
      },
    },
    {
      id: 'fallback-metric',
      title: 'Falls back to the deterministic string metric',
      detail:
        'When the judge stays down the sample is scored by `fallbackExactMatch` (label equality), so the run finishes with a reproducible number instead of an outage. The draft has no fallback and lets the whole run fail.',
      match: {
        python: {all: [/fallback_exact_match\(/, /exact_match/]},
        typescript: {all: [/fallbackExactMatch\(/, /ExactMatch/]},
        go: {all: [/fallbackExactMatch\(/, /ExactMatch/]},
        scala: {all: [/fallbackExactMatch\(/, /ExactMatch/]},
        cpp: {all: [/fallback_exact_match\(/, /exact_match/]},
      },
    },
    {
      id: 'breaker',
      title: 'Opens a breaker after five failures for 30 s',
      detail:
        'A failure counter opens the breaker after `BREAKER_FAILURES = 5` retryable failures for `BREAKER_COOLDOWN_S = 30`, and `allow()` is checked before each attempt so an open breaker skips the judge instead of hammering it.',
      match: {
        python: {all: [/BREAKER_FAILURES\s*=\s*5/, /BREAKER_COOLDOWN_S\s*=\s*30/, /\.allow\(\)/]},
        typescript: {all: [/BREAKER_FAILURES\s*=\s*5/, /BREAKER_COOLDOWN_S\s*=\s*30/, /\.allow\(\)/]},
        go: {all: [/breakerFailures\s*=\s*5/, /breakerCooldownS\s*=\s*30/, /\.allow\(\)/]},
        scala: {all: [/BreakerFailures\s*=\s*5/, /BreakerCooldownS\s*=\s*30/, /\.allow\(/]},
        cpp: {all: [/kBreakerFailures\s*=\s*5/, /kBreakerCooldownS\s*=\s*30/, /\.allow\(\)/]},
      },
    },
    {
      id: 'invalid-argument',
      title: 'Never retries a malformed sample',
      detail:
        '`INVALID_ARGUMENT` is recognized and returned immediately, and there is no catch-all that swallows every failure and loops. The draft’s blanket handler turns one malformed golden sample into an infinite retry loop.',
      match: {
        python: {all: [/INVALID_ARGUMENT/], none: [/except\s+Exception\s*:/]},
        typescript: {all: [/INVALID_ARGUMENT/], none: [/catch\s*\{\s*continue/]},
        go: {all: [/codes\.InvalidArgument/], none: [/if err != nil\s*\{\s*continue/]},
        scala: {all: [/INVALID_ARGUMENT/], none: [/case _:\s*Throwable/]},
        cpp: {all: [/StatusCode::INVALID_ARGUMENT/], none: [/catch\s*\(\s*\.\.\.\s*\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import judge_pb2
import judge_pb2_grpc

channel = grpc.insecure_channel("judge:9000")
judge = judge_pb2_grpc.JudgeStub(channel)

attempts = 0


def score_sample(sample: dict) -> float:
    # TODO: add the 800 ms deadline, bound the attempts to 3 and retry only UNAVAILABLE /
    # DEADLINE_EXCEEDED, score with the deterministic string metric when the judge stays down, open
    # a breaker after five failures, and never retry a malformed sample.
    global attempts
    while True:
        attempts += 1
        try:
            request = judge_pb2.ScoreRequest(
                model_version=sample["model_version"],
                input=sample["input"],
                expected=sample["expected"],
            )
            reply = judge.Score(request)
            return float(reply.score)
        except Exception:
            continue
`,
      solution: `import time

import grpc

import judge_pb2
import judge_pb2_grpc

DEADLINE_S = 0.8
MAX_ATTEMPTS = 3
BREAKER_FAILURES = 5
BREAKER_COOLDOWN_S = 30
RETRYABLE = {grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED}

channel = grpc.insecure_channel("judge:9000")
judge = judge_pb2_grpc.JudgeStub(channel)


def fallback_exact_match(sample: dict) -> float:
    """Deterministic exact_match metric: used whenever the judge is unavailable or slow."""
    return 1.0 if sample["input"].strip() == sample["expected"].strip() else 0.0


class Breaker:
    """Opens after BREAKER_FAILURES retryable failures; skips the judge for BREAKER_COOLDOWN_S."""

    def __init__(self) -> None:
        self.failures = 0
        self.opened_at = 0.0

    def allow(self) -> bool:
        if self.failures < BREAKER_FAILURES:
            return True
        if time.monotonic() - self.opened_at < BREAKER_COOLDOWN_S:
            return False
        self.failures = 0
        return True

    def record(self, error: grpc.RpcError | None) -> None:
        if error is None:
            self.failures = 0
        elif error.code() in RETRYABLE:
            self.failures += 1
            if self.failures >= BREAKER_FAILURES:
                self.opened_at = time.monotonic()


breaker = Breaker()


def score_sample(sample: dict) -> float:
    for _ in range(MAX_ATTEMPTS):
        if not breaker.allow():
            return fallback_exact_match(sample)
        try:
            request = judge_pb2.ScoreRequest(
                model_version=sample["model_version"],
                input=sample["input"],
                expected=sample["expected"],
            )
            reply = judge.Score(request, timeout=DEADLINE_S)
            breaker.record(None)
            return float(reply.score)
        except grpc.RpcError as exc:
            breaker.record(exc)
            if exc.code() == grpc.StatusCode.INVALID_ARGUMENT:
                raise
            if exc.code() not in RETRYABLE:
                raise
    return fallback_exact_match(sample)
`,
    },
    typescript: {
      starter: `/** scoreSample: a model-generated draft that retries every failure forever. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

interface Sample {
  sample_id: string;
  model_version: string;
  input: string;
  expected: string;
}

interface JudgeClient {
  Score(
    request: {model_version: string; input: string; expected: string},
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, reply: {score: number}) => void,
  ): grpc.ClientUnaryCall;
}

const {judge} = grpc.loadPackageDefinition(protoLoader.loadSync('judge.proto')) as unknown as {
  judge: {Judge: new (target: string, credentials: grpc.ChannelCredentials) => JudgeClient};
};
const client = new judge.Judge('judge:9000', grpc.credentials.createInsecure());

export async function scoreSample(sample: Sample): Promise<number> {
  // TODO: add the 800 ms deadline, bound the attempts to 3 and retry only UNAVAILABLE /
  // DEADLINE_EXCEEDED, score with the deterministic string metric when the judge stays down, open
  // a breaker after five failures, and never retry a malformed sample.
  for (;;) {
    try {
      const reply = await new Promise<{score: number}>((resolve, reject) => {
        client.Score(
          {model_version: sample.model_version, input: sample.input, expected: sample.expected},
          {},
          (error, value) => (error === null ? resolve(value) : reject(error)),
        );
      });
      return reply.score;
    } catch {
      continue;
    }
  }
}
`,
      solution: `/** scoreSample: 800 ms deadline, three bounded attempts, fallback metric, breaker. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const DEADLINE_MS = 800;
const MAX_ATTEMPTS = 3;
const BREAKER_FAILURES = 5;
const BREAKER_COOLDOWN_S = 30;
const RETRYABLE: Record<number, true> = {
  [grpc.status.UNAVAILABLE]: true,
  [grpc.status.DEADLINE_EXCEEDED]: true,
};

interface Sample {
  sample_id: string;
  model_version: string;
  input: string;
  expected: string;
}

interface JudgeClient {
  Score(
    request: {model_version: string; input: string; expected: string},
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, reply: {score: number}) => void,
  ): grpc.ClientUnaryCall;
}

const {judge} = grpc.loadPackageDefinition(protoLoader.loadSync('judge.proto')) as unknown as {
  judge: {Judge: new (target: string, credentials: grpc.ChannelCredentials) => JudgeClient};
};
const client = new judge.Judge('judge:9000', grpc.credentials.createInsecure());

function fallbackExactMatch(sample: Sample): number {
  return sample.input.trim() === sample.expected.trim() ? 1 : 0;
}

class Breaker {
  private failures = 0;
  private openedAt = 0;

  allow(): boolean {
    if (this.failures < BREAKER_FAILURES) return true;
    if (Date.now() / 1000 - this.openedAt < BREAKER_COOLDOWN_S) return false;
    this.failures = 0;
    return true;
  }

  record(error: grpc.ServiceError | null): void {
    if (error === null) {
      this.failures = 0;
      return;
    }
    if (RETRYABLE[error.code] === true) {
      this.failures += 1;
      if (this.failures >= BREAKER_FAILURES) this.openedAt = Date.now() / 1000;
    }
  }
}

const breaker = new Breaker();

export async function scoreSample(sample: Sample): Promise<number> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (!breaker.allow()) return fallbackExactMatch(sample);
    try {
      const reply = await new Promise<{score: number}>((resolve, reject) => {
        client.Score(
          {model_version: sample.model_version, input: sample.input, expected: sample.expected},
          {deadline: Date.now() + DEADLINE_MS},
          (error, value) => (error === null ? resolve(value) : reject(error)),
        );
      });
      breaker.record(null);
      return reply.score;
    } catch (error) {
      const status = (error as grpc.ServiceError).code;
      breaker.record(error as grpc.ServiceError);
      if (status === grpc.status.INVALID_ARGUMENT || RETRYABLE[status] !== true) throw error;
    }
  }
  return fallbackExactMatch(sample);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"google.golang.org/grpc"
)

var judge pb.JudgeClient

type Sample struct {
	SampleID     string
	ModelVersion string
	Input        string
	Expected     string
}

func scoreSample(ctx context.Context, sample Sample) (float64, error) {
	// TODO: add the 800 ms deadline, bound the attempts to 3 and retry only UNAVAILABLE /
	// DEADLINE_EXCEEDED, score with the deterministic string metric when the judge stays down, open
	// a breaker after five failures, and never retry a malformed sample.
	for {
		reply, err := judge.Score(ctx, &pb.ScoreRequest{
			ModelVersion: sample.ModelVersion,
			Input:        sample.Input,
			Expected:     sample.Expected,
		})
		if err != nil {
			continue
		}
		return reply.Score, nil
	}
}
`,
      solution: `package main

import (
	"context"
	"strings"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	deadlineMS       = 800
	maxAttempts      = 3
	breakerFailures  = 5
	breakerCooldownS = 30
)

var judge pb.JudgeClient

type Sample struct {
	SampleID     string
	ModelVersion string
	Input        string
	Expected     string
}

func retryable(code codes.Code) bool {
	return code == codes.Unavailable || code == codes.DeadlineExceeded
}

func fallbackExactMatch(sample Sample) float64 {
	if strings.TrimSpace(sample.Input) == strings.TrimSpace(sample.Expected) {
		return 1
	}
	return 0
}

type breaker struct {
	failures int
	openedAt time.Time
}

func (b *breaker) allow() bool {
	if b.failures < breakerFailures {
		return true
	}
	if time.Since(b.openedAt) < breakerCooldownS*time.Second {
		return false
	}
	b.failures = 0
	return true
}

func (b *breaker) record(err error) {
	if err == nil {
		b.failures = 0
		return
	}
	if retryable(status.Code(err)) {
		b.failures++
		if b.failures >= breakerFailures {
			b.openedAt = time.Now()
		}
	}
}

var judgeBreaker = &breaker{}

func scoreSample(ctx context.Context, sample Sample) (float64, error) {
	for attempt := 0; attempt < maxAttempts; attempt++ {
		if !judgeBreaker.allow() {
			return fallbackExactMatch(sample), nil
		}
		callCtx, cancel := context.WithTimeout(ctx, deadlineMS*time.Millisecond)
		reply, err := judge.Score(callCtx, &pb.ScoreRequest{
			ModelVersion: sample.ModelVersion,
			Input:        sample.Input,
			Expected:     sample.Expected,
		})
		cancel()
		if err == nil {
			judgeBreaker.record(nil)
			return reply.Score, nil
		}
		judgeBreaker.record(err)
		if status.Code(err) == codes.InvalidArgument || !retryable(status.Code(err)) {
			return 0, err
		}
	}
	return fallbackExactMatch(sample), nil
}
`,
    },
    scala: {
      starter: `import io.grpc.ManagedChannelBuilder

final case class Sample(sample_id: String, model_version: String, input: String, expected: String)

object Scorer {
  val judge = JudgeGrpc.blockingStub(
    ManagedChannelBuilder.forAddress("judge", 9000).usePlaintext().build()
  )

  def scoreSample(sample: Sample): Double = {
    // TODO: add the 800 ms deadline, bound the attempts to 3 and retry only UNAVAILABLE /
    // DEADLINE_EXCEEDED, score with the deterministic string metric when the judge stays down, open
    // a breaker after five failures, and never retry a malformed sample.
    while (true) {
      try {
        val reply = judge.score(
          ScoreRequest(modelVersion = sample.model_version, input = sample.input, expected = sample.expected)
        )
        return reply.score
      } catch {
        case _: Throwable => // retry
      }
    }
    0.0
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

final case class Sample(sample_id: String, model_version: String, input: String, expected: String)

object Scorer {
  val DeadlineMs = 800L
  val MaxAttempts = 3
  val BreakerFailures = 5
  val BreakerCooldownS = 30L

  val judge = JudgeGrpc.blockingStub(
    ManagedChannelBuilder.forAddress("judge", 9000).usePlaintext().build()
  )

  def fallbackExactMatch(sample: Sample): Double =
    if (sample.input.trim == sample.expected.trim) 1.0 else 0.0

  class Breaker {
    private var failures = 0
    private var openedAt = 0L

    def allow(): Boolean = {
      if (failures < BreakerFailures) true
      else if (System.currentTimeMillis() / 1000 - openedAt < BreakerCooldownS) false
      else {
        failures = 0
        true
      }
    }

    def record(error: Option[StatusRuntimeException]): Unit = error match {
      case None => failures = 0
      case Some(e) if e.getStatus.getCode == Status.Code.UNAVAILABLE ||
          e.getStatus.getCode == Status.Code.DEADLINE_EXCEEDED =>
        failures += 1
        if (failures >= BreakerFailures) openedAt = System.currentTimeMillis() / 1000
      case Some(_) => ()
    }
  }

  val breaker = new Breaker

  def scoreSample(sample: Sample): Double = {
    var attempt = 0
    while (attempt < MaxAttempts) {
      if (!breaker.allow()) return fallbackExactMatch(sample)
      try {
        val reply = judge
          .withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS)
          .score(ScoreRequest(modelVersion = sample.model_version, input = sample.input, expected = sample.expected))
        breaker.record(None)
        return reply.score
      } catch {
        case e: StatusRuntimeException =>
          breaker.record(Some(e))
          if (e.getStatus.getCode == Status.Code.INVALID_ARGUMENT) throw e
          if (
            e.getStatus.getCode != Status.Code.UNAVAILABLE &&
            e.getStatus.getCode != Status.Code.DEADLINE_EXCEEDED
          ) throw e
      }
      attempt += 1
    }
    fallbackExactMatch(sample)
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include "judge.grpc.pb.h"

#include <string>

std::unique_ptr<Judge::Stub> judge;

struct Sample {
  std::string sample_id;
  std::string model_version;
  std::string input;
  std::string expected;
};

double scoreSample(const Sample& sample) {
  // TODO: add the 800 ms deadline, bound the attempts to 3 and retry only UNAVAILABLE /
  // DEADLINE_EXCEEDED, score with the deterministic string metric when the judge stays down, open
  // a breaker after five failures, and never retry a malformed sample.
  while (true) {
    grpc::ClientContext ctx;
    ScoreRequest request;
    request.set_model_version(sample.model_version);
    request.set_input(sample.input);
    request.set_expected(sample.expected);
    ScoreReply reply;
    const grpc::Status status = judge->Score(&ctx, request, &reply);
    if (!status.ok()) continue;
    return reply.score();
  }
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include "judge.grpc.pb.h"

#include <chrono>
#include <string>

constexpr int kDeadlineMs = 800;
constexpr int kMaxAttempts = 3;
constexpr int kBreakerFailures = 5;
constexpr int kBreakerCooldownS = 30;

std::unique_ptr<Judge::Stub> judge;

struct Sample {
  std::string sample_id;
  std::string model_version;
  std::string input;
  std::string expected;
};

double fallback_exact_match(const Sample& sample) {
  return sample.input == sample.expected ? 1.0 : 0.0;
}

bool retryable(grpc::StatusCode code) {
  return code == grpc::StatusCode::UNAVAILABLE || code == grpc::StatusCode::DEADLINE_EXCEEDED;
}

class Breaker {
 public:
  bool allow() {
    if (failures_ < kBreakerFailures) return true;
    const auto now = std::chrono::system_clock::now();
    if (std::chrono::duration_cast<std::chrono::seconds>(now - opened_at_).count() < kBreakerCooldownS) return false;
    failures_ = 0;
    return true;
  }

  void record(const grpc::Status& status) {
    if (status.ok()) {
      failures_ = 0;
      return;
    }
    if (retryable(status.error_code())) {
      failures_ += 1;
      if (failures_ >= kBreakerFailures) opened_at_ = std::chrono::system_clock::now();
    }
  }

 private:
  int failures_ = 0;
  std::chrono::system_clock::time_point opened_at_ = std::chrono::system_clock::now();
};

Breaker breaker;

double scoreSample(const Sample& sample) {
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    if (!breaker.allow()) return fallback_exact_match(sample);
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kDeadlineMs));
    ScoreRequest request;
    request.set_model_version(sample.model_version);
    request.set_input(sample.input);
    request.set_expected(sample.expected);
    ScoreReply reply;
    const grpc::Status status = judge->Score(&ctx, request, &reply);
    breaker.record(status);
    if (status.ok()) return reply.score();
    if (status.error_code() == grpc::StatusCode::INVALID_ARGUMENT || !retryable(status.error_code())) {
      return 0.0;
    }
  }
  return fallback_exact_match(sample);
}
`,
    },
  },
  debrief: `The interview question is failure policy on a dependency you do not control. The draft passes every serial test with a healthy judge and fails exactly when a release eval runs but the judge is being redeployed: an unbounded retry loop turns a bad deploy into a hot loop, one malformed sample burns the whole budget, and there is no fallback, so an outage silently invalidates every sample instead of scoring them cheaply. The fixes are the four contracts every outbound call needs — a deadline, bounded attempts over a status whitelist, a deterministic degradation path, and a breaker so the dependency gets room to recover. Real harnesses add a judge-version pin so the fallback and the judge are comparable, a per-run fallback share that fails the gate when too many samples degraded, and hedged requests for the long tail.`,
};
