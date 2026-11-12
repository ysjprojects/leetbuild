import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/audit/decisions: append, never edit',
  concept: 'http',
  guides: ['request-boundaries'],
  file: 'api',
  focus: ['client', 'auditd', 'db'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/audit/decisions\` with body \`{"model_version",
"policy_id", "input_digest", "decision_digest"}\` on the provided ledger (\`audit.ledger\`): it takes
the tenant from the body (the \`X-Tenant-Id\` header when the body names none), stores the body as it
came with \`recorded_at\` set from the caller's \`timestamp\`, answers **201** with the record, and keeps
a \`PATCH /v1/audit/decisions/{id}\` route that rewrites a record through \`ledger.update\`. It serves the
demo and hides 4 flaws.

**Failure mode the checks target.** One tenant writes into another tenant's trail; a prompt sent
along with the digests lands in the ledger; a client backdates its decisions; and an old record can
be rewritten after the fact.

- The tenant is the authenticated \`X-Tenant-Id\` header and nothing else; a missing one is **401**.
- \`model_version\` and \`policy_id\` are non-empty and both digests pass the provided \`is_digest\`
  (64 lower-case hex digits), else **400**. Only these four fields reach \`ledger.insert\`.
- \`recorded_at\` is the server clock in ms, strictly after the tenant's last record:
  \`max(now_ms, ledger.last_recorded_at(tenant) + 1)\`.
- No route edits a record: \`PUT\`, \`PATCH\` and \`DELETE\` on \`/v1/audit/decisions/{id}\` answer **405**.`,
  sequence: {
    participants: ['Client', 'Audit Service', 'ledger'],
    messages: [
      {from: 'Client', to: 'Audit Service', label: 'POST /v1/audit/decisions · X-Tenant-Id · digests', kind: 'sync'},
      {from: 'Audit Service', to: 'Audit Service', label: '401 without a tenant · 400 on a bad digest', kind: 'sync'},
      {from: 'Audit Service', to: 'ledger', label: 'last_recorded_at(tenant)', kind: 'sync'},
      {
        from: 'Audit Service',
        to: 'ledger',
        label: 'insert(tenant, four fields · recorded_at = max(now, last + 1))',
        kind: 'sync',
      },
      {from: 'Audit Service', to: 'Client', label: '201 {id, digests, recorded_at}', kind: 'reply'},
      {from: 'Client', to: 'Audit Service', label: 'PATCH /v1/audit/decisions/{id}', kind: 'sync'},
      {from: 'Audit Service', to: 'Client', label: '405: the trail has no edits', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Serves POST /v1/audit/decisions',
      detail: 'Register the append on `POST /v1/audit/decisions`; it answers **201** with the stored record.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/audit\/decisions["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/audit\/decisions['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/audit\/decisions"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"audit"\s*\/\s*"decisions"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/audit\/decisions"/]},
      },
    },
    {
      id: 'tenant-header',
      title: 'The tenant is the authenticated header',
      detail:
        'The tenant is read from `X-Tenant-Id` only (a missing one is **401**); a `tenant` field in the body is ignored, so a caller cannot write into another tenant’s trail.',
      match: {
        python: {all: [/x-tenant-id/i, /\b401\b/], none: [/body(\.get\(|\[)\s*["']tenant["']/]},
        typescript: {all: [/x-tenant-id/i, /code\(401\)/], none: [/body\.tenant\b|body\[['"]tenant['"]\]/]},
        go: {all: [/Header\.Get\("X-Tenant-Id"\)/, /StatusUnauthorized/], none: [/body\["tenant"\]/]},
        scala: {all: [/"X-Tenant-Id"/, /Unauthorized/], none: [/body\.(getOrElse|get)\(\s*"tenant"/]},
        cpp: {all: [/get_header_value\(\s*"X-Tenant-Id"\s*\)/, /\b401\b/], none: [/body\.value\(\s*"tenant"/]},
      },
    },
    {
      id: 'digests-only',
      title: 'Only validated digests reach the ledger',
      detail:
        'Both digests pass `is_digest`/`isDigest` and the text fields are non-empty (**400** otherwise), and only the four named fields are inserted: the body as a whole never reaches `ledger.insert`, so a prompt sent along is dropped.',
      match: {
        python: {all: [/is_digest\(/, /\b400\b/], none: [/\*\*body\b/, /dict\(body\)/]},
        typescript: {all: [/isDigest\(/, /code\(400\)/], none: [/\.\.\.body\b/]},
        go: {all: [/digest\.IsDigest\(/, /StatusBadRequest|\b400\b/], none: [/fields\s*:=\s*body\b/]},
        scala: {all: [/Digest\.isDigest\(/, /BadRequest/], none: [/Ledger\.insert\(\s*tenant,\s*body\b/]},
        cpp: {all: [/digest::isDigest\(/, /\b400\b/], none: [/fields\s*=\s*body\s*;/]},
      },
    },
    {
      id: 'server-time',
      title: 'recorded_at is the server clock, monotonic per tenant',
      detail:
        '`recorded_at` is `max(now_ms, last_recorded_at(tenant) + 1)` from the server clock; the caller’s `timestamp` is never read, so nobody can backdate a decision.',
      match: {
        python: {all: [/ledger\.last_recorded_at\(/, /time\.time\(\)/], none: [/["']timestamp["']/]},
        typescript: {all: [/lastRecordedAt\(/, /Date\.now\(\)/], none: [/\btimestamp\b/]},
        go: {all: [/ledger\.LastRecordedAt\(/, /time\.Now\(\)/], none: [/"timestamp"/]},
        scala: {all: [/Ledger\.lastRecordedAt\(/, /System\.currentTimeMillis\(\)/], none: [/"timestamp"/]},
        cpp: {all: [/ledger::lastRecordedAt\(/, /system_clock::now\(\)/], none: [/"timestamp"/]},
      },
    },
    {
      id: 'append-only',
      title: 'No edit route; PUT, PATCH and DELETE are 405',
      detail:
        'Nothing calls `ledger.update`, and an edit attempt on `/v1/audit/decisions/{id}` answers **405**: a correction is a new record, never a rewrite of an old one.',
      match: {
        python: {all: [/\b405\b/], none: [/ledger\.update\(/]},
        typescript: {all: [/code\(405\)/], none: [/\bupdate\(/]},
        go: {all: [/StatusMethodNotAllowed|\b405\b/], none: [/ledger\.Update\(/]},
        scala: {all: [/MethodNotAllowed/], none: [/Ledger\.update\(/]},
        cpp: {all: [/\b405\b/], none: [/ledger::update\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from audit import ledger  # insert, get, update, last_recorded_at
from audit.digest import is_digest

app = FastAPI()


@app.post("/v1/audit/decisions")
async def append_decision(request: Request) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    body = await request.json()
    tenant = body.get("tenant") or request.headers.get("x-tenant-id", "")
    fields = {**body, "recorded_at": body.get("timestamp", int(time.time() * 1000))}
    record = ledger.insert(tenant, fields)
    return JSONResponse(record, status_code=201)


@app.patch("/v1/audit/decisions/{record_id}")
async def correct_decision(record_id: str, request: Request) -> JSONResponse:
    record = ledger.update(record_id, await request.json())
    if record is None:
        raise HTTPException(status_code=404, detail="no such record")
    return JSONResponse(record)
`,
      solution: `import time

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from audit import ledger  # insert, get, update, last_recorded_at
from audit.digest import is_digest

app = FastAPI()

TEXT_FIELDS = ("model_version", "policy_id")
DIGEST_FIELDS = ("input_digest", "decision_digest")


@app.post("/v1/audit/decisions")
async def append_decision(request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        return JSONResponse({"error": "X-Tenant-Id is required"}, status_code=401)
    body = await request.json()
    for name in TEXT_FIELDS:
        if not isinstance(body.get(name), str) or body[name] == "":
            return JSONResponse({"error": f"{name} is required"}, status_code=400)
    for name in DIGEST_FIELDS:
        if not is_digest(body.get(name)):
            return JSONResponse({"error": f"{name} must be 64 lower-case hex digits"}, status_code=400)
    # Digests only: whatever else the caller sent (a prompt, the decision text) never reaches the ledger.
    fields = {name: body[name] for name in TEXT_FIELDS + DIGEST_FIELDS}
    # The server's clock, never the caller's, and strictly after the tenant's last record.
    fields["recorded_at"] = max(int(time.time() * 1000), ledger.last_recorded_at(tenant) + 1)
    return JSONResponse(ledger.insert(tenant, fields), status_code=201)


@app.api_route("/v1/audit/decisions/{record_id}", methods=["PUT", "PATCH", "DELETE"])
async def no_edits(record_id: str) -> JSONResponse:
    # The trail is append-only: a correction is a new record, not an edit of an old one.
    return JSONResponse({"error": "audit records are append-only"}, status_code=405)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {isDigest} from 'audit/digest';
import {get, insert, lastRecordedAt, update} from 'audit/ledger';

export const app = Fastify();

app.post('/v1/audit/decisions', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const body = request.body as Record<string, unknown>;
  const tenant = (body.tenant as string | undefined) || String(request.headers['x-tenant-id'] ?? '');
  const record = await insert(tenant, {...body, recorded_at: body.timestamp ?? Date.now()});
  return reply.code(201).send(record);
});

app.patch('/v1/audit/decisions/:recordId', async (request, reply) => {
  const {recordId} = request.params as {recordId: string};
  const record = await update(recordId, request.body as Record<string, unknown>);
  if (record === null) return reply.code(404).send({error: 'no such record'});
  return record;
});
`,
      solution: `import Fastify, {type FastifyReply} from 'fastify';

import {isDigest} from 'audit/digest';
import {get, insert, lastRecordedAt, update} from 'audit/ledger';

export const app = Fastify();

const TEXT_FIELDS = ['model_version', 'policy_id'] as const;
const DIGEST_FIELDS = ['input_digest', 'decision_digest'] as const;

app.post('/v1/audit/decisions', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const body = (request.body ?? {}) as Record<string, unknown>;
  for (const name of TEXT_FIELDS) {
    if (typeof body[name] !== 'string' || body[name] === '') return reply.code(400).send({error: \`\${name} is required\`});
  }
  for (const name of DIGEST_FIELDS) {
    if (!isDigest(body[name])) return reply.code(400).send({error: \`\${name} must be 64 lower-case hex digits\`});
  }
  // Digests only: whatever else the caller sent (a prompt, the decision text) never reaches the ledger.
  const fields: Record<string, unknown> = {};
  for (const name of [...TEXT_FIELDS, ...DIGEST_FIELDS]) fields[name] = body[name];
  // The server's clock, never the caller's, and strictly after the tenant's last record.
  fields.recorded_at = Math.max(Date.now(), (await lastRecordedAt(tenant)) + 1);
  return reply.code(201).send(await insert(tenant, fields));
});

// The trail is append-only: a correction is a new record, not an edit of an old one.
const noEdits = async (_request: unknown, reply: FastifyReply) => reply.code(405).send({error: 'audit records are append-only'});
app.put('/v1/audit/decisions/:recordId', noEdits);
app.patch('/v1/audit/decisions/:recordId', noEdits);
app.delete('/v1/audit/decisions/:recordId', noEdits);
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
	"time"

	"audit/ledger" // ledger.Insert, Get, Update, LastRecordedAt
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func appendDecision(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	body := map[string]any{}
	json.NewDecoder(r.Body).Decode(&body)
	tenant, _ := body["tenant"].(string)
	if tenant == "" {
		tenant = r.Header.Get("X-Tenant-Id")
	}
	fields := body
	fields["recorded_at"] = body["timestamp"]
	if fields["recorded_at"] == nil {
		fields["recorded_at"] = time.Now().UnixMilli()
	}
	record, err := ledger.Insert(r.Context(), tenant, fields)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(rw, http.StatusCreated, record)
}

func correctDecision(rw http.ResponseWriter, r *http.Request) {
	fields := map[string]any{}
	json.NewDecoder(r.Body).Decode(&fields)
	record := ledger.Update(r.Context(), r.PathValue("id"), fields)
	if record == nil {
		http.Error(rw, "no such record", http.StatusNotFound)
		return
	}
	writeJSON(rw, http.StatusOK, record)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/audit/decisions", appendDecision)
	mux.HandleFunc("PATCH /v1/audit/decisions/{id}", correctDecision)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"time"

	"audit/digest" // digest.IsDigest
	"audit/ledger" // ledger.Insert, Get, Update, LastRecordedAt
)

var (
	textFields   = []string{"model_version", "policy_id"}
	digestFields = []string{"input_digest", "decision_digest"}
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

// stringField is body[name] when it is a string, else "".
func stringField(body map[string]any, name string) string {
	if s, ok := body[name].(string); ok {
		return s
	}
	return ""
}

func appendDecision(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	body := map[string]any{}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "the body is not a JSON object"})
		return
	}
	// Digests only: whatever else the caller sent (a prompt, the decision text) never reaches the ledger.
	fields := map[string]any{}
	for _, name := range textFields {
		value := stringField(body, name)
		if value == "" {
			writeJSON(rw, http.StatusBadRequest, map[string]string{"error": name + " is required"})
			return
		}
		fields[name] = value
	}
	for _, name := range digestFields {
		value := stringField(body, name)
		if !digest.IsDigest(value) {
			writeJSON(rw, http.StatusBadRequest, map[string]string{"error": name + " must be 64 lower-case hex digits"})
			return
		}
		fields[name] = value
	}
	// The server's clock, never the caller's, and strictly after the tenant's last record.
	recordedAt := time.Now().UnixMilli()
	if last := ledger.LastRecordedAt(r.Context(), tenant); recordedAt <= last {
		recordedAt = last + 1
	}
	fields["recorded_at"] = recordedAt
	record, err := ledger.Insert(r.Context(), tenant, fields)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(rw, http.StatusCreated, record)
}

// noEdits answers every edit attempt: the trail is append-only, a correction is a new record.
func noEdits(rw http.ResponseWriter, r *http.Request) {
	writeJSON(rw, http.StatusMethodNotAllowed, map[string]string{"error": "audit records are append-only"})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/audit/decisions", appendDecision)
	mux.HandleFunc("PUT /v1/audit/decisions/{id}", noEdits)
	mux.HandleFunc("PATCH /v1/audit/decisions/{id}", noEdits)
	mux.HandleFunc("DELETE /v1/audit/decisions/{id}", noEdits)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import audit.Ledger // Ledger.insert, get, update, lastRecordedAt, toJson

object Api {
  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  /** A request body as field name to text (a number as its digits). */
  private def fields(raw: String): Map[String, String] = raw.parseJson.asJsObject.fields.collect {
    case (name, JsString(s)) => name -> s
    case (name, JsNumber(n)) => name -> n.toBigInt.toString
  }

  val route: Route = concat(
    path("v1" / "audit" / "decisions") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { header =>
          entity(as[String]) { raw =>
            // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
            val body = fields(raw)
            val tenant = body.getOrElse("tenant", header.getOrElse(""))
            val recordedAt = body.getOrElse("timestamp", System.currentTimeMillis().toString)
            val record = Ledger.insert(tenant, body + ("recorded_at" -> recordedAt))
            complete(json(StatusCodes.Created, Ledger.toJson(record)))
          }
        }
      }
    },
    path("v1" / "audit" / "decisions" / Segment) { recordId =>
      patch {
        entity(as[String]) { raw =>
          Ledger.update(recordId, fields(raw)) match {
            case Some(record) => complete(json(StatusCodes.OK, Ledger.toJson(record)))
            case None => complete(StatusCodes.NotFound -> "no such record")
          }
        }
      }
    },
  )
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import audit.{Digest, Ledger} // Digest.isDigest; Ledger.insert, get, update, lastRecordedAt, toJson

object Api {
  val TextFields: Seq[String] = Seq("model_version", "policy_id")
  val DigestFields: Seq[String] = Seq("input_digest", "decision_digest")

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  /** A request body as field name to text (a number as its digits). */
  private def fields(raw: String): Map[String, String] = raw.parseJson.asJsObject.fields.collect {
    case (name, JsString(s)) => name -> s
    case (name, JsNumber(n)) => name -> n.toBigInt.toString
  }

  /** The first field that is missing or malformed. */
  private def invalid(body: Map[String, String]): Option[String] =
    TextFields.find(name => body.getOrElse(name, "").isEmpty).orElse(DigestFields.find(name => !Digest.isDigest(body.getOrElse(name, ""))))

  private val appendOnly = json(StatusCodes.MethodNotAllowed, JsObject("error" -> JsString("audit records are append-only")))

  val route: Route = concat(
    path("v1" / "audit" / "decisions") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") {
          case None | Some("") => complete(json(StatusCodes.Unauthorized, JsObject("error" -> JsString("X-Tenant-Id is required"))))
          case Some(tenant) =>
            entity(as[String]) { raw =>
              val body = fields(raw)
              invalid(body) match {
                case Some(name) => complete(json(StatusCodes.BadRequest, JsObject("error" -> JsString(s"$name is missing or malformed"))))
                case None =>
                  // Digests only: whatever else the caller sent (a prompt, the decision text) never reaches the ledger.
                  val kept = (TextFields ++ DigestFields).map(name => name -> body(name)).toMap
                  // The server's clock, never the caller's, and strictly after the tenant's last record.
                  val recordedAt = math.max(System.currentTimeMillis(), Ledger.lastRecordedAt(tenant) + 1)
                  complete(json(StatusCodes.Created, Ledger.toJson(Ledger.insert(tenant, kept + ("recorded_at" -> recordedAt.toString)))))
              }
            }
        }
      }
    },
    // The trail is append-only: a correction is a new record, not an edit of an old one.
    path("v1" / "audit" / "decisions" / Segment) { _ =>
      (put | patch | delete) {
        complete(appendOnly)
      }
    },
  )
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <string>

#include "audit/ledger.h"  // ledger::insert, get, update, lastRecordedAt, toJson

using json = nlohmann::json;

long long now_ms() {
  using namespace std::chrono;
  return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}

void append_decision(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const json body = json::parse(req.body);
  std::string tenant = body.value("tenant", "");
  if (tenant.empty()) tenant = req.get_header_value("X-Tenant-Id");
  json fields = body;
  fields["recorded_at"] = body.contains("timestamp") ? body["timestamp"] : json(now_ms());
  const ledger::Decision record = ledger::insert(tenant, fields);
  res.status = 201;
  res.set_content(ledger::toJson(record).dump(), "application/json");
}

void correct_decision(const httplib::Request& req, httplib::Response& res) {
  const auto record = ledger::update(req.matches[1], json::parse(req.body));
  if (!record) {
    res.status = 404;
    res.set_content("no such record", "text/plain");
    return;
  }
  res.set_content(ledger::toJson(*record).dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/audit/decisions", append_decision);
  svr.Patch(R"(/v1/audit/decisions/([\\w-]+))", correct_decision);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <string>
#include <vector>

#include "audit/digest.h"  // digest::isDigest
#include "audit/ledger.h"  // ledger::insert, get, update, lastRecordedAt, toJson

using json = nlohmann::json;

const std::vector<std::string> kTextFields = {"model_version", "policy_id"};
const std::vector<std::string> kDigestFields = {"input_digest", "decision_digest"};

long long now_ms() {
  using namespace std::chrono;
  return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void append_decision(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, {{"error", "X-Tenant-Id is required"}});
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return reply(res, 400, {{"error", "the body is not a JSON object"}});
  // Digests only: whatever else the caller sent (a prompt, the decision text) never reaches the ledger.
  json fields = json::object();
  for (const std::string& name : kTextFields) {
    if (!body.contains(name) || !body.at(name).is_string() || body.at(name).get<std::string>().empty()) {
      return reply(res, 400, {{"error", name + " is required"}});
    }
    fields[name] = body.at(name);
  }
  for (const std::string& name : kDigestFields) {
    if (!body.contains(name) || !body.at(name).is_string() || !digest::isDigest(body.at(name).get<std::string>())) {
      return reply(res, 400, {{"error", name + " must be 64 lower-case hex digits"}});
    }
    fields[name] = body.at(name);
  }
  // The server's clock, never the caller's, and strictly after the tenant's last record.
  fields["recorded_at"] = std::max(now_ms(), ledger::lastRecordedAt(tenant) + 1);
  reply(res, 201, ledger::toJson(ledger::insert(tenant, fields)));
}

// The trail is append-only: a correction is a new record, not an edit of an old one.
void no_edits(const httplib::Request&, httplib::Response& res) { reply(res, 405, {{"error", "audit records are append-only"}}); }

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/audit/decisions", append_decision);
  svr.Put(R"(/v1/audit/decisions/([\\w-]+))", no_edits);
  svr.Patch(R"(/v1/audit/decisions/([\\w-]+))", no_edits);
  svr.Delete(R"(/v1/audit/decisions/([\\w-]+))", no_edits);
}
`,
    },
  },
  harness: {
    python: `import hashlib
import time

from audit import ledger

IN = hashlib.sha256(b"input:ticket-4411").hexdigest()
OUT = hashlib.sha256(b"decision:approve").hexdigest()
BODY = {"model_version": "risk-v7", "policy_id": "refunds-2026-10", "input_digest": IN, "decision_digest": OUT}
T1 = {"X-Tenant-Id": "t1"}
PROMPT = "Customer 4411 asks for a refund of order 9921 after the kettle broke"
ALLOWED = {"id", "tenant", "model_version", "policy_id", "input_digest", "decision_digest", "recorded_at", "position", "status"}


def _api(ctx):
    return ctx.client(ctx.load("api").app)


async def _append(c, body=None, headers=None):
    return await c.post("/v1/audit/decisions", json=BODY if body is None else body, headers=T1 if headers is None else headers)


def _records(ctx):
    return sorted(ctx.redis.keys("audit:rec:*"))


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await _append(c)
    assert r.status_code == 201, f"POST /v1/audit/decisions answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("id"), f"the answer must carry the record id, got {body}"
    stored = ledger.get(body["id"])
    assert stored is not None, f"the answer names {body['id']} but the ledger has no such record ({_records(ctx)})"
    for name, value in BODY.items():
        assert stored.get(name) == value and body.get(name) == value, f"{name}: the ledger holds {stored.get(name)!r} and the answer {body.get(name)!r}, expected {value!r}"


async def check_tenant_header(ctx):
    async with _api(ctx) as c:
        anonymous = await _append(c, headers={})
        assert anonymous.status_code == 401, f"an append without X-Tenant-Id answered {anonymous.status_code}, expected 401: the tenant is the authenticated header"
        assert _records(ctx) == [], f"an append without a tenant was stored: {_records(ctx)}"
        spoofed = await _append(c, body={**BODY, "tenant": "t2"})
    assert spoofed.status_code == 201, f"an append as t1 answered {spoofed.status_code}: {spoofed.text}"
    record = ledger.get(spoofed.json()["id"])
    assert record["tenant"] == "t1", f"a caller authenticated as t1 wrote a record into tenant {record['tenant']!r} by naming it in the body: the tenant comes from X-Tenant-Id only"


async def check_digests_only(ctx):
    async with _api(ctx) as c:
        r = await _append(c, body={**BODY, "prompt": PROMPT, "decision": "approve the refund"})
        assert r.status_code == 201, f"a valid append with extra fields answered {r.status_code}: {r.text}"
        raw = ctx.redis.hgetall(f"audit:rec:{r.json()['id']}")
        extra = sorted(set(raw) - ALLOWED)
        assert not extra, f"the ledger row holds {extra} ({raw}): the body went to the ledger as it came. Only model_version, policy_id and the two digests are stored"
        assert "kettle" not in r.text, f"the answer echoes the prompt: {r.text}"
        bad = [
            ({**BODY, "input_digest": IN.upper()}, "an upper-case input_digest"),
            ({**BODY, "decision_digest": OUT[:63]}, "a 63-character decision_digest"),
            ({**BODY, "decision_digest": PROMPT}, "a decision_digest holding text"),
            ({k: v for k, v in BODY.items() if k != "input_digest"}, "no input_digest"),
            ({**BODY, "model_version": ""}, "an empty model_version"),
            ({k: v for k, v in BODY.items() if k != "policy_id"}, "no policy_id"),
        ]
        for body, what in bad:
            r = await _append(c, body=body)
            assert r.status_code == 400, f"an append with {what} answered {r.status_code}, expected 400"
    assert len(_records(ctx)) == 1, f"a rejected append was stored: {_records(ctx)}"


async def check_server_time(ctx):
    now = int(time.time() * 1000)
    backdated = {**BODY, "timestamp": 1262304000000}
    async with _api(ctx) as c:
        first = await _append(c, body=backdated)
        second = await _append(c, body=backdated)
        third = await _append(c)
        other = await _append(c, headers={"X-Tenant-Id": "t2"})
        ctx.clock.advance(5)
        later = await _append(c)
    at = [r.json().get("recorded_at") for r in (first, second, third)]
    assert isinstance(at[0], int) and abs(at[0] - now) <= 1000, f"recorded_at is {at[0]!r} while the server clock reads {now}: the caller's timestamp (2010-01-01) was kept. recorded_at comes from the server clock"
    assert at[1] == at[0] + 1 and at[2] == at[0] + 2, f"three appends in one millisecond got recorded_at {at}, expected {[at[0], at[0] + 1, at[0] + 2]}: each record of a tenant lands strictly after the tenant's last one"
    assert abs(other.json()["recorded_at"] - now) <= 1000, f"t2's first record got recorded_at {other.json()['recorded_at']}, expected the clock ({now}): the order is per tenant"
    assert abs(later.json()["recorded_at"] - (now + 5000)) <= 1000, f"five seconds later recorded_at is {later.json()['recorded_at']}, expected about {now + 5000}"
    assert ledger.get(first.json()["id"])["recorded_at"] == at[0], "the ledger must hold the recorded_at the answer gave"


async def check_append_only(ctx):
    async with _api(ctx) as c:
        record = (await _append(c)).json()
        before = ctx.redis.hgetall(f"audit:rec:{record['id']}")
        for method in ("PATCH", "PUT", "DELETE"):
            r = await c.request(method, f"/v1/audit/decisions/{record['id']}", json={"decision_digest": "0" * 64}, headers=T1)
            assert r.status_code == 405, f"{method} /v1/audit/decisions/{record['id']} answered {r.status_code}, expected 405: an audit record has no edits"
    after = ctx.redis.hgetall(f"audit:rec:{record['id']}")
    assert after == before, f"an edit attempt changed the stored record: {before} became {after}"
`,
    typescript: `const BODY = (digest: (text: string) => string) => ({
  model_version: 'risk-v7',
  policy_id: 'refunds-2026-10',
  input_digest: digest('input:ticket-4411'),
  decision_digest: digest('decision:approve'),
});
const T1 = {'X-Tenant-Id': 't1'};
const PROMPT = 'Customer 4411 asks for a refund of order 9921 after the kettle broke';
const ALLOWED: Record<string, true> = {id: true, tenant: true, model_version: true, policy_id: true, input_digest: true, decision_digest: true, recorded_at: true, position: true, status: true};

function api(ctx) {
  const {sha256Hex} = ctx.load('/support/audit/digest.ts');
  return {c: ctx.client(ctx.load('api').app), ledger: ctx.load('/support/audit/ledger.ts'), body: BODY(sha256Hex)};
}

const append = (c, body, headers: Record<string, string> = T1) => c.post('/v1/audit/decisions', {json: body, headers});
const records = ctx => (ctx.redis.keys('audit:rec:*') as string[]).sort();

export async function check_route(ctx) {
  const {c, ledger, body} = api(ctx);
  const r = await append(c, body);
  assert.equal(r.status, 201, \`POST /v1/audit/decisions answered \${r.status}: \${r.text}\`);
  const answer = r.json();
  assert(answer.id, \`the answer must carry the record id, got \${r.text}\`);
  const stored = await ledger.get(answer.id);
  assert(stored !== null, \`the answer names \${answer.id} but the ledger has no such record (\${JSON.stringify(records(ctx))})\`);
  for (const [name, value] of Object.entries(body)) {
    assert(stored[name] === value && answer[name] === value, \`\${name}: the ledger holds \${JSON.stringify(stored[name])} and the answer \${JSON.stringify(answer[name])}, expected \${JSON.stringify(value)}\`);
  }
}

export async function check_tenant_header(ctx) {
  const {c, ledger, body} = api(ctx);
  const anonymous = await append(c, body, {});
  assert.equal(anonymous.status, 401, \`an append without X-Tenant-Id answered \${anonymous.status}, expected 401: the tenant is the authenticated header\`);
  assert.deepEqual(records(ctx), [], \`an append without a tenant was stored: \${JSON.stringify(records(ctx))}\`);
  const spoofed = await append(c, {...body, tenant: 't2'});
  assert.equal(spoofed.status, 201, \`an append as t1 answered \${spoofed.status}: \${spoofed.text}\`);
  const record = await ledger.get(spoofed.json().id);
  assert.equal(record.tenant, 't1', \`a caller authenticated as t1 wrote a record into tenant \${JSON.stringify(record.tenant)} by naming it in the body: the tenant comes from X-Tenant-Id only\`);
}

export async function check_digests_only(ctx) {
  const {c, body} = api(ctx);
  const r = await append(c, {...body, prompt: PROMPT, decision: 'approve the refund'});
  assert.equal(r.status, 201, \`a valid append with extra fields answered \${r.status}: \${r.text}\`);
  const raw = ctx.redis.hgetall(\`audit:rec:\${r.json().id}\`);
  const extra = Object.keys(raw).filter(name => ALLOWED[name] !== true).sort();
  assert.deepEqual(extra, [], \`the ledger row holds \${JSON.stringify(extra)} (\${JSON.stringify(raw)}): the body went to the ledger as it came. Only model_version, policy_id and the two digests are stored\`);
  assert(!r.text.includes('kettle'), \`the answer echoes the prompt: \${r.text}\`);
  const without = (name: string) => Object.fromEntries(Object.entries(body).filter(([k]) => k !== name));
  const bad: [Record<string, unknown>, string][] = [
    [{...body, input_digest: body.input_digest.toUpperCase()}, 'an upper-case input_digest'],
    [{...body, decision_digest: body.decision_digest.slice(0, 63)}, 'a 63-character decision_digest'],
    [{...body, decision_digest: PROMPT}, 'a decision_digest holding text'],
    [without('input_digest'), 'no input_digest'],
    [{...body, model_version: ''}, 'an empty model_version'],
    [without('policy_id'), 'no policy_id'],
  ];
  for (const [b, what] of bad) {
    const rejected = await append(c, b);
    assert.equal(rejected.status, 400, \`an append with \${what} answered \${rejected.status}, expected 400\`);
  }
  assert.equal(records(ctx).length, 1, \`a rejected append was stored: \${JSON.stringify(records(ctx))}\`);
}

export async function check_server_time(ctx) {
  const {c, ledger, body} = api(ctx);
  const now = ctx.clock.now();
  const backdated = {...body, timestamp: 1262304000000};
  const first = await append(c, backdated);
  const second = await append(c, backdated);
  const third = await append(c, body);
  const other = await append(c, body, {'X-Tenant-Id': 't2'});
  ctx.clock.advance(5);
  const later = await append(c, body);
  const at = [first, second, third].map(r => r.json().recorded_at);
  assert(typeof at[0] === 'number' && Math.abs(at[0] - now) <= 1000, \`recorded_at is \${JSON.stringify(at[0])} while the server clock reads \${now}: the caller's timestamp (2010-01-01) was kept. recorded_at comes from the server clock\`);
  assert(at[1] === at[0] + 1 && at[2] === at[0] + 2, \`three appends in one millisecond got recorded_at \${JSON.stringify(at)}, expected \${at[0]}, \${at[0] + 1}, \${at[0] + 2}: each record of a tenant lands strictly after the tenant's last one\`);
  assert(Math.abs(other.json().recorded_at - now) <= 1000, \`t2's first record got recorded_at \${other.json().recorded_at}, expected the clock (\${now}): the order is per tenant\`);
  assert(Math.abs(later.json().recorded_at - (now + 5000)) <= 1000, \`five seconds later recorded_at is \${later.json().recorded_at}, expected about \${now + 5000}\`);
  assert.equal((await ledger.get(first.json().id)).recorded_at, at[0], 'the ledger must hold the recorded_at the answer gave');
}

export async function check_append_only(ctx) {
  const {c, body} = api(ctx);
  const record = (await append(c, body)).json();
  const before = JSON.stringify(ctx.redis.hgetall(\`audit:rec:\${record.id}\`));
  for (const method of ['PATCH', 'PUT', 'DELETE']) {
    const r = await c.request(method, \`/v1/audit/decisions/\${record.id}\`, {json: {decision_digest: '0'.repeat(64)}, headers: T1});
    assert.equal(r.status, 405, \`\${method} /v1/audit/decisions/\${record.id} answered \${r.status}, expected 405: an audit record has no edits\`);
  }
  const after = JSON.stringify(ctx.redis.hgetall(\`audit:rec:\${record.id}\`));
  assert.equal(after, before, \`an edit attempt changed the stored record: \${before} became \${after}\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"sort"
	"strings"

	"audit/digest"
	"audit/ledger"

	"leetbuild/harness"
)

const prompt = "Customer 4411 asks for a refund of order 9921 after the kettle broke"

var allowed = map[string]bool{"id": true, "tenant": true, "model_version": true, "policy_id": true, "input_digest": true, "decision_digest": true, "recorded_at": true, "position": true, "status": true}

func validBody() map[string]any {
	return map[string]any{
		"model_version":   "risk-v7",
		"policy_id":       "refunds-2026-10",
		"input_digest":    digest.Sha256Hex("input:ticket-4411"),
		"decision_digest": digest.Sha256Hex("decision:approve"),
	}
}

func with(body map[string]any, name string, value any) map[string]any {
	out := map[string]any{}
	for k, v := range body {
		out[k] = v
	}
	out[name] = value
	return out
}

func without(body map[string]any, name string) map[string]any {
	out := map[string]any{}
	for k, v := range body {
		if k != name {
			out[k] = v
		}
	}
	return out
}

func api(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func appendAs(c *harness.HTTP, body map[string]any, tenant string) *harness.Response {
	if tenant == "" {
		return c.Post("/v1/audit/decisions", body)
	}
	return c.Post("/v1/audit/decisions", body, "X-Tenant-Id", tenant)
}

type answer struct {
	ID         string \`json:"id"\`
	Tenant     string \`json:"tenant"\`
	RecordedAt int64  \`json:"recorded_at"\`
}

func answerOf(r *harness.Response) answer {
	var a answer
	r.Decode(&a)
	return a
}

func CheckRoute(ctx *harness.Ctx) {
	c := api(ctx)
	body := validBody()
	r := appendAs(c, body, "t1")
	ctx.Equal(r.Status, 201, "POST /v1/audit/decisions (%s)", r.Text())
	got := r.JSON().(map[string]any)
	id, _ := got["id"].(string)
	ctx.Assert(id != "", "the answer must carry the record id, got %s", r.Text())
	stored := ctx.Redis.HGetAll("audit:rec:" + id)
	ctx.Assert(len(stored) > 0, "the answer names %s but the ledger has no such record (%q)", id, ctx.Redis.Keys("audit:rec:*"))
	for name, value := range body {
		ctx.Assert(stored[name] == value && got[name] == value, "%s: the ledger holds %q and the answer %v, expected %q", name, stored[name], got[name], value)
	}
}

func CheckTenantHeader(ctx *harness.Ctx) {
	c := api(ctx)
	anonymous := appendAs(c, validBody(), "")
	ctx.Equal(anonymous.Status, 401, "an append without X-Tenant-Id must be refused: the tenant is the authenticated header; the status")
	ctx.Equal(len(ctx.Redis.Keys("audit:rec:*")), 0, "an append without a tenant was stored; the records")
	spoofed := appendAs(c, with(validBody(), "tenant", "t2"), "t1")
	ctx.Equal(spoofed.Status, 201, "an append as t1 (%s)", spoofed.Text())
	record := ledger.Get(context.Background(), answerOf(spoofed).ID)
	ctx.Assert(record != nil && record.Tenant == "t1", "a caller authenticated as t1 wrote a record into another tenant by naming it in the body (%+v): the tenant comes from X-Tenant-Id only", record)
}

func CheckDigestsOnly(ctx *harness.Ctx) {
	c := api(ctx)
	body := validBody()
	r := appendAs(c, with(with(body, "prompt", prompt), "decision", "approve the refund"), "t1")
	ctx.Equal(r.Status, 201, "a valid append with extra fields (%s)", r.Text())
	raw := ctx.Redis.HGetAll("audit:rec:" + answerOf(r).ID)
	var extra []string
	for name := range raw {
		if !allowed[name] {
			extra = append(extra, name)
		}
	}
	sort.Strings(extra)
	ctx.Assert(len(extra) == 0, "the ledger row holds %q (%v): the body went to the ledger as it came. Only model_version, policy_id and the two digests are stored", extra, raw)
	ctx.Assert(!strings.Contains(r.Text(), "kettle"), "the answer echoes the prompt: %s", r.Text())
	in := body["input_digest"].(string)
	out := body["decision_digest"].(string)
	bad := []struct {
		body map[string]any
		what string
	}{
		{with(body, "input_digest", strings.ToUpper(in)), "an upper-case input_digest"},
		{with(body, "decision_digest", out[:63]), "a 63-character decision_digest"},
		{with(body, "decision_digest", prompt), "a decision_digest holding text"},
		{without(body, "input_digest"), "no input_digest"},
		{with(body, "model_version", ""), "an empty model_version"},
		{without(body, "policy_id"), "no policy_id"},
	}
	for _, b := range bad {
		rejected := appendAs(c, b.body, "t1")
		ctx.Equal(rejected.Status, 400, "an append with %s; the status", b.what)
	}
	ctx.Equal(len(ctx.Redis.Keys("audit:rec:*")), 1, "a rejected append was stored; the records")
}

func CheckServerTime(ctx *harness.Ctx) {
	c := api(ctx)
	now := ctx.Clock.Now()
	backdated := with(validBody(), "timestamp", 1262304000000)
	first := answerOf(appendAs(c, backdated, "t1"))
	second := answerOf(appendAs(c, backdated, "t1"))
	third := answerOf(appendAs(c, validBody(), "t1"))
	other := answerOf(appendAs(c, validBody(), "t2"))
	ctx.Clock.Advance(5)
	later := answerOf(appendAs(c, validBody(), "t1"))
	ctx.Assert(first.RecordedAt >= now-1000 && first.RecordedAt <= now+1000, "recorded_at is %d while the server clock reads %d: the caller's timestamp (2010-01-01) was kept. recorded_at comes from the server clock", first.RecordedAt, now)
	ctx.Assert(second.RecordedAt == first.RecordedAt+1 && third.RecordedAt == first.RecordedAt+2, "three appends in one millisecond got recorded_at %d, %d, %d: each record of a tenant lands strictly after the tenant's last one", first.RecordedAt, second.RecordedAt, third.RecordedAt)
	ctx.Assert(other.RecordedAt >= now-1000 && other.RecordedAt <= now+1000, "t2's first record got recorded_at %d, expected the clock (%d): the order is per tenant", other.RecordedAt, now)
	ctx.Assert(later.RecordedAt >= now+4000 && later.RecordedAt <= now+6000, "five seconds later recorded_at is %d, expected about %d", later.RecordedAt, now+5000)
	ctx.Equal(ledger.Get(context.Background(), first.ID).RecordedAt, first.RecordedAt, "the ledger must hold the recorded_at the answer gave")
}

func CheckAppendOnly(ctx *harness.Ctx) {
	c := api(ctx)
	record := answerOf(appendAs(c, validBody(), "t1"))
	before := ctx.Redis.HGetAll("audit:rec:" + record.ID)
	for _, method := range []string{"PATCH", "PUT", "DELETE"} {
		r := c.Do(method, "/v1/audit/decisions/"+record.ID, map[string]any{"decision_digest": strings.Repeat("0", 64)}, "X-Tenant-Id", "t1")
		ctx.Equal(r.Status, 405, "%s /v1/audit/decisions/%s must be refused: an audit record has no edits; the status", method, record.ID)
	}
	ctx.Equal(ctx.Redis.HGetAll("audit:rec:"+record.ID), before, "an edit attempt changed the stored record")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cctype>
#include <set>
#include <string>
#include <vector>

namespace {

using json = nlohmann::json;

const std::string kPrompt = "Customer 4411 asks for a refund of order 9921 after the kettle broke";
const std::set<std::string> kAllowed = {"id", "tenant", "model_version", "policy_id", "input_digest", "decision_digest", "recorded_at", "position", "status"};

json validBody() {
  return {{"model_version", "risk-v7"},
          {"policy_id", "refunds-2026-10"},
          {"input_digest", sha256_hex("input:ticket-4411")},
          {"decision_digest", sha256_hex("decision:approve")}};
}

json without(json body, const std::string& name) {
  body.erase(name);
  return body;
}

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response appendAs(harness::HTTP& c, const json& body, const std::string& tenant) {
  if (tenant.empty()) return c.Post("/v1/audit/decisions", body.dump(), "Content-Type", "application/json");
  return c.Post("/v1/audit/decisions", body.dump(), "Content-Type", "application/json", "X-Tenant-Id", tenant);
}

json answerOf(const harness::Response& r) { return json::parse(r.Text(), nullptr, false); }

long long recordedAt(const harness::Response& r) {
  const json a = answerOf(r);
  return a.is_object() && a.contains("recorded_at") && a["recorded_at"].is_number() ? a["recorded_at"].get<long long>() : -1;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  const json body = validBody();
  const auto r = appendAs(c, body, "t1");
  ctx.Equal(r.Status, 201, "POST /v1/audit/decisions (%s)", r.Text());
  const json got = answerOf(r);
  const std::string id = got.is_object() ? got.value("id", "") : "";
  ctx.Assert(!id.empty(), "the answer must carry the record id, got %s", r.Text());
  const auto stored = ctx.Redis.HGetAll("audit:rec:" + id);
  ctx.Assert(!stored.empty(), "the answer names %s but the ledger has no such record", id);
  for (const auto& [name, value] : body.items()) {
    const std::string want = value.get<std::string>();
    ctx.Assert(stored.count(name) && stored.at(name) == want && got.value(name, "") == want, "%s: the ledger holds %q and the answer %s, expected %q", name, stored.count(name) ? stored.at(name) : "", got.value(name, ""), want);
  }
}

void CheckTenantHeader(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto anonymous = appendAs(c, validBody(), "");
  ctx.Equal(anonymous.Status, 401, "an append without X-Tenant-Id must be refused: the tenant is the authenticated header; the status");
  ctx.Equal(ctx.Redis.Keys("audit:rec:*").size(), 0, "an append without a tenant was stored; the records");
  json spoof = validBody();
  spoof["tenant"] = "t2";
  const auto spoofed = appendAs(c, spoof, "t1");
  ctx.Equal(spoofed.Status, 201, "an append as t1 (%s)", spoofed.Text());
  const auto record = ledger::get(answerOf(spoofed).value("id", ""));
  ctx.Assert(record && record->tenant == "t1", "a caller authenticated as t1 wrote a record into tenant %q by naming it in the body: the tenant comes from X-Tenant-Id only", record ? record->tenant : "");
}

void CheckDigestsOnly(harness::Ctx& ctx) {
  auto c = api(ctx);
  const json body = validBody();
  json extra_fields = body;
  extra_fields["prompt"] = kPrompt;
  extra_fields["decision"] = "approve the refund";
  const auto r = appendAs(c, extra_fields, "t1");
  ctx.Equal(r.Status, 201, "a valid append with extra fields (%s)", r.Text());
  const auto raw = ctx.Redis.HGetAll("audit:rec:" + answerOf(r).value("id", ""));
  std::vector<std::string> extra;
  for (const auto& [name, value] : raw) {
    if (!kAllowed.count(name)) extra.push_back(name);
  }
  ctx.Assert(extra.empty(), "the ledger row holds %q (%v): the body went to the ledger as it came. Only model_version, policy_id and the two digests are stored", extra, raw);
  ctx.Assert(r.Text().find("kettle") == std::string::npos, "the answer echoes the prompt: %s", r.Text());
  std::string upper = body["input_digest"].get<std::string>();
  std::transform(upper.begin(), upper.end(), upper.begin(), [](unsigned char ch) { return static_cast<char>(std::toupper(ch)); });
  json b1 = body, b2 = body, b3 = body, b5 = body;
  b1["input_digest"] = upper;
  b2["decision_digest"] = body["decision_digest"].get<std::string>().substr(0, 63);
  b3["decision_digest"] = kPrompt;
  b5["model_version"] = "";
  const std::vector<std::pair<json, std::string>> bad = {
      {b1, "an upper-case input_digest"}, {b2, "a 63-character decision_digest"}, {b3, "a decision_digest holding text"},
      {without(body, "input_digest"), "no input_digest"}, {b5, "an empty model_version"}, {without(body, "policy_id"), "no policy_id"}};
  for (const auto& [b, what] : bad) {
    const auto rejected = appendAs(c, b, "t1");
    ctx.Equal(rejected.Status, 400, "an append with %s; the status", what);
  }
  ctx.Equal(ctx.Redis.Keys("audit:rec:*").size(), 1, "a rejected append was stored; the records");
}

void CheckServerTime(harness::Ctx& ctx) {
  auto c = api(ctx);
  const long long now = ctx.Clock.Now();
  json backdated = validBody();
  backdated["timestamp"] = 1262304000000LL;
  const auto first = appendAs(c, backdated, "t1");
  const auto second = appendAs(c, backdated, "t1");
  const auto third = appendAs(c, validBody(), "t1");
  const auto other = appendAs(c, validBody(), "t2");
  ctx.Clock.Advance(5);
  const auto later = appendAs(c, validBody(), "t1");
  const long long at0 = recordedAt(first), at1 = recordedAt(second), at2 = recordedAt(third);
  ctx.Assert(at0 >= now - 1000 && at0 <= now + 1000, "recorded_at is %d while the server clock reads %d: the caller's timestamp (2010-01-01) was kept. recorded_at comes from the server clock", at0, now);
  ctx.Assert(at1 == at0 + 1 && at2 == at0 + 2, "three appends in one millisecond got recorded_at %d, %d, %d: each record of a tenant lands strictly after the tenant's last one", at0, at1, at2);
  ctx.Assert(recordedAt(other) >= now - 1000 && recordedAt(other) <= now + 1000, "t2's first record got recorded_at %d, expected the clock (%d): the order is per tenant", recordedAt(other), now);
  ctx.Assert(recordedAt(later) >= now + 4000 && recordedAt(later) <= now + 6000, "five seconds later recorded_at is %d, expected about %d", recordedAt(later), now + 5000);
  ctx.Equal(ledger::get(answerOf(first).value("id", ""))->recorded_at, at0, "the ledger must hold the recorded_at the answer gave");
}

void CheckAppendOnly(harness::Ctx& ctx) {
  auto c = api(ctx);
  const std::string id = answerOf(appendAs(c, validBody(), "t1")).value("id", "");
  const auto before = ctx.Redis.HGetAll("audit:rec:" + id);
  const std::string edit = json{{"decision_digest", std::string(64, '0')}}.dump();
  for (const std::string method : {"PATCH", "PUT", "DELETE"}) {
    const auto r = c.Do(method, "/v1/audit/decisions/" + id, edit, "Content-Type", "application/json", "X-Tenant-Id", "t1");
    ctx.Equal(r.Status, 405, "%s /v1/audit/decisions/%s must be refused: an audit record has no edits; the status", method, id);
  }
  ctx.Equal(ctx.Redis.HGetAll("audit:rec:" + id), before, "an edit attempt changed the stored record");
}
`,
  },
  hints: [
    'Post a decision with a `prompt` field and a `timestamp` from 2010, then read the ledger row: the prompt is stored, `recorded_at` says 2010, and a `PATCH` on the record answers 200 and changes it.',
    'The handler hands the body to `ledger.insert` as it arrived, so every extra field and the caller’s clock become evidence. The tenant is read from the body before the header, and the `PATCH` route forwards to `ledger.update`.',
    'Read `X-Tenant-Id` (401 when empty); check the two text fields and `is_digest` on both digests (400); insert only those four fields with `recorded_at = max(now_ms, last_recorded_at(tenant) + 1)`; answer 405 on `PUT`, `PATCH` and `DELETE`.',
  ],
  debrief: `Everything the record holds is either checked or produced by the server, which is what lets it serve as evidence later. The digests stand in for the content: the trail proves which input and which decision it saw without holding either, so it never becomes a second copy of tenant data. \`recorded_at\` comes from the server and moves strictly forward per tenant, so the order an auditor reads is the order the service wrote. The 405 routes are deliberate: a missing edit route is a property you assert, and a correction becomes a new record. Production audit services authenticate the caller with mTLS or a signed token rather than a bare header, and keep the ledger on write-once storage such as S3 Object Lock in compliance mode.`,
};
