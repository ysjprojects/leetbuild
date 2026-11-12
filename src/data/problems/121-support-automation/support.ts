/**
 * Hand-written support modules the support-automation steps import but no step builds: the `apv2`
 * package. `config` is the contract every step agrees on (the dependencies' addresses, the trace
 * topic, the Redis key layout); `auth` verifies bearer tokens into a principal; `turns` is the turn
 * store and `workflow` the queue the workflow engine drains (step 1); `model` holds the shapes the
 * steps pass each other; `handoff` is the human escalation queue (step 4); `outbox` keeps the spans
 * the broker refused (step 5); and `standins` is how the deterministic stand-ins the checks serve
 * over gRPC answer (the model, the tools, the guardrails, the retriever).
 */
import {CPP_DIGEST_H, CPP_IDS_H} from '../cpp-support';
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'apv2/__init__.py': '',
  'apv2/config.py': `"""Addresses, the trace topic and the Redis key layout every step of apv2 agrees on."""
import hashlib

# The dependencies' gRPC addresses: stand-ins served by the checks (apv2.standins).
RETRIEVER = "retriever:9300"
LLM_ADAPTER = "llm-adapter:9000"
TOOL_MANAGER = "tools:9100"
GUARDRAIL_FRAMEWORK = "guardrails:9200"
# One span per LLM, tool or guardrail call, for the insights consumer.
TRACE_TOPIC = "assistant.trace"


def turn_key(conversation: str, idem_key: str) -> str:
    """The stored turn of one (conversation, Idempotency-Key): a JSON string."""
    return f"turn:{conversation}:{idem_key}"


def context_key(tenant: str, conversation: str) -> str:
    """One conversation's runtime context: a list of JSON items {"kind", "text"}, oldest first."""
    return f"ctx:{tenant}:{conversation}"


def profile_key(tenant: str, user: str) -> str:
    """The user's record: a hash (customer_name, user_role, current_trip, email, phone, payment_last4)."""
    return f"profile:{tenant}:{user}"


def retriever_key(tenant: str, name: str, question: str) -> str:
    """A dynamic retriever's cached answer to one question: a JSON list of strings."""
    digest = hashlib.sha256(question.encode("utf-8")).hexdigest()[:16]
    return f"retr:{tenant}:{name}:{digest}"


def metrics_key(tenant: str, kind: str, name: str) -> str:
    """The insights counters of one call kind and name: a hash (calls, latency_ms, input_tokens, output_tokens, blocked)."""
    return f"metrics:{tenant}:{kind}:{name}"
`,
  'apv2/auth.py': `"""Bearer-token verification (provided): the identity provider's tokens, as principals."""
from dataclasses import dataclass


@dataclass(frozen=True)
class Principal:
    tenant: str
    actor_id: str
    role: str  # "customer" or "agent"


TOKENS = {
    "tok-guest-1": Principal("t1", "guest-1", "customer"),
    "tok-guest-2": Principal("t1", "guest-2", "customer"),
    "tok-agent-7": Principal("t1", "agent-7", "agent"),
    "tok-host-3": Principal("t2", "host-3", "customer"),
}


def verify(authorization: str | None) -> Principal | None:
    """The principal behind \`Authorization: Bearer <token>\`; None when the header is missing or the token unknown."""
    if not authorization or not authorization.startswith("Bearer "):
        return None
    return TOKENS.get(authorization[len("Bearer "):].strip())
`,
  'apv2/turns.py': `"""
The turn store (provided): one turn per (conversation, Idempotency-Key) in Redis, a JSON string
under config.turn_key that lives TURN_TTL_S. A turn is {turn_id, tenant, conversation, actor,
role, text}.
"""
import json

import redis

from apv2.config import turn_key

TURN_TTL_S = 86_400

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def get(conversation: str, idem_key: str) -> dict | None:
    """The turn stored under (conversation, idem_key), if any."""
    raw = r.get(turn_key(conversation, idem_key))
    return json.loads(raw) if raw else None


def put(conversation: str, idem_key: str, turn: dict) -> None:
    """Store the turn under (conversation, idem_key), replacing whatever was there."""
    r.set(turn_key(conversation, idem_key), json.dumps(turn), ex=TURN_TTL_S)


def claim(conversation: str, idem_key: str, turn: dict) -> dict | None:
    """Store the turn unless one is already there (one SET NX): None when this turn was stored, else the stored one."""
    if r.set(turn_key(conversation, idem_key), json.dumps(turn), ex=TURN_TTL_S, nx=True):
        return None
    return get(conversation, idem_key)
`,
  'apv2/workflow.py': `"""The workflow engine's queue (provided): enqueue hands a turn to the Chain of Thought workers."""
import json

import redis

TURN_QUEUE = "apv2:turns"

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def enqueue(turn: dict) -> None:
    """Append the turn to the Redis list apv2:turns; a worker runs it outside the request."""
    r.rpush(TURN_QUEUE, json.dumps(turn))
`,
  'apv2/handoff.py': `"""The human escalation queue (provided): turns a person answers instead of the model."""
import json

import redis

HANDOFF_KEY = "apv2:handoff"

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def escalate(tenant: str, conversation: str, turn_id: str, verdicts: dict) -> None:
    """Queue the turn for a human agent with the guardrail verdicts that stopped it."""
    row = {"tenant": tenant, "conversation": conversation, "turn_id": turn_id, "verdicts": verdicts}
    r.rpush(HANDOFF_KEY, json.dumps(row))
`,
  'apv2/outbox.py': `"""
The trace outbox (provided): \`insert(span, reason)\` appends the span to the Redis list
apv2:outbox as JSON ({"span": …, "reason": …}); a relay produces the rows later.
"""
import json

import redis

OUTBOX_KEY = "apv2:outbox"

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def insert(span: dict, reason: str) -> None:
    r.rpush(OUTBOX_KEY, json.dumps({"span": span, "reason": reason}))
`,
  'apv2/standins.py': `"""
How the stand-ins the checks serve over gRPC answer; apv2's code never calls these directly.
Deterministic on purpose: the course grades what the platform does around the model, not the prose.

retrieve(name, question): help_articles answers one article that quotes the question.
reason(messages): the question is the last user item; the tool outcomes are the tool items after it.
  "loop: …"       asks for get_reservation until it has seen 12 outcomes, then answers
  "call:<tool> …" asks for <tool> once, then answers with the outcome
  anything else   asks for get_reservation once, then answers with the reservation
invoke(tool, args): the registered tools' results; None for a name the Tool Manager does not know.
check(guardrail, question, answer, articles) -> (verdict, reason):
  relevance FAILs an answer that starts with "[off-topic]"; groundedness FAILs an answer about a
  refund when no article mentions one; pii FAILs an answer with an email address ("@").
"""
RESERVATION = '{"reservation": "HM-4410", "city": "Lisbon", "check_in": "2026-12-04"}'
TOOL_RESULTS = {
    "get_reservation": RESERVATION,
    "search_help": '{"articles": 2}',
    "update_listing": '{"updated": true}',
    "issue_refund": '{"refunded": true}',
}


def retrieve(name: str, question: str) -> list[str]:
    return [f"Help article for: {question}"] if name == "help_articles" else []


def reason(messages) -> dict:
    """messages: items with .kind and .text (or dicts). Returns kind, tool, args, text and token counts."""
    items = [(m["kind"], m["text"]) if isinstance(m, dict) else (m.kind, m.text) for m in messages]
    last_user = max((i for i, (kind, _) in enumerate(items) if kind == "user"), default=-1)
    question = items[last_user][1] if last_user >= 0 else ""
    outcomes = [text for kind, text in items[last_user + 1:] if kind == "tool"]
    tokens = {"input_tokens": sum(len(text) for _, text in items) // 4 + 1, "output_tokens": 16}

    def tool(name: str) -> dict:
        return {"kind": "tool", "tool": name, "args": "{}", "text": "", **tokens}

    def result(text: str) -> dict:
        return {"kind": "result", "tool": "", "args": "", "text": text, **tokens}

    if question.startswith("loop:"):
        return tool("get_reservation") if len(outcomes) < 12 else result("I could not settle this.")
    if question.startswith("call:"):
        name = question[len("call:"):].split(" ")[0]
        return tool(name) if not outcomes else result("Done: " + outcomes[-1])
    return tool("get_reservation") if not outcomes else result("Your next stay: " + outcomes[-1])


def invoke(tool: str, args: str) -> str | None:
    return TOOL_RESULTS.get(tool)


def check(guardrail: str, question: str, answer: str, articles) -> tuple[str, str]:
    if guardrail == "relevance" and answer.startswith("[off-topic]"):
        return "FAIL", "the answer is not about the question"
    if guardrail == "groundedness" and "refund" in answer.lower() and not any("refund" in a.lower() for a in articles):
        return "FAIL", "the refund claim is in no article"
    if guardrail == "pii" and "@" in answer:
        return "FAIL", "the answer carries an email address"
    return "PASS", ""
`,
};

