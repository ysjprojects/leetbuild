import type {Step} from '@/lib/types';

export const pushGatewayStep: Step = {
  id: 'push-gateway',
  title: 'Call the push gateway with a deadline and jittered retries',
  concept: 'grpc',
  file: 'push_client',
  focus: ['worker', 'gateway'],
  task: `## Task

The push gateway fronts APNs and FCM and has this contract:

\`\`\`proto
service PushGateway {
  rpc Send(SendRequest) returns (SendReply);
}
message SendRequest { string device_token = 1; string title = 2; string body = 3; string collapse_key = 4; }
message SendReply   { string message_id = 1; }
\`\`\`

Implement \`send_push(token, title, body, collapse_key)\` on top of the generated stub.
\`devices.disable(token)\` is provided: it marks a device token stale so no further sends go to it.

- Every call carries a **deadline of 3 s**.
- \`UNAVAILABLE\` and \`RESOURCE_EXHAUSTED\` are worth retrying: wait **exponential backoff with
  jitter** (base 200 ms: ~200, ~400, …, plus a random slice) and try again, **at most 3 attempts**.
- \`INVALID_ARGUMENT\` and \`NOT_FOUND\` mean the token is bad or unregistered: \`devices.disable(token)\`,
  return nothing, and never retry — the same token will fail the same way.
- \`DEADLINE_EXCEEDED\`, or retries exhausted → raise a **retryable** error. The consumer (next step)
  re-queues the notification instead of blocking its partition on one slow provider.
- Any other status propagates as a plain error.

:::widget deadline-retry {"base": 200, "deadline": 3000, "attempts": 3}

:::widget grpc-streams {"mode": "unary"}`,
  sequence: {
    participants: ['delivery', 'Push gateway', 'devices'],
    messages: [
      {from: 'delivery', to: 'Push gateway', label: 'Send(token, title, body) · deadline 3 s', kind: 'sync'},
      {from: 'Push gateway', to: 'delivery', label: 'status UNAVAILABLE', kind: 'reply'},
      {from: 'delivery', to: 'delivery', label: 'sleep 200 ms + jitter', kind: 'sync'},
      {from: 'delivery', to: 'Push gateway', label: 'Send(…) attempt 2', kind: 'sync'},
      {from: 'Push gateway', to: 'delivery', label: 'SendReply{message_id}', kind: 'reply'},
      {from: 'delivery', to: 'Push gateway', label: 'Send(stale-token, …)', kind: 'sync'},
      {from: 'Push gateway', to: 'delivery', label: 'status NOT_FOUND → devices.disable(token)', kind: 'reply'},
    ],
  },
  hints: [
    'The loop runs at most three times; inside it: set the deadline on the call, make the call, and branch on the status code. Returning from inside the loop is the success path.',
    'Backoff is `base × 2^attempt` plus a random amount up to `base`: the exponent spreads retries over time, the jitter keeps a thousand workers from retrying in lock-step.',
    'Three different exits: a stale token returns nothing (after disabling it), a deadline raises the retryable error immediately, and the last retryable failure raises it too — only unexpected statuses raise a plain error.',
  ],
  checks: [
    {
      id: 'deadline',
      title: 'Sets a 3 s deadline on every call',
      detail: 'Each RPC carries a deadline (3 s); without one a stalled provider stalls the whole partition.',
      match: {
        python: {all: [/stub\.Send\([^\n]*timeout\s*=\s*(DEADLINE_S|3(\.0)?)\b/]},
        go: {all: [/context\.WithTimeout\(\s*\w+\s*,\s*(deadline|3\s*\*\s*time\.Second)\s*\)/]},
        scala: {all: [/withDeadlineAfter\(\s*(DeadlineMillis|3000L?)\s*,/]},
        cpp: {all: [/set_deadline\([^\n]*kDeadline/]},
      },
    },
    {
      id: 'backoff',
      title: 'Retries UNAVAILABLE and RESOURCE_EXHAUSTED with exponential backoff and jitter',
      detail:
        'Both statuses are transient; the wait between attempts doubles from the 200 ms base and carries a random component so retries do not synchronise.',
      match: {
        python: {
          all: [
            /StatusCode\.UNAVAILABLE/,
            /StatusCode\.RESOURCE_EXHAUSTED/,
            /time\.sleep\(/,
            /(BASE_BACKOFF_S|0\.2)\s*\*\s*2\s*\*\*|2\s*\*\*\s*\w+|<<\s*\w+/,
            /random\.\w+\(/,
          ],
        },
        go: {
          all: [
            /codes\.Unavailable/,
            /codes\.ResourceExhausted/,
            /time\.Sleep\(/,
            /baseBackoff\s*(<<|\*)|math\.Pow\(/,
            /rand\.\w+\(/,
          ],
        },
        scala: {
          all: [
            /Code\.UNAVAILABLE/,
            /Code\.RESOURCE_EXHAUSTED/,
            /Thread\.sleep\(/,
            /BaseBackoffMillis\s*(<<|\*)|[mM]ath\.pow\(/,
            /Random\.\w+\(|\.nextLong\(|\.nextInt\(/,
          ],
        },
        cpp: {
          all: [
            /StatusCode::UNAVAILABLE/,
            /StatusCode::RESOURCE_EXHAUSTED/,
            /sleep_for\(/,
            /kBaseBackoff\s*\*|kBaseBackoff\.count\(\)\s*(<<|\*)|std::pow\(/,
            /uniform_(int|real)_distribution|\brand\(\)|random_device/,
          ],
        },
      },
    },
    {
      id: 'bounded',
      title: 'Makes at most 3 attempts',
      detail: 'Never loop until success: a provider that is down would pin every worker forever.',
      match: {
        python: {all: [/for \w+ in range\(\s*(MAX_ATTEMPTS|3)\s*\)/], none: [/while True/]},
        go: {all: [/for \w+ := 0; \w+ < (maxAttempts|3); \w+\+\+/], none: [/for \{/]},
        scala: {
          all: [/\w+ < (MaxAttempts|3)\b|\w+ <= 2\b|0 until (MaxAttempts|3)\b/],
          none: [/while\s*\(\s*true\s*\)/],
        },
        cpp: {
          all: [/for \(int \w+ = 0; \w+ < (kMaxAttempts|3); (\+\+\w+|\w+\+\+)\)/],
          none: [/while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\)/],
        },
      },
    },
    {
      id: 'stale-token',
      title: 'Disables the device on INVALID_ARGUMENT / NOT_FOUND and does not retry',
      detail:
        'A bad or unregistered token fails identically every time: call `devices.disable(token)` and return nothing so the consumer records the outcome and moves on.',
      match: {
        python: {
          all: [
            /StatusCode\.INVALID_ARGUMENT/,
            /StatusCode\.NOT_FOUND/,
            /devices\.disable\(\s*token\s*\)/,
            /return None/,
          ],
        },
        go: {
          all: [
            /codes\.InvalidArgument/,
            /codes\.NotFound/,
            /devices\.Disable\(\s*ctx\s*,\s*token\s*\)/,
            /return "", nil/,
          ],
        },
        scala: {all: [/Code\.INVALID_ARGUMENT/, /Code\.NOT_FOUND/, /Devices\.disable\(\s*token\s*\)/, /\bNone\b/]},
        cpp: {
          all: [
            /StatusCode::INVALID_ARGUMENT/,
            /StatusCode::NOT_FOUND/,
            /devices::disable\(\s*token\s*\)/,
            /std::nullopt/,
          ],
        },
      },
    },
    {
      id: 'retryable',
      title: 'Raises a retryable error on DEADLINE_EXCEEDED and exhausted retries',
      detail:
        'The consumer needs to tell "try again later" from "give up": a deadline or three failed transient attempts raise the retryable error, which it turns into a record on the retry topic.',
      match: {
        python: {all: [/StatusCode\.DEADLINE_EXCEEDED/, /raise Retryable\(/]},
        go: {all: [/codes\.DeadlineExceeded/, /(?<!var )ErrRetryable\b/]},
        scala: {all: [/Code\.DEADLINE_EXCEEDED/, /throw new Retryable\(/]},
        cpp: {all: [/StatusCode::DEADLINE_EXCEEDED/, /throw Retryable\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import random
import time

import grpc

import devices  # devices.disable(token): marks a device token stale — provided
import push_pb2
import push_pb2_grpc

DEADLINE_S = 3.0
BASE_BACKOFF_S = 0.2
MAX_ATTEMPTS = 3

channel = grpc.insecure_channel("push-gateway:9000")
stub = push_pb2_grpc.PushGatewayStub(channel)


class Retryable(Exception):
    """The consumer re-queues the notification on the retry topic (step 6)."""


def send_push(token: str, title: str, body: str, collapse_key: str) -> str | None:
    """Message id from the gateway, or None when the device token is stale."""
    request = push_pb2.SendRequest(device_token=token, title=title, body=body, collapse_key=collapse_key)
    # TODO: up to MAX_ATTEMPTS calls to stub.Send, each with a DEADLINE_S timeout
    # TODO: UNAVAILABLE / RESOURCE_EXHAUSTED → sleep BASE_BACKOFF_S * 2**attempt plus jitter, try again
    # TODO: INVALID_ARGUMENT / NOT_FOUND → devices.disable(token), return None
    # TODO: DEADLINE_EXCEEDED, or retries exhausted → raise Retryable; anything else → raise
    raise NotImplementedError
`,
      solution: `import random
import time

import grpc

import devices  # devices.disable(token): marks a device token stale — provided
import push_pb2
import push_pb2_grpc

DEADLINE_S = 3.0
BASE_BACKOFF_S = 0.2
MAX_ATTEMPTS = 3

channel = grpc.insecure_channel("push-gateway:9000")
stub = push_pb2_grpc.PushGatewayStub(channel)


class Retryable(Exception):
    """The consumer re-queues the notification on the retry topic (step 6)."""


def send_push(token: str, title: str, body: str, collapse_key: str) -> str | None:
    """Message id from the gateway, or None when the device token is stale."""
    request = push_pb2.SendRequest(device_token=token, title=title, body=body, collapse_key=collapse_key)
    for attempt in range(MAX_ATTEMPTS):
        try:
            return stub.Send(request, timeout=DEADLINE_S).message_id
        except grpc.RpcError as e:
            code = e.code()
            if code in (grpc.StatusCode.INVALID_ARGUMENT, grpc.StatusCode.NOT_FOUND):
                devices.disable(token)
                return None
            if code == grpc.StatusCode.DEADLINE_EXCEEDED:
                raise Retryable("push gateway: deadline exceeded") from e
            if code in (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.RESOURCE_EXHAUSTED):
                if attempt == MAX_ATTEMPTS - 1:
                    raise Retryable(f"push gateway {code.name} after {MAX_ATTEMPTS} attempts") from e
                time.sleep(BASE_BACKOFF_S * 2**attempt + random.uniform(0, BASE_BACKOFF_S))
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
	"fmt"
	"math/rand/v2"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"notify/devices" // devices.Disable(ctx, token): marks a device token stale — provided
	pb "notify/gen/push"
)

const (
	deadline    = 3 * time.Second
	baseBackoff = 200 * time.Millisecond
	maxAttempts = 3
)

// ErrRetryable tells the consumer to re-queue the notification on the retry topic (step 6).
var ErrRetryable = errors.New("push gateway: retry later")

var conn, _ = grpc.NewClient("push-gateway:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewPushGatewayClient(conn)

// sendPush returns the gateway's message id, or "" with a nil error when the device token is stale.
func sendPush(ctx context.Context, token, title, body, collapseKey string) (string, error) {
	req := &pb.SendRequest{DeviceToken: token, Title: title, Body: body, CollapseKey: collapseKey}
	// TODO: up to maxAttempts calls to stub.Send, each under a context that expires after deadline
	// TODO: codes.Unavailable / codes.ResourceExhausted → sleep baseBackoff<<attempt plus jitter, try again
	// TODO: codes.InvalidArgument / codes.NotFound → devices.Disable(ctx, token), return "", nil
	// TODO: codes.DeadlineExceeded, or retries exhausted → wrap ErrRetryable; anything else → return the error
	_ = req
	_ = codes.OK
	_ = status.Code
	_ = rand.Int64N
	_ = fmt.Errorf
	return "", errors.New("not implemented")
}
`,
      solution: `package main

import (
	"context"
	"errors"
	"fmt"
	"math/rand/v2"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"notify/devices" // devices.Disable(ctx, token): marks a device token stale — provided
	pb "notify/gen/push"
)

const (
	deadline    = 3 * time.Second
	baseBackoff = 200 * time.Millisecond
	maxAttempts = 3
)

// ErrRetryable tells the consumer to re-queue the notification on the retry topic (step 6).
var ErrRetryable = errors.New("push gateway: retry later")

var conn, _ = grpc.NewClient("push-gateway:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewPushGatewayClient(conn)

// sendPush returns the gateway's message id, or "" with a nil error when the device token is stale.
func sendPush(ctx context.Context, token, title, body, collapseKey string) (string, error) {
	req := &pb.SendRequest{DeviceToken: token, Title: title, Body: body, CollapseKey: collapseKey}
	var lastErr error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		reply, err := stub.Send(callCtx, req)
		cancel()
		if err == nil {
			return reply.GetMessageId(), nil
		}
		switch status.Code(err) {
		case codes.InvalidArgument, codes.NotFound:
			devices.Disable(ctx, token)
			return "", nil
		case codes.DeadlineExceeded:
			return "", fmt.Errorf("%w: %v", ErrRetryable, err)
		case codes.Unavailable, codes.ResourceExhausted:
			lastErr = err
			time.Sleep(baseBackoff<<attempt + time.Duration(rand.Int64N(int64(baseBackoff))))
		default:
			return "", err
		}
	}
	return "", fmt.Errorf("%w: %d attempts: %v", ErrRetryable, maxAttempts, lastErr)
}
`,
    },
    scala: {
      starter: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}
import notify.Devices // Devices.disable(token): marks a device token stale — provided
import notify.push.{PushGatewayGrpc, SendRequest}
import scala.util.Random

object PushClient {
  val DeadlineMillis = 3000L
  val BaseBackoffMillis = 200L
  val MaxAttempts = 3

  /** The consumer re-queues the notification on the retry topic (step 6). */
  class Retryable(msg: String, cause: Throwable = null) extends RuntimeException(msg, cause)

  private val channel = ManagedChannelBuilder.forAddress("push-gateway", 9000).usePlaintext().build()
  private val stub = PushGatewayGrpc.blockingStub(channel)

  /** Message id from the gateway, or None when the device token is stale. */
  def sendPush(token: String, title: String, body: String, collapseKey: String): Option[String] = {
    val request = SendRequest(deviceToken = token, title = title, body = body, collapseKey = collapseKey)
    // TODO: up to MaxAttempts calls to send, each withDeadlineAfter DeadlineMillis
    // TODO: UNAVAILABLE / RESOURCE_EXHAUSTED → sleep (BaseBackoffMillis << attempt) plus jitter, try again
    // TODO: INVALID_ARGUMENT / NOT_FOUND → Devices.disable(token), None
    // TODO: DEADLINE_EXCEEDED, or retries exhausted → throw Retryable; anything else → rethrow
    ???
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}
import notify.Devices // Devices.disable(token): marks a device token stale — provided
import notify.push.{PushGatewayGrpc, SendRequest}
import scala.util.Random

object PushClient {
  val DeadlineMillis = 3000L
  val BaseBackoffMillis = 200L
  val MaxAttempts = 3

  /** The consumer re-queues the notification on the retry topic (step 6). */
  class Retryable(msg: String, cause: Throwable = null) extends RuntimeException(msg, cause)

  private val channel = ManagedChannelBuilder.forAddress("push-gateway", 9000).usePlaintext().build()
  private val stub = PushGatewayGrpc.blockingStub(channel)

  /** Message id from the gateway, or None when the device token is stale. */
  def sendPush(token: String, title: String, body: String, collapseKey: String): Option[String] = {
    val request = SendRequest(deviceToken = token, title = title, body = body, collapseKey = collapseKey)
    var attempt = 0
    while (attempt < MaxAttempts) {
      try {
        val reply = stub.withDeadlineAfter(DeadlineMillis, TimeUnit.MILLISECONDS).send(request)
        return Some(reply.messageId)
      } catch {
        case e: StatusRuntimeException =>
          e.getStatus.getCode match {
            case Status.Code.INVALID_ARGUMENT | Status.Code.NOT_FOUND =>
              Devices.disable(token)
              return None
            case Status.Code.DEADLINE_EXCEEDED => throw new Retryable("push gateway: deadline exceeded", e)
            case Status.Code.UNAVAILABLE | Status.Code.RESOURCE_EXHAUSTED if attempt < MaxAttempts - 1 =>
              Thread.sleep((BaseBackoffMillis << attempt) + Random.nextLong(BaseBackoffMillis))
            case Status.Code.UNAVAILABLE | Status.Code.RESOURCE_EXHAUSTED =>
              throw new Retryable(s"push gateway \${e.getStatus.getCode} after $MaxAttempts attempts", e)
            case _ => throw e
          }
      }
      attempt += 1
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
#include <random>
#include <stdexcept>
#include <string>
#include <thread>

#include "devices.h"  // namespace devices { void disable(const std::string& token); } — marks a token stale; provided
#include "push.grpc.pb.h"

constexpr std::chrono::milliseconds kDeadline{3000};
constexpr std::chrono::milliseconds kBaseBackoff{200};
constexpr int kMaxAttempts = 3;

// The consumer re-queues the notification on the retry topic (step 6).
struct Retryable : std::runtime_error {
  using std::runtime_error::runtime_error;
};

auto channel = grpc::CreateChannel("push-gateway:9000", grpc::InsecureChannelCredentials());
auto stub = notify::PushGateway::NewStub(channel);
std::mt19937_64 rng{std::random_device{}()};

// Message id from the gateway, or nullopt when the device token is stale.
std::optional<std::string> send_push(const std::string& token, const std::string& title, const std::string& body,
                                     const std::string& collapse_key) {
  notify::SendRequest request;
  request.set_device_token(token);
  request.set_title(title);
  request.set_body(body);
  request.set_collapse_key(collapse_key);
  // TODO: up to kMaxAttempts calls to stub->Send, each with a ClientContext deadline of now + kDeadline
  // TODO: UNAVAILABLE / RESOURCE_EXHAUSTED → sleep kBaseBackoff * (1 << attempt) plus jitter from rng, try again
  // TODO: INVALID_ARGUMENT / NOT_FOUND → devices::disable(token), return nullopt
  // TODO: DEADLINE_EXCEEDED, or retries exhausted → throw Retryable; anything else → throw runtime_error
  return "";
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <optional>
#include <random>
#include <stdexcept>
#include <string>
#include <thread>

#include "devices.h"  // namespace devices { void disable(const std::string& token); } — marks a token stale; provided
#include "push.grpc.pb.h"

constexpr std::chrono::milliseconds kDeadline{3000};
constexpr std::chrono::milliseconds kBaseBackoff{200};
constexpr int kMaxAttempts = 3;

// The consumer re-queues the notification on the retry topic (step 6).
struct Retryable : std::runtime_error {
  using std::runtime_error::runtime_error;
};

auto channel = grpc::CreateChannel("push-gateway:9000", grpc::InsecureChannelCredentials());
auto stub = notify::PushGateway::NewStub(channel);
std::mt19937_64 rng{std::random_device{}()};

// Message id from the gateway, or nullopt when the device token is stale.
std::optional<std::string> send_push(const std::string& token, const std::string& title, const std::string& body,
                                     const std::string& collapse_key) {
  notify::SendRequest request;
  request.set_device_token(token);
  request.set_title(title);
  request.set_body(body);
  request.set_collapse_key(collapse_key);
  for (int attempt = 0; attempt < kMaxAttempts; ++attempt) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    notify::SendReply reply;
    const grpc::Status status = stub->Send(&ctx, request, &reply);
    if (status.ok()) return reply.message_id();
    switch (status.error_code()) {
      case grpc::StatusCode::INVALID_ARGUMENT:
      case grpc::StatusCode::NOT_FOUND:
        devices::disable(token);
        return std::nullopt;
      case grpc::StatusCode::DEADLINE_EXCEEDED:
        throw Retryable("push gateway: deadline exceeded");
      case grpc::StatusCode::UNAVAILABLE:
      case grpc::StatusCode::RESOURCE_EXHAUSTED: {
        if (attempt == kMaxAttempts - 1) throw Retryable("push gateway: " + status.error_message());
        std::uniform_int_distribution<long> jitter(0, kBaseBackoff.count());
        std::this_thread::sleep_for(kBaseBackoff * (1 << attempt) + std::chrono::milliseconds(jitter(rng)));
        break;
      }
      default:
        throw std::runtime_error("push gateway: " + status.error_message());
    }
  }
  throw Retryable("push gateway: retries exhausted");
}
`,
    },
  },
  debrief: `Three decisions make a provider call safe to put inside a consumer: a deadline, so one stuck call cannot hold a partition; retries only for the statuses that mean "not right now", with backoff and jitter so a provider recovering from an outage is not hit by every worker at once; and a distinct retryable error, so the caller can park the work instead of blocking on it. Disabling a stale token on the spot is what keeps the gateway's error rate honest. Real clients also honour \`Retry-After\` metadata from the gateway, use a circuit breaker when the error rate stays high, and collapse duplicate notifications with the \`collapse_key\` on the device.`,
};
