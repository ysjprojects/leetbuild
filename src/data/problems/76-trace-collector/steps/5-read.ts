import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/traces/{id}: the trace with its gaps',
  concept: 'http',
  guides: ['honest-reads', 'request-boundaries'],
  file: 'read',
  focus: ['reader', 'collector', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/traces/{trace_id}\` for the on-call reader: it
requires \`X-Tenant-Id\` (401), loads the trace with \`assembly.load_trace\` (404 when there is none),
keeps the spans whose parent is present, gives each a \`start_ms\` relative to the earliest one and
answers \`{trace_id, root_span_id, partial: false, gaps: [], spans}\`. The tree looks tidy because
whatever did not fit is gone; it hides four flaws.

**Failure mode the checks target.** An incident review is misled by a trace that looks complete: a
span whose parent did not arrive is not shown, nothing says the trace is partial, and the timeline
cannot be lined up with a log line. And any tenant can read any trace.

- A trace whose \`owner\` is not the caller is **404**, the same answer as a trace that does not
  exist.
- Every stored span is in \`spans\`. Each parent id a span names that is not in the trace is in
  \`gaps\` as \`{parent_span_id, waiting}\` (how many spans name it), ordered by \`parent_span_id\`.
- \`partial\` is \`true\` when \`gaps\` is not empty.
- Each span carries its absolute \`start_ms\`, its \`duration_ms\` and \`end_ms\` = \`start_ms +
  duration_ms\`.`,
  sequence: {
    participants: ['Trace reader', 'Trace Collector', 'Redis'],
    messages: [
      {from: 'Trace reader', to: 'Trace Collector', label: 'GET /v1/traces/{id} · X-Tenant-Id', kind: 'sync'},
      {from: 'Trace Collector', to: 'Redis', label: 'load_trace(id)', kind: 'sync'},
      {from: 'Redis', to: 'Trace Collector', label: '{owner, root, spans}', kind: 'reply'},
      {
        from: 'Trace Collector',
        to: 'Trace Collector',
        label: 'owner ≠ tenant → 404 · gaps = parents not in the trace',
        kind: 'sync',
      },
      {
        from: 'Trace Collector',
        to: 'Trace reader',
        label: '200 {root_span_id, partial, gaps, spans[start_ms, end_ms]}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Serves GET /v1/traces/{trace_id}',
      detail:
        'Register `GET /v1/traces/{trace_id}` and answer a stored trace from `load_trace`/`loadTrace` with its root and spans.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/traces\/\{trace_id\}["']/, /assembly\.load_trace\(/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/traces\/:trace_id['"]/, /loadTrace\(/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/traces\/\{trace_id\}"/, /assembly\.LoadTrace\(/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"traces"\s*\/\s*Segment\s*\)/, /Assembly\.loadTrace\(/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/traces\//, /assembly::loadTrace\(/]},
      },
    },
    {
      id: 'tenant-scope',
      title: "Another tenant's trace is 404",
      detail:
        "The trace's `owner` is compared with the caller and a foreign trace answers **404**, so the read path neither serves nor confirms another tenant's traces; the starter serves any trace to any tenant.",
      match: {
        python: {all: [/["']owner["']\]\s*!=\s*tenant|tenant\s*!=\s*\w+\[["']owner["']\]/]},
        typescript: {all: [/owner\s*!==\s*tenant|tenant\s*!==\s*\w+\.owner/]},
        go: {all: [/Owner\s*!=\s*tenant|tenant\s*!=\s*\w+\.Owner/]},
        scala: {all: [/owner\s*!=\s*tenant|tenant\s*!=\s*\w+\.owner/]},
        cpp: {all: [/owner\s*!=\s*tenant|tenant\s*!=\s*\w+(->|\.)owner/]},
      },
    },
    {
      id: 'gaps-visible',
      title: 'Every span is shown, and the missing parents are gaps',
      detail:
        'No stored span is filtered out; each parent id that is not in the trace is reported in `gaps` with how many spans are `waiting` for it. The starter drops those spans, so the tree looks shorter and complete.',
      match: {
        python: {all: [/waiting/], none: [/["']gaps["']\s*:\s*\[\]/]},
        typescript: {all: [/waiting/], none: [/gaps:\s*\[\]/]},
        go: {all: [/waiting/], none: [/"gaps":\s*\[\]gap\{\}/]},
        scala: {all: [/waiting/], none: [/"gaps"\s*->\s*JsArray\(\)/]},
        cpp: {all: [/waiting/], none: [/\{"gaps",\s*json::array\(\)\}/]},
      },
    },
    {
      id: 'partial-marker',
      title: 'A trace with gaps is marked partial',
      detail:
        '`partial` follows the gaps: `true` when a parent is missing. The starter answers `partial: false` for every trace.',
      match: {
        python: {all: [/["']partial["']/], none: [/["']partial["']\s*:\s*False/]},
        typescript: {all: [/partial/], none: [/partial:\s*false/]},
        go: {all: [/"partial"/], none: [/"partial":\s*false/]},
        scala: {all: [/"partial"/], none: [/"partial"\s*->\s*(JsBoolean\(false\)|JsFalse)/]},
        cpp: {all: [/"partial"/], none: [/\{"partial",\s*false\}/]},
      },
    },
    {
      id: 'absolute-timestamps',
      title: 'Spans carry absolute start and end times',
      detail:
        'Each span reports the `start_ms` it was ingested with and `end_ms` = `start_ms + duration_ms`, so a span can be lined up with logs and deploys; the starter reports offsets from the earliest span.',
      match: {
        python: {all: [/end_ms/], none: [/-\s*origin/]},
        typescript: {all: [/end_ms/], none: [/-\s*origin/]},
        go: {all: [/end_ms/], none: [/-\s*origin/]},
        scala: {all: [/end_ms/], none: [/-\s*origin/]},
        cpp: {all: [/end_ms/], none: [/-\s*origin/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from traces import assembly  # load_trace(trace_id) -> {trace_id, owner, root, count, missing, extra_roots, spans} | None

app = FastAPI()


@app.get("/v1/traces/{trace_id}")
def read_trace(trace_id: str, request: Request) -> JSONResponse:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        return JSONResponse({"error": "X-Tenant-Id is required"}, status_code=401)
    trace = assembly.load_trace(trace_id)
    if trace is None:
        return JSONResponse({"error": "no such trace"}, status_code=404)
    ids = {s["span_id"] for s in trace["spans"]}
    shown = [s for s in trace["spans"] if not s["parent_span_id"] or s["parent_span_id"] in ids]
    origin = min((s["start_ms"] for s in shown), default=0)
    spans = [
        {"span_id": s["span_id"], "parent_span_id": s["parent_span_id"], "service": s["service"], "start_ms": s["start_ms"] - origin, "duration_ms": s["duration_ms"]}
        for s in shown
    ]
    return JSONResponse({"trace_id": trace_id, "root_span_id": trace["root"], "partial": False, "gaps": [], "spans": spans})
`,
      solution: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from traces import assembly  # load_trace(trace_id) -> {trace_id, owner, root, count, missing, extra_roots, spans} | None

app = FastAPI()


def gaps_of(spans: list[dict]) -> list[dict]:
    """Every parent id a span names that is not in the trace, with how many spans wait for it."""
    ids = {s["span_id"] for s in spans}
    waiting: dict[str, int] = {}
    for s in spans:
        parent = s["parent_span_id"]
        if parent and parent not in ids:
            waiting[parent] = waiting.get(parent, 0) + 1
    return [{"parent_span_id": parent, "waiting": n} for parent, n in sorted(waiting.items())]


@app.get("/v1/traces/{trace_id}")
def read_trace(trace_id: str, request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        return JSONResponse({"error": "X-Tenant-Id is required"}, status_code=401)
    trace = assembly.load_trace(trace_id)
    # Another tenant's trace answers exactly as a missing one: the endpoint confirms nothing.
    if trace is None or trace["owner"] != tenant:
        return JSONResponse({"error": "no such trace"}, status_code=404)
    gaps = gaps_of(trace["spans"])
    spans = [
        {
            "span_id": s["span_id"],
            "parent_span_id": s["parent_span_id"],
            "service": s["service"],
            "start_ms": s["start_ms"],
            "duration_ms": s["duration_ms"],
            "end_ms": s["start_ms"] + s["duration_ms"],
        }
        for s in trace["spans"]
    ]
    return JSONResponse({"trace_id": trace_id, "root_span_id": trace["root"], "partial": bool(gaps), "gaps": gaps, "spans": spans})
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {loadTrace} from 'traces/assembly';

export const app = Fastify();

app.get('/v1/traces/:trace_id', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {trace_id} = request.params as {trace_id: string};
  const trace = await loadTrace(trace_id);
  if (trace === null) return reply.code(404).send({error: 'no such trace'});
  const ids = new Set(trace.spans.map(s => s.span_id));
  const shown = trace.spans.filter(s => s.parent_span_id === '' || ids.has(s.parent_span_id));
  const origin = Math.min(...shown.map(s => s.start_ms));
  const spans = shown.map(s => ({span_id: s.span_id, parent_span_id: s.parent_span_id, service: s.service, start_ms: s.start_ms - origin, duration_ms: s.duration_ms}));
  return {trace_id, root_span_id: trace.root, partial: false, gaps: [], spans};
});
`,
      solution: `import Fastify from 'fastify';

import {type Span, loadTrace} from 'traces/assembly';

export const app = Fastify();

/** Every parent id a span names that is not in the trace, with how many spans wait for it. */
export function gapsOf(spans: Span[]): {parent_span_id: string; waiting: number}[] {
  const ids = new Set(spans.map(s => s.span_id));
  const waiting = new Map<string, number>();
  for (const s of spans) {
    if (s.parent_span_id !== '' && !ids.has(s.parent_span_id)) waiting.set(s.parent_span_id, (waiting.get(s.parent_span_id) ?? 0) + 1);
  }
  return [...waiting.keys()].sort().map(parent => ({parent_span_id: parent, waiting: waiting.get(parent) ?? 0}));
}

app.get('/v1/traces/:trace_id', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {trace_id} = request.params as {trace_id: string};
  const trace = await loadTrace(trace_id);
  // Another tenant's trace answers exactly as a missing one: the endpoint confirms nothing.
  if (trace === null || trace.owner !== tenant) return reply.code(404).send({error: 'no such trace'});
  const gaps = gapsOf(trace.spans);
  const spans = trace.spans.map(s => ({
    span_id: s.span_id,
    parent_span_id: s.parent_span_id,
    service: s.service,
    start_ms: s.start_ms,
    duration_ms: s.duration_ms,
    end_ms: s.start_ms + s.duration_ms,
  }));
  return {trace_id, root_span_id: trace.root, partial: gaps.length > 0, gaps, spans};
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"traces/assembly" // assembly.LoadTrace(ctx, traceID) (*Trace, error)
)

type gap struct {
	ParentSpanID string \`json:"parent_span_id"\`
	Waiting      int    \`json:"waiting"\`
}

type spanOut struct {
	SpanID       string \`json:"span_id"\`
	ParentSpanID string \`json:"parent_span_id"\`
	Service      string \`json:"service"\`
	StartMs      int64  \`json:"start_ms"\`
	DurationMs   int64  \`json:"duration_ms"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func readTrace(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	traceID := r.PathValue("trace_id")
	trace, err := assembly.LoadTrace(r.Context(), traceID)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	if trace == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such trace"})
		return
	}
	ids := map[string]bool{}
	for _, s := range trace.Spans {
		ids[s.SpanID] = true
	}
	shown := []assembly.Span{}
	for _, s := range trace.Spans {
		if s.ParentSpanID == "" || ids[s.ParentSpanID] {
			shown = append(shown, s)
		}
	}
	var origin int64
	for i, s := range shown {
		if i == 0 || s.StartMs < origin {
			origin = s.StartMs
		}
	}
	spans := []spanOut{}
	for _, s := range shown {
		spans = append(spans, spanOut{SpanID: s.SpanID, ParentSpanID: s.ParentSpanID, Service: s.Service, StartMs: s.StartMs - origin, DurationMs: s.DurationMs})
	}
	writeJSON(rw, http.StatusOK, map[string]any{"trace_id": traceID, "root_span_id": trace.Root, "partial": false, "gaps": []gap{}, "spans": spans})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/traces/{trace_id}", readTrace)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"sort"

	"traces/assembly" // assembly.LoadTrace(ctx, traceID) (*Trace, error)
)

type gap struct {
	ParentSpanID string \`json:"parent_span_id"\`
	Waiting      int    \`json:"waiting"\`
}

type spanOut struct {
	SpanID       string \`json:"span_id"\`
	ParentSpanID string \`json:"parent_span_id"\`
	Service      string \`json:"service"\`
	StartMs      int64  \`json:"start_ms"\`
	DurationMs   int64  \`json:"duration_ms"\`
	EndMs        int64  \`json:"end_ms"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

// gapsOf is every parent id a span names that is not in the trace, with how many spans wait for it.
func gapsOf(spans []assembly.Span) []gap {
	ids := map[string]bool{}
	for _, s := range spans {
		ids[s.SpanID] = true
	}
	waiting := map[string]int{}
	for _, s := range spans {
		if s.ParentSpanID != "" && !ids[s.ParentSpanID] {
			waiting[s.ParentSpanID]++
		}
	}
	gaps := []gap{}
	for parent, n := range waiting {
		gaps = append(gaps, gap{ParentSpanID: parent, Waiting: n})
	}
	sort.Slice(gaps, func(i, j int) bool { return gaps[i].ParentSpanID < gaps[j].ParentSpanID })
	return gaps
}

func readTrace(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	traceID := r.PathValue("trace_id")
	trace, err := assembly.LoadTrace(r.Context(), traceID)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	// Another tenant's trace answers exactly as a missing one: the endpoint confirms nothing.
	if trace == nil || trace.Owner != tenant {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such trace"})
		return
	}
	gaps := gapsOf(trace.Spans)
	spans := []spanOut{}
	for _, s := range trace.Spans {
		spans = append(spans, spanOut{SpanID: s.SpanID, ParentSpanID: s.ParentSpanID, Service: s.Service, StartMs: s.StartMs, DurationMs: s.DurationMs, EndMs: s.StartMs + s.DurationMs})
	}
	writeJSON(rw, http.StatusOK, map[string]any{"trace_id": traceID, "root_span_id": trace.Root, "partial": len(gaps) > 0, "gaps": gaps, "spans": spans})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/traces/{trace_id}", readTrace)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import traces.Assembly // Assembly.loadTrace(traceId): Option[Trace]

object ReadApi {
  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  val route: Route = path("v1" / "traces" / Segment) { traceId =>
    get {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(error(StatusCodes.Unauthorized, "X-Tenant-Id is required"))
        case Some(tenant) =>
          // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
          Assembly.loadTrace(traceId) match {
            case None => complete(error(StatusCodes.NotFound, "no such trace"))
            case Some(trace) =>
              val ids = trace.spans.map(_.spanId).toSet
              val shown = trace.spans.filter(s => s.parentSpanId.isEmpty || ids(s.parentSpanId))
              val origin = if (shown.isEmpty) 0L else shown.map(_.startMs).min
              val spans = shown.map { s =>
                JsObject("span_id" -> JsString(s.spanId), "parent_span_id" -> JsString(s.parentSpanId), "service" -> JsString(s.service),
                  "start_ms" -> JsNumber(s.startMs - origin), "duration_ms" -> JsNumber(s.durationMs))
              }
              complete(json(StatusCodes.OK, JsObject("trace_id" -> JsString(traceId), "root_span_id" -> JsString(trace.root), "partial" -> JsBoolean(false),
                "gaps" -> JsArray(), "spans" -> JsArray(spans.toVector))))
          }
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import traces.Assembly // Assembly.loadTrace(traceId): Option[Trace]

object ReadApi {
  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  /** Every parent id a span names that is not in the trace, with how many spans wait for it. */
  def gapsOf(spans: Seq[Assembly.Span]): Seq[JsObject] = {
    val ids = spans.map(_.spanId).toSet
    spans.map(_.parentSpanId).filter(parent => parent.nonEmpty && !ids(parent)).groupBy(identity).toSeq.sortBy(_._1).map { case (parent, waiting) =>
      JsObject("parent_span_id" -> JsString(parent), "waiting" -> JsNumber(waiting.size))
    }
  }

  val route: Route = path("v1" / "traces" / Segment) { traceId =>
    get {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(error(StatusCodes.Unauthorized, "X-Tenant-Id is required"))
        case Some(tenant) =>
          Assembly.loadTrace(traceId) match {
            // Another tenant's trace answers exactly as a missing one: the endpoint confirms nothing.
            case None => complete(error(StatusCodes.NotFound, "no such trace"))
            case Some(trace) if trace.owner != tenant => complete(error(StatusCodes.NotFound, "no such trace"))
            case Some(trace) =>
              val gaps = gapsOf(trace.spans)
              val spans = trace.spans.map { s =>
                JsObject("span_id" -> JsString(s.spanId), "parent_span_id" -> JsString(s.parentSpanId), "service" -> JsString(s.service),
                  "start_ms" -> JsNumber(s.startMs), "duration_ms" -> JsNumber(s.durationMs), "end_ms" -> JsNumber(s.startMs + s.durationMs))
              }
              complete(json(StatusCodes.OK, JsObject("trace_id" -> JsString(traceId), "root_span_id" -> JsString(trace.root), "partial" -> JsBoolean(gaps.nonEmpty),
                "gaps" -> JsArray(gaps.toVector), "spans" -> JsArray(spans.toVector))))
          }
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
#include <set>
#include <string>
#include <vector>

#include "traces/assembly.h"  // assembly::loadTrace(trace_id) -> std::optional<Trace>

using json = nlohmann::json;

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void read_trace(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, {{"error", "X-Tenant-Id is required"}});
  const std::string trace_id = req.matches[1];
  const auto trace = assembly::loadTrace(trace_id);
  if (!trace) return reply(res, 404, {{"error", "no such trace"}});
  std::set<std::string> ids;
  for (const auto& s : trace->spans) ids.insert(s.span_id);
  std::vector<assembly::Span> shown;
  for (const auto& s : trace->spans) {
    if (s.parent_span_id.empty() || ids.count(s.parent_span_id)) shown.push_back(s);
  }
  long long origin = shown.empty() ? 0 : shown.front().start_ms;
  for (const auto& s : shown) origin = std::min(origin, s.start_ms);
  json spans = json::array();
  for (const auto& s : shown) {
    spans.push_back({{"span_id", s.span_id}, {"parent_span_id", s.parent_span_id}, {"service", s.service}, {"start_ms", s.start_ms - origin}, {"duration_ms", s.duration_ms}});
  }
  reply(res, 200, {{"trace_id", trace_id}, {"root_span_id", trace->root}, {"partial", false}, {"gaps", json::array()}, {"spans", spans}});
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/traces/([\\w-]+))", read_trace); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <map>
#include <set>
#include <string>
#include <vector>

#include "traces/assembly.h"  // assembly::loadTrace(trace_id) -> std::optional<Trace>

using json = nlohmann::json;

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

// Every parent id a span names that is not in the trace, with how many spans wait for it.
json gaps_of(const std::vector<assembly::Span>& spans) {
  std::set<std::string> ids;
  for (const auto& s : spans) ids.insert(s.span_id);
  std::map<std::string, int> waiting;
  for (const auto& s : spans) {
    if (!s.parent_span_id.empty() && !ids.count(s.parent_span_id)) waiting[s.parent_span_id]++;
  }
  json gaps = json::array();
  for (const auto& [parent, n] : waiting) gaps.push_back({{"parent_span_id", parent}, {"waiting", n}});
  return gaps;
}

void read_trace(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, {{"error", "X-Tenant-Id is required"}});
  const std::string trace_id = req.matches[1];
  const auto trace = assembly::loadTrace(trace_id);
  // Another tenant's trace answers exactly as a missing one: the endpoint confirms nothing.
  if (!trace || trace->owner != tenant) return reply(res, 404, {{"error", "no such trace"}});
  const json gaps = gaps_of(trace->spans);
  json spans = json::array();
  for (const auto& s : trace->spans) {
    spans.push_back({{"span_id", s.span_id}, {"parent_span_id", s.parent_span_id}, {"service", s.service}, {"start_ms", s.start_ms}, {"duration_ms", s.duration_ms},
                     {"end_ms", s.start_ms + s.duration_ms}});
  }
  reply(res, 200, {{"trace_id", trace_id}, {"root_span_id", trace->root}, {"partial", !gaps.empty()}, {"gaps", gaps}, {"spans", spans}});
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/traces/([\\w-]+))", read_trace); }
`,
    },
  },
  harness: {
    python: `from traces import assembly

TRACE = "4bf92f3577b34da6a3ce929d0e0e4736"
OTHER = "5c0a3f4688c45eb7b4df03af1f1f5847"
ROOT = "00f067aa0ba902b7"
PAY = "00f067aa0ba902b8"
ORPHAN = "00f067aa0ba902b9"
NEVER = "00f067aa0ba902ba"
T0 = 1712345678901


def _seed(trace_id=TRACE, tenant="acme", orphan=True):
    assembly.insert_span(tenant, {"trace_id": trace_id, "span_id": ROOT, "parent_span_id": "", "service": "checkout", "start_ms": T0, "duration_ms": 412})
    assembly.insert_span(tenant, {"trace_id": trace_id, "span_id": PAY, "parent_span_id": ROOT, "service": "payments", "start_ms": T0 + 40, "duration_ms": 120})
    if orphan:
        assembly.insert_span(tenant, {"trace_id": trace_id, "span_id": ORPHAN, "parent_span_id": NEVER, "service": "inventory", "start_ms": T0 + 60, "duration_ms": 30})


def _api(ctx):
    return ctx.client(ctx.load("read").app)


async def _get(c, trace_id=TRACE, tenant="acme"):
    r = await c.get(f"/v1/traces/{trace_id}", headers={"X-Tenant-Id": tenant})
    return r


async def _ok(c, trace_id=TRACE):
    r = await _get(c, trace_id)
    assert r.status_code == 200, f"GET /v1/traces/{trace_id} by its owner answered {r.status_code}: {r.text}"
    return r.json()


async def check_route(ctx):
    _seed(orphan=False)
    async with _api(ctx) as c:
        body = await _ok(c)
    assert body.get("root_span_id") == ROOT, f"the trace's root is {ROOT}, the read answered {body}"
    assert [s.get("span_id") for s in body.get("spans", [])] == [ROOT, PAY], f"the read must list both spans in start order, got {body.get('spans')}"


async def check_tenant_scope(ctx):
    _seed()
    async with _api(ctx) as c:
        foreign = await _get(c, tenant="globex")
        missing = await _get(c, trace_id=OTHER, tenant="globex")
        own = await _get(c)
    assert foreign.status_code == 404, f"tenant globex read acme's trace and got {foreign.status_code}: {foreign.text}. A trace owned by another tenant is 404"
    assert "checkout" not in foreign.text, f"the 404 for another tenant's trace leaks its content: {foreign.text}"
    assert missing.status_code == 404, f"a trace that does not exist answered {missing.status_code}"
    assert own.status_code == 200, f"the owner reading its trace answered {own.status_code}: {own.text}"


async def check_gaps_visible(ctx):
    _seed()
    async with _api(ctx) as c:
        body = await _ok(c)
    ids = [s.get("span_id") for s in body.get("spans", [])]
    assert ORPHAN in ids, f"span {ORPHAN} names a parent that never arrived and the read dropped it: spans {ids}. Every stored span must be shown"
    assert body.get("gaps") == [{"parent_span_id": NEVER, "waiting": 1}], f"the parent {NEVER} never arrived and one span waits for it: gaps must be [{{parent_span_id: {NEVER}, waiting: 1}}], got {body.get('gaps')}"


async def check_partial_marker(ctx):
    _seed()
    _seed(trace_id=OTHER, orphan=False)
    async with _api(ctx) as c:
        partial = await _ok(c)
        whole = await _ok(c, OTHER)
    assert partial.get("partial") is True, f"a trace with a missing parent was answered partial {partial.get('partial')!r}: it must say true"
    assert whole.get("partial") is False, f"a trace with every parent present was answered partial {whole.get('partial')!r}"


async def check_absolute_timestamps(ctx):
    _seed(orphan=False)
    async with _api(ctx) as c:
        body = await _ok(c)
    want = {ROOT: (T0, 412), PAY: (T0 + 40, 120)}
    for span in body.get("spans", []):
        start, duration = want[span["span_id"]]
        assert span.get("start_ms") == start, f"span {span['span_id']} was ingested with start_ms {start} and the read answers {span.get('start_ms')}: report the absolute time, not an offset"
        assert span.get("end_ms") == start + duration, f"span {span['span_id']} must carry end_ms = start_ms + duration_ms = {start + duration}, got {span.get('end_ms')}"
`,
    typescript: `const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const OTHER = '5c0a3f4688c45eb7b4df03af1f1f5847';
const ROOT = '00f067aa0ba902b7';
const PAY = '00f067aa0ba902b8';
const ORPHAN = '00f067aa0ba902b9';
const NEVER = '00f067aa0ba902ba';
const T0 = 1712345678901;

async function seed(ctx, trace_id = TRACE, orphan = true) {
  const assembly = ctx.load('/support/traces/assembly.ts');
  await assembly.insertSpan('acme', {trace_id, span_id: ROOT, parent_span_id: '', service: 'checkout', start_ms: T0, duration_ms: 412});
  await assembly.insertSpan('acme', {trace_id, span_id: PAY, parent_span_id: ROOT, service: 'payments', start_ms: T0 + 40, duration_ms: 120});
  if (orphan) await assembly.insertSpan('acme', {trace_id, span_id: ORPHAN, parent_span_id: NEVER, service: 'inventory', start_ms: T0 + 60, duration_ms: 30});
}

const api = ctx => ctx.client(ctx.load('read').app);
const get = (c, traceId = TRACE, tenant = 'acme') => c.get(\`/v1/traces/\${traceId}\`, {headers: {'X-Tenant-Id': tenant}});

async function ok(c, traceId = TRACE) {
  const r = await get(c, traceId);
  assert.equal(r.status, 200, \`GET /v1/traces/\${traceId} by its owner answered \${r.status}: \${r.text}\`);
  return r.json();
}

export async function check_route(ctx) {
  await seed(ctx, TRACE, false);
  const body = await ok(api(ctx));
  assert.equal(body.root_span_id, ROOT, \`the trace's root is \${ROOT}, the read answered \${JSON.stringify(body)}\`);
  assert.deepStrictEqual((body.spans ?? []).map(s => s.span_id), [ROOT, PAY], \`the read must list both spans in start order, got \${JSON.stringify(body.spans)}\`);
}

export async function check_tenant_scope(ctx) {
  await seed(ctx);
  const c = api(ctx);
  const foreign = await get(c, TRACE, 'globex');
  const missing = await get(c, OTHER, 'globex');
  const own = await get(c);
  assert.equal(foreign.status, 404, \`tenant globex read acme's trace and got \${foreign.status}: \${foreign.text}. A trace owned by another tenant is 404\`);
  assert(!foreign.text.includes('checkout'), \`the 404 for another tenant's trace leaks its content: \${foreign.text}\`);
  assert.equal(missing.status, 404, \`a trace that does not exist answered \${missing.status}\`);
  assert.equal(own.status, 200, \`the owner reading its trace answered \${own.status}: \${own.text}\`);
}

export async function check_gaps_visible(ctx) {
  await seed(ctx);
  const body = await ok(api(ctx));
  const ids = (body.spans ?? []).map(s => s.span_id);
  assert(ids.includes(ORPHAN), \`span \${ORPHAN} names a parent that never arrived and the read dropped it: spans \${JSON.stringify(ids)}. Every stored span must be shown\`);
  assert.deepStrictEqual(body.gaps, [{parent_span_id: NEVER, waiting: 1}], \`the parent \${NEVER} never arrived and one span waits for it: gaps must list it with waiting 1, got \${JSON.stringify(body.gaps)}\`);
}

export async function check_partial_marker(ctx) {
  await seed(ctx);
  await seed(ctx, OTHER, false);
  const c = api(ctx);
  const partial = await ok(c);
  const whole = await ok(c, OTHER);
  assert.equal(partial.partial, true, \`a trace with a missing parent was answered partial \${JSON.stringify(partial.partial)}: it must say true\`);
  assert.equal(whole.partial, false, \`a trace with every parent present was answered partial \${JSON.stringify(whole.partial)}\`);
}

export async function check_absolute_timestamps(ctx) {
  await seed(ctx, TRACE, false);
  const body = await ok(api(ctx));
  const want: Record<string, [number, number]> = {[ROOT]: [T0, 412], [PAY]: [T0 + 40, 120]};
  for (const span of body.spans ?? []) {
    const [start, duration] = want[span.span_id];
    assert.equal(span.start_ms, start, \`span \${span.span_id} was ingested with start_ms \${start} and the read answers \${span.start_ms}: report the absolute time, not an offset\`);
    assert.equal(span.end_ms, start + duration, \`span \${span.span_id} must carry end_ms = start_ms + duration_ms = \${start + duration}, got \${span.end_ms}\`);
  }
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"strings"

	"traces/assembly"

	"leetbuild/harness"
)

const (
	rdTrace  = "4bf92f3577b34da6a3ce929d0e0e4736"
	rdOther  = "5c0a3f4688c45eb7b4df03af1f1f5847"
	rdRoot   = "00f067aa0ba902b7"
	rdPay    = "00f067aa0ba902b8"
	rdOrphan = "00f067aa0ba902b9"
	rdNever  = "00f067aa0ba902ba"
	rdT0     = int64(1712345678901)
)

type readBody struct {
	RootSpanID string \`json:"root_span_id"\`
	Partial    *bool  \`json:"partial"\`
	Gaps       []gap  \`json:"gaps"\`
	Spans      []struct {
		SpanID  string \`json:"span_id"\`
		StartMs int64  \`json:"start_ms"\`
		EndMs   *int64 \`json:"end_ms"\`
	} \`json:"spans"\`
}

func rdSeed(ctx *harness.Ctx, traceID string, orphan bool) {
	spans := []assembly.Span{
		{TraceID: traceID, SpanID: rdRoot, Service: "checkout", StartMs: rdT0, DurationMs: 412},
		{TraceID: traceID, SpanID: rdPay, ParentSpanID: rdRoot, Service: "payments", StartMs: rdT0 + 40, DurationMs: 120},
	}
	if orphan {
		spans = append(spans, assembly.Span{TraceID: traceID, SpanID: rdOrphan, ParentSpanID: rdNever, Service: "inventory", StartMs: rdT0 + 60, DurationMs: 30})
	}
	for _, s := range spans {
		_, err := assembly.InsertSpan(context.Background(), "acme", s)
		ctx.NoError(err, "seeding span %s", s.SpanID)
	}
}

func rdAPI(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func rdGet(c *harness.HTTP, traceID, tenant string) *harness.Response {
	return c.Get("/v1/traces/"+traceID, "X-Tenant-Id", tenant)
}

func rdOK(ctx *harness.Ctx, c *harness.HTTP, traceID string) readBody {
	r := rdGet(c, traceID, "acme")
	ctx.Equal(r.Status, 200, "GET /v1/traces/%s by its owner (%s)", traceID, r.Text())
	var body readBody
	r.Decode(&body)
	return body
}

func spanIDs(body readBody) []string {
	ids := []string{}
	for _, s := range body.Spans {
		ids = append(ids, s.SpanID)
	}
	return ids
}

func CheckRoute(ctx *harness.Ctx) {
	rdSeed(ctx, rdTrace, false)
	body := rdOK(ctx, rdAPI(ctx), rdTrace)
	ctx.Equal(body.RootSpanID, rdRoot, "the trace's root_span_id")
	ctx.Equal(spanIDs(body), []string{rdRoot, rdPay}, "the read must list both spans in start order; the span ids")
}

func CheckTenantScope(ctx *harness.Ctx) {
	rdSeed(ctx, rdTrace, true)
	c := rdAPI(ctx)
	foreign := rdGet(c, rdTrace, "globex")
	ctx.Equal(foreign.Status, 404, "tenant globex read acme's trace (%s): a trace owned by another tenant is 404", foreign.Text())
	ctx.Assert(!strings.Contains(foreign.Text(), "checkout"), "the 404 for another tenant's trace leaks its content: %s", foreign.Text())
	ctx.Equal(rdGet(c, rdOther, "globex").Status, 404, "a trace that does not exist")
	own := rdGet(c, rdTrace, "acme")
	ctx.Equal(own.Status, 200, "the owner reading its trace (%s)", own.Text())
}

func CheckGapsVisible(ctx *harness.Ctx) {
	rdSeed(ctx, rdTrace, true)
	body := rdOK(ctx, rdAPI(ctx), rdTrace)
	ids := spanIDs(body)
	found := false
	for _, id := range ids {
		found = found || id == rdOrphan
	}
	ctx.Assert(found, "span %s names a parent that never arrived and the read dropped it: spans %q. Every stored span must be shown", rdOrphan, ids)
	ctx.Equal(body.Gaps, []gap{{ParentSpanID: rdNever, Waiting: 1}}, "the parent %s never arrived and one span waits for it; gaps", rdNever)
}

func CheckPartialMarker(ctx *harness.Ctx) {
	rdSeed(ctx, rdTrace, true)
	rdSeed(ctx, rdOther, false)
	c := rdAPI(ctx)
	partial := rdOK(ctx, c, rdTrace)
	whole := rdOK(ctx, c, rdOther)
	ctx.Assert(partial.Partial != nil && *partial.Partial, "a trace with a missing parent must be answered partial true")
	ctx.Assert(whole.Partial != nil && !*whole.Partial, "a trace with every parent present must be answered partial false")
}

func CheckAbsoluteTimestamps(ctx *harness.Ctx) {
	rdSeed(ctx, rdTrace, false)
	body := rdOK(ctx, rdAPI(ctx), rdTrace)
	want := map[string][2]int64{rdRoot: {rdT0, 412}, rdPay: {rdT0 + 40, 120}}
	for _, s := range body.Spans {
		w := want[s.SpanID]
		ctx.Equal(s.StartMs, w[0], "span %s was ingested with start_ms %d: report the absolute time, not an offset; start_ms", s.SpanID, w[0])
		ctx.Assert(s.EndMs != nil && *s.EndMs == w[0]+w[1], "span %s must carry end_ms = start_ms + duration_ms = %d", s.SpanID, w[0]+w[1])
	}
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <map>
#include <string>
#include <utility>
#include <vector>

#include "traces/assembly.h"

namespace {

const std::string kTrace = "4bf92f3577b34da6a3ce929d0e0e4736";
const std::string kOther = "5c0a3f4688c45eb7b4df03af1f1f5847";
const std::string kRoot = "00f067aa0ba902b7";
const std::string kPay = "00f067aa0ba902b8";
const std::string kOrphan = "00f067aa0ba902b9";
const std::string kNever = "00f067aa0ba902ba";
constexpr long long kT0 = 1712345678901LL;

void seed(const std::string& trace_id, bool orphan) {
  assembly::insertSpan("acme", assembly::Span{trace_id, kRoot, "", "checkout", kT0, 412});
  assembly::insertSpan("acme", assembly::Span{trace_id, kPay, kRoot, "payments", kT0 + 40, 120});
  if (orphan) assembly::insertSpan("acme", assembly::Span{trace_id, kOrphan, kNever, "inventory", kT0 + 60, 30});
}

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response get(harness::HTTP& c, const std::string& trace_id, const std::string& tenant) { return c.Get("/v1/traces/" + trace_id, "X-Tenant-Id", tenant); }

nlohmann::json ok(harness::Ctx& ctx, harness::HTTP& c, const std::string& trace_id) {
  const auto r = get(c, trace_id, "acme");
  ctx.Equal(r.Status, 200, "GET /v1/traces/%s by its owner (%s)", trace_id, r.Text());
  return nlohmann::json::parse(r.Text(), nullptr, false);
}

std::vector<std::string> spanIds(const nlohmann::json& body) {
  std::vector<std::string> ids;
  if (body.is_object() && body.contains("spans")) {
    for (const auto& s : body["spans"]) ids.push_back(s.value("span_id", ""));
  }
  return ids;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  seed(kTrace, false);
  auto c = api(ctx);
  const auto body = ok(ctx, c, kTrace);
  ctx.Equal(body.value("root_span_id", ""), kRoot, "the trace's root_span_id");
  ctx.Equal(spanIds(body), {kRoot, kPay}, "the read must list both spans in start order; the span ids");
}

void CheckTenantScope(harness::Ctx& ctx) {
  seed(kTrace, true);
  auto c = api(ctx);
  const auto foreign = get(c, kTrace, "globex");
  ctx.Equal(foreign.Status, 404, "tenant globex read acme's trace (%s): a trace owned by another tenant is 404", foreign.Text());
  ctx.Assert(foreign.Text().find("checkout") == std::string::npos, "the 404 for another tenant's trace leaks its content: %s", foreign.Text());
  ctx.Equal(get(c, kOther, "globex").Status, 404, "a trace that does not exist");
  const auto own = get(c, kTrace, "acme");
  ctx.Equal(own.Status, 200, "the owner reading its trace (%s)", own.Text());
}

void CheckGapsVisible(harness::Ctx& ctx) {
  seed(kTrace, true);
  auto c = api(ctx);
  const auto body = ok(ctx, c, kTrace);
  const auto ids = spanIds(body);
  ctx.Assert(std::find(ids.begin(), ids.end(), kOrphan) != ids.end(), "span %s names a parent that never arrived and the read dropped it: spans %q. Every stored span must be shown", kOrphan, ids);
  const nlohmann::json want = nlohmann::json::array({{{"parent_span_id", kNever}, {"waiting", 1}}});
  ctx.Assert(body.value("gaps", nlohmann::json()) == want, "the parent %s never arrived and one span waits for it: gaps must be %s, got %s", kNever, want.dump(), body.value("gaps", nlohmann::json()).dump());
}

void CheckPartialMarker(harness::Ctx& ctx) {
  seed(kTrace, true);
  seed(kOther, false);
  auto c = api(ctx);
  const auto partial = ok(ctx, c, kTrace);
  const auto whole = ok(ctx, c, kOther);
  ctx.Assert(partial.value("partial", nlohmann::json()) == true, "a trace with a missing parent must be answered partial true, got %s", partial.value("partial", nlohmann::json()).dump());
  ctx.Assert(whole.value("partial", nlohmann::json()) == false, "a trace with every parent present must be answered partial false, got %s", whole.value("partial", nlohmann::json()).dump());
}

void CheckAbsoluteTimestamps(harness::Ctx& ctx) {
  seed(kTrace, false);
  auto c = api(ctx);
  const auto body = ok(ctx, c, kTrace);
  const std::map<std::string, std::pair<long long, long long>> want = {{kRoot, {kT0, 412}}, {kPay, {kT0 + 40, 120}}};
  for (const auto& s : body.value("spans", nlohmann::json::array())) {
    const auto& [start, duration] = want.at(s.value("span_id", ""));
    ctx.Equal(s.value("start_ms", 0LL), start, "span %s was ingested with start_ms %v: report the absolute time, not an offset; start_ms", s.value("span_id", ""), start);
    ctx.Equal(s.value("end_ms", 0LL), start + duration, "span %s must carry end_ms = start_ms + duration_ms; end_ms", s.value("span_id", ""));
  }
}
`,
  },
  hints: [
    "Read a trace whose payments span named a parent that did not arrive: the waterfall is short, says nothing is missing, starts at 0 ms, and the same URL works with another tenant's header.",
    "The handler keeps only spans whose parent is present, hard-codes `partial: false` and `gaps: []`, subtracts the earliest start from every span, and does not compare the trace's `owner` with the caller.",
    'Answer 404 when `trace["owner"] != tenant`; keep every span; build `gaps` from parent ids not among the span ids with their `waiting` counts; set `partial` to `bool(gaps)`; send the absolute `start_ms` and `end_ms = start_ms + duration_ms`.',
  ],
  debrief: `A read path for incidents has one job beyond the tree: to say what it does not know. Showing the orphaned span with its missing parent named turns "the trace looks fine" into "payments was called by something we never heard from", which is usually the lead. Absolute timestamps are what line a span up with a log line or a deploy; offsets are a rendering choice, so the UI computes them. The owner check answers 404 rather than 403 so the endpoint confirms no trace id that belongs to someone else. A reader in front of many hosts also has to deal with clock skew: a child that appears to start before its parent is flagged, not silently reordered.`,
};
