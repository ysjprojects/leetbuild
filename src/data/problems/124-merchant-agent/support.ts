/**
 * Hand-written support modules the merchant-agent steps import but no step builds: the `sidekick`
 * package, the same in every language. `config` is the contract (the peers' addresses, the trace
 * topic, what a model call reserves, the prompt version); `catalog` the tools the model may call, the
 * scope each needs and its guidance; `permissions` the merchant's staff scopes and `turns` the stored
 * turns (Redis); `outcome` what the loop returns; `evals` the judge rubrics, the schema validator and
 * Cohen's kappa; `gtx` the ground-truth set; `trace` the finished turn the trace path receives;
 * `outbox` where a refused trace goes. `model`, `tools` and `judge` are the deterministic stand-ins
 * the checks serve over gRPC.
 */
import {CPP_DIGEST_H, CPP_IDS_H} from '../cpp-support';
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'sidekick/__init__.py': '',
  'sidekick/config.py': `"""Addresses, topics and costs every step of sidekick agrees on."""
# The model, the admin's tools and the judges: stand-ins the checks serve over gRPC.
MODEL_ADDR = "model:9000"
TOOLS_ADDR = "tools:9000"
JUDGE_ADDR = "judge:9000"
# One trace event per assist turn, keyed by shop, for the gtx-builder.
TOPIC = "assist.trace"
# What one model call reserves from the shop's token budget.
TOKENS_PER_CALL = 2_000
# The version of the system prompt and the catalog a trace was produced with.
PROMPT_VERSION = "sk-prompt-14"
`,
  'sidekick/catalog.py': `"""The tool catalog (provided): every tool the model may call, the scope it needs, its guidance."""
from dataclasses import dataclass

# The tool result the loop sends back when it refuses a call.
PERMISSION_DENIED = "PERMISSION_DENIED"


@dataclass(frozen=True)
class Tool:
    name: str
    description: str  # one line: what the model sees in the tool list
    required_scope: str  # the staff permission the merchant must hold
    writes: bool  # True: the tool changes the shop
    instructions: str  # how to use it well: sent just in time, after the tool ran


CATALOG: dict[str, Tool] = {
    tool.name: tool
    for tool in (
        Tool(
            "segment_customers",
            "Find the customers that match a segment query.",
            "read_customers",
            False,
            "Write segments in the customer query language: customer_account_status = ENABLED, default_address_city = Toronto. Tags are free text, not a status.",
        ),
        Tool(
            "query_analytics",
            "Run a ShopifyQL query over the shop's sales.",
            "read_reports",
            False,
            "Use ShopifyQL: FROM sales SHOW total_sales SINCE -30d. Report the numbers as returned.",
        ),
        Tool(
            "search_products",
            "Search the shop's products by title.",
            "read_products",
            False,
            "Return product ids and titles; open a product by id before editing it.",
        ),
        Tool(
            "fill_product_form",
            "Fill fields of the product form the merchant has open.",
            "write_products",
            True,
            "Fill only the fields the merchant asked for and leave the form unsaved for the merchant to review.",
        ),
    )
}
`,
  'sidekick/permissions.py': `"""The permission store (provided): the scopes the merchant's staff account grants, the Redis set perms:{shop}."""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def scopes_for(shop: str) -> list[str]:
    """The shop's scopes, sorted (read_customers, write_products, ...); empty for an unknown shop."""
    return sorted(r.smembers(f"perms:{shop}"))
`,
  'sidekick/turns.py': `"""The turn store (provided): finished turns in Redis under turn:{shop}:{idem_key}, for a day."""
import json

import redis

TURN_TTL_S = 86_400

r = redis.Redis(host="redis", port=6379, decode_responses=True)


class TurnStore:
    def get(self, shop: str, idem_key: str) -> dict | None:
        """The turn stored for (shop, idem_key): {turn_id, reply, tools_used, status}; None when there is none."""
        raw = r.get(f"turn:{shop}:{idem_key}")
        return json.loads(raw) if raw else None

    def put(self, shop: str, idem_key: str, turn: dict) -> None:
        """Store the finished turn under (shop, idem_key)."""
        r.set(f"turn:{shop}:{idem_key}", json.dumps(turn), ex=TURN_TTL_S)


store = TurnStore()
`,
  'sidekick/trace.py': `"""A finished turn as the trace path receives it (provided). message and tool_results are merchant data."""
from dataclasses import dataclass


@dataclass
class TurnRecord:
    turn_id: str
    shop: str
    page: str
    message: str  # the merchant's words
    tools_used: list[str]
    tool_results: list[str]  # what the tools answered: customers, orders, products
    latency_ms: int
    tokens: int
    judge_score: float
`,
  'sidekick/outcome.py': `"""What the agent loop returns for one turn (provided)."""
from dataclasses import dataclass, field


@dataclass
class Outcome:
    reply: str
    tools_used: list[str] = field(default_factory=list)
    # done, turn_limit, deadline or over_budget
    status: str = "done"
`,
  'sidekick/evals.py': `"""Evaluation helpers (provided): the criteria and their rubrics, the schema validator, Cohen's kappa."""
import json
from dataclasses import dataclass, field

from sidekick.catalog import CATALOG

CRITERIA = ("correctness", "schema_compliance", "helpfulness")
# The written rubric each criterion's judge was calibrated with.
RUBRICS = {
    "correctness": "Score 1 if every tool call and every claim matches the shop's data and the merchant's request, else 0.",
    "schema_compliance": "Score 1 if every tool call uses the documented fields and operators, else 0.",
    "helpfulness": "Score 1 if the merchant's goal was reached without needless steps, else 0.",
}
# The fields a segment query may filter on.
SEGMENT_FIELDS = ("customer_account_status", "default_address_city", "amount_spent", "orders_count")


@dataclass
class ToolCall:
    name: str
    args_json: str


@dataclass
class Conversation:
    id: str
    turns: list[str]
    tool_calls: list[ToolCall]
    # criterion -> 0 or 1, on the human-labelled subset only
    human_labels: dict[str, int] = field(default_factory=dict)


@dataclass
class Decision:
    ship: bool
    means: dict[str, float]
    reason: str


def transcript(conversation: Conversation) -> str:
    """The whole conversation, turn by turn, as a judge reads it."""
    return "\\n".join(conversation.turns)


def validate_schema(call: ToolCall) -> bool:
    """Procedural validation: a known tool, JSON object arguments, a segment query on a documented field."""
    if call.name not in CATALOG:
        return False
    try:
        args = json.loads(call.args_json)
    except ValueError:
        return False
    if not isinstance(args, dict):
        return False
    if call.name == "segment_customers":
        query = args.get("query")
        return isinstance(query, str) and query.split(" ")[0] in SEGMENT_FIELDS
    return True


def cohen_kappa(a: list[int], b: list[int]) -> float:
    """Agreement of two raters' 0/1 labels beyond chance: 1 is perfect, 0 is what chance gives."""
    n = len(a)
    if n == 0 or n != len(b):
        return 0.0
    observed = sum(1 for x, y in zip(a, b) if x == y) / n
    pa, pb = sum(a) / n, sum(b) / n
    chance = pa * pb + (1 - pa) * (1 - pb)
    if chance == 1:
        return 1.0 if observed == 1 else 0.0
    return (observed - chance) / (1 - chance)
`,
  'sidekick/gtx.py': `"""
The ground-truth set (provided): conversations sampled from real merchant sessions and replayed through
a candidate version, the human labels on a subset, the scores of the last release (the baseline), and
the candidates the trace consumer adds. Redis: gtx:baseline (criterion -> score), gtx:release:{version}
(criterion -> mean), gtx:candidates (a list of JSON events).
"""
import json

import redis

from sidekick.evals import CRITERIA, Conversation, ToolCall

r = redis.Redis(host="redis", port=6379, decode_responses=True)

GOOD_CALL = ToolCall("segment_customers", '{"query":"default_address_city = Toronto"}')
TAG_CALL = ToolCall("segment_customers", '{"query":"customer_tags CONTAINS enabled"}')


def _conversation(version: str, i: int) -> Conversation:
    p = i % 20
    misses = []
    if p == 7 or (version == "v-early" and p in (1, 3, 5, 9, 11, 15)):
        misses.append("correctness")
    if p == 13 or (version == "v-regress" and p == 2):
        misses.append("helpfulness")
    turns = [
        f"merchant: which of my customers are from Toronto? (#{i})",
        "sidekick: calling segment_customers" + "".join(f" [miss:{c}]" for c in misses),
        "tools: 2 customers",
        "sidekick: You have 2 customers in Toronto.",
    ]
    call = TAG_CALL if version == "v-tag" and p in (4, 8, 12, 16) else GOOD_CALL
    labels = {c: 0 if c in misses else 1 for c in CRITERIA} if p in (0, 7, 13) else {}
    return Conversation(f"{version}-{i}", turns, [call], labels)


def sample(version: str, n: int) -> list[Conversation]:
    """n conversations replayed through version, the same ones every time."""
    return [_conversation(version, i) for i in range(n)]


def baseline(criterion: str) -> float:
    """The last release's mean for criterion (0.0 when there is none)."""
    raw = r.hget("gtx:baseline", criterion)
    return float(raw) if raw else 0.0


def record(version: str, means: dict[str, float]) -> None:
    """Record a shipped version's means."""
    r.hset(f"gtx:release:{version}", mapping={c: str(m) for c, m in means.items()})


def insert_candidate(event: dict) -> None:
    """Add a trace event to the candidates a human may later sample into the set."""
    r.rpush("gtx:candidates", json.dumps(event))
`,
  'sidekick/outbox.py': `"""
The trace outbox (provided): \`insert(event, reason)\` appends the event to the Redis list
\`outbox:assist.trace\` as JSON (\`{"event": …, "reason": …}\`); a relay produces the rows later.
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)
KEY = "outbox:assist.trace"


def insert(event: dict, reason: str) -> None:
    r.rpush(KEY, json.dumps({"event": event, "reason": reason}))
`,
  'sidekick/model.py': `"""
The stand-in for the model. The checks serve it over gRPC (Model.Complete at config.MODEL_ADDR);
sidekick's code never calls it directly. Deterministic on purpose: the course grades the loop around
the model, not its prose.

respond(user_message, tool_results) -> Reply(text, tool_name, args_json):
  a message starting with "loop:" asks for query_analytics on every turn and never answers
  with no tool result yet: "customers" asks for segment_customers, "description" for
  fill_product_form, "delete" for delete_shop (no catalog has it), "sales" for query_analytics;
  anything else is answered at once
  after a tool result it answers "Done: " and the last result
"""
from dataclasses import dataclass


@dataclass
class Reply:
    text: str
    tool_name: str
    args_json: str


PLAYBOOK = (
    ("customers", "segment_customers", '{"query":"default_address_city = Toronto"}'),
    ("description", "fill_product_form", '{"product_id":"p-1","field":"seo_description"}'),
    ("delete", "delete_shop", "{}"),
    ("sales", "query_analytics", '{"query":"FROM sales SHOW total_sales SINCE -30d"}'),
)


def respond(user_message: str, tool_results: list[str]) -> Reply:
    if user_message.startswith("loop:"):
        return Reply("", "query_analytics", '{"query":"FROM sales SHOW total_sales"}')
    if tool_results:
        return Reply("Done: " + tool_results[-1], "", "")
    for word, name, args in PLAYBOOK:
        if word in user_message:
            return Reply("", name, args)
    return Reply("I can help with customers, products and sales.", "", "")
`,
  'sidekick/tools.py': `"""
The stand-in for the admin's tools. The checks serve it over gRPC (Tools.Invoke at config.TOOLS_ADDR).
invoke(shop, name, args_json) answers a JSON document naming the shop, the tool and the arguments, so
a result computed for one shop is recognisable in another's answer.
"""


def invoke(shop: str, name: str, args_json: str) -> str:
    return '{"shop":"' + shop + '","tool":"' + name + '","args":' + args_json + "}"
`,
  'sidekick/judge.py': `"""
The stand-in for the LLM judges. The checks serve it over gRPC (Judge.Score at config.JUDGE_ADDR).
score(criterion, rubric, transcript): with the criterion's written rubric (evals.RUBRICS) the judge
agrees with the human labellers: 0.0 when the transcript shows a miss on that criterion
("[miss:<criterion>]", in whichever turn), else 1.0. Any other rubric gets the generous, uncalibrated
VIBE_SCORE whatever the conversation says.
"""
from sidekick.evals import RUBRICS

VIBE_SCORE = 0.9


def score(criterion: str, rubric: str, transcript: str) -> float:
    if RUBRICS.get(criterion) != rubric:
        return VIBE_SCORE
    return 0.0 if f"[miss:{criterion}]" in transcript else 1.0
`,
};

