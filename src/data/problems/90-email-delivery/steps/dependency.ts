import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Relay calls with bounce-aware retries',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'relay', 'store'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it calls the relay and returns
on the happy path, so the demo passes. It hides three flaws in the failure paths — the paths the demo
never exercises. Find them, fix them, and prove the fix.

Implement the gRPC relay client used by every send:

- Every relay call carries a **10-second deadline** (\`DEADLINE_S = 10\`); the draft waits 30 seconds,
  so a slow relay holds the worker for three times as long as it should.
- A **hard bounce is terminal**: the reply's \`bounce_kind == HARD\` is recorded and the call returns
  after one attempt. The draft treats a hard bounce like any error and retries it forever.
- Retries **reuse the same message id**: the id is the parameter the caller supplied, so a retry is
  the same message. The draft generates a fresh \`uuid4()\` on every attempt.
- A **timeout is reconciled by message id before any resend**: on \`DEADLINE_EXCEEDED\` the client asks
  the relay what happened to \`message_id\` and returns the reconciled outcome instead of sending
  again. The draft resends immediately with a new id, so the mail goes out twice.
- A **suppressed response is terminal**, not retryable: only \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` are
  in \`RETRYABLE_CODES\`. The draft retries a suppressed reply.

**Failure mode the checks target.** Retrying a hard bounce keeps hammering a dead address for a week;
a new message id on a timeout resend delivers duplicates; treating a suppressed reply as retryable
re-sends to an address the platform promised to leave alone.`,
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
        'The call is made with a 10-second deadline taken from a named constant (`DEADLINE_S = 10`). The draft waits 30 seconds before giving up.',
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
        'A `HARD` bounce records the bounce and returns; there is no unbounded retry loop. The draft retries a hard bounce forever.',
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
        'The request is built from the `message_id` the caller supplied, so a retry is the same message. The draft generates a fresh id on every attempt.',
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
        'On `DEADLINE_EXCEEDED` the client reconciles the outcome for `message_id` before it sends again. The draft resends with a new id, so the mail is delivered twice.',
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
        'Only `UNAVAILABLE` and `DEADLINE_EXCEEDED` are in `RETRYABLE_CODES`; a suppressed reply returns immediately. The draft adds suppressed to the retryable set.',
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
    # TODO: this draft retries hard bounces forever, resends after a timeout with a new message id
    # so the mail is delivered twice, and treats a suppressed response as retryable.
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
  // TODO: this draft retries hard bounces forever, resends after a timeout with a new message id
  // so the mail is delivered twice, and treats a suppressed response as retryable.
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
	// TODO: this draft retries hard bounces forever, resends after a timeout with a new message id
	// so the mail is delivered twice, and treats a suppressed response as retryable.
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
    // TODO: this draft retries hard bounces forever, resends after a timeout with a new message id
    // so the mail is delivered twice, and treats a suppressed response as retryable.
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
  // TODO: this draft retries hard bounces forever, resends after a timeout with a new message id
  // so the mail is delivered twice, and treats a suppressed response as retryable.
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
    'A hard bounce is a terminal signal, not an error: `bounce_kind == HARD` records the bounce and returns. Only `UNAVAILABLE` and `DEADLINE_EXCEEDED` belong in `RETRYABLE_CODES`, and a bounded `for` loop replaces the draft’s `while True`.',
    'A retry is the same message: build the request from the `message_id` the caller passed in. A fresh `uuid4()` per attempt turns one message into several deliveries.',
    'A timeout leaves the outcome unknown, so reconcile it: ask the relay for `message_id` before sending again. Re-sending first is how a duplicate is delivered.',
  ],
  debrief: `The interviewer is testing whether you can review the failure paths of a gRPC client. The draft reads fine because the demo relay accepts everything. Three defects are being checked: an unbounded retry that ignores a terminal hard bounce; a fresh message id on retry, so a timeout resend delivers a duplicate; and a suppressed reply in the retryable set. The fix is a bounded loop with a deadline, one message id for the whole attempt sequence, reconciliation on timeout, and a small retryable set. Real relays add per-category retry budgets, jittered backoff, and idempotency keys the relay itself deduplicates on.`,
};
