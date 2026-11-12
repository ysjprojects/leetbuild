import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Model calls per record: a deadline, bounded retries, a pinned version',
  concept: 'grpc',
  guides: ['deadlines-and-retries', 'model-output'],
  file: 'client',
  focus: ['worker', 'model'],
  task: `## Task

**Starting point.** The starter's \`run_shard(batch_id, model, shard_id, records)\` calls \`Model.Infer\`
(\`batch_inference.proto\`, a stand-in served at \`batch/config\`'s \`MODEL_SERVER\`) once per record with
\`{batch_id, record_id, input}\`, retrying any error after a short sleep until the record's 30-second wall
clock runs out; then it abandons the shard and reports every record failed. It returns the provided
\`ShardResult\` with each \`Output\` and the counts. Against a healthy model server it answers. It hides 5
flaws.

**Failure mode the checks target.** One record should cost one record. A call with no deadline holds
the worker for as long as the model server hangs; retrying a record the model cannot parse burns 30
seconds of calls and then throws away the shard's good outputs, so a single poisoned line reruns a
thousand records; and a request that names no model is answered by whatever version is latest, so a
rollout in the middle of a batch mixes two models in one output.

\`\`\`proto
service Model { rpc Infer(InferRequest) returns (InferReply); }
message InferRequest { string batch_id = 1; string record_id = 2; string model = 3; string input = 4; }
message InferReply   { string output = 1; string model = 2; }
\`\`\`

Requirements:

- Every attempt carries a **5-second deadline** (\`DEADLINE_S\`); \`DEADLINE_EXCEEDED\` fails the record
  with reason \`deadline\`, not retried.
- Only \`UNAVAILABLE\` is retried, at most **twice** (\`MAX_ATTEMPTS\` = 3) with a backoff; a third
  failure is reason \`unavailable\`. Any other status fails the record after one call (\`invalid_argument\`, …).
- A failed record is one \`RecordError\` and \`failed\` +1; the shard goes on.
- Every request carries the batch's \`model\`.`,
  sequence: {
    participants: ['Worker', 'Model server'],
    messages: [
      {from: 'Worker', to: 'Model server', label: 'Infer r0 · model sum-v7 · deadline 5 s', kind: 'sync'},
      {from: 'Model server', to: 'Worker', label: 'UNAVAILABLE', kind: 'reply'},
      {from: 'Worker', to: 'Model server', label: 'Infer r0 · attempt 2 after backoff', kind: 'sync'},
      {from: 'Model server', to: 'Worker', label: '{output, model: sum-v7}', kind: 'reply'},
      {from: 'Worker', to: 'Model server', label: 'Infer r1 (poison)', kind: 'sync'},
      {from: 'Model server', to: 'Worker', label: 'INVALID_ARGUMENT → RecordError, go on', kind: 'reply'},
    ],
  },
  hints: [
    'Symptom: a hung model server parks a worker for its whole hang, one unparseable record turns into a shard with zero outputs after 30 seconds of calls, and a batch submitted for `sum-v7` comes back answered by `sum-v8`.',
    'Mechanism: the call carries no deadline; the loop treats every status as worth retrying and is bounded by the clock, not by attempts; on giving up it returns a fresh all-failed result; and the request leaves `model` empty.',
    "Change: `timeout=DEADLINE_S` (or the stack's deadline) on each call; retry only `UNAVAILABLE` while `attempt < MAX_ATTEMPTS`, sleeping a backoff; any other code appends one `RecordError` and moves to the next record; set `model=model` on the request.",
  ],
  checks: [
    {
      id: 'attempt-deadline',
      title: 'Five-second deadline on every attempt',
      detail:
        'Each Infer call carries a deadline of about 5 s (DEADLINE_S as timeout=, deadline: Date.now() + DEADLINE_MS, context.WithTimeout, withDeadlineAfter, set_deadline); a model that answers in 4 s is accepted. The starter sends no deadline.',
      match: {
        python: {all: [/timeout\s*=\s*DEADLINE_S/]},
        typescript: {all: [/deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/]},
        go: {all: [/context\.WithTimeout\(/]},
        scala: {all: [/withDeadlineAfter\(/]},
        cpp: {all: [/set_deadline\(/]},
      },
    },
    {
      id: 'retry-unavailable',
      title: 'Retries only UNAVAILABLE, at most twice',
      detail:
        'One UNAVAILABLE earns a retry after a backoff and the record is answered on the second call; a server that stays UNAVAILABLE gets three calls, then the record fails with reason unavailable. The starter retries anything until its 30-second wall clock runs out.',
      match: {
        python: {all: [/grpc\.StatusCode\.UNAVAILABLE/, /MAX_ATTEMPTS/], none: [/MAX_RECORD_SECONDS/]},
        typescript: {all: [/status\.UNAVAILABLE/, /MAX_ATTEMPTS/], none: [/MAX_RECORD_SECONDS/]},
        go: {all: [/codes\.Unavailable/, /maxAttempts/], none: [/maxRecordSeconds/]},
        scala: {all: [/Status\.Code\.UNAVAILABLE/, /MaxAttempts/], none: [/MaxRecordSeconds/]},
        cpp: {all: [/grpc::StatusCode::UNAVAILABLE/, /kMaxAttempts/], none: [/kMaxRecordSeconds/]},
      },
    },
    {
      id: 'hung-call-cut',
      title: 'Cuts a hung call at the deadline',
      detail:
        'A model server that takes 8 s comes back DEADLINE_EXCEEDED after about 5 s; the record fails with reason deadline after one call. The starter waits the whole hang out.',
      match: {
        python: {all: [/grpc\.StatusCode\.DEADLINE_EXCEEDED/, /["']deadline["']/]},
        typescript: {all: [/status\.DEADLINE_EXCEEDED/, /['"]deadline['"]/]},
        go: {all: [/codes\.DeadlineExceeded/, /"deadline"/]},
        scala: {all: [/Status\.Code\.DEADLINE_EXCEEDED/, /"deadline"/]},
        cpp: {all: [/grpc::StatusCode::DEADLINE_EXCEEDED/, /"deadline"/]},
      },
    },
    {
      id: 'poison-contained',
      title: 'Contains a poisoned record to its own line',
      detail:
        'In a shard of four records where the second is one the model cannot parse (INVALID_ARGUMENT), that record is called once and fails with reason invalid_argument, and the other three are answered: completed 3, failed 1. The starter retries the poison for 30 s, then reports the whole shard failed.',
      match: {
        python: {all: [/\.failed\s*\+=\s*1/], none: [/["']abandoned["']/]},
        typescript: {all: [/\.failed\s*(\+=\s*1|\+\+)/], none: [/['"]abandoned['"]/]},
        go: {all: [/\.Failed\+\+|\.Failed\s*\+=\s*1/], none: [/"abandoned"/]},
        scala: {all: [/failed\s*\+=\s*1/], none: [/"abandoned"/]},
        cpp: {all: [/\.failed\+\+|\+\+\w+\.failed|\.failed\s*\+=\s*1/], none: [/"abandoned"/]},
      },
    },
    {
      id: 'pinned-model',
      title: "Pins the batch's model on every request",
      detail:
        "A batch submitted for sum-v7 is answered by sum-v7 on every record while the server's latest is sum-v8; each Output carries the version that answered. The starter's requests name no model, so the latest answers.",
      match: {
        python: {all: [/InferRequest\([^)]*\bmodel\s*=\s*model\b/]},
        typescript: {all: [/stub\.Infer\(\s*\{[^}]*\bmodel\b/]},
        go: {all: [/pb\.InferRequest\{[^}]*Model:\s*model\b/]},
        scala: {all: [/InferRequest\([^)]*\bmodel\s*=\s*model\b/]},
        cpp: {all: [/set_model\(\s*model\s*\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
import time

import grpc

import batch_inference_pb2
import batch_inference_pb2_grpc
from batch.config import MODEL_SERVER
from batch.records import Output, Record, RecordError, ShardResult

logger = logging.getLogger("batch.worker")

MAX_RECORD_SECONDS = 30
BACKOFF_S = 0.5

channel = grpc.insecure_channel(MODEL_SERVER)
stub = batch_inference_pb2_grpc.ModelStub(channel)


def run_shard(batch_id: str, model: str, shard_id: int, records: list[Record]) -> ShardResult:
    """Run the model over one shard's records: every output, every failed record, and the counts."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    logger.info("shard %s/%d: %d records on %s", batch_id, shard_id, len(records), model)
    result = ShardResult(batch_id=batch_id, shard_id=shard_id, model=model)
    for record in records:
        until = time.monotonic() + MAX_RECORD_SECONDS
        while True:
            try:
                reply = stub.Infer(batch_inference_pb2.InferRequest(batch_id=batch_id, record_id=record.record_id, input=record.input))
                break
            except grpc.RpcError as err:
                if time.monotonic() >= until:
                    logger.error("record %s failed with %s: giving up on shard %d", record.record_id, err.code(), shard_id)
                    errors = [RecordError(r.record_id, "abandoned") for r in records]
                    return ShardResult(batch_id=batch_id, shard_id=shard_id, model=model, failed=len(records), errors=errors)
                time.sleep(BACKOFF_S)
        result.outputs.append(Output(record.record_id, reply.output, reply.model))
        result.completed += 1
    return result
`,
      solution: `import logging
import time

import grpc

import batch_inference_pb2
import batch_inference_pb2_grpc
from batch.config import MODEL_SERVER
from batch.records import Output, Record, RecordError, ShardResult

logger = logging.getLogger("batch.worker")

DEADLINE_S = 5.0
MAX_ATTEMPTS = 3
BACKOFF_S = 0.5

channel = grpc.insecure_channel(MODEL_SERVER)
stub = batch_inference_pb2_grpc.ModelStub(channel)


def infer(batch_id: str, model: str, record: Record) -> Output | RecordError:
    """One record: a deadline per attempt, UNAVAILABLE retried at most twice, anything else final."""
    attempt = 1
    while True:
        try:
            reply = stub.Infer(
                batch_inference_pb2.InferRequest(batch_id=batch_id, record_id=record.record_id, model=model, input=record.input),
                timeout=DEADLINE_S,
            )
            return Output(record.record_id, reply.output, reply.model)
        except grpc.RpcError as err:
            code = err.code()
            if code == grpc.StatusCode.UNAVAILABLE and attempt < MAX_ATTEMPTS:
                time.sleep(BACKOFF_S * attempt)
                attempt += 1
                continue
            if code == grpc.StatusCode.DEADLINE_EXCEEDED:
                return RecordError(record.record_id, "deadline")
            return RecordError(record.record_id, code.name.lower())


def run_shard(batch_id: str, model: str, shard_id: int, records: list[Record]) -> ShardResult:
    """Run the model over one shard's records: every output, every failed record, and the counts."""
    logger.info("shard %s/%d: %d records on %s", batch_id, shard_id, len(records), model)
    result = ShardResult(batch_id=batch_id, shard_id=shard_id, model=model)
    for record in records:
        outcome = infer(batch_id, model, record)
        if isinstance(outcome, Output):
            result.outputs.append(outcome)
            result.completed += 1
        else:
            logger.warning("record %s failed: %s", record.record_id, outcome.reason)
            result.errors.append(outcome)
            result.failed += 1
    return result
`,
    },
    typescript: {
      starter: `import {setTimeout as sleep} from 'node:timers/promises';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {MODEL_SERVER} from 'batch/config';
import type {Record as InputRecord, RecordError, ShardResult} from 'batch/records';

export const MAX_RECORD_SECONDS = 30;
export const BACKOFF_MS = 500;

interface InferRequest {
  batch_id: string;
  record_id: string;
  model?: string;
  input: string;
}
interface InferReply {
  output: string;
  model: string;
}
interface ModelClient {
  Infer(request: InferRequest, options?: {deadline: number}): Promise<InferReply>;
}

const {batch} = grpc.loadPackageDefinition(protoLoader.loadSync('batch_inference.proto')) as unknown as {
  batch: {Model: new (target: string, credentials: grpc.ChannelCredentials) => ModelClient};
};
const stub = new batch.Model(MODEL_SERVER, grpc.credentials.createInsecure());

/** Run the model over one shard's records: every output, every failed record, and the counts. */
export async function runShard(batchId: string, model: string, shardId: number, records: InputRecord[]): Promise<ShardResult> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  console.log(\`shard \${batchId}/\${shardId}: \${records.length} records on \${model}\`);
  const result: ShardResult = {batch_id: batchId, shard_id: shardId, model, completed: 0, failed: 0, outputs: [], errors: []};
  for (const record of records) {
    const until = Date.now() + MAX_RECORD_SECONDS * 1000;
    let reply: InferReply;
    for (;;) {
      try {
        reply = await stub.Infer({batch_id: batchId, record_id: record.record_id, input: record.input});
        break;
      } catch (err) {
        if (Date.now() >= until) {
          console.error(\`record \${record.record_id} failed with \${(err as grpc.ServiceError).code}: giving up on shard \${shardId}\`);
          const errors: RecordError[] = records.map(r => ({record_id: r.record_id, reason: 'abandoned'}));
          return {batch_id: batchId, shard_id: shardId, model, completed: 0, failed: records.length, outputs: [], errors};
        }
        await sleep(BACKOFF_MS);
      }
    }
    result.outputs.push({record_id: record.record_id, output: reply.output, model: reply.model});
    result.completed += 1;
  }
  return result;
}
`,
      solution: `import {setTimeout as sleep} from 'node:timers/promises';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {MODEL_SERVER} from 'batch/config';
import type {Record as InputRecord, Output, RecordError, ShardResult} from 'batch/records';

export const DEADLINE_MS = 5_000;
export const MAX_ATTEMPTS = 3;
export const BACKOFF_MS = 500;

interface InferRequest {
  batch_id: string;
  record_id: string;
  model?: string;
  input: string;
}
interface InferReply {
  output: string;
  model: string;
}
interface ModelClient {
  Infer(request: InferRequest, options?: {deadline: number}): Promise<InferReply>;
}

const {batch} = grpc.loadPackageDefinition(protoLoader.loadSync('batch_inference.proto')) as unknown as {
  batch: {Model: new (target: string, credentials: grpc.ChannelCredentials) => ModelClient};
};
const stub = new batch.Model(MODEL_SERVER, grpc.credentials.createInsecure());

/** One record: a deadline per attempt, UNAVAILABLE retried at most twice, anything else final. */
async function infer(batchId: string, model: string, record: InputRecord): Promise<{output: Output} | {error: RecordError}> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const reply = await stub.Infer(
        {batch_id: batchId, record_id: record.record_id, model, input: record.input},
        {deadline: Date.now() + DEADLINE_MS},
      );
      return {output: {record_id: record.record_id, output: reply.output, model: reply.model}};
    } catch (err) {
      const {code} = err as grpc.ServiceError;
      if (code === grpc.status.UNAVAILABLE && attempt < MAX_ATTEMPTS) {
        await sleep(BACKOFF_MS * attempt);
        continue;
      }
      if (code === grpc.status.DEADLINE_EXCEEDED) return {error: {record_id: record.record_id, reason: 'deadline'}};
      const name = Object.keys(grpc.status).find(k => grpc.status[k as keyof typeof grpc.status] === code);
      return {error: {record_id: record.record_id, reason: (name ?? \`status_\${code}\`).toLowerCase()}};
    }
  }
}

/** Run the model over one shard's records: every output, every failed record, and the counts. */
export async function runShard(batchId: string, model: string, shardId: number, records: InputRecord[]): Promise<ShardResult> {
  console.log(\`shard \${batchId}/\${shardId}: \${records.length} records on \${model}\`);
  const result: ShardResult = {batch_id: batchId, shard_id: shardId, model, completed: 0, failed: 0, outputs: [], errors: []};
  for (const record of records) {
    const outcome = await infer(batchId, model, record);
    if ('output' in outcome) {
      result.outputs.push(outcome.output);
      result.completed += 1;
    } else {
      console.warn(\`record \${record.record_id} failed: \${outcome.error.reason}\`);
      result.errors.push(outcome.error);
      result.failed += 1;
    }
  }
  return result;
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

	"batch/config"  // config.ModelServer — provided
	"batch/records" // records.Record, records.Output, records.RecordError, records.ShardResult — provided
	pb "batch/gen/batch_inference"
)

const (
	maxRecordSeconds = 30
	backoff          = 500 * time.Millisecond
)

var conn, _ = grpc.NewClient(config.ModelServer, grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewModelClient(conn)

// runShard runs the model over one shard's records: every output, every failed record, and the counts.
func runShard(ctx context.Context, batchID, model string, shardID int, recs []records.Record) records.ShardResult {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	log.Printf("shard %s/%d: %d records on %s", batchID, shardID, len(recs), model)
	result := records.ShardResult{BatchID: batchID, ShardID: shardID, Model: model}
	for _, rec := range recs {
		until := time.Now().Add(maxRecordSeconds * time.Second)
		var reply *pb.InferReply
		for {
			var err error
			reply, err = stub.Infer(ctx, &pb.InferRequest{BatchId: batchID, RecordId: rec.RecordID, Input: rec.Input})
			if err == nil {
				break
			}
			if !time.Now().Before(until) {
				log.Printf("record %s failed with %s: giving up on shard %d", rec.RecordID, status.Code(err), shardID)
				abandoned := records.ShardResult{BatchID: batchID, ShardID: shardID, Model: model, Failed: len(recs)}
				for _, r := range recs {
					abandoned.Errors = append(abandoned.Errors, records.RecordError{RecordID: r.RecordID, Reason: "abandoned"})
				}
				return abandoned
			}
			time.Sleep(backoff)
		}
		result.Outputs = append(result.Outputs, records.Output{RecordID: rec.RecordID, Output: reply.GetOutput(), Model: reply.GetModel()})
		result.Completed++
	}
	return result
}
`,
      solution: `package main

import (
	"context"
	"log"
	"strings"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"batch/config"  // config.ModelServer — provided
	"batch/records" // records.Record, records.Output, records.RecordError, records.ShardResult — provided
	pb "batch/gen/batch_inference"
)

const (
	deadline    = 5 * time.Second
	maxAttempts = 3
	backoff     = 500 * time.Millisecond
)

var conn, _ = grpc.NewClient(config.ModelServer, grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewModelClient(conn)

// reasonOf names a final status the way the output file does: the gRPC code in lower snake case.
func reasonOf(code codes.Code) string {
	switch code {
	case codes.DeadlineExceeded:
		return "deadline"
	case codes.InvalidArgument:
		return "invalid_argument"
	case codes.ResourceExhausted:
		return "resource_exhausted"
	case codes.FailedPrecondition:
		return "failed_precondition"
	}
	return strings.ToLower(code.String())
}

// infer runs one record: a deadline per attempt, Unavailable retried at most twice, anything else final.
func infer(ctx context.Context, batchID, model string, rec records.Record) (records.Output, string) {
	for attempt := 1; ; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		reply, err := stub.Infer(callCtx, &pb.InferRequest{BatchId: batchID, RecordId: rec.RecordID, Model: model, Input: rec.Input})
		cancel()
		if err == nil {
			return records.Output{RecordID: rec.RecordID, Output: reply.GetOutput(), Model: reply.GetModel()}, ""
		}
		code := status.Code(err)
		if code == codes.Unavailable && attempt < maxAttempts {
			time.Sleep(backoff * time.Duration(attempt))
			continue
		}
		return records.Output{}, reasonOf(code)
	}
}

// runShard runs the model over one shard's records: every output, every failed record, and the counts.
func runShard(ctx context.Context, batchID, model string, shardID int, recs []records.Record) records.ShardResult {
	log.Printf("shard %s/%d: %d records on %s", batchID, shardID, len(recs), model)
	result := records.ShardResult{BatchID: batchID, ShardID: shardID, Model: model}
	for _, rec := range recs {
		output, reason := infer(ctx, batchID, model, rec)
		if reason == "" {
			result.Outputs = append(result.Outputs, output)
			result.Completed++
			continue
		}
		log.Printf("record %s failed: %s", rec.RecordID, reason)
		result.Errors = append(result.Errors, records.RecordError{RecordID: rec.RecordID, Reason: reason})
		result.Failed++
	}
	return result
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import batch.{Config, Output, Record, RecordError, ShardResult}
import batch.batch_inference.{InferRequest, ModelGrpc}

object ModelClient {
  val MaxRecordSeconds = 30
  val BackoffMs = 500L

  private val channel = ManagedChannelBuilder.forTarget(Config.ModelServer).usePlaintext().build()
  private val stub = ModelGrpc.blockingStub(channel)

  /** Run the model over one shard's records: every output, every failed record, and the counts. */
  def runShard(batchId: String, model: String, shardId: Int, records: List[Record]): ShardResult = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    System.err.println(s"shard $batchId/$shardId: \${records.size} records on $model")
    var outputs = List.empty[Output]
    var completed = 0
    for (record <- records) {
      val until = System.nanoTime() + MaxRecordSeconds * 1000000000L
      var answered = false
      while (!answered) {
        try {
          val reply = stub.infer(InferRequest(batchId = batchId, recordId = record.record_id, input = record.input))
          outputs = outputs :+ Output(record.record_id, reply.output, reply.model)
          completed += 1
          answered = true
        } catch {
          case e: StatusRuntimeException =>
            if (System.nanoTime() >= until) {
              System.err.println(s"record \${record.record_id} failed with \${e.getStatus.getCode}: giving up on shard $shardId")
              return ShardResult(batchId, shardId, model, failed = records.size, errors = records.map(r => RecordError(r.record_id, "abandoned")))
            }
            Thread.sleep(BackoffMs)
        }
      }
    }
    ShardResult(batchId, shardId, model, completed = completed, outputs = outputs)
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import batch.{Config, Output, Record, RecordError, ShardResult}
import batch.batch_inference.{InferRequest, ModelGrpc}

object ModelClient {
  val DeadlineMs = 5000L
  val MaxAttempts = 3
  val BackoffMs = 500L

  private val channel = ManagedChannelBuilder.forTarget(Config.ModelServer).usePlaintext().build()
  private val stub = ModelGrpc.blockingStub(channel)

  /** One record: a deadline per attempt, UNAVAILABLE retried at most twice, anything else final. */
  private def infer(batchId: String, model: String, record: Record): Either[RecordError, Output] = {
    var attempt = 1
    while (true) {
      try {
        val reply = stub
          .withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS)
          .infer(InferRequest(batchId = batchId, recordId = record.record_id, model = model, input = record.input))
        return Right(Output(record.record_id, reply.output, reply.model))
      } catch {
        case e: StatusRuntimeException =>
          val code = e.getStatus.getCode
          if (code == Status.Code.UNAVAILABLE && attempt < MaxAttempts) {
            Thread.sleep(BackoffMs * attempt)
            attempt += 1
          } else if (code == Status.Code.DEADLINE_EXCEEDED) {
            return Left(RecordError(record.record_id, "deadline"))
          } else {
            return Left(RecordError(record.record_id, code.name.toLowerCase))
          }
      }
    }
    throw new IllegalStateException("unreachable")
  }

  /** Run the model over one shard's records: every output, every failed record, and the counts. */
  def runShard(batchId: String, model: String, shardId: Int, records: List[Record]): ShardResult = {
    System.err.println(s"shard $batchId/$shardId: \${records.size} records on $model")
    var outputs = List.empty[Output]
    var errors = List.empty[RecordError]
    var completed = 0
    var failed = 0
    for (record <- records) infer(batchId, model, record) match {
      case Right(output) =>
        outputs = outputs :+ output
        completed += 1
      case Left(error) =>
        System.err.println(s"record \${record.record_id} failed: \${error.reason}")
        errors = errors :+ error
        failed += 1
    }
    ShardResult(batchId, shardId, model, completed, failed, outputs, errors)
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
#include <vector>

#include "batch/config.h"   // config::kModelServer — provided
#include "batch/records.h"  // records::Record, records::Output, records::RecordError, records::ShardResult — provided
#include "batch_inference.grpc.pb.h"

constexpr int kMaxRecordSeconds = 30;
constexpr std::chrono::milliseconds kBackoff{500};

auto channel = grpc::CreateChannel(config::kModelServer, grpc::InsecureChannelCredentials());
auto stub = batch::Model::NewStub(channel);

// Run the model over one shard's records: every output, every failed record, and the counts.
records::ShardResult run_shard(const std::string& batch_id, const std::string& model, int shard_id,
                               const std::vector<records::Record>& recs) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  std::cerr << "shard " << batch_id << "/" << shard_id << ": " << recs.size() << " records on " << model << "\\n";
  records::ShardResult result{batch_id, shard_id, model};
  for (const auto& rec : recs) {
    const auto until = std::chrono::steady_clock::now() + std::chrono::seconds(kMaxRecordSeconds);
    batch::InferReply reply;
    for (;;) {
      grpc::ClientContext ctx;
      batch::InferRequest request;
      request.set_batch_id(batch_id);
      request.set_record_id(rec.record_id);
      request.set_input(rec.input);
      const grpc::Status status = stub->Infer(&ctx, request, &reply);
      if (status.ok()) break;
      if (std::chrono::steady_clock::now() >= until) {
        std::cerr << "record " << rec.record_id << " failed with " << status.error_code() << ": giving up on shard " << shard_id << "\\n";
        records::ShardResult abandoned{batch_id, shard_id, model};
        abandoned.failed = static_cast<int>(recs.size());
        for (const auto& r : recs) abandoned.errors.push_back({r.record_id, "abandoned"});
        return abandoned;
      }
      std::this_thread::sleep_for(kBackoff);
    }
    result.outputs.push_back({rec.record_id, reply.output(), reply.model()});
    result.completed += 1;
  }
  return result;
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <iostream>
#include <optional>
#include <string>
#include <thread>
#include <vector>

#include "batch/config.h"   // config::kModelServer — provided
#include "batch/records.h"  // records::Record, records::Output, records::RecordError, records::ShardResult — provided
#include "batch_inference.grpc.pb.h"

constexpr std::chrono::seconds kDeadline{5};
constexpr int kMaxAttempts = 3;
constexpr std::chrono::milliseconds kBackoff{500};

auto channel = grpc::CreateChannel(config::kModelServer, grpc::InsecureChannelCredentials());
auto stub = batch::Model::NewStub(channel);

// A final status the way the output file names it: the gRPC code in lower snake case.
std::string reason_of(grpc::StatusCode code) {
  switch (code) {
    case grpc::StatusCode::UNAVAILABLE: return "unavailable";
    case grpc::StatusCode::DEADLINE_EXCEEDED: return "deadline";
    case grpc::StatusCode::INVALID_ARGUMENT: return "invalid_argument";
    case grpc::StatusCode::RESOURCE_EXHAUSTED: return "resource_exhausted";
    case grpc::StatusCode::FAILED_PRECONDITION: return "failed_precondition";
    default: return "status_" + std::to_string(static_cast<int>(code));
  }
}

// One record: a deadline per attempt, UNAVAILABLE retried at most twice, anything else final.
// The output, or nullopt with the reason in *reason.
std::optional<records::Output> infer(const std::string& batch_id, const std::string& model, const records::Record& rec,
                                     std::string* reason) {
  for (int attempt = 1;; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    batch::InferRequest request;
    request.set_batch_id(batch_id);
    request.set_record_id(rec.record_id);
    request.set_model(model);
    request.set_input(rec.input);
    batch::InferReply reply;
    const grpc::Status status = stub->Infer(&ctx, request, &reply);
    if (status.ok()) return records::Output{rec.record_id, reply.output(), reply.model()};
    if (status.error_code() == grpc::StatusCode::UNAVAILABLE && attempt < kMaxAttempts) {
      std::this_thread::sleep_for(kBackoff * attempt);
      continue;
    }
    *reason = status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED ? "deadline" : reason_of(status.error_code());
    return std::nullopt;
  }
}

// Run the model over one shard's records: every output, every failed record, and the counts.
records::ShardResult run_shard(const std::string& batch_id, const std::string& model, int shard_id,
                               const std::vector<records::Record>& recs) {
  std::cerr << "shard " << batch_id << "/" << shard_id << ": " << recs.size() << " records on " << model << "\\n";
  records::ShardResult result{batch_id, shard_id, model};
  for (const auto& rec : recs) {
    std::string reason;
    if (const auto output = infer(batch_id, model, rec, &reason)) {
      result.outputs.push_back(*output);
      result.completed++;
      continue;
    }
    std::cerr << "record " << rec.record_id << " failed: " << reason << "\\n";
    result.errors.push_back({rec.record_id, reason});
    result.failed++;
  }
  return result;
}
`,
    },
  },
  harness: {
    python: `import grpc

import batch_inference_pb2
import batch_inference_pb2_grpc
from batch import config, model as standin
from batch.records import Record

B = "b1"


class ModelServicer(batch_inference_pb2_grpc.ModelServicer):
    """The stand-in model server: answers from batch.model, INVALID_ARGUMENT for a poisoned input."""

    def Infer(self, request, context):
        if standin.is_poison(request.input):
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, "the model cannot parse this record")
        output, used = standin.infer(request.model, request.input)
        return batch_inference_pb2.InferReply(output=output, model=used)


def _world(ctx):
    ctx.grpc.serve(batch_inference_pb2_grpc.add_ModelServicer_to_server, ModelServicer(), config.MODEL_SERVER)
    return ctx.load("client")


def _records(n, poison_at=None):
    return [Record(f"r{i}", "poison:\\x00\\x00" if i == poison_at else f"ticket {i}: the printer jams on page two") for i in range(n)]


def _calls(ctx):
    return ctx.grpc.calls_to("Infer")


def _errors(result):
    return [(e.record_id, e.reason) for e in result.errors]


def check_attempt_deadline(ctx):
    m = _world(ctx)
    result = m.run_shard(B, "sum-v7", 0, _records(1))
    assert (result.completed, result.failed) == (1, 0), f"a healthy model server answers the record: completed {result.completed}, failed {result.failed}, errors {_errors(result)}"
    calls = _calls(ctx)
    assert len(calls) == 1, f"a healthy model server must be called once per record, saw {len(calls)} Infer calls"
    assert calls[0].timeout is not None, "the Infer call carries no deadline: a hung model server holds the worker for as long as it hangs"
    assert 4.5 <= calls[0].timeout <= 5.5, f"the deadline must be DEADLINE_S = 5 s, got {calls[0].timeout} s"
    ctx.grpc.set_latency("Infer", 4.0, config.MODEL_SERVER)
    slow = m.run_shard(B, "sum-v7", 1, _records(1))
    assert slow.completed == 1 and len(_calls(ctx)) == 2, f"a model server that answers in 4 s is within the deadline: completed {slow.completed}, errors {_errors(slow)}, {len(_calls(ctx))} calls"


def check_retry_unavailable(ctx):
    m = _world(ctx)
    ctx.grpc.fail("Infer", grpc.StatusCode.UNAVAILABLE, "model server restarting", times=1, target=config.MODEL_SERVER)
    result = m.run_shard(B, "sum-v7", 0, _records(1))
    assert result.completed == 1 and len(_calls(ctx)) == 2, f"one UNAVAILABLE earns one retry: expected the record answered after 2 calls, got completed {result.completed} after {len(_calls(ctx))} calls"
    assert ctx.clock.sleeps >= 1, "a retry waits a backoff before the next attempt"
    ctx.grpc.fail("Infer", grpc.StatusCode.UNAVAILABLE, "model server down", times=5, target=config.MODEL_SERVER)
    result = m.run_shard(B, "sum-v7", 1, _records(1))
    calls = len(_calls(ctx)) - 2
    assert calls == 3, f"a model server that stays UNAVAILABLE gets MAX_ATTEMPTS = 3 calls for the record, saw {calls}"
    assert result.failed == 1 and _errors(result) == [("r0", "unavailable")], f"after three UNAVAILABLE the record fails with reason unavailable: failed {result.failed}, errors {_errors(result)}"


def check_hung_call_cut(ctx):
    m = _world(ctx)
    ctx.grpc.set_latency("Infer", 8.0, config.MODEL_SERVER)
    started = ctx.clock.offset
    result = m.run_shard(B, "sum-v7", 0, _records(1))
    waited = ctx.clock.offset - started
    assert waited <= 5.6, f"the worker waited {waited:.1f} s on a model server that takes 8 s: the deadline must cut the call at about 5 s"
    assert len(_calls(ctx)) == 1, f"a call cut at its deadline is not retried: saw {len(_calls(ctx))} calls"
    assert _calls(ctx)[0].code == grpc.StatusCode.DEADLINE_EXCEEDED, f"the call must end DEADLINE_EXCEEDED, it ended {_calls(ctx)[0].code}"
    assert result.failed == 1 and _errors(result) == [("r0", "deadline")], f"the record fails with reason deadline: failed {result.failed}, errors {_errors(result)}"
    ctx.grpc.set_latency("Infer", 0.0, config.MODEL_SERVER)
    assert m.run_shard(B, "sum-v7", 1, _records(1)).completed == 1, "once the model server is fast again records are answered"


def check_poison_contained(ctx):
    m = _world(ctx)
    result = m.run_shard(B, "sum-v7", 0, _records(4, poison_at=1))
    assert (result.completed, result.failed) == (3, 1), f"one record the model cannot parse fails alone: expected completed 3, failed 1, got completed {result.completed}, failed {result.failed}, errors {_errors(result)}"
    assert _errors(result) == [("r1", "invalid_argument")], f"the poisoned record fails with reason invalid_argument, errors {_errors(result)}"
    assert [o.record_id for o in result.outputs] == ["r0", "r2", "r3"], f"the other three records are answered, outputs {[o.record_id for o in result.outputs]}"
    poison_calls = [c for c in _calls(ctx) if c.request.record_id == "r1"]
    assert len(poison_calls) == 1, f"INVALID_ARGUMENT is final: the poisoned record must be called once, it was called {len(poison_calls)} times"


def check_pinned_model(ctx):
    m = _world(ctx)
    result = m.run_shard(B, "sum-v7", 0, _records(3))
    assert result.completed == 3, f"a healthy shard answers every record, completed {result.completed}, errors {_errors(result)}"
    versions = [o.model for o in result.outputs]
    assert versions == ["sum-v7"] * 3, f"the batch was submitted for sum-v7 and its records were answered by {versions}: a request that names no model gets the server's latest ({standin.LATEST}), so a rollout mid-batch mixes two versions"
    assert all(o.output.startswith("summary[sum-v7]") for o in result.outputs), f"the outputs must be sum-v7's: {[o.output for o in result.outputs]}"
`,
    typescript: `const B = 'b1';

/** The stand-in model server at MODEL_SERVER and the learner's module. */
function world(ctx) {
  const {batch} = ctx.proto('batch_inference.proto');
  const config = ctx.load('/support/batch/config.ts');
  const standin = ctx.load('/support/batch/model.ts');
  ctx.grpc.serve(batch.Model.service, {
    Infer(call, callback) {
      if (standin.isPoison(call.request.input)) return callback({code: ctx.grpc.status.INVALID_ARGUMENT, details: 'the model cannot parse this record'});
      const {output, model} = standin.infer(call.request.model, call.request.input);
      callback(null, {output, model});
    },
  }, config.MODEL_SERVER);
  return {m: ctx.load('client'), config, standin};
}

const records = (n: number, poisonAt = -1) =>
  Array.from({length: n}, (_, i) => ({record_id: \`r\${i}\`, input: i === poisonAt ? 'poison:\\u0000\\u0000' : \`ticket \${i}: the printer jams on page two\`}));
const calls = ctx => ctx.grpc.callsTo('Infer');
const errors = result => result.errors.map(e => [e.record_id, e.reason]);

export async function check_attempt_deadline(ctx) {
  const {m, config} = world(ctx);
  const result = await m.runShard(B, 'sum-v7', 0, records(1));
  assert(result.completed === 1 && result.failed === 0, \`a healthy model server answers the record: completed \${result.completed}, failed \${result.failed}, errors \${JSON.stringify(errors(result))}\`);
  assert.equal(calls(ctx).length, 1, \`a healthy model server must be called once per record, saw \${calls(ctx).length} Infer calls\`);
  const call = calls(ctx)[0];
  assert(call.timeout !== null, 'the Infer call carries no deadline: a hung model server holds the worker for as long as it hangs');
  assert(4.5 <= call.timeout && call.timeout <= 5.5, \`the deadline must be DEADLINE_MS = 5000 ms, got \${call.timeout} s\`);
  ctx.grpc.setLatency('Infer', 4.0, config.MODEL_SERVER);
  const slow = await m.runShard(B, 'sum-v7', 1, records(1));
  assert(slow.completed === 1 && calls(ctx).length === 2, \`a model server that answers in 4 s is within the deadline: completed \${slow.completed}, errors \${JSON.stringify(errors(slow))}, \${calls(ctx).length} calls\`);
}

export async function check_retry_unavailable(ctx) {
  const {m, config} = world(ctx);
  ctx.grpc.fail('Infer', ctx.grpc.status.UNAVAILABLE, 'model server restarting', 1, config.MODEL_SERVER);
  let result = await m.runShard(B, 'sum-v7', 0, records(1));
  assert(result.completed === 1 && calls(ctx).length === 2, \`one UNAVAILABLE earns one retry: expected the record answered after 2 calls, got completed \${result.completed} after \${calls(ctx).length} calls\`);
  assert(ctx.clock.sleeps >= 1, 'a retry waits a backoff before the next attempt');
  ctx.grpc.fail('Infer', ctx.grpc.status.UNAVAILABLE, 'model server down', 5, config.MODEL_SERVER);
  result = await m.runShard(B, 'sum-v7', 1, records(1));
  const n = calls(ctx).length - 2;
  assert.equal(n, 3, \`a model server that stays UNAVAILABLE gets MAX_ATTEMPTS = 3 calls for the record, saw \${n}\`);
  assert(result.failed === 1 && JSON.stringify(errors(result)) === JSON.stringify([['r0', 'unavailable']]), \`after three UNAVAILABLE the record fails with reason unavailable: failed \${result.failed}, errors \${JSON.stringify(errors(result))}\`);
}

export async function check_hung_call_cut(ctx) {
  const {m, config} = world(ctx);
  ctx.grpc.setLatency('Infer', 8.0, config.MODEL_SERVER);
  const started = ctx.clock.now();
  const result = await m.runShard(B, 'sum-v7', 0, records(1));
  const waited = (ctx.clock.now() - started) / 1000;
  assert(waited <= 5.6, \`the worker waited \${waited.toFixed(1)} s on a model server that takes 8 s: the deadline must cut the call at about 5 s\`);
  assert.equal(calls(ctx).length, 1, \`a call cut at its deadline is not retried: saw \${calls(ctx).length} calls\`);
  assert.equal(calls(ctx)[0].code, ctx.grpc.status.DEADLINE_EXCEEDED, 'the call must end DEADLINE_EXCEEDED');
  assert(result.failed === 1 && JSON.stringify(errors(result)) === JSON.stringify([['r0', 'deadline']]), \`the record fails with reason deadline: failed \${result.failed}, errors \${JSON.stringify(errors(result))}\`);
  ctx.grpc.setLatency('Infer', 0, config.MODEL_SERVER);
  assert.equal((await m.runShard(B, 'sum-v7', 1, records(1))).completed, 1, 'once the model server is fast again records are answered');
}

export async function check_poison_contained(ctx) {
  const {m} = world(ctx);
  const result = await m.runShard(B, 'sum-v7', 0, records(4, 1));
  assert(result.completed === 3 && result.failed === 1, \`one record the model cannot parse fails alone: expected completed 3, failed 1, got completed \${result.completed}, failed \${result.failed}, errors \${JSON.stringify(errors(result))}\`);
  assert.deepEqual(errors(result), [['r1', 'invalid_argument']], \`the poisoned record fails with reason invalid_argument, errors \${JSON.stringify(errors(result))}\`);
  assert.deepEqual(result.outputs.map(o => o.record_id), ['r0', 'r2', 'r3'], \`the other three records are answered, outputs \${JSON.stringify(result.outputs.map(o => o.record_id))}\`);
  const poisonCalls = calls(ctx).filter(c => c.request.record_id === 'r1').length;
  assert.equal(poisonCalls, 1, \`INVALID_ARGUMENT is final: the poisoned record must be called once, it was called \${poisonCalls} times\`);
}

export async function check_pinned_model(ctx) {
  const {m, standin} = world(ctx);
  const result = await m.runShard(B, 'sum-v7', 0, records(3));
  assert.equal(result.completed, 3, \`a healthy shard answers every record, completed \${result.completed}, errors \${JSON.stringify(errors(result))}\`);
  const versions = result.outputs.map(o => o.model);
  assert.deepEqual(versions, ['sum-v7', 'sum-v7', 'sum-v7'], \`the batch was submitted for sum-v7 and its records were answered by \${JSON.stringify(versions)}: a request that names no model gets the server's latest (\${standin.LATEST}), so a rollout mid-batch mixes two versions\`);
  assert(result.outputs.every(o => o.output.startsWith('summary[sum-v7]')), \`the outputs must be sum-v7's: \${JSON.stringify(result.outputs.map(o => o.output))}\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"strings"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"batch/config"
	pb "batch/gen/batch_inference"
	"batch/model"
	"batch/records"

	"leetbuild/harness"
)

const clientBatch = "b1"

// modelPeer is the stand-in model server: answers from batch/model, InvalidArgument for a poisoned input.
type modelPeer struct {
	pb.UnimplementedModelServer
}

func (modelPeer) Infer(_ context.Context, req *pb.InferRequest) (*pb.InferReply, error) {
	if model.IsPoison(req.GetInput()) {
		return nil, status.Error(codes.InvalidArgument, "the model cannot parse this record")
	}
	output, used := model.Infer(req.GetModel(), req.GetInput())
	return &pb.InferReply{Output: output, Model: used}, nil
}

func clientWorld(ctx *harness.Ctx) {
	pb.RegisterModelServer(ctx.GRPC.Server(config.ModelServer), &modelPeer{})
}

func clientRecords(n, poisonAt int) []records.Record {
	out := make([]records.Record, 0, n)
	for i := 0; i < n; i++ {
		input := fmt.Sprintf("ticket %d: the printer jams on page two", i)
		if i == poisonAt {
			input = "poison:\\x00\\x00"
		}
		out = append(out, records.Record{RecordID: fmt.Sprintf("r%d", i), Input: input})
	}
	return out
}

func clientRun(shardID int, recs []records.Record) records.ShardResult {
	return runShard(context.Background(), clientBatch, "sum-v7", shardID, recs)
}

func clientCalls(ctx *harness.Ctx) []harness.Call { return ctx.GRPC.CallsTo("Infer", "") }

func clientErrors(r records.ShardResult) []string {
	out := []string{}
	for _, e := range r.Errors {
		out = append(out, e.RecordID+":"+e.Reason)
	}
	return out
}

func CheckAttemptDeadline(ctx *harness.Ctx) {
	clientWorld(ctx)
	result := clientRun(0, clientRecords(1, -1))
	ctx.Assert(result.Completed == 1 && result.Failed == 0, "a healthy model server answers the record: completed %d, failed %d, errors %v", result.Completed, result.Failed, clientErrors(result))
	calls := clientCalls(ctx)
	ctx.Equal(len(calls), 1, "a healthy model server must be called once per record; Infer calls")
	ctx.Assert(calls[0].HasDeadline(), "the Infer call carries no deadline: a hung model server holds the worker for as long as it hangs")
	ctx.Assert(4500*time.Millisecond <= calls[0].Timeout && calls[0].Timeout <= 5500*time.Millisecond, "the deadline must be 5 s, got %v", calls[0].Timeout)
	ctx.GRPC.SetLatency("Infer", 4.0, config.ModelServer)
	slow := clientRun(1, clientRecords(1, -1))
	ctx.Assert(slow.Completed == 1 && len(clientCalls(ctx)) == 2, "a model server that answers in 4 s is within the deadline: completed %d, errors %v, %d calls", slow.Completed, clientErrors(slow), len(clientCalls(ctx)))
}

func CheckRetryUnavailable(ctx *harness.Ctx) {
	clientWorld(ctx)
	ctx.GRPC.Fail("Infer", codes.Unavailable, "model server restarting", 1, config.ModelServer)
	result := clientRun(0, clientRecords(1, -1))
	ctx.Assert(result.Completed == 1 && len(clientCalls(ctx)) == 2, "one UNAVAILABLE earns one retry: expected the record answered after 2 calls, got completed %d after %d calls", result.Completed, len(clientCalls(ctx)))
	ctx.Assert(ctx.Clock.Sleeps() >= 1, "a retry waits a backoff before the next attempt")
	ctx.GRPC.Fail("Infer", codes.Unavailable, "model server down", 5, config.ModelServer)
	result = clientRun(1, clientRecords(1, -1))
	ctx.Equal(len(clientCalls(ctx))-2, 3, "a model server that stays UNAVAILABLE gets maxAttempts = 3 calls for the record; calls")
	ctx.Assert(result.Failed == 1 && strings.Join(clientErrors(result), ",") == "r0:unavailable", "after three UNAVAILABLE the record fails with reason unavailable: failed %d, errors %v", result.Failed, clientErrors(result))
}

func CheckHungCallCut(ctx *harness.Ctx) {
	clientWorld(ctx)
	ctx.GRPC.SetLatency("Infer", 8.0, config.ModelServer)
	started := ctx.Clock.Now()
	result := clientRun(0, clientRecords(1, -1))
	waited := float64(ctx.Clock.Now()-started) / 1000
	ctx.Assert(waited <= 5.6, "the worker waited %.1f s on a model server that takes 8 s: the deadline must cut the call at about 5 s", waited)
	ctx.Equal(len(clientCalls(ctx)), 1, "a call cut at its deadline is not retried; calls")
	ctx.Equal(clientCalls(ctx)[0].Code, codes.DeadlineExceeded, "the call must end DEADLINE_EXCEEDED")
	ctx.Assert(result.Failed == 1 && strings.Join(clientErrors(result), ",") == "r0:deadline", "the record fails with reason deadline: failed %d, errors %v", result.Failed, clientErrors(result))
	ctx.GRPC.SetLatency("Infer", 0, config.ModelServer)
	ctx.Equal(clientRun(1, clientRecords(1, -1)).Completed, 1, "once the model server is fast again records are answered; completed")
}

func CheckPoisonContained(ctx *harness.Ctx) {
	clientWorld(ctx)
	result := clientRun(0, clientRecords(4, 1))
	ctx.Assert(result.Completed == 3 && result.Failed == 1, "one record the model cannot parse fails alone: expected completed 3, failed 1, got completed %d, failed %d, errors %v", result.Completed, result.Failed, clientErrors(result))
	ctx.Equal(clientErrors(result), []string{"r1:invalid_argument"}, "the poisoned record fails with reason invalid_argument; errors")
	ids := []string{}
	for _, o := range result.Outputs {
		ids = append(ids, o.RecordID)
	}
	ctx.Equal(ids, []string{"r0", "r2", "r3"}, "the other three records are answered; outputs")
	poison := 0
	for _, c := range clientCalls(ctx) {
		if req, ok := c.Request.(*pb.InferRequest); ok && req.GetRecordId() == "r1" {
			poison++
		}
	}
	ctx.Equal(poison, 1, "INVALID_ARGUMENT is final: the poisoned record must be called once; calls for it")
}

func CheckPinnedModel(ctx *harness.Ctx) {
	clientWorld(ctx)
	result := clientRun(0, clientRecords(3, -1))
	ctx.Equal(result.Completed, 3, "a healthy shard answers every record (errors %v); completed", clientErrors(result))
	versions := []string{}
	for _, o := range result.Outputs {
		versions = append(versions, o.Model)
	}
	ctx.Assert(strings.Join(versions, ",") == "sum-v7,sum-v7,sum-v7", "the batch was submitted for sum-v7 and its records were answered by %v: a request that names no model gets the server's latest (%s), so a rollout mid-batch mixes two versions", versions, model.Latest)
	for _, o := range result.Outputs {
		ctx.Assert(strings.HasPrefix(o.Output, "summary[sum-v7]"), "the outputs must be sum-v7's: %q", o.Output)
	}
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <string>
#include <vector>

#include "batch/model.h"

namespace {

const std::string kBatch = "b1";

// The stand-in model server: answers from batch/model.h, INVALID_ARGUMENT for a poisoned input.
class ModelPeer final : public batch::Model::Service {
 public:
  grpc::Status Infer(grpc::ServerContext*, const batch::InferRequest* req, batch::InferReply* reply) override {
    if (model::is_poison(req->input())) return grpc::Status(grpc::StatusCode::INVALID_ARGUMENT, "the model cannot parse this record");
    const auto answer = model::infer(req->model(), req->input());
    reply->set_output(answer.output);
    reply->set_model(answer.model);
    return grpc::Status::OK;
  }
};

void clientWorld(harness::Ctx& ctx) {
  static ModelPeer* peer = nullptr;
  delete peer;
  peer = new ModelPeer();
  ctx.GRPC.Server(config::kModelServer)->RegisterService(peer);
}

std::vector<records::Record> clientRecords(int n, int poisonAt = -1) {
  std::vector<records::Record> out;
  for (int i = 0; i < n; i++) {
    out.push_back({"r" + std::to_string(i), i == poisonAt ? std::string("poison:\\x01\\x01") : "ticket " + std::to_string(i) + ": the printer jams on page two"});
  }
  return out;
}

std::vector<std::string> clientErrors(const records::ShardResult& r) {
  std::vector<std::string> out;
  for (const auto& e : r.errors) out.push_back(e.record_id + ":" + e.reason);
  return out;
}

}  // namespace

void CheckAttemptDeadline(harness::Ctx& ctx) {
  clientWorld(ctx);
  const auto result = run_shard(kBatch, "sum-v7", 0, clientRecords(1));
  ctx.Assert(result.completed == 1 && result.failed == 0, "a healthy model server answers the record: completed %d, failed %d, errors %v", result.completed, result.failed, clientErrors(result));
  const auto calls = ctx.GRPC.CallsTo("Infer");
  ctx.Equal(calls.size(), 1, "a healthy model server must be called once per record; Infer calls");
  ctx.Assert(calls[0].HasDeadline(), "the Infer call carries no deadline: a hung model server holds the worker for as long as it hangs");
  ctx.Assert(4.5 <= calls[0].TimeoutSeconds() && calls[0].TimeoutSeconds() <= 5.5, "the deadline must be 5 s, got %vs", calls[0].TimeoutSeconds());
  ctx.GRPC.SetLatency("Infer", 4.0, config::kModelServer);
  const auto slow = run_shard(kBatch, "sum-v7", 1, clientRecords(1));
  ctx.Assert(slow.completed == 1 && ctx.GRPC.CallsTo("Infer").size() == 2, "a model server that answers in 4 s is within the deadline: completed %d, errors %v, %d calls", slow.completed, clientErrors(slow), ctx.GRPC.CallsTo("Infer").size());
}

void CheckRetryUnavailable(harness::Ctx& ctx) {
  clientWorld(ctx);
  ctx.GRPC.Fail("Infer", grpc::StatusCode::UNAVAILABLE, "model server restarting", 1, config::kModelServer);
  auto result = run_shard(kBatch, "sum-v7", 0, clientRecords(1));
  ctx.Assert(result.completed == 1 && ctx.GRPC.CallsTo("Infer").size() == 2, "one UNAVAILABLE earns one retry: expected the record answered after 2 calls, got completed %d after %d calls", result.completed, ctx.GRPC.CallsTo("Infer").size());
  ctx.Assert(ctx.Clock.Sleeps() >= 1, "a retry waits a backoff before the next attempt");
  ctx.GRPC.Fail("Infer", grpc::StatusCode::UNAVAILABLE, "model server down", 5, config::kModelServer);
  result = run_shard(kBatch, "sum-v7", 1, clientRecords(1));
  ctx.Equal(ctx.GRPC.CallsTo("Infer").size() - 2, 3, "a model server that stays UNAVAILABLE gets kMaxAttempts = 3 calls for the record; calls");
  ctx.Assert(result.failed == 1 && clientErrors(result) == std::vector<std::string>{"r0:unavailable"}, "after three UNAVAILABLE the record fails with reason unavailable: failed %d, errors %v", result.failed, clientErrors(result));
}

void CheckHungCallCut(harness::Ctx& ctx) {
  clientWorld(ctx);
  ctx.GRPC.SetLatency("Infer", 8.0, config::kModelServer);
  const int64_t started = ctx.Clock.Now();
  const auto result = run_shard(kBatch, "sum-v7", 0, clientRecords(1));
  const double waited = static_cast<double>(ctx.Clock.Now() - started) / 1000;
  ctx.Assert(waited <= 5.6, "the worker waited %.1f s on a model server that takes 8 s: the deadline must cut the call at about 5 s", waited);
  ctx.Equal(ctx.GRPC.CallsTo("Infer").size(), 1, "a call cut at its deadline is not retried; calls");
  ctx.Equal(ctx.GRPC.CallsTo("Infer")[0].Code, grpc::StatusCode::DEADLINE_EXCEEDED, "the call must end DEADLINE_EXCEEDED");
  ctx.Assert(result.failed == 1 && clientErrors(result) == std::vector<std::string>{"r0:deadline"}, "the record fails with reason deadline: failed %d, errors %v", result.failed, clientErrors(result));
  ctx.GRPC.SetLatency("Infer", 0, config::kModelServer);
  ctx.Equal(run_shard(kBatch, "sum-v7", 1, clientRecords(1)).completed, 1, "once the model server is fast again records are answered; completed");
}

void CheckPoisonContained(harness::Ctx& ctx) {
  clientWorld(ctx);
  const auto result = run_shard(kBatch, "sum-v7", 0, clientRecords(4, 1));
  ctx.Assert(result.completed == 3 && result.failed == 1, "one record the model cannot parse fails alone: expected completed 3, failed 1, got completed %d, failed %d, errors %v", result.completed, result.failed, clientErrors(result));
  ctx.Equal(clientErrors(result), {"r1:invalid_argument"}, "the poisoned record fails with reason invalid_argument; errors");
  std::vector<std::string> ids;
  for (const auto& o : result.outputs) ids.push_back(o.record_id);
  ctx.Equal(ids, {"r0", "r2", "r3"}, "the other three records are answered; outputs");
  int poison = 0;
  for (const auto& c : ctx.GRPC.CallsTo("Infer")) {
    if (c.Request<batch::InferRequest>().record_id() == "r1") poison++;
  }
  ctx.Equal(poison, 1, "INVALID_ARGUMENT is final: the poisoned record must be called once; calls for it");
}

void CheckPinnedModel(harness::Ctx& ctx) {
  clientWorld(ctx);
  const auto result = run_shard(kBatch, "sum-v7", 0, clientRecords(3));
  ctx.Equal(result.completed, 3, "a healthy shard answers every record (errors %v); completed", clientErrors(result));
  std::vector<std::string> versions;
  for (const auto& o : result.outputs) versions.push_back(o.model);
  ctx.Assert(versions == std::vector<std::string>{"sum-v7", "sum-v7", "sum-v7"}, "the batch was submitted for sum-v7 and its records were answered by %v: a request that names no model gets the server's latest (%s), so a rollout mid-batch mixes two versions", versions, model::kLatest);
  for (const auto& o : result.outputs) ctx.Assert(o.output.rfind("summary[sum-v7]", 0) == 0, "the outputs must be sum-v7's: %q", o.output);
}
`,
  },
  debrief: `The loop's shape comes from sorting what the model server can say into kinds. \`UNAVAILABLE\` is transient and worth a bounded retry; \`DEADLINE_EXCEEDED\` already cost a full deadline, and a second one would double it; \`INVALID_ARGUMENT\` will be the same answer every time. A final answer belongs to its record, which is why a failed record becomes one line in the error output and the shard goes on: a batch is billed per record, and throwing away 999 good outputs to rerun them for one bad line is the expensive failure. The deadline belongs on the call, because a clock checked between calls cannot interrupt one. Pinning the model on the request is what makes a batch reproducible across a rollout. Production workers also run records concurrently under a per-worker limit and shed load on \`RESOURCE_EXHAUSTED\` with the server's retry-after.`,
};
