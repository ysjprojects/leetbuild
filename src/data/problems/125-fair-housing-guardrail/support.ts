/**
 * Hand-written support modules the fair-housing steps import but no step builds: the `fhguard`
 * package. `store` is fhguard's database (API keys, saved policy versions, the review queue, the
 * audit trail, the outbox), kept in Redis under `fhstore:*` so a check can read it, plus the two
 * records every step passes around (Policy, Decision). `cache` is step 3's policy cache, `tiers`
 * step 2's tiers (with `evaluate`, the guard as steps 1 and 4 call it) and `model` the client of
 * the assistant's model. The checks serve the classifier, the judge and the model over gRPC.
 */
import {CPP_DIGEST_H, CPP_IDS_H} from '../cpp-support';
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'fhguard/__init__.py': '',
  'fhguard/store.py': `"""
fhguard's database (provided), kept in Redis under fhstore:* so a check can read it: API keys
(hash fhstore:apikeys, key -> caller), saved policy versions (fhstore:policy:{version}, JSON), the
human-review queue (list fhstore:review), the audit trail (hash fhstore:audit, event_id -> event)
and the outbox (list fhstore:outbox). Policy and Decision are the records every step passes around.
"""
import json
from dataclasses import asdict, dataclass, field

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

API_KEYS = "fhstore:apikeys"
REVIEW = "fhstore:review"
AUDIT = "fhstore:audit"
OUTBOX = "fhstore:outbox"


@dataclass
class Policy:
    """A policy version (fh-YYYY-MM-DD[.n]) and the phrases its stop list blocks."""

    version: str
    stop_phrases: list[str] = field(default_factory=list)


@dataclass
class Decision:
    """What the tiers decided: allowed or not, the tier that decided, the classifier score, and why."""

    allowed: bool
    tier: str
    score: float = 0.0
    reasons: list[str] = field(default_factory=list)


def caller(api_key: str) -> str | None:
    """The caller an API key belongs to; None for an empty or unknown key."""
    return r.hget(API_KEYS, api_key) if api_key else None


def add_api_key(api_key: str, name: str) -> None:
    r.hset(API_KEYS, api_key, name)


def save_policy(policy: Policy) -> None:
    r.set(f"fhstore:policy:{policy.version}", json.dumps(asdict(policy)))


def load_policy(version: str) -> Policy | None:
    raw = r.get(f"fhstore:policy:{version}")
    return None if raw is None else Policy(**json.loads(raw))


def enqueue_review(conversation_id: str, strikes: int) -> None:
    """Hand a conversation to human review."""
    r.rpush(REVIEW, json.dumps({"conversation_id": conversation_id, "strikes": strikes}))


def review_queue() -> list[dict]:
    return [json.loads(row) for row in r.lrange(REVIEW, 0, -1)]


def append_audit(event: dict) -> bool:
    """Append-only, one row per event_id: a redelivered event is not appended twice. True when new."""
    return bool(r.hsetnx(AUDIT, event["event_id"], json.dumps(event)))


def audit_rows() -> list[dict]:
    return [json.loads(row) for row in r.hvals(AUDIT)]


def insert_outbox(event: dict, reason: str) -> None:
    """Keep an event the broker refused, with the broker's reason, for the relay to produce later."""
    r.rpush(OUTBOX, json.dumps({"event": event, "reason": reason}))


def outbox_rows() -> list[dict]:
    return [json.loads(row) for row in r.lrange(OUTBOX, 0, -1)]
`,
  'fhguard/cache.py': `"""
The policy cache (provided; step 3 builds the same functions). fh:policy:{version} caches a saved
policy for an hour; fh:policy:active names the version new conversations pin, and publish moves it
in one MULTI/EXEC with the cache entry, after the store has the version. Decisions are cached for
a day under fh:decision:{version}:{sha256 of the text}; strikes count per conversation in
fh:strikes:{conversation_id} and expire a day after the first.
"""
import hashlib
import json
from dataclasses import asdict

import redis

from fhguard import store
from fhguard.store import Decision, Policy

r = redis.Redis(host="redis", port=6379, decode_responses=True)

POLICY_TTL_S = 3600
DECISION_TTL_S = 86_400
STRIKE_TTL_S = 86_400
ACTIVE_KEY = "fh:policy:active"


def policy_key(version: str) -> str:
    return f"fh:policy:{version}"


def text_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def decision_key(version: str, text: str) -> str:
    return f"fh:decision:{version}:{text_hash(text)}"


def strikes_key(conversation_id: str) -> str:
    return f"fh:strikes:{conversation_id}"


def get_policy(version: str) -> Policy | None:
    raw = r.get(policy_key(version))
    if raw is not None:
        return Policy(**json.loads(raw))
    policy = store.load_policy(version)
    if policy is not None:
        r.set(policy_key(version), json.dumps(asdict(policy)), ex=POLICY_TTL_S)
    return policy


def active_version() -> str | None:
    return r.get(ACTIVE_KEY)


def publish(policy: Policy) -> None:
    store.save_policy(policy)
    pipe = r.pipeline(transaction=True)
    pipe.set(policy_key(policy.version), json.dumps(asdict(policy)), ex=POLICY_TTL_S)
    pipe.set(ACTIVE_KEY, policy.version)
    pipe.execute()


def cached_decision(version: str, text: str) -> Decision | None:
    raw = r.get(decision_key(version, text))
    return None if raw is None else Decision(**json.loads(raw))


def cache_decision(version: str, text: str, decision: Decision) -> None:
    r.set(decision_key(version, text), json.dumps(asdict(decision)), ex=DECISION_TTL_S)


def record_strike(conversation_id: str) -> int:
    key = strikes_key(conversation_id)
    strikes = int(r.incr(key))
    if strikes == 1:
        r.expire(key, STRIKE_TTL_S)
    return strikes
`,
  'fhguard/tiers.py': `"""
The guard tiers (provided; step 2 builds decide). decide runs the policy's stop list, then the
classifier under 250 ms, blocks at 0.35, allows below 0.15 and asks the judge (2 s) about the band
between; an RPC error at any tier blocks with reason guard_unavailable. evaluate is the guard as the
routes call it: the cached decision for (version, text), else decide under that policy version and
cache the verdict (a fail-closed decision is not a verdict and is not cached). An unknown policy
version blocks.
"""
import grpc

import fair_housing_guardrail_pb2 as pb
import fair_housing_guardrail_pb2_grpc as pb_grpc
from fhguard import cache
from fhguard.store import Decision, Policy

CLASSIFY_DEADLINE_S = 0.25
JUDGE_DEADLINE_S = 2.0
BLOCK_THRESHOLD = 0.35
REVIEW_LOW = 0.15
FAIL_CLOSED_REASON = "guard_unavailable"

classifier = pb_grpc.ClassifierStub(grpc.insecure_channel("classifier:9000"))
judge = pb_grpc.JudgeStub(grpc.insecure_channel("judge:9000"))


def stop_phrase(text: str, policy: Policy) -> str | None:
    lowered = text.lower()
    return next((phrase for phrase in policy.stop_phrases if phrase.lower() in lowered), None)


def decide(text: str, policy: Policy) -> Decision:
    phrase = stop_phrase(text, policy)
    if phrase is not None:
        return Decision(False, "stoplist", 1.0, [f"stop_phrase:{phrase}"])
    try:
        reply = classifier.Classify(pb.ClassifyRequest(text=text, policy_version=policy.version), timeout=CLASSIFY_DEADLINE_S)
    except grpc.RpcError:
        return Decision(False, "classifier", 1.0, [FAIL_CLOSED_REASON])
    if reply.score >= BLOCK_THRESHOLD:
        return Decision(False, "classifier", reply.score, [f"classifier:{reply.label}"])
    if reply.score < REVIEW_LOW:
        return Decision(True, "classifier", reply.score, [])
    try:
        verdict = judge.Assess(pb.AssessRequest(text=text, policy_version=policy.version), timeout=JUDGE_DEADLINE_S)
    except grpc.RpcError:
        return Decision(False, "judge", reply.score, [FAIL_CLOSED_REASON])
    if verdict.compliant:
        return Decision(True, "judge", reply.score, [])
    return Decision(False, "judge", reply.score, [f"judge:{verdict.reason}"])


def evaluate(text: str, policy_version: str) -> Decision:
    cached = cache.cached_decision(policy_version, text)
    if cached is not None:
        return cached
    policy = cache.get_policy(policy_version)
    if policy is None:
        return Decision(False, "policy", 1.0, ["unknown_policy_version"])
    decision = decide(text, policy)
    if FAIL_CLOSED_REASON not in decision.reasons:
        cache.cache_decision(policy_version, text, decision)
    return decision
`,
  'fhguard/model.py': `"""The assistant's model (provided): Assistant.Complete at model:9000, under a 10 s deadline."""
import grpc

import fair_housing_guardrail_pb2 as pb
import fair_housing_guardrail_pb2_grpc as pb_grpc

MODEL_DEADLINE_S = 10.0

assistant = pb_grpc.AssistantStub(grpc.insecure_channel("model:9000"))


def complete(question: str, instructions: str = "") -> str:
    """The model's answer; instructions are added to its system prompt. Raises grpc.RpcError."""
    reply = assistant.Complete(pb.CompleteRequest(question=question, instructions=instructions), timeout=MODEL_DEADLINE_S)
    return reply.answer
`,
};

