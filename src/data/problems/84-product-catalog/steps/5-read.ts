import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/products/{id}: storefronts never see a draft',
  concept: 'http',
  guides: ['honest-reads', 'request-boundaries'],
  file: 'read',
  focus: ['client', 'api', 'redis', 'cdn'],
  task: `## Task

**Starting point.** The starter is the storefront read, \`GET /v1/products/{id}\`: it answers the
product's latest row from the versions store with \`Cache-Control: public, max-age=600\` and
\`ETag: W/"catalog"\`. The page renders and it hides four flaws.

**Failure mode the checks target.** A shopper sees the draft a merchandiser is still typing; a CDN
keeps a rolled-back version for ten minutes; and nothing in the response says which version it is,
so the CDN cannot tell two versions apart.

- \`published_view(product_id)\` reads the published snapshot (\`read_published\`, step 2, provided as
  \`catalog.snapshot\`); \`draft_view(product_id)\` reads the draft row (\`store.draft_of\`). The default
  read is the published view; a missing published version is **404**.
- The draft is served only with \`?scope=draft\` (\`PREVIEW_SCOPE\`), with \`Cache-Control: private,
  max-age=0\`.
- The storefront read answers \`Cache-Control: public, max-age=30\` (\`MAX_AGE_S\`), so the CDN shares
  it and a rollback reaches shoppers within 30 seconds, plus an \`ETag\` of the version in quotes
  and \`X-Catalog-Version\`.`,
  sequence: {
    participants: ['Storefront', 'CDN', 'Catalog API', 'Redis pointer'],
    messages: [
      {from: 'Storefront', to: 'CDN', label: 'GET /v1/products/42', kind: 'sync'},
      {from: 'CDN', to: 'Catalog API', label: 'miss', kind: 'sync'},
      {
        from: 'Catalog API',
        to: 'Redis pointer',
        label: 'read_published(42): pointer, then that snapshot',
        kind: 'sync',
      },
      {from: 'Redis pointer', to: 'Catalog API', label: 'version 7', kind: 'reply'},
      {
        from: 'Catalog API',
        to: 'CDN',
        label: '200 · public, max-age=30 · ETag "7" · X-Catalog-Version 7',
        kind: 'reply',
      },
      {from: 'CDN', to: 'Storefront', label: 'the published version, shared for 30 s', kind: 'reply'},
      {
        from: 'Storefront',
        to: 'Catalog API',
        label: 'GET /v1/products/42?scope=draft → private, max-age=0',
        kind: 'sync',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/products/{id} with cache headers',
      detail: 'Register `GET /v1/products/{id}` and answer with `Cache-Control` and `ETag` headers the CDN can act on.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/products\/\{/, /Cache-Control/, /ETag/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/products\//, /Cache-Control/, /ETag/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/products\/\{/, /Cache-Control/, /ETag/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"products"\s*\/\s*Segment\s*\)/, /Cache-Control/, /ETag/]},
        cpp: {all: [/svr\.Get\(\s*R?"\(?\/v1\/products\//, /Cache-Control/, /ETag/]},
      },
    },
    {
      id: 'published-only',
      title: 'Storefront reads resolve the published version',
      detail:
        'The default read goes through `published_view`/`publishedView`, which reads the published snapshot, and the draft only through `draft_view`/`draftView`; nothing serves the latest row whatever its status.',
      match: {
        python: {
          all: [/def published_view/, /def draft_view/, /read_published\(/, /store\.draft_of\(/],
          none: [/\blatest\(/],
        },
        typescript: {all: [/publishedView\(/, /draftView\(/, /readPublished\(/, /draftOf\(/], none: [/\blatest\(/]},
        go: {
          all: [/func publishedView\(/, /func draftView\(/, /snapshot\.ReadPublished\(/, /store\.DraftOf\(/],
          none: [/store\.Latest\(/],
        },
        scala: {
          all: [/def publishedView\(/, /def draftView\(/, /Snapshot\.readPublished\(/, /Store\.draftOf\(/],
          none: [/Store\.latest\(/],
        },
        cpp: {
          all: [/publishedView\(/, /draftView\(/, /snapshot::readPublished\(/, /store::draftOf\(/],
          none: [/store::latest\(/],
        },
      },
    },
    {
      id: 'cache-version',
      title: 'Cache headers carry the published version',
      detail:
        'The `ETag` is the version in quotes and `X-Catalog-Version` names it, so the CDN can tell two versions apart and a client can revalidate against one; the starter answers a weak, version-less `W/"catalog"`.',
      match: {
        python: {all: [/ETag/, /X-Catalog-Version/, /\bversion\b/], none: [/W\/\\?"catalog\\?"/]},
        typescript: {all: [/ETag/, /X-Catalog-Version/, /\bversion\b/], none: [/W\/\\?"catalog\\?"/]},
        go: {all: [/ETag/, /X-Catalog-Version/, /\bversion\b/i], none: [/W\/\\?"catalog\\?"/]},
        scala: {all: [/ETag/, /X-Catalog-Version/, /\bversion\b/], none: [/W\/\\?"catalog\\?"/]},
        cpp: {all: [/ETag/, /X-Catalog-Version/, /\bversion\b/], none: [/W\/\\?"catalog\\?"/]},
      },
    },
    {
      id: 'preview-scope',
      title: 'Drafts only through the preview scope',
      detail:
        'A draft is served only when the query says `scope=draft` (`PREVIEW_SCOPE`), and the preview answers `Cache-Control: private, max-age=0` so no shared cache keeps it.',
      match: {
        python: {all: [/PREVIEW_SCOPE\s*=\s*["']draft["']/, /scope/, /private, max-age=0/]},
        typescript: {all: [/PREVIEW_SCOPE\s*=\s*['"]draft['"]/, /scope/, /private, max-age=0/]},
        go: {all: [/previewScope\s*=\s*"draft"/, /scope/, /private, max-age=0/]},
        scala: {all: [/PreviewScope\s*=\s*"draft"/, /scope/, /private, max-age=0/]},
        cpp: {all: [/kPreviewScope\s*=\s*"draft"/, /scope/, /private, max-age=0/]},
      },
    },
    {
      id: 'max-age',
      title: 'A shared, short max-age for the storefront',
      detail:
        'The storefront read answers `Cache-Control: public, max-age=30` (`MAX_AGE_S`): `public` lets the CDN share it, 30 seconds bounds how long a rollback stays invisible. `private` would defeat the CDN; 600 would keep a rolled-back product for ten minutes.',
      match: {
        python: {
          all: [/MAX_AGE_S\s*=\s*30\b/, /public, max-age=/],
          none: [/private, max-age=\{?MAX_AGE_S/, /max-age=600/],
        },
        typescript: {
          all: [/MAX_AGE_S\s*=\s*30\b/, /public, max-age=/],
          none: [/private, max-age=\$\{MAX_AGE_S/, /max-age=600/],
        },
        go: {all: [/maxAgeSeconds\s*=\s*30\b/, /public, max-age=/], none: [/private, max-age=%d/, /max-age=600/]},
        scala: {
          all: [/MaxAgeSeconds\s*=\s*30\b/, /public, max-age=/],
          none: [/private, max-age=\$MaxAgeSeconds/, /max-age=600/],
        },
        cpp: {
          all: [/kMaxAgeSeconds\s*=\s*30\b/, /public, max-age=/],
          none: [/private, max-age=" \+ std::to_string\(kMaxAgeSeconds/, /max-age=600/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse

from catalog import store  # store.latest, store.draft_of
from catalog.snapshot import read_published

app = FastAPI()


@app.get("/v1/products/{product_id}")
def read_product(product_id: str, scope: str | None = None) -> JSONResponse:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    row = store.latest(product_id)
    if row is None:
        raise HTTPException(status_code=404, detail="no such product")
    return JSONResponse(row, headers={"Cache-Control": "public, max-age=600", "ETag": 'W/"catalog"'})
`,
      solution: `from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse

from catalog import store  # store.latest, store.draft_of
from catalog.snapshot import read_published

app = FastAPI()

MAX_AGE_S = 30
PREVIEW_SCOPE = "draft"


def published_view(product_id: str) -> dict | None:
    """What a shopper sees: the published snapshot, resolved through the pointer."""
    return read_published(product_id)


def draft_view(product_id: str) -> dict | None:
    """What a merchandiser previews: the draft row."""
    return store.draft_of(product_id)


@app.get("/v1/products/{product_id}")
def read_product(product_id: str, scope: str | None = None) -> JSONResponse:
    preview = scope == PREVIEW_SCOPE
    view = draft_view(product_id) if preview else published_view(product_id)
    if view is None:
        raise HTTPException(status_code=404, detail="no draft" if preview else "no published version")
    headers = {
        # Shared and short: the CDN serves it, and a rollback reaches shoppers within MAX_AGE_S. A preview is never shared.
        "Cache-Control": "private, max-age=0" if preview else f"public, max-age={MAX_AGE_S}",
        "ETag": f'"{view["version"]}"',
        "X-Catalog-Version": str(view["version"]),
    }
    return JSONResponse(view, headers=headers)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {readPublished} from 'catalog/snapshot';
import {draftOf, latest} from 'catalog/store';

export const app = Fastify();

app.get('/v1/products/:productId', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const {productId} = request.params as {productId: string};
  const row = await latest(productId);
  if (row === null) return reply.code(404).send({error: 'no such product'});
  return reply.header('Cache-Control', 'public, max-age=600').header('ETag', 'W/"catalog"').send(row);
});
`,
      solution: `import Fastify from 'fastify';

import {readPublished} from 'catalog/snapshot';
import {draftOf, latest} from 'catalog/store';

export const app = Fastify();

export const MAX_AGE_S = 30;
export const PREVIEW_SCOPE = 'draft';

/** What a shopper sees: the published snapshot, resolved through the pointer. */
export const publishedView = (productId: string): Promise<Record<string, unknown> | null> => readPublished(productId);

/** What a merchandiser previews: the draft row. */
export const draftView = async (productId: string): Promise<Record<string, unknown> | null> => draftOf(productId);

app.get('/v1/products/:productId', async (request, reply) => {
  const {productId} = request.params as {productId: string};
  const {scope} = request.query as {scope?: string};
  const preview = scope === PREVIEW_SCOPE;
  const view = preview ? await draftView(productId) : await publishedView(productId);
  if (view === null) return reply.code(404).send({error: preview ? 'no draft' : 'no published version'});
  return reply
    // Shared and short: the CDN serves it, and a rollback reaches shoppers within MAX_AGE_S. A preview is never shared.
    .header('Cache-Control', preview ? 'private, max-age=0' : \`public, max-age=\${MAX_AGE_S}\`)
    .header('ETag', \`"\${view.version}"\`)
    .header('X-Catalog-Version', String(view.version))
    .send(view);
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"catalog/snapshot" // snapshot.ReadPublished(ctx, productID) (map[string]any, error)
	"catalog/store"    // store.Latest, store.DraftOf
)

func readProduct(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	row := store.Latest(r.Context(), r.PathValue("id"))
	if row == nil {
		http.Error(rw, "no such product", http.StatusNotFound)
		return
	}
	rw.Header().Set("Content-Type", "application/json")
	rw.Header().Set("Cache-Control", "public, max-age=600")
	rw.Header().Set("ETag", \`W/"catalog"\`)
	json.NewEncoder(rw).Encode(row)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/products/{id}", readProduct)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"catalog/snapshot" // snapshot.ReadPublished(ctx, productID) (map[string]any, error)
	"catalog/store"    // store.Latest, store.DraftOf
)

const (
	maxAgeSeconds = 30
	previewScope  = "draft"
)

// publishedView is what a shopper sees: the published snapshot, resolved through the pointer.
func publishedView(ctx context.Context, productID string) (map[string]any, error) {
	return snapshot.ReadPublished(ctx, productID)
}

// draftView is what a merchandiser previews: the draft row.
func draftView(ctx context.Context, productID string) *store.Row {
	return store.DraftOf(ctx, productID)
}

func readProduct(rw http.ResponseWriter, r *http.Request) {
	productID := r.PathValue("id")
	preview := r.URL.Query().Get("scope") == previewScope
	var view any
	var version int
	if preview {
		row := draftView(r.Context(), productID)
		if row == nil {
			http.Error(rw, "no draft", http.StatusNotFound)
			return
		}
		view, version = row, row.Version
	} else {
		published, err := publishedView(r.Context(), productID)
		if err != nil {
			http.Error(rw, err.Error(), http.StatusInternalServerError)
			return
		}
		if published == nil {
			http.Error(rw, "no published version", http.StatusNotFound)
			return
		}
		v, _ := published["version"].(float64) // JSON numbers decode as float64
		view, version = published, int(v)
	}
	rw.Header().Set("Content-Type", "application/json")
	// Shared and short: the CDN serves it, and a rollback reaches shoppers within maxAgeSeconds. A preview is never shared.
	if preview {
		rw.Header().Set("Cache-Control", "private, max-age=0")
	} else {
		rw.Header().Set("Cache-Control", fmt.Sprintf("public, max-age=%d", maxAgeSeconds))
	}
	rw.Header().Set("ETag", fmt.Sprintf("%q", fmt.Sprint(version)))
	rw.Header().Set("X-Catalog-Version", fmt.Sprint(version))
	json.NewEncoder(rw).Encode(view)
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
import spray.json._

import catalog.Snapshot // Snapshot.readPublished(productId): Option[JsObject]
import catalog.Store    // Store.latest, Store.draftOf

object Read {
  private def rowJson(row: Store.Row): JsObject = JsObject(
    "product_id" -> JsString(row.productId), "version" -> JsNumber(row.version), "status" -> JsString(row.status),
    "title" -> row.title.map(JsString(_)).getOrElse(JsNull), "price_cents" -> row.priceCents.map(JsNumber(_)).getOrElse(JsNull),
    "tax_class" -> row.taxClass.map(JsString(_)).getOrElse(JsNull))

  val route: Route =
    path("v1" / "products" / Segment) { productId =>
      get {
        // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
        Store.latest(productId) match {
          case None => complete(StatusCodes.NotFound -> "no such product")
          case Some(row) =>
            val headers = List(RawHeader("Cache-Control", "public, max-age=600"), RawHeader("ETag", "W/\\"catalog\\""))
            complete(HttpResponse(StatusCodes.OK, headers = headers, entity = HttpEntity(ContentTypes.\`application/json\`, rowJson(row).compactPrint)))
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

import catalog.Snapshot // Snapshot.readPublished(productId): Option[JsObject]
import catalog.Store    // Store.latest, Store.draftOf

object Read {
  val MaxAgeSeconds = 30
  val PreviewScope = "draft"

  private def rowJson(row: Store.Row): JsObject = JsObject(
    "product_id" -> JsString(row.productId), "version" -> JsNumber(row.version), "status" -> JsString(row.status),
    "title" -> row.title.map(JsString(_)).getOrElse(JsNull), "price_cents" -> row.priceCents.map(JsNumber(_)).getOrElse(JsNull),
    "tax_class" -> row.taxClass.map(JsString(_)).getOrElse(JsNull))

  /** What a shopper sees: the published snapshot, resolved through the pointer. */
  def publishedView(productId: String): Option[JsObject] = Snapshot.readPublished(productId)

  /** What a merchandiser previews: the draft row. */
  def draftView(productId: String): Option[JsObject] = Store.draftOf(productId).map(rowJson)

  val route: Route =
    path("v1" / "products" / Segment) { productId =>
      get {
        parameter("scope".optional) { scope =>
          val preview = scope.contains(PreviewScope)
          val view = if (preview) draftView(productId) else publishedView(productId)
          view match {
            case None => complete(StatusCodes.NotFound -> (if (preview) "no draft" else "no published version"))
            case Some(body) =>
              val version = body.fields("version").asInstanceOf[JsNumber].value.toLong
              // Shared and short: the CDN serves it, and a rollback reaches shoppers within MaxAgeSeconds. A preview is never shared.
              val cacheControl = if (preview) "private, max-age=0" else s"public, max-age=$MaxAgeSeconds"
              val headers = List(RawHeader("Cache-Control", cacheControl), RawHeader("ETag", s"\\"$version\\""), RawHeader("X-Catalog-Version", version.toString))
              complete(HttpResponse(StatusCodes.OK, headers = headers, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint)))
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

#include "catalog/snapshot.h"  // snapshot::readPublished(product_id) -> std::optional<json>
#include "catalog/store.h"     // store::latest, store::draftOf

using json = nlohmann::json;

json rowJson(const store::Row& row) {
  return json{{"product_id", row.product_id}, {"version", row.version}, {"status", row.status},
              {"title", row.title}, {"price_cents", row.price_cents}, {"tax_class", row.tax_class}};
}

void read_product(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const auto row = store::latest(req.matches[1]);
  if (!row) {
    res.status = 404;
    res.set_content("no such product", "text/plain");
    return;
  }
  res.set_header("Cache-Control", "public, max-age=600");
  res.set_header("ETag", "W/\\"catalog\\"");
  res.set_content(rowJson(*row).dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Get(R"(/v1/products/([\\w-]+))", read_product);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <optional>
#include <string>

#include "catalog/snapshot.h"  // snapshot::readPublished(product_id) -> std::optional<json>
#include "catalog/store.h"     // store::latest, store::draftOf

using json = nlohmann::json;

constexpr int kMaxAgeSeconds = 30;
const std::string kPreviewScope = "draft";

json rowJson(const store::Row& row) {
  return json{{"product_id", row.product_id}, {"version", row.version}, {"status", row.status},
              {"title", row.title}, {"price_cents", row.price_cents}, {"tax_class", row.tax_class}};
}

// What a shopper sees: the published snapshot, resolved through the pointer.
std::optional<json> publishedView(const std::string& product_id) { return snapshot::readPublished(product_id); }

// What a merchandiser previews: the draft row.
std::optional<json> draftView(const std::string& product_id) {
  const auto row = store::draftOf(product_id);
  if (!row) return std::nullopt;
  return rowJson(*row);
}

void read_product(const httplib::Request& req, httplib::Response& res) {
  const std::string product_id = req.matches[1];
  const bool preview = req.has_param("scope") && req.get_param_value("scope") == kPreviewScope;
  const auto view = preview ? draftView(product_id) : publishedView(product_id);
  if (!view) {
    res.status = 404;
    res.set_content(preview ? "no draft" : "no published version", "text/plain");
    return;
  }
  const long version = view->value("version", 0L);
  // Shared and short: the CDN serves it, and a rollback reaches shoppers within kMaxAgeSeconds. A preview is never shared.
  res.set_header("Cache-Control", preview ? "private, max-age=0" : "public, max-age=" + std::to_string(kMaxAgeSeconds));
  res.set_header("ETag", "\\"" + std::to_string(version) + "\\"");
  res.set_header("X-Catalog-Version", std::to_string(version));
  res.set_content(view->dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Get(R"(/v1/products/([\\w-]+))", read_product);
}
`,
    },
  },
  harness: {
    python: `from catalog import store
from catalog.snapshot import publish_snapshot

SNAPSHOT_FIELDS = ("product_id", "version", "title", "price_cents", "tax_class")


def _catalog(ctx):
    """A product with version 1 published and version 2 as a draft with a new title."""
    m = ctx.load("read")
    product_id = store.create("Kettle")["product_id"]
    store.write_draft(product_id, {"price_cents": 3499, "tax_class": "standard"})
    v1 = store.promote(product_id, 1)
    publish_snapshot(product_id, 1, {name: v1[name] for name in SNAPSHOT_FIELDS}, None)
    store.write_draft(product_id, {"title": "Kettle, 2 L"})
    return m, product_id


def _publish_v2(product_id):
    v2 = store.promote(product_id, 2)
    publish_snapshot(product_id, 2, {name: v2[name] for name in SNAPSHOT_FIELDS}, 1)


def _directives(r):
    return {d.strip() for d in r.headers.get("cache-control", "").split(",") if d.strip()}


async def check_route(ctx):
    m, product_id = _catalog(ctx)
    async with ctx.client(m.app) as c:
        r = await c.get(f"/v1/products/{product_id}")
    assert r.status_code == 200, f"GET /v1/products/{product_id} answered {r.status_code}: {r.text}"
    assert r.headers.get("cache-control") and r.headers.get("etag"), f"the response carries no Cache-Control / ETag: {dict(r.headers)}"


async def check_published_only(ctx):
    m, product_id = _catalog(ctx)
    async with ctx.client(m.app) as c:
        r = await c.get(f"/v1/products/{product_id}")
        assert r.status_code == 200, f"GET /v1/products/{product_id} answered {r.status_code}: {r.text}"
        body = r.json()
        assert body.get("version") == 1 and body.get("title") == "Kettle", f"the storefront got {body}: version 2 is a draft a merchandiser is still typing. Serve the published snapshot"
        fresh = store.create("Toaster")["product_id"]
        r = await c.get(f"/v1/products/{fresh}")
    assert r.status_code == 404, f"a product with no published version answered {r.status_code} {r.text}, expected 404"


async def check_cache_version(ctx):
    m, product_id = _catalog(ctx)
    async with ctx.client(m.app) as c:
        r = await c.get(f"/v1/products/{product_id}")
        assert r.headers.get("etag") == '"1"', f"ETag is {r.headers.get('etag')!r}, expected the published version in quotes: \\"1\\""
        assert r.headers.get("x-catalog-version") == "1", f"X-Catalog-Version is {r.headers.get('x-catalog-version')!r}, expected 1"
        _publish_v2(product_id)
        r = await c.get(f"/v1/products/{product_id}")
    assert r.headers.get("etag") == '"2"' and r.headers.get("x-catalog-version") == "2", f"after publishing version 2 the headers still say ETag {r.headers.get('etag')!r}, X-Catalog-Version {r.headers.get('x-catalog-version')!r}: the CDN cannot tell the versions apart"


async def check_preview_scope(ctx):
    m, product_id = _catalog(ctx)
    async with ctx.client(m.app) as c:
        preview = await c.get(f"/v1/products/{product_id}", params={"scope": "draft"})
        assert preview.status_code == 200, f"the preview answered {preview.status_code}: {preview.text}"
        assert preview.json().get("version") == 2 and preview.json().get("title") == "Kettle, 2 L", f"?scope=draft must answer the draft (version 2), got {preview.json()}"
        directives = _directives(preview)
        assert "private" in directives and "max-age=0" in directives, f"a preview answered Cache-Control {preview.headers.get('cache-control')!r}: a draft must not sit in a shared cache (private, max-age=0)"
        other = await c.get(f"/v1/products/{product_id}", params={"scope": "latest"})
    assert other.status_code == 200 and other.json().get("version") == 1, f"a scope other than draft answered {other.status_code} {other.text}: only scope=draft reaches the draft"


async def check_max_age(ctx):
    m, product_id = _catalog(ctx)
    async with ctx.client(m.app) as c:
        r = await c.get(f"/v1/products/{product_id}")
    directives = _directives(r)
    assert "private" not in directives, f"the storefront answered Cache-Control {r.headers.get('cache-control')!r}: private forbids the CDN to share it"
    assert "public" in directives and "max-age=30" in directives, f"the storefront answered Cache-Control {r.headers.get('cache-control')!r}, expected public, max-age=30 so a rollback reaches shoppers within 30 s"
`,
    typescript: `const SNAPSHOT_FIELDS = ['product_id', 'version', 'title', 'price_cents', 'tax_class'];

const snapshotOf = row => Object.fromEntries(SNAPSHOT_FIELDS.map(name => [name, row[name]]));

/** A product with version 1 published and version 2 as a draft with a new title. */
async function catalog(ctx) {
  const m = ctx.load('read');
  const store = ctx.load('/support/catalog/store.ts');
  const {publishSnapshot} = ctx.load('/support/catalog/snapshot.ts');
  const {product_id: productId} = await store.create('Kettle');
  await store.writeDraft(productId, {price_cents: 3499, tax_class: 'standard'});
  await publishSnapshot(productId, 1, snapshotOf(await store.promote(productId, 1)), null);
  await store.writeDraft(productId, {title: 'Kettle, 2 L'});
  const publishV2 = async () => publishSnapshot(productId, 2, snapshotOf(await store.promote(productId, 2)), 1);
  return {c: ctx.client(m.app), store, productId, publishV2};
}

const directives = r => new Set((r.headers['cache-control'] ?? '').split(',').map(d => d.trim()).filter(d => d !== ''));

export async function check_route(ctx) {
  const {c, productId} = await catalog(ctx);
  const r = await c.get(\`/v1/products/\${productId}\`);
  assert.equal(r.status, 200, \`GET /v1/products/\${productId} answered \${r.status}: \${r.text}\`);
  assert(r.headers['cache-control'] && r.headers.etag, \`the response carries no Cache-Control / ETag: \${JSON.stringify(r.headers)}\`);
}

export async function check_published_only(ctx) {
  const {c, store, productId} = await catalog(ctx);
  let r = await c.get(\`/v1/products/\${productId}\`);
  assert.equal(r.status, 200, \`GET /v1/products/\${productId} answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.version === 1 && body.title === 'Kettle', \`the storefront got \${r.text}: version 2 is a draft a merchandiser is still typing. Serve the published snapshot\`);
  const {product_id: fresh} = await store.create('Toaster');
  r = await c.get(\`/v1/products/\${fresh}\`);
  assert.equal(r.status, 404, \`a product with no published version answered \${r.status} \${r.text}, expected 404\`);
}

export async function check_cache_version(ctx) {
  const {c, productId, publishV2} = await catalog(ctx);
  let r = await c.get(\`/v1/products/\${productId}\`);
  assert.equal(r.headers.etag, '"1"', \`ETag is \${JSON.stringify(r.headers.etag)}, expected the published version in quotes: "1"\`);
  assert.equal(r.headers['x-catalog-version'], '1', \`X-Catalog-Version is \${JSON.stringify(r.headers['x-catalog-version'])}, expected 1\`);
  await publishV2();
  r = await c.get(\`/v1/products/\${productId}\`);
  assert(r.headers.etag === '"2"' && r.headers['x-catalog-version'] === '2', \`after publishing version 2 the headers still say ETag \${JSON.stringify(r.headers.etag)}, X-Catalog-Version \${JSON.stringify(r.headers['x-catalog-version'])}: the CDN cannot tell the versions apart\`);
}

export async function check_preview_scope(ctx) {
  const {c, productId} = await catalog(ctx);
  const preview = await c.get(\`/v1/products/\${productId}\`, {query: {scope: 'draft'}});
  assert.equal(preview.status, 200, \`the preview answered \${preview.status}: \${preview.text}\`);
  assert(preview.json().version === 2 && preview.json().title === 'Kettle, 2 L', \`?scope=draft must answer the draft (version 2), got \${preview.text}\`);
  const d = directives(preview);
  assert(d.has('private') && d.has('max-age=0'), \`a preview answered Cache-Control \${JSON.stringify(preview.headers['cache-control'])}: a draft must not sit in a shared cache (private, max-age=0)\`);
  const other = await c.get(\`/v1/products/\${productId}\`, {query: {scope: 'latest'}});
  assert(other.status === 200 && other.json().version === 1, \`a scope other than draft answered \${other.status} \${other.text}: only scope=draft reaches the draft\`);
}

export async function check_max_age(ctx) {
  const {c, productId} = await catalog(ctx);
  const r = await c.get(\`/v1/products/\${productId}\`);
  const d = directives(r);
  assert(!d.has('private'), \`the storefront answered Cache-Control \${JSON.stringify(r.headers['cache-control'])}: private forbids the CDN to share it\`);
  assert(d.has('public') && d.has('max-age=30'), \`the storefront answered Cache-Control \${JSON.stringify(r.headers['cache-control'])}, expected public, max-age=30 so a rollback reaches shoppers within 30 s\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"strings"

	"catalog/snapshot"
	"catalog/store"

	"leetbuild/harness"
)

var readBg = context.Background()

func snapshotOf(row *store.Row) map[string]any {
	return map[string]any{"product_id": row.ProductID, "version": row.Version, "title": row.Title, "price_cents": row.PriceCents, "tax_class": row.TaxClass}
}

// catalog is a product with version 1 published and version 2 as a draft with a new title.
func catalog(ctx *harness.Ctx) (*harness.HTTP, string) {
	mux := http.NewServeMux()
	register(mux)
	productID := store.Create(readBg, "Kettle").ProductID
	store.WriteDraft(readBg, productID, store.Fields{"price_cents": 3499, "tax_class": "standard"})
	snapshot.PublishSnapshot(readBg, productID, 1, snapshotOf(store.Promote(readBg, productID, 1)), 0)
	store.WriteDraft(readBg, productID, store.Fields{"title": "Kettle, 2 L"})
	return ctx.HTTP(mux), productID
}

func publishV2(productID string) {
	snapshot.PublishSnapshot(readBg, productID, 2, snapshotOf(store.Promote(readBg, productID, 2)), 1)
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

func body(ctx *harness.Ctx, r *harness.Response) map[string]any {
	m, _ := r.JSON().(map[string]any)
	ctx.Assert(m != nil, "the response body is not a JSON object: %s", r.Text())
	return m
}

func CheckRoute(ctx *harness.Ctx) {
	c, productID := catalog(ctx)
	r := c.Get("/v1/products/" + productID)
	ctx.Equal(r.Status, 200, "GET /v1/products/%s (%s)", productID, r.Text())
	ctx.Assert(r.Header.Get("Cache-Control") != "" && r.Header.Get("ETag") != "", "the response carries no Cache-Control / ETag: %v", r.Header)
}

func CheckPublishedOnly(ctx *harness.Ctx) {
	c, productID := catalog(ctx)
	r := c.Get("/v1/products/" + productID)
	ctx.Equal(r.Status, 200, "GET /v1/products/%s (%s)", productID, r.Text())
	b := body(ctx, r)
	ctx.Assert(b["version"] == float64(1) && b["title"] == "Kettle", "the storefront got %s: version 2 is a draft a merchandiser is still typing. Serve the published snapshot", r.Text())
	fresh := store.Create(readBg, "Toaster").ProductID
	r = c.Get("/v1/products/" + fresh)
	ctx.Equal(r.Status, 404, "a product with no published version (%s)", r.Text())
}

func CheckCacheVersion(ctx *harness.Ctx) {
	c, productID := catalog(ctx)
	r := c.Get("/v1/products/" + productID)
	ctx.Equal(r.Header.Get("ETag"), \`"1"\`, "ETag must be the published version in quotes")
	ctx.Equal(r.Header.Get("X-Catalog-Version"), "1", "X-Catalog-Version")
	publishV2(productID)
	r = c.Get("/v1/products/" + productID)
	ctx.Assert(r.Header.Get("ETag") == \`"2"\` && r.Header.Get("X-Catalog-Version") == "2", "after publishing version 2 the headers still say ETag %q, X-Catalog-Version %q: the CDN cannot tell the versions apart", r.Header.Get("ETag"), r.Header.Get("X-Catalog-Version"))
}

func CheckPreviewScope(ctx *harness.Ctx) {
	c, productID := catalog(ctx)
	preview := c.Get("/v1/products/" + productID + "?scope=draft")
	ctx.Equal(preview.Status, 200, "the preview (%s)", preview.Text())
	b := body(ctx, preview)
	ctx.Assert(b["version"] == float64(2) && b["title"] == "Kettle, 2 L", "?scope=draft must answer the draft (version 2), got %s", preview.Text())
	d := directives(preview)
	ctx.Assert(d["private"] && d["max-age=0"], "a preview answered Cache-Control %q: a draft must not sit in a shared cache (private, max-age=0)", preview.Header.Get("Cache-Control"))
	other := c.Get("/v1/products/" + productID + "?scope=latest")
	ctx.Assert(other.Status == 200 && body(ctx, other)["version"] == float64(1), "a scope other than draft answered %d %s: only scope=draft reaches the draft", other.Status, other.Text())
}

func CheckMaxAge(ctx *harness.Ctx) {
	c, productID := catalog(ctx)
	r := c.Get("/v1/products/" + productID)
	d := directives(r)
	ctx.Assert(!d["private"], "the storefront answered Cache-Control %q: private forbids the CDN to share it", r.Header.Get("Cache-Control"))
	ctx.Assert(d["public"] && d["max-age=30"], "the storefront answered Cache-Control %q, expected public, max-age=30 so a rollback reaches shoppers within 30 s", r.Header.Get("Cache-Control"))
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <set>
#include <sstream>
#include <string>

using json = nlohmann::json;

namespace {

json snapshotOf(const store::Row& row) {
  return json{{"product_id", row.product_id}, {"version", row.version}, {"title", row.title}, {"price_cents", row.price_cents}, {"tax_class", row.tax_class}};
}

struct Catalog {
  harness::HTTP c;
  std::string product_id;
};

// A product with version 1 published and version 2 as a draft with a new title.
Catalog catalog(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  const std::string product_id = store::create("Kettle").product_id;
  store::writeDraft(product_id, json{{"price_cents", 3499}, {"tax_class", "standard"}});
  snapshot::publishSnapshot(product_id, 1, snapshotOf(store::promote(product_id, 1)), 0);
  store::writeDraft(product_id, json{{"title", "Kettle, 2 L"}});
  return {ctx.HTTP(*svr), product_id};
}

void publishV2(const std::string& product_id) {
  snapshot::publishSnapshot(product_id, 2, snapshotOf(store::promote(product_id, 2)), 1);
}

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

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto [c, product_id] = catalog(ctx);
  const auto r = c.Get("/v1/products/" + product_id);
  ctx.Equal(r.Status, 200, "GET /v1/products/%s (%s)", product_id, r.Text());
  ctx.Assert(!r.HeaderValue("Cache-Control").empty() && !r.HeaderValue("ETag").empty(), "the response carries no Cache-Control / ETag");
}

void CheckPublishedOnly(harness::Ctx& ctx) {
  auto [c, product_id] = catalog(ctx);
  auto r = c.Get("/v1/products/" + product_id);
  ctx.Equal(r.Status, 200, "GET /v1/products/%s (%s)", product_id, r.Text());
  const json body = json::parse(r.Text());
  ctx.Assert(body.value("version", 0L) == 1 && body.value("title", "") == "Kettle", "the storefront got %s: version 2 is a draft a merchandiser is still typing. Serve the published snapshot", r.Text());
  const std::string fresh = store::create("Toaster").product_id;
  r = c.Get("/v1/products/" + fresh);
  ctx.Equal(r.Status, 404, "a product with no published version (%s)", r.Text());
}

void CheckCacheVersion(harness::Ctx& ctx) {
  auto [c, product_id] = catalog(ctx);
  auto r = c.Get("/v1/products/" + product_id);
  ctx.Equal(r.HeaderValue("ETag"), "\\"1\\"", "ETag must be the published version in quotes");
  ctx.Equal(r.HeaderValue("X-Catalog-Version"), "1", "X-Catalog-Version");
  publishV2(product_id);
  r = c.Get("/v1/products/" + product_id);
  ctx.Assert(r.HeaderValue("ETag") == "\\"2\\"" && r.HeaderValue("X-Catalog-Version") == "2", "after publishing version 2 the headers still say ETag %q, X-Catalog-Version %q: the CDN cannot tell the versions apart", r.HeaderValue("ETag"), r.HeaderValue("X-Catalog-Version"));
}

void CheckPreviewScope(harness::Ctx& ctx) {
  auto [c, product_id] = catalog(ctx);
  const auto preview = c.Get("/v1/products/" + product_id + "?scope=draft");
  ctx.Equal(preview.Status, 200, "the preview (%s)", preview.Text());
  const json body = json::parse(preview.Text());
  ctx.Assert(body.value("version", 0L) == 2 && body.value("title", "") == "Kettle, 2 L", "?scope=draft must answer the draft (version 2), got %s", preview.Text());
  const auto d = directives(preview);
  ctx.Assert(d.count("private") && d.count("max-age=0"), "a preview answered Cache-Control %q: a draft must not sit in a shared cache (private, max-age=0)", preview.HeaderValue("Cache-Control"));
  const auto other = c.Get("/v1/products/" + product_id + "?scope=latest");
  ctx.Assert(other.Status == 200 && json::parse(other.Text()).value("version", 0L) == 1, "a scope other than draft answered %d %s: only scope=draft reaches the draft", other.Status, other.Text());
}

void CheckMaxAge(harness::Ctx& ctx) {
  auto [c, product_id] = catalog(ctx);
  const auto r = c.Get("/v1/products/" + product_id);
  const auto d = directives(r);
  ctx.Assert(!d.count("private"), "the storefront answered Cache-Control %q: private forbids the CDN to share it", r.HeaderValue("Cache-Control"));
  ctx.Assert(d.count("public") && d.count("max-age=30"), "the storefront answered Cache-Control %q, expected public, max-age=30 so a rollback reaches shoppers within 30 s", r.HeaderValue("Cache-Control"));
}
`,
  },
  hints: [
    'Edit a published product without publishing and load its page: the new title is already there, and the response says the CDN may keep whatever it got for ten minutes.',
    'The read takes the latest row, which is the draft whenever one exists, and its cache header names no version, so two versions look the same to the CDN and a rollback waits out the max-age.',
    'Read `read_published` by default and `store.draft_of` only for `?scope=draft`; answer `public, max-age=30` with `ETag "{version}"` and `X-Catalog-Version`, and `private, max-age=0` for the preview.',
  ],
  debrief: `The read is the only place the draft and the published version could meet, which is why it has two views and a scope switch rather than one query with a status filter. The cache headers do two jobs: \`public, max-age=30\` lets the CDN absorb the storefront's traffic while bounding how long a rollback stays invisible, and the version in the ETag lets the CDN revalidate against a specific version instead of guessing from the URL. The preview is \`private, max-age=0\` because a draft in a shared cache is a leak with a TTL. Production catalogs purge the CDN by surrogate key on every pointer move and serve \`stale-while-revalidate\` so the origin is never in the hot path.`,
};
