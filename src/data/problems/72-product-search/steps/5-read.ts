import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/products/{id}: the price that cannot be stale',
  concept: 'http',
  file: 'read',
  focus: ['client', 'read', 'catalog', 'redis'],
  task: `## Task

**Starting point.** The starter registers \`GET /v1/products/{id}\`, looks the product up in a
process-level dictionary keyed by product id, fetches it from the catalog on a miss, stores it for
the life of the process, and answers with the id, the price and \`price_version: "latest"\`. It
compiles, it answers the demo, and it hides four flaws.

**Failure mode the checks target.** A read path is where staleness becomes a lie. The starter's
cache has no version and no expiry, so it serves whatever it saw first; its \`price_version\` is a
constant, so a caller that trusts the version trusts nothing; and it is keyed by product id alone, so
a cross-tenant read is one id away. The fix ties the response to the document it actually returns:
the document's version, the snapshot's version, and a five-minute bound past which the read fails
loudly instead of serving a price the catalog has moved past.

- The document is read through the catalog snapshot for the **caller's tenant**
  (\`snapshot(tenant, id)\`), and a product that is not in that tenant's catalog is **404**.
- The response reports the document's **own** price version (\`price_version\` / \`priceVersion\`), not
  a constant: the version must describe the value beside it.
- The document carries its **index version** and its index timestamp; the response is refused
  (**409**) when the snapshot is more than **5 minutes** behind (\`MAX_INDEX_LAG_MS = 300000\`,
  \`snapshot_ms - index_ms > MAX_INDEX_LAG_MS\`).
- Log the refusal, not the price history: a stale document is an operations signal.`,
  sequence: {
    participants: ['Client', 'Product read', 'Redis', 'Catalog'],
    messages: [
      {from: 'Client', to: 'Product read', label: 'GET /v1/products/{id} · X-Tenant-Id', kind: 'sync'},
      {from: 'Product read', to: 'Redis', label: 'GET product:{tenant}:{id}', kind: 'sync'},
      {from: 'Redis', to: 'Product read', label: 'cached document / nil', kind: 'reply'},
      {from: 'Product read', to: 'Catalog', label: 'snapshot(tenant, id) · index version', kind: 'sync'},
      {from: 'Catalog', to: 'Product read', label: 'document · price_version · index_ms', kind: 'reply'},
      {from: 'Product read', to: 'Product read', label: 'snapshot_ms - index_ms > 300000 → 409', kind: 'sync'},
      {from: 'Product read', to: 'Client', label: '200 {price, price_version, index_version} / 404', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/products/{id}',
      detail: 'Register the product read route on `GET /v1/products/{id}`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/products\/\{product_id\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/products\/:id['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/products\/\{id\}"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"products"\s*\/\s*Segment\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/products\//]},
      },
    },
    {
      id: 'version-reported',
      title: "Reports the document's own price version",
      detail:
        'The response carries the version of the price it returns, never a constant. The starter answers `price_version: "latest"` while serving a cached value, so a caller that trusts the version is misled.',
      match: {
        python: {all: [/price_version/], none: [/latest/i]},
        typescript: {all: [/priceVersion/], none: [/latest/i]},
        go: {all: [/PriceVersion/], none: [/latest/i]},
        scala: {all: [/priceVersion/], none: [/latest/i]},
        cpp: {all: [/price_version/], none: [/latest/i]},
      },
    },
    {
      id: 'staleness-bound',
      title: 'Enforces the five-minute index lag bound',
      detail:
        'A document whose index timestamp trails the snapshot by more than `MAX_INDEX_LAG_MS = 300000` is refused (409). The starter caches until the process restarts and has no bound, so a price change may never appear.',
      match: {
        python: {all: [/MAX_INDEX_LAG_MS\s*=\s*300000/, /stale/]},
        typescript: {all: [/MAX_INDEX_LAG_MS\s*=\s*300000/, /stale/]},
        go: {all: [/maxIndexLagMs\s*=\s*300000/, /stale/]},
        scala: {all: [/MaxIndexLagMs\s*=\s*300000/, /stale/]},
        cpp: {all: [/kMaxIndexLagMs\s*=\s*300000/, /stale/]},
      },
    },
    {
      id: 'tenant-scope',
      title: 'Scopes the read to the tenant, 404 for a foreign id',
      detail:
        "The document is read for the caller's tenant and a product id outside that catalog is **404**. The starter keys a process cache by product id alone, so any tenant can read any product that was cached once.",
      match: {
        python: {all: [/tenant/, /status_code\s*=\s*404/]},
        typescript: {all: [/tenant/, /code\(\s*404\s*\)/]},
        go: {all: [/tenant/, /StatusNotFound/]},
        scala: {all: [/tenant/, /StatusCodes\.NotFound/]},
        cpp: {all: [/tenant/, /\b404\b/]},
      },
    },
    {
      id: 'index-version-check',
      title: 'Compares the document index version against the snapshot',
      detail:
        "The read carries the document's index version and compares it with the current catalog snapshot before answering. The starter has neither, so there is nothing to compare and nothing to refuse.",
      match: {
        python: {all: [/index_version/, /snapshot/]},
        typescript: {all: [/indexVersion/, /snapshot/]},
        go: {all: [/IndexVersion/, /[Ss]napshot/]},
        scala: {all: [/indexVersion/, /[Ss]napshot/]},
        cpp: {all: [/index_version/, /snapshot/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("product-read")

CACHE: dict[str, dict] = {}


class Catalog:
    def fetch(self, tenant: str, product_id: str) -> dict:
        """Fetch the document for a product id."""
        raise NotImplementedError


catalog = Catalog()


@app.get("/v1/products/{product_id}")
def read_product(
    product_id: str,
    tenant: str = Header(default="", alias="X-Tenant-Id"),
) -> JSONResponse:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    document = CACHE.get(product_id)
    if document is None:
        document = catalog.fetch(tenant, product_id)
        CACHE[product_id] = document
    logger.info("read product=%s", product_id)
    return JSONResponse(
        {"id": document["id"], "price": document["price"], "price_version": "latest"},
        status_code=200,
    )
`,
      solution: `import logging

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("product-read")

MAX_INDEX_LAG_MS = 300000


class Catalog:
    def snapshot(self, tenant: str, product_id: str) -> dict | None:
        """The document as of the current catalog snapshot, or None if it is not in this catalog."""
        raise NotImplementedError


catalog = Catalog()


def is_stale(document: dict) -> bool:
    """A document whose index timestamp trails the snapshot is stale, not merely old."""
    return document["snapshot_ms"] - document["index_ms"] > MAX_INDEX_LAG_MS


@app.get("/v1/products/{product_id}")
def read_product(
    product_id: str,
    tenant: str = Header(default="", alias="X-Tenant-Id"),
) -> JSONResponse:
    if tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    document = catalog.snapshot(tenant, product_id)
    if document is None:
        raise HTTPException(status_code=404, detail="product not found in this catalog")
    if is_stale(document):
        logger.warning("stale document tenant=%s product=%s", tenant, product_id)
        raise HTTPException(status_code=409, detail="document is behind the catalog snapshot")
    return JSONResponse(
        {
            "id": document["id"],
            "price": document["price"],
            "price_version": document["price_version"],
            "index_version": document["index_version"],
            "stale": False,
        },
        status_code=200,
    )
`,
    },
    typescript: {
      starter: `/** GET /v1/products/:id: the starter. */
import Fastify from 'fastify';

export const app = Fastify();

const CACHE: Record<string, {id: string; price: number}> = {};

interface Catalog {
  fetch(tenant: string, productId: string): Promise<{id: string; price: number}>;
}

const catalog: Catalog = {
  fetch: async () => {
    throw new Error('not implemented');
  },
};

app.get('/v1/products/:id', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'] as string;
  const {id} = request.params as {id: string};
  let document = CACHE[id];
  if (document === undefined) {
    document = await catalog.fetch(tenant, id);
    CACHE[id] = document;
  }
  request.log.info({product: id}, 'read');
  return reply.code(200).send({id: document.id, price: document.price, price_version: 'latest'});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/products/:id: the document's own version, tenant-scoped, bounded staleness. */
import Fastify from 'fastify';

import {catalog} from './catalog';

export const app = Fastify();

const MAX_INDEX_LAG_MS = 300000;

app.get('/v1/products/:id', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {id} = request.params as {id: string};
  const document = await catalog.snapshot(tenant, id);
  if (document === null) return reply.code(404).send({error: 'product not found in this catalog'});
  if (document.snapshot_ms - document.index_ms > MAX_INDEX_LAG_MS) {
    request.log.warn({tenant, product: id}, 'stale document');
    return reply.code(409).send({error: 'document is behind the catalog snapshot'});
  }
  return reply.code(200).send({
    id: document.id,
    price: document.price,
    price_version: document.priceVersion,
    index_version: document.indexVersion,
    stale: false,
  });
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
)

var productCache = map[string]map[string]any{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func catalogFetch(tenant, id string) map[string]any {
	return map[string]any{"id": id, "price": 0.0}
}

func readProduct(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	id := r.PathValue("id")
	document, ok := productCache[id]
	if !ok {
		document = catalogFetch(tenant, id)
		productCache[id] = document
	}
	log.Printf("read product=%s", id)
	writeJSON(rw, http.StatusOK, map[string]any{
		"id":            document["id"],
		"price":         document["price"],
		"price_version": "latest",
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/products/{id}", readProduct)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
)

const maxIndexLagMs = 300000

type ProductDocument struct {
	Id           string
	Price        float64
	PriceVersion string
	IndexVersion string
	IndexMs      int64
	SnapshotMs   int64
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func catalogSnapshot(tenant, id string) (*ProductDocument, error) {
	_ = tenant
	_ = id
	return nil, errors.New("not in this catalog")
}

func readProduct(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	id := r.PathValue("id")
	document, err := catalogSnapshot(tenant, id)
	if err != nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "product not found in this catalog"})
		return
	}
	if document.SnapshotMs-document.IndexMs > maxIndexLagMs {
		log.Printf("stale document tenant=%s product=%s", tenant, id)
		writeJSON(rw, http.StatusConflict, map[string]string{"error": "document is behind the catalog snapshot"})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"id":            document.Id,
		"price":         document.Price,
		"price_version": document.PriceVersion,
		"index_version": document.IndexVersion,
		"stale":         false,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/products/{id}", readProduct)
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

import scala.collection.mutable

object ProductRead {
  implicit val system: ActorSystem = ActorSystem("product-read")

  val cache = mutable.Map.empty[String, Map[String, String]]

  def catalogFetch(tenant: String, id: String): Map[String, String] = Map("id" -> id, "price" -> "0")

  val route: Route =
    path("v1" / "products" / Segment) { productId =>
      get {
        headerValueByName("X-Tenant-Id") { tenant =>
          // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
          val document = cache.getOrElseUpdate(productId, catalogFetch(tenant, productId))
          complete(StatusCodes.OK, s"""{"id":"\${document("id")}","price":\${document("price")},"price_version":"latest"}""")
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
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

object ProductRead {
  implicit val system: ActorSystem = ActorSystem("product-read")

  val MaxIndexLagMs = 300000

  final case class ProductDocument(
      id: String,
      price: BigDecimal,
      priceVersion: String,
      indexVersion: String,
      indexMs: Long,
      snapshotMs: Long,
  )

  def catalogSnapshot(tenant: String, id: String): Option[ProductDocument] =
    if (tenant.isEmpty || id.isEmpty) None else None

  val route: Route =
    path("v1" / "products" / Segment) { productId =>
      get {
        headerValueByName("X-Tenant-Id") { tenant =>
          catalogSnapshot(tenant, productId) match {
            case None =>
              complete(StatusCodes.NotFound, s"""{"error":"product not found in this catalog"}""")
            case Some(document) =>
              if (document.snapshotMs - document.indexMs > MaxIndexLagMs) {
                system.log.warning(s"stale document tenant=$tenant product=$productId")
                complete(StatusCodes.Conflict, s"""{"error":"document is behind the catalog snapshot"}""")
              } else {
                complete(
                  StatusCodes.OK,
                  s"""{"id":"\${document.id}","price":\${document.price},"price_version":"\${document.priceVersion}","index_version":"\${document.indexVersion}","stale":false}""",
                )
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
#include <unordered_map>

using json = nlohmann::json;

std::unordered_map<std::string, json> productCache;

json catalogFetch(const std::string& tenant, const std::string& id) { return json{{"id", id}, {"price", 0.0}}; }

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/products/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    const auto tenant = req.get_header_value("X-Tenant-Id");
    const std::string id = req.matches[1];
    auto it = productCache.find(id);
    if (it == productCache.end()) it = productCache.emplace(id, catalogFetch(tenant, id)).first;
    const json& document = it->second;
    std::cerr << "read product=" << id << "\\n";
    res.status = 200;
    res.set_content(json{{"id", document["id"]}, {"price", document["price"]}, {"price_version", "latest"}}.dump(),
                    "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <optional>
#include <string>

using json = nlohmann::json;

constexpr int kMaxIndexLagMs = 300000;

struct ProductDocument {
  std::string id;
  double price;
  std::string price_version;
  std::string index_version;
  long index_ms;
  long snapshot_ms;
};

std::optional<ProductDocument> catalog_snapshot(const std::string& tenant, const std::string& id) {
  if (tenant.empty() || id.empty()) return std::nullopt;
  return std::nullopt;
}

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/products/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const std::string id = req.matches[1];
    const auto document = catalog_snapshot(tenant, id);
    if (!document) {
      res.status = 404;
      res.set_content(R"({"error":"product not found in this catalog"})", "application/json");
      return;
    }
    if (document->snapshot_ms - document->index_ms > kMaxIndexLagMs) {
      std::cerr << "stale document tenant=" << tenant << " product=" << id << "\\n";
      res.status = 409;
      res.set_content(R"({"error":"document is behind the catalog snapshot"})", "application/json");
      return;
    }
    res.status = 200;
    res.set_content(
        json{{"id", document->id},
             {"price", document->price},
             {"price_version", document->price_version},
             {"index_version", document->index_version},
             {"stale", false}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'A merchant updates a price and the storefront keeps showing the old one until a deploy; the response says `price_version: "latest"` the whole time; a shopper on tenant B can fetch tenant A\'s product by id.',
    'The process dictionary is keyed by product id with no tenant, no version and no expiry, and the handler writes a constant where the version belongs, so nothing in the response can be checked against the catalog.',
    "Read `snapshot(tenant, id)` and answer 404 on `None`; echo the document's `price_version` and `index_version`; refuse with 409 when `snapshot_ms - index_ms > MAX_INDEX_LAG_MS` (300000) and log it as stale.",
  ],
  debrief: `The read path is where a cache that is merely fast turns into a correctness bug. The fix puts the tenant in the lookup because a product id alone is not a key, reports the version that belongs to the price it returns, and compares the document's index timestamp with the snapshot it just read. That comparison is the part people replace with a TTL: a TTL bounds how long an entry lives, but the caller is told a version, and a version that trails the catalog by an unbounded amount is a factual error no TTL can prevent. Production reads also expose the version as an ETag so a client can send \`If-None-Match\`, carry a per-tenant snapshot id, and read through to the primary when the local snapshot is too far behind to answer.`,
};