export const supportModulesTs: Record<string, string> = {
  'fhguard/store.ts': `/**
 * fhguard's database (provided), kept in Redis under fhstore:* so a check can read it: API keys
 * (hash fhstore:apikeys, key -> caller), saved policy versions (fhstore:policy:{version}, JSON), the
 * human-review queue (list fhstore:review), the audit trail (hash fhstore:audit, event_id -> event)
 * and the outbox (list fhstore:outbox). Policy and Decision are the records every step passes around.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const API_KEYS = 'fhstore:apikeys';
export const REVIEW = 'fhstore:review';
export const AUDIT = 'fhstore:audit';
export const OUTBOX = 'fhstore:outbox';

/** A policy version (fh-YYYY-MM-DD[.n]) and the phrases its stop list blocks. */
export interface Policy {
  version: string;
  stop_phrases: string[];
}

/** What the tiers decided: allowed or not, the tier that decided, the classifier score, and why. */
export interface Decision {
  allowed: boolean;
  tier: string;
  score: number;
  reasons: string[];
}

export interface ReviewItem {
  conversation_id: string;
  strikes: number;
}

export interface OutboxRow {
  event: Record<string, unknown>;
  reason: string;
}

/** The caller an API key belongs to; null for an empty or unknown key. */
export async function caller(apiKey: string): Promise<string | null> {
  return apiKey ? redis.hget(API_KEYS, apiKey) : null;
}

export async function addApiKey(apiKey: string, name: string): Promise<void> {
  await redis.hset(API_KEYS, apiKey, name);
}

export async function savePolicy(policy: Policy): Promise<void> {
  await redis.set(\`fhstore:policy:\${policy.version}\`, JSON.stringify(policy));
}

export async function loadPolicy(version: string): Promise<Policy | null> {
  const raw = await redis.get(\`fhstore:policy:\${version}\`);
  return raw === null ? null : (JSON.parse(raw) as Policy);
}

/** Hand a conversation to human review. */
export async function enqueueReview(conversationId: string, strikes: number): Promise<void> {
  await redis.rpush(REVIEW, JSON.stringify({conversation_id: conversationId, strikes}));
}

export async function reviewQueue(): Promise<ReviewItem[]> {
  return (await redis.lrange(REVIEW, 0, -1)).map(row => JSON.parse(row) as ReviewItem);
}

/** Append-only, one row per event_id: a redelivered event is not appended twice. True when new. */
export async function appendAudit(event: Record<string, unknown>): Promise<boolean> {
  return (await redis.hsetnx(AUDIT, String(event.event_id), JSON.stringify(event))) === 1;
}

export async function auditRows(): Promise<Record<string, unknown>[]> {
  return (await redis.hvals(AUDIT)).map(row => JSON.parse(row) as Record<string, unknown>);
}

/** Keep an event the broker refused, with the broker's reason, for the relay to produce later. */
export async function insertOutbox(event: Record<string, unknown>, reason: string): Promise<void> {
  await redis.rpush(OUTBOX, JSON.stringify({event, reason}));
}

export async function outboxRows(): Promise<OutboxRow[]> {
  return (await redis.lrange(OUTBOX, 0, -1)).map(row => JSON.parse(row) as OutboxRow);
}
`,
  'fhguard/cache.ts': `/**
 * The policy cache (provided; step 3 builds the same functions). fh:policy:{version} caches a saved
 * policy for an hour; fh:policy:active names the version new conversations pin, and publish moves it
 * in one MULTI/EXEC with the cache entry, after the store has the version. Decisions are cached for
 * a day under fh:decision:{version}:{sha256 of the text}; strikes count per conversation in
 * fh:strikes:{conversation_id} and expire a day after the first.
 */
import {createHash} from 'node:crypto';

import Redis from 'ioredis';

import {type Decision, type Policy, loadPolicy, savePolicy} from 'fhguard/store';

const redis = new Redis({host: 'redis', port: 6379});

export const POLICY_TTL_S = 3600;
export const DECISION_TTL_S = 86_400;
export const STRIKE_TTL_S = 86_400;
export const ACTIVE_KEY = 'fh:policy:active';

export const policyKey = (version: string): string => \`fh:policy:\${version}\`;
export const textHash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
export const decisionKey = (version: string, text: string): string => \`fh:decision:\${version}:\${textHash(text)}\`;
export const strikesKey = (conversationId: string): string => \`fh:strikes:\${conversationId}\`;

export async function getPolicy(version: string): Promise<Policy | null> {
  const raw = await redis.get(policyKey(version));
  if (raw !== null) return JSON.parse(raw) as Policy;
  const policy = await loadPolicy(version);
  if (policy !== null) await redis.set(policyKey(version), JSON.stringify(policy), 'EX', POLICY_TTL_S);
  return policy;
}

export async function activeVersion(): Promise<string | null> {
  return redis.get(ACTIVE_KEY);
}

export async function publish(policy: Policy): Promise<void> {
  await savePolicy(policy);
  await redis.multi().set(policyKey(policy.version), JSON.stringify(policy), 'EX', POLICY_TTL_S).set(ACTIVE_KEY, policy.version).exec();
}

export async function cachedDecision(version: string, text: string): Promise<Decision | null> {
  const raw = await redis.get(decisionKey(version, text));
  return raw === null ? null : (JSON.parse(raw) as Decision);
}

export async function cacheDecision(version: string, text: string, decision: Decision): Promise<void> {
  await redis.set(decisionKey(version, text), JSON.stringify(decision), 'EX', DECISION_TTL_S);
}

export async function recordStrike(conversationId: string): Promise<number> {
  const key = strikesKey(conversationId);
  const strikes = await redis.incr(key);
  if (strikes === 1) await redis.expire(key, STRIKE_TTL_S);
  return strikes;
}
`,
  'fhguard/tiers.ts': `/**
 * The guard tiers (provided; step 2 builds decide). decide runs the policy's stop list, then the
 * classifier under 250 ms, blocks at 0.35, allows below 0.15 and asks the judge (2 s) about the band
 * between; an RPC error at any tier blocks with reason guard_unavailable. evaluate is the guard as
 * the routes call it: the cached decision for (version, text), else decide under that policy version
 * and cache the verdict (a fail-closed decision is not a verdict and is not cached). An unknown
 * policy version blocks.
 */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {cacheDecision, cachedDecision, getPolicy} from 'fhguard/cache';
import type {Decision, Policy} from 'fhguard/store';

export const CLASSIFY_DEADLINE_MS = 250;
export const JUDGE_DEADLINE_MS = 2000;
export const BLOCK_THRESHOLD = 0.35;
export const REVIEW_LOW = 0.15;
export const FAIL_CLOSED_REASON = 'guard_unavailable';

interface TextRequest {
  text: string;
  policy_version: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('fair_housing_guardrail.proto')) as unknown as {
  fairhousing: {Classifier: grpc.ServiceClientConstructor; Judge: grpc.ServiceClientConstructor};
};
const classifier = new pkg.fairhousing.Classifier('classifier:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Classify(request: TextRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{score: number; label: string}>;
};
const judge = new pkg.fairhousing.Judge('judge:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Assess(request: TextRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{compliant: boolean; reason: string}>;
};

export function stopPhrase(text: string, policy: Policy): string | null {
  const lowered = text.toLowerCase();
  return policy.stop_phrases.find(phrase => lowered.includes(phrase.toLowerCase())) ?? null;
}

export async function decide(text: string, policy: Policy): Promise<Decision> {
  const phrase = stopPhrase(text, policy);
  if (phrase !== null) return {allowed: false, tier: 'stoplist', score: 1, reasons: [\`stop_phrase:\${phrase}\`]};
  const request = {text, policy_version: policy.version};
  let reply: {score: number; label: string};
  try {
    reply = await classifier.Classify(request, new grpc.Metadata(), {deadline: Date.now() + CLASSIFY_DEADLINE_MS});
  } catch {
    return {allowed: false, tier: 'classifier', score: 1, reasons: [FAIL_CLOSED_REASON]};
  }
  const score = Number(reply.score);
  if (score >= BLOCK_THRESHOLD) return {allowed: false, tier: 'classifier', score, reasons: [\`classifier:\${reply.label}\`]};
  if (score < REVIEW_LOW) return {allowed: true, tier: 'classifier', score, reasons: []};
  let verdict: {compliant: boolean; reason: string};
  try {
    verdict = await judge.Assess(request, new grpc.Metadata(), {deadline: Date.now() + JUDGE_DEADLINE_MS});
  } catch {
    return {allowed: false, tier: 'judge', score, reasons: [FAIL_CLOSED_REASON]};
  }
  if (verdict.compliant) return {allowed: true, tier: 'judge', score, reasons: []};
  return {allowed: false, tier: 'judge', score, reasons: [\`judge:\${verdict.reason}\`]};
}

export async function evaluate(text: string, policyVersion: string): Promise<Decision> {
  const cached = await cachedDecision(policyVersion, text);
  if (cached !== null) return cached;
  const policy = await getPolicy(policyVersion);
  if (policy === null) return {allowed: false, tier: 'policy', score: 1, reasons: ['unknown_policy_version']};
  const decision = await decide(text, policy);
  if (!decision.reasons.includes(FAIL_CLOSED_REASON)) await cacheDecision(policyVersion, text, decision);
  return decision;
}
`,
  'fhguard/model.ts': `/** The assistant's model (provided): Assistant.Complete at model:9000, under a 10 s deadline. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

export const MODEL_DEADLINE_MS = 10_000;

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('fair_housing_guardrail.proto')) as unknown as {
  fairhousing: {Assistant: grpc.ServiceClientConstructor};
};
const assistant = new pkg.fairhousing.Assistant('model:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Complete(
    request: {question: string; instructions: string},
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
  ): Promise<{answer: string}>;
};

/** The model's answer; instructions are added to its system prompt. Rejects with the gRPC error. */
export async function complete(question: string, instructions = ''): Promise<string> {
  const reply = await assistant.Complete({question, instructions}, new grpc.Metadata(), {deadline: Date.now() + MODEL_DEADLINE_MS});
  return reply.answer;
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'fhguard/store/store.go': `// Package store is fhguard's database (provided), kept in Redis under fhstore:* so a check can
// read it: API keys (hash fhstore:apikeys, key -> caller), saved policy versions
// (fhstore:policy:{version}, JSON), the human-review queue (list fhstore:review), the audit trail
// (hash fhstore:audit, event_id -> event) and the outbox (list fhstore:outbox). Policy and Decision
// are the records every step passes around.
package store

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	APIKeys = "fhstore:apikeys"
	Review  = "fhstore:review"
	Audit   = "fhstore:audit"
	Outbox  = "fhstore:outbox"
)

