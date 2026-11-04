/**
 * Hand-written support modules the fraud-scoring steps import but no step builds: the `fraud`
 * package. `features` is the feature contract (server-derived vectors at a pinned version, their
 * digest, the score bands and the rules engine); `store` the scorer's records (accounts, decisions,
 * review cases and the PAN audit log, in Redis as the course's stand-in for its database); `model`
 * the model client of step 3 as the endpoint and the velocity step use it; and `risk_model` the
 * deterministic stand-in the checks serve over gRPC in place of the fraud model. The five languages
 * keep the same keys, so a harness reads one layout whatever the stack.
 */
import {CPP_DIGEST_H} from '../cpp-support';
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'fraud/__init__.py': '',
  'fraud/features.py': `"""
The feature contract every step agrees on (provided). derive_features(account, amount_cents) is the
server's own view of a transaction at FEATURE_VERSION: the account's age and chargeback history from
the account store, and the amount. feature_digest(features) is the SHA-256 of the canonical JSON
(sorted keys, no spaces), so an event can name a vector without carrying it. band_for maps a score to
approve (<= APPROVE_MAX), review (<= REVIEW_MAX) or decline. rules_score is the rules engine, counted
in hundredths so every language agrees: 10, plus 30 per prior chargeback, plus 20 under 30 days of
account age, plus 20 from 1000.00 up, capped at 100.
"""
import hashlib
import json

FEATURE_VERSION = "fx-3"
RULES_VERSION = "rules-7"
APPROVE_MAX = 0.30
REVIEW_MAX = 0.70


def derive_features(account: dict, amount_cents: int) -> dict:
    return {
        "feature_version": FEATURE_VERSION,
        "account_age_days": int(account["age_days"]),
        "prior_chargebacks": int(account["chargebacks"]),
        "amount_cents": int(amount_cents),
    }


def feature_digest(features: dict) -> str:
    canonical = json.dumps(features, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def band_for(score: float) -> str:
    if score <= APPROVE_MAX:
        return "approve"
    if score <= REVIEW_MAX:
        return "review"
    return "decline"


def rules_score(features: dict) -> float:
    points = 10 + 30 * int(features["prior_chargebacks"])
    if int(features["account_age_days"]) < 30:
        points += 20
    if int(features["amount_cents"]) >= 100_000:
        points += 20
    return min(points, 100) / 100
`,
  'fraud/store.py': `"""
The scorer's records (provided), in Redis as the course's stand-in for its database:
account:{ref} a hash (account_ref, tenant, age_days, chargebacks); decision:{transaction_id} the
stored decision as JSON; case:{case_id} a hash (case_id, tenant, transaction_id, account_ref, score,
band, signals as a JSON array, card_attempts, device_accounts, pan); audit:pan the audited PAN
reads, oldest first, each JSON {actor, scope, case_id}.
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def get_account(account_ref: str) -> dict | None:
    """The account, or None when the scorer has never seen it."""
    raw = r.hgetall(f"account:{account_ref}")
    if not raw:
        return None
    return {"account_ref": raw["account_ref"], "tenant": raw["tenant"], "age_days": int(raw["age_days"]), "chargebacks": int(raw["chargebacks"])}


def put_account(record: dict) -> None:
    r.hset(f"account:{record['account_ref']}", mapping={name: str(record[name]) for name in ("account_ref", "tenant", "age_days", "chargebacks")})


def get_decision(transaction_id: str) -> dict | None:
    """The decision stored for the transaction, or None."""
    raw = r.get(f"decision:{transaction_id}")
    return json.loads(raw) if raw else None


def save_decision(record: dict) -> None:
    """Store the decision under its transaction_id."""
    r.set(f"decision:{record['transaction_id']}", json.dumps(record))


def load_case(case_id: str) -> dict | None:
    """The back-office read: any tenant's case by id, or None."""
    raw = r.hgetall(f"case:{case_id}")
    if not raw:
        return None
    return {
        "case_id": raw["case_id"],
        "tenant": raw["tenant"],
        "transaction_id": raw["transaction_id"],
        "account_ref": raw["account_ref"],
        "score": float(raw["score"]),
        "band": raw["band"],
        "signals": json.loads(raw["signals"]),
        "card_attempts": int(raw["card_attempts"]),
        "device_accounts": int(raw["device_accounts"]),
        "pan": raw["pan"],
    }


def case_of(tenant: str, case_id: str) -> dict | None:
    """The case when it belongs to tenant, else None (a foreign case and a missing one look the same)."""
    case = load_case(case_id)
    return case if case is not None and case["tenant"] == tenant else None


def put_case(record: dict) -> None:
    mapping = {name: str(record[name]) for name in ("case_id", "tenant", "transaction_id", "account_ref", "score", "band", "card_attempts", "device_accounts", "pan")}
    mapping["signals"] = json.dumps(list(record["signals"]))
    r.hset(f"case:{record['case_id']}", mapping=mapping)


def audit(actor: str, scope: str, case_id: str) -> None:
    """Append one audited PAN read."""
    r.rpush("audit:pan", json.dumps({"actor": actor, "scope": scope, "case_id": case_id}))


def audit_log() -> list[dict]:
    return [json.loads(entry) for entry in r.lrange("audit:pan", 0, -1)]
`,
  'fraud/model.py': `"""
The model client (provided; step 3 builds the same function). score_transaction(features) calls
Model.Score at MODEL_TARGET with a DEADLINE_S (300 ms) deadline per attempt and at most MAX_ATTEMPTS
(3) attempts; only UNAVAILABLE and DEADLINE_EXCEEDED are retried, and INVALID_ARGUMENT raises
InvalidFeatures. When the attempts run out, or the model answers another error, it answers the rules
verdict: rules_score raised to at least RULES_MIN_SCORE, so a degraded decision is never an approval,
marked fallback with model_version RULES_VERSION. A verdict is {score, band, fallback, model_version}.
"""
import grpc

import fraud_scoring_pb2
import fraud_scoring_pb2_grpc
from fraud.features import RULES_VERSION, band_for, rules_score

MODEL_TARGET = "fraud-model:9000"
DEADLINE_S = 0.3
MAX_ATTEMPTS = 3
RETRYABLE = (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED)
RULES_MIN_SCORE = 0.45

stub = fraud_scoring_pb2_grpc.ModelStub(grpc.insecure_channel(MODEL_TARGET))


class InvalidFeatures(Exception):
    """The model refused the vector (INVALID_ARGUMENT): every attempt would be refused the same way."""


def rules_verdict(features: dict) -> dict:
    score = max(rules_score(features), RULES_MIN_SCORE)
    return {"score": score, "band": band_for(score), "fallback": True, "model_version": RULES_VERSION}


def score_transaction(features: dict) -> dict:
    request = fraud_scoring_pb2.ScoreRequest(**features)
    for _ in range(MAX_ATTEMPTS):
        try:
            reply = stub.Score(request, timeout=DEADLINE_S)
        except grpc.RpcError as exc:
            if exc.code() == grpc.StatusCode.INVALID_ARGUMENT:
                raise InvalidFeatures(exc.details()) from exc
            if exc.code() in RETRYABLE:
                continue
            break
        return {"score": reply.score, "band": band_for(reply.score), "fallback": False, "model_version": reply.model_version}
    return rules_verdict(features)
`,
  'fraud/risk_model.py': `"""
The stand-in for the fraud model. The checks serve ModelPeer over gRPC (Model.Score at
fraud.model.MODEL_TARGET); the scorer never calls it directly. Deterministic, in hundredths: 5, plus
40 per prior chargeback, plus 15 under 30 days of account age, plus 10 from 1000.00 up, capped at 99.
A vector at any feature_version but FEATURE_VERSION is refused with INVALID_ARGUMENT.
"""
import grpc

import fraud_scoring_pb2
import fraud_scoring_pb2_grpc
from fraud.features import FEATURE_VERSION

MODEL_VERSION = "fm-2026-11"


def model_score(account_age_days: int, prior_chargebacks: int, amount_cents: int) -> float:
    points = 5 + 40 * prior_chargebacks
    if account_age_days < 30:
        points += 15
    if amount_cents >= 100_000:
        points += 10
    return min(points, 99) / 100


class ModelPeer(fraud_scoring_pb2_grpc.ModelServicer):
    def Score(self, request, context):
        if request.feature_version != FEATURE_VERSION:
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, f"feature_version {request.feature_version!r} is not {FEATURE_VERSION}")
        score = model_score(request.account_age_days, request.prior_chargebacks, request.amount_cents)
        return fraud_scoring_pb2.ScoreReply(score=score, model_version=MODEL_VERSION)
`,
};

