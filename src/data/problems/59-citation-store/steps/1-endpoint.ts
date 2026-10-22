import type {Step} from '@/lib/types';

export const citationEndpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/citations: spans that must resolve',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, takes
the body and stores a citation. It compiles, it serves the demo, and it hides three production
flaws. Review it like the service owner, fix it, and prove the fix with the checks below.

Implement \`POST /v1/citations\` with body
\`{"document_id": "doc-7", "version": 3, "start": 412, "end": 447, "quote": "…"}\`.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- \`document_id\` is a non-empty string, \`version\` an integer **>= 1**, \`start\` an integer
  **>= 0**, \`end > start\`, and \`quote\` a non-empty string of at most **16 KiB**; anything else is
  **400**.
- The quote must equal the bytes at \`[start, end)\` of the document's **named version**. On a
  mismatch answer **422** with both texts — \`{"stored": …, "supplied": …}\`, the text that is
  actually at those offsets and the text the caller sent — so the caller can see how the span
  drifted.
- Offsets always resolve against the immutable **version** in the request, never the document's
  latest text: a document update must not change what an already-recorded citation points at.
- \`Idempotency-Key\` is required (**400** when missing). A replay of \`(tenant, key)\` returns the
  stored record instead of recording a second one.

**Failure mode the checks target.** Storing the caller's offsets without comparing them to the
document bytes turns the store into a claim nobody verified; resolving them against the document
instead of the version means an edit silently re-points every old citation at new text; and keying
the record by document id alone makes two different versions of the same document indistinguishable.
Every one of those is silent until a reviewer clicks the citation.`,
  sequence: {
    participants: ['Client', 'Citation API', 'document store', 'citation store'],
    messages: [
      {from: 'Client', to: 'Citation API', label: 'POST /v1/citations · X-Tenant-Id · Idempotency-Key', kind: 'sync'},
      {from: 'Citation API', to: 'Citation API', label: 'validate span · tenant · key', kind: 'sync'},
      {from: 'Citation API', to: 'citation store', label: 'get(tenant, idem_key)', kind: 'sync'},
      {from: 'citation store', to: 'Citation API', label: 'stored citation / none', kind: 'reply'},
      {from: 'Citation API', to: 'document store', label: 'getVersion(document_id, version)', kind: 'sync'},
      {from: 'document store', to: 'Citation API', label: 'version text', kind: 'reply'},
      {
        from: 'Citation API',
        to: 'Citation API',
        label: 'quote != text[start:end] → 422 {stored, supplied}',
        kind: 'sync',
      },
      {from: 'Citation API', to: 'Client', label: '200 {id, version, start, end, status}', kind: 'reply'},
    ],
  },
  hints: [
    'Write the guard clauses first, in cost order: tenant, Idempotency-Key, span shape, quote size. Every one of them returns before the document store is touched, so a malformed citation never costs a fetch.',
    'The comparison is three values, not two: the document text for the **requested version**, the slice `text[start:end]`, and the caller’s quote. Slice the requested version — slicing `latest(document_id)` is exactly the bug, because the same offsets land on different text after an edit.',
    'A mismatch is not a 400: the request was well formed, the span simply does not resolve. Answer 422 with both texts (`stored` and `supplied`) — the caller needs the actual bytes to re-anchor, and the stored value is what your record will hold.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/citations',
      detail: 'Register the citation route on `POST /v1/citations`.',
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
      title: 'Rejects a malformed span and a missing tenant',
      detail:
        'A missing `X-Tenant-Id` is **401**; `version < 1`, `start < 0`, `end <= start`, an empty `document_id` or an oversized `quote` is **400**. The draft forwards whatever the caller sent.',
      match: {
        python: {
          all: [
            /status_code\s*=\s*401/,
            /status_code\s*=\s*400/,
            /body\.version\s*<\s*1/,
            /body\.end\s*<=\s*body\.start/,
          ],
        },
        typescript: {
          all: [/code\(\s*401\s*\)/, /code\(\s*400\s*\)/, /body\.version\s*<\s*1/, /body\.end\s*<=\s*body\.start/],
        },
        go: {
          all: [/StatusUnauthorized/, /StatusBadRequest/, /body\.Version\s*<\s*1/, /body\.End\s*<=\s*body\.Start/],
        },
        scala: {
          all: [
            /StatusCodes\.Unauthorized/,
            /StatusCodes\.BadRequest/,
            /body\.version\s*<\s*1/,
            /body\.end\s*<=\s*body\.start/,
          ],
        },
        cpp: {all: [/\b401\b/, /\b400\b/, /version\s*<\s*1/, /end\s*<=\s*start/]},
      },
    },
    {
      id: 'span-match',
      title: 'The quote must equal the bytes at those offsets',
      detail:
        'The quote is compared against the slice of the version text and a mismatch answers **422** with the stored text and the supplied quote. The draft stores the quote without ever reading the document bytes.',
      match: {
        python: {all: [/status_code\s*=\s*422/, /actual\s*!=\s*body\.quote/, /"stored"/, /"supplied"/]},
        typescript: {all: [/code\(\s*422\s*\)/, /actual\s*!==?\s*body\.quote/, /stored:/, /supplied:/]},
        go: {all: [/StatusUnprocessableEntity/, /actual\s*!=\s*body\.Quote/, /"stored"/, /"supplied"/]},
        scala: {all: [/StatusCodes\.UnprocessableEntity/, /actual\s*!=\s*body\.quote/, /"stored"/, /"supplied"/]},
        cpp: {all: [/\b422\b/, /actual\s*!=\s*quote/, /"stored"/, /"supplied"/]},
      },
    },
    {
      id: 'version-scope',
      title: 'Resolves against the named immutable version',
      detail:
        'The span resolves against `(document_id, version)` — the version the caller named — and the stored record keeps that version, so a later edit cannot re-point it. The draft resolves the document’s latest text and keeps no version.',
      match: {
        python: {all: [/resolve_span\(/, /documents\.get_version\(/, /"version":\s*body\.version/]},
        typescript: {all: [/resolveSpan\(/, /documents\.getVersion\(/, /version:\s*body\.version/]},
        go: {all: [/resolveSpan\(/, /documents\.GetVersion\(/, /"version":\s*body\.Version/]},
        scala: {all: [/resolveSpan\(/, /documents\.getVersion\(/, /Citation\([^)]*body\.version/]},
        cpp: {all: [/resolveSpan\(/, /documents\.getVersion\(/, /\{"version",\s*version\}/]},
      },
    },
    {
      id: 'idempotent',
      title: 'Keys a replayed record by (tenant, Idempotency-Key)',
      detail:
        '`Idempotency-Key` is required and the record is stored under `(tenant, key)`; a replay returns the stored citation instead of recording a second one. The draft ignores the header and keys by document id alone.',
      match: {
        python: {all: [/Idempotency-Key/, /store\.get\(/, /store\.put\(/], order: [/store\.get\(/, /store\.put\(/]},
        typescript: {all: [/idempotency-key/, /store\.get\(/, /store\.put\(/], order: [/store\.get\(/, /store\.put\(/]},
        go: {all: [/Idempotency-Key/, /store\.Get\(/, /store\.Put\(/], order: [/store\.Get\(/, /store\.Put\(/]},
        scala: {all: [/Idempotency-Key/, /store\.get\(/, /store\.put\(/], order: [/store\.get\(/, /store\.put\(/]},
        cpp: {all: [/Idempotency-Key/, /store\.get\(/, /store\.put\(/], order: [/store\.get\(/, /store\.put\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()


class CitationRequest(BaseModel):
    document_id: str
    version: int
    start: int
    end: int
    quote: str


class CitationStore:
    def put(self, tenant: str, citation: dict) -> None:
        """Store the citation for the tenant."""
        raise NotImplementedError


store = CitationStore()


@app.post("/v1/citations")
def record(
    body: CitationRequest, tenant: str | None = Header(default=None, alias="X-Tenant-Id")
) -> JSONResponse:
    # TODO: the draft stores whatever offsets the caller sends, accepts the quote without checking
    # it, and keys by document id alone, so citations to old versions silently point at the newest
    # text. Validate the span, resolve it against (document_id, version), and key the record by
    # (tenant, Idempotency-Key).
    text = documents.latest(body.document_id)
    citation = {
        "document_id": body.document_id,
        "start": body.start,
        "end": body.end,
        "quote": text[body.start : body.end],
        "status": "verified",
    }
    store.put(tenant, citation)
    return JSONResponse(citation, status_code=200)
`,
      solution: `from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()

MAX_QUOTE_BYTES = 1 << 14


class CitationRequest(BaseModel):
    document_id: str
    version: int
    start: int
    end: int
    quote: str


class CitationStore:
    def get(self, tenant: str, idem_key: str) -> dict | None:
        """The citation stored under (tenant, idem_key), if any."""
        raise NotImplementedError

    def put(self, tenant: str, idem_key: str, citation: dict) -> None:
        """Store the citation under (tenant, idem_key)."""
        raise NotImplementedError


store = CitationStore()


def resolve_span(document_id: str, version: int, start: int, end: int) -> str | None:
    """The bytes at [start, end) of that immutable version, or None when the version is unknown."""
    text = documents.get_version(document_id, version)
    if text is None:
        return None
    return text[start:end]


@app.post("/v1/citations")
def record(
    body: CitationRequest,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    idem_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if idem_key is None or idem_key == "":
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    if body.document_id == "" or body.version < 1:
        raise HTTPException(status_code=400, detail="document_id and version are required")
    if body.start < 0 or body.end <= body.start:
        raise HTTPException(status_code=400, detail="offsets must satisfy 0 <= start < end")
    if body.quote == "" or len(body.quote.encode("utf-8")) > MAX_QUOTE_BYTES:
        raise HTTPException(status_code=400, detail="quote must be 1 byte .. 16 KiB")

    stored = store.get(tenant, idem_key)
    if stored is not None:
        return JSONResponse(stored, status_code=200)

    actual = resolve_span(body.document_id, body.version, body.start, body.end)
    if actual is None:
        raise HTTPException(status_code=404, detail="unknown document version")
    if actual != body.quote:
        return JSONResponse(
            {"error": "span does not match", "stored": actual, "supplied": body.quote},
            status_code=422,
        )

    citation = {
        "id": idem_key,
        "document_id": body.document_id,
        "version": body.version,
        "start": body.start,
        "end": body.end,
        "quote": body.quote,
        "status": "verified",
    }
    store.put(tenant, idem_key, citation)
    return JSONResponse(citation, status_code=200)
`,
    },
    typescript: {
      starter: `/** POST /v1/citations: a model-generated draft that trusts the caller's offsets. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import {documents, store} from './store';

export const app = Fastify();

interface CitationBody {
  document_id: string;
  version: number;
  start: number;
  end: number;
  quote: string;
}

app.post('/v1/citations', async (request, reply) => {
  // TODO: the draft stores whatever offsets the caller sends, accepts the quote without checking
  // it, and keys by document id alone, so citations to old versions silently point at the newest
  // text. Validate the span, resolve it against (document_id, version), and key the record by
  // (tenant, Idempotency-Key).
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as CitationBody;
  const text = documents.getLatest(body.document_id);
  const citation = {
    id: randomUUID(),
    document_id: body.document_id,
    start: body.start,
    end: body.end,
    quote: text.slice(body.start, body.end),
    status: 'verified',
  };
  await store.put(tenant, citation);
  return reply.code(200).send(citation);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/citations: record a span that must resolve against an immutable version. */
import Fastify from 'fastify';

import {documents, store} from './store';

export const app = Fastify();

const MAX_QUOTE_BYTES = 1 << 14;

interface CitationBody {
  document_id: string;
  version: number;
  start: number;
  end: number;
  quote: string;
}

interface Citation {
  id: string;
  document_id: string;
  version: number;
  start: number;
  end: number;
  quote: string;
  status: string;
}

function resolveSpan(documentId: string, version: number, start: number, end: number): string | null {
  const text = documents.getVersion(documentId, version);
  if (text === null) return null;
  return text.slice(start, end);
}

app.post('/v1/citations', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '')
    return reply.code(400).send({error: 'Idempotency-Key is required'});

  const body = request.body as Partial<CitationBody> | null;
  if (body === null || typeof body !== 'object' || typeof body.document_id !== 'string' || body.document_id === '')
    return reply.code(400).send({error: 'document_id is required'});
  if (!Number.isInteger(body.version) || body.version < 1)
    return reply.code(400).send({error: 'version must be an integer >= 1'});
  if (!Number.isInteger(body.start) || !Number.isInteger(body.end) || body.start < 0 || body.end <= body.start)
    return reply.code(400).send({error: 'offsets must satisfy 0 <= start < end'});
  const quote = body.quote;
  if (typeof quote !== 'string' || quote === '' || Buffer.byteLength(quote, 'utf8') > MAX_QUOTE_BYTES)
    return reply.code(400).send({error: 'quote must be 1 byte .. 16 KiB'});

  const stored: Citation | null = await store.get(tenant, idemKey);
  if (stored !== null) return reply.code(200).send(stored);

  const actual = resolveSpan(body.document_id, body.version, body.start, body.end);
  if (actual === null) return reply.code(404).send({error: 'unknown document version'});
  if (actual !== body.quote)
    return reply.code(422).send({error: 'span does not match', stored: actual, supplied: body.quote});

  const citation: Citation = {
    id: idemKey,
    document_id: body.document_id,
    version: body.version,
    start: body.start,
    end: body.end,
    quote: body.quote,
    status: 'verified',
  };
  await store.put(tenant, idemKey, citation);
  return reply.code(200).send(citation);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"net/http"
)

type CitationRequest struct {
	DocumentID string \`json:"document_id"\`
	Version    int    \`json:"version"\`
	Start      int    \`json:"start"\`
	End        int    \`json:"end"\`
	Quote      string \`json:"quote"\`
}

type CitationStore struct{}

func (s *CitationStore) Put(ctx context.Context, tenant string, citation map[string]any) error {
	return nil
}

var store = &CitationStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func record(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	var body CitationRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: the draft stores whatever offsets the caller sends, accepts the quote without checking
	// it, and keys by document id alone, so citations to old versions silently point at the newest
	// text. Validate the span, resolve it against (document_id, version), and key the record by
	// (tenant, Idempotency-Key).
	text, _ := documents.Latest(body.DocumentID)
	citation := map[string]any{
		"document_id": body.DocumentID,
		"start":       body.Start,
		"end":         body.End,
		"quote":       text[body.Start:body.End],
		"status":      "verified",
	}
	_ = store.Put(r.Context(), tenant, citation)
	writeJSON(rw, http.StatusOK, citation)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/citations", record)
	_ = http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"net/http"
)

const maxQuoteBytes = 1 << 14

type CitationRequest struct {
	DocumentID string \`json:"document_id"\`
	Version    int    \`json:"version"\`
	Start      int    \`json:"start"\`
	End        int    \`json:"end"\`
	Quote      string \`json:"quote"\`
}

type CitationStore struct{}

func (s *CitationStore) Get(ctx context.Context, tenant, idemKey string) (map[string]any, error) {
	return nil, nil
}

func (s *CitationStore) Put(ctx context.Context, tenant, idemKey string, citation map[string]any) error {
	return nil
}

var store = &CitationStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func resolveSpan(documentID string, version, start, end int) (string, bool) {
	text, ok := documents.GetVersion(documentID, version)
	if !ok {
		return "", false
	}
	if start < 0 || end > len(text) || end <= start {
		return "", false
	}
	return text[start:end], true
}

func record(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	idemKey := r.Header.Get("Idempotency-Key")
	if idemKey == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "Idempotency-Key is required"})
		return
	}
	var body CitationRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if body.DocumentID == "" || body.Version < 1 {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "document_id and version are required"})
		return
	}
	if body.Start < 0 || body.End <= body.Start {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "offsets must satisfy 0 <= start < end"})
		return
	}
	if body.Quote == "" || len(body.Quote) > maxQuoteBytes {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "quote must be 1 byte .. 16 KiB"})
		return
	}

	stored, err := store.Get(r.Context(), tenant, idemKey)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if stored != nil {
		writeJSON(rw, http.StatusOK, stored)
		return
	}

	actual, ok := resolveSpan(body.DocumentID, body.Version, body.Start, body.End)
	if !ok {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown document version"})
		return
	}
	if actual != body.Quote {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]any{
			"error":    "span does not match",
			"stored":   actual,
			"supplied": body.Quote,
		})
		return
	}

	citation := map[string]any{
		"id":          idemKey,
		"document_id": body.DocumentID,
		"version":     body.Version,
		"start":       body.Start,
		"end":         body.End,
		"quote":       body.Quote,
		"status":      "verified",
	}
	if err := store.Put(r.Context(), tenant, idemKey, citation); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	writeJSON(rw, http.StatusOK, citation)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/citations", record)
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
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class CitationRequest(document_id: String, version: Int, start: Int, end: Int, quote: String)
final case class Citation(
    id: String,
    document_id: String,
    version: Int,
    start: Int,
    end: Int,
    quote: String,
    status: String
)

object CitationApi {
  implicit val system: ActorSystem = ActorSystem("citation-store")
  implicit val requestFormat: RootJsonFormat[CitationRequest] = jsonFormat5(CitationRequest)
  implicit val citationFormat: RootJsonFormat[Citation] = jsonFormat7(Citation)

  val store = CitationStore.open()

  val route: Route =
    path("v1" / "citations") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[CitationRequest]) { body =>
            // TODO: the draft stores whatever offsets the caller sends, accepts the quote without
            // checking it, and keys by document id alone, so citations to old versions silently
            // point at the newest text. Validate the span, resolve it against (document_id,
            // version), and key the record by (tenant, Idempotency-Key).
            val text = documents.latest(body.document_id)
            val citation = Citation(
              java.util.UUID.randomUUID().toString,
              body.document_id,
              body.version,
              body.start,
              body.end,
              text.substring(body.start, body.end),
              "verified"
            )
            store.put(tenant, citation)
            complete(StatusCodes.OK, citation)
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.nio.charset.StandardCharsets

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class CitationRequest(document_id: String, version: Int, start: Int, end: Int, quote: String)
final case class Citation(
    id: String,
    document_id: String,
    version: Int,
    start: Int,
    end: Int,
    quote: String,
    status: String
)

object CitationApi {
  implicit val system: ActorSystem = ActorSystem("citation-store")
  implicit val requestFormat: RootJsonFormat[CitationRequest] = jsonFormat5(CitationRequest)
  implicit val citationFormat: RootJsonFormat[Citation] = jsonFormat7(Citation)

  val MaxQuoteBytes = 1 << 14
  val store = CitationStore.open()

  def resolveSpan(documentId: String, version: Int, start: Int, end: Int): Option[String] =
    documents.getVersion(documentId, version).map(_.substring(start, end))

  val route: Route =
    path("v1" / "citations") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          optionalHeaderValueByName("Idempotency-Key") { idemOpt =>
            entity(as[CitationRequest]) { body =>
              if (!tenantOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
              } else if (!idemOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.BadRequest, """{"error":"Idempotency-Key is required"}""")
              } else if (body.document_id.isEmpty || body.version < 1) {
                complete(StatusCodes.BadRequest, """{"error":"document_id and version are required"}""")
              } else if (body.start < 0 || body.end <= body.start) {
                complete(StatusCodes.BadRequest, """{"error":"offsets must satisfy 0 <= start < end"}""")
              } else if (body.quote.isEmpty || body.quote.getBytes(StandardCharsets.UTF_8).length > MaxQuoteBytes) {
                complete(StatusCodes.BadRequest, """{"error":"quote must be 1 byte .. 16 KiB"}""")
              } else {
                val tenant = tenantOpt.get
                val idemKey = idemOpt.get
                store.get(tenant, idemKey) match {
                  case Some(stored) =>
                    complete(StatusCodes.OK, stored)
                  case None =>
                    resolveSpan(body.document_id, body.version, body.start, body.end) match {
                      case None =>
                        complete(StatusCodes.NotFound, """{"error":"unknown document version"}""")
                      case Some(actual) if actual != body.quote =>
                        complete(
                          StatusCodes.UnprocessableEntity,
                          s"""{"error":"span does not match","stored":"$actual","supplied":"\${body.quote}"}"""
                        )
                      case Some(_) =>
                        val citation = Citation(
                          idemKey,
                          body.document_id,
                          body.version,
                          body.start,
                          body.end,
                          body.quote,
                          "verified"
                        )
                        store.put(tenant, idemKey, citation)
                        complete(StatusCodes.OK, citation)
                    }
                }
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

#include <iostream>
#include <optional>
#include <string>

using json = nlohmann::json;

struct CitationStore {
  void put(const std::string& tenant, const json& citation);
};

CitationStore store;

int main() {
  httplib::Server svr;

  svr.Post("/v1/citations", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    // TODO: the draft stores whatever offsets the caller sends, accepts the quote without checking
    // it, and keys by document id alone, so citations to old versions silently point at the newest
    // text. Validate the span, resolve it against (document_id, version), and key the record by
    // (tenant, Idempotency-Key).
    const auto documentId = body.value("document_id", std::string());
    const auto start = body.value("start", 0);
    const auto end = body.value("end", 0);
    const auto text = documents.latest(documentId);
    const json citation = {
        {"document_id", documentId},
        {"start", start},
        {"end", end},
        {"quote", text.substr(static_cast<std::size_t>(start), static_cast<std::size_t>(end - start))},
        {"status", "verified"},
    };
    store.put(tenant, citation);
    res.status = 200;
    res.set_content(citation.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <optional>
#include <string>

using json = nlohmann::json;

constexpr std::size_t kMaxQuoteBytes = 1 << 14;

struct DocumentStore {
  std::optional<std::string> getVersion(const std::string& documentId, int version) const;
};

DocumentStore documents;

struct CitationStore {
  std::optional<json> get(const std::string& tenant, const std::string& idemKey);
  void put(const std::string& tenant, const std::string& idemKey, const json& citation);
};

CitationStore store;

std::optional<std::string> resolveSpan(const std::string& documentId, int version, long long start, long long end) {
  const auto text = documents.getVersion(documentId, version);
  if (!text.has_value()) return std::nullopt;
  if (start < 0 || end > static_cast<long long>(text->size()) || end <= start) return std::nullopt;
  return text->substr(static_cast<std::size_t>(start), static_cast<std::size_t>(end - start));
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/citations", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto idemKey = req.get_header_value("Idempotency-Key");
    if (idemKey.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"Idempotency-Key is required"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    const auto documentId = body.value("document_id", std::string());
    const int version = body.value("version", 0);
    const long long start = body.value("start", 0);
    const long long end = body.value("end", 0);
    const auto quote = body.value("quote", std::string());
    if (documentId.empty() || version < 1) {
      res.status = 400;
      res.set_content(R"({"error":"document_id and version are required"})", "application/json");
      return;
    }
    if (start < 0 || end <= start) {
      res.status = 400;
      res.set_content(R"({"error":"offsets must satisfy 0 <= start < end"})", "application/json");
      return;
    }
    if (quote.empty() || quote.size() > kMaxQuoteBytes) {
      res.status = 400;
      res.set_content(R"({"error":"quote must be 1 byte .. 16 KiB"})", "application/json");
      return;
    }

    const auto stored = store.get(tenant, idemKey);
    if (stored) {
      res.status = 200;
      res.set_content(stored->dump(), "application/json");
      return;
    }

    const auto actual = resolveSpan(documentId, version, start, end);
    if (!actual.has_value()) {
      res.status = 404;
      res.set_content(R"({"error":"unknown document version"})", "application/json");
      return;
    }
    if (actual != quote) {
      res.status = 422;
      res.set_content(
          json{{"error", "span does not match"}, {"stored", *actual}, {"supplied", quote}}.dump(),
          "application/json");
      return;
    }

    const json citation = {
        {"id", idemKey},
        {"document_id", documentId},
        {"version", version},
        {"start", start},
        {"end", end},
        {"quote", quote},
        {"status", "verified"},
    };
    store.put(tenant, idemKey, citation);
    res.status = 200;
    res.set_content(citation.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The interviewer is testing whether you can review a generated handler whose bug is in the data model, not the syntax. The draft reads fine because the demo cites a document that was never edited. Three defects are being checked. First, an unverified span: offsets and a quote only mean something together, so the handler must slice the version text and compare — a 422 with both texts is what lets a caller re-anchor. Second, the resolution key: \`(document_id, version)\` is the identity of the text an offset points into; resolving the document's latest version and storing no version at all means every later edit rewrites history. Third, idempotency: the record is keyed by \`(tenant, Idempotency-Key)\` so a client retry returns the same citation instead of a second one with a fresh id. Real stores add byte-offset normalization for encodings, a quote fingerprint for cheap re-anchoring, and a compaction job that re-verifies citations when a document's text is rewritten.`,
};
