import type {Step} from '@/lib/types';

export const rerankClientStep: Step = {
  id: 'dependency',
  title: 'The reranker client: batches, a deadline, unscored is not a score',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'reranker'],
  task: `## Task

**Starting point.** The starter's \`rerank_passages(query, passages)\` calls \`Reranker.Score\`
(\`reranker_service.proto\`, served as a stand-in at \`rerank.config\`'s \`MODEL\`) in batches of
\`BATCH_SIZE\` = 128 with a 5-second timeout, retries a failed batch up to \`MAX_ATTEMPTS\` = 3 times
whatever the status, then fills it with \`NEUTRAL_SCORE\` = 0.5, and returns one score per passage.
Against a healthy model it answers in one call per batch. It hides 4 flaws.

**Failure mode the checks target.** When the model degrades the list does not look broken, it looks
reordered: a failed batch comes back as a row of 0.5s that outrank genuinely weak passages, a slow
replica holds the request for seconds per batch, and a batch the model rejects as malformed is sent
three times and then scored as if nothing happened.

\`\`\`proto
service Reranker { rpc Score(ScoreRequest) returns (ScoreReply); }
message ScoreRequest { string query = 1; repeated string passages = 2; }
message ScoreReply   { repeated double scores = 1; string model_version = 2; }
\`\`\`

- \`BATCH_SIZE\` is **64**; every call carries a **700 ms** deadline (\`BATCH_DEADLINE_S\`).
- A batch that fails (deadline, \`UNAVAILABLE\`, any status but one) is called once and its passages
  come back **unscored** (\`None\`/\`null\`/\`nil\`/\`nullopt\`); the other batches keep their scores.
- \`INVALID_ARGUMENT\` is terminal: no retry, and \`rerank_passages\` raises (Go: returns an error).`,
  sequence: {
    participants: ['Rerank API', 'Reranker model'],
    messages: [
      {from: 'Rerank API', to: 'Rerank API', label: 'slice passages into batches of 64', kind: 'sync'},
      {from: 'Rerank API', to: 'Reranker model', label: 'Score(batch 1) · deadline 700 ms', kind: 'sync'},
      {from: 'Reranker model', to: 'Rerank API', label: 'scores', kind: 'reply'},
      {from: 'Rerank API', to: 'Reranker model', label: 'Score(batch 2) · deadline 700 ms', kind: 'sync'},
      {from: 'Reranker model', to: 'Rerank API', label: 'UNAVAILABLE', kind: 'reply'},
      {from: 'Rerank API', to: 'Rerank API', label: 'batch 2 unscored · batch 3 still runs', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'batch-size',
      title: 'Calls the model in batches of 64',
      detail:
        '150 passages are three calls of 64, 64 and 22 passages, and the scores come back one per passage in request order. The starter sends 128 and 22.',
      match: {
        python: {all: [/BATCH_SIZE\s*=\s*64\b/]},
        typescript: {all: [/BATCH_SIZE\s*=\s*64\b/]},
        go: {all: [/batchSize\s*=\s*64\b/]},
        scala: {all: [/BatchSize\s*=\s*64\b/]},
        cpp: {all: [/kBatchSize\s*=\s*64\b/]},
      },
    },
    {
      id: 'batch-deadline',
      title: 'Puts a 700 ms deadline on every call',
      detail:
        'Every Score call carries a deadline of about 700 ms, so a replica that takes a second per batch costs 0.7 s per batch and leaves those passages unscored. The starter waits up to 5 s.',
      match: {
        python: {all: [/BATCH_DEADLINE_S\s*=\s*0?\.7\b/, /timeout\s*=\s*BATCH_DEADLINE_S/]},
        typescript: {all: [/BATCH_DEADLINE_MS\s*=\s*700\b/, /deadline:\s*Date\.now\(\)\s*\+\s*BATCH_DEADLINE_MS/]},
        go: {all: [/700\s*\*\s*time\.Millisecond/, /context\.WithTimeout\(/]},
        scala: {all: [/BatchDeadlineMs\s*=\s*700L?\b/, /withDeadlineAfter\(\s*BatchDeadlineMs/]},
        cpp: {all: [/kBatchDeadline\{\s*700\s*\}/, /set_deadline\(/]},
      },
    },
    {
      id: 'unscored-not-neutral',
      title: 'Marks a failed batch unscored, once',
      detail:
        'A batch the model keeps failing (`UNAVAILABLE`) is called once and its passages come back unscored; the batches around it keep their scores. The starter calls it three times and fills it with 0.5, so an outage reads as mid-tier relevance.',
      match: {
        python: {all: [/\[None\]\s*\*/], none: [/NEUTRAL_SCORE/]},
        typescript: {all: [/\bnull\b/], none: [/NEUTRAL_SCORE/]},
        go: {all: [/\bnil\b/], none: [/neutralScore/]},
        scala: {all: [/\bNone\b/], none: [/NeutralScore/]},
        cpp: {all: [/std::nullopt/], none: [/kNeutralScore/]},
      },
    },
    {
      id: 'malformed-terminal',
      title: 'Stops at INVALID_ARGUMENT without a retry',
      detail:
        'A batch the model rejects as `INVALID_ARGUMENT` (an empty passage) is called once and `rerank_passages` raises; a malformed request does not get better on the second try. The starter retries it twice and returns neutral scores.',
      match: {
        python: {all: [/StatusCode\.INVALID_ARGUMENT/, /\braise\b/], none: [/MAX_ATTEMPTS/]},
        typescript: {all: [/status\.INVALID_ARGUMENT/, /\bthrow\b/], none: [/MAX_ATTEMPTS/]},
        go: {all: [/codes\.InvalidArgument/], none: [/maxAttempts/]},
        scala: {all: [/INVALID_ARGUMENT/, /\bthrow\b/], none: [/MaxAttempts/]},
        cpp: {all: [/StatusCode::INVALID_ARGUMENT/, /\bthrow\b/], none: [/kMaxAttempts/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import reranker_service_pb2
import reranker_service_pb2_grpc
from rerank.config import MODEL

BATCH_SIZE = 128
TIMEOUT_S = 5.0
MAX_ATTEMPTS = 3
NEUTRAL_SCORE = 0.5

channel = grpc.insecure_channel(MODEL)
stub = reranker_service_pb2_grpc.RerankerStub(channel)


def score_batch(query: str, batch: list[str]) -> list[float]:
    """One batch: retried on any error; a batch that keeps failing scores NEUTRAL_SCORE."""
    for _ in range(MAX_ATTEMPTS):
        try:
            reply = stub.Score(reranker_service_pb2.ScoreRequest(query=query, passages=batch), timeout=TIMEOUT_S)
            return list(reply.scores)
        except grpc.RpcError:
            continue
    return [NEUTRAL_SCORE] * len(batch)


def rerank_passages(query: str, passages: list[str]) -> list[float]:
    """One score per passage, in passage order."""
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    scores = []
    for start in range(0, len(passages), BATCH_SIZE):
        scores.extend(score_batch(query, passages[start : start + BATCH_SIZE]))
    return scores
`,
      solution: `import logging

import grpc

import reranker_service_pb2
import reranker_service_pb2_grpc
from rerank.config import MODEL

logger = logging.getLogger("rerank.client")

BATCH_SIZE = 64
BATCH_DEADLINE_S = 0.7

channel = grpc.insecure_channel(MODEL)
stub = reranker_service_pb2_grpc.RerankerStub(channel)


class MalformedBatch(Exception):
    """The model rejected a batch as invalid: a bug in the request, not a brownout."""


def score_batch(query: str, batch: list[str]) -> list[float | None]:
    """One batch, one call: its scores, or None for each passage when the call failed."""
    try:
        reply = stub.Score(reranker_service_pb2.ScoreRequest(query=query, passages=batch), timeout=BATCH_DEADLINE_S)
    except grpc.RpcError as err:
        if err.code() == grpc.StatusCode.INVALID_ARGUMENT:
            raise MalformedBatch(err.details()) from err
        logger.warning("rerank batch unscored: %s (%d passages)", err.code().name, len(batch))
        return [None] * len(batch)  # unscored is not a score: the caller keeps retrieval order for these
    return list(reply.scores)


def rerank_passages(query: str, passages: list[str]) -> list[float | None]:
    """One score per passage, in passage order; None for a passage whose batch failed."""
    scores: list[float | None] = []
    for start in range(0, len(passages), BATCH_SIZE):
        scores.extend(score_batch(query, passages[start : start + BATCH_SIZE]))
    return scores
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {MODEL} from 'rerank/config';

export const BATCH_SIZE = 128;
export const TIMEOUT_MS = 5_000;
export const MAX_ATTEMPTS = 3;
export const NEUTRAL_SCORE = 0.5;

interface ScoreRequest {
  query: string;
  passages: string[];
}
interface ScoreReply {
  scores: number[];
  model_version: string;
}
interface RerankerClient {
  Score(request: ScoreRequest, options?: {deadline: number}): Promise<ScoreReply>;
}

const {rerankd} = grpc.loadPackageDefinition(protoLoader.loadSync('reranker_service.proto')) as unknown as {
  rerankd: {Reranker: new (target: string, credentials: grpc.ChannelCredentials) => RerankerClient};
};
const stub = new rerankd.Reranker(MODEL, grpc.credentials.createInsecure());

/** One batch: retried on any error; a batch that keeps failing scores NEUTRAL_SCORE. */
async function scoreBatch(query: string, batch: string[]): Promise<number[]> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const reply = await stub.Score({query, passages: batch}, {deadline: Date.now() + TIMEOUT_MS});
      return reply.scores;
    } catch {
      continue;
    }
  }
  return batch.map(() => NEUTRAL_SCORE);
}

/** One score per passage, in passage order. */
export async function rerankPassages(query: string, passages: string[]): Promise<number[]> {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const scores: number[] = [];
  for (let start = 0; start < passages.length; start += BATCH_SIZE) {
    scores.push(...(await scoreBatch(query, passages.slice(start, start + BATCH_SIZE))));
  }
  return scores;
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {MODEL} from 'rerank/config';

export const BATCH_SIZE = 64;
export const BATCH_DEADLINE_MS = 700;

interface ScoreRequest {
  query: string;
  passages: string[];
}
interface ScoreReply {
  scores: number[];
  model_version: string;
}
interface RerankerClient {
  Score(request: ScoreRequest, options?: {deadline: number}): Promise<ScoreReply>;
}

const {rerankd} = grpc.loadPackageDefinition(protoLoader.loadSync('reranker_service.proto')) as unknown as {
  rerankd: {Reranker: new (target: string, credentials: grpc.ChannelCredentials) => RerankerClient};
};
const stub = new rerankd.Reranker(MODEL, grpc.credentials.createInsecure());

/** The model rejected a batch as invalid: a bug in the request, not a brownout. */
export class MalformedBatch extends Error {}

/** One batch, one call: its scores, or null for each passage when the call failed. */
async function scoreBatch(query: string, batch: string[]): Promise<(number | null)[]> {
  try {
    const reply = await stub.Score({query, passages: batch}, {deadline: Date.now() + BATCH_DEADLINE_MS});
    return reply.scores;
  } catch (err) {
    const {code, details} = err as grpc.ServiceError;
    if (code === grpc.status.INVALID_ARGUMENT) throw new MalformedBatch(details);
    console.warn(\`rerank batch unscored: status \${code} (\${batch.length} passages)\`);
    return batch.map(() => null); // unscored is not a score: the caller keeps retrieval order for these
  }
}

/** One score per passage, in passage order; null for a passage whose batch failed. */
export async function rerankPassages(query: string, passages: string[]): Promise<(number | null)[]> {
  const scores: (number | null)[] = [];
  for (let start = 0; start < passages.length; start += BATCH_SIZE) {
    scores.push(...(await scoreBatch(query, passages.slice(start, start + BATCH_SIZE))));
  }
  return scores;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"rerank/config" // config.Model — provided
	pb "rerank/gen/reranker_service"
)

const (
	batchSize    = 128
	timeout      = 5 * time.Second
	maxAttempts  = 3
	neutralScore = 0.5
)

var conn, _ = grpc.NewClient(config.Model, grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewRerankerClient(conn)

// scoreBatch scores one batch: retried on any error; a batch that keeps failing scores neutralScore.
func scoreBatch(ctx context.Context, query string, batch []string) []*float64 {
	for attempt := 0; attempt < maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, timeout)
		reply, err := stub.Score(callCtx, &pb.ScoreRequest{Query: query, Passages: batch})
		cancel()
		if err != nil {
			continue
		}
		out := make([]*float64, len(batch))
		for i, s := range reply.GetScores() {
			score := s
			out[i] = &score
		}
		return out
	}
	out := make([]*float64, len(batch))
	for i := range out {
		score := neutralScore
		out[i] = &score
	}
	return out
}

// rerankPassages returns one score per passage, in passage order.
func rerankPassages(ctx context.Context, query string, passages []string) ([]*float64, error) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	scores := make([]*float64, 0, len(passages))
	for start := 0; start < len(passages); start += batchSize {
		end := start + batchSize
		if end > len(passages) {
			end = len(passages)
		}
		scores = append(scores, scoreBatch(ctx, query, passages[start:end])...)
	}
	return scores, nil
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"log"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"rerank/config" // config.Model — provided
	pb "rerank/gen/reranker_service"
)

const (
	batchSize     = 64
	batchDeadline = 700 * time.Millisecond
)

var conn, _ = grpc.NewClient(config.Model, grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewRerankerClient(conn)

// scoreBatch makes one call for one batch: its scores, or nil for each passage when the call
// failed; an error only when the model rejected the batch as malformed.
func scoreBatch(ctx context.Context, query string, batch []string) ([]*float64, error) {
	out := make([]*float64, len(batch))
	callCtx, cancel := context.WithTimeout(ctx, batchDeadline)
	reply, err := stub.Score(callCtx, &pb.ScoreRequest{Query: query, Passages: batch})
	cancel()
	if err != nil {
		if status.Code(err) == codes.InvalidArgument {
			return nil, fmt.Errorf("malformed batch: %w", err)
		}
		log.Printf("rerank batch unscored: %s (%d passages)", status.Code(err), len(batch))
		return out, nil // unscored is not a score: the caller keeps retrieval order for these
	}
	for i, s := range reply.GetScores() {
		score := s
		out[i] = &score
	}
	return out, nil
}

// rerankPassages returns one score per passage, in passage order; nil for a passage whose batch failed.
func rerankPassages(ctx context.Context, query string, passages []string) ([]*float64, error) {
	scores := make([]*float64, 0, len(passages))
	for start := 0; start < len(passages); start += batchSize {
		end := start + batchSize
		if end > len(passages) {
			end = len(passages)
		}
		batch, err := scoreBatch(ctx, query, passages[start:end])
		if err != nil {
			return nil, err
		}
		scores = append(scores, batch...)
	}
	return scores, nil
}
`,
    },
    scala: {
      starter: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import rerank.Config
import rerankd.reranker_service.{RerankerGrpc, ScoreRequest}

object RerankerClient {
  val BatchSize = 128
  val TimeoutMs = 5000L
  val MaxAttempts = 3
  val NeutralScore = 0.5

  private val channel = ManagedChannelBuilder.forTarget(Config.Model).usePlaintext().build()
  private val stub = RerankerGrpc.blockingStub(channel)

  /** One batch: retried on any error; a batch that keeps failing scores NeutralScore. */
  private def scoreBatch(query: String, batch: Seq[String]): Seq[Option[Double]] = {
    var attempt = 0
    while (attempt < MaxAttempts) {
      try {
        val reply = stub.withDeadlineAfter(TimeoutMs, TimeUnit.MILLISECONDS).score(ScoreRequest(query = query, passages = batch))
        return reply.scores.map(Some(_))
      } catch {
        case _: StatusRuntimeException => attempt += 1
      }
    }
    batch.map(_ => Some(NeutralScore))
  }

  /** One score per passage, in passage order. */
  def rerankPassages(query: String, passages: Seq[String]): Seq[Option[Double]] = {
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    passages.grouped(BatchSize).toSeq.flatMap(scoreBatch(query, _))
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import rerank.Config
import rerankd.reranker_service.{RerankerGrpc, ScoreRequest}

/** The model rejected a batch as invalid: a bug in the request, not a brownout. */
final class MalformedBatch(message: String) extends RuntimeException(message)

object RerankerClient {
  val BatchSize = 64
  val BatchDeadlineMs = 700L

  private val channel = ManagedChannelBuilder.forTarget(Config.Model).usePlaintext().build()
  private val stub = RerankerGrpc.blockingStub(channel)

  /** One batch, one call: its scores, or None for each passage when the call failed. */
  private def scoreBatch(query: String, batch: Seq[String]): Seq[Option[Double]] =
    try {
      val reply = stub.withDeadlineAfter(BatchDeadlineMs, TimeUnit.MILLISECONDS).score(ScoreRequest(query = query, passages = batch))
      reply.scores.map(Some(_))
    } catch {
      case e: StatusRuntimeException if e.getStatus.getCode == Status.Code.INVALID_ARGUMENT =>
        throw new MalformedBatch(e.getStatus.getDescription)
      case e: StatusRuntimeException =>
        System.err.println(s"rerank batch unscored: \${e.getStatus.getCode} (\${batch.size} passages)")
        batch.map(_ => None) // unscored is not a score: the caller keeps retrieval order for these
    }

  /** One score per passage, in passage order; None for a passage whose batch failed. */
  def rerankPassages(query: String, passages: Seq[String]): Seq[Option[Double]] =
    passages.grouped(BatchSize).toSeq.flatMap(scoreBatch(query, _))
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <algorithm>
#include <chrono>
#include <optional>
#include <string>
#include <vector>

#include "rerank/config.h"  // config::kModel — provided
#include "reranker_service.grpc.pb.h"

constexpr size_t kBatchSize = 128;
constexpr std::chrono::seconds kTimeout{5};
constexpr int kMaxAttempts = 3;
constexpr double kNeutralScore = 0.5;

auto channel = grpc::CreateChannel(config::kModel, grpc::InsecureChannelCredentials());
auto stub = rerankd::Reranker::NewStub(channel);

// One batch: retried on any error; a batch that keeps failing scores kNeutralScore.
std::vector<std::optional<double>> scoreBatch(const std::string& query, const std::vector<std::string>& batch) {
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kTimeout);
    rerankd::ScoreRequest request;
    request.set_query(query);
    for (const std::string& p : batch) request.add_passages(p);
    rerankd::ScoreReply reply;
    if (stub->Score(&ctx, request, &reply).ok()) return {reply.scores().begin(), reply.scores().end()};
  }
  return std::vector<std::optional<double>>(batch.size(), kNeutralScore);
}

// One score per passage, in passage order.
std::vector<std::optional<double>> rerankPassages(const std::string& query, const std::vector<std::string>& passages) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  std::vector<std::optional<double>> scores;
  for (size_t start = 0; start < passages.size(); start += kBatchSize) {
    const size_t end = std::min(start + kBatchSize, passages.size());
    const auto batch = scoreBatch(query, std::vector<std::string>(passages.begin() + start, passages.begin() + end));
    scores.insert(scores.end(), batch.begin(), batch.end());
  }
  return scores;
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <algorithm>
#include <chrono>
#include <iostream>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

#include "rerank/config.h"  // config::kModel — provided
#include "reranker_service.grpc.pb.h"

constexpr size_t kBatchSize = 64;
constexpr std::chrono::milliseconds kBatchDeadline{700};

auto channel = grpc::CreateChannel(config::kModel, grpc::InsecureChannelCredentials());
auto stub = rerankd::Reranker::NewStub(channel);

// The model rejected a batch as invalid: a bug in the request, not a brownout.
struct MalformedBatch : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// One batch, one call: its scores, or nullopt for each passage when the call failed.
std::vector<std::optional<double>> scoreBatch(const std::string& query, const std::vector<std::string>& batch) {
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kBatchDeadline);
  rerankd::ScoreRequest request;
  request.set_query(query);
  for (const std::string& p : batch) request.add_passages(p);
  rerankd::ScoreReply reply;
  const grpc::Status status = stub->Score(&ctx, request, &reply);
  if (status.ok()) return {reply.scores().begin(), reply.scores().end()};
  if (status.error_code() == grpc::StatusCode::INVALID_ARGUMENT) throw MalformedBatch(status.error_message());
  std::cerr << "rerank batch unscored: status " << status.error_code() << " (" << batch.size() << " passages)\\n";
  return std::vector<std::optional<double>>(batch.size(), std::nullopt);  // unscored is not a score
}

// One score per passage, in passage order; nullopt for a passage whose batch failed.
std::vector<std::optional<double>> rerankPassages(const std::string& query, const std::vector<std::string>& passages) {
  std::vector<std::optional<double>> scores;
  for (size_t start = 0; start < passages.size(); start += kBatchSize) {
    const size_t end = std::min(start + kBatchSize, passages.size());
    const auto batch = scoreBatch(query, std::vector<std::string>(passages.begin() + start, passages.begin() + end));
    scores.insert(scores.end(), batch.begin(), batch.end());
  }
  return scores;
}
`,
    },
  },
  harness: {
    python: `import grpc

import reranker_service_pb2
import reranker_service_pb2_grpc
from rerank import config, model

QUERY = "solar panel efficiency"


class RerankerServicer(reranker_service_pb2_grpc.RerankerServicer):
    """The stand-in cross-encoder: scores from rerank.model, faults from model.batch_fault; records batch sizes."""

    def __init__(self):
        self.batches = []

    def Score(self, request, context):
        passages = list(request.passages)
        self.batches.append(len(passages))
        fault = model.batch_fault(passages)
        if fault == "unavailable":
            context.abort(grpc.StatusCode.UNAVAILABLE, "replica draining")
        if fault == "invalid_argument":
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, "empty passage in batch")
        return reranker_service_pb2.ScoreReply(scores=[model.score(request.query, p) for p in passages], model_version=model.MODEL_VERSION)


def _world(ctx):
    servicer = RerankerServicer()
    ctx.grpc.serve(reranker_service_pb2_grpc.add_RerankerServicer_to_server, servicer, config.MODEL)
    return ctx.load("client"), servicer


def _passages(n):
    words = ["solar", "panel", "efficiency", "wind"]
    return [f"{words[i % 4]} {words[(i + 1) % 4]} note {i}" for i in range(n)]


def _calls(ctx):
    return ctx.grpc.calls_to("Score")


def check_batch_size(ctx):
    m, servicer = _world(ctx)
    passages = _passages(150)
    scores = m.rerank_passages(QUERY, passages)
    assert servicer.batches == [64, 64, 22], f"150 passages must be three calls of 64, 64 and 22, the model saw batches of {servicer.batches}"
    assert isinstance(scores, list) and len(scores) == 150, f"one score per passage: expected 150, got {len(scores) if isinstance(scores, list) else scores!r}"
    wrong = [i for i, (got, p) in enumerate(zip(scores, passages)) if got is None or abs(got - model.score(QUERY, p)) > 1e-6]
    assert not wrong, f"the scores must be the model's, in passage order; passages {wrong[:5]} are not"


def check_batch_deadline(ctx):
    m, _ = _world(ctx)
    m.rerank_passages(QUERY, _passages(10))
    calls = _calls(ctx)
    assert calls and calls[0].timeout is not None, "the Score call carries no deadline: a slow replica holds the request as long as it likes"
    assert 0.6 <= calls[0].timeout <= 0.75, f"each call's deadline must be 700 ms, got {calls[0].timeout:.2f} s"
    ctx.grpc.set_latency("Score", 1.0, config.MODEL)
    started = ctx.clock.offset
    scores = m.rerank_passages(QUERY, _passages(100))
    waited = ctx.clock.offset - started
    assert scores == [None] * 100, f"a replica that takes 1 s per batch must leave both batches unscored at 700 ms, got {[s for s in scores[:3]]}…"
    assert len(_calls(ctx)) == 3, f"two batches must be two calls, saw {len(_calls(ctx)) - 1}"
    assert waited <= 1.6, f"two slow batches held the request {waited:.1f} s: each must be cut at 700 ms"


def check_unscored_not_neutral(ctx):
    m, servicer = _world(ctx)
    passages = _passages(150)
    passages[70] = "brownout: solar panel"  # the second batch lands on a replica that keeps failing
    scores = m.rerank_passages(QUERY, passages)
    assert len(scores) == 150, f"one entry per passage: expected 150, got {len(scores)}"
    failed = scores[64:128]
    assert all(s is None for s in failed), f"the passages of the failed batch must come back unscored (None), got {sorted({repr(s) for s in failed})}: a neutral score makes an outage read as mid-tier relevance"
    kept = [i for i in list(range(64)) + list(range(128, 150)) if scores[i] is None or abs(scores[i] - model.score(QUERY, passages[i])) > 1e-6]
    assert not kept, f"the healthy batches must keep their scores; passages {kept[:5]} lost theirs"
    assert len(servicer.batches) == 3, f"three batches must be three calls, the model was called {len(servicer.batches)} times: a failed batch is not retried inside the 700 ms budget"


def check_malformed_terminal(ctx):
    m, servicer = _world(ctx)
    try:
        result = m.rerank_passages(QUERY, ["solar panel", "", "wind panel"])
    except Exception:  # noqa: BLE001 - any exception is the expected ending
        result = None
    else:
        raise AssertionError(f"a batch the model rejected as INVALID_ARGUMENT must end the call with an error, rerank_passages returned {result!r}")
    assert len(servicer.batches) == 1, f"INVALID_ARGUMENT is terminal: the model must be called once, it was called {len(servicer.batches)} times"
    assert m.rerank_passages(QUERY, ["solar panel"]) is not None, "a well-formed request after the malformed one is served"
`,
    typescript: `const QUERY = 'solar panel efficiency';

function world(ctx) {
  const {rerankd} = ctx.proto('reranker_service.proto');
  const config = ctx.load('/support/rerank/config.ts');
  const model = ctx.load('/support/rerank/model.ts');
  const batches: number[] = [];
  ctx.grpc.serve(rerankd.Reranker.service, {
    Score(call, callback) {
      const passages: string[] = call.request.passages ?? [];
      batches.push(passages.length);
      const fault = model.batchFault(passages);
      if (fault === 'unavailable') return callback({code: ctx.grpc.status.UNAVAILABLE, details: 'replica draining'});
      if (fault === 'invalid_argument') return callback({code: ctx.grpc.status.INVALID_ARGUMENT, details: 'empty passage in batch'});
      callback(null, {scores: passages.map(p => model.score(call.request.query, p)), model_version: model.MODEL_VERSION});
    },
  }, config.MODEL);
  return {m: ctx.load('client'), batches, model, config};
}

const passagesOf = (n: number): string[] => {
  const words = ['solar', 'panel', 'efficiency', 'wind'];
  return Array.from({length: n}, (_, i) => \`\${words[i % 4]} \${words[(i + 1) % 4]} note \${i}\`);
};

export async function check_batch_size(ctx) {
  const {m, batches, model} = world(ctx);
  const passages = passagesOf(150);
  const scores = await m.rerankPassages(QUERY, passages);
  assert.deepEqual(batches, [64, 64, 22], \`150 passages must be three calls of 64, 64 and 22, the model saw batches of \${JSON.stringify(batches)}\`);
  assert(Array.isArray(scores) && scores.length === 150, \`one score per passage: expected 150, got \${Array.isArray(scores) ? scores.length : JSON.stringify(scores)}\`);
  const wrong = passages.flatMap((p, i) => (scores[i] === null || Math.abs(scores[i] - model.score(QUERY, p)) > 1e-6 ? [i] : []));
  assert.equal(wrong.length, 0, \`the scores must be the model's, in passage order; passages \${JSON.stringify(wrong.slice(0, 5))} are not\`);
}

export async function check_batch_deadline(ctx) {
  const {m, config} = world(ctx);
  await m.rerankPassages(QUERY, passagesOf(10));
  const first = ctx.grpc.callsTo('Score')[0];
  assert(first && first.timeout !== null, 'the Score call carries no deadline: a slow replica holds the request as long as it likes');
  assert(first.timeout >= 0.6 && first.timeout <= 0.75, \`each call's deadline must be 700 ms, got \${first.timeout} s\`);
  ctx.grpc.setLatency('Score', 1.0, config.MODEL);
  const started = ctx.clock.now();
  const scores = await m.rerankPassages(QUERY, passagesOf(100));
  const waited = (ctx.clock.now() - started) / 1000;
  assert(scores.length === 100 && scores.every(s => s === null), \`a replica that takes 1 s per batch must leave both batches unscored at 700 ms, got \${JSON.stringify(scores.slice(0, 3))}…\`);
  assert.equal(ctx.grpc.callsTo('Score').length, 3, \`two batches must be two calls, saw \${ctx.grpc.callsTo('Score').length - 1}\`);
  assert(waited <= 1.6, \`two slow batches held the request \${waited.toFixed(1)} s: each must be cut at 700 ms\`);
}

export async function check_unscored_not_neutral(ctx) {
  const {m, batches, model} = world(ctx);
  const passages = passagesOf(150);
  passages[70] = 'brownout: solar panel'; // the second batch lands on a replica that keeps failing
  const scores = await m.rerankPassages(QUERY, passages);
  assert.equal(scores.length, 150, \`one entry per passage: expected 150, got \${scores.length}\`);
  const failed = scores.slice(64, 128);
  assert(failed.every(s => s === null), \`the passages of the failed batch must come back unscored (null), got \${JSON.stringify([...new Set(failed)])}: a neutral score makes an outage read as mid-tier relevance\`);
  const kept = passages.flatMap((p, i) => ((i < 64 || i >= 128) && (scores[i] === null || Math.abs(scores[i] - model.score(QUERY, p)) > 1e-6) ? [i] : []));
  assert.equal(kept.length, 0, \`the healthy batches must keep their scores; passages \${JSON.stringify(kept.slice(0, 5))} lost theirs\`);
  assert.equal(batches.length, 3, \`three batches must be three calls, the model was called \${batches.length} times: a failed batch is not retried inside the 700 ms budget\`);
}

export async function check_malformed_terminal(ctx) {
  const {m, batches} = world(ctx);
  let result;
  let raised = false;
  try {
    result = await m.rerankPassages(QUERY, ['solar panel', '', 'wind panel']);
  } catch {
    raised = true;
  }
  assert(raised, \`a batch the model rejected as INVALID_ARGUMENT must end the call with an error, rerankPassages resolved \${JSON.stringify(result)}\`);
  assert.equal(batches.length, 1, \`INVALID_ARGUMENT is terminal: the model must be called once, it was called \${batches.length} times\`);
  assert.equal((await m.rerankPassages(QUERY, ['solar panel'])).length, 1, 'a well-formed request after the malformed one is served');
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"math"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"rerank/config"
	pb "rerank/gen/reranker_service"
	"rerank/model"

	"leetbuild/harness"
)

const clientQuery = "solar panel efficiency"

// clientPeer is the stand-in cross-encoder: scores from rerank/model, faults from model.BatchFault; records batch sizes.
type clientPeer struct {
	pb.UnimplementedRerankerServer
	batches []int
}

func (p *clientPeer) Score(_ context.Context, req *pb.ScoreRequest) (*pb.ScoreReply, error) {
	passages := req.GetPassages()
	p.batches = append(p.batches, len(passages))
	fault := model.BatchFault(passages)
	if fault == "unavailable" {
		return nil, status.Error(codes.Unavailable, "replica draining")
	}
	if fault == "invalid_argument" {
		return nil, status.Error(codes.InvalidArgument, "empty passage in batch")
	}
	scores := make([]float64, len(passages))
	for i, passage := range passages {
		scores[i] = model.Score(req.GetQuery(), passage)
	}
	return &pb.ScoreReply{Scores: scores, ModelVersion: model.Version}, nil
}

func clientWorld(ctx *harness.Ctx) *clientPeer {
	peer := &clientPeer{}
	pb.RegisterRerankerServer(ctx.GRPC.Server(config.Model), peer)
	return peer
}

func clientPassages(n int) []string {
	words := []string{"solar", "panel", "efficiency", "wind"}
	out := make([]string, n)
	for i := range out {
		out[i] = fmt.Sprintf("%s %s note %d", words[i%4], words[(i+1)%4], i)
	}
	return out
}

func clientRerank(ctx *harness.Ctx, passages []string) []*float64 {
	scores, err := rerankPassages(context.Background(), clientQuery, passages)
	ctx.NoError(err, "rerankPassages(%d passages)", len(passages))
	return scores
}

func clientWrong(scores []*float64, passages []string, indexes []int) []int {
	var wrong []int
	for _, i := range indexes {
		if scores[i] == nil || math.Abs(*scores[i]-model.Score(clientQuery, passages[i])) > 1e-6 {
			wrong = append(wrong, i)
		}
	}
	return wrong
}

func clientRange(from, to int) []int {
	out := []int{}
	for i := from; i < to; i++ {
		out = append(out, i)
	}
	return out
}

func CheckBatchSize(ctx *harness.Ctx) {
	peer := clientWorld(ctx)
	passages := clientPassages(150)
	scores := clientRerank(ctx, passages)
	ctx.Equal(peer.batches, []int{64, 64, 22}, "150 passages must be three calls of 64, 64 and 22; the batches the model saw")
	ctx.Equal(len(scores), 150, "one score per passage; the scores")
	wrong := clientWrong(scores, passages, clientRange(0, 150))
	ctx.Equal(len(wrong), 0, "the scores must be the model's, in passage order (passages %v are not); wrong scores", wrong)
}

func CheckBatchDeadline(ctx *harness.Ctx) {
	clientWorld(ctx)
	clientRerank(ctx, clientPassages(10))
	calls := ctx.GRPC.CallsTo("Score", "")
	ctx.Assert(len(calls) > 0 && calls[0].HasDeadline(), "the Score call carries no deadline: a slow replica holds the request as long as it likes")
	ctx.Assert(calls[0].Timeout.Seconds() >= 0.6 && calls[0].Timeout.Seconds() <= 0.75, "each call's deadline must be 700 ms, got %v", calls[0].Timeout)
	ctx.GRPC.SetLatency("Score", 1.0, config.Model)
	started := ctx.Clock.Now()
	scores := clientRerank(ctx, clientPassages(100))
	waited := float64(ctx.Clock.Now()-started) / 1000
	unscored := 0
	for _, s := range scores {
		if s == nil {
			unscored++
		}
	}
	ctx.Equal(unscored, 100, "a replica that takes 1 s per batch must leave both batches unscored at 700 ms; unscored passages")
	ctx.Equal(len(ctx.GRPC.CallsTo("Score", "")), 3, "two batches must be two calls; calls so far")
	ctx.Assert(waited <= 1.6, "two slow batches held the request %.1f s: each must be cut at 700 ms", waited)
}

func CheckUnscoredNotNeutral(ctx *harness.Ctx) {
	peer := clientWorld(ctx)
	passages := clientPassages(150)
	passages[70] = "brownout: solar panel" // the second batch lands on a replica that keeps failing
	scores := clientRerank(ctx, passages)
	ctx.Equal(len(scores), 150, "one entry per passage; the entries")
	scored := []float64{}
	for _, s := range scores[64:128] {
		if s != nil {
			scored = append(scored, *s)
		}
	}
	ctx.Equal(len(scored), 0, "the passages of the failed batch must come back unscored (nil), not as a score: a neutral score makes an outage read as mid-tier relevance; scored entries")
	kept := clientWrong(scores, passages, append(clientRange(0, 64), clientRange(128, 150)...))
	ctx.Equal(len(kept), 0, "the healthy batches must keep their scores (passages %v lost theirs); lost scores", kept)
	ctx.Equal(len(peer.batches), 3, "three batches must be three calls: a failed batch is not retried inside the 700 ms budget; the calls")
}

func CheckMalformedTerminal(ctx *harness.Ctx) {
	peer := clientWorld(ctx)
	scores, err := rerankPassages(context.Background(), clientQuery, []string{"solar panel", "", "wind panel"})
	ctx.Assert(err != nil, "a batch the model rejected as INVALID_ARGUMENT must end the call with an error, rerankPassages returned %d scores and no error", len(scores))
	ctx.Equal(len(peer.batches), 1, "INVALID_ARGUMENT is terminal: the model must be called once; the calls")
	ctx.Equal(len(clientRerank(ctx, []string{"solar panel"})), 1, "a well-formed request after the malformed one is served; its scores")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <cmath>
#include <exception>
#include <string>
#include <vector>

#include "rerank/config.h"
#include "rerank/model.h"

namespace {

const std::string kQuery = "solar panel efficiency";

// The stand-in cross-encoder: scores from rerank/model.h, faults from model::batch_fault; records batch sizes.
class RerankerPeer final : public rerankd::Reranker::Service {
 public:
  std::vector<int> batches;

  grpc::Status Score(grpc::ServerContext*, const rerankd::ScoreRequest* req, rerankd::ScoreReply* reply) override {
    const std::vector<std::string> passages(req->passages().begin(), req->passages().end());
    batches.push_back(static_cast<int>(passages.size()));
    const std::string fault = model::batch_fault(passages);
    if (fault == "unavailable") return grpc::Status(grpc::StatusCode::UNAVAILABLE, "replica draining");
    if (fault == "invalid_argument") return grpc::Status(grpc::StatusCode::INVALID_ARGUMENT, "empty passage in batch");
    for (const auto& p : passages) reply->add_scores(model::score(req->query(), p));
    reply->set_model_version(model::kVersion);
    return grpc::Status::OK;
  }
};

RerankerPeer& clientWorld(harness::Ctx& ctx) {
  static RerankerPeer* peer = nullptr;
  delete peer;
  peer = new RerankerPeer;
  ctx.GRPC.Server(config::kModel)->RegisterService(peer);
  return *peer;
}

std::vector<std::string> passagesOf(int n) {
  const std::vector<std::string> words = {"solar", "panel", "efficiency", "wind"};
  std::vector<std::string> out;
  for (int i = 0; i < n; i++) out.push_back(words[i % 4] + " " + words[(i + 1) % 4] + " note " + std::to_string(i));
  return out;
}

int wrongScores(const std::vector<std::optional<double>>& scores, const std::vector<std::string>& passages, size_t from, size_t to) {
  int wrong = 0;
  for (size_t i = from; i < to; i++) {
    if (!scores[i] || std::fabs(*scores[i] - model::score(kQuery, passages[i])) > 1e-6) wrong++;
  }
  return wrong;
}

}  // namespace

void CheckBatchSize(harness::Ctx& ctx) {
  auto& peer = clientWorld(ctx);
  const auto passages = passagesOf(150);
  const auto scores = rerankPassages(kQuery, passages);
  ctx.Equal(peer.batches, std::vector<int>{64, 64, 22}, "150 passages must be three calls of 64, 64 and 22; the batches the model saw");
  ctx.Equal(scores.size(), 150, "one score per passage; the scores");
  ctx.Equal(wrongScores(scores, passages, 0, 150), 0, "the scores must be the model's, in passage order; wrong scores");
}

void CheckBatchDeadline(harness::Ctx& ctx) {
  clientWorld(ctx);
  rerankPassages(kQuery, passagesOf(10));
  const auto calls = ctx.GRPC.CallsTo("Score");
  ctx.Assert(!calls.empty() && calls[0].HasDeadline(), "the Score call carries no deadline: a slow replica holds the request as long as it likes");
  ctx.Assert(calls[0].TimeoutSeconds() >= 0.6 && calls[0].TimeoutSeconds() <= 0.75, "each call's deadline must be 700 ms, got %vs", calls[0].TimeoutSeconds());
  ctx.GRPC.SetLatency("Score", 1.0, config::kModel);
  const int64_t started = ctx.Clock.Now();
  const auto scores = rerankPassages(kQuery, passagesOf(100));
  const double waited = static_cast<double>(ctx.Clock.Now() - started) / 1000;
  int unscored = 0;
  for (const auto& s : scores) unscored += s ? 0 : 1;
  ctx.Equal(unscored, 100, "a replica that takes 1 s per batch must leave both batches unscored at 700 ms; unscored passages");
  ctx.Equal(ctx.GRPC.CallsTo("Score").size(), 3, "two batches must be two calls; calls so far");
  ctx.Assert(waited <= 1.6, "two slow batches held the request %.1f s: each must be cut at 700 ms", waited);
}

void CheckUnscoredNotNeutral(harness::Ctx& ctx) {
  auto& peer = clientWorld(ctx);
  auto passages = passagesOf(150);
  passages[70] = "brownout: solar panel";  // the second batch lands on a replica that keeps failing
  const auto scores = rerankPassages(kQuery, passages);
  ctx.Equal(scores.size(), 150, "one entry per passage; the entries");
  int scored = 0;
  double sample = 0;
  for (size_t i = 64; i < 128 && i < scores.size(); i++) {
    if (scores[i]) {
      scored++;
      sample = *scores[i];
    }
  }
  ctx.Equal(scored, 0, "the passages of the failed batch must come back unscored (nullopt), not %v: a neutral score makes an outage read as mid-tier relevance; scored entries", sample);
  ctx.Equal(wrongScores(scores, passages, 0, 64) + wrongScores(scores, passages, 128, 150), 0, "the healthy batches must keep their scores; lost scores");
  ctx.Equal(peer.batches.size(), 3, "three batches must be three calls: a failed batch is not retried inside the 700 ms budget; the calls");
}

void CheckMalformedTerminal(harness::Ctx& ctx) {
  auto& peer = clientWorld(ctx);
  bool raised = false;
  size_t returned = 0;
  try {
    returned = rerankPassages(kQuery, {"solar panel", "", "wind panel"}).size();
  } catch (const std::exception&) {
    raised = true;
  }
  ctx.Assert(raised, "a batch the model rejected as INVALID_ARGUMENT must end the call with an exception, rerankPassages returned %d scores", returned);
  ctx.Equal(peer.batches.size(), 1, "INVALID_ARGUMENT is terminal: the model must be called once; the calls");
  ctx.Equal(rerankPassages(kQuery, {"solar panel"}).size(), 1, "a well-formed request after the malformed one is served; its scores");
}
`,
  },
  hints: [
    'During a brownout, low-value passages climb above scored ones: a whole stretch of the list reads 0.5. A slow replica makes a 150-passage request take seconds, and an empty passage is sent three times.',
    'A failed batch is retried whatever the status, then filled with `NEUTRAL_SCORE`, so "the model did not answer" becomes a mid-range score; the 5 s timeout and 128-passage batches let one call hold the request.',
    '`BATCH_SIZE = 64`, `timeout=BATCH_DEADLINE_S` (0.7) on one call per batch; on `INVALID_ARGUMENT` raise; on any other `RpcError` return `[None] * len(batch)` and go on to the next batch.',
  ],
  debrief: `The client sorts model failures into two kinds. A deadline or an unavailable replica is the world's fault and costs only those passages: they come back unscored, the endpoint keeps them in retrieval order, and the batches that answered keep their value. A malformed batch is the caller's fault, so it ends the request and no retry hides it. No retry inside the request is a budget decision: at 700 ms a batch, a second attempt doubles the latency of the request it was meant to save. Unscored is a type (an optional) rather than a number, because any number sorts. Production clients hedge a slow batch to a second replica after the median latency, and trip a circuit breaker so a dead replica stops costing 700 ms a batch.`,
};
