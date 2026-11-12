import type {Step} from '@/lib/types';

export const redactEndpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/redact: fail closed, echo nothing',
  concept: 'http',
  guides: ['request-boundaries', 'failing-dependencies'],
  file: 'api',
  focus: ['client', 'redactor', 'detector'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/redact\` with body \`{document_id, text, entities}\`
and the tenant in \`X-Tenant-Id\`: it calls \`ner.detect\` (provided), writes the redaction with
\`store.save\` and answers the redacted text with its spans. It serves the demo and hides four
flaws.

**Failure mode the checks target.** A detector outage answers 200 with the customer's text; an
oversized text is quoted back in the 413 body; an entity type nobody declared reaches the detector
and redacts nothing; and a text with nothing to redact is never recorded, so the audit read cannot
tell it from a text that was skipped.

- A text over \`MAX_TEXT_BYTES\` (256 KiB) is **413** with a constant body.
- Every requested entity is in \`ENTITY_TYPES\` (the default is \`DEFAULT_ENTITIES\`); anything else
  is **400**, before the detector is called.
- \`DetectorUnavailable\` is **503** \`{"error": "detector_unavailable"}\`, and nothing is saved.
- Every 200 is saved first and answers \`{document_id, status: "processed", redacted_text, spans,
  entity_counts, detector_version, source, degraded}\`, an empty span list included.`,
  sequence: {
    participants: ['Client', 'Redactor', 'Detector', 'Redis'],
    messages: [
      {
        from: 'Client',
        to: 'Redactor',
        label: 'POST /v1/redact · X-Tenant-Id · {document_id, text, entities}',
        kind: 'sync',
      },
      {from: 'Redactor', to: 'Redactor', label: '401 tenant · 400 body · 413 size · 400 entity type', kind: 'sync'},
      {from: 'Redactor', to: 'Detector', label: 'ner.detect(text, entities)', kind: 'sync'},
      {from: 'Detector', to: 'Redactor', label: 'Detection · or DetectorUnavailable → 503', kind: 'reply'},
      {from: 'Redactor', to: 'Redis', label: 'store.save → doc:{document_id}', kind: 'sync'},
      {
        from: 'Redactor',
        to: 'Client',
        label: '200 {status: "processed", redacted_text, spans, entity_counts}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Redacts on POST /v1/redact and saves the result',
      detail:
        'Register `POST /v1/redact`; a text with an email and a phone number answers the redacted text and its spans, and the redaction is saved through `store.save`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/redact["']/, /store\.save\(/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/redact['"]/, /\bsave\(/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/redact"/, /store\.Save\(/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"redact"\s*\)/, /Store\.save\(/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/redact"/, /store::save\(/]},
      },
    },
    {
      id: 'size-cap',
      title: 'An oversized text is 413 with a constant body',
      detail:
        'A text over `MAX_TEXT_BYTES` (256 KiB) answers **413** `{"error": "text_too_large"}`; the starter quotes the first 80 characters of the payload back in a `preview` field, so the error path copies customer text into every log that records a response.',
      match: {
        python: {all: [/MAX_TEXT_BYTES/, /\b413\b/], none: [/["']preview["']/, /text\[\s*:\s*\d+\s*\]/]},
        typescript: {all: [/MAX_TEXT_BYTES/, /\b413\b/], none: [/\bpreview\s*:/, /text\.slice\(\s*0/]},
        go: {all: [/maxTextBytes/, /StatusRequestEntityTooLarge|\b413\b/], none: [/"preview"/, /\.Text\[:\d+\]/]},
        scala: {all: [/MaxTextBytes/, /PayloadTooLarge|\b413\b/], none: [/"preview"/, /\.take\(\d+\)/]},
        cpp: {all: [/kMaxTextBytes/, /\b413\b/], none: [/"preview"/, /\.substr\(0,\s*\d+\)/]},
      },
    },
    {
      id: 'entity-whitelist',
      title: 'Unknown entity types are 400 before the detector runs',
      detail:
        'Each requested entity is checked against `ENTITY_TYPES` before `detect` is called, and an unknown one is **400**; the starter passes the list through, so a typo in a type name returns 200 with that type left unredacted.',
      match: {
        python: {all: [/\bin ENTITY_TYPES\b/, /\b400\b/], order: [/\bin ENTITY_TYPES\b/, /\bdetect\(/]},
        typescript: {all: [/ENTITY_TYPES\.includes\(/, /\b400\b/], order: [/ENTITY_TYPES\.includes\(/, /\bdetect\(/]},
        go: {
          all: [/slices\.Contains\(spans\.EntityTypes|range spans\.EntityTypes/, /StatusBadRequest|\b400\b/],
          order: [/slices\.Contains\(spans\.EntityTypes|range spans\.EntityTypes/, /ner\.Detect\(/],
        },
        scala: {
          all: [/EntityTypes\.contains|EntityTypes\.toSet/, /BadRequest|\b400\b/],
          order: [/EntityTypes\.contains|EntityTypes\.toSet/, /Ner\.detect\(/],
        },
        cpp: {
          all: [/kEntityTypes\.(?:begin|end)\(\)/, /\b400\b/],
          order: [/kEntityTypes\.(?:begin|end)\(\)/, /ner::detect\(/],
        },
      },
    },
    {
      id: 'fail-closed',
      title: 'A detector failure is 503 with no text',
      detail:
        '`DetectorUnavailable` answers **503** `{"error": "detector_unavailable"}` and saves nothing; the starter catches it and answers 200 with the caller\'s own text as `redacted_text`, so an outage leaks every document it touches.',
      match: {
        python: {all: [/\b503\b/, /detector_unavailable/], none: [/["']redacted_text["']\s*:\s*text\b/]},
        typescript: {all: [/\b503\b/, /detector_unavailable/], none: [/redacted_text:\s*text\b/]},
        go: {
          all: [/StatusServiceUnavailable|\b503\b/, /detector_unavailable/],
          none: [/"redacted_text":\s*body\.Text/],
        },
        scala: {
          all: [/ServiceUnavailable|\b503\b/, /detector_unavailable/],
          none: [/"redacted_text"\s*->\s*JsString\(text\)/],
        },
        cpp: {all: [/\b503\b/, /detector_unavailable/], none: [/\{"redacted_text",\s*text\}/]},
      },
    },
    {
      id: 'processed',
      title: 'A text with nothing to redact is saved and marked processed',
      detail:
        'A detection with no spans is saved like any other and answers `status: "processed"` with an empty span list; the starter returns early with `status: "clean"` and saves nothing, so a miss looks the same as a redactor that did not run.',
      match: {
        python: {all: [/["']processed["']/, /store\.save\(/], none: [/if not detection\.spans/, /["']clean["']/]},
        typescript: {all: [/'processed'/, /\bsave\(/], none: [/detection\.spans\.length === 0/, /'clean'/]},
        go: {all: [/"processed"/, /store\.Save\(/], none: [/len\(detection\.Spans\) == 0/, /"clean"/]},
        scala: {all: [/"processed"/, /Store\.save\(/], none: [/detection\.spans\.isEmpty/, /"clean"/]},
        cpp: {all: [/"processed"/, /store::save\(/], none: [/detection\.spans\.empty\(\)/, /"clean"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from dataclasses import asdict

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from redactor import store  # store.save(tenant, document_id, spans, detector_version, redacted_text)
from redactor.ner import detect  # detect(text, entities) -> Detection, or raises DetectorUnavailable
from redactor.spans import DEFAULT_ENTITIES, ENTITY_TYPES, DetectorUnavailable, apply_spans, count_entities

app = FastAPI()

MAX_TEXT_BYTES = 256 * 1024


@app.post("/v1/redact")
async def redact(request: Request) -> JSONResponse:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    body = await request.json()
    document_id, text = body.get("document_id"), body.get("text")
    if not document_id or not isinstance(text, str) or not text:
        raise HTTPException(status_code=400, detail="document_id and text are required")
    if len(text.encode()) > MAX_TEXT_BYTES:
        return JSONResponse({"error": "text_too_large", "preview": text[:80]}, status_code=413)
    entities = body.get("entities") or list(DEFAULT_ENTITIES)
    try:
        detection = detect(text, entities)
    except DetectorUnavailable:
        return JSONResponse({"document_id": document_id, "status": "degraded", "redacted_text": text, "degraded": True})
    if not detection.spans:
        return JSONResponse({"document_id": document_id, "status": "clean"})
    redacted = apply_spans(text, detection.spans)
    store.save(tenant, document_id, detection.spans, detection.detector_version, redacted)
    return JSONResponse(
        {
            "document_id": document_id,
            "status": "processed",
            "redacted_text": redacted,
            "spans": [asdict(s) for s in detection.spans],
            "entity_counts": count_entities(detection.spans),
            "detector_version": detection.detector_version,
            "source": detection.source,
            "degraded": detection.degraded,
        }
    )
`,
      solution: `from dataclasses import asdict

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from redactor import store  # store.save(tenant, document_id, spans, detector_version, redacted_text)
from redactor.ner import detect  # detect(text, entities) -> Detection, or raises DetectorUnavailable
from redactor.spans import DEFAULT_ENTITIES, ENTITY_TYPES, DetectorUnavailable, apply_spans, count_entities

app = FastAPI()

MAX_TEXT_BYTES = 256 * 1024


@app.post("/v1/redact")
async def redact(request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    body = await request.json()
    document_id, text = body.get("document_id"), body.get("text")
    if not document_id or not isinstance(text, str) or not text:
        raise HTTPException(status_code=400, detail="document_id and text are required")
    if len(text.encode()) > MAX_TEXT_BYTES:
        # A constant body: an error path must not carry the payload into logs and traces.
        return JSONResponse({"error": "text_too_large"}, status_code=413)
    entities = body.get("entities") or list(DEFAULT_ENTITIES)
    if not isinstance(entities, list) or any(e not in ENTITY_TYPES for e in entities):
        return JSONResponse({"error": "unknown_entity"}, status_code=400)
    try:
        detection = detect(text, entities)
    except DetectorUnavailable:
        # Fail closed: no detector can vouch for this text, so none of it goes back.
        return JSONResponse({"error": "detector_unavailable"}, status_code=503)
    redacted = apply_spans(text, detection.spans)
    store.save(tenant, document_id, detection.spans, detection.detector_version, redacted)
    return JSONResponse(
        {
            "document_id": document_id,
            "status": "processed",
            "redacted_text": redacted,
            "spans": [asdict(s) for s in detection.spans],
            "entity_counts": count_entities(detection.spans),
            "detector_version": detection.detector_version,
            "source": detection.source,
            "degraded": detection.degraded,
        }
    )
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {detect} from 'redactor/ner'; // detect(text, entities): Detection, or throws DetectorUnavailable
import {DEFAULT_ENTITIES, type Detection, DetectorUnavailable, ENTITY_TYPES, applySpans, countEntities} from 'redactor/spans';
import {save} from 'redactor/store'; // save(tenant, documentId, spans, detectorVersion, redactedText)

export const app = Fastify();

export const MAX_TEXT_BYTES = 256 * 1024;

interface RedactBody {
  document_id?: string;
  text?: unknown;
  entities?: string[];
}

app.post('/v1/redact', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const body = (request.body ?? {}) as RedactBody;
  const {document_id: documentId, text} = body;
  if (!documentId || typeof text !== 'string' || text === '') return reply.code(400).send({error: 'document_id and text are required'});
  if (Buffer.byteLength(text) > MAX_TEXT_BYTES) return reply.code(413).send({error: 'text_too_large', preview: text.slice(0, 80)});
  const entities = body.entities ?? [...DEFAULT_ENTITIES];
  let detection: Detection;
  try {
    detection = await detect(text, entities);
  } catch (e) {
    if (!(e instanceof DetectorUnavailable)) throw e;
    return {document_id: documentId, status: 'degraded', redacted_text: text, degraded: true};
  }
  if (detection.spans.length === 0) return {document_id: documentId, status: 'clean'};
  const redacted = applySpans(text, detection.spans);
  await save(tenant, documentId, detection.spans, detection.detector_version, redacted);
  return {
    document_id: documentId,
    status: 'processed',
    redacted_text: redacted,
    spans: detection.spans,
    entity_counts: countEntities(detection.spans),
    detector_version: detection.detector_version,
    source: detection.source,
    degraded: detection.degraded,
  };
});
`,
      solution: `import Fastify from 'fastify';

import {detect} from 'redactor/ner'; // detect(text, entities): Detection, or throws DetectorUnavailable
import {DEFAULT_ENTITIES, type Detection, DetectorUnavailable, ENTITY_TYPES, applySpans, countEntities} from 'redactor/spans';
import {save} from 'redactor/store'; // save(tenant, documentId, spans, detectorVersion, redactedText)

export const app = Fastify();

export const MAX_TEXT_BYTES = 256 * 1024;

interface RedactBody {
  document_id?: string;
  text?: unknown;
  entities?: unknown;
}

app.post('/v1/redact', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const body = (request.body ?? {}) as RedactBody;
  const {document_id: documentId, text} = body;
  if (!documentId || typeof text !== 'string' || text === '') return reply.code(400).send({error: 'document_id and text are required'});
  // A constant body: an error path must not carry the payload into logs and traces.
  if (Buffer.byteLength(text) > MAX_TEXT_BYTES) return reply.code(413).send({error: 'text_too_large'});
  const entities = body.entities ?? [...DEFAULT_ENTITIES];
  if (!Array.isArray(entities) || !entities.every(e => ENTITY_TYPES.includes(e))) return reply.code(400).send({error: 'unknown_entity'});
  let detection: Detection;
  try {
    detection = await detect(text, entities);
  } catch (e) {
    if (!(e instanceof DetectorUnavailable)) throw e;
    // Fail closed: no detector can vouch for this text, so none of it goes back.
    return reply.code(503).send({error: 'detector_unavailable'});
  }
  const redacted = applySpans(text, detection.spans);
  await save(tenant, documentId, detection.spans, detection.detector_version, redacted);
  return {
    document_id: documentId,
    status: 'processed',
    redacted_text: redacted,
    spans: detection.spans,
    entity_counts: countEntities(detection.spans),
    detector_version: detection.detector_version,
    source: detection.source,
    degraded: detection.degraded,
  };
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"redactor/ner"   // ner.Detect(ctx, text, entities) (spans.Detection, error): spans.ErrDetectorUnavailable when no detector can answer
	"redactor/spans" // spans.EntityTypes, DefaultEntities, ApplySpans, CountEntities
	"redactor/store" // store.Save(ctx, tenant, documentID, spans, detectorVersion, redactedText)
)

const maxTextBytes = 256 * 1024

type redactRequest struct {
	DocumentID string   \`json:"document_id"\`
	Text       string   \`json:"text"\`
	Entities   []string \`json:"entities"\`
}

type redactResponse struct {
	DocumentID      string         \`json:"document_id"\`
	Status          string         \`json:"status"\`
	RedactedText    string         \`json:"redacted_text"\`
	Spans           []spans.Span   \`json:"spans"\`
	EntityCounts    map[string]int \`json:"entity_counts"\`
	DetectorVersion string         \`json:"detector_version"\`
	Source          string         \`json:"source"\`
	Degraded        bool           \`json:"degraded"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func redact(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	var body redactRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.DocumentID == "" || body.Text == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "document_id and text are required"})
		return
	}
	if len(body.Text) > maxTextBytes {
		writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]string{"error": "text_too_large", "preview": body.Text[:80]})
		return
	}
	entities := body.Entities
	if len(entities) == 0 {
		entities = spans.DefaultEntities
	}
	detection, err := ner.Detect(r.Context(), body.Text, entities)
	if err != nil {
		writeJSON(rw, http.StatusOK, map[string]any{"document_id": body.DocumentID, "status": "degraded", "redacted_text": body.Text, "degraded": true})
		return
	}
	if len(detection.Spans) == 0 {
		writeJSON(rw, http.StatusOK, map[string]any{"document_id": body.DocumentID, "status": "clean"})
		return
	}
	redacted := spans.ApplySpans(body.Text, detection.Spans)
	if err := store.Save(r.Context(), tenant, body.DocumentID, detection.Spans, detection.DetectorVersion, redacted); err != nil {
		http.Error(rw, "store unavailable", http.StatusInternalServerError)
		return
	}
	writeJSON(rw, http.StatusOK, redactResponse{
		DocumentID: body.DocumentID, Status: "processed", RedactedText: redacted, Spans: detection.Spans,
		EntityCounts: spans.CountEntities(detection.Spans), DetectorVersion: detection.DetectorVersion,
		Source: detection.Source, Degraded: detection.Degraded,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/redact", redact)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"slices"

	"redactor/ner"   // ner.Detect(ctx, text, entities) (spans.Detection, error): spans.ErrDetectorUnavailable when no detector can answer
	"redactor/spans" // spans.EntityTypes, DefaultEntities, ApplySpans, CountEntities
	"redactor/store" // store.Save(ctx, tenant, documentID, spans, detectorVersion, redactedText)
)

const maxTextBytes = 256 * 1024

type redactRequest struct {
	DocumentID string   \`json:"document_id"\`
	Text       string   \`json:"text"\`
	Entities   []string \`json:"entities"\`
}

type redactResponse struct {
	DocumentID      string         \`json:"document_id"\`
	Status          string         \`json:"status"\`
	RedactedText    string         \`json:"redacted_text"\`
	Spans           []spans.Span   \`json:"spans"\`
	EntityCounts    map[string]int \`json:"entity_counts"\`
	DetectorVersion string         \`json:"detector_version"\`
	Source          string         \`json:"source"\`
	Degraded        bool           \`json:"degraded"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func redact(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	var body redactRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.DocumentID == "" || body.Text == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "document_id and text are required"})
		return
	}
	if len(body.Text) > maxTextBytes {
		// A constant body: an error path must not carry the payload into logs and traces.
		writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]string{"error": "text_too_large"})
		return
	}
	entities := body.Entities
	if len(entities) == 0 {
		entities = spans.DefaultEntities
	}
	for _, entity := range entities {
		if !slices.Contains(spans.EntityTypes, entity) {
			writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "unknown_entity"})
			return
		}
	}
	detection, err := ner.Detect(r.Context(), body.Text, entities)
	if err != nil {
		// Fail closed: no detector can vouch for this text, so none of it goes back.
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "detector_unavailable"})
		return
	}
	redacted := spans.ApplySpans(body.Text, detection.Spans)
	if err := store.Save(r.Context(), tenant, body.DocumentID, detection.Spans, detection.DetectorVersion, redacted); err != nil {
		http.Error(rw, "store unavailable", http.StatusInternalServerError)
		return
	}
	writeJSON(rw, http.StatusOK, redactResponse{
		DocumentID: body.DocumentID, Status: "processed", RedactedText: redacted, Spans: detection.Spans,
		EntityCounts: spans.CountEntities(detection.Spans), DetectorVersion: detection.DetectorVersion,
		Source: detection.Source, Degraded: detection.Degraded,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/redact", redact)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import redactor.{DetectorUnavailable, Ner, Spans, Store} // Ner.detect(text, entities), Store.save(tenant, documentId, spans, detectorVersion, redactedText)

object Api {
  val MaxTextBytes: Int = 256 * 1024

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  def redact(tenant: String, body: JsObject): HttpResponse = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val fields = body.fields
    (fields.get("document_id"), fields.get("text")) match {
      case (Some(JsString(documentId)), Some(JsString(text))) if documentId.nonEmpty && text.nonEmpty =>
        if (text.getBytes("UTF-8").length > MaxTextBytes) json(StatusCodes.PayloadTooLarge, JsObject("error" -> JsString("text_too_large"), "preview" -> JsString(text.take(80))))
        else {
          val entities = fields.get("entities") match {
            case Some(JsArray(items)) if items.nonEmpty => items.collect { case JsString(e) => e }
            case _ => Spans.DefaultEntities
          }
          try {
            val detection = Ner.detect(text, entities)
            if (detection.spans.isEmpty) json(StatusCodes.OK, JsObject("document_id" -> JsString(documentId), "status" -> JsString("clean")))
            else {
              val redacted = Spans.applySpans(text, detection.spans)
              Store.save(tenant, documentId, detection.spans, detection.detectorVersion, redacted)
              json(StatusCodes.OK, JsObject(
                "document_id" -> JsString(documentId), "status" -> JsString("processed"), "redacted_text" -> JsString(redacted),
                "spans" -> JsArray(detection.spans.map(Spans.spanJson).toVector), "entity_counts" -> Spans.countsJson(Spans.countEntities(detection.spans)),
                "detector_version" -> JsString(detection.detectorVersion), "source" -> JsString(detection.source), "degraded" -> JsBoolean(detection.degraded)))
            }
          } catch {
            case _: DetectorUnavailable =>
              json(StatusCodes.OK, JsObject("document_id" -> JsString(documentId), "status" -> JsString("degraded"), "redacted_text" -> JsString(text), "degraded" -> JsTrue))
          }
        }
      case _ => error(StatusCodes.BadRequest, "document_id and text are required")
    }
  }

  val route: Route = path("v1" / "redact") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(error(StatusCodes.Unauthorized, "X-Tenant-Id is required"))
        case Some(tenant) => entity(as[String])(raw => complete(redact(tenant, raw.parseJson.asJsObject)))
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import redactor.{DetectorUnavailable, Ner, Spans, Store} // Ner.detect(text, entities), Store.save(tenant, documentId, spans, detectorVersion, redactedText)

object Api {
  val MaxTextBytes: Int = 256 * 1024

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  def redact(tenant: String, body: JsObject): HttpResponse = {
    val fields = body.fields
    (fields.get("document_id"), fields.get("text")) match {
      // A constant body: an error path must not carry the payload into logs and traces.
      case (Some(JsString(documentId)), Some(JsString(text))) if documentId.nonEmpty && text.nonEmpty =>
        if (text.getBytes("UTF-8").length > MaxTextBytes) error(StatusCodes.PayloadTooLarge, "text_too_large")
        else {
          val entities = fields.get("entities") match {
            case Some(JsArray(items)) if items.nonEmpty => items.map { case JsString(e) => e; case other => other.toString }
            case _ => Spans.DefaultEntities
          }
          if (!entities.forall(Spans.EntityTypes.contains)) error(StatusCodes.BadRequest, "unknown_entity")
          else
            try {
              val detection = Ner.detect(text, entities)
              val redacted = Spans.applySpans(text, detection.spans)
              Store.save(tenant, documentId, detection.spans, detection.detectorVersion, redacted)
              json(StatusCodes.OK, JsObject(
                "document_id" -> JsString(documentId), "status" -> JsString("processed"), "redacted_text" -> JsString(redacted),
                "spans" -> JsArray(detection.spans.map(Spans.spanJson).toVector), "entity_counts" -> Spans.countsJson(Spans.countEntities(detection.spans)),
                "detector_version" -> JsString(detection.detectorVersion), "source" -> JsString(detection.source), "degraded" -> JsBoolean(detection.degraded)))
            } catch {
              // Fail closed: no detector can vouch for this text, so none of it goes back.
              case _: DetectorUnavailable => error(StatusCodes.ServiceUnavailable, "detector_unavailable")
            }
        }
      case _ => error(StatusCodes.BadRequest, "document_id and text are required")
    }
  }

  val route: Route = path("v1" / "redact") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(error(StatusCodes.Unauthorized, "X-Tenant-Id is required"))
        case Some(tenant) => entity(as[String])(raw => complete(redact(tenant, raw.parseJson.asJsObject)))
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
#include <vector>

#include "redactor/ner.h"    // ner::detect(text, entities) -> spans::Detection, or throws spans::DetectorUnavailable
#include "redactor/spans.h"  // spans::kEntityTypes, kDefaultEntities, apply_spans, count_entities
#include "redactor/store.h"  // store::save(tenant, document_id, spans, detector_version, redacted_text)

using json = nlohmann::json;

constexpr size_t kMaxTextBytes = 256 * 1024;

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void redact(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, json{{"error", "X-Tenant-Id is required"}});
  const json body = json::parse(req.body, nullptr, false);
  const std::string document_id = body.is_object() ? body.value("document_id", "") : "";
  const std::string text = body.is_object() && body.contains("text") && body["text"].is_string() ? body["text"].get<std::string>() : "";
  if (document_id.empty() || text.empty()) return reply(res, 400, json{{"error", "document_id and text are required"}});
  if (text.size() > kMaxTextBytes) return reply(res, 413, json{{"error", "text_too_large"}, {"preview", text.substr(0, 80)}});
  std::vector<std::string> entities = body.value("entities", std::vector<std::string>{});
  if (entities.empty()) entities = spans::kDefaultEntities;
  spans::Detection detection;
  try {
    detection = ner::detect(text, entities);
  } catch (const spans::DetectorUnavailable&) {
    return reply(res, 200, json{{"document_id", document_id}, {"status", "degraded"}, {"redacted_text", text}, {"degraded", true}});
  }
  if (detection.spans.empty()) return reply(res, 200, json{{"document_id", document_id}, {"status", "clean"}});
  const std::string redacted = spans::apply_spans(text, detection.spans);
  store::save(tenant, document_id, detection.spans, detection.detector_version, redacted);
  reply(res, 200, json{{"document_id", document_id}, {"status", "processed"}, {"redacted_text", redacted},
                       {"spans", detection.spans}, {"entity_counts", spans::count_entities(detection.spans)},
                       {"detector_version", detection.detector_version}, {"source", detection.source}, {"degraded", detection.degraded}});
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/redact", redact); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <string>
#include <vector>

#include "redactor/ner.h"    // ner::detect(text, entities) -> spans::Detection, or throws spans::DetectorUnavailable
#include "redactor/spans.h"  // spans::kEntityTypes, kDefaultEntities, apply_spans, count_entities
#include "redactor/store.h"  // store::save(tenant, document_id, spans, detector_version, redacted_text)

using json = nlohmann::json;

constexpr size_t kMaxTextBytes = 256 * 1024;

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void redact(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, json{{"error", "X-Tenant-Id is required"}});
  const json body = json::parse(req.body, nullptr, false);
  const std::string document_id = body.is_object() ? body.value("document_id", "") : "";
  const std::string text = body.is_object() && body.contains("text") && body["text"].is_string() ? body["text"].get<std::string>() : "";
  if (document_id.empty() || text.empty()) return reply(res, 400, json{{"error", "document_id and text are required"}});
  // A constant body: an error path must not carry the payload into logs and traces.
  if (text.size() > kMaxTextBytes) return reply(res, 413, json{{"error", "text_too_large"}});
  std::vector<std::string> entities = body.value("entities", std::vector<std::string>{});
  if (entities.empty()) entities = spans::kDefaultEntities;
  for (const std::string& entity : entities) {
    if (std::find(spans::kEntityTypes.begin(), spans::kEntityTypes.end(), entity) == spans::kEntityTypes.end()) {
      return reply(res, 400, json{{"error", "unknown_entity"}});
    }
  }
  spans::Detection detection;
  try {
    detection = ner::detect(text, entities);
  } catch (const spans::DetectorUnavailable&) {
    // Fail closed: no detector can vouch for this text, so none of it goes back.
    return reply(res, 503, json{{"error", "detector_unavailable"}});
  }
  const std::string redacted = spans::apply_spans(text, detection.spans);
  store::save(tenant, document_id, detection.spans, detection.detector_version, redacted);
  reply(res, 200, json{{"document_id", document_id}, {"status", "processed"}, {"redacted_text", redacted},
                       {"spans", detection.spans}, {"entity_counts", spans::count_entities(detection.spans)},
                       {"detector_version", detection.detector_version}, {"source", detection.source}, {"degraded", detection.degraded}});
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/redact", redact); }
`,
    },
  },
  harness: {
    python: `import detector_pb2
import detector_pb2_grpc
from redactor import store
from redactor.spans import scan

TENANT = {"X-Tenant-Id": "acme"}
TEXT = "Reach Ada at ada@example.com or 415-555-0132."
CAP = 256 * 1024


class Detector(detector_pb2_grpc.DetectorServicer):
    """The NER model's stand-in: every requested type a pattern covers, by its pattern."""

    def Detect(self, request, context):
        found = [detector_pb2.EntitySpan(start=s.start, end=s.end, entity=s.entity) for s in scan(request.text, request.entities)]
        return detector_pb2.DetectResponse(spans=found, model_version="ner-2026.10")


def _api(ctx, detector=True):
    if detector:
        ctx.grpc.serve(detector_pb2_grpc.add_DetectorServicer_to_server, Detector())
    return ctx.client(ctx.load("api").app)


async def _redact(c, body, headers=TENANT):
    return await c.post("/v1/redact", json=body, headers=headers)


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await _redact(c, {"document_id": "d-1", "text": TEXT})
        assert r.status_code == 200, f"POST /v1/redact answered {r.status_code}: {r.text}"
        body = r.json()
        assert body.get("redacted_text") == "Reach Ada at [EMAIL] or [PHONE].", f"the redacted text is {body.get('redacted_text')!r}"
        email, phone = TEXT.index("ada@"), TEXT.index("415")
        got = [(s.get("start"), s.get("end"), s.get("entity")) for s in body.get("spans") or []]
        assert got == [(email, email + 15, "EMAIL"), (phone, phone + 12, "PHONE")], f"the spans are {got}"
        saved = store.load("d-1")
        assert saved is not None and saved.tenant == "acme" and len(saved.spans) == 2, f"the redaction must be saved for tenant acme, the store holds {saved}"
        r = await _redact(c, {"document_id": "d-2", "text": TEXT}, headers={})
    assert r.status_code == 401, f"a request without X-Tenant-Id answered {r.status_code}, expected 401"


async def check_size_cap(ctx):
    async with _api(ctx) as c:
        big = "Call 415-555-0132 now. " + "lorem ipsum dolor sit amet " * 10_000
        r = await _redact(c, {"document_id": "d-big", "text": big})
        assert r.status_code == 413, f"a {len(big)}-byte text answered {r.status_code}, expected 413"
        assert "415-555-0132" not in r.text and "lorem" not in r.text, f"the 413 body quotes the payload: {r.text[:200]}. An error body is logged and traced; keep it constant"
        exact = "x@example.com " + ("lorem ipsum " * 30_000)[: CAP - 14]
        r = await _redact(c, {"document_id": "d-cap", "text": exact, "entities": ["EMAIL"]})
    assert r.status_code == 200, f"a text of exactly 256 KiB answered {r.status_code}, expected 200"


async def check_entity_whitelist(ctx):
    async with _api(ctx) as c:
        r = await _redact(c, {"document_id": "d-1", "text": TEXT, "entities": ["EMAIL", "PHONE_NUMBER"]})
        assert r.status_code == 400, f"an unknown entity type (PHONE_NUMBER) answered {r.status_code}, expected 400: the phone number went back unredacted"
        assert ctx.grpc.calls_to("Detect") == [], "the detector was called for a request with an unknown entity type: reject it first"
        assert store.load("d-1") is None, "a rejected request must not be saved"
        r = await _redact(c, {"document_id": "d-2", "text": TEXT, "entities": ["EMAIL"]})
    assert r.status_code == 200 and r.json().get("redacted_text") == "Reach Ada at [EMAIL] or 415-555-0132.", f"a request for EMAIL only answered {r.status_code} {r.text}"


async def check_fail_closed(ctx):
    async with _api(ctx, detector=False) as c:
        r = await _redact(c, {"document_id": "d-1", "text": "Ada Lovelace, ada@example.com", "entities": ["EMAIL", "PERSON"]})
        assert r.status_code == 503, f"with the detector down and PERSON requested (no pattern covers it) the redactor answered {r.status_code}, expected 503"
        assert "ada@example.com" not in r.text and "Lovelace" not in r.text, f"the 503 body carries the customer text: {r.text}"
        assert r.json() == {"error": "detector_unavailable"}, f"the 503 body is {r.text}, expected {{\\"error\\": \\"detector_unavailable\\"}}"
        assert store.load("d-1") is None, "a request that could not be redacted must not be saved"
        r = await _redact(c, {"document_id": "d-2", "text": TEXT})
    assert r.status_code == 200 and r.json().get("degraded") is True, f"with the detector down and only pattern types requested, the regex fallback answers a degraded 200; got {r.status_code} {r.text}"


async def check_processed(ctx):
    clean = "Nothing personal in this sentence."
    async with _api(ctx) as c:
        r = await _redact(c, {"document_id": "d-clean", "text": clean})
    assert r.status_code == 200, f"a text with nothing to redact answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("status") == "processed", f"a text with nothing to redact must answer status processed, got {body}"
    assert body.get("spans") == [] and body.get("entity_counts") == {} and body.get("redacted_text") == clean, f"expected an empty span list, empty counts and the text as redacted_text, got {body}"
    assert body.get("detector_version") == "ner-2026.10", f"the answer must name the detector version, got {body}"
    saved = store.load("d-clean")
    assert saved is not None and saved.spans == [], f"a text with nothing to redact must be saved like any other (the audit read shows it was processed), the store holds {saved}"
`,
    typescript: `const TENANT = {'X-Tenant-Id': 'acme'};
const TEXT = 'Reach Ada at ada@example.com or 415-555-0132.';
const CAP = 256 * 1024;

/** The NER model's stand-in: every requested type a pattern covers, by its pattern. */
function api(ctx, {detector = true} = {}) {
  const {scan} = ctx.load('/support/redactor/spans.ts');
  if (detector) {
    const pkg = ctx.proto('detector.proto');
    ctx.grpc.serve(pkg.redactor.Detector.service, {
      Detect(call, callback) {
        const found = scan(call.request.text, call.request.entities ?? []).map(s => ({start: s.start, end: s.end, entity: s.entity}));
        callback(null, {spans: found, model_version: 'ner-2026.10'});
      },
    });
  }
  return {c: ctx.client(ctx.load('api').app), store: ctx.load('/support/redactor/store.ts')};
}

const redact = (c, body, headers: Record<string, string> = TENANT) => c.post('/v1/redact', {json: body, headers});

export async function check_route(ctx) {
  const {c, store} = api(ctx);
  let r = await redact(c, {document_id: 'd-1', text: TEXT});
  assert.equal(r.status, 200, \`POST /v1/redact answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert.equal(body.redacted_text, 'Reach Ada at [EMAIL] or [PHONE].', \`the redacted text is \${JSON.stringify(body.redacted_text)}\`);
  const email = TEXT.indexOf('ada@');
  const phone = TEXT.indexOf('415');
  const got = (body.spans ?? []).map(s => [s.start, s.end, s.entity]);
  assert.deepStrictEqual(got, [[email, email + 15, 'EMAIL'], [phone, phone + 12, 'PHONE']], \`the spans are \${JSON.stringify(got)}\`);
  const saved = await store.load('d-1');
  assert(saved !== null && saved.tenant === 'acme' && saved.spans.length === 2, \`the redaction must be saved for tenant acme, the store holds \${JSON.stringify(saved)}\`);
  r = await redact(c, {document_id: 'd-2', text: TEXT}, {});
  assert.equal(r.status, 401, \`a request without X-Tenant-Id answered \${r.status}, expected 401\`);
}

export async function check_size_cap(ctx) {
  const {c} = api(ctx);
  const big = 'Call 415-555-0132 now. ' + 'lorem ipsum dolor sit amet '.repeat(10_000);
  let r = await redact(c, {document_id: 'd-big', text: big});
  assert.equal(r.status, 413, \`a \${big.length}-byte text answered \${r.status}, expected 413\`);
  assert(!r.text.includes('415-555-0132') && !r.text.includes('lorem'), \`the 413 body quotes the payload: \${r.text.slice(0, 200)}. An error body is logged and traced; keep it constant\`);
  const exact = 'x@example.com ' + 'lorem ipsum '.repeat(30_000).slice(0, CAP - 14);
  r = await redact(c, {document_id: 'd-cap', text: exact, entities: ['EMAIL']});
  assert.equal(r.status, 200, \`a text of exactly 256 KiB answered \${r.status}, expected 200\`);
}

export async function check_entity_whitelist(ctx) {
  const {c, store} = api(ctx);
  let r = await redact(c, {document_id: 'd-1', text: TEXT, entities: ['EMAIL', 'PHONE_NUMBER']});
  assert.equal(r.status, 400, \`an unknown entity type (PHONE_NUMBER) answered \${r.status}, expected 400: the phone number went back unredacted\`);
  assert.equal(ctx.grpc.callsTo('Detect').length, 0, 'the detector was called for a request with an unknown entity type: reject it first');
  assert.equal(await store.load('d-1'), null, 'a rejected request must not be saved');
  r = await redact(c, {document_id: 'd-2', text: TEXT, entities: ['EMAIL']});
  assert(r.status === 200 && r.json().redacted_text === 'Reach Ada at [EMAIL] or 415-555-0132.', \`a request for EMAIL only answered \${r.status} \${r.text}\`);
}

export async function check_fail_closed(ctx) {
  const {c, store} = api(ctx, {detector: false});
  let r = await redact(c, {document_id: 'd-1', text: 'Ada Lovelace, ada@example.com', entities: ['EMAIL', 'PERSON']});
  assert.equal(r.status, 503, \`with the detector down and PERSON requested (no pattern covers it) the redactor answered \${r.status}, expected 503\`);
  assert(!r.text.includes('ada@example.com') && !r.text.includes('Lovelace'), \`the 503 body carries the customer text: \${r.text}\`);
  assert.deepStrictEqual(r.json(), {error: 'detector_unavailable'}, \`the 503 body is \${r.text}, expected {"error": "detector_unavailable"}\`);
  assert.equal(await store.load('d-1'), null, 'a request that could not be redacted must not be saved');
  r = await redact(c, {document_id: 'd-2', text: TEXT});
  assert(r.status === 200 && r.json().degraded === true, \`with the detector down and only pattern types requested, the regex fallback answers a degraded 200; got \${r.status} \${r.text}\`);
}

export async function check_processed(ctx) {
  const {c, store} = api(ctx);
  const clean = 'Nothing personal in this sentence.';
  const r = await redact(c, {document_id: 'd-clean', text: clean});
  assert.equal(r.status, 200, \`a text with nothing to redact answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert.equal(body.status, 'processed', \`a text with nothing to redact must answer status processed, got \${r.text}\`);
  assert(Array.isArray(body.spans) && body.spans.length === 0 && JSON.stringify(body.entity_counts) === '{}' && body.redacted_text === clean, \`expected an empty span list, empty counts and the text as redacted_text, got \${r.text}\`);
  assert.equal(body.detector_version, 'ner-2026.10', \`the answer must name the detector version, got \${r.text}\`);
  const saved = await store.load('d-clean');
  assert(saved !== null && saved.spans.length === 0, \`a text with nothing to redact must be saved like any other (the audit read shows it was processed), the store holds \${JSON.stringify(saved)}\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"strings"

	pb "redactor/gen/detector"
	"redactor/spans"
	"redactor/store"

	"leetbuild/harness"
)

const (
	apiText = "Reach Ada at ada@example.com or 415-555-0132."
	apiCap  = 256 * 1024
)

// detectorPeer is the NER model's stand-in: every requested type a pattern covers, by its pattern.
type detectorPeer struct {
	pb.UnimplementedDetectorServer
}

func (detectorPeer) Detect(_ context.Context, req *pb.DetectRequest) (*pb.DetectResponse, error) {
	var found []*pb.EntitySpan
	for _, s := range spans.Scan(req.GetText(), req.GetEntities()) {
		found = append(found, &pb.EntitySpan{Start: int32(s.Start), End: int32(s.End), Entity: s.Entity})
	}
	return &pb.DetectResponse{Spans: found, ModelVersion: "ner-2026.10"}, nil
}

func apiClient(ctx *harness.Ctx, detector bool) *harness.HTTP {
	if detector {
		pb.RegisterDetectorServer(ctx.GRPC.Server(""), detectorPeer{})
	}
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func apiRedact(c *harness.HTTP, body map[string]any) *harness.Response {
	return c.Post("/v1/redact", body, "X-Tenant-Id", "acme")
}

func apiBody(r *harness.Response) map[string]any {
	var body map[string]any
	r.Decode(&body)
	return body
}

func apiLoad(ctx *harness.Ctx, documentID string) *store.Redaction {
	saved, err := store.Load(context.Background(), documentID)
	ctx.NoError(err, "store.Load(%s)", documentID)
	return saved
}

func CheckRoute(ctx *harness.Ctx) {
	c := apiClient(ctx, true)
	r := apiRedact(c, map[string]any{"document_id": "d-1", "text": apiText})
	ctx.Equal(r.Status, 200, "POST /v1/redact (%s)", r.Text())
	body := apiBody(r)
	ctx.Equal(body["redacted_text"], "Reach Ada at [EMAIL] or [PHONE].", "the redacted text")
	email, phone := strings.Index(apiText, "ada@"), strings.Index(apiText, "415")
	var got [][]any
	for _, s := range body["spans"].([]any) {
		m := s.(map[string]any)
		got = append(got, []any{m["start"], m["end"], m["entity"]})
	}
	ctx.Equal(got, [][]any{{float64(email), float64(email + 15), "EMAIL"}, {float64(phone), float64(phone + 12), "PHONE"}}, "the spans")
	saved := apiLoad(ctx, "d-1")
	ctx.Assert(saved != nil && saved.Tenant == "acme" && len(saved.Spans) == 2, "the redaction must be saved for tenant acme, the store holds %+v", saved)
	r = c.Post("/v1/redact", map[string]any{"document_id": "d-2", "text": apiText})
	ctx.Equal(r.Status, 401, "a request without X-Tenant-Id")
}

func CheckSizeCap(ctx *harness.Ctx) {
	c := apiClient(ctx, true)
	big := "Call 415-555-0132 now. " + strings.Repeat("lorem ipsum dolor sit amet ", 10000)
	r := apiRedact(c, map[string]any{"document_id": "d-big", "text": big})
	ctx.Equal(r.Status, 413, "a %d-byte text", len(big))
	ctx.Assert(!strings.Contains(r.Text(), "415-555-0132") && !strings.Contains(r.Text(), "lorem"), "the 413 body quotes the payload: %.200s. An error body is logged and traced; keep it constant", r.Text())
	exact := "x@example.com " + strings.Repeat("lorem ipsum ", 30000)[:apiCap-14]
	r = apiRedact(c, map[string]any{"document_id": "d-cap", "text": exact, "entities": []string{"EMAIL"}})
	ctx.Equal(r.Status, 200, "a text of exactly 256 KiB")
}

func CheckEntityWhitelist(ctx *harness.Ctx) {
	c := apiClient(ctx, true)
	r := apiRedact(c, map[string]any{"document_id": "d-1", "text": apiText, "entities": []string{"EMAIL", "PHONE_NUMBER"}})
	ctx.Equal(r.Status, 400, "an unknown entity type (PHONE_NUMBER) must be rejected, the phone number went back unredacted")
	ctx.Equal(len(ctx.GRPC.CallsTo("Detect", "")), 0, "the detector was called for a request with an unknown entity type: reject it first; Detect calls")
	ctx.Assert(apiLoad(ctx, "d-1") == nil, "a rejected request must not be saved")
	r = apiRedact(c, map[string]any{"document_id": "d-2", "text": apiText, "entities": []string{"EMAIL"}})
	ctx.Assert(r.Status == 200 && apiBody(r)["redacted_text"] == "Reach Ada at [EMAIL] or 415-555-0132.", "a request for EMAIL only answered %d %s", r.Status, r.Text())
}

func CheckFailClosed(ctx *harness.Ctx) {
	c := apiClient(ctx, false)
	r := apiRedact(c, map[string]any{"document_id": "d-1", "text": "Ada Lovelace, ada@example.com", "entities": []string{"EMAIL", "PERSON"}})
	ctx.Equal(r.Status, 503, "with the detector down and PERSON requested (no pattern covers it)")
	ctx.Assert(!strings.Contains(r.Text(), "ada@example.com") && !strings.Contains(r.Text(), "Lovelace"), "the 503 body carries the customer text: %s", r.Text())
	ctx.Equal(apiBody(r), map[string]any{"error": "detector_unavailable"}, "the 503 body")
	ctx.Assert(apiLoad(ctx, "d-1") == nil, "a request that could not be redacted must not be saved")
	r = apiRedact(c, map[string]any{"document_id": "d-2", "text": apiText})
	ctx.Assert(r.Status == 200 && apiBody(r)["degraded"] == true, "with the detector down and only pattern types requested, the regex fallback answers a degraded 200; got %d %s", r.Status, r.Text())
}

func CheckProcessed(ctx *harness.Ctx) {
	c := apiClient(ctx, true)
	clean := "Nothing personal in this sentence."
	r := apiRedact(c, map[string]any{"document_id": "d-clean", "text": clean})
	ctx.Equal(r.Status, 200, "a text with nothing to redact (%s)", r.Text())
	body := apiBody(r)
	ctx.Equal(body["status"], "processed", "a text with nothing to redact must answer status processed (%s); the status", r.Text())
	ctx.Equal(body["spans"], []any{}, "the spans of a text with nothing to redact")
	ctx.Equal(body["entity_counts"], map[string]any{}, "the entity counts of a text with nothing to redact")
	ctx.Equal(body["redacted_text"], clean, "the redacted text")
	ctx.Equal(body["detector_version"], "ner-2026.10", "the answer must name the detector version")
	saved := apiLoad(ctx, "d-clean")
	ctx.Assert(saved != nil && len(saved.Spans) == 0, "a text with nothing to redact must be saved like any other (the audit read shows it was processed), the store holds %+v", saved)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <string>

#include "detector.grpc.pb.h"

namespace {

const std::string kText = "Reach Ada at ada@example.com or 415-555-0132.";
constexpr size_t kCap = 256 * 1024;

// The NER model's stand-in: every requested type a pattern covers, by its pattern.
class DetectorPeer final : public redactor::Detector::Service {
 public:
  grpc::Status Detect(grpc::ServerContext*, const redactor::DetectRequest* req, redactor::DetectResponse* out) override {
    for (const spans::Span& s : spans::scan(req->text(), {req->entities().begin(), req->entities().end()})) {
      redactor::EntitySpan* found = out->add_spans();
      found->set_start(s.start);
      found->set_end(s.end);
      found->set_entity(s.entity);
    }
    out->set_model_version("ner-2026.10");
    return grpc::Status::OK;
  }
};

harness::HTTP api(harness::Ctx& ctx, bool detector) {
  static DetectorPeer* peer = nullptr;
  delete peer;
  peer = new DetectorPeer;
  if (detector) ctx.GRPC.Server("")->RegisterService(peer);
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response post(harness::HTTP& c, const nlohmann::json& body) {
  return c.Post("/v1/redact", body.dump(), "Content-Type", "application/json", "X-Tenant-Id", "acme");
}

nlohmann::json parsed(const harness::Response& r) { return nlohmann::json::parse(r.Text(), nullptr, false); }

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx, true);
  auto r = post(c, {{"document_id", "d-1"}, {"text", kText}});
  ctx.Equal(r.Status, 200, "POST /v1/redact (%s)", r.Text());
  const auto body = parsed(r);
  ctx.Equal(body.value("redacted_text", ""), "Reach Ada at [EMAIL] or [PHONE].", "the redacted text");
  const long email = static_cast<long>(kText.find("ada@"));
  const long phone = static_cast<long>(kText.find("415"));
  nlohmann::json got = nlohmann::json::array();
  for (const auto& s : body.value("spans", nlohmann::json::array())) got.push_back({s.value("start", -1L), s.value("end", -1L), s.value("entity", "")});
  ctx.Equal(got, nlohmann::json({{email, email + 15, "EMAIL"}, {phone, phone + 12, "PHONE"}}), "the spans");
  const auto saved = store::load("d-1");
  ctx.Assert(saved && saved->tenant == "acme" && saved->spans.size() == 2, "the redaction must be saved for tenant acme with its two spans");
  r = c.Post("/v1/redact", nlohmann::json{{"document_id", "d-2"}, {"text", kText}}.dump(), "Content-Type", "application/json");
  ctx.Equal(r.Status, 401, "a request without X-Tenant-Id");
}

void CheckSizeCap(harness::Ctx& ctx) {
  auto c = api(ctx, true);
  std::string big = "Call 415-555-0132 now. ";
  for (int i = 0; i < 10000; i++) big += "lorem ipsum dolor sit amet ";
  auto r = post(c, {{"document_id", "d-big"}, {"text", big}});
  ctx.Equal(r.Status, 413, "a %d-byte text", big.size());
  ctx.Assert(r.Text().find("415-555-0132") == std::string::npos && r.Text().find("lorem") == std::string::npos,
             "the 413 body quotes the payload: %s. An error body is logged and traced; keep it constant", r.Text().substr(0, 200));
  std::string filler;
  while (filler.size() < kCap) filler += "lorem ipsum ";
  const std::string exact = "x@example.com " + filler.substr(0, kCap - 14);
  r = post(c, {{"document_id", "d-cap"}, {"text", exact}, {"entities", nlohmann::json::array({"EMAIL"})}});
  ctx.Equal(r.Status, 200, "a text of exactly 256 KiB");
}

void CheckEntityWhitelist(harness::Ctx& ctx) {
  auto c = api(ctx, true);
  auto r = post(c, {{"document_id", "d-1"}, {"text", kText}, {"entities", nlohmann::json::array({"EMAIL", "PHONE_NUMBER"})}});
  ctx.Equal(r.Status, 400, "an unknown entity type (PHONE_NUMBER) must be rejected, the phone number went back unredacted");
  ctx.Equal(ctx.GRPC.CallsTo("Detect").size(), 0, "the detector was called for a request with an unknown entity type: reject it first; Detect calls");
  ctx.Assert(!store::load("d-1"), "a rejected request must not be saved");
  r = post(c, {{"document_id", "d-2"}, {"text", kText}, {"entities", nlohmann::json::array({"EMAIL"})}});
  ctx.Assert(r.Status == 200 && parsed(r).value("redacted_text", "") == "Reach Ada at [EMAIL] or 415-555-0132.", "a request for EMAIL only answered %d %s", r.Status, r.Text());
}

void CheckFailClosed(harness::Ctx& ctx) {
  auto c = api(ctx, false);
  auto r = post(c, {{"document_id", "d-1"}, {"text", "Ada Lovelace, ada@example.com"}, {"entities", nlohmann::json::array({"EMAIL", "PERSON"})}});
  ctx.Equal(r.Status, 503, "with the detector down and PERSON requested (no pattern covers it)");
  ctx.Assert(r.Text().find("ada@example.com") == std::string::npos && r.Text().find("Lovelace") == std::string::npos, "the 503 body carries the customer text: %s", r.Text());
  ctx.Equal(parsed(r), nlohmann::json({{"error", "detector_unavailable"}}), "the 503 body");
  ctx.Assert(!store::load("d-1"), "a request that could not be redacted must not be saved");
  r = post(c, {{"document_id", "d-2"}, {"text", kText}});
  ctx.Assert(r.Status == 200 && parsed(r).value("degraded", false), "with the detector down and only pattern types requested, the regex fallback answers a degraded 200; got %d %s", r.Status, r.Text());
}

void CheckProcessed(harness::Ctx& ctx) {
  auto c = api(ctx, true);
  const std::string clean = "Nothing personal in this sentence.";
  const auto r = post(c, {{"document_id", "d-clean"}, {"text", clean}});
  ctx.Equal(r.Status, 200, "a text with nothing to redact (%s)", r.Text());
  const auto body = parsed(r);
  ctx.Equal(body.value("status", ""), "processed", "a text with nothing to redact must answer status processed (%s); the status", r.Text());
  ctx.Equal(body.value("spans", nlohmann::json()), nlohmann::json::array(), "the spans of a text with nothing to redact");
  ctx.Equal(body.value("entity_counts", nlohmann::json()), nlohmann::json::object(), "the entity counts of a text with nothing to redact");
  ctx.Equal(body.value("redacted_text", ""), clean, "the redacted text");
  ctx.Equal(body.value("detector_version", ""), "ner-2026.10", "the answer must name the detector version");
  const auto saved = store::load("d-clean");
  ctx.Assert(saved && saved->spans.empty(), "a text with nothing to redact must be saved like any other (the audit read shows it was processed)");
}
`,
  },
  hints: [
    'Stop the detector and redact a text with a name in it: the answer is 200 and carries the text as it came in. Send 300 KiB: the 413 quotes its first line back.',
    'The handler catches `DetectorUnavailable` and answers the input; the 413 body slices the payload; `entities` reaches `detect` unchecked; and a detection with no spans returns before `store.save` with status `clean`.',
    'Answer 413 `{"error": "text_too_large"}`; 400 when an entity is not in `ENTITY_TYPES`, before `detect`; 503 `{"error": "detector_unavailable"}` on `DetectorUnavailable`; drop the no-match return so every detection is saved and answered as `processed`.',
  ],
  debrief: `Every guard returns before the detector is called, and every error body is a constant: an error path is logged, traced and retried more often than the happy path, so it is the last place a payload may appear. Failing closed is the shape the outage takes: when no detector can vouch for the text, the request cannot be served, and a 503 is the only honest answer. Saving the clean result is what makes "processed with zero spans" a fact the audit read can show, distinct from "never ran". Production redactors also scrub the text from exception messages and metric labels, cap the request body at the proxy before the handler parses it, and alert on the 503 rate so an outage is seen as one.`,
};
