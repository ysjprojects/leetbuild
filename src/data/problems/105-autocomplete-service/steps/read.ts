import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/trending: a window, a floor, a category filter and no user linkage',
  concept: 'http',
  file: 'trending',
  focus: ['client', 'api', 'terms', 'consumer'],
  task: `## Task

**Starting point.** The starter registers \`GET /v1/trending\`: it answers **401** without
\`X-Tenant-Id\`, sums the tenant's hourly buckets with \`terms.trend_counts(tenant, 0)\` and returns the
ten most searched terms as \`{"window_hours": 24, "entries": [{"term", "count", "user_id"}]}\`, the
user id from \`terms.last_searcher\`. It serves the demo and hides four flaws.

**Failure mode the checks target.** A name searched once appears on the trending rail next to the id
of the person who typed it; a term that peaked last month still trends; and a clinic or a person's
name tops the rail because nothing looks at its category.

- Sum only the last \`WINDOW_HOURS\` = 24 buckets: \`since_hour = terms.current_hour() - WINDOW_HOURS + 1\`.
- A term trends at \`MIN_TREND_COUNT\` = 100 searches or more in the window.
- Drop terms whose \`terms.category_of\` is in \`SENSITIVE_CATEGORIES\` (adult, health, person).
- An entry is \`{"term", "count"}\` and nothing else; filter first, then keep the top
  \`MAX_ENTRIES\` = 10, most searched first.`,
  sequence: {
    participants: ['Search box', 'suggestd', 'Term store'],
    messages: [
      {from: 'Search box', to: 'suggestd', label: 'GET /v1/trending · X-Tenant-Id', kind: 'sync'},
      {from: 'suggestd', to: 'Term store', label: 'trend_counts(tenant, current_hour() - 23)', kind: 'sync'},
      {from: 'Term store', to: 'suggestd', label: 'searches per term over 24 hourly buckets', kind: 'reply'},
      {from: 'suggestd', to: 'Term store', label: 'category_of(tenant, term)', kind: 'sync'},
      {from: 'suggestd', to: 'suggestd', label: 'count ≥ 100 · category not sensitive · top 10', kind: 'sync'},
      {from: 'suggestd', to: 'Search box', label: '200 {window_hours: 24, entries: [{term, count}]}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Serves GET /v1/trending per tenant',
      detail:
        'Register `GET /v1/trending`; a request without `X-Tenant-Id` is **401**, and a tenant sees its own terms, most searched first, under `window_hours` and `entries`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/trending["']/, /\b401\b/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/trending['"]/, /\b401\b/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/trending"/, /StatusUnauthorized|\b401\b/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"trending"\s*\)/, /Unauthorized|\b401\b/]},
        cpp: {all: [/svr\.Get\(\s*"\/v1\/trending"/, /\b401\b/]},
      },
    },
    {
      id: 'occurrence-floor',
      title: 'Trends only terms searched at least 100 times',
      detail:
        'A term with fewer than `MIN_TREND_COUNT` (100) searches in the window is left out: one search is a search, not a trend.',
      match: {
        python: {all: [/MIN_TREND_COUNT\s*=\s*100\b/, /<\s*MIN_TREND_COUNT|>=\s*MIN_TREND_COUNT/]},
        typescript: {all: [/MIN_TREND_COUNT\s*=\s*100\b/, /<\s*MIN_TREND_COUNT|>=\s*MIN_TREND_COUNT/]},
        go: {all: [/minTrendCount\s*=\s*100\b/, /<\s*minTrendCount|>=\s*minTrendCount/]},
        scala: {all: [/MinTrendCount\s*=\s*100L?\b/, /<\s*MinTrendCount|>=\s*MinTrendCount/]},
        cpp: {all: [/kMinTrendCount\s*=\s*100\b/, /<\s*kMinTrendCount|>=\s*kMinTrendCount/]},
      },
    },
    {
      id: 'window',
      title: 'Counts the last 24 hours, not all time',
      detail:
        'The counts start at `current_hour() - WINDOW_HOURS + 1`, so popular means popular in the last 24 hourly buckets; `trend_counts(tenant, 0)` sums every bucket ever written.',
      match: {
        python: {all: [/current_hour\(\)\s*-\s*WINDOW_HOURS/], none: [/trend_counts\(\s*tenant,\s*0\s*\)/]},
        typescript: {all: [/currentHour\(\)\s*-\s*WINDOW_HOURS/], none: [/trendCounts\(\s*tenant,\s*0\s*\)/]},
        go: {all: [/terms\.CurrentHour\(\)\s*-\s*windowHours/], none: [/TrendCounts\([^)]*,\s*0\s*\)/]},
        scala: {all: [/Terms\.currentHour\(\)\s*-\s*WindowHours/], none: [/trendCounts\(\s*tenant,\s*0L?\s*\)/]},
        cpp: {all: [/terms::currentHour\(\)\s*-\s*kWindowHours/], none: [/trendCounts\(\s*tenant,\s*0\s*\)/]},
      },
    },
    {
      id: 'sensitive-filter',
      title: 'Never trends a sensitive category',
      detail:
        'A term whose `category_of` is in `SENSITIVE_CATEGORIES` (adult, health, person) is dropped whatever its count, before the top ten are cut.',
      match: {
        python: {all: [/SENSITIVE_CATEGORIES\s*=/, /category_of\(/]},
        typescript: {all: [/SENSITIVE_CATEGORIES\s*=/, /categoryOf\(/]},
        go: {all: [/sensitiveCategories\s*=/, /terms\.CategoryOf\(/]},
        scala: {all: [/SensitiveCategories\s*[:=]/, /Terms\.categoryOf\(/]},
        cpp: {all: [/kSensitiveCategories\s*=/, /terms::categoryOf\(/]},
      },
    },
    {
      id: 'no-user-linkage',
      title: 'Entries carry a term and a count only',
      detail:
        'An entry is `{"term", "count"}`: no user id, nothing from `last_searcher` that ties an aggregate back to the person who searched.',
      match: {
        python: {all: [/["']term["']/], none: [/last_searcher\(|user_id/]},
        typescript: {all: [/\bterm\b/], none: [/lastSearcher\(|user_id/]},
        go: {all: [/json:"term"/], none: [/LastSearcher\(|user_id/]},
        scala: {all: [/"term"/], none: [/lastSearcher\(|user_id/]},
        cpp: {all: [/"term"/], none: [/lastSearcher\(|user_id/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from suggest import terms  # current_hour, trend_counts, category_of, last_searcher

app = FastAPI()

WINDOW_HOURS = 24
MAX_ENTRIES = 10


@app.get("/v1/trending")
def trending(request: Request):
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        return JSONResponse({"error": "X-Tenant-Id is required"}, status_code=401)
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    counts = terms.trend_counts(tenant, 0)
    entries = [
        {"term": term, "count": count, "user_id": terms.last_searcher(tenant, term)}
        for term, count in sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    ]
    return {"window_hours": WINDOW_HOURS, "entries": entries[:MAX_ENTRIES]}
`,
      solution: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from suggest import terms  # current_hour, trend_counts, category_of, last_searcher

app = FastAPI()

WINDOW_HOURS = 24
MIN_TREND_COUNT = 100
SENSITIVE_CATEGORIES = frozenset({"adult", "health", "person"})
MAX_ENTRIES = 10


@app.get("/v1/trending")
def trending(request: Request):
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        return JSONResponse({"error": "X-Tenant-Id is required"}, status_code=401)
    # The last WINDOW_HOURS hourly buckets, the current one included: popular now, not ever.
    counts = terms.trend_counts(tenant, terms.current_hour() - WINDOW_HOURS + 1)
    entries = []
    for term, count in sorted(counts.items(), key=lambda item: (-item[1], item[0])):
        if count < MIN_TREND_COUNT or terms.category_of(tenant, term) in SENSITIVE_CATEGORIES:
            continue
        entries.append({"term": term, "count": count})  # an aggregate: nothing that points at a person
    return {"window_hours": WINDOW_HOURS, "entries": entries[:MAX_ENTRIES]}
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {categoryOf, currentHour, lastSearcher, trendCounts} from 'suggest/terms';

export const app = Fastify();

export const WINDOW_HOURS = 24;
export const MAX_ENTRIES = 10;

app.get('/v1/trending', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const counts = await trendCounts(tenant, 0);
  const ranked = [...counts].sort(([a, x], [b, y]) => y - x || a.localeCompare(b));
  const entries = [];
  for (const [term, count] of ranked) entries.push({term, count, user_id: await lastSearcher(tenant, term)});
  return {window_hours: WINDOW_HOURS, entries: entries.slice(0, MAX_ENTRIES)};
});
`,
      solution: `import Fastify from 'fastify';

import {categoryOf, currentHour, lastSearcher, trendCounts} from 'suggest/terms';

export const app = Fastify();

export const WINDOW_HOURS = 24;
export const MIN_TREND_COUNT = 100;
export const SENSITIVE_CATEGORIES = new Set(['adult', 'health', 'person']);
export const MAX_ENTRIES = 10;

app.get('/v1/trending', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  // The last WINDOW_HOURS hourly buckets, the current one included: popular now, not ever.
  const counts = await trendCounts(tenant, currentHour() - WINDOW_HOURS + 1);
  const ranked = [...counts].sort(([a, x], [b, y]) => y - x || a.localeCompare(b));
  const entries: {term: string; count: number}[] = [];
  for (const [term, count] of ranked) {
    if (count < MIN_TREND_COUNT || SENSITIVE_CATEGORIES.has(await categoryOf(tenant, term))) continue;
    entries.push({term, count}); // an aggregate: nothing that points at a person
  }
  return {window_hours: WINDOW_HOURS, entries: entries.slice(0, MAX_ENTRIES)};
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
	"sort"

	"suggest/terms" // terms.CurrentHour, TrendCounts, CategoryOf, LastSearcher
)

const (
	windowHours = 24
	maxEntries  = 10
)

type trendEntry struct {
	Term   string \`json:"term"\`
	Count  int64  \`json:"count"\`
	UserID string \`json:"user_id"\`
}

type trendBody struct {
	WindowHours int          \`json:"window_hours"\`
	Entries     []trendEntry \`json:"entries"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func trending(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	entries := []trendEntry{}
	for term, count := range terms.TrendCounts(r.Context(), tenant, 0) {
		entries = append(entries, trendEntry{Term: term, Count: count, UserID: terms.LastSearcher(r.Context(), tenant, term)})
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].Count != entries[j].Count {
			return entries[i].Count > entries[j].Count
		}
		return entries[i].Term < entries[j].Term
	})
	if len(entries) > maxEntries {
		entries = entries[:maxEntries]
	}
	writeJSON(rw, http.StatusOK, trendBody{WindowHours: windowHours, Entries: entries})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/trending", trending)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"sort"

	"suggest/terms" // terms.CurrentHour, TrendCounts, CategoryOf, LastSearcher
)

const (
	windowHours   = 24
	minTrendCount = 100
	maxEntries    = 10
)

var sensitiveCategories = map[string]bool{"adult": true, "health": true, "person": true}

// trendEntry is an aggregate: nothing in it points at a person.
type trendEntry struct {
	Term  string \`json:"term"\`
	Count int64  \`json:"count"\`
}

type trendBody struct {
	WindowHours int          \`json:"window_hours"\`
	Entries     []trendEntry \`json:"entries"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func trending(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	// The last windowHours hourly buckets, the current one included: popular now, not ever.
	entries := []trendEntry{}
	for term, count := range terms.TrendCounts(r.Context(), tenant, terms.CurrentHour()-windowHours+1) {
		if count < minTrendCount || sensitiveCategories[terms.CategoryOf(r.Context(), tenant, term)] {
			continue
		}
		entries = append(entries, trendEntry{Term: term, Count: count})
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].Count != entries[j].Count {
			return entries[i].Count > entries[j].Count
		}
		return entries[i].Term < entries[j].Term
	})
	if len(entries) > maxEntries {
		entries = entries[:maxEntries]
	}
	writeJSON(rw, http.StatusOK, trendBody{WindowHours: windowHours, Entries: entries})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/trending", trending)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import suggest.Terms // Terms.currentHour, trendCounts, categoryOf, lastSearcher

object Trending {
  val WindowHours = 24
  val MaxEntries = 10

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  val route: Route = path("v1" / "trending") {
    get {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(json(StatusCodes.Unauthorized, JsObject("error" -> JsString("X-Tenant-Id is required"))))
        case Some(tenant) =>
          // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
          val ranked = Terms.trendCounts(tenant, 0L).toSeq.sortBy { case (term, count) => (-count, term) }
          val entries = ranked.take(MaxEntries).map { case (term, count) =>
            JsObject("term" -> JsString(term), "count" -> JsNumber(count), "user_id" -> JsString(Terms.lastSearcher(tenant, term)))
          }
          complete(json(StatusCodes.OK, JsObject("window_hours" -> JsNumber(WindowHours), "entries" -> JsArray(entries.toVector))))
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import suggest.Terms // Terms.currentHour, trendCounts, categoryOf, lastSearcher

object Trending {
  val WindowHours = 24
  val MinTrendCount = 100L
  val SensitiveCategories: Set[String] = Set("adult", "health", "person")
  val MaxEntries = 10

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  val route: Route = path("v1" / "trending") {
    get {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(json(StatusCodes.Unauthorized, JsObject("error" -> JsString("X-Tenant-Id is required"))))
        case Some(tenant) =>
          // The last WindowHours hourly buckets, the current one included: popular now, not ever.
          val counts = Terms.trendCounts(tenant, Terms.currentHour() - WindowHours + 1)
          val ranked = counts.toSeq.sortBy { case (term, count) => (-count, term) }
          val kept = ranked.filterNot { case (term, count) => count < MinTrendCount || SensitiveCategories(Terms.categoryOf(tenant, term)) }
          // An aggregate: nothing that points at a person.
          val entries = kept.take(MaxEntries).map { case (term, count) => JsObject("term" -> JsString(term), "count" -> JsNumber(count)) }
          complete(json(StatusCodes.OK, JsObject("window_hours" -> JsNumber(WindowHours), "entries" -> JsArray(entries.toVector))))
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <string>
#include <utility>
#include <vector>

#include "suggest/terms.h"  // terms::currentHour, trendCounts, categoryOf, lastSearcher

using json = nlohmann::json;

constexpr int kWindowHours = 24;
constexpr size_t kMaxEntries = 10;

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void trending(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, {{"error", "X-Tenant-Id is required"}});
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const auto counts = terms::trendCounts(tenant, 0);
  std::vector<std::pair<std::string, long long>> ranked(counts.begin(), counts.end());
  std::stable_sort(ranked.begin(), ranked.end(), [](const auto& a, const auto& b) { return a.second > b.second; });
  json entries = json::array();
  for (const auto& [term, count] : ranked) {
    if (entries.size() == kMaxEntries) break;
    entries.push_back({{"term", term}, {"count", count}, {"user_id", terms::lastSearcher(tenant, term)}});
  }
  reply(res, 200, {{"window_hours", kWindowHours}, {"entries", entries}});
}

void register_routes(httplib::Server& svr) { svr.Get("/v1/trending", trending); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "suggest/terms.h"  // terms::currentHour, trendCounts, categoryOf, lastSearcher

using json = nlohmann::json;

constexpr int kWindowHours = 24;
constexpr long long kMinTrendCount = 100;
const std::set<std::string> kSensitiveCategories = {"adult", "health", "person"};
constexpr size_t kMaxEntries = 10;

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void trending(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, {{"error", "X-Tenant-Id is required"}});
  // The last kWindowHours hourly buckets, the current one included: popular now, not ever.
  const auto counts = terms::trendCounts(tenant, terms::currentHour() - kWindowHours + 1);
  std::vector<std::pair<std::string, long long>> ranked(counts.begin(), counts.end());
  std::stable_sort(ranked.begin(), ranked.end(), [](const auto& a, const auto& b) { return a.second > b.second; });
  json entries = json::array();
  for (const auto& [term, count] : ranked) {
    if (entries.size() == kMaxEntries) break;
    if (count < kMinTrendCount || kSensitiveCategories.count(terms::categoryOf(tenant, term))) continue;
    entries.push_back({{"term", term}, {"count", count}});  // an aggregate: nothing that points at a person
  }
  reply(res, 200, {{"window_hours", kWindowHours}, {"entries", entries}});
}

void register_routes(httplib::Server& svr) { svr.Get("/v1/trending", trending); }
`,
    },
  },
  harness: {
    python: `def _hour(ctx):
    return int(ctx.clock.time() // 3600)


def _seed(ctx, hour, counts, tenant="acme"):
    ctx.redis.zadd(f"suggest:trend:{tenant}:{hour}", counts)


def _api(ctx):
    ctx.clock.advance(30 * 86400)  # a month into the clock, so the window has history behind it
    return ctx.client(ctx.load("trending").app)


async def _read(c, tenant="acme"):
    return await c.get("/v1/trending", headers={"X-Tenant-Id": tenant} if tenant else {})


def _entries(r):
    return [(e.get("term"), e.get("count")) for e in r.json().get("entries", [])]


async def check_route(ctx):
    async with _api(ctx) as c:
        now = _hour(ctx)
        _seed(ctx, now, {"kettle": 150, "kettlebell": 120})
        _seed(ctx, now, {"kebab": 500}, tenant="globex")
        r = await _read(c)
        assert r.status_code == 200, f"GET /v1/trending answered {r.status_code}: {r.text}"
        assert r.json().get("window_hours") == 24, f"window_hours is {r.json().get('window_hours')!r}, expected 24"
        assert _entries(r) == [("kettle", 150), ("kettlebell", 120)], f"acme's trends are {_entries(r)}, expected kettle 150, kettlebell 120 (globex's kebab is not acme's)"
        r = await _read(c, tenant=None)
    assert r.status_code == 401, f"a request without X-Tenant-Id answered {r.status_code}, expected 401"


async def check_occurrence_floor(ctx):
    async with _api(ctx) as c:
        _seed(ctx, _hour(ctx), {"kettle": 150, "jane doe": 1, "rare find": 99, "lamp": 100})
        r = await _read(c)
    assert _entries(r) == [("kettle", 150), ("lamp", 100)], f"the rail shows {_entries(r)}, expected kettle and lamp: a term searched fewer than 100 times is not a trend"


async def check_window(ctx):
    async with _api(ctx) as c:
        now = _hour(ctx)
        _seed(ctx, now, {"kettle": 60})
        _seed(ctx, now - 1, {"kettle": 60})
        _seed(ctx, now - 23, {"kettlebell": 110})
        _seed(ctx, now - 24, {"lamp": 500})
        _seed(ctx, now - 48, {"lamp": 500})
        r = await _read(c)
    assert _entries(r) == [("kettle", 120), ("kettlebell", 110)], f"the rail shows {_entries(r)}, expected kettle 120 and kettlebell 110: only the last 24 hourly buckets count, and lamp's searches are older"


async def check_sensitive_filter(ctx):
    async with _api(ctx) as c:
        _seed(ctx, _hour(ctx), {"kettle": 150, "clinic near me": 400, "jane doe": 300, "lamp": 200})
        ctx.redis.hset("suggest:category:acme", mapping={"kettle": "kitchen", "clinic near me": "health", "jane doe": "person", "lamp": "home"})
        r = await _read(c)
    assert _entries(r) == [("lamp", 200), ("kettle", 150)], f"the rail shows {_entries(r)}, expected lamp and kettle: a health term and a person's name never trend"


async def check_no_user_linkage(ctx):
    async with _api(ctx) as c:
        _seed(ctx, _hour(ctx), {"kettle": 150})
        ctx.redis.hset("suggest:searcher:acme", "kettle", "u-17")
        r = await _read(c)
    entries = r.json().get("entries", [])
    assert entries and all(set(e) == {"term", "count"} for e in entries), f"the entries are {entries}: an entry is a term and a count, nothing that ties it to a person"
    assert "u-17" not in r.text, f"the response names user u-17: {r.text}"
`,
    typescript: `function api(ctx) {
  ctx.clock.advance(30 * 86400); // a month into the clock, so the window has history behind it
  return ctx.client(ctx.load('trending').app);
}

const hourOf = ctx => Math.floor(ctx.clock.now() / 3_600_000);

function seed(ctx, hour: number, counts: Record<string, number>, tenant = 'acme'): void {
  for (const [term, count] of Object.entries(counts)) ctx.redis.zadd(\`suggest:trend:\${tenant}:\${hour}\`, count, term);
}

const read = (c, tenant: string | null = 'acme') => c.get('/v1/trending', {headers: tenant === null ? {} : {'X-Tenant-Id': tenant}});

const entriesOf = r => (r.json().entries ?? []).map(e => [e.term, e.count]);

export async function check_route(ctx) {
  const c = api(ctx);
  const now = hourOf(ctx);
  seed(ctx, now, {kettle: 150, kettlebell: 120});
  seed(ctx, now, {kebab: 500}, 'globex');
  let r = await read(c);
  assert.equal(r.status, 200, \`GET /v1/trending answered \${r.status}: \${r.text}\`);
  assert.equal(r.json().window_hours, 24, \`window_hours is \${JSON.stringify(r.json().window_hours)}, expected 24\`);
  assert.deepStrictEqual(entriesOf(r), [['kettle', 150], ['kettlebell', 120]], \`acme's trends are \${JSON.stringify(entriesOf(r))}, expected kettle 150, kettlebell 120 (globex's kebab is not acme's)\`);
  r = await read(c, null);
  assert.equal(r.status, 401, \`a request without X-Tenant-Id answered \${r.status}, expected 401\`);
}

export async function check_occurrence_floor(ctx) {
  const c = api(ctx);
  seed(ctx, hourOf(ctx), {kettle: 150, 'jane doe': 1, 'rare find': 99, lamp: 100});
  const r = await read(c);
  assert.deepStrictEqual(entriesOf(r), [['kettle', 150], ['lamp', 100]], \`the rail shows \${JSON.stringify(entriesOf(r))}, expected kettle and lamp: a term searched fewer than 100 times is not a trend\`);
}

export async function check_window(ctx) {
  const c = api(ctx);
  const now = hourOf(ctx);
  seed(ctx, now, {kettle: 60});
  seed(ctx, now - 1, {kettle: 60});
  seed(ctx, now - 23, {kettlebell: 110});
  seed(ctx, now - 24, {lamp: 500});
  seed(ctx, now - 48, {lamp: 500});
  const r = await read(c);
  assert.deepStrictEqual(entriesOf(r), [['kettle', 120], ['kettlebell', 110]], \`the rail shows \${JSON.stringify(entriesOf(r))}, expected kettle 120 and kettlebell 110: only the last 24 hourly buckets count, and lamp's searches are older\`);
}

export async function check_sensitive_filter(ctx) {
  const c = api(ctx);
  seed(ctx, hourOf(ctx), {kettle: 150, 'clinic near me': 400, 'jane doe': 300, lamp: 200});
  ctx.redis.hset('suggest:category:acme', {kettle: 'kitchen', 'clinic near me': 'health', 'jane doe': 'person', lamp: 'home'});
  const r = await read(c);
  assert.deepStrictEqual(entriesOf(r), [['lamp', 200], ['kettle', 150]], \`the rail shows \${JSON.stringify(entriesOf(r))}, expected lamp and kettle: a health term and a person's name never trend\`);
}

export async function check_no_user_linkage(ctx) {
  const c = api(ctx);
  seed(ctx, hourOf(ctx), {kettle: 150});
  ctx.redis.hset('suggest:searcher:acme', 'kettle', 'u-17');
  const r = await read(c);
  const entries = r.json().entries ?? [];
  assert(entries.length > 0 && entries.every(e => JSON.stringify(Object.keys(e).sort()) === '["count","term"]'), \`the entries are \${JSON.stringify(entries)}: an entry is a term and a count, nothing that ties it to a person\`);
  assert(!r.text.includes('u-17'), \`the response names user u-17: \${r.text}\`);
}
`,
    go: `package main

import (
	"fmt"
	"net/http"
	"strings"

	"leetbuild/harness"
)

func rdAPI(ctx *harness.Ctx) *harness.HTTP {
	ctx.Clock.Advance(30 * 86400) // a month into the clock, so the window has history behind it
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func rdHour(ctx *harness.Ctx) int64 { return ctx.Clock.Now() / 3600000 }

func rdSeed(ctx *harness.Ctx, tenant string, hour int64, counts map[string]int) {
	for term, n := range counts {
		ctx.Redis.Do("ZADD", fmt.Sprintf("suggest:trend:%s:%d", tenant, hour), n, term)
	}
}

func rdRead(c *harness.HTTP) *harness.Response { return c.Get("/v1/trending", "X-Tenant-Id", "acme") }

func rdEntries(r *harness.Response) []string {
	var body struct {
		Entries []struct {
			Term  string \`json:"term"\`
			Count int64  \`json:"count"\`
		} \`json:"entries"\`
	}
	r.Decode(&body)
	out := []string{}
	for _, e := range body.Entries {
		out = append(out, fmt.Sprintf("%s %d", e.Term, e.Count))
	}
	return out
}

func CheckRoute(ctx *harness.Ctx) {
	c := rdAPI(ctx)
	now := rdHour(ctx)
	rdSeed(ctx, "acme", now, map[string]int{"kettle": 150, "kettlebell": 120})
	rdSeed(ctx, "globex", now, map[string]int{"kebab": 500})
	r := rdRead(c)
	ctx.Equal(r.Status, 200, "GET /v1/trending (%s)", r.Text())
	var body struct {
		WindowHours int \`json:"window_hours"\`
	}
	r.Decode(&body)
	ctx.Equal(body.WindowHours, 24, "window_hours")
	ctx.Equal(rdEntries(r), []string{"kettle 150", "kettlebell 120"}, "acme's trends (globex's kebab is not acme's)")
	ctx.Equal(c.Get("/v1/trending").Status, 401, "a request without X-Tenant-Id")
}

func CheckOccurrenceFloor(ctx *harness.Ctx) {
	c := rdAPI(ctx)
	rdSeed(ctx, "acme", rdHour(ctx), map[string]int{"kettle": 150, "jane doe": 1, "rare find": 99, "lamp": 100})
	ctx.Equal(rdEntries(rdRead(c)), []string{"kettle 150", "lamp 100"}, "a term searched fewer than 100 times is not a trend; the rail")
}

func CheckWindow(ctx *harness.Ctx) {
	c := rdAPI(ctx)
	now := rdHour(ctx)
	rdSeed(ctx, "acme", now, map[string]int{"kettle": 60})
	rdSeed(ctx, "acme", now-1, map[string]int{"kettle": 60})
	rdSeed(ctx, "acme", now-23, map[string]int{"kettlebell": 110})
	rdSeed(ctx, "acme", now-24, map[string]int{"lamp": 500})
	rdSeed(ctx, "acme", now-48, map[string]int{"lamp": 500})
	ctx.Equal(rdEntries(rdRead(c)), []string{"kettle 120", "kettlebell 110"}, "only the last 24 hourly buckets count, and lamp's searches are older; the rail")
}

func CheckSensitiveFilter(ctx *harness.Ctx) {
	c := rdAPI(ctx)
	rdSeed(ctx, "acme", rdHour(ctx), map[string]int{"kettle": 150, "clinic near me": 400, "jane doe": 300, "lamp": 200})
	ctx.Redis.Do("HSET", "suggest:category:acme", "kettle", "kitchen", "clinic near me", "health", "jane doe", "person", "lamp", "home")
	ctx.Equal(rdEntries(rdRead(c)), []string{"lamp 200", "kettle 150"}, "a health term and a person's name never trend; the rail")
}

func CheckNoUserLinkage(ctx *harness.Ctx) {
	c := rdAPI(ctx)
	rdSeed(ctx, "acme", rdHour(ctx), map[string]int{"kettle": 150})
	ctx.Redis.Do("HSET", "suggest:searcher:acme", "kettle", "u-17")
	r := rdRead(c)
	var body struct {
		Entries []map[string]any \`json:"entries"\`
	}
	r.Decode(&body)
	ctx.Assert(len(body.Entries) > 0, "the rail is empty: %s", r.Text())
	for _, e := range body.Entries {
		_, hasTerm := e["term"]
		_, hasCount := e["count"]
		ctx.Assert(len(e) == 2 && hasTerm && hasCount, "the entry %v must be a term and a count, nothing that ties it to a person", e)
	}
	ctx.Assert(!strings.Contains(r.Text(), "u-17"), "the response names user u-17: %s", r.Text())
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <map>
#include <string>
#include <vector>

namespace {

harness::HTTP rdAPI(harness::Ctx& ctx) {
  ctx.Clock.Advance(30 * 86400);  // a month into the clock, so the window has history behind it
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

long long rdHour(harness::Ctx& ctx) { return ctx.Clock.Now() / 3600000; }

void rdSeed(harness::Ctx& ctx, long long hour, const std::map<std::string, int>& counts, const std::string& tenant = "acme") {
  for (const auto& [term, n] : counts) ctx.Redis.Must({"ZADD", "suggest:trend:" + tenant + ":" + std::to_string(hour), std::to_string(n), term});
}

harness::Response rdRead(harness::HTTP& c) { return c.Get("/v1/trending", "X-Tenant-Id", "acme"); }

std::vector<std::string> rdEntries(const harness::Response& r) {
  std::vector<std::string> out;
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  if (!body.is_object() || !body.contains("entries")) return out;
  for (const auto& e : body["entries"]) out.push_back(e.value("term", "") + " " + std::to_string(e.value("count", 0LL)));
  return out;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = rdAPI(ctx);
  const long long now = rdHour(ctx);
  rdSeed(ctx, now, {{"kettle", 150}, {"kettlebell", 120}});
  rdSeed(ctx, now, {{"kebab", 500}}, "globex");
  const auto r = rdRead(c);
  ctx.Equal(r.Status, 200, "GET /v1/trending (%s)", r.Text());
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  ctx.Equal(body.is_object() ? body.value("window_hours", 0) : 0, 24, "window_hours");
  ctx.Equal(rdEntries(r), {"kettle 150", "kettlebell 120"}, "acme's trends (globex's kebab is not acme's)");
  ctx.Equal(c.Get("/v1/trending").Status, 401, "a request without X-Tenant-Id");
}

void CheckOccurrenceFloor(harness::Ctx& ctx) {
  auto c = rdAPI(ctx);
  rdSeed(ctx, rdHour(ctx), {{"kettle", 150}, {"jane doe", 1}, {"rare find", 99}, {"lamp", 100}});
  ctx.Equal(rdEntries(rdRead(c)), {"kettle 150", "lamp 100"}, "a term searched fewer than 100 times is not a trend; the rail");
}

void CheckWindow(harness::Ctx& ctx) {
  auto c = rdAPI(ctx);
  const long long now = rdHour(ctx);
  rdSeed(ctx, now, {{"kettle", 60}});
  rdSeed(ctx, now - 1, {{"kettle", 60}});
  rdSeed(ctx, now - 23, {{"kettlebell", 110}});
  rdSeed(ctx, now - 24, {{"lamp", 500}});
  rdSeed(ctx, now - 48, {{"lamp", 500}});
  ctx.Equal(rdEntries(rdRead(c)), {"kettle 120", "kettlebell 110"}, "only the last 24 hourly buckets count, and lamp's searches are older; the rail");
}

void CheckSensitiveFilter(harness::Ctx& ctx) {
  auto c = rdAPI(ctx);
  rdSeed(ctx, rdHour(ctx), {{"kettle", 150}, {"clinic near me", 400}, {"jane doe", 300}, {"lamp", 200}});
  ctx.Redis.Must({"HSET", "suggest:category:acme", "kettle", "kitchen", "clinic near me", "health", "jane doe", "person", "lamp", "home"});
  ctx.Equal(rdEntries(rdRead(c)), {"lamp 200", "kettle 150"}, "a health term and a person's name never trend; the rail");
}

void CheckNoUserLinkage(harness::Ctx& ctx) {
  auto c = rdAPI(ctx);
  rdSeed(ctx, rdHour(ctx), {{"kettle", 150}});
  ctx.Redis.Must({"HSET", "suggest:searcher:acme", "kettle", "u-17"});
  const auto r = rdRead(c);
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  ctx.Assert(body.is_object() && body.contains("entries") && !body["entries"].empty(), "the rail is empty: %s", r.Text());
  for (const auto& e : body["entries"]) {
    ctx.Assert(e.size() == 2 && e.contains("term") && e.contains("count"), "the entry %s must be a term and a count, nothing that ties it to a person", e.dump());
  }
  ctx.Assert(r.Text().find("u-17") == std::string::npos, "the response names user u-17: %s", r.Text());
}
`,
  },
  hints: [
    "Search a name once and open the trending rail: it is there, next to the id of the person who searched it. Last month's peak and a clinic's name sit above this week's terms.",
    '`trend_counts(tenant, 0)` sums every bucket since the epoch, every count is accepted, nothing looks at `category_of`, and each entry copies `last_searcher` into the response.',
    'Pass `current_hour() - WINDOW_HOURS + 1`; skip a term under `MIN_TREND_COUNT` or whose `category_of` is in `SENSITIVE_CATEGORIES`; append `{"term", "count"}` only; cut to `MAX_ENTRIES` after the filter.',
  ],
  debrief: `A trend is a claim about many people, and each rule here protects that claim: the window says when, the floor says how many, and the category filter keeps out what should not be announced however many searched it. Dropping the user id is the same rule seen from the other side: an aggregate that names a contributor is not an aggregate. Filtering before the top-ten cut keeps a removed term from costing the rail a slot. Production rails count distinct users rather than searches, so one bot repeating a name cannot reach the floor, and send a term that newly crosses it to a review queue before it is shown.`,
};
