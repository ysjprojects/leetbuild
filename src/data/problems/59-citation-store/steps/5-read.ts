import type {Step} from '@/lib/types';

export const readCitationsStep: Step = {
  id: 'read',
  title: 'GET /v1/citations/{id}: an answer that names its evidence',
  concept: 'http',
  guides: ['honest-reads', 'request-boundaries', 'model-output'],
  file: 'read',
  focus: ['client', 'api', 'db'],
  task: `## Task

**Starting point.** The starter serves the read side: \`GET /v1/citations/{citation_id}\` answers
\`evidence(citation)\` for \`store.get(citation_id)\`, and \`GET /v1/answers/{answer_id}/citations\`
answers \`{answer_id, status, citations}\` for \`store.for_answer(answer_id)\`. \`evidence\` is
\`{id, quote, status}\`, the status being \`verified\` whenever \`documents.latest\` finds the document;
the answer's status is its first citation's. It serves the demo and hides four flaws.

**Failure mode the checks target.** Any tenant can read any citation by id; a reader cannot check a
quote that comes without its version and offsets; a citation the verifier marked broken reads as
verified because its document still exists; and an answer with one broken citation reports itself
verified.

- \`X-Tenant-Id\` is required (**401**). Another tenant's citation is **404**, the same answer as a
  missing one; the answer list holds only the caller's citations (none: **404**).
- \`evidence\` is \`{id, document_id, version, start, end, quote, status, reason}\` as stored.
- The status is the **stored verification** (step 4 commits it), never a guess.
- \`answer_status(citations)\` is the worst status by \`STATUS_RANK\` (\`verified\` < \`pending\` <
  \`broken\`), and any broken citation makes the answer \`ANSWER_DEGRADED\` (\`degraded\`).`,
  sequence: {
    participants: ['Client', 'Citation API', 'citation store'],
    messages: [
      {from: 'Client', to: 'Citation API', label: 'GET /v1/citations/{id} · X-Tenant-Id', kind: 'sync'},
      {from: 'Citation API', to: 'citation store', label: 'get(citation_id)', kind: 'sync'},
      {from: 'citation store', to: 'Citation API', label: 'row with tenant, span, stored status', kind: 'reply'},
      {
        from: 'Citation API',
        to: 'Client',
        label: '404 for another tenant’s citation · evidence otherwise',
        kind: 'reply',
      },
      {from: 'Client', to: 'Citation API', label: 'GET /v1/answers/{answer_id}/citations', kind: 'sync'},
      {from: 'Citation API', to: 'citation store', label: 'for_answer(answer_id) · keep the tenant’s', kind: 'sync'},
      {
        from: 'Citation API',
        to: 'Client',
        label: '200 {status: worst by STATUS_RANK · broken → degraded, citations}',
        kind: 'reply',
      },
    ],
  },
  hints: [
    'Read a citation with another tenant’s header: it comes back. Mark a citation broken and read it: it says verified, with no version or offsets to check, and its answer still reports verified.',
    'The read never compares the row’s tenant, builds the status from whether the document exists instead of the stored verdict, drops version, start, end and reason, and copies the first citation’s status onto the answer.',
    'Answer 401 without a tenant and 404 when `citation["tenant"] != tenant`; return every stored evidence field; filter the answer list by tenant; compute `answer_status` as the max by `STATUS_RANK`, `broken` → `ANSWER_DEGRADED`.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Serves a citation and an answer’s citations',
      detail: 'Register `GET /v1/citations/{citation_id}` and `GET /v1/answers/{answer_id}/citations`.',
      match: {
        python: {
          all: [
            /@app\.get\(\s*["']\/v1\/citations\/\{citation_id\}["']/,
            /@app\.get\(\s*["']\/v1\/answers\/\{answer_id\}\/citations["']/,
          ],
        },
        typescript: {
          all: [
            /app\.get\(\s*['"]\/v1\/citations\/:citationId['"]/,
            /app\.get\(\s*['"]\/v1\/answers\/:answerId\/citations['"]/,
          ],
        },
        go: {
          all: [
            /HandleFunc\(\s*"GET \/v1\/citations\/\{id\}"/,
            /HandleFunc\(\s*"GET \/v1\/answers\/\{id\}\/citations"/,
          ],
        },
        scala: {
          all: [
            /path\(\s*"v1"\s*\/\s*"citations"\s*\/\s*Segment\s*\)/,
            /path\(\s*"v1"\s*\/\s*"answers"\s*\/\s*Segment\s*\/\s*"citations"\s*\)/,
          ],
        },
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/citations\//, /svr\.Get\(\s*R"\(\/v1\/answers\//]},
      },
    },
    {
      id: 'tenant-404',
      title: 'Another tenant’s citation is 404',
      detail:
        'A missing `X-Tenant-Id` is **401**; a citation whose row belongs to another tenant answers **404** like a missing one (a 403 would confirm it exists), and an answer list holds only the caller’s citations. The starter serves any tenant anything.',
      match: {
        python: {all: [/\b401\b/, /\[["']tenant["']\]\s*[!=]=\s*tenant/, /\b404\b/]},
        typescript: {all: [/code\(\s*401\s*\)/, /\.tenant\s*[!=]==?\s*tenant/, /code\(\s*404\s*\)/]},
        go: {all: [/StatusUnauthorized|\b401\b/, /\.Tenant\s*[!=]=\s*tenant/, /StatusNotFound|\b404\b/]},
        scala: {all: [/Unauthorized|\b401\b/, /\.tenant\s*[!=]=\s*tenant/, /NotFound|\b404\b/]},
        cpp: {all: [/\b401\b/, /\.tenant\s*[!=]=\s*tenant/, /\b404\b/]},
      },
    },
    {
      id: 'evidence-shape',
      title: 'The citation names its evidence in full',
      detail:
        'The evidence carries `document_id`, `version`, `start`, `end`, `quote`, `status` and `reason` as stored, so a reader can check the quote against the bytes. The starter answers a quote and a status only.',
      match: {
        python: {all: [/["']version["']/, /["']start["']/, /["']end["']/, /["']reason["']/]},
        typescript: {all: [/\bversion:/, /\bstart:/, /\bend:/, /\breason:/]},
        go: {all: [/"version"/, /"start"/, /"end"/, /"reason"/]},
        scala: {all: [/"version"/, /"start"/, /"end"/, /"reason"/]},
        cpp: {all: [/"version"/, /"start"/, /"end"/, /"reason"/]},
      },
    },
    {
      id: 'stored-status',
      title: 'The status is the stored verification',
      detail:
        'The evidence returns the status and reason the verifier committed. The starter answers `verified` whenever the document still exists, which says nothing about whether the quote is in it.',
      match: {
        python: {all: [/\bstatus\b/], none: [/documents\.latest\(/]},
        typescript: {all: [/\bstatus\b/], none: [/\blatest\(/]},
        go: {all: [/\bStatus\b/], none: [/documents\.Latest\(/]},
        scala: {all: [/\bstatus\b/], none: [/Documents\.latest\(/]},
        cpp: {all: [/\bstatus\b/], none: [/documents::latest\(/]},
      },
    },
    {
      id: 'worst-status',
      title: 'The answer reports its worst citation',
      detail:
        '`answer_status` ranks the statuses with `STATUS_RANK` and returns the worst; a broken citation makes the answer `ANSWER_DEGRADED`. The starter copies the first citation’s status, so a broken one further down disappears.',
      match: {
        python: {all: [/STATUS_RANK/, /def answer_status\(/, /ANSWER_DEGRADED/], none: [/\[0\]\[["']status["']\]/]},
        typescript: {all: [/STATUS_RANK/, /function answerStatus\(/, /ANSWER_DEGRADED/], none: [/\[0\]\.status/]},
        go: {all: [/statusRank/, /func answerStatus\(/, /answerDegraded/], none: [/\[0\]\.Status/]},
        scala: {all: [/StatusRank/, /def answerStatus\(/, /AnswerDegraded/], none: [/\.head\b/]},
        cpp: {
          all: [/kStatusRank/, /answerStatus\(/, /kAnswerDegraded/],
          none: [/\[0\]\["status"\]|\.front\(\)\["status"\]/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from citations import documents, store  # documents.latest; store.get, store.for_answer

app = FastAPI()


def evidence(citation: dict) -> dict:
    """What a reader sees of a citation."""
    exists = documents.latest(citation["document_id"]) is not None
    return {"id": citation["id"], "quote": citation["quote"], "status": "verified" if exists else "broken"}


@app.get("/v1/citations/{citation_id}")
def read_citation(citation_id: str, request: Request) -> JSONResponse:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    citation = store.get(citation_id)
    if citation is None:
        return JSONResponse({"error": "no such citation"}, status_code=404)
    return JSONResponse(evidence(citation))


@app.get("/v1/answers/{answer_id}/citations")
def read_answer(answer_id: str, request: Request) -> JSONResponse:
    citations = [evidence(citation) for citation in store.for_answer(answer_id)]
    if not citations:
        return JSONResponse({"error": "no such answer"}, status_code=404)
    return JSONResponse({"answer_id": answer_id, "status": citations[0]["status"], "citations": citations})
`,
      solution: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from citations import store  # store.get, store.for_answer

app = FastAPI()

STATUS_RANK = {"verified": 0, "pending": 1, "broken": 2}
ANSWER_DEGRADED = "degraded"
EVIDENCE = ("id", "document_id", "version", "start", "end", "quote", "status", "reason")


def evidence(citation: dict) -> dict:
    """What a reader needs to check the quote against the document, and the verifier's stored verdict."""
    return {name: citation[name] for name in EVIDENCE}


def answer_status(citations: list[dict]) -> str:
    """The worst status among the citations; one broken citation makes the whole answer degraded."""
    worst = max((citation["status"] for citation in citations), key=lambda status: STATUS_RANK[status], default="verified")
    return ANSWER_DEGRADED if worst == "broken" else worst


@app.get("/v1/citations/{citation_id}")
def read_citation(citation_id: str, request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        return JSONResponse({"error": "X-Tenant-Id is required"}, status_code=401)
    citation = store.get(citation_id)
    # Another tenant's citation is answered like a missing one: a 403 would confirm it exists.
    if citation is None or citation["tenant"] != tenant:
        return JSONResponse({"error": "no such citation"}, status_code=404)
    return JSONResponse(evidence(citation))


@app.get("/v1/answers/{answer_id}/citations")
def read_answer(answer_id: str, request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        return JSONResponse({"error": "X-Tenant-Id is required"}, status_code=401)
    citations = [evidence(citation) for citation in store.for_answer(answer_id) if citation["tenant"] == tenant]
    if not citations:
        return JSONResponse({"error": "no such answer"}, status_code=404)
    return JSONResponse({"answer_id": answer_id, "status": answer_status(citations), "citations": citations})
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {latest} from 'citations/documents';
import {type Citation, forAnswer, get} from 'citations/store';

export const app = Fastify();

/** What a reader sees of a citation. */
async function evidence(citation: Citation) {
  const exists = (await latest(citation.document_id)) !== null;
  return {id: citation.id, quote: citation.quote, status: exists ? 'verified' : 'broken'};
}

app.get('/v1/citations/:citationId', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const {citationId} = request.params as {citationId: string};
  const citation = await get(citationId);
  if (citation === null) return reply.code(404).send({error: 'no such citation'});
  return evidence(citation);
});

app.get('/v1/answers/:answerId/citations', async (request, reply) => {
  const {answerId} = request.params as {answerId: string};
  const citations = await Promise.all((await forAnswer(answerId)).map(evidence));
  if (citations.length === 0) return reply.code(404).send({error: 'no such answer'});
  return {answer_id: answerId, status: citations[0].status, citations};
});
`,
      solution: `import Fastify from 'fastify';

import {type Citation, forAnswer, get} from 'citations/store';

export const app = Fastify();

export const STATUS_RANK: Record<string, number> = {verified: 0, pending: 1, broken: 2};
export const ANSWER_DEGRADED = 'degraded';

/** What a reader needs to check the quote against the document, and the verifier's stored verdict. */
function evidence(c: Citation) {
  return {
    id: c.id,
    document_id: c.document_id,
    version: c.version,
    start: c.start,
    end: c.end,
    quote: c.quote,
    status: c.status,
    reason: c.reason,
  };
}

/** The worst status among the citations; one broken citation makes the whole answer degraded. */
export function answerStatus(citations: {status: string}[]): string {
  let worst = 'verified';
  for (const {status} of citations) if (STATUS_RANK[status] > STATUS_RANK[worst]) worst = status;
  return worst === 'broken' ? ANSWER_DEGRADED : worst;
}

app.get('/v1/citations/:citationId', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {citationId} = request.params as {citationId: string};
  const citation = await get(citationId);
  // Another tenant's citation is answered like a missing one: a 403 would confirm it exists.
  if (citation === null || citation.tenant !== tenant) return reply.code(404).send({error: 'no such citation'});
  return evidence(citation);
});

app.get('/v1/answers/:answerId/citations', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {answerId} = request.params as {answerId: string};
  const citations = (await forAnswer(answerId)).filter(c => c.tenant === tenant).map(evidence);
  if (citations.length === 0) return reply.code(404).send({error: 'no such answer'});
  return {answer_id: answerId, status: answerStatus(citations), citations};
});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"net/http"

	"citations/documents" // documents.Latest
	"citations/store"     // store.Get, store.ForAnswer
)

type evidence struct {
	ID     string \`json:"id"\`
	Quote  string \`json:"quote"\`
	Status string \`json:"status"\`
}

type answerView struct {
	AnswerID  string     \`json:"answer_id"\`
	Status    string     \`json:"status"\`
	Citations []evidence \`json:"citations"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

// evidenceOf is what a reader sees of a citation.
func evidenceOf(ctx context.Context, c store.Citation) evidence {
	status := "broken"
	if _, exists := documents.Latest(ctx, c.DocumentID); exists {
		status = "verified"
	}
	return evidence{ID: c.ID, Quote: c.Quote, Status: status}
}

func readCitation(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	citation := store.Get(r.Context(), r.PathValue("id"))
	if citation == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such citation"})
		return
	}
	writeJSON(rw, http.StatusOK, evidenceOf(r.Context(), *citation))
}

func readAnswer(rw http.ResponseWriter, r *http.Request) {
	answerID := r.PathValue("id")
	citations := []evidence{}
	for _, c := range store.ForAnswer(r.Context(), answerID) {
		citations = append(citations, evidenceOf(r.Context(), c))
	}
	if len(citations) == 0 {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such answer"})
		return
	}
	writeJSON(rw, http.StatusOK, answerView{AnswerID: answerID, Status: citations[0].Status, Citations: citations})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/citations/{id}", readCitation)
	mux.HandleFunc("GET /v1/answers/{id}/citations", readAnswer)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"

	"citations/store" // store.Get, store.ForAnswer
)

const answerDegraded = "degraded"

var statusRank = map[string]int{"verified": 0, "pending": 1, "broken": 2}

// evidence is what a reader needs to check the quote against the document, and the verifier's stored verdict.
type evidence struct {
	ID         string \`json:"id"\`
	DocumentID string \`json:"document_id"\`
	Version    int    \`json:"version"\`
	Start      int    \`json:"start"\`
	End        int    \`json:"end"\`
	Quote      string \`json:"quote"\`
	Status     string \`json:"status"\`
	Reason     string \`json:"reason"\`
}

type answerView struct {
	AnswerID  string     \`json:"answer_id"\`
	Status    string     \`json:"status"\`
	Citations []evidence \`json:"citations"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func evidenceOf(c store.Citation) evidence {
	return evidence{ID: c.ID, DocumentID: c.DocumentID, Version: c.Version, Start: c.Start, End: c.End, Quote: c.Quote, Status: c.Status, Reason: c.Reason}
}

// answerStatus is the worst status among the citations; one broken citation makes the whole answer degraded.
func answerStatus(citations []evidence) string {
	worst := "verified"
	for _, c := range citations {
		if statusRank[c.Status] > statusRank[worst] {
			worst = c.Status
		}
	}
	if worst == "broken" {
		return answerDegraded
	}
	return worst
}

func readCitation(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	citation := store.Get(r.Context(), r.PathValue("id"))
	// Another tenant's citation is answered like a missing one: a 403 would confirm it exists.
	if citation == nil || citation.Tenant != tenant {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such citation"})
		return
	}
	writeJSON(rw, http.StatusOK, evidenceOf(*citation))
}

func readAnswer(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	answerID := r.PathValue("id")
	citations := []evidence{}
	for _, c := range store.ForAnswer(r.Context(), answerID) {
		if c.Tenant == tenant {
			citations = append(citations, evidenceOf(c))
		}
	}
	if len(citations) == 0 {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such answer"})
		return
	}
	writeJSON(rw, http.StatusOK, answerView{AnswerID: answerID, Status: answerStatus(citations), Citations: citations})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/citations/{id}", readCitation)
	mux.HandleFunc("GET /v1/answers/{id}/citations", readAnswer)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import citations.{Documents, Store} // Documents.latest; Store.get, Store.forAnswer

object Read {
  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  /** What a reader sees of a citation. */
  def evidence(c: Store.Citation): JsObject = {
    val status = if (Documents.latest(c.documentId).isDefined) "verified" else "broken"
    JsObject("id" -> JsString(c.id), "quote" -> JsString(c.quote), "status" -> JsString(status))
  }

  val route: Route = concat(
    path("v1" / "citations" / Segment) { citationId =>
      get {
        // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
        Store.get(citationId) match {
          case None => complete(json(StatusCodes.NotFound, JsObject("error" -> JsString("no such citation"))))
          case Some(citation) => complete(json(StatusCodes.OK, evidence(citation)))
        }
      }
    },
    path("v1" / "answers" / Segment / "citations") { answerId =>
      get {
        val citations = Store.forAnswer(answerId).map(evidence)
        if (citations.isEmpty) complete(json(StatusCodes.NotFound, JsObject("error" -> JsString("no such answer"))))
        else complete(json(StatusCodes.OK, JsObject("answer_id" -> JsString(answerId), "status" -> citations.head.fields("status"), "citations" -> JsArray(citations.toVector))))
      }
    }
  )
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import citations.Store // Store.get, Store.forAnswer

object Read {
  val StatusRank: Map[String, Int] = Map("verified" -> 0, "pending" -> 1, "broken" -> 2)
  val AnswerDegraded = "degraded"

  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  /** What a reader needs to check the quote against the document, and the verifier's stored verdict. */
  def evidence(c: Store.Citation): JsObject =
    JsObject(
      "id" -> JsString(c.id),
      "document_id" -> JsString(c.documentId),
      "version" -> JsNumber(c.version),
      "start" -> JsNumber(c.start),
      "end" -> JsNumber(c.end),
      "quote" -> JsString(c.quote),
      "status" -> JsString(c.status),
      "reason" -> JsString(c.reason)
    )

  /** The worst status among the citations; one broken citation makes the whole answer degraded. */
  def answerStatus(citations: Seq[Store.Citation]): String = {
    val worst = citations.map(_.status).maxByOption(StatusRank).getOrElse("verified")
    if (worst == "broken") AnswerDegraded else worst
  }

  val route: Route = concat(
    path("v1" / "citations" / Segment) { citationId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") {
          case None | Some("") => complete(error(StatusCodes.Unauthorized, "X-Tenant-Id is required"))
          case Some(tenant) =>
            Store.get(citationId) match {
              // Another tenant's citation is answered like a missing one: a 403 would confirm it exists.
              case Some(citation) if citation.tenant == tenant => complete(json(StatusCodes.OK, evidence(citation)))
              case _ => complete(error(StatusCodes.NotFound, "no such citation"))
            }
        }
      }
    },
    path("v1" / "answers" / Segment / "citations") { answerId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") {
          case None | Some("") => complete(error(StatusCodes.Unauthorized, "X-Tenant-Id is required"))
          case Some(tenant) =>
            val citations = Store.forAnswer(answerId).filter(_.tenant == tenant)
            if (citations.isEmpty) complete(error(StatusCodes.NotFound, "no such answer"))
            else
              complete(
                json(
                  StatusCodes.OK,
                  JsObject("answer_id" -> JsString(answerId), "status" -> JsString(answerStatus(citations)), "citations" -> JsArray(citations.map(evidence).toVector))
                )
              )
        }
      }
    }
  )
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

#include "citations/documents.h"  // documents::latest
#include "citations/store.h"      // store::get, store::forAnswer

using json = nlohmann::json;

// What a reader sees of a citation.
json evidence(const store::Citation& c) {
  const bool exists = documents::latest(c.document_id).has_value();
  return json{{"id", c.id}, {"quote", c.quote}, {"status", exists ? "verified" : "broken"}};
}

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void read_citation(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const auto citation = store::get(req.matches[1]);
  if (!citation) return reply(res, 404, json{{"error", "no such citation"}});
  reply(res, 200, evidence(*citation));
}

void read_answer(const httplib::Request& req, httplib::Response& res) {
  const std::string answer_id = req.matches[1];
  json citations = json::array();
  for (const store::Citation& c : store::forAnswer(answer_id)) citations.push_back(evidence(c));
  if (citations.empty()) return reply(res, 404, json{{"error", "no such answer"}});
  reply(res, 200, json{{"answer_id", answer_id}, {"status", citations[0]["status"]}, {"citations", citations}});
}

void register_routes(httplib::Server& svr) {
  svr.Get(R"(/v1/citations/([\\w-]+))", read_citation);
  svr.Get(R"(/v1/answers/([\\w-]+)/citations)", read_answer);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <map>
#include <string>
#include <vector>

#include "citations/store.h"  // store::get, store::forAnswer

using json = nlohmann::json;

const std::map<std::string, int> kStatusRank = {{"verified", 0}, {"pending", 1}, {"broken", 2}};
const std::string kAnswerDegraded = "degraded";

// What a reader needs to check the quote against the document, and the verifier's stored verdict.
json evidence(const store::Citation& c) {
  return json{{"id", c.id},       {"document_id", c.document_id}, {"version", c.version}, {"start", c.start},
              {"end", c.end},     {"quote", c.quote},             {"status", c.status},   {"reason", c.reason}};
}

// The worst status among the citations; one broken citation makes the whole answer degraded.
std::string answerStatus(const std::vector<store::Citation>& citations) {
  std::string worst = "verified";
  for (const store::Citation& c : citations) {
    if (kStatusRank.at(c.status) > kStatusRank.at(worst)) worst = c.status;
  }
  return worst == "broken" ? kAnswerDegraded : worst;
}

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void read_citation(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, json{{"error", "X-Tenant-Id is required"}});
  const auto citation = store::get(req.matches[1]);
  // Another tenant's citation is answered like a missing one: a 403 would confirm it exists.
  if (!citation || citation->tenant != tenant) return reply(res, 404, json{{"error", "no such citation"}});
  reply(res, 200, evidence(*citation));
}

void read_answer(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, json{{"error", "X-Tenant-Id is required"}});
  const std::string answer_id = req.matches[1];
  std::vector<store::Citation> mine;
  for (const store::Citation& c : store::forAnswer(answer_id)) {
    if (c.tenant == tenant) mine.push_back(c);
  }
  if (mine.empty()) return reply(res, 404, json{{"error", "no such answer"}});
  json citations = json::array();
  for (const store::Citation& c : mine) citations.push_back(evidence(c));
  reply(res, 200, json{{"answer_id", answer_id}, {"status", answerStatus(mine)}, {"citations", citations}});
}

void register_routes(httplib::Server& svr) {
  svr.Get(R"(/v1/citations/([\\w-]+))", read_citation);
  svr.Get(R"(/v1/answers/([\\w-]+)/citations)", read_answer);
}
`,
    },
  },
  harness: {
    python: `from citations import documents, store

FIELDS = {"answer_id": "a-1", "document_id": "doc-7", "version": 1, "start": 4, "end": 12, "quote": "Lovelace"}


def _api(ctx):
    documents.add_version("doc-7", "Ada Lovelace wrote the first program.")
    return ctx.client(ctx.load("read").app)


def _seed(tenant="t1", status=None, reason="", **over):
    """A stored citation; with a status, what the verifier committed for it."""
    row = store.create(tenant, {**FIELDS, **over})
    if status is not None:
        store.set_verification({**row, "status": status, "reason": reason})
    return store.get(row["id"])


async def _get(c, path, tenant="t1"):
    return await c.get(path, headers={"X-Tenant-Id": tenant} if tenant else {})


def _ids(r):
    return [x.get("id") for x in r.json().get("citations", [])] if r.status_code == 200 else []


async def check_route(ctx):
    async with _api(ctx) as c:
        row = _seed(status="verified")
        r = await _get(c, f"/v1/citations/{row['id']}")
        assert r.status_code == 200 and r.json().get("id") == row["id"] and r.json().get("quote") == "Lovelace", f"GET /v1/citations/{row['id']} answered {r.status_code} {r.text}"
        r = await _get(c, "/v1/answers/a-1/citations")
    assert r.status_code == 200 and _ids(r) == [row["id"]], f"GET /v1/answers/a-1/citations answered {r.status_code} {r.text}, expected the citation {row['id']}"


async def check_tenant_404(ctx):
    async with _api(ctx) as c:
        mine = _seed("t1", status="verified")
        theirs = _seed("t2", status="verified")
        r = await _get(c, f"/v1/citations/{theirs['id']}")
        assert r.status_code == 404 and "Lovelace" not in r.text, f"tenant t1 read tenant t2's citation {theirs['id']}: {r.status_code} {r.text}. Another tenant's citation is 404, as if it did not exist"
        r = await _get(c, f"/v1/citations/{mine['id']}", tenant="")
        assert r.status_code == 401, f"a read without X-Tenant-Id answered {r.status_code}, expected 401"
        r = await _get(c, "/v1/answers/a-1/citations")
    assert _ids(r) == [mine["id"]], f"tenant t1's answer a-1 lists {_ids(r)}: tenant t2's citation under the same answer id must not appear"


async def check_evidence_shape(ctx):
    async with _api(ctx) as c:
        row = _seed()
        store.set_verification({**row, "version": 2, "start": 12, "end": 20, "status": "verified", "reason": ""})
        r = await _get(c, f"/v1/citations/{row['id']}")
    body = r.json()
    want = {"id": row["id"], "document_id": "doc-7", "version": 2, "start": 12, "end": 20, "quote": "Lovelace", "status": "verified", "reason": ""}
    wrong = sorted(k for k in want if body.get(k) != want[k])
    assert not wrong, f"the citation answered {body}: {wrong} differ from the stored {want}. Without the version and offsets nobody can check the quote against the document"


async def check_stored_status(ctx):
    async with _api(ctx) as c:
        broken = _seed(status="broken", reason="span_moved")
        pending = _seed(document_id="doc-9")
        r = await _get(c, f"/v1/citations/{broken['id']}")
        assert r.json().get("status") == "broken" and r.json().get("reason") == "span_moved", f"a citation the verifier marked broken (span_moved) reads {r.text}: its document still exists, which says nothing about whether the quote is in it"
        r = await _get(c, f"/v1/citations/{pending['id']}")
    assert r.json().get("status") == "pending", f"a citation the verifier has not checked yet reads {r.text}, expected status pending"


async def check_worst_status(ctx):
    async with _api(ctx) as c:
        _seed(status="verified")
        _seed()
        r = await _get(c, "/v1/answers/a-1/citations")
        assert r.json().get("status") == "pending", f"an answer with a verified and a pending citation reports {r.json().get('status')!r}, expected pending"
        _seed(status="broken", reason="span_moved")
        r = await _get(c, "/v1/answers/a-1/citations")
        assert r.json().get("status") == "degraded", f"an answer whose third citation is broken reports {r.json().get('status')!r}, expected degraded"
        _seed(answer_id="a-2", status="verified")
        _seed(answer_id="a-2", status="verified")
        r = await _get(c, "/v1/answers/a-2/citations")
    assert r.json().get("status") == "verified", f"an answer whose citations are all verified reports {r.json().get('status')!r}"
`,
    typescript: `const FIELDS = {answer_id: 'a-1', document_id: 'doc-7', version: 1, start: 4, end: 12, quote: 'Lovelace'};

async function api(ctx) {
  const documents = ctx.load('/support/citations/documents.ts');
  const store = ctx.load('/support/citations/store.ts');
  await documents.addVersion('doc-7', 'Ada Lovelace wrote the first program.');
  /** A stored citation; with a status, what the verifier committed for it. */
  const seed = async (tenant = 't1', status: string | null = null, reason = '', over = {}) => {
    const row = await store.create(tenant, {...FIELDS, ...over});
    if (status !== null) await store.setVerification({...row, status, reason});
    return store.get(row.id);
  };
  return {c: ctx.client(ctx.load('read').app), store, seed};
}

const read = (c, path: string, tenant = 't1') => c.get(path, {headers: tenant ? {'X-Tenant-Id': tenant} : {}});

const ids = r => (r.status === 200 ? (r.json().citations ?? []).map(x => x.id) : []);

export async function check_route(ctx) {
  const {c, seed} = await api(ctx);
  const row = await seed('t1', 'verified');
  let r = await read(c, \`/v1/citations/\${row.id}\`);
  assert(r.status === 200 && r.json().id === row.id && r.json().quote === 'Lovelace', \`GET /v1/citations/\${row.id} answered \${r.status} \${r.text}\`);
  r = await read(c, '/v1/answers/a-1/citations');
  assert(r.status === 200 && JSON.stringify(ids(r)) === JSON.stringify([row.id]), \`GET /v1/answers/a-1/citations answered \${r.status} \${r.text}, expected the citation \${row.id}\`);
}

export async function check_tenant_404(ctx) {
  const {c, seed} = await api(ctx);
  const mine = await seed('t1', 'verified');
  const theirs = await seed('t2', 'verified');
  let r = await read(c, \`/v1/citations/\${theirs.id}\`);
  assert(r.status === 404 && !r.text.includes('Lovelace'), \`tenant t1 read tenant t2's citation \${theirs.id}: \${r.status} \${r.text}. Another tenant's citation is 404, as if it did not exist\`);
  r = await read(c, \`/v1/citations/\${mine.id}\`, '');
  assert.equal(r.status, 401, \`a read without X-Tenant-Id answered \${r.status}, expected 401\`);
  r = await read(c, '/v1/answers/a-1/citations');
  assert.deepStrictEqual(ids(r), [mine.id], \`tenant t1's answer a-1 lists \${JSON.stringify(ids(r))}: tenant t2's citation under the same answer id must not appear\`);
}

export async function check_evidence_shape(ctx) {
  const {c, store, seed} = await api(ctx);
  const row = await seed();
  await store.setVerification({...row, version: 2, start: 12, end: 20, status: 'verified', reason: ''});
  const r = await read(c, \`/v1/citations/\${row.id}\`);
  const body = r.json();
  const want = {id: row.id, document_id: 'doc-7', version: 2, start: 12, end: 20, quote: 'Lovelace', status: 'verified', reason: ''};
  const wrong = Object.keys(want).filter(k => body[k] !== want[k]);
  assert.equal(wrong.length, 0, \`the citation answered \${r.text}: \${JSON.stringify(wrong)} differ from the stored \${JSON.stringify(want)}. Without the version and offsets nobody can check the quote against the document\`);
}

export async function check_stored_status(ctx) {
  const {c, seed} = await api(ctx);
  const broken = await seed('t1', 'broken', 'span_moved');
  const pending = await seed('t1', null, '', {document_id: 'doc-9'});
  let r = await read(c, \`/v1/citations/\${broken.id}\`);
  assert(r.json().status === 'broken' && r.json().reason === 'span_moved', \`a citation the verifier marked broken (span_moved) reads \${r.text}: its document still exists, which says nothing about whether the quote is in it\`);
  r = await read(c, \`/v1/citations/\${pending.id}\`);
  assert.equal(r.json().status, 'pending', \`a citation the verifier has not checked yet reads \${r.text}, expected status pending\`);
}

export async function check_worst_status(ctx) {
  const {c, seed} = await api(ctx);
  await seed('t1', 'verified');
  await seed();
  let r = await read(c, '/v1/answers/a-1/citations');
  assert.equal(r.json().status, 'pending', \`an answer with a verified and a pending citation reports \${JSON.stringify(r.json().status)}, expected pending\`);
  await seed('t1', 'broken', 'span_moved');
  r = await read(c, '/v1/answers/a-1/citations');
  assert.equal(r.json().status, 'degraded', \`an answer whose third citation is broken reports \${JSON.stringify(r.json().status)}, expected degraded\`);
  await seed('t1', 'verified', '', {answer_id: 'a-2'});
  await seed('t1', 'verified', '', {answer_id: 'a-2'});
  r = await read(c, '/v1/answers/a-2/citations');
  assert.equal(r.json().status, 'verified', \`an answer whose citations are all verified reports \${JSON.stringify(r.json().status)}\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"strings"

	"citations/documents"
	"citations/store"

	"leetbuild/harness"
)

var readBg = context.Background()

func readAPI(ctx *harness.Ctx) *harness.HTTP {
	documents.AddVersion(readBg, "doc-7", "Ada Lovelace wrote the first program.")
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

// seed stores a citation; with a status, what the verifier committed for it.
func seed(tenant, answerID, documentID, status, reason string) store.Citation {
	row := store.Create(readBg, tenant, store.Citation{AnswerID: answerID, DocumentID: documentID, Version: 1, Start: 4, End: 12, Quote: "Lovelace"})
	if status != "" {
		row.Status = status
		row.Reason = reason
		store.SetVerification(readBg, row)
	}
	return *store.Get(readBg, row.ID)
}

func readAs(c *harness.HTTP, path, tenant string) (*harness.Response, map[string]any) {
	var r *harness.Response
	if tenant == "" {
		r = c.Get(path)
	} else {
		r = c.Get(path, "X-Tenant-Id", tenant)
	}
	body, _ := r.JSON().(map[string]any)
	return r, body
}

func listed(r *harness.Response, body map[string]any) []string {
	ids := []string{}
	if r.Status != 200 {
		return ids
	}
	items, _ := body["citations"].([]any)
	for _, item := range items {
		m, _ := item.(map[string]any)
		id, _ := m["id"].(string)
		ids = append(ids, id)
	}
	return ids
}

func CheckRoute(ctx *harness.Ctx) {
	c := readAPI(ctx)
	row := seed("t1", "a-1", "doc-7", "verified", "")
	r, b := readAs(c, "/v1/citations/"+row.ID, "t1")
	ctx.Assert(r.Status == 200 && b["id"] == row.ID && b["quote"] == "Lovelace", "GET /v1/citations/%s answered %d %s", row.ID, r.Status, r.Text())
	r, b = readAs(c, "/v1/answers/a-1/citations", "t1")
	ctx.Equal(listed(r, b), []string{row.ID}, "GET /v1/answers/a-1/citations (%d %s); the citations", r.Status, r.Text())
}

func CheckTenant404(ctx *harness.Ctx) {
	c := readAPI(ctx)
	mine := seed("t1", "a-1", "doc-7", "verified", "")
	theirs := seed("t2", "a-1", "doc-7", "verified", "")
	r, _ := readAs(c, "/v1/citations/"+theirs.ID, "t1")
	ctx.Assert(r.Status == 404 && !strings.Contains(r.Text(), "Lovelace"), "tenant t1 read tenant t2's citation %s: %d %s. Another tenant's citation is 404, as if it did not exist", theirs.ID, r.Status, r.Text())
	r, _ = readAs(c, "/v1/citations/"+mine.ID, "")
	ctx.Equal(r.Status, 401, "a read without X-Tenant-Id")
	r, b := readAs(c, "/v1/answers/a-1/citations", "t1")
	ctx.Equal(listed(r, b), []string{mine.ID}, "tenant t1's answer a-1 must not list tenant t2's citation under the same answer id; the citations")
}

func CheckEvidenceShape(ctx *harness.Ctx) {
	c := readAPI(ctx)
	row := seed("t1", "a-1", "doc-7", "", "")
	row.Version = 2
	row.Start = 12
	row.End = 20
	row.Status = "verified"
	store.SetVerification(readBg, row)
	r, b := readAs(c, "/v1/citations/"+row.ID, "t1")
	want := map[string]any{"id": row.ID, "document_id": "doc-7", "version": float64(2), "start": float64(12), "end": float64(20), "quote": "Lovelace", "status": "verified", "reason": ""}
	wrong := []string{}
	for k, v := range want {
		if b[k] != v {
			wrong = append(wrong, k)
		}
	}
	ctx.Assert(len(wrong) == 0, "the citation answered %s: %q differ from the stored %v. Without the version and offsets nobody can check the quote against the document", r.Text(), wrong, want)
}

func CheckStoredStatus(ctx *harness.Ctx) {
	c := readAPI(ctx)
	broken := seed("t1", "a-1", "doc-7", "broken", "span_moved")
	pending := seed("t1", "a-1", "doc-9", "", "")
	r, b := readAs(c, "/v1/citations/"+broken.ID, "t1")
	ctx.Assert(b["status"] == "broken" && b["reason"] == "span_moved", "a citation the verifier marked broken (span_moved) reads %s: its document still exists, which says nothing about whether the quote is in it", r.Text())
	r, b = readAs(c, "/v1/citations/"+pending.ID, "t1")
	ctx.Assert(b["status"] == "pending", "a citation the verifier has not checked yet reads %s, expected status pending", r.Text())
}

func CheckWorstStatus(ctx *harness.Ctx) {
	c := readAPI(ctx)
	seed("t1", "a-1", "doc-7", "verified", "")
	seed("t1", "a-1", "doc-7", "", "")
	_, b := readAs(c, "/v1/answers/a-1/citations", "t1")
	ctx.Equal(b["status"], "pending", "an answer with a verified and a pending citation; its status")
	seed("t1", "a-1", "doc-7", "broken", "span_moved")
	_, b = readAs(c, "/v1/answers/a-1/citations", "t1")
	ctx.Equal(b["status"], "degraded", "an answer whose third citation is broken; its status")
	seed("t1", "a-2", "doc-7", "verified", "")
	seed("t1", "a-2", "doc-7", "verified", "")
	_, b = readAs(c, "/v1/answers/a-2/citations", "t1")
	ctx.Equal(b["status"], "verified", "an answer whose citations are all verified; its status")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "citations/documents.h"
#include "citations/store.h"

using json = nlohmann::json;

namespace {

harness::HTTP readAPI(harness::Ctx& ctx) {
  documents::addVersion("doc-7", "Ada Lovelace wrote the first program.");
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

// A stored citation; with a status, what the verifier committed for it.
store::Citation seed(const std::string& tenant, const std::string& answer_id = "a-1", const std::string& document_id = "doc-7", const std::string& status = "",
                     const std::string& reason = "") {
  store::Citation row = store::create(tenant, store::Citation{"", "", answer_id, document_id, 1, 4, 12, "Lovelace", "", ""});
  if (!status.empty()) {
    row.status = status;
    row.reason = reason;
    store::setVerification(row);
  }
  return *store::get(row.id);
}

harness::Response readAs(harness::HTTP& c, const std::string& path, const std::string& tenant = "t1") {
  return tenant.empty() ? c.Get(path) : c.Get(path, "X-Tenant-Id", tenant);
}

json bodyOf(const harness::Response& r) {
  const json body = json::parse(r.Text(), nullptr, false);
  return body.is_object() ? body : json::object();
}

std::vector<std::string> listed(const harness::Response& r) {
  std::vector<std::string> ids;
  const json body = bodyOf(r);
  if (r.Status != 200 || !body.contains("citations") || !body["citations"].is_array()) return ids;
  for (const auto& item : body["citations"]) ids.push_back(item.is_object() ? item.value("id", "") : "");
  return ids;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = readAPI(ctx);
  const store::Citation row = seed("t1", "a-1", "doc-7", "verified");
  auto r = readAs(c, "/v1/citations/" + row.id);
  ctx.Assert(r.Status == 200 && bodyOf(r).value("id", "") == row.id && bodyOf(r).value("quote", "") == "Lovelace", "GET /v1/citations/%s answered %d %s", row.id, r.Status, r.Text());
  r = readAs(c, "/v1/answers/a-1/citations");
  ctx.Equal(listed(r), {row.id}, "GET /v1/answers/a-1/citations (%d %s); the citations", r.Status, r.Text());
}

void CheckTenant404(harness::Ctx& ctx) {
  auto c = readAPI(ctx);
  const store::Citation mine = seed("t1", "a-1", "doc-7", "verified");
  const store::Citation theirs = seed("t2", "a-1", "doc-7", "verified");
  auto r = readAs(c, "/v1/citations/" + theirs.id);
  ctx.Assert(r.Status == 404 && r.Text().find("Lovelace") == std::string::npos, "tenant t1 read tenant t2's citation %s: %d %s. Another tenant's citation is 404, as if it did not exist", theirs.id, r.Status, r.Text());
  r = readAs(c, "/v1/citations/" + mine.id, "");
  ctx.Equal(r.Status, 401, "a read without X-Tenant-Id");
  r = readAs(c, "/v1/answers/a-1/citations");
  ctx.Equal(listed(r), {mine.id}, "tenant t1's answer a-1 must not list tenant t2's citation under the same answer id; the citations");
}

void CheckEvidenceShape(harness::Ctx& ctx) {
  auto c = readAPI(ctx);
  store::Citation row = seed("t1");
  row.version = 2;
  row.start = 12;
  row.end = 20;
  row.status = "verified";
  store::setVerification(row);
  const auto r = readAs(c, "/v1/citations/" + row.id);
  const json want = {{"id", row.id}, {"document_id", "doc-7"}, {"version", 2}, {"start", 12}, {"end", 20}, {"quote", "Lovelace"}, {"status", "verified"}, {"reason", ""}};
  const json body = bodyOf(r);
  std::vector<std::string> wrong;
  for (const auto& [k, v] : want.items()) {
    if (!body.contains(k) || body[k] != v) wrong.push_back(k);
  }
  ctx.Assert(wrong.empty(), "the citation answered %s: %q differ from the stored %s. Without the version and offsets nobody can check the quote against the document", r.Text(), wrong, want.dump());
}

void CheckStoredStatus(harness::Ctx& ctx) {
  auto c = readAPI(ctx);
  const store::Citation broken = seed("t1", "a-1", "doc-7", "broken", "span_moved");
  const store::Citation pending = seed("t1", "a-1", "doc-9");
  auto r = readAs(c, "/v1/citations/" + broken.id);
  ctx.Assert(bodyOf(r).value("status", "") == "broken" && bodyOf(r).value("reason", "") == "span_moved", "a citation the verifier marked broken (span_moved) reads %s: its document still exists, which says nothing about whether the quote is in it", r.Text());
  r = readAs(c, "/v1/citations/" + pending.id);
  ctx.Assert(bodyOf(r).value("status", "") == "pending", "a citation the verifier has not checked yet reads %s, expected status pending", r.Text());
}

void CheckWorstStatus(harness::Ctx& ctx) {
  auto c = readAPI(ctx);
  seed("t1", "a-1", "doc-7", "verified");
  seed("t1", "a-1", "doc-7");
  auto r = readAs(c, "/v1/answers/a-1/citations");
  ctx.Equal(bodyOf(r).value("status", ""), "pending", "an answer with a verified and a pending citation; its status");
  seed("t1", "a-1", "doc-7", "broken", "span_moved");
  r = readAs(c, "/v1/answers/a-1/citations");
  ctx.Equal(bodyOf(r).value("status", ""), "degraded", "an answer whose third citation is broken; its status");
  seed("t1", "a-2", "doc-7", "verified");
  seed("t1", "a-2", "doc-7", "verified");
  r = readAs(c, "/v1/answers/a-2/citations");
  ctx.Equal(bodyOf(r).value("status", ""), "verified", "an answer whose citations are all verified; its status");
}
`,
  },
  debrief: `The read has two jobs, and the fix separates them: say who may see a citation, and say what is known about it. The tenant check sits on the row, not on the route, and a foreign citation answers like a missing one, so the endpoint cannot be used to probe for ids. The status comes from the verifier's committed verdict, because only the verifier compared the quote with the bytes; document existence is a weaker fact pretending to be the same one. The answer's status is a worst-of so one broken citation cannot hide behind good ones. Production read paths also expose when the verdict was made and against which version, and let a client ask for re-verification of a stale one.`,
};
