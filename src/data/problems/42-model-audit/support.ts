/**
 * Hand-written support modules the model-audit steps import but no step builds: the `audit`
 * package. `audit.digest` is SHA-256 in hex and one chain link; `audit.ledger` is the decision
 * records (Redis hashes, the course's stand-in for the audit database), the signing queue and the
 * outbox; `audit.chain` is the per-tenant hash chain of step 2 as later steps use it
 * (`append_entry`, `verify_chain`, plus `head` and `entry_at`). The five languages keep the same
 * keys, so a harness reads one layout whatever the stack.
 */
import {CPP_DIGEST_H} from '../cpp-support';
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'audit/__init__.py': '',
  'audit/digest.py': `"""
Digests (provided). Every digest in auditd is SHA-256 as 64 lower-case hex digits: is_digest tells
one from anything else, and link_digest is one link of a tenant's chain,
sha256(prev | record_digest | position), prev being the link before it ("" before position 1).
"""
import hashlib
import re

DIGEST_RE = re.compile(r"[0-9a-f]{64}")


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def is_digest(value: object) -> bool:
    """A SHA-256 digest as 64 lower-case hex digits."""
    return isinstance(value, str) and DIGEST_RE.fullmatch(value) is not None


def link_digest(prev: str, record_digest: str, position: int) -> str:
    """One link of a chain: sha256(prev | record_digest | position)."""
    return sha256_hex(f"{prev}|{record_digest}|{position}")
`,
  'audit/ledger.py': `"""
The ledger (provided), the course's stand-in for the audit database. A decision record is the Redis
hash audit:rec:{id}: id, tenant, model_version, policy_id, input_digest, decision_digest,
recorded_at (unix ms), position (0 until chained), status (pending, signed or unsigned), signature
and key_id. audit:tenant:{tenant} keeps the tenant's last_recorded_at; audit:signing_queue lists the
records waiting for a receipt; audit:outbox holds the events the broker refused, each a JSON
{topic, key, payload}. A record comes back as a dict, recorded_at and position as ints.
"""
import json

import redis

from audit.digest import sha256_hex

r = redis.Redis(host="redis", port=6379, decode_responses=True)

RECORD_FIELDS = ("tenant", "model_version", "policy_id", "input_digest", "decision_digest", "recorded_at")


def _record(raw: dict) -> dict | None:
    if not raw:
        return None
    return {**raw, "recorded_at": int(raw.get("recorded_at") or 0), "position": int(raw.get("position") or 0)}


def get(record_id: str) -> dict | None:
    """The record, or None."""
    return _record(r.hgetall(f"audit:rec:{record_id}"))


def insert(tenant: str, fields: dict) -> dict:
    """A new record of the tenant holding exactly the given fields (plus id, tenant, position 0, status pending); returns it."""
    record_id = f"d-{r.incr('audit:seq')}"
    mapping = {name: str(value) for name, value in fields.items()}
    mapping.update({"id": record_id, "tenant": tenant, "position": "0", "status": "pending"})
    r.hset(f"audit:rec:{record_id}", mapping=mapping)
    if "recorded_at" in fields:
        r.hset(f"audit:tenant:{tenant}", "last_recorded_at", str(fields["recorded_at"]))
    return get(record_id)


def update(record_id: str, fields: dict) -> dict | None:
    """The corrections writer the old admin console used: overwrites the given fields of a record in place."""
    if not r.exists(f"audit:rec:{record_id}"):
        return None
    if fields:
        r.hset(f"audit:rec:{record_id}", mapping={name: str(value) for name, value in fields.items()})
    return get(record_id)


def last_recorded_at(tenant: str) -> int:
    """The recorded_at of the tenant's newest record (0 before the first)."""
    return int(r.hget(f"audit:tenant:{tenant}", "last_recorded_at") or 0)


def record_digest(record: dict) -> str:
    """The digest the chain holds for a record: its RECORD_FIELDS in order, joined by |."""
    return sha256_hex("|".join(str(record[name]) for name in RECORD_FIELDS))


def set_position(record_id: str, position: int) -> None:
    """Note where the record sits in its tenant's chain."""
    r.hset(f"audit:rec:{record_id}", "position", str(position))


def set_receipt(record_id: str, signature: str, key_id: str) -> None:
    """Keep the signer's receipt: the record is signed."""
    r.hset(f"audit:rec:{record_id}", mapping={"status": "signed", "signature": signature, "key_id": key_id})


def queue_unsigned(record_id: str) -> None:
    """Mark the record unsigned and queue it for the signing worker."""
    r.hset(f"audit:rec:{record_id}", "status", "unsigned")
    r.rpush("audit:signing_queue", record_id)


def insert_outbox(topic: str, key: str, payload: dict) -> None:
    """Keep an event the broker refused, for the relay to publish again."""
    r.rpush("audit:outbox", json.dumps({"topic": topic, "key": key, "payload": payload}))
`,
  'audit/chain.py': `"""
The tenant chains (provided; step 2 builds append_entry and verify_chain the same way). A tenant's
chain is one hash, audit:chain:{tenant}: length (the last position written), head (the link at that
position) and, per position n, rec:{n} (the record digest), link:{n} (link_digest(link:{n-1},
rec:{n}, n), "" before position 1) and id:{n} (the record id). append_entry reads length and head
once, computes the next link and writes it with one Lua compare-and-set that succeeds only while
length is unchanged, retrying when another append got there first. verify_chain walks from a
position to the last one, recomputing every link.
"""
import redis

from audit.digest import link_digest

r = redis.Redis(host="redis", port=6379, decode_responses=True)

MAX_APPEND_ATTEMPTS = 5

APPEND_LUA = """
if (redis.call('HGET', KEYS[1], 'length') or '0') ~= ARGV[1] then return 0 end
local n = tonumber(ARGV[1]) + 1
redis.call('HSET', KEYS[1], 'rec:' .. n, ARGV[2], 'link:' .. n, ARGV[3], 'id:' .. n, ARGV[4], 'head', ARGV[3], 'length', n)
return n
"""
append = r.register_script(APPEND_LUA)


def chain_key(tenant: str) -> str:
    return f"audit:chain:{tenant}"


def append_entry(tenant: str, record_id: str, record_digest: str) -> dict:
    """Chain the record at the tenant's next position: {"position", "digest"} (the link written)."""
    key = chain_key(tenant)
    for _ in range(MAX_APPEND_ATTEMPTS):
        length, head = r.hmget(key, "length", "head")
        length = int(length or 0)
        link = link_digest(head or "", record_digest, length + 1)
        position = append(keys=[key], args=[length, record_digest, link, record_id])
        if position:
            return {"position": int(position), "digest": link}
    raise RuntimeError(f"the chain of {tenant} kept moving: {MAX_APPEND_ATTEMPTS} appends lost the race")


def verify_chain(tenant: str, from_position: int) -> dict:
    """Recompute every link from from_position to the last: {"valid", "chain_length", "first_divergence"}."""
    entries = r.hgetall(chain_key(tenant))
    length = int(entries.get("length") or 0)
    prev = entries.get(f"link:{from_position - 1}", "") if from_position > 1 else ""
    covered = 0
    for n in range(from_position, length + 1):
        rec, link = entries.get(f"rec:{n}"), entries.get(f"link:{n}")
        if rec is None or link is None or link != link_digest(prev, rec, n):
            return {"valid": False, "chain_length": covered, "first_divergence": n}
        prev = link
        covered += 1
    return {"valid": True, "chain_length": covered, "first_divergence": None}


def head(tenant: str) -> dict:
    """The last position written and its link ({"position": 0, "digest": ""} for an empty chain)."""
    length, digest = r.hmget(chain_key(tenant), "length", "head")
    return {"position": int(length or 0), "digest": digest or ""}


def entry_at(tenant: str, position: int) -> dict | None:
    """What the chain holds at a position: {"record_id", "record_digest", "digest"}, or None."""
    record_id, rec, link = r.hmget(chain_key(tenant), f"id:{position}", f"rec:{position}", f"link:{position}")
    if rec is None:
        return None
    return {"record_id": record_id, "record_digest": rec, "digest": link}
`,
};

