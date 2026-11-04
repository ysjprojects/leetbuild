import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Judge calls: a deadline, bounded retries, parked instead of passed',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'judge', 'redis'],
  task: `## Task

**Starting point.** The starter's \`judge_record(state, record)\` sends the provided \`SyntheticRecord\`'s
text to \`Judge.Score\` (\`synthetic_data.proto\`, a stand-in at \`synth/config\`'s \`JUDGE\`) and settles the
record through the step-2 state with its seed digest. It retries any error and any refusal up to
\`RETRY_LIMIT\` times with no deadline, admits with \`DEFAULT_SCORE\` when the attempts run out, and skips
the judge for records past \`JUDGE_PREFIX\` (100). Against a healthy judge it admits after one call. It
hides 5 flaws.

**Failure mode the checks target.** A judge that is slow rather than down: with no deadline every
record waits it out, and with a default score every failure becomes an admitted record nobody scored.
Retrying a refusal asks the same question three times. The prefix makes a job look fully judged when
only its first hundred records were.

\`\`\`proto
service Judge { rpc Score(ScoreRequest) returns (ScoreReply); }
message ScoreRequest { string record_id = 1; string recipe_id = 2; string text = 3; }
message ScoreReply   { double score = 1; bool refused = 2; string judge_version = 3; }
\`\`\`

- Every attempt carries a **900 ms deadline**. \`DEADLINE_EXCEEDED\` parks the record (reason
  \`judge_timeout\`) after one call.
- Only \`UNAVAILABLE\` is retried, at most \`MAX_ATTEMPTS\` (3) calls with a backoff; still unavailable
  parks it (\`judge_unavailable\`). Any other status rejects it, reason the status name.
- A refusal is terminal: \`rejected\`, reason \`refused\`, one call.
- Only a judge's answer admits, with its \`score\` and \`judge_version\`, whatever the record's \`seq\`.
- One \`state.settle\` per record; the result is \`{status, reason, attempts, score, judge_version}\`.`,
  sequence: {
    participants: ['Worker', 'Judge', 'Job state'],
    messages: [
      {from: 'Worker', to: 'Judge', label: 'Score · deadline 900 ms', kind: 'sync'},
      {from: 'Judge', to: 'Worker', label: 'UNAVAILABLE', kind: 'reply'},
      {from: 'Worker', to: 'Judge', label: 'Score · attempt 2 after backoff', kind: 'sync'},
      {from: 'Judge', to: 'Worker', label: 'DEADLINE_EXCEEDED', kind: 'reply'},
      {from: 'Worker', to: 'Job state', label: 'settle(job, record, entity, parked, digest)', kind: 'sync'},
    ],
  },
  hints: [
    'Symptom: when the judge slows down, every record takes seconds and still comes out admitted with score 0.5; a refused record is asked three times and admitted anyway; records after the hundredth are admitted without a judge call.',
    'Mechanism: the call has no deadline, so a slow judge is waited out; the loop retries every status and every refusal, and the fall-through admits with DEFAULT_SCORE; the `seq >= JUDGE_PREFIX` branch settles before any call.',
    'Change: drop the prefix branch and the default score; `timeout=DEADLINE_S` on each call; retry only UNAVAILABLE while `attempt < MAX_ATTEMPTS` with a backoff; DEADLINE_EXCEEDED or a last UNAVAILABLE settles parked, a refusal or another status settles rejected.',
  ],
  checks: [
    {
      id: 'attempt-deadline',
      title: '900 ms deadline on every attempt',
      detail:
        'Each Score call carries a deadline of about 900 ms (DEADLINE_S as timeout=, a deadline: Date.now() + DEADLINE_MS, context.WithTimeout, withDeadlineAfter, set_deadline); a judge that answers in 600 ms admits the record with its score. The starter sends no deadline.',
      match: {
        python: {all: [/DEADLINE_S/, /timeout\s*=\s*DEADLINE_S/]},
        typescript: {all: [/DEADLINE_MS/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/]},
        go: {all: [/deadline\b/, /context\.WithTimeout\(/]},
        scala: {all: [/DeadlineMs/, /withDeadlineAfter\(/]},
        cpp: {all: [/kDeadline/, /set_deadline\(/]},
      },
    },
    {
      id: 'park-timeout',
      title: 'Parks a timed-out record instead of admitting it',
      detail:
        'A judge that hangs past the deadline ends the call DEADLINE_EXCEEDED after about 900 ms; the record is settled parked with reason judge_timeout, never admitted with a made-up score. The starter waits the hang out, and on failures admits with DEFAULT_SCORE.',
      match: {
        python: {all: [/grpc\.StatusCode\.DEADLINE_EXCEEDED/, /judge_timeout/], none: [/DEFAULT_SCORE/]},
        typescript: {all: [/status\.DEADLINE_EXCEEDED/, /judge_timeout/], none: [/DEFAULT_SCORE/]},
        go: {all: [/codes\.DeadlineExceeded/, /judge_timeout/], none: [/defaultScore/]},
        scala: {all: [/Status\.Code\.DEADLINE_EXCEEDED/, /judge_timeout/], none: [/DefaultScore/]},
        cpp: {all: [/grpc::StatusCode::DEADLINE_EXCEEDED/, /judge_timeout/], none: [/kDefaultScore/]},
      },
    },
    {
      id: 'retry-unavailable',
      title: 'Retries only UNAVAILABLE, at most three calls',
      detail:
        'One UNAVAILABLE earns a retry after a backoff and the record is admitted on the second call; three in a row park it as judge_unavailable after exactly three calls; INVALID_ARGUMENT rejects it after one. The starter retries every status and then admits.',
      match: {
        python: {all: [/grpc\.StatusCode\.UNAVAILABLE/, /MAX_ATTEMPTS/], none: [/RETRY_LIMIT/]},
        typescript: {all: [/status\.UNAVAILABLE/, /MAX_ATTEMPTS/], none: [/RETRY_LIMIT/]},
        go: {all: [/codes\.Unavailable/, /maxAttempts/], none: [/retryLimit/]},
        scala: {all: [/Status\.Code\.UNAVAILABLE/, /MaxAttempts/], none: [/RetryLimit/]},
        cpp: {all: [/grpc::StatusCode::UNAVAILABLE/, /kMaxAttempts/], none: [/kRetryLimit/]},
      },
    },
    {
      id: 'refusal-terminal',
      title: 'Rejects a refused record after one call',
      detail:
        'A refusal ends the record after one call as rejected with reason refused, settled once. The starter asks again and admits the record with the default score when the judge keeps refusing.',
      match: {
        python: {all: [/reply\.refused/, /["']refused["']/]},
        typescript: {all: [/\.refused\b/, /['"]refused['"]/]},
        go: {all: [/GetRefused\(\)/, /"refused"/]},
        scala: {all: [/\.refused\b/, /"refused"/]},
        cpp: {all: [/\.refused\(\)/, /"refused"/]},
      },
    },
    {
      id: 'judge-every-record',
      title: 'Judges every record, not a prefix',
      detail:
        "A record with seq 250 is sent to the judge and admitted with the judge's score and version (a refused one is rejected). The starter admits every record past JUDGE_PREFIX without a call.",
      match: {
        python: {all: [/stub\.Score\(/], none: [/JUDGE_PREFIX/]},
        typescript: {all: [/stub\.Score\(/], none: [/JUDGE_PREFIX/]},
        go: {all: [/stub\.Score\(/], none: [/judgePrefix/]},
        scala: {all: [/\.score\(/], none: [/JudgePrefix/]},
        cpp: {all: [/->Score\(/], none: [/kJudgePrefix/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
import time

import grpc

import synthetic_data_pb2
import synthetic_data_pb2_grpc
from synth.config import JUDGE
from synth.records import SyntheticRecord, seed_digest

logger = logging.getLogger("synthd.judge")

RETRY_LIMIT = 3
BACKOFF_S = 0.1
JUDGE_PREFIX = 100
DEFAULT_SCORE = 0.5

channel = grpc.insecure_channel(JUDGE)
stub = synthetic_data_pb2_grpc.JudgeStub(channel)


def judge_record(state, record: SyntheticRecord) -> dict:
    """Score one generated record and settle it: admitted with the judge's score, parked or rejected."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    digest = seed_digest(record.seed_text)
    if record.seq >= JUDGE_PREFIX:
        state.settle(record.job_id, record.record_id, record.entity_id, "admitted", digest)
        return {"status": "admitted", "reason": "", "attempts": 0, "score": DEFAULT_SCORE, "judge_version": ""}
    request = synthetic_data_pb2.ScoreRequest(record_id=record.record_id, recipe_id=record.recipe_id, text=record.text)
    for attempt in range(1, RETRY_LIMIT + 1):
        try:
            reply = stub.Score(request)
        except grpc.RpcError as err:
            logger.warning("judge call failed record=%s code=%s", record.record_id, err.code())
            time.sleep(BACKOFF_S)
            continue
        if reply.refused:
            time.sleep(BACKOFF_S)
            continue
        state.settle(record.job_id, record.record_id, record.entity_id, "admitted", digest)
        return {"status": "admitted", "reason": "", "attempts": attempt, "score": reply.score, "judge_version": reply.judge_version}
    state.settle(record.job_id, record.record_id, record.entity_id, "admitted", digest)
    return {"status": "admitted", "reason": "", "attempts": RETRY_LIMIT, "score": DEFAULT_SCORE, "judge_version": ""}
`,
      solution: `import logging
import time

import grpc

import synthetic_data_pb2
import synthetic_data_pb2_grpc
from synth.config import JUDGE
from synth.records import SyntheticRecord, seed_digest

logger = logging.getLogger("synthd.judge")

DEADLINE_S = 0.9
MAX_ATTEMPTS = 3
BACKOFF_S = 0.1

channel = grpc.insecure_channel(JUDGE)
stub = synthetic_data_pb2_grpc.JudgeStub(channel)


def judge_record(state, record: SyntheticRecord) -> dict:
    """Score one generated record and settle it: admitted with the judge's score, parked or rejected."""

    def settle(outcome: str, reason: str, attempt: int, score: float = 0.0, judge_version: str = "") -> dict:
        state.settle(record.job_id, record.record_id, record.entity_id, outcome, seed_digest(record.seed_text))
        return {"status": outcome, "reason": reason, "attempts": attempt, "score": score, "judge_version": judge_version}

    request = synthetic_data_pb2.ScoreRequest(record_id=record.record_id, recipe_id=record.recipe_id, text=record.text)
    attempt = 0
    while True:
        attempt += 1
        try:
            reply = stub.Score(request, timeout=DEADLINE_S)
        except grpc.RpcError as err:
            code = err.code()
            if code == grpc.StatusCode.UNAVAILABLE and attempt < MAX_ATTEMPTS:
                time.sleep(BACKOFF_S * attempt)
                continue
            logger.warning("judge call failed record=%s code=%s attempt=%d", record.record_id, code, attempt)
            if code == grpc.StatusCode.DEADLINE_EXCEEDED:
                return settle("parked", "judge_timeout", attempt)
            if code == grpc.StatusCode.UNAVAILABLE:
                return settle("parked", "judge_unavailable", attempt)
            return settle("rejected", code.name.lower(), attempt)
        if reply.refused:
            return settle("rejected", "refused", attempt)
        return settle("admitted", "", attempt, reply.score, reply.judge_version)
`,
    },
    typescript: {
      starter: `import {setTimeout as sleep} from 'node:timers/promises';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {JUDGE} from 'synth/config';
import {type SyntheticRecord, seedDigest} from 'synth/records';

export const RETRY_LIMIT = 3;
export const BACKOFF_MS = 100;
export const JUDGE_PREFIX = 100;
export const DEFAULT_SCORE = 0.5;

interface ScoreRequest {
  record_id: string;
  recipe_id: string;
  text: string;
}
interface ScoreReply {
  score: number;
  refused: boolean;
  judge_version: string;
}
interface JudgeClient {
  Score(request: ScoreRequest, options?: {deadline: number}): Promise<ScoreReply>;
}

const {synthd} = grpc.loadPackageDefinition(protoLoader.loadSync('synthetic_data.proto')) as unknown as {
  synthd: {Judge: new (target: string, credentials: grpc.ChannelCredentials) => JudgeClient};
};
const stub = new synthd.Judge(JUDGE, grpc.credentials.createInsecure());

/** The step-2 job state the worker hands in: one settle per record. */
export interface JobState {
  settle(jobId: string, recordId: string, entityId: string, outcome: string, seedDigest: string): Promise<void>;
}

export interface Verdict {
  status: string;
  reason: string;
  attempts: number;
  score: number;
  judge_version: string;
}

/** Score one generated record and settle it: admitted with the judge's score, parked or rejected. */
export async function judgeRecord(state: JobState, record: SyntheticRecord): Promise<Verdict> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const digest = seedDigest(record.seed_text);
  if (record.seq >= JUDGE_PREFIX) {
    await state.settle(record.job_id, record.record_id, record.entity_id, 'admitted', digest);
    return {status: 'admitted', reason: '', attempts: 0, score: DEFAULT_SCORE, judge_version: ''};
  }
  const request = {record_id: record.record_id, recipe_id: record.recipe_id, text: record.text};
  for (let attempt = 1; attempt <= RETRY_LIMIT; attempt += 1) {
    let reply: ScoreReply;
    try {
      reply = await stub.Score(request);
    } catch (err) {
      console.warn(\`judge call failed record=\${record.record_id} code=\${(err as grpc.ServiceError).code}\`);
      await sleep(BACKOFF_MS);
      continue;
    }
    if (reply.refused) {
      await sleep(BACKOFF_MS);
      continue;
    }
    await state.settle(record.job_id, record.record_id, record.entity_id, 'admitted', digest);
    return {status: 'admitted', reason: '', attempts: attempt, score: reply.score, judge_version: reply.judge_version};
  }
  await state.settle(record.job_id, record.record_id, record.entity_id, 'admitted', digest);
  return {status: 'admitted', reason: '', attempts: RETRY_LIMIT, score: DEFAULT_SCORE, judge_version: ''};
}
`,
      solution: `import {setTimeout as sleep} from 'node:timers/promises';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {JUDGE} from 'synth/config';
import {type SyntheticRecord, seedDigest} from 'synth/records';

export const DEADLINE_MS = 900;
export const MAX_ATTEMPTS = 3;
export const BACKOFF_MS = 100;

interface ScoreRequest {
  record_id: string;
  recipe_id: string;
  text: string;
}
interface ScoreReply {
  score: number;
  refused: boolean;
  judge_version: string;
}
interface JudgeClient {
  Score(request: ScoreRequest, options?: {deadline: number}): Promise<ScoreReply>;
}

const {synthd} = grpc.loadPackageDefinition(protoLoader.loadSync('synthetic_data.proto')) as unknown as {
  synthd: {Judge: new (target: string, credentials: grpc.ChannelCredentials) => JudgeClient};
};
const stub = new synthd.Judge(JUDGE, grpc.credentials.createInsecure());

/** The step-2 job state the worker hands in: one settle per record. */
export interface JobState {
  settle(jobId: string, recordId: string, entityId: string, outcome: string, seedDigest: string): Promise<void>;
}

export interface Verdict {
  status: string;
  reason: string;
  attempts: number;
  score: number;
  judge_version: string;
}

/** Score one generated record and settle it: admitted with the judge's score, parked or rejected. */
export async function judgeRecord(state: JobState, record: SyntheticRecord): Promise<Verdict> {
  const settle = async (status: string, reason: string, attempts: number, score = 0, judgeVersion = ''): Promise<Verdict> => {
    await state.settle(record.job_id, record.record_id, record.entity_id, status, seedDigest(record.seed_text));
    return {status, reason, attempts, score, judge_version: judgeVersion};
  };

  const request = {record_id: record.record_id, recipe_id: record.recipe_id, text: record.text};
  for (let attempt = 1; ; attempt += 1) {
    let reply: ScoreReply;
    try {
      reply = await stub.Score(request, {deadline: Date.now() + DEADLINE_MS});
    } catch (err) {
      const {code} = err as grpc.ServiceError;
      if (code === grpc.status.UNAVAILABLE && attempt < MAX_ATTEMPTS) {
        await sleep(BACKOFF_MS * attempt);
        continue;
      }
      console.warn(\`judge call failed record=\${record.record_id} code=\${code} attempt=\${attempt}\`);
      if (code === grpc.status.DEADLINE_EXCEEDED) return settle('parked', 'judge_timeout', attempt);
      if (code === grpc.status.UNAVAILABLE) return settle('parked', 'judge_unavailable', attempt);
      const name = Object.keys(grpc.status).find(k => grpc.status[k as keyof typeof grpc.status] === code);
      return settle('rejected', (name ?? \`status_\${code}\`).toLowerCase(), attempt);
    }
    if (reply.refused) return settle('rejected', 'refused', attempt);
    return settle('admitted', '', attempt, reply.score, reply.judge_version);
  }
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

	pb "synth/gen/synthetic_data"
	"synth/config"  // config.Judge — provided
	"synth/records" // records.SyntheticRecord, records.SeedDigest — provided
)

const (
	retryLimit   = 3
	backoff      = 100 * time.Millisecond
	judgePrefix  = 100
	defaultScore = 0.5
)

var conn, _ = grpc.NewClient(config.Judge, grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewJudgeClient(conn)

// JobState is the step-2 job state the worker hands in: one Settle per record.
type JobState interface {
	Settle(ctx context.Context, jobID, recordID, entityID, outcome, seedDigest string) error
}

// Verdict is one record's outcome.
type Verdict struct {
	Status       string
	Reason       string
	Attempts     int
	Score        float64
	JudgeVersion string
}

// judgeRecord scores one generated record and settles it: admitted with the judge's score, parked or rejected.
func judgeRecord(ctx context.Context, state JobState, record records.SyntheticRecord) (Verdict, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	digest := records.SeedDigest(record.SeedText)
	if record.Seq >= judgePrefix {
		if err := state.Settle(ctx, record.JobID, record.RecordID, record.EntityID, "admitted", digest); err != nil {
			return Verdict{}, err
		}
		return Verdict{Status: "admitted", Score: defaultScore}, nil
	}
	request := &pb.ScoreRequest{RecordId: record.RecordID, RecipeId: record.RecipeID, Text: record.Text}
	for attempt := 1; attempt <= retryLimit; attempt++ {
		reply, err := stub.Score(ctx, request)
		if err != nil {
			log.Printf("judge call failed record=%s code=%s", record.RecordID, status.Code(err))
			time.Sleep(backoff)
			continue
		}
		if reply.GetRefused() {
			time.Sleep(backoff)
			continue
		}
		if err := state.Settle(ctx, record.JobID, record.RecordID, record.EntityID, "admitted", digest); err != nil {
			return Verdict{}, err
		}
		return Verdict{Status: "admitted", Attempts: attempt, Score: reply.GetScore(), JudgeVersion: reply.GetJudgeVersion()}, nil
	}
	if err := state.Settle(ctx, record.JobID, record.RecordID, record.EntityID, "admitted", digest); err != nil {
		return Verdict{}, err
	}
	return Verdict{Status: "admitted", Attempts: retryLimit, Score: defaultScore}, nil
}
`,
      solution: `package main

import (
	"context"
	"log"
	"strconv"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "synth/gen/synthetic_data"
	"synth/config"  // config.Judge — provided
	"synth/records" // records.SyntheticRecord, records.SeedDigest — provided
)

const (
	deadline    = 900 * time.Millisecond
	maxAttempts = 3
	backoff     = 100 * time.Millisecond
)

var conn, _ = grpc.NewClient(config.Judge, grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewJudgeClient(conn)

// JobState is the step-2 job state the worker hands in: one Settle per record.
type JobState interface {
	Settle(ctx context.Context, jobID, recordID, entityID, outcome, seedDigest string) error
}

// Verdict is one record's outcome.
type Verdict struct {
	Status       string
	Reason       string
	Attempts     int
	Score        float64
	JudgeVersion string
}

// reasonOf names a status the way the other runtimes do (INVALID_ARGUMENT → invalid_argument).
func reasonOf(code codes.Code) string {
	switch code {
	case codes.InvalidArgument:
		return "invalid_argument"
	case codes.ResourceExhausted:
		return "resource_exhausted"
	case codes.PermissionDenied:
		return "permission_denied"
	}
	return "status_" + strconv.Itoa(int(code))
}

// judgeRecord scores one generated record and settles it: admitted with the judge's score, parked or rejected.
func judgeRecord(ctx context.Context, state JobState, record records.SyntheticRecord) (Verdict, error) {
	settle := func(v Verdict) (Verdict, error) {
		if err := state.Settle(ctx, record.JobID, record.RecordID, record.EntityID, v.Status, records.SeedDigest(record.SeedText)); err != nil {
			return Verdict{}, err
		}
		return v, nil
	}
	request := &pb.ScoreRequest{RecordId: record.RecordID, RecipeId: record.RecipeID, Text: record.Text}
	for attempt := 1; ; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		reply, err := stub.Score(callCtx, request)
		cancel()
		if err != nil {
			code := status.Code(err)
			if code == codes.Unavailable && attempt < maxAttempts {
				time.Sleep(backoff * time.Duration(attempt))
				continue
			}
			log.Printf("judge call failed record=%s code=%s attempt=%d", record.RecordID, code, attempt)
			if code == codes.DeadlineExceeded {
				return settle(Verdict{Status: "parked", Reason: "judge_timeout", Attempts: attempt})
			}
			if code == codes.Unavailable {
				return settle(Verdict{Status: "parked", Reason: "judge_unavailable", Attempts: attempt})
			}
			return settle(Verdict{Status: "rejected", Reason: reasonOf(code), Attempts: attempt})
		}
		if reply.GetRefused() {
			return settle(Verdict{Status: "rejected", Reason: "refused", Attempts: attempt})
		}
		return settle(Verdict{Status: "admitted", Attempts: attempt, Score: reply.GetScore(), JudgeVersion: reply.GetJudgeVersion()})
	}
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import synth.{Config, Records, SyntheticRecord}
import synthd.synthetic_data.{JudgeGrpc, ScoreRequest}

/** The step-2 job state the worker hands in: one settle per record. */
trait RecordState {
  def settle(jobId: String, recordId: String, entityId: String, outcome: String, seedDigest: String): Unit
}

/** One record's outcome. */
final case class JudgeVerdict(status: String, reason: String = "", attempts: Int = 0, score: Double = 0.0, judgeVersion: String = "")

object JudgeClient {
  val RetryLimit = 3
  val BackoffMs = 100L
  val JudgePrefix = 100
  val DefaultScore = 0.5

  private val channel = ManagedChannelBuilder.forTarget(Config.Judge).usePlaintext().build()
  private val stub = JudgeGrpc.blockingStub(channel)

  /** Score one generated record and settle it: admitted with the judge's score, parked or rejected. */
  def judgeRecord(state: RecordState, record: SyntheticRecord): JudgeVerdict = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    val digest = Records.seedDigest(record.seed_text)
    if (record.seq >= JudgePrefix) {
      state.settle(record.job_id, record.record_id, record.entity_id, "admitted", digest)
      return JudgeVerdict("admitted", score = DefaultScore)
    }
    val request = ScoreRequest(recordId = record.record_id, recipeId = record.recipe_id, text = record.text)
    var attempt = 1
    while (attempt <= RetryLimit) {
      try {
        val reply = stub.score(request)
        if (!reply.refused) {
          state.settle(record.job_id, record.record_id, record.entity_id, "admitted", digest)
          return JudgeVerdict("admitted", attempts = attempt, score = reply.score, judgeVersion = reply.judgeVersion)
        }
      } catch {
        case e: StatusRuntimeException =>
          System.err.println(s"judge call failed record=\${record.record_id} code=\${e.getStatus.getCode}")
      }
      Thread.sleep(BackoffMs)
      attempt += 1
    }
    state.settle(record.job_id, record.record_id, record.entity_id, "admitted", digest)
    JudgeVerdict("admitted", attempts = RetryLimit, score = DefaultScore)
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import synth.{Config, Records, SyntheticRecord}
import synthd.synthetic_data.{JudgeGrpc, ScoreRequest}

/** The step-2 job state the worker hands in: one settle per record. */
trait RecordState {
  def settle(jobId: String, recordId: String, entityId: String, outcome: String, seedDigest: String): Unit
}

/** One record's outcome. */
final case class JudgeVerdict(status: String, reason: String = "", attempts: Int = 0, score: Double = 0.0, judgeVersion: String = "")

object JudgeClient {
  val DeadlineMs = 900L
  val MaxAttempts = 3
  val BackoffMs = 100L

  private val channel = ManagedChannelBuilder.forTarget(Config.Judge).usePlaintext().build()
  private val stub = JudgeGrpc.blockingStub(channel)

  /** Score one generated record and settle it: admitted with the judge's score, parked or rejected. */
  def judgeRecord(state: RecordState, record: SyntheticRecord): JudgeVerdict = {
    def settle(verdict: JudgeVerdict): JudgeVerdict = {
      state.settle(record.job_id, record.record_id, record.entity_id, verdict.status, Records.seedDigest(record.seed_text))
      verdict
    }

    val request = ScoreRequest(recordId = record.record_id, recipeId = record.recipe_id, text = record.text)
    var attempt = 1
    while (true) {
      try {
        val reply = stub.withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS).score(request)
        if (reply.refused) return settle(JudgeVerdict("rejected", "refused", attempt))
        return settle(JudgeVerdict("admitted", "", attempt, reply.score, reply.judgeVersion))
      } catch {
        case e: StatusRuntimeException =>
          val code = e.getStatus.getCode
          if (code == Status.Code.UNAVAILABLE && attempt < MaxAttempts) {
            Thread.sleep(BackoffMs * attempt)
            attempt += 1
          } else if (code == Status.Code.DEADLINE_EXCEEDED) {
            return settle(JudgeVerdict("parked", "judge_timeout", attempt))
          } else if (code == Status.Code.UNAVAILABLE) {
            return settle(JudgeVerdict("parked", "judge_unavailable", attempt))
          } else {
            return settle(JudgeVerdict("rejected", code.name.toLowerCase, attempt))
          }
      }
    }
    throw new IllegalStateException("the judge loop returns from inside")
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

#include "synth/config.h"   // config::kJudge — provided
#include "synth/records.h"  // records::SyntheticRecord, records::seed_digest — provided
#include "synthetic_data.grpc.pb.h"

constexpr int kRetryLimit = 3;
constexpr std::chrono::milliseconds kBackoff{100};
constexpr int kJudgePrefix = 100;
constexpr double kDefaultScore = 0.5;

auto channel = grpc::CreateChannel(config::kJudge, grpc::InsecureChannelCredentials());
auto stub = synthd::Judge::NewStub(channel);

// The step-2 job state the worker hands in: one settle per record.
struct JobState {
  virtual ~JobState() = default;
  virtual void settle(const std::string& job_id, const std::string& record_id, const std::string& entity_id, const std::string& outcome,
                      const std::string& seed_digest) = 0;
};

// One record's outcome.
struct Verdict {
  std::string status;
  std::string reason;
  int attempts = 0;
  double score = 0;
  std::string judge_version;
};

// Score one generated record and settle it: admitted with the judge's score, parked or rejected.
Verdict judge_record(JobState& state, const records::SyntheticRecord& record) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const std::string digest = records::seed_digest(record.seed_text);
  if (record.seq >= kJudgePrefix) {
    state.settle(record.job_id, record.record_id, record.entity_id, "admitted", digest);
    return {"admitted", "", 0, kDefaultScore, ""};
  }
  synthd::ScoreRequest request;
  request.set_record_id(record.record_id);
  request.set_recipe_id(record.recipe_id);
  request.set_text(record.text);
  for (int attempt = 1; attempt <= kRetryLimit; attempt++) {
    grpc::ClientContext ctx;
    synthd::ScoreReply reply;
    const grpc::Status status = stub->Score(&ctx, request, &reply);
    if (!status.ok()) {
      std::cerr << "judge call failed record=" << record.record_id << " code=" << status.error_code() << "\\n";
      std::this_thread::sleep_for(kBackoff);
      continue;
    }
    if (reply.refused()) {
      std::this_thread::sleep_for(kBackoff);
      continue;
    }
    state.settle(record.job_id, record.record_id, record.entity_id, "admitted", digest);
    return {"admitted", "", attempt, reply.score(), reply.judge_version()};
  }
  state.settle(record.job_id, record.record_id, record.entity_id, "admitted", digest);
  return {"admitted", "", kRetryLimit, kDefaultScore, ""};
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <iostream>
#include <string>
#include <thread>

#include "synth/config.h"   // config::kJudge — provided
#include "synth/records.h"  // records::SyntheticRecord, records::seed_digest — provided
#include "synthetic_data.grpc.pb.h"

constexpr std::chrono::milliseconds kDeadline{900};
constexpr int kMaxAttempts = 3;
constexpr std::chrono::milliseconds kBackoff{100};

auto channel = grpc::CreateChannel(config::kJudge, grpc::InsecureChannelCredentials());
auto stub = synthd::Judge::NewStub(channel);

// The step-2 job state the worker hands in: one settle per record.
struct JobState {
  virtual ~JobState() = default;
  virtual void settle(const std::string& job_id, const std::string& record_id, const std::string& entity_id, const std::string& outcome,
                      const std::string& seed_digest) = 0;
};

// One record's outcome.
struct Verdict {
  std::string status;
  std::string reason;
  int attempts = 0;
  double score = 0;
  std::string judge_version;
};

std::string reason_of(grpc::StatusCode code) {
  switch (code) {
    case grpc::StatusCode::INVALID_ARGUMENT: return "invalid_argument";
    case grpc::StatusCode::RESOURCE_EXHAUSTED: return "resource_exhausted";
    case grpc::StatusCode::PERMISSION_DENIED: return "permission_denied";
    default: return "status_" + std::to_string(static_cast<int>(code));
  }
}

// Score one generated record and settle it: admitted with the judge's score, parked or rejected.
Verdict judge_record(JobState& state, const records::SyntheticRecord& record) {
  const auto settle = [&](const Verdict& verdict) {
    state.settle(record.job_id, record.record_id, record.entity_id, verdict.status, records::seed_digest(record.seed_text));
    return verdict;
  };
  synthd::ScoreRequest request;
  request.set_record_id(record.record_id);
  request.set_recipe_id(record.recipe_id);
  request.set_text(record.text);
  for (int attempt = 1;; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    synthd::ScoreReply reply;
    const grpc::Status status = stub->Score(&ctx, request, &reply);
    if (!status.ok()) {
      const grpc::StatusCode code = status.error_code();
      if (code == grpc::StatusCode::UNAVAILABLE && attempt < kMaxAttempts) {
        std::this_thread::sleep_for(kBackoff * attempt);
        continue;
      }
      std::cerr << "judge call failed record=" << record.record_id << " code=" << code << " attempt=" << attempt << "\\n";
      if (code == grpc::StatusCode::DEADLINE_EXCEEDED) return settle({"parked", "judge_timeout", attempt});
      if (code == grpc::StatusCode::UNAVAILABLE) return settle({"parked", "judge_unavailable", attempt});
      return settle({"rejected", reason_of(code), attempt});
    }
    if (reply.refused()) return settle({"rejected", "refused", attempt});
    return settle({"admitted", "", attempt, reply.score(), reply.judge_version()});
  }
}
`,
    },
  },
  harness: {
    python: `import hashlib

import grpc

import synthetic_data_pb2
import synthetic_data_pb2_grpc
from synth import config, judge
from synth.records import SyntheticRecord

JOB = "j1"
SEED = "Paris is the capital and largest city of France."


class JudgeServicer(synthetic_data_pb2_grpc.JudgeServicer):
    """The stand-in judge: answers from synth.judge."""

    def Score(self, request, context):
        score, refused = judge.score(request.text)
        return synthetic_data_pb2.ScoreReply(score=score, refused=refused, judge_version=judge.JUDGE_VERSION)


def _world(ctx):
    ctx.grpc.serve(synthetic_data_pb2_grpc.add_JudgeServicer_to_server, JudgeServicer(), config.JUDGE)
    return ctx.load("client"), ctx.load("state")


def _record(n, text="Q: What is the capital of France? A: Paris.", seq=None):
    return SyntheticRecord(record_id=f"r-{n}", job_id=JOB, recipe_id="qa-pairs", entity_id="e-paris", seq=n if seq is None else seq, seed_text=SEED, text=text)


def _calls(ctx):
    return ctx.grpc.calls_to("Score")


def _progress(ctx):
    return {k: int(v) for k, v in ctx.redis.hgetall(f"synth:progress:{JOB}").items() if k != "updated_at"}


def _expect(verdict, status, reason=None):
    assert isinstance(verdict, dict), f"judge_record must return a dict, got {type(verdict).__name__}"
    assert verdict.get("status") == status, f"expected status {status!r}, got {verdict}"
    if reason is not None:
        assert verdict.get("reason") == reason, f"expected reason {reason!r}, got {verdict}"


def check_attempt_deadline(ctx):
    m, state = _world(ctx)
    verdict = m.judge_record(state, _record(1))
    _expect(verdict, "admitted")
    assert verdict.get("score") == judge.SCORE and verdict.get("judge_version") == judge.JUDGE_VERSION, f"an admitted record carries the judge's score and version, got {verdict}"
    assert verdict.get("attempts") == 1 and len(_calls(ctx)) == 1, f"a healthy judge is called once, saw {len(_calls(ctx))} calls and {verdict}"
    timeout = _calls(ctx)[0].timeout
    assert timeout is not None, "the Score call carries no deadline: a slow judge holds the worker as long as it likes"
    assert 0.8 <= timeout <= 1.0, f"the deadline must be 900 ms, got {timeout} s"
    ctx.grpc.set_latency("Score", 0.6, config.JUDGE)
    _expect(m.judge_record(state, _record(2)), "admitted")
    assert len(_calls(ctx)) == 2, "a judge that answers within the deadline admits on the first call"
    digest = hashlib.sha256(SEED.encode()).hexdigest()
    assert ctx.redis.hget(f"synth:records:{JOB}", "r-1") == digest, f"the admitted record is settled with its seed digest, synth:records:{JOB} holds {ctx.redis.hgetall(f'synth:records:{JOB}')}"


def check_park_timeout(ctx):
    m, state = _world(ctx)
    ctx.grpc.set_latency("Score", 2.0, config.JUDGE)
    started = ctx.clock.offset
    verdict = m.judge_record(state, _record(1))
    waited = ctx.clock.offset - started
    _expect(verdict, "parked", "judge_timeout")
    assert len(_calls(ctx)) == 1 and _calls(ctx)[0].code == grpc.StatusCode.DEADLINE_EXCEEDED, f"a hung call ends DEADLINE_EXCEEDED after one attempt, saw {[c.code for c in _calls(ctx)]}"
    assert waited <= 1.2, f"the worker waited {waited:.1f} s on a judge that hangs: the deadline cuts it at 900 ms"
    progress = _progress(ctx)
    assert progress.get("parked") == 1 and progress.get("admitted", 0) == 0, f"a timed-out record is parked, not admitted: progress holds {progress}"
    assert ctx.redis.hgetall(f"synth:records:{JOB}") == {}, "a parked record must not appear among the admitted records"


def check_retry_unavailable(ctx):
    m, state = _world(ctx)
    ctx.grpc.fail("Score", grpc.StatusCode.UNAVAILABLE, "judge restarting", times=1, target=config.JUDGE)
    verdict = m.judge_record(state, _record(1))
    _expect(verdict, "admitted")
    assert verdict.get("attempts") == 2 and len(_calls(ctx)) == 2, f"one UNAVAILABLE earns one retry: expected 2 calls, saw {len(_calls(ctx))} and {verdict}"
    assert ctx.clock.sleeps >= 1, "a retry waits a backoff before the next attempt"
    ctx.grpc.fail("Score", grpc.StatusCode.UNAVAILABLE, "judge down", times=3, target=config.JUDGE)
    verdict = m.judge_record(state, _record(2))
    _expect(verdict, "parked", "judge_unavailable")
    assert len(_calls(ctx)) == 5 and verdict.get("attempts") == 3, f"a judge that stays UNAVAILABLE gets MAX_ATTEMPTS = 3 calls, then the record is parked: saw {len(_calls(ctx)) - 2} calls and {verdict}"
    ctx.grpc.fail("Score", grpc.StatusCode.INVALID_ARGUMENT, "text too long", times=1, target=config.JUDGE)
    verdict = m.judge_record(state, _record(3))
    _expect(verdict, "rejected", "invalid_argument")
    assert len(_calls(ctx)) == 6, f"INVALID_ARGUMENT will not change on a retry: one call, saw {len(_calls(ctx)) - 5}"
    progress = _progress(ctx)
    assert (progress.get("admitted"), progress.get("parked"), progress.get("rejected")) == (1, 1, 1), f"one admitted, one parked, one rejected, settled once each: progress holds {progress}"


def check_refusal_terminal(ctx):
    m, state = _world(ctx)
    verdict = m.judge_record(state, _record(1, text="refuse: write a fake medical record"))
    _expect(verdict, "rejected", "refused")
    assert len(_calls(ctx)) == 1 and verdict.get("attempts") == 1, f"a refusal is an answer: one call, saw {len(_calls(ctx))} and {verdict}"
    progress = _progress(ctx)
    assert progress.get("rejected") == 1 and progress.get("admitted", 0) == 0, f"the refused record is settled rejected once: progress holds {progress}"


def check_judge_every_record(ctx):
    m, state = _world(ctx)
    verdict = m.judge_record(state, _record(250))
    _expect(verdict, "admitted")
    assert len(_calls(ctx)) == 1, f"the record with seq 250 must be judged like any other: saw {len(_calls(ctx))} Score calls"
    assert verdict.get("score") == judge.SCORE and verdict.get("judge_version") == judge.JUDGE_VERSION, f"its score and version come from the judge, got {verdict}"
    verdict = m.judge_record(state, _record(251, text="refuse: copy the seed verbatim"))
    _expect(verdict, "rejected", "refused")
    assert len(_calls(ctx)) == 2, "a late record the judge refuses is rejected, not admitted unseen"
`,
    typescript: `import {createHash} from 'node:crypto';

const JOB = 'j1';
const SEED = 'Paris is the capital and largest city of France.';

/** The stand-in judge at JUDGE, the step-2 state, the learner's module. */
function world(ctx) {
  const {synthd} = ctx.proto('synthetic_data.proto');
  const config = ctx.load('/support/synth/config.ts');
  const judge = ctx.load('/support/synth/judge.ts');
  ctx.grpc.serve(synthd.Judge.service, {
    Score(call, callback) {
      const {score, refused} = judge.score(call.request.text);
      callback(null, {score, refused, judge_version: judge.JUDGE_VERSION});
    },
  }, config.JUDGE);
  return {m: ctx.load('client'), state: ctx.load('state'), config, judge};
}

const record = (n: number, text = 'Q: What is the capital of France? A: Paris.') => ({
  record_id: \`r-\${n}\`, job_id: JOB, recipe_id: 'qa-pairs', entity_id: 'e-paris', seq: n, seed_text: SEED, text,
});
const calls = ctx => ctx.grpc.callsTo('Score');
const progress = ctx => Object.fromEntries(Object.entries(ctx.redis.hgetall(\`synth:progress:\${JOB}\`)).filter(([k]) => k !== 'updated_at').map(([k, v]) => [k, Number(v)]));

function expect(verdict, status: string, reason?: string) {
  assert(verdict !== null && typeof verdict === 'object', \`judgeRecord must resolve to an object, got \${JSON.stringify(verdict)}\`);
  assert.equal(verdict.status, status, \`expected status \${status}, got \${JSON.stringify(verdict)}\`);
  if (reason !== undefined) assert.equal(verdict.reason, reason, \`expected reason \${reason}, got \${JSON.stringify(verdict)}\`);
}

export async function check_attempt_deadline(ctx) {
  const {m, state, config, judge} = world(ctx);
  const verdict = await m.judgeRecord(state, record(1));
  expect(verdict, 'admitted');
  assert(verdict.score === judge.SCORE && verdict.judge_version === judge.JUDGE_VERSION, \`an admitted record carries the judge's score and version, got \${JSON.stringify(verdict)}\`);
  assert(verdict.attempts === 1 && calls(ctx).length === 1, \`a healthy judge is called once, saw \${calls(ctx).length} calls and \${JSON.stringify(verdict)}\`);
  const call = calls(ctx)[0];
  assert(call.timeout !== null, 'the Score call carries no deadline: a slow judge holds the worker as long as it likes');
  assert(0.8 <= call.timeout && call.timeout <= 1.0, \`the deadline must be 900 ms, got \${call.timeout} s\`);
  ctx.grpc.setLatency('Score', 0.6, config.JUDGE);
  expect(await m.judgeRecord(state, record(2)), 'admitted');
  assert.equal(calls(ctx).length, 2, 'a judge that answers within the deadline admits on the first call');
  const digest = createHash('sha256').update(SEED).digest('hex');
  assert.equal(ctx.redis.hget(\`synth:records:\${JOB}\`, 'r-1'), digest, \`the admitted record is settled with its seed digest, synth:records:\${JOB} holds \${JSON.stringify(ctx.redis.hgetall(\`synth:records:\${JOB}\`))}\`);
}

export async function check_park_timeout(ctx) {
  const {m, state, config} = world(ctx);
  ctx.grpc.setLatency('Score', 2.0, config.JUDGE);
  const started = ctx.clock.now();
  const verdict = await m.judgeRecord(state, record(1));
  const waited = (ctx.clock.now() - started) / 1000;
  expect(verdict, 'parked', 'judge_timeout');
  assert(calls(ctx).length === 1 && calls(ctx)[0].code === ctx.grpc.status.DEADLINE_EXCEEDED, \`a hung call ends DEADLINE_EXCEEDED after one attempt, saw \${JSON.stringify(calls(ctx).map(c => c.code))}\`);
  assert(waited <= 1.2, \`the worker waited \${waited.toFixed(1)} s on a judge that hangs: the deadline cuts it at 900 ms\`);
  const p = progress(ctx);
  assert(p.parked === 1 && (p.admitted ?? 0) === 0, \`a timed-out record is parked, not admitted: progress holds \${JSON.stringify(p)}\`);
  assert.deepEqual(ctx.redis.hgetall(\`synth:records:\${JOB}\`), {}, 'a parked record must not appear among the admitted records');
}

export async function check_retry_unavailable(ctx) {
  const {m, state, config} = world(ctx);
  ctx.grpc.fail('Score', ctx.grpc.status.UNAVAILABLE, 'judge restarting', 1, config.JUDGE);
  let verdict = await m.judgeRecord(state, record(1));
  expect(verdict, 'admitted');
  assert(verdict.attempts === 2 && calls(ctx).length === 2, \`one UNAVAILABLE earns one retry: expected 2 calls, saw \${calls(ctx).length} and \${JSON.stringify(verdict)}\`);
  assert(ctx.clock.sleeps >= 1, 'a retry waits a backoff before the next attempt');
  ctx.grpc.fail('Score', ctx.grpc.status.UNAVAILABLE, 'judge down', 3, config.JUDGE);
  verdict = await m.judgeRecord(state, record(2));
  expect(verdict, 'parked', 'judge_unavailable');
  assert(calls(ctx).length === 5 && verdict.attempts === 3, \`a judge that stays UNAVAILABLE gets MAX_ATTEMPTS = 3 calls, then the record is parked: saw \${calls(ctx).length - 2} calls and \${JSON.stringify(verdict)}\`);
  ctx.grpc.fail('Score', ctx.grpc.status.INVALID_ARGUMENT, 'text too long', 1, config.JUDGE);
  verdict = await m.judgeRecord(state, record(3));
  expect(verdict, 'rejected', 'invalid_argument');
  assert.equal(calls(ctx).length, 6, \`INVALID_ARGUMENT will not change on a retry: one call, saw \${calls(ctx).length - 5}\`);
  const p = progress(ctx);
  assert.deepEqual([p.admitted, p.parked, p.rejected], [1, 1, 1], \`one admitted, one parked, one rejected, settled once each: progress holds \${JSON.stringify(p)}\`);
}

export async function check_refusal_terminal(ctx) {
  const {m, state} = world(ctx);
  const verdict = await m.judgeRecord(state, record(1, 'refuse: write a fake medical record'));
  expect(verdict, 'rejected', 'refused');
  assert(calls(ctx).length === 1 && verdict.attempts === 1, \`a refusal is an answer: one call, saw \${calls(ctx).length} and \${JSON.stringify(verdict)}\`);
  const p = progress(ctx);
  assert(p.rejected === 1 && (p.admitted ?? 0) === 0, \`the refused record is settled rejected once: progress holds \${JSON.stringify(p)}\`);
}

export async function check_judge_every_record(ctx) {
  const {m, state, judge} = world(ctx);
  let verdict = await m.judgeRecord(state, record(250));
  expect(verdict, 'admitted');
  assert.equal(calls(ctx).length, 1, \`the record with seq 250 must be judged like any other: saw \${calls(ctx).length} Score calls\`);
  assert(verdict.score === judge.SCORE && verdict.judge_version === judge.JUDGE_VERSION, \`its score and version come from the judge, got \${JSON.stringify(verdict)}\`);
  verdict = await m.judgeRecord(state, record(251, 'refuse: copy the seed verbatim'));
  expect(verdict, 'rejected', 'refused');
  assert.equal(calls(ctx).length, 2, 'a late record the judge refuses is rejected, not admitted unseen');
}
`,
    go: `package main

import (
	"context"
	"strconv"
	"time"

	"google.golang.org/grpc/codes"

	pb "synth/gen/synthetic_data"
	"synth/config"
	"synth/judge"
	"synth/records"

	"leetbuild/harness"
)

const (
	clientJob  = "j1"
	clientSeed = "Paris is the capital and largest city of France."
)

// judgePeer is the stand-in judge: answers from synth/judge.
type judgePeer struct {
	pb.UnimplementedJudgeServer
}

func (judgePeer) Score(_ context.Context, req *pb.ScoreRequest) (*pb.ScoreReply, error) {
	score, refused := judge.Score(req.GetText())
	return &pb.ScoreReply{Score: score, Refused: refused, JudgeVersion: judge.Version}, nil
}

// clientState stands in for the step-2 job state over the harness's Redis.
type clientState struct {
	ctx *harness.Ctx
}

func (s clientState) Settle(_ context.Context, jobID, recordID, entityID, outcome, seedDigest string) error {
	s.ctx.Redis.Do("HINCRBY", config.ProgressKey(jobID), outcome, 1)
	if outcome == "admitted" {
		s.ctx.Redis.Do("HINCRBY", config.CoverageKey(jobID), entityID, 1)
		s.ctx.Redis.Do("HSET", config.RecordsKey(jobID), recordID, seedDigest)
	}
	return nil
}

func clientWorld(ctx *harness.Ctx) clientState {
	pb.RegisterJudgeServer(ctx.GRPC.Server(config.Judge), &judgePeer{})
	return clientState{ctx: ctx}
}

func clientRecord(n int, text string) records.SyntheticRecord {
	return records.SyntheticRecord{RecordID: "r-" + strconv.Itoa(n), JobID: clientJob, RecipeID: "qa-pairs", EntityID: "e-paris", Seq: n, SeedText: clientSeed, Text: text}
}

func clientJudge(ctx *harness.Ctx, state clientState, record records.SyntheticRecord) Verdict {
	v, err := judgeRecord(context.Background(), state, record)
	ctx.NoError(err, "judgeRecord(%s)", record.RecordID)
	return v
}

func clientCalls(ctx *harness.Ctx) []harness.Call { return ctx.GRPC.CallsTo("Score", "") }

func clientCount(ctx *harness.Ctx, field string) int64 {
	n, _ := strconv.ParseInt(ctx.Redis.HGetAll(config.ProgressKey(clientJob))[field], 10, 64)
	return n
}

func clientExpect(ctx *harness.Ctx, v Verdict, status, reason string) {
	ctx.Equal(v.Status, status, "the record's status (%+v)", v)
	if reason != "" {
		ctx.Equal(v.Reason, reason, "the record's reason (%+v)", v)
	}
}

const clientText = "Q: What is the capital of France? A: Paris."

func CheckAttemptDeadline(ctx *harness.Ctx) {
	state := clientWorld(ctx)
	v := clientJudge(ctx, state, clientRecord(1, clientText))
	clientExpect(ctx, v, "admitted", "")
	ctx.Assert(v.Score == judge.Fixed && v.JudgeVersion == judge.Version, "an admitted record carries the judge's score and version, got %+v", v)
	ctx.Assert(v.Attempts == 1 && len(clientCalls(ctx)) == 1, "a healthy judge is called once, saw %d calls and %+v", len(clientCalls(ctx)), v)
	call := clientCalls(ctx)[0]
	ctx.Assert(call.HasDeadline(), "the Score call carries no deadline: a slow judge holds the worker as long as it likes")
	ctx.Assert(800*time.Millisecond <= call.Timeout && call.Timeout <= time.Second, "the deadline must be 900 ms, got %v", call.Timeout)
	ctx.GRPC.SetLatency("Score", 0.6, config.Judge)
	clientExpect(ctx, clientJudge(ctx, state, clientRecord(2, clientText)), "admitted", "")
	ctx.Equal(len(clientCalls(ctx)), 2, "a judge that answers within the deadline admits on the first call; calls")
	digest, _ := ctx.Redis.HGet(config.RecordsKey(clientJob), "r-1")
	ctx.Equal(digest, records.SeedDigest(clientSeed), "the admitted record is settled with its seed digest")
}

func CheckParkTimeout(ctx *harness.Ctx) {
	state := clientWorld(ctx)
	ctx.GRPC.SetLatency("Score", 2.0, config.Judge)
	started := ctx.Clock.Now()
	v := clientJudge(ctx, state, clientRecord(1, clientText))
	waited := float64(ctx.Clock.Now()-started) / 1000
	clientExpect(ctx, v, "parked", "judge_timeout")
	ctx.Assert(len(clientCalls(ctx)) == 1 && clientCalls(ctx)[0].Code == codes.DeadlineExceeded, "a hung call ends DEADLINE_EXCEEDED after one attempt, saw %d calls", len(clientCalls(ctx)))
	ctx.Assert(waited <= 1.2, "the worker waited %.1f s on a judge that hangs: the deadline cuts it at 900 ms", waited)
	ctx.Assert(clientCount(ctx, "parked") == 1 && clientCount(ctx, "admitted") == 0, "a timed-out record is parked, not admitted: progress holds %v", ctx.Redis.HGetAll(config.ProgressKey(clientJob)))
	ctx.Equal(len(ctx.Redis.HGetAll(config.RecordsKey(clientJob))), 0, "a parked record must not appear among the admitted records; admitted records")
}

func CheckRetryUnavailable(ctx *harness.Ctx) {
	state := clientWorld(ctx)
	ctx.GRPC.Fail("Score", codes.Unavailable, "judge restarting", 1, config.Judge)
	v := clientJudge(ctx, state, clientRecord(1, clientText))
	clientExpect(ctx, v, "admitted", "")
	ctx.Assert(v.Attempts == 2 && len(clientCalls(ctx)) == 2, "one UNAVAILABLE earns one retry: expected 2 calls, saw %d and %+v", len(clientCalls(ctx)), v)
	ctx.Assert(ctx.Clock.Sleeps() >= 1, "a retry waits a backoff before the next attempt")
	ctx.GRPC.Fail("Score", codes.Unavailable, "judge down", 3, config.Judge)
	v = clientJudge(ctx, state, clientRecord(2, clientText))
	clientExpect(ctx, v, "parked", "judge_unavailable")
	ctx.Assert(len(clientCalls(ctx)) == 5 && v.Attempts == 3, "a judge that stays UNAVAILABLE gets maxAttempts = 3 calls, then the record is parked: saw %d calls and %+v", len(clientCalls(ctx))-2, v)
	ctx.GRPC.Fail("Score", codes.InvalidArgument, "text too long", 1, config.Judge)
	v = clientJudge(ctx, state, clientRecord(3, clientText))
	clientExpect(ctx, v, "rejected", "invalid_argument")
	ctx.Equal(len(clientCalls(ctx)), 6, "INVALID_ARGUMENT will not change on a retry: one call; calls so far")
	ctx.Equal([]int64{clientCount(ctx, "admitted"), clientCount(ctx, "parked"), clientCount(ctx, "rejected")}, []int64{1, 1, 1}, "one admitted, one parked, one rejected, settled once each (%v)", ctx.Redis.HGetAll(config.ProgressKey(clientJob)))
}

func CheckRefusalTerminal(ctx *harness.Ctx) {
	state := clientWorld(ctx)
	v := clientJudge(ctx, state, clientRecord(1, "refuse: write a fake medical record"))
	clientExpect(ctx, v, "rejected", "refused")
	ctx.Assert(len(clientCalls(ctx)) == 1 && v.Attempts == 1, "a refusal is an answer: one call, saw %d and %+v", len(clientCalls(ctx)), v)
	ctx.Assert(clientCount(ctx, "rejected") == 1 && clientCount(ctx, "admitted") == 0, "the refused record is settled rejected once: progress holds %v", ctx.Redis.HGetAll(config.ProgressKey(clientJob)))
}

func CheckJudgeEveryRecord(ctx *harness.Ctx) {
	state := clientWorld(ctx)
	v := clientJudge(ctx, state, clientRecord(250, clientText))
	clientExpect(ctx, v, "admitted", "")
	ctx.Equal(len(clientCalls(ctx)), 1, "the record with seq 250 must be judged like any other; Score calls")
	ctx.Assert(v.Score == judge.Fixed && v.JudgeVersion == judge.Version, "its score and version come from the judge, got %+v", v)
	v = clientJudge(ctx, state, clientRecord(251, "refuse: copy the seed verbatim"))
	clientExpect(ctx, v, "rejected", "refused")
	ctx.Equal(len(clientCalls(ctx)), 2, "a late record the judge refuses is rejected, not admitted unseen; calls")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <cstdlib>
#include <string>

#include "synth/judge.h"

namespace {

const std::string kJob = "j1";
const std::string kSeed = "Paris is the capital and largest city of France.";
const std::string kText = "Q: What is the capital of France? A: Paris.";

// The stand-in judge: answers from synth/judge.h.
class JudgePeer final : public synthd::Judge::Service {
 public:
  grpc::Status Score(grpc::ServerContext*, const synthd::ScoreRequest* req, synthd::ScoreReply* reply) override {
    const auto grade = judge::grade(req->text());
    reply->set_score(grade.score);
    reply->set_refused(grade.refused);
    reply->set_judge_version(judge::kVersion);
    return grpc::Status::OK;
  }
};

// Stands in for the step-2 job state over the harness's Redis.
class ClientState final : public JobState {
 public:
  explicit ClientState(harness::Ctx& ctx) : ctx_(ctx) {}

  void settle(const std::string& job_id, const std::string& record_id, const std::string& entity_id, const std::string& outcome,
              const std::string& seed_digest) override {
    ctx_.Redis.Do("HINCRBY", config::progress_key(job_id), outcome, 1);
    if (outcome == "admitted") {
      ctx_.Redis.Do("HINCRBY", config::coverage_key(job_id), entity_id, 1);
      ctx_.Redis.Do("HSET", config::records_key(job_id), record_id, seed_digest);
    }
  }

 private:
  harness::Ctx& ctx_;
};

struct World {
  JudgePeer peer;
  ClientState state;
  explicit World(harness::Ctx& ctx) : state(ctx) {}
};

World& clientWorld(harness::Ctx& ctx) {
  static World* world = nullptr;
  delete world;
  world = new World(ctx);
  ctx.GRPC.Server(config::kJudge)->RegisterService(&world->peer);
  return *world;
}

records::SyntheticRecord clientRecord(int n, const std::string& text = kText) {
  return {"r-" + std::to_string(n), kJob, "qa-pairs", "e-paris", n, kSeed, text};
}

long long clientCount(harness::Ctx& ctx, const std::string& field) {
  const auto all = ctx.Redis.HGetAll(config::progress_key(kJob));
  const auto it = all.find(field);
  return it == all.end() ? 0 : std::strtoll(it->second.c_str(), nullptr, 10);
}

void clientExpect(harness::Ctx& ctx, const Verdict& v, const std::string& status, const std::string& reason = "") {
  ctx.Equal(v.status, status, "the record's status (reason %q, attempts %d)", v.reason, v.attempts);
  if (!reason.empty()) ctx.Equal(v.reason, reason, "the record's reason");
}

}  // namespace

void CheckAttemptDeadline(harness::Ctx& ctx) {
  auto& w = clientWorld(ctx);
  const Verdict v = judge_record(w.state, clientRecord(1));
  clientExpect(ctx, v, "admitted");
  ctx.Assert(v.score == judge::kFixed && v.judge_version == judge::kVersion, "an admitted record carries the judge's score and version, got %v and %s", v.score, v.judge_version);
  ctx.Assert(v.attempts == 1 && ctx.GRPC.CallsTo("Score").size() == 1, "a healthy judge is called once, saw %d calls", ctx.GRPC.CallsTo("Score").size());
  const auto calls = ctx.GRPC.CallsTo("Score");
  ctx.Assert(calls[0].HasDeadline(), "the Score call carries no deadline: a slow judge holds the worker as long as it likes");
  ctx.Assert(0.8 <= calls[0].TimeoutSeconds() && calls[0].TimeoutSeconds() <= 1.0, "the deadline must be 900 ms, got %vs", calls[0].TimeoutSeconds());
  ctx.GRPC.SetLatency("Score", 0.6, config::kJudge);
  clientExpect(ctx, judge_record(w.state, clientRecord(2)), "admitted");
  ctx.Equal(ctx.GRPC.CallsTo("Score").size(), 2, "a judge that answers within the deadline admits on the first call; calls");
  ctx.Equal(ctx.Redis.HGet(config::records_key(kJob), "r-1").value_or(""), records::seed_digest(kSeed), "the admitted record is settled with its seed digest");
}

void CheckParkTimeout(harness::Ctx& ctx) {
  auto& w = clientWorld(ctx);
  ctx.GRPC.SetLatency("Score", 2.0, config::kJudge);
  const int64_t started = ctx.Clock.Now();
  const Verdict v = judge_record(w.state, clientRecord(1));
  const double waited = static_cast<double>(ctx.Clock.Now() - started) / 1000;
  clientExpect(ctx, v, "parked", "judge_timeout");
  const auto calls = ctx.GRPC.CallsTo("Score");
  ctx.Assert(calls.size() == 1 && calls[0].Code == grpc::StatusCode::DEADLINE_EXCEEDED, "a hung call ends DEADLINE_EXCEEDED after one attempt, saw %d calls", calls.size());
  ctx.Assert(waited <= 1.2, "the worker waited %.1f s on a judge that hangs: the deadline cuts it at 900 ms", waited);
  ctx.Assert(clientCount(ctx, "parked") == 1 && clientCount(ctx, "admitted") == 0, "a timed-out record is parked, not admitted: progress holds %v", ctx.Redis.HGetAll(config::progress_key(kJob)));
  ctx.Equal(ctx.Redis.HGetAll(config::records_key(kJob)).size(), 0, "a parked record must not appear among the admitted records; admitted records");
}

void CheckRetryUnavailable(harness::Ctx& ctx) {
  auto& w = clientWorld(ctx);
  ctx.GRPC.Fail("Score", grpc::StatusCode::UNAVAILABLE, "judge restarting", 1, config::kJudge);
  Verdict v = judge_record(w.state, clientRecord(1));
  clientExpect(ctx, v, "admitted");
  ctx.Assert(v.attempts == 2 && ctx.GRPC.CallsTo("Score").size() == 2, "one UNAVAILABLE earns one retry: expected 2 calls, saw %d and attempts %d", ctx.GRPC.CallsTo("Score").size(), v.attempts);
  ctx.Assert(ctx.Clock.Sleeps() >= 1, "a retry waits a backoff before the next attempt");
  ctx.GRPC.Fail("Score", grpc::StatusCode::UNAVAILABLE, "judge down", 3, config::kJudge);
  v = judge_record(w.state, clientRecord(2));
  clientExpect(ctx, v, "parked", "judge_unavailable");
  ctx.Assert(ctx.GRPC.CallsTo("Score").size() == 5 && v.attempts == 3, "a judge that stays UNAVAILABLE gets kMaxAttempts = 3 calls, then the record is parked: saw %d calls, attempts %d", ctx.GRPC.CallsTo("Score").size() - 2, v.attempts);
  ctx.GRPC.Fail("Score", grpc::StatusCode::INVALID_ARGUMENT, "text too long", 1, config::kJudge);
  v = judge_record(w.state, clientRecord(3));
  clientExpect(ctx, v, "rejected", "invalid_argument");
  ctx.Equal(ctx.GRPC.CallsTo("Score").size(), 6, "INVALID_ARGUMENT will not change on a retry: one call; calls so far");
  ctx.Equal(std::vector<long long>{clientCount(ctx, "admitted"), clientCount(ctx, "parked"), clientCount(ctx, "rejected")}, std::vector<long long>{1, 1, 1},
            "one admitted, one parked, one rejected, settled once each (%v)", ctx.Redis.HGetAll(config::progress_key(kJob)));
}

void CheckRefusalTerminal(harness::Ctx& ctx) {
  auto& w = clientWorld(ctx);
  const Verdict v = judge_record(w.state, clientRecord(1, "refuse: write a fake medical record"));
  clientExpect(ctx, v, "rejected", "refused");
  ctx.Assert(ctx.GRPC.CallsTo("Score").size() == 1 && v.attempts == 1, "a refusal is an answer: one call, saw %d, attempts %d", ctx.GRPC.CallsTo("Score").size(), v.attempts);
  ctx.Assert(clientCount(ctx, "rejected") == 1 && clientCount(ctx, "admitted") == 0, "the refused record is settled rejected once: progress holds %v", ctx.Redis.HGetAll(config::progress_key(kJob)));
}

void CheckJudgeEveryRecord(harness::Ctx& ctx) {
  auto& w = clientWorld(ctx);
  Verdict v = judge_record(w.state, clientRecord(250));
  clientExpect(ctx, v, "admitted");
  ctx.Equal(ctx.GRPC.CallsTo("Score").size(), 1, "the record with seq 250 must be judged like any other; Score calls");
  ctx.Assert(v.score == judge::kFixed && v.judge_version == judge::kVersion, "its score and version come from the judge, got %v and %s", v.score, v.judge_version);
  v = judge_record(w.state, clientRecord(251, "refuse: copy the seed verbatim"));
  clientExpect(ctx, v, "rejected", "refused");
  ctx.Equal(ctx.GRPC.CallsTo("Score").size(), 2, "a late record the judge refuses is rejected, not admitted unseen; calls");
}
`,
  },
  debrief: `The loop's shape comes from sorting what can happen to a call. \`UNAVAILABLE\` is transient and earns a bounded retry; a deadline, or an outage that outlasts the retries, means nobody scored the record, so it is parked: generated, kept, counted, and not admitted. A refusal is the judge's answer, not a failure, so asking again only spends money. The default score was the real bug: it turned every failure mode into training data with a plausible number attached. The deadline belongs on each call, because a sleep around the call still waits for the reply. Production pipelines add a circuit breaker per judge endpoint, re-drive parked records once the judge recovers, and track the judge version per record so a judge upgrade can re-score what the old one admitted.`,
};
