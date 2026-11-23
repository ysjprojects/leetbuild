import type {Step} from '@/lib/types';

export const reasoningLoopStep: Step = {
  id: 'reasoning-loop',
  title: 'Chain of Thought loop: deadlines, bounded iterations, a tool registry',
  concept: 'grpc',
  guides: ['deadlines-and-retries'],
  file: 'cot_workflow',
  focus: ['workflow', 'llm', 'tools', 'redis'],
  task: `## Task

**Starting point.** The starter is the Chain of Thought workflow, \`run_turn(store, turn)\`: it
appends the question to the step-2 context store, then loops: \`store.assemble\`, \`LlmAdapter.Reason\`
with the history, and on \`kind == "tool"\` a \`ToolManager.Invoke\` of the tool the model named, whose
result goes back into the context as a \`tool\` item. On \`kind == "result"\` it appends the answer and
returns \`{"status": "answered", "answer", "iterations"}\`. It serves the demo and hides 5 flaws.

**Failure mode the checks target.** A model that asks for a tool on every reply runs an unbounded
bill; a call without a deadline holds a worker for as long as the dependency stalls; a tool name taken
from the model lets a prompt injection in a help article issue a refund for a customer; and a write
tool without a key refunds twice when the worker retries the turn.

- Every \`Reason\` carries its own **5 s** (\`REASON_DEADLINE_S\`); a failed one, whatever the
  status, returns \`escalated\`.
- At most **6** iterations (\`MAX_ITERATIONS\`), then \`escalated\`.
- \`TOOL_REGISTRY\` maps a name to \`READ\` or \`WRITE\` and the roles that may run it:
  \`get_reservation\` and \`search_help\` are \`READ\` for customers and agents; \`update_listing\` and
  \`issue_refund\` are \`WRITE\` for agents only. An unknown name or a role not listed makes the
  outcome \`{"error": "tool not allowed"}\`, with no \`Invoke\`.
- Every \`Invoke\` carries its own **3 s** (\`TOOL_DEADLINE_S\`); a failed one, whatever the status,
  is the outcome \`{"error": "tool failed"}\`.
- \`WRITE\` tools carry \`idempotency_key = "{turn_id}:{iteration}"\`; \`READ\` tools none.`,
  sequence: {
    participants: ['CoT workflow', 'Context store', 'LLM Adapter', 'Tool Manager'],
    messages: [
      {from: 'CoT workflow', to: 'Context store', label: 'append_item(user) · assemble', kind: 'sync'},
      {from: 'CoT workflow', to: 'LLM Adapter', label: 'Reason · deadline 5 s · iteration 1/6', kind: 'sync'},
      {from: 'LLM Adapter', to: 'CoT workflow', label: 'kind=tool · get_reservation', kind: 'reply'},
      {from: 'CoT workflow', to: 'CoT workflow', label: 'TOOL_REGISTRY: READ, customer allowed', kind: 'sync'},
      {from: 'CoT workflow', to: 'Tool Manager', label: 'Invoke · deadline 3 s', kind: 'sync'},
      {from: 'Tool Manager', to: 'CoT workflow', label: 'result', kind: 'reply'},
      {from: 'CoT workflow', to: 'Context store', label: 'append_item(tool outcome)', kind: 'sync'},
      {from: 'CoT workflow', to: 'LLM Adapter', label: 'Reason · iteration 2/6', kind: 'sync'},
      {from: 'LLM Adapter', to: 'CoT workflow', label: 'kind=result', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'reason-deadline',
      title: 'Every Reason call carries a 5 s deadline',
      detail:
        'A turn is answered after two Reason calls, each with a deadline of about 5 s, and the context holds the question, the tool outcome and the answer; with a model that takes 2 s, every Reason call still carries about 5 s; a model that takes 6 s is cut at 5 s and the turn comes back `escalated`, as it does when Reason fails with INTERNAL. The starter calls Reason without a deadline.',
      match: {
        python: {all: [/REASON_DEADLINE_S/, /Reason\([\s\S]{0,200}?timeout\s*=\s*REASON_DEADLINE_S/]},
        typescript: {
          all: [/REASON_DEADLINE_MS/, /Reason\([\s\S]{0,200}?deadline:\s*Date\.now\(\)\s*\+\s*REASON_DEADLINE_MS/],
        },
        go: {all: [/reasonDeadline/, /context\.WithTimeout\([^\n]*reasonDeadline\)/]},
        cpp: {all: [/kReasonDeadline/, /set_deadline\([^\n]*kReasonDeadline\)/]},
      },
    },
    {
      id: 'bounded-loop',
      title: 'At most six reasoning iterations, then escalate',
      detail:
        'A model that asks for a tool on every reply gets exactly 6 Reason calls and the turn comes back `escalated` with iterations 6. The starter loops until the model answers, 13 calls later.',
      match: {
        python: {all: [/MAX_ITERATIONS/, /["']escalated["']/], none: [/while\s+True/]},
        typescript: {
          all: [/MAX_ITERATIONS/, /['"]escalated['"]/],
          none: [/while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\)/],
        },
        go: {all: [/maxIterations/, /"escalated"/], none: [/for\s*\{/]},
        cpp: {all: [/kMaxIterations/, /"escalated"/], none: [/while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\)/]},
      },
    },
    {
      id: 'tool-registry',
      title: 'Resolves tools through the registry and the turn’s role',
      detail:
        'A customer turn whose model asks for `issue_refund` or `update_listing` (agent-only), or for `delete_account` (unregistered), makes no Invoke and feeds `{"error": "tool not allowed"}` back to the model; an agent turn runs `issue_refund`. The starter invokes whatever name the model returned.',
      match: {
        python: {all: [/TOOL_REGISTRY/, /tool not allowed/]},
        typescript: {all: [/TOOL_REGISTRY/, /tool not allowed/]},
        go: {all: [/toolRegistry/, /tool not allowed/]},
        cpp: {all: [/kToolRegistry/, /tool not allowed/]},
      },
    },
    {
      id: 'tool-deadline',
      title: 'Every Invoke call carries a 3 s deadline',
      detail:
        'Each Invoke carries a deadline of about 3 s, also on every iteration of a loop whose tool takes 2 s; a tool that takes 5 s is cut at 3 s, `{"error": "tool failed"}` goes back to the model and the turn is still answered, as it is when Invoke fails with INTERNAL. The starter waits for the tool however long it takes.',
      match: {
        python: {all: [/TOOL_DEADLINE_S/, /Invoke\([\s\S]{0,300}?timeout\s*=\s*TOOL_DEADLINE_S/]},
        typescript: {
          all: [/TOOL_DEADLINE_MS/, /Invoke\([\s\S]{0,300}?deadline:\s*Date\.now\(\)\s*\+\s*TOOL_DEADLINE_MS/],
        },
        go: {all: [/toolDeadline/, /context\.WithTimeout\([^\n]*toolDeadline\)/]},
        cpp: {all: [/kToolDeadline/, /set_deadline\([^\n]*kToolDeadline\)/]},
      },
    },
    {
      id: 'write-idempotency',
      title: 'Keys WRITE tools by turn and iteration',
      detail:
        'An agent turn that issues a refund sends `idempotency_key` `turn-9:1`, and running the same turn again (a worker redelivery) executes the refund once; a READ tool carries no key. The starter sends no key, so the Tool Manager refunds twice.',
      match: {
        python: {all: [/idempotency_key\s*=/, /["']WRITE["']/]},
        typescript: {all: [/idempotency_key\s*[:,}]/, /['"]WRITE['"]/]},
        go: {all: [/IdempotencyKey:/, /"WRITE"/]},
        cpp: {all: [/set_idempotency_key\(/, /"WRITE"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

import grpc

import support_automation_pb2 as pb
import support_automation_pb2_grpc as pb_grpc
from apv2.config import LLM_ADAPTER, TOOL_MANAGER

logger = logging.getLogger("apv2.cot")

llm = pb_grpc.LlmAdapterStub(grpc.insecure_channel(LLM_ADAPTER))
tools = pb_grpc.ToolManagerStub(grpc.insecure_channel(TOOL_MANAGER))


def run_turn(store, turn: dict) -> dict:
    """One turn of the Chain of Thought loop: reason, run the tool asked for, feed the outcome back, until a result."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    tenant, conversation = turn["tenant"], turn["conversation"]
    store.append_item(tenant, conversation, {"kind": "user", "text": turn["text"]})
    iteration = 0
    while True:
        iteration += 1
        context = store.assemble(tenant, conversation, turn["actor"], turn["text"])
        messages = [pb.ContextItem(kind=item["kind"], text=item["text"]) for item in context["history"]]
        reply = llm.Reason(pb.ReasonRequest(turn_id=turn["turn_id"], iteration=iteration, messages=messages))
        if reply.kind == "result":
            store.append_item(tenant, conversation, {"kind": "assistant", "text": reply.text})
            return {"status": "answered", "answer": reply.text, "iterations": iteration}
        request = pb.InvokeRequest(turn_id=turn["turn_id"], tool=reply.tool, args=reply.args)
        outcome = tools.Invoke(request).result
        logger.info("turn=%s iteration=%d tool=%s", turn["turn_id"], iteration, reply.tool)
        store.append_item(tenant, conversation, {"kind": "tool", "text": outcome})
`,
      solution: `import logging

import grpc

import support_automation_pb2 as pb
import support_automation_pb2_grpc as pb_grpc
from apv2.config import LLM_ADAPTER, TOOL_MANAGER

logger = logging.getLogger("apv2.cot")

REASON_DEADLINE_S = 5.0
TOOL_DEADLINE_S = 3.0
MAX_ITERATIONS = 6
# name → (READ or WRITE, the roles that may run it)
TOOL_REGISTRY = {
    "get_reservation": ("READ", {"customer", "agent"}),
    "search_help": ("READ", {"customer", "agent"}),
    "update_listing": ("WRITE", {"agent"}),
    "issue_refund": ("WRITE", {"agent"}),
}
NOT_ALLOWED = '{"error": "tool not allowed"}'
TOOL_FAILED = '{"error": "tool failed"}'

llm = pb_grpc.LlmAdapterStub(grpc.insecure_channel(LLM_ADAPTER))
tools = pb_grpc.ToolManagerStub(grpc.insecure_channel(TOOL_MANAGER))


def _run_tool(turn: dict, iteration: int, reply) -> str:
    """The outcome the model sees: the tool's result, or why it did not run."""
    entry = TOOL_REGISTRY.get(reply.tool)
    if entry is None or turn["role"] not in entry[1]:
        return NOT_ALLOWED  # the model's choice is a request, not an authorization
    key = f"{turn['turn_id']}:{iteration}" if entry[0] == "WRITE" else ""
    request = pb.InvokeRequest(turn_id=turn["turn_id"], tool=reply.tool, args=reply.args, idempotency_key=key)
    try:
        return tools.Invoke(request, timeout=TOOL_DEADLINE_S).result
    except grpc.RpcError as err:
        logger.warning("turn=%s iteration=%d tool=%s failed: %s", turn["turn_id"], iteration, reply.tool, err.code())
        return TOOL_FAILED


def run_turn(store, turn: dict) -> dict:
    """One turn of the Chain of Thought loop: reason, run the tool asked for, feed the outcome back, until a result."""
    tenant, conversation = turn["tenant"], turn["conversation"]
    store.append_item(tenant, conversation, {"kind": "user", "text": turn["text"]})
    for iteration in range(1, MAX_ITERATIONS + 1):
        context = store.assemble(tenant, conversation, turn["actor"], turn["text"])
        messages = [pb.ContextItem(kind=item["kind"], text=item["text"]) for item in context["history"]]
        try:
            reply = llm.Reason(pb.ReasonRequest(turn_id=turn["turn_id"], iteration=iteration, messages=messages), timeout=REASON_DEADLINE_S)
        except grpc.RpcError as err:
            logger.warning("turn=%s iteration=%d reason failed: %s", turn["turn_id"], iteration, err.code())
            return {"status": "escalated", "answer": "", "iterations": iteration}
        if reply.kind == "result":
            store.append_item(tenant, conversation, {"kind": "assistant", "text": reply.text})
            return {"status": "answered", "answer": reply.text, "iterations": iteration}
        outcome = _run_tool(turn, iteration, reply)
        logger.info("turn=%s iteration=%d tool=%s", turn["turn_id"], iteration, reply.tool)
        store.append_item(tenant, conversation, {"kind": "tool", "text": outcome})
    return {"status": "escalated", "answer": "", "iterations": MAX_ITERATIONS}
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {LLM_ADAPTER, TOOL_MANAGER} from 'apv2/config';
import type {ContextStore, Item, Turn} from 'apv2/model';

interface ReasonReply {
  kind: string;
  tool: string;
  args: string;
  text: string;
  input_tokens: number;
  output_tokens: number;
}
interface LlmClient {
  Reason(request: {turn_id: string; iteration: number; messages: Item[]}, options?: {deadline: number}): Promise<ReasonReply>;
}
interface ToolClient {
  Invoke(request: {turn_id: string; tool: string; args: string; idempotency_key?: string}, options?: {deadline: number}): Promise<{result: string}>;
}

const {apv2rpc} = grpc.loadPackageDefinition(protoLoader.loadSync('support_automation.proto')) as unknown as {
  apv2rpc: {
    LlmAdapter: new (target: string, credentials: grpc.ChannelCredentials) => LlmClient;
    ToolManager: new (target: string, credentials: grpc.ChannelCredentials) => ToolClient;
  };
};
const llm = new apv2rpc.LlmAdapter(LLM_ADAPTER, grpc.credentials.createInsecure());
const tools = new apv2rpc.ToolManager(TOOL_MANAGER, grpc.credentials.createInsecure());

export interface TurnResult {
  status: string;
  answer: string;
  iterations: number;
}

/** One turn of the Chain of Thought loop: reason, run the tool asked for, feed the outcome back, until a result. */
export async function runTurn(store: ContextStore, turn: Turn): Promise<TurnResult> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const {tenant, conversation} = turn;
  await store.appendItem(tenant, conversation, {kind: 'user', text: turn.text});
  let iteration = 0;
  while (true) {
    iteration += 1;
    const context = await store.assemble(tenant, conversation, turn.actor, turn.text);
    const reply = await llm.Reason({turn_id: turn.turn_id, iteration, messages: context.history});
    if (reply.kind === 'result') {
      await store.appendItem(tenant, conversation, {kind: 'assistant', text: reply.text});
      return {status: 'answered', answer: reply.text, iterations: iteration};
    }
    const {result} = await tools.Invoke({turn_id: turn.turn_id, tool: reply.tool, args: reply.args});
    await store.appendItem(tenant, conversation, {kind: 'tool', text: result});
  }
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {LLM_ADAPTER, TOOL_MANAGER} from 'apv2/config';
import type {ContextStore, Item, Turn} from 'apv2/model';

export const REASON_DEADLINE_MS = 5_000;
export const TOOL_DEADLINE_MS = 3_000;
export const MAX_ITERATIONS = 6;
/** name → READ or WRITE, and the roles that may run it. */
export const TOOL_REGISTRY: Record<string, {mode: 'READ' | 'WRITE'; roles: string[]}> = {
  get_reservation: {mode: 'READ', roles: ['customer', 'agent']},
  search_help: {mode: 'READ', roles: ['customer', 'agent']},
  update_listing: {mode: 'WRITE', roles: ['agent']},
  issue_refund: {mode: 'WRITE', roles: ['agent']},
};
const NOT_ALLOWED = '{"error": "tool not allowed"}';
const TOOL_FAILED = '{"error": "tool failed"}';

interface ReasonReply {
  kind: string;
  tool: string;
  args: string;
  text: string;
  input_tokens: number;
  output_tokens: number;
}
interface LlmClient {
  Reason(request: {turn_id: string; iteration: number; messages: Item[]}, options?: {deadline: number}): Promise<ReasonReply>;
}
interface ToolClient {
  Invoke(request: {turn_id: string; tool: string; args: string; idempotency_key?: string}, options?: {deadline: number}): Promise<{result: string}>;
}

const {apv2rpc} = grpc.loadPackageDefinition(protoLoader.loadSync('support_automation.proto')) as unknown as {
  apv2rpc: {
    LlmAdapter: new (target: string, credentials: grpc.ChannelCredentials) => LlmClient;
    ToolManager: new (target: string, credentials: grpc.ChannelCredentials) => ToolClient;
  };
};
const llm = new apv2rpc.LlmAdapter(LLM_ADAPTER, grpc.credentials.createInsecure());
const tools = new apv2rpc.ToolManager(TOOL_MANAGER, grpc.credentials.createInsecure());

export interface TurnResult {
  status: string;
  answer: string;
  iterations: number;
}

/** The outcome the model sees: the tool's result, or why it did not run. */
async function runTool(turn: Turn, iteration: number, reply: ReasonReply): Promise<string> {
  const entry = Object.hasOwn(TOOL_REGISTRY, reply.tool) ? TOOL_REGISTRY[reply.tool] : undefined;
  if (entry === undefined || !entry.roles.includes(turn.role)) return NOT_ALLOWED; // the model's choice is a request, not an authorization
  const idempotency_key = entry.mode === 'WRITE' ? \`\${turn.turn_id}:\${iteration}\` : '';
  try {
    const {result} = await tools.Invoke(
      {turn_id: turn.turn_id, tool: reply.tool, args: reply.args, idempotency_key},
      {deadline: Date.now() + TOOL_DEADLINE_MS},
    );
    return result;
  } catch {
    return TOOL_FAILED;
  }
}

/** One turn of the Chain of Thought loop: reason, run the tool asked for, feed the outcome back, until a result. */
export async function runTurn(store: ContextStore, turn: Turn): Promise<TurnResult> {
  const {tenant, conversation} = turn;
  await store.appendItem(tenant, conversation, {kind: 'user', text: turn.text});
  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration += 1) {
    const context = await store.assemble(tenant, conversation, turn.actor, turn.text);
    let reply: ReasonReply;
    try {
      reply = await llm.Reason({turn_id: turn.turn_id, iteration, messages: context.history}, {deadline: Date.now() + REASON_DEADLINE_MS});
    } catch {
      return {status: 'escalated', answer: '', iterations: iteration};
    }
    if (reply.kind === 'result') {
      await store.appendItem(tenant, conversation, {kind: 'assistant', text: reply.text});
      return {status: 'answered', answer: reply.text, iterations: iteration};
    }
    await store.appendItem(tenant, conversation, {kind: 'tool', text: await runTool(turn, iteration, reply)});
  }
  return {status: 'escalated', answer: '', iterations: MAX_ITERATIONS};
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

	"apv2/config" // config.LlmAdapter, config.ToolManager — provided
	pb "apv2/gen/support_automation"
	"apv2/model" // model.Turn, model.Item, model.ContextStore
)

var llmConn, _ = grpc.NewClient(config.LlmAdapter, grpc.WithTransportCredentials(insecure.NewCredentials()))
var toolConn, _ = grpc.NewClient(config.ToolManager, grpc.WithTransportCredentials(insecure.NewCredentials()))
var llm = pb.NewLlmAdapterClient(llmConn)
var tools = pb.NewToolManagerClient(toolConn)

// TurnResult is how a turn ended: answered (with the answer) or escalated to a human.
type TurnResult struct {
	Status     string
	Answer     string
	Iterations int
}

func toMessages(history []model.Item) []*pb.ContextItem {
	out := make([]*pb.ContextItem, 0, len(history))
	for _, item := range history {
		out = append(out, &pb.ContextItem{Kind: item.Kind, Text: item.Text})
	}
	return out
}

// runTurn is one turn of the Chain of Thought loop: reason, run the tool asked for, feed the outcome
// back, until a result.
func runTurn(ctx context.Context, store model.ContextStore, turn model.Turn) (TurnResult, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	if err := store.AppendItem(ctx, turn.Tenant, turn.Conversation, model.Item{Kind: "user", Text: turn.Text}); err != nil {
		return TurnResult{}, err
	}
	iteration := 0
	for {
		iteration++
		c, err := store.Assemble(ctx, turn.Tenant, turn.Conversation, turn.Actor, turn.Text)
		if err != nil {
			return TurnResult{}, err
		}
		reply, err := llm.Reason(ctx, &pb.ReasonRequest{TurnId: turn.TurnID, Iteration: int32(iteration), Messages: toMessages(c.History)})
		if err != nil {
			return TurnResult{}, err
		}
		if reply.GetKind() == "result" {
			if err := store.AppendItem(ctx, turn.Tenant, turn.Conversation, model.Item{Kind: "assistant", Text: reply.GetText()}); err != nil {
				return TurnResult{}, err
			}
			return TurnResult{Status: "answered", Answer: reply.GetText(), Iterations: iteration}, nil
		}
		out, err := tools.Invoke(ctx, &pb.InvokeRequest{TurnId: turn.TurnID, Tool: reply.GetTool(), Args: reply.GetArgs()})
		if err != nil {
			return TurnResult{}, err
		}
		log.Printf("turn=%s iteration=%d tool=%s", turn.TurnID, iteration, reply.GetTool())
		if err := store.AppendItem(ctx, turn.Tenant, turn.Conversation, model.Item{Kind: "tool", Text: out.GetResult()}); err != nil {
			return TurnResult{}, err
		}
	}
}
`,
      solution: `package main

import (
	"context"
	"log"
	"slices"
	"strconv"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"apv2/config" // config.LlmAdapter, config.ToolManager — provided
	pb "apv2/gen/support_automation"
	"apv2/model" // model.Turn, model.Item, model.ContextStore
)

const (
	reasonDeadline = 5 * time.Second
	toolDeadline   = 3 * time.Second
	maxIterations  = 6
	notAllowed     = \`{"error": "tool not allowed"}\`
	toolFailed     = \`{"error": "tool failed"}\`
)

type toolSpec struct {
	Mode  string // READ or WRITE
	Roles []string
}

var toolRegistry = map[string]toolSpec{
	"get_reservation": {Mode: "READ", Roles: []string{"customer", "agent"}},
	"search_help":     {Mode: "READ", Roles: []string{"customer", "agent"}},
	"update_listing":  {Mode: "WRITE", Roles: []string{"agent"}},
	"issue_refund":    {Mode: "WRITE", Roles: []string{"agent"}},
}

var llmConn, _ = grpc.NewClient(config.LlmAdapter, grpc.WithTransportCredentials(insecure.NewCredentials()))
var toolConn, _ = grpc.NewClient(config.ToolManager, grpc.WithTransportCredentials(insecure.NewCredentials()))
var llm = pb.NewLlmAdapterClient(llmConn)
var tools = pb.NewToolManagerClient(toolConn)

// TurnResult is how a turn ended: answered (with the answer) or escalated to a human.
type TurnResult struct {
	Status     string
	Answer     string
	Iterations int
}

func toMessages(history []model.Item) []*pb.ContextItem {
	out := make([]*pb.ContextItem, 0, len(history))
	for _, item := range history {
		out = append(out, &pb.ContextItem{Kind: item.Kind, Text: item.Text})
	}
	return out
}

// runTool is the outcome the model sees: the tool's result, or why it did not run.
func runTool(ctx context.Context, turn model.Turn, iteration int, reply *pb.ReasonReply) string {
	spec, ok := toolRegistry[reply.GetTool()]
	if !ok || !slices.Contains(spec.Roles, turn.Role) {
		return notAllowed // the model's choice is a request, not an authorization
	}
	key := ""
	if spec.Mode == "WRITE" {
		key = turn.TurnID + ":" + strconv.Itoa(iteration)
	}
	callCtx, cancel := context.WithTimeout(ctx, toolDeadline)
	defer cancel()
	out, err := tools.Invoke(callCtx, &pb.InvokeRequest{TurnId: turn.TurnID, Tool: reply.GetTool(), Args: reply.GetArgs(), IdempotencyKey: key})
	if err != nil {
		log.Printf("turn=%s iteration=%d tool=%s failed: %v", turn.TurnID, iteration, reply.GetTool(), err)
		return toolFailed
	}
	return out.GetResult()
}

// runTurn is one turn of the Chain of Thought loop: reason, run the tool asked for, feed the outcome
// back, until a result.
func runTurn(ctx context.Context, store model.ContextStore, turn model.Turn) (TurnResult, error) {
	if err := store.AppendItem(ctx, turn.Tenant, turn.Conversation, model.Item{Kind: "user", Text: turn.Text}); err != nil {
		return TurnResult{}, err
	}
	for iteration := 1; iteration <= maxIterations; iteration++ {
		c, err := store.Assemble(ctx, turn.Tenant, turn.Conversation, turn.Actor, turn.Text)
		if err != nil {
			return TurnResult{}, err
		}
		callCtx, cancel := context.WithTimeout(ctx, reasonDeadline)
		reply, err := llm.Reason(callCtx, &pb.ReasonRequest{TurnId: turn.TurnID, Iteration: int32(iteration), Messages: toMessages(c.History)})
		cancel()
		if err != nil {
			log.Printf("turn=%s iteration=%d reason failed: %v", turn.TurnID, iteration, err)
			return TurnResult{Status: "escalated", Iterations: iteration}, nil
		}
		if reply.GetKind() == "result" {
			if err := store.AppendItem(ctx, turn.Tenant, turn.Conversation, model.Item{Kind: "assistant", Text: reply.GetText()}); err != nil {
				return TurnResult{}, err
			}
			return TurnResult{Status: "answered", Answer: reply.GetText(), Iterations: iteration}, nil
		}
		outcome := runTool(ctx, turn, iteration, reply)
		log.Printf("turn=%s iteration=%d tool=%s", turn.TurnID, iteration, reply.GetTool())
		if err := store.AppendItem(ctx, turn.Tenant, turn.Conversation, model.Item{Kind: "tool", Text: outcome}); err != nil {
			return TurnResult{}, err
		}
	}
	return TurnResult{Status: "escalated", Iterations: maxIterations}, nil
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <string>

#include "apv2/config.h"  // config::kLlmAdapter, config::kToolManager — provided
#include "apv2/model.h"   // model::Item, model::ContextStore
#include "support_automation.grpc.pb.h"

using json = nlohmann::json;

auto llm = apv2rpc::LlmAdapter::NewStub(grpc::CreateChannel(config::kLlmAdapter, grpc::InsecureChannelCredentials()));
auto tools = apv2rpc::ToolManager::NewStub(grpc::CreateChannel(config::kToolManager, grpc::InsecureChannelCredentials()));

// How a turn ended: answered (with the answer) or escalated to a human.
struct TurnResult {
  std::string status;
  std::string answer;
  int iterations = 0;
};

// One turn of the Chain of Thought loop: reason, run the tool asked for, feed the outcome back, until
// a result. turn: {turn_id, tenant, conversation, actor, role, text}.
TurnResult run_turn(model::ContextStore& store, const json& turn) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const std::string tenant = turn["tenant"], conversation = turn["conversation"], turn_id = turn["turn_id"], text = turn["text"];
  store.append_item(tenant, conversation, {"user", text});
  int iteration = 0;
  while (true) {
    iteration++;
    const auto context = store.assemble(tenant, conversation, turn["actor"], text);
    apv2rpc::ReasonRequest request;
    request.set_turn_id(turn_id);
    request.set_iteration(iteration);
    for (const auto& item : context.history) {
      auto* m = request.add_messages();
      m->set_kind(item.kind);
      m->set_text(item.text);
    }
    grpc::ClientContext reason_ctx;
    apv2rpc::ReasonReply reply;
    const grpc::Status status = llm->Reason(&reason_ctx, request, &reply);
    if (!status.ok()) throw std::runtime_error("reason failed: " + status.error_message());
    if (reply.kind() == "result") {
      store.append_item(tenant, conversation, {"assistant", reply.text()});
      return {"answered", reply.text(), iteration};
    }
    grpc::ClientContext invoke_ctx;
    apv2rpc::InvokeRequest invoke;
    invoke.set_turn_id(turn_id);
    invoke.set_tool(reply.tool());
    invoke.set_args(reply.args());
    apv2rpc::InvokeReply out;
    const grpc::Status invoked = tools->Invoke(&invoke_ctx, invoke, &out);
    if (!invoked.ok()) throw std::runtime_error("tool failed: " + invoked.error_message());
    std::cerr << "turn=" << turn_id << " iteration=" << iteration << " tool=" << reply.tool() << "\\n";
    store.append_item(tenant, conversation, {"tool", out.result()});
  }
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <iostream>
#include <map>
#include <string>
#include <vector>

#include "apv2/config.h"  // config::kLlmAdapter, config::kToolManager — provided
#include "apv2/model.h"   // model::Item, model::ContextStore
#include "support_automation.grpc.pb.h"

using json = nlohmann::json;

constexpr std::chrono::seconds kReasonDeadline{5};
constexpr std::chrono::seconds kToolDeadline{3};
constexpr int kMaxIterations = 6;
const std::string kNotAllowed = R"({"error": "tool not allowed"})";
const std::string kToolFailed = R"({"error": "tool failed"})";

struct ToolSpec {
  std::string mode;  // READ or WRITE
  std::vector<std::string> roles;
};

const std::map<std::string, ToolSpec> kToolRegistry = {
    {"get_reservation", {"READ", {"customer", "agent"}}},
    {"search_help", {"READ", {"customer", "agent"}}},
    {"update_listing", {"WRITE", {"agent"}}},
    {"issue_refund", {"WRITE", {"agent"}}},
};

auto llm = apv2rpc::LlmAdapter::NewStub(grpc::CreateChannel(config::kLlmAdapter, grpc::InsecureChannelCredentials()));
auto tools = apv2rpc::ToolManager::NewStub(grpc::CreateChannel(config::kToolManager, grpc::InsecureChannelCredentials()));

// How a turn ended: answered (with the answer) or escalated to a human.
struct TurnResult {
  std::string status;
  std::string answer;
  int iterations = 0;
};

// The outcome the model sees: the tool's result, or why it did not run.
std::string run_tool(const json& turn, int iteration, const apv2rpc::ReasonReply& reply) {
  const auto it = kToolRegistry.find(reply.tool());
  const std::string role = turn["role"];
  if (it == kToolRegistry.end() || std::none_of(it->second.roles.begin(), it->second.roles.end(), [&](const std::string& r) { return r == role; })) {
    return kNotAllowed;  // the model's choice is a request, not an authorization
  }
  const std::string turn_id = turn["turn_id"];
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kToolDeadline);
  apv2rpc::InvokeRequest invoke;
  invoke.set_turn_id(turn_id);
  invoke.set_tool(reply.tool());
  invoke.set_args(reply.args());
  if (it->second.mode == "WRITE") invoke.set_idempotency_key(turn_id + ":" + std::to_string(iteration));
  apv2rpc::InvokeReply out;
  const grpc::Status status = tools->Invoke(&ctx, invoke, &out);
  if (!status.ok()) {
    std::cerr << "turn=" << turn_id << " iteration=" << iteration << " tool=" << reply.tool() << " failed: " << status.error_message() << "\\n";
    return kToolFailed;
  }
  return out.result();
}

// One turn of the Chain of Thought loop: reason, run the tool asked for, feed the outcome back, until
// a result. turn: {turn_id, tenant, conversation, actor, role, text}.
TurnResult run_turn(model::ContextStore& store, const json& turn) {
  const std::string tenant = turn["tenant"], conversation = turn["conversation"], turn_id = turn["turn_id"], text = turn["text"];
  store.append_item(tenant, conversation, {"user", text});
  for (int iteration = 1; iteration <= kMaxIterations; iteration++) {
    const auto context = store.assemble(tenant, conversation, turn["actor"], text);
    apv2rpc::ReasonRequest request;
    request.set_turn_id(turn_id);
    request.set_iteration(iteration);
    for (const auto& item : context.history) {
      auto* m = request.add_messages();
      m->set_kind(item.kind);
      m->set_text(item.text);
    }
    grpc::ClientContext reason_ctx;
    reason_ctx.set_deadline(std::chrono::system_clock::now() + kReasonDeadline);
    apv2rpc::ReasonReply reply;
    if (!llm->Reason(&reason_ctx, request, &reply).ok()) return {"escalated", "", iteration};
    if (reply.kind() == "result") {
      store.append_item(tenant, conversation, {"assistant", reply.text()});
      return {"answered", reply.text(), iteration};
    }
    const std::string outcome = run_tool(turn, iteration, reply);
    std::cerr << "turn=" << turn_id << " iteration=" << iteration << " tool=" << reply.tool() << "\\n";
    store.append_item(tenant, conversation, {"tool", outcome});
  }
  return {"escalated", "", kMaxIterations};
}
`,
    },
  },
  harness: {
    python: `import json

import grpc

import support_automation_pb2 as pb
import support_automation_pb2_grpc as pb_grpc
from apv2 import config, standins

QUESTION = "Where is my next reservation?"


def _turn(text=QUESTION, role="customer", turn_id="turn-1", actor="guest-1"):
    return {"turn_id": turn_id, "tenant": "t1", "conversation": "c-1", "actor": actor, "role": role, "text": text}


class Retriever(pb_grpc.ContextRetrieverServicer):
    def Retrieve(self, request, context):
        return pb.RetrieveReply(items=standins.retrieve(request.retriever, request.question))


class Llm(pb_grpc.LlmAdapterServicer):
    def Reason(self, request, context):
        return pb.ReasonReply(**standins.reason(request.messages))


class Tools(pb_grpc.ToolManagerServicer):
    """The Tool Manager: runs a registered tool; a repeated idempotency key answers from its ledger."""

    def __init__(self):
        self.ledger = {}
        self.executed = []

    def Invoke(self, request, context):
        if request.idempotency_key and request.idempotency_key in self.ledger:
            return pb.InvokeReply(result=self.ledger[request.idempotency_key])
        result = standins.invoke(request.tool, request.args)
        if result is None:
            context.abort(grpc.StatusCode.NOT_FOUND, f"no tool {request.tool}")
        self.executed.append(request.tool)
        if request.idempotency_key:
            self.ledger[request.idempotency_key] = result
        return pb.InvokeReply(result=result)


def _world(ctx):
    ctx.grpc.serve(pb_grpc.add_ContextRetrieverServicer_to_server, Retriever(), config.RETRIEVER)
    ctx.grpc.serve(pb_grpc.add_LlmAdapterServicer_to_server, Llm(), config.LLM_ADAPTER)
    tools = Tools()
    ctx.grpc.serve(pb_grpc.add_ToolManagerServicer_to_server, tools, config.TOOL_MANAGER)
    store = ctx.load("context_store")
    return ctx.load("cot_workflow"), store, tools


def _items(ctx):
    return [json.loads(raw) for raw in ctx.redis.lrange("ctx:t1:c-1", 0, -1)]


def check_reason_deadline(ctx):
    m, store, _ = _world(ctx)
    result = m.run_turn(store, _turn())
    assert result.get("status") == "answered", f"a plain question must be answered, got {result}"
    assert result.get("answer") == "Your next stay: " + standins.RESERVATION, f"the answer is the model's result, got {result.get('answer')!r}"
    reasons = ctx.grpc.calls_to("Reason")
    assert len(reasons) == 2 and len(ctx.grpc.calls_to("Invoke")) == 1, f"one tool call then the answer: expected 2 Reason calls and 1 Invoke, saw {len(reasons)} and {len(ctx.grpc.calls_to('Invoke'))}"
    assert [i.get("kind") for i in _items(ctx)] == ["user", "tool", "assistant"], f"the conversation's context must hold the question, the tool outcome and the answer, got {[i.get('kind') for i in _items(ctx)]}"
    for call in reasons:
        assert call.timeout is not None, "a Reason call carries no deadline: a stalled model holds the worker for as long as it stalls"
        assert 4.5 <= call.timeout <= 5.5, f"the Reason deadline must be REASON_DEADLINE_S = 5 s, got {call.timeout} s"
    ctx.grpc.set_latency("Reason", 2.0, config.LLM_ADAPTER)
    steady = m.run_turn(store, _turn(turn_id="turn-2"))
    assert steady.get("status") == "answered", f"a model that takes 2 s per call must still answer, got {steady}"
    for call in ctx.grpc.calls_to("Reason")[2:]:
        assert call.timeout is not None and 4.5 <= call.timeout <= 5.5, f"with a model that takes 2 s per call, a later Reason call carried a deadline of {call.timeout} s: each call gets its own REASON_DEADLINE_S = 5 s, not what is left of one shared budget"
    ctx.grpc.set_latency("Reason", 6.0, config.LLM_ADAPTER)
    started = ctx.clock.offset
    slow = m.run_turn(store, _turn(turn_id="turn-3"))
    waited = ctx.clock.offset - started
    assert waited <= 5.5, f"the turn waited {waited:.1f} s on a model that takes 6 s: cut it at the 5 s deadline"
    assert slow.get("status") == "escalated", f"a Reason call that failed its deadline must end the turn escalated, got {slow}"
    ctx.grpc.set_latency("Reason", 0.0, config.LLM_ADAPTER)
    ctx.grpc.fail("Reason", grpc.StatusCode.INTERNAL, "the model adapter crashed")
    try:
        broken = m.run_turn(store, _turn(turn_id="turn-4"))
    except grpc.RpcError as err:
        raise AssertionError(f"a Reason call that failed with INTERNAL escaped run_turn ({err.code()}): any failed Reason ends the turn escalated") from None
    assert broken.get("status") == "escalated", f"a Reason call that failed with INTERNAL must end the turn escalated, got {broken}"


def check_bounded_loop(ctx):
    m, store, _ = _world(ctx)
    result = m.run_turn(store, _turn(text="loop: check every reservation"))
    reasons = len(ctx.grpc.calls_to("Reason"))
    assert reasons == 6, f"a model that asks for a tool on every reply got {reasons} Reason calls: stop at MAX_ITERATIONS = 6, or one turn bills without bound"
    assert result.get("status") == "escalated" and result.get("iterations") == 6, f"a turn that spent its 6 iterations must come back escalated with iterations 6, got {result}"


def check_tool_registry(ctx):
    m, store, tools = _world(ctx)
    result = m.run_turn(store, _turn(text="call:issue_refund for my last stay"))
    assert "issue_refund" not in tools.executed, "a customer turn ran issue_refund because the model asked for it: resolve the tool through TOOL_REGISTRY and the turn's role before any Invoke"
    assert result.get("status") == "answered" and "tool not allowed" in result.get("answer", ""), f"the model must be told {{\\"error\\": \\"tool not allowed\\"}} and answer from it, got {result}"
    m.run_turn(store, _turn(text="call:delete_account now", turn_id="turn-2"))
    m.run_turn(store, _turn(text="call:update_listing to allow pets", turn_id="turn-4"))
    assert [c.request.tool for c in ctx.grpc.calls_to("Invoke")] == [], f"a tool outside the registry, or update_listing (agent-only) on a customer turn, must not reach the Tool Manager, saw Invoke for {[c.request.tool for c in ctx.grpc.calls_to('Invoke')]}"
    agent = m.run_turn(store, _turn(text="call:issue_refund for HM-4410", role="agent", turn_id="turn-3", actor="agent-7"))
    assert tools.executed == ["issue_refund"] and agent.get("status") == "answered", f"an agent turn may run issue_refund, executed {tools.executed}, result {agent}"


def check_tool_deadline(ctx):
    m, store, _ = _world(ctx)
    ctx.grpc.set_latency("Invoke", 5.0, config.TOOL_MANAGER)
    started = ctx.clock.offset
    result = m.run_turn(store, _turn())
    waited = ctx.clock.offset - started
    invokes = ctx.grpc.calls_to("Invoke")
    assert len(invokes) == 1, f"one tool call expected, saw {len(invokes)}"
    assert invokes[0].timeout is not None, "the Invoke call carries no deadline: a stalled tool holds the worker for as long as it stalls"
    assert 2.5 <= invokes[0].timeout <= 3.5, f"the Invoke deadline must be TOOL_DEADLINE_S = 3 s, got {invokes[0].timeout} s"
    assert waited <= 3.5, f"the turn waited {waited:.1f} s on a tool that takes 5 s: cut it at 3 s"
    assert result.get("status") == "answered" and "tool failed" in result.get("answer", ""), f"a tool that failed its deadline is an outcome the model sees ({{\\"error\\": \\"tool failed\\"}}), and the turn goes on; got {result}"
    ctx.grpc.set_latency("Invoke", 2.0, config.TOOL_MANAGER)
    looped = m.run_turn(store, _turn(text="loop: check every reservation", turn_id="turn-2"))
    later = ctx.grpc.calls_to("Invoke")[1:]
    assert len(later) == 6 and looped.get("status") == "escalated", f"a looping model with a tool that takes 2 s must make 6 Invoke calls and escalate, saw {len(later)} calls and {looped}"
    for call in later:
        assert call.timeout is not None and 2.5 <= call.timeout <= 3.5, f"with a tool that takes 2 s per call, a later Invoke carried a deadline of {call.timeout} s: each call gets its own TOOL_DEADLINE_S = 3 s, not what is left of one shared budget"
    ctx.grpc.set_latency("Invoke", 0.0, config.TOOL_MANAGER)
    ctx.grpc.fail("Invoke", grpc.StatusCode.INTERNAL, "the tool crashed")
    try:
        crashed = m.run_turn(store, _turn(turn_id="turn-3"))
    except grpc.RpcError as err:
        raise AssertionError(f"an Invoke that failed with INTERNAL escaped run_turn ({err.code()}): any failed Invoke is the outcome {{\\"error\\": \\"tool failed\\"}}") from None
    assert crashed.get("status") == "answered" and "tool failed" in crashed.get("answer", ""), f"an Invoke that failed with INTERNAL is the outcome {{\\"error\\": \\"tool failed\\"}} the model sees, and the turn goes on; got {crashed}"


def check_write_idempotency(ctx):
    m, store, tools = _world(ctx)
    turn = _turn(text="call:issue_refund for HM-4410", role="agent", turn_id="turn-9", actor="agent-7")
    m.run_turn(store, turn)
    invoke = ctx.grpc.calls_to("Invoke")[0].request
    assert invoke.idempotency_key == "turn-9:1", f"issue_refund is a WRITE tool: it must carry idempotency_key \\"turn-9:1\\" ({{turn_id}}:{{iteration}}), got {invoke.idempotency_key!r}"
    m.run_turn(store, turn)
    refunds = tools.executed.count("issue_refund")
    assert refunds == 1, f"the worker ran the same turn twice (a redelivery) and the Tool Manager executed issue_refund {refunds} times: the key lets it answer the retry from its ledger"
    m.run_turn(store, _turn(turn_id="turn-10"))
    read = ctx.grpc.calls_to("Invoke")[-1].request
    assert read.tool == "get_reservation" and read.idempotency_key == "", f"a READ tool carries no idempotency key, got {read.idempotency_key!r}"
`,
    typescript: `const QUESTION = 'Where is my next reservation?';

const turnOf = ({text = QUESTION, role = 'customer', turn_id = 'turn-1', actor = 'guest-1'} = {}) => ({
  turn_id,
  tenant: 't1',
  conversation: 'c-1',
  actor,
  role,
  text,
});

function world(ctx) {
  const {apv2rpc} = ctx.proto('support_automation.proto');
  const config = ctx.load('/support/apv2/config.ts');
  const standins = ctx.load('/support/apv2/standins.ts');
  ctx.grpc.serve(apv2rpc.ContextRetriever.service, {
    Retrieve(call, callback) {
      callback(null, {items: standins.retrieve(call.request.retriever, call.request.question)});
    },
  }, config.RETRIEVER);
  ctx.grpc.serve(apv2rpc.LlmAdapter.service, {
    Reason(call, callback) {
      callback(null, standins.reason(call.request.messages ?? []));
    },
  }, config.LLM_ADAPTER);
  const tools = {ledger: new Map<string, string>(), executed: [] as string[]};
  ctx.grpc.serve(apv2rpc.ToolManager.service, {
    Invoke(call, callback) {
      const {tool, args, idempotency_key: key} = call.request;
      if (key && tools.ledger.has(key)) return callback(null, {result: tools.ledger.get(key)});
      const result = standins.invoke(tool, args);
      if (result === null) return callback({code: ctx.grpc.status.NOT_FOUND, details: \`no tool \${tool}\`});
      tools.executed.push(tool);
      if (key) tools.ledger.set(key, result);
      callback(null, {result});
    },
  }, config.TOOL_MANAGER);
  const store = ctx.load('context_store');
  return {m: ctx.load('cot_workflow'), store, tools, config, standins};
}

const kinds = (ctx): string[] => ctx.redis.lrange('ctx:t1:c-1', 0, -1).map((raw: string) => JSON.parse(raw).kind);

export async function check_reason_deadline(ctx) {
  const {m, store, config, standins} = world(ctx);
  const result = await m.runTurn(store, turnOf());
  assert.equal(result.status, 'answered', \`a plain question must be answered, got \${JSON.stringify(result)}\`);
  assert.equal(result.answer, 'Your next stay: ' + standins.RESERVATION, \`the answer is the model's result, got \${JSON.stringify(result.answer)}\`);
  const reasons = ctx.grpc.callsTo('Reason');
  assert(reasons.length === 2 && ctx.grpc.callsTo('Invoke').length === 1, \`one tool call then the answer: expected 2 Reason calls and 1 Invoke, saw \${reasons.length} and \${ctx.grpc.callsTo('Invoke').length}\`);
  assert.deepStrictEqual(kinds(ctx), ['user', 'tool', 'assistant'], \`the conversation's context must hold the question, the tool outcome and the answer, got \${JSON.stringify(kinds(ctx))}\`);
  for (const call of reasons) {
    assert(call.timeout !== null, 'a Reason call carries no deadline: a stalled model holds the worker for as long as it stalls');
    assert(call.timeout >= 4.5 && call.timeout <= 5.5, \`the Reason deadline must be REASON_DEADLINE_MS = 5000 ms, got \${call.timeout} s\`);
  }
  ctx.grpc.setLatency('Reason', 2.0, config.LLM_ADAPTER);
  const steady = await m.runTurn(store, turnOf({turn_id: 'turn-2'}));
  assert.equal(steady.status, 'answered', \`a model that takes 2 s per call must still answer, got \${JSON.stringify(steady)}\`);
  for (const call of ctx.grpc.callsTo('Reason').slice(2)) {
    assert(call.timeout !== null && call.timeout >= 4.5 && call.timeout <= 5.5, \`with a model that takes 2 s per call, a later Reason call carried a deadline of \${call.timeout} s: each call gets its own REASON_DEADLINE_MS = 5000 ms, not what is left of one shared budget\`);
  }
  ctx.grpc.setLatency('Reason', 6.0, config.LLM_ADAPTER);
  const started = ctx.clock.now();
  const slow = await m.runTurn(store, turnOf({turn_id: 'turn-3'}));
  const waited = (ctx.clock.now() - started) / 1000;
  assert(waited <= 5.5, \`the turn waited \${waited.toFixed(1)} s on a model that takes 6 s: cut it at the 5 s deadline\`);
  assert.equal(slow.status, 'escalated', \`a Reason call that failed its deadline must end the turn escalated, got \${JSON.stringify(slow)}\`);
  ctx.grpc.setLatency('Reason', 0, config.LLM_ADAPTER);
  ctx.grpc.fail('Reason', ctx.grpc.status.INTERNAL, 'the model adapter crashed');
  let broken;
  try {
    broken = await m.runTurn(store, turnOf({turn_id: 'turn-4'}));
  } catch (e) {
    assert.fail(\`a Reason call that failed with INTERNAL escaped runTurn (\${String(e)}): any failed Reason ends the turn escalated\`);
  }
  assert.equal(broken.status, 'escalated', \`a Reason call that failed with INTERNAL must end the turn escalated, got \${JSON.stringify(broken)}\`);
}

export async function check_bounded_loop(ctx) {
  const {m, store} = world(ctx);
  const result = await m.runTurn(store, turnOf({text: 'loop: check every reservation'}));
  const reasons = ctx.grpc.callsTo('Reason').length;
  assert.equal(reasons, 6, \`a model that asks for a tool on every reply got \${reasons} Reason calls: stop at MAX_ITERATIONS = 6, or one turn bills without bound\`);
  assert(result.status === 'escalated' && result.iterations === 6, \`a turn that spent its 6 iterations must come back escalated with iterations 6, got \${JSON.stringify(result)}\`);
}

export async function check_tool_registry(ctx) {
  const {m, store, tools} = world(ctx);
  let result;
  try {
    result = await m.runTurn(store, turnOf({text: 'call:issue_refund for my last stay'}));
  } catch (e) {
    result = {status: 'failed', answer: String(e)};
  }
  assert(!tools.executed.includes('issue_refund'), 'a customer turn ran issue_refund because the model asked for it: resolve the tool through TOOL_REGISTRY and the turn\\'s role before any Invoke');
  assert(result.status === 'answered' && result.answer.includes('tool not allowed'), \`the model must be told {"error": "tool not allowed"} and answer from it, got \${JSON.stringify(result)}\`);
  await m.runTurn(store, turnOf({text: 'call:delete_account now', turn_id: 'turn-2'}));
  await m.runTurn(store, turnOf({text: 'call:update_listing to allow pets', turn_id: 'turn-4'}));
  const invoked = ctx.grpc.callsTo('Invoke').map(c => c.request.tool);
  assert.deepStrictEqual(invoked, [], \`a tool outside the registry, or update_listing (agent-only) on a customer turn, must not reach the Tool Manager, saw Invoke for \${JSON.stringify(invoked)}\`);
  const agent = await m.runTurn(store, turnOf({text: 'call:issue_refund for HM-4410', role: 'agent', turn_id: 'turn-3', actor: 'agent-7'}));
  assert(tools.executed.length === 1 && tools.executed[0] === 'issue_refund' && agent.status === 'answered', \`an agent turn may run issue_refund, executed \${JSON.stringify(tools.executed)}, result \${JSON.stringify(agent)}\`);
}

export async function check_tool_deadline(ctx) {
  const {m, store, config} = world(ctx);
  ctx.grpc.setLatency('Invoke', 5.0, config.TOOL_MANAGER);
  const started = ctx.clock.now();
  const result = await m.runTurn(store, turnOf());
  const waited = (ctx.clock.now() - started) / 1000;
  const invokes = ctx.grpc.callsTo('Invoke');
  assert.equal(invokes.length, 1, \`one tool call expected, saw \${invokes.length}\`);
  assert(invokes[0].timeout !== null, 'the Invoke call carries no deadline: a stalled tool holds the worker for as long as it stalls');
  assert(invokes[0].timeout >= 2.5 && invokes[0].timeout <= 3.5, \`the Invoke deadline must be TOOL_DEADLINE_MS = 3000 ms, got \${invokes[0].timeout} s\`);
  assert(waited <= 3.5, \`the turn waited \${waited.toFixed(1)} s on a tool that takes 5 s: cut it at 3 s\`);
  assert(result.status === 'answered' && result.answer.includes('tool failed'), \`a tool that failed its deadline is an outcome the model sees ({"error": "tool failed"}), and the turn goes on; got \${JSON.stringify(result)}\`);
  ctx.grpc.setLatency('Invoke', 2.0, config.TOOL_MANAGER);
  const looped = await m.runTurn(store, turnOf({text: 'loop: check every reservation', turn_id: 'turn-2'}));
  const later = ctx.grpc.callsTo('Invoke').slice(1);
  assert(later.length === 6 && looped.status === 'escalated', \`a looping model with a tool that takes 2 s must make 6 Invoke calls and escalate, saw \${later.length} calls and \${JSON.stringify(looped)}\`);
  for (const call of later) {
    assert(call.timeout !== null && call.timeout >= 2.5 && call.timeout <= 3.5, \`with a tool that takes 2 s per call, a later Invoke carried a deadline of \${call.timeout} s: each call gets its own TOOL_DEADLINE_MS = 3000 ms, not what is left of one shared budget\`);
  }
  ctx.grpc.setLatency('Invoke', 0, config.TOOL_MANAGER);
  ctx.grpc.fail('Invoke', ctx.grpc.status.INTERNAL, 'the tool crashed');
  let crashed;
  try {
    crashed = await m.runTurn(store, turnOf({turn_id: 'turn-3'}));
  } catch (e) {
    assert.fail(\`an Invoke that failed with INTERNAL escaped runTurn (\${String(e)}): any failed Invoke is the outcome {"error": "tool failed"}\`);
  }
  assert(crashed.status === 'answered' && crashed.answer.includes('tool failed'), \`an Invoke that failed with INTERNAL is the outcome {"error": "tool failed"} the model sees, and the turn goes on; got \${JSON.stringify(crashed)}\`);
}

export async function check_write_idempotency(ctx) {
  const {m, store, tools} = world(ctx);
  const turn = turnOf({text: 'call:issue_refund for HM-4410', role: 'agent', turn_id: 'turn-9', actor: 'agent-7'});
  await m.runTurn(store, turn);
  const key = ctx.grpc.callsTo('Invoke')[0].request.idempotency_key ?? '';
  assert.equal(key, 'turn-9:1', \`issue_refund is a WRITE tool: it must carry idempotency_key "turn-9:1" ({turn_id}:{iteration}), got \${JSON.stringify(key)}\`);
  await m.runTurn(store, turn);
  const refunds = tools.executed.filter(t => t === 'issue_refund').length;
  assert.equal(refunds, 1, \`the worker ran the same turn twice (a redelivery) and the Tool Manager executed issue_refund \${refunds} times: the key lets it answer the retry from its ledger\`);
  await m.runTurn(store, turnOf({turn_id: 'turn-10'}));
  const read = ctx.grpc.callsTo('Invoke').at(-1).request;
  assert(read.tool === 'get_reservation' && (read.idempotency_key ?? '') === '', \`a READ tool carries no idempotency key, got \${JSON.stringify(read.idempotency_key)}\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"apv2/config"
	pb "apv2/gen/support_automation"
	"apv2/model"
	"apv2/standins"

	"leetbuild/harness"
)

const kHCotQuestion = "Where is my next reservation?"

// cotStore stands in for the step-2 context store over the harness's Redis.
type HCotStore struct{ ctx *harness.Ctx }

func (s HCotStore) AppendItem(_ context.Context, tenant, conversation string, item model.Item) error {
	doc, _ := json.Marshal(item)
	s.ctx.Redis.Do("RPUSH", config.ContextKey(tenant, conversation), string(doc))
	return nil
}

func (s HCotStore) Assemble(_ context.Context, tenant, conversation, _, _ string) (model.Context, error) {
	history := []model.Item{}
	for _, raw := range s.ctx.Redis.LRange(config.ContextKey(tenant, conversation), 0, -1) {
		var item model.Item
		json.Unmarshal([]byte(raw), &item)
		history = append(history, item)
	}
	return model.Context{History: history, Profile: map[string]string{}, Articles: []string{}}, nil
}

type HLlmPeer struct {
	pb.UnimplementedLlmAdapterServer
}

func (HLlmPeer) Reason(_ context.Context, req *pb.ReasonRequest) (*pb.ReasonReply, error) {
	items := []model.Item{}
	for _, m := range req.GetMessages() {
		items = append(items, model.Item{Kind: m.GetKind(), Text: m.GetText()})
	}
	move := standins.Reason(items)
	return &pb.ReasonReply{Kind: move.Kind, Tool: move.Tool, Args: move.Args, Text: move.Text, InputTokens: move.InputTokens, OutputTokens: move.OutputTokens}, nil
}

// toolPeer is the Tool Manager: runs a registered tool; a repeated idempotency key answers from its ledger.
type HToolPeer struct {
	pb.UnimplementedToolManagerServer
	ledger   map[string]string
	executed []string
}

func (t *HToolPeer) Invoke(_ context.Context, req *pb.InvokeRequest) (*pb.InvokeReply, error) {
	if key := req.GetIdempotencyKey(); key != "" {
		if result, ok := t.ledger[key]; ok {
			return &pb.InvokeReply{Result: result}, nil
		}
	}
	result, ok := standins.Invoke(req.GetTool(), req.GetArgs())
	if !ok {
		return nil, status.Error(codes.NotFound, "no tool "+req.GetTool())
	}
	t.executed = append(t.executed, req.GetTool())
	if key := req.GetIdempotencyKey(); key != "" {
		t.ledger[key] = result
	}
	return &pb.InvokeReply{Result: result}, nil
}

func hCotWorld(ctx *harness.Ctx) (HCotStore, *HToolPeer) {
	pb.RegisterLlmAdapterServer(ctx.GRPC.Server(config.LlmAdapter), HLlmPeer{})
	tools := &HToolPeer{ledger: map[string]string{}}
	pb.RegisterToolManagerServer(ctx.GRPC.Server(config.ToolManager), tools)
	return HCotStore{ctx: ctx}, tools
}

func hCotTurn(text, role, turnID, actor string) model.Turn {
	return model.Turn{TurnID: turnID, Tenant: "t1", Conversation: "c-1", Actor: actor, Role: role, Text: text}
}

func hCotRun(ctx *harness.Ctx, store HCotStore, turn model.Turn) TurnResult {
	result, err := runTurn(context.Background(), store, turn)
	ctx.NoError(err, "runTurn(%s)", turn.TurnID)
	return result
}

func hCotKinds(ctx *harness.Ctx) []string {
	out := []string{}
	for _, raw := range ctx.Redis.LRange("ctx:t1:c-1", 0, -1) {
		var item model.Item
		json.Unmarshal([]byte(raw), &item)
		out = append(out, item.Kind)
	}
	return out
}

func hCotCount(list []string, name string) int {
	n := 0
	for _, s := range list {
		if s == name {
			n++
		}
	}
	return n
}

func CheckReasonDeadline(ctx *harness.Ctx) {
	store, _ := hCotWorld(ctx)
	result := hCotRun(ctx, store, hCotTurn(kHCotQuestion, "customer", "turn-1", "guest-1"))
	ctx.Equal(result.Status, "answered", "a plain question must be answered (%+v)", result)
	ctx.Equal(result.Answer, "Your next stay: "+standins.Reservation, "the answer is the model's result")
	reasons := ctx.GRPC.CallsTo("Reason", "")
	ctx.Assert(len(reasons) == 2 && len(ctx.GRPC.CallsTo("Invoke", "")) == 1, "one tool call then the answer: expected 2 Reason calls and 1 Invoke, saw %d and %d", len(reasons), len(ctx.GRPC.CallsTo("Invoke", "")))
	ctx.Equal(hCotKinds(ctx), []string{"user", "tool", "assistant"}, "the conversation's context must hold the question, the tool outcome and the answer")
	for _, call := range reasons {
		ctx.Assert(call.HasDeadline(), "a Reason call carries no deadline: a stalled model holds the worker for as long as it stalls")
		ctx.Assert(call.Timeout >= 4500*time.Millisecond && call.Timeout <= 5500*time.Millisecond, "the Reason deadline must be reasonDeadline = 5 s, got %v", call.Timeout)
	}
	ctx.GRPC.SetLatency("Reason", 2.0, config.LlmAdapter)
	steady := hCotRun(ctx, store, hCotTurn(kHCotQuestion, "customer", "turn-2", "guest-1"))
	ctx.Equal(steady.Status, "answered", "a model that takes 2 s per call must still answer (%+v)", steady)
	for _, call := range ctx.GRPC.CallsTo("Reason", "")[2:] {
		ctx.Assert(call.HasDeadline() && call.Timeout >= 4500*time.Millisecond && call.Timeout <= 5500*time.Millisecond, "with a model that takes 2 s per call, a later Reason call carried a deadline of %v: each call gets its own reasonDeadline = 5 s, not what is left of one shared budget", call.Timeout)
	}
	ctx.GRPC.SetLatency("Reason", 6.0, config.LlmAdapter)
	started := ctx.Clock.Now()
	slow := hCotRun(ctx, store, hCotTurn(kHCotQuestion, "customer", "turn-3", "guest-1"))
	waited := float64(ctx.Clock.Now()-started) / 1000
	ctx.Assert(waited <= 5.5, "the turn waited %.1f s on a model that takes 6 s: cut it at the 5 s deadline", waited)
	ctx.Equal(slow.Status, "escalated", "a Reason call that failed its deadline must end the turn escalated (%+v)", slow)
	ctx.GRPC.SetLatency("Reason", 0, config.LlmAdapter)
	ctx.GRPC.Fail("Reason", codes.Internal, "the model adapter crashed", 1, "")
	broken, err := runTurn(context.Background(), store, hCotTurn(kHCotQuestion, "customer", "turn-4", "guest-1"))
	ctx.Assert(err == nil && broken.Status == "escalated", "a Reason call that failed with Internal must end the turn escalated, not return the error; got %+v (%v)", broken, err)
}

func CheckBoundedLoop(ctx *harness.Ctx) {
	store, _ := hCotWorld(ctx)
	result := hCotRun(ctx, store, hCotTurn("loop: check every reservation", "customer", "turn-1", "guest-1"))
	ctx.Equal(len(ctx.GRPC.CallsTo("Reason", "")), 6, "a model that asks for a tool on every reply: stop at maxIterations = 6, or one turn bills without bound; Reason calls")
	ctx.Assert(result.Status == "escalated" && result.Iterations == 6, "a turn that spent its 6 iterations must come back escalated with Iterations 6, got %+v", result)
}

func CheckToolRegistry(ctx *harness.Ctx) {
	store, tools := hCotWorld(ctx)
	result, err := runTurn(context.Background(), store, hCotTurn("call:issue_refund for my last stay", "customer", "turn-1", "guest-1"))
	ctx.Equal(hCotCount(tools.executed, "issue_refund"), 0, "a customer turn ran issue_refund because the model asked for it: resolve the tool through toolRegistry and the turn's role before any Invoke; refunds executed")
	ctx.Assert(err == nil && result.Status == "answered" && strings.Contains(result.Answer, "tool not allowed"), "the model must be told {\\"error\\": \\"tool not allowed\\"} and answer from it, got %+v (%v)", result, err)
	runTurn(context.Background(), store, hCotTurn("call:delete_account now", "customer", "turn-2", "guest-1"))
	runTurn(context.Background(), store, hCotTurn("call:update_listing to allow pets", "customer", "turn-4", "guest-1"))
	ctx.Equal(len(ctx.GRPC.CallsTo("Invoke", "")), 0, "a tool outside the registry, or update_listing (agent-only) on a customer turn, must not reach the Tool Manager; Invoke calls")
	agent := hCotRun(ctx, store, hCotTurn("call:issue_refund for HM-4410", "agent", "turn-3", "agent-7"))
	ctx.Assert(len(tools.executed) == 1 && tools.executed[0] == "issue_refund" && agent.Status == "answered", "an agent turn may run issue_refund, executed %v, result %+v", tools.executed, agent)
}

func CheckToolDeadline(ctx *harness.Ctx) {
	store, _ := hCotWorld(ctx)
	ctx.GRPC.SetLatency("Invoke", 5.0, config.ToolManager)
	started := ctx.Clock.Now()
	result, err := runTurn(context.Background(), store, hCotTurn(kHCotQuestion, "customer", "turn-1", "guest-1"))
	waited := float64(ctx.Clock.Now()-started) / 1000
	invokes := ctx.GRPC.CallsTo("Invoke", "")
	ctx.Equal(len(invokes), 1, "one tool call expected; Invoke calls")
	ctx.Assert(invokes[0].HasDeadline(), "the Invoke call carries no deadline: a stalled tool holds the worker for as long as it stalls")
	ctx.Assert(invokes[0].Timeout >= 2500*time.Millisecond && invokes[0].Timeout <= 3500*time.Millisecond, "the Invoke deadline must be toolDeadline = 3 s, got %v", invokes[0].Timeout)
	ctx.Assert(waited <= 3.5, "the turn waited %.1f s on a tool that takes 5 s: cut it at 3 s", waited)
	ctx.Assert(err == nil && result.Status == "answered" && strings.Contains(result.Answer, "tool failed"), "a tool that failed its deadline is an outcome the model sees ({\\"error\\": \\"tool failed\\"}), and the turn goes on; got %+v (%v)", result, err)
	ctx.GRPC.SetLatency("Invoke", 2.0, config.ToolManager)
	looped, err := runTurn(context.Background(), store, hCotTurn("loop: check every reservation", "customer", "turn-2", "guest-1"))
	later := ctx.GRPC.CallsTo("Invoke", "")[1:]
	ctx.Assert(err == nil && len(later) == 6 && looped.Status == "escalated", "a looping model with a tool that takes 2 s must make 6 Invoke calls and escalate, saw %d calls and %+v (%v)", len(later), looped, err)
	for _, call := range later {
		ctx.Assert(call.HasDeadline() && call.Timeout >= 2500*time.Millisecond && call.Timeout <= 3500*time.Millisecond, "with a tool that takes 2 s per call, a later Invoke carried a deadline of %v: each call gets its own toolDeadline = 3 s, not what is left of one shared budget", call.Timeout)
	}
	ctx.GRPC.SetLatency("Invoke", 0, config.ToolManager)
	ctx.GRPC.Fail("Invoke", codes.Internal, "the tool crashed", 1, "")
	crashed, err := runTurn(context.Background(), store, hCotTurn(kHCotQuestion, "customer", "turn-3", "guest-1"))
	ctx.Assert(err == nil && crashed.Status == "answered" && strings.Contains(crashed.Answer, "tool failed"), "an Invoke that failed with Internal is the outcome {\\"error\\": \\"tool failed\\"} the model sees, and the turn goes on; got %+v (%v)", crashed, err)
}

func CheckWriteIdempotency(ctx *harness.Ctx) {
	store, tools := hCotWorld(ctx)
	turn := hCotTurn("call:issue_refund for HM-4410", "agent", "turn-9", "agent-7")
	hCotRun(ctx, store, turn)
	first := ctx.GRPC.CallsTo("Invoke", "")[0].Request.(*pb.InvokeRequest)
	ctx.Equal(first.GetIdempotencyKey(), "turn-9:1", "issue_refund is a WRITE tool: it must carry idempotency key {turn_id}:{iteration}")
	hCotRun(ctx, store, turn)
	ctx.Equal(hCotCount(tools.executed, "issue_refund"), 1, "the worker ran the same turn twice (a redelivery): the key lets the Tool Manager answer the retry from its ledger; refunds executed")
	hCotRun(ctx, store, hCotTurn(kHCotQuestion, "customer", "turn-10", "guest-1"))
	invokes := ctx.GRPC.CallsTo("Invoke", "")
	read := invokes[len(invokes)-1].Request.(*pb.InvokeRequest)
	ctx.Assert(read.GetTool() == "get_reservation" && read.GetIdempotencyKey() == "", "a READ tool carries no idempotency key, got %q", read.GetIdempotencyKey())
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <map>
#include <string>
#include <vector>

#include "apv2/standins.h"

namespace {

using json = nlohmann::json;

const std::string kHCotQuestion = "Where is my next reservation?";

// Stands in for the step-2 context store over the harness's Redis.
class HCotStore final : public model::ContextStore {
 public:
  explicit HCotStore(harness::Ctx& ctx) : ctx_(ctx) {}
  void append_item(const std::string& tenant, const std::string& conversation, const model::Item& item) override {
    ctx_.Redis.Do("RPUSH", config::context_key(tenant, conversation), json{{"kind", item.kind}, {"text", item.text}}.dump());
  }
  model::Context assemble(const std::string& tenant, const std::string& conversation, const std::string&, const std::string&) override {
    model::Context out;
    for (const auto& raw : ctx_.Redis.LRange(config::context_key(tenant, conversation), 0, -1)) {
      const json item = json::parse(raw, nullptr, false);
      out.history.push_back({item.value("kind", ""), item.value("text", "")});
    }
    return out;
  }

 private:
  harness::Ctx& ctx_;
};

class HLlmPeer final : public apv2rpc::LlmAdapter::Service {
 public:
  grpc::Status Reason(grpc::ServerContext*, const apv2rpc::ReasonRequest* req, apv2rpc::ReasonReply* reply) override {
    std::vector<model::Item> items;
    for (const auto& m : req->messages()) items.push_back({m.kind(), m.text()});
    const auto move = standins::reason(items);
    reply->set_kind(move.kind);
    reply->set_tool(move.tool);
    reply->set_args(move.args);
    reply->set_text(move.text);
    reply->set_input_tokens(move.input_tokens);
    reply->set_output_tokens(move.output_tokens);
    return grpc::Status::OK;
  }
};

// The Tool Manager: runs a registered tool; a repeated idempotency key answers from its ledger.
class HToolPeer final : public apv2rpc::ToolManager::Service {
 public:
  std::map<std::string, std::string> ledger;
  std::vector<std::string> executed;
  grpc::Status Invoke(grpc::ServerContext*, const apv2rpc::InvokeRequest* req, apv2rpc::InvokeReply* reply) override {
    const std::string key = req->idempotency_key();
    if (!key.empty() && ledger.count(key) == 1) {
      reply->set_result(ledger[key]);
      return grpc::Status::OK;
    }
    const auto result = standins::invoke(req->tool(), req->args());
    if (!result) return grpc::Status(grpc::StatusCode::NOT_FOUND, "no tool " + req->tool());
    executed.push_back(req->tool());
    if (!key.empty()) ledger[key] = *result;
    reply->set_result(*result);
    return grpc::Status::OK;
  }
};

struct HCotWorld {
  HLlmPeer llm;
  HToolPeer tools;
  HCotStore store;
  explicit HCotWorld(harness::Ctx& ctx) : store(ctx) {}
};

HCotWorld& hCotWorld(harness::Ctx& ctx) {
  static HCotWorld* world = nullptr;
  delete world;
  world = new HCotWorld(ctx);
  ctx.GRPC.Server(config::kLlmAdapter)->RegisterService(&world->llm);
  ctx.GRPC.Server(config::kToolManager)->RegisterService(&world->tools);
  return *world;
}

json hCotTurn(const std::string& text, const std::string& role = "customer", const std::string& turn_id = "turn-1", const std::string& actor = "guest-1") {
  return {{"turn_id", turn_id}, {"tenant", "t1"}, {"conversation", "c-1"}, {"actor", actor}, {"role", role}, {"text", text}};
}

std::vector<std::string> hCotKinds(harness::Ctx& ctx) {
  std::vector<std::string> out;
  for (const auto& raw : ctx.Redis.LRange("ctx:t1:c-1", 0, -1)) out.push_back(json::parse(raw, nullptr, false).value("kind", ""));
  return out;
}

TurnResult hCotRun(harness::Ctx& ctx, HCotWorld& w, const json& turn) {
  try {
    return run_turn(w.store, turn);
  } catch (const std::exception& e) {
    ctx.Fatalf("run_turn(%s) threw: %s", turn["turn_id"].get<std::string>(), e.what());
  }
  return {};
}

}  // namespace

void CheckReasonDeadline(harness::Ctx& ctx) {
  auto& w = hCotWorld(ctx);
  const TurnResult result = hCotRun(ctx, w, hCotTurn(kHCotQuestion));
  ctx.Equal(result.status, "answered", "a plain question must be answered (answer %q)", result.answer);
  ctx.Equal(result.answer, "Your next stay: " + standins::kReservation, "the answer is the model's result");
  const auto reasons = ctx.GRPC.CallsTo("Reason");
  ctx.Assert(reasons.size() == 2 && ctx.GRPC.CallsTo("Invoke").size() == 1, "one tool call then the answer: expected 2 Reason calls and 1 Invoke, saw %d and %d", reasons.size(), ctx.GRPC.CallsTo("Invoke").size());
  ctx.Equal(hCotKinds(ctx), std::vector<std::string>{"user", "tool", "assistant"}, "the conversation's context must hold the question, the tool outcome and the answer");
  for (const auto& call : reasons) {
    ctx.Assert(call.HasDeadline(), "a Reason call carries no deadline: a stalled model holds the worker for as long as it stalls");
    ctx.Assert(call.TimeoutSeconds() >= 4.5 && call.TimeoutSeconds() <= 5.5, "the Reason deadline must be kReasonDeadline = 5 s, got %vs", call.TimeoutSeconds());
  }
  ctx.GRPC.SetLatency("Reason", 2.0, config::kLlmAdapter);
  const TurnResult steady = hCotRun(ctx, w, hCotTurn(kHCotQuestion, "customer", "turn-2"));
  ctx.Equal(steady.status, "answered", "a model that takes 2 s per call must still answer");
  const auto later = ctx.GRPC.CallsTo("Reason");
  for (size_t i = 2; i < later.size(); i++) {
    ctx.Assert(later[i].HasDeadline() && later[i].TimeoutSeconds() >= 4.5 && later[i].TimeoutSeconds() <= 5.5,
               "with a model that takes 2 s per call, a later Reason call carried a deadline of %vs: each call gets its own kReasonDeadline = 5 s, not what is left of one shared budget", later[i].TimeoutSeconds());
  }
  ctx.GRPC.SetLatency("Reason", 6.0, config::kLlmAdapter);
  const int64_t started = ctx.Clock.Now();
  const TurnResult slow = hCotRun(ctx, w, hCotTurn(kHCotQuestion, "customer", "turn-3"));
  const double waited = static_cast<double>(ctx.Clock.Now() - started) / 1000;
  ctx.Assert(waited <= 5.5, "the turn waited %.1f s on a model that takes 6 s: cut it at the 5 s deadline", waited);
  ctx.Equal(slow.status, "escalated", "a Reason call that failed its deadline must end the turn escalated");
  ctx.GRPC.SetLatency("Reason", 0, config::kLlmAdapter);
  ctx.GRPC.Fail("Reason", grpc::StatusCode::INTERNAL, "the model adapter crashed");
  const TurnResult broken = hCotRun(ctx, w, hCotTurn(kHCotQuestion, "customer", "turn-4"));
  ctx.Equal(broken.status, "escalated", "a Reason call that failed with INTERNAL must end the turn escalated");
}

void CheckBoundedLoop(harness::Ctx& ctx) {
  auto& w = hCotWorld(ctx);
  const TurnResult result = hCotRun(ctx, w, hCotTurn("loop: check every reservation"));
  ctx.Equal(ctx.GRPC.CallsTo("Reason").size(), 6, "a model that asks for a tool on every reply: stop at kMaxIterations = 6, or one turn bills without bound; Reason calls");
  ctx.Assert(result.status == "escalated" && result.iterations == 6, "a turn that spent its 6 iterations must come back escalated with iterations 6, got %s after %d", result.status, result.iterations);
}

void CheckToolRegistry(harness::Ctx& ctx) {
  auto& w = hCotWorld(ctx);
  TurnResult result;
  std::string error;
  try {
    result = run_turn(w.store, hCotTurn("call:issue_refund for my last stay"));
  } catch (const std::exception& e) {
    error = e.what();
  }
  ctx.Equal(std::count(w.tools.executed.begin(), w.tools.executed.end(), "issue_refund"), 0,
            "a customer turn ran issue_refund because the model asked for it: resolve the tool through kToolRegistry and the turn's role before any Invoke; refunds executed");
  ctx.Assert(error.empty() && result.status == "answered" && result.answer.find("tool not allowed") != std::string::npos,
             "the model must be told {\\"error\\": \\"tool not allowed\\"} and answer from it, got %s %q %s", result.status, result.answer, error);
  try {
    run_turn(w.store, hCotTurn("call:delete_account now", "customer", "turn-2"));
    run_turn(w.store, hCotTurn("call:update_listing to allow pets", "customer", "turn-4"));
  } catch (const std::exception&) {
  }
  ctx.Equal(ctx.GRPC.CallsTo("Invoke").size(), 0, "a tool outside the registry, or update_listing (agent-only) on a customer turn, must not reach the Tool Manager; Invoke calls");
  const TurnResult agent = hCotRun(ctx, w, hCotTurn("call:issue_refund for HM-4410", "agent", "turn-3", "agent-7"));
  ctx.Assert(w.tools.executed == std::vector<std::string>{"issue_refund"} && agent.status == "answered", "an agent turn may run issue_refund, executed %v, status %s", w.tools.executed, agent.status);
}

void CheckToolDeadline(harness::Ctx& ctx) {
  auto& w = hCotWorld(ctx);
  ctx.GRPC.SetLatency("Invoke", 5.0, config::kToolManager);
  const int64_t started = ctx.Clock.Now();
  const TurnResult result = hCotRun(ctx, w, hCotTurn(kHCotQuestion));
  const double waited = static_cast<double>(ctx.Clock.Now() - started) / 1000;
  const auto invokes = ctx.GRPC.CallsTo("Invoke");
  ctx.Equal(invokes.size(), 1, "one tool call expected; Invoke calls");
  ctx.Assert(invokes[0].HasDeadline(), "the Invoke call carries no deadline: a stalled tool holds the worker for as long as it stalls");
  ctx.Assert(invokes[0].TimeoutSeconds() >= 2.5 && invokes[0].TimeoutSeconds() <= 3.5, "the Invoke deadline must be kToolDeadline = 3 s, got %vs", invokes[0].TimeoutSeconds());
  ctx.Assert(waited <= 3.5, "the turn waited %.1f s on a tool that takes 5 s: cut it at 3 s", waited);
  ctx.Assert(result.status == "answered" && result.answer.find("tool failed") != std::string::npos,
             "a tool that failed its deadline is an outcome the model sees ({\\"error\\": \\"tool failed\\"}), and the turn goes on; got %s %q", result.status, result.answer);
  ctx.GRPC.SetLatency("Invoke", 2.0, config::kToolManager);
  const TurnResult looped = hCotRun(ctx, w, hCotTurn("loop: check every reservation", "customer", "turn-2"));
  const auto all = ctx.GRPC.CallsTo("Invoke");
  ctx.Assert(all.size() == 7 && looped.status == "escalated", "a looping model with a tool that takes 2 s must make 6 Invoke calls and escalate, saw %d calls and %s", all.size() - 1, looped.status);
  for (size_t i = 1; i < all.size(); i++) {
    ctx.Assert(all[i].HasDeadline() && all[i].TimeoutSeconds() >= 2.5 && all[i].TimeoutSeconds() <= 3.5,
               "with a tool that takes 2 s per call, a later Invoke carried a deadline of %vs: each call gets its own kToolDeadline = 3 s, not what is left of one shared budget", all[i].TimeoutSeconds());
  }
  ctx.GRPC.SetLatency("Invoke", 0, config::kToolManager);
  ctx.GRPC.Fail("Invoke", grpc::StatusCode::INTERNAL, "the tool crashed");
  const TurnResult crashed = hCotRun(ctx, w, hCotTurn(kHCotQuestion, "customer", "turn-3"));
  ctx.Assert(crashed.status == "answered" && crashed.answer.find("tool failed") != std::string::npos,
             "an Invoke that failed with INTERNAL is the outcome {\\"error\\": \\"tool failed\\"} the model sees, and the turn goes on; got %s %q", crashed.status, crashed.answer);
}

void CheckWriteIdempotency(harness::Ctx& ctx) {
  auto& w = hCotWorld(ctx);
  const json turn = hCotTurn("call:issue_refund for HM-4410", "agent", "turn-9", "agent-7");
  hCotRun(ctx, w, turn);
  const auto first = ctx.GRPC.CallsTo("Invoke")[0].Request<apv2rpc::InvokeRequest>();
  ctx.Equal(first.idempotency_key(), "turn-9:1", "issue_refund is a WRITE tool: it must carry idempotency key {turn_id}:{iteration}");
  hCotRun(ctx, w, turn);
  ctx.Equal(std::count(w.tools.executed.begin(), w.tools.executed.end(), "issue_refund"), 1,
            "the worker ran the same turn twice (a redelivery): the key lets the Tool Manager answer the retry from its ledger; refunds executed");
  hCotRun(ctx, w, hCotTurn(kHCotQuestion, "customer", "turn-10"));
  const auto read = ctx.GRPC.CallsTo("Invoke").back().Request<apv2rpc::InvokeRequest>();
  ctx.Assert(read.tool() == "get_reservation" && read.idempotency_key().empty(), "a READ tool carries no idempotency key, got %q", read.idempotency_key());
}
`,
  },
  hints: [
    "Symptom: one question bills a dozen model calls, a stalled model or tool parks a worker indefinitely, a guest's turn issues a refund because a help article told the model to, and a redelivered turn refunds twice.",
    'Mechanism: `while True` has no budget; Reason and Invoke carry no deadline; the tool name goes from the model straight into `InvokeRequest`; and no `idempotency_key` lets the Tool Manager recognise a retried write.',
    'Change: `for iteration in range(1, MAX_ITERATIONS + 1)` ending `escalated`; `timeout=REASON_DEADLINE_S` / `TOOL_DEADLINE_S` with `RpcError` handled; look up `TOOL_REGISTRY[name]` and the turn\'s role first; key WRITE tools `f"{turn_id}:{iteration}"`.',
  ],
  debrief: `The loop is a budget and a boundary. The iteration cap and the two deadlines bound what one turn can cost in money and in worker time, and a failure becomes either an outcome the model can reason about (a tool that failed) or a handoff (a model that did not answer). The registry turns the model's tool choice into a request the platform authorizes against the verified role from step 1, which is what keeps a prompt injection from becoming a refund. The key \`{turn_id}:{iteration}\` is stable across a redelivery of the same turn, so the Tool Manager can answer the retry from its ledger. Production loops also cap tokens per turn, rate-limit per tool, and run tool guardrails on arguments before the call.`,
};