export const supportModulesTs: Record<string, string> = {
  'audit/digest.ts': `/**
 * Digests (provided). Every digest in auditd is SHA-256 as 64 lower-case hex digits: isDigest tells
 * one from anything else, and linkDigest is one link of a tenant's chain,
 * sha256(prev | recordDigest | position), prev being the link before it ("" before position 1).
 */
import {createHash} from 'node:crypto';

export const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** A SHA-256 digest as 64 lower-case hex digits. */
export const isDigest = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

/** One link of a chain: sha256(prev | recordDigest | position). */
export const linkDigest = (prev: string, recordDigest: string, position: number): string =>
  sha256Hex(\`\${prev}|\${recordDigest}|\${position}\`);
`,
  'audit/ledger.ts': `/**
 * The ledger (provided), the course's stand-in for the audit database. A decision record is the
 * Redis hash audit:rec:{id}: id, tenant, model_version, policy_id, input_digest, decision_digest,
 * recorded_at (unix ms), position (0 until chained), status (pending, signed or unsigned),
 * signature and key_id. audit:tenant:{tenant} keeps the tenant's last_recorded_at;
 * audit:signing_queue lists the records waiting for a receipt; audit:outbox holds the events the
 * broker refused, each a JSON {topic, key, payload}. A Decision has recorded_at and position as numbers.
 */
import Redis from 'ioredis';

import {sha256Hex} from './digest';

const redis = new Redis({host: 'redis', port: 6379});

export const RECORD_FIELDS = ['tenant', 'model_version', 'policy_id', 'input_digest', 'decision_digest', 'recorded_at'] as const;

export interface Decision {
  id: string;
  tenant: string;
  model_version: string;
  policy_id: string;
  input_digest: string;
  decision_digest: string;
  recorded_at: number;
  position: number;
  status: string;
  [field: string]: unknown;
}

const text = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value));

function decision(raw: Record<string, string>): Decision | null {
  if (Object.keys(raw).length === 0) return null;
  return {...raw, recorded_at: Number(raw.recorded_at ?? 0), position: Number(raw.position ?? 0)} as Decision;
}

/** The record, or null. */
export async function get(recordId: string): Promise<Decision | null> {
  return decision(await redis.hgetall(\`audit:rec:\${recordId}\`));
}

/** A new record of the tenant holding exactly the given fields (plus id, tenant, position 0, status pending); returns it. */
export async function insert(tenant: string, fields: Record<string, unknown>): Promise<Decision> {
  const recordId = \`d-\${await redis.incr('audit:seq')}\`;
  const mapping: Record<string, string> = {};
  for (const [name, value] of Object.entries(fields)) mapping[name] = text(value);
  Object.assign(mapping, {id: recordId, tenant, position: '0', status: 'pending'});
  await redis.hset(\`audit:rec:\${recordId}\`, mapping);
  if (fields.recorded_at !== undefined) await redis.hset(\`audit:tenant:\${tenant}\`, 'last_recorded_at', text(fields.recorded_at));
  return (await get(recordId)) as Decision;
}

/** The corrections writer the old admin console used: overwrites the given fields of a record in place. */
export async function update(recordId: string, fields: Record<string, unknown>): Promise<Decision | null> {
  if ((await redis.exists(\`audit:rec:\${recordId}\`)) === 0) return null;
  const mapping: Record<string, string> = {};
  for (const [name, value] of Object.entries(fields)) mapping[name] = text(value);
  if (Object.keys(mapping).length > 0) await redis.hset(\`audit:rec:\${recordId}\`, mapping);
  return get(recordId);
}

/** The recorded_at of the tenant's newest record (0 before the first). */
export async function lastRecordedAt(tenant: string): Promise<number> {
  return Number((await redis.hget(\`audit:tenant:\${tenant}\`, 'last_recorded_at')) ?? 0);
}

/** The digest the chain holds for a record: its RECORD_FIELDS in order, joined by |. */
export function recordDigest(record: Decision): string {
  return sha256Hex(RECORD_FIELDS.map(name => String(record[name])).join('|'));
}

/** Note where the record sits in its tenant's chain. */
export async function setPosition(recordId: string, position: number): Promise<void> {
  await redis.hset(\`audit:rec:\${recordId}\`, 'position', String(position));
}

/** Keep the signer's receipt: the record is signed. */
export async function setReceipt(recordId: string, signature: string, keyId: string): Promise<void> {
  await redis.hset(\`audit:rec:\${recordId}\`, {status: 'signed', signature, key_id: keyId});
}

/** Mark the record unsigned and queue it for the signing worker. */
export async function queueUnsigned(recordId: string): Promise<void> {
  await redis.hset(\`audit:rec:\${recordId}\`, 'status', 'unsigned');
  await redis.rpush('audit:signing_queue', recordId);
}

/** Keep an event the broker refused, for the relay to publish again. */
export async function insertOutbox(topic: string, key: string, payload: Record<string, unknown>): Promise<void> {
  await redis.rpush('audit:outbox', JSON.stringify({topic, key, payload}));
}
`,
  'audit/chain.ts': `/**
 * The tenant chains (provided; step 2 builds appendEntry and verifyChain the same way). A tenant's
 * chain is one hash, audit:chain:{tenant}: length (the last position written), head (the link at
 * that position) and, per position n, rec:{n} (the record digest), link:{n} (linkDigest(link:{n-1},
 * rec:{n}, n), "" before position 1) and id:{n} (the record id). appendEntry reads length and head
 * once, computes the next link and writes it with one Lua compare-and-set that succeeds only while
 * length is unchanged, retrying when another append got there first. verifyChain walks from a
 * position to the last one, recomputing every link.
 */
import Redis from 'ioredis';

import {linkDigest} from './digest';

export const MAX_APPEND_ATTEMPTS = 5;

export const APPEND_LUA = \`
if (redis.call('HGET', KEYS[1], 'length') or '0') ~= ARGV[1] then return 0 end
local n = tonumber(ARGV[1]) + 1
redis.call('HSET', KEYS[1], 'rec:' .. n, ARGV[2], 'link:' .. n, ARGV[3], 'id:' .. n, ARGV[4], 'head', ARGV[3], 'length', n)
return n
\`;

interface ChainRedis extends Redis {
  appendLink(key: string, length: number, recordDigest: string, link: string, recordId: string): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as ChainRedis;
redis.defineCommand('appendLink', {numberOfKeys: 1, lua: APPEND_LUA});

export interface Entry {
  position: number;
  digest: string;
}

export interface Verdict {
  valid: boolean;
  chain_length: number;
  first_divergence: number | null;
}

export const chainKey = (tenant: string): string => \`audit:chain:\${tenant}\`;

/** Chain the record at the tenant's next position: the position and the link written. */
export async function appendEntry(tenant: string, recordId: string, recordDigest: string): Promise<Entry> {
  const key = chainKey(tenant);
  for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt++) {
    const [length, head] = await redis.hmget(key, 'length', 'head');
    const last = Number(length ?? 0);
    const link = linkDigest(head ?? '', recordDigest, last + 1);
    const position = Number(await redis.appendLink(key, last, recordDigest, link, recordId));
    if (position > 0) return {position, digest: link};
  }
  throw new Error(\`the chain of \${tenant} kept moving: \${MAX_APPEND_ATTEMPTS} appends lost the race\`);
}

/** Recompute every link from fromPosition to the last. */
export async function verifyChain(tenant: string, fromPosition: number): Promise<Verdict> {
  const entries = await redis.hgetall(chainKey(tenant));
  const length = Number(entries.length ?? 0);
  let prev = fromPosition > 1 ? (entries[\`link:\${fromPosition - 1}\`] ?? '') : '';
  let covered = 0;
  for (let n = fromPosition; n <= length; n++) {
    const rec = entries[\`rec:\${n}\`];
    const link = entries[\`link:\${n}\`];
    if (rec === undefined || link === undefined || link !== linkDigest(prev, rec, n)) {
      return {valid: false, chain_length: covered, first_divergence: n};
    }
    prev = link;
    covered++;
  }
  return {valid: true, chain_length: covered, first_divergence: null};
}

/** The last position written and its link (position 0, digest "" for an empty chain). */
export async function head(tenant: string): Promise<Entry> {
  const [length, digest] = await redis.hmget(chainKey(tenant), 'length', 'head');
  return {position: Number(length ?? 0), digest: digest ?? ''};
}

/** What the chain holds at a position, or null. */
export async function entryAt(tenant: string, position: number): Promise<{record_id: string; record_digest: string; digest: string} | null> {
  const [recordId, rec, link] = await redis.hmget(chainKey(tenant), \`id:\${position}\`, \`rec:\${position}\`, \`link:\${position}\`);
  if (rec === null) return null;
  return {record_id: recordId ?? '', record_digest: rec, digest: link ?? ''};
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'audit/digest/digest.go': `// Package digest is provided. Every digest in auditd is SHA-256 as 64 lower-case hex digits:
// IsDigest tells one from anything else, and LinkDigest is one link of a tenant's chain,
// sha256(prev | recordDigest | position), prev being the link before it ("" before position 1).
package digest

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
)

