import type {Step} from '@/lib/types';

export const guardrailsStep: Step = {
  id: 'guardrails',
  title: 'Guardrails framework: parallel checks, one deadline, fail closed',
  concept: 'grpc',
  guides: ['deadlines-and-retries', 'failing-dependencies', 'model-output'],
  file: 'guardrail_gate',
  focus: ['workflow', 'guardrails', 'human'],
  task: `## Task

**Starting point.** The starter is \`gate(turn, answer, articles)\`, which sits between the reasoning
loop and the customer: for each name in \`GUARDRAILS\` it awaits one
\`GuardrailFramework.Check(guardrail, turn_id, question, answer, articles)\`, skips a guardrail whose
call fails, logs a warning when a verdict is \`FAIL\`, and returns
\`{"status": "answered", "answer", "verdicts"}\`. It serves the demo and hides 5 flaws.

**Failure mode the checks target.** A guardrail that is not configured never runs; checks run one
after another add their latencies to every turn; a call with no deadline makes the guardrail service's
slow hour the assistant's slow hour; and a failed call or an explicit \`FAIL\` still lets a
hallucinated refund policy reach a guest.

- \`GUARDRAILS = ("relevance", "groundedness", "pii")\`, every one on every turn.
- All checks start together (\`asyncio.gather\`, \`Promise.all\`, goroutines, futures) under one
  **2 s** deadline (\`GUARDRAIL_DEADLINE_S\`).
- A check that times out or fails with any status is the verdict \`ERROR\`.
- Any verdict other than \`PASS\` blocks the answer: \`handoff.escalate(tenant, conversation,
  turn_id, verdicts)\`, status \`escalated\`, answer \`""\`. Only all \`PASS\` is \`answered\`.
- The verdicts are returned either way.`,
  sequence: {
    participants: ['CoT workflow', 'Guardrail Framework', 'Human agent'],
    messages: [
      {from: 'CoT workflow', to: 'Guardrail Framework', label: 'Check relevance · deadline 2 s', kind: 'async'},
      {from: 'CoT workflow', to: 'Guardrail Framework', label: 'Check groundedness · same deadline', kind: 'async'},
      {from: 'CoT workflow', to: 'Guardrail Framework', label: 'Check pii · same deadline', kind: 'async'},
      {from: 'Guardrail Framework', to: 'CoT workflow', label: 'PASS · FAIL · (timeout, error → ERROR)', kind: 'reply'},
      {
        from: 'CoT workflow',
        to: 'Human agent',
        label: 'escalate(tenant, conversation, turn, verdicts) on any non-PASS',
        kind: 'async',
      },
    ],
  },
  checks: [
    {
      id: 'all-guardrails',
      title: 'Runs every configured guardrail',
      detail:
        'A grounded answer is checked by relevance, groundedness and pii, one Check each, and comes back `answered` with three PASS verdicts. The starter configures relevance and groundedness only.',
      match: {
        python: {all: [/["']relevance["']/, /["']groundedness["']/, /["']pii["']/]},
        typescript: {all: [/['"]relevance['"]/, /['"]groundedness['"]/, /['"]pii['"]/]},
        go: {all: [/"relevance"/, /"groundedness"/, /"pii"/]},
        scala: {all: [/"relevance"/, /"groundedness"/, /"pii"/]},
        cpp: {all: [/"relevance"/, /"groundedness"/, /"pii"/]},
      },
    },
    {
      id: 'parallel',
      title: 'Starts the checks together, not one after another',
      detail:
        'The guardrail service sees all three checks in flight at once. The starter awaits each check before sending the next, so the turn pays the sum of their latencies.',
      match: {
        python: {all: [/asyncio\.gather\(|TaskGroup\(|create_task\(/]},
        typescript: {all: [/Promise\.all(Settled)?\(/]},
        go: {all: [/\bgo\s+func\b/, /sync\.WaitGroup|errgroup/]},
        scala: {all: [/Future\.(sequence|traverse)\(/]},
        cpp: {all: [/std::async\(|std::thread\b/]},
      },
    },
    {
      id: 'one-deadline',
      title: 'Every check carries the 2 s deadline',
      detail:
        'Each Check carries a deadline of about 2 s, and against a guardrail service that takes 5 s every verdict comes back ERROR and the turn is escalated. The starter waits as long as the service takes.',
      match: {
        python: {
          all: [
            /GUARDRAIL_DEADLINE_S/,
            /timeout\s*=\s*GUARDRAIL_DEADLINE_S|wait_for\([\s\S]{0,300}?GUARDRAIL_DEADLINE_S/,
          ],
        },
        typescript: {all: [/GUARDRAIL_DEADLINE_MS/, /deadline\b[\s\S]{0,80}?GUARDRAIL_DEADLINE_MS/]},
        go: {all: [/guardrailDeadline/, /context\.WithTimeout\([^\n]*guardrailDeadline\)/]},
        scala: {all: [/GuardrailDeadlineMs/, /withDeadlineAfter\(\s*GuardrailDeadlineMs/]},
        cpp: {all: [/kGuardrailDeadline/, /set_deadline\(/]},
      },
    },
    {
      id: 'fail-closed',
      title: 'A timeout or RPC error is a failed verdict',
      detail:
        'With the guardrail service answering UNAVAILABLE, every verdict is ERROR and the answer is withheld. The starter skips a guardrail whose call failed, so an outage passes every answer.',
      match: {
        python: {all: [/["']ERROR["']/]},
        typescript: {all: [/['"]ERROR['"]/]},
        go: {all: [/"ERROR"/]},
        scala: {all: [/"ERROR"/]},
        cpp: {all: [/"ERROR"/]},
      },
    },
    {
      id: 'escalate',
      title: 'Blocks the answer and escalates on any non-PASS verdict',
      detail:
        'An answer promising a refund no article mentions fails groundedness: the gate returns `escalated` with an empty answer and writes one handoff row carrying the verdicts; a grounded answer writes none. The starter logs the FAIL and returns the answer.',
      match: {
        python: {all: [/handoff\.escalate\(/, /["']escalated["']/]},
        typescript: {all: [/handoff\.escalate\(/, /['"]escalated['"]/]},
        go: {all: [/handoff\.Escalate\(/, /"escalated"/]},
        scala: {all: [/Handoff\.escalate\(/, /"escalated"/]},
        cpp: {all: [/handoff::escalate\(/, /"escalated"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

import grpc
import grpc.aio

import support_automation_pb2 as pb
import support_automation_pb2_grpc as pb_grpc
from apv2 import handoff  # handoff.escalate(tenant, conversation, turn_id, verdicts) — provided
from apv2.config import GUARDRAIL_FRAMEWORK

logger = logging.getLogger("apv2.guardrails")

GUARDRAILS = ("relevance", "groundedness")

framework = pb_grpc.GuardrailFrameworkStub(grpc.aio.insecure_channel(GUARDRAIL_FRAMEWORK))


async def gate(turn: dict, answer: str, articles: list[str]) -> dict:
    """Run the guardrails on the model's answer before it reaches the customer."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    verdicts = {}
    for name in GUARDRAILS:
        request = pb.CheckRequest(guardrail=name, turn_id=turn["turn_id"], question=turn["text"], answer=answer, articles=articles)
        try:
            reply = await framework.Check(request)
        except grpc.RpcError as err:
            logger.warning("turn=%s guardrail=%s unavailable: %s", turn["turn_id"], name, err.code())
            continue
        verdicts[name] = reply.verdict
        if reply.verdict == "FAIL":
            logger.warning("turn=%s guardrail=%s FAIL: %s", turn["turn_id"], name, reply.reason)
    return {"status": "answered", "answer": answer, "verdicts": verdicts}
`,
      solution: `import asyncio
import logging

import grpc
import grpc.aio

import support_automation_pb2 as pb
import support_automation_pb2_grpc as pb_grpc
from apv2 import handoff  # handoff.escalate(tenant, conversation, turn_id, verdicts) — provided
from apv2.config import GUARDRAIL_FRAMEWORK

logger = logging.getLogger("apv2.guardrails")

GUARDRAILS = ("relevance", "groundedness", "pii")
GUARDRAIL_DEADLINE_S = 2.0

framework = pb_grpc.GuardrailFrameworkStub(grpc.aio.insecure_channel(GUARDRAIL_FRAMEWORK))


async def _check(name: str, turn: dict, answer: str, articles: list[str]) -> str:
    request = pb.CheckRequest(guardrail=name, turn_id=turn["turn_id"], question=turn["text"], answer=answer, articles=articles)
    try:
        reply = await framework.Check(request, timeout=GUARDRAIL_DEADLINE_S)
    except grpc.RpcError as err:
        logger.warning("turn=%s guardrail=%s failed: %s", turn["turn_id"], name, err.code())
        return "ERROR"  # a guardrail that could not answer did not pass
    return reply.verdict


async def gate(turn: dict, answer: str, articles: list[str]) -> dict:
    """Run the guardrails on the model's answer before it reaches the customer."""
    results = await asyncio.gather(*(_check(name, turn, answer, articles) for name in GUARDRAILS))
    verdicts = dict(zip(GUARDRAILS, results))
    if any(verdict != "PASS" for verdict in verdicts.values()):
        handoff.escalate(turn["tenant"], turn["conversation"], turn["turn_id"], verdicts)
        return {"status": "escalated", "answer": "", "verdicts": verdicts}
    return {"status": "answered", "answer": answer, "verdicts": verdicts}
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {GUARDRAIL_FRAMEWORK} from 'apv2/config';
import * as handoff from 'apv2/handoff'; // handoff.escalate(tenant, conversation, turnId, verdicts) — provided
import type {Turn} from 'apv2/model';

export const GUARDRAILS = ['relevance', 'groundedness'];

interface CheckRequest {
  guardrail: string;
  turn_id: string;
  question: string;
  answer: string;
  articles: string[];
}
interface FrameworkClient {
  Check(request: CheckRequest, options?: {deadline: number}): Promise<{verdict: string; reason: string}>;
}

const {apv2rpc} = grpc.loadPackageDefinition(protoLoader.loadSync('support_automation.proto')) as unknown as {
  apv2rpc: {GuardrailFramework: new (target: string, credentials: grpc.ChannelCredentials) => FrameworkClient};
};
const framework = new apv2rpc.GuardrailFramework(GUARDRAIL_FRAMEWORK, grpc.credentials.createInsecure());

export interface GateResult {
  status: string;
  answer: string;
  verdicts: Record<string, string>;
}

/** Run the guardrails on the model's answer before it reaches the customer. */
export async function gate(turn: Turn, answer: string, articles: string[]): Promise<GateResult> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const verdicts: Record<string, string> = {};
  for (const guardrail of GUARDRAILS) {
    try {
      const reply = await framework.Check({guardrail, turn_id: turn.turn_id, question: turn.text, answer, articles});
      verdicts[guardrail] = reply.verdict;
      if (reply.verdict === 'FAIL') console.warn(\`turn=\${turn.turn_id} guardrail=\${guardrail} FAIL: \${reply.reason}\`);
    } catch (err) {
      console.warn(\`turn=\${turn.turn_id} guardrail=\${guardrail} unavailable: \${(err as grpc.ServiceError).code}\`);
    }
  }
  return {status: 'answered', answer, verdicts};
}

void handoff;
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {GUARDRAIL_FRAMEWORK} from 'apv2/config';
import * as handoff from 'apv2/handoff'; // handoff.escalate(tenant, conversation, turnId, verdicts) — provided
import type {Turn} from 'apv2/model';

export const GUARDRAILS = ['relevance', 'groundedness', 'pii'];
export const GUARDRAIL_DEADLINE_MS = 2_000;

interface CheckRequest {
  guardrail: string;
  turn_id: string;
  question: string;
  answer: string;
  articles: string[];
}
interface FrameworkClient {
  Check(request: CheckRequest, options?: {deadline: number}): Promise<{verdict: string; reason: string}>;
}

const {apv2rpc} = grpc.loadPackageDefinition(protoLoader.loadSync('support_automation.proto')) as unknown as {
  apv2rpc: {GuardrailFramework: new (target: string, credentials: grpc.ChannelCredentials) => FrameworkClient};
};
const framework = new apv2rpc.GuardrailFramework(GUARDRAIL_FRAMEWORK, grpc.credentials.createInsecure());

export interface GateResult {
  status: string;
  answer: string;
  verdicts: Record<string, string>;
}

/** Run the guardrails on the model's answer before it reaches the customer. */
export async function gate(turn: Turn, answer: string, articles: string[]): Promise<GateResult> {
  const deadline = Date.now() + GUARDRAIL_DEADLINE_MS; // one deadline for the whole gate
  const results = await Promise.all(
    GUARDRAILS.map(async guardrail => {
      try {
        const reply = await framework.Check({guardrail, turn_id: turn.turn_id, question: turn.text, answer, articles}, {deadline});
        return reply.verdict;
      } catch (err) {
        console.warn(\`turn=\${turn.turn_id} guardrail=\${guardrail} failed: \${(err as grpc.ServiceError).code}\`);
        return 'ERROR'; // a guardrail that could not answer did not pass
      }
    }),
  );
  const verdicts = Object.fromEntries(GUARDRAILS.map((name, i) => [name, results[i]]));
  if (results.some(verdict => verdict !== 'PASS')) {
    await handoff.escalate(turn.tenant, turn.conversation, turn.turn_id, verdicts);
    return {status: 'escalated', answer: '', verdicts};
  }
  return {status: 'answered', answer, verdicts};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"log"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"apv2/config" // config.GuardrailFramework — provided
	pb "apv2/gen/support_automation"
	"apv2/handoff" // handoff.Escalate(ctx, tenant, conversation, turnID, verdicts) — provided
	"apv2/model"   // model.Turn
)

var guardrails = []string{"relevance", "groundedness"}

var frameworkConn, _ = grpc.NewClient(config.GuardrailFramework, grpc.WithTransportCredentials(insecure.NewCredentials()))
var framework = pb.NewGuardrailFrameworkClient(frameworkConn)

// GateResult is what the customer gets: the answer when every guardrail passed, else an escalation.
type GateResult struct {
	Status   string
	Answer   string
	Verdicts map[string]string
}

// gate runs the guardrails on the model's answer before it reaches the customer.
func gate(ctx context.Context, turn model.Turn, answer string, articles []string) (GateResult, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	verdicts := map[string]string{}
	for _, name := range guardrails {
		reply, err := framework.Check(ctx, &pb.CheckRequest{Guardrail: name, TurnId: turn.TurnID, Question: turn.Text, Answer: answer, Articles: articles})
		if err != nil {
			log.Printf("turn=%s guardrail=%s unavailable: %v", turn.TurnID, name, err)
			continue
		}
		verdicts[name] = reply.GetVerdict()
		if reply.GetVerdict() == "FAIL" {
			log.Printf("turn=%s guardrail=%s FAIL: %s", turn.TurnID, name, reply.GetReason())
		}
	}
	return GateResult{Status: "answered", Answer: answer, Verdicts: verdicts}, nil
}

var _ = handoff.Escalate
`,
      solution: `package main

import (
	"context"
	"log"
	"sync"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"apv2/config" // config.GuardrailFramework — provided
	pb "apv2/gen/support_automation"
	"apv2/handoff" // handoff.Escalate(ctx, tenant, conversation, turnID, verdicts) — provided
	"apv2/model"   // model.Turn
)

const guardrailDeadline = 2 * time.Second

var guardrails = []string{"relevance", "groundedness", "pii"}

var frameworkConn, _ = grpc.NewClient(config.GuardrailFramework, grpc.WithTransportCredentials(insecure.NewCredentials()))
var framework = pb.NewGuardrailFrameworkClient(frameworkConn)

// GateResult is what the customer gets: the answer when every guardrail passed, else an escalation.
type GateResult struct {
	Status   string
	Answer   string
	Verdicts map[string]string
}

// gate runs the guardrails on the model's answer before it reaches the customer.
func gate(ctx context.Context, turn model.Turn, answer string, articles []string) (GateResult, error) {
	callCtx, cancel := context.WithTimeout(ctx, guardrailDeadline) // one deadline for the whole gate
	defer cancel()
	results := make([]string, len(guardrails))
	var wg sync.WaitGroup
	for i, name := range guardrails {
		wg.Add(1)
		go func(i int, name string) {
			defer wg.Done()
			reply, err := framework.Check(callCtx, &pb.CheckRequest{Guardrail: name, TurnId: turn.TurnID, Question: turn.Text, Answer: answer, Articles: articles})
			if err != nil {
				log.Printf("turn=%s guardrail=%s failed: %v", turn.TurnID, name, err)
				results[i] = "ERROR" // a guardrail that could not answer did not pass
				return
			}
			results[i] = reply.GetVerdict()
		}(i, name)
	}
	wg.Wait()
	verdicts := map[string]string{}
	passed := true
	for i, name := range guardrails {
		verdicts[name] = results[i]
		passed = passed && results[i] == "PASS"
	}
	if !passed {
		if err := handoff.Escalate(ctx, turn.Tenant, turn.Conversation, turn.TurnID, verdicts); err != nil {
			return GateResult{}, err
		}
		return GateResult{Status: "escalated", Verdicts: verdicts}, nil
	}
	return GateResult{Status: "answered", Answer: answer, Verdicts: verdicts}, nil
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import apv2.{Config, Turn}
import apv2rpc.support_automation.{CheckRequest, GuardrailFrameworkGrpc}

/** What the customer gets: the answer when every guardrail passed, else an escalation. */
final case class GateResult(status: String, answer: String, verdicts: Map[String, String])

object GuardrailGate {
  val Guardrails = Seq("relevance", "groundedness")

  private val framework = GuardrailFrameworkGrpc.blockingStub(ManagedChannelBuilder.forTarget(Config.GuardrailFramework).usePlaintext().build())

  /** Run the guardrails on the model's answer before it reaches the customer. */
  def gate(turn: Turn, answer: String, articles: Seq[String]): GateResult = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    val verdicts = Guardrails.flatMap { name =>
      try {
        val reply = framework.check(CheckRequest(guardrail = name, turnId = turn.turn_id, question = turn.text, answer = answer, articles = articles))
        if (reply.verdict == "FAIL") println(s"turn=\${turn.turn_id} guardrail=$name FAIL: \${reply.reason}")
        Some(name -> reply.verdict)
      } catch {
        case e: StatusRuntimeException =>
          println(s"turn=\${turn.turn_id} guardrail=$name unavailable: \${e.getStatus.getCode}")
          None
      }
    }.toMap
    GateResult("answered", answer, verdicts)
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import scala.concurrent.duration._
import scala.concurrent.{Await, ExecutionContext, Future}
import scala.util.control.NonFatal

import io.grpc.ManagedChannelBuilder

import apv2.{Config, Handoff, Turn}
import apv2rpc.support_automation.{CheckRequest, GuardrailFrameworkGrpc}

/** What the customer gets: the answer when every guardrail passed, else an escalation. */
final case class GateResult(status: String, answer: String, verdicts: Map[String, String])

object GuardrailGate {
  val Guardrails = Seq("relevance", "groundedness", "pii")
  val GuardrailDeadlineMs = 2000L

  private implicit val ec: ExecutionContext = ExecutionContext.global
  private val framework = GuardrailFrameworkGrpc.stub(ManagedChannelBuilder.forTarget(Config.GuardrailFramework).usePlaintext().build())

  /** Run the guardrails on the model's answer before it reaches the customer. */
  def gate(turn: Turn, answer: String, articles: Seq[String]): GateResult = {
    val deadline = framework.withDeadlineAfter(GuardrailDeadlineMs, TimeUnit.MILLISECONDS) // one deadline for the whole gate
    val checks = Guardrails.map { name =>
      deadline
        .check(CheckRequest(guardrail = name, turnId = turn.turn_id, question = turn.text, answer = answer, articles = articles))
        .map(_.verdict)
        .recover { case NonFatal(_) => "ERROR" } // a guardrail that could not answer did not pass
    }
    val verdicts = Guardrails.zip(Await.result(Future.sequence(checks), (GuardrailDeadlineMs + 1000).millis)).toMap
    if (verdicts.values.exists(_ != "PASS")) {
      Handoff.escalate(turn.tenant, turn.conversation, turn.turn_id, verdicts)
      GateResult("escalated", "", verdicts)
    } else GateResult("answered", answer, verdicts)
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <map>
#include <string>
#include <vector>

#include "apv2/config.h"   // config::kGuardrailFramework — provided
#include "apv2/handoff.h"  // handoff::escalate(tenant, conversation, turn_id, verdicts) — provided
#include "support_automation.grpc.pb.h"

using json = nlohmann::json;

const std::vector<std::string> kGuardrails = {"relevance", "groundedness"};

auto framework = apv2rpc::GuardrailFramework::NewStub(grpc::CreateChannel(config::kGuardrailFramework, grpc::InsecureChannelCredentials()));

// What the customer gets: the answer when every guardrail passed, else an escalation.
struct GateResult {
  std::string status;
  std::string answer;
  std::map<std::string, std::string> verdicts;
};

// Run the guardrails on the model's answer before it reaches the customer.
GateResult gate(const json& turn, const std::string& answer, const std::vector<std::string>& articles) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  std::map<std::string, std::string> verdicts;
  for (const auto& name : kGuardrails) {
    grpc::ClientContext ctx;
    apv2rpc::CheckRequest request;
    request.set_guardrail(name);
    request.set_turn_id(turn["turn_id"].get<std::string>());
    request.set_question(turn["text"].get<std::string>());
    request.set_answer(answer);
    for (const auto& a : articles) request.add_articles(a);
    apv2rpc::CheckReply reply;
    const grpc::Status status = framework->Check(&ctx, request, &reply);
    if (!status.ok()) {
      std::cerr << "guardrail " << name << " unavailable: " << status.error_message() << "\\n";
      continue;
    }
    verdicts[name] = reply.verdict();
    if (reply.verdict() == "FAIL") std::cerr << "guardrail " << name << " FAIL: " << reply.reason() << "\\n";
  }
  return {"answered", answer, verdicts};
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <future>
#include <iostream>
#include <map>
#include <string>
#include <vector>

#include "apv2/config.h"   // config::kGuardrailFramework — provided
#include "apv2/handoff.h"  // handoff::escalate(tenant, conversation, turn_id, verdicts) — provided
#include "support_automation.grpc.pb.h"

using json = nlohmann::json;

const std::vector<std::string> kGuardrails = {"relevance", "groundedness", "pii"};
constexpr std::chrono::seconds kGuardrailDeadline{2};

auto framework = apv2rpc::GuardrailFramework::NewStub(grpc::CreateChannel(config::kGuardrailFramework, grpc::InsecureChannelCredentials()));

// What the customer gets: the answer when every guardrail passed, else an escalation.
struct GateResult {
  std::string status;
  std::string answer;
  std::map<std::string, std::string> verdicts;
};

std::string check_one(const std::string& name, const json& turn, const std::string& answer, const std::vector<std::string>& articles,
                      std::chrono::system_clock::time_point deadline) {
  grpc::ClientContext ctx;
  ctx.set_deadline(deadline);
  apv2rpc::CheckRequest request;
  request.set_guardrail(name);
  request.set_turn_id(turn["turn_id"].get<std::string>());
  request.set_question(turn["text"].get<std::string>());
  request.set_answer(answer);
  for (const auto& a : articles) request.add_articles(a);
  apv2rpc::CheckReply reply;
  const grpc::Status status = framework->Check(&ctx, request, &reply);
  if (!status.ok()) {
    std::cerr << "guardrail " << name << " failed: " << status.error_message() << "\\n";
    return "ERROR";  // a guardrail that could not answer did not pass
  }
  return reply.verdict();
}

// Run the guardrails on the model's answer before it reaches the customer.
GateResult gate(const json& turn, const std::string& answer, const std::vector<std::string>& articles) {
  const auto deadline = std::chrono::system_clock::now() + kGuardrailDeadline;  // one deadline for the whole gate
  std::vector<std::future<std::string>> checks;
  for (const auto& name : kGuardrails) {
    checks.push_back(std::async(std::launch::async, [&, name] { return check_one(name, turn, answer, articles, deadline); }));
  }
  std::map<std::string, std::string> verdicts;
  bool passed = true;
  for (size_t i = 0; i < kGuardrails.size(); i++) {
    verdicts[kGuardrails[i]] = checks[i].get();
    passed = passed && verdicts[kGuardrails[i]] == "PASS";
  }
  if (!passed) {
    handoff::escalate(turn["tenant"], turn["conversation"], turn["turn_id"], verdicts);
    return {"escalated", "", verdicts};
  }
  return {"answered", answer, verdicts};
}
`,
    },
  },
  harness: {
    python: `import asyncio
import json

import grpc

import support_automation_pb2 as pb
import support_automation_pb2_grpc as pb_grpc
from apv2 import config, standins

TURN = {"turn_id": "turn-1", "tenant": "t1", "conversation": "c-1", "actor": "guest-1", "role": "customer", "text": "Where is my next reservation?"}
ARTICLES = ["Help article for: Where is my next reservation?"]
GOOD = "Your next stay is HM-4410 in Lisbon, check-in 4 December."
REFUND = "You will get a full refund for this stay."


class Framework(pb_grpc.GuardrailFrameworkServicer):
    """The Guardrails Framework: verdicts from apv2.standins, and how many checks were in flight at once."""

    def __init__(self):
        self.in_flight = 0
        self.peak = 0

    async def Check(self, request, context):
        self.in_flight += 1
        self.peak = max(self.peak, self.in_flight)
        for _ in range(3):
            await asyncio.sleep(0)
        self.in_flight -= 1
        verdict, reason = standins.check(request.guardrail, request.question, request.answer, list(request.articles))
        return pb.CheckReply(verdict=verdict, reason=reason)


def _world(ctx):
    framework = Framework()
    ctx.grpc.serve(pb_grpc.add_GuardrailFrameworkServicer_to_server, framework, config.GUARDRAIL_FRAMEWORK)
    return ctx.load("guardrail_gate"), framework


def _handoffs(ctx):
    return [json.loads(raw) for raw in ctx.redis.lrange("apv2:handoff", 0, -1)]


async def check_all_guardrails(ctx):
    m, _ = _world(ctx)
    result = await m.gate(TURN, GOOD, ARTICLES)
    checked = sorted(c.request.guardrail for c in ctx.grpc.calls_to("Check"))
    assert checked == ["groundedness", "pii", "relevance"], f"the gate ran the guardrails {checked}: every configured guardrail (relevance, groundedness, pii) runs on every turn, once"
    assert result.get("status") == "answered" and result.get("answer") == GOOD, f"a grounded answer passes, got {result}"
    assert dict(result.get("verdicts", {})) == {"relevance": "PASS", "groundedness": "PASS", "pii": "PASS"}, f"the verdicts come back with the turn, got {result.get('verdicts')}"


async def check_parallel(ctx):
    m, framework = _world(ctx)
    await m.gate(TURN, GOOD, ARTICLES)
    assert len(ctx.grpc.calls_to("Check")) >= 2, "the gate must call Check once per guardrail"
    assert framework.peak == len(ctx.grpc.calls_to("Check")), f"at most {framework.peak} of {len(ctx.grpc.calls_to('Check'))} checks were in flight at once: start them together (asyncio.gather) so the turn pays the slowest guardrail, not the sum"


async def check_one_deadline(ctx):
    m, _ = _world(ctx)
    await m.gate(TURN, GOOD, ARTICLES)
    for call in ctx.grpc.calls_to("Check"):
        assert call.timeout is not None, f"the {call.request.guardrail} check carries no deadline: the guardrail service's slow hour becomes the assistant's"
        assert 1.5 <= call.timeout <= 2.05, f"the {call.request.guardrail} check's deadline is {call.timeout} s, expected GUARDRAIL_DEADLINE_S = 2 s"
    ctx.grpc.set_latency("Check", 5.0, config.GUARDRAIL_FRAMEWORK)
    result = await m.gate({**TURN, "turn_id": "turn-2"}, GOOD, ARTICLES)
    verdicts = dict(result.get("verdicts", {}))
    assert verdicts and set(verdicts.values()) == {"ERROR"}, f"against a guardrail service that takes 5 s every check must time out at 2 s and read ERROR, got {verdicts}"
    assert result.get("status") == "escalated", f"a gate whose guardrails timed out must escalate, got {result.get('status')!r}"


async def check_fail_closed(ctx):
    m, _ = _world(ctx)
    ctx.grpc.fail("Check", grpc.StatusCode.UNAVAILABLE, "guardrails down", times=3, target=config.GUARDRAIL_FRAMEWORK)
    result = await m.gate(TURN, GOOD, ARTICLES)
    verdicts = dict(result.get("verdicts", {}))
    assert result.get("status") == "escalated" and result.get("answer") == "", f"with the guardrail service UNAVAILABLE the gate returned {result.get('status')!r} with answer {result.get('answer')!r}: a guardrail that could not answer did not pass, so the answer is withheld"
    assert verdicts and set(verdicts.values()) == {"ERROR"}, f"every failed check is the verdict ERROR, got {verdicts}"


async def check_escalate(ctx):
    m, _ = _world(ctx)
    result = await m.gate(TURN, REFUND, ARTICLES)
    assert result.get("status") == "escalated", f"an answer promising a refund no article mentions failed groundedness and the gate returned {result.get('status')!r}: any verdict other than PASS blocks the answer"
    assert result.get("answer") == "", f"a blocked answer must not reach the customer, got {result.get('answer')!r}"
    rows = _handoffs(ctx)
    assert len(rows) == 1, f"the blocked turn must be handed to a human once (handoff.escalate), found {len(rows)} rows"
    row = rows[0]
    assert row.get("turn_id") == "turn-1" and row.get("conversation") == "c-1" and row.get("tenant") == "t1", f"the handoff row names the turn: {row}"
    assert row.get("verdicts", {}).get("groundedness") == "FAIL", f"the handoff row carries the verdicts, got {row.get('verdicts')}"
    ok = await m.gate({**TURN, "turn_id": "turn-2"}, GOOD, ARTICLES)
    assert ok.get("status") == "answered" and len(_handoffs(ctx)) == 1, "a grounded answer is answered and writes no handoff row"
`,
    typescript: `const TURN = {turn_id: 'turn-1', tenant: 't1', conversation: 'c-1', actor: 'guest-1', role: 'customer', text: 'Where is my next reservation?'};
const ARTICLES = ['Help article for: Where is my next reservation?'];
const GOOD = 'Your next stay is HM-4410 in Lisbon, check-in 4 December.';
const REFUND = 'You will get a full refund for this stay.';

function world(ctx) {
  const {apv2rpc} = ctx.proto('support_automation.proto');
  const config = ctx.load('/support/apv2/config.ts');
  const standins = ctx.load('/support/apv2/standins.ts');
  const framework = {inFlight: 0, peak: 0};
  ctx.grpc.serve(apv2rpc.GuardrailFramework.service, {
    Check(call, callback) {
      framework.inFlight += 1;
      framework.peak = Math.max(framework.peak, framework.inFlight);
      setTimeout(() => {
        framework.inFlight -= 1;
        const r = call.request;
        callback(null, standins.check(r.guardrail, r.question, r.answer, r.articles ?? []));
      }, 10);
    },
  }, config.GUARDRAIL_FRAMEWORK);
  return {m: ctx.load('guardrail_gate'), framework, config};
}

const handoffs = (ctx): Record<string, any>[] => ctx.redis.lrange('apv2:handoff', 0, -1).map((raw: string) => JSON.parse(raw));
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = warn;
  }
};

export async function check_all_guardrails(ctx) {
  const {m} = world(ctx);
  const result = await m.gate(TURN, GOOD, ARTICLES);
  const checked = ctx.grpc.callsTo('Check').map(c => c.request.guardrail).sort();
  assert.deepStrictEqual(checked, ['groundedness', 'pii', 'relevance'], \`the gate ran the guardrails \${JSON.stringify(checked)}: every configured guardrail (relevance, groundedness, pii) runs on every turn, once\`);
  assert(result.status === 'answered' && result.answer === GOOD, \`a grounded answer passes, got \${JSON.stringify(result)}\`);
  assert.deepStrictEqual({...result.verdicts}, {relevance: 'PASS', groundedness: 'PASS', pii: 'PASS'}, \`the verdicts come back with the turn, got \${JSON.stringify(result.verdicts)}\`);
}

export async function check_parallel(ctx) {
  const {m, framework} = world(ctx);
  await m.gate(TURN, GOOD, ARTICLES);
  const calls = ctx.grpc.callsTo('Check').length;
  assert(calls >= 2, 'the gate must call Check once per guardrail');
  assert.equal(framework.peak, calls, \`at most \${framework.peak} of \${calls} checks were in flight at once: start them together (Promise.all) so the turn pays the slowest guardrail, not the sum\`);
}

export async function check_one_deadline(ctx) {
  const {m, config} = world(ctx);
  await m.gate(TURN, GOOD, ARTICLES);
  for (const call of ctx.grpc.callsTo('Check')) {
    assert(call.timeout !== null, \`the \${call.request.guardrail} check carries no deadline: the guardrail service's slow hour becomes the assistant's\`);
    assert(call.timeout >= 1.5 && call.timeout <= 2.05, \`the \${call.request.guardrail} check's deadline is \${call.timeout} s, expected GUARDRAIL_DEADLINE_MS = 2000 ms\`);
  }
  ctx.grpc.setLatency('Check', 5.0, config.GUARDRAIL_FRAMEWORK);
  const result = await quiet(() => m.gate({...TURN, turn_id: 'turn-2'}, GOOD, ARTICLES));
  const values = [...new Set(Object.values(result.verdicts ?? {}))];
  assert(values.length === 1 && values[0] === 'ERROR', \`against a guardrail service that takes 5 s every check must time out at 2 s and read ERROR, got \${JSON.stringify(result.verdicts)}\`);
  assert.equal(result.status, 'escalated', \`a gate whose guardrails timed out must escalate, got \${result.status}\`);
}

export async function check_fail_closed(ctx) {
  const {m, config} = world(ctx);
  ctx.grpc.fail('Check', ctx.grpc.status.UNAVAILABLE, 'guardrails down', 3, config.GUARDRAIL_FRAMEWORK);
  const result = await quiet(() => m.gate(TURN, GOOD, ARTICLES));
  assert(result.status === 'escalated' && result.answer === '', \`with the guardrail service UNAVAILABLE the gate returned \${result.status} with answer \${JSON.stringify(result.answer)}: a guardrail that could not answer did not pass, so the answer is withheld\`);
  const values = [...new Set(Object.values(result.verdicts ?? {}))];
  assert(values.length === 1 && values[0] === 'ERROR', \`every failed check is the verdict ERROR, got \${JSON.stringify(result.verdicts)}\`);
}

export async function check_escalate(ctx) {
  const {m} = world(ctx);
  const result = await quiet(() => m.gate(TURN, REFUND, ARTICLES));
  assert.equal(result.status, 'escalated', \`an answer promising a refund no article mentions failed groundedness and the gate returned \${result.status}: any verdict other than PASS blocks the answer\`);
  assert.equal(result.answer, '', \`a blocked answer must not reach the customer, got \${JSON.stringify(result.answer)}\`);
  const rows = handoffs(ctx);
  assert.equal(rows.length, 1, \`the blocked turn must be handed to a human once (handoff.escalate), found \${rows.length} rows\`);
  assert(rows[0].turn_id === 'turn-1' && rows[0].conversation === 'c-1' && rows[0].tenant === 't1', \`the handoff row names the turn: \${JSON.stringify(rows[0])}\`);
  assert.equal(rows[0].verdicts?.groundedness, 'FAIL', \`the handoff row carries the verdicts, got \${JSON.stringify(rows[0].verdicts)}\`);
  const ok = await m.gate({...TURN, turn_id: 'turn-2'}, GOOD, ARTICLES);
  assert(ok.status === 'answered' && handoffs(ctx).length === 1, 'a grounded answer is answered and writes no handoff row');
}
`,
    go: `package main

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"sort"
	"sync"
	"time"

	"google.golang.org/grpc/codes"

	"apv2/config"
	pb "apv2/gen/support_automation"
	"apv2/model"
	"apv2/standins"

	"leetbuild/harness"
)

var gateTurn = model.Turn{TurnID: "turn-1", Tenant: "t1", Conversation: "c-1", Actor: "guest-1", Role: "customer", Text: "Where is my next reservation?"}
var gateArticles = []string{"Help article for: Where is my next reservation?"}

const (
	gateGood   = "Your next stay is HM-4410 in Lisbon, check-in 4 December."
	gateRefund = "You will get a full refund for this stay."
)

// frameworkPeer is the Guardrails Framework: verdicts from apv2/standins, and how many checks were in flight at once.
type frameworkPeer struct {
	pb.UnimplementedGuardrailFrameworkServer
	mu       sync.Mutex
	inFlight int
	peak     int
}

func (f *frameworkPeer) Check(_ context.Context, req *pb.CheckRequest) (*pb.CheckReply, error) {
	f.mu.Lock()
	f.inFlight++
	if f.inFlight > f.peak {
		f.peak = f.inFlight
	}
	f.mu.Unlock()
	time.Sleep(10 * time.Millisecond)
	f.mu.Lock()
	f.inFlight--
	f.mu.Unlock()
	verdict, reason := standins.Check(req.GetGuardrail(), req.GetQuestion(), req.GetAnswer(), req.GetArticles())
	return &pb.CheckReply{Verdict: verdict, Reason: reason}, nil
}

func gateWorld(ctx *harness.Ctx) *frameworkPeer {
	log.SetOutput(&bytes.Buffer{})
	peer := &frameworkPeer{}
	pb.RegisterGuardrailFrameworkServer(ctx.GRPC.Server(config.GuardrailFramework), peer)
	return peer
}

func gateRun(ctx *harness.Ctx, turnID, answer string) GateResult {
	turn := gateTurn
	turn.TurnID = turnID
	result, err := gate(context.Background(), turn, answer, gateArticles)
	ctx.NoError(err, "gate(%s)", turnID)
	return result
}

func gateHandoffs(ctx *harness.Ctx) []map[string]any {
	var rows []map[string]any
	for _, raw := range ctx.Redis.LRange("apv2:handoff", 0, -1) {
		var row map[string]any
		json.Unmarshal([]byte(raw), &row)
		rows = append(rows, row)
	}
	return rows
}

func gateAll(verdicts map[string]string, want string) bool {
	for _, v := range verdicts {
		if v != want {
			return false
		}
	}
	return len(verdicts) > 0
}

func CheckAllGuardrails(ctx *harness.Ctx) {
	gateWorld(ctx)
	result := gateRun(ctx, "turn-1", gateGood)
	checked := []string{}
	for _, c := range ctx.GRPC.CallsTo("Check", "") {
		checked = append(checked, c.Request.(*pb.CheckRequest).GetGuardrail())
	}
	sort.Strings(checked)
	ctx.Equal(checked, []string{"groundedness", "pii", "relevance"}, "every configured guardrail (relevance, groundedness, pii) runs on every turn, once; the guardrails the gate ran")
	ctx.Assert(result.Status == "answered" && result.Answer == gateGood, "a grounded answer passes, got %+v", result)
	ctx.Equal(result.Verdicts, map[string]string{"relevance": "PASS", "groundedness": "PASS", "pii": "PASS"}, "the verdicts come back with the turn")
}

func CheckParallel(ctx *harness.Ctx) {
	peer := gateWorld(ctx)
	gateRun(ctx, "turn-1", gateGood)
	calls := len(ctx.GRPC.CallsTo("Check", ""))
	ctx.Assert(calls >= 2, "the gate must call Check once per guardrail")
	ctx.Assert(peer.peak == calls, "at most %d of %d checks were in flight at once: start them together (a goroutine each) so the turn pays the slowest guardrail, not the sum", peer.peak, calls)
}

func CheckOneDeadline(ctx *harness.Ctx) {
	gateWorld(ctx)
	gateRun(ctx, "turn-1", gateGood)
	for _, call := range ctx.GRPC.CallsTo("Check", "") {
		name := call.Request.(*pb.CheckRequest).GetGuardrail()
		ctx.Assert(call.HasDeadline(), "the %s check carries no deadline: the guardrail service's slow hour becomes the assistant's", name)
		ctx.Assert(call.Timeout >= 1500*time.Millisecond && call.Timeout <= 2050*time.Millisecond, "the %s check's deadline is %v, expected guardrailDeadline = 2 s", name, call.Timeout)
	}
	ctx.GRPC.SetLatency("Check", 5.0, config.GuardrailFramework)
	result := gateRun(ctx, "turn-2", gateGood)
	ctx.Assert(gateAll(result.Verdicts, "ERROR"), "against a guardrail service that takes 5 s every check must time out at 2 s and read ERROR, got %v", result.Verdicts)
	ctx.Equal(result.Status, "escalated", "a gate whose guardrails timed out must escalate; the status")
}

func CheckFailClosed(ctx *harness.Ctx) {
	gateWorld(ctx)
	ctx.GRPC.Fail("Check", codes.Unavailable, "guardrails down", 3, config.GuardrailFramework)
	result := gateRun(ctx, "turn-1", gateGood)
	ctx.Assert(result.Status == "escalated" && result.Answer == "", "with the guardrail service UNAVAILABLE the gate returned %q with answer %q: a guardrail that could not answer did not pass, so the answer is withheld", result.Status, result.Answer)
	ctx.Assert(gateAll(result.Verdicts, "ERROR"), "every failed check is the verdict ERROR, got %v", result.Verdicts)
}

func CheckEscalate(ctx *harness.Ctx) {
	gateWorld(ctx)
	result := gateRun(ctx, "turn-1", gateRefund)
	ctx.Equal(result.Status, "escalated", "an answer promising a refund no article mentions failed groundedness: any verdict other than PASS blocks the answer; the status")
	ctx.Equal(result.Answer, "", "a blocked answer must not reach the customer; the answer")
	rows := gateHandoffs(ctx)
	ctx.Equal(len(rows), 1, "the blocked turn must be handed to a human once (handoff.Escalate); handoff rows")
	row := rows[0]
	ctx.Assert(row["turn_id"] == "turn-1" && row["conversation"] == "c-1" && row["tenant"] == "t1", "the handoff row names the turn: %v", row)
	verdicts, _ := row["verdicts"].(map[string]any)
	ctx.Equal(verdicts["groundedness"], "FAIL", "the handoff row carries the verdicts (%v)", row["verdicts"])
	ok := gateRun(ctx, "turn-2", gateGood)
	ctx.Assert(ok.Status == "answered" && len(gateHandoffs(ctx)) == 1, "a grounded answer is answered and writes no handoff row")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <map>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <vector>

#include "apv2/standins.h"

namespace {

using json = nlohmann::json;

const json kGateTurn = {{"turn_id", "turn-1"}, {"tenant", "t1"}, {"conversation", "c-1"}, {"actor", "guest-1"}, {"role", "customer"}, {"text", "Where is my next reservation?"}};
const std::vector<std::string> kGateArticles = {"Help article for: Where is my next reservation?"};
const std::string kGateGood = "Your next stay is HM-4410 in Lisbon, check-in 4 December.";
const std::string kGateRefund = "You will get a full refund for this stay.";

// The Guardrails Framework: verdicts from apv2/standins.h, and how many checks were in flight at once.
class FrameworkPeer final : public apv2rpc::GuardrailFramework::Service {
 public:
  std::mutex mu;
  int in_flight = 0;
  int peak = 0;
  grpc::Status Check(grpc::ServerContext*, const apv2rpc::CheckRequest* req, apv2rpc::CheckReply* reply) override {
    {
      std::lock_guard<std::mutex> lock(mu);
      peak = std::max(peak, ++in_flight);
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
    {
      std::lock_guard<std::mutex> lock(mu);
      --in_flight;
    }
    const auto [verdict, reason] = standins::check(req->guardrail(), req->question(), req->answer(), {req->articles().begin(), req->articles().end()});
    reply->set_verdict(verdict);
    reply->set_reason(reason);
    return grpc::Status::OK;
  }
};

FrameworkPeer& gateWorld(harness::Ctx& ctx) {
  static FrameworkPeer* peer = nullptr;
  delete peer;
  peer = new FrameworkPeer();
  ctx.GRPC.Server(config::kGuardrailFramework)->RegisterService(peer);
  return *peer;
}

json gateTurn(const std::string& turn_id) {
  json turn = kGateTurn;
  turn["turn_id"] = turn_id;
  return turn;
}

std::vector<json> gateHandoffs(harness::Ctx& ctx) {
  std::vector<json> rows;
  for (const auto& raw : ctx.Redis.LRange("apv2:handoff", 0, -1)) rows.push_back(json::parse(raw, nullptr, false));
  return rows;
}

bool gateAll(const std::map<std::string, std::string>& verdicts, const std::string& want) {
  return !verdicts.empty() && std::all_of(verdicts.begin(), verdicts.end(), [&](const auto& kv) { return kv.second == want; });
}

std::string describe(const std::map<std::string, std::string>& verdicts) {
  return json(verdicts).dump();
}

}  // namespace

void CheckAllGuardrails(harness::Ctx& ctx) {
  gateWorld(ctx);
  const GateResult result = gate(gateTurn("turn-1"), kGateGood, kGateArticles);
  std::vector<std::string> checked;
  for (const auto& c : ctx.GRPC.CallsTo("Check")) checked.push_back(c.Request<apv2rpc::CheckRequest>().guardrail());
  std::sort(checked.begin(), checked.end());
  ctx.Equal(checked, std::vector<std::string>{"groundedness", "pii", "relevance"}, "every configured guardrail (relevance, groundedness, pii) runs on every turn, once; the guardrails the gate ran");
  ctx.Assert(result.status == "answered" && result.answer == kGateGood, "a grounded answer passes, got %s %q", result.status, result.answer);
  ctx.Assert(result.verdicts == std::map<std::string, std::string>{{"relevance", "PASS"}, {"groundedness", "PASS"}, {"pii", "PASS"}}, "the verdicts come back with the turn, got %s", describe(result.verdicts));
}

void CheckParallel(harness::Ctx& ctx) {
  auto& peer = gateWorld(ctx);
  gate(gateTurn("turn-1"), kGateGood, kGateArticles);
  const int calls = static_cast<int>(ctx.GRPC.CallsTo("Check").size());
  ctx.Assert(calls >= 2, "the gate must call Check once per guardrail");
  ctx.Assert(peer.peak == calls, "at most %d of %d checks were in flight at once: start them together (std::async) so the turn pays the slowest guardrail, not the sum", peer.peak, calls);
}

void CheckOneDeadline(harness::Ctx& ctx) {
  gateWorld(ctx);
  gate(gateTurn("turn-1"), kGateGood, kGateArticles);
  for (const auto& call : ctx.GRPC.CallsTo("Check")) {
    const std::string name = call.Request<apv2rpc::CheckRequest>().guardrail();
    ctx.Assert(call.HasDeadline(), "the %s check carries no deadline: the guardrail service's slow hour becomes the assistant's", name);
    ctx.Assert(call.TimeoutSeconds() >= 1.5 && call.TimeoutSeconds() <= 2.05, "the %s check's deadline is %vs, expected kGuardrailDeadline = 2 s", name, call.TimeoutSeconds());
  }
  ctx.GRPC.SetLatency("Check", 5.0, config::kGuardrailFramework);
  const GateResult result = gate(gateTurn("turn-2"), kGateGood, kGateArticles);
  ctx.Assert(gateAll(result.verdicts, "ERROR"), "against a guardrail service that takes 5 s every check must time out at 2 s and read ERROR, got %s", describe(result.verdicts));
  ctx.Equal(result.status, "escalated", "a gate whose guardrails timed out must escalate; the status");
}

void CheckFailClosed(harness::Ctx& ctx) {
  gateWorld(ctx);
  ctx.GRPC.Fail("Check", grpc::StatusCode::UNAVAILABLE, "guardrails down", 3, config::kGuardrailFramework);
  const GateResult result = gate(gateTurn("turn-1"), kGateGood, kGateArticles);
  ctx.Assert(result.status == "escalated" && result.answer.empty(),
             "with the guardrail service UNAVAILABLE the gate returned %s with answer %q: a guardrail that could not answer did not pass, so the answer is withheld", result.status, result.answer);
  ctx.Assert(gateAll(result.verdicts, "ERROR"), "every failed check is the verdict ERROR, got %s", describe(result.verdicts));
}

void CheckEscalate(harness::Ctx& ctx) {
  gateWorld(ctx);
  const GateResult result = gate(gateTurn("turn-1"), kGateRefund, kGateArticles);
  ctx.Equal(result.status, "escalated", "an answer promising a refund no article mentions failed groundedness: any verdict other than PASS blocks the answer; the status");
  ctx.Equal(result.answer, "", "a blocked answer must not reach the customer; the answer");
  const auto rows = gateHandoffs(ctx);
  ctx.Equal(rows.size(), 1, "the blocked turn must be handed to a human once (handoff::escalate); handoff rows");
  const json row = rows[0];
  ctx.Assert(row.value("turn_id", "") == "turn-1" && row.value("conversation", "") == "c-1" && row.value("tenant", "") == "t1", "the handoff row names the turn: %s", row.dump());
  ctx.Assert(row.contains("verdicts") && row["verdicts"].value("groundedness", "") == "FAIL", "the handoff row carries the verdicts, got %s", row.dump());
  const GateResult ok = gate(gateTurn("turn-2"), kGateGood, kGateArticles);
  ctx.Assert(ok.status == "answered" && gateHandoffs(ctx).size() == 1, "a grounded answer is answered and writes no handoff row");
}
`,
  },
  hints: [
    "Symptom: answers with a guest's email go out because nobody checks for PII, every turn is as slow as all its guardrails added up, and on the night the guardrail service was down every answer reached the chat.",
    'Mechanism: `GUARDRAILS` omits pii; each `Check` is awaited before the next starts and carries no deadline; a failed call is skipped with `continue`; and a `FAIL` verdict is only logged before `return {"status": "answered", ...}`.',
    'Change: add `"pii"`; build one coroutine per guardrail with `timeout=GUARDRAIL_DEADLINE_S` returning `"ERROR"` on `RpcError`; `asyncio.gather` them; on any non-PASS call `handoff.escalate(...)` and return `escalated` with `answer ""`.',
  ],
  debrief: `The gate is a decision that has to be made on time and on the safe side. Running the checks together makes its cost the slowest guardrail instead of the sum, and one deadline makes that cost a constant the turn can budget for. Treating a timeout or an error as \`ERROR\` rather than as silence is the whole point of a guardrail: an outage must look like a failed check, not like a pass. Escalating with the verdicts gives the human agent the reason along with the turn. Production frameworks also give each guardrail a severity (some only annotate the answer), cache verdicts for an identical answer, and add a circuit breaker so a dead guardrail service routes every turn to people without first waiting out its deadline.`,
};
