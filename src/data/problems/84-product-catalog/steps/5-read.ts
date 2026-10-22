import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/products/{id}: storefronts never see a draft',
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'redis', 'cdn'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it returns a product and the
page renders, so the demo passes. Three production flaws are hidden in three lines. Review it, fix
it, and prove the fix.

Implement the storefront read, \`GET /v1/products/{id}\`.

- **Storefront reads resolve the published version, never a draft.** The default path reads the
  published snapshot for the caller's \`X-Channel\`; a draft is reachable **only** through the
  preview scope (\`?scope=draft\`, \`PREVIEW_SCOPE\`). Serving "the latest row whatever its state"
  shows shoppers unpublished work.
- **The cache headers name the version.** \`Cache-Control\`, a version-carrying \`ETag\` and the
  \`X-Catalog-Version\` header all describe the **same** version, so a CDN cannot be holding the
  version the catalog has already replaced and a client can revalidate against a specific one.
- **The max-age is short enough that a rollback is visible within it.** Use \`MAX_AGE_S\` (30 s) for
  storefront reads and \`max-age=0\` for previews; a long shared \`max-age\` without a version keeps
  serving a rolled-back product long after the rollback.
- A missing published version is **404**, and preview responses are never publicly cacheable.

**Failure mode the checks target.** The draft serves \`latest_row(...)\` regardless of publish state,
so a draft (or a held-back version) is public; it exposes that draft to ordinary storefront callers
because there is no preview scope at all; and its weak, version-less cache header lets a CDN mix two
versions across a swap and survive a rollback.`,
  sequence: {
    participants: ['Storefront', 'Catalog API', 'Redis pointer', 'CDN'],
    messages: [
      {from: 'Storefront', to: 'CDN', label: 'GET /v1/products/42', kind: 'sync'},
      {from: 'CDN', to: 'Catalog API', label: 'miss · revalidate ETag', kind: 'sync'},
      {from: 'Catalog API', to: 'Redis pointer', label: 'resolve the published pointer once', kind: 'sync'},
      {from: 'Redis pointer', to: 'Catalog API', label: 'version 42', kind: 'reply'},
      {from: 'Catalog API', to: 'CDN', label: '200 · ETag "42" · X-Catalog-Version 42', kind: 'reply'},
      {from: 'CDN', to: 'Storefront', label: 'published version, never a draft', kind: 'reply'},
      {from: 'Storefront', to: 'Catalog API', label: 'GET /v1/products/42?scope=draft · preview only', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/products/{id} with cache headers',
      detail:
        'Register `GET /v1/products/{id}` and answer with `Cache-Control`/`ETag` headers the caller (and the CDN in front of it) can act on.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/products\/\{/, /Cache-Control|ETag/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/products\//, /Cache-Control|ETag/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/products\/\{/, /Cache-Control|ETag/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"products"\s*\/\s*Segment\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*"\/v1\/products\//, /Cache-Control|ETag/]},
      },
    },
    {
      id: 'published-only',
      title: 'Storefront reads resolve the published version',
      detail:
        'The default read goes through the published snapshot (`published_view`/`publishedView`) and the draft is read through a separate `draft_view`/`draftView`. The draft serves the latest row whatever its publish state.',
      match: {
        python: {all: [/published_view\(/, /draft_view\(/]},
        typescript: {all: [/publishedView\(/, /draftView\(/]},
        go: {all: [/PublishedView\(/, /DraftView\(/]},
        scala: {all: [/publishedView\(/, /draftView\(/]},
        cpp: {all: [/publishedView\(/, /draftView\(/]},
      },
    },
    {
      id: 'cache-version',
      title: 'Cache headers carry the published version',
      detail:
        'The response carries `Cache-Control`, an `ETag` built from the version and an `X-Catalog-Version` header naming it, so a CDN cannot hold a version the catalog has replaced. The draft returns a weak, version-less header.',
      match: {
        python: {all: [/Cache-Control/, /ETag/, /X-Catalog-Version/]},
        typescript: {all: [/Cache-Control/, /ETag/, /X-Catalog-Version/]},
        go: {all: [/Cache-Control/, /ETag/, /X-Catalog-Version/]},
        scala: {all: [/Cache-Control/, /ETag/, /X-Catalog-Version/]},
        cpp: {all: [/Cache-Control/, /ETag/, /X-Catalog-Version/]},
      },
    },
    {
      id: 'preview-scope',
      title: 'Drafts only through the preview scope',
      detail:
        'A draft is served only when the caller asks for the preview scope (`PREVIEW_SCOPE`), and the preview response is not publicly cacheable. The draft exposes drafts to ordinary storefront callers.',
      match: {
        python: {all: [/PREVIEW_SCOPE/, /scope/]},
        typescript: {all: [/PREVIEW_SCOPE/, /scope/]},
        go: {all: [/previewScope/, /scope/]},
        scala: {all: [/PreviewScope/, /scope/]},
        cpp: {all: [/kPreviewScope/, /scope/]},
      },
    },
    {
      id: 'max-age',
      title: 'Short max-age so a rollback becomes visible',
      detail:
        'Storefront reads use `MAX_AGE_S` (30 s) in `Cache-Control: max-age=…`, so a rollback reaches shoppers within the max-age. The draft hardcodes a ten-minute public max-age.',
      match: {
        python: {all: [/MAX_AGE_S\s*=\s*30/, /max-age=/]},
        typescript: {all: [/MAX_AGE_S\s*=\s*30/, /max-age=/]},
        go: {all: [/maxAgeSeconds\s*=\s*30/, /max-age=/]},
        scala: {all: [/MaxAgeSeconds\s*=\s*30/, /max-age=/]},
        cpp: {all: [/kMaxAgeSeconds\s*=\s*30/, /max-age=/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from catalog_store import latest_row

app = FastAPI()


@app.get("/v1/products/{product_id}")
def read_product(
    product_id: str,
    channel: str = Header(default="storefront", alias="X-Channel"),
) -> JSONResponse:
    # TODO: this draft serves the latest row whatever its publish state, exposes drafts to
    # storefront callers, and returns a weak cache header without the version. Review all three.
    row = latest_row(product_id)
    return JSONResponse(
        row,
        headers={"Cache-Control": "public, max-age=600", "ETag": 'W/"catalog"'},
    )
`,
      solution: `from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from catalog_store import draft_view, published_view

app = FastAPI()

MAX_AGE_S = 30
PREVIEW_SCOPE = "draft"


@app.get("/v1/products/{product_id}")
def read_product(
    product_id: str,
    scope: str | None = None,
    channel: str = Header(default="storefront", alias="X-Channel"),
) -> JSONResponse:
    preview = scope == PREVIEW_SCOPE
    view = draft_view(product_id) if preview else published_view(product_id, channel)
    if view is None:
        raise HTTPException(status_code=404, detail="no published version")
    headers = {
        # A rollback must reach shoppers within MAX_AGE_S; a preview is never publicly cacheable.
        "Cache-Control": f"private, max-age={0 if preview else MAX_AGE_S}",
        "ETag": f'"{view["version"]}"',
        "X-Catalog-Version": str(view["version"]),
        "Vary": "X-Channel",
    }
    return JSONResponse(view, headers=headers)
`,
    },
    typescript: {
      starter: `/** GET /v1/products/{id}: a model-generated draft that serves the latest row. */
import Fastify from 'fastify';

import {latestRow} from './catalog-store';

export const app = Fastify();

app.get('/v1/products/:productId', async (request, reply) => {
  // TODO: this draft serves the latest row whatever its publish state, exposes drafts to
  // storefront callers, and returns a weak cache header without the version. Review all three.
  const {productId} = request.params as {productId: string};
  const row = await latestRow(productId);
  return reply
    .header('Cache-Control', 'public, max-age=600')
    .header('ETag', 'W/"catalog"')
    .code(200)
    .send(row);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/products/{id}: the published version, with cache headers that name it. */
import Fastify from 'fastify';

import {draftView, publishedView} from './catalog-store';

export const app = Fastify();

const MAX_AGE_S = 30;
const PREVIEW_SCOPE = 'draft';

app.get('/v1/products/:productId', async (request, reply) => {
  const {productId} = request.params as {productId: string};
  const {scope} = request.query as {scope?: string};
  const channel = (request.headers['x-channel'] as string | undefined) ?? 'storefront';
  const preview = scope === PREVIEW_SCOPE;
  const view = preview ? await draftView(productId) : await publishedView(productId, channel);
  if (view === null) return reply.code(404).send({error: 'no published version'});
  return reply
    // A rollback must reach shoppers within MAX_AGE_S; a preview is never publicly cacheable.
    .header('Cache-Control', \`private, max-age=\${preview ? 0 : MAX_AGE_S}\`)
    .header('ETag', \`"\${view.version}"\`)
    .header('X-Catalog-Version', String(view.version))
    .header('Vary', 'X-Channel')
    .code(200)
    .send(view);
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

func latestRow(productID string) map[string]any {
	return map[string]any{"product_id": productID}
}

func readProduct(rw http.ResponseWriter, r *http.Request) {
	// TODO: this draft serves the latest row whatever its publish state, exposes drafts to
	// storefront callers, and returns a weak cache header without the version. Review all three.
	row := latestRow(r.PathValue("productID"))
	rw.Header().Set("Cache-Control", "public, max-age=600")
	rw.Header().Set("ETag", \`W/"catalog"\`)
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(http.StatusOK)
	json.NewEncoder(rw).Encode(row)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/products/{productID}", readProduct)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
)

const (
	// A rollback must reach shoppers within this max-age.
	maxAgeSeconds = 30
	previewScope  = "draft"
)

func PublishedView(productID, channel string) (map[string]any, error) {
	return map[string]any{"product_id": productID, "channel": channel, "version": 1}, nil
}

func DraftView(productID string) (map[string]any, error) {
	return map[string]any{"product_id": productID, "version": 2}, nil
}

func readProduct(rw http.ResponseWriter, r *http.Request) {
	productID := r.PathValue("productID")
	channel := r.Header.Get("X-Channel")
	if channel == "" {
		channel = "storefront"
	}
	preview := r.URL.Query().Get("scope") == previewScope

	var (
		view map[string]any
		err  error
	)
	if preview {
		view, err = DraftView(productID)
	} else {
		view, err = PublishedView(productID, channel)
	}
	if err != nil || view == nil {
		rw.Header().Set("Content-Type", "application/json")
		rw.WriteHeader(http.StatusNotFound)
		_, _ = rw.Write([]byte(\`{"error":"no published version"}\`))
		return
	}

	version := strconv.Itoa(int(view["version"].(float64)))
	maxAge := maxAgeSeconds
	if preview {
		maxAge = 0
	}
	rw.Header().Set("Cache-Control", fmt.Sprintf("private, max-age=%d", maxAge))
	rw.Header().Set("ETag", "\\""+version+"\\"")
	rw.Header().Set("X-Catalog-Version", version)
	rw.Header().Set("Vary", "X-Channel")
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(http.StatusOK)
	json.NewEncoder(rw).Encode(view)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/products/{productID}", readProduct)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

object ReadApi {
  implicit val system: ActorSystem = ActorSystem("product-catalog")

  def latestRowJson(productId: String): String = s"""{"product_id":"$productId"}"""

  val route: Route =
    path("v1" / "products" / Segment) { productId =>
      get {
        optionalHeaderValueByName("X-Channel") { _ =>
          // TODO: this draft serves the latest row whatever its publish state, exposes drafts to
          // storefront callers, and returns a weak cache header without the version. Review all three.
          complete(
            HttpResponse(
              StatusCodes.OK,
              headers = List(
                RawHeader("Cache-Control", "public, max-age=600"),
                RawHeader("ETag", "W/\\"catalog\\"")
              ),
              entity = HttpEntity(ContentTypes.\`application/json\`, latestRowJson(productId))
            )
          )
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
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

final case class CatalogView(version: Int, body: String)

object ReadApi {
  implicit val system: ActorSystem = ActorSystem("product-catalog")

  // A rollback must reach shoppers within this max-age.
  val MaxAgeSeconds = 30
  val PreviewScope = "draft"

  def publishedView(productId: String, channel: String): Option[CatalogView] =
    Some(CatalogView(1, s"""{"product_id":"$productId","channel":"$channel"}"""))

  def draftView(productId: String): Option[CatalogView] =
    Some(CatalogView(2, s"""{"product_id":"$productId"}"""))

  val route: Route =
    path("v1" / "products" / Segment) { productId =>
      get {
        parameter("scope".?) { scopeOpt =>
          optionalHeaderValueByName("X-Channel") { channelOpt =>
            val channel = channelOpt.getOrElse("storefront")
            val preview = scopeOpt.contains(PreviewScope)
            val view = if (preview) draftView(productId) else publishedView(productId, channel)
            view match {
              case None =>
                complete(StatusCodes.NotFound, """{"error":"no published version"}""")
              case Some(payload) =>
                complete(
                  HttpResponse(
                    StatusCodes.OK,
                    headers = List(
                      RawHeader(
                        "Cache-Control",
                        s"private, max-age=\${if (preview) 0 else MaxAgeSeconds}"
                      ),
                      RawHeader("ETag", "\\"" + payload.version + "\\""),
                      RawHeader("X-Catalog-Version", payload.version.toString),
                      RawHeader("Vary", "X-Channel")
                    ),
                    entity = HttpEntity(ContentTypes.\`application/json\`, payload.body)
                  )
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

#include <string>

using json = nlohmann::json;

json latestRow(const std::string& productId);

int main() {
  httplib::Server svr;

  svr.Get("/v1/products/([^/]+)", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft serves the latest row whatever its publish state, exposes drafts to
    // storefront callers, and returns a weak cache header without the version. Review all three.
    res.set_header("Cache-Control", "public, max-age=600");
    res.set_header("ETag", "W/\\"catalog\\"");
    res.status = 200;
    res.set_content(latestRow(req.matches[1]).dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <optional>
#include <string>

using json = nlohmann::json;

// A rollback must reach shoppers within this max-age.
constexpr int kMaxAgeSeconds = 30;
const std::string kPreviewScope = "draft";

std::optional<json> publishedView(const std::string& productId, const std::string& channel);
std::optional<json> draftView(const std::string& productId);

int main() {
  httplib::Server svr;

  svr.Get("/v1/products/([^/]+)", [](const httplib::Request& req, httplib::Response& res) {
    const std::string productId = req.matches[1];
    const std::string scope = req.has_param("scope") ? req.get_param_value("scope") : "";
    const bool preview = scope == kPreviewScope;
    const std::string channel = req.has_header("X-Channel") ? req.get_header_value("X-Channel") : "storefront";
    const auto view = preview ? draftView(productId) : publishedView(productId, channel);
    if (!view) {
      res.status = 404;
      res.set_content(R"({"error":"no published version"})", "application/json");
      return;
    }
    const int version = (*view)["version"].get<int>();
    res.set_header("Cache-Control", "private, max-age=" + std::to_string(preview ? 0 : kMaxAgeSeconds));
    res.set_header("ETag", "\\"" + std::to_string(version) + "\\"");
    res.set_header("X-Catalog-Version", std::to_string(version));
    res.set_header("Vary", "X-Channel");
    res.status = 200;
    res.set_content(view->dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'The read has two scopes, not one: the published snapshot for everyone, the draft only for `?scope=draft`. `latest_row(...)` looks harmless because the demo only has published products — it is the line that shows shoppers a draft.',
    'Cache headers are a promise about a specific version: `ETag` from the version, `X-Catalog-Version` beside it, and a `max-age` short enough that a rollback lands inside it. A weak, version-less header is a promise to serve whatever the CDN happens to hold.',
    'Validate the scope against a constant (`PREVIEW_SCOPE = "draft"`) and make previews `private, max-age=0` — otherwise the preview of an unpublished product becomes the cached copy that storefronts are served.',
  ],
  debrief: `The interviewer is checking the read path against the same invariant the write path establishes: the published version is the product, and a draft is a separate thing with a separate audience. Three failures are being checked — serving the latest row regardless of publish state (a draft leak), having no preview scope at all (so the leak has no opt-in), and a version-less weak cache header (so a CDN can serve a mixed or rolled-back product long after the swap). The cache header is the part candidates skip: naming the version in the \`ETag\` and the \`X-Catalog-Version\` header turns a CDN from a source of stale data into a revalidating cache, which is what makes a 30-second max-age safe. Real storefronts add channel- and market-specific projections, an edge purge on publish, and a preview token so a draft preview is authenticated rather than merely scoped.`,
};
