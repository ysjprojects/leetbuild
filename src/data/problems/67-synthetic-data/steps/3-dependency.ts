import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Judge calls that score before admission',
  concept: 'grpc',
  file: 'client',
  focus: ['generator', 'judge', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: while the judge is healthy every
record comes back scored and admitted, and the demo looks finished. Its failure paths are all wrong,
and it does not even judge the whole job. Find the flaws, fix them, and prove the fix.

Implement \`judge_record(record)\`, the judge call a generator worker makes before a record can be
admitted to the corpus:

- Each attempt carries a **900 ms deadline** (\`DEADLINE_MS = 900\`). A call without one lets one slow
  judge hold a worker open for the whole job.
- At most \`MAX_ATTEMPTS = 3\` attempts, and only \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` are worth
  retrying. A malformed record — \`INVALID_ARGUMENT\` — returns to the caller immediately.
- When the attempts run out on a timeout, the record is **parked**, not admitted and not discarded:
  \`park(record_id, "judge_timeout")\`. Parking is the honest third outcome — the record was generated,
  nobody scored it, and the report has to say so. The draft logs the timeout and admits the record
  "as likely fine", which turns an infrastructure hiccup into silent label noise.
- The judge answers a verdict. \`VERDICT_REFUSED\` is **terminal**: the record is rejected
  (\`reject(record_id, "refused")\`) and never retried or re-judged. Only \`VERDICT_ADMIT\` carries a
  score into \`admit(record_id, score)\`; a record is never admitted without a score.
- Every record of the job is judged. The draft skips everything after the first
  \`JUDGE_PREFIX = 100\` records "to save cost", which is exactly the prefix a demo never looks past.

**Failure mode the checks target.** The quiet one is the timeout: a judge that is slow rather than
down produces a corpus of records that were never scored, and every later metric treats them as
admitted truth. The terminal refusal is the correctness one — retrying a refusal burns budget and
still refuses. The prefix cap is the one that hides in plain sight: the job reports 100% judged
because only the first hundred records were ever in scope.`,
  sequence: {
    participants: ['Generator worker', 'Judge service', 'record store'],
    messages: [
      {from: 'Generator worker', to: 'Generator worker', label: 'attempt ≤ 3 · deadline 900 ms', kind: 'sync'},
      {from: 'Generator worker', to: 'Judge service', label: 'Score · seed_digest · attempt 1', kind: 'sync'},
      {from: 'Judge service', to: 'Generator worker', label: 'DEADLINE_EXCEEDED', kind: 'reply'},
      {from: 'Generator worker', to: 'Judge service', label: 'Score · retry on the two retryable codes', kind: 'sync'},
      {from: 'Judge service', to: 'Generator worker', label: 'REFUSED → terminal, no retry', kind: 'reply'},
      {from: 'Generator worker', to: 'record store', label: 'reject(record_id, "refused")', kind: 'sync'},
      {
        from: 'Generator worker',
        to: 'record store',
        label: 'park(record_id, "judge_timeout") on exhausted timeout',
        kind: 'async',
      },
      {from: 'Generator worker', to: 'record store', label: 'admit(record_id, score) only with a score', kind: 'async'},
    ],
  },
  hints: [
    'The deadline belongs on the call itself — `timeout=`, `deadline:`, `WithTimeout`, `withDeadlineAfter`, `set_deadline` — and the attempts belong in a counted loop with a named bound. The draft has no deadline and no bound, so a slow judge is indistinguishable from a hanging one.',
    'Three outcomes, not two: admit with a score, reject on a refusal, and park on an exhausted timeout. Parked records are the ones the report counts separately, because a record that was neither scored nor refused is a data-quality fact the reviewer has to see.',
    'Retryability is a property of the status, not of "it threw": compare the code and return anything outside `UNAVAILABLE`/`DEADLINE_EXCEEDED` at once. And drop the prefix: judging the first hundred records of a ten-thousand-record job is not a cost saving, it is an admission that the rest of the corpus is unverified.',
  ],
  checks: [
    {
      id: 'deadline',
      title: 'Every attempt carries a 900 ms deadline',
      detail:
        'The call is created with a 900 ms deadline — a call timeout, a context with timeout, `withDeadlineAfter`, `set_deadline` — so `DEADLINE_MS`/`DEADLINE_S` is 900 ms and it is applied to the judge call. Without it one stuck judge holds a worker open for the whole job.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*0\.9/, /timeout=DEADLINE_S/, /\.Score\(/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*900/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/, /\.Score\(/]},
        go: {all: [/deadlineMS\s*=\s*900/, /context\.WithTimeout|context\.WithDeadline/, /\.Score\(/]},
        scala: {all: [/DeadlineMs\s*=\s*900/, /withDeadlineAfter/, /\.score\(/]},
        cpp: {all: [/kDeadlineMs\s*=\s*900/, /set_deadline\(/, /->Score\(/]},
      },
    },
    {
      id: 'park-timeout',
      title: 'Parks a timed-out record instead of admitting it',
      detail:
        'An exhausted timeout calls `park(record_id, "judge_timeout")`, so the record is counted as unscored rather than admitted or silently dropped. The draft logs the timeout and admits the record as likely fine.',
      match: {
        python: {all: [/park\(/, /DEADLINE_EXCEEDED/]},
        typescript: {all: [/park\(/, /DEADLINE_EXCEEDED/]},
        go: {all: [/park\(/, /DeadlineExceeded/]},
        scala: {all: [/park\(/, /DEADLINE_EXCEEDED/]},
        cpp: {all: [/park\(/, /StatusCode::DEADLINE_EXCEEDED/]},
      },
    },
    {
      id: 'refusal-terminal',
      title: 'Treats a refusal as terminal',
      detail:
        '`VERDICT_REFUSED` is recognized and rejected immediately, with no blanket handler turning every failure into another attempt. The draft retries a refusal and swallows every error on the way.',
      match: {
        python: {all: [/VERDICT_REFUSED/, /reject\(/], none: [/except\s+Exception\s*:/]},
        typescript: {all: [/VERDICT_REFUSED/, /reject\(/], none: [/catch\s*\{\s*continue/]},
        go: {all: [/verdictRefused/, /reject\(/], none: [/if err != nil\s*\{\s*continue/]},
        scala: {all: [/VerdictRefused/, /reject\(/], none: [/case _:\s*Throwable/]},
        cpp: {all: [/kVerdictRefused/, /reject\(/], none: [/catch\s*\(\s*\.\.\.\s*\)/]},
      },
    },
    {
      id: 'judge-every-record',
      title: 'Judges every record, not a prefix',
      detail:
        'All records of the job are judged; there is no `JUDGE_PREFIX`/`JUDGE_PREFIX`-style cut-off that quietly leaves the tail of the corpus unverified. The draft stops after the first hundred.',
      match: {
        python: {all: [/records/], none: [/JUDGE_PREFIX/]},
        typescript: {all: [/records/], none: [/JUDGE_PREFIX/]},
        go: {all: [/records/], none: [/judgePrefix/]},
        scala: {all: [/records/], none: [/JudgePrefix/]},
        cpp: {all: [/records/], none: [/kJudgePrefix/]},
      },
    },
    {
      id: 'score-before-admit',
      title: 'Never admits a record without a judge score',
      detail:
        '`admit` is only reached with a real score; no default score stands in for a timeout and no "likely fine" path exists. The draft admits unscored records with `DEFAULT_SCORE = 1`.',
      match: {
        python: {all: [/admit\(/, /score/], none: [/likely fine|assume_ok|DEFAULT_SCORE\s*=\s*1/]},
        typescript: {all: [/admit\(/, /score/], none: [/likely fine|assumeOk|DEFAULT_SCORE\s*=\s*1/]},
        go: {all: [/admit\(/, /Score/], none: [/likely fine|assumeOK|defaultScore\s*=\s*1/]},
        scala: {all: [/admit\(/, /score/], none: [/likely fine|assumeOk|DefaultScore\s*=\s*1/]},
        cpp: {all: [/admit\(/, /score/], none: [/likely fine|assume_ok|kDefaultScore\s*=\s*1/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

import grpc

import judge_pb2
import judge_pb2_grpc

from synthd.records import admit

JUDGE_PREFIX = 100
DEFAULT_SCORE = 1.0
RETRY_LIMIT = 3

channel = grpc.insecure_channel("judge:9000")
judge = judge_pb2_grpc.JudgeStub(channel)
logger = logging.getLogger("synthd.generator")


def judge_record(record: dict) -> None:
    # TODO: put the 900 ms deadline on every attempt, bound the attempts at 3 and retry only
    # UNAVAILABLE / DEADLINE_EXCEEDED, park a record whose attempts run out instead of admitting it
    # with DEFAULT_SCORE, treat a refusal as terminal, and judge every record instead of the first
    # JUDGE_PREFIX ones.
    record_id = record["record_id"]
    request = judge_pb2.JudgeRequest(
        record_id=record_id,
        seed_digest=record["seed_digest"],
        content=record["content"],
    )
    for _ in range(RETRY_LIMIT):
        try:
            reply = judge.Score(request)
            if reply.verdict == "refused":
                continue
            admit(record_id, reply.score)
            return
        except Exception:
            logger.warning("judge timeout, admitting as likely fine")
            admit(record_id, DEFAULT_SCORE)
            return
    admit(record_id, DEFAULT_SCORE)


def judge_job(records: list[dict]) -> None:
    for record in records[:JUDGE_PREFIX]:
        judge_record(record)
`,
      solution: `import grpc

import judge_pb2
import judge_pb2_grpc

from synthd.records import admit, park, reject

DEADLINE_S = 0.9
MAX_ATTEMPTS = 3
VERDICT_ADMIT = "admit"
VERDICT_REFUSED = "refused"
RETRYABLE = {grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED}

channel = grpc.insecure_channel("judge:9000")
judge = judge_pb2_grpc.JudgeStub(channel)


def judge_record(record: dict) -> None:
    """Judge one record before admission: 900 ms per attempt, three attempts, park on timeout."""
    record_id = record["record_id"]
    request = judge_pb2.JudgeRequest(
        record_id=record_id,
        seed_digest=record["seed_digest"],
        content=record["content"],
    )
    for _ in range(MAX_ATTEMPTS):
        try:
            reply = judge.Score(request, timeout=DEADLINE_S)
        except grpc.RpcError as exc:
            if exc.code() in RETRYABLE:
                continue
            raise
        if reply.verdict == VERDICT_REFUSED:
            reject(record_id, "refused")
            return
        if reply.verdict != VERDICT_ADMIT:
            raise ValueError(f"judge returned an unexpected verdict {reply.verdict!r}")
        admit(record_id, reply.score)
        return
    # Attempts exhausted: the record was never scored, so it is parked — never admitted.
    park(record_id, "judge_timeout")


def judge_job(records: list[dict]) -> None:
    for record in records:
        judge_record(record)
`,
    },
    typescript: {
      starter: `/** judgeRecord: a model-generated draft that retries every failure and skips the tail of the job. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {admit} from './records';

const JUDGE_PREFIX = 100;
const DEFAULT_SCORE = 1;
const RETRY_LIMIT = 3;

interface SyntheticRecord {
  record_id: string;
  seed_digest: string;
  content: string;
}

interface JudgeReply {
  verdict: string;
  score: number;
}

interface JudgeClient {
  Score(
    request: {record_id: string; seed_digest: string; content: string},
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, reply: JudgeReply) => void,
  ): grpc.ClientUnaryCall;
}

const {judge} = grpc.loadPackageDefinition(protoLoader.loadSync('judge.proto')) as unknown as {
  judge: {Judge: new (target: string, credentials: grpc.ChannelCredentials) => JudgeClient};
};
const client = new judge.Judge('judge:9000', grpc.credentials.createInsecure());

export async function judgeRecord(record: SyntheticRecord): Promise<void> {
  // TODO: put the 900 ms deadline on every attempt, bound the attempts at 3 and retry only
  // UNAVAILABLE / DEADLINE_EXCEEDED, park a record whose attempts run out instead of admitting it
  // with DEFAULT_SCORE, treat a refusal as terminal, and judge every record instead of the first
  // JUDGE_PREFIX ones.
  const request = {record_id: record.record_id, seed_digest: record.seed_digest, content: record.content};
  for (let attempt = 0; attempt < RETRY_LIMIT; attempt += 1) {
    try {
      const reply = await new Promise<JudgeReply>((resolve, reject) => {
        client.Score(request, {}, (error, value) => (error === null ? resolve(value) : reject(error)));
      });
      if (reply.verdict === 'refused') {
        continue;
      }
      admit(record.record_id, reply.score);
      return;
    } catch {
      continue;
    }
  }
  console.warn('judge timeout, admitting as likely fine');
  admit(record.record_id, DEFAULT_SCORE);
}

export async function judgeJob(records: SyntheticRecord[]): Promise<void> {
  for (const record of records.slice(0, JUDGE_PREFIX)) {
    await judgeRecord(record);
  }
}
`,
      solution: `/** judgeRecord: 900 ms deadline per attempt, three bounded attempts, park on an exhausted timeout. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {admit, park, reject} from './records';

const DEADLINE_MS = 900;
const MAX_ATTEMPTS = 3;
const VERDICT_ADMIT = 'admit';
const VERDICT_REFUSED = 'refused';
const RETRYABLE: Record<number, true> = {
  [grpc.status.UNAVAILABLE]: true,
  [grpc.status.DEADLINE_EXCEEDED]: true,
};

interface SyntheticRecord {
  record_id: string;
  seed_digest: string;
  content: string;
}

interface JudgeReply {
  verdict: string;
  score: number;
}

interface JudgeClient {
  Score(
    request: {record_id: string; seed_digest: string; content: string},
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, reply: JudgeReply) => void,
  ): grpc.ClientUnaryCall;
}

const {judge} = grpc.loadPackageDefinition(protoLoader.loadSync('judge.proto')) as unknown as {
  judge: {Judge: new (target: string, credentials: grpc.ChannelCredentials) => JudgeClient};
};
const client = new judge.Judge('judge:9000', grpc.credentials.createInsecure());

export async function judgeRecord(record: SyntheticRecord): Promise<void> {
  const request = {record_id: record.record_id, seed_digest: record.seed_digest, content: record.content};
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    let reply: JudgeReply;
    try {
      reply = await new Promise<JudgeReply>((resolve, fail) => {
        client.Score(request, {deadline: Date.now() + DEADLINE_MS}, (error, value) =>
          error === null ? resolve(value) : fail(error),
        );
      });
    } catch (error) {
      const status = (error as grpc.ServiceError).code;
      if (RETRYABLE[status] !== true) throw error; // INVALID_ARGUMENT and the rest go back at once
      continue; // UNAVAILABLE / DEADLINE_EXCEEDED are the only two codes worth another attempt
    }
    if (reply.verdict === VERDICT_REFUSED) {
      reject(record.record_id, 'refused'); // terminal: a refusal is never retried and never admitted
      return;
    }
    if (reply.verdict !== VERDICT_ADMIT) {
      throw new Error('judge returned an unexpected verdict: ' + reply.verdict);
    }
    admit(record.record_id, reply.score);
    return;
  }
  park(record.record_id, 'judge_timeout');
}

export async function judgeJob(records: SyntheticRecord[]): Promise<void> {
  for (const record of records) {
    await judgeRecord(record);
  }
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"log"
)

const judgePrefix = 100

const defaultScore = 1.0

const retryLimit = 3

var judge pb.JudgeClient

type Record struct {
	RecordID   string
	SeedDigest string
	Content    string
}

func judgeRecord(ctx context.Context, record Record) {
	// TODO: put the 900 ms deadline on every attempt, bound the attempts at 3 and retry only
	// UNAVAILABLE / DEADLINE_EXCEEDED, park a record whose attempts run out instead of admitting it
	// with defaultScore, treat a refusal as terminal, and judge every record instead of the first
	// judgePrefix ones.
	for attempt := 0; attempt < retryLimit; attempt++ {
		reply, err := judge.Score(ctx, &pb.JudgeRequest{
			RecordId:   record.RecordID,
			SeedDigest: record.SeedDigest,
			Content:    record.Content,
		})
		if err != nil {
			continue
		}
		if reply.Verdict == "refused" {
			continue
		}
		admit(record.RecordID, reply.Score)
		return
	}
	log.Printf("judge timeout, admitting as likely fine")
	admit(record.RecordID, defaultScore)
}

func judgeJob(ctx context.Context, records []Record) {
	for _, record := range records[:judgePrefix] {
		judgeRecord(ctx, record)
	}
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	deadlineMS  = 900
	maxAttempts = 3
)

const (
	verdictAdmit   = "admit"
	verdictRefused = "refused"
)

var judge pb.JudgeClient

type Record struct {
	RecordID   string
	SeedDigest string
	Content    string
}

func retryable(code codes.Code) bool {
	return code == codes.Unavailable || code == codes.DeadlineExceeded
}

func judgeRecord(ctx context.Context, record Record) error {
	request := &pb.JudgeRequest{
		RecordId:   record.RecordID,
		SeedDigest: record.SeedDigest,
		Content:    record.Content,
	}
	for attempt := 0; attempt < maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadlineMS*time.Millisecond)
		reply, err := judge.Score(callCtx, request)
		cancel()
		if err != nil {
			if retryable(status.Code(err)) {
				continue
			}
			return err
		}
		if reply.Verdict == verdictRefused {
			reject(record.RecordID, "refused")
			return nil
		}
		if reply.Verdict != verdictAdmit {
			return fmt.Errorf("judge returned an unexpected verdict %q", reply.Verdict)
		}
		admit(record.RecordID, reply.Score)
		return nil
	}
	// Attempts exhausted: the record was never scored, so it is parked — never admitted.
	park(record.RecordID, "judge_timeout")
	return nil
}

func judgeJob(ctx context.Context, records []Record) error {
	for _, record := range records {
		if err := judgeRecord(ctx, record); err != nil {
			return err
		}
	}
	return nil
}
`,
    },
    scala: {
      starter: `import io.grpc.ManagedChannelBuilder

final case class Record(record_id: String, seed_digest: String, content: String)

object Judge {
  val JudgePrefix = 100
  val DefaultScore = 1.0
  val RetryLimit = 3

  val judge = JudgeGrpc.blockingStub(
    ManagedChannelBuilder.forAddress("judge", 9000).usePlaintext().build()
  )

  def judgeRecord(record: Record): Unit = {
    // TODO: put the 900 ms deadline on every attempt, bound the attempts at 3 and retry only
    // UNAVAILABLE / DEADLINE_EXCEEDED, park a record whose attempts run out instead of admitting it
    // with DefaultScore, treat a refusal as terminal, and judge every record instead of the first
    // JudgePrefix ones.
    for (_ <- 0 until RetryLimit) {
      try {
        val reply = judge.score(
          JudgeRequest(recordId = record.record_id, seedDigest = record.seed_digest, content = record.content)
        )
        if (reply.verdict == "refused") {
          // the next attempt may not refuse it
        } else {
          admit(record.record_id, reply.score)
          return
        }
      } catch {
        case _: Throwable => // retry
      }
    }
    System.err.println("judge timeout, admitting as likely fine")
    admit(record.record_id, DefaultScore)
  }

  def judgeJob(records: Seq[Record]): Unit =
    records.take(JudgePrefix).foreach(judgeRecord)
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

final case class Record(record_id: String, seed_digest: String, content: String)

object Judge {
  val DeadlineMs = 900L
  val MaxAttempts = 3
  val VerdictAdmit = "admit"
  val VerdictRefused = "refused"

  val judge = JudgeGrpc.blockingStub(
    ManagedChannelBuilder.forAddress("judge", 9000).usePlaintext().build()
  )

  def retryable(code: Status.Code): Boolean =
    code == Status.Code.UNAVAILABLE || code == Status.Code.DEADLINE_EXCEEDED

  def judgeRecord(record: Record): Unit = {
    val request = JudgeRequest(
      recordId = record.record_id,
      seedDigest = record.seed_digest,
      content = record.content
    )
    var attempt = 0
    while (attempt < MaxAttempts) {
      attempt += 1
      try {
        val reply = judge.withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS).score(request)
        if (reply.verdict == VerdictRefused) {
          reject(record.record_id, "refused")
          return
        }
        if (reply.verdict != VerdictAdmit) {
          throw new IllegalStateException("judge returned an unexpected verdict: " + reply.verdict)
        }
        admit(record.record_id, reply.score)
        return
      } catch {
        case e: StatusRuntimeException =>
          if (!retryable(e.getStatus.getCode)) throw e
      }
    }
    // Attempts exhausted: the record was never scored, so it is parked — never admitted.
    park(record.record_id, "judge_timeout")
  }

  def judgeJob(records: Seq[Record]): Unit =
    records.foreach(judgeRecord)
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include "judge.grpc.pb.h"

#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

constexpr int kJudgePrefix = 100;
constexpr double kDefaultScore = 1.0;
constexpr int kRetryLimit = 3;

std::unique_ptr<Judge::Stub> judge;

struct Record {
  std::string record_id;
  std::string seed_digest;
  std::string content;
};

void judgeRecord(const Record& record) {
  // TODO: put the 900 ms deadline on every attempt, bound the attempts at 3 and retry only
  // UNAVAILABLE / DEADLINE_EXCEEDED, park a record whose attempts run out instead of admitting it
  // with kDefaultScore, treat a refusal as terminal, and judge every record instead of the first
  // kJudgePrefix ones.
  JudgeRequest request;
  request.set_record_id(record.record_id);
  request.set_seed_digest(record.seed_digest);
  request.set_content(record.content);
  for (int attempt = 0; attempt < kRetryLimit; attempt++) {
    try {
      grpc::ClientContext ctx;
      JudgeReply reply;
      const grpc::Status status = judge->Score(&ctx, request, &reply);
      if (!status.ok()) {
        throw std::runtime_error(status.error_message());
      }
      if (reply.verdict() == "refused") {
        continue;
      }
      admit(record.record_id, reply.score());
      return;
    } catch (...) {
      continue;
    }
  }
  std::cerr << "judge timeout, admitting as likely fine" << std::endl;
  admit(record.record_id, kDefaultScore);
}

void judgeJob(const std::vector<Record>& records) {
  for (int i = 0; i < kJudgePrefix && i < static_cast<int>(records.size()); i++) {
    judgeRecord(records[i]);
  }
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include "judge.grpc.pb.h"

#include <chrono>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

constexpr int kDeadlineMs = 900;
constexpr int kMaxAttempts = 3;
constexpr char kVerdictAdmit[] = "admit";
constexpr char kVerdictRefused[] = "refused";

std::unique_ptr<Judge::Stub> judge;

struct Record {
  std::string record_id;
  std::string seed_digest;
  std::string content;
};

bool retryable(grpc::StatusCode code) {
  return code == grpc::StatusCode::UNAVAILABLE || code == grpc::StatusCode::DEADLINE_EXCEEDED;
}

void judgeRecord(const Record& record) {
  JudgeRequest request;
  request.set_record_id(record.record_id);
  request.set_seed_digest(record.seed_digest);
  request.set_content(record.content);
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kDeadlineMs));
    JudgeReply reply;
    const grpc::Status status = judge->Score(&ctx, request, &reply);
    if (!status.ok()) {
      if (retryable(status.error_code())) continue;
      throw std::runtime_error(status.error_message());
    }
    if (reply.verdict() == kVerdictRefused) {
      reject(record.record_id, "refused");
      return;
    }
    if (reply.verdict() != kVerdictAdmit) {
      throw std::runtime_error("judge returned an unexpected verdict: " + reply.verdict());
    }
    admit(record.record_id, reply.score());
    return;
  }
  // Attempts exhausted: the record was never scored, so it is parked — never admitted.
  park(record.record_id, "judge_timeout");
}

void judgeJob(const std::vector<Record>& records) {
  for (const Record& record : records) {
    judgeRecord(record);
  }
}
`,
    },
  },
  debrief: `The interviewer is testing whether you can name a third outcome. Most drafts have admit and reject, and then a timeout error that has to become one of them; the correct answer is neither — park it, count it, and let the report carry the number. That is what stops infrastructure flakiness from becoming label noise: an unscored record cannot be admitted as truth because the admission path requires a score. The refusal matters because it is the one verdict the judge will repeat forever: retrying it spends budget on an answer that does not change. The prefix cap is the trap for the cost-minded candidate: judging a prefix optimizes a metric that no longer measures the corpus. Real systems add a rejudge queue for parked records, per-entity judge cost budgets, and a separate score for the judge's own confidence.`,
};
