import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Auth validation: a short cache that fails closed',
  concept: 'grpc',
  file: 'dependency',
  focus: ['api', 'auth'],
  task: `## Task

**Starting point.** The starter's \`validate(token)\` calls the auth service's gRPC \`Validate\`
method with a 5-second timeout, retries any error three times, caches a successful answer for an
hour and, when every attempt fails, returns the cached claims. \`revoke(token)\` is a no-op. It
compiles and hides 5 flaws.

**Failure mode the checks target.** The starter caches a validation for an hour and, when the auth service is down,
answers from that cache, so a token revoked ten minutes ago still authenticates. It has no deadline, so a slow
auth service becomes a slow session layer. And it retries a rejection three times, turning a correct "no" into
load on a service that already said no.

Requirements:

- **Deadline.** Every validation carries a \`DEADLINE_MS\` deadline of **150 ms**; a call that misses it must not
  hold the request open.
- **Short positive cache.** A successful validation may be cached, but only for \`CACHE_TTL_S\` = **30 seconds**,
  so a revocation is visible inside the window.
- **Fail closed.** A timeout or an unavailable auth service **denies** the request; returning the last known
  claims on failure is exactly how a revoked session keeps working during an outage.
- **Revocation reaches the cache.** \`revoke(token)\` drops the cached entry immediately, so the next request
  re-validates rather than trusting the copy.
- **Rejections are terminal.** \`UNAUTHENTICATED\` and \`PERMISSION_DENIED\` are not retried; only a transient
  failure may be retried, and even then the deadline still applies.`,
  sequence: {
    participants: ['Session API', 'Auth Service', 'Session Cache'],
    messages: [
      {from: 'Session API', to: 'Session Cache', label: 'get(token)', kind: 'sync'},
      {from: 'Session Cache', to: 'Session API', label: 'claims / miss', kind: 'reply'},
      {from: 'Session API', to: 'Auth Service', label: 'Validate(token) · deadline 150 ms', kind: 'sync'},
      {from: 'Auth Service', to: 'Session API', label: 'claims / UNAUTHENTICATED', kind: 'reply'},
      {from: 'Session API', to: 'Session Cache', label: 'set(token, claims, CACHE_TTL_S)', kind: 'async'},
      {from: 'Session API', to: 'Auth Service', label: 'Revoke(token) invalidates the cache', kind: 'sync'},
    ],
  },
  hints: [
    'An operator revokes a stolen token; the attacker keeps browsing for the rest of the hour, and during an auth outage every cached session keeps working while new logins hang for 15 seconds.',
    'The cache window is 3600 s and `revoke` leaves it untouched; after three failed attempts the fallback returns `hit[0]`; and the loop retries every `RpcError`, rejections included, with a 5 s timeout.',
    'Set `CACHE_TTL_S = 30` and `DEADLINE_MS = 150`, return `None` on `DEADLINE_EXCEEDED` or `UNAVAILABLE`, stop on `TERMINAL_CODES` (`UNAUTHENTICATED`, `PERMISSION_DENIED`), and make `revoke` call `cache.pop(token, None)`.',
  ],
  checks: [
    {
      id: 'deadline',
      title: 'Sets a 150 ms deadline on every validation',
      detail:
        'Each `Validate` call carries `DEADLINE_MS` = 150, so a slow auth service cannot hold a session request open. The starter calls the stub with a 5-second timeout and no deadline constant.',
      match: {
        python: {all: [/DEADLINE_MS/, /timeout\s*=/]},
        typescript: {all: [/DEADLINE_MS/, /deadline\s*:/]},
        go: {all: [/deadlineMS/, /WithTimeout\(/]},
        scala: {all: [/DeadlineMs/, /withDeadlineAfter\(/]},
        cpp: {all: [/kDeadlineMs/, /deadline/]},
      },
    },
    {
      id: 'short-cache',
      title: 'Caches a positive validation for 30 seconds',
      detail:
        'A hit is served from `cache` only within `CACHE_TTL_S` = 30 seconds. The starter caches for an hour, so a revocation takes an hour to be seen.',
      match: {
        python: {all: [/CACHE_TTL_S\s*=\s*30/, /cache\.get\(/]},
        typescript: {all: [/CACHE_TTL_S\s*=\s*30/, /cache\.get\(/]},
        go: {all: [/cacheTTLS\s*=\s*30/, /cache\[token\]/]},
        scala: {all: [/CacheTtlS[^=\n]*=\s*30/, /cache\.get\(/]},
        cpp: {all: [/kCacheTtlS\s*=\s*30/, /cache\.find\(/]},
      },
    },
    {
      id: 'fail-closed',
      title: 'Denies the request when the auth service times out',
      detail:
        'A deadline miss or an unavailable auth service denies the request instead of returning stale claims. The starter returns the cached copy — fail open.',
      match: {
        python: {all: [/DEADLINE_EXCEEDED/, /return None/]},
        typescript: {all: [/DEADLINE_EXCEEDED/, /return null/]},
        go: {all: [/DeadlineExceeded/, /return nil/]},
        scala: {all: [/DEADLINE_EXCEEDED/, /None/]},
        cpp: {all: [/DEADLINE_EXCEEDED/, /std::nullopt/]},
      },
    },
    {
      id: 'revoke-visible',
      title: 'Drops the cached entry on revocation',
      detail:
        '`revoke(token)` deletes the cache entry, so the next request re-validates. The starter’s revoke never touches the cache, so a revoked token keeps validating until the TTL ends.',
      match: {
        python: {all: [/def revoke\(/, /cache\.pop\(/]},
        typescript: {all: [/function revoke\(/, /cache\.delete\(/]},
        go: {all: [/func Revoke\(/, /delete\(cache,\s*token\)/]},
        scala: {all: [/def revoke\(/, /cache\.removed\(/]},
        cpp: {all: [/void revoke\(/, /cache\.erase\(/]},
      },
    },
    {
      id: 'terminal-reject',
      title: 'Treats a rejection as terminal',
      detail:
        '`UNAUTHENTICATED` and `PERMISSION_DENIED` are classified as terminal and never retried. The starter retries every status three times.',
      match: {
        python: {all: [/TERMINAL_CODES/, /PERMISSION_DENIED/]},
        typescript: {all: [/TERMINAL_CODES/, /PERMISSION_DENIED/]},
        go: {all: [/terminalCodes/, /PermissionDenied/]},
        scala: {all: [/TerminalCodes/, /PERMISSION_DENIED/]},
        cpp: {all: [/kTerminalCodes/, /PERMISSION_DENIED/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import grpc

from auth_pb2 import ValidateRequest
from auth_pb2_grpc import AuthServiceStub

CACHE_TTL_S = 3600

cache: dict[str, tuple[dict, float]] = {}


async def validate(stub: AuthServiceStub, token: str) -> dict | None:
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    now = time.time()
    hit = cache.get(token)
    if hit is not None and now < hit[1]:
        return hit[0]
    for _ in range(3):
        try:
            resp = await stub.Validate(ValidateRequest(token=token), timeout=5)
        except grpc.RpcError:
            continue
        claims = {"user_id": resp.user_id, "device_class": resp.device_class, "auth_assertion": True}
        cache[token] = (claims, now + CACHE_TTL_S)
        return claims
    return hit[0] if hit is not None else {"user_id": "anonymous", "auth_assertion": True}


def revoke(token: str) -> None:
    return None
`,
      solution: `import time

import grpc

from auth_pb2 import ValidateRequest
from auth_pb2_grpc import AuthServiceStub

DEADLINE_MS = 150
CACHE_TTL_S = 30

TERMINAL_CODES = frozenset({grpc.StatusCode.UNAUTHENTICATED, grpc.StatusCode.PERMISSION_DENIED})

cache: dict[str, tuple[dict, float]] = {}


async def validate(stub: AuthServiceStub, token: str) -> dict | None:
    now = time.time()
    hit = cache.get(token)
    if hit is not None and now < hit[1]:
        return hit[0]
    try:
        resp = await stub.Validate(ValidateRequest(token=token), timeout=DEADLINE_MS / 1000)
    except grpc.RpcError as err:
        # A rejection is terminal; a timeout or an outage denies the request instead of trusting a copy.
        if err.code() in TERMINAL_CODES:
            return None
        if err.code() in (grpc.StatusCode.DEADLINE_EXCEEDED, grpc.StatusCode.UNAVAILABLE):
            return None
        return None
    claims = {"user_id": resp.user_id, "device_class": resp.device_class, "auth_assertion": True}
    cache[token] = (claims, now + CACHE_TTL_S)
    return claims


def revoke(token: str) -> None:
    # Revocation must be visible within the cache window, so the entry is dropped immediately.
    cache.pop(token, None)
`,
    },
    typescript: {
      starter: `import {credentials} from '@grpc/grpc-js';
import {AuthServiceClient} from './auth_grpc_pb';

const CACHE_TTL_S = 3600;

const cache = new Map<string, {claims: Record<string, unknown>; expiresAt: number}>();
const client = new AuthServiceClient('auth:50051', credentials.createInsecure());

export async function validate(token: string): Promise<Record<string, unknown> | null> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const now = Date.now();
  const hit = cache.get(token);
  if (hit !== undefined && now < hit.expiresAt) {
    return hit.claims;
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const claims = await callValidate(client, token);
      cache.set(token, {claims, expiresAt: now + CACHE_TTL_S * 1000});
      return claims;
    } catch {
      continue;
    }
  }
  return hit?.claims ?? {user_id: 'anonymous', auth_assertion: true};
}

function callValidate(client: AuthServiceClient, token: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    client.validate({token}, (err, res) => (err ? reject(err) : resolve(res.toObject())));
  });
}

export function revoke(token: string): void {
  void token;
}
`,
      solution: `import {credentials, status} from '@grpc/grpc-js';
import {AuthServiceClient} from './auth_grpc_pb';

const DEADLINE_MS = 150;
const CACHE_TTL_S = 30;

const TERMINAL_CODES = new Set([status.UNAUTHENTICATED, status.PERMISSION_DENIED]);

const cache = new Map<string, {claims: Record<string, unknown>; expiresAt: number}>();
const client = new AuthServiceClient('auth:50051', credentials.createInsecure());

export async function validate(token: string): Promise<Record<string, unknown> | null> {
  const now = Date.now();
  const hit = cache.get(token);
  if (hit !== undefined && now < hit.expiresAt) {
    return hit.claims;
  }
  try {
    const claims = await callValidate(client, token);
    cache.set(token, {claims, expiresAt: now + CACHE_TTL_S * 1000});
    return claims;
  } catch (err) {
    const code = (err as {code?: number}).code;
    // A rejection is terminal; a timeout or an outage denies the request instead of trusting a copy.
    if (code !== undefined && TERMINAL_CODES.has(code)) {
      return null;
    }
    if (code === status.DEADLINE_EXCEEDED || code === status.UNAVAILABLE) {
      return null;
    }
    return null;
  }
}

function callValidate(client: AuthServiceClient, token: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    client.validate({token}, {deadline: Date.now() + DEADLINE_MS}, (err, res) =>
      err ? reject(err) : resolve(res.toObject()),
    );
  });
}

export function revoke(token: string): void {
  // Revocation must be visible within the cache window, so the entry is dropped immediately.
  cache.delete(token);
}
`,
    },
    go: {
      starter: `package session

import (
	"context"
	"time"

	"google.golang.org/grpc"

	authpb "sessiond/authpb"
)

const cacheTTLS = 3600

type cachedClaims struct {
	claims    *authpb.Claims
	expiresAt time.Time
}

var cache = map[string]cachedClaims{}

func Validate(ctx context.Context, client authpb.AuthServiceClient, token string) (*authpb.Claims, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	hit, ok := cache[token]
	if ok && time.Now().Before(hit.expiresAt) {
		return hit.claims, nil
	}
	var last error
	for attempt := 0; attempt < 3; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		claims, err := client.Validate(callCtx, &authpb.ValidateRequest{Token: token})
		cancel()
		if err != nil {
			last = err
			continue
		}
		cache[token] = cachedClaims{claims: claims, expiresAt: time.Now().Add(cacheTTLS * time.Second)}
		return claims, nil
	}
	if ok {
		return hit.claims, nil
	}
	return nil, last
}

func Revoke(token string) {
}
`,
      solution: `package session

import (
	"context"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	authpb "sessiond/authpb"
)

const (
	deadlineMS = 150
	cacheTTLS  = 30
)

var terminalCodes = map[codes.Code]bool{
	codes.Unauthenticated: true,
	codes.PermissionDenied: true,
}

type cachedClaims struct {
	claims    *authpb.Claims
	expiresAt time.Time
}

var cache = map[string]cachedClaims{}

func Validate(ctx context.Context, client authpb.AuthServiceClient, token string) (*authpb.Claims, error) {
	hit, ok := cache[token]
	if ok && time.Now().Before(hit.expiresAt) {
		return hit.claims, nil
	}
	callCtx, cancel := context.WithTimeout(ctx, deadlineMS*time.Millisecond)
	defer cancel()
	claims, err := client.Validate(callCtx, &authpb.ValidateRequest{Token: token})
	if err != nil {
		// A rejection is terminal; a timeout or an outage denies the request instead of trusting a copy.
		if terminalCodes[status.Code(err)] {
			return nil, err
		}
		if status.Code(err) == codes.DeadlineExceeded {
			return nil, err
		}
		return nil, err
	}
	cache[token] = cachedClaims{claims: claims, expiresAt: time.Now().Add(cacheTTLS * time.Second)}
	return claims, nil
}

func Revoke(token string) {
	// Revocation must be visible within the cache window, so the entry is dropped immediately.
	delete(cache, token)
}
`,
    },
    scala: {
      starter: `package session

import scala.concurrent.{ExecutionContext, Future}

import auth.AuthServiceGrpc
import auth.AuthServiceGrpc.AuthServiceBlockingStub

object AuthValidation {
  val CacheTtlS: Long = 3600

  private var cache: Map[String, Claims] = Map.empty

  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  def validate(stub: AuthServiceGrpc.AuthServiceBlockingStub, token: String): Option[Claims] = {
    cache.get(token) match {
      case Some(claims) => Some(claims)
      case None =>
        var last: Option[Claims] = None
        var attempt = 0
        while (attempt < 3 && last.isEmpty) {
          try {
            val claims = stub.withDeadlineAfter(5, java.util.concurrent.TimeUnit.SECONDS).validate(token)
            cache = cache.updated(token, claims)
            last = Some(claims)
          } catch {
            case _: Throwable => attempt += 1
          }
        }
        last
    }
  }

  def revoke(token: String): Unit = {
  }
}
`,
      solution: `package session

import auth.AuthServiceGrpc
import auth.AuthServiceGrpc.AuthServiceBlockingStub
import io.grpc.Status

object AuthValidation {
  val DeadlineMs: Long = 150
  val CacheTtlS: Long = 30

  val TerminalCodes: Set[Status.Code] =
    Set(Status.Code.UNAUTHENTICATED, Status.Code.PERMISSION_DENIED)

  private var cache: Map[String, (Claims, Long)] = Map.empty

  def validate(stub: AuthServiceGrpc.AuthServiceBlockingStub, token: String): Option[Claims] = {
    val now = System.currentTimeMillis()
    cache.get(token) match {
      case Some((claims, expiresAt)) if now < expiresAt => Some(claims)
      case _ =>
        try {
          val claims = stub.withDeadlineAfter(DeadlineMs, java.util.concurrent.TimeUnit.MILLISECONDS).validate(token)
          cache = cache.updated(token, (claims, now + CacheTtlS * 1000))
          Some(claims)
        } catch {
          // A rejection is terminal; a timeout or an outage denies the request instead of trusting a copy.
          case e: io.grpc.StatusRuntimeException =>
            if (TerminalCodes.contains(e.getStatus.getCode)) None
            else if (e.getStatus.getCode == Status.Code.DEADLINE_EXCEEDED) None
            else None
        }
    }
  }

  def revoke(token: String): Unit = {
    // Revocation must be visible within the cache window, so the entry is dropped immediately.
    cache = cache.removed(token)
  }
}
`,
    },
    cpp: {
      starter: `#include <chrono>
#include <string>
#include <unordered_map>

#include <grpcpp/grpcpp.h>

#include "auth.grpc.pb.h"

namespace session {

constexpr int kCacheTtlS = 3600;

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
std::optional<auth::Claims> validate(auth::AuthService::Stub& stub, const std::string& token) {
  static std::unordered_map<std::string, auth::Claims> cache;
  const auto hit = cache.find(token);
  if (hit != cache.end()) {
    return hit->second;
  }
  for (int attempt = 0; attempt < 3; ++attempt) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(5));
    auth::ValidateRequest req;
    req.set_token(token);
    auth::Claims claims;
    const auto status = stub.Validate(&ctx, req, &claims);
    if (status.ok()) {
      cache[token] = claims;
      return claims;
    }
  }
  return std::nullopt;
}

void revoke(const std::string& token) {
}

}  // namespace session
`,
      solution: `#include <chrono>
#include <optional>
#include <string>
#include <unordered_map>

#include <grpcpp/grpcpp.h>

#include "auth.grpc.pb.h"

namespace session {

constexpr int kDeadlineMs = 150;
constexpr int kCacheTtlS = 30;

const std::unordered_map<grpc::StatusCode, bool> kTerminalCodes = {
    {grpc::StatusCode::UNAUTHENTICATED, true},
    {grpc::StatusCode::PERMISSION_DENIED, true},
};

std::unordered_map<std::string, auth::Claims> cache;

std::optional<auth::Claims> validate(auth::AuthService::Stub& stub, const std::string& token) {
  const auto hit = cache.find(token);
  if (hit != cache.end()) {
    return hit->second;
  }
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kDeadlineMs));
  auth::ValidateRequest req;
  req.set_token(token);
  auth::Claims claims;
  const auto status = stub.Validate(&ctx, req, &claims);
  if (!status.ok()) {
    // A rejection is terminal; a timeout or an outage denies the request instead of trusting a copy.
    if (kTerminalCodes.count(status.error_code()) > 0) {
      return std::nullopt;
    }
    if (status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED) {
      return std::nullopt;
    }
    return std::nullopt;
  }
  cache[token] = claims;
  return claims;
}

void revoke(const std::string& token) {
  // Revocation must be visible within the cache window, so the entry is dropped immediately.
  cache.erase(token);
}

}  // namespace session
`,
    },
  },
  debrief: `The fix has this shape because a validation path can only be as trustworthy as its least trustworthy answer. A 150 ms deadline bounds what a slow auth service can cost a request. A 30-second cache keeps the round-trip savings while capping how long a revoked token outlives its revocation, and \`revoke\` dropping the entry makes that cap zero for the case that matters most. Returning \`None\` on a timeout is the uncomfortable choice: it means an auth outage logs people out, which is the correct trade against an outage that keeps revoked sessions alive. Classifying \`UNAUTHENTICATED\` and \`PERMISSION_DENIED\` as terminal stops the client from retrying a decision the server already made. Production auth clients add a short negative cache, a circuit breaker on the auth path, and a metric on revocation-to-invalidation latency.`,
};
