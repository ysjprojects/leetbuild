import type {Step} from '@/lib/types';

export const agentLoopStep: Step = {
  id: 'agent-loop',
  title: 'The agentic loop: just-in-time instructions, bounded turns',
  concept: 'grpc',
  file: 'agent_loop',
  focus: ['api', 'model', 'tools'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft of the loop behind every
assist turn: the model reads the conversation, picks a tool or answers, the tool runs, the result
goes back to the model. It works on the demo. It hides four production flaws — one of them is the
exact failure Shopify's Sidekick team describes as *death by a thousand instructions*. Review it, fix
it, and prove the fix.

Implement \`run_agent(shop, scopes, message, page)\` over two gRPC services: \`Model.Complete\`
(\`system\`, \`messages\`, \`tools\`, \`instructions\` → text or a \`tool_call\`) and
\`Tools.Invoke\` (\`shop\`, \`name\`, \`args_json\` → \`result_json\`).

- The **system prompt is a constant** (\`SYSTEM_PROMPT\`): fundamental agent behaviour only. It is
  sent unchanged on every turn, so the provider's prompt cache keeps hitting.
- The model sees a **compact tool list** each turn — a name and a one-line description per tool —
  never the tools' instructions.
- **Just-in-time instructions**: when the model calls a tool, that tool's instructions travel back
  with the tool's result, in the \`instructions\` field of the **next** \`Complete\` call only, and
  are cleared afterwards. A tool the merchant never uses never costs a token.
- The loop is bounded: at most **\`MAX_TURNS = 6\`** model turns, a **10 s** deadline on every
  \`Complete\` and \`Invoke\` call, and a **30 s** budget for the whole loop. When either runs out,
  return a short reply saying so, with the tools used so far.
- **Scope gate**: a tool call whose \`required_scope\` is not in the merchant's scopes (or an
  unknown tool name) is **not invoked**. Append a \`PERMISSION_DENIED\` tool result so the model can
  explain and move on.

**Failure mode the checks target.** A system prompt that concatenates every tool's guidance grows
with every tool, conflicts with itself, breaks the prompt cache on every edit, and still gets the
model to pick the wrong tool; an unbounded loop with no deadline lets one looping conversation pin
a worker and a budget; and a loop that invokes whatever the model names turns a read-only staff
account into a product editor.`,
  sequence: {
    participants: ['sidekick API', 'Model', 'Tools'],
    messages: [
      {from: 'sidekick API', to: 'Model', label: 'Complete(system, messages, tools[name+desc]) · 10 s', kind: 'sync'},
      {from: 'Model', to: 'sidekick API', label: 'tool_call segment_customers {city: Toronto}', kind: 'reply'},
      {from: 'sidekick API', to: 'sidekick API', label: 'required_scope read_customers ∈ scopes?', kind: 'sync'},
      {from: 'sidekick API', to: 'Tools', label: 'Invoke(shop, segment_customers, args) · 10 s', kind: 'sync'},
      {from: 'Tools', to: 'sidekick API', label: 'result_json', kind: 'reply'},
      {
        from: 'sidekick API',
        to: 'Model',
        label: 'Complete(… + tool result, instructions = segment_customers guidance)',
        kind: 'sync',
      },
      {from: 'Model', to: 'sidekick API', label: 'text: "14 customers are from Toronto …"', kind: 'reply'},
    ],
  },
  hints: [
    'Split the three things the draft stuffs into one prompt: a constant `SYSTEM_PROMPT` (sent as-is), a `ToolSpec(name, description)` list the model sees every turn, and each tool’s `instructions`, which only exist to be handed back when that tool fires.',
    'Keep a `jit_instructions` variable: set it from the invoked tool after a successful `Invoke`, pass it in the next `Complete` request’s `instructions` field, then reset it to empty. The conversation messages carry the tool result; the instructions ride alongside, for one turn.',
    'Bound the loop three ways: `for _ in range(MAX_TURNS)` instead of `while True`, `timeout=` on every stub call, and an elapsed-time check against `LOOP_BUDGET_S` at the top of each turn. Before invoking, look the tool up and compare its `required_scope` with the merchant’s scopes; on a miss, append a `PERMISSION_DENIED` tool message instead of calling anything.',
  ],
  checks: [
    {
      id: 'stable-system',
      title: 'Sends the constant system prompt unchanged',
      detail:
        'The `system` field is `SYSTEM_PROMPT` itself — never `SYSTEM_PROMPT` concatenated with tool text. A system prompt that grows with the tool registry is the "death by a thousand instructions" the source describes, and it defeats the provider’s prompt cache on every change.',
      match: {
        python: {all: [/system\s*=\s*SYSTEM_PROMPT\s*,/], none: [/SYSTEM_PROMPT\s*\+/]},
        typescript: {all: [/system:\s*SYSTEM_PROMPT\s*,/], none: [/SYSTEM_PROMPT\s*\+/]},
        go: {all: [/System:\s*systemPrompt\s*,/], none: [/systemPrompt\s*\+/]},
        scala: {all: [/system\s*=\s*SystemPrompt\s*,/], none: [/SystemPrompt\s*\+/]},
        cpp: {all: [/set_system\(\s*kSystemPrompt\s*\)/], none: [/kSystemPrompt\s*\+/]},
      },
    },
    {
      id: 'jit-instructions',
      title: 'Injects a tool’s instructions only when that tool fires',
      detail:
        'A `jit_instructions` value is set from the invoked tool and passed as the next `Complete` request’s `instructions`; no code path joins every tool’s instructions into the prompt or the tool list. The draft dumps all of them into the system prompt and the tool descriptions.',
      match: {
        python: {all: [/jit_instructions/, /instructions\s*=\s*jit_instructions/], none: [/\.instructions for /]},
        typescript: {all: [/jitInstructions/, /instructions:\s*jitInstructions/], none: [/=>\s*\w+\.instructions\b/]},
        go: {all: [/jitInstructions/, /Instructions:\s*jitInstructions/], none: [/append\([^)]*\.Instructions/]},
        scala: {all: [/jitInstructions/, /instructions\s*=\s*jitInstructions/], none: [/map\(_\.instructions\)/]},
        cpp: {
          all: [/jit_instructions/, /set_instructions\(\s*jit_instructions\s*\)/],
          none: [/\+=\s*[^;]*\.instructions/],
        },
      },
    },
    {
      id: 'bounded-turns',
      title: 'At most six model turns, no unbounded loop',
      detail:
        'Turns are bounded by `MAX_TURNS = 6` in a counted loop; there is no `while True` / `for {}`. The draft loops until the model stops calling tools, which a confused model never does.',
      match: {
        python: {all: [/MAX_TURNS\s*=\s*6/, /range\(MAX_TURNS\)/], none: [/while\s+True/]},
        typescript: {
          all: [/MAX_TURNS\s*=\s*6/, /turn\s*<\s*MAX_TURNS/],
          none: [/while\s*\(\s*true\s*\)/, /for\s*\(\s*;\s*;\s*\)/],
        },
        go: {all: [/maxTurns\s*=\s*6/, /turn\s*<\s*maxTurns/], none: [/\bfor\s*\{/]},
        scala: {all: [/MaxTurns\s*=\s*6/, /turn\s*<\s*MaxTurns/], none: [/while\s*\(\s*true\s*\)/]},
        cpp: {all: [/kMaxTurns\s*=\s*6/, /turn\s*<\s*kMaxTurns/], none: [/while\s*\(\s*true\s*\)/]},
      },
    },
    {
      id: 'deadline',
      title: 'Deadline per call, budget per loop',
      detail:
        'Every `Complete` and `Invoke` call carries a 10 s deadline (`MODEL_DEADLINE_S` / `MODEL_DEADLINE_MS`), and the loop stops after `LOOP_BUDGET_S = 30` seconds elapsed. Without them one stuck tool holds the worker and the merchant’s turn open indefinitely.',
      match: {
        python: {all: [/MODEL_DEADLINE_S\s*=\s*10/, /timeout\s*=\s*MODEL_DEADLINE_S/, /LOOP_BUDGET_S\s*=\s*30/]},
        typescript: {
          all: [
            /MODEL_DEADLINE_MS\s*=\s*10_?000/,
            /deadline:\s*Date\.now\(\)\s*\+\s*MODEL_DEADLINE_MS/,
            /LOOP_BUDGET_MS\s*=\s*30_?000/,
          ],
        },
        go: {all: [/modelDeadlineMS\s*=\s*10000/, /context\.WithTimeout/, /loopBudgetMS\s*=\s*30000/]},
        scala: {
          all: [/ModelDeadlineMs\s*=\s*10000/, /withDeadlineAfter\(\s*ModelDeadlineMs/, /LoopBudgetMs\s*=\s*30000/],
        },
        cpp: {all: [/kModelDeadlineMs\s*=\s*10000/, /set_deadline\(/, /kLoopBudgetMs\s*=\s*30000/]},
      },
    },
    {
      id: 'scope-gate',
      title: 'Refuses tools outside the merchant’s scopes',
      detail:
        'Before `Invoke`, the tool is looked up and its `required_scope` checked against the scopes attached in step 1; a miss appends a `PERMISSION_DENIED` tool result and never invokes. The draft invokes whatever name the model produces.',
      match: {
        python: {all: [/\.required_scope not in scopes/, /PERMISSION_DENIED/]},
        typescript: {all: [/scopes\.includes\(\s*\w+\.requiredScope\s*\)/, /PERMISSION_DENIED/]},
        go: {all: [/slices\.Contains\(\s*scopes,\s*\w+\.RequiredScope\s*\)/, /PERMISSION_DENIED/]},
        scala: {all: [/scopes\.contains\(\s*\w+\.requiredScope\s*\)/, /PERMISSION_DENIED/]},
        cpp: {all: [/\w+(->|\.)requiredScope\s*\)/, /PERMISSION_DENIED/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time
from dataclasses import dataclass, field

import grpc

import sidekick_pb2
import sidekick_pb2_grpc

SYSTEM_PROMPT = (
    "You are Sidekick, the assistant inside this merchant's Shopify admin. "
    "Answer from the merchant's own data, use one tool at a time, and stop when the task is done."
)


@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    required_scope: str
    instructions: str


TOOLS = {
    tool.name: tool
    for tool in (
        Tool(
            "segment_customers",
            "Filter the shop's customers by attribute.",
            "read_customers",
            "Filters use customer fields, never tags as a catch-all: 'status enabled' means "
            "customer_account_status = 'ENABLED'. Cities match default_address.city case-insensitively.",
        ),
        Tool(
            "fill_product_form",
            "Fill fields of the product form on the open page.",
            "write_products",
            "Fill only the fields the merchant asked for. SEO descriptions are at most 160 characters "
            "and never invent product facts.",
        ),
        Tool(
            "query_analytics",
            "Answer a sales or sessions question over a date range.",
            "read_analytics",
            "Date ranges default to the last 30 days; report totals in the shop's currency.",
        ),
    )
}

model = sidekick_pb2_grpc.ModelStub(grpc.insecure_channel("model:9000"))
tools = sidekick_pb2_grpc.ToolsStub(grpc.insecure_channel("tools:9000"))


@dataclass
class Outcome:
    reply: str
    tools_used: list[str] = field(default_factory=list)


def run_agent(shop: str, scopes: list[str], message: str, page: str) -> Outcome:
    # TODO: this draft dumps every tool's instructions into the system prompt and the tool list,
    # loops until the model stops calling tools, sets no deadline, and invokes any tool the model
    # names. Review all four.
    system = SYSTEM_PROMPT + "\\n\\n" + "\\n\\n".join(t.instructions for t in TOOLS.values())
    specs = [
        sidekick_pb2.ToolSpec(name=t.name, description=t.description + "\\n" + t.instructions)
        for t in TOOLS.values()
    ]
    messages = [sidekick_pb2.Message(role="user", content=f"[page: {page}] {message}")]
    used: list[str] = []
    while True:
        reply = model.Complete(sidekick_pb2.CompleteRequest(system=system, messages=messages, tools=specs))
        if not reply.HasField("tool_call"):
            return Outcome(reply=reply.text, tools_used=used)
        call = reply.tool_call
        result = tools.Invoke(sidekick_pb2.InvokeRequest(shop=shop, name=call.name, args_json=call.args_json))
        used.append(call.name)
        messages.append(sidekick_pb2.Message(role="tool", tool_name=call.name, content=result.result_json))
        time.sleep(0)
`,
      solution: `import json
import time
from dataclasses import dataclass, field

import grpc

import sidekick_pb2
import sidekick_pb2_grpc

MAX_TURNS = 6
MODEL_DEADLINE_S = 10.0
LOOP_BUDGET_S = 30.0

SYSTEM_PROMPT = (
    "You are Sidekick, the assistant inside this merchant's Shopify admin. "
    "Answer from the merchant's own data, use one tool at a time, and stop when the task is done."
)


@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    required_scope: str
    instructions: str


TOOLS = {
    tool.name: tool
    for tool in (
        Tool(
            "segment_customers",
            "Filter the shop's customers by attribute.",
            "read_customers",
            "Filters use customer fields, never tags as a catch-all: 'status enabled' means "
            "customer_account_status = 'ENABLED'. Cities match default_address.city case-insensitively.",
        ),
        Tool(
            "fill_product_form",
            "Fill fields of the product form on the open page.",
            "write_products",
            "Fill only the fields the merchant asked for. SEO descriptions are at most 160 characters "
            "and never invent product facts.",
        ),
        Tool(
            "query_analytics",
            "Answer a sales or sessions question over a date range.",
            "read_analytics",
            "Date ranges default to the last 30 days; report totals in the shop's currency.",
        ),
    )
}

model = sidekick_pb2_grpc.ModelStub(grpc.insecure_channel("model:9000"))
tools = sidekick_pb2_grpc.ToolsStub(grpc.insecure_channel("tools:9000"))


@dataclass
class Outcome:
    reply: str
    tools_used: list[str] = field(default_factory=list)


def tool_specs() -> list[sidekick_pb2.ToolSpec]:
    """The compact list the model sees every turn: a name and one line each, never the instructions."""
    return [sidekick_pb2.ToolSpec(name=t.name, description=t.description) for t in TOOLS.values()]


def run_agent(shop: str, scopes: list[str], message: str, page: str) -> Outcome:
    started = time.monotonic()
    messages = [sidekick_pb2.Message(role="user", content=f"[page: {page}] {message}")]
    used: list[str] = []
    jit_instructions = ""
    for _ in range(MAX_TURNS):
        if time.monotonic() - started > LOOP_BUDGET_S:
            break
        request = sidekick_pb2.CompleteRequest(
            system=SYSTEM_PROMPT,
            messages=messages,
            tools=tool_specs(),
            instructions=jit_instructions,
        )
        reply = model.Complete(request, timeout=MODEL_DEADLINE_S)
        jit_instructions = ""
        if not reply.HasField("tool_call"):
            return Outcome(reply=reply.text, tools_used=used)

        call = reply.tool_call
        tool = TOOLS.get(call.name)
        if tool is None or tool.required_scope not in scopes:
            denied = json.dumps({"error": "PERMISSION_DENIED", "tool": call.name})
            messages.append(sidekick_pb2.Message(role="tool", tool_name=call.name, content=denied))
            continue
        result = tools.Invoke(
            sidekick_pb2.InvokeRequest(shop=shop, name=call.name, args_json=call.args_json),
            timeout=MODEL_DEADLINE_S,
        )
        used.append(call.name)
        messages.append(sidekick_pb2.Message(role="tool", tool_name=call.name, content=result.result_json))
        jit_instructions = tool.instructions
    return Outcome(reply="I couldn't finish that in this turn. Try a narrower request.", tools_used=used)
`,
    },
    typescript: {
      starter: `/** The agentic loop: a model-generated draft that puts every tool's instructions in the system prompt. */
import {model, tools, type Message} from './clients';

const SYSTEM_PROMPT =
  "You are Sidekick, the assistant inside this merchant's Shopify admin. " +
  "Answer from the merchant's own data, use one tool at a time, and stop when the task is done.";

interface Tool {
  name: string;
  description: string;
  requiredScope: string;
  instructions: string;
}

const TOOLS: Record<string, Tool> = {
  segment_customers: {
    name: 'segment_customers',
    description: "Filter the shop's customers by attribute.",
    requiredScope: 'read_customers',
    instructions:
      "Filters use customer fields, never tags as a catch-all: 'status enabled' means " +
      "customer_account_status = 'ENABLED'. Cities match default_address.city case-insensitively.",
  },
  fill_product_form: {
    name: 'fill_product_form',
    description: 'Fill fields of the product form on the open page.',
    requiredScope: 'write_products',
    instructions:
      'Fill only the fields the merchant asked for. SEO descriptions are at most 160 characters ' +
      'and never invent product facts.',
  },
  query_analytics: {
    name: 'query_analytics',
    description: 'Answer a sales or sessions question over a date range.',
    requiredScope: 'read_analytics',
    instructions: "Date ranges default to the last 30 days; report totals in the shop's currency.",
  },
};

export interface Outcome {
  reply: string;
  toolsUsed: string[];
}

export async function runAgent(input: {
  shop: string;
  scopes: string[];
  message: string;
  page: string;
}): Promise<Outcome> {
  // TODO: this draft dumps every tool's instructions into the system prompt and the tool list,
  // loops until the model stops calling tools, sets no deadline, and invokes any tool the model
  // names. Review all four.
  const system = SYSTEM_PROMPT + '\\n\\n' + Object.values(TOOLS).map(t => t.instructions).join('\\n\\n');
  const specs = Object.values(TOOLS).map(t => ({name: t.name, description: t.description + '\\n' + t.instructions}));
  const messages: Message[] = [{role: 'user', content: \`[page: \${input.page}] \${input.message}\`}];
  const used: string[] = [];
  for (;;) {
    const reply = await model.Complete({system, messages, tools: specs, instructions: ''});
    if (reply.tool_call === undefined) return {reply: reply.text, toolsUsed: used};
    const call = reply.tool_call;
    const result = await tools.Invoke({shop: input.shop, name: call.name, args_json: call.args_json});
    used.push(call.name);
    messages.push({role: 'tool', tool_name: call.name, content: result.result_json});
  }
}
`,
      solution: `/** The agentic loop: a stable system prompt, a compact tool list, just-in-time instructions, bounded turns. */
import {model, tools, type Message} from './clients';

const MAX_TURNS = 6;
const MODEL_DEADLINE_MS = 10_000;
const LOOP_BUDGET_MS = 30_000;

const SYSTEM_PROMPT =
  "You are Sidekick, the assistant inside this merchant's Shopify admin. " +
  "Answer from the merchant's own data, use one tool at a time, and stop when the task is done.";

interface Tool {
  name: string;
  description: string;
  requiredScope: string;
  instructions: string;
}

const TOOLS: Record<string, Tool> = {
  segment_customers: {
    name: 'segment_customers',
    description: "Filter the shop's customers by attribute.",
    requiredScope: 'read_customers',
    instructions:
      "Filters use customer fields, never tags as a catch-all: 'status enabled' means " +
      "customer_account_status = 'ENABLED'. Cities match default_address.city case-insensitively.",
  },
  fill_product_form: {
    name: 'fill_product_form',
    description: 'Fill fields of the product form on the open page.',
    requiredScope: 'write_products',
    instructions:
      'Fill only the fields the merchant asked for. SEO descriptions are at most 160 characters ' +
      'and never invent product facts.',
  },
  query_analytics: {
    name: 'query_analytics',
    description: 'Answer a sales or sessions question over a date range.',
    requiredScope: 'read_analytics',
    instructions: "Date ranges default to the last 30 days; report totals in the shop's currency.",
  },
};

/** The compact list the model sees every turn: a name and one line each, never the instructions. */
const TOOL_SPECS = Object.values(TOOLS).map(t => ({name: t.name, description: t.description}));

export interface Outcome {
  reply: string;
  toolsUsed: string[];
}

export async function runAgent(input: {
  shop: string;
  scopes: string[];
  message: string;
  page: string;
}): Promise<Outcome> {
  const started = Date.now();
  const messages: Message[] = [{role: 'user', content: \`[page: \${input.page}] \${input.message}\`}];
  const used: string[] = [];
  let jitInstructions = '';
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (Date.now() - started > LOOP_BUDGET_MS) break;
    const reply = await model.Complete(
      {system: SYSTEM_PROMPT, messages, tools: TOOL_SPECS, instructions: jitInstructions},
      {deadline: Date.now() + MODEL_DEADLINE_MS},
    );
    jitInstructions = '';
    if (reply.tool_call === undefined) return {reply: reply.text, toolsUsed: used};

    const call = reply.tool_call;
    const tool = TOOLS[call.name];
    if (tool === undefined || !input.scopes.includes(tool.requiredScope)) {
      const denied = JSON.stringify({error: 'PERMISSION_DENIED', tool: call.name});
      messages.push({role: 'tool', tool_name: call.name, content: denied});
      continue;
    }
    const result = await tools.Invoke(
      {shop: input.shop, name: call.name, args_json: call.args_json},
      {deadline: Date.now() + MODEL_DEADLINE_MS},
    );
    used.push(call.name);
    messages.push({role: 'tool', tool_name: call.name, content: result.result_json});
    jitInstructions = tool.instructions;
  }
  return {reply: "I couldn't finish that in this turn. Try a narrower request.", toolsUsed: used};
}
`,
    },
    go: {
      starter: `package agent

import (
	"context"
	"fmt"
	"strings"

	pb "sidekick/sidekickpb"
)

const systemPrompt = "You are Sidekick, the assistant inside this merchant's Shopify admin. " +
	"Answer from the merchant's own data, use one tool at a time, and stop when the task is done."

type Tool struct {
	Name          string
	Description   string
	RequiredScope string
	Instructions  string
}

var tools = map[string]Tool{
	"segment_customers": {
		Name:          "segment_customers",
		Description:   "Filter the shop's customers by attribute.",
		RequiredScope: "read_customers",
		Instructions: "Filters use customer fields, never tags as a catch-all: 'status enabled' means " +
			"customer_account_status = 'ENABLED'. Cities match default_address.city case-insensitively.",
	},
	"fill_product_form": {
		Name:          "fill_product_form",
		Description:   "Fill fields of the product form on the open page.",
		RequiredScope: "write_products",
		Instructions: "Fill only the fields the merchant asked for. SEO descriptions are at most 160 characters " +
			"and never invent product facts.",
	},
	"query_analytics": {
		Name:          "query_analytics",
		Description:   "Answer a sales or sessions question over a date range.",
		RequiredScope: "read_analytics",
		Instructions:  "Date ranges default to the last 30 days; report totals in the shop's currency.",
	},
}

var (
	model    pb.ModelClient
	toolsRPC pb.ToolsClient
)

type Outcome struct {
	Reply     string
	ToolsUsed []string
}

// TODO: this draft dumps every tool's instructions into the system prompt and the tool list, loops
// until the model stops calling tools, sets no deadline, and invokes any tool the model names.
// Review all four.
func Run(ctx context.Context, shop string, scopes []string, message, page string) (Outcome, error) {
	var parts []string
	var specs []*pb.ToolSpec
	for _, t := range tools {
		parts = append(parts, t.Instructions)
		specs = append(specs, &pb.ToolSpec{Name: t.Name, Description: t.Description + "\\n" + t.Instructions})
	}
	system := systemPrompt + "\\n\\n" + strings.Join(parts, "\\n\\n")
	messages := []*pb.Message{{Role: "user", Content: fmt.Sprintf("[page: %s] %s", page, message)}}
	var used []string
	for {
		reply, err := model.Complete(ctx, &pb.CompleteRequest{System: system, Messages: messages, Tools: specs})
		if err != nil {
			return Outcome{}, err
		}
		if reply.ToolCall == nil {
			return Outcome{Reply: reply.Text, ToolsUsed: used}, nil
		}
		call := reply.ToolCall
		result, err := toolsRPC.Invoke(ctx, &pb.InvokeRequest{Shop: shop, Name: call.Name, ArgsJson: call.ArgsJson})
		if err != nil {
			return Outcome{}, err
		}
		used = append(used, call.Name)
		messages = append(messages, &pb.Message{Role: "tool", ToolName: call.Name, Content: result.ResultJson})
	}
}
`,
      solution: `package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"time"

	pb "sidekick/sidekickpb"
)

const (
	maxTurns        = 6
	modelDeadlineMS = 10000
	loopBudgetMS    = 30000
)

const systemPrompt = "You are Sidekick, the assistant inside this merchant's Shopify admin. " +
	"Answer from the merchant's own data, use one tool at a time, and stop when the task is done."

type Tool struct {
	Name          string
	Description   string
	RequiredScope string
	Instructions  string
}

var tools = map[string]Tool{
	"segment_customers": {
		Name:          "segment_customers",
		Description:   "Filter the shop's customers by attribute.",
		RequiredScope: "read_customers",
		Instructions: "Filters use customer fields, never tags as a catch-all: 'status enabled' means " +
			"customer_account_status = 'ENABLED'. Cities match default_address.city case-insensitively.",
	},
	"fill_product_form": {
		Name:          "fill_product_form",
		Description:   "Fill fields of the product form on the open page.",
		RequiredScope: "write_products",
		Instructions: "Fill only the fields the merchant asked for. SEO descriptions are at most 160 characters " +
			"and never invent product facts.",
	},
	"query_analytics": {
		Name:          "query_analytics",
		Description:   "Answer a sales or sessions question over a date range.",
		RequiredScope: "read_analytics",
		Instructions:  "Date ranges default to the last 30 days; report totals in the shop's currency.",
	},
}

var (
	model    pb.ModelClient
	toolsRPC pb.ToolsClient
)

type Outcome struct {
	Reply     string
	ToolsUsed []string
}

// toolSpecs is the compact list the model sees every turn: a name and one line each, never the instructions.
func toolSpecs() []*pb.ToolSpec {
	specs := make([]*pb.ToolSpec, 0, len(tools))
	for _, t := range tools {
		specs = append(specs, &pb.ToolSpec{Name: t.Name, Description: t.Description})
	}
	return specs
}

func complete(ctx context.Context, request *pb.CompleteRequest) (*pb.CompleteReply, error) {
	callCtx, cancel := context.WithTimeout(ctx, modelDeadlineMS*time.Millisecond)
	defer cancel()
	return model.Complete(callCtx, request)
}

func invoke(ctx context.Context, request *pb.InvokeRequest) (*pb.InvokeReply, error) {
	callCtx, cancel := context.WithTimeout(ctx, modelDeadlineMS*time.Millisecond)
	defer cancel()
	return toolsRPC.Invoke(callCtx, request)
}

func Run(ctx context.Context, shop string, scopes []string, message, page string) (Outcome, error) {
	started := time.Now()
	messages := []*pb.Message{{Role: "user", Content: fmt.Sprintf("[page: %s] %s", page, message)}}
	var used []string
	jitInstructions := ""
	for turn := 0; turn < maxTurns; turn++ {
		if time.Since(started) > loopBudgetMS*time.Millisecond {
			break
		}
		reply, err := complete(ctx, &pb.CompleteRequest{
			System:       systemPrompt,
			Messages:     messages,
			Tools:        toolSpecs(),
			Instructions: jitInstructions,
		})
		if err != nil {
			return Outcome{}, err
		}
		jitInstructions = ""
		if reply.ToolCall == nil {
			return Outcome{Reply: reply.Text, ToolsUsed: used}, nil
		}

		call := reply.ToolCall
		tool, known := tools[call.Name]
		if !known || !slices.Contains(scopes, tool.RequiredScope) {
			denied, _ := json.Marshal(map[string]string{"error": "PERMISSION_DENIED", "tool": call.Name})
			messages = append(messages, &pb.Message{Role: "tool", ToolName: call.Name, Content: string(denied)})
			continue
		}
		result, err := invoke(ctx, &pb.InvokeRequest{Shop: shop, Name: call.Name, ArgsJson: call.ArgsJson})
		if err != nil {
			return Outcome{}, err
		}
		used = append(used, call.Name)
		messages = append(messages, &pb.Message{Role: "tool", ToolName: call.Name, Content: result.ResultJson})
		jitInstructions = tool.Instructions
	}
	return Outcome{Reply: "I couldn't finish that in this turn. Try a narrower request.", ToolsUsed: used}, nil
}
`,
    },
    scala: {
      starter: `import io.grpc.ManagedChannelBuilder
import scala.collection.mutable.ArrayBuffer

object Agent {
  val SystemPrompt =
    "You are Sidekick, the assistant inside this merchant's Shopify admin. " +
      "Answer from the merchant's own data, use one tool at a time, and stop when the task is done."

  final case class Tool(name: String, description: String, requiredScope: String, instructions: String)

  val Tools: Map[String, Tool] = List(
    Tool(
      "segment_customers",
      "Filter the shop's customers by attribute.",
      "read_customers",
      "Filters use customer fields, never tags as a catch-all: 'status enabled' means " +
        "customer_account_status = 'ENABLED'. Cities match default_address.city case-insensitively."
    ),
    Tool(
      "fill_product_form",
      "Fill fields of the product form on the open page.",
      "write_products",
      "Fill only the fields the merchant asked for. SEO descriptions are at most 160 characters " +
        "and never invent product facts."
    ),
    Tool(
      "query_analytics",
      "Answer a sales or sessions question over a date range.",
      "read_analytics",
      "Date ranges default to the last 30 days; report totals in the shop's currency."
    )
  ).map(t => t.name -> t).toMap

  final case class Outcome(reply: String, toolsUsed: List[String])

  val model = ModelGrpc.blockingStub(ManagedChannelBuilder.forAddress("model", 9000).usePlaintext().build())
  val tools = ToolsGrpc.blockingStub(ManagedChannelBuilder.forAddress("tools", 9000).usePlaintext().build())

  // TODO: this draft dumps every tool's instructions into the system prompt and the tool list, loops
  // until the model stops calling tools, sets no deadline, and invokes any tool the model names.
  // Review all four.
  def run(shop: String, scopes: List[String], message: String, page: String): Outcome = {
    val systemPrompt = SystemPrompt + "\\n\\n" + Tools.values.map(_.instructions).mkString("\\n\\n")
    val specs = Tools.values.map(t => ToolSpec(name = t.name, description = t.description + "\\n" + t.instructions)).toSeq
    val messages = ArrayBuffer(Message(role = "user", content = s"[page: $page] $message"))
    val used = ArrayBuffer.empty[String]
    while (true) {
      val reply = model.complete(CompleteRequest(system = systemPrompt, messages = messages.toSeq, tools = specs))
      reply.toolCall match {
        case None => return Outcome(reply.text, used.toList)
        case Some(call) =>
          val result = tools.invoke(InvokeRequest(shop = shop, name = call.name, argsJson = call.argsJson))
          used += call.name
          messages += Message(role = "tool", toolName = call.name, content = result.resultJson)
      }
    }
    Outcome("", used.toList)
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.ManagedChannelBuilder
import scala.collection.mutable.ArrayBuffer

object Agent {
  val MaxTurns = 6
  val ModelDeadlineMs = 10000L
  val LoopBudgetMs = 30000L

  val SystemPrompt =
    "You are Sidekick, the assistant inside this merchant's Shopify admin. " +
      "Answer from the merchant's own data, use one tool at a time, and stop when the task is done."

  final case class Tool(name: String, description: String, requiredScope: String, instructions: String)

  val Tools: Map[String, Tool] = List(
    Tool(
      "segment_customers",
      "Filter the shop's customers by attribute.",
      "read_customers",
      "Filters use customer fields, never tags as a catch-all: 'status enabled' means " +
        "customer_account_status = 'ENABLED'. Cities match default_address.city case-insensitively."
    ),
    Tool(
      "fill_product_form",
      "Fill fields of the product form on the open page.",
      "write_products",
      "Fill only the fields the merchant asked for. SEO descriptions are at most 160 characters " +
        "and never invent product facts."
    ),
    Tool(
      "query_analytics",
      "Answer a sales or sessions question over a date range.",
      "read_analytics",
      "Date ranges default to the last 30 days; report totals in the shop's currency."
    )
  ).map(t => t.name -> t).toMap

  // The compact list the model sees every turn: a name and one line each, never the instructions.
  val ToolSpecs: Seq[ToolSpec] = Tools.values.map(t => ToolSpec(name = t.name, description = t.description)).toSeq

  final case class Outcome(reply: String, toolsUsed: List[String])

  val model = ModelGrpc.blockingStub(ManagedChannelBuilder.forAddress("model", 9000).usePlaintext().build())
  val tools = ToolsGrpc.blockingStub(ManagedChannelBuilder.forAddress("tools", 9000).usePlaintext().build())

  def run(shop: String, scopes: List[String], message: String, page: String): Outcome = {
    val started = System.currentTimeMillis()
    val messages = ArrayBuffer(Message(role = "user", content = s"[page: $page] $message"))
    val used = ArrayBuffer.empty[String]
    var jitInstructions = ""
    var turn = 0
    while (turn < MaxTurns && System.currentTimeMillis() - started <= LoopBudgetMs) {
      val reply = model
        .withDeadlineAfter(ModelDeadlineMs, TimeUnit.MILLISECONDS)
        .complete(
          CompleteRequest(
            system = SystemPrompt,
            messages = messages.toSeq,
            tools = ToolSpecs,
            instructions = jitInstructions
          )
        )
      jitInstructions = ""
      reply.toolCall match {
        case None => return Outcome(reply.text, used.toList)
        case Some(call) =>
          Tools.get(call.name) match {
            case Some(tool) if scopes.contains(tool.requiredScope) =>
              val result = tools
                .withDeadlineAfter(ModelDeadlineMs, TimeUnit.MILLISECONDS)
                .invoke(InvokeRequest(shop = shop, name = call.name, argsJson = call.argsJson))
              used += call.name
              messages += Message(role = "tool", toolName = call.name, content = result.resultJson)
              jitInstructions = tool.instructions
            case _ =>
              val denied = s"""{"error":"PERMISSION_DENIED","tool":"\${call.name}"}"""
              messages += Message(role = "tool", toolName = call.name, content = denied)
          }
      }
      turn += 1
    }
    Outcome("I couldn't finish that in this turn. Try a narrower request.", used.toList)
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include "sidekick.grpc.pb.h"

#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

const std::string kSystemPrompt =
    "You are Sidekick, the assistant inside this merchant's Shopify admin. "
    "Answer from the merchant's own data, use one tool at a time, and stop when the task is done.";

struct Tool {
  std::string description;
  std::string requiredScope;
  std::string instructions;
};

const std::map<std::string, Tool> kTools = {
    {"segment_customers",
     {"Filter the shop's customers by attribute.", "read_customers",
      "Filters use customer fields, never tags as a catch-all: 'status enabled' means "
      "customer_account_status = 'ENABLED'. Cities match default_address.city case-insensitively."}},
    {"fill_product_form",
     {"Fill fields of the product form on the open page.", "write_products",
      "Fill only the fields the merchant asked for. SEO descriptions are at most 160 characters "
      "and never invent product facts."}},
    {"query_analytics",
     {"Answer a sales or sessions question over a date range.", "read_analytics",
      "Date ranges default to the last 30 days; report totals in the shop's currency."}},
};

struct AgentOutcome {
  std::string reply;
  std::vector<std::string> toolsUsed;
};

std::unique_ptr<sidekick::Model::Stub> model =
    sidekick::Model::NewStub(grpc::CreateChannel("model:9000", grpc::InsecureChannelCredentials()));
std::unique_ptr<sidekick::Tools::Stub> tools =
    sidekick::Tools::NewStub(grpc::CreateChannel("tools:9000", grpc::InsecureChannelCredentials()));

// TODO: this draft dumps every tool's instructions into the system prompt and the tool list, loops
// until the model stops calling tools, sets no deadline, and invokes any tool the model names.
// Review all four.
AgentOutcome runAgent(
    const std::string& shop,
    const std::vector<std::string>& scopes,
    const std::string& message,
    const std::string& page) {
  std::string system = kSystemPrompt;
  for (const auto& [name, tool] : kTools) system += "\\n\\n" + tool.instructions;
  std::vector<sidekick::Message> messages;
  sidekick::Message first;
  first.set_role("user");
  first.set_content("[page: " + page + "] " + message);
  messages.push_back(first);
  std::vector<std::string> used;
  while (true) {
    grpc::ClientContext ctx;
    sidekick::CompleteRequest request;
    request.set_system(system);
    for (const auto& m : messages) *request.add_messages() = m;
    for (const auto& [name, tool] : kTools) {
      auto* spec = request.add_tools();
      spec->set_name(name);
      spec->set_description(tool.description + "\\n" + tool.instructions);
    }
    sidekick::CompleteReply reply;
    const grpc::Status status = model->Complete(&ctx, request, &reply);
    if (!status.ok()) throw std::runtime_error("model failed: " + status.error_message());
    if (!reply.has_tool_call()) return {reply.text(), used};

    const auto& call = reply.tool_call();
    grpc::ClientContext toolCtx;
    sidekick::InvokeRequest invokeRequest;
    invokeRequest.set_shop(shop);
    invokeRequest.set_name(call.name());
    invokeRequest.set_args_json(call.args_json());
    sidekick::InvokeReply result;
    const grpc::Status invoked = tools->Invoke(&toolCtx, invokeRequest, &result);
    if (!invoked.ok()) throw std::runtime_error("tool failed: " + invoked.error_message());
    used.push_back(call.name());
    sidekick::Message toolMessage;
    toolMessage.set_role("tool");
    toolMessage.set_tool_name(call.name());
    toolMessage.set_content(result.result_json());
    messages.push_back(toolMessage);
  }
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include "sidekick.grpc.pb.h"

#include <algorithm>
#include <chrono>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

constexpr int kMaxTurns = 6;
constexpr int kModelDeadlineMs = 10000;
constexpr int kLoopBudgetMs = 30000;

const std::string kSystemPrompt =
    "You are Sidekick, the assistant inside this merchant's Shopify admin. "
    "Answer from the merchant's own data, use one tool at a time, and stop when the task is done.";

struct Tool {
  std::string description;
  std::string requiredScope;
  std::string instructions;
};

const std::map<std::string, Tool> kTools = {
    {"segment_customers",
     {"Filter the shop's customers by attribute.", "read_customers",
      "Filters use customer fields, never tags as a catch-all: 'status enabled' means "
      "customer_account_status = 'ENABLED'. Cities match default_address.city case-insensitively."}},
    {"fill_product_form",
     {"Fill fields of the product form on the open page.", "write_products",
      "Fill only the fields the merchant asked for. SEO descriptions are at most 160 characters "
      "and never invent product facts."}},
    {"query_analytics",
     {"Answer a sales or sessions question over a date range.", "read_analytics",
      "Date ranges default to the last 30 days; report totals in the shop's currency."}},
};

struct AgentOutcome {
  std::string reply;
  std::vector<std::string> toolsUsed;
};

std::unique_ptr<sidekick::Model::Stub> model =
    sidekick::Model::NewStub(grpc::CreateChannel("model:9000", grpc::InsecureChannelCredentials()));
std::unique_ptr<sidekick::Tools::Stub> tools =
    sidekick::Tools::NewStub(grpc::CreateChannel("tools:9000", grpc::InsecureChannelCredentials()));

std::chrono::system_clock::time_point deadline() {
  return std::chrono::system_clock::now() + std::chrono::milliseconds(kModelDeadlineMs);
}

sidekick::Message toolMessage(const std::string& name, const std::string& content) {
  sidekick::Message m;
  m.set_role("tool");
  m.set_tool_name(name);
  m.set_content(content);
  return m;
}

AgentOutcome runAgent(
    const std::string& shop,
    const std::vector<std::string>& scopes,
    const std::string& message,
    const std::string& page) {
  const auto started = std::chrono::steady_clock::now();
  std::vector<sidekick::Message> messages;
  sidekick::Message first;
  first.set_role("user");
  first.set_content("[page: " + page + "] " + message);
  messages.push_back(first);
  std::vector<std::string> used;
  std::string jit_instructions;
  for (int turn = 0; turn < kMaxTurns; turn++) {
    const auto elapsed = std::chrono::steady_clock::now() - started;
    if (std::chrono::duration_cast<std::chrono::milliseconds>(elapsed).count() > kLoopBudgetMs) break;

    grpc::ClientContext ctx;
    ctx.set_deadline(deadline());
    sidekick::CompleteRequest request;
    request.set_system(kSystemPrompt);
    for (const auto& m : messages) *request.add_messages() = m;
    for (const auto& [name, tool] : kTools) {
      auto* spec = request.add_tools();
      spec->set_name(name);
      spec->set_description(tool.description);
    }
    request.set_instructions(jit_instructions);
    sidekick::CompleteReply reply;
    const grpc::Status status = model->Complete(&ctx, request, &reply);
    if (!status.ok()) throw std::runtime_error("model failed: " + status.error_message());
    jit_instructions.clear();
    if (!reply.has_tool_call()) return {reply.text(), used};

    const auto& call = reply.tool_call();
    const auto tool = kTools.find(call.name());
    if (tool == kTools.end() || std::find(scopes.begin(), scopes.end(), tool->second.requiredScope) == scopes.end()) {
      messages.push_back(toolMessage(call.name(), R"({"error":"PERMISSION_DENIED","tool":")" + call.name() + "\\"}"));
      continue;
    }
    grpc::ClientContext toolCtx;
    toolCtx.set_deadline(deadline());
    sidekick::InvokeRequest invokeRequest;
    invokeRequest.set_shop(shop);
    invokeRequest.set_name(call.name());
    invokeRequest.set_args_json(call.args_json());
    sidekick::InvokeReply result;
    const grpc::Status invoked = tools->Invoke(&toolCtx, invokeRequest, &result);
    if (!invoked.ok()) throw std::runtime_error("tool failed: " + invoked.error_message());
    used.push_back(call.name());
    messages.push_back(toolMessage(call.name(), result.result_json()));
    jit_instructions = tool->second.instructions;
  }
  return {"I couldn't finish that in this turn. Try a narrower request.", used};
}
`,
    },
  },
  debrief: `The interviewer is testing whether you understand what an agent's context window is for. Sidekick's team hit it at scale: past twenty tools the boundaries blur, past fifty there are several ways to do everything, and a system prompt that tries to cover every case becomes a pile of conflicting special cases that slows the model and cannot be maintained. The fix is structural, not a better prompt: the system prompt holds fundamental behaviour and never changes (so the provider's prompt cache keeps hitting), the tool list is compact, and each tool's guidance is delivered just in time — alongside that tool's result, for the next turn only. The other three flaws are the ones every generated loop has: no turn bound, no deadline, and no check that the tool the model picked is one this merchant's staff account may use. Real loops add per-tool argument schemas validated before invocation, instruction variants by beta flag, model version and page context (the source's modularity point), and a token budget per turn alongside the time budget.`,
};