export const supportModulesTs: Record<string, string> = {
  'apv2/config.ts': `/** Addresses, the trace topic and the Redis key layout every step of apv2 agrees on. */
import {createHash} from 'node:crypto';

/** The dependencies' gRPC addresses: stand-ins served by the checks (apv2/standins). */
export const RETRIEVER = 'retriever:9300';
export const LLM_ADAPTER = 'llm-adapter:9000';
export const TOOL_MANAGER = 'tools:9100';
export const GUARDRAIL_FRAMEWORK = 'guardrails:9200';
/** One span per LLM, tool or guardrail call, for the insights consumer. */
export const TRACE_TOPIC = 'assistant.trace';

/** The stored turn of one (conversation, Idempotency-Key): a JSON string. */
export const turnKey = (conversation: string, idemKey: string): string => \`turn:\${conversation}:\${idemKey}\`;
/** One conversation's runtime context: a list of JSON items {"kind", "text"}, oldest first. */
export const contextKey = (tenant: string, conversation: string): string => \`ctx:\${tenant}:\${conversation}\`;
/** The user's record: a hash (customer_name, user_role, current_trip, email, phone, payment_last4). */
export const profileKey = (tenant: string, user: string): string => \`profile:\${tenant}:\${user}\`;
/** A dynamic retriever's cached answer to one question: a JSON list of strings. */
export const retrieverKey = (tenant: string, name: string, question: string): string =>
  \`retr:\${tenant}:\${name}:\${createHash('sha256').update(question, 'utf8').digest('hex').slice(0, 16)}\`;
/** The insights counters of one call kind and name: a hash (calls, latency_ms, input_tokens, output_tokens, blocked). */
export const metricsKey = (tenant: string, kind: string, name: string): string => \`metrics:\${tenant}:\${kind}:\${name}\`;
`,
  'apv2/model.ts': `/** The shapes apv2's steps pass each other. */

/** A turn: one customer message on its way through the platform. */
export interface Turn {
  turn_id: string;
  tenant: string;
  conversation: string;
  actor: string;
  /** "customer" or "agent": decides which tools the reasoning loop may run. */
  role: string;
  text: string;
}

/** One entry of the runtime context: kind is user, assistant or tool. */
export interface Item {
  kind: string;
  text: string;
}

/** What the context store assembles for one LLM call. */
export interface Context {
  history: Item[];
  /** The declared static context (field → value). */
  profile: Record<string, string>;
  /** What the dynamic retrievers returned for this question. */
  articles: string[];
}

/** The step-2 context store, as the reasoning loop uses it. */
export interface ContextStore {
  appendItem(tenant: string, conversation: string, item: Item): Promise<void>;
  assemble(tenant: string, conversation: string, user: string, question: string): Promise<Context>;
}
`,
  'apv2/auth.ts': `/** Bearer-token verification (provided): the identity provider's tokens, as principals. */
export interface Principal {
  tenant: string;
  actor_id: string;
  /** "customer" or "agent". */
  role: string;
}

export const TOKENS: Record<string, Principal> = {
  'tok-guest-1': {tenant: 't1', actor_id: 'guest-1', role: 'customer'},
  'tok-guest-2': {tenant: 't1', actor_id: 'guest-2', role: 'customer'},
  'tok-agent-7': {tenant: 't1', actor_id: 'agent-7', role: 'agent'},
  'tok-host-3': {tenant: 't2', actor_id: 'host-3', role: 'customer'},
};

/** The principal behind \`Authorization: Bearer <token>\`; null when the header is missing or the token unknown. */
export function verify(authorization: string | undefined): Principal | null {
  if (authorization === undefined || !authorization.startsWith('Bearer ')) return null;
  return TOKENS[authorization.slice('Bearer '.length).trim()] ?? null;
}
`,
  'apv2/turns.ts': `/**
 * The turn store (provided): one turn per (conversation, Idempotency-Key) in Redis, a JSON string
 * under turnKey that lives TURN_TTL_S.
 */
import Redis from 'ioredis';

import {turnKey} from 'apv2/config';
import type {Turn} from 'apv2/model';

export const TURN_TTL_S = 86_400;

const redis = new Redis({host: 'redis', port: 6379});

/** The turn stored under (conversation, idemKey), if any. */
export async function get(conversation: string, idemKey: string): Promise<Turn | null> {
  const raw = await redis.get(turnKey(conversation, idemKey));
  return raw === null ? null : (JSON.parse(raw) as Turn);
}

/** Store the turn under (conversation, idemKey), replacing whatever was there. */
export async function put(conversation: string, idemKey: string, turn: Turn): Promise<void> {
  await redis.set(turnKey(conversation, idemKey), JSON.stringify(turn), 'EX', TURN_TTL_S);
}

/** Store the turn unless one is already there (one SET NX): null when this turn was stored, else the stored one. */
export async function claim(conversation: string, idemKey: string, turn: Turn): Promise<Turn | null> {
  const stored = await redis.set(turnKey(conversation, idemKey), JSON.stringify(turn), 'EX', TURN_TTL_S, 'NX');
  if (stored === 'OK') return null;
  return get(conversation, idemKey);
}
`,
  'apv2/workflow.ts': `/** The workflow engine's queue (provided): enqueue hands a turn to the Chain of Thought workers. */
import Redis from 'ioredis';

import type {Turn} from 'apv2/model';

export const TURN_QUEUE = 'apv2:turns';

const redis = new Redis({host: 'redis', port: 6379});

/** Append the turn to the Redis list apv2:turns; a worker runs it outside the request. */
export async function enqueue(turn: Turn): Promise<void> {
  await redis.rpush(TURN_QUEUE, JSON.stringify(turn));
}
`,
  'apv2/handoff.ts': `/** The human escalation queue (provided): turns a person answers instead of the model. */
import Redis from 'ioredis';

export const HANDOFF_KEY = 'apv2:handoff';

const redis = new Redis({host: 'redis', port: 6379});

/** Queue the turn for a human agent with the guardrail verdicts that stopped it. */
export async function escalate(tenant: string, conversation: string, turnId: string, verdicts: Record<string, string>): Promise<void> {
  await redis.rpush(HANDOFF_KEY, JSON.stringify({tenant, conversation, turn_id: turnId, verdicts}));
}
`,
  'apv2/outbox.ts': `/**
 * The trace outbox (provided): \`insert(span, reason)\` appends the span to the Redis list
 * apv2:outbox as JSON ({"span": …, "reason": …}); a relay produces the rows later.
 */
import Redis from 'ioredis';

export const OUTBOX_KEY = 'apv2:outbox';

const redis = new Redis({host: 'redis', port: 6379});

export async function insert(span: Record<string, unknown>, reason: string): Promise<void> {
  await redis.rpush(OUTBOX_KEY, JSON.stringify({span, reason}));
}
`,
  'apv2/standins.ts': `/**
 * How the stand-ins the checks serve over gRPC answer; apv2's code never calls these directly.
 * Deterministic on purpose: the course grades what the platform does around the model, not the prose.
 * The rules are apv2/standins.py's.
 */
export const RESERVATION = '{"reservation": "HM-4410", "city": "Lisbon", "check_in": "2026-12-04"}';
export const TOOL_RESULTS: Record<string, string> = {
  get_reservation: RESERVATION,
  search_help: '{"articles": 2}',
  update_listing: '{"updated": true}',
  issue_refund: '{"refunded": true}',
};

export interface Move {
  kind: string;
  tool: string;
  args: string;
  text: string;
  input_tokens: number;
  output_tokens: number;
}

export function retrieve(name: string, question: string): string[] {
  return name === 'help_articles' ? [\`Help article for: \${question}\`] : [];
}

export function reason(messages: {kind: string; text: string}[]): Move {
  let lastUser = -1;
  messages.forEach((m, i) => {
    if (m.kind === 'user') lastUser = i;
  });
  const question = lastUser >= 0 ? messages[lastUser].text : '';
  const outcomes = messages.slice(lastUser + 1).filter(m => m.kind === 'tool').map(m => m.text);
  const tokens = {input_tokens: Math.floor(messages.reduce((n, m) => n + m.text.length, 0) / 4) + 1, output_tokens: 16};
  const tool = (name: string): Move => ({kind: 'tool', tool: name, args: '{}', text: '', ...tokens});
  const result = (text: string): Move => ({kind: 'result', tool: '', args: '', text, ...tokens});
  if (question.startsWith('loop:')) return outcomes.length < 12 ? tool('get_reservation') : result('I could not settle this.');
  if (question.startsWith('call:')) {
    const name = question.slice('call:'.length).split(' ')[0];
    return outcomes.length === 0 ? tool(name) : result('Done: ' + outcomes[outcomes.length - 1]);
  }
  return outcomes.length === 0 ? tool('get_reservation') : result('Your next stay: ' + outcomes[outcomes.length - 1]);
}

export function invoke(tool: string, _args: string): string | null {
  return TOOL_RESULTS[tool] ?? null;
}

export function check(guardrail: string, _question: string, answer: string, articles: string[]): {verdict: string; reason: string} {
  if (guardrail === 'relevance' && answer.startsWith('[off-topic]')) return {verdict: 'FAIL', reason: 'the answer is not about the question'};
  if (guardrail === 'groundedness' && answer.toLowerCase().includes('refund') && !articles.some(a => a.toLowerCase().includes('refund')))
    return {verdict: 'FAIL', reason: 'the refund claim is in no article'};
  if (guardrail === 'pii' && answer.includes('@')) return {verdict: 'FAIL', reason: 'the answer carries an email address'};
  return {verdict: 'PASS', reason: ''};
}
`,
};

