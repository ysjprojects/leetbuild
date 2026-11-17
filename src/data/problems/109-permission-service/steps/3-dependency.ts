import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Policy engine calls that deny when they cannot verify',
  concept: 'grpc',
  guides: ['deadlines-and-retries', 'failing-dependencies'],
  file: 'client',
  focus: ['api', 'engine', 'redis'],
  task: `## Task

**Starting point.** The starter is \`authorize(subject, permission, scope)\`, the check every
request makes: it serves a cached allow from \`perm:allow:{subject}:{permission}:{scope}\` (60 s
TTL), else calls \`PolicyEngine.Check\` up to three times with a 200 ms sleep after any error, caches
an allow, and when every attempt failed returns the engine's last allow, kept for an hour. With a
healthy engine it answers correctly, and it hides four flaws.

**Failure mode the checks target.** A stalled engine holds every request open; an unknown permission
is asked three times; an engine outage turns into the allows of the last hour; and a revoked grant
keeps its cached allow for a minute.

\`\`\`proto
service PolicyEngine { rpc Check(CheckRequest) returns (Decision); }  // Decision{allowed, reason}
\`\`\`

- Every attempt carries its own **400 ms** deadline (\`DEADLINE_S\`).
- At most **two** attempts (\`MAX_ATTEMPTS\`), 100 ms apart, and only after \`UNAVAILABLE\` or
  \`DEADLINE_EXCEEDED\`. Any other status is the engine's answer: deny, no retry.
- When both attempts fail, raise \`PolicyUnavailable\` (the route answers 503): never an old allow.
- A cached allow is a hash with a **60 s** TTL, stamped with the \`perm:grant_version\` read before
  the call, and counts only while the stamp equals the current version.`,
  sequence: {
    participants: ['Permission Service', 'Redis', 'Policy engine'],
    messages: [
      {
        from: 'Permission Service',
        to: 'Redis',
        label: 'GET perm:grant_version · HGET perm:allow:… version',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Permission Service', label: 'stamp = current → allow', kind: 'reply'},
      {from: 'Permission Service', to: 'Policy engine', label: 'Check · deadline 400 ms', kind: 'sync'},
      {
        from: 'Policy engine',
        to: 'Permission Service',
        label: 'UNAVAILABLE → 100 ms → one more attempt',
        kind: 'reply',
      },
      {
        from: 'Policy engine',
        to: 'Permission Service',
        label: 'Decision{allowed} · INVALID_ARGUMENT → deny',
        kind: 'reply',
      },
      {from: 'Permission Service', to: 'Redis', label: 'HSET allow {version} · EXPIRE 60', kind: 'sync'},
      {
        from: 'Permission Service',
        to: 'Permission Service',
        label: 'two attempts failed → PolicyUnavailable (503)',
        kind: 'sync',
      },
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Calls the policy engine under a 400 ms deadline',
      detail:
        'Every `Check` attempt carries its own 400 ms deadline, and the two attempts are 100 ms apart, so a stalled engine costs two short attempts and a `PolicyUnavailable`; the starter calls with no deadline and waits as long as the engine does.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*0?\.4\b/, /Check\([^)]*timeout\s*=\s*DEADLINE_S/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*400\b/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/]},
        go: {
          all: [/policyDeadline\s*=\s*400\s*\*\s*time\.Millisecond/, /context\.WithTimeout\([^\n]*policyDeadline\)/],
        },
        scala: {all: [/DeadlineMs\s*=\s*400L?\b/, /withDeadlineAfter\(\s*DeadlineMs/]},
        cpp: {all: [/kDeadline\{400\}/, /set_deadline\([^\n]*kDeadline\)/]},
      },
    },
    {
      id: 'retry-transient',
      title: 'Retries only a transport failure, and only once',
      detail:
        'Two attempts at most, the second only after `UNAVAILABLE` or `DEADLINE_EXCEEDED`; any other status (an unknown permission is `INVALID_ARGUMENT`; `PERMISSION_DENIED`, `NOT_FOUND`, `FAILED_PRECONDITION` and `INTERNAL` too) is a denial after one call. The starter retries every error three times.',
      match: {
        python: {all: [/MAX_ATTEMPTS\s*=\s*2\b/, /StatusCode\.UNAVAILABLE/, /StatusCode\.DEADLINE_EXCEEDED/]},
        typescript: {all: [/MAX_ATTEMPTS\s*=\s*2\b/, /status\.UNAVAILABLE/, /status\.DEADLINE_EXCEEDED/]},
        go: {all: [/maxAttempts\s*=\s*2\b/, /codes\.Unavailable/, /codes\.DeadlineExceeded/]},
        scala: {all: [/MaxAttempts\s*=\s*2\b/, /Code\.UNAVAILABLE/, /Code\.DEADLINE_EXCEEDED/]},
        cpp: {all: [/kMaxAttempts\s*=\s*2\b/, /StatusCode::UNAVAILABLE/, /StatusCode::DEADLINE_EXCEEDED/]},
      },
    },
    {
      id: 'fail-closed',
      title: 'Denies with PolicyUnavailable when the engine cannot be asked',
      detail:
        'When both attempts fail the call raises `PolicyUnavailable` (503 with `Retry-After` at the route); it never falls back to an allow the engine gave earlier, as the starter does with its one-hour copy.',
      match: {
        python: {all: [/raise PolicyUnavailable/], none: [/last_allow/]},
        typescript: {all: [/throw new PolicyUnavailable/], none: [/lastAllow/]},
        go: {all: [/return false,[^\n]*ErrPolicyUnavailable/], none: [/lastAllow/]},
        scala: {all: [/throw new PolicyUnavailable/], none: [/lastAllow/]},
        cpp: {all: [/throw PolicyUnavailable/], none: [/lastAllow/]},
      },
    },
    {
      id: 'cached-allow-version',
      title: 'Serves a cached allow only at the grant version it was given at',
      detail:
        'The cached allow (60 s TTL) is stamped with the `perm:grant_version` read before the call and served only while the stamp equals the current version; any grant change, one that commits while the engine answers included, asks the engine again. The starter trusts the TTL.',
      match: {
        python: {
          all: [/VERSION_KEY\s*=\s*["']perm:grant_version["']/, /\.get\(\s*VERSION_KEY/],
          none: [/==\s*["']1["']/],
        },
        typescript: {
          all: [/VERSION_KEY\s*=\s*['"]perm:grant_version['"]/, /\.get\(\s*VERSION_KEY/],
          none: [/===\s*['"]1['"]/],
        },
        go: {all: [/versionKey\s*=\s*"perm:grant_version"/, /\.Get\(\s*ctx,\s*versionKey/], none: [/==\s*"1"/]},
        scala: {all: [/VersionKey\s*=\s*"perm:grant_version"/, /\.get\(\s*VersionKey/], none: [/==\s*"1"/]},
        cpp: {all: [/kVersionKey\s*=\s*"perm:grant_version"/, /\.get\(\s*kVersionKey/], none: [/==\s*"1"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import grpc
import redis

import permission_service_pb2 as pb
import permission_service_pb2_grpc as pb_grpc

r = redis.Redis(host="redis", port=6379, decode_responses=True)
engine = pb_grpc.PolicyEngineStub(grpc.insecure_channel("policy-engine:9000"))

RETRIES = 3
ALLOW_TTL_S = 60
LAST_ALLOW_TTL_S = 3600


class PolicyUnavailable(Exception):
    """The engine could not be asked: the route answers 503 with Retry-After."""


def allow_key(subject: str, permission: str, scope: str) -> str:
    return f"perm:allow:{subject}:{permission}:{scope}"


def last_allow_key(subject: str, permission: str, scope: str) -> str:
    return f"perm:last_allow:{subject}:{permission}:{scope}"


def authorize(subject: str, permission: str, scope: str) -> bool:
    """Whether the policy engine allows subject to use permission at scope."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    if r.get(allow_key(subject, permission, scope)) == "1":
        return True
    request = pb.CheckRequest(subject=subject, permission=permission, scope=scope)
    for attempt in range(RETRIES):
        try:
            decision = engine.Check(request)
        except grpc.RpcError:
            time.sleep(0.2)  # the engine is flaky: ask again
            continue
        if decision.allowed:
            r.set(allow_key(subject, permission, scope), "1", ex=ALLOW_TTL_S)
            r.set(last_allow_key(subject, permission, scope), "1", ex=LAST_ALLOW_TTL_S)
        return decision.allowed
    return r.get(last_allow_key(subject, permission, scope)) == "1"  # the engine is down: keep serving what it last said
`,
      solution: `import time

import grpc
import redis

import permission_service_pb2 as pb
import permission_service_pb2_grpc as pb_grpc

r = redis.Redis(host="redis", port=6379, decode_responses=True)
engine = pb_grpc.PolicyEngineStub(grpc.insecure_channel("policy-engine:9000"))

VERSION_KEY = "perm:grant_version"
DEADLINE_S = 0.4
MAX_ATTEMPTS = 2
BACKOFF_S = 0.1
ALLOW_TTL_S = 60
RETRYABLE = (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED)


class PolicyUnavailable(Exception):
    """The engine could not be asked: the route answers 503 with Retry-After."""


def allow_key(subject: str, permission: str, scope: str) -> str:
    return f"perm:allow:{subject}:{permission}:{scope}"


def authorize(subject: str, permission: str, scope: str) -> bool:
    """Whether the policy engine allows subject to use permission at scope."""
    version = r.get(VERSION_KEY) or "0"
    if r.hget(allow_key(subject, permission, scope), "version") == version:
        return True  # the engine allowed this at the current grant version
    request = pb.CheckRequest(subject=subject, permission=permission, scope=scope)
    for attempt in range(MAX_ATTEMPTS):
        try:
            decision = engine.Check(request, timeout=DEADLINE_S)
        except grpc.RpcError as exc:
            if exc.code() not in RETRYABLE:
                return False  # the engine answered: a rejection is a denial, not a reason to ask again
            if attempt + 1 < MAX_ATTEMPTS:
                time.sleep(BACKOFF_S)
            continue
        if decision.allowed:
            r.hset(allow_key(subject, permission, scope), "version", version)
            r.expire(allow_key(subject, permission, scope), ALLOW_TTL_S)
        return decision.allowed
    # Nothing verified this request: deny it, and let the client retry.
    raise PolicyUnavailable(f"policy engine: no answer in {MAX_ATTEMPTS} attempts")
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Redis from 'ioredis';

interface CheckRequest {
  subject: string;
  permission: string;
  scope: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('permission_service.proto')) as unknown as {
  policyd: {PolicyEngine: grpc.ServiceClientConstructor};
};
const engine = new pkg.policyd.PolicyEngine('policy-engine:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Check(request: CheckRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{allowed: boolean; reason: string}>;
};
const redis = new Redis({host: 'redis', port: 6379});

export const RETRIES = 3;
export const ALLOW_TTL_S = 60;
export const LAST_ALLOW_TTL_S = 3600;

/** The engine could not be asked: the route answers 503 with Retry-After. */
export class PolicyUnavailable extends Error {}

const allowKey = (subject: string, permission: string, scope: string): string => \`perm:allow:\${subject}:\${permission}:\${scope}\`;
const lastAllowKey = (subject: string, permission: string, scope: string): string => \`perm:last_allow:\${subject}:\${permission}:\${scope}\`;

/** Whether the policy engine allows subject to use permission at scope. */
export async function authorize(subject: string, permission: string, scope: string): Promise<boolean> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  if ((await redis.get(allowKey(subject, permission, scope))) === '1') return true;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    let decision;
    try {
      decision = await engine.Check({subject, permission, scope}, new grpc.Metadata(), {});
    } catch {
      await new Promise(resolve => setTimeout(resolve, 200)); // the engine is flaky: ask again
      continue;
    }
    if (decision.allowed) {
      await redis.set(allowKey(subject, permission, scope), '1', 'EX', ALLOW_TTL_S);
      await redis.set(lastAllowKey(subject, permission, scope), '1', 'EX', LAST_ALLOW_TTL_S);
    }
    return decision.allowed;
  }
  return (await redis.get(lastAllowKey(subject, permission, scope))) === '1'; // the engine is down: keep serving what it last said
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Redis from 'ioredis';

interface CheckRequest {
  subject: string;
  permission: string;
  scope: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('permission_service.proto')) as unknown as {
  policyd: {PolicyEngine: grpc.ServiceClientConstructor};
};
const engine = new pkg.policyd.PolicyEngine('policy-engine:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Check(request: CheckRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{allowed: boolean; reason: string}>;
};
const redis = new Redis({host: 'redis', port: 6379});

export const VERSION_KEY = 'perm:grant_version';
export const DEADLINE_MS = 400;
export const MAX_ATTEMPTS = 2;
export const BACKOFF_MS = 100;
export const ALLOW_TTL_S = 60;
const RETRYABLE: number[] = [grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED];

/** The engine could not be asked: the route answers 503 with Retry-After. */
export class PolicyUnavailable extends Error {}

const allowKey = (subject: string, permission: string, scope: string): string => \`perm:allow:\${subject}:\${permission}:\${scope}\`;

/** Whether the policy engine allows subject to use permission at scope. */
export async function authorize(subject: string, permission: string, scope: string): Promise<boolean> {
  const version = (await redis.get(VERSION_KEY)) ?? '0';
  if ((await redis.hget(allowKey(subject, permission, scope), 'version')) === version) return true; // allowed at the current grant version
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let decision;
    try {
      decision = await engine.Check({subject, permission, scope}, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
    } catch (e) {
      if (!RETRYABLE.includes((e as grpc.ServiceError).code)) return false; // the engine answered: a rejection is a denial
      if (attempt + 1 < MAX_ATTEMPTS) await new Promise(resolve => setTimeout(resolve, BACKOFF_MS));
      continue;
    }
    if (decision.allowed) {
      await redis.hset(allowKey(subject, permission, scope), 'version', version);
      await redis.expire(allowKey(subject, permission, scope), ALLOW_TTL_S);
    }
    return decision.allowed;
  }
  // Nothing verified this request: deny it, and let the client retry.
  throw new PolicyUnavailable(\`policy engine: no answer in \${MAX_ATTEMPTS} attempts\`);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "permz/gen/permission_service"
)

const (
	retries       = 3
	allowTTL      = 60 * time.Second
	lastAllowTTL  = time.Hour
	policyAddress = "policy-engine:9000"
)

var (
	rdb          = redis.NewClient(&redis.Options{Addr: "redis:6379"})
	engineConn, _ = grpc.NewClient(policyAddress, grpc.WithTransportCredentials(insecure.NewCredentials()))
	engine       = pb.NewPolicyEngineClient(engineConn)
)

// ErrPolicyUnavailable: the engine could not be asked, the route answers 503 with Retry-After.
var ErrPolicyUnavailable = errors.New("policy engine unavailable")

func allowKey(subject, permission, scope string) string {
	return "perm:allow:" + subject + ":" + permission + ":" + scope
}

func lastAllowKey(subject, permission, scope string) string {
	return "perm:last_allow:" + subject + ":" + permission + ":" + scope
}

// authorize reports whether the policy engine allows subject to use permission at scope.
func authorize(ctx context.Context, subject, permission, scope string) (bool, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	if rdb.Get(ctx, allowKey(subject, permission, scope)).Val() == "1" {
		return true, nil
	}
	request := &pb.CheckRequest{Subject: subject, Permission: permission, Scope: scope}
	for attempt := 0; attempt < retries; attempt++ {
		decision, err := engine.Check(ctx, request)
		if err != nil {
			time.Sleep(200 * time.Millisecond) // the engine is flaky: ask again
			continue
		}
		if decision.GetAllowed() {
			rdb.Set(ctx, allowKey(subject, permission, scope), "1", allowTTL)
			rdb.Set(ctx, lastAllowKey(subject, permission, scope), "1", lastAllowTTL)
		}
		return decision.GetAllowed(), nil
	}
	return rdb.Get(ctx, lastAllowKey(subject, permission, scope)).Val() == "1", nil // the engine is down: keep serving what it last said
}
`,
      solution: `package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "permz/gen/permission_service"
)

const (
	versionKey     = "perm:grant_version"
	policyDeadline = 400 * time.Millisecond
	maxAttempts    = 2
	backoff        = 100 * time.Millisecond
	allowTTL       = 60 * time.Second
	policyAddress  = "policy-engine:9000"
)

var (
	rdb           = redis.NewClient(&redis.Options{Addr: "redis:6379"})
	engineConn, _ = grpc.NewClient(policyAddress, grpc.WithTransportCredentials(insecure.NewCredentials()))
	engine        = pb.NewPolicyEngineClient(engineConn)
)

// ErrPolicyUnavailable: the engine could not be asked, the route answers 503 with Retry-After.
var ErrPolicyUnavailable = errors.New("policy engine unavailable")

func allowKey(subject, permission, scope string) string {
	return "perm:allow:" + subject + ":" + permission + ":" + scope
}

// authorize reports whether the policy engine allows subject to use permission at scope.
func authorize(ctx context.Context, subject, permission, scope string) (bool, error) {
	version, err := rdb.Get(ctx, versionKey).Result()
	if err != nil {
		version = "0"
	}
	if stamp, err := rdb.HGet(ctx, allowKey(subject, permission, scope), "version").Result(); err == nil && stamp == version {
		return true, nil // the engine allowed this at the current grant version
	}
	request := &pb.CheckRequest{Subject: subject, Permission: permission, Scope: scope}
	for attempt := 0; attempt < maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, policyDeadline)
		decision, err := engine.Check(callCtx, request)
		cancel()
		if err != nil {
			if code := status.Code(err); code != codes.Unavailable && code != codes.DeadlineExceeded {
				return false, nil // the engine answered: a rejection is a denial, not a reason to ask again
			}
			if attempt+1 < maxAttempts {
				time.Sleep(backoff)
			}
			continue
		}
		if decision.GetAllowed() {
			rdb.HSet(ctx, allowKey(subject, permission, scope), "version", version)
			rdb.Expire(ctx, allowKey(subject, permission, scope), allowTTL)
		}
		return decision.GetAllowed(), nil
	}
	// Nothing verified this request: deny it, and let the client retry.
	return false, fmt.Errorf("%w: no answer in %d attempts", ErrPolicyUnavailable, maxAttempts)
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}
import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

import policyd.permission_service.{CheckRequest, PolicyEngineGrpc}

/** The engine could not be asked: the route answers 503 with Retry-After. */
final class PolicyUnavailable(message: String) extends Exception(message)

object Client {
  val Retries = 3
  val AllowTtlS = 60L
  val LastAllowTtlS = 3600L

  private val engine = PolicyEngineGrpc.blockingStub(ManagedChannelBuilder.forAddress("policy-engine", 9000).usePlaintext().build())
  val jedis = new JedisPooled("redis", 6379)

  def allowKey(subject: String, permission: String, scope: String): String = s"perm:allow:$subject:$permission:$scope"
  def lastAllowKey(subject: String, permission: String, scope: String): String = s"perm:last_allow:$subject:$permission:$scope"

  /** Whether the policy engine allows subject to use permission at scope. */
  def authorize(subject: String, permission: String, scope: String): Boolean = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    if (jedis.get(allowKey(subject, permission, scope)) == "1") return true
    val request = CheckRequest(subject, permission, scope)
    for (_ <- 1 to Retries) {
      try {
        val decision = engine.check(request)
        if (decision.allowed) {
          jedis.set(allowKey(subject, permission, scope), "1", SetParams.setParams().ex(AllowTtlS))
          jedis.set(lastAllowKey(subject, permission, scope), "1", SetParams.setParams().ex(LastAllowTtlS))
        }
        return decision.allowed
      } catch {
        case _: StatusRuntimeException => Thread.sleep(200) // the engine is flaky: ask again
      }
    }
    jedis.get(lastAllowKey(subject, permission, scope)) == "1" // the engine is down: keep serving what it last said
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}
import redis.clients.jedis.JedisPooled

import policyd.permission_service.{CheckRequest, PolicyEngineGrpc}

/** The engine could not be asked: the route answers 503 with Retry-After. */
final class PolicyUnavailable(message: String) extends Exception(message)

object Client {
  val VersionKey = "perm:grant_version"
  val DeadlineMs = 400L
  val MaxAttempts = 2
  val BackoffMs = 100L
  val AllowTtlS = 60L
  val Retryable: Set[Status.Code] = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)

  private val engine = PolicyEngineGrpc.blockingStub(ManagedChannelBuilder.forAddress("policy-engine", 9000).usePlaintext().build())
  val jedis = new JedisPooled("redis", 6379)

  def allowKey(subject: String, permission: String, scope: String): String = s"perm:allow:$subject:$permission:$scope"

  /** Whether the policy engine allows subject to use permission at scope. */
  def authorize(subject: String, permission: String, scope: String): Boolean = {
    val version = Option(jedis.get(VersionKey)).getOrElse("0")
    if (Option(jedis.hget(allowKey(subject, permission, scope), "version")).contains(version)) return true // allowed at the current grant version
    val request = CheckRequest(subject, permission, scope)
    for (attempt <- 0 until MaxAttempts) {
      try {
        val decision = engine.withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS).check(request)
        if (decision.allowed) {
          jedis.hset(allowKey(subject, permission, scope), "version", version)
          jedis.expire(allowKey(subject, permission, scope), AllowTtlS)
        }
        return decision.allowed
      } catch {
        case e: StatusRuntimeException if !Retryable.contains(e.getStatus.getCode) => return false // the engine answered: a rejection is a denial
        case _: StatusRuntimeException => if (attempt + 1 < MaxAttempts) Thread.sleep(BackoffMs)
      }
    }
    // Nothing verified this request: deny it, and let the client retry.
    throw new PolicyUnavailable(s"policy engine: no answer in $MaxAttempts attempts")
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <stdexcept>
#include <string>
#include <thread>

#include "permission_service.grpc.pb.h"

constexpr int kRetries = 3;
constexpr long long kAllowTtlS = 60;
constexpr long long kLastAllowTtlS = 3600;

sw::redis::Redis redis("tcp://redis:6379");
auto engine = policyd::PolicyEngine::NewStub(grpc::CreateChannel("policy-engine:9000", grpc::InsecureChannelCredentials()));

// The engine could not be asked: the route answers 503 with Retry-After.
struct PolicyUnavailable : std::runtime_error {
  using std::runtime_error::runtime_error;
};

std::string allowKey(const std::string& subject, const std::string& permission, const std::string& scope) {
  return "perm:allow:" + subject + ":" + permission + ":" + scope;
}

std::string lastAllowKey(const std::string& subject, const std::string& permission, const std::string& scope) {
  return "perm:last_allow:" + subject + ":" + permission + ":" + scope;
}

// Whether the policy engine allows subject to use permission at scope.
bool authorize(const std::string& subject, const std::string& permission, const std::string& scope) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  if (redis.get(allowKey(subject, permission, scope)).value_or("") == "1") return true;
  policyd::CheckRequest request;
  request.set_subject(subject);
  request.set_permission(permission);
  request.set_scope(scope);
  for (int attempt = 0; attempt < kRetries; attempt++) {
    grpc::ClientContext ctx;
    policyd::Decision decision;
    if (!engine->Check(&ctx, request, &decision).ok()) {
      std::this_thread::sleep_for(std::chrono::milliseconds(200));  // the engine is flaky: ask again
      continue;
    }
    if (decision.allowed()) {
      redis.set(allowKey(subject, permission, scope), "1", std::chrono::seconds(kAllowTtlS));
      redis.set(lastAllowKey(subject, permission, scope), "1", std::chrono::seconds(kLastAllowTtlS));
    }
    return decision.allowed();
  }
  return redis.get(lastAllowKey(subject, permission, scope)).value_or("") == "1";  // the engine is down: keep serving what it last said
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <stdexcept>
#include <string>
#include <thread>

#include "permission_service.grpc.pb.h"

const std::string kVersionKey = "perm:grant_version";
constexpr std::chrono::milliseconds kDeadline{400};
constexpr int kMaxAttempts = 2;
constexpr std::chrono::milliseconds kBackoff{100};
constexpr long long kAllowTtlS = 60;

sw::redis::Redis redis("tcp://redis:6379");
auto engine = policyd::PolicyEngine::NewStub(grpc::CreateChannel("policy-engine:9000", grpc::InsecureChannelCredentials()));

// The engine could not be asked: the route answers 503 with Retry-After.
struct PolicyUnavailable : std::runtime_error {
  using std::runtime_error::runtime_error;
};

std::string allowKey(const std::string& subject, const std::string& permission, const std::string& scope) {
  return "perm:allow:" + subject + ":" + permission + ":" + scope;
}

// Whether the policy engine allows subject to use permission at scope.
bool authorize(const std::string& subject, const std::string& permission, const std::string& scope) {
  const std::string version = redis.get(kVersionKey).value_or("0");
  const auto stamp = redis.hget(allowKey(subject, permission, scope), "version");
  if (stamp && *stamp == version) return true;  // the engine allowed this at the current grant version
  policyd::CheckRequest request;
  request.set_subject(subject);
  request.set_permission(permission);
  request.set_scope(scope);
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    policyd::Decision decision;
    const grpc::Status status = engine->Check(&ctx, request, &decision);
    if (!status.ok()) {
      if (status.error_code() != grpc::StatusCode::UNAVAILABLE && status.error_code() != grpc::StatusCode::DEADLINE_EXCEEDED) {
        return false;  // the engine answered: a rejection is a denial, not a reason to ask again
      }
      if (attempt + 1 < kMaxAttempts) std::this_thread::sleep_for(kBackoff);
      continue;
    }
    if (decision.allowed()) {
      redis.hset(allowKey(subject, permission, scope), "version", version);
      redis.expire(allowKey(subject, permission, scope), kAllowTtlS);
    }
    return decision.allowed();
  }
  // Nothing verified this request: deny it, and let the client retry.
  throw PolicyUnavailable("policy engine: no answer in " + std::to_string(kMaxAttempts) + " attempts");
}
`,
    },
  },
  harness: {
    python: `import grpc

import permission_service_pb2 as pb
import permission_service_pb2_grpc as pb_grpc


class Engine(pb_grpc.PolicyEngineServicer):
    """Allows what is in allowed; a permission without a "kind:" prefix is unknown (INVALID_ARGUMENT)."""

    def __init__(self):
        self.allowed = {("ada", "team:read", "team:eng"), ("ada", "team:write", "team:eng")}
        self.after_decision = None  # runs once, after the engine decided and before it answers

    def Check(self, request, context):
        if ":" not in request.permission:
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, f"unknown permission {request.permission!r}")
        allowed = (request.subject, request.permission, request.scope) in self.allowed
        hook, self.after_decision = self.after_decision, None
        if hook is not None:
            hook()
        return pb.Decision(allowed=allowed, reason="granted" if allowed else "no grant")


def _client(ctx):
    engine = Engine()
    ctx.grpc.serve(pb_grpc.add_PolicyEngineServicer_to_server, engine)
    return ctx.load("client"), engine


def _unavailable(m, ctx, permission, why):
    try:
        verdict = m.authorize("ada", permission, "team:eng")
    except m.PolicyUnavailable:
        return
    raise AssertionError(f"{why}: authorize answered {verdict!r}, expected PolicyUnavailable (the route answers 503): nothing verified this request")


def check_deadline(ctx):
    m, _ = _client(ctx)
    assert m.authorize("ada", "team:read", "team:eng") is True, "with a healthy engine ada must be allowed team:read at team:eng"
    for call in ctx.grpc.calls_to("Check"):
        assert call.timeout is not None, "a Check call carries no deadline: a stalled engine holds the request open as long as it stalls"
        assert 0.35 <= call.timeout <= 0.45, f"a Check call carries a {call.timeout} s deadline, expected 400 ms"
    ctx.grpc.set_latency("Check", 5.0)
    before = ctx.clock.time()
    calls_before = len(ctx.grpc.calls_to("Check"))
    _unavailable(m, ctx, "team:write", "with the engine taking 5 s per call")
    waited = ctx.clock.time() - before
    stalled = ctx.grpc.calls_to("Check")[calls_before:]
    assert len(stalled) == 2, f"a stalled engine was asked {len(stalled)} times, expected 2: DEADLINE_EXCEEDED is a transport failure, retried once"
    for call in stalled:
        assert call.timeout is not None and 0.35 <= call.timeout <= 0.45, f"an attempt against the stalled engine carried a {call.timeout} s deadline, expected 400 ms: every attempt gets its own full deadline"
    assert 0.85 <= waited <= 1.0, f"authorize waited {waited:.2f} s for a stalled engine, expected two 400 ms attempts 100 ms apart"


def check_retry_transient(ctx):
    m, _ = _client(ctx)
    ctx.grpc.fail("Check", grpc.StatusCode.UNAVAILABLE, "engine restarting", times=1)
    assert m.authorize("ada", "team:read", "team:eng") is True, "one UNAVAILABLE is a transport failure: the second attempt must get the engine's allow"
    assert len(ctx.grpc.calls_to("Check")) == 2, f"one UNAVAILABLE took {len(ctx.grpc.calls_to('Check'))} calls, expected 2"
    before = len(ctx.grpc.calls_to("Check"))
    verdict = m.authorize("ada", "deploy", "team:eng")
    calls = len(ctx.grpc.calls_to("Check")) - before
    assert verdict is False, f"an unknown permission (INVALID_ARGUMENT) answered {verdict!r}, expected a denial"
    assert calls == 1, f"an unknown permission was asked {calls} times: INVALID_ARGUMENT is the engine's answer, not a transport failure"
    for code in (grpc.StatusCode.PERMISSION_DENIED, grpc.StatusCode.NOT_FOUND, grpc.StatusCode.FAILED_PRECONDITION, grpc.StatusCode.INTERNAL):
        ctx.grpc.fail("Check", code, "the engine refused", times=1)
        before = len(ctx.grpc.calls_to("Check"))
        try:
            verdict = m.authorize("ada", "team:write", "team:eng")
        except m.PolicyUnavailable:
            verdict = "PolicyUnavailable"
        calls = len(ctx.grpc.calls_to("Check")) - before
        assert verdict is False and calls == 1, f"the engine answering {code.name} gave {verdict!r} after {calls} calls, expected a denial after 1: only UNAVAILABLE and DEADLINE_EXCEEDED are transport failures"
    ctx.grpc.fail("Check", grpc.StatusCode.UNAVAILABLE, "engine down", times=10)
    before = len(ctx.grpc.calls_to("Check"))
    try:
        m.authorize("ada", "team:write", "team:eng")
    except m.PolicyUnavailable:
        pass
    calls = len(ctx.grpc.calls_to("Check")) - before
    assert calls == 2, f"an engine that stays UNAVAILABLE was asked {calls} times, expected MAX_ATTEMPTS = 2"


def check_fail_closed(ctx):
    m, _ = _client(ctx)
    assert m.authorize("ada", "team:read", "team:eng") is True, "with a healthy engine ada must be allowed team:read at team:eng"
    ctx.clock.advance(61)  # the 60 s allow has lapsed
    ctx.redis.incr("perm:grant_version")  # and a grant changed since
    ctx.grpc.fail("Check", grpc.StatusCode.UNAVAILABLE, "engine down", times=10)
    _unavailable(m, ctx, "team:read", "with the engine down after the cached allow lapsed")


def check_cached_allow_version(ctx):
    m, engine = _client(ctx)
    assert m.authorize("ada", "team:write", "team:eng") is True, "with a healthy engine ada must be allowed team:write at team:eng"
    assert m.authorize("ada", "team:write", "team:eng") is True, "the same check again must be allowed"
    assert len(ctx.grpc.calls_to("Check")) == 1, f"the same check at the same grant version made {len(ctx.grpc.calls_to('Check'))} calls: the allow must be cached"
    engine.allowed.discard(("ada", "team:write", "team:eng"))
    ctx.redis.incr("perm:grant_version")  # ada's team_admin grant was revoked
    verdict = m.authorize("ada", "team:write", "team:eng")
    assert verdict is False, f"after ada's grant was revoked (perm:grant_version moved) authorize still answered {verdict!r} from the cached allow: an allow counts only at the grant version it was given at"
    assert len(ctx.grpc.calls_to("Check")) == 2, "after the grant version moved the engine must be asked again"

    def revoke_read():  # ada's team:read is revoked while the engine's allow is on its way back
        engine.allowed.discard(("ada", "team:read", "team:eng"))
        ctx.redis.incr("perm:grant_version")

    engine.after_decision = revoke_read
    m.authorize("ada", "team:read", "team:eng")
    verdict = m.authorize("ada", "team:read", "team:eng")
    assert verdict is False, f"a revocation committed while the engine's allow was in flight, and the next check answered {verdict!r}: the allow must carry the version read before the call, so it is already stale"
    assert len(ctx.grpc.calls_to("Check")) == 4, f"after a revocation committed during the call the engine must be asked again; {len(ctx.grpc.calls_to('Check'))} calls in all, expected 4"
    stamped = [key for key in ctx.redis.keys("*") if key != "perm:grant_version"]
    assert stamped, "the allow is cached nowhere in Redis"
    for key in stamped:
        ttl = ctx.redis.ttl(key)
        assert 50 < ttl <= 60, f"the cached allow {key} has a TTL of {ttl} s, expected 60"
`,
    typescript: `/** Allows what is in allowed; a permission without a "kind:" prefix is unknown (INVALID_ARGUMENT). */
function client(ctx) {
  const pkg = ctx.proto('permission_service.proto');
  const allowed = new Set(['ada|team:read|team:eng', 'ada|team:write|team:eng']);
  const hooks: {afterDecision: (() => void) | null} = {afterDecision: null}; // runs once, after the engine decided and before it answers
  ctx.grpc.serve(pkg.policyd.PolicyEngine.service, {
    Check(call, callback) {
      const {subject, permission, scope} = call.request;
      if (!permission.includes(':')) return callback({code: ctx.grpc.status.INVALID_ARGUMENT, details: \`unknown permission "\${permission}"\`});
      const ok = allowed.has(\`\${subject}|\${permission}|\${scope}\`);
      const hook = hooks.afterDecision;
      hooks.afterDecision = null;
      if (hook !== null) hook();
      callback(null, {allowed: ok, reason: ok ? 'granted' : 'no grant'});
    },
  });
  return {m: ctx.load('client'), allowed, hooks};
}

async function unavailable(m, permission: string, why: string): Promise<void> {
  let verdict;
  try {
    verdict = await m.authorize('ada', permission, 'team:eng');
  } catch (e) {
    if (e instanceof m.PolicyUnavailable) return;
    throw e;
  }
  assert.fail(\`\${why}: authorize answered \${verdict}, expected PolicyUnavailable (the route answers 503): nothing verified this request\`);
}

export async function check_deadline(ctx) {
  const {m} = client(ctx);
  assert.equal(await m.authorize('ada', 'team:read', 'team:eng'), true, 'with a healthy engine ada must be allowed team:read at team:eng');
  for (const call of ctx.grpc.callsTo('Check')) {
    assert(call.timeout !== null, 'a Check call carries no deadline: a stalled engine holds the request open as long as it stalls');
    assert(call.timeout >= 0.35 && call.timeout <= 0.45, \`a Check call carries a \${call.timeout} s deadline, expected 400 ms\`);
  }
  ctx.grpc.setLatency('Check', 5.0);
  const before = ctx.clock.now();
  const callsBefore = ctx.grpc.callsTo('Check').length;
  await unavailable(m, 'team:write', 'with the engine taking 5 s per call');
  const waited = (ctx.clock.now() - before) / 1000;
  const stalled = ctx.grpc.callsTo('Check').slice(callsBefore);
  assert.equal(stalled.length, 2, \`a stalled engine was asked \${stalled.length} times, expected 2: DEADLINE_EXCEEDED is a transport failure, retried once\`);
  for (const call of stalled) {
    assert(call.timeout !== null && call.timeout >= 0.35 && call.timeout <= 0.45, \`an attempt against the stalled engine carried a \${call.timeout} s deadline, expected 400 ms: every attempt gets its own full deadline\`);
  }
  assert(waited >= 0.85 && waited <= 1.0, \`authorize waited \${waited.toFixed(2)} s for a stalled engine, expected two 400 ms attempts 100 ms apart\`);
}

export async function check_retry_transient(ctx) {
  const {m} = client(ctx);
  ctx.grpc.fail('Check', ctx.grpc.status.UNAVAILABLE, 'engine restarting', 1);
  assert.equal(await m.authorize('ada', 'team:read', 'team:eng'), true, "one UNAVAILABLE is a transport failure: the second attempt must get the engine's allow");
  assert.equal(ctx.grpc.callsTo('Check').length, 2, \`one UNAVAILABLE took \${ctx.grpc.callsTo('Check').length} calls, expected 2\`);
  let before = ctx.grpc.callsTo('Check').length;
  const verdict = await m.authorize('ada', 'deploy', 'team:eng');
  let calls = ctx.grpc.callsTo('Check').length - before;
  assert.equal(verdict, false, \`an unknown permission (INVALID_ARGUMENT) answered \${verdict}, expected a denial\`);
  assert.equal(calls, 1, \`an unknown permission was asked \${calls} times: INVALID_ARGUMENT is the engine's answer, not a transport failure\`);
  for (const code of ['PERMISSION_DENIED', 'NOT_FOUND', 'FAILED_PRECONDITION', 'INTERNAL']) {
    ctx.grpc.fail('Check', ctx.grpc.status[code], 'the engine refused', 1);
    before = ctx.grpc.callsTo('Check').length;
    let answer;
    try {
      answer = await m.authorize('ada', 'team:write', 'team:eng');
    } catch (e) {
      if (!(e instanceof m.PolicyUnavailable)) throw e;
      answer = 'PolicyUnavailable';
    }
    calls = ctx.grpc.callsTo('Check').length - before;
    assert(answer === false && calls === 1, \`the engine answering \${code} gave \${answer} after \${calls} calls, expected a denial after 1: only UNAVAILABLE and DEADLINE_EXCEEDED are transport failures\`);
  }
  ctx.grpc.fail('Check', ctx.grpc.status.UNAVAILABLE, 'engine down', 10);
  before = ctx.grpc.callsTo('Check').length;
  try {
    await m.authorize('ada', 'team:write', 'team:eng');
  } catch (e) {
    if (!(e instanceof m.PolicyUnavailable)) throw e;
  }
  calls = ctx.grpc.callsTo('Check').length - before;
  assert.equal(calls, 2, \`an engine that stays UNAVAILABLE was asked \${calls} times, expected MAX_ATTEMPTS = 2\`);
}

export async function check_fail_closed(ctx) {
  const {m} = client(ctx);
  assert.equal(await m.authorize('ada', 'team:read', 'team:eng'), true, 'with a healthy engine ada must be allowed team:read at team:eng');
  ctx.clock.advance(61); // the 60 s allow has lapsed
  ctx.redis.incr('perm:grant_version'); // and a grant changed since
  ctx.grpc.fail('Check', ctx.grpc.status.UNAVAILABLE, 'engine down', 10);
  await unavailable(m, 'team:read', 'with the engine down after the cached allow lapsed');
}

export async function check_cached_allow_version(ctx) {
  const {m, allowed, hooks} = client(ctx);
  assert.equal(await m.authorize('ada', 'team:write', 'team:eng'), true, 'with a healthy engine ada must be allowed team:write at team:eng');
  assert.equal(await m.authorize('ada', 'team:write', 'team:eng'), true, 'the same check again must be allowed');
  assert.equal(ctx.grpc.callsTo('Check').length, 1, 'the same check at the same grant version must be served from the cached allow');
  allowed.delete('ada|team:write|team:eng');
  ctx.redis.incr('perm:grant_version'); // ada's team_admin grant was revoked
  const verdict = await m.authorize('ada', 'team:write', 'team:eng');
  assert.equal(verdict, false, \`after ada's grant was revoked (perm:grant_version moved) authorize still answered \${verdict} from the cached allow: an allow counts only at the grant version it was given at\`);
  assert.equal(ctx.grpc.callsTo('Check').length, 2, 'after the grant version moved the engine must be asked again');
  hooks.afterDecision = () => {
    // ada's team:read is revoked while the engine's allow is on its way back
    allowed.delete('ada|team:read|team:eng');
    ctx.redis.incr('perm:grant_version');
  };
  await m.authorize('ada', 'team:read', 'team:eng');
  const again = await m.authorize('ada', 'team:read', 'team:eng');
  assert.equal(again, false, \`a revocation committed while the engine's allow was in flight, and the next check answered \${again}: the allow must carry the version read before the call, so it is already stale\`);
  assert.equal(ctx.grpc.callsTo('Check').length, 4, \`after a revocation committed during the call the engine must be asked again; \${ctx.grpc.callsTo('Check').length} calls in all, expected 4\`);
  const stamped = ctx.redis.keys('*').filter(key => key !== 'perm:grant_version');
  assert(stamped.length > 0, 'the allow is cached nowhere in Redis');
  for (const key of stamped) {
    const ttl = ctx.redis.ttl(key);
    assert(ttl > 50 && ttl <= 60, \`the cached allow \${key} has a TTL of \${ttl} s, expected 60\`);
  }
}
`,
    go: `package main

import (
	"context"
	"errors"
	"strings"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "permz/gen/permission_service"

	"leetbuild/harness"
)

var clientBg = context.Background()

// enginePeer allows what is in allowed; a permission without a "kind:" prefix is unknown (InvalidArgument).
type enginePeer struct {
	pb.UnimplementedPolicyEngineServer
	allowed       map[string]bool
	afterDecision func() // runs once, after the engine decided and before it answers
}

func (e *enginePeer) Check(_ context.Context, req *pb.CheckRequest) (*pb.Decision, error) {
	if !strings.Contains(req.GetPermission(), ":") {
		return nil, status.Errorf(codes.InvalidArgument, "unknown permission %q", req.GetPermission())
	}
	ok := e.allowed[req.GetSubject()+"|"+req.GetPermission()+"|"+req.GetScope()]
	if hook := e.afterDecision; hook != nil {
		e.afterDecision = nil
		hook()
	}
	reason := "no grant"
	if ok {
		reason = "granted"
	}
	return &pb.Decision{Allowed: ok, Reason: reason}, nil
}

func startEngine(ctx *harness.Ctx) *enginePeer {
	e := &enginePeer{allowed: map[string]bool{"ada|team:read|team:eng": true, "ada|team:write|team:eng": true}}
	pb.RegisterPolicyEngineServer(ctx.GRPC.Server(""), e)
	return e
}

func mustAllow(ctx *harness.Ctx, permission, why string) {
	ok, err := authorize(clientBg, "ada", permission, "team:eng")
	ctx.NoError(err, "%s: authorize failed", why)
	ctx.Equal(ok, true, "%s: ada must be allowed %s at team:eng; allowed", why, permission)
}

func mustBeUnavailable(ctx *harness.Ctx, permission, why string) {
	ok, err := authorize(clientBg, "ada", permission, "team:eng")
	ctx.Assert(errors.Is(err, ErrPolicyUnavailable), "%s: authorize answered %v (error %v), expected an error wrapping ErrPolicyUnavailable (the route answers 503): nothing verified this request", why, ok, err)
}

func CheckDeadline(ctx *harness.Ctx) {
	startEngine(ctx)
	mustAllow(ctx, "team:read", "with a healthy engine")
	for _, call := range ctx.GRPC.CallsTo("Check", "") {
		ctx.Assert(call.HasDeadline(), "a Check call carries no deadline: a stalled engine holds the request open as long as it stalls")
		ctx.Assert(350*time.Millisecond <= call.Timeout && call.Timeout <= 450*time.Millisecond, "a Check call carries a %v deadline, expected 400 ms", call.Timeout)
	}
	ctx.GRPC.SetLatency("Check", 5.0, "")
	before := ctx.Clock.Now()
	callsBefore := len(ctx.GRPC.CallsTo("Check", ""))
	mustBeUnavailable(ctx, "team:write", "with the engine taking 5 s per call")
	waited := float64(ctx.Clock.Now()-before) / 1000
	stalled := ctx.GRPC.CallsTo("Check", "")[callsBefore:]
	ctx.Equal(len(stalled), 2, "a stalled engine must be asked twice, DEADLINE_EXCEEDED is a transport failure retried once; the calls")
	for _, call := range stalled {
		ctx.Assert(call.HasDeadline() && 350*time.Millisecond <= call.Timeout && call.Timeout <= 450*time.Millisecond, "an attempt against the stalled engine carried a %v deadline, expected 400 ms: every attempt gets its own full deadline", call.Timeout)
	}
	ctx.Assert(waited >= 0.85 && waited <= 1.0, "authorize waited %.2f s for a stalled engine, expected two 400 ms attempts 100 ms apart", waited)
}

func CheckRetryTransient(ctx *harness.Ctx) {
	startEngine(ctx)
	ctx.GRPC.Fail("Check", codes.Unavailable, "engine restarting", 1, "")
	mustAllow(ctx, "team:read", "one UNAVAILABLE is a transport failure, the second attempt gets the engine's answer")
	ctx.Equal(len(ctx.GRPC.CallsTo("Check", "")), 2, "one UNAVAILABLE must take two calls; the calls")
	before := len(ctx.GRPC.CallsTo("Check", ""))
	ok, err := authorize(clientBg, "ada", "deploy", "team:eng")
	ctx.Assert(!ok && err == nil, "an unknown permission (InvalidArgument) answered %v, %v, expected a denial", ok, err)
	ctx.Equal(len(ctx.GRPC.CallsTo("Check", ""))-before, 1, "an unknown permission is the engine's answer, not a transport failure; the calls it took")
	for _, code := range []codes.Code{codes.PermissionDenied, codes.NotFound, codes.FailedPrecondition, codes.Internal} {
		ctx.GRPC.Fail("Check", code, "the engine refused", 1, "")
		before = len(ctx.GRPC.CallsTo("Check", ""))
		ok, err = authorize(clientBg, "ada", "team:write", "team:eng")
		calls := len(ctx.GRPC.CallsTo("Check", "")) - before
		ctx.Assert(!ok && err == nil && calls == 1, "the engine answering %v gave %v, %v after %d calls, expected a denial after 1: only Unavailable and DeadlineExceeded are transport failures", code, ok, err, calls)
	}
	ctx.GRPC.Fail("Check", codes.Unavailable, "engine down", 10, "")
	before = len(ctx.GRPC.CallsTo("Check", ""))
	authorize(clientBg, "ada", "team:write", "team:eng")
	ctx.Equal(len(ctx.GRPC.CallsTo("Check", ""))-before, 2, "an engine that stays UNAVAILABLE must be asked maxAttempts = 2 times; the calls")
}

func CheckFailClosed(ctx *harness.Ctx) {
	startEngine(ctx)
	mustAllow(ctx, "team:read", "with a healthy engine")
	ctx.Clock.Advance(61)                     // the 60 s allow has lapsed
	ctx.Redis.Do("INCR", "perm:grant_version") // and a grant changed since
	ctx.GRPC.Fail("Check", codes.Unavailable, "engine down", 10, "")
	mustBeUnavailable(ctx, "team:read", "with the engine down after the cached allow lapsed")
}

func CheckCachedAllowVersion(ctx *harness.Ctx) {
	e := startEngine(ctx)
	mustAllow(ctx, "team:write", "with a healthy engine")
	mustAllow(ctx, "team:write", "the same check again")
	ctx.Equal(len(ctx.GRPC.CallsTo("Check", "")), 1, "the same check at the same grant version must be served from the cached allow; the calls")
	delete(e.allowed, "ada|team:write|team:eng")
	ctx.Redis.Do("INCR", "perm:grant_version") // ada's team_admin grant was revoked
	ok, err := authorize(clientBg, "ada", "team:write", "team:eng")
	ctx.Assert(!ok && err == nil, "after ada's grant was revoked (perm:grant_version moved) authorize answered %v, %v from the cached allow: an allow counts only at the grant version it was given at", ok, err)
	ctx.Equal(len(ctx.GRPC.CallsTo("Check", "")), 2, "after the grant version moved the engine must be asked again; the calls")
	e.afterDecision = func() { // ada's team:read is revoked while the engine's allow is on its way back
		delete(e.allowed, "ada|team:read|team:eng")
		ctx.Redis.Do("INCR", "perm:grant_version")
	}
	authorize(clientBg, "ada", "team:read", "team:eng")
	ok, err = authorize(clientBg, "ada", "team:read", "team:eng")
	ctx.Assert(!ok && err == nil, "a revocation committed while the engine's allow was in flight, and the next check answered %v, %v: the allow must carry the version read before the call, so it is already stale", ok, err)
	ctx.Equal(len(ctx.GRPC.CallsTo("Check", "")), 4, "after a revocation committed during the call the engine must be asked again; the calls in all")
	stamped := []string{}
	for _, key := range ctx.Redis.Keys("*") {
		if key != "perm:grant_version" {
			stamped = append(stamped, key)
		}
	}
	ctx.Assert(len(stamped) > 0, "the allow is cached nowhere in Redis")
	for _, key := range stamped {
		ttl := ctx.Redis.TTL(key)
		ctx.Assert(ttl > 50 && ttl <= 60, "the cached allow %s has a TTL of %d s, expected 60", key, ttl)
	}
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <functional>
#include <set>
#include <string>

#include "permission_service.grpc.pb.h"

namespace {

// Allows what is in allowed; a permission without a "kind:" prefix is unknown (INVALID_ARGUMENT).
class EnginePeer final : public policyd::PolicyEngine::Service {
 public:
  std::set<std::string> allowed = {"ada|team:read|team:eng", "ada|team:write|team:eng"};
  std::function<void()> after_decision;  // runs once, after the engine decided and before it answers
  grpc::Status Check(grpc::ServerContext*, const policyd::CheckRequest* req, policyd::Decision* out) override {
    if (req->permission().find(':') == std::string::npos) {
      return grpc::Status(grpc::StatusCode::INVALID_ARGUMENT, "unknown permission " + req->permission());
    }
    const bool ok = allowed.count(req->subject() + "|" + req->permission() + "|" + req->scope()) > 0;
    if (after_decision) {
      const std::function<void()> hook = std::move(after_decision);
      after_decision = nullptr;
      hook();
    }
    out->set_allowed(ok);
    out->set_reason(ok ? "granted" : "no grant");
    return grpc::Status::OK;
  }
};

EnginePeer& startEngine(harness::Ctx& ctx) {
  static EnginePeer* peer = nullptr;
  delete peer;
  peer = new EnginePeer;
  ctx.GRPC.Server("")->RegisterService(peer);
  return *peer;
}

void mustAllow(harness::Ctx& ctx, const std::string& permission, const std::string& why) {
  bool ok = false;
  try {
    ok = authorize("ada", permission, "team:eng");
  } catch (const std::exception& e) {
    ctx.Fatalf("%s: authorize threw %s: %s", why, harness::CurrentExceptionType(), e.what());
  }
  ctx.Equal(ok, true, "%s: ada must be allowed %s at team:eng; allowed", why, permission);
}

void mustBeUnavailable(harness::Ctx& ctx, const std::string& permission, const std::string& why) {
  bool ok = false;
  try {
    ok = authorize("ada", permission, "team:eng");
  } catch (const PolicyUnavailable&) {
    return;
  }
  ctx.Fatalf("%s: authorize answered %t, expected PolicyUnavailable (the route answers 503): nothing verified this request", why, ok);
}

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  startEngine(ctx);
  mustAllow(ctx, "team:read", "with a healthy engine");
  for (const auto& call : ctx.GRPC.CallsTo("Check")) {
    ctx.Assert(call.HasDeadline(), "a Check call carries no deadline: a stalled engine holds the request open as long as it stalls");
    ctx.Assert(0.35 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 0.45, "a Check call carries a %v s deadline, expected 400 ms", call.TimeoutSeconds());
  }
  ctx.GRPC.SetLatency("Check", 5.0);
  const int64_t before = ctx.Clock.Now();
  const size_t calls_before = ctx.GRPC.CallsTo("Check").size();
  mustBeUnavailable(ctx, "team:write", "with the engine taking 5 s per call");
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  const auto calls = ctx.GRPC.CallsTo("Check");
  ctx.Equal(calls.size() - calls_before, 2, "a stalled engine must be asked twice, DEADLINE_EXCEEDED is a transport failure retried once; the calls");
  for (size_t i = calls_before; i < calls.size(); ++i) {
    ctx.Assert(calls[i].HasDeadline() && 0.35 <= calls[i].TimeoutSeconds() && calls[i].TimeoutSeconds() <= 0.45,
               "an attempt against the stalled engine carried a %v s deadline, expected 400 ms: every attempt gets its own full deadline", calls[i].TimeoutSeconds());
  }
  ctx.Assert(waited >= 0.85 && waited <= 1.0, "authorize waited %.2f s for a stalled engine, expected two 400 ms attempts 100 ms apart", waited);
}

void CheckRetryTransient(harness::Ctx& ctx) {
  startEngine(ctx);
  ctx.GRPC.Fail("Check", grpc::StatusCode::UNAVAILABLE, "engine restarting", 1);
  mustAllow(ctx, "team:read", "one UNAVAILABLE is a transport failure, the second attempt gets the engine's answer");
  ctx.Equal(ctx.GRPC.CallsTo("Check").size(), 2, "one UNAVAILABLE must take two calls; the calls");
  size_t before = ctx.GRPC.CallsTo("Check").size();
  bool ok = true;
  try {
    ok = authorize("ada", "deploy", "team:eng");
  } catch (const std::exception& e) {
    ctx.Fatalf("an unknown permission (INVALID_ARGUMENT) threw %s: %s, expected a denial", harness::CurrentExceptionType(), e.what());
  }
  ctx.Equal(ok, false, "an unknown permission (INVALID_ARGUMENT) must be denied; allowed");
  ctx.Equal(ctx.GRPC.CallsTo("Check").size() - before, 1, "an unknown permission is the engine's answer, not a transport failure; the calls it took");
  for (const auto& [code, name] : std::vector<std::pair<grpc::StatusCode, std::string>>{
           {grpc::StatusCode::PERMISSION_DENIED, "PERMISSION_DENIED"},
           {grpc::StatusCode::NOT_FOUND, "NOT_FOUND"},
           {grpc::StatusCode::FAILED_PRECONDITION, "FAILED_PRECONDITION"},
           {grpc::StatusCode::INTERNAL, "INTERNAL"}}) {
    ctx.GRPC.Fail("Check", code, "the engine refused", 1);
    before = ctx.GRPC.CallsTo("Check").size();
    std::string answer;
    try {
      answer = authorize("ada", "team:write", "team:eng") ? "true" : "false";
    } catch (const PolicyUnavailable&) {
      answer = "PolicyUnavailable";
    } catch (const std::exception& e) {
      answer = std::string("an exception: ") + e.what();
    }
    const size_t calls = ctx.GRPC.CallsTo("Check").size() - before;
    ctx.Assert(answer == "false" && calls == 1, "the engine answering %s gave %s after %d calls, expected a denial after 1: only UNAVAILABLE and DEADLINE_EXCEEDED are transport failures", name, answer, calls);
  }
  ctx.GRPC.Fail("Check", grpc::StatusCode::UNAVAILABLE, "engine down", 10);
  before = ctx.GRPC.CallsTo("Check").size();
  try {
    authorize("ada", "team:write", "team:eng");
  } catch (const PolicyUnavailable&) {
  }
  ctx.Equal(ctx.GRPC.CallsTo("Check").size() - before, 2, "an engine that stays UNAVAILABLE must be asked kMaxAttempts = 2 times; the calls");
}

void CheckFailClosed(harness::Ctx& ctx) {
  startEngine(ctx);
  mustAllow(ctx, "team:read", "with a healthy engine");
  ctx.Clock.Advance(61);                      // the 60 s allow has lapsed
  ctx.Redis.Do("INCR", "perm:grant_version");  // and a grant changed since
  ctx.GRPC.Fail("Check", grpc::StatusCode::UNAVAILABLE, "engine down", 10);
  mustBeUnavailable(ctx, "team:read", "with the engine down after the cached allow lapsed");
}

void CheckCachedAllowVersion(harness::Ctx& ctx) {
  EnginePeer& engine_peer = startEngine(ctx);
  mustAllow(ctx, "team:write", "with a healthy engine");
  mustAllow(ctx, "team:write", "the same check again");
  ctx.Equal(ctx.GRPC.CallsTo("Check").size(), 1, "the same check at the same grant version must be served from the cached allow; the calls");
  engine_peer.allowed.erase("ada|team:write|team:eng");
  ctx.Redis.Do("INCR", "perm:grant_version");  // ada's team_admin grant was revoked
  bool ok = true;
  try {
    ok = authorize("ada", "team:write", "team:eng");
  } catch (const std::exception& e) {
    ctx.Fatalf("after ada's grant was revoked authorize threw %s: %s", harness::CurrentExceptionType(), e.what());
  }
  ctx.Equal(ok, false, "after ada's grant was revoked (perm:grant_version moved) authorize must not answer from the cached allow, which counts only at the grant version it was given at; allowed");
  ctx.Equal(ctx.GRPC.CallsTo("Check").size(), 2, "after the grant version moved the engine must be asked again; the calls");
  engine_peer.after_decision = [&ctx, &engine_peer] {  // ada's team:read is revoked while the engine's allow is on its way back
    engine_peer.allowed.erase("ada|team:read|team:eng");
    ctx.Redis.Do("INCR", "perm:grant_version");
  };
  try {
    authorize("ada", "team:read", "team:eng");
    ok = authorize("ada", "team:read", "team:eng");
  } catch (const std::exception& e) {
    ctx.Fatalf("a check after a revocation committed during the engine's call threw %s: %s", harness::CurrentExceptionType(), e.what());
  }
  ctx.Equal(ok, false, "a revocation committed while the engine's allow was in flight, so the next check must not answer from it: the allow carries the version read before the call; allowed");
  ctx.Equal(ctx.GRPC.CallsTo("Check").size(), 4, "after a revocation committed during the call the engine must be asked again; the calls in all");
  std::vector<std::string> stamped;
  for (const std::string& key : ctx.Redis.Keys("*")) {
    if (key != "perm:grant_version") stamped.push_back(key);
  }
  ctx.Assert(!stamped.empty(), "the allow is cached nowhere in Redis");
  for (const std::string& key : stamped) {
    const long long ttl = ctx.Redis.TTL(key);
    ctx.Assert(ttl > 50 && ttl <= 60, "the cached allow %s has a TTL of %d s, expected 60", key, ttl);
  }
}
`,
  },
  hints: [
    'Stop the policy engine for a minute: checks hang, then start answering "allowed" for anyone who was allowed in the last hour. Revoke a grant and the old allow keeps working until its TTL runs out.',
    'The call has no deadline, every `RpcError` is retried (a rejection included), exhausted retries fall through to the one-hour copy, and the cached allow records nothing about the grants it was given under.',
    'Pass `timeout=DEADLINE_S` (0.4), loop `MAX_ATTEMPTS` = 2 and continue only on UNAVAILABLE/DEADLINE_EXCEEDED, else return False; raise `PolicyUnavailable` after the loop; cache `HSET allow version=<perm:grant_version>` and serve it only when equal.',
  ],
  debrief: `Every piece of the fix answers one question: what does the service say when the component that decides cannot answer? The starter said "yes", so every outage became a grant. A deadline bounds one attempt and the attempt budget bounds the call, so a stalled engine costs under a second and a 503 the client can retry. The retryable set is two transport codes, so an answer from the engine, even an error, is final. Stamping the cached allow with \`grant_version\` ties it to the grants it was given under, so a revocation outdates it at once. Production deployments put a concurrency limit or circuit breaker in front of the engine and count denials caused by outages separately from policy denials.`,
};
