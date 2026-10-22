import type {Step} from '@/lib/types';

export const rerankClientStep: Step = {
  id: 'dependency',
  title: 'Reranker calls with a partial-results contract',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'reranker'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it slices the candidates, calls
the reranker over gRPC and concatenates the scores. It serves the happy path and it hides three
production flaws. Review it like the service owner, fix it, and prove the fix with the checks below.

Call the reranker model over gRPC in **batches of 64** with a **700 ms deadline per batch**. The call
is allowed to fail without failing the request:

- A batch that fails (deadline, unavailable, transport) yields **unscored** markers for exactly those
  passages, and the original retrieval order is kept for them. Never substitute a neutral score:
  **unscored is not a score**, and a fake mid-tier number silently reorders the list.
- A **malformed** batch — \`INVALID_ARGUMENT\` — is terminal: it is a bug in the request or the model
  contract, not a transient failure, so it is never retried and it ends the call with an error.
- A failure in one batch must not abort the request. The remaining batches still run and return their
  scores, so a partial outage degrades one slice of the list instead of the whole response.
- The returned scores must model "no score" in the type: an optional per passage, not a magic value.

**Failure mode the checks target.** The draft retries every error forever inside \`while\`/\`for\`
until it succeeds, assigns \`NEUTRAL_SCORE\` to a failed batch so infra failures look like genuine
relevance and silently reorder results, and on a non-retryable error it returns an empty list — one
bad batch discards every good score the request had already paid for.`,
  sequence: {
    participants: ['Rerank API', 'Reranker model'],
    messages: [
      {from: 'Rerank API', to: 'Rerank API', label: 'slice candidates into batches of 64', kind: 'sync'},
      {from: 'Rerank API', to: 'Reranker model', label: 'Rerank(batch) · deadline 700 ms', kind: 'sync'},
      {from: 'Reranker model', to: 'Rerank API', label: 'scores', kind: 'reply'},
      {from: 'Reranker model', to: 'Rerank API', label: 'DEADLINE_EXCEEDED', kind: 'reply'},
      {from: 'Rerank API', to: 'Rerank API', label: 'mark batch unscored · keep retrieval order', kind: 'sync'},
      {from: 'Rerank API', to: 'Rerank API', label: 'run the remaining batches', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'batch-size',
      title: 'Calls the model in batches of 64',
      detail:
        "The batch size is `64`, so one call cannot exceed the model's comfortable sequence budget. The draft uses 128.",
      match: {
        python: {all: [/BATCH_SIZE\s*=\s*64/]},
        typescript: {all: [/BATCH_SIZE\s*=\s*64/]},
        go: {all: [/BATCH_SIZE\s*=\s*64/]},
        scala: {all: [/BatchSize\s*=\s*64/]},
        cpp: {all: [/BATCH_SIZE\s*=\s*64/]},
      },
    },
    {
      id: 'deadline',
      title: 'Sets a 700 ms deadline per batch',
      detail:
        'Each batch call carries a `700` ms deadline so a slow batch cannot hold the request open. The draft waits five seconds.',
      match: {
        python: {all: [/BATCH_DEADLINE_MS\s*=\s*700/]},
        typescript: {all: [/BATCH_DEADLINE_MS\s*=\s*700/]},
        go: {all: [/BATCH_DEADLINE_MS\s*=\s*700/]},
        scala: {all: [/BatchDeadlineMs\s*=\s*700/]},
        cpp: {all: [/BATCH_DEADLINE_MS\s*=\s*700/]},
      },
    },
    {
      id: 'unscored-not-neutral',
      title: 'Marks a failed batch unscored instead of scoring it',
      detail:
        'A failed batch yields `unscored` markers and there is no neutral-score constant, so an infrastructure failure cannot masquerade as relevance.',
      match: {
        python: {all: [/unscored/], none: [/NEUTRAL_SCORE/]},
        typescript: {all: [/unscored/], none: [/NEUTRAL_SCORE/]},
        go: {all: [/unscored/], none: [/NEUTRAL_SCORE/]},
        scala: {all: [/unscored/], none: [/NeutralScore/]},
        cpp: {all: [/unscored/], none: [/NEUTRAL_SCORE/]},
      },
    },
    {
      id: 'terminal-malformed',
      title: 'Treats INVALID_ARGUMENT as terminal',
      detail:
        'A malformed batch returns `INVALID_ARGUMENT` and ends the call; the code never loops forever retrying it. The draft retries until the batch happens to succeed.',
      match: {
        python: {all: [/INVALID_ARGUMENT/], none: [/while\s+True/]},
        typescript: {all: [/INVALID_ARGUMENT/], none: [/while\s*\(\s*true\s*\)/]},
        go: {all: [/codes\.InvalidArgument/], none: [/for\s*\{/]},
        scala: {all: [/INVALID_ARGUMENT/], none: [/while\s*\(/]},
        cpp: {all: [/INVALID_ARGUMENT/], none: [/while\s*\(\s*true\s*\)/]},
      },
    },
    {
      id: 'partial-results',
      title: 'Completes the remaining batches after a failure',
      detail:
        'A failed batch is recorded and the loop moves on; the request is never aborted with an empty result. The draft throws away every score when one batch fails.',
      match: {
        python: {all: [/BATCH_SIZE/], none: [/return\s+\[\]/]},
        typescript: {all: [/BATCH_SIZE/], none: [/return\s+\[\]/]},
        go: {all: [/BATCH_SIZE/], none: [/return\s+\[\]float64\{\},\s*nil/]},
        scala: {all: [/BatchSize/], none: [/return\s+Seq\.empty/]},
        cpp: {all: [/BATCH_SIZE/], none: [/return\s+std::vector<double>\{\}/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

BATCH_SIZE = 128
DEADLINE_SECONDS = 5
NEUTRAL_SCORE = 0.5


def rerank_passages(query, candidates, model_version, stub):
    scores = []
    for start in range(0, len(candidates), BATCH_SIZE):
        batch = candidates[start:start + BATCH_SIZE]
        while True:
            try:
                reply = stub.Rerank(
                    {"query": query, "passages": [c.text for c in batch], "model_version": model_version},
                    timeout=DEADLINE_SECONDS,
                )
                scores.extend(reply.scores)
                break
            except grpc.RpcError as exc:
                if exc.code() == grpc.StatusCode.DEADLINE_EXCEEDED:
                    continue
                # TODO: this draft retries every error forever, assigns a neutral score to failed
                # batches so unscored passages outrank real ones, and aborts the whole request when
                # one batch fails. Make a malformed batch terminal and mark failures unscored.
                scores.extend([NEUTRAL_SCORE for _ in batch])
                return []
    return scores
`,
      solution: `import grpc

BATCH_SIZE = 64
BATCH_DEADLINE_MS = 700


def rerank_passages(query, candidates, model_version, stub) -> list[float | None]:
    """Rerank in batches of 64; a failed batch is unscored, a malformed one is terminal."""
    scores: list[float | None] = []
    for start in range(0, len(candidates), BATCH_SIZE):
        batch = candidates[start:start + BATCH_SIZE]
        try:
            reply = stub.Rerank(
                {"query": query, "passages": [c.text for c in batch], "model_version": model_version},
                timeout=BATCH_DEADLINE_MS / 1000,
            )
            scores.extend(reply.scores)
        except grpc.RpcError as exc:
            if exc.code() == grpc.StatusCode.INVALID_ARGUMENT:
                raise
            unscored = [None for _ in batch]
            scores.extend(unscored)
    return scores
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';

const BATCH_SIZE = 128;
const DEADLINE_SECONDS = 5;
const NEUTRAL_SCORE = 0.5;

export async function rerankPassages(
  query: string,
  candidates: {passageId: string; text: string}[],
  modelVersion: string,
  client: grpc.Client,
): Promise<number[]> {
  const scores: number[] = [];
  for (let start = 0; start < candidates.length; start += BATCH_SIZE) {
    const batch = candidates.slice(start, start + BATCH_SIZE);
    while (true) {
      try {
        const reply = await callRerank(client, query, batch, modelVersion, DEADLINE_SECONDS);
        scores.push(...reply.scores);
        break;
      } catch (err) {
        if ((err as grpc.ServiceError).code === grpc.status.DEADLINE_EXCEEDED) continue;
        // TODO: this draft retries every error forever, assigns a neutral score to failed batches
        // so unscored passages outrank real ones, and aborts the whole request when one batch
        // fails. Make a malformed batch terminal and mark failures unscored.
        scores.push(...batch.map(() => NEUTRAL_SCORE));
        return [];
      }
    }
  }
  return scores;
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';

const BATCH_SIZE = 64;
const BATCH_DEADLINE_MS = 700;

export async function rerankPassages(
  query: string,
  candidates: {passageId: string; text: string}[],
  modelVersion: string,
  client: grpc.Client,
): Promise<(number | null)[]> {
  const scores: (number | null)[] = [];
  for (let start = 0; start < candidates.length; start += BATCH_SIZE) {
    const batch = candidates.slice(start, start + BATCH_SIZE);
    try {
      const reply = await callRerank(client, query, batch, modelVersion, BATCH_DEADLINE_MS);
      scores.push(...reply.scores);
    } catch (err) {
      if ((err as grpc.ServiceError).code === grpc.status.INVALID_ARGUMENT) throw err;
      const unscored: (number | null)[] = batch.map(() => null);
      scores.push(...unscored);
    }
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

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	BATCH_SIZE       = 128
	DEADLINE_SECONDS = 5
	NEUTRAL_SCORE    = 0.5
)

func rerankPassages(ctx context.Context, query string, candidates []Candidate, modelVersion string, client RerankerClient) ([]float64, error) {
	scores := make([]float64, 0, len(candidates))
	for start := 0; start < len(candidates); start += BATCH_SIZE {
		end := start + BATCH_SIZE
		if end > len(candidates) {
			end = len(candidates)
		}
		batch := candidates[start:end]
		for {
			callCtx, cancel := context.WithTimeout(ctx, time.Duration(DEADLINE_SECONDS)*time.Second)
			reply, err := callRerank(callCtx, client, query, batch, modelVersion)
			cancel()
			if err == nil {
				scores = append(scores, reply.Scores...)
				break
			}
			if status.Code(err) == codes.DeadlineExceeded {
				continue
			}
			// TODO: this draft retries every error forever, assigns a neutral score to failed
			// batches so unscored passages outrank real ones, and aborts the whole request when one
			// batch fails. Make a malformed batch terminal and mark failures unscored.
			for range batch {
				scores = append(scores, NEUTRAL_SCORE)
			}
			return []float64{}, nil
		}
	}
	return scores, nil
}
`,
      solution: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	BATCH_SIZE        = 64
	BATCH_DEADLINE_MS = 700
)

func rerankPassages(ctx context.Context, query string, candidates []Candidate, modelVersion string, client RerankerClient) ([]*float64, error) {
	scores := make([]*float64, 0, len(candidates))
	for start := 0; start < len(candidates); start += BATCH_SIZE {
		end := start + BATCH_SIZE
		if end > len(candidates) {
			end = len(candidates)
		}
		batch := candidates[start:end]
		callCtx, cancel := context.WithTimeout(ctx, time.Duration(BATCH_DEADLINE_MS)*time.Millisecond)
		reply, err := callRerank(callCtx, client, query, batch, modelVersion)
		cancel()
		if err != nil {
			if status.Code(err) == codes.InvalidArgument {
				return nil, err
			}
			unscored := make([]*float64, len(batch))
			scores = append(scores, unscored...)
			continue
		}
		for i := range reply.Scores {
			value := reply.Scores[i]
			scores = append(scores, &value)
		}
	}
	return scores, nil
}
`,
    },
    scala: {
      starter: `import scala.concurrent.Await

object RerankerClient {
  val BatchSize = 128
  val DeadlineSeconds = 5
  val NeutralScore = 0.5

  def rerankPassages(
      query: String,
      candidates: Seq[Candidate],
      modelVersion: String,
      stub: RerankStub,
  ): Seq[Double] = {
    val scores = scala.collection.mutable.ArrayBuffer.empty[Double]
    candidates.grouped(BatchSize).foreach { batch =>
      var done = false
      while (!done) {
        try {
          val reply = Await.result(stub.rerank(query, batch.map(_.text), modelVersion), DeadlineSeconds.seconds)
          scores ++= reply.scores
          done = true
        } catch {
          case _: DeadlineExceeded => ()
          case _: Throwable =>
            // TODO: this draft retries every error forever, assigns a neutral score to failed
            // batches so unscored passages outrank real ones, and aborts the whole request when one
            // batch fails. Make a malformed batch terminal and mark failures unscored.
            scores ++= batch.map(_ => NeutralScore)
            return Seq.empty
        }
      }
    }
    scores.toSeq
  }
}
`,
      solution: `import io.grpc.Status

import scala.concurrent.Await

object RerankerClient {
  val BatchSize = 64
  val BatchDeadlineMs = 700

  def rerankPassages(
      query: String,
      candidates: Seq[Candidate],
      modelVersion: String,
      stub: RerankStub,
  ): Seq[Option[Double]] = {
    val scores = scala.collection.mutable.ArrayBuffer.empty[Option[Double]]
    candidates.grouped(BatchSize).foreach { batch =>
      try {
        val reply = Await.result(stub.rerank(query, batch.map(_.text), modelVersion), BatchDeadlineMs.millis)
        scores ++= reply.scores.map(Some(_))
      } catch {
        case err: RerankException if err.status == Status.Code.INVALID_ARGUMENT => throw err
        case _: Throwable =>
          val unscored: Seq[Option[Double]] = batch.map(_ => None)
          scores ++= unscored
      }
    }
    scores.toSeq
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <algorithm>
#include <chrono>
#include <cstddef>
#include <string>
#include <vector>

constexpr std::size_t BATCH_SIZE = 128;
constexpr int DEADLINE_SECONDS = 5;
constexpr double NEUTRAL_SCORE = 0.5;

std::vector<double> rerankPassages(const std::string& query, const std::vector<Candidate>& candidates,
                                   const std::string& modelVersion, Reranker::Stub* stub) {
  std::vector<double> scores;
  for (std::size_t start = 0; start < candidates.size(); start += BATCH_SIZE) {
    std::vector<Candidate> batch(candidates.begin() + start,
                                 candidates.begin() + std::min(start + BATCH_SIZE, candidates.size()));
    while (true) {
      grpc::ClientContext ctx;
      ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(DEADLINE_SECONDS));
      RerankReply reply;
      const auto status = stub->Rerank(&ctx, buildRequest(query, batch, modelVersion), &reply);
      if (status.ok()) {
        for (double score : reply.scores()) scores.push_back(score);
        break;
      }
      if (status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED) continue;
      // TODO: this draft retries every error forever, assigns a neutral score to failed batches so
      // unscored passages outrank real ones, and aborts the whole request when one batch fails.
      // Make a malformed batch terminal and mark failures unscored.
      for (std::size_t i = 0; i < batch.size(); ++i) scores.push_back(NEUTRAL_SCORE);
      return std::vector<double>{};
    }
  }
  return scores;
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <algorithm>
#include <chrono>
#include <cstddef>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

constexpr std::size_t BATCH_SIZE = 64;
constexpr int BATCH_DEADLINE_MS = 700;

std::vector<std::optional<double>> rerankPassages(const std::string& query, const std::vector<Candidate>& candidates,
                                                  const std::string& modelVersion, Reranker::Stub* stub) {
  std::vector<std::optional<double>> scores;
  for (std::size_t start = 0; start < candidates.size(); start += BATCH_SIZE) {
    std::vector<Candidate> batch(candidates.begin() + start,
                                 candidates.begin() + std::min(start + BATCH_SIZE, candidates.size()));
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(BATCH_DEADLINE_MS));
    RerankReply reply;
    const auto status = stub->Rerank(&ctx, buildRequest(query, batch, modelVersion), &reply);
    if (!status.ok()) {
      if (status.error_code() == grpc::StatusCode::INVALID_ARGUMENT) {
        throw std::runtime_error(status.error_message());
      }
      const std::vector<std::optional<double>> unscored(batch.size(), std::nullopt);
      scores.insert(scores.end(), unscored.begin(), unscored.end());
      continue;
    }
    for (double score : reply.scores()) scores.emplace_back(score);
  }
  return scores;
}
`,
    },
  },
  hints: [
    'Model the missing score in the type first: an optional per passage. Once "unscored" is a value, a neutral number has nowhere to hide and the caller can tell a failure from a low score.',
    'Sort the error codes by what they mean. `INVALID_ARGUMENT` says the request is wrong and retrying will never fix it; deadline and unavailable say try again, but only inside the deadline budget.',
    'A batch failure is a slice, not the request. Catch it, record unscored markers for that batch, `continue` to the next one, and return the mixed list — partial results beat a blank page.',
  ],
  debrief: `The interviewer is testing whether you can keep a partial failure from becoming a silent quality change.
The draft reads fine because the demo's model never fails. Three defects are being checked: a
neutral score standing in for a failure (so a down model looks like mid-tier relevance), an unbounded
retry around a malformed batch (so a bad request becomes a hot loop), and an abort that discards the
scores already computed (so one bad batch costs the whole response). The optional score type is the
part candidates skip: if "unscored" is expressible, it cannot be confused with a number. Real systems
add a per-batch budget so the total deadline is bounded, a circuit breaker so a failing model is not
hammered batch after batch, and a metric for the unscored share — the number the next step surfaces.`,
};