/** The Go twins: the same \`apv2\` packages, imported as apv2/config, apv2/auth, apv2/turns, … */
export const supportModulesGo: Record<string, string> = {
  'apv2/config/config.go': `// Package config holds the addresses, the trace topic and the Redis key layout every step of apv2
// agrees on.
package config

import (
	"crypto/sha256"
	"encoding/hex"
)

const (
	// The dependencies' gRPC addresses: stand-ins served by the checks (apv2/standins).
	Retriever          = "retriever:9300"
	LlmAdapter         = "llm-adapter:9000"
	ToolManager        = "tools:9100"
	GuardrailFramework = "guardrails:9200"
	// TraceTopic carries one span per LLM, tool or guardrail call, for the insights consumer.
	TraceTopic = "assistant.trace"
)

// TurnKey is the stored turn of one (conversation, Idempotency-Key): a JSON string.
func TurnKey(conversation, idemKey string) string { return "turn:" + conversation + ":" + idemKey }

// ContextKey is one conversation's runtime context: a list of JSON items {"kind", "text"}, oldest first.
func ContextKey(tenant, conversation string) string { return "ctx:" + tenant + ":" + conversation }

// ProfileKey is the user's record: a hash (customer_name, user_role, current_trip, email, phone, payment_last4).
func ProfileKey(tenant, user string) string { return "profile:" + tenant + ":" + user }

// RetrieverKey is a dynamic retriever's cached answer to one question: a JSON list of strings.
func RetrieverKey(tenant, name, question string) string {
	sum := sha256.Sum256([]byte(question))
	return "retr:" + tenant + ":" + name + ":" + hex.EncodeToString(sum[:])[:16]
}

// MetricsKey holds the insights counters of one call kind and name: a hash (calls, latency_ms,
// input_tokens, output_tokens, blocked).
func MetricsKey(tenant, kind, name string) string { return "metrics:" + tenant + ":" + kind + ":" + name }
`,
  'apv2/model/model.go': `// Package model holds the shapes apv2's steps pass each other.
package model

import "context"

// Turn is one customer message on its way through the platform. Role ("customer" or "agent")
// decides which tools the reasoning loop may run.
type Turn struct {
	TurnID       string \`json:"turn_id"\`
	Tenant       string \`json:"tenant"\`
	Conversation string \`json:"conversation"\`
	Actor        string \`json:"actor"\`
	Role         string \`json:"role"\`
	Text         string \`json:"text"\`
}

// Item is one entry of the runtime context: Kind is user, assistant or tool.
type Item struct {
	Kind string \`json:"kind"\`
	Text string \`json:"text"\`
}

// Context is what the context store assembles for one LLM call: the history, the declared static
// context (field → value) and what the dynamic retrievers returned for this question.
type Context struct {
	History  []Item
	Profile  map[string]string
	Articles []string
}

// ContextStore is the step-2 context store, as the reasoning loop uses it.
type ContextStore interface {
	AppendItem(ctx context.Context, tenant, conversation string, item Item) error
	Assemble(ctx context.Context, tenant, conversation, user, question string) (Context, error)
}
`,
  'apv2/auth/auth.go': `// Package auth is bearer-token verification (provided): the identity provider's tokens, as principals.
package auth

import "strings"

// Principal is who a verified token belongs to; Role is "customer" or "agent".
type Principal struct {
	Tenant  string
	ActorID string
	Role    string
}

var tokens = map[string]Principal{
	"tok-guest-1": {Tenant: "t1", ActorID: "guest-1", Role: "customer"},
	"tok-guest-2": {Tenant: "t1", ActorID: "guest-2", Role: "customer"},
	"tok-agent-7": {Tenant: "t1", ActorID: "agent-7", Role: "agent"},
	"tok-host-3":  {Tenant: "t2", ActorID: "host-3", Role: "customer"},
}

// Verify is the principal behind "Authorization: Bearer <token>"; ok is false when the header is
// missing or the token unknown.
func Verify(authorization string) (Principal, bool) {
	if !strings.HasPrefix(authorization, "Bearer ") {
		return Principal{}, false
	}
	p, ok := tokens[strings.TrimSpace(strings.TrimPrefix(authorization, "Bearer "))]
	return p, ok
}
`,
  'apv2/turns/turns.go': `// Package turns is the turn store (provided): one turn per (conversation, Idempotency-Key) in
// Redis, a JSON string under config.TurnKey that lives TurnTTL.
package turns

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"

	"apv2/config"
	"apv2/model"
)

const TurnTTL = 86_400 * time.Second

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Get is the turn stored under (conversation, idemKey); nil when there is none.
func Get(ctx context.Context, conversation, idemKey string) (*model.Turn, error) {
	raw, err := rdb.Get(ctx, config.TurnKey(conversation, idemKey)).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var turn model.Turn
	if err := json.Unmarshal(raw, &turn); err != nil {
		return nil, err
	}
	return &turn, nil
}

// Put stores the turn under (conversation, idemKey), replacing whatever was there.
func Put(ctx context.Context, conversation, idemKey string, turn model.Turn) error {
	doc, _ := json.Marshal(turn)
	return rdb.Set(ctx, config.TurnKey(conversation, idemKey), doc, TurnTTL).Err()
}

// Claim stores the turn unless one is already there (one SET NX): nil when this turn was stored,
// else the stored one.
func Claim(ctx context.Context, conversation, idemKey string, turn model.Turn) (*model.Turn, error) {
	doc, _ := json.Marshal(turn)
	stored, err := rdb.SetNX(ctx, config.TurnKey(conversation, idemKey), doc, TurnTTL).Result()
	if err != nil {
		return nil, err
	}
	if stored {
		return nil, nil
	}
	return Get(ctx, conversation, idemKey)
}
`,
  'apv2/workflow/workflow.go': `// Package workflow is the workflow engine's queue (provided): Enqueue hands a turn to the Chain of
// Thought workers.
package workflow

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"

	"apv2/model"
)

const TurnQueue = "apv2:turns"

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Enqueue appends the turn to the Redis list apv2:turns; a worker runs it outside the request.
func Enqueue(ctx context.Context, turn model.Turn) error {
	doc, _ := json.Marshal(turn)
	return rdb.RPush(ctx, TurnQueue, doc).Err()
}
`,
  'apv2/handoff/handoff.go': `// Package handoff is the human escalation queue (provided): turns a person answers instead of the model.
package handoff

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"
)

const Key = "apv2:handoff"

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Escalate queues the turn for a human agent with the guardrail verdicts that stopped it.
func Escalate(ctx context.Context, tenant, conversation, turnID string, verdicts map[string]string) error {
	row, _ := json.Marshal(map[string]any{"tenant": tenant, "conversation": conversation, "turn_id": turnID, "verdicts": verdicts})
	return rdb.RPush(ctx, Key, row).Err()
}
`,
  'apv2/outbox/outbox.go': `// Package outbox is the trace outbox (provided): Insert appends the span to the Redis list
// apv2:outbox as JSON ({"span": …, "reason": …}); a relay produces the rows later.
package outbox

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"
)

const Key = "apv2:outbox"

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Insert appends span (a JSON document) with the reason it could not be produced.
func Insert(ctx context.Context, span json.RawMessage, reason string) error {
	row, _ := json.Marshal(map[string]any{"span": span, "reason": reason})
	return rdb.RPush(ctx, Key, row).Err()
}
`,
  'apv2/standins/standins.go': `// Package standins is how the stand-ins the checks serve over gRPC answer; apv2's code never calls
// it directly. Deterministic on purpose: the course grades what the platform does around the model,
// not the prose. The rules are apv2/standins.py's.
package standins

import (
	"strings"

	"apv2/model"
)

const Reservation = \`{"reservation": "HM-4410", "city": "Lisbon", "check_in": "2026-12-04"}\`

var ToolResults = map[string]string{
	"get_reservation": Reservation,
	"search_help":     \`{"articles": 2}\`,
	"update_listing":  \`{"updated": true}\`,
	"issue_refund":    \`{"refunded": true}\`,
}

// Move is the model's answer: Kind "tool" (run Tool with Args) or "result" (Text is the answer).
type Move struct {
	Kind, Tool, Args, Text    string
	InputTokens, OutputTokens int32
}

func Retrieve(name, question string) []string {
	if name == "help_articles" {
		return []string{"Help article for: " + question}
	}
	return []string{}
}

func Reason(messages []model.Item) Move {
	lastUser := -1
	size := 0
	for i, m := range messages {
		size += len(m.Text)
		if m.Kind == "user" {
			lastUser = i
		}
	}
	question := ""
	if lastUser >= 0 {
		question = messages[lastUser].Text
	}
	var outcomes []string
	for _, m := range messages[lastUser+1:] {
		if m.Kind == "tool" {
			outcomes = append(outcomes, m.Text)
		}
	}
	in := int32(size/4 + 1)
	tool := func(name string) Move { return Move{Kind: "tool", Tool: name, Args: "{}", InputTokens: in, OutputTokens: 16} }
	result := func(text string) Move { return Move{Kind: "result", Text: text, InputTokens: in, OutputTokens: 16} }
	switch {
	case strings.HasPrefix(question, "loop:"):
		if len(outcomes) < 12 {
			return tool("get_reservation")
		}
		return result("I could not settle this.")
	case strings.HasPrefix(question, "call:"):
		name := strings.SplitN(strings.TrimPrefix(question, "call:"), " ", 2)[0]
		if len(outcomes) == 0 {
			return tool(name)
		}
		return result("Done: " + outcomes[len(outcomes)-1])
	}
	if len(outcomes) == 0 {
		return tool("get_reservation")
	}
	return result("Your next stay: " + outcomes[len(outcomes)-1])
}

// Invoke is a registered tool's result; ok is false for a name the Tool Manager does not know.
func Invoke(tool, args string) (string, bool) {
	r, ok := ToolResults[tool]
	return r, ok
}

func Check(guardrail, question, answer string, articles []string) (verdict, reason string) {
	if guardrail == "relevance" && strings.HasPrefix(answer, "[off-topic]") {
		return "FAIL", "the answer is not about the question"
	}
	if guardrail == "groundedness" && strings.Contains(strings.ToLower(answer), "refund") {
		grounded := false
		for _, a := range articles {
			grounded = grounded || strings.Contains(strings.ToLower(a), "refund")
		}
		if !grounded {
			return "FAIL", "the refund claim is in no article"
		}
	}
	if guardrail == "pii" && strings.Contains(answer, "@") {
		return "FAIL", "the answer carries an email address"
	}
	return "PASS", ""
}
`,
};

