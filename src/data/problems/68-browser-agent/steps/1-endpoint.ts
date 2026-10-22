import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/browser/sessions: a session with a policy, not a URL',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'profile'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the session route,
decodes the body, mints a session id and answers 202 with the URL the caller asked for. It compiles,
it serves the demo — a session that starts on a public page and stays there — and it hides four
production flaws. Review it like the owner of the browser platform, fix it, and prove the fix with
the checks below.

Implement \`POST /v1/browser/sessions\` with body \`{"task": "…", "profile": "public-web", "max_steps": 20}\`.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- \`task\` is a non-empty string of at most **4 KiB** (\`4 << 10\` bytes of UTF-8); anything larger is
  **413**. The task text describes the job; it is never a destination.
- \`profile\` names an **egress allowlist profile** that the server resolves against its own catalog
  (\`EGRESS_PROFILES\`, each with \`schemes\`, \`hosts\` and an \`entry\` point). An unknown profile is
  **400**, and the session starts at the profile's entry point — the request carries **no start URL**,
  because a URL from the caller is a destination the caller chose.
- \`max_steps\` is required and must be an integer from **1** to **60**; omitted or out of range is
  **400**. A session without a budget is not a session.
- \`Idempotency-Key\` is required (**400** when missing). A retry with the same \`(tenant, key)\`
  returns the stored session instead of opening a second browser.
- Every navigation is **re-validated against the profile at action time**, including each **redirect**
  hop and each **subresource** the page pulls: \`authorize_navigation(profile, url)\` resolves scheme
  and host, and an off-profile target is **blocked** and recorded with its reason — never followed
  and never dropped silently.
- Log the start with tenant, session id, budget and profile name — never the task text or a URL.

**Failure mode the checks target.** The draft treats the caller's \`start_url\` as the session's entry
point and never resolves a profile, so the allowlist the platform advertises does not exist in the
code path that matters. It follows whatever the page sends next — a **302** to \`http://10.0.0.5/\` or
an \`<img src>\` pointing at an internal service — because nothing re-checks a hop after the first one.
It also lets \`max_steps\` default to "unlimited", so one task runs until someone notices the spend.
None of it shows up in a demo where the page is friendly and the first URL is the only URL.`,
  sequence: {
    participants: ['Client', 'Session API', 'Egress profiles', 'Session state'],
    messages: [
      {
        from: 'Client',
        to: 'Session API',
        label: 'POST /v1/browser/sessions · X-Tenant-Id · Idempotency-Key',
        kind: 'sync',
      },
      {from: 'Session API', to: 'Egress profiles', label: 'resolve profile → schemes · hosts · entry', kind: 'sync'},
      {from: 'Egress profiles', to: 'Session API', label: 'allowlist or unknown profile → 400', kind: 'reply'},
      {from: 'Session API', to: 'Session state', label: 'put session:{id} · profile · budget', kind: 'async'},
      {from: 'Session API', to: 'Client', label: '202 {session_id, profile, current_url, max_steps}', kind: 'reply'},
      {
        from: 'Session API',
        to: 'Session API',
        label: 'hop: authorize_navigation(profile, url) on every redirect',
        kind: 'sync',
      },
      {from: 'Session API', to: 'Session API', label: 'off-profile → block + record reason', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/browser/sessions',
      detail: 'Register the session-start route on `POST /v1/browser/sessions`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/browser\/sessions["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/browser\/sessions['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/browser\/sessions"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"browser"\s*\/\s*"sessions"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/browser\/sessions"/]},
      },
    },
    {
      id: 'profile',
      title: 'Resolves the egress profile server-side',
      detail:
        '`profile` is a name resolved against the server’s own `EGRESS_PROFILES` catalog, and an unknown name is **400**; the request carries no start URL, so the caller cannot choose the destination. The draft accepts `start_url` as the entry point and any profile string, so the allowlist exists only in the docs.',
      match: {
        python: {all: [/EGRESS_PROFILES/, /status_code\s*=\s*400/], none: [/start_url/]},
        typescript: {all: [/EGRESS_PROFILES/, /code\(\s*400\s*\)/], none: [/startUrl/]},
        go: {all: [/egressProfiles/, /http\.StatusBadRequest/], none: [/start_?url/i]},
        scala: {all: [/EgressProfiles/, /StatusCodes\.BadRequest/], none: [/startUrl/]},
        cpp: {all: [/kEgressProfiles/, /\b400\b/], none: [/start_url/]},
      },
    },
    {
      id: 'budget',
      title: 'Rejects a session without a step budget',
      detail:
        '`max_steps` is mandatory and must be an integer from `1` to `60`; omitted or out of range is **400**. The draft treats an omitted budget as unlimited, which is the difference between a bounded agent and an open-ended spend.',
      match: {
        python: {all: [/MIN_STEPS/, /MAX_STEPS/, /status_code\s*=\s*400/]},
        typescript: {all: [/MIN_STEPS/, /MAX_STEPS/, /code\(\s*400\s*\)/]},
        go: {all: [/minSteps/, /maxSteps/, /http\.StatusBadRequest/]},
        scala: {all: [/MinSteps/, /MaxSteps/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kMinSteps/, /kMaxSteps/, /\b400\b/]},
      },
    },
    {
      id: 'egress-revalidate',
      title: 'Re-validates every navigation, redirects and subresources included',
      detail:
        'One `authorize_navigation(profile, url)` helper resolves scheme and host against the profile at action time, and every hop goes through it: the redirect follower and the subresource check both authorize before the driver is asked to navigate. The draft validates the first URL and nothing else, so a 302 to an internal address walks straight past the allowlist.',
      match: {
        python: {all: [/def authorize_navigation\(/, /def follow_redirect\(/, /def check_subresource\(/]},
        typescript: {
          all: [/function authorizeNavigation\(/, /function followRedirect\(/, /function checkSubresource\(/],
        },
        go: {all: [/func authorizeNavigation\(/, /func followRedirect\(/, /func checkSubresource\(/]},
        scala: {all: [/def authorizeNavigation\(/, /def followRedirect\(/, /def checkSubresource\(/]},
        cpp: {all: [/authorizeNavigation\(/, /followRedirect\(/, /checkSubresource\(/]},
      },
    },
    {
      id: 'blocked-reason',
      title: 'Blocks an off-profile navigation and records the reason',
      detail:
        'A refused hop is appended to the session’s `blocked` list with its `reason` and written to the log, so the trace shows what the page tried instead of an empty page the operator cannot explain. The draft has no such record: an off-profile navigation either goes through or disappears.',
      match: {
        python: {all: [/def record_block\(/, /reason/, /"blocked"/]},
        typescript: {all: [/function recordBlock\(/, /reason/, /blocked/]},
        go: {all: [/func recordBlock\(/, /reason/, /blocked/i]},
        scala: {all: [/def recordBlock\(/, /reason/, /blocked/]},
        cpp: {all: [/recordBlock\(/, /reason/, /blocked/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
import uuid

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("browser.api")


class SessionRequest(BaseModel):
    task: str
    profile: str = "public-web"
    start_url: str
    max_steps: int | None = None


@app.post("/v1/browser/sessions")
def start_session(body: SessionRequest, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: the draft takes the caller's start_url as the session's entry point, resolves no egress
    # profile, treats an omitted max_steps as unlimited, and validates nothing about a later redirect
    # or subresource. Review all four.
    session = {
        "session_id": str(uuid.uuid4()),
        "tenant": tenant,
        "profile": body.profile,
        "current_url": body.start_url,
        "max_steps": body.max_steps,
        "status": "pending",
    }
    logger.info("session start tenant=%s session=%s url=%s", tenant, session["session_id"], body.start_url)
    return JSONResponse(session, status_code=202)
`,
      solution: `import logging
import uuid
from urllib.parse import urlparse

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("browser.api")

MAX_TASK_BYTES = 4 << 10
MIN_STEPS = 1
MAX_STEPS = 60
MAX_REDIRECTS = 5

EGRESS_PROFILES = {
    "public-web": {
        "schemes": ["https"],
        "hosts": ["*.example.com", "*.wikipedia.org"],
        "entry": "https://www.example.com/",
    },
    "docs-only": {
        "schemes": ["https"],
        "hosts": ["*.readthedocs.io"],
        "entry": "https://docs.readthedocs.io/",
    },
}
PRIVATE_SUFFIXES = (".internal", ".local", ".cluster", "localhost", "127.", "10.", "169.254.", "192.168.")


class SessionRequest(BaseModel):
    task: str
    profile: str
    max_steps: int | None = None


class SessionStore:
    def get(self, tenant: str, idem_key: str) -> dict | None:
        """The session stored for (tenant, idem_key), if any."""
        raise NotImplementedError

    def put(self, tenant: str, idem_key: str, session: dict) -> None:
        """Store the session under (tenant, idem_key)."""
        raise NotImplementedError


store = SessionStore()


def host_allowed(profile: dict, host: str) -> bool:
    """The host is inside the profile's allowlist and is not a private address."""
    if any(host == suffix or host.endswith(suffix) for suffix in PRIVATE_SUFFIXES):
        return False
    return any(pattern.startswith("*.") and host.endswith(pattern[1:]) for pattern in profile["hosts"])


def authorize_navigation(profile: dict, raw_url: str) -> tuple[bool, str]:
    """Re-validated on every hop, at action time: scheme and host against the profile."""
    parsed = urlparse(raw_url)
    if parsed.scheme not in profile["schemes"]:
        return False, "scheme not allowed by profile"
    if not host_allowed(profile, parsed.hostname or ""):
        return False, "host not in the egress allowlist"
    return True, ""


def record_block(session: dict, target: str, reason: str) -> None:
    """A refused navigation is recorded with its reason, never silently dropped."""
    session["blocked"].append({"url": target, "reason": reason})
    logger.warning("navigation blocked session=%s reason=%s", session["session_id"], reason)


def follow_redirect(session: dict, profile: dict, location: str, hops: int = 0) -> str:
    """Every redirect hop is authorized before the driver is asked to follow it."""
    if hops >= MAX_REDIRECTS:
        record_block(session, location, "redirect chain too long")
        raise HTTPException(status_code=409, detail="redirect chain too long")
    allowed, reason = authorize_navigation(profile, location)
    if not allowed:
        record_block(session, location, reason)
        raise HTTPException(status_code=409, detail="navigation blocked by egress profile")
    return location


def check_subresource(session: dict, profile: dict, target: str) -> None:
    """Subresources the page pulls are authorized against the same profile."""
    allowed, reason = authorize_navigation(profile, target)
    if not allowed:
        record_block(session, target, reason)


@app.post("/v1/browser/sessions")
def start_session(
    body: SessionRequest,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    idem_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if idem_key is None or idem_key == "":
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    if body.task == "":
        raise HTTPException(status_code=400, detail="task must be a non-empty string")
    if len(body.task.encode("utf-8")) > MAX_TASK_BYTES:
        raise HTTPException(status_code=413, detail="task exceeds 4 KiB")
    profile = EGRESS_PROFILES.get(body.profile)
    if profile is None:
        raise HTTPException(status_code=400, detail="unknown egress profile")
    if body.max_steps is None:
        raise HTTPException(status_code=400, detail="max_steps is required")
    if not MIN_STEPS <= body.max_steps <= MAX_STEPS:
        raise HTTPException(status_code=400, detail="max_steps must be 1..60")

    stored = store.get(tenant, idem_key)
    if stored is not None:
        return JSONResponse(stored, status_code=200)

    session = {
        "session_id": str(uuid.uuid4()),
        "tenant": tenant,
        "profile": body.profile,
        "current_url": profile["entry"],
        "max_steps": body.max_steps,
        "steps_used": 0,
        "blocked": [],
        "status": "pending",
    }
    store.put(tenant, idem_key, session)
    logger.info(
        "session start tenant=%s session=%s steps=%d profile=%s",
        tenant,
        session["session_id"],
        body.max_steps,
        body.profile,
    )
    return JSONResponse(session, status_code=202)
`,
    },
    typescript: {
      starter: `/** POST /v1/browser/sessions: a model-generated draft that navigates wherever the page points. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

export const app = Fastify();

interface SessionBody {
  task: string;
  profile: string;
  startUrl: string;
  max_steps?: number;
}

app.post('/v1/browser/sessions', async (request, reply) => {
  // TODO: the draft takes the caller's startUrl as the session's entry point, resolves no egress
  // profile, treats an omitted max_steps as unlimited, and validates nothing about a later redirect
  // or subresource. Review all four.
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as SessionBody;
  const session = {
    session_id: randomUUID(),
    tenant,
    profile: body.profile,
    current_url: body.startUrl,
    max_steps: body.max_steps,
    status: 'pending',
  };
  request.log.info({tenant, session_id: session.session_id, url: body.startUrl}, 'session started');
  return reply.code(202).send(session);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/browser/sessions: a session carries a policy, never a destination. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import {store} from './state';

export const app = Fastify();

const MAX_TASK_BYTES = 4 << 10;
const MIN_STEPS = 1;
const MAX_STEPS = 60;
const MAX_REDIRECTS = 5;

interface Profile {
  schemes: string[];
  hosts: string[];
  entry: string;
}

const EGRESS_PROFILES: Record<string, Profile> = {
  'public-web': {schemes: ['https'], hosts: ['*.example.com', '*.wikipedia.org'], entry: 'https://www.example.com/'},
  'docs-only': {schemes: ['https'], hosts: ['*.readthedocs.io'], entry: 'https://docs.readthedocs.io/'},
};

const PRIVATE_SUFFIXES = ['.internal', '.local', '.cluster', 'localhost', '127.', '10.', '169.254.', '192.168.'];

const logger = {
  info: (fields: Record<string, unknown>, message: string): void => console.info(message, fields),
  warn: (fields: Record<string, unknown>, message: string): void => console.warn(message, fields),
};

interface SessionBody {
  task: string;
  profile: string;
  max_steps?: number;
}

interface Session {
  session_id: string;
  tenant: string;
  profile: string;
  current_url: string;
  max_steps: number;
  steps_used: number;
  blocked: {url: string; reason: string}[];
  status: string;
}

const hostAllowed = (profile: Profile, host: string): boolean => {
  if (PRIVATE_SUFFIXES.some(suffix => host === suffix || host.endsWith(suffix))) return false;
  return profile.hosts.some(pattern => pattern.startsWith('*.') && host.endsWith(pattern.slice(1)));
};

/** Re-validated on every hop, at action time: scheme and host against the profile. */
export function authorizeNavigation(profile: Profile, rawUrl: string): {allowed: boolean; reason: string} {
  const url = new URL(rawUrl);
  if (!profile.schemes.includes(url.protocol.replace(':', '')))
    return {allowed: false, reason: 'scheme not allowed by profile'};
  if (!hostAllowed(profile, url.hostname)) return {allowed: false, reason: 'host not in the egress allowlist'};
  return {allowed: true, reason: ''};
}

/** A refused navigation is recorded with its reason, never silently dropped. */
export function recordBlock(session: Session, url: string, reason: string): void {
  session.blocked.push({url, reason});
  logger.warn({session_id: session.session_id, reason}, 'navigation blocked');
}

/** Every redirect hop is authorized before the driver is asked to follow it. */
export function followRedirect(session: Session, profile: Profile, location: string, hops = 0): string {
  if (hops >= MAX_REDIRECTS) {
    recordBlock(session, location, 'redirect chain too long');
    throw new Error('redirect chain too long');
  }
  const {allowed, reason} = authorizeNavigation(profile, location);
  if (!allowed) {
    recordBlock(session, location, reason);
    throw new Error('navigation blocked by egress profile');
  }
  return location;
}

/** Subresources the page pulls are authorized against the same profile. */
export function checkSubresource(session: Session, profile: Profile, url: string): void {
  const {allowed, reason} = authorizeNavigation(profile, url);
  if (!allowed) recordBlock(session, url, reason);
}

app.post('/v1/browser/sessions', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '')
    return reply.code(400).send({error: 'Idempotency-Key is required'});

  const body = request.body as Partial<SessionBody> | null;
  if (body === null || typeof body !== 'object' || typeof body.task !== 'string' || body.task === '')
    return reply.code(400).send({error: 'task must be a non-empty string'});
  if (Buffer.byteLength(body.task, 'utf8') > MAX_TASK_BYTES)
    return reply.code(413).send({error: 'task exceeds 4 KiB'});

  const profile = EGRESS_PROFILES[body.profile ?? ''];
  if (profile === undefined) return reply.code(400).send({error: 'unknown egress profile'});

  const maxSteps = body.max_steps;
  if (maxSteps === undefined) return reply.code(400).send({error: 'max_steps is required'});
  if (!Number.isInteger(maxSteps) || maxSteps < MIN_STEPS || maxSteps > MAX_STEPS)
    return reply.code(400).send({error: 'max_steps must be 1..60'});

  const stored: Session | null = await store.get(tenant, idemKey);
  if (stored !== null) return reply.code(200).send(stored);

  const session: Session = {
    session_id: randomUUID(),
    tenant,
    profile: body.profile ?? '',
    current_url: profile.entry,
    max_steps: maxSteps,
    steps_used: 0,
    blocked: [],
    status: 'pending',
  };
  await store.put(tenant, idemKey, session);
  logger.info(
    {tenant, session_id: session.session_id, max_steps: maxSteps, profile: session.profile},
    'session started',
  );
  return reply.code(202).send(session);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/google/uuid"
)

type sessionRequest struct {
	Task     string \`json:"task"\`
	Profile  string \`json:"profile"\`
	StartURL string \`json:"start_url"\`
	MaxSteps *int   \`json:"max_steps"\`
}

func startSession(w http.ResponseWriter, r *http.Request) {
	// TODO: the draft takes the caller's StartURL as the session's entry point, resolves no egress
	// profile, treats an omitted MaxSteps as unlimited, and validates nothing about a later redirect
	// or subresource. Review all four.
	var body sessionRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	tenant := r.Header.Get("X-Tenant-Id")
	session := map[string]any{
		"session_id":  uuid.NewString(),
		"tenant":      tenant,
		"profile":     body.Profile,
		"current_url": body.StartURL,
		"max_steps":   body.MaxSteps,
		"status":      "pending",
	}
	log.Printf("session start tenant=%s url=%s", tenant, body.StartURL)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	_ = json.NewEncoder(w).Encode(session)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/browser/sessions", startSession)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
      solution: `package main

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"net/url"
	"strings"

	"github.com/google/uuid"
)

const (
	maxTaskBytes = 4 << 10
	minSteps     = 1
	maxSteps     = 60
	maxRedirects = 5
)

type egressProfile struct {
	Schemes []string \`json:"schemes"\`
	Hosts   []string \`json:"hosts"\`
	Entry   string   \`json:"entry"\`
}

var egressProfiles = map[string]egressProfile{
	"public-web": {
		Schemes: []string{"https"},
		Hosts:   []string{"*.example.com", "*.wikipedia.org"},
		Entry:   "https://www.example.com/",
	},
	"docs-only": {
		Schemes: []string{"https"},
		Hosts:   []string{"*.readthedocs.io"},
		Entry:   "https://docs.readthedocs.io/",
	},
}

var privateSuffixes = []string{".internal", ".local", ".cluster", "localhost", "127.", "10.", "169.254.", "192.168."}

type blockedNavigation struct {
	URL    string \`json:"url"\`
	Reason string \`json:"reason"\`
}

type sessionState struct {
	SessionID  string              \`json:"session_id"\`
	Tenant     string              \`json:"tenant"\`
	Profile    string              \`json:"profile"\`
	CurrentURL string              \`json:"current_url"\`
	MaxSteps   int                 \`json:"max_steps"\`
	StepsUsed  int                 \`json:"steps_used"\`
	Blocked    []blockedNavigation \`json:"blocked"\`
	Status     string              \`json:"status"\`
}

func hostAllowed(profile egressProfile, host string) bool {
	for _, suffix := range privateSuffixes {
		if host == suffix || strings.HasSuffix(host, suffix) {
			return false
		}
	}
	for _, pattern := range profile.Hosts {
		if strings.HasPrefix(pattern, "*.") && strings.HasSuffix(host, pattern[1:]) {
			return true
		}
	}
	return false
}

// authorizeNavigation re-validates one hop against the profile at action time: scheme and host.
func authorizeNavigation(profile egressProfile, rawURL string) (bool, string) {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return false, "unparseable navigation target"
	}
	schemeAllowed := false
	for _, scheme := range profile.Schemes {
		if parsed.Scheme == scheme {
			schemeAllowed = true
		}
	}
	if !schemeAllowed {
		return false, "scheme not allowed by profile"
	}
	if !hostAllowed(profile, parsed.Hostname()) {
		return false, "host not in the egress allowlist"
	}
	return true, ""
}

// recordBlock records a refused navigation with its reason, never silently dropping it.
func recordBlock(session *sessionState, target string, reason string) {
	session.Blocked = append(session.Blocked, blockedNavigation{URL: target, Reason: reason})
	log.Printf("navigation blocked session=%s reason=%s", session.SessionID, reason)
}

// followRedirect authorizes every redirect hop before the driver is asked to follow it.
func followRedirect(session *sessionState, profile egressProfile, location string, hops int) (string, error) {
	if hops >= maxRedirects {
		recordBlock(session, location, "redirect chain too long")
		return "", errors.New("redirect chain too long")
	}
	allowed, reason := authorizeNavigation(profile, location)
	if !allowed {
		recordBlock(session, location, reason)
		return "", errors.New("navigation blocked by egress profile")
	}
	return location, nil
}

// checkSubresource authorizes the subresources a page pulls against the same profile.
func checkSubresource(session *sessionState, profile egressProfile, target string) {
	allowed, reason := authorizeNavigation(profile, target)
	if !allowed {
		recordBlock(session, target, reason)
	}
}

func startSession(w http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(w, "missing X-Tenant-Id", http.StatusUnauthorized)
		return
	}
	if r.Header.Get("Idempotency-Key") == "" {
		http.Error(w, "Idempotency-Key is required", http.StatusBadRequest)
		return
	}
	body := struct {
		Task     string \`json:"task"\`
		Profile  string \`json:"profile"\`
		MaxSteps *int   \`json:"max_steps"\`
	}{}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	if body.Task == "" {
		http.Error(w, "task must be a non-empty string", http.StatusBadRequest)
		return
	}
	if len(body.Task) > maxTaskBytes {
		http.Error(w, "task exceeds 4 KiB", http.StatusRequestEntityTooLarge)
		return
	}
	profile, known := egressProfiles[body.Profile]
	if !known {
		http.Error(w, "unknown egress profile", http.StatusBadRequest)
		return
	}
	if body.MaxSteps == nil {
		http.Error(w, "max_steps is required", http.StatusBadRequest)
		return
	}
	if *body.MaxSteps < minSteps || *body.MaxSteps > maxSteps {
		http.Error(w, "max_steps must be 1..60", http.StatusBadRequest)
		return
	}
	session := sessionState{
		SessionID:  uuid.NewString(),
		Tenant:     tenant,
		Profile:    body.Profile,
		CurrentURL: profile.Entry,
		MaxSteps:   *body.MaxSteps,
		Blocked:    []blockedNavigation{},
		Status:     "pending",
	}
	log.Printf("session start tenant=%s session=%s steps=%d profile=%s", tenant, session.SessionID, session.MaxSteps, session.Profile)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	_ = json.NewEncoder(w).Encode(session)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/browser/sessions", startSession)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
    },
    scala: {
      starter: `import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

final case class SessionRequest(task: String, profile: String, startUrl: String, max_steps: Option[Int])

object SessionApi {
  implicit val system: ActorSystem = ActorSystem("browser-agent")

  def jsonEntity(body: String): ResponseEntity =
    HttpEntity(ContentTypes.\`application/json\`, body)

  val route: Route =
    path("v1" / "browser" / "sessions") {
      post {
        // TODO: the draft takes the caller's startUrl as the session's entry point, resolves no
        // egress profile, treats an omitted max_steps as unlimited, and validates nothing about a
        // later redirect or subresource. Review all four.
        entity(as[String]) { body =>
          val request = body.parseJson.asJsObject
          complete(
            StatusCodes.Accepted,
            jsonEntity(
              s"""{"session_id":"\${UUID.randomUUID()}","profile":"\${request.fields("profile").convertTo[String]}","current_url":"\${request.fields("start_url").convertTo[String]}"}"""
            )
          )
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

final case class EgressProfile(schemes: List[String], hosts: List[String], entry: String)
final case class BlockedNavigation(url: String, reason: String)

object SessionApi {
  implicit val system: ActorSystem = ActorSystem("browser-agent")

  val MaxTaskBytes = 4 << 10
  val MinSteps = 1
  val MaxSteps = 60
  val MaxRedirects = 5

  val EgressProfiles: Map[String, EgressProfile] = Map(
    "public-web" -> EgressProfile(List("https"), List("*.example.com", "*.wikipedia.org"), "https://www.example.com/"),
    "docs-only" -> EgressProfile(List("https"), List("*.readthedocs.io"), "https://docs.readthedocs.io/")
  )
  val PrivateSuffixes: List[String] =
    List(".internal", ".local", ".cluster", "localhost", "127.", "10.", "169.254.", "192.168.")

  def jsonEntity(body: String): ResponseEntity =
    HttpEntity(ContentTypes.\`application/json\`, body)

  def hostAllowed(profile: EgressProfile, host: String): Boolean =
    !PrivateSuffixes.exists(suffix => host == suffix || host.endsWith(suffix)) &&
      profile.hosts.exists(pattern => pattern.startsWith("*.") && host.endsWith(pattern.drop(1)))

  /** Re-validated on every hop, at action time: scheme and host against the profile. */
  def authorizeNavigation(profile: EgressProfile, rawUrl: String): Either[String, Unit] = {
    val uri = Uri(rawUrl)
    if (!profile.schemes.contains(uri.scheme)) Left("scheme not allowed by profile")
    else if (!hostAllowed(profile, uri.authority.host.address)) Left("host not in the egress allowlist")
    else Right(())
  }

  /** A refused navigation is recorded with its reason, never silently dropped. */
  def recordBlock(blocked: scala.collection.mutable.ListBuffer[BlockedNavigation], url: String, reason: String): Unit = {
    blocked += BlockedNavigation(url, reason)
    system.log.warning(s"navigation blocked reason=$reason")
  }

  /** Every redirect hop is authorized before the driver is asked to follow it. */
  def followRedirect(
      blocked: scala.collection.mutable.ListBuffer[BlockedNavigation],
      profile: EgressProfile,
      location: String,
      hops: Int
  ): Either[String, String] =
    if (hops >= MaxRedirects) {
      recordBlock(blocked, location, "redirect chain too long")
      Left("redirect chain too long")
    } else
      authorizeNavigation(profile, location) match {
        case Left(reason) =>
          recordBlock(blocked, location, reason)
          Left("navigation blocked by egress profile")
        case Right(_) => Right(location)
      }

  /** Subresources the page pulls are authorized against the same profile. */
  def checkSubresource(
      blocked: scala.collection.mutable.ListBuffer[BlockedNavigation],
      profile: EgressProfile,
      url: String
  ): Unit =
    authorizeNavigation(profile, url) match {
      case Left(reason) => recordBlock(blocked, url, reason)
      case Right(_)     => ()
    }

  val route: Route =
    path("v1" / "browser" / "sessions") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          optionalHeaderValueByName("Idempotency-Key") { keyOpt =>
            entity(as[String]) { body =>
              val tenant = tenantOpt.filter(_.nonEmpty)
              val request = body.parseJson.asJsObject
              val profileName = request.fields.get("profile").map(_.convertTo[String]).getOrElse("")
              val steps = request.fields.get("max_steps").map(_.convertTo[Int])
              if (tenant.isEmpty) {
                complete(StatusCodes.Unauthorized, jsonEntity("""{"error":"missing X-Tenant-Id"}"""))
              } else if (keyOpt.forall(_.isEmpty)) {
                complete(StatusCodes.BadRequest, jsonEntity("""{"error":"Idempotency-Key is required"}"""))
              } else if (!EgressProfiles.contains(profileName)) {
                complete(StatusCodes.BadRequest, jsonEntity("""{"error":"unknown egress profile"}"""))
              } else if (steps.isEmpty || steps.exists(n => n < MinSteps || n > MaxSteps)) {
                complete(StatusCodes.BadRequest, jsonEntity("""{"error":"max_steps must be 1..60"}"""))
              } else {
                val profile = EgressProfiles(profileName)
                val blocked = scala.collection.mutable.ListBuffer.empty[BlockedNavigation]
                complete(
                  StatusCodes.Accepted,
                  jsonEntity(
                    s"""{"session_id":"\${UUID.randomUUID()}","profile":"$profileName","current_url":"\${profile.entry}","max_steps":\${steps.get}}"""
                  )
                )
              }
            }
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

using json = nlohmann::json;

int main() {
  httplib::Server svr;

  svr.Post("/v1/browser/sessions", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: the draft takes the caller's start_url as the session's entry point, resolves no egress
    // profile, treats an omitted max_steps as unlimited, and validates nothing about a later redirect
    // or subresource. Review all four.
    const auto body = json::parse(req.body);
    const auto tenant = req.get_header_value("X-Tenant-Id");
    res.status = 202;
    res.set_content(json{{"session_id", "generated"},
                         {"tenant", tenant},
                         {"profile", body.value("profile", "public-web")},
                         {"current_url", body.at("start_url")},
                         {"max_steps", body.value("max_steps", 0)}}
                        .dump(),
                    "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <cstddef>
#include <iostream>
#include <map>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr std::size_t kMaxTaskBytes = 4 << 10;
constexpr int kMinSteps = 1;
constexpr int kMaxSteps = 60;
constexpr int kMaxRedirects = 5;

struct EgressProfile {
  std::vector<std::string> schemes;
  std::vector<std::string> hosts;
  std::string entry;
};

const std::map<std::string, EgressProfile> kEgressProfiles = {
    {"public-web", {{"https"}, {"*.example.com", "*.wikipedia.org"}, "https://www.example.com/"}},
    {"docs-only", {{"https"}, {"*.readthedocs.io"}, "https://docs.readthedocs.io/"}},
};

const std::vector<std::string> kPrivateSuffixes = {".internal", ".local", ".cluster", "localhost",
                                                   "127.",      "10.",  "169.254.", "192.168."};

struct BlockedNavigation {
  std::string url;
  std::string reason;
};

struct SessionState {
  std::string sessionId;
  std::string tenant;
  std::string profile;
  std::string currentUrl;
  int maxSteps = 0;
  int stepsUsed = 0;
  std::vector<BlockedNavigation> blocked;
  std::string status;
};

static bool endsWith(const std::string& value, const std::string& suffix) {
  return value.size() >= suffix.size() &&
         value.compare(value.size() - suffix.size(), suffix.size(), suffix) == 0;
}

static bool hostAllowed(const EgressProfile& profile, const std::string& host) {
  for (const auto& suffix : kPrivateSuffixes)
    if (host == suffix || endsWith(host, suffix)) return false;
  for (const auto& pattern : profile.hosts)
    if (pattern.rfind("*.", 0) == 0 && endsWith(host, pattern.substr(1))) return true;
  return false;
}

// authorizeNavigation re-validates one hop against the profile at action time: scheme and host.
static std::pair<bool, std::string> authorizeNavigation(const EgressProfile& profile, const std::string& rawUrl) {
  const auto schemeEnd = rawUrl.find("://");
  const std::string scheme = schemeEnd == std::string::npos ? std::string() : rawUrl.substr(0, schemeEnd);
  if (std::find(profile.schemes.begin(), profile.schemes.end(), scheme) == profile.schemes.end())
    return {false, "scheme not allowed by profile"};
  const std::size_t hostStart = schemeEnd == std::string::npos ? 0 : schemeEnd + 3;
  std::size_t hostEnd = rawUrl.find('/', hostStart);
  if (hostEnd == std::string::npos) hostEnd = rawUrl.size();
  const std::string host = rawUrl.substr(hostStart, hostEnd - hostStart);
  if (!hostAllowed(profile, host)) return {false, "host not in the egress allowlist"};
  return {true, std::string()};
}

// recordBlock records a refused navigation with its reason, never silently dropping it.
static void recordBlock(SessionState& session, const std::string& target, const std::string& reason) {
  session.blocked.push_back(BlockedNavigation{target, reason});
  std::cerr << "navigation blocked session=" << session.sessionId << " reason=" << reason << std::endl;
}

// followRedirect authorizes every redirect hop before the driver is asked to follow it.
static std::pair<bool, std::string> followRedirect(SessionState& session, const EgressProfile& profile,
                                                   const std::string& location, int hops) {
  if (hops >= kMaxRedirects) {
    recordBlock(session, location, "redirect chain too long");
    return {false, "redirect chain too long"};
  }
  const auto verdict = authorizeNavigation(profile, location);
  if (!verdict.first) {
    recordBlock(session, location, verdict.second);
    return {false, "navigation blocked by egress profile"};
  }
  return {true, location};
}

// checkSubresource authorizes the subresources a page pulls against the same profile.
static void checkSubresource(SessionState& session, const EgressProfile& profile, const std::string& target) {
  const auto verdict = authorizeNavigation(profile, target);
  if (!verdict.first) recordBlock(session, target, verdict.second);
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/browser/sessions", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    if (req.get_header_value("Idempotency-Key").empty()) {
      res.status = 400;
      res.set_content(R"({"error":"Idempotency-Key is required"})", "application/json");
      return;
    }
    const auto body = json::parse(req.body);
    const std::string task = body.value("task", std::string());
    if (task.empty() || task.size() > kMaxTaskBytes) {
      res.status = 413;
      res.set_content(R"({"error":"task exceeds 4 KiB"})", "application/json");
      return;
    }
    const std::string profileName = body.value("profile", std::string());
    const auto profileIt = kEgressProfiles.find(profileName);
    if (profileIt == kEgressProfiles.end()) {
      res.status = 400;
      res.set_content(R"({"error":"unknown egress profile"})", "application/json");
      return;
    }
    if (!body.contains("max_steps")) {
      res.status = 400;
      res.set_content(R"({"error":"max_steps is required"})", "application/json");
      return;
    }
    const int steps = body.value("max_steps", 0);
    if (steps < kMinSteps || steps > kMaxSteps) {
      res.status = 400;
      res.set_content(R"({"error":"max_steps must be 1..60"})", "application/json");
      return;
    }
    SessionState session;
    session.sessionId = "generated";
    session.tenant = tenant;
    session.profile = profileName;
    session.currentUrl = profileIt->second.entry;
    session.maxSteps = steps;
    session.status = "pending";
    res.status = 202;
    res.set_content(json{{"session_id", session.sessionId},
                         {"tenant", tenant},
                         {"profile", profileName},
                         {"current_url", session.currentUrl},
                         {"max_steps", steps},
                         {"status", "pending"}}
                        .dump(),
                    "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'A session takes a **policy**, not a destination. `profile` is a name the server resolves against its own catalog (`EGRESS_PROFILES`), and an unknown name is **400**. There is no start-URL field to trust: the session begins at the profile’s entry point, so the caller never names an address.',
    'Authorize at action time, not at start time. One `authorize_navigation(profile, url)` helper resolves scheme and host against the profile, and **every** hop goes through it — the redirect follower and the subresource check included — so a `302` to `http://10.0.0.5/` cannot walk past the allowlist. When a hop is refused, record the URL and the reason on the session so the trace shows what the page tried.',
    'A session without a budget is not a session: `max_steps` is mandatory, an integer from 1 to 60, and an unbounded browser session is how one task runs until someone notices the spend. Reject it with **400** rather than defaulting to “unlimited”.',
  ],
  debrief: `The interviewer is testing whether you can review a browser session start as a **policy** boundary rather than a convenience API. The draft reads fine because the demo sends a public URL and the page stays there. Four defects are being checked. First, the destination: a browser agent’s blast radius is everything the page can reach, so the caller names an egress *profile* and the server resolves it — an unknown profile is a 400, not a default. Second, re-validation at action time: checking the first URL and then trusting the page is how the agent walks into the intranet on the second hop, because redirects and subresources are the page’s own choices, not the caller’s. Third, the record: a blocked navigation has to leave a reason behind, or the operator sees a blank page and cannot tell a hostile redirect from a broken site. Fourth, the budget: an omitted \`max_steps\` must be a rejection, because “unlimited” is the only setting nobody can afford. Real platforms add per-profile rate limits, a separate profile for authenticated sessions, and a policy service so the allowlist changes without a deploy.`,
};
