import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'GET /v1/search: caps and a filter allowlist in front of the engine',
  concept: 'http',
  guides: ['request-boundaries'],
  file: 'api',
  focus: ['client', 'api', 'catalog'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/search\` on the catalog index (\`search.catalog\`,
provided): it reads \`X-Tenant-Id\` (401 when missing), \`q\`, \`page_size\` (default 20) and
\`filters\`, a JSON object of strings, and answers \`{results, page_size}\` from
\`run_query(tenant, q, filters, page_size)\`. It serves the demo and hides four flaws.

**Failure mode the checks target.** A 10 KB query or \`page_size=10000\` goes straight to the engine;
a filter on \`cost_cents\`, a field the index stores for merchandising but shoppers must not see,
tells a shopper which product costs what; a malformed \`filters\` crashes the handler.

- \`q\` is 1 to \`MAX_QUERY_BYTES\` = 256 bytes of UTF-8 (bytes, not characters); a blank or longer
  one is **400**.
- \`page_size\` is an integer from 1 to \`MAX_PAGE_SIZE\` = 100; anything else is **400**.
- \`filters\` parses as a JSON object whose values are strings; anything else is **400**.
- Filter fields are checked against \`ALLOWED_FILTER_FIELDS\`: \`brand\`, \`category\`, \`in_stock\`,
  \`min_price\`, \`max_price\`. An unknown one is **400** with a body that names it and carries the
  \`allowed\` list.`,
  sequence: {
    participants: ['Storefront', 'searchd', 'Catalog index'],
    messages: [
      {
        from: 'Storefront',
        to: 'searchd',
        label: 'GET /v1/search · X-Tenant-Id · q · filters · page_size',
        kind: 'sync',
      },
      {
        from: 'searchd',
        to: 'searchd',
        label: 'q ≤ 256 bytes · 1 ≤ page_size ≤ 100 · filters ⊆ allowlist',
        kind: 'sync',
      },
      {from: 'searchd', to: 'Catalog index', label: 'run_query(tenant, q, filters, page_size)', kind: 'sync'},
      {from: 'Catalog index', to: 'searchd', label: 'public views, cheapest first', kind: 'reply'},
      {from: 'searchd', to: 'Storefront', label: '200 {results, page_size} · or 400 {error, allowed}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/search for the caller’s tenant',
      detail: 'Register `GET /v1/search` and answer the tenant’s matching products, cheapest first.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/search["']/, /run_query\(/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/search['"]/, /runQuery\(/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/search"/, /catalog\.RunQuery\(/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"search"\s*\)/, /Catalog\.runQuery\(/]},
        cpp: {all: [/svr\.Get\(\s*"\/v1\/search"/, /catalog::runQuery\(/]},
      },
    },
    {
      id: 'query-cap',
      title: 'Caps q at 256 bytes and refuses a blank one',
      detail:
        '`q` is measured in UTF-8 bytes against `MAX_QUERY_BYTES` = 256, and a blank `q` (which matches the whole catalog) is refused; both answer **400**.',
      match: {
        python: {all: [/MAX_QUERY_BYTES\s*=\s*256/, /len\(\s*q\.encode\(/]},
        typescript: {
          all: [/MAX_QUERY_BYTES\s*=\s*256/, /TextEncoder\(\)\.encode\(\s*q\s*\)\.length|Buffer\.byteLength\(\s*q/],
        },
        go: {all: [/maxQueryBytes\s*=\s*256/, /len\(\s*(\[\]byte\()?q\)?\s*\)\s*>\s*maxQueryBytes/]},
        scala: {all: [/MaxQueryBytes\s*=\s*256/, /getBytes\(\s*"UTF-8"\s*\)\.length\s*>\s*MaxQueryBytes/]},
        cpp: {all: [/kMaxQueryBytes\s*=\s*256/, /q\.size\(\)\s*>\s*kMaxQueryBytes/]},
      },
    },
    {
      id: 'page-cap',
      title: 'Caps page_size at 100',
      detail:
        '`page_size` must be an integer from 1 to `MAX_PAGE_SIZE` = 100; the starter forwards `page_size=10000`, so one request reads a whole catalog.',
      match: {
        python: {all: [/MAX_PAGE_SIZE\s*=\s*100/, /page_size\s*(<=|>)\s*MAX_PAGE_SIZE/]},
        typescript: {all: [/MAX_PAGE_SIZE\s*=\s*100/, /pageSize\s*>\s*MAX_PAGE_SIZE/]},
        go: {all: [/maxPageSize\s*=\s*100/, /pageSize\s*>\s*maxPageSize/]},
        scala: {all: [/MaxPageSize\s*=\s*100/, /(size|pageSize)\s*>\s*MaxPageSize|1 to MaxPageSize/]},
        cpp: {all: [/kMaxPageSize\s*=\s*100/, /page_size\s*>\s*kMaxPageSize/]},
      },
    },
    {
      id: 'filter-allowlist',
      title: 'Refuses filter fields outside the allowlist',
      detail:
        'Every filter field is checked against `ALLOWED_FILTER_FIELDS`; an unknown one is **400** naming the field with the `allowed` list. The engine filters on any stored field, `cost_cents` included.',
      match: {
        python: {
          all: [
            /ALLOWED_FILTER_FIELDS\s*=/,
            /not in ALLOWED_FILTER_FIELDS|-\s*set\(\s*ALLOWED_FILTER_FIELDS/,
            /allowed/,
          ],
        },
        typescript: {all: [/ALLOWED_FILTER_FIELDS\s*=/, /ALLOWED_FILTER_FIELDS\.(includes|has)\(/, /allowed:/]},
        go: {all: [/allowedFilterFields\s*=/, /range allowedFilterFields|allowedFilterFields\[/, /"allowed"/]},
        cpp: {all: [/kAllowedFilterFields\s*=/, /kAllowedFilterFields\.(begin|end|count)\(/, /"allowed"/]},
        scala: {all: [/AllowedFilterFields(:[^=\n]*)?\s*=/, /AllowedFilterFields\.contains\(/, /"allowed"/]},
      },
    },
    {
      id: 'filter-shape',
      title: 'A malformed filters value is 400, not a crash',
      detail:
        '`filters` must parse as a JSON object of strings; malformed JSON, an array, or a non-string value answers **400**. The starter parses without a guard, so bad input surfaces as a 500 or as an empty page.',
      match: {
        python: {
          all: [
            /except\s+(json\.)?(JSONDecodeError|ValueError)/,
            /isinstance\(\s*\w+,\s*dict\s*\)/,
            /isinstance\(\s*\w+,\s*str\s*\)/,
          ],
        },
        typescript: {all: [/catch\s*(\(\w*\))?\s*\{/, /Array\.isArray\(/, /typeof \w+ === 'string'/]},
        go: {all: [/if err := json\.Unmarshal\(/]},
        scala: {all: [/Try\(|catch\s*\{/, /JsString\(/]},
        cpp: {all: [/json::parse\([^\n]*,\s*nullptr,\s*false\)/, /is_object\(\)/, /is_string\(\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from search import catalog  # catalog.run_query(tenant, q, filters, page_size) -> list of public views

app = FastAPI()

DEFAULT_PAGE_SIZE = 20


@app.get("/v1/search")
def search(request: Request) -> JSONResponse:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        return JSONResponse({"error": "missing X-Tenant-Id"}, status_code=401)
    q = request.query_params.get("q", "")
    page_size = int(request.query_params.get("page_size", DEFAULT_PAGE_SIZE))
    filters = json.loads(request.query_params.get("filters", "{}"))
    results = catalog.run_query(tenant, q, filters, page_size)
    return JSONResponse({"results": results, "page_size": page_size})
`,
      solution: `import json

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from search import catalog  # catalog.run_query(tenant, q, filters, page_size) -> list of public views

app = FastAPI()

DEFAULT_PAGE_SIZE = 20
MAX_QUERY_BYTES = 256
MAX_PAGE_SIZE = 100
# What a shopper may filter on: the engine filters on any stored field, cost_cents included.
ALLOWED_FILTER_FIELDS = ("brand", "category", "in_stock", "min_price", "max_price")


def bad_request(error: str, **extra) -> JSONResponse:
    return JSONResponse({"error": error, **extra}, status_code=400)


@app.get("/v1/search")
def search(request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        return JSONResponse({"error": "missing X-Tenant-Id"}, status_code=401)
    q = request.query_params.get("q", "")
    if not q.strip() or len(q.encode("utf-8")) > MAX_QUERY_BYTES:
        return bad_request(f"q must be 1 to {MAX_QUERY_BYTES} bytes of UTF-8")
    try:
        page_size = int(request.query_params.get("page_size", DEFAULT_PAGE_SIZE))
    except ValueError:
        page_size = 0
    if not 1 <= page_size <= MAX_PAGE_SIZE:
        return bad_request(f"page_size must be an integer from 1 to {MAX_PAGE_SIZE}")
    try:
        filters = json.loads(request.query_params.get("filters", "{}"))
    except json.JSONDecodeError:
        filters = None
    if not isinstance(filters, dict) or not all(isinstance(value, str) for value in filters.values()):
        return bad_request("filters must be a JSON object of strings")
    unknown = [field for field in filters if field not in ALLOWED_FILTER_FIELDS]
    if unknown:
        return bad_request(f"unknown filter field {unknown[0]}", allowed=list(ALLOWED_FILTER_FIELDS))
    results = catalog.run_query(tenant, q, filters, page_size)
    return JSONResponse({"results": results, "page_size": page_size})
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {runQuery} from 'search/catalog'; // runQuery(tenant, q, filters, pageSize): Promise<Hit[]>

export const app = Fastify();

const DEFAULT_PAGE_SIZE = 20;

app.get('/v1/search', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const query = request.query as Record<string, string | undefined>;
  const q = query.q ?? '';
  const pageSize = Number(query.page_size ?? DEFAULT_PAGE_SIZE);
  const filters = JSON.parse(query.filters ?? '{}') as Record<string, string>;
  const results = await runQuery(tenant, q, filters, pageSize);
  return {results, page_size: pageSize};
});
`,
      solution: `import Fastify from 'fastify';

import {runQuery} from 'search/catalog'; // runQuery(tenant, q, filters, pageSize): Promise<Hit[]>

export const app = Fastify();

const DEFAULT_PAGE_SIZE = 20;
const MAX_QUERY_BYTES = 256;
const MAX_PAGE_SIZE = 100;
// What a shopper may filter on: the engine filters on any stored field, cost_cents included.
const ALLOWED_FILTER_FIELDS = ['brand', 'category', 'in_stock', 'min_price', 'max_price'];

app.get('/v1/search', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const query = request.query as Record<string, string | undefined>;
  const q = query.q ?? '';
  if (q.trim() === '' || new TextEncoder().encode(q).length > MAX_QUERY_BYTES)
    return reply.code(400).send({error: \`q must be 1 to \${MAX_QUERY_BYTES} bytes of UTF-8\`});
  const pageSize = Number(query.page_size ?? DEFAULT_PAGE_SIZE);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE)
    return reply.code(400).send({error: \`page_size must be an integer from 1 to \${MAX_PAGE_SIZE}\`});
  let filters: unknown;
  try {
    filters = JSON.parse(query.filters ?? '{}');
  } catch {
    filters = null;
  }
  if (typeof filters !== 'object' || filters === null || Array.isArray(filters) || !Object.values(filters).every(value => typeof value === 'string'))
    return reply.code(400).send({error: 'filters must be a JSON object of strings'});
  const unknown = Object.keys(filters).filter(field => !ALLOWED_FILTER_FIELDS.includes(field));
  if (unknown.length > 0) return reply.code(400).send({error: \`unknown filter field \${unknown[0]}\`, allowed: ALLOWED_FILTER_FIELDS});
  const results = await runQuery(tenant, q, filters as Record<string, string>, pageSize);
  return {results, page_size: pageSize};
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
	"strconv"

	"search/catalog" // catalog.RunQuery(ctx, tenant, q, filters, pageSize) []catalog.Hit
)

const defaultPageSize = 20

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func search(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	params := r.URL.Query()
	q := params.Get("q")
	pageSize := defaultPageSize
	if raw := params.Get("page_size"); raw != "" {
		pageSize, _ = strconv.Atoi(raw)
	}
	filters := map[string]string{}
	json.Unmarshal([]byte(params.Get("filters")), &filters)
	results := catalog.RunQuery(r.Context(), tenant, q, filters, pageSize)
	writeJSON(rw, http.StatusOK, map[string]any{"results": results, "page_size": pageSize})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/search", search)
}
`,
      solution: `package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"search/catalog" // catalog.RunQuery(ctx, tenant, q, filters, pageSize) []catalog.Hit
)

const (
	defaultPageSize = 20
	maxQueryBytes   = 256
	maxPageSize     = 100
)

// What a shopper may filter on: the engine filters on any stored field, cost_cents included.
var allowedFilterFields = []string{"brand", "category", "in_stock", "min_price", "max_price"}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func badRequest(rw http.ResponseWriter, body map[string]any) {
	writeJSON(rw, http.StatusBadRequest, body)
}

func allowed(field string) bool {
	for _, name := range allowedFilterFields {
		if name == field {
			return true
		}
	}
	return false
}

func search(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	params := r.URL.Query()
	q := params.Get("q")
	if strings.TrimSpace(q) == "" || len(q) > maxQueryBytes {
		badRequest(rw, map[string]any{"error": fmt.Sprintf("q must be 1 to %d bytes of UTF-8", maxQueryBytes)})
		return
	}
	pageSize := defaultPageSize
	if raw := params.Get("page_size"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil {
			n = 0
		}
		pageSize = n
	}
	if pageSize < 1 || pageSize > maxPageSize {
		badRequest(rw, map[string]any{"error": fmt.Sprintf("page_size must be an integer from 1 to %d", maxPageSize)})
		return
	}
	filters := map[string]string{}
	if raw := params.Get("filters"); raw != "" {
		if err := json.Unmarshal([]byte(raw), &filters); err != nil {
			badRequest(rw, map[string]any{"error": "filters must be a JSON object of strings"})
			return
		}
	}
	for field := range filters {
		if !allowed(field) {
			badRequest(rw, map[string]any{"error": "unknown filter field " + field, "allowed": allowedFilterFields})
			return
		}
	}
	results := catalog.RunQuery(r.Context(), tenant, q, filters, pageSize)
	writeJSON(rw, http.StatusOK, map[string]any{"results": results, "page_size": pageSize})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/search", search)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import search.Catalog // Catalog.runQuery(tenant, q, filters, pageSize): Seq[JsObject]

object SearchApi {
  val DefaultPageSize = 20

  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  val route: Route = path("v1" / "search") {
    get {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(json(StatusCodes.Unauthorized, JsObject("error" -> JsString("missing X-Tenant-Id"))))
        case Some(tenant) =>
          parameters("q".optional, "page_size".optional, "filters".optional) { (q, pageSize, filters) =>
            // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
            val size = pageSize.map(_.toInt).getOrElse(DefaultPageSize)
            val requested = filters.getOrElse("{}").parseJson.asJsObject.fields.map { case (field, value) => field -> value.toString }
            val results = Catalog.runQuery(tenant, q.getOrElse(""), requested, size)
            complete(json(StatusCodes.OK, JsObject("results" -> JsArray(results.toVector), "page_size" -> JsNumber(size))))
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

import scala.util.Try

import search.Catalog // Catalog.runQuery(tenant, q, filters, pageSize): Seq[JsObject]

object SearchApi {
  val DefaultPageSize = 20
  val MaxQueryBytes = 256
  val MaxPageSize = 100
  // What a shopper may filter on: the engine filters on any stored field, cost_cents included.
  val AllowedFilterFields: Seq[String] = Seq("brand", "category", "in_stock", "min_price", "max_price")

  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def badRequest(error: String, extra: (String, JsValue)*): HttpResponse =
    json(StatusCodes.BadRequest, JsObject((("error" -> JsString(error)) +: extra).toMap))

  /** The filters as field → text, or None unless the value is a JSON object of strings. */
  private def parseFilters(raw: String): Option[Map[String, String]] =
    Try(raw.parseJson).toOption.collect { case JsObject(fields) => fields }.flatMap { fields =>
      val strings = fields.collect { case (field, JsString(value)) => field -> value }
      if (strings.size == fields.size) Some(strings) else None
    }

  val route: Route = path("v1" / "search") {
    get {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(json(StatusCodes.Unauthorized, JsObject("error" -> JsString("missing X-Tenant-Id"))))
        case Some(tenant) =>
          parameters("q".optional, "page_size".optional, "filters".optional) { (q, pageSize, filters) =>
            val text = q.getOrElse("")
            val size = pageSize.map(raw => raw.toIntOption.getOrElse(0)).getOrElse(DefaultPageSize)
            if (text.trim.isEmpty || text.getBytes("UTF-8").length > MaxQueryBytes)
              complete(badRequest(s"q must be 1 to $MaxQueryBytes bytes of UTF-8"))
            else if (size < 1 || size > MaxPageSize)
              complete(badRequest(s"page_size must be an integer from 1 to $MaxPageSize"))
            else
              parseFilters(filters.getOrElse("{}")) match {
                case None => complete(badRequest("filters must be a JSON object of strings"))
                case Some(requested) =>
                  requested.keys.find(field => !AllowedFilterFields.contains(field)) match {
                    case Some(field) => complete(badRequest(s"unknown filter field $field", "allowed" -> JsArray(AllowedFilterFields.map(JsString(_)).toVector)))
                    case None =>
                      val results = Catalog.runQuery(tenant, text, requested, size)
                      complete(json(StatusCodes.OK, JsObject("results" -> JsArray(results.toVector), "page_size" -> JsNumber(size))))
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
#include <string>

#include "search/catalog.h"  // catalog::runQuery(tenant, q, filters, page_size) -> JSON array of public views

using json = nlohmann::json;

const int kDefaultPageSize = 20;

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void search(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, {{"error", "missing X-Tenant-Id"}});
  const std::string q = req.get_param_value("q");
  const int page_size = req.has_param("page_size") ? std::stoi(req.get_param_value("page_size")) : kDefaultPageSize;
  const auto filters = json::parse(req.has_param("filters") ? req.get_param_value("filters") : "{}").get<std::map<std::string, std::string>>();
  reply(res, 200, {{"results", catalog::runQuery(tenant, q, filters, page_size)}, {"page_size", page_size}});
}

void register_routes(httplib::Server& svr) { svr.Get("/v1/search", search); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <cctype>
#include <map>
#include <string>
#include <vector>

#include "search/catalog.h"  // catalog::runQuery(tenant, q, filters, page_size) -> JSON array of public views

using json = nlohmann::json;

const int kDefaultPageSize = 20;
const size_t kMaxQueryBytes = 256;
const int kMaxPageSize = 100;
// What a shopper may filter on: the engine filters on any stored field, cost_cents included.
const std::vector<std::string> kAllowedFilterFields = {"brand", "category", "in_stock", "min_price", "max_price"};

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void search(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, {{"error", "missing X-Tenant-Id"}});
  const std::string q = req.get_param_value("q");
  if (q.find_first_not_of(" \\t\\r\\n") == std::string::npos || q.size() > kMaxQueryBytes) {
    return reply(res, 400, {{"error", "q must be 1 to 256 bytes of UTF-8"}});
  }
  int page_size = kDefaultPageSize;
  if (req.has_param("page_size")) {
    const std::string raw = req.get_param_value("page_size");
    const bool digits = !raw.empty() && raw.size() <= 6 && std::all_of(raw.begin(), raw.end(), [](unsigned char c) { return std::isdigit(c); });
    page_size = digits ? std::stoi(raw) : 0;
  }
  if (page_size < 1 || page_size > kMaxPageSize) return reply(res, 400, {{"error", "page_size must be an integer from 1 to 100"}});
  const json parsed = json::parse(req.has_param("filters") ? req.get_param_value("filters") : "{}", nullptr, false);
  if (!parsed.is_object()) return reply(res, 400, {{"error", "filters must be a JSON object of strings"}});
  std::map<std::string, std::string> filters;
  for (const auto& item : parsed.items()) {
    if (!item.value().is_string()) return reply(res, 400, {{"error", "filters must be a JSON object of strings"}});
    if (std::find(kAllowedFilterFields.begin(), kAllowedFilterFields.end(), item.key()) == kAllowedFilterFields.end()) {
      return reply(res, 400, {{"error", "unknown filter field " + item.key()}, {"allowed", kAllowedFilterFields}});
    }
    filters[item.key()] = item.value().get<std::string>();
  }
  reply(res, 200, {{"results", catalog::runQuery(tenant, q, filters, page_size)}, {"page_size", page_size}});
}

void register_routes(httplib::Server& svr) { svr.Get("/v1/search", search); }
`,
    },
  },
  harness: {
    python: `from search import catalog

TENANT = "t-1"
PRODUCTS = [
    {"id": "p-1", "title": "Steel Kettle", "brand": "acme", "category": "kitchen", "price_cents": 3499, "in_stock": True, "cost_cents": 1200},
    {"id": "p-2", "title": "Glass Kettle", "brand": "brew", "category": "kitchen", "price_cents": 2999, "in_stock": False, "cost_cents": 900},
    {"id": "p-3", "title": "Kettle Descaler", "brand": "acme", "category": "cleaning", "price_cents": 899, "in_stock": True, "cost_cents": 150},
]
OTHER = {"id": "p-9", "title": "Copper Kettle", "brand": "acme", "category": "kitchen", "price_cents": 5999, "in_stock": True, "cost_cents": 3000}
ALLOWED = ("brand", "category", "in_stock", "min_price", "max_price")


def _api(ctx):
    for product in PRODUCTS:
        catalog.put_product(TENANT, product)
    catalog.put_product("t-2", OTHER)
    return ctx.client(ctx.load("api").app)


async def _search(c, **params):
    try:
        return await c.get("/v1/search", params=params, headers={"X-Tenant-Id": TENANT})
    except Exception as exc:
        raise AssertionError(f"GET /v1/search with {params} crashed the handler ({type(exc).__name__}: {exc}): a bad input must answer 400")


def _ids(r):
    return [hit["id"] for hit in r.json().get("results", [])]


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await _search(c, q="kettle")
    assert r.status_code == 200, f"GET /v1/search?q=kettle answered {r.status_code}: {r.text}"
    assert _ids(r) == ["p-3", "p-2", "p-1"], f"the search answered {_ids(r)}, expected the tenant's three kettles, cheapest first"
    assert r.json().get("page_size") == 20, f"without page_size the response must say 20, got {r.json().get('page_size')!r}"


async def check_query_cap(ctx):
    async with _api(ctx) as c:
        long = "kettle " + "x" * 300
        r = await _search(c, q=long)
        assert r.status_code == 400, f"a {len(long)}-byte query answered {r.status_code}: q is capped at 256 bytes"
        r = await _search(c, q="é" * 129)
        assert r.status_code == 400, f"a query of 129 characters and 258 bytes (é is two bytes in UTF-8) answered {r.status_code}: the cap counts bytes, not characters"
        r = await _search(c, q="é" * 128)
        assert r.status_code == 200, f"a query of exactly 256 bytes answered {r.status_code}: 256 bytes is within the cap"
        r = await _search(c, q="   ")
    assert r.status_code == 400, f"a blank query answered {r.status_code} with {_ids(r) if r.status_code == 200 else r.text}: an empty q matches the whole catalog"


async def check_page_cap(ctx):
    async with _api(ctx) as c:
        for size in ("10000", "101", "0"):
            r = await _search(c, q="kettle", page_size=size)
            assert r.status_code == 400, f"page_size={size} answered {r.status_code}: page_size is an integer from 1 to 100"
        r = await _search(c, q="kettle", page_size="ten")
        assert r.status_code == 400, f"page_size=ten answered {r.status_code}, expected 400"
        r = await _search(c, q="kettle", page_size="1")
        assert r.status_code == 200 and _ids(r) == ["p-3"], f"page_size=1 answered {r.status_code} {r.text}, expected the cheapest kettle"
        r = await _search(c, q="kettle", page_size="100")
    assert r.status_code == 200, f"page_size=100 answered {r.status_code}: 100 is within the cap"


async def check_filter_allowlist(ctx):
    async with _api(ctx) as c:
        r = await _search(c, q="kettle", filters='{"cost_cents": "1200"}')
        assert r.status_code == 400, f"a filter on cost_cents answered {r.status_code} with {_ids(r) if r.status_code == 200 else r.text}: the wholesale cost is one guess away. Check filter fields against ALLOWED_FILTER_FIELDS"
        assert "cost_cents" in r.text, f"the 400 must name the unknown field (cost_cents), got {r.text}"
        allowed = r.json().get("allowed")
        assert isinstance(allowed, list) and sorted(allowed) == sorted(ALLOWED), f"the 400 must carry the allowed list {list(ALLOWED)}, got {allowed!r}"
        r = await _search(c, q="kettle", filters='{"brand": "acme", "max_price": "1000"}')
        assert r.status_code == 200 and _ids(r) == ["p-3"], f"brand=acme and max_price=1000 answered {r.status_code} {r.text}, expected [p-3]"
        r = await _search(c, q="kettle", filters='{"in_stock": "true"}')
    assert r.status_code == 200 and _ids(r) == ["p-3", "p-1"], f"in_stock=true answered {r.status_code} {r.text}, expected [p-3, p-1]"


async def check_filter_shape(ctx):
    async with _api(ctx) as c:
        for raw in ('{"in_stock": true}', '["brand"]', "brand=acme"):
            r = await _search(c, q="kettle", filters=raw)
            assert r.status_code == 400, f"filters={raw} answered {r.status_code}: filters must be a JSON object of strings, anything else is 400"
        r = await _search(c, q="kettle", filters='{"category": "kitchen"}')
    assert r.status_code == 200 and _ids(r) == ["p-2", "p-1"], f"category=kitchen answered {r.status_code} {r.text}, expected [p-2, p-1]"
`,
    typescript: `const TENANT = 't-1';
const PRODUCTS = [
  {id: 'p-1', title: 'Steel Kettle', brand: 'acme', category: 'kitchen', price_cents: 3499, in_stock: true, cost_cents: 1200},
  {id: 'p-2', title: 'Glass Kettle', brand: 'brew', category: 'kitchen', price_cents: 2999, in_stock: false, cost_cents: 900},
  {id: 'p-3', title: 'Kettle Descaler', brand: 'acme', category: 'cleaning', price_cents: 899, in_stock: true, cost_cents: 150},
];
const OTHER = {id: 'p-9', title: 'Copper Kettle', brand: 'acme', category: 'kitchen', price_cents: 5999, in_stock: true, cost_cents: 3000};
const ALLOWED = ['brand', 'category', 'in_stock', 'min_price', 'max_price'];

async function api(ctx) {
  const catalog = ctx.load('/support/search/catalog.ts');
  for (const product of PRODUCTS) await catalog.putProduct(TENANT, product);
  await catalog.putProduct('t-2', OTHER);
  return ctx.client(ctx.load('api').app);
}

async function search(c, query: Record<string, string>) {
  try {
    return await c.get('/v1/search', {query, headers: {'X-Tenant-Id': TENANT}});
  } catch (e) {
    assert.fail(\`GET /v1/search with \${JSON.stringify(query)} crashed the handler (\${(e as Error).message}): a bad input must answer 400\`);
  }
}

function ids(r): string[] {
  try {
    return (r.json().results ?? []).map(hit => hit.id);
  } catch {
    return [];
  }
}

export async function check_route(ctx) {
  const c = await api(ctx);
  const r = await search(c, {q: 'kettle'});
  assert.equal(r.status, 200, \`GET /v1/search?q=kettle answered \${r.status}: \${r.text}\`);
  assert.deepStrictEqual(ids(r), ['p-3', 'p-2', 'p-1'], \`the search answered \${JSON.stringify(ids(r))}, expected the tenant's three kettles, cheapest first\`);
  assert.equal(r.json().page_size, 20, \`without page_size the response must say 20, got \${JSON.stringify(r.json().page_size)}\`);
}

export async function check_query_cap(ctx) {
  const c = await api(ctx);
  const long = 'kettle ' + 'x'.repeat(300);
  let r = await search(c, {q: long});
  assert.equal(r.status, 400, \`a \${long.length}-byte query answered \${r.status}: q is capped at 256 bytes\`);
  r = await search(c, {q: 'é'.repeat(129)});
  assert.equal(r.status, 400, \`a query of 129 characters and 258 bytes (é is two bytes in UTF-8) answered \${r.status}: the cap counts bytes, not characters\`);
  r = await search(c, {q: 'é'.repeat(128)});
  assert.equal(r.status, 200, \`a query of exactly 256 bytes answered \${r.status}: 256 bytes is within the cap\`);
  r = await search(c, {q: '   '});
  assert.equal(r.status, 400, \`a blank query answered \${r.status} with \${r.text}: an empty q matches the whole catalog\`);
}

export async function check_page_cap(ctx) {
  const c = await api(ctx);
  for (const size of ['10000', '101', '0', 'ten']) {
    const r = await search(c, {q: 'kettle', page_size: size});
    assert.equal(r.status, 400, \`page_size=\${size} answered \${r.status}: page_size is an integer from 1 to 100\`);
  }
  let r = await search(c, {q: 'kettle', page_size: '1'});
  assert(r.status === 200 && JSON.stringify(ids(r)) === '["p-3"]', \`page_size=1 answered \${r.status} \${r.text}, expected the cheapest kettle\`);
  r = await search(c, {q: 'kettle', page_size: '100'});
  assert.equal(r.status, 200, \`page_size=100 answered \${r.status}: 100 is within the cap\`);
}

export async function check_filter_allowlist(ctx) {
  const c = await api(ctx);
  let r = await search(c, {q: 'kettle', filters: '{"cost_cents": "1200"}'});
  assert.equal(r.status, 400, \`a filter on cost_cents answered \${r.status} with \${r.text}: the wholesale cost is one guess away. Check filter fields against ALLOWED_FILTER_FIELDS\`);
  assert(r.text.includes('cost_cents'), \`the 400 must name the unknown field (cost_cents), got \${r.text}\`);
  const allowed = r.json().allowed;
  assert(Array.isArray(allowed) && JSON.stringify([...allowed].sort()) === JSON.stringify([...ALLOWED].sort()), \`the 400 must carry the allowed list \${JSON.stringify(ALLOWED)}, got \${JSON.stringify(allowed)}\`);
  r = await search(c, {q: 'kettle', filters: '{"brand": "acme", "max_price": "1000"}'});
  assert(r.status === 200 && JSON.stringify(ids(r)) === '["p-3"]', \`brand=acme and max_price=1000 answered \${r.status} \${r.text}, expected [p-3]\`);
  r = await search(c, {q: 'kettle', filters: '{"in_stock": "true"}'});
  assert(r.status === 200 && JSON.stringify(ids(r)) === '["p-3","p-1"]', \`in_stock=true answered \${r.status} \${r.text}, expected [p-3, p-1]\`);
}

export async function check_filter_shape(ctx) {
  const c = await api(ctx);
  for (const raw of ['{"in_stock": true}', '["brand"]', 'brand=acme']) {
    const r = await search(c, {q: 'kettle', filters: raw});
    assert.equal(r.status, 400, \`filters=\${raw} answered \${r.status}: filters must be a JSON object of strings, anything else is 400\`);
  }
  const r = await search(c, {q: 'kettle', filters: '{"category": "kitchen"}'});
  assert(r.status === 200 && JSON.stringify(ids(r)) === '["p-2","p-1"]', \`category=kitchen answered \${r.status} \${r.text}, expected [p-2, p-1]\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"net/url"
	"sort"
	"strings"

	"search/catalog"

	"leetbuild/harness"
)

const apiTenant = "t-1"

var (
	apiProducts = []catalog.Product{
		{ID: "p-1", Title: "Steel Kettle", Brand: "acme", Category: "kitchen", PriceCents: 3499, InStock: true, CostCents: 1200},
		{ID: "p-2", Title: "Glass Kettle", Brand: "brew", Category: "kitchen", PriceCents: 2999, InStock: false, CostCents: 900},
		{ID: "p-3", Title: "Kettle Descaler", Brand: "acme", Category: "cleaning", PriceCents: 899, InStock: true, CostCents: 150},
	}
	apiOther   = catalog.Product{ID: "p-9", Title: "Copper Kettle", Brand: "acme", Category: "kitchen", PriceCents: 5999, InStock: true, CostCents: 3000}
	apiAllowed = []string{"brand", "category", "in_stock", "max_price", "min_price"}
)

func api(ctx *harness.Ctx) *harness.HTTP {
	for _, p := range apiProducts {
		catalog.PutProduct(context.Background(), apiTenant, p)
	}
	catalog.PutProduct(context.Background(), "t-2", apiOther)
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func searchFor(c *harness.HTTP, params map[string]string) *harness.Response {
	values := url.Values{}
	for k, v := range params {
		values.Set(k, v)
	}
	return c.Get("/v1/search?"+values.Encode(), "X-Tenant-Id", apiTenant)
}

func hitIDs(r *harness.Response) []string {
	var body struct {
		Results []struct {
			ID string \`json:"id"\`
		} \`json:"results"\`
	}
	r.Decode(&body)
	out := []string{}
	for _, hit := range body.Results {
		out = append(out, hit.ID)
	}
	return out
}

func CheckRoute(ctx *harness.Ctx) {
	c := api(ctx)
	r := searchFor(c, map[string]string{"q": "kettle"})
	ctx.Equal(r.Status, 200, "GET /v1/search?q=kettle (%s)", r.Text())
	ctx.Equal(hitIDs(r), []string{"p-3", "p-2", "p-1"}, "the search must answer the tenant's three kettles, cheapest first")
	var body struct {
		PageSize int \`json:"page_size"\`
	}
	r.Decode(&body)
	ctx.Equal(body.PageSize, 20, "without page_size the response's page_size")
}

func CheckQueryCap(ctx *harness.Ctx) {
	c := api(ctx)
	long := "kettle " + strings.Repeat("x", 300)
	r := searchFor(c, map[string]string{"q": long})
	ctx.Equal(r.Status, 400, "a %d-byte query must be refused: q is capped at 256 bytes; the status", len(long))
	r = searchFor(c, map[string]string{"q": strings.Repeat("é", 129)})
	ctx.Equal(r.Status, 400, "a query of 129 characters and 258 bytes (é is two bytes in UTF-8): the cap counts bytes, not characters; the status")
	r = searchFor(c, map[string]string{"q": strings.Repeat("é", 128)})
	ctx.Equal(r.Status, 200, "a query of exactly 256 bytes is within the cap; the status")
	r = searchFor(c, map[string]string{"q": "   "})
	ctx.Equal(r.Status, 400, "a blank query matches the whole catalog and must be refused (%s); the status", r.Text())
}

func CheckPageCap(ctx *harness.Ctx) {
	c := api(ctx)
	for _, size := range []string{"10000", "101", "0", "ten"} {
		r := searchFor(c, map[string]string{"q": "kettle", "page_size": size})
		ctx.Equal(r.Status, 400, "page_size=%s must be refused (an integer from 1 to 100); the status", size)
	}
	r := searchFor(c, map[string]string{"q": "kettle", "page_size": "1"})
	ctx.Assert(r.Status == 200 && strings.Join(hitIDs(r), ",") == "p-3", "page_size=1 answered %d %s, expected the cheapest kettle", r.Status, r.Text())
	r = searchFor(c, map[string]string{"q": "kettle", "page_size": "100"})
	ctx.Equal(r.Status, 200, "page_size=100 is within the cap; the status")
}

func CheckFilterAllowlist(ctx *harness.Ctx) {
	c := api(ctx)
	r := searchFor(c, map[string]string{"q": "kettle", "filters": \`{"cost_cents": "1200"}\`})
	ctx.Equal(r.Status, 400, "a filter on cost_cents answered %s: the wholesale cost is one guess away. Check filter fields against allowedFilterFields; the status", r.Text())
	ctx.Assert(strings.Contains(r.Text(), "cost_cents"), "the 400 must name the unknown field (cost_cents), got %s", r.Text())
	var body struct {
		Allowed []string \`json:"allowed"\`
	}
	r.Decode(&body)
	sort.Strings(body.Allowed)
	ctx.Equal(body.Allowed, apiAllowed, "the 400 must carry the allowed list")
	r = searchFor(c, map[string]string{"q": "kettle", "filters": \`{"brand": "acme", "max_price": "1000"}\`})
	ctx.Assert(r.Status == 200 && strings.Join(hitIDs(r), ",") == "p-3", "brand=acme and max_price=1000 answered %d %s, expected [p-3]", r.Status, r.Text())
	r = searchFor(c, map[string]string{"q": "kettle", "filters": \`{"in_stock": "true"}\`})
	ctx.Assert(r.Status == 200 && strings.Join(hitIDs(r), ",") == "p-3,p-1", "in_stock=true answered %d %s, expected [p-3, p-1]", r.Status, r.Text())
}

func CheckFilterShape(ctx *harness.Ctx) {
	c := api(ctx)
	for _, raw := range []string{\`{"in_stock": true}\`, \`["brand"]\`, "brand=acme"} {
		r := searchFor(c, map[string]string{"q": "kettle", "filters": raw})
		ctx.Equal(r.Status, 400, "filters=%s must be refused: filters is a JSON object of strings (%s); the status", raw, r.Text())
	}
	r := searchFor(c, map[string]string{"q": "kettle", "filters": \`{"category": "kitchen"}\`})
	ctx.Assert(r.Status == 200 && strings.Join(hitIDs(r), ",") == "p-2,p-1", "category=kitchen answered %d %s, expected [p-2, p-1]", r.Status, r.Text())
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cstdio>
#include <string>
#include <utility>
#include <vector>

#include "search/catalog.h"

namespace {

const std::string kTenant = "t-1";

std::vector<catalog::Product> products() {
  return {{"p-1", "Steel Kettle", "acme", "kitchen", 3499, true, 1200, 0},
          {"p-2", "Glass Kettle", "brew", "kitchen", 2999, false, 900, 0},
          {"p-3", "Kettle Descaler", "acme", "cleaning", 899, true, 150, 0}};
}

harness::HTTP api(harness::Ctx& ctx) {
  for (const auto& p : products()) catalog::putProduct(kTenant, p);
  catalog::putProduct("t-2", {"p-9", "Copper Kettle", "acme", "kitchen", 5999, true, 3000, 0});
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

std::string encode(const std::string& text) {
  std::string out;
  for (unsigned char c : text) {
    if (std::isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') {
      out += static_cast<char>(c);
    } else {
      char buf[4];
      std::snprintf(buf, sizeof buf, "%%%02X", c);
      out += buf;
    }
  }
  return out;
}

harness::Response searchFor(harness::HTTP& c, const std::vector<std::pair<std::string, std::string>>& params) {
  std::string path = "/v1/search";
  char sep = '?';
  for (const auto& [name, value] : params) {
    path += sep + name + "=" + encode(value);
    sep = '&';
  }
  return c.Get(path, "X-Tenant-Id", kTenant);
}

std::string ids(const harness::Response& r) {
  std::string out;
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  if (!body.is_object() || !body.contains("results") || !body["results"].is_array()) return out;
  for (const auto& hit : body["results"]) out += (out.empty() ? "" : ",") + hit.value("id", "");
  return out;
}

std::string repeat(const std::string& s, int n) {
  std::string out;
  for (int i = 0; i < n; ++i) out += s;
  return out;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = searchFor(c, {{"q", "kettle"}});
  ctx.Equal(r.Status, 200, "GET /v1/search?q=kettle (%s)", r.Text());
  ctx.Equal(ids(r), "p-3,p-2,p-1", "the search must answer the tenant's three kettles, cheapest first");
  ctx.Equal(nlohmann::json::parse(r.Text()).value("page_size", 0), 20, "without page_size the response's page_size");
}

void CheckQueryCap(harness::Ctx& ctx) {
  auto c = api(ctx);
  const std::string longer = "kettle " + repeat("x", 300);
  auto r = searchFor(c, {{"q", longer}});
  ctx.Equal(r.Status, 400, "a %d-byte query must be refused: q is capped at 256 bytes; the status", longer.size());
  r = searchFor(c, {{"q", repeat("é", 129)}});
  ctx.Equal(r.Status, 400, "a query of 129 characters and 258 bytes (é is two bytes in UTF-8): the cap counts bytes, not characters; the status");
  r = searchFor(c, {{"q", repeat("é", 128)}});
  ctx.Equal(r.Status, 200, "a query of exactly 256 bytes is within the cap; the status");
  r = searchFor(c, {{"q", "   "}});
  ctx.Equal(r.Status, 400, "a blank query matches the whole catalog and must be refused (%s); the status", r.Text());
}

void CheckPageCap(harness::Ctx& ctx) {
  auto c = api(ctx);
  for (const std::string size : {"10000", "101", "0", "ten"}) {
    const auto r = searchFor(c, {{"q", "kettle"}, {"page_size", size}});
    ctx.Equal(r.Status, 400, "page_size=%s must be refused (an integer from 1 to 100); the status", size);
  }
  auto r = searchFor(c, {{"q", "kettle"}, {"page_size", "1"}});
  ctx.Assert(r.Status == 200 && ids(r) == "p-3", "page_size=1 answered %d %s, expected the cheapest kettle", r.Status, r.Text());
  r = searchFor(c, {{"q", "kettle"}, {"page_size", "100"}});
  ctx.Equal(r.Status, 200, "page_size=100 is within the cap; the status");
}

void CheckFilterAllowlist(harness::Ctx& ctx) {
  auto c = api(ctx);
  auto r = searchFor(c, {{"q", "kettle"}, {"filters", R"({"cost_cents": "1200"})"}});
  ctx.Equal(r.Status, 400, "a filter on cost_cents answered %s: the wholesale cost is one guess away. Check filter fields against kAllowedFilterFields; the status", r.Text());
  ctx.Assert(r.Text().find("cost_cents") != std::string::npos, "the 400 must name the unknown field (cost_cents), got %s", r.Text());
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  std::vector<std::string> allowed;
  if (body.is_object() && body.contains("allowed") && body["allowed"].is_array()) {
    for (const auto& name : body["allowed"]) allowed.push_back(name.is_string() ? name.get<std::string>() : name.dump());
  }
  std::sort(allowed.begin(), allowed.end());
  ctx.Equal(allowed, {"brand", "category", "in_stock", "max_price", "min_price"}, "the 400 must carry the allowed list");
  r = searchFor(c, {{"q", "kettle"}, {"filters", R"({"brand": "acme", "max_price": "1000"})"}});
  ctx.Assert(r.Status == 200 && ids(r) == "p-3", "brand=acme and max_price=1000 answered %d %s, expected [p-3]", r.Status, r.Text());
  r = searchFor(c, {{"q", "kettle"}, {"filters", R"({"in_stock": "true"})"}});
  ctx.Assert(r.Status == 200 && ids(r) == "p-3,p-1", "in_stock=true answered %d %s, expected [p-3, p-1]", r.Status, r.Text());
}

void CheckFilterShape(harness::Ctx& ctx) {
  auto c = api(ctx);
  for (const std::string raw : {R"({"in_stock": true})", R"(["brand"])", "brand=acme"}) {
    const auto r = searchFor(c, {{"q", "kettle"}, {"filters", raw}});
    ctx.Equal(r.Status, 400, "filters=%s must be refused: filters is a JSON object of strings (%s); the status", raw, r.Text());
  }
  const auto r = searchFor(c, {{"q", "kettle"}, {"filters", R"({"category": "kitchen"})"}});
  ctx.Assert(r.Status == 200 && ids(r) == "p-2,p-1", "category=kitchen answered %d %s, expected [p-2, p-1]", r.Status, r.Text());
}
`,
  },
  hints: [
    'Search with `filters={"cost_cents":"1200"}`: one kettle comes back, so a shopper can learn the wholesale cost by guessing. A 300-byte query and `page_size=10000` both answer 200, and `filters=brand=acme` answers 500.',
    'The handler passes every request value to `run_query` as it arrived, and the engine treats any stored field as a filter. Nothing bounds `q` or the page size, and the JSON parse has no guard.',
    'Before `run_query`: 400 unless `q` is 1 to 256 UTF-8 bytes, `page_size` an integer from 1 to 100, and `filters` a JSON object of strings whose keys are all in `ALLOWED_FILTER_FIELDS` (name the field, return `allowed`).',
  ],
  debrief: `The engine stays general on purpose: merchandising tools filter on cost and margin, so the place that decides what a shopper can address is the public endpoint, and the allowlist sits there beside the caps. Every rejection is a 400 the client can correct, with the allowed list in the body, instead of a 500 or a silently empty page. The query cap counts bytes because the URL, the cache key and the index all pay in bytes. A larger deployment derives the allowlist per tenant from the index schema, bounds query complexity (term count, wildcards) as well as length, and rate-limits each tenant so one storefront's crawler cannot starve the rest.`,
};
