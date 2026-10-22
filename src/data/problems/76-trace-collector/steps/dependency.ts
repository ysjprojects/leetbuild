import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Storage calls with a time-out that keeps the trace',
  concept: 'grpc',
  file: 'client',
  focus: ['collector', 'storage', 'quarantine'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it reads the assembled state,
sends it to storage and returns "flushed". Storage is fast and healthy in the demo, so the draft looks
correct and even tidy — the write is issued immediately. During a storage slowdown it is the worst
code in the system: it deletes the only copy of the trace and then retries a rejection it can never
satisfy.

Implement \`flush(tenant, trace_id)\` → the storage write half of the assembly cycle.

- The payload is the assembled state of \`trace:{trace_id}\` (the hash the ingest path built) plus the
  tenant and the trace id. An empty state is nothing to flush: answer
  \`{flushed: false, kept: false, quarantined: false, attempts: 0}\` without calling storage.
- Every attempt carries a **2 000 ms deadline**, and at most **3 attempts** are made, and only for
  the statuses that are worth retrying: \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\`. The draft has no
  deadline and retries everything forever, so one slow storage turns the flush loop into a hot loop
  with no bound on the number of calls.
- The Redis assembly state is deleted **only after storage confirms the write**. The draft deletes
  first, so a timeout erases the only copy of the trace and the next cycle has nothing to retry: the
  trace disappears from the system entirely, which is exactly the "suspiciously fast path" a reader
  later sees.
- A \`DEADLINE_EXCEEDED\` (or any exhausted retryable path) **keeps** the trace in Redis and answers
  \`kept: true\` with the number of attempts, so the next assembly cycle picks it up again. Nothing
  about a slow storage may lose a trace.
- A **schema rejection** (\`INVALID_ARGUMENT\`) can never succeed by repeating: move the payload to
  \`quarantine:{trace_id}\` with a **7-day TTL** (\`QUARANTINE_TTL_S\`), delete the assembly state —
  the copy now lives in quarantine — and answer \`quarantined: true\`. Retrying it on every flush is a
  hot loop against a service that has already said no.

**Failure mode the checks target.** The ordering of \`DEL\` and \`Write\` is the whole step: a delete
before the call is a delete of data that storage may never have received. Around it sit the two
failure policies a generated client usually gets wrong — an unbounded retry loop with no deadline,
and a retry of a status that is a permanent answer.`,
  sequence: {
    participants: ['Trace Collector', 'Redis', 'Span storage'],
    messages: [
      {from: 'Trace Collector', to: 'Redis', label: 'HGETALL trace:{id} · the assembled state', kind: 'sync'},
      {from: 'Redis', to: 'Trace Collector', label: '{count, missing, root, seen:…}', kind: 'reply'},
      {from: 'Trace Collector', to: 'Span storage', label: 'Write(trace) · deadline 2000 ms', kind: 'sync'},
      {from: 'Span storage', to: 'Trace Collector', label: 'OK · the write is durable', kind: 'reply'},
      {from: 'Trace Collector', to: 'Redis', label: 'DEL trace:{id} only after the confirmation', kind: 'sync'},
      {
        from: 'Span storage',
        to: 'Trace Collector',
        label: 'DEADLINE_EXCEEDED · retry within 3 attempts',
        kind: 'reply',
      },
      {
        from: 'Trace Collector',
        to: 'Trace Collector',
        label: 'exhausted → kept: true, the next cycle retries',
        kind: 'sync',
      },
      {from: 'Trace Collector', to: 'Redis', label: 'INVALID_ARGUMENT → HSET quarantine:{id} · TTL 7 d', kind: 'sync'},
    ],
  },
  hints: [
    'Bound the call before you bound the loop: the deadline is a per-attempt 2 s argument on the RPC (`timeout=`, `deadline:`, `context.WithTimeout`, `withDeadlineAfter`, `set_deadline`), and the loop is at most 3 attempts over the retryable statuses. Without a deadline a slow storage parks every flusher on a socket, and the retry loop multiplies that by the number of cycles.',
    'Deleting the assembly state is a claim about the world: "storage has this trace". It is only true after the RPC returns OK, so issue the delete there — never before the call, and never on the timeout path. A timeout leaves the trace in Redis, which is what makes the next cycle able to retry it.',
    'Group the failures by what they mean. `UNAVAILABLE` and `DEADLINE_EXCEEDED` are "try again"; `INVALID_ARGUMENT` is "this payload will never be accepted" — quarantine it with a long TTL so a human can inspect it and stop paying for a retry that cannot succeed.',
  ],
  checks: [
    {
      id: 'deadline',
      title: 'Every attempt carries a 2-second deadline',
      detail:
        'The write is issued with a 2 000 ms deadline on the call itself, so a slow storage cannot park the flusher. The draft calls storage with no deadline at all.',
      match: {
        python: {all: [/WRITE_DEADLINE_MS\s*=\s*2000/, /timeout=/]},
        typescript: {all: [/WRITE_DEADLINE_MS\s*=\s*2000/, /deadline:/]},
        go: {all: [/writeDeadlineMS\s*=\s*2000/, /context\.WithTimeout\(/]},
        scala: {all: [/WriteDeadlineMs\s*=\s*2000/, /withDeadlineAfter\(/]},
        cpp: {all: [/kWriteDeadlineMs\s*=\s*2000/, /set_deadline\(/]},
      },
    },
    {
      id: 'delete-after-confirm',
      title: 'Deletes the assembly state only after storage confirms',
      detail:
        'The delete is issued after the write returns OK, so a failed or timed-out write leaves the trace in Redis. The draft deletes before it calls storage, which is how a timeout loses the trace entirely.',
      match: {
        python: {order: [/stub\.Write\(/, /r\.delete\(/]},
        typescript: {order: [/writer\.Write\(/, /r\.del\(/]},
        go: {order: [/writer\.Write\(/, /rdb\.Del\(/]},
        scala: {order: [/\.write\(/, /jedis\.del\(/]},
        cpp: {order: [/stub->Write\(/, /redis->del\(/]},
      },
    },
    {
      id: 'timeout-keeps',
      title: 'A timeout keeps the trace for the next cycle',
      detail:
        'A `DEADLINE_EXCEEDED` that exhausts the attempts leaves the state in Redis and answers `kept: true`, so the trace survives a storage slowdown. The draft has already deleted it.',
      match: {
        python: {all: [/DEADLINE_EXCEEDED/, /"kept"/, /MAX_ATTEMPTS/]},
        typescript: {all: [/DEADLINE_EXCEEDED/, /kept/, /MAX_ATTEMPTS/]},
        go: {all: [/DeadlineExceeded/, /"kept"/, /maxAttempts/]},
        scala: {all: [/DEADLINE_EXCEEDED/, /"kept"/, /MaxAttempts/]},
        cpp: {all: [/DEADLINE_EXCEEDED/, /"kept"/, /kMaxAttempts/]},
      },
    },
    {
      id: 'quarantine-schema',
      title: 'A schema rejection quarantines the trace',
      detail:
        'An `INVALID_ARGUMENT` moves the payload to `quarantine:{trace_id}` under a long TTL and stops retrying it; the draft retries the rejection on every flush. The count of retryable attempts is also bounded.',
      match: {
        python: {all: [/INVALID_ARGUMENT/, /quarantine/, /QUARANTINE_TTL_S/, /RETRYABLE/]},
        typescript: {all: [/INVALID_ARGUMENT/, /quarantine/, /QUARANTINE_TTL_S/, /RETRYABLE/]},
        go: {all: [/InvalidArgument/, /quarantine/, /quarantineTTLS/, /retryable/]},
        scala: {all: [/INVALID_ARGUMENT/, /quarantine/, /QuarantineTtlS/, /Retryable/]},
        cpp: {all: [/INVALID_ARGUMENT/, /quarantine/, /kQuarantineTtlS/, /kRetryable|StatusCode::UNAVAILABLE/]},
      },
    },
    {
      id: 'bounded-retries',
      title: 'Retries only the statuses worth retrying, at most 3 times',
      detail:
        'Only `UNAVAILABLE` and `DEADLINE_EXCEEDED` are retried, and the loop stops after `MAX_ATTEMPTS` (3); everything else is answered immediately. The draft loops forever on any error.',
      match: {
        python: {all: [/MAX_ATTEMPTS\s*=\s*3/, /RETRYABLE/, /UNAVAILABLE/]},
        typescript: {all: [/MAX_ATTEMPTS\s*=\s*3/, /RETRYABLE/, /grpc\.status\.UNAVAILABLE/]},
        go: {all: [/maxAttempts\s*=\s*3/, /retryable/, /codes\.Unavailable/]},
        scala: {all: [/MaxAttempts\s*=\s*3/, /Retryable/, /Status\.Code\.UNAVAILABLE/]},
        cpp: {all: [/kMaxAttempts\s*=\s*3/, /grpc::StatusCode::UNAVAILABLE/, /grpc::StatusCode::DEADLINE_EXCEEDED/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import grpc
import redis

import storage_pb2
import storage_pb2_grpc

r = redis.Redis(host="redis", port=6379, decode_responses=True)

channel = grpc.insecure_channel("storage:9000")
stub = storage_pb2_grpc.TraceWriterStub(channel)


def flush(tenant: str, trace_id: str) -> dict:
    """Write the assembled trace to storage and report what happened to it."""
    # TODO: the draft deletes the assembly state before the write is confirmed, so a storage
    # timeout erases the only copy of the trace; it retries a schema rejection on every flush, and
    # it has no deadline at all. Delete only after the confirmation, quarantine a rejection, and
    # bound the retries to the statuses that are worth retrying.
    key = f"trace:{trace_id}"
    state = r.hgetall(key)
    r.delete(key)
    attempts = 0
    while True:
        attempts += 1
        try:
            stub.Write(
                storage_pb2.WriteRequest(
                    trace_id=trace_id,
                    tenant=tenant,
                    payload=json.dumps(state),
                )
            )
            return {"trace_id": trace_id, "flushed": True, "attempts": attempts}
        except grpc.RpcError:
            continue
`,
      solution: `import json

import grpc
import redis

import storage_pb2
import storage_pb2_grpc

r = redis.Redis(host="redis", port=6379, decode_responses=True)

WRITE_DEADLINE_MS = 2000
MAX_ATTEMPTS = 3
QUARANTINE_TTL_S = 7 * 24 * 60 * 60
RETRYABLE = (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED)

channel = grpc.insecure_channel("storage:9000")
stub = storage_pb2_grpc.TraceWriterStub(channel)


def flush(tenant: str, trace_id: str) -> dict:
    """Write the assembled trace to storage, keeping or quarantining it when that fails."""
    key = f"trace:{trace_id}"
    state = r.hgetall(key)
    if not state:
        return {"trace_id": trace_id, "flushed": False, "kept": False, "quarantined": False, "attempts": 0}

    request = storage_pb2.WriteRequest(trace_id=trace_id, tenant=tenant, payload=json.dumps(state))
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            stub.Write(request, timeout=WRITE_DEADLINE_MS / 1000)
        except grpc.RpcError as error:
            if error.code() == grpc.StatusCode.INVALID_ARGUMENT:
                # Storage will reject this payload on every attempt: keep it for inspection.
                quarantine = f"quarantine:{trace_id}"
                r.hset(quarantine, mapping={"payload": json.dumps(state), "reason": str(error.code())})
                r.expire(quarantine, QUARANTINE_TTL_S)
                r.delete(key)
                return {
                    "trace_id": trace_id,
                    "flushed": False,
                    "kept": False,
                    "quarantined": True,
                    "attempts": attempt,
                }
            if error.code() not in RETRYABLE:
                return {
                    "trace_id": trace_id,
                    "flushed": False,
                    "kept": True,
                    "quarantined": False,
                    "attempts": attempt,
                }
            continue
        # Storage confirmed the write: the assembly state is the duplicate copy now.
        r.delete(key)
        return {"trace_id": trace_id, "flushed": True, "kept": False, "quarantined": False, "attempts": attempt}

    return {
        "trace_id": trace_id,
        "flushed": False,
        "kept": True,
        "quarantined": False,
        "attempts": MAX_ATTEMPTS,
    }
`,
    },
    typescript: {
      starter: `/** Trace storage write: a model-generated draft that deletes first and never gives up. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import {Redis} from 'ioredis';

const r = new Redis('redis://redis:6379');

interface WriterClient {
  Write(request: {trace_id: string; tenant: string; payload: string}): Promise<unknown>;
}

const {storage} = grpc.loadPackageDefinition(protoLoader.loadSync('storage.proto')) as unknown as {
  storage: {TraceWriter: new (target: string, credentials: grpc.ChannelCredentials) => WriterClient};
};
const writer = new storage.TraceWriter('storage:9000', grpc.credentials.createInsecure());

export interface FlushResult {
  trace_id: string;
  flushed: boolean;
  kept: boolean;
  quarantined: boolean;
  attempts: number;
}

export async function flush(tenant: string, traceId: string): Promise<FlushResult> {
  // TODO: the draft deletes the assembly state before the write is confirmed, so a storage timeout
  // erases the only copy of the trace; it retries a schema rejection on every flush, and it has no
  // deadline at all. Delete only after the confirmation, quarantine a rejection, and bound the
  // retries to the statuses that are worth retrying.
  const key = \`trace:\${traceId}\`;
  const state = await r.hgetall(key);
  const payload = JSON.stringify(state);
  await r.del(key);
  let attempts = 0;
  for (;;) {
    attempts += 1;
    try {
      await writer.Write({trace_id: traceId, tenant, payload});
      return {trace_id: traceId, flushed: true, kept: false, quarantined: false, attempts};
    } catch {
      continue;
    }
  }
}
`,
      solution: `/** Trace storage write: 2 s deadline, delete only after the confirmation, quarantine a rejection. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import {Redis} from 'ioredis';

const r = new Redis('redis://redis:6379');

const WRITE_DEADLINE_MS = 2000;
const MAX_ATTEMPTS = 3;
const QUARANTINE_TTL_S = 7 * 24 * 60 * 60;
const RETRYABLE: Record<number, true> = {
  [grpc.status.UNAVAILABLE]: true,
  [grpc.status.DEADLINE_EXCEEDED]: true,
};

interface WriterClient {
  Write(
    request: {trace_id: string; tenant: string; payload: string},
    metadata: grpc.Metadata,
    options: {deadline: number},
  ): Promise<unknown>;
}

const {storage} = grpc.loadPackageDefinition(protoLoader.loadSync('storage.proto')) as unknown as {
  storage: {TraceWriter: new (target: string, credentials: grpc.ChannelCredentials) => WriterClient};
};
const writer = new storage.TraceWriter('storage:9000', grpc.credentials.createInsecure());

export interface FlushResult {
  trace_id: string;
  flushed: boolean;
  kept: boolean;
  quarantined: boolean;
  attempts: number;
}

export async function flush(tenant: string, traceId: string): Promise<FlushResult> {
  const key = \`trace:\${traceId}\`;
  const state = await r.hgetall(key);
  if (Object.keys(state).length === 0)
    return {trace_id: traceId, flushed: false, kept: false, quarantined: false, attempts: 0};

  const payload = JSON.stringify(state);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await writer.Write(
        {trace_id: traceId, tenant, payload},
        new grpc.Metadata(),
        {deadline: Date.now() + WRITE_DEADLINE_MS},
      );
    } catch (error) {
      const status = error as grpc.ServiceError;
      if (status.code === grpc.status.INVALID_ARGUMENT) {
        // Storage will reject this payload on every attempt: keep it for inspection.
        await r.hset(\`quarantine:\${traceId}\`, {payload, reason: String(status.code)});
        await r.expire(\`quarantine:\${traceId}\`, QUARANTINE_TTL_S);
        await r.del(key);
        return {trace_id: traceId, flushed: false, kept: false, quarantined: true, attempts: attempt};
      }
      if (RETRYABLE[status.code] !== true)
        return {trace_id: traceId, flushed: false, kept: true, quarantined: false, attempts: attempt};
      continue;
    }
    // Storage confirmed the write: the assembly state is the duplicate copy now.
    await r.del(key);
    return {trace_id: traceId, flushed: true, kept: false, quarantined: false, attempts: attempt};
  }
  return {trace_id: traceId, flushed: false, kept: true, quarantined: false, attempts: MAX_ATTEMPTS};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"
	pb "traced/storagepb"
)

var (
	rdb    *redis.Client
	writer pb.TraceWriterClient
)

func flush(ctx context.Context, tenant, traceID string) (map[string]any, error) {
	// TODO: the draft deletes the assembly state before the write is confirmed, so a storage
	// timeout erases the only copy of the trace; it retries a schema rejection on every flush, and
	// it has no deadline at all. Delete only after the confirmation, quarantine a rejection, and
	// bound the retries to the statuses that are worth retrying.
	key := "trace:" + traceID
	state, err := rdb.HGetAll(ctx, key).Result()
	if err != nil {
		return nil, err
	}
	payload, _ := json.Marshal(state)
	rdb.Del(ctx, key)
	request := &pb.WriteRequest{TraceId: traceID, Tenant: tenant, Payload: string(payload)}
	for attempts := 1; ; attempts++ {
		if _, err := writer.Write(ctx, request); err == nil {
			return map[string]any{"trace_id": traceID, "flushed": true, "attempts": attempts}, nil
		}
	}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "traced/storagepb"
)

const (
	writeDeadlineMS = 2000
	maxAttempts     = 3
	quarantineTTLS  = 7 * 24 * 60 * 60
)

var retryable = map[codes.Code]bool{codes.Unavailable: true, codes.DeadlineExceeded: true}

var (
	rdb    *redis.Client
	writer pb.TraceWriterClient
)

func flush(ctx context.Context, tenant, traceID string) (map[string]any, error) {
	key := "trace:" + traceID
	state, err := rdb.HGetAll(ctx, key).Result()
	if err != nil {
		return nil, err
	}
	if len(state) == 0 {
		return map[string]any{
			"trace_id": traceID, "flushed": false, "kept": false, "quarantined": false, "attempts": 0,
		}, nil
	}
	payload, _ := json.Marshal(state)
	request := &pb.WriteRequest{TraceId: traceID, Tenant: tenant, Payload: string(payload)}

	for attempt := 1; attempt <= maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, writeDeadlineMS*time.Millisecond)
		_, err := writer.Write(callCtx, request)
		cancel()
		if err == nil {
			// Storage confirmed the write: the assembly state is the duplicate copy now.
			rdb.Del(ctx, key)
			return map[string]any{
				"trace_id": traceID, "flushed": true, "kept": false, "quarantined": false, "attempts": attempt,
			}, nil
		}
		if status.Code(err) == codes.InvalidArgument {
			// Storage will reject this payload on every attempt: keep it for inspection.
			rdb.HSet(ctx, "quarantine:"+traceID, "payload", string(payload), "reason", err.Error())
			rdb.Expire(ctx, "quarantine:"+traceID, quarantineTTLS*time.Second)
			rdb.Del(ctx, key)
			return map[string]any{
				"trace_id": traceID, "flushed": false, "kept": false, "quarantined": true, "attempts": attempt,
			}, nil
		}
		if !retryable[status.Code(err)] {
			return map[string]any{
				"trace_id": traceID, "flushed": false, "kept": true, "quarantined": false, "attempts": attempt,
			}, nil
		}
	}

	return map[string]any{
		"trace_id": traceID, "flushed": false, "kept": true, "quarantined": false, "attempts": maxAttempts,
	}, nil
}
`,
    },
    scala: {
      starter: `import io.grpc.ManagedChannelBuilder
import redis.clients.jedis.Jedis

import scala.jdk.CollectionConverters._

object TraceWriterClient {
  val jedis = new Jedis("redis", 6379)
  val stub = StorageGrpc.blockingStub(ManagedChannelBuilder.forAddress("storage", 9000).usePlaintext().build())

  def flush(tenant: String, traceId: String): Map[String, Any] = {
    // TODO: the draft deletes the assembly state before the write is confirmed, so a storage
    // timeout erases the only copy of the trace; it retries a schema rejection on every flush, and
    // it has no deadline at all. Delete only after the confirmation, quarantine a rejection, and
    // bound the retries to the statuses that are worth retrying.
    val key = s"trace:$traceId"
    val state = jedis.hgetAll(key).asScala.toMap
    val payload = state.map { case (field, value) => s""""$field":"$value"""" }.mkString("{", ",", "}")
    jedis.del(key)
    var attempts = 0
    var done = false
    while (!done) {
      attempts += 1
      try {
        stub.write(WriteRequest(traceId = traceId, tenant = tenant, payload = payload))
        done = true
      } catch {
        case _: io.grpc.StatusRuntimeException => ()
      }
    }
    Map("trace_id" -> traceId, "flushed" -> true, "attempts" -> attempts)
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}
import redis.clients.jedis.Jedis

import scala.jdk.CollectionConverters._

object TraceWriterClient {
  val WriteDeadlineMs = 2000L
  val MaxAttempts = 3
  val QuarantineTtlS = 7L * 24 * 60 * 60
  val Retryable = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)

  val jedis = new Jedis("redis", 6379)
  val stub = StorageGrpc.blockingStub(ManagedChannelBuilder.forAddress("storage", 9000).usePlaintext().build())

  def flush(tenant: String, traceId: String): Map[String, Any] = {
    val key = s"trace:$traceId"
    val state = jedis.hgetAll(key).asScala.toMap
    if (state.isEmpty) {
      Map("trace_id" -> traceId, "flushed" -> false, "kept" -> false, "quarantined" -> false, "attempts" -> 0)
    } else {
      val payload = state.map { case (field, value) => s""""$field":"$value"""" }.mkString("{", ",", "}")
      val request = WriteRequest(traceId = traceId, tenant = tenant, payload = payload)
      var attempt = 1
      var result = Map[String, Any]()
      var done = false
      while (attempt <= MaxAttempts && !done) {
        try {
          stub
            .withDeadlineAfter(WriteDeadlineMs, TimeUnit.MILLISECONDS)
            .write(request)
          // Storage confirmed the write: the assembly state is the duplicate copy now.
          jedis.del(key)
          result =
            Map("trace_id" -> traceId, "flushed" -> true, "kept" -> false, "quarantined" -> false, "attempts" -> attempt)
          done = true
        } catch {
          case exc: StatusRuntimeException =>
            val code = exc.getStatus.getCode
            if (code == Status.Code.INVALID_ARGUMENT) {
              // Storage will reject this payload on every attempt: keep it for inspection.
              val quarantine = s"quarantine:$traceId"
              jedis.hset(quarantine, Map("payload" -> payload, "reason" -> code.toString).asJava)
              jedis.expire(quarantine, QuarantineTtlS)
              jedis.del(key)
              result = Map(
                "trace_id" -> traceId,
                "flushed" -> false,
                "kept" -> false,
                "quarantined" -> true,
                "attempts" -> attempt
              )
              done = true
            } else if (!Retryable.contains(code)) {
              result = Map(
                "trace_id" -> traceId,
                "flushed" -> false,
                "kept" -> true,
                "quarantined" -> false,
                "attempts" -> attempt
              )
              done = true
            } else {
              attempt += 1
            }
        }
      }
      if (!done) {
        result =
          Map("trace_id" -> traceId, "flushed" -> false, "kept" -> true, "quarantined" -> false, "attempts" -> MaxAttempts)
      }
      result
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include "storage.grpc.pb.h"

#include <memory>
#include <string>

using json = nlohmann::json;

std::unique_ptr<sw::redis::Redis> redis;
std::unique_ptr<Storage::TraceWriter::Stub> stub;

json flush(const std::string& tenant, const std::string& traceId) {
  // TODO: the draft deletes the assembly state before the write is confirmed, so a storage timeout
  // erases the only copy of the trace; it retries a schema rejection on every flush, and it has no
  // deadline at all. Delete only after the confirmation, quarantine a rejection, and bound the
  // retries to the statuses that are worth retrying.
  const std::string key = "trace:" + traceId;
  std::unordered_map<std::string, std::string> state;
  redis->hgetall(key, std::inserter(state, state.end()));
  const std::string payload = json(state).dump();
  redis->del(key);
  for (int attempt = 1; ; attempt++) {
    grpc::ClientContext ctx;
    WriteRequest request;
    request.set_trace_id(traceId);
    request.set_tenant(tenant);
    request.set_payload(payload);
    WriteReply reply;
    if (stub->Write(&ctx, request, &reply).ok()) {
      return json{{"trace_id", traceId}, {"flushed", true}, {"attempts", attempt}};
    }
  }
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include "storage.grpc.pb.h"

#include <chrono>
#include <memory>
#include <string>
#include <unordered_map>

using json = nlohmann::json;

constexpr int kWriteDeadlineMs = 2000;
constexpr int kMaxAttempts = 3;
constexpr long long kQuarantineTtlS = 7LL * 24 * 60 * 60;

std::unique_ptr<sw::redis::Redis> redis;
std::unique_ptr<Storage::TraceWriter::Stub> stub;

bool retryable(const grpc::StatusCode code) {
  return code == grpc::StatusCode::UNAVAILABLE || code == grpc::StatusCode::DEADLINE_EXCEEDED;
}

json flush(const std::string& tenant, const std::string& traceId) {
  const std::string key = "trace:" + traceId;
  std::unordered_map<std::string, std::string> state;
  redis->hgetall(key, std::inserter(state, state.end()));
  if (state.empty()) {
    return json{{"trace_id", traceId},
                {"flushed", false},
                {"kept", false},
                {"quarantined", false},
                {"attempts", 0}};
  }
  const std::string payload = json(state).dump();

  for (int attempt = 1; attempt <= kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kWriteDeadlineMs));
    WriteRequest request;
    request.set_trace_id(traceId);
    request.set_tenant(tenant);
    request.set_payload(payload);
    WriteReply reply;
    const grpc::Status status = stub->Write(&ctx, request, &reply);
    if (status.ok()) {
      // Storage confirmed the write: the assembly state is the duplicate copy now.
      redis->del(key);
      return json{{"trace_id", traceId},
                  {"flushed", true},
                  {"kept", false},
                  {"quarantined", false},
                  {"attempts", attempt}};
    }
    if (status.error_code() == grpc::StatusCode::INVALID_ARGUMENT) {
      // Storage will reject this payload on every attempt: keep it for inspection.
      const std::string quarantine = "quarantine:" + traceId;
      redis->hset(quarantine, "payload", payload);
      redis->hset(quarantine, "reason", status.error_message());
      redis->expire(quarantine, kQuarantineTtlS);
      redis->del(key);
      return json{{"trace_id", traceId},
                  {"flushed", false},
                  {"kept", false},
                  {"quarantined", true},
                  {"attempts", attempt}};
    }
    if (!retryable(status.error_code())) {
      return json{{"trace_id", traceId},
                  {"flushed", false},
                  {"kept", true},
                  {"quarantined", false},
                  {"attempts", attempt}};
    }
  }

  return json{{"trace_id", traceId},
              {"flushed", false},
              {"kept", true},
              {"quarantined", false},
              {"attempts", kMaxAttempts}};
}
`,
    },
  },
  debrief: `The interviewer is asking where the boundary of a durable write sits. "Storage has the trace" is only true once the RPC has returned OK, so the delete is the statement that the copy is redundant — issue it any earlier and a timeout turns a retryable incident into data loss. That is the whole bug behind a suspiciously fast trace: the collector deleted its state, storage never received it, and the reader believed an empty trace rather than a missing one. Around the ordering sit the two policies a generated client gets wrong most often. A deadline per attempt is what stops one slow storage from parking every flusher; a bounded retry set is what stops a permanent answer from being asked again forever; and quarantine is the only honest place for a payload the schema has rejected — visible to a human, out of the retry loop, and out of the live trace store. Real collectors add jittered backoff between attempts, a write-ahead spool for slow storage, and per-status metrics so "kept" is an alarm rather than a number in a return value.`,
};
