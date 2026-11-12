import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/products/{id}: the tenant’s current public document',
  concept: 'http',
  guides: ['honest-reads', 'request-boundaries'],
  file: 'product',
  focus: ['client', 'api', 'catalog'],
  task: `## Task

**Starting point.** The starter serves the product page, \`GET /v1/products/{id}\` with
\`X-Tenant-Id\` (401 when missing): it looks the id up with \`find_product\`, keeps every document it
read in a process-level \`documents\` dict, and answers the document with \`Cache-Control: public,
max-age=3600\`. Product pages load fast, and it hides four flaws.

**Failure mode the checks target.** Another tenant's product id answers 200 with that tenant's
document; the body carries the wholesale \`cost_cents\`; a price change never reaches a process that
already read the product; and an hour of public caching lets a shared proxy serve one tenant's page,
and an old price, to everyone.

- Read the caller's catalog only (\`get_product(tenant, id)\`); an id outside it is **404**.
- Answer \`public_view(product)\`: the shopper's fields and \`price_version\`, no \`cost_cents\`.
- Read the catalog on every request: no process-level copy.
- Answer \`Cache-Control: private, max-age=30\` and \`ETag: "{price_version}"\`; a request whose
  \`If-None-Match\` equals the ETag is **304** with no body.`,
  sequence: {
    participants: ['Storefront', 'searchd', 'Catalog index'],
    messages: [
      {
        from: 'Storefront',
        to: 'searchd',
        label: 'GET /v1/products/p-1 · X-Tenant-Id · If-None-Match "2"',
        kind: 'sync',
      },
      {from: 'searchd', to: 'Catalog index', label: 'get_product(tenant, p-1)', kind: 'sync'},
      {from: 'Catalog index', to: 'searchd', label: 'document · price_version 3 · or none → 404', kind: 'reply'},
      {
        from: 'searchd',
        to: 'Storefront',
        label: '200 public_view · private, max-age=30 · ETag "3" (304 when it matches)',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'tenant-scope',
      title: 'Another tenant’s product is 404',
      detail:
        'The document is read with `get_product(tenant, id)`, so an id from another tenant’s catalog answers **404**; the starter’s `find_product` looks in every tenant’s catalog.',
      match: {
        python: {all: [/catalog\.get_product\(\s*tenant/], none: [/find_product\(/]},
        typescript: {all: [/getProduct\(\s*tenant/], none: [/findProduct\(/]},
        go: {all: [/catalog\.GetProduct\(\s*r\.Context\(\),\s*tenant/], none: [/FindProduct\(/]},
        scala: {all: [/Catalog\.getProduct\(\s*tenant/], none: [/findProduct\(/]},
        cpp: {all: [/catalog::getProduct\(\s*tenant/], none: [/findProduct\(/]},
      },
    },
    {
      id: 'public-fields',
      title: 'The body is the public view',
      detail:
        'The response is `public_view(product)`: id, title, brand, category, price, stock and `price_version`. The starter serializes every stored field, the wholesale `cost_cents` included.',
      match: {
        python: {all: [/catalog\.public_view\(/]},
        typescript: {all: [/publicView\(/]},
        go: {all: [/catalog\.PublicView\(/]},
        scala: {all: [/Catalog\.publicView\(/], none: [/Catalog\.toJson\(/]},
        cpp: {all: [/catalog::publicView\(/], none: [/catalog::toJson\(/]},
      },
    },
    {
      id: 'fresh-price',
      title: 'A price change shows on the next read',
      detail:
        'The catalog is read on every request; the starter keeps each document in a process-level `documents` map forever, so a repriced product keeps its old price until the process restarts.',
      match: {
        python: {all: [/catalog\.get_product\(/], none: [/^documents\s*[:=]/m]},
        typescript: {all: [/getProduct\(/], none: [/const documents\s*=/]},
        go: {all: [/catalog\.GetProduct\(/], none: [/documents\s*=\s*map\[/]},
        scala: {all: [/Catalog\.getProduct\(/], none: [/val documents\s*=/]},
        cpp: {all: [/catalog::getProduct\(/], none: [/catalog::Product>\s*documents/]},
      },
    },
    {
      id: 'cache-headers',
      title: 'Private, 30 seconds, an ETag of the price version',
      detail:
        'The response carries `Cache-Control: private, max-age=30` and `ETag: "{price_version}"`, and a matching `If-None-Match` answers **304**; the starter’s `public, max-age=3600` lets a shared cache hand a tenant’s page and an hour-old price to anyone.',
      match: {
        python: {
          all: [/private, max-age=(30|\{MAX_AGE_S\})/, /["']ETag["']/, /if-none-match/i, /\b304\b/],
          none: [/public, max-age/],
        },
        typescript: {
          all: [/private, max-age=(30|\$\{MAX_AGE_S\})/, /['"]ETag['"]/, /if-none-match/i, /\b304\b/],
          none: [/public, max-age/],
        },
        go: {
          all: [/private, max-age=(30|%d)/, /"ETag"/, /If-None-Match/, /StatusNotModified|\b304\b/],
          none: [/public, max-age/],
        },
        scala: {
          all: [/private, max-age=(30|\$MaxAgeSeconds)/, /"ETag"/, /If-None-Match/, /NotModified/],
          none: [/public, max-age/],
        },
        cpp: {all: [/private, max-age=/, /"ETag"/, /If-None-Match/, /\b304\b/], none: [/public, max-age/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from search import catalog  # get_product, find_product, public_view

app = FastAPI()

# product id -> document: a popular product is read from Redis once per process.
documents: dict[str, dict] = {}


@app.get("/v1/products/{product_id}")
def read_product(product_id: str, request: Request) -> JSONResponse:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        return JSONResponse({"error": "missing X-Tenant-Id"}, status_code=401)
    product = documents.get(product_id)
    if product is None:
        product = catalog.find_product(product_id)
        if product is None:
            return JSONResponse({"error": "no such product"}, status_code=404)
        documents[product_id] = product
    return JSONResponse(product, headers={"Cache-Control": "public, max-age=3600"})
`,
      solution: `from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse

from search import catalog  # get_product, find_product, public_view

app = FastAPI()

MAX_AGE_S = 30


@app.get("/v1/products/{product_id}")
def read_product(product_id: str, request: Request) -> Response:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        return JSONResponse({"error": "missing X-Tenant-Id"}, status_code=401)
    product = catalog.get_product(tenant, product_id)  # the caller's catalog, read every time
    if product is None:
        return JSONResponse({"error": "no such product"}, status_code=404)
    etag = f'"{product["price_version"]}"'
    # private: the page belongs to one tenant; 30 s bounds how long a repriced product shows its old price.
    headers = {"Cache-Control": f"private, max-age={MAX_AGE_S}", "ETag": etag}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    return JSONResponse(catalog.public_view(product), headers=headers)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {type Product, findProduct, getProduct, publicView} from 'search/catalog';

export const app = Fastify();

// product id -> document: a popular product is read from Redis once per process.
const documents = new Map<string, Product>();

app.get('/v1/products/:productId', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const {productId} = request.params as {productId: string};
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  let product = documents.get(productId) ?? null;
  if (product === null) {
    product = await findProduct(productId);
    if (product === null) return reply.code(404).send({error: 'no such product'});
    documents.set(productId, product);
  }
  reply.header('Cache-Control', 'public, max-age=3600');
  return product;
});
`,
      solution: `import Fastify from 'fastify';

import {type Product, findProduct, getProduct, publicView} from 'search/catalog';

export const app = Fastify();

const MAX_AGE_S = 30;

app.get('/v1/products/:productId', async (request, reply) => {
  const {productId} = request.params as {productId: string};
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const product: Product | null = await getProduct(tenant, productId); // the caller's catalog, read every time
  if (product === null) return reply.code(404).send({error: 'no such product'});
  const etag = \`"\${product.price_version}"\`;
  // private: the page belongs to one tenant; 30 s bounds how long a repriced product shows its old price.
  reply.header('Cache-Control', \`private, max-age=\${MAX_AGE_S}\`);
  reply.header('ETag', etag);
  if (request.headers['if-none-match'] === etag) return reply.code(304).send();
  return publicView(product);
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"search/catalog" // GetProduct, FindProduct, PublicView
)

// product id -> document: a popular product is read from Redis once per process.
var documents = map[string]*catalog.Product{}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func readProduct(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	productID := r.PathValue("id")
	product, ok := documents[productID]
	if !ok {
		product = catalog.FindProduct(r.Context(), productID)
		if product == nil {
			writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such product"})
			return
		}
		documents[productID] = product
	}
	rw.Header().Set("Cache-Control", "public, max-age=3600")
	writeJSON(rw, http.StatusOK, product)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/products/{id}", readProduct)
}
`,
      solution: `package main

import (
	"encoding/json"
	"fmt"
	"net/http"

	"search/catalog" // GetProduct, FindProduct, PublicView
)

const maxAgeSeconds = 30

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func readProduct(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	product := catalog.GetProduct(r.Context(), tenant, r.PathValue("id")) // the caller's catalog, read every time
	if product == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such product"})
		return
	}
	etag := fmt.Sprintf("%q", fmt.Sprint(product.PriceVersion))
	// private: the page belongs to one tenant; 30 s bounds how long a repriced product shows its old price.
	rw.Header().Set("Cache-Control", fmt.Sprintf("private, max-age=%d", maxAgeSeconds))
	rw.Header().Set("ETag", etag)
	if r.Header.Get("If-None-Match") == etag {
		rw.WriteHeader(http.StatusNotModified)
		return
	}
	writeJSON(rw, http.StatusOK, catalog.PublicView(*product))
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/products/{id}", readProduct)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

import search.Catalog // getProduct, findProduct, publicView, toJson

object ProductApi {
  // product id -> document: a popular product is read from Redis once per process.
  private val documents = scala.collection.concurrent.TrieMap.empty[String, Catalog.Product]

  val route: Route = path("v1" / "products" / Segment) { productId =>
    get {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(StatusCodes.Unauthorized -> "missing X-Tenant-Id")
        case Some(_) =>
          // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
          documents.get(productId).orElse(Catalog.findProduct(productId).map { p => documents.put(productId, p); p }) match {
            case None => complete(StatusCodes.NotFound -> "no such product")
            case Some(product) =>
              val headers = List(RawHeader("Cache-Control", "public, max-age=3600"))
              complete(HttpResponse(StatusCodes.OK, headers = headers, entity = HttpEntity(ContentTypes.\`application/json\`, Catalog.toJson(product).compactPrint)))
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

import search.Catalog // getProduct, findProduct, publicView, toJson

object ProductApi {
  val MaxAgeSeconds = 30

  val route: Route = path("v1" / "products" / Segment) { productId =>
    get {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(StatusCodes.Unauthorized -> "missing X-Tenant-Id")
        case Some(tenant) =>
          optionalHeaderValueByName("If-None-Match") { ifNoneMatch =>
            Catalog.getProduct(tenant, productId) match { // the caller's catalog, read every time
              case None => complete(StatusCodes.NotFound -> "no such product")
              case Some(product) =>
                val etag = "\\"" + product.priceVersion + "\\""
                // private: the page belongs to one tenant; 30 s bounds how long a repriced product shows its old price.
                val headers = List(RawHeader("Cache-Control", s"private, max-age=$MaxAgeSeconds"), RawHeader("ETag", etag))
                if (ifNoneMatch.contains(etag)) complete(HttpResponse(StatusCodes.NotModified, headers = headers))
                else complete(HttpResponse(StatusCodes.OK, headers = headers, entity = HttpEntity(ContentTypes.\`application/json\`, Catalog.publicView(product).compactPrint)))
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

#include "search/catalog.h"  // catalog::getProduct, findProduct, publicView, toJson

using json = nlohmann::json;

// product id -> document: a popular product is read from Redis once per process.
std::map<std::string, catalog::Product> documents;

void read_product(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content(R"({"error": "missing X-Tenant-Id"})", "application/json");
    return;
  }
  const std::string product_id = req.matches[1];
  if (!documents.count(product_id)) {
    const auto product = catalog::findProduct(product_id);
    if (!product) {
      res.status = 404;
      res.set_content(R"({"error": "no such product"})", "application/json");
      return;
    }
    documents[product_id] = *product;
  }
  res.set_header("Cache-Control", "public, max-age=3600");
  res.set_content(catalog::toJson(documents[product_id]).dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/products/([\\w-]+))", read_product); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

#include "search/catalog.h"  // catalog::getProduct, findProduct, publicView, toJson

using json = nlohmann::json;

const int kMaxAgeSeconds = 30;

void read_product(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content(R"({"error": "missing X-Tenant-Id"})", "application/json");
    return;
  }
  const auto product = catalog::getProduct(tenant, req.matches[1]);  // the caller's catalog, read every time
  if (!product) {
    res.status = 404;
    res.set_content(R"({"error": "no such product"})", "application/json");
    return;
  }
  const std::string etag = "\\"" + std::to_string(product->price_version) + "\\"";
  // private: the page belongs to one tenant; 30 s bounds how long a repriced product shows its old price.
  res.set_header("Cache-Control", "private, max-age=" + std::to_string(kMaxAgeSeconds));
  res.set_header("ETag", etag);
  if (req.get_header_value("If-None-Match") == etag) {
    res.status = 304;
    return;
  }
  res.set_content(catalog::publicView(*product).dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/products/([\\w-]+))", read_product); }
`,
    },
  },
  harness: {
    python: `from search import catalog

KETTLE = {"id": "p-1", "title": "Steel Kettle", "brand": "acme", "category": "kitchen", "price_cents": 3499, "in_stock": True, "cost_cents": 1200}
PUBLIC = {"id": "p-1", "title": "Steel Kettle", "brand": "acme", "category": "kitchen", "price_cents": 3499, "in_stock": True, "price_version": 1}


def _api(ctx):
    catalog.put_product("t-1", KETTLE)
    return ctx.client(ctx.load("product").app)


async def _get(c, tenant="t-1", **headers):
    return await c.get("/v1/products/p-1", headers={"X-Tenant-Id": tenant, **headers})


def _directives(r):
    return {d.strip() for d in r.headers.get("cache-control", "").split(",") if d.strip()}


async def check_tenant_scope(ctx):
    async with _api(ctx) as c:
        other = await _get(c, tenant="t-2")
        assert other.status_code == 404, f"tenant t-2 reading t-1's p-1 answered {other.status_code}: {other.text}. Read the caller's catalog only (get_product(tenant, id))"
        own = await _get(c)
    assert own.status_code == 200 and own.json().get("id") == "p-1", f"t-1 reading its own p-1 answered {own.status_code} {own.text}"


async def check_public_fields(ctx):
    async with _api(ctx) as c:
        r = await _get(c)
    assert r.status_code == 200, f"GET /v1/products/p-1 answered {r.status_code}: {r.text}"
    body = r.json()
    assert "cost_cents" not in body, f"the product page carries the wholesale cost: {body}. Answer public_view(product)"
    assert body == PUBLIC, f"the product page is {body}, expected the public view {PUBLIC}"


async def check_fresh_price(ctx):
    async with _api(ctx) as c:
        first = await _get(c)
        assert first.status_code == 200 and first.json().get("price_cents") == 3499, f"the first read answered {first.status_code} {first.text}"
        catalog.put_product("t-1", {**KETTLE, "price_cents": 2999})
        second = await _get(c)
    body = second.json()
    assert body.get("price_cents") == 2999 and body.get("price_version") == 2, f"after a reprice to 2999 the page answered price {body.get('price_cents')} version {body.get('price_version')}: a process-level copy keeps the old price. Read the catalog on every request"


async def check_cache_headers(ctx):
    async with _api(ctx) as c:
        r = await _get(c)
        directives = _directives(r)
        assert "public" not in directives and "private" in directives and "max-age=30" in directives, f"the page answered Cache-Control {r.headers.get('cache-control')!r}: a shared cache would hand this tenant's page to anyone. Use private, max-age=30"
        assert r.headers.get("etag") == '"1"', f"ETag is {r.headers.get('etag')!r}, expected the price version in quotes: \\"1\\""
        again = await _get(c, **{"If-None-Match": '"1"'})
        assert again.status_code == 304 and again.text == "", f"a revalidation with If-None-Match \\"1\\" answered {again.status_code} {again.text!r}, expected 304 with no body"
        catalog.put_product("t-1", {**KETTLE, "price_cents": 2999})
        stale = await _get(c, **{"If-None-Match": '"1"'})
    assert stale.status_code == 200 and stale.headers.get("etag") == '"2"', f"after a reprice, If-None-Match \\"1\\" answered {stale.status_code} with ETag {stale.headers.get('etag')!r}, expected 200 and \\"2\\""
`,
    typescript: `const KETTLE = {id: 'p-1', title: 'Steel Kettle', brand: 'acme', category: 'kitchen', price_cents: 3499, in_stock: true, cost_cents: 1200};
const PUBLIC = {id: 'p-1', title: 'Steel Kettle', brand: 'acme', category: 'kitchen', price_cents: 3499, in_stock: true, price_version: 1};

async function api(ctx) {
  const catalog = ctx.load('/support/search/catalog.ts');
  await catalog.putProduct('t-1', KETTLE);
  return {c: ctx.client(ctx.load('product').app), catalog};
}

const get = (c, tenant = 't-1', headers: Record<string, string> = {}) => c.get('/v1/products/p-1', {headers: {'X-Tenant-Id': tenant, ...headers}});

const directives = r => new Set((r.headers['cache-control'] ?? '').split(',').map(d => d.trim()).filter(d => d !== ''));

export async function check_tenant_scope(ctx) {
  const {c} = await api(ctx);
  const other = await get(c, 't-2');
  assert.equal(other.status, 404, \`tenant t-2 reading t-1's p-1 answered \${other.status}: \${other.text}. Read the caller's catalog only (getProduct(tenant, id))\`);
  const own = await get(c);
  assert(own.status === 200 && own.json().id === 'p-1', \`t-1 reading its own p-1 answered \${own.status} \${own.text}\`);
}

export async function check_public_fields(ctx) {
  const {c} = await api(ctx);
  const r = await get(c);
  assert.equal(r.status, 200, \`GET /v1/products/p-1 answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(!('cost_cents' in body), \`the product page carries the wholesale cost: \${r.text}. Answer publicView(product)\`);
  assert.deepStrictEqual(body, PUBLIC, \`the product page is \${r.text}, expected the public view \${JSON.stringify(PUBLIC)}\`);
}

export async function check_fresh_price(ctx) {
  const {c, catalog} = await api(ctx);
  const first = await get(c);
  assert(first.status === 200 && first.json().price_cents === 3499, \`the first read answered \${first.status} \${first.text}\`);
  await catalog.putProduct('t-1', {...KETTLE, price_cents: 2999});
  const body = (await get(c)).json();
  assert(body.price_cents === 2999 && body.price_version === 2, \`after a reprice to 2999 the page answered price \${body.price_cents} version \${body.price_version}: a process-level copy keeps the old price. Read the catalog on every request\`);
}

export async function check_cache_headers(ctx) {
  const {c, catalog} = await api(ctx);
  const r = await get(c);
  const d = directives(r);
  assert(!d.has('public') && d.has('private') && d.has('max-age=30'), \`the page answered Cache-Control \${JSON.stringify(r.headers['cache-control'])}: a shared cache would hand this tenant's page to anyone. Use private, max-age=30\`);
  assert.equal(r.headers.etag, '"1"', \`ETag is \${JSON.stringify(r.headers.etag)}, expected the price version in quotes: "1"\`);
  const again = await get(c, 't-1', {'If-None-Match': '"1"'});
  assert(again.status === 304 && again.text === '', \`a revalidation with If-None-Match "1" answered \${again.status} \${JSON.stringify(again.text)}, expected 304 with no body\`);
  await catalog.putProduct('t-1', {...KETTLE, price_cents: 2999});
  const stale = await get(c, 't-1', {'If-None-Match': '"1"'});
  assert(stale.status === 200 && stale.headers.etag === '"2"', \`after a reprice, If-None-Match "1" answered \${stale.status} with ETag \${JSON.stringify(stale.headers.etag)}, expected 200 and "2"\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"strings"

	"search/catalog"

	"leetbuild/harness"
)

var productKettle = catalog.Product{ID: "p-1", Title: "Steel Kettle", Brand: "acme", Category: "kitchen", PriceCents: 3499, InStock: true, CostCents: 1200}

func productAPI(ctx *harness.Ctx) *harness.HTTP {
	catalog.PutProduct(context.Background(), "t-1", productKettle)
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func pageBody(r *harness.Response) map[string]any {
	var body map[string]any
	r.Decode(&body)
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

func CheckTenantScope(ctx *harness.Ctx) {
	c := productAPI(ctx)
	other := c.Get("/v1/products/p-1", "X-Tenant-Id", "t-2")
	ctx.Equal(other.Status, 404, "tenant t-2 reading t-1's p-1 answered %s: read the caller's catalog only (catalog.GetProduct(ctx, tenant, id)); the status", other.Text())
	own := c.Get("/v1/products/p-1", "X-Tenant-Id", "t-1")
	ctx.Assert(own.Status == 200 && pageBody(own)["id"] == "p-1", "t-1 reading its own p-1 answered %d %s", own.Status, own.Text())
}

func CheckPublicFields(ctx *harness.Ctx) {
	c := productAPI(ctx)
	r := c.Get("/v1/products/p-1", "X-Tenant-Id", "t-1")
	ctx.Equal(r.Status, 200, "GET /v1/products/p-1 (%s)", r.Text())
	body := pageBody(r)
	_, leaked := body["cost_cents"]
	ctx.Assert(!leaked, "the product page carries the wholesale cost: %s. Answer catalog.PublicView(product)", r.Text())
	ctx.Equal(body, map[string]any{"id": "p-1", "title": "Steel Kettle", "brand": "acme", "category": "kitchen", "price_cents": float64(3499), "in_stock": true, "price_version": float64(1)}, "the product page must be the public view")
}

func CheckFreshPrice(ctx *harness.Ctx) {
	c := productAPI(ctx)
	first := c.Get("/v1/products/p-1", "X-Tenant-Id", "t-1")
	ctx.Assert(first.Status == 200 && pageBody(first)["price_cents"] == float64(3499), "the first read answered %d %s", first.Status, first.Text())
	repriced := productKettle
	repriced.PriceCents = 2999
	catalog.PutProduct(context.Background(), "t-1", repriced)
	body := pageBody(c.Get("/v1/products/p-1", "X-Tenant-Id", "t-1"))
	ctx.Assert(body["price_cents"] == float64(2999) && body["price_version"] == float64(2), "after a reprice to 2999 the page answered price %v version %v: a process-level copy keeps the old price. Read the catalog on every request", body["price_cents"], body["price_version"])
}

func CheckCacheHeaders(ctx *harness.Ctx) {
	c := productAPI(ctx)
	r := c.Get("/v1/products/p-1", "X-Tenant-Id", "t-1")
	d := directives(r)
	ctx.Assert(!d["public"] && d["private"] && d["max-age=30"], "the page answered Cache-Control %q: a shared cache would hand this tenant's page to anyone. Use private, max-age=30", r.Header.Get("Cache-Control"))
	ctx.Equal(r.Header.Get("ETag"), \`"1"\`, "the ETag must be the price version in quotes")
	again := c.Get("/v1/products/p-1", "X-Tenant-Id", "t-1", "If-None-Match", \`"1"\`)
	ctx.Assert(again.Status == 304 && again.Text() == "", "a revalidation with If-None-Match \\"1\\" answered %d %q, expected 304 with no body", again.Status, again.Text())
	repriced := productKettle
	repriced.PriceCents = 2999
	catalog.PutProduct(context.Background(), "t-1", repriced)
	stale := c.Get("/v1/products/p-1", "X-Tenant-Id", "t-1", "If-None-Match", \`"1"\`)
	ctx.Assert(stale.Status == 200 && stale.Header.Get("ETag") == \`"2"\`, "after a reprice, If-None-Match \\"1\\" answered %d with ETag %q, expected 200 and \\"2\\"", stale.Status, stale.Header.Get("ETag"))
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <set>
#include <sstream>
#include <string>

#include "search/catalog.h"

namespace {

const catalog::Product kKettle{"p-1", "Steel Kettle", "acme", "kitchen", 3499, true, 1200, 0};

harness::HTTP productAPI(harness::Ctx& ctx) {
  catalog::putProduct("t-1", kKettle);
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

nlohmann::json pageBody(const harness::Response& r) { return nlohmann::json::parse(r.Text(), nullptr, false); }

std::set<std::string> directives(const harness::Response& r) {
  std::set<std::string> out;
  std::stringstream in(r.HeaderValue("Cache-Control"));
  std::string d;
  while (std::getline(in, d, ',')) {
    const auto a = d.find_first_not_of(' ');
    const auto b = d.find_last_not_of(' ');
    if (a != std::string::npos) out.insert(d.substr(a, b - a + 1));
  }
  return out;
}

catalog::Product repriced() {
  catalog::Product p = kKettle;
  p.price_cents = 2999;
  return p;
}

}  // namespace

void CheckTenantScope(harness::Ctx& ctx) {
  auto c = productAPI(ctx);
  const auto other = c.Get("/v1/products/p-1", "X-Tenant-Id", "t-2");
  ctx.Equal(other.Status, 404, "tenant t-2 reading t-1's p-1 answered %s: read the caller's catalog only (catalog::getProduct(tenant, id)); the status", other.Text());
  const auto own = c.Get("/v1/products/p-1", "X-Tenant-Id", "t-1");
  ctx.Assert(own.Status == 200 && pageBody(own).value("id", "") == "p-1", "t-1 reading its own p-1 answered %d %s", own.Status, own.Text());
}

void CheckPublicFields(harness::Ctx& ctx) {
  auto c = productAPI(ctx);
  const auto r = c.Get("/v1/products/p-1", "X-Tenant-Id", "t-1");
  ctx.Equal(r.Status, 200, "GET /v1/products/p-1 (%s)", r.Text());
  const auto body = pageBody(r);
  ctx.Assert(body.is_object() && !body.contains("cost_cents"), "the product page carries the wholesale cost: %s. Answer catalog::publicView(product)", r.Text());
  const nlohmann::json expected = {{"id", "p-1"}, {"title", "Steel Kettle"}, {"brand", "acme"}, {"category", "kitchen"}, {"price_cents", 3499}, {"in_stock", true}, {"price_version", 1}};
  ctx.Assert(body == expected, "the product page is %s, expected the public view %s", r.Text(), expected.dump());
}

void CheckFreshPrice(harness::Ctx& ctx) {
  auto c = productAPI(ctx);
  const auto first = c.Get("/v1/products/p-1", "X-Tenant-Id", "t-1");
  ctx.Assert(first.Status == 200 && pageBody(first).value("price_cents", 0) == 3499, "the first read answered %d %s", first.Status, first.Text());
  catalog::putProduct("t-1", repriced());
  const auto body = pageBody(c.Get("/v1/products/p-1", "X-Tenant-Id", "t-1"));
  ctx.Assert(body.value("price_cents", 0) == 2999 && body.value("price_version", 0) == 2, "after a reprice to 2999 the page answered price %d version %d: a process-level copy keeps the old price. Read the catalog on every request",
             body.value("price_cents", 0), body.value("price_version", 0));
}

void CheckCacheHeaders(harness::Ctx& ctx) {
  auto c = productAPI(ctx);
  const auto r = c.Get("/v1/products/p-1", "X-Tenant-Id", "t-1");
  const auto d = directives(r);
  ctx.Assert(!d.count("public") && d.count("private") && d.count("max-age=30"), "the page answered Cache-Control %q: a shared cache would hand this tenant's page to anyone. Use private, max-age=30", r.HeaderValue("Cache-Control"));
  ctx.Equal(r.HeaderValue("ETag"), "\\"1\\"", "the ETag must be the price version in quotes");
  const auto again = c.Get("/v1/products/p-1", "X-Tenant-Id", "t-1", "If-None-Match", "\\"1\\"");
  ctx.Assert(again.Status == 304 && again.Text().empty(), "a revalidation with If-None-Match \\"1\\" answered %d %q, expected 304 with no body", again.Status, again.Text());
  catalog::putProduct("t-1", repriced());
  const auto stale = c.Get("/v1/products/p-1", "X-Tenant-Id", "t-1", "If-None-Match", "\\"1\\"");
  ctx.Assert(stale.Status == 200 && stale.HeaderValue("ETag") == "\\"2\\"", "after a reprice, If-None-Match \\"1\\" answered %d with ETag %q, expected 200 and \\"2\\"", stale.Status, stale.HeaderValue("ETag"));
}
`,
  },
  hints: [
    'Read another tenant’s product id: it answers 200 with their document, wholesale cost included. Reprice a product the process has already served: the page keeps the old price, and it says public for an hour.',
    '`find_product` looks in every tenant’s catalog, the `documents` dict keeps the first read forever, the body is the whole stored document, and `public, max-age=3600` invites every shared cache to keep it.',
    'Read `get_product(tenant, id)` on every request (404 when missing), answer `public_view(product)`, set `Cache-Control: private, max-age=30` and `ETag: "{price_version}"`, and answer 304 when `If-None-Match` equals it.',
  ],
  debrief: `The product page is the read a shopper trusts with money, so it reads the source on every request and lets HTTP caching do the saving: the ETag names the version that was served, a revalidation costs one hash read and an empty 304, and \`max-age=30\` bounds how long a repriced product shows its old price in the browser. \`private\` is there because the response depends on a header a shared cache does not key on; one proxy that ignored it would mix tenants. The tenant check and the public view are the same rule as the search filter allowlist: the stored document is not the shopper's document. A larger deployment adds \`Vary\` for any header it does key on and a short in-process cache keyed by tenant and version.`,
};
