import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/spans: spans are validated at the edge',
  concept: 'http',
  guides: ['request-boundaries'],
  file: 'api',
  focus: ['sdk', 'collector', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/spans\`: it reads the tenant from \`X-Tenant-Id\`,
decodes \`{trace_id, span_id, parent_span_id, service, start_ms, duration_ms}\`, hands the span to
\`assembly.insert_span(tenant, span)\` (provided as \`traces.assembly\`; step 2 builds it) and answers
**202** \`{trace_id, span_id, duplicate, count, missing}\`. It serves the demo and hides four flaws.

**Failure mode the checks target.** Spans without a tenant pile into a bucket nobody owns, a trace
id one character short becomes a trace nobody can query, a span that names itself as its parent
leaves a trace without a root, and a duration sent in nanoseconds turns a 412 ms checkout into a
span of almost five days.

- A missing or empty \`X-Tenant-Id\` is **401**.
- \`trace_id\` is exactly 32 lowercase hex characters (\`TRACE_ID_RE\`), \`span_id\` 16
  (\`SPAN_ID_RE\`); \`parent_span_id\` is \`""\` for a root, else a span id. Anything else is **422**.
- A span whose \`parent_span_id\` equals its \`span_id\` is **422**.
- \`duration_ms\` is an integer from 0 to \`MAX_DURATION_MS\` (1 800 000, 30 minutes); anything
  else is **422**.
- Every rejection is answered before \`insert_span\`, so it leaves nothing in Redis.`,
  sequence: {
    participants: ['Traces SDK', 'Trace Collector', 'Redis'],
    messages: [
      {from: 'Traces SDK', to: 'Trace Collector', label: 'POST /v1/spans · X-Tenant-Id', kind: 'sync'},
      {from: 'Trace Collector', to: 'Trace Collector', label: 'ids · self-parent · duration_ms range', kind: 'sync'},
      {from: 'Trace Collector', to: 'Traces SDK', label: '401 / 422 before anything is written', kind: 'reply'},
      {from: 'Trace Collector', to: 'Redis', label: 'insert_span(tenant, span) · one script', kind: 'sync'},
      {from: 'Redis', to: 'Trace Collector', label: '{inserted, count, missing}', kind: 'reply'},
      {from: 'Trace Collector', to: 'Traces SDK', label: '202 {span_id, duplicate, count, missing}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Accepts a span on POST /v1/spans',
      detail: 'Register `POST /v1/spans` and hand a valid span to `insert_span`/`insertSpan`, answering 202.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/spans["']/, /assembly\.insert_span\(/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/spans['"]/, /insertSpan\(/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/spans"/, /assembly\.InsertSpan\(/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"spans"\s*\)/, /Assembly\.insertSpan\(/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/spans"/, /assembly::insertSpan\(/]},
      },
    },
    {
      id: 'tenant-required',
      title: 'A span without a tenant is 401',
      detail:
        'A missing or empty `X-Tenant-Id` answers **401** and stores nothing; the starter files the span under a shared `"default"` tenant.',
      match: {
        python: {all: [/\b401\b/], none: [/["']default["']/]},
        typescript: {all: [/\b401\b/], none: [/['"]default['"]/]},
        go: {all: [/StatusUnauthorized|\b401\b/], none: [/"default"/]},
        scala: {all: [/Unauthorized|\b401\b/], none: [/"default"/]},
        cpp: {all: [/\b401\b/], none: [/"default"/]},
      },
    },
    {
      id: 'id-shape',
      title: 'Malformed trace and span ids are 422',
      detail:
        'The trace id must match 32 lowercase hex characters and the span id (and a parent that is set) 16, else **422** before the span is stored.',
      match: {
        python: {all: [/\{32\}/, /\{16\}/, /\b422\b/]},
        typescript: {all: [/\{32\}/, /\{16\}/, /\b422\b/]},
        go: {all: [/\{32\}/, /\{16\}/, /StatusUnprocessableEntity|\b422\b/]},
        scala: {all: [/\{32\}/, /\{16\}/, /UnprocessableEntity|\b422\b/]},
        cpp: {all: [/\{32\}/, /\{16\}/, /\b422\b/]},
      },
    },
    {
      id: 'self-parent',
      title: 'A span cannot be its own parent',
      detail:
        'A span whose `parent_span_id` equals its `span_id` is **422**: stored, it leaves a trace that never resolves a root.',
      match: {
        python: {all: [/parent_span_id\s*==\s*[\w.[\]"']*span_id|span_id\s*==\s*[\w.[\]"']*parent_span_id/]},
        typescript: {all: [/parent\w*\s*===\s*[\w.[\]'"]*span_id|span_id\s*===\s*[\w.[\]'"]*parent/i]},
        go: {all: [/ParentSpanID\s*==\s*[\w.]*SpanID|\bSpanID\s*==\s*[\w.]*ParentSpanID/]},
        scala: {all: [/parent\w*\s*==\s*[\w.]*spanId|spanId\s*==\s*[\w.]*parent/i]},
        cpp: {all: [/parent\w*\s*==\s*[\w.]*span_id|span_id\s*==\s*[\w.]*parent/]},
      },
    },
    {
      id: 'duration-range',
      title: 'duration_ms is an integer number of milliseconds, at most 30 minutes',
      detail:
        '`duration_ms` must be an integer from 0 to `MAX_DURATION_MS` (1 800 000), else **422**: a nanosecond or fractional value is refused, not truncated into a span of days.',
      match: {
        python: {all: [/MAX_DURATION_MS/], none: [/duration_ms:\s*float/, /int\(\s*body\.duration_ms\s*\)/]},
        typescript: {all: [/MAX_DURATION_MS/, /Number\.isInteger\(/], none: [/Math\.trunc\(/]},
        go: {all: [/maxDurationMs/], none: [/DurationMs\s+float64/]},
        scala: {all: [/MaxDurationMs/, /isValidLong|isWhole/]},
        cpp: {all: [/kMaxDurationMs/, /is_number_integer\(\)/], none: [/value\(\s*"duration_ms",\s*0\.0\s*\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from traces import assembly  # insert_span(tenant, span) -> {inserted, count, missing}

app = FastAPI()


class SpanIn(BaseModel):
    trace_id: str
    span_id: str
    parent_span_id: str = ""
    service: str
    start_ms: int
    duration_ms: float


@app.post("/v1/spans")
def ingest(body: SpanIn, request: Request) -> JSONResponse:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id") or "default"
    span = {**body.model_dump(), "duration_ms": int(body.duration_ms)}
    result = assembly.insert_span(tenant, span)
    return JSONResponse(
        {"trace_id": body.trace_id, "span_id": body.span_id, "duplicate": not result["inserted"], "count": result["count"], "missing": result["missing"]},
        status_code=202,
    )
`,
      solution: `import re

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from traces import assembly  # insert_span(tenant, span) -> {inserted, count, missing}

app = FastAPI()

TRACE_ID_RE = re.compile(r"[0-9a-f]{32}")
SPAN_ID_RE = re.compile(r"[0-9a-f]{16}")
MAX_DURATION_MS = 30 * 60 * 1000


class SpanIn(BaseModel):
    trace_id: str
    span_id: str
    parent_span_id: str = ""
    service: str
    start_ms: int
    duration_ms: int  # a fractional value is refused by the model (422), not truncated


def unprocessable(error: str) -> JSONResponse:
    return JSONResponse({"error": error}, status_code=422)


@app.post("/v1/spans")
def ingest(body: SpanIn, request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        return JSONResponse({"error": "X-Tenant-Id is required"}, status_code=401)
    if not TRACE_ID_RE.fullmatch(body.trace_id) or not SPAN_ID_RE.fullmatch(body.span_id):
        return unprocessable("trace_id is 32 lowercase hex characters, span_id 16")
    if body.parent_span_id and not SPAN_ID_RE.fullmatch(body.parent_span_id):
        return unprocessable("parent_span_id is empty for a root, else 16 lowercase hex characters")
    if body.parent_span_id == body.span_id:
        return unprocessable("a span cannot be its own parent")
    if not 0 <= body.duration_ms <= MAX_DURATION_MS:
        return unprocessable(f"duration_ms is milliseconds, from 0 to {MAX_DURATION_MS}")
    # Every guard has answered: only a valid span reaches the assembly.
    result = assembly.insert_span(tenant, body.model_dump())
    return JSONResponse(
        {"trace_id": body.trace_id, "span_id": body.span_id, "duplicate": not result["inserted"], "count": result["count"], "missing": result["missing"]},
        status_code=202,
    )
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {type Span, insertSpan} from 'traces/assembly';

export const app = Fastify();

app.post('/v1/spans', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const tenant = (request.headers['x-tenant-id'] as string | undefined) || 'default';
  const body = request.body as Span;
  const span: Span = {
    trace_id: String(body.trace_id),
    span_id: String(body.span_id),
    parent_span_id: body.parent_span_id ?? '',
    service: String(body.service),
    start_ms: Number(body.start_ms),
    duration_ms: Math.trunc(Number(body.duration_ms)),
  };
  const result = await insertSpan(tenant, span);
  return reply.code(202).send({trace_id: span.trace_id, span_id: span.span_id, duplicate: !result.inserted, count: result.count, missing: result.missing});
});
`,
      solution: `import Fastify from 'fastify';

import {type Span, insertSpan} from 'traces/assembly';

export const app = Fastify();

export const TRACE_ID_RE = /^[0-9a-f]{32}$/;
export const SPAN_ID_RE = /^[0-9a-f]{16}$/;
export const MAX_DURATION_MS = 30 * 60 * 1000;

app.post('/v1/spans', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const body = request.body as Record<string, unknown>;
  const {trace_id, span_id, service, start_ms, duration_ms} = body;
  const parent = body.parent_span_id ?? '';
  if (typeof trace_id !== 'string' || !TRACE_ID_RE.test(trace_id) || typeof span_id !== 'string' || !SPAN_ID_RE.test(span_id)) {
    return reply.code(422).send({error: 'trace_id is 32 lowercase hex characters, span_id 16'});
  }
  if (typeof parent !== 'string' || (parent !== '' && !SPAN_ID_RE.test(parent))) {
    return reply.code(422).send({error: 'parent_span_id is empty for a root, else 16 lowercase hex characters'});
  }
  if (parent === span_id) return reply.code(422).send({error: 'a span cannot be its own parent'});
  if (typeof duration_ms !== 'number' || !Number.isInteger(duration_ms) || duration_ms < 0 || duration_ms > MAX_DURATION_MS) {
    return reply.code(422).send({error: \`duration_ms is an integer number of milliseconds, from 0 to \${MAX_DURATION_MS}\`});
  }
  if (typeof service !== 'string' || typeof start_ms !== 'number') return reply.code(422).send({error: 'service and start_ms are required'});
  // Every guard has answered: only a valid span reaches the assembly.
  const span: Span = {trace_id, span_id, parent_span_id: parent, service, start_ms, duration_ms};
  const result = await insertSpan(tenant, span);
  return reply.code(202).send({trace_id, span_id, duplicate: !result.inserted, count: result.count, missing: result.missing});
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"traces/assembly" // assembly.InsertSpan(ctx, tenant, span) (Inserted, error)
)

type spanIn struct {
	TraceID      string  \`json:"trace_id"\`
	SpanID       string  \`json:"span_id"\`
	ParentSpanID string  \`json:"parent_span_id"\`
	Service      string  \`json:"service"\`
	StartMs      int64   \`json:"start_ms"\`
	DurationMs   float64 \`json:"duration_ms"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func ingest(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		tenant = "default"
	}
	var body spanIn
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, err.Error(), http.StatusBadRequest)
		return
	}
	span := assembly.Span{TraceID: body.TraceID, SpanID: body.SpanID, ParentSpanID: body.ParentSpanID, Service: body.Service, StartMs: body.StartMs, DurationMs: int64(body.DurationMs)}
	result, err := assembly.InsertSpan(r.Context(), tenant, span)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(rw, http.StatusAccepted, map[string]any{"trace_id": span.TraceID, "span_id": span.SpanID, "duplicate": !result.Inserted, "count": result.Count, "missing": result.Missing})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/spans", ingest)
}
`,
      solution: `package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"

	"traces/assembly" // assembly.InsertSpan(ctx, tenant, span) (Inserted, error)
)

var (
	traceIDRe = regexp.MustCompile(\`^[0-9a-f]{32}$\`)
	spanIDRe  = regexp.MustCompile(\`^[0-9a-f]{16}$\`)
)

const maxDurationMs = 30 * 60 * 1000

type spanIn struct {
	TraceID      string \`json:"trace_id"\`
	SpanID       string \`json:"span_id"\`
	ParentSpanID string \`json:"parent_span_id"\`
	Service      string \`json:"service"\`
	StartMs      int64  \`json:"start_ms"\`
	DurationMs   int64  \`json:"duration_ms"\` // a fractional value fails to decode: 422, not truncated
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func unprocessable(rw http.ResponseWriter, msg string) {
	writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": msg})
}

func ingest(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	var body spanIn
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		unprocessable(rw, err.Error())
		return
	}
	if !traceIDRe.MatchString(body.TraceID) || !spanIDRe.MatchString(body.SpanID) {
		unprocessable(rw, "trace_id is 32 lowercase hex characters, span_id 16")
		return
	}
	if body.ParentSpanID != "" && !spanIDRe.MatchString(body.ParentSpanID) {
		unprocessable(rw, "parent_span_id is empty for a root, else 16 lowercase hex characters")
		return
	}
	if body.ParentSpanID == body.SpanID {
		unprocessable(rw, "a span cannot be its own parent")
		return
	}
	if body.DurationMs < 0 || body.DurationMs > maxDurationMs {
		unprocessable(rw, fmt.Sprintf("duration_ms is milliseconds, from 0 to %d", maxDurationMs))
		return
	}
	// Every guard has answered: only a valid span reaches the assembly.
	span := assembly.Span{TraceID: body.TraceID, SpanID: body.SpanID, ParentSpanID: body.ParentSpanID, Service: body.Service, StartMs: body.StartMs, DurationMs: body.DurationMs}
	result, err := assembly.InsertSpan(r.Context(), tenant, span)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(rw, http.StatusAccepted, map[string]any{"trace_id": span.TraceID, "span_id": span.SpanID, "duplicate": !result.Inserted, "count": result.Count, "missing": result.Missing})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/spans", ingest)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import traces.Assembly // Assembly.insertSpan(tenant, span): Inserted

object Api {
  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def text(body: Map[String, JsValue], name: String): String = body.get(name).collect { case JsString(s) => s }.getOrElse("")

  val route: Route = path("v1" / "spans") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") { header =>
        entity(as[String]) { raw =>
          // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
          val tenant = header.filter(_.nonEmpty).getOrElse("default")
          val body = raw.parseJson.asJsObject.fields
          val start = body.get("start_ms").collect { case JsNumber(n) => n.toLong }.getOrElse(0L)
          val duration = body.get("duration_ms").collect { case JsNumber(n) => n.toLong }.getOrElse(0L)
          val span = Assembly.Span(text(body, "trace_id"), text(body, "span_id"), text(body, "parent_span_id"), text(body, "service"), start, duration)
          val result = Assembly.insertSpan(tenant, span)
          complete(json(StatusCodes.Accepted, JsObject(
            "trace_id" -> JsString(span.traceId), "span_id" -> JsString(span.spanId), "duplicate" -> JsBoolean(!result.inserted),
            "count" -> JsNumber(result.count), "missing" -> JsNumber(result.missing))))
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

import scala.util.matching.Regex

import traces.Assembly // Assembly.insertSpan(tenant, span): Inserted

object Api {
  val TraceIdRe: Regex = "[0-9a-f]{32}".r
  val SpanIdRe: Regex = "[0-9a-f]{16}".r
  val MaxDurationMs: Long = 30L * 60 * 1000

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def unprocessable(error: String): HttpResponse = json(StatusCodes.UnprocessableEntity, JsObject("error" -> JsString(error)))

  private def text(body: Map[String, JsValue], name: String): String = body.get(name).collect { case JsString(s) => s }.getOrElse("")

  /** Why the span is refused, if it is. */
  private def refusal(body: Map[String, JsValue], span: Assembly.Span): Option[String] = {
    val duration = body.get("duration_ms").collect { case JsNumber(n) => n }
    if (!TraceIdRe.matches(span.traceId) || !SpanIdRe.matches(span.spanId)) Some("trace_id is 32 lowercase hex characters, span_id 16")
    else if (span.parentSpanId.nonEmpty && !SpanIdRe.matches(span.parentSpanId)) Some("parent_span_id is empty for a root, else 16 lowercase hex characters")
    else if (span.parentSpanId == span.spanId) Some("a span cannot be its own parent")
    else if (!duration.exists(n => n.isValidLong && n >= 0 && n <= MaxDurationMs)) Some(s"duration_ms is an integer number of milliseconds, from 0 to $MaxDurationMs")
    else None
  }

  val route: Route = path("v1" / "spans") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(json(StatusCodes.Unauthorized, JsObject("error" -> JsString("X-Tenant-Id is required"))))
        case Some(tenant) =>
          entity(as[String]) { raw =>
            val body = raw.parseJson.asJsObject.fields
            val start = body.get("start_ms").collect { case JsNumber(n) => n.toLong }.getOrElse(0L)
            val duration = body.get("duration_ms").collect { case JsNumber(n) => n.toLong }.getOrElse(0L)
            val span = Assembly.Span(text(body, "trace_id"), text(body, "span_id"), text(body, "parent_span_id"), text(body, "service"), start, duration)
            refusal(body, span) match {
              case Some(error) => complete(unprocessable(error))
              case None =>
                // Every guard has answered: only a valid span reaches the assembly.
                val result = Assembly.insertSpan(tenant, span)
                complete(json(StatusCodes.Accepted, JsObject(
                  "trace_id" -> JsString(span.traceId), "span_id" -> JsString(span.spanId), "duplicate" -> JsBoolean(!result.inserted),
                  "count" -> JsNumber(result.count), "missing" -> JsNumber(result.missing))))
            }
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

#include <string>

#include "traces/assembly.h"  // assembly::insertSpan(tenant, span) -> Inserted

using json = nlohmann::json;

void ingest(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) tenant = "default";
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) {
    res.status = 400;
    res.set_content("the body is not a JSON object", "text/plain");
    return;
  }
  const assembly::Span span{body.value("trace_id", ""), body.value("span_id", ""), body.value("parent_span_id", ""), body.value("service", ""),
                            body.value("start_ms", 0LL), static_cast<long long>(body.value("duration_ms", 0.0))};
  const assembly::Inserted result = assembly::insertSpan(tenant, span);
  res.status = 202;
  res.set_content(json{{"trace_id", span.trace_id}, {"span_id", span.span_id}, {"duplicate", !result.inserted}, {"count", result.count}, {"missing", result.missing}}.dump(),
                  "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/spans", ingest); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <regex>
#include <string>

#include "traces/assembly.h"  // assembly::insertSpan(tenant, span) -> Inserted

using json = nlohmann::json;

const std::regex kTraceIdRe("[0-9a-f]{32}");
const std::regex kSpanIdRe("[0-9a-f]{16}");
constexpr long long kMaxDurationMs = 30LL * 60 * 1000;

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

// Why the span is refused, or "".
std::string refusal(const json& body, const assembly::Span& span) {
  if (!std::regex_match(span.trace_id, kTraceIdRe) || !std::regex_match(span.span_id, kSpanIdRe)) return "trace_id is 32 lowercase hex characters, span_id 16";
  if (!span.parent_span_id.empty() && !std::regex_match(span.parent_span_id, kSpanIdRe)) return "parent_span_id is empty for a root, else 16 lowercase hex characters";
  if (span.parent_span_id == span.span_id) return "a span cannot be its own parent";
  const json duration = body.value("duration_ms", json());
  if (!duration.is_number_integer() || duration.get<long long>() < 0 || duration.get<long long>() > kMaxDurationMs) {
    return "duration_ms is an integer number of milliseconds, from 0 to " + std::to_string(kMaxDurationMs);
  }
  return "";
}

void ingest(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, {{"error", "X-Tenant-Id is required"}});
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object() || !body.value("trace_id", json()).is_string() || !body.value("span_id", json()).is_string()) {
    return reply(res, 422, {{"error", "trace_id and span_id are required"}});
  }
  const assembly::Span span{body.value("trace_id", ""), body.value("span_id", ""), body.value("parent_span_id", ""), body.value("service", ""),
                            body.value("start_ms", 0LL), body.value("duration_ms", json(0)).is_number_integer() ? body["duration_ms"].get<long long>() : 0};
  if (const std::string error = refusal(body, span); !error.empty()) return reply(res, 422, {{"error", error}});
  // Every guard has answered: only a valid span reaches the assembly.
  const assembly::Inserted result = assembly::insertSpan(tenant, span);
  reply(res, 202, {{"trace_id", span.trace_id}, {"span_id", span.span_id}, {"duplicate", !result.inserted}, {"count", result.count}, {"missing", result.missing}});
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/spans", ingest); }
`,
    },
  },
  harness: {
    python: `from traces import assembly

TRACE = "4bf92f3577b34da6a3ce929d0e0e4736"
ROOT = "00f067aa0ba902b7"
CHILD = "00f067aa0ba902b8"


def _span(**over):
    span = {"trace_id": TRACE, "span_id": ROOT, "parent_span_id": "", "service": "checkout", "start_ms": 1712345678901, "duration_ms": 412}
    span.update(over)
    return span


def _api(ctx):
    return ctx.client(ctx.load("api").app)


async def _post(c, body, tenant="acme"):
    return await c.post("/v1/spans", json=body, headers={} if tenant is None else {"X-Tenant-Id": tenant})


def _nothing_stored(ctx, why):
    keys = ctx.redis.keys("trace:*")
    assert keys == [], f"{why}, yet Redis now holds {keys}: a rejection must be answered before insert_span"


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await _post(c, _span())
        assert r.status_code == 202, f"POST /v1/spans with a valid root span answered {r.status_code}: {r.text}"
        body = r.json()
        assert body.get("span_id") == ROOT and body.get("duplicate") is False and body.get("count") == 1, f"the 202 must report the span as new, count 1; got {body}"
        r = await _post(c, _span(span_id=CHILD, parent_span_id=ROOT, service="payments", start_ms=1712345678950, duration_ms=120))
        assert r.status_code == 202, f"a valid child span answered {r.status_code}: {r.text}"
    trace = assembly.load_trace(TRACE)
    assert trace is not None and trace["owner"] == "acme", f"the trace must be stored for tenant acme, Redis holds {trace}"
    assert [s["span_id"] for s in trace["spans"]] == [ROOT, CHILD], f"both spans must be stored, got {trace['spans']}"


async def check_tenant_required(ctx):
    async with _api(ctx) as c:
        for tenant in (None, ""):
            r = await _post(c, _span(), tenant=tenant)
            assert r.status_code == 401, f"a span with X-Tenant-Id {'missing' if tenant is None else 'empty'} answered {r.status_code}, expected 401: {r.text}"
            _nothing_stored(ctx, "the span had no tenant")
        r = await _post(c, _span())
        assert r.status_code == 202, f"the same span with X-Tenant-Id acme answered {r.status_code}: {r.text}"
    assert assembly.load_trace(TRACE)["owner"] == "acme", "the trace must belong to the tenant that sent it"


async def check_id_shape(ctx):
    bad = [
        ("a trace id one character short", _span(trace_id=TRACE[:31])),
        ("an uppercase trace id", _span(trace_id=TRACE.upper())),
        ("a span id of 15 characters", _span(span_id=ROOT[:15])),
        ("a span id with a non-hex character", _span(span_id="00f067aa0ba902bz")),
        ("a parent id that is not a span id", _span(span_id=CHILD, parent_span_id="root")),
    ]
    async with _api(ctx) as c:
        for why, body in bad:
            r = await _post(c, body)
            assert r.status_code == 422, f"{why} answered {r.status_code}, expected 422: {r.text}"
            _nothing_stored(ctx, f"{why} was refused")
        r = await _post(c, _span())
        assert r.status_code == 202, f"a well-formed root span answered {r.status_code}: {r.text}"


async def check_self_parent(ctx):
    async with _api(ctx) as c:
        r = await _post(c, _span(span_id=CHILD, parent_span_id=CHILD))
        assert r.status_code == 422, f"a span whose parent_span_id is its own span_id answered {r.status_code}, expected 422: {r.text}"
        _nothing_stored(ctx, "the span named itself as its parent")
        r = await _post(c, _span(span_id=CHILD, parent_span_id=ROOT))
        assert r.status_code == 202, f"a child of another span answered {r.status_code}: {r.text}"


async def check_duration_range(ctx):
    async with _api(ctx) as c:
        for why, value in (("a negative duration_ms", -5), ("412 ms sent in nanoseconds", 412_000_000), ("a fractional duration_ms", 412.5)):
            r = await _post(c, _span(duration_ms=value))
            assert r.status_code == 422, f"{why} ({value}) answered {r.status_code}, expected 422: {r.text}"
            _nothing_stored(ctx, f"{why} was refused")
        r = await _post(c, _span(duration_ms=1_800_000))
        assert r.status_code == 202, f"duration_ms 1800000 (exactly 30 minutes) answered {r.status_code}: {r.text}"
    assert assembly.load_trace(TRACE)["spans"][0]["duration_ms"] == 1_800_000, "the stored duration must be the one sent"
`,
    typescript: `const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const ROOT = '00f067aa0ba902b7';
const CHILD = '00f067aa0ba902b8';

const span = (over: Record<string, unknown> = {}) => ({trace_id: TRACE, span_id: ROOT, parent_span_id: '', service: 'checkout', start_ms: 1712345678901, duration_ms: 412, ...over});

function api(ctx) {
  return {c: ctx.client(ctx.load('api').app), assembly: ctx.load('/support/traces/assembly.ts')};
}

const post = (c, body, tenant: string | null = 'acme') => c.post('/v1/spans', {json: body, headers: tenant === null ? {} : {'X-Tenant-Id': tenant}});

function nothingStored(ctx, why: string): void {
  const keys = ctx.redis.keys('trace:*');
  assert.equal(keys.length, 0, \`\${why}, yet Redis now holds \${JSON.stringify(keys)}: a rejection must be answered before insertSpan\`);
}

export async function check_route(ctx) {
  const {c, assembly} = api(ctx);
  let r = await post(c, span());
  assert.equal(r.status, 202, \`POST /v1/spans with a valid root span answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.span_id === ROOT && body.duplicate === false && body.count === 1, \`the 202 must report the span as new, count 1; got \${r.text}\`);
  r = await post(c, span({span_id: CHILD, parent_span_id: ROOT, service: 'payments', start_ms: 1712345678950, duration_ms: 120}));
  assert.equal(r.status, 202, \`a valid child span answered \${r.status}: \${r.text}\`);
  const trace = await assembly.loadTrace(TRACE);
  assert(trace !== null && trace.owner === 'acme', \`the trace must be stored for tenant acme, Redis holds \${JSON.stringify(trace)}\`);
  assert.deepStrictEqual(trace.spans.map(s => s.span_id), [ROOT, CHILD], \`both spans must be stored, got \${JSON.stringify(trace.spans)}\`);
}

export async function check_tenant_required(ctx) {
  const {c, assembly} = api(ctx);
  for (const tenant of [null, '']) {
    const r = await post(c, span(), tenant);
    assert.equal(r.status, 401, \`a span with X-Tenant-Id \${tenant === null ? 'missing' : 'empty'} answered \${r.status}, expected 401: \${r.text}\`);
    nothingStored(ctx, 'the span had no tenant');
  }
  const r = await post(c, span());
  assert.equal(r.status, 202, \`the same span with X-Tenant-Id acme answered \${r.status}: \${r.text}\`);
  assert.equal((await assembly.loadTrace(TRACE)).owner, 'acme', 'the trace must belong to the tenant that sent it');
}

export async function check_id_shape(ctx) {
  const {c} = api(ctx);
  const bad: [string, Record<string, unknown>][] = [
    ['a trace id one character short', span({trace_id: TRACE.slice(0, 31)})],
    ['an uppercase trace id', span({trace_id: TRACE.toUpperCase()})],
    ['a span id of 15 characters', span({span_id: ROOT.slice(0, 15)})],
    ['a span id with a non-hex character', span({span_id: '00f067aa0ba902bz'})],
    ['a parent id that is not a span id', span({span_id: CHILD, parent_span_id: 'root'})],
  ];
  for (const [why, body] of bad) {
    const r = await post(c, body);
    assert.equal(r.status, 422, \`\${why} answered \${r.status}, expected 422: \${r.text}\`);
    nothingStored(ctx, \`\${why} was refused\`);
  }
  const r = await post(c, span());
  assert.equal(r.status, 202, \`a well-formed root span answered \${r.status}: \${r.text}\`);
}

export async function check_self_parent(ctx) {
  const {c} = api(ctx);
  let r = await post(c, span({span_id: CHILD, parent_span_id: CHILD}));
  assert.equal(r.status, 422, \`a span whose parent_span_id is its own span_id answered \${r.status}, expected 422: \${r.text}\`);
  nothingStored(ctx, 'the span named itself as its parent');
  r = await post(c, span({span_id: CHILD, parent_span_id: ROOT}));
  assert.equal(r.status, 202, \`a child of another span answered \${r.status}: \${r.text}\`);
}

export async function check_duration_range(ctx) {
  const {c, assembly} = api(ctx);
  for (const [why, value] of [['a negative duration_ms', -5], ['412 ms sent in nanoseconds', 412_000_000], ['a fractional duration_ms', 412.5]] as const) {
    const r = await post(c, span({duration_ms: value}));
    assert.equal(r.status, 422, \`\${why} (\${value}) answered \${r.status}, expected 422: \${r.text}\`);
    nothingStored(ctx, \`\${why} was refused\`);
  }
  const r = await post(c, span({duration_ms: 1_800_000}));
  assert.equal(r.status, 202, \`duration_ms 1800000 (exactly 30 minutes) answered \${r.status}: \${r.text}\`);
  assert.equal((await assembly.loadTrace(TRACE)).spans[0].duration_ms, 1_800_000, 'the stored duration must be the one sent');
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
	apiTrace = "4bf92f3577b34da6a3ce929d0e0e4736"
	apiRoot  = "00f067aa0ba902b7"
	apiChild = "00f067aa0ba902b8"
)

func apiSpan(over map[string]any) map[string]any {
	span := map[string]any{"trace_id": apiTrace, "span_id": apiRoot, "parent_span_id": "", "service": "checkout", "start_ms": 1712345678901, "duration_ms": 412}
	for k, v := range over {
		span[k] = v
	}
	return span
}

func api(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func post(c *harness.HTTP, body map[string]any) *harness.Response {
	return c.Post("/v1/spans", body, "X-Tenant-Id", "acme")
}

func nothingStored(ctx *harness.Ctx, why string) {
	keys := ctx.Redis.Keys("trace:*")
	ctx.Assert(len(keys) == 0, "%s, yet Redis now holds %q: a rejection must be answered before InsertSpan", why, keys)
}

func loadAPITrace(ctx *harness.Ctx) *assembly.Trace {
	trace, err := assembly.LoadTrace(context.Background(), apiTrace)
	ctx.NoError(err, "LoadTrace(%s)", apiTrace)
	return trace
}

func CheckRoute(ctx *harness.Ctx) {
	c := api(ctx)
	r := post(c, apiSpan(nil))
	ctx.Equal(r.Status, 202, "POST /v1/spans with a valid root span (%s)", r.Text())
	var body struct {
		SpanID    string \`json:"span_id"\`
		Duplicate *bool  \`json:"duplicate"\`
		Count     int    \`json:"count"\`
	}
	r.Decode(&body)
	ctx.Assert(body.SpanID == apiRoot && body.Duplicate != nil && !*body.Duplicate && body.Count == 1, "the 202 must report the span as new, count 1; got %s", r.Text())
	r = post(c, apiSpan(map[string]any{"span_id": apiChild, "parent_span_id": apiRoot, "service": "payments", "start_ms": 1712345678950, "duration_ms": 120}))
	ctx.Equal(r.Status, 202, "a valid child span (%s)", r.Text())
	trace := loadAPITrace(ctx)
	ctx.Assert(trace != nil && trace.Owner == "acme", "the trace must be stored for tenant acme, Redis holds %+v", trace)
	ids := []string{}
	for _, s := range trace.Spans {
		ids = append(ids, s.SpanID)
	}
	ctx.Equal(ids, []string{apiRoot, apiChild}, "both spans must be stored; the span ids")
}

func CheckTenantRequired(ctx *harness.Ctx) {
	c := api(ctx)
	r := c.Post("/v1/spans", apiSpan(nil))
	ctx.Equal(r.Status, 401, "a span with X-Tenant-Id missing must be refused (%s)", r.Text())
	nothingStored(ctx, "the span had no tenant")
	r = c.Post("/v1/spans", apiSpan(nil), "X-Tenant-Id", "")
	ctx.Equal(r.Status, 401, "a span with X-Tenant-Id empty must be refused (%s)", r.Text())
	nothingStored(ctx, "the span had no tenant")
	r = post(c, apiSpan(nil))
	ctx.Equal(r.Status, 202, "the same span with X-Tenant-Id acme (%s)", r.Text())
	ctx.Equal(loadAPITrace(ctx).Owner, "acme", "the trace must belong to the tenant that sent it; its owner")
}

func CheckIdShape(ctx *harness.Ctx) {
	c := api(ctx)
	bad := []struct {
		why  string
		body map[string]any
	}{
		{"a trace id one character short", apiSpan(map[string]any{"trace_id": apiTrace[:31]})},
		{"an uppercase trace id", apiSpan(map[string]any{"trace_id": strings.ToUpper(apiTrace)})},
		{"a span id of 15 characters", apiSpan(map[string]any{"span_id": apiRoot[:15]})},
		{"a span id with a non-hex character", apiSpan(map[string]any{"span_id": "00f067aa0ba902bz"})},
		{"a parent id that is not a span id", apiSpan(map[string]any{"span_id": apiChild, "parent_span_id": "root"})},
	}
	for _, b := range bad {
		r := post(c, b.body)
		ctx.Equal(r.Status, 422, "%s must be refused (%s)", b.why, r.Text())
		nothingStored(ctx, b.why+" was refused")
	}
	r := post(c, apiSpan(nil))
	ctx.Equal(r.Status, 202, "a well-formed root span (%s)", r.Text())
}

func CheckSelfParent(ctx *harness.Ctx) {
	c := api(ctx)
	r := post(c, apiSpan(map[string]any{"span_id": apiChild, "parent_span_id": apiChild}))
	ctx.Equal(r.Status, 422, "a span whose parent_span_id is its own span_id must be refused (%s)", r.Text())
	nothingStored(ctx, "the span named itself as its parent")
	r = post(c, apiSpan(map[string]any{"span_id": apiChild, "parent_span_id": apiRoot}))
	ctx.Equal(r.Status, 202, "a child of another span (%s)", r.Text())
}

func CheckDurationRange(ctx *harness.Ctx) {
	c := api(ctx)
	for _, b := range []struct {
		why   string
		value any
	}{{"a negative duration_ms", -5}, {"412 ms sent in nanoseconds", 412000000}, {"a fractional duration_ms", 412.5}} {
		r := post(c, apiSpan(map[string]any{"duration_ms": b.value}))
		ctx.Equal(r.Status, 422, "%s (%v) must be refused (%s)", b.why, b.value, r.Text())
		nothingStored(ctx, b.why+" was refused")
	}
	r := post(c, apiSpan(map[string]any{"duration_ms": 1800000}))
	ctx.Equal(r.Status, 202, "duration_ms 1800000 (exactly 30 minutes) (%s)", r.Text())
	ctx.Equal(loadAPITrace(ctx).Spans[0].DurationMs, 1800000, "the stored duration must be the one sent; duration_ms")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <cctype>
#include <string>
#include <vector>

#include "traces/assembly.h"

namespace {

const std::string kTrace = "4bf92f3577b34da6a3ce929d0e0e4736";
const std::string kRoot = "00f067aa0ba902b7";
const std::string kChild = "00f067aa0ba902b8";

nlohmann::json span(const nlohmann::json& over = nlohmann::json::object()) {
  nlohmann::json s = {{"trace_id", kTrace}, {"span_id", kRoot}, {"parent_span_id", ""}, {"service", "checkout"}, {"start_ms", 1712345678901LL}, {"duration_ms", 412}};
  s.update(over);
  return s;
}

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response post(harness::HTTP& c, const nlohmann::json& body) {
  return c.Post("/v1/spans", body.dump(), "Content-Type", "application/json", "X-Tenant-Id", "acme");
}

void nothingStored(harness::Ctx& ctx, const std::string& why) {
  const auto keys = ctx.Redis.Keys("trace:*");
  ctx.Assert(keys.empty(), "%s, yet Redis now holds %q: a rejection must be answered before insertSpan", why, keys);
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  auto r = post(c, span());
  ctx.Equal(r.Status, 202, "POST /v1/spans with a valid root span (%s)", r.Text());
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  ctx.Assert(body.is_object() && body.value("span_id", "") == kRoot && body.value("duplicate", true) == false && body.value("count", 0) == 1,
             "the 202 must report the span as new, count 1; got %s", r.Text());
  r = post(c, span({{"span_id", kChild}, {"parent_span_id", kRoot}, {"service", "payments"}, {"start_ms", 1712345678950LL}, {"duration_ms", 120}}));
  ctx.Equal(r.Status, 202, "a valid child span (%s)", r.Text());
  const auto trace = assembly::loadTrace(kTrace);
  ctx.Assert(trace && trace->owner == "acme", "the trace must be stored for tenant acme, its owner is %q", trace ? trace->owner : "");
  std::vector<std::string> ids;
  for (const auto& s : trace->spans) ids.push_back(s.span_id);
  ctx.Equal(ids, {kRoot, kChild}, "both spans must be stored; the span ids");
}

void CheckTenantRequired(harness::Ctx& ctx) {
  auto c = api(ctx);
  auto r = c.Post("/v1/spans", span().dump(), "Content-Type", "application/json");
  ctx.Equal(r.Status, 401, "a span with X-Tenant-Id missing must be refused (%s)", r.Text());
  nothingStored(ctx, "the span had no tenant");
  r = c.Post("/v1/spans", span().dump(), "Content-Type", "application/json", "X-Tenant-Id", "");
  ctx.Equal(r.Status, 401, "a span with X-Tenant-Id empty must be refused (%s)", r.Text());
  nothingStored(ctx, "the span had no tenant");
  r = post(c, span());
  ctx.Equal(r.Status, 202, "the same span with X-Tenant-Id acme (%s)", r.Text());
  ctx.Equal(assembly::loadTrace(kTrace)->owner, "acme", "the trace must belong to the tenant that sent it; its owner");
}

void CheckIdShape(harness::Ctx& ctx) {
  auto c = api(ctx);
  std::string upper = kTrace;
  for (char& ch : upper) ch = static_cast<char>(std::toupper(static_cast<unsigned char>(ch)));
  const std::vector<std::pair<std::string, nlohmann::json>> bad = {
      {"a trace id one character short", span({{"trace_id", kTrace.substr(0, 31)}})},
      {"an uppercase trace id", span({{"trace_id", upper}})},
      {"a span id of 15 characters", span({{"span_id", kRoot.substr(0, 15)}})},
      {"a span id with a non-hex character", span({{"span_id", "00f067aa0ba902bz"}})},
      {"a parent id that is not a span id", span({{"span_id", kChild}, {"parent_span_id", "root"}})},
  };
  for (const auto& [why, body] : bad) {
    const auto r = post(c, body);
    ctx.Equal(r.Status, 422, "%s must be refused (%s)", why, r.Text());
    nothingStored(ctx, why + " was refused");
  }
  const auto r = post(c, span());
  ctx.Equal(r.Status, 202, "a well-formed root span (%s)", r.Text());
}

void CheckSelfParent(harness::Ctx& ctx) {
  auto c = api(ctx);
  auto r = post(c, span({{"span_id", kChild}, {"parent_span_id", kChild}}));
  ctx.Equal(r.Status, 422, "a span whose parent_span_id is its own span_id must be refused (%s)", r.Text());
  nothingStored(ctx, "the span named itself as its parent");
  r = post(c, span({{"span_id", kChild}, {"parent_span_id", kRoot}}));
  ctx.Equal(r.Status, 202, "a child of another span (%s)", r.Text());
}

void CheckDurationRange(harness::Ctx& ctx) {
  auto c = api(ctx);
  const std::vector<std::pair<std::string, nlohmann::json>> bad = {
      {"a negative duration_ms", -5}, {"412 ms sent in nanoseconds", 412000000}, {"a fractional duration_ms", 412.5}};
  for (const auto& [why, value] : bad) {
    const auto r = post(c, span({{"duration_ms", value}}));
    ctx.Equal(r.Status, 422, "%s (%s) must be refused (%s)", why, value.dump(), r.Text());
    nothingStored(ctx, why + " was refused");
  }
  const auto r = post(c, span({{"duration_ms", 1800000}}));
  ctx.Equal(r.Status, 202, "duration_ms 1800000 (exactly 30 minutes) (%s)", r.Text());
  ctx.Equal(assembly::loadTrace(kTrace)->spans.at(0).duration_ms, 1800000, "the stored duration must be the one sent; duration_ms");
}
`,
  },
  hints: [
    'A span posted without a tenant header is accepted and belongs to nobody, a trace id one character short comes back 202, a span naming itself as parent is stored, and a nanosecond duration lasts days.',
    'The handler trusts the body: nothing checks the length or alphabet of the ids, nothing compares the parent with the span id, the duration is truncated with no bounds, and a missing tenant falls back to "default".',
    'Answer 401 on an empty `X-Tenant-Id`; full-match `TRACE_ID_RE` and `SPAN_ID_RE` (and the parent when set); 422 when `parent_span_id == span_id`; take `duration_ms` as an integer within 0..`MAX_DURATION_MS`; all before `insert_span`.',
  ],
  debrief: `The edge is the one place a collector can refuse a span cheaply: once a malformed id is a Redis key, every later stage works around it and nobody can query it. The id checks are regular expressions because W3C Trace Context fixes the format; the self-parent check is the one structural rule a single span can break on its own; the duration bound catches unit mistakes, the most common exporter bug, at the cost of refusing a rare span longer than 30 minutes. A collector in front of real SDKs also refuses all-zero ids (invalid under Trace Context), caps the body size and the spans per request, and answers a batch with a partial-success count, as OTLP does, so one bad span does not cost the others.`,
};