export const supportModulesTs: Record<string, string> = {
  'fraud/features.ts': `/**
 * The feature contract every step agrees on (provided). deriveFeatures(account, amountCents) is the
 * server's own view of a transaction at FEATURE_VERSION: the account's age and chargeback history
 * from the account store, and the amount. featureDigest(features) is the SHA-256 of the canonical
 * JSON (sorted keys, no spaces), so an event can name a vector without carrying it. bandFor maps a
 * score to approve (<= APPROVE_MAX), review (<= REVIEW_MAX) or decline. rulesScore is the rules
 * engine, counted in hundredths so every language agrees: 10, plus 30 per prior chargeback, plus 20
 * under 30 days of account age, plus 20 from 1000.00 up, capped at 100.
 */
import {createHash} from 'node:crypto';

import type {Account} from 'fraud/store';

export const FEATURE_VERSION = 'fx-3';
export const RULES_VERSION = 'rules-7';
export const APPROVE_MAX = 0.3;
export const REVIEW_MAX = 0.7;

export interface Features {
  feature_version: string;
  account_age_days: number;
  prior_chargebacks: number;
  amount_cents: number;
}

export function deriveFeatures(account: Account, amountCents: number): Features {
  return {
    feature_version: FEATURE_VERSION,
    account_age_days: account.age_days,
    prior_chargebacks: account.chargebacks,
    amount_cents: amountCents,
  };
}

export function featureDigest(features: Features): string {
  const entries = Object.entries(features).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(Object.fromEntries(entries)), 'utf8').digest('hex');
}

export function bandFor(score: number): string {
  if (score <= APPROVE_MAX) return 'approve';
  if (score <= REVIEW_MAX) return 'review';
  return 'decline';
}

export function rulesScore(features: Features): number {
  let points = 10 + 30 * features.prior_chargebacks;
  if (features.account_age_days < 30) points += 20;
  if (features.amount_cents >= 100_000) points += 20;
  return Math.min(points, 100) / 100;
}
`,
  'fraud/store.ts': `/**
 * The scorer's records (provided), in Redis as the course's stand-in for its database:
 * account:{ref} a hash (account_ref, tenant, age_days, chargebacks); decision:{transaction_id} the
 * stored decision as JSON; case:{case_id} a hash (case_id, tenant, transaction_id, account_ref,
 * score, band, signals as a JSON array, card_attempts, device_accounts, pan); audit:pan the audited
 * PAN reads, oldest first, each JSON {actor, scope, case_id}.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export interface Account {
  account_ref: string;
  tenant: string;
  age_days: number;
  chargebacks: number;
}

export interface Decision {
  transaction_id: string;
  account_ref: string;
  score: number;
  band: string;
  fallback: boolean;
  model_version: string;
  feature_version: string;
}

export interface Case {
  case_id: string;
  tenant: string;
  transaction_id: string;
  account_ref: string;
  score: number;
  band: string;
  signals: string[];
  card_attempts: number;
  device_accounts: number;
  pan: string;
}

export interface AuditEntry {
  actor: string;
  scope: string;
  case_id: string;
}

/** The account, or null when the scorer has never seen it. */
export async function getAccount(accountRef: string): Promise<Account | null> {
  const raw = await redis.hgetall(\`account:\${accountRef}\`);
  if (Object.keys(raw).length === 0) return null;
  return {account_ref: raw.account_ref, tenant: raw.tenant, age_days: Number(raw.age_days), chargebacks: Number(raw.chargebacks)};
}

export async function putAccount(record: Account): Promise<void> {
  await redis.hset(\`account:\${record.account_ref}\`, {
    account_ref: record.account_ref,
    tenant: record.tenant,
    age_days: String(record.age_days),
    chargebacks: String(record.chargebacks),
  });
}

/** The decision stored for the transaction, or null. */
export async function getDecision(transactionId: string): Promise<Decision | null> {
  const raw = await redis.get(\`decision:\${transactionId}\`);
  return raw === null ? null : (JSON.parse(raw) as Decision);
}

/** Store the decision under its transaction_id. */
export async function saveDecision(record: Decision): Promise<void> {
  await redis.set(\`decision:\${record.transaction_id}\`, JSON.stringify(record));
}

/** The back-office read: any tenant's case by id, or null. */
export async function loadCase(caseId: string): Promise<Case | null> {
  const raw = await redis.hgetall(\`case:\${caseId}\`);
  if (Object.keys(raw).length === 0) return null;
  return {
    case_id: raw.case_id,
    tenant: raw.tenant,
    transaction_id: raw.transaction_id,
    account_ref: raw.account_ref,
    score: Number(raw.score),
    band: raw.band,
    signals: JSON.parse(raw.signals) as string[],
    card_attempts: Number(raw.card_attempts),
    device_accounts: Number(raw.device_accounts),
    pan: raw.pan,
  };
}

/** The case when it belongs to tenant, else null (a foreign case and a missing one look the same). */
export async function caseOf(tenant: string, caseId: string): Promise<Case | null> {
  const found = await loadCase(caseId);
  return found !== null && found.tenant === tenant ? found : null;
}

export async function putCase(record: Case): Promise<void> {
  await redis.hset(\`case:\${record.case_id}\`, {
    case_id: record.case_id,
    tenant: record.tenant,
    transaction_id: record.transaction_id,
    account_ref: record.account_ref,
    score: String(record.score),
    band: record.band,
    signals: JSON.stringify(record.signals),
    card_attempts: String(record.card_attempts),
    device_accounts: String(record.device_accounts),
    pan: record.pan,
  });
}

/** Append one audited PAN read. */
export async function audit(actor: string, scope: string, caseId: string): Promise<void> {
  await redis.rpush('audit:pan', JSON.stringify({actor, scope, case_id: caseId}));
}

export async function auditLog(): Promise<AuditEntry[]> {
  return (await redis.lrange('audit:pan', 0, -1)).map(entry => JSON.parse(entry) as AuditEntry);
}
`,
  'fraud/model.ts': `/**
 * The model client (provided; step 3 builds the same function). scoreTransaction(features) calls
 * Model.Score at MODEL_TARGET with a DEADLINE_MS (300 ms) deadline per attempt and at most
 * MAX_ATTEMPTS (3) attempts; only UNAVAILABLE and DEADLINE_EXCEEDED are retried, and INVALID_ARGUMENT
 * throws InvalidFeatures. When the attempts run out, or the model answers another error, it resolves
 * the rules verdict: rulesScore raised to at least RULES_MIN_SCORE, so a degraded decision is never
 * an approval, marked fallback with model_version RULES_VERSION.
 */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {type Features, RULES_VERSION, bandFor, rulesScore} from 'fraud/features';

export const MODEL_TARGET = 'fraud-model:9000';
export const DEADLINE_MS = 300;
export const MAX_ATTEMPTS = 3;
export const RULES_MIN_SCORE = 0.45;
const RETRYABLE = [grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED];

export interface Verdict {
  score: number;
  band: string;
  fallback: boolean;
  model_version: string;
}

interface ScoreReply {
  score: number;
  model_version: string;
}

interface ModelClient {
  Score(request: Features, options: {deadline: number}): Promise<ScoreReply>;
}

const {fraudscore} = grpc.loadPackageDefinition(protoLoader.loadSync('fraud_scoring.proto')) as unknown as {
  fraudscore: {Model: new (target: string, credentials: grpc.ChannelCredentials) => ModelClient};
};
const stub = new fraudscore.Model(MODEL_TARGET, grpc.credentials.createInsecure());

/** The model refused the vector (INVALID_ARGUMENT): every attempt would be refused the same way. */
export class InvalidFeatures extends Error {}

export function rulesVerdict(features: Features): Verdict {
  const score = Math.max(rulesScore(features), RULES_MIN_SCORE);
  return {score, band: bandFor(score), fallback: true, model_version: RULES_VERSION};
}

export async function scoreTransaction(features: Features): Promise<Verdict> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let reply: ScoreReply;
    try {
      reply = await stub.Score(features, {deadline: Date.now() + DEADLINE_MS});
    } catch (err) {
      const {code, details} = err as grpc.ServiceError;
      if (code === grpc.status.INVALID_ARGUMENT) throw new InvalidFeatures(details);
      if (RETRYABLE.includes(code)) continue;
      break;
    }
    return {score: reply.score, band: bandFor(reply.score), fallback: false, model_version: reply.model_version};
  }
  return rulesVerdict(features);
}
`,
  'fraud/risk_model.ts': `/**
 * The stand-in for the fraud model. The checks serve modelPeer over gRPC (Model.Score at
 * MODEL_TARGET); the scorer never calls it directly. Deterministic, in hundredths: 5, plus 40 per
 * prior chargeback, plus 15 under 30 days of account age, plus 10 from 1000.00 up, capped at 99. A
 * vector at any feature_version but FEATURE_VERSION is refused with INVALID_ARGUMENT.
 */
import * as grpc from '@grpc/grpc-js';

import {FEATURE_VERSION} from 'fraud/features';

export const MODEL_VERSION = 'fm-2026-11';

export function modelScore(accountAgeDays: number, priorChargebacks: number, amountCents: number): number {
  let points = 5 + 40 * priorChargebacks;
  if (accountAgeDays < 30) points += 15;
  if (amountCents >= 100_000) points += 10;
  return Math.min(points, 99) / 100;
}

interface ScoreCall {
  request: {feature_version: string; account_age_days: unknown; prior_chargebacks: unknown; amount_cents: unknown};
}
type ScoreCallback = (error: {code: grpc.status; details: string} | null, reply?: {score: number; model_version: string}) => void;

export const modelPeer = {
  Score(call: ScoreCall, callback: ScoreCallback): void {
    const {feature_version, account_age_days, prior_chargebacks, amount_cents} = call.request;
    if (feature_version !== FEATURE_VERSION) {
      callback({code: grpc.status.INVALID_ARGUMENT, details: \`feature_version "\${feature_version}" is not \${FEATURE_VERSION}\`});
      return;
    }
    const score = modelScore(Number(account_age_days), Number(prior_chargebacks), Number(amount_cents));
    callback(null, {score, model_version: MODEL_VERSION});
  },
};
`,
};