// Policy is a policy version (fh-YYYY-MM-DD[.n]) and the phrases its stop list blocks.
type Policy struct {
	Version     string   \`json:"version"\`
	StopPhrases []string \`json:"stop_phrases"\`
}

// Decision is what the tiers decided: allowed or not, the tier that decided, the classifier score, and why.
type Decision struct {
	Allowed bool     \`json:"allowed"\`
	Tier    string   \`json:"tier"\`
	Score   float64  \`json:"score"\`
	Reasons []string \`json:"reasons"\`
}

// ReviewItem is one conversation handed to human review.
type ReviewItem struct {
	ConversationID string \`json:"conversation_id"\`
	Strikes        int64  \`json:"strikes"\`
}

// OutboxRow is an event the broker refused and the broker's reason.
type OutboxRow struct {
	Event  map[string]any \`json:"event"\`
	Reason string         \`json:"reason"\`
}

// Caller is the caller an API key belongs to; ok is false for an empty or unknown key.
func Caller(ctx context.Context, apiKey string) (string, bool) {
	if apiKey == "" {
		return "", false
	}
	name, err := rdb.HGet(ctx, APIKeys, apiKey).Result()
	return name, err == nil
}

func AddAPIKey(ctx context.Context, apiKey, name string) {
	rdb.HSet(ctx, APIKeys, apiKey, name)
}

func SavePolicy(ctx context.Context, policy Policy) error {
	raw, _ := json.Marshal(policy)
	return rdb.Set(ctx, fmt.Sprintf("fhstore:policy:%s", policy.Version), raw, 0).Err()
}

// LoadPolicy is the saved policy version; nil when there is none.
func LoadPolicy(ctx context.Context, version string) (*Policy, error) {
	raw, err := rdb.Get(ctx, fmt.Sprintf("fhstore:policy:%s", version)).Result()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var policy Policy
	return &policy, json.Unmarshal([]byte(raw), &policy)
}

// EnqueueReview hands a conversation to human review.
func EnqueueReview(ctx context.Context, conversationID string, strikes int64) error {
	raw, _ := json.Marshal(ReviewItem{ConversationID: conversationID, Strikes: strikes})
	return rdb.RPush(ctx, Review, raw).Err()
}

func ReviewQueue(ctx context.Context) []ReviewItem {
	items := []ReviewItem{}
	for _, row := range rdb.LRange(ctx, Review, 0, -1).Val() {
		var item ReviewItem
		json.Unmarshal([]byte(row), &item)
		items = append(items, item)
	}
	return items
}

// AppendAudit appends one row per event_id: a redelivered event is not appended twice. True when new.
func AppendAudit(ctx context.Context, event map[string]any) (bool, error) {
	raw, _ := json.Marshal(event)
	return rdb.HSetNX(ctx, Audit, fmt.Sprint(event["event_id"]), raw).Result()
}

func AuditRows(ctx context.Context) []map[string]any {
	rows := []map[string]any{}
	for _, raw := range rdb.HVals(ctx, Audit).Val() {
		var row map[string]any
		json.Unmarshal([]byte(raw), &row)
		rows = append(rows, row)
	}
	return rows
}

// InsertOutbox keeps an event the broker refused, with the broker's reason, for the relay to produce later.
func InsertOutbox(ctx context.Context, event map[string]any, reason string) error {
	raw, _ := json.Marshal(OutboxRow{Event: event, Reason: reason})
	return rdb.RPush(ctx, Outbox, raw).Err()
}

func OutboxRows(ctx context.Context) []OutboxRow {
	rows := []OutboxRow{}
	for _, raw := range rdb.LRange(ctx, Outbox, 0, -1).Val() {
		var row OutboxRow
		json.Unmarshal([]byte(raw), &row)
		rows = append(rows, row)
	}
	return rows
}
`,
  'fhguard/cache/cache.go': `// Package cache is the policy cache (provided; step 3 builds the same functions).
// fh:policy:{version} caches a saved policy for an hour; fh:policy:active names the version new
// conversations pin, and Publish moves it in one MULTI/EXEC with the cache entry, after the store
// has the version. Decisions are cached for a day under fh:decision:{version}:{sha256 of the text};
// strikes count per conversation in fh:strikes:{conversation_id} and expire a day after the first.
package cache

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"time"

	"github.com/redis/go-redis/v9"

	"fhguard/store"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	PolicyTTL   = time.Hour
	DecisionTTL = 24 * time.Hour
	StrikeTTL   = 24 * time.Hour
	ActiveKey   = "fh:policy:active"
)

func PolicyKey(version string) string { return "fh:policy:" + version }

func TextHash(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

func DecisionKey(version, text string) string { return "fh:decision:" + version + ":" + TextHash(text) }

func StrikesKey(conversationID string) string { return "fh:strikes:" + conversationID }

// GetPolicy is the policy version, from the cache or else from the store (then cached); nil when unknown.
func GetPolicy(ctx context.Context, version string) (*store.Policy, error) {
	raw, err := rdb.Get(ctx, PolicyKey(version)).Result()
	if err == nil {
		var policy store.Policy
		return &policy, json.Unmarshal([]byte(raw), &policy)
	}
	if err != redis.Nil {
		return nil, err
	}
	policy, err := store.LoadPolicy(ctx, version)
	if err != nil || policy == nil {
		return nil, err
	}
	doc, _ := json.Marshal(policy)
	return policy, rdb.Set(ctx, PolicyKey(version), doc, PolicyTTL).Err()
}

// ActiveVersion is the version new conversations pin; "" when none is published.
func ActiveVersion(ctx context.Context) string {
	return rdb.Get(ctx, ActiveKey).Val()
}

func Publish(ctx context.Context, policy store.Policy) error {
	if err := store.SavePolicy(ctx, policy); err != nil {
		return err
	}
	doc, _ := json.Marshal(policy)
	_, err := rdb.TxPipelined(ctx, func(pipe redis.Pipeliner) error {
		pipe.Set(ctx, PolicyKey(policy.Version), doc, PolicyTTL)
		pipe.Set(ctx, ActiveKey, policy.Version, 0)
		return nil
	})
	return err
}

// CachedDecision is the decision cached for (version, text); nil when there is none.
func CachedDecision(ctx context.Context, version, text string) (*store.Decision, error) {
	raw, err := rdb.Get(ctx, DecisionKey(version, text)).Result()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var decision store.Decision
	return &decision, json.Unmarshal([]byte(raw), &decision)
}

func CacheDecision(ctx context.Context, version, text string, decision store.Decision) error {
	doc, _ := json.Marshal(decision)
	return rdb.Set(ctx, DecisionKey(version, text), doc, DecisionTTL).Err()
}

func RecordStrike(ctx context.Context, conversationID string) (int64, error) {
	key := StrikesKey(conversationID)
	strikes, err := rdb.Incr(ctx, key).Result()
	if err != nil {
		return 0, err
	}
	if strikes == 1 {
		rdb.Expire(ctx, key, StrikeTTL)
	}
	return strikes, nil
}
`,
  'fhguard/tiers/tiers.go': `// Package tiers is the guard tiers (provided; step 2 builds decide). Decide runs the policy's
// stop list, then the classifier under 250 ms, blocks at 0.35, allows below 0.15 and asks the
// judge (2 s) about the band between; an RPC error at any tier blocks with reason
// guard_unavailable. Evaluate is the guard as the routes call it: the cached decision for
// (version, text), else Decide under that policy version and cache the verdict (a fail-closed
// decision is not a verdict and is not cached). An unknown policy version blocks.
package tiers

import (
	"context"
	"strings"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"fhguard/cache"
	pb "fhguard/gen/fair_housing_guardrail"
	"fhguard/store"
)

const (
	ClassifyDeadline = 250 * time.Millisecond
	JudgeDeadline    = 2 * time.Second
	BlockThreshold   = 0.35
	ReviewLow        = 0.15
	FailClosedReason = "guard_unavailable"
)

var (
	classifierConn, _ = grpc.NewClient("classifier:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	judgeConn, _      = grpc.NewClient("judge:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	classifier        = pb.NewClassifierClient(classifierConn)
	judge             = pb.NewJudgeClient(judgeConn)
)

// StopPhrase is the first stop-list phrase the text contains, case-insensitively; "" when none.
func StopPhrase(text string, policy store.Policy) string {
	lowered := strings.ToLower(text)
	for _, phrase := range policy.StopPhrases {
		if strings.Contains(lowered, strings.ToLower(phrase)) {
			return phrase
		}
	}
	return ""
}

func Decide(ctx context.Context, text string, policy store.Policy) store.Decision {
	if phrase := StopPhrase(text, policy); phrase != "" {
		return store.Decision{Allowed: false, Tier: "stoplist", Score: 1, Reasons: []string{"stop_phrase:" + phrase}}
	}
	classifyCtx, cancel := context.WithTimeout(ctx, ClassifyDeadline)
	reply, err := classifier.Classify(classifyCtx, &pb.ClassifyRequest{Text: text, PolicyVersion: policy.Version})
	cancel()
	if err != nil {
		return store.Decision{Allowed: false, Tier: "classifier", Score: 1, Reasons: []string{FailClosedReason}}
	}
	score := reply.GetScore()
	if score >= BlockThreshold {
		return store.Decision{Allowed: false, Tier: "classifier", Score: score, Reasons: []string{"classifier:" + reply.GetLabel()}}
	}
	if score < ReviewLow {
		return store.Decision{Allowed: true, Tier: "classifier", Score: score, Reasons: []string{}}
	}
	judgeCtx, cancelJudge := context.WithTimeout(ctx, JudgeDeadline)
	verdict, err := judge.Assess(judgeCtx, &pb.AssessRequest{Text: text, PolicyVersion: policy.Version})
	cancelJudge()
	if err != nil {
		return store.Decision{Allowed: false, Tier: "judge", Score: score, Reasons: []string{FailClosedReason}}
	}
	if verdict.GetCompliant() {
		return store.Decision{Allowed: true, Tier: "judge", Score: score, Reasons: []string{}}
	}
	return store.Decision{Allowed: false, Tier: "judge", Score: score, Reasons: []string{"judge:" + verdict.GetReason()}}
}

func Evaluate(ctx context.Context, text, policyVersion string) store.Decision {
	if cached, err := cache.CachedDecision(ctx, policyVersion, text); err == nil && cached != nil {
		return *cached
	}
	policy, err := cache.GetPolicy(ctx, policyVersion)
	if err != nil {
		return store.Decision{Allowed: false, Tier: "policy", Score: 1, Reasons: []string{FailClosedReason}}
	}
	if policy == nil {
		return store.Decision{Allowed: false, Tier: "policy", Score: 1, Reasons: []string{"unknown_policy_version"}}
	}
	decision := Decide(ctx, text, *policy)
	for _, reason := range decision.Reasons {
		if reason == FailClosedReason {
			return decision
		}
	}
	cache.CacheDecision(ctx, policyVersion, text, decision)
	return decision
}
`,
  'fhguard/model/model.go': `// Package model is the assistant's model (provided): Assistant.Complete at model:9000, under a
// 10 s deadline.
package model

import (
	"context"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "fhguard/gen/fair_housing_guardrail"
)

const Deadline = 10 * time.Second

var (
	conn, _   = grpc.NewClient("model:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	assistant = pb.NewAssistantClient(conn)
)

// Complete is the model's answer; instructions are added to its system prompt.
func Complete(ctx context.Context, question, instructions string) (string, error) {
	callCtx, cancel := context.WithTimeout(ctx, Deadline)
	defer cancel()
	reply, err := assistant.Complete(callCtx, &pb.CompleteRequest{Question: question, Instructions: instructions})
	if err != nil {
		return "", err
	}
	return reply.GetAnswer(), nil
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'digest.h': CPP_DIGEST_H,
  'ids.h': CPP_IDS_H,
  'fhguard/store.h': `// fhguard's database (provided), kept in Redis under fhstore:* so a check can read it: API keys
// (hash fhstore:apikeys, key -> caller), saved policy versions (fhstore:policy:{version}, JSON),
// the human-review queue (list fhstore:review), the audit trail (hash fhstore:audit, event_id ->
// event) and the outbox (list fhstore:outbox). Policy and Decision are the records every step
// passes around.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <iterator>
#include <optional>
#include <string>
#include <vector>

namespace store {

// A policy version (fh-YYYY-MM-DD[.n]) and the phrases its stop list blocks.
struct Policy {
  std::string version;
  std::vector<std::string> stop_phrases;
};

// What the tiers decided: allowed or not, the tier that decided, the classifier score, and why.
struct Decision {
  bool allowed = false;
  std::string tier;
  double score = 0;
  std::vector<std::string> reasons;
};

inline void to_json(nlohmann::json& j, const Policy& p) { j = {{"version", p.version}, {"stop_phrases", p.stop_phrases}}; }
inline void from_json(const nlohmann::json& j, Policy& p) {
  p.version = j.value("version", "");
  p.stop_phrases = j.value("stop_phrases", std::vector<std::string>{});
}
inline void to_json(nlohmann::json& j, const Decision& d) {
  j = {{"allowed", d.allowed}, {"tier", d.tier}, {"score", d.score}, {"reasons", d.reasons}};
}
inline void from_json(const nlohmann::json& j, Decision& d) {
  d.allowed = j.value("allowed", false);
  d.tier = j.value("tier", "");
  d.score = j.value("score", 0.0);
  d.reasons = j.value("reasons", std::vector<std::string>{});
}

inline const std::string kApiKeys = "fhstore:apikeys";
inline const std::string kReview = "fhstore:review";
inline const std::string kAudit = "fhstore:audit";
inline const std::string kOutbox = "fhstore:outbox";

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// The caller an API key belongs to; nothing for an empty or unknown key.
inline std::optional<std::string> caller(const std::string& api_key) {
  if (api_key.empty()) return std::nullopt;
  const auto name = redis().hget(kApiKeys, api_key);
  if (!name) return std::nullopt;
  return *name;
}

inline void addApiKey(const std::string& api_key, const std::string& name) { redis().hset(kApiKeys, api_key, name); }

inline void savePolicy(const Policy& policy) { redis().set("fhstore:policy:" + policy.version, nlohmann::json(policy).dump()); }

inline std::optional<Policy> loadPolicy(const std::string& version) {
  const auto raw = redis().get("fhstore:policy:" + version);
  if (!raw) return std::nullopt;
  return nlohmann::json::parse(*raw).get<Policy>();
}

// Hand a conversation to human review.
inline void enqueueReview(const std::string& conversation_id, long long strikes) {
  redis().rpush(kReview, nlohmann::json{{"conversation_id", conversation_id}, {"strikes", strikes}}.dump());
}

inline std::vector<nlohmann::json> rowsOf(const std::vector<std::string>& raw) {
  std::vector<nlohmann::json> rows;
  for (const auto& r : raw) rows.push_back(nlohmann::json::parse(r));
  return rows;
}

inline std::vector<nlohmann::json> reviewQueue() {
  std::vector<std::string> raw;
  redis().lrange(kReview, 0, -1, std::back_inserter(raw));
  return rowsOf(raw);
}

// Append-only, one row per event_id: a redelivered event is not appended twice. True when new.
inline bool appendAudit(const nlohmann::json& event) {
  return redis().hsetnx(kAudit, event.value("event_id", ""), event.dump());
}

inline std::vector<nlohmann::json> auditRows() {
  std::vector<std::string> raw;
  redis().hvals(kAudit, std::back_inserter(raw));
  return rowsOf(raw);
}

// Keep an event the broker refused, with the broker's reason, for the relay to produce later.
inline void insertOutbox(const nlohmann::json& event, const std::string& reason) {
  redis().rpush(kOutbox, nlohmann::json{{"event", event}, {"reason", reason}}.dump());
}

inline std::vector<nlohmann::json> outboxRows() {
  std::vector<std::string> raw;
  redis().lrange(kOutbox, 0, -1, std::back_inserter(raw));
  return rowsOf(raw);
}

}  // namespace store
`,
  'fhguard/cache.h': `// The policy cache (provided; step 3 builds the same functions). fh:policy:{version} caches a
// saved policy for an hour; fh:policy:active names the version new conversations pin, and publish
// moves it in one MULTI/EXEC with the cache entry, after the store has the version. Decisions are
// cached for a day under fh:decision:{version}:{sha256 of the text}; strikes count per
// conversation in fh:strikes:{conversation_id} and expire a day after the first.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <optional>
#include <string>

#include "digest.h"
#include "fhguard/store.h"

namespace cache {

constexpr std::chrono::seconds kPolicyTtl{3600};
constexpr std::chrono::seconds kDecisionTtl{86400};
constexpr std::chrono::seconds kStrikeTtl{86400};
inline const std::string kActiveKey = "fh:policy:active";

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string policyKey(const std::string& version) { return "fh:policy:" + version; }
inline std::string textHash(const std::string& text) { return sha256_hex(text); }
inline std::string decisionKey(const std::string& version, const std::string& text) {
  return "fh:decision:" + version + ":" + textHash(text);
}
inline std::string strikesKey(const std::string& conversation_id) { return "fh:strikes:" + conversation_id; }

inline std::optional<store::Policy> getPolicy(const std::string& version) {
  if (const auto raw = redis().get(policyKey(version))) return nlohmann::json::parse(*raw).get<store::Policy>();
  const auto policy = store::loadPolicy(version);
  if (policy) redis().set(policyKey(version), nlohmann::json(*policy).dump(), kPolicyTtl);
  return policy;
}

inline std::optional<std::string> activeVersion() {
  const auto version = redis().get(kActiveKey);
  if (!version) return std::nullopt;
  return *version;
}

inline void publish(const store::Policy& policy) {
  store::savePolicy(policy);
  auto tx = redis().transaction();
  tx.set(policyKey(policy.version), nlohmann::json(policy).dump(), kPolicyTtl).set(kActiveKey, policy.version);
  tx.exec();
}

inline std::optional<store::Decision> cachedDecision(const std::string& version, const std::string& text) {
  const auto raw = redis().get(decisionKey(version, text));
  if (!raw) return std::nullopt;
  return nlohmann::json::parse(*raw).get<store::Decision>();
}

inline void cacheDecision(const std::string& version, const std::string& text, const store::Decision& decision) {
  redis().set(decisionKey(version, text), nlohmann::json(decision).dump(), kDecisionTtl);
}

inline long long recordStrike(const std::string& conversation_id) {
  const std::string key = strikesKey(conversation_id);
  const long long strikes = redis().incr(key);
  if (strikes == 1) redis().expire(key, kStrikeTtl);
  return strikes;
}

}  // namespace cache
`,
  'fhguard/tiers.h': `// The guard tiers (provided; step 2 builds decide). decide runs the policy's stop list, then the
// classifier under 250 ms, blocks at 0.35, allows below 0.15 and asks the judge (2 s) about the
// band between; an RPC error at any tier blocks with reason guard_unavailable. evaluate is the
// guard as the routes call it: the cached decision for (version, text), else decide under that
// policy version and cache the verdict (a fail-closed decision is not a verdict and is not
// cached). An unknown policy version blocks.
#pragma once

#include <grpcpp/grpcpp.h>

#include <algorithm>
#include <cctype>
#include <chrono>
#include <string>

#include "fair_housing_guardrail.grpc.pb.h"
#include "fhguard/cache.h"
#include "fhguard/store.h"

namespace tiers {

constexpr std::chrono::milliseconds kClassifyDeadline{250};
constexpr std::chrono::milliseconds kJudgeDeadline{2000};
constexpr double kBlockThreshold = 0.35;
constexpr double kReviewLow = 0.15;
inline const std::string kFailClosedReason = "guard_unavailable";

inline fairhousing::Classifier::Stub& classifier() {
  static auto stub = fairhousing::Classifier::NewStub(grpc::CreateChannel("classifier:9000", grpc::InsecureChannelCredentials()));
  return *stub;
}

inline fairhousing::Judge::Stub& judge() {
  static auto stub = fairhousing::Judge::NewStub(grpc::CreateChannel("judge:9000", grpc::InsecureChannelCredentials()));
  return *stub;
}

inline std::string lowered(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return s;
}

// The first stop-list phrase the text contains, case-insensitively; "" when none.
inline std::string stopPhrase(const std::string& text, const store::Policy& policy) {
  const std::string haystack = lowered(text);
  for (const auto& phrase : policy.stop_phrases) {
    if (haystack.find(lowered(phrase)) != std::string::npos) return phrase;
  }
  return "";
}

inline store::Decision decide(const std::string& text, const store::Policy& policy) {
  const std::string phrase = stopPhrase(text, policy);
  if (!phrase.empty()) return {false, "stoplist", 1.0, {"stop_phrase:" + phrase}};
  fairhousing::ClassifyRequest request;
  request.set_text(text);
  request.set_policy_version(policy.version);
  fairhousing::ClassifyReply reply;
  grpc::ClientContext classify;
  classify.set_deadline(std::chrono::system_clock::now() + kClassifyDeadline);
  if (!classifier().Classify(&classify, request, &reply).ok()) return {false, "classifier", 1.0, {kFailClosedReason}};
  const double score = reply.score();
  if (score >= kBlockThreshold) return {false, "classifier", score, {"classifier:" + reply.label()}};
  if (score < kReviewLow) return {true, "classifier", score, {}};
  fairhousing::AssessRequest ask;
  ask.set_text(text);
  ask.set_policy_version(policy.version);
  fairhousing::Assessment verdict;
  grpc::ClientContext assess;
  assess.set_deadline(std::chrono::system_clock::now() + kJudgeDeadline);
  if (!judge().Assess(&assess, ask, &verdict).ok()) return {false, "judge", score, {kFailClosedReason}};
  if (verdict.compliant()) return {true, "judge", score, {}};
  return {false, "judge", score, {"judge:" + verdict.reason()}};
}

inline store::Decision evaluate(const std::string& text, const std::string& policy_version) {
  if (const auto cached = cache::cachedDecision(policy_version, text)) return *cached;
  const auto policy = cache::getPolicy(policy_version);
  if (!policy) return {false, "policy", 1.0, {"unknown_policy_version"}};
  const store::Decision decision = decide(text, *policy);
  if (std::find(decision.reasons.begin(), decision.reasons.end(), kFailClosedReason) == decision.reasons.end()) {
    cache::cacheDecision(policy_version, text, decision);
  }
  return decision;
}

}  // namespace tiers
`,
  'fhguard/model.h': `// The assistant's model (provided): Assistant.Complete at model:9000, under a 10 s deadline.
#pragma once

#include <grpcpp/grpcpp.h>

#include <chrono>
#include <stdexcept>
#include <string>

#include "fair_housing_guardrail.grpc.pb.h"

namespace model {

constexpr std::chrono::seconds kDeadline{10};

inline fairhousing::Assistant::Stub& assistant() {
  static auto stub = fairhousing::Assistant::NewStub(grpc::CreateChannel("model:9000", grpc::InsecureChannelCredentials()));
  return *stub;
}

// The model's answer; instructions are added to its system prompt. Throws std::runtime_error.
inline std::string complete(const std::string& question, const std::string& instructions = "") {
  fairhousing::CompleteRequest request;
  request.set_question(question);
  request.set_instructions(instructions);
  fairhousing::CompleteReply reply;
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
  const grpc::Status status = assistant().Complete(&ctx, request, &reply);
  if (!status.ok()) throw std::runtime_error("model: " + status.error_message());
  return reply.answer();
}

}  // namespace model
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('fhguard', 'Store')]: `package fhguard

import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

/**
 * fhguard's database (provided), kept in Redis under fhstore:* so a check can read it: API keys
 * (hash fhstore:apikeys, key -> caller), saved policy versions (fhstore:policy:{version}, JSON), the
 * human-review queue (list fhstore:review), the audit trail (hash fhstore:audit, event_id -> event)
 * and the outbox (list fhstore:outbox). Policy and Decision are the records every step passes around.
 */
object Store {

  /** A policy version (fh-YYYY-MM-DD[.n]) and the phrases its stop list blocks. */
  final case class Policy(version: String, stopPhrases: Seq[String])

  /** What the tiers decided: allowed or not, the tier that decided, the classifier score, and why. */
  final case class Decision(allowed: Boolean, tier: String, score: Double, reasons: Seq[String])

  val jedis = new JedisPooled("redis", 6379)

  val ApiKeys = "fhstore:apikeys"
  val Review = "fhstore:review"
  val Audit = "fhstore:audit"
  val Outbox = "fhstore:outbox"

  def policyJson(p: Policy): JsObject =
    JsObject("version" -> JsString(p.version), "stop_phrases" -> JsArray(p.stopPhrases.map(JsString(_)).toVector))

  def policyFrom(js: JsValue): Policy = {
    val f = js.asJsObject.fields
    Policy(f("version").convertTo[String](DefaultJsonProtocol.StringJsonFormat), f("stop_phrases") match {
      case JsArray(items) => items.collect { case JsString(s) => s }
      case _              => Seq.empty
    })
  }

  def decisionJson(d: Decision): JsObject = JsObject(
    "allowed" -> JsBoolean(d.allowed),
    "tier" -> JsString(d.tier),
    "score" -> JsNumber(d.score),
    "reasons" -> JsArray(d.reasons.map(JsString(_)).toVector),
  )

  def decisionFrom(js: JsValue): Decision = {
    val f = js.asJsObject.fields
    Decision(
      f.get("allowed").contains(JsTrue),
      f.get("tier").collect { case JsString(s) => s }.getOrElse(""),
      f.get("score").collect { case JsNumber(n) => n.toDouble }.getOrElse(0.0),
      f.get("reasons").collect { case JsArray(items) => items.collect { case JsString(s) => s } }.getOrElse(Seq.empty),
    )
  }

  /** The caller an API key belongs to; None for an empty or unknown key. */
  def caller(apiKey: String): Option[String] =
    if (apiKey.isEmpty) None else Option(jedis.hget(ApiKeys, apiKey))

  def addApiKey(apiKey: String, name: String): Unit = jedis.hset(ApiKeys, apiKey, name)

  def savePolicy(policy: Policy): Unit = jedis.set(s"fhstore:policy:\${policy.version}", policyJson(policy).compactPrint)

  def loadPolicy(version: String): Option[Policy] =
    Option(jedis.get(s"fhstore:policy:$version")).map(raw => policyFrom(raw.parseJson))

  /** Hand a conversation to human review. */
  def enqueueReview(conversationId: String, strikes: Long): Unit =
    jedis.rpush(Review, JsObject("conversation_id" -> JsString(conversationId), "strikes" -> JsNumber(strikes)).compactPrint)

  def reviewQueue(): Seq[JsObject] = jedis.lrange(Review, 0, -1).asScala.toSeq.map(_.parseJson.asJsObject)

  /** Append-only, one row per event_id: a redelivered event is not appended twice. True when new. */
  def appendAudit(event: JsObject): Boolean = {
    val id = event.fields.get("event_id").collect { case JsString(s) => s }.getOrElse("")
    jedis.hsetnx(Audit, id, event.compactPrint) == 1L
  }

  def auditRows(): Seq[JsObject] = jedis.hvals(Audit).asScala.toSeq.map(_.parseJson.asJsObject)

  /** Keep an event the broker refused, with the broker's reason, for the relay to produce later. */
  def insertOutbox(event: JsObject, reason: String): Unit =
    jedis.rpush(Outbox, JsObject("event" -> event, "reason" -> JsString(reason)).compactPrint)

  def outboxRows(): Seq[JsObject] = jedis.lrange(Outbox, 0, -1).asScala.toSeq.map(_.parseJson.asJsObject)
}
`,
  [scalaPath('fhguard', 'Cache')]: `package fhguard

import java.nio.charset.StandardCharsets
import java.security.MessageDigest

import spray.json._

/**
 * The policy cache (provided; step 3 builds the same functions). fh:policy:{version} caches a saved
 * policy for an hour; fh:policy:active names the version new conversations pin, and publish moves it
 * in one MULTI/EXEC with the cache entry, after the store has the version. Decisions are cached for
 * a day under fh:decision:{version}:{sha256 of the text}; strikes count per conversation in
 * fh:strikes:{conversation_id} and expire a day after the first.
 */
object Cache {
  private val jedis = Store.jedis

  val PolicyTtlSeconds = 3600L
  val DecisionTtlSeconds = 86400L
  val StrikeTtlSeconds = 86400L
  val ActiveKey = "fh:policy:active"

  def policyKey(version: String): String = s"fh:policy:$version"

  def textHash(text: String): String =
    MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)).map("%02x".format(_)).mkString

  def decisionKey(version: String, text: String): String = s"fh:decision:$version:\${textHash(text)}"

  def strikesKey(conversationId: String): String = s"fh:strikes:$conversationId"

  def getPolicy(version: String): Option[Store.Policy] =
    Option(jedis.get(policyKey(version))).map(raw => Store.policyFrom(raw.parseJson)).orElse {
      val policy = Store.loadPolicy(version)
      policy.foreach(p => jedis.setex(policyKey(version), PolicyTtlSeconds, Store.policyJson(p).compactPrint))
      policy
    }

  def activeVersion(): Option[String] = Option(jedis.get(ActiveKey))

  def publish(policy: Store.Policy): Unit = {
    Store.savePolicy(policy)
    val tx = jedis.multi()
    tx.setex(policyKey(policy.version), PolicyTtlSeconds, Store.policyJson(policy).compactPrint)
    tx.set(ActiveKey, policy.version)
    tx.exec()
  }

  def cachedDecision(version: String, text: String): Option[Store.Decision] =
    Option(jedis.get(decisionKey(version, text))).map(raw => Store.decisionFrom(raw.parseJson))

  def cacheDecision(version: String, text: String, decision: Store.Decision): Unit =
    jedis.setex(decisionKey(version, text), DecisionTtlSeconds, Store.decisionJson(decision).compactPrint)

  def recordStrike(conversationId: String): Long = {
    val key = strikesKey(conversationId)
    val strikes = jedis.incr(key)
    if (strikes == 1L) jedis.expire(key, StrikeTtlSeconds)
    strikes
  }
}
`,
  [scalaPath('fhguard', 'Tiers')]: `package fhguard

import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import fairhousing.fair_housing_guardrail.{AssessRequest, ClassifierGrpc, ClassifyRequest, JudgeGrpc}

/**
 * The guard tiers (provided; step 2 builds decide). decide runs the policy's stop list, then the
 * classifier under 250 ms, blocks at 0.35, allows below 0.15 and asks the judge (2 s) about the band
 * between; an RPC error at any tier blocks with reason guard_unavailable. evaluate is the guard as
 * the routes call it: the cached decision for (version, text), else decide under that policy version
 * and cache the verdict (a fail-closed decision is not a verdict and is not cached). An unknown
 * policy version blocks.
 */
object Tiers {
  val ClassifyDeadlineMs = 250L
  val JudgeDeadlineMs = 2000L
  val BlockThreshold = 0.35
  val ReviewLow = 0.15
  val FailClosedReason = "guard_unavailable"

  private val classifier = ClassifierGrpc.blockingStub(ManagedChannelBuilder.forAddress("classifier", 9000).usePlaintext().build())
  private val judge = JudgeGrpc.blockingStub(ManagedChannelBuilder.forAddress("judge", 9000).usePlaintext().build())

  def stopPhrase(text: String, policy: Store.Policy): Option[String] = {
    val lowered = text.toLowerCase
    policy.stopPhrases.find(phrase => lowered.contains(phrase.toLowerCase))
  }

  def decide(text: String, policy: Store.Policy): Store.Decision = stopPhrase(text, policy) match {
    case Some(phrase) => Store.Decision(allowed = false, "stoplist", 1.0, Seq(s"stop_phrase:$phrase"))
    case None =>
      try {
        val reply = classifier.withDeadlineAfter(ClassifyDeadlineMs, TimeUnit.MILLISECONDS).classify(ClassifyRequest(text = text, policyVersion = policy.version))
        if (reply.score >= BlockThreshold) Store.Decision(allowed = false, "classifier", reply.score, Seq(s"classifier:\${reply.label}"))
        else if (reply.score < ReviewLow) Store.Decision(allowed = true, "classifier", reply.score, Seq.empty)
        else
          try {
            val verdict = judge.withDeadlineAfter(JudgeDeadlineMs, TimeUnit.MILLISECONDS).assess(AssessRequest(text = text, policyVersion = policy.version))
            if (verdict.compliant) Store.Decision(allowed = true, "judge", reply.score, Seq.empty)
            else Store.Decision(allowed = false, "judge", reply.score, Seq(s"judge:\${verdict.reason}"))
          } catch {
            case _: StatusRuntimeException => Store.Decision(allowed = false, "judge", reply.score, Seq(FailClosedReason))
          }
      } catch {
        case _: StatusRuntimeException => Store.Decision(allowed = false, "classifier", 1.0, Seq(FailClosedReason))
      }
  }

  def evaluate(text: String, policyVersion: String): Store.Decision =
    Cache.cachedDecision(policyVersion, text).getOrElse {
      Cache.getPolicy(policyVersion) match {
        case None => Store.Decision(allowed = false, "policy", 1.0, Seq("unknown_policy_version"))
        case Some(policy) =>
          val decision = decide(text, policy)
          if (!decision.reasons.contains(FailClosedReason)) Cache.cacheDecision(policyVersion, text, decision)
          decision
      }
    }
}
`,
  [scalaPath('fhguard', 'Model')]: `package fhguard

import java.util.concurrent.TimeUnit

import io.grpc.ManagedChannelBuilder

import fairhousing.fair_housing_guardrail.{AssistantGrpc, CompleteRequest}

/** The assistant's model (provided): Assistant.Complete at model:9000, under a 10 s deadline. */
object Model {
  val DeadlineSeconds = 10L

  private val assistant = AssistantGrpc.blockingStub(ManagedChannelBuilder.forAddress("model", 9000).usePlaintext().build())

  /** The model's answer; instructions are added to its system prompt. Throws StatusRuntimeException. */
  def complete(question: String, instructions: String = ""): String =
    assistant.withDeadlineAfter(DeadlineSeconds, TimeUnit.SECONDS).complete(CompleteRequest(question = question, instructions = instructions)).answer
}
`,
};