export const supportModulesTs: Record<string, string> = {
  'sidekick/config.ts': `/** Addresses, topics and costs every step of sidekick agrees on. */
/** The model, the admin's tools and the judges: stand-ins the checks serve over gRPC. */
export const MODEL_ADDR = 'model:9000';
export const TOOLS_ADDR = 'tools:9000';
export const JUDGE_ADDR = 'judge:9000';
/** One trace event per assist turn, keyed by shop, for the gtx-builder. */
export const TOPIC = 'assist.trace';
/** What one model call reserves from the shop's token budget. */
export const TOKENS_PER_CALL = 2_000;
/** The version of the system prompt and the catalog a trace was produced with. */
export const PROMPT_VERSION = 'sk-prompt-14';
`,
  'sidekick/catalog.ts': `/** The tool catalog (provided): every tool the model may call, the scope it needs, its guidance. */

/** The tool result the loop sends back when it refuses a call. */
export const PERMISSION_DENIED = 'PERMISSION_DENIED';

export interface Tool {
  name: string;
  /** One line: what the model sees in the tool list. */
  description: string;
  /** The staff permission the merchant must hold. */
  required_scope: string;
  /** True: the tool changes the shop. */
  writes: boolean;
  /** How to use it well: sent just in time, after the tool ran. */
  instructions: string;
}

const tools: Tool[] = [
  {
    name: 'segment_customers',
    description: 'Find the customers that match a segment query.',
    required_scope: 'read_customers',
    writes: false,
    instructions:
      'Write segments in the customer query language: customer_account_status = ENABLED, default_address_city = Toronto. Tags are free text, not a status.',
  },
  {
    name: 'query_analytics',
    description: "Run a ShopifyQL query over the shop's sales.",
    required_scope: 'read_reports',
    writes: false,
    instructions: 'Use ShopifyQL: FROM sales SHOW total_sales SINCE -30d. Report the numbers as returned.',
  },
  {
    name: 'search_products',
    description: "Search the shop's products by title.",
    required_scope: 'read_products',
    writes: false,
    instructions: 'Return product ids and titles; open a product by id before editing it.',
  },
  {
    name: 'fill_product_form',
    description: 'Fill fields of the product form the merchant has open.',
    required_scope: 'write_products',
    writes: true,
    instructions: 'Fill only the fields the merchant asked for and leave the form unsaved for the merchant to review.',
  },
];

export const CATALOG: Record<string, Tool> = Object.fromEntries(tools.map(t => [t.name, t]));
`,
  'sidekick/permissions.ts': `/** The permission store (provided): the scopes the merchant's staff account grants, the Redis set perms:{shop}. */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

/** The shop's scopes, sorted (read_customers, write_products, ...); empty for an unknown shop. */
export async function scopesFor(shop: string): Promise<string[]> {
  return (await redis.smembers(\`perms:\${shop}\`)).sort();
}
`,
  'sidekick/turns.ts': `/** The turn store (provided): finished turns in Redis under turn:{shop}:{idemKey}, for a day. */
import Redis from 'ioredis';

export const TURN_TTL_S = 86_400;

const redis = new Redis({host: 'redis', port: 6379});

export interface Turn {
  turn_id: string;
  reply: string;
  tools_used: string[];
  status: string;
}

export const store = {
  /** The turn stored for (shop, idemKey); null when there is none. */
  async get(shop: string, idemKey: string): Promise<Turn | null> {
    const raw = await redis.get(\`turn:\${shop}:\${idemKey}\`);
    return raw === null ? null : (JSON.parse(raw) as Turn);
  },

  /** Store the finished turn under (shop, idemKey). */
  async put(shop: string, idemKey: string, turn: Turn): Promise<void> {
    await redis.set(\`turn:\${shop}:\${idemKey}\`, JSON.stringify(turn), 'EX', TURN_TTL_S);
  },
};
`,
  'sidekick/trace.ts': `/** A finished turn as the trace path receives it (provided). message and tool_results are merchant data. */
export interface TurnRecord {
  turn_id: string;
  shop: string;
  page: string;
  /** The merchant's words. */
  message: string;
  tools_used: string[];
  /** What the tools answered: customers, orders, products. */
  tool_results: string[];
  latency_ms: number;
  tokens: number;
  judge_score: number;
}
`,
  'sidekick/outcome.ts': `/** What the agent loop returns for one turn (provided). */
export interface Outcome {
  reply: string;
  tools_used: string[];
  /** done, turn_limit, deadline or over_budget */
  status: string;
}
`,
  'sidekick/evals.ts': `/** Evaluation helpers (provided): the criteria and their rubrics, the schema validator, Cohen's kappa. */
import {CATALOG} from 'sidekick/catalog';

export const CRITERIA = ['correctness', 'schema_compliance', 'helpfulness'];
/** The written rubric each criterion's judge was calibrated with. */
export const RUBRICS: Record<string, string> = {
  correctness: "Score 1 if every tool call and every claim matches the shop's data and the merchant's request, else 0.",
  schema_compliance: 'Score 1 if every tool call uses the documented fields and operators, else 0.',
  helpfulness: "Score 1 if the merchant's goal was reached without needless steps, else 0.",
};
/** The fields a segment query may filter on. */
export const SEGMENT_FIELDS = ['customer_account_status', 'default_address_city', 'amount_spent', 'orders_count'];

export interface ToolCall {
  name: string;
  args_json: string;
}

export interface Conversation {
  id: string;
  turns: string[];
  tool_calls: ToolCall[];
  /** criterion → 0 or 1, on the human-labelled subset only */
  human_labels: Record<string, number>;
}

export interface Decision {
  ship: boolean;
  means: Record<string, number>;
  reason: string;
}

/** The whole conversation, turn by turn, as a judge reads it. */
export function transcript(conversation: Conversation): string {
  return conversation.turns.join('\\n');
}

/** Procedural validation: a known tool, JSON object arguments, a segment query on a documented field. */
export function validateSchema(call: ToolCall): boolean {
  if (!(call.name in CATALOG)) return false;
  let args: unknown;
  try {
    args = JSON.parse(call.args_json);
  } catch {
    return false;
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return false;
  if (call.name === 'segment_customers') {
    const query = (args as Record<string, unknown>).query;
    return typeof query === 'string' && SEGMENT_FIELDS.includes(query.split(' ')[0]);
  }
  return true;
}

/** Agreement of two raters' 0/1 labels beyond chance: 1 is perfect, 0 is what chance gives. */
export function cohenKappa(a: number[], b: number[]): number {
  const n = a.length;
  if (n === 0 || n !== b.length) return 0;
  const observed = a.filter((x, i) => x === b[i]).length / n;
  const pa = a.reduce((s, x) => s + x, 0) / n;
  const pb = b.reduce((s, x) => s + x, 0) / n;
  const chance = pa * pb + (1 - pa) * (1 - pb);
  if (chance === 1) return observed === 1 ? 1 : 0;
  return (observed - chance) / (1 - chance);
}
`,
  'sidekick/gtx.ts': `/**
 * The ground-truth set (provided): conversations sampled from real merchant sessions and replayed
 * through a candidate version, the human labels on a subset, the scores of the last release (the
 * baseline), and the candidates the trace consumer adds. Redis: gtx:baseline (criterion → score),
 * gtx:release:{version} (criterion → mean), gtx:candidates (a list of JSON events).
 */
import Redis from 'ioredis';

import {CRITERIA, type Conversation, type ToolCall} from 'sidekick/evals';

const redis = new Redis({host: 'redis', port: 6379});

const GOOD_CALL: ToolCall = {name: 'segment_customers', args_json: '{"query":"default_address_city = Toronto"}'};
const TAG_CALL: ToolCall = {name: 'segment_customers', args_json: '{"query":"customer_tags CONTAINS enabled"}'};

function conversation(version: string, i: number): Conversation {
  const p = i % 20;
  const misses: string[] = [];
  if (p === 7 || (version === 'v-early' && [1, 3, 5, 9, 11, 15].includes(p))) misses.push('correctness');
  if (p === 13 || (version === 'v-regress' && p === 2)) misses.push('helpfulness');
  const turns = [
    \`merchant: which of my customers are from Toronto? (#\${i})\`,
    'sidekick: calling segment_customers' + misses.map(c => \` [miss:\${c}]\`).join(''),
    'tools: 2 customers',
    'sidekick: You have 2 customers in Toronto.',
  ];
  const call = version === 'v-tag' && [4, 8, 12, 16].includes(p) ? TAG_CALL : GOOD_CALL;
  const labels: Record<string, number> = {};
  if ([0, 7, 13].includes(p)) for (const c of CRITERIA) labels[c] = misses.includes(c) ? 0 : 1;
  return {id: \`\${version}-\${i}\`, turns, tool_calls: [call], human_labels: labels};
}

/** n conversations replayed through version, the same ones every time. */
export function sample(version: string, n: number): Conversation[] {
  return Array.from({length: n}, (_, i) => conversation(version, i));
}

/** The last release's mean for criterion (0 when there is none). */
export async function baseline(criterion: string): Promise<number> {
  const raw = await redis.hget('gtx:baseline', criterion);
  return raw === null ? 0 : Number(raw);
}

/** Record a shipped version's means. */
export async function record(version: string, means: Record<string, number>): Promise<void> {
  await redis.hset(\`gtx:release:\${version}\`, Object.fromEntries(Object.entries(means).map(([c, m]) => [c, String(m)])));
}

/** Add a trace event to the candidates a human may later sample into the set. */
export async function insertCandidate(event: Record<string, unknown>): Promise<void> {
  await redis.rpush('gtx:candidates', JSON.stringify(event));
}
`,
  'sidekick/outbox.ts': `/**
 * The trace outbox (provided): \`insert(event, reason)\` appends the event to the Redis list
 * \`outbox:assist.trace\` as JSON (\`{"event": …, "reason": …}\`); a relay produces the rows later.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});
export const KEY = 'outbox:assist.trace';

export async function insert(event: Record<string, unknown>, reason: string): Promise<void> {
  await redis.rpush(KEY, JSON.stringify({event, reason}));
}
`,
  'sidekick/model.ts': `/**
 * The stand-in for the model. The checks serve it over gRPC (Model.Complete at MODEL_ADDR);
 * sidekick's code never calls it directly. Deterministic on purpose: the course grades the loop around
 * the model, not its prose.
 *
 * respond(userMessage, toolResults) → {text, tool_name, args_json}:
 *   a message starting with "loop:" asks for query_analytics on every turn and never answers
 *   with no tool result yet: "customers" asks for segment_customers, "description" for
 *   fill_product_form, "delete" for delete_shop (no catalog has it), "sales" for query_analytics;
 *   anything else is answered at once
 *   after a tool result it answers "Done: " and the last result
 */
export interface Reply {
  text: string;
  tool_name: string;
  args_json: string;
}

const PLAYBOOK: [string, string, string][] = [
  ['customers', 'segment_customers', '{"query":"default_address_city = Toronto"}'],
  ['description', 'fill_product_form', '{"product_id":"p-1","field":"seo_description"}'],
  ['delete', 'delete_shop', '{}'],
  ['sales', 'query_analytics', '{"query":"FROM sales SHOW total_sales SINCE -30d"}'],
];

export function respond(userMessage: string, toolResults: string[]): Reply {
  if (userMessage.startsWith('loop:')) return {text: '', tool_name: 'query_analytics', args_json: '{"query":"FROM sales SHOW total_sales"}'};
  if (toolResults.length > 0) return {text: 'Done: ' + toolResults[toolResults.length - 1], tool_name: '', args_json: ''};
  for (const [word, name, args] of PLAYBOOK) if (userMessage.includes(word)) return {text: '', tool_name: name, args_json: args};
  return {text: 'I can help with customers, products and sales.', tool_name: '', args_json: ''};
}
`,
  'sidekick/tools.ts': `/**
 * The stand-in for the admin's tools. The checks serve it over gRPC (Tools.Invoke at TOOLS_ADDR).
 * invoke(shop, name, argsJson) answers a JSON document naming the shop, the tool and the arguments,
 * so a result computed for one shop is recognisable in another's answer.
 */
export function invoke(shop: string, name: string, argsJson: string): string {
  return '{"shop":"' + shop + '","tool":"' + name + '","args":' + argsJson + '}';
}
`,
  'sidekick/judge.ts': `/**
 * The stand-in for the LLM judges. The checks serve it over gRPC (Judge.Score at JUDGE_ADDR).
 * score(criterion, rubric, transcript): with the criterion's written rubric (RUBRICS) the judge agrees
 * with the human labellers: 0 when the transcript shows a miss on that criterion ("[miss:<criterion>]",
 * in whichever turn), else 1. Any other rubric gets the generous, uncalibrated VIBE_SCORE whatever the
 * conversation says.
 */
import {RUBRICS} from 'sidekick/evals';

export const VIBE_SCORE = 0.9;

export function score(criterion: string, rubric: string, transcript: string): number {
  if (RUBRICS[criterion] !== rubric) return VIBE_SCORE;
  return transcript.includes(\`[miss:\${criterion}]\`) ? 0 : 1;
}
`,
};

