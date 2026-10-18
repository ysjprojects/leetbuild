import type {Step} from '@/lib/types';

export const resizeRpcStep: Step = {
  id: 'resize-rpc',
  title: 'Call the resizer over gRPC with a deadline',
  concept: 'grpc',
  file: 'resizer_client',
  focus: ['thumbs', 'resizer', 'origin'],
  task: `## Task

The resizer is an internal service with this contract:

\`\`\`proto
service Resizer {
  rpc Resize(ResizeRequest) returns (ResizeReply);
}
message ResizeRequest { string image_id = 1; uint32 width = 2; }
message ResizeReply   { bytes jpeg = 1; }
\`\`\`

Implement \`render(id, width)\` on top of the generated stub:

- Every call carries a **deadline of 800 ms** — a thumbnail that takes longer is not worth waiting for
  while a browser hangs.
- \`NOT_FOUND\` from the resizer means the origin has no such image: return nothing (that becomes the
  negative-cache sentinel).
- Retry **once** when the status is \`UNAVAILABLE\` (the resizer is restarting, a connection dropped).
  Do not retry other statuses: a \`DEADLINE_EXCEEDED\` already cost the full budget and an
  \`INVALID_ARGUMENT\` will fail again.
- Any other error propagates.

:::widget grpc-streams {"mode": "unary"}

:::widget deadline-retry {"base": 100, "deadline": 800, "attempts": 2}`,
  sequence: {
    participants: ['thumbs', 'Resizer', 'Origin'],
    messages: [
      {from: 'thumbs', to: 'Resizer', label: 'Resize(cat, 256) · deadline 800 ms', kind: 'sync'},
      {from: 'Resizer', to: 'Origin', label: 'fetch cat.jpg', kind: 'sync'},
      {from: 'Origin', to: 'Resizer', label: 'original bytes', kind: 'reply'},
      {from: 'Resizer', to: 'thumbs', label: 'ResizeReply{jpeg}', kind: 'reply'},
      {from: 'thumbs', to: 'Resizer', label: 'Resize(ghost, 256)', kind: 'sync'},
      {from: 'Resizer', to: 'thumbs', label: 'status NOT_FOUND', kind: 'reply'},
    ],
  },
  hints: [
    'The deadline is per attempt and is set on the call itself (a timeout argument, a context with timeout, or a stub option) — not with a sleep or a timer around the call.',
    'Inspect the status code of the error: `NOT_FOUND` → return nothing; `UNAVAILABLE` on the first attempt → try again; everything else → re-raise.',
    'A loop of at most two attempts with the status check inside it keeps the retry bounded and readable.',
  ],
  checks: [
    {
      id: 'deadline',
      title: 'Sets a per-call deadline',
      detail: 'Every RPC must carry a deadline (800 ms) so a slow resizer cannot hold the request open.',
      match: {
        python: {all: [/stub\.Resize\([^\n]*timeout\s*=/]},
        typescript: {all: [/\.Resize\([^\n]*deadline\s*:/]},
        go: {all: [/context\.WithTimeout\(/]},
        scala: {all: [/withDeadlineAfter\(/]},
        cpp: {all: [/set_deadline\(/]},
      },
    },
    {
      id: 'not-found',
      title: 'Treats NOT_FOUND as a missing image',
      detail: 'A `NOT_FOUND` status is a normal outcome, not an error: return nothing so the caller caches the miss.',
      match: {
        python: {all: [/StatusCode\.NOT_FOUND/, /return None/]},
        typescript: {all: [/status\.NOT_FOUND/, /return null/]},
        go: {all: [/codes\.NotFound/, /return nil, nil/]},
        scala: {all: [/Status\.Code\.NOT_FOUND|Code\.NOT_FOUND/, /\bNone\b/]},
        cpp: {all: [/grpc::StatusCode::NOT_FOUND|StatusCode::NOT_FOUND/, /std::nullopt/]},
      },
    },
    {
      id: 'retry-unavailable',
      title: 'Retries once on UNAVAILABLE',
      detail:
        'Only `UNAVAILABLE` is worth a second attempt; other statuses either already spent the budget or will fail again.',
      match: {
        python: {all: [/StatusCode\.UNAVAILABLE/, /\battempts?\b|\bretr(y|ies)\b/]},
        typescript: {all: [/status\.UNAVAILABLE/, /\battempts?\b|\bretr(y|ies)\b/]},
        go: {all: [/codes\.Unavailable/, /\battempts?\b|\bretr(y|ies)\b/]},
        scala: {all: [/Code\.UNAVAILABLE/, /\battempts?\b|\bretr(y|ies)\b/]},
        cpp: {all: [/StatusCode::UNAVAILABLE/, /\battempts?\b|\bretr(y|ies)\b/]},
      },
    },
    {
      id: 'bounded',
      title: 'Retries are bounded',
      detail: 'Never loop until success: a resizer that is down would pin every request thread.',
      match: {
        python: {all: [/for \w+ in range\(\s*2\s*\)/], none: [/while True/]},
        typescript: {
          all: [/for \(let \w+ = 0; \w+ < 2; (\+\+\w+|\w+\+\+)\)/],
          none: [/while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\)/],
        },
        go: {all: [/for \w+ := 0; \w+ < 2; \w+\+\+/], none: [/for \{/]},
        scala: {all: [/\w+ <- 0 until 2|\w+ < 2|\w+ <= 1/], none: [/while\s*\(\s*true\s*\)/]},
        cpp: {
          all: [/for \(int \w+ = 0; \w+ < 2; (\+\+\w+|\w+\+\+)\)/],
          none: [/while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\)/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import resizer_pb2
import resizer_pb2_grpc

DEADLINE_S = 0.8

channel = grpc.insecure_channel("resizer:9000")
stub = resizer_pb2_grpc.ResizerStub(channel)


def render(image_id: str, width: int) -> bytes | None:
    request = resizer_pb2.ResizeRequest(image_id=image_id, width=width)
    # TODO: stub.Resize with a deadline of DEADLINE_S
    # TODO: NOT_FOUND → None; UNAVAILABLE → retry once; anything else → raise
    raise NotImplementedError
`,
      solution: `import grpc

import resizer_pb2
import resizer_pb2_grpc

DEADLINE_S = 0.8

channel = grpc.insecure_channel("resizer:9000")
stub = resizer_pb2_grpc.ResizerStub(channel)


def render(image_id: str, width: int) -> bytes | None:
    request = resizer_pb2.ResizeRequest(image_id=image_id, width=width)
    for attempt in range(2):
        try:
            return stub.Resize(request, timeout=DEADLINE_S).jpeg
        except grpc.RpcError as e:
            if e.code() == grpc.StatusCode.NOT_FOUND:
                return None
            if e.code() == grpc.StatusCode.UNAVAILABLE and attempt == 0:
                continue
            raise
    return None
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

interface ResizeRequest {
  image_id: string;
  width: number;
}
interface ResizeReply {
  jpeg: Buffer;
}
interface ResizerClient {
  Resize(request: ResizeRequest, options: {deadline: number | Date}): Promise<ResizeReply>;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('resizer.proto')) as unknown as {
  thumbs: {Resizer: new (target: string, credentials: grpc.ChannelCredentials) => ResizerClient};
};

export const DEADLINE_MS = 800;

const stub = new pkg.thumbs.Resizer('resizer:9000', grpc.credentials.createInsecure());

export async function render(imageId: string, width: number): Promise<Buffer | null> {
  const request: ResizeRequest = {image_id: imageId, width};
  // TODO: stub.Resize with a deadline of DEADLINE_MS from now
  // TODO: NOT_FOUND → null; UNAVAILABLE → retry once; anything else → throw
  throw new Error('not implemented');
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

interface ResizeRequest {
  image_id: string;
  width: number;
}
interface ResizeReply {
  jpeg: Buffer;
}
interface ResizerClient {
  Resize(request: ResizeRequest, options: {deadline: number | Date}): Promise<ResizeReply>;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('resizer.proto')) as unknown as {
  thumbs: {Resizer: new (target: string, credentials: grpc.ChannelCredentials) => ResizerClient};
};

export const DEADLINE_MS = 800;

const stub = new pkg.thumbs.Resizer('resizer:9000', grpc.credentials.createInsecure());

export async function render(imageId: string, width: number): Promise<Buffer | null> {
  const request: ResizeRequest = {image_id: imageId, width};
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const reply = await stub.Resize(request, {deadline: Date.now() + DEADLINE_MS});
      return reply.jpeg;
    } catch (e) {
      const {code} = e as grpc.ServiceError;
      if (code === grpc.status.NOT_FOUND) return null;
      if (code === grpc.status.UNAVAILABLE && attempt === 0) continue;
      throw e;
    }
  }
  return null;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"errors"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "thumbs/gen/resizer"
)

const deadline = 800 * time.Millisecond

var conn, _ = grpc.NewClient("resizer:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewResizerClient(conn)

func render(ctx context.Context, id string, width int) ([]byte, error) {
	req := &pb.ResizeRequest{ImageId: id, Width: uint32(width)}
	// TODO: stub.Resize with a context that expires after \`deadline\`
	// TODO: codes.NotFound → nil, nil; codes.Unavailable → retry once; anything else → return the error
	_ = req
	_ = codes.OK
	_ = status.Code
	return nil, errors.New("not implemented")
}
`,
      solution: `package main

import (
	"context"
	"errors"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "thumbs/gen/resizer"
)

const deadline = 800 * time.Millisecond

var conn, _ = grpc.NewClient("resizer:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewResizerClient(conn)

func render(ctx context.Context, id string, width int) ([]byte, error) {
	req := &pb.ResizeRequest{ImageId: id, Width: uint32(width)}
	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		reply, err := stub.Resize(callCtx, req)
		cancel()
		if err == nil {
			return reply.GetJpeg(), nil
		}
		switch status.Code(err) {
		case codes.NotFound:
			return nil, nil
		case codes.Unavailable:
			lastErr = err
			continue
		default:
			return nil, err
		}
	}
	return nil, errors.Join(errors.New("resizer unavailable"), lastErr)
}
`,
    },
    scala: {
      starter: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}
import thumbs.resizer.{ResizeRequest, ResizerGrpc}

object ResizerClient {
  val DeadlineMillis = 800L

  private val channel = ManagedChannelBuilder.forAddress("resizer", 9000).usePlaintext().build()
  private val stub = ResizerGrpc.blockingStub(channel)

  def render(id: String, width: Int): Option[Array[Byte]] = {
    val request = ResizeRequest(imageId = id, width = width)
    // TODO: call Resize with a deadline of DeadlineMillis
    // TODO: NOT_FOUND → None; UNAVAILABLE → retry once; anything else → rethrow
    None
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}
import thumbs.resizer.{ResizeRequest, ResizerGrpc}

object ResizerClient {
  val DeadlineMillis = 800L

  private val channel = ManagedChannelBuilder.forAddress("resizer", 9000).usePlaintext().build()
  private val stub = ResizerGrpc.blockingStub(channel)

  def render(id: String, width: Int): Option[Array[Byte]] = {
    val request = ResizeRequest(imageId = id, width = width)
    var attempt = 0
    while (attempt < 2) {
      try {
        val reply = stub.withDeadlineAfter(DeadlineMillis, TimeUnit.MILLISECONDS).resize(request)
        return Some(reply.jpeg.toByteArray)
      } catch {
        case e: StatusRuntimeException =>
          e.getStatus.getCode match {
            case Status.Code.NOT_FOUND => return None
            case Status.Code.UNAVAILABLE if attempt == 0 => attempt += 1
            case _ => throw e
          }
      }
    }
    None
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <optional>
#include <string>

#include "resizer.grpc.pb.h"

constexpr std::chrono::milliseconds kDeadline{800};

auto channel = grpc::CreateChannel("resizer:9000", grpc::InsecureChannelCredentials());
auto stub = thumbs::Resizer::NewStub(channel);

std::optional<std::string> render(const std::string& id, int width) {
  thumbs::ResizeRequest request;
  request.set_image_id(id);
  request.set_width(width);
  // TODO: call stub->Resize with a ClientContext whose deadline is now + kDeadline
  // TODO: NOT_FOUND → nullopt; UNAVAILABLE → retry once; anything else → throw
  return std::nullopt;
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <optional>
#include <stdexcept>
#include <string>

#include "resizer.grpc.pb.h"

constexpr std::chrono::milliseconds kDeadline{800};

auto channel = grpc::CreateChannel("resizer:9000", grpc::InsecureChannelCredentials());
auto stub = thumbs::Resizer::NewStub(channel);

std::optional<std::string> render(const std::string& id, int width) {
  thumbs::ResizeRequest request;
  request.set_image_id(id);
  request.set_width(width);
  for (int attempt = 0; attempt < 2; ++attempt) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    thumbs::ResizeReply reply;
    const grpc::Status status = stub->Resize(&ctx, request, &reply);
    if (status.ok()) return reply.jpeg();
    if (status.error_code() == grpc::StatusCode::NOT_FOUND) return std::nullopt;
    if (status.error_code() == grpc::StatusCode::UNAVAILABLE && attempt == 0) continue;
    throw std::runtime_error("resizer: " + status.error_message());
  }
  throw std::runtime_error("resizer unavailable");
}
`,
    },
  },
  harness: {
    python: `import grpc

import resizer_pb2
import resizer_pb2_grpc


class FakeResizer(resizer_pb2_grpc.ResizerServicer):
    def __init__(self):
        self.calls = 0

    def Resize(self, request, context):
        self.calls += 1
        if request.image_id == "ghost":
            context.abort(grpc.StatusCode.NOT_FOUND, "no such image")
        return resizer_pb2.ResizeReply(jpeg=b"JPEG-" + request.image_id.encode() + b"-" + str(request.width).encode())


def _client(ctx):
    peer = FakeResizer()
    ctx.grpc.serve(resizer_pb2_grpc.add_ResizerServicer_to_server, peer)
    return ctx.load("resizer_client"), peer


def check_deadline(ctx):
    m, peer = _client(ctx)
    assert m.render("cat", 256) == b"JPEG-cat-256", "render must return the resizer's bytes"
    call = ctx.grpc.calls_to("Resize")[-1]
    assert call.timeout is not None, "the RPC carries no deadline"
    assert 0.5 <= call.timeout <= 1.0, f"the deadline must be about 800 ms, got {call.timeout} s"
    ctx.grpc.set_latency("Resize", 3.0)
    try:
        m.render("cat", 128)
        raise AssertionError("a resizer slower than the deadline must surface DEADLINE_EXCEEDED")
    except grpc.RpcError as e:
        assert e.code() == grpc.StatusCode.DEADLINE_EXCEEDED, f"a slow resizer raised {e.code()}, expected DEADLINE_EXCEEDED"
    assert len(ctx.grpc.calls_to("Resize")) == 2, "DEADLINE_EXCEEDED must not be retried"


def check_not_found(ctx):
    m, peer = _client(ctx)
    assert m.render("ghost", 256) is None, "NOT_FOUND means the origin has no such image: return None"
    assert peer.calls == 1, "NOT_FOUND must not be retried"


def check_retry_unavailable(ctx):
    m, peer = _client(ctx)
    ctx.grpc.fail("Resize", grpc.StatusCode.UNAVAILABLE, times=1)
    assert m.render("cat", 256) == b"JPEG-cat-256", "one UNAVAILABLE must be retried and succeed"
    assert len(ctx.grpc.calls_to("Resize")) == 2, "exactly one retry after UNAVAILABLE"
    ctx.grpc.fail("Resize", grpc.StatusCode.INVALID_ARGUMENT, "width", times=1)
    try:
        m.render("cat", 256)
        raise AssertionError("INVALID_ARGUMENT must propagate, not be retried or swallowed")
    except grpc.RpcError as e:
        assert e.code() == grpc.StatusCode.INVALID_ARGUMENT
    assert len(ctx.grpc.calls_to("Resize")) == 3, "INVALID_ARGUMENT must not be retried"


def check_bounded(ctx):
    m, peer = _client(ctx)
    ctx.grpc.fail("Resize", grpc.StatusCode.UNAVAILABLE, times=50)
    try:
        m.render("cat", 256)
        raise AssertionError("a resizer that stays UNAVAILABLE must raise, not return")
    except grpc.RpcError as e:
        assert e.code() == grpc.StatusCode.UNAVAILABLE
    attempts = len(ctx.grpc.calls_to("Resize"))
    assert attempts == 2, f"made {attempts} attempts against a down resizer; retries must stop after the second"
`,
    typescript: `/** The resizer peer: knows every image but ghost, counts its calls. */
function client(ctx) {
  const peer = {calls: 0};
  const {thumbs} = ctx.proto('resizer.proto');
  ctx.grpc.serve(thumbs.Resizer.service, {
    Resize: (call, callback) => {
      peer.calls += 1;
      const {image_id, width} = call.request;
      if (image_id === 'ghost') return callback({code: ctx.grpc.status.NOT_FOUND, details: 'no such image'});
      callback(null, {jpeg: Buffer.from(\`JPEG-\${image_id}-\${width}\`)});
    },
  });
  return {m: ctx.load('resizer_client'), peer};
}

const statusName = (ctx, code: number) => Object.keys(ctx.grpc.status).find(k => ctx.grpc.status[k] === code) ?? String(code);

export async function check_deadline(ctx) {
  const {m} = client(ctx);
  assert.equal(String(await m.render('cat', 256)), 'JPEG-cat-256', "render must return the resizer's bytes");
  const calls = ctx.grpc.callsTo('Resize');
  const call = calls[calls.length - 1];
  assert(call.timeout !== null, 'the RPC carries no deadline');
  assert(0.5 <= call.timeout && call.timeout <= 1.0, \`the deadline must be about 800 ms, got \${call.timeout} s\`);
  ctx.grpc.setLatency('Resize', 3.0);
  await assert.rejects(
    m.render('cat', 128),
    e => {
      assert.equal(e.code, ctx.grpc.status.DEADLINE_EXCEEDED, \`a slow resizer raised \${statusName(ctx, e.code)}, expected DEADLINE_EXCEEDED\`);
      return true;
    },
    'a resizer slower than the deadline must surface DEADLINE_EXCEEDED',
  );
  assert.equal(ctx.grpc.callsTo('Resize').length, 2, 'DEADLINE_EXCEEDED must not be retried');
}

export async function check_not_found(ctx) {
  const {m, peer} = client(ctx);
  assert.equal(await m.render('ghost', 256), null, 'NOT_FOUND means the origin has no such image: return null');
  assert.equal(peer.calls, 1, 'NOT_FOUND must not be retried');
}

export async function check_retry_unavailable(ctx) {
  const {m} = client(ctx);
  ctx.grpc.fail('Resize', ctx.grpc.status.UNAVAILABLE, '', 1);
  assert.equal(String(await m.render('cat', 256)), 'JPEG-cat-256', 'one UNAVAILABLE must be retried and succeed');
  assert.equal(ctx.grpc.callsTo('Resize').length, 2, 'exactly one retry after UNAVAILABLE');
  ctx.grpc.fail('Resize', ctx.grpc.status.INVALID_ARGUMENT, 'width', 1);
  await assert.rejects(
    m.render('cat', 256),
    e => {
      assert.equal(e.code, ctx.grpc.status.INVALID_ARGUMENT, \`INVALID_ARGUMENT must propagate as is, got \${statusName(ctx, e.code)}\`);
      return true;
    },
    'INVALID_ARGUMENT must propagate, not be retried or swallowed',
  );
  assert.equal(ctx.grpc.callsTo('Resize').length, 3, 'INVALID_ARGUMENT must not be retried');
}

export async function check_bounded(ctx) {
  const {m} = client(ctx);
  ctx.grpc.fail('Resize', ctx.grpc.status.UNAVAILABLE, '', 50);
  await assert.rejects(
    m.render('cat', 256),
    e => {
      assert.equal(e.code, ctx.grpc.status.UNAVAILABLE, \`a resizer that stays down must surface UNAVAILABLE, got \${statusName(ctx, e.code)}\`);
      return true;
    },
    'a resizer that stays UNAVAILABLE must throw, not return',
  );
  const attempts = ctx.grpc.callsTo('Resize').length;
  assert.equal(attempts, 2, \`made \${attempts} attempts against a down resizer; retries must stop after the second\`);
}
`,
  },
  debrief: `Deadlines are the single most important thing a client sets: without one, a slow dependency turns into a slow *you*. Retrying only \`UNAVAILABLE\` — and only a bounded number of times — is what keeps a retry from becoming a retry storm. Production clients add jittered backoff between attempts, honour the server's retry policy, and propagate the caller's deadline instead of picking their own (\`ctx\` in Go, \`grpc-timeout\` on the wire).`,
};
