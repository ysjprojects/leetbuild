import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Judge calls: a deadline, bounded retries, a breaker and a marked fallback',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'judge'],
  task: `## Task

**Starting point.** The starter's \`score_sample(sample)\` builds a \`ScoreRequest\` from the provided
\`GoldenSample\` and calls \`Judge.Score\` (\`judge.proto\`, served as a stand-in at \`JUDGE\`) in a loop: on
any error it logs, sleeps \`BACKOFF_S\` and calls again; on a reply it answers \`{status: "scored", score,
judge: "model", attempts}\`. Against a healthy judge it answers in one call. It hides 5 flaws.

**Failure mode the checks target.** A judge redeploy turns the loop into a retry storm against a
service that is already down and the run stops moving; a judge that hangs holds a worker for as long as
it hangs; a malformed sample spins on \`INVALID_ARGUMENT\` forever.

\`\`\`proto
service Judge { rpc Score(ScoreRequest) returns (ScoreReply); }
message ScoreRequest { string run_id = 1; string sample_id = 2; string expected = 3; string output = 4; }
message ScoreReply   { double score = 1; string judge_version = 2; }
\`\`\`

Requirements:

- Every attempt carries an **800 ms** deadline (\`DEADLINE_S\`).
- Only \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` are retried, after a backoff, for at most **3** attempts
  (\`MAX_ATTEMPTS\`).
- When the judge cannot answer, the provided \`exact_match(expected, output)\` scores the sample, marked
  \`judge: "fallback"\`.
- \`INVALID_ARGUMENT\` answers \`status: "invalid"\` after one call: no retry, no fallback.
- A breaker, asked with \`breaker.allow()\` before each attempt, opens after **5** failed attempts in a
  row (\`BREAKER_FAILURES\`) for **30 s** (\`BREAKER_COOLDOWN_S\`); while open, samples skip the judge.`,
  sequence: {
    participants: ['Worker', 'Breaker', 'Judge'],
    messages: [
      {from: 'Worker', to: 'Breaker', label: 'allow()', kind: 'sync'},
      {from: 'Worker', to: 'Judge', label: 'Score · deadline 800 ms', kind: 'sync'},
      {from: 'Judge', to: 'Worker', label: 'UNAVAILABLE', kind: 'reply'},
      {from: 'Worker', to: 'Breaker', label: 'failure · allow()', kind: 'sync'},
      {from: 'Worker', to: 'Judge', label: 'Score · attempt 2 after backoff', kind: 'sync'},
      {from: 'Judge', to: 'Worker', label: '{score, judge_version}', kind: 'reply'},
      {from: 'Worker', to: 'Worker', label: 'judge down or breaker open → exact_match, judge: fallback', kind: 'sync'},
    ],
  },
  hints: [
    'Symptom: during a judge redeploy one sample makes dozens of calls and the run stops moving, a judge that hangs holds a worker for its whole hang, and one malformed sample never finishes.',
    'Mechanism: the loop retries every status, forever, and sends no deadline, so a hang lasts as long as the judge decides; nothing scores the sample another way, and nothing remembers that the last calls all failed.',
    'Change: `timeout=DEADLINE_S` on the call; loop while `attempts < MAX_ATTEMPTS and breaker.allow()`; return `invalid` on `INVALID_ARGUMENT`; record each retryable failure in the breaker; after the loop return `exact_match` with `judge: "fallback"`.',
  ],
  checks: [
    {
      id: 'deadline',
      title: 'An 800 ms deadline on every attempt',
      detail:
        'Each Score call carries a deadline of about 800 ms (timeout=DEADLINE_S, deadline: Date.now() + DEADLINE_MS, context.WithTimeout, withDeadlineAfter, set_deadline); a judge answering in 500 ms is used on the first call. The starter sends no deadline.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*0?\.8\b/, /timeout\s*=\s*DEADLINE_S/]},
        typescript: {all: [/\b800\b|\b0?\.8\b/, /deadline:\s*Date\.now\(\)\s*\+/]},
        go: {all: [/context\.WithTimeout\(/, /\b800\b/]},
        scala: {all: [/withDeadlineAfter\(/, /\b800L?\b|\b0?\.8\b/]},
        cpp: {all: [/set_deadline\(/, /\b800\b/]},
      },
    },
    {
      id: 'retry-unavailable',
      title: 'Retries UNAVAILABLE at most twice',
      detail:
        "One UNAVAILABLE earns a retry after a backoff and the model's score; a judge that stays UNAVAILABLE gets exactly three calls for the sample. The starter calls until the judge answers.",
      match: {
        python: {all: [/grpc\.StatusCode\.UNAVAILABLE/, /MAX_ATTEMPTS/], none: [/while\s+True/]},
        typescript: {all: [/status\.UNAVAILABLE/, /MAX_ATTEMPTS/], none: [/while\s*\(\s*true\s*\)/]},
        go: {all: [/codes\.Unavailable/, /maxAttempts/], none: [/\bfor\s*\{/]},
        scala: {all: [/Status\.Code\.UNAVAILABLE/, /MaxAttempts/], none: [/while\s*\(\s*true\s*\)/]},
        cpp: {
          all: [/grpc::StatusCode::UNAVAILABLE/, /kMaxAttempts/],
          none: [/while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\)/],
        },
      },
    },
    {
      id: 'fallback-metric',
      title: 'Scores with exact_match, marked fallback, when the judge cannot answer',
      detail:
        'A judge that hangs past every deadline, or stays UNAVAILABLE, leaves the sample scored by exact_match(expected, output) with judge fallback, after about three deadlines of waiting. The starter waits the judge out.',
      match: {
        python: {all: [/exact_match\(/, /["']fallback["']/]},
        typescript: {all: [/exactMatch\(/, /['"]fallback['"]/]},
        go: {all: [/metrics\.ExactMatch\(/, /"fallback"/]},
        scala: {all: [/Metrics\.exactMatch\(/, /"fallback"/]},
        cpp: {all: [/metrics::exact_match\(/, /"fallback"/]},
      },
    },
    {
      id: 'invalid-argument',
      title: 'Reports INVALID_ARGUMENT as invalid after one call',
      detail:
        'A judge answering INVALID_ARGUMENT gets one call, no backoff, and the sample comes back status invalid, not a fallback score; five invalid samples in a row leave the breaker closed. The starter retries it.',
      match: {
        python: {all: [/grpc\.StatusCode\.INVALID_ARGUMENT/, /["']invalid["']/]},
        typescript: {all: [/status\.INVALID_ARGUMENT/, /['"]invalid['"]/]},
        go: {all: [/codes\.InvalidArgument/, /"invalid"/]},
        scala: {all: [/Status\.Code\.INVALID_ARGUMENT/, /"invalid"/]},
        cpp: {all: [/grpc::StatusCode::INVALID_ARGUMENT/, /"invalid"/]},
      },
    },
    {
      id: 'breaker',
      title: 'Opens a breaker after five failed attempts, for 30 s',
      detail:
        'With the judge down, the fifth failed attempt in a row opens the breaker: later samples go to the fallback without a call until 30 s have passed, then a trial call reaches the judge again. The starter has no breaker.',
      match: {
        python: {all: [/BREAKER_FAILURES/, /BREAKER_COOLDOWN_S/, /\.allow\(\)/]},
        typescript: {all: [/BREAKER_FAILURES/, /BREAKER_COOLDOWN/, /\.allow\(\)/]},
        go: {all: [/breakerFailures/, /breakerCooldown/, /\.allow\(\)/]},
        scala: {all: [/BreakerFailures/, /BreakerCooldown/, /\.allow\(\)/]},
        cpp: {all: [/kBreakerFailures/, /kBreakerCooldown/, /\.allow\(\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
import time

import grpc

import judge_pb2
import judge_pb2_grpc
from evals.config import JUDGE
from evals.samples import GoldenSample

logger = logging.getLogger("evald.judge")

BACKOFF_S = 0.1

channel = grpc.insecure_channel(JUDGE)
stub = judge_pb2_grpc.JudgeStub(channel)


def score_sample(sample: GoldenSample) -> dict:
    """Score one golden sample with the judge: {status, score, judge, attempts}."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    request = judge_pb2.ScoreRequest(
        run_id=sample.run_id, sample_id=sample.sample_id, expected=sample.expected, output=sample.output
    )
    attempts = 0
    while True:
        attempts += 1
        try:
            reply = stub.Score(request)
        except grpc.RpcError as err:
            logger.warning("judge call failed run=%s sample=%s code=%s", sample.run_id, sample.sample_id, err.code())
            time.sleep(BACKOFF_S)
            continue
        return {"status": "scored", "score": reply.score, "judge": "model", "attempts": attempts}
`,
      solution: `import logging
import time

import grpc

import judge_pb2
import judge_pb2_grpc
from evals.config import JUDGE
from evals.metrics import exact_match
from evals.samples import GoldenSample

logger = logging.getLogger("evald.judge")

DEADLINE_S = 0.8
MAX_ATTEMPTS = 3
BACKOFF_S = 0.1
BREAKER_FAILURES = 5
BREAKER_COOLDOWN_S = 30.0
RETRYABLE = (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED)

channel = grpc.insecure_channel(JUDGE)
stub = judge_pb2_grpc.JudgeStub(channel)


class Breaker:
    """Opens after BREAKER_FAILURES failed attempts in a row; while open, samples skip the judge."""

    def __init__(self) -> None:
        self.failures = 0
        self.open_until = 0.0

    def allow(self) -> bool:
        return time.monotonic() >= self.open_until

    def record(self, ok: bool) -> None:
        if ok:
            self.failures = 0
            return
        self.failures += 1
        if self.failures >= BREAKER_FAILURES:
            self.open_until = time.monotonic() + BREAKER_COOLDOWN_S
            self.failures = 0


breaker = Breaker()


def score_sample(sample: GoldenSample) -> dict:
    """Score one golden sample: the judge within a deadline and bounded retries, else the marked fallback."""
    request = judge_pb2.ScoreRequest(
        run_id=sample.run_id, sample_id=sample.sample_id, expected=sample.expected, output=sample.output
    )
    attempts = 0
    while attempts < MAX_ATTEMPTS and breaker.allow():
        attempts += 1
        try:
            reply = stub.Score(request, timeout=DEADLINE_S)
        except grpc.RpcError as err:
            code = err.code()
            if code == grpc.StatusCode.INVALID_ARGUMENT:
                logger.warning("judge refused run=%s sample=%s: %s", sample.run_id, sample.sample_id, err.details())
                return {"status": "invalid", "score": 0.0, "judge": "", "attempts": attempts}
            if code not in RETRYABLE:
                logger.warning("judge failed run=%s sample=%s code=%s", sample.run_id, sample.sample_id, code)
                break
            breaker.record(False)
            if attempts < MAX_ATTEMPTS:
                time.sleep(BACKOFF_S * attempts)
            continue
        breaker.record(True)
        return {"status": "scored", "score": reply.score, "judge": "model", "attempts": attempts}
    return {"status": "scored", "score": exact_match(sample.expected, sample.output), "judge": "fallback", "attempts": attempts}
`,
    },
    typescript: {
      starter: `import {setTimeout as sleep} from 'node:timers/promises';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {JUDGE} from 'evals/config';
import type {GoldenSample} from 'evals/samples';

export const BACKOFF_MS = 100;

interface ScoreRequest {
  run_id: string;
  sample_id: string;
  expected: string;
  output: string;
}
interface ScoreReply {
  score: number;
  judge_version: string;
}
interface JudgeClient {
  Score(request: ScoreRequest, options?: {deadline: number}): Promise<ScoreReply>;
}

const {evals} = grpc.loadPackageDefinition(protoLoader.loadSync('judge.proto')) as unknown as {
  evals: {Judge: new (target: string, credentials: grpc.ChannelCredentials) => JudgeClient};
};
const stub = new evals.Judge(JUDGE, grpc.credentials.createInsecure());

/** One sample's score: status scored or invalid, the score, which judge produced it, the attempts made. */
export interface SampleScore {
  status: string;
  score: number;
  judge: string;
  attempts: number;
}

/** Score one golden sample with the judge. */
export async function scoreSample(sample: GoldenSample): Promise<SampleScore> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const request: ScoreRequest = {run_id: sample.run_id, sample_id: sample.sample_id, expected: sample.expected, output: sample.output};
  let attempts = 0;
  while (true) {
    attempts += 1;
    try {
      const reply = await stub.Score(request);
      return {status: 'scored', score: reply.score, judge: 'model', attempts};
    } catch (err) {
      console.warn(\`judge call failed run=\${sample.run_id} sample=\${sample.sample_id} code=\${(err as grpc.ServiceError).code}\`);
      await sleep(BACKOFF_MS);
    }
  }
}
`,
      solution: `import {setTimeout as sleep} from 'node:timers/promises';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {JUDGE} from 'evals/config';
import {exactMatch} from 'evals/metrics';
import type {GoldenSample} from 'evals/samples';

export const DEADLINE_MS = 800;
export const MAX_ATTEMPTS = 3;
export const BACKOFF_MS = 100;
export const BREAKER_FAILURES = 5;
export const BREAKER_COOLDOWN_MS = 30_000;
const RETRYABLE: number[] = [grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED];

interface ScoreRequest {
  run_id: string;
  sample_id: string;
  expected: string;
  output: string;
}
interface ScoreReply {
  score: number;
  judge_version: string;
}
interface JudgeClient {
  Score(request: ScoreRequest, options?: {deadline: number}): Promise<ScoreReply>;
}

const {evals} = grpc.loadPackageDefinition(protoLoader.loadSync('judge.proto')) as unknown as {
  evals: {Judge: new (target: string, credentials: grpc.ChannelCredentials) => JudgeClient};
};
const stub = new evals.Judge(JUDGE, grpc.credentials.createInsecure());

/** One sample's score: status scored or invalid, the score, which judge produced it, the attempts made. */
export interface SampleScore {
  status: string;
  score: number;
  judge: string;
  attempts: number;
}

/** Opens after BREAKER_FAILURES failed attempts in a row; while open, samples skip the judge. */
class Breaker {
  private failures = 0;
  private openUntil = 0;

  allow(): boolean {
    return Date.now() >= this.openUntil;
  }

  record(ok: boolean): void {
    if (ok) {
      this.failures = 0;
      return;
    }
    this.failures += 1;
    if (this.failures >= BREAKER_FAILURES) {
      this.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
      this.failures = 0;
    }
  }
}

export const breaker = new Breaker();

/** Score one golden sample: the judge within a deadline and bounded retries, else the marked fallback. */
export async function scoreSample(sample: GoldenSample): Promise<SampleScore> {
  const request: ScoreRequest = {run_id: sample.run_id, sample_id: sample.sample_id, expected: sample.expected, output: sample.output};
  let attempts = 0;
  while (attempts < MAX_ATTEMPTS && breaker.allow()) {
    attempts += 1;
    let reply: ScoreReply;
    try {
      reply = await stub.Score(request, {deadline: Date.now() + DEADLINE_MS});
    } catch (err) {
      const {code, details} = err as grpc.ServiceError;
      if (code === grpc.status.INVALID_ARGUMENT) {
        console.warn(\`judge refused run=\${sample.run_id} sample=\${sample.sample_id}: \${details}\`);
        return {status: 'invalid', score: 0, judge: '', attempts};
      }
      if (!RETRYABLE.includes(code)) {
        console.warn(\`judge failed run=\${sample.run_id} sample=\${sample.sample_id} code=\${code}\`);
        break;
      }
      breaker.record(false);
      if (attempts < MAX_ATTEMPTS) await sleep(BACKOFF_MS * attempts);
      continue;
    }
    breaker.record(true);
    return {status: 'scored', score: reply.score, judge: 'model', attempts};
  }
  return {status: 'scored', score: exactMatch(sample.expected, sample.output), judge: 'fallback', attempts};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"log"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"evals/config" // config.Judge — provided
	pb "evals/gen/judge"
	"evals/samples" // samples.GoldenSample — provided
)

const backoff = 100 * time.Millisecond

var conn, _ = grpc.NewClient(config.Judge, grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewJudgeClient(conn)

// SampleScore is one sample's score: status scored or invalid, the score, which judge produced it, the attempts made.
type SampleScore struct {
	Status   string
	Score    float64
	Judge    string
	Attempts int
}

// scoreSample scores one golden sample with the judge.
func scoreSample(ctx context.Context, sample samples.GoldenSample) SampleScore {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	request := &pb.ScoreRequest{RunId: sample.RunID, SampleId: sample.SampleID, Expected: sample.Expected, Output: sample.Output}
	attempts := 0
	for {
		attempts++
		reply, err := stub.Score(ctx, request)
		if err != nil {
			log.Printf("judge call failed run=%s sample=%s code=%s", sample.RunID, sample.SampleID, status.Code(err))
			time.Sleep(backoff)
			continue
		}
		return SampleScore{Status: "scored", Score: reply.GetScore(), Judge: "model", Attempts: attempts}
	}
}
`,
      solution: `package main

import (
	"context"
	"log"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"evals/config" // config.Judge — provided
	pb "evals/gen/judge"
	"evals/metrics" // metrics.ExactMatch(expected, output) — provided
	"evals/samples" // samples.GoldenSample — provided
)

const (
	deadline        = 800 * time.Millisecond
	maxAttempts     = 3
	backoff         = 100 * time.Millisecond
	breakerFailures = 5
	breakerCooldown = 30 * time.Second
)

var conn, _ = grpc.NewClient(config.Judge, grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewJudgeClient(conn)

// SampleScore is one sample's score: status scored or invalid, the score, which judge produced it, the attempts made.
type SampleScore struct {
	Status   string
	Score    float64
	Judge    string
	Attempts int
}

// circuitBreaker opens after breakerFailures failed attempts in a row; while open, samples skip the judge.
type circuitBreaker struct {
	failures  int
	openUntil time.Time
}

func (b *circuitBreaker) allow() bool { return !time.Now().Before(b.openUntil) }

func (b *circuitBreaker) record(ok bool) {
	if ok {
		b.failures = 0
		return
	}
	b.failures++
	if b.failures >= breakerFailures {
		b.openUntil = time.Now().Add(breakerCooldown)
		b.failures = 0
	}
}

var breaker = &circuitBreaker{}

// scoreSample scores one golden sample: the judge within a deadline and bounded retries, else the marked fallback.
func scoreSample(ctx context.Context, sample samples.GoldenSample) SampleScore {
	request := &pb.ScoreRequest{RunId: sample.RunID, SampleId: sample.SampleID, Expected: sample.Expected, Output: sample.Output}
	attempts := 0
attempt:
	for attempts < maxAttempts && breaker.allow() {
		attempts++
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		reply, err := stub.Score(callCtx, request)
		cancel()
		if err == nil {
			breaker.record(true)
			return SampleScore{Status: "scored", Score: reply.GetScore(), Judge: "model", Attempts: attempts}
		}
		switch code := status.Code(err); code {
		case codes.InvalidArgument:
			log.Printf("judge refused run=%s sample=%s: %v", sample.RunID, sample.SampleID, err)
			return SampleScore{Status: "invalid", Attempts: attempts}
		case codes.Unavailable, codes.DeadlineExceeded:
			breaker.record(false)
			if attempts < maxAttempts {
				time.Sleep(backoff * time.Duration(attempts))
			}
		default:
			log.Printf("judge failed run=%s sample=%s code=%s", sample.RunID, sample.SampleID, code)
			break attempt
		}
	}
	return SampleScore{Status: "scored", Score: metrics.ExactMatch(sample.Expected, sample.Output), Judge: "fallback", Attempts: attempts}
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import evals.{Config, GoldenSample}
import evals.judge.{JudgeGrpc, ScoreRequest}

/** One sample's score: status scored or invalid, the score, which judge produced it, the attempts made. */
final case class SampleScore(status: String, score: Double, judge: String, attempts: Int)

object JudgeClient {
  val BackoffMs = 100L

  private val channel = ManagedChannelBuilder.forTarget(Config.Judge).usePlaintext().build()
  private val stub = JudgeGrpc.blockingStub(channel)

  /** Score one golden sample with the judge. */
  def scoreSample(sample: GoldenSample): SampleScore = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    val request = ScoreRequest(runId = sample.run_id, sampleId = sample.sample_id, expected = sample.expected, output = sample.output)
    var attempts = 0
    while (true) {
      attempts += 1
      try {
        val reply = stub.score(request)
        return SampleScore("scored", reply.score, "model", attempts)
      } catch {
        case e: StatusRuntimeException =>
          System.err.println(s"judge call failed run=\${sample.run_id} sample=\${sample.sample_id} code=\${e.getStatus.getCode}")
          Thread.sleep(BackoffMs)
      }
    }
    SampleScore("scored", 0.0, "model", attempts)
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import evals.{Config, GoldenSample, Metrics}
import evals.judge.{JudgeGrpc, ScoreRequest}

/** One sample's score: status scored or invalid, the score, which judge produced it, the attempts made. */
final case class SampleScore(status: String, score: Double, judge: String, attempts: Int)

/** Opens after BreakerFailures failed attempts in a row; while open, samples skip the judge. */
final class Breaker(failuresToOpen: Int, cooldownMs: Long) {
  private var failures = 0
  private var openUntil = 0L

  def allow(): Boolean = System.currentTimeMillis() >= openUntil

  def record(ok: Boolean): Unit =
    if (ok) failures = 0
    else {
      failures += 1
      if (failures >= failuresToOpen) {
        openUntil = System.currentTimeMillis() + cooldownMs
        failures = 0
      }
    }
}

object JudgeClient {
  val DeadlineMs = 800L
  val MaxAttempts = 3
  val BackoffMs = 100L
  val BreakerFailures = 5
  val BreakerCooldownMs = 30000L
  private val Retryable = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)

  private val channel = ManagedChannelBuilder.forTarget(Config.Judge).usePlaintext().build()
  private val stub = JudgeGrpc.blockingStub(channel)
  val breaker = new Breaker(BreakerFailures, BreakerCooldownMs)

  /** Score one golden sample: the judge within a deadline and bounded retries, else the marked fallback. */
  def scoreSample(sample: GoldenSample): SampleScore = {
    val request = ScoreRequest(runId = sample.run_id, sampleId = sample.sample_id, expected = sample.expected, output = sample.output)
    var attempts = 0
    var judgeFailed = false
    while (!judgeFailed && attempts < MaxAttempts && breaker.allow()) {
      attempts += 1
      try {
        val reply = stub.withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS).score(request)
        breaker.record(true)
        return SampleScore("scored", reply.score, "model", attempts)
      } catch {
        case e: StatusRuntimeException =>
          val code = e.getStatus.getCode
          if (code == Status.Code.INVALID_ARGUMENT) {
            System.err.println(s"judge refused run=\${sample.run_id} sample=\${sample.sample_id}: \${e.getStatus.getDescription}")
            return SampleScore("invalid", 0.0, "", attempts)
          }
          if (Retryable.contains(code)) {
            breaker.record(false)
            if (attempts < MaxAttempts) Thread.sleep(BackoffMs * attempts)
          } else {
            System.err.println(s"judge failed run=\${sample.run_id} sample=\${sample.sample_id} code=$code")
            judgeFailed = true
          }
      }
    }
    SampleScore("scored", Metrics.exactMatch(sample.expected, sample.output), "fallback", attempts)
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <iostream>
#include <string>
#include <thread>

#include "evals/config.h"   // config::kJudge — provided
#include "evals/samples.h"  // samples::GoldenSample — provided
#include "judge.grpc.pb.h"

constexpr std::chrono::milliseconds kBackoff{100};

auto channel = grpc::CreateChannel(config::kJudge, grpc::InsecureChannelCredentials());
auto stub = evals::Judge::NewStub(channel);

// One sample's score: status scored or invalid, the score, which judge produced it, the attempts made.
struct SampleScore {
  std::string status;
  double score = 0;
  std::string judge;
  int attempts = 0;
};

// Score one golden sample with the judge.
SampleScore score_sample(const samples::GoldenSample& sample) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  evals::ScoreRequest request;
  request.set_run_id(sample.run_id);
  request.set_sample_id(sample.sample_id);
  request.set_expected(sample.expected);
  request.set_output(sample.output);
  int attempts = 0;
  while (true) {
    attempts++;
    grpc::ClientContext ctx;
    evals::ScoreReply reply;
    const grpc::Status status = stub->Score(&ctx, request, &reply);
    if (status.ok()) return {"scored", reply.score(), "model", attempts};
    std::cerr << "judge call failed run=" << sample.run_id << " sample=" << sample.sample_id << " code=" << status.error_code() << "\\n";
    std::this_thread::sleep_for(kBackoff);
  }
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <iostream>
#include <string>
#include <thread>

#include "evals/config.h"   // config::kJudge — provided
#include "evals/metrics.h"  // metrics::exact_match(expected, output) — provided
#include "evals/samples.h"  // samples::GoldenSample — provided
#include "judge.grpc.pb.h"

constexpr std::chrono::milliseconds kDeadline{800};
constexpr int kMaxAttempts = 3;
constexpr std::chrono::milliseconds kBackoff{100};
constexpr int kBreakerFailures = 5;
constexpr std::chrono::seconds kBreakerCooldown{30};

auto channel = grpc::CreateChannel(config::kJudge, grpc::InsecureChannelCredentials());
auto stub = evals::Judge::NewStub(channel);

// One sample's score: status scored or invalid, the score, which judge produced it, the attempts made.
struct SampleScore {
  std::string status;
  double score = 0;
  std::string judge;
  int attempts = 0;
};

// Opens after kBreakerFailures failed attempts in a row; while open, samples skip the judge.
class Breaker {
 public:
  bool allow() const { return std::chrono::steady_clock::now() >= open_until_; }

  void record(bool ok) {
    if (ok) {
      failures_ = 0;
      return;
    }
    if (++failures_ >= kBreakerFailures) {
      open_until_ = std::chrono::steady_clock::now() + kBreakerCooldown;
      failures_ = 0;
    }
  }

 private:
  int failures_ = 0;
  std::chrono::steady_clock::time_point open_until_{};
};

Breaker breaker;

// Score one golden sample: the judge within a deadline and bounded retries, else the marked fallback.
SampleScore score_sample(const samples::GoldenSample& sample) {
  evals::ScoreRequest request;
  request.set_run_id(sample.run_id);
  request.set_sample_id(sample.sample_id);
  request.set_expected(sample.expected);
  request.set_output(sample.output);
  int attempts = 0;
  while (attempts < kMaxAttempts && breaker.allow()) {
    attempts++;
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    evals::ScoreReply reply;
    const grpc::Status status = stub->Score(&ctx, request, &reply);
    if (status.ok()) {
      breaker.record(true);
      return {"scored", reply.score(), "model", attempts};
    }
    const grpc::StatusCode code = status.error_code();
    if (code == grpc::StatusCode::INVALID_ARGUMENT) {
      std::cerr << "judge refused run=" << sample.run_id << " sample=" << sample.sample_id << ": " << status.error_message() << "\\n";
      return {"invalid", 0, "", attempts};
    }
    if (code != grpc::StatusCode::UNAVAILABLE && code != grpc::StatusCode::DEADLINE_EXCEEDED) {
      std::cerr << "judge failed run=" << sample.run_id << " sample=" << sample.sample_id << " code=" << code << "\\n";
      break;
    }
    breaker.record(false);
    if (attempts < kMaxAttempts) std::this_thread::sleep_for(kBackoff * attempts);
  }
  return {"scored", metrics::exact_match(sample.expected, sample.output), "fallback", attempts};
}
`,
    },
  },
  harness: {
    python: `import grpc

import judge_pb2
import judge_pb2_grpc
from evals import config, judge
from evals.samples import GoldenSample


class JudgeServicer(judge_pb2_grpc.JudgeServicer):
    """The stand-in judge: grades from evals.judge."""

    def Score(self, request, context):
        return judge_pb2.ScoreReply(score=judge.grade(request.expected, request.output), judge_version=judge.JUDGE_VERSION)


def _world(ctx):
    ctx.grpc.serve(judge_pb2_grpc.add_JudgeServicer_to_server, JudgeServicer(), config.JUDGE)
    return ctx.load("client")


def _sample(n, expected="Paris", output="The capital of France is Paris."):
    return GoldenSample(run_id="r1", sample_id=f"s-{n}", expected=expected, output=output)


def _calls(ctx):
    return ctx.grpc.calls_to("Score")


def _shape(result):
    assert isinstance(result, dict), f"score_sample must return a dict, got {result!r}"
    return result


def _judged(result, score=0.75):
    _shape(result)
    return result.get("status") == "scored" and result.get("judge") == "model" and abs(float(result.get("score", -1)) - score) < 1e-9


def check_deadline(ctx):
    m = _world(ctx)
    result = _shape(m.score_sample(_sample(1)))
    assert _judged(result), f"a healthy judge grades 'Paris' in '...is Paris.' 0.75: expected status scored, judge model, score 0.75, got {result}"
    assert result.get("attempts") == 1, f"a healthy judge is called once (attempts 1), got {result}"
    calls = _calls(ctx)
    assert len(calls) == 1, f"a healthy judge must be called exactly once, saw {len(calls)} Score calls"
    assert calls[0].timeout is not None, "the Score call carries no deadline: a judge that hangs holds the worker for as long as it hangs"
    assert 0.6 <= calls[0].timeout <= 1.0, f"the deadline must be DEADLINE_S = 0.8 s, got {calls[0].timeout} s"
    ctx.grpc.set_latency("Score", 0.5, config.JUDGE)
    result = m.score_sample(_sample(2))
    assert _judged(result) and len(_calls(ctx)) == 2, f"a judge answering in 500 ms is within the deadline and used on the first call: {len(_calls(ctx))} calls, {result}"


def check_retry_unavailable(ctx):
    m = _world(ctx)
    ctx.grpc.fail("Score", grpc.StatusCode.UNAVAILABLE, "judge restarting", times=1, target=config.JUDGE)
    result = _shape(m.score_sample(_sample(1)))
    assert _judged(result), f"one UNAVAILABLE then a healthy judge: the retry must get the model's score, got {result}"
    assert result.get("attempts") == 2 and len(_calls(ctx)) == 2, f"one UNAVAILABLE earns one retry: expected 2 calls and attempts 2, saw {len(_calls(ctx))} calls and {result}"
    assert ctx.clock.sleeps >= 1, "a retry waits a backoff before the next attempt"
    ctx.grpc.fail("Score", grpc.StatusCode.UNAVAILABLE, "judge down", times=3, target=config.JUDGE)
    result = _shape(m.score_sample(_sample(2)))
    assert len(_calls(ctx)) == 5, f"a judge that stays UNAVAILABLE gets MAX_ATTEMPTS = 3 calls for the sample, saw {len(_calls(ctx)) - 2}"
    assert result.get("attempts") == 3 and result.get("judge") != "model", f"three failed attempts: attempts 3 and no model score, got {result}"


def check_fallback_metric(ctx):
    m = _world(ctx)
    ctx.grpc.set_latency("Score", 5.0, config.JUDGE)  # the judge hangs
    started = ctx.clock.offset
    result = _shape(m.score_sample(_sample(1, expected="Paris", output=" paris ")))
    waited = ctx.clock.offset - started
    assert result.get("judge") == "fallback" and result.get("status") == "scored", f"the judge hung on every attempt and the sample came back {result}: score it with exact_match and mark it judge 'fallback'"
    assert result.get("score") == 1.0, f"exact_match(' paris ', 'Paris') is 1.0 (trimmed, case-insensitive), got {result}"
    assert waited <= 3.5, f"the worker waited {waited:.1f} s on a judge that hangs: three 800 ms attempts and their backoffs, then the fallback"
    ctx.grpc.set_latency("Score", 0.0, config.JUDGE)
    ctx.grpc.fail("Score", grpc.StatusCode.UNAVAILABLE, "judge down", times=3, target=config.JUDGE)
    result = _shape(m.score_sample(_sample(2)))
    assert result.get("judge") == "fallback" and result.get("score") == 0.0, f"with the judge UNAVAILABLE, 'The capital of France is Paris.' against 'Paris' is an exact_match 0.0 marked fallback, got {result}"


def check_invalid_argument(ctx):
    m = _world(ctx)
    ctx.grpc.fail("Score", grpc.StatusCode.INVALID_ARGUMENT, "output exceeds the judge's context", times=1, target=config.JUDGE)
    result = _shape(m.score_sample(_sample(1)))
    assert result.get("status") == "invalid", f"INVALID_ARGUMENT is the sample's fault and must come back status 'invalid', got {result}"
    assert len(_calls(ctx)) == 1 and ctx.clock.sleeps == 0, f"no retry fixes an invalid sample: expected 1 call and no backoff, saw {len(_calls(ctx))} calls and {ctx.clock.sleeps} sleeps"
    assert result.get("judge") != "fallback", f"an invalid sample is reported, not scored by the fallback: {result}"
    ctx.grpc.fail("Score", grpc.StatusCode.INVALID_ARGUMENT, "malformed sample", times=5, target=config.JUDGE)
    for n in range(2, 7):
        assert _shape(m.score_sample(_sample(n))).get("status") == "invalid"
    result = _shape(m.score_sample(_sample(7)))
    assert _judged(result) and len(_calls(ctx)) == 7, f"five invalid samples are not judge failures: the breaker stays closed and the next sample reaches the judge, got {result} after {len(_calls(ctx))} calls"


def check_breaker(ctx):
    m = _world(ctx)
    ctx.grpc.fail("Score", grpc.StatusCode.UNAVAILABLE, "judge down", times=5, target=config.JUDGE)
    first = _shape(m.score_sample(_sample(1)))
    assert first.get("judge") == "fallback" and len(_calls(ctx)) == 3, f"the judge is down: the first sample makes 3 calls and falls back, saw {len(_calls(ctx))} calls and {first}"
    second = _shape(m.score_sample(_sample(2)))
    assert second.get("judge") == "fallback" and len(_calls(ctx)) == 5, f"the fifth failed attempt in a row opens the breaker (BREAKER_FAILURES = 5, asked before each attempt): the second sample makes 2 calls and falls back, saw {len(_calls(ctx)) - 3} calls and {second}"
    for n in range(3, 7):
        assert _shape(m.score_sample(_sample(n))).get("judge") == "fallback"
    assert len(_calls(ctx)) == 5, f"while the breaker is open samples skip the judge, yet {len(_calls(ctx)) - 5} calls went out"
    ctx.clock.advance(10)
    assert _shape(m.score_sample(_sample(7))).get("judge") == "fallback" and len(_calls(ctx)) == 5, "ten seconds into a 30 s cooldown the breaker is still open"
    ctx.clock.advance(21)
    result = _shape(m.score_sample(_sample(8)))
    assert _judged(result) and len(_calls(ctx)) == 6, f"after the 30 s cooldown a trial call reaches the judge, which is back: got {result} after {len(_calls(ctx))} calls"
`,
    typescript: `const sample = (n: number, expected = 'Paris', output = 'The capital of France is Paris.') => ({run_id: 'r1', sample_id: \`s-\${n}\`, expected, output});

/** The stand-in judge at JUDGE, then the learner's module. */
function world(ctx) {
  const {evals} = ctx.proto('judge.proto');
  const config = ctx.load('/support/evals/config.ts');
  const judge = ctx.load('/support/evals/judge.ts');
  ctx.grpc.serve(evals.Judge.service, {
    Score(call, callback) {
      callback(null, {score: judge.grade(call.request.expected, call.request.output), judge_version: judge.JUDGE_VERSION});
    },
  }, config.JUDGE);
  return {m: ctx.load('client'), config};
}

const calls = ctx => ctx.grpc.callsTo('Score');
const judged = (result, score = 0.75) => result?.status === 'scored' && result?.judge === 'model' && Math.abs(Number(result?.score) - score) < 1e-9;

export async function check_deadline(ctx) {
  const {m, config} = world(ctx);
  let result = await m.scoreSample(sample(1));
  assert(judged(result), \`a healthy judge grades 'Paris' in '...is Paris.' 0.75: expected status scored, judge model, score 0.75, got \${JSON.stringify(result)}\`);
  assert.equal(result.attempts, 1, \`a healthy judge is called once (attempts 1), got \${JSON.stringify(result)}\`);
  assert.equal(calls(ctx).length, 1, \`a healthy judge must be called exactly once, saw \${calls(ctx).length} Score calls\`);
  const call = calls(ctx)[0];
  assert(call.timeout !== null && call.timeout !== undefined, 'the Score call carries no deadline: a judge that hangs holds the worker for as long as it hangs');
  assert(0.6 <= call.timeout && call.timeout <= 1.0, \`the deadline must be DEADLINE_MS = 800 ms, got \${call.timeout} s\`);
  ctx.grpc.setLatency('Score', 0.5, config.JUDGE);
  result = await m.scoreSample(sample(2));
  assert(judged(result) && calls(ctx).length === 2, \`a judge answering in 500 ms is within the deadline and used on the first call: \${calls(ctx).length} calls, \${JSON.stringify(result)}\`);
}

export async function check_retry_unavailable(ctx) {
  const {m, config} = world(ctx);
  ctx.grpc.fail('Score', ctx.grpc.status.UNAVAILABLE, 'judge restarting', 1, config.JUDGE);
  let result = await m.scoreSample(sample(1));
  assert(judged(result), \`one UNAVAILABLE then a healthy judge: the retry must get the model's score, got \${JSON.stringify(result)}\`);
  assert(result.attempts === 2 && calls(ctx).length === 2, \`one UNAVAILABLE earns one retry: expected 2 calls and attempts 2, saw \${calls(ctx).length} calls and \${JSON.stringify(result)}\`);
  assert(ctx.clock.sleeps >= 1, 'a retry waits a backoff before the next attempt');
  ctx.grpc.fail('Score', ctx.grpc.status.UNAVAILABLE, 'judge down', 3, config.JUDGE);
  result = await m.scoreSample(sample(2));
  assert.equal(calls(ctx).length, 5, \`a judge that stays UNAVAILABLE gets MAX_ATTEMPTS = 3 calls for the sample, saw \${calls(ctx).length - 2}\`);
  assert(result?.attempts === 3 && result?.judge !== 'model', \`three failed attempts: attempts 3 and no model score, got \${JSON.stringify(result)}\`);
}

export async function check_fallback_metric(ctx) {
  const {m, config} = world(ctx);
  ctx.grpc.setLatency('Score', 5.0, config.JUDGE); // the judge hangs
  const started = ctx.clock.now();
  let result = await m.scoreSample(sample(1, 'Paris', ' paris '));
  const waited = (ctx.clock.now() - started) / 1000;
  assert(result?.judge === 'fallback' && result?.status === 'scored', \`the judge hung on every attempt and the sample came back \${JSON.stringify(result)}: score it with exactMatch and mark it judge 'fallback'\`);
  assert.equal(result.score, 1, \`exactMatch(' paris ', 'Paris') is 1 (trimmed, case-insensitive), got \${JSON.stringify(result)}\`);
  assert(waited <= 3.5, \`the worker waited \${waited.toFixed(1)} s on a judge that hangs: three 800 ms attempts and their backoffs, then the fallback\`);
  ctx.grpc.setLatency('Score', 0, config.JUDGE);
  ctx.grpc.fail('Score', ctx.grpc.status.UNAVAILABLE, 'judge down', 3, config.JUDGE);
  result = await m.scoreSample(sample(2));
  assert(result?.judge === 'fallback' && result?.score === 0, \`with the judge UNAVAILABLE, 'The capital of France is Paris.' against 'Paris' is an exactMatch 0 marked fallback, got \${JSON.stringify(result)}\`);
}

export async function check_invalid_argument(ctx) {
  const {m, config} = world(ctx);
  ctx.grpc.fail('Score', ctx.grpc.status.INVALID_ARGUMENT, "output exceeds the judge's context", 1, config.JUDGE);
  let result = await m.scoreSample(sample(1));
  assert.equal(result?.status, 'invalid', \`INVALID_ARGUMENT is the sample's fault and must come back status 'invalid', got \${JSON.stringify(result)}\`);
  assert(calls(ctx).length === 1 && ctx.clock.sleeps === 0, \`no retry fixes an invalid sample: expected 1 call and no backoff, saw \${calls(ctx).length} calls and \${ctx.clock.sleeps} sleeps\`);
  assert.notEqual(result.judge, 'fallback', \`an invalid sample is reported, not scored by the fallback: \${JSON.stringify(result)}\`);
  ctx.grpc.fail('Score', ctx.grpc.status.INVALID_ARGUMENT, 'malformed sample', 5, config.JUDGE);
  for (let n = 2; n <= 6; n += 1) assert.equal((await m.scoreSample(sample(n)))?.status, 'invalid');
  result = await m.scoreSample(sample(7));
  assert(judged(result) && calls(ctx).length === 7, \`five invalid samples are not judge failures: the breaker stays closed and the next sample reaches the judge, got \${JSON.stringify(result)} after \${calls(ctx).length} calls\`);
}

export async function check_breaker(ctx) {
  const {m, config} = world(ctx);
  ctx.grpc.fail('Score', ctx.grpc.status.UNAVAILABLE, 'judge down', 5, config.JUDGE);
  const first = await m.scoreSample(sample(1));
  assert(first?.judge === 'fallback' && calls(ctx).length === 3, \`the judge is down: the first sample makes 3 calls and falls back, saw \${calls(ctx).length} calls and \${JSON.stringify(first)}\`);
  const second = await m.scoreSample(sample(2));
  assert(second?.judge === 'fallback' && calls(ctx).length === 5, \`the fifth failed attempt in a row opens the breaker (BREAKER_FAILURES = 5, asked before each attempt): the second sample makes 2 calls and falls back, saw \${calls(ctx).length - 3} calls and \${JSON.stringify(second)}\`);
  for (let n = 3; n <= 6; n += 1) assert.equal((await m.scoreSample(sample(n)))?.judge, 'fallback');
  assert.equal(calls(ctx).length, 5, \`while the breaker is open samples skip the judge, yet \${calls(ctx).length - 5} calls went out\`);
  ctx.clock.advance(10);
  assert((await m.scoreSample(sample(7)))?.judge === 'fallback' && calls(ctx).length === 5, 'ten seconds into a 30 s cooldown the breaker is still open');
  ctx.clock.advance(21);
  const result = await m.scoreSample(sample(8));
  assert(judged(result) && calls(ctx).length === 6, \`after the 30 s cooldown a trial call reaches the judge, which is back: got \${JSON.stringify(result)} after \${calls(ctx).length} calls\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"math"
	"time"

	"google.golang.org/grpc/codes"

	"evals/config"
	pb "evals/gen/judge"
	"evals/judge"
	"evals/samples"

	"leetbuild/harness"
)

// judgePeer is the stand-in judge: grades from evals/judge.
type judgePeer struct {
	pb.UnimplementedJudgeServer
}

func (judgePeer) Score(_ context.Context, req *pb.ScoreRequest) (*pb.ScoreReply, error) {
	return &pb.ScoreReply{Score: judge.Grade(req.GetExpected(), req.GetOutput()), JudgeVersion: judge.Version}, nil
}

func clientWorld(ctx *harness.Ctx) {
	pb.RegisterJudgeServer(ctx.GRPC.Server(config.Judge), &judgePeer{})
}

func clientSample(n int, expected, output string) samples.GoldenSample {
	return samples.GoldenSample{RunID: "r1", SampleID: fmt.Sprintf("s-%d", n), Expected: expected, Output: output}
}

func clientScore(n int) SampleScore {
	return scoreSample(context.Background(), clientSample(n, "Paris", "The capital of France is Paris."))
}

func clientCalls(ctx *harness.Ctx) int { return len(ctx.GRPC.CallsTo("Score", "")) }

func clientJudged(s SampleScore) bool {
	return s.Status == "scored" && s.Judge == "model" && math.Abs(s.Score-0.75) < 1e-9
}

func CheckDeadline(ctx *harness.Ctx) {
	clientWorld(ctx)
	result := clientScore(1)
	ctx.Assert(clientJudged(result), "a healthy judge grades 'Paris' in '...is Paris.' 0.75: expected status scored, judge model, score 0.75, got %+v", result)
	ctx.Equal(result.Attempts, 1, "a healthy judge is called once; attempts")
	calls := ctx.GRPC.CallsTo("Score", "")
	ctx.Equal(len(calls), 1, "a healthy judge must be called exactly once; Score calls")
	ctx.Assert(calls[0].HasDeadline(), "the Score call carries no deadline: a judge that hangs holds the worker for as long as it hangs")
	ctx.Assert(600*time.Millisecond <= calls[0].Timeout && calls[0].Timeout <= time.Second, "the deadline must be 800 ms, got %v", calls[0].Timeout)
	ctx.GRPC.SetLatency("Score", 0.5, config.Judge)
	result = clientScore(2)
	ctx.Assert(clientJudged(result) && clientCalls(ctx) == 2, "a judge answering in 500 ms is within the deadline and used on the first call: %d calls, %+v", clientCalls(ctx), result)
}

func CheckRetryUnavailable(ctx *harness.Ctx) {
	clientWorld(ctx)
	ctx.GRPC.Fail("Score", codes.Unavailable, "judge restarting", 1, config.Judge)
	result := clientScore(1)
	ctx.Assert(clientJudged(result), "one UNAVAILABLE then a healthy judge: the retry must get the model's score, got %+v", result)
	ctx.Assert(result.Attempts == 2 && clientCalls(ctx) == 2, "one UNAVAILABLE earns one retry: expected 2 calls and Attempts 2, saw %d calls and %+v", clientCalls(ctx), result)
	ctx.Assert(ctx.Clock.Sleeps() >= 1, "a retry waits a backoff before the next attempt")
	ctx.GRPC.Fail("Score", codes.Unavailable, "judge down", 3, config.Judge)
	result = clientScore(2)
	ctx.Equal(clientCalls(ctx), 5, "a judge that stays UNAVAILABLE gets maxAttempts = 3 calls for the sample; calls so far")
	ctx.Assert(result.Attempts == 3 && result.Judge != "model", "three failed attempts: Attempts 3 and no model score, got %+v", result)
}

func CheckFallbackMetric(ctx *harness.Ctx) {
	clientWorld(ctx)
	ctx.GRPC.SetLatency("Score", 5.0, config.Judge) // the judge hangs
	started := ctx.Clock.Now()
	result := scoreSample(context.Background(), clientSample(1, "Paris", " paris "))
	waited := float64(ctx.Clock.Now()-started) / 1000
	ctx.Assert(result.Judge == "fallback" && result.Status == "scored", "the judge hung on every attempt and the sample came back %+v: score it with metrics.ExactMatch and mark it Judge \\"fallback\\"", result)
	ctx.Equal(result.Score, 1.0, "metrics.ExactMatch(\\"Paris\\", \\" paris \\") is 1 (trimmed, case-insensitive); the score")
	ctx.Assert(waited <= 3.5, "the worker waited %.1f s on a judge that hangs: three 800 ms attempts and their backoffs, then the fallback", waited)
	ctx.GRPC.SetLatency("Score", 0, config.Judge)
	ctx.GRPC.Fail("Score", codes.Unavailable, "judge down", 3, config.Judge)
	result = clientScore(2)
	ctx.Assert(result.Judge == "fallback" && result.Score == 0, "with the judge UNAVAILABLE, 'The capital of France is Paris.' against 'Paris' is an ExactMatch 0 marked fallback, got %+v", result)
}

func CheckInvalidArgument(ctx *harness.Ctx) {
	clientWorld(ctx)
	ctx.GRPC.Fail("Score", codes.InvalidArgument, "output exceeds the judge's context", 1, config.Judge)
	result := clientScore(1)
	ctx.Equal(result.Status, "invalid", "INVALID_ARGUMENT is the sample's fault (%+v); the status", result)
	ctx.Assert(clientCalls(ctx) == 1 && ctx.Clock.Sleeps() == 0, "no retry fixes an invalid sample: expected 1 call and no backoff, saw %d calls and %d sleeps", clientCalls(ctx), ctx.Clock.Sleeps())
	ctx.Assert(result.Judge != "fallback", "an invalid sample is reported, not scored by the fallback: %+v", result)
	ctx.GRPC.Fail("Score", codes.InvalidArgument, "malformed sample", 5, config.Judge)
	for n := 2; n <= 6; n++ {
		ctx.Equal(clientScore(n).Status, "invalid", "sample %d's status", n)
	}
	result = clientScore(7)
	ctx.Assert(clientJudged(result) && clientCalls(ctx) == 7, "five invalid samples are not judge failures: the breaker stays closed and the next sample reaches the judge, got %+v after %d calls", result, clientCalls(ctx))
}

func CheckBreaker(ctx *harness.Ctx) {
	clientWorld(ctx)
	ctx.GRPC.Fail("Score", codes.Unavailable, "judge down", 5, config.Judge)
	first := clientScore(1)
	ctx.Assert(first.Judge == "fallback" && clientCalls(ctx) == 3, "the judge is down: the first sample makes 3 calls and falls back, saw %d calls and %+v", clientCalls(ctx), first)
	second := clientScore(2)
	ctx.Assert(second.Judge == "fallback" && clientCalls(ctx) == 5, "the fifth failed attempt in a row opens the breaker (breakerFailures = 5, asked before each attempt): the second sample makes 2 calls and falls back, saw %d calls and %+v", clientCalls(ctx)-3, second)
	for n := 3; n <= 6; n++ {
		ctx.Equal(clientScore(n).Judge, "fallback", "sample %d's judge with the breaker open", n)
	}
	ctx.Equal(clientCalls(ctx), 5, "while the breaker is open samples skip the judge; calls")
	ctx.Clock.Advance(10)
	ctx.Assert(clientScore(7).Judge == "fallback" && clientCalls(ctx) == 5, "ten seconds into a 30 s cooldown the breaker is still open")
	ctx.Clock.Advance(21)
	result := clientScore(8)
	ctx.Assert(clientJudged(result) && clientCalls(ctx) == 6, "after the 30 s cooldown a trial call reaches the judge, which is back: got %+v after %d calls", result, clientCalls(ctx))
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <cmath>
#include <string>

#include "evals/judge.h"

namespace {

// The stand-in judge: grades from evals/judge.h.
class JudgePeer final : public evals::Judge::Service {
 public:
  grpc::Status Score(grpc::ServerContext*, const evals::ScoreRequest* req, evals::ScoreReply* reply) override {
    reply->set_score(judge::grade(req->expected(), req->output()));
    reply->set_judge_version(judge::kVersion);
    return grpc::Status::OK;
  }
};

void clientWorld(harness::Ctx& ctx) {
  static JudgePeer peer;
  ctx.GRPC.Server(config::kJudge)->RegisterService(&peer);
}

samples::GoldenSample clientSample(int n, const std::string& expected = "Paris", const std::string& output = "The capital of France is Paris.") {
  return {"r1", "s-" + std::to_string(n), expected, output};
}

size_t clientCalls(harness::Ctx& ctx) { return ctx.GRPC.CallsTo("Score").size(); }

bool clientJudged(const SampleScore& s) { return s.status == "scored" && s.judge == "model" && std::fabs(s.score - 0.75) < 1e-9; }

std::string show(const SampleScore& s) {
  return "{status " + s.status + ", score " + harness::FormatFloat(s.score) + ", judge " + s.judge + ", attempts " + std::to_string(s.attempts) + "}";
}

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  clientWorld(ctx);
  SampleScore result = score_sample(clientSample(1));
  ctx.Assert(clientJudged(result), "a healthy judge grades 'Paris' in '...is Paris.' 0.75: expected status scored, judge model, score 0.75, got %s", show(result));
  ctx.Equal(result.attempts, 1, "a healthy judge is called once; attempts");
  const auto calls = ctx.GRPC.CallsTo("Score");
  ctx.Equal(calls.size(), 1, "a healthy judge must be called exactly once; Score calls");
  ctx.Assert(calls[0].HasDeadline(), "the Score call carries no deadline: a judge that hangs holds the worker for as long as it hangs");
  ctx.Assert(0.6 <= calls[0].TimeoutSeconds() && calls[0].TimeoutSeconds() <= 1.0, "the deadline must be 800 ms, got %vs", calls[0].TimeoutSeconds());
  ctx.GRPC.SetLatency("Score", 0.5, config::kJudge);
  result = score_sample(clientSample(2));
  ctx.Assert(clientJudged(result) && clientCalls(ctx) == 2, "a judge answering in 500 ms is within the deadline and used on the first call: %d calls, %s", clientCalls(ctx), show(result));
}

void CheckRetryUnavailable(harness::Ctx& ctx) {
  clientWorld(ctx);
  ctx.GRPC.Fail("Score", grpc::StatusCode::UNAVAILABLE, "judge restarting", 1, config::kJudge);
  SampleScore result = score_sample(clientSample(1));
  ctx.Assert(clientJudged(result), "one UNAVAILABLE then a healthy judge: the retry must get the model's score, got %s", show(result));
  ctx.Assert(result.attempts == 2 && clientCalls(ctx) == 2, "one UNAVAILABLE earns one retry: expected 2 calls and attempts 2, saw %d calls and %s", clientCalls(ctx), show(result));
  ctx.Assert(ctx.Clock.Sleeps() >= 1, "a retry waits a backoff before the next attempt");
  ctx.GRPC.Fail("Score", grpc::StatusCode::UNAVAILABLE, "judge down", 3, config::kJudge);
  result = score_sample(clientSample(2));
  ctx.Equal(clientCalls(ctx), 5, "a judge that stays UNAVAILABLE gets kMaxAttempts = 3 calls for the sample; calls so far");
  ctx.Assert(result.attempts == 3 && result.judge != "model", "three failed attempts: attempts 3 and no model score, got %s", show(result));
}

void CheckFallbackMetric(harness::Ctx& ctx) {
  clientWorld(ctx);
  ctx.GRPC.SetLatency("Score", 5.0, config::kJudge);  // the judge hangs
  const int64_t started = ctx.Clock.Now();
  SampleScore result = score_sample(clientSample(1, "Paris", " paris "));
  const double waited = static_cast<double>(ctx.Clock.Now() - started) / 1000;
  ctx.Assert(result.judge == "fallback" && result.status == "scored", "the judge hung on every attempt and the sample came back %s: score it with metrics::exact_match and mark it judge \\"fallback\\"", show(result));
  ctx.Equal(result.score, 1.0, "metrics::exact_match(\\"Paris\\", \\" paris \\") is 1 (trimmed, case-insensitive); the score");
  ctx.Assert(waited <= 3.5, "the worker waited %.1f s on a judge that hangs: three 800 ms attempts and their backoffs, then the fallback", waited);
  ctx.GRPC.SetLatency("Score", 0, config::kJudge);
  ctx.GRPC.Fail("Score", grpc::StatusCode::UNAVAILABLE, "judge down", 3, config::kJudge);
  result = score_sample(clientSample(2));
  ctx.Assert(result.judge == "fallback" && result.score == 0, "with the judge UNAVAILABLE, 'The capital of France is Paris.' against 'Paris' is an exact_match 0 marked fallback, got %s", show(result));
}

void CheckInvalidArgument(harness::Ctx& ctx) {
  clientWorld(ctx);
  ctx.GRPC.Fail("Score", grpc::StatusCode::INVALID_ARGUMENT, "output exceeds the judge's context", 1, config::kJudge);
  SampleScore result = score_sample(clientSample(1));
  ctx.Equal(result.status, "invalid", "INVALID_ARGUMENT is the sample's fault (%s); the status", show(result));
  ctx.Assert(clientCalls(ctx) == 1 && ctx.Clock.Sleeps() == 0, "no retry fixes an invalid sample: expected 1 call and no backoff, saw %d calls and %d sleeps", clientCalls(ctx), ctx.Clock.Sleeps());
  ctx.Assert(result.judge != "fallback", "an invalid sample is reported, not scored by the fallback: %s", show(result));
  ctx.GRPC.Fail("Score", grpc::StatusCode::INVALID_ARGUMENT, "malformed sample", 5, config::kJudge);
  for (int n = 2; n <= 6; n++) ctx.Equal(score_sample(clientSample(n)).status, "invalid", "sample %d's status", n);
  result = score_sample(clientSample(7));
  ctx.Assert(clientJudged(result) && clientCalls(ctx) == 7, "five invalid samples are not judge failures: the breaker stays closed and the next sample reaches the judge, got %s after %d calls", show(result), clientCalls(ctx));
}

void CheckBreaker(harness::Ctx& ctx) {
  clientWorld(ctx);
  ctx.GRPC.Fail("Score", grpc::StatusCode::UNAVAILABLE, "judge down", 5, config::kJudge);
  const SampleScore first = score_sample(clientSample(1));
  ctx.Assert(first.judge == "fallback" && clientCalls(ctx) == 3, "the judge is down: the first sample makes 3 calls and falls back, saw %d calls and %s", clientCalls(ctx), show(first));
  const SampleScore second = score_sample(clientSample(2));
  ctx.Assert(second.judge == "fallback" && clientCalls(ctx) == 5, "the fifth failed attempt in a row opens the breaker (kBreakerFailures = 5, asked before each attempt): the second sample makes 2 calls and falls back, saw %d calls and %s", clientCalls(ctx) - 3, show(second));
  for (int n = 3; n <= 6; n++) ctx.Equal(score_sample(clientSample(n)).judge, "fallback", "sample %d's judge with the breaker open", n);
  ctx.Equal(clientCalls(ctx), 5, "while the breaker is open samples skip the judge; calls");
  ctx.Clock.Advance(10);
  ctx.Assert(score_sample(clientSample(7)).judge == "fallback" && clientCalls(ctx) == 5, "ten seconds into a 30 s cooldown the breaker is still open");
  ctx.Clock.Advance(21);
  const SampleScore result = score_sample(clientSample(8));
  ctx.Assert(clientJudged(result) && clientCalls(ctx) == 6, "after the 30 s cooldown a trial call reaches the judge, which is back: got %s after %d calls", show(result), clientCalls(ctx));
}
`,
  },
  debrief: `The loop's shape comes from sorting the judge's answers by whose fault they are. \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` are the judge's: worth a bounded retry, then a cheaper score that keeps the run moving, marked so the gate can discount it. \`INVALID_ARGUMENT\` is the sample's, and no retry fixes it. The deadline belongs on each call, because only the call can be cut. The breaker turns a down judge from three wasted calls per sample into none, and the trial call after the cooldown is how the worker learns the judge is back. Production harnesses also cache judge scores by judge version, sample and output so a rerun costs nothing, and record the judge version in the run so a judge upgrade cannot move the pass rate unnoticed.`,
};
