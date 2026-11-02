import type {Step} from '@/lib/types';

export const rerankClientStep: Step = {
  id: 'dependency',
  title: 'Reranker calls with a partial-results contract',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'reranker'],
  task: `## Task

**Starting point.** The starter's \`rerank_passages\` slices the candidates into batches of 128,
calls the reranker stub with a 5-second timeout, retries a deadline forever, and on any other gRPC
error pads the batch with \`NEUTRAL_SCORE\` and returns an empty list. It serves the happy path and
hides 5 flaws.

**Failure mode the checks target.** When the model degrades, the list does not look broken, it
looks reordered: a batch that timed out comes back as a row of 0.5s that outrank genuinely low
passages, a malformed batch spins in a hot loop, and one bad batch throws away every score the
request already paid for.

Requirements:

- Call the model in **batches of 64** with a **700 ms deadline per batch**.
- A batch that fails (deadline, unavailable, transport) yields **unscored** markers for exactly
  those passages, keeping the original retrieval order for them. No neutral-score constant: unscored
  is not a score.
- A **malformed** batch (\`INVALID_ARGUMENT\`) is terminal: it is a bug in the request or the model
  contract, so it is not retried and ends the call with an error.
- A failure in one batch must not abort the request; the remaining batches still run and return
  their scores.
- Model "no score" in the type: an optional per passage, not a magic value.`,
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
        "The batch size is `64`, so one call cannot exceed the model's comfortable sequence budget. The starter uses 128.",
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
        'Each batch call carries a `700` ms deadline so a slow batch cannot hold the request open. The starter waits five seconds.',
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
        'A malformed batch returns `INVALID_ARGUMENT` and ends the call; the code never loops forever retrying it. The starter retries until the batch happens to succeed.',
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
        'A failed batch is recorded and the loop moves on; the request is never aborted with an empty result. The starter throws away every score when one batch fails.',
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
                # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
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
        // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
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
			// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
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
            // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
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
      // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
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
    'During a model brownout, relevance dashboards stay green while users see mid-ranked passages that no one scored; one bad request pins a worker at 100% CPU, and other requests come back empty.',
    'The except branch treats every code the same: deadline retries without a budget, everything else pads with `NEUTRAL_SCORE` and then returns `[]`, discarding the batches that already succeeded.',
    'Set `BATCH_SIZE = 64`, a 700 ms deadline, make `INVALID_ARGUMENT` raise, append `None`/unscored for a failed batch and `continue` to the next one; delete `NEUTRAL_SCORE`.',
  ],
  debrief: `The fix changes the return type before it changes the control flow: once "unscored" is a value a
passage can carry, a neutral number has nowhere to hide and the caller can tell a failure from a low
score. Error codes are then sorted by meaning rather than caught together, because \`INVALID_ARGUMENT\`
says the request is wrong and a retry cannot help, while a deadline says try again inside the budget.
A batch failure is a slice, not the request, so the loop records markers and moves on; partial
results beat a blank page. A production client would also bound the total deadline across batches,
put a circuit breaker in front of a model that is failing every batch, and emit the unscored share
as a metric, which is the number the read step surfaces.`,
};
