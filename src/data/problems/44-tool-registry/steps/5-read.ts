import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: "GET /v1/tools/{name}: resolution against the caller's pin and allowlist",
  concept: 'http',
  guides: ['honest-reads', 'request-boundaries'],
  file: 'read',
  focus: ['client', 'registry', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/tools/{name}\`, the resolve call an agent makes
before it uses a tool: it answers 401 without \`X-Tenant-Id\`, resolves the name in the active catalog
with \`catalog.resolve(name)\` (step 2, provided as \`toolsd.catalog\`), answers 404 when the tool is
missing, and returns the catalog entry as stored. It serves the demo and hides three flaws.

**Failure mode the checks target.** An agent that pinned a catalog for its run is switched to the
newest definitions mid-plan; any tenant resolves any tool, including irreversible ones it was never
granted; and every caller receives the owner team's internal endpoint and credential reference.

- The run's pin comes from \`X-Run-Id\`: \`catalog.resolve(name, run_id)\`.
- The allowlist is the authenticated tenant's, \`store.allowlist(tenant)\`. A tool outside it is
  **404** with the same body as a missing tool; a 403 would tell a caller which tools exist.
- The response is \`PUBLIC_FIELDS\` only: \`name\`, \`version\` (the version served), \`side_effect\`
  and \`schema\`.`,
  sequence: {
    participants: ['Agent run', 'toolsd', 'Redis'],
    messages: [
      {from: 'Agent run', to: 'toolsd', label: 'GET /v1/tools/payments.refund · X-Tenant-Id · X-Run-Id', kind: 'sync'},
      {from: 'toolsd', to: 'Redis', label: 'SMEMBERS tenant:acme:tools → not granted: 404', kind: 'sync'},
      {from: 'toolsd', to: 'Redis', label: 'GET catalog:pin:run-1 → 7 · HGET catalog:version:7', kind: 'sync'},
      {from: 'toolsd', to: 'Agent run', label: '200 {name, version, side_effect, schema}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/tools/{name}',
      detail: 'Register the resolve route on `GET /v1/tools/{name}`; a request without `X-Tenant-Id` is 401.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/tools\/\{name\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/tools\/:name['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/tools\/\{name\}"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"tools"\s*\/\s*Segment\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/tools\//]},
      },
    },
    {
      id: 'run-pin',
      title: "Serves the version the caller's run pinned",
      detail:
        '`X-Run-Id` is passed to `catalog.resolve`, so a run keeps the catalog it started on; the starter resolves every request in the active catalog.',
      match: {
        python: {all: [/x-run-id/i], none: [/catalog\.resolve\(\s*name\s*\)/]},
        typescript: {all: [/x-run-id/i], none: [/resolve\(\s*name\s*\)/]},
        go: {all: [/X-Run-Id/i], none: [/catalog\.Resolve\([^\n]*name,\s*""\)/]},
        scala: {all: [/X-Run-Id/i], none: [/Catalog\.resolve\(\s*name\s*\)/]},
        cpp: {all: [/X-Run-Id/i], none: [/catalog::resolve\(\s*name\s*\)/]},
      },
    },
    {
      id: 'allowlist-404',
      title: 'A tool outside the allowlist is a 404',
      detail:
        "The tenant's allowlist (`store.allowlist(tenant)`) is checked before resolving, and a tool outside it answers exactly as a missing one, **404**; the starter skips the allowlist, so any authenticated caller resolves any tool.",
      match: {
        python: {
          all: [/store\.allowlist\(\s*tenant\s*\)/],
          none: [/\b403\b/],
          order: [/store\.allowlist\(/, /catalog\.resolve\(/],
        },
        typescript: {
          all: [/allowlist\(\s*tenant\s*\)/],
          none: [/\b403\b/],
          order: [/allowlist\(\s*tenant/, /\bresolve\(/],
        },
        go: {
          all: [/store\.Allowlist\([^\n]*tenant\)/],
          none: [/StatusForbidden|\b403\b/],
          order: [/store\.Allowlist\(/, /catalog\.Resolve\(/],
        },
        scala: {
          all: [/Store\.allowlist\(\s*tenant/],
          none: [/Forbidden/],
          order: [/Store\.allowlist\(/, /Catalog\.resolve\(/],
        },
        cpp: {
          all: [/store::allowlist\(\s*tenant\s*\)/],
          none: [/\b403\b/],
          order: [/store::allowlist\(/, /catalog::resolve\(/],
        },
      },
    },
    {
      id: 'public-fields',
      title: 'Answers the public contract only',
      detail:
        'The response is built from `PUBLIC_FIELDS` (`name`, `version`, `side_effect`, `schema`); the starter returns the stored entry, so the internal endpoint and credential reference reach every caller.',
      match: {
        python: {all: [/PUBLIC_FIELDS/], none: [/JSONResponse\(\s*entry\s*\)/]},
        typescript: {all: [/PUBLIC_FIELDS/], none: [/send\(\s*entry\s*\)|return entry;/]},
        go: {all: [/publicFields/], none: [/writeJSON\(rw,\s*http\.StatusOK,\s*entry\)/]},
        scala: {all: [/PublicFields/], none: [/entry\.compactPrint/]},
        cpp: {all: [/kPublicFields/], none: [/entry->dump\(\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from toolsd import catalog, store  # catalog.resolve, store.allowlist

app = FastAPI()


@app.get("/v1/tools/{name}")
def resolve_tool(name: str, request: Request) -> JSONResponse:
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    entry = catalog.resolve(name)
    if entry is None:
        raise HTTPException(status_code=404, detail="no such tool")
    return JSONResponse(entry)
`,
      solution: `from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from toolsd import catalog, store  # catalog.resolve, store.allowlist

app = FastAPI()

PUBLIC_FIELDS = ("name", "version", "side_effect", "schema")


@app.get("/v1/tools/{name}")
def resolve_tool(name: str, request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    # Outside the allowlist answers exactly like a missing tool: a 403 would confirm the tool exists.
    if name not in store.allowlist(tenant):
        raise HTTPException(status_code=404, detail="no such tool")
    entry = catalog.resolve(name, request.headers.get("x-run-id"))
    if entry is None:
        raise HTTPException(status_code=404, detail="no such tool")
    return JSONResponse({field: entry[field] for field in PUBLIC_FIELDS})
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {resolve} from 'toolsd/catalog';
import {allowlist} from 'toolsd/store';

export const app = Fastify();

app.get('/v1/tools/:name', async (request, reply) => {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {name} = request.params as {name: string};
  const entry = await resolve(name);
  if (entry === null) return reply.code(404).send({error: 'no such tool'});
  return reply.send(entry);
});
`,
      solution: `import Fastify from 'fastify';

import {resolve} from 'toolsd/catalog';
import {allowlist} from 'toolsd/store';

export const app = Fastify();

export const PUBLIC_FIELDS = ['name', 'version', 'side_effect', 'schema'];

app.get('/v1/tools/:name', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {name} = request.params as {name: string};
  // Outside the allowlist answers exactly like a missing tool: a 403 would confirm the tool exists.
  if (!(await allowlist(tenant)).has(name)) return reply.code(404).send({error: 'no such tool'});
  const runId = request.headers['x-run-id'];
  const entry = await resolve(name, typeof runId === 'string' && runId !== '' ? runId : null);
  if (entry === null) return reply.code(404).send({error: 'no such tool'});
  return reply.send(Object.fromEntries(PUBLIC_FIELDS.map(field => [field, entry[field]])));
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"toolsd/catalog" // catalog.Resolve(ctx, name, runID); toolsd/store has store.Allowlist(ctx, tenant)
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func resolveTool(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	if r.Header.Get("X-Tenant-Id") == "" {
		http.Error(rw, "missing X-Tenant-Id", http.StatusUnauthorized)
		return
	}
	entry, err := catalog.Resolve(r.Context(), r.PathValue("name"), "")
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	if entry == nil {
		http.Error(rw, "no such tool", http.StatusNotFound)
		return
	}
	writeJSON(rw, http.StatusOK, entry)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/tools/{name}", resolveTool)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"

	"toolsd/catalog" // catalog.Resolve(ctx, name, runID)
	"toolsd/store"   // store.Allowlist(ctx, tenant)
)

var publicFields = []string{"name", "version", "side_effect", "schema"}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func resolveTool(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "missing X-Tenant-Id", http.StatusUnauthorized)
		return
	}
	name := r.PathValue("name")
	allowed, err := store.Allowlist(r.Context(), tenant)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	// Outside the allowlist answers exactly like a missing tool: a 403 would confirm the tool exists.
	if !allowed[name] {
		http.Error(rw, "no such tool", http.StatusNotFound)
		return
	}
	entry, err := catalog.Resolve(r.Context(), name, r.Header.Get("X-Run-Id"))
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	if entry == nil {
		http.Error(rw, "no such tool", http.StatusNotFound)
		return
	}
	public := map[string]any{}
	for _, field := range publicFields {
		public[field] = entry[field]
	}
	writeJSON(rw, http.StatusOK, public)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/tools/{name}", resolveTool)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

import toolsd.{Catalog, Store} // Catalog.resolve(name, runId), Store.allowlist(tenant)

object Read {
  val route: Route =
    path("v1" / "tools" / Segment) { name =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenant =>
          // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
          if (tenant.forall(_.isEmpty)) complete(StatusCodes.Unauthorized -> "missing X-Tenant-Id")
          else
            Catalog.resolve(name) match {
              case None        => complete(StatusCodes.NotFound -> "no such tool")
              case Some(entry) => complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, entry.compactPrint)))
            }
        }
      }
    }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import toolsd.{Catalog, Store} // Catalog.resolve(name, runId), Store.allowlist(tenant)

object Read {
  val PublicFields: Seq[String] = Seq("name", "version", "side_effect", "schema")

  val route: Route =
    path("v1" / "tools" / Segment) { name =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantHeader =>
          optionalHeaderValueByName("X-Run-Id") { runId =>
            tenantHeader.filter(_.nonEmpty) match {
              case None => complete(StatusCodes.Unauthorized -> "missing X-Tenant-Id")
              // Outside the allowlist answers exactly like a missing tool: a 403 would confirm the tool exists.
              case Some(tenant) if !Store.allowlist(tenant).contains(name) => complete(StatusCodes.NotFound -> "no such tool")
              case Some(_) =>
                Catalog.resolve(name, runId.filter(_.nonEmpty)) match {
                  case None => complete(StatusCodes.NotFound -> "no such tool")
                  case Some(entry) =>
                    val public = JsObject(PublicFields.flatMap(field => entry.fields.get(field).map(field -> _)).toMap)
                    complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, public.compactPrint)))
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

#include <string>

#include "toolsd/catalog.h"  // catalog::resolve(name, run_id)
#include "toolsd/store.h"    // store::allowlist(tenant)

using json = nlohmann::json;

void resolve_tool(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  if (req.get_header_value("X-Tenant-Id").empty()) {
    res.status = 401;
    res.set_content(R"({"error": "missing X-Tenant-Id"})", "application/json");
    return;
  }
  const auto entry = catalog::resolve(req.matches[1]);
  if (!entry) {
    res.status = 404;
    res.set_content(R"({"error": "no such tool"})", "application/json");
    return;
  }
  res.set_content(entry->dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/tools/([\\w.-]+))", resolve_tool); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "toolsd/catalog.h"  // catalog::resolve(name, run_id)
#include "toolsd/store.h"    // store::allowlist(tenant)

using json = nlohmann::json;

const std::vector<std::string> kPublicFields = {"name", "version", "side_effect", "schema"};

void not_found(httplib::Response& res) {
  res.status = 404;
  res.set_content(R"({"error": "no such tool"})", "application/json");
}

void resolve_tool(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content(R"({"error": "missing X-Tenant-Id"})", "application/json");
    return;
  }
  const std::string name = req.matches[1];
  // Outside the allowlist answers exactly like a missing tool: a 403 would confirm the tool exists.
  if (!store::allowlist(tenant).count(name)) return not_found(res);
  const auto entry = catalog::resolve(name, req.get_header_value("X-Run-Id"));
  if (!entry) return not_found(res);
  json response = json::object();
  for (const std::string& field : kPublicFields) {
    if (entry->contains(field)) response[field] = (*entry)[field];
  }
  res.set_content(response.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/tools/([\\w.-]+))", resolve_tool); }
`,
    },
  },
  harness: {
    python: `from toolsd import catalog, store

ACME = {"X-Tenant-Id": "acme"}
FIELDS = {"name", "version", "side_effect", "schema"}


def _entry(name, version, side_effect, owner):
    return {"name": name, "version": version, "side_effect": side_effect, "owner": owner, "schema": {"type": "object", "properties": {"q": {"type": "string"}}}, "endpoint": f"https://{owner}.internal/{name}", "credential_ref": f"vault://{owner}/{name}"}


def _api(ctx):
    """Catalog 7, then 9 active; run-1 pinned 7; acme may resolve search and payments.refund, not payments.void."""
    v7 = {"search": _entry("search", "a1", "read", "search"), "payments.refund": _entry("payments.refund", "b1", "irreversible", "payments"), "payments.void": _entry("payments.void", "d1", "write", "payments")}
    v9 = {"search": _entry("search", "a2", "read", "search"), "payments.refund": _entry("payments.refund", "b2", "irreversible", "payments"), "payments.void": _entry("payments.void", "d2", "write", "payments")}
    for cv in ("7", "9"):
        catalog.record_validation(cv, "passed", "")
    catalog.promote("7", v7)
    catalog.pin_run("run-1", "7")
    catalog.promote("9", v9)
    store.grant("acme", "search", "payments.refund")
    return ctx.client(ctx.load("read").app)


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await c.get("/v1/tools/search", headers=ACME)
        assert r.status_code == 200, f"GET /v1/tools/search answered {r.status_code}: {r.text}"
        body = r.json()
        assert body.get("name") == "search" and body.get("version") == "a2", f"the active catalog serves search a2, the response is {body}"
        r = await c.get("/v1/tools/search")
    assert r.status_code == 401, f"a resolve without X-Tenant-Id answered {r.status_code}, expected 401"


async def check_run_pin(ctx):
    async with _api(ctx) as c:
        pinned = await c.get("/v1/tools/payments.refund", headers={**ACME, "X-Run-Id": "run-1"})
        assert pinned.status_code == 200, f"a pinned resolve answered {pinned.status_code}: {pinned.text}"
        assert pinned.json().get("version") == "b1", f"run-1 pinned catalog 7 and was served payments.refund {pinned.json().get('version')}: a promotion switched a running agent to new definitions mid-plan"
        active = await c.get("/v1/tools/payments.refund", headers=ACME)
        assert active.json().get("version") == "b2", f"without a run the active catalog serves b2, got {active.json()}"
        unpinned = await c.get("/v1/tools/payments.refund", headers={**ACME, "X-Run-Id": "run-2"})
    assert unpinned.json().get("version") == "b2", f"a run that pinned nothing is served the active b2, got {unpinned.json()}"


async def check_allowlist_404(ctx):
    async with _api(ctx) as c:
        denied = await c.get("/v1/tools/payments.void", headers=ACME)
        missing = await c.get("/v1/tools/payments.nothing", headers=ACME)
        assert missing.status_code == 404, f"a missing tool answered {missing.status_code}, expected 404"
        assert denied.status_code == 404, f"payments.void, which acme was never granted, answered {denied.status_code}: a tool outside the allowlist is 404"
        assert denied.text == missing.text, f"a tool outside the allowlist answered {denied.text!r}, a missing tool {missing.text!r}: the two must be indistinguishable"
        other = await c.get("/v1/tools/payments.refund", headers={"X-Tenant-Id": "globex"})
    assert other.status_code == 404, f"globex, granted nothing, resolved payments.refund with {other.status_code}: the allowlist is the caller's tenant's"


async def check_public_fields(ctx):
    async with _api(ctx) as c:
        r = await c.get("/v1/tools/payments.refund", headers=ACME)
    assert r.status_code == 200, f"GET /v1/tools/payments.refund answered {r.status_code}: {r.text}"
    body = r.json()
    assert set(body) == FIELDS, f"the response carries {sorted(body)}, expected exactly {sorted(FIELDS)}"
    assert "vault://" not in r.text and ".internal" not in r.text, f"the response leaks the owner's endpoint or credential reference: {r.text}"
    assert body["schema"] == {"type": "object", "properties": {"q": {"type": "string"}}}, f"the schema served is {body['schema']}"
`,
    typescript: `const ACME = {'X-Tenant-Id': 'acme'};
const FIELDS = ['name', 'schema', 'side_effect', 'version'];

function entry(name: string, version: string, sideEffect: string, owner: string) {
  return {name, version, side_effect: sideEffect, owner, schema: {type: 'object', properties: {q: {type: 'string'}}}, endpoint: \`https://\${owner}.internal/\${name}\`, credential_ref: \`vault://\${owner}/\${name}\`};
}

/** Catalog 7, then 9 active; run-1 pinned 7; acme may resolve search and payments.refund, not payments.void. */
async function api(ctx) {
  const catalog = ctx.load('/support/toolsd/catalog.ts');
  const store = ctx.load('/support/toolsd/store.ts');
  const v7 = {search: entry('search', 'a1', 'read', 'search'), 'payments.refund': entry('payments.refund', 'b1', 'irreversible', 'payments'), 'payments.void': entry('payments.void', 'd1', 'write', 'payments')};
  const v9 = {search: entry('search', 'a2', 'read', 'search'), 'payments.refund': entry('payments.refund', 'b2', 'irreversible', 'payments'), 'payments.void': entry('payments.void', 'd2', 'write', 'payments')};
  for (const cv of ['7', '9']) await catalog.recordValidation(cv, 'passed', '');
  await catalog.promote('7', v7);
  await catalog.pinRun('run-1', '7');
  await catalog.promote('9', v9);
  await store.grant('acme', 'search', 'payments.refund');
  return ctx.client(ctx.load('read').app);
}

export async function check_route(ctx) {
  const c = await api(ctx);
  let r = await c.get('/v1/tools/search', {headers: ACME});
  assert.equal(r.status, 200, \`GET /v1/tools/search answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.name === 'search' && body.version === 'a2', \`the active catalog serves search a2, the response is \${r.text}\`);
  r = await c.get('/v1/tools/search');
  assert.equal(r.status, 401, \`a resolve without X-Tenant-Id answered \${r.status}, expected 401\`);
}

export async function check_run_pin(ctx) {
  const c = await api(ctx);
  const pinned = await c.get('/v1/tools/payments.refund', {headers: {...ACME, 'X-Run-Id': 'run-1'}});
  assert.equal(pinned.status, 200, \`a pinned resolve answered \${pinned.status}: \${pinned.text}\`);
  assert.equal(pinned.json().version, 'b1', \`run-1 pinned catalog 7 and was served payments.refund \${pinned.json().version}: a promotion switched a running agent to new definitions mid-plan\`);
  const active = await c.get('/v1/tools/payments.refund', {headers: ACME});
  assert.equal(active.json().version, 'b2', \`without a run the active catalog serves b2, got \${active.text}\`);
  const unpinned = await c.get('/v1/tools/payments.refund', {headers: {...ACME, 'X-Run-Id': 'run-2'}});
  assert.equal(unpinned.json().version, 'b2', \`a run that pinned nothing is served the active b2, got \${unpinned.text}\`);
}

export async function check_allowlist_404(ctx) {
  const c = await api(ctx);
  const denied = await c.get('/v1/tools/payments.void', {headers: ACME});
  const missing = await c.get('/v1/tools/payments.nothing', {headers: ACME});
  assert.equal(missing.status, 404, \`a missing tool answered \${missing.status}, expected 404\`);
  assert.equal(denied.status, 404, \`payments.void, which acme was never granted, answered \${denied.status}: a tool outside the allowlist is 404\`);
  assert.equal(denied.text, missing.text, \`a tool outside the allowlist answered \${denied.text}, a missing tool \${missing.text}: the two must be indistinguishable\`);
  const other = await c.get('/v1/tools/payments.refund', {headers: {'X-Tenant-Id': 'globex'}});
  assert.equal(other.status, 404, \`globex, granted nothing, resolved payments.refund with \${other.status}: the allowlist is the caller's tenant's\`);
}

export async function check_public_fields(ctx) {
  const c = await api(ctx);
  const r = await c.get('/v1/tools/payments.refund', {headers: ACME});
  assert.equal(r.status, 200, \`GET /v1/tools/payments.refund answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert.deepStrictEqual(Object.keys(body).sort(), FIELDS, \`the response carries \${JSON.stringify(Object.keys(body).sort())}, expected exactly \${JSON.stringify(FIELDS)}\`);
  assert(!r.text.includes('vault://') && !r.text.includes('.internal'), \`the response leaks the owner's endpoint or credential reference: \${r.text}\`);
  assert.deepStrictEqual(body.schema, {type: 'object', properties: {q: {type: 'string'}}}, \`the schema served is \${JSON.stringify(body.schema)}\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"sort"
	"strings"

	"toolsd/catalog"
	"toolsd/store"

	"leetbuild/harness"
)

var readBg = context.Background()

func entry(name, version, sideEffect, owner string) catalog.Entry {
	return catalog.Entry{"name": name, "version": version, "side_effect": sideEffect, "owner": owner, "schema": map[string]any{"type": "object", "properties": map[string]any{"q": map[string]any{"type": "string"}}}, "endpoint": "https://" + owner + ".internal/" + name, "credential_ref": "vault://" + owner + "/" + name}
}

// api: catalog 7, then 9 active; run-1 pinned 7; acme may resolve search and payments.refund, not payments.void.
func api(ctx *harness.Ctx) *harness.HTTP {
	v7 := map[string]catalog.Entry{"search": entry("search", "a1", "read", "search"), "payments.refund": entry("payments.refund", "b1", "irreversible", "payments"), "payments.void": entry("payments.void", "d1", "write", "payments")}
	v9 := map[string]catalog.Entry{"search": entry("search", "a2", "read", "search"), "payments.refund": entry("payments.refund", "b2", "irreversible", "payments"), "payments.void": entry("payments.void", "d2", "write", "payments")}
	for _, cv := range []string{"7", "9"} {
		ctx.NoError(catalog.RecordValidation(readBg, cv, "passed", ""), "seeding failed")
	}
	ctx.NoError(catalog.Promote(readBg, "7", v7), "seeding failed")
	ctx.NoError(catalog.PinRun(readBg, "run-1", "7"), "seeding failed")
	ctx.NoError(catalog.Promote(readBg, "9", v9), "seeding failed")
	ctx.NoError(store.Grant(readBg, "acme", "search", "payments.refund"), "seeding failed")
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func served(r *harness.Response) map[string]any {
	var body map[string]any
	r.Decode(&body)
	return body
}

func CheckRoute(ctx *harness.Ctx) {
	c := api(ctx)
	r := c.Get("/v1/tools/search", "X-Tenant-Id", "acme")
	ctx.Equal(r.Status, 200, "GET /v1/tools/search (%s)", r.Text())
	body := served(r)
	ctx.Assert(body["name"] == "search" && body["version"] == "a2", "the active catalog serves search a2, the response is %s", r.Text())
	ctx.Equal(c.Get("/v1/tools/search").Status, 401, "a resolve without X-Tenant-Id")
}

func CheckRunPin(ctx *harness.Ctx) {
	c := api(ctx)
	pinned := c.Get("/v1/tools/payments.refund", "X-Tenant-Id", "acme", "X-Run-Id", "run-1")
	ctx.Equal(pinned.Status, 200, "a pinned resolve (%s)", pinned.Text())
	ctx.Equal(served(pinned)["version"], "b1", "run-1 pinned catalog 7: a promotion must not switch a running agent to new definitions mid-plan; the payments.refund version served")
	ctx.Equal(served(c.Get("/v1/tools/payments.refund", "X-Tenant-Id", "acme"))["version"], "b2", "without a run, the version the active catalog serves")
	ctx.Equal(served(c.Get("/v1/tools/payments.refund", "X-Tenant-Id", "acme", "X-Run-Id", "run-2"))["version"], "b2", "a run that pinned nothing is served the active catalog; the version")
}

func CheckAllowlist404(ctx *harness.Ctx) {
	c := api(ctx)
	denied := c.Get("/v1/tools/payments.void", "X-Tenant-Id", "acme")
	missing := c.Get("/v1/tools/payments.nothing", "X-Tenant-Id", "acme")
	ctx.Equal(missing.Status, 404, "a missing tool")
	ctx.Equal(denied.Status, 404, "payments.void, which acme was never granted: a tool outside the allowlist is 404")
	ctx.Equal(denied.Text(), missing.Text(), "a tool outside the allowlist and a missing tool must be indistinguishable; the body")
	ctx.Equal(c.Get("/v1/tools/payments.refund", "X-Tenant-Id", "globex").Status, 404, "globex, granted nothing, resolving payments.refund (the allowlist is the caller's tenant's)")
}

func CheckPublicFields(ctx *harness.Ctx) {
	c := api(ctx)
	r := c.Get("/v1/tools/payments.refund", "X-Tenant-Id", "acme")
	ctx.Equal(r.Status, 200, "GET /v1/tools/payments.refund (%s)", r.Text())
	body := served(r)
	fields := make([]string, 0, len(body))
	for k := range body {
		fields = append(fields, k)
	}
	sort.Strings(fields)
	ctx.Equal(fields, []string{"name", "schema", "side_effect", "version"}, "the response's fields")
	ctx.Assert(!strings.Contains(r.Text(), "vault://") && !strings.Contains(r.Text(), ".internal"), "the response leaks the owner's endpoint or credential reference: %s", r.Text())
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

using json = nlohmann::json;

namespace {

json entry(const std::string& name, const std::string& version, const std::string& side_effect, const std::string& owner) {
  return json{{"name", name},
              {"version", version},
              {"side_effect", side_effect},
              {"owner", owner},
              {"schema", {{"type", "object"}, {"properties", {{"q", {{"type", "string"}}}}}}},
              {"endpoint", "https://" + owner + ".internal/" + name},
              {"credential_ref", "vault://" + owner + "/" + name}};
}

// Catalog 7, then 9 active; run-1 pinned 7; acme may resolve search and payments.refund, not payments.void.
harness::HTTP api(harness::Ctx& ctx) {
  const json v7 = {{"search", entry("search", "a1", "read", "search")},
                   {"payments.refund", entry("payments.refund", "b1", "irreversible", "payments")},
                   {"payments.void", entry("payments.void", "d1", "write", "payments")}};
  const json v9 = {{"search", entry("search", "a2", "read", "search")},
                   {"payments.refund", entry("payments.refund", "b2", "irreversible", "payments")},
                   {"payments.void", entry("payments.void", "d2", "write", "payments")}};
  catalog::recordValidation("7", "passed", "");
  catalog::recordValidation("9", "passed", "");
  catalog::promote("7", v7);
  catalog::pinRun("run-1", "7");
  catalog::promote("9", v9);
  store::grant("acme", {"search", "payments.refund"});
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

std::string versionIn(const harness::Response& r) {
  const json body = json::parse(r.Text(), nullptr, false);
  return body.is_object() ? body.value("version", "") : "";
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = c.Get("/v1/tools/search", "X-Tenant-Id", "acme");
  ctx.Equal(r.Status, 200, "GET /v1/tools/search (%s)", r.Text());
  ctx.Assert(r.Text().find("\\"search\\"") != std::string::npos && versionIn(r) == "a2", "the active catalog serves search a2, the response is %s", r.Text());
  ctx.Equal(c.Get("/v1/tools/search").Status, 401, "a resolve without X-Tenant-Id");
}

void CheckRunPin(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto pinned = c.Get("/v1/tools/payments.refund", "X-Tenant-Id", "acme", "X-Run-Id", "run-1");
  ctx.Equal(pinned.Status, 200, "a pinned resolve (%s)", pinned.Text());
  ctx.Equal(versionIn(pinned), "b1", "run-1 pinned catalog 7: a promotion must not switch a running agent to new definitions mid-plan; the payments.refund version served");
  ctx.Equal(versionIn(c.Get("/v1/tools/payments.refund", "X-Tenant-Id", "acme")), "b2", "without a run, the version the active catalog serves");
  ctx.Equal(versionIn(c.Get("/v1/tools/payments.refund", "X-Tenant-Id", "acme", "X-Run-Id", "run-2")), "b2", "a run that pinned nothing is served the active catalog; the version");
}

void CheckAllowlist404(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto denied = c.Get("/v1/tools/payments.void", "X-Tenant-Id", "acme");
  const auto missing = c.Get("/v1/tools/payments.nothing", "X-Tenant-Id", "acme");
  ctx.Equal(missing.Status, 404, "a missing tool");
  ctx.Equal(denied.Status, 404, "payments.void, which acme was never granted: a tool outside the allowlist is 404");
  ctx.Equal(denied.Text(), missing.Text(), "a tool outside the allowlist and a missing tool must be indistinguishable; the body");
  ctx.Equal(c.Get("/v1/tools/payments.refund", "X-Tenant-Id", "globex").Status, 404, "globex, granted nothing, resolving payments.refund (the allowlist is the caller's tenant's)");
}

void CheckPublicFields(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = c.Get("/v1/tools/payments.refund", "X-Tenant-Id", "acme");
  ctx.Equal(r.Status, 200, "GET /v1/tools/payments.refund (%s)", r.Text());
  const json body = json::parse(r.Text(), nullptr, false);
  std::vector<std::string> fields;
  if (body.is_object()) {
    for (const auto& [k, v] : body.items()) fields.push_back(k);
  }
  ctx.Equal(fields, {"name", "schema", "side_effect", "version"}, "the response's fields");
  ctx.Assert(r.Text().find("vault://") == std::string::npos && r.Text().find(".internal") == std::string::npos, "the response leaks the owner's endpoint or credential reference: %s", r.Text());
}
`,
  },
  hints: [
    "Pin a run to catalog 7, promote 9, and resolve with `X-Run-Id`: the agent gets the new version. Resolve a tool your tenant was never granted: 200, with the owner's endpoint and vault path in the body.",
    'The handler calls `catalog.resolve(name)` without the run id, never reads the allowlist, and returns the stored entry, so whatever the registry keeps internally goes out with it.',
    '404 (same body as a missing tool) unless `name in store.allowlist(tenant)`; `catalog.resolve(name, request.headers.get("x-run-id"))`; answer `{f: entry[f] for f in PUBLIC_FIELDS}`.',
  ],
  debrief: `Resolution is where the registry's guarantees reach the agent, so each of them is applied here: the run's pin keeps the definition the plan was built against, the allowlist decides what this tenant may call, and the response is a projection rather than the stored record. Answering 404 outside the allowlist keeps the endpoint from confirming which tools exist, which matters for names like payments.refund. Building the response from a field list means an internal field added to the registry later stays internal by default. Production registries cache allowlists per tenant with a short TTL, log every resolution with its run id for audit, and sign the response so the agent runtime can check where it came from.`,
};
