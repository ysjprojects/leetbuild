import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Model calls per shard with a partial-failure policy',
  concept: 'grpc',
  file: 'client',
  focus: ['worker', 'model'],
  task: `## Task

**Starting point.** The starter implements \`generate\`, which calls \`model.Generate(shard_id)\` in a
\`while True\` loop with no deadline, calls \`cancel_all()\` on any exception and tries again; and
\`run_batch\`, which maps \`generate\` over the shards and returns \`status: "succeeded"\`. A healthy
model server makes the demo pass. It hides 5 flaws.

**Failure mode the checks target.** One hung or poisoned shard taking the batch down: a call with no
deadline pins the worker, an unbounded retry on a timeout hammers a provider that is already slow, a
shared abort turns one bad record into a failed batch, and the result reports success for a batch that
dropped a shard.

- **One deadline per attempt: 5 seconds.** A call that does not return is abandoned, not waited on.
- **Retry at most twice, and only \`UNAVAILABLE\`.** The retryable set contains exactly
  \`UNAVAILABLE\`; \`DEADLINE_EXCEEDED\` is not retried.
- **Contain the failure to its own shard.** A shard that still fails after the retries is recorded
  as failed and the batch continues; the other in-flight shards are not cancelled.
- **Report the failed count.** The batch result carries the completed and \`failed_shards\` counts so
  the status endpoint and the events can report the real state.

:::widget deadline-retry {"base": 200, "deadline": 5000, "attempts": 3}`,
  sequence: {
    participants: ['Worker pool', 'Model server', 'store'],
    messages: [
      {from: 'Worker pool', to: 'Model server', label: 'Generate(shard) · deadline 5 s', kind: 'sync'},
      {from: 'Model server', to: 'Worker pool', label: 'UNAVAILABLE', kind: 'reply'},
      {from: 'Worker pool', to: 'Model server', label: 'retry 1 and 2 · only on UNAVAILABLE', kind: 'sync'},
      {from: 'Model server', to: 'Worker pool', label: 'ShardReply{output}', kind: 'reply'},
      {from: 'Worker pool', to: 'store', label: 'mark this shard failed · siblings keep running', kind: 'async'},
    ],
  },
  hints: [
    'A provider brownout and one worker pegs a CPU retrying the same shard for an hour; one malformed record and the operator sees every sibling shard cancelled with the batch still marked succeeded.',
    'No timeout on the call, `while True` with a bare `except Exception` that retries every status, `cancel_all()` on each failure, and `run_batch` hard-codes the status string.',
    'Call with `timeout=DEADLINE_S`, loop `for _ in range(MAX_ATTEMPTS)`, break unless `error.code() in RETRYABLE`; per shard catch, append to `failed`, continue; return `failed_shards` in the summary.',
  ],
  checks: [
    {
      id: 'deadline',
      title: 'Every attempt carries a 5-second deadline',
      detail:
        'Each model call is made under a **5-second** deadline. The starter has no deadline, so a hung provider blocks the worker.',
      match: {
        python: {all: [/DEADLINE_S/, /timeout=DEADLINE_S/]},
        typescript: {all: [/DEADLINE_MS/, /deadline:/]},
        go: {all: [/deadlineSeconds|DeadlineSeconds/, /context\.WithTimeout/]},
        scala: {all: [/DeadlineSeconds/, /withDeadlineAfter/]},
        cpp: {all: [/kDeadlineMs/, /set_deadline/]},
      },
    },
    {
      id: 'retry-unavailable',
      title: 'Retries only on UNAVAILABLE',
      detail:
        'The retryable set is exactly `UNAVAILABLE`; a timeout is not retried. The starter retries every error, including `DEADLINE_EXCEEDED`, forever.',
      match: {
        python: {all: [/UNAVAILABLE/, /RETRYABLE/], none: [/DEADLINE_EXCEEDED/]},
        typescript: {all: [/UNAVAILABLE/, /RETRYABLE/], none: [/DEADLINE_EXCEEDED/]},
        go: {all: [/codes\.Unavailable/, /retryable/], none: [/codes\.DeadlineExceeded/]},
        scala: {all: [/UNAVAILABLE/, /Retryable/], none: [/DEADLINE_EXCEEDED/]},
        cpp: {all: [/UNAVAILABLE/, /retryable/], none: [/DEADLINE_EXCEEDED/]},
      },
    },
    {
      id: 'bounded-attempts',
      title: 'At most two retries',
      detail:
        'The attempt loop is bounded by `MAX_ATTEMPTS` (initial call plus two retries). The starter loops `while true`, so a permanent failure never returns.',
      match: {
        python: {all: [/MAX_ATTEMPTS/, /range\(MAX_ATTEMPTS\)/]},
        typescript: {all: [/MAX_ATTEMPTS/, /attempt\s*<\s*MAX_ATTEMPTS/]},
        go: {all: [/maxAttempts/, /for attempt :=/]},
        scala: {all: [/MaxAttempts/, /1 to MaxAttempts/]},
        cpp: {all: [/kMaxAttempts/, /for\s*\(int attempt/]},
      },
    },
    {
      id: 'contained-failure',
      title: 'A shard failure is contained to its own shard',
      detail:
        'A failed shard is caught and recorded per shard; it never cancels the other in-flight shards. The starter calls a batch-wide cancel from the catch block.',
      match: {
        python: {all: [/except grpc\.RpcError/, /failed/], none: [/cancel_all/]},
        typescript: {all: [/catch\s*\(/, /failed/], none: [/cancelAll/]},
        go: {all: [/if err != nil/, /Failed/], none: [/CancelAll/]},
        scala: {all: [/StatusRuntimeException/, /failed/], none: [/cancelAll/]},
        cpp: {all: [/catch\s*\(/, /failed/], none: [/cancelAll|cancel_all/]},
      },
    },
    {
      id: 'failed-count',
      title: 'The batch reports an explicit failed-shard count',
      detail:
        'The batch result carries the failed shards instead of a blanket success. The starter returns `succeeded` even when a shard was dropped.',
      match: {
        python: {all: [/failed_shards|failed_count/, /return/]},
        typescript: {all: [/failedShards|failedCount/, /return/]},
        go: {all: [/FailedShards|FailedCount/, /return/]},
        scala: {all: [/failedShards|FailedShards/, /Map\(|return/]},
        cpp: {all: [/failed_shards|failedShards/, /return|summary/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

attempts = 0


def generate(shard_id: str) -> str:
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    global attempts
    while True:
        attempts += 1
        try:
            return model.Generate(shard_id)
        except Exception:
            cancel_all()
            continue


def run_batch(batch_id: str, shards: list[str]) -> dict:
    outputs = [generate(shard_id) for shard_id in shards]
    return {"batch_id": batch_id, "status": "succeeded", "outputs": outputs}
`,
      solution: `import time

import grpc

DEADLINE_S = 5
MAX_ATTEMPTS = 3
RETRYABLE = {grpc.StatusCode.UNAVAILABLE}


def generate(shard_id: str) -> str:
    last_error: grpc.RpcError | None = None
    for attempt in range(MAX_ATTEMPTS):
        try:
            return model.Generate(shard_id, timeout=DEADLINE_S).output
        except grpc.RpcError as exc:
            last_error = exc
            if exc.code() not in RETRYABLE:
                break
            time.sleep(0.2 * (2**attempt))
    raise last_error or RuntimeError("shard failed")


def run_batch(batch_id: str, shards: list[str]) -> dict:
    failed: list[str] = []
    for shard_id in shards:
        try:
            store.put_output(batch_id, shard_id, generate(shard_id))
        except grpc.RpcError:
            failed.append(shard_id)
    return {
        "batch_id": batch_id,
        "completed": len(shards) - len(failed),
        "failed_shards": failed,
    }
`,
    },
    typescript: {
      starter: `/** Per-shard model call. */
import * as grpc from '@grpc/grpc-js';

export async function generate(shardID: string): Promise<string> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  for (;;) {
    try {
      return await callModel(shardID);
    } catch (error) {
      cancelAll();
    }
  }
}

export async function runBatch(batchID: string, shards: string[]): Promise<Record<string, unknown>> {
  const outputs: string[] = [];
  for (const shardID of shards) outputs.push(await generate(shardID));
  return {batch_id: batchID, status: 'succeeded', outputs};
}
`,
      solution: `/** Per-shard model call: a 5 s deadline, two UNAVAILABLE retries, a contained failure. */
import * as grpc from '@grpc/grpc-js';

const DEADLINE_MS = 5_000;
const MAX_ATTEMPTS = 3;
const RETRYABLE: Record<number, true> = {[grpc.status.UNAVAILABLE]: true};

export async function generate(shardID: string): Promise<string> {
  let lastError: grpc.ServiceError | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await new Promise<string>((resolve, reject) => {
        model.Generate(
          {shard_id: shardID},
          new grpc.Metadata(),
          {deadline: Date.now() + DEADLINE_MS},
          (error: grpc.ServiceError | null, reply: {output: string}) => {
            if (error) reject(error);
            else resolve(reply.output);
          },
        );
      });
    } catch (error) {
      const serviceError = error as grpc.ServiceError;
      lastError = serviceError;
      if (RETRYABLE[serviceError.code] !== true) break;
    }
  }
  throw lastError ?? new Error('shard failed');
}

export async function runBatch(batchID: string, shards: string[]): Promise<Record<string, unknown>> {
  const failed: string[] = [];
  for (const shardID of shards) {
    try {
      await store.putOutput(batchID, shardID, await generate(shardID));
    } catch (error) {
      failed.push(shardID);
    }
  }
  return {batch_id: batchID, completed: shards.length - failed.length, failedShards: failed};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"google.golang.org/grpc"
)

func Generate(client ModelClient, shardID string) (string, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	for {
		reply, err := client.Generate(context.Background(), &ShardRequest{ShardId: shardID})
		if err == nil {
			return reply.Output, nil
		}
		cancelAll()
	}
}

func RunBatch(client ModelClient, batchID string, shards []string) map[string]any {
	outputs := []string{}
	for _, shardID := range shards {
		out, _ := Generate(client, shardID)
		outputs = append(outputs, out)
	}
	return map[string]any{"batch_id": batchID, "status": "succeeded", "outputs": outputs}
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
	deadlineSeconds = 5
	maxAttempts     = 3
)

var retryable = map[codes.Code]bool{codes.Unavailable: true}

func Generate(client ModelClient, shardID string) (string, error) {
	var lastErr error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(context.Background(), deadlineSeconds*time.Second)
		reply, err := client.Generate(callCtx, &ShardRequest{ShardId: shardID})
		cancel()
		if err == nil {
			return reply.Output, nil
		}
		lastErr = err
		if !retryable[status.Code(err)] {
			break
		}
	}
	return "", lastErr
}

func RunBatch(client ModelClient, batchID string, shards []string) map[string]any {
	failed := []string{}
	for _, shardID := range shards {
		output, err := Generate(client, shardID)
		if err != nil {
			failed = append(failed, shardID)
			continue
		}
		_ = store.PutOutput(context.Background(), batchID, shardID, output)
	}
	return map[string]any{
		"batch_id":     batchID,
		"completed":    len(shards) - len(failed),
		"FailedShards": failed,
	}
}
`,
    },
    scala: {
      starter: `import io.grpc.StatusRuntimeException

object ShardRunner {
  def generate(stub: ModelGrpc.ModelBlockingStub, shardId: String): String = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    var done = false
    var output = ""
    while (!done) {
      try {
        output = stub.generate(ShardRequest(shardId)).output
        done = true
      } catch {
        case _: StatusRuntimeException => cancelAll()
      }
    }
    output
  }

  def runBatch(stub: ModelGrpc.ModelBlockingStub, batchId: String, shards: Seq[String]): Map[String, Any] = {
    val outputs = shards.map(shardId => generate(stub, shardId))
    Map("batch_id" -> batchId, "status" -> "succeeded", "outputs" -> outputs)
  }
}
`,
      solution: `import io.grpc.Status
import io.grpc.StatusRuntimeException

import java.util.concurrent.TimeUnit

object ShardRunner {
  val DeadlineSeconds = 5
  val MaxAttempts = 3
  val Retryable: Set[Status.Code] = Set(Status.Code.UNAVAILABLE)

  def generate(stub: ModelGrpc.ModelBlockingStub, shardId: String): String = {
    var lastError: StatusRuntimeException = null
    for (attempt <- 1 to MaxAttempts) {
      try {
        val call = stub.withDeadlineAfter(DeadlineSeconds, TimeUnit.SECONDS)
        return call.generate(ShardRequest(shardId)).output
      } catch {
        case e: StatusRuntimeException =>
          lastError = e
          if (!Retryable.contains(e.getStatus.getCode)) throw e
      }
    }
    throw lastError
  }

  def runBatch(stub: ModelGrpc.ModelBlockingStub, batchId: String, shards: Seq[String]): Map[String, Any] = {
    val failed = scala.collection.mutable.ArrayBuffer.empty[String]
    shards.foreach { shardId =>
      try {
        store.putOutput(batchId, shardId, generate(stub, shardId))
      } catch {
        case _: StatusRuntimeException => failed += shardId
      }
    }
    Map(
      "batch_id" -> batchId,
      "completed" -> (shards.size - failed.size),
      "failedShards" -> failed.toList,
    )
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <string>
#include <vector>

std::string generate(Model::Stub& stub, const std::string& shardId) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  bool done = false;
  std::string output;
  while (!done) {
    grpc::ClientContext ctx;
    ShardRequest request;
    request.set_shard_id(shardId);
    ShardReply reply;
    const auto status = stub.Generate(&ctx, request, &reply);
    if (status.ok()) {
      output = reply.output();
      done = true;
    } else {
      cancelAll();
    }
  }
  return output;
}

json run_batch(Model::Stub& stub, const std::string& batchId, const std::vector<std::string>& shards) {
  std::vector<std::string> outputs;
  for (const auto& shardId : shards) {
    outputs.push_back(generate(stub, shardId));
  }
  return json{{"batch_id", batchId}, {"status", "succeeded"}, {"outputs", outputs}};
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <stdexcept>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr int kDeadlineMs = 5000;
constexpr int kMaxAttempts = 3;

bool is_retryable(const grpc::Status& status) {
  return status.error_code() == grpc::StatusCode::UNAVAILABLE;
}

std::string generate(Model::Stub& stub, const std::string& shardId) {
  grpc::Status last;
  for (int attempt = 0; attempt < kMaxAttempts; ++attempt) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kDeadlineMs));
    ShardRequest request;
    request.set_shard_id(shardId);
    ShardReply reply;
    const auto status = stub.Generate(&ctx, request, &reply);
    if (status.ok()) return reply.output();
    last = status;
    if (!is_retryable(status)) break;
  }
  throw std::runtime_error(last.error_message());
}

json run_batch(Model::Stub& stub, const std::string& batchId, const std::vector<std::string>& shards) {
  std::vector<std::string> failed;
  for (const auto& shardId : shards) {
    try {
      store.put_output(batchId, shardId, generate(stub, shardId));
    } catch (const std::exception&) {
      failed.push_back(shardId);
    }
  }
  return json{
      {"batch_id", batchId},
      {"completed", shards.size() - failed.size()},
      {"failed_shards", failed},
  };
}
`,
    },
  },
  debrief: `The fix bounds the call in time and in scope. A deadline bounds one attempt; a fixed attempt count
bounds the call; the retryable set decides which failures deserve another try, and a timeout is not
one of them because retrying a deadline turns a slow provider into a hot loop. Containment is why the
failure is caught per shard: a poisoned record is data, so it goes into \`failed\` and the loop
continues, where a batch-wide cancel lets one record fail a million. The summary has to carry
\`failed_shards\` or the status endpoint has nothing to report but a blanket success.

What this step did not do: jittered backoff between the two retries, a per-endpoint concurrency
limit so a thousand workers retrying at once do not finish the provider off, and a request id on each
attempt so a retried shard is not billed twice.`,
};
