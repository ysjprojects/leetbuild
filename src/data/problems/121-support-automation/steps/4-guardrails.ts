import type {Step} from '@/lib/types';

export const guardrailsStep: Step = {
  id: 'guardrails',
  title: 'Guardrails framework: parallel checks, one deadline, fail closed',
  concept: 'grpc',
  file: 'guardrail_gate',
  focus: ['workflow', 'guardrails', 'human'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft of the gate between the
reasoning loop's result and the customer: it asks the Guardrail Framework whether the draft answer
is relevant and returns the answer. When the guardrail service is healthy and the answer is fine,
the demo passes. It hides four production flaws. Review it like the owner of the guardrails, fix
it, and prove the fix.

Implement \`gate(turn, draft, context)\`, run once per turn after the loop produces a result and
before anything reaches the customer:

- The configured guardrails are \`GUARDRAILS = ("relevance", "groundedness", "pii")\`: is the
  answer about the question, is it grounded in the assembled context (the hallucination check),
  does it leak personal data. Every one of them runs on every turn; a product cannot ship with the
  groundedness guardrail quietly skipped.
- They run **in parallel** — \`Check\` on \`guardrails:9200\` once per guardrail, started together
  — under **one 2 s deadline** (\`GUARDRAIL_DEADLINE_S\`). Three sequential 2 s checks would
  triple the tail latency of every turn.
- A guardrail that times out or fails with any status is a failed verdict (\`ERROR\`), not a pass.
  The gate **fails closed**: an unverified answer is an unverified answer.
- Any verdict other than \`PASS\` **blocks the answer** and hands the conversation to a human
  agent: \`handoff.escalate(conversation, turn_id, verdicts)\`; the turn's status is \`escalated\`
  and the draft is never returned. Only when every verdict is \`PASS\` is the status \`answered\`.
- The verdicts are returned with the turn either way, so step 5 can record them.

**Failure mode the checks target.** The draft runs one guardrail, waits for it with no deadline,
treats an exception as "nothing to see", and on an explicit \`FAIL\` logs a warning and returns the
answer anyway. In production the guardrail service's slow day becomes the assistant's slow day,
and its outage becomes the day every hallucinated refund policy reached a guest.`,
  sequence: {
    participants: ['CoT workflow', 'Guardrail Framework', 'Human agent'],
    messages: [
      {from: 'CoT workflow', to: 'Guardrail Framework', label: 'Check relevance · deadline 2 s', kind: 'sync'},
      {from: 'CoT workflow', to: 'Guardrail Framework', label: 'Check groundedness · same deadline', kind: 'sync'},
      {from: 'CoT workflow', to: 'Guardrail Framework', label: 'Check pii · same deadline', kind: 'sync'},
      {from: 'Guardrail Framework', to: 'CoT workflow', label: 'PASS · FAIL · (timeout → ERROR)', kind: 'reply'},
      {
        from: 'CoT workflow',
        to: 'Human agent',
        label: 'escalate(conversation, turn, verdicts) on any non-PASS',
        kind: 'async',
      },
      {from: 'CoT workflow', to: 'CoT workflow', label: 'answered only when every verdict is PASS', kind: 'sync'},
    ],
  },
  hints: [
    'Make the guardrail list data, not code: a tuple of names and one loop that builds a `CheckRequest` per name. Start all the calls before waiting on any of them — `.future()` on the stub, `Promise.all`, goroutines with a `WaitGroup`, `Future.sequence`, `std::async` — and give each the same 2 s deadline.',
    'Collect verdicts into a map keyed by guardrail name. An RPC error — including `DEADLINE_EXCEEDED` — writes `"ERROR"` into the map instead of being swallowed; the decision afterwards is simply "is every value `PASS`?".',
    'When any verdict is not `PASS`, call `handoff.escalate(conversation, turn_id, verdicts)` and return `{status: "escalated", verdicts}` without the draft. The log line in the starter is where the draft leaks: a warning is not a block.',
  ],
  checks: [
    {
      id: 'all-guardrails',
      title: 'Runs every configured guardrail',
      detail:
        '`GUARDRAILS` lists `relevance`, `groundedness` and `pii`, and the gate iterates the list to build one `Check` per guardrail. The draft hardcodes a single relevance check.',
      match: {
        python: {all: [/GUARDRAILS\s*=/, /"groundedness"/, /"pii"/, /in GUARDRAILS/]},
        typescript: {all: [/GUARDRAILS\s*=/, /'groundedness'/, /'pii'/, /GUARDRAILS\.map\(/]},
        go: {all: [/guardrailNames\s*=/, /"groundedness"/, /"pii"/, /range guardrailNames/]},
        scala: {all: [/Guardrails\s*=\s*Seq\(/, /"groundedness"/, /"pii"/, /Guardrails\.map/]},
        cpp: {all: [/kGuardrails\s*=/, /"groundedness"/, /"pii"/, /:\s*kGuardrails\)/]},
      },
    },
    {
      id: 'parallel',
      title: 'Starts the checks together, not one after another',
      detail:
        'All `Check` calls are issued before any result is awaited — `.future()`, `Promise.all`, goroutines and a `WaitGroup`, `Future.sequence`, `std::async`. Sequential checks multiply the turn’s tail latency by the number of guardrails.',
      match: {
        python: {all: [/\.Check\.future\(/]},
        typescript: {all: [/Promise\.all\(/]},
        go: {all: [/sync\.WaitGroup/, /go func\(/]},
        scala: {all: [/Future\.sequence\(/]},
        cpp: {all: [/std::async\(\s*std::launch::async/]},
      },
    },
    {
      id: 'one-deadline',
      title: 'Every check carries the 2 s deadline',
      detail:
        '`GUARDRAIL_DEADLINE_S = 2` is set on each `Check` call — the same deadline for all of them, so the gate as a whole is bounded. The draft waits for the guardrail service indefinitely.',
      match: {
        python: {all: [/GUARDRAIL_DEADLINE_S\s*=\s*2/, /timeout=GUARDRAIL_DEADLINE_S/]},
        typescript: {
          all: [/GUARDRAIL_DEADLINE_MS\s*=\s*2_?000/, /deadline\s*=\s*Date\.now\(\)\s*\+\s*GUARDRAIL_DEADLINE_MS/],
        },
        go: {all: [/guardrailDeadline\s*=\s*2\s*\*\s*time\.Second/, /context\.WithTimeout\([^)]*guardrailDeadline\)/]},
        scala: {all: [/GuardrailDeadlineMs\s*=\s*2000/, /withDeadlineAfter\(GuardrailDeadlineMs/]},
        cpp: {all: [/kGuardrailDeadlineMs\s*=\s*2000/, /std::chrono::milliseconds\(kGuardrailDeadlineMs\)/]},
      },
    },
    {
      id: 'fail-closed',
      title: 'A timeout or RPC error is a failed verdict',
      detail:
        'An RPC failure — `DEADLINE_EXCEEDED` included — records the verdict `ERROR` for that guardrail; nothing is swallowed. The draft catches the exception and continues as if the guardrail had passed.',
      match: {
        python: {all: [/except grpc\.RpcError/, /"ERROR"/], none: [/except[^\n]*:\s*\n\s*pass\b/]},
        typescript: {all: [/catch/, /'ERROR'/], none: [/catch\s*(\([^)]*\))?\s*\{\s*\}/]},
        go: {all: [/err != nil/, /"ERROR"/]},
        scala: {all: [/\.recover\s*\{/, /"ERROR"/]},
        cpp: {all: [/!status\.ok\(\)/, /"ERROR"/]},
      },
    },
    {
      id: 'escalate',
      title: 'Blocks the answer and escalates on any non-PASS verdict',
      detail:
        'Any verdict other than `PASS` calls `handoff.escalate(conversation, turn_id, verdicts)` and returns an `escalated` turn without the draft. The draft logs a warning and returns the answer anyway.',
      match: {
        python: {all: [/handoff\.escalate\(/, /"escalated"/]},
        typescript: {all: [/handoff\.escalate\(/, /'escalated'/]},
        go: {all: [/handoff\.Escalate\(/, /"escalated"/]},
        scala: {all: [/Handoff\.escalate\(/, /"escalated"/]},
        cpp: {all: [/handoff\.escalate\(/, /"escalated"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

import grpc

import apv2_pb2
import apv2_pb2_grpc

logger = logging.getLogger("guardrails")
guardrails = apv2_pb2_grpc.GuardrailsStub(grpc.insecure_channel("guardrails:9200"))


class Handoff:
    def escalate(self, conversation: str, turn_id: str, verdicts: dict[str, str]) -> None:
        """Queue the conversation for a human agent with the guardrail verdicts attached."""
        raise NotImplementedError


handoff = Handoff()


def gate(turn: dict, draft: str, context: dict) -> dict:
    # TODO: run relevance, groundedness and pii in parallel under one 2 s deadline, treat a
    # timeout as a failed verdict, and escalate instead of returning a failed answer.
    verdicts: dict[str, str] = {}
    try:
        request = apv2_pb2.CheckRequest(
            guardrail="relevance",
            conversation=turn["conversation"],
            draft=draft,
            context_json=json.dumps(context),
        )
        reply = guardrails.Check(request)
        verdicts["relevance"] = reply.verdict
        if reply.verdict != "PASS":
            logger.warning("guardrail relevance failed turn=%s reason=%s", turn["turn_id"], reply.reason)
    except Exception:
        pass
    return {"status": "answered", "result": draft, "verdicts": verdicts}
`,
      solution: `import json

import grpc

import apv2_pb2
import apv2_pb2_grpc

GUARDRAILS = ("relevance", "groundedness", "pii")
GUARDRAIL_DEADLINE_S = 2.0

guardrails = apv2_pb2_grpc.GuardrailsStub(grpc.insecure_channel("guardrails:9200"))


class Handoff:
    def escalate(self, conversation: str, turn_id: str, verdicts: dict[str, str]) -> None:
        """Queue the conversation for a human agent with the guardrail verdicts attached."""
        raise NotImplementedError


handoff = Handoff()


def gate(turn: dict, draft: str, context: dict) -> dict:
    context_json = json.dumps(context)
    pending = {}
    for name in GUARDRAILS:
        request = apv2_pb2.CheckRequest(
            guardrail=name,
            conversation=turn["conversation"],
            draft=draft,
            context_json=context_json,
        )
        pending[name] = guardrails.Check.future(request, timeout=GUARDRAIL_DEADLINE_S)

    verdicts: dict[str, str] = {}
    for name, future in pending.items():
        try:
            verdicts[name] = future.result().verdict
        except grpc.RpcError:
            verdicts[name] = "ERROR"

    if any(verdict != "PASS" for verdict in verdicts.values()):
        handoff.escalate(turn["conversation"], turn["turn_id"], verdicts)
        return {"status": "escalated", "verdicts": verdicts}
    return {"status": "answered", "result": draft, "verdicts": verdicts}
`,
    },
    typescript: {
      starter: `/** Guardrail gate: a model-generated draft that checks relevance and returns the answer regardless. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {handoff} from './handoff';

interface CheckReply {
  verdict: 'PASS' | 'FAIL';
  reason: string;
}

interface GuardrailsClient {
  Check(
    request: {guardrail: string; conversation: string; draft: string; context_json: string},
    callback: (error: grpc.ServiceError | null, reply: CheckReply) => void,
  ): void;
}

const {apv2} = grpc.loadPackageDefinition(protoLoader.loadSync('apv2.proto')) as unknown as {
  apv2: {Guardrails: new (target: string, credentials: grpc.ChannelCredentials) => GuardrailsClient};
};
const guardrails = new apv2.Guardrails('guardrails:9200', grpc.credentials.createInsecure());

export interface Turn {
  turn_id: string;
  conversation: string;
}

export interface Gated {
  status: 'answered' | 'escalated';
  result?: string;
  verdicts: Record<string, string>;
}

export async function gate(turn: Turn, draft: string, context: unknown): Promise<Gated> {
  // TODO: run relevance, groundedness and pii in parallel under one 2 s deadline, treat a
  // timeout as a failed verdict, and escalate instead of returning a failed answer.
  const verdicts: Record<string, string> = {};
  try {
    const reply = await new Promise<CheckReply>((resolve, reject) => {
      guardrails.Check(
        {guardrail: 'relevance', conversation: turn.conversation, draft, context_json: JSON.stringify(context)},
        (error, value) => (error ? reject(error) : resolve(value)),
      );
    });
    verdicts.relevance = reply.verdict;
    if (reply.verdict !== 'PASS') console.warn(\`guardrail relevance failed turn=\${turn.turn_id}: \${reply.reason}\`);
  } catch {
    // the guardrail service is best-effort
  }
  return {status: 'answered', result: draft, verdicts};
}
`,
      solution: `/** Guardrail gate: every configured guardrail in parallel under one deadline; fail closed; escalate. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {handoff} from './handoff';

const GUARDRAILS = ['relevance', 'groundedness', 'pii'] as const;
const GUARDRAIL_DEADLINE_MS = 2_000;

interface CheckReply {
  verdict: 'PASS' | 'FAIL';
  reason: string;
}

interface GuardrailsClient {
  Check(
    request: {guardrail: string; conversation: string; draft: string; context_json: string},
    metadata: grpc.Metadata,
    options: {deadline: number},
    callback: (error: grpc.ServiceError | null, reply: CheckReply) => void,
  ): void;
}

const {apv2} = grpc.loadPackageDefinition(protoLoader.loadSync('apv2.proto')) as unknown as {
  apv2: {Guardrails: new (target: string, credentials: grpc.ChannelCredentials) => GuardrailsClient};
};
const guardrails = new apv2.Guardrails('guardrails:9200', grpc.credentials.createInsecure());

export interface Turn {
  turn_id: string;
  conversation: string;
}

export interface Gated {
  status: 'answered' | 'escalated';
  result?: string;
  verdicts: Record<string, string>;
}

function check(guardrail: string, conversation: string, draft: string, contextJson: string, deadline: number) {
  return new Promise<CheckReply>((resolve, reject) => {
    guardrails.Check(
      {guardrail, conversation, draft, context_json: contextJson},
      new grpc.Metadata(),
      {deadline},
      (error, value) => (error ? reject(error) : resolve(value)),
    );
  });
}

export async function gate(turn: Turn, draft: string, context: unknown): Promise<Gated> {
  const contextJson = JSON.stringify(context);
  const deadline = Date.now() + GUARDRAIL_DEADLINE_MS;
  const entries = await Promise.all(
    GUARDRAILS.map(async (name): Promise<[string, string]> => {
      try {
        const reply = await check(name, turn.conversation, draft, contextJson, deadline);
        return [name, reply.verdict];
      } catch {
        return [name, 'ERROR'];
      }
    }),
  );
  const verdicts = Object.fromEntries(entries);
  if (entries.some(([, verdict]) => verdict !== 'PASS')) {
    await handoff.escalate(turn.conversation, turn.turn_id, verdicts);
    return {status: 'escalated', verdicts};
  }
  return {status: 'answered', result: draft, verdicts};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"

	pb "apv2/apv2pb"
)

var guardrails pb.GuardrailsClient

type Handoff struct{}

// Escalate queues the conversation for a human agent with the guardrail verdicts attached.
func (h *Handoff) Escalate(ctx context.Context, conversation, turnID string, verdicts map[string]string) error {
	return nil
}

var handoff = &Handoff{}

type Gated struct {
	Status   string
	Result   string
	Verdicts map[string]string
}

// TODO: run relevance, groundedness and pii in parallel under one 2 s deadline, treat a
// timeout as a failed verdict, and escalate instead of returning a failed answer.
func Gate(ctx context.Context, turn Turn, draft string, assembled *Assembled) Gated {
	contextJSON, _ := json.Marshal(assembled)
	verdicts := map[string]string{}
	reply, _ := guardrails.Check(ctx, &pb.CheckRequest{
		Guardrail:    "relevance",
		Conversation: turn.Conversation,
		Draft:        draft,
		ContextJson:  string(contextJSON),
	})
	if reply != nil {
		verdicts["relevance"] = reply.Verdict
		if reply.Verdict != "PASS" {
			log.Printf("guardrail relevance failed turn=%s reason=%s", turn.TurnID, reply.Reason)
		}
	}
	return Gated{Status: "answered", Result: draft, Verdicts: verdicts}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"sync"
	"time"

	pb "apv2/apv2pb"
)

const guardrailDeadline = 2 * time.Second

var guardrailNames = []string{"relevance", "groundedness", "pii"}

var guardrails pb.GuardrailsClient

type Handoff struct{}

// Escalate queues the conversation for a human agent with the guardrail verdicts attached.
func (h *Handoff) Escalate(ctx context.Context, conversation, turnID string, verdicts map[string]string) error {
	return nil
}

var handoff = &Handoff{}

type Gated struct {
	Status   string
	Result   string
	Verdicts map[string]string
}

func Gate(ctx context.Context, turn Turn, draft string, assembled *Assembled) Gated {
	contextJSON, _ := json.Marshal(assembled)
	callCtx, cancel := context.WithTimeout(ctx, guardrailDeadline)
	defer cancel()

	var wg sync.WaitGroup
	var mu sync.Mutex
	verdicts := make(map[string]string, len(guardrailNames))
	for _, name := range guardrailNames {
		wg.Add(1)
		go func(name string) {
			defer wg.Done()
			reply, err := guardrails.Check(callCtx, &pb.CheckRequest{
				Guardrail:    name,
				Conversation: turn.Conversation,
				Draft:        draft,
				ContextJson:  string(contextJSON),
			})
			verdict := "ERROR"
			if err != nil {
				log.Printf("guardrail %s failed turn=%s err=%v", name, turn.TurnID, err)
			} else {
				verdict = reply.Verdict
			}
			mu.Lock()
			verdicts[name] = verdict
			mu.Unlock()
		}(name)
	}
	wg.Wait()

	for _, verdict := range verdicts {
		if verdict != "PASS" {
			_ = handoff.Escalate(ctx, turn.Conversation, turn.TurnID, verdicts)
			return Gated{Status: "escalated", Verdicts: verdicts}
		}
	}
	return Gated{Status: "answered", Result: draft, Verdicts: verdicts}
}
`,
    },
    scala: {
      starter: `import java.util.logging.Logger

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}
import spray.json._

final case class Gated(status: String, result: Option[String], verdicts: Map[String, String])

object Handoff {
  /** Queues the conversation for a human agent with the guardrail verdicts attached. */
  def escalate(conversation: String, turnId: String, verdicts: Map[String, String]): Unit = ???
}

object GuardrailGate {
  private val log = Logger.getLogger("guardrails")
  val stub = GuardrailsGrpc.blockingStub(ManagedChannelBuilder.forAddress("guardrails", 9200).usePlaintext().build())

  // TODO: run relevance, groundedness and pii in parallel under one 2 s deadline, treat a
  // timeout as a failed verdict, and escalate instead of returning a failed answer.
  def gate(turn: Turn, draft: String, context: JsObject): Gated = {
    var verdicts = Map.empty[String, String]
    try {
      val reply = stub.check(
        CheckRequest(guardrail = "relevance", conversation = turn.conversation, draft = draft, contextJson = context.compactPrint)
      )
      verdicts += ("relevance" -> reply.verdict)
      if (reply.verdict != "PASS") {
        log.warning(s"guardrail relevance failed turn=\${turn.turnId} reason=\${reply.reason}")
      }
    } catch {
      case _: StatusRuntimeException => ()
    }
    Gated("answered", Some(draft), verdicts)
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import scala.concurrent.duration._
import scala.concurrent.{Await, ExecutionContext, Future}

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}
import spray.json._

final case class Gated(status: String, result: Option[String], verdicts: Map[String, String])

object Handoff {
  /** Queues the conversation for a human agent with the guardrail verdicts attached. */
  def escalate(conversation: String, turnId: String, verdicts: Map[String, String]): Unit = ???
}

object GuardrailGate {
  implicit val ec: ExecutionContext = ExecutionContext.global

  val Guardrails = Seq("relevance", "groundedness", "pii")
  val GuardrailDeadlineMs = 2000L

  val stub = GuardrailsGrpc.blockingStub(ManagedChannelBuilder.forAddress("guardrails", 9200).usePlaintext().build())

  def gate(turn: Turn, draft: String, context: JsObject): Gated = {
    val contextJson = context.compactPrint
    val checks = Guardrails.map { name =>
      Future {
        val reply = stub
          .withDeadlineAfter(GuardrailDeadlineMs, TimeUnit.MILLISECONDS)
          .check(CheckRequest(guardrail = name, conversation = turn.conversation, draft = draft, contextJson = contextJson))
        name -> reply.verdict
      }.recover { case _: StatusRuntimeException => name -> "ERROR" }
    }
    val verdicts = Await.result(Future.sequence(checks), (GuardrailDeadlineMs + 500L).millis).toMap

    if (verdicts.values.exists(_ != "PASS")) {
      Handoff.escalate(turn.conversation, turn.turnId, verdicts)
      Gated("escalated", None, verdicts)
    } else {
      Gated("answered", Some(draft), verdicts)
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>

#include "apv2.grpc.pb.h"

#include <iostream>
#include <map>
#include <memory>
#include <string>

using json = nlohmann::json;

struct Handoff {
  // Queues the conversation for a human agent with the guardrail verdicts attached.
  void escalate(const std::string& conversation, const std::string& turnId, const std::map<std::string, std::string>& verdicts);
};

Handoff handoff;
std::unique_ptr<apv2::Guardrails::Stub> guardrails;

// TODO: run relevance, groundedness and pii in parallel under one 2 s deadline, treat a
// timeout as a failed verdict, and escalate instead of returning a failed answer.
json gate(const std::string& conversation, const std::string& turnId, const std::string& draft, const json& context) {
  std::map<std::string, std::string> verdicts;
  grpc::ClientContext ctx;
  apv2::CheckRequest request;
  request.set_guardrail("relevance");
  request.set_conversation(conversation);
  request.set_draft(draft);
  request.set_context_json(context.dump());
  apv2::CheckReply reply;
  guardrails->Check(&ctx, request, &reply);
  verdicts["relevance"] = reply.verdict();
  if (reply.verdict() == "FAIL") {
    std::cerr << "guardrail relevance failed turn=" << turnId << " reason=" << reply.reason() << "\\n";
  }
  return json{{"status", "answered"}, {"result", draft}, {"verdicts", verdicts}};
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>

#include "apv2.grpc.pb.h"

#include <chrono>
#include <future>
#include <map>
#include <memory>
#include <string>
#include <utility>
#include <vector>

using json = nlohmann::json;

const std::vector<std::string> kGuardrails = {"relevance", "groundedness", "pii"};
constexpr int kGuardrailDeadlineMs = 2000;

struct Handoff {
  // Queues the conversation for a human agent with the guardrail verdicts attached.
  void escalate(const std::string& conversation, const std::string& turnId, const std::map<std::string, std::string>& verdicts);
};

Handoff handoff;
std::unique_ptr<apv2::Guardrails::Stub> guardrails;

json gate(const std::string& conversation, const std::string& turnId, const std::string& draft, const json& context) {
  const std::string contextJson = context.dump();
  const auto deadline = std::chrono::system_clock::now() + std::chrono::milliseconds(kGuardrailDeadlineMs);

  std::vector<std::pair<std::string, std::future<std::string>>> pending;
  for (const auto& name : kGuardrails) {
    pending.emplace_back(name, std::async(std::launch::async, [&, name]() -> std::string {
      grpc::ClientContext ctx;
      ctx.set_deadline(deadline);
      apv2::CheckRequest request;
      request.set_guardrail(name);
      request.set_conversation(conversation);
      request.set_draft(draft);
      request.set_context_json(contextJson);
      apv2::CheckReply reply;
      const grpc::Status status = guardrails->Check(&ctx, request, &reply);
      if (!status.ok()) return "ERROR";
      return reply.verdict();
    }));
  }

  std::map<std::string, std::string> verdicts;
  bool blocked = false;
  for (auto& [name, future] : pending) {
    const std::string verdict = future.get();
    verdicts[name] = verdict;
    if (verdict != "PASS") blocked = true;
  }

  if (blocked) {
    handoff.escalate(conversation, turnId, verdicts);
    return json{{"status", "escalated"}, {"verdicts", verdicts}};
  }
  return json{{"status", "answered"}, {"result", draft}, {"verdicts", verdicts}};
}
`,
    },
  },
  debrief: `The interviewer is testing whether you treat a safety check as a gate or as telemetry. The draft treats it as telemetry: one check, a warning, the answer goes out. The post's framework is a gate — reusable guardrails that engineers from different teams write once, executed in parallel against the model's output, LLM-backed where the question is semantic (content moderation, groundedness) and rule-backed where it is structural (a tool call with an invalid listing setup). Four properties make it a gate: every configured guardrail runs, they run together under one deadline so the gate costs one check's latency rather than three, a check that could not run is a check that failed, and a failed check ends in a human, not in a hedge. The fail-closed rule is the one candidates argue about, and the argument is the interview: a guardrail outage that passes everything is indistinguishable from no guardrail at all. Real frameworks add a severity per guardrail (block vs annotate), regeneration once before escalation, tool guardrails that run before \`Invoke\` rather than after the result, and a verdict stream — step 5 — so the gate's own precision can be measured.`,
};
