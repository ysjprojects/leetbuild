import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/search: the server decides tenant, width, k and version',
  concept: 'http',
  file: 'api',
  focus: ['client', 'search', 'corpus'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/search\` with body \`{query, k, tenant?,
index_version?}\` on the corpus (\`search.corpus\`, provided): it takes the tenant from the body when
one is given (the \`X-Tenant-Id\` header otherwise), searches the version the body names (the active
one otherwise), clamps \`k\` into 1 to 100 and answers \`{hits, k, index_version}\` from
\`corpus.nearest\`. It serves the demo and hides four flaws.

**Failure mode the checks target.** Any caller reads another tenant's corpus by naming it in the
body; a client that asks for 500 results gets 100 and believes it saw everything; a 3-number query
is scored against 4-dimension vectors and still ranks; and a caller searches a retired index version.

- The tenant is the \`X-Tenant-Id\` header: absent is **401**, a body \`tenant\` that differs is **403**.
- The query has exactly the active index's \`dims\` numbers, else **400** naming the active version.
- \`k\` is an integer from 1 to \`MAX_K\` (100); anything else is **400**, not clamped.
- The search runs in the active version; a body \`index_version\` that is not it is **409** naming the
  active one.`,
  sequence: {
    participants: ['Client', 'searchd', 'Corpus'],
    messages: [
      {from: 'Client', to: 'searchd', label: 'POST /v1/search · X-Tenant-Id · {query, k}', kind: 'sync'},
      {from: 'searchd', to: 'searchd', label: 'tenant = header · 401 / 403 on a body tenant', kind: 'sync'},
      {from: 'searchd', to: 'Corpus', label: 'active_index()', kind: 'sync'},
      {from: 'Corpus', to: 'searchd', label: 'idx-42 · dims 4', kind: 'reply'},
      {from: 'searchd', to: 'searchd', label: '409 other version · 400 width · 400 k outside 1..100', kind: 'sync'},
      {from: 'searchd', to: 'Corpus', label: 'nearest(tenant, idx-42, query, k)', kind: 'sync'},
      {from: 'searchd', to: 'Client', label: '200 {hits, k, index_version}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Answers POST /v1/search from the tenant namespace',
      detail:
        'Register `POST /v1/search`; a search under `X-Tenant-Id` answers `{hits, k, index_version}` from `nearest` in the active version.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/search["']/, /corpus\.nearest\(/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/search['"]/, /nearest\(/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/search"/, /corpus\.Nearest\(/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"search"\s*\)/, /\bpost\b/, /Corpus\.nearest\(/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/search"/, /corpus::nearest\(/]},
      },
    },
    {
      id: 'tenant-header',
      title: 'The tenant is the authenticated header',
      detail:
        'The tenant is `X-Tenant-Id` (**401** when absent); a body `tenant` that differs is **403**. The starter prefers the body, so a caller reads any corpus by naming it.',
      match: {
        python: {all: [/x-tenant-id/i, /\b401\b/, /\b403\b/], none: [/body\.tenant\s+or\b/]},
        typescript: {all: [/x-tenant-id/i, /code\(\s*401\s*\)/, /code\(\s*403\s*\)/], none: [/body\.tenant\s*\?\?/]},
        go: {
          all: [/X-Tenant-Id/i, /StatusUnauthorized|\b401\b/, /StatusForbidden|\b403\b/],
          none: [/tenant\s*:=\s*body\.Tenant\b/],
        },
        scala: {all: [/X-Tenant-Id/i, /Unauthorized/, /Forbidden/], none: [/\.orElse\(header\)/]},
        cpp: {all: [/X-Tenant-Id/i, /\b401\b/, /\b403\b/], none: [/tenant\s*=\s*body\.value\(\s*"tenant"/]},
      },
    },
    {
      id: 'k-cap',
      title: 'Rejects k outside 1 to 100 instead of clamping it',
      detail:
        '`k` must be an integer from 1 to `MAX_K` (100); anything else is **400**. The starter clamps it and answers 200, so the caller never learns its request was rewritten.',
      match: {
        python: {all: [/MAX_K/, /\b400\b/], none: [/min\(\s*body\.k/]},
        typescript: {all: [/MAX_K/, /code\(\s*400\s*\)/], none: [/Math\.min\(/]},
        go: {all: [/maxK/, /StatusBadRequest|\b400\b/], none: [/\bk\s*=\s*maxK\b/]},
        scala: {all: [/MaxK/, /BadRequest/], none: [/math\.min\(/]},
        cpp: {all: [/kMaxK/, /\b400\b/], none: [/std::(clamp|min)\(/]},
      },
    },
    {
      id: 'dimension',
      title: 'Checks the query width against the active index',
      detail:
        "The query's length is compared with the active index's `dims` and a mismatch is **400** naming the active version. `nearest` scores over the shorter of two vectors, so the starter ranks a wrong-width query.",
      match: {
        python: {all: [/["']dims["']/, /len\(\s*body\.query\s*\)/]},
        typescript: {all: [/\.dims\b/, /query\.length/]},
        go: {all: [/\.Dims\b/, /len\(\s*body\.Query\s*\)/]},
        scala: {all: [/\.dims\b/, /query\.(length|size)\b/]},
        cpp: {all: [/\.dims\b/, /query\.size\(\)/]},
      },
    },
    {
      id: 'active-version',
      title: 'Searches the active version only',
      detail:
        'The search runs in `active_index()` and a body `index_version` that is not the active one is **409** naming it. The starter searches whatever version the body names.',
      match: {
        python: {all: [/\b409\b/], none: [/body\.index_version\s+or\b/]},
        typescript: {all: [/code\(\s*409\s*\)/], none: [/body\.index_version\s*\?\?/]},
        go: {all: [/StatusConflict|\b409\b/], none: [/version\s*:=\s*body\.IndexVersion\b/]},
        scala: {all: [/Conflict/], none: [/getOrElse\(active\.version\)/]},
        cpp: {all: [/\b409\b/], none: [/body\.value\(\s*"index_version",\s*active\.version\s*\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Request
from pydantic import BaseModel

from search import corpus  # active_index, nearest, document, document_by_id

app = FastAPI()

MAX_K = 100


class SearchRequest(BaseModel):
    query: list[float]
    k: int = 10
    tenant: str | None = None
    index_version: str | None = None


@app.post("/v1/search")
def search(body: SearchRequest, request: Request) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    tenant = body.tenant or request.headers.get("x-tenant-id", "")
    active = corpus.active_index()
    version = body.index_version or active["version"]
    k = max(1, min(body.k, MAX_K))
    hits = corpus.nearest(tenant, version, body.query, k)
    return {"hits": hits, "k": k, "index_version": version}
`,
      solution: `from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

from search import corpus  # active_index, nearest, document, document_by_id

app = FastAPI()

MAX_K = 100


class SearchRequest(BaseModel):
    query: list[float]
    k: int = 10
    tenant: str | None = None
    index_version: str | None = None


@app.post("/v1/search")
def search(body: SearchRequest, request: Request) -> dict:
    # The tenant is who authenticated; a body field may only agree with it.
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    if body.tenant is not None and body.tenant != tenant:
        raise HTTPException(status_code=403, detail="the body names another tenant")
    active = corpus.active_index()
    if body.index_version is not None and body.index_version != active["version"]:
        raise HTTPException(status_code=409, detail={"error": "index version is not active", "index_version": active["version"]})
    if len(body.query) != active["dims"]:
        raise HTTPException(
            status_code=400,
            detail={"error": f"query has {len(body.query)} dimensions, the index has {active['dims']}", "index_version": active["version"]},
        )
    if not 1 <= body.k <= MAX_K:
        raise HTTPException(status_code=400, detail=f"k must be an integer from 1 to {MAX_K}")
    hits = corpus.nearest(tenant, active["version"], body.query, body.k)
    return {"hits": hits, "k": body.k, "index_version": active["version"]}
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {activeIndex, nearest} from 'search/corpus';

export const app = Fastify();

const MAX_K = 100;

interface SearchBody {
  query: number[];
  k?: number;
  tenant?: string;
  index_version?: string;
}

app.post('/v1/search', async request => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const body = request.body as SearchBody;
  const tenant = body.tenant ?? String(request.headers['x-tenant-id'] ?? '');
  const active = await activeIndex();
  const version = body.index_version ?? active.version;
  const k = Math.max(1, Math.min(body.k ?? 10, MAX_K));
  const hits = await nearest(tenant, version, body.query, k);
  return {hits, k, index_version: version};
});
`,
      solution: `import Fastify from 'fastify';

import {activeIndex, nearest} from 'search/corpus';

export const app = Fastify();

const MAX_K = 100;

interface SearchBody {
  query: number[];
  k?: number;
  tenant?: string;
  index_version?: string;
}

app.post('/v1/search', async (request, reply) => {
  const body = request.body as SearchBody;
  // The tenant is who authenticated; a body field may only agree with it.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  if (body.tenant !== undefined && body.tenant !== tenant) return reply.code(403).send({error: 'the body names another tenant'});
  const active = await activeIndex();
  if (body.index_version !== undefined && body.index_version !== active.version) {
    return reply.code(409).send({error: 'index version is not active', index_version: active.version});
  }
  if (body.query.length !== active.dims) {
    return reply.code(400).send({error: \`query has \${body.query.length} dimensions, the index has \${active.dims}\`, index_version: active.version});
  }
  const k = body.k ?? 10;
  if (!Number.isInteger(k) || k < 1 || k > MAX_K) return reply.code(400).send({error: \`k must be an integer from 1 to \${MAX_K}\`});
  const hits = await nearest(tenant, active.version, body.query, k);
  return {hits, k, index_version: active.version};
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"search/corpus" // corpus.ActiveIndex, Nearest, Document, DocumentByID
)

const maxK = 100

type searchRequest struct {
	Query        []float64 \`json:"query"\`
	K            *int      \`json:"k"\`
	Tenant       string    \`json:"tenant"\`
	IndexVersion string    \`json:"index_version"\`
}

type searchResponse struct {
	Hits         []corpus.Hit \`json:"hits"\`
	K            int          \`json:"k"\`
	IndexVersion string       \`json:"index_version"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func search(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	var body searchRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "the body must be JSON"})
		return
	}
	tenant := body.Tenant
	if tenant == "" {
		tenant = r.Header.Get("X-Tenant-Id")
	}
	active := corpus.ActiveIndex(r.Context())
	version := body.IndexVersion
	if version == "" {
		version = active.Version
	}
	k := 10
	if body.K != nil {
		k = *body.K
	}
	if k > maxK {
		k = maxK
	}
	if k < 1 {
		k = 1
	}
	hits := corpus.Nearest(r.Context(), tenant, version, body.Query, k)
	writeJSON(rw, http.StatusOK, searchResponse{Hits: hits, K: k, IndexVersion: version})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/search", search)
}
`,
      solution: `package main

import (
	"encoding/json"
	"fmt"
	"net/http"

	"search/corpus" // corpus.ActiveIndex, Nearest, Document, DocumentByID
)

const maxK = 100

type searchRequest struct {
	Query        []float64 \`json:"query"\`
	K            *int      \`json:"k"\`
	Tenant       string    \`json:"tenant"\`
	IndexVersion string    \`json:"index_version"\`
}

type searchResponse struct {
	Hits         []corpus.Hit \`json:"hits"\`
	K            int          \`json:"k"\`
	IndexVersion string       \`json:"index_version"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func search(rw http.ResponseWriter, r *http.Request) {
	var body searchRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "the body must be JSON"})
		return
	}
	// The tenant is who authenticated; a body field may only agree with it.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	if body.Tenant != "" && body.Tenant != tenant {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "the body names another tenant"})
		return
	}
	active := corpus.ActiveIndex(r.Context())
	if body.IndexVersion != "" && body.IndexVersion != active.Version {
		writeJSON(rw, http.StatusConflict, map[string]string{"error": "index version is not active", "index_version": active.Version})
		return
	}
	if len(body.Query) != active.Dims {
		msg := fmt.Sprintf("query has %d dimensions, the index has %d", len(body.Query), active.Dims)
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": msg, "index_version": active.Version})
		return
	}
	k := 10
	if body.K != nil {
		k = *body.K
	}
	if k < 1 || k > maxK {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("k must be an integer from 1 to %d", maxK)})
		return
	}
	hits := corpus.Nearest(r.Context(), tenant, active.Version, body.Query, k)
	writeJSON(rw, http.StatusOK, searchResponse{Hits: hits, K: k, IndexVersion: active.Version})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/search", search)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import search.Corpus // Corpus.activeIndex, nearest, document, documentById

object Api {
  val MaxK = 100

  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def hitsJson(hits: Seq[Corpus.Hit]): JsArray =
    JsArray(hits.map(h => JsObject("id" -> JsString(h.id), "score" -> JsNumber(h.score))).toVector)

  val route: Route = path("v1" / "search") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") { header =>
        entity(as[String]) { raw =>
          // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
          val body = raw.parseJson.asJsObject.fields
          val query = body.get("query").collect { case JsArray(xs) => xs.collect { case JsNumber(n) => n.toDouble } }.getOrElse(Vector.empty)
          val tenant = body.get("tenant").collect { case JsString(s) => s }.orElse(header).getOrElse("")
          val active = Corpus.activeIndex()
          val version = body.get("index_version").collect { case JsString(s) => s }.getOrElse(active.version)
          val k = math.max(1, math.min(body.get("k").collect { case JsNumber(n) => n.toInt }.getOrElse(10), MaxK))
          val hits = Corpus.nearest(tenant, version, query, k)
          complete(json(StatusCodes.OK, JsObject("hits" -> hitsJson(hits), "k" -> JsNumber(k), "index_version" -> JsString(version))))
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

import search.Corpus // Corpus.activeIndex, nearest, document, documentById

object Api {
  val MaxK = 100

  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String, fields: (String, JsValue)*): HttpResponse =
    json(status, JsObject(("error" -> JsString(message)) +: fields: _*))

  private def hitsJson(hits: Seq[Corpus.Hit]): JsArray =
    JsArray(hits.map(h => JsObject("id" -> JsString(h.id), "score" -> JsNumber(h.score))).toVector)

  val route: Route = path("v1" / "search") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") { header =>
        entity(as[String]) { raw =>
          val body = raw.parseJson.asJsObject.fields
          val query = body.get("query").collect { case JsArray(xs) => xs.collect { case JsNumber(n) => n.toDouble } }.getOrElse(Vector.empty)
          val bodyTenant = body.get("tenant").collect { case JsString(s) => s }
          val requested = body.get("index_version").collect { case JsString(s) => s }
          val k = body.get("k").collect { case JsNumber(n) if n.isValidInt => n.toInt }.getOrElse(10)
          // The tenant is who authenticated; a body field may only agree with it.
          header.filter(_.nonEmpty) match {
            case None => complete(error(StatusCodes.Unauthorized, "X-Tenant-Id is required"))
            case Some(tenant) if bodyTenant.exists(_ != tenant) => complete(error(StatusCodes.Forbidden, "the body names another tenant"))
            case Some(tenant) =>
              val active = Corpus.activeIndex()
              if (requested.exists(_ != active.version))
                complete(error(StatusCodes.Conflict, "index version is not active", "index_version" -> JsString(active.version)))
              else if (query.length != active.dims)
                complete(error(StatusCodes.BadRequest, s"query has \${query.length} dimensions, the index has \${active.dims}", "index_version" -> JsString(active.version)))
              else if (k < 1 || k > MaxK) complete(error(StatusCodes.BadRequest, s"k must be an integer from 1 to $MaxK"))
              else {
                val hits = Corpus.nearest(tenant, active.version, query, k)
                complete(json(StatusCodes.OK, JsObject("hits" -> hitsJson(hits), "k" -> JsNumber(k), "index_version" -> JsString(active.version))))
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

#include <algorithm>
#include <string>
#include <vector>

#include "search/corpus.h"  // corpus::activeIndex, nearest, document, documentById

using json = nlohmann::json;

constexpr long kMaxK = 100;

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void search(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const json body = json::parse(req.body, nullptr, false);
  if (body.is_discarded() || !body.contains("query")) {
    reply(res, 400, {{"error", "the body must be JSON with a query"}});
    return;
  }
  const std::vector<double> query = body["query"].get<std::vector<double>>();
  std::string tenant = body.value("tenant", "");
  if (tenant.empty()) tenant = req.get_header_value("X-Tenant-Id");
  const corpus::Index active = corpus::activeIndex();
  const std::string version = body.value("index_version", active.version);
  const long k = std::clamp(body.value("k", 10L), 1L, kMaxK);
  reply(res, 200, {{"hits", corpus::nearest(tenant, version, query, k)}, {"k", k}, {"index_version", version}});
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/search", search); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "search/corpus.h"  // corpus::activeIndex, nearest, document, documentById

using json = nlohmann::json;

constexpr long kMaxK = 100;

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void search(const httplib::Request& req, httplib::Response& res) {
  const json body = json::parse(req.body, nullptr, false);
  if (body.is_discarded() || !body.contains("query")) {
    reply(res, 400, {{"error", "the body must be JSON with a query"}});
    return;
  }
  const std::vector<double> query = body["query"].get<std::vector<double>>();
  // The tenant is who authenticated; a body field may only agree with it.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    reply(res, 401, {{"error", "X-Tenant-Id is required"}});
    return;
  }
  if (body.contains("tenant") && body["tenant"] != tenant) {
    reply(res, 403, {{"error", "the body names another tenant"}});
    return;
  }
  const corpus::Index active = corpus::activeIndex();
  if (body.contains("index_version") && body["index_version"] != active.version) {
    reply(res, 409, {{"error", "index version is not active"}, {"index_version", active.version}});
    return;
  }
  if (static_cast<long>(query.size()) != active.dims) {
    const std::string msg = "query has " + std::to_string(query.size()) + " dimensions, the index has " + std::to_string(active.dims);
    reply(res, 400, {{"error", msg}, {"index_version", active.version}});
    return;
  }
  const long k = body.value("k", 10L);
  if (k < 1 || k > kMaxK) {
    reply(res, 400, {{"error", "k must be an integer from 1 to " + std::to_string(kMaxK)}});
    return;
  }
  reply(res, 200, {{"hits", corpus::nearest(tenant, active.version, query, k)}, {"k", k}, {"index_version", active.version}});
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/search", search); }
`,
    },
  },
  harness: {
    python: `from search import corpus

QUERY = [1.0, 0.0, 0.0, 0.0]
ACME = {"X-Tenant-Id": "acme"}


def _api(ctx):
    """acme's namespace in the active idx-42 (4 dimensions), globex's g1 beside it, and acme's old-1 in the retired idx-41."""
    corpus.activate("idx-42", 4)
    corpus.put_document("acme", "idx-42", "a1", [0.9, 0.1, 0.0, 0.0])
    corpus.put_document("acme", "idx-42", "a2", [0.5, 0.5, 0.0, 0.0])
    corpus.put_document("acme", "idx-42", "a3", [0.1, 0.9, 0.0, 0.0])
    corpus.put_document("globex", "idx-42", "g1", [1.0, 0.0, 0.0, 0.0])
    corpus.put_document("acme", "idx-41", "old-1", [1.0, 0.0, 0.0, 0.0])
    return ctx.client(ctx.load("api").app)


def _ids(r):
    try:
        return [h["id"] for h in r.json().get("hits", [])]
    except Exception:  # noqa: BLE001
        return []


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await c.post("/v1/search", json={"query": QUERY, "k": 2}, headers=ACME)
    assert r.status_code == 200, f"POST /v1/search answered {r.status_code}: {r.text}"
    body = r.json()
    assert _ids(r) == ["a1", "a2"], f"acme's two nearest documents to {QUERY} are a1 and a2; the search answered {body}"
    assert body.get("k") == 2 and body.get("index_version") == "idx-42", f"the response must carry k 2 and the active version idx-42, got {body}"


async def check_tenant_header(ctx):
    async with _api(ctx) as c:
        anonymous = await c.post("/v1/search", json={"query": QUERY, "k": 2, "tenant": "globex"})
        forged = await c.post("/v1/search", json={"query": QUERY, "k": 2, "tenant": "globex"}, headers=ACME)
        agreeing = await c.post("/v1/search", json={"query": QUERY, "k": 2, "tenant": "acme"}, headers=ACME)
    assert "g1" not in forged.text, f"a caller authenticated as acme read globex's document g1 by naming globex in the body: {forged.status_code} {forged.text}"
    assert "g1" not in anonymous.text, f"a caller with no X-Tenant-Id read globex's document g1 by naming globex in the body: {anonymous.status_code} {anonymous.text}"
    assert anonymous.status_code == 401, f"a search without X-Tenant-Id answered {anonymous.status_code}, expected 401"
    assert forged.status_code == 403, f"a body tenant globex under X-Tenant-Id acme answered {forged.status_code}, expected 403"
    assert agreeing.status_code == 200 and _ids(agreeing) == ["a1", "a2"], f"a body tenant that agrees with the header is allowed: got {agreeing.status_code} {agreeing.text}"


async def check_k_cap(ctx):
    async with _api(ctx) as c:
        big = await c.post("/v1/search", json={"query": QUERY, "k": 500}, headers=ACME)
        zero = await c.post("/v1/search", json={"query": QUERY, "k": 0}, headers=ACME)
        cap = await c.post("/v1/search", json={"query": QUERY, "k": 100}, headers=ACME)
    assert big.status_code == 400, f"k 500 answered {big.status_code} {big.text}: a request above the cap of 100 must be rejected with 400, not clamped"
    assert zero.status_code == 400, f"k 0 answered {zero.status_code} {zero.text}, expected 400"
    assert cap.status_code == 200 and cap.json().get("k") == 100 and len(_ids(cap)) == 3, f"k 100 is allowed and answers acme's three documents, got {cap.status_code} {cap.text}"


async def check_dimension(ctx):
    async with _api(ctx) as c:
        narrow = await c.post("/v1/search", json={"query": [1.0, 0.0, 0.0], "k": 2}, headers=ACME)
        wide = await c.post("/v1/search", json={"query": [1.0, 0.0, 0.0, 0.0, 0.0], "k": 2}, headers=ACME)
    assert narrow.status_code == 400, f"a 3-number query against the 4-dimension index answered {narrow.status_code} {narrow.text}: it was scored against vectors of another width. Reject it with 400"
    assert "idx-42" in narrow.text, f"the 400 must name the active index version it compared against (idx-42), got {narrow.text}"
    assert wide.status_code == 400, f"a 5-number query against the 4-dimension index answered {wide.status_code} {wide.text}, expected 400"


async def check_active_version(ctx):
    async with _api(ctx) as c:
        retired = await c.post("/v1/search", json={"query": QUERY, "k": 2, "index_version": "idx-41"}, headers=ACME)
        current = await c.post("/v1/search", json={"query": QUERY, "k": 2, "index_version": "idx-42"}, headers=ACME)
    assert "old-1" not in retired.text, f"a caller searched the retired version idx-41 by naming it in the body: {retired.status_code} {retired.text}"
    assert retired.status_code == 409 and "idx-42" in retired.text, f"a body index_version idx-41 must be 409 naming the active idx-42, got {retired.status_code} {retired.text}"
    assert current.status_code == 200 and _ids(current) == ["a1", "a2"], f"a body index_version equal to the active one is allowed, got {current.status_code} {current.text}"
`,
    typescript: `const QUERY = [1, 0, 0, 0];
const ACME = {'X-Tenant-Id': 'acme'};

/** acme's namespace in the active idx-42 (4 dimensions), globex's g1 beside it, and acme's old-1 in the retired idx-41. */
async function api(ctx) {
  const corpus = ctx.load('/support/search/corpus.ts');
  await corpus.activate('idx-42', 4);
  await corpus.putDocument('acme', 'idx-42', 'a1', [0.9, 0.1, 0, 0]);
  await corpus.putDocument('acme', 'idx-42', 'a2', [0.5, 0.5, 0, 0]);
  await corpus.putDocument('acme', 'idx-42', 'a3', [0.1, 0.9, 0, 0]);
  await corpus.putDocument('globex', 'idx-42', 'g1', [1, 0, 0, 0]);
  await corpus.putDocument('acme', 'idx-41', 'old-1', [1, 0, 0, 0]);
  return ctx.client(ctx.load('api').app);
}

function ids(r): string[] {
  try {
    return (r.json().hits ?? []).map(h => h.id);
  } catch {
    return [];
  }
}

const search = (c, body, headers = ACME) => c.post('/v1/search', {json: body, headers});

export async function check_route(ctx) {
  const c = await api(ctx);
  const r = await search(c, {query: QUERY, k: 2});
  assert.equal(r.status, 200, \`POST /v1/search answered \${r.status}: \${r.text}\`);
  assert.deepStrictEqual(ids(r), ['a1', 'a2'], \`acme's two nearest documents to [1, 0, 0, 0] are a1 and a2; the search answered \${r.text}\`);
  const body = r.json();
  assert(body.k === 2 && body.index_version === 'idx-42', \`the response must carry k 2 and the active version idx-42, got \${r.text}\`);
}

export async function check_tenant_header(ctx) {
  const c = await api(ctx);
  const anonymous = await search(c, {query: QUERY, k: 2, tenant: 'globex'}, {});
  const forged = await search(c, {query: QUERY, k: 2, tenant: 'globex'});
  const agreeing = await search(c, {query: QUERY, k: 2, tenant: 'acme'});
  assert(!forged.text.includes('g1'), \`a caller authenticated as acme read globex's document g1 by naming globex in the body: \${forged.status} \${forged.text}\`);
  assert(!anonymous.text.includes('g1'), \`a caller with no X-Tenant-Id read globex's document g1 by naming globex in the body: \${anonymous.status} \${anonymous.text}\`);
  assert.equal(anonymous.status, 401, \`a search without X-Tenant-Id answered \${anonymous.status}, expected 401\`);
  assert.equal(forged.status, 403, \`a body tenant globex under X-Tenant-Id acme answered \${forged.status}, expected 403\`);
  assert(agreeing.status === 200 && ids(agreeing).join() === 'a1,a2', \`a body tenant that agrees with the header is allowed: got \${agreeing.status} \${agreeing.text}\`);
}

export async function check_k_cap(ctx) {
  const c = await api(ctx);
  const big = await search(c, {query: QUERY, k: 500});
  const zero = await search(c, {query: QUERY, k: 0});
  const cap = await search(c, {query: QUERY, k: 100});
  assert.equal(big.status, 400, \`k 500 answered \${big.status} \${big.text}: a request above the cap of 100 must be rejected with 400, not clamped\`);
  assert.equal(zero.status, 400, \`k 0 answered \${zero.status} \${zero.text}, expected 400\`);
  assert(cap.status === 200 && cap.json().k === 100 && ids(cap).length === 3, \`k 100 is allowed and answers acme's three documents, got \${cap.status} \${cap.text}\`);
}

export async function check_dimension(ctx) {
  const c = await api(ctx);
  const narrow = await search(c, {query: [1, 0, 0], k: 2});
  const wide = await search(c, {query: [1, 0, 0, 0, 0], k: 2});
  assert.equal(narrow.status, 400, \`a 3-number query against the 4-dimension index answered \${narrow.status} \${narrow.text}: it was scored against vectors of another width. Reject it with 400\`);
  assert(narrow.text.includes('idx-42'), \`the 400 must name the active index version it compared against (idx-42), got \${narrow.text}\`);
  assert.equal(wide.status, 400, \`a 5-number query against the 4-dimension index answered \${wide.status} \${wide.text}, expected 400\`);
}

export async function check_active_version(ctx) {
  const c = await api(ctx);
  const retired = await search(c, {query: QUERY, k: 2, index_version: 'idx-41'});
  const current = await search(c, {query: QUERY, k: 2, index_version: 'idx-42'});
  assert(!retired.text.includes('old-1'), \`a caller searched the retired version idx-41 by naming it in the body: \${retired.status} \${retired.text}\`);
  assert(retired.status === 409 && retired.text.includes('idx-42'), \`a body index_version idx-41 must be 409 naming the active idx-42, got \${retired.status} \${retired.text}\`);
  assert(current.status === 200 && ids(current).join() === 'a1,a2', \`a body index_version equal to the active one is allowed, got \${current.status} \${current.text}\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"search/corpus"

	"leetbuild/harness"
)

var apiQuery = []float64{1, 0, 0, 0}

// api seeds acme's namespace in the active idx-42 (4 dimensions), globex's g1 beside it, and
// acme's old-1 in the retired idx-41.
func api(ctx *harness.Ctx) *harness.HTTP {
	bg := context.Background()
	corpus.Activate(bg, "idx-42", 4)
	corpus.PutDocument(bg, "acme", "idx-42", "a1", []float64{0.9, 0.1, 0, 0})
	corpus.PutDocument(bg, "acme", "idx-42", "a2", []float64{0.5, 0.5, 0, 0})
	corpus.PutDocument(bg, "acme", "idx-42", "a3", []float64{0.1, 0.9, 0, 0})
	corpus.PutDocument(bg, "globex", "idx-42", "g1", []float64{1, 0, 0, 0})
	corpus.PutDocument(bg, "acme", "idx-41", "old-1", []float64{1, 0, 0, 0})
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

type apiAnswer struct {
	Hits []struct {
		ID string \`json:"id"\`
	} \`json:"hits"\`
	K            int    \`json:"k"\`
	IndexVersion string \`json:"index_version"\`
}

func answerOf(r *harness.Response) apiAnswer {
	var a apiAnswer
	json.Unmarshal(r.Body, &a)
	return a
}

func idsOf(r *harness.Response) []string {
	out := []string{}
	for _, h := range answerOf(r).Hits {
		out = append(out, h.ID)
	}
	return out
}

func searchAs(c *harness.HTTP, body map[string]any, tenant string) *harness.Response {
	if tenant == "" {
		return c.Post("/v1/search", body)
	}
	return c.Post("/v1/search", body, "X-Tenant-Id", tenant)
}

func CheckRoute(ctx *harness.Ctx) {
	c := api(ctx)
	r := searchAs(c, map[string]any{"query": apiQuery, "k": 2}, "acme")
	ctx.Equal(r.Status, 200, "POST /v1/search (%s)", r.Text())
	ctx.Equal(idsOf(r), []string{"a1", "a2"}, "acme's two nearest documents to [1 0 0 0] are a1 and a2 (%s)", r.Text())
	a := answerOf(r)
	ctx.Assert(a.K == 2 && a.IndexVersion == "idx-42", "the response must carry k 2 and the active version idx-42, got %s", r.Text())
}

func CheckTenantHeader(ctx *harness.Ctx) {
	c := api(ctx)
	anonymous := searchAs(c, map[string]any{"query": apiQuery, "k": 2, "tenant": "globex"}, "")
	forged := searchAs(c, map[string]any{"query": apiQuery, "k": 2, "tenant": "globex"}, "acme")
	agreeing := searchAs(c, map[string]any{"query": apiQuery, "k": 2, "tenant": "acme"}, "acme")
	ctx.Assert(!strings.Contains(forged.Text(), "g1"), "a caller authenticated as acme read globex's document g1 by naming globex in the body: %d %s", forged.Status, forged.Text())
	ctx.Assert(!strings.Contains(anonymous.Text(), "g1"), "a caller with no X-Tenant-Id read globex's document g1 by naming globex in the body: %d %s", anonymous.Status, anonymous.Text())
	ctx.Equal(anonymous.Status, 401, "a search without X-Tenant-Id")
	ctx.Equal(forged.Status, 403, "a body tenant globex under X-Tenant-Id acme")
	ctx.Assert(agreeing.Status == 200 && strings.Join(idsOf(agreeing), ",") == "a1,a2", "a body tenant that agrees with the header is allowed: got %d %s", agreeing.Status, agreeing.Text())
}

func CheckKCap(ctx *harness.Ctx) {
	c := api(ctx)
	big := searchAs(c, map[string]any{"query": apiQuery, "k": 500}, "acme")
	zero := searchAs(c, map[string]any{"query": apiQuery, "k": 0}, "acme")
	limit := searchAs(c, map[string]any{"query": apiQuery, "k": 100}, "acme")
	ctx.Equal(big.Status, 400, "k 500 answered %s: a request above the cap of 100 must be rejected with 400, not clamped; the status", big.Text())
	ctx.Equal(zero.Status, 400, "k 0 (%s)", zero.Text())
	ctx.Assert(limit.Status == 200 && answerOf(limit).K == 100 && len(idsOf(limit)) == 3, "k 100 is allowed and answers acme's three documents, got %d %s", limit.Status, limit.Text())
}

func CheckDimension(ctx *harness.Ctx) {
	c := api(ctx)
	narrow := searchAs(c, map[string]any{"query": []float64{1, 0, 0}, "k": 2}, "acme")
	wide := searchAs(c, map[string]any{"query": []float64{1, 0, 0, 0, 0}, "k": 2}, "acme")
	ctx.Equal(narrow.Status, 400, "a 3-number query against the 4-dimension index answered %s: it was scored against vectors of another width. Reject it with 400; the status", narrow.Text())
	ctx.Assert(strings.Contains(narrow.Text(), "idx-42"), "the 400 must name the active index version it compared against (idx-42), got %s", narrow.Text())
	ctx.Equal(wide.Status, 400, "a 5-number query against the 4-dimension index (%s)", wide.Text())
}

func CheckActiveVersion(ctx *harness.Ctx) {
	c := api(ctx)
	retired := searchAs(c, map[string]any{"query": apiQuery, "k": 2, "index_version": "idx-41"}, "acme")
	current := searchAs(c, map[string]any{"query": apiQuery, "k": 2, "index_version": "idx-42"}, "acme")
	ctx.Assert(!strings.Contains(retired.Text(), "old-1"), "a caller searched the retired version idx-41 by naming it in the body: %d %s", retired.Status, retired.Text())
	ctx.Assert(retired.Status == 409 && strings.Contains(retired.Text(), "idx-42"), "a body index_version idx-41 must be 409 naming the active idx-42, got %d %s", retired.Status, retired.Text())
	ctx.Assert(current.Status == 200 && strings.Join(idsOf(current), ",") == "a1,a2", "a body index_version equal to the active one is allowed, got %d %s", current.Status, current.Text())
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

namespace {

const std::string kQuery = "[1.0, 0.0, 0.0, 0.0]";

// acme's namespace in the active idx-42 (4 dimensions), globex's g1 beside it, and acme's old-1 in
// the retired idx-41.
harness::HTTP api(harness::Ctx& ctx) {
  corpus::activate("idx-42", 4);
  corpus::putDocument("acme", "idx-42", "a1", {0.9, 0.1, 0, 0});
  corpus::putDocument("acme", "idx-42", "a2", {0.5, 0.5, 0, 0});
  corpus::putDocument("acme", "idx-42", "a3", {0.1, 0.9, 0, 0});
  corpus::putDocument("globex", "idx-42", "g1", {1, 0, 0, 0});
  corpus::putDocument("acme", "idx-41", "old-1", {1, 0, 0, 0});
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

nlohmann::json parsed(const harness::Response& r) {
  const auto j = nlohmann::json::parse(r.Text(), nullptr, false);
  return j.is_discarded() ? nlohmann::json::object() : j;
}

std::string ids(const harness::Response& r) {
  const auto j = parsed(r);
  std::string out;
  if (j.is_object() && j.contains("hits") && j["hits"].is_array()) {
    for (const auto& h : j["hits"]) out += (out.empty() ? "" : ",") + h.value("id", std::string());
  }
  return out;
}

bool has(const harness::Response& r, const std::string& needle) { return r.Text().find(needle) != std::string::npos; }

harness::Response searchAs(harness::HTTP& c, const std::string& body, const std::string& tenant) {
  if (tenant.empty()) return c.Post("/v1/search", body, "Content-Type", "application/json");
  return c.Post("/v1/search", body, "Content-Type", "application/json", "X-Tenant-Id", tenant);
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = searchAs(c, R"({"query": [1.0, 0.0, 0.0, 0.0], "k": 2})", "acme");
  ctx.Equal(r.Status, 200, "POST /v1/search (%s)", r.Text());
  ctx.Equal(ids(r), "a1,a2", "acme's two nearest documents to [1, 0, 0, 0] are a1 and a2 (%s)", r.Text());
  const auto body = parsed(r);
  ctx.Assert(body.value("k", 0L) == 2 && body.value("index_version", std::string()) == "idx-42", "the response must carry k 2 and the active version idx-42, got %s", r.Text());
}

void CheckTenantHeader(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto anonymous = searchAs(c, R"({"query": [1.0, 0.0, 0.0, 0.0], "k": 2, "tenant": "globex"})", "");
  const auto forged = searchAs(c, R"({"query": [1.0, 0.0, 0.0, 0.0], "k": 2, "tenant": "globex"})", "acme");
  const auto agreeing = searchAs(c, R"({"query": [1.0, 0.0, 0.0, 0.0], "k": 2, "tenant": "acme"})", "acme");
  ctx.Assert(!has(forged, "g1"), "a caller authenticated as acme read globex's document g1 by naming globex in the body: %d %s", forged.Status, forged.Text());
  ctx.Assert(!has(anonymous, "g1"), "a caller with no X-Tenant-Id read globex's document g1 by naming globex in the body: %d %s", anonymous.Status, anonymous.Text());
  ctx.Equal(anonymous.Status, 401, "a search without X-Tenant-Id");
  ctx.Equal(forged.Status, 403, "a body tenant globex under X-Tenant-Id acme");
  ctx.Assert(agreeing.Status == 200 && ids(agreeing) == "a1,a2", "a body tenant that agrees with the header is allowed: got %d %s", agreeing.Status, agreeing.Text());
}

void CheckKCap(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto big = searchAs(c, R"({"query": [1.0, 0.0, 0.0, 0.0], "k": 500})", "acme");
  const auto zero = searchAs(c, R"({"query": [1.0, 0.0, 0.0, 0.0], "k": 0})", "acme");
  const auto limit = searchAs(c, R"({"query": [1.0, 0.0, 0.0, 0.0], "k": 100})", "acme");
  ctx.Equal(big.Status, 400, "k 500 answered %s: a request above the cap of 100 must be rejected with 400, not clamped; the status", big.Text());
  ctx.Equal(zero.Status, 400, "k 0 (%s)", zero.Text());
  ctx.Assert(limit.Status == 200 && parsed(limit).value("k", 0L) == 100 && ids(limit) == "a1,a2,a3", "k 100 is allowed and answers acme's three documents, got %d %s", limit.Status, limit.Text());
}

void CheckDimension(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto narrow = searchAs(c, R"({"query": [1.0, 0.0, 0.0], "k": 2})", "acme");
  const auto wide = searchAs(c, R"({"query": [1.0, 0.0, 0.0, 0.0, 0.0], "k": 2})", "acme");
  ctx.Equal(narrow.Status, 400, "a 3-number query against the 4-dimension index answered %s: it was scored against vectors of another width. Reject it with 400; the status", narrow.Text());
  ctx.Assert(has(narrow, "idx-42"), "the 400 must name the active index version it compared against (idx-42), got %s", narrow.Text());
  ctx.Equal(wide.Status, 400, "a 5-number query against the 4-dimension index (%s)", wide.Text());
}

void CheckActiveVersion(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto retired = searchAs(c, R"({"query": [1.0, 0.0, 0.0, 0.0], "k": 2, "index_version": "idx-41"})", "acme");
  const auto current = searchAs(c, R"({"query": [1.0, 0.0, 0.0, 0.0], "k": 2, "index_version": "idx-42"})", "acme");
  ctx.Assert(!has(retired, "old-1"), "a caller searched the retired version idx-41 by naming it in the body: %d %s", retired.Status, retired.Text());
  ctx.Assert(retired.Status == 409 && has(retired, "idx-42"), "a body index_version idx-41 must be 409 naming the active idx-42, got %d %s", retired.Status, retired.Text());
  ctx.Assert(current.Status == 200 && ids(current) == "a1,a2", "a body index_version equal to the active one is allowed, got %d %s", current.Status, current.Text());
}
`,
  },
  hints: [
    'Send `tenant: "globex"` in the body under acme\'s header and globex\'s documents come back; `k: 500` answers 200 with `k: 100`; a three-number query against the four-dimension index still ranks.',
    "The handler prefers the body's `tenant` and `index_version` to what the server knows, clamps `k` with `min` and `max`, and hands the query to `nearest`, which scores over the shorter of two vectors without checking widths.",
    'Read `X-Tenant-Id` (401 when empty, 403 when the body tenant differs), 409 a body `index_version` other than the active one, 400 when `len(query)` differs from `dims`, 400 for `k` outside 1 to `MAX_K`; search the active version.',
  ],
  debrief: `Each fix moves a decision from the caller to the server: the tenant comes from authentication, the version from the index catalog, the width from the index itself. Rejecting instead of clamping matters because a clamped request still answers 200, so a client paging through 500 results stops at 100 believing it saw everything. The width check belongs at the edge because a dot product over mismatched vectors still produces numbers, and numbers look like a ranking. Production services take the tenant from a signed token rather than a bare header, reject non-finite elements, and let a client pin an older index only through a named alias the operator controls.`,
};