/** The Go twins: the same \`sidekick\` packages, imported as sidekick/config, sidekick/catalog, … */
export const supportModulesGo: Record<string, string> = {
  'sidekick/config/config.go': `// Package config holds the addresses, topics and costs every step of sidekick agrees on.
package config

const (
	// The model, the admin's tools and the judges: stand-ins the checks serve over gRPC.
	ModelAddr = "model:9000"
	ToolsAddr = "tools:9000"
	JudgeAddr = "judge:9000"
	// Topic carries one trace event per assist turn, keyed by shop, for the gtx-builder.
	Topic = "assist.trace"
	// TokensPerCall is what one model call reserves from the shop's token budget.
	TokensPerCall = 2000
	// PromptVersion is the version of the system prompt and the catalog a trace was produced with.
	PromptVersion = "sk-prompt-14"
)
`,
  'sidekick/catalog/catalog.go': `// Package catalog is the tool catalog (provided): every tool the model may call, the scope it
// needs, its guidance.
package catalog

// PermissionDenied is the tool result the loop sends back when it refuses a call.
const PermissionDenied = "PERMISSION_DENIED"

type Tool struct {
	Name          string
	Description   string // one line: what the model sees in the tool list
	RequiredScope string // the staff permission the merchant must hold
	Writes        bool   // true: the tool changes the shop
	Instructions  string // how to use it well: sent just in time, after the tool ran
}

// Tools is the catalog, in the order the model sees it.
var Tools = []Tool{
	{"segment_customers", "Find the customers that match a segment query.", "read_customers", false,
		"Write segments in the customer query language: customer_account_status = ENABLED, default_address_city = Toronto. Tags are free text, not a status."},
	{"query_analytics", "Run a ShopifyQL query over the shop's sales.", "read_reports", false,
		"Use ShopifyQL: FROM sales SHOW total_sales SINCE -30d. Report the numbers as returned."},
	{"search_products", "Search the shop's products by title.", "read_products", false,
		"Return product ids and titles; open a product by id before editing it."},
	{"fill_product_form", "Fill fields of the product form the merchant has open.", "write_products", true,
		"Fill only the fields the merchant asked for and leave the form unsaved for the merchant to review."},
}

// Lookup is the tool called name; false when the catalog has none.
func Lookup(name string) (Tool, bool) {
	for _, t := range Tools {
		if t.Name == name {
			return t, true
		}
	}
	return Tool{}, false
}
`,
  'sidekick/permissions/permissions.go': `// Package permissions is the permission store (provided): the scopes the merchant's staff account
// grants, the Redis set perms:{shop}.
package permissions

import (
	"context"
	"sort"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// ScopesFor is the shop's scopes, sorted (read_customers, write_products, ...); empty for an unknown shop.
func ScopesFor(ctx context.Context, shop string) ([]string, error) {
	scopes, err := rdb.SMembers(ctx, "perms:"+shop).Result()
	if err != nil {
		return nil, err
	}
	sort.Strings(scopes)
	return scopes, nil
}
`,
  'sidekick/turns/turns.go': `// Package turns is the turn store (provided): finished turns in Redis under turn:{shop}:{idemKey},
// for a day.
package turns

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"
)

const TurnTTL = 24 * time.Hour

// Turn is a finished assist turn as the API answers it.
type Turn struct {
	TurnID    string   \`json:"turn_id"\`
	Reply     string   \`json:"reply"\`
	ToolsUsed []string \`json:"tools_used"\`
	Status    string   \`json:"status"\`
}

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Get is the turn stored for (shop, idemKey); nil when there is none.
func Get(ctx context.Context, shop, idemKey string) (*Turn, error) {
	raw, err := rdb.Get(ctx, "turn:"+shop+":"+idemKey).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var turn Turn
	if err := json.Unmarshal(raw, &turn); err != nil {
		return nil, err
	}
	return &turn, nil
}

// Put stores the finished turn under (shop, idemKey).
func Put(ctx context.Context, shop, idemKey string, turn Turn) error {
	doc, err := json.Marshal(turn)
	if err != nil {
		return err
	}
	return rdb.Set(ctx, "turn:"+shop+":"+idemKey, doc, TurnTTL).Err()
}
`,
  'sidekick/trace/trace.go': `// Package trace holds a finished turn as the trace path receives it (provided). Message and
// ToolResults are merchant data.
package trace

type TurnRecord struct {
	TurnID      string
	Shop        string
	Page        string
	Message     string   // the merchant's words
	ToolsUsed   []string
	ToolResults []string // what the tools answered: customers, orders, products
	LatencyMs   int
	Tokens      int
	JudgeScore  float64
}
`,
  'sidekick/outcome/outcome.go': `// Package outcome is what the agent loop returns for one turn (provided).
package outcome

type Outcome struct {
	Reply     string
	ToolsUsed []string
	Status    string // done, turn_limit, deadline or over_budget
}
`,
  'sidekick/evals/evals.go': `// Package evals holds the evaluation helpers (provided): the criteria and their rubrics, the schema
// validator, Cohen's kappa.
package evals

import (
	"encoding/json"
	"strings"

	"sidekick/catalog"
)

var Criteria = []string{"correctness", "schema_compliance", "helpfulness"}

// Rubrics are the written rubrics each criterion's judge was calibrated with.
var Rubrics = map[string]string{
	"correctness":       "Score 1 if every tool call and every claim matches the shop's data and the merchant's request, else 0.",
	"schema_compliance": "Score 1 if every tool call uses the documented fields and operators, else 0.",
	"helpfulness":       "Score 1 if the merchant's goal was reached without needless steps, else 0.",
}

// SegmentFields are the fields a segment query may filter on.
var SegmentFields = []string{"customer_account_status", "default_address_city", "amount_spent", "orders_count"}

type ToolCall struct {
	Name     string
	ArgsJSON string
}

type Conversation struct {
	ID          string
	Turns       []string
	ToolCalls   []ToolCall
	HumanLabels map[string]int // criterion -> 0 or 1, on the human-labelled subset only
}

type Decision struct {
	Ship   bool
	Means  map[string]float64
	Reason string
}

// Transcript is the whole conversation, turn by turn, as a judge reads it.
func Transcript(c Conversation) string { return strings.Join(c.Turns, "\\n") }

// ValidateSchema is procedural validation: a known tool, JSON object arguments, a segment query on a
// documented field.
func ValidateSchema(call ToolCall) bool {
	if _, ok := catalog.Lookup(call.Name); !ok {
		return false
	}
	var args map[string]any
	if err := json.Unmarshal([]byte(call.ArgsJSON), &args); err != nil || args == nil {
		return false
	}
	if call.Name == "segment_customers" {
		query, ok := args["query"].(string)
		if !ok {
			return false
		}
		field := strings.Split(query, " ")[0]
		for _, f := range SegmentFields {
			if f == field {
				return true
			}
		}
		return false
	}
	return true
}

// CohenKappa is the agreement of two raters' 0/1 labels beyond chance: 1 is perfect, 0 is what chance gives.
func CohenKappa(a, b []int) float64 {
	n := len(a)
	if n == 0 || n != len(b) {
		return 0
	}
	same, sa, sb := 0, 0, 0
	for i := range a {
		if a[i] == b[i] {
			same++
		}
		sa += a[i]
		sb += b[i]
	}
	observed := float64(same) / float64(n)
	pa, pb := float64(sa)/float64(n), float64(sb)/float64(n)
	chance := pa*pb + (1-pa)*(1-pb)
	if chance == 1 {
		if observed == 1 {
			return 1
		}
		return 0
	}
	return (observed - chance) / (1 - chance)
}
`,
  'sidekick/gtx/gtx.go': `// Package gtx is the ground-truth set (provided): conversations sampled from real merchant sessions
// and replayed through a candidate version, the human labels on a subset, the scores of the last
// release (the baseline), and the candidates the trace consumer adds. Redis: gtx:baseline
// (criterion -> score), gtx:release:{version} (criterion -> mean), gtx:candidates (JSON events).
package gtx

import (
	"context"
	"errors"
	"fmt"
	"strconv"

	"github.com/redis/go-redis/v9"

	"sidekick/evals"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var (
	goodCall = evals.ToolCall{Name: "segment_customers", ArgsJSON: \`{"query":"default_address_city = Toronto"}\`}
	tagCall  = evals.ToolCall{Name: "segment_customers", ArgsJSON: \`{"query":"customer_tags CONTAINS enabled"}\`}
)

func in(p int, set ...int) bool {
	for _, s := range set {
		if s == p {
			return true
		}
	}
	return false
}

func conversation(version string, i int) evals.Conversation {
	p := i % 20
	var misses []string
	if p == 7 || (version == "v-early" && in(p, 1, 3, 5, 9, 11, 15)) {
		misses = append(misses, "correctness")
	}
	if p == 13 || (version == "v-regress" && p == 2) {
		misses = append(misses, "helpfulness")
	}
	second := "sidekick: calling segment_customers"
	for _, c := range misses {
		second += " [miss:" + c + "]"
	}
	turns := []string{
		fmt.Sprintf("merchant: which of my customers are from Toronto? (#%d)", i),
		second,
		"tools: 2 customers",
		"sidekick: You have 2 customers in Toronto.",
	}
	call := goodCall
	if version == "v-tag" && in(p, 4, 8, 12, 16) {
		call = tagCall
	}
	labels := map[string]int{}
	if in(p, 0, 7, 13) {
		for _, c := range evals.Criteria {
			labels[c] = 1
			for _, m := range misses {
				if m == c {
					labels[c] = 0
				}
			}
		}
	}
	return evals.Conversation{ID: version + "-" + strconv.Itoa(i), Turns: turns, ToolCalls: []evals.ToolCall{call}, HumanLabels: labels}
}

// Sample is n conversations replayed through version, the same ones every time.
func Sample(version string, n int) []evals.Conversation {
	out := make([]evals.Conversation, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, conversation(version, i))
	}
	return out
}

// Baseline is the last release's mean for criterion (0 when there is none).
func Baseline(ctx context.Context, criterion string) (float64, error) {
	raw, err := rdb.HGet(ctx, "gtx:baseline", criterion).Result()
	if errors.Is(err, redis.Nil) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return strconv.ParseFloat(raw, 64)
}

// Record records a shipped version's means.
func Record(ctx context.Context, version string, means map[string]float64) error {
	fields := []any{}
	for c, m := range means {
		fields = append(fields, c, strconv.FormatFloat(m, 'g', -1, 64))
	}
	return rdb.HSet(ctx, "gtx:release:"+version, fields...).Err()
}

// InsertCandidate adds a trace event (its JSON) to the candidates a human may later sample into the set.
func InsertCandidate(ctx context.Context, event []byte) error {
	return rdb.RPush(ctx, "gtx:candidates", event).Err()
}
`,
  'sidekick/outbox/outbox.go': `// Package outbox is the trace outbox (provided): Insert appends the event to the Redis list
// outbox:assist.trace as JSON ({"event": …, "reason": …}); a relay produces the rows later.
package outbox

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const Key = "outbox:assist.trace"

// Insert appends event (a JSON document) with the reason it could not be produced.
func Insert(ctx context.Context, event json.RawMessage, reason string) error {
	row, _ := json.Marshal(map[string]any{"event": event, "reason": reason})
	return rdb.RPush(ctx, Key, row).Err()
}
`,
  'sidekick/model/model.go': `// Package model is the stand-in for the model. The checks serve it over gRPC (Model.Complete at
// config.ModelAddr); sidekick's code never calls it directly. Deterministic on purpose: the course
// grades the loop around the model, not its prose.
//
// Respond(userMessage, toolResults) → Reply{Text, ToolName, ArgsJSON}:
//
//	a message starting with "loop:" asks for query_analytics on every turn and never answers
//	with no tool result yet: "customers" asks for segment_customers, "description" for
//	fill_product_form, "delete" for delete_shop (no catalog has it), "sales" for query_analytics;
//	anything else is answered at once
//	after a tool result it answers "Done: " and the last result
package model

import "strings"

type Reply struct {
	Text     string
	ToolName string
	ArgsJSON string
}

var playbook = [][3]string{
	{"customers", "segment_customers", \`{"query":"default_address_city = Toronto"}\`},
	{"description", "fill_product_form", \`{"product_id":"p-1","field":"seo_description"}\`},
	{"delete", "delete_shop", "{}"},
	{"sales", "query_analytics", \`{"query":"FROM sales SHOW total_sales SINCE -30d"}\`},
}

func Respond(userMessage string, toolResults []string) Reply {
	if strings.HasPrefix(userMessage, "loop:") {
		return Reply{ToolName: "query_analytics", ArgsJSON: \`{"query":"FROM sales SHOW total_sales"}\`}
	}
	if len(toolResults) > 0 {
		return Reply{Text: "Done: " + toolResults[len(toolResults)-1]}
	}
	for _, p := range playbook {
		if strings.Contains(userMessage, p[0]) {
			return Reply{ToolName: p[1], ArgsJSON: p[2]}
		}
	}
	return Reply{Text: "I can help with customers, products and sales."}
}
`,
  'sidekick/tools/tools.go': `// Package tools is the stand-in for the admin's tools. The checks serve it over gRPC (Tools.Invoke
// at config.ToolsAddr). Invoke(shop, name, argsJSON) answers a JSON document naming the shop, the tool
// and the arguments, so a result computed for one shop is recognisable in another's answer.
package tools

func Invoke(shop, name, argsJSON string) string {
	return \`{"shop":"\` + shop + \`","tool":"\` + name + \`","args":\` + argsJSON + "}"
}
`,
  'sidekick/judge/judge.go': `// Package judge is the stand-in for the LLM judges. The checks serve it over gRPC (Judge.Score at
// config.JudgeAddr). Score(criterion, rubric, transcript): with the criterion's written rubric
// (evals.Rubrics) the judge agrees with the human labellers: 0 when the transcript shows a miss on
// that criterion ("[miss:<criterion>]", in whichever turn), else 1. Any other rubric gets the
// generous, uncalibrated VibeScore whatever the conversation says.
package judge

import (
	"strings"

	"sidekick/evals"
)

const VibeScore = 0.9

func Score(criterion, rubric, transcript string) float64 {
	if want, ok := evals.Rubrics[criterion]; !ok || want != rubric {
		return VibeScore
	}
	if strings.Contains(transcript, "[miss:"+criterion+"]") {
		return 0
	}
	return 1
}
`,
};

