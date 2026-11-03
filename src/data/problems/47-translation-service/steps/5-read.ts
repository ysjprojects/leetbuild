import type {Step} from '@/lib/types';

export const glossaryReadStep: Step = {
  id: 'read',
  title: "GET /v1/glossaries/{source}/{target}: one tenant's glossary, by version",
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/glossaries/{source}/{target}\` for the glossary page:
it takes the tenant from \`?tenant=\` (so the support console can open any tenant) or else from
\`X-Tenant-Id\`, resolves the active glossary (\`translate.glossary\`) and answers
\`{"source", "target", "terms"}\` (empty terms when there is none) with
\`Cache-Control: public, max-age=3600\`. The page renders and it hides four flaws.

**Failure mode the checks target.** Tenant B reads tenant A's product names by adding \`?tenant=A\`; a
translator cannot say which glossary version produced a bad translation, or open that version; a
missing glossary looks like an empty one; and a shared cache serves one tenant's terms to the next
caller for an hour.

- The tenant is \`X-Tenant-Id\` only (**401** without it); a \`?tenant=\` naming another tenant is
  **403**.
- The answer carries \`tenant\`, \`source\`, \`target\`, \`version\`, \`term_count\` and \`terms\`;
  \`?version=n\` pins that version.
- A pair or version with no glossary for the tenant is **404**.
- \`Cache-Control: private, no-cache\`: no shared cache keeps it, and a browser revalidates.`,
  sequence: {
    participants: ['Client', 'translationd', 'Redis'],
    messages: [
      {from: 'Client', to: 'translationd', label: 'GET /v1/glossaries/en/fr?version=1 · X-Tenant-Id', kind: 'sync'},
      {from: 'translationd', to: 'translationd', label: 'no header → 401 · ?tenant= another → 403', kind: 'sync'},
      {from: 'translationd', to: 'Redis', label: 'resolve_glossary(tenant, en, fr, 1)', kind: 'sync'},
      {from: 'Redis', to: 'translationd', label: '{version, terms} · none → 404', kind: 'reply'},
      {
        from: 'translationd',
        to: 'Client',
        label: '200 {version, term_count, terms} · private, no-cache',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/glossaries/{source}/{target}',
      detail: "Register `GET /v1/glossaries/{source}/{target}` and answer the caller's terms for that pair.",
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/glossaries\/\{source\}\/\{target\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/glossaries\/:source\/:target['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/glossaries\/\{source\}\/\{target\}"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"glossaries"\s*\/\s*Segment\s*\/\s*Segment\s*\)/]},
        cpp: {all: [/svr\.Get\(\s*R?"\(?\/v1\/glossaries\//]},
      },
    },
    {
      id: 'tenant-scope',
      title: "Reads the caller's own glossary, 403 for another tenant's",
      detail:
        'The tenant comes from `X-Tenant-Id` (401 without it), and a `?tenant=` naming someone else is **403**. The starter lets the query string choose the tenant.',
      match: {
        python: {all: [/\b401\b/, /\b403\b/], none: [/query_params\.get\(\s*["']tenant["']\s*\)\s*or\b/]},
        typescript: {all: [/\b401\b/, /\b403\b/], none: [/\.tenant\s*\?\?/]},
        go: {all: [/StatusUnauthorized|\b401\b/, /StatusForbidden|\b403\b/]},
        scala: {all: [/Unauthorized|\b401\b/, /Forbidden|\b403\b/], none: [/asked\.orElse\(/]},
        cpp: {all: [/\b401\b/, /\b403\b/]},
      },
    },
    {
      id: 'version',
      title: 'Answers the version and term count, and pins ?version=',
      detail:
        'Every answer carries `version` and `term_count`, and `?version=n` is passed to `resolve_glossary`, so a translator can open the exact glossary a translation used. The starter answers bare terms of the active version.',
      match: {
        python: {all: [/term_count/, /resolve_glossary\([^\n]*version/]},
        typescript: {all: [/term_count/, /resolveGlossary\([^\n]*version/]},
        go: {all: [/term_count/, /ResolveGlossary\([^\n]*version/]},
        scala: {all: [/term_count/, /resolveGlossary\([^\n]*version/]},
        cpp: {all: [/term_count/, /resolveGlossary\([^\n]*version/]},
      },
    },
    {
      id: 'not-found',
      title: 'A missing glossary is 404, not an empty one',
      detail:
        'When the tenant has no glossary for the pair, or no such version, the answer is **404**. The starter answers 200 with empty terms, so "no glossary" and "a glossary with no terms yet" look the same.',
      match: {
        python: {all: [/\b404\b/]},
        typescript: {all: [/\b404\b/]},
        go: {all: [/StatusNotFound|\b404\b/]},
        scala: {all: [/NotFound|\b404\b/]},
        cpp: {all: [/\b404\b/]},
      },
    },
    {
      id: 'freshness',
      title: 'Keeps the read out of shared caches',
      detail:
        "The answer is `Cache-Control: private, no-cache`: it depends on `X-Tenant-Id`, so a shared cache keyed by URL would hand one tenant's terms to another, and a corrected term shows on the next read. The starter answers `public, max-age=3600`.",
      match: {
        python: {all: [/private/, /no-cache|max-age=0/], none: [/public/]},
        typescript: {all: [/private/, /no-cache|max-age=0/], none: [/public/]},
        go: {all: [/private/, /no-cache|max-age=0/], none: [/public/]},
        scala: {all: [/private/, /no-cache|max-age=0/], none: [/public/]},
        cpp: {all: [/private/, /no-cache|max-age=0/], none: [/public/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from translate.glossary import resolve_glossary  # resolve_glossary(tenant, source, target, version=None)

app = FastAPI()


@app.get("/v1/glossaries/{source}/{target}")
def read_glossary(source: str, target: str, request: Request) -> JSONResponse:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    tenant = request.query_params.get("tenant") or request.headers.get("x-tenant-id", "")
    pinned = resolve_glossary(tenant, source, target)
    terms = pinned["terms"] if pinned else {}
    return JSONResponse({"source": source, "target": target, "terms": terms}, headers={"Cache-Control": "public, max-age=3600"})
`,
      solution: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from translate.glossary import resolve_glossary  # resolve_glossary(tenant, source, target, version=None)

app = FastAPI()

# The answer depends on X-Tenant-Id: no shared cache may keep it, and a browser revalidates.
CACHE_CONTROL = "private, no-cache"


def error(status: int, message: str) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=status)


@app.get("/v1/glossaries/{source}/{target}")
def read_glossary(source: str, target: str, request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        return error(401, "X-Tenant-Id is required")
    asked = request.query_params.get("tenant")
    if asked is not None and asked != tenant:
        return error(403, "a glossary is readable by its own tenant only")
    version = request.query_params.get("version")
    if version is not None and not version.isdigit():
        return error(400, "version must be a number")
    pinned = resolve_glossary(tenant, source, target, int(version) if version is not None else None)
    if pinned is None:
        return error(404, f"no {source}->{target} glossary" + (f" version {version}" if version else ""))
    body = {
        "tenant": tenant,
        "source": source,
        "target": target,
        "version": pinned["version"],
        "term_count": len(pinned["terms"]),
        "terms": pinned["terms"],
    }
    return JSONResponse(body, headers={"Cache-Control": CACHE_CONTROL})
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {resolveGlossary} from 'translate/glossary'; // resolveGlossary(tenant, source, target, version = null)

export const app = Fastify();

app.get('/v1/glossaries/:source/:target', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const {source, target} = request.params as {source: string; target: string};
  const query = request.query as {tenant?: string};
  const tenant = query.tenant ?? String(request.headers['x-tenant-id'] ?? '');
  const pinned = await resolveGlossary(tenant, source, target);
  return reply.header('Cache-Control', 'public, max-age=3600').send({source, target, terms: pinned?.terms ?? {}});
});
`,
      solution: `import Fastify from 'fastify';

import {resolveGlossary} from 'translate/glossary'; // resolveGlossary(tenant, source, target, version = null)

export const app = Fastify();

// The answer depends on X-Tenant-Id: no shared cache may keep it, and a browser revalidates.
export const CACHE_CONTROL = 'private, no-cache';

app.get('/v1/glossaries/:source/:target', async (request, reply) => {
  const {source, target} = request.params as {source: string; target: string};
  const query = request.query as {tenant?: string; version?: string};
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  if (query.tenant !== undefined && query.tenant !== tenant) return reply.code(403).send({error: 'a glossary is readable by its own tenant only'});
  if (query.version !== undefined && !/^\\d+$/.test(query.version)) return reply.code(400).send({error: 'version must be a number'});
  const version = query.version === undefined ? null : Number(query.version);
  const pinned = await resolveGlossary(tenant, source, target, version);
  if (pinned === null) return reply.code(404).send({error: \`no \${source}->\${target} glossary\`});
  return reply.header('Cache-Control', CACHE_CONTROL).send({
    tenant,
    source,
    target,
    version: pinned.version,
    term_count: Object.keys(pinned.terms).length,
    terms: pinned.terms,
  });
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"translate/glossary" // glossary.ResolveGlossary(ctx, tenant, source, target, version)
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func readGlossary(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	source, target := r.PathValue("source"), r.PathValue("target")
	tenant := r.URL.Query().Get("tenant")
	if tenant == "" {
		tenant = r.Header.Get("X-Tenant-Id")
	}
	pinned, err := glossary.ResolveGlossary(r.Context(), tenant, source, target, 0)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	terms := map[string]string{}
	if pinned != nil {
		terms = pinned.Terms
	}
	rw.Header().Set("Cache-Control", "public, max-age=3600")
	writeJSON(rw, http.StatusOK, map[string]any{"source": source, "target": target, "terms": terms})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/glossaries/{source}/{target}", readGlossary)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"strconv"

	"translate/glossary" // glossary.ResolveGlossary(ctx, tenant, source, target, version)
)

// cacheControl: the answer depends on X-Tenant-Id, so no shared cache may keep it, and a browser revalidates.
const cacheControl = "private, no-cache"

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func readGlossary(rw http.ResponseWriter, r *http.Request) {
	source, target := r.PathValue("source"), r.PathValue("target")
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	if asked := r.URL.Query().Get("tenant"); asked != "" && asked != tenant {
		http.Error(rw, "a glossary is readable by its own tenant only", http.StatusForbidden)
		return
	}
	var version int64
	if raw := r.URL.Query().Get("version"); raw != "" {
		n, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || n < 0 {
			http.Error(rw, "version must be a number", http.StatusBadRequest)
			return
		}
		if n == 0 {
			http.Error(rw, "no glossary version 0", http.StatusNotFound)
			return
		}
		version = n
	}
	pinned, err := glossary.ResolveGlossary(r.Context(), tenant, source, target, version)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	if pinned == nil {
		http.Error(rw, "no "+source+"->"+target+" glossary", http.StatusNotFound)
		return
	}
	rw.Header().Set("Cache-Control", cacheControl)
	writeJSON(rw, http.StatusOK, map[string]any{
		"tenant":     tenant,
		"source":     source,
		"target":     target,
		"version":    pinned.Version,
		"term_count": len(pinned.Terms),
		"terms":      pinned.Terms,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/glossaries/{source}/{target}", readGlossary)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import translate.Glossary // Glossary.resolveGlossary(tenant, source, target, version = None)

object Read {
  def read(source: String, target: String, header: Option[String], asked: Option[String], version: Option[String]): HttpResponse = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val tenant = asked.orElse(header).getOrElse("")
    val terms = Glossary.resolveGlossary(tenant, source, target).map(_.terms).getOrElse(Map.empty)
    val body = JsObject("source" -> JsString(source), "target" -> JsString(target), "terms" -> JsObject(terms.map { case (k, v) => k -> JsString(v) }))
    HttpResponse(StatusCodes.OK, headers = List(RawHeader("Cache-Control", "public, max-age=3600")), entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))
  }

  val route: Route = path("v1" / "glossaries" / Segment / Segment) { (source, target) =>
    get {
      optionalHeaderValueByName("X-Tenant-Id") { header =>
        parameters("tenant".optional, "version".optional) { (asked, version) =>
          complete(read(source, target, header, asked, version))
        }
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import translate.Glossary // Glossary.resolveGlossary(tenant, source, target, version = None)

object Read {
  /** The answer depends on X-Tenant-Id: no shared cache may keep it, and a browser revalidates. */
  val CacheControl = "private, no-cache"

  private def error(status: StatusCode, message: String): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, JsObject("error" -> JsString(message)).compactPrint))

  def read(source: String, target: String, header: Option[String], asked: Option[String], version: Option[String]): HttpResponse =
    header.filter(_.nonEmpty) match {
      case None => error(StatusCodes.Unauthorized, "X-Tenant-Id is required")
      case Some(tenant) if asked.exists(_ != tenant) => error(StatusCodes.Forbidden, "a glossary is readable by its own tenant only")
      case Some(_) if version.exists(v => v.isEmpty || !v.forall(_.isDigit)) => error(StatusCodes.BadRequest, "version must be a number")
      case Some(tenant) =>
        Glossary.resolveGlossary(tenant, source, target, version.map(_.toLong)) match {
          case None => error(StatusCodes.NotFound, s"no $source->$target glossary")
          case Some(pinned) =>
            val body = JsObject(
              "tenant" -> JsString(tenant),
              "source" -> JsString(source),
              "target" -> JsString(target),
              "version" -> JsNumber(pinned.version),
              "term_count" -> JsNumber(pinned.terms.size),
              "terms" -> JsObject(pinned.terms.map { case (k, v) => k -> JsString(v) }),
            )
            HttpResponse(StatusCodes.OK, headers = List(RawHeader("Cache-Control", CacheControl)), entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))
        }
    }

  val route: Route = path("v1" / "glossaries" / Segment / Segment) { (source, target) =>
    get {
      optionalHeaderValueByName("X-Tenant-Id") { header =>
        parameters("tenant".optional, "version".optional) { (asked, version) =>
          complete(read(source, target, header, asked, version))
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

#include "translate/glossary.h"  // glossary::resolveGlossary(tenant, source, target, version = 0)

using json = nlohmann::json;

void read_glossary(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string source = req.matches[1], target = req.matches[2];
  const std::string tenant = req.has_param("tenant") ? req.get_param_value("tenant") : req.get_header_value("X-Tenant-Id");
  const auto pinned = glossary::resolveGlossary(tenant, source, target);
  const json terms = pinned ? json(pinned->terms) : json::object();
  res.set_header("Cache-Control", "public, max-age=3600");
  res.set_content(json{{"source", source}, {"target", target}, {"terms", terms}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Get(R"(/v1/glossaries/([a-z]+)/([a-z]+))", read_glossary);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

#include "translate/glossary.h"  // glossary::resolveGlossary(tenant, source, target, version = 0)

using json = nlohmann::json;

// The answer depends on X-Tenant-Id: no shared cache may keep it, and a browser revalidates.
const std::string kCacheControl = "private, no-cache";

void fail(httplib::Response& res, int status, const std::string& message) {
  res.status = status;
  res.set_content(json{{"error", message}}.dump(), "application/json");
}

void read_glossary(const httplib::Request& req, httplib::Response& res) {
  const std::string source = req.matches[1], target = req.matches[2];
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return fail(res, 401, "X-Tenant-Id is required");
  if (req.has_param("tenant") && req.get_param_value("tenant") != tenant) return fail(res, 403, "a glossary is readable by its own tenant only");
  long version = 0;
  if (req.has_param("version")) {
    const std::string raw = req.get_param_value("version");
    if (raw.empty() || raw.find_first_not_of("0123456789") != std::string::npos) return fail(res, 400, "version must be a number");
    version = std::stol(raw);
    if (version == 0) return fail(res, 404, "no glossary version 0");
  }
  const auto pinned = glossary::resolveGlossary(tenant, source, target, version);
  if (!pinned) return fail(res, 404, "no " + source + "->" + target + " glossary");
  res.set_header("Cache-Control", kCacheControl);
  const json body = {{"tenant", tenant},  {"source", source},
                     {"target", target},  {"version", pinned->version},
                     {"term_count", pinned->terms.size()}, {"terms", pinned->terms}};
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Get(R"(/v1/glossaries/([a-z]+)/([a-z]+))", read_glossary);
}
`,
    },
  },
  harness: {
    python: `from translate.glossary import publish_terms

ACME = {"X-Tenant-Id": "acme"}
V1 = {"Dashboard": "Tableau de bord", "Invoice": "Facture"}
V2 = {"Dashboard": "Panneau", "Invoice": "Facture"}


def _read(ctx):
    publish_terms("acme", "en", "fr", V1)
    return ctx.client(ctx.load("read").app)


def _directives(r):
    return {d.strip() for d in r.headers.get("cache-control", "").split(",") if d.strip()}


async def check_route(ctx):
    async with _read(ctx) as c:
        r = await c.get("/v1/glossaries/en/fr", headers=ACME)
    assert r.status_code == 200, f"GET /v1/glossaries/en/fr answered {r.status_code}: {r.text}"
    assert r.json().get("terms") == V1, f"acme's en->fr glossary answered {r.json()}"


async def check_tenant_scope(ctx):
    async with _read(ctx) as c:
        other = await c.get("/v1/glossaries/en/fr", headers={"X-Tenant-Id": "globex"}, params={"tenant": "acme"})
        assert "Tableau de bord" not in other.text, f"globex read acme's glossary with ?tenant=acme: {other.status_code} {other.text}"
        assert other.status_code == 403, f"globex asking for ?tenant=acme answered {other.status_code}, expected 403"
        anonymous = await c.get("/v1/glossaries/en/fr", params={"tenant": "acme"})
        assert anonymous.status_code == 401, f"a read without X-Tenant-Id answered {anonymous.status_code}: {anonymous.text}, expected 401"
        own = await c.get("/v1/glossaries/en/fr", headers=ACME, params={"tenant": "acme"})
    assert own.status_code == 200 and own.json().get("terms") == V1, f"acme naming itself in ?tenant= answered {own.status_code} {own.text}"


async def check_version(ctx):
    async with _read(ctx) as c:
        publish_terms("acme", "en", "fr", {"Dashboard": "Panneau"})
        active = await c.get("/v1/glossaries/en/fr", headers=ACME)
        body = active.json()
        assert body.get("version") == 2 and body.get("term_count") == 2 and body.get("terms") == V2, f"the active glossary answered {body}: it must name its version (2) and term_count (2) beside the terms"
        pinned = await c.get("/v1/glossaries/en/fr", headers=ACME, params={"version": "1"})
    body = pinned.json()
    assert pinned.status_code == 200 and body.get("version") == 1 and body.get("terms") == V1, f"?version=1 answered {pinned.status_code} {body}: a translator must be able to open the version a translation used"


async def check_not_found(ctx):
    async with _read(ctx) as c:
        pair = await c.get("/v1/glossaries/en/de", headers=ACME)
        assert pair.status_code == 404, f"acme has no en->de glossary and the read answered {pair.status_code} {pair.text}, expected 404"
        tenant = await c.get("/v1/glossaries/en/fr", headers={"X-Tenant-Id": "globex"})
        assert tenant.status_code == 404, f"globex has no en->fr glossary and the read answered {tenant.status_code} {tenant.text}, expected 404"
        version = await c.get("/v1/glossaries/en/fr", headers=ACME, params={"version": "9"})
    assert version.status_code == 404, f"version 9 does not exist and the read answered {version.status_code} {version.text}, expected 404"


async def check_freshness(ctx):
    async with _read(ctx) as c:
        r = await c.get("/v1/glossaries/en/fr", headers=ACME)
        d = _directives(r)
        assert "public" not in d, f"the read answered Cache-Control {r.headers.get('cache-control')!r}: public lets a shared cache hand acme's terms to the next caller of the URL"
        assert "private" in d and ("no-cache" in d or "max-age=0" in d), f"the read answered Cache-Control {r.headers.get('cache-control')!r}, expected private, no-cache"
        publish_terms("acme", "en", "fr", {"Dashboard": "Panneau"})
        again = await c.get("/v1/glossaries/en/fr", headers=ACME)
    assert again.json().get("terms", {}).get("Dashboard") == "Panneau", f"after a correction the read answered {again.json()}"
`,
    typescript: `const ACME = {'X-Tenant-Id': 'acme'};
const V1 = {Dashboard: 'Tableau de bord', Invoice: 'Facture'};
const V2 = {Dashboard: 'Panneau', Invoice: 'Facture'};

async function read(ctx) {
  const glossary = ctx.load('/support/translate/glossary.ts');
  await glossary.publishTerms('acme', 'en', 'fr', V1);
  return {c: ctx.client(ctx.load('read').app), glossary};
}

const directives = r => new Set((r.headers['cache-control'] ?? '').split(',').map(d => d.trim()).filter(d => d !== ''));

export async function check_route(ctx) {
  const {c} = await read(ctx);
  const r = await c.get('/v1/glossaries/en/fr', {headers: ACME});
  assert.equal(r.status, 200, \`GET /v1/glossaries/en/fr answered \${r.status}: \${r.text}\`);
  assert.deepStrictEqual(r.json().terms, V1, \`acme's en->fr glossary answered \${r.text}\`);
}

export async function check_tenant_scope(ctx) {
  const {c} = await read(ctx);
  const other = await c.get('/v1/glossaries/en/fr', {headers: {'X-Tenant-Id': 'globex'}, query: {tenant: 'acme'}});
  assert(!other.text.includes('Tableau de bord'), \`globex read acme's glossary with ?tenant=acme: \${other.status} \${other.text}\`);
  assert.equal(other.status, 403, \`globex asking for ?tenant=acme answered \${other.status}, expected 403\`);
  const anonymous = await c.get('/v1/glossaries/en/fr', {query: {tenant: 'acme'}});
  assert.equal(anonymous.status, 401, \`a read without X-Tenant-Id answered \${anonymous.status}: \${anonymous.text}, expected 401\`);
  const own = await c.get('/v1/glossaries/en/fr', {headers: ACME, query: {tenant: 'acme'}});
  assert(own.status === 200 && JSON.stringify(own.json().terms) === JSON.stringify(V1), \`acme naming itself in ?tenant= answered \${own.status} \${own.text}\`);
}

export async function check_version(ctx) {
  const {c, glossary} = await read(ctx);
  await glossary.publishTerms('acme', 'en', 'fr', {Dashboard: 'Panneau'});
  const active = (await c.get('/v1/glossaries/en/fr', {headers: ACME})).json();
  assert(active.version === 2 && active.term_count === 2 && JSON.stringify(active.terms) === JSON.stringify(V2), \`the active glossary answered \${JSON.stringify(active)}: it must name its version (2) and term_count (2) beside the terms\`);
  const pinned = await c.get('/v1/glossaries/en/fr', {headers: ACME, query: {version: '1'}});
  const body = pinned.json();
  assert(pinned.status === 200 && body.version === 1 && JSON.stringify(body.terms) === JSON.stringify(V1), \`?version=1 answered \${pinned.status} \${pinned.text}: a translator must be able to open the version a translation used\`);
}

export async function check_not_found(ctx) {
  const {c} = await read(ctx);
  const pair = await c.get('/v1/glossaries/en/de', {headers: ACME});
  assert.equal(pair.status, 404, \`acme has no en->de glossary and the read answered \${pair.status} \${pair.text}, expected 404\`);
  const tenant = await c.get('/v1/glossaries/en/fr', {headers: {'X-Tenant-Id': 'globex'}});
  assert.equal(tenant.status, 404, \`globex has no en->fr glossary and the read answered \${tenant.status} \${tenant.text}, expected 404\`);
  const version = await c.get('/v1/glossaries/en/fr', {headers: ACME, query: {version: '9'}});
  assert.equal(version.status, 404, \`version 9 does not exist and the read answered \${version.status} \${version.text}, expected 404\`);
}

export async function check_freshness(ctx) {
  const {c, glossary} = await read(ctx);
  const r = await c.get('/v1/glossaries/en/fr', {headers: ACME});
  const d = directives(r);
  assert(!d.has('public'), \`the read answered Cache-Control \${JSON.stringify(r.headers['cache-control'])}: public lets a shared cache hand acme's terms to the next caller of the URL\`);
  assert(d.has('private') && (d.has('no-cache') || d.has('max-age=0')), \`the read answered Cache-Control \${JSON.stringify(r.headers['cache-control'])}, expected private, no-cache\`);
  await glossary.publishTerms('acme', 'en', 'fr', {Dashboard: 'Panneau'});
  const again = await c.get('/v1/glossaries/en/fr', {headers: ACME});
  assert.equal(again.json().terms?.Dashboard, 'Panneau', \`after a correction the read answered \${again.text}\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"strings"

	"translate/glossary"

	"leetbuild/harness"
)

var readBg = context.Background()

func readApi(ctx *harness.Ctx) *harness.HTTP {
	_, err := glossary.PublishTerms(readBg, "acme", "en", "fr", map[string]string{"Dashboard": "Tableau de bord", "Invoice": "Facture"})
	ctx.NoError(err, "seeding acme's glossary")
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func bodyOf(ctx *harness.Ctx, r *harness.Response) map[string]any {
	body, ok := r.JSON().(map[string]any)
	ctx.Assert(ok, "the answer is not a JSON object: %d %s", r.Status, r.Text())
	return body
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

var v1Terms = map[string]any{"Dashboard": "Tableau de bord", "Invoice": "Facture"}

func CheckRoute(ctx *harness.Ctx) {
	c := readApi(ctx)
	r := c.Get("/v1/glossaries/en/fr", "X-Tenant-Id", "acme")
	ctx.Equal(r.Status, 200, "GET /v1/glossaries/en/fr (%s)", r.Text())
	ctx.Equal(bodyOf(ctx, r)["terms"], v1Terms, "acme's en->fr terms")
}

func CheckTenantScope(ctx *harness.Ctx) {
	c := readApi(ctx)
	other := c.Get("/v1/glossaries/en/fr?tenant=acme", "X-Tenant-Id", "globex")
	ctx.Assert(!strings.Contains(other.Text(), "Tableau de bord"), "globex read acme's glossary with ?tenant=acme: %d %s", other.Status, other.Text())
	ctx.Equal(other.Status, 403, "globex asking for ?tenant=acme")
	anonymous := c.Get("/v1/glossaries/en/fr?tenant=acme")
	ctx.Equal(anonymous.Status, 401, "a read without X-Tenant-Id (%s)", anonymous.Text())
	own := c.Get("/v1/glossaries/en/fr?tenant=acme", "X-Tenant-Id", "acme")
	ctx.Equal(own.Status, 200, "acme naming itself in ?tenant= (%s)", own.Text())
}

func CheckVersion(ctx *harness.Ctx) {
	c := readApi(ctx)
	_, err := glossary.PublishTerms(readBg, "acme", "en", "fr", map[string]string{"Dashboard": "Panneau"})
	ctx.NoError(err, "publishing version 2")
	active := bodyOf(ctx, c.Get("/v1/glossaries/en/fr", "X-Tenant-Id", "acme"))
	ctx.Assert(active["version"] == float64(2) && active["term_count"] == float64(2), "the active glossary answered %v: it must name its version (2) and term_count (2) beside the terms", active)
	pinned := c.Get("/v1/glossaries/en/fr?version=1", "X-Tenant-Id", "acme")
	body := bodyOf(ctx, pinned)
	ctx.Assert(pinned.Status == 200 && body["version"] == float64(1), "?version=1 answered %d %s: a translator must be able to open the version a translation used", pinned.Status, pinned.Text())
	ctx.Equal(body["terms"], v1Terms, "version 1's terms")
}

func CheckNotFound(ctx *harness.Ctx) {
	c := readApi(ctx)
	pair := c.Get("/v1/glossaries/en/de", "X-Tenant-Id", "acme")
	ctx.Equal(pair.Status, 404, "acme has no en->de glossary (%s)", pair.Text())
	tenant := c.Get("/v1/glossaries/en/fr", "X-Tenant-Id", "globex")
	ctx.Equal(tenant.Status, 404, "globex has no en->fr glossary (%s)", tenant.Text())
	version := c.Get("/v1/glossaries/en/fr?version=9", "X-Tenant-Id", "acme")
	ctx.Equal(version.Status, 404, "version 9 does not exist (%s)", version.Text())
}

func CheckFreshness(ctx *harness.Ctx) {
	c := readApi(ctx)
	r := c.Get("/v1/glossaries/en/fr", "X-Tenant-Id", "acme")
	d := directives(r)
	ctx.Assert(!d["public"], "the read answered Cache-Control %q: public lets a shared cache hand acme's terms to the next caller of the URL", r.Header.Get("Cache-Control"))
	ctx.Assert(d["private"] && (d["no-cache"] || d["max-age=0"]), "the read answered Cache-Control %q, expected private, no-cache", r.Header.Get("Cache-Control"))
	_, err := glossary.PublishTerms(readBg, "acme", "en", "fr", map[string]string{"Dashboard": "Panneau"})
	ctx.NoError(err, "publishing a correction")
	again := bodyOf(ctx, c.Get("/v1/glossaries/en/fr", "X-Tenant-Id", "acme"))
	terms, _ := again["terms"].(map[string]any)
	ctx.Equal(terms["Dashboard"], "Panneau", "after a correction, the term the read answered")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <set>
#include <sstream>
#include <string>

namespace {

using json = nlohmann::json;

const json kV1 = {{"Dashboard", "Tableau de bord"}, {"Invoice", "Facture"}};

harness::HTTP readApi(harness::Ctx& ctx) {
  glossary::publishTerms("acme", "en", "fr", {{"Dashboard", "Tableau de bord"}, {"Invoice", "Facture"}});
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

json bodyOf(harness::Ctx& ctx, const harness::Response& r) {
  const json body = json::parse(r.Text(), nullptr, false);
  ctx.Assert(body.is_object(), "the answer is not a JSON object: %d %s", r.Status, r.Text());
  return body;
}

std::set<std::string> directives(const harness::Response& r) {
  std::set<std::string> out;
  std::stringstream in(r.HeaderValue("Cache-Control"));
  std::string d;
  while (std::getline(in, d, ',')) {
    const auto a = d.find_first_not_of(' ');
    if (a != std::string::npos) out.insert(d.substr(a, d.find_last_not_of(' ') - a + 1));
  }
  return out;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = readApi(ctx);
  const auto r = c.Get("/v1/glossaries/en/fr", "X-Tenant-Id", "acme");
  ctx.Equal(r.Status, 200, "GET /v1/glossaries/en/fr (%s)", r.Text());
  ctx.Equal(bodyOf(ctx, r).value("terms", json()), kV1, "acme's en->fr terms");
}

void CheckTenantScope(harness::Ctx& ctx) {
  auto c = readApi(ctx);
  const auto other = c.Get("/v1/glossaries/en/fr?tenant=acme", "X-Tenant-Id", "globex");
  ctx.Assert(other.Text().find("Tableau de bord") == std::string::npos, "globex read acme's glossary with ?tenant=acme: %d %s", other.Status, other.Text());
  ctx.Equal(other.Status, 403, "globex asking for ?tenant=acme");
  const auto anonymous = c.Get("/v1/glossaries/en/fr?tenant=acme");
  ctx.Equal(anonymous.Status, 401, "a read without X-Tenant-Id (%s)", anonymous.Text());
  const auto own = c.Get("/v1/glossaries/en/fr?tenant=acme", "X-Tenant-Id", "acme");
  ctx.Equal(own.Status, 200, "acme naming itself in ?tenant= (%s)", own.Text());
}

void CheckVersion(harness::Ctx& ctx) {
  auto c = readApi(ctx);
  glossary::publishTerms("acme", "en", "fr", {{"Dashboard", "Panneau"}});
  const json active = bodyOf(ctx, c.Get("/v1/glossaries/en/fr", "X-Tenant-Id", "acme"));
  ctx.Assert(active.value("version", 0L) == 2 && active.value("term_count", 0L) == 2, "the active glossary answered %s: it must name its version (2) and term_count (2) beside the terms", active.dump());
  const auto pinned = c.Get("/v1/glossaries/en/fr?version=1", "X-Tenant-Id", "acme");
  const json body = bodyOf(ctx, pinned);
  ctx.Assert(pinned.Status == 200 && body.value("version", 0L) == 1, "?version=1 answered %d %s: a translator must be able to open the version a translation used", pinned.Status, pinned.Text());
  ctx.Equal(body.value("terms", json()), kV1, "version 1's terms");
}

void CheckNotFound(harness::Ctx& ctx) {
  auto c = readApi(ctx);
  const auto pair = c.Get("/v1/glossaries/en/de", "X-Tenant-Id", "acme");
  ctx.Equal(pair.Status, 404, "acme has no en->de glossary (%s)", pair.Text());
  const auto tenant = c.Get("/v1/glossaries/en/fr", "X-Tenant-Id", "globex");
  ctx.Equal(tenant.Status, 404, "globex has no en->fr glossary (%s)", tenant.Text());
  const auto version = c.Get("/v1/glossaries/en/fr?version=9", "X-Tenant-Id", "acme");
  ctx.Equal(version.Status, 404, "version 9 does not exist (%s)", version.Text());
}

void CheckFreshness(harness::Ctx& ctx) {
  auto c = readApi(ctx);
  const auto r = c.Get("/v1/glossaries/en/fr", "X-Tenant-Id", "acme");
  const auto d = directives(r);
  ctx.Assert(!d.count("public"), "the read answered Cache-Control %q: public lets a shared cache hand acme's terms to the next caller of the URL", r.HeaderValue("Cache-Control"));
  ctx.Assert(d.count("private") && (d.count("no-cache") || d.count("max-age=0")), "the read answered Cache-Control %q, expected private, no-cache", r.HeaderValue("Cache-Control"));
  glossary::publishTerms("acme", "en", "fr", {{"Dashboard", "Panneau"}});
  const json again = bodyOf(ctx, c.Get("/v1/glossaries/en/fr", "X-Tenant-Id", "acme"));
  ctx.Equal(again.value("terms", json::object()).value("Dashboard", ""), "Panneau", "after a correction, the term the read answered");
}
`,
  },
  hints: [
    "Read the glossary page as globex with `?tenant=acme`: acme's product names come back. Ask for a pair acme never set up: 200 with empty terms. And the answer never says which version it is.",
    'The handler takes the tenant from the query string before the header, resolves only the active version, turns "none" into empty terms, and sends `public, max-age=3600` on an answer that depends on a request header.',
    'Tenant from `X-Tenant-Id` only (401), 403 when `?tenant=` differs; pass `?version=` to `resolve_glossary` and 404 on None; answer `version`, `term_count` and `terms` with `Cache-Control: private, no-cache`.',
  ],
  debrief: `The tenant is an identity, not a parameter: once a query string can name it, every tenant is one URL edit away from every glossary, so a mismatch is refused rather than resolved. The version and term count turn the page into an audit tool, since a translator can open exactly the glossary a translation used, and a 404 keeps "not set up" apart from "set up, still empty". The cache header follows from the tenant rule: the answer varies by a request header, so a shared cache keyed by URL is a leak, and \`no-cache\` shows a corrected term on the next read. Production services take the tenant from a signed token, audit cross-tenant support access, and send ETags so revalidation costs a 304.`,
};
