import type {Step} from '@/lib/types';

export const readCitationsStep: Step = {
  id: 'read',
  title: 'GET /v1/citations/{id}: an answer that names its evidence',
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'db', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it serves a citation, it is
fast, and the demo always asks for the caller’s own answer. It hides three flaws — a cross-tenant
read, a status that is guessed instead of read, and an answer whose status ignores its broken
citations. Review it, fix it, and prove the fix.

Implement the read side, two endpoints:

\`GET /v1/citations/{citation_id}\`:

- The tenant comes from \`X-Tenant-Id\` (**401** when absent) and the citation is returned for the
  **owning tenant only**: a citation that belongs to another tenant is **404**, never 403 — a 403
  confirms that the citation exists, which is itself information the caller may not have.
- The response names the evidence in full: \`{"id", "document_id", "version", "start", "end",
  "quote", "status", "reason"}\`. The draft returns a quote and a status but no version and no
  offsets, so a reviewer cannot check the span against the bytes.

\`GET /v1/answers/{answer_id}/citations\`:

- The list is scoped by tenant in the lookup, not filtered after the fact.
- The answer’s **status is the worst status among its citations**: \`broken\` beats \`pending\`
  beats \`verified\`, and an answer with any broken citation reports **\`degraded\`**. The draft
  reports the first citation’s status, so one broken citation in the middle is invisible.
- **Statuses come from the stored verification**, never recomputed from “the document still
  exists”. The draft answers \`valid\` for anything whose document resolves, which erases the
  verification result this whole store exists to keep.

**Failure mode the checks target.** Reading by id without the tenant predicate turns the endpoint
into a citation oracle for every tenant; recomputing the status from document existence replaces a
proof with a guess; and an answer status that ignores broken citations makes the whole response look
trustworthy while one of its spans no longer resolves.`,
  sequence: {
    participants: ['Client', 'Citation API', 'citation store'],
    messages: [
      {from: 'Client', to: 'Citation API', label: 'GET /v1/citations/{id} · X-Tenant-Id', kind: 'sync'},
      {from: 'Citation API', to: 'citation store', label: 'get(citation_id)', kind: 'sync'},
      {from: 'citation store', to: 'Citation API', label: 'stored citation + verification', kind: 'reply'},
      {from: 'Citation API', to: 'Client', label: '404 for a foreign citation — never 403', kind: 'reply'},
      {from: 'Client', to: 'Citation API', label: 'GET /v1/answers/{answer_id}/citations', kind: 'sync'},
      {from: 'Citation API', to: 'citation store', label: 'for_answer(answer_id, tenant)', kind: 'sync'},
      {
        from: 'Citation API',
        to: 'Client',
        label: '200 {status: degraded, citations: [{span, version, status}]}',
        kind: 'reply',
      },
    ],
  },
  hints: [
    'One code for two situations: look the citation up with the tenant in the predicate and answer **404** when there is no row. A separate 403 branch tells a caller that the citation exists and belongs to someone else, which is exactly the fact you are trying to keep from them.',
    'The status is stored data, not something to derive: return `citation["status"]` as the verification recorded it. `"valid" if the document exists` is a guess that outlives the verification it replaces.',
    'Rank the statuses explicitly (`broken > pending > verified`) and compute the answer’s status as the maximum over its citations, mapping a broken worst-case to `degraded`. Taking the first citation’s status — or the last one — makes the answer’s verdict depend on ordering instead of on its evidence.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Serves the citation and the answer’s citation list',
      detail:
        'Register both reads: `GET /v1/citations/{citation_id}` with the id from the path, and `GET /v1/answers/{answer_id}/citations`.',
      match: {
        python: {
          all: [
            /@app\.get\(\s*["']\/v1\/citations\/\{citation_id\}["']/,
            /@app\.get\(\s*["']\/v1\/answers\/\{answer_id\}\/citations["']/,
          ],
        },
        typescript: {
          all: [
            /app\.get\(\s*['"]\/v1\/citations\/:citation_id['"]/,
            /app\.get\(\s*['"]\/v1\/answers\/:answer_id\/citations['"]/,
          ],
        },
        go: {
          all: [
            /HandleFunc\(\s*"GET \/v1\/citations\/\{citation_id\}"/,
            /HandleFunc\(\s*"GET \/v1\/answers\/\{answer_id\}\/citations"/,
          ],
        },
        scala: {
          all: [
            /path\(\s*"v1"\s*\/\s*"citations"\s*\/\s*Segment\s*\)/,
            /path\(\s*"v1"\s*\/\s*"answers"\s*\/\s*Segment\s*\/\s*"citations"\s*\)/,
            /\bget\s*\{/,
          ],
        },
        cpp: {all: [/svr\.Get\(R"\(/, /citations\/\(\[/, /answers\/\(\[/, /req\.matches\[1\]/]},
      },
    },
    {
      id: 'evidence-shape',
      title: 'The citation names its evidence in full',
      detail:
        'The response carries the version, the full offset range and the quote, so a reviewer can check the span against the bytes. The draft returns a quote and a status but no version and no offsets.',
      match: {
        python: {all: [/"quote"/, /"version"/, /"status"/, /"start"/, /"end"/]},
        typescript: {all: [/quote:/, /version:/, /status:/, /start:/, /end:/]},
        go: {all: [/"quote"/, /"version"/, /"status"/, /"start"/, /"end"/]},
        scala: {all: [/CitationEvidence\(/, /quote/, /version/, /start/, /end/]},
        cpp: {all: [/"quote"/, /"version"/, /"status"/, /"start"/, /"end"/]},
      },
    },
    {
      id: 'worst-status',
      title: 'The answer reports the worst status among its citations',
      detail:
        'A ranked worst-of (`broken > pending > verified`) decides the answer’s status, and any broken citation makes it `degraded`. The draft echoes the first citation’s status, so a broken citation in the middle disappears.',
      match: {
        python: {all: [/STATUS_RANK/, /answer_status\(/, /ANSWER_DEGRADED/]},
        typescript: {all: [/STATUS_RANK/, /answerStatus\(/, /ANSWER_DEGRADED/]},
        go: {all: [/statusRank/, /answerStatus\(/, /answerDegraded/]},
        scala: {all: [/StatusRank/, /answerStatus\(/, /AnswerDegraded/]},
        cpp: {all: [/kStatusRank/, /answerStatus\(/, /kAnswerDegraded/]},
      },
    },
    {
      id: 'stored-status',
      title: 'The status is the stored verification, not a guess',
      detail:
        'The response returns the stored verification status. The draft answers `valid` whenever the document still exists, replacing the verification result with a lookup.',
      match: {
        python: {all: [/"status":\s*citation\["status"\]/], none: [/documents\.exists\(/]},
        typescript: {all: [/status:\s*citation\.status/], none: [/documents\.exists\(/]},
        go: {all: [/"status":\s*citation\.Status/], none: [/documents\.Exists\(/]},
        scala: {all: [/status = citation\.status/], none: [/documents\.exists\(/]},
        cpp: {all: [/\{"status",\s*citation\.at\("status"\)\}/], none: [/documents\.exists\(/]},
      },
    },
    {
      id: 'tenant-404',
      title: 'A foreign citation is 404, never 403',
      detail:
        'The citation is returned only to the tenant that owns it and anything else answers **404** — a 403 would confirm the citation exists. The draft serves any tenant the citation it asks for.',
      match: {
        python: {all: [/citation\["tenant"\]\s*!=\s*tenant/, /status_code\s*=\s*404/]},
        typescript: {all: [/citation\.tenant\s*!==?\s*tenant/, /code\(\s*404\s*\)/]},
        go: {all: [/citation\.Tenant\s*!=\s*tenant/, /StatusNotFound/]},
        scala: {all: [/citation\.tenant\s*!=\s*tenant/, /StatusCodes\.NotFound/]},
        cpp: {all: [/value\("tenant",\s*std::string\(\)\)\s*!=\s*tenant/, /\b404\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI
from fastapi.responses import JSONResponse

app = FastAPI()


@app.get("/v1/citations/{citation_id}")
def read_citation(citation_id: str) -> JSONResponse:
    # TODO: this draft serves any tenant, guesses the status from whether the document exists, and
    # returns no version or offsets. Return the stored verification and the full span, and answer
    # 404 for a citation that belongs to another tenant.
    citation = lookup(citation_id)
    return JSONResponse(
        {
            "id": citation["id"],
            "quote": citation["quote"],
            "status": "valid" if documents.exists(citation["document_id"]) else "broken",
        },
        status_code=200,
    )


@app.get("/v1/answers/{answer_id}/citations")
def read_answer(answer_id: str) -> JSONResponse:
    citations = for_answer(answer_id)
    statuses = [citation["status"] for citation in citations]
    return JSONResponse(
        {
            "answer_id": answer_id,
            "status": statuses[0] if statuses else "verified",
            "citations": citations,
        },
        status_code=200,
    )
`,
      solution: `from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()

# The worst status wins: one broken citation makes the whole answer degraded.
STATUS_RANK = {"verified": 0, "pending": 1, "broken": 2}
ANSWER_DEGRADED = "degraded"


class CitationStore:
    def get(self, citation_id: str) -> dict | None:
        """The stored citation, whatever tenant it belongs to."""
        raise NotImplementedError

    def for_answer(self, answer_id: str, tenant: str) -> list[dict]:
        """The answer's citations, scoped by tenant in the query rather than filtered afterwards."""
        raise NotImplementedError


store = CitationStore()


def answer_status(citations: list[dict]) -> str:
    worst = max((citation["status"] for citation in citations), key=lambda s: STATUS_RANK.get(s, 1), default="verified")
    return ANSWER_DEGRADED if worst == "broken" else worst


@app.get("/v1/citations/{citation_id}")
def read_citation(
    citation_id: str, tenant: str | None = Header(default=None, alias="X-Tenant-Id")
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    citation = store.get(citation_id)
    if citation is None or citation["tenant"] != tenant:
        # 404 for a foreign citation too: a 403 would confirm that it exists.
        raise HTTPException(status_code=404, detail="unknown citation")
    return JSONResponse(
        {
            "id": citation["id"],
            "document_id": citation["document_id"],
            "version": citation["version"],
            "start": citation["start"],
            "end": citation["end"],
            "quote": citation["quote"],
            # The stored verification is the status: never recompute it from the document.
            "status": citation["status"],
            "reason": citation.get("reason"),
        },
        status_code=200,
    )


@app.get("/v1/answers/{answer_id}/citations")
def read_answer(
    answer_id: str, tenant: str | None = Header(default=None, alias="X-Tenant-Id")
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    citations = store.for_answer(answer_id, tenant)
    if not citations:
        raise HTTPException(status_code=404, detail="unknown answer")
    return JSONResponse(
        {
            "answer_id": answer_id,
            "status": answer_status(citations),
            "citations": [
                {
                    "id": citation["id"],
                    "document_id": citation["document_id"],
                    "version": citation["version"],
                    "start": citation["start"],
                    "end": citation["end"],
                    "quote": citation["quote"],
                    "status": citation["status"],
                }
                for citation in citations
            ],
        },
        status_code=200,
    )
`,
    },
    typescript: {
      starter: `/** A model-generated read that serves any tenant and guesses the citation status. */
import Fastify from 'fastify';

import {documents, db} from './store';

export const app = Fastify();

app.get('/v1/citations/:citation_id', async (request, reply) => {
  // TODO: this draft serves any tenant, guesses the status from whether the document exists, and
  // returns no version or offsets. Return the stored verification and the full span, and answer
  // 404 for a citation that belongs to another tenant.
  const {citation_id} = request.params as {citation_id: string};
  const citation = await db.lookup(citation_id);
  return reply.code(200).send({
    id: citation.id,
    quote: citation.quote,
    status: documents.exists(citation.document_id) ? 'valid' : 'broken',
  });
});

app.get('/v1/answers/:answer_id/citations', async (request, reply) => {
  const {answer_id} = request.params as {answer_id: string};
  const citations = await db.forAnswer(answer_id);
  return reply.code(200).send({
    answer_id,
    status: citations[0]?.status ?? 'verified',
    citations,
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** Citation read: the stored verification, the full span, and the owning tenant only. */
import Fastify from 'fastify';

import {store} from './store';

export const app = Fastify();

// The worst status wins: one broken citation makes the whole answer degraded.
const STATUS_RANK: Record<string, number> = {verified: 0, pending: 1, broken: 2};
const ANSWER_DEGRADED = 'degraded';

interface Citation {
  id: string;
  tenant: string;
  document_id: string;
  version: number;
  start: number;
  end: number;
  quote: string;
  status: string;
  reason?: string | null;
}

function answerStatus(citations: Citation[]): string {
  const worst = citations.reduce(
    (acc, citation) => (STATUS_RANK[citation.status] > STATUS_RANK[acc] ? citation.status : acc),
    'verified',
  );
  return worst === 'broken' ? ANSWER_DEGRADED : worst;
}

function evidence(citation: Citation) {
  return {
    id: citation.id,
    document_id: citation.document_id,
    version: citation.version,
    start: citation.start,
    end: citation.end,
    quote: citation.quote,
    // The stored verification is the status: never recompute it from the document.
    status: citation.status,
    reason: citation.reason ?? null,
  };
}

app.get('/v1/citations/:citation_id', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {citation_id} = request.params as {citation_id: string};
  const citation: Citation | null = await store.get(citation_id);
  // 404 for a foreign citation too: a 403 would confirm that it exists.
  if (citation === null || citation.tenant !== tenant)
    return reply.code(404).send({error: 'unknown citation'});
  return reply.code(200).send(evidence(citation));
});

app.get('/v1/answers/:answer_id/citations', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {answer_id} = request.params as {answer_id: string};
  const citations: Citation[] = await store.forAnswer(answer_id, tenant);
  if (citations.length === 0) return reply.code(404).send({error: 'unknown answer'});
  return reply.code(200).send({
    answer_id,
    status: answerStatus(citations),
    citations: citations.map(evidence),
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
)

func readCitation(rw http.ResponseWriter, r *http.Request) {
	// TODO: this draft serves any tenant, guesses the status from whether the document exists, and
	// returns no version or offsets. Return the stored verification and the full span, and answer
	// 404 for a citation that belongs to another tenant.
	citation, _ := store.Get(r.Context(), r.PathValue("citation_id"))
	writeJSON(rw, http.StatusOK, map[string]any{
		"id":     citation.ID,
		"quote":  citation.Quote,
		"status": map[bool]string{true: "valid", false: "broken"}[documents.Exists(citation.DocumentID)],
	})
}

func readAnswer(rw http.ResponseWriter, r *http.Request) {
	citations, _ := store.ForAnswer(r.Context(), r.PathValue("answer_id"), "")
	status := "verified"
	if len(citations) > 0 {
		status = citations[0].Status
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"answer_id": r.PathValue("answer_id"),
		"status":    status,
		"citations": citations,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/citations/{citation_id}", readCitation)
	mux.HandleFunc("GET /v1/answers/{answer_id}/citations", readAnswer)
	_ = http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"net/http"
)

// The worst status wins: one broken citation makes the whole answer degraded.
var statusRank = map[string]int{"verified": 0, "pending": 1, "broken": 2}

const (
	answerDegraded = "degraded"
	statusVerified = "verified"
)

type Citation struct {
	ID         string \`json:"id"\`
	Tenant     string \`json:"tenant"\`
	DocumentID string \`json:"document_id"\`
	Version    int    \`json:"version"\`
	Start      int64  \`json:"start"\`
	End        int64  \`json:"end"\`
	Quote      string \`json:"quote"\`
	Status     string \`json:"status"\`
	Reason     string \`json:"reason"\`
}

type CitationStore struct{}

func (s *CitationStore) Get(ctx context.Context, citationID string) (*Citation, error) {
	return nil, nil
}

func (s *CitationStore) ForAnswer(ctx context.Context, answerID, tenant string) ([]Citation, error) {
	return nil, nil
}

var store = &CitationStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func answerStatus(citations []Citation) string {
	worst := statusVerified
	for _, citation := range citations {
		if statusRank[citation.Status] > statusRank[worst] {
			worst = citation.Status
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
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	citation, err := store.Get(r.Context(), r.PathValue("citation_id"))
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	// 404 for a foreign citation too: a 403 would confirm that it exists.
	if citation == nil || citation.Tenant != tenant {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown citation"})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"id":          citation.ID,
		"document_id": citation.DocumentID,
		"version":     citation.Version,
		"start":       citation.Start,
		"end":         citation.End,
		"quote":       citation.Quote,
		// The stored verification is the status: never recompute it from the document.
		"status": citation.Status,
		"reason": citation.Reason,
	})
}

func readAnswer(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	citations, err := store.ForAnswer(r.Context(), r.PathValue("answer_id"), tenant)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if len(citations) == 0 {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown answer"})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"answer_id": r.PathValue("answer_id"),
		"status":    answerStatus(citations),
		"citations": citations,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/citations/{citation_id}", readCitation)
	mux.HandleFunc("GET /v1/answers/{answer_id}/citations", readAnswer)
	_ = http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux)
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

object ReadApi {
  implicit val system: ActorSystem = ActorSystem("citation-read")

  val route: Route =
    concat(
      path("v1" / "citations" / Segment) { citationId =>
        get {
          // TODO: this draft serves any tenant, guesses the status from whether the document
          // exists, and returns no version or offsets. Return the stored verification and the full
          // span, and answer 404 for a citation that belongs to another tenant.
          val citation = store.get(citationId)
          val status = if (documents.exists(citation.document_id)) "valid" else "broken"
          complete(StatusCodes.OK, s"""{"id":"$citationId","quote":"\${citation.quote}","status":"$status"}""")
        }
      },
      path("v1" / "answers" / Segment / "citations") { answerId =>
        get {
          val citations = store.forAnswer(answerId)
          val status = citations.headOption.map(_.status).getOrElse("verified")
          complete(StatusCodes.OK, s"""{"answer_id":"$answerId","status":"$status","citations":[]}""")
        }
      }
    )

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
import spray.json.RootJsonFormat

final case class CitationRecord(
    id: String,
    tenant: String,
    document_id: String,
    version: Int,
    start: Int,
    end: Int,
    quote: String,
    status: String,
    reason: Option[String]
)

final case class CitationEvidence(
    id: String,
    document_id: String,
    version: Int,
    start: Int,
    end: Int,
    quote: String,
    status: String,
    reason: Option[String]
)

final case class AnswerCitations(answer_id: String, status: String, citations: List[CitationEvidence])

object ReadApi {
  implicit val system: ActorSystem = ActorSystem("citation-read")
  implicit val evidenceFormat: RootJsonFormat[CitationEvidence] = jsonFormat8(CitationEvidence)
  implicit val answerFormat: RootJsonFormat[AnswerCitations] = jsonFormat3(AnswerCitations)

  // The worst status wins: one broken citation makes the whole answer degraded.
  val StatusRank = Map("verified" -> 0, "pending" -> 1, "broken" -> 2)
  val AnswerDegraded = "degraded"

  val store = CitationStore.open()

  def answerStatus(citations: List[CitationRecord]): String = {
    val worst = citations.map(_.status).sortBy(status => StatusRank.getOrElse(status, 1)).lastOption.getOrElse("verified")
    if (worst == "broken") AnswerDegraded else worst
  }

  def evidence(citation: CitationRecord): CitationEvidence =
    CitationEvidence(
      id = citation.id,
      document_id = citation.document_id,
      version = citation.version,
      start = citation.start,
      end = citation.end,
      quote = citation.quote,
      // The stored verification is the status: never recompute it from the document.
      status = citation.status,
      reason = citation.reason
    )

  val route: Route =
    concat(
      path("v1" / "citations" / Segment) { citationId =>
        get {
          optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
            if (!tenantOpt.exists(_.nonEmpty)) {
              complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
            } else {
              // 404 for a foreign citation too: a 403 would confirm that it exists.
              store.get(citationId) match {
                case Some(citation) if citation.tenant != tenantOpt.get =>
                  complete(StatusCodes.NotFound, """{"error":"unknown citation"}""")
                case None =>
                  complete(StatusCodes.NotFound, """{"error":"unknown citation"}""")
                case Some(citation) =>
                  complete(StatusCodes.OK, evidence(citation))
              }
            }
          }
        }
      },
      path("v1" / "answers" / Segment / "citations") { answerId =>
        get {
          optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
            if (!tenantOpt.exists(_.nonEmpty)) {
              complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
            } else {
              val citations = store.forAnswer(answerId, tenantOpt.get)
              if (citations.isEmpty) {
                complete(StatusCodes.NotFound, """{"error":"unknown answer"}""")
              } else {
                complete(
                  StatusCodes.OK,
                  AnswerCitations(answerId, answerStatus(citations), citations.map(evidence))
                )
              }
            }
          }
        }
      }
    )

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

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/citations/([\\w-]+))", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft serves any tenant, guesses the status from whether the document exists, and
    // returns no version or offsets. Return the stored verification and the full span, and answer
    // 404 for a citation that belongs to another tenant.
    const std::string citationId = req.matches[1];
    const auto citation = store.get(citationId);
    res.status = 200;
    res.set_content(
        json{{"id", citationId},
             {"quote", citation.value("quote", std::string())},
             {"status", documents.exists(citation.value("document_id", std::string())) ? "valid" : "broken"}}
            .dump(),
        "application/json");
  });

  svr.Get(R"(/v1/answers/([\\w-]+)/citations)", [](const httplib::Request& req, httplib::Response& res) {
    const std::string answerId = req.matches[1];
    const auto citations = store.forAnswer(answerId);
    res.status = 200;
    res.set_content(
        json{{"answer_id", answerId},
             {"status", citations.empty() ? "verified" : citations.front().value("status", std::string())},
             {"citations", citations}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <map>
#include <string>
#include <vector>

using json = nlohmann::json;

// The worst status wins: one broken citation makes the whole answer degraded.
const std::map<std::string, int> kStatusRank = {{"verified", 0}, {"pending", 1}, {"broken", 2}};
const std::string kAnswerDegraded = "degraded";

struct CitationStore {
  std::vector<json> forAnswer(const std::string& answerId, const std::string& tenant) const;
};

CitationStore store;

std::optional<json> lookupCitation(const std::string& citationId);

std::string answerStatus(const std::vector<json>& citations) {
  std::string worst = "verified";
  for (const auto& citation : citations) {
    const auto status = citation.value("status", std::string());
    if (kStatusRank.at(status) > kStatusRank.at(worst)) worst = status;
  }
  if (worst == "broken") return kAnswerDegraded;
  return worst;
}

json evidence(const json& citation) {
  return {
      {"id", citation.at("id")},
      {"document_id", citation.at("document_id")},
      {"version", citation.at("version")},
      {"start", citation.at("start")},
      {"end", citation.at("end")},
      {"quote", citation.at("quote")},
      // The stored verification is the status: never recompute it from the document.
      {"status", citation.at("status")},
      {"reason", citation.value("reason", std::string())},
  };
}

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/citations/([\\w-]+))", [](const httplib::Request& req, httplib::Response& res) {
    const std::string tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const std::string citationId = req.matches[1];
    const auto citation = lookupCitation(citationId);
    // 404 for a foreign citation too: a 403 would confirm that it exists.
    if (!citation || citation->value("tenant", std::string()) != tenant) {
      res.status = 404;
      res.set_content(R"({"error":"unknown citation"})", "application/json");
      return;
    }
    res.status = 200;
    res.set_content(evidence(*citation).dump(), "application/json");
  });

  svr.Get(R"(/v1/answers/([\\w-]+)/citations)", [](const httplib::Request& req, httplib::Response& res) {
    const std::string tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const std::string answerId = req.matches[1];
    const auto citations = store.forAnswer(answerId, tenant);
    if (citations.empty()) {
      res.status = 404;
      res.set_content(R"({"error":"unknown answer"})", "application/json");
      return;
    }
    json rows = json::array();
    for (const auto& citation : citations) rows.push_back(evidence(citation));
    res.status = 200;
    res.set_content(
        json{{"answer_id", answerId}, {"status", answerStatus(citations)}, {"citations", rows}}.dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The interviewer is testing two boundaries in one read: who may see a citation, and what the reader is told. The IDOR is the obvious one — a lookup by id without the tenant predicate turns any authenticated session into a reader of every tenant’s citations, and the fix is the 404 that refuses to confirm existence, not a post-fetch check. The status is the subtler one: \`valid if the document exists\` replaces the stored verification with a lookup, so a citation that could not be re-anchored reads as fine because the document is still there. And an answer’s status has to be the worst of its citations, ranked explicitly, with \`degraded\` for a broken one: any rule that takes the first (or the majority) makes the answer’s verdict depend on ordering instead of on the evidence. Real readers add per-citation reason codes in the response, a stable pagination cursor over citations, and a cached aggregate of answer statuses that is invalidated by verification events.`,
};
