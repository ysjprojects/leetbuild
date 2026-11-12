import type {Step} from '@/lib/types';

export const citationEndpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/citations: spans that must resolve',
  concept: 'http',
  guides: ['request-boundaries', 'model-output', 'idempotent-requests'],
  file: 'api',
  focus: ['client', 'api', 'db'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/citations\` with body \`{"answer_id", "document_id",
"version", "start", "end", "quote"}\`: it reads the tenant from \`X-Tenant-Id\`, slices the document's
newest text (\`documents.latest\`) at the caller's offsets and stores that slice as the quote through
\`store.create\`, answering **201** with the row. It serves the demo and hides four flaws.

**Failure mode the checks target.** A citation is a claim that these characters, at these offsets,
in this version, say this. The starter accepts a request with no tenant or an empty span, never
compares the quote with the document, resolves a version 1 citation against version 2's text, and
records a client's retry as a second citation.

- A missing \`X-Tenant-Id\` is **401**. \`version < 1\`, \`start < 0\`, \`end <= start\`, an empty
  \`document_id\` or \`answer_id\`, and a quote empty or longer than \`MAX_QUOTE_CHARS\` (16 KiB) are
  **400**.
- Resolve the span in the **named version** (\`documents.get_version\`; an unknown version is **404**).
- The quote must equal the text at \`[start, end)\`; a mismatch is **422** with
  \`{"stored": …, "supplied": …}\`.
- \`Idempotency-Key\` is required (**400**). Look it up with \`store.by_key(tenant, key)\` before
  creating: a replay answers the citation the first attempt created; a new citation is bound with
  \`store.bind_key\`.`,
  sequence: {
    participants: ['Client', 'Citation API', 'documents', 'citation store'],
    messages: [
      {from: 'Client', to: 'Citation API', label: 'POST /v1/citations · X-Tenant-Id · Idempotency-Key', kind: 'sync'},
      {from: 'Citation API', to: 'Citation API', label: 'tenant → 401 · span, MAX_QUOTE_CHARS → 400', kind: 'sync'},
      {from: 'Citation API', to: 'citation store', label: 'by_key(tenant, key)', kind: 'sync'},
      {from: 'citation store', to: 'Citation API', label: 'the first attempt’s citation / none', kind: 'reply'},
      {from: 'Citation API', to: 'documents', label: 'get_version(document_id, version)', kind: 'sync'},
      {from: 'documents', to: 'Citation API', label: 'that version’s text', kind: 'reply'},
      {
        from: 'Citation API',
        to: 'Citation API',
        label: 'text[start:end] != quote → 422 {stored, supplied}',
        kind: 'sync',
      },
      {
        from: 'Citation API',
        to: 'citation store',
        label: 'create(tenant, …) · bind_key(tenant, key, id)',
        kind: 'sync',
      },
      {
        from: 'Citation API',
        to: 'Client',
        label: '201 {id, version, start, end, quote, status: pending}',
        kind: 'reply',
      },
    ],
  },
  hints: [
    'Publish version 2 of a document, then cite version 1: the stored quote is version 2’s text. Retry a timed-out request and the answer owns two citation ids for one quote.',
    'The starter never reads the version the request names: it slices `documents.latest` and stores that slice in place of the quote, so nothing is ever compared, and it never looks at `Idempotency-Key`.',
    'Answer 401/400 before any read, look up `store.by_key(tenant, key)`, read `documents.get_version(document_id, version)`, answer 422 with `stored` and `supplied` when `text[start:end] != quote`, then `store.create` and `store.bind_key`.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/citations',
      detail: 'Register `POST /v1/citations`, answering **201** with the stored citation.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/citations["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/citations['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/citations"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"citations"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/citations"/]},
      },
    },
    {
      id: 'validate',
      title: 'Rejects a missing tenant and a malformed span',
      detail:
        'A missing `X-Tenant-Id` is **401**; `version < 1`, `start < 0`, `end <= start`, an empty id and a quote over `MAX_QUOTE_CHARS` are **400**, and nothing is stored. The starter stores whatever arrives.',
      match: {
        python: {
          all: [
            /\b401\b/,
            /\b400\b/,
            /version\s*(<\s*1|<=\s*0)/,
            /end\s*<=\s*[\w.]*start|start\s*>=\s*[\w.]*end/,
            /MAX_QUOTE_CHARS/,
          ],
        },
        typescript: {
          all: [
            /code\(\s*401\s*\)/,
            /code\(\s*400\s*\)/,
            /version\s*(<\s*1|<=\s*0)/,
            /end\s*<=\s*[\w.]*start|start\s*>=\s*[\w.]*end/,
            /MAX_QUOTE_CHARS/,
          ],
        },
        go: {
          all: [
            /StatusUnauthorized|\b401\b/,
            /StatusBadRequest|\b400\b/,
            /Version\s*(<\s*1|<=\s*0)/,
            /End\s*<=\s*[\w.]*Start|Start\s*>=\s*[\w.]*End/,
            /maxQuoteChars/,
          ],
        },
        scala: {
          all: [
            /Unauthorized|\b401\b/,
            /BadRequest|\b400\b/,
            /version\s*(<\s*1|<=\s*0)/,
            /end\s*<=\s*[\w.]*start|start\s*>=\s*[\w.]*end/,
            /MaxQuoteChars/,
          ],
        },
        cpp: {
          all: [
            /\b401\b/,
            /\b400\b/,
            /version\s*(<\s*1|<=\s*0)/,
            /end\s*<=\s*[\w.]*start|start\s*>=\s*[\w.]*end/,
            /kMaxQuoteChars/,
          ],
        },
      },
    },
    {
      id: 'span-match',
      title: 'The quote must equal the text at those offsets',
      detail:
        'The quote is compared with the version’s text at `[start, end)`; a mismatch answers **422** with `stored` (the text that is there) and `supplied` (the quote sent), and nothing is stored. The starter never compares: it stores its own slice.',
      match: {
        python: {all: [/\b422\b/, /["']stored["']/, /["']supplied["']/, /!=\s*body\.quote\b/]},
        typescript: {all: [/code\(\s*422\s*\)/, /\bstored\b/, /\bsupplied\b/, /!==?\s*body\.quote\b/]},
        go: {all: [/StatusUnprocessableEntity|\b422\b/, /"stored"/, /"supplied"/, /!=\s*body\.Quote\b/]},
        scala: {all: [/UnprocessableEntity|\b422\b/, /"stored"/, /"supplied"/, /!=\s*body\.quote\b/]},
        cpp: {all: [/\b422\b/, /"stored"/, /"supplied"/, /!=\s*body\.quote\b/]},
      },
    },
    {
      id: 'version-scope',
      title: 'Resolves the span in the named version',
      detail:
        'The text comes from `get_version(document_id, version)`, the immutable version the request names, so a citation of version 1 keeps version 1’s quote after version 2 is published. The starter reads `latest`.',
      match: {
        python: {all: [/documents\.get_version\(/], none: [/documents\.latest\(/]},
        typescript: {all: [/getVersion\(/], none: [/\blatest\(/]},
        go: {all: [/documents\.GetVersion\(/], none: [/documents\.Latest\(/]},
        scala: {all: [/Documents\.getVersion\(/], none: [/Documents\.latest\(/]},
        cpp: {all: [/documents::getVersion\(/], none: [/documents::latest\(/]},
      },
    },
    {
      id: 'idempotent',
      title: 'Keys a retried request by (tenant, Idempotency-Key)',
      detail:
        '`Idempotency-Key` is required (**400**), the citation it created is looked up (`by_key`/`byKey`) before anything is created, and a new citation is bound to it; a retry answers the same id.',
      match: {
        python: {
          all: [/idempotency-key/i, /store\.by_key\(/, /store\.bind_key\(/],
          order: [/store\.by_key\(/, /store\.create\(/],
        },
        typescript: {all: [/idempotency-key/i, /byKey\(/, /bindKey\(/], order: [/byKey\(/, /\bcreate\(/]},
        go: {
          all: [/Idempotency-Key/i, /store\.ByKey\(/, /store\.BindKey\(/],
          order: [/store\.ByKey\(/, /store\.Create\(/],
        },
        scala: {
          all: [/Idempotency-Key/i, /Store\.byKey\(/, /Store\.bindKey\(/],
          order: [/Store\.byKey\(/, /Store\.create\(/],
        },
        cpp: {
          all: [/Idempotency-Key/i, /store::byKey\(/, /store::bindKey\(/],
          order: [/store::byKey\(/, /store::create\(/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from citations import documents, store  # documents.get_version, latest; store.create, by_key, bind_key

app = FastAPI()


class CitationRequest(BaseModel):
    answer_id: str
    document_id: str
    version: int
    start: int
    end: int
    quote: str


@app.post("/v1/citations", status_code=201)
def create_citation(body: CitationRequest, request: Request) -> JSONResponse:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    text = documents.latest(body.document_id) or ""
    citation = store.create(tenant, {**body.model_dump(), "quote": text[body.start : body.end]})
    return JSONResponse(citation, status_code=201)
`,
      solution: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from citations import documents, store  # documents.get_version, latest; store.create, by_key, bind_key

app = FastAPI()

MAX_QUOTE_CHARS = 16 * 1024


class CitationRequest(BaseModel):
    answer_id: str
    document_id: str
    version: int
    start: int
    end: int
    quote: str


def span_error(body: CitationRequest) -> str | None:
    """Why the request cannot be a citation, or None."""
    if not body.document_id or not body.answer_id:
        return "document_id and answer_id are required"
    if body.version < 1:
        return "version must be >= 1"
    if body.start < 0 or body.end <= body.start:
        return "the span must have 0 <= start < end"
    if not body.quote or len(body.quote) > MAX_QUOTE_CHARS:
        return f"the quote must be 1 to {MAX_QUOTE_CHARS} characters"
    return None


@app.post("/v1/citations", status_code=201)
def create_citation(body: CitationRequest, request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        return JSONResponse({"error": "X-Tenant-Id is required"}, status_code=401)
    key = request.headers.get("idempotency-key", "")
    if not key:
        return JSONResponse({"error": "Idempotency-Key is required"}, status_code=400)
    error = span_error(body)
    if error is not None:
        return JSONResponse({"error": error}, status_code=400)
    replay = store.by_key(tenant, key)
    if replay is not None:
        return JSONResponse(replay, status_code=201)  # a retry answers the citation the first attempt created
    # The version the request names: it never changes, so neither does what the citation points at.
    text = documents.get_version(body.document_id, body.version)
    if text is None:
        return JSONResponse({"error": "no such document version"}, status_code=404)
    stored = text[body.start : body.end]
    if stored != body.quote:
        return JSONResponse({"error": "the quote is not the text at those offsets", "stored": stored, "supplied": body.quote}, status_code=422)
    citation = store.create(tenant, body.model_dump())
    store.bind_key(tenant, key, citation["id"])
    return JSONResponse(citation, status_code=201)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {getVersion, latest} from 'citations/documents';
import {type CitationFields, bindKey, byKey, create} from 'citations/store';

export const app = Fastify();

app.post('/v1/citations', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const tenant = (request.headers['x-tenant-id'] as string | undefined) ?? '';
  const body = request.body as CitationFields;
  const text = (await latest(body.document_id)) ?? '';
  const citation = await create(tenant, {...body, quote: text.slice(body.start, body.end)});
  return reply.code(201).send(citation);
});
`,
      solution: `import Fastify from 'fastify';

import {getVersion, latest} from 'citations/documents';
import {type CitationFields, bindKey, byKey, create} from 'citations/store';

export const app = Fastify();

export const MAX_QUOTE_CHARS = 16 * 1024;

/** Why the request cannot be a citation, or null. */
function spanError(body: CitationFields): string | null {
  if (!body.document_id || !body.answer_id) return 'document_id and answer_id are required';
  if (!Number.isInteger(body.version) || body.version < 1) return 'version must be an integer >= 1';
  if (!Number.isInteger(body.start) || !Number.isInteger(body.end) || body.start < 0 || body.end <= body.start) {
    return 'the span must have 0 <= start < end';
  }
  if (!body.quote || body.quote.length > MAX_QUOTE_CHARS) return \`the quote must be 1 to \${MAX_QUOTE_CHARS} characters\`;
  return null;
}

app.post('/v1/citations', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key === '') return reply.code(400).send({error: 'Idempotency-Key is required'});
  const body = request.body as CitationFields;
  const error = spanError(body);
  if (error !== null) return reply.code(400).send({error});
  const replay = await byKey(tenant, key);
  if (replay !== null) return reply.code(201).send(replay); // a retry answers the citation the first attempt created
  // The version the request names: it never changes, so neither does what the citation points at.
  const text = await getVersion(body.document_id, body.version);
  if (text === null) return reply.code(404).send({error: 'no such document version'});
  const stored = text.slice(body.start, body.end);
  if (stored !== body.quote) {
    return reply.code(422).send({error: 'the quote is not the text at those offsets', stored, supplied: body.quote});
  }
  const citation = await create(tenant, body);
  await bindKey(tenant, key, citation.id);
  return reply.code(201).send(citation);
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"citations/documents" // documents.GetVersion, Latest
	"citations/store"     // store.Create, ByKey, BindKey
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

// span is text[start:end], clamped to the text.
func span(text string, start, end int) string {
	start, end = max(start, 0), min(end, len(text))
	if start >= end {
		return ""
	}
	return text[start:end]
}

func createCitation(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	var body store.Citation
	json.NewDecoder(r.Body).Decode(&body)
	text, _ := documents.Latest(r.Context(), body.DocumentID)
	body.Quote = span(text, body.Start, body.End)
	writeJSON(rw, http.StatusCreated, store.Create(r.Context(), tenant, body))
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/citations", createCitation)
}
`,
      solution: `package main

import (
	"encoding/json"
	"fmt"
	"net/http"

	"citations/documents" // documents.GetVersion, Latest
	"citations/store"     // store.Create, ByKey, BindKey
)

const maxQuoteChars = 16 * 1024

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

// span is text[start:end], clamped to the text.
func span(text string, start, end int) string {
	start, end = max(start, 0), min(end, len(text))
	if start >= end {
		return ""
	}
	return text[start:end]
}

// spanError says why the request cannot be a citation, or "".
func spanError(body store.Citation) string {
	if body.DocumentID == "" || body.AnswerID == "" {
		return "document_id and answer_id are required"
	}
	if body.Version < 1 {
		return "version must be >= 1"
	}
	if body.Start < 0 || body.End <= body.Start {
		return "the span must have 0 <= start < end"
	}
	if body.Quote == "" || len(body.Quote) > maxQuoteChars {
		return fmt.Sprintf("the quote must be 1 to %d characters", maxQuoteChars)
	}
	return ""
}

func createCitation(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	key := r.Header.Get("Idempotency-Key")
	if key == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "Idempotency-Key is required"})
		return
	}
	var body store.Citation
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if msg := spanError(body); msg != "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": msg})
		return
	}
	if replay := store.ByKey(r.Context(), tenant, key); replay != nil {
		writeJSON(rw, http.StatusCreated, replay) // a retry answers the citation the first attempt created
		return
	}
	// The version the request names: it never changes, so neither does what the citation points at.
	text, ok := documents.GetVersion(r.Context(), body.DocumentID, body.Version)
	if !ok {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such document version"})
		return
	}
	if stored := span(text, body.Start, body.End); stored != body.Quote {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "the quote is not the text at those offsets", "stored": stored, "supplied": body.Quote})
		return
	}
	citation := store.Create(r.Context(), tenant, body)
	store.BindKey(r.Context(), tenant, key, citation.ID)
	writeJSON(rw, http.StatusCreated, citation)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/citations", createCitation)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import citations.{Documents, Store} // Documents.getVersion, latest; Store.create, byKey, bindKey

object Api {
  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  /** The request body as a citation of no one yet: answer_id, document_id, version, start, end, quote. */
  private def citationOf(raw: String): Store.Citation = {
    val fields = raw.parseJson.asJsObject.fields
    def text(name: String): String = fields.get(name).collect { case JsString(s) => s }.getOrElse("")
    def number(name: String): Long = fields.get(name).collect { case JsNumber(n) => n.toLong }.getOrElse(0L)
    Store.Citation("", "", text("answer_id"), text("document_id"), number("version"), number("start"), number("end"), text("quote"), "", "")
  }

  val route: Route =
    path("v1" / "citations") {
      post {
        (optionalHeaderValueByName("X-Tenant-Id") & optionalHeaderValueByName("Idempotency-Key")) { (tenant, key) =>
          entity(as[String]) { raw =>
            // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
            val body = citationOf(raw)
            val text = Documents.latest(body.documentId).getOrElse("")
            val citation = Store.create(tenant.getOrElse(""), body.copy(quote = text.slice(body.start.toInt, body.end.toInt)))
            complete(json(StatusCodes.Created, citation.toJson))
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

import citations.{Documents, Store} // Documents.getVersion, latest; Store.create, byKey, bindKey

object Api {
  val MaxQuoteChars: Int = 16 * 1024

  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  /** The request body as a citation of no one yet: answer_id, document_id, version, start, end, quote. */
  private def citationOf(raw: String): Store.Citation = {
    val fields = raw.parseJson.asJsObject.fields
    def text(name: String): String = fields.get(name).collect { case JsString(s) => s }.getOrElse("")
    def number(name: String): Long = fields.get(name).collect { case JsNumber(n) => n.toLong }.getOrElse(0L)
    Store.Citation("", "", text("answer_id"), text("document_id"), number("version"), number("start"), number("end"), text("quote"), "", "")
  }

  /** Why the request cannot be a citation. */
  def spanError(body: Store.Citation): Option[String] =
    if (body.documentId.isEmpty || body.answerId.isEmpty) Some("document_id and answer_id are required")
    else if (body.version < 1) Some("version must be >= 1")
    else if (body.start < 0 || body.end <= body.start) Some("the span must have 0 <= start < end")
    else if (body.quote.isEmpty || body.quote.length > MaxQuoteChars) Some(s"the quote must be 1 to $MaxQuoteChars characters")
    else None

  def createCitation(tenant: String, key: String, body: Store.Citation): HttpResponse =
    if (tenant.isEmpty) error(StatusCodes.Unauthorized, "X-Tenant-Id is required")
    else if (key.isEmpty) error(StatusCodes.BadRequest, "Idempotency-Key is required")
    else
      spanError(body) match {
        case Some(message) => error(StatusCodes.BadRequest, message)
        case None =>
          Store.byKey(tenant, key) match {
            case Some(replay) => json(StatusCodes.Created, replay.toJson) // a retry answers the citation the first attempt created
            case None =>
              // The version the request names: it never changes, so neither does what the citation points at.
              Documents.getVersion(body.documentId, body.version) match {
                case None => error(StatusCodes.NotFound, "no such document version")
                case Some(text) =>
                  val stored = text.slice(body.start.toInt, body.end.toInt)
                  if (stored != body.quote)
                    json(
                      StatusCodes.UnprocessableEntity,
                      JsObject("error" -> JsString("the quote is not the text at those offsets"), "stored" -> JsString(stored), "supplied" -> JsString(body.quote))
                    )
                  else {
                    val citation = Store.create(tenant, body)
                    Store.bindKey(tenant, key, citation.id)
                    json(StatusCodes.Created, citation.toJson)
                  }
              }
          }
      }

  val route: Route =
    path("v1" / "citations") {
      post {
        (optionalHeaderValueByName("X-Tenant-Id") & optionalHeaderValueByName("Idempotency-Key")) { (tenant, key) =>
          entity(as[String]) { raw =>
            complete(createCitation(tenant.getOrElse(""), key.getOrElse(""), citationOf(raw)))
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
#include <string>

#include "citations/documents.h"  // documents::getVersion, latest
#include "citations/store.h"      // store::create, byKey, bindKey

using json = nlohmann::json;

// text[start, end), clamped to the text.
std::string span(const std::string& text, long start, long end) {
  start = std::max(start, 0L);
  end = std::min(end, static_cast<long>(text.size()));
  return start >= end ? "" : text.substr(start, end - start);
}

// The request body as a citation of no one yet: answer_id, document_id, version, start, end, quote.
store::Citation citationOf(const json& body) {
  store::Citation c;
  c.answer_id = body.value("answer_id", "");
  c.document_id = body.value("document_id", "");
  c.version = body.value("version", 0L);
  c.start = body.value("start", 0L);
  c.end = body.value("end", 0L);
  c.quote = body.value("quote", "");
  return c;
}

void create_citation(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  store::Citation body = citationOf(json::parse(req.body));
  body.quote = span(documents::latest(body.document_id).value_or(""), body.start, body.end);
  res.status = 201;
  res.set_content(store::toJson(store::create(tenant, body)).dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/citations", create_citation);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <string>

#include "citations/documents.h"  // documents::getVersion, latest
#include "citations/store.h"      // store::create, byKey, bindKey

using json = nlohmann::json;

constexpr long kMaxQuoteChars = 16 * 1024;

// text[start, end), clamped to the text.
std::string span(const std::string& text, long start, long end) {
  start = std::max(start, 0L);
  end = std::min(end, static_cast<long>(text.size()));
  return start >= end ? "" : text.substr(start, end - start);
}

// The request body as a citation of no one yet: answer_id, document_id, version, start, end, quote.
store::Citation citationOf(const json& body) {
  store::Citation c;
  c.answer_id = body.value("answer_id", "");
  c.document_id = body.value("document_id", "");
  c.version = body.value("version", 0L);
  c.start = body.value("start", 0L);
  c.end = body.value("end", 0L);
  c.quote = body.value("quote", "");
  return c;
}

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

// Why the request cannot be a citation, or "".
std::string spanError(const store::Citation& body) {
  if (body.document_id.empty() || body.answer_id.empty()) return "document_id and answer_id are required";
  if (body.version < 1) return "version must be >= 1";
  if (body.start < 0 || body.end <= body.start) return "the span must have 0 <= start < end";
  if (body.quote.empty() || static_cast<long>(body.quote.size()) > kMaxQuoteChars) {
    return "the quote must be 1 to " + std::to_string(kMaxQuoteChars) + " characters";
  }
  return "";
}

void create_citation(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, json{{"error", "X-Tenant-Id is required"}});
  const std::string key = req.get_header_value("Idempotency-Key");
  if (key.empty()) return reply(res, 400, json{{"error", "Idempotency-Key is required"}});
  const json parsed = json::parse(req.body, nullptr, false);
  if (!parsed.is_object()) return reply(res, 400, json{{"error", "the body must be a JSON object"}});
  const store::Citation body = citationOf(parsed);
  if (const std::string error = spanError(body); !error.empty()) return reply(res, 400, json{{"error", error}});
  if (const auto replay = store::byKey(tenant, key)) {
    return reply(res, 201, store::toJson(*replay));  // a retry answers the citation the first attempt created
  }
  // The version the request names: it never changes, so neither does what the citation points at.
  const auto text = documents::getVersion(body.document_id, body.version);
  if (!text) return reply(res, 404, json{{"error", "no such document version"}});
  const std::string stored = span(*text, body.start, body.end);
  if (stored != body.quote) {
    return reply(res, 422, json{{"error", "the quote is not the text at those offsets"}, {"stored", stored}, {"supplied", body.quote}});
  }
  const store::Citation citation = store::create(tenant, body);
  store::bindKey(tenant, key, citation.id);
  reply(res, 201, store::toJson(citation));
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/citations", create_citation);
}
`,
    },
  },
  harness: {
    python: `from citations import documents, store

V1 = "The tower is 300 metres tall and opened in 1889."
V2 = "The tower is 330 metres tall and opened in 1889."


def _api(ctx):
    return ctx.client(ctx.load("api").app)


def _body(**over):
    return {"answer_id": "a-1", "document_id": "doc-7", "version": 1, "start": 13, "end": 16, "quote": "300", **over}


async def _cite(c, body, tenant="t1", key="k-1"):
    headers = {}
    if tenant:
        headers["X-Tenant-Id"] = tenant
    if key:
        headers["Idempotency-Key"] = key
    return await c.post("/v1/citations", json=body, headers=headers)


async def check_route(ctx):
    documents.add_version("doc-7", V1)
    async with _api(ctx) as c:
        r = await _cite(c, _body())
    assert r.status_code == 201, f"POST /v1/citations answered {r.status_code}: {r.text}"
    citation_id = r.json().get("id")
    row = store.get(citation_id) if citation_id else None
    assert row is not None and row["document_id"] == "doc-7" and row["quote"] == "300", f"the answer {r.text} names no stored citation of doc-7 quoting 300 (stored: {row})"


async def check_validate(ctx):
    documents.add_version("doc-7", V1)
    async with _api(ctx) as c:
        r = await _cite(c, _body(), tenant="")
        assert r.status_code == 401, f"a citation without X-Tenant-Id answered {r.status_code}, expected 401: a citation belongs to an authenticated tenant"
        cases = [
            ("version 0", _body(version=0)),
            ("start -1", _body(start=-1)),
            ("end equal to start", _body(end=13, quote="3")),
            ("an empty document_id", _body(document_id="")),
            ("a quote over 16 KiB", _body(start=0, end=16385, quote="x" * 16385)),
        ]
        for n, (what, body) in enumerate(cases):
            r = await _cite(c, body, key=f"k-{n}")
            assert r.status_code == 400, f"a request with {what} answered {r.status_code} {r.text[:160]}, expected 400"
    assert store.get("c-1") is None, f"a rejected request stored a citation: {store.get('c-1')}"


async def check_span_match(ctx):
    documents.add_version("doc-7", V1)
    async with _api(ctx) as c:
        r = await _cite(c, _body(quote="301"))
    assert r.status_code == 422, f"quoting 301 where version 1 says 300 answered {r.status_code} {r.text}, expected 422"
    body = r.json()
    assert body.get("stored") == "300" and body.get("supplied") == "301", f"the 422 must carry both texts, stored 300 and supplied 301, got {body}"
    assert store.get("c-1") is None, f"a quote that is not the text at its offsets was stored: {store.get('c-1')}"


async def check_version_scope(ctx):
    documents.add_version("doc-7", V1)
    documents.add_version("doc-7", V2)
    async with _api(ctx) as c:
        r = await _cite(c, _body(), key="k-1")
        assert r.status_code == 201, f"citing version 1 with its own text (300) answered {r.status_code} {r.text}: the span must resolve in the version the request names, not the newest one"
        row = store.get(r.json()["id"])
        assert row["version"] == 1 and row["quote"] == "300", f"the citation of version 1 was stored as version {row['version']} quoting {row['quote']!r}: version 1 says 300, version 2 says 330"
        r = await _cite(c, _body(version=2, quote="330"), key="k-2")
        assert r.status_code == 201, f"citing version 2 with its own text (330) answered {r.status_code} {r.text}"
        r = await _cite(c, _body(quote="330"), key="k-3")
    assert r.status_code == 422, f"quoting version 2's text (330) as version 1 answered {r.status_code}, expected 422: version 1 says 300"


async def check_idempotent(ctx):
    documents.add_version("doc-7", V1)
    async with _api(ctx) as c:
        first = await _cite(c, _body(), key="k-1")
        retry = await _cite(c, _body(), key="k-1")
        assert first.status_code == 201 and retry.status_code == 201, f"the first attempt answered {first.status_code}, the retry {retry.status_code}: {retry.text}"
        assert retry.json().get("id") == first.json().get("id"), f"a retry with the same Idempotency-Key created {retry.json().get('id')} next to {first.json().get('id')}: it must answer the citation the first attempt created"
        rows = store.for_answer("a-1")
        assert len(rows) == 1, f"two attempts with one Idempotency-Key stored {len(rows)} citations"
        other = await _cite(c, _body(), tenant="t2", key="k-1")
        assert other.status_code == 201 and other.json().get("id") != first.json().get("id"), f"another tenant's request with the same key answered {other.status_code} {other.text}: keys are scoped by tenant"
        none = await _cite(c, _body(), key="")
    assert none.status_code == 400, f"a citation without Idempotency-Key answered {none.status_code}, expected 400"
`,
    typescript: `const V1 = 'The tower is 300 metres tall and opened in 1889.';
const V2 = 'The tower is 330 metres tall and opened in 1889.';

function api(ctx) {
  return {
    c: ctx.client(ctx.load('api').app),
    documents: ctx.load('/support/citations/documents.ts'),
    store: ctx.load('/support/citations/store.ts'),
  };
}

const body = (over = {}) => ({answer_id: 'a-1', document_id: 'doc-7', version: 1, start: 13, end: 16, quote: '300', ...over});

function cite(c, json, tenant = 't1', key = 'k-1') {
  const headers: Record<string, string> = {};
  if (tenant) headers['X-Tenant-Id'] = tenant;
  if (key) headers['Idempotency-Key'] = key;
  return c.post('/v1/citations', {json, headers});
}

export async function check_route(ctx) {
  const {c, documents, store} = api(ctx);
  await documents.addVersion('doc-7', V1);
  const r = await cite(c, body());
  assert.equal(r.status, 201, \`POST /v1/citations answered \${r.status}: \${r.text}\`);
  const id = r.json().id;
  const row = id ? await store.get(id) : null;
  assert(row !== null && row.document_id === 'doc-7' && row.quote === '300', \`the answer \${r.text} names no stored citation of doc-7 quoting 300 (stored: \${JSON.stringify(row)})\`);
}

export async function check_validate(ctx) {
  const {c, documents, store} = api(ctx);
  await documents.addVersion('doc-7', V1);
  let r = await cite(c, body(), '');
  assert.equal(r.status, 401, \`a citation without X-Tenant-Id answered \${r.status}, expected 401: a citation belongs to an authenticated tenant\`);
  const cases: [string, object][] = [
    ['version 0', body({version: 0})],
    ['start -1', body({start: -1})],
    ['end equal to start', body({end: 13, quote: '3'})],
    ['an empty document_id', body({document_id: ''})],
    ['a quote over 16 KiB', body({start: 0, end: 16385, quote: 'x'.repeat(16385)})],
  ];
  for (const [n, [what, json]] of cases.entries()) {
    r = await cite(c, json, 't1', \`k-\${n}\`);
    assert.equal(r.status, 400, \`a request with \${what} answered \${r.status} \${r.text.slice(0, 160)}, expected 400\`);
  }
  assert.equal(await store.get('c-1'), null, 'a rejected request stored a citation');
}

export async function check_span_match(ctx) {
  const {c, documents, store} = api(ctx);
  await documents.addVersion('doc-7', V1);
  const r = await cite(c, body({quote: '301'}));
  assert.equal(r.status, 422, \`quoting 301 where version 1 says 300 answered \${r.status} \${r.text}, expected 422\`);
  const b = r.json();
  assert(b.stored === '300' && b.supplied === '301', \`the 422 must carry both texts, stored 300 and supplied 301, got \${r.text}\`);
  assert.equal(await store.get('c-1'), null, 'a quote that is not the text at its offsets was stored');
}

export async function check_version_scope(ctx) {
  const {c, documents, store} = api(ctx);
  await documents.addVersion('doc-7', V1);
  await documents.addVersion('doc-7', V2);
  let r = await cite(c, body(), 't1', 'k-1');
  assert.equal(r.status, 201, \`citing version 1 with its own text (300) answered \${r.status} \${r.text}: the span must resolve in the version the request names, not the newest one\`);
  const row = await store.get(r.json().id);
  assert(row.version === 1 && row.quote === '300', \`the citation of version 1 was stored as version \${row.version} quoting \${JSON.stringify(row.quote)}: version 1 says 300, version 2 says 330\`);
  r = await cite(c, body({version: 2, quote: '330'}), 't1', 'k-2');
  assert.equal(r.status, 201, \`citing version 2 with its own text (330) answered \${r.status} \${r.text}\`);
  r = await cite(c, body({quote: '330'}), 't1', 'k-3');
  assert.equal(r.status, 422, \`quoting version 2's text (330) as version 1 answered \${r.status}, expected 422: version 1 says 300\`);
}

export async function check_idempotent(ctx) {
  const {c, documents, store} = api(ctx);
  await documents.addVersion('doc-7', V1);
  const first = await cite(c, body(), 't1', 'k-1');
  const retry = await cite(c, body(), 't1', 'k-1');
  assert(first.status === 201 && retry.status === 201, \`the first attempt answered \${first.status}, the retry \${retry.status}: \${retry.text}\`);
  assert.equal(retry.json().id, first.json().id, \`a retry with the same Idempotency-Key created \${retry.json().id} next to \${first.json().id}: it must answer the citation the first attempt created\`);
  const rows = await store.forAnswer('a-1');
  assert.equal(rows.length, 1, \`two attempts with one Idempotency-Key stored \${rows.length} citations\`);
  const other = await cite(c, body(), 't2', 'k-1');
  assert(other.status === 201 && other.json().id !== first.json().id, \`another tenant's request with the same key answered \${other.status} \${other.text}: keys are scoped by tenant\`);
  const none = await cite(c, body(), 't1', '');
  assert.equal(none.status, 400, \`a citation without Idempotency-Key answered \${none.status}, expected 400\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"citations/documents"
	"citations/store"

	"leetbuild/harness"
)

const (
	apiV1 = "The tower is 300 metres tall and opened in 1889."
	apiV2 = "The tower is 330 metres tall and opened in 1889."
)

var apiBg = context.Background()

func api(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func citeBody(over map[string]any) map[string]any {
	body := map[string]any{"answer_id": "a-1", "document_id": "doc-7", "version": 1, "start": 13, "end": 16, "quote": "300"}
	for k, v := range over {
		body[k] = v
	}
	return body
}

func cite(c *harness.HTTP, body map[string]any, tenant, key string) *harness.Response {
	header := []string{}
	if tenant != "" {
		header = append(header, "X-Tenant-Id", tenant)
	}
	if key != "" {
		header = append(header, "Idempotency-Key", key)
	}
	return c.Post("/v1/citations", body, header...)
}

func idOf(r *harness.Response) string {
	m, _ := r.JSON().(map[string]any)
	id, _ := m["id"].(string)
	return id
}

func CheckRoute(ctx *harness.Ctx) {
	documents.AddVersion(apiBg, "doc-7", apiV1)
	r := cite(api(ctx), citeBody(nil), "t1", "k-1")
	ctx.Equal(r.Status, 201, "POST /v1/citations (%s)", r.Text())
	row := store.Get(apiBg, idOf(r))
	ctx.Assert(row != nil && row.DocumentID == "doc-7" && row.Quote == "300", "the answer %s names no stored citation of doc-7 quoting 300 (stored: %+v)", r.Text(), row)
}

func CheckValidate(ctx *harness.Ctx) {
	documents.AddVersion(apiBg, "doc-7", apiV1)
	c := api(ctx)
	r := cite(c, citeBody(nil), "", "k-1")
	ctx.Equal(r.Status, 401, "a citation without X-Tenant-Id (a citation belongs to an authenticated tenant)")
	cases := []struct {
		what string
		over map[string]any
	}{
		{"version 0", map[string]any{"version": 0}},
		{"start -1", map[string]any{"start": -1}},
		{"end equal to start", map[string]any{"end": 13, "quote": "3"}},
		{"an empty document_id", map[string]any{"document_id": ""}},
		{"a quote over 16 KiB", map[string]any{"start": 0, "end": 16385, "quote": strings.Repeat("x", 16385)}},
	}
	for n, tc := range cases {
		r = cite(c, citeBody(tc.over), "t1", fmt.Sprintf("k-%d", n))
		ctx.Equal(r.Status, 400, "a request with %s", tc.what)
	}
	ctx.Assert(store.Get(apiBg, "c-1") == nil, "a rejected request stored a citation: %+v", store.Get(apiBg, "c-1"))
}

func CheckSpanMatch(ctx *harness.Ctx) {
	documents.AddVersion(apiBg, "doc-7", apiV1)
	r := cite(api(ctx), citeBody(map[string]any{"quote": "301"}), "t1", "k-1")
	ctx.Equal(r.Status, 422, "quoting 301 where version 1 says 300 (%s)", r.Text())
	b, _ := r.JSON().(map[string]any)
	ctx.Assert(b["stored"] == "300" && b["supplied"] == "301", "the 422 must carry both texts, stored 300 and supplied 301, got %s", r.Text())
	ctx.Assert(store.Get(apiBg, "c-1") == nil, "a quote that is not the text at its offsets was stored: %+v", store.Get(apiBg, "c-1"))
}

func CheckVersionScope(ctx *harness.Ctx) {
	documents.AddVersion(apiBg, "doc-7", apiV1)
	documents.AddVersion(apiBg, "doc-7", apiV2)
	c := api(ctx)
	r := cite(c, citeBody(nil), "t1", "k-1")
	ctx.Equal(r.Status, 201, "citing version 1 with its own text (300) must succeed: the span resolves in the version the request names, not the newest one (%s)", r.Text())
	row := store.Get(apiBg, idOf(r))
	ctx.Assert(row != nil && row.Version == 1 && row.Quote == "300", "the citation of version 1 was stored as %+v: version 1 says 300, version 2 says 330", row)
	r = cite(c, citeBody(map[string]any{"version": 2, "quote": "330"}), "t1", "k-2")
	ctx.Equal(r.Status, 201, "citing version 2 with its own text (330) (%s)", r.Text())
	r = cite(c, citeBody(map[string]any{"quote": "330"}), "t1", "k-3")
	ctx.Equal(r.Status, 422, "quoting version 2's text (330) as version 1 (version 1 says 300)")
}

func CheckIdempotent(ctx *harness.Ctx) {
	documents.AddVersion(apiBg, "doc-7", apiV1)
	c := api(ctx)
	first := cite(c, citeBody(nil), "t1", "k-1")
	retry := cite(c, citeBody(nil), "t1", "k-1")
	ctx.Assert(first.Status == 201 && retry.Status == 201, "the first attempt answered %d, the retry %d: %s", first.Status, retry.Status, retry.Text())
	ctx.Equal(idOf(retry), idOf(first), "a retry with the same Idempotency-Key must answer the citation the first attempt created; the id")
	ctx.Equal(len(store.ForAnswer(apiBg, "a-1")), 1, "two attempts with one Idempotency-Key; the citations stored")
	other := cite(c, citeBody(nil), "t2", "k-1")
	ctx.Assert(other.Status == 201 && idOf(other) != idOf(first), "another tenant's request with the same key answered %d %s: keys are scoped by tenant", other.Status, other.Text())
	none := cite(c, citeBody(nil), "t1", "")
	ctx.Equal(none.Status, 400, "a citation without Idempotency-Key")
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

const std::string kV1 = "The tower is 300 metres tall and opened in 1889.";
const std::string kV2 = "The tower is 330 metres tall and opened in 1889.";

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

json citeBody(const json& over = json::object()) {
  json body = {{"answer_id", "a-1"}, {"document_id", "doc-7"}, {"version", 1}, {"start", 13}, {"end", 16}, {"quote", "300"}};
  body.update(over);
  return body;
}

harness::Response cite(harness::HTTP& c, const json& body, const std::string& tenant, const std::string& key) {
  if (tenant.empty()) return c.Post("/v1/citations", body.dump(), "Content-Type", "application/json", "Idempotency-Key", key);
  if (key.empty()) return c.Post("/v1/citations", body.dump(), "Content-Type", "application/json", "X-Tenant-Id", tenant);
  return c.Post("/v1/citations", body.dump(), "Content-Type", "application/json", "X-Tenant-Id", tenant, "Idempotency-Key", key);
}

json bodyOf(const harness::Response& r) {
  const json body = json::parse(r.Text(), nullptr, false);
  return body.is_object() ? body : json::object();
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  documents::addVersion("doc-7", kV1);
  auto c = api(ctx);
  const auto r = cite(c, citeBody(), "t1", "k-1");
  ctx.Equal(r.Status, 201, "POST /v1/citations (%s)", r.Text());
  const auto row = store::get(bodyOf(r).value("id", ""));
  ctx.Assert(row && row->document_id == "doc-7" && row->quote == "300", "the answer %s names no stored citation of doc-7 quoting 300", r.Text());
}

void CheckValidate(harness::Ctx& ctx) {
  documents::addVersion("doc-7", kV1);
  auto c = api(ctx);
  auto r = cite(c, citeBody(), "", "k-1");
  ctx.Equal(r.Status, 401, "a citation without X-Tenant-Id (a citation belongs to an authenticated tenant)");
  const std::vector<std::pair<std::string, json>> cases = {
      {"version 0", json{{"version", 0}}},
      {"start -1", json{{"start", -1}}},
      {"end equal to start", json{{"end", 13}, {"quote", "3"}}},
      {"an empty document_id", json{{"document_id", ""}}},
      {"a quote over 16 KiB", json{{"start", 0}, {"end", 16385}, {"quote", std::string(16385, 'x')}}},
  };
  for (size_t n = 0; n < cases.size(); n++) {
    r = cite(c, citeBody(cases[n].second), "t1", "k-" + std::to_string(n));
    ctx.Equal(r.Status, 400, "a request with %s", cases[n].first);
  }
  ctx.Assert(!store::get("c-1"), "a rejected request stored a citation");
}

void CheckSpanMatch(harness::Ctx& ctx) {
  documents::addVersion("doc-7", kV1);
  auto c = api(ctx);
  const auto r = cite(c, citeBody(json{{"quote", "301"}}), "t1", "k-1");
  ctx.Equal(r.Status, 422, "quoting 301 where version 1 says 300 (%s)", r.Text());
  const json b = bodyOf(r);
  ctx.Assert(b.value("stored", "") == "300" && b.value("supplied", "") == "301", "the 422 must carry both texts, stored 300 and supplied 301, got %s", r.Text());
  ctx.Assert(!store::get("c-1"), "a quote that is not the text at its offsets was stored");
}

void CheckVersionScope(harness::Ctx& ctx) {
  documents::addVersion("doc-7", kV1);
  documents::addVersion("doc-7", kV2);
  auto c = api(ctx);
  auto r = cite(c, citeBody(), "t1", "k-1");
  ctx.Equal(r.Status, 201, "citing version 1 with its own text (300) must succeed: the span resolves in the version the request names, not the newest one (%s)", r.Text());
  const auto row = store::get(bodyOf(r).value("id", ""));
  ctx.Assert(row && row->version == 1 && row->quote == "300", "the citation of version 1 was stored as version %d quoting %q: version 1 says 300, version 2 says 330",
             row ? row->version : 0L, row ? row->quote : "");
  r = cite(c, citeBody(json{{"version", 2}, {"quote", "330"}}), "t1", "k-2");
  ctx.Equal(r.Status, 201, "citing version 2 with its own text (330) (%s)", r.Text());
  r = cite(c, citeBody(json{{"quote", "330"}}), "t1", "k-3");
  ctx.Equal(r.Status, 422, "quoting version 2's text (330) as version 1 (version 1 says 300)");
}

void CheckIdempotent(harness::Ctx& ctx) {
  documents::addVersion("doc-7", kV1);
  auto c = api(ctx);
  const auto first = cite(c, citeBody(), "t1", "k-1");
  const auto retry = cite(c, citeBody(), "t1", "k-1");
  ctx.Assert(first.Status == 201 && retry.Status == 201, "the first attempt answered %d, the retry %d: %s", first.Status, retry.Status, retry.Text());
  ctx.Equal(bodyOf(retry).value("id", ""), bodyOf(first).value("id", ""), "a retry with the same Idempotency-Key must answer the citation the first attempt created; the id");
  ctx.Equal(store::forAnswer("a-1").size(), 1, "two attempts with one Idempotency-Key; the citations stored");
  const auto other = cite(c, citeBody(), "t2", "k-1");
  ctx.Assert(other.Status == 201 && bodyOf(other).value("id", "") != bodyOf(first).value("id", ""), "another tenant's request with the same key answered %d %s: keys are scoped by tenant",
             other.Status, other.Text());
  const auto none = cite(c, citeBody(), "t1", "");
  ctx.Equal(none.Status, 400, "a citation without Idempotency-Key");
}
`,
  },
  debrief: `The record is only worth storing if it can be checked later, so the shape of the fix is "compare at write time, against something that cannot change": the immutable version the request names. Answering 422 with both texts turns a silent mismatch into a message a client can act on. The Idempotency-Key lookup sits before the read and the create because a retry must not depend on whether the document moved in between. Production stores normalise text before comparing (Unicode form, whitespace), record which model run produced the citation, expire the idempotency records after a day or so, and bind the key to a hash of the body so a reused key with a different span is rejected.`,
};
