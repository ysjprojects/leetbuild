import type {Step} from '@/lib/types';

export const reasoningLoopStep: Step = {
  id: 'reasoning-loop',
  title: 'Chain of Thought loop: deadlines, bounded iterations, a tool registry',
  concept: 'grpc',
  file: 'cot_workflow',
  focus: ['workflow', 'llm', 'tools', 'redis'],
  task: `## Task

**Starting point.** The starter is the Chain of Thought workflow, \`run_turn(turn)\`: it assembles
context, asks the LLM Adapter (\`llm-adapter:9000\`) for reasoning, invokes whatever tool the model
named on the Tool Manager (\`tools:9100\`), and loops until a result. It serves the demo and hides
5 flaws.

**Failure mode the checks target.** \`while True\` around a model that may request a tool on every
reply is an unbounded bill; a call without a deadline is a worker held hostage by one slow
dependency; invoking whatever name the model emitted turns a prompt injection in a help article
into a call to any registered action; an un-keyed write tool refunds twice on retry.

- Every \`Reason\` call carries a **5 s** deadline (\`REASON_DEADLINE_S\`).
- At most **6** iterations (\`MAX_ITERATIONS\`); when the budget is spent without a result the
  turn is returned as \`escalated\`.
- Tools are resolved through \`TOOL_REGISTRY\` (name → \`READ\` or \`WRITE\`). An unknown name
  becomes an outcome fed back to the model (\`{"error": "unknown tool"}\`), not an \`Invoke\`.
- Every \`Invoke\` carries a **3 s** deadline (\`TOOL_DEADLINE_S\`).
- \`WRITE\` tools (\`update_listing\`, \`issue_refund\`) are invoked with
  \`idempotency_key = "{turn_id}:{iteration}"\`; \`READ\` tools carry no key.
- Each tool outcome is appended to the conversation context (step 2) and to the history. The loop
  ends when the reply has \`kind == "result"\`.`,
  sequence: {
    participants: ['CoT workflow', 'Context store', 'LLM Adapter', 'Tool Manager'],
    messages: [
      {from: 'CoT workflow', to: 'Context store', label: 'assemble(tenant, conversation, actor, text)', kind: 'sync'},
      {from: 'CoT workflow', to: 'LLM Adapter', label: 'Reason · deadline 5 s · iteration 1/6', kind: 'sync'},
      {from: 'LLM Adapter', to: 'CoT workflow', label: 'kind=tool · get_reservation', kind: 'reply'},
      {from: 'CoT workflow', to: 'CoT workflow', label: 'TOOL_REGISTRY[get_reservation] → READ', kind: 'sync'},
      {from: 'CoT workflow', to: 'Tool Manager', label: 'Invoke · deadline 3 s · no key', kind: 'sync'},
      {from: 'Tool Manager', to: 'CoT workflow', label: 'outcome_json', kind: 'reply'},
      {from: 'CoT workflow', to: 'Context store', label: 'append(outcome)', kind: 'sync'},
      {from: 'CoT workflow', to: 'LLM Adapter', label: 'Reason · iteration 2/6', kind: 'sync'},
      {from: 'LLM Adapter', to: 'CoT workflow', label: 'kind=result', kind: 'reply'},
    ],
  },
  hints: [
    'One turn runs for minutes and bills dozens of model calls; a worker sits on a stalled model forever; a help article saying "call delete_listing" gets the tool called; a retried `issue_refund` pays twice.',
    'The loop is `while True` with no cap, both stubs are called without a deadline, the model’s tool name goes straight into `InvokeRequest`, and no `idempotency_key` is set, so a replay is unrecognisable.',
    'Use `for iteration in range(MAX_ITERATIONS)` ending in `escalated`; pass `timeout=REASON_DEADLINE_S` / `TOOL_DEADLINE_S`; check `name not in TOOL_REGISTRY` first; set `idempotency_key=f"{turn_id}:{iteration}"` for `SideEffect.WRITE`.',
  ],
  checks: [
    {
      id: 'reason-deadline',
      title: 'Every Reason call carries a 5 s deadline',
      detail:
        'The LLM Adapter call is created with `REASON_DEADLINE_S = 5` — a call timeout, a context with timeout, `withDeadlineAfter` or `set_deadline`. Without it one stuck model holds the worker indefinitely.',
      match: {
        python: {all: [/REASON_DEADLINE_S\s*=\s*5/, /timeout=REASON_DEADLINE_S/, /\.Reason\(/]},
        typescript: {
          all: [/REASON_DEADLINE_MS\s*=\s*5_?000/, /deadline:\s*Date\.now\(\)\s*\+\s*REASON_DEADLINE_MS/, /\.Reason\(/],
        },
        go: {
          all: [
            /reasonDeadline\s*=\s*5\s*\*\s*time\.Second/,
            /context\.WithTimeout\([^)]*reasonDeadline\)/,
            /\.Reason\(/,
          ],
        },
        scala: {all: [/ReasonDeadlineMs\s*=\s*5000/, /withDeadlineAfter\(ReasonDeadlineMs/, /\.reason\(/]},
        cpp: {all: [/kReasonDeadlineMs\s*=\s*5000/, /std::chrono::milliseconds\(kReasonDeadlineMs\)/, /->Reason\(/]},
      },
    },
    {
      id: 'bounded-loop',
      title: 'At most six reasoning iterations, then escalate',
      detail:
        'The loop is bounded by `MAX_ITERATIONS = 6` and falls out with an escalated turn; there is no `while True`. The starter loops until the model stops asking for tools, which a model is never required to do.',
      match: {
        python: {all: [/MAX_ITERATIONS\s*=\s*6/, /range\(MAX_ITERATIONS\)/], none: [/while\s+True/]},
        typescript: {
          all: [/MAX_ITERATIONS\s*=\s*6/, /iteration\s*<\s*MAX_ITERATIONS/],
          none: [/for\s*\(\s*;\s*;\s*\)/, /while\s*\(\s*true\s*\)/],
        },
        go: {all: [/maxIterations\s*=\s*6/, /iteration\s*<\s*maxIterations/], none: [/for\s*\{/]},
        scala: {all: [/MaxIterations\s*=\s*6/, /iteration\s*<\s*MaxIterations/], none: [/while\s*\(\s*true\s*\)/]},
        cpp: {all: [/kMaxIterations\s*=\s*6/, /iteration\s*<\s*kMaxIterations/], none: [/while\s*\(\s*true\s*\)/]},
      },
    },
    {
      id: 'tool-registry',
      title: 'Resolves tools through the registry, never by name alone',
      detail:
        '`TOOL_REGISTRY` maps tool names to side-effect classes and the model’s name is looked up before any `Invoke`; an unknown name becomes an error outcome for the model. The starter invokes whatever string the model emitted.',
      match: {
        python: {all: [/TOOL_REGISTRY\s*=/, /not in TOOL_REGISTRY/]},
        typescript: {all: [/TOOL_REGISTRY(:[^=]*)?\s*=/, /TOOL_REGISTRY\[/]},
        go: {all: [/toolRegistry\s*=/, /toolRegistry\[/, /!ok/]},
        scala: {all: [/ToolRegistry(:[^=]*)?\s*=/, /ToolRegistry\.get\(/]},
        cpp: {all: [/kToolRegistry\s*=/, /kToolRegistry\.find\(/]},
      },
    },
    {
      id: 'tool-deadline',
      title: 'Every Invoke call carries a 3 s deadline',
      detail:
        'The Tool Manager call is created with `TOOL_DEADLINE_S = 3`. A tool that calls a slow downstream must not hold the turn — and the model’s 5 s reasoning budget is separate from it.',
      match: {
        python: {all: [/TOOL_DEADLINE_S\s*=\s*3/, /timeout=TOOL_DEADLINE_S/, /\.Invoke\(/]},
        typescript: {
          all: [/TOOL_DEADLINE_MS\s*=\s*3_?000/, /deadline:\s*Date\.now\(\)\s*\+\s*TOOL_DEADLINE_MS/, /\.Invoke\(/],
        },
        go: {
          all: [/toolDeadline\s*=\s*3\s*\*\s*time\.Second/, /context\.WithTimeout\([^)]*toolDeadline\)/, /\.Invoke\(/],
        },
        scala: {all: [/ToolDeadlineMs\s*=\s*3000/, /withDeadlineAfter\(ToolDeadlineMs/, /\.invoke\(/]},
        cpp: {all: [/kToolDeadlineMs\s*=\s*3000/, /std::chrono::milliseconds\(kToolDeadlineMs\)/, /->Invoke\(/]},
      },
    },
    {
      id: 'write-idempotency',
      title: 'Keys WRITE tools by turn and iteration',
      detail:
        'A tool whose registry entry is `WRITE` is invoked with `idempotency_key = "{turn_id}:{iteration}"`; `READ` tools carry none. The starter sends no key, so a retried `issue_refund` refunds twice.',
      match: {
        python: {all: [/SideEffect\.WRITE/, /idempotency_key\s*=/]},
        typescript: {all: [/['"]write['"]/, /idempotency_key:/]},
        go: {all: [/SideEffectWrite/, /IdempotencyKey\s*[:=]/]},
        scala: {all: [/SideEffect\.Write/, /idempotencyKey\s*=/]},
        cpp: {all: [/SideEffect::kWrite/, /set_idempotency_key\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import grpc

import apv2_pb2
import apv2_pb2_grpc
from context_store import append, assemble

llm = apv2_pb2_grpc.LlmAdapterStub(grpc.insecure_channel("llm-adapter:9000"))
tools = apv2_pb2_grpc.ToolManagerStub(grpc.insecure_channel("tools:9100"))


def run_turn(turn: dict) -> dict:
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    tenant, conversation = turn["tenant"], turn["conversation"]
    context = assemble(tenant, conversation, turn["actor"], turn["text"])
    while True:
        reply = llm.Reason(
            apv2_pb2.ReasonRequest(conversation=conversation, context_json=json.dumps(context))
        )
        if reply.kind == "result":
            append(tenant, conversation, {"role": "assistant", "result": reply.result})
            return {"status": "answered", "result": reply.result}
        outcome = tools.Invoke(apv2_pb2.InvokeRequest(tool=reply.tool, arguments_json=reply.arguments_json))
        item = {"role": "tool", "tool": reply.tool, "outcome": outcome.outcome_json}
        append(tenant, conversation, item)
        context["history"].append(item)
`,
      solution: `import json
from enum import Enum

import grpc

import apv2_pb2
import apv2_pb2_grpc
from context_store import append, assemble

REASON_DEADLINE_S = 5.0
TOOL_DEADLINE_S = 3.0
MAX_ITERATIONS = 6


class SideEffect(Enum):
    READ = "read"
    WRITE = "write"


TOOL_REGISTRY = {
    "get_reservation": SideEffect.READ,
    "check_listing_availability": SideEffect.READ,
    "update_listing": SideEffect.WRITE,
    "issue_refund": SideEffect.WRITE,
}

llm = apv2_pb2_grpc.LlmAdapterStub(grpc.insecure_channel("llm-adapter:9000"))
tools = apv2_pb2_grpc.ToolManagerStub(grpc.insecure_channel("tools:9100"))


def execute_tool(turn_id: str, iteration: int, reply: apv2_pb2.ReasonReply) -> dict:
    if reply.tool not in TOOL_REGISTRY:
        return {"role": "tool", "tool": reply.tool, "error": "unknown tool"}
    request = apv2_pb2.InvokeRequest(tool=reply.tool, arguments_json=reply.arguments_json)
    if TOOL_REGISTRY[reply.tool] is SideEffect.WRITE:
        request.idempotency_key = f"{turn_id}:{iteration}"
    try:
        outcome = tools.Invoke(request, timeout=TOOL_DEADLINE_S)
    except grpc.RpcError as exc:
        return {"role": "tool", "tool": reply.tool, "error": exc.code().name}
    return {"role": "tool", "tool": reply.tool, "outcome": outcome.outcome_json}


def run_turn(turn: dict) -> dict:
    tenant, conversation = turn["tenant"], turn["conversation"]
    context = assemble(tenant, conversation, turn["actor"], turn["text"])
    for iteration in range(MAX_ITERATIONS):
        request = apv2_pb2.ReasonRequest(
            conversation=conversation,
            context_json=json.dumps(context),
            tools=list(TOOL_REGISTRY),
        )
        reply = llm.Reason(request, timeout=REASON_DEADLINE_S)
        if reply.kind == "result":
            append(tenant, conversation, {"role": "assistant", "result": reply.result})
            return {"status": "answered", "result": reply.result, "iterations": iteration + 1}
        item = execute_tool(turn["turn_id"], iteration, reply)
        append(tenant, conversation, item)
        context["history"].append(item)
    return {"status": "escalated", "reason": "iteration budget exhausted", "iterations": MAX_ITERATIONS}
`,
    },
    typescript: {
      starter: `/** Chain of Thought workflow: reason, run the requested tool, feed the outcome back, repeat. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {append, assemble} from './context_store';

interface ReasonReply {
  kind: 'tool' | 'result';
  tool: string;
  arguments_json: string;
  result: string;
}

interface InvokeReply {
  outcome_json: string;
}

interface LlmAdapterClient {
  Reason(
    request: {conversation: string; context_json: string},
    callback: (error: grpc.ServiceError | null, reply: ReasonReply) => void,
  ): void;
}

interface ToolManagerClient {
  Invoke(
    request: {tool: string; arguments_json: string},
    callback: (error: grpc.ServiceError | null, reply: InvokeReply) => void,
  ): void;
}

const {apv2} = grpc.loadPackageDefinition(protoLoader.loadSync('apv2.proto')) as unknown as {
  apv2: {
    LlmAdapter: new (target: string, credentials: grpc.ChannelCredentials) => LlmAdapterClient;
    ToolManager: new (target: string, credentials: grpc.ChannelCredentials) => ToolManagerClient;
  };
};
const llm = new apv2.LlmAdapter('llm-adapter:9000', grpc.credentials.createInsecure());
const tools = new apv2.ToolManager('tools:9100', grpc.credentials.createInsecure());

export interface Turn {
  turn_id: string;
  tenant: string;
  conversation: string;
  actor: string;
  text: string;
}

export async function runTurn(turn: Turn): Promise<{status: string; result?: string}> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const context = await assemble(turn.tenant, turn.conversation, turn.actor, turn.text);
  for (;;) {
    const reply = await new Promise<ReasonReply>((resolve, reject) => {
      llm.Reason({conversation: turn.conversation, context_json: JSON.stringify(context)}, (error, value) =>
        error ? reject(error) : resolve(value),
      );
    });
    if (reply.kind === 'result') {
      await append(turn.tenant, turn.conversation, {role: 'assistant', result: reply.result});
      return {status: 'answered', result: reply.result};
    }
    const outcome = await new Promise<InvokeReply>((resolve, reject) => {
      tools.Invoke({tool: reply.tool, arguments_json: reply.arguments_json}, (error, value) =>
        error ? reject(error) : resolve(value),
      );
    });
    const item = {role: 'tool', tool: reply.tool, outcome: outcome.outcome_json};
    await append(turn.tenant, turn.conversation, item);
    context.history.push(item);
  }
}
`,
      solution: `/** Chain of Thought workflow: deadlines per call, six iterations, a tool registry, keyed writes. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {append, assemble} from './context_store';

const REASON_DEADLINE_MS = 5_000;
const TOOL_DEADLINE_MS = 3_000;
const MAX_ITERATIONS = 6;

type SideEffect = 'read' | 'write';

const TOOL_REGISTRY: Record<string, SideEffect> = {
  get_reservation: 'read',
  check_listing_availability: 'read',
  update_listing: 'write',
  issue_refund: 'write',
};

interface ReasonReply {
  kind: 'tool' | 'result';
  tool: string;
  arguments_json: string;
  result: string;
}

interface InvokeReply {
  outcome_json: string;
}

type Callback<T> = (error: grpc.ServiceError | null, reply: T) => void;

interface LlmAdapterClient {
  Reason(
    request: {conversation: string; context_json: string; tools: string[]},
    metadata: grpc.Metadata,
    options: {deadline: number},
    callback: Callback<ReasonReply>,
  ): void;
}

interface ToolManagerClient {
  Invoke(
    request: {tool: string; arguments_json: string; idempotency_key: string},
    metadata: grpc.Metadata,
    options: {deadline: number},
    callback: Callback<InvokeReply>,
  ): void;
}

const {apv2} = grpc.loadPackageDefinition(protoLoader.loadSync('apv2.proto')) as unknown as {
  apv2: {
    LlmAdapter: new (target: string, credentials: grpc.ChannelCredentials) => LlmAdapterClient;
    ToolManager: new (target: string, credentials: grpc.ChannelCredentials) => ToolManagerClient;
  };
};
const llm = new apv2.LlmAdapter('llm-adapter:9000', grpc.credentials.createInsecure());
const tools = new apv2.ToolManager('tools:9100', grpc.credentials.createInsecure());

export interface Turn {
  turn_id: string;
  tenant: string;
  conversation: string;
  actor: string;
  text: string;
}

interface ToolItem {
  role: 'tool';
  tool: string;
  outcome?: string;
  error?: string;
}

function reason(conversation: string, context: unknown): Promise<ReasonReply> {
  return new Promise((resolve, reject) => {
    llm.Reason(
      {conversation, context_json: JSON.stringify(context), tools: Object.keys(TOOL_REGISTRY)},
      new grpc.Metadata(),
      {deadline: Date.now() + REASON_DEADLINE_MS},
      (error, value) => (error ? reject(error) : resolve(value)),
    );
  });
}

async function executeTool(turnId: string, iteration: number, reply: ReasonReply): Promise<ToolItem> {
  const sideEffect = TOOL_REGISTRY[reply.tool];
  if (sideEffect === undefined) return {role: 'tool', tool: reply.tool, error: 'unknown tool'};
  const request = {
    tool: reply.tool,
    arguments_json: reply.arguments_json,
    idempotency_key: sideEffect === 'write' ? \`\${turnId}:\${iteration}\` : '',
  };
  try {
    const outcome = await new Promise<InvokeReply>((resolve, reject) => {
      tools.Invoke(request, new grpc.Metadata(), {deadline: Date.now() + TOOL_DEADLINE_MS}, (error, value) =>
        error ? reject(error) : resolve(value),
      );
    });
    return {role: 'tool', tool: reply.tool, outcome: outcome.outcome_json};
  } catch (error) {
    return {role: 'tool', tool: reply.tool, error: grpc.status[(error as grpc.ServiceError).code]};
  }
}

export async function runTurn(turn: Turn): Promise<{status: string; result?: string; iterations: number}> {
  const context = await assemble(turn.tenant, turn.conversation, turn.actor, turn.text);
  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const reply = await reason(turn.conversation, context);
    if (reply.kind === 'result') {
      await append(turn.tenant, turn.conversation, {role: 'assistant', result: reply.result});
      return {status: 'answered', result: reply.result, iterations: iteration + 1};
    }
    const item = await executeTool(turn.turn_id, iteration, reply);
    await append(turn.tenant, turn.conversation, item);
    context.history.push(item);
  }
  return {status: 'escalated', iterations: MAX_ITERATIONS};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"

	pb "apv2/apv2pb"
)

var (
	llm   pb.LlmAdapterClient
	tools pb.ToolManagerClient
)

type Turn struct {
	TurnID       string
	Tenant       string
	Conversation string
	Actor        string
	Text         string
}

type Outcome struct {
	Status string
	Result string
}

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
func RunTurn(ctx context.Context, turn Turn) (Outcome, error) {
	assembled, err := Assemble(ctx, turn.Tenant, turn.Conversation, turn.Actor, turn.Text)
	if err != nil {
		return Outcome{}, err
	}
	for {
		contextJSON, _ := json.Marshal(assembled)
		reply, err := llm.Reason(ctx, &pb.ReasonRequest{Conversation: turn.Conversation, ContextJson: string(contextJSON)})
		if err != nil {
			return Outcome{}, err
		}
		if reply.Kind == "result" {
			_ = Append(ctx, turn.Tenant, turn.Conversation, map[string]any{"role": "assistant", "result": reply.Result})
			return Outcome{Status: "answered", Result: reply.Result}, nil
		}
		outcome, err := tools.Invoke(ctx, &pb.InvokeRequest{Tool: reply.Tool, ArgumentsJson: reply.ArgumentsJson})
		if err != nil {
			return Outcome{}, err
		}
		item := map[string]any{"role": "tool", "tool": reply.Tool, "outcome": outcome.OutcomeJson}
		_ = Append(ctx, turn.Tenant, turn.Conversation, item)
		assembled.History = append(assembled.History, item)
	}
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"google.golang.org/grpc/status"

	pb "apv2/apv2pb"
)

const (
	reasonDeadline = 5 * time.Second
	toolDeadline   = 3 * time.Second
	maxIterations  = 6
)

type SideEffect int

const (
	SideEffectRead SideEffect = iota
	SideEffectWrite
)

var toolRegistry = map[string]SideEffect{
	"get_reservation":            SideEffectRead,
	"check_listing_availability": SideEffectRead,
	"update_listing":             SideEffectWrite,
	"issue_refund":               SideEffectWrite,
}

var (
	llm   pb.LlmAdapterClient
	tools pb.ToolManagerClient
)

type Turn struct {
	TurnID       string
	Tenant       string
	Conversation string
	Actor        string
	Text         string
}

type Outcome struct {
	Status     string
	Result     string
	Iterations int
}

func toolNames() []string {
	names := make([]string, 0, len(toolRegistry))
	for name := range toolRegistry {
		names = append(names, name)
	}
	return names
}

func reason(ctx context.Context, conversation string, assembled *Assembled) (*pb.ReasonReply, error) {
	contextJSON, err := json.Marshal(assembled)
	if err != nil {
		return nil, err
	}
	callCtx, cancel := context.WithTimeout(ctx, reasonDeadline)
	defer cancel()
	return llm.Reason(callCtx, &pb.ReasonRequest{
		Conversation: conversation,
		ContextJson:  string(contextJSON),
		Tools:        toolNames(),
	})
}

func executeTool(ctx context.Context, turnID string, iteration int, reply *pb.ReasonReply) map[string]any {
	sideEffect, ok := toolRegistry[reply.Tool]
	if !ok {
		return map[string]any{"role": "tool", "tool": reply.Tool, "error": "unknown tool"}
	}
	request := &pb.InvokeRequest{Tool: reply.Tool, ArgumentsJson: reply.ArgumentsJson}
	if sideEffect == SideEffectWrite {
		request.IdempotencyKey = fmt.Sprintf("%s:%d", turnID, iteration)
	}
	callCtx, cancel := context.WithTimeout(ctx, toolDeadline)
	defer cancel()
	outcome, err := tools.Invoke(callCtx, request)
	if err != nil {
		return map[string]any{"role": "tool", "tool": reply.Tool, "error": status.Code(err).String()}
	}
	return map[string]any{"role": "tool", "tool": reply.Tool, "outcome": outcome.OutcomeJson}
}

func RunTurn(ctx context.Context, turn Turn) (Outcome, error) {
	assembled, err := Assemble(ctx, turn.Tenant, turn.Conversation, turn.Actor, turn.Text)
	if err != nil {
		return Outcome{}, err
	}
	for iteration := 0; iteration < maxIterations; iteration++ {
		reply, err := reason(ctx, turn.Conversation, assembled)
		if err != nil {
			return Outcome{}, err
		}
		if reply.Kind == "result" {
			if err := Append(ctx, turn.Tenant, turn.Conversation, map[string]any{"role": "assistant", "result": reply.Result}); err != nil {
				return Outcome{}, err
			}
			return Outcome{Status: "answered", Result: reply.Result, Iterations: iteration + 1}, nil
		}
		item := executeTool(ctx, turn.TurnID, iteration, reply)
		if err := Append(ctx, turn.Tenant, turn.Conversation, item); err != nil {
			return Outcome{}, err
		}
		assembled.History = append(assembled.History, item)
	}
	return Outcome{Status: "escalated", Iterations: maxIterations}, nil
}
`,
    },
    scala: {
      starter: `import io.grpc.ManagedChannelBuilder
import spray.json._

final case class Turn(turnId: String, tenant: String, conversation: String, actor: String, text: String)
final case class Outcome(status: String, result: Option[String])

object CotWorkflow {
  val llm = LlmAdapterGrpc.blockingStub(ManagedChannelBuilder.forAddress("llm-adapter", 9000).usePlaintext().build())
  val tools = ToolManagerGrpc.blockingStub(ManagedChannelBuilder.forAddress("tools", 9100).usePlaintext().build())

  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  def runTurn(turn: Turn): Outcome = {
    val assembled = ContextStore.assemble(turn.tenant, turn.conversation, turn.actor, turn.text)
    var history = assembled.history
    var outcome: Option[Outcome] = None
    while (outcome.isEmpty) {
      val contextJson = JsObject(
        "history" -> JsArray(history),
        "static" -> JsObject(assembled.static),
        "dynamic" -> JsObject(assembled.dynamic.map { case (k, v) => k -> JsArray(v) })
      ).compactPrint
      val reply = llm.reason(ReasonRequest(conversation = turn.conversation, contextJson = contextJson))
      if (reply.kind == "result") {
        ContextStore.append(turn.tenant, turn.conversation, JsObject("role" -> JsString("assistant"), "result" -> JsString(reply.result)))
        outcome = Some(Outcome("answered", Some(reply.result)))
      } else {
        val invoked = tools.invoke(InvokeRequest(tool = reply.tool, argumentsJson = reply.argumentsJson))
        val item = JsObject("role" -> JsString("tool"), "tool" -> JsString(reply.tool), "outcome" -> JsString(invoked.outcomeJson))
        ContextStore.append(turn.tenant, turn.conversation, item)
        history = history :+ item
      }
    }
    outcome.get
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}
import spray.json._

final case class Turn(turnId: String, tenant: String, conversation: String, actor: String, text: String)
final case class Outcome(status: String, result: Option[String], iterations: Int)

sealed trait SideEffect
object SideEffect {
  case object Read extends SideEffect
  case object Write extends SideEffect
}

object CotWorkflow {
  val ReasonDeadlineMs = 5000L
  val ToolDeadlineMs = 3000L
  val MaxIterations = 6

  val ToolRegistry: Map[String, SideEffect] = Map(
    "get_reservation" -> SideEffect.Read,
    "check_listing_availability" -> SideEffect.Read,
    "update_listing" -> SideEffect.Write,
    "issue_refund" -> SideEffect.Write
  )

  val llm = LlmAdapterGrpc.blockingStub(ManagedChannelBuilder.forAddress("llm-adapter", 9000).usePlaintext().build())
  val tools = ToolManagerGrpc.blockingStub(ManagedChannelBuilder.forAddress("tools", 9100).usePlaintext().build())

  def executeTool(turnId: String, iteration: Int, reply: ReasonReply): JsObject =
    ToolRegistry.get(reply.tool) match {
      case None =>
        JsObject("role" -> JsString("tool"), "tool" -> JsString(reply.tool), "error" -> JsString("unknown tool"))
      case Some(sideEffect) =>
        val idempotencyKey = if (sideEffect == SideEffect.Write) s"$turnId:$iteration" else ""
        val request = InvokeRequest(tool = reply.tool, argumentsJson = reply.argumentsJson, idempotencyKey = idempotencyKey)
        try {
          val invoked = tools.withDeadlineAfter(ToolDeadlineMs, TimeUnit.MILLISECONDS).invoke(request)
          JsObject("role" -> JsString("tool"), "tool" -> JsString(reply.tool), "outcome" -> JsString(invoked.outcomeJson))
        } catch {
          case exc: StatusRuntimeException =>
            JsObject("role" -> JsString("tool"), "tool" -> JsString(reply.tool), "error" -> JsString(exc.getStatus.getCode.name))
        }
    }

  def runTurn(turn: Turn): Outcome = {
    val assembled = ContextStore.assemble(turn.tenant, turn.conversation, turn.actor, turn.text)
    var history = assembled.history
    var iteration = 0
    while (iteration < MaxIterations) {
      val contextJson = JsObject(
        "history" -> JsArray(history),
        "static" -> JsObject(assembled.static),
        "dynamic" -> JsObject(assembled.dynamic.map { case (k, v) => k -> JsArray(v) })
      ).compactPrint
      val request = ReasonRequest(conversation = turn.conversation, contextJson = contextJson, tools = ToolRegistry.keys.toSeq)
      val reply = llm.withDeadlineAfter(ReasonDeadlineMs, TimeUnit.MILLISECONDS).reason(request)
      if (reply.kind == "result") {
        ContextStore.append(turn.tenant, turn.conversation, JsObject("role" -> JsString("assistant"), "result" -> JsString(reply.result)))
        return Outcome("answered", Some(reply.result), iteration + 1)
      }
      val item = executeTool(turn.turnId, iteration, reply)
      ContextStore.append(turn.tenant, turn.conversation, item)
      history = history :+ item
      iteration += 1
    }
    Outcome("escalated", None, MaxIterations)
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>

#include "apv2.grpc.pb.h"

#include <memory>
#include <string>

using json = nlohmann::json;

json assemble(const std::string& tenant, const std::string& conversation, const std::string& userId, const std::string& question);
void append(const std::string& tenant, const std::string& conversation, const json& item);

struct Turn {
  std::string turnId;
  std::string tenant;
  std::string conversation;
  std::string actor;
  std::string text;
};

std::unique_ptr<apv2::LlmAdapter::Stub> llm;
std::unique_ptr<apv2::ToolManager::Stub> tools;

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
json runTurn(const Turn& turn) {
  json context = assemble(turn.tenant, turn.conversation, turn.actor, turn.text);
  while (true) {
    grpc::ClientContext reasonCtx;
    apv2::ReasonRequest request;
    request.set_conversation(turn.conversation);
    request.set_context_json(context.dump());
    apv2::ReasonReply reply;
    const grpc::Status status = llm->Reason(&reasonCtx, request, &reply);
    if (!status.ok()) throw std::runtime_error("reason failed: " + status.error_message());
    if (reply.kind() == "result") {
      append(turn.tenant, turn.conversation, json{{"role", "assistant"}, {"result", reply.result()}});
      return json{{"status", "answered"}, {"result", reply.result()}};
    }
    grpc::ClientContext invokeCtx;
    apv2::InvokeRequest invoke;
    invoke.set_tool(reply.tool());
    invoke.set_arguments_json(reply.arguments_json());
    apv2::InvokeReply outcome;
    tools->Invoke(&invokeCtx, invoke, &outcome);
    const json item = {{"role", "tool"}, {"tool", reply.tool()}, {"outcome", outcome.outcome_json()}};
    append(turn.tenant, turn.conversation, item);
    context["history"].push_back(item);
  }
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>

#include "apv2.grpc.pb.h"

#include <chrono>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>

using json = nlohmann::json;

json assemble(const std::string& tenant, const std::string& conversation, const std::string& userId, const std::string& question);
void append(const std::string& tenant, const std::string& conversation, const json& item);

constexpr int kReasonDeadlineMs = 5000;
constexpr int kToolDeadlineMs = 3000;
constexpr int kMaxIterations = 6;

enum class SideEffect { kRead, kWrite };

const std::map<std::string, SideEffect> kToolRegistry = {
    {"get_reservation", SideEffect::kRead},
    {"check_listing_availability", SideEffect::kRead},
    {"update_listing", SideEffect::kWrite},
    {"issue_refund", SideEffect::kWrite},
};

struct Turn {
  std::string turnId;
  std::string tenant;
  std::string conversation;
  std::string actor;
  std::string text;
};

std::unique_ptr<apv2::LlmAdapter::Stub> llm;
std::unique_ptr<apv2::ToolManager::Stub> tools;

json executeTool(const std::string& turnId, int iteration, const apv2::ReasonReply& reply) {
  const auto entry = kToolRegistry.find(reply.tool());
  if (entry == kToolRegistry.end()) {
    return json{{"role", "tool"}, {"tool", reply.tool()}, {"error", "unknown tool"}};
  }
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kToolDeadlineMs));
  apv2::InvokeRequest request;
  request.set_tool(reply.tool());
  request.set_arguments_json(reply.arguments_json());
  if (entry->second == SideEffect::kWrite) request.set_idempotency_key(turnId + ":" + std::to_string(iteration));
  apv2::InvokeReply outcome;
  const grpc::Status status = tools->Invoke(&ctx, request, &outcome);
  if (!status.ok()) {
    return json{{"role", "tool"}, {"tool", reply.tool()}, {"error", std::to_string(status.error_code())}};
  }
  return json{{"role", "tool"}, {"tool", reply.tool()}, {"outcome", outcome.outcome_json()}};
}

json runTurn(const Turn& turn) {
  json context = assemble(turn.tenant, turn.conversation, turn.actor, turn.text);
  for (int iteration = 0; iteration < kMaxIterations; iteration++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kReasonDeadlineMs));
    apv2::ReasonRequest request;
    request.set_conversation(turn.conversation);
    request.set_context_json(context.dump());
    for (const auto& [name, side_effect] : kToolRegistry) request.add_tools(name);
    apv2::ReasonReply reply;
    const grpc::Status status = llm->Reason(&ctx, request, &reply);
    if (!status.ok()) throw std::runtime_error("reason failed: " + status.error_message());
    if (reply.kind() == "result") {
      append(turn.tenant, turn.conversation, json{{"role", "assistant"}, {"result", reply.result()}});
      return json{{"status", "answered"}, {"result", reply.result()}, {"iterations", iteration + 1}};
    }
    const json item = executeTool(turn.turnId, iteration, reply);
    append(turn.tenant, turn.conversation, item);
    context["history"].push_back(item);
  }
  return json{{"status", "escalated"}, {"iterations", kMaxIterations}};
}
`,
    },
  },
  debrief: `Every piece of the fix answers one question: what is the worst case of this loop? The post says the workflow stays in the reasoning loop until a result is generated, which describes the algorithm, not the budget. A deadline bounds one model call, a second bounds one tool call, the iteration cap bounds the turn, and escalation is how a bounded turn ends when the model has not finished. The registry separates proposing from deciding: the model names a tool, the platform decides whether it exists, so a name planted in a help article stops at the lookup. The idempotency key covers three retry paths (loop, client, Tool Manager) so a refund is applied once. Production platforms also gate the registry by role and cap tokens per turn.`,
};
