import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/spans: spans are validated at the edge',
  concept: 'http',
  file: 'api',
  focus: ['sdk', 'collector', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the ingest route,
decodes the body, hands the span to the assembler and answers \`202\`. It serves the demo because the
demo's SDK sends a 32-character trace id, a parent that is never itself, and a duration that happens
to be small. Three of those assumptions are wrong in production and one of them silently changes the
meaning of every number the trace shows.

Implement \`POST /v1/spans\` with body
\`{"trace_id": "4bf92f3577b34da6a3ce929d0e0e4736", "span_id": "00f067aa0ba902b7", "parent_span_id": "00f067aa0ba902b6", "service": "checkout", "start_ms": 1712345678901, "duration_ms": 412}\`.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- \`trace_id\` is exactly **32 lowercase hex** characters and \`span_id\` is exactly **16 lowercase
  hex** characters; \`parent_span_id\` is optional (absent or \`""\` for a root) but must match the span
  id shape when present. A malformed id is **422**, never a stored span.
- A span whose \`parent_span_id\` equals its own \`span_id\` is **422**. An accepted self-parent is a
  cycle: the assembler never resolves a root for that trace and every read of it waits forever.
- \`duration_ms\` is an integer from **0** to **1 800 000**; negative or larger values are **422**.
  The unit is part of the contract: the body carries \`duration_ms\`, the response reports
  \`"duration_unit": "ms"\`, and a body that sends \`duration\` or \`duration_s\` (seconds, as the SDK
  that generated this draft emits) is **422** rather than silently stored as a millisecond value.
- \`service\` is a non-empty string of at most **64** characters and \`start_ms\` is a non-negative
  epoch millisecond.
- The span reaches the assembler (\`store.insert_span\`) **only after** every guard has passed, and the
  response is \`202\` with the trace id, span id, service, \`duration_ms\`, \`duration_unit\` and
  \`duplicate\` — the flag the dedupe key produces, so a retrying exporter is visible in the response.

**Failure mode the checks target.** Every one of these defects is invisible until it matters. A
32-hex id with a missing character is just another string to Redis, so the span lands under a key
nobody will ever read; a self-parent hides one broken SDK behind a trace that never assembles; and a
draft that reads \`duration\` as milliseconds turns a 412-second checkout into a 412-millisecond one,
which is exactly the number an incident review will believe.`,
  sequence: {
    participants: ['Traces SDK', 'Trace Collector', 'Redis'],
    messages: [
      {from: 'Traces SDK', to: 'Trace Collector', label: 'POST /v1/spans · X-Tenant-Id', kind: 'sync'},
      {
        from: 'Trace Collector',
        to: 'Trace Collector',
        label: 'validate trace/span ids · self-parent · duration_ms',
        kind: 'sync',
      },
      {from: 'Trace Collector', to: 'Traces SDK', label: '422 {error} before any state is written', kind: 'reply'},
      {from: 'Trace Collector', to: 'Redis', label: 'EVAL insert span · marker span:{trace}:{span}', kind: 'sync'},
      {from: 'Redis', to: 'Trace Collector', label: '{inserted, count, missing, ttl}', kind: 'reply'},
      {
        from: 'Trace Collector',
        to: 'Traces SDK',
        label: '202 {span_id, duration_ms, duration_unit: ms, duplicate}',
        kind: 'reply',
      },
    ],
  },
  hints: [
    'Compile the two id shapes once and match them in the handler: `^[0-9a-f]{32}$` for a trace and `^[0-9a-f]{16}$` for a span. Reject with 422 **before** the store call — an id that never matched any other span is the cheapest thing in the system to detect and the most expensive one to discover during an incident.',
    'A parent that names its own span is a cycle, not a typo. Compare `parent_span_id` with `span_id` after the shape check and answer 422; `Some(id) == Some(id)` style comparisons on an optional field are fine, just keep the empty/absent parent as a root.',
    'The unit belongs to the field name. Accept `duration_ms`, bound it, echo `duration_unit`, and make any other duration field — `duration`, `duration_s`, whatever the SDK invented — a 422. Whichever way you enforce that (a strict model, a field whitelist, a decoder that rejects unknown fields), the point is that a seconds value can never be read as milliseconds.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/spans',
      detail: 'Register the ingest route on `POST /v1/spans`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/spans["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/spans['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/spans"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"spans"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/spans"/]},
      },
    },
    {
      id: 'id-shape',
      title: 'Rejects malformed trace and span ids',
      detail:
        'Both id shapes are checked (32 hex for a trace, 16 hex for a span and its parent) and a malformed id is **422**. The draft stores whatever string arrives, so a truncated id becomes a trace nobody can read.',
      match: {
        python: {all: [/TRACE_ID_RE/, /SPAN_ID_RE/, /status_code\s*=\s*422/]},
        typescript: {all: [/TRACE_ID_RE/, /SPAN_ID_RE/, /code\(\s*422\s*\)/]},
        go: {all: [/traceIDRe/, /spanIDRe/, /StatusUnprocessableEntity/]},
        scala: {all: [/TraceIdRe/, /SpanIdRe/, /StatusCodes\.UnprocessableEntity/]},
        cpp: {all: [/kTraceIdRe/, /kSpanIdRe/, /\b422\b/]},
      },
    },
    {
      id: 'self-parent',
      title: 'A span cannot be its own parent',
      detail:
        'A body whose `parent_span_id` equals its `span_id` is **422**: an accepted cycle means the trace never resolves a root. The draft stores it without a word.',
      match: {
        python: {all: [/body\.parent_span_id\s*==\s*body\.span_id/, /status_code\s*=\s*422/]},
        typescript: {all: [/(parentId|parent_span_id)\s*===\s*(spanId|body\.span_id)/, /code\(\s*422\s*\)/]},
        go: {all: [/body\.ParentSpanID\s*==\s*body\.SpanID/, /StatusUnprocessableEntity/]},
        scala: {all: [/parentId\s*==\s*body\.span_id/, /StatusCodes\.UnprocessableEntity/]},
        cpp: {all: [/parent\s*==\s*spanId/, /\b422\b/]},
      },
    },
    {
      id: 'duration-unit',
      title: 'The duration unit is explicit and enforced',
      detail:
        'The span carries `duration_ms`, the response reports `duration_unit`, and a body that sends a seconds field (`duration` / `duration_s`) or an out-of-range value is **422**. The draft reads `duration` as if it were milliseconds.',
      match: {
        python: {all: [/DURATION_UNIT\s*=\s*"ms"/, /MAX_DURATION_MS/, /extra\s*=\s*"forbid"/]},
        typescript: {all: [/DURATION_UNIT\s*=\s*'ms'/, /MAX_DURATION_MS/, /ALLOWED_FIELDS/]},
        go: {all: [/durationUnit\s*=\s*"ms"/, /maxDurationMS/, /DisallowUnknownFields/]},
        scala: {all: [/DurationUnit\s*=\s*"ms"/, /MaxDurationMs/, /AllowedFields/]},
        cpp: {all: [/kDurationUnit\s*=\s*"ms"/, /kMaxDurationMs/, /kAllowedFields/]},
      },
    },
    {
      id: 'validate-before-store',
      title: 'Validates before anything is stored',
      detail:
        'Every guard returns before the span reaches the assembler: the 422 paths are decided before `insert_span`/`insertSpan` is called, so a rejected span leaves no state behind.',
      match: {
        python: {order: [/status_code\s*=\s*422/, /store\.insert_span\(/]},
        typescript: {order: [/code\(\s*422\s*\)/, /store\.insertSpan\(/]},
        go: {order: [/StatusUnprocessableEntity/, /store\.InsertSpan\(/]},
        scala: {order: [/StatusCodes\.UnprocessableEntity/, /store\.insertSpan\(/]},
        cpp: {order: [/\b422\b/, /store\.insertSpan\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()


class SpanIn(BaseModel):
    trace_id: str
    span_id: str
    parent_span_id: str | None = None
    service: str
    start_ms: int
    duration: float


class SpanStore:
    def insert_span(self, tenant: str, span: dict) -> bool:
        """Insert the span into the trace assembly; True when the span was new."""
        raise NotImplementedError


store = SpanStore()


@app.post("/v1/spans")
def ingest(body: SpanIn, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this draft trusts whatever the SDK sends. It checks neither id shape, accepts a span
    # whose parent is itself, and reads the SDK's duration (seconds) as if it were milliseconds.
    # Validate the ids, reject a self-parent, name the unit explicitly, and only then store.
    span = {
        "trace_id": body.trace_id,
        "span_id": body.span_id,
        "parent_span_id": body.parent_span_id or "",
        "service": body.service,
        "start_ms": body.start_ms,
        "duration_ms": int(body.duration),
    }
    created = store.insert_span(tenant, span)
    return JSONResponse(
        {
            "trace_id": body.trace_id,
            "span_id": body.span_id,
            "service": body.service,
            "duration_ms": int(body.duration),
            "duplicate": not created,
        },
        status_code=202,
    )
`,
      solution: `import re

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict

app = FastAPI()

TRACE_ID_RE = re.compile(r"^[0-9a-f]{32}$")
SPAN_ID_RE = re.compile(r"^[0-9a-f]{16}$")
DURATION_UNIT = "ms"
MAX_DURATION_MS = 30 * 60 * 1000
MAX_SERVICE_LEN = 64


class SpanIn(BaseModel):
    # A seconds field is rejected by the model instead of being read as milliseconds.
    model_config = ConfigDict(extra="forbid")

    trace_id: str
    span_id: str
    parent_span_id: str | None = None
    service: str
    start_ms: int
    duration_ms: int


class SpanStore:
    def insert_span(self, tenant: str, span: dict) -> bool:
        """Insert the span into the trace assembly; True when the span was new."""
        raise NotImplementedError


store = SpanStore()


@app.post("/v1/spans")
def ingest(body: SpanIn, tenant: str | None = Header(default=None, alias="X-Tenant-Id")) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if not TRACE_ID_RE.match(body.trace_id):
        raise HTTPException(status_code=422, detail="trace_id must be 32 lowercase hex characters")
    if not SPAN_ID_RE.match(body.span_id):
        raise HTTPException(status_code=422, detail="span_id must be 16 lowercase hex characters")
    if body.parent_span_id is not None and body.parent_span_id != "" and not SPAN_ID_RE.match(body.parent_span_id):
        raise HTTPException(status_code=422, detail="parent_span_id must be 16 lowercase hex characters")
    if body.parent_span_id == body.span_id:
        raise HTTPException(status_code=422, detail="a span cannot be its own parent")
    if body.service == "" or len(body.service) > MAX_SERVICE_LEN:
        raise HTTPException(status_code=422, detail="service must be 1..64 characters")
    if body.start_ms < 0:
        raise HTTPException(status_code=422, detail="start_ms must be an epoch millisecond")
    if body.duration_ms < 0 or body.duration_ms > MAX_DURATION_MS:
        raise HTTPException(status_code=422, detail="duration_ms must be 0..1800000")

    span = {
        "trace_id": body.trace_id,
        "span_id": body.span_id,
        "parent_span_id": body.parent_span_id or "",
        "service": body.service,
        "start_ms": body.start_ms,
        "duration_ms": body.duration_ms,
    }
    created = store.insert_span(tenant, span)
    return JSONResponse(
        {
            "trace_id": body.trace_id,
            "span_id": body.span_id,
            "service": body.service,
            "duration_ms": body.duration_ms,
            "duration_unit": DURATION_UNIT,
            "duplicate": not created,
        },
        status_code=202,
    )
`,
    },
    typescript: {
      starter: `/** POST /v1/spans: a model-generated draft that trusts the SDK's own units. */
import Fastify from 'fastify';

import {store} from './span_store';

export const app = Fastify();

interface SpanBody {
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  service: string;
  start_ms: number;
  duration: number;
}

app.post('/v1/spans', async (request, reply) => {
  // TODO: this draft trusts whatever the SDK sends. It checks neither id shape, accepts a span
  // whose parent is itself, and reads the SDK's \`duration\` (seconds) as if it were milliseconds.
  // Validate the ids, reject a self-parent, name the unit explicitly, and only then store.
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as SpanBody;
  const durationMs = Math.round(body.duration);
  const created = await store.insertSpan(tenant, {
    trace_id: body.trace_id,
    span_id: body.span_id,
    parent_span_id: body.parent_span_id ?? '',
    service: body.service,
    start_ms: body.start_ms,
    duration_ms: durationMs,
  });
  return reply.code(202).send({
    trace_id: body.trace_id,
    span_id: body.span_id,
    service: body.service,
    duration_ms: durationMs,
    duplicate: !created,
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/spans: validate the edge, name the unit, then hand one span to the assembler. */
import Fastify from 'fastify';

import {store} from './span_store';

export const app = Fastify();

const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const SPAN_ID_RE = /^[0-9a-f]{16}$/;
const DURATION_UNIT = 'ms';
const MAX_DURATION_MS = 30 * 60 * 1000;
const MAX_SERVICE_LEN = 64;
const ALLOWED_FIELDS: Record<string, true> = {
  trace_id: true,
  span_id: true,
  parent_span_id: true,
  service: true,
  start_ms: true,
  duration_ms: true,
};

interface SpanBody {
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  service: string;
  start_ms: number;
  duration_ms: number;
}

app.post('/v1/spans', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});

  const raw = request.body;
  if (raw === null || typeof raw !== 'object') return reply.code(400).send({error: 'invalid json'});
  const body = raw as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (ALLOWED_FIELDS[key] !== true)
      return reply.code(422).send({error: \`unknown field \${key}: durations are milliseconds in duration_ms\`});
  }

  const traceId = body.trace_id;
  const spanId = body.span_id;
  const parentId = typeof body.parent_span_id === 'string' ? body.parent_span_id : '';
  if (typeof traceId !== 'string' || !TRACE_ID_RE.test(traceId))
    return reply.code(422).send({error: 'trace_id must be 32 lowercase hex characters'});
  if (typeof spanId !== 'string' || !SPAN_ID_RE.test(spanId))
    return reply.code(422).send({error: 'span_id must be 16 lowercase hex characters'});
  if (parentId !== '' && !SPAN_ID_RE.test(parentId))
    return reply.code(422).send({error: 'parent_span_id must be 16 lowercase hex characters'});
  if (parentId === spanId) return reply.code(422).send({error: 'a span cannot be its own parent'});

  const service = body.service;
  const startMs = body.start_ms;
  const durationMs = body.duration_ms;
  if (typeof service !== 'string' || service === '' || service.length > MAX_SERVICE_LEN)
    return reply.code(422).send({error: 'service must be 1..64 characters'});
  if (!Number.isInteger(startMs) || (startMs as number) < 0)
    return reply.code(422).send({error: 'start_ms must be an epoch millisecond'});
  if (!Number.isInteger(durationMs) || (durationMs as number) < 0 || (durationMs as number) > MAX_DURATION_MS)
    return reply.code(422).send({error: 'duration_ms must be 0..1800000'});

  const created = await store.insertSpan(tenant, {
    trace_id: traceId,
    span_id: spanId,
    parent_span_id: parentId,
    service,
    start_ms: startMs as number,
    duration_ms: durationMs as number,
  });
  return reply.code(202).send({
    trace_id: traceId,
    span_id: spanId,
    service,
    duration_ms: durationMs,
    duration_unit: DURATION_UNIT,
    duplicate: !created,
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"
)

type spanIn struct {
	TraceID      string  \`json:"trace_id"\`
	SpanID       string  \`json:"span_id"\`
	ParentSpanID string  \`json:"parent_span_id"\`
	Service      string  \`json:"service"\`
	StartMS      int64   \`json:"start_ms"\`
	Duration     float64 \`json:"duration"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

func ingest(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	var body spanIn
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft trusts whatever the SDK sends. It checks neither id shape, accepts a span
	// whose parent is itself, and reads the SDK's duration (seconds) as if it were milliseconds.
	// Validate the ids, reject a self-parent, name the unit explicitly, and only then store.
	span := map[string]any{
		"trace_id":       body.TraceID,
		"span_id":        body.SpanID,
		"parent_span_id": body.ParentSpanID,
		"service":        body.Service,
		"start_ms":       body.StartMS,
		"duration_ms":    int64(body.Duration),
	}
	created, err := store.InsertSpan(r.Context(), tenant, span)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "try again"})
		return
	}
	writeJSON(rw, http.StatusAccepted, map[string]any{
		"trace_id":    body.TraceID,
		"span_id":     body.SpanID,
		"service":     body.Service,
		"duration_ms": int64(body.Duration),
		"duplicate":   !created,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/spans", ingest)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"encoding/json"
	"log"
	"net/http"
	"regexp"
)

const (
	durationUnit  = "ms"
	maxDurationMS = int64(30 * 60 * 1000)
	maxServiceLen = 64
)

var (
	traceIDRe = regexp.MustCompile("^[0-9a-f]{32}$")
	spanIDRe  = regexp.MustCompile("^[0-9a-f]{16}$")
)

type spanIn struct {
	TraceID      string \`json:"trace_id"\`
	SpanID       string \`json:"span_id"\`
	ParentSpanID string \`json:"parent_span_id"\`
	Service      string \`json:"service"\`
	StartMS      int64  \`json:"start_ms"\`
	DurationMS   int64  \`json:"duration_ms"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

func ingest(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}

	decoder := json.NewDecoder(r.Body)
	// A seconds field is an unknown field: 422 instead of a silently mis-scaled duration.
	decoder.DisallowUnknownFields()
	var body spanIn
	if err := decoder.Decode(&body); err != nil {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{
			"error": "unknown or malformed field; durations are milliseconds in duration_ms",
		})
		return
	}
	if !traceIDRe.MatchString(body.TraceID) {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{
			"error": "trace_id must be 32 lowercase hex characters",
		})
		return
	}
	if !spanIDRe.MatchString(body.SpanID) {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{
			"error": "span_id must be 16 lowercase hex characters",
		})
		return
	}
	if body.ParentSpanID != "" && !spanIDRe.MatchString(body.ParentSpanID) {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{
			"error": "parent_span_id must be 16 lowercase hex characters",
		})
		return
	}
	if body.ParentSpanID == body.SpanID {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{
			"error": "a span cannot be its own parent",
		})
		return
	}
	if body.Service == "" || len(body.Service) > maxServiceLen {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{
			"error": "service must be 1..64 characters",
		})
		return
	}
	if body.StartMS < 0 {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{
			"error": "start_ms must be an epoch millisecond",
		})
		return
	}
	if body.DurationMS < 0 || body.DurationMS > maxDurationMS {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{
			"error": "duration_ms must be 0..1800000",
		})
		return
	}

	span := map[string]any{
		"trace_id":       body.TraceID,
		"span_id":        body.SpanID,
		"parent_span_id": body.ParentSpanID,
		"service":        body.Service,
		"start_ms":       body.StartMS,
		"duration_ms":    body.DurationMS,
	}
	created, err := store.InsertSpan(r.Context(), tenant, span)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "try again"})
		return
	}
	writeJSON(rw, http.StatusAccepted, map[string]any{
		"trace_id":      body.TraceID,
		"span_id":       body.SpanID,
		"service":       body.Service,
		"duration_ms":   body.DurationMS,
		"duration_unit": durationUnit,
		"duplicate":     !created,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/spans", ingest)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class SpanIn(
    trace_id: String,
    span_id: String,
    parent_span_id: Option[String],
    service: String,
    start_ms: Long,
    duration: Double
)

object Api {
  implicit val system: ActorSystem = ActorSystem("trace-collector")
  implicit val spanFormat: RootJsonFormat[SpanIn] = jsonFormat6(SpanIn)

  val store = SpanStore.open()

  val route: Route =
    path("v1" / "spans") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[SpanIn]) { body =>
            // TODO: this draft trusts whatever the SDK sends. It checks neither id shape, accepts a
            // span whose parent is itself, and reads the SDK's duration (seconds) as if it were
            // milliseconds. Validate the ids, reject a self-parent, name the unit, then store.
            val span = Map[String, Any](
              "trace_id" -> body.trace_id,
              "span_id" -> body.span_id,
              "parent_span_id" -> body.parent_span_id.getOrElse(""),
              "service" -> body.service,
              "start_ms" -> body.start_ms,
              "duration_ms" -> body.duration.toLong
            )
            store.insertSpan(tenant, span)
            complete(
              StatusCodes.Accepted,
              s"""{"trace_id":"\${body.trace_id}","span_id":"\${body.span_id}","service":"\${body.service}","duration_ms":\${body.duration.toLong}}"""
            )
          }
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
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.{JsObject, RootJsonFormat}

import scala.util.matching.Regex

final case class SpanIn(
    trace_id: String,
    span_id: String,
    parent_span_id: Option[String],
    service: String,
    start_ms: Long,
    duration_ms: Long
)

object Api {
  implicit val system: ActorSystem = ActorSystem("trace-collector")
  implicit val spanFormat: RootJsonFormat[SpanIn] = jsonFormat6(SpanIn)

  val TraceIdRe: Regex = "^[0-9a-f]{32}$".r
  val SpanIdRe: Regex = "^[0-9a-f]{16}$".r
  val DurationUnit = "ms"
  val MaxDurationMs = 30L * 60 * 1000
  val MaxServiceLen = 64
  val AllowedFields =
    Set("trace_id", "span_id", "parent_span_id", "service", "start_ms", "duration_ms")

  val store = SpanStore.open()

  def badRequest(reason: String, status: StatusCode = StatusCodes.UnprocessableEntity): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, s"""{"error":"$reason"}"""))

  val route: Route =
    path("v1" / "spans") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[JsObject]) { raw =>
            val unknown = raw.fields.keySet.diff(AllowedFields)
            if (unknown.nonEmpty) {
              // A seconds field is an unknown field: 422 instead of a silently mis-scaled duration.
              complete(badRequest(s"unknown field \${unknown.head}: durations are milliseconds in duration_ms"))
            } else {
              val body = raw.convertTo[SpanIn]
              val parentId = body.parent_span_id.getOrElse("")
              if (!TraceIdRe.matches(body.trace_id))
                complete(badRequest("trace_id must be 32 lowercase hex characters"))
              else if (!SpanIdRe.matches(body.span_id))
                complete(badRequest("span_id must be 16 lowercase hex characters"))
              else if (parentId != "" && !SpanIdRe.matches(parentId))
                complete(badRequest("parent_span_id must be 16 lowercase hex characters"))
              else if (parentId == body.span_id)
                complete(badRequest("a span cannot be its own parent"))
              else if (body.service.isEmpty || body.service.length > MaxServiceLen)
                complete(badRequest("service must be 1..64 characters"))
              else if (body.start_ms < 0)
                complete(badRequest("start_ms must be an epoch millisecond"))
              else if (body.duration_ms < 0 || body.duration_ms > MaxDurationMs)
                complete(badRequest("duration_ms must be 0..1800000"))
              else {
                val span = Map[String, Any](
                  "trace_id" -> body.trace_id,
                  "span_id" -> body.span_id,
                  "parent_span_id" -> parentId,
                  "service" -> body.service,
                  "start_ms" -> body.start_ms,
                  "duration_ms" -> body.duration_ms
                )
                val created = store.insertSpan(tenant, span)
                complete(
                  StatusCodes.Accepted,
                  s"""{"trace_id":"\${body.trace_id}","span_id":"\${body.span_id}","service":"\${body.service}","duration_ms":\${body.duration_ms},"duration_unit":"$DurationUnit","duplicate":\${!created}}"""
                )
              }
            }
          }
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
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

using json = nlohmann::json;

struct SpanStore {
  bool insertSpan(const std::string& tenant, const json& span);
};

SpanStore store;

int main() {
  httplib::Server svr;

  svr.Post("/v1/spans", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this draft trusts whatever the SDK sends. It checks neither id shape, accepts a span
    // whose parent is itself, and reads the SDK's duration (seconds) as if it were milliseconds.
    // Validate the ids, reject a self-parent, name the unit explicitly, and only then store.
    const double duration = body.value("duration", 0.0);
    const json span = {
        {"trace_id", body.value("trace_id", std::string())},
        {"span_id", body.value("span_id", std::string())},
        {"parent_span_id", body.value("parent_span_id", std::string())},
        {"service", body.value("service", std::string())},
        {"start_ms", body.value("start_ms", 0LL)},
        {"duration_ms", static_cast<long long>(duration)},
    };
    const bool created = store.insertSpan(tenant, span);
    res.status = 202;
    res.set_content(
        json{{"trace_id", span["trace_id"]},
             {"span_id", span["span_id"]},
             {"service", span["service"]},
             {"duration_ms", span["duration_ms"]},
             {"duplicate", !created}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <regex>
#include <set>
#include <string>

using json = nlohmann::json;

const std::regex kTraceIdRe("^[0-9a-f]{32}$");
const std::regex kSpanIdRe("^[0-9a-f]{16}$");
const std::string kDurationUnit = "ms";
constexpr long long kMaxDurationMs = 30LL * 60 * 1000;
constexpr std::size_t kMaxServiceLen = 64;
const std::set<std::string> kAllowedFields = {
    "trace_id", "span_id", "parent_span_id", "service", "start_ms", "duration_ms"};

struct SpanStore {
  bool insertSpan(const std::string& tenant, const json& span);
};

SpanStore store;

void reject(httplib::Response& res, int status, const std::string& reason) {
  res.status = status;
  res.set_content(json{{"error", reason}}.dump(), "application/json");
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/spans", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      reject(res, 401, "missing X-Tenant-Id");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      reject(res, 400, "invalid json");
      return;
    }
    for (const auto& field : body.items()) {
      if (kAllowedFields.count(field.key()) == 0) {
        // A seconds field is an unknown field: 422 instead of a mis-scaled duration.
        reject(res, 422, "unknown field " + field.key() + ": durations are milliseconds in duration_ms");
        return;
      }
    }
    const auto traceId = body.value("trace_id", std::string());
    const auto spanId = body.value("span_id", std::string());
    const auto parent = body.value("parent_span_id", std::string());
    if (!std::regex_match(traceId, kTraceIdRe)) {
      reject(res, 422, "trace_id must be 32 lowercase hex characters");
      return;
    }
    if (!std::regex_match(spanId, kSpanIdRe)) {
      reject(res, 422, "span_id must be 16 lowercase hex characters");
      return;
    }
    if (!parent.empty() && !std::regex_match(parent, kSpanIdRe)) {
      reject(res, 422, "parent_span_id must be 16 lowercase hex characters");
      return;
    }
    if (parent == spanId) {
      reject(res, 422, "a span cannot be its own parent");
      return;
    }
    const auto service = body.value("service", std::string());
    if (service.empty() || service.size() > kMaxServiceLen) {
      reject(res, 422, "service must be 1..64 characters");
      return;
    }
    const long long startMs = body.value("start_ms", -1LL);
    const long long durationMs = body.value("duration_ms", -1LL);
    if (startMs < 0) {
      reject(res, 422, "start_ms must be an epoch millisecond");
      return;
    }
    if (durationMs < 0 || durationMs > kMaxDurationMs) {
      reject(res, 422, "duration_ms must be 0..1800000");
      return;
    }

    const json span = {
        {"trace_id", traceId},
        {"span_id", spanId},
        {"parent_span_id", parent},
        {"service", service},
        {"start_ms", startMs},
        {"duration_ms", durationMs},
    };
    const bool created = store.insertSpan(tenant, span);
    res.status = 202;
    res.set_content(
        json{{"trace_id", traceId},
             {"span_id", spanId},
             {"service", service},
             {"duration_ms", durationMs},
             {"duration_unit", kDurationUnit},
             {"duplicate", !created}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The interviewer is testing whether you review a generated ingest handler at the trust boundary, and the tell is that every defect is a *shape* problem rather than a crash. Ids are the join key of the whole system: a trace id that is the wrong length does not fail anywhere, it simply produces a trace that no query will ever find, which is worse than an error because it looks like data loss during an incident. The self-parent is the cycle case that turns an assembly algorithm into an infinite expectation: the trace waits for a root that cannot exist. The unit is the quietest one and the most dangerous: a span whose duration is read in the wrong unit makes a slow path look fast, and a latency dashboard is exactly the artefact an on-call engineer trusts to decide whether to roll back. Real collectors add clock-skew correction between the SDK's \`start_ms\` and the collector's receipt, parse the W3C \`traceparent\` header, cap per-tenant ingest rates, and decide sampling at the edge — but all of that assumes the ids and units survived the door.`,
};
