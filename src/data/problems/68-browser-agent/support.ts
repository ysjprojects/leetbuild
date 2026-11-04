/**
 * Hand-written support modules the browser-agent steps import but no step builds: the `browser`
 * package. `profiles` is the server's egress catalog and the one navigation check; `sessions` the
 * session documents in Redis (browser:session:{id}) and the Idempotency-Key records; `lease` the
 * step-lease transition of step 2 as the later steps use it; `trace` the step record, the target
 * digest and the trace store (browser:trace:{id}) the consumer of step 4 fills and the read of
 * step 5 serves; `screenshots` the screenshot references. The five languages keep the same keys, so
 * a harness reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'browser/__init__.py': '',
  'browser/profiles.py': `"""
The egress profiles (provided): the server's catalog of where a session's browser may go. A profile
names the schemes and hosts its browser may reach ("*.example.com" matches any subdomain, a bare
host only itself) and the entry point a session starts at. authorize_navigation is the one check
every navigation goes through: the reason the URL is refused, or "" when the profile allows it.
"""

EGRESS_PROFILES = {
    "public-web": {
        "name": "public-web",
        "schemes": ["https"],
        "hosts": ["example.com", "*.example.com", "*.wikipedia.org"],
        "entry": "https://www.example.com/",
    },
    "docs-only": {
        "name": "docs-only",
        "schemes": ["https"],
        "hosts": ["*.readthedocs.io"],
        "entry": "https://docs.readthedocs.io/",
    },
}


def get_profile(name: str) -> dict | None:
    """The profile called name, or None when the catalog has none."""
    return EGRESS_PROFILES.get(name)


def split_url(url: str) -> tuple[str, str]:
    """(scheme, host) of an absolute URL, lower-cased; ("", "") when it is not one."""
    scheme, sep, rest = url.partition("://")
    if not sep or not scheme:
        return "", ""
    for stop in "/?#":
        rest = rest.split(stop, 1)[0]
    host = rest.rsplit("@", 1)[-1].split(":", 1)[0]
    return scheme.lower(), host.lower()


def host_allowed(patterns: list[str], host: str) -> bool:
    for pattern in patterns:
        if pattern.startswith("*.") and host.endswith(pattern[1:]):
            return True
        if host == pattern:
            return True
    return False


def authorize_navigation(profile: dict, url: str) -> str:
    """Why profile refuses url, or "" when its browser may go there."""
    scheme, host = split_url(url)
    if not host:
        return "not an absolute URL"
    if scheme not in profile["schemes"]:
        return f"scheme {scheme} is not in profile {profile['name']}"
    if not host_allowed(profile["hosts"], host):
        return f"host {host} is not in profile {profile['name']}"
    return ""
`,
  'browser/sessions.py': `"""
The session documents (provided): browser:session:{id} is one hash per session with session_id,
tenant, profile, task, current_url, page_digest, step_index, max_steps, budget_remaining and status
(running or budget_exhausted). browser:idem:{tenant}:{key} holds the session an Idempotency-Key
started. Session ids are s-1, s-2, … from the browser:seq:session counter.
"""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

INT_FIELDS = ("step_index", "max_steps", "budget_remaining")
VIEW_FIELDS = ("session_id", "profile", "current_url", "step_index", "max_steps", "budget_remaining", "status")


def session_key(session_id: str) -> str:
    return f"browser:session:{session_id}"


def idempotency_key(tenant: str, key: str) -> str:
    return f"browser:idem:{tenant}:{key}"


def create_session(tenant: str, profile: str, task: str, max_steps: int, current_url: str) -> dict:
    """A new running session at current_url with max_steps of budget; returns it."""
    session_id = f"s-{r.incr('browser:seq:session')}"
    r.hset(
        session_key(session_id),
        mapping={
            "session_id": session_id,
            "tenant": tenant,
            "profile": profile,
            "task": task,
            "current_url": current_url,
            "page_digest": "",
            "step_index": 0,
            "max_steps": max_steps,
            "budget_remaining": max_steps,
            "status": "running",
        },
    )
    return load_session(session_id)


def load_session(session_id: str) -> dict | None:
    """The session (its counters as ints), or None."""
    raw = r.hgetall(session_key(session_id))
    if not raw:
        return None
    return {**raw, **{name: int(raw[name]) for name in INT_FIELDS}}


def session_for_key(tenant: str, key: str) -> str | None:
    """The session the tenant's Idempotency-Key started, if any."""
    return r.get(idempotency_key(tenant, key))


def remember_key(tenant: str, key: str, session_id: str) -> None:
    r.set(idempotency_key(tenant, key), session_id)


def record_page(session_id: str, url: str, digest: str) -> None:
    """The page the session's browser is on now."""
    r.hset(session_key(session_id), mapping={"current_url": url, "page_digest": digest})


def public_view(session: dict) -> dict:
    """What a client sees of a session."""
    return {name: session[name] for name in VIEW_FIELDS}
`,
  'browser/lease.py': `"""
The step lease (provided; step 2 builds the same function): begin_step takes or refreshes worker's
lease on a session (browser:lease:{id}, a 45-second TTL) and charges one step of its budget in one
Lua script. It returns the new step index, or LEASE_HELD (another worker's lease is live),
BUDGET_EXHAUSTED (the session's status becomes budget_exhausted) or NO_SESSION.
"""
import redis

from browser.sessions import session_key

r = redis.Redis(host="redis", port=6379, decode_responses=True)

LEASE_TTL_MS = 45_000
LEASE_HELD = -1
BUDGET_EXHAUSTED = -2
NO_SESSION = -3

BEGIN_STEP_LUA = """
if redis.call('EXISTS', KEYS[1]) == 0 then return -3 end
local owner = redis.call('GET', KEYS[2])
if owner and owner ~= ARGV[1] then return -1 end
if tonumber(redis.call('HGET', KEYS[1], 'budget_remaining')) <= 0 then
  redis.call('HSET', KEYS[1], 'status', 'budget_exhausted')
  return -2
end
redis.call('SET', KEYS[2], ARGV[1], 'PX', ARGV[2])
redis.call('HINCRBY', KEYS[1], 'budget_remaining', -1)
return redis.call('HINCRBY', KEYS[1], 'step_index', 1)
"""
begin = r.register_script(BEGIN_STEP_LUA)


def lease_key(session_id: str) -> str:
    return f"browser:lease:{session_id}"


def begin_step(session_id: str, worker: str) -> int:
    return int(begin(keys=[session_key(session_id), lease_key(session_id)], args=[worker, LEASE_TTL_MS]))
`,
  'browser/trace.py': `"""
The step trace (provided). A step, as run_action (step 3) returns it, is a dict with session_id,
step_index, action (navigate, click or type), target (a URL or a selector), text (what a type
action typed), outcome (ok, blocked, failed or refused), url and digest (the page it left the
browser on) and reason. digest names a target without carrying it. The trace store
browser:trace:{id} keeps one browser.step event per step index, so a redelivered event overwrites
itself; read_trace answers them in step order.
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def trace_key(session_id: str) -> str:
    return f"browser:trace:{session_id}"


def digest(text: str) -> str:
    """A one-way digest of text: FNV-1a, 32 bits, as 8 hex digits."""
    h = 0x811C9DC5
    for byte in text.encode("utf-8"):
        h = ((h ^ byte) * 0x01000193) & 0xFFFFFFFF
    return f"{h:08x}"


def append_step(session_id: str, event: dict) -> None:
    """Store one browser.step event under its step index."""
    r.hset(trace_key(session_id), str(event["step_index"]), json.dumps(event, sort_keys=True))


def read_trace(session_id: str) -> list[dict]:
    """Every stored event of the session, in step order."""
    return sorted((json.loads(raw) for raw in r.hvals(trace_key(session_id))), key=lambda e: e["step_index"])
`,
  'browser/screenshots.py': `"""
Screenshot references (provided). public_url is where the store keeps a step's screenshot, readable
by anyone who has the URL, for as long as the object exists. sign_screenshot is a reference that
expires: the URL carries expires (Unix seconds) and a signature over the path and the expiry, and
the store serves it until then. verify is the store's check.
"""
import time

from browser.trace import digest

BASE_URL = "https://shots.browserd.example"
SECRET = "browserd-screenshots"


def public_url(session_id: str, step_index: int) -> str:
    return f"{BASE_URL}/{session_id}/{step_index}.png"


def signature(path: str, expires_at: int) -> str:
    return digest(f"{SECRET}|{path}|{expires_at}")


def sign_screenshot(session_id: str, step_index: int, ttl_s: int) -> dict:
    """{url, expires_at}: a reference the store honours for ttl_s seconds from now."""
    expires_at = int(time.time()) + ttl_s
    path = public_url(session_id, step_index)
    return {"url": f"{path}?expires={expires_at}&sig={signature(path, expires_at)}", "expires_at": expires_at}


def verify(url: str, now: int) -> bool:
    """Whether the store serves url at Unix time now."""
    path, _, query = url.partition("?")
    params = dict(part.split("=", 1) for part in query.split("&") if "=" in part)
    if not params.get("expires", "").isdigit() or "sig" not in params:
        return False
    expires_at = int(params["expires"])
    return now <= expires_at and params["sig"] == signature(path, expires_at)
`,
};

export const supportModulesTs: Record<string, string> = {
  'browser/profiles.ts': `/**
 * The egress profiles (provided): the server's catalog of where a session's browser may go. A
 * profile names the schemes and hosts its browser may reach ("*.example.com" matches any
 * subdomain, a bare host only itself) and the entry point a session starts at. authorizeNavigation
 * is the one check every navigation goes through: the reason the URL is refused, or "" when the
 * profile allows it.
 */