export const supportModulesGo: Record<string, string> = {
  'fraud/features/features.go': `// Package features is the feature contract every step agrees on (provided). DeriveFeatures is the
// server's own view of a transaction at FeatureVersion: the account's age and chargeback history
// from the account store, and the amount. FeatureDigest is the SHA-256 of the canonical JSON (sorted
// keys, no spaces), so an event can name a vector without carrying it. BandFor maps a score to
// approve (<= ApproveMax), review (<= ReviewMax) or decline. RulesScore is the rules engine, counted
// in hundredths so every language agrees: 10, plus 30 per prior chargeback, plus 20 under 30 days of
// account age, plus 20 from 1000.00 up, capped at 100.
package features

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"

	"fraud/store"
)

const (
	FeatureVersion = "fx-3"
	RulesVersion   = "rules-7"
	ApproveMax     = 0.30
	ReviewMax      = 0.70
)

// Features is a feature vector. Its fields are in key order, so json.Marshal is the canonical form.
type Features struct {
	AccountAgeDays   int64  \`json:"account_age_days"\`
	AmountCents      int64  \`json:"amount_cents"\`
	FeatureVersion   string \`json:"feature_version"\`
	PriorChargebacks int64  \`json:"prior_chargebacks"\`
}

// DeriveFeatures is the server's feature vector for a transaction of amountCents by account.
func DeriveFeatures(account store.Account, amountCents int64) Features {
	return Features{AccountAgeDays: account.AgeDays, AmountCents: amountCents, FeatureVersion: FeatureVersion, PriorChargebacks: account.Chargebacks}
}

// FeatureDigest is the SHA-256 of the vector's canonical JSON, as 64 hex digits.
func FeatureDigest(f Features) string {
	canonical, _ := json.Marshal(f)
	sum := sha256.Sum256(canonical)
	return hex.EncodeToString(sum[:])
}

// BandFor maps a score to approve, review or decline.
func BandFor(score float64) string {
	switch {
	case score <= ApproveMax:
		return "approve"
	case score <= ReviewMax:
		return "review"
	}
	return "decline"
}

// RulesScore is the rules engine's score of the vector.
func RulesScore(f Features) float64 {
	points := 10 + 30*f.PriorChargebacks
	if f.AccountAgeDays < 30 {
		points += 20
	}
	if f.AmountCents >= 100000 {
		points += 20
	}
	if points > 100 {
		points = 100
	}
	return float64(points) / 100
}
`,
  'fraud/store/store.go': `// Package store holds the scorer's records (provided), in Redis as the course's stand-in for its
// database: account:{ref} a hash (account_ref, tenant, age_days, chargebacks);
// decision:{transaction_id} the stored decision as JSON; case:{case_id} a hash (case_id, tenant,
// transaction_id, account_ref, score, band, signals as a JSON array, card_attempts,
// device_accounts, pan); audit:pan the audited PAN reads, oldest first, each JSON {actor, scope,
// case_id}.
package store

import (
	"context"
	"encoding/json"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Account is one cardholder account the scorer knows.
type Account struct {
	AccountRef  string \`json:"account_ref"\`
	Tenant      string \`json:"tenant"\`
	AgeDays     int64  \`json:"age_days"\`
	Chargebacks int64  \`json:"chargebacks"\`
}

// Decision is what the scorer answered for one transaction.
type Decision struct {
	TransactionID  string  \`json:"transaction_id"\`
	AccountRef     string  \`json:"account_ref"\`
	Score          float64 \`json:"score"\`
	Band           string  \`json:"band"\`
	Fallback       bool    \`json:"fallback"\`
	ModelVersion   string  \`json:"model_version"\`
	FeatureVersion string  \`json:"feature_version"\`
}

// Case is a decision sent to review, with what the reviewer needs and the card it was made on.
type Case struct {
	CaseID         string   \`json:"case_id"\`
	Tenant         string   \`json:"tenant"\`
	TransactionID  string   \`json:"transaction_id"\`
	AccountRef     string   \`json:"account_ref"\`
	Score          float64  \`json:"score"\`
	Band           string   \`json:"band"\`
	Signals        []string \`json:"signals"\`
	CardAttempts   int64    \`json:"card_attempts"\`
	DeviceAccounts int64    \`json:"device_accounts"\`
	Pan            string   \`json:"pan"\`
}

// AuditEntry is one audited PAN read.
type AuditEntry struct {
	Actor  string \`json:"actor"\`
	Scope  string \`json:"scope"\`
	CaseID string \`json:"case_id"\`
}

func number(raw string) int64 {
	n, _ := strconv.ParseInt(raw, 10, 64)
	return n
}

// GetAccount is the account, or nil when the scorer has never seen it.
func GetAccount(ctx context.Context, accountRef string) *Account {
	raw := rdb.HGetAll(ctx, "account:"+accountRef).Val()
	if len(raw) == 0 {
		return nil
	}
	return &Account{AccountRef: raw["account_ref"], Tenant: raw["tenant"], AgeDays: number(raw["age_days"]), Chargebacks: number(raw["chargebacks"])}
}

// PutAccount stores the account.
func PutAccount(ctx context.Context, a Account) {
	rdb.HSet(ctx, "account:"+a.AccountRef, map[string]any{"account_ref": a.AccountRef, "tenant": a.Tenant, "age_days": strconv.FormatInt(a.AgeDays, 10), "chargebacks": strconv.FormatInt(a.Chargebacks, 10)})
}

// GetDecision is the decision stored for the transaction, or nil.
func GetDecision(ctx context.Context, transactionID string) *Decision {
	raw, err := rdb.Get(ctx, "decision:"+transactionID).Result()
	if err != nil {
		return nil
	}
	var d Decision
	if json.Unmarshal([]byte(raw), &d) != nil {
		return nil
	}
	return &d
}

// SaveDecision stores the decision under its TransactionID.
func SaveDecision(ctx context.Context, d Decision) {
	raw, _ := json.Marshal(d)
	rdb.Set(ctx, "decision:"+d.TransactionID, string(raw), 0)
}

// LoadCase is the back-office read: any tenant's case by id, or nil.
func LoadCase(ctx context.Context, caseID string) *Case {
	raw := rdb.HGetAll(ctx, "case:"+caseID).Val()
	if len(raw) == 0 {
		return nil
	}
	score, _ := strconv.ParseFloat(raw["score"], 64)
	var signals []string
	json.Unmarshal([]byte(raw["signals"]), &signals)
	return &Case{
		CaseID: raw["case_id"], Tenant: raw["tenant"], TransactionID: raw["transaction_id"], AccountRef: raw["account_ref"],
		Score: score, Band: raw["band"], Signals: signals,
		CardAttempts: number(raw["card_attempts"]), DeviceAccounts: number(raw["device_accounts"]), Pan: raw["pan"],
	}
}

// CaseOf is the case when it belongs to tenant, else nil (a foreign case and a missing one look the same).
func CaseOf(ctx context.Context, tenant, caseID string) *Case {
	c := LoadCase(ctx, caseID)
	if c == nil || c.Tenant != tenant {
		return nil
	}
	return c
}

// PutCase stores the case.
func PutCase(ctx context.Context, c Case) {
	signals, _ := json.Marshal(c.Signals)
	rdb.HSet(ctx, "case:"+c.CaseID, map[string]any{
		"case_id": c.CaseID, "tenant": c.Tenant, "transaction_id": c.TransactionID, "account_ref": c.AccountRef,
		"score": strconv.FormatFloat(c.Score, 'f', -1, 64), "band": c.Band, "signals": string(signals),
		"card_attempts": strconv.FormatInt(c.CardAttempts, 10), "device_accounts": strconv.FormatInt(c.DeviceAccounts, 10), "pan": c.Pan,
	})
}

// Audit appends one audited PAN read.
func Audit(ctx context.Context, actor, scope, caseID string) {
	raw, _ := json.Marshal(AuditEntry{Actor: actor, Scope: scope, CaseID: caseID})
	rdb.RPush(ctx, "audit:pan", string(raw))
}

// AuditLog is every audited PAN read, oldest first.
func AuditLog(ctx context.Context) []AuditEntry {
	var out []AuditEntry
	for _, raw := range rdb.LRange(ctx, "audit:pan", 0, -1).Val() {
		var e AuditEntry
		if json.Unmarshal([]byte(raw), &e) == nil {
			out = append(out, e)
		}
	}
	return out
}
`,
  'fraud/model/model.go': `// Package model is the model client (provided; step 3 builds the same function). ScoreTransaction
// calls Model.Score at ModelTarget with a 300 ms deadline per attempt and at most three attempts;
// only Unavailable and DeadlineExceeded are retried, and InvalidArgument returns ErrInvalidFeatures.
// When the attempts run out, or the model answers another error, it answers the rules verdict:
// RulesScore raised to at least RulesMinScore, so a degraded decision is never an approval, marked
// Fallback with ModelVersion features.RulesVersion.
package model

import (
	"context"
	"errors"
	"fmt"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"fraud/features"
	pb "fraud/gen/fraud_scoring"
)

const (
	ModelTarget   = "fraud-model:9000"
	deadline      = 300 * time.Millisecond
	maxAttempts   = 3
	RulesMinScore = 0.45
)

var conn, _ = grpc.NewClient(ModelTarget, grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewModelClient(conn)

// ErrInvalidFeatures: the model refused the vector, and every attempt would be refused the same way.
var ErrInvalidFeatures = errors.New("invalid features")

// Verdict is one score of a feature vector and where it came from.
type Verdict struct {
	Score        float64 \`json:"score"\`
	Band         string  \`json:"band"\`
	Fallback     bool    \`json:"fallback"\`
	ModelVersion string  \`json:"model_version"\`
}

// RulesVerdict is the rules engine's verdict, never in the approve band.
func RulesVerdict(f features.Features) Verdict {
	score := features.RulesScore(f)
	if score < RulesMinScore {
		score = RulesMinScore
	}
	return Verdict{Score: score, Band: features.BandFor(score), Fallback: true, ModelVersion: features.RulesVersion}
}

// ScoreTransaction scores the vector with the model, or with the rules when the model cannot answer.
func ScoreTransaction(ctx context.Context, f features.Features) (Verdict, error) {
	request := &pb.ScoreRequest{FeatureVersion: f.FeatureVersion, AccountAgeDays: f.AccountAgeDays, PriorChargebacks: f.PriorChargebacks, AmountCents: f.AmountCents}
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		reply, err := stub.Score(callCtx, request)
		cancel()
		if err == nil {
			return Verdict{Score: reply.GetScore(), Band: features.BandFor(reply.GetScore()), Fallback: false, ModelVersion: reply.GetModelVersion()}, nil
		}
		code := status.Code(err)
		if code == codes.InvalidArgument {
			return Verdict{}, fmt.Errorf("%w: %s", ErrInvalidFeatures, status.Convert(err).Message())
		}
		if code != codes.Unavailable && code != codes.DeadlineExceeded {
			break
		}
	}
	return RulesVerdict(f), nil
}
`,
  'fraud/riskmodel/riskmodel.go': `// Package riskmodel is the stand-in for the fraud model. The checks register Peer over gRPC
// (Model.Score at model.ModelTarget); the scorer never calls it directly. Deterministic, in
// hundredths: 5, plus 40 per prior chargeback, plus 15 under 30 days of account age, plus 10 from
// 1000.00 up, capped at 99. A vector at any feature_version but features.FeatureVersion is refused
// with InvalidArgument.
package riskmodel

import (
	"context"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"fraud/features"
	pb "fraud/gen/fraud_scoring"
)

const ModelVersion = "fm-2026-11"

// ModelScore is the stand-in's score.
func ModelScore(accountAgeDays, priorChargebacks, amountCents int64) float64 {
	points := 5 + 40*priorChargebacks
	if accountAgeDays < 30 {
		points += 15
	}
	if amountCents >= 100000 {
		points += 10
	}
	if points > 99 {
		points = 99
	}
	return float64(points) / 100
}

// Peer serves Model.Score.
type Peer struct {
	pb.UnimplementedModelServer
}

func (Peer) Score(_ context.Context, req *pb.ScoreRequest) (*pb.ScoreReply, error) {
	if req.GetFeatureVersion() != features.FeatureVersion {
		return nil, status.Errorf(codes.InvalidArgument, "feature_version %q is not %s", req.GetFeatureVersion(), features.FeatureVersion)
	}
	score := ModelScore(req.GetAccountAgeDays(), req.GetPriorChargebacks(), req.GetAmountCents())
	return &pb.ScoreReply{Score: score, ModelVersion: ModelVersion}, nil
}
`,
};

