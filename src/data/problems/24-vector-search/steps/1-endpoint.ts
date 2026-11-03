import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/search: the query contract',
  concept: 'http',
  file: 'api',
  focus: ['client', 'search', 'index'],
  task: `## Task

**Starting point.** The starter registers \`POST /v1/search\` with body
\`{"query": [0.1, …], "k": 10, "tenant": "acme", "index_version": "idx-42"}\`, clamps \`k\` into
1..100, searches the index as the tenant and version the body names, and returns \`hits\`, \`k\`
and \`index_version\`. It compiles, serves the demo and hides four flaws.

**Failure mode the checks target.** A body \`tenant\` lets any caller read any tenant's corpus by
naming it; an unbounded \`k\` asks the index for everything; a caller-named \`index_version\` reads a
retired or future snapshot; and only the dimension check stops a wrong-width query at the edge.

- The tenant is the authenticated \`X-Tenant-Id\` header and is **required** (**401** when absent).
  A \`tenant\` field in the body is not trusted: when it contradicts the header the request is
  **403**. The header is the only tenant the search runs as.
- The query vector must have exactly the active index's dimension (**768**); a mismatch is **400**
  and the error names the active index version it was compared against.
- \`k\` is an integer from **1** to **100**; anything above the cap is **400**, not clamped, and the
  response echoes the \`k\` that was actually searched.
- The index version is resolved **server-side** to the active one. A body \`index_version\` that is
  not the active version is **409** with the active version in the error.
- The response carries \`hits\`, \`k\` and the \`index_version\` the search actually ran against.`,
  sequence: {
    participants: ['Client', 'Search API', 'Index versions'],
    messages: [
      {from: 'Client', to: 'Search API', label: 'POST /v1/search · X-Tenant-Id · {query, k}', kind: 'sync'},
      {from: 'Search API', to: 'Search API', label: 'authenticate · drop body tenant', kind: 'sync'},
      {from: 'Search API', to: 'Index versions', label: 'activeVersion() · dimensions()', kind: 'sync'},
      {from: 'Index versions', to: 'Search API', label: 'idx-42 · 768', kind: 'reply'},
      {from: 'Search API', to: 'Search API', label: 'reject k > 100 · wrong dimension', kind: 'sync'},
      {from: 'Search API', to: 'Client', label: '200 {hits, k, index_version} / 403 / 409', kind: 'reply'},
    ],
  },
  hints: [
    "A request with a forged body `tenant` returns another tenant's documents, `k: 500` comes back 200 with `k: 100`, and a 512-wide vector reaches the shards.",
    'The handler reads tenant and version from the body and clamps `k` with `min`; nothing reads `X-Tenant-Id`, compares `len(query)` to the index dimension, or checks the version.',
    'Read `X-Tenant-Id` (401 absent, 403 on body mismatch), reject `len(query) != INDEX_DIMENSIONS` with 400, reject `k > MAX_K` with 400, and 409 any body `index_version` that is not `ACTIVE_INDEX_VERSION`.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/search',
      detail: 'Register the search route on `POST /v1/search`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/search["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/search['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/search"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"search"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/search"/]},
      },
    },
    {
      id: 'tenant-filter',
      title: 'Scopes the search to the authenticated tenant',
      detail:
        'The tenant comes from `X-Tenant-Id` (**401** when missing) and a contradicting `tenant` in the body is **403**. The starter reads the tenant from the body, so any caller can search any corpus.',
      match: {
        python: {all: [/X-Tenant-Id/, /status_code\s*=\s*401/, /status_code\s*=\s*403/, /body\.tenant/]},
        typescript: {all: [/x-tenant-id/, /code\(\s*401\s*\)/, /code\(\s*403\s*\)/, /body\.tenant/]},
        go: {all: [/X-Tenant-Id/, /StatusUnauthorized/, /StatusForbidden/, /body\.Tenant/]},
        scala: {all: [/X-Tenant-Id/, /StatusCodes\.Unauthorized/, /StatusCodes\.Forbidden/, /body\.tenant/]},
        cpp: {all: [/X-Tenant-Id/, /\b401\b/, /\b403\b/, /body\.value\(\s*"tenant"/]},
      },
    },
    {
      id: 'k-cap',
      title: 'Rejects k above the cap instead of clamping it',
      detail:
        '`k` must be an integer in 1..100 and anything above the cap is **400**. The starter clamps `k` down to the cap and answers 200, so the caller never learns its request was rewritten.',
      match: {
        python: {all: [/MAX_K\s*=\s*100/, /1\s*<=\s*body\.k\s*<=\s*MAX_K/, /status_code\s*=\s*400/]},
        typescript: {all: [/MAX_K\s*=\s*100/, /k\s*>\s*MAX_K/, /code\(\s*400\s*\)/]},
        go: {all: [/maxK\s*=\s*100/, /k\s*>\s*maxK/, /StatusBadRequest/]},
        scala: {all: [/MaxK\s*=\s*100/, /k\s*>\s*MaxK/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kMaxK\s*=\s*100/, /k\s*>\s*kMaxK/, /\b400\b/]},
      },
    },
    {
      id: 'dimension',
      title: 'Checks the query against the active dimension',
      detail:
        'The vector length is compared against the active index dimension (**768**) and a mismatch is **400** with the active version in the error. The starter never compares the vector, so a wrong-width query reaches the shards.',
      match: {
        python: {all: [/INDEX_DIMENSIONS/, /len\(body\.query\)\s*!=\s*INDEX_DIMENSIONS/, /active_version/]},
        typescript: {all: [/INDEX_DIMENSIONS/, /vector\.length\s*!==\s*INDEX_DIMENSIONS/, /active_version/]},
        go: {all: [/indexDimensions/, /len\(body\.Query\)\s*!=\s*indexDimensions/, /active_version/]},
        scala: {all: [/IndexDimensions/, /\.length\s*!=\s*IndexDimensions/, /active_version/]},
        cpp: {all: [/kIndexDimensions/, /\.size\(\)\s*!=\s*kIndexDimensions/, /active_version/]},
      },
    },
    {
      id: 'active-version',
      title: 'Resolves the index version server-side',
      detail:
        'The searched version is the active one and a body `index_version` that disagrees is **409** naming the active version. The starter searches whatever version the body names.',
      match: {
        python: {all: [/ACTIVE_INDEX_VERSION/, /status_code\s*=\s*409/, /body\.index_version/]},
        typescript: {all: [/ACTIVE_INDEX_VERSION/, /code\(\s*409\s*\)/, /body\.index_version/]},
        go: {all: [/activeIndexVersion/, /StatusConflict/, /body\.IndexVersion/]},
        scala: {all: [/ActiveIndexVersion/, /StatusCodes\.Conflict/, /body\.index_version/]},
        cpp: {all: [/kActiveIndexVersion/, /\b409\b/, /index_version/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("search")

ACTIVE_INDEX_VERSION = "idx-42"


class SearchRequest(BaseModel):
    query: list[float]
    k: int = 10
    tenant: str
    index_version: str = ACTIVE_INDEX_VERSION


class Index:
    def search(self, tenant: str, query: list[float], k: int, version: str) -> list[dict]:
        """Nearest neighbors for one tenant, from one index version."""
        raise NotImplementedError


index = Index()


@app.post("/v1/search")
def search(body: SearchRequest) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    k = max(1, min(body.k, 100))
    hits = index.search(body.tenant, body.query, k, body.index_version)
    logger.info("search tenant=%s k=%d version=%s", body.tenant, k, body.index_version)
    return JSONResponse({"hits": hits, "k": k, "index_version": body.index_version}, status_code=200)
`,
      solution: `import logging

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("search")

MAX_K = 100
INDEX_DIMENSIONS = 768
ACTIVE_INDEX_VERSION = "idx-42"


class SearchRequest(BaseModel):
    query: list[float]
    k: int = 10
    tenant: str | None = None
    index_version: str | None = None


class Index:
    def search(self, tenant: str, query: list[float], k: int, version: str) -> list[dict]:
        """Nearest neighbors for one tenant, from one index version."""
        raise NotImplementedError


index = Index()


def authenticate(header_tenant: str | None, body_tenant: str | None) -> str:
    """The header is the tenant; a body field may only agree with it."""
    if header_tenant is None or header_tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if body_tenant is not None and body_tenant != header_tenant:
        raise HTTPException(status_code=403, detail="body tenant does not match the authenticated tenant")
    return header_tenant


def resolve_version(requested: str | None) -> str:
    """The only searchable version is the active one; a caller may only confirm it."""
    if requested is not None and requested != ACTIVE_INDEX_VERSION:
        raise HTTPException(
            status_code=409,
            detail={"error": "index version is not active", "active_version": ACTIVE_INDEX_VERSION},
        )
    return ACTIVE_INDEX_VERSION


def validate(body: SearchRequest) -> None:
    if len(body.query) != INDEX_DIMENSIONS:
        raise HTTPException(
            status_code=400,
            detail={
                "error": "query vector has the wrong dimension",
                "expected": INDEX_DIMENSIONS,
                "active_version": ACTIVE_INDEX_VERSION,
            },
        )
    if not 1 <= body.k <= MAX_K:
        raise HTTPException(status_code=400, detail="k must be an integer between 1 and 100")


@app.post("/v1/search")
def search(
    body: SearchRequest,
    tenant_header: str | None = Header(default=None, alias="X-Tenant-Id"),
) -> JSONResponse:
    tenant = authenticate(tenant_header, body.tenant)
    version = resolve_version(body.index_version)
    validate(body)
    hits = index.search(tenant, body.query, body.k, version)
    logger.info("search tenant=%s k=%d version=%s", tenant, body.k, version)
    return JSONResponse({"hits": hits, "k": body.k, "index_version": version}, status_code=200)
`,
    },
    typescript: {
      starter: `/** POST /v1/search. */
import Fastify from 'fastify';

import {index} from './index_store';

export const app = Fastify();

interface SearchBody {
  query: number[];
  k?: number;
  tenant: string;
  index_version?: string;
}

app.post('/v1/search', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const body = request.body as SearchBody;
  const version = body.index_version ?? 'idx-42';
  const k = Math.min(Math.max(body.k ?? 10, 1), 100);
  const hits = await index.search(body.tenant, body.query, k, version);
  request.log.info({tenant: body.tenant, k, version}, 'searched');
  return reply.code(200).send({hits, k, index_version: version});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/search: the tenant, the cap and the index version are the server's to decide. */
import Fastify from 'fastify';

import {index} from './index_store';

export const app = Fastify();

const MAX_K = 100;
const INDEX_DIMENSIONS = 768;
const ACTIVE_INDEX_VERSION = 'idx-42';

interface SearchBody {
  query?: number[];
  k?: number;
  tenant?: string;
  index_version?: string;
}

app.post('/v1/search', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});

  const body = (request.body ?? {}) as SearchBody;
  if (body.tenant !== undefined && body.tenant !== tenant)
    return reply.code(403).send({error: 'body tenant does not match the authenticated tenant'});
  if (body.index_version !== undefined && body.index_version !== ACTIVE_INDEX_VERSION)
    return reply
      .code(409)
      .send({error: 'index version is not active', active_version: ACTIVE_INDEX_VERSION});

  const vector = body.query;
  if (!Array.isArray(vector) || vector.length !== INDEX_DIMENSIONS)
    return reply.code(400).send({
      error: 'query vector has the wrong dimension',
      expected: INDEX_DIMENSIONS,
      active_version: ACTIVE_INDEX_VERSION,
    });
  const k = body.k ?? 10;
  if (!Number.isInteger(k) || k < 1 || k > MAX_K) return reply.code(400).send({error: 'k must be between 1 and 100'});

  const hits = await index.search(tenant, vector, k, ACTIVE_INDEX_VERSION);
  request.log.info({tenant, k, version: ACTIVE_INDEX_VERSION}, 'searched');
  return reply.code(200).send({hits, k, index_version: ACTIVE_INDEX_VERSION});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
)

const activeIndexVersion = "idx-42"

type SearchRequest struct {
	Query        []float64 \`json:"query"\`
	K            int       \`json:"k"\`
	Tenant       string    \`json:"tenant,omitempty"\`
	IndexVersion string    \`json:"index_version,omitempty"\`
}

type Hit struct {
	ID    string  \`json:"id"\`
	Score float64 \`json:"score"\`
}

type Index struct{}

func (i *Index) Search(ctx context.Context, tenant string, query []float64, k int, version string) ([]Hit, error) {
	return nil, nil
}

var index = &Index{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func search(rw http.ResponseWriter, r *http.Request) {
	var body SearchRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	version := body.IndexVersion
	if version == "" {
		version = activeIndexVersion
	}
	k := body.K
	if k < 1 {
		k = 10
	}
	if k > 100 {
		k = 100
	}
	hits, err := index.Search(r.Context(), body.Tenant, body.Query, k, version)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "index unavailable"})
		return
	}
	log.Printf("search tenant=%s k=%d version=%s", body.Tenant, k, version)
	writeJSON(rw, http.StatusOK, map[string]any{"hits": hits, "k": k, "index_version": version})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/search", search)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
)

const (
	maxK               = 100
	indexDimensions    = 768
	activeIndexVersion = "idx-42"
)

type SearchRequest struct {
	Query        []float64 \`json:"query"\`
	K            int       \`json:"k"\`
	Tenant       string    \`json:"tenant,omitempty"\`
	IndexVersion string    \`json:"index_version,omitempty"\`
}

type Hit struct {
	ID    string  \`json:"id"\`
	Score float64 \`json:"score"\`
}

type Index struct{}

func (i *Index) Search(ctx context.Context, tenant string, query []float64, k int, version string) ([]Hit, error) {
	return nil, nil
}

var index = &Index{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func resolveVersion(requested string) (string, bool) {
	if requested != "" && requested != activeIndexVersion {
		return activeIndexVersion, false
	}
	return activeIndexVersion, true
}

func search(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	var body SearchRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if body.Tenant != "" && body.Tenant != tenant {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "body tenant does not match the authenticated tenant"})
		return
	}
	version, ok := resolveVersion(body.IndexVersion)
	if !ok {
		writeJSON(rw, http.StatusConflict, map[string]any{"error": "index version is not active", "active_version": version})
		return
	}
	if len(body.Query) != indexDimensions {
		writeJSON(rw, http.StatusBadRequest, map[string]any{
			"error":          "query vector has the wrong dimension",
			"expected":       indexDimensions,
			"active_version": version,
		})
		return
	}
	k := body.K
	if k == 0 {
		k = 10
	}
	if k < 1 || k > maxK {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "k must be between 1 and 100"})
		return
	}
	hits, err := index.Search(r.Context(), tenant, body.Query, k, version)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "index unavailable"})
		return
	}
	log.Printf("search tenant=%s k=%d version=%s", tenant, k, version)
	writeJSON(rw, http.StatusOK, map[string]any{"hits": hits, "k": k, "index_version": version})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/search", search)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class SearchRequest(query: List[Double], k: Int, tenant: String, index_version: Option[String])
final case class Hit(id: String, score: Double)

trait Index {
  def search(tenant: String, query: List[Double], k: Int, version: String): List[Hit]
}

object Index {
  def open(): Index = new Index {
    def search(tenant: String, query: List[Double], k: Int, version: String): List[Hit] = Nil
  }
}

object SearchApi {
  implicit val system: ActorSystem = ActorSystem("vector-search")
  implicit val searchFormat: RootJsonFormat[SearchRequest] = jsonFormat4(SearchRequest)

  val ActiveIndexVersion = "idx-42"
  val index: Index = Index.open()

  val route: Route =
    path("v1" / "search") {
      post {
        entity(as[SearchRequest]) { body =>
          // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
          val version = body.index_version.getOrElse(ActiveIndexVersion)
          val k = math.max(1, math.min(body.k, 100))
          val hits = index.search(body.tenant, body.query, k, version)
          system.log.info(s"search tenant=\${body.tenant} k=$k version=$version")
          complete(StatusCodes.OK, s"""{"k":$k,"index_version":"$version","hits":\${hits.size}}""")
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class SearchRequest(query: List[Double], k: Int, tenant: Option[String], index_version: Option[String])
final case class Hit(id: String, score: Double)
final case class SearchResponse(k: Int, index_version: String, hits: List[Hit])

trait Index {
  def search(tenant: String, query: List[Double], k: Int, version: String): List[Hit]
}

object Index {
  def open(): Index = new Index {
    def search(tenant: String, query: List[Double], k: Int, version: String): List[Hit] = Nil
  }
}

object SearchApi {
  implicit val system: ActorSystem = ActorSystem("vector-search")
  implicit val searchFormat: RootJsonFormat[SearchRequest] = jsonFormat4(SearchRequest)
  implicit val hitFormat: RootJsonFormat[Hit] = jsonFormat2(Hit)
  implicit val responseFormat: RootJsonFormat[SearchResponse] = jsonFormat3(SearchResponse)

  val MaxK = 100
  val IndexDimensions = 768
  val ActiveIndexVersion = "idx-42"

  val index: Index = Index.open()

  val route: Route =
    path("v1" / "search") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          entity(as[SearchRequest]) { body =>
            tenantOpt.filter(_.nonEmpty) match {
              case None =>
                complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
              case Some(tenant) if body.tenant.exists(_ != tenant) =>
                complete(StatusCodes.Forbidden, """{"error":"body tenant does not match the authenticated tenant"}""")
              case Some(_) if body.index_version.exists(_ != ActiveIndexVersion) =>
                complete(
                  StatusCodes.Conflict,
                  s"""{"error":"index version is not active","active_version":"$ActiveIndexVersion"}""")
              case Some(_) if body.query.length != IndexDimensions =>
                complete(
                  StatusCodes.BadRequest,
                  s"""{"error":"query vector has the wrong dimension","expected":$IndexDimensions,"active_version":"$ActiveIndexVersion"}""")
              case Some(_) if body.k < 1 || body.k > MaxK =>
                complete(StatusCodes.BadRequest, """{"error":"k must be between 1 and 100"}""")
              case Some(tenant) =>
                val hits = index.search(tenant, body.query, body.k, ActiveIndexVersion)
                system.log.info(s"search tenant=$tenant k=\${body.k} version=$ActiveIndexVersion")
                complete(StatusCodes.OK, SearchResponse(body.k, ActiveIndexVersion, hits))
            }
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <iostream>
#include <string>

using json = nlohmann::json;

const std::string kActiveIndexVersion = "idx-42";

struct Index {
  json search(const std::string& tenant, const std::vector<double>& query, int k, const std::string& version);
};

Index index;

int main() {
  httplib::Server svr;

  svr.Post("/v1/search", [](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    const auto tenant = body.value("tenant", std::string());
    const auto version = body.value("index_version", kActiveIndexVersion);
    const auto query = body.value("query", std::vector<double>());
    const int k = std::clamp(body.value("k", 10), 1, 100);
    const json hits = index.search(tenant, query, k, version);
    std::clog << "search tenant=" << tenant << " k=" << k << " version=" << version << "\\n";
    res.status = 200;
    res.set_content(json{{"hits", hits}, {"k", k}, {"index_version", version}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <string>

using json = nlohmann::json;

constexpr int kMaxK = 100;
constexpr std::size_t kIndexDimensions = 768;
const std::string kActiveIndexVersion = "idx-42";

struct Index {
  json search(const std::string& tenant, const std::vector<double>& query, int k, const std::string& version);
};

Index index;

int main() {
  httplib::Server svr;

  svr.Post("/v1/search", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    const auto bodyTenant = body.value("tenant", std::string());
    if (!bodyTenant.empty() && bodyTenant != tenant) {
      res.status = 403;
      res.set_content(R"({"error":"body tenant does not match the authenticated tenant"})", "application/json");
      return;
    }
    const auto requestedVersion = body.value("index_version", std::string());
    if (!requestedVersion.empty() && requestedVersion != kActiveIndexVersion) {
      res.status = 409;
      res.set_content(
          json{{"error", "index version is not active"}, {"active_version", kActiveIndexVersion}}.dump(),
          "application/json");
      return;
    }
    const auto query = body.value("query", std::vector<double>());
    if (query.size() != kIndexDimensions) {
      res.status = 400;
      res.set_content(json{{"error", "query vector has the wrong dimension"},
                           {"expected", kIndexDimensions},
                           {"active_version", kActiveIndexVersion}}
                          .dump(),
                      "application/json");
      return;
    }
    const int k = body.value("k", 10);
    if (k < 1 || k > kMaxK) {
      res.status = 400;
      res.set_content(R"({"error":"k must be between 1 and 100"})", "application/json");
      return;
    }
    const json hits = index.search(tenant, query, k, kActiveIndexVersion);
    std::clog << "search tenant=" << tenant << " k=" << k << " version=" << kActiveIndexVersion << "\\n";
    res.status = 200;
    res.set_content(json{{"hits", hits}, {"k", k}, {"index_version", kActiveIndexVersion}}.dump(),
                    "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The fix has the shape of guard clauses in trust order: the header tenant first, because
every later decision runs as that tenant; then the version, read once from the registry so the
dimension check, the search and the response all agree on one string; then the width and \`k\`.
Rejecting \`k > 100\` instead of clamping keeps the response consistent with what was searched, and a
body \`tenant\` that contradicts the header is a 403 rather than a silent override. Production
search services go further: the index registry carries per-tenant dimensions and caps an operator
can lower, and a handshake endpoint returns \`active_version\` and \`dimensions\` so clients can
validate a query before sending it.
`,
};
