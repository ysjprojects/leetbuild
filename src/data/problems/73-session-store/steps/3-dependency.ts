import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Auth validation: a short cache that fails closed',
  concept: 'grpc',
  file: 'dependency',
  focus: ['api', 'auth'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it calls the auth service to validate a
token and caches the answer so every request does not pay a round trip. It compiles, it serves the demo, and it
hides four production flaws. Review it like the service owner, fix it, and prove the fix with the checks below.

Implement \`validate(token)\` against the auth service's gRPC \`Validate\` method.

- **Deadline.** Every validation carries a \`DEADLINE_MS\` deadline of **150 ms**; a call that misses it must not
  hold the request open.
- **Short positive cache.** A successful validation may be cached, but only for \`CACHE_TTL_S\` = **30 seconds**,
  so a revocation is visible inside the window.
- **Fail closed.** A timeout or an unavailable auth service **denies** the request; the draft's habit of
  returning the last known claims on failure is exactly how a revoked session keeps working during an outage.
- **Revocation reaches the cache.** \`revoke(token)\` drops the cached entry immediately, so the next request
  re-validates rather than trusting the copy.
- **Rejections are terminal.** \`UNAUTHENTICATED\` and \`PERMISSION_DENIED\` are never retried; only a transient
  failure may be retried, and even then the deadline still applies.

**Failure mode the checks target.** The draft caches a validation for an hour and, when the auth service is down,
answers from that cache — so a token revoked ten minutes ago still authenticates. It has no deadline, so a slow
auth service becomes a slow session layer. And it retries a rejection three times, turning a correct "no" into
load on a service that already said no.`,
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
    'What should a request do when the auth service cannot answer? The draft answers with the last copy it saw — say out loud why that is a revocation bypass.',
    'A cache is only as safe as its window. How long may a validated token stay trusted after the auth service has already revoked it?',
    'Not every gRPC status is retryable. Which two mean "the caller is wrong" and must end the request on the first answer?',
  ],
  checks: [
    {
      id: 'deadline',
      title: 'Sets a 150 ms deadline on every validation',
      detail:
        'Each `Validate` call carries `DEADLINE_MS` = 150, so a slow auth service cannot hold a session request open. The draft calls the stub with a 5-second timeout and no deadline constant.',
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
        'A hit is served from `cache` only within `CACHE_TTL_S` = 30 seconds. The draft caches for an hour, so a revocation takes an hour to be seen.',
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
        'A deadline miss or an unavailable auth service denies the request instead of returning stale claims. The draft returns the cached copy — fail open.',
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
        '`revoke(token)` deletes the cache entry, so the next request re-validates. The draft’s revoke never touches the cache, so a revoked token keeps validating until the TTL ends.',
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
        '`UNAUTHENTICATED` and `PERMISSION_DENIED` are classified as terminal and never retried. The draft retries every status three times.',
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
    # TODO: the cache lives an hour and a failed call falls back to the stale copy, so a revoked
    # token keeps working and an auth outage is answered with old claims.
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
    # TODO: revocation never reaches the cache.
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
  // TODO: the cache lives an hour and a failed call falls back to the stale copy, so a revoked
  // token keeps working and an auth outage is answered with old claims.
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
  // TODO: revocation never reaches the cache.
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
	// TODO: the cache lives an hour and a failed call falls back to the stale copy, so a revoked
	// token keeps working and an auth outage is answered with old claims.
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
	// TODO: revocation never reaches the cache.
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

  // TODO: the cache lives an hour and a failed call falls back to the stale copy, so a revoked token
  // keeps working and an auth outage is answered with old claims.
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
    // TODO: revocation never reaches the cache.
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

// TODO: the cache lives an hour and a failed call falls back to the stale copy, so a revoked token
// keeps working and an auth outage is answered with old claims.
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
  // TODO: revocation never reaches the cache.
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
  debrief: `The interviewer is testing whether you can review a generated dependency for the failure modes that matter when the dependency is unavailable. Four defects are being checked: a long cache window means a revocation is not seen until the window ends; a missing deadline turns a slow auth service into a slow session layer; failing open on a timeout returns the exact stale claims a revoker was trying to invalidate; and retrying a rejection multiplies a correct "no" into load. The habits to name out loud are: bound every remote call with a deadline, keep the trust window short and invalidate it on the event that matters, deny when you cannot verify, and never retry a decision the server has already made. Real services add a negative cache with a very short TTL, a circuit breaker on the auth path, and a metric on cache hit rate next to one on revocation-to-invalidation latency.`,
};
