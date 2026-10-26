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
        typescript: {all: [/\.Send\([^)]*\{\s*deadline:\s*Date\.now\(\)\s*\+\s*(DEADLINE_MS|3000)\b/]},
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
        typescript: {
          all: [
            /status\.UNAVAILABLE/,
            /status\.RESOURCE_EXHAUSTED/,
            /\bsleep\(|setTimeout\(/,
            /(BASE_BACKOFF_MS|200)\s*\*\s*2\s*\*\*|2\s*\*\*\s*\w+|<<\s*\w+|Math\.pow\(/,
            /Math\.random\(\)|randomInt\(/,
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
        typescript: {
          all: [/for \(let \w+ = 0; \w+ < (MAX_ATTEMPTS|3); (\+\+\w+|\w+\+\+)\)/],
          none: [/while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\)/],
        },
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
        typescript: {
          all: [/status\.INVALID_ARGUMENT/, /status\.NOT_FOUND/, /devices\.disable\(\s*token\s*\)/, /return null/],
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
        typescript: {all: [/status\.DEADLINE_EXCEEDED/, /throw new Retryable\(/]},
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
    typescript: {
      starter: `import {setTimeout as sleep} from 'node:timers/promises';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {devices} from 'notify/devices'; // devices.disable(token): marks a device token stale — provided

export const DEADLINE_MS = 3000;
export const BASE_BACKOFF_MS = 200;
export const MAX_ATTEMPTS = 3;

interface SendRequest {
  device_token: string;
  title: string;
  body: string;
  collapse_key: string;
}

interface SendReply {
  message_id: string;
}

interface PushGatewayClient {
  Send(request: SendRequest, options: {deadline: number}): Promise<SendReply>;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('push.proto')) as unknown as {
  notify: {PushGateway: new (target: string, credentials: grpc.ChannelCredentials) => PushGatewayClient};
};
const client = new pkg.notify.PushGateway('push-gateway:9000', grpc.credentials.createInsecure());

/** The consumer re-queues the notification on the retry topic (step 6). */
export class Retryable extends Error {}

/** Message id from the gateway, or null when the device token is stale. */
export async function sendPush(token: string, title: string, body: string, collapseKey: string): Promise<string | null> {
  const request: SendRequest = {device_token: token, title, body, collapse_key: collapseKey};
  // TODO: up to MAX_ATTEMPTS calls to client.Send, each with a deadline of Date.now() + DEADLINE_MS
  // TODO: UNAVAILABLE / RESOURCE_EXHAUSTED → sleep BASE_BACKOFF_MS * 2 ** attempt plus jitter, try again
  // TODO: INVALID_ARGUMENT / NOT_FOUND → devices.disable(token), return null
  // TODO: DEADLINE_EXCEEDED, or retries exhausted → throw Retryable; anything else → rethrow
  throw new Error('not implemented');
}
`,
      solution: `import {setTimeout as sleep} from 'node:timers/promises';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {devices} from 'notify/devices'; // devices.disable(token): marks a device token stale — provided

export const DEADLINE_MS = 3000;
export const BASE_BACKOFF_MS = 200;
export const MAX_ATTEMPTS = 3;

interface SendRequest {
  device_token: string;
  title: string;
  body: string;
  collapse_key: string;
}

interface SendReply {
  message_id: string;
}

interface PushGatewayClient {
  Send(request: SendRequest, options: {deadline: number}): Promise<SendReply>;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('push.proto')) as unknown as {
  notify: {PushGateway: new (target: string, credentials: grpc.ChannelCredentials) => PushGatewayClient};
};
const client = new pkg.notify.PushGateway('push-gateway:9000', grpc.credentials.createInsecure());

/** The consumer re-queues the notification on the retry topic (step 6). */
export class Retryable extends Error {}

/** Message id from the gateway, or null when the device token is stale. */
export async function sendPush(token: string, title: string, body: string, collapseKey: string): Promise<string | null> {
  const request: SendRequest = {device_token: token, title, body, collapse_key: collapseKey};
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const reply = await client.Send(request, {deadline: Date.now() + DEADLINE_MS});
      return reply.message_id;
    } catch (e) {
      const {code, message} = e as grpc.ServiceError;
      if (code === grpc.status.INVALID_ARGUMENT || code === grpc.status.NOT_FOUND) {
        devices.disable(token);
        return null;
      }
      if (code === grpc.status.DEADLINE_EXCEEDED) throw new Retryable('push gateway: deadline exceeded', {cause: e});
      if (code === grpc.status.UNAVAILABLE || code === grpc.status.RESOURCE_EXHAUSTED) {
        if (attempt === MAX_ATTEMPTS - 1)
          throw new Retryable(\`push gateway: \${message} after \${MAX_ATTEMPTS} attempts\`, {cause: e});
        await sleep(BASE_BACKOFF_MS * 2 ** attempt + Math.random() * BASE_BACKOFF_MS);
        continue;
      }
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
  harness: {
    python: `import grpc

import push_pb2
import push_pb2_grpc


class FakeGateway(push_pb2_grpc.PushGatewayServicer):
    def __init__(self):
        self.calls = 0

    def Send(self, request, context):
        self.calls += 1
        if request.device_token == "stale":
            context.abort(grpc.StatusCode.NOT_FOUND, "unregistered device token")
        return push_pb2.SendReply(message_id="m-" + request.device_token + "-" + str(self.calls))


def _client(ctx):
    peer = FakeGateway()
    ctx.grpc.serve(push_pb2_grpc.add_PushGatewayServicer_to_server, peer)
    return ctx.load("push_client"), peer


def _send(m, token="tok-1"):
    return m.send_push(token, "Shipped", "On its way", "order-1")


def _waited(ctx, m, code, times):
    """Virtual seconds slept and sleeps taken by one send_push that first meets the given failures."""
    ctx.grpc.fail("Send", code, times=times)
    offset, sleeps = ctx.clock.offset, ctx.clock.sleeps
    result = _send(m)
    return result, round(ctx.clock.offset - offset, 6), ctx.clock.sleeps - sleeps


def check_deadline(ctx):
    m, peer = _client(ctx)
    assert _send(m) == "m-tok-1-1", "send_push must return the gateway's message_id"
    ctx.grpc.fail("Send", grpc.StatusCode.UNAVAILABLE, times=1)
    assert _send(m) == "m-tok-1-2", "one UNAVAILABLE must be retried and succeed"
    calls = ctx.grpc.calls_to("Send")
    assert len(calls) == 3, f"expected 3 calls (one success, one failure, one retry), saw {len(calls)}"
    for call in calls:
        assert call.timeout is not None, "an RPC carries no deadline"
        assert 2.5 <= call.timeout <= 3.0, f"every call must carry a deadline of about 3 s, got {call.timeout} s"
    request = calls[0].request
    assert (request.device_token, request.title, request.body, request.collapse_key) == ("tok-1", "Shipped", "On its way", "order-1"), f"the request must carry token, title, body and collapse_key, got {request}"


def check_backoff(ctx):
    m, peer = _client(ctx)
    result, waited, sleeps = _waited(ctx, m, grpc.StatusCode.UNAVAILABLE, 1)
    assert result == "m-tok-1-1", "one UNAVAILABLE must be retried and succeed"
    assert sleeps == 1, f"expected one backoff sleep between the two attempts, saw {sleeps}"
    assert 0.2 <= waited <= 0.45, f"the first backoff must be about 200 ms plus jitter, it was {waited} s"
    result, waited2, sleeps = _waited(ctx, m, grpc.StatusCode.RESOURCE_EXHAUSTED, 2)
    assert result == "m-tok-1-2", "two RESOURCE_EXHAUSTED must be retried and the third attempt succeed"
    assert sleeps == 2, f"expected two backoff sleeps before the third attempt, saw {sleeps}"
    assert 0.6 <= waited2 <= 1.05, f"the two backoffs must be about 200 + 400 ms plus jitter, together they were {waited2} s"
    seen = {waited}
    for _ in range(6):
        seen.add(_waited(ctx, m, grpc.StatusCode.UNAVAILABLE, 1)[1])
    assert len(seen) > 1, f"every first backoff lasted exactly {waited} s: add jitter so retries do not synchronise"


def check_bounded(ctx):
    m, peer = _client(ctx)
    ctx.grpc.fail("Send", grpc.StatusCode.UNAVAILABLE, times=50)
    try:
        _send(m)
        raise AssertionError("a gateway that stays UNAVAILABLE must raise, send_push returned")
    except m.Retryable:
        pass
    attempts = len(ctx.grpc.calls_to("Send"))
    assert attempts == 3, f"made {attempts} attempts against a down gateway, expected exactly 3"
    assert peer.calls == 0, "no attempt reached the gateway: every one was UNAVAILABLE"


def check_stale_token(ctx):
    m, peer = _client(ctx)
    assert _send(m, "stale") is None, "NOT_FOUND means the token is unregistered: return None"
    assert m.devices.disabled == ["stale"], f"the stale token must be disabled, devices.disabled is {m.devices.disabled}"
    assert len(ctx.grpc.calls_to("Send")) == 1, "NOT_FOUND must not be retried"
    ctx.grpc.fail("Send", grpc.StatusCode.INVALID_ARGUMENT, "malformed token", times=1)
    assert _send(m, "bad") is None, "INVALID_ARGUMENT means the token is bad: return None"
    assert m.devices.disabled == ["stale", "bad"], f"the bad token must be disabled, devices.disabled is {m.devices.disabled}"
    assert len(ctx.grpc.calls_to("Send")) == 2, "INVALID_ARGUMENT must not be retried"
    assert ctx.clock.sleeps == 0, "a stale token must not wait for a backoff"


def check_retryable(ctx):
    m, peer = _client(ctx)
    ctx.grpc.set_latency("Send", 5.0)
    try:
        _send(m)
        raise AssertionError("a gateway slower than the deadline must raise Retryable, send_push returned")
    except m.Retryable:
        pass
    assert len(ctx.grpc.calls_to("Send")) == 1, "DEADLINE_EXCEEDED must not be retried: the consumer re-queues the record instead"
    ctx.grpc.set_latency("Send", 0.0)
    ctx.grpc.fail("Send", grpc.StatusCode.RESOURCE_EXHAUSTED, times=3)
    try:
        _send(m)
        raise AssertionError("exhausted retries must raise Retryable, send_push returned")
    except m.Retryable:
        pass
    ctx.grpc.fail("Send", grpc.StatusCode.PERMISSION_DENIED, "bad credentials", times=1)
    try:
        _send(m)
        raise AssertionError("PERMISSION_DENIED must propagate as an error, send_push returned")
    except m.Retryable:
        raise AssertionError("PERMISSION_DENIED is not transient: it must propagate as a plain error, not Retryable")
    except grpc.RpcError as e:
        assert e.code() == grpc.StatusCode.PERMISSION_DENIED
    assert m.devices.disabled == [], "only INVALID_ARGUMENT / NOT_FOUND disable the token"
`,
    typescript: `/** The push gateway peer: answers every token but 'stale' (NOT_FOUND), counts the calls that reached it. */
function client(ctx) {
  const pkg = ctx.proto('push.proto');
  const peer = {calls: 0};
  ctx.grpc.serve(pkg.notify.PushGateway.service, {
    Send: (call, callback) => {
      peer.calls += 1;
      if (call.request.device_token === 'stale')
        return callback({code: ctx.grpc.status.NOT_FOUND, details: 'unregistered device token'});
      callback(null, {message_id: \`m-\${call.request.device_token}-\${peer.calls}\`});
    },
  });
  const m = ctx.load('push_client');
  const devices = ctx.load('/support/notify/devices.ts').devices;
  return {m, peer, devices};
}

function send(m, token = 'tok-1') {
  return m.sendPush(token, 'Shipped', 'On its way', 'order-1');
}

/** The error a promise rejected with, or null when it resolved. */
async function thrown(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (e) {
    return e;
  }
}

/** Virtual seconds slept and sleeps taken by one sendPush that first meets the given failures. */
async function waited(ctx, m, code: number, times: number) {
  ctx.grpc.fail('Send', code, '', times);
  const started = ctx.clock.now();
  const sleeps = ctx.clock.sleeps;
  const result = await send(m);
  return {result, seconds: Math.round((ctx.clock.now() - started) / 1000 * 1e6) / 1e6, sleeps: ctx.clock.sleeps - sleeps};
}

export async function check_deadline(ctx) {
  const {m} = client(ctx);
  assert.equal(await send(m), 'm-tok-1-1', "sendPush must return the gateway's message_id");
  ctx.grpc.fail('Send', ctx.grpc.status.UNAVAILABLE, '', 1);
  assert.equal(await send(m), 'm-tok-1-2', 'one UNAVAILABLE must be retried and succeed');
  const calls = ctx.grpc.callsTo('Send');
  assert.equal(calls.length, 3, \`expected 3 calls (one success, one failure, one retry), saw \${calls.length}\`);
  for (const call of calls) {
    assert(call.timeout !== null, 'an RPC carries no deadline');
    assert(2.5 <= call.timeout && call.timeout <= 3.0, \`every call must carry a deadline of about 3 s, got \${call.timeout} s\`);
  }
  const request = calls[0].request;
  assert.deepEqual(
    [request.device_token, request.title, request.body, request.collapse_key],
    ['tok-1', 'Shipped', 'On its way', 'order-1'],
    \`the request must carry token, title, body and collapse_key, got \${JSON.stringify(request)}\`,
  );
}

export async function check_backoff(ctx) {
  const {m} = client(ctx);
  const one = await waited(ctx, m, ctx.grpc.status.UNAVAILABLE, 1);
  assert.equal(one.result, 'm-tok-1-1', 'one UNAVAILABLE must be retried and succeed');
  assert.equal(one.sleeps, 1, \`expected one backoff sleep between the two attempts, saw \${one.sleeps}\`);
  assert(0.2 <= one.seconds && one.seconds <= 0.45, \`the first backoff must be about 200 ms plus jitter, it was \${one.seconds} s\`);
  const two = await waited(ctx, m, ctx.grpc.status.RESOURCE_EXHAUSTED, 2);
  assert.equal(two.result, 'm-tok-1-2', 'two RESOURCE_EXHAUSTED must be retried and the third attempt succeed');
  assert.equal(two.sleeps, 2, \`expected two backoff sleeps before the third attempt, saw \${two.sleeps}\`);
  assert(0.6 <= two.seconds && two.seconds <= 1.05, \`the two backoffs must be about 200 + 400 ms plus jitter, together they were \${two.seconds} s\`);
  const seen = new Set([one.seconds]);
  for (let i = 0; i < 6; i++) seen.add((await waited(ctx, m, ctx.grpc.status.UNAVAILABLE, 1)).seconds);
  assert(seen.size > 1, \`every first backoff lasted exactly \${one.seconds} s: add jitter so retries do not synchronise\`);
}

export async function check_bounded(ctx) {
  const {m, peer} = client(ctx);
  ctx.grpc.fail('Send', ctx.grpc.status.UNAVAILABLE, '', 50);
  const error = await thrown(send(m));
  assert(error !== null, 'a gateway that stays UNAVAILABLE must throw, sendPush returned');
  assert(error instanceof m.Retryable, \`a gateway that stays UNAVAILABLE must throw Retryable, got \${error}\`);
  const attempts = ctx.grpc.callsTo('Send').length;
  assert.equal(attempts, 3, \`made \${attempts} attempts against a down gateway, expected exactly 3\`);
  assert.equal(peer.calls, 0, 'no attempt reached the gateway: every one was UNAVAILABLE');
}

export async function check_stale_token(ctx) {
  const {m, devices} = client(ctx);
  assert.equal(await send(m, 'stale'), null, 'NOT_FOUND means the token is unregistered: return null');
  assert.deepEqual(devices.disabled, ['stale'], \`the stale token must be disabled, devices.disabled is \${JSON.stringify(devices.disabled)}\`);
  assert.equal(ctx.grpc.callsTo('Send').length, 1, 'NOT_FOUND must not be retried');
  ctx.grpc.fail('Send', ctx.grpc.status.INVALID_ARGUMENT, 'malformed token', 1);
  assert.equal(await send(m, 'bad'), null, 'INVALID_ARGUMENT means the token is bad: return null');
  assert.deepEqual(devices.disabled, ['stale', 'bad'], \`the bad token must be disabled, devices.disabled is \${JSON.stringify(devices.disabled)}\`);
  assert.equal(ctx.grpc.callsTo('Send').length, 2, 'INVALID_ARGUMENT must not be retried');
  assert.equal(ctx.clock.sleeps, 0, 'a stale token must not wait for a backoff');
}

export async function check_retryable(ctx) {
  const {m, devices} = client(ctx);
  ctx.grpc.setLatency('Send', 5.0);
  const slow = await thrown(send(m));
  assert(slow !== null, 'a gateway slower than the deadline must throw Retryable, sendPush returned');
  assert(slow instanceof m.Retryable, \`a gateway slower than the deadline must throw Retryable, got \${slow}\`);
  assert.equal(ctx.grpc.callsTo('Send').length, 1, 'DEADLINE_EXCEEDED must not be retried: the consumer re-queues the record instead');
  ctx.grpc.setLatency('Send', 0.0);
  ctx.grpc.fail('Send', ctx.grpc.status.RESOURCE_EXHAUSTED, '', 3);
  const exhausted = await thrown(send(m));
  assert(exhausted !== null, 'exhausted retries must throw Retryable, sendPush returned');
  assert(exhausted instanceof m.Retryable, \`exhausted retries must throw Retryable, got \${exhausted}\`);
  ctx.grpc.fail('Send', ctx.grpc.status.PERMISSION_DENIED, 'bad credentials', 1);
  const denied = await thrown(send(m));
  assert(denied !== null, 'PERMISSION_DENIED must propagate as an error, sendPush returned');
  assert(!(denied instanceof m.Retryable), 'PERMISSION_DENIED is not transient: it must propagate as a plain error, not Retryable');
  assert.equal(denied.code, ctx.grpc.status.PERMISSION_DENIED, \`PERMISSION_DENIED must propagate with its status code, got \${denied}\`);
  assert.deepEqual(devices.disabled, [], 'only INVALID_ARGUMENT / NOT_FOUND disable the token');
}
`,
    go: `package main

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sync"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"leetbuild/harness"

	"notify/devices"
	pb "notify/gen/push"
)

// pushPeer is the push gateway: it answers every token but "stale" (NOT_FOUND) and counts the calls that reached it.
type pushPeer struct {
	pb.UnimplementedPushGatewayServer
	mu    sync.Mutex
	calls int
}

func (p *pushPeer) Send(ctx context.Context, req *pb.SendRequest) (*pb.SendReply, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.calls++
	if req.GetDeviceToken() == "stale" {
		return nil, status.Error(codes.NotFound, "unregistered device token")
	}
	return &pb.SendReply{MessageId: fmt.Sprintf("m-%s-%d", req.GetDeviceToken(), p.calls)}, nil
}

func servePushPeer(ctx *harness.Ctx) *pushPeer {
	p := &pushPeer{}
	pb.RegisterPushGatewayServer(ctx.GRPC.Server(""), p)
	return p
}

func pushSend(token string) (string, error) {
	return sendPush(context.Background(), token, "Shipped", "On its way", "order-1")
}

// pushWait is one sendPush that first met injected failures: its result, the virtual seconds it took and the sleeps it took.
type pushWait struct {
	result  string
	seconds float64
	sleeps  int
}

func pushWaited(ctx *harness.Ctx, code codes.Code, times int) pushWait {
	ctx.GRPC.Fail("Send", code, "", times, "")
	started := ctx.Clock.Now()
	sleeps := ctx.Clock.Sleeps()
	result, err := pushSend("tok-1")
	ctx.NoError(err, "sendPush after %d %v returned an error", times, code)
	return pushWait{
		result:  result,
		seconds: math.Round(float64(ctx.Clock.Now()-started)/1000*1e6) / 1e6,
		sleeps:  ctx.Clock.Sleeps() - sleeps,
	}
}

func CheckDeadline(ctx *harness.Ctx) {
	servePushPeer(ctx)
	id, err := pushSend("tok-1")
	ctx.NoError(err, "sendPush returned an error")
	ctx.Equal(id, "m-tok-1-1", "sendPush must return the gateway's message_id")
	ctx.GRPC.Fail("Send", codes.Unavailable, "", 1, "")
	id, err = pushSend("tok-1")
	ctx.NoError(err, "one UNAVAILABLE must be retried and succeed")
	ctx.Equal(id, "m-tok-1-2", "one UNAVAILABLE must be retried and succeed")
	calls := ctx.GRPC.CallsTo("Send", "")
	ctx.Equal(len(calls), 3, "expected 3 calls (one success, one failure, one retry)")
	for _, call := range calls {
		ctx.Assert(call.HasDeadline(), "an RPC carries no deadline")
		timeout := call.Timeout.Seconds()
		ctx.Assert(2.5 <= timeout && timeout <= 3.0, "every call must carry a deadline of about 3 s, got %v s", timeout)
	}
	request, ok := calls[0].Request.(*pb.SendRequest)
	ctx.Assert(ok, "the call carried no SendRequest, got %v", calls[0].Request)
	ctx.Equal(
		[]string{request.GetDeviceToken(), request.GetTitle(), request.GetBody(), request.GetCollapseKey()},
		[]string{"tok-1", "Shipped", "On its way", "order-1"},
		"the request must carry token, title, body and collapse_key",
	)
}

func CheckBackoff(ctx *harness.Ctx) {
	servePushPeer(ctx)
	one := pushWaited(ctx, codes.Unavailable, 1)
	ctx.Equal(one.result, "m-tok-1-1", "one UNAVAILABLE must be retried and succeed")
	ctx.Equal(one.sleeps, 1, "expected one backoff sleep between the two attempts: sleeps")
	ctx.Assert(0.2 <= one.seconds && one.seconds <= 0.45, "the first backoff must be about 200 ms plus jitter, it was %v s", one.seconds)
	two := pushWaited(ctx, codes.ResourceExhausted, 2)
	ctx.Equal(two.result, "m-tok-1-2", "two RESOURCE_EXHAUSTED must be retried and the third attempt succeed")
	ctx.Equal(two.sleeps, 2, "expected two backoff sleeps before the third attempt: sleeps")
	ctx.Assert(0.6 <= two.seconds && two.seconds <= 1.05, "the two backoffs must be about 200 + 400 ms plus jitter, together they were %v s", two.seconds)
	seen := map[float64]bool{one.seconds: true}
	for range 6 {
		seen[pushWaited(ctx, codes.Unavailable, 1).seconds] = true
	}
	ctx.Assert(len(seen) > 1, "every first backoff lasted exactly %v s: add jitter so retries do not synchronise", one.seconds)
}

func CheckBounded(ctx *harness.Ctx) {
	peer := servePushPeer(ctx)
	ctx.GRPC.Fail("Send", codes.Unavailable, "", 50, "")
	_, err := pushSend("tok-1")
	ctx.Assert(err != nil, "a gateway that stays UNAVAILABLE must return an error wrapping ErrRetryable, sendPush returned nil")
	ctx.ErrorIs(err, ErrRetryable, "a gateway that stays UNAVAILABLE must return an error wrapping ErrRetryable")
	ctx.Equal(len(ctx.GRPC.CallsTo("Send", "")), 3, "attempts against a down gateway")
	ctx.Equal(peer.calls, 0, "no attempt reached the gateway (every one was UNAVAILABLE): calls the gateway answered")
}

func CheckStaleToken(ctx *harness.Ctx) {
	servePushPeer(ctx)
	id, err := pushSend("stale")
	ctx.NoError(err, "NOT_FOUND means the token is unregistered: sendPush must return a nil error")
	ctx.Equal(id, "", "NOT_FOUND means the token is unregistered: the message id")
	ctx.Equal(devices.Disabled, []string{"stale"}, "the stale token must be disabled: devices.Disabled")
	ctx.Equal(len(ctx.GRPC.CallsTo("Send", "")), 1, "NOT_FOUND must not be retried: calls to Send")
	ctx.GRPC.Fail("Send", codes.InvalidArgument, "malformed token", 1, "")
	id, err = pushSend("bad")
	ctx.NoError(err, "INVALID_ARGUMENT means the token is bad: sendPush must return a nil error")
	ctx.Equal(id, "", "INVALID_ARGUMENT means the token is bad: the message id")
	ctx.Equal(devices.Disabled, []string{"stale", "bad"}, "the bad token must be disabled: devices.Disabled")
	ctx.Equal(len(ctx.GRPC.CallsTo("Send", "")), 2, "INVALID_ARGUMENT must not be retried: calls to Send")
	ctx.Equal(ctx.Clock.Sleeps(), 0, "a stale token must not wait for a backoff: sleeps")
}

func CheckRetryable(ctx *harness.Ctx) {
	servePushPeer(ctx)
	ctx.GRPC.SetLatency("Send", 5.0, "")
	_, slow := pushSend("tok-1")
	ctx.Assert(slow != nil, "a gateway slower than the deadline must return an error wrapping ErrRetryable, sendPush returned nil")
	ctx.ErrorIs(slow, ErrRetryable, "a gateway slower than the deadline must return an error wrapping ErrRetryable")
	ctx.Equal(len(ctx.GRPC.CallsTo("Send", "")), 1, "DEADLINE_EXCEEDED must not be retried (the consumer re-queues the record instead): calls to Send")
	ctx.GRPC.SetLatency("Send", 0.0, "")
	ctx.GRPC.Fail("Send", codes.ResourceExhausted, "", 3, "")
	_, exhausted := pushSend("tok-1")
	ctx.Assert(exhausted != nil, "exhausted retries must return an error wrapping ErrRetryable, sendPush returned nil")
	ctx.ErrorIs(exhausted, ErrRetryable, "exhausted retries must return an error wrapping ErrRetryable")
	ctx.GRPC.Fail("Send", codes.PermissionDenied, "bad credentials", 1, "")
	_, denied := pushSend("tok-1")
	ctx.Assert(denied != nil, "PERMISSION_DENIED must propagate as an error, sendPush returned nil")
	ctx.Assert(!errors.Is(denied, ErrRetryable), "PERMISSION_DENIED is not transient: it must propagate as a plain error, not ErrRetryable")
	ctx.Equal(status.Code(denied), codes.PermissionDenied, "PERMISSION_DENIED must propagate with its status code (%v)", denied)
	ctx.Equal(devices.Disabled, []string(nil), "only INVALID_ARGUMENT / NOT_FOUND disable the token: devices.Disabled")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <cmath>
#include <exception>
#include <memory>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <vector>

namespace {

// The push gateway: it answers every token but "stale" (NOT_FOUND) and counts the calls that reached it.
class PushPeer final : public notify::PushGateway::Service {
 public:
  grpc::Status Send(grpc::ServerContext*, const notify::SendRequest* req, notify::SendReply* reply) override {
    std::lock_guard<std::mutex> lock(mu);
    calls++;
    if (req->device_token() == "stale") return grpc::Status(grpc::StatusCode::NOT_FOUND, "unregistered device token");
    reply->set_message_id("m-" + req->device_token() + "-" + std::to_string(calls));
    return grpc::Status::OK;
  }
  std::mutex mu;
  int calls = 0;
};

PushPeer& servePushPeer(harness::Ctx& ctx) {
  static PushPeer peer;
  ctx.GRPC.Server("")->RegisterService(&peer);
  return peer;
}

// How send_push ended: its result, or what it threw (retryable: a Retryable).
struct PushResult {
  std::optional<std::string> id;
  std::string error;
  bool retryable = false;
  bool failed() const { return !error.empty(); }
};

PushResult pushSend(const std::string& token) {
  try {
    return {send_push(token, "Shipped", "On its way", "order-1"), "", false};
  } catch (const Retryable& e) {
    return {std::nullopt, std::string("Retryable: ") + e.what(), true};
  } catch (const std::exception& e) {
    return {std::nullopt, harness::CurrentExceptionType() + ": " + e.what(), false};
  }
}

// One send_push that first met injected failures: its result, the virtual seconds it took and the sleeps it took.
struct PushWait {
  std::optional<std::string> result;
  double seconds = 0;
  int sleeps = 0;
};

PushWait pushWaited(harness::Ctx& ctx, grpc::StatusCode code, int times) {
  ctx.GRPC.Fail("Send", code, "", times, "");
  const int64_t started = ctx.Clock.Now();
  const int sleeps = ctx.Clock.Sleeps();
  const PushResult r = pushSend("tok-1");
  ctx.Assert(!r.failed(), "send_push after %d %v threw %s", times, code, r.error);
  return {r.id, std::round(static_cast<double>(ctx.Clock.Now() - started) / 1000 * 1e6) / 1e6, ctx.Clock.Sleeps() - sleeps};
}

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  servePushPeer(ctx);
  PushResult r = pushSend("tok-1");
  ctx.Assert(!r.failed(), "send_push threw %s", r.error);
  ctx.Equal(r.id, "m-tok-1-1", "send_push must return the gateway's message_id");
  ctx.GRPC.Fail("Send", grpc::StatusCode::UNAVAILABLE, "", 1, "");
  r = pushSend("tok-1");
  ctx.Assert(!r.failed(), "one UNAVAILABLE must be retried and succeed, send_push threw %s", r.error);
  ctx.Equal(r.id, "m-tok-1-2", "one UNAVAILABLE must be retried and succeed");
  const auto calls = ctx.GRPC.CallsTo("Send", "");
  ctx.Equal(calls.size(), 3, "expected 3 calls (one success, one failure, one retry)");
  for (const auto& call : calls) {
    ctx.Assert(call.HasDeadline(), "an RPC carries no deadline");
    const double timeout = call.TimeoutSeconds();
    ctx.Assert(2.5 <= timeout && timeout <= 3.0, "every call must carry a deadline of about 3 s, got %v s", timeout);
  }
  ctx.Assert(calls[0].HasRequest(), "the call carried no SendRequest");
  const auto request = calls[0].Request<notify::SendRequest>();
  ctx.Equal(std::vector<std::string>{request.device_token(), request.title(), request.body(), request.collapse_key()},
            {"tok-1", "Shipped", "On its way", "order-1"}, "the request must carry token, title, body and collapse_key");
}

void CheckBackoff(harness::Ctx& ctx) {
  servePushPeer(ctx);
  const PushWait one = pushWaited(ctx, grpc::StatusCode::UNAVAILABLE, 1);
  ctx.Equal(one.result, "m-tok-1-1", "one UNAVAILABLE must be retried and succeed");
  ctx.Equal(one.sleeps, 1, "expected one backoff sleep between the two attempts: sleeps");
  ctx.Assert(0.2 <= one.seconds && one.seconds <= 0.45, "the first backoff must be about 200 ms plus jitter, it was %v s",
             one.seconds);
  const PushWait two = pushWaited(ctx, grpc::StatusCode::RESOURCE_EXHAUSTED, 2);
  ctx.Equal(two.result, "m-tok-1-2", "two RESOURCE_EXHAUSTED must be retried and the third attempt succeed");
  ctx.Equal(two.sleeps, 2, "expected two backoff sleeps before the third attempt: sleeps");
  ctx.Assert(0.6 <= two.seconds && two.seconds <= 1.05,
             "the two backoffs must be about 200 + 400 ms plus jitter, together they were %v s", two.seconds);
  std::set<double> seen = {one.seconds};
  for (int i = 0; i < 6; i++) seen.insert(pushWaited(ctx, grpc::StatusCode::UNAVAILABLE, 1).seconds);
  ctx.Assert(seen.size() > 1, "every first backoff lasted exactly %v s: add jitter so retries do not synchronise", one.seconds);
}

void CheckBounded(harness::Ctx& ctx) {
  PushPeer& peer = servePushPeer(ctx);
  ctx.GRPC.Fail("Send", grpc::StatusCode::UNAVAILABLE, "", 50, "");
  const PushResult r = pushSend("tok-1");
  ctx.Assert(r.failed(), "a gateway that stays UNAVAILABLE must throw Retryable, send_push returned normally");
  ctx.Assert(r.retryable, "a gateway that stays UNAVAILABLE must throw Retryable, send_push threw %s", r.error);
  ctx.Equal(ctx.GRPC.CallsTo("Send", "").size(), 3, "attempts against a down gateway");
  ctx.Equal(peer.calls, 0, "no attempt reached the gateway (every one was UNAVAILABLE): calls the gateway answered");
}

void CheckStaleToken(harness::Ctx& ctx) {
  servePushPeer(ctx);
  PushResult r = pushSend("stale");
  ctx.Assert(!r.failed(), "NOT_FOUND means the token is unregistered: send_push must not throw, it threw %s", r.error);
  ctx.Equal(r.id, nullptr, "NOT_FOUND means the token is unregistered: the message id");
  ctx.Equal(devices::disabled, {"stale"}, "the stale token must be disabled: devices::disabled");
  ctx.Equal(ctx.GRPC.CallsTo("Send", "").size(), 1, "NOT_FOUND must not be retried: calls to Send");
  ctx.GRPC.Fail("Send", grpc::StatusCode::INVALID_ARGUMENT, "malformed token", 1, "");
  r = pushSend("bad");
  ctx.Assert(!r.failed(), "INVALID_ARGUMENT means the token is bad: send_push must not throw, it threw %s", r.error);
  ctx.Equal(r.id, nullptr, "INVALID_ARGUMENT means the token is bad: the message id");
  ctx.Equal(devices::disabled, {"stale", "bad"}, "the bad token must be disabled: devices::disabled");
  ctx.Equal(ctx.GRPC.CallsTo("Send", "").size(), 2, "INVALID_ARGUMENT must not be retried: calls to Send");
  ctx.Equal(ctx.Clock.Sleeps(), 0, "a stale token must not wait for a backoff: sleeps");
}

void CheckRetryable(harness::Ctx& ctx) {
  servePushPeer(ctx);
  ctx.GRPC.SetLatency("Send", 5.0, "");
  const PushResult slow = pushSend("tok-1");
  ctx.Assert(slow.failed(), "a gateway slower than the deadline must throw Retryable, send_push returned normally");
  ctx.Assert(slow.retryable, "a gateway slower than the deadline must throw Retryable, send_push threw %s", slow.error);
  ctx.Equal(ctx.GRPC.CallsTo("Send", "").size(), 1,
            "DEADLINE_EXCEEDED must not be retried (the consumer re-queues the record instead): calls to Send");
  ctx.GRPC.SetLatency("Send", 0.0, "");
  ctx.GRPC.Fail("Send", grpc::StatusCode::RESOURCE_EXHAUSTED, "", 3, "");
  const PushResult exhausted = pushSend("tok-1");
  ctx.Assert(exhausted.failed(), "exhausted retries must throw Retryable, send_push returned normally");
  ctx.Assert(exhausted.retryable, "exhausted retries must throw Retryable, send_push threw %s", exhausted.error);
  ctx.GRPC.Fail("Send", grpc::StatusCode::PERMISSION_DENIED, "bad credentials", 1, "");
  const PushResult denied = pushSend("tok-1");
  ctx.Assert(denied.failed(), "PERMISSION_DENIED must propagate as an exception, send_push returned normally");
  // Go also reads the status code off the error; the C++ step throws a plain std::runtime_error
  // carrying the status message, so the check reads the message.
  ctx.Assert(!denied.retryable,
             "PERMISSION_DENIED is not transient: it must propagate as a plain error, not Retryable (%s)", denied.error);
  ctx.Assert(denied.error.find("bad credentials") != std::string::npos,
             "PERMISSION_DENIED must propagate with the gateway's message (bad credentials), send_push threw %s",
             denied.error);
  ctx.Equal(devices::disabled, std::vector<std::string>{},
            "only INVALID_ARGUMENT / NOT_FOUND disable the token: devices::disabled");
}
`,
  },
  debrief: `Three decisions make a provider call safe to put inside a consumer: a deadline, so one stuck call cannot hold a partition; retries only for the statuses that mean "not right now", with backoff and jitter so a provider recovering from an outage is not hit by every worker at once; and a distinct retryable error, so the caller can park the work instead of blocking on it. Disabling a stale token on the spot is what keeps the gateway's error rate honest. Real clients also honour \`Retry-After\` metadata from the gateway, use a circuit breaker when the error rate stays high, and collapse duplicate notifications with the \`collapse_key\` on the device.`,
};
