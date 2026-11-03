import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/traces/{id}: the tree as it truly was',
  concept: 'http',
  file: 'read',
  focus: ['reader', 'collector', 'redis', 'storage'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/traces/{trace_id}\`: it loads the assembly state,
keeps the spans whose parent is present, renders them as a tree with per-span durations, marks the
trace complete and answers \`200\` to any tenant. The tree looks tidy because the starter removes
whatever did not fit, and it hides four flaws.

**Failure mode the checks target.** This is the step where an incident analysis is misled. The
starter's answer is internally consistent, every span it returns has a parent, so nobody doubts it;
the latency it shows is the sum of the spans present, with no timeline to place them on. And since
the endpoint does not compare the trace's owner with the caller, one tenant can read another's.

- The caller is authenticated by \`X-Tenant-Id\` (**401** when missing); a trace owned by another
  tenant is **404**, not 403, so "not yours" and "not there" are indistinguishable.
- The response carries \`root_span_id\` and one entry per stored span with \`span_id\`,
  \`parent_span_id\`, \`service\`, **\`start_ms\`** (absolute), \`duration_ms\` and
  **\`end_ms\` = \`start_ms\` + \`duration_ms\`**.
- Every parent reference that never got its span is reported in **\`gaps\`** (the
  \`parent_span_id\` and how many stored spans name it) and the trace is marked **\`partial\`** when
  the gap list is not empty.
- A missing trace is **404**; a malformed trace id is **422** before the state is read.`,
  sequence: {
    participants: ['Trace reader', 'Trace Collector', 'Redis'],
    messages: [
      {from: 'Trace reader', to: 'Trace Collector', label: 'GET /v1/traces/{id} · X-Tenant-Id', kind: 'sync'},
      {from: 'Trace Collector', to: 'Redis', label: 'HGETALL trace:{id}', kind: 'sync'},
      {from: 'Redis', to: 'Trace Collector', label: '{owner, root, count, missing, refs:…}', kind: 'reply'},
      {
        from: 'Trace Collector',
        to: 'Trace Collector',
        label: 'owner ≠ tenant → 404 · gaps = refs whose span never arrived',
        kind: 'sync',
      },
      {
        from: 'Trace Collector',
        to: 'Trace reader',
        label: '200 {root_span_id, partial: true, gaps, spans[start_ms…end_ms]}',
        kind: 'reply',
      },
      {
        from: 'Trace Collector',
        to: 'Trace reader',
        label: '404 {error} · someone else’s trace looks exactly like a missing one',
        kind: 'reply',
      },
    ],
  },
  hints: [
    'An on-call engineer opens a checkout trace, sees a short, complete-looking waterfall with no timeline, and rolls forward; the same URL also works with a tenant header that does not own the trace.',
    'The handler filters out spans whose parent is absent, hardcodes the trace as complete, emits durations without `start_ms`/`end_ms`, and reads the state without comparing its `owner` field to the caller.',
    'In `read_trace`, return 404 when `owner != tenant`, build `gaps` from the `refs:` fields whose span is absent, set `partial` from `missing = len(gaps)`, and add `end_ms = start_ms + duration_ms` per span.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/traces/{id}',
      detail: 'Register the read route on `GET /v1/traces/{trace_id}`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/traces\/\{trace_id\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/traces\/:trace_id['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/traces\/\{trace_id\}"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"traces"\s*\/\s*Segment\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(/, /\/v1\/traces\//]},
      },
    },
    {
      id: 'partial-marker',
      title: 'A partial trace is marked partial',
      detail:
        'The gap count decides an explicit `partial` marker in the response, so a trace whose child never arrived cannot be read as a complete one. The starter hardcodes a complete trace.',
      match: {
        python: {all: [/partial/, /missing = len\(gaps\)/]},
        typescript: {all: [/partial/, /missing = gaps\.length/]},
        go: {all: [/partial/, /missing := len\(gaps\)/]},
        scala: {all: [/partial/, /Missing = gaps\.size/]},
        cpp: {all: [/partial/, /missing = gaps\.size\(\)/]},
      },
    },
    {
      id: 'gaps-visible',
      title: 'Missing children appear as gaps',
      detail:
        'Every `refs:{span_id}` whose span is not in the state is reported in `gaps` with the number of spans waiting for it. The starter filters those spans out so the tree looks shorter, never empty.',
      match: {
        python: {all: [/gaps/, /refs/]},
        typescript: {all: [/gaps/, /refs/]},
        go: {all: [/gaps/, /trace\.Refs/]},
        scala: {all: [/gaps/, /refs:/]},
        cpp: {all: [/gaps/, /trace\.refs/]},
      },
    },
    {
      id: 'absolute-timestamps',
      title: 'Spans carry absolute start and end timestamps',
      detail:
        'Each span reports `start_ms`, `duration_ms` and `end_ms` (`start_ms + duration_ms`), so the waterfall places every span on the request’s absolute timeline. The starter returns durations only.',
      match: {
        python: {all: [/start_ms/, /duration_ms/, /end_ms/]},
        typescript: {all: [/start_ms/, /duration_ms/, /end_ms/]},
        go: {all: [/start_ms/, /duration_ms/, /end_ms/]},
        scala: {all: [/start_ms/, /duration_ms/, /end_ms/]},
        cpp: {all: [/start_ms/, /duration_ms/, /end_ms/]},
      },
    },
    {
      id: 'tenant-scope',
      title: 'Trace access is scoped to the owning tenant',
      detail:
        'The trace’s recorded owner is compared with the authenticated caller and a foreign trace is **404**, so the read path cannot be used to enumerate or read another tenant’s traces. The starter serves any trace to any caller.',
      match: {
        python: {all: [/owner != tenant/, /status_code\s*=\s*404/]},
        typescript: {all: [/owner !== tenant/, /code\(\s*404\s*\)/]},
        go: {all: [/owner != tenant/, /StatusNotFound/]},
        scala: {all: [/owner != tenant/, /StatusCodes\.NotFound/]},
        cpp: {all: [/owner != tenant/, /\b404\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Header

app = FastAPI()


class TraceReader:
    def load(self, trace_id: str) -> dict | None:
        """The assembled trace: owner, root, spans and refs (parent id → spans waiting)."""
        raise NotImplementedError


store = TraceReader()


@app.get("/v1/traces/{trace_id}")
def read_trace(trace_id: str, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    trace = store.load(trace_id)
    stored = {span["span_id"] for span in trace["spans"]}
    spans = [
        span
        for span in trace["spans"]
        if span["parent_span_id"] == "" or span["parent_span_id"] in stored
    ]
    return {
        "trace_id": trace_id,
        "root_span_id": trace["root"],
        "complete": True,
        "spans": [
            {
                "span_id": span["span_id"],
                "service": span["service"],
                "duration_ms": span["duration_ms"],
            }
            for span in spans
        ],
    }
`,
      solution: `import re

from fastapi import FastAPI, Header, HTTPException

app = FastAPI()

TRACE_ID_RE = re.compile(r"^[0-9a-f]{32}$")


class TraceReader:
    def load(self, trace_id: str) -> dict | None:
        """The assembled trace: owner, root, spans and refs (parent id → spans waiting)."""
        raise NotImplementedError


store = TraceReader()


@app.get("/v1/traces/{trace_id}")
def read_trace(trace_id: str, tenant: str | None = Header(default=None, alias="X-Tenant-Id")) -> dict:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if not TRACE_ID_RE.match(trace_id):
        raise HTTPException(status_code=422, detail="trace_id must be 32 lowercase hex characters")
    trace = store.load(trace_id)
    if trace is None:
        raise HTTPException(status_code=404, detail="no such trace")

    owner = trace["owner"]
    # Someone else's trace is a 404, not a 403: "not yours" must be indistinguishable from "not here".
    if owner != tenant:
        raise HTTPException(status_code=404, detail="no such trace")

    stored = {span["span_id"] for span in trace["spans"]}
    gaps = [
        {"parent_span_id": parent_id, "expected_by": refs}
        for parent_id, refs in trace["refs"].items()
        if parent_id not in stored
    ]
    missing = len(gaps)
    spans = [
        {
            "span_id": span["span_id"],
            "parent_span_id": span["parent_span_id"],
            "service": span["service"],
            "start_ms": span["start_ms"],
            "duration_ms": span["duration_ms"],
            "end_ms": span["start_ms"] + span["duration_ms"],
        }
        for span in trace["spans"]
    ]
    return {
        "trace_id": trace_id,
        "root_span_id": trace["root"],
        "partial": missing > 0,
        "gaps": gaps,
        "spans": spans,
    }
`,
    },
    typescript: {
      starter: `/** GET /v1/traces/{id}. */
import Fastify from 'fastify';

import {store} from './trace_store';

export const app = Fastify();

interface Span {
  span_id: string;
  parent_span_id: string;
  service: string;
  start_ms: number;
  duration_ms: number;
}

app.get('/v1/traces/:trace_id', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const {trace_id: traceId} = request.params as {trace_id: string};
  const trace = await store.load(traceId);
  const stored = new Set(trace.spans.map((span: Span) => span.span_id));
  const spans = trace.spans
    .filter((span: Span) => span.parent_span_id === '' || stored.has(span.parent_span_id))
    .map((span: Span) => ({
      span_id: span.span_id,
      service: span.service,
      duration_ms: span.duration_ms,
    }));
  return reply.code(200).send({trace_id: traceId, root_span_id: trace.root, complete: true, spans});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/traces/{id}: the tree as it was, with the gaps and the owning tenant. */
import Fastify from 'fastify';

import {store} from './trace_store';

export const app = Fastify();

const TRACE_ID_RE = /^[0-9a-f]{32}$/;

interface Span {
  span_id: string;
  parent_span_id: string;
  service: string;
  start_ms: number;
  duration_ms: number;
}

interface TraceState {
  owner: string;
  root: string;
  spans: Span[];
  refs: Record<string, number>;
}

app.get('/v1/traces/:trace_id', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {trace_id: traceId} = request.params as {trace_id: string};
  if (!TRACE_ID_RE.test(traceId)) return reply.code(422).send({error: 'trace_id must be 32 hex characters'});

  const trace = (await store.load(traceId)) as TraceState | null;
  if (trace === null) return reply.code(404).send({error: 'no such trace'});

  const owner = trace.owner;
  // Someone else's trace is a 404, not a 403: "not yours" must be indistinguishable from "not here".
  if (owner !== tenant) return reply.code(404).send({error: 'no such trace'});

  const stored = new Set(trace.spans.map(span => span.span_id));
  const gaps = Object.entries(trace.refs)
    .filter(([parentId]) => !stored.has(parentId))
    .map(([parentId, waiting]) => ({parent_span_id: parentId, expected_by: waiting}));
  const missing = gaps.length;

  return reply.code(200).send({
    trace_id: traceId,
    root_span_id: trace.root,
    partial: missing > 0,
    gaps,
    spans: trace.spans.map(span => ({
      span_id: span.span_id,
      parent_span_id: span.parent_span_id,
      service: span.service,
      start_ms: span.start_ms,
      duration_ms: span.duration_ms,
      end_ms: span.start_ms + span.duration_ms,
    })),
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

type traceSpan struct {
	SpanID       string \`json:"span_id"\`
	ParentSpanID string \`json:"parent_span_id"\`
	Service      string \`json:"service"\`
	StartMS      int64  \`json:"start_ms"\`
	DurationMS   int64  \`json:"duration_ms"\`
}

type traceState struct {
	Owner  string           \`json:"owner"\`
	Root   string           \`json:"root"\`
	Spans  []traceSpan      \`json:"spans"\`
	Refs   map[string]int64 \`json:"refs"\`
}

func readTrace(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	traceID := r.PathValue("trace_id")
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	trace := store.Load(r.Context(), traceID)
	stored := map[string]bool{}
	for _, span := range trace.Spans {
		stored[span.SpanID] = true
	}
	spans := []map[string]any{}
	for _, span := range trace.Spans {
		if span.ParentSpanID == "" || stored[span.ParentSpanID] {
			spans = append(spans, map[string]any{
				"span_id":     span.SpanID,
				"service":     span.Service,
				"duration_ms": span.DurationMS,
			})
		}
	}
	rw.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(rw).Encode(map[string]any{
		"trace_id":     traceID,
		"root_span_id": trace.Root,
		"complete":     true,
		"spans":        spans,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/traces/{trace_id}", readTrace)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"regexp"
)

var traceIDRe = regexp.MustCompile("^[0-9a-f]{32}$")

type traceSpan struct {
	SpanID       string \`json:"span_id"\`
	ParentSpanID string \`json:"parent_span_id"\`
	Service      string \`json:"service"\`
	StartMS      int64  \`json:"start_ms"\`
	DurationMS   int64  \`json:"duration_ms"\`
}

type traceState struct {
	Owner string           \`json:"owner"\`
	Root  string           \`json:"root"\`
	Spans []traceSpan      \`json:"spans"\`
	Refs  map[string]int64 \`json:"refs"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

func readTrace(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	traceID := r.PathValue("trace_id")
	if !traceIDRe.MatchString(traceID) {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{
			"error": "trace_id must be 32 lowercase hex characters",
		})
		return
	}
	trace := store.Load(r.Context(), traceID)
	if trace == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such trace"})
		return
	}
	owner := trace.Owner
	// Someone else's trace is a 404, not a 403: "not yours" must be indistinguishable from "not here".
	if owner != tenant {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such trace"})
		return
	}

	stored := map[string]bool{}
	for _, span := range trace.Spans {
		stored[span.SpanID] = true
	}
	gaps := []map[string]any{}
	for parentID, waiting := range trace.Refs {
		if !stored[parentID] {
			gaps = append(gaps, map[string]any{"parent_span_id": parentID, "expected_by": waiting})
		}
	}
	missing := len(gaps)

	spans := []map[string]any{}
	for _, span := range trace.Spans {
		spans = append(spans, map[string]any{
			"span_id":        span.SpanID,
			"parent_span_id": span.ParentSpanID,
			"service":        span.Service,
			"start_ms":       span.StartMS,
			"duration_ms":    span.DurationMS,
			"end_ms":         span.StartMS + span.DurationMS,
		})
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"trace_id":     traceID,
		"root_span_id": trace.Root,
		"partial":      missing > 0,
		"gaps":         gaps,
		"spans":        spans,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/traces/{trace_id}", readTrace)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}

var _ = fmt.Sprintf
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

final case class TraceSpan(
    span_id: String,
    parent_span_id: String,
    service: String,
    start_ms: Long,
    duration_ms: Long
)

final case class TraceState(owner: String, root: String, spans: List[TraceSpan], refs: Map[String, Int])

object ReadApi {
  implicit val system: ActorSystem = ActorSystem("trace-collector")

  val store = TraceReader.open()

  val route: Route =
    path("v1" / "traces" / Segment) { traceId =>
      get {
        headerValueByName("X-Tenant-Id") { tenant =>
          // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
          val trace = store.load(traceId)
          val stored = trace.spans.map(_.span_id).toSet
          val spans = trace.spans
            .filter(span => span.parent_span_id.isEmpty || stored.contains(span.parent_span_id))
            .map(span =>
              JsObject(
                "span_id" -> JsString(span.span_id),
                "service" -> JsString(span.service),
                "duration_ms" -> JsNumber(span.duration_ms)
              )
            )
          complete(
            StatusCodes.OK,
            JsObject(
              "trace_id" -> JsString(traceId),
              "root_span_id" -> JsString(trace.root),
              "complete" -> JsBoolean(true),
              "spans" -> JsArray(spans.toVector)
            ).compactPrint
          )
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
import spray.json._

import scala.util.matching.Regex

final case class TraceSpan(
    span_id: String,
    parent_span_id: String,
    service: String,
    start_ms: Long,
    duration_ms: Long
)

final case class TraceState(owner: String, root: String, spans: List[TraceSpan], refs: Map[String, Int])

object ReadApi {
  implicit val system: ActorSystem = ActorSystem("trace-collector")

  val TraceIdRe: Regex = "^[0-9a-f]{32}$".r
  val store = TraceReader.open()

  val route: Route =
    path("v1" / "traces" / Segment) { traceId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          if (!tenantOpt.exists(_.nonEmpty))
            complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
          else if (!TraceIdRe.matches(traceId))
            complete(StatusCodes.UnprocessableEntity, """{"error":"trace_id must be 32 hex characters"}""")
          else
            store.load(traceId) match {
              case None =>
                complete(StatusCodes.NotFound, """{"error":"no such trace"}""")
              case Some(trace) =>
                val tenant = tenantOpt.get
                val owner = trace.owner
                // Someone else's trace is a 404, not a 403: "not yours" looks like "not here".
                if (owner != tenant) {
                  complete(StatusCodes.NotFound, """{"error":"no such trace"}""")
                } else {
                  val stored = trace.spans.map(_.span_id).toSet
                  val gaps = trace.refs.toList
                    .filter { case (parentId, _) => !stored.contains(parentId) }
                    .map { case (parentId, waiting) =>
                      JsObject(
                        "parent_span_id" -> JsString(parentId),
                        "expected_by" -> JsNumber(waiting)
                      )
                    }
                  val Missing = gaps.size
                  val spans = trace.spans.map { span =>
                    JsObject(
                      "span_id" -> JsString(span.span_id),
                      "parent_span_id" -> JsString(span.parent_span_id),
                      "service" -> JsString(span.service),
                      "start_ms" -> JsNumber(span.start_ms),
                      "duration_ms" -> JsNumber(span.duration_ms),
                      "end_ms" -> JsNumber(span.start_ms + span.duration_ms)
                    )
                  }
                  complete(
                    StatusCodes.OK,
                    JsObject(
                      "trace_id" -> JsString(traceId),
                      "root_span_id" -> JsString(trace.root),
                      "partial" -> JsBoolean(Missing > 0),
                      "gaps" -> JsArray(gaps.toVector),
                      "spans" -> JsArray(spans.toVector)
                    ).compactPrint
                  )
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
#include <vector>

using json = nlohmann::json;

struct TraceSpan {
  std::string span_id;
  std::string parent_span_id;
  std::string service;
  long long start_ms = 0;
  long long duration_ms = 0;
};

struct traceState {
  std::string owner;
  std::string root;
  std::vector<TraceSpan> spans;
  std::map<std::string, long long> refs;
};

traceState loadTrace(const std::string& traceId);

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/traces/([0-9a-f]{32}))", [](const httplib::Request& req, httplib::Response& res) {
    const std::string traceId = req.matches[1];
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    const traceState trace = loadTrace(traceId);
    std::set<std::string> stored;
    for (const auto& span : trace.spans) stored.insert(span.span_id);

    json spans = json::array();
    for (const auto& span : trace.spans) {
      if (span.parent_span_id.empty() || stored.count(span.parent_span_id) > 0) {
        spans.push_back(json{{"span_id", span.span_id},
                             {"service", span.service},
                             {"duration_ms", span.duration_ms}});
      }
    }
    res.status = 200;
    res.set_content(
        json{{"trace_id", traceId}, {"root_span_id", trace.root}, {"complete", true}, {"spans", spans}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <map>
#include <regex>
#include <set>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::regex kTraceIdRe("^[0-9a-f]{32}$");

struct TraceSpan {
  std::string span_id;
  std::string parent_span_id;
  std::string service;
  long long start_ms = 0;
  long long duration_ms = 0;
};

struct traceState {
  std::string owner;
  std::string root;
  std::vector<TraceSpan> spans;
  std::map<std::string, long long> refs;
};

traceState loadTrace(const std::string& traceId);

void reject(httplib::Response& res, int status, const std::string& reason) {
  res.status = status;
  res.set_content(json{{"error", reason}}.dump(), "application/json");
}

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/traces/([0-9a-f]{32}))", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      reject(res, 401, "missing X-Tenant-Id");
      return;
    }
    const std::string traceId = req.matches[1];
    if (!std::regex_match(traceId, kTraceIdRe)) {
      reject(res, 422, "trace_id must be 32 lowercase hex characters");
      return;
    }

    const traceState trace = loadTrace(traceId);
    const std::string owner = trace.owner;
    // Someone else's trace is a 404, not a 403: "not yours" looks exactly like "not here".
    if (owner != tenant) {
      reject(res, 404, "no such trace");
      return;
    }

    std::set<std::string> stored;
    for (const auto& span : trace.spans) stored.insert(span.span_id);

    json gaps = json::array();
    for (const auto& [parentId, waiting] : trace.refs) {
      if (stored.count(parentId) == 0)
        gaps.push_back(json{{"parent_span_id", parentId}, {"expected_by", waiting}});
    }
    const std::size_t missing = gaps.size();

    json spans = json::array();
    for (const auto& span : trace.spans) {
      spans.push_back(json{{"span_id", span.span_id},
                           {"parent_span_id", span.parent_span_id},
                           {"service", span.service},
                           {"start_ms", span.start_ms},
                           {"duration_ms", span.duration_ms},
                           {"end_ms", span.start_ms + span.duration_ms}});
    }

    res.status = 200;
    res.set_content(
        json{{"trace_id", traceId},
             {"root_span_id", trace.root},
             {"partial", missing > 0},
             {"gaps", gaps},
             {"spans", spans}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The fix reports the gaps instead of hiding them because a trace that stopped half way is the normal case: a service crashed, an exporter flushed before its parent arrived, a sampler dropped a span. The starter's answer hides all of that and stays internally consistent, which is what makes it dangerous; an on-call engineer reads a shorter waterfall and concludes the request was fast. Marking the trace partial and attaching absolute timestamps turns it into a usable answer: here is the tree, here is what is missing, place it on the timeline before concluding anything. The owner check makes the read path a data boundary; 404 for a foreign trace keeps it from enumerating what exists. Production platforms add a redaction pass over attributes before they reach a browser.`,
};