export interface Profile {
  name: string;
  schemes: string[];
  hosts: string[];
  entry: string;
}

export const EGRESS_PROFILES: Record<string, Profile> = {
  'public-web': {
    name: 'public-web',
    schemes: ['https'],
    hosts: ['example.com', '*.example.com', '*.wikipedia.org'],
    entry: 'https://www.example.com/',
  },
  'docs-only': {name: 'docs-only', schemes: ['https'], hosts: ['*.readthedocs.io'], entry: 'https://docs.readthedocs.io/'},
};

/** The profile called name, or null when the catalog has none. */
export function getProfile(name: string): Profile | null {
  return Object.prototype.hasOwnProperty.call(EGRESS_PROFILES, name) ? EGRESS_PROFILES[name] : null;
}

/** [scheme, host] of an absolute URL, lower-cased; ['', ''] when it is not one. */
export function splitUrl(url: string): [string, string] {
  const at = url.indexOf('://');
  if (at <= 0) return ['', ''];
  let rest = url.slice(at + 3);
  for (const stop of ['/', '?', '#']) rest = rest.split(stop)[0];
  rest = rest.slice(rest.lastIndexOf('@') + 1).split(':')[0];
  return [url.slice(0, at).toLowerCase(), rest.toLowerCase()];
}

/** Why profile refuses url, or "" when its browser may go there. */
export function authorizeNavigation(profile: Profile, url: string): string {
  const [scheme, host] = splitUrl(url);
  if (host === '') return 'not an absolute URL';
  if (!profile.schemes.includes(scheme)) return \`scheme \${scheme} is not in profile \${profile.name}\`;
  const allowed = profile.hosts.some(pattern => (pattern.startsWith('*.') && host.endsWith(pattern.slice(1))) || host === pattern);
  if (!allowed) return \`host \${host} is not in profile \${profile.name}\`;
  return '';
}
`,
  'browser/sessions.ts': `/**
 * The session documents (provided): browser:session:{id} is one hash per session with session_id,
 * tenant, profile, task, current_url, page_digest, step_index, max_steps, budget_remaining and
 * status (running or budget_exhausted). browser:idem:{tenant}:{key} holds the session an
 * Idempotency-Key started. Session ids are s-1, s-2, … from the browser:seq:session counter.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export interface Session {
  session_id: string;
  tenant: string;
  profile: string;
  task: string;
  current_url: string;
  page_digest: string;
  step_index: number;
  max_steps: number;
  budget_remaining: number;
  status: string;
}

export const sessionKey = (sessionId: string): string => \`browser:session:\${sessionId}\`;
export const idempotencyKey = (tenant: string, key: string): string => \`browser:idem:\${tenant}:\${key}\`;

/** A new running session at currentUrl with maxSteps of budget; returns it. */
export async function createSession(tenant: string, profile: string, task: string, maxSteps: number, currentUrl: string): Promise<Session> {
  const sessionId = \`s-\${await redis.incr('browser:seq:session')}\`;
  await redis.hset(sessionKey(sessionId), {
    session_id: sessionId,
    tenant,
    profile,
    task,
    current_url: currentUrl,
    page_digest: '',
    step_index: 0,
    max_steps: maxSteps,
    budget_remaining: maxSteps,
    status: 'running',
  });
  return (await loadSession(sessionId)) as Session;
}

/** The session (its counters as numbers), or null. */
export async function loadSession(sessionId: string): Promise<Session | null> {
  const raw = await redis.hgetall(sessionKey(sessionId));
  if (Object.keys(raw).length === 0) return null;
  return {
    ...(raw as unknown as Session),
    step_index: Number(raw.step_index),
    max_steps: Number(raw.max_steps),
    budget_remaining: Number(raw.budget_remaining),
  };
}

/** The session the tenant's Idempotency-Key started, if any. */
export async function sessionForKey(tenant: string, key: string): Promise<string | null> {
  return redis.get(idempotencyKey(tenant, key));
}

export async function rememberKey(tenant: string, key: string, sessionId: string): Promise<void> {
  await redis.set(idempotencyKey(tenant, key), sessionId);
}

/** The page the session's browser is on now. */
export async function recordPage(sessionId: string, url: string, digest: string): Promise<void> {
  await redis.hset(sessionKey(sessionId), {current_url: url, page_digest: digest});
}

/** What a client sees of a session. */
export function publicView(s: Session): Record<string, unknown> {
  return {
    session_id: s.session_id,
    profile: s.profile,
    current_url: s.current_url,
    step_index: s.step_index,
    max_steps: s.max_steps,
    budget_remaining: s.budget_remaining,
    status: s.status,
  };
}
`,
  'browser/lease.ts': `/**
 * The step lease (provided; step 2 builds the same function): beginStep takes or refreshes
 * worker's lease on a session (browser:lease:{id}, a 45-second TTL) and charges one step of its
 * budget in one Lua script. It returns the new step index, or LEASE_HELD (another worker's lease is
 * live), BUDGET_EXHAUSTED (the session's status becomes budget_exhausted) or NO_SESSION.
 */
import Redis from 'ioredis';

import {sessionKey} from 'browser/sessions';

export const LEASE_TTL_MS = 45_000;
export const LEASE_HELD = -1;
export const BUDGET_EXHAUSTED = -2;
export const NO_SESSION = -3;

export const BEGIN_STEP_LUA = \`
if redis.call('EXISTS', KEYS[1]) == 0 then return -3 end
local owner = redis.call('GET', KEYS[2])
if owner and owner ~= ARGV[1] then return -1 end
if tonumber(redis.call('HGET', KEYS[1], 'budget_remaining')) <= 0 then
  redis.call('HSET', KEYS[1], 'status', 'budget_exhausted')
  return -2
end
redis.call('SET', KEYS[2], ARGV[1], 'PX', ARGV[2])
redis.call('HINCRBY', KEYS[1], 'budget_remaining', -1)
return redis.call('HINCRBY', KEYS[1], 'step_index', 1)
\`;

interface LeaseRedis extends Redis {
  beginStep(session: string, lease: string, worker: string, ttlMs: number): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as LeaseRedis;
redis.defineCommand('beginStep', {numberOfKeys: 2, lua: BEGIN_STEP_LUA});

export const leaseKey = (sessionId: string): string => \`browser:lease:\${sessionId}\`;

export async function beginStep(sessionId: string, worker: string): Promise<number> {
  return Number(await redis.beginStep(sessionKey(sessionId), leaseKey(sessionId), worker, LEASE_TTL_MS));
}
`,
  'browser/trace.ts': `/**
 * The step trace (provided). A Step is what runAction (step 3) returns: the action (navigate,
 * click or type), its target (a URL or a selector), the text a type action typed, the outcome (ok,
 * blocked, failed or refused), the page it left the browser on (url, digest) and a reason. digest
 * names a target without carrying it. The trace store browser:trace:{id} keeps one browser.step
 * event per step index, so a redelivered event overwrites itself; readTrace answers them in step
 * order.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export interface Step {
  session_id: string;
  step_index: number;
  action: string;
  target: string;
  text: string;
  outcome: string;
  url: string;
  digest: string;
  reason: string;
}

export type StepEvent = Record<string, unknown> & {session_id: string; step_index: number};

export const traceKey = (sessionId: string): string => \`browser:trace:\${sessionId}\`;

/** A one-way digest of text: FNV-1a, 32 bits, as 8 hex digits. */
export function digest(text: string): string {
  let h = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) h = Math.imul(h ^ byte, 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}

/** Store one browser.step event under its step index. */
export async function appendStep(sessionId: string, event: StepEvent): Promise<void> {
  const sorted = Object.fromEntries(Object.entries(event).sort(([a], [b]) => (a < b ? -1 : 1)));
  await redis.hset(traceKey(sessionId), String(event.step_index), JSON.stringify(sorted));
}

/** Every stored event of the session, in step order. */
export async function readTrace(sessionId: string): Promise<StepEvent[]> {
  const values = await redis.hvals(traceKey(sessionId));
  return values.map(raw => JSON.parse(raw) as StepEvent).sort((a, b) => a.step_index - b.step_index);
}
`,
  'browser/screenshots.ts': `/**
 * Screenshot references (provided). publicUrl is where the store keeps a step's screenshot,
 * readable by anyone who has the URL, for as long as the object exists. signScreenshot is a
 * reference that expires: the URL carries expires (Unix seconds) and a signature over the path and
 * the expiry, and the store serves it until then. verify is the store's check.
 */
import {digest} from 'browser/trace';

export const BASE_URL = 'https://shots.browserd.example';
const SECRET = 'browserd-screenshots';

export interface Shot {
  url: string;
  expires_at: number;
}

export const publicUrl = (sessionId: string, stepIndex: number): string => \`\${BASE_URL}/\${sessionId}/\${stepIndex}.png\`;

const signature = (path: string, expiresAt: number): string => digest(\`\${SECRET}|\${path}|\${expiresAt}\`);

/** {url, expires_at}: a reference the store honours for ttlS seconds from now. */
export function signScreenshot(sessionId: string, stepIndex: number, ttlS: number): Shot {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlS;
  const path = publicUrl(sessionId, stepIndex);
  return {url: \`\${path}?expires=\${expiresAt}&sig=\${signature(path, expiresAt)}\`, expires_at: expiresAt};
}

/** Whether the store serves url at Unix time now. */
export function verify(url: string, now: number): boolean {
  const [path, query = ''] = url.split('?');
  const params = new Map(query.split('&').filter(p => p.includes('=')).map(p => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]));
  const expires = params.get('expires') ?? '';
  if (!/^\\d+$/.test(expires) || !params.has('sig')) return false;
  return now <= Number(expires) && params.get('sig') === signature(path, Number(expires));
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'browser/profiles/profiles.go': `// Package profiles is the egress catalog (provided): where a session's browser may go. A profile
// names the schemes and hosts its browser may reach ("*.example.com" matches any subdomain, a bare
// host only itself) and the entry point a session starts at. AuthorizeNavigation is the one check
// every navigation goes through: the reason the URL is refused, or "" when the profile allows it.
package profiles

import "strings"

type Profile struct {
	Name    string
	Schemes []string
	Hosts   []string
	Entry   string
}

var EgressProfiles = map[string]Profile{
	"public-web": {Name: "public-web", Schemes: []string{"https"}, Hosts: []string{"example.com", "*.example.com", "*.wikipedia.org"}, Entry: "https://www.example.com/"},
	"docs-only":  {Name: "docs-only", Schemes: []string{"https"}, Hosts: []string{"*.readthedocs.io"}, Entry: "https://docs.readthedocs.io/"},
}

// GetProfile is the profile called name, or nil when the catalog has none.
func GetProfile(name string) *Profile {
	p, ok := EgressProfiles[name]
	if !ok {
		return nil
	}
	return &p
}

// SplitURL is the scheme and host of an absolute URL, lower-cased; "", "" when it is not one.
func SplitURL(url string) (string, string) {
	at := strings.Index(url, "://")
	if at <= 0 {
		return "", ""
	}
	rest := url[at+3:]
	if i := strings.IndexAny(rest, "/?#"); i >= 0 {
		rest = rest[:i]
	}
	if i := strings.LastIndex(rest, "@"); i >= 0 {
		rest = rest[i+1:]
	}
	if i := strings.Index(rest, ":"); i >= 0 {
		rest = rest[:i]
	}
	return strings.ToLower(url[:at]), strings.ToLower(rest)
}

func hostAllowed(patterns []string, host string) bool {
	for _, pattern := range patterns {
		if strings.HasPrefix(pattern, "*.") && strings.HasSuffix(host, pattern[1:]) {
			return true
		}
		if host == pattern {
			return true
		}
	}
	return false
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// AuthorizeNavigation is why profile refuses url, or "" when its browser may go there.
func AuthorizeNavigation(profile *Profile, url string) string {
	scheme, host := SplitURL(url)
	if host == "" {
		return "not an absolute URL"
	}
	if !contains(profile.Schemes, scheme) {
		return "scheme " + scheme + " is not in profile " + profile.Name
	}
	if !hostAllowed(profile.Hosts, host) {
		return "host " + host + " is not in profile " + profile.Name
	}
	return ""
}
`,
  'browser/sessions/sessions.go': `// Package sessions is the session documents (provided): browser:session:{id} is one hash per
// session with session_id, tenant, profile, task, current_url, page_digest, step_index, max_steps,
// budget_remaining and status (running or budget_exhausted). browser:idem:{tenant}:{key} holds
// the session an Idempotency-Key started. Session ids are s-1, s-2, … from browser:seq:session.
package sessions

import (
	"context"
	"fmt"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type Session struct {
	ID              string \`json:"session_id"\`
	Tenant          string \`json:"tenant"\`
	Profile         string \`json:"profile"\`
	Task            string \`json:"task"\`
	CurrentURL      string \`json:"current_url"\`
	PageDigest      string \`json:"page_digest"\`
	StepIndex       int    \`json:"step_index"\`
	MaxSteps        int    \`json:"max_steps"\`
	BudgetRemaining int    \`json:"budget_remaining"\`
	Status          string \`json:"status"\`
}

func SessionKey(sessionID string) string { return "browser:session:" + sessionID }

func IdempotencyKey(tenant, key string) string { return "browser:idem:" + tenant + ":" + key }

// CreateSession starts a running session at currentURL with maxSteps of budget and returns it.
func CreateSession(ctx context.Context, tenant, profile, task string, maxSteps int, currentURL string) *Session {
	sessionID := fmt.Sprintf("s-%d", rdb.Incr(ctx, "browser:seq:session").Val())
	rdb.HSet(ctx, SessionKey(sessionID), map[string]any{
		"session_id": sessionID, "tenant": tenant, "profile": profile, "task": task, "current_url": currentURL,
		"page_digest": "", "step_index": "0", "max_steps": strconv.Itoa(maxSteps), "budget_remaining": strconv.Itoa(maxSteps), "status": "running",
	})
	return LoadSession(ctx, sessionID)
}

// LoadSession is the session, or nil.
func LoadSession(ctx context.Context, sessionID string) *Session {
	raw := rdb.HGetAll(ctx, SessionKey(sessionID)).Val()
	if len(raw) == 0 {
		return nil
	}
	step, _ := strconv.Atoi(raw["step_index"])
	maxSteps, _ := strconv.Atoi(raw["max_steps"])
	budget, _ := strconv.Atoi(raw["budget_remaining"])
	return &Session{ID: raw["session_id"], Tenant: raw["tenant"], Profile: raw["profile"], Task: raw["task"], CurrentURL: raw["current_url"],
		PageDigest: raw["page_digest"], StepIndex: step, MaxSteps: maxSteps, BudgetRemaining: budget, Status: raw["status"]}
}

// SessionForKey is the session the tenant's Idempotency-Key started, "" when none.
func SessionForKey(ctx context.Context, tenant, key string) string {
	return rdb.Get(ctx, IdempotencyKey(tenant, key)).Val()
}

func RememberKey(ctx context.Context, tenant, key, sessionID string) {
	rdb.Set(ctx, IdempotencyKey(tenant, key), sessionID, 0)
}

// RecordPage notes the page the session's browser is on now.
func RecordPage(ctx context.Context, sessionID, url, digest string) {
	rdb.HSet(ctx, SessionKey(sessionID), map[string]any{"current_url": url, "page_digest": digest})
}

// PublicView is what a client sees of a session.
func PublicView(s *Session) map[string]any {
	return map[string]any{"session_id": s.ID, "profile": s.Profile, "current_url": s.CurrentURL, "step_index": s.StepIndex,
		"max_steps": s.MaxSteps, "budget_remaining": s.BudgetRemaining, "status": s.Status}
}
`,
  'browser/lease/lease.go': `// Package lease is the step lease (provided; step 2 builds the same function): BeginStep takes or
// refreshes worker's lease on a session (browser:lease:{id}, a 45-second TTL) and charges one step
// of its budget in one Lua script. It returns the new step index, or LeaseHeld (another worker's
// lease is live), BudgetExhausted (the session's status becomes budget_exhausted) or NoSession.
package lease

import (
	"context"

	"github.com/redis/go-redis/v9"

	"browser/sessions"
)

const (
	LeaseTTLMs      = 45000
	LeaseHeld       = -1
	BudgetExhausted = -2
	NoSession       = -3
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var beginStepScript = redis.NewScript(\`
if redis.call('EXISTS', KEYS[1]) == 0 then return -3 end
local owner = redis.call('GET', KEYS[2])
if owner and owner ~= ARGV[1] then return -1 end
if tonumber(redis.call('HGET', KEYS[1], 'budget_remaining')) <= 0 then
  redis.call('HSET', KEYS[1], 'status', 'budget_exhausted')
  return -2
end
redis.call('SET', KEYS[2], ARGV[1], 'PX', ARGV[2])
redis.call('HINCRBY', KEYS[1], 'budget_remaining', -1)
return redis.call('HINCRBY', KEYS[1], 'step_index', 1)
\`)

func LeaseKey(sessionID string) string { return "browser:lease:" + sessionID }

func BeginStep(ctx context.Context, sessionID, worker string) (int, error) {
	return beginStepScript.Run(ctx, rdb, []string{sessions.SessionKey(sessionID), LeaseKey(sessionID)}, worker, LeaseTTLMs).Int()
}
`,
  'browser/trace/trace.go': `// Package trace is the step trace (provided). A Step is what runAction (step 3) returns: the
// action (navigate, click or type), its target (a URL or a selector), the text a type action typed,
// the outcome (ok, blocked, failed or refused), the page it left the browser on (URL, Digest) and a
// reason. Digest names a target without carrying it. The trace store browser:trace:{id} keeps one
// browser.step event per step index, so a redelivered event overwrites itself; ReadTrace answers
// them in step order.
package trace

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type Step struct {
	SessionID string \`json:"session_id"\`
	StepIndex int    \`json:"step_index"\`
	Action    string \`json:"action"\`
	Target    string \`json:"target"\`
	Text      string \`json:"text"\`
	Outcome   string \`json:"outcome"\`
	URL       string \`json:"url"\`
	Digest    string \`json:"digest"\`
	Reason    string \`json:"reason"\`
}

func TraceKey(sessionID string) string { return "browser:trace:" + sessionID }

// Digest is a one-way digest of text: FNV-1a, 32 bits, as 8 hex digits.
func Digest(text string) string {
	h := uint32(2166136261)
	for i := 0; i < len(text); i++ {
		h = (h ^ uint32(text[i])) * 16777619
	}
	return fmt.Sprintf("%08x", h)
}

// StepIndex reads an event's step_index (a number decoded from JSON, or an int).
func StepIndex(event map[string]any) int {
	switch v := event["step_index"].(type) {
	case float64:
		return int(v)
	case int:
		return v
	}
	return 0
}

// AppendStep stores one browser.step event under its step index.
func AppendStep(ctx context.Context, sessionID string, event map[string]any) error {
	raw, err := json.Marshal(event)
	if err != nil {
		return err
	}
	return rdb.HSet(ctx, TraceKey(sessionID), fmt.Sprint(StepIndex(event)), string(raw)).Err()
}

// ReadTrace is every stored event of the session, in step order.
func ReadTrace(ctx context.Context, sessionID string) ([]map[string]any, error) {
	values, err := rdb.HVals(ctx, TraceKey(sessionID)).Result()
	if err != nil {
		return nil, err
	}
	events := make([]map[string]any, 0, len(values))
	for _, raw := range values {
		event := map[string]any{}
		if err := json.Unmarshal([]byte(raw), &event); err != nil {
			return nil, err
		}
		events = append(events, event)
	}
	sort.Slice(events, func(i, j int) bool { return StepIndex(events[i]) < StepIndex(events[j]) })
	return events, nil
}
`,
  'browser/screenshots/screenshots.go': `// Package screenshots is the screenshot references (provided). PublicURL is where the store keeps a
// step's screenshot, readable by anyone who has the URL, for as long as the object exists.
// SignScreenshot is a reference that expires: the URL carries expires (Unix seconds) and a
// signature over the path and the expiry, and the store serves it until then. Verify is the
// store's check.
package screenshots

import (
	"fmt"
	"strconv"
	"strings"
	"time"

	"browser/trace"
)

const (
	BaseURL = "https://shots.browserd.example"
	secret  = "browserd-screenshots"
)

type Shot struct {
	URL       string \`json:"url"\`
	ExpiresAt int64  \`json:"expires_at"\`
}

func PublicURL(sessionID string, stepIndex int) string {
	return fmt.Sprintf("%s/%s/%d.png", BaseURL, sessionID, stepIndex)
}

func signature(path string, expiresAt int64) string {
	return trace.Digest(fmt.Sprintf("%s|%s|%d", secret, path, expiresAt))
}

// SignScreenshot is a reference the store honours for ttlS seconds from now.
func SignScreenshot(sessionID string, stepIndex int, ttlS int64) Shot {
	expiresAt := time.Now().Unix() + ttlS
	path := PublicURL(sessionID, stepIndex)
	return Shot{URL: fmt.Sprintf("%s?expires=%d&sig=%s", path, expiresAt, signature(path, expiresAt)), ExpiresAt: expiresAt}
}

// Verify reports whether the store serves url at Unix time now.
func Verify(url string, now int64) bool {
	path, query, _ := strings.Cut(url, "?")
	params := map[string]string{}
	for _, part := range strings.Split(query, "&") {
		if name, value, ok := strings.Cut(part, "="); ok {
			params[name] = value
		}
	}
	expiresAt, err := strconv.ParseInt(params["expires"], 10, 64)
	if err != nil || params["sig"] == "" {
		return false
	}
	return now <= expiresAt && params["sig"] == signature(path, expiresAt)
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'browser/profiles.h': `// The egress profiles (provided): the server's catalog of where a session's browser may go. A
// profile names the schemes and hosts its browser may reach ("*.example.com" matches any
// subdomain, a bare host only itself) and the entry point a session starts at. authorizeNavigation
// is the one check every navigation goes through: the reason the URL is refused, or "" when the
// profile allows it.
#pragma once

#include <algorithm>
#include <cctype>
#include <map>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace profiles {

struct Profile {
  std::string name;
  std::vector<std::string> schemes;
  std::vector<std::string> hosts;
  std::string entry;
};

inline const std::map<std::string, Profile>& egressProfiles() {
  static const std::map<std::string, Profile> catalog = {
      {"public-web", {"public-web", {"https"}, {"example.com", "*.example.com", "*.wikipedia.org"}, "https://www.example.com/"}},
      {"docs-only", {"docs-only", {"https"}, {"*.readthedocs.io"}, "https://docs.readthedocs.io/"}},
  };
  return catalog;
}

// The profile called name, or none when the catalog has none.
inline std::optional<Profile> getProfile(const std::string& name) {
  const auto it = egressProfiles().find(name);
  if (it == egressProfiles().end()) return std::nullopt;
  return it->second;
}

inline std::string lower(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return s;
}

// Scheme and host of an absolute URL, lower-cased; both "" when it is not one.
inline std::pair<std::string, std::string> splitUrl(const std::string& url) {
  const auto at = url.find("://");
  if (at == std::string::npos || at == 0) return {"", ""};
  std::string rest = url.substr(at + 3);
  rest = rest.substr(0, rest.find_first_of("/?#"));
  const auto user = rest.rfind('@');
  if (user != std::string::npos) rest = rest.substr(user + 1);
  rest = rest.substr(0, rest.find(':'));
  return {lower(url.substr(0, at)), lower(rest)};
}

inline bool hostAllowed(const std::vector<std::string>& patterns, const std::string& host) {
  for (const std::string& pattern : patterns) {
    if (pattern.rfind("*.", 0) == 0) {
      const std::string suffix = pattern.substr(1);
      if (host.size() > suffix.size() && host.compare(host.size() - suffix.size(), suffix.size(), suffix) == 0) return true;
    }
    if (host == pattern) return true;
  }
  return false;
}

// Why profile refuses url, or "" when its browser may go there.
inline std::string authorizeNavigation(const Profile& profile, const std::string& url) {
  const auto [scheme, host] = splitUrl(url);
  if (host.empty()) return "not an absolute URL";
  if (std::find(profile.schemes.begin(), profile.schemes.end(), scheme) == profile.schemes.end()) {
    return "scheme " + scheme + " is not in profile " + profile.name;
  }
  if (!hostAllowed(profile.hosts, host)) return "host " + host + " is not in profile " + profile.name;
  return "";
}

}  // namespace profiles
`,
  'browser/sessions.h': `// The session documents (provided): browser:session:{id} is one hash per session with session_id,
// tenant, profile, task, current_url, page_digest, step_index, max_steps, budget_remaining and
// status (running or budget_exhausted). browser:idem:{tenant}:{key} holds the session an
// Idempotency-Key started. Session ids are s-1, s-2, … from the browser:seq:session counter.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <optional>
#include <string>
#include <unordered_map>

namespace sessions {

struct Session {
  std::string session_id;
  std::string tenant;
  std::string profile;
  std::string task;
  std::string current_url;
  std::string page_digest;
  long step_index = 0;
  long max_steps = 0;
  long budget_remaining = 0;
  std::string status;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string sessionKey(const std::string& session_id) { return "browser:session:" + session_id; }

inline std::string idempotencyKey(const std::string& tenant, const std::string& key) {
  return "browser:idem:" + tenant + ":" + key;
}

// The session, or none.
inline std::optional<Session> loadSession(const std::string& session_id) {
  const std::unordered_map<std::string, std::string> raw = redis().hgetall(sessionKey(session_id));
  if (raw.empty()) return std::nullopt;
  const auto text = [&raw](const char* name) { return raw.count(name) ? raw.at(name) : std::string(); };
  const auto number = [&text](const char* name) { return text(name).empty() ? 0L : std::stol(text(name)); };
  return Session{text("session_id"), text("tenant"), text("profile"), text("task"), text("current_url"), text("page_digest"),
                 number("step_index"), number("max_steps"), number("budget_remaining"), text("status")};
}

// A new running session at current_url with max_steps of budget; returns it.
inline Session createSession(const std::string& tenant, const std::string& profile, const std::string& task, long max_steps,
                             const std::string& current_url) {
  const std::string session_id = "s-" + std::to_string(redis().incr("browser:seq:session"));
  redis().hset(sessionKey(session_id), {{"session_id", session_id},
                                        {"tenant", tenant},
                                        {"profile", profile},
                                        {"task", task},
                                        {"current_url", current_url},
                                        {"page_digest", ""},
                                        {"step_index", "0"},
                                        {"max_steps", std::to_string(max_steps)},
                                        {"budget_remaining", std::to_string(max_steps)},
                                        {"status", "running"}});
  return *loadSession(session_id);
}

// The session the tenant's Idempotency-Key started, if any.
inline std::optional<std::string> sessionForKey(const std::string& tenant, const std::string& key) {
  const auto value = redis().get(idempotencyKey(tenant, key));
  if (!value) return std::nullopt;
  return std::string(*value);
}

inline void rememberKey(const std::string& tenant, const std::string& key, const std::string& session_id) {
  redis().set(idempotencyKey(tenant, key), session_id);
}

// The page the session's browser is on now.
inline void recordPage(const std::string& session_id, const std::string& url, const std::string& digest) {
  redis().hset(sessionKey(session_id), {{"current_url", url}, {"page_digest", digest}});
}

// What a client sees of a session.
inline nlohmann::json publicView(const Session& s) {
  return nlohmann::json{{"session_id", s.session_id},       {"profile", s.profile},
                        {"current_url", s.current_url},     {"step_index", s.step_index},
                        {"max_steps", s.max_steps},         {"budget_remaining", s.budget_remaining},
                        {"status", s.status}};
}

}  // namespace sessions
`,
  'browser/lease.h': `// The step lease (provided; step 2 builds the same function): beginStep takes or refreshes
// worker's lease on a session (browser:lease:{id}, a 45-second TTL) and charges one step of its
// budget in one Lua script. It returns the new step index, or kLeaseHeld (another worker's lease
// is live), kBudgetExhausted (the session's status becomes budget_exhausted) or kNoSession.
#pragma once

#include <sw/redis++/redis++.h>

#include <string>

#include "browser/sessions.h"

namespace lease {

constexpr long kLeaseTtlMs = 45000;
constexpr long kLeaseHeld = -1;
constexpr long kBudgetExhausted = -2;
constexpr long kNoSession = -3;

inline const std::string kBeginStepLua = R"lua(
if redis.call('EXISTS', KEYS[1]) == 0 then return -3 end
local owner = redis.call('GET', KEYS[2])
if owner and owner ~= ARGV[1] then return -1 end
if tonumber(redis.call('HGET', KEYS[1], 'budget_remaining')) <= 0 then
  redis.call('HSET', KEYS[1], 'status', 'budget_exhausted')
  return -2
end
redis.call('SET', KEYS[2], ARGV[1], 'PX', ARGV[2])
redis.call('HINCRBY', KEYS[1], 'budget_remaining', -1)
return redis.call('HINCRBY', KEYS[1], 'step_index', 1)
)lua";

inline std::string leaseKey(const std::string& session_id) { return "browser:lease:" + session_id; }

inline long beginStep(const std::string& session_id, const std::string& worker) {
  return static_cast<long>(sessions::redis().eval<long long>(kBeginStepLua, {sessions::sessionKey(session_id), leaseKey(session_id)},
                                                             {worker, std::to_string(kLeaseTtlMs)}));
}

}  // namespace lease
`,
  'browser/trace.h': `// The step trace (provided). A Step is what runAction (step 3) returns: the action (navigate,
// click or type), its target (a URL or a selector), the text a type action typed, the outcome (ok,
// blocked, failed or refused), the page it left the browser on (url, digest) and a reason. digest
// names a target without carrying it. The trace store browser:trace:{id} keeps one browser.step
// event per step index, so a redelivered event overwrites itself; readTrace answers them in step
// order.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <string>
#include <unordered_map>
#include <vector>

#include "browser/sessions.h"

namespace trace {

struct Step {
  std::string session_id;
  long step_index = 0;
  std::string action;
  std::string target;
  std::string text;
  std::string outcome;
  std::string url;
  std::string digest;
  std::string reason;
};

inline std::string traceKey(const std::string& session_id) { return "browser:trace:" + session_id; }

// A one-way digest of text: FNV-1a, 32 bits, as 8 hex digits.
inline std::string digest(const std::string& text) {
  uint32_t h = 2166136261u;
  for (const unsigned char byte : text) h = (h ^ byte) * 16777619u;
  char out[9];
  std::snprintf(out, sizeof out, "%08x", h);
  return out;
}

// Store one browser.step event under its step index.
inline void appendStep(const std::string& session_id, const nlohmann::json& event) {
  sessions::redis().hset(traceKey(session_id), std::to_string(event.value("step_index", 0L)), event.dump());
}

// Every stored event of the session, in step order.
inline std::vector<nlohmann::json> readTrace(const std::string& session_id) {
  const std::unordered_map<std::string, std::string> raw = sessions::redis().hgetall(traceKey(session_id));
  std::vector<nlohmann::json> events;
  for (const auto& entry : raw) events.push_back(nlohmann::json::parse(entry.second));
  std::sort(events.begin(), events.end(),
            [](const nlohmann::json& a, const nlohmann::json& b) { return a.value("step_index", 0L) < b.value("step_index", 0L); });
  return events;
}

}  // namespace trace
`,
  'browser/screenshots.h': `// Screenshot references (provided). publicUrl is where the store keeps a step's screenshot,
// readable by anyone who has the URL, for as long as the object exists. signScreenshot is a
// reference that expires: the URL carries expires (Unix seconds) and a signature over the path and
// the expiry, and the store serves it until then. verify is the store's check.
#pragma once

#include <chrono>
#include <map>
#include <sstream>
#include <string>

#include "browser/trace.h"

namespace screenshots {

inline const std::string kBaseUrl = "https://shots.browserd.example";
inline const std::string kSecret = "browserd-screenshots";

struct Shot {
  std::string url;
  long long expires_at = 0;
};

inline std::string publicUrl(const std::string& session_id, long step_index) {
  return kBaseUrl + "/" + session_id + "/" + std::to_string(step_index) + ".png";
}

inline std::string signature(const std::string& path, long long expires_at) {
  return trace::digest(kSecret + "|" + path + "|" + std::to_string(expires_at));
}

// A reference the store honours for ttl_s seconds from now.
inline Shot signScreenshot(const std::string& session_id, long step_index, long long ttl_s) {
  const long long now =
      std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  const long long expires_at = now + ttl_s;
  const std::string path = publicUrl(session_id, step_index);
  return Shot{path + "?expires=" + std::to_string(expires_at) + "&sig=" + signature(path, expires_at), expires_at};
}

// Whether the store serves url at Unix time now.
inline bool verify(const std::string& url, long long now) {
  const auto q = url.find('?');
  if (q == std::string::npos) return false;
  const std::string path = url.substr(0, q);
  std::map<std::string, std::string> params;
  std::stringstream query(url.substr(q + 1));
  std::string part;
  while (std::getline(query, part, '&')) {
    const auto eq = part.find('=');
    if (eq != std::string::npos) params[part.substr(0, eq)] = part.substr(eq + 1);
  }
  const std::string expires = params["expires"];
  if (expires.empty() || expires.find_first_not_of("0123456789") != std::string::npos || params["sig"].empty()) return false;
  const long long expires_at = std::stoll(expires);
  return now <= expires_at && params["sig"] == signature(path, expires_at);
}

}  // namespace screenshots
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('browser', 'Profiles')]: `package browser

/**
 * The egress profiles (provided): the server's catalog of where a session's browser may go. A
 * profile names the schemes and hosts its browser may reach ("*.example.com" matches any
 * subdomain, a bare host only itself) and the entry point a session starts at. authorizeNavigation
 * is the one check every navigation goes through: the reason the URL is refused, or "" when the
 * profile allows it.
 */
object Profiles {
  final case class Profile(name: String, schemes: Seq[String], hosts: Seq[String], entry: String)

  val EgressProfiles: Map[String, Profile] = Map(
    "public-web" -> Profile("public-web", Seq("https"), Seq("example.com", "*.example.com", "*.wikipedia.org"), "https://www.example.com/"),
    "docs-only" -> Profile("docs-only", Seq("https"), Seq("*.readthedocs.io"), "https://docs.readthedocs.io/"),
  )

  /** The profile called name, if the catalog has one. */
  def getProfile(name: String): Option[Profile] = EgressProfiles.get(name)

  /** Scheme and host of an absolute URL, lower-cased; both "" when it is not one. */
  def splitUrl(url: String): (String, String) = {
    val at = url.indexOf("://")
    if (at <= 0) ("", "")
    else {
      val authority = url.substring(at + 3).takeWhile(c => c != '/' && c != '?' && c != '#')
      val host = authority.substring(authority.lastIndexOf('@') + 1).takeWhile(_ != ':')
      (url.substring(0, at).toLowerCase, host.toLowerCase)
    }
  }

  private def hostAllowed(patterns: Seq[String], host: String): Boolean =
    patterns.exists(pattern => (pattern.startsWith("*.") && host.endsWith(pattern.substring(1))) || host == pattern)

  /** Why profile refuses url, or "" when its browser may go there. */
  def authorizeNavigation(profile: Profile, url: String): String = {
    val (scheme, host) = splitUrl(url)
    if (host.isEmpty) "not an absolute URL"
    else if (!profile.schemes.contains(scheme)) s"scheme $scheme is not in profile \${profile.name}"
    else if (!hostAllowed(profile.hosts, host)) s"host $host is not in profile \${profile.name}"
    else ""
  }
}
`,
  [scalaPath('browser', 'Sessions')]: `package browser

import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

/**
 * The session documents (provided): browser:session:{id} is one hash per session with session_id,
 * tenant, profile, task, current_url, page_digest, step_index, max_steps, budget_remaining and
 * status (running or budget_exhausted). browser:idem:{tenant}:{key} holds the session an
 * Idempotency-Key started. Session ids are s-1, s-2, … from the browser:seq:session counter.
 */
object Sessions {
  final case class Session(
      sessionId: String,
      tenant: String,
      profile: String,
      task: String,
      currentUrl: String,
      pageDigest: String,
      stepIndex: Long,
      maxSteps: Long,
      budgetRemaining: Long,
      status: String,
  )

  val jedis = new JedisPooled("redis", 6379)

  def sessionKey(sessionId: String): String = s"browser:session:$sessionId"
  def idempotencyKey(tenant: String, key: String): String = s"browser:idem:$tenant:$key"

  /** The session, if it exists. */
  def loadSession(sessionId: String): Option[Session] = {
    val raw = jedis.hgetAll(sessionKey(sessionId)).asScala.toMap
    if (raw.isEmpty) None
    else {
      def text(name: String): String = raw.getOrElse(name, "")
      def number(name: String): Long = text(name).toLongOption.getOrElse(0L)
      Some(Session(text("session_id"), text("tenant"), text("profile"), text("task"), text("current_url"), text("page_digest"),
        number("step_index"), number("max_steps"), number("budget_remaining"), text("status")))
    }
  }

  /** A new running session at currentUrl with maxSteps of budget; returns it. */
  def createSession(tenant: String, profile: String, task: String, maxSteps: Long, currentUrl: String): Session = {
    val sessionId = s"s-\${jedis.incr("browser:seq:session")}"
    jedis.hset(sessionKey(sessionId), Map(
      "session_id" -> sessionId, "tenant" -> tenant, "profile" -> profile, "task" -> task, "current_url" -> currentUrl,
      "page_digest" -> "", "step_index" -> "0", "max_steps" -> maxSteps.toString, "budget_remaining" -> maxSteps.toString, "status" -> "running",
    ).asJava)
    loadSession(sessionId).get
  }

  /** The session the tenant's Idempotency-Key started, if any. */
  def sessionForKey(tenant: String, key: String): Option[String] = Option(jedis.get(idempotencyKey(tenant, key)))

  def rememberKey(tenant: String, key: String, sessionId: String): Unit = jedis.set(idempotencyKey(tenant, key), sessionId)

  /** The page the session's browser is on now. */
  def recordPage(sessionId: String, url: String, digest: String): Unit =
    jedis.hset(sessionKey(sessionId), Map("current_url" -> url, "page_digest" -> digest).asJava)

  /** What a client sees of a session. */
  def publicView(s: Session): JsObject = JsObject(
    "session_id" -> JsString(s.sessionId), "profile" -> JsString(s.profile), "current_url" -> JsString(s.currentUrl),
    "step_index" -> JsNumber(s.stepIndex), "max_steps" -> JsNumber(s.maxSteps), "budget_remaining" -> JsNumber(s.budgetRemaining),
    "status" -> JsString(s.status),
  )
}
`,
  [scalaPath('browser', 'Lease')]: `package browser

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
 * The step lease (provided; step 2 builds the same function): beginStep takes or refreshes
 * worker's lease on a session (browser:lease:{id}, a 45-second TTL) and charges one step of its
 * budget in one Lua script. It returns the new step index, or LeaseHeld (another worker's lease is
 * live), BudgetExhausted (the session's status becomes budget_exhausted) or NoSession.
 */
object Lease {
  val LeaseTtlMs = 45000L
  val LeaseHeld = -1L
  val BudgetExhausted = -2L
  val NoSession = -3L

  val jedis = new JedisPooled("redis", 6379)

  val BeginStepLua: String =
    """if redis.call('EXISTS', KEYS[1]) == 0 then return -3 end
      |local owner = redis.call('GET', KEYS[2])
      |if owner and owner ~= ARGV[1] then return -1 end
      |if tonumber(redis.call('HGET', KEYS[1], 'budget_remaining')) <= 0 then
      |  redis.call('HSET', KEYS[1], 'status', 'budget_exhausted')
      |  return -2
      |end
      |redis.call('SET', KEYS[2], ARGV[1], 'PX', ARGV[2])
      |redis.call('HINCRBY', KEYS[1], 'budget_remaining', -1)
      |return redis.call('HINCRBY', KEYS[1], 'step_index', 1)
      |""".stripMargin

  def leaseKey(sessionId: String): String = s"browser:lease:$sessionId"

  def beginStep(sessionId: String, worker: String): Long =
    jedis.eval(BeginStepLua, List(Sessions.sessionKey(sessionId), leaseKey(sessionId)).asJava, List(worker, LeaseTtlMs.toString).asJava)
      .asInstanceOf[java.lang.Long]
}
`,
  [scalaPath('browser', 'Trace')]: `package browser

import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

/**
 * The step trace (provided). A Step is what runAction (step 3) returns: the action (navigate,
 * click or type), its target (a URL or a selector), the text a type action typed, the outcome (ok,
 * blocked, failed or refused), the page it left the browser on (url, digest) and a reason. digest
 * names a target without carrying it. The trace store browser:trace:{id} keeps one browser.step
 * event per step index, so a redelivered event overwrites itself; readTrace answers them in step
 * order.
 */
object Trace {
  final case class Step(
      sessionId: String,
      stepIndex: Long,
      action: String,
      target: String,
      text: String,
      outcome: String,
      url: String,
      digest: String,
      reason: String,
  )

  val jedis = new JedisPooled("redis", 6379)

  def traceKey(sessionId: String): String = s"browser:trace:$sessionId"

  /** A one-way digest of text: FNV-1a, 32 bits, as 8 hex digits. */
  def digest(text: String): String = {
    var h = 0x811c9dc5L
    text.getBytes("UTF-8").foreach { b => h = ((h ^ (b & 0xff)) * 0x01000193L) & 0xffffffffL }
    f"$h%08x"
  }

  private def stepIndexOf(event: JsObject): Long = event.fields.get("step_index") match {
    case Some(JsNumber(n)) => n.toLong
    case _ => 0L
  }

  /** Store one browser.step event under its step index. */
  def appendStep(sessionId: String, event: JsObject): Unit =
    jedis.hset(traceKey(sessionId), stepIndexOf(event).toString, JsObject(scala.collection.immutable.TreeMap(event.fields.toSeq: _*)).compactPrint)

  /** Every stored event of the session, in step order. */
  def readTrace(sessionId: String): Seq[JsObject] =
    jedis.hvals(traceKey(sessionId)).asScala.toSeq.map(_.parseJson.asJsObject).sortBy(stepIndexOf)
}
`,
  [scalaPath('browser', 'Screenshots')]: `package browser

/**
 * Screenshot references (provided). publicUrl is where the store keeps a step's screenshot,
 * readable by anyone who has the URL, for as long as the object exists. signScreenshot is a
 * reference that expires: the URL carries expires (Unix seconds) and a signature over the path and
 * the expiry, and the store serves it until then. verify is the store's check.
 */
object Screenshots {
  val BaseUrl = "https://shots.browserd.example"
  private val Secret = "browserd-screenshots"

  final case class Shot(url: String, expiresAt: Long)

  def publicUrl(sessionId: String, stepIndex: Long): String = s"$BaseUrl/$sessionId/$stepIndex.png"

  private def signature(path: String, expiresAt: Long): String = Trace.digest(s"$Secret|$path|$expiresAt")

  /** A reference the store honours for ttlS seconds from now. */
  def signScreenshot(sessionId: String, stepIndex: Long, ttlS: Long): Shot = {
    val expiresAt = System.currentTimeMillis() / 1000 + ttlS
    val path = publicUrl(sessionId, stepIndex)
    Shot(s"$path?expires=$expiresAt&sig=\${signature(path, expiresAt)}", expiresAt)
  }

  /** Whether the store serves url at Unix time now. */
  def verify(url: String, now: Long): Boolean = url.split("\\\\?", 2) match {
    case Array(path, query) =>
      val params = query.split("&").flatMap(p => p.split("=", 2) match { case Array(k, v) => Some(k -> v); case _ => None }).toMap
      (params.get("expires").flatMap(_.toLongOption), params.get("sig")) match {
        case (Some(expiresAt), Some(sig)) => now <= expiresAt && sig == signature(path, expiresAt)
        case _ => false
      }
    case _ => false
  }
}
`,
};
