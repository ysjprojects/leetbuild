import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/forms/{id}/submissions: validation against the published schema',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'db'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/forms/{id}/submissions\` with body
\`{"fields": {name: text}}\` on the form store (\`forms.store\`, provided): it resolves the form's
schema with \`store.draft_schema\`, runs every value through a tag-stripping regex, stores it with
\`store.insert_submission\` and answers \`201 {"submission_id"}\`. It serves the demo and hides 5
flaws.

**Failure mode the checks target.** A public caller writes a field the author has not shipped, or
any field at all, at any length; a message with markup comes back with the submitter's words cut
out; and a client that retries after a timeout files the same submission twice.

- Validate against \`store.published_schema\`: the published version is the contract with
  submitters, the draft belongs to the author.
- A field the schema does not declare, or a value longer than its \`max_bytes\` (counted in UTF-8
  bytes), is **422** with a body naming every offending field; nothing is stored.
- Store values **HTML-escaped** (\`&\`, \`<\`, \`>\`), not stripped.
- \`Idempotency-Key\` is required (**400** without it). Look up \`store.submission_for_key(form, key)\`
  before inserting and answer the original \`submission_id\` on a replay; record the key with
  \`store.record_key\` after the insert.`,
  sequence: {
    participants: ['Submitter', 'Form API', 'Form store'],
    messages: [
      {from: 'Submitter', to: 'Form API', label: 'POST /v1/forms/{id}/submissions · Idempotency-Key', kind: 'sync'},
      {from: 'Form API', to: 'Form store', label: 'published_schema(form) → field: max_bytes', kind: 'sync'},
      {
        from: 'Form API',
        to: 'Form store',
        label: 'submission_for_key(form, key) → original id on a replay',
        kind: 'sync',
      },
      {from: 'Form API', to: 'Form API', label: 'unknown field · over max_bytes → 422 naming it', kind: 'sync'},
      {from: 'Form API', to: 'Form store', label: 'insert_submission(escaped values) · record_key', kind: 'sync'},
      {from: 'Form API', to: 'Submitter', label: '201 {submission_id}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'published-schema',
      title: 'Validates against the published schema version',
      detail:
        'The handler reads the form through `published_schema`/`publishedSchema`: a field only the unpublished draft declares is rejected, a field the draft dropped but the published form still shows is accepted. The starter reads the draft.',
      match: {
        python: {all: [/store\.published_schema\(/], none: [/store\.draft_schema\(/]},
        typescript: {all: [/\bpublishedSchema\(/], none: [/\bdraftSchema\(/]},
        go: {all: [/store\.PublishedSchema\(/], none: [/store\.DraftSchema\(/]},
        scala: {all: [/Store\.publishedSchema\(/], none: [/Store\.draftSchema\(/]},
        cpp: {all: [/store::publishedSchema\(/], none: [/store::draftSchema\(/]},
      },
    },
    {
      id: 'unknown-fields',
      title: 'Rejects undeclared fields by name',
      detail:
        'A field the published schema does not declare answers **422** naming it (every one of them), and nothing is stored. The starter stores whatever fields arrive.',
      match: {
        python: {all: [/status_code\s*=\s*422/, /["']unknown field["']/]},
        typescript: {all: [/code\(\s*422\s*\)/, /['"]unknown field['"]/]},
        go: {all: [/StatusUnprocessableEntity|\b422\b/, /"unknown field"/]},
        scala: {all: [/UnprocessableEntity/, /"unknown field"/]},
        cpp: {all: [/status\s*=\s*422/, /"unknown field"/]},
      },
    },
    {
      id: 'field-limits',
      title: 'Enforces each field’s max_bytes in bytes',
      detail:
        'A value longer than its field’s `max_bytes`, counted in UTF-8 bytes (21 × `é` is 42 bytes), answers **422** naming the field. The starter stores any length.',
      match: {
        python: {all: [/len\([^)\n]*\.encode\(/]},
        typescript: {all: [/Buffer\.byteLength\(|TextEncoder\(\)\.encode\(/]},
        go: {all: [/len\(\w+\)\s*>\s*\w+/]},
        scala: {all: [/\.getBytes\([^)\n]*\)\.length/]},
        cpp: {all: [/\.size\(\)\s*>\s*/]},
      },
    },
    {
      id: 'escape-markup',
      title: 'Escapes markup at rest instead of stripping it',
      detail:
        'Stored values are HTML-escaped (`html.escape`, `html.EscapeString`, an `escapeHtml`), so `<script>` is kept as inert text the dashboard can render. The starter deletes everything between `<` and `>` with a regex.',
      match: {
        python: {all: [/html\.escape\(/], none: [/<\[\^>\]\*>/]},
        typescript: {all: [/&lt;/, /&amp;/], none: [/<\[\^>\]\*>/]},
        go: {all: [/html\.EscapeString\(/], none: [/<\[\^>\]\*>/]},
        scala: {all: [/&lt;/, /&amp;/], none: [/<\[\^>\]\*>/]},
        cpp: {all: [/&lt;/, /&amp;/], none: [/<\[\^>\]\*>/]},
      },
    },
    {
      id: 'replay-id',
      title: 'A replayed Idempotency-Key answers the original submission',
      detail:
        '`Idempotency-Key` is required (**400**), looked up with `submission_for_key`/`submissionForKey` before the insert and recorded with `record_key`/`recordKey` after it, so a retry answers the first `submission_id`. The starter ignores the header.',
      match: {
        python: {
          all: [/idempotency-key/i, /\b400\b/, /store\.record_key\(/],
          order: [/store\.submission_for_key\(/, /store\.insert_submission\(/],
        },
        typescript: {
          all: [/idempotency-key/i, /\b400\b/, /\brecordKey\(/],
          order: [/\bsubmissionForKey\(/, /\binsertSubmission\(/],
        },
        go: {
          all: [/Idempotency-Key/i, /StatusBadRequest|\b400\b/, /store\.RecordKey\(/],
          order: [/store\.SubmissionForKey\(/, /store\.InsertSubmission\(/],
        },
        scala: {
          all: [/Idempotency-Key/i, /BadRequest/, /Store\.recordKey\(/],
          order: [/Store\.submissionForKey\(/, /Store\.insertSubmission\(/],
        },
        cpp: {
          all: [/Idempotency-Key/i, /status\s*=\s*400/, /store::recordKey\(/],
          order: [/store::submissionForKey\(/, /store::insertSubmission\(/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import re

from fastapi import FastAPI, HTTPException, Request

from forms import store  # published_schema, draft_schema, insert_submission, submission_for_key, record_key

app = FastAPI()


def strip_tags(value: str) -> str:
    return re.sub(r"<[^>]*>", "", value)


@app.post("/v1/forms/{form_id}/submissions", status_code=201)
async def submit(form_id: str, request: Request) -> dict:
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    schema = store.draft_schema(form_id)
    if schema is None:
        raise HTTPException(status_code=404, detail="no such form")
    body = await request.json()
    values = {name: strip_tags(str(value)) for name, value in body.get("fields", {}).items()}
    submission_id = store.insert_submission(form_id, values)
    return {"submission_id": submission_id}
`,
      solution: `import html

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from forms import store  # published_schema, draft_schema, insert_submission, submission_for_key, record_key

app = FastAPI()


@app.post("/v1/forms/{form_id}/submissions", status_code=201)
async def submit(form_id: str, request: Request):
    key = request.headers.get("idempotency-key", "")
    if not key:
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    # The published version is the contract with submitters; the draft belongs to the author.
    schema = store.published_schema(form_id)
    if schema is None:
        raise HTTPException(status_code=404, detail="no such form")
    replayed = store.submission_for_key(form_id, key)
    if replayed is not None:
        return JSONResponse({"submission_id": replayed, "replayed": True})
    body = await request.json()
    fields = {name: str(value) for name, value in body.get("fields", {}).items()}
    errors = []
    for name, value in fields.items():
        if name not in schema:
            errors.append({"field": name, "error": "unknown field"})
        elif len(value.encode("utf-8")) > schema[name]:
            errors.append({"field": name, "error": f"longer than {schema[name]} bytes"})
    if errors:
        raise HTTPException(status_code=422, detail={"errors": errors})
    # Escaped, not stripped: the dashboard renders it as text and the submitter's words survive.
    submission_id = store.insert_submission(form_id, {name: html.escape(value) for name, value in fields.items()})
    store.record_key(form_id, key, submission_id)
    return {"submission_id": submission_id}
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {draftSchema, insertSubmission, publishedSchema, recordKey, submissionForKey} from 'forms/store';

export const app = Fastify();

const stripTags = (value: string): string => value.replace(/<[^>]*>/g, '');

app.post('/v1/forms/:formId/submissions', async (request, reply) => {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const {formId} = request.params as {formId: string};
  const schema = await draftSchema(formId);
  if (schema === null) return reply.code(404).send({error: 'no such form'});
  const {fields = {}} = request.body as {fields?: Record<string, unknown>};
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(fields)) values[name] = stripTags(String(value));
  const submissionId = await insertSubmission(formId, values);
  return reply.code(201).send({submission_id: submissionId});
});
`,
      solution: `import Fastify from 'fastify';

import {draftSchema, insertSubmission, publishedSchema, recordKey, submissionForKey} from 'forms/store';

export const app = Fastify();

const ENTITIES: Record<string, string> = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;'};

/** Escaped, not stripped: the dashboard renders it as text and the submitter's words survive. */
const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, c => ENTITIES[c]);

app.post('/v1/forms/:formId/submissions', async (request, reply) => {
  const {formId} = request.params as {formId: string};
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key === '') return reply.code(400).send({error: 'Idempotency-Key is required'});
  // The published version is the contract with submitters; the draft belongs to the author.
  const schema = await publishedSchema(formId);
  if (schema === null) return reply.code(404).send({error: 'no such form'});
  const replayed = await submissionForKey(formId, key);
  if (replayed !== null) return reply.code(200).send({submission_id: replayed, replayed: true});
  const {fields = {}} = request.body as {fields?: Record<string, unknown>};
  const errors: {field: string; error: string}[] = [];
  for (const [name, value] of Object.entries(fields)) {
    const limit = Object.hasOwn(schema, name) ? schema[name] : undefined;
    if (limit === undefined) errors.push({field: name, error: 'unknown field'});
    else if (Buffer.byteLength(String(value), 'utf8') > limit) errors.push({field: name, error: \`longer than \${limit} bytes\`});
  }
  if (errors.length > 0) return reply.code(422).send({errors});
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(fields)) values[name] = escapeHtml(String(value));
  const submissionId = await insertSubmission(formId, values);
  await recordKey(formId, key, submissionId);
  return reply.code(201).send({submission_id: submissionId});
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
	"regexp"

	"forms/store" // store.PublishedSchema, DraftSchema, InsertSubmission, SubmissionForKey, RecordKey
)

var tags = regexp.MustCompile(\`<[^>]*>\`)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func submit(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	formID := r.PathValue("id")
	schema := store.DraftSchema(r.Context(), formID)
	if schema == nil {
		http.Error(rw, "no such form", http.StatusNotFound)
		return
	}
	var body struct {
		Fields map[string]string \`json:"fields"\`
	}
	json.NewDecoder(r.Body).Decode(&body)
	values := map[string]string{}
	for name, value := range body.Fields {
		values[name] = tags.ReplaceAllString(value, "")
	}
	id, err := store.InsertSubmission(r.Context(), formID, values)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(rw, http.StatusCreated, map[string]string{"submission_id": id})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/forms/{id}/submissions", submit)
}
`,
      solution: `package main

import (
	"encoding/json"
	"fmt"
	"html"
	"net/http"

	"forms/store" // store.PublishedSchema, DraftSchema, InsertSubmission, SubmissionForKey, RecordKey
)

type fieldError struct {
	Field string \`json:"field"\`
	Error string \`json:"error"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func submit(rw http.ResponseWriter, r *http.Request) {
	formID := r.PathValue("id")
	key := r.Header.Get("Idempotency-Key")
	if key == "" {
		http.Error(rw, "Idempotency-Key is required", http.StatusBadRequest)
		return
	}
	// The published version is the contract with submitters; the draft belongs to the author.
	schema := store.PublishedSchema(r.Context(), formID)
	if schema == nil {
		http.Error(rw, "no such form", http.StatusNotFound)
		return
	}
	if replayed := store.SubmissionForKey(r.Context(), formID, key); replayed != "" {
		writeJSON(rw, http.StatusOK, map[string]any{"submission_id": replayed, "replayed": true})
		return
	}
	var body struct {
		Fields map[string]string \`json:"fields"\`
	}
	json.NewDecoder(r.Body).Decode(&body)
	var errors []fieldError
	for name, value := range body.Fields {
		limit, declared := schema[name]
		if !declared {
			errors = append(errors, fieldError{name, "unknown field"})
		} else if len(value) > limit { // len counts bytes
			errors = append(errors, fieldError{name, fmt.Sprintf("longer than %d bytes", limit)})
		}
	}
	if len(errors) > 0 {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]any{"errors": errors})
		return
	}
	values := map[string]string{}
	for name, value := range body.Fields {
		// Escaped, not stripped: the dashboard renders it as text and the submitter's words survive.
		values[name] = html.EscapeString(value)
	}
	id, err := store.InsertSubmission(r.Context(), formID, values)
	if err == nil {
		err = store.RecordKey(r.Context(), formID, key, id)
	}
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(rw, http.StatusCreated, map[string]string{"submission_id": id})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/forms/{id}/submissions", submit)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import forms.Store // Store.publishedSchema, draftSchema, insertSubmission, submissionForKey, recordKey

object SubmitApi {
  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def stripTags(value: String): String = value.replaceAll("<[^>]*>", "")

  /** The body's fields, field name to text. */
  private def fields(raw: String): Map[String, String] = raw.parseJson.asJsObject.fields.get("fields") match {
    case Some(JsObject(given)) => given.map { case (name, JsString(s)) => name -> s; case (name, other) => name -> other.compactPrint }
    case _ => Map.empty
  }

  val route: Route =
    path("v1" / "forms" / Segment / "submissions") { formId =>
      post {
        entity(as[String]) { raw =>
          // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
          Store.draftSchema(formId) match {
            case None => complete(StatusCodes.NotFound -> "no such form")
            case Some(_) =>
              val id = Store.insertSubmission(formId, fields(raw).map { case (name, value) => name -> stripTags(value) })
              complete(json(StatusCodes.Created, JsObject("submission_id" -> JsString(id))))
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

import forms.Store // Store.publishedSchema, draftSchema, insertSubmission, submissionForKey, recordKey

object SubmitApi {
  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  /** Escaped, not stripped: the dashboard renders it as text and the submitter's words survive. */
  def escapeHtml(value: String): String =
    value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\\"", "&quot;").replace("'", "&#x27;")

  /** The body's fields, field name to text. */
  private def fields(raw: String): Map[String, String] = raw.parseJson.asJsObject.fields.get("fields") match {
    case Some(JsObject(given)) => given.map { case (name, JsString(s)) => name -> s; case (name, other) => name -> other.compactPrint }
    case _ => Map.empty
  }

  /** Every field the schema does not declare or that is longer than its max_bytes. */
  private def errorsOf(schema: Store.Schema, given: Map[String, String]): Seq[JsObject] =
    given.toSeq.flatMap { case (name, value) =>
      schema.get(name) match {
        case None => Some(JsObject("field" -> JsString(name), "error" -> JsString("unknown field")))
        case Some(limit) if value.getBytes(UTF_8).length > limit =>
          Some(JsObject("field" -> JsString(name), "error" -> JsString(s"longer than $limit bytes")))
        case _ => None
      }
    }

  val route: Route =
    path("v1" / "forms" / Segment / "submissions") { formId =>
      post {
        optionalHeaderValueByName("Idempotency-Key") {
          case None | Some("") => complete(StatusCodes.BadRequest -> "Idempotency-Key is required")
          case Some(key) =>
            entity(as[String]) { raw =>
              // The published version is the contract with submitters; the draft belongs to the author.
              Store.publishedSchema(formId) match {
                case None => complete(StatusCodes.NotFound -> "no such form")
                case Some(schema) =>
                  Store.submissionForKey(formId, key) match {
                    case Some(replayed) => complete(json(StatusCodes.OK, JsObject("submission_id" -> JsString(replayed), "replayed" -> JsTrue)))
                    case None =>
                      val given = fields(raw)
                      val errors = errorsOf(schema, given)
                      if (errors.nonEmpty) complete(json(StatusCodes.UnprocessableEntity, JsObject("errors" -> JsArray(errors.toVector))))
                      else {
                        val id = Store.insertSubmission(formId, given.map { case (name, value) => name -> escapeHtml(value) })
                        Store.recordKey(formId, key, id)
                        complete(json(StatusCodes.Created, JsObject("submission_id" -> JsString(id))))
                      }
                  }
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

#include <map>
#include <regex>
#include <string>

#include "forms/store.h"  // store::publishedSchema, draftSchema, insertSubmission, submissionForKey, recordKey

using json = nlohmann::json;

std::string stripTags(const std::string& value) { return std::regex_replace(value, std::regex("<[^>]*>"), ""); }

// The body's fields, field name to text.
std::map<std::string, std::string> fieldsOf(const std::string& raw) {
  std::map<std::string, std::string> fields;
  const json body = json::parse(raw, nullptr, false);
  if (!body.is_object() || !body.contains("fields") || !body["fields"].is_object()) return fields;
  for (const auto& [name, value] : body["fields"].items()) fields[name] = value.is_string() ? value.get<std::string>() : value.dump();
  return fields;
}

void submit(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const std::string form_id = req.matches[1];
  if (!store::draftSchema(form_id)) {
    res.status = 404;
    res.set_content("no such form", "text/plain");
    return;
  }
  std::map<std::string, std::string> values;
  for (const auto& [name, value] : fieldsOf(req.body)) values[name] = stripTags(value);
  const std::string id = store::insertSubmission(form_id, values);
  res.status = 201;
  res.set_content(json{{"submission_id", id}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Post(R"(/v1/forms/([\\w-]+)/submissions)", submit);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <map>
#include <string>

#include "forms/store.h"  // store::publishedSchema, draftSchema, insertSubmission, submissionForKey, recordKey

using json = nlohmann::json;

// Escaped, not stripped: the dashboard renders it as text and the submitter's words survive.
std::string escapeHtml(const std::string& value) {
  std::string out;
  for (const char c : value) {
    switch (c) {
      case '&': out += "&amp;"; break;
      case '<': out += "&lt;"; break;
      case '>': out += "&gt;"; break;
      case '"': out += "&quot;"; break;
      case '\\'': out += "&#x27;"; break;
      default: out += c;
    }
  }
  return out;
}

// The body's fields, field name to text.
std::map<std::string, std::string> fieldsOf(const std::string& raw) {
  std::map<std::string, std::string> fields;
  const json body = json::parse(raw, nullptr, false);
  if (!body.is_object() || !body.contains("fields") || !body["fields"].is_object()) return fields;
  for (const auto& [name, value] : body["fields"].items()) fields[name] = value.is_string() ? value.get<std::string>() : value.dump();
  return fields;
}

void submit(const httplib::Request& req, httplib::Response& res) {
  const std::string form_id = req.matches[1];
  const std::string key = req.get_header_value("Idempotency-Key");
  if (key.empty()) {
    res.status = 400;
    res.set_content("Idempotency-Key is required", "text/plain");
    return;
  }
  // The published version is the contract with submitters; the draft belongs to the author.
  const auto schema = store::publishedSchema(form_id);
  if (!schema) {
    res.status = 404;
    res.set_content("no such form", "text/plain");
    return;
  }
  if (const auto replayed = store::submissionForKey(form_id, key)) {
    res.set_content(json{{"submission_id", *replayed}, {"replayed", true}}.dump(), "application/json");
    return;
  }
  const auto fields = fieldsOf(req.body);
  json errors = json::array();
  for (const auto& [name, value] : fields) {
    const auto declared = schema->find(name);
    if (declared == schema->end()) {
      errors.push_back({{"field", name}, {"error", "unknown field"}});
    } else if (value.size() > static_cast<size_t>(declared->second)) {  // size() counts bytes
      errors.push_back({{"field", name}, {"error", "longer than " + std::to_string(declared->second) + " bytes"}});
    }
  }
  if (!errors.empty()) {
    res.status = 422;
    res.set_content(json{{"errors", errors}}.dump(), "application/json");
    return;
  }
  std::map<std::string, std::string> values;
  for (const auto& [name, value] : fields) values[name] = escapeHtml(value);
  const std::string id = store::insertSubmission(form_id, values);
  store::recordKey(form_id, key, id);
  res.status = 201;
  res.set_content(json{{"submission_id", id}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Post(R"(/v1/forms/([\\w-]+)/submissions)", submit);
}
`,
    },
  },
  harness: {
    python: `from forms import store

PUBLISHED = {"name": 40, "email": 80, "message": 200}
# The author's next version: phone added, message dropped. Not published yet.
DRAFT = {"name": 40, "email": 80, "phone": 20}


def _api(ctx):
    store.define_form("f-1", "u-owner", PUBLISHED, DRAFT)
    return ctx.client(ctx.load("api").app)


async def _submit(c, fields, key):
    headers = {"Idempotency-Key": key} if key else {}
    return await c.post("/v1/forms/f-1/submissions", json={"fields": fields}, headers=headers)


def _count(ctx):
    return ctx.redis.zcard("form:f-1:submissions")


async def check_published_schema(ctx):
    async with _api(ctx) as c:
        r = await _submit(c, {"name": "Ada", "message": "Hello"}, "k-1")
        assert r.status_code == 201, f"a submission of the published fields name and message answered {r.status_code}: {r.text}. Submitters see the published form, whatever the draft dropped"
        r = await _submit(c, {"name": "Ada", "phone": "555-0100"}, "k-2")
    assert r.status_code == 422, f"a submission of phone, a field only the unpublished draft declares, answered {r.status_code}: a public caller wrote a field the author has not shipped"
    assert "phone" in r.text, f"the 422 must name the field phone, got {r.text}"
    assert _count(ctx) == 1, f"the form holds {_count(ctx)} submissions, expected only the valid one"


async def check_unknown_fields(ctx):
    async with _api(ctx) as c:
        r = await _submit(c, {"name": "Ada", "is_admin": "true", "plan": "enterprise"}, "k-1")
        assert r.status_code == 422, f"a submission with the undeclared fields is_admin and plan answered {r.status_code}, expected 422"
        assert "is_admin" in r.text and "plan" in r.text, f"the 422 must name every undeclared field (is_admin, plan), got {r.text}"
        assert _count(ctx) == 0, "a rejected submission was stored anyway"
        r = await _submit(c, {"name": "Ada"}, "k-2")
    assert r.status_code == 201, f"a submission of declared fields only answered {r.status_code}: {r.text}"


async def check_field_limits(ctx):
    async with _api(ctx) as c:
        r = await _submit(c, {"name": "é" * 21}, "k-1")
        assert r.status_code == 422, f"21 characters of é (42 bytes) in name, declared max_bytes 40, answered {r.status_code}: count the limit in UTF-8 bytes, not characters"
        assert "name" in r.text, f"the 422 must name the field, got {r.text}"
        r = await _submit(c, {"message": "x" * 201}, "k-2")
        assert r.status_code == 422, f"201 bytes in message, declared max_bytes 200, answered {r.status_code}"
        r = await _submit(c, {"name": "a" * 40, "message": "x" * 200}, "k-3")
    assert r.status_code == 201, f"values exactly at their max_bytes answered {r.status_code}: {r.text}"
    assert _count(ctx) == 1, f"the form holds {_count(ctx)} submissions, expected only the one within its limits"


async def check_escape_markup(ctx):
    text = "<script>alert(1)</script> & thanks"
    async with _api(ctx) as c:
        r = await _submit(c, {"message": text}, "k-1")
    assert r.status_code == 201, f"a message with markup answered {r.status_code}: {r.text}"
    stored = store.load_submission(r.json()["submission_id"])["values"]["message"]
    assert "<" not in stored and ">" not in stored, f"the stored message {stored!r} still holds raw markup the dashboard would run"
    assert stored == "&lt;script&gt;alert(1)&lt;/script&gt; &amp; thanks", f"the stored message is {stored!r}: the markup must be escaped (&lt; &gt; &amp;), not cut out with the submitter's words"


async def check_replay_id(ctx):
    async with _api(ctx) as c:
        first = await _submit(c, {"name": "Ada"}, "k-1")
        replay = await _submit(c, {"name": "Ada"}, "k-1")
        assert first.status_code == 201 and replay.status_code in (200, 201), f"the first POST answered {first.status_code}, its replay {replay.status_code}"
        assert replay.json().get("submission_id") == first.json().get("submission_id"), f"a replay of Idempotency-Key k-1 answered {replay.json()}, the first POST {first.json()}: one person, two submissions"
        assert _count(ctx) == 1, f"two POSTs with one Idempotency-Key stored {_count(ctx)} submissions"
        other = await _submit(c, {"name": "Grace"}, "k-2")
        assert other.status_code == 201 and other.json().get("submission_id") != first.json().get("submission_id"), f"a new key must store a new submission, got {other.status_code} {other.text}"
        none = await _submit(c, {"name": "Ada"}, None)
    assert none.status_code == 400, f"a POST without Idempotency-Key answered {none.status_code}, expected 400"
`,
    typescript: `const PUBLISHED = {name: 40, email: 80, message: 200};
// The author's next version: phone added, message dropped. Not published yet.
const DRAFT = {name: 40, email: 80, phone: 20};

async function api(ctx) {
  const store = ctx.load('/support/forms/store.ts');
  await store.defineForm('f-1', 'u-owner', PUBLISHED, DRAFT);
  return {c: ctx.client(ctx.load('api').app), store};
}

const submit = (c, fields: Record<string, string>, key: string | null) =>
  c.post('/v1/forms/f-1/submissions', {json: {fields}, headers: key === null ? {} : {'Idempotency-Key': key}});

const count = (ctx): number => ctx.redis.zcard('form:f-1:submissions');

export async function check_published_schema(ctx) {
  const {c} = await api(ctx);
  let r = await submit(c, {name: 'Ada', message: 'Hello'}, 'k-1');
  assert.equal(r.status, 201, \`a submission of the published fields name and message answered \${r.status}: \${r.text}. Submitters see the published form, whatever the draft dropped\`);
  r = await submit(c, {name: 'Ada', phone: '555-0100'}, 'k-2');
  assert.equal(r.status, 422, \`a submission of phone, a field only the unpublished draft declares, answered \${r.status}: a public caller wrote a field the author has not shipped\`);
  assert(r.text.includes('phone'), \`the 422 must name the field phone, got \${r.text}\`);
  assert.equal(count(ctx), 1, 'the form must hold only the valid submission');
}

export async function check_unknown_fields(ctx) {
  const {c} = await api(ctx);
  let r = await submit(c, {name: 'Ada', is_admin: 'true', plan: 'enterprise'}, 'k-1');
  assert.equal(r.status, 422, \`a submission with the undeclared fields is_admin and plan answered \${r.status}, expected 422\`);
  assert(r.text.includes('is_admin') && r.text.includes('plan'), \`the 422 must name every undeclared field (is_admin, plan), got \${r.text}\`);
  assert.equal(count(ctx), 0, 'a rejected submission was stored anyway');
  r = await submit(c, {name: 'Ada'}, 'k-2');
  assert.equal(r.status, 201, \`a submission of declared fields only answered \${r.status}: \${r.text}\`);
}

export async function check_field_limits(ctx) {
  const {c} = await api(ctx);
  let r = await submit(c, {name: 'é'.repeat(21)}, 'k-1');
  assert.equal(r.status, 422, \`21 characters of é (42 bytes) in name, declared max_bytes 40, answered \${r.status}: count the limit in UTF-8 bytes, not characters\`);
  assert(r.text.includes('name'), \`the 422 must name the field, got \${r.text}\`);
  r = await submit(c, {message: 'x'.repeat(201)}, 'k-2');
  assert.equal(r.status, 422, \`201 bytes in message, declared max_bytes 200, answered \${r.status}\`);
  r = await submit(c, {name: 'a'.repeat(40), message: 'x'.repeat(200)}, 'k-3');
  assert.equal(r.status, 201, \`values exactly at their max_bytes answered \${r.status}: \${r.text}\`);
  assert.equal(count(ctx), 1, 'the form must hold only the submission within its limits');
}

export async function check_escape_markup(ctx) {
  const {c, store} = await api(ctx);
  const r = await submit(c, {message: '<script>alert(1)</script> & thanks'}, 'k-1');
  assert.equal(r.status, 201, \`a message with markup answered \${r.status}: \${r.text}\`);
  const stored = (await store.loadSubmission(r.json().submission_id)).values.message;
  assert(!stored.includes('<') && !stored.includes('>'), \`the stored message \${JSON.stringify(stored)} still holds raw markup the dashboard would run\`);
  assert.equal(stored, '&lt;script&gt;alert(1)&lt;/script&gt; &amp; thanks', \`the stored message is \${JSON.stringify(stored)}: the markup must be escaped (&lt; &gt; &amp;), not cut out with the submitter's words\`);
}

export async function check_replay_id(ctx) {
  const {c} = await api(ctx);
  const first = await submit(c, {name: 'Ada'}, 'k-1');
  const replay = await submit(c, {name: 'Ada'}, 'k-1');
  assert(first.status === 201 && (replay.status === 200 || replay.status === 201), \`the first POST answered \${first.status}, its replay \${replay.status}\`);
  assert.equal(replay.json().submission_id, first.json().submission_id, \`a replay of Idempotency-Key k-1 answered \${replay.text}, the first POST \${first.text}: one person, two submissions\`);
  assert.equal(count(ctx), 1, 'two POSTs with one Idempotency-Key must store one submission');
  const other = await submit(c, {name: 'Grace'}, 'k-2');
  assert(other.status === 201 && other.json().submission_id !== first.json().submission_id, \`a new key must store a new submission, got \${other.status} \${other.text}\`);
  const none = await submit(c, {name: 'Ada'}, null);
  assert.equal(none.status, 400, \`a POST without Idempotency-Key answered \${none.status}, expected 400\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"strings"

	"forms/store"

	"leetbuild/harness"
)

// The author's next version adds phone and drops message; it is not published yet.
var (
	apiPublished = store.Schema{"name": 40, "email": 80, "message": 200}
	apiDraft     = store.Schema{"name": 40, "email": 80, "phone": 20}
)

func apiClient(ctx *harness.Ctx) *harness.HTTP {
	ctx.NoError(store.DefineForm(context.Background(), "f-1", "u-owner", apiPublished, apiDraft), "DefineForm")
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func apiSubmit(c *harness.HTTP, fields map[string]string, key string) *harness.Response {
	body := map[string]any{"fields": fields}
	if key == "" {
		return c.Post("/v1/forms/f-1/submissions", body)
	}
	return c.Post("/v1/forms/f-1/submissions", body, "Idempotency-Key", key)
}

func apiCount(ctx *harness.Ctx) int64 { return ctx.Redis.ZCard("form:f-1:submissions") }

func apiID(r *harness.Response) string {
	var body struct {
		SubmissionID string \`json:"submission_id"\`
	}
	r.Decode(&body)
	return body.SubmissionID
}

func CheckPublishedSchema(ctx *harness.Ctx) {
	c := apiClient(ctx)
	r := apiSubmit(c, map[string]string{"name": "Ada", "message": "Hello"}, "k-1")
	ctx.Equal(r.Status, 201, "a submission of the published fields name and message (%s); submitters see the published form, whatever the draft dropped", r.Text())
	r = apiSubmit(c, map[string]string{"name": "Ada", "phone": "555-0100"}, "k-2")
	ctx.Equal(r.Status, 422, "a submission of phone, a field only the unpublished draft declares: a public caller must not write a field the author has not shipped")
	ctx.Assert(strings.Contains(r.Text(), "phone"), "the 422 must name the field phone, got %s", r.Text())
	ctx.Equal(apiCount(ctx), 1, "the form must hold only the valid submission; submissions")
}

func CheckUnknownFields(ctx *harness.Ctx) {
	c := apiClient(ctx)
	r := apiSubmit(c, map[string]string{"name": "Ada", "is_admin": "true", "plan": "enterprise"}, "k-1")
	ctx.Equal(r.Status, 422, "a submission with the undeclared fields is_admin and plan")
	ctx.Assert(strings.Contains(r.Text(), "is_admin") && strings.Contains(r.Text(), "plan"), "the 422 must name every undeclared field (is_admin, plan), got %s", r.Text())
	ctx.Equal(apiCount(ctx), 0, "a rejected submission must not be stored; submissions")
	r = apiSubmit(c, map[string]string{"name": "Ada"}, "k-2")
	ctx.Equal(r.Status, 201, "a submission of declared fields only (%s)", r.Text())
}

func CheckFieldLimits(ctx *harness.Ctx) {
	c := apiClient(ctx)
	r := apiSubmit(c, map[string]string{"name": strings.Repeat("é", 21)}, "k-1")
	ctx.Equal(r.Status, 422, "21 characters of é (42 bytes) in name, declared max_bytes 40: count the limit in UTF-8 bytes, not characters")
	ctx.Assert(strings.Contains(r.Text(), "name"), "the 422 must name the field, got %s", r.Text())
	r = apiSubmit(c, map[string]string{"message": strings.Repeat("x", 201)}, "k-2")
	ctx.Equal(r.Status, 422, "201 bytes in message, declared max_bytes 200")
	r = apiSubmit(c, map[string]string{"name": strings.Repeat("a", 40), "message": strings.Repeat("x", 200)}, "k-3")
	ctx.Equal(r.Status, 201, "values exactly at their max_bytes (%s)", r.Text())
	ctx.Equal(apiCount(ctx), 1, "the form must hold only the submission within its limits; submissions")
}

func CheckEscapeMarkup(ctx *harness.Ctx) {
	c := apiClient(ctx)
	r := apiSubmit(c, map[string]string{"message": "<script>alert(1)</script> & thanks"}, "k-1")
	ctx.Equal(r.Status, 201, "a message with markup (%s)", r.Text())
	s := store.LoadSubmission(context.Background(), apiID(r))
	ctx.Assert(s != nil, "the submission %s is not in the store", apiID(r))
	stored := s.Values["message"]
	ctx.Assert(!strings.ContainsAny(stored, "<>"), "the stored message %q still holds raw markup the dashboard would run", stored)
	ctx.Equal(stored, "&lt;script&gt;alert(1)&lt;/script&gt; &amp; thanks", "the markup must be escaped (&lt; &gt; &amp;), not cut out with the submitter's words; the stored message")
}

func CheckReplayId(ctx *harness.Ctx) {
	c := apiClient(ctx)
	first := apiSubmit(c, map[string]string{"name": "Ada"}, "k-1")
	replay := apiSubmit(c, map[string]string{"name": "Ada"}, "k-1")
	ctx.Assert(first.Status == 201 && (replay.Status == 200 || replay.Status == 201), "the first POST answered %d, its replay %d", first.Status, replay.Status)
	ctx.Equal(apiID(replay), apiID(first), "a replay of Idempotency-Key k-1 must answer the first submission_id (one person, one submission)")
	ctx.Equal(apiCount(ctx), 1, "two POSTs with one Idempotency-Key; submissions")
	other := apiSubmit(c, map[string]string{"name": "Grace"}, "k-2")
	ctx.Assert(other.Status == 201 && apiID(other) != apiID(first), "a new key must store a new submission, got %d %s", other.Status, other.Text())
	none := apiSubmit(c, map[string]string{"name": "Ada"}, "")
	ctx.Equal(none.Status, 400, "a POST without Idempotency-Key")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>

#include "forms/store.h"

namespace {

// The author's next version adds phone and drops message; it is not published yet.
const store::Schema kPublished = {{"name", 40}, {"email", 80}, {"message", 200}};
const store::Schema kDraft = {{"name", 40}, {"email", 80}, {"phone", 20}};

harness::HTTP api(harness::Ctx& ctx) {
  store::defineForm("f-1", "u-owner", kPublished, kDraft);
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response submitWith(harness::HTTP& c, const nlohmann::json& fields, const std::string& key) {
  const std::string body = nlohmann::json{{"fields", fields}}.dump();
  if (key.empty()) return c.Post("/v1/forms/f-1/submissions", body, "Content-Type", "application/json");
  return c.Post("/v1/forms/f-1/submissions", body, "Content-Type", "application/json", "Idempotency-Key", key);
}

long long count(harness::Ctx& ctx) { return ctx.Redis.ZCard("form:f-1:submissions"); }

std::string idOf(const harness::Response& r) {
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  return body.is_object() ? body.value("submission_id", "") : "";
}

bool has(const harness::Response& r, const std::string& text) { return r.Text().find(text) != std::string::npos; }

std::string repeat(const std::string& s, int n) {
  std::string out;
  for (int i = 0; i < n; i++) out += s;
  return out;
}

}  // namespace

void CheckPublishedSchema(harness::Ctx& ctx) {
  auto c = api(ctx);
  auto r = submitWith(c, {{"name", "Ada"}, {"message", "Hello"}}, "k-1");
  ctx.Equal(r.Status, 201, "a submission of the published fields name and message (%s); submitters see the published form, whatever the draft dropped", r.Text());
  r = submitWith(c, {{"name", "Ada"}, {"phone", "555-0100"}}, "k-2");
  ctx.Equal(r.Status, 422, "a submission of phone, a field only the unpublished draft declares: a public caller must not write a field the author has not shipped");
  ctx.Assert(has(r, "phone"), "the 422 must name the field phone, got %s", r.Text());
  ctx.Equal(count(ctx), 1, "the form must hold only the valid submission; submissions");
}

void CheckUnknownFields(harness::Ctx& ctx) {
  auto c = api(ctx);
  auto r = submitWith(c, {{"name", "Ada"}, {"is_admin", "true"}, {"plan", "enterprise"}}, "k-1");
  ctx.Equal(r.Status, 422, "a submission with the undeclared fields is_admin and plan");
  ctx.Assert(has(r, "is_admin") && has(r, "plan"), "the 422 must name every undeclared field (is_admin, plan), got %s", r.Text());
  ctx.Equal(count(ctx), 0, "a rejected submission must not be stored; submissions");
  r = submitWith(c, {{"name", "Ada"}}, "k-2");
  ctx.Equal(r.Status, 201, "a submission of declared fields only (%s)", r.Text());
}

void CheckFieldLimits(harness::Ctx& ctx) {
  auto c = api(ctx);
  auto r = submitWith(c, {{"name", repeat("é", 21)}}, "k-1");
  ctx.Equal(r.Status, 422, "21 characters of é (42 bytes) in name, declared max_bytes 40: count the limit in UTF-8 bytes, not characters");
  ctx.Assert(has(r, "name"), "the 422 must name the field, got %s", r.Text());
  r = submitWith(c, {{"message", repeat("x", 201)}}, "k-2");
  ctx.Equal(r.Status, 422, "201 bytes in message, declared max_bytes 200");
  r = submitWith(c, {{"name", repeat("a", 40)}, {"message", repeat("x", 200)}}, "k-3");
  ctx.Equal(r.Status, 201, "values exactly at their max_bytes (%s)", r.Text());
  ctx.Equal(count(ctx), 1, "the form must hold only the submission within its limits; submissions");
}

void CheckEscapeMarkup(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = submitWith(c, {{"message", "<script>alert(1)</script> & thanks"}}, "k-1");
  ctx.Equal(r.Status, 201, "a message with markup (%s)", r.Text());
  const auto s = store::loadSubmission(idOf(r));
  ctx.Assert(s.has_value(), "the submission %s is not in the store", idOf(r));
  const std::string stored = s->values.count("message") ? s->values.at("message") : "";
  ctx.Assert(stored.find_first_of("<>") == std::string::npos, "the stored message %q still holds raw markup the dashboard would run", stored);
  ctx.Equal(stored, "&lt;script&gt;alert(1)&lt;/script&gt; &amp; thanks", "the markup must be escaped (&lt; &gt; &amp;), not cut out with the submitter's words; the stored message");
}

void CheckReplayId(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto first = submitWith(c, {{"name", "Ada"}}, "k-1");
  const auto replay = submitWith(c, {{"name", "Ada"}}, "k-1");
  ctx.Assert(first.Status == 201 && (replay.Status == 200 || replay.Status == 201), "the first POST answered %d, its replay %d", first.Status, replay.Status);
  ctx.Equal(idOf(replay), idOf(first), "a replay of Idempotency-Key k-1 must answer the first submission_id (one person, one submission)");
  ctx.Equal(count(ctx), 1, "two POSTs with one Idempotency-Key; submissions");
  const auto other = submitWith(c, {{"name", "Grace"}}, "k-2");
  ctx.Assert(other.Status == 201 && idOf(other) != idOf(first), "a new key must store a new submission, got %d %s", other.Status, other.Text());
  const auto none = submitWith(c, {{"name", "Ada"}}, "");
  ctx.Equal(none.Status, 400, "a POST without Idempotency-Key");
}
`,
  },
  hints: [
    'Add a field to the draft without publishing it: a public caller can already fill it, a 4 MB message is stored whole, `<b>` in a message comes back with the text around it cut, and a retried POST makes two rows.',
    'The handler reads `draft_schema` and then never compares a field with it; the regex deletes everything between `<` and `>`; and nothing reads `Idempotency-Key`, so each retry is a new insert.',
    'Read `published_schema`, collect an error per undeclared name and per value whose UTF-8 length exceeds `max_bytes` (422), store `html.escape(value)`, and answer `submission_for_key` before inserting, `record_key` after.',
  ],
  debrief: `The published schema is pinned because a published form is a contract with the people filling it in: the draft is the author's workspace, and validating against it lets strangers write fields nobody has shipped. The limit is counted in bytes because storage and downstream columns are. Escaping keeps what the submitter wrote and makes it inert wherever it is rendered; stripping destroys the text and still trusts every other renderer. The key lookup runs before the insert so a client that timed out gets its first answer back. A production intake also expires idempotency records, writes the key and the row in one transaction so a crash between them cannot leave a key without its submission, and returns field errors a form builder can map back to its inputs.`,
};
