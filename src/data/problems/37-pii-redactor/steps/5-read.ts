import type {Step} from '@/lib/types';

export const readRedactionStep: Step = {
  id: 'read',
  title: 'GET /v1/documents/{id}/redaction: spans for the owner, no text',
  concept: 'http',
  guides: ['request-boundaries', 'honest-reads'],
  file: 'read',
  focus: ['client', 'redactor', 'redis'],
  task: `## Task

**Starting point.** The starter serves the audit read \`GET /v1/documents/{document_id}/redaction\`:
it loads the redaction with \`store.load\` (provided; it returns the record whichever tenant owns
it) and answers \`{document_id, entity_counts, detector_version, redacted_text}\`, or \`{}\` when there
is none. It serves the demo and hides four flaws.

**Failure mode the checks target.** Any caller reads any tenant's record; a document that does not
exist answers 200; the read hands back the stored output, a second and less guarded copy of the
customer's text; and without offsets nobody can check a redaction against the output they hold.

- The tenant comes from \`X-Tenant-Id\` (**401** when absent). Another tenant's record answers
  exactly what a missing one does: **404**.
- The answer is \`{document_id, spans, entity_types, entity_counts, detector_version,
  redacted_length}\`: spans as \`{start, end, entity, replacement}\`, \`entity_types\` sorted,
  \`redacted_length\` the length of the stored output, and no text.
- With the spans, a caller holding the redacted output finds every replacement in it: each sits at
  its \`start\` plus what the earlier replacements added to the length.`,
  sequence: {
    participants: ['Client', 'Redactor', 'Redis'],
    messages: [
      {from: 'Client', to: 'Redactor', label: 'GET /v1/documents/d-1/redaction · X-Tenant-Id', kind: 'sync'},
      {from: 'Redactor', to: 'Redactor', label: '401 without a tenant', kind: 'sync'},
      {from: 'Redactor', to: 'Redis', label: 'store.load(d-1) → doc:d-1', kind: 'sync'},
      {from: 'Redis', to: 'Redactor', label: 'record · or none', kind: 'reply'},
      {from: 'Redactor', to: 'Client', label: '404 for missing or foreign, the same body', kind: 'reply'},
      {
        from: 'Redactor',
        to: 'Client',
        label: '200 {spans, entity_types, entity_counts, redacted_length}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Serves the audit read for the owner',
      detail:
        "Register `GET /v1/documents/{document_id}/redaction` and answer the owner's record through `store.load`, with its `document_id`, `entity_counts` and `detector_version`.",
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/documents\/\{document_id\}\/redaction["']/, /store\.load\(/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/documents\/:\w+\/redaction['"]/, /\bload\(/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/documents\/\{\w+\}\/redaction"/, /store\.Load\(/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"documents"\s*\/\s*Segment\s*\/\s*"redaction"\s*\)/, /Store\.load\(/]},
        cpp: {all: [/svr\.Get\(R"\(\/v1\/documents\//, /store::load\(/]},
      },
    },
    {
      id: 'tenant-scope',
      title: "Another tenant's record is 404, like a missing one",
      detail:
        "The tenant comes from `X-Tenant-Id` (401 when absent) and a record owned by another tenant answers the same 404 as a missing one; the starter does not read the header, so any caller reads any tenant's audit record.",
      match: {
        python: {all: [/x-tenant-id/i, /\.tenant\s*!=\s*tenant|tenant\s*!=\s*\w+\.tenant/]},
        typescript: {all: [/x-tenant-id/i, /\.tenant\s*!==\s*tenant|tenant\s*!==\s*\w+\.tenant/]},
        go: {all: [/X-Tenant-Id/i, /\.Tenant\s*!=\s*tenant|tenant\s*!=\s*\w+\.Tenant/]},
        scala: {all: [/X-Tenant-Id/i, /\.tenant\s*[!=]=\s*tenant|tenant\s*[!=]=\s*\w+\.tenant/]},
        cpp: {all: [/X-Tenant-Id/i, /->tenant\s*!=\s*tenant|tenant\s*!=\s*\w+->tenant/]},
      },
    },
    {
      id: 'not-found',
      title: 'A missing document is 404',
      detail:
        'A document with no record answers **404** (not 403, which would confirm it exists); the starter answers 200 with an empty object, which a client reads as "processed, nothing found".',
      match: {
        python: {all: [/\b404\b/], none: [/return \{\}/, /\b403\b/]},
        typescript: {all: [/\b404\b/], none: [/return \{\};/, /\b403\b/]},
        go: {all: [/StatusNotFound|\b404\b/], none: [/StatusOK,\s*map\[string\]any\{\}/, /StatusForbidden|\b403\b/]},
        scala: {all: [/NotFound|\b404\b/], none: [/JsObject\.empty/, /Forbidden|\b403\b/]},
        cpp: {all: [/\b404\b/], none: [/json::object\(\)/, /\b403\b/]},
      },
    },
    {
      id: 'no-text',
      title: 'The audit read carries no text',
      detail:
        'The response has no `redacted_text` and nothing from the text; the starter returns the stored output, which makes the audit endpoint a second copy of every document, readable by whoever audits.',
      match: {
        python: {none: [/["']redacted_text["']\s*:/]},
        typescript: {none: [/redacted_text:\s*\w+\.redacted_text/]},
        go: {none: [/"redacted_text"/]},
        scala: {none: [/"redacted_text"/]},
        cpp: {none: [/"redacted_text"/]},
      },
    },
    {
      id: 'offsets',
      title: 'Spans and the redacted length let a caller verify the output',
      detail:
        'The answer carries `spans` with their replacements, sorted `entity_types` and `redacted_length`, so a caller holding the redacted output can check every replacement is where the spans say; the starter answers counts only.',
      match: {
        python: {all: [/redacted_length/, /len\(\w+\.redacted_text\)/, /entity_types/, /["']spans["']/]},
        typescript: {all: [/redacted_length:\s*\w+\.redacted_text\.length/, /entity_types/, /spans:/]},
        go: {all: [/"redacted_length"/, /len\(\w+\.RedactedText\)/, /"entity_types"/]},
        scala: {all: [/"redacted_length"/, /redactedText\.length/, /"entity_types"/]},
        cpp: {all: [/"redacted_length"/, /redacted_text\.size\(\)/, /"entity_types"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Request

from redactor import store  # store.load(document_id) -> Redaction | None, whichever tenant owns it

app = FastAPI()


@app.get("/v1/documents/{document_id}/redaction")
def read_redaction(document_id: str, request: Request) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    record = store.load(document_id)
    if record is None:
        return {}
    return {
        "document_id": document_id,
        "entity_counts": record.entity_counts,
        "detector_version": record.detector_version,
        "redacted_text": record.redacted_text,
    }
`,
      solution: `from dataclasses import asdict

from fastapi import FastAPI, HTTPException, Request

from redactor import store  # store.load(document_id) -> Redaction | None, whichever tenant owns it

app = FastAPI()


@app.get("/v1/documents/{document_id}/redaction")
def read_redaction(document_id: str, request: Request) -> dict:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    record = store.load(document_id)
    # Missing and foreign answer alike: anything else tells a caller which documents exist.
    if record is None or record.tenant != tenant:
        raise HTTPException(status_code=404, detail="no such document")
    return {
        "document_id": document_id,
        "spans": [asdict(s) for s in record.spans],
        "entity_types": sorted(record.entity_counts),
        "entity_counts": record.entity_counts,
        "detector_version": record.detector_version,
        "redacted_length": len(record.redacted_text),  # enough to verify the output; the output stays out
    }
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {load} from 'redactor/store'; // load(documentId): Redaction | null, whichever tenant owns it

export const app = Fastify();

app.get('/v1/documents/:document_id/redaction', async request => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const {document_id: documentId} = request.params as {document_id: string};
  const record = await load(documentId);
  if (record === null) return {};
  return {
    document_id: documentId,
    entity_counts: record.entity_counts,
    detector_version: record.detector_version,
    redacted_text: record.redacted_text,
  };
});
`,
      solution: `import Fastify from 'fastify';

import {load} from 'redactor/store'; // load(documentId): Redaction | null, whichever tenant owns it

export const app = Fastify();

app.get('/v1/documents/:document_id/redaction', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {document_id: documentId} = request.params as {document_id: string};
  const record = await load(documentId);
  // Missing and foreign answer alike: anything else tells a caller which documents exist.
  if (record === null || record.tenant !== tenant) return reply.code(404).send({error: 'no such document'});
  return {
    document_id: documentId,
    spans: record.spans,
    entity_types: Object.keys(record.entity_counts).sort(),
    entity_counts: record.entity_counts,
    detector_version: record.detector_version,
    redacted_length: record.redacted_text.length, // enough to verify the output; the output stays out
  };
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"redactor/store" // store.Load(ctx, documentID) (*store.Redaction, error), whichever tenant owns it
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func readRedaction(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	documentID := r.PathValue("document_id")
	record, err := store.Load(r.Context(), documentID)
	if err != nil {
		http.Error(rw, "store unavailable", http.StatusInternalServerError)
		return
	}
	if record == nil {
		writeJSON(rw, http.StatusOK, map[string]any{})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"document_id":      documentID,
		"entity_counts":    record.EntityCounts,
		"detector_version": record.DetectorVersion,
		"redacted_text":    record.RedactedText,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/documents/{document_id}/redaction", readRedaction)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"sort"

	"redactor/store" // store.Load(ctx, documentID) (*store.Redaction, error), whichever tenant owns it
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func readRedaction(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	documentID := r.PathValue("document_id")
	record, err := store.Load(r.Context(), documentID)
	if err != nil {
		http.Error(rw, "store unavailable", http.StatusInternalServerError)
		return
	}
	// Missing and foreign answer alike: anything else tells a caller which documents exist.
	if record == nil || record.Tenant != tenant {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such document"})
		return
	}
	entityTypes := make([]string, 0, len(record.EntityCounts))
	for entity := range record.EntityCounts {
		entityTypes = append(entityTypes, entity)
	}
	sort.Strings(entityTypes)
	writeJSON(rw, http.StatusOK, map[string]any{
		"document_id":      documentID,
		"spans":            record.Spans,
		"entity_types":     entityTypes,
		"entity_counts":    record.EntityCounts,
		"detector_version": record.DetectorVersion,
		"redacted_length":  len(record.RedactedText), // enough to verify the output; the output stays out
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/documents/{document_id}/redaction", readRedaction)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import redactor.{Spans, Store} // Store.load(documentId): Option[Redaction], whichever tenant owns it

object ReadApi {
  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  def read(documentId: String): HttpResponse = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    Store.load(documentId) match {
      case None => json(StatusCodes.OK, JsObject.empty)
      case Some(record) =>
        json(StatusCodes.OK, JsObject(
          "document_id" -> JsString(documentId), "entity_counts" -> Spans.countsJson(record.entityCounts),
          "detector_version" -> JsString(record.detectorVersion), "redacted_text" -> JsString(record.redactedText)))
    }
  }

  val route: Route = path("v1" / "documents" / Segment / "redaction") { documentId =>
    get {
      complete(read(documentId))
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import redactor.{Spans, Store} // Store.load(documentId): Option[Redaction], whichever tenant owns it

object ReadApi {
  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  def read(tenant: String, documentId: String): HttpResponse =
    Store.load(documentId) match {
      case Some(record) if record.tenant == tenant =>
        json(StatusCodes.OK, JsObject(
          "document_id" -> JsString(documentId),
          "spans" -> JsArray(record.spans.map(Spans.spanJson).toVector),
          "entity_types" -> JsArray(record.entityCounts.keys.toVector.sorted.map(JsString(_))),
          "entity_counts" -> Spans.countsJson(record.entityCounts),
          "detector_version" -> JsString(record.detectorVersion),
          "redacted_length" -> JsNumber(record.redactedText.length))) // enough to verify the output; the output stays out
      // Missing and foreign answer alike: anything else tells a caller which documents exist.
      case _ => error(StatusCodes.NotFound, "no such document")
    }

  val route: Route = path("v1" / "documents" / Segment / "redaction") { documentId =>
    get {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(error(StatusCodes.Unauthorized, "X-Tenant-Id is required"))
        case Some(tenant) => complete(read(tenant, documentId))
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

#include "redactor/store.h"  // store::load(document_id) -> std::optional<store::Redaction>, whichever tenant owns it

using json = nlohmann::json;

void read_redaction(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string document_id = req.matches[1];
  const auto record = store::load(document_id);
  if (!record) {
    res.set_content(json::object().dump(), "application/json");
    return;
  }
  res.set_content(json{{"document_id", document_id}, {"entity_counts", record->entity_counts},
                       {"detector_version", record->detector_version}, {"redacted_text", record->redacted_text}}.dump(),
                  "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/documents/([\\w-]+)/redaction)", read_redaction); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "redactor/store.h"  // store::load(document_id) -> std::optional<store::Redaction>, whichever tenant owns it

using json = nlohmann::json;

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void read_redaction(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, json{{"error", "X-Tenant-Id is required"}});
  const std::string document_id = req.matches[1];
  const auto record = store::load(document_id);
  // Missing and foreign answer alike: anything else tells a caller which documents exist.
  if (!record || record->tenant != tenant) return reply(res, 404, json{{"error", "no such document"}});
  std::vector<std::string> entity_types;
  for (const auto& [entity, count] : record->entity_counts) entity_types.push_back(entity);  // a std::map: already sorted
  reply(res, 200, json{{"document_id", document_id}, {"spans", record->spans}, {"entity_types", entity_types},
                       {"entity_counts", record->entity_counts}, {"detector_version", record->detector_version},
                       {"redacted_length", record->redacted_text.size()}});  // enough to verify the output; the output stays out
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/documents/([\\w-]+)/redaction)", read_redaction); }
`,
    },
  },
  harness: {
    python: `from redactor import store
from redactor.spans import apply_spans, scan

TEXT = "Reach Ada at ada@example.com or 415-555-0132."


def _seed(document_id="d-1", tenant="acme"):
    found = scan(TEXT, ["EMAIL", "PHONE"])
    redacted = apply_spans(TEXT, found)
    store.save(tenant, document_id, found, "ner-2026.10", redacted)
    return redacted


def _api(ctx):
    return ctx.client(ctx.load("read").app)


async def _get(c, document_id, tenant="acme"):
    headers = {"X-Tenant-Id": tenant} if tenant else {}
    return await c.get(f"/v1/documents/{document_id}/redaction", headers=headers)


async def check_route(ctx):
    _seed()
    async with _api(ctx) as c:
        r = await _get(c, "d-1")
    assert r.status_code == 200, f"GET /v1/documents/d-1/redaction answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("document_id") == "d-1" and body.get("detector_version") == "ner-2026.10", f"the answer must name the document and the detector version, got {body}"
    assert body.get("entity_counts") == {"EMAIL": 1, "PHONE": 1}, f"the entity counts are {body.get('entity_counts')}"


async def check_tenant_scope(ctx):
    _seed("d-1", "acme")
    async with _api(ctx) as c:
        foreign = await _get(c, "d-1", tenant="globex")
        missing = await _get(c, "d-none", tenant="globex")
        anonymous = await _get(c, "d-1", tenant=None)
        own = await _get(c, "d-1")
    assert foreign.status_code == 404, f"tenant globex read acme's document d-1: {foreign.status_code} {foreign.text[:200]}. The record's tenant must be the caller's"
    assert foreign.text == missing.text, f"another tenant's record must answer exactly what a missing one does: {foreign.text} against {missing.text}"
    assert anonymous.status_code == 401, f"a read without X-Tenant-Id answered {anonymous.status_code}, expected 401"
    assert own.status_code == 200, f"the owner's read answered {own.status_code}: {own.text}"


async def check_not_found(ctx):
    async with _api(ctx) as c:
        r = await _get(c, "d-none")
    assert r.status_code == 404, f"a document with no record answered {r.status_code} {r.text}, expected 404: an empty 200 reads as processed with nothing found"


async def check_no_text(ctx):
    redacted = _seed()
    async with _api(ctx) as c:
        r = await _get(c, "d-1")
    assert r.status_code == 200, f"the owner's read answered {r.status_code}: {r.text}"
    assert "redacted_text" not in r.json(), f"the audit read returns the stored output: {r.text}. It is a second copy of the document"
    assert "Reach Ada" not in r.text and redacted not in r.text, f"the audit read carries text: {r.text}"


async def check_offsets(ctx):
    redacted = _seed()
    async with _api(ctx) as c:
        r = await _get(c, "d-1")
    body = r.json()
    found = body.get("spans")
    assert found and all("replacement" in s for s in found), f"the answer must carry the spans with their replacements, got {found}"
    assert body.get("entity_types") == ["EMAIL", "PHONE"], f"entity_types must be the sorted types, got {body.get('entity_types')}"
    assert body.get("redacted_length") == len(redacted), f"redacted_length is {body.get('redacted_length')}, the output the caller holds is {len(redacted)} long"
    shift = 0
    for s in found:
        at = s["start"] + shift
        assert redacted[at:at + len(s["replacement"])] == s["replacement"], f"the span {s} does not match the output at {at}: {redacted!r}"
        shift += len(s["replacement"]) - (s["end"] - s["start"])
`,
    typescript: `const TEXT = 'Reach Ada at ada@example.com or 415-555-0132.';

async function setup(ctx, seed: [string, string][] = [['d-1', 'acme']]) {
  const {scan, applySpans} = ctx.load('/support/redactor/spans.ts');
  const store = ctx.load('/support/redactor/store.ts');
  const found = scan(TEXT, ['EMAIL', 'PHONE']);
  const redacted = applySpans(TEXT, found);
  for (const [documentId, tenant] of seed) await store.save(tenant, documentId, found, 'ner-2026.10', redacted);
  return {c: ctx.client(ctx.load('read').app), redacted};
}

const get = (c, documentId: string, tenant: string | null = 'acme') =>
  c.get(\`/v1/documents/\${documentId}/redaction\`, {headers: tenant === null ? {} : {'X-Tenant-Id': tenant}});

export async function check_route(ctx) {
  const {c} = await setup(ctx);
  const r = await get(c, 'd-1');
  assert.equal(r.status, 200, \`GET /v1/documents/d-1/redaction answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.document_id === 'd-1' && body.detector_version === 'ner-2026.10', \`the answer must name the document and the detector version, got \${r.text}\`);
  assert.deepStrictEqual(body.entity_counts, {EMAIL: 1, PHONE: 1}, \`the entity counts are \${JSON.stringify(body.entity_counts)}\`);
}

export async function check_tenant_scope(ctx) {
  const {c} = await setup(ctx);
  const foreign = await get(c, 'd-1', 'globex');
  const missing = await get(c, 'd-none', 'globex');
  const anonymous = await get(c, 'd-1', null);
  const own = await get(c, 'd-1');
  assert.equal(foreign.status, 404, \`tenant globex read acme's document d-1: \${foreign.status} \${foreign.text.slice(0, 200)}. The record's tenant must be the caller's\`);
  assert.equal(foreign.text, missing.text, \`another tenant's record must answer exactly what a missing one does: \${foreign.text} against \${missing.text}\`);
  assert.equal(anonymous.status, 401, \`a read without X-Tenant-Id answered \${anonymous.status}, expected 401\`);
  assert.equal(own.status, 200, \`the owner's read answered \${own.status}: \${own.text}\`);
}

export async function check_not_found(ctx) {
  const {c} = await setup(ctx, []);
  const r = await get(c, 'd-none');
  assert.equal(r.status, 404, \`a document with no record answered \${r.status} \${r.text}, expected 404: an empty 200 reads as processed with nothing found\`);
}

export async function check_no_text(ctx) {
  const {c, redacted} = await setup(ctx);
  const r = await get(c, 'd-1');
  assert.equal(r.status, 200, \`the owner's read answered \${r.status}: \${r.text}\`);
  assert(!('redacted_text' in r.json()), \`the audit read returns the stored output: \${r.text}. It is a second copy of the document\`);
  assert(!r.text.includes('Reach Ada') && !r.text.includes(redacted), \`the audit read carries text: \${r.text}\`);
}

export async function check_offsets(ctx) {
  const {c, redacted} = await setup(ctx);
  const body = (await get(c, 'd-1')).json();
  const found = body.spans;
  assert(Array.isArray(found) && found.length > 0 && found.every(s => 'replacement' in s), \`the answer must carry the spans with their replacements, got \${JSON.stringify(found)}\`);
  assert.deepStrictEqual(body.entity_types, ['EMAIL', 'PHONE'], \`entity_types must be the sorted types, got \${JSON.stringify(body.entity_types)}\`);
  assert.equal(body.redacted_length, redacted.length, \`redacted_length is \${body.redacted_length}, the output the caller holds is \${redacted.length} long\`);
  let shift = 0;
  for (const s of found) {
    const at = s.start + shift;
    assert.equal(redacted.slice(at, at + s.replacement.length), s.replacement, \`the span \${JSON.stringify(s)} does not match the output at \${at}: \${redacted}\`);
    shift += s.replacement.length - (s.end - s.start);
  }
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"strings"

	"redactor/spans"
	"redactor/store"

	"leetbuild/harness"
)

const readText = "Reach Ada at ada@example.com or 415-555-0132."

func readSeed(ctx *harness.Ctx, documentID, tenant string) string {
	found := spans.Scan(readText, []string{"EMAIL", "PHONE"})
	redacted := spans.ApplySpans(readText, found)
	ctx.NoError(store.Save(context.Background(), tenant, documentID, found, "ner-2026.10", redacted), "store.Save")
	return redacted
}

func readClient(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func readGet(c *harness.HTTP, documentID, tenant string) *harness.Response {
	if tenant == "" {
		return c.Get("/v1/documents/" + documentID + "/redaction")
	}
	return c.Get("/v1/documents/"+documentID+"/redaction", "X-Tenant-Id", tenant)
}

func readBody(r *harness.Response) map[string]any {
	var body map[string]any
	r.Decode(&body)
	return body
}

func CheckRoute(ctx *harness.Ctx) {
	readSeed(ctx, "d-1", "acme")
	r := readGet(readClient(ctx), "d-1", "acme")
	ctx.Equal(r.Status, 200, "GET /v1/documents/d-1/redaction (%s)", r.Text())
	body := readBody(r)
	ctx.Assert(body["document_id"] == "d-1" && body["detector_version"] == "ner-2026.10", "the answer must name the document and the detector version, got %s", r.Text())
	ctx.Equal(body["entity_counts"], map[string]any{"EMAIL": float64(1), "PHONE": float64(1)}, "the entity counts")
}

func CheckTenantScope(ctx *harness.Ctx) {
	readSeed(ctx, "d-1", "acme")
	c := readClient(ctx)
	foreign := readGet(c, "d-1", "globex")
	missing := readGet(c, "d-none", "globex")
	anonymous := readGet(c, "d-1", "")
	own := readGet(c, "d-1", "acme")
	ctx.Equal(foreign.Status, 404, "tenant globex read acme's document d-1 (%.200s); the record's tenant must be the caller's", foreign.Text())
	ctx.Equal(foreign.Text(), missing.Text(), "another tenant's record must answer exactly what a missing one does")
	ctx.Equal(anonymous.Status, 401, "a read without X-Tenant-Id")
	ctx.Equal(own.Status, 200, "the owner's read (%s)", own.Text())
}

func CheckNotFound(ctx *harness.Ctx) {
	r := readGet(readClient(ctx), "d-none", "acme")
	ctx.Equal(r.Status, 404, "a document with no record (%s): an empty 200 reads as processed with nothing found", r.Text())
}

func CheckNoText(ctx *harness.Ctx) {
	redacted := readSeed(ctx, "d-1", "acme")
	r := readGet(readClient(ctx), "d-1", "acme")
	ctx.Equal(r.Status, 200, "the owner's read (%s)", r.Text())
	_, has := readBody(r)["redacted_text"]
	ctx.Assert(!has, "the audit read returns the stored output: %s. It is a second copy of the document", r.Text())
	ctx.Assert(!strings.Contains(r.Text(), "Reach Ada") && !strings.Contains(r.Text(), redacted), "the audit read carries text: %s", r.Text())
}

func CheckOffsets(ctx *harness.Ctx) {
	redacted := readSeed(ctx, "d-1", "acme")
	body := readBody(readGet(readClient(ctx), "d-1", "acme"))
	found, _ := body["spans"].([]any)
	ctx.Assert(len(found) > 0, "the answer must carry the spans with their replacements, got %v", body["spans"])
	ctx.Equal(body["entity_types"], []any{"EMAIL", "PHONE"}, "entity_types must be the sorted types")
	ctx.Equal(body["redacted_length"], float64(len(redacted)), "redacted_length must be the length of the output the caller holds")
	shift := 0
	for _, item := range found {
		s := item.(map[string]any)
		replacement, _ := s["replacement"].(string)
		ctx.Assert(replacement != "", "the span %v carries no replacement", s)
		at := int(s["start"].(float64)) + shift
		ctx.Assert(at+len(replacement) <= len(redacted) && redacted[at:at+len(replacement)] == replacement, "the span %v does not match the output at %d: %s", s, at, redacted)
		shift += len(replacement) - int(s["end"].(float64)-s["start"].(float64))
	}
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>

namespace {

const std::string kText = "Reach Ada at ada@example.com or 415-555-0132.";

std::string seed(const std::string& document_id, const std::string& tenant) {
  const auto found = spans::scan(kText, {"EMAIL", "PHONE"});
  const std::string redacted = spans::apply_spans(kText, found);
  store::save(tenant, document_id, found, "ner-2026.10", redacted);
  return redacted;
}

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response get(harness::HTTP& c, const std::string& document_id, const std::string& tenant) {
  if (tenant.empty()) return c.Get("/v1/documents/" + document_id + "/redaction");
  return c.Get("/v1/documents/" + document_id + "/redaction", "X-Tenant-Id", tenant);
}

nlohmann::json parsed(const harness::Response& r) { return nlohmann::json::parse(r.Text(), nullptr, false); }

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  seed("d-1", "acme");
  auto c = api(ctx);
  const auto r = get(c, "d-1", "acme");
  ctx.Equal(r.Status, 200, "GET /v1/documents/d-1/redaction (%s)", r.Text());
  const auto body = parsed(r);
  ctx.Assert(body.value("document_id", "") == "d-1" && body.value("detector_version", "") == "ner-2026.10", "the answer must name the document and the detector version, got %s", r.Text());
  ctx.Equal(body.value("entity_counts", nlohmann::json()), nlohmann::json({{"EMAIL", 1}, {"PHONE", 1}}), "the entity counts");
}

void CheckTenantScope(harness::Ctx& ctx) {
  seed("d-1", "acme");
  auto c = api(ctx);
  const auto foreign = get(c, "d-1", "globex");
  const auto missing = get(c, "d-none", "globex");
  const auto anonymous = get(c, "d-1", "");
  const auto own = get(c, "d-1", "acme");
  ctx.Equal(foreign.Status, 404, "tenant globex read acme's document d-1 (%s); the record's tenant must be the caller's", foreign.Text().substr(0, 200));
  ctx.Equal(foreign.Text(), missing.Text(), "another tenant's record must answer exactly what a missing one does");
  ctx.Equal(anonymous.Status, 401, "a read without X-Tenant-Id");
  ctx.Equal(own.Status, 200, "the owner's read (%s)", own.Text());
}

void CheckNotFound(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = get(c, "d-none", "acme");
  ctx.Equal(r.Status, 404, "a document with no record (%s): an empty 200 reads as processed with nothing found", r.Text());
}

void CheckNoText(harness::Ctx& ctx) {
  const std::string redacted = seed("d-1", "acme");
  auto c = api(ctx);
  const auto r = get(c, "d-1", "acme");
  ctx.Equal(r.Status, 200, "the owner's read (%s)", r.Text());
  ctx.Assert(!parsed(r).contains("redacted_text"), "the audit read returns the stored output: %s. It is a second copy of the document", r.Text());
  ctx.Assert(r.Text().find("Reach Ada") == std::string::npos && r.Text().find(redacted) == std::string::npos, "the audit read carries text: %s", r.Text());
}

void CheckOffsets(harness::Ctx& ctx) {
  const std::string redacted = seed("d-1", "acme");
  auto c = api(ctx);
  const auto body = parsed(get(c, "d-1", "acme"));
  const auto found = body.value("spans", nlohmann::json::array());
  ctx.Assert(!found.empty(), "the answer must carry the spans with their replacements, got %s", body.dump());
  ctx.Equal(body.value("entity_types", nlohmann::json()), nlohmann::json::array({"EMAIL", "PHONE"}), "entity_types must be the sorted types");
  ctx.Equal(body.value("redacted_length", -1L), redacted.size(), "redacted_length must be the length of the output the caller holds");
  long shift = 0;
  for (const auto& s : found) {
    const std::string replacement = s.value("replacement", "");
    ctx.Assert(!replacement.empty(), "the span %s carries no replacement", s.dump());
    const long at = s.value("start", 0L) + shift;
    ctx.Assert(redacted.compare(at, replacement.size(), replacement) == 0, "the span %s does not match the output at %d: %s", s.dump(), at, redacted);
    shift += static_cast<long>(replacement.size()) - (s.value("end", 0L) - s.value("start", 0L));
  }
}
`,
  },
  hints: [
    "Read acme's document with `X-Tenant-Id: globex`: you get its record. Ask for a document that never existed: 200 and `{}`. Every answer carries the stored output.",
    "`store.load` returns the record whichever tenant owns it, and nothing compares its `tenant` with the caller's; the no-record branch returns `{}`; the response copies `redacted_text` and leaves out the spans.",
    'Read `X-Tenant-Id` (401 when absent); answer 404 when the record is `None` or its `tenant` differs; answer `spans`, `sorted(entity_counts)` as `entity_types`, `entity_counts`, `detector_version` and `len(record.redacted_text)` as `redacted_length`.',
  ],
  debrief: `The tenant check sits on the record, after the load, because the store is keyed by document id alone: the ownership test is the only thing standing between one tenant and another's audit trail. Answering a foreign record with the same 404 as a missing one keeps the endpoint from becoming an oracle for which documents exist. The audit read exists to prove what was removed, and offsets with their replacements prove it to a caller who already holds the output, without the endpoint holding or sending a copy. Production audit stores also key records by tenant so the check is structural, log every audit read with the reader's identity, and expire offsets with the document's retention.`,
};
