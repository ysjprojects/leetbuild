import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Relay calls with one message id and terminal bounces',
  concept: 'grpc',
  guides: ['deadlines-and-retries'],
  file: 'dispatch',
  focus: ['api', 'relay', 'store', 'redis'],
  task: `## Task

**Starting point.** The starter's \`deliver(message_id)\` hands a queued message to the relay over
gRPC (\`Relay.SendMail\`) in up to \`MAX_ATTEMPTS\` (3) attempts, each with a 30-second deadline and
the request's \`message_id\` set to \`{message_id}-{attempt}\`. It records every attempt, marks the
message \`sent\` on \`accepted\`, and on anything else sleeps \`BACKOFF_S\` and tries again, ending in
\`deferred\`. With a healthy relay it delivers, and it hides four flaws.

**Failure mode the checks target.** A stalled relay holds a worker for 30 seconds an attempt; a
timeout whose reply was lost is resent and the customer gets the email twice; and a dead address
is asked three times, then stays mailable.

\`\`\`proto
service Relay {
  rpc SendMail(SendMailRequest) returns (Delivery);  // accepted, soft_bounce, hard_bounce, suppressed
  rpc GetStatus(StatusRequest) returns (Delivery);   // the verdict for a message id, or unknown
}
\`\`\`

- Every call carries a \`DEADLINE_S\` = 10 s deadline.
- Every attempt sends the message's own id: the relay mails an id once.
- \`hard_bounce\` is terminal: state \`bounced\` with its \`bounce_category\`, and
  \`gate.suppress(recipient)\`. \`suppressed\` is terminal too. Only \`UNAVAILABLE\` and \`soft_bounce\`
  are retried, after \`BACKOFF_S\`.
- On \`DEADLINE_EXCEEDED\`, ask \`GetStatus(message_id)\` before sending again: its verdict settles
  the attempt, and \`unknown\` means the relay never got the message.`,
  sequence: {
    participants: ['Dispatcher', 'Relay', 'Message store', 'Gate'],
    messages: [
      {from: 'Dispatcher', to: 'Relay', label: 'SendMail(message_id) · deadline 10 s', kind: 'sync'},
      {from: 'Relay', to: 'Dispatcher', label: 'DEADLINE_EXCEEDED (reply lost)', kind: 'reply'},
      {from: 'Dispatcher', to: 'Relay', label: 'GetStatus(message_id)', kind: 'sync'},
      {from: 'Relay', to: 'Dispatcher', label: 'accepted · hard_bounce · unknown → resend same id', kind: 'reply'},
      {from: 'Dispatcher', to: 'Message store', label: 'record_attempt · set_state', kind: 'sync'},
      {from: 'Dispatcher', to: 'Gate', label: 'hard_bounce → suppress(recipient)', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every relay call carries a 10-second deadline',
      detail:
        'SendMail and GetStatus are called with `DEADLINE_S` (10 s); the starter waits 30 seconds an attempt on a stalled relay.',
      match: {
        python: {
          all: [/DEADLINE_S\s*=\s*10\b/, /SendMail\([\s\S]{0,120}?timeout\s*=\s*DEADLINE_S/],
          none: [/timeout\s*=\s*30\b/],
        },
        typescript: {
          all: [/DEADLINE_MS\s*=\s*10_?000\b/, /SendMail\([\s\S]{0,160}?deadline:[^\n]*DEADLINE_MS/],
          none: [/30_?000/],
        },
        go: {
          all: [/deadline\s*=\s*10\s*\*\s*time\.Second/, /context\.WithTimeout\([^\n]*deadline\)/],
          none: [/30\s*\*\s*time\.Second/],
        },
        scala: {
          all: [/DeadlineSeconds\s*=\s*10L?\b/, /withDeadlineAfter\(\s*DeadlineSeconds/],
          none: [/withDeadlineAfter\(\s*30/],
        },
        cpp: {all: [/kDeadline\{10\}/, /set_deadline\([^\n]*kDeadline\)/], none: [/seconds\{30\}|seconds\(30\)/]},
      },
    },
    {
      id: 'same-message-id',
      title: "Retries carry the message's own id",
      detail:
        'Every SendMail carries the message id the store assigned, so the relay can answer a retry with its first verdict; the starter appends the attempt number, which makes each retry a new email.',
      match: {
        python: {all: [/message_id\s*=\s*message_id\b/], none: [/f["']\{message_id\}-/, /uuid/]},
        typescript: {all: [/message_id:\s*messageId\b/], none: [/\$\{messageId\}-/, /randomUUID/]},
        go: {all: [/MessageId:\s*messageID\b/], none: [/Sprintf\([^\n]*messageID,\s*attempt/]},
        scala: {all: [/messageId\s*=\s*messageId\b/], none: [/s"\$messageId-/]},
        cpp: {all: [/set_message_id\(\s*message_id\s*\)/], none: [/message_id \+ "-"/]},
      },
    },
    {
      id: 'terminal-outcomes',
      title: 'A hard bounce is recorded and suppressed, not retried',
      detail:
        '`hard_bounce` ends the message in `bounced` with its `bounce_category` and suppresses the recipient through the gate; `suppressed` ends it too. Neither is sent again.',
      match: {
        python: {all: [/["']hard_bounce["']/, /gate\.suppress\(/, /bounce_category/]},
        typescript: {all: [/['"]hard_bounce['"]/, /\bsuppress\(/, /bounce_category/]},
        go: {all: [/"hard_bounce"/, /gate\.Suppress\(/, /BounceCategory/]},
        scala: {all: [/"hard_bounce"/, /Gate\.suppress\(/, /bounceCategory/]},
        cpp: {all: [/"hard_bounce"/, /gate::suppress\(/, /bounce_category\(\)/]},
      },
    },
    {
      id: 'reconcile-timeout',
      title: 'Asks GetStatus before resending after a timeout',
      detail:
        'A `DEADLINE_EXCEEDED` leaves the outcome unknown, so the client asks `GetStatus(message_id)` and resends only when the relay never saw the message.',
      match: {
        python: {all: [/DEADLINE_EXCEEDED/, /GetStatus\(/]},
        typescript: {all: [/DEADLINE_EXCEEDED/, /GetStatus\(/]},
        go: {all: [/codes\.DeadlineExceeded/, /GetStatus\(/]},
        scala: {all: [/DEADLINE_EXCEEDED/, /getStatus\(/]},
        cpp: {all: [/DEADLINE_EXCEEDED/, /GetStatus\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import grpc

import email_delivery_pb2 as pb
import email_delivery_pb2_grpc as pb_grpc
from mail import gate, store  # gate.suppress(address); store.load, record_attempt, set_state

MAX_ATTEMPTS = 3
BACKOFF_S = 2

relay = pb_grpc.RelayStub(grpc.insecure_channel("relay:9000"))


def deliver(message_id: str) -> str:
    """Hand a queued message to the relay; returns the state it ends in (sent, bounced, suppressed or deferred)."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    message = store.load(message_id)
    for attempt in range(MAX_ATTEMPTS):
        request = pb.SendMailRequest(
            message_id=f"{message_id}-{attempt}",
            recipient=message["recipient"],
            template_id=message["template_id"],
            subject=message["subject"],
            variables=message["variables"],
        )
        try:
            delivery = relay.SendMail(request, timeout=30)
        except grpc.RpcError:
            store.record_attempt(message_id, "error")
            time.sleep(BACKOFF_S)
            continue
        store.record_attempt(message_id, delivery.outcome)
        if delivery.outcome == "accepted":
            store.set_state(message_id, "sent")
            return "sent"
        time.sleep(BACKOFF_S)
    store.set_state(message_id, "deferred")
    return "deferred"
`,
      solution: `import time

import grpc

import email_delivery_pb2 as pb
import email_delivery_pb2_grpc as pb_grpc
from mail import gate, store  # gate.suppress(address); store.load, record_attempt, set_state

DEADLINE_S = 10
MAX_ATTEMPTS = 3
BACKOFF_S = 2

relay = pb_grpc.RelayStub(grpc.insecure_channel("relay:9000"))


def deliver(message_id: str) -> str:
    """Hand a queued message to the relay; returns the state it ends in (sent, bounced, suppressed or deferred)."""
    message = store.load(message_id)
    # One request, one id, for every attempt: the relay answers a retry with its first verdict.
    request = pb.SendMailRequest(
        message_id=message_id,
        recipient=message["recipient"],
        template_id=message["template_id"],
        subject=message["subject"],
        variables=message["variables"],
    )
    for _ in range(MAX_ATTEMPTS):
        try:
            delivery = relay.SendMail(request, timeout=DEADLINE_S)
        except grpc.RpcError as exc:
            if exc.code() == grpc.StatusCode.UNAVAILABLE:
                store.record_attempt(message_id, "unavailable")
                time.sleep(BACKOFF_S)
                continue
            if exc.code() != grpc.StatusCode.DEADLINE_EXCEEDED:
                raise
            # The relay may have taken the message before its reply was lost: ask before sending again.
            delivery = relay.GetStatus(pb.StatusRequest(message_id=message_id), timeout=DEADLINE_S)
            if delivery.outcome == "unknown":
                store.record_attempt(message_id, "timeout")
                continue
        store.record_attempt(message_id, delivery.outcome)
        if delivery.outcome == "accepted":
            store.set_state(message_id, "sent")
            return "sent"
        if delivery.outcome == "hard_bounce":
            # The mailbox does not exist: record why, and never mail it again.
            store.set_state(message_id, "bounced", delivery.bounce_category)
            gate.suppress(message["recipient"])
            return "bounced"
        if delivery.outcome == "suppressed":
            store.set_state(message_id, "suppressed")
            return "suppressed"
        time.sleep(BACKOFF_S)  # soft_bounce: the mailbox may take it later
    store.set_state(message_id, "deferred")
    return "deferred"
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {suppress} from 'mail/gate';
import {load, recordAttempt, setState} from 'mail/store';

export const MAX_ATTEMPTS = 3;
export const BACKOFF_MS = 2000;

interface Delivery {
  outcome: string;
  bounce_category: string;
}

interface SendMailRequest {
  message_id: string;
  recipient: string;
  template_id: string;
  subject: string;
  variables: Record<string, string>;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('email_delivery.proto')) as unknown as {
  smtprelay: {Relay: grpc.ServiceClientConstructor};
};
const relay = new pkg.smtprelay.Relay('relay:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  SendMail(request: SendMailRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<Delivery>;
  GetStatus(request: {message_id: string}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<Delivery>;
};

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Hand a queued message to the relay; resolves to the state it ends in (sent, bounced, suppressed or deferred). */
export async function deliver(messageId: string): Promise<string> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const message = await load(messageId);
  if (message === null) throw new Error(\`no message \${messageId}\`);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const request = {
      message_id: \`\${messageId}-\${attempt}\`,
      recipient: message.recipient,
      template_id: message.template_id,
      subject: message.subject,
      variables: message.variables,
    };
    let delivery: Delivery;
    try {
      delivery = await relay.SendMail(request, new grpc.Metadata(), {deadline: Date.now() + 30_000});
    } catch {
      await recordAttempt(messageId, 'error');
      await sleep(BACKOFF_MS);
      continue;
    }
    await recordAttempt(messageId, delivery.outcome);
    if (delivery.outcome === 'accepted') {
      await setState(messageId, 'sent');
      return 'sent';
    }
    await sleep(BACKOFF_MS);
  }
  await setState(messageId, 'deferred');
  return 'deferred';
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {suppress} from 'mail/gate';
import {load, recordAttempt, setState} from 'mail/store';

export const DEADLINE_MS = 10_000;
export const MAX_ATTEMPTS = 3;
export const BACKOFF_MS = 2000;

interface Delivery {
  outcome: string;
  bounce_category: string;
}

interface SendMailRequest {
  message_id: string;
  recipient: string;
  template_id: string;
  subject: string;
  variables: Record<string, string>;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('email_delivery.proto')) as unknown as {
  smtprelay: {Relay: grpc.ServiceClientConstructor};
};
const relay = new pkg.smtprelay.Relay('relay:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  SendMail(request: SendMailRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<Delivery>;
  GetStatus(request: {message_id: string}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<Delivery>;
};

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Hand a queued message to the relay; resolves to the state it ends in (sent, bounced, suppressed or deferred). */
export async function deliver(messageId: string): Promise<string> {
  const message = await load(messageId);
  if (message === null) throw new Error(\`no message \${messageId}\`);
  // One request, one id, for every attempt: the relay answers a retry with its first verdict.
  const request = {
    message_id: messageId,
    recipient: message.recipient,
    template_id: message.template_id,
    subject: message.subject,
    variables: message.variables,
  };
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let delivery: Delivery;
    try {
      delivery = await relay.SendMail(request, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
    } catch (e) {
      const {code} = e as grpc.ServiceError;
      if (code === grpc.status.UNAVAILABLE) {
        await recordAttempt(messageId, 'unavailable');
        await sleep(BACKOFF_MS);
        continue;
      }
      if (code !== grpc.status.DEADLINE_EXCEEDED) throw e;
      // The relay may have taken the message before its reply was lost: ask before sending again.
      delivery = await relay.GetStatus({message_id: messageId}, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
      if (delivery.outcome === 'unknown') {
        await recordAttempt(messageId, 'timeout');
        continue;
      }
    }
    await recordAttempt(messageId, delivery.outcome);
    if (delivery.outcome === 'accepted') {
      await setState(messageId, 'sent');
      return 'sent';
    }
    if (delivery.outcome === 'hard_bounce') {
      // The mailbox does not exist: record why, and never mail it again.
      await setState(messageId, 'bounced', delivery.bounce_category);
      await suppress(message.recipient);
      return 'bounced';
    }
    if (delivery.outcome === 'suppressed') {
      await setState(messageId, 'suppressed');
      return 'suppressed';
    }
    await sleep(BACKOFF_MS); // soft_bounce: the mailbox may take it later
  }
  await setState(messageId, 'deferred');
  return 'deferred';
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"fmt"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "mail/gen/email_delivery"
	"mail/store" // store.Load, RecordAttempt, SetState; "mail/gate" has gate.Suppress(ctx, address)
)

const (
	maxAttempts = 3
	backoff     = 2 * time.Second
)

var (
	relayConn, _ = grpc.NewClient("relay:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	relay        = pb.NewRelayClient(relayConn)
)

// deliver hands a queued message to the relay and returns the state it ends in (sent, bounced,
// suppressed or deferred).
func deliver(ctx context.Context, messageID string) (string, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	message := store.Load(ctx, messageID)
	if message == nil {
		return "", fmt.Errorf("no message %s", messageID)
	}
	for attempt := 0; attempt < maxAttempts; attempt++ {
		request := &pb.SendMailRequest{MessageId: fmt.Sprintf("%s-%d", messageID, attempt), Recipient: message.Recipient,
			TemplateId: message.TemplateID, Subject: message.Subject, Variables: message.Variables}
		callCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		delivery, err := relay.SendMail(callCtx, request)
		cancel()
		if err != nil {
			store.RecordAttempt(ctx, messageID, "error")
			time.Sleep(backoff)
			continue
		}
		store.RecordAttempt(ctx, messageID, delivery.GetOutcome())
		if delivery.GetOutcome() == "accepted" {
			store.SetState(ctx, messageID, "sent", "")
			return "sent", nil
		}
		time.Sleep(backoff)
	}
	store.SetState(ctx, messageID, "deferred", "")
	return "deferred", nil
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "mail/gen/email_delivery"
	"mail/gate"  // gate.Suppress(ctx, address)
	"mail/store" // store.Load, RecordAttempt, SetState
)

const (
	deadline    = 10 * time.Second
	maxAttempts = 3
	backoff     = 2 * time.Second
)

var (
	relayConn, _ = grpc.NewClient("relay:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	relay        = pb.NewRelayClient(relayConn)
)

// deliver hands a queued message to the relay and returns the state it ends in (sent, bounced,
// suppressed or deferred).
func deliver(ctx context.Context, messageID string) (string, error) {
	message := store.Load(ctx, messageID)
	if message == nil {
		return "", fmt.Errorf("no message %s", messageID)
	}
	// One request, one id, for every attempt: the relay answers a retry with its first verdict.
	request := &pb.SendMailRequest{MessageId: messageID, Recipient: message.Recipient,
		TemplateId: message.TemplateID, Subject: message.Subject, Variables: message.Variables}
	for attempt := 0; attempt < maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		delivery, err := relay.SendMail(callCtx, request)
		cancel()
		switch status.Code(err) {
		case codes.OK:
		case codes.Unavailable:
			store.RecordAttempt(ctx, messageID, "unavailable")
			time.Sleep(backoff)
			continue
		case codes.DeadlineExceeded:
			// The relay may have taken the message before its reply was lost: ask before sending again.
			statusCtx, cancelStatus := context.WithTimeout(ctx, deadline)
			delivery, err = relay.GetStatus(statusCtx, &pb.StatusRequest{MessageId: messageID})
			cancelStatus()
			if err != nil {
				return "", err
			}
			if delivery.GetOutcome() == "unknown" {
				store.RecordAttempt(ctx, messageID, "timeout")
				continue
			}
		default:
			return "", err
		}
		store.RecordAttempt(ctx, messageID, delivery.GetOutcome())
		switch delivery.GetOutcome() {
		case "accepted":
			store.SetState(ctx, messageID, "sent", "")
			return "sent", nil
		case "hard_bounce":
			// The mailbox does not exist: record why, and never mail it again.
			store.SetState(ctx, messageID, "bounced", delivery.GetBounceCategory())
			return "bounced", gate.Suppress(ctx, message.Recipient)
		case "suppressed":
			store.SetState(ctx, messageID, "suppressed", "")
			return "suppressed", nil
		}
		time.Sleep(backoff) // soft_bounce: the mailbox may take it later
	}
	store.SetState(ctx, messageID, "deferred", "")
	return "deferred", nil
}
`,
    },
    scala: {
      starter: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}
import smtprelay.email_delivery.{Delivery, RelayGrpc, SendMailRequest}

import mail.{Gate, Store} // Gate.suppress(address); Store.load, recordAttempt, setState

object Dispatch {
  val MaxAttempts = 3
  val BackoffMillis = 2000L

  private val relay = RelayGrpc.blockingStub(ManagedChannelBuilder.forAddress("relay", 9000).usePlaintext().build())

  /** Hand a queued message to the relay; returns the state it ends in (sent, bounced, suppressed or deferred). */
  def deliver(messageId: String): String = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val message = Store.load(messageId).getOrElse(throw new NoSuchElementException(s"no message $messageId"))
    def attempt(n: Int): String =
      if (n >= MaxAttempts) {
        Store.setState(messageId, "deferred")
        "deferred"
      } else {
        val request = SendMailRequest(messageId = s"$messageId-$n", recipient = message.recipient, templateId = message.templateId,
          subject = message.subject, variables = message.variables)
        val delivery: Option[Delivery] =
          try Some(relay.withDeadlineAfter(30, TimeUnit.SECONDS).sendMail(request))
          catch { case _: StatusRuntimeException => None }
        delivery match {
          case Some(d) if d.outcome == "accepted" =>
            Store.recordAttempt(messageId, d.outcome)
            Store.setState(messageId, "sent")
            "sent"
          case other =>
            Store.recordAttempt(messageId, other.map(_.outcome).getOrElse("error"))
            Thread.sleep(BackoffMillis)
            attempt(n + 1)
        }
      }
    attempt(0)
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}
import smtprelay.email_delivery.{Delivery, RelayGrpc, SendMailRequest, StatusRequest}

import mail.{Gate, Store} // Gate.suppress(address); Store.load, recordAttempt, setState

object Dispatch {
  val DeadlineSeconds = 10L
  val MaxAttempts = 3
  val BackoffMillis = 2000L

  private val relay = RelayGrpc.blockingStub(ManagedChannelBuilder.forAddress("relay", 9000).usePlaintext().build())

  /** One SendMail; None when the attempt settled nothing (unavailable, or a timeout the relay never saw). */
  private def sendOnce(messageId: String, request: SendMailRequest): Option[Delivery] =
    try Some(relay.withDeadlineAfter(DeadlineSeconds, TimeUnit.SECONDS).sendMail(request))
    catch {
      case e: StatusRuntimeException if e.getStatus.getCode == Status.Code.UNAVAILABLE =>
        Store.recordAttempt(messageId, "unavailable")
        Thread.sleep(BackoffMillis)
        None
      case e: StatusRuntimeException if e.getStatus.getCode == Status.Code.DEADLINE_EXCEEDED =>
        // The relay may have taken the message before its reply was lost: ask before sending again.
        val status = relay.withDeadlineAfter(DeadlineSeconds, TimeUnit.SECONDS).getStatus(StatusRequest(messageId = messageId))
        if (status.outcome == "unknown") {
          Store.recordAttempt(messageId, "timeout")
          None
        } else Some(status)
    }

  /** Hand a queued message to the relay; returns the state it ends in (sent, bounced, suppressed or deferred). */
  def deliver(messageId: String): String = {
    val message = Store.load(messageId).getOrElse(throw new NoSuchElementException(s"no message $messageId"))
    // One request, one id, for every attempt: the relay answers a retry with its first verdict.
    val request = SendMailRequest(messageId = messageId, recipient = message.recipient, templateId = message.templateId,
      subject = message.subject, variables = message.variables)
    def attempt(n: Int): String =
      if (n >= MaxAttempts) {
        Store.setState(messageId, "deferred")
        "deferred"
      } else
        sendOnce(messageId, request) match {
          case None => attempt(n + 1)
          case Some(delivery) =>
            Store.recordAttempt(messageId, delivery.outcome)
            delivery.outcome match {
              case "accepted" =>
                Store.setState(messageId, "sent")
                "sent"
              case "hard_bounce" =>
                // The mailbox does not exist: record why, and never mail it again.
                Store.setState(messageId, "bounced", delivery.bounceCategory)
                Gate.suppress(message.recipient)
                "bounced"
              case "suppressed" =>
                Store.setState(messageId, "suppressed")
                "suppressed"
              case _ =>
                Thread.sleep(BackoffMillis) // soft_bounce: the mailbox may take it later
                attempt(n + 1)
            }
        }
    attempt(0)
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <stdexcept>
#include <string>
#include <thread>

#include "email_delivery.grpc.pb.h"
#include "mail/gate.h"   // mail::gate::suppress(address)
#include "mail/store.h"  // mail::store::load, recordAttempt, setState

namespace store = mail::store;

constexpr int kMaxAttempts = 3;
constexpr std::chrono::seconds kBackoff{2};

auto relay = smtprelay::Relay::NewStub(grpc::CreateChannel("relay:9000", grpc::InsecureChannelCredentials()));

// Hand a queued message to the relay; returns the state it ends in (sent, bounced, suppressed or deferred).
std::string deliver(const std::string& message_id) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const auto message = store::load(message_id);
  if (!message) throw std::out_of_range("no message " + message_id);
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    smtprelay::SendMailRequest request;
    request.set_message_id(message_id + "-" + std::to_string(attempt));
    request.set_recipient(message->recipient);
    request.set_template_id(message->template_id);
    request.set_subject(message->subject);
    for (const auto& [name, value] : message->variables) (*request.mutable_variables())[name] = value;
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds{30});
    smtprelay::Delivery delivery;
    if (!relay->SendMail(&ctx, request, &delivery).ok()) {
      store::recordAttempt(message_id, "error");
      std::this_thread::sleep_for(kBackoff);
      continue;
    }
    store::recordAttempt(message_id, delivery.outcome());
    if (delivery.outcome() == "accepted") {
      store::setState(message_id, "sent");
      return "sent";
    }
    std::this_thread::sleep_for(kBackoff);
  }
  store::setState(message_id, "deferred");
  return "deferred";
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <stdexcept>
#include <string>
#include <thread>

#include "email_delivery.grpc.pb.h"
#include "mail/gate.h"   // mail::gate::suppress(address)
#include "mail/store.h"  // mail::store::load, recordAttempt, setState

namespace store = mail::store;
namespace gate = mail::gate;

constexpr std::chrono::seconds kDeadline{10};
constexpr int kMaxAttempts = 3;
constexpr std::chrono::seconds kBackoff{2};

auto relay = smtprelay::Relay::NewStub(grpc::CreateChannel("relay:9000", grpc::InsecureChannelCredentials()));

// Hand a queued message to the relay; returns the state it ends in (sent, bounced, suppressed or deferred).
std::string deliver(const std::string& message_id) {
  const auto message = store::load(message_id);
  if (!message) throw std::out_of_range("no message " + message_id);
  // One request, one id, for every attempt: the relay answers a retry with its first verdict.
  smtprelay::SendMailRequest request;
  request.set_message_id(message_id);
  request.set_recipient(message->recipient);
  request.set_template_id(message->template_id);
  request.set_subject(message->subject);
  for (const auto& [name, value] : message->variables) (*request.mutable_variables())[name] = value;
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    smtprelay::Delivery delivery;
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    const grpc::Status sent = relay->SendMail(&ctx, request, &delivery);
    if (sent.error_code() == grpc::StatusCode::UNAVAILABLE) {
      store::recordAttempt(message_id, "unavailable");
      std::this_thread::sleep_for(kBackoff);
      continue;
    }
    if (sent.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED) {
      // The relay may have taken the message before its reply was lost: ask before sending again.
      grpc::ClientContext status_ctx;
      status_ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
      smtprelay::StatusRequest status_request;
      status_request.set_message_id(message_id);
      const grpc::Status asked = relay->GetStatus(&status_ctx, status_request, &delivery);
      if (!asked.ok()) throw std::runtime_error("relay status: " + asked.error_message());
      if (delivery.outcome() == "unknown") {
        store::recordAttempt(message_id, "timeout");
        continue;
      }
    } else if (!sent.ok()) {
      throw std::runtime_error("relay: " + sent.error_message());
    }
    store::recordAttempt(message_id, delivery.outcome());
    if (delivery.outcome() == "accepted") {
      store::setState(message_id, "sent");
      return "sent";
    }
    if (delivery.outcome() == "hard_bounce") {
      // The mailbox does not exist: record why, and never mail it again.
      store::setState(message_id, "bounced", delivery.bounce_category());
      gate::suppress(message->recipient);
      return "bounced";
    }
    if (delivery.outcome() == "suppressed") {
      store::setState(message_id, "suppressed");
      return "suppressed";
    }
    std::this_thread::sleep_for(kBackoff);  // soft_bounce: the mailbox may take it later
  }
  store::setState(message_id, "deferred");
  return "deferred";
}
`,
    },
  },
  harness: {
    python: `import grpc

import email_delivery_pb2 as pb
import email_delivery_pb2_grpc as pb_grpc
from mail import store


class Relay(pb_grpc.RelayServicer):
    """Accepts every recipient but bounce@ (hard bounce, mailbox_unknown) and blocked@ (on the relay's
    own list). A message id it already took answers its first verdict and is not mailed again; the
    first lose_replies replies are lost after the relay took the message."""

    def __init__(self):
        self.verdicts = {}
        self.mailed = []
        self.lose_replies = 0

    def SendMail(self, request, context):
        verdict = self.verdicts.get(request.message_id)
        if verdict is None:
            if request.recipient.startswith("bounce@"):
                verdict = pb.Delivery(outcome="hard_bounce", bounce_category="mailbox_unknown")
            elif request.recipient.startswith("blocked@"):
                verdict = pb.Delivery(outcome="suppressed")
            else:
                verdict = pb.Delivery(outcome="accepted")
                self.mailed.append(request.recipient)
            self.verdicts[request.message_id] = verdict
        if self.lose_replies > 0:
            self.lose_replies -= 1
            context.abort(grpc.StatusCode.DEADLINE_EXCEEDED, "the relay took the message; its reply was lost")
        return verdict

    def GetStatus(self, request, context):
        return self.verdicts.get(request.message_id, pb.Delivery(outcome="unknown"))


def _setup(ctx):
    relay = Relay()
    ctx.grpc.serve(pb_grpc.add_RelayServicer_to_server, relay)
    return ctx.load("dispatch"), relay


def _message(recipient="ana@example.com"):
    return store.enqueue("t-1", recipient, "welcome", "Welcome", {"first_name": "Ana"})


def check_deadline(ctx):
    m, _ = _setup(ctx)
    message_id = _message()
    state = m.deliver(message_id)
    assert state == "sent", f"with a healthy relay deliver answered {state!r}, expected sent"
    calls = ctx.grpc.calls_to("SendMail")
    assert calls, "no SendMail call was made"
    for call in calls:
        assert call.timeout is not None, "a SendMail call carries no deadline: a stalled relay holds the worker"
        assert 9.5 <= call.timeout <= 10.5, f"a SendMail call carries a {call.timeout} s deadline, expected DEADLINE_S = 10: a stalled relay holds a worker that long per attempt"


def check_same_message_id(ctx):
    m, relay = _setup(ctx)
    ctx.grpc.fail("SendMail", grpc.StatusCode.UNAVAILABLE, "relay restarting")
    message_id = _message()
    state = m.deliver(message_id)
    assert state == "sent", f"after one UNAVAILABLE deliver answered {state!r}, expected sent"
    ids = [c.request.message_id for c in ctx.grpc.calls_to("SendMail")]
    assert ids == [message_id, message_id], f"the two attempts carried message ids {ids}, expected {message_id!r} twice: a new id per attempt is a new email to the relay, which cannot tell a retry from a second message"
    outcomes = [a["outcome"] for a in store.attempts(message_id)]
    assert len(outcomes) == 2 and outcomes[-1] == "accepted", f"the timeline holds {outcomes}, expected the failed attempt and then accepted"
    assert relay.mailed == ["ana@example.com"], f"the relay mailed {relay.mailed}"


def check_terminal_outcomes(ctx):
    m, _ = _setup(ctx)
    bounced = _message("bounce@example.com")
    state = m.deliver(bounced)
    calls = len(ctx.grpc.calls_to("SendMail"))
    assert calls == 1, f"a hard bounce was sent to the relay {calls} times: the mailbox does not exist, asking again cannot change that"
    assert state == "bounced", f"a hard bounce left deliver answering {state!r}, expected bounced"
    assert ctx.clock.sleeps == 0, "a hard bounce must not be slept on and retried"
    message = store.load(bounced)
    assert message["state"] == "bounced" and message["bounce_category"] == "mailbox_unknown", f"the message holds state {message['state']!r}, bounce_category {message['bounce_category']!r}, expected bounced with mailbox_unknown"
    assert ctx.redis.sismember("mail:suppressed", "bounce@example.com"), "after a hard bounce the address is not in mail:suppressed: the next send mails a mailbox that does not exist. Suppress it through the gate"
    blocked = _message("blocked@example.com")
    state = m.deliver(blocked)
    assert state == "suppressed" and len(ctx.grpc.calls_to("SendMail")) == 2, f"a recipient on the relay's own list answered {state!r} after {len(ctx.grpc.calls_to('SendMail')) - 1} call(s), expected suppressed after one"


def check_reconcile_timeout(ctx):
    m, relay = _setup(ctx)
    relay.lose_replies = 1
    message_id = _message()
    state = m.deliver(message_id)
    assert relay.mailed == ["ana@example.com"], f"the relay mailed {relay.mailed}: it took the message, its reply was lost, and the resend reached the customer as a second email. Ask GetStatus before sending again"
    assert state == "sent", f"the relay accepted the message (its reply was lost) and deliver answered {state!r}, expected sent"
    assert ctx.grpc.calls_to("GetStatus"), "after DEADLINE_EXCEEDED no GetStatus call was made"
    assert len(ctx.grpc.calls_to("SendMail")) == 1, f"GetStatus said accepted, yet SendMail was called {len(ctx.grpc.calls_to('SendMail'))} times"
    # A timeout the relay never saw: GetStatus answers unknown, and the same id is sent again.
    ctx.grpc.fail("SendMail", grpc.StatusCode.DEADLINE_EXCEEDED, "no answer")
    second = _message("bo@example.com")
    state = m.deliver(second)
    assert state == "sent" and relay.mailed.count("bo@example.com") == 1, f"after a timeout the relay never saw, deliver answered {state!r} and the relay mailed {relay.mailed}"
`,
    typescript: `/** The relay stand-in: accepts every recipient but bounce@ (hard bounce) and blocked@ (on its own list); an id it took answers its first verdict. */
function setup(ctx) {
  const pkg = ctx.proto('email_delivery.proto');
  const relay = {verdicts: new Map<string, {outcome: string; bounce_category: string}>(), mailed: [] as string[], loseReplies: 0};
  ctx.grpc.serve(pkg.smtprelay.Relay.service, {
    SendMail(call, callback) {
      const {message_id, recipient} = call.request;
      let verdict = relay.verdicts.get(message_id);
      if (verdict === undefined) {
        if (recipient.startsWith('bounce@')) verdict = {outcome: 'hard_bounce', bounce_category: 'mailbox_unknown'};
        else if (recipient.startsWith('blocked@')) verdict = {outcome: 'suppressed', bounce_category: ''};
        else {
          verdict = {outcome: 'accepted', bounce_category: ''};
          relay.mailed.push(recipient);
        }
        relay.verdicts.set(message_id, verdict);
      }
      if (relay.loseReplies > 0) {
        relay.loseReplies--;
        return callback({code: ctx.grpc.status.DEADLINE_EXCEEDED, details: 'the relay took the message; its reply was lost'});
      }
      callback(null, verdict);
    },
    GetStatus(call, callback) {
      callback(null, relay.verdicts.get(call.request.message_id) ?? {outcome: 'unknown', bounce_category: ''});
    },
  });
  const store = ctx.load('/support/mail/store.ts');
  const message = (recipient = 'ana@example.com') => store.enqueue('t-1', recipient, 'welcome', 'Welcome', {first_name: 'Ana'});
  return {m: ctx.load('dispatch'), relay, store, message};
}

export async function check_deadline(ctx) {
  const {m, message} = setup(ctx);
  const state = await m.deliver(await message());
  assert.equal(state, 'sent', \`with a healthy relay deliver answered \${state}\`);
  const calls = ctx.grpc.callsTo('SendMail');
  assert(calls.length > 0, 'no SendMail call was made');
  for (const call of calls) {
    assert(call.timeout !== null, 'a SendMail call carries no deadline: a stalled relay holds the worker');
    assert(call.timeout >= 9.5 && call.timeout <= 10.5, \`a SendMail call carries a \${call.timeout} s deadline, expected DEADLINE_MS = 10000: a stalled relay holds a worker that long per attempt\`);
  }
}

export async function check_same_message_id(ctx) {
  const {m, relay, store, message} = setup(ctx);
  ctx.grpc.fail('SendMail', ctx.grpc.status.UNAVAILABLE, 'relay restarting');
  const messageId = await message();
  const state = await m.deliver(messageId);
  assert.equal(state, 'sent', \`after one UNAVAILABLE deliver answered \${state}\`);
  const ids = ctx.grpc.callsTo('SendMail').map(c => c.request.message_id);
  assert.deepStrictEqual(ids, [messageId, messageId], \`the two attempts carried message ids \${JSON.stringify(ids)}, expected \${messageId} twice: a new id per attempt is a new email to the relay, which cannot tell a retry from a second message\`);
  const outcomes = (await store.attempts(messageId)).map(a => a.outcome);
  assert(outcomes.length === 2 && outcomes[1] === 'accepted', \`the timeline holds \${JSON.stringify(outcomes)}, expected the failed attempt and then accepted\`);
  assert.deepStrictEqual(relay.mailed, ['ana@example.com'], \`the relay mailed \${JSON.stringify(relay.mailed)}\`);
}

export async function check_terminal_outcomes(ctx) {
  const {m, store, message} = setup(ctx);
  const bounced = await message('bounce@example.com');
  let state = await m.deliver(bounced);
  const calls = ctx.grpc.callsTo('SendMail').length;
  assert.equal(calls, 1, \`a hard bounce was sent to the relay \${calls} times: the mailbox does not exist, asking again cannot change that\`);
  assert.equal(state, 'bounced', \`a hard bounce left deliver answering \${state}\`);
  assert.equal(ctx.clock.sleeps, 0, 'a hard bounce must not be slept on and retried');
  const stored = await store.load(bounced);
  assert(stored.state === 'bounced' && stored.bounce_category === 'mailbox_unknown', \`the message holds state \${stored.state}, bounce_category \${stored.bounce_category}, expected bounced with mailbox_unknown\`);
  assert.equal(ctx.redis.sismember('mail:suppressed', 'bounce@example.com'), 1, 'after a hard bounce the address is not in mail:suppressed: the next send mails a mailbox that does not exist. Suppress it through the gate');
  state = await m.deliver(await message('blocked@example.com'));
  assert(state === 'suppressed' && ctx.grpc.callsTo('SendMail').length === 2, \`a recipient on the relay's own list answered \${state} after \${ctx.grpc.callsTo('SendMail').length - 1} call(s), expected suppressed after one\`);
}

export async function check_reconcile_timeout(ctx) {
  const {m, relay, message} = setup(ctx);
  relay.loseReplies = 1;
  let state = await m.deliver(await message());
  assert.deepStrictEqual(relay.mailed, ['ana@example.com'], \`the relay mailed \${JSON.stringify(relay.mailed)}: it took the message, its reply was lost, and the resend reached the customer as a second email. Ask GetStatus before sending again\`);
  assert.equal(state, 'sent', \`the relay accepted the message (its reply was lost) and deliver answered \${state}\`);
  assert(ctx.grpc.callsTo('GetStatus').length > 0, 'after DEADLINE_EXCEEDED no GetStatus call was made');
  assert.equal(ctx.grpc.callsTo('SendMail').length, 1, 'GetStatus said accepted, yet SendMail was called again');
  // A timeout the relay never saw: GetStatus answers unknown, and the same id is sent again.
  ctx.grpc.fail('SendMail', ctx.grpc.status.DEADLINE_EXCEEDED, 'no answer');
  state = await m.deliver(await message('bo@example.com'));
  assert(state === 'sent' && relay.mailed.filter(r => r === 'bo@example.com').length === 1, \`after a timeout the relay never saw, deliver answered \${state} and the relay mailed \${JSON.stringify(relay.mailed)}\`);
}
`,
    go: `package main

import (
	"context"
	"strings"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "mail/gen/email_delivery"
	"mail/store"

	"leetbuild/harness"
)

var dispatchBg = context.Background()

// relayPeer accepts every recipient but bounce@ (hard bounce) and blocked@ (on its own list); an id
// it took answers its first verdict, and the first loseReplies replies are lost after it took the message.
type relayPeer struct {
	pb.UnimplementedRelayServer
	verdicts    map[string]*pb.Delivery
	mailed      []string
	loseReplies int
}

func (p *relayPeer) SendMail(_ context.Context, req *pb.SendMailRequest) (*pb.Delivery, error) {
	verdict, seen := p.verdicts[req.GetMessageId()]
	if !seen {
		switch {
		case strings.HasPrefix(req.GetRecipient(), "bounce@"):
			verdict = &pb.Delivery{Outcome: "hard_bounce", BounceCategory: "mailbox_unknown"}
		case strings.HasPrefix(req.GetRecipient(), "blocked@"):
			verdict = &pb.Delivery{Outcome: "suppressed"}
		default:
			verdict = &pb.Delivery{Outcome: "accepted"}
			p.mailed = append(p.mailed, req.GetRecipient())
		}
		p.verdicts[req.GetMessageId()] = verdict
	}
	if p.loseReplies > 0 {
		p.loseReplies--
		return nil, status.Error(codes.DeadlineExceeded, "the relay took the message; its reply was lost")
	}
	return verdict, nil
}

func (p *relayPeer) GetStatus(_ context.Context, req *pb.StatusRequest) (*pb.Delivery, error) {
	if verdict, seen := p.verdicts[req.GetMessageId()]; seen {
		return verdict, nil
	}
	return &pb.Delivery{Outcome: "unknown"}, nil
}

func serveRelay(ctx *harness.Ctx) *relayPeer {
	peer := &relayPeer{verdicts: map[string]*pb.Delivery{}}
	pb.RegisterRelayServer(ctx.GRPC.Server(""), peer)
	return peer
}

func newMessage(recipient string) string {
	return store.Enqueue(dispatchBg, "t-1", recipient, "welcome", "Welcome", map[string]string{"first_name": "Ana"})
}

func mustDeliver(ctx *harness.Ctx, messageID string) string {
	state, err := deliver(dispatchBg, messageID)
	ctx.NoError(err, "deliver(%s) failed", messageID)
	return state
}

func countOf(list []string, item string) int {
	n := 0
	for _, v := range list {
		if v == item {
			n++
		}
	}
	return n
}

func CheckDeadline(ctx *harness.Ctx) {
	serveRelay(ctx)
	ctx.Equal(mustDeliver(ctx, newMessage("ana@example.com")), "sent", "with a healthy relay, deliver")
	calls := ctx.GRPC.CallsTo("SendMail", "")
	ctx.Assert(len(calls) > 0, "no SendMail call was made")
	for _, call := range calls {
		ctx.Assert(call.HasDeadline(), "a SendMail call carries no deadline: a stalled relay holds the worker")
		ctx.Assert(9500*time.Millisecond <= call.Timeout && call.Timeout <= 10500*time.Millisecond, "a SendMail call carries a %v deadline, expected 10 s: a stalled relay holds a worker that long per attempt", call.Timeout)
	}
}

func CheckSameMessageId(ctx *harness.Ctx) {
	relay := serveRelay(ctx)
	ctx.GRPC.Fail("SendMail", codes.Unavailable, "relay restarting", 1, "")
	messageID := newMessage("ana@example.com")
	ctx.Equal(mustDeliver(ctx, messageID), "sent", "after one UNAVAILABLE, deliver")
	var ids []string
	for _, c := range ctx.GRPC.CallsTo("SendMail", "") {
		ids = append(ids, c.Request.(*pb.SendMailRequest).GetMessageId())
	}
	ctx.Equal(ids, []string{messageID, messageID}, "the two attempts must carry the message's own id (a new id per attempt is a new email to the relay, which cannot tell a retry from a second message); the ids")
	attempts := store.Attempts(dispatchBg, messageID)
	ctx.Assert(len(attempts) == 2 && attempts[1].Outcome == "accepted", "the timeline holds %v, expected the failed attempt and then accepted", attempts)
	ctx.Equal(relay.mailed, []string{"ana@example.com"}, "the recipients the relay mailed")
}

func CheckTerminalOutcomes(ctx *harness.Ctx) {
	serveRelay(ctx)
	bounced := newMessage("bounce@example.com")
	state := mustDeliver(ctx, bounced)
	ctx.Equal(len(ctx.GRPC.CallsTo("SendMail", "")), 1, "a hard bounce was asked again (the mailbox does not exist, asking again cannot change that); the SendMail calls")
	ctx.Equal(state, "bounced", "after a hard bounce, deliver")
	ctx.Equal(ctx.Clock.Sleeps(), 0, "a hard bounce must not be slept on and retried; the sleeps")
	message := store.Load(dispatchBg, bounced)
	ctx.Assert(message.State == "bounced" && message.BounceCategory == "mailbox_unknown", "the message holds state %q, bounce_category %q, expected bounced with mailbox_unknown", message.State, message.BounceCategory)
	ctx.Assert(ctx.Redis.SIsMember("mail:suppressed", "bounce@example.com"), "after a hard bounce the address is not in mail:suppressed: the next send mails a mailbox that does not exist. Suppress it through the gate")
	state = mustDeliver(ctx, newMessage("blocked@example.com"))
	ctx.Assert(state == "suppressed" && len(ctx.GRPC.CallsTo("SendMail", "")) == 2, "a recipient on the relay's own list answered %q after %d call(s), expected suppressed after one", state, len(ctx.GRPC.CallsTo("SendMail", ""))-1)
}

func CheckReconcileTimeout(ctx *harness.Ctx) {
	relay := serveRelay(ctx)
	relay.loseReplies = 1
	state := mustDeliver(ctx, newMessage("ana@example.com"))
	ctx.Equal(relay.mailed, []string{"ana@example.com"}, "the relay took the message, its reply was lost, and a resend reached the customer as a second email (ask GetStatus before sending again); the recipients the relay mailed")
	ctx.Equal(state, "sent", "the relay accepted the message (its reply was lost); deliver")
	ctx.Assert(len(ctx.GRPC.CallsTo("GetStatus", "")) > 0, "after DEADLINE_EXCEEDED no GetStatus call was made")
	ctx.Equal(len(ctx.GRPC.CallsTo("SendMail", "")), 1, "GetStatus said accepted, so nothing is resent; the SendMail calls")
	// A timeout the relay never saw: GetStatus answers unknown, and the same id is sent again.
	ctx.GRPC.Fail("SendMail", codes.DeadlineExceeded, "no answer", 1, "")
	state = mustDeliver(ctx, newMessage("bo@example.com"))
	ctx.Assert(state == "sent" && countOf(relay.mailed, "bo@example.com") == 1, "after a timeout the relay never saw, deliver answered %q and the relay mailed %q", state, relay.mailed)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <map>
#include <string>
#include <vector>

#include "email_delivery.grpc.pb.h"
#include "mail/store.h"

namespace {

// Accepts every recipient but bounce@ (hard bounce) and blocked@ (on its own list); an id it took
// answers its first verdict, and the first lose_replies replies are lost after it took the message.
class RelayPeer final : public smtprelay::Relay::Service {
 public:
  std::map<std::string, smtprelay::Delivery> verdicts;
  std::vector<std::string> mailed;
  int lose_replies = 0;

  grpc::Status SendMail(grpc::ServerContext*, const smtprelay::SendMailRequest* req, smtprelay::Delivery* out) override {
    auto seen = verdicts.find(req->message_id());
    if (seen == verdicts.end()) {
      smtprelay::Delivery verdict;
      if (req->recipient().rfind("bounce@", 0) == 0) {
        verdict.set_outcome("hard_bounce");
        verdict.set_bounce_category("mailbox_unknown");
      } else if (req->recipient().rfind("blocked@", 0) == 0) {
        verdict.set_outcome("suppressed");
      } else {
        verdict.set_outcome("accepted");
        mailed.push_back(req->recipient());
      }
      seen = verdicts.emplace(req->message_id(), verdict).first;
    }
    if (lose_replies > 0) {
      lose_replies--;
      return grpc::Status(grpc::StatusCode::DEADLINE_EXCEEDED, "the relay took the message; its reply was lost");
    }
    *out = seen->second;
    return grpc::Status::OK;
  }

  grpc::Status GetStatus(grpc::ServerContext*, const smtprelay::StatusRequest* req, smtprelay::Delivery* out) override {
    const auto seen = verdicts.find(req->message_id());
    if (seen == verdicts.end()) {
      out->set_outcome("unknown");
    } else {
      *out = seen->second;
    }
    return grpc::Status::OK;
  }
};

RelayPeer& serveRelay(harness::Ctx& ctx) {
  static RelayPeer* peer = nullptr;
  delete peer;
  peer = new RelayPeer;
  ctx.GRPC.Server("")->RegisterService(peer);
  return *peer;
}

std::string newMessage(const std::string& recipient) {
  return mail::store::enqueue("t-1", recipient, "welcome", "Welcome", {{"first_name", "Ana"}});
}

std::string mustDeliver(harness::Ctx& ctx, const std::string& message_id) {
  try {
    return deliver(message_id);
  } catch (const std::exception& e) {
    ctx.Fatalf("deliver(%s) threw %s: %s", message_id, harness::CurrentExceptionType(), e.what());
  }
}

long countOf(const std::vector<std::string>& list, const std::string& item) {
  long n = 0;
  for (const auto& v : list) n += v == item ? 1 : 0;
  return n;
}

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  serveRelay(ctx);
  ctx.Equal(mustDeliver(ctx, newMessage("ana@example.com")), "sent", "with a healthy relay, deliver");
  const auto calls = ctx.GRPC.CallsTo("SendMail");
  ctx.Assert(!calls.empty(), "no SendMail call was made");
  for (const auto& call : calls) {
    ctx.Assert(call.HasDeadline(), "a SendMail call carries no deadline: a stalled relay holds the worker");
    ctx.Assert(9.5 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 10.5, "a SendMail call carries a %v s deadline, expected kDeadline = 10 s: a stalled relay holds a worker that long per attempt", call.TimeoutSeconds());
  }
}

void CheckSameMessageId(harness::Ctx& ctx) {
  RelayPeer& relay = serveRelay(ctx);
  ctx.GRPC.Fail("SendMail", grpc::StatusCode::UNAVAILABLE, "relay restarting", 1);
  const std::string message_id = newMessage("ana@example.com");
  ctx.Equal(mustDeliver(ctx, message_id), "sent", "after one UNAVAILABLE, deliver");
  std::vector<std::string> ids;
  for (const auto& c : ctx.GRPC.CallsTo("SendMail")) ids.push_back(c.Request<smtprelay::SendMailRequest>().message_id());
  ctx.Equal(ids, std::vector<std::string>{message_id, message_id}, "the two attempts must carry the message's own id (a new id per attempt is a new email to the relay, which cannot tell a retry from a second message); the ids");
  const auto attempts = mail::store::attempts(message_id);
  ctx.Assert(attempts.size() == 2 && attempts[1].outcome == "accepted", "the timeline holds %d attempt(s), the last %q, expected the failed attempt and then accepted", attempts.size(), attempts.empty() ? "" : attempts.back().outcome);
  ctx.Equal(relay.mailed, std::vector<std::string>{"ana@example.com"}, "the recipients the relay mailed");
}

void CheckTerminalOutcomes(harness::Ctx& ctx) {
  serveRelay(ctx);
  const std::string bounced = newMessage("bounce@example.com");
  std::string state = mustDeliver(ctx, bounced);
  ctx.Equal(ctx.GRPC.CallsTo("SendMail").size(), 1, "a hard bounce was asked again (the mailbox does not exist, asking again cannot change that); the SendMail calls");
  ctx.Equal(state, "bounced", "after a hard bounce, deliver");
  ctx.Equal(ctx.Clock.Sleeps(), 0, "a hard bounce must not be slept on and retried; the sleeps");
  const auto message = mail::store::load(bounced);
  ctx.Assert(message && message->state == "bounced" && message->bounce_category == "mailbox_unknown", "the message holds state %q, bounce_category %q, expected bounced with mailbox_unknown",
             message ? message->state : "", message ? message->bounce_category : "");
  ctx.Assert(ctx.Redis.SIsMember("mail:suppressed", "bounce@example.com"), "after a hard bounce the address is not in mail:suppressed: the next send mails a mailbox that does not exist. Suppress it through the gate");
  state = mustDeliver(ctx, newMessage("blocked@example.com"));
  ctx.Assert(state == "suppressed" && ctx.GRPC.CallsTo("SendMail").size() == 2, "a recipient on the relay's own list answered %q after %d call(s), expected suppressed after one", state,
             static_cast<int>(ctx.GRPC.CallsTo("SendMail").size()) - 1);
}

void CheckReconcileTimeout(harness::Ctx& ctx) {
  RelayPeer& relay = serveRelay(ctx);
  relay.lose_replies = 1;
  std::string state = mustDeliver(ctx, newMessage("ana@example.com"));
  ctx.Equal(relay.mailed, std::vector<std::string>{"ana@example.com"}, "the relay took the message, its reply was lost, and a resend reached the customer as a second email (ask GetStatus before sending again); the recipients the relay mailed");
  ctx.Equal(state, "sent", "the relay accepted the message (its reply was lost); deliver");
  ctx.Assert(!ctx.GRPC.CallsTo("GetStatus").empty(), "after DEADLINE_EXCEEDED no GetStatus call was made");
  ctx.Equal(ctx.GRPC.CallsTo("SendMail").size(), 1, "GetStatus said accepted, so nothing is resent; the SendMail calls");
  // A timeout the relay never saw: GetStatus answers unknown, and the same id is sent again.
  ctx.GRPC.Fail("SendMail", grpc::StatusCode::DEADLINE_EXCEEDED, "no answer", 1);
  state = mustDeliver(ctx, newMessage("bo@example.com"));
  ctx.Assert(state == "sent" && countOf(relay.mailed, "bo@example.com") == 1, "after a timeout the relay never saw, deliver answered %q and the relay mailed %q", state, relay.mailed);
}
`,
  },
  hints: [
    "Lose the relay's reply once: the customer gets the email twice. Send to an address that hard-bounces: the relay is asked three times and the address can be mailed again tomorrow.",
    'Each attempt carries a new id, so the relay cannot tell a retry from a second email, and a timeout is handled like a refusal. Every outcome but accepted is slept on and retried, under a 30-second deadline.',
    "Build the request once with the message's own id and `timeout=DEADLINE_S`. On DEADLINE_EXCEEDED call `GetStatus` first; on `hard_bounce` set `bounced` with the category and `gate.suppress`; stop on `suppressed`; retry only UNAVAILABLE and soft bounces.",
  ],
  debrief: `The message id is the contract with the relay: as long as every attempt carries it, the relay can answer a retry with its first verdict, and a timeout becomes a question (GetStatus) instead of a gamble. A hard bounce is the mailbox saying it does not exist, so the only useful reaction is to stop: record the category for the status read and add the address to suppression, so the gate refuses the next send. Ten seconds bounds what a stalled relay costs a worker. Production senders retry soft bounces for hours with a growing backoff rather than three times, reconcile unknown outcomes in a sweeper instead of inline, and feed the bounces a relay reports later, through its feedback stream, into the same suppression list.`,
};
