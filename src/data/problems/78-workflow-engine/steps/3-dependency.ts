import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Side-effect calls guarded by an effect ledger',
  concept: 'grpc',
  file: 'client',
  focus: ['worker', 'effects', 'ledger'],
  task: `## Task

**Review premise.** Step 1 published and pinned the definition; this is the half of \`workflowd\` that
executes it. The starter is a plausible model-generated draft: it marks the step done, calls
\`SendWelcome\`, and when the call deadlines it calls again, so the demo's welcome email goes out. It
hides the flaw that decides whether a run may be replayed at all — the side effect is guarded by
nothing. Review it like the on-call engineer who owns the customer's inbox, fix it, and prove the fix
with the checks below.

Implement \`run_step(run_id, step, payload, stub)\`: one step's side effect over gRPC, exactly once.

- Every step's effect carries a **deterministic** id. \`effect_id(run_id, step)\` returns
  \`f"{run_id}:{step}"\`, so a replay of the same step computes the same key; a fresh uuid per attempt
  would leave the ledger unable to recognise its own record.
- Read the **effect ledger** *before* the call: \`done = ledger.done(key)\`, and when it is not
  \`None\` return the recorded outcome and never touch the target. That read is the replay skip, and
  the value in \`done\` is exactly what a resumed worker answers with.
- Call the target under a **2 s deadline** (\`stub.SendWelcome(...)\`, \`timeout=2\`,
  \`withDeadlineAfter\`, \`set_deadline\`): a call without one pins the worker for as long as the
  target cares to take.
- Write in this order: \`ledger.record(key, outcome)\` **first** and
  \`runs.mark_done(run_id, step)\` **after**. The draft has it the other way round, so a crash
  between the two loses the effect forever: the checkpoint says the step is done and the email was
  never sent.
- A \`DEADLINE_EXCEEDED\` is **ambiguous**, not a failure — the request may have arrived and only
  the response been lost. Consult the ledger again before any retry, and when it still holds no
  record for the key, fail loudly instead of resending.

**Failure mode the checks target.** Marking the step done before the call turns a crash in that
window into a side effect that is never executed and never retried. Retrying a timeout without the
ledger sends the welcome email twice to a customer who already got it. Both are invisible in a demo
where nothing crashes and the target answers in milliseconds, and both are the reason the record
must come before the checkpoint and a deadline must be reconciled instead of resent.`,
  sequence: {
    participants: ['Worker', 'Effect ledger', 'Welcome service'],
    messages: [
      {
        from: 'Worker',
        to: 'Effect ledger',
        label: 'done(effect_id(run_id, step)) — has this step already run?',
        kind: 'sync',
      },
      {from: 'Effect ledger', to: 'Worker', label: 'the recorded outcome, or nothing', kind: 'reply'},
      {from: 'Worker', to: 'Worker', label: 'hit → return it, do not call the target', kind: 'sync'},
      {from: 'Worker', to: 'Welcome service', label: 'SendWelcome · 2 s deadline', kind: 'sync'},
      {from: 'Welcome service', to: 'Worker', label: 'message id', kind: 'reply'},
      {
        from: 'Worker',
        to: 'Effect ledger',
        label: 'on DEADLINE_EXCEEDED: done(effect_id) again before any retry',
        kind: 'sync',
      },
      {from: 'Worker', to: 'Effect ledger', label: 'record(effect_id, outcome)', kind: 'async'},
      {
        from: 'Worker',
        to: 'Worker',
        label: 'mark_done(run_id, step) — only after the record',
        kind: 'sync',
      },
    ],
  },
  checks: [
    {
      id: 'effect-id',
      title: 'Derives a deterministic effect id from run and step',
      detail:
        'The ledger key is a function of the run and the step — `f"{run_id}:{step}"` — so a replay of the same step computes the same id. The draft has no id at all, and a random one per attempt would make the ledger unable to recognise its own record.',
      match: {
        python: {all: [/def effect_id\(/, /\{run_id\}:\{step\}/]},
        typescript: {all: [/function effectId\(/, /\$\{runId\}:\$\{step\}/]},
        go: {all: [/func effectID\(/, /runID \+ ":" \+ step/]},
        scala: {all: [/def effectId\(/, /\$runId:\$step/]},
        cpp: {all: [/effectId\(/, /runId \+ ":" \+ step/]},
      },
    },
    {
      id: 'replay-skip',
      title: 'A replay returns the recorded outcome instead of calling',
      detail:
        '`done = ledger.done(key)` is read before the call and a recorded outcome is returned as it stands, keeping the value in `done`. The draft has no ledger, so every replay of a resumed step sends the welcome email again.',
      match: {
        python: {order: [/ledger\.done\(/, /return done/]},
        typescript: {order: [/ledger\.done\(/, /return done/]},
        go: {order: [/ledger\.Done\(/, /return done/]},
        scala: {order: [/ledger\.done\(/, /return done/]},
        cpp: {order: [/ledger\.done\(/, /return done;/]},
      },
    },
    {
      id: 'record-then-done',
      title: 'The ledger records the effect before the step is marked done',
      detail:
        '`ledger.record(key, outcome)` completes before `runs.mark_done(run_id, step)`, so a crash after the email still leaves a record that the replay returns. The draft marks the step done first, which is the order that loses the effect.',
      match: {
        python: {order: [/ledger\.record\(/, /runs\.mark_done\(/]},
        typescript: {order: [/ledger\.record\(/, /runs\.markDone\(/]},
        go: {order: [/ledger\.Record\(/, /runs\.MarkDone\(/]},
        scala: {order: [/ledger\.record\(/, /runs\.markDone\(/]},
        cpp: {order: [/ledger\.record\(/, /runs\.markDone\(/]},
      },
    },
    {
      id: 'call-then-record',
      title: 'The effect call precedes the ledger write',
      detail:
        '`SendWelcome` happens before anything is recorded, so the ledger only ever holds outcomes of effects that actually ran. Recording first would let the ledger accept a call that never reached the target.',
      match: {
        python: {order: [/stub\.SendWelcome\(/, /ledger\.record\(/]},
        typescript: {order: [/stub\.sendWelcome\(/, /ledger\.record\(/]},
        go: {order: [/stub\.SendWelcome\(/, /ledger\.Record\(/]},
        scala: {order: [/stub\.sendWelcome\(/, /ledger\.record\(/]},
        cpp: {order: [/SendWelcome\(/, /ledger\.record\(/]},
      },
    },
    {
      id: 'timeout-reconcile',
      title: 'A deadline is reconciled against the ledger before any retry',
      detail:
        'After `DEADLINE_EXCEEDED` the code reads `ledger.done(key)` a second time: a hit returns the recorded outcome, a miss fails loudly. The draft retries the call on the spot, so a timeout that already sent the email sends it twice.',
      match: {
        python: {order: [/DEADLINE_EXCEEDED/, /ledger\.done\(/]},
        typescript: {order: [/DEADLINE_EXCEEDED/, /ledger\.done\(/]},
        go: {order: [/codes\.DeadlineExceeded/, /ledger\.Done\(/]},
        scala: {order: [/DEADLINE_EXCEEDED/, /ledger\.done\(/]},
        cpp: {order: [/DEADLINE_EXCEEDED/, /ledger\.done\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""One step's side effect over gRPC: a model-generated draft with no effect ledger."""
import logging

import grpc

import welcome_pb2
import welcome_pb2_grpc

logger = logging.getLogger("workflowd.effects")

DEADLINE_S = 2


class RunStore:
    def mark_done(self, run_id: str, step: str) -> None:
        """Advance the run's checkpoint to the next step."""
        raise NotImplementedError


runs = RunStore()


def run_step(run_id: str, step: str, payload: dict, stub: welcome_pb2_grpc.WelcomeStub) -> dict:
    # TODO: this draft marks the step done before the effect runs, so a crash in between skips the
    # welcome email forever, and it retries a deadline blindly — a timeout that already sent the
    # email sends it twice. There is no effect ledger at all: no deterministic effect id, no read
    # before the call, and no record before the step is marked done.
    runs.mark_done(run_id, step)
    request = welcome_pb2.WelcomeRequest(to=payload["to"], name=payload.get("name", ""))
    try:
        reply = stub.SendWelcome(request, timeout=DEADLINE_S)
        return {"status": "ok", "message_id": reply.message_id}
    except grpc.RpcError as exc:
        if exc.code() == grpc.StatusCode.DEADLINE_EXCEEDED:
            logger.warning("welcome send deadlined, sending again")
            retry = stub.SendWelcome(request, timeout=DEADLINE_S)
            return {"status": "ok", "message_id": retry.message_id}
        raise
`,
      solution: `"""One step's side effect over gRPC: exactly once, guarded by the effect ledger."""
import logging

import grpc

import welcome_pb2
import welcome_pb2_grpc

logger = logging.getLogger("workflowd.effects")

DEADLINE_S = 2


class EffectLedger:
    def done(self, key: str) -> dict | None:
        """The outcome recorded under key, or None when the effect never ran."""
        raise NotImplementedError

    def record(self, key: str, outcome: dict) -> None:
        """Record the effect's outcome; the step is marked done only after this returns."""
        raise NotImplementedError


class RunStore:
    def mark_done(self, run_id: str, step: str) -> None:
        """Advance the run's checkpoint to the next step."""
        raise NotImplementedError


ledger = EffectLedger()
runs = RunStore()


def effect_id(run_id: str, step: str) -> str:
    """Deterministic, so a replay of the same step computes the same key."""
    return f"{run_id}:{step}"


def run_step(run_id: str, step: str, payload: dict, stub: welcome_pb2_grpc.WelcomeStub) -> dict:
    key = effect_id(run_id, step)
    done = ledger.done(key)
    if done is not None:
        logger.info("effect %s already ran, returning the recorded outcome", key)
        return done
    request = welcome_pb2.WelcomeRequest(to=payload["to"], name=payload.get("name", ""))
    try:
        reply = stub.SendWelcome(request, timeout=DEADLINE_S)
    except grpc.RpcError as exc:
        if exc.code() == grpc.StatusCode.DEADLINE_EXCEEDED:
            # A deadline is ambiguous: the email may have gone out. Ask the ledger, never resend.
            reconciled = ledger.done(key)
            if reconciled is not None:
                return reconciled
            raise
        raise
    outcome = {"status": "ok", "message_id": reply.message_id}
    ledger.record(key, outcome)
    runs.mark_done(run_id, step)
    return outcome
`,
    },
    typescript: {
      starter: `/** One step's side effect over gRPC: a model-generated draft with no effect ledger. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const DEADLINE_MS = 2_000;

export interface WelcomeRequest {
  to: string;
  name: string;
}

export interface WelcomeReply {
  messageId: string;
}

export interface Outcome {
  status: string;
  messageId: string;
}

export interface WelcomeClient {
  sendWelcome(request: WelcomeRequest, options: {deadline: number}): Promise<WelcomeReply>;
}

const {welcome} = grpc.loadPackageDefinition(protoLoader.loadSync('welcome.proto')) as unknown as {
  welcome: {Welcome: new (target: string, credentials: grpc.ChannelCredentials) => WelcomeClient};
};

export function welcomeClient(target = 'welcome:9000'): WelcomeClient {
  return new welcome.Welcome(target, grpc.credentials.createInsecure());
}

const runs = {
  async markDone(runId: string, step: string): Promise<void> {
    throw new Error('not implemented');
  },
};

export async function runStep(
  runId: string,
  step: string,
  payload: WelcomeRequest,
  stub: WelcomeClient,
): Promise<Outcome> {
  // TODO: this draft marks the step done before the effect runs, so a crash in between skips the
  // welcome email forever, and it retries a deadline blindly — a timeout that already sent the
  // email sends it twice. There is no effect ledger at all: no deterministic effect id, no read
  // before the call, and no record before the step is marked done.
  await runs.markDone(runId, step);
  try {
    const reply = await stub.sendWelcome(payload, {deadline: Date.now() + DEADLINE_MS});
    return {status: 'ok', messageId: reply.messageId};
  } catch (error) {
    if ((error as grpc.ServiceError).code === grpc.status.DEADLINE_EXCEEDED) {
      const retry = await stub.sendWelcome(payload, {deadline: Date.now() + DEADLINE_MS});
      return {status: 'ok', messageId: retry.messageId};
    }
    throw error;
  }
}
`,
      solution: `/** One step's side effect over gRPC: exactly once, guarded by the effect ledger. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const DEADLINE_MS = 2_000;

export interface WelcomeRequest {
  to: string;
  name: string;
}

export interface WelcomeReply {
  messageId: string;
}

export interface Outcome {
  status: string;
  messageId: string;
}

export interface WelcomeClient {
  sendWelcome(request: WelcomeRequest, options: {deadline: number}): Promise<WelcomeReply>;
}

const {welcome} = grpc.loadPackageDefinition(protoLoader.loadSync('welcome.proto')) as unknown as {
  welcome: {Welcome: new (target: string, credentials: grpc.ChannelCredentials) => WelcomeClient};
};

export function welcomeClient(target = 'welcome:9000'): WelcomeClient {
  return new welcome.Welcome(target, grpc.credentials.createInsecure());
}

class EffectLedger {
  /** The outcome recorded under key, or null when the effect never ran. */
  async done(key: string): Promise<Outcome | null> {
    throw new Error('not implemented');
  }

  /** Record the effect's outcome; the step is marked done only after this returns. */
  async record(key: string, outcome: Outcome): Promise<void> {
    throw new Error('not implemented');
  }
}

class RunStore {
  /** Advance the run's checkpoint to the next step. */
  async markDone(runId: string, step: string): Promise<void> {
    throw new Error('not implemented');
  }
}

const ledger = new EffectLedger();
const runs = new RunStore();

/** Deterministic, so a replay of the same step computes the same key. */
export function effectId(runId: string, step: string): string {
  return \`\${runId}:\${step}\`;
}

export async function runStep(
  runId: string,
  step: string,
  payload: WelcomeRequest,
  stub: WelcomeClient,
): Promise<Outcome> {
  const key = effectId(runId, step);
  const done = await ledger.done(key);
  if (done !== null) return done;
  let reply: WelcomeReply;
  try {
    reply = await stub.sendWelcome(payload, {deadline: Date.now() + DEADLINE_MS});
  } catch (error) {
    if ((error as grpc.ServiceError).code === grpc.status.DEADLINE_EXCEEDED) {
      // A deadline is ambiguous: the email may have gone out. Ask the ledger, never resend.
      const reconciled = await ledger.done(key);
      if (reconciled !== null) return reconciled;
      throw new Error(\`welcome send deadlined with no ledger record for \${key}\`);
    }
    throw error;
  }
  const outcome: Outcome = {status: 'ok', messageId: reply.messageId};
  await ledger.record(key, outcome);
  await runs.markDone(runId, step);
  return outcome;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "workflow/welcomepb"
)

const deadlineS = 2

type RunStore struct{}

// MarkDone advances the run's checkpoint to the next step.
func (s *RunStore) MarkDone(ctx context.Context, runID, step string) error { return nil }

var runs = &RunStore{}

// TODO: this draft marks the step done before the effect runs, so a crash in between skips the
// welcome email forever, and it retries a deadline blindly — a timeout that already sent the email
// sends it twice. There is no effect ledger at all: no deterministic effect id, no read before the
// call, and no record before the step is marked done.
func runStep(ctx context.Context, runID, step string, payload *pb.WelcomeRequest, stub pb.WelcomeClient) (*pb.WelcomeReply, error) {
	if err := runs.MarkDone(ctx, runID, step); err != nil {
		return nil, err
	}
	callCtx, cancel := context.WithTimeout(ctx, deadlineS*time.Second)
	defer cancel()
	reply, err := stub.SendWelcome(callCtx, payload)
	if err != nil {
		if status.Code(err) == codes.DeadlineExceeded {
			retryCtx, retryCancel := context.WithTimeout(ctx, deadlineS*time.Second)
			defer retryCancel()
			return stub.SendWelcome(retryCtx, payload)
		}
		return nil, err
	}
	return reply, nil
}
`,
      solution: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "workflow/welcomepb"
)

const deadlineS = 2

type EffectLedger struct{}

// Done returns the outcome recorded under key, or nil when the effect never ran.
func (l *EffectLedger) Done(ctx context.Context, key string) (*pb.WelcomeReply, error) {
	return nil, nil
}

// Record writes the effect's outcome; the step is marked done only after this returns.
func (l *EffectLedger) Record(ctx context.Context, key string, outcome *pb.WelcomeReply) error {
	return nil
}

type RunStore struct{}

// MarkDone advances the run's checkpoint to the next step.
func (s *RunStore) MarkDone(ctx context.Context, runID, step string) error { return nil }

var (
	ledger = &EffectLedger{}
	runs   = &RunStore{}
)

// effectID is deterministic, so a replay of the same step computes the same key.
func effectID(runID, step string) string {
	return runID + ":" + step
}

func runStep(ctx context.Context, runID, step string, payload *pb.WelcomeRequest, stub pb.WelcomeClient) (*pb.WelcomeReply, error) {
	key := effectID(runID, step)
	done, err := ledger.Done(ctx, key)
	if err != nil {
		return nil, err
	}
	if done != nil {
		return done, nil
	}
	callCtx, cancel := context.WithTimeout(ctx, deadlineS*time.Second)
	defer cancel()
	reply, err := stub.SendWelcome(callCtx, payload)
	if err != nil {
		if status.Code(err) == codes.DeadlineExceeded {
			// A deadline is ambiguous: the email may have gone out. Ask the ledger, never resend.
			reconciled, lookupErr := ledger.Done(ctx, key)
			if lookupErr != nil {
				return nil, lookupErr
			}
			if reconciled != nil {
				return reconciled, nil
			}
			return nil, err
		}
		return nil, err
	}
	if err := ledger.Record(ctx, key, reply); err != nil {
		return nil, err
	}
	if err := runs.MarkDone(ctx, runID, step); err != nil {
		return nil, err
	}
	return reply, nil
}
`,
    },
    scala: {
      starter: `import java.util.concurrent.TimeUnit

import io.grpc.{Status, StatusRuntimeException}

object Effects {
  val DeadlineMs = 2000

  object runs {
    /** Advance the run's checkpoint to the next step. */
    def markDone(runId: String, step: String): Unit = ()
  }

  // TODO: this draft marks the step done before the effect runs, so a crash in between skips the
  // welcome email forever, and it retries a deadline blindly — a timeout that already sent the
  // email sends it twice. There is no effect ledger at all: no deterministic effect id, no read
  // before the call, and no record before the step is marked done.
  def runStep(
      runId: String,
      step: String,
      payload: WelcomeRequest,
      stub: WelcomeServiceGrpc.WelcomeServiceBlockingStub): WelcomeReply = {
    runs.markDone(runId, step)
    try {
      stub.withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS).sendWelcome(payload)
    } catch {
      case _: StatusRuntimeException =>
        stub.withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS).sendWelcome(payload)
    }
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{Status, StatusRuntimeException}

object Effects {
  val DeadlineMs = 2000

  object ledger {
    /** The outcome recorded under key, or None when the effect never ran. */
    def done(key: String): Option[WelcomeReply] = None

    /** Record the effect's outcome; the step is marked done only after this returns. */
    def record(key: String, outcome: WelcomeReply): Unit = ()
  }

  object runs {
    /** Advance the run's checkpoint to the next step. */
    def markDone(runId: String, step: String): Unit = ()
  }

  /** Deterministic, so a replay of the same step computes the same key. */
  def effectId(runId: String, step: String): String = s"$runId:$step"

  /** One attempt: the deadline is on the call itself, never around it. */
  private def sendOnce(stub: WelcomeServiceGrpc.WelcomeServiceBlockingStub, payload: WelcomeRequest): WelcomeReply =
    stub.sendWelcome(payload)

  def runStep(
      runId: String,
      step: String,
      payload: WelcomeRequest,
      stub: WelcomeServiceGrpc.WelcomeServiceBlockingStub): WelcomeReply = {
    val key = effectId(runId, step)
    val done = ledger.done(key)
    if (done.isDefined) return done.get
    val reply =
      try {
        sendOnce(stub.withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS), payload)
      } catch {
        case exc: StatusRuntimeException if exc.getStatus.getCode == Status.Code.DEADLINE_EXCEEDED =>
          // A deadline is ambiguous: the email may have gone out. Ask the ledger, never resend.
          val reconciled = ledger.done(key)
          if (reconciled.isDefined) reconciled.get else throw exc
      }
    ledger.record(key, reply)
    runs.markDone(runId, step)
    reply
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include "welcome.grpc.pb.h"

#include <chrono>
#include <stdexcept>
#include <string>

constexpr int kDeadlineS = 2;

struct RunStore {
  void markDone(const std::string& runId, const std::string& step);
};

RunStore runs;

// TODO: this draft marks the step done before the effect runs, so a crash in between skips the
// welcome email forever, and it retries a deadline blindly — a timeout that already sent the email
// sends it twice. There is no effect ledger at all: no deterministic effect id, no read before the
// call, and no record before the step is marked done.
WelcomeReply runStep(const std::string& runId, const std::string& step, const WelcomeRequest& payload, Welcome::Stub* stub) {
  runs.markDone(runId, step);
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(kDeadlineS));
  WelcomeReply reply;
  grpc::Status status = stub->SendWelcome(&ctx, payload, &reply);
  if (!status.ok() && status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED) {
    grpc::ClientContext retry;
    retry.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(kDeadlineS));
    status = stub->SendWelcome(&retry, payload, &reply);
  }
  if (!status.ok()) throw std::runtime_error(status.error_message());
  return reply;
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include "welcome.grpc.pb.h"

#include <chrono>
#include <stdexcept>
#include <string>

constexpr int kDeadlineS = 2;

/** What the effect produced, and whether the ledger actually holds a record of it. */
struct Outcome {
  bool recorded = false;
  std::string status;
  std::string message_id;
};

struct EffectLedger {
  /** The outcome recorded under key; recorded stays false when the effect never ran. */
  Outcome done(const std::string& key) { throw std::logic_error("not implemented"); }

  /** Record the effect's outcome; the step is marked done only after this returns. */
  void record(const std::string& key, const Outcome& outcome) { throw std::logic_error("not implemented"); }
};

struct RunStore {
  /** Advance the run's checkpoint to the next step. */
  void markDone(const std::string& runId, const std::string& step) { throw std::logic_error("not implemented"); }
};

EffectLedger ledger;
RunStore runs;

/** Deterministic, so a replay of the same step computes the same key. */
std::string effectId(const std::string& runId, const std::string& step) {
  return runId + ":" + step;
}

Outcome runStep(const std::string& runId, const std::string& step, const WelcomeRequest& payload, Welcome::Stub* stub) {
  const std::string key = effectId(runId, step);
  Outcome done = ledger.done(key);
  if (done.recorded) return done;
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(kDeadlineS));
  WelcomeReply reply;
  const grpc::Status status = stub->SendWelcome(&ctx, payload, &reply);
  if (!status.ok()) {
    if (status.error_code() != grpc::StatusCode::DEADLINE_EXCEEDED) throw std::runtime_error(status.error_message());
    // A deadline is ambiguous: the email may have gone out. Ask the ledger, never resend.
    done = ledger.done(key);
    if (done.recorded) return done;
    throw std::runtime_error("welcome send deadlined with no ledger record: " + status.error_message());
  }
  Outcome outcome;
  outcome.recorded = true;
  outcome.status = "ok";
  outcome.message_id = reply.message_id();
  ledger.record(key, outcome);
  runs.markDone(runId, step);
  return outcome;
}
`,
    },
  },
  hints: [
    'The ledger key is the effect id: a function of the run and the step (`f"{run_id}:{step}"`), computed the same way on every attempt. A fresh uuid per call makes the ledger useless, because the replay cannot recognise what the first attempt wrote.',
    'Read before you call: `done = ledger.done(key)`, return `done` when it is not `None`, and only then `stub.SendWelcome(...)`. After the call — never before it — `ledger.record(key, outcome)` and then `runs.mark_done(run_id, step)`: the record has to survive a crash that kills the process before the checkpoint is written.',
    'A deadline is an unknown, not a failure. Catch it, then call `ledger.done(key)` a second time: a record means the email went out and you return it, no record means it did not and you raise instead of resending, because a second `SendWelcome` is a second email to the customer.',
  ],
  debrief: `The interviewer is asking one question: what happens if this step runs twice? A workflow step is executed by a worker that can crash between any two lines and be replaced, and the caller of \`SendWelcome\` cannot tell a lost request from a lost response. The deterministic effect id is what makes the ledger able to answer at all — a uuid minted per attempt records an effect nobody will ever look up again. Reading the ledger before the call turns a replay into a lookup, and recording the outcome before the checkpoint means a crash after the email still leaves the run knowing the email happened; the draft's order says the step is done while the email may never have been sent, which is the one failure no one notices until a customer complains. The second read after a deadline is the same idea applied to an ambiguous failure: a timeout means "unknown", and the ledger is the only thing that can resolve it, so a miss is a loud failure rather than a resend. Production adds a TTL and a status column on the ledger row so a long-dead attempt can be retried, an expiry after which an effect is considered abandoned, and a provider-side idempotency key so even the first send is safe.`,
};