/** The C++ twins as headers (fraud/*.h), plus digest.h (SHA-256). */
export const supportModulesCpp: Record<string, string> = {
  'digest.h': CPP_DIGEST_H,
  'fraud/store.h': `// The scorer's records (provided), in Redis as the course's stand-in for its database:
// account:{ref} a hash (account_ref, tenant, age_days, chargebacks); decision:{transaction_id} the
// stored decision as JSON; case:{case_id} a hash (case_id, tenant, transaction_id, account_ref,
// score, band, signals as a JSON array, card_attempts, device_accounts, pan); audit:pan the audited
// PAN reads, oldest first, each JSON {actor, scope, case_id}.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace store {

// One cardholder account the scorer knows.
struct Account {
  std::string account_ref;
  std::string tenant;
  long long age_days = 0;
  long long chargebacks = 0;
};

// A decision sent to review, with what the reviewer needs and the card it was made on.
struct Case {
  std::string case_id;
  std::string tenant;
  std::string transaction_id;
  std::string account_ref;
  double score = 0;
  std::string band;
  std::vector<std::string> signals;
  long long card_attempts = 0;
  long long device_accounts = 0;
  std::string pan;
};

// One audited PAN read.
struct AuditEntry {
  std::string actor;
  std::string scope;
  std::string case_id;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// The account, or none when the scorer has never seen it.
inline std::optional<Account> getAccount(const std::string& account_ref) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall("account:" + account_ref);
  if (raw.empty()) return std::nullopt;
  return Account{raw.at("account_ref"), raw.at("tenant"), std::stoll(raw.at("age_days")), std::stoll(raw.at("chargebacks"))};
}

inline void putAccount(const Account& a) {
  redis().hset("account:" + a.account_ref, {{"account_ref", a.account_ref}, {"tenant", a.tenant},
                                            {"age_days", std::to_string(a.age_days)}, {"chargebacks", std::to_string(a.chargebacks)}});
}

// The decision stored for the transaction (a JSON object), or none.
inline std::optional<nlohmann::json> getDecision(const std::string& transaction_id) {
  const auto raw = redis().get("decision:" + transaction_id);
  if (!raw) return std::nullopt;
  return nlohmann::json::parse(*raw);
}

// Store the decision under its transaction_id.
inline void saveDecision(const nlohmann::json& decision) {
  redis().set("decision:" + decision.at("transaction_id").get<std::string>(), decision.dump());
}

// The back-office read: any tenant's case by id, or none.
inline std::optional<Case> loadCase(const std::string& case_id) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall("case:" + case_id);
  if (raw.empty()) return std::nullopt;
  Case c;
  c.case_id = raw.at("case_id");
  c.tenant = raw.at("tenant");
  c.transaction_id = raw.at("transaction_id");
  c.account_ref = raw.at("account_ref");
  c.score = std::stod(raw.at("score"));
  c.band = raw.at("band");
  c.signals = nlohmann::json::parse(raw.at("signals")).get<std::vector<std::string>>();
  c.card_attempts = std::stoll(raw.at("card_attempts"));
  c.device_accounts = std::stoll(raw.at("device_accounts"));
  c.pan = raw.at("pan");
  return c;
}

// The case when it belongs to tenant, else none (a foreign case and a missing one look the same).
inline std::optional<Case> caseOf(const std::string& tenant, const std::string& case_id) {
  auto c = loadCase(case_id);
  if (!c || c->tenant != tenant) return std::nullopt;
  return c;
}

inline void putCase(const Case& c) {
  redis().hset("case:" + c.case_id, {{"case_id", c.case_id},
                                     {"tenant", c.tenant},
                                     {"transaction_id", c.transaction_id},
                                     {"account_ref", c.account_ref},
                                     {"score", nlohmann::json(c.score).dump()},
                                     {"band", c.band},
                                     {"signals", nlohmann::json(c.signals).dump()},
                                     {"card_attempts", std::to_string(c.card_attempts)},
                                     {"device_accounts", std::to_string(c.device_accounts)},
                                     {"pan", c.pan}});
}

// Append one audited PAN read.
inline void audit(const std::string& actor, const std::string& scope, const std::string& case_id) {
  redis().rpush("audit:pan", nlohmann::json{{"actor", actor}, {"scope", scope}, {"case_id", case_id}}.dump());
}

inline std::vector<AuditEntry> auditLog() {
  std::vector<AuditEntry> out;
  for (const auto& raw : redis().lrange("audit:pan", 0, -1)) {
    const auto entry = nlohmann::json::parse(raw);
    out.push_back({entry.value("actor", ""), entry.value("scope", ""), entry.value("case_id", "")});
  }
  return out;
}

}  // namespace store
`,
  'fraud/features.h': `// The feature contract every step agrees on (provided). deriveFeatures is the server's own view of
// a transaction at kFeatureVersion: the account's age and chargeback history from the account store,
// and the amount. featureDigest is the SHA-256 of the canonical JSON (sorted keys, no spaces), so an
// event can name a vector without carrying it. bandFor maps a score to approve (<= kApproveMax),
// review (<= kReviewMax) or decline. rulesScore is the rules engine, counted in hundredths so every
// language agrees: 10, plus 30 per prior chargeback, plus 20 under 30 days of account age, plus 20
// from 1000.00 up, capped at 100.
#pragma once

#include <nlohmann/json.hpp>

#include <algorithm>
#include <string>

#include "digest.h"
#include "fraud/store.h"

namespace features {

inline const std::string kFeatureVersion = "fx-3";
inline const std::string kRulesVersion = "rules-7";
inline constexpr double kApproveMax = 0.30;
inline constexpr double kReviewMax = 0.70;

// A feature vector.
struct Features {
  std::string feature_version;
  long long account_age_days = 0;
  long long prior_chargebacks = 0;
  long long amount_cents = 0;
};

// The vector as a JSON object (keys sorted, as nlohmann::json keeps them).
inline nlohmann::json toJson(const Features& f) {
  return nlohmann::json{{"feature_version", f.feature_version},
                        {"account_age_days", f.account_age_days},
                        {"prior_chargebacks", f.prior_chargebacks},
                        {"amount_cents", f.amount_cents}};
}

// The server's feature vector for a transaction of amount_cents by account.
inline Features deriveFeatures(const store::Account& account, long long amount_cents) {
  return Features{kFeatureVersion, account.age_days, account.chargebacks, amount_cents};
}

// The SHA-256 of the vector's canonical JSON, as 64 hex digits.
inline std::string featureDigest(const Features& f) { return sha256_hex(toJson(f).dump()); }

// approve, review or decline.
inline std::string bandFor(double score) {
  if (score <= kApproveMax) return "approve";
  if (score <= kReviewMax) return "review";
  return "decline";
}

// The rules engine's score of the vector.
inline double rulesScore(const Features& f) {
  long long points = 10 + 30 * f.prior_chargebacks;
  if (f.account_age_days < 30) points += 20;
  if (f.amount_cents >= 100000) points += 20;
  return static_cast<double>(std::min<long long>(points, 100)) / 100;
}

}  // namespace features
`,
  'fraud/model.h': `// The model client (provided; step 3 builds the same function). scoreTransaction calls Model.Score
// at kModelTarget with a 300 ms deadline per attempt and at most three attempts; only UNAVAILABLE
// and DEADLINE_EXCEEDED are retried, and INVALID_ARGUMENT throws InvalidFeatures. When the attempts
// run out, or the model answers another error, it answers the rules verdict: rulesScore raised to at
// least kRulesMinScore, so a degraded decision is never an approval, marked fallback with
// model_version features::kRulesVersion.
#pragma once

#include <grpcpp/grpcpp.h>

#include <algorithm>
#include <chrono>
#include <stdexcept>
#include <string>

#include "fraud/features.h"
#include "fraud_scoring.grpc.pb.h"

namespace model {

inline const std::string kModelTarget = "fraud-model:9000";
inline constexpr std::chrono::milliseconds kDeadline{300};
inline constexpr int kMaxAttempts = 3;
inline constexpr double kRulesMinScore = 0.45;

// One score of a feature vector and where it came from.
struct Verdict {
  double score = 0;
  std::string band;
  bool fallback = false;
  std::string model_version;
};

// The model refused the vector (INVALID_ARGUMENT): every attempt would be refused the same way.
struct InvalidFeatures : std::runtime_error {
  using std::runtime_error::runtime_error;
};

inline fraudscore::Model::Stub& stub() {
  static auto s = fraudscore::Model::NewStub(grpc::CreateChannel(kModelTarget, grpc::InsecureChannelCredentials()));
  return *s;
}

// The rules engine's verdict, never in the approve band.
inline Verdict rulesVerdict(const features::Features& f) {
  const double score = std::max(features::rulesScore(f), kRulesMinScore);
  return Verdict{score, features::bandFor(score), true, features::kRulesVersion};
}

// Scores the vector with the model, or with the rules when the model cannot answer.
inline Verdict scoreTransaction(const features::Features& f) {
  fraudscore::ScoreRequest request;
  request.set_feature_version(f.feature_version);
  request.set_account_age_days(f.account_age_days);
  request.set_prior_chargebacks(f.prior_chargebacks);
  request.set_amount_cents(f.amount_cents);
  for (int attempt = 1; attempt <= kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    fraudscore::ScoreReply reply;
    const grpc::Status status = stub().Score(&ctx, request, &reply);
    if (status.ok()) return Verdict{reply.score(), features::bandFor(reply.score()), false, reply.model_version()};
    const auto code = status.error_code();
    if (code == grpc::StatusCode::INVALID_ARGUMENT) throw InvalidFeatures(status.error_message());
    if (code != grpc::StatusCode::UNAVAILABLE && code != grpc::StatusCode::DEADLINE_EXCEEDED) break;
  }
  return rulesVerdict(f);
}

}  // namespace model
`,
  'fraud/risk_model.h': `// The stand-in for the fraud model. The checks register riskmodel::Peer over gRPC (Model.Score at
// model::kModelTarget); the scorer never calls it directly. Deterministic, in hundredths: 5, plus 40
// per prior chargeback, plus 15 under 30 days of account age, plus 10 from 1000.00 up, capped at 99.
// A vector at any feature_version but features::kFeatureVersion is refused with INVALID_ARGUMENT.
#pragma once

#include <grpcpp/grpcpp.h>

#include <algorithm>
#include <string>

#include "fraud/features.h"
#include "fraud_scoring.grpc.pb.h"

namespace riskmodel {

inline const std::string kModelVersion = "fm-2026-11";

inline double modelScore(long long account_age_days, long long prior_chargebacks, long long amount_cents) {
  long long points = 5 + 40 * prior_chargebacks;
  if (account_age_days < 30) points += 15;
  if (amount_cents >= 100000) points += 10;
  return static_cast<double>(std::min<long long>(points, 99)) / 100;
}

class Peer final : public fraudscore::Model::Service {
 public:
  grpc::Status Score(grpc::ServerContext*, const fraudscore::ScoreRequest* req, fraudscore::ScoreReply* out) override {
    if (req->feature_version() != features::kFeatureVersion) {
      return grpc::Status(grpc::StatusCode::INVALID_ARGUMENT, "feature_version " + req->feature_version() + " is not " + features::kFeatureVersion);
    }
    out->set_score(modelScore(req->account_age_days(), req->prior_chargebacks(), req->amount_cents()));
    out->set_model_version(kModelVersion);
    return grpc::Status::OK;
  }
};

}  // namespace riskmodel
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('fraud', 'Features')]: `package fraud

import java.nio.charset.StandardCharsets
import java.security.MessageDigest

/** A feature vector. */
final case class FeatureVector(featureVersion: String, accountAgeDays: Long, priorChargebacks: Long, amountCents: Long)

/**
 * The feature contract every step agrees on (provided). deriveFeatures is the server's own view of a
 * transaction at FeatureVersion: the account's age and chargeback history from the account store,
 * and the amount. featureDigest is the SHA-256 of the canonical JSON (sorted keys, no spaces), so an
 * event can name a vector without carrying it. bandFor maps a score to approve (<= ApproveMax),
 * review (<= ReviewMax) or decline. rulesScore is the rules engine, counted in hundredths so every
 * language agrees: 10, plus 30 per prior chargeback, plus 20 under 30 days of account age, plus 20
 * from 1000.00 up, capped at 100.
 */
object Features {
  val FeatureVersion = "fx-3"
  val RulesVersion = "rules-7"
  val ApproveMax = 0.30
  val ReviewMax = 0.70

  def deriveFeatures(account: Account, amountCents: Long): FeatureVector =
    FeatureVector(FeatureVersion, account.ageDays, account.chargebacks, amountCents)

  def canonicalJson(f: FeatureVector): String =
    s"""{"account_age_days":\${f.accountAgeDays},"amount_cents":\${f.amountCents},"feature_version":"\${f.featureVersion}","prior_chargebacks":\${f.priorChargebacks}}"""

  def featureDigest(f: FeatureVector): String =
    MessageDigest.getInstance("SHA-256").digest(canonicalJson(f).getBytes(StandardCharsets.UTF_8)).map(b => f"\${b & 0xff}%02x").mkString

  def bandFor(score: Double): String =
    if (score <= ApproveMax) "approve" else if (score <= ReviewMax) "review" else "decline"

  def rulesScore(f: FeatureVector): Double = {
    var points = 10L + 30L * f.priorChargebacks
    if (f.accountAgeDays < 30) points += 20
    if (f.amountCents >= 100000) points += 20
    math.min(points, 100L).toDouble / 100
  }
}
`,
  [scalaPath('fraud', 'Store')]: `package fraud

import redis.clients.jedis.JedisPooled
import spray.json._
import spray.json.DefaultJsonProtocol._

import scala.jdk.CollectionConverters._

/** One cardholder account the scorer knows. */
final case class Account(accountRef: String, tenant: String, ageDays: Long, chargebacks: Long)

/** A decision sent to review, with what the reviewer needs and the card it was made on. */
final case class Case(
    caseId: String,
    tenant: String,
    transactionId: String,
    accountRef: String,
    score: Double,
    band: String,
    signals: Seq[String],
    cardAttempts: Long,
    deviceAccounts: Long,
    pan: String)

/** One audited PAN read. */
final case class AuditEntry(actor: String, scope: String, caseId: String)

/**
 * The scorer's records (provided), in Redis as the course's stand-in for its database:
 * account:{ref} a hash (account_ref, tenant, age_days, chargebacks); decision:{transaction_id} the
 * stored decision as JSON; case:{case_id} a hash (case_id, tenant, transaction_id, account_ref,
 * score, band, signals as a JSON array, card_attempts, device_accounts, pan); audit:pan the audited
 * PAN reads, oldest first, each JSON {actor, scope, case_id}.
 */
object Store {
  val jedis = new JedisPooled("redis", 6379)

  /** The account, if the scorer has seen it. */
  def getAccount(accountRef: String): Option[Account] = {
    val raw = jedis.hgetAll(s"account:$accountRef").asScala.toMap
    if (raw.isEmpty) None else Some(Account(raw("account_ref"), raw("tenant"), raw("age_days").toLong, raw("chargebacks").toLong))
  }

  def putAccount(a: Account): Unit =
    jedis.hset(s"account:\${a.accountRef}", Map("account_ref" -> a.accountRef, "tenant" -> a.tenant, "age_days" -> a.ageDays.toString, "chargebacks" -> a.chargebacks.toString).asJava)

  /** The decision stored for the transaction, if any. */
  def getDecision(transactionId: String): Option[JsObject] =
    Option(jedis.get(s"decision:$transactionId")).map(_.parseJson.asJsObject)

  /** Store the decision under its transaction_id. */
  def saveDecision(decision: JsObject): Unit =
    jedis.set(s"decision:\${decision.fields("transaction_id").convertTo[String]}", decision.compactPrint)

  /** The back-office read: any tenant's case by id. */
  def loadCase(caseId: String): Option[Case] = {
    val raw = jedis.hgetAll(s"case:$caseId").asScala.toMap
    if (raw.isEmpty) None
    else
      Some(Case(raw("case_id"), raw("tenant"), raw("transaction_id"), raw("account_ref"), raw("score").toDouble, raw("band"),
        raw("signals").parseJson.convertTo[Seq[String]], raw("card_attempts").toLong, raw("device_accounts").toLong, raw("pan")))
  }

  /** The case when it belongs to tenant (a foreign case and a missing one look the same). */
  def caseOf(tenant: String, caseId: String): Option[Case] = loadCase(caseId).filter(_.tenant == tenant)

  def putCase(c: Case): Unit =
    jedis.hset(s"case:\${c.caseId}", Map(
      "case_id" -> c.caseId, "tenant" -> c.tenant, "transaction_id" -> c.transactionId, "account_ref" -> c.accountRef,
      "score" -> c.score.toString, "band" -> c.band, "signals" -> c.signals.toJson.compactPrint,
      "card_attempts" -> c.cardAttempts.toString, "device_accounts" -> c.deviceAccounts.toString, "pan" -> c.pan).asJava)

  /** Append one audited PAN read. */
  def audit(actor: String, scope: String, caseId: String): Unit =
    jedis.rpush("audit:pan", JsObject("actor" -> JsString(actor), "scope" -> JsString(scope), "case_id" -> JsString(caseId)).compactPrint)

  def auditLog(): Seq[AuditEntry] =
    jedis.lrange("audit:pan", 0, -1).asScala.toSeq.map { raw =>
      val fields = raw.parseJson.asJsObject.fields
      AuditEntry(fields("actor").convertTo[String], fields("scope").convertTo[String], fields("case_id").convertTo[String])
    }
}
`,
  [scalaPath('fraud', 'Model')]: `package fraud

import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import fraudscore.fraud_scoring.{ModelGrpc, ScoreRequest}

/** One score of a feature vector and where it came from. */
final case class Verdict(score: Double, band: String, fallback: Boolean, modelVersion: String)

/** The model refused the vector (INVALID_ARGUMENT): every attempt would be refused the same way. */
final class InvalidFeatures(message: String) extends Exception(message)

/**
 * The model client (provided; step 3 builds the same function). scoreTransaction calls Model.Score
 * at ModelTarget with a 300 ms deadline per attempt and at most three attempts; only UNAVAILABLE and
 * DEADLINE_EXCEEDED are retried, and INVALID_ARGUMENT throws InvalidFeatures. When the attempts run
 * out, or the model answers another error, it answers the rules verdict: rulesScore raised to at
 * least RulesMinScore, so a degraded decision is never an approval, marked fallback with model
 * version Features.RulesVersion.
 */
object Model {
  val ModelTarget = "fraud-model:9000"
  val DeadlineMs = 300L
  val MaxAttempts = 3
  val RulesMinScore = 0.45
  private val Retryable = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)

  private val stub = ModelGrpc.blockingStub(ManagedChannelBuilder.forTarget(ModelTarget).usePlaintext().build())

  def rulesVerdict(f: FeatureVector): Verdict = {
    val score = math.max(Features.rulesScore(f), RulesMinScore)
    Verdict(score, Features.bandFor(score), fallback = true, Features.RulesVersion)
  }

  def scoreTransaction(f: FeatureVector): Verdict = {
    val request = ScoreRequest(f.featureVersion, f.accountAgeDays, f.priorChargebacks, f.amountCents)
    var attempt = 1
    while (attempt <= MaxAttempts) {
      try {
        val reply = stub.withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS).score(request)
        return Verdict(reply.score, Features.bandFor(reply.score), fallback = false, reply.modelVersion)
      } catch {
        case e: StatusRuntimeException if e.getStatus.getCode == Status.Code.INVALID_ARGUMENT =>
          throw new InvalidFeatures(Option(e.getStatus.getDescription).getOrElse("invalid features"))
        case e: StatusRuntimeException if Retryable(e.getStatus.getCode) => attempt += 1
        case _: StatusRuntimeException => attempt = MaxAttempts + 1
      }
    }
    rulesVerdict(f)
  }
}
`,
};
