import type {Step} from '@/lib/types';

export const summarizerEndpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/summaries: a byte cap, a band the text cannot pick, one summary per key',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'rules', 'store'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/summaries\` with body
\`{"source_ref", "content", "band"}\`: it requires \`X-Tenant-Id\` (**401**), picks the band, and
writes the source's extractive lead through \`store.create_summary\` (\`summarizer.store\`,
provided), answering **201** with \`summary_id\`, \`source_hash\`, \`band\`, \`target_words\`, \`kind\`
and \`summary\`. It serves the demo and hides three flaws.

**Failure mode the checks target.** A 4 MB filing goes straight into the summarizer; a document
that says "TL;DR" picks its own length over the caller's band; and a client that retries after a
timeout gets a second summary and a second bill.

- \`content\` is capped at \`MAX_SOURCE_BYTES\` = 1 MiB of UTF-8 (\`1 << 20\`); a larger one is **413**
  with \`chunking\` = \`/v1/sources/{source_ref}/chunks\` and \`chunk_bytes\` = \`CHUNK_BYTES\` (65536).
- The band is the request's, checked against \`BAND_TARGETS\` (short 100, medium 250, long 600
  words): an unknown band is **400**, and nothing in the text changes it.
- \`Idempotency-Key\` is required (**400**). Look \`(tenant, key)\` up with \`store.replay\` first and
  answer the recorded response with **200** and \`"replayed": true\`; record a new one with
  \`store.remember\`.`,
  sequence: {
    participants: ['Client', 'Summarizer', 'Band rules', 'Summary store'],
    messages: [
      {from: 'Client', to: 'Summarizer', label: 'POST /v1/summaries · X-Tenant-Id · Idempotency-Key', kind: 'sync'},
      {from: 'Summarizer', to: 'Summary store', label: 'replay(tenant, key) → recorded / none', kind: 'sync'},
      {from: 'Summarizer', to: 'Summarizer', label: 'UTF-8 bytes > 1 MiB → 413 · chunking', kind: 'sync'},
      {from: 'Summarizer', to: 'Band rules', label: 'BAND_TARGETS[band] · unknown → 400', kind: 'sync'},
      {from: 'Summarizer', to: 'Summary store', label: 'create_summary(...) · remember(tenant, key)', kind: 'sync'},
      {from: 'Summarizer', to: 'Client', label: '201 {summary_id, band, target_words, summary}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/summaries',
      detail: 'Register `POST /v1/summaries`; a request without `X-Tenant-Id` is **401**.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/summaries["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/summaries['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/summaries"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"summaries"\s*\)/, /\bpost\b/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/summaries"/]},
      },
    },
    {
      id: 'source-cap',
      title: 'Caps the source at 1 MiB of UTF-8 with a pointer to the chunked path',
      detail:
        'A source over `MAX_SOURCE_BYTES` (1 MiB, counted in UTF-8 bytes) is **413** naming `chunking` and `chunk_bytes`, and nothing is summarized; the starter takes any size.',
      match: {
        python: {
          all: [
            /MAX_SOURCE_BYTES\s*=\s*(1\s*<<\s*20|1048576|1024\s*\*\s*1024)/,
            /status_code\s*=\s*413/,
            /chunk_bytes/,
            /\.encode\(/,
          ],
        },
        typescript: {
          all: [
            /MAX_SOURCE_BYTES\s*=\s*(1\s*<<\s*20|1048576|1024\s*\*\s*1024)/,
            /code\(\s*413\s*\)/,
            /chunk_bytes/,
            /TextEncoder|byteLength/,
          ],
        },
        go: {
          all: [
            /maxSourceBytes\s*=\s*(1\s*<<\s*20|1048576|1024\s*\*\s*1024)/,
            /StatusRequestEntityTooLarge|\b413\b/,
            /chunk_bytes/,
          ],
        },
        scala: {
          all: [
            /MaxSourceBytes[^=\n]*=\s*(1\s*<<\s*20|1048576|1024\s*\*\s*1024)/,
            /PayloadTooLarge|RequestEntityTooLarge|\b413\b/,
            /chunk_bytes/,
            /getBytes\(/,
          ],
        },
        cpp: {all: [/kMaxSourceBytes\s*=\s*(1\s*<<\s*20|1048576|1024\s*\*\s*1024)/, /\b413\b/, /chunk_bytes/]},
      },
    },
    {
      id: 'band-authority',
      title: 'Takes the band from the request and the platform table, never from the text',
      detail:
        'The band is the request\'s, looked up in `BAND_TARGETS`; an unknown one is **400**. The starter\'s `detect_band` lets a document that says "TL;DR" or "in detail" choose its own length.',
      match: {
        python: {all: [/BAND_TARGETS/, /status_code\s*=\s*400/], none: [/detect_band\(/, /BAND_TARGETS\.get\(/]},
        typescript: {all: [/BAND_TARGETS/, /code\(\s*400\s*\)/], none: [/detectBand\(/, /\?\?\s*250/]},
        go: {all: [/bandTargets\[/, /StatusBadRequest|\b400\b/], none: [/detectBand\(/]},
        scala: {all: [/BandTargets/, /BadRequest/], none: [/detectBand\(/, /getOrElse\(\s*band\s*,\s*250/]},
        cpp: {all: [/kBandTargets/, /\b400\b/], none: [/detectBand\(/]},
      },
    },
    {
      id: 'idempotent-replay',
      title: 'Answers a retried request from its (tenant, Idempotency-Key) record',
      detail:
        '`Idempotency-Key` is required (**400**); `replay` is consulted before `create_summary` and a replay answers the recorded response with `replayed: true`, while a new request is recorded with `remember`. The starter ignores the header, so every retry writes another summary.',
      match: {
        python: {
          all: [/idempotency-key/i, /store\.replay\(/, /store\.remember\(/],
          order: [/store\.replay\(/, /store\.create_summary\(/],
        },
        typescript: {all: [/idempotency-key/i, /\breplay\(/, /\bremember\(/], order: [/\breplay\(/, /createSummary\(/]},
        go: {
          all: [/Idempotency-Key/i, /store\.Replay\(/, /store\.Remember\(/],
          order: [/store\.Replay\(/, /store\.CreateSummary\(/],
        },
        scala: {
          all: [/Idempotency-Key/i, /Store\.replay\(/, /Store\.remember\(/],
          order: [/Store\.replay\(/, /Store\.createSummary\(/],
        },
        cpp: {
          all: [/Idempotency-Key/i, /store::replay\(/, /store::remember\(/],
          order: [/store::replay\(/, /store::createSummary\(/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from summarizer import store  # create_summary, replay, remember

app = FastAPI()

BAND_TARGETS = {"short": 100, "medium": 250, "long": 600}


class SummaryRequest(BaseModel):
    source_ref: str
    content: str
    band: str = "medium"


def detect_band(content: str) -> str | None:
    """The length a document asks for in its own text."""
    lowered = content.lower()
    if "tl;dr" in lowered or "in one sentence" in lowered:
        return "short"
    if "in detail" in lowered:
        return "long"
    return None


@app.post("/v1/summaries")
def submit(body: SummaryRequest, request: Request) -> JSONResponse:
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        return JSONResponse({"error": "X-Tenant-Id is required"}, status_code=401)
    band = detect_band(body.content) or body.band
    record = store.create_summary(tenant, body.source_ref, body.content, band, BAND_TARGETS.get(band, 250))
    fields = ("summary_id", "source_ref", "source_hash", "band", "target_words", "kind", "summary")
    return JSONResponse({**{name: record[name] for name in fields}, "replayed": False}, status_code=201)
`,
      solution: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from summarizer import store  # create_summary, replay, remember

app = FastAPI()

MAX_SOURCE_BYTES = 1 << 20
CHUNK_BYTES = 64 << 10
BAND_TARGETS = {"short": 100, "medium": 250, "long": 600}


class SummaryRequest(BaseModel):
    source_ref: str
    content: str
    band: str = "medium"


@app.post("/v1/summaries")
def submit(body: SummaryRequest, request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        return JSONResponse({"error": "X-Tenant-Id is required"}, status_code=401)
    key = request.headers.get("idempotency-key", "")
    if not key:
        return JSONResponse({"error": "Idempotency-Key is required"}, status_code=400)
    recorded = store.replay(tenant, key)
    if recorded is not None:
        return JSONResponse({**recorded, "replayed": True}, status_code=200)  # the first attempt's answer
    size = len(body.content.encode("utf-8"))
    if size > MAX_SOURCE_BYTES:
        return JSONResponse(
            {
                "error": "source over 1 MiB",
                "source_bytes": size,
                "chunking": f"/v1/sources/{body.source_ref}/chunks",
                "chunk_bytes": CHUNK_BYTES,
            },
            status_code=413,
        )
    # The band is the caller's, checked against the platform table; the text has no say in it.
    if body.band not in BAND_TARGETS:
        return JSONResponse({"error": f"unknown band {body.band}", "bands": sorted(BAND_TARGETS)}, status_code=400)
    record = store.create_summary(tenant, body.source_ref, body.content, body.band, BAND_TARGETS[body.band])
    fields = ("summary_id", "source_ref", "source_hash", "band", "target_words", "kind", "summary")
    response = {**{name: record[name] for name in fields}, "replayed": False}
    store.remember(tenant, key, response)
    return JSONResponse(response, status_code=201)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {createSummary, remember, replay} from 'summarizer/store';

// Bodies up to 2 MiB reach the handler, which applies the source cap itself.
export const app = Fastify({bodyLimit: 2 * 1024 * 1024});

export const BAND_TARGETS: Record<string, number> = {short: 100, medium: 250, long: 600};

interface SummaryRequest {
  source_ref: string;
  content: string;
  band?: string;
}

/** The length a document asks for in its own text. */
export function detectBand(content: string): string | null {
  const lowered = content.toLowerCase();
  if (lowered.includes('tl;dr') || lowered.includes('in one sentence')) return 'short';
  if (lowered.includes('in detail')) return 'long';
  return null;
}

app.post('/v1/summaries', async (request, reply) => {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {source_ref, content, band: asked = 'medium'} = request.body as SummaryRequest;
  const band = detectBand(content) ?? asked;
  const r = await createSummary(tenant, source_ref, content, band, BAND_TARGETS[band] ?? 250);
  const {summary_id, source_hash, target_words, kind, summary} = r;
  return reply.code(201).send({summary_id, source_ref, source_hash, band, target_words, kind, summary, replayed: false});
});
`,
      solution: `import Fastify from 'fastify';

import {createSummary, remember, replay} from 'summarizer/store';

// Bodies up to 2 MiB reach the handler, which applies the source cap itself.
export const app = Fastify({bodyLimit: 2 * 1024 * 1024});

export const MAX_SOURCE_BYTES = 1 << 20;
export const CHUNK_BYTES = 64 << 10;
export const BAND_TARGETS: Record<string, number> = {short: 100, medium: 250, long: 600};

interface SummaryRequest {
  source_ref: string;
  content: string;
  band?: string;
}

app.post('/v1/summaries', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key === '') return reply.code(400).send({error: 'Idempotency-Key is required'});
  const recorded = await replay(tenant, key);
  if (recorded !== null) return reply.code(200).send({...recorded, replayed: true}); // the first attempt's answer
  const {source_ref, content, band = 'medium'} = request.body as SummaryRequest;
  const size = new TextEncoder().encode(content).length;
  if (size > MAX_SOURCE_BYTES) {
    return reply
      .code(413)
      .send({error: 'source over 1 MiB', source_bytes: size, chunking: \`/v1/sources/\${source_ref}/chunks\`, chunk_bytes: CHUNK_BYTES});
  }
  // The band is the caller's, checked against the platform table; the text has no say in it.
  if (!(band in BAND_TARGETS)) return reply.code(400).send({error: \`unknown band \${band}\`, bands: Object.keys(BAND_TARGETS)});
  const r = await createSummary(tenant, source_ref, content, band, BAND_TARGETS[band]);
  const {summary_id, source_hash, target_words, kind, summary} = r;
  const response = {summary_id, source_ref, source_hash, band, target_words, kind, summary, replayed: false};
  await remember(tenant, key, response);
  return reply.code(201).send(response);
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
	"strings"

	"summarizer/store" // store.CreateSummary, Replay, Remember
)

var bandTargets = map[string]int{"short": 100, "medium": 250, "long": 600}

type summaryRequest struct {
	SourceRef string \`json:"source_ref"\`
	Content   string \`json:"content"\`
	Band      string \`json:"band"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

// detectBand is the length a document asks for in its own text.
func detectBand(content string) string {
	lowered := strings.ToLower(content)
	if strings.Contains(lowered, "tl;dr") || strings.Contains(lowered, "in one sentence") {
		return "short"
	}
	if strings.Contains(lowered, "in detail") {
		return "long"
	}
	return ""
}

func submit(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	body := summaryRequest{Band: "medium"}
	json.NewDecoder(r.Body).Decode(&body)
	band := detectBand(body.Content)
	if band == "" {
		band = body.Band
	}
	target, known := bandTargets[band]
	if !known {
		target = 250
	}
	record := store.CreateSummary(r.Context(), tenant, body.SourceRef, body.Content, band, target)
	writeJSON(rw, http.StatusCreated, map[string]any{
		"summary_id": record.SummaryID, "source_ref": record.SourceRef, "source_hash": record.SourceHash, "band": record.Band,
		"target_words": record.TargetWords, "kind": record.Kind, "summary": record.Summary, "replayed": false,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/summaries", submit)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"

	"summarizer/store" // store.CreateSummary, Replay, Remember
)

const (
	maxSourceBytes = 1 << 20
	chunkBytes     = 64 << 10
)

var bandTargets = map[string]int{"short": 100, "medium": 250, "long": 600}

type summaryRequest struct {
	SourceRef string \`json:"source_ref"\`
	Content   string \`json:"content"\`
	Band      string \`json:"band"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func submit(rw http.ResponseWriter, r *http.Request) {
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
	if recorded := store.Replay(r.Context(), tenant, key); recorded != nil {
		recorded["replayed"] = true // the first attempt's answer
		writeJSON(rw, http.StatusOK, recorded)
		return
	}
	body := summaryRequest{Band: "medium"}
	json.NewDecoder(r.Body).Decode(&body)
	if len(body.Content) > maxSourceBytes { // a Go string's length is its UTF-8 bytes
		writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]any{
			"error": "source over 1 MiB", "source_bytes": len(body.Content),
			"chunking": "/v1/sources/" + body.SourceRef + "/chunks", "chunk_bytes": chunkBytes,
		})
		return
	}
	// The band is the caller's, checked against the platform table; the text has no say in it.
	target, known := bandTargets[body.Band]
	if !known {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "unknown band " + body.Band})
		return
	}
	record := store.CreateSummary(r.Context(), tenant, body.SourceRef, body.Content, body.Band, target)
	response := map[string]any{
		"summary_id": record.SummaryID, "source_ref": record.SourceRef, "source_hash": record.SourceHash, "band": record.Band,
		"target_words": record.TargetWords, "kind": record.Kind, "summary": record.Summary, "replayed": false,
	}
	store.Remember(r.Context(), tenant, key, response)
	writeJSON(rw, http.StatusCreated, response)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/summaries", submit)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import summarizer.Store // Store.createSummary, replay, remember

object Api {
  val BandTargets: Map[String, Int] = Map("short" -> 100, "medium" -> 250, "long" -> 600)

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def field(body: Map[String, JsValue], name: String, default: String): String =
    body.get(name).collect { case JsString(s) => s }.getOrElse(default)

  /** The length a document asks for in its own text. */
  def detectBand(content: String): Option[String] = {
    val lowered = content.toLowerCase
    if (lowered.contains("tl;dr") || lowered.contains("in one sentence")) Some("short")
    else if (lowered.contains("in detail")) Some("long")
    else None
  }

  private def submit(tenant: String, body: Map[String, JsValue]): HttpResponse = {
    // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    val content = field(body, "content", "")
    val band = detectBand(content).getOrElse(field(body, "band", "medium"))
    if (tenant.isEmpty) json(StatusCodes.Unauthorized, JsObject("error" -> JsString("X-Tenant-Id is required")))
    else {
      val record = Store.createSummary(tenant, field(body, "source_ref", ""), content, band, BandTargets.getOrElse(band, 250))
      val view = Store.toJson(record).fields.filter { case (name, _) => Set("summary_id", "source_ref", "source_hash", "band", "target_words", "kind", "summary")(name) }
      json(StatusCodes.Created, JsObject(view + ("replayed" -> JsFalse)))
    }
  }

  val route: Route = path("v1" / "summaries") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") { tenant =>
        entity(as[String]) { raw =>
          complete(submit(tenant.getOrElse(""), raw.parseJson.asJsObject.fields))
        }
      }
    }
  }
}
`,
      solution: `import java.nio.charset.StandardCharsets.UTF_8

import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import summarizer.Store // Store.createSummary, replay, remember

object Api {
  val MaxSourceBytes: Int = 1 << 20
  val ChunkBytes: Int = 64 << 10
  val BandTargets: Map[String, Int] = Map("short" -> 100, "medium" -> 250, "long" -> 600)

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def field(body: Map[String, JsValue], name: String, default: String): String =
    body.get(name).collect { case JsString(s) => s }.getOrElse(default)

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  private def submit(tenant: String, key: String, body: Map[String, JsValue]): HttpResponse = {
    val sourceRef = field(body, "source_ref", "")
    val content = field(body, "content", "")
    val band = field(body, "band", "medium")
    val size = content.getBytes(UTF_8).length
    if (tenant.isEmpty) error(StatusCodes.Unauthorized, "X-Tenant-Id is required")
    else if (key.isEmpty) error(StatusCodes.BadRequest, "Idempotency-Key is required")
    else
      Store.replay(tenant, key) match {
        case Some(recorded) => json(StatusCodes.OK, JsObject(recorded.fields + ("replayed" -> JsTrue))) // the first attempt's answer
        case None if size > MaxSourceBytes =>
          json(StatusCodes.PayloadTooLarge, JsObject(
            "error" -> JsString("source over 1 MiB"),
            "source_bytes" -> JsNumber(size),
            "chunking" -> JsString(s"/v1/sources/$sourceRef/chunks"),
            "chunk_bytes" -> JsNumber(ChunkBytes)))
        // The band is the caller's, checked against the platform table; the text has no say in it.
        case None if !BandTargets.contains(band) => error(StatusCodes.BadRequest, s"unknown band $band")
        case None =>
          val record = Store.createSummary(tenant, sourceRef, content, band, BandTargets(band))
          val view = Store.toJson(record).fields.filter { case (name, _) => Set("summary_id", "source_ref", "source_hash", "band", "target_words", "kind", "summary")(name) }
          val response = JsObject(view + ("replayed" -> JsFalse))
          Store.remember(tenant, key, response)
          json(StatusCodes.Created, response)
      }
  }

  val route: Route = path("v1" / "summaries") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") { tenant =>
        optionalHeaderValueByName("Idempotency-Key") { key =>
          entity(as[String]) { raw =>
            complete(submit(tenant.getOrElse(""), key.getOrElse(""), raw.parseJson.asJsObject.fields))
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

#include <algorithm>
#include <cctype>
#include <map>
#include <string>

#include "summarizer/store.h"  // summarizer::store::createSummary, replay, remember

using json = nlohmann::json;
namespace store = summarizer::store;

const std::map<std::string, long> kBandTargets = {{"short", 100}, {"medium", 250}, {"long", 600}};

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

// The length a document asks for in its own text.
std::string detectBand(std::string content) {
  std::transform(content.begin(), content.end(), content.begin(), [](unsigned char c) { return std::tolower(c); });
  if (content.find("tl;dr") != std::string::npos || content.find("in one sentence") != std::string::npos) return "short";
  if (content.find("in detail") != std::string::npos) return "long";
  return "";
}

void submit(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, {{"error", "X-Tenant-Id is required"}});
  const json body = json::parse(req.body);
  const std::string content = body.value("content", "");
  std::string band = detectBand(content);
  if (band.empty()) band = body.value("band", "medium");
  const auto target = kBandTargets.find(band);
  const json record = store::createSummary(tenant, body.value("source_ref", ""), content, band, target == kBandTargets.end() ? 250 : target->second);
  json response = json::object();
  for (const char* name : {"summary_id", "source_ref", "source_hash", "band", "target_words", "kind", "summary"}) response[name] = record[name];
  response["replayed"] = false;
  reply(res, 201, response);
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/summaries", submit); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <map>
#include <string>

#include "summarizer/store.h"  // summarizer::store::createSummary, replay, remember

using json = nlohmann::json;
namespace store = summarizer::store;

const long kMaxSourceBytes = 1 << 20;
const long kChunkBytes = 64 << 10;
const std::map<std::string, long> kBandTargets = {{"short", 100}, {"medium", 250}, {"long", 600}};

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void submit(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, {{"error", "X-Tenant-Id is required"}});
  const std::string key = req.get_header_value("Idempotency-Key");
  if (key.empty()) return reply(res, 400, {{"error", "Idempotency-Key is required"}});
  if (auto recorded = store::replay(tenant, key)) {
    (*recorded)["replayed"] = true;  // the first attempt's answer
    return reply(res, 200, *recorded);
  }
  const json body = json::parse(req.body);
  const std::string source_ref = body.value("source_ref", "");
  const std::string content = body.value("content", "");
  const std::string band = body.value("band", "medium");
  if (static_cast<long>(content.size()) > kMaxSourceBytes) {  // std::string holds the UTF-8 bytes
    return reply(res, 413, {{"error", "source over 1 MiB"},
                            {"source_bytes", content.size()},
                            {"chunking", "/v1/sources/" + source_ref + "/chunks"},
                            {"chunk_bytes", kChunkBytes}});
  }
  // The band is the caller's, checked against the platform table; the text has no say in it.
  const auto target = kBandTargets.find(band);
  if (target == kBandTargets.end()) return reply(res, 400, {{"error", "unknown band " + band}});
  const json record = store::createSummary(tenant, source_ref, content, band, target->second);
  json response = json::object();
  for (const char* name : {"summary_id", "source_ref", "source_hash", "band", "target_words", "kind", "summary"}) response[name] = record[name];
  response["replayed"] = false;
  store::remember(tenant, key, response);
  reply(res, 201, response);
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/summaries", submit); }
`,
    },
  },
  harness: {
    python: `from summarizer import store

DOC = "The board met on 3 March. Revenue rose four percent in the quarter.\\n\\nThe audit committee approved the accounts. Two directors stepped down."
BIG = "Line of the filing. " * 52429  # 1,048,580 bytes: four over the cap
WIDE = "R\\u00e9sum\\u00e9. " * 110000  # 880,000 characters, 1,100,000 UTF-8 bytes


def _headers(key="k-1", tenant="t1"):
    return {"X-Tenant-Id": tenant, "Idempotency-Key": key}


def _api(ctx):
    return ctx.client(ctx.load("api").app)


async def _submit(c, content=DOC, band="medium", headers=None):
    return await c.post("/v1/summaries", json={"source_ref": "doc-1", "content": content, "band": band}, headers=_headers() if headers is None else headers)


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await _submit(c)
        assert r.status_code in (200, 201), f"POST /v1/summaries answered {r.status_code}: {r.text}"
        body = r.json()
        assert body.get("band") == "medium" and body.get("target_words") == 250, f"a medium request must answer band medium with 250 target words, got {body}"
        assert str(body.get("summary", "")).startswith("The board met on 3 March."), f"the summary must be the source's lead, got {body.get('summary')!r}"
        assert store.load_summary("t1", body.get("summary_id", "")) is not None, f"no summary {body.get('summary_id')!r} is stored for t1"
        anon = await _submit(c, headers={"Idempotency-Key": "k-2"})
    assert anon.status_code == 401, f"a request without X-Tenant-Id answered {anon.status_code}, expected 401"


async def check_source_cap(ctx):
    async with _api(ctx) as c:
        r = await _submit(c, content=BIG)
        assert r.status_code == 413, f"a {len(BIG)}-byte source answered {r.status_code}: past 1 MiB a source belongs on the chunked path, expected 413"
        assert "/v1/sources/doc-1/chunks" in r.text and "65536" in r.text, f"the 413 must name the chunked path /v1/sources/doc-1/chunks and chunk_bytes 65536, got {r.text[:300]}"
        r = await _submit(c, content=WIDE, headers=_headers("k-2"))
        assert r.status_code == 413, f"a source of {len(WIDE)} characters but {len(WIDE.encode())} UTF-8 bytes answered {r.status_code}: the cap counts bytes, not characters"
        assert ctx.redis.get("summary:seq") is None, "a source over the cap was summarized anyway"
        ok = await _submit(c, headers=_headers("k-3"))
    assert ok.status_code in (200, 201), f"a small source answered {ok.status_code}: {ok.text}"


async def check_band_authority(ctx):
    async with _api(ctx) as c:
        r = await _submit(c, content="TL;DR: keep this to one line. " + DOC, band="long")
        body = r.json()
        assert body.get("band") == "long" and body.get("target_words") == 600, f"a long request whose text says TL;DR answered {body.get('band')} / {body.get('target_words')} words: the text chose its own length. Expected long, 600"
        r = await _submit(c, content="Explain in detail. " + DOC, band="short", headers=_headers("k-2"))
        body = r.json()
        assert body.get("band") == "short" and body.get("target_words") == 100, f"a short request whose text says 'in detail' answered {body.get('band')} / {body.get('target_words')} words, expected short, 100"
        r = await _submit(c, band="huge", headers=_headers("k-3"))
        assert r.status_code == 400, f"an unknown band answered {r.status_code}, expected 400"
    assert ctx.redis.get("summary:seq") == "2", f"{ctx.redis.get('summary:seq')} summaries were written, expected 2: an unknown band writes none"


async def check_idempotent_replay(ctx):
    async with _api(ctx) as c:
        first = await _submit(c)
        assert first.status_code in (200, 201), f"the first request answered {first.status_code}: {first.text}"
        retry = await _submit(c)
        assert retry.status_code == 200 and retry.json().get("replayed") is True, f"a retry with the same Idempotency-Key answered {retry.status_code} {retry.text}, expected 200 with replayed true"
        assert retry.json().get("summary_id") == first.json().get("summary_id"), f"the retry answered summary {retry.json().get('summary_id')}, the first {first.json().get('summary_id')}"
        assert ctx.redis.get("summary:seq") == "1", f"two requests with one key wrote {ctx.redis.get('summary:seq')} summaries: each retry is billed again"
        other = await _submit(c, headers=_headers("k-1", "t2"))
        assert other.status_code in (200, 201) and other.json().get("summary_id") != first.json().get("summary_id"), f"another tenant's request with the same key must get its own summary, got {other.status_code} {other.text}"
        missing = await _submit(c, headers={"X-Tenant-Id": "t1"})
    assert missing.status_code == 400, f"a request without Idempotency-Key answered {missing.status_code}, expected 400"
`,
    typescript: `const DOC = 'The board met on 3 March. Revenue rose four percent in the quarter.\\n\\nThe audit committee approved the accounts. Two directors stepped down.';
const BIG = 'Line of the filing. '.repeat(52429); // 1,048,580 bytes: four over the cap
const WIDE = 'R\\u00e9sum\\u00e9. '.repeat(110000); // 880,000 characters, 1,100,000 UTF-8 bytes

const keyed = (key: string, tenant = 't1') => ({'X-Tenant-Id': tenant, 'Idempotency-Key': key});

function api(ctx) {
  return {c: ctx.client(ctx.load('api').app), store: ctx.load('/support/summarizer/store.ts')};
}

function submit(c, content: string, band: string, headers: Record<string, string>) {
  return c.post('/v1/summaries', {json: {source_ref: 'doc-1', content, band}, headers});
}

export async function check_route(ctx) {
  const {c, store} = api(ctx);
  const r = await submit(c, DOC, 'medium', keyed('k-1'));
  assert(r.status === 200 || r.status === 201, \`POST /v1/summaries answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.band === 'medium' && body.target_words === 250, \`a medium request must answer band medium with 250 target words, got \${r.text}\`);
  assert(String(body.summary).startsWith('The board met on 3 March.'), \`the summary must be the source's lead, got \${JSON.stringify(body.summary)}\`);
  assert((await store.loadSummary('t1', body.summary_id)) !== null, \`no summary \${body.summary_id} is stored for t1\`);
  const anon = await submit(c, DOC, 'medium', {'Idempotency-Key': 'k-2'});
  assert.equal(anon.status, 401, \`a request without X-Tenant-Id answered \${anon.status}, expected 401\`);
}

export async function check_source_cap(ctx) {
  const {c} = api(ctx);
  let r = await submit(c, BIG, 'medium', keyed('k-1'));
  assert.equal(r.status, 413, \`a \${BIG.length}-byte source answered \${r.status}: past 1 MiB a source belongs on the chunked path, expected 413\`);
  assert(r.text.includes('/v1/sources/doc-1/chunks') && r.text.includes('65536'), \`the 413 must name the chunked path /v1/sources/doc-1/chunks and chunk_bytes 65536, got \${r.text.slice(0, 300)}\`);
  r = await submit(c, WIDE, 'medium', keyed('k-2'));
  assert.equal(r.status, 413, \`a source of \${WIDE.length} characters but 1,100,000 UTF-8 bytes answered \${r.status}: the cap counts bytes, not characters\`);
  assert.equal(ctx.redis.get('summary:seq'), null, 'a source over the cap was summarized anyway');
  const ok = await submit(c, DOC, 'medium', keyed('k-3'));
  assert(ok.status === 200 || ok.status === 201, \`a small source answered \${ok.status}: \${ok.text}\`);
}

export async function check_band_authority(ctx) {
  const {c} = api(ctx);
  let body = (await submit(c, 'TL;DR: keep this to one line. ' + DOC, 'long', keyed('k-1'))).json();
  assert(body.band === 'long' && body.target_words === 600, \`a long request whose text says TL;DR answered \${body.band} / \${body.target_words} words: the text chose its own length. Expected long, 600\`);
  body = (await submit(c, 'Explain in detail. ' + DOC, 'short', keyed('k-2'))).json();
  assert(body.band === 'short' && body.target_words === 100, \`a short request whose text says 'in detail' answered \${body.band} / \${body.target_words} words, expected short, 100\`);
  const r = await submit(c, DOC, 'huge', keyed('k-3'));
  assert.equal(r.status, 400, \`an unknown band answered \${r.status}, expected 400\`);
  assert.equal(ctx.redis.get('summary:seq'), '2', \`\${ctx.redis.get('summary:seq')} summaries were written, expected 2: an unknown band writes none\`);
}

export async function check_idempotent_replay(ctx) {
  const {c} = api(ctx);
  const first = await submit(c, DOC, 'medium', keyed('k-1'));
  assert(first.status === 200 || first.status === 201, \`the first request answered \${first.status}: \${first.text}\`);
  const retry = await submit(c, DOC, 'medium', keyed('k-1'));
  assert(retry.status === 200 && retry.json().replayed === true, \`a retry with the same Idempotency-Key answered \${retry.status} \${retry.text}, expected 200 with replayed true\`);
  assert.equal(retry.json().summary_id, first.json().summary_id, 'the retry must answer the first summary id');
  assert.equal(ctx.redis.get('summary:seq'), '1', \`two requests with one key wrote \${ctx.redis.get('summary:seq')} summaries: each retry is billed again\`);
  const other = await submit(c, DOC, 'medium', keyed('k-1', 't2'));
  assert((other.status === 200 || other.status === 201) && other.json().summary_id !== first.json().summary_id, \`another tenant's request with the same key must get its own summary, got \${other.status} \${other.text}\`);
  const missing = await submit(c, DOC, 'medium', {'X-Tenant-Id': 't1'});
  assert.equal(missing.status, 400, \`a request without Idempotency-Key answered \${missing.status}, expected 400\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"strings"

	"summarizer/store"

	"leetbuild/harness"
)

const apiDoc = "The board met on 3 March. Revenue rose four percent in the quarter.\\n\\nThe audit committee approved the accounts. Two directors stepped down."

type submitted struct {
	SummaryID   string \`json:"summary_id"\`
	Band        string \`json:"band"\`
	TargetWords int    \`json:"target_words"\`
	Summary     string \`json:"summary"\`
	Replayed    bool   \`json:"replayed"\`
}

func apiClient(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func postSummary(c *harness.HTTP, content, band string, header ...string) *harness.Response {
	return c.Post("/v1/summaries", map[string]string{"source_ref": "doc-1", "content": content, "band": band}, header...)
}

func keyed(key, tenant string) []string { return []string{"X-Tenant-Id", tenant, "Idempotency-Key", key} }

func decoded(r *harness.Response) submitted {
	var s submitted
	r.Decode(&s)
	return s
}

func seq(ctx *harness.Ctx) string {
	n, _ := ctx.Redis.Get("summary:seq")
	return n
}

func CheckRoute(ctx *harness.Ctx) {
	c := apiClient(ctx)
	r := postSummary(c, apiDoc, "medium", keyed("k-1", "t1")...)
	ctx.Assert(r.Status == 200 || r.Status == 201, "POST /v1/summaries answered %d: %s", r.Status, r.Text())
	body := decoded(r)
	ctx.Assert(body.Band == "medium" && body.TargetWords == 250, "a medium request must answer band medium with 250 target words, got %s", r.Text())
	ctx.Assert(strings.HasPrefix(body.Summary, "The board met on 3 March."), "the summary must be the source's lead, got %q", body.Summary)
	ctx.Assert(store.LoadSummary(context.Background(), "t1", body.SummaryID) != nil, "no summary %q is stored for t1", body.SummaryID)
	anon := postSummary(c, apiDoc, "medium", "Idempotency-Key", "k-2")
	ctx.Equal(anon.Status, 401, "a request without X-Tenant-Id")
}

func CheckSourceCap(ctx *harness.Ctx) {
	c := apiClient(ctx)
	big := strings.Repeat("Line of the filing. ", 52429)
	r := postSummary(c, big, "medium", keyed("k-1", "t1")...)
	ctx.Equal(r.Status, 413, "a %d-byte source (past 1 MiB a source belongs on the chunked path)", len(big))
	ctx.Assert(strings.Contains(r.Text(), "/v1/sources/doc-1/chunks") && strings.Contains(r.Text(), "65536"), "the 413 must name the chunked path /v1/sources/doc-1/chunks and chunk_bytes 65536, got %.300s", r.Text())
	wide := strings.Repeat("R\\u00e9sum\\u00e9. ", 110000)
	r = postSummary(c, wide, "medium", keyed("k-2", "t1")...)
	ctx.Equal(r.Status, 413, "a source of 880,000 characters but %d UTF-8 bytes (the cap counts bytes, not characters)", len(wide))
	ctx.Equal(seq(ctx), "", "a source over the cap was summarized anyway; summary:seq")
	ok := postSummary(c, apiDoc, "medium", keyed("k-3", "t1")...)
	ctx.Assert(ok.Status == 200 || ok.Status == 201, "a small source answered %d: %s", ok.Status, ok.Text())
}

func CheckBandAuthority(ctx *harness.Ctx) {
	c := apiClient(ctx)
	body := decoded(postSummary(c, "TL;DR: keep this to one line. "+apiDoc, "long", keyed("k-1", "t1")...))
	ctx.Assert(body.Band == "long" && body.TargetWords == 600, "a long request whose text says TL;DR answered %s / %d words: the text chose its own length. Expected long, 600", body.Band, body.TargetWords)
	body = decoded(postSummary(c, "Explain in detail. "+apiDoc, "short", keyed("k-2", "t1")...))
	ctx.Assert(body.Band == "short" && body.TargetWords == 100, "a short request whose text says 'in detail' answered %s / %d words, expected short, 100", body.Band, body.TargetWords)
	r := postSummary(c, apiDoc, "huge", keyed("k-3", "t1")...)
	ctx.Equal(r.Status, 400, "an unknown band")
	ctx.Equal(seq(ctx), "2", "an unknown band must write no summary; summary:seq")
}

func CheckIdempotentReplay(ctx *harness.Ctx) {
	c := apiClient(ctx)
	first := postSummary(c, apiDoc, "medium", keyed("k-1", "t1")...)
	ctx.Assert(first.Status == 200 || first.Status == 201, "the first request answered %d: %s", first.Status, first.Text())
	retry := postSummary(c, apiDoc, "medium", keyed("k-1", "t1")...)
	ctx.Assert(retry.Status == 200 && decoded(retry).Replayed, "a retry with the same Idempotency-Key answered %d %s, expected 200 with replayed true", retry.Status, retry.Text())
	ctx.Equal(decoded(retry).SummaryID, decoded(first).SummaryID, "the retry must answer the first summary id")
	ctx.Equal(seq(ctx), "1", "two requests with one key must write one summary (each retry is billed again); summary:seq")
	other := postSummary(c, apiDoc, "medium", keyed("k-1", "t2")...)
	ctx.Assert((other.Status == 200 || other.Status == 201) && decoded(other).SummaryID != decoded(first).SummaryID, "another tenant's request with the same key must get its own summary, got %d %s", other.Status, other.Text())
	missing := postSummary(c, apiDoc, "medium", "X-Tenant-Id", "t1")
	ctx.Equal(missing.Status, 400, "a request without Idempotency-Key")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>

#include "summarizer/store.h"

namespace {

const std::string kDoc =
    "The board met on 3 March. Revenue rose four percent in the quarter.\\n\\nThe audit committee approved the accounts. Two directors stepped down.";

harness::HTTP apiClient(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response postSummary(harness::HTTP& c, const std::string& content, const std::string& band, const std::string& tenant, const std::string& key) {
  const std::string body = nlohmann::json{{"source_ref", "doc-1"}, {"content", content}, {"band", band}}.dump();
  if (tenant.empty()) return c.Post("/v1/summaries", body, "Content-Type", "application/json", "Idempotency-Key", key);
  if (key.empty()) return c.Post("/v1/summaries", body, "Content-Type", "application/json", "X-Tenant-Id", tenant);
  return c.Post("/v1/summaries", body, "Content-Type", "application/json", "X-Tenant-Id", tenant, "Idempotency-Key", key);
}

nlohmann::json bodyOf(harness::Ctx& ctx, const harness::Response& r) {
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  ctx.Assert(body.is_object(), "the response is not a JSON object: %d %.200s", r.Status, r.Text());
  return body;
}

std::string repeat(const std::string& s, int n) {
  std::string out;
  out.reserve(s.size() * n);
  for (int i = 0; i < n; i++) out += s;
  return out;
}

std::string seq(harness::Ctx& ctx) { return ctx.Redis.Get("summary:seq").value_or(""); }

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = apiClient(ctx);
  const auto r = postSummary(c, kDoc, "medium", "t1", "k-1");
  ctx.Assert(r.Status == 200 || r.Status == 201, "POST /v1/summaries answered %d: %s", r.Status, r.Text());
  const auto body = bodyOf(ctx, r);
  ctx.Assert(body.value("band", "") == "medium" && body.value("target_words", 0L) == 250, "a medium request must answer band medium with 250 target words, got %s", r.Text());
  ctx.Assert(body.value("summary", "").rfind("The board met on 3 March.", 0) == 0, "the summary must be the source's lead, got %q", body.value("summary", ""));
  ctx.Assert(summarizer::store::loadSummary("t1", body.value("summary_id", "")).has_value(), "no summary %q is stored for t1", body.value("summary_id", ""));
  const auto anon = postSummary(c, kDoc, "medium", "", "k-2");
  ctx.Equal(anon.Status, 401, "a request without X-Tenant-Id");
}

void CheckSourceCap(harness::Ctx& ctx) {
  auto c = apiClient(ctx);
  const std::string big = repeat("Line of the filing. ", 52429);
  auto r = postSummary(c, big, "medium", "t1", "k-1");
  ctx.Equal(r.Status, 413, "a %d-byte source (past 1 MiB a source belongs on the chunked path)", big.size());
  ctx.Assert(r.Text().find("/v1/sources/doc-1/chunks") != std::string::npos && r.Text().find("65536") != std::string::npos,
             "the 413 must name the chunked path /v1/sources/doc-1/chunks and chunk_bytes 65536, got %.300s", r.Text());
  const std::string wide = repeat("R\\u00e9sum\\u00e9. ", 110000);
  r = postSummary(c, wide, "medium", "t1", "k-2");
  ctx.Equal(r.Status, 413, "a source of 880,000 characters but %d UTF-8 bytes (the cap counts bytes, not characters)", wide.size());
  ctx.Equal(seq(ctx), "", "a source over the cap was summarized anyway; summary:seq");
  const auto ok = postSummary(c, kDoc, "medium", "t1", "k-3");
  ctx.Assert(ok.Status == 200 || ok.Status == 201, "a small source answered %d: %s", ok.Status, ok.Text());
}

void CheckBandAuthority(harness::Ctx& ctx) {
  auto c = apiClient(ctx);
  auto body = bodyOf(ctx, postSummary(c, "TL;DR: keep this to one line. " + kDoc, "long", "t1", "k-1"));
  ctx.Assert(body.value("band", "") == "long" && body.value("target_words", 0L) == 600,
             "a long request whose text says TL;DR answered %s / %d words: the text chose its own length. Expected long, 600", body.value("band", ""), body.value("target_words", 0L));
  body = bodyOf(ctx, postSummary(c, "Explain in detail. " + kDoc, "short", "t1", "k-2"));
  ctx.Assert(body.value("band", "") == "short" && body.value("target_words", 0L) == 100,
             "a short request whose text says 'in detail' answered %s / %d words, expected short, 100", body.value("band", ""), body.value("target_words", 0L));
  const auto r = postSummary(c, kDoc, "huge", "t1", "k-3");
  ctx.Equal(r.Status, 400, "an unknown band");
  ctx.Equal(seq(ctx), "2", "an unknown band must write no summary; summary:seq");
}

void CheckIdempotentReplay(harness::Ctx& ctx) {
  auto c = apiClient(ctx);
  const auto first = postSummary(c, kDoc, "medium", "t1", "k-1");
  ctx.Assert(first.Status == 200 || first.Status == 201, "the first request answered %d: %s", first.Status, first.Text());
  const auto retry = postSummary(c, kDoc, "medium", "t1", "k-1");
  ctx.Assert(retry.Status == 200 && bodyOf(ctx, retry).value("replayed", false), "a retry with the same Idempotency-Key answered %d %s, expected 200 with replayed true", retry.Status, retry.Text());
  ctx.Equal(bodyOf(ctx, retry).value("summary_id", ""), bodyOf(ctx, first).value("summary_id", ""), "the retry must answer the first summary id");
  ctx.Equal(seq(ctx), "1", "two requests with one key must write one summary (each retry is billed again); summary:seq");
  const auto other = postSummary(c, kDoc, "medium", "t2", "k-1");
  ctx.Assert((other.Status == 200 || other.Status == 201) && bodyOf(ctx, other).value("summary_id", "") != bodyOf(ctx, first).value("summary_id", ""),
             "another tenant's request with the same key must get its own summary, got %d %s", other.Status, other.Text());
  const auto missing = postSummary(c, kDoc, "medium", "t1", "");
  ctx.Equal(missing.Status, 400, "a request without Idempotency-Key");
}
`,
  },
  hints: [
    'Submit a 4 MB filing and it is summarized like any other; send "TL;DR" at the top of a long request and the answer has 100 target words; retry the same request and a second summary id comes back.',
    'Nothing measures the body before `create_summary`; `detect_band` reads the document before the band field is consulted; and the handler never reads `Idempotency-Key`, so each request is new to it.',
    'Read the key (400 if missing) and answer `store.replay(tenant, key)` with `replayed: true`; 413 when the UTF-8 bytes exceed `MAX_SOURCE_BYTES`; 400 unless `body.band` is in `BAND_TARGETS`; `store.remember` the response.',
  ],
  debrief: `The cap counts UTF-8 bytes because bytes are what the model and the queue pay for, and the 413 names the chunked path so a client has somewhere to go instead of a dead end. The band is a policy the caller chooses within a platform table; letting the document choose it is the smallest prompt injection there is, since text the service only reads ends up steering it. The replay lookup happens before any work, so a retry costs one Redis read. A production service keeps the idempotency record with an expiry, stores a fingerprint of the request body so a reused key with a different document is refused, and meters the bytes per tenant before the cap ever applies.`,
};