/** The C++ twins as headers (apv2/*.h), plus digest.h (SHA-256) for the retriever key and ids.h (UUIDs). */
export const supportModulesCpp: Record<string, string> = {
  'digest.h': CPP_DIGEST_H,
  'ids.h': CPP_IDS_H,
  'apv2/config.h': `// Addresses, the trace topic and the Redis key layout every step of apv2 agrees on.
#pragma once

#include <string>

#include <sw/redis++/redis++.h>

#include "digest.h"

namespace config {

// The dependencies' gRPC addresses: stand-ins served by the checks (apv2/standins.h).
inline constexpr const char* kRetriever = "retriever:9300";
inline constexpr const char* kLlmAdapter = "llm-adapter:9000";
inline constexpr const char* kToolManager = "tools:9100";
inline constexpr const char* kGuardrailFramework = "guardrails:9200";
// One span per LLM, tool or guardrail call, for the insights consumer.
inline constexpr const char* kTraceTopic = "assistant.trace";

// The stored turn of one (conversation, Idempotency-Key): a JSON string.
inline std::string turn_key(const std::string& conversation, const std::string& idem_key) { return "turn:" + conversation + ":" + idem_key; }
// One conversation's runtime context: a list of JSON items {"kind", "text"}, oldest first.
inline std::string context_key(const std::string& tenant, const std::string& conversation) { return "ctx:" + tenant + ":" + conversation; }
// The user's record: a hash (customer_name, user_role, current_trip, email, phone, payment_last4).
inline std::string profile_key(const std::string& tenant, const std::string& user) { return "profile:" + tenant + ":" + user; }
// A dynamic retriever's cached answer to one question: a JSON list of strings.
inline std::string retriever_key(const std::string& tenant, const std::string& name, const std::string& question) {
  return "retr:" + tenant + ":" + name + ":" + sha256_hex(question).substr(0, 16);
}
// The insights counters of one call kind and name: a hash (calls, latency_ms, input_tokens, output_tokens, blocked).
inline std::string metrics_key(const std::string& tenant, const std::string& kind, const std::string& name) {
  return "metrics:" + tenant + ":" + kind + ":" + name;
}

// The one Redis connection the provided modules share.
inline sw::redis::Redis& redis() {
  static sw::redis::Redis conn("tcp://redis:6379");
  return conn;
}

}  // namespace config
`,
  'apv2/model.h': `// The shapes apv2's steps pass each other. A turn is JSON: {turn_id, tenant, conversation, actor,
// role, text}; role ("customer" or "agent") decides which tools the reasoning loop may run.
#pragma once

#include <map>
#include <string>
#include <vector>

namespace model {

// One entry of the runtime context: kind is user, assistant or tool.
struct Item {
  std::string kind;
  std::string text;
};

// What the context store assembles for one LLM call: the history, the declared static context
// (field → value) and what the dynamic retrievers returned for this question.
struct Context {
  std::vector<Item> history;
  std::map<std::string, std::string> profile;
  std::vector<std::string> articles;
};

// The step-2 context store, as the reasoning loop uses it.
struct ContextStore {
  virtual ~ContextStore() = default;
  virtual void append_item(const std::string& tenant, const std::string& conversation, const Item& item) = 0;
  virtual Context assemble(const std::string& tenant, const std::string& conversation, const std::string& user, const std::string& question) = 0;
};

}  // namespace model
`,
  'apv2/auth.h': `// Bearer-token verification (provided): the identity provider's tokens, as principals.
#pragma once

#include <map>
#include <optional>
#include <string>

namespace auth {

struct Principal {
  std::string tenant;
  std::string actor_id;
  std::string role;  // "customer" or "agent"
};

// The principal behind "Authorization: Bearer <token>"; nullopt when the header is missing or the
// token unknown.
inline std::optional<Principal> verify(const std::string& authorization) {
  static const std::map<std::string, Principal> tokens = {
      {"tok-guest-1", {"t1", "guest-1", "customer"}},
      {"tok-guest-2", {"t1", "guest-2", "customer"}},
      {"tok-agent-7", {"t1", "agent-7", "agent"}},
      {"tok-host-3", {"t2", "host-3", "customer"}},
  };
  if (authorization.rfind("Bearer ", 0) != 0) return std::nullopt;
  std::string token = authorization.substr(7);
  while (!token.empty() && token.back() == ' ') token.pop_back();
  const auto it = tokens.find(token);
  if (it == tokens.end()) return std::nullopt;
  return it->second;
}

}  // namespace auth
`,
  'apv2/turns.h': `// The turn store (provided): one turn per (conversation, Idempotency-Key) in Redis, a JSON string
// under config::turn_key that lives kTurnTtlSeconds.
#pragma once

#include <optional>
#include <string>

#include <nlohmann/json.hpp>

#include "apv2/config.h"

namespace turns {

inline constexpr long long kTurnTtlSeconds = 86400;

// The turn stored under (conversation, idem_key), if any.
inline std::optional<nlohmann::json> get(const std::string& conversation, const std::string& idem_key) {
  const auto raw = config::redis().get(config::turn_key(conversation, idem_key));
  if (!raw) return std::nullopt;
  return nlohmann::json::parse(*raw);
}

// Store the turn under (conversation, idem_key), replacing whatever was there.
inline void put(const std::string& conversation, const std::string& idem_key, const nlohmann::json& turn) {
  config::redis().set(config::turn_key(conversation, idem_key), turn.dump(), std::chrono::seconds(kTurnTtlSeconds));
}

// Store the turn unless one is already there (one SET NX): nullopt when this turn was stored, else
// the stored one.
inline std::optional<nlohmann::json> claim(const std::string& conversation, const std::string& idem_key, const nlohmann::json& turn) {
  if (config::redis().set(config::turn_key(conversation, idem_key), turn.dump(), std::chrono::seconds(kTurnTtlSeconds),
                          sw::redis::UpdateType::NOT_EXIST)) {
    return std::nullopt;
  }
  return get(conversation, idem_key);
}

}  // namespace turns
`,
  'apv2/workflow.h': `// The workflow engine's queue (provided): enqueue hands a turn to the Chain of Thought workers.
#pragma once

#include <nlohmann/json.hpp>

#include "apv2/config.h"

namespace workflow {

inline constexpr const char* kTurnQueue = "apv2:turns";

// Append the turn to the Redis list apv2:turns; a worker runs it outside the request.
inline void enqueue(const nlohmann::json& turn) { config::redis().rpush(kTurnQueue, turn.dump()); }

}  // namespace workflow
`,
  'apv2/handoff.h': `// The human escalation queue (provided): turns a person answers instead of the model.
#pragma once

#include <map>
#include <string>

#include <nlohmann/json.hpp>

#include "apv2/config.h"

namespace handoff {

inline constexpr const char* kKey = "apv2:handoff";

// Queue the turn for a human agent with the guardrail verdicts that stopped it.
inline void escalate(const std::string& tenant, const std::string& conversation, const std::string& turn_id,
                     const std::map<std::string, std::string>& verdicts) {
  const nlohmann::json row = {{"tenant", tenant}, {"conversation", conversation}, {"turn_id", turn_id}, {"verdicts", verdicts}};
  config::redis().rpush(kKey, row.dump());
}

}  // namespace handoff
`,
  'apv2/outbox.h': `// The trace outbox (provided): insert(span_json, reason) appends the span to the Redis list
// apv2:outbox as JSON ({"span": …, "reason": …}); a relay produces the rows later.
#pragma once

#include <string>

#include <nlohmann/json.hpp>

#include "apv2/config.h"

namespace outbox {

inline constexpr const char* kKey = "apv2:outbox";

inline void insert(const std::string& span_json, const std::string& reason) {
  nlohmann::json row;
  row["span"] = nlohmann::json::parse(span_json, nullptr, false);
  row["reason"] = reason;
  config::redis().rpush(kKey, row.dump());
}

}  // namespace outbox
`,
  'apv2/standins.h': `// How the stand-ins the checks serve over gRPC answer; apv2's code never calls these directly.
// Deterministic on purpose: the course grades what the platform does around the model, not the
// prose. The rules are apv2/standins.py's.
#pragma once

#include <algorithm>
#include <cctype>
#include <map>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "apv2/model.h"

namespace standins {

inline const std::string kReservation = R"({"reservation": "HM-4410", "city": "Lisbon", "check_in": "2026-12-04"})";

inline const std::map<std::string, std::string>& tool_results() {
  static const std::map<std::string, std::string> results = {
      {"get_reservation", kReservation},
      {"search_help", R"({"articles": 2})"},
      {"update_listing", R"({"updated": true})"},
      {"issue_refund", R"({"refunded": true})"},
  };
  return results;
}

// The model's answer: kind "tool" (run tool with args) or "result" (text is the answer).
struct Move {
  std::string kind, tool, args, text;
  int input_tokens = 0, output_tokens = 0;
};

inline std::vector<std::string> retrieve(const std::string& name, const std::string& question) {
  if (name == "help_articles") return {"Help article for: " + question};
  return {};
}

inline Move reason(const std::vector<model::Item>& messages) {
  int last_user = -1;
  size_t chars = 0;
  for (size_t i = 0; i < messages.size(); i++) {
    chars += messages[i].text.size();
    if (messages[i].kind == "user") last_user = static_cast<int>(i);
  }
  const std::string question = last_user >= 0 ? messages[last_user].text : "";
  std::vector<std::string> outcomes;
  for (size_t i = last_user + 1; i < messages.size(); i++) {
    if (messages[i].kind == "tool") outcomes.push_back(messages[i].text);
  }
  const int in = static_cast<int>(chars / 4 + 1);
  const auto tool = [&](const std::string& name) { return Move{"tool", name, "{}", "", in, 16}; };
  const auto result = [&](const std::string& text) { return Move{"result", "", "", text, in, 16}; };
  if (question.rfind("loop:", 0) == 0) return outcomes.size() < 12 ? tool("get_reservation") : result("I could not settle this.");
  if (question.rfind("call:", 0) == 0) {
    const std::string rest = question.substr(5);
    const std::string name = rest.substr(0, rest.find(' '));
    return outcomes.empty() ? tool(name) : result("Done: " + outcomes.back());
  }
  return outcomes.empty() ? tool("get_reservation") : result("Your next stay: " + outcomes.back());
}

// A registered tool's result; nullopt for a name the Tool Manager does not know.
inline std::optional<std::string> invoke(const std::string& tool, const std::string&) {
  const auto it = tool_results().find(tool);
  if (it == tool_results().end()) return std::nullopt;
  return it->second;
}

inline std::string lower(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return s;
}

inline std::pair<std::string, std::string> check(const std::string& guardrail, const std::string&, const std::string& answer,
                                                 const std::vector<std::string>& articles) {
  if (guardrail == "relevance" && answer.rfind("[off-topic]", 0) == 0) return {"FAIL", "the answer is not about the question"};
  if (guardrail == "groundedness" && lower(answer).find("refund") != std::string::npos &&
      std::none_of(articles.begin(), articles.end(), [](const std::string& a) { return lower(a).find("refund") != std::string::npos; })) {
    return {"FAIL", "the refund claim is in no article"};
  }
  if (guardrail == "pii" && answer.find('@') != std::string::npos) return {"FAIL", "the answer carries an email address"};
  return {"PASS", ""};
}

}  // namespace standins
`,
};

