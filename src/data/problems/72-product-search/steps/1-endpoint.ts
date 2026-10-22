import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'GET /v1/search: the query DSL is not a filter injection',
  concept: 'http',
  file: 'api',
  focus: ['client', 'search', 'engine'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers \`GET /v1/search\`,
reads the text query, the filter string and the page size off the request, and hands them to the
query engine. It compiles, it serves the demo, and it hides four production flaws. Review it like
the service owner, fix it, and prove the fix with the checks below.

Implement \`GET /v1/search\` with query parameters \`q\`, \`filters\`, \`page_size\` and the
authenticated \`X-Tenant-Id\` header.

- \`q\` is a non-empty string of at most **256 bytes** of UTF-8 (**400** otherwise). Byte length,
  not character count: one emoji is four bytes.
- \`filters\` is a JSON object whose keys are checked against the **per-tenant allowlist**
  \`{"brand", "category", "in_stock", "min_price", "max_price"}\`. An unknown field is **400** and
  the response names the offending field and lists the allowed set. Only allowlisted fields reach
  the engine.
- \`page_size\` is an integer from **1** to **100** (**400** above the cap). The draft accepts
  \`page_size=10000\`, so one call can ask the index for the whole catalog.
- The engine query is assembled by a helper (\`build_engine_query\` / \`buildEngineQuery\`) from the
  **validated** fields and the tenant, never by interpolating the caller's filter string. The tenant
  travels in the query, so the engine scopes the result set to the caller's catalog.
- Log the decision — tenant, page size, the *names* of the filters used — never the raw filter text
  or the query text.

**Failure mode the checks target.** Passing the caller's filter string straight into the engine makes
every field in the index addressable: a crafted filter can name an unpublished field or another
tenant's attribute, which is how a search box becomes a data leak. The missing caps turn the endpoint
into an unbounded read: a page size of 10000 or a megabyte query is a cheap way to exhaust the index.
The fix is the boring one — validate cheaply before the expensive call, and build the engine query
only from values that survived the allowlist.`,
  sequence: {
    participants: ['Client', 'Search API', 'Query engine'],
    messages: [
      {from: 'Client', to: 'Search API', label: 'GET /v1/search · X-Tenant-Id · q · filters · page_size', kind: 'sync'},
      {from: 'Search API', to: 'Search API', label: 'cap q · allowlist filter fields · cap page_size', kind: 'sync'},
      {from: 'Search API', to: 'Query engine', label: 'buildEngineQuery(validated, tenant)', kind: 'sync'},
      {from: 'Query engine', to: 'Search API', label: 'page of products', kind: 'reply'},
      {from: 'Search API', to: 'Client', label: '200 {results, page_size}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/search',
      detail: 'Register the search route on `GET /v1/search`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/search["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/search['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/search"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"search"\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*"\/v1\/search"/]},
      },
    },
    {
      id: 'query-cap',
      title: 'Caps the text query at 256 bytes',
      detail:
        '`q` must be non-empty and at most `1 << 8` bytes of UTF-8; anything larger is **400**. The draft forwards an unbounded query to the engine.',
      match: {
        python: {all: [/MAX_QUERY_BYTES/, /status_code\s*=\s*400/, /encode\("utf-8"\)/]},
        typescript: {all: [/MAX_QUERY_BYTES/, /code\(\s*400\s*\)/, /Buffer\.byteLength/]},
        go: {all: [/maxQueryBytes/, /StatusBadRequest/, /len\(\[\]byte\(/]},
        scala: {all: [/MaxQueryBytes/, /StatusCodes\.BadRequest/, /getBytes/]},
        cpp: {all: [/kMaxQueryBytes/, /\b400\b/, /\.size\(\)/]},
      },
    },
    {
      id: 'page-cap',
      title: 'Caps the page size at 100',
      detail:
        '`page_size` is an integer from 1 to 100; the draft accepts `page_size=10000`, so one request can pull the whole catalog out of the index.',
      match: {
        python: {all: [/MAX_PAGE_SIZE/, /page_size/]},
        typescript: {all: [/MAX_PAGE_SIZE/, /pageSize/]},
        go: {all: [/maxPageSize/, /pageSize/]},
        scala: {all: [/MaxPageSize/, /pageSize/]},
        cpp: {all: [/kMaxPageSize/, /page_size/]},
      },
    },
    {
      id: 'filter-allowlist',
      title: 'Rejects unknown filter fields with the allowed set',
      detail:
        'Filter keys are checked against the per-tenant allowlist; an unknown field is **400** and the message names the field and the allowed set. The draft passes the filter string through, so any index field is addressable.',
      match: {
        python: {all: [/ALLOWED_FILTER_FIELDS/, /status_code\s*=\s*400/, /unknown filter/]},
        typescript: {all: [/ALLOWED_FILTER_FIELDS/, /code\(\s*400\s*\)/, /unknown filter/]},
        go: {all: [/allowedFilterFields/, /StatusBadRequest/, /unknown filter/]},
        scala: {all: [/AllowedFilterFields/, /StatusCodes\.BadRequest/, /unknown filter/]},
        cpp: {all: [/kAllowedFilterFields/, /\b400\b/, /unknown filter/]},
      },
    },
    {
      id: 'engine-scoping',
      title: 'Builds the engine query from validated fields, tenant-scoped',
      detail:
        "The engine query is assembled by `buildEngineQuery` from the validated filter fields and the tenant, never from the caller's raw filter string. The draft interpolates the string, so a filter can address a field outside the tenant's catalog.",
      match: {
        python: {all: [/def build_engine_query\(/, /tenant/]},
        typescript: {all: [/function buildEngineQuery\(/, /tenant/]},
        go: {all: [/func buildEngineQuery\(/, /tenant/]},
        scala: {all: [/def buildEngineQuery\(/, /tenant/]},
        cpp: {all: [/buildEngineQuery\(/, /tenant/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from fastapi import FastAPI, Header, Query
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("search")


class QueryEngine:
    def search(self, q: str, filters: str, size: int) -> list[dict]:
        """Run a query against the index."""
        raise NotImplementedError


engine = QueryEngine()


@app.get("/v1/search")
def search(
    q: str = Query(default=""),
    filters: str = Query(default="{}"),
    page_size: int = Query(default=10),
    tenant: str = Header(default="", alias="X-Tenant-Id"),
) -> JSONResponse:
    # TODO: this draft forwards the caller's filter string straight to the engine, caps neither the
    # query nor the page size, and lets a filter name any index field. Review all four.
    parsed = json.loads(filters)
    results = engine.search(q, parsed, page_size)
    logger.info("search tenant=%s q=%r filters=%r", tenant, q, filters)
    return JSONResponse({"results": results, "page_size": page_size}, status_code=200)
`,
      solution: `import json
import logging

from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("search")

MAX_QUERY_BYTES = 1 << 8
MAX_PAGE_SIZE = 100
ALLOWED_FILTER_FIELDS = {"brand", "category", "in_stock", "min_price", "max_price"}


class QueryEngine:
    def search(self, query: dict) -> list[dict]:
        """Run the validated query against the index."""
        raise NotImplementedError


engine = QueryEngine()


def build_engine_query(q: str, tenant: str, filters: dict, page_size: int) -> dict:
    """Assemble the engine query from validated fields only, scoped to the tenant's catalog."""
    return {"q": q, "tenant": tenant, "filters": filters, "page_size": page_size}


@app.get("/v1/search")
def search(
    q: str = Query(default=""),
    filters: str = Query(default="{}"),
    page_size: int = Query(default=10),
    tenant: str = Header(default="", alias="X-Tenant-Id"),
) -> JSONResponse:
    if tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if q == "":
        raise HTTPException(status_code=400, detail="q must be a non-empty string")
    if len(q.encode("utf-8")) > MAX_QUERY_BYTES:
        raise HTTPException(status_code=400, detail="q exceeds 256 bytes")
    if page_size < 1 or page_size > MAX_PAGE_SIZE:
        raise HTTPException(status_code=400, detail="page_size must be 1..100")

    try:
        requested = json.loads(filters)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="filters must be a JSON object")
    if not isinstance(requested, dict):
        raise HTTPException(status_code=400, detail="filters must be a JSON object")

    unknown = [f for f in requested if f not in ALLOWED_FILTER_FIELDS]
    if unknown:
        raise HTTPException(
            status_code=400,
            detail=f"unknown filter field '{unknown[0]}'; allowed: {sorted(ALLOWED_FILTER_FIELDS)}",
        )
    validated = {f: requested[f] for f in ALLOWED_FILTER_FIELDS if f in requested}

    query = build_engine_query(q, tenant, validated, page_size)
    logger.info("search tenant=%s page_size=%d filters=%s", tenant, page_size, sorted(validated))
    page = engine.search(query)
    return JSONResponse({"results": page, "page_size": page_size, "tenant": tenant}, status_code=200)
`,
    },
    typescript: {
      starter: `/** GET /v1/search: a model-generated draft that hands the filter string to the engine. */
import Fastify from 'fastify';

export const app = Fastify();

const engine = {
  search: async (q: string, filters: Record<string, unknown>, size: number): Promise<unknown[]> => {
    void q;
    void filters;
    void size;
    return [];
  },
};

app.get('/v1/search', async (request, reply) => {
  // TODO: this draft forwards the caller's filter string straight to the engine, caps neither the
  // query nor the page size, and lets a filter name any index field. Review all four.
  const {q = '', filters = '{}', page_size = '10'} = request.query as Record<string, string>;
  const tenant = request.headers['x-tenant-id'] as string;
  const results = await engine.search(q, JSON.parse(filters), Number(page_size));
  request.log.info({tenant, q, filters}, 'searched');
  return reply.code(200).send({results, page_size: Number(page_size)});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/search: a bounded query DSL with an allowlisted filter surface. */
import {createHash} from 'node:crypto';

import Fastify from 'fastify';

export const app = Fastify();

const MAX_QUERY_BYTES = 1 << 8;
const MAX_PAGE_SIZE = 100;
const ALLOWED_FILTER_FIELDS: Record<string, true> = {
  brand: true,
  category: true,
  in_stock: true,
  min_price: true,
  max_price: true,
};

const engine = {
  search: async (query: EngineQuery): Promise<unknown[]> => {
    void query;
    return [];
  },
};

interface EngineQuery {
  q: string;
  tenant: string;
  filters: Record<string, unknown>;
  page_size: number;
}

function buildEngineQuery(q: string, tenant: string, filters: Record<string, unknown>, pageSize: number): EngineQuery {
  return {q, tenant, filters, page_size: pageSize};
}

app.get('/v1/search', async (request, reply) => {
  const {q = '', filters = '{}', page_size = '10'} = request.query as Record<string, string>;
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  if (q === '') return reply.code(400).send({error: 'q must be a non-empty string'});
  if (Buffer.byteLength(q, 'utf8') > MAX_QUERY_BYTES) return reply.code(400).send({error: 'q exceeds 256 bytes'});
  const pageSize = Number(page_size);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE)
    return reply.code(400).send({error: 'page_size must be 1..100'});

  let requested: unknown;
  try {
    requested = JSON.parse(filters);
  } catch {
    return reply.code(400).send({error: 'filters must be a JSON object'});
  }
  if (typeof requested !== 'object' || requested === null || Array.isArray(requested))
    return reply.code(400).send({error: 'filters must be a JSON object'});

  const given = requested as Record<string, unknown>;
  const unknown = Object.keys(given).filter(field => ALLOWED_FILTER_FIELDS[field] !== true);
  if (unknown.length > 0)
    return reply.code(400).send({error: \`unknown filter field '\${unknown[0]}'; allowed: \${Object.keys(ALLOWED_FILTER_FIELDS).sort()}\`});
  const validated: Record<string, unknown> = {};
  for (const field of Object.keys(ALLOWED_FILTER_FIELDS)) if (field in given) validated[field] = given[field];

  const query = buildEngineQuery(q, tenant, validated, pageSize);
  request.log.info({tenant, page_size: pageSize, filters: Object.keys(validated)}, 'searched');
  const results = await engine.search(query);
  return reply.code(200).send({results, page_size: pageSize, tenant});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func engineSearch(q, filters string, size int) []any {
	return nil
}

func search(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	q := r.URL.Query().Get("q")
	filters := r.URL.Query().Get("filters")
	pageSize, _ := strconv.Atoi(r.URL.Query().Get("page_size"))
	// TODO: this draft forwards the caller's filter string straight to the engine, caps neither the
	// query nor the page size, and lets a filter name any index field. Review all four.
	results := engineSearch(q, filters, pageSize)
	log.Printf("search tenant=%s q=%q filters=%q", tenant, q, filters)
	writeJSON(rw, http.StatusOK, map[string]any{"results": results, "page_size": pageSize})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/search", search)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution:
        `package main

import (
	"encoding/json"
	"log"
	"net/http"
	"sort"
	"strconv"
	"strings"
)

const (
	maxQueryBytes = 1 << 8
	maxPageSize   = 100
)

var allowedFilterFields = map[string]bool{
	"brand":     true,
	"category":  true,
	"in_stock":  true,
	"min_price": true,
	"max_price": true,
}

type engineQuery struct {
	Q        string         ` +
        '`json:"q"`' +
        `
	Tenant   string         ` +
        '`json:"tenant"`' +
        `
	Filters  map[string]any ` +
        '`json:"filters"`' +
        `
	PageSize int            ` +
        '`json:"page_size"`' +
        `
}

func allowedFields() []string {
	fields := make([]string, 0, len(allowedFilterFields))
	for field := range allowedFilterFields {
		fields = append(fields, field)
	}
	sort.Strings(fields)
	return fields
}

func buildEngineQuery(q, tenant string, filters map[string]any, pageSize int) engineQuery {
	return engineQuery{Q: q, Tenant: tenant, Filters: filters, PageSize: pageSize}
}

func engineSearch(query engineQuery) []any {
	return nil
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func search(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	q := r.URL.Query().Get("q")
	if q == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "q must be a non-empty string"})
		return
	}
	if len([]byte(q)) > maxQueryBytes {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "q exceeds 256 bytes"})
		return
	}
	pageSize, err := strconv.Atoi(r.URL.Query().Get("page_size"))
	if err != nil {
		pageSize = 10
	}
	if pageSize < 1 || pageSize > maxPageSize {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "page_size must be 1..100"})
		return
	}
	var requested map[string]any
	if err := json.Unmarshal([]byte(r.URL.Query().Get("filters")), &requested); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "filters must be a JSON object"})
		return
	}
	for field := range requested {
		if !allowedFilterFields[field] {
			writeJSON(rw, http.StatusBadRequest, map[string]string{
				"error": "unknown filter field '" + field + "'; allowed: " + strings.Join(allowedFields(), ", "),
			})
			return
		}
	}
	validated := make(map[string]any)
	for field := range allowedFilterFields {
		if value, ok := requested[field]; ok {
			validated[field] = value
		}
	}
	query := buildEngineQuery(q, tenant, validated, pageSize)
	log.Printf("search tenant=%s page_size=%d filters=%v", tenant, pageSize, allowedFields())
	results := engineSearch(query)
	writeJSON(rw, http.StatusOK, map[string]any{"results": results, "page_size": pageSize, "tenant": tenant})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/search", search)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

object SearchApi {
  implicit val system: ActorSystem = ActorSystem("product-search")

  def engineSearch(q: String, filters: String, size: Int): Seq[String] = Seq.empty

  val route: Route =
    path("v1" / "search") {
      get {
        parameters("q".?, "filters".?, "page_size".as[Int].?) { (qOpt, filtersOpt, sizeOpt) =>
          headerValueByName("X-Tenant-Id") { tenant =>
            // TODO: this draft forwards the caller's filter string straight to the engine, caps
            // neither the query nor the page size, and lets a filter name any index field.
            val q = qOpt.getOrElse("")
            val filters = filtersOpt.getOrElse("{}")
            val pageSize = sizeOpt.getOrElse(10)
            val results = engineSearch(q, filters, pageSize)
            system.log.info(s"search tenant=$tenant q=$q filters=$filters")
            complete(StatusCodes.OK, s"""{"results":[],"page_size":$pageSize}""")
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.nio.charset.StandardCharsets

import scala.util.Try
import scala.util.control.NonFatal

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json._

object SearchApi {
  implicit val system: ActorSystem = ActorSystem("product-search")

  val MaxQueryBytes = 1 << 8
  val MaxPageSize = 100
  val AllowedFilterFields = Set("brand", "category", "in_stock", "min_price", "max_price")

  final case class EngineQuery(q: String, tenant: String, filters: Map[String, JsValue], pageSize: Int)

  def buildEngineQuery(q: String, tenant: String, filters: Map[String, JsValue], pageSize: Int): EngineQuery =
    EngineQuery(q, tenant, filters, pageSize)

  def engineSearch(query: EngineQuery): Seq[String] = Seq.empty

  val route: Route =
    path("v1" / "search") {
      get {
        parameters("q".?, "filters".?, "page_size".as[Int].?) { (qOpt, filtersOpt, sizeOpt) =>
          headerValueByName("X-Tenant-Id") { tenant =>
            val q = qOpt.getOrElse("")
            val pageSize = sizeOpt.getOrElse(10)
            if (q.isEmpty) {
              complete(StatusCodes.BadRequest, s"""{"error":"q must be a non-empty string"}""")
            } else if (q.getBytes(StandardCharsets.UTF_8).length > MaxQueryBytes) {
              complete(StatusCodes.BadRequest, s"""{"error":"q exceeds 256 bytes"}""")
            } else if (pageSize < 1 || pageSize > MaxPageSize) {
              complete(StatusCodes.BadRequest, s"""{"error":"page_size must be 1..100"}""")
            } else {
              Try(filtersOpt.getOrElse("{}").parseJson.asJsObject) match {
                case scala.util.Failure(_) =>
                  complete(StatusCodes.BadRequest, s"""{"error":"filters must be a JSON object"}""")
                case scala.util.Success(requested) =>
                  val fields = requested.fields.keySet
                  val unknown = fields.diff(AllowedFilterFields)
                  if (unknown.nonEmpty) {
                    complete(
                      StatusCodes.BadRequest,
                      s"""{"error":"unknown filter field '\${unknown.head}'; allowed: \${AllowedFilterFields.toList.sorted.mkString(", ")}"}""",
                    )
                  } else {
                    val validated = requested.fields.filter { case (field, _) => AllowedFilterFields.contains(field) }
                    val query = buildEngineQuery(q, tenant, validated, pageSize)
                    system.log.info(s"search tenant=$tenant page_size=$pageSize filters=\${validated.keySet.toList.sorted}")
                    val results = engineSearch(query)
                    complete(StatusCodes.OK, s"""{"results":[],"page_size":$pageSize}""")
                  }
              }
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

#include <iostream>
#include <string>

using json = nlohmann::json;

std::vector<std::string> engineSearch(const std::string& q, const std::string& filters, int size) {
  (void)q;
  (void)filters;
  (void)size;
  return {};
}

int main() {
  httplib::Server svr;

  svr.Get("/v1/search", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    const auto q = req.get_param_value("q");
    const auto filters = req.get_param_value("filters");
    const int pageSize = req.has_param("page_size") ? std::stoi(req.get_param_value("page_size")) : 10;
    // TODO: this draft forwards the caller's filter string straight to the engine, caps neither the
    // query nor the page size, and lets a filter name any index field. Review all four.
    const auto results = engineSearch(q, filters, pageSize);
    std::cerr << "search tenant=" << tenant << " q=" << q << " filters=" << filters << "\\n";
    res.status = 200;
    res.set_content(json{{"results", results}, {"page_size", pageSize}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <iostream>
#include <set>
#include <string>

using json = nlohmann::json;

constexpr std::size_t kMaxQueryBytes = 1 << 8;
constexpr int kMaxPageSize = 100;
const std::set<std::string> kAllowedFilterFields = {"brand", "category", "in_stock", "min_price", "max_price"};

struct EngineQuery {
  std::string q;
  std::string tenant;
  json filters;
  int page_size;
};

EngineQuery buildEngineQuery(const std::string& q, const std::string& tenant, const json& filters, int pageSize) {
  return EngineQuery{q, tenant, filters, pageSize};
}

std::vector<std::string> engineSearch(const EngineQuery& query) {
  (void)query;
  return {};
}

std::string allowedFields() {
  std::string out;
  for (const auto& field : kAllowedFilterFields) {
    if (!out.empty()) out += ", ";
    out += field;
  }
  return out;
}

int main() {
  httplib::Server svr;

  svr.Get("/v1/search", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto q = req.get_param_value("q");
    if (q.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"q must be a non-empty string"})", "application/json");
      return;
    }
    if (q.size() > kMaxQueryBytes) {
      res.status = 400;
      res.set_content(R"({"error":"q exceeds 256 bytes"})", "application/json");
      return;
    }
    const int pageSize = req.has_param("page_size") ? std::stoi(req.get_param_value("page_size")) : 10;
    if (pageSize < 1 || pageSize > kMaxPageSize) {
      res.status = 400;
      res.set_content(R"({"error":"page_size must be 1..100"})", "application/json");
      return;
    }
    const json requested = json::parse(req.get_param_value("filters"), nullptr, false);
    if (!requested.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"filters must be a JSON object"})", "application/json");
      return;
    }
    for (const auto& [field, value] : requested.items()) {
      if (kAllowedFilterFields.count(field) == 0) {
        res.status = 400;
        res.set_content(
            json{{"error", "unknown filter field '" + field + "'; allowed: " + allowedFields()}}.dump(),
            "application/json");
        return;
      }
    }
    json validated = json::object();
    for (const auto& field : kAllowedFilterFields)
      if (requested.contains(field)) validated[field] = requested[field];
    const auto query = buildEngineQuery(q, tenant, validated, pageSize);
    std::cerr << "search tenant=" << tenant << " page_size=" << pageSize << " filters=" << validated.size() << "\\n";
    const auto results = engineSearch(query);
    res.status = 200;
    res.set_content(json{{"results", results}, {"page_size", pageSize}, {"tenant", tenant}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Validate in cost order, all of it before the engine call: tenant, non-empty `q`, byte length, page range, then the filter object. A rejection that happens before the index is touched cannot burn index capacity.',
    "The allowlist is the whole point: collect the requested keys, diff them against the allowed set, and on a difference return `400` naming the field and listing the allowed set. Only then copy the surviving keys into a fresh object — never pass the caller's object through.",
    'Build the engine query in one helper that takes the validated fields and the tenant. If the raw filter text is never a parameter of that helper, an injection has nowhere to live; the check looks for exactly that helper.',
  ],
  debrief: `The interviewer is testing whether you can review a generated handler at the trust boundary. The draft reads fine because the demo sends a well-formed query with no filters and a small page. Four defects are being checked: the byte cap on the text query (cheap rejection before the index pays for it), the page cap (8000 results is not a page), the per-tenant filter allowlist (a crafted key must not address a field the tenant cannot see), and the assembly of the engine query from validated values only. The allowlist and the query-assembly helper are two halves of one idea: the caller supplies data, the server decides which fields exist. Real search services add typed filter values (a price is a number, a range is two numbers), per-tenant field visibility driven by the catalog, and a query-language version so old clients cannot smuggle retired fields.`,
};
