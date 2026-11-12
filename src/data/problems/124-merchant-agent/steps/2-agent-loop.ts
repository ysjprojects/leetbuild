import type {Step} from '@/lib/types';

export const agentLoopStep: Step = {
  id: 'agent-loop',
  title: 'The agentic loop: just-in-time instructions, bounded turns',
  concept: 'grpc',
  guides: ['deadlines-and-retries', 'model-output'],
  file: 'agent_loop',
  focus: ['api', 'model', 'tools'],
  task: `## Task

**Starting point.** The starter is \`run_agent(shop, scopes, message, page, turn_id)\`, the loop behind
every assist turn. It appends every catalog tool's \`instructions\` to \`SYSTEM_PROMPT\` and to each
tool's description, then loops with \`while True\`: \`reserve\` (step 3), \`Model.Complete\` with no
deadline, and \`invoke_tool\` (step 3) for whatever tool the model names, until the model answers in
text. It serves the demo and hides 5 flaws.

**Failure mode the checks target.** The prompt grows with every tool and conflicts with itself, so
the model picks the wrong tool. One confused conversation holds a worker for as long as the model
keeps asking for tools, a slow model holds it longer, and a read-only staff account fills a product
form because the loop invokes any tool the model names.

- Every \`Complete\` carries \`system_prompt = SYSTEM_PROMPT\` and the catalog's names with their
  one-line descriptions.
- Just in time: after a tool runs, its \`instructions\` travel in the next \`Complete\` only.
- At most \`MAX_TURNS = 6\` calls (status \`turn_limit\`); each call has a deadline of at most
  \`MODEL_DEADLINE_S = 10\` and the loop a budget of \`LOOP_BUDGET_S = 30\` (status \`deadline\`).
- A tool missing from the catalog, or whose \`required_scope\` is not in \`scopes\`, is not invoked: the
  loop answers the model with a \`PERMISSION_DENIED\` tool message.`,
  sequence: {
    participants: ['agent loop', 'budget (step 3)', 'Model', 'Tools (step 3)'],
    messages: [
      {from: 'agent loop', to: 'budget (step 3)', label: 'reserve(shop, TOKENS_PER_CALL)', kind: 'sync'},
      {
        from: 'agent loop',
        to: 'Model',
        label: 'Complete(SYSTEM_PROMPT, tools[name, description]) · ≤ 10 s',
        kind: 'sync',
      },
      {from: 'Model', to: 'agent loop', label: 'tool_call segment_customers', kind: 'reply'},
      {from: 'agent loop', to: 'agent loop', label: 'read_customers ∈ scopes?', kind: 'sync'},
      {from: 'agent loop', to: 'Tools (step 3)', label: 'invoke_tool(shop, turn_id, name, args)', kind: 'sync'},
      {from: 'agent loop', to: 'Model', label: 'Complete(… + tool result, instructions = its guidance)', kind: 'sync'},
      {from: 'Model', to: 'agent loop', label: 'text → Outcome(reply, tools_used, done)', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'compact-prompt',
      title: 'Sends the constant system prompt and a compact tool list',
      detail:
        "Every Complete carries the same system prompt with no tool's instructions in it, and a tool list of the catalog's names with their one-line descriptions. The starter puts every tool's guidance in both.",
      match: {
        python: {all: [/system_prompt\s*=\s*SYSTEM_PROMPT\b/, /description\s*=\s*\w+\.description\s*\)/]},
        typescript: {all: [/system_prompt:\s*SYSTEM_PROMPT\b/, /description:\s*\w+\.description\s*[,}]/]},
        go: {all: [/SystemPrompt:\s*systemPrompt\b/, /Description:\s*\w+\.Description\s*[,}]/]},
        scala: {all: [/systemPrompt\s*=\s*SystemPrompt\b/, /description\s*=\s*\w+\.description\s*\)/]},
        cpp: {all: [/set_system_prompt\(\s*kSystemPrompt\s*\)/, /set_description\(\s*\w+\.description\s*\)/]},
      },
    },
    {
      id: 'jit-instructions',
      title: "Sends a tool's instructions in the call after it ran",
      detail:
        'The first call carries no instructions; the call after `segment_customers` ran carries exactly its instructions; a refused tool sends none. The starter never fills `instructions`.',
      match: {
        python: {all: [/instructions\s*=\s*\w+\.instructions/, /instructions\s*=\s*instructions\b/]},
        typescript: {all: [/instructions\s*=\s*\w+\.instructions/]},
        go: {all: [/instructions\s*=\s*\w+\.Instructions/, /Instructions:\s*instructions\b/]},
        scala: {all: [/instructions\s*=\s*\w+\.instructions/]},
        cpp: {all: [/set_instructions\(\s*\w+(->|\.)instructions\s*\)/]},
      },
    },
    {
      id: 'turn-limit',
      title: 'Stops after six model calls',
      detail:
        'A model that asks for a tool on every turn gets exactly 6 Complete calls and the outcome says `turn_limit`. The starter loops until the model gives up.',
      match: {
        python: {all: [/MAX_TURNS\s*=\s*6\b/, /range\(\s*MAX_TURNS\s*\)/], none: [/while\s+True/]},
        typescript: {
          all: [/MAX_TURNS\s*=\s*6\b/, /<\s*MAX_TURNS\b/],
          none: [/while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\)/],
        },
        go: {all: [/maxTurns\s*=\s*6\b/, /<\s*maxTurns\b/], none: [/\bfor\s*\{/]},
        scala: {all: [/MaxTurns\s*=\s*6\b/, /<\s*MaxTurns\b/], none: [/while\s*\(\s*true\s*\)/]},
        cpp: {all: [/kMaxTurns\s*=\s*6\b/, /<\s*kMaxTurns\b/], none: [/while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\)/]},
      },
    },
    {
      id: 'call-deadline',
      title: 'A deadline on every model call and a 30 s budget for the loop',
      detail:
        'Every Complete carries a deadline of at most 10 s: a model that hangs ends the turn after 10 s with status `deadline`, and a model that takes 8 s per call ends the loop at 30 s. The starter waits as long as the model takes.',
      match: {
        python: {all: [/timeout\s*=/, /LOOP_BUDGET_S/, /DEADLINE_EXCEEDED/]},
        typescript: {all: [/deadline:/, /LOOP_BUDGET_MS/, /DEADLINE_EXCEEDED/]},
        go: {all: [/context\.With(Timeout|Deadline)\(/, /loopBudget/, /codes\.DeadlineExceeded/]},
        scala: {all: [/withDeadlineAfter\(/, /LoopBudgetMs/, /DEADLINE_EXCEEDED/]},
        cpp: {all: [/set_deadline\(/, /kLoopBudget/, /DEADLINE_EXCEEDED/]},
      },
    },
    {
      id: 'scope-gate',
      title: 'Invokes only catalog tools the merchant holds the scope for',
      detail:
        'With scopes `[read_customers]`, a `fill_product_form` call and an unknown `delete_shop` call reach no tool; the model gets a `PERMISSION_DENIED` tool message and `tools_used` stays empty. The starter invokes whatever the model names.',
      match: {
        python: {all: [/PERMISSION_DENIED/], order: [/required_scope\s+(not\s+)?in\s+scopes/, /=\s*invoke_tool\(/]},
        typescript: {
          all: [/PERMISSION_DENIED/],
          order: [/scopes\.includes\(\s*\w+\.required_scope\s*\)/, /await invokeTool\(/],
        },
        go: {all: [/catalog\.PermissionDenied/], order: [/\.RequiredScope/, /=\s*invokeTool\(/]},
        scala: {all: [/Catalog\.PermissionDenied/], order: [/\.requiredScope/, /BudgetCache\.invokeTool\(/]},
        cpp: {all: [/catalog::kPermissionDenied/], order: [/->required_scope/, /=\s*invoke_tool\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import merchant_agent_pb2
import merchant_agent_pb2_grpc
from budget_cache import invoke_tool, reserve  # step 3: the shop's budget, and its tools behind a cache
from sidekick.catalog import CATALOG
from sidekick.config import MODEL_ADDR, TOKENS_PER_CALL
from sidekick.outcome import Outcome

SYSTEM_PROMPT = (
    "You are Sidekick, the assistant inside a Shopify admin. Answer the merchant's question about their own "
    "shop, call a tool when the answer needs the shop's data, and say so when you cannot help."
)

model = merchant_agent_pb2_grpc.ModelStub(grpc.insecure_channel(MODEL_ADDR))


def run_agent(shop: str, scopes: list[str], message: str, page: str, turn_id: str) -> Outcome:
    """One assist turn: the model and the merchant's tools in a loop."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    system = SYSTEM_PROMPT + "\\n\\nTools:\\n" + "\\n".join(f"{t.name}: {t.instructions}" for t in CATALOG.values())
    tools = [merchant_agent_pb2.ToolSpec(name=t.name, description=f"{t.description} {t.instructions}") for t in CATALOG.values()]
    messages = [merchant_agent_pb2.Message(role="user", content=message)]
    used: list[str] = []
    while True:
        if not reserve(shop, TOKENS_PER_CALL):
            return Outcome("Sidekick is busy for this shop; try again in a minute.", used, "over_budget")
        reply = model.Complete(
            merchant_agent_pb2.CompleteRequest(shop=shop, page=page, system_prompt=system, tools=tools, messages=messages)
        )
        call = reply.tool_call
        if call.name == "":
            return Outcome(reply.text, used, "done")
        messages.append(merchant_agent_pb2.Message(role="assistant", content=call.args_json, tool_name=call.name))
        result = invoke_tool(shop, turn_id, call.name, call.args_json)
        used.append(call.name)
        messages.append(merchant_agent_pb2.Message(role="tool", content=result, tool_name=call.name))
`,
      solution: `import time

import grpc

import merchant_agent_pb2
import merchant_agent_pb2_grpc
from budget_cache import invoke_tool, reserve  # step 3: the shop's budget, and its tools behind a cache
from sidekick.catalog import CATALOG, PERMISSION_DENIED
from sidekick.config import MODEL_ADDR, TOKENS_PER_CALL
from sidekick.outcome import Outcome

SYSTEM_PROMPT = (
    "You are Sidekick, the assistant inside a Shopify admin. Answer the merchant's question about their own "
    "shop, call a tool when the answer needs the shop's data, and say so when you cannot help."
)
MAX_TURNS = 6
MODEL_DEADLINE_S = 10.0
LOOP_BUDGET_S = 30.0

model = merchant_agent_pb2_grpc.ModelStub(grpc.insecure_channel(MODEL_ADDR))
TOOL_LIST = [merchant_agent_pb2.ToolSpec(name=t.name, description=t.description) for t in CATALOG.values()]


def run_agent(shop: str, scopes: list[str], message: str, page: str, turn_id: str) -> Outcome:
    """One assist turn: the model and the merchant's tools in a bounded loop."""
    messages = [merchant_agent_pb2.Message(role="user", content=message)]
    instructions = ""  # the guidance of the tool that ran last turn, sent once
    used: list[str] = []
    deadline = time.time() + LOOP_BUDGET_S
    for _ in range(MAX_TURNS):
        remaining = deadline - time.time()
        if remaining <= 0:
            return Outcome("This is taking too long; here is what I have so far.", used, "deadline")
        if not reserve(shop, TOKENS_PER_CALL):
            return Outcome("Sidekick is busy for this shop; try again in a minute.", used, "over_budget")
        request = merchant_agent_pb2.CompleteRequest(
            shop=shop, page=page, system_prompt=SYSTEM_PROMPT, tools=TOOL_LIST, messages=messages, instructions=instructions
        )
        try:
            reply = model.Complete(request, timeout=min(MODEL_DEADLINE_S, remaining))
        except grpc.RpcError as err:
            if err.code() == grpc.StatusCode.DEADLINE_EXCEEDED:
                return Outcome("This is taking too long; here is what I have so far.", used, "deadline")
            raise
        call = reply.tool_call
        if call.name == "":
            return Outcome(reply.text, used, "done")
        messages.append(merchant_agent_pb2.Message(role="assistant", content=call.args_json, tool_name=call.name))
        tool = CATALOG.get(call.name)
        if tool is None or tool.required_scope not in scopes:
            messages.append(merchant_agent_pb2.Message(role="tool", content=PERMISSION_DENIED, tool_name=call.name))
            instructions = ""
            continue
        result = invoke_tool(shop, turn_id, call.name, call.args_json)
        used.append(call.name)
        messages.append(merchant_agent_pb2.Message(role="tool", content=result, tool_name=call.name))
        instructions = tool.instructions
    return Outcome("I stopped after six steps; here is what I have so far.", used, "turn_limit")
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {CATALOG} from 'sidekick/catalog';
import {MODEL_ADDR, TOKENS_PER_CALL} from 'sidekick/config';
import type {Outcome} from 'sidekick/outcome';

import {invokeTool, reserve} from './budget_cache'; // step 3: the shop's budget, and its tools behind a cache

export const SYSTEM_PROMPT =
  "You are Sidekick, the assistant inside a Shopify admin. Answer the merchant's question about their own " +
  "shop, call a tool when the answer needs the shop's data, and say so when you cannot help.";

interface Message {
  role: string;
  content: string;
  tool_name?: string;
}
interface CompleteRequest {
  shop: string;
  page: string;
  system_prompt: string;
  tools: {name: string; description: string}[];
  messages: Message[];
  instructions?: string;
}
interface CompleteReply {
  text: string;
  tool_call?: {name: string; args_json: string} | null;
}
interface ModelClient {
  Complete(request: CompleteRequest, options?: {deadline: number}): Promise<CompleteReply>;
}

const {sidekickrpc} = grpc.loadPackageDefinition(protoLoader.loadSync('merchant_agent.proto')) as unknown as {
  sidekickrpc: {Model: new (target: string, credentials: grpc.ChannelCredentials) => ModelClient};
};
const model = new sidekickrpc.Model(MODEL_ADDR, grpc.credentials.createInsecure());

/** One assist turn: the model and the merchant's tools in a loop. */
export async function runAgent(shop: string, scopes: string[], message: string, page: string, turnId: string): Promise<Outcome> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const system = SYSTEM_PROMPT + '\\n\\nTools:\\n' + Object.values(CATALOG).map(t => t.name + ': ' + t.instructions).join('\\n');
  const tools = Object.values(CATALOG).map(t => ({name: t.name, description: t.description + ' ' + t.instructions}));
  const messages: Message[] = [{role: 'user', content: message}];
  const used: string[] = [];
  while (true) {
    if (!(await reserve(shop, TOKENS_PER_CALL))) return {reply: 'Sidekick is busy for this shop; try again in a minute.', tools_used: used, status: 'over_budget'};
    const reply = await model.Complete({shop, page, system_prompt: system, tools, messages: [...messages]});
    const call = reply.tool_call;
    if (!call || call.name === '') return {reply: reply.text, tools_used: used, status: 'done'};
    messages.push({role: 'assistant', content: call.args_json, tool_name: call.name});
    const result = await invokeTool(shop, turnId, call.name, call.args_json);
    used.push(call.name);
    messages.push({role: 'tool', content: result, tool_name: call.name});
  }
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {CATALOG, PERMISSION_DENIED, type Tool} from 'sidekick/catalog';
import {MODEL_ADDR, TOKENS_PER_CALL} from 'sidekick/config';
import type {Outcome} from 'sidekick/outcome';

import {invokeTool, reserve} from './budget_cache'; // step 3: the shop's budget, and its tools behind a cache

export const SYSTEM_PROMPT =
  "You are Sidekick, the assistant inside a Shopify admin. Answer the merchant's question about their own " +
  "shop, call a tool when the answer needs the shop's data, and say so when you cannot help.";
export const MAX_TURNS = 6;
export const MODEL_DEADLINE_MS = 10_000;
export const LOOP_BUDGET_MS = 30_000;

interface Message {
  role: string;
  content: string;
  tool_name?: string;
}
interface CompleteRequest {
  shop: string;
  page: string;
  system_prompt: string;
  tools: {name: string; description: string}[];
  messages: Message[];
  instructions?: string;
}
interface CompleteReply {
  text: string;
  tool_call?: {name: string; args_json: string} | null;
}
interface ModelClient {
  Complete(request: CompleteRequest, options?: {deadline: number}): Promise<CompleteReply>;
}

const {sidekickrpc} = grpc.loadPackageDefinition(protoLoader.loadSync('merchant_agent.proto')) as unknown as {
  sidekickrpc: {Model: new (target: string, credentials: grpc.ChannelCredentials) => ModelClient};
};
const model = new sidekickrpc.Model(MODEL_ADDR, grpc.credentials.createInsecure());
const TOOL_LIST = Object.values(CATALOG).map(t => ({name: t.name, description: t.description}));

/** One assist turn: the model and the merchant's tools in a bounded loop. */
export async function runAgent(shop: string, scopes: string[], message: string, page: string, turnId: string): Promise<Outcome> {
  const messages: Message[] = [{role: 'user', content: message}];
  let instructions = ''; // the guidance of the tool that ran last turn, sent once
  const used: string[] = [];
  const deadline = Date.now() + LOOP_BUDGET_MS;
  const slow = (): Outcome => ({reply: 'This is taking too long; here is what I have so far.', tools_used: used, status: 'deadline'});
  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return slow();
    if (!(await reserve(shop, TOKENS_PER_CALL))) return {reply: 'Sidekick is busy for this shop; try again in a minute.', tools_used: used, status: 'over_budget'};
    let reply: CompleteReply;
    try {
      reply = await model.Complete(
        {shop, page, system_prompt: SYSTEM_PROMPT, tools: TOOL_LIST, messages: [...messages], instructions},
        {deadline: Date.now() + Math.min(MODEL_DEADLINE_MS, remaining)},
      );
    } catch (err) {
      if ((err as grpc.ServiceError).code === grpc.status.DEADLINE_EXCEEDED) return slow();
      throw err;
    }
    const call = reply.tool_call;
    if (!call || call.name === '') return {reply: reply.text, tools_used: used, status: 'done'};
    messages.push({role: 'assistant', content: call.args_json, tool_name: call.name});
    const tool: Tool | undefined = Object.hasOwn(CATALOG, call.name) ? CATALOG[call.name] : undefined;
    if (tool === undefined || !scopes.includes(tool.required_scope)) {
      messages.push({role: 'tool', content: PERMISSION_DENIED, tool_name: call.name});
      instructions = '';
      continue;
    }
    const result = await invokeTool(shop, turnId, call.name, call.args_json);
    used.push(call.name);
    messages.push({role: 'tool', content: result, tool_name: call.name});
    instructions = tool.instructions;
  }
  return {reply: 'I stopped after six steps; here is what I have so far.', tools_used: used, status: 'turn_limit'};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"errors"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"sidekick/catalog" // catalog.Tools — provided
	"sidekick/config"  // config.ModelAddr, config.TokensPerCall — provided
	"sidekick/outcome" // outcome.Outcome — provided
	pb "sidekickrpc/gen/merchant_agent"
)

const systemPrompt = "You are Sidekick, the assistant inside a Shopify admin. Answer the merchant's question about their own " +
	"shop, call a tool when the answer needs the shop's data, and say so when you cannot help."

var modelConn, _ = grpc.NewClient(config.ModelAddr, grpc.WithTransportCredentials(insecure.NewCredentials()))
var modelClient = pb.NewModelClient(modelConn)

// Built in step 3 (budget_cache.go): the shop's budget, and its tools behind a cache.
var reserve = func(ctx context.Context, shop string, tokens int64) (bool, error) {
	return false, errors.New("reserve is built in step 3 (budget_cache.go)")
}
var invokeTool = func(ctx context.Context, shop, turnID, name, argsJSON string) (string, error) {
	return "", errors.New("invokeTool is built in step 3 (budget_cache.go)")
}

// runAgent is one assist turn: the model and the merchant's tools in a loop.
func runAgent(ctx context.Context, shop string, scopes []string, message, page, turnID string) (outcome.Outcome, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	system := systemPrompt + "\\n\\nTools:"
	tools := []*pb.ToolSpec{}
	for _, t := range catalog.Tools {
		system += "\\n" + t.Name + ": " + t.Instructions
		tools = append(tools, &pb.ToolSpec{Name: t.Name, Description: t.Description + " " + t.Instructions})
	}
	messages := []*pb.Message{{Role: "user", Content: message}}
	used := []string{}
	for {
		ok, err := reserve(ctx, shop, config.TokensPerCall)
		if err != nil {
			return outcome.Outcome{}, err
		}
		if !ok {
			return outcome.Outcome{Reply: "Sidekick is busy for this shop; try again in a minute.", ToolsUsed: used, Status: "over_budget"}, nil
		}
		reply, err := modelClient.Complete(ctx, &pb.CompleteRequest{Shop: shop, Page: page, SystemPrompt: system, Tools: tools, Messages: messages})
		if err != nil {
			return outcome.Outcome{}, err
		}
		call := reply.GetToolCall()
		if call.GetName() == "" {
			return outcome.Outcome{Reply: reply.GetText(), ToolsUsed: used, Status: "done"}, nil
		}
		messages = append(messages, &pb.Message{Role: "assistant", Content: call.GetArgsJson(), ToolName: call.GetName()})
		result, err := invokeTool(ctx, shop, turnID, call.GetName(), call.GetArgsJson())
		if err != nil {
			return outcome.Outcome{}, err
		}
		used = append(used, call.GetName())
		messages = append(messages, &pb.Message{Role: "tool", Content: result, ToolName: call.GetName()})
	}
}
`,
      solution: `package main

import (
	"context"
	"errors"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"sidekick/catalog" // catalog.Tools, catalog.Lookup(name), catalog.PermissionDenied — provided
	"sidekick/config"  // config.ModelAddr, config.TokensPerCall — provided
	"sidekick/outcome" // outcome.Outcome — provided
	pb "sidekickrpc/gen/merchant_agent"
)

const (
	systemPrompt = "You are Sidekick, the assistant inside a Shopify admin. Answer the merchant's question about their own " +
		"shop, call a tool when the answer needs the shop's data, and say so when you cannot help."
	maxTurns      = 6
	modelDeadline = 10 * time.Second
	loopBudget    = 30 * time.Second
)

var modelConn, _ = grpc.NewClient(config.ModelAddr, grpc.WithTransportCredentials(insecure.NewCredentials()))
var modelClient = pb.NewModelClient(modelConn)

// Built in step 3 (budget_cache.go): the shop's budget, and its tools behind a cache.
var reserve = func(ctx context.Context, shop string, tokens int64) (bool, error) {
	return false, errors.New("reserve is built in step 3 (budget_cache.go)")
}
var invokeTool = func(ctx context.Context, shop, turnID, name, argsJSON string) (string, error) {
	return "", errors.New("invokeTool is built in step 3 (budget_cache.go)")
}

func holds(scopes []string, scope string) bool {
	for _, s := range scopes {
		if s == scope {
			return true
		}
	}
	return false
}

// runAgent is one assist turn: the model and the merchant's tools in a bounded loop.
func runAgent(ctx context.Context, shop string, scopes []string, message, page, turnID string) (outcome.Outcome, error) {
	tools := []*pb.ToolSpec{}
	for _, t := range catalog.Tools {
		tools = append(tools, &pb.ToolSpec{Name: t.Name, Description: t.Description})
	}
	messages := []*pb.Message{{Role: "user", Content: message}}
	instructions := "" // the guidance of the tool that ran last turn, sent once
	used := []string{}
	slow := outcome.Outcome{Reply: "This is taking too long; here is what I have so far.", Status: "deadline"}
	deadline := time.Now().Add(loopBudget)
	for turn := 0; turn < maxTurns; turn++ {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			slow.ToolsUsed = used
			return slow, nil
		}
		ok, err := reserve(ctx, shop, config.TokensPerCall)
		if err != nil {
			return outcome.Outcome{}, err
		}
		if !ok {
			return outcome.Outcome{Reply: "Sidekick is busy for this shop; try again in a minute.", ToolsUsed: used, Status: "over_budget"}, nil
		}
		wait := modelDeadline
		if remaining < wait {
			wait = remaining
		}
		callCtx, cancel := context.WithTimeout(ctx, wait)
		reply, err := modelClient.Complete(callCtx, &pb.CompleteRequest{Shop: shop, Page: page, SystemPrompt: systemPrompt, Tools: tools, Messages: messages, Instructions: instructions})
		cancel()
		if status.Code(err) == codes.DeadlineExceeded {
			slow.ToolsUsed = used
			return slow, nil
		}
		if err != nil {
			return outcome.Outcome{}, err
		}
		call := reply.GetToolCall()
		if call.GetName() == "" {
			return outcome.Outcome{Reply: reply.GetText(), ToolsUsed: used, Status: "done"}, nil
		}
		messages = append(messages, &pb.Message{Role: "assistant", Content: call.GetArgsJson(), ToolName: call.GetName()})
		tool, known := catalog.Lookup(call.GetName())
		if !known || !holds(scopes, tool.RequiredScope) {
			messages = append(messages, &pb.Message{Role: "tool", Content: catalog.PermissionDenied, ToolName: call.GetName()})
			instructions = ""
			continue
		}
		result, err := invokeTool(ctx, shop, turnID, call.GetName(), call.GetArgsJson())
		if err != nil {
			return outcome.Outcome{}, err
		}
		used = append(used, call.GetName())
		messages = append(messages, &pb.Message{Role: "tool", Content: result, ToolName: call.GetName()})
		instructions = tool.Instructions
	}
	return outcome.Outcome{Reply: "I stopped after six steps; here is what I have so far.", ToolsUsed: used, Status: "turn_limit"}, nil
}
`,
    },
    scala: {
      starter: `import io.grpc.ManagedChannelBuilder

import sidekick.{Catalog, Config, Outcome}
import sidekickrpc.merchant_agent.{CompleteRequest, Message, ModelGrpc, ToolCall, ToolSpec}

object AgentLoop {
  val SystemPrompt: String =
    "You are Sidekick, the assistant inside a Shopify admin. Answer the merchant's question about their own " +
      "shop, call a tool when the answer needs the shop's data, and say so when you cannot help."

  private val model = ModelGrpc.blockingStub(ManagedChannelBuilder.forTarget(Config.ModelAddr).usePlaintext().build())

  /** One assist turn: the model and the merchant's tools in a loop. */
  def runAgent(shop: String, scopes: List[String], message: String, page: String, turnId: String): Outcome = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    val system = SystemPrompt + "\\n\\nTools:\\n" + Catalog.Tools.map(t => s"\${t.name}: \${t.instructions}").mkString("\\n")
    val tools = Catalog.Tools.map(t => ToolSpec(name = t.name, description = s"\${t.description} \${t.instructions}"))
    var messages = Vector(Message(role = "user", content = message))
    var used = Vector.empty[String]
    while (true) {
      if (!BudgetCache.reserve(shop, Config.TokensPerCall))
        return Outcome("Sidekick is busy for this shop; try again in a minute.", used.toList, "over_budget")
      val reply = model.complete(CompleteRequest(shop = shop, page = page, systemPrompt = system, tools = tools, messages = messages))
      val call = reply.toolCall.getOrElse(ToolCall())
      if (call.name.isEmpty) return Outcome(reply.text, used.toList, "done")
      messages :+= Message(role = "assistant", content = call.argsJson, toolName = call.name)
      val result = BudgetCache.invokeTool(shop, turnId, call.name, call.argsJson)
      used :+= call.name
      messages :+= Message(role = "tool", content = result, toolName = call.name)
    }
    Outcome("", used.toList, "done")
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import sidekick.{Catalog, Config, Outcome}
import sidekickrpc.merchant_agent.{CompleteReply, CompleteRequest, Message, ModelGrpc, ToolCall, ToolSpec}

object AgentLoop {
  val SystemPrompt: String =
    "You are Sidekick, the assistant inside a Shopify admin. Answer the merchant's question about their own " +
      "shop, call a tool when the answer needs the shop's data, and say so when you cannot help."
  val MaxTurns = 6
  val ModelDeadlineMs = 10000L
  val LoopBudgetMs = 30000L

  private val model = ModelGrpc.blockingStub(ManagedChannelBuilder.forTarget(Config.ModelAddr).usePlaintext().build())
  private val toolList = Catalog.Tools.map(t => ToolSpec(name = t.name, description = t.description))

  /** One assist turn: the model and the merchant's tools in a bounded loop. */
  def runAgent(shop: String, scopes: List[String], message: String, page: String, turnId: String): Outcome = {
    var messages = Vector(Message(role = "user", content = message))
    var instructions = "" // the guidance of the tool that ran last turn, sent once
    var used = Vector.empty[String]
    def slow = Outcome("This is taking too long; here is what I have so far.", used.toList, "deadline")
    val deadline = System.currentTimeMillis() + LoopBudgetMs
    var turn = 0
    while (turn < MaxTurns) {
      turn += 1
      val remaining = deadline - System.currentTimeMillis()
      if (remaining <= 0) return slow
      if (!BudgetCache.reserve(shop, Config.TokensPerCall))
        return Outcome("Sidekick is busy for this shop; try again in a minute.", used.toList, "over_budget")
      val request = CompleteRequest(
        shop = shop,
        page = page,
        systemPrompt = SystemPrompt,
        tools = toolList,
        messages = messages,
        instructions = instructions
      )
      val reply: CompleteReply =
        try model.withDeadlineAfter(math.min(ModelDeadlineMs, remaining), TimeUnit.MILLISECONDS).complete(request)
        catch {
          case e: StatusRuntimeException if e.getStatus.getCode == Status.Code.DEADLINE_EXCEEDED => return slow
        }
      val call = reply.toolCall.getOrElse(ToolCall())
      if (call.name.isEmpty) return Outcome(reply.text, used.toList, "done")
      messages :+= Message(role = "assistant", content = call.argsJson, toolName = call.name)
      Catalog.lookup(call.name).filter(tool => scopes.contains(tool.requiredScope)) match {
        case None =>
          messages :+= Message(role = "tool", content = Catalog.PermissionDenied, toolName = call.name)
          instructions = ""
        case Some(tool) =>
          val result = BudgetCache.invokeTool(shop, turnId, call.name, call.argsJson)
          used :+= call.name
          messages :+= Message(role = "tool", content = result, toolName = call.name)
          instructions = tool.instructions
      }
    }
    Outcome("I stopped after six steps; here is what I have so far.", used.toList, "turn_limit")
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <stdexcept>
#include <string>
#include <vector>

#include "merchant_agent.grpc.pb.h"
#include "sidekick/catalog.h"  // catalog::tools() — provided
#include "sidekick/config.h"   // config::kModelAddr, config::kTokensPerCall — provided
#include "sidekick/outcome.h"  // outcome::Outcome — provided

// Built in step 3 (budget_cache.cpp): the shop's budget, and its tools behind a cache.
bool reserve(const std::string& shop, long long tokens);
std::string invoke_tool(const std::string& shop, const std::string& turn_id, const std::string& name, const std::string& args_json);

const std::string kSystemPrompt =
    "You are Sidekick, the assistant inside a Shopify admin. Answer the merchant's question about their own "
    "shop, call a tool when the answer needs the shop's data, and say so when you cannot help.";

auto model_stub = sidekickrpc::Model::NewStub(grpc::CreateChannel(config::kModelAddr, grpc::InsecureChannelCredentials()));

// One assist turn: the model and the merchant's tools in a loop.
outcome::Outcome run_agent(const std::string& shop, const std::vector<std::string>& scopes, const std::string& message,
                           const std::string& page, const std::string& turn_id) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  sidekickrpc::CompleteRequest request;
  request.set_shop(shop);
  request.set_page(page);
  std::string system = kSystemPrompt + "\\n\\nTools:";
  for (const auto& t : catalog::tools()) {
    system += "\\n" + t.name + ": " + t.instructions;
    auto* spec = request.add_tools();
    spec->set_name(t.name);
    spec->set_description(t.description + " " + t.instructions);
  }
  request.set_system_prompt(system);
  auto* user = request.add_messages();
  user->set_role("user");
  user->set_content(message);
  std::vector<std::string> used;
  while (true) {
    if (!reserve(shop, config::kTokensPerCall)) return {"Sidekick is busy for this shop; try again in a minute.", used, "over_budget"};
    grpc::ClientContext ctx;
    sidekickrpc::CompleteReply reply;
    const grpc::Status status = model_stub->Complete(&ctx, request, &reply);
    if (!status.ok()) throw std::runtime_error("model: " + status.error_message());
    const auto& call = reply.tool_call();
    if (call.name().empty()) return {reply.text(), used, "done"};
    auto* asked = request.add_messages();
    asked->set_role("assistant");
    asked->set_content(call.args_json());
    asked->set_tool_name(call.name());
    const std::string result = invoke_tool(shop, turn_id, call.name(), call.args_json());
    used.push_back(call.name());
    auto* answered = request.add_messages();
    answered->set_role("tool");
    answered->set_content(result);
    answered->set_tool_name(call.name());
  }
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <algorithm>
#include <chrono>
#include <stdexcept>
#include <string>
#include <vector>

#include "merchant_agent.grpc.pb.h"
#include "sidekick/catalog.h"  // catalog::tools(), catalog::lookup(name), catalog::kPermissionDenied — provided
#include "sidekick/config.h"   // config::kModelAddr, config::kTokensPerCall — provided
#include "sidekick/outcome.h"  // outcome::Outcome — provided

// Built in step 3 (budget_cache.cpp): the shop's budget, and its tools behind a cache.
bool reserve(const std::string& shop, long long tokens);
std::string invoke_tool(const std::string& shop, const std::string& turn_id, const std::string& name, const std::string& args_json);

const std::string kSystemPrompt =
    "You are Sidekick, the assistant inside a Shopify admin. Answer the merchant's question about their own "
    "shop, call a tool when the answer needs the shop's data, and say so when you cannot help.";
constexpr int kMaxTurns = 6;
constexpr std::chrono::milliseconds kModelDeadline{10000};
constexpr std::chrono::milliseconds kLoopBudget{30000};

auto model_stub = sidekickrpc::Model::NewStub(grpc::CreateChannel(config::kModelAddr, grpc::InsecureChannelCredentials()));

void add_message(sidekickrpc::CompleteRequest& request, const std::string& role, const std::string& content, const std::string& tool_name) {
  auto* m = request.add_messages();
  m->set_role(role);
  m->set_content(content);
  m->set_tool_name(tool_name);
}

// One assist turn: the model and the merchant's tools in a bounded loop.
outcome::Outcome run_agent(const std::string& shop, const std::vector<std::string>& scopes, const std::string& message,
                           const std::string& page, const std::string& turn_id) {
  sidekickrpc::CompleteRequest request;
  request.set_shop(shop);
  request.set_page(page);
  request.set_system_prompt(kSystemPrompt);
  for (const auto& t : catalog::tools()) {
    auto* spec = request.add_tools();
    spec->set_name(t.name);
    spec->set_description(t.description);
  }
  add_message(request, "user", message, "");
  std::vector<std::string> used;
  const outcome::Outcome slow{"This is taking too long; here is what I have so far.", {}, "deadline"};
  const auto deadline = std::chrono::system_clock::now() + kLoopBudget;
  for (int turn = 0; turn < kMaxTurns; ++turn) {
    const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - std::chrono::system_clock::now());
    if (remaining.count() <= 0) return {slow.reply, used, slow.status};
    if (!reserve(shop, config::kTokensPerCall)) return {"Sidekick is busy for this shop; try again in a minute.", used, "over_budget"};
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::min(kModelDeadline, remaining));
    sidekickrpc::CompleteReply reply;
    const grpc::Status status = model_stub->Complete(&ctx, request, &reply);
    if (status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED) return {slow.reply, used, slow.status};
    if (!status.ok()) throw std::runtime_error("model: " + status.error_message());
    request.set_instructions("");
    const auto& call = reply.tool_call();
    if (call.name().empty()) return {reply.text(), used, "done"};
    add_message(request, "assistant", call.args_json(), call.name());
    const catalog::Tool* tool = catalog::lookup(call.name());
    if (tool == nullptr || std::find(scopes.begin(), scopes.end(), tool->required_scope) == scopes.end()) {
      add_message(request, "tool", catalog::kPermissionDenied, call.name());
      continue;
    }
    const std::string result = invoke_tool(shop, turn_id, call.name(), call.args_json());
    used.push_back(call.name());
    add_message(request, "tool", result, call.name());
    request.set_instructions(tool->instructions);
  }
  return {"I stopped after six steps; here is what I have so far.", used, "turn_limit"};
}
`,
    },
  },
  harness: {
    python: `import grpc

import merchant_agent_pb2
import merchant_agent_pb2_grpc
from sidekick import catalog, config, model, tools

# The stand-in model answers in text after this many calls, so a loop with no exit still ends.
LOOP_CAP = 12
CUSTOMERS = "which of my customers are from Toronto?"
FORM = "write an SEO description for the jacket I have open"
LOOP = "loop: compare this week's sales with every week this year"


class ModelPeer(merchant_agent_pb2_grpc.ModelServicer):
    """The stand-in model: answers from sidekick.model."""

    def __init__(self):
        self.calls = 0

    def Complete(self, request, context):
        self.calls += 1
        if self.calls > LOOP_CAP:
            return merchant_agent_pb2.CompleteReply(text="(the stand-in model stopped asking for tools)")
        user = request.messages[0].content if request.messages else ""
        reply = model.respond(user, [m.content for m in request.messages if m.role == "tool"])
        return merchant_agent_pb2.CompleteReply(text=reply.text, tool_call=merchant_agent_pb2.ToolCall(name=reply.tool_name, args_json=reply.args_json))


class ToolsPeer(merchant_agent_pb2_grpc.ToolsServicer):
    """The stand-in tools: answers from sidekick.tools."""

    def Invoke(self, request, context):
        return merchant_agent_pb2.InvokeReply(result_json=tools.invoke(request.shop, request.name, request.args_json))


def _world(ctx):
    ctx.grpc.serve(merchant_agent_pb2_grpc.add_ModelServicer_to_server, ModelPeer(), config.MODEL_ADDR)
    ctx.grpc.serve(merchant_agent_pb2_grpc.add_ToolsServicer_to_server, ToolsPeer(), config.TOOLS_ADDR)
    return ctx.load("agent_loop")


def _requests(ctx):
    return [call.request for call in ctx.grpc.calls_to("Complete")]


def _invoked(ctx):
    return [call.request.name for call in ctx.grpc.calls_to("Invoke")]


def check_compact_prompt(ctx):
    m = _world(ctx)
    m.run_agent("s1", ["read_customers"], CUSTOMERS, "customers", "t-1")
    m.run_agent("s1", ["read_reports"], "how were sales last month?", "analytics", "t-2")
    requests = _requests(ctx)
    assert len(requests) >= 4, f"two turns that each call one tool make 4 Complete calls, saw {len(requests)}"
    prompts = {r.system_prompt for r in requests}
    assert len(prompts) == 1, f"the system prompt changed between calls ({len(prompts)} versions): every change misses the provider's prompt cache"
    for tool in catalog.CATALOG.values():
        assert tool.instructions not in requests[0].system_prompt, f"the system prompt carries {tool.name}'s instructions: every tool's guidance in every call is the prompt that grows with the catalog"
    listed = [(t.name, t.description) for t in requests[0].tools]
    expected = [(t.name, t.description) for t in catalog.CATALOG.values()]
    assert listed == expected, f"the tool list must be the catalog's names with their one-line descriptions, got {listed}"


def check_jit_instructions(ctx):
    m = _world(ctx)
    out = m.run_agent("s1", ["read_customers"], CUSTOMERS, "customers", "t-1")
    requests = _requests(ctx)
    assert len(requests) == 2 and out.tools_used == ["segment_customers"], f"the Toronto question takes one tool call and two Complete calls, saw {len(requests)} calls and {out}"
    assert requests[0].instructions == "", f"the first call carries instructions though no tool has run: {requests[0].instructions!r}"
    wanted = catalog.CATALOG["segment_customers"].instructions
    assert requests[1].instructions == wanted, f"the call after segment_customers ran must carry its instructions ({wanted[:40]!r}…) in \`instructions\`, got {requests[1].instructions!r}"
    m.run_agent("s1", [], CUSTOMERS, "customers", "t-2")
    later = _requests(ctx)[2:]
    assert later and all(r.instructions == "" for r in later), f"a refused tool call ran nothing, so the next call carries no instructions: {[r.instructions for r in later]}"


def check_turn_limit(ctx):
    m = _world(ctx)
    out = m.run_agent("s1", ["read_reports"], LOOP, "analytics", "t-1")
    calls = len(ctx.grpc.calls_to("Complete"))
    assert calls == 6, f"a model that asks for a tool on every turn got {calls} Complete calls: the loop stops at MAX_TURNS = 6"
    assert out.status == "turn_limit", f"the outcome must say turn_limit, got {out.status!r}"
    assert len(out.tools_used) == 6, f"tools_used lists the six tool calls made, got {out.tools_used}"


def check_call_deadline(ctx):
    m = _world(ctx)
    ctx.grpc.set_latency("Complete", 60.0, config.MODEL_ADDR)
    started = ctx.clock.time()
    out = m.run_agent("s1", ["read_customers"], CUSTOMERS, "customers", "t-1")
    waited = ctx.clock.time() - started
    first = ctx.grpc.calls_to("Complete")[0]
    assert first.timeout is not None and first.timeout <= 10.5, f"Complete must carry a deadline of at most 10 s, it carried {first.timeout}"
    assert out.status == "deadline" and waited <= 10.5, f"a model that hangs held the turn {waited:.0f} s (status {out.status!r}): cut it at MODEL_DEADLINE_S and answer with status deadline"
    ctx.grpc.set_latency("Complete", 8.0, config.MODEL_ADDR)
    started = ctx.clock.time()
    out = m.run_agent("s1", ["read_reports"], LOOP, "analytics", "t-2")
    waited = ctx.clock.time() - started
    assert waited <= 30.5, f"a model that takes 8 s per call held the loop {waited:.0f} s: the whole loop has LOOP_BUDGET_S = 30"
    assert out.status == "deadline", f"a loop that ran out of time must say deadline, got {out.status!r}"


def check_scope_gate(ctx):
    m = _world(ctx)
    out = m.run_agent("s1", ["read_customers"], FORM, "products", "t-1")
    assert _invoked(ctx) == [], f"a staff account with only read_customers got {_invoked(ctx)} invoked: fill_product_form needs write_products"
    assert out.tools_used == [], f"tools_used must stay empty when the call was refused: {out}"
    last = _requests(ctx)[-1]
    told = [msg for msg in last.messages if msg.role == "tool"]
    assert told and told[-1].content == catalog.PERMISSION_DENIED and told[-1].tool_name == "fill_product_form", f"the model must hear PERMISSION_DENIED for fill_product_form, its messages were {[(x.role, x.tool_name, x.content[:30]) for x in last.messages]}"
    m.run_agent("s1", ["read_customers", "write_products"], "delete my shop", "home", "t-2")
    assert _invoked(ctx) == [], f"delete_shop is not in the catalog and was invoked anyway: {_invoked(ctx)}"
    out = m.run_agent("s1", ["read_customers", "write_products"], FORM, "products", "t-3")
    assert _invoked(ctx) == ["fill_product_form"] and out.tools_used == ["fill_product_form"], f"with write_products the form is filled once: invoked {_invoked(ctx)}, outcome {out}"
`,
    typescript: `const LOOP_CAP = 12; // the stand-in model answers in text after this many calls, so a loop with no exit still ends
const CUSTOMERS = 'which of my customers are from Toronto?';
const FORM = 'write an SEO description for the jacket I have open';
const LOOP = "loop: compare this week's sales with every week this year";

/** The stand-in model and tools, the learner's module. */
function world(ctx) {
  const {sidekickrpc} = ctx.proto('merchant_agent.proto');
  const config = ctx.load('/support/sidekick/config.ts');
  const model = ctx.load('/support/sidekick/model.ts');
  const tools = ctx.load('/support/sidekick/tools.ts');
  const catalog = ctx.load('/support/sidekick/catalog.ts');
  let calls = 0;
  ctx.grpc.serve(sidekickrpc.Model.service, {
    Complete(call, callback) {
      calls += 1;
      if (calls > LOOP_CAP) return callback(null, {text: '(the stand-in model stopped asking for tools)', tool_call: {name: '', args_json: ''}});
      const messages = call.request.messages ?? [];
      const reply = model.respond(messages[0]?.content ?? '', messages.filter(x => x.role === 'tool').map(x => x.content));
      return callback(null, {text: reply.text, tool_call: {name: reply.tool_name, args_json: reply.args_json}});
    },
  }, config.MODEL_ADDR);
  ctx.grpc.serve(sidekickrpc.Tools.service, {
    Invoke(call, callback) {
      callback(null, {result_json: tools.invoke(call.request.shop, call.request.name, call.request.args_json)});
    },
  }, config.TOOLS_ADDR);
  return {m: ctx.load('agent_loop'), config, catalog};
}

const requests = ctx => ctx.grpc.callsTo('Complete').map(call => call.request);
const invoked = (ctx): string[] => ctx.grpc.callsTo('Invoke').map(call => call.request.name);

export async function check_compact_prompt(ctx) {
  const {m, catalog} = world(ctx);
  await m.runAgent('s1', ['read_customers'], CUSTOMERS, 'customers', 't-1');
  await m.runAgent('s1', ['read_reports'], 'how were sales last month?', 'analytics', 't-2');
  const all = requests(ctx);
  assert(all.length >= 4, \`two turns that each call one tool make 4 Complete calls, saw \${all.length}\`);
  const prompts = new Set(all.map(r => r.system_prompt));
  assert.equal(prompts.size, 1, \`the system prompt changed between calls (\${prompts.size} versions): every change misses the provider's prompt cache\`);
  for (const tool of Object.values(catalog.CATALOG) as {name: string; instructions: string}[]) {
    assert(!all[0].system_prompt.includes(tool.instructions), \`the system prompt carries \${tool.name}'s instructions: every tool's guidance in every call is the prompt that grows with the catalog\`);
  }
  const listed = (all[0].tools ?? []).map(t => [t.name, t.description]);
  const expected = (Object.values(catalog.CATALOG) as {name: string; description: string}[]).map(t => [t.name, t.description]);
  assert.deepEqual(listed, expected, \`the tool list must be the catalog's names with their one-line descriptions, got \${JSON.stringify(listed)}\`);
}

export async function check_jit_instructions(ctx) {
  const {m, catalog} = world(ctx);
  const out = await m.runAgent('s1', ['read_customers'], CUSTOMERS, 'customers', 't-1');
  const all = requests(ctx);
  assert(all.length === 2 && JSON.stringify(out.tools_used) === '["segment_customers"]', \`the Toronto question takes one tool call and two Complete calls, saw \${all.length} calls and \${JSON.stringify(out)}\`);
  assert.equal(all[0].instructions ?? '', '', \`the first call carries instructions though no tool has run: \${JSON.stringify(all[0].instructions)}\`);
  const wanted = catalog.CATALOG.segment_customers.instructions;
  assert.equal(all[1].instructions ?? '', wanted, \`the call after segment_customers ran must carry its instructions in \\\`instructions\\\`, got \${JSON.stringify(all[1].instructions)}\`);
  await m.runAgent('s1', [], CUSTOMERS, 'customers', 't-2');
  const later = requests(ctx).slice(2);
  assert(later.length > 0 && later.every(r => (r.instructions ?? '') === ''), \`a refused tool call ran nothing, so the next call carries no instructions: \${JSON.stringify(later.map(r => r.instructions))}\`);
}

export async function check_turn_limit(ctx) {
  const {m} = world(ctx);
  const out = await m.runAgent('s1', ['read_reports'], LOOP, 'analytics', 't-1');
  const calls = ctx.grpc.callsTo('Complete').length;
  assert.equal(calls, 6, \`a model that asks for a tool on every turn got \${calls} Complete calls: the loop stops at MAX_TURNS = 6\`);
  assert.equal(out.status, 'turn_limit', \`the outcome must say turn_limit, got \${JSON.stringify(out.status)}\`);
  assert.equal(out.tools_used.length, 6, \`tools_used lists the six tool calls made, got \${JSON.stringify(out.tools_used)}\`);
}

export async function check_call_deadline(ctx) {
  const {m, config} = world(ctx);
  ctx.grpc.setLatency('Complete', 60, config.MODEL_ADDR);
  let started = ctx.clock.now();
  let out = await m.runAgent('s1', ['read_customers'], CUSTOMERS, 'customers', 't-1');
  let waited = (ctx.clock.now() - started) / 1000;
  const first = ctx.grpc.callsTo('Complete')[0];
  assert(first.timeout !== null && first.timeout <= 10.5, \`Complete must carry a deadline of at most 10 s, it carried \${first.timeout}\`);
  assert(out.status === 'deadline' && waited <= 10.5, \`a model that hangs held the turn \${waited.toFixed(0)} s (status \${out.status}): cut it at MODEL_DEADLINE_MS and answer with status deadline\`);
  ctx.grpc.setLatency('Complete', 8, config.MODEL_ADDR);
  started = ctx.clock.now();
  out = await m.runAgent('s1', ['read_reports'], LOOP, 'analytics', 't-2');
  waited = (ctx.clock.now() - started) / 1000;
  assert(waited <= 30.5, \`a model that takes 8 s per call held the loop \${waited.toFixed(0)} s: the whole loop has LOOP_BUDGET_MS = 30000\`);
  assert.equal(out.status, 'deadline', \`a loop that ran out of time must say deadline, got \${out.status}\`);
}

export async function check_scope_gate(ctx) {
  const {m, catalog} = world(ctx);
  let out = await m.runAgent('s1', ['read_customers'], FORM, 'products', 't-1');
  assert.deepEqual(invoked(ctx), [], \`a staff account with only read_customers got \${JSON.stringify(invoked(ctx))} invoked: fill_product_form needs write_products\`);
  assert.deepEqual(out.tools_used, [], \`tools_used must stay empty when the call was refused: \${JSON.stringify(out)}\`);
  const all = requests(ctx);
  const told = (all[all.length - 1].messages ?? []).filter(x => x.role === 'tool');
  const lastTold = told[told.length - 1];
  assert(lastTold && lastTold.content === catalog.PERMISSION_DENIED && lastTold.tool_name === 'fill_product_form', \`the model must hear PERMISSION_DENIED for fill_product_form, its messages were \${JSON.stringify(all[all.length - 1].messages)}\`);
  await m.runAgent('s1', ['read_customers', 'write_products'], 'delete my shop', 'home', 't-2');
  assert.deepEqual(invoked(ctx), [], \`delete_shop is not in the catalog and was invoked anyway: \${JSON.stringify(invoked(ctx))}\`);
  out = await m.runAgent('s1', ['read_customers', 'write_products'], FORM, 'products', 't-3');
  assert(JSON.stringify(invoked(ctx)) === '["fill_product_form"]' && JSON.stringify(out.tools_used) === '["fill_product_form"]', \`with write_products the form is filled once: invoked \${JSON.stringify(invoked(ctx))}, outcome \${JSON.stringify(out)}\`);
}
`,
    go: `package main

import (
	"context"
	"strings"

	"sidekick/catalog"
	"sidekick/config"
	"sidekick/model"
	"sidekick/outcome"
	"sidekick/tools"
	pb "sidekickrpc/gen/merchant_agent"

	"leetbuild/harness"
)

const (
	loopCap       = 12 // the stand-in model answers in text after this many calls, so a loop with no exit still ends
	loopCustomers = "which of my customers are from Toronto?"
	loopForm      = "write an SEO description for the jacket I have open"
	loopEndless   = "loop: compare this week's sales with every week this year"
)

// loopModel is the stand-in model: answers from sidekick/model.
type loopModel struct {
	pb.UnimplementedModelServer
	calls int
}

func (p *loopModel) Complete(_ context.Context, req *pb.CompleteRequest) (*pb.CompleteReply, error) {
	p.calls++
	if p.calls > loopCap {
		return &pb.CompleteReply{Text: "(the stand-in model stopped asking for tools)"}, nil
	}
	user := ""
	results := []string{}
	for i, m := range req.GetMessages() {
		if i == 0 {
			user = m.GetContent()
		}
		if m.GetRole() == "tool" {
			results = append(results, m.GetContent())
		}
	}
	r := model.Respond(user, results)
	return &pb.CompleteReply{Text: r.Text, ToolCall: &pb.ToolCall{Name: r.ToolName, ArgsJson: r.ArgsJSON}}, nil
}

// loopWorld serves the stand-in model and stands in for step 3: every reservation fits, and a tool
// is answered by sidekick/tools and recorded.
func loopWorld(ctx *harness.Ctx) *[]string {
	pb.RegisterModelServer(ctx.GRPC.Server(config.ModelAddr), &loopModel{})
	invoked := &[]string{}
	reserve = func(context.Context, string, int64) (bool, error) { return true, nil }
	invokeTool = func(_ context.Context, shop, turnID, name, argsJSON string) (string, error) {
		*invoked = append(*invoked, name)
		return tools.Invoke(shop, name, argsJSON), nil
	}
	return invoked
}

func loopRun(ctx *harness.Ctx, scopes []string, message, page, turnID string) outcome.Outcome {
	out, err := runAgent(context.Background(), "s1", scopes, message, page, turnID)
	ctx.NoError(err, "runAgent(%q)", message)
	return out
}

func loopRequests(ctx *harness.Ctx) []*pb.CompleteRequest {
	out := []*pb.CompleteRequest{}
	for _, c := range ctx.GRPC.CallsTo("Complete", "") {
		req, _ := c.Request.(*pb.CompleteRequest)
		out = append(out, req)
	}
	return out
}

func CheckCompactPrompt(ctx *harness.Ctx) {
	loopWorld(ctx)
	loopRun(ctx, []string{"read_customers"}, loopCustomers, "customers", "t-1")
	loopRun(ctx, []string{"read_reports"}, "how were sales last month?", "analytics", "t-2")
	all := loopRequests(ctx)
	ctx.Assert(len(all) >= 4, "two turns that each call one tool make 4 Complete calls, saw %d", len(all))
	for _, r := range all {
		ctx.Equal(r.GetSystemPrompt(), all[0].GetSystemPrompt(), "the system prompt changed between calls: every change misses the provider's prompt cache")
	}
	for _, t := range catalog.Tools {
		ctx.Assert(!strings.Contains(all[0].GetSystemPrompt(), t.Instructions), "the system prompt carries %s's instructions: every tool's guidance in every call is the prompt that grows with the catalog", t.Name)
	}
	listed := [][2]string{}
	for _, t := range all[0].GetTools() {
		listed = append(listed, [2]string{t.GetName(), t.GetDescription()})
	}
	expected := [][2]string{}
	for _, t := range catalog.Tools {
		expected = append(expected, [2]string{t.Name, t.Description})
	}
	ctx.Equal(listed, expected, "the tool list must be the catalog's names with their one-line descriptions")
}

func CheckJitInstructions(ctx *harness.Ctx) {
	loopWorld(ctx)
	out := loopRun(ctx, []string{"read_customers"}, loopCustomers, "customers", "t-1")
	all := loopRequests(ctx)
	ctx.Assert(len(all) == 2 && len(out.ToolsUsed) == 1, "the Toronto question takes one tool call and two Complete calls, saw %d calls and %+v", len(all), out)
	ctx.Equal(all[0].GetInstructions(), "", "the first call carries instructions though no tool has run")
	seg, _ := catalog.Lookup("segment_customers")
	ctx.Equal(all[1].GetInstructions(), seg.Instructions, "the call after segment_customers ran must carry its instructions in Instructions")
	loopRun(ctx, []string{}, loopCustomers, "customers", "t-2")
	later := loopRequests(ctx)[2:]
	ctx.Assert(len(later) > 0, "the refused turn made no Complete call")
	for _, r := range later {
		ctx.Equal(r.GetInstructions(), "", "a refused tool call ran nothing, so the next call carries no instructions")
	}
}

func CheckTurnLimit(ctx *harness.Ctx) {
	loopWorld(ctx)
	out := loopRun(ctx, []string{"read_reports"}, loopEndless, "analytics", "t-1")
	ctx.Equal(len(ctx.GRPC.CallsTo("Complete", "")), 6, "a model that asks for a tool on every turn: the loop stops at maxTurns = 6; Complete calls")
	ctx.Equal(out.Status, "turn_limit", "the outcome's status")
	ctx.Equal(len(out.ToolsUsed), 6, "ToolsUsed lists the six tool calls made")
}

func CheckCallDeadline(ctx *harness.Ctx) {
	loopWorld(ctx)
	ctx.GRPC.SetLatency("Complete", 60, config.ModelAddr)
	started := ctx.Clock.Now()
	out := loopRun(ctx, []string{"read_customers"}, loopCustomers, "customers", "t-1")
	waited := float64(ctx.Clock.Now()-started) / 1000
	first := ctx.GRPC.CallsTo("Complete", "")[0]
	ctx.Assert(first.HasDeadline() && first.Timeout.Seconds() <= 10.5, "Complete must carry a deadline of at most 10 s, it carried %v", first.Timeout)
	ctx.Assert(out.Status == "deadline" && waited <= 10.5, "a model that hangs held the turn %.0f s (status %q): cut it at modelDeadline and answer with status deadline", waited, out.Status)
	ctx.GRPC.SetLatency("Complete", 8, config.ModelAddr)
	started = ctx.Clock.Now()
	out = loopRun(ctx, []string{"read_reports"}, loopEndless, "analytics", "t-2")
	waited = float64(ctx.Clock.Now()-started) / 1000
	ctx.Assert(waited <= 30.5, "a model that takes 8 s per call held the loop %.0f s: the whole loop has loopBudget = 30 s", waited)
	ctx.Equal(out.Status, "deadline", "a loop that ran out of time; status")
}

func CheckScopeGate(ctx *harness.Ctx) {
	invoked := loopWorld(ctx)
	out := loopRun(ctx, []string{"read_customers"}, loopForm, "products", "t-1")
	ctx.Equal(*invoked, []string{}, "a staff account with only read_customers: fill_product_form needs write_products; invoked")
	ctx.Equal(out.ToolsUsed, []string{}, "ToolsUsed when the call was refused")
	all := loopRequests(ctx)
	var told *pb.Message
	for _, m := range all[len(all)-1].GetMessages() {
		if m.GetRole() == "tool" {
			told = m
		}
	}
	ctx.Assert(told != nil && told.GetContent() == catalog.PermissionDenied && told.GetToolName() == "fill_product_form", "the model must hear PERMISSION_DENIED for fill_product_form, its messages were %v", all[len(all)-1].GetMessages())
	loopRun(ctx, []string{"read_customers", "write_products"}, "delete my shop", "home", "t-2")
	ctx.Equal(*invoked, []string{}, "delete_shop is not in the catalog; invoked")
	out = loopRun(ctx, []string{"read_customers", "write_products"}, loopForm, "products", "t-3")
	ctx.Assert(len(*invoked) == 1 && (*invoked)[0] == "fill_product_form" && len(out.ToolsUsed) == 1, "with write_products the form is filled once: invoked %v, outcome %+v", *invoked, out)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <string>
#include <vector>

#include "merchant_agent.grpc.pb.h"
#include "sidekick/catalog.h"
#include "sidekick/config.h"
#include "sidekick/model.h"
#include "sidekick/tools.h"

namespace {

constexpr int kLoopCap = 12;  // the stand-in model answers in text after this many calls, so a loop with no exit still ends
const std::string kCustomers = "which of my customers are from Toronto?";
const std::string kForm = "write an SEO description for the jacket I have open";
const std::string kEndless = "loop: compare this week's sales with every week this year";

std::vector<std::string> loopInvoked;

// The stand-in model: answers from sidekick/model.h.
class LoopModel final : public sidekickrpc::Model::Service {
 public:
  int calls = 0;
  grpc::Status Complete(grpc::ServerContext*, const sidekickrpc::CompleteRequest* req, sidekickrpc::CompleteReply* reply) override {
    calls++;
    if (calls > kLoopCap) {
      reply->set_text("(the stand-in model stopped asking for tools)");
      return grpc::Status::OK;
    }
    std::vector<std::string> results;
    for (const auto& m : req->messages()) {
      if (m.role() == "tool") results.push_back(m.content());
    }
    const auto r = model::respond(req->messages_size() > 0 ? req->messages(0).content() : "", results);
    reply->set_text(r.text);
    reply->mutable_tool_call()->set_name(r.tool_name);
    reply->mutable_tool_call()->set_args_json(r.args_json);
    return grpc::Status::OK;
  }
};

void loopWorld(harness::Ctx& ctx) {
  static LoopModel* peer = nullptr;
  delete peer;
  peer = new LoopModel;
  ctx.GRPC.Server(config::kModelAddr)->RegisterService(peer);
  loopInvoked.clear();
}

outcome::Outcome loopRun(const std::vector<std::string>& scopes, const std::string& message, const std::string& page, const std::string& turn_id) {
  return run_agent("s1", scopes, message, page, turn_id);
}

std::vector<sidekickrpc::CompleteRequest> loopRequests(harness::Ctx& ctx) {
  std::vector<sidekickrpc::CompleteRequest> out;
  for (const auto& c : ctx.GRPC.CallsTo("Complete")) out.push_back(c.Request<sidekickrpc::CompleteRequest>());
  return out;
}

}  // namespace

// Stands in for step 3: every reservation fits, and a tool is answered by sidekick/tools.h and recorded.
bool reserve(const std::string&, long long) { return true; }

std::string invoke_tool(const std::string& shop, const std::string&, const std::string& name, const std::string& args_json) {
  loopInvoked.push_back(name);
  return tools::invoke(shop, name, args_json);
}

void CheckCompactPrompt(harness::Ctx& ctx) {
  loopWorld(ctx);
  loopRun({"read_customers"}, kCustomers, "customers", "t-1");
  loopRun({"read_reports"}, "how were sales last month?", "analytics", "t-2");
  const auto all = loopRequests(ctx);
  ctx.Assert(all.size() >= 4, "two turns that each call one tool make 4 Complete calls, saw %d", all.size());
  for (const auto& r : all) ctx.Equal(r.system_prompt(), all[0].system_prompt(), "the system prompt changed between calls: every change misses the provider's prompt cache");
  for (const auto& t : catalog::tools()) {
    ctx.Assert(all[0].system_prompt().find(t.instructions) == std::string::npos,
               "the system prompt carries %s's instructions: every tool's guidance in every call is the prompt that grows with the catalog", t.name);
  }
  std::vector<std::string> listed, expected;
  for (const auto& t : all[0].tools()) listed.push_back(t.name() + " | " + t.description());
  for (const auto& t : catalog::tools()) expected.push_back(t.name + " | " + t.description);
  ctx.Equal(listed, expected, "the tool list must be the catalog's names with their one-line descriptions");
}

void CheckJitInstructions(harness::Ctx& ctx) {
  loopWorld(ctx);
  const auto out = loopRun({"read_customers"}, kCustomers, "customers", "t-1");
  const auto all = loopRequests(ctx);
  ctx.Assert(all.size() == 2 && out.tools_used.size() == 1, "the Toronto question takes one tool call and two Complete calls, saw %d calls and %d tools", all.size(), out.tools_used.size());
  ctx.Equal(all[0].instructions(), "", "the first call carries instructions though no tool has run");
  ctx.Equal(all[1].instructions(), catalog::lookup("segment_customers")->instructions, "the call after segment_customers ran must carry its instructions in instructions");
  loopRun({}, kCustomers, "customers", "t-2");
  const auto later = loopRequests(ctx);
  ctx.Assert(later.size() > 2, "the refused turn made no Complete call");
  for (size_t i = 2; i < later.size(); ++i) ctx.Equal(later[i].instructions(), "", "a refused tool call ran nothing, so the next call carries no instructions");
}

void CheckTurnLimit(harness::Ctx& ctx) {
  loopWorld(ctx);
  const auto out = loopRun({"read_reports"}, kEndless, "analytics", "t-1");
  ctx.Equal(ctx.GRPC.CallsTo("Complete").size(), 6, "a model that asks for a tool on every turn: the loop stops at kMaxTurns = 6; Complete calls");
  ctx.Equal(out.status, "turn_limit", "the outcome's status");
  ctx.Equal(out.tools_used.size(), 6, "tools_used lists the six tool calls made");
}

void CheckCallDeadline(harness::Ctx& ctx) {
  loopWorld(ctx);
  ctx.GRPC.SetLatency("Complete", 60, config::kModelAddr);
  auto started = ctx.Clock.Now();
  auto out = loopRun({"read_customers"}, kCustomers, "customers", "t-1");
  double waited = static_cast<double>(ctx.Clock.Now() - started) / 1000;
  const auto first = ctx.GRPC.CallsTo("Complete")[0];
  ctx.Assert(first.HasDeadline() && first.TimeoutSeconds() <= 10.5, "Complete must carry a deadline of at most 10 s, it carried %vs", first.TimeoutSeconds());
  ctx.Assert(out.status == "deadline" && waited <= 10.5, "a model that hangs held the turn %.0f s (status %q): cut it at kModelDeadline and answer with status deadline", waited, out.status);
  ctx.GRPC.SetLatency("Complete", 8, config::kModelAddr);
  started = ctx.Clock.Now();
  out = loopRun({"read_reports"}, kEndless, "analytics", "t-2");
  waited = static_cast<double>(ctx.Clock.Now() - started) / 1000;
  ctx.Assert(waited <= 30.5, "a model that takes 8 s per call held the loop %.0f s: the whole loop has kLoopBudget = 30 s", waited);
  ctx.Equal(out.status, "deadline", "a loop that ran out of time; status");
}

void CheckScopeGate(harness::Ctx& ctx) {
  loopWorld(ctx);
  auto out = loopRun({"read_customers"}, kForm, "products", "t-1");
  ctx.Equal(loopInvoked, std::vector<std::string>{}, "a staff account with only read_customers: fill_product_form needs write_products; invoked");
  ctx.Equal(out.tools_used, std::vector<std::string>{}, "tools_used when the call was refused");
  const auto all = loopRequests(ctx);
  const sidekickrpc::Message* told = nullptr;
  for (const auto& m : all.back().messages()) {
    if (m.role() == "tool") told = &m;
  }
  ctx.Assert(told != nullptr && told->content() == catalog::kPermissionDenied && told->tool_name() == "fill_product_form",
             "the model must hear PERMISSION_DENIED for fill_product_form after the refused call");
  loopRun({"read_customers", "write_products"}, "delete my shop", "home", "t-2");
  ctx.Equal(loopInvoked, std::vector<std::string>{}, "delete_shop is not in the catalog; invoked");
  out = loopRun({"read_customers", "write_products"}, kForm, "products", "t-3");
  ctx.Assert(loopInvoked == std::vector<std::string>{"fill_product_form"} && out.tools_used.size() == 1, "with write_products the form is filled once: invoked %v", loopInvoked);
}
`,
  },
  hints: [
    'Symptom: since the catalog grew the assistant picks the wrong tool more often, a conversation about weekly sales spins for minutes, and a staff account that can only read customers filled in a product form.',
    "Mechanism: every tool's guidance is concatenated into the system prompt and the tool descriptions on every call; `while True` ends only when the model answers in text; `Complete` has no deadline; the tool name goes to `invoke_tool` unchecked.",
    'Change: `system_prompt=SYSTEM_PROMPT` and bare name/description specs; set `instructions = tool.instructions` after an invoke and send it once; `for _ in range(MAX_TURNS)` with `timeout=min(MODEL_DEADLINE_S, remaining)`; refuse unknown tools and a missing `required_scope` with `PERMISSION_DENIED`.',
  ],
  debrief: `Each change keeps the loop's context proportional to what the turn needs. A constant system prompt stays cacheable and stops guidance for forty tools from competing in every call; just-in-time instructions put a tool's rules next to the result they govern, once. The turn cap and the two time limits bound what one conversation can cost, and \`turn_limit\` or \`deadline\` in the outcome lets the caller say so instead of hanging. The scope gate belongs in the loop because the model proposes and the server disposes: a tool name is untrusted input. Production loops also summarise or drop old tool results as the transcript grows, and log which instructions were sent with which call so a wrong answer can be traced to its guidance.`,
};
