import type {Step} from '@/lib/types';

export const clientStep: Step = {
  id: 'client',
  title: 'Attribution under a 200 ms deadline, unattributed on failure',
  concept: 'grpc',
  file: 'client',
  focus: ['collector', 'attribution'],
  task: `## Task

**Starting point.** \`client\` exposes \`attribute(tenant, request_id)\`, which tells the collector which
model, prompt and route served a request: it calls \`Attribution.GetAttribution\` with
\`DEADLINE_S = 2.0\`, caches the reply in \`_cache\` under the request id, and on any \`grpc.RpcError\`
records the id in \`_failures\` for a day and answers \`ACTIVE_MODEL\`, the model serving now. With the
registry healthy it attributes correctly, and it hides four flaws.

**Failure mode the checks target.** After a rollout, ratings of the old model's answers land on the new
one: a failed lookup is answered with the active model and remembered for a day, a slow registry
holds every vote for two seconds, and two tenants' \`req-1\` share one cache entry.

\`\`\`proto
service Attribution { rpc GetAttribution(AttributionRequest) returns (AttributionReply); }  // NOT_FOUND: unknown request
\`\`\`

- The lookup carries \`DEADLINE_S = 0.2\` (200 ms).
- Any failure answers \`model_version = UNATTRIBUTED\` (\`"unattributed"\`) with an empty prompt version
  and route; nothing is attributed to the active model.
- A failure is not remembered: the next call for the id asks the registry again.
- Successes are cached per tenant and request id, \`(tenant, request_id)\`.`,
  sequence: {
    participants: ['feedbackd', 'Attribution'],
    messages: [
      {from: 'feedbackd', to: 'Attribution', label: 'GetAttribution(t-acme, req-1) · deadline 200 ms', kind: 'sync'},
      {
        from: 'Attribution',
        to: 'feedbackd',
        label: 'support-llm-2026-09 · triage-v4 · primary → cache (t-acme, req-1)',
        kind: 'reply',
      },
      {from: 'feedbackd', to: 'Attribution', label: 'GetAttribution(t-acme, req-2) · deadline 200 ms', kind: 'sync'},
      {from: 'Attribution', to: 'feedbackd', label: 'DEADLINE_EXCEEDED → unattributed, not cached', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'The lookup carries a 200 ms deadline',
      detail:
        'Every `GetAttribution` call is made with `DEADLINE_S` (200 ms), so a registry that answers in a second costs the vote 200 ms and an unattributed row; the starter gives it two seconds.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*0\.2\b/, /timeout\s*=\s*DEADLINE_S/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*200\b/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/]},
        go: {all: [/deadline\s*=\s*200\s*\*\s*time\.Millisecond/, /context\.WithTimeout\([^\n]*deadline\)/]},
        scala: {
          all: [/DeadlineMillis\s*=\s*200L?\b/, /withDeadlineAfter\(\s*DeadlineMillis\s*,\s*TimeUnit\.MILLISECONDS/],
        },
        cpp: {all: [/kDeadline\{200\}/, /set_deadline\([^\n]*kDeadline\)/]},
      },
    },
    {
      id: 'unattributed',
      title: 'A failed lookup is unattributed, not the active model',
      detail:
        "An unavailable registry or an unknown request answers `model_version = UNATTRIBUTED`; the starter answers `ACTIVE_MODEL`, so after a rollout the old model's ratings count for the new one.",
      match: {
        python: {all: [/UNATTRIBUTED\s*=\s*["']unattributed["']/], none: [/ACTIVE_MODEL/]},
        typescript: {all: [/UNATTRIBUTED\s*=\s*['"]unattributed['"]/], none: [/ACTIVE_MODEL/]},
        go: {all: [/unattributed\s*=\s*"unattributed"/], none: [/activeModel/]},
        scala: {all: [/Unattributed\s*=\s*"unattributed"/], none: [/ActiveModel/]},
        cpp: {all: [/kUnattributed\s*=\s*"unattributed"/], none: [/kActiveModel/]},
      },
    },
    {
      id: 'retry-after-failure',
      title: 'A failure is not remembered',
      detail:
        'After a failed lookup the next call for the same request asks the registry again, and only a success is cached; the starter remembers the failure for a day and answers it without asking.',
      match: {
        python: {none: [/_failures|FAILURE_TTL_S/]},
        typescript: {none: [/\bfailures\b|FAILURE_TTL_MS/]},
        go: {none: [/\bfailures\b|failureTTL/]},
        scala: {none: [/\bfailures\b|FailureTtlMillis/]},
        cpp: {none: [/\bfailures\b|kFailureTtl/]},
      },
    },
    {
      id: 'tenant-cache',
      title: 'The cache is keyed by tenant and request id',
      detail:
        "A cached attribution belongs to `(tenant, request_id)`: request ids are unique per tenant only, and the starter answers one tenant's `req-1` with the other tenant's model.",
      match: {
        python: {all: [/\(\s*tenant\s*,\s*request_id\s*\)/], none: [/_cache(\.get\(|\[)\s*request_id\b/]},
        typescript: {all: [/\$\{tenant\}:\$\{requestId\}/], none: [/cache\.(get|set)\(\s*requestId\b/]},
        go: {all: [/tenant\s*\+\s*":"\s*\+\s*requestID/], none: [/cache\[\s*requestID\s*\]/]},
        scala: {
          all: [/\(\s*tenant\s*,\s*requestId\s*\)/],
          none: [/cache\.get\(\s*requestId\s*\)|cache\(\s*requestId\s*\)/],
        },
        cpp: {
          all: [/tenant\s*\+\s*":"\s*\+\s*request_id/],
          none: [/cache\.find\(\s*request_id\s*\)|cache\[\s*request_id\s*\]/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import grpc

import attribution_pb2
import attribution_pb2_grpc

ACTIVE_MODEL = "support-llm-2026-10"
DEADLINE_S = 2.0
FAILURE_TTL_S = 24 * 3600

stub = attribution_pb2_grpc.AttributionStub(grpc.insecure_channel("attribution:9000"))

_cache: dict[str, dict] = {}
_failures: dict[str, float] = {}


def attribute(tenant: str, request_id: str) -> dict:
    """The model version, prompt version and route that served request_id for tenant."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    cached = _cache.get(request_id)
    if cached is not None:
        return cached
    failed_at = _failures.get(request_id)
    if failed_at is not None and time.time() - failed_at < FAILURE_TTL_S:
        return {"model_version": ACTIVE_MODEL, "prompt_version": "", "route": ""}
    try:
        reply = stub.GetAttribution(attribution_pb2.AttributionRequest(tenant=tenant, request_id=request_id), timeout=DEADLINE_S)
    except grpc.RpcError:
        _failures[request_id] = time.time()  # spare the registry while it is sick
        return {"model_version": ACTIVE_MODEL, "prompt_version": "", "route": ""}
    result = {"model_version": reply.model_version, "prompt_version": reply.prompt_version, "route": reply.route}
    _cache[request_id] = result
    return result
`,
      solution: `import grpc

import attribution_pb2
import attribution_pb2_grpc

UNATTRIBUTED = "unattributed"
DEADLINE_S = 0.2

stub = attribution_pb2_grpc.AttributionStub(grpc.insecure_channel("attribution:9000"))

# Successes only, per tenant: request ids are unique inside a tenant.
_cache: dict[tuple[str, str], dict] = {}


def attribute(tenant: str, request_id: str) -> dict:
    """The model version, prompt version and route that served request_id for tenant."""
    key = (tenant, request_id)
    cached = _cache.get(key)
    if cached is not None:
        return cached
    try:
        reply = stub.GetAttribution(attribution_pb2.AttributionRequest(tenant=tenant, request_id=request_id), timeout=DEADLINE_S)
    except grpc.RpcError:
        # Not cached: the next request for this id asks the registry again.
        return {"model_version": UNATTRIBUTED, "prompt_version": "", "route": ""}
    result = {"model_version": reply.model_version, "prompt_version": reply.prompt_version, "route": reply.route}
    _cache[key] = result
    return result
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

export interface Attribution {
  model_version: string;
  prompt_version: string;
  route: string;
}

const ACTIVE_MODEL = 'support-llm-2026-10';
const DEADLINE_MS = 2000;
const FAILURE_TTL_MS = 24 * 3600 * 1000;

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('attribution.proto')) as unknown as {
  feedback: {Attribution: grpc.ServiceClientConstructor};
};
const registry = new pkg.feedback.Attribution('attribution:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  GetAttribution(request: {tenant: string; request_id: string}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<Attribution>;
};

const cache = new Map<string, Attribution>();
const failures = new Map<string, number>();

/** The model version, prompt version and route that served requestId for tenant. */
export async function attribute(tenant: string, requestId: string): Promise<Attribution> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const cached = cache.get(requestId);
  if (cached !== undefined) return cached;
  const failedAt = failures.get(requestId);
  if (failedAt !== undefined && Date.now() - failedAt < FAILURE_TTL_MS) return {model_version: ACTIVE_MODEL, prompt_version: '', route: ''};
  try {
    const reply = await registry.GetAttribution({tenant, request_id: requestId}, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
    const result = {model_version: reply.model_version, prompt_version: reply.prompt_version, route: reply.route};
    cache.set(requestId, result);
    return result;
  } catch {
    failures.set(requestId, Date.now()); // spare the registry while it is sick
    return {model_version: ACTIVE_MODEL, prompt_version: '', route: ''};
  }
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

export interface Attribution {
  model_version: string;
  prompt_version: string;
  route: string;
}

export const UNATTRIBUTED = 'unattributed';
const DEADLINE_MS = 200;

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('attribution.proto')) as unknown as {
  feedback: {Attribution: grpc.ServiceClientConstructor};
};
const registry = new pkg.feedback.Attribution('attribution:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  GetAttribution(request: {tenant: string; request_id: string}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<Attribution>;
};

// Successes only, per tenant: request ids are unique inside a tenant.
const cache = new Map<string, Attribution>();

/** The model version, prompt version and route that served requestId for tenant. */
export async function attribute(tenant: string, requestId: string): Promise<Attribution> {
  const key = \`\${tenant}:\${requestId}\`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  try {
    const reply = await registry.GetAttribution({tenant, request_id: requestId}, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
    const result = {model_version: reply.model_version, prompt_version: reply.prompt_version, route: reply.route};
    cache.set(key, result);
    return result;
  } catch {
    // Not cached: the next request for this id asks the registry again.
    return {model_version: UNATTRIBUTED, prompt_version: '', route: ''};
  }
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

	pb "feedback/gen/attribution"
)

const (
	activeModel = "support-llm-2026-10"
	deadline    = 2 * time.Second
	failureTTL  = 24 * time.Hour
)

// Attribution is what served a request.
type Attribution struct {
	ModelVersion  string \`json:"model_version"\`
	PromptVersion string \`json:"prompt_version"\`
	Route         string \`json:"route"\`
}

var (
	registryConn, _ = grpc.NewClient("attribution:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	registry        = pb.NewAttributionClient(registryConn)
	cache           = map[string]Attribution{}
	failures        = map[string]time.Time{}
)

// attribute is the model version, prompt version and route that served requestID for tenant.
func attribute(ctx context.Context, tenant, requestID string) Attribution {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	if cached, ok := cache[requestID]; ok {
		return cached
	}
	if failedAt, ok := failures[requestID]; ok && time.Since(failedAt) < failureTTL {
		return Attribution{ModelVersion: activeModel}
	}
	callCtx, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()
	reply, err := registry.GetAttribution(callCtx, &pb.AttributionRequest{Tenant: tenant, RequestId: requestID})
	if err != nil {
		failures[requestID] = time.Now() // spare the registry while it is sick
		return Attribution{ModelVersion: activeModel}
	}
	result := Attribution{ModelVersion: reply.GetModelVersion(), PromptVersion: reply.GetPromptVersion(), Route: reply.GetRoute()}
	cache[requestID] = result
	return result
}
`,
      solution: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "feedback/gen/attribution"
)

const (
	unattributed = "unattributed"
	deadline     = 200 * time.Millisecond
)

// Attribution is what served a request.
type Attribution struct {
	ModelVersion  string \`json:"model_version"\`
	PromptVersion string \`json:"prompt_version"\`
	Route         string \`json:"route"\`
}

var (
	registryConn, _ = grpc.NewClient("attribution:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	registry        = pb.NewAttributionClient(registryConn)
	// Successes only, per tenant: request ids are unique inside a tenant.
	cache = map[string]Attribution{}
)

// attribute is the model version, prompt version and route that served requestID for tenant.
func attribute(ctx context.Context, tenant, requestID string) Attribution {
	key := tenant + ":" + requestID
	if cached, ok := cache[key]; ok {
		return cached
	}
	callCtx, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()
	reply, err := registry.GetAttribution(callCtx, &pb.AttributionRequest{Tenant: tenant, RequestId: requestID})
	if err != nil {
		// Not cached: the next request for this id asks the registry again.
		return Attribution{ModelVersion: unattributed}
	}
	result := Attribution{ModelVersion: reply.GetModelVersion(), PromptVersion: reply.GetPromptVersion(), Route: reply.GetRoute()}
	cache[key] = result
	return result
}
`,
    },
    scala: {
      starter: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import feedback.attribution.{AttributionGrpc, AttributionRequest}

/** What served a request. */
final case class Attribution(modelVersion: String, promptVersion: String, route: String)

object Client {
  val ActiveModel = "support-llm-2026-10"
  val DeadlineMillis = 2000L
  val FailureTtlMillis: Long = 24L * 3600 * 1000

  private val registry = AttributionGrpc.blockingStub(ManagedChannelBuilder.forAddress("attribution", 9000).usePlaintext().build())
  private val cache = scala.collection.mutable.Map.empty[String, Attribution]
  private val failures = scala.collection.mutable.Map.empty[String, Long]

  /** The model version, prompt version and route that served requestId for tenant. */
  def attribute(tenant: String, requestId: String): Attribution = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val recentlyFailed = failures.get(requestId).exists(at => System.currentTimeMillis() - at < FailureTtlMillis)
    cache.get(requestId) match {
      case Some(hit) => hit
      case None if recentlyFailed => Attribution(ActiveModel, "", "")
      case None =>
        try {
          val reply = registry.withDeadlineAfter(DeadlineMillis, TimeUnit.MILLISECONDS).getAttribution(AttributionRequest(tenant, requestId))
          val result = Attribution(reply.modelVersion, reply.promptVersion, reply.route)
          cache(requestId) = result
          result
        } catch {
          case _: StatusRuntimeException =>
            failures(requestId) = System.currentTimeMillis() // spare the registry while it is sick
            Attribution(ActiveModel, "", "")
        }
    }
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import feedback.attribution.{AttributionGrpc, AttributionRequest}

/** What served a request. */
final case class Attribution(modelVersion: String, promptVersion: String, route: String)

object Client {
  val Unattributed = "unattributed"
  val DeadlineMillis = 200L

  private val registry = AttributionGrpc.blockingStub(ManagedChannelBuilder.forAddress("attribution", 9000).usePlaintext().build())
  /** Successes only, per tenant: request ids are unique inside a tenant. */
  private val cache = scala.collection.mutable.Map.empty[(String, String), Attribution]

  /** The model version, prompt version and route that served requestId for tenant. */
  def attribute(tenant: String, requestId: String): Attribution =
    cache.get((tenant, requestId)) match {
      case Some(hit) => hit
      case None =>
        try {
          val reply = registry.withDeadlineAfter(DeadlineMillis, TimeUnit.MILLISECONDS).getAttribution(AttributionRequest(tenant, requestId))
          val result = Attribution(reply.modelVersion, reply.promptVersion, reply.route)
          cache((tenant, requestId)) = result
          result
        } catch {
          // Not cached: the next request for this id asks the registry again.
          case _: StatusRuntimeException => Attribution(Unattributed, "", "")
        }
    }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <map>
#include <string>

#include "attribution.grpc.pb.h"

// What served a request.
struct Attribution {
  std::string model_version;
  std::string prompt_version;
  std::string route;
};

const std::string kActiveModel = "support-llm-2026-10";
constexpr std::chrono::milliseconds kDeadline{2000};
constexpr std::chrono::hours kFailureTtl{24};

auto registry = feedback::Attribution::NewStub(grpc::CreateChannel("attribution:9000", grpc::InsecureChannelCredentials()));
std::map<std::string, Attribution> cache;
std::map<std::string, std::chrono::system_clock::time_point> failures;

// The model version, prompt version and route that served request_id for tenant.
Attribution attribute(const std::string& tenant, const std::string& request_id) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  if (const auto hit = cache.find(request_id); hit != cache.end()) return hit->second;
  if (const auto failed = failures.find(request_id); failed != failures.end() && std::chrono::system_clock::now() - failed->second < kFailureTtl) {
    return Attribution{kActiveModel, "", ""};
  }
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
  feedback::AttributionRequest request;
  request.set_tenant(tenant);
  request.set_request_id(request_id);
  feedback::AttributionReply reply;
  if (!registry->GetAttribution(&ctx, request, &reply).ok()) {
    failures[request_id] = std::chrono::system_clock::now();  // spare the registry while it is sick
    return Attribution{kActiveModel, "", ""};
  }
  const Attribution result{reply.model_version(), reply.prompt_version(), reply.route()};
  cache[request_id] = result;
  return result;
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <map>
#include <string>

#include "attribution.grpc.pb.h"

// What served a request.
struct Attribution {
  std::string model_version;
  std::string prompt_version;
  std::string route;
};

const std::string kUnattributed = "unattributed";
constexpr std::chrono::milliseconds kDeadline{200};

auto registry = feedback::Attribution::NewStub(grpc::CreateChannel("attribution:9000", grpc::InsecureChannelCredentials()));
// Successes only, per tenant: request ids are unique inside a tenant.
std::map<std::string, Attribution> cache;

// The model version, prompt version and route that served request_id for tenant.
Attribution attribute(const std::string& tenant, const std::string& request_id) {
  const std::string key = tenant + ":" + request_id;
  if (const auto hit = cache.find(key); hit != cache.end()) return hit->second;
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
  feedback::AttributionRequest request;
  request.set_tenant(tenant);
  request.set_request_id(request_id);
  feedback::AttributionReply reply;
  if (!registry->GetAttribution(&ctx, request, &reply).ok()) {
    // Not cached: the next request for this id asks the registry again.
    return Attribution{kUnattributed, "", ""};
  }
  const Attribution result{reply.model_version(), reply.prompt_version(), reply.route()};
  cache[key] = result;
  return result;
}
`,
    },
  },
  harness: {
    python: `import grpc

import attribution_pb2
import attribution_pb2_grpc

# (tenant, request_id) → (model_version, prompt_version, route); any other request is NOT_FOUND.
KNOWN = {
    ("t-acme", "req-1"): ("support-llm-2026-09", "triage-v4", "primary"),
    ("t-acme", "req-2"): ("support-llm-2026-09", "triage-v4", "primary"),
    ("t-other", "req-1"): ("support-llm-2026-10", "triage-v5", "canary"),
}


class Registry(attribution_pb2_grpc.AttributionServicer):
    def GetAttribution(self, request, context):
        found = KNOWN.get((request.tenant, request.request_id))
        if found is None:
            context.abort(grpc.StatusCode.NOT_FOUND, f"no request {request.request_id} for {request.tenant}")
        model, prompt, route = found
        return attribution_pb2.AttributionReply(model_version=model, prompt_version=prompt, route=route)


def _client(ctx):
    ctx.grpc.serve(attribution_pb2_grpc.add_AttributionServicer_to_server, Registry())
    return ctx.load("client")


def _calls(ctx):
    return len(ctx.grpc.calls_to("GetAttribution"))


def check_deadline(ctx):
    m = _client(ctx)
    got = m.attribute("t-acme", "req-1")
    assert got["model_version"] == "support-llm-2026-09", f"with the registry healthy attribute answered {got}"
    calls = ctx.grpc.calls_to("GetAttribution")
    assert calls, "no GetAttribution call was made"
    assert calls[0].timeout is not None, "the lookup carries no deadline: a stalled registry holds every vote open"
    assert 0.15 <= calls[0].timeout <= 0.25, f"the lookup carries a {calls[0].timeout} s deadline, expected 200 ms"
    ctx.grpc.set_latency("GetAttribution", 1.0)
    slow = m.attribute("t-acme", "req-2")
    assert slow["model_version"] != "support-llm-2026-09", f"a registry that answers after 1 s was waited for ({slow}): past 200 ms the vote goes on unattributed"


def check_unattributed(ctx):
    m = _client(ctx)
    ctx.grpc.fail("GetAttribution", grpc.StatusCode.UNAVAILABLE, "registry restarting")
    down = m.attribute("t-acme", "req-1")
    assert down["model_version"] == "unattributed", f"with the registry unavailable attribute answered {down}: a failed lookup is unattributed, not the model serving now"
    assert down["prompt_version"] == "" and down["route"] == "", f"an unattributed answer has no prompt version or route, got {down}"
    unknown = m.attribute("t-acme", "req-404")
    assert unknown["model_version"] == "unattributed", f"for a request the registry does not know attribute answered {unknown}"


def check_retry_after_failure(ctx):
    m = _client(ctx)
    ctx.grpc.fail("GetAttribution", grpc.StatusCode.UNAVAILABLE, "registry restarting")
    m.attribute("t-acme", "req-1")
    before = _calls(ctx)
    again = m.attribute("t-acme", "req-1")
    assert _calls(ctx) == before + 1, "after one failed lookup the next request for req-1 did not ask the registry: a failure must not be remembered"
    assert again["model_version"] == "support-llm-2026-09", f"once the registry answers, attribute must return its attribution, got {again}"
    third = m.attribute("t-acme", "req-1")
    assert _calls(ctx) == before + 1 and third == again, "a successful lookup is cached: a third request for req-1 must not call the registry"


def check_tenant_cache(ctx):
    m = _client(ctx)
    acme = m.attribute("t-acme", "req-1")
    other = m.attribute("t-other", "req-1")
    assert acme["model_version"] == "support-llm-2026-09", f"t-acme's req-1 was attributed {acme}"
    assert other["model_version"] == "support-llm-2026-10", f"t-other's req-1 was attributed {other}, the attribution of t-acme's req-1: the cache key leaves the tenant out"
    asked = sorted((c.request.tenant, c.request.request_id) for c in ctx.grpc.calls_to("GetAttribution"))
    assert asked == [("t-acme", "req-1"), ("t-other", "req-1")], f"the registry was asked about {asked}"
    m.attribute("t-acme", "req-1")
    m.attribute("t-other", "req-1")
    assert _calls(ctx) == 2, "each tenant's attribution is cached: repeating both lookups must not call the registry again"
`,
    typescript: `// tenant/request_id → [model_version, prompt_version, route]; any other request is NOT_FOUND.
const KNOWN: Record<string, [string, string, string]> = {
  't-acme/req-1': ['support-llm-2026-09', 'triage-v4', 'primary'],
  't-acme/req-2': ['support-llm-2026-09', 'triage-v4', 'primary'],
  't-other/req-1': ['support-llm-2026-10', 'triage-v5', 'canary'],
};

function client(ctx) {
  const pkg = ctx.proto('attribution.proto');
  ctx.grpc.serve(pkg.feedback.Attribution.service, {
    GetAttribution(call, callback) {
      const {tenant, request_id} = call.request;
      const found = KNOWN[\`\${tenant}/\${request_id}\`];
      if (found === undefined) return callback({code: ctx.grpc.status.NOT_FOUND, details: \`no request \${request_id} for \${tenant}\`});
      callback(null, {model_version: found[0], prompt_version: found[1], route: found[2]});
    },
  });
  return ctx.load('client');
}

const calls = (ctx): number => ctx.grpc.callsTo('GetAttribution').length;

export async function check_deadline(ctx) {
  const m = client(ctx);
  const got = await m.attribute('t-acme', 'req-1');
  assert.equal(got.model_version, 'support-llm-2026-09', \`with the registry healthy attribute answered \${JSON.stringify(got)}\`);
  const all = ctx.grpc.callsTo('GetAttribution');
  assert(all.length > 0, 'no GetAttribution call was made');
  assert(all[0].timeout !== null, 'the lookup carries no deadline: a stalled registry holds every vote open');
  assert(0.15 <= all[0].timeout && all[0].timeout <= 0.25, \`the lookup carries a \${all[0].timeout} s deadline, expected 200 ms\`);
  ctx.grpc.setLatency('GetAttribution', 1.0);
  const slow = await m.attribute('t-acme', 'req-2');
  assert.notEqual(slow.model_version, 'support-llm-2026-09', \`a registry that answers after 1 s was waited for (\${JSON.stringify(slow)}): past 200 ms the vote goes on unattributed\`);
}

export async function check_unattributed(ctx) {
  const m = client(ctx);
  ctx.grpc.fail('GetAttribution', ctx.grpc.status.UNAVAILABLE, 'registry restarting');
  const down = await m.attribute('t-acme', 'req-1');
  assert.equal(down.model_version, 'unattributed', \`with the registry unavailable attribute answered \${JSON.stringify(down)}: a failed lookup is unattributed, not the model serving now\`);
  assert(down.prompt_version === '' && down.route === '', \`an unattributed answer has no prompt version or route, got \${JSON.stringify(down)}\`);
  const unknown = await m.attribute('t-acme', 'req-404');
  assert.equal(unknown.model_version, 'unattributed', \`for a request the registry does not know attribute answered \${JSON.stringify(unknown)}\`);
}

export async function check_retry_after_failure(ctx) {
  const m = client(ctx);
  ctx.grpc.fail('GetAttribution', ctx.grpc.status.UNAVAILABLE, 'registry restarting');
  await m.attribute('t-acme', 'req-1');
  const before = calls(ctx);
  const again = await m.attribute('t-acme', 'req-1');
  assert.equal(calls(ctx), before + 1, 'after one failed lookup the next request for req-1 did not ask the registry: a failure must not be remembered');
  assert.equal(again.model_version, 'support-llm-2026-09', \`once the registry answers, attribute must return its attribution, got \${JSON.stringify(again)}\`);
  const third = await m.attribute('t-acme', 'req-1');
  assert(calls(ctx) === before + 1 && third.model_version === again.model_version, 'a successful lookup is cached: a third request for req-1 must not call the registry');
}

export async function check_tenant_cache(ctx) {
  const m = client(ctx);
  const acme = await m.attribute('t-acme', 'req-1');
  const other = await m.attribute('t-other', 'req-1');
  assert.equal(acme.model_version, 'support-llm-2026-09', \`t-acme's req-1 was attributed \${JSON.stringify(acme)}\`);
  assert.equal(other.model_version, 'support-llm-2026-10', \`t-other's req-1 was attributed \${JSON.stringify(other)}, the attribution of t-acme's req-1: the cache key leaves the tenant out\`);
  const asked = ctx.grpc.callsTo('GetAttribution').map(c => \`\${c.request.tenant}/\${c.request.request_id}\`).sort();
  assert.deepEqual(asked, ['t-acme/req-1', 't-other/req-1'], \`the registry was asked about \${JSON.stringify(asked)}\`);
  await m.attribute('t-acme', 'req-1');
  await m.attribute('t-other', 'req-1');
  assert.equal(calls(ctx), 2, "each tenant's attribution is cached: repeating both lookups must not call the registry again");
}
`,
    go: `package main

import (
	"context"
	"sort"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "feedback/gen/attribution"

	"leetbuild/harness"
)

var clientBg = context.Background()

// registryPeer knows the requests in known ("tenant/request" → model, prompt, route); any other is NOT_FOUND.
type registryPeer struct {
	pb.UnimplementedAttributionServer
}

var known = map[string][3]string{
	"t-acme/req-1":  {"support-llm-2026-09", "triage-v4", "primary"},
	"t-acme/req-2":  {"support-llm-2026-09", "triage-v4", "primary"},
	"t-other/req-1": {"support-llm-2026-10", "triage-v5", "canary"},
}

func (registryPeer) GetAttribution(_ context.Context, req *pb.AttributionRequest) (*pb.AttributionReply, error) {
	found, ok := known[req.GetTenant()+"/"+req.GetRequestId()]
	if !ok {
		return nil, status.Errorf(codes.NotFound, "no request %s for %s", req.GetRequestId(), req.GetTenant())
	}
	return &pb.AttributionReply{ModelVersion: found[0], PromptVersion: found[1], Route: found[2]}, nil
}

func serveRegistry(ctx *harness.Ctx) {
	pb.RegisterAttributionServer(ctx.GRPC.Server(""), registryPeer{})
}

func registryCalls(ctx *harness.Ctx) int { return len(ctx.GRPC.CallsTo("GetAttribution", "")) }

func CheckDeadline(ctx *harness.Ctx) {
	serveRegistry(ctx)
	got := attribute(clientBg, "t-acme", "req-1")
	ctx.Equal(got.ModelVersion, "support-llm-2026-09", "with the registry healthy, the attributed model")
	calls := ctx.GRPC.CallsTo("GetAttribution", "")
	ctx.Assert(len(calls) > 0, "no GetAttribution call was made")
	ctx.Assert(calls[0].HasDeadline(), "the lookup carries no deadline: a stalled registry holds every vote open")
	ctx.Assert(150*time.Millisecond <= calls[0].Timeout && calls[0].Timeout <= 250*time.Millisecond, "the lookup carries a %v deadline, expected 200 ms", calls[0].Timeout)
	ctx.GRPC.SetLatency("GetAttribution", 1.0, "")
	slow := attribute(clientBg, "t-acme", "req-2")
	ctx.Assert(slow.ModelVersion != "support-llm-2026-09", "a registry that answers after 1 s was waited for (%+v): past 200 ms the vote goes on unattributed", slow)
}

func CheckUnattributed(ctx *harness.Ctx) {
	serveRegistry(ctx)
	ctx.GRPC.Fail("GetAttribution", codes.Unavailable, "registry restarting", 1, "")
	down := attribute(clientBg, "t-acme", "req-1")
	ctx.Equal(down.ModelVersion, "unattributed", "with the registry unavailable (a failed lookup is unattributed, not the model serving now), the model")
	ctx.Assert(down.PromptVersion == "" && down.Route == "", "an unattributed answer has no prompt version or route, got %+v", down)
	unknown := attribute(clientBg, "t-acme", "req-404")
	ctx.Equal(unknown.ModelVersion, "unattributed", "for a request the registry does not know, the model")
}

func CheckRetryAfterFailure(ctx *harness.Ctx) {
	serveRegistry(ctx)
	ctx.GRPC.Fail("GetAttribution", codes.Unavailable, "registry restarting", 1, "")
	attribute(clientBg, "t-acme", "req-1")
	before := registryCalls(ctx)
	again := attribute(clientBg, "t-acme", "req-1")
	ctx.Equal(registryCalls(ctx), before+1, "after one failed lookup the next request for req-1 must ask the registry again (a failure is not remembered); the calls")
	ctx.Equal(again.ModelVersion, "support-llm-2026-09", "once the registry answers, the attributed model")
	third := attribute(clientBg, "t-acme", "req-1")
	ctx.Assert(registryCalls(ctx) == before+1 && third == again, "a successful lookup is cached: a third request for req-1 must not call the registry")
}

func CheckTenantCache(ctx *harness.Ctx) {
	serveRegistry(ctx)
	acme := attribute(clientBg, "t-acme", "req-1")
	other := attribute(clientBg, "t-other", "req-1")
	ctx.Equal(acme.ModelVersion, "support-llm-2026-09", "t-acme's req-1, the model")
	ctx.Equal(other.ModelVersion, "support-llm-2026-10", "t-other's req-1 got t-acme's attribution: the cache key leaves the tenant out; the model")
	var asked []string
	for _, c := range ctx.GRPC.CallsTo("GetAttribution", "") {
		r := c.Request.(*pb.AttributionRequest)
		asked = append(asked, r.GetTenant()+"/"+r.GetRequestId())
	}
	sort.Strings(asked)
	ctx.Equal(asked, []string{"t-acme/req-1", "t-other/req-1"}, "the requests the registry was asked about")
	attribute(clientBg, "t-acme", "req-1")
	attribute(clientBg, "t-other", "req-1")
	ctx.Equal(registryCalls(ctx), 2, "each tenant's attribution is cached: repeating both lookups must not call the registry again; the calls")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <algorithm>
#include <map>
#include <string>
#include <vector>

namespace {

// "tenant/request" → model, prompt, route; any other request is NOT_FOUND.
const std::map<std::string, std::vector<std::string>> kKnown = {
    {"t-acme/req-1", {"support-llm-2026-09", "triage-v4", "primary"}},
    {"t-acme/req-2", {"support-llm-2026-09", "triage-v4", "primary"}},
    {"t-other/req-1", {"support-llm-2026-10", "triage-v5", "canary"}},
};

class RegistryPeer final : public feedback::Attribution::Service {
 public:
  grpc::Status GetAttribution(grpc::ServerContext*, const feedback::AttributionRequest* req, feedback::AttributionReply* out) override {
    const auto found = kKnown.find(req->tenant() + "/" + req->request_id());
    if (found == kKnown.end()) return grpc::Status(grpc::StatusCode::NOT_FOUND, "no request " + req->request_id() + " for " + req->tenant());
    out->set_model_version(found->second[0]);
    out->set_prompt_version(found->second[1]);
    out->set_route(found->second[2]);
    return grpc::Status::OK;
  }
};

void serveRegistry(harness::Ctx& ctx) {
  static RegistryPeer* peer = nullptr;
  delete peer;
  peer = new RegistryPeer;
  ctx.GRPC.Server("")->RegisterService(peer);
  cache.clear();
}

size_t registryCalls(harness::Ctx& ctx) { return ctx.GRPC.CallsTo("GetAttribution").size(); }

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  serveRegistry(ctx);
  const Attribution got = attribute("t-acme", "req-1");
  ctx.Equal(got.model_version, "support-llm-2026-09", "with the registry healthy, the attributed model");
  const auto calls = ctx.GRPC.CallsTo("GetAttribution");
  ctx.Assert(!calls.empty(), "no GetAttribution call was made");
  ctx.Assert(calls[0].HasDeadline(), "the lookup carries no deadline: a stalled registry holds every vote open");
  ctx.Assert(0.15 <= calls[0].TimeoutSeconds() && calls[0].TimeoutSeconds() <= 0.25, "the lookup carries a %v s deadline, expected 200 ms", calls[0].TimeoutSeconds());
  ctx.GRPC.SetLatency("GetAttribution", 1.0);
  const Attribution slow = attribute("t-acme", "req-2");
  ctx.Assert(slow.model_version != "support-llm-2026-09", "a registry that answers after 1 s was waited for (model %q): past 200 ms the vote goes on unattributed", slow.model_version);
}

void CheckUnattributed(harness::Ctx& ctx) {
  serveRegistry(ctx);
  ctx.GRPC.Fail("GetAttribution", grpc::StatusCode::UNAVAILABLE, "registry restarting", 1);
  const Attribution down = attribute("t-acme", "req-1");
  ctx.Equal(down.model_version, "unattributed", "with the registry unavailable (a failed lookup is unattributed, not the model serving now), the model");
  ctx.Assert(down.prompt_version.empty() && down.route.empty(), "an unattributed answer has no prompt version or route, got %q and %q", down.prompt_version, down.route);
  const Attribution unknown = attribute("t-acme", "req-404");
  ctx.Equal(unknown.model_version, "unattributed", "for a request the registry does not know, the model");
}

void CheckRetryAfterFailure(harness::Ctx& ctx) {
  serveRegistry(ctx);
  ctx.GRPC.Fail("GetAttribution", grpc::StatusCode::UNAVAILABLE, "registry restarting", 1);
  attribute("t-acme", "req-1");
  const size_t before = registryCalls(ctx);
  const Attribution again = attribute("t-acme", "req-1");
  ctx.Equal(registryCalls(ctx), before + 1, "after one failed lookup the next request for req-1 must ask the registry again (a failure is not remembered); the calls");
  ctx.Equal(again.model_version, "support-llm-2026-09", "once the registry answers, the attributed model");
  const Attribution third = attribute("t-acme", "req-1");
  ctx.Assert(registryCalls(ctx) == before + 1 && third.model_version == again.model_version, "a successful lookup is cached: a third request for req-1 must not call the registry");
}

void CheckTenantCache(harness::Ctx& ctx) {
  serveRegistry(ctx);
  const Attribution acme = attribute("t-acme", "req-1");
  const Attribution other = attribute("t-other", "req-1");
  ctx.Equal(acme.model_version, "support-llm-2026-09", "t-acme's req-1, the model");
  ctx.Equal(other.model_version, "support-llm-2026-10", "t-other's req-1 got t-acme's attribution: the cache key leaves the tenant out; the model");
  std::vector<std::string> asked;
  for (const auto& c : ctx.GRPC.CallsTo("GetAttribution")) {
    const auto& r = c.Request<feedback::AttributionRequest>();
    asked.push_back(r.tenant() + "/" + r.request_id());
  }
  std::sort(asked.begin(), asked.end());
  ctx.Equal(asked, {"t-acme/req-1", "t-other/req-1"}, "the requests the registry was asked about");
  attribute("t-acme", "req-1");
  attribute("t-other", "req-1");
  ctx.Equal(registryCalls(ctx), 2, "each tenant's attribution is cached: repeating both lookups must not call the registry again; the calls");
}
`,
  },
  hints: [
    'Roll out a new model, take the registry down for a moment, and rate an answer of the old one: the vote counts for the new model, and keeps doing so for that request all day after the registry is back.',
    'The `except` branch answers `ACTIVE_MODEL` and writes `_failures`, which the next call reads before asking; the deadline is two seconds; and `_cache` is keyed by the request id alone.',
    'Set `DEADLINE_S = 0.2`, return `UNATTRIBUTED` from the `except` without writing anything, delete `_failures`, and key `_cache` by `(tenant, request_id)`.',
  ],
  debrief: `\`unattributed\` is the honest answer to "which model served this?" when the registry cannot say, and it keeps the error visible: a dashboard can report how much feedback is unattributed, while a rating credited to the active model silently moves quality from one version to another. Only successes are cached because a success is a fact about a past request that cannot change, while a failure is a fact about the registry right now. The deadline is short because the lookup sits on the vote's path. Production collectors carry the model version in the served-request record so most votes need no lookup, and backfill unattributed rows from the registry later.`,
};
