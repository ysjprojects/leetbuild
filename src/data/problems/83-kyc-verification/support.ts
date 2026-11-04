/**
 * Hand-written support modules the kyc-verification steps import but no step builds: the `kyc`
 * package. `kyc.cases` is the case store (every case a Redis hash, the course's stand-in for the
 * decision database): create, load, decide, look up by applicant. `kyc.storage` is document
 * storage: objects with their digests, a fetch log, permanent URLs and expiring signed links.
 * `kyc.intake` is the intake state of step 2 as later steps use it: `reserve_attempt` (one Lua
 * script) and `open_case` (SET NX). The five languages keep the same keys, so a harness reads one
 * layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'kyc/__init__.py': '',
  'kyc/cases.py': `"""
The case store (provided): every verification case is a Redis hash kyc:case:{case_id} with
case_id, tenant, applicant, status (pending, approved, rejected or manual_review), reasons (the
vendor's reason codes, comma-joined), degraded ("1" when the vendor failed and a person decides
instead) and documents (JSON: [{type, ref, digest}]). kyc:applicants:{applicant} maps each tenant
to that applicant's newest case. A case is returned as a dict: reasons a list, degraded a bool,
documents a list. decide appends "status:reasons:degraded" to the audit list kyc:audit:{case_id};
a decided case (approved or rejected) stops being the applicant's active case.
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

STATUSES = ("pending", "approved", "rejected", "manual_review")


def case_key(case_id: str) -> str:
    return f"kyc:case:{case_id}"


def _case(raw: dict) -> dict | None:
    if not raw:
        return None
    return {
        "case_id": raw["case_id"],
        "tenant": raw["tenant"],
        "applicant": raw["applicant"],
        "status": raw["status"],
        "reasons": [code for code in raw.get("reasons", "").split(",") if code],
        "degraded": raw.get("degraded") == "1",
        "documents": json.loads(raw.get("documents") or "[]"),
    }


def new_id() -> str:
    """A fresh case id: c-1, c-2, ..."""
    return f"c-{r.incr('kyc:case:seq')}"


def create(case_id: str, tenant: str, applicant: str, documents: list[dict]) -> dict:
    """Write case case_id as pending with its documents ({type, ref, digest}); it becomes the applicant's newest case in the tenant."""
    r.hset(
        case_key(case_id),
        mapping={"case_id": case_id, "tenant": tenant, "applicant": applicant, "status": "pending", "reasons": "", "degraded": "0", "documents": json.dumps(documents)},
    )
    r.hset(f"kyc:applicants:{applicant}", tenant, case_id)
    return load(case_id)


def load(case_id: str) -> dict | None:
    """The case, or None."""
    return _case(r.hgetall(case_key(case_id)))


def decide(case_id: str, status: str, reasons: list[str], degraded: bool) -> dict:
    """Record the decision on the case (status, the vendor's reason codes, degraded) and return the case."""
    case = load(case_id)
    if case is None:
        raise KeyError(case_id)
    if status not in STATUSES:
        raise ValueError(f"unknown status {status!r}")
    r.hset(case_key(case_id), mapping={"status": status, "reasons": ",".join(reasons), "degraded": "1" if degraded else "0"})
    r.rpush(f"kyc:audit:{case_id}", f"{status}:{','.join(reasons)}:{'1' if degraded else '0'}")
    active = f"kyc:active:{case['tenant']}:{case['applicant']}"
    if status in ("approved", "rejected") and r.get(active) == case_id:
        r.delete(active)
    return load(case_id)


def lookup(tenant: str, applicant: str) -> dict | None:
    """The applicant's newest case in the tenant, or None."""
    case_id = r.hget(f"kyc:applicants:{applicant}", tenant)
    return load(case_id) if case_id else None


def lookup_any(applicant: str) -> dict | None:
    """The support console's lookup: the newest case with this applicant reference in any tenant, or None."""
    ids = r.hvals(f"kyc:applicants:{applicant}")
    if not ids:
        return None
    return load(max(ids, key=lambda case_id: int(case_id.split("-")[1])))
`,
  'kyc/storage.py': `"""
Document storage (provided): every object is a Redis hash storage:object:{ref} with its content and
its digest (sha256 of the content, computed at upload). fetch downloads an object and logs the ref
in the list storage:fetches. url is an object's permanent address; sign hands out a link that
resolves for ttl_s seconds (storage:link:{token}, expiring in Redis) with its expires_at (epoch
seconds); resolve answers the ref a URL still reaches, or None.
"""
import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

BASE = "https://storage.kycd.internal"


def put(ref: str, content: str, digest: str) -> None:
    """Upload an object (the applicant app does this before submitting)."""
    r.hset(f"storage:object:{ref}", mapping={"content": content, "digest": digest})


def fetch(ref: str) -> dict | None:
    """Download the object: {ref, content, digest}, or None when there is none."""
    r.rpush("storage:fetches", ref)
    raw = r.hgetall(f"storage:object:{ref}")
    return {"ref": ref, "content": raw["content"], "digest": raw["digest"]} if raw else None


def url(ref: str) -> str:
    """The object's permanent address."""
    return f"{BASE}/o/{ref}"


def sign(ref: str, ttl_s: int) -> dict:
    """A link to the object that resolves for ttl_s seconds: {url, expires_at}."""
    token = f"l-{r.incr('storage:link:seq')}"
    r.set(f"storage:link:{token}", ref, ex=ttl_s)
    return {"url": f"{BASE}/l/{token}", "expires_at": int(time.time()) + ttl_s}


def resolve(link: str) -> str | None:
    """The ref the URL reaches now, or None."""
    if link.startswith(f"{BASE}/o/"):
        ref = link[len(BASE) + 3 :]
        return ref if r.exists(f"storage:object:{ref}") else None
    if link.startswith(f"{BASE}/l/"):
        return r.get(f"storage:link:{link[len(BASE) + 3 :]}")
    return None
`,
  'kyc/intake.py': `"""
Intake state (provided; step 2 builds the same two functions). kyc:attempts:{tenant}:{applicant}
counts an applicant's submissions in a window of ATTEMPT_WINDOW_S seconds, moved by one Lua script:
reserve_attempt answers (True, 0) for a reservation and (False, seconds until the window ends) past
MAX_ATTEMPTS. kyc:active:{tenant}:{applicant} names the applicant's open case: open_case claims it
with SET NX, so two submissions converge on one case, and answers (case_id, created).
"""
import redis

from kyc import cases

r = redis.Redis(host="redis", port=6379, decode_responses=True)

MAX_ATTEMPTS = 4
ATTEMPT_WINDOW_S = 3600

RESERVE_LUA = """
local n = tonumber(redis.call('GET', KEYS[1]) or '0')
if n >= tonumber(ARGV[1]) then return {0, redis.call('TTL', KEYS[1])} end
n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
return {1, redis.call('TTL', KEYS[1])}
"""
reserve = r.register_script(RESERVE_LUA)


def attempts_key(tenant: str, applicant: str) -> str:
    return f"kyc:attempts:{tenant}:{applicant}"


def active_key(tenant: str, applicant: str) -> str:
    return f"kyc:active:{tenant}:{applicant}"


def reserve_attempt(tenant: str, applicant: str) -> tuple[bool, int]:
    """(True, 0) when the attempt is reserved; (False, seconds until the window ends) past the cap."""
    allowed, ttl = reserve(keys=[attempts_key(tenant, applicant)], args=[MAX_ATTEMPTS, ATTEMPT_WINDOW_S])
    return (True, 0) if allowed == 1 else (False, max(int(ttl), 1))


def open_case(tenant: str, applicant: str, documents: list[dict]) -> tuple[str, bool]:
    """The applicant's open case: (case_id, True) when this call opened it, (case_id, False) when one was open."""
    case_id = cases.new_id()
    if not r.set(active_key(tenant, applicant), case_id, nx=True):
        return r.get(active_key(tenant, applicant)), False
    cases.create(case_id, tenant, applicant, documents)
    return case_id, True
`,
};

export const supportModulesTs: Record<string, string> = {
  'kyc/cases.ts': `/**
 * The case store (provided): every verification case is a Redis hash kyc:case:{case_id} with
 * case_id, tenant, applicant, status (pending, approved, rejected or manual_review), reasons (the
 * vendor's reason codes, comma-joined), degraded ("1" when the vendor failed and a person decides
 * instead) and documents (JSON: [{type, ref, digest}]). kyc:applicants:{applicant} maps each tenant
 * to that applicant's newest case. decide appends "status:reasons:degraded" to the audit list
 * kyc:audit:{case_id}; a decided case (approved or rejected) stops being the applicant's active case.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const STATUSES = ['pending', 'approved', 'rejected', 'manual_review'];

export interface Document {
  type: string;
  ref: string;
  digest: string;
}

export interface Case {
  case_id: string;
  tenant: string;
  applicant: string;
  status: string;
  reasons: string[];
  degraded: boolean;
  documents: Document[];
}

export const caseKey = (caseId: string): string => \`kyc:case:\${caseId}\`;

function toCase(raw: Record<string, string>): Case | null {
  if (Object.keys(raw).length === 0) return null;
  return {
    case_id: raw.case_id,
    tenant: raw.tenant,
    applicant: raw.applicant,
    status: raw.status,
    reasons: (raw.reasons ?? '').split(',').filter(code => code !== ''),
    degraded: raw.degraded === '1',
    documents: JSON.parse(raw.documents || '[]') as Document[],
  };
}

/** A fresh case id: c-1, c-2, ... */
export async function newId(): Promise<string> {
  return \`c-\${await redis.incr('kyc:case:seq')}\`;
}

/** Write case caseId as pending with its documents; it becomes the applicant's newest case in the tenant. */
export async function create(caseId: string, tenant: string, applicant: string, documents: Document[]): Promise<Case> {
  await redis.hset(caseKey(caseId), {
    case_id: caseId,
    tenant,
    applicant,
    status: 'pending',
    reasons: '',
    degraded: '0',
    documents: JSON.stringify(documents),
  });
  await redis.hset(\`kyc:applicants:\${applicant}\`, tenant, caseId);
  return (await load(caseId)) as Case;
}

/** The case, or null. */
export async function load(caseId: string): Promise<Case | null> {
  return toCase(await redis.hgetall(caseKey(caseId)));
}

/** Record the decision on the case (status, the vendor's reason codes, degraded) and return the case. */
export async function decide(caseId: string, status: string, reasons: string[], degraded: boolean): Promise<Case> {
  const current = await load(caseId);
  if (current === null) throw new Error(\`no case \${caseId}\`);
  if (!STATUSES.includes(status)) throw new Error(\`unknown status \${status}\`);
  await redis.hset(caseKey(caseId), {status, reasons: reasons.join(','), degraded: degraded ? '1' : '0'});
  await redis.rpush(\`kyc:audit:\${caseId}\`, \`\${status}:\${reasons.join(',')}:\${degraded ? '1' : '0'}\`);
  const active = \`kyc:active:\${current.tenant}:\${current.applicant}\`;
  if ((status === 'approved' || status === 'rejected') && (await redis.get(active)) === caseId) await redis.del(active);
  return (await load(caseId)) as Case;
}

/** The applicant's newest case in the tenant, or null. */
export async function lookup(tenant: string, applicant: string): Promise<Case | null> {
  const caseId = await redis.hget(\`kyc:applicants:\${applicant}\`, tenant);
  return caseId ? load(caseId) : null;
}

/** The support console's lookup: the newest case with this applicant reference in any tenant, or null. */
export async function lookupAny(applicant: string): Promise<Case | null> {
  const ids = await redis.hvals(\`kyc:applicants:\${applicant}\`);
  if (ids.length === 0) return null;
  const newest = ids.reduce((a, b) => (Number(b.split('-')[1]) > Number(a.split('-')[1]) ? b : a));
  return load(newest);
}
`,
  'kyc/storage.ts': `/**
 * Document storage (provided): every object is a Redis hash storage:object:{ref} with its content
 * and its digest (sha256 of the content, computed at upload). fetch downloads an object and logs the
 * ref in the list storage:fetches. url is an object's permanent address; sign hands out a link that
 * resolves for ttlS seconds (storage:link:{token}, expiring in Redis) with its expires_at (epoch
 * seconds); resolve answers the ref a URL still reaches, or null.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const BASE = 'https://storage.kycd.internal';

export interface StoredObject {
  ref: string;
  content: string;
  digest: string;
}

export interface SignedLink {
  url: string;
  expires_at: number;
}

/** Upload an object (the applicant app does this before submitting). */
export async function put(ref: string, content: string, digest: string): Promise<void> {
  await redis.hset(\`storage:object:\${ref}\`, {content, digest});
}

/** Download the object, or null when there is none. */
export async function fetch(ref: string): Promise<StoredObject | null> {
  await redis.rpush('storage:fetches', ref);
  const raw = await redis.hgetall(\`storage:object:\${ref}\`);
  return Object.keys(raw).length === 0 ? null : {ref, content: raw.content, digest: raw.digest};
}

/** The object's permanent address. */
export const url = (ref: string): string => \`\${BASE}/o/\${ref}\`;

/** A link to the object that resolves for ttlS seconds. */
export async function sign(ref: string, ttlS: number): Promise<SignedLink> {
  const token = \`l-\${await redis.incr('storage:link:seq')}\`;
  await redis.set(\`storage:link:\${token}\`, ref, 'EX', ttlS);
  return {url: \`\${BASE}/l/\${token}\`, expires_at: Math.floor(Date.now() / 1000) + ttlS};
}

/** The ref the URL reaches now, or null. */
export async function resolve(link: string): Promise<string | null> {
  if (link.startsWith(\`\${BASE}/o/\`)) {
    const ref = link.slice(BASE.length + 3);
    return (await redis.exists(\`storage:object:\${ref}\`)) === 1 ? ref : null;
  }
  if (link.startsWith(\`\${BASE}/l/\`)) return redis.get(\`storage:link:\${link.slice(BASE.length + 3)}\`);
  return null;
}
`,
  'kyc/intake.ts': `/**
 * Intake state (provided; step 2 builds the same two functions). kyc:attempts:{tenant}:{applicant}
 * counts an applicant's submissions in a window of ATTEMPT_WINDOW_S seconds, moved by one Lua
 * script: reserveAttempt answers {allowed: true, retryAfterS: 0} for a reservation and
 * {allowed: false, retryAfterS: seconds until the window ends} past MAX_ATTEMPTS.
 * kyc:active:{tenant}:{applicant} names the applicant's open case: openCase claims it with SET NX,
 * so two submissions converge on one case, and answers {caseId, created}.
 */
import Redis from 'ioredis';

import {type Document, create, newId} from './cases';

export const MAX_ATTEMPTS = 4;
export const ATTEMPT_WINDOW_S = 3600;

export const RESERVE_LUA = \`
local n = tonumber(redis.call('GET', KEYS[1]) or '0')
if n >= tonumber(ARGV[1]) then return {0, redis.call('TTL', KEYS[1])} end
n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
return {1, redis.call('TTL', KEYS[1])}
\`;

interface IntakeRedis extends Redis {
  reserve(key: string, cap: number, windowS: number): Promise<[number, number]>;
}

const redis = new Redis({host: 'redis', port: 6379}) as IntakeRedis;
redis.defineCommand('reserve', {numberOfKeys: 1, lua: RESERVE_LUA});

export const attemptsKey = (tenant: string, applicant: string): string => \`kyc:attempts:\${tenant}:\${applicant}\`;
export const activeKey = (tenant: string, applicant: string): string => \`kyc:active:\${tenant}:\${applicant}\`;

export interface Reservation {
  allowed: boolean;
  retryAfterS: number;
}

/** {allowed: true, retryAfterS: 0} when the attempt is reserved; past the cap, the seconds until the window ends. */
export async function reserveAttempt(tenant: string, applicant: string): Promise<Reservation> {
  const [allowed, ttl] = await redis.reserve(attemptsKey(tenant, applicant), MAX_ATTEMPTS, ATTEMPT_WINDOW_S);
  return allowed === 1 ? {allowed: true, retryAfterS: 0} : {allowed: false, retryAfterS: Math.max(Number(ttl), 1)};
}

export interface Opened {
  caseId: string;
  created: boolean;
}

/** The applicant's open case: created when this call opened it, not when one was open. */
export async function openCase(tenant: string, applicant: string, documents: Document[]): Promise<Opened> {
  const caseId = await newId();
  if ((await redis.set(activeKey(tenant, applicant), caseId, 'NX')) === null) {
    return {caseId: (await redis.get(activeKey(tenant, applicant))) as string, created: false};
  }
  await create(caseId, tenant, applicant, documents);
  return {caseId, created: true};
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'kyc/cases/cases.go': `// Package cases is the case store (provided): every verification case is a Redis hash
// kyc:case:{case_id} with case_id, tenant, applicant, status (pending, approved, rejected or
// manual_review), reasons (the vendor's reason codes, comma-joined), degraded ("1" when the vendor
// failed and a person decides instead) and documents (JSON: [{type, ref, digest}]).
// kyc:applicants:{applicant} maps each tenant to that applicant's newest case. Decide appends
// "status:reasons:degraded" to the audit list kyc:audit:{case_id}; a decided case (approved or
// rejected) stops being the applicant's active case.
package cases

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Statuses a case can have.
var Statuses = []string{"pending", "approved", "rejected", "manual_review"}

// Document is one document of a case.
type Document struct {
	Type   string \`json:"type"\`
	Ref    string \`json:"ref"\`
	Digest string \`json:"digest"\`
}

// Case is one verification case.
type Case struct {
	CaseID    string     \`json:"case_id"\`
	Tenant    string     \`json:"tenant"\`
	Applicant string     \`json:"applicant"\`
	Status    string     \`json:"status"\`
	Reasons   []string   \`json:"reasons"\`
	Degraded  bool       \`json:"degraded"\`
	Documents []Document \`json:"documents"\`
}

// CaseKey is the hash of a case.
func CaseKey(caseID string) string { return "kyc:case:" + caseID }

func toCase(raw map[string]string) *Case {
	if len(raw) == 0 {
		return nil
	}
	c := &Case{CaseID: raw["case_id"], Tenant: raw["tenant"], Applicant: raw["applicant"], Status: raw["status"], Reasons: []string{}, Degraded: raw["degraded"] == "1", Documents: []Document{}}
	for _, code := range strings.Split(raw["reasons"], ",") {
		if code != "" {
			c.Reasons = append(c.Reasons, code)
		}
	}
	if raw["documents"] != "" {
		json.Unmarshal([]byte(raw["documents"]), &c.Documents)
	}
	return c
}

// NewID is a fresh case id: c-1, c-2, ...
func NewID(ctx context.Context) string {
	return fmt.Sprintf("c-%d", rdb.Incr(ctx, "kyc:case:seq").Val())
}

// Create writes case caseID as pending with its documents; it becomes the applicant's newest case in the tenant.
func Create(ctx context.Context, caseID, tenant, applicant string, documents []Document) *Case {
	docs, _ := json.Marshal(documents)
	rdb.HSet(ctx, CaseKey(caseID), map[string]any{"case_id": caseID, "tenant": tenant, "applicant": applicant, "status": "pending", "reasons": "", "degraded": "0", "documents": string(docs)})
	rdb.HSet(ctx, "kyc:applicants:"+applicant, tenant, caseID)
	return Load(ctx, caseID)
}

// Load is the case, or nil.
func Load(ctx context.Context, caseID string) *Case {
	return toCase(rdb.HGetAll(ctx, CaseKey(caseID)).Val())
}

// Decide records the decision on the case (status, the vendor's reason codes, degraded) and returns the case.
func Decide(ctx context.Context, caseID, status string, reasons []string, degraded bool) (*Case, error) {
	current := Load(ctx, caseID)
	if current == nil {
		return nil, fmt.Errorf("no case %s", caseID)
	}
	known := false
	for _, s := range Statuses {
		known = known || s == status
	}
	if !known {
		return nil, fmt.Errorf("unknown status %q", status)
	}
	flag := "0"
	if degraded {
		flag = "1"
	}
	rdb.HSet(ctx, CaseKey(caseID), map[string]any{"status": status, "reasons": strings.Join(reasons, ","), "degraded": flag})
	rdb.RPush(ctx, "kyc:audit:"+caseID, status+":"+strings.Join(reasons, ",")+":"+flag)
	active := "kyc:active:" + current.Tenant + ":" + current.Applicant
	if (status == "approved" || status == "rejected") && rdb.Get(ctx, active).Val() == caseID {
		rdb.Del(ctx, active)
	}
	return Load(ctx, caseID), nil
}

// Lookup is the applicant's newest case in the tenant, or nil.
func Lookup(ctx context.Context, tenant, applicant string) *Case {
	caseID, err := rdb.HGet(ctx, "kyc:applicants:"+applicant, tenant).Result()
	if err != nil {
		return nil
	}
	return Load(ctx, caseID)
}

// LookupAny is the support console's lookup: the newest case with this applicant reference in any tenant, or nil.
func LookupAny(ctx context.Context, applicant string) *Case {
	newest, best := "", -1
	for _, caseID := range rdb.HVals(ctx, "kyc:applicants:"+applicant).Val() {
		n, _ := strconv.Atoi(strings.TrimPrefix(caseID, "c-"))
		if n > best {
			newest, best = caseID, n
		}
	}
	if newest == "" {
		return nil
	}
	return Load(ctx, newest)
}
`,
  'kyc/storage/storage.go': `// Package storage is document storage (provided): every object is a Redis hash
// storage:object:{ref} with its content and its digest (sha256 of the content, computed at upload).
// Fetch downloads an object and logs the ref in the list storage:fetches. URL is an object's
// permanent address; Sign hands out a link that resolves for ttlS seconds (storage:link:{token},
// expiring in Redis) with its expires_at (epoch seconds); Resolve answers the ref a URL still
// reaches.
package storage

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Base is where storage serves objects and links.
const Base = "https://storage.kycd.internal"

// Object is a downloaded object.
type Object struct {
	Ref     string \`json:"ref"\`
	Content string \`json:"content"\`
	Digest  string \`json:"digest"\`
}

// Link is a signed link and when it stops resolving.
type Link struct {
	URL       string \`json:"url"\`
	ExpiresAt int64  \`json:"expires_at"\`
}

// Put uploads an object (the applicant app does this before submitting).
func Put(ctx context.Context, ref, content, digest string) {
	rdb.HSet(ctx, "storage:object:"+ref, map[string]any{"content": content, "digest": digest})
}

// Fetch downloads the object, or nil when there is none.
func Fetch(ctx context.Context, ref string) *Object {
	rdb.RPush(ctx, "storage:fetches", ref)
	raw := rdb.HGetAll(ctx, "storage:object:"+ref).Val()
	if len(raw) == 0 {
		return nil
	}
	return &Object{Ref: ref, Content: raw["content"], Digest: raw["digest"]}
}

// URL is the object's permanent address.
func URL(ref string) string { return Base + "/o/" + ref }

// Sign is a link to the object that resolves for ttlS seconds.
func Sign(ctx context.Context, ref string, ttlS int) Link {
	token := fmt.Sprintf("l-%d", rdb.Incr(ctx, "storage:link:seq").Val())
	rdb.Set(ctx, "storage:link:"+token, ref, time.Duration(ttlS)*time.Second)
	return Link{URL: Base + "/l/" + token, ExpiresAt: time.Now().Unix() + int64(ttlS)}
}

// Resolve is the ref the URL reaches now, and whether it reaches one.
func Resolve(ctx context.Context, link string) (string, bool) {
	if ref, ok := strings.CutPrefix(link, Base+"/o/"); ok {
		return ref, rdb.Exists(ctx, "storage:object:"+ref).Val() == 1
	}
	if token, ok := strings.CutPrefix(link, Base+"/l/"); ok {
		ref, err := rdb.Get(ctx, "storage:link:"+token).Result()
		return ref, err == nil
	}
	return "", false
}
`,
  'kyc/intake/intake.go': `// Package intake is the intake state (provided; step 2 builds the same two functions).
// kyc:attempts:{tenant}:{applicant} counts an applicant's submissions in a window of
// AttemptWindowS seconds, moved by one Lua script: ReserveAttempt answers (true, 0) for a
// reservation and (false, seconds until the window ends) past MaxAttempts.
// kyc:active:{tenant}:{applicant} names the applicant's open case: OpenCase claims it with SET NX,
// so two submissions converge on one case, and answers (caseID, created).
package intake

import (
	"context"

	"github.com/redis/go-redis/v9"

	"kyc/cases"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	MaxAttempts    = 4
	AttemptWindowS = 3600
)

// Reserve reserves an attempt if the count is under ARGV[1]; the window (ARGV[2]) starts with the first.
var Reserve = redis.NewScript(\`
local n = tonumber(redis.call('GET', KEYS[1]) or '0')
if n >= tonumber(ARGV[1]) then return {0, redis.call('TTL', KEYS[1])} end
n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
return {1, redis.call('TTL', KEYS[1])}
\`)

func AttemptsKey(tenant, applicant string) string { return "kyc:attempts:" + tenant + ":" + applicant }
func ActiveKey(tenant, applicant string) string   { return "kyc:active:" + tenant + ":" + applicant }

// ReserveAttempt is (true, 0) when the attempt is reserved; past the cap, (false, seconds until the window ends).
func ReserveAttempt(ctx context.Context, tenant, applicant string) (bool, int64, error) {
	reply, err := Reserve.Run(ctx, rdb, []string{AttemptsKey(tenant, applicant)}, MaxAttempts, AttemptWindowS).Int64Slice()
	if err != nil {
		return false, 0, err
	}
	if reply[0] == 1 {
		return true, 0, nil
	}
	return false, max(reply[1], 1), nil
}

// OpenCase is the applicant's open case: created when this call opened it, not when one was open.
func OpenCase(ctx context.Context, tenant, applicant string, documents []cases.Document) (string, bool, error) {
	caseID := cases.NewID(ctx)
	claimed, err := rdb.SetNX(ctx, ActiveKey(tenant, applicant), caseID, 0).Result()
	if err != nil {
		return "", false, err
	}
	if !claimed {
		existing, err := rdb.Get(ctx, ActiveKey(tenant, applicant)).Result()
		return existing, false, err
	}
	cases.Create(ctx, caseID, tenant, applicant, documents)
	return caseID, true, nil
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'kyc/cases.h': `// The case store (provided): every verification case is a Redis hash kyc:case:{case_id} with
// case_id, tenant, applicant, status (pending, approved, rejected or manual_review), reasons (the
// vendor's reason codes, comma-joined), degraded ("1" when the vendor failed and a person decides
// instead) and documents (JSON: [{type, ref, digest}]). kyc:applicants:{applicant} maps each tenant
// to that applicant's newest case. decide appends "status:reasons:degraded" to the audit list
// kyc:audit:{case_id}; a decided case (approved or rejected) stops being the applicant's active case.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <iterator>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

namespace cases {

struct Document {
  std::string type;
  std::string ref;
  std::string digest;
};

struct Case {
  std::string case_id;
  std::string tenant;
  std::string applicant;
  std::string status;
  std::vector<std::string> reasons;
  bool degraded = false;
  std::vector<Document> documents;
};

inline const std::vector<std::string> kStatuses = {"pending", "approved", "rejected", "manual_review"};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string caseKey(const std::string& case_id) { return "kyc:case:" + case_id; }

inline nlohmann::json documentsJson(const std::vector<Document>& documents) {
  nlohmann::json out = nlohmann::json::array();
  for (const Document& d : documents) out.push_back({{"type", d.type}, {"ref", d.ref}, {"digest", d.digest}});
  return out;
}

inline std::optional<Case> load(const std::string& case_id) {
  std::unordered_map<std::string, std::string> raw;
  redis().hgetall(caseKey(case_id), std::inserter(raw, raw.begin()));
  if (raw.empty()) return std::nullopt;
  Case c;
  c.case_id = raw["case_id"];
  c.tenant = raw["tenant"];
  c.applicant = raw["applicant"];
  c.status = raw["status"];
  c.degraded = raw["degraded"] == "1";
  std::string reasons = raw["reasons"];
  size_t start = 0;
  while (start < reasons.size()) {
    size_t comma = reasons.find(',', start);
    if (comma == std::string::npos) comma = reasons.size();
    if (comma > start) c.reasons.push_back(reasons.substr(start, comma - start));
    start = comma + 1;
  }
  if (!raw["documents"].empty()) {
    for (const auto& d : nlohmann::json::parse(raw["documents"])) {
      c.documents.push_back({d.value("type", ""), d.value("ref", ""), d.value("digest", "")});
    }
  }
  return c;
}

// A fresh case id: c-1, c-2, ...
inline std::string newId() { return "c-" + std::to_string(redis().incr("kyc:case:seq")); }

// Write case case_id as pending with its documents; it becomes the applicant's newest case in the tenant.
inline Case create(const std::string& case_id, const std::string& tenant, const std::string& applicant,
                   const std::vector<Document>& documents) {
  redis().hset(caseKey(case_id), {std::make_pair(std::string("case_id"), case_id), std::make_pair(std::string("tenant"), tenant),
                                  std::make_pair(std::string("applicant"), applicant), std::make_pair(std::string("status"), std::string("pending")),
                                  std::make_pair(std::string("reasons"), std::string()), std::make_pair(std::string("degraded"), std::string("0")),
                                  std::make_pair(std::string("documents"), documentsJson(documents).dump())});
  redis().hset("kyc:applicants:" + applicant, tenant, case_id);
  return *load(case_id);
}

// Record the decision on the case (status, the vendor's reason codes, degraded) and return the case.
inline Case decide(const std::string& case_id, const std::string& status, const std::vector<std::string>& reasons, bool degraded) {
  const auto current = load(case_id);
  if (!current) throw std::out_of_range("no case " + case_id);
  if (std::find(kStatuses.begin(), kStatuses.end(), status) == kStatuses.end()) throw std::invalid_argument("unknown status " + status);
  std::string joined;
  for (const std::string& code : reasons) joined += (joined.empty() ? "" : ",") + code;
  redis().hset(caseKey(case_id), {std::make_pair(std::string("status"), status), std::make_pair(std::string("reasons"), joined),
                                  std::make_pair(std::string("degraded"), std::string(degraded ? "1" : "0"))});
  redis().rpush("kyc:audit:" + case_id, status + ":" + joined + ":" + (degraded ? "1" : "0"));
  const std::string active = "kyc:active:" + current->tenant + ":" + current->applicant;
  if ((status == "approved" || status == "rejected") && redis().get(active).value_or("") == case_id) redis().del(active);
  return *load(case_id);
}

// The applicant's newest case in the tenant, or none.
inline std::optional<Case> lookup(const std::string& tenant, const std::string& applicant) {
  const auto case_id = redis().hget("kyc:applicants:" + applicant, tenant);
  return case_id ? load(*case_id) : std::nullopt;
}

// The support console's lookup: the newest case with this applicant reference in any tenant, or none.
inline std::optional<Case> lookupAny(const std::string& applicant) {
  std::vector<std::string> ids;
  redis().hvals("kyc:applicants:" + applicant, std::back_inserter(ids));
  std::string newest;
  long best = -1;
  for (const std::string& id : ids) {
    const long n = std::stol(id.substr(2));
    if (n > best) {
      best = n;
      newest = id;
    }
  }
  return newest.empty() ? std::nullopt : load(newest);
}

}  // namespace cases
`,
  'kyc/storage.h': `// Document storage (provided): every object is a Redis hash storage:object:{ref} with its content
// and its digest (sha256 of the content, computed at upload). fetch downloads an object and logs the
// ref in the list storage:fetches. url is an object's permanent address; sign hands out a link that
// resolves for ttl_s seconds (storage:link:{token}, expiring in Redis) with its expires_at (epoch
// seconds); resolve answers the ref a URL still reaches.
#pragma once

#include <sw/redis++/redis++.h>

#include <chrono>
#include <iterator>
#include <optional>
#include <string>
#include <unordered_map>

namespace storage {

inline const std::string kBase = "https://storage.kycd.internal";

struct Object {
  std::string ref;
  std::string content;
  std::string digest;
};

struct Link {
  std::string url;
  long long expires_at = 0;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// Upload an object (the applicant app does this before submitting).
inline void put(const std::string& ref, const std::string& content, const std::string& digest) {
  redis().hset("storage:object:" + ref, {std::make_pair(std::string("content"), content), std::make_pair(std::string("digest"), digest)});
}

// Download the object, or none when there is none.
inline std::optional<Object> fetch(const std::string& ref) {
  redis().rpush("storage:fetches", ref);
  std::unordered_map<std::string, std::string> raw;
  redis().hgetall("storage:object:" + ref, std::inserter(raw, raw.begin()));
  if (raw.empty()) return std::nullopt;
  return Object{ref, raw["content"], raw["digest"]};
}

// The object's permanent address.
inline std::string url(const std::string& ref) { return kBase + "/o/" + ref; }

// A link to the object that resolves for ttl_s seconds.
inline Link sign(const std::string& ref, long ttl_s) {
  const std::string token = "l-" + std::to_string(redis().incr("storage:link:seq"));
  redis().set("storage:link:" + token, ref, std::chrono::seconds(ttl_s));
  const long long now = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  return Link{kBase + "/l/" + token, now + ttl_s};
}

// The ref the URL reaches now, or none.
inline std::optional<std::string> resolve(const std::string& link) {
  const std::string object = kBase + "/o/";
  const std::string signed_link = kBase + "/l/";
  if (link.rfind(object, 0) == 0) {
    const std::string ref = link.substr(object.size());
    return redis().exists("storage:object:" + ref) == 1 ? std::optional<std::string>(ref) : std::nullopt;
  }
  if (link.rfind(signed_link, 0) == 0) {
    const auto ref = redis().get("storage:link:" + link.substr(signed_link.size()));
    return ref ? std::optional<std::string>(*ref) : std::nullopt;
  }
  return std::nullopt;
}

}  // namespace storage
`,
  'kyc/intake.h': `// Intake state (provided; step 2 builds the same two functions). kyc:attempts:{tenant}:{applicant}
// counts an applicant's submissions in a window of kAttemptWindowS seconds, moved by one Lua
// script: reserveAttempt answers {true, 0} for a reservation and {false, seconds until the window
// ends} past kMaxAttempts. kyc:active:{tenant}:{applicant} names the applicant's open case:
// openCase claims it with SET NX, so two submissions converge on one case, and answers
// {case_id, created}.
#pragma once

#include <sw/redis++/redis++.h>

#include <algorithm>
#include <chrono>
#include <string>
#include <vector>

#include "kyc/cases.h"

namespace intake {

constexpr long kMaxAttempts = 4;
constexpr long kAttemptWindowS = 3600;

inline const std::string kReserveLua = R"lua(
local n = tonumber(redis.call('GET', KEYS[1]) or '0')
if n >= tonumber(ARGV[1]) then return {0, redis.call('TTL', KEYS[1])} end
n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
return {1, redis.call('TTL', KEYS[1])}
)lua";

struct Reservation {
  bool allowed = false;
  long long retry_after_s = 0;
};

struct Opened {
  std::string case_id;
  bool created = false;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string attemptsKey(const std::string& tenant, const std::string& applicant) { return "kyc:attempts:" + tenant + ":" + applicant; }
inline std::string activeKey(const std::string& tenant, const std::string& applicant) { return "kyc:active:" + tenant + ":" + applicant; }

// {true, 0} when the attempt is reserved; past the cap, {false, seconds until the window ends}.
inline Reservation reserveAttempt(const std::string& tenant, const std::string& applicant) {
  const auto reply = redis().eval<std::vector<long long>>(kReserveLua, {attemptsKey(tenant, applicant)},
                                                          {std::to_string(kMaxAttempts), std::to_string(kAttemptWindowS)});
  if (reply.at(0) == 1) return {true, 0};
  return {false, std::max(reply.at(1), 1LL)};
}

// The applicant's open case: created when this call opened it, not when one was open.
inline Opened openCase(const std::string& tenant, const std::string& applicant, const std::vector<cases::Document>& documents) {
  const std::string case_id = cases::newId();
  if (!redis().set(activeKey(tenant, applicant), case_id, std::chrono::milliseconds(0), sw::redis::UpdateType::NOT_EXIST)) {
    return {redis().get(activeKey(tenant, applicant)).value_or(""), false};
  }
  cases::create(case_id, tenant, applicant, documents);
  return {case_id, true};
}

}  // namespace intake
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('kyc', 'Cases')]: `package kyc

import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

/**
 * The case store (provided): every verification case is a Redis hash kyc:case:{case_id} with
 * case_id, tenant, applicant, status (pending, approved, rejected or manual_review), reasons (the
 * vendor's reason codes, comma-joined), degraded ("1" when the vendor failed and a person decides
 * instead) and documents (JSON: [{type, ref, digest}]). kyc:applicants:{applicant} maps each tenant
 * to that applicant's newest case. decide appends "status:reasons:degraded" to the audit list
 * kyc:audit:{case_id}; a decided case (approved or rejected) stops being the applicant's active case.
 */
object Cases {
  final case class Document(documentType: String, ref: String, digest: String)
  final case class Case(caseId: String, tenant: String, applicant: String, status: String, reasons: Seq[String], degraded: Boolean, documents: Seq[Document])

  val Statuses: Seq[String] = Seq("pending", "approved", "rejected", "manual_review")

  val jedis = new JedisPooled("redis", 6379)

  def caseKey(caseId: String): String = s"kyc:case:$caseId"

  def documentsJson(documents: Seq[Document]): JsArray =
    JsArray(documents.map(d => JsObject("type" -> JsString(d.documentType), "ref" -> JsString(d.ref), "digest" -> JsString(d.digest))).toVector)

  private def toCase(raw: Map[String, String]): Option[Case] =
    if (raw.isEmpty) None
    else {
      val documents = raw.get("documents").filter(_.nonEmpty).map(_.parseJson) match {
        case Some(JsArray(items)) =>
          items.map { item =>
            val f = item.asJsObject.fields
            def text(name: String): String = f.get(name).collect { case JsString(s) => s }.getOrElse("")
            Document(text("type"), text("ref"), text("digest"))
          }
        case _ => Vector.empty
      }
      Some(Case(raw("case_id"), raw("tenant"), raw("applicant"), raw("status"), raw.getOrElse("reasons", "").split(",").toSeq.filter(_.nonEmpty), raw.get("degraded").contains("1"), documents))
    }

  /** A fresh case id: c-1, c-2, ... */
  def newId(): String = s"c-\${jedis.incr("kyc:case:seq")}"

  /** Write case caseId as pending with its documents; it becomes the applicant's newest case in the tenant. */
  def create(caseId: String, tenant: String, applicant: String, documents: Seq[Document]): Case = {
    jedis.hset(caseKey(caseId), Map("case_id" -> caseId, "tenant" -> tenant, "applicant" -> applicant, "status" -> "pending", "reasons" -> "", "degraded" -> "0", "documents" -> documentsJson(documents).compactPrint).asJava)
    jedis.hset(s"kyc:applicants:$applicant", tenant, caseId)
    load(caseId).get
  }

  /** The case, if there is one. */
  def load(caseId: String): Option[Case] = toCase(jedis.hgetAll(caseKey(caseId)).asScala.toMap)

  /** Record the decision on the case (status, the vendor's reason codes, degraded) and return the case. */
  def decide(caseId: String, status: String, reasons: Seq[String], degraded: Boolean): Case = {
    val current = load(caseId).getOrElse(throw new NoSuchElementException(s"no case $caseId"))
    require(Statuses.contains(status), s"unknown status $status")
    jedis.hset(caseKey(caseId), Map("status" -> status, "reasons" -> reasons.mkString(","), "degraded" -> (if (degraded) "1" else "0")).asJava)
    jedis.rpush(s"kyc:audit:$caseId", s"$status:\${reasons.mkString(",")}:\${if (degraded) "1" else "0"}")
    val active = s"kyc:active:\${current.tenant}:\${current.applicant}"
    if ((status == "approved" || status == "rejected") && jedis.get(active) == caseId) jedis.del(active)
    load(caseId).get
  }

  /** The applicant's newest case in the tenant. */
  def lookup(tenant: String, applicant: String): Option[Case] =
    Option(jedis.hget(s"kyc:applicants:$applicant", tenant)).flatMap(load)

  /** The support console's lookup: the newest case with this applicant reference in any tenant. */
  def lookupAny(applicant: String): Option[Case] = {
    val ids = jedis.hvals(s"kyc:applicants:$applicant").asScala.toSeq
    if (ids.isEmpty) None else load(ids.maxBy(_.stripPrefix("c-").toLong))
  }
}
`,
  [scalaPath('kyc', 'Storage')]: `package kyc

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
 * Document storage (provided): every object is a Redis hash storage:object:{ref} with its content
 * and its digest (sha256 of the content, computed at upload). fetch downloads an object and logs the
 * ref in the list storage:fetches. url is an object's permanent address; sign hands out a link that
 * resolves for ttlS seconds (storage:link:{token}, expiring in Redis) with its expires_at (epoch
 * seconds); resolve answers the ref a URL still reaches.
 */
object Storage {
  final case class StoredObject(ref: String, content: String, digest: String)
  final case class Link(url: String, expiresAt: Long)

  val Base = "https://storage.kycd.internal"

  val jedis = new JedisPooled("redis", 6379)

  /** Upload an object (the applicant app does this before submitting). */
  def put(ref: String, content: String, digest: String): Unit =
    jedis.hset(s"storage:object:$ref", Map("content" -> content, "digest" -> digest).asJava)

  /** Download the object, if there is one. */
  def fetch(ref: String): Option[StoredObject] = {
    jedis.rpush("storage:fetches", ref)
    val raw = jedis.hgetAll(s"storage:object:$ref").asScala
    if (raw.isEmpty) None else Some(StoredObject(ref, raw("content"), raw("digest")))
  }

  /** The object's permanent address. */
  def url(ref: String): String = s"$Base/o/$ref"

  /** A link to the object that resolves for ttlS seconds. */
  def sign(ref: String, ttlS: Long): Link = {
    val token = s"l-\${jedis.incr("storage:link:seq")}"
    jedis.setex(s"storage:link:$token", ttlS, ref)
    Link(s"$Base/l/$token", System.currentTimeMillis() / 1000 + ttlS)
  }

  /** The ref the URL reaches now. */
  def resolve(link: String): Option[String] =
    if (link.startsWith(s"$Base/o/")) Some(link.stripPrefix(s"$Base/o/")).filter(ref => jedis.exists(s"storage:object:$ref"))
    else if (link.startsWith(s"$Base/l/")) Option(jedis.get(s"storage:link:\${link.stripPrefix(s"$Base/l/")}"))
    else None
}
`,
  [scalaPath('kyc', 'Intake')]: `package kyc

import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

import scala.jdk.CollectionConverters._

/**
 * Intake state (provided; step 2 builds the same two functions). kyc:attempts:{tenant}:{applicant}
 * counts an applicant's submissions in a window of AttemptWindowS seconds, moved by one Lua script:
 * reserveAttempt answers (true, 0) for a reservation and (false, seconds until the window ends) past
 * MaxAttempts. kyc:active:{tenant}:{applicant} names the applicant's open case: openCase claims it
 * with SET NX, so two submissions converge on one case, and answers (caseId, created).
 */
object Intake {
  val MaxAttempts = 4
  val AttemptWindowS = 3600

  val ReserveLua: String =
    """local n = tonumber(redis.call('GET', KEYS[1]) or '0')
      |if n >= tonumber(ARGV[1]) then return {0, redis.call('TTL', KEYS[1])} end
      |n = redis.call('INCR', KEYS[1])
      |if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
      |return {1, redis.call('TTL', KEYS[1])}
      |""".stripMargin

  val jedis = new JedisPooled("redis", 6379)

  def attemptsKey(tenant: String, applicant: String): String = s"kyc:attempts:$tenant:$applicant"
  def activeKey(tenant: String, applicant: String): String = s"kyc:active:$tenant:$applicant"

  /** (true, 0) when the attempt is reserved; past the cap, (false, seconds until the window ends). */
  def reserveAttempt(tenant: String, applicant: String): (Boolean, Long) = {
    val reply = jedis.eval(ReserveLua, List(attemptsKey(tenant, applicant)).asJava, List(MaxAttempts.toString, AttemptWindowS.toString).asJava)
      .asInstanceOf[java.util.List[java.lang.Long]].asScala.map(_.longValue)
    if (reply.head == 1L) (true, 0L) else (false, math.max(reply(1), 1L))
  }

  /** The applicant's open case: created when this call opened it, not when one was open. */
  def openCase(tenant: String, applicant: String, documents: Seq[Cases.Document]): (String, Boolean) = {
    val caseId = Cases.newId()
    if (jedis.set(activeKey(tenant, applicant), caseId, SetParams.setParams().nx()) == null) (jedis.get(activeKey(tenant, applicant)), false)
    else {
      Cases.create(caseId, tenant, applicant, documents)
      (caseId, true)
    }
  }
}
`,
};
