import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/users/{id}: the owner, the public, and audited support',
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'db', 'support'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/users/{id}\` behind the gateway, which sets
\`X-User-Id\` (and \`X-Role\` for staff): it answers **401** without a caller and **404** for an unknown
account, gives the owner and any \`support\` caller the whole account from \`accounts.get_account\`,
gives everyone else the account minus its email, and sends \`Cache-Control: public, max-age=300\`
on every answer. Your own profile renders; it hides three flaws.

**Failure mode the checks target.** Any member reads another member's phone number; a shared cache
keeps the owner's full record and serves it to the next caller; and a support agent reads any
account without saying why or leaving a trace.

- Everyone but the owner and support gets \`PUBLIC_FIELDS\` only: \`user_id\`, \`name\`, \`status\`,
  \`created_at\`.
- An answer that carries the email or the phone is \`Cache-Control: private, no-store\`; the public
  projection is \`public, max-age=60\`. Every answer carries \`Vary: X-User-Id\`.
- A \`support\` caller (\`SUPPORT_ROLES\`) needs \`X-Support-Reason\` (**400** without it), and the
  read is written with \`accounts.record_audit(caller, user_id, reason)\` before the record is
  returned.`,
  sequence: {
    participants: ['Member', 'Support agent', 'identityd', 'accounts store'],
    messages: [
      {from: 'Member', to: 'identityd', label: 'GET /v1/users/u-1 · X-User-Id: u-2', kind: 'sync'},
      {from: 'identityd', to: 'accounts store', label: 'get_account(u-1)', kind: 'sync'},
      {
        from: 'identityd',
        to: 'Member',
        label: '200 PUBLIC_FIELDS · public, max-age=60 · Vary: X-User-Id',
        kind: 'reply',
      },
      {
        from: 'Support agent',
        to: 'identityd',
        label: 'GET /v1/users/u-1 · X-Role: support · X-Support-Reason',
        kind: 'sync',
      },
      {from: 'identityd', to: 'accounts store', label: 'record_audit(agent, u-1, reason)', kind: 'sync'},
      {from: 'identityd', to: 'Support agent', label: '200 whole account · private, no-store', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'read-route',
      title: 'Registers GET /v1/users/{id} for the owner',
      detail:
        'Register `GET /v1/users/{id}`: 401 without `X-User-Id`, 404 for an unknown account, the whole account for its owner.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/users\/\{user_id\}["']/, /\b401\b/, /\b404\b/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/users\/:userId['"]/, /\b401\b/, /\b404\b/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/users\/\{id\}"/, /StatusUnauthorized|\b401\b/, /StatusNotFound|\b404\b/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"users"\s*\/\s*Segment\s*\)/, /Unauthorized/, /NotFound/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/users\//, /\b401\b/, /\b404\b/]},
      },
    },
    {
      id: 'public-projection',
      title: 'Everyone else gets the public fields only',
      detail:
        'A caller who is neither the owner nor support gets the fields `PUBLIC_FIELDS` names and nothing else; the starter removes the email and passes the rest, phone included, and any field added to the row later.',
      match: {
        python: {all: [/PUBLIC_FIELDS\s*=/, /in PUBLIC_FIELDS/], none: [/!=\s*["']email["']/]},
        typescript: {all: [/PUBLIC_FIELDS\s*=/, /PUBLIC_FIELDS\.map\(|of PUBLIC_FIELDS/], none: [/!==\s*'email'/]},
        go: {all: [/publicFields\s*=/, /range publicFields/], none: [/delete\(view,\s*"email"\)/]},
        scala: {all: [/PublicFields\s*[:=]/, /PublicFields\.contains/], none: [/-\s*"email"/]},
        cpp: {all: [/kPublicFields\s*=/, /:\s*kPublicFields\)/], none: [/erase\("email"\)/]},
      },
    },
    {
      id: 'cache-scope',
      title: 'Contact data never sits in a shared cache',
      detail:
        "An answer with the email or the phone is `private, no-store`, the public projection `public, max-age=60`, and every answer `Vary: X-User-Id`; the starter marks every answer `public, max-age=300`, so a CDN serves the owner's record to whoever asks next.",
      match: {
        python: {all: [/private, no-store/, /Vary/], none: [/max-age=300/]},
        typescript: {all: [/private, no-store/, /Vary/], none: [/max-age=300/]},
        go: {all: [/private, no-store/, /Vary/], none: [/max-age=300/]},
        scala: {all: [/private, no-store/, /Vary/], none: [/max-age=300/]},
        cpp: {all: [/private, no-store/, /Vary/], none: [/max-age=300/]},
      },
    },
    {
      id: 'support-audit',
      title: 'Support reads need a reason and leave an audit record',
      detail:
        'A `support` caller without `X-Support-Reason` is **400**; with one, `record_audit(caller, user_id, reason)` is written before the account is returned. The starter hands support the record with no reason and no trace.',
      match: {
        python: {all: [/x-support-reason/i, /\b400\b/], order: [/role in SUPPORT_ROLES/, /accounts\.record_audit\(/]},
        typescript: {
          all: [/x-support-reason/i, /\b400\b/],
          order: [/SUPPORT_ROLES\.includes\(role\)/, /recordAudit\(/],
        },
        go: {
          all: [/X-Support-Reason/, /StatusBadRequest|\b400\b/],
          order: [/supportRoles\[role\]/, /accounts\.RecordAudit\(/],
        },
        scala: {
          all: [/X-Support-Reason/, /BadRequest/],
          order: [/SupportRoles\.contains\(role\)/, /Accounts\.recordAudit\(/],
        },
        cpp: {all: [/X-Support-Reason/, /\b400\b/], order: [/kSupportRoles\.count\(role\)/, /accounts::recordAudit\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from identityd import accounts  # get_account, record_audit

app = FastAPI()

SUPPORT_ROLES = ("support",)


@app.get("/v1/users/{user_id}")
def read_user(user_id: str, request: Request) -> JSONResponse:
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    caller = request.headers.get("x-user-id", "")
    if not caller:
        raise HTTPException(status_code=401, detail="X-User-Id is required")
    account = accounts.get_account(user_id)
    if account is None:
        raise HTTPException(status_code=404, detail="no such user")
    role = request.headers.get("x-role", "member")
    if caller == user_id or role in SUPPORT_ROLES:
        view = account
    else:
        view = {name: value for name, value in account.items() if name != "email"}  # members see profiles, not addresses
    # Profiles change rarely: let the CDN keep them for five minutes.
    return JSONResponse(view, headers={"Cache-Control": "public, max-age=300"})
`,
      solution: `from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from identityd import accounts  # get_account, record_audit

app = FastAPI()

SUPPORT_ROLES = ("support",)
PUBLIC_FIELDS = ("user_id", "name", "status", "created_at")
PRIVATE = {"Cache-Control": "private, no-store", "Vary": "X-User-Id"}
PUBLIC = {"Cache-Control": "public, max-age=60", "Vary": "X-User-Id"}


@app.get("/v1/users/{user_id}")
def read_user(user_id: str, request: Request) -> JSONResponse:
    caller = request.headers.get("x-user-id", "")
    if not caller:
        raise HTTPException(status_code=401, detail="X-User-Id is required")
    account = accounts.get_account(user_id)
    if account is None:
        raise HTTPException(status_code=404, detail="no such user")
    role = request.headers.get("x-role", "member")
    if caller == user_id:
        return JSONResponse(account, headers=PRIVATE)  # contact data: never in a shared cache
    if role in SUPPORT_ROLES:
        reason = request.headers.get("x-support-reason", "")
        if not reason:
            raise HTTPException(status_code=400, detail="X-Support-Reason is required")
        accounts.record_audit(caller, user_id, reason)  # on the trail before the record leaves
        return JSONResponse(account, headers=PRIVATE)
    # An allowlist: a field added to the row later stays private until someone lists it here.
    return JSONResponse({name: account[name] for name in PUBLIC_FIELDS}, headers=PUBLIC)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {getAccount, recordAudit} from 'identityd/accounts';

export const app = Fastify();

export const SUPPORT_ROLES = ['support'];

app.get('/v1/users/:userId', async (request, reply) => {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const {userId} = request.params as {userId: string};
  const caller = request.headers['x-user-id'];
  if (typeof caller !== 'string' || caller === '') return reply.code(401).send({error: 'X-User-Id is required'});
  const account = await getAccount(userId);
  if (account === null) return reply.code(404).send({error: 'no such user'});
  const role = (request.headers['x-role'] as string | undefined) ?? 'member';
  const view =
    caller === userId || SUPPORT_ROLES.includes(role)
      ? account
      : Object.fromEntries(Object.entries(account).filter(([name]) => name !== 'email')); // members see profiles, not addresses
  // Profiles change rarely: let the CDN keep them for five minutes.
  return reply.header('Cache-Control', 'public, max-age=300').send(view);
});
`,
      solution: `import Fastify from 'fastify';

import {getAccount, recordAudit} from 'identityd/accounts';

export const app = Fastify();

export const SUPPORT_ROLES = ['support'];
export const PUBLIC_FIELDS = ['user_id', 'name', 'status', 'created_at'] as const;

app.get('/v1/users/:userId', async (request, reply) => {
  const {userId} = request.params as {userId: string};
  const caller = request.headers['x-user-id'];
  if (typeof caller !== 'string' || caller === '') return reply.code(401).send({error: 'X-User-Id is required'});
  const account = await getAccount(userId);
  if (account === null) return reply.code(404).send({error: 'no such user'});
  const role = (request.headers['x-role'] as string | undefined) ?? 'member';
  reply.header('Vary', 'X-User-Id');
  // Contact data: never in a shared cache.
  if (caller === userId) return reply.header('Cache-Control', 'private, no-store').send(account);
  if (SUPPORT_ROLES.includes(role)) {
    const reason = request.headers['x-support-reason'];
    if (typeof reason !== 'string' || reason === '') return reply.code(400).send({error: 'X-Support-Reason is required'});
    await recordAudit(caller, userId, reason); // on the trail before the record leaves
    return reply.header('Cache-Control', 'private, no-store').send(account);
  }
  // An allowlist: a field added to the row later stays private until someone lists it here.
  const view = Object.fromEntries(PUBLIC_FIELDS.map(name => [name, account[name]]));
  return reply.header('Cache-Control', 'public, max-age=60').send(view);
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"identityd/accounts" // accounts.GetAccount, RecordAudit
)

var supportRoles = map[string]bool{"support": true}

func fieldsOf(a *accounts.Account) map[string]any {
	return map[string]any{"user_id": a.UserID, "email": a.Email, "phone": a.Phone, "name": a.Name, "status": a.Status, "created_at": a.CreatedAt}
}

func readUser(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	userID := r.PathValue("id")
	caller := r.Header.Get("X-User-Id")
	if caller == "" {
		http.Error(rw, "X-User-Id is required", http.StatusUnauthorized)
		return
	}
	account, err := accounts.GetAccount(r.Context(), userID)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusServiceUnavailable)
		return
	}
	if account == nil {
		http.Error(rw, "no such user", http.StatusNotFound)
		return
	}
	role := r.Header.Get("X-Role")
	view := fieldsOf(account)
	if caller != userID && !supportRoles[role] {
		delete(view, "email") // members see profiles, not addresses
	}
	// Profiles change rarely: let the CDN keep them for five minutes.
	rw.Header().Set("Cache-Control", "public, max-age=300")
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode(view)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/users/{id}", readUser)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"

	"identityd/accounts" // accounts.GetAccount, RecordAudit
)

var supportRoles = map[string]bool{"support": true}

var publicFields = []string{"user_id", "name", "status", "created_at"}

func fieldsOf(a *accounts.Account) map[string]any {
	return map[string]any{"user_id": a.UserID, "email": a.Email, "phone": a.Phone, "name": a.Name, "status": a.Status, "created_at": a.CreatedAt}
}

func writeView(rw http.ResponseWriter, view map[string]any, cacheControl string) {
	rw.Header().Set("Cache-Control", cacheControl)
	rw.Header().Set("Vary", "X-User-Id")
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode(view)
}

func readUser(rw http.ResponseWriter, r *http.Request) {
	userID := r.PathValue("id")
	caller := r.Header.Get("X-User-Id")
	if caller == "" {
		http.Error(rw, "X-User-Id is required", http.StatusUnauthorized)
		return
	}
	account, err := accounts.GetAccount(r.Context(), userID)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusServiceUnavailable)
		return
	}
	if account == nil {
		http.Error(rw, "no such user", http.StatusNotFound)
		return
	}
	role := r.Header.Get("X-Role")
	if caller == userID {
		writeView(rw, fieldsOf(account), "private, no-store") // contact data: never in a shared cache
		return
	}
	if supportRoles[role] {
		reason := r.Header.Get("X-Support-Reason")
		if reason == "" {
			http.Error(rw, "X-Support-Reason is required", http.StatusBadRequest)
			return
		}
		if err := accounts.RecordAudit(r.Context(), caller, userID, reason); err != nil { // on the trail before the record leaves
			http.Error(rw, err.Error(), http.StatusServiceUnavailable)
			return
		}
		writeView(rw, fieldsOf(account), "private, no-store")
		return
	}
	// An allowlist: a field added to the row later stays private until someone lists it here.
	all, view := fieldsOf(account), map[string]any{}
	for _, name := range publicFields {
		view[name] = all[name]
	}
	writeView(rw, view, "public, max-age=60")
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/users/{id}", readUser)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import identityd.Accounts // Accounts.getAccount, recordAudit

object Read {
  val SupportRoles: Set[String] = Set("support")

  val route: Route = path("v1" / "users" / Segment) { userId =>
    get {
      (optionalHeaderValueByName("X-User-Id") & optionalHeaderValueByName("X-Role")) { (callerHeader, roleHeader) =>
        // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
        val caller = callerHeader.getOrElse("")
        val role = roleHeader.getOrElse("member")
        if (caller.isEmpty) complete(StatusCodes.Unauthorized -> "X-User-Id is required")
        else
          Accounts.getAccount(userId) match {
            case None => complete(StatusCodes.NotFound -> "no such user")
            case Some(account) =>
              val full = account.toJson
              val view = if (caller == userId || SupportRoles.contains(role)) full else JsObject(full.fields - "email") // members see profiles, not addresses
              // Profiles change rarely: let the CDN keep them for five minutes.
              complete(HttpResponse(StatusCodes.OK, headers = List(RawHeader("Cache-Control", "public, max-age=300")), entity = HttpEntity(ContentTypes.\`application/json\`, view.compactPrint)))
          }
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import identityd.Accounts // Accounts.getAccount, recordAudit

object Read {
  val SupportRoles: Set[String] = Set("support")
  val PublicFields: Seq[String] = Seq("user_id", "name", "status", "created_at")

  private def view(body: JsObject, cacheControl: String): HttpResponse =
    HttpResponse(StatusCodes.OK, headers = List(RawHeader("Cache-Control", cacheControl), RawHeader("Vary", "X-User-Id")),
      entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  val route: Route = path("v1" / "users" / Segment) { userId =>
    get {
      (optionalHeaderValueByName("X-User-Id") & optionalHeaderValueByName("X-Role") & optionalHeaderValueByName("X-Support-Reason")) {
        (callerHeader, roleHeader, reasonHeader) =>
          val caller = callerHeader.getOrElse("")
          val role = roleHeader.getOrElse("member")
          if (caller.isEmpty) complete(StatusCodes.Unauthorized -> "X-User-Id is required")
          else
            Accounts.getAccount(userId) match {
              case None => complete(StatusCodes.NotFound -> "no such user")
              case Some(account) if caller == userId => complete(view(account.toJson, "private, no-store")) // contact data: never in a shared cache
              case Some(account) if SupportRoles.contains(role) =>
                reasonHeader.filter(_.nonEmpty) match {
                  case None => complete(StatusCodes.BadRequest -> "X-Support-Reason is required")
                  case Some(reason) =>
                    Accounts.recordAudit(caller, userId, reason) // on the trail before the record leaves
                    complete(view(account.toJson, "private, no-store"))
                }
              case Some(account) =>
                // An allowlist: a field added to the row later stays private until someone lists it here.
                complete(view(JsObject(account.toJson.fields.filter { case (name, _) => PublicFields.contains(name) }), "public, max-age=60"))
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

#include <set>
#include <string>

#include "identityd/accounts.h"  // accounts::getAccount, recordAudit, toJson

using json = nlohmann::json;

const std::set<std::string> kSupportRoles = {"support"};

void read_user(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const std::string user_id = req.matches[1];
  const std::string caller = req.get_header_value("X-User-Id");
  if (caller.empty()) {
    res.status = 401;
    res.set_content("X-User-Id is required", "text/plain");
    return;
  }
  const auto account = accounts::getAccount(user_id);
  if (!account) {
    res.status = 404;
    res.set_content("no such user", "text/plain");
    return;
  }
  const std::string role = req.has_header("X-Role") ? req.get_header_value("X-Role") : "member";
  json view = accounts::toJson(*account);
  if (caller != user_id && !kSupportRoles.count(role)) view.erase("email");  // members see profiles, not addresses
  // Profiles change rarely: let the CDN keep them for five minutes.
  res.set_header("Cache-Control", "public, max-age=300");
  res.set_content(view.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/users/([\\w-]+))", read_user); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <set>
#include <string>
#include <vector>

#include "identityd/accounts.h"  // accounts::getAccount, recordAudit, toJson

using json = nlohmann::json;

const std::set<std::string> kSupportRoles = {"support"};
const std::vector<std::string> kPublicFields = {"user_id", "name", "status", "created_at"};

void sendView(httplib::Response& res, const json& view, const std::string& cache_control) {
  res.set_header("Cache-Control", cache_control);
  res.set_header("Vary", "X-User-Id");
  res.set_content(view.dump(), "application/json");
}

void read_user(const httplib::Request& req, httplib::Response& res) {
  const std::string user_id = req.matches[1];
  const std::string caller = req.get_header_value("X-User-Id");
  if (caller.empty()) {
    res.status = 401;
    res.set_content("X-User-Id is required", "text/plain");
    return;
  }
  const auto account = accounts::getAccount(user_id);
  if (!account) {
    res.status = 404;
    res.set_content("no such user", "text/plain");
    return;
  }
  const std::string role = req.has_header("X-Role") ? req.get_header_value("X-Role") : "member";
  if (caller == user_id) {
    sendView(res, accounts::toJson(*account), "private, no-store");  // contact data: never in a shared cache
    return;
  }
  if (kSupportRoles.count(role)) {
    const std::string reason = req.get_header_value("X-Support-Reason");
    if (reason.empty()) {
      res.status = 400;
      res.set_content("X-Support-Reason is required", "text/plain");
      return;
    }
    accounts::recordAudit(caller, user_id, reason);  // on the trail before the record leaves
    sendView(res, accounts::toJson(*account), "private, no-store");
    return;
  }
  // An allowlist: a field added to the row later stays private until someone lists it here.
  const json full = accounts::toJson(*account);
  json view = json::object();
  for (const std::string& name : kPublicFields) view[name] = full[name];
  sendView(res, view, "public, max-age=60");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/users/([\\w-]+))", read_user); }
`,
    },
  },
  harness: {
    python: `from identityd import accounts

PUBLIC = {"user_id", "name", "status", "created_at"}


def _api(ctx):
    accounts.create_account("u-1", "ada@example.com", "+442079460958", "Ada Lovelace")
    accounts.create_account("u-2", "eve@example.com", "+15550100200", "Eve")
    return ctx.client(ctx.load("read").app)


async def _get(c, user_id, **headers):
    names = {"caller": "X-User-Id", "role": "X-Role", "reason": "X-Support-Reason"}
    return await c.get(f"/v1/users/{user_id}", headers={names[k]: v for k, v in headers.items()})


def _directives(r):
    return {d.strip() for d in r.headers.get("cache-control", "").split(",") if d.strip()}


def _varies_by_caller(r):
    return "x-user-id" in {v.strip().lower() for v in r.headers.get("vary", "").split(",")}


async def check_read_route(ctx):
    async with _api(ctx) as c:
        own = await _get(c, "u-1", caller="u-1")
        anonymous = await _get(c, "u-1")
        unknown = await _get(c, "u-9", caller="u-1")
    assert own.status_code == 200, f"the owner's read answered {own.status_code}: {own.text}"
    body = own.json()
    assert body.get("email") == "ada@example.com" and body.get("phone") == "+442079460958", f"the owner must see their whole account, got {body}"
    assert anonymous.status_code == 401, f"a read without X-User-Id answered {anonymous.status_code}, expected 401"
    assert unknown.status_code == 404, f"a read of an unknown account answered {unknown.status_code}, expected 404"


async def check_public_projection(ctx):
    async with _api(ctx) as c:
        r = await _get(c, "u-1", caller="u-2")
    assert r.status_code == 200, f"a member's read of u-1 answered {r.status_code}: {r.text}"
    body = r.json()
    for value in ("ada@example.com", "+442079460958", "7946"):
        assert value not in r.text, f"another member's read of u-1 carries {value!r}: {r.text}. Everyone but the owner gets PUBLIC_FIELDS only"
    assert set(body) == PUBLIC, f"another member's read of u-1 carries the fields {sorted(body)}, expected exactly {sorted(PUBLIC)}"
    assert body["name"] == "Ada Lovelace" and body["status"] == "unverified", f"the public view must carry the name and the status, got {body}"


async def check_cache_scope(ctx):
    async with _api(ctx) as c:
        own = await _get(c, "u-1", caller="u-1")
        support = await _get(c, "u-1", caller="agent-7", role="support", reason="ticket 4411")
        public = await _get(c, "u-1", caller="u-2")
    for who, r in (("the owner's read", own), ("a support read", support)):
        d = _directives(r)
        assert "public" not in d and "no-store" in d, f"{who} carries the email and the phone and answered Cache-Control {r.headers.get('cache-control')!r}: a shared cache keeps it and serves it to the next caller. Use private, no-store"
    d = _directives(public)
    assert "public" in d and "max-age=60" in d, f"the public view answered Cache-Control {public.headers.get('cache-control')!r}, expected public, max-age=60"
    for who, r in (("the owner's read", own), ("the public view", public)):
        assert _varies_by_caller(r), f"{who} answered Vary {r.headers.get('vary')!r}: a cache must key the answer by X-User-Id"


async def check_support_audit(ctx):
    async with _api(ctx) as c:
        blind = await _get(c, "u-1", caller="agent-7", role="support")
        assert blind.status_code == 400, f"a support read without X-Support-Reason answered {blind.status_code}, expected 400"
        assert accounts.audit_entries() == [], f"a refused support read left audit entries {accounts.audit_entries()}"
        r = await _get(c, "u-1", caller="agent-7", role="support", reason="ticket 4411")
        member = await _get(c, "u-1", caller="u-2")
    assert r.status_code == 200 and r.json().get("email") == "ada@example.com", f"a support read with a reason must answer the whole account, got {r.status_code} {r.text}"
    entries = [{k: e.get(k) for k in ("actor", "user_id", "reason")} for e in accounts.audit_entries()]
    assert entries == [{"actor": "agent-7", "user_id": "u-1", "reason": "ticket 4411"}], f"after one support read the audit trail holds {entries}, expected agent-7 reading u-1 for ticket 4411"
    assert member.status_code == 200, f"a member's read answered {member.status_code}"
`,
    typescript: `const PUBLIC = ['created_at', 'name', 'status', 'user_id'];

async function api(ctx) {
  const accounts = ctx.load('/support/identityd/accounts.ts');
  await accounts.createAccount('u-1', 'ada@example.com', '+442079460958', 'Ada Lovelace');
  await accounts.createAccount('u-2', 'eve@example.com', '+15550100200', 'Eve');
  return {c: ctx.client(ctx.load('read').app), accounts};
}

function read(c, userId: string, headers: {caller?: string; role?: string; reason?: string} = {}) {
  const sent: Record<string, string> = {};
  if (headers.caller !== undefined) sent['X-User-Id'] = headers.caller;
  if (headers.role !== undefined) sent['X-Role'] = headers.role;
  if (headers.reason !== undefined) sent['X-Support-Reason'] = headers.reason;
  return c.get(\`/v1/users/\${userId}\`, {headers: sent});
}

const directives = r => new Set(String(r.headers['cache-control'] ?? '').split(',').map(d => d.trim()).filter(d => d !== ''));

const variesByCaller = r => String(r.headers.vary ?? '').split(',').map(v => v.trim().toLowerCase()).includes('x-user-id');

export async function check_read_route(ctx) {
  const {c} = await api(ctx);
  const own = await read(c, 'u-1', {caller: 'u-1'});
  assert.equal(own.status, 200, \`the owner's read answered \${own.status}: \${own.text}\`);
  const body = own.json();
  assert(body.email === 'ada@example.com' && body.phone === '+442079460958', \`the owner must see their whole account, got \${own.text}\`);
  assert.equal((await read(c, 'u-1')).status, 401, 'a read without X-User-Id must answer 401');
  assert.equal((await read(c, 'u-9', {caller: 'u-1'})).status, 404, 'a read of an unknown account must answer 404');
}

export async function check_public_projection(ctx) {
  const {c} = await api(ctx);
  const r = await read(c, 'u-1', {caller: 'u-2'});
  assert.equal(r.status, 200, \`a member's read of u-1 answered \${r.status}: \${r.text}\`);
  for (const value of ['ada@example.com', '+442079460958', '7946']) {
    assert(!r.text.includes(value), \`another member's read of u-1 carries \${value}: \${r.text}. Everyone but the owner gets PUBLIC_FIELDS only\`);
  }
  const body = r.json();
  assert.deepStrictEqual(Object.keys(body).sort(), PUBLIC, \`another member's read of u-1 carries the fields \${JSON.stringify(Object.keys(body).sort())}, expected exactly \${JSON.stringify(PUBLIC)}\`);
  assert(body.name === 'Ada Lovelace' && body.status === 'unverified', \`the public view must carry the name and the status, got \${r.text}\`);
}

export async function check_cache_scope(ctx) {
  const {c} = await api(ctx);
  const own = await read(c, 'u-1', {caller: 'u-1'});
  const support = await read(c, 'u-1', {caller: 'agent-7', role: 'support', reason: 'ticket 4411'});
  const pub = await read(c, 'u-1', {caller: 'u-2'});
  for (const [who, r] of [["the owner's read", own], ['a support read', support]] as const) {
    const d = directives(r);
    assert(!d.has('public') && d.has('no-store'), \`\${who} carries the email and the phone and answered Cache-Control \${JSON.stringify(r.headers['cache-control'])}: a shared cache keeps it and serves it to the next caller. Use private, no-store\`);
  }
  const d = directives(pub);
  assert(d.has('public') && d.has('max-age=60'), \`the public view answered Cache-Control \${JSON.stringify(pub.headers['cache-control'])}, expected public, max-age=60\`);
  for (const [who, r] of [["the owner's read", own], ['the public view', pub]] as const) {
    assert(variesByCaller(r), \`\${who} answered Vary \${JSON.stringify(r.headers.vary)}: a cache must key the answer by X-User-Id\`);
  }
}

export async function check_support_audit(ctx) {
  const {c, accounts} = await api(ctx);
  const blind = await read(c, 'u-1', {caller: 'agent-7', role: 'support'});
  assert.equal(blind.status, 400, \`a support read without X-Support-Reason answered \${blind.status}, expected 400\`);
  assert.deepStrictEqual(await accounts.auditEntries(), [], 'a refused support read left audit entries');
  const r = await read(c, 'u-1', {caller: 'agent-7', role: 'support', reason: 'ticket 4411'});
  assert(r.status === 200 && r.json().email === 'ada@example.com', \`a support read with a reason must answer the whole account, got \${r.status} \${r.text}\`);
  const entries = (await accounts.auditEntries()).map(e => ({actor: e.actor, user_id: e.user_id, reason: e.reason}));
  assert.deepStrictEqual(entries, [{actor: 'agent-7', user_id: 'u-1', reason: 'ticket 4411'}], \`after one support read the audit trail holds \${JSON.stringify(entries)}, expected agent-7 reading u-1 for ticket 4411\`);
  assert.equal((await read(c, 'u-1', {caller: 'u-2'})).status, 200, "a member's read must answer 200");
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"sort"
	"strings"

	"identityd/accounts"

	"leetbuild/harness"
)

var readBg = context.Background()

func readAPI(ctx *harness.Ctx) *harness.HTTP {
	for _, a := range [][4]string{{"u-1", "ada@example.com", "+442079460958", "Ada Lovelace"}, {"u-2", "eve@example.com", "+15550100200", "Eve"}} {
		_, err := accounts.CreateAccount(readBg, a[0], a[1], a[2], a[3])
		ctx.NoError(err, "CreateAccount(%s) failed", a[0])
	}
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func directives(r *harness.Response) map[string]bool {
	out := map[string]bool{}
	for _, d := range strings.Split(r.Header.Get("Cache-Control"), ",") {
		if d = strings.TrimSpace(d); d != "" {
			out[d] = true
		}
	}
	return out
}

func variesByCaller(r *harness.Response) bool {
	for _, v := range strings.Split(r.Header.Get("Vary"), ",") {
		if strings.EqualFold(strings.TrimSpace(v), "X-User-Id") {
			return true
		}
	}
	return false
}

func bodyOf(ctx *harness.Ctx, r *harness.Response) map[string]any {
	var body map[string]any
	r.Decode(&body)
	return body
}

func CheckReadRoute(ctx *harness.Ctx) {
	c := readAPI(ctx)
	own := c.Get("/v1/users/u-1", "X-User-Id", "u-1")
	ctx.Equal(own.Status, 200, "the owner's read (%s)", own.Text())
	body := bodyOf(ctx, own)
	ctx.Assert(body["email"] == "ada@example.com" && body["phone"] == "+442079460958", "the owner must see their whole account, got %s", own.Text())
	ctx.Equal(c.Get("/v1/users/u-1").Status, 401, "a read without X-User-Id")
	ctx.Equal(c.Get("/v1/users/u-9", "X-User-Id", "u-1").Status, 404, "a read of an unknown account")
}

func CheckPublicProjection(ctx *harness.Ctx) {
	c := readAPI(ctx)
	r := c.Get("/v1/users/u-1", "X-User-Id", "u-2")
	ctx.Equal(r.Status, 200, "a member's read of u-1 (%s)", r.Text())
	for _, value := range []string{"ada@example.com", "+442079460958", "7946"} {
		ctx.Assert(!strings.Contains(r.Text(), value), "another member's read of u-1 carries %q: %s. Everyone but the owner gets publicFields only", value, r.Text())
	}
	body := bodyOf(ctx, r)
	names := make([]string, 0, len(body))
	for name := range body {
		names = append(names, name)
	}
	sort.Strings(names)
	ctx.Equal(names, []string{"created_at", "name", "status", "user_id"}, "the fields of another member's read of u-1")
	ctx.Assert(body["name"] == "Ada Lovelace" && body["status"] == "unverified", "the public view must carry the name and the status, got %s", r.Text())
}

func CheckCacheScope(ctx *harness.Ctx) {
	c := readAPI(ctx)
	own := c.Get("/v1/users/u-1", "X-User-Id", "u-1")
	support := c.Get("/v1/users/u-1", "X-User-Id", "agent-7", "X-Role", "support", "X-Support-Reason", "ticket 4411")
	public := c.Get("/v1/users/u-1", "X-User-Id", "u-2")
	for who, r := range map[string]*harness.Response{"the owner's read": own, "a support read": support} {
		d := directives(r)
		ctx.Assert(!d["public"] && d["no-store"], "%s carries the email and the phone and answered Cache-Control %q: a shared cache keeps it and serves it to the next caller. Use private, no-store", who, r.Header.Get("Cache-Control"))
	}
	d := directives(public)
	ctx.Assert(d["public"] && d["max-age=60"], "the public view answered Cache-Control %q, expected public, max-age=60", public.Header.Get("Cache-Control"))
	for who, r := range map[string]*harness.Response{"the owner's read": own, "the public view": public} {
		ctx.Assert(variesByCaller(r), "%s answered Vary %q: a cache must key the answer by X-User-Id", who, r.Header.Get("Vary"))
	}
}

func CheckSupportAudit(ctx *harness.Ctx) {
	c := readAPI(ctx)
	blind := c.Get("/v1/users/u-1", "X-User-Id", "agent-7", "X-Role", "support")
	ctx.Equal(blind.Status, 400, "a support read without X-Support-Reason")
	ctx.Equal(len(accounts.AuditEntries(readBg)), 0, "a refused support read must leave no audit entry; the entries")
	r := c.Get("/v1/users/u-1", "X-User-Id", "agent-7", "X-Role", "support", "X-Support-Reason", "ticket 4411")
	ctx.Assert(r.Status == 200 && bodyOf(ctx, r)["email"] == "ada@example.com", "a support read with a reason must answer the whole account, got %d %s", r.Status, r.Text())
	entries := accounts.AuditEntries(readBg)
	ctx.Assert(len(entries) == 1 && entries[0].Actor == "agent-7" && entries[0].UserID == "u-1" && entries[0].Reason == "ticket 4411", "after one support read the audit trail holds %+v, expected agent-7 reading u-1 for ticket 4411", entries)
	ctx.Equal(c.Get("/v1/users/u-1", "X-User-Id", "u-2").Status, 200, "a member's read")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <set>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

#include "identityd/accounts.h"

using json = nlohmann::json;

namespace {

harness::HTTP readApi(harness::Ctx& ctx) {
  accounts::createAccount("u-1", "ada@example.com", "+442079460958", "Ada Lovelace");
  accounts::createAccount("u-2", "eve@example.com", "+15550100200", "Eve");
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

std::set<std::string> listOf(const std::string& header) {
  std::set<std::string> out;
  std::stringstream in(header);
  std::string d;
  while (std::getline(in, d, ',')) {
    const auto a = d.find_first_not_of(' ');
    if (a == std::string::npos) continue;
    std::string v = d.substr(a, d.find_last_not_of(' ') - a + 1);
    for (char& ch : v) ch = static_cast<char>(std::tolower(static_cast<unsigned char>(ch)));
    out.insert(v);
  }
  return out;
}

json bodyOf(const harness::Response& r) { return json::parse(r.Text(), nullptr, false); }

}  // namespace

void CheckReadRoute(harness::Ctx& ctx) {
  auto c = readApi(ctx);
  const auto own = c.Get("/v1/users/u-1", "X-User-Id", "u-1");
  ctx.Equal(own.Status, 200, "the owner's read (%s)", own.Text());
  const json body = bodyOf(own);
  ctx.Assert(body.is_object() && body.value("email", "") == "ada@example.com" && body.value("phone", "") == "+442079460958", "the owner must see their whole account, got %s", own.Text());
  ctx.Equal(c.Get("/v1/users/u-1").Status, 401, "a read without X-User-Id");
  ctx.Equal(c.Get("/v1/users/u-9", "X-User-Id", "u-1").Status, 404, "a read of an unknown account");
}

void CheckPublicProjection(harness::Ctx& ctx) {
  auto c = readApi(ctx);
  const auto r = c.Get("/v1/users/u-1", "X-User-Id", "u-2");
  ctx.Equal(r.Status, 200, "a member's read of u-1 (%s)", r.Text());
  for (const std::string value : {"ada@example.com", "+442079460958", "7946"}) {
    ctx.Assert(r.Text().find(value) == std::string::npos, "another member's read of u-1 carries %q: %s. Everyone but the owner gets kPublicFields only", value, r.Text());
  }
  const json body = bodyOf(r);
  std::vector<std::string> names;
  for (auto it = body.begin(); it != body.end(); ++it) names.push_back(it.key());
  ctx.Equal(names, {"created_at", "name", "status", "user_id"}, "the fields of another member's read of u-1");
  ctx.Assert(body.value("name", "") == "Ada Lovelace" && body.value("status", "") == "unverified", "the public view must carry the name and the status, got %s", r.Text());
}

void CheckCacheScope(harness::Ctx& ctx) {
  auto c = readApi(ctx);
  const auto own = c.Get("/v1/users/u-1", "X-User-Id", "u-1");
  const auto support = c.Get("/v1/users/u-1", "X-User-Id", "agent-7", "X-Role", "support", "X-Support-Reason", "ticket 4411");
  const auto pub = c.Get("/v1/users/u-1", "X-User-Id", "u-2");
  for (const auto& [who, r] : std::vector<std::pair<std::string, harness::Response>>{{"the owner's read", own}, {"a support read", support}}) {
    const auto d = listOf(r.HeaderValue("Cache-Control"));
    ctx.Assert(!d.count("public") && d.count("no-store"), "%s carries the email and the phone and answered Cache-Control %q: a shared cache keeps it and serves it to the next caller. Use private, no-store", who, r.HeaderValue("Cache-Control"));
  }
  const auto d = listOf(pub.HeaderValue("Cache-Control"));
  ctx.Assert(d.count("public") && d.count("max-age=60"), "the public view answered Cache-Control %q, expected public, max-age=60", pub.HeaderValue("Cache-Control"));
  for (const auto& [who, r] : std::vector<std::pair<std::string, harness::Response>>{{"the owner's read", own}, {"the public view", pub}}) {
    ctx.Assert(listOf(r.HeaderValue("Vary")).count("x-user-id"), "%s answered Vary %q: a cache must key the answer by X-User-Id", who, r.HeaderValue("Vary"));
  }
}

void CheckSupportAudit(harness::Ctx& ctx) {
  auto c = readApi(ctx);
  const auto blind = c.Get("/v1/users/u-1", "X-User-Id", "agent-7", "X-Role", "support");
  ctx.Equal(blind.Status, 400, "a support read without X-Support-Reason");
  ctx.Assert(accounts::auditEntries().empty(), "a refused support read must leave no audit entry");
  const auto r = c.Get("/v1/users/u-1", "X-User-Id", "agent-7", "X-Role", "support", "X-Support-Reason", "ticket 4411");
  ctx.Assert(r.Status == 200 && bodyOf(r).value("email", "") == "ada@example.com", "a support read with a reason must answer the whole account, got %d %s", r.Status, r.Text());
  const auto entries = accounts::auditEntries();
  ctx.Assert(entries.size() == 1 && entries[0].value("actor", "") == "agent-7" && entries[0].value("user_id", "") == "u-1" && entries[0].value("reason", "") == "ticket 4411",
             "after one support read the audit trail holds %d entries, expected agent-7 reading u-1 for ticket 4411", entries.size());
  ctx.Equal(c.Get("/v1/users/u-1", "X-User-Id", "u-2").Status, 200, "a member's read");
}
`,
  },
  hints: [
    "Read another member's profile: the phone number is there. Read your own twice through a CDN: the second caller gets it. Ask as support: the record arrives, and nothing says who looked.",
    'The public view is the account minus one field, so every other field leaks. One `Cache-Control: public` header covers every answer, contact data included. The support branch is the owner branch.',
    'Build the public view from `PUBLIC_FIELDS`; send `private, no-store` with contact data, `public, max-age=60` without, `Vary: X-User-Id` always; give support its own branch: 400 without a reason, `record_audit` before returning.',
  ],
  debrief: `Disclosure is decided per caller, so the read has three answers rather than one with fields removed. The public view is an allowlist because a projection by subtraction grows a leak the day someone adds a column. Cache headers are part of that decision: \`public\` hands the answer to every cache between the service and the user, so only the view without contact data may carry it, and \`Vary: X-User-Id\` keeps a cache from serving one caller's answer to another. The audit record is written before the account leaves, so a support read that happened always has a trace. Production services also rate-limit support lookups, require a ticket that names the account, and let the user see who read their record.`,
};
