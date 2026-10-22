import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/trending: the popular queries rail',
  concept: 'http',
  file: 'read',
  focus: ['api', 'trending', 'store'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it reads recent queries and
returns the popular ones for the trending rail. It compiles, it shows something on the demo, and it
hides three production flaws. Review it like the service owner, fix it, and prove the fix with the
checks below.

Implement \`GET /v1/trending\`.

- A term trends only when it has at least **\`MIN_TREND_COUNT = 100\` occurrences** in the window. One
  search is a search, not a trend.
- The window is explicit (\`WINDOW_SECONDS\`), so "popular" has a time bound rather than meaning "ever".
- Terms whose category is **sensitive** (\`SENSITIVE_CATEGORIES\`) are filtered out and never trend,
  even when their count is high.
- A trend entry carries the **term and its count only** — never a user id, a session id or anything
  that links the trend back to the person who searched. A trend is an aggregate, not a person.
- The response shape is \`{"window_seconds": …, "entries": [{"term": …, "count": …}]}\`.

**Failure mode the checks target.** A single occurrence promoted to a trend publishes one person's
name to everyone on the next page load — the trending rail is the highest-traffic place a search term
can land. Linking each trend entry to the user who triggered it turns an analytics read into a
privacy leak that survives in logs and caches. The missing sensitive-category filter is the third:
without it, a high-count term from a category that should never surface becomes the top trend.`,
  sequence: {
    participants: ['Client', 'Autocomplete API', 'Trend index'],
    messages: [
      {from: 'Client', to: 'Autocomplete API', label: 'GET /v1/trending · X-Tenant-Id', kind: 'sync'},
      {from: 'Autocomplete API', to: 'Trend index', label: 'trending_window(tenant, 86400)', kind: 'sync'},
      {from: 'Trend index', to: 'Autocomplete API', label: 'term · category · count', kind: 'reply'},
      {from: 'Autocomplete API', to: 'Autocomplete API', label: 'filter sensitive · floor at 100', kind: 'sync'},
      {from: 'Autocomplete API', to: 'Client', label: '200 {window_seconds, entries}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/trending',
      detail: 'Register the trending read on `GET /v1/trending`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/trending["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/trending['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/trending"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"trending"\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*"\/v1\/trending"/]},
      },
    },
    {
      id: 'occurrence-floor',
      title: 'Applies the 100-occurrence floor',
      detail:
        'A term trends only at `MIN_TREND_COUNT = 100` occurrences in the window. The draft promotes single-occurrence queries.',
      match: {
        python: {all: [/MIN_TREND_COUNT/, /count\s*[<>]=?\s*MIN_TREND_COUNT/]},
        typescript: {all: [/MIN_TREND_COUNT/, /count\s*[<>]=?\s*MIN_TREND_COUNT/]},
        go: {all: [/minTrendCount/, /Count\s*[<>]=?\s*minTrendCount/]},
        scala: {all: [/MinTrendCount/, /count\s*[<>]=?\s*MinTrendCount/]},
        cpp: {all: [/kMinTrendCount/, /count\s*[<>]=?\s*kMinTrendCount/]},
      },
    },
    {
      id: 'window',
      title: 'Bounds trends to an explicit window',
      detail:
        'The read aggregates over `WINDOW_SECONDS`, so "popular" has a time bound. The draft has no window and trends are unbounded in time.',
      match: {
        python: {all: [/WINDOW_SECONDS/]},
        typescript: {all: [/WINDOW_SECONDS/]},
        go: {all: [/windowSeconds/]},
        scala: {all: [/WindowSeconds/]},
        cpp: {all: [/kWindowSeconds/]},
      },
    },
    {
      id: 'sensitive-filter',
      title: 'Filters sensitive categories',
      detail: 'Terms in a sensitive category never trend, whatever their count. The draft has no category filter.',
      match: {
        python: {all: [/SENSITIVE_CATEGORIES/]},
        typescript: {all: [/SENSITIVE_CATEGORIES/]},
        go: {all: [/sensitiveCategories/]},
        scala: {all: [/SensitiveCategories/]},
        cpp: {all: [/kSensitiveCategories/]},
      },
    },
    {
      id: 'no-user-linkage',
      title: 'Carries no user linkage',
      detail:
        'A trend entry is the term and its count — no user id, no session id. The draft attaches the `user_id` that triggered the trend.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/trending["']/], none: [/\buser_id\b/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/trending['"]/], none: [/\buser_id\b/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/trending"/], none: [/\buser_id\b/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"trending"\s*\)/], none: [/\buser_id\b/]},
        cpp: {all: [/svr\.Get\(\s*"\/v1\/trending"/], none: [/\buser_id\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI

app = FastAPI()


@app.get("/v1/trending")
def trending(x_tenant_id: str = ""):
    # TODO: this draft promotes raw queries with a single occurrence as trends and links each
    # trend entry to the user who triggered it, so a person's name trends after one search.
    rows = index.recent_queries(x_tenant_id)
    return {
        "entries": [{"term": row.text, "count": row.count, "user_id": row.user_id} for row in rows]
    }
`,
      solution: `from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse

app = FastAPI()

MIN_TREND_COUNT = 100
WINDOW_SECONDS = 86400
SENSITIVE_CATEGORIES = {"adult", "medical", "gambling"}


@app.get("/v1/trending")
def trending(x_tenant_id: str = Header(default="")):
    if not x_tenant_id:
        return JSONResponse({"error": "missing X-Tenant-Id"}, status_code=401)
    entries = []
    for term in index.trending_window(x_tenant_id, WINDOW_SECONDS):
        if term.category in SENSITIVE_CATEGORIES:
            continue
        if term.count < MIN_TREND_COUNT:
            continue
        entries.append({"term": term.text, "count": term.count})
    return {"window_seconds": WINDOW_SECONDS, "entries": entries}
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

export const app = Fastify();

app.get('/v1/trending', async (request, reply) => {
  // TODO: this draft promotes raw queries with a single occurrence as trends and links each
  // trend entry to the user who triggered it, so a person's name trends after one search.
  const tenant = request.headers['x-tenant-id'] as string;
  const rows = await index.recentQueries(tenant);
  return {entries: rows.map(row => ({term: row.text, count: row.count, user_id: row.userId}))};
});
`,
      solution: `import Fastify from 'fastify';

export const app = Fastify();

const MIN_TREND_COUNT = 100;
const WINDOW_SECONDS = 86400;
const SENSITIVE_CATEGORIES: Record<string, true> = {adult: true, medical: true, gambling: true};

app.get('/v1/trending', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const entries: {term: string; count: number}[] = [];
  for (const term of await index.trendingWindow(tenant, WINDOW_SECONDS)) {
    if (SENSITIVE_CATEGORIES[term.category] === true) continue;
    if (term.count < MIN_TREND_COUNT) continue;
    entries.push({term: term.text, count: term.count});
  }
  return {window_seconds: WINDOW_SECONDS, entries};
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
)

func trending(rw http.ResponseWriter, r *http.Request) {
	// TODO: this draft promotes raw queries with a single occurrence as trends and links each
	// trend entry to the user who triggered it, so a person's name trends after one search.
	tenant := r.Header.Get("X-Tenant-Id")
	rows := index.RecentQueries(tenant)
	entries := []map[string]any{}
	for _, row := range rows {
		entries = append(entries, map[string]any{"term": row.Text, "count": row.Count, "user_id": row.UserID})
	}
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode(map[string]any{"entries": entries})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/trending", trending)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
)

const (
	minTrendCount = 100
	windowSeconds = 86400
)

var sensitiveCategories = map[string]bool{"adult": true, "medical": true, "gambling": true}

type TrendEntry struct {
	Term  string \`json:"term"\`
	Count int    \`json:"count"\`
}

func trending(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeError(rw, http.StatusUnauthorized, "missing X-Tenant-Id")
		return
	}
	entries := []TrendEntry{}
	for _, term := range index.TrendingWindow(tenant, windowSeconds) {
		if sensitiveCategories[term.Category] {
			continue
		}
		if term.Count < minTrendCount {
			continue
		}
		entries = append(entries, TrendEntry{Term: term.Text, Count: term.Count})
	}
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode(map[string]any{"window_seconds": windowSeconds, "entries": entries})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/trending", trending)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

object Read {
  implicit val system: ActorSystem = ActorSystem("trending")

  val route: Route =
    path("v1" / "trending") {
      get {
        headerValueByName("X-Tenant-Id") { tenant =>
          // TODO: this draft promotes raw queries with a single occurrence as trends and links
          // each trend entry to the user who triggered it.
          val rows = index.recentQueries(tenant)
          val entries = rows.map(row => s"""{"term":"\${row.text}","count":\${row.count},"user_id":"\${row.userId}"}""")
          complete(StatusCodes.OK, s"""{"entries":[\${entries.mkString(",")}]}""")
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

object Read {
  implicit val system: ActorSystem = ActorSystem("trending")

  val MinTrendCount = 100
  val WindowSeconds = 86400
  val SensitiveCategories = Set("adult", "medical", "gambling")

  val route: Route =
    path("v1" / "trending") {
      get {
        headerValueByName("X-Tenant-Id") { tenant =>
          val entries = index.trendingWindow(tenant, WindowSeconds).collect {
            case term if !SensitiveCategories.contains(term.category) && term.count >= MinTrendCount =>
              s"""{"term":"\${term.text}","count":\${term.count}}"""
          }
          complete(
            StatusCodes.OK,
            s"""{"window_seconds":$WindowSeconds,"entries":[\${entries.mkString(",")}]}"""
          )
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
      starter: `#include <string>

#include <httplib.h>
#include <nlohmann/json.hpp>

using json = nlohmann::json;

int main() {
  httplib::Server svr;

  svr.Get("/v1/trending", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft promotes raw queries with a single occurrence as trends and links each
    // trend entry to the user who triggered it.
    const auto tenant = req.get_header_value("X-Tenant-Id");
    json entries = json::array();
    for (const auto& row : recentQueries(tenant)) {
      entries.push_back({{"term", row.text}, {"count", row.count}, {"user_id", row.userId}});
    }
    res.status = 200;
    res.set_content(json{{"entries", entries}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <set>
#include <string>

#include <httplib.h>
#include <nlohmann/json.hpp>

using json = nlohmann::json;

constexpr int kMinTrendCount = 100;
constexpr int kWindowSeconds = 86400;
const std::set<std::string> kSensitiveCategories = {"adult", "medical", "gambling"};

int main() {
  httplib::Server svr;

  svr.Get("/v1/trending", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    json entries = json::array();
    for (const auto& term : trendingWindow(tenant, kWindowSeconds)) {
      if (kSensitiveCategories.count(term.category) != 0) continue;
      if (term.count < kMinTrendCount) continue;
      entries.push_back({{"term", term.text}, {"count", term.count}});
    }
    res.status = 200;
    res.set_content(
        json{{"window_seconds", kWindowSeconds}, {"entries", entries}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'A trend is an aggregate over many people. Pick the floor first — 100 occurrences in the window — and apply it before the term reaches the rail, so a single search can never trend.',
    'Filter by category, not by count: a sensitive term with 100 000 occurrences still must not trend. Exclude the category before you rank.',
    'The response is the term and its count. Nothing about the user who searched belongs in it — not the user id, not the session id, not the tenant. Aggregates are safe to cache and to log; per-user rows are not.',
  ],
  debrief: `The interviewer is testing whether you can review a generated analytics read at the privacy boundary. The draft reads fine because the demo searches the same term many times. Three defects are being checked. No occurrence floor means the first search of a person's name publishes it to everyone on the next page load — the trending rail is the highest-traffic place a term can land. Attaching the user who triggered the trend turns an aggregate read into a per-user leak that survives in caches and logs. The missing sensitive-category filter is the third: a high-count term from a category that should never surface becomes the top trend. Real reads add k-anonymity over distinct searchers, a rolling window computed offline so the read is a cache hit, and a review path for terms that are trending but should not be.`,
};
