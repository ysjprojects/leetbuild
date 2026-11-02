import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Relay calls with bounce-aware retries',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'relay', 'store'],
  task: `## Task

**Starting point.** The starter's \`send(recipient, message_id)\` loops with \`while True\`: it builds
a \`SendRequest\` with a fresh \`uuid4()\`, calls \`stub.Send\` with a 30-second timeout, sleeps two
seconds and loops again on any \`RpcError\`, on a \`HARD\` bounce and on a suppressed reply, and
returns \`accepted\` otherwise. It compiles and hides five flaws.

**Failure mode the checks target.** A dead address is hammered every two seconds for as long as the
process lives; a timeout resend carries a new id, so the relay delivers the mail twice; a suppressed
reply is retried against an address the platform promised to leave alone; and a slow relay holds a
worker for 30 seconds per attempt.

Requirements:

- Every call uses \`timeout=DEADLINE_S\` with \`DEADLINE_S = 10\`.
- \`bounce_kind == HARD_BOUNCE\` calls \`record_bounce(message_id, ...)\` and returns after one
  attempt; no \`while True\`, the loop is bounded by \`MAX_ATTEMPTS\`.
- The request is built with \`message_id=message_id\` from the caller; no \`uuid4()\`.
- On \`DEADLINE_EXCEEDED\` the client calls \`reconcile(message_id)\` and returns that outcome before
  any resend.
- \`RETRYABLE_CODES\` holds only \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\`; a \`suppressed\` reply
  returns at once.`,
  sequence: {
    participants: ['Email API', 'Relay', 'Message store'],
    messages: [
      {from: 'Email API', to: 'Relay', label: 'Send(SendRequest{message_id, recipient}) · deadline 10s', kind: 'sync'},
      {
        from: 'Relay',
        to: 'Email API',
        label: 'Accepted / Bounce{HARD} / Suppressed / DEADLINE_EXCEEDED',
        kind: 'reply',
      },
      {from: 'Email API', to: 'Message store', label: 'record_bounce(message_id, HARD) — terminal, once', kind: 'sync'},
      {from: 'Email API', to: 'Relay', label: 'Reconcile(message_id) after a timeout, before any resend', kind: 'sync'},
      {from: 'Email API', to: 'Relay', label: 'retry with the same message_id, bounded backoff', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every relay call carries a 10-second deadline',
      detail:
        'The call is made with a 10-second deadline taken from a named constant (`DEADLINE_S = 10`). The starter waits 30 seconds before giving up.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*10/, /timeout\s*=\s*DEADLINE_S/]},
        typescript: {all: [/DEADLINE_MS/, /deadline/]},
        go: {all: [/DeadlineSeconds\s*=\s*10/, /context\.WithTimeout/]},
        scala: {all: [/DeadlineSeconds\s*=\s*10/, /withDeadline/]},
        cpp: {all: [/kDeadlineSeconds\s*=\s*10/, /set_deadline/]},
      },
    },
    {
      id: 'hard-bounce-terminal',
      title: 'A hard bounce stops after one attempt and is recorded',
      detail:
        'A `HARD` bounce records the bounce and returns; there is no unbounded retry loop. The starter retries a hard bounce forever.',
      match: {
        python: {all: [/HARD_BOUNCE/, /record_bounce\(/], none: [/while True/]},
        typescript: {all: [/HARD_BOUNCE/, /recordBounce\(/], none: [/while\s*\(\s*true\s*\)/]},
        go: {all: [/BounceHard|hardBounce/, /recordBounce\(/], none: [/for\s*\{/]},
        scala: {all: [/HardBounce|HARD_BOUNCE/, /recordBounce\(/], none: [/while\s*\(\s*true\s*\)/]},
        cpp: {all: [/kHardBounce/, /recordBounce\(/], none: [/while\s*\(\s*true\s*\)/]},
      },
    },
    {
      id: 'same-message-id',
      title: 'Retries reuse the message id',
      detail:
        'The request is built from the `message_id` the caller supplied, so a retry is the same message. The starter generates a fresh id on every attempt.',
      match: {
        python: {all: [/message_id=message_id/], none: [/uuid4\(/]},
        typescript: {all: [/message_id:\s*messageId/], none: [/randomUUID\(/]},
        go: {all: [/MessageID:\s*messageID/], none: [/uuid\.New/]},
        scala: {all: [/messageId\s*=\s*messageId/], none: [/UUID\.randomUUID/]},
        cpp: {all: [/set_message_id\(message_id\)/], none: [/uuid/i]},
      },
    },
    {
      id: 'reconcile-before-resend',
      title: 'Reconciles a timeout by message id before resending',
      detail:
        'On `DEADLINE_EXCEEDED` the client reconciles the outcome for `message_id` before it sends again. The starter resends with a new id, so the mail is delivered twice.',
      match: {
        python: {all: [/reconcile\(/, /DEADLINE_EXCEEDED/]},
        typescript: {all: [/reconcile\(/, /DEADLINE_EXCEEDED/]},
        go: {all: [/Reconcile\(/, /DEADLINE_EXCEEDED/]},
        scala: {all: [/reconcile\(/, /DEADLINE_EXCEEDED/]},
        cpp: {all: [/reconcile\(/, /DEADLINE_EXCEEDED/]},
      },
    },
    {
      id: 'suppressed-terminal',
      title: 'A suppressed response is terminal, not retryable',
      detail:
        'Only `UNAVAILABLE` and `DEADLINE_EXCEEDED` are in `RETRYABLE_CODES`; a suppressed reply returns immediately. The starter adds suppressed to the retryable set.',
      match: {
        python: {all: [/RETRYABLE_CODES/, /suppressed/], none: [/RETRYABLE_CODES[^\n]*[Ss]uppressed/]},
        typescript: {all: [/RETRYABLE_CODES/, /suppressed/], none: [/RETRYABLE_CODES[^\n]*[Ss]uppressed/]},
        go: {all: [/RetryableCodes/, /Suppressed/], none: [/RetryableCodes[^\n]*Suppressed/]},
        scala: {all: [/RetryableCodes/, /[Ss]uppressed/], none: [/RetryableCodes[^\n]*[Ss]uppressed/]},
        cpp: {all: [/kRetryableCodes/, /suppressed/], none: [/kRetryableCodes[^\n]*suppressed/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time
import uuid

import grpc

import relay_pb2
import relay_pb2_grpc

MAX_ATTEMPTS = 3


def send(recipient: str, message_id: str) -> dict:
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    while True:
        request = relay_pb2.SendRequest(recipient=recipient, message_id=str(uuid.uuid4()))
        try:
            reply = stub.Send(request, timeout=30.0)
        except grpc.RpcError:
            time.sleep(2)
            continue
        if reply.bounce_kind == relay_pb2.BounceKind.HARD:
            time.sleep(2)
            continue
        if reply.suppressed:
            time.sleep(2)
            continue
        return {"state": "accepted", "message_id": request.message_id}
`,
      solution: `import time

import grpc

import relay_pb2
import relay_pb2_grpc

DEADLINE_S = 10.0
MAX_ATTEMPTS = 3
HARD_BOUNCE = relay_pb2.BounceKind.HARD
RETRYABLE_CODES = (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED)


def send(recipient: str, message_id: str) -> dict:
    """Deliver one message over gRPC, reusing the same message id across retries."""
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            reply = stub.Send(
                relay_pb2.SendRequest(recipient=recipient, message_id=message_id), timeout=DEADLINE_S
            )
        except grpc.RpcError as error:
            if error.code() not in RETRYABLE_CODES:
                raise
            if error.code() == grpc.StatusCode.DEADLINE_EXCEEDED:
                # Reconcile by message id before any resend.
                if relay_pb2_grpc.reconcile(stub, message_id):
                    return {"state": "accepted", "message_id": message_id}
            time.sleep(2 ** attempt)
            continue
        if reply.bounce_kind == HARD_BOUNCE:
            record_bounce(message_id, reply)
            return {"state": "bounced", "message_id": message_id}
        if reply.suppressed:
            return {"state": "suppressed", "message_id": message_id}
        return {"state": "accepted", "message_id": message_id}
    raise TimeoutError("relay unreachable")
`,
    },
    typescript: {
      starter: `import {Status, StatusCode} from '@grpc/grpc-js';
import {randomUUID} from 'node:crypto';

import {relayClient} from './relay';

const MAX_ATTEMPTS = 3;

const delay = (ms: number): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

export async function send(
  recipient: string,
  messageId: string,
): Promise<{state: string; message_id: string}> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  while (true) {
    const request = {recipient, message_id: randomUUID()};
    try {
      const reply = await relayClient.send(request);
      if (reply.bounce_kind === 'HARD') {
        await delay(2000);
        continue;
      }
      if (reply.suppressed) {
        await delay(2000);
        continue;
      }
      return {state: 'accepted', message_id: request.message_id};
    } catch {
      await delay(2000);
    }
  }
}
`,
      solution: `import {Status, StatusCode} from '@grpc/grpc-js';

import {relayClient} from './relay';

const DEADLINE_MS = 10_000;
const MAX_ATTEMPTS = 3;
const HARD_BOUNCE = 'HARD';
const RETRYABLE_CODES = [StatusCode.UNAVAILABLE, StatusCode.DEADLINE_EXCEEDED];

const delay = (ms: number): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

export async function send(
  recipient: string,
  messageId: string,
): Promise<{state: string; message_id: string}> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const reply = await relayClient.send(
        {recipient, message_id: messageId},
        {deadline: Date.now() + DEADLINE_MS},
      );
      if (reply.bounce_kind === HARD_BOUNCE) {
        await recordBounce(messageId, reply);
        return {state: 'bounced', message_id: messageId};
      }
      if (reply.suppressed) {
        return {state: 'suppressed', message_id: messageId};
      }
      return {state: 'accepted', message_id: messageId};
    } catch (error) {
      const code = (error as {code?: number}).code;
      if (code === undefined || !RETRYABLE_CODES.includes(code)) {
        throw error;
      }
      if (code === StatusCode.DEADLINE_EXCEEDED) {
        // Reconcile by message id before any resend.
        if (await reconcile(relayClient, messageId)) {
          return {state: 'accepted', message_id: messageId};
        }
      }
      await delay(2 ** attempt * 100);
    }
  }
  throw new Error('relay unreachable');
}
`,
    },
    go: {
      starter: `package client

import (
	"context"
	"time"

	"github.com/google/uuid"
	pb "email/relaypb"
)

const maxAttempts = 3

func Send(ctx context.Context, relay pb.RelayClient, recipient, messageID string) (string, error) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	for {
		reply, err := relay.Send(ctx, &pb.SendRequest{
			Recipient: recipient,
			MessageID: uuid.NewString(),
		})
		if err != nil {
			time.Sleep(2 * time.Second)
			continue
		}
		if reply.BounceKind == pb.BounceKind_HARD {
			time.Sleep(2 * time.Second)
			continue
		}
		if reply.Suppressed {
			time.Sleep(2 * time.Second)
			continue
		}
		return "accepted", nil
	}
}
`,
      solution: `package client

import (
	"context"
	"fmt"
	"time"

	pb "email/relaypb"
)

const (
	DeadlineSeconds = 10
	maxAttempts     = 3
	BounceHard      = pb.BounceKind_HARD
)

var RetryableCodes = map[string]bool{"UNAVAILABLE": true, "DEADLINE_EXCEEDED": true}

func Send(ctx context.Context, relay pb.RelayClient, recipient, messageID string) (string, error) {
	// Retries reuse the same message id; a timeout is reconciled before any resend.
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, DeadlineSeconds*time.Second)
		reply, err := relay.Send(callCtx, &pb.SendRequest{
			Recipient: recipient,
			MessageID: messageID,
		})
		cancel()
		if err == nil {
			if reply.BounceKind == BounceHard {
				recordBounce(messageID, reply)
				return "bounced", nil
			}
			if reply.Suppressed {
				return "suppressed", nil
			}
			return "accepted", nil
		}
		code := statusCode(err)
		if !RetryableCodes[code] {
			return "", err
		}
		if code == "DEADLINE_EXCEEDED" {
			// Reconcile by message id before any resend.
			if Reconcile(relay, messageID) {
				return "accepted", nil
			}
		}
		time.Sleep(time.Duration(attempt) * time.Second)
	}
	return "", fmt.Errorf("relay unreachable")
}
`,
    },
    scala: {
      starter: `package client

import scala.concurrent.duration._
import scala.util.{Failure, Success, Try}

object Client {
  val MaxAttempts = 3

  def send(relay: RelayStub, recipient: String, messageId: String): String = {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    while (true) {
      val request = SendRequest(recipient = recipient, messageId = java.util.UUID.randomUUID().toString)
      Try(relay.send(request)) match {
        case Success(reply) if reply.bounceKind == "HARD" => Thread.sleep(2000)
        case Success(reply) if reply.suppressed => Thread.sleep(2000)
        case Success(_) => return "accepted"
        case Failure(_) => Thread.sleep(2000)
      }
    }
    "unreachable"
  }
}
`,
      solution: `package client

import java.util.concurrent.TimeUnit

import scala.concurrent.duration._

object Client {
  val DeadlineSeconds = 10
  val MaxAttempts = 3
  val HardBounce = "HARD"
  val RetryableCodes: Set[String] = Set("UNAVAILABLE", "DEADLINE_EXCEEDED")

  def send(relay: RelayStub, recipient: String, messageId: String): String = {
    var attempt = 1
    var outcome: String = null
    while (outcome == null && attempt <= MaxAttempts) {
      attempt += 1
      Try(relay.send(SendRequest(recipient = recipient, messageId = messageId))
        .withDeadlineAfter(DeadlineSeconds.toLong, TimeUnit.SECONDS)) match {
        case Success(reply) if reply.bounceKind == HardBounce =>
          recordBounce(messageId, reply)
          outcome = "bounced"
        case Success(reply) if reply.suppressed =>
          outcome = "suppressed"
        case Success(_) =>
          outcome = "accepted"
        case Failure(error) =>
          val code = statusCode(error)
          if (!RetryableCodes.contains(code)) {
            throw error
          }
          if (code == "DEADLINE_EXCEEDED") {
            // Reconcile by message id before any resend.
            if (reconcile(relay, messageId)) {
              outcome = "accepted"
            }
          }
          if (outcome == null) Thread.sleep(attempt * 1000L)
      }
    }
    if (outcome == null) throw new RuntimeException("relay unreachable")
    outcome
  }
}
`,
    },
    cpp: {
      starter: `#include "relay.grpc.pb.h"

#include <chrono>
#include <string>
#include <thread>

namespace client {

constexpr int kMaxAttempts = 3;

std::string send(relay::Relay::Stub& stub, const std::string& recipient, const std::string& message_id) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  while (true) {
    relay::SendRequest request;
    request.set_recipient(recipient);
    request.set_message_id(uuidString());
    grpc::ClientContext context;
    relay::SendReply reply;
    const grpc::Status status = stub.Send(&context, request, &reply);
    if (!status.ok()) {
      std::this_thread::sleep_for(std::chrono::seconds(2));
      continue;
    }
    if (reply.bounce_kind() == relay::HARD) {
      std::this_thread::sleep_for(std::chrono::seconds(2));
      continue;
    }
    if (reply.suppressed()) {
      std::this_thread::sleep_for(std::chrono::seconds(2));
      continue;
    }
    return "accepted";
  }
}

}  // namespace client
`,
      solution: `#include "relay.grpc.pb.h"

#include <chrono>
#include <string>
#include <thread>

namespace client {

constexpr int kDeadlineSeconds = 10;
constexpr int kMaxAttempts = 3;
const std::string kHardBounce = "HARD";
const std::vector<std::string> kRetryableCodes = {"UNAVAILABLE", "DEADLINE_EXCEEDED"};

std::string send(relay::Relay::Stub& stub, const std::string& recipient, const std::string& message_id) {
  for (int attempt = 1; attempt <= kMaxAttempts; ++attempt) {
    relay::SendRequest request;
    request.set_recipient(recipient);
    request.set_message_id(message_id);
    grpc::ClientContext context;
    context.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(kDeadlineSeconds));
    relay::SendReply reply;
    const grpc::Status status = stub.Send(&context, request, &reply);
    if (status.ok()) {
      if (reply.bounce_kind() == kHardBounce) {
        recordBounce(message_id, reply);
        return "bounced";
      }
      if (reply.suppressed()) {
        return "suppressed";
      }
      return "accepted";
    }
    const std::string code = statusCode(status);
    if (std::find(kRetryableCodes.begin(), kRetryableCodes.end(), code) == kRetryableCodes.end()) {
      return "";
    }
    if (code == "DEADLINE_EXCEEDED") {
      // Reconcile by message id before any resend.
      if (reconcile(stub, message_id)) {
        return "accepted";
      }
    }
    std::this_thread::sleep_for(std::chrono::seconds(attempt));
  }
  return "";
}

}  // namespace client
`,
    },
  },
  hints: [
    'One recipient received the same receipt twice after a relay blip, and the relay logs show a bounced address being retried every two seconds all night.',
    'Each loop iteration mints a new `uuid4()`, so a resend after a timeout is a different message to the relay, and the `HARD` branch sleeps and continues instead of returning.',
    'Build the request with `message_id=message_id`, make `HARD_BOUNCE` call `record_bounce` and return, and on `DEADLINE_EXCEEDED` call `reconcile(message_id)` first. `DEADLINE_S`, `RETRYABLE_CODES` and `MAX_ATTEMPTS` cover the rest.',
  ],
  debrief: `The fix separates three kinds of relay answer. A hard bounce and a suppressed reply are facts about the recipient, so retrying cannot change them; they are recorded and returned. \`UNAVAILABLE\` is a fact about the relay, so a bounded retry under the same message id is correct. \`DEADLINE_EXCEEDED\` is no fact at all: the message may or may not have gone out, which is why the client asks the relay about \`message_id\` before it sends again, and why the id must come from the caller rather than from each attempt. Production relay clients add jittered exponential backoff, a per-category retry budget so a relay outage cannot multiply traffic, and deduplication on the relay side keyed by the message id, so a reconcile that itself times out still cannot double-deliver.`,
};