/** The Scala twins: the same \`apv2\` objects, compiled with the steps by \`yarn check:scala\`. */
export const supportModulesScala: Record<string, string> = {
  [scalaPath('apv2', 'Config')]: `package apv2

import java.nio.charset.StandardCharsets.UTF_8
import java.security.MessageDigest

/** Addresses, the trace topic and the Redis key layout every step of apv2 agrees on. */
object Config {
  /** The dependencies' gRPC addresses: stand-ins served by the checks. */
  val Retriever = "retriever:9300"
  val LlmAdapter = "llm-adapter:9000"
  val ToolManager = "tools:9100"
  val GuardrailFramework = "guardrails:9200"
  /** One span per LLM, tool or guardrail call, for the insights consumer. */
  val TraceTopic = "assistant.trace"

  /** The stored turn of one (conversation, Idempotency-Key): a JSON string. */
  def turnKey(conversation: String, idemKey: String): String = s"turn:$conversation:$idemKey"
  /** One conversation's runtime context: a list of JSON items {"kind", "text"}, oldest first. */
  def contextKey(tenant: String, conversation: String): String = s"ctx:$tenant:$conversation"
  /** The user's record: a hash (customer_name, user_role, current_trip, email, phone, payment_last4). */
  def profileKey(tenant: String, user: String): String = s"profile:$tenant:$user"
  /** A dynamic retriever's cached answer to one question: a JSON list of strings. */
  def retrieverKey(tenant: String, name: String, question: String): String = {
    val digest = MessageDigest.getInstance("SHA-256").digest(question.getBytes(UTF_8)).map("%02x".format(_)).mkString
    s"retr:$tenant:$name:\${digest.take(16)}"
  }
  /** The insights counters of one call kind and name: a hash (calls, latency_ms, input_tokens, output_tokens, blocked). */
  def metricsKey(tenant: String, kind: String, name: String): String = s"metrics:$tenant:$kind:$name"
}
`,
  [scalaPath('apv2', 'Model')]: `package apv2

/** A turn: one customer message on its way through the platform; role decides which tools the loop may run. */
final case class Turn(turn_id: String, tenant: String, conversation: String, actor: String, role: String, text: String)

/** One entry of the runtime context: kind is user, assistant or tool. */
final case class Item(kind: String, text: String)

/** What the context store assembles for one LLM call. */
final case class Context(history: Seq[Item], profile: Map[String, String], articles: Seq[String])

/** The step-2 context store, as the reasoning loop uses it. */
trait ContextStore {
  def appendItem(tenant: String, conversation: String, item: Item): Unit
  def assemble(tenant: String, conversation: String, user: String, question: String): Context
}

object Turn {
  def toJson(t: Turn): String = ujson.write(
    ujson.Obj(
      "turn_id" -> t.turn_id,
      "tenant" -> t.tenant,
      "conversation" -> t.conversation,
      "actor" -> t.actor,
      "role" -> t.role,
      "text" -> t.text
    )
  )

  def fromJson(raw: String): Turn = {
    val j = ujson.read(raw)
    Turn(j("turn_id").str, j("tenant").str, j("conversation").str, j("actor").str, j("role").str, j("text").str)
  }
}
`,
  [scalaPath('apv2', 'Auth')]: `package apv2

/** Who a verified token belongs to; role is "customer" or "agent". */
final case class Principal(tenant: String, actorId: String, role: String)

/** Bearer-token verification (provided): the identity provider's tokens, as principals. */
object Auth {
  private val tokens = Map(
    "tok-guest-1" -> Principal("t1", "guest-1", "customer"),
    "tok-guest-2" -> Principal("t1", "guest-2", "customer"),
    "tok-agent-7" -> Principal("t1", "agent-7", "agent"),
    "tok-host-3" -> Principal("t2", "host-3", "customer")
  )

  /** The principal behind \`Authorization: Bearer <token>\`; None when the header is missing or the token unknown. */
  def verify(authorization: Option[String]): Option[Principal] =
    authorization.filter(_.startsWith("Bearer ")).map(_.drop(7).trim).flatMap(tokens.get)
}
`,
  [scalaPath('apv2', 'Turns')]: `package apv2

import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

/** The turn store (provided): one turn per (conversation, Idempotency-Key) in Redis, a JSON string that lives TurnTtlSeconds. */
object Turns {
  val TurnTtlSeconds = 86400L
  private val jedis = new JedisPooled("redis", 6379)

  /** The turn stored under (conversation, idemKey), if any. */
  def get(conversation: String, idemKey: String): Option[Turn] =
    Option(jedis.get(Config.turnKey(conversation, idemKey))).map(Turn.fromJson)

  /** Store the turn under (conversation, idemKey), replacing whatever was there. */
  def put(conversation: String, idemKey: String, turn: Turn): Unit = {
    jedis.set(Config.turnKey(conversation, idemKey), Turn.toJson(turn), SetParams.setParams().ex(TurnTtlSeconds))
    ()
  }

  /** Store the turn unless one is already there (one SET NX): None when this turn was stored, else the stored one. */
  def claim(conversation: String, idemKey: String, turn: Turn): Option[Turn] = {
    val stored = jedis.set(Config.turnKey(conversation, idemKey), Turn.toJson(turn), SetParams.setParams().ex(TurnTtlSeconds).nx())
    if (stored == "OK") None else get(conversation, idemKey)
  }
}
`,
  [scalaPath('apv2', 'Workflow')]: `package apv2

import redis.clients.jedis.JedisPooled

/** The workflow engine's queue (provided): enqueue hands a turn to the Chain of Thought workers. */
object Workflow {
  val TurnQueue = "apv2:turns"
  private val jedis = new JedisPooled("redis", 6379)

  /** Append the turn to the Redis list apv2:turns; a worker runs it outside the request. */
  def enqueue(turn: Turn): Unit = {
    jedis.rpush(TurnQueue, Turn.toJson(turn))
    ()
  }
}
`,
  [scalaPath('apv2', 'Handoff')]: `package apv2

import redis.clients.jedis.JedisPooled

/** The human escalation queue (provided): turns a person answers instead of the model. */
object Handoff {
  val Key = "apv2:handoff"
  private val jedis = new JedisPooled("redis", 6379)

  /** Queue the turn for a human agent with the guardrail verdicts that stopped it. */
  def escalate(tenant: String, conversation: String, turnId: String, verdicts: Map[String, String]): Unit = {
    val row = ujson.Obj(
      "tenant" -> tenant,
      "conversation" -> conversation,
      "turn_id" -> turnId,
      "verdicts" -> ujson.Obj.from(verdicts.map { case (k, v) => k -> ujson.Str(v) })
    )
    jedis.rpush(Key, ujson.write(row))
    ()
  }
}
`,
  [scalaPath('apv2', 'Outbox')]: `package apv2

import redis.clients.jedis.JedisPooled

/**
 * The trace outbox (provided): \`insert(spanJson, reason)\` appends the span to the Redis list
 * apv2:outbox as JSON ({"span": …, "reason": …}); a relay produces the rows later.
 */
object Outbox {
  val Key = "apv2:outbox"
  private val jedis = new JedisPooled("redis", 6379)

  def insert(spanJson: String, reason: String): Unit = {
    jedis.rpush(Key, ujson.write(ujson.Obj("span" -> ujson.read(spanJson), "reason" -> reason)))
    ()
  }
}
`,
};
