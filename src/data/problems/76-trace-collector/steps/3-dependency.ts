import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Storage writes with a deadline that keep the trace',
  concept: 'grpc',
  guides: ['deadlines-and-retries'],
  file: 'client',
  focus: ['collector', 'storage', 'quarantine'],
  task: `## Task

**Starting point.** The starter is the storage half of the assembly cycle: \`flush_trace(trace_id)\`
loads the trace (\`assembly.load_trace\`), deletes its Redis state (\`assembly.delete_trace\`), sends
\`TraceWriter.Write\` to span storage at \`storage:9000\` and, on any error, sleeps a second and sends
it again until it succeeds. It answers \`{flushed, kept, quarantined, attempts}\`. Storage is fast in
the demo, so it looks right; it hides four flaws.

\`\`\`proto
service TraceWriter { rpc Write(WriteRequest) returns (WriteReply); }  // INVALID_ARGUMENT: refused by the schema
\`\`\`

**Failure mode the checks target.** A storage timeout erases the only copy of a trace, a stalled
storage holds the flusher for as long as it stalls, an outage turns every flusher into a retry
loop, and a trace storage will never accept is sent again every second.

- Every attempt carries a 2-second deadline (\`WRITE_DEADLINE_S\`).
- The assembly state is deleted only after \`Write\` answered OK.
- At most \`MAX_ATTEMPTS\` = 3 attempts, and only \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` are
  retried. When they run out, or another status answers, the trace stays in Redis and the answer is
  \`kept: true\`, for the next cycle.
- \`INVALID_ARGUMENT\` is not retried: \`assembly.quarantine(trace, details)\` parks the trace for 7
  days and the answer is \`quarantined: true\`.`,
  sequence: {
    participants: ['Trace Collector', 'Redis', 'Span storage'],
    messages: [
      {from: 'Trace Collector', to: 'Redis', label: 'load_trace(id)', kind: 'sync'},
      {from: 'Trace Collector', to: 'Span storage', label: 'Write · deadline 2 s · attempt 1..3', kind: 'sync'},
      {from: 'Span storage', to: 'Trace Collector', label: 'OK', kind: 'reply'},
      {from: 'Trace Collector', to: 'Redis', label: 'delete_trace(id) only now', kind: 'sync'},
      {
        from: 'Span storage',
        to: 'Trace Collector',
        label: 'UNAVAILABLE ×3 → kept: true, the next cycle retries',
        kind: 'reply',
      },
      {
        from: 'Span storage',
        to: 'Trace Collector',
        label: 'INVALID_ARGUMENT → quarantine(trace) · 7 days',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every Write carries a 2-second deadline',
      detail:
        'Each attempt is made with its own 2-second deadline on the call, and a timed-out attempt is retried, so a stalled storage costs the flusher three attempts of two seconds each; the starter waits for as long as storage takes.',
      match: {
        python: {all: [/\.Write\([\s\S]{0,200}?timeout\s*=/]},
        typescript: {all: [/\.Write\([\s\S]{0,300}?deadline:/]},
        go: {all: [/context\.WithTimeout\(/]},
        cpp: {all: [/set_deadline\(/]},
      },
    },
    {
      id: 'delete-after-confirm',
      title: 'Deletes the assembly state only after storage confirmed',
      detail:
        '`delete_trace`/`deleteTrace` runs after `Write` answered OK, so a failed or timed-out write leaves the trace in Redis; the starter deletes it before the call.',
      match: {
        python: {order: [/\.Write\(/, /assembly\.delete_trace\(/]},
        typescript: {order: [/\.Write\(/, /deleteTrace\(/]},
        go: {order: [/storage\.Write\(/, /assembly\.DeleteTrace\(/]},
        cpp: {order: [/->Write\(/, /assembly::deleteTrace\(/]},
      },
    },
    {
      id: 'bounded-retries',
      title: 'At most 3 attempts, for UNAVAILABLE and DEADLINE_EXCEEDED only',
      detail:
        'The loop is bounded by `MAX_ATTEMPTS` (3) and retries only the transient codes; when the attempts run out, or another status such as `PERMISSION_DENIED` or `INTERNAL` answers after one call, the trace is kept for the next cycle. The starter loops until storage answers.',
      match: {
        python: {all: [/MAX_ATTEMPTS\s*=\s*3\b/, /StatusCode\.UNAVAILABLE/], none: [/while True/]},
        typescript: {
          all: [/MAX_ATTEMPTS\s*=\s*3\b/, /status\.UNAVAILABLE/],
          none: [/while\s*\(true\)|for\s*\([^;\n]*;\s*;/],
        },
        go: {all: [/maxAttempts\s*=\s*3\b/, /codes\.Unavailable/], none: [/for \{|for [^;\n]*;\s*;/]},
        cpp: {
          all: [/kMaxAttempts\s*=\s*3\b/, /StatusCode::UNAVAILABLE/],
          none: [/for\s*\([^;\n]*;\s*;|while\s*\(true\)/],
        },
      },
    },
    {
      id: 'quarantine',
      title: 'A schema rejection is quarantined, not retried',
      detail:
        "An `INVALID_ARGUMENT` cannot succeed by repeating: the trace goes to `quarantine(trace, details)`, with storage's details as the reason, after one call and the answer says so.",
      match: {
        python: {all: [/StatusCode\.INVALID_ARGUMENT/, /assembly\.quarantine\(/]},
        typescript: {all: [/status\.INVALID_ARGUMENT/, /quarantine\(/]},
        go: {all: [/codes\.InvalidArgument/, /assembly\.Quarantine\(/]},
        cpp: {all: [/StatusCode::INVALID_ARGUMENT/, /assembly::quarantine\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import grpc

import trace_collector_pb2 as pb
import trace_collector_pb2_grpc
from traces import assembly  # load_trace, delete_trace, quarantine

storage = trace_collector_pb2_grpc.TraceWriterStub(grpc.insecure_channel("storage:9000"))


def write_request(trace: dict) -> pb.WriteRequest:
    spans = [
        pb.Span(span_id=s["span_id"], parent_span_id=s["parent_span_id"], service=s["service"], start_ms=s["start_ms"], duration_ms=s["duration_ms"])
        for s in trace["spans"]
    ]
    return pb.WriteRequest(tenant=trace["owner"], trace_id=trace["trace_id"], spans=spans, missing=trace["missing"])


def flush_trace(trace_id: str) -> dict:
    """Write the assembled trace to span storage; {flushed, kept, quarantined, attempts}."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    trace = assembly.load_trace(trace_id)
    if trace is None:
        return {"flushed": False, "kept": False, "quarantined": False, "attempts": 0}
    assembly.delete_trace(trace_id)  # the payload is in hand
    attempts = 0
    while True:
        attempts += 1
        try:
            storage.Write(write_request(trace))
            return {"flushed": True, "kept": False, "quarantined": False, "attempts": attempts}
        except grpc.RpcError:
            time.sleep(1.0)  # storage is having a moment: try again
`,
      solution: `import grpc

import trace_collector_pb2 as pb
import trace_collector_pb2_grpc
from traces import assembly  # load_trace, delete_trace, quarantine

WRITE_DEADLINE_S = 2.0
MAX_ATTEMPTS = 3
RETRYABLE = (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED)

storage = trace_collector_pb2_grpc.TraceWriterStub(grpc.insecure_channel("storage:9000"))


def write_request(trace: dict) -> pb.WriteRequest:
    spans = [
        pb.Span(span_id=s["span_id"], parent_span_id=s["parent_span_id"], service=s["service"], start_ms=s["start_ms"], duration_ms=s["duration_ms"])
        for s in trace["spans"]
    ]
    return pb.WriteRequest(tenant=trace["owner"], trace_id=trace["trace_id"], spans=spans, missing=trace["missing"])


def flush_trace(trace_id: str) -> dict:
    """Write the assembled trace to span storage; {flushed, kept, quarantined, attempts}."""
    trace = assembly.load_trace(trace_id)
    if trace is None:
        return {"flushed": False, "kept": False, "quarantined": False, "attempts": 0}
    request = write_request(trace)
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            storage.Write(request, timeout=WRITE_DEADLINE_S)
        except grpc.RpcError as exc:
            if exc.code() == grpc.StatusCode.INVALID_ARGUMENT:
                assembly.quarantine(trace, exc.details())  # repeating it cannot succeed
                return {"flushed": False, "kept": False, "quarantined": True, "attempts": attempt}
            if exc.code() in RETRYABLE and attempt < MAX_ATTEMPTS:
                continue
            # Out of attempts, or a status a retry will not change: the state stays for the next cycle.
            return {"flushed": False, "kept": True, "quarantined": False, "attempts": attempt}
        assembly.delete_trace(trace_id)  # storage confirmed the write
        return {"flushed": True, "kept": False, "quarantined": False, "attempts": attempt}
    return {"flushed": False, "kept": True, "quarantined": False, "attempts": MAX_ATTEMPTS}
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {type Trace, deleteTrace, loadTrace, quarantine} from 'traces/assembly';

interface WriteRequest {
  tenant: string;
  trace_id: string;
  spans: {span_id: string; parent_span_id: string; service: string; start_ms: number; duration_ms: number}[];
  missing: number;
}

export interface FlushResult {
  flushed: boolean;
  kept: boolean;
  quarantined: boolean;
  attempts: number;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('trace_collector.proto')) as unknown as {
  tracestore: {TraceWriter: grpc.ServiceClientConstructor};
};
const storage = new pkg.tracestore.TraceWriter('storage:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Write(request: WriteRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{stored: number}>;
};

export function writeRequest(trace: Trace): WriteRequest {
  const spans = trace.spans.map(({span_id, parent_span_id, service, start_ms, duration_ms}) => ({span_id, parent_span_id, service, start_ms, duration_ms}));
  return {tenant: trace.owner, trace_id: trace.trace_id, spans, missing: trace.missing};
}

/** Write the assembled trace to span storage. */
export async function flushTrace(traceId: string): Promise<FlushResult> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const trace = await loadTrace(traceId);
  if (trace === null) return {flushed: false, kept: false, quarantined: false, attempts: 0};
  await deleteTrace(traceId); // the payload is in hand
  for (let attempts = 1; ; attempts++) {
    try {
      await storage.Write(writeRequest(trace), new grpc.Metadata(), {});
      return {flushed: true, kept: false, quarantined: false, attempts};
    } catch {
      const {promise, resolve} = Promise.withResolvers<void>();
      setTimeout(resolve, 1000); // storage is having a moment: try again
      await promise;
    }
  }
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {type Trace, deleteTrace, loadTrace, quarantine} from 'traces/assembly';

export const WRITE_DEADLINE_MS = 2000;
export const MAX_ATTEMPTS = 3;
const RETRYABLE = new Set([grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED]);

interface WriteRequest {
  tenant: string;
  trace_id: string;
  spans: {span_id: string; parent_span_id: string; service: string; start_ms: number; duration_ms: number}[];
  missing: number;
}

export interface FlushResult {
  flushed: boolean;
  kept: boolean;
  quarantined: boolean;
  attempts: number;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('trace_collector.proto')) as unknown as {
  tracestore: {TraceWriter: grpc.ServiceClientConstructor};
};
const storage = new pkg.tracestore.TraceWriter('storage:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Write(request: WriteRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{stored: number}>;
};

export function writeRequest(trace: Trace): WriteRequest {
  const spans = trace.spans.map(({span_id, parent_span_id, service, start_ms, duration_ms}) => ({span_id, parent_span_id, service, start_ms, duration_ms}));
  return {tenant: trace.owner, trace_id: trace.trace_id, spans, missing: trace.missing};
}

/** Write the assembled trace to span storage. */
export async function flushTrace(traceId: string): Promise<FlushResult> {
  const trace = await loadTrace(traceId);
  if (trace === null) return {flushed: false, kept: false, quarantined: false, attempts: 0};
  const request = writeRequest(trace);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await storage.Write(request, new grpc.Metadata(), {deadline: Date.now() + WRITE_DEADLINE_MS});
    } catch (e) {
      const {code, details} = e as grpc.ServiceError;
      if (code === grpc.status.INVALID_ARGUMENT) {
        await quarantine(trace, details); // repeating it cannot succeed
        return {flushed: false, kept: false, quarantined: true, attempts: attempt};
      }
      if (RETRYABLE.has(code) && attempt < MAX_ATTEMPTS) continue;
      // Out of attempts, or a status a retry will not change: the state stays for the next cycle.
      return {flushed: false, kept: true, quarantined: false, attempts: attempt};
    }
    await deleteTrace(traceId); // storage confirmed the write
    return {flushed: true, kept: false, quarantined: false, attempts: attempt};
  }
  return {flushed: false, kept: true, quarantined: false, attempts: MAX_ATTEMPTS};
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

	"traces/assembly" // assembly.LoadTrace, DeleteTrace, Quarantine
	pb "traces/gen/trace_collector"
)

var (
	storageConn, _ = grpc.NewClient("storage:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	storage        = pb.NewTraceWriterClient(storageConn)
)

type flushResult struct {
	Flushed     bool \`json:"flushed"\`
	Kept        bool \`json:"kept"\`
	Quarantined bool \`json:"quarantined"\`
	Attempts    int  \`json:"attempts"\`
}

func writeRequest(trace *assembly.Trace) *pb.WriteRequest {
	spans := make([]*pb.Span, 0, len(trace.Spans))
	for _, s := range trace.Spans {
		spans = append(spans, &pb.Span{SpanId: s.SpanID, ParentSpanId: s.ParentSpanID, Service: s.Service, StartMs: s.StartMs, DurationMs: s.DurationMs})
	}
	return &pb.WriteRequest{Tenant: trace.Owner, TraceId: trace.TraceID, Spans: spans, Missing: trace.Missing}
}

// flushTrace writes the assembled trace to span storage.
func flushTrace(ctx context.Context, traceID string) (flushResult, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	trace, err := assembly.LoadTrace(ctx, traceID)
	if err != nil || trace == nil {
		return flushResult{}, err
	}
	if err := assembly.DeleteTrace(ctx, traceID); err != nil { // the payload is in hand
		return flushResult{}, err
	}
	for attempt := 1; ; attempt++ {
		if _, err := storage.Write(ctx, writeRequest(trace)); err == nil {
			return flushResult{Flushed: true, Attempts: attempt}, nil
		}
		time.Sleep(time.Second) // storage is having a moment: try again
	}
}
`,
      solution: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"traces/assembly" // assembly.LoadTrace, DeleteTrace, Quarantine
	pb "traces/gen/trace_collector"
)

const (
	writeDeadline = 2 * time.Second
	maxAttempts   = 3
)

var (
	storageConn, _ = grpc.NewClient("storage:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	storage        = pb.NewTraceWriterClient(storageConn)
)

type flushResult struct {
	Flushed     bool \`json:"flushed"\`
	Kept        bool \`json:"kept"\`
	Quarantined bool \`json:"quarantined"\`
	Attempts    int  \`json:"attempts"\`
}

func writeRequest(trace *assembly.Trace) *pb.WriteRequest {
	spans := make([]*pb.Span, 0, len(trace.Spans))
	for _, s := range trace.Spans {
		spans = append(spans, &pb.Span{SpanId: s.SpanID, ParentSpanId: s.ParentSpanID, Service: s.Service, StartMs: s.StartMs, DurationMs: s.DurationMs})
	}
	return &pb.WriteRequest{Tenant: trace.Owner, TraceId: trace.TraceID, Spans: spans, Missing: trace.Missing}
}

// flushTrace writes the assembled trace to span storage.
func flushTrace(ctx context.Context, traceID string) (flushResult, error) {
	trace, err := assembly.LoadTrace(ctx, traceID)
	if err != nil || trace == nil {
		return flushResult{}, err
	}
	request := writeRequest(trace)
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, writeDeadline)
		_, err := storage.Write(callCtx, request)
		cancel()
		if err == nil {
			// Storage confirmed the write: only now does the assembly state go.
			return flushResult{Flushed: true, Attempts: attempt}, assembly.DeleteTrace(ctx, traceID)
		}
		switch status.Code(err) {
		case codes.InvalidArgument:
			// Repeating it cannot succeed.
			return flushResult{Quarantined: true, Attempts: attempt}, assembly.Quarantine(ctx, trace, status.Convert(err).Message())
		case codes.Unavailable, codes.DeadlineExceeded:
			if attempt < maxAttempts {
				continue
			}
		}
		// Out of attempts, or a status a retry will not change: the state stays for the next cycle.
		return flushResult{Kept: true, Attempts: attempt}, nil
	}
	return flushResult{Kept: true, Attempts: maxAttempts}, nil
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <string>
#include <thread>

#include "trace_collector.grpc.pb.h"
#include "traces/assembly.h"  // assembly::loadTrace, deleteTrace, quarantine

struct FlushResult {
  bool flushed = false;
  bool kept = false;
  bool quarantined = false;
  int attempts = 0;
};

auto storage = tracestore::TraceWriter::NewStub(grpc::CreateChannel("storage:9000", grpc::InsecureChannelCredentials()));

tracestore::WriteRequest writeRequest(const assembly::Trace& trace) {
  tracestore::WriteRequest request;
  request.set_tenant(trace.owner);
  request.set_trace_id(trace.trace_id);
  request.set_missing(trace.missing);
  for (const assembly::Span& s : trace.spans) {
    tracestore::Span* span = request.add_spans();
    span->set_span_id(s.span_id);
    span->set_parent_span_id(s.parent_span_id);
    span->set_service(s.service);
    span->set_start_ms(s.start_ms);
    span->set_duration_ms(s.duration_ms);
  }
  return request;
}

// Write the assembled trace to span storage.
FlushResult flushTrace(const std::string& trace_id) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const auto trace = assembly::loadTrace(trace_id);
  if (!trace) return FlushResult{};
  assembly::deleteTrace(trace_id);  // the payload is in hand
  for (int attempt = 1;; attempt++) {
    grpc::ClientContext ctx;
    tracestore::WriteReply reply;
    if (storage->Write(&ctx, writeRequest(*trace), &reply).ok()) return FlushResult{true, false, false, attempt};
    std::this_thread::sleep_for(std::chrono::seconds{1});  // storage is having a moment: try again
  }
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <string>

#include "trace_collector.grpc.pb.h"
#include "traces/assembly.h"  // assembly::loadTrace, deleteTrace, quarantine

constexpr std::chrono::milliseconds kWriteDeadline{2000};
constexpr int kMaxAttempts = 3;

struct FlushResult {
  bool flushed = false;
  bool kept = false;
  bool quarantined = false;
  int attempts = 0;
};

auto storage = tracestore::TraceWriter::NewStub(grpc::CreateChannel("storage:9000", grpc::InsecureChannelCredentials()));

tracestore::WriteRequest writeRequest(const assembly::Trace& trace) {
  tracestore::WriteRequest request;
  request.set_tenant(trace.owner);
  request.set_trace_id(trace.trace_id);
  request.set_missing(trace.missing);
  for (const assembly::Span& s : trace.spans) {
    tracestore::Span* span = request.add_spans();
    span->set_span_id(s.span_id);
    span->set_parent_span_id(s.parent_span_id);
    span->set_service(s.service);
    span->set_start_ms(s.start_ms);
    span->set_duration_ms(s.duration_ms);
  }
  return request;
}

// Write the assembled trace to span storage.
FlushResult flushTrace(const std::string& trace_id) {
  const auto trace = assembly::loadTrace(trace_id);
  if (!trace) return FlushResult{};
  const tracestore::WriteRequest request = writeRequest(*trace);
  for (int attempt = 1; attempt <= kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kWriteDeadline);
    tracestore::WriteReply reply;
    const grpc::Status status = storage->Write(&ctx, request, &reply);
    if (status.ok()) {
      assembly::deleteTrace(trace_id);  // storage confirmed the write
      return FlushResult{true, false, false, attempt};
    }
    if (status.error_code() == grpc::StatusCode::INVALID_ARGUMENT) {
      assembly::quarantine(*trace, status.error_message());  // repeating it cannot succeed
      return FlushResult{false, false, true, attempt};
    }
    const bool retryable = status.error_code() == grpc::StatusCode::UNAVAILABLE || status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED;
    // Out of attempts, or a status a retry will not change: the state stays for the next cycle.
    if (!retryable || attempt == kMaxAttempts) return FlushResult{false, true, false, attempt};
  }
  return FlushResult{false, true, false, kMaxAttempts};
}
`,
    },
  },
  harness: {
    python: `import grpc

import trace_collector_pb2 as pb
import trace_collector_pb2_grpc
from traces import assembly

TRACE = "4bf92f3577b34da6a3ce929d0e0e4736"
KEY = f"trace:{TRACE}"
ROOT = "00f067aa0ba902b7"
CHILD = "00f067aa0ba902b8"


class Storage(trace_collector_pb2_grpc.TraceWriterServicer):
    """Span storage: stores every trace whose spans all name a service; records whether the assembly state still existed when each write reached it."""

    def __init__(self, ctx):
        self.ctx = ctx
        self.state_present = []
        self.stored = []

    def Write(self, request, context):
        self.state_present.append(self.ctx.redis.exists(f"trace:{request.trace_id}") == 1)
        if any(not s.service for s in request.spans):
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, "span without a service: the span schema requires one")
        self.stored.append(request)
        return pb.WriteReply(stored=len(request.spans))


def _client(ctx, child_service="payments"):
    storage = Storage(ctx)
    ctx.grpc.serve(trace_collector_pb2_grpc.add_TraceWriterServicer_to_server, storage)
    assembly.insert_span("acme", {"trace_id": TRACE, "span_id": ROOT, "parent_span_id": "", "service": "checkout", "start_ms": 1712345678901, "duration_ms": 412})
    assembly.insert_span("acme", {"trace_id": TRACE, "span_id": CHILD, "parent_span_id": ROOT, "service": child_service, "start_ms": 1712345678950, "duration_ms": 120})
    return ctx.load("client"), storage


def _flush(ctx, m, why):
    result = ctx.drain(m.flush_trace, TRACE)
    assert result is not None, f"{why}: flush_trace never returned, it kept retrying until the runtime stopped it"
    return result


def check_deadline(ctx):
    m, storage = _client(ctx)
    ctx.grpc.set_latency("Write", 10.0)
    result = ctx.drain(m.flush_trace, TRACE)
    calls = ctx.grpc.calls_to("Write")
    assert calls, "flush_trace never called Write"
    for call in calls:
        assert call.timeout is not None, "a Write carries no deadline: a storage that stalls holds the flusher for as long as it stalls"
        assert 1.5 <= call.timeout <= 2.5, f"a Write carries a {call.timeout} s deadline, expected 2 s"
    assert result is not None, "with storage stalled flush_trace never returned"
    assert len(calls) == 3, f"with storage stalled flush_trace called Write {len(calls)} times, expected MAX_ATTEMPTS = 3: DEADLINE_EXCEEDED is retried, and every attempt gets its own 2 s"
    assert result["kept"] is True and result["flushed"] is False, f"every write timed out, so the trace must be kept for the next cycle; flush_trace answered {result}"
    assert ctx.redis.exists(KEY) == 1, "the writes timed out and the trace is gone from Redis"
    ctx.grpc.set_latency("Write", 0.0)
    result = _flush(ctx, m, "with storage answering again")
    assert result["flushed"] is True, f"once storage answers, the kept trace must be written; flush_trace answered {result}"


def check_delete_after_confirm(ctx):
    m, storage = _client(ctx)
    result = _flush(ctx, m, "with storage healthy")
    assert storage.state_present, "flush_trace never reached storage"
    assert storage.state_present[0], "the trace's Redis state was already deleted when the Write reached storage: had that write timed out, the only copy of the trace would be gone. Delete it after Write answered OK"
    assert result["flushed"] is True and result["attempts"] == 1, f"a healthy storage takes the write at once; flush_trace answered {result}"
    request = storage.stored[0]
    assert request.tenant == "acme" and [s.span_id for s in request.spans] == [ROOT, CHILD], f"the write must carry the tenant and both spans, storage got tenant {request.tenant!r} and spans {[s.span_id for s in request.spans]}"
    assert ctx.redis.exists(KEY) == 0, "storage confirmed the write and the assembly state is still in Redis"


def check_bounded_retries(ctx):
    m, storage = _client(ctx)
    ctx.grpc.fail("Write", grpc.StatusCode.UNAVAILABLE, times=3)
    result = _flush(ctx, m, "with storage down")
    calls = len(ctx.grpc.calls_to("Write"))
    assert calls == 3, f"with storage down flush_trace called Write {calls} times, expected MAX_ATTEMPTS = 3"
    assert result == {"flushed": False, "kept": True, "quarantined": False, "attempts": 3}, f"three UNAVAILABLE answers must end in kept, attempts 3; flush_trace answered {result}"
    assert ctx.redis.exists(KEY) == 1, "storage never took the trace and it is gone from Redis: it must stay for the next cycle"
    for code in (grpc.StatusCode.PERMISSION_DENIED, grpc.StatusCode.INTERNAL, grpc.StatusCode.FAILED_PRECONDITION):
        before = len(ctx.grpc.calls_to("Write"))
        ctx.grpc.fail("Write", code, times=1)
        result = _flush(ctx, m, f"with storage answering {code.name}")
        calls = len(ctx.grpc.calls_to("Write")) - before
        assert calls == 1, f"storage answered {code.name} and flush_trace called Write {calls} times: only UNAVAILABLE and DEADLINE_EXCEEDED are retried"
        assert result == {"flushed": False, "kept": True, "quarantined": False, "attempts": 1}, f"{code.name} is neither retried nor a schema rejection: the trace is kept for the next cycle, attempts 1; flush_trace answered {result}"
        assert ctx.redis.exists(KEY) == 1 and ctx.redis.exists(f"quarantine:{TRACE}") == 0, f"after {code.name} the trace must stay in the assembly, not be dropped or quarantined"
    before = len(ctx.grpc.calls_to("Write"))
    ctx.grpc.fail("Write", grpc.StatusCode.UNAVAILABLE, times=2)
    result = _flush(ctx, m, "with storage back after two UNAVAILABLE answers")
    calls = len(ctx.grpc.calls_to("Write")) - before
    assert calls == 3 and result == {"flushed": True, "kept": False, "quarantined": False, "attempts": 3}, f"two UNAVAILABLE answers then OK: the third attempt must write the trace; flush_trace called Write {calls} times and answered {result}"
    assert ctx.redis.exists(KEY) == 0, "storage confirmed the third attempt and the assembly state is still in Redis"


def check_quarantine(ctx):
    m, storage = _client(ctx, child_service="")
    result = _flush(ctx, m, "with a trace storage refuses")
    calls = len(ctx.grpc.calls_to("Write"))
    assert calls == 1, f"storage answered INVALID_ARGUMENT and flush_trace called Write {calls} times: a schema rejection is not retried"
    assert result.get("quarantined") is True and result.get("flushed") is False, f"a rejected trace must be answered as quarantined, flush_trace answered {result}"
    ttl = ctx.redis.ttl(f"quarantine:{TRACE}")
    assert 7 * 86400 - 60 <= ttl <= 7 * 86400, f"quarantine:{TRACE} has TTL {ttl}: the trace must be parked with assembly.quarantine"
    parked = ctx.redis.get(f"quarantine:{TRACE}") or ""
    assert "span without a service" in parked, f"quarantine:{TRACE} must record storage's details as the reason (span without a service: ...), it holds {parked[:200]!r}"
    assert ctx.redis.exists(KEY) == 0, "a quarantined trace must leave the assembly"
`,
    typescript: `const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const KEY = \`trace:\${TRACE}\`;
const ROOT = '00f067aa0ba902b7';
const CHILD = '00f067aa0ba902b8';

/** Span storage: stores every trace whose spans all name a service; records whether the assembly state still existed when each write reached it. */
async function client(ctx, childService = 'payments') {
  const pkg = ctx.proto('trace_collector.proto');
  const storage = {statePresent: [] as boolean[], stored: [] as {tenant: string; spans: {span_id: string}[]}[]};
  ctx.grpc.serve(pkg.tracestore.TraceWriter.service, {
    Write(call, callback) {
      storage.statePresent.push(ctx.redis.exists(\`trace:\${call.request.trace_id}\`) === 1);
      if (call.request.spans.some(s => !s.service)) return callback({code: ctx.grpc.status.INVALID_ARGUMENT, details: 'span without a service: the span schema requires one'});
      storage.stored.push(call.request);
      callback(null, {stored: call.request.spans.length});
    },
  });
  const assembly = ctx.load('/support/traces/assembly.ts');
  await assembly.insertSpan('acme', {trace_id: TRACE, span_id: ROOT, parent_span_id: '', service: 'checkout', start_ms: 1712345678901, duration_ms: 412});
  await assembly.insertSpan('acme', {trace_id: TRACE, span_id: CHILD, parent_span_id: ROOT, service: childService, start_ms: 1712345678950, duration_ms: 120});
  return {m: ctx.load('client'), storage};
}

async function flush(ctx, m, why: string) {
  const result = await ctx.drain(m.flushTrace(TRACE));
  assert(result !== undefined, \`\${why}: flushTrace never resolved, it kept retrying until the runtime stopped it\`);
  return result;
}

export async function check_deadline(ctx) {
  const {m} = await client(ctx);
  ctx.grpc.setLatency('Write', 10.0);
  const result = await ctx.drain(m.flushTrace(TRACE));
  const calls = ctx.grpc.callsTo('Write');
  assert(calls.length > 0, 'flushTrace never called Write');
  for (const call of calls) {
    assert(call.timeout !== null, 'a Write carries no deadline: a storage that stalls holds the flusher for as long as it stalls');
    assert(1.5 <= call.timeout && call.timeout <= 2.5, \`a Write carries a \${call.timeout} s deadline, expected 2 s\`);
  }
  assert(result !== undefined, 'with storage stalled flushTrace never resolved');
  assert.equal(calls.length, 3, \`with storage stalled flushTrace called Write \${calls.length} times, expected MAX_ATTEMPTS = 3: DEADLINE_EXCEEDED is retried, and every attempt gets its own 2 s\`);
  assert(result.kept === true && result.flushed === false, \`every write timed out, so the trace must be kept for the next cycle; flushTrace answered \${JSON.stringify(result)}\`);
  assert.equal(ctx.redis.exists(KEY), 1, 'the writes timed out and the trace is gone from Redis');
  ctx.grpc.setLatency('Write', 0);
  const again = await flush(ctx, m, 'with storage answering again');
  assert.equal(again.flushed, true, \`once storage answers, the kept trace must be written; flushTrace answered \${JSON.stringify(again)}\`);
}

export async function check_delete_after_confirm(ctx) {
  const {m, storage} = await client(ctx);
  const result = await flush(ctx, m, 'with storage healthy');
  assert(storage.statePresent.length > 0, 'flushTrace never reached storage');
  assert(storage.statePresent[0], "the trace's Redis state was already deleted when the Write reached storage: had that write timed out, the only copy of the trace would be gone. Delete it after Write answered OK");
  assert(result.flushed === true && result.attempts === 1, \`a healthy storage takes the write at once; flushTrace answered \${JSON.stringify(result)}\`);
  const request = storage.stored[0];
  assert(request.tenant === 'acme' && JSON.stringify(request.spans.map(s => s.span_id)) === JSON.stringify([ROOT, CHILD]), \`the write must carry the tenant and both spans, storage got \${JSON.stringify(request)}\`);
  assert.equal(ctx.redis.exists(KEY), 0, 'storage confirmed the write and the assembly state is still in Redis');
}

export async function check_bounded_retries(ctx) {
  const {m} = await client(ctx);
  ctx.grpc.fail('Write', ctx.grpc.status.UNAVAILABLE, '', 3);
  let result = await flush(ctx, m, 'with storage down');
  let calls = ctx.grpc.callsTo('Write').length;
  assert.equal(calls, 3, \`with storage down flushTrace called Write \${calls} times, expected MAX_ATTEMPTS = 3\`);
  assert.deepStrictEqual(result, {flushed: false, kept: true, quarantined: false, attempts: 3}, \`three UNAVAILABLE answers must end in kept, attempts 3; flushTrace answered \${JSON.stringify(result)}\`);
  assert.equal(ctx.redis.exists(KEY), 1, 'storage never took the trace and it is gone from Redis: it must stay for the next cycle');
  for (const name of ['PERMISSION_DENIED', 'INTERNAL', 'FAILED_PRECONDITION']) {
    const before = ctx.grpc.callsTo('Write').length;
    ctx.grpc.fail('Write', ctx.grpc.status[name], '', 1);
    result = await flush(ctx, m, \`with storage answering \${name}\`);
    calls = ctx.grpc.callsTo('Write').length - before;
    assert.equal(calls, 1, \`storage answered \${name} and flushTrace called Write \${calls} times: only UNAVAILABLE and DEADLINE_EXCEEDED are retried\`);
    assert.deepStrictEqual(result, {flushed: false, kept: true, quarantined: false, attempts: 1}, \`\${name} is neither retried nor a schema rejection: the trace is kept for the next cycle, attempts 1; flushTrace answered \${JSON.stringify(result)}\`);
    assert(ctx.redis.exists(KEY) === 1 && ctx.redis.exists(\`quarantine:\${TRACE}\`) === 0, \`after \${name} the trace must stay in the assembly, not be dropped or quarantined\`);
  }
  const before = ctx.grpc.callsTo('Write').length;
  ctx.grpc.fail('Write', ctx.grpc.status.UNAVAILABLE, '', 2);
  result = await flush(ctx, m, 'with storage back after two UNAVAILABLE answers');
  calls = ctx.grpc.callsTo('Write').length - before;
  assert(calls === 3 && result.flushed === true && result.kept === false && result.quarantined === false && result.attempts === 3, \`two UNAVAILABLE answers then OK: the third attempt must write the trace (flushed, attempts 3); flushTrace called Write \${calls} times and answered \${JSON.stringify(result)}\`);
  assert.equal(ctx.redis.exists(KEY), 0, 'storage confirmed the third attempt and the assembly state is still in Redis');
}

export async function check_quarantine(ctx) {
  const {m} = await client(ctx, '');
  const result = await flush(ctx, m, 'with a trace storage refuses');
  const calls = ctx.grpc.callsTo('Write').length;
  assert.equal(calls, 1, \`storage answered INVALID_ARGUMENT and flushTrace called Write \${calls} times: a schema rejection is not retried\`);
  assert(result.quarantined === true && result.flushed === false, \`a rejected trace must be answered as quarantined, flushTrace answered \${JSON.stringify(result)}\`);
  const ttl = ctx.redis.ttl(\`quarantine:\${TRACE}\`);
  assert(7 * 86400 - 60 <= ttl && ttl <= 7 * 86400, \`quarantine:\${TRACE} has TTL \${ttl}: the trace must be parked with quarantine()\`);
  const parked = ctx.redis.get(\`quarantine:\${TRACE}\`) ?? '';
  assert(parked.includes('span without a service'), \`quarantine:\${TRACE} must record storage's details as the reason (span without a service: ...), it holds \${JSON.stringify(parked.slice(0, 200))}\`);
  assert.equal(ctx.redis.exists(KEY), 0, 'a quarantined trace must leave the assembly');
}
`,
    go: `package main

import (
	"context"
	"strings"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"traces/assembly"
	pb "traces/gen/trace_collector"

	"leetbuild/harness"
)

const (
	kHClTrace = "4bf92f3577b34da6a3ce929d0e0e4736"
	kHClKey   = "trace:" + kHClTrace
	kHClRoot  = "00f067aa0ba902b7"
	kHClChild = "00f067aa0ba902b8"
)

// HStoragePeer stores every trace whose spans all name a service and records whether the assembly
// state still existed when each write reached it.
type HStoragePeer struct {
	pb.UnimplementedTraceWriterServer
	ctx          *harness.Ctx
	statePresent []bool
	stored       []*pb.WriteRequest
}

func (s *HStoragePeer) Write(_ context.Context, req *pb.WriteRequest) (*pb.WriteReply, error) {
	s.statePresent = append(s.statePresent, s.ctx.Redis.Exists("trace:"+req.GetTraceId()) == 1)
	for _, span := range req.GetSpans() {
		if span.GetService() == "" {
			return nil, status.Error(codes.InvalidArgument, "span without a service: the span schema requires one")
		}
	}
	s.stored = append(s.stored, req)
	return &pb.WriteReply{Stored: int64(len(req.GetSpans()))}, nil
}

func hClientPeer(ctx *harness.Ctx, childService string) *HStoragePeer {
	peer := &HStoragePeer{ctx: ctx}
	pb.RegisterTraceWriterServer(ctx.GRPC.Server(""), peer)
	bg := context.Background()
	_, err := assembly.InsertSpan(bg, "acme", assembly.Span{TraceID: kHClTrace, SpanID: kHClRoot, Service: "checkout", StartMs: 1712345678901, DurationMs: 412})
	ctx.NoError(err, "seeding the root span")
	_, err = assembly.InsertSpan(bg, "acme", assembly.Span{TraceID: kHClTrace, SpanID: kHClChild, ParentSpanID: kHClRoot, Service: childService, StartMs: 1712345678950, DurationMs: 120})
	ctx.NoError(err, "seeding the child span")
	return peer
}

func hFlushOnce(ctx *harness.Ctx) (flushResult, bool) {
	var result flushResult
	var err error
	returned := ctx.Drain(func() { result, err = flushTrace(context.Background(), kHClTrace) })
	if returned {
		ctx.NoError(err, "flushTrace")
	}
	return result, returned
}

func hMustFlush(ctx *harness.Ctx, why string) flushResult {
	result, returned := hFlushOnce(ctx)
	ctx.Assert(returned, "%s: flushTrace never returned, it kept retrying until the runtime stopped it", why)
	return result
}

func CheckDeadline(ctx *harness.Ctx) {
	hClientPeer(ctx, "payments")
	ctx.GRPC.SetLatency("Write", 10.0, "")
	result, returned := hFlushOnce(ctx)
	calls := ctx.GRPC.CallsTo("Write", "")
	ctx.Assert(len(calls) > 0, "flushTrace never called Write")
	for _, call := range calls {
		ctx.Assert(call.HasDeadline(), "a Write carries no deadline: a storage that stalls holds the flusher for as long as it stalls")
		ctx.Assert(call.Timeout.Seconds() >= 1.5 && call.Timeout.Seconds() <= 2.5, "a Write carries a %v deadline, expected 2 s", call.Timeout)
	}
	ctx.Assert(returned, "with storage stalled flushTrace never returned")
	ctx.Assert(len(calls) == 3, "with storage stalled flushTrace called Write %d times, expected MAX_ATTEMPTS = 3: DEADLINE_EXCEEDED is retried, and every attempt gets its own 2 s", len(calls))
	ctx.Assert(result.Kept && !result.Flushed, "every write timed out, so the trace must be kept for the next cycle; flushTrace answered %+v", result)
	ctx.Equal(ctx.Redis.Exists(kHClKey), 1, "the writes timed out; the trace must still be in Redis")
	ctx.GRPC.SetLatency("Write", 0, "")
	again := hMustFlush(ctx, "with storage answering again")
	ctx.Assert(again.Flushed, "once storage answers, the kept trace must be written; flushTrace answered %+v", again)
}

func CheckDeleteAfterConfirm(ctx *harness.Ctx) {
	peer := hClientPeer(ctx, "payments")
	result := hMustFlush(ctx, "with storage healthy")
	ctx.Assert(len(peer.statePresent) > 0, "flushTrace never reached storage")
	ctx.Assert(peer.statePresent[0], "the trace's Redis state was already deleted when the Write reached storage: had that write timed out, the only copy of the trace would be gone. Delete it after Write answered OK")
	ctx.Assert(result.Flushed && result.Attempts == 1, "a healthy storage takes the write at once; flushTrace answered %+v", result)
	request := peer.stored[0]
	ids := []string{}
	for _, s := range request.GetSpans() {
		ids = append(ids, s.GetSpanId())
	}
	ctx.Assert(request.GetTenant() == "acme" && len(ids) == 2 && ids[0] == kHClRoot && ids[1] == kHClChild, "the write must carry the tenant and both spans, storage got tenant %q and spans %q", request.GetTenant(), ids)
	ctx.Equal(ctx.Redis.Exists(kHClKey), 0, "storage confirmed the write; the assembly state must be gone from Redis")
}

func CheckBoundedRetries(ctx *harness.Ctx) {
	hClientPeer(ctx, "payments")
	ctx.GRPC.Fail("Write", codes.Unavailable, "", 3, "")
	result := hMustFlush(ctx, "with storage down")
	ctx.Equal(len(ctx.GRPC.CallsTo("Write", "")), 3, "with storage down, the Write calls (MAX_ATTEMPTS = 3)")
	ctx.Equal(result, flushResult{Kept: true, Attempts: 3}, "three UNAVAILABLE answers must end in kept, attempts 3; flushTrace answered")
	ctx.Equal(ctx.Redis.Exists(kHClKey), 1, "storage never took the trace; it must stay in Redis for the next cycle")
	for _, terminal := range []struct {
		name string
		code codes.Code
	}{{"PERMISSION_DENIED", codes.PermissionDenied}, {"INTERNAL", codes.Internal}, {"FAILED_PRECONDITION", codes.FailedPrecondition}} {
		before := len(ctx.GRPC.CallsTo("Write", ""))
		ctx.GRPC.Fail("Write", terminal.code, "", 1, "")
		result = hMustFlush(ctx, "with storage answering "+terminal.name)
		calls := len(ctx.GRPC.CallsTo("Write", "")) - before
		ctx.Assert(calls == 1, "storage answered %s and flushTrace called Write %d times: only UNAVAILABLE and DEADLINE_EXCEEDED are retried", terminal.name, calls)
		ctx.Assert(result == flushResult{Kept: true, Attempts: 1}, "%s is neither retried nor a schema rejection: the trace is kept for the next cycle, attempts 1; flushTrace answered %+v", terminal.name, result)
		ctx.Assert(ctx.Redis.Exists(kHClKey) == 1 && ctx.Redis.Exists("quarantine:"+kHClTrace) == 0, "after %s the trace must stay in the assembly, not be dropped or quarantined", terminal.name)
	}
	before := len(ctx.GRPC.CallsTo("Write", ""))
	ctx.GRPC.Fail("Write", codes.Unavailable, "", 2, "")
	result = hMustFlush(ctx, "with storage back after two UNAVAILABLE answers")
	calls := len(ctx.GRPC.CallsTo("Write", "")) - before
	ctx.Assert(calls == 3 && result == flushResult{Flushed: true, Attempts: 3}, "two UNAVAILABLE answers then OK: the third attempt must write the trace; flushTrace called Write %d times and answered %+v", calls, result)
	ctx.Equal(ctx.Redis.Exists(kHClKey), 0, "storage confirmed the third attempt; the assembly state must be gone from Redis")
}

func CheckQuarantine(ctx *harness.Ctx) {
	hClientPeer(ctx, "")
	result := hMustFlush(ctx, "with a trace storage refuses")
	ctx.Equal(len(ctx.GRPC.CallsTo("Write", "")), 1, "storage answered INVALID_ARGUMENT: a schema rejection is not retried; the Write calls")
	ctx.Assert(result.Quarantined && !result.Flushed, "a rejected trace must be answered as quarantined, flushTrace answered %+v", result)
	ttl := ctx.Redis.TTL("quarantine:" + kHClTrace)
	ctx.Assert(ttl >= 7*86400-60 && ttl <= 7*86400, "quarantine:%s has TTL %d: the trace must be parked with assembly.Quarantine", kHClTrace, ttl)
	parked, _ := ctx.Redis.Get("quarantine:" + kHClTrace)
	ctx.Assert(strings.Contains(parked, "span without a service"), "quarantine:%s must record storage's details as the reason (span without a service: ...), it holds %.200q", kHClTrace, parked)
	ctx.Equal(ctx.Redis.Exists(kHClKey), 0, "a quarantined trace must leave the assembly")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <string>
#include <utility>
#include <vector>

#include "trace_collector.grpc.pb.h"
#include "traces/assembly.h"

namespace {

const std::string kHTrace = "4bf92f3577b34da6a3ce929d0e0e4736";
const std::string kHKey = "trace:" + kHTrace;
const std::string kHRoot = "00f067aa0ba902b7";
const std::string kHChild = "00f067aa0ba902b8";

// Span storage: stores every trace whose spans all name a service; records whether the assembly
// state still existed when each write reached it.
class HStoragePeer final : public tracestore::TraceWriter::Service {
 public:
  explicit HStoragePeer(harness::Ctx& ctx) : ctx_(ctx) {}
  std::vector<bool> state_present;
  std::vector<tracestore::WriteRequest> stored;
  grpc::Status Write(grpc::ServerContext*, const tracestore::WriteRequest* req, tracestore::WriteReply* out) override {
    state_present.push_back(ctx_.Redis.Exists("trace:" + req->trace_id()) == 1);
    for (const auto& s : req->spans()) {
      if (s.service().empty()) return grpc::Status(grpc::StatusCode::INVALID_ARGUMENT, "span without a service: the span schema requires one");
    }
    stored.push_back(*req);
    out->set_stored(req->spans_size());
    return grpc::Status::OK;
  }

 private:
  harness::Ctx& ctx_;
};

HStoragePeer& hClientPeer(harness::Ctx& ctx, const std::string& child_service) {
  static HStoragePeer* peer = nullptr;
  delete peer;
  peer = new HStoragePeer(ctx);
  ctx.GRPC.Server("")->RegisterService(peer);
  assembly::insertSpan("acme", assembly::Span{kHTrace, kHRoot, "", "checkout", 1712345678901LL, 412});
  assembly::insertSpan("acme", assembly::Span{kHTrace, kHChild, kHRoot, child_service, 1712345678950LL, 120});
  return *peer;
}

FlushResult hMustFlush(harness::Ctx& ctx, const std::string& why) {
  FlushResult result;
  const bool returned = ctx.Drain([&] { result = flushTrace(kHTrace); });
  ctx.Assert(returned, "%s: flushTrace never returned, it kept retrying until the runtime stopped it", why);
  return result;
}

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  hClientPeer(ctx, "payments");
  ctx.GRPC.SetLatency("Write", 10.0);
  FlushResult result;
  const bool returned = ctx.Drain([&] { result = flushTrace(kHTrace); });
  const auto calls = ctx.GRPC.CallsTo("Write");
  ctx.Assert(!calls.empty(), "flushTrace never called Write");
  for (const auto& call : calls) {
    ctx.Assert(call.HasDeadline(), "a Write carries no deadline: a storage that stalls holds the flusher for as long as it stalls");
    ctx.Assert(1.5 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 2.5, "a Write carries a %v s deadline, expected 2 s", call.TimeoutSeconds());
  }
  ctx.Assert(returned, "with storage stalled flushTrace never returned");
  ctx.Assert(calls.size() == 3, "with storage stalled flushTrace called Write %v times, expected kMaxAttempts = 3: DEADLINE_EXCEEDED is retried, and every attempt gets its own 2 s", calls.size());
  ctx.Assert(result.kept && !result.flushed, "every write timed out, so the trace must be kept for the next cycle; flushTrace answered kept %t flushed %t", result.kept, result.flushed);
  ctx.Equal(ctx.Redis.Exists(kHKey), 1, "the writes timed out; the trace must still be in Redis");
  ctx.GRPC.SetLatency("Write", 0);
  const FlushResult again = hMustFlush(ctx, "with storage answering again");
  ctx.Assert(again.flushed, "once storage answers, the kept trace must be written");
}

void CheckDeleteAfterConfirm(harness::Ctx& ctx) {
  HStoragePeer& peer = hClientPeer(ctx, "payments");
  const FlushResult result = hMustFlush(ctx, "with storage healthy");
  ctx.Assert(!peer.state_present.empty(), "flushTrace never reached storage");
  ctx.Assert(peer.state_present[0], "the trace's Redis state was already deleted when the Write reached storage: had that write timed out, the only copy of the trace would be gone. Delete it after Write answered OK");
  ctx.Assert(result.flushed && result.attempts == 1, "a healthy storage takes the write at once; flushTrace answered flushed %t after %v attempts", result.flushed, result.attempts);
  const auto& request = peer.stored.at(0);
  std::vector<std::string> ids;
  for (const auto& s : request.spans()) ids.push_back(s.span_id());
  ctx.Assert(request.tenant() == "acme" && ids == std::vector<std::string>{kHRoot, kHChild}, "the write must carry the tenant and both spans, storage got tenant %q and spans %q", request.tenant(), ids);
  ctx.Equal(ctx.Redis.Exists(kHKey), 0, "storage confirmed the write; the assembly state must be gone from Redis");
}

void CheckBoundedRetries(harness::Ctx& ctx) {
  hClientPeer(ctx, "payments");
  ctx.GRPC.Fail("Write", grpc::StatusCode::UNAVAILABLE, "", 3);
  FlushResult result = hMustFlush(ctx, "with storage down");
  ctx.Equal(ctx.GRPC.CallsTo("Write").size(), 3, "with storage down, the Write calls (kMaxAttempts = 3)");
  ctx.Assert(!result.flushed && result.kept && !result.quarantined && result.attempts == 3, "three UNAVAILABLE answers must end in kept, attempts 3; flushTrace answered kept %t after %v attempts", result.kept, result.attempts);
  ctx.Equal(ctx.Redis.Exists(kHKey), 1, "storage never took the trace; it must stay in Redis for the next cycle");
  const std::vector<std::pair<std::string, grpc::StatusCode>> terminals = {
      {"PERMISSION_DENIED", grpc::StatusCode::PERMISSION_DENIED}, {"INTERNAL", grpc::StatusCode::INTERNAL}, {"FAILED_PRECONDITION", grpc::StatusCode::FAILED_PRECONDITION}};
  for (const auto& [name, code] : terminals) {
    const std::size_t before = ctx.GRPC.CallsTo("Write").size();
    ctx.GRPC.Fail("Write", code, "", 1);
    result = hMustFlush(ctx, "with storage answering " + name);
    const std::size_t calls = ctx.GRPC.CallsTo("Write").size() - before;
    ctx.Assert(calls == 1, "storage answered %s and flushTrace called Write %v times: only UNAVAILABLE and DEADLINE_EXCEEDED are retried", name, calls);
    ctx.Assert(!result.flushed && result.kept && !result.quarantined && result.attempts == 1,
               "%s is neither retried nor a schema rejection: the trace is kept for the next cycle, attempts 1; flushTrace answered flushed %t kept %t quarantined %t after %v attempts", name,
               result.flushed, result.kept, result.quarantined, result.attempts);
    ctx.Assert(ctx.Redis.Exists(kHKey) == 1 && ctx.Redis.Exists("quarantine:" + kHTrace) == 0, "after %s the trace must stay in the assembly, not be dropped or quarantined", name);
  }
  const std::size_t before = ctx.GRPC.CallsTo("Write").size();
  ctx.GRPC.Fail("Write", grpc::StatusCode::UNAVAILABLE, "", 2);
  result = hMustFlush(ctx, "with storage back after two UNAVAILABLE answers");
  const std::size_t calls = ctx.GRPC.CallsTo("Write").size() - before;
  ctx.Assert(calls == 3 && result.flushed && !result.kept && !result.quarantined && result.attempts == 3,
             "two UNAVAILABLE answers then OK: the third attempt must write the trace; flushTrace called Write %v times and answered flushed %t after %v attempts", calls, result.flushed, result.attempts);
  ctx.Equal(ctx.Redis.Exists(kHKey), 0, "storage confirmed the third attempt; the assembly state must be gone from Redis");
}

void CheckQuarantine(harness::Ctx& ctx) {
  hClientPeer(ctx, "");
  const FlushResult result = hMustFlush(ctx, "with a trace storage refuses");
  ctx.Equal(ctx.GRPC.CallsTo("Write").size(), 1, "storage answered INVALID_ARGUMENT: a schema rejection is not retried; the Write calls");
  ctx.Assert(result.quarantined && !result.flushed, "a rejected trace must be answered as quarantined");
  const long long ttl = ctx.Redis.TTL("quarantine:" + kHTrace);
  ctx.Assert(ttl >= 7 * 86400 - 60 && ttl <= 7 * 86400, "quarantine:%s has TTL %v: the trace must be parked with assembly::quarantine", kHTrace, ttl);
  const std::string parked = ctx.Redis.Get("quarantine:" + kHTrace).value_or("");
  ctx.Assert(parked.find("span without a service") != std::string::npos, "quarantine:%s must record storage's details as the reason (span without a service: ...), it holds %q", kHTrace, parked.substr(0, 200));
  ctx.Equal(ctx.Redis.Exists(kHKey), 0, "a quarantined trace must leave the assembly");
}
`,
  },
  hints: [
    'Make storage slow and flush: the flusher waits as long as storage does, and when the write finally times out the trace is gone from Redis. A trace storage refuses is sent again every second.',
    'The starter deletes the hash before Write has answered, passes no deadline, and treats every error as a reason to sleep and try again, including INVALID_ARGUMENT, which says the payload itself is wrong.',
    'Pass `timeout=WRITE_DEADLINE_S`; loop `range(1, MAX_ATTEMPTS + 1)`; `delete_trace` after `Write` returns; `INVALID_ARGUMENT` → `assembly.quarantine(trace, exc.details())`; `RETRYABLE` codes continue; anything else, or the last attempt, answers `kept: true`.',
  ],
  debrief: `The delete is the commit point of the flush, so it belongs after the one signal that the data is safe somewhere else: storage's OK. Before that, Redis holds the only copy, and a timeout says nothing about whether storage wrote it, which is why the write has to be safe to repeat on the next cycle. The deadline and the attempt bound are what keep an outage local: three two-second attempts cost a flusher six seconds per trace instead of the whole outage. The status code sorts the rest, transient codes are retried and INVALID_ARGUMENT is parked. Jaeger's collector puts a bounded queue between ingest and the storage writer for the same reason, and drops spans when it is full rather than blocking the SDKs.`,
};