var digestRE = regexp.MustCompile(\`^[0-9a-f]{64}$\`)

// Sha256Hex is the SHA-256 of the text in hex.
func Sha256Hex(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

// IsDigest reports whether value is a SHA-256 digest as 64 lower-case hex digits.
func IsDigest(value string) bool {
	return digestRE.MatchString(value)
}

// LinkDigest is one link of a chain: sha256(prev | recordDigest | position).
func LinkDigest(prev, recordDigest string, position int64) string {
	return Sha256Hex(fmt.Sprintf("%s|%s|%d", prev, recordDigest, position))
}
`,
  'audit/ledger/ledger.go': `// Package ledger is provided, the course's stand-in for the audit database. A decision record is
// the Redis hash audit:rec:{id}: id, tenant, model_version, policy_id, input_digest,
// decision_digest, recorded_at (unix ms), position (0 until chained), status (pending, signed or
// unsigned), signature and key_id. audit:tenant:{tenant} keeps the tenant's last_recorded_at;
// audit:signing_queue lists the records waiting for a receipt; audit:outbox holds the events the
// broker refused, each a JSON {topic, key, payload}.
package ledger

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/redis/go-redis/v9"

	"audit/digest"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Decision is one record of the ledger.
type Decision struct {
	ID             string \`json:"id"\`
	Tenant         string \`json:"tenant"\`
	ModelVersion   string \`json:"model_version"\`
	PolicyID       string \`json:"policy_id"\`
	InputDigest    string \`json:"input_digest"\`
	DecisionDigest string \`json:"decision_digest"\`
	RecordedAt     int64  \`json:"recorded_at"\`
	Position       int64  \`json:"position"\`
	Status         string \`json:"status"\`
	Signature      string \`json:"signature,omitempty"\`
	KeyID          string \`json:"key_id,omitempty"\`
}

func text(value any) string {
	if s, ok := value.(string); ok {
		return s
	}
	if f, ok := value.(float64); ok {
		return strconv.FormatFloat(f, 'f', -1, 64)
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return fmt.Sprint(value)
	}
	return string(raw)
}

func decision(raw map[string]string) *Decision {
	if len(raw) == 0 {
		return nil
	}
	recordedAt, _ := strconv.ParseInt(raw["recorded_at"], 10, 64)
	position, _ := strconv.ParseInt(raw["position"], 10, 64)
	return &Decision{
		ID: raw["id"], Tenant: raw["tenant"], ModelVersion: raw["model_version"], PolicyID: raw["policy_id"],
		InputDigest: raw["input_digest"], DecisionDigest: raw["decision_digest"], RecordedAt: recordedAt,
		Position: position, Status: raw["status"], Signature: raw["signature"], KeyID: raw["key_id"],
	}
}

// Get is the record, or nil.
func Get(ctx context.Context, recordID string) *Decision {
	return decision(rdb.HGetAll(ctx, "audit:rec:"+recordID).Val())
}

// Insert writes a new record of the tenant holding exactly the given fields (plus id, tenant,
// position 0, status pending) and returns it.
func Insert(ctx context.Context, tenant string, fields map[string]any) (*Decision, error) {
	recordID := fmt.Sprintf("d-%d", rdb.Incr(ctx, "audit:seq").Val())
	mapping := map[string]any{}
	for name, value := range fields {
		mapping[name] = text(value)
	}
	mapping["id"] = recordID
	mapping["tenant"] = tenant
	mapping["position"] = "0"
	mapping["status"] = "pending"
	if err := rdb.HSet(ctx, "audit:rec:"+recordID, mapping).Err(); err != nil {
		return nil, err
	}
	if recordedAt, ok := fields["recorded_at"]; ok {
		rdb.HSet(ctx, "audit:tenant:"+tenant, "last_recorded_at", text(recordedAt))
	}
	return Get(ctx, recordID), nil
}

// Update is the corrections writer the old admin console used: it overwrites the given fields of a
// record in place; nil when there is no such record.
func Update(ctx context.Context, recordID string, fields map[string]any) *Decision {
	if rdb.Exists(ctx, "audit:rec:"+recordID).Val() == 0 {
		return nil
	}
	mapping := map[string]any{}
	for name, value := range fields {
		mapping[name] = text(value)
	}
	if len(mapping) > 0 {
		rdb.HSet(ctx, "audit:rec:"+recordID, mapping)
	}
	return Get(ctx, recordID)
}

// LastRecordedAt is the recorded_at of the tenant's newest record (0 before the first).
func LastRecordedAt(ctx context.Context, tenant string) int64 {
	n, _ := strconv.ParseInt(rdb.HGet(ctx, "audit:tenant:"+tenant, "last_recorded_at").Val(), 10, 64)
	return n
}

// RecordDigest is the digest the chain holds for a record: tenant, model_version, policy_id,
// input_digest, decision_digest and recorded_at, in that order, joined by |.
func RecordDigest(d *Decision) string {
	fields := []string{d.Tenant, d.ModelVersion, d.PolicyID, d.InputDigest, d.DecisionDigest, strconv.FormatInt(d.RecordedAt, 10)}
	return digest.Sha256Hex(strings.Join(fields, "|"))
}

// SetPosition notes where the record sits in its tenant's chain.
func SetPosition(ctx context.Context, recordID string, position int64) {
	rdb.HSet(ctx, "audit:rec:"+recordID, "position", strconv.FormatInt(position, 10))
}

// SetReceipt keeps the signer's receipt: the record is signed.
func SetReceipt(ctx context.Context, recordID, signature, keyID string) {
	rdb.HSet(ctx, "audit:rec:"+recordID, map[string]any{"status": "signed", "signature": signature, "key_id": keyID})
}

// QueueUnsigned marks the record unsigned and queues it for the signing worker.
func QueueUnsigned(ctx context.Context, recordID string) {
	rdb.HSet(ctx, "audit:rec:"+recordID, "status", "unsigned")
	rdb.RPush(ctx, "audit:signing_queue", recordID)
}

// InsertOutbox keeps an event the broker refused, for the relay to publish again.
func InsertOutbox(ctx context.Context, topic, key string, payload any) error {
	raw, err := json.Marshal(map[string]any{"topic": topic, "key": key, "payload": payload})
	if err != nil {
		return err
	}
	return rdb.RPush(ctx, "audit:outbox", raw).Err()
}
`,
  'audit/chain/chain.go': `// Package chain is the tenant chains (provided; step 2 builds appendEntry and verifyChain the same
// way). A tenant's chain is one hash, audit:chain:{tenant}: length (the last position written), head
// (the link at that position) and, per position n, rec:{n} (the record digest), link:{n}
// (LinkDigest(link:{n-1}, rec:{n}, n), "" before position 1) and id:{n} (the record id).
// AppendEntry reads length and head once, computes the next link and writes it with one Lua
// compare-and-set that succeeds only while length is unchanged, retrying when another append got
// there first. VerifyChain walks from a position to the last one, recomputing every link.
package chain

import (
	"context"
	"fmt"
	"strconv"

	"github.com/redis/go-redis/v9"

	"audit/digest"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// MaxAppendAttempts bounds the compare-and-set retries of one append.
const MaxAppendAttempts = 5

var appendLink = redis.NewScript(\`
if (redis.call('HGET', KEYS[1], 'length') or '0') ~= ARGV[1] then return 0 end
local n = tonumber(ARGV[1]) + 1
redis.call('HSET', KEYS[1], 'rec:' .. n, ARGV[2], 'link:' .. n, ARGV[3], 'id:' .. n, ARGV[4], 'head', ARGV[3], 'length', n)
return n
\`)

// Entry is a position of a chain and the link written there.
type Entry struct {
	Position int64  \`json:"position"\`
	Digest   string \`json:"digest"\`
}

// Verdict is what a walk found: the positions that verified, and the first that did not (nil: none).
type Verdict struct {
	Valid           bool   \`json:"valid"\`
	ChainLength     int64  \`json:"chain_length"\`
	FirstDivergence *int64 \`json:"first_divergence"\`
}

// Link is what the chain holds at a position.
type Link struct {
	RecordID     string \`json:"record_id"\`
	RecordDigest string \`json:"record_digest"\`
	Digest       string \`json:"digest"\`
}

// Key is the hash holding a tenant's chain.
func Key(tenant string) string { return "audit:chain:" + tenant }

func str(v any) string {
	s, _ := v.(string)
	return s
}

// AppendEntry chains the record at the tenant's next position.
func AppendEntry(ctx context.Context, tenant, recordID, recordDigest string) (Entry, error) {
	key := Key(tenant)
	for attempt := 0; attempt < MaxAppendAttempts; attempt++ {
		values, err := rdb.HMGet(ctx, key, "length", "head").Result()
		if err != nil {
			return Entry{}, err
		}
		length, _ := strconv.ParseInt(str(values[0]), 10, 64)
		link := digest.LinkDigest(str(values[1]), recordDigest, length+1)
		position, err := appendLink.Run(ctx, rdb, []string{key}, length, recordDigest, link, recordID).Int64()
		if err != nil {
			return Entry{}, err
		}
		if position > 0 {
			return Entry{Position: position, Digest: link}, nil
		}
	}
	return Entry{}, fmt.Errorf("the chain of %s kept moving: %d appends lost the race", tenant, MaxAppendAttempts)
}

// VerifyChain recomputes every link from fromPosition to the last.
func VerifyChain(ctx context.Context, tenant string, fromPosition int64) (Verdict, error) {
	entries, err := rdb.HGetAll(ctx, Key(tenant)).Result()
	if err != nil {
		return Verdict{}, err
	}
	length, _ := strconv.ParseInt(entries["length"], 10, 64)
	prev := ""
	if fromPosition > 1 {
		prev = entries[fmt.Sprintf("link:%d", fromPosition-1)]
	}
	var covered int64
	for n := fromPosition; n <= length; n++ {
		rec, hasRec := entries[fmt.Sprintf("rec:%d", n)]
		link, hasLink := entries[fmt.Sprintf("link:%d", n)]
		if !hasRec || !hasLink || link != digest.LinkDigest(prev, rec, n) {
			at := n
			return Verdict{Valid: false, ChainLength: covered, FirstDivergence: &at}, nil
		}
		prev = link
		covered++
	}
	return Verdict{Valid: true, ChainLength: covered}, nil
}

// Head is the last position written and its link (position 0, digest "" for an empty chain).
func Head(ctx context.Context, tenant string) (Entry, error) {
	values, err := rdb.HMGet(ctx, Key(tenant), "length", "head").Result()
	if err != nil {
		return Entry{}, err
	}
	length, _ := strconv.ParseInt(str(values[0]), 10, 64)
	return Entry{Position: length, Digest: str(values[1])}, nil
}

// EntryAt is what the chain holds at a position, or nil.
func EntryAt(ctx context.Context, tenant string, position int64) (*Link, error) {
	n := strconv.FormatInt(position, 10)
	values, err := rdb.HMGet(ctx, Key(tenant), "id:"+n, "rec:"+n, "link:"+n).Result()
	if err != nil {
		return nil, err
	}
	if values[1] == nil {
		return nil, nil
	}
	return &Link{RecordID: str(values[0]), RecordDigest: str(values[1]), Digest: str(values[2])}, nil
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'sha256.h': CPP_DIGEST_H,
  'audit/digest.h': `// Digests (provided). Every digest in auditd is SHA-256 as 64 lower-case hex digits: isDigest tells
// one from anything else, and linkDigest is one link of a tenant's chain,
// sha256(prev | record_digest | position), prev being the link before it ("" before position 1).
#pragma once

#include <string>

#include "sha256.h"  // sha256_hex(bytes)

namespace digest {

// A SHA-256 digest as 64 lower-case hex digits.
inline bool isDigest(const std::string& value) {
  if (value.size() != 64) return false;
  for (const char c : value) {
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  }
  return true;
}

// One link of a chain: sha256(prev | record_digest | position).
inline std::string linkDigest(const std::string& prev, const std::string& record_digest, long position) {
  return sha256_hex(prev + "|" + record_digest + "|" + std::to_string(position));
}

}  // namespace digest
`,
  'audit/ledger.h': `// The ledger (provided), the course's stand-in for the audit database. A decision record is the Redis
// hash audit:rec:{id}: id, tenant, model_version, policy_id, input_digest, decision_digest,
// recorded_at (unix ms), position (0 until chained), status (pending, signed or unsigned), signature
// and key_id. audit:tenant:{tenant} keeps the tenant's last_recorded_at; audit:signing_queue lists
// the records waiting for a receipt; audit:outbox holds the events the broker refused, each a JSON
// {topic, key, payload}. Fields are a JSON object, as a request body parses.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <map>
#include <optional>
#include <string>
#include <unordered_map>

#include "sha256.h"  // sha256_hex(bytes)

namespace ledger {

struct Decision {
  std::string id;
  std::string tenant;
  std::string model_version;
  std::string policy_id;
  std::string input_digest;
  std::string decision_digest;
  long long recorded_at = 0;
  long position = 0;
  std::string status;
  std::string signature;
  std::string key_id;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string text(const nlohmann::json& value) { return value.is_string() ? value.get<std::string>() : value.dump(); }

// The record, or none.
inline std::optional<Decision> get(const std::string& record_id) {
  std::unordered_map<std::string, std::string> raw;
  redis().hgetall("audit:rec:" + record_id, std::inserter(raw, raw.begin()));
  if (raw.empty()) return std::nullopt;
  const auto field = [&raw](const char* name) { return raw.count(name) ? raw.at(name) : std::string(); };
  Decision d;
  d.id = field("id");
  d.tenant = field("tenant");
  d.model_version = field("model_version");
  d.policy_id = field("policy_id");
  d.input_digest = field("input_digest");
  d.decision_digest = field("decision_digest");
  d.recorded_at = field("recorded_at").empty() ? 0 : std::stoll(field("recorded_at"));
  d.position = field("position").empty() ? 0 : std::stol(field("position"));
  d.status = field("status");
  d.signature = field("signature");
  d.key_id = field("key_id");
  return d;
}

// The record as the API answers it.
inline nlohmann::json toJson(const Decision& d) {
  nlohmann::json out = {{"id", d.id}, {"tenant", d.tenant}, {"model_version", d.model_version}, {"policy_id", d.policy_id},
                        {"input_digest", d.input_digest}, {"decision_digest", d.decision_digest}, {"recorded_at", d.recorded_at},
                        {"position", d.position}, {"status", d.status}};
  if (!d.signature.empty()) out["signature"] = d.signature;
  if (!d.key_id.empty()) out["key_id"] = d.key_id;
  return out;
}

// A new record of the tenant holding exactly the given fields (plus id, tenant, position 0, status
// pending); returns it.
inline Decision insert(const std::string& tenant, const nlohmann::json& fields) {
  const std::string record_id = "d-" + std::to_string(redis().incr("audit:seq"));
  std::map<std::string, std::string> mapping;
  for (const auto& [name, value] : fields.items()) mapping[name] = text(value);
  mapping["id"] = record_id;
  mapping["tenant"] = tenant;
  mapping["position"] = "0";
  mapping["status"] = "pending";
  redis().hset("audit:rec:" + record_id, mapping.begin(), mapping.end());
  if (fields.contains("recorded_at")) redis().hset("audit:tenant:" + tenant, "last_recorded_at", text(fields["recorded_at"]));
  return *get(record_id);
}

// The corrections writer the old admin console used: overwrites the given fields of a record in
// place; none when there is no such record.
inline std::optional<Decision> update(const std::string& record_id, const nlohmann::json& fields) {
  if (redis().exists("audit:rec:" + record_id) == 0) return std::nullopt;
  std::map<std::string, std::string> mapping;
  for (const auto& [name, value] : fields.items()) mapping[name] = text(value);
  if (!mapping.empty()) redis().hset("audit:rec:" + record_id, mapping.begin(), mapping.end());
  return get(record_id);
}

// The recorded_at of the tenant's newest record (0 before the first).
inline long long lastRecordedAt(const std::string& tenant) {
  const auto value = redis().hget("audit:tenant:" + tenant, "last_recorded_at");
  return value && !value->empty() ? std::stoll(*value) : 0;
}

// The digest the chain holds for a record: tenant, model_version, policy_id, input_digest,
// decision_digest and recorded_at, in that order, joined by |.
inline std::string recordDigest(const Decision& d) {
  return sha256_hex(d.tenant + "|" + d.model_version + "|" + d.policy_id + "|" + d.input_digest + "|" + d.decision_digest + "|" +
                    std::to_string(d.recorded_at));
}

// Note where the record sits in its tenant's chain.
inline void setPosition(const std::string& record_id, long position) {
  redis().hset("audit:rec:" + record_id, "position", std::to_string(position));
}

// Keep the signer's receipt: the record is signed.
inline void setReceipt(const std::string& record_id, const std::string& signature, const std::string& key_id) {
  redis().hset("audit:rec:" + record_id, {std::make_pair(std::string("status"), std::string("signed")),
                                          std::make_pair(std::string("signature"), signature),
                                          std::make_pair(std::string("key_id"), key_id)});
}

// Mark the record unsigned and queue it for the signing worker.
inline void queueUnsigned(const std::string& record_id) {
  redis().hset("audit:rec:" + record_id, "status", "unsigned");
  redis().rpush("audit:signing_queue", record_id);
}

// Keep an event the broker refused, for the relay to publish again.
inline void insertOutbox(const std::string& topic, const std::string& key, const nlohmann::json& payload) {
  redis().rpush("audit:outbox", nlohmann::json{{"topic", topic}, {"key", key}, {"payload", payload}}.dump());
}

}  // namespace ledger
`,
  'audit/chain.h': `// The tenant chains (provided; step 2 builds appendEntry and verifyChain the same way). A tenant's
// chain is one hash, audit:chain:{tenant}: length (the last position written), head (the link at
// that position) and, per position n, rec:{n} (the record digest), link:{n} (linkDigest(link:{n-1},
// rec:{n}, n), "" before position 1) and id:{n} (the record id). appendEntry reads length and head
// once, computes the next link and writes it with one Lua compare-and-set that succeeds only while
// length is unchanged, retrying when another append got there first. verifyChain walks from a
// position to the last one, recomputing every link.
#pragma once

#include <sw/redis++/redis++.h>

#include <iterator>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

#include "audit/digest.h"  // digest::linkDigest

namespace chain {

struct Entry {
  long position = 0;
  std::string digest;
};

// What a walk found: the positions that verified, and the first that did not (none: every one did).
struct Verdict {
  bool valid = true;
  long chain_length = 0;
  std::optional<long> first_divergence;
};

// What the chain holds at a position.
struct Link {
  std::string record_id;
  std::string record_digest;
  std::string digest;
};

constexpr int kMaxAppendAttempts = 5;

inline const std::string kAppendLua = R"lua(
if (redis.call('HGET', KEYS[1], 'length') or '0') ~= ARGV[1] then return 0 end
local n = tonumber(ARGV[1]) + 1
redis.call('HSET', KEYS[1], 'rec:' .. n, ARGV[2], 'link:' .. n, ARGV[3], 'id:' .. n, ARGV[4], 'head', ARGV[3], 'length', n)
return n
)lua";

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string chainKey(const std::string& tenant) { return "audit:chain:" + tenant; }

// Chain the record at the tenant's next position: the position and the link written.
inline Entry appendEntry(const std::string& tenant, const std::string& record_id, const std::string& record_digest) {
  const std::string key = chainKey(tenant);
  for (int attempt = 0; attempt < kMaxAppendAttempts; attempt++) {
    std::vector<sw::redis::OptionalString> values;
    redis().hmget(key, {"length", "head"}, std::back_inserter(values));
    const long length = values[0] ? std::stol(*values[0]) : 0;
    const std::string link = digest::linkDigest(values[1] ? *values[1] : "", record_digest, length + 1);
    const long long position = redis().eval<long long>(kAppendLua, {key}, {std::to_string(length), record_digest, link, record_id});
    if (position > 0) return Entry{static_cast<long>(position), link};
  }
  throw std::runtime_error("the chain of " + tenant + " kept moving: every append lost the race");
}

// Recompute every link from from_position to the last.
inline Verdict verifyChain(const std::string& tenant, long from_position) {
  std::unordered_map<std::string, std::string> entries;
  redis().hgetall(chainKey(tenant), std::inserter(entries, entries.begin()));
  const long length = entries.count("length") ? std::stol(entries.at("length")) : 0;
  std::string prev;
  if (from_position > 1 && entries.count("link:" + std::to_string(from_position - 1))) prev = entries.at("link:" + std::to_string(from_position - 1));
  Verdict verdict;
  for (long n = from_position; n <= length; n++) {
    const auto rec = entries.find("rec:" + std::to_string(n));
    const auto link = entries.find("link:" + std::to_string(n));
    if (rec == entries.end() || link == entries.end() || link->second != digest::linkDigest(prev, rec->second, n)) {
      verdict.valid = false;
      verdict.first_divergence = n;
      return verdict;
    }
    prev = link->second;
    verdict.chain_length++;
  }
  return verdict;
}

// The last position written and its link (position 0, digest "" for an empty chain).
inline Entry head(const std::string& tenant) {
  std::vector<sw::redis::OptionalString> values;
  redis().hmget(chainKey(tenant), {"length", "head"}, std::back_inserter(values));
  return Entry{values[0] ? std::stol(*values[0]) : 0, values[1] ? *values[1] : ""};
}

// What the chain holds at a position, or none.
inline std::optional<Link> entryAt(const std::string& tenant, long position) {
  const std::string n = std::to_string(position);
  std::vector<sw::redis::OptionalString> values;
  redis().hmget(chainKey(tenant), {"id:" + n, "rec:" + n, "link:" + n}, std::back_inserter(values));
  if (!values[1]) return std::nullopt;
  return Link{values[0] ? *values[0] : "", *values[1], values[2] ? *values[2] : ""};
}

}  // namespace chain
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('audit', 'Digest')]: `package audit

import java.nio.charset.StandardCharsets
import java.security.MessageDigest

/**
 * Digests (provided). Every digest in auditd is SHA-256 as 64 lower-case hex digits: isDigest tells
 * one from anything else, and linkDigest is one link of a tenant's chain,
 * sha256(prev | recordDigest | position), prev being the link before it ("" before position 1).
 */
object Digest {
  private val DigestRe = "[0-9a-f]{64}".r

  def sha256Hex(text: String): String =
    MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)).map(b => f"\${b & 0xff}%02x").mkString

  /** A SHA-256 digest as 64 lower-case hex digits. */
  def isDigest(value: String): Boolean = value != null && DigestRe.matches(value)

  /** One link of a chain: sha256(prev | recordDigest | position). */
  def linkDigest(prev: String, recordDigest: String, position: Long): String = sha256Hex(s"$prev|$recordDigest|$position")
}
`,
  [scalaPath('audit', 'Ledger')]: `package audit

import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

/**
 * The ledger (provided), the course's stand-in for the audit database. A decision record is the
 * Redis hash audit:rec:{id}: id, tenant, model_version, policy_id, input_digest, decision_digest,
 * recorded_at (unix ms), position (0 until chained), status (pending, signed or unsigned),
 * signature and key_id. audit:tenant:{tenant} keeps the tenant's last_recorded_at;
 * audit:signing_queue lists the records waiting for a receipt; audit:outbox holds the events the
 * broker refused, each a JSON {topic, key, payload}. Fields are field name to text.
 */
object Ledger {
  final case class Decision(
      id: String,
      tenant: String,
      modelVersion: String,
      policyId: String,
      inputDigest: String,
      decisionDigest: String,
      recordedAt: Long,
      position: Long,
      status: String,
      signature: Option[String],
      keyId: Option[String]
  )

  val jedis = new JedisPooled("redis", 6379)

  private def decision(raw: Map[String, String]): Option[Decision] =
    if (raw.isEmpty) None
    else {
      def field(name: String): String = raw.getOrElse(name, "")
      def number(name: String): Long = raw.get(name).filter(_.nonEmpty).map(_.toLong).getOrElse(0L)
      Some(Decision(field("id"), field("tenant"), field("model_version"), field("policy_id"), field("input_digest"),
        field("decision_digest"), number("recorded_at"), number("position"), field("status"),
        raw.get("signature").filter(_.nonEmpty), raw.get("key_id").filter(_.nonEmpty)))
    }

  /** The record, if it exists. */
  def get(recordId: String): Option[Decision] = decision(jedis.hgetAll(s"audit:rec:$recordId").asScala.toMap)

  /** The record as the API answers it. */
  def toJson(d: Decision): JsObject = JsObject(
    Map[String, JsValue](
      "id" -> JsString(d.id), "tenant" -> JsString(d.tenant), "model_version" -> JsString(d.modelVersion),
      "policy_id" -> JsString(d.policyId), "input_digest" -> JsString(d.inputDigest),
      "decision_digest" -> JsString(d.decisionDigest), "recorded_at" -> JsNumber(d.recordedAt),
      "position" -> JsNumber(d.position), "status" -> JsString(d.status)
    ) ++ d.signature.map(s => "signature" -> JsString(s)) ++ d.keyId.map(k => "key_id" -> JsString(k))
  )

  /** A new record of the tenant holding exactly the given fields (plus id, tenant, position 0, status pending); returns it. */
  def insert(tenant: String, fields: Map[String, String]): Decision = {
    val recordId = s"d-\${jedis.incr("audit:seq")}"
    val mapping = fields ++ Map("id" -> recordId, "tenant" -> tenant, "position" -> "0", "status" -> "pending")
    jedis.hset(s"audit:rec:$recordId", mapping.asJava)
    fields.get("recorded_at").foreach(at => jedis.hset(s"audit:tenant:$tenant", "last_recorded_at", at))
    get(recordId).get
  }

  /** The corrections writer the old admin console used: overwrites the given fields of a record in place. */
  def update(recordId: String, fields: Map[String, String]): Option[Decision] =
    if (!jedis.exists(s"audit:rec:$recordId")) None
    else {
      if (fields.nonEmpty) jedis.hset(s"audit:rec:$recordId", fields.asJava)
      get(recordId)
    }

  /** The recorded_at of the tenant's newest record (0 before the first). */
  def lastRecordedAt(tenant: String): Long =
    Option(jedis.hget(s"audit:tenant:$tenant", "last_recorded_at")).filter(_.nonEmpty).map(_.toLong).getOrElse(0L)

  /** The digest the chain holds for a record: tenant, model_version, policy_id, input_digest, decision_digest, recorded_at, joined by |. */
  def recordDigest(d: Decision): String =
    Digest.sha256Hex(Seq(d.tenant, d.modelVersion, d.policyId, d.inputDigest, d.decisionDigest, d.recordedAt.toString).mkString("|"))

  /** Note where the record sits in its tenant's chain. */
  def setPosition(recordId: String, position: Long): Unit = jedis.hset(s"audit:rec:$recordId", "position", position.toString)

  /** Keep the signer's receipt: the record is signed. */
  def setReceipt(recordId: String, signature: String, keyId: String): Unit =
    jedis.hset(s"audit:rec:$recordId", Map("status" -> "signed", "signature" -> signature, "key_id" -> keyId).asJava)

  /** Mark the record unsigned and queue it for the signing worker. */
  def queueUnsigned(recordId: String): Unit = {
    jedis.hset(s"audit:rec:$recordId", "status", "unsigned")
    jedis.rpush("audit:signing_queue", recordId)
  }

  /** Keep an event the broker refused, for the relay to publish again. */
  def insertOutbox(topic: String, key: String, payload: JsObject): Unit =
    jedis.rpush("audit:outbox", JsObject("topic" -> JsString(topic), "key" -> JsString(key), "payload" -> payload).compactPrint)
}
`,
  [scalaPath('audit', 'Chain')]: `package audit

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
 * The tenant chains (provided; step 2 builds appendEntry and verifyChain the same way). A tenant's
 * chain is one hash, audit:chain:{tenant}: length (the last position written), head (the link at
 * that position) and, per position n, rec:{n} (the record digest), link:{n} (linkDigest(link:{n-1},
 * rec:{n}, n), "" before position 1) and id:{n} (the record id). appendEntry reads length and head
 * once, computes the next link and writes it with one Lua compare-and-set that succeeds only while
 * length is unchanged, retrying when another append got there first. verifyChain walks from a
 * position to the last one, recomputing every link.
 */
object Chain {
  final case class Entry(position: Long, digest: String)
  final case class Verdict(valid: Boolean, chainLength: Long, firstDivergence: Option[Long])
  final case class Link(recordId: String, recordDigest: String, digest: String)

  val jedis = new JedisPooled("redis", 6379)

  val MaxAppendAttempts = 5

  val AppendLua: String =
    """if (redis.call('HGET', KEYS[1], 'length') or '0') ~= ARGV[1] then return 0 end
      |local n = tonumber(ARGV[1]) + 1
      |redis.call('HSET', KEYS[1], 'rec:' .. n, ARGV[2], 'link:' .. n, ARGV[3], 'id:' .. n, ARGV[4], 'head', ARGV[3], 'length', n)
      |return n
      |""".stripMargin

  def chainKey(tenant: String): String = s"audit:chain:$tenant"

  /** Chain the record at the tenant's next position: the position and the link written. */
  def appendEntry(tenant: String, recordId: String, recordDigest: String): Entry = {
    val key = chainKey(tenant)
    for (_ <- 1 to MaxAppendAttempts) {
      val values = jedis.hmget(key, "length", "head").asScala
      val length = Option(values(0)).map(_.toLong).getOrElse(0L)
      val link = Digest.linkDigest(Option(values(1)).getOrElse(""), recordDigest, length + 1)
      val position = jedis.eval(AppendLua, List(key).asJava, List(length.toString, recordDigest, link, recordId).asJava).asInstanceOf[java.lang.Long]
      if (position > 0) return Entry(position, link)
    }
    throw new IllegalStateException(s"the chain of $tenant kept moving: $MaxAppendAttempts appends lost the race")
  }

  /** Recompute every link from fromPosition to the last. */
  def verifyChain(tenant: String, fromPosition: Long): Verdict = {
    val entries = jedis.hgetAll(chainKey(tenant)).asScala.toMap
    val length = entries.get("length").map(_.toLong).getOrElse(0L)
    var prev = if (fromPosition > 1) entries.getOrElse(s"link:\${fromPosition - 1}", "") else ""
    var covered = 0L
    for (n <- fromPosition to length) {
      val ok = (entries.get(s"rec:$n"), entries.get(s"link:$n")) match {
        case (Some(rec), Some(link)) => link == Digest.linkDigest(prev, rec, n)
        case _ => false
      }
      if (!ok) return Verdict(valid = false, covered, Some(n))
      prev = entries(s"link:$n")
      covered += 1
    }
    Verdict(valid = true, covered, None)
  }

  /** The last position written and its link (position 0, digest "" for an empty chain). */
  def head(tenant: String): Entry = {
    val values = jedis.hmget(chainKey(tenant), "length", "head").asScala
    Entry(Option(values(0)).map(_.toLong).getOrElse(0L), Option(values(1)).getOrElse(""))
  }

  /** What the chain holds at a position, if anything. */
  def entryAt(tenant: String, position: Long): Option[Link] = {
    val values = jedis.hmget(chainKey(tenant), s"id:$position", s"rec:$position", s"link:$position").asScala
    Option(values(1)).map(rec => Link(Option(values(0)).getOrElse(""), rec, Option(values(2)).getOrElse("")))
  }
}
`,
};
