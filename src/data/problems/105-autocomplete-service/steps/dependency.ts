import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Suggester call behind GET /v1/autocomplete',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'suggester', 'fallback'],
  task: `## Task

**Starting point.** The starter calls the suggester over gRPC with a two-second timeout, retries
three times inside the request, and returns the suggester's terms or an empty list. It compiles,
it works when the suggester is healthy, and it hides 5 flaws.

- The suggester is called with a **150 ms deadline** (\`DEADLINE_MS = 150\`). A typeahead that waits
  longer than that is worse than no suggestion.
- When the call fails or the deadline fires, the response serves the **static curated fallback
  list**, not an empty list. The UI must keep suggesting while the suggester is slow.
- The fallback response is **marked as fallback** (\`"source": "fallback"\`, against \`"suggester"\`
  on the normal path) so the client and the metrics can tell a degraded answer from a real one.
- **Retries are dropped, not run inline.** A retry inside the user's request adds latency on top of
  latency; the call is attempted once under the deadline and the fallback serves the request. The
  dropped attempt is counted (\`RETRIES_DROPPED\`) so the drop is visible in metrics.
- The fallback list is **versioned** (\`FALLBACK_LIST_VERSION\`) so a bad list can be rolled back by
  changing one value rather than shipping new code.

**Failure mode the checks target.** Returning nothing on timeout is the visible part: the suggester
is slow for ten seconds during a deploy and the search box looks broken, so users type the term in
full and the product loses its reason to exist. Retrying inline compounds the outage, because the
suggester is already slow and now every request multiplies the load. The unversioned, unmarked
fallback is the subtle part: when the curated list itself is wrong there is no value to roll back,
and nobody can tell a degraded answer from a real one.`,
  sequence: {
    participants: ['Autocomplete API', 'Suggester', 'Fallback list'],
    messages: [
      {from: 'Autocomplete API', to: 'Suggester', label: 'Suggest(prefix) · deadline 150 ms', kind: 'sync'},
      {from: 'Suggester', to: 'Autocomplete API', label: 'terms / DEADLINE_EXCEEDED', kind: 'reply'},
      {from: 'Autocomplete API', to: 'Autocomplete API', label: 'drop the retry · count dropped', kind: 'sync'},
      {from: 'Autocomplete API', to: 'Fallback list', label: 'read curated list v{version}', kind: 'sync'},
      {from: 'Fallback list', to: 'Autocomplete API', label: 'static terms', kind: 'reply'},
      {from: 'Autocomplete API', to: 'Autocomplete API', label: 'mark source=fallback', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Calls the suggester with a 150 ms deadline',
      detail:
        'The suggester call carries `DEADLINE_MS = 150`. The starter calls with a two-second timeout and retries inside the request.',
      match: {
        python: {all: [/DEADLINE_MS/, /timeout\s*=\s*DEADLINE_MS/]},
        typescript: {all: [/DEADLINE_MS/, /deadline/]},
        go: {all: [/deadlineMs/, /context\.WithTimeout\(/]},
        scala: {all: [/DeadlineMs/, /withDeadlineAfter\(/]},
        cpp: {all: [/kDeadlineMs/, /set_deadline\(/]},
      },
    },
    {
      id: 'fallback-list',
      title: 'A timeout serves the fallback list, not an empty response',
      detail:
        'On error the response carries the curated fallback list. The starter returns `[]`, so a slow suggester makes the UI look broken.',
      match: {
        python: {all: [/FALLBACK_SUGGESTIONS/, /except\s+grpc\.RpcError/]},
        typescript: {all: [/FALLBACK_SUGGESTIONS/, /if\s*\(\s*error/]},
        go: {all: [/fallbackSuggestions/, /if\s+err\s*!=\s*nil/]},
        scala: {all: [/FallbackSuggestions/, /recover\s*\{/]},
        cpp: {all: [/kFallbackSuggestions/, /status\.ok\(\)/]},
      },
    },
    {
      id: 'fallback-marker',
      title: 'Marks the fallback response',
      detail:
        'The degraded response is marked `"source": "fallback"` so the client and metrics can tell it apart from a real suggester answer. The starter has no marker at all.',
      match: {
        python: {all: [/"fallback"/]},
        typescript: {all: [/'fallback'/]},
        go: {all: [/"fallback"/]},
        scala: {all: [/"fallback"/]},
        cpp: {all: [/"fallback"/]},
      },
    },
    {
      id: 'drop-retries',
      title: 'Drops retries instead of running them inline',
      detail:
        'The suggester is attempted once under the deadline; a failed attempt is counted as dropped rather than retried in the request. The starter retries three times inline.',
      match: {
        python: {all: [/RETRIES_DROPPED/], none: [/for\s+attempt\s+in\s+range\(/]},
        typescript: {all: [/RETRIES_DROPPED/], none: [/attempt\s*<\s*\d+/]},
        go: {all: [/retriesDropped/], none: [/for\s+attempt\s*:=\s*0/]},
        scala: {all: [/RetriesDropped/], none: [/for\s*\(\s*attempt\s*<-/]},
        cpp: {all: [/kRetriesDropped/], none: [/for\s*\(\s*int\s+attempt/]},
      },
    },
    {
      id: 'fallback-version',
      title: 'Versions the fallback list so it can be rolled back',
      detail:
        'The fallback list carries `FALLBACK_LIST_VERSION`, returned with the marker, so a bad list is rolled back by changing one value. The starter has no version.',
      match: {
        python: {all: [/FALLBACK_LIST_VERSION/]},
        typescript: {all: [/FALLBACK_LIST_VERSION/]},
        go: {all: [/fallbackListVersion/]},
        scala: {all: [/FallbackListVersion/]},
        cpp: {all: [/kFallbackListVersion/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc


def suggest(stub, tenant: str, prefix: str):
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    request = SuggestRequest(tenant=tenant, prefix=prefix)
    for attempt in range(3):
        try:
            response = stub.Suggest(request, timeout=2.0)
            return {"suggestions": list(response.suggestions)}
        except grpc.RpcError:
            continue
    return {"suggestions": []}
`,
      solution: `import grpc

DEADLINE_MS = 150
FALLBACK_LIST_VERSION = "2026-10-21"
FALLBACK_SUGGESTIONS = ["invoices", "inventory", "integrations"]
RETRIES_DROPPED = metrics.counter("autocomplete.retries_dropped")


def suggest(stub, tenant: str, prefix: str):
    request = SuggestRequest(tenant=tenant, prefix=prefix)
    try:
        response = stub.Suggest(request, timeout=DEADLINE_MS / 1000.0)
    except grpc.RpcError:
        RETRIES_DROPPED.inc()
        return {
            "suggestions": FALLBACK_SUGGESTIONS,
            "source": "fallback",
            "fallback_version": FALLBACK_LIST_VERSION,
        }
    return {"suggestions": list(response.suggestions), "source": "suggester"}
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';

export function suggest(client: SuggesterClient, tenant: string, prefix: string): Promise<string[]> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const request = {tenant, prefix};
  return new Promise(resolve => {
    let attempt = 0;
    const run = (): void => {
      client.Suggest(request, {}, (error, response) => {
        if (error !== null && attempt < 3) {
          attempt += 1;
          run();
          return;
        }
        resolve(error !== null ? [] : response.suggestions);
      });
    };
    run();
  });
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';

export const DEADLINE_MS = 150;
export const FALLBACK_LIST_VERSION = '2026-10-21';
export const FALLBACK_SUGGESTIONS = ['invoices', 'inventory', 'integrations'];
export const RETRIES_DROPPED = metrics.counter('autocomplete.retries_dropped');

export interface SuggestionResult {
  suggestions: string[];
  source: 'suggester' | 'fallback';
  fallback_version?: string;
}

export function suggest(client: SuggesterClient, tenant: string, prefix: string): Promise<SuggestionResult> {
  const request = {tenant, prefix};
  return new Promise(resolve => {
    const deadline = new Date(Date.now() + DEADLINE_MS);
    client.Suggest(request, {deadline}, (error, response) => {
      if (error !== null) {
        RETRIES_DROPPED.inc();
        resolve({
          suggestions: FALLBACK_SUGGESTIONS,
          source: 'fallback',
          fallback_version: FALLBACK_LIST_VERSION,
        });
        return;
      }
      resolve({suggestions: response.suggestions, source: 'suggester'});
    });
  });
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"google.golang.org/grpc"
)

func Suggest(ctx context.Context, client SuggesterClient, tenant, prefix string) (Result, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	for attempt := 0; attempt < 3; attempt++ {
		response, err := client.Suggest(ctx, &SuggestRequest{Tenant: tenant, Prefix: prefix})
		if err == nil {
			return Result{Suggestions: response.Suggestions}, nil
		}
	}
	return Result{Suggestions: []string{}}, nil
}
`,
      solution: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc"
)

const deadlineMs = 150

var fallbackListVersion = "2026-10-21"

var fallbackSuggestions = []string{"invoices", "inventory", "integrations"}

var retriesDropped = metrics.Counter("autocomplete.retries_dropped")

func Suggest(ctx context.Context, client SuggesterClient, tenant, prefix string) (Result, error) {
	callCtx, cancel := context.WithTimeout(ctx, time.Duration(deadlineMs)*time.Millisecond)
	defer cancel()
	response, err := client.Suggest(callCtx, &SuggestRequest{Tenant: tenant, Prefix: prefix})
	if err != nil {
		retriesDropped.Inc()
		return Result{
			Suggestions:     fallbackSuggestions,
			Source:          "fallback",
			FallbackVersion: fallbackListVersion,
		}, nil
	}
	return Result{Suggestions: response.Suggestions, Source: "suggester"}, nil
}
`,
    },
    scala: {
      starter: `import scala.concurrent.{ExecutionContext, Future}

object Client {
  def suggest(stub: SuggesterGrpc.SuggesterStub, tenant: String, prefix: String)(implicit ec: ExecutionContext): Future[Result] = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    val request = SuggestRequest(tenant = tenant, prefix = prefix)
    def run(remaining: Int): Future[Result] = {
      if (remaining == 0) Future.successful(Result(suggestions = List.empty))
      else stub.suggest(request).recoverWith { case _: StatusRuntimeException => run(remaining - 1) }
    }
    run(3)
  }
}
`,
      solution: `import scala.concurrent.duration._
import scala.concurrent.{ExecutionContext, Future}

object Client {
  val DeadlineMs: Long = 150
  val FallbackListVersion = "2026-10-21"
  val FallbackSuggestions: List[String] = List("invoices", "inventory", "integrations")
  val RetriesDropped: Counter = metrics.counter("autocomplete.retries_dropped")

  def suggest(stub: SuggesterGrpc.SuggesterStub, tenant: String, prefix: String)(implicit ec: ExecutionContext): Future[Result] = {
    val request = SuggestRequest(tenant = tenant, prefix = prefix)
    stub
      .withDeadlineAfter(DeadlineMs, MILLISECONDS)
      .suggest(request)
      .map(response => Result(suggestions = response.suggestions, source = "suggester"))
      .recover { case _: StatusRuntimeException =>
        RetriesDropped.inc()
        Result(
          suggestions = FallbackSuggestions,
          source = "fallback",
          fallbackVersion = Some(FallbackListVersion)
        )
      }
  }
}
`,
    },
    cpp: {
      starter: `#include <string>
#include <vector>

#include <grpcpp/grpcpp.h>

Result Suggest(Suggester::Stub& stub, const std::string& tenant, const std::string& prefix) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  SuggestRequest request;
  request.set_tenant(tenant);
  request.set_prefix(prefix);
  for (int attempt = 0; attempt < 3; ++attempt) {
    grpc::ClientContext context;
    SuggestResponse response;
    const auto status = stub.Suggest(&context, request, &response);
    if (status.ok()) {
      return Result{
          std::vector<std::string>(response.suggestions().begin(), response.suggestions().end()),
          "suggester",
          ""};
    }
  }
  return Result{{}, "suggester", ""};
}
`,
      solution: `#include <chrono>
#include <string>
#include <vector>

#include <grpcpp/grpcpp.h>

constexpr long kDeadlineMs = 150;
const std::string kFallbackListVersion = "2026-10-21";
const std::vector<std::string> kFallbackSuggestions = {"invoices", "inventory", "integrations"};
metrics::Counter kRetriesDropped("autocomplete.retries_dropped");

Result Suggest(Suggester::Stub& stub, const std::string& tenant, const std::string& prefix) {
  SuggestRequest request;
  request.set_tenant(tenant);
  request.set_prefix(prefix);
  grpc::ClientContext context;
  context.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kDeadlineMs));
  SuggestResponse response;
  const auto status = stub.Suggest(&context, request, &response);
  if (!status.ok()) {
    kRetriesDropped.Inc();
    return Result{kFallbackSuggestions, "fallback", kFallbackListVersion};
  }
  return Result{
      std::vector<std::string>(response.suggestions().begin(), response.suggestions().end()),
      "suggester",
      ""};
}
`,
    },
  },
  hints: [
    'During a suggester deploy the dropdown goes blank for six seconds per keystroke, and the suggester dashboard shows three times the normal request rate.',
    'The loop calls with a two-second timeout and retries up to three times inside the request; on the last failure it returns an empty list with nothing to say it was degraded.',
    'Call once with DEADLINE_MS = 150, count a failure in RETRIES_DROPPED, and return FALLBACK_SUGGESTIONS with "source": "fallback" and FALLBACK_LIST_VERSION; the healthy path says "source": "suggester".',
  ],
  debrief: `The shape of the fix is one attempt, a short deadline, and a real answer on failure. A 150 ms deadline fits inside a keystroke, so a slow suggester costs the user nothing visible. Dropping the retry instead of running it inline keeps a slow suggester from becoming a down one: during an outage every inline retry is extra load on the thing already struggling, and the dropped counter keeps that decision visible. The fallback is a curated list, not an empty array, because a typeahead that degrades is still a typeahead; the marker lets the client tell the two apart, and the version makes a bad list a one-value rollback. Production clients add a breaker so a down suggester is not called at all, an in-memory copy of the fallback list, and an alert on the fallback rate.`,
};
