import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Token validation: a short cache that fails closed',
  concept: 'grpc',
  guides: ['deadlines-and-retries', 'failing-dependencies'],
  file: 'auth_client',
  focus: ['api', 'auth'],
  task: `## Task

**Starting point.** The starter is the client every request uses to check a bearer token with the
auth service (gRPC \`sessionauth.Auth\` in \`session_store.proto\`, at \`auth:9000\`).
\`validate(token)\` answers claims from an in-process cache for up to \`CACHE_TTL_S\` = 3600 s; on a
miss it calls \`Validate\` with a 5-second timeout, up to three times whatever the error, caches the
answer, and when every attempt fails answers the claims it cached last, however old.
\`revoke(token)\` calls \`Revoke\`. It serves the demo and hides five flaws.

**Failure mode the checks target.** A token revoked at the auth service keeps validating for an
hour. A slow auth service holds every request for five seconds. An outage signs in every user the
cache ever saw. A token the auth service rejected is sent three times.

- Every call carries a 150 ms deadline (\`DEADLINE_S\` = 0.15, \`DEADLINE_MS\` = 150).
- A positive answer is cached for \`CACHE_TTL_S\` = 30 s at most.
- A deadline, \`UNAVAILABLE\` or any other failure denies the request (no claims); nothing older than
  the cache window is answered.
- \`revoke\` drops the token's cache entry.
- \`UNAUTHENTICATED\` is the answer: one call, no retry.`,
  sequence: {
    participants: ['Session API', 'Cache', 'Auth service'],
    messages: [
      {from: 'Session API', to: 'Cache', label: 'claims(token) younger than 30 s?', kind: 'sync'},
      {from: 'Session API', to: 'Auth service', label: 'Validate(token) · deadline 150 ms', kind: 'sync'},
      {from: 'Auth service', to: 'Session API', label: 'Claims / UNAUTHENTICATED / DEADLINE_EXCEEDED', kind: 'reply'},
      {from: 'Session API', to: 'Cache', label: 'claims → keep 30 s; anything else → deny', kind: 'sync'},
      {from: 'Session API', to: 'Cache', label: 'revoke: drop the entry', kind: 'sync'},
      {from: 'Session API', to: 'Auth service', label: 'Revoke(token)', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every validation carries a 150 ms deadline',
      detail:
        'Each `Validate` call carries a deadline between 100 and 200 ms, and an auth service that takes a second to answer is a denial. The starter allows five seconds.',
      match: {
        python: {all: [/timeout\s*=\s*(DEADLINE_S|0?\.15)\b/], none: [/timeout\s*=\s*5\b/]},
        typescript: {
          all: [/deadline:\s*Date\.now\(\)\s*\+\s*(DEADLINE_MS|150)\b/],
          none: [/Date\.now\(\)\s*\+\s*5000/],
        },
        go: {
          all: [/WithTimeout\(\s*ctx,\s*(deadline|150\s*\*\s*time\.Millisecond)\s*\)/],
          none: [/5\s*\*\s*time\.Second/],
        },
        scala: {
          all: [/withDeadlineAfter\(\s*(DeadlineMs|150L?),\s*TimeUnit\.MILLISECONDS/],
          none: [/withDeadlineAfter\(\s*5,\s*TimeUnit\.SECONDS/],
        },
        cpp: {all: [/now\(\)\s*\+\s*(kDeadline|std::chrono::milliseconds\{150\})/], none: [/seconds\{5\}/]},
      },
    },
    {
      id: 'short-cache',
      title: 'A positive answer is cached for 30 seconds',
      detail:
        'A second validation 10 s later comes from the cache; 35 s after the first, a token the auth service has since revoked no longer validates. The starter trusts a cached answer for an hour.',
      match: {
        python: {all: [/CACHE_TTL_S\s*=\s*30\b/]},
        typescript: {all: [/CACHE_TTL_S\s*=\s*30\b/]},
        go: {all: [/cacheTTL\s*=\s*30\s*\*\s*time\.Second/]},
        scala: {all: [/CacheTtlS\s*=\s*30L?\b/]},
        cpp: {all: [/kCacheTtl\{30\}/]},
      },
    },
    {
      id: 'fail-closed',
      title: 'An unreachable auth service denies the request',
      detail:
        'An hour after a token was cached, with the auth service answering `UNAVAILABLE`, validation answers no claims. The starter falls back to the claims it cached last.',
      match: {
        python: {none: [/except grpc\.RpcError[\s\S]*return hit\[0\]/]},
        typescript: {none: [/catch[\s\S]*return hit\.claims/]},
        go: {none: [/if found \{\s*return hit\.claims/]},
        scala: {none: [/orElse\(hit\.map\(_\._1\)\)/]},
        cpp: {none: [/if \(hit != cache\.end\(\)\) return hit->second\.claims/]},
      },
    },
    {
      id: 'revoke-visible',
      title: 'A revocation reaches the cache',
      detail:
        'Right after `revoke(token)` the token no longer validates. The starter tells the auth service and keeps the cached claims.',
      match: {
        python: {order: [/def revoke\(/, /cache\.pop\(/]},
        typescript: {order: [/function revoke\(/, /cache\.delete\(/]},
        go: {order: [/func revoke\(/, /delete\(cache,/]},
        scala: {order: [/def revoke\(/, /cache\.remove\(/]},
        cpp: {order: [/void revoke\(/, /cache\.erase\(/]},
      },
    },
    {
      id: 'terminal-reject',
      title: 'A rejection is not retried',
      detail:
        'A token the auth service answers `UNAUTHENTICATED` costs one `Validate` call. The starter retries every error three times.',
      match: {
        python: {none: [/for _ in range\(/]},
        typescript: {none: [/for \(let attempt/]},
        go: {none: [/for attempt := /]},
        scala: {none: [/\(1 to 3\)/]},
        cpp: {none: [/for \(int attempt/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import grpc

import session_store_pb2
import session_store_pb2_grpc

CACHE_TTL_S = 3600

auth = session_store_pb2_grpc.AuthStub(grpc.insecure_channel("auth:9000"))

# token -> (claims, when the cached copy stops being trusted)
cache: dict[str, tuple[dict, float]] = {}


def validate(token: str) -> dict | None:
    """The claims of a bearer token ({user_id, device_class}), or None when the request must be denied."""
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    now = time.time()
    hit = cache.get(token)
    if hit is not None and now < hit[1]:
        return hit[0]
    for _ in range(3):
        try:
            reply = auth.Validate(session_store_pb2.ValidateRequest(token=token), timeout=5)
        except grpc.RpcError:
            continue
        claims = {"user_id": reply.user_id, "device_class": reply.device_class}
        cache[token] = (claims, now + CACHE_TTL_S)
        return claims
    if hit is not None:
        return hit[0]
    return None


def revoke(token: str) -> None:
    """End a token at the auth service."""
    auth.Revoke(session_store_pb2.RevokeRequest(token=token), timeout=5)
`,
      solution: `import time

import grpc

import session_store_pb2
import session_store_pb2_grpc

DEADLINE_S = 0.15
# How long a revocation may take to bite on this instance.
CACHE_TTL_S = 30

auth = session_store_pb2_grpc.AuthStub(grpc.insecure_channel("auth:9000"))

# token -> (claims, when the cached copy stops being trusted)
cache: dict[str, tuple[dict, float]] = {}


def validate(token: str) -> dict | None:
    """The claims of a bearer token ({user_id, device_class}), or None when the request must be denied."""
    now = time.time()
    hit = cache.get(token)
    if hit is not None and now < hit[1]:
        return hit[0]
    cache.pop(token, None)
    try:
        reply = auth.Validate(session_store_pb2.ValidateRequest(token=token), timeout=DEADLINE_S)
    except grpc.RpcError:
        # UNAUTHENTICATED is the answer; DEADLINE_EXCEEDED and UNAVAILABLE say nothing about the token.
        # Deny either way, and retry nothing: an outage costs a retry, admitting a revoked token costs more.
        return None
    claims = {"user_id": reply.user_id, "device_class": reply.device_class}
    cache[token] = (claims, now + CACHE_TTL_S)
    return claims


def revoke(token: str) -> None:
    """End a token at the auth service; this instance stops trusting its cached copy at once."""
    cache.pop(token, None)
    auth.Revoke(session_store_pb2.RevokeRequest(token=token), timeout=DEADLINE_S)
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

export const CACHE_TTL_S = 3600;

export interface Claims {
  user_id: string;
  device_class: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('session_store.proto')) as unknown as {
  sessionauth: {Auth: grpc.ServiceClientConstructor};
};
const auth = new pkg.sessionauth.Auth('auth:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Validate(request: {token: string}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<Claims>;
  Revoke(request: {token: string}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{revoked: boolean}>;
};

/** token → the claims and when the cached copy stops being trusted (ms). */
export const cache = new Map<string, {claims: Claims; expires: number}>();

/** The claims of a bearer token, or null when the request must be denied. */
export async function validate(token: string): Promise<Claims | null> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const now = Date.now();
  const hit = cache.get(token);
  if (hit !== undefined && now < hit.expires) return hit.claims;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const reply = await auth.Validate({token}, new grpc.Metadata(), {deadline: Date.now() + 5000});
      const claims = {user_id: reply.user_id, device_class: reply.device_class};
      cache.set(token, {claims, expires: now + CACHE_TTL_S * 1000});
      return claims;
    } catch {
      continue;
    }
  }
  if (hit !== undefined) return hit.claims;
  return null;
}

/** End a token at the auth service. */
export async function revoke(token: string): Promise<void> {
  await auth.Revoke({token}, new grpc.Metadata(), {deadline: Date.now() + 5000});
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

export const DEADLINE_MS = 150;
/** How long a revocation may take to bite on this instance. */
export const CACHE_TTL_S = 30;

export interface Claims {
  user_id: string;
  device_class: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('session_store.proto')) as unknown as {
  sessionauth: {Auth: grpc.ServiceClientConstructor};
};
const auth = new pkg.sessionauth.Auth('auth:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Validate(request: {token: string}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<Claims>;
  Revoke(request: {token: string}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{revoked: boolean}>;
};

/** token → the claims and when the cached copy stops being trusted (ms). */
export const cache = new Map<string, {claims: Claims; expires: number}>();

/** The claims of a bearer token, or null when the request must be denied. */
export async function validate(token: string): Promise<Claims | null> {
  const now = Date.now();
  const hit = cache.get(token);
  if (hit !== undefined && now < hit.expires) return hit.claims;
  cache.delete(token);
  try {
    const reply = await auth.Validate({token}, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
    const claims = {user_id: reply.user_id, device_class: reply.device_class};
    cache.set(token, {claims, expires: now + CACHE_TTL_S * 1000});
    return claims;
  } catch {
    // UNAUTHENTICATED is the answer; DEADLINE_EXCEEDED and UNAVAILABLE say nothing about the token.
    // Deny either way, and retry nothing: an outage costs a retry, admitting a revoked token costs more.
    return null;
  }
}

/** End a token at the auth service; this instance stops trusting its cached copy at once. */
export async function revoke(token: string): Promise<void> {
  cache.delete(token);
  await auth.Revoke({token}, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "sessions/gen/session_store"
)

const cacheTTL = 3600 * time.Second

var (
	authConn, _ = grpc.NewClient("auth:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	auth        = pb.NewAuthClient(authConn)
)

// Claims are what the auth service asserts for a live token.
type Claims struct {
	UserID      string
	DeviceClass string
}

type cached struct {
	claims  *Claims
	expires time.Time
}

// cache holds token → the claims and when the cached copy stops being trusted.
var cache = map[string]cached{}

// validate is the claims of a bearer token, or nil when the request must be denied.
func validate(ctx context.Context, token string) *Claims {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	now := time.Now()
	hit, found := cache[token]
	if found && now.Before(hit.expires) {
		return hit.claims
	}
	for attempt := 0; attempt < 3; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		reply, err := auth.Validate(callCtx, &pb.ValidateRequest{Token: token})
		cancel()
		if err != nil {
			continue
		}
		claims := &Claims{UserID: reply.GetUserId(), DeviceClass: reply.GetDeviceClass()}
		cache[token] = cached{claims: claims, expires: now.Add(cacheTTL)}
		return claims
	}
	if found {
		return hit.claims
	}
	return nil
}

// revoke ends a token at the auth service.
func revoke(ctx context.Context, token string) error {
	callCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	_, err := auth.Revoke(callCtx, &pb.RevokeRequest{Token: token})
	return err
}
`,
      solution: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "sessions/gen/session_store"
)

const (
	deadline = 150 * time.Millisecond
	// cacheTTL is how long a revocation may take to bite on this instance.
	cacheTTL = 30 * time.Second
)

var (
	authConn, _ = grpc.NewClient("auth:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	auth        = pb.NewAuthClient(authConn)
)

// Claims are what the auth service asserts for a live token.
type Claims struct {
	UserID      string
	DeviceClass string
}

type cached struct {
	claims  *Claims
	expires time.Time
}

// cache holds token → the claims and when the cached copy stops being trusted.
var cache = map[string]cached{}

// validate is the claims of a bearer token, or nil when the request must be denied.
func validate(ctx context.Context, token string) *Claims {
	now := time.Now()
	if hit, found := cache[token]; found && now.Before(hit.expires) {
		return hit.claims
	}
	delete(cache, token)
	callCtx, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()
	reply, err := auth.Validate(callCtx, &pb.ValidateRequest{Token: token})
	if err != nil {
		// Unauthenticated is the answer; DeadlineExceeded and Unavailable say nothing about the token.
		// Deny either way, and retry nothing: an outage costs a retry, admitting a revoked token costs more.
		return nil
	}
	claims := &Claims{UserID: reply.GetUserId(), DeviceClass: reply.GetDeviceClass()}
	cache[token] = cached{claims: claims, expires: now.Add(cacheTTL)}
	return claims
}

// revoke ends a token at the auth service; this instance stops trusting its cached copy at once.
func revoke(ctx context.Context, token string) error {
	delete(cache, token)
	callCtx, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()
	_, err := auth.Revoke(callCtx, &pb.RevokeRequest{Token: token})
	return err
}
`,
    },
    scala: {
      starter: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import sessionauth.session_store.{AuthGrpc, RevokeRequest, ValidateRequest}

object AuthClient {
  final case class Claims(userId: String, deviceClass: String)

  val CacheTtlS = 3600L

  private val auth = AuthGrpc.blockingStub(ManagedChannelBuilder.forAddress("auth", 9000).usePlaintext().build())

  /** token → the claims and when the cached copy stops being trusted (ms). */
  val cache = scala.collection.concurrent.TrieMap.empty[String, (Claims, Long)]

  /** The claims of a bearer token, or None when the request must be denied. */
  def validate(token: String): Option[Claims] = {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    val now = System.currentTimeMillis()
    val hit = cache.get(token)
    hit.filter { case (_, expires) => now < expires }.map(_._1).orElse {
      val answered = (1 to 3).iterator.map { _ =>
        try Some(auth.withDeadlineAfter(5, TimeUnit.SECONDS).validate(ValidateRequest(token)))
        catch { case _: StatusRuntimeException => None }
      }.collectFirst { case Some(reply) => Claims(reply.userId, reply.deviceClass) }
      answered.foreach(claims => cache.put(token, (claims, now + CacheTtlS * 1000)))
      answered.orElse(hit.map(_._1))
    }
  }

  /** End a token at the auth service. */
  def revoke(token: String): Unit = {
    auth.withDeadlineAfter(5, TimeUnit.SECONDS).revoke(RevokeRequest(token))
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import sessionauth.session_store.{AuthGrpc, RevokeRequest, ValidateRequest}

object AuthClient {
  final case class Claims(userId: String, deviceClass: String)

  val DeadlineMs = 150L
  /** How long a revocation may take to bite on this instance. */
  val CacheTtlS = 30L

  private val auth = AuthGrpc.blockingStub(ManagedChannelBuilder.forAddress("auth", 9000).usePlaintext().build())

  /** token → the claims and when the cached copy stops being trusted (ms). */
  val cache = scala.collection.concurrent.TrieMap.empty[String, (Claims, Long)]

  /** The claims of a bearer token, or None when the request must be denied. */
  def validate(token: String): Option[Claims] = {
    val now = System.currentTimeMillis()
    cache.get(token).filter { case (_, expires) => now < expires }.map(_._1).orElse {
      cache.remove(token)
      try {
        val reply = auth.withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS).validate(ValidateRequest(token))
        val claims = Claims(reply.userId, reply.deviceClass)
        cache.put(token, (claims, now + CacheTtlS * 1000))
        Some(claims)
      } catch {
        // UNAUTHENTICATED is the answer; DEADLINE_EXCEEDED and UNAVAILABLE say nothing about the token.
        // Deny either way, and retry nothing: an outage costs a retry, admitting a revoked token costs more.
        case _: StatusRuntimeException => None
      }
    }
  }

  /** End a token at the auth service; this instance stops trusting its cached copy at once. */
  def revoke(token: String): Unit = {
    cache.remove(token)
    auth.withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS).revoke(RevokeRequest(token))
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <map>
#include <optional>
#include <string>

#include "session_store.grpc.pb.h"

constexpr std::chrono::seconds kCacheTtl{3600};

auto auth = sessionauth::Auth::NewStub(grpc::CreateChannel("auth:9000", grpc::InsecureChannelCredentials()));

// What the auth service asserts for a live token.
struct Claims {
  std::string user_id;
  std::string device_class;
};

struct Cached {
  Claims claims;
  std::chrono::system_clock::time_point expires;
};

// token → the claims and when the cached copy stops being trusted.
std::map<std::string, Cached> cache;

// The claims of a bearer token, or none when the request must be denied.
std::optional<Claims> validate(const std::string& token) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const auto now = std::chrono::system_clock::now();
  const auto hit = cache.find(token);
  if (hit != cache.end() && now < hit->second.expires) return hit->second.claims;
  sessionauth::ValidateRequest request;
  request.set_token(token);
  for (int attempt = 0; attempt < 3; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds{5});
    sessionauth::Claims reply;
    if (!auth->Validate(&ctx, request, &reply).ok()) continue;
    const Claims claims{reply.user_id(), reply.device_class()};
    cache[token] = Cached{claims, now + kCacheTtl};
    return claims;
  }
  if (hit != cache.end()) return hit->second.claims;
  return std::nullopt;
}

// End a token at the auth service.
void revoke(const std::string& token) {
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds{5});
  sessionauth::RevokeRequest request;
  request.set_token(token);
  sessionauth::RevokeReply reply;
  auth->Revoke(&ctx, request, &reply);
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <map>
#include <optional>
#include <string>

#include "session_store.grpc.pb.h"

constexpr std::chrono::milliseconds kDeadline{150};
// How long a revocation may take to bite on this instance.
constexpr std::chrono::seconds kCacheTtl{30};

auto auth = sessionauth::Auth::NewStub(grpc::CreateChannel("auth:9000", grpc::InsecureChannelCredentials()));

// What the auth service asserts for a live token.
struct Claims {
  std::string user_id;
  std::string device_class;
};

struct Cached {
  Claims claims;
  std::chrono::system_clock::time_point expires;
};

// token → the claims and when the cached copy stops being trusted.
std::map<std::string, Cached> cache;

// The claims of a bearer token, or none when the request must be denied.
std::optional<Claims> validate(const std::string& token) {
  const auto now = std::chrono::system_clock::now();
  const auto hit = cache.find(token);
  if (hit != cache.end() && now < hit->second.expires) return hit->second.claims;
  cache.erase(token);
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
  sessionauth::ValidateRequest request;
  request.set_token(token);
  sessionauth::Claims reply;
  // UNAUTHENTICATED is the answer; DEADLINE_EXCEEDED and UNAVAILABLE say nothing about the token.
  // Deny either way, and retry nothing: an outage costs a retry, admitting a revoked token costs more.
  if (!auth->Validate(&ctx, request, &reply).ok()) return std::nullopt;
  const Claims claims{reply.user_id(), reply.device_class()};
  cache[token] = Cached{claims, now + kCacheTtl};
  return claims;
}

// End a token at the auth service; this instance stops trusting its cached copy at once.
void revoke(const std::string& token) {
  cache.erase(token);
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
  sessionauth::RevokeRequest request;
  request.set_token(token);
  sessionauth::RevokeReply reply;
  auth->Revoke(&ctx, request, &reply);
}
`,
    },
  },
  harness: {
    python: `import grpc

import session_store_pb2
import session_store_pb2_grpc

CLAIMS = {"user_id": "u-1", "device_class": "mobile"}


class Auth(session_store_pb2_grpc.AuthServicer):
    """The auth service: tokens it knows answer their claims, anything else is UNAUTHENTICATED."""

    def __init__(self):
        self.tokens = {"tok-1": ("u-1", "mobile"), "tok-2": ("u-2", "desktop")}

    def Validate(self, request, context):
        claims = self.tokens.get(request.token)
        if claims is None:
            context.abort(grpc.StatusCode.UNAUTHENTICATED, "unknown or revoked token")
        return session_store_pb2.Claims(user_id=claims[0], device_class=claims[1])

    def Revoke(self, request, context):
        return session_store_pb2.RevokeReply(revoked=self.tokens.pop(request.token, None) is not None)


def _client(ctx):
    auth = Auth()
    ctx.grpc.serve(session_store_pb2_grpc.add_AuthServicer_to_server, auth)
    return ctx.load("auth_client"), auth


def check_deadline(ctx):
    m, _ = _client(ctx)
    claims = m.validate("tok-1")
    assert claims == CLAIMS, f"validate('tok-1') answered {claims}, expected {CLAIMS}"
    for call in ctx.grpc.calls_to("Validate"):
        assert call.timeout is not None and 0.1 <= call.timeout <= 0.2, f"a Validate call carries a {call.timeout} s deadline, expected 150 ms: a slow auth service holds every request open that long"
    ctx.grpc.set_latency("Validate", 1.0)
    late = m.validate("tok-2")
    assert late is None, f"with the auth service answering in 1 s, validate('tok-2') answered {late}: give up at 150 ms and deny"


def check_short_cache(ctx):
    m, auth = _client(ctx)
    assert m.validate("tok-1") == CLAIMS, "validate('tok-1') must answer its claims"
    ctx.clock.advance(10)
    assert m.validate("tok-1") == CLAIMS, "validate('tok-1') must answer its claims 10 s later"
    calls = len(ctx.grpc.calls_to("Validate"))
    assert calls == 1, f"two validations 10 s apart made {calls} Validate calls: the second must come from the cache"
    del auth.tokens["tok-1"]  # an operator revokes it at the auth service
    ctx.clock.advance(25)
    claims = m.validate("tok-1")
    assert claims is None, f"35 s after it was cached, a token the auth service has revoked still validated ({claims}): cache a positive answer for 30 s at most"


def check_fail_closed(ctx):
    m, _ = _client(ctx)
    assert m.validate("tok-1") == CLAIMS, "validate('tok-1') must answer its claims"
    ctx.clock.advance(3601)  # an hour later, past any cache window
    ctx.grpc.fail("Validate", grpc.StatusCode.UNAVAILABLE, "auth is down", times=10)
    claims = m.validate("tok-1")
    assert claims is None, f"with the auth service down, validate answered {claims}, cached an hour ago: an outage must deny, or a revoked token works for as long as the outage lasts"


def check_revoke_visible(ctx):
    m, _ = _client(ctx)
    assert m.validate("tok-1") == CLAIMS, "validate('tok-1') must answer its claims"
    m.revoke("tok-1")
    assert ctx.grpc.calls_to("Revoke"), "revoke must tell the auth service (Revoke)"
    claims = m.validate("tok-1")
    assert claims is None, f"right after revoke('tok-1') the token still validated from the cache ({claims}): revoke must drop the cached entry"


def check_terminal_reject(ctx):
    m, _ = _client(ctx)
    assert m.validate("tok-unknown") is None, "a token the auth service rejects must not validate"
    calls = len(ctx.grpc.calls_to("Validate"))
    assert calls == 1, f"a token the auth service rejected (UNAUTHENTICATED) was sent {calls} times: the rejection is the answer, not a failure to retry"
    assert ctx.clock.sleeps == 0, "a rejection must not be slept on and retried"
`,
    typescript: `const CLAIMS = {user_id: 'u-1', device_class: 'mobile'};

/** The auth service: tokens it knows answer their claims, anything else is UNAUTHENTICATED. */
function client(ctx) {
  const pkg = ctx.proto('session_store.proto');
  const tokens = new Map([
    ['tok-1', CLAIMS],
    ['tok-2', {user_id: 'u-2', device_class: 'desktop'}],
  ]);
  ctx.grpc.serve(pkg.sessionauth.Auth.service, {
    Validate(call, callback) {
      const claims = tokens.get(call.request.token);
      if (claims === undefined) return callback({code: ctx.grpc.status.UNAUTHENTICATED, details: 'unknown or revoked token'});
      callback(null, claims);
    },
    Revoke(call, callback) {
      callback(null, {revoked: tokens.delete(call.request.token)});
    },
  });
  return {m: ctx.load('auth_client'), tokens};
}

const claimsOf = (claims): string => JSON.stringify(claims === null ? null : {user_id: claims.user_id, device_class: claims.device_class});

export async function check_deadline(ctx) {
  const {m} = client(ctx);
  const claims = await m.validate('tok-1');
  assert.equal(claimsOf(claims), JSON.stringify(CLAIMS), \`validate('tok-1') answered \${claimsOf(claims)}\`);
  for (const call of ctx.grpc.callsTo('Validate')) {
    assert(call.timeout !== null && 0.1 <= call.timeout && call.timeout <= 0.2, \`a Validate call carries a \${call.timeout} s deadline, expected 150 ms: a slow auth service holds every request open that long\`);
  }
  ctx.grpc.setLatency('Validate', 1.0);
  const late = await m.validate('tok-2');
  assert.equal(late, null, \`with the auth service answering in 1 s, validate('tok-2') answered \${claimsOf(late)}: give up at 150 ms and deny\`);
}

export async function check_short_cache(ctx) {
  const {m, tokens} = client(ctx);
  assert.equal(claimsOf(await m.validate('tok-1')), JSON.stringify(CLAIMS), "validate('tok-1') must answer its claims");
  ctx.clock.advance(10);
  assert.equal(claimsOf(await m.validate('tok-1')), JSON.stringify(CLAIMS), "validate('tok-1') must answer its claims 10 s later");
  const calls = ctx.grpc.callsTo('Validate').length;
  assert.equal(calls, 1, \`two validations 10 s apart made \${calls} Validate calls: the second must come from the cache\`);
  tokens.delete('tok-1'); // an operator revokes it at the auth service
  ctx.clock.advance(25);
  const claims = await m.validate('tok-1');
  assert.equal(claims, null, \`35 s after it was cached, a token the auth service has revoked still validated (\${claimsOf(claims)}): cache a positive answer for 30 s at most\`);
}

export async function check_fail_closed(ctx) {
  const {m} = client(ctx);
  assert.equal(claimsOf(await m.validate('tok-1')), JSON.stringify(CLAIMS), "validate('tok-1') must answer its claims");
  ctx.clock.advance(3601); // an hour later, past any cache window
  ctx.grpc.fail('Validate', ctx.grpc.status.UNAVAILABLE, 'auth is down', 10);
  const claims = await m.validate('tok-1');
  assert.equal(claims, null, \`with the auth service down, validate answered \${claimsOf(claims)}, cached an hour ago: an outage must deny, or a revoked token works for as long as the outage lasts\`);
}

export async function check_revoke_visible(ctx) {
  const {m} = client(ctx);
  assert.equal(claimsOf(await m.validate('tok-1')), JSON.stringify(CLAIMS), "validate('tok-1') must answer its claims");
  await m.revoke('tok-1');
  assert(ctx.grpc.callsTo('Revoke').length > 0, 'revoke must tell the auth service (Revoke)');
  const claims = await m.validate('tok-1');
  assert.equal(claims, null, \`right after revoke('tok-1') the token still validated from the cache (\${claimsOf(claims)}): revoke must drop the cached entry\`);
}

export async function check_terminal_reject(ctx) {
  const {m} = client(ctx);
  assert.equal(await m.validate('tok-unknown'), null, 'a token the auth service rejects must not validate');
  const calls = ctx.grpc.callsTo('Validate').length;
  assert.equal(calls, 1, \`a token the auth service rejected (UNAUTHENTICATED) was sent \${calls} times: the rejection is the answer, not a failure to retry\`);
  assert.equal(ctx.clock.sleeps, 0, 'a rejection must not be slept on and retried');
}
`,
    go: `package main

import (
	"context"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "sessions/gen/session_store"

	"leetbuild/harness"
)

var bg = context.Background()

// authPeer is the auth service: tokens it knows answer their claims, anything else is Unauthenticated.
type authPeer struct {
	pb.UnimplementedAuthServer
	tokens map[string]*pb.Claims
}

func (a *authPeer) Validate(_ context.Context, req *pb.ValidateRequest) (*pb.Claims, error) {
	claims, ok := a.tokens[req.GetToken()]
	if !ok {
		return nil, status.Error(codes.Unauthenticated, "unknown or revoked token")
	}
	return claims, nil
}

func (a *authPeer) Revoke(_ context.Context, req *pb.RevokeRequest) (*pb.RevokeReply, error) {
	_, ok := a.tokens[req.GetToken()]
	delete(a.tokens, req.GetToken())
	return &pb.RevokeReply{Revoked: ok}, nil
}

func client(ctx *harness.Ctx) *authPeer {
	peer := &authPeer{tokens: map[string]*pb.Claims{
		"tok-1": {UserId: "u-1", DeviceClass: "mobile"},
		"tok-2": {UserId: "u-2", DeviceClass: "desktop"},
	}}
	pb.RegisterAuthServer(ctx.GRPC.Server(""), peer)
	clear(cache)
	return peer
}

func isU1(c *Claims) bool { return c != nil && c.UserID == "u-1" && c.DeviceClass == "mobile" }

func CheckDeadline(ctx *harness.Ctx) {
	client(ctx)
	ctx.Assert(isU1(validate(bg, "tok-1")), "validate(tok-1) must answer u-1's claims")
	for _, call := range ctx.GRPC.CallsTo("Validate", "") {
		ctx.Assert(call.HasDeadline() && call.Timeout.Seconds() >= 0.1 && call.Timeout.Seconds() <= 0.2, "a Validate call carries a %v deadline, expected 150 ms: a slow auth service holds every request open that long", call.Timeout)
	}
	ctx.GRPC.SetLatency("Validate", 1.0, "")
	late := validate(bg, "tok-2")
	ctx.Assert(late == nil, "with the auth service answering in 1 s, validate(tok-2) answered %+v: give up at 150 ms and deny", late)
}

func CheckShortCache(ctx *harness.Ctx) {
	peer := client(ctx)
	ctx.Assert(isU1(validate(bg, "tok-1")), "validate(tok-1) must answer u-1's claims")
	ctx.Clock.Advance(10)
	ctx.Assert(isU1(validate(bg, "tok-1")), "validate(tok-1) must answer u-1's claims 10 s later")
	ctx.Equal(len(ctx.GRPC.CallsTo("Validate", "")), 1, "two validations 10 s apart: the second must come from the cache; the Validate calls")
	delete(peer.tokens, "tok-1") // an operator revokes it at the auth service
	ctx.Clock.Advance(25)
	claims := validate(bg, "tok-1")
	ctx.Assert(claims == nil, "35 s after it was cached, a token the auth service has revoked still validated (%+v): cache a positive answer for 30 s at most", claims)
}

func CheckFailClosed(ctx *harness.Ctx) {
	client(ctx)
	ctx.Assert(isU1(validate(bg, "tok-1")), "validate(tok-1) must answer u-1's claims")
	ctx.Clock.Advance(3601) // an hour later, past any cache window
	ctx.GRPC.Fail("Validate", codes.Unavailable, "auth is down", 10, "")
	claims := validate(bg, "tok-1")
	ctx.Assert(claims == nil, "with the auth service down, validate answered %+v, cached an hour ago: an outage must deny, or a revoked token works for as long as the outage lasts", claims)
}

func CheckRevokeVisible(ctx *harness.Ctx) {
	client(ctx)
	ctx.Assert(isU1(validate(bg, "tok-1")), "validate(tok-1) must answer u-1's claims")
	ctx.NoError(revoke(bg, "tok-1"), "revoke(tok-1)")
	ctx.Assert(len(ctx.GRPC.CallsTo("Revoke", "")) > 0, "revoke must tell the auth service (Revoke)")
	claims := validate(bg, "tok-1")
	ctx.Assert(claims == nil, "right after revoke(tok-1) the token still validated from the cache (%+v): revoke must drop the cached entry", claims)
}

func CheckTerminalReject(ctx *harness.Ctx) {
	client(ctx)
	ctx.Assert(validate(bg, "tok-unknown") == nil, "a token the auth service rejects must not validate")
	ctx.Equal(len(ctx.GRPC.CallsTo("Validate", "")), 1, "a token the auth service rejected (Unauthenticated) is the answer, not a failure to retry; the Validate calls")
	ctx.Equal(ctx.Clock.Sleeps(), 0, "a rejection must not be slept on and retried; the sleeps")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <map>
#include <string>

namespace {

// The auth service: tokens it knows answer their claims, anything else is UNAUTHENTICATED.
class AuthPeer final : public sessionauth::Auth::Service {
 public:
  std::map<std::string, std::pair<std::string, std::string>> tokens = {{"tok-1", {"u-1", "mobile"}}, {"tok-2", {"u-2", "desktop"}}};
  grpc::Status Validate(grpc::ServerContext*, const sessionauth::ValidateRequest* req, sessionauth::Claims* out) override {
    const auto found = tokens.find(req->token());
    if (found == tokens.end()) return grpc::Status(grpc::StatusCode::UNAUTHENTICATED, "unknown or revoked token");
    out->set_user_id(found->second.first);
    out->set_device_class(found->second.second);
    return grpc::Status::OK;
  }
  grpc::Status Revoke(grpc::ServerContext*, const sessionauth::RevokeRequest* req, sessionauth::RevokeReply* out) override {
    out->set_revoked(tokens.erase(req->token()) > 0);
    return grpc::Status::OK;
  }
};

AuthPeer& client(harness::Ctx& ctx) {
  static AuthPeer* peer = nullptr;
  delete peer;
  peer = new AuthPeer;
  ctx.GRPC.Server("")->RegisterService(peer);
  cache.clear();
  return *peer;
}

bool isU1(const std::optional<Claims>& c) { return c && c->user_id == "u-1" && c->device_class == "mobile"; }

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  client(ctx);
  ctx.Assert(isU1(validate("tok-1")), "validate(tok-1) must answer u-1's claims");
  for (const auto& call : ctx.GRPC.CallsTo("Validate")) {
    ctx.Assert(call.HasDeadline() && 0.1 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 0.2,
               "a Validate call carries a %v s deadline, expected 150 ms: a slow auth service holds every request open that long", call.TimeoutSeconds());
  }
  ctx.GRPC.SetLatency("Validate", 1.0);
  ctx.Assert(!validate("tok-2").has_value(), "with the auth service answering in 1 s, validate(tok-2) answered claims: give up at 150 ms and deny");
}

void CheckShortCache(harness::Ctx& ctx) {
  AuthPeer& peer = client(ctx);
  ctx.Assert(isU1(validate("tok-1")), "validate(tok-1) must answer u-1's claims");
  ctx.Clock.Advance(10);
  ctx.Assert(isU1(validate("tok-1")), "validate(tok-1) must answer u-1's claims 10 s later");
  ctx.Equal(ctx.GRPC.CallsTo("Validate").size(), 1, "two validations 10 s apart: the second must come from the cache; the Validate calls");
  peer.tokens.erase("tok-1");  // an operator revokes it at the auth service
  ctx.Clock.Advance(25);
  ctx.Assert(!validate("tok-1").has_value(), "35 s after it was cached, a token the auth service has revoked still validated: cache a positive answer for 30 s at most");
}

void CheckFailClosed(harness::Ctx& ctx) {
  client(ctx);
  ctx.Assert(isU1(validate("tok-1")), "validate(tok-1) must answer u-1's claims");
  ctx.Clock.Advance(3601);  // an hour later, past any cache window
  ctx.GRPC.Fail("Validate", grpc::StatusCode::UNAVAILABLE, "auth is down", 10);
  ctx.Assert(!validate("tok-1").has_value(),
             "with the auth service down, validate answered the claims cached an hour ago: an outage must deny, or a revoked token works for as long as the outage lasts");
}

void CheckRevokeVisible(harness::Ctx& ctx) {
  client(ctx);
  ctx.Assert(isU1(validate("tok-1")), "validate(tok-1) must answer u-1's claims");
  revoke("tok-1");
  ctx.Assert(!ctx.GRPC.CallsTo("Revoke").empty(), "revoke must tell the auth service (Revoke)");
  ctx.Assert(!validate("tok-1").has_value(), "right after revoke(tok-1) the token still validated from the cache: revoke must drop the cached entry");
}

void CheckTerminalReject(harness::Ctx& ctx) {
  client(ctx);
  ctx.Assert(!validate("tok-unknown").has_value(), "a token the auth service rejects must not validate");
  ctx.Equal(ctx.GRPC.CallsTo("Validate").size(), 1, "a token the auth service rejected (UNAUTHENTICATED) is the answer, not a failure to retry; the Validate calls");
  ctx.Equal(ctx.Clock.Sleeps(), 0, "a rejection must not be slept on and retried; the sleeps");
}
`,
  },
  hints: [
    'Revoke a token at the auth service and validate it again: it still answers the claims. Take the auth service down an hour later: every user the cache once saw is still signed in.',
    'The cache trusts an answer for an hour and `revoke` never touches it; the loop treats a rejection like a timeout, each attempt may wait five seconds, and after it the stale cached claims are answered.',
    '`CACHE_TTL_S = 30`; one `Validate` call with `timeout=DEADLINE_S` (0.15) and `None` on any `RpcError`; in `revoke`, `cache.pop(token, None)` before calling `Revoke`.',
  ],
  debrief: `An authentication check fails closed because the two mistakes cost different amounts: denying a valid user during an outage costs a retry, admitting a revoked one costs whatever the attacker does next. The cache trades the auth service's load against how long a revocation takes to bite, so its window is the revocation delay you promise, and \`revoke\` empties the local entry so the instance that handled it agrees at once. The deadline keeps a slow dependency from becoming a slow front door. Deployments with many instances push revocations to all of them (a pub/sub channel or a short revocation list), since a local \`pop\` only fixes the process it ran in, and validate signed tokens locally, asking the auth service only about revocation.`,
};
