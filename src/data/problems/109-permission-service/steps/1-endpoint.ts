import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/roles/assignments: you cannot grant what you do not hold',
  concept: 'http',
  guides: ['request-boundaries', 'idempotent-requests'],
  file: 'api',
  focus: ['client', 'api', 'catalog', 'store'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/roles/assignments\` with body
\`{"subject": "cyd", "role": "viewer", "scope": "team:eng"}\` and the \`X-Assigner-Id\` header (401
when missing). It answers 403 unless the assigner holds \`org_admin\` or \`team_admin\` somewhere,
then writes the grant with \`grants.add\` and answers \`201\` with it. It serves the demo and hides
three flaws.

**Failure mode the checks target.** A team admin grants \`org_admin\` at \`org\`; a grant lands on
\`scope: "*"\`, a scope no role defines; and a client that times out and retries gets a second grant.

- **The catalog decides.** \`role\` must be in \`catalog.ROLES\` and
  \`catalog.scope_kind(scope)\` one of its \`scope_kinds\`, otherwise **422**.
- **No escalation.** The assigner must hold \`roles:assign\` and every permission in
  \`catalog.permissions_of(role)\` at the target scope (\`grants.effective(assigner, scope)\`, which
  applies \`catalog.covers\`). The first one missing is **403** with
  \`{"error": "insufficient_permissions", "missing_permission": "code:write"}\`.
- **Idempotency.** \`Idempotency-Key\` is required (**400**). Look \`(assigner, key)\` up with
  \`grants.assignment\` before writing and answer the recorded grant on a replay; record a new one
  with \`grants.record_assignment\`.`,
  sequence: {
    participants: ['Client', 'Permission Service', 'Role catalog', 'Grant store'],
    messages: [
      {
        from: 'Client',
        to: 'Permission Service',
        label: 'POST /v1/roles/assignments · X-Assigner-Id · Idempotency-Key',
        kind: 'sync',
      },
      {
        from: 'Permission Service',
        to: 'Grant store',
        label: 'assignment(assigner, key) → recorded / none',
        kind: 'sync',
      },
      {from: 'Permission Service', to: 'Role catalog', label: 'ROLES[role] · scope_kind(scope) → 422', kind: 'sync'},
      {from: 'Permission Service', to: 'Grant store', label: 'effective(assigner, scope)', kind: 'sync'},
      {
        from: 'Permission Service',
        to: 'Permission Service',
        label: 'roles:assign + permissions_of(role) all held? → 403 missing_permission',
        kind: 'sync',
      },
      {
        from: 'Permission Service',
        to: 'Grant store',
        label: 'add · record_assignment(assigner, key, grant)',
        kind: 'sync',
      },
      {
        from: 'Permission Service',
        to: 'Client',
        label: '201 {grant_id, subject, role, scope, assigner}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Registers POST /v1/roles/assignments',
      detail: 'Register `POST /v1/roles/assignments`; an assignment an org admin makes answers 201 with the grant.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/roles\/assignments["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/roles\/assignments['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/roles\/assignments"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"roles"\s*\/\s*"assignments"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/roles\/assignments"/]},
      },
    },
    {
      id: 'catalog',
      title: 'Validates the role and the scope kind against the catalog with 422',
      detail:
        'The role is looked up in the catalog and the scope kind must be one the catalog allows for it, else **422**; the starter writes whatever role and scope it is sent, `"*"` included.',
      match: {
        python: {all: [/catalog\.ROLES\b/, /catalog\.scope_kind\(/, /\b422\b/]},
        typescript: {all: [/ROLES\[/, /scopeKind\(/, /\b422\b/]},
        go: {all: [/catalog\.Roles\[/, /catalog\.ScopeKind\(/, /StatusUnprocessableEntity|\b422\b/]},
        scala: {all: [/Catalog\.Roles\.get\(|Catalog\.Roles\(/, /Catalog\.scopeKind\(/, /UnprocessableEntity|\b422\b/]},
        cpp: {all: [/catalog::kRoles\.find\(|catalog::kRoles\.at\(/, /catalog::scopeKind\(/, /\b422\b/]},
      },
    },
    {
      id: 'no-escalation',
      title: 'Refuses a grant that exceeds the assigner, naming the permission',
      detail:
        'The assigner must hold `roles:assign` and every permission of the role at the target scope (`effective`, scope containment included); the first gap is **403** naming `missing_permission`. The starter only asks whether the assigner is an admin somewhere.',
      match: {
        python: {all: [/grants\.effective\(/, /catalog\.permissions_of\(/, /roles:assign/, /missing_permission/]},
        typescript: {all: [/\beffective\(/, /permissionsOf\(/, /roles:assign/, /missing_permission/]},
        go: {all: [/grants\.Effective\(/, /catalog\.PermissionsOf\(/, /roles:assign/, /missing_permission/]},
        scala: {all: [/Grants\.effective\(/, /Catalog\.permissionsOf\(/, /roles:assign/, /missing_permission/]},
        cpp: {all: [/grants::effective\(/, /catalog::permissionsOf\(/, /roles:assign/, /missing_permission/]},
      },
    },
    {
      id: 'idempotent',
      title: 'Answers a retried assignment with the recorded grant',
      detail:
        '`Idempotency-Key` is required (400) and `(assigner, key)` is looked up (`assignment`) before the grant is written; a replay answers the recorded grant and a new assignment is recorded (`record_assignment`/`recordAssignment`).',
      match: {
        python: {
          all: [/idempotency-key/i, /grants\.assignment\(/, /grants\.record_assignment\(/, /\b400\b/],
          order: [/grants\.assignment\(/, /grants\.add\(/],
        },
        typescript: {
          all: [/idempotency-key/i, /\bassignment\(/, /recordAssignment\(/, /\b400\b/],
          order: [/\bassignment\(/, /\badd\(/],
        },
        go: {
          all: [/Idempotency-Key/i, /grants\.Assignment\(/, /grants\.RecordAssignment\(/, /StatusBadRequest|\b400\b/],
          order: [/grants\.Assignment\(/, /grants\.Add\(/],
        },
        scala: {
          all: [/Idempotency-Key/i, /Grants\.assignment\(/, /Grants\.recordAssignment\(/, /BadRequest|\b400\b/],
          order: [/Grants\.assignment\(/, /Grants\.add\(/],
        },
        cpp: {
          all: [/Idempotency-Key/i, /grants::assignment\(/, /grants::recordAssignment\(/, /\b400\b/],
          order: [/grants::assignment\(/, /grants::add\(/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from permz import catalog  # ROLES, scope_kind, covers, permissions_of
from permz import grants  # grants_of, effective, add, assignment, record_assignment

app = FastAPI()

ADMIN_ROLES = ("org_admin", "team_admin")


class Assignment(BaseModel):
    subject: str
    role: str
    scope: str


@app.post("/v1/roles/assignments", status_code=201)
def assign(body: Assignment, request: Request):
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    assigner = request.headers.get("x-assigner-id", "")
    if not assigner:
        return JSONResponse({"error": "X-Assigner-Id is required"}, status_code=401)
    if not any(grant["role"] in ADMIN_ROLES for grant in grants.grants_of(assigner)):
        return JSONResponse({"error": "insufficient_permissions"}, status_code=403)
    return grants.add(body.subject, body.role, body.scope, assigner)
`,
      solution: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from permz import catalog  # ROLES, scope_kind, covers, permissions_of
from permz import grants  # grants_of, effective, add, assignment, record_assignment

app = FastAPI()


class Assignment(BaseModel):
    subject: str
    role: str
    scope: str


@app.post("/v1/roles/assignments", status_code=201)
def assign(body: Assignment, request: Request):
    assigner = request.headers.get("x-assigner-id", "")
    if not assigner:
        return JSONResponse({"error": "X-Assigner-Id is required"}, status_code=401)
    key = request.headers.get("idempotency-key", "")
    if not key:
        return JSONResponse({"error": "Idempotency-Key is required"}, status_code=400)
    recorded = grants.assignment(assigner, key)
    if recorded is not None:
        return recorded  # a replay answers what the first attempt answered
    role = catalog.ROLES.get(body.role)
    if role is None or catalog.scope_kind(body.scope) not in role["scope_kinds"]:
        return JSONResponse({"error": "not in the role catalog", "role": body.role, "scope": body.scope}, status_code=422)
    # Hand out only what the assigner holds at the target scope: the right to assign, and every permission of the role.
    held = grants.effective(assigner, body.scope)
    for permission in ["roles:assign", *catalog.permissions_of(body.role)]:
        if permission not in held:
            return JSONResponse({"error": "insufficient_permissions", "missing_permission": permission}, status_code=403)
    grant = grants.add(body.subject, body.role, body.scope, assigner)
    grants.record_assignment(assigner, key, grant)
    return grant
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {ROLES, permissionsOf, scopeKind} from 'permz/catalog';
import {add, assignment, effective, grantsOf, recordAssignment} from 'permz/grants';

export const app = Fastify();

const ADMIN_ROLES = ['org_admin', 'team_admin'];

interface AssignmentBody {
  subject: string;
  role: string;
  scope: string;
}

app.post('/v1/roles/assignments', async (request, reply) => {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const assigner = request.headers['x-assigner-id'];
  if (typeof assigner !== 'string' || assigner === '') return reply.code(401).send({error: 'X-Assigner-Id is required'});
  const {subject, role, scope} = request.body as AssignmentBody;
  const held = await grantsOf(assigner);
  if (!held.some(grant => ADMIN_ROLES.includes(grant.role))) return reply.code(403).send({error: 'insufficient_permissions'});
  return reply.code(201).send(await add(subject, role, scope, assigner));
});
`,
      solution: `import Fastify from 'fastify';

import {ROLES, permissionsOf, scopeKind} from 'permz/catalog';
import {add, assignment, effective, grantsOf, recordAssignment} from 'permz/grants';

export const app = Fastify();

interface AssignmentBody {
  subject: string;
  role: string;
  scope: string;
}

app.post('/v1/roles/assignments', async (request, reply) => {
  const assigner = request.headers['x-assigner-id'];
  if (typeof assigner !== 'string' || assigner === '') return reply.code(401).send({error: 'X-Assigner-Id is required'});
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key === '') return reply.code(400).send({error: 'Idempotency-Key is required'});
  const recorded = await assignment(assigner, key);
  if (recorded !== null) return reply.code(201).send(recorded); // a replay answers what the first attempt answered
  const {subject, role, scope} = request.body as AssignmentBody;
  const entry = Object.hasOwn(ROLES, role) ? ROLES[role] : undefined;
  if (entry === undefined || !entry.scope_kinds.includes(scopeKind(scope))) {
    return reply.code(422).send({error: 'not in the role catalog', role, scope});
  }
  // Hand out only what the assigner holds at the target scope: the right to assign, and every permission of the role.
  const held = await effective(assigner, scope);
  const missing = ['roles:assign', ...permissionsOf(role)].find(permission => !held.includes(permission));
  if (missing !== undefined) return reply.code(403).send({error: 'insufficient_permissions', missing_permission: missing});
  const grant = await add(subject, role, scope, assigner);
  await recordAssignment(assigner, key, grant);
  return reply.code(201).send(grant);
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"permz/grants" // grants.GrantsOf, Effective, Add, Assignment, RecordAssignment; catalog: permz/catalog
)

var adminRoles = map[string]bool{"org_admin": true, "team_admin": true}

type assignmentBody struct {
	Subject string \`json:"subject"\`
	Role    string \`json:"role"\`
	Scope   string \`json:"scope"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func assign(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	assigner := r.Header.Get("X-Assigner-Id")
	if assigner == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Assigner-Id is required"})
		return
	}
	var body assignmentBody
	json.NewDecoder(r.Body).Decode(&body)
	admin := false
	for _, g := range grants.GrantsOf(r.Context(), assigner) {
		admin = admin || adminRoles[g.Role]
	}
	if !admin {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "insufficient_permissions"})
		return
	}
	writeJSON(rw, http.StatusCreated, grants.Add(r.Context(), body.Subject, body.Role, body.Scope, assigner))
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/roles/assignments", assign)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"

	"permz/catalog" // catalog.Roles, ScopeKind, Covers, PermissionsOf
	"permz/grants"  // grants.GrantsOf, Effective, Add, Assignment, RecordAssignment
)

type assignmentBody struct {
	Subject string \`json:"subject"\`
	Role    string \`json:"role"\`
	Scope   string \`json:"scope"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

// allowedAt reports whether the catalog lets role be granted at a scope of this kind.
func allowedAt(role catalog.Role, kind string) bool {
	for _, k := range role.ScopeKinds {
		if k == kind {
			return true
		}
	}
	return false
}

func assign(rw http.ResponseWriter, r *http.Request) {
	assigner := r.Header.Get("X-Assigner-Id")
	if assigner == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Assigner-Id is required"})
		return
	}
	key := r.Header.Get("Idempotency-Key")
	if key == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "Idempotency-Key is required"})
		return
	}
	if recorded := grants.Assignment(r.Context(), assigner, key); recorded != nil {
		writeJSON(rw, http.StatusCreated, recorded) // a replay answers what the first attempt answered
		return
	}
	var body assignmentBody
	json.NewDecoder(r.Body).Decode(&body)
	role, known := catalog.Roles[body.Role]
	if !known || !allowedAt(role, catalog.ScopeKind(body.Scope)) {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "not in the role catalog", "role": body.Role, "scope": body.Scope})
		return
	}
	// Hand out only what the assigner holds at the target scope: the right to assign, and every permission of the role.
	held := map[string]bool{}
	for _, p := range grants.Effective(r.Context(), assigner, body.Scope) {
		held[p] = true
	}
	for _, p := range append([]string{"roles:assign"}, catalog.PermissionsOf(body.Role)...) {
		if !held[p] {
			writeJSON(rw, http.StatusForbidden, map[string]string{"error": "insufficient_permissions", "missing_permission": p})
			return
		}
	}
	grant := grants.Add(r.Context(), body.Subject, body.Role, body.Scope, assigner)
	grants.RecordAssignment(r.Context(), assigner, key, grant)
	writeJSON(rw, http.StatusCreated, grant)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/roles/assignments", assign)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import permz.Catalog // Catalog.Roles, scopeKind, covers, permissionsOf
import permz.Grants // Grants.grantsOf, effective, add, assignment, recordAssignment

object Api {
  val AdminRoles: Set[String] = Set("org_admin", "team_admin")

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  val route: Route = path("v1" / "roles" / "assignments") {
    post {
      optionalHeaderValueByName("X-Assigner-Id") { assignerHeader =>
        entity(as[String]) { raw =>
          // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
          val body = raw.parseJson.asJsObject.fields
          def text(name: String): String = body.get(name).collect { case JsString(s) => s }.getOrElse("")
          assignerHeader.filter(_.nonEmpty) match {
            case None => complete(error(StatusCodes.Unauthorized, "X-Assigner-Id is required"))
            case Some(assigner) =>
              if (!Grants.grantsOf(assigner).exists(grant => AdminRoles.contains(grant.role)))
                complete(error(StatusCodes.Forbidden, "insufficient_permissions"))
              else complete(json(StatusCodes.Created, Grants.add(text("subject"), text("role"), text("scope"), assigner).toJson))
          }
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

import permz.Catalog // Catalog.Roles, scopeKind, covers, permissionsOf
import permz.Grants // Grants.grantsOf, effective, add, assignment, recordAssignment

object Api {
  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  val route: Route = path("v1" / "roles" / "assignments") {
    post {
      optionalHeaderValueByName("X-Assigner-Id") { assignerHeader =>
        optionalHeaderValueByName("Idempotency-Key") { keyHeader =>
          entity(as[String]) { raw =>
            val body = raw.parseJson.asJsObject.fields
            def text(name: String): String = body.get(name).collect { case JsString(s) => s }.getOrElse("")
            (assignerHeader.filter(_.nonEmpty), keyHeader.filter(_.nonEmpty)) match {
              case (None, _) => complete(error(StatusCodes.Unauthorized, "X-Assigner-Id is required"))
              case (_, None) => complete(error(StatusCodes.BadRequest, "Idempotency-Key is required"))
              case (Some(assigner), Some(key)) =>
                Grants.assignment(assigner, key) match {
                  case Some(recorded) => complete(json(StatusCodes.Created, recorded.toJson)) // a replay answers what the first attempt answered
                  case None => complete(assignOnce(assigner, key, text("subject"), text("role"), text("scope")))
                }
            }
          }
        }
      }
    }
  }

  /** The response to a valid, not yet recorded assignment by assigner. */
  private def assignOnce(assigner: String, key: String, subject: String, role: String, scope: String): HttpResponse =
    Catalog.Roles.get(role) match {
      case Some(entry) if entry.scopeKinds.contains(Catalog.scopeKind(scope)) =>
        // Hand out only what the assigner holds at the target scope: the right to assign, and every permission of the role.
        val held = Grants.effective(assigner, scope).toSet
        ("roles:assign" +: Catalog.permissionsOf(role)).find(p => !held.contains(p)) match {
          case Some(missing) =>
            json(StatusCodes.Forbidden, JsObject("error" -> JsString("insufficient_permissions"), "missing_permission" -> JsString(missing)))
          case None =>
            val grant = Grants.add(subject, role, scope, assigner)
            Grants.recordAssignment(assigner, key, grant)
            json(StatusCodes.Created, grant.toJson)
        }
      case _ => error(StatusCodes.UnprocessableEntity, "not in the role catalog")
    }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <set>
#include <string>

#include "permz/grants.h"  // grants::grantsOf, effective, add, assignment, recordAssignment, toJson; catalog: permz/catalog.h

using json = nlohmann::json;

const std::set<std::string> kAdminRoles = {"org_admin", "team_admin"};

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void assign(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const std::string assigner = req.get_header_value("X-Assigner-Id");
  if (assigner.empty()) return reply(res, 401, json{{"error", "X-Assigner-Id is required"}});
  const json body = json::parse(req.body);
  bool admin = false;
  for (const grants::Grant& g : grants::grantsOf(assigner)) admin = admin || kAdminRoles.count(g.role) > 0;
  if (!admin) return reply(res, 403, json{{"error", "insufficient_permissions"}});
  const grants::Grant grant = grants::add(body.value("subject", ""), body.value("role", ""), body.value("scope", ""), assigner);
  reply(res, 201, grants::toJson(grant));
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/roles/assignments", assign); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <string>
#include <vector>

#include "permz/catalog.h"  // catalog::kRoles, scopeKind, covers, permissionsOf
#include "permz/grants.h"   // grants::grantsOf, effective, add, assignment, recordAssignment, toJson

using json = nlohmann::json;

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void assign(const httplib::Request& req, httplib::Response& res) {
  const std::string assigner = req.get_header_value("X-Assigner-Id");
  if (assigner.empty()) return reply(res, 401, json{{"error", "X-Assigner-Id is required"}});
  const std::string key = req.get_header_value("Idempotency-Key");
  if (key.empty()) return reply(res, 400, json{{"error", "Idempotency-Key is required"}});
  if (const auto recorded = grants::assignment(assigner, key)) {
    return reply(res, 201, grants::toJson(*recorded));  // a replay answers what the first attempt answered
  }
  const json body = json::parse(req.body);
  const std::string subject = body.value("subject", ""), role = body.value("role", ""), scope = body.value("scope", "");
  const auto entry = catalog::kRoles.find(role);
  if (entry == catalog::kRoles.end() || std::find(entry->second.scope_kinds.begin(), entry->second.scope_kinds.end(),
                                                  catalog::scopeKind(scope)) == entry->second.scope_kinds.end()) {
    return reply(res, 422, json{{"error", "not in the role catalog"}, {"role", role}, {"scope", scope}});
  }
  // Hand out only what the assigner holds at the target scope: the right to assign, and every permission of the role.
  const std::vector<std::string> held = grants::effective(assigner, scope);
  std::vector<std::string> needed = {"roles:assign"};
  for (const std::string& p : catalog::permissionsOf(role)) needed.push_back(p);
  for (const std::string& p : needed) {
    if (std::find(held.begin(), held.end(), p) == held.end()) {
      return reply(res, 403, json{{"error", "insufficient_permissions"}, {"missing_permission", p}});
    }
  }
  const grants::Grant grant = grants::add(subject, role, scope, assigner);
  grants::recordAssignment(assigner, key, grant);
  reply(res, 201, grants::toJson(grant));
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/roles/assignments", assign); }
`,
    },
  },
  harness: {
    python: `from permz import grants


def _seed():
    grants.add("olu", "org_admin", "org", "root")
    grants.add("ada", "team_admin", "team:eng", "olu")
    grants.add("bob", "viewer", "team:eng", "ada")


def _api(ctx):
    _seed()
    return ctx.client(ctx.load("api").app)


async def _assign(c, assigner, role, scope, key=None):
    headers = {"X-Assigner-Id": assigner, "Idempotency-Key": key or f"{assigner}/{role}/{scope}"}
    return await c.post("/v1/roles/assignments", json={"subject": "cyd", "role": role, "scope": scope}, headers=headers)


def _held():
    return [(g["role"], g["scope"]) for g in grants.grants_of("cyd")]


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await _assign(c, "olu", "viewer", "team:eng")
    assert r.status_code == 201, f"olu (org_admin at org) assigning viewer at team:eng answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("subject") == "cyd" and body.get("role") == "viewer" and body.get("scope") == "team:eng" and body.get("grant_id"), f"the 201 must carry the grant (grant_id, subject, role, scope), got {body}"
    assert _held() == [("viewer", "team:eng")], f"after the assignment cyd holds {_held()}"


async def check_catalog(ctx):
    async with _api(ctx) as c:
        for role, scope, what in (
            ("superuser", "org", "a role the catalog does not define"),
            ("viewer", "*", 'viewer at scope "*"'),
            ("viewer", "org", "viewer at org (the catalog allows viewer at team and project scopes)"),
            ("team_admin", "project:eng/api", "team_admin at a project (the catalog allows it at team scopes)"),
        ):
            r = await _assign(c, "olu", role, scope)
            assert r.status_code == 422, f"olu assigning {what} answered {r.status_code}, expected 422: the catalog is the only source of roles and of the scope kinds each may be granted at"
        r = await _assign(c, "olu", "developer", "project:eng/api")
        assert r.status_code == 201, f"olu assigning developer at project:eng/api answered {r.status_code}: {r.text}"
    assert _held() == [("developer", "project:eng/api")], f"cyd holds {_held()}: only the assignment the catalog allows may be written"


async def check_no_escalation(ctx):
    async with _api(ctx) as c:
        r = await _assign(c, "ada", "org_admin", "org")
        assert r.status_code == 403, f"ada (team_admin at team:eng) granting org_admin at org answered {r.status_code}, expected 403: an assigner hands out only what it holds"
        assert r.json().get("missing_permission"), f"the 403 must name the missing permission (missing_permission), got {r.text}"
        r = await _assign(c, "ada", "team_admin", "team:ops")
        assert r.status_code == 403, f"ada granting team_admin at team:ops answered {r.status_code}, expected 403: team:eng does not cover team:ops"
        r = await _assign(c, "ada", "developer", "project:eng/api")
        assert r.status_code == 403 and r.json().get("missing_permission") == "code:write", f"ada granting developer (code:write, team:read) at project:eng/api answered {r.status_code} {r.text}, expected 403 naming code:write, which ada does not hold"
        r = await _assign(c, "bob", "viewer", "team:eng")
        assert r.status_code == 403 and r.json().get("missing_permission") == "roles:assign", f"bob (viewer at team:eng) granting viewer answered {r.status_code} {r.text}, expected 403 naming roles:assign"
        r = await _assign(c, "ada", "viewer", "project:eng/api")
        assert r.status_code == 201, f"ada granting viewer at project:eng/api answered {r.status_code} {r.text}, expected 201: team:eng covers its projects"
    assert _held() == [("viewer", "project:eng/api")], f"cyd holds {_held()}: a refused assignment was written"


async def check_idempotent(ctx):
    async with _api(ctx) as c:
        none = await c.post("/v1/roles/assignments", json={"subject": "cyd", "role": "viewer", "scope": "team:eng"}, headers={"X-Assigner-Id": "olu"})
        assert none.status_code == 400, f"an assignment without Idempotency-Key answered {none.status_code}, expected 400"
        assert _held() == [], f"an assignment without Idempotency-Key wrote {_held()}"
        first = await _assign(c, "olu", "viewer", "team:eng", "k-1")
        replay = await _assign(c, "olu", "viewer", "team:eng", "k-1")
        assert first.status_code == 201 and replay.status_code in (200, 201), f"the assignment answered {first.status_code}, its replay {replay.status_code}"
        assert replay.json().get("grant_id") == first.json().get("grant_id"), f"a replay of Idempotency-Key k-1 answered grant {replay.json().get('grant_id')}, the first attempt {first.json().get('grant_id')}: a retry must answer the recorded grant"
        assert len(_held()) == 1, f"a retried assignment wrote {len(_held())} grants for cyd, expected 1"
        other = await _assign(c, "olu", "viewer", "team:ops", "k-2")
    assert other.status_code == 201 and len(_held()) == 2, f"an assignment with a new key answered {other.status_code}; cyd holds {_held()}"
`,
    typescript: `function api(ctx) {
  const grants = ctx.load('/support/permz/grants.ts');
  const c = ctx.client(ctx.load('api').app);
  const seed = async () => {
    await grants.add('olu', 'org_admin', 'org', 'root');
    await grants.add('ada', 'team_admin', 'team:eng', 'olu');
    await grants.add('bob', 'viewer', 'team:eng', 'ada');
  };
  const held = async (): Promise<string[]> => (await grants.grantsOf('cyd')).map(g => \`\${g.role}@\${g.scope}\`);
  return {c, seed, held};
}

const assign = (c, assigner: string, role: string, scope: string, key?: string) =>
  c.post('/v1/roles/assignments', {
    json: {subject: 'cyd', role, scope},
    headers: {'X-Assigner-Id': assigner, 'Idempotency-Key': key ?? \`\${assigner}/\${role}/\${scope}\`},
  });

export async function check_route(ctx) {
  const {c, seed, held} = api(ctx);
  await seed();
  const r = await assign(c, 'olu', 'viewer', 'team:eng');
  assert.equal(r.status, 201, \`olu (org_admin at org) assigning viewer at team:eng answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.subject === 'cyd' && body.role === 'viewer' && body.scope === 'team:eng' && body.grant_id, \`the 201 must carry the grant (grant_id, subject, role, scope), got \${r.text}\`);
  assert.deepStrictEqual(await held(), ['viewer@team:eng'], 'after the assignment cyd must hold viewer at team:eng');
}

export async function check_catalog(ctx) {
  const {c, seed, held} = api(ctx);
  await seed();
  const invalid = [
    ['superuser', 'org', 'a role the catalog does not define'],
    ['viewer', '*', 'viewer at scope "*"'],
    ['viewer', 'org', 'viewer at org (the catalog allows viewer at team and project scopes)'],
    ['team_admin', 'project:eng/api', 'team_admin at a project (the catalog allows it at team scopes)'],
  ];
  for (const [role, scope, what] of invalid) {
    const r = await assign(c, 'olu', role, scope);
    assert.equal(r.status, 422, \`olu assigning \${what} answered \${r.status}, expected 422: the catalog is the only source of roles and of the scope kinds each may be granted at\`);
  }
  const r = await assign(c, 'olu', 'developer', 'project:eng/api');
  assert.equal(r.status, 201, \`olu assigning developer at project:eng/api answered \${r.status}: \${r.text}\`);
  assert.deepStrictEqual(await held(), ['developer@project:eng/api'], 'only the assignment the catalog allows may be written');
}

export async function check_no_escalation(ctx) {
  const {c, seed, held} = api(ctx);
  await seed();
  let r = await assign(c, 'ada', 'org_admin', 'org');
  assert.equal(r.status, 403, \`ada (team_admin at team:eng) granting org_admin at org answered \${r.status}, expected 403: an assigner hands out only what it holds\`);
  assert(r.json().missing_permission, \`the 403 must name the missing permission (missing_permission), got \${r.text}\`);
  r = await assign(c, 'ada', 'team_admin', 'team:ops');
  assert.equal(r.status, 403, \`ada granting team_admin at team:ops answered \${r.status}, expected 403: team:eng does not cover team:ops\`);
  r = await assign(c, 'ada', 'developer', 'project:eng/api');
  assert(r.status === 403 && r.json().missing_permission === 'code:write', \`ada granting developer (code:write, team:read) at project:eng/api answered \${r.status} \${r.text}, expected 403 naming code:write, which ada does not hold\`);
  r = await assign(c, 'bob', 'viewer', 'team:eng');
  assert(r.status === 403 && r.json().missing_permission === 'roles:assign', \`bob (viewer at team:eng) granting viewer answered \${r.status} \${r.text}, expected 403 naming roles:assign\`);
  r = await assign(c, 'ada', 'viewer', 'project:eng/api');
  assert.equal(r.status, 201, \`ada granting viewer at project:eng/api answered \${r.status} \${r.text}, expected 201: team:eng covers its projects\`);
  assert.deepStrictEqual(await held(), ['viewer@project:eng/api'], 'a refused assignment was written');
}

export async function check_idempotent(ctx) {
  const {c, seed, held} = api(ctx);
  await seed();
  const none = await c.post('/v1/roles/assignments', {json: {subject: 'cyd', role: 'viewer', scope: 'team:eng'}, headers: {'X-Assigner-Id': 'olu'}});
  assert.equal(none.status, 400, \`an assignment without Idempotency-Key answered \${none.status}, expected 400\`);
  assert.deepStrictEqual(await held(), [], 'an assignment without Idempotency-Key must write nothing');
  const first = await assign(c, 'olu', 'viewer', 'team:eng', 'k-1');
  const replay = await assign(c, 'olu', 'viewer', 'team:eng', 'k-1');
  assert(first.status === 201 && (replay.status === 200 || replay.status === 201), \`the assignment answered \${first.status}, its replay \${replay.status}\`);
  assert.equal(replay.json().grant_id, first.json().grant_id, \`a replay of Idempotency-Key k-1 answered \${replay.text}, the first attempt \${first.text}: a retry must answer the recorded grant\`);
  assert.equal((await held()).length, 1, \`a retried assignment wrote \${(await held()).length} grants for cyd, expected 1\`);
  const other = await assign(c, 'olu', 'viewer', 'team:ops', 'k-2');
  assert(other.status === 201 && (await held()).length === 2, \`an assignment with a new key answered \${other.status}; cyd holds \${JSON.stringify(await held())}\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"

	"permz/grants"

	"leetbuild/harness"
)

type assignReply struct {
	GrantID           string \`json:"grant_id"\`
	Subject           string \`json:"subject"\`
	Role              string \`json:"role"\`
	Scope             string \`json:"scope"\`
	MissingPermission string \`json:"missing_permission"\`
}

func api(ctx *harness.Ctx) *harness.HTTP {
	bg := context.Background()
	grants.Add(bg, "olu", "org_admin", "org", "root")
	grants.Add(bg, "ada", "team_admin", "team:eng", "olu")
	grants.Add(bg, "bob", "viewer", "team:eng", "ada")
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func assignAs(c *harness.HTTP, assigner, role, scope, key string) (*harness.Response, assignReply) {
	if key == "" {
		key = assigner + "/" + role + "/" + scope
	}
	r := c.Post("/v1/roles/assignments", map[string]string{"subject": "cyd", "role": role, "scope": scope}, "X-Assigner-Id", assigner, "Idempotency-Key", key)
	var body assignReply
	r.Decode(&body)
	return r, body
}

func heldByCyd() []string {
	out := []string{}
	for _, g := range grants.GrantsOf(context.Background(), "cyd") {
		out = append(out, g.Role+"@"+g.Scope)
	}
	return out
}

func CheckRoute(ctx *harness.Ctx) {
	c := api(ctx)
	r, body := assignAs(c, "olu", "viewer", "team:eng", "")
	ctx.Equal(r.Status, 201, "olu (org_admin at org) assigning viewer at team:eng (%s)", r.Text())
	ctx.Assert(body.Subject == "cyd" && body.Role == "viewer" && body.Scope == "team:eng" && body.GrantID != "", "the 201 must carry the grant (grant_id, subject, role, scope), got %s", r.Text())
	ctx.Equal(heldByCyd(), []string{"viewer@team:eng"}, "after the assignment, cyd's grants")
}

func CheckCatalog(ctx *harness.Ctx) {
	c := api(ctx)
	for _, tc := range [][3]string{
		{"superuser", "org", "a role the catalog does not define"},
		{"viewer", "*", "viewer at scope \\"*\\""},
		{"viewer", "org", "viewer at org (the catalog allows viewer at team and project scopes)"},
		{"team_admin", "project:eng/api", "team_admin at a project (the catalog allows it at team scopes)"},
	} {
		r, _ := assignAs(c, "olu", tc[0], tc[1], "")
		ctx.Equal(r.Status, 422, "olu assigning %s must be refused: the catalog is the only source of roles and of the scope kinds each may be granted at; the status", tc[2])
	}
	r, _ := assignAs(c, "olu", "developer", "project:eng/api", "")
	ctx.Equal(r.Status, 201, "olu assigning developer at project:eng/api (%s)", r.Text())
	ctx.Equal(heldByCyd(), []string{"developer@project:eng/api"}, "only the assignment the catalog allows may be written; cyd's grants")
}

func CheckNoEscalation(ctx *harness.Ctx) {
	c := api(ctx)
	r, body := assignAs(c, "ada", "org_admin", "org", "")
	ctx.Equal(r.Status, 403, "ada (team_admin at team:eng) granting org_admin at org must be refused: an assigner hands out only what it holds; the status")
	ctx.Assert(body.MissingPermission != "", "the 403 must name the missing permission (missing_permission), got %s", r.Text())
	r, _ = assignAs(c, "ada", "team_admin", "team:ops", "")
	ctx.Equal(r.Status, 403, "ada granting team_admin at team:ops must be refused (team:eng does not cover team:ops); the status")
	r, body = assignAs(c, "ada", "developer", "project:eng/api", "")
	ctx.Assert(r.Status == 403 && body.MissingPermission == "code:write", "ada granting developer (code:write, team:read) at project:eng/api answered %d %s, expected 403 naming code:write, which ada does not hold", r.Status, r.Text())
	r, body = assignAs(c, "bob", "viewer", "team:eng", "")
	ctx.Assert(r.Status == 403 && body.MissingPermission == "roles:assign", "bob (viewer at team:eng) granting viewer answered %d %s, expected 403 naming roles:assign", r.Status, r.Text())
	r, _ = assignAs(c, "ada", "viewer", "project:eng/api", "")
	ctx.Equal(r.Status, 201, "ada granting viewer at project:eng/api must succeed, team:eng covers its projects (%s); the status", r.Text())
	ctx.Equal(heldByCyd(), []string{"viewer@project:eng/api"}, "a refused assignment was written; cyd's grants")
}

func CheckIdempotent(ctx *harness.Ctx) {
	c := api(ctx)
	none := c.Post("/v1/roles/assignments", map[string]string{"subject": "cyd", "role": "viewer", "scope": "team:eng"}, "X-Assigner-Id", "olu")
	ctx.Equal(none.Status, 400, "an assignment without Idempotency-Key")
	ctx.Equal(heldByCyd(), []string{}, "an assignment without Idempotency-Key must write nothing; cyd's grants")
	first, a := assignAs(c, "olu", "viewer", "team:eng", "k-1")
	replay, b := assignAs(c, "olu", "viewer", "team:eng", "k-1")
	ctx.Assert(first.Status == 201 && (replay.Status == 200 || replay.Status == 201), "the assignment answered %d, its replay %d", first.Status, replay.Status)
	ctx.Equal(b.GrantID, a.GrantID, "a replay of Idempotency-Key k-1 must answer the recorded grant; its grant_id")
	ctx.Equal(len(heldByCyd()), 1, "a retried assignment must write one grant; cyd's grants")
	other, _ := assignAs(c, "olu", "viewer", "team:ops", "k-2")
	ctx.Assert(other.Status == 201 && len(heldByCyd()) == 2, "an assignment with a new key answered %d; cyd holds %v", other.Status, heldByCyd())
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "permz/grants.h"

namespace {

harness::HTTP api(harness::Ctx& ctx) {
  grants::add("olu", "org_admin", "org", "root");
  grants::add("ada", "team_admin", "team:eng", "olu");
  grants::add("bob", "viewer", "team:eng", "ada");
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response assignAs(harness::HTTP& c, const std::string& assigner, const std::string& role, const std::string& scope,
                           std::string key = "") {
  if (key.empty()) key = assigner + "/" + role + "/" + scope;
  const std::string body = nlohmann::json{{"subject", "cyd"}, {"role", role}, {"scope", scope}}.dump();
  return c.Post("/v1/roles/assignments", body, "Content-Type", "application/json", "X-Assigner-Id", assigner, "Idempotency-Key", key);
}

std::string field(const harness::Response& r, const std::string& name) {
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  return body.is_object() && body.contains(name) && body[name].is_string() ? body[name].get<std::string>() : "";
}

std::vector<std::string> heldByCyd() {
  std::vector<std::string> out;
  for (const grants::Grant& g : grants::grantsOf("cyd")) out.push_back(g.role + "@" + g.scope);
  return out;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = assignAs(c, "olu", "viewer", "team:eng");
  ctx.Equal(r.Status, 201, "olu (org_admin at org) assigning viewer at team:eng (%s)", r.Text());
  ctx.Assert(field(r, "subject") == "cyd" && field(r, "role") == "viewer" && field(r, "scope") == "team:eng" && !field(r, "grant_id").empty(),
             "the 201 must carry the grant (grant_id, subject, role, scope), got %s", r.Text());
  ctx.Equal(heldByCyd(), {"viewer@team:eng"}, "after the assignment, cyd's grants");
}

void CheckCatalog(harness::Ctx& ctx) {
  auto c = api(ctx);
  const std::vector<std::vector<std::string>> invalid = {
      {"superuser", "org", "a role the catalog does not define"},
      {"viewer", "*", "viewer at scope \\"*\\""},
      {"viewer", "org", "viewer at org (the catalog allows viewer at team and project scopes)"},
      {"team_admin", "project:eng/api", "team_admin at a project (the catalog allows it at team scopes)"},
  };
  for (const auto& tc : invalid) {
    const auto r = assignAs(c, "olu", tc[0], tc[1]);
    ctx.Equal(r.Status, 422, "olu assigning %s must be refused: the catalog is the only source of roles and of the scope kinds each may be granted at; the status", tc[2]);
  }
  const auto r = assignAs(c, "olu", "developer", "project:eng/api");
  ctx.Equal(r.Status, 201, "olu assigning developer at project:eng/api (%s)", r.Text());
  ctx.Equal(heldByCyd(), {"developer@project:eng/api"}, "only the assignment the catalog allows may be written; cyd's grants");
}

void CheckNoEscalation(harness::Ctx& ctx) {
  auto c = api(ctx);
  auto r = assignAs(c, "ada", "org_admin", "org");
  ctx.Equal(r.Status, 403, "ada (team_admin at team:eng) granting org_admin at org must be refused: an assigner hands out only what it holds; the status");
  ctx.Assert(!field(r, "missing_permission").empty(), "the 403 must name the missing permission (missing_permission), got %s", r.Text());
  r = assignAs(c, "ada", "team_admin", "team:ops");
  ctx.Equal(r.Status, 403, "ada granting team_admin at team:ops must be refused (team:eng does not cover team:ops); the status");
  r = assignAs(c, "ada", "developer", "project:eng/api");
  ctx.Assert(r.Status == 403 && field(r, "missing_permission") == "code:write",
             "ada granting developer (code:write, team:read) at project:eng/api answered %d %s, expected 403 naming code:write, which ada does not hold", r.Status, r.Text());
  r = assignAs(c, "bob", "viewer", "team:eng");
  ctx.Assert(r.Status == 403 && field(r, "missing_permission") == "roles:assign", "bob (viewer at team:eng) granting viewer answered %d %s, expected 403 naming roles:assign", r.Status, r.Text());
  r = assignAs(c, "ada", "viewer", "project:eng/api");
  ctx.Equal(r.Status, 201, "ada granting viewer at project:eng/api must succeed, team:eng covers its projects (%s); the status", r.Text());
  ctx.Equal(heldByCyd(), {"viewer@project:eng/api"}, "a refused assignment was written; cyd's grants");
}

void CheckIdempotent(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto none = c.Post("/v1/roles/assignments", R"({"subject": "cyd", "role": "viewer", "scope": "team:eng"})", "Content-Type", "application/json", "X-Assigner-Id", "olu");
  ctx.Equal(none.Status, 400, "an assignment without Idempotency-Key");
  ctx.Equal(heldByCyd(), std::vector<std::string>{}, "an assignment without Idempotency-Key must write nothing; cyd's grants");
  const auto first = assignAs(c, "olu", "viewer", "team:eng", "k-1");
  const auto replay = assignAs(c, "olu", "viewer", "team:eng", "k-1");
  ctx.Assert(first.Status == 201 && (replay.Status == 200 || replay.Status == 201), "the assignment answered %d, its replay %d", first.Status, replay.Status);
  ctx.Equal(field(replay, "grant_id"), field(first, "grant_id"), "a replay of Idempotency-Key k-1 must answer the recorded grant; its grant_id");
  ctx.Equal(heldByCyd().size(), 1, "a retried assignment must write one grant; cyd's grants");
  const auto other = assignAs(c, "olu", "viewer", "team:ops", "k-2");
  ctx.Assert(other.Status == 201 && heldByCyd().size() == 2, "an assignment with a new key answered %d; cyd holds %d grants", other.Status, heldByCyd().size());
}
`,
  },
  hints: [
    'Log in as a team admin of `team:eng` and grant yourself `org_admin` at `org`: the request answers 201. A grant at `scope: "*"` goes through too, and a retried request after a timeout writes a second grant.',
    'The starter asks only whether the assigner holds an admin role anywhere; it never compares the role being handed out, or its scope, with anything in the catalog or in what the assigner holds, and it never reads `Idempotency-Key`.',
    'Answer `grants.assignment(assigner, key)` when recorded; 422 unless `catalog.ROLES[role]` allows `catalog.scope_kind(scope)`; 403 on the first of `roles:assign` + `permissions_of(role)` missing from `grants.effective(assigner, scope)`; then `add` and `record_assignment`.',
  ],
  debrief: `Authorization and assignment are one question here: to hand out a permission you must hold it, at a scope that covers the one you write to. That is why the check is a set comparison over the catalog's permissions instead of an "is admin" flag, why it goes through \`effective\` (which already applies scope containment), and why the catalog alone defines valid roles and scopes, so \`*\` is a 422 instead of a grant nobody can reason about. The idempotency record sits in the grant store, so a retry reads the first answer. Production systems also expire grants, route privileged roles through an approval, and keep an append-only log of who assigned what, which access reviews read.`,
};
