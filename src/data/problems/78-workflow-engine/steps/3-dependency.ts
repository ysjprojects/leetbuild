import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'gRPC side effects guarded by an effect ledger',
  concept: 'grpc',
  file: 'client',
  focus: ['worker', 'mailer', 'ledger'],
  task: `## Task

**Starting point.** \`run_step(run_id, step, next_step, user_id)\` runs the \`send_welcome\` step of a
run: it moves the checkpoint with \`checkpoint.advance(run_id, step, next_step, "", now)\`, then
calls \`Mailer.SendWelcome\` with a fresh UUID as \`effect_id\` under the 2 s \`DEADLINE_S\`, sends
once more on \`DEADLINE_EXCEEDED\`, and returns the message id. It serves the demo and hides five
flaws.

**Failure mode the checks target.** A crash between the advance and the call leaves a step marked
done and a customer with no email; a worker that replays the step after a restart sends a second
email; a deadline whose request did arrive is resent on the spot.

- \`effect_id(run_id, step)\` is \`"{run_id}:{step}"\`, and it goes in the request.
- \`ledger.done(effect_id)\` first: a recorded message id is returned without calling the mailer.
- Call, then \`ledger.record(effect_id, message_id)\`, then
  \`checkpoint.advance(run_id, step, next_step, message_id, now)\`.
- On \`DEADLINE_EXCEEDED\` ask \`GetDelivery(effect_id)\`: a delivery is the outcome; \`NOT_FOUND\`
  raises \`EffectPending\` and the step is retried later.`,
  sequence: {
    participants: ['Worker', 'Effect ledger', 'Mailer', 'Checkpoint'],
    messages: [
      {from: 'Worker', to: 'Effect ledger', label: 'done("r1:send_welcome")', kind: 'sync'},
      {from: 'Effect ledger', to: 'Worker', label: 'recorded message id → return it, no call', kind: 'reply'},
      {from: 'Worker', to: 'Mailer', label: 'SendWelcome {effect_id: r1:send_welcome} · 2 s deadline', kind: 'sync'},
      {from: 'Mailer', to: 'Worker', label: 'DEADLINE_EXCEEDED', kind: 'reply'},
      {from: 'Worker', to: 'Mailer', label: 'GetDelivery(r1:send_welcome) · NOT_FOUND → EffectPending', kind: 'sync'},
      {from: 'Worker', to: 'Effect ledger', label: 'record(r1:send_welcome, m-1)', kind: 'sync'},
      {from: 'Worker', to: 'Checkpoint', label: 'advance(r1, send_welcome → notify_sales, m-1)', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'effect-id',
      title: 'Sends a deterministic effect id',
      detail:
        'The `send_welcome` steps of runs r1 and r2 send `effect_id` `r1:send_welcome` and `r2:send_welcome`. The starter sends a fresh UUID per attempt, so nothing links a retry to the attempt before it.',
      match: {
        python: {all: [/f"\{run_id\}:\{step\}"/], none: [/uuid/]},
        typescript: {all: [/\$\{runId\}:\$\{step\}/], none: [/randomUUID/]},
        go: {all: [/runID \+ ":" \+ step/], none: [/rand\./]},
        scala: {all: [/\$runId:\$step|\$\{runId\}:\$\{step\}/], none: [/UUID/]},
        cpp: {all: [/run_id \+ ":" \+ step/], none: [/random_device/]},
      },
    },
    {
      id: 'replay-skip',
      title: 'A replay returns the recorded outcome without calling',
      detail:
        'Running the step a second time, as a worker does after a restart, returns the same message id and the mailer has sent one email. The starter keeps no ledger and sends again.',
      match: {
        python: {all: [/ledger\.done\(/]},
        typescript: {all: [/ledger\.done\(/]},
        go: {all: [/ledger\.Done\(/]},
        scala: {all: [/Ledger\.done\(/]},
        cpp: {all: [/ledger::done\(/]},
      },
    },
    {
      id: 'effect-before-advance',
      title: 'The checkpoint moves only after the effect ran',
      detail:
        'With the mailer down (UNAVAILABLE), the step fails and the checkpoint is still at `send_welcome`. The starter advances first, so the run moves past an email that was never sent.',
      match: {
        python: {order: [/mailer\.SendWelcome\(/, /checkpoint\.advance\(/]},
        typescript: {order: [/mailer\.SendWelcome\(/, /checkpoint\.advance\(/]},
        go: {order: [/mailer\.SendWelcome\(/, /checkpoint\.Advance\(/]},
        scala: {order: [/\.sendWelcome\(/, /Checkpoint\.advance\(/]},
        cpp: {order: [/mailer->SendWelcome\(/, /checkpoint::advance\(/]},
      },
    },
    {
      id: 'record-before-advance',
      title: 'The ledger records the effect before the checkpoint moves',
      detail:
        'At the moment `run:r1:checkpoint` is written, `effect:r1:send_welcome` already holds the message id, so a crash between the two leaves a record the replay returns. The starter writes no record at all.',
      match: {
        python: {order: [/ledger\.record\(/, /checkpoint\.advance\(/]},
        typescript: {order: [/ledger\.record\(/, /checkpoint\.advance\(/]},
        go: {order: [/ledger\.Record\(/, /checkpoint\.Advance\(/]},
        scala: {order: [/Ledger\.record\(/, /Checkpoint\.advance\(/]},
        cpp: {order: [/ledger::record\(/, /checkpoint::advance\(/]},
      },
    },
    {
      id: 'timeout-reconcile',
      title: 'A deadline is reconciled, never resent on the spot',
      detail:
        'When the mailer sends the email and the reply is lost (DEADLINE_EXCEEDED), the step returns that message id with one email sent; when the request never arrived, the step fails with one call made and the checkpoint unmoved. Every call carries a 2 s deadline. The starter sends again.',
      match: {
        python: {order: [/DEADLINE_EXCEEDED/, /mailer\.GetDelivery\(/]},
        typescript: {order: [/DEADLINE_EXCEEDED/, /mailer\.GetDelivery\(/]},
        go: {order: [/codes\.DeadlineExceeded/, /mailer\.GetDelivery\(/]},
        scala: {order: [/DEADLINE_EXCEEDED/, /\.getDelivery\(/]},
        cpp: {order: [/DEADLINE_EXCEEDED/, /mailer->GetDelivery\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time
import uuid

import grpc

import workflow_engine_pb2
import workflow_engine_pb2_grpc
from workflow import checkpoint, ledger  # checkpoint.advance(run_id, from_step, to_step, output, now) · ledger.done, record

DEADLINE_S = 2

mailer = workflow_engine_pb2_grpc.MailerStub(grpc.insecure_channel("mailer:9000"))


class EffectPending(Exception):
    """The send timed out and the mailer has no message for this effect yet: the step is retried later."""


def run_step(run_id: str, step: str, next_step: str, user_id: str) -> str:
    """Run the welcome-email step of run_id once and advance the run to next_step; returns the message id."""
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    checkpoint.advance(run_id, step, next_step, "", int(time.time()))
    request = workflow_engine_pb2.WelcomeRequest(effect_id=str(uuid.uuid4()), user_id=user_id)
    try:
        reply = mailer.SendWelcome(request, timeout=DEADLINE_S)
    except grpc.RpcError as exc:
        if exc.code() != grpc.StatusCode.DEADLINE_EXCEEDED:
            raise
        reply = mailer.SendWelcome(request, timeout=DEADLINE_S)  # the mailer was slow: send once more
    return reply.message_id
`,
      solution: `import time

import grpc

import workflow_engine_pb2
import workflow_engine_pb2_grpc
from workflow import checkpoint, ledger  # checkpoint.advance(run_id, from_step, to_step, output, now) · ledger.done, record

DEADLINE_S = 2

mailer = workflow_engine_pb2_grpc.MailerStub(grpc.insecure_channel("mailer:9000"))


class EffectPending(Exception):
    """The send timed out and the mailer has no message for this effect yet: the step is retried later."""


def effect_id(run_id: str, step: str) -> str:
    """The same for every attempt of one step of one run, so a replay finds the first attempt's record."""
    return f"{run_id}:{step}"


def send_welcome(key: str, user_id: str) -> str:
    try:
        return mailer.SendWelcome(workflow_engine_pb2.WelcomeRequest(effect_id=key, user_id=user_id), timeout=DEADLINE_S).message_id
    except grpc.RpcError as exc:
        if exc.code() != grpc.StatusCode.DEADLINE_EXCEEDED:
            raise
    # The request may have arrived: ask the mailer by effect id instead of sending again.
    try:
        return mailer.GetDelivery(workflow_engine_pb2.DeliveryLookup(effect_id=key), timeout=DEADLINE_S).message_id
    except grpc.RpcError as exc:
        if exc.code() == grpc.StatusCode.NOT_FOUND:
            raise EffectPending(key) from exc
        raise


def run_step(run_id: str, step: str, next_step: str, user_id: str) -> str:
    """Run the welcome-email step of run_id once and advance the run to next_step; returns the message id."""
    key = effect_id(run_id, step)
    message_id = ledger.done(key)
    if message_id is None:  # a replay finds the first attempt's outcome and skips the call
        message_id = send_welcome(key, user_id)
        # Recorded before the checkpoint moves: a crash in between leaves a record the replay returns.
        ledger.record(key, message_id)
    checkpoint.advance(run_id, step, next_step, message_id, int(time.time()))
    return message_id
`,
    },
    typescript: {
      starter: `import {randomUUID} from 'node:crypto';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import * as checkpoint from 'workflow/checkpoint'; // advance(runId, fromStep, toStep, output, now)
import * as ledger from 'workflow/ledger'; // done, record

export const DEADLINE_MS = 2000;

interface Delivery {
  message_id: string;
  effect_id: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('workflow_engine.proto')) as unknown as {
  workflowd: {Mailer: grpc.ServiceClientConstructor};
};
const mailer = new pkg.workflowd.Mailer('mailer:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  SendWelcome(request: {effect_id: string; user_id: string}, options: grpc.CallOptions): Promise<Delivery>;
  GetDelivery(request: {effect_id: string}, options: grpc.CallOptions): Promise<Delivery>;
};

/** The send timed out and the mailer has no message for this effect yet: the step is retried later. */
export class EffectPending extends Error {}

/** Run the welcome-email step of runId once and advance the run to nextStep; resolves the message id. */
export async function runStep(runId: string, step: string, nextStep: string, userId: string): Promise<string> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  await checkpoint.advance(runId, step, nextStep, '', Math.floor(Date.now() / 1000));
  const request = {effect_id: randomUUID(), user_id: userId};
  try {
    return (await mailer.SendWelcome(request, {deadline: Date.now() + DEADLINE_MS})).message_id;
  } catch (err) {
    if ((err as grpc.ServiceError).code !== grpc.status.DEADLINE_EXCEEDED) throw err;
    return (await mailer.SendWelcome(request, {deadline: Date.now() + DEADLINE_MS})).message_id; // the mailer was slow: send once more
  }
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import * as checkpoint from 'workflow/checkpoint'; // advance(runId, fromStep, toStep, output, now)
import * as ledger from 'workflow/ledger'; // done, record

export const DEADLINE_MS = 2000;

interface Delivery {
  message_id: string;
  effect_id: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('workflow_engine.proto')) as unknown as {
  workflowd: {Mailer: grpc.ServiceClientConstructor};
};
const mailer = new pkg.workflowd.Mailer('mailer:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  SendWelcome(request: {effect_id: string; user_id: string}, options: grpc.CallOptions): Promise<Delivery>;
  GetDelivery(request: {effect_id: string}, options: grpc.CallOptions): Promise<Delivery>;
};

/** The send timed out and the mailer has no message for this effect yet: the step is retried later. */
export class EffectPending extends Error {}

/** The same for every attempt of one step of one run, so a replay finds the first attempt's record. */
export const effectId = (runId: string, step: string): string => \`\${runId}:\${step}\`;

async function sendWelcome(key: string, userId: string): Promise<string> {
  try {
    return (await mailer.SendWelcome({effect_id: key, user_id: userId}, {deadline: Date.now() + DEADLINE_MS})).message_id;
  } catch (err) {
    if ((err as grpc.ServiceError).code !== grpc.status.DEADLINE_EXCEEDED) throw err;
  }
  // The request may have arrived: ask the mailer by effect id instead of sending again.
  try {
    return (await mailer.GetDelivery({effect_id: key}, {deadline: Date.now() + DEADLINE_MS})).message_id;
  } catch (err) {
    if ((err as grpc.ServiceError).code === grpc.status.NOT_FOUND) throw new EffectPending(key);
    throw err;
  }
}

/** Run the welcome-email step of runId once and advance the run to nextStep; resolves the message id. */
export async function runStep(runId: string, step: string, nextStep: string, userId: string): Promise<string> {
  const key = effectId(runId, step);
  let messageId = await ledger.done(key);
  if (messageId === null) {
    // A replay finds the first attempt's outcome above and skips the call.
    messageId = await sendWelcome(key, userId);
    // Recorded before the checkpoint moves: a crash in between leaves a record the replay returns.
    await ledger.record(key, messageId);
  }
  await checkpoint.advance(runId, step, nextStep, messageId, Math.floor(Date.now() / 1000));
  return messageId;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"fmt"
	"math/rand"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"workflow/checkpoint" // checkpoint.Advance(ctx, runID, fromStep, toStep, output, now) (bool, error)
	pb "workflowd/gen/workflow_engine"
)

const deadline = 2 * time.Second

var (
	mailerConn, _ = grpc.NewClient("mailer:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	mailer        = pb.NewMailerClient(mailerConn)
)

// runStep runs the welcome-email step of runID once and advances the run to nextStep; it returns the
// message id. The effect ledger is the package workflow/ledger: ledger.Done(ctx, effectID) (string, bool),
// ledger.Record(ctx, effectID, outcome) error.
func runStep(ctx context.Context, runID, step, nextStep, userID string) (string, error) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	if _, err := checkpoint.Advance(ctx, runID, step, nextStep, "", time.Now().Unix()); err != nil {
		return "", err
	}
	request := &pb.WelcomeRequest{EffectId: fmt.Sprintf("%016x", rand.Uint64()), UserId: userID}
	callCtx, cancel := context.WithTimeout(ctx, deadline)
	reply, err := mailer.SendWelcome(callCtx, request)
	cancel()
	if status.Code(err) == codes.DeadlineExceeded {
		retryCtx, cancelRetry := context.WithTimeout(ctx, deadline)
		defer cancelRetry()
		reply, err = mailer.SendWelcome(retryCtx, request) // the mailer was slow: send once more
	}
	if err != nil {
		return "", err
	}
	return reply.GetMessageId(), nil
}
`,
      solution: `package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"workflow/checkpoint" // checkpoint.Advance(ctx, runID, fromStep, toStep, output, now) (bool, error)
	"workflow/ledger"     // ledger.Done(ctx, effectID) (string, bool), ledger.Record(ctx, effectID, outcome) error
	pb "workflowd/gen/workflow_engine"
)

const deadline = 2 * time.Second

var (
	mailerConn, _ = grpc.NewClient("mailer:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	mailer        = pb.NewMailerClient(mailerConn)
)

// ErrEffectPending: the send timed out and the mailer has no message for this effect yet; the step
// is retried later.
var ErrEffectPending = errors.New("effect pending: the send timed out and no message was found")

// effectID is the same for every attempt of one step of one run, so a replay finds the first
// attempt's record.
func effectID(runID, step string) string { return runID + ":" + step }

func sendWelcome(ctx context.Context, key, userID string) (string, error) {
	callCtx, cancel := context.WithTimeout(ctx, deadline)
	reply, err := mailer.SendWelcome(callCtx, &pb.WelcomeRequest{EffectId: key, UserId: userID})
	cancel()
	if err == nil {
		return reply.GetMessageId(), nil
	}
	if status.Code(err) != codes.DeadlineExceeded {
		return "", err
	}
	// The request may have arrived: ask the mailer by effect id instead of sending again.
	lookupCtx, cancelLookup := context.WithTimeout(ctx, deadline)
	defer cancelLookup()
	found, err := mailer.GetDelivery(lookupCtx, &pb.DeliveryLookup{EffectId: key})
	if status.Code(err) == codes.NotFound {
		return "", fmt.Errorf("%w: %s", ErrEffectPending, key)
	}
	if err != nil {
		return "", err
	}
	return found.GetMessageId(), nil
}

// runStep runs the welcome-email step of runID once and advances the run to nextStep; it returns the
// message id.
func runStep(ctx context.Context, runID, step, nextStep, userID string) (string, error) {
	key := effectID(runID, step)
	messageID, done := ledger.Done(ctx, key)
	if !done { // a replay finds the first attempt's outcome and skips the call
		var err error
		if messageID, err = sendWelcome(ctx, key, userID); err != nil {
			return "", err
		}
		// Recorded before the checkpoint moves: a crash in between leaves a record the replay returns.
		if err := ledger.Record(ctx, key, messageID); err != nil {
			return "", err
		}
	}
	if _, err := checkpoint.Advance(ctx, runID, step, nextStep, messageID, time.Now().Unix()); err != nil {
		return "", err
	}
	return messageID, nil
}
`,
    },
    scala: {
      starter: `import java.util.UUID
import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import workflow.{Checkpoint, Ledger} // Checkpoint.advance(runId, fromStep, toStep, output, now) · Ledger.done, record
import workflowd.workflow_engine.{DeliveryLookup, MailerGrpc, WelcomeRequest}

/** The send timed out and the mailer has no message for this effect yet: the step is retried later. */
final class EffectPending(message: String) extends Exception(message)

object Client {
  val DeadlineSeconds = 2L

  private val mailer = MailerGrpc.blockingStub(ManagedChannelBuilder.forAddress("mailer", 9000).usePlaintext().build())

  /** Run the welcome-email step of runId once and advance the run to nextStep; returns the message id. */
  def runStep(runId: String, step: String, nextStep: String, userId: String): String = {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    Checkpoint.advance(runId, step, nextStep, "", System.currentTimeMillis() / 1000)
    val request = WelcomeRequest(effectId = UUID.randomUUID().toString, userId = userId)
    try mailer.withDeadlineAfter(DeadlineSeconds, TimeUnit.SECONDS).sendWelcome(request).messageId
    catch {
      case e: StatusRuntimeException if e.getStatus.getCode == Status.Code.DEADLINE_EXCEEDED =>
        mailer.withDeadlineAfter(DeadlineSeconds, TimeUnit.SECONDS).sendWelcome(request).messageId // the mailer was slow: send once more
    }
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import workflow.{Checkpoint, Ledger} // Checkpoint.advance(runId, fromStep, toStep, output, now) · Ledger.done, record
import workflowd.workflow_engine.{DeliveryLookup, MailerGrpc, WelcomeRequest}

/** The send timed out and the mailer has no message for this effect yet: the step is retried later. */
final class EffectPending(message: String) extends Exception(message)

object Client {
  val DeadlineSeconds = 2L

  private val mailer = MailerGrpc.blockingStub(ManagedChannelBuilder.forAddress("mailer", 9000).usePlaintext().build())

  /** The same for every attempt of one step of one run, so a replay finds the first attempt's record. */
  def effectId(runId: String, step: String): String = s"$runId:$step"

  private def sendWelcome(key: String, userId: String): String =
    try mailer.withDeadlineAfter(DeadlineSeconds, TimeUnit.SECONDS).sendWelcome(WelcomeRequest(effectId = key, userId = userId)).messageId
    catch {
      case e: StatusRuntimeException if e.getStatus.getCode == Status.Code.DEADLINE_EXCEEDED =>
        // The request may have arrived: ask the mailer by effect id instead of sending again.
        try mailer.withDeadlineAfter(DeadlineSeconds, TimeUnit.SECONDS).getDelivery(DeliveryLookup(effectId = key)).messageId
        catch {
          case lookup: StatusRuntimeException if lookup.getStatus.getCode == Status.Code.NOT_FOUND => throw new EffectPending(key)
        }
    }

  /** Run the welcome-email step of runId once and advance the run to nextStep; returns the message id. */
  def runStep(runId: String, step: String, nextStep: String, userId: String): String = {
    val key = effectId(runId, step)
    // A replay finds the first attempt's outcome and skips the call.
    val messageId = Ledger.done(key).getOrElse {
      val sent = sendWelcome(key, userId)
      // Recorded before the checkpoint moves: a crash in between leaves a record the replay returns.
      Ledger.record(key, sent)
      sent
    }
    Checkpoint.advance(runId, step, nextStep, messageId, System.currentTimeMillis() / 1000)
    messageId
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <random>
#include <stdexcept>
#include <string>

#include "workflow/checkpoint.h"  // checkpoint::advance(run_id, from_step, to_step, output, now)
#include "workflow/ledger.h"      // ledger::done, ledger::record
#include "workflow_engine.grpc.pb.h"

constexpr std::chrono::seconds kDeadline{2};

auto mailer = workflowd::Mailer::NewStub(grpc::CreateChannel("mailer:9000", grpc::InsecureChannelCredentials()));

// The send timed out and the mailer has no message for this effect yet: the step is retried later.
struct EffectPending : std::runtime_error {
  using std::runtime_error::runtime_error;
};

long long unixNow() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

// Run the welcome-email step of run_id once and advance the run to next_step; returns the message id.
std::string runStep(const std::string& run_id, const std::string& step, const std::string& next_step, const std::string& user_id) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  checkpoint::advance(run_id, step, next_step, "", unixNow());
  workflowd::WelcomeRequest request;
  request.set_effect_id(std::to_string(std::random_device{}()));
  request.set_user_id(user_id);
  workflowd::Delivery delivery;
  grpc::Status status;
  {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    status = mailer->SendWelcome(&ctx, request, &delivery);
  }
  if (status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED) {
    grpc::ClientContext retry;  // the mailer was slow: send once more
    retry.set_deadline(std::chrono::system_clock::now() + kDeadline);
    status = mailer->SendWelcome(&retry, request, &delivery);
  }
  if (!status.ok()) throw std::runtime_error("SendWelcome: " + status.error_message());
  return delivery.message_id();
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <stdexcept>
#include <string>

#include "workflow/checkpoint.h"  // checkpoint::advance(run_id, from_step, to_step, output, now)
#include "workflow/ledger.h"      // ledger::done, ledger::record
#include "workflow_engine.grpc.pb.h"

constexpr std::chrono::seconds kDeadline{2};

auto mailer = workflowd::Mailer::NewStub(grpc::CreateChannel("mailer:9000", grpc::InsecureChannelCredentials()));

// The send timed out and the mailer has no message for this effect yet: the step is retried later.
struct EffectPending : std::runtime_error {
  using std::runtime_error::runtime_error;
};

long long unixNow() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

// The same for every attempt of one step of one run, so a replay finds the first attempt's record.
std::string effectId(const std::string& run_id, const std::string& step) { return run_id + ":" + step; }

std::string sendWelcome(const std::string& key, const std::string& user_id) {
  workflowd::WelcomeRequest request;
  request.set_effect_id(key);
  request.set_user_id(user_id);
  workflowd::Delivery delivery;
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
  grpc::Status status = mailer->SendWelcome(&ctx, request, &delivery);
  if (status.ok()) return delivery.message_id();
  if (status.error_code() != grpc::StatusCode::DEADLINE_EXCEEDED) throw std::runtime_error("SendWelcome: " + status.error_message());
  // The request may have arrived: ask the mailer by effect id instead of sending again.
  workflowd::DeliveryLookup lookup;
  lookup.set_effect_id(key);
  grpc::ClientContext lookupCtx;
  lookupCtx.set_deadline(std::chrono::system_clock::now() + kDeadline);
  status = mailer->GetDelivery(&lookupCtx, lookup, &delivery);
  if (status.ok()) return delivery.message_id();
  if (status.error_code() == grpc::StatusCode::NOT_FOUND) throw EffectPending(key);
  throw std::runtime_error("GetDelivery: " + status.error_message());
}

// Run the welcome-email step of run_id once and advance the run to next_step; returns the message id.
std::string runStep(const std::string& run_id, const std::string& step, const std::string& next_step, const std::string& user_id) {
  const std::string key = effectId(run_id, step);
  std::string message_id;
  if (const auto done = ledger::done(key)) {
    message_id = *done;  // a replay finds the first attempt's outcome and skips the call
  } else {
    message_id = sendWelcome(key, user_id);
    // Recorded before the checkpoint moves: a crash in between leaves a record the replay returns.
    ledger::record(key, message_id);
  }
  checkpoint::advance(run_id, step, next_step, message_id, unixNow());
  return message_id;
}
`,
    },
  },
  harness: {
    python: `import grpc

import workflow_engine_pb2
import workflow_engine_pb2_grpc


class Mailer(workflow_engine_pb2_grpc.MailerServicer):
    """Sends whatever it is asked to (no deduplication); lose_replies sends, then answers DEADLINE_EXCEEDED."""

    def __init__(self):
        self.sent = []  # (effect_id, message_id), oldest first
        self.lose_replies = 0

    def SendWelcome(self, request, context):
        message_id = f"m-{len(self.sent) + 1}"
        self.sent.append((request.effect_id, message_id))
        if self.lose_replies > 0:
            self.lose_replies -= 1
            context.abort(grpc.StatusCode.DEADLINE_EXCEEDED, "the email went out, the reply was lost")
        return workflow_engine_pb2.Delivery(message_id=message_id, effect_id=request.effect_id)

    def GetDelivery(self, request, context):
        for effect, message_id in reversed(self.sent):
            if effect == request.effect_id:
                return workflow_engine_pb2.Delivery(message_id=message_id, effect_id=effect)
        context.abort(grpc.StatusCode.NOT_FOUND, f"no message for {request.effect_id}")


def _client(ctx):
    mailer = Mailer()
    ctx.grpc.serve(workflow_engine_pb2_grpc.add_MailerServicer_to_server, mailer)
    return ctx.load("client"), mailer


def _at_send_welcome(ctx, run_id):
    ctx.redis.hset(f"run:{run_id}:checkpoint", mapping={"current_step": "send_welcome", "completed": "create_account", "output_ref": "", "updated_at": 1000})


def _step(ctx, m, run_id="r1"):
    return m.run_step(run_id, "send_welcome", "notify_sales", "u-1")


def _fails(fn):
    try:
        fn()
    except Exception:
        return True
    return False


def check_effect_id(ctx):
    m, mailer = _client(ctx)
    for run_id in ("r1", "r2"):
        _at_send_welcome(ctx, run_id)
        _step(ctx, m, run_id)
    ids = [c.request.effect_id for c in ctx.grpc.calls_to("SendWelcome")]
    assert ids == ["r1:send_welcome", "r2:send_welcome"], f"the SendWelcome requests carry effect ids {ids}, expected ['r1:send_welcome', 'r2:send_welcome']: a random id per attempt links no retry to the attempt before it"


def check_replay_skip(ctx):
    m, mailer = _client(ctx)
    _at_send_welcome(ctx, "r1")
    first = _step(ctx, m)
    replay = _step(ctx, m)  # a worker that restarted runs the step again
    assert len(mailer.sent) == 1, f"running send_welcome twice for r1 sent {len(mailer.sent)} emails: a replay must return the recorded outcome without calling"
    assert replay == first, f"the replay returned {replay!r}, the first attempt {first!r}: a replay returns the recorded message id"


def check_effect_before_advance(ctx):
    m, _ = _client(ctx)
    _at_send_welcome(ctx, "r1")
    ctx.grpc.fail("SendWelcome", grpc.StatusCode.UNAVAILABLE, "mailer is down")
    assert _fails(lambda: _step(ctx, m)), "run_step returned normally while the mailer was down"
    step = ctx.redis.hget("run:r1:checkpoint", "current_step")
    assert step == "send_welcome", f"the mailer was down and no email went out, yet the checkpoint moved to {step!r}: the run will never send it"


def check_record_before_advance(ctx):
    m, _ = _client(ctx)
    _at_send_welcome(ctx, "r1")
    seen = ctx.redis_after("run:r1:checkpoint", lambda: ctx.redis.get("effect:r1:send_welcome"))
    message_id = _step(ctx, m)
    assert seen.fired, "run_step never advanced run:r1:checkpoint"
    assert seen.result == message_id, f"when the checkpoint moved, the ledger held {seen.result!r} for r1:send_welcome, not the message id {message_id!r}: a crash right there leaves a step marked done whose email no replay can find"


def check_timeout_reconcile(ctx):
    m, mailer = _client(ctx)
    _at_send_welcome(ctx, "r1")
    mailer.lose_replies = 1  # the email goes out, the reply is lost
    message_id = _step(ctx, m)
    assert len(mailer.sent) == 1, f"SendWelcome timed out after the email went out and the step sent {len(mailer.sent)} emails: ask GetDelivery by effect id instead of sending again"
    assert message_id == mailer.sent[0][1], f"run_step returned {message_id!r}, expected the delivered message {mailer.sent[0][1]!r}"
    assert ctx.redis.get("effect:r1:send_welcome") == message_id, "the reconciled outcome must be recorded in the ledger"
    for call in ctx.grpc.calls_to("SendWelcome"):
        assert call.timeout is not None and 1.5 <= call.timeout <= 2.5, f"a SendWelcome call carries a {call.timeout} s deadline, expected DEADLINE_S = 2"
    # A deadline whose request never arrived: nothing to find, and the request may still be in flight.
    _at_send_welcome(ctx, "r2")
    before = len(ctx.grpc.calls_to("SendWelcome"))
    ctx.grpc.fail("SendWelcome", grpc.StatusCode.DEADLINE_EXCEEDED, "deadline exceeded")
    assert _fails(lambda: _step(ctx, m, "r2")), "run_step returned normally after a deadline with no delivery found: it must fail (EffectPending) so the step is retried later"
    sends = len(ctx.grpc.calls_to("SendWelcome")) - before
    assert sends == 1, f"after a deadline with no delivery found the step called SendWelcome {sends} times, expected 1: a resend on the spot doubles the email when the first request is still in flight"
    step = ctx.redis.hget("run:r2:checkpoint", "current_step")
    assert step == "send_welcome", f"r2's checkpoint moved to {step!r} although its email is unaccounted for"
`,
    typescript: `function client(ctx) {
  const pkg = ctx.proto('workflow_engine.proto');
  // Sends whatever it is asked to (no deduplication); loseReplies sends, then answers DEADLINE_EXCEEDED.
  const mailer = {sent: [] as {effect_id: string; message_id: string}[], loseReplies: 0};
  ctx.grpc.serve(pkg.workflowd.Mailer.service, {
    SendWelcome(call, callback) {
      const message_id = \`m-\${mailer.sent.length + 1}\`;
      mailer.sent.push({effect_id: call.request.effect_id, message_id});
      if (mailer.loseReplies > 0) {
        mailer.loseReplies--;
        return callback({code: ctx.grpc.status.DEADLINE_EXCEEDED, details: 'the email went out, the reply was lost'});
      }
      callback(null, {message_id, effect_id: call.request.effect_id});
    },
    GetDelivery(call, callback) {
      const found = [...mailer.sent].reverse().find(s => s.effect_id === call.request.effect_id);
      if (found === undefined) return callback({code: ctx.grpc.status.NOT_FOUND, details: \`no message for \${call.request.effect_id}\`});
      callback(null, found);
    },
  });
  return {m: ctx.load('client'), mailer};
}

const atSendWelcome = (ctx, runId: string): void => {
  ctx.redis.hset(\`run:\${runId}:checkpoint\`, 'current_step', 'send_welcome', 'completed', 'create_account', 'output_ref', '', 'updated_at', '1000');
};

const step = (m, runId = 'r1'): Promise<string> => m.runStep(runId, 'send_welcome', 'notify_sales', 'u-1');

async function fails(promise: Promise<unknown>): Promise<boolean> {
  try {
    await promise;
  } catch {
    return true;
  }
  return false;
}

export async function check_effect_id(ctx) {
  const {m} = client(ctx);
  for (const runId of ['r1', 'r2']) {
    atSendWelcome(ctx, runId);
    await step(m, runId);
  }
  const ids = ctx.grpc.callsTo('SendWelcome').map(c => c.request.effect_id);
  assert.deepStrictEqual(ids, ['r1:send_welcome', 'r2:send_welcome'], \`the SendWelcome requests carry effect ids \${JSON.stringify(ids)}: a random id per attempt links no retry to the attempt before it\`);
}

export async function check_replay_skip(ctx) {
  const {m, mailer} = client(ctx);
  atSendWelcome(ctx, 'r1');
  const first = await step(m);
  const replay = await step(m); // a worker that restarted runs the step again
  assert.equal(mailer.sent.length, 1, \`running send_welcome twice for r1 sent \${mailer.sent.length} emails: a replay must return the recorded outcome without calling\`);
  assert.equal(replay, first, 'a replay returns the recorded message id');
}

export async function check_effect_before_advance(ctx) {
  const {m} = client(ctx);
  atSendWelcome(ctx, 'r1');
  ctx.grpc.fail('SendWelcome', ctx.grpc.status.UNAVAILABLE, 'mailer is down');
  assert(await fails(step(m)), 'runStep resolved while the mailer was down');
  const current = ctx.redis.hget('run:r1:checkpoint', 'current_step');
  assert.equal(current, 'send_welcome', \`the mailer was down and no email went out, yet the checkpoint moved to \${JSON.stringify(current)}: the run will never send it\`);
}

export async function check_record_before_advance(ctx) {
  const {m} = client(ctx);
  atSendWelcome(ctx, 'r1');
  const seen = ctx.redisAfter('run:r1:checkpoint', () => ctx.redis.get('effect:r1:send_welcome'));
  const messageId = await step(m);
  assert(seen.fired, 'runStep never advanced run:r1:checkpoint');
  assert.equal(seen.result, messageId, \`when the checkpoint moved, the ledger held \${JSON.stringify(seen.result)} for r1:send_welcome: a crash right there leaves a step marked done whose email no replay can find\`);
}

export async function check_timeout_reconcile(ctx) {
  const {m, mailer} = client(ctx);
  atSendWelcome(ctx, 'r1');
  mailer.loseReplies = 1; // the email goes out, the reply is lost
  const messageId = await step(m);
  assert.equal(mailer.sent.length, 1, \`SendWelcome timed out after the email went out and the step sent \${mailer.sent.length} emails: ask GetDelivery by effect id instead of sending again\`);
  assert.equal(messageId, mailer.sent[0].message_id, 'runStep must resolve the delivered message id');
  assert.equal(ctx.redis.get('effect:r1:send_welcome'), messageId, 'the reconciled outcome must be recorded in the ledger');
  for (const call of ctx.grpc.callsTo('SendWelcome')) {
    assert(call.timeout !== null && 1.5 <= call.timeout && call.timeout <= 2.5, \`a SendWelcome call carries a \${call.timeout} s deadline, expected DEADLINE_MS = 2000\`);
  }
  // A deadline whose request never arrived: nothing to find, and the request may still be in flight.
  atSendWelcome(ctx, 'r2');
  const before = ctx.grpc.callsTo('SendWelcome').length;
  ctx.grpc.fail('SendWelcome', ctx.grpc.status.DEADLINE_EXCEEDED, 'deadline exceeded');
  assert(await fails(step(m, 'r2')), 'runStep resolved after a deadline with no delivery found: it must reject (EffectPending) so the step is retried later');
  const sends = ctx.grpc.callsTo('SendWelcome').length - before;
  assert.equal(sends, 1, \`after a deadline with no delivery found the step called SendWelcome \${sends} times: a resend on the spot doubles the email when the first request is still in flight\`);
  assert.equal(ctx.redis.hget('run:r2:checkpoint', 'current_step'), 'send_welcome', "r2's checkpoint moved although its email is unaccounted for");
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "workflowd/gen/workflow_engine"

	"leetbuild/harness"
)

var clientBg = context.Background()

type sentMail struct {
	effectID  string
	messageID string
}

// mailerPeer sends whatever it is asked to (no deduplication); loseReplies sends, then answers
// DEADLINE_EXCEEDED.
type mailerPeer struct {
	pb.UnimplementedMailerServer
	sent        []sentMail
	loseReplies int
}

func (m *mailerPeer) SendWelcome(_ context.Context, req *pb.WelcomeRequest) (*pb.Delivery, error) {
	id := fmt.Sprintf("m-%d", len(m.sent)+1)
	m.sent = append(m.sent, sentMail{req.GetEffectId(), id})
	if m.loseReplies > 0 {
		m.loseReplies--
		return nil, status.Error(codes.DeadlineExceeded, "the email went out, the reply was lost")
	}
	return &pb.Delivery{MessageId: id, EffectId: req.GetEffectId()}, nil
}

func (m *mailerPeer) GetDelivery(_ context.Context, req *pb.DeliveryLookup) (*pb.Delivery, error) {
	for i := len(m.sent) - 1; i >= 0; i-- {
		if m.sent[i].effectID == req.GetEffectId() {
			return &pb.Delivery{MessageId: m.sent[i].messageID, EffectId: m.sent[i].effectID}, nil
		}
	}
	return nil, status.Errorf(codes.NotFound, "no message for %s", req.GetEffectId())
}

func client(ctx *harness.Ctx) *mailerPeer {
	mailer := &mailerPeer{}
	pb.RegisterMailerServer(ctx.GRPC.Server(""), mailer)
	return mailer
}

func atSendWelcome(ctx *harness.Ctx, runID string) {
	ctx.Redis.Do("HSET", "run:"+runID+":checkpoint", "current_step", "send_welcome", "completed", "create_account", "output_ref", "", "updated_at", "1000")
}

func currentStep(ctx *harness.Ctx, runID string) string {
	step, _ := ctx.Redis.HGet("run:"+runID+":checkpoint", "current_step")
	return step
}

func mustStep(ctx *harness.Ctx, runID string) string {
	messageID, err := runStep(clientBg, runID, "send_welcome", "notify_sales", "u-1")
	ctx.NoError(err, "runStep(%s, send_welcome) failed", runID)
	return messageID
}

func CheckEffectId(ctx *harness.Ctx) {
	client(ctx)
	for _, runID := range []string{"r1", "r2"} {
		atSendWelcome(ctx, runID)
		mustStep(ctx, runID)
	}
	var ids []string
	for _, c := range ctx.GRPC.CallsTo("SendWelcome", "") {
		ids = append(ids, c.Request.(*pb.WelcomeRequest).GetEffectId())
	}
	ctx.Equal(ids, []string{"r1:send_welcome", "r2:send_welcome"}, "the SendWelcome effect ids (a random id per attempt links no retry to the attempt before it)")
}

func CheckReplaySkip(ctx *harness.Ctx) {
	mailer := client(ctx)
	atSendWelcome(ctx, "r1")
	first := mustStep(ctx, "r1")
	replay := mustStep(ctx, "r1") // a worker that restarted runs the step again
	ctx.Equal(len(mailer.sent), 1, "running send_welcome twice for r1 must send one email (a replay returns the recorded outcome without calling); the emails")
	ctx.Equal(replay, first, "a replay returns the recorded message id; the replay")
}

func CheckEffectBeforeAdvance(ctx *harness.Ctx) {
	client(ctx)
	atSendWelcome(ctx, "r1")
	ctx.GRPC.Fail("SendWelcome", codes.Unavailable, "mailer is down", 1, "")
	_, err := runStep(clientBg, "r1", "send_welcome", "notify_sales", "u-1")
	ctx.Assert(err != nil, "runStep returned no error while the mailer was down")
	ctx.Equal(currentStep(ctx, "r1"), "send_welcome", "the mailer was down and no email went out, so the checkpoint must not move (the run would never send it); current_step")
}

func CheckRecordBeforeAdvance(ctx *harness.Ctx) {
	client(ctx)
	atSendWelcome(ctx, "r1")
	seen := ctx.Redis.After("run:r1:checkpoint", func() any {
		recorded, _ := ctx.Redis.Get("effect:r1:send_welcome")
		return recorded
	})
	messageID := mustStep(ctx, "r1")
	ctx.Assert(seen.Fired, "runStep never advanced run:r1:checkpoint")
	ctx.Equal(seen.Result, messageID, "when the checkpoint moved, the ledger must already hold the message id for r1:send_welcome (a crash right there leaves a step marked done whose email no replay can find); the record")
}

func CheckTimeoutReconcile(ctx *harness.Ctx) {
	mailer := client(ctx)
	atSendWelcome(ctx, "r1")
	mailer.loseReplies = 1 // the email goes out, the reply is lost
	messageID := mustStep(ctx, "r1")
	ctx.Equal(len(mailer.sent), 1, "SendWelcome timed out after the email went out: ask GetDelivery by effect id instead of sending again; the emails")
	ctx.Equal(messageID, mailer.sent[0].messageID, "runStep must return the delivered message id")
	recorded, _ := ctx.Redis.Get("effect:r1:send_welcome")
	ctx.Equal(recorded, messageID, "the reconciled outcome must be recorded in the ledger")
	for _, call := range ctx.GRPC.CallsTo("SendWelcome", "") {
		ctx.Assert(call.HasDeadline() && 1500*time.Millisecond <= call.Timeout && call.Timeout <= 2500*time.Millisecond, "a SendWelcome call carries a %v deadline, expected 2 s", call.Timeout)
	}
	// A deadline whose request never arrived: nothing to find, and the request may still be in flight.
	atSendWelcome(ctx, "r2")
	before := len(ctx.GRPC.CallsTo("SendWelcome", ""))
	ctx.GRPC.Fail("SendWelcome", codes.DeadlineExceeded, "deadline exceeded", 1, "")
	_, err := runStep(clientBg, "r2", "send_welcome", "notify_sales", "u-1")
	ctx.Assert(err != nil, "runStep returned no error after a deadline with no delivery found: it must fail (ErrEffectPending) so the step is retried later")
	ctx.Equal(len(ctx.GRPC.CallsTo("SendWelcome", ""))-before, 1, "after a deadline with no delivery found, a resend on the spot doubles the email when the first request is still in flight; the SendWelcome calls")
	ctx.Equal(currentStep(ctx, "r2"), "send_welcome", "r2's email is unaccounted for, so its checkpoint must not move; current_step")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "workflow_engine.grpc.pb.h"

namespace {

// Sends whatever it is asked to (no deduplication); lose_replies sends, then answers DEADLINE_EXCEEDED.
class MailerPeer final : public workflowd::Mailer::Service {
 public:
  std::vector<std::pair<std::string, std::string>> sent;  // (effect_id, message_id), oldest first
  int lose_replies = 0;

  grpc::Status SendWelcome(grpc::ServerContext*, const workflowd::WelcomeRequest* req, workflowd::Delivery* out) override {
    const std::string id = "m-" + std::to_string(sent.size() + 1);
    sent.emplace_back(req->effect_id(), id);
    if (lose_replies > 0) {
      lose_replies--;
      return grpc::Status(grpc::StatusCode::DEADLINE_EXCEEDED, "the email went out, the reply was lost");
    }
    out->set_message_id(id);
    out->set_effect_id(req->effect_id());
    return grpc::Status::OK;
  }

  grpc::Status GetDelivery(grpc::ServerContext*, const workflowd::DeliveryLookup* req, workflowd::Delivery* out) override {
    for (auto it = sent.rbegin(); it != sent.rend(); ++it) {
      if (it->first == req->effect_id()) {
        out->set_message_id(it->second);
        out->set_effect_id(it->first);
        return grpc::Status::OK;
      }
    }
    return grpc::Status(grpc::StatusCode::NOT_FOUND, "no message for " + req->effect_id());
  }
};

MailerPeer& client(harness::Ctx& ctx) {
  static MailerPeer* peer = nullptr;
  delete peer;
  peer = new MailerPeer;
  ctx.GRPC.Server("")->RegisterService(peer);
  return *peer;
}

void atSendWelcome(harness::Ctx& ctx, const std::string& run_id) {
  ctx.Redis.Do("HSET", "run:" + run_id + ":checkpoint", "current_step", "send_welcome", "completed", "create_account", "output_ref", "", "updated_at", "1000");
}

std::string currentStep(harness::Ctx& ctx, const std::string& run_id) { return ctx.Redis.HGet("run:" + run_id + ":checkpoint", "current_step").value_or(""); }

std::string mustStep(harness::Ctx& ctx, const std::string& run_id) {
  try {
    return runStep(run_id, "send_welcome", "notify_sales", "u-1");
  } catch (const std::exception& e) {
    ctx.Fatalf("runStep(%s, send_welcome) threw %s: %s", run_id, harness::CurrentExceptionType(), e.what());
  }
  return "";
}

bool fails(const std::string& run_id) {
  try {
    runStep(run_id, "send_welcome", "notify_sales", "u-1");
  } catch (const std::exception&) {
    return true;
  }
  return false;
}

}  // namespace

void CheckEffectId(harness::Ctx& ctx) {
  client(ctx);
  for (const std::string run_id : {"r1", "r2"}) {
    atSendWelcome(ctx, run_id);
    mustStep(ctx, run_id);
  }
  std::vector<std::string> ids;
  for (const auto& c : ctx.GRPC.CallsTo("SendWelcome")) ids.push_back(c.Request<workflowd::WelcomeRequest>().effect_id());
  ctx.Equal(ids, {"r1:send_welcome", "r2:send_welcome"}, "the SendWelcome effect ids (a random id per attempt links no retry to the attempt before it)");
}

void CheckReplaySkip(harness::Ctx& ctx) {
  MailerPeer& mailer = client(ctx);
  atSendWelcome(ctx, "r1");
  const std::string first = mustStep(ctx, "r1");
  const std::string replay = mustStep(ctx, "r1");  // a worker that restarted runs the step again
  ctx.Equal(mailer.sent.size(), 1, "running send_welcome twice for r1 must send one email (a replay returns the recorded outcome without calling); the emails");
  ctx.Equal(replay, first, "a replay returns the recorded message id; the replay");
}

void CheckEffectBeforeAdvance(harness::Ctx& ctx) {
  client(ctx);
  atSendWelcome(ctx, "r1");
  ctx.GRPC.Fail("SendWelcome", grpc::StatusCode::UNAVAILABLE, "mailer is down");
  ctx.Assert(fails("r1"), "runStep returned normally while the mailer was down");
  ctx.Equal(currentStep(ctx, "r1"), "send_welcome", "the mailer was down and no email went out, so the checkpoint must not move (the run would never send it); current_step");
}

void CheckRecordBeforeAdvance(harness::Ctx& ctx) {
  client(ctx);
  atSendWelcome(ctx, "r1");
  bool fired = false;
  std::optional<std::string> recorded;
  ctx.Redis.After("run:r1:checkpoint", [&] {
    fired = true;
    recorded = ctx.Redis.Get("effect:r1:send_welcome");
  });
  const std::string message_id = mustStep(ctx, "r1");
  ctx.Assert(fired, "runStep never advanced run:r1:checkpoint");
  ctx.Equal(recorded.value_or(""), message_id, "when the checkpoint moved, the ledger must already hold the message id for r1:send_welcome (a crash right there leaves a step marked done whose email no replay can find); the record");
}

void CheckTimeoutReconcile(harness::Ctx& ctx) {
  MailerPeer& mailer = client(ctx);
  atSendWelcome(ctx, "r1");
  mailer.lose_replies = 1;  // the email goes out, the reply is lost
  const std::string message_id = mustStep(ctx, "r1");
  ctx.Equal(mailer.sent.size(), 1, "SendWelcome timed out after the email went out: ask GetDelivery by effect id instead of sending again; the emails");
  ctx.Equal(message_id, mailer.sent[0].second, "runStep must return the delivered message id");
  ctx.Equal(ctx.Redis.Get("effect:r1:send_welcome").value_or(""), message_id, "the reconciled outcome must be recorded in the ledger");
  for (const auto& call : ctx.GRPC.CallsTo("SendWelcome")) {
    ctx.Assert(call.HasDeadline() && 1.5 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 2.5, "a SendWelcome call carries a %v s deadline, expected kDeadline = 2 s", call.TimeoutSeconds());
  }
  // A deadline whose request never arrived: nothing to find, and the request may still be in flight.
  atSendWelcome(ctx, "r2");
  const size_t before = ctx.GRPC.CallsTo("SendWelcome").size();
  ctx.GRPC.Fail("SendWelcome", grpc::StatusCode::DEADLINE_EXCEEDED, "deadline exceeded");
  ctx.Assert(fails("r2"), "runStep returned normally after a deadline with no delivery found: it must throw (EffectPending) so the step is retried later");
  ctx.Equal(ctx.GRPC.CallsTo("SendWelcome").size() - before, 1, "after a deadline with no delivery found, a resend on the spot doubles the email when the first request is still in flight; the SendWelcome calls");
  ctx.Equal(currentStep(ctx, "r2"), "send_welcome", "r2's email is unaccounted for, so its checkpoint must not move; current_step");
}
`,
  },
  hints: [
    'A worker restarts mid-run and the customer gets two welcome emails; another run says `send_welcome` is done and no email exists; a slow mailer turns one signup into two emails.',
    '`run_step` advances before it calls, so a crash after the advance loses the email. A fresh UUID per attempt links nothing to the attempt before, and no ledger is read, so every replay and every timeout sends again.',
    '`key = f"{run_id}:{step}"`; `ledger.done(key)` hit → return it. Else `SendWelcome(effect_id=key)`; on `DEADLINE_EXCEEDED` `GetDelivery(key)`, `NOT_FOUND` → `EffectPending`. Then `ledger.record`, then `checkpoint.advance(…, message_id, …)`.',
  ],
  debrief: `The worker can stop between any two lines, and the caller of \`SendWelcome\` cannot tell a lost request from a lost reply, so the fix is an order and an identity, not a retry policy. The effect id is a function of the run and the step, so every attempt of one step shares it: the ledger finds the first attempt's record, and the mailer can be asked whether that id was delivered. Recording before advancing means a crash leaves a record and an unmoved checkpoint, which the replay resolves without a call. A miss after a timeout fails instead of resending, because the first request may still be in flight. Production engines also pass the id to the target as an idempotency key, as Stripe's \`Idempotency-Key\` header does, so the target deduplicates a resend itself.`,
};
