import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Suggester call: a 150 ms deadline, one attempt, a fallback nobody caches',
  concept: 'grpc',
  guides: ['deadlines-and-retries', 'failing-dependencies'],
  file: 'client',
  focus: ['api', 'suggester', 'redis'],
  task: `## Task

**Starting point.** The starter is \`suggest(tenant, prefix)\`, what the endpoint asks for completions:
it reads the cache (\`get_suggestions\`, step 2, provided as \`suggest.cache\`), else calls
\`Suggester.Suggest\` over gRPC with a 2 s timeout up to three times, caches what it got
(\`put_suggestions\`), and answers \`{"suggestions", "source"}\`. With a healthy suggester it works,
and it hides four flaws.

**Failure mode the checks target.** During a suggester deploy the dropdown waits seconds per keystroke,
every miss sends the struggling suggester three calls, the box comes back empty, and that empty list
is cached for five minutes after the suggester recovered.

\`\`\`proto
service Suggester { rpc Suggest(SuggestRequest) returns (SuggestReply); }  // tenant, prefix, limit → terms
\`\`\`

- Call once, with a \`DEADLINE_S\` = 150 ms deadline; never retry inside the request.
- On any failure answer the curated \`FALLBACK_SUGGESTIONS\` that start with the prefix, with
  \`"source": "fallback"\` and \`"fallback_version": FALLBACK_VERSION\`.
- Cache only what the suggester answered: a fallback is returned before the cache write.`,
  sequence: {
    participants: ['suggestd', 'Redis', 'Suggester'],
    messages: [
      {from: 'suggestd', to: 'Redis', label: 'get_suggestions(tenant, prefix) → miss', kind: 'sync'},
      {from: 'suggestd', to: 'Suggester', label: 'Suggest · deadline 150 ms · one attempt', kind: 'sync'},
      {from: 'Suggester', to: 'suggestd', label: 'terms → put_suggestions · source "suggester"', kind: 'reply'},
      {from: 'Suggester', to: 'suggestd', label: 'DEADLINE_EXCEEDED / UNAVAILABLE', kind: 'reply'},
      {from: 'suggestd', to: 'suggestd', label: 'fallback list · source "fallback" · not cached', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Calls the suggester with a 150 ms deadline',
      detail:
        'Every `Suggest` call carries `DEADLINE_S` (150 ms), so a suggester that takes 400 ms costs the keystroke 150 ms; the starter waits up to two seconds.',
      match: {
        python: {
          all: [/DEADLINE_S\s*=\s*0?\.15\b/, /Suggest\([\s\S]{0,200}?timeout\s*=\s*DEADLINE_S/],
          none: [/timeout\s*=\s*2/],
        },
        typescript: {all: [/DEADLINE_MS\s*=\s*150\b/, /deadline:[^\n]*DEADLINE_MS/], none: [/TIMEOUT_MS/]},
        go: {
          all: [/deadline\s*=\s*150\s*\*\s*time\.Millisecond/, /context\.WithTimeout\([^\n]*deadline\)/],
          none: [/2\s*\*\s*time\.Second/],
        },
        cpp: {all: [/kDeadline\{150\}/, /set_deadline\([^\n]*kDeadline\)/], none: [/seconds\{2\}/]},
      },
    },
    {
      id: 'no-inline-retry',
      title: 'Makes one attempt per request',
      detail:
        'A failed call is answered from the fallback, not retried in the request, whatever its status code (`UNAVAILABLE`, `DEADLINE_EXCEEDED`, `INTERNAL` …): three attempts per miss triple the load on a suggester that is already failing.',
      match: {
        python: {all: [/except grpc\.RpcError/], none: [/ATTEMPTS|for \w+ in range\(/, /while True/, /time\.sleep\(/]},
        typescript: {all: [/catch/], none: [/ATTEMPTS|for \(let attempt/, /while \(true\)/]},
        go: {all: [/suggester\.Suggest\(/], none: [/attempts|for attempt/]},
        cpp: {all: [/suggester->Suggest\(/], none: [/kAttempts|for \(int attempt/]},
      },
    },
    {
      id: 'fallback',
      title: 'Answers a marked, versioned fallback on failure',
      detail:
        'On a deadline or an error the answer is the curated `FALLBACK_SUGGESTIONS` that start with the prefix, with `source` `"fallback"` and the `FALLBACK_VERSION` of the list, so the client and the metrics can tell a degraded answer and a bad list can be rolled back.',
      match: {
        python: {
          all: [/FALLBACK_SUGGESTIONS\s*=/, /FALLBACK_VERSION\s*=/, /["']fallback["']/, /["']fallback_version["']/],
        },
        typescript: {all: [/FALLBACK_SUGGESTIONS\s*=/, /FALLBACK_VERSION\s*=/, /['"]fallback['"]/, /fallback_version/]},
        go: {all: [/fallbackSuggestions\s*=/, /fallbackVersion\s*=/, /"fallback"/, /fallback_version/]},
        cpp: {all: [/kFallbackSuggestions\s*=/, /kFallbackVersion\s*=/, /"fallback"/]},
      },
    },
    {
      id: 'degraded-not-cached',
      title: 'Caches only what the suggester answered',
      detail:
        'The failure branch returns the fallback before the cache write, so the next keystroke asks the recovered suggester; the starter caches the empty list it got and serves it for the whole TTL.',
      match: {
        python: {all: [/except grpc\.RpcError[^\n]*:\s*\n(?:\s*#[^\n]*\n)*\s*return\b/]},
        typescript: {all: [/catch\s*(?:\([^)]*\))?\s*\{\s*(?:\/\/[^\n]*\s*)*return\b/]},
        go: {order: [/if err != nil \{/, /Source:\s*"fallback"/, /cache\.PutSuggestions\(/]},
        cpp: {order: [/!suggester->Suggest\([^\n]*\.ok\(\)\)/, /"fallback"/, /cache::putSuggestions\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import autocomplete_service_pb2 as pb
import autocomplete_service_pb2_grpc as pb_grpc
from suggest.cache import get_suggestions, put_suggestions

TIMEOUT_S = 2.0
ATTEMPTS = 3

suggester = pb_grpc.SuggesterStub(grpc.insecure_channel("suggester:9000"))


def suggest(tenant: str, prefix: str) -> dict:
    """Completions of the tenant's folded prefix: {"suggestions", "source"}."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    cached = get_suggestions(tenant, prefix)
    if cached is not None:
        return {"suggestions": cached, "source": "cache"}
    suggestions = []
    for _ in range(ATTEMPTS):
        try:
            reply = suggester.Suggest(pb.SuggestRequest(tenant=tenant, prefix=prefix, limit=10), timeout=TIMEOUT_S)
            suggestions = list(reply.terms)
            break
        except grpc.RpcError:
            continue
    put_suggestions(tenant, prefix, suggestions)
    return {"suggestions": suggestions, "source": "suggester"}
`,
      solution: `import grpc

import autocomplete_service_pb2 as pb
import autocomplete_service_pb2_grpc as pb_grpc
from suggest.cache import get_suggestions, put_suggestions

DEADLINE_S = 0.15
FALLBACK_VERSION = "curated-2026-11-01"
FALLBACK_SUGGESTIONS = ("integrations", "inventory", "invoices", "kettle", "keyboard")

suggester = pb_grpc.SuggesterStub(grpc.insecure_channel("suggester:9000"))


def suggest(tenant: str, prefix: str) -> dict:
    """Completions of the tenant's folded prefix: {"suggestions", "source"}."""
    cached = get_suggestions(tenant, prefix)
    if cached is not None:
        return {"suggestions": cached, "source": "cache"}
    try:
        # One attempt under the deadline: a retry here multiplies the load on a suggester that is already slow.
        reply = suggester.Suggest(pb.SuggestRequest(tenant=tenant, prefix=prefix, limit=10), timeout=DEADLINE_S)
    except grpc.RpcError:
        # Degraded, and not cached: the next keystroke asks the suggester again.
        return {
            "suggestions": [term for term in FALLBACK_SUGGESTIONS if term.startswith(prefix)],
            "source": "fallback",
            "fallback_version": FALLBACK_VERSION,
        }
    suggestions = list(reply.terms)
    put_suggestions(tenant, prefix, suggestions)
    return {"suggestions": suggestions, "source": "suggester"}
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {getSuggestions, putSuggestions} from 'suggest/cache';

export const TIMEOUT_MS = 2000;
export const ATTEMPTS = 3;

export interface Answer {
  suggestions: string[];
  source: string;
  fallback_version?: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('autocomplete_service.proto')) as unknown as {
  suggestd: {Suggester: grpc.ServiceClientConstructor};
};
const suggester = new pkg.suggestd.Suggester('suggester:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Suggest(request: {tenant: string; prefix: string; limit: number}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{terms?: string[]}>;
};

/** Completions of the tenant's folded prefix. */
export async function suggest(tenant: string, prefix: string): Promise<Answer> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const cached = await getSuggestions(tenant, prefix);
  if (cached !== null) return {suggestions: cached, source: 'cache'};
  let suggestions: string[] = [];
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      const reply = await suggester.Suggest({tenant, prefix, limit: 10}, new grpc.Metadata(), {deadline: Date.now() + TIMEOUT_MS});
      suggestions = reply.terms ?? [];
      break;
    } catch {
      continue;
    }
  }
  await putSuggestions(tenant, prefix, suggestions);
  return {suggestions, source: 'suggester'};
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {getSuggestions, putSuggestions} from 'suggest/cache';

export const DEADLINE_MS = 150;
export const FALLBACK_VERSION = 'curated-2026-11-01';
export const FALLBACK_SUGGESTIONS = ['integrations', 'inventory', 'invoices', 'kettle', 'keyboard'];

export interface Answer {
  suggestions: string[];
  source: string;
  fallback_version?: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('autocomplete_service.proto')) as unknown as {
  suggestd: {Suggester: grpc.ServiceClientConstructor};
};
const suggester = new pkg.suggestd.Suggester('suggester:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Suggest(request: {tenant: string; prefix: string; limit: number}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{terms?: string[]}>;
};

/** Completions of the tenant's folded prefix. */
export async function suggest(tenant: string, prefix: string): Promise<Answer> {
  const cached = await getSuggestions(tenant, prefix);
  if (cached !== null) return {suggestions: cached, source: 'cache'};
  let reply: {terms?: string[]};
  try {
    // One attempt under the deadline: a retry here multiplies the load on a suggester that is already slow.
    reply = await suggester.Suggest({tenant, prefix, limit: 10}, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
  } catch {
    // Degraded, and not cached: the next keystroke asks the suggester again.
    return {
      suggestions: FALLBACK_SUGGESTIONS.filter(term => term.startsWith(prefix)),
      source: 'fallback',
      fallback_version: FALLBACK_VERSION,
    };
  }
  const suggestions = reply.terms ?? [];
  await putSuggestions(tenant, prefix, suggestions);
  return {suggestions, source: 'suggester'};
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

	"suggest/cache" // cache.GetSuggestions, cache.PutSuggestions
	pb "suggest/gen/autocomplete_service"
)

const (
	timeout  = 2 * time.Second
	attempts = 3
)

var (
	suggesterConn, _ = grpc.NewClient("suggester:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	suggester        = pb.NewSuggesterClient(suggesterConn)
)

// answer is the completions of a prefix and where they came from.
type answer struct {
	Suggestions     []string \`json:"suggestions"\`
	Source          string   \`json:"source"\`
	FallbackVersion string   \`json:"fallback_version,omitempty"\`
}

// suggest is the completions of the tenant's folded prefix.
func suggest(ctx context.Context, tenant, prefix string) answer {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	if cached, hit := cache.GetSuggestions(ctx, tenant, prefix); hit {
		return answer{Suggestions: cached, Source: "cache"}
	}
	suggestions := []string{}
	for attempt := 0; attempt < attempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, timeout)
		reply, err := suggester.Suggest(callCtx, &pb.SuggestRequest{Tenant: tenant, Prefix: prefix, Limit: 10})
		cancel()
		if err == nil {
			suggestions = append([]string{}, reply.GetTerms()...)
			break
		}
	}
	cache.PutSuggestions(ctx, tenant, prefix, suggestions)
	return answer{Suggestions: suggestions, Source: "suggester"}
}
`,
      solution: `package main

import (
	"context"
	"strings"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"suggest/cache" // cache.GetSuggestions, cache.PutSuggestions
	pb "suggest/gen/autocomplete_service"
)

const (
	deadline        = 150 * time.Millisecond
	fallbackVersion = "curated-2026-11-01"
)

var fallbackSuggestions = []string{"integrations", "inventory", "invoices", "kettle", "keyboard"}

var (
	suggesterConn, _ = grpc.NewClient("suggester:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	suggester        = pb.NewSuggesterClient(suggesterConn)
)

// answer is the completions of a prefix and where they came from.
type answer struct {
	Suggestions     []string \`json:"suggestions"\`
	Source          string   \`json:"source"\`
	FallbackVersion string   \`json:"fallback_version,omitempty"\`
}

// suggest is the completions of the tenant's folded prefix.
func suggest(ctx context.Context, tenant, prefix string) answer {
	if cached, hit := cache.GetSuggestions(ctx, tenant, prefix); hit {
		return answer{Suggestions: cached, Source: "cache"}
	}
	// One attempt under the deadline: a retry here multiplies the load on a suggester that is already slow.
	callCtx, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()
	reply, err := suggester.Suggest(callCtx, &pb.SuggestRequest{Tenant: tenant, Prefix: prefix, Limit: 10})
	if err != nil {
		// Degraded, and not cached: the next keystroke asks the suggester again.
		matching := []string{}
		for _, term := range fallbackSuggestions {
			if strings.HasPrefix(term, prefix) {
				matching = append(matching, term)
			}
		}
		return answer{Suggestions: matching, Source: "fallback", FallbackVersion: fallbackVersion}
	}
	suggestions := append([]string{}, reply.GetTerms()...)
	cache.PutSuggestions(ctx, tenant, prefix, suggestions)
	return answer{Suggestions: suggestions, Source: "suggester"}
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <string>
#include <vector>

#include "autocomplete_service.grpc.pb.h"
#include "suggest/cache.h"  // cache::getSuggestions, cache::putSuggestions

constexpr std::chrono::seconds kTimeout{2};
constexpr int kAttempts = 3;

auto suggester = suggestd::Suggester::NewStub(grpc::CreateChannel("suggester:9000", grpc::InsecureChannelCredentials()));

// The completions of a prefix and where they came from.
struct Answer {
  std::vector<std::string> suggestions;
  std::string source;
  std::string fallback_version;
};

// Completions of the tenant's folded prefix.
Answer suggest(const std::string& tenant, const std::string& prefix) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  if (const auto cached = cache::getSuggestions(tenant, prefix)) return {*cached, "cache", ""};
  suggestd::SuggestRequest request;
  request.set_tenant(tenant);
  request.set_prefix(prefix);
  request.set_limit(10);
  std::vector<std::string> suggestions;
  for (int attempt = 0; attempt < kAttempts; ++attempt) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kTimeout);
    suggestd::SuggestReply reply;
    if (suggester->Suggest(&ctx, request, &reply).ok()) {
      suggestions.assign(reply.terms().begin(), reply.terms().end());
      break;
    }
  }
  cache::putSuggestions(tenant, prefix, suggestions);
  return {suggestions, "suggester", ""};
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <string>
#include <vector>

#include "autocomplete_service.grpc.pb.h"
#include "suggest/cache.h"  // cache::getSuggestions, cache::putSuggestions

constexpr std::chrono::milliseconds kDeadline{150};
const std::string kFallbackVersion = "curated-2026-11-01";
const std::vector<std::string> kFallbackSuggestions = {"integrations", "inventory", "invoices", "kettle", "keyboard"};

auto suggester = suggestd::Suggester::NewStub(grpc::CreateChannel("suggester:9000", grpc::InsecureChannelCredentials()));

// The completions of a prefix and where they came from.
struct Answer {
  std::vector<std::string> suggestions;
  std::string source;
  std::string fallback_version;
};

// Completions of the tenant's folded prefix.
Answer suggest(const std::string& tenant, const std::string& prefix) {
  if (const auto cached = cache::getSuggestions(tenant, prefix)) return {*cached, "cache", ""};
  suggestd::SuggestRequest request;
  request.set_tenant(tenant);
  request.set_prefix(prefix);
  request.set_limit(10);
  // One attempt under the deadline: a retry here multiplies the load on a suggester that is already slow.
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
  suggestd::SuggestReply reply;
  if (!suggester->Suggest(&ctx, request, &reply).ok()) {
    // Degraded, and not cached: the next keystroke asks the suggester again.
    Answer degraded{{}, "fallback", kFallbackVersion};
    for (const std::string& term : kFallbackSuggestions) {
      if (term.rfind(prefix, 0) == 0) degraded.suggestions.push_back(term);
    }
    return degraded;
  }
  const std::vector<std::string> suggestions(reply.terms().begin(), reply.terms().end());
  cache::putSuggestions(tenant, prefix, suggestions);
  return {suggestions, "suggester", ""};
}
`,
    },
  },
  harness: {
    python: `import grpc

import autocomplete_service_pb2 as pb
import autocomplete_service_pb2_grpc as pb_grpc

TERMS = {"ke": ["kettle", "kettlebell", "keyboard"], "in": ["inbox", "invoice templates"]}


class Suggester(pb_grpc.SuggesterServicer):
    """The ranking suggester: a fixed answer per prefix."""

    def Suggest(self, request, context):
        return pb.SuggestReply(terms=TERMS.get(request.prefix, [])[: request.limit or 10], model_version="rank-7")


def _client(ctx):
    ctx.grpc.serve(pb_grpc.add_SuggesterServicer_to_server, Suggester())
    return ctx.load("client")


def check_deadline(ctx):
    m = _client(ctx)
    got = m.suggest("acme", "ke")
    assert got.get("source") == "suggester" and got.get("suggestions") == TERMS["ke"], f"with a healthy suggester suggest answered {got}"
    calls = ctx.grpc.calls_to("Suggest")
    assert calls, "no Suggest call was made"
    for call in calls:
        assert call.timeout is not None, "the Suggest call carries no deadline: a stalled suggester holds every keystroke"
        assert 0.1 <= call.timeout <= 0.16, f"the Suggest call carries a {call.timeout} s deadline, expected DEADLINE_S = 0.15"
    ctx.grpc.set_latency("Suggest", 0.4)
    before = ctx.clock.time()
    m.suggest("acme", "in")
    waited = ctx.clock.time() - before
    assert waited <= 0.2, f"suggest waited {waited:.2f} s for a suggester that takes 0.4 s: the dropdown has 150 ms"


def check_no_inline_retry(ctx):
    m = _client(ctx)
    ctx.grpc.fail("Suggest", grpc.StatusCode.UNAVAILABLE, "deploy in progress", times=3)
    m.suggest("acme", "ke")
    calls = len(ctx.grpc.calls_to("Suggest"))
    assert calls == 1, f"one keystroke against a failing suggester made {calls} Suggest calls: retrying in the request multiplies the load during an outage"
    assert ctx.clock.sleeps == 0, "a failure must not be slept on in the request"
    # Whatever the error, one call: no status code earns a second attempt inside the request.
    for code, prefix in ((grpc.StatusCode.DEADLINE_EXCEEDED, "kett"), (grpc.StatusCode.INTERNAL, "in"), (grpc.StatusCode.UNKNOWN, "inv"), (grpc.StatusCode.RESOURCE_EXHAUSTED, "key")):
        ctx.grpc.failures.clear()
        ctx.grpc.fail("Suggest", code, "suggester error", times=2)
        before = len(ctx.grpc.calls_to("Suggest"))
        got = m.suggest("acme", prefix)
        calls = len(ctx.grpc.calls_to("Suggest")) - before
        assert calls == 1, f"a keystroke whose Suggest call failed {code.name} made {calls} Suggest calls, expected 1: no error is retried inside the request"
        assert got.get("source") == "fallback", f"a keystroke whose Suggest call failed {code.name} answered {got}, expected the fallback"


def check_fallback(ctx):
    m = _client(ctx)
    ctx.grpc.set_latency("Suggest", 1.0)
    got = m.suggest("acme", "in")
    assert got.get("source") == "fallback", f"with the suggester taking 1 s suggest answered {got}: past the deadline the answer is the fallback, marked source 'fallback'"
    assert got.get("suggestions") == ["integrations", "inventory", "invoices"], f"the fallback for 'in' is {got.get('suggestions')}, expected the curated terms that start with the prefix"
    version = getattr(m, "FALLBACK_VERSION", None)
    assert version and got.get("fallback_version") == version, f"the fallback answer carries fallback_version {got.get('fallback_version')!r}, expected FALLBACK_VERSION ({version!r})"
    ctx.grpc.set_latency("Suggest", 0.0)
    ctx.grpc.fail("Suggest", grpc.StatusCode.UNAVAILABLE, "deploy in progress")
    got = m.suggest("acme", "ke")
    assert got.get("source") == "fallback" and got.get("suggestions") == ["kettle", "keyboard"], f"with the suggester UNAVAILABLE suggest answered {got}, expected the fallback kettle, keyboard"
    ctx.grpc.fail("Suggest", grpc.StatusCode.UNAVAILABLE, "deploy in progress")
    got = m.suggest("acme", "ve")
    assert got.get("source") == "fallback" and got.get("suggestions") == [], f"the fallback for 've' answered {got}, expected no suggestions: a curated term qualifies when it starts with the prefix (inventory only contains it)"


def check_degraded_not_cached(ctx):
    m = _client(ctx)
    ctx.grpc.fail("Suggest", grpc.StatusCode.UNAVAILABLE, "deploy in progress", times=3)
    first = m.suggest("acme", "ke")
    cached = sorted(ctx.redis.keys("suggest:cache:*"))
    assert cached == [], f"a failed call left {cached} in the cache ({first}): a degraded answer must not be cached"
    ctx.grpc.failures.clear()  # the deploy is over
    second = m.suggest("acme", "ke")
    assert second.get("source") == "suggester" and second.get("suggestions") == TERMS["ke"], f"once the suggester recovered the next keystroke answered {second}, expected the suggester's terms"
    third = m.suggest("acme", "ke")
    assert third.get("source") == "cache" and third.get("suggestions") == TERMS["ke"], f"the suggester's answer must be cached, the third keystroke answered {third}"
`,
    typescript: `const TERMS: Record<string, string[]> = {ke: ['kettle', 'kettlebell', 'keyboard'], in: ['inbox', 'invoice templates']};

/** The ranking suggester: a fixed answer per prefix. */
function client(ctx) {
  const pkg = ctx.proto('autocomplete_service.proto');
  ctx.grpc.serve(pkg.suggestd.Suggester.service, {
    Suggest(call, callback) {
      callback(null, {terms: (TERMS[call.request.prefix] ?? []).slice(0, call.request.limit || 10), model_version: 'rank-7'});
    },
  });
  return ctx.load('client');
}

export async function check_deadline(ctx) {
  const m = client(ctx);
  const got = await m.suggest('acme', 'ke');
  assert(got.source === 'suggester' && JSON.stringify(got.suggestions) === JSON.stringify(TERMS.ke), \`with a healthy suggester suggest answered \${JSON.stringify(got)}\`);
  const calls = ctx.grpc.callsTo('Suggest');
  assert(calls.length > 0, 'no Suggest call was made');
  for (const call of calls) {
    assert(call.timeout !== null, 'the Suggest call carries no deadline: a stalled suggester holds every keystroke');
    assert(0.1 <= call.timeout && call.timeout <= 0.16, \`the Suggest call carries a \${call.timeout} s deadline, expected DEADLINE_MS = 150\`);
  }
  ctx.grpc.setLatency('Suggest', 0.4);
  const before = ctx.clock.now();
  await m.suggest('acme', 'in');
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 0.2, \`suggest waited \${waited.toFixed(2)} s for a suggester that takes 0.4 s: the dropdown has 150 ms\`);
}

export async function check_no_inline_retry(ctx) {
  const m = client(ctx);
  ctx.grpc.fail('Suggest', ctx.grpc.status.UNAVAILABLE, 'deploy in progress', 3);
  await m.suggest('acme', 'ke');
  const calls = ctx.grpc.callsTo('Suggest').length;
  assert.equal(calls, 1, \`one keystroke against a failing suggester made \${calls} Suggest calls: retrying in the request multiplies the load during an outage\`);
  assert.equal(ctx.clock.sleeps, 0, 'a failure must not be slept on in the request');
  // Whatever the error, one call: no status code earns a second attempt inside the request.
  for (const [code, prefix] of [['DEADLINE_EXCEEDED', 'kett'], ['INTERNAL', 'in'], ['UNKNOWN', 'inv'], ['RESOURCE_EXHAUSTED', 'key']]) {
    ctx.grpc.clearFailures();
    ctx.grpc.fail('Suggest', ctx.grpc.status[code], 'suggester error', 2);
    const before = ctx.grpc.callsTo('Suggest').length;
    const got = await m.suggest('acme', prefix);
    const made = ctx.grpc.callsTo('Suggest').length - before;
    assert.equal(made, 1, \`a keystroke whose Suggest call failed \${code} made \${made} Suggest calls, expected 1: no error is retried inside the request\`);
    assert.equal(got.source, 'fallback', \`a keystroke whose Suggest call failed \${code} answered \${JSON.stringify(got)}, expected the fallback\`);
  }
}

export async function check_fallback(ctx) {
  const m = client(ctx);
  ctx.grpc.setLatency('Suggest', 1.0);
  let got = await m.suggest('acme', 'in');
  assert.equal(got.source, 'fallback', \`with the suggester taking 1 s suggest answered \${JSON.stringify(got)}: past the deadline the answer is the fallback, marked source "fallback"\`);
  assert.deepStrictEqual(got.suggestions, ['integrations', 'inventory', 'invoices'], \`the fallback for "in" is \${JSON.stringify(got.suggestions)}, expected the curated terms that start with the prefix\`);
  assert(m.FALLBACK_VERSION && got.fallback_version === m.FALLBACK_VERSION, \`the fallback answer carries fallback_version \${JSON.stringify(got.fallback_version)}, expected FALLBACK_VERSION (\${JSON.stringify(m.FALLBACK_VERSION)})\`);
  ctx.grpc.setLatency('Suggest', 0);
  ctx.grpc.fail('Suggest', ctx.grpc.status.UNAVAILABLE, 'deploy in progress');
  got = await m.suggest('acme', 'ke');
  assert(got.source === 'fallback' && JSON.stringify(got.suggestions) === JSON.stringify(['kettle', 'keyboard']), \`with the suggester UNAVAILABLE suggest answered \${JSON.stringify(got)}, expected the fallback kettle, keyboard\`);
  ctx.grpc.fail('Suggest', ctx.grpc.status.UNAVAILABLE, 'deploy in progress');
  got = await m.suggest('acme', 've');
  assert(got.source === 'fallback' && JSON.stringify(got.suggestions) === '[]', \`the fallback for "ve" answered \${JSON.stringify(got)}, expected no suggestions: a curated term qualifies when it starts with the prefix (inventory only contains it)\`);
}

export async function check_degraded_not_cached(ctx) {
  const m = client(ctx);
  ctx.grpc.fail('Suggest', ctx.grpc.status.UNAVAILABLE, 'deploy in progress', 3);
  const first = await m.suggest('acme', 'ke');
  const cached = ctx.redis.keys('suggest:cache:*');
  assert.deepStrictEqual(cached, [], \`a failed call left \${JSON.stringify(cached)} in the cache (\${JSON.stringify(first)}): a degraded answer must not be cached\`);
  ctx.grpc.clearFailures(); // the deploy is over
  const second = await m.suggest('acme', 'ke');
  assert(second.source === 'suggester' && JSON.stringify(second.suggestions) === JSON.stringify(TERMS.ke), \`once the suggester recovered the next keystroke answered \${JSON.stringify(second)}, expected the suggester's terms\`);
  const third = await m.suggest('acme', 'ke');
  assert(third.source === 'cache' && JSON.stringify(third.suggestions) === JSON.stringify(TERMS.ke), \`the suggester's answer must be cached, the third keystroke answered \${JSON.stringify(third)}\`);
}
`,
    go: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc/codes"

	pb "suggest/gen/autocomplete_service"

	"leetbuild/harness"
)

var (
	hClientBg    = context.Background()
	hClientTerms = map[string][]string{"ke": {"kettle", "kettlebell", "keyboard"}, "in": {"inbox", "invoice templates"}}
)

// suggesterPeer is the ranking suggester: a fixed answer per prefix.
type HSuggesterPeer struct {
	pb.UnimplementedSuggesterServer
}

func (HSuggesterPeer) Suggest(_ context.Context, req *pb.SuggestRequest) (*pb.SuggestReply, error) {
	return &pb.SuggestReply{Terms: hClientTerms[req.GetPrefix()], ModelVersion: "rank-7"}, nil
}

func hClientPeer(ctx *harness.Ctx) {
	pb.RegisterSuggesterServer(ctx.GRPC.Server(""), HSuggesterPeer{})
}

func CheckDeadline(ctx *harness.Ctx) {
	hClientPeer(ctx)
	got := suggest(hClientBg, "acme", "ke")
	ctx.Assert(got.Source == "suggester", "with a healthy suggester suggest answered %+v", got)
	ctx.Equal(got.Suggestions, hClientTerms["ke"], "the suggester's terms")
	calls := ctx.GRPC.CallsTo("Suggest", "")
	ctx.Assert(len(calls) > 0, "no Suggest call was made")
	for _, call := range calls {
		ctx.Assert(call.HasDeadline(), "the Suggest call carries no deadline: a stalled suggester holds every keystroke")
		ctx.Assert(100*time.Millisecond <= call.Timeout && call.Timeout <= 160*time.Millisecond, "the Suggest call carries a %v deadline, expected 150 ms", call.Timeout)
	}
	ctx.GRPC.SetLatency("Suggest", 0.4, "")
	before := ctx.Clock.Now()
	suggest(hClientBg, "acme", "in")
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 0.2, "suggest waited %.2f s for a suggester that takes 0.4 s: the dropdown has 150 ms", waited)
}

func CheckNoInlineRetry(ctx *harness.Ctx) {
	hClientPeer(ctx)
	ctx.GRPC.Fail("Suggest", codes.Unavailable, "deploy in progress", 3, "")
	suggest(hClientBg, "acme", "ke")
	ctx.Equal(len(ctx.GRPC.CallsTo("Suggest", "")), 1, "one keystroke against a failing suggester: retrying in the request multiplies the load during an outage; the Suggest calls")
	ctx.Equal(ctx.Clock.Sleeps(), 0, "a failure must not be slept on in the request; the sleeps")
	// Whatever the error, one call: no status code earns a second attempt inside the request.
	for _, tc := range []struct {
		code   codes.Code
		prefix string
	}{{codes.DeadlineExceeded, "kett"}, {codes.Internal, "in"}, {codes.Unknown, "inv"}, {codes.ResourceExhausted, "key"}} {
		ctx.GRPC.ClearFailures()
		ctx.GRPC.Fail("Suggest", tc.code, "suggester error", 2, "")
		before := len(ctx.GRPC.CallsTo("Suggest", ""))
		got := suggest(hClientBg, "acme", tc.prefix)
		ctx.Equal(len(ctx.GRPC.CallsTo("Suggest", ""))-before, 1, "a keystroke whose Suggest call failed %v: no error is retried inside the request; the Suggest calls", tc.code)
		ctx.Equal(got.Source, "fallback", "a keystroke whose Suggest call failed %v must answer the fallback; the source", tc.code)
	}
}

func CheckFallback(ctx *harness.Ctx) {
	hClientPeer(ctx)
	ctx.GRPC.SetLatency("Suggest", 1.0, "")
	got := suggest(hClientBg, "acme", "in")
	ctx.Equal(got.Source, "fallback", "with the suggester taking 1 s the answer must be the fallback, marked; the source")
	ctx.Equal(got.Suggestions, []string{"integrations", "inventory", "invoices"}, "the fallback for \\"in\\" (the curated terms that start with the prefix)")
	ctx.Assert(got.FallbackVersion != "", "the fallback answer carries no fallback_version: a bad list cannot be traced or rolled back")
	ctx.GRPC.SetLatency("Suggest", 0, "")
	ctx.GRPC.Fail("Suggest", codes.Unavailable, "deploy in progress", 1, "")
	got = suggest(hClientBg, "acme", "ke")
	ctx.Assert(got.Source == "fallback", "with the suggester UNAVAILABLE suggest answered %+v, expected the fallback", got)
	ctx.Equal(got.Suggestions, []string{"kettle", "keyboard"}, "the fallback for \\"ke\\"")
	ctx.GRPC.Fail("Suggest", codes.Unavailable, "deploy in progress", 1, "")
	got = suggest(hClientBg, "acme", "ve")
	ctx.Assert(got.Source == "fallback" && len(got.Suggestions) == 0, "the fallback for \\"ve\\" answered %+v, expected no suggestions: a curated term qualifies when it starts with the prefix (inventory only contains it)", got)
}

func CheckDegradedNotCached(ctx *harness.Ctx) {
	hClientPeer(ctx)
	ctx.GRPC.Fail("Suggest", codes.Unavailable, "deploy in progress", 3, "")
	first := suggest(hClientBg, "acme", "ke")
	cached := ctx.Redis.Keys("suggest:cache:*")
	ctx.Assert(len(cached) == 0, "a failed call left %q in the cache (%+v): a degraded answer must not be cached", cached, first)
	ctx.GRPC.ClearFailures()
	second := suggest(hClientBg, "acme", "ke")
	ctx.Assert(second.Source == "suggester", "once the suggester recovered the next keystroke answered %+v, expected the suggester's terms", second)
	ctx.Equal(second.Suggestions, hClientTerms["ke"], "the suggester's terms once it recovered")
	third := suggest(hClientBg, "acme", "ke")
	ctx.Assert(third.Source == "cache", "the suggester's answer must be cached, the third keystroke answered %+v", third)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <map>
#include <string>
#include <vector>

#include "autocomplete_service.grpc.pb.h"

namespace {

using HStrings = std::vector<std::string>;

const std::map<std::string, HStrings> hTerms = {{"ke", {"kettle", "kettlebell", "keyboard"}}, {"in", {"inbox", "invoice templates"}}};

// The ranking suggester: a fixed answer per prefix.
class HSuggesterPeer final : public suggestd::Suggester::Service {
 public:
  grpc::Status Suggest(grpc::ServerContext*, const suggestd::SuggestRequest* req, suggestd::SuggestReply* out) override {
    const auto found = hTerms.find(req->prefix());
    if (found != hTerms.end()) {
      for (const std::string& term : found->second) out->add_terms(term);
    }
    out->set_model_version("rank-7");
    return grpc::Status::OK;
  }
};

void hClientPeer(harness::Ctx& ctx) {
  static HSuggesterPeer* peer = nullptr;
  delete peer;
  peer = new HSuggesterPeer;
  ctx.GRPC.Server("")->RegisterService(peer);
}

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  hClientPeer(ctx);
  const Answer got = suggest("acme", "ke");
  ctx.Equal(got.source, "suggester", "with a healthy suggester, the source");
  ctx.Equal(got.suggestions, hTerms.at("ke"), "the suggester's terms");
  const auto calls = ctx.GRPC.CallsTo("Suggest");
  ctx.Assert(!calls.empty(), "no Suggest call was made");
  for (const auto& call : calls) {
    ctx.Assert(call.HasDeadline(), "the Suggest call carries no deadline: a stalled suggester holds every keystroke");
    ctx.Assert(0.1 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 0.16, "the Suggest call carries a %v s deadline, expected kDeadline = 150 ms", call.TimeoutSeconds());
  }
  ctx.GRPC.SetLatency("Suggest", 0.4);
  const int64_t before = ctx.Clock.Now();
  suggest("acme", "in");
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 0.2, "suggest waited %.2f s for a suggester that takes 0.4 s: the dropdown has 150 ms", waited);
}

void CheckNoInlineRetry(harness::Ctx& ctx) {
  hClientPeer(ctx);
  ctx.GRPC.Fail("Suggest", grpc::StatusCode::UNAVAILABLE, "deploy in progress", 3);
  suggest("acme", "ke");
  ctx.Equal(ctx.GRPC.CallsTo("Suggest").size(), 1, "one keystroke against a failing suggester: retrying in the request multiplies the load during an outage; the Suggest calls");
  ctx.Equal(ctx.Clock.Sleeps(), 0, "a failure must not be slept on in the request; the sleeps");
  // Whatever the error, one call: no status code earns a second attempt inside the request.
  const std::vector<std::pair<grpc::StatusCode, std::string>> errors = {
      {grpc::StatusCode::DEADLINE_EXCEEDED, "kett"}, {grpc::StatusCode::INTERNAL, "in"}, {grpc::StatusCode::UNKNOWN, "inv"}, {grpc::StatusCode::RESOURCE_EXHAUSTED, "key"}};
  for (const auto& [code, prefix] : errors) {
    ctx.GRPC.ClearFailures();
    ctx.GRPC.Fail("Suggest", code, "suggester error", 2);
    const size_t before = ctx.GRPC.CallsTo("Suggest").size();
    const Answer got = suggest("acme", prefix);
    ctx.Equal(ctx.GRPC.CallsTo("Suggest").size() - before, 1, "a keystroke whose Suggest call failed with status %d: no error is retried inside the request; the Suggest calls", static_cast<int>(code));
    ctx.Equal(got.source, "fallback", "a keystroke whose Suggest call failed with status %d must answer the fallback; the source", static_cast<int>(code));
  }
}

void CheckFallback(harness::Ctx& ctx) {
  hClientPeer(ctx);
  ctx.GRPC.SetLatency("Suggest", 1.0);
  Answer got = suggest("acme", "in");
  ctx.Equal(got.source, "fallback", "with the suggester taking 1 s the answer must be the fallback, marked; the source");
  ctx.Equal(got.suggestions, HStrings{"integrations", "inventory", "invoices"}, "the fallback for \\"in\\" (the curated terms that start with the prefix)");
  ctx.Assert(!got.fallback_version.empty(), "the fallback answer carries no fallback_version: a bad list cannot be traced or rolled back");
  ctx.GRPC.SetLatency("Suggest", 0);
  ctx.GRPC.Fail("Suggest", grpc::StatusCode::UNAVAILABLE, "deploy in progress", 1);
  got = suggest("acme", "ke");
  ctx.Equal(got.source, "fallback", "with the suggester UNAVAILABLE, the source");
  ctx.Equal(got.suggestions, HStrings{"kettle", "keyboard"}, "the fallback for \\"ke\\"");
  ctx.GRPC.Fail("Suggest", grpc::StatusCode::UNAVAILABLE, "deploy in progress", 1);
  got = suggest("acme", "ve");
  ctx.Equal(got.source, "fallback", "with the suggester UNAVAILABLE, the source for \\"ve\\"");
  ctx.Equal(got.suggestions, HStrings{}, "the fallback for \\"ve\\": a curated term qualifies when it starts with the prefix (inventory only contains it)");
}

void CheckDegradedNotCached(harness::Ctx& ctx) {
  hClientPeer(ctx);
  ctx.GRPC.Fail("Suggest", grpc::StatusCode::UNAVAILABLE, "deploy in progress", 3);
  const Answer first = suggest("acme", "ke");
  const auto cached = ctx.Redis.Keys("suggest:cache:*");
  ctx.Assert(cached.empty(), "a failed call left %q in the cache (source %s): a degraded answer must not be cached", cached, first.source);
  ctx.GRPC.ClearFailures();
  const Answer second = suggest("acme", "ke");
  ctx.Equal(second.source, "suggester", "once the suggester recovered, the next keystroke's source");
  ctx.Equal(second.suggestions, hTerms.at("ke"), "the suggester's terms once it recovered");
  ctx.Equal(suggest("acme", "ke").source, "cache", "the suggester's answer must be cached; the third keystroke's source");
}
`,
  },
  hints: [
    'Make the suggester take a second: each keystroke waits for it. Make it fail: it is called three times, the dropdown is empty, and it stays empty for five minutes after the suggester is back.',
    'The 2 s timeout is longer than a keystroke; the loop retries inline against the same failing service; the empty list from the failed attempts goes through `put_suggestions` like a real answer.',
    'Call `Suggest` once with `timeout=DEADLINE_S` (0.15); in `except grpc.RpcError` return the `FALLBACK_SUGGESTIONS` that start with the prefix, `source: "fallback"` and `FALLBACK_VERSION`; cache only `reply.terms`.',
  ],
  debrief: `The deadline is set from the keystroke's budget, not from how long the suggester might need: past 150 ms an answer is too late to be shown, so waiting longer only holds a connection. Dropping the retry is the same budget seen from the suggester's side: during a deploy every inline retry is extra load on the instances that are left. The fallback is marked and versioned because a degraded answer has to be visible in the response and in the metrics, and a bad curated list has to be rolled back by changing one value. Not caching it is what lets the recovery show on the next keystroke. Production clients add a circuit breaker so a suggester that keeps failing is not called at all for a while, and hedge a slow call to a second replica.`,
};
