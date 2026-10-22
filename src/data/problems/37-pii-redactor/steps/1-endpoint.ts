import type {Step} from '@/lib/types';

export const redactEndpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/redact: fail closed, never echo raw text',
  concept: 'http',
  file: 'api',
  focus: ['client', 'redactor', 'detector'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, reads
the body, calls the detector and returns something. It compiles, the demo hides nothing because the
demo text always matches, and it fails open in the three ways that turn a redactor into a leak.
Review it like the service owner, fix it, and prove the fix with the checks below.

Implement \`POST /v1/redact\` with body \`{"text": "…", "entities": ["EMAIL", "PHONE"], "document_id": "…"}\`.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- \`text\` is a non-empty string of at most **256 KiB** (\`1 << 18\` bytes) of UTF-8; a larger text
  is **413** and the error body must **never** quote the payload.
- \`entities\` is a subset of the eight declared types (at most eight); an unknown or oversized
  list is **400**. The default set is \`EMAIL\`, \`PHONE\`, \`SSN\`.
- \`document_id\` is required (**400** when absent) — the audit trail is keyed by it later.
- Detection returns spans; the response is the redacted text plus the spans, the per-type counts
  and the pattern version: \`{"document_id", "status", "redacted_text", "spans", "entity_counts",
  "pattern_version"}\`.
- Clean text with no match is still **processed**: the response status is \`"processed"\` with an
  empty span list. Never treat "nothing matched" as "return the input unchanged and call it done".
- A detector failure is **503** with \`{"error": "detector_unavailable"}\` and **no text** in the
  body. The draft catches the detector error and returns the original text with a warning, so an
  outage becomes an exfiltration path.

**Failure mode the checks target.** The whole point of a redactor is what it does when it cannot
answer. The draft's three flaws are one flaw in three places: it prefers a convenient answer to a
safe one. Returning the input on no-match means a regex miss silently disables redaction; returning
the input on detector error means a provider outage leaks every document in flight; quoting a
truncated payload in the 413 body puts sensitive text into error logs and client-side crash reports.`,
  sequence: {
    participants: ['Client', 'Redactor', 'Detector'],
    messages: [
      {from: 'Client', to: 'Redactor', label: 'POST /v1/redact · X-Tenant-Id · {text, entities}', kind: 'sync'},
      {from: 'Redactor', to: 'Redactor', label: '401 tenant · 413 size · 400 entities · 400 document_id', kind: 'sync'},
      {from: 'Redactor', to: 'Detector', label: 'Detect(text, entities)', kind: 'sync'},
      {from: 'Detector', to: 'Redactor', label: 'spans[]', kind: 'reply'},
      {from: 'Detector', to: 'Redactor', label: 'UNAVAILABLE', kind: 'reply'},
      {from: 'Redactor', to: 'Redactor', label: '503 {error: detector_unavailable} — never the input', kind: 'sync'},
      {from: 'Redactor', to: 'Client', label: '200 {status, redacted_text, spans, entity_counts}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/redact',
      detail: 'Register the redaction route on `POST /v1/redact`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/redact["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/redact['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/redact"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"redact"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/redact"/]},
      },
    },
    {
      id: 'size-cap',
      title: 'Caps the text at 256 KiB and whitelists the entity types',
      detail:
        'A text over `1 << 18` bytes is **413**; an unknown or oversized `entities` list is **400**. The draft carries inline literals instead of named caps and never checks the entity whitelist, so a caller can ask for a pass that detects nothing.',
      match: {
        python: {all: [/MAX_TEXT_BYTES/, /MAX_ENTITY_TYPES/, /status_code\s*=\s*413/, /status_code\s*=\s*400/]},
        typescript: {all: [/MAX_TEXT_BYTES/, /MAX_ENTITY_TYPES/, /code\(\s*413\s*\)/, /code\(\s*400\s*\)/]},
        go: {all: [/maxTextBytes/, /maxEntityTypes/, /StatusRequestEntityTooLarge/, /StatusBadRequest/]},
        scala: {
          all: [/MaxTextBytes/, /MaxEntityTypes/, /StatusCodes\.RequestEntityTooLarge/, /StatusCodes\.BadRequest/],
        },
        cpp: {all: [/kMaxTextBytes/, /kMaxEntityTypes/, /\b413\b/, /\b400\b/]},
      },
    },
    {
      id: 'fail-closed',
      title: 'A detector failure is 503 with no text',
      detail:
        'A detector error becomes **503 `{"error": "detector_unavailable"}`** — never the original text, never a degraded 200. The draft catches the error, logs a warning and returns the input with `degraded: true`, so an outage leaks every document.',
      match: {
        python: {all: [/status_code\s*=\s*503/, /detector_unavailable/, /except DetectorUnavailable/]},
        typescript: {all: [/code\(\s*503\s*\)/, /detector_unavailable/, /DetectorUnavailable/]},
        go: {all: [/StatusServiceUnavailable/, /detector_unavailable/, /ErrDetectorUnavailable/]},
        scala: {all: [/StatusCodes\.ServiceUnavailable/, /detector_unavailable/, /Failure/]},
        cpp: {all: [/\b503\b/, /detector_unavailable/, /DetectorUnavailable/]},
      },
    },
    {
      id: 'processed',
      title: 'Clean text is still marked processed, with spans and counts',
      detail:
        'Every 200 carries `"status": "processed"`, the span list, the per-type counts and the pattern version, whether or not anything matched. The draft short-circuits on no-match and returns the raw text, so a miss is indistinguishable from a disabled redactor.',
      match: {
        python: {all: [/STATUS_PROCESSED/, /"status":\s*STATUS_PROCESSED/, /"spans":/, /entity_counts/]},
        typescript: {all: [/STATUS_PROCESSED/, /status:\s*STATUS_PROCESSED/, /spans:/, /entity_counts/]},
        go: {all: [/statusProcessed/, /"status":\s*statusProcessed/, /"spans"/, /entityCounts|"entity_counts"/]},
        scala: {all: [/StatusProcessed/, /status\s*=\s*StatusProcessed/, /spans\s*=/, /entity_counts|EntityCounts/]},
        cpp: {all: [/kStatusProcessed/, /"status",\s*kStatusProcessed/, /"spans"/, /entity_counts/]},
      },
    },
    {
      id: 'spans-only',
      title: 'Returns spans and counts, never a raw text field',
      detail:
        'The response exposes spans of `(start, end, entity, replacement)` and the counts, but no `text`/`original_text` field anywhere — including errors. The draft returns the caller’s own text back under a `text` key on the happy path and in the 413 body.',
      match: {
        python: {all: [/class Span/, /pattern_version/], none: [/["']text["']\s*:/]},
        typescript: {all: [/type Span/, /pattern_version/], none: [/["']text["']\s*:/]},
        go: {all: [/type Span struct/, /pattern_version/], none: [/["']text["']\s*:/]},
        scala: {all: [/case class Span/, /pattern_version/], none: [/["']text["']\s*:/]},
        cpp: {all: [/struct Span/, /pattern_version/], none: [/["']text["']\s*:/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("redactor")


class RedactRequest(BaseModel):
    text: str
    entities: list[str] = []
    document_id: str


class DetectorUnavailable(Exception):
    pass


class Detector:
    def detect(self, text: str, entities: list[str]) -> list[dict]:
        """Return the spans of sensitive entities in text."""
        raise NotImplementedError


detector = Detector()


def apply_spans(text: str, spans: list[dict]) -> str:
    out = []
    cursor = 0
    for span in sorted(spans, key=lambda s: s["start"]):
        out.append(text[cursor : span["start"]])
        out.append(span["replacement"])
        cursor = span["end"]
    out.append(text[cursor:])
    return "".join(out)


@app.post("/v1/redact")
def redact(body: RedactRequest, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this draft returns the original text when no entity matches, swallows detector errors
    # and returns the input unchanged, and echoes oversized inputs in the error body.
    if len(body.text.encode("utf-8")) > 1 << 18:
        return JSONResponse({"error": f"text too large: {body.text[:64]}"}, status_code=413)
    try:
        spans = detector.detect(body.text, body.entities)
    except Exception:
        logger.warning("detector failed for document=%s", body.document_id)
        return JSONResponse({"text": body.text, "degraded": True}, status_code=200)
    if not spans:
        return JSONResponse({"text": body.text}, status_code=200)
    return JSONResponse({"text": apply_spans(body.text, spans)}, status_code=200)
`,
      solution: `import logging

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("redactor")

MAX_TEXT_BYTES = 1 << 18
MAX_ENTITY_TYPES = 8
ALLOWED_ENTITIES = {"EMAIL", "PHONE", "SSN", "CREDIT_CARD", "IBAN", "IPV4", "NAME", "ADDRESS"}
DEFAULT_ENTITIES = ["EMAIL", "PHONE", "SSN"]
STATUS_PROCESSED = "processed"
PATTERN_VERSION = 7


class RedactRequest(BaseModel):
    text: str
    entities: list[str] = []
    document_id: str


class Span(BaseModel):
    start: int
    end: int
    entity: str
    replacement: str


class DetectorUnavailable(Exception):
    """The detector could not answer; redaction must fail closed."""


class Detector:
    def detect(self, text: str, entities: list[str]) -> list[Span]:
        """Return the spans of sensitive entities in text."""
        raise NotImplementedError


detector = Detector()


def apply_spans(text: str, spans: list[Span]) -> str:
    out = []
    cursor = 0
    for span in sorted(spans, key=lambda s: s.start):
        out.append(text[cursor : span.start])
        out.append(span.replacement)
        cursor = span.end
    out.append(text[cursor:])
    return "".join(out)


@app.post("/v1/redact")
def redact(
    body: RedactRequest,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail={"error": "missing X-Tenant-Id"})
    if body.document_id == "":
        raise HTTPException(status_code=400, detail={"error": "document_id is required"})
    if body.text == "":
        raise HTTPException(status_code=400, detail={"error": "text must be a non-empty string"})
    raw = body.text
    if len(raw.encode("utf-8")) > MAX_TEXT_BYTES:
        # The cap is rejected without quoting any of the payload.
        raise HTTPException(status_code=413, detail={"error": "text exceeds 256 KiB"})
    entities = body.entities or DEFAULT_ENTITIES
    if len(entities) > MAX_ENTITY_TYPES or any(e not in ALLOWED_ENTITIES for e in entities):
        raise HTTPException(status_code=400, detail={"error": "unknown entity type"})

    try:
        spans = detector.detect(raw, entities)
    except DetectorUnavailable:
        # Fail closed: the caller gets an error, not their own unredacted text.
        raise HTTPException(status_code=503, detail={"error": "detector_unavailable"})

    counts: dict[str, int] = {}
    for span in spans:
        counts[span.entity] = counts.get(span.entity, 0) + 1
    payload = {
        "document_id": body.document_id,
        "status": STATUS_PROCESSED,
        "redacted_text": apply_spans(raw, spans),
        "spans": [span.model_dump() for span in spans],
        "entity_counts": counts,
        "pattern_version": PATTERN_VERSION,
    }
    logger.info(
        "redact tenant=%s document=%s spans=%d status=%s",
        tenant,
        body.document_id,
        len(spans),
        STATUS_PROCESSED,
    )
    return JSONResponse(payload, status_code=200)
`,
    },
    typescript: {
      starter: `/** POST /v1/redact: a model-generated draft that fails open. */
import Fastify from 'fastify';

export const app = Fastify();

interface RedactBody {
  text: string;
  entities?: string[];
  document_id: string;
}

app.post('/v1/redact', async (request, reply) => {
  // TODO: this draft returns the original text when no entity matches, swallows detector errors
  // and returns the input unchanged, and echoes oversized inputs in the error body.
  const body = request.body as RedactBody;
  if (Buffer.byteLength(body.text, 'utf8') > 1 << 18)
    return reply.code(413).send({error: \`text too large: \${body.text.slice(0, 64)}\`});
  let spans: Array<{start: number; end: number; entity: string; replacement: string}>;
  try {
    spans = await detector.detect(body.text, body.entities ?? []);
  } catch {
    request.log.warn('detector failed');
    return reply.code(200).send({text: body.text, degraded: true});
  }
  if (spans.length === 0) return reply.code(200).send({text: body.text});
  return reply.code(200).send({text: applySpans(body.text, spans)});
});

declare const detector: {detect(text: string, entities: string[]): Promise<Array<{start: number; end: number; entity: string; replacement: string}>>};

function applySpans(text: string, spans: Array<{start: number; end: number; replacement: string}>): string {
  let out = '';
  let cursor = 0;
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    out += text.slice(cursor, span.start) + span.replacement;
    cursor = span.end;
  }
  return out + text.slice(cursor);
}

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/redact: redaction that fails closed and never echoes the payload. */
import Fastify from 'fastify';

import {DetectorUnavailable, applySpans, detector, type Span} from './detector';

export const app = Fastify();

const MAX_TEXT_BYTES = 1 << 18;
const MAX_ENTITY_TYPES = 8;
const DEFAULT_ENTITIES = ['EMAIL', 'PHONE', 'SSN'];
const ALLOWED_ENTITIES: Record<string, true> = {
  EMAIL: true,
  PHONE: true,
  SSN: true,
  CREDIT_CARD: true,
  IBAN: true,
  IPV4: true,
  NAME: true,
  ADDRESS: true,
};
const STATUS_PROCESSED = 'processed';
const PATTERN_VERSION = 7;

interface RedactBody {
  text: string;
  entities?: string[];
  document_id: string;
}

app.post('/v1/redact', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});

  const body = request.body as Partial<RedactBody> | null;
  if (body === null || typeof body !== 'object' || typeof body.text !== 'string' || body.text === '')
    return reply.code(400).send({error: 'text must be a non-empty string'});
  if (typeof body.document_id !== 'string' || body.document_id === '')
    return reply.code(400).send({error: 'document_id is required'});

  const raw = body.text;
  if (Buffer.byteLength(raw, 'utf8') > MAX_TEXT_BYTES)
    // The cap is rejected without quoting any of the payload.
    return reply.code(413).send({error: 'text exceeds 256 KiB'});

  const entities = body.entities ?? DEFAULT_ENTITIES;
  if (!Array.isArray(entities) || entities.length > MAX_ENTITY_TYPES || entities.some(e => ALLOWED_ENTITIES[e] !== true))
    return reply.code(400).send({error: 'unknown entity type'});

  let spans: Span[];
  try {
    spans = await detector.detect(raw, entities.length > 0 ? entities : DEFAULT_ENTITIES);
  } catch (error) {
    if (error instanceof DetectorUnavailable)
      // Fail closed: the caller gets an error, not their own unredacted text.
      return reply.code(503).send({error: 'detector_unavailable'});
    throw error;
  }

  const entity_counts: Record<string, number> = {};
  for (const span of spans) entity_counts[span.entity] = (entity_counts[span.entity] ?? 0) + 1;

  request.log.info({tenant, document_id: body.document_id, spans: spans.length, status: STATUS_PROCESSED}, 'redacted');
  return reply.code(200).send({
    document_id: body.document_id,
    status: STATUS_PROCESSED,
    redacted_text: applySpans(raw, spans),
    spans,
    entity_counts,
    pattern_version: PATTERN_VERSION,
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
)

type RedactRequest struct {
	Text       string   \`json:"text"\`
	Entities   []string \`json:"entities"\`
	DocumentID string   \`json:"document_id"\`
}

type Span struct {
	Start       int    \`json:"start"\`
	End         int    \`json:"end"\`
	Entity      string \`json:"entity"\`
	Replacement string \`json:"replacement"\`
}

type Detector interface {
	Detect(ctx context.Context, text string, entities []string) ([]Span, error)
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func redact(rw http.ResponseWriter, r *http.Request) {
	var body RedactRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft returns the original text when no entity matches, swallows detector errors
	// and returns the input unchanged, and echoes oversized inputs in the error body.
	if len([]byte(body.Text)) > 1<<18 {
		writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]string{"error": "text too large: " + body.Text[:64]})
		return
	}
	spans, err := detector.Detect(r.Context(), body.Text, body.Entities)
	if err != nil {
		log.Printf("detector failed document=%s", body.DocumentID)
		writeJSON(rw, http.StatusOK, map[string]any{"text": body.Text, "degraded": true})
		return
	}
	if len(spans) == 0 {
		writeJSON(rw, http.StatusOK, map[string]any{"text": body.Text})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{"text": applySpans(body.Text, spans)})
}

func applySpans(text string, spans []Span) string {
	out := make([]byte, 0, len(text))
	cursor := 0
	for _, span := range spans {
		out = append(out, text[cursor:span.Start]...)
		out = append(out, span.Replacement...)
		cursor = span.End
	}
	return string(out) + text[cursor:]
}

var detector Detector

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/redact", redact)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
)

const (
	maxTextBytes   = 1 << 18
	maxEntityTypes = 8
	statusProcessed = "processed"
	patternVersion  = 7
)

var allowedEntities = map[string]bool{
	"EMAIL": true, "PHONE": true, "SSN": true, "CREDIT_CARD": true,
	"IBAN": true, "IPV4": true, "NAME": true, "ADDRESS": true,
}

var defaultEntities = []string{"EMAIL", "PHONE", "SSN"}

// ErrDetectorUnavailable means the detector could not answer; redaction must fail closed.
var ErrDetectorUnavailable = errors.New("detector_unavailable")

type RedactRequest struct {
	Text       string   \`json:"text"\`
	Entities   []string \`json:"entities"\`
	DocumentID string   \`json:"document_id"\`
}

type Span struct {
	Start       int    \`json:"start"\`
	End         int    \`json:"end"\`
	Entity      string \`json:"entity"\`
	Replacement string \`json:"replacement"\`
}

type Detector interface {
	Detect(ctx context.Context, text string, entities []string) ([]Span, error)
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func applySpans(text string, spans []Span) string {
	out := make([]byte, 0, len(text))
	cursor := 0
	for _, span := range spans {
		out = append(out, text[cursor:span.Start]...)
		out = append(out, span.Replacement...)
		cursor = span.End
	}
	return string(out) + text[cursor:]
}

func validEntities(entities []string) bool {
	if len(entities) > maxEntityTypes {
		return false
	}
	for _, entity := range entities {
		if !allowedEntities[entity] {
			return false
		}
	}
	return true
}

func redact(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	var body RedactRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if body.DocumentID == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "document_id is required"})
		return
	}
	if body.Text == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "text must be a non-empty string"})
		return
	}
	if len([]byte(body.Text)) > maxTextBytes {
		// The cap is rejected without quoting any of the payload.
		writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]string{"error": "text exceeds 256 KiB"})
		return
	}
	entities := body.Entities
	if len(entities) == 0 {
		entities = defaultEntities
	}
	if !validEntities(entities) {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "unknown entity type"})
		return
	}

	spans, err := detector.Detect(r.Context(), body.Text, entities)
	if err != nil {
		// Fail closed: the caller gets an error, not their own unredacted text.
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "detector_unavailable"})
		return
	}

	entityCounts := map[string]int{}
	for _, span := range spans {
		entityCounts[span.Entity]++
	}
	log.Printf("redact tenant=%s document=%s spans=%d status=%s", tenant, body.DocumentID, len(spans), statusProcessed)
	writeJSON(rw, http.StatusOK, map[string]any{
		"document_id":     body.DocumentID,
		"status":          statusProcessed,
		"redacted_text":   applySpans(body.Text, spans),
		"spans":           spans,
		"entity_counts":   entityCounts,
		"pattern_version": patternVersion,
	})
}

var detector Detector

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/redact", redact)
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

final case class RedactRequest(text: String, entities: List[String], document_id: String)

object RedactApi {
  implicit val system: ActorSystem = ActorSystem("redactor")
  implicit val requestFormat: RootJsonFormat[RedactRequest] = jsonFormat3(RedactRequest)

  val detector = Detector.open()

  val route: Route =
    path("v1" / "redact") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[RedactRequest]) { body =>
            // TODO: this draft returns the original text when no entity matches, swallows detector
            // errors and returns the input unchanged, and echoes oversized inputs in the error body.
            if (body.text.getBytes("UTF-8").length > (1 << 18)) {
              complete(StatusCodes.RequestEntityTooLarge, s"""{"error":"text too large: \${body.text.take(64)}"}""")
            } else {
              detector.detect(body.text, body.entities) match {
                case scala.util.Success(spans) if spans.isEmpty =>
                  complete(StatusCodes.OK, s"""{"text":\${body.text}}""")
                case scala.util.Success(spans) =>
                  complete(StatusCodes.OK, s"""{"text":"\${applySpans(body.text, spans)}"}""")
                case scala.util.Failure(_) =>
                  system.log.warning(s"detector failed document=\${body.document_id}")
                  complete(StatusCodes.OK, s"""{"text":\${body.text},"degraded":true}""")
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
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class RedactRequest(text: String, entities: List[String], document_id: String)
final case class Span(start: Int, end: Int, entity: String, replacement: String)
final case class Redaction(
    document_id: String,
    status: String,
    redacted_text: String,
    spans: List[Span],
    entity_counts: Map[String, Int],
    pattern_version: Int,
)

object RedactApi {
  implicit val system: ActorSystem = ActorSystem("redactor")
  implicit val requestFormat: RootJsonFormat[RedactRequest] = jsonFormat3(RedactRequest)
  implicit val spanFormat: RootJsonFormat[Span] = jsonFormat4(Span)
  implicit val redactionFormat: RootJsonFormat[Redaction] = jsonFormat6(Redaction)

  val MaxTextBytes = 1 << 18
  val MaxEntityTypes = 8
  val DefaultEntities = List("EMAIL", "PHONE", "SSN")
  val AllowedEntities = Set("EMAIL", "PHONE", "SSN", "CREDIT_CARD", "IBAN", "IPV4", "NAME", "ADDRESS")
  val StatusProcessed = "processed"
  val PatternVersion = 7

  val detector = Detector.open()

  def applySpans(text: String, spans: List[Span]): String = {
    val out = new StringBuilder
    var cursor = 0
    for (span <- spans.sortBy(_.start)) {
      out.append(text.substring(cursor, span.start)).append(span.replacement)
      cursor = span.end
    }
    out.append(text.substring(cursor)).toString
  }

  val route: Route =
    path("v1" / "redact") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          entity(as[RedactRequest]) { body =>
            if (!tenantOpt.exists(_.nonEmpty)) {
              complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
            } else if (body.document_id.isEmpty) {
              complete(StatusCodes.BadRequest, """{"error":"document_id is required"}""")
            } else if (body.text.isEmpty) {
              complete(StatusCodes.BadRequest, """{"error":"text must be a non-empty string"}""")
            } else if (body.text.getBytes("UTF-8").length > MaxTextBytes) {
              // The cap is rejected without quoting any of the payload.
              complete(StatusCodes.RequestEntityTooLarge, """{"error":"text exceeds 256 KiB"}""")
            } else {
              val entities = if (body.entities.isEmpty) DefaultEntities else body.entities
              if (entities.length > MaxEntityTypes || !entities.forall(AllowedEntities.contains)) {
                complete(StatusCodes.BadRequest, """{"error":"unknown entity type"}""")
              } else {
                detector.detect(body.text, entities) match {
                  case scala.util.Failure(_) =>
                    // Fail closed: the caller gets an error, not their own unredacted text.
                    complete(StatusCodes.ServiceUnavailable, """{"error":"detector_unavailable"}""")
                  case scala.util.Success(spans) =>
                    val counts = spans.groupBy(_.entity).view.mapValues(_.size).toMap
                    val tenant = tenantOpt.get
                    system.log.info(
                      s"redact tenant=$tenant document=\${body.document_id} spans=\${spans.size} status=$StatusProcessed",
                    )
                    complete(
                      StatusCodes.OK,
                      Redaction(
                        document_id = body.document_id,
                        status = StatusProcessed,
                        redacted_text = applySpans(body.text, spans),
                        spans = spans,
                        entity_counts = counts,
                        pattern_version = PatternVersion,
                      ),
                    )
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
#include <string>
#include <vector>

using json = nlohmann::json;

struct Span {
  int start = 0;
  int end = 0;
  std::string entity;
  std::string replacement;
};

struct Detector {
  virtual std::optional<std::vector<Span>> detect(const std::string& text, const std::vector<std::string>& entities);
};

Detector detector;

std::string applySpans(const std::string& text, const std::vector<Span>& spans) {
  std::string out;
  std::size_t cursor = 0;
  for (const auto& span : spans) {
    out += text.substr(cursor, span.start - cursor) + span.replacement;
    cursor = span.end;
  }
  return out + text.substr(cursor);
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/redact", [](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    const auto text = body.value("text", std::string());
    const auto documentId = body.value("document_id", std::string());
    // TODO: this draft returns the original text when no entity matches, swallows detector errors
    // and returns the input unchanged, and echoes oversized inputs in the error body.
    if (text.size() > 1u << 18) {
      res.status = 413;
      res.set_content(json{{"error", "text too large: " + text.substr(0, 64)}}.dump(), "application/json");
      return;
    }
    auto spans = detector.detect(text, {});
    if (!spans) {
      std::cerr << "detector failed document=" << documentId << "\\n";
      res.status = 200;
      res.set_content(json{{"text", text}, {"degraded", true}}.dump(), "application/json");
      return;
    }
    res.status = 200;
    res.set_content(json{{"text", spans->empty() ? text : applySpans(text, *spans)}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <optional>
#include <set>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr std::size_t kMaxTextBytes = 1 << 18;
constexpr std::size_t kMaxEntityTypes = 8;
const std::string kStatusProcessed = "processed";
constexpr int kPatternVersion = 7;

const std::set<std::string> kAllowedEntities = {"EMAIL", "PHONE", "SSN", "CREDIT_CARD",
                                                "IBAN",  "IPV4",  "NAME", "ADDRESS"};
const std::vector<std::string> kDefaultEntities = {"EMAIL", "PHONE", "SSN"};

struct Span {
  int start = 0;
  int end = 0;
  std::string entity;
  std::string replacement;
};

struct DetectorUnavailable : std::exception {};

struct Detector {
  virtual std::vector<Span> detect(const std::string& text, const std::vector<std::string>& entities);
};

Detector detector;

std::string applySpans(const std::string& text, const std::vector<Span>& spans) {
  std::vector<Span> ordered = spans;
  std::sort(ordered.begin(), ordered.end(), [](const Span& a, const Span& b) { return a.start < b.start; });
  std::string out;
  std::size_t cursor = 0;
  for (const auto& span : ordered) {
    out += text.substr(cursor, static_cast<std::size_t>(span.start) - cursor) + span.replacement;
    cursor = static_cast<std::size_t>(span.end);
  }
  return out + text.substr(cursor);
}

bool validEntities(const std::vector<std::string>& entities) {
  if (entities.size() > kMaxEntityTypes) return false;
  for (const auto& entity : entities)
    if (kAllowedEntities.count(entity) == 0) return false;
  return true;
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/redact", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("text") || !body["text"].is_string()) {
      res.status = 400;
      res.set_content(R"({"error":"text must be a non-empty string"})", "application/json");
      return;
    }
    const auto text = body["text"].get<std::string>();
    const auto documentId = body.value("document_id", std::string());
    if (documentId.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"document_id is required"})", "application/json");
      return;
    }
    if (text.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"text must be a non-empty string"})", "application/json");
      return;
    }
    if (text.size() > kMaxTextBytes) {
      // The cap is rejected without quoting any of the payload.
      res.status = 413;
      res.set_content(R"({"error":"text exceeds 256 KiB"})", "application/json");
      return;
    }
    auto entities = body.value("entities", std::vector<std::string>{});
    if (entities.empty()) entities = kDefaultEntities;
    if (!validEntities(entities)) {
      res.status = 400;
      res.set_content(R"({"error":"unknown entity type"})", "application/json");
      return;
    }

    std::vector<Span> spans;
    try {
      spans = detector.detect(text, entities);
    } catch (const DetectorUnavailable&) {
      // Fail closed: the caller gets an error, not their own unredacted text.
      res.status = 503;
      res.set_content(R"({"error":"detector_unavailable"})", "application/json");
      return;
    }

    json entity_counts = json::object();
    for (const auto& span : spans) entity_counts[span.entity] = entity_counts.value(span.entity, 0) + 1;
    json out = {
        {"document_id", documentId},
        {"status", kStatusProcessed},
        {"redacted_text", applySpans(text, spans)},
        {"spans", json::array()},
        {"entity_counts", entity_counts},
        {"pattern_version", kPatternVersion},
    };
    for (const auto& span : spans)
      out["spans"].push_back(
          json{{"start", span.start}, {"end", span.end}, {"entity", span.entity}, {"replacement", span.replacement}});
    std::cerr << "redact tenant=" << tenant << " document=" << documentId << " spans=" << spans.size()
              << " status=" << kStatusProcessed << "\\n";
    res.status = 200;
    res.set_content(out.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Order the guards by cost and by blame: tenant (401), document_id (400), text shape (400), byte length (413), entity whitelist (400). Each returns before the detector is called, so an oversized or malformed request never reaches the model — and the 413 body stays a constant error string, never a slice of the payload.',
    'Fail closed means the error path is the most important path. `except DetectorUnavailable: raise HTTPException(503, {"error": "detector_unavailable"})` — no `degraded: true`, no returning `body.text`. A warning header is not a control; if the detector cannot answer, the request cannot be served.',
    'A clean document is a successful redaction, not a no-op. Always answer with `status: "processed"`, the span list (possibly empty), `entity_counts` and `pattern_version`, so a caller can tell "ran and found nothing" from "redaction was skipped".',
  ],
  debrief: `The interviewer is testing whether you can review a generated handler for its failure behavior, not its happy path. The draft reads fine because the demo always matches and the detector never fails. The three defects are one defect: it prefers an answer to a safe answer. Returning the input on no-match silently disables redaction; returning the input on detector error turns a model outage into an exfiltration path; quoting a slice of the payload in the 413 body ships sensitive text into logs, crash reports and retry queues. A real redactor adds the model's own health signal to the response (\`pattern_version\`, counts), makes "processed" a first-class status so a down detector is visible in dashboards, and keeps the raw text only in the caller's request buffer — never in a response, a log line or a metric label.`,
};
