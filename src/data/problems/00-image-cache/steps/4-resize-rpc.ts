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
  debrief: `Deadlines are the single most important thing a client sets: without one, a slow dependency turns into a slow *you*. Retrying only \`UNAVAILABLE\` — and only a bounded number of times — is what keeps a retry from becoming a retry storm. Production clients add jittered backoff between attempts, honour the server's retry policy, and propagate the caller's deadline instead of picking their own (\`ctx\` in Go, \`grpc-timeout\` on the wire).`,
};
