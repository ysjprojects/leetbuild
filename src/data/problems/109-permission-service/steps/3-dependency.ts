import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  concept: 'grpc',
  file: 'client',
  title: 'Policy engine calls that deny when unverifiable',
  focus: ['api', 'engine', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the check route,
asks the policy engine for a decision, caches the answer and returns it, and it compiles. Every
failure path is wrong. Find them, fix them, and prove the fix with the checks below.

The effective-permission check consults the policy engine over gRPC — \`PolicyEngine.Decide\`, a unary
call taking \`subject\`, \`permission\` and \`scope\`, answering \`ALLOW\` or \`DENY\` — and the service has
to survive that engine being slow, gone or unhappy.

- **Deadline.** Every attempt carries a **400 ms** deadline, on the call itself: \`timeout=\`,
  \`deadline:\`, \`context.WithTimeout\`, \`withDeadlineAfter\`, \`context->set_deadline\`. A call with no
  deadline lets one wedged engine pin the request open indefinitely.
- **At most two attempts.** Only transport failures — \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` — are
  retried, after a jittered backoff. Every other status is the engine's answer, not noise.
- **A timeout denies.** When the attempts are exhausted the caller gets a retriable **503** with
  \`Retry-After: 1\` — never the last cached allow. An outage must not become broad access.
- **A \`DENY\` is terminal.** One call, no retry, **403**, and no cached allow consulted behind it.
  The draft retries a rejection as though the engine were merely flaky.
- **A cached allow is only as good as its version.** Cached allows live under
  \`perm:allow:{subject}:{permission}:{scope}\` and count only while their stored \`grant_version\`
  matches the current counter; otherwise the engine is asked again. A TTL is not a revocation
  signal: the draft's entry keeps a revoked grant alive for the rest of its minute.

**Failure mode the checks target.** The draft fails open, which is the one thing an authorization
path may not do. It calls the engine with no time bound, so one hung call is one hung request; it
catches every RPC error and, once the attempts are gone, answers from the last cached allow, so an
engine outage silently becomes platform-wide access; it retries a policy rejection, so a deliberate
\`DENY\` costs two calls and, with a warm cache, comes back as an \`ALLOW\`; and it trusts its cache on
a timer instead of a version, so a revocation waits for the TTL. Each of those is invisible in a demo
where the engine is fast and nothing is ever revoked.`,
  sequence: {
    participants: ['Permission Service', 'Policy engine', 'Redis', 'Client'],
    messages: [
      {from: 'Client', to: 'Permission Service', label: 'POST /v1/check · subject · permission · scope', kind: 'sync'},
      {
        from: 'Permission Service',
        to: 'Redis',
        label: 'hgetall perm:allow:{subject}:{permission}:{scope}',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Permission Service', label: 'stored allow + grant_version / none', kind: 'reply'},
      {
        from: 'Permission Service',
        to: 'Policy engine',
        label: 'Decide(subject, permission, scope) · 400 ms deadline',
        kind: 'sync',
      },
      {from: 'Policy engine', to: 'Permission Service', label: 'ALLOW', kind: 'reply'},
      {from: 'Permission Service', to: 'Redis', label: 'hset allow · grant_version · effect', kind: 'async'},
      {from: 'Permission Service', to: 'Policy engine', label: 'Decide · DENY', kind: 'sync'},
      {from: 'Permission Service', to: 'Client', label: '403 policy_denied · one call · no retry', kind: 'reply'},
      {from: 'Permission Service', to: 'Policy engine', label: 'Decide · deadline expires, retry once', kind: 'sync'},
      {from: 'Permission Service', to: 'Client', label: '503 policy_unavailable · Retry-After: 1', kind: 'reply'},
    ],
  },
  hints: [
    'The time bound belongs to the call, not to a wrapper around it: `timeout=`, `deadline: Date.now() + …`, `context.WithTimeout`, `withDeadlineAfter`, `set_deadline`. Then decide what a timeout *means* — the engine did not answer, so the answer cannot be yes. Hand the caller a retriable failure instead of reaching for the cache.',
    'Retryability is a property of the status code, not of “it threw”. Capture the code, keep a small attempt counter, sleep with jitter between transport failures, and let `UNAVAILABLE`/`DEADLINE_EXCEEDED` be the only two that earn a second call; anything else returns immediately.',
    'For the cache, store the version beside the allow and compare it with the current counter before trusting the entry — a matching version is the only proof the allow survived the last revocation. Keep the deny path ahead of any cache fallback so a rejection can never be softened into an allow.',
  ],
  checks: [
    {
      id: 'deadline',
      title: 'Calls the policy engine under a 400 ms deadline',
      detail:
        'The decision call carries a 400 ms deadline, so an unresponsive engine cannot pin a request open. The draft calls the engine with no deadline at all.',
      match: {
        python: {all: [/POLICY_TIMEOUT_MS/, /timeout\s*=\s*POLICY_TIMEOUT_MS/]},
        typescript: {all: [/POLICY_TIMEOUT_MS/, /deadline/]},
        go: {all: [/policyTimeoutMs/, /context\.WithTimeout/]},
        scala: {all: [/PolicyTimeoutMs/, /deadlineAfter|withDeadline/]},
        cpp: {all: [/kPolicyTimeoutMs/, /set_deadline/]},
      },
    },
    {
      id: 'fail-closed',
      title: 'Denies with a retriable error when the engine cannot be reached',
      detail:
        'A `DEADLINE_EXCEEDED` denies the request: the caller gets a retriable `503` with `Retry-After` and never the last cached allow. The draft falls back to the cached allow, so an outage turns into broad access.',
      match: {
        python: {all: [/DEADLINE_EXCEEDED/, /Retry-After/, /status_code\s*=\s*503/]},
        typescript: {all: [/DEADLINE_EXCEEDED/, /Retry-After/, /code\(\s*503\s*\)/]},
        go: {all: [/DeadlineExceeded/, /Retry-After/, /StatusServiceUnavailable/]},
        scala: {all: [/DEADLINE_EXCEEDED/, /Retry-After/, /StatusCodes\.ServiceUnavailable/]},
        cpp: {all: [/DEADLINE_EXCEEDED/, /Retry-After/, /\b503\b/]},
      },
    },
    {
      id: 'terminal-deny',
      title: 'Treats a policy rejection as terminal',
      detail:
        'A `DENY` from the engine is final: `403`, one call, no retry, no cache consultation. The draft retries a rejection as if the engine were merely flaky, and only then denies.',
      match: {
        python: {all: [/is_terminal\(/, /status_code\s*=\s*403/]},
        typescript: {all: [/isTerminal\(/, /code\(\s*403\s*\)/]},
        go: {all: [/isTerminal\(/, /StatusForbidden/]},
        scala: {all: [/isTerminal\(/, /StatusCodes\.Forbidden/]},
        cpp: {all: [/isTerminal\(/, /\b403\b/]},
      },
    },
    {
      id: 'retry-transient',
      title: 'Retries only transport failures, and only twice',
      detail:
        'Only `UNAVAILABLE` and `DEADLINE_EXCEEDED` are retried, at most twice with backoff; every other status fails fast. The draft retries any error, including a rejection.',
      match: {
        python: {all: [/MAX_ATTEMPTS/, /UNAVAILABLE/]},
        typescript: {all: [/MAX_ATTEMPTS/, /UNAVAILABLE/]},
        go: {all: [/maxAttempts/, /Unavailable/]},
        scala: {all: [/MaxAttempts/, /UNAVAILABLE/]},
        cpp: {all: [/kMaxAttempts/, /UNAVAILABLE/]},
      },
    },
    {
      id: 'cached-allow-version',
      title: 'Never serves a cached allow past its version',
      detail:
        'A cached allow counts only while its stored version matches the current `grant_version`; otherwise the engine is asked again. The draft serves its cached allow on a TTL and never checks a version.',
      match: {
        python: {all: [/def allow_is_current\(/, /grant_version/]},
        typescript: {all: [/function allowIsCurrent\(/, /grant_version/]},
        go: {all: [/func allowIsCurrent\(/, /grant_version/]},
        scala: {all: [/def allowIsCurrent\(/, /grant_version/]},
        cpp: {all: [/allowIsCurrent\(/, /grant_version/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""Policy-engine client for the effective-permission check."""
import grpc
from fastapi import FastAPI, HTTPException
from redis import Redis

import policy_pb2
import policy_pb2_grpc

app = FastAPI()
redis = Redis.from_url("redis://perm-cache:6379", decode_responses=True)
channel = grpc.insecure_channel("policy-engine:50051")
stub = policy_pb2_grpc.PolicyEngineStub(channel)

RETRY_LIMIT = 3
ALLOW_TTL_SECONDS = 60
ALLOW_KEY = "perm:allow:{subject}:{permission}:{scope}"


def allow_key(subject: str, permission: str, scope: str) -> str:
    """The cache key of the allow for exactly this (subject, permission, scope) triple."""
    return ALLOW_KEY.format(subject=subject, permission=permission, scope=scope)


def decide(subject: str, permission: str, scope: str) -> str:
    # TODO: the draft calls the engine with no time bound, treats a policy rejection as if the
    # engine were flaky, and returns the last cached allow once every attempt has failed. It fails
    # open on timeout, so an engine outage turns into broad access. Review the whole failure path.
    cached = redis.get(allow_key(subject, permission, scope))
    request = policy_pb2.DecideRequest(subject=subject, permission=permission, scope=scope)
    for _ in range(RETRY_LIMIT):
        try:
            reply = stub.Decide(request)
        except grpc.RpcError:
            continue
        if reply.effect == "DENY":
            return "DENY"
        redis.set(allow_key(subject, permission, scope), "ALLOW", ex=ALLOW_TTL_SECONDS)
        return "ALLOW"
    if cached is not None:
        return "ALLOW"
    return "UNVERIFIED"


@app.post("/v1/check")
def check(subject: str, permission: str, scope: str) -> dict:
    verdict = decide(subject, permission, scope)
    if verdict == "ALLOW":
        return {"allowed": True, "subject": subject, "permission": permission, "scope": scope}
    if verdict == "DENY":
        raise HTTPException(status_code=403, detail={"error": "policy_denied"})
    raise HTTPException(status_code=503, detail={"error": "policy_unavailable"})
`,
      solution: `"""Policy-engine client for the effective-permission check."""
import random
import time

import grpc
from fastapi import FastAPI, HTTPException
from redis import Redis

import policy_pb2
import policy_pb2_grpc

app = FastAPI()
redis = Redis.from_url("redis://perm-cache:6379", decode_responses=True)
channel = grpc.insecure_channel("policy-engine:50051")
stub = policy_pb2_grpc.PolicyEngineStub(channel)

POLICY_TIMEOUT_MS = 400
MAX_ATTEMPTS = 2
BACKOFF_MS = 50
TRANSIENT_CODES = {"UNAVAILABLE", "DEADLINE_EXCEEDED"}
TERMINAL_CODES = {"PERMISSION_DENIED", "UNAUTHENTICATED"}
GRANT_VERSION_KEY = "perm:grant_version"
ALLOW_KEY = "perm:allow:{subject}:{permission}:{scope}"


def allow_key(subject: str, permission: str, scope: str) -> str:
    """The cache key of the allow for exactly this (subject, permission, scope) triple."""
    return ALLOW_KEY.format(subject=subject, permission=permission, scope=scope)


def current_grant_version() -> int:
    """The global counter every cached allow is stamped with."""
    value = redis.get(GRANT_VERSION_KEY)
    return int(value) if value is not None else 0


def allow_is_current(subject: str, permission: str, scope: str, version: int) -> bool:
    """A cached allow counts only while its stored version matches the current counter."""
    cached = redis.hgetall(allow_key(subject, permission, scope))
    if not cached:
        return False
    return int(cached.get("grant_version", -1)) == version


def is_terminal(code: str) -> bool:
    """A rejection is the engine's answer; retrying it changes nothing."""
    return code in TERMINAL_CODES


def backoff_seconds(attempt: int) -> float:
    """50 ms doubling per attempt, with jitter so retries do not synchronise."""
    return (BACKOFF_MS * 2 ** (attempt - 1) + random.randint(0, BACKOFF_MS)) / 1000.0


def decide(subject: str, permission: str, scope: str) -> str:
    """Ask the engine for one verdict: "ALLOW", "DENY" (terminal) or "UNAVAILABLE" (retriable)."""
    version = current_grant_version()
    if allow_is_current(subject, permission, scope, version):
        return "ALLOW"

    request = policy_pb2.DecideRequest(subject=subject, permission=permission, scope=scope)
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            reply = stub.Decide(request, timeout=POLICY_TIMEOUT_MS)
        except grpc.RpcError as exc:
            code = exc.code().name
            if is_terminal(code):
                return "DENY"
            if code not in TRANSIENT_CODES or attempt == MAX_ATTEMPTS:
                break
            time.sleep(backoff_seconds(attempt))
            continue
        if reply.effect == "DENY":
            return "DENY"
        redis.hset(
            allow_key(subject, permission, scope),
            mapping={"grant_version": version, "effect": "ALLOW"},
        )
        return "ALLOW"
    return "UNAVAILABLE"


@app.post("/v1/check")
def check(subject: str, permission: str, scope: str) -> dict:
    verdict = decide(subject, permission, scope)
    if verdict == "ALLOW":
        return {"allowed": True, "subject": subject, "permission": permission, "scope": scope}
    if verdict == "DENY":
        raise HTTPException(status_code=403, detail={"error": "policy_denied"})
    raise HTTPException(
        status_code=503,
        headers={"Retry-After": "1"},
        detail={"error": "policy_unavailable"},
    )
`,
    },
    typescript: {
      starter: `/** Policy-engine client for the effective-permission check. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Fastify from 'fastify';
import Redis from 'ioredis';

export const app = Fastify();
const redis = new Redis('redis://perm-cache:6379');

const packageDefinition = protoLoader.loadSync('proto/policy.proto', {keepCase: true});
const proto = grpc.loadPackageDefinition(packageDefinition) as {
  policy: {PolicyEngine: new (address: string, credentials: grpc.ChannelCredentials) => PolicyEngineClient};
};
const engine = new proto.policy.PolicyEngine('policy-engine:50051', grpc.credentials.createInsecure());

const RETRY_LIMIT = 3;
const ALLOW_TTL_SECONDS = 60;
const allowKey = (subject: string, permission: string, scope: string) =>
  \`perm:allow:\${subject}:\${permission}:\${scope}\`;

interface CheckBody {
  subject: string;
  permission: string;
  scope: string;
}

interface DecideReply {
  effect: string;
}

interface PolicyEngineClient extends grpc.Client {
  decide(request: CheckBody, callback: (error: Error | null, reply: DecideReply) => void): grpc.ClientUnaryCall;
}

function callEngine(subject: string, permission: string, scope: string): Promise<string> {
  const {promise, resolve, reject} = Promise.withResolvers<string>();
  engine.decide({subject, permission, scope}, (error, reply) => {
    if (error) reject(error);
    else resolve(reply.effect);
  });
  return promise;
}

export async function decide(subject: string, permission: string, scope: string): Promise<string> {
  // TODO: the draft calls the engine with no time bound, treats a policy rejection as if the
  // engine were flaky, and returns the last cached allow once every attempt has failed. It fails
  // open on timeout, so an engine outage turns into broad access. Review the whole failure path.
  const cached = await redis.get(allowKey(subject, permission, scope));
  for (let attempt = 0; attempt < RETRY_LIMIT; attempt += 1) {
    try {
      const effect = await callEngine(subject, permission, scope);
      if (effect === 'DENY') return 'DENY';
      await redis.set(allowKey(subject, permission, scope), 'ALLOW', 'EX', ALLOW_TTL_SECONDS);
      return 'ALLOW';
    } catch {
      // the draft treats a rejection and a transport failure the same way
    }
  }
  if (cached !== null) return 'ALLOW';
  return 'UNVERIFIED';
}

app.post('/v1/check', async (request, reply) => {
  const {subject, permission, scope} = request.body as CheckBody;
  const verdict = await decide(subject, permission, scope);
  if (verdict === 'ALLOW') return reply.code(200).send({allowed: true, subject, permission, scope});
  if (verdict === 'DENY') return reply.code(403).send({error: 'policy_denied'});
  return reply.code(503).send({error: 'policy_unavailable'});
});

void app.listen({port: 8445, host: '0.0.0.0'});
`,
      solution: `/** Policy-engine client for the effective-permission check. */
import {status as grpcStatus, type ClientUnaryCall, type ServiceError} from '@grpc/grpc-js';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Fastify from 'fastify';
import Redis from 'ioredis';

export const app = Fastify();
const redis = new Redis('redis://perm-cache:6379');

const POLICY_TIMEOUT_MS = 400;
const MAX_ATTEMPTS = 2;
const BACKOFF_MS = 50;
const GRANT_VERSION_KEY = 'perm:grant_version';

interface DecideRequest {
  subject: string;
  permission: string;
  scope: string;
}

interface DecideReply {
  effect: 'ALLOW' | 'DENY';
}

interface PolicyEngineClient extends grpc.Client {
  decide(
    request: DecideRequest,
    options: grpc.CallOptions,
    callback: (error: ServiceError | null, reply: DecideReply) => void,
  ): ClientUnaryCall;
}

const packageDefinition = protoLoader.loadSync('proto/policy.proto', {keepCase: true});
const proto = grpc.loadPackageDefinition(packageDefinition) as {
  policy: {PolicyEngine: new (address: string, credentials: grpc.ChannelCredentials) => PolicyEngineClient};
};
const engine = new proto.policy.PolicyEngine('policy-engine:50051', grpc.credentials.createInsecure());

const allowKey = (subject: string, permission: string, scope: string) =>
  \`perm:allow:\${subject}:\${permission}:\${scope}\`;

/** \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` are the only statuses worth another attempt. */
const RETRYABLE: Record<number, true> = {
  [grpcStatus.UNAVAILABLE]: true,
  [grpcStatus.DEADLINE_EXCEEDED]: true,
};

/** A rejection is the engine's answer; retrying it changes nothing. */
function isTerminal(code: number): boolean {
  return code === grpcStatus.PERMISSION_DENIED || code === grpcStatus.UNAUTHENTICATED;
}

async function sleep(ms: number): Promise<void> {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function callEngine(subject: string, permission: string, scope: string): Promise<'ALLOW' | 'DENY'> {
  const {promise, resolve, reject} = Promise.withResolvers<'ALLOW' | 'DENY'>();
  engine.decide({subject, permission, scope}, {deadline: Date.now() + POLICY_TIMEOUT_MS}, (error, reply) => {
    if (error) reject(error);
    else resolve(reply.effect);
  });
  return promise;
}

async function currentGrantVersion(): Promise<number> {
  const value = await redis.get(GRANT_VERSION_KEY);
  return value === null ? 0 : Number.parseInt(value, 10);
}

/** A cached allow counts only while its stored version matches the current counter. */
export async function allowIsCurrent(
  subject: string,
  permission: string,
  scope: string,
  version: number,
): Promise<boolean> {
  const stored = await redis.hget(allowKey(subject, permission, scope), 'grant_version');
  return stored !== null && Number.parseInt(stored, 10) === version;
}

export async function decide(
  subject: string,
  permission: string,
  scope: string,
): Promise<'ALLOW' | 'DENY' | 'UNAVAILABLE'> {
  const version = await currentGrantVersion();
  if (await allowIsCurrent(subject, permission, scope, version)) return 'ALLOW';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const effect = await callEngine(subject, permission, scope);
      if (effect === 'DENY') return 'DENY';
      await redis.hset(allowKey(subject, permission, scope), 'grant_version', String(version), 'effect', 'ALLOW');
      return 'ALLOW';
    } catch (error) {
      const code = (error as ServiceError).code;
      if (isTerminal(code)) return 'DENY';
      if (RETRYABLE[code] !== true || attempt === MAX_ATTEMPTS) break;
      await sleep(BACKOFF_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * BACKOFF_MS));
    }
  }
  return 'UNAVAILABLE';
}

interface CheckBody {
  subject: string;
  permission: string;
  scope: string;
}

app.post('/v1/check', async (request, reply) => {
  const {subject, permission, scope} = request.body as CheckBody;
  const verdict = await decide(subject, permission, scope);
  if (verdict === 'ALLOW') return reply.code(200).send({allowed: true, subject, permission, scope});
  if (verdict === 'DENY') return reply.code(403).send({error: 'policy_denied'});
  return reply.code(503).header('Retry-After', '1').send({error: 'policy_unavailable'});
});

void app.listen({port: 8445, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	policyv1 "permz/gen/policy/v1"
)

const (
	retryLimit  = 3
	allowTTL    = 60 * time.Second
	allowKeyFmt = "perm:allow:%s:%s:%s"
)

var cache = redis.NewClient(&redis.Options{Addr: "perm-cache:6379"})
var engine policyv1.PolicyEngineClient

type CheckRequest struct {
	Subject    string \`json:"subject"\`
	Permission string \`json:"permission"\`
	Scope      string \`json:"scope"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func allowKey(subject, permission, scope string) string {
	return fmt.Sprintf(allowKeyFmt, subject, permission, scope)
}

func decide(ctx context.Context, subject, permission, scope string) string {
	// TODO: the draft calls the engine with no time bound, treats a policy rejection as if the
	// engine were flaky, and returns the last cached allow once every attempt has failed. It fails
	// open on timeout, so an engine outage turns into broad access. Review the whole failure path.
	key := allowKey(subject, permission, scope)
	cached, _ := cache.Get(ctx, key).Result()
	req := &policyv1.DecideRequest{Subject: subject, Permission: permission, Scope: scope}
	for attempt := 0; attempt < retryLimit; attempt++ {
		reply, err := engine.Decide(ctx, req)
		if err != nil {
			continue
		}
		if reply.GetEffect() == "DENY" {
			return "DENY"
		}
		cache.Set(ctx, key, "ALLOW", allowTTL)
		return "ALLOW"
	}
	if cached != "" {
		return "ALLOW"
	}
	return "UNVERIFIED"
}

func check(rw http.ResponseWriter, r *http.Request) {
	var body CheckRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	switch decide(r.Context(), body.Subject, body.Permission, body.Scope) {
	case "ALLOW":
		writeJSON(rw, http.StatusOK, map[string]any{"allowed": true, "subject": body.Subject})
	case "DENY":
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "policy_denied"})
	default:
		writeJSON(rw, http.StatusBadGateway, map[string]string{"error": "policy_unavailable"})
	}
}

func main() {
	conn, err := grpc.NewClient("policy-engine:50051", grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		log.Fatalf("policy engine: %v", err)
	}
	engine = policyv1.NewPolicyEngineClient(conn)

	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/check", check)
	log.Fatal(http.ListenAndServeTLS(":8445", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math/rand"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	policyv1 "permz/gen/policy/v1"
)

const (
	policyTimeoutMs = 400
	maxAttempts     = 2
	backoffMs       = 50
	grantVersionKey = "perm:grant_version"
	allowKeyFmt     = "perm:allow:%s:%s:%s"

	verdictAllow      = "ALLOW"
	verdictDeny       = "DENY"
	verdictUnverified = "UNVERIFIED"
)

var cache = redis.NewClient(&redis.Options{Addr: "perm-cache:6379"})
var engine policyv1.PolicyEngineClient

type CheckRequest struct {
	Subject    string \`json:"subject"\`
	Permission string \`json:"permission"\`
	Scope      string \`json:"scope"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func allowKey(subject, permission, scope string) string {
	return fmt.Sprintf(allowKeyFmt, subject, permission, scope)
}

func grantVersion(ctx context.Context) int64 {
	value, err := cache.Get(ctx, grantVersionKey).Int64()
	if err != nil {
		return 0
	}
	return value
}

// allowIsCurrent reports whether the cached allow carries the current grant_version.
func allowIsCurrent(ctx context.Context, subject, permission, scope string, version int64) bool {
	stored, err := cache.HGet(ctx, allowKey(subject, permission, scope), "grant_version").Int64()
	if err != nil {
		return false
	}
	return stored == version
}

// isTerminal reports whether the status is the engine's answer rather than a transport failure.
func isTerminal(code codes.Code) bool {
	return code == codes.PermissionDenied || code == codes.Unauthenticated
}

func isTransient(code codes.Code) bool {
	return code == codes.Unavailable || code == codes.DeadlineExceeded
}

func backoff(attempt int) time.Duration {
	return time.Duration(backoffMs*(1<<(attempt-1))+rand.IntN(backoffMs)) * time.Millisecond
}

// decide asks the engine for one verdict: ALLOW, DENY or UNVERIFIED (retriable, never an allow).
func decide(ctx context.Context, subject, permission, scope string) string {
	version := grantVersion(ctx)
	if allowIsCurrent(ctx, subject, permission, scope, version) {
		return verdictAllow
	}
	req := &policyv1.DecideRequest{Subject: subject, Permission: permission, Scope: scope}
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, policyTimeoutMs*time.Millisecond)
		reply, err := engine.Decide(callCtx, req)
		cancel()
		if err == nil {
			if reply.GetEffect() == verdictDeny {
				return verdictDeny
			}
			cache.HSet(ctx, allowKey(subject, permission, scope), "grant_version", version, "effect", "ALLOW")
			return verdictAllow
		}
		code := status.Code(err)
		if isTerminal(code) {
			return verdictDeny
		}
		if !isTransient(code) || attempt == maxAttempts {
			break
		}
		time.Sleep(backoff(attempt))
	}
	return verdictUnverified
}

func check(rw http.ResponseWriter, r *http.Request) {
	var body CheckRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	switch decide(r.Context(), body.Subject, body.Permission, body.Scope) {
	case verdictAllow:
		writeJSON(rw, http.StatusOK, map[string]any{"allowed": true, "subject": body.Subject})
	case verdictDeny:
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "policy_denied"})
	default:
		rw.Header().Set("Retry-After", "1")
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "policy_unavailable"})
	}
}

func main() {
	conn, err := grpc.NewClient("policy-engine:50051", grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		log.Fatalf("policy engine: %v", err)
	}
	engine = policyv1.NewPolicyEngineClient(conn)

	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/check", check)
	log.Fatal(http.ListenAndServeTLS(":8445", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class CheckRequest(subject: String, permission: String, scope: String)

sealed trait Verdict
case object Allow extends Verdict
case object Deny extends Verdict
case object Unverified extends Verdict

object PermissionCheck {
  implicit val system: ActorSystem = ActorSystem("permission-service")
  implicit val requestFormat: RootJsonFormat[CheckRequest] = jsonFormat3(CheckRequest)

  val RetryLimit = 3
  val AllowTtlSeconds = 60L

  val cache = AllowCache.open()
  val engine = PolicyEngineClient.open("policy-engine:50051")

  def allowKey(subject: String, permission: String, scope: String): String =
    s"perm:allow:\${subject}:\${permission}:\${scope}"

  def decide(subject: String, permission: String, scope: String): Verdict = {
    // TODO: the draft calls the engine with no time bound, treats a policy rejection as if the
    // engine were flaky, and returns the last cached allow once every attempt has failed. It fails
    // open on timeout, so an engine outage turns into broad access. Review the whole failure path.
    val cached = cache.get(allowKey(subject, permission, scope))
    var attempt = 0
    while (attempt < RetryLimit) {
      try {
        val reply = engine.decide(subject, permission, scope)
        if (reply.effect == "DENY") return Deny
        cache.set(allowKey(subject, permission, scope), "ALLOW", AllowTtlSeconds)
        return Allow
      } catch {
        case _: io.grpc.StatusRuntimeException => attempt += 1
      }
    }
    if (cached.isDefined) Allow else Unverified
  }

  val route: Route =
    path("v1" / "check") {
      post {
        entity(as[CheckRequest]) { req =>
          decide(req.subject, req.permission, req.scope) match {
            case Allow => complete(StatusCodes.OK, """{"allowed":true}""")
            case Deny => complete(StatusCodes.Forbidden, """{"error":"policy_denied"}""")
            case Unverified => complete(StatusCodes.BadGateway, """{"error":"policy_unavailable"}""")
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8445).bind(route)
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import scala.concurrent.{ExecutionContext, Future}
import scala.concurrent.duration._
import scala.util.Random

import io.grpc.{Status, StatusRuntimeException}
import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import org.apache.pekko.pattern.after
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class CheckRequest(subject: String, permission: String, scope: String)
final case class EngineReply(effect: String)

sealed trait Verdict
case object Allow extends Verdict
case object Deny extends Verdict
case object Unverified extends Verdict

object PermissionCheck {
  implicit val system: ActorSystem = ActorSystem("permission-service")
  implicit val ec: ExecutionContext = system.dispatcher
  implicit val requestFormat: RootJsonFormat[CheckRequest] = jsonFormat3(CheckRequest)

  val PolicyTimeoutMs = 400
  val MaxAttempts = 2
  val BackoffMs = 50L
  val GrantVersionKey = "perm:grant_version"

  val cache = AllowCache.open()
  val engine = PolicyEngineClient.open("policy-engine:50051")

  def allowKey(subject: String, permission: String, scope: String): String =
    s"perm:allow:\${subject}:\${permission}:\${scope}"

  def currentGrantVersion(): Future[Long] =
    cache.get(GrantVersionKey).map(_.map(_.toLong).getOrElse(0L))

  /** A cached allow counts only while its stored version matches the current counter. */
  def allowIsCurrent(subject: String, permission: String, scope: String, version: Long): Future[Boolean] =
    cache.hget(allowKey(subject, permission, scope), "grant_version").map(_.exists(_ == version.toString))

  /** A rejection is the engine's answer; retrying it changes nothing. */
  def isTerminal(code: Status.Code): Boolean =
    code == Status.PERMISSION_DENIED || code == Status.UNAUTHENTICATED

  def isTransient(code: Status.Code): Boolean =
    code == Status.UNAVAILABLE || code == Status.DEADLINE_EXCEEDED

  private def callEngine(subject: String, permission: String, scope: String): Future[EngineReply] =
    engine.withDeadlineAfter(PolicyTimeoutMs, TimeUnit.MILLISECONDS).decide(subject, permission, scope)

  private def backoff(attempt: Int): FiniteDuration =
    (BackoffMs * math.pow(2, attempt - 1).toLong + Random.nextLong(BackoffMs)).millis

  private def attempt(
    subject: String,
    permission: String,
    scope: String,
    version: Long,
    n: Int,
  ): Future[Verdict] =
    callEngine(subject, permission, scope)
      .flatMap { reply =>
        if (reply.effect == "DENY") Future.successful(Deny)
        else
          cache
            .hset(allowKey(subject, permission, scope), "grant_version", version.toString, "effect", "ALLOW")
            .map(_ => Allow)
      }
      .recoverWith {
        case e: StatusRuntimeException =>
          val code = e.getStatus.getCode
          if (isTerminal(code)) Future.successful(Deny)
          else if (isTransient(code) && n < MaxAttempts)
            after(backoff(n), system.scheduler)(attempt(subject, permission, scope, version, n + 1))
          else Future.successful(Unverified)
      }

  def decide(subject: String, permission: String, scope: String): Future[Verdict] =
    currentGrantVersion().flatMap { version =>
      allowIsCurrent(subject, permission, scope, version).flatMap { current =>
        if (current) Future.successful(Allow)
        else attempt(subject, permission, scope, version, n = 1)
      }
    }

  val route: Route =
    path("v1" / "check") {
      post {
        entity(as[CheckRequest]) { req =>
          onSuccess(decide(req.subject, req.permission, req.scope)) {
            case Allow => complete(StatusCodes.OK, """{"allowed":true}""")
            case Deny => complete(StatusCodes.Forbidden, """{"error":"policy_denied"}""")
            case Unverified =>
              respondWithHeader(RawHeader("Retry-After", "1")) {
                complete(StatusCodes.ServiceUnavailable, """{"error":"policy_unavailable"}""")
              }
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8445).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>
#include <httplib.h>
#include <nlohmann/json.hpp>
#include <redis++/redis++.h>

#include <chrono>
#include <string>

#include "policy.grpc.pb.h"

namespace {

constexpr int kRetryLimit = 3;
constexpr int kAllowTtlSeconds = 60;

std::string allowKey(const std::string& subject, const std::string& permission, const std::string& scope) {
  return "perm:allow:" + subject + ":" + permission + ":" + scope;
}

}  // namespace

int main() {
  auto redis = sw::redis::Redis("tcp://perm-cache:6379");
  auto channel = grpc::CreateChannel("policy-engine:50051", grpc::InsecureChannelCredentials());
  auto engine = policy::PolicyEngine::NewStub(channel);

  httplib::Server svr;

  svr.Post("/v1/check", [&](const httplib::Request& req, httplib::Response& res) {
    const auto body = nlohmann::json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    const std::string subject = body.value("subject", std::string());
    const std::string permission = body.value("permission", std::string());
    const std::string scope = body.value("scope", std::string());
    const std::string key = allowKey(subject, permission, scope);
    const auto cached = redis.get(key);

    // TODO: the draft calls the engine with no time bound, treats a policy rejection as if the
    // engine were flaky, and returns the last cached allow once every attempt has failed. It fails
    // open on timeout, so an engine outage turns into broad access. Review the whole failure path.
    policy::DecideRequest request;
    request.set_subject(subject);
    request.set_permission(permission);
    request.set_scope(scope);

    policy::DecideReply reply;
    grpc::Status status;
    for (int attempt = 0; attempt < kRetryLimit; ++attempt) {
      grpc::ClientContext context;
      status = engine->Decide(&context, request, &reply);
      if (status.ok()) break;
    }
    if (!status.ok()) {
      if (cached) {
        res.status = 200;
        res.set_content(R"({"allowed":true,"source":"cache"})", "application/json");
        return;
      }
      res.status = 502;
      res.set_content(R"({"error":"policy_unavailable"})", "application/json");
      return;
    }
    if (reply.effect() == "DENY") {
      res.status = 403;
      res.set_content(R"({"error":"policy_denied"})", "application/json");
      return;
    }
    redis->set(key, "ALLOW", std::chrono::milliseconds(kAllowTtlSeconds * 1000));
    res.status = 200;
    res.set_content(R"({"allowed":true})", "application/json");
  });

  svr.listen("0.0.0.0", 8445);
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <httplib.h>
#include <nlohmann/json.hpp>
#include <redis++/redis++.h>

#include <chrono>
#include <random>
#include <string>
#include <thread>

#include "policy.grpc.pb.h"

namespace {

constexpr int kPolicyTimeoutMs = 400;
constexpr int kMaxAttempts = 2;
constexpr int kBackoffMs = 50;
const std::string kGrantVersionKey = "perm:grant_version";

std::string allowKey(const std::string& subject, const std::string& permission, const std::string& scope) {
  return "perm:allow:" + subject + ":" + permission + ":" + scope;
}

// A rejection is the engine's answer; retrying it changes nothing.
bool isTerminal(grpc::StatusCode code) {
  return code == grpc::StatusCode::PERMISSION_DENIED || code == grpc::StatusCode::UNAUTHENTICATED;
}

bool isTransient(grpc::StatusCode code) {
  return code == grpc::StatusCode::UNAVAILABLE || code == grpc::StatusCode::DEADLINE_EXCEEDED;
}

std::chrono::milliseconds backoff(int attempt) {
  static std::mt19937 rng(std::random_device{}());
  std::uniform_int_distribution<int> jitter(0, kBackoffMs);
  return std::chrono::milliseconds(kBackoffMs * (1 << (attempt - 1)) + jitter(rng));
}

enum class Verdict { kAllow, kDeny, kUnverified };

}  // namespace

int main() {
  auto redis = sw::redis::Redis("tcp://perm-cache:6379");
  auto channel = grpc::CreateChannel("policy-engine:50051", grpc::InsecureChannelCredentials());
  auto engine = policy::PolicyEngine::NewStub(channel);

  const auto grantVersion = [&]() -> long long {
    const auto value = redis->get(kGrantVersionKey);
    return value ? std::stoll(*value) : 0LL;
  };

  // allowIsCurrent reports whether the cached allow carries the current grant_version.
  const auto allowIsCurrent = [&](const std::string& subject, const std::string& permission, const std::string& scope,
                                  long long version) -> bool {
    const auto stored = redis->hget(allowKey(subject, permission, scope), "grant_version");
    return stored && std::stoll(*stored) == version;
  };

  const auto decide = [&](const std::string& subject, const std::string& permission,
                          const std::string& scope) -> Verdict {
    const long long version = grantVersion();
    if (allowIsCurrent(subject, permission, scope, version)) return Verdict::kAllow;

    policy::DecideRequest request;
    request.set_subject(subject);
    request.set_permission(permission);
    request.set_scope(scope);

    for (int attempt = 1; attempt <= kMaxAttempts; ++attempt) {
      grpc::ClientContext context;
      context.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kPolicyTimeoutMs));
      policy::DecideReply reply;
      const grpc::Status status = engine->Decide(&context, request, &reply);
      if (status.ok()) {
        if (reply.effect() == "DENY") return Verdict::kDeny;
        redis->hset(allowKey(subject, permission, scope), "grant_version", std::to_string(version));
        return Verdict::kAllow;
      }
      if (isTerminal(status.error_code())) return Verdict::kDeny;
      if (!isTransient(status.error_code()) || attempt == kMaxAttempts) break;
      std::this_thread::sleep_for(backoff(attempt));
    }
    return Verdict::kUnverified;
  };

  httplib::Server svr;

  svr.Post("/v1/check", [&](const httplib::Request& req, httplib::Response& res) {
    const auto body = nlohmann::json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    const std::string subject = body.value("subject", std::string());
    const std::string permission = body.value("permission", std::string());
    const std::string scope = body.value("scope", std::string());

    switch (decide(subject, permission, scope)) {
      case Verdict::kAllow:
        res.status = 200;
        res.set_content(R"({"allowed":true})", "application/json");
        return;
      case Verdict::kDeny:
        res.status = 403;
        res.set_content(R"({"error":"policy_denied"})", "application/json");
        return;
      case Verdict::kUnverified:
        res.status = 503;
        res.set_header("Retry-After", "1");
        res.set_content(R"({"error":"policy_unavailable"})", "application/json");
        return;
    }
  });

  svr.listen("0.0.0.0", 8445);
}
`,
    },
  },
  debrief: `The interviewer is asking one question in five costumes: what does this service do when the component that decides permissions does not answer? The draft answers "allow", which is exactly why it is dangerous — every failure mode of the policy engine becomes a grant. A deadline bounds one attempt; a small attempt budget bounds the call; the retryable set of two transport codes and nothing else stops a deliberate rejection from being re-rolled into a second roll of the dice; and the cache is keyed to the grant version so an allow cannot outlive the revocation that invalidated it. Real deployments add a jittered backoff shared across replicas, a concurrency cap or breaker around the engine so a slow engine cannot drain the request pool, a Retry-After aligned with their own backoff so clients do not stampede on recovery, and a counter on the deny-by-outage path — because that number is how you find out that your safety property is carrying production traffic.`,
};