/** The C++ twins as headers (sidekick/*.h), plus digest.h (SHA-256) and ids.h (UUIDs). */
export const supportModulesCpp: Record<string, string> = {
  'digest.h': CPP_DIGEST_H,
  'ids.h': CPP_IDS_H,
  'sidekick/config.h': `// Addresses, topics and costs every step of sidekick agrees on.
#pragma once

#include <sw/redis++/redis++.h>

namespace config {

// The model, the admin's tools and the judges: stand-ins the checks serve over gRPC.
inline constexpr const char* kModelAddr = "model:9000";
inline constexpr const char* kToolsAddr = "tools:9000";
inline constexpr const char* kJudgeAddr = "judge:9000";
// One trace event per assist turn, keyed by shop, for the gtx-builder.
inline constexpr const char* kTopic = "assist.trace";
// What one model call reserves from the shop's token budget.
inline constexpr long long kTokensPerCall = 2000;
// The version of the system prompt and the catalog a trace was produced with.
inline constexpr const char* kPromptVersion = "sk-prompt-14";

// The one Redis connection the provided modules share.
inline sw::redis::Redis& redis() {
  static sw::redis::Redis conn("tcp://redis:6379");
  return conn;
}

}  // namespace config
`,
  'sidekick/catalog.h': `// The tool catalog (provided): every tool the model may call, the scope it needs, its guidance.
#pragma once

#include <string>
#include <vector>

namespace catalog {

// The tool result the loop sends back when it refuses a call.
inline constexpr const char* kPermissionDenied = "PERMISSION_DENIED";

struct Tool {
  std::string name;
  std::string description;     // one line: what the model sees in the tool list
  std::string required_scope;  // the staff permission the merchant must hold
  bool writes = false;         // true: the tool changes the shop
  std::string instructions;    // how to use it well: sent just in time, after the tool ran
};

// The catalog, in the order the model sees it.
inline const std::vector<Tool>& tools() {
  static const std::vector<Tool> all = {
      {"segment_customers", "Find the customers that match a segment query.", "read_customers", false,
       "Write segments in the customer query language: customer_account_status = ENABLED, default_address_city = Toronto. Tags are free text, not a status."},
      {"query_analytics", "Run a ShopifyQL query over the shop's sales.", "read_reports", false,
       "Use ShopifyQL: FROM sales SHOW total_sales SINCE -30d. Report the numbers as returned."},
      {"search_products", "Search the shop's products by title.", "read_products", false,
       "Return product ids and titles; open a product by id before editing it."},
      {"fill_product_form", "Fill fields of the product form the merchant has open.", "write_products", true,
       "Fill only the fields the merchant asked for and leave the form unsaved for the merchant to review."},
  };
  return all;
}

// The tool called name; nullptr when the catalog has none.
inline const Tool* lookup(const std::string& name) {
  for (const Tool& t : tools()) {
    if (t.name == name) return &t;
  }
  return nullptr;
}

}  // namespace catalog
`,
  'sidekick/permissions.h': `// The permission store (provided): the scopes the merchant's staff account grants, the Redis set
// perms:{shop}.
#pragma once

#include <algorithm>
#include <iterator>
#include <string>
#include <vector>

#include "sidekick/config.h"

namespace permissions {

// The shop's scopes, sorted (read_customers, write_products, ...); empty for an unknown shop.
inline std::vector<std::string> scopes_for(const std::string& shop) {
  std::vector<std::string> scopes;
  config::redis().smembers("perms:" + shop, std::back_inserter(scopes));
  std::sort(scopes.begin(), scopes.end());
  return scopes;
}

}  // namespace permissions
`,
  'sidekick/turns.h': `// The turn store (provided): finished turns in Redis under turn:{shop}:{idem_key}, for a day. A turn
// is the JSON object {turn_id, reply, tools_used, status}.
#pragma once

#include <chrono>
#include <optional>
#include <string>

#include <nlohmann/json.hpp>

#include "sidekick/config.h"

namespace turns {

inline constexpr long long kTurnTtlSeconds = 86400;

// The turn stored for (shop, idem_key), if any.
inline std::optional<nlohmann::json> get(const std::string& shop, const std::string& idem_key) {
  const auto raw = config::redis().get("turn:" + shop + ":" + idem_key);
  if (!raw) return std::nullopt;
  return nlohmann::json::parse(*raw);
}

// Store the finished turn under (shop, idem_key).
inline void put(const std::string& shop, const std::string& idem_key, const nlohmann::json& turn) {
  config::redis().set("turn:" + shop + ":" + idem_key, turn.dump(), std::chrono::seconds(kTurnTtlSeconds));
}

}  // namespace turns
`,
  'sidekick/trace.h': `// A finished turn as the trace path receives it (provided). message and tool_results are merchant data.
#pragma once

#include <string>
#include <vector>

namespace trace {

struct TurnRecord {
  std::string turn_id;
  std::string shop;
  std::string page;
  std::string message;  // the merchant's words
  std::vector<std::string> tools_used;
  std::vector<std::string> tool_results;  // what the tools answered: customers, orders, products
  int latency_ms = 0;
  int tokens = 0;
  double judge_score = 0;
};

}  // namespace trace
`,
  'sidekick/outcome.h': `// What the agent loop returns for one turn (provided).
#pragma once

#include <string>
#include <vector>

namespace outcome {

struct Outcome {
  std::string reply;
  std::vector<std::string> tools_used;
  std::string status = "done";  // done, turn_limit, deadline or over_budget
};

}  // namespace outcome
`,
  'sidekick/evals.h': `// Evaluation helpers (provided): the criteria and their rubrics, the schema validator, Cohen's kappa.
#pragma once

#include <map>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "sidekick/catalog.h"

namespace evals {

inline const std::vector<std::string> kCriteria = {"correctness", "schema_compliance", "helpfulness"};

// The written rubric each criterion's judge was calibrated with.
inline const std::map<std::string, std::string> kRubrics = {
    {"correctness", "Score 1 if every tool call and every claim matches the shop's data and the merchant's request, else 0."},
    {"schema_compliance", "Score 1 if every tool call uses the documented fields and operators, else 0."},
    {"helpfulness", "Score 1 if the merchant's goal was reached without needless steps, else 0."},
};

// The fields a segment query may filter on.
inline const std::vector<std::string> kSegmentFields = {"customer_account_status", "default_address_city", "amount_spent", "orders_count"};

struct ToolCall {
  std::string name;
  std::string args_json;
};

struct Conversation {
  std::string id;
  std::vector<std::string> turns;
  std::vector<ToolCall> tool_calls;
  std::map<std::string, int> human_labels;  // criterion -> 0 or 1, on the human-labelled subset only
};

struct Decision {
  bool ship = false;
  std::map<std::string, double> means;
  std::string reason;
};

// The whole conversation, turn by turn, as a judge reads it.
inline std::string transcript(const Conversation& c) {
  std::string out;
  for (size_t i = 0; i < c.turns.size(); ++i) out += (i == 0 ? "" : "\\n") + c.turns[i];
  return out;
}

// Procedural validation: a known tool, JSON object arguments, a segment query on a documented field.
inline bool validate_schema(const ToolCall& call) {
  if (catalog::lookup(call.name) == nullptr) return false;
  const auto args = nlohmann::json::parse(call.args_json, nullptr, false);
  if (!args.is_object()) return false;
  if (call.name == "segment_customers") {
    if (!args.contains("query") || !args["query"].is_string()) return false;
    const std::string query = args["query"].get<std::string>();
    const std::string field = query.substr(0, query.find(' '));
    for (const auto& f : kSegmentFields) {
      if (f == field) return true;
    }
    return false;
  }
  return true;
}

// Agreement of two raters' 0/1 labels beyond chance: 1 is perfect, 0 is what chance gives.
inline double cohen_kappa(const std::vector<int>& a, const std::vector<int>& b) {
  const size_t n = a.size();
  if (n == 0 || n != b.size()) return 0;
  int same = 0, sa = 0, sb = 0;
  for (size_t i = 0; i < n; ++i) {
    if (a[i] == b[i]) ++same;
    sa += a[i];
    sb += b[i];
  }
  const double observed = static_cast<double>(same) / n;
  const double pa = static_cast<double>(sa) / n, pb = static_cast<double>(sb) / n;
  const double chance = pa * pb + (1 - pa) * (1 - pb);
  if (chance == 1) return observed == 1 ? 1 : 0;
  return (observed - chance) / (1 - chance);
}

}  // namespace evals
`,
  'sidekick/gtx.h': `// The ground-truth set (provided): conversations sampled from real merchant sessions and replayed
// through a candidate version, the human labels on a subset, the scores of the last release (the
// baseline), and the candidates the trace consumer adds. Redis: gtx:baseline (criterion -> score),
// gtx:release:{version} (criterion -> mean), gtx:candidates (a list of JSON events).
#pragma once

#include <algorithm>
#include <initializer_list>
#include <map>
#include <string>
#include <unordered_map>
#include <vector>

#include "sidekick/config.h"
#include "sidekick/evals.h"

namespace gtx {

inline bool member(int p, std::initializer_list<int> set) { return std::any_of(set.begin(), set.end(), [p](int s) { return s == p; }); }

inline evals::Conversation conversation(const std::string& version, int i) {
  const int p = i % 20;
  std::vector<std::string> misses;
  if (p == 7 || (version == "v-early" && member(p, {1, 3, 5, 9, 11, 15}))) misses.push_back("correctness");
  if (p == 13 || (version == "v-regress" && p == 2)) misses.push_back("helpfulness");
  std::string second = "sidekick: calling segment_customers";
  for (const auto& c : misses) second += " [miss:" + c + "]";
  evals::Conversation conv;
  conv.id = version + "-" + std::to_string(i);
  conv.turns = {"merchant: which of my customers are from Toronto? (#" + std::to_string(i) + ")", second, "tools: 2 customers",
                "sidekick: You have 2 customers in Toronto."};
  const bool tag = version == "v-tag" && member(p, {4, 8, 12, 16});
  conv.tool_calls = {{"segment_customers", tag ? R"({"query":"customer_tags CONTAINS enabled"})" : R"({"query":"default_address_city = Toronto"})"}};
  if (member(p, {0, 7, 13})) {
    for (const auto& c : evals::kCriteria) {
      conv.human_labels[c] = std::find(misses.begin(), misses.end(), c) == misses.end() ? 1 : 0;
    }
  }
  return conv;
}

// n conversations replayed through version, the same ones every time.
inline std::vector<evals::Conversation> sample(const std::string& version, int n) {
  std::vector<evals::Conversation> out;
  for (int i = 0; i < n; ++i) out.push_back(conversation(version, i));
  return out;
}

// The last release's mean for criterion (0 when there is none).
inline double baseline(const std::string& criterion) {
  const auto raw = config::redis().hget("gtx:baseline", criterion);
  return raw ? std::stod(*raw) : 0.0;
}

// Record a shipped version's means.
inline void record(const std::string& version, const std::map<std::string, double>& means) {
  std::unordered_map<std::string, std::string> fields;
  for (const auto& [c, m] : means) fields[c] = std::to_string(m);
  config::redis().hset("gtx:release:" + version, fields.begin(), fields.end());
}

// Add a trace event (its JSON) to the candidates a human may later sample into the set.
inline void insert_candidate(const std::string& event_json) { config::redis().rpush("gtx:candidates", event_json); }

}  // namespace gtx
`,
  'sidekick/outbox.h': `// The trace outbox (provided): insert(event_json, reason) appends the event to the Redis list
// outbox:assist.trace as JSON ({"event": …, "reason": …}); a relay produces the rows later.
#pragma once

#include <string>

#include <nlohmann/json.hpp>

#include "sidekick/config.h"

namespace outbox {

inline const std::string kKey = "outbox:assist.trace";

inline void insert(const std::string& event_json, const std::string& reason) {
  nlohmann::json row;
  row["event"] = nlohmann::json::parse(event_json);
  row["reason"] = reason;
  config::redis().rpush(kKey, row.dump());
}

}  // namespace outbox
`,
  'sidekick/model.h': `// The stand-in for the model. The checks serve it over gRPC (Model.Complete at
// config::kModelAddr); sidekick's code never calls it directly. Deterministic on purpose: the course
// grades the loop around the model, not its prose.
//
// respond(user_message, tool_results) -> Reply{text, tool_name, args_json}:
//   a message starting with "loop:" asks for query_analytics on every turn and never answers
//   with no tool result yet: "customers" asks for segment_customers, "description" for
//   fill_product_form, "delete" for delete_shop (no catalog has it), "sales" for query_analytics;
//   anything else is answered at once
//   after a tool result it answers "Done: " and the last result
#pragma once

#include <array>
#include <string>
#include <vector>

namespace model {

struct Reply {
  std::string text;
  std::string tool_name;
  std::string args_json;
};

inline Reply respond(const std::string& user_message, const std::vector<std::string>& tool_results) {
  if (user_message.rfind("loop:", 0) == 0) return {"", "query_analytics", R"({"query":"FROM sales SHOW total_sales"})"};
  if (!tool_results.empty()) return {"Done: " + tool_results.back(), "", ""};
  static const std::array<std::array<const char*, 3>, 4> playbook = {{
      {"customers", "segment_customers", R"({"query":"default_address_city = Toronto"})"},
      {"description", "fill_product_form", R"({"product_id":"p-1","field":"seo_description"})"},
      {"delete", "delete_shop", "{}"},
      {"sales", "query_analytics", R"({"query":"FROM sales SHOW total_sales SINCE -30d"})"},
  }};
  for (const auto& p : playbook) {
    if (user_message.find(p[0]) != std::string::npos) return {"", p[1], p[2]};
  }
  return {"I can help with customers, products and sales.", "", ""};
}

}  // namespace model
`,
  'sidekick/tools.h': `// The stand-in for the admin's tools. The checks serve it over gRPC (Tools.Invoke at
// config::kToolsAddr). invoke(shop, name, args_json) answers a JSON document naming the shop, the
// tool and the arguments, so a result computed for one shop is recognisable in another's answer.
#pragma once

#include <string>

namespace tools {

inline std::string invoke(const std::string& shop, const std::string& name, const std::string& args_json) {
  return R"({"shop":")" + shop + R"(","tool":")" + name + R"(","args":)" + args_json + "}";
}

}  // namespace tools
`,
  'sidekick/judge.h': `// The stand-in for the LLM judges. The checks serve it over gRPC (Judge.Score at config::kJudgeAddr).
// score(criterion, rubric, transcript): with the criterion's written rubric (evals::kRubrics) the
// judge agrees with the human labellers: 0 when the transcript shows a miss on that criterion
// ("[miss:<criterion>]", in whichever turn), else 1. Any other rubric gets the generous, uncalibrated
// kVibeScore whatever the conversation says.
#pragma once

#include <string>

#include "sidekick/evals.h"

namespace judge {

inline constexpr double kVibeScore = 0.9;

inline double score(const std::string& criterion, const std::string& rubric, const std::string& transcript) {
  const auto it = evals::kRubrics.find(criterion);
  if (it == evals::kRubrics.end() || it->second != rubric) return kVibeScore;
  return transcript.find("[miss:" + criterion + "]") != std::string::npos ? 0 : 1;
}

}  // namespace judge
`,
};

