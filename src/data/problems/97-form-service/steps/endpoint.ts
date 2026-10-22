import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/forms/{id}/submissions: validation against the pinned schema',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the submission
route, parses the body and stores the fields. It compiles, it serves the demo, and it hides four
production flaws. Review it like the service owner, fix it, and prove the fix with the checks below.

Implement \`POST /v1/forms/{id}/submissions\` with body \`{"fields": {"name": "…", "message": "…"}}\`.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- **Validation runs against the form's published schema version, pinned when the form was loaded.**
  A form keeps a published version and a mutable draft; submissions must be checked against the
  published one, so a field the author has not shipped yet cannot be written by a public caller.
- Unknown fields are rejected field by field (**422**); each rejection names the field.
- A value longer than the field's declared \`max_bytes\` — capped by the service's own ceiling — is
  rejected (**422**).
- Markup is **escaped at rest**, not stripped: the admin dashboard renders field values, so
  \`<script>\` must survive as inert text, and the original input must still be recoverable for an
  audited export. Stripping the tags silently corrupts what the submitter wrote.
- \`Idempotency-Key\` is required (**400** when missing). Replaying the same
  \`(form, key)\` returns the **original** \`submission_id\` instead of storing a second submission.

**Failure mode the checks target.** The draft validates against the *draft* schema, so a published
form accepts fields the author has not shipped; it accepts unknown fields and any length; it strips
markup instead of escaping it, so a stored value cannot be rendered safely and the original text is
lost; and a replay re-stores the submission under a new id, so the same person is counted twice.`,
  sequence: {
    participants: ['Client', 'Form API', 'Schema store', 'Submissions store'],
    messages: [
      {from: 'Client', to: 'Form API', label: 'POST /v1/forms/{id}/submissions · Idempotency-Key', kind: 'sync'},
      {from: 'Form API', to: 'Schema store', label: 'load published schema version pinned at load', kind: 'sync'},
      {from: 'Schema store', to: 'Form API', label: '{fields: {name, email, message} · max_bytes}', kind: 'reply'},
      {
        from: 'Form API',
        to: 'Submissions store',
        label: 'lookup submission by (form, idempotency key)',
        kind: 'sync',
      },
      {
        from: 'Submissions store',
        to: 'Form API',
        label: 'existing submission id — replay returns the original id',
        kind: 'reply',
      },
      {from: 'Form API', to: 'Submissions store', label: 'insert with escaped field values', kind: 'sync'},
      {from: 'Form API', to: 'Client', label: '201 {submission_id} · 422 {errors: [field, error]}', kind: 'reply'},
    ],
  },
  hints: [
    'A form has two versions: the published one the world sees and the draft the author is editing. The handler must resolve the **published** version when it loads the form, not the draft — otherwise a public caller can write fields the author has not shipped. Reject unknown field names against that pinned schema rather than merging them in.',
    'Escaping and stripping are not the same operation. `<b>hi</b>` escaped is `&lt;b&gt;hi&lt;/b&gt;` — inert in HTML, reversible in an export. The same string stripped is `hi` — the submitter’s text is destroyed and no audit trail can recover it. Use the language’s HTML-escape primitive and keep the raw value out of the rendered document.',
    'A replay is a read, not a write: look the `(form, Idempotency-Key)` pair up first and answer with the stored id. Store the pair in the same transaction as the submission so a crash cannot leave the key without its row.',
  ],
  checks: [
    {
      id: 'published-schema',
      title: 'Validates against the published schema version pinned at load',
      detail:
        'Validation resolves the form’s **published** schema version and checks fields against it. The draft validates against the draft version, so a published form accepts fields the author has not shipped yet.',
      match: {
        python: {all: [/PUBLISHED_SCHEMA_VERSION/], none: [/draft_schema/]},
        typescript: {all: [/PUBLISHED_SCHEMA_VERSION/], none: [/draftSchemaVersion/]},
        go: {all: [/publishedSchemaVersion/], none: [/draftSchemaVersion/]},
        scala: {all: [/PublishedSchemaVersion/], none: [/DraftSchemas/]},
        cpp: {all: [/kPublishedSchemaVersion/], none: [/draftSchemaVersion/]},
      },
    },
    {
      id: 'unknown-fields',
      title: 'Rejects unknown fields by name',
      detail:
        'Every field not declared in the pinned schema is rejected and named in the error list (**422**). The draft merges unknown fields straight into storage.',
      match: {
        python: {all: [/unknown field/]},
        typescript: {all: [/unknown field/]},
        go: {all: [/unknown field/]},
        scala: {all: [/unknown field/]},
        cpp: {all: [/unknown field/]},
      },
    },
    {
      id: 'field-limits',
      title: 'Enforces the declared per-field size limit',
      detail:
        'A value longer than the field’s declared `max_bytes`, capped by the service ceiling, is rejected (**422**). The draft stores any length it is handed.',
      match: {
        python: {all: [/MAX_FIELD_BYTES/, /max_bytes/]},
        typescript: {all: [/MAX_FIELD_BYTES/, /maxBytes/]},
        go: {all: [/maxFieldBytes/, /declared/]},
        scala: {all: [/MaxFieldBytes/]},
        cpp: {all: [/kMaxFieldBytes/]},
      },
    },
    {
      id: 'escape-markup',
      title: 'Escapes markup at rest instead of stripping it',
      detail:
        'Stored values are HTML-escaped, so a stored `<script>` renders inert and the original input is recoverable. The draft strips tags with a regex, destroying the value and still leaving an unsafe pipeline.',
      match: {
        python: {all: [/html\.escape/], none: [/strip_tags/]},
        typescript: {all: [/escapeHtml/], none: [/stripTags/]},
        go: {all: [/html\.EscapeString/], none: [/stripTags/]},
        scala: {all: [/escapeHtml/], none: [/stripTags/]},
        cpp: {all: [/EscapeHtml/], none: [/StripTags/]},
      },
    },
    {
      id: 'replay-id',
      title: 'A replay returns the original submission id',
      detail:
        'A repeated `(form, Idempotency-Key)` is looked up and answered with the stored `submission_id` instead of inserting again. The draft ignores the key and stores a second submission.',
      match: {
        python: {all: [/"Idempotency-Key"/, /existing_submission_id/]},
        typescript: {all: [/'Idempotency-Key'/, /existingSubmissionId/]},
        go: {all: [/"Idempotency-Key"/, /existingSubmissionID/]},
        scala: {all: [/"Idempotency-Key"/, /existingSubmissionId/]},
        cpp: {all: [/"Idempotency-Key"/, /ExistingSubmissionId/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import re

from fastapi import FastAPI, Header
from pydantic import BaseModel

app = FastAPI()

forms = {}
submissions = {}


def strip_tags(value: str) -> str:
    return re.sub(r"<[^>]*>", "", value)


class Submission(BaseModel):
    fields: dict


@app.post("/v1/forms/{form_id}/submissions")
def submit(form_id: str, body: Submission, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    # TODO: this draft validates against the form's draft schema version, accepts unknown fields,
    # enforces no size limit, strips markup instead of escaping it, and re-stores a replay.
    form = forms[form_id]
    schema = form["draft_schema_version"]
    submission_id = "sub_" + str(len(submissions) + 1)
    stored = {name: strip_tags(str(value)) for name, value in body.fields.items()}
    submissions[submission_id] = {"form_id": form_id, "fields": stored}
    return {"submission_id": submission_id, "schema_version": schema}
`,
      solution: `import html
import uuid

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

app = FastAPI()

PUBLISHED_SCHEMA_VERSION = "v3"
MAX_FIELD_BYTES = 8000

SCHEMAS = {
    "v3": {
        "fields": {
            "name": {"max_bytes": 200},
            "email": {"max_bytes": 320},
            "message": {"max_bytes": 4000},
        }
    }
}

forms = {}
submissions = {}
submissions_by_key = {}


def existing_submission_id(form_id: str, key: str) -> str | None:
    return submissions_by_key.get((form_id, key))


class Submission(BaseModel):
    fields: dict


@app.post("/v1/forms/{form_id}/submissions")
def submit(
    form_id: str,
    body: Submission,
    idempotency_key: str = Header(alias="Idempotency-Key"),
    tenant: str = Header(alias="X-Tenant-Id"),
) -> dict:
    # The schema is pinned to the version published when the form was loaded, never the draft.
    schema = SCHEMAS[PUBLISHED_SCHEMA_VERSION]
    replayed = existing_submission_id(form_id, idempotency_key)
    if replayed is not None:
        return {"submission_id": replayed, "replayed": True}
    errors = []
    for name, value in body.fields.items():
        declared = schema["fields"].get(name)
        if declared is None:
            errors.append({"field": name, "error": "unknown field"})
        elif len(str(value).encode("utf-8")) > min(declared["max_bytes"], MAX_FIELD_BYTES):
            errors.append({"field": name, "error": "value exceeds declared limit"})
    if errors:
        raise HTTPException(status_code=422, detail={"errors": errors})
    submission_id = "sub_" + uuid.uuid4().hex
    submissions[submission_id] = {
        "form_id": form_id,
        "fields": {name: html.escape(str(value)) for name, value in body.fields.items()},
    }
    submissions_by_key[(form_id, idempotency_key)] = submission_id
    return {"submission_id": submission_id}
`,
    },
    typescript: {
      starter: `/** POST /v1/forms/:id/submissions — a model-generated draft. */
import Fastify from 'fastify';

export const app = Fastify();

const forms: Record<string, {draftSchemaVersion: string}> = {};
const submissions: Record<string, {formId: string; fields: Record<string, string>}> = {};

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, '');
}

app.post('/v1/forms/:id/submissions', async (req, reply) => {
  // TODO: this draft validates against the form's draft schema version, accepts unknown fields,
  // enforces no size limit, strips markup instead of escaping it, and re-stores a replay.
  const {id} = req.params as {id: string};
  const form = forms[id];
  const schemaVersion = form.draftSchemaVersion;
  const submissionId = 'sub_' + String(Object.keys(submissions).length + 1);
  const fields: Record<string, string> = {};
  for (const [name, value] of Object.entries((req.body as {fields?: Record<string, unknown>}).fields ?? {}))
    fields[name] = stripTags(String(value));
  submissions[submissionId] = {formId: id, fields};
  return reply.send({submissionId, schemaVersion});
});
`,
      solution: `/** POST /v1/forms/:id/submissions — validates against the published schema pinned at load. */
import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';

export const app = Fastify();

const PUBLISHED_SCHEMA_VERSION = 'v3';
const MAX_FIELD_BYTES = 8000;

const SCHEMAS: Record<string, {fields: Record<string, {maxBytes: number}>}> = {
  v3: {fields: {name: {maxBytes: 200}, email: {maxBytes: 320}, message: {maxBytes: 4000}}},
};

const submissions: Record<string, {formId: string; fields: Record<string, string>}> = {};
const submissionsByKey: Record<string, string> = {};

function existingSubmissionId(formId: string, key: string): string | undefined {
  return submissionsByKey[formId + '/' + key];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

app.post('/v1/forms/:id/submissions', async (req, reply) => {
  const {id} = req.params as {id: string};
  const key = req.headers['Idempotency-Key'] as string | undefined;
  // The schema is pinned to the version published when the form was loaded, never the draft.
  const schema = SCHEMAS[PUBLISHED_SCHEMA_VERSION];
  const replayed = key === undefined ? undefined : existingSubmissionId(id, key);
  if (replayed !== undefined) return reply.send({submissionId: replayed, replayed: true});
  const errors: {field: string; error: string}[] = [];
  for (const [name, value] of Object.entries((req.body as {fields?: Record<string, unknown>}).fields ?? {})) {
    const declared = schema.fields[name];
    if (declared === undefined) errors.push({field: name, error: 'unknown field'});
    else if (Buffer.byteLength(String(value), 'utf8') > Math.min(declared.maxBytes, MAX_FIELD_BYTES))
      errors.push({field: name, error: 'value exceeds declared limit'});
  }
  if (errors.length > 0) return reply.code(422).send({errors});
  const fields: Record<string, string> = {};
  for (const [name, value] of Object.entries((req.body as {fields?: Record<string, unknown>}).fields ?? {}))
    fields[name] = escapeHtml(String(value));
  const submissionId = 'sub_' + randomUUID();
  submissions[submissionId] = {formId: id, fields};
  if (key !== undefined) submissionsByKey[id + '/' + key] = submissionId;
  return reply.send({submissionId});
});
`,
    },
    go: {
      starter:
        `package formapi

import (
	"encoding/json"
	"net/http"
	"regexp"
)

var tagPattern = regexp.MustCompile("<[^>]*>")

func stripTags(value string) string {
	return tagPattern.ReplaceAllString(value, "")
}

var forms = map[string]map[string]any{}
var submissions = map[string]map[string]string{}

func Submit(w http.ResponseWriter, r *http.Request) {
	// TODO: this draft validates against the form's draft schema version, accepts unknown fields,
	// enforces no size limit, strips markup instead of escaping it, and re-stores a replay.
	var body struct {
		Fields map[string]string ` +
        '`' +
        `json:"fields"` +
        '`' +
        `
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	formID := r.PathValue("id")
	schemaVersion := forms[formID]["draftSchemaVersion"]
	fields := map[string]string{}
	for name, value := range body.Fields {
		fields[name] = stripTags(value)
	}
	submissionID := "sub_" + formID
	submissions[submissionID] = fields
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"submissionId": submissionID, "schemaVersion": schemaVersion})
}
`,
      solution:
        `package formapi

import (
	"encoding/json"
	"html"
	"net/http"
)

const (
	publishedSchemaVersion = "v3"
	maxFieldBytes          = 8000
)

var schemas = map[string]map[string]int{
	"v3": {"name": 200, "email": 320, "message": 4000},
}

var submissions = map[string]map[string]string{}
var submissionsByKey = map[string]string{}

func existingSubmissionID(formID, key string) (string, bool) {
	id, ok := submissionsByKey[formID+"/"+key]
	return id, ok
}

func Submit(w http.ResponseWriter, r *http.Request) {
	formID := r.PathValue("id")
	key := r.Header.Get("Idempotency-Key")
	// The schema is pinned to the version published when the form was loaded, never the draft.
	fields := schemas[publishedSchemaVersion]
	if existing, ok := existingSubmissionID(formID, key); ok {
		writeJSON(w, http.StatusOK, map[string]any{"submissionId": existing, "replayed": true})
		return
	}
	var body struct {
		Fields map[string]string ` +
        '`' +
        `json:"fields"` +
        '`' +
        `
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	var errs []map[string]string
	stored := map[string]string{}
	for name, value := range body.Fields {
		limit, declared := fields[name]
		if !declared {
			errs = append(errs, map[string]string{"field": name, "error": "unknown field"})
			continue
		}
		if size := len([]byte(value)); size > limit || size > maxFieldBytes {
			errs = append(errs, map[string]string{"field": name, "error": "value exceeds declared limit"})
			continue
		}
		stored[name] = html.EscapeString(value)
	}
	if len(errs) > 0 {
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"errors": errs})
		return
	}
	submissionID := "sub_" + key
	submissions[submissionID] = stored
	submissionsByKey[formID+"/"+key] = submissionID
	writeJSON(w, http.StatusCreated, map[string]any{"submissionId": submissionID})
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.server.Route
import org.apache.pekko.http.scaladsl.server.Directives._

object Api {
  private val TagPattern = "<[^>]*>".r

  def stripTags(value: String): String = TagPattern.replaceAllIn(value, "")

  var submissions: Map[String, Map[String, String]] = Map.empty

  val routes: Route = path("v1" / "forms" / Segment / "submissions") { formId =>
    post {
      // TODO: this draft validates against the form's draft schema version, accepts unknown fields,
      // enforces no size limit, strips markup instead of escaping it, and re-stores a replay.
      entity(as[Map[String, String]]) { body =>
        val schema = DraftSchemas.latest(formId)
        val stored = body.map { case (name, value) => name -> stripTags(value) }
        submissions = submissions.updated("sub_" + formId, stored)
        complete(s"""{"submissionId":"sub_$formId","schemaVersion":"$schema"}""")
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Route
import org.apache.pekko.http.scaladsl.server.Directives._

import java.util.UUID

object Api {
  val PublishedSchemaVersion = "v3"
  val MaxFieldBytes = 8000

  val Schemas: Map[String, Map[String, Int]] = Map(
    "v3" -> Map("name" -> 200, "email" -> 320, "message" -> 4000)
  )

  var submissions: Map[String, Map[String, String]] = Map.empty
  var submissionsByKey: Map[String, String] = Map.empty

  def existingSubmissionId(formId: String, key: String): Option[String] =
    submissionsByKey.get(formId + "/" + key)

  def escapeHtml(value: String): String =
    value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\\"", "&quot;")

  val routes: Route = path("v1" / "forms" / Segment / "submissions") { formId =>
    post {
      headerValueByName("Idempotency-Key") { key =>
        // The schema is pinned to the version published when the form was loaded, never the draft.
        val fields = Schemas(PublishedSchemaVersion)
        existingSubmissionId(formId, key) match {
          case Some(existing) => complete(StatusCodes.OK -> s"""{"submissionId":"$existing","replayed":true}""")
          case None =>
            entity(as[Map[String, String]]) { body =>
              val errors = body.collect {
                case (name, _) if !fields.contains(name) => name
              }
              if (errors.nonEmpty) {
                val rendered = errors.map(name => s"""{"field":"$name","error":"unknown field"}""").mkString(",")
                complete(StatusCodes.UnprocessableEntity -> s"""{"errors":[$rendered]}""")
              } else {
                val oversized = body.exists { case (name, value) =>
                  value.getBytes("UTF-8").length > Math.min(fields(name), MaxFieldBytes)
                }
                if (oversized) {
                  complete(StatusCodes.UnprocessableEntity -> s"""{"errors":[{"error":"value exceeds declared limit"}]}""")
                } else {
                  val id = "sub_" + UUID.randomUUID().toString
                  submissions = submissions.updated(id, body.map { case (name, value) => name -> escapeHtml(value) })
                  submissionsByKey = submissionsByKey.updated(formId + "/" + key, id)
                  complete(StatusCodes.Created -> s"""{"submissionId":"$id"}""")
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

#include <regex>
#include <string>

using json = nlohmann::json;

static std::string StripTags(const std::string& value) {
  return std::regex_replace(value, std::regex("<[^>]*>"), "");
}

void RegisterRoutes(httplib::Server& svr, FormStore& forms, SubmissionStore& submissions) {
  svr.Post("/v1/forms/([^/]+)/submissions", [&](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft validates against the form's draft schema version, accepts unknown fields,
    // enforces no size limit, strips markup instead of escaping it, and re-stores a replay.
    const std::string formId = req.matches[1];
    json form = forms.Get(formId);
    const std::string schemaVersion = form["draftSchemaVersion"];
    json fields = json::object();
    for (auto& [name, value] : json::parse(req.body)["fields"].items())
      fields[name] = StripTags(value.get<std::string>());
    const std::string submissionId = "sub_" + formId;
    submissions.Put(submissionId, fields.dump());
    res.status = 200;
    res.set_content(json{{"submissionId", submissionId}, {"schemaVersion", schemaVersion}}.dump(), "application/json");
  });
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <map>
#include <string>
#include <vector>

using json = nlohmann::json;

static const char* kPublishedSchemaVersion = "v3";
static const int kMaxFieldBytes = 8000;

static const std::map<std::string, std::map<std::string, int>> schemas = {
    {"v3", {{"name", 200}, {"email", 320}, {"message", 4000}}},
};

static std::string EscapeHtml(const std::string& value) {
  std::string out;
  out.reserve(value.size());
  for (const char c : value) {
    if (c == '&') out += "&amp;";
    else if (c == '<') out += "&lt;";
    else if (c == '>') out += "&gt;";
    else if (c == '"') out += "&quot;";
    else out += c;
  }
  return out;
}

static bool ExistingSubmissionId(const std::string& formId, const std::string& key, std::string& out) {
  return false;
}

void RegisterRoutes(httplib::Server& svr, FormStore& forms, SubmissionStore& submissions) {
  svr.Post("/v1/forms/([^/]+)/submissions", [&](const httplib::Request& req, httplib::Response& res) {
    const std::string formId = req.matches[1];
    const std::string key = req.get_header_value("Idempotency-Key");
    // The schema is pinned to the version published when the form was loaded, never the draft.
    const auto& fields = schemas.at(kPublishedSchemaVersion);
    std::string existing;
    if (ExistingSubmissionId(formId, key, existing)) {
      res.status = 200;
      res.set_content(json{{"submissionId", existing}, {"replayed", true}}.dump(), "application/json");
      return;
    }
    const json body = json::parse(req.body);
    json errors = json::array();
    json stored = json::object();
    for (auto& [name, value] : body["fields"].items()) {
      const auto declared = fields.find(name);
      if (declared == fields.end()) {
        errors.push_back(json{{"field", name}, {"error", "unknown field"}});
        continue;
      }
      const std::string text = value.get<std::string>();
      if (static_cast<int>(text.size()) > declared->second || static_cast<int>(text.size()) > kMaxFieldBytes) {
        errors.push_back(json{{"field", name}, {"error", "value exceeds declared limit"}});
        continue;
      }
      stored[name] = EscapeHtml(text);
    }
    if (!errors.empty()) {
      res.status = 422;
      res.set_content(json{{"errors", errors}}.dump(), "application/json");
      return;
    }
    const std::string submissionId = "sub_" + key;
    submissions.Put(submissionId, stored.dump());
    res.status = 201;
    res.set_content(json{{"submissionId", submissionId}}.dump(), "application/json");
  });
}
`,
    },
  },
  debrief: `The interviewer is testing whether you can review a generated handler at the trust boundary. The draft reads fine because the demo posts well-formed fields from one tenant and never retries. The subtle flaw is the schema version: the handler resolves the *draft* schema, so a field the author has not published is accepted from a public caller — the published version is the contract, and it must be pinned when the form is loaded. Escaping rather than stripping matters because the admin dashboard renders stored values: stripping tags destroys the submitter's text and still leaves the pipeline unsafe, while escaping renders it inert and keeps the raw value recoverable for an audited export. Idempotency closes the last hole: a replay must return the original id, which means the key is stored in the same transaction as the submission. Real systems add per-form captcha, rate limits keyed on form and IP, and a signed schema version in the response so the client knows which contract it wrote against.`,
};