/** The Scala twins: the same \`sidekick\` objects, compiled with the steps by \`yarn check:scala\`. */
export const supportModulesScala: Record<string, string> = {
  [scalaPath('sidekick', 'Config')]: `package sidekick

/** Addresses, topics and costs every step of sidekick agrees on. */
object Config {
  /** The model, the admin's tools and the judges: stand-ins the checks serve over gRPC. */
  val ModelAddr = "model:9000"
  val ToolsAddr = "tools:9000"
  val JudgeAddr = "judge:9000"
  /** One trace event per assist turn, keyed by shop, for the gtx-builder. */
  val Topic = "assist.trace"
  /** What one model call reserves from the shop's token budget. */
  val TokensPerCall = 2000L
  /** The version of the system prompt and the catalog a trace was produced with. */
  val PromptVersion = "sk-prompt-14"
}
`,
  [scalaPath('sidekick', 'Catalog')]: `package sidekick

/**
 * A tool the model may call: a one-line description (what the model sees), the staff permission the
 * merchant must hold, whether it changes the shop, and its guidance (sent just in time, after it ran).
 */
final case class Tool(name: String, description: String, requiredScope: String, writes: Boolean, instructions: String)

/** The tool catalog (provided). */
object Catalog {
  /** The tool result the loop sends back when it refuses a call. */
  val PermissionDenied = "PERMISSION_DENIED"

  /** The catalog, in the order the model sees it. */
  val Tools: List[Tool] = List(
    Tool(
      "segment_customers",
      "Find the customers that match a segment query.",
      "read_customers",
      writes = false,
      "Write segments in the customer query language: customer_account_status = ENABLED, default_address_city = Toronto. Tags are free text, not a status."
    ),
    Tool(
      "query_analytics",
      "Run a ShopifyQL query over the shop's sales.",
      "read_reports",
      writes = false,
      "Use ShopifyQL: FROM sales SHOW total_sales SINCE -30d. Report the numbers as returned."
    ),
    Tool(
      "search_products",
      "Search the shop's products by title.",
      "read_products",
      writes = false,
      "Return product ids and titles; open a product by id before editing it."
    ),
    Tool(
      "fill_product_form",
      "Fill fields of the product form the merchant has open.",
      "write_products",
      writes = true,
      "Fill only the fields the merchant asked for and leave the form unsaved for the merchant to review."
    )
  )

  /** The tool called name, if the catalog has one. */
  def lookup(name: String): Option[Tool] = Tools.find(_.name == name)
}
`,
  [scalaPath('sidekick', 'Permissions')]: `package sidekick

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/** The permission store (provided): the scopes the merchant's staff account grants, the Redis set perms:{shop}. */
object Permissions {
  private val jedis = new JedisPooled("redis", 6379)

  /** The shop's scopes, sorted (read_customers, write_products, ...); empty for an unknown shop. */
  def scopesFor(shop: String): List[String] = jedis.smembers(s"perms:$shop").asScala.toList.sorted
}
`,
  [scalaPath('sidekick', 'Turns')]: `package sidekick

import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

/** A finished assist turn as the API answers it. */
final case class Turn(turnId: String, reply: String, toolsUsed: List[String], status: String) {
  def toJson: ujson.Obj =
    ujson.Obj("turn_id" -> turnId, "reply" -> reply, "tools_used" -> ujson.Arr.from(toolsUsed), "status" -> status)
}

/** The turn store (provided): finished turns in Redis under turn:{shop}:{idemKey}, for a day. */
object Turns {
  val TurnTtlSeconds = 86400L
  private val jedis = new JedisPooled("redis", 6379)

  /** The turn stored for (shop, idemKey), if any. */
  def get(shop: String, idemKey: String): Option[Turn] =
    Option(jedis.get(s"turn:$shop:$idemKey")).map { raw =>
      val j = ujson.read(raw)
      Turn(j("turn_id").str, j("reply").str, j("tools_used").arr.map(_.str).toList, j("status").str)
    }

  /** Store the finished turn under (shop, idemKey). */
  def put(shop: String, idemKey: String, turn: Turn): Unit = {
    jedis.set(s"turn:$shop:$idemKey", ujson.write(turn.toJson), SetParams.setParams().ex(TurnTtlSeconds))
    ()
  }
}
`,
  [scalaPath('sidekick', 'TurnRecord')]: `package sidekick

/** A finished turn as the trace path receives it (provided). message and toolResults are merchant data. */
final case class TurnRecord(
    turnId: String,
    shop: String,
    page: String,
    message: String,
    toolsUsed: List[String],
    toolResults: List[String],
    latencyMs: Int,
    tokens: Int,
    judgeScore: Double
)
`,
  [scalaPath('sidekick', 'Outcome')]: `package sidekick

/** What the agent loop returns for one turn (provided); status is done, turn_limit, deadline or over_budget. */
final case class Outcome(reply: String, toolsUsed: List[String], status: String)
`,
  [scalaPath('sidekick', 'Evals')]: `package sidekick

final case class ToolCall(name: String, argsJson: String)

/** A replayed conversation; humanLabels (criterion -> 0 or 1) on the human-labelled subset only. */
final case class Conversation(id: String, turns: List[String], toolCalls: List[ToolCall], humanLabels: Map[String, Int])

final case class Decision(ship: Boolean, means: Map[String, Double], reason: String)

/** Evaluation helpers (provided): the criteria and their rubrics, the schema validator, Cohen's kappa. */
object Evals {
  val Criteria: List[String] = List("correctness", "schema_compliance", "helpfulness")

  /** The written rubric each criterion's judge was calibrated with. */
  val Rubrics: Map[String, String] = Map(
    "correctness" -> "Score 1 if every tool call and every claim matches the shop's data and the merchant's request, else 0.",
    "schema_compliance" -> "Score 1 if every tool call uses the documented fields and operators, else 0.",
    "helpfulness" -> "Score 1 if the merchant's goal was reached without needless steps, else 0."
  )

  /** The fields a segment query may filter on. */
  val SegmentFields: Set[String] = Set("customer_account_status", "default_address_city", "amount_spent", "orders_count")

  /** The whole conversation, turn by turn, as a judge reads it. */
  def transcript(c: Conversation): String = c.turns.mkString("\\n")

  /** Procedural validation: a known tool, JSON object arguments, a segment query on a documented field. */
  def validateSchema(call: ToolCall): Boolean =
    Catalog.lookup(call.name).isDefined && scala.util.Try(ujson.read(call.argsJson)).toOption.exists {
      case args: ujson.Obj =>
        call.name != "segment_customers" || args.value.get("query").exists {
          case ujson.Str(q) => SegmentFields.contains(q.split(" ")(0))
          case _            => false
        }
      case _ => false
    }

  /** Agreement of two raters' 0/1 labels beyond chance: 1 is perfect, 0 is what chance gives. */
  def cohenKappa(a: Seq[Int], b: Seq[Int]): Double = {
    val n = a.size
    if (n == 0 || n != b.size) 0.0
    else {
      val observed = a.zip(b).count { case (x, y) => x == y }.toDouble / n
      val pa = a.sum.toDouble / n
      val pb = b.sum.toDouble / n
      val chance = pa * pb + (1 - pa) * (1 - pb)
      if (chance == 1) (if (observed == 1) 1.0 else 0.0) else (observed - chance) / (1 - chance)
    }
  }
}
`,
  [scalaPath('sidekick', 'Gtx')]: `package sidekick

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
 * The ground-truth set (provided): conversations sampled from real merchant sessions and replayed
 * through a candidate version, the human labels on a subset, the scores of the last release (the
 * baseline), and the candidates the trace consumer adds. Redis: gtx:baseline (criterion -> score),
 * gtx:release:{version} (criterion -> mean), gtx:candidates (a list of JSON events).
 */
object Gtx {
  private val jedis = new JedisPooled("redis", 6379)
  private val GoodCall = ToolCall("segment_customers", """{"query":"default_address_city = Toronto"}""")
  private val TagCall = ToolCall("segment_customers", """{"query":"customer_tags CONTAINS enabled"}""")

  private def conversation(version: String, i: Int): Conversation = {
    val p = i % 20
    val misses = List(
      Option.when(p == 7 || (version == "v-early" && Set(1, 3, 5, 9, 11, 15)(p)))("correctness"),
      Option.when(p == 13 || (version == "v-regress" && p == 2))("helpfulness")
    ).flatten
    val turns = List(
      s"merchant: which of my customers are from Toronto? (#$i)",
      "sidekick: calling segment_customers" + misses.map(c => s" [miss:$c]").mkString,
      "tools: 2 customers",
      "sidekick: You have 2 customers in Toronto."
    )
    val call = if (version == "v-tag" && Set(4, 8, 12, 16)(p)) TagCall else GoodCall
    val labels = if (Set(0, 7, 13)(p)) Evals.Criteria.map(c => c -> (if (misses.contains(c)) 0 else 1)).toMap else Map.empty[String, Int]
    Conversation(s"$version-$i", turns, List(call), labels)
  }

  /** n conversations replayed through version, the same ones every time. */
  def sample(version: String, n: Int): List[Conversation] = (0 until n).map(conversation(version, _)).toList

  /** The last release's mean for criterion (0 when there is none). */
  def baseline(criterion: String): Double = Option(jedis.hget("gtx:baseline", criterion)).map(_.toDouble).getOrElse(0.0)

  /** Record a shipped version's means. */
  def record(version: String, means: Map[String, Double]): Unit = {
    jedis.hset(s"gtx:release:$version", means.map { case (c, m) => c -> m.toString }.asJava)
    ()
  }

  /** Add a trace event (its JSON) to the candidates a human may later sample into the set. */
  def insertCandidate(eventJson: String): Unit = {
    jedis.rpush("gtx:candidates", eventJson)
    ()
  }
}
`,
  [scalaPath('sidekick', 'Outbox')]: `package sidekick

import redis.clients.jedis.JedisPooled

/**
 * The trace outbox (provided): \`insert(eventJson, reason)\` appends the event to the Redis list
 * \`outbox:assist.trace\` as JSON (\`{"event": …, "reason": …}\`); a relay produces the rows later.
 */
object Outbox {
  val Key = "outbox:assist.trace"
  private val jedis = new JedisPooled("redis", 6379)

  def insert(eventJson: String, reason: String): Unit = {
    jedis.rpush(Key, ujson.write(ujson.Obj("event" -> ujson.read(eventJson), "reason" -> reason)))
    ()
  }
}
`,
};
