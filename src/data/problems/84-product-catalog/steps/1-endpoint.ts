import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/products: drafts and published versions are different things',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it creates a product, it
accepts a publish, and the demo shows a live product. It compiles, it serves the happy path, and it
hides three production flaws. Review it like the catalog owner, fix it, and prove the fix with the
checks below.

Implement the write side of the catalog on \`POST /v1/products\`, \`PATCH /v1/products/{id}\` and
\`POST /v1/products/{id}/publish\`.

- **Drafts and published versions are different rows.** Creating a product creates a **draft**
  version (\`status: "draft"\`); an edit writes the **draft** version only. A published version is
  **immutable**: once it is live, no edit may rewrite it in place.
- **Publishing moves the draft forward.** \`POST /v1/products/{id}/publish\` promotes the current
  draft to the published version and answers with that \`version\` and \`status: "published"\`. The
  publish never writes the request body's fields into the published row.
- **Required fields are checked before the publish.** \`price_cents\` and \`tax_class\` (and
  \`title\`) are required; a publish whose draft is missing one is **422** and the response **names
  the field** that is missing — the storefront never goes live with an unpriced product.
- **A publish action carries an \`Idempotency-Key\`.** A replay of the same \`(product, key)\`
  returns the **same** version instead of minting a new one; a missing key is **400**. Publishing
  twice must not produce two live versions.

**Failure mode the checks target.** The draft edits the published record in place, so an
unpublished edit is immediately visible on the storefront; it publishes happily with the price or
the tax class missing, so the page goes live unpriced; and it re-publishes on every retry, so a
client timeout plus retry mints a second version of the same product.`,
  sequence: {
    participants: ['Admin', 'Catalog API', 'draft store', 'publish keys'],
    messages: [
      {from: 'Admin', to: 'Catalog API', label: 'POST /v1/products · title', kind: 'sync'},
      {from: 'Catalog API', to: 'draft store', label: 'insert(version 1, status = draft)', kind: 'sync'},
      {from: 'draft store', to: 'Catalog API', label: 'product_id · version 1', kind: 'reply'},
      {from: 'Admin', to: 'Catalog API', label: 'POST /v1/products/{id}/publish · Idempotency-Key', kind: 'sync'},
      {from: 'Catalog API', to: 'Catalog API', label: 'required fields → 422 naming the field', kind: 'sync'},
      {from: 'Catalog API', to: 'publish keys', label: 'published_result(product_id, key)', kind: 'sync'},
      {from: 'publish keys', to: 'Catalog API', label: 'stored version / none', kind: 'reply'},
      {from: 'Catalog API', to: 'draft store', label: 'publish(version, key) · published is immutable', kind: 'async'},
      {from: 'Catalog API', to: 'Admin', label: '200 {version, status: "published"}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Registers the product and publish routes',
      detail: 'Register `POST /v1/products` and the publish action `POST /v1/products/{id}/publish`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/products["']/, /\/publish["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/products['"]/, /\/publish['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/products"/, /\/publish"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"products"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/products"/, /\/publish"/]},
      },
    },
    {
      id: 'draft-write',
      title: 'Edits write the draft row, never the published version',
      detail:
        'An edit goes through the draft (`writeDraft`/`write_draft`) and the publish reads the draft (`draftOf`/`draft_of`) — nothing updates a published row. The draft writes every edit straight into the published record, so an unpublished change is live immediately.',
      match: {
        python: {all: [/write_draft\(/, /draft_of\(/], none: [/update_published\(/]},
        typescript: {all: [/writeDraft\(/, /draftOf\(/], none: [/updatePublished\(/]},
        go: {all: [/WriteDraft\(/, /DraftOf\(/], none: [/UpdatePublished\(/]},
        scala: {all: [/writeDraft\(/, /draftOf\(/], none: [/updatePublished\(/]},
        cpp: {all: [/writeDraft\(/, /draftOf\(/], none: [/updatePublished\(/]},
      },
    },
    {
      id: 'required-fields',
      title: 'A publish missing a required field is 422 naming it',
      detail:
        'The required fields are declared (`REQUIRED_FIELDS`) and checked before the publish: a missing one answers **422 Unprocessable Entity** whose body carries the name of the missing field. The draft publishes with the price and the tax class unset.',
      match: {
        python: {all: [/REQUIRED_FIELDS/, /status_code\s*=\s*422/, /missing/]},
        typescript: {all: [/REQUIRED_FIELDS/, /code\(\s*422\s*\)/, /missing/]},
        go: {all: [/requiredFields/, /StatusUnprocessableEntity/, /missing/]},
        scala: {all: [/RequiredFields/, /StatusCodes\.UnprocessableEntity/, /missing/]},
        cpp: {all: [/kRequiredFields/, /\b422\b/, /missing/]},
      },
    },
    {
      id: 'publish-idempotency',
      title: 'Keys a publish action by (product, Idempotency-Key)',
      detail:
        '`Idempotency-Key` is required and the recorded publish result is looked up under `(product_id, key)` **before** the publish runs, so a replay returns the stored version instead of minting a new one. The draft ignores the header and promotes again.',
      match: {
        python: {
          all: [/Idempotency-Key/, /published_result\(/, /\.publish\(/],
          order: [/published_result\(/, /\.publish\(/],
        },
        typescript: {
          all: [/Idempotency-Key/i, /publishedResult\(/, /\.publish\(/],
          order: [/publishedResult\(/, /\.publish\(/],
        },
        go: {all: [/Idempotency-Key/, /PublishedResult\(/, /\.Publish\(/], order: [/PublishedResult\(/, /\.Publish\(/]},
        scala: {
          all: [/Idempotency-Key/, /publishedResult\(/, /\.publish\(/],
          order: [/publishedResult\(/, /\.publish\(/],
        },
        cpp: {
          all: [/Idempotency-Key/, /publishedResult\(/, /\.publish\(/],
          order: [/publishedResult\(/, /\.publish\(/],
        },
      },
    },
    {
      id: 'publish-version',
      title: 'Publishing records the version that went live',
      detail:
        'The publish call returns the version that became published and the response reports it with `status: "published"`; publishing is a move to a new version, not a rewrite of the row the storefront is already serving.',
      match: {
        python: {all: [/\.publish\(/, /["']published["']/, /version/]},
        typescript: {all: [/\.publish\(/, /["']published["']/, /version/]},
        go: {all: [/\.Publish\(/, /"published"/, /version/]},
        scala: {all: [/\.publish\(/, /"published"/, /version/]},
        cpp: {all: [/\.publish\(/, /"published"/, /version/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import uuid

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()


class CatalogStore:
    def upsert(self, product_id: str, fields: dict) -> dict:
        """Write fields straight into the product row and return it."""
        raise NotImplementedError


store = CatalogStore()


class ProductBody(BaseModel):
    title: str | None = None
    price_cents: int | None = None
    tax_class: str | None = None


@app.post("/v1/products")
def create_product(body: ProductBody) -> JSONResponse:
    # TODO: this draft edits the published record in place, publishes with the required fields
    # missing (price, tax class), and re-publishes on every retry. Review all three.
    product_id = str(uuid.uuid4())
    row = store.upsert(product_id, body.model_dump(exclude_none=True))
    row["status"] = "published"
    return JSONResponse(row, status_code=200)


@app.post("/v1/products/{product_id}/publish")
def publish_product(
    product_id: str,
    body: ProductBody,
    idem_key: str = Header(alias="Idempotency-Key"),
) -> dict:
    row = store.upsert(product_id, body.model_dump(exclude_none=True))
    row["version"] = int(row.get("version", 0)) + 1
    row["status"] = "published"
    return row
`,
      solution: `import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()

REQUIRED_FIELDS = ("title", "price_cents", "tax_class")


class CatalogStore:
    def create_draft(self, title: str) -> tuple[str, dict]:
        """Create a product with its first draft version; return (product_id, draft)."""
        raise NotImplementedError

    def draft_of(self, product_id: str) -> dict:
        """The product's draft version, whatever the published version is."""
        raise NotImplementedError

    def write_draft(self, product_id: str, fields: dict) -> dict:
        """Write fields into the draft version only; the published version stays immutable."""
        raise NotImplementedError

    def publish(self, product_id: str, version: int, idem_key: str) -> dict:
        """Move the draft version to published and record the publish action's key."""
        raise NotImplementedError

    def published_result(self, product_id: str, idem_key: str) -> dict | None:
        """The publish result already recorded for (product_id, idem_key), if any."""
        raise NotImplementedError


store = CatalogStore()


class ProductCreate(BaseModel):
    title: str


class ProductEdit(BaseModel):
    title: str | None = None
    price_cents: int | None = None
    tax_class: str | None = None


def published(product_id: str, version: int) -> dict:
    return {"product_id": product_id, "version": version, "status": "published"}


@app.post("/v1/products", status_code=201)
def create_product(body: ProductCreate) -> dict:
    product_id, draft = store.create_draft(body.title)
    return {"product_id": product_id, "version": draft["version"], "status": "draft"}


@app.patch("/v1/products/{product_id}")
def edit_product(product_id: str, body: ProductEdit) -> dict:
    draft = store.write_draft(product_id, body.model_dump(exclude_none=True))
    return {"product_id": product_id, "version": draft["version"], "status": "draft"}


@app.post("/v1/products/{product_id}/publish")
def publish_product(
    product_id: str,
    idem_key: str = Header(alias="Idempotency-Key"),
) -> JSONResponse:
    if not idem_key:
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    stored = store.published_result(product_id, idem_key)
    if stored is not None:
        return JSONResponse(stored, status_code=200)
    draft = store.draft_of(product_id)
    missing = [name for name in REQUIRED_FIELDS if draft.get(name) in (None, "")]
    if missing:
        raise HTTPException(status_code=422, detail={"missing": missing[0]})
    promoted = store.publish(product_id, draft["version"], idem_key)
    return JSONResponse(published(product_id, promoted["version"]), status_code=200)
`,
    },
    typescript: {
      starter: `/** POST /v1/products: a model-generated draft that publishes whatever it is given. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

export const app = Fastify();

interface ProductBody {
  title?: string;
  price_cents?: number;
  tax_class?: string;
}

export async function upsert(productId: string, fields: ProductBody): Promise<Record<string, unknown>> {
  return {product_id: productId, ...fields};
}

app.post('/v1/products', async (request, reply) => {
  // TODO: this draft edits the published record in place, publishes with the required fields
  // missing (price, tax class), and re-publishes on every retry. Review all three.
  const body = request.body as ProductBody;
  const row = await upsert(randomUUID(), body);
  row.status = 'published';
  return reply.code(200).send(row);
});

app.post('/v1/products/:productId/publish', async (request, reply) => {
  const {productId} = request.params as {productId: string};
  const body = request.body as ProductBody;
  const row = await upsert(productId, body);
  row.version = Number(row.version ?? 0) + 1;
  row.status = 'published';
  return reply.code(200).send(row);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/products: a draft version you edit, a published version you cannot. */
import Fastify from 'fastify';

import {store} from './store';

export const app = Fastify();

const REQUIRED_FIELDS = ['title', 'price_cents', 'tax_class'] as const;

interface CreateBody {
  title: string;
}

interface EditBody {
  title?: string;
  price_cents?: number;
  tax_class?: string;
}

function published(productId: string, version: number): Record<string, unknown> {
  return {product_id: productId, version, status: 'published'};
}

app.post('/v1/products', async (request, reply) => {
  const body = request.body as CreateBody;
  const draft = await store.createDraft(body.title);
  return reply.code(201).send({product_id: draft.product_id, version: draft.version, status: 'draft'});
});

app.patch('/v1/products/:productId', async (request, reply) => {
  const {productId} = request.params as {productId: string};
  const body = request.body as EditBody;
  const draft = await store.writeDraft(productId, body);
  return reply.code(200).send({product_id: productId, version: draft.version, status: 'draft'});
});

app.post('/v1/products/:productId/publish', async (request, reply) => {
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '')
    return reply.code(400).send({error: 'Idempotency-Key is required'});
  const {productId} = request.params as {productId: string};
  const stored = await store.publishedResult(productId, idemKey);
  if (stored !== null) return reply.code(200).send(stored);
  const draft = await store.draftOf(productId);
  const missing = REQUIRED_FIELDS.filter(name => {
    const value = (draft as unknown as Record<string, unknown>)[name];
    return value === undefined || value === null || value === '';
  });
  if (missing.length > 0)
    return reply.code(422).send({error: 'missing required field', field: missing[0]});
  const promoted = await store.publish(productId, draft.version, idemKey);
  return reply.code(200).send(published(productId, promoted.version));
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

	"github.com/google/uuid"
)

type ProductBody struct {
	Title      string \`json:"title"\`
	PriceCents int64  \`json:"price_cents"\`
	TaxClass   string \`json:"tax_class"\`
}

type CatalogStore struct{}

func (s *CatalogStore) Upsert(productID string, fields map[string]any) (map[string]any, error) {
	return map[string]any{"product_id": productID, "fields": fields}, nil
}

var store = &CatalogStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func createProduct(rw http.ResponseWriter, r *http.Request) {
	// TODO: this draft edits the published record in place, publishes with the required fields
	// missing (price, tax class), and re-publishes on every retry. Review all three.
	body := ProductBody{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	row, _ := store.Upsert(uuid.NewString(), map[string]any{"title": body.Title})
	row["status"] = "published"
	writeJSON(rw, http.StatusOK, row)
}

func publishProduct(rw http.ResponseWriter, r *http.Request) {
	_ = r.Header.Get("Idempotency-Key")
	row, _ := store.Upsert(r.PathValue("productID"), map[string]any{})
	row["version"] = 1
	row["status"] = "published"
	writeJSON(rw, http.StatusOK, row)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/products", createProduct)
	mux.HandleFunc("POST /v1/products/{productID}/publish", publishProduct)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"encoding/json"
	"log"
	"net/http"
)

var requiredFields = []string{"title", "price_cents", "tax_class"}

type ProductBody struct {
	Title      string \`json:"title"\`
	PriceCents *int64 \`json:"price_cents"\`
	TaxClass   string \`json:"tax_class"\`
}

type Draft struct {
	ProductID string         \`json:"product_id"\`
	Version   int            \`json:"version"\`
	Fields    map[string]any \`json:"fields"\`
}

type CatalogStore struct{}

func (s *CatalogStore) CreateDraft(title string) (Draft, error) {
	return Draft{ProductID: "new", Version: 1, Fields: map[string]any{"title": title}}, nil
}

// DraftOf returns the draft version: the published version is never an input to an edit.
func (s *CatalogStore) DraftOf(productID string) (Draft, error) {
	return Draft{ProductID: productID, Version: 1, Fields: map[string]any{}}, nil
}

// WriteDraft writes the fields into the draft version only.
func (s *CatalogStore) WriteDraft(productID string, fields map[string]any) (Draft, error) {
	return Draft{ProductID: productID, Version: 1, Fields: fields}, nil
}

// Publish promotes the draft version and records the publish action's key.
func (s *CatalogStore) Publish(productID string, version int, idemKey string) (Draft, error) {
	return Draft{ProductID: productID, Version: version + 1}, nil
}

func (s *CatalogStore) PublishedResult(productID, idemKey string) (map[string]any, error) {
	return nil, nil
}

var store = &CatalogStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func publishedBody(productID string, version int) map[string]any {
	return map[string]any{"product_id": productID, "version": version, "status": "published"}
}

func missingRequired(draft Draft) string {
	for _, name := range requiredFields {
		value, ok := draft.Fields[name]
		if !ok || value == nil || value == "" {
			return name
		}
	}
	return ""
}

func createProduct(rw http.ResponseWriter, r *http.Request) {
	body := ProductBody{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	draft, err := store.CreateDraft(body.Title)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	writeJSON(rw, http.StatusCreated, map[string]any{
		"product_id": draft.ProductID, "version": draft.Version, "status": "draft",
	})
}

func editProduct(rw http.ResponseWriter, r *http.Request) {
	fields := map[string]any{}
	_ = json.NewDecoder(r.Body).Decode(&fields)
	draft, err := store.WriteDraft(r.PathValue("productID"), fields)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"product_id": draft.ProductID, "version": draft.Version, "status": "draft",
	})
}

func publishProduct(rw http.ResponseWriter, r *http.Request) {
	idemKey := r.Header.Get("Idempotency-Key")
	if idemKey == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "Idempotency-Key is required"})
		return
	}
	productID := r.PathValue("productID")
	stored, err := store.PublishedResult(productID, idemKey)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if stored != nil {
		writeJSON(rw, http.StatusOK, stored)
		return
	}
	draft, err := store.DraftOf(productID)
	if err != nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no draft to publish"})
		return
	}
	if name := missingRequired(draft); name != "" {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{
			"error": "missing required field", "field": name,
		})
		return
	}
	promoted, err := store.Publish(productID, draft.Version, idemKey)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	writeJSON(rw, http.StatusOK, publishedBody(productID, promoted.Version))
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/products", createProduct)
	mux.HandleFunc("PATCH /v1/products/{productID}", editProduct)
	mux.HandleFunc("POST /v1/products/{productID}/publish", publishProduct)
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
import spray.json._

final case class ProductBody(title: Option[String], price_cents: Option[Long], tax_class: Option[String])

object CatalogApi {
  implicit val system: ActorSystem = ActorSystem("product-catalog")
  implicit val bodyFormat: RootJsonFormat[ProductBody] = jsonFormat3(ProductBody)

  val store = CatalogStore.open()

  val route: Route =
    path("v1" / "products") {
      post {
        entity(as[ProductBody]) { body =>
          // TODO: this draft edits the published record in place, publishes with the required
          // fields missing (price, tax class), and re-publishes on every retry. Review all three.
          val row = store.upsert("new", Map("title" -> body.title.getOrElse("")))
          complete(StatusCodes.OK, row.toJson.compactPrint)
        }
      }
    } ~
      path("v1" / "products" / Segment / "publish") { productId =>
        post {
          headerValueByName("Idempotency-Key") { _ =>
            val row = store.upsert(productId, Map.empty[String, String])
            complete(StatusCodes.OK, row.toJson.compactPrint)
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
import spray.json._

final case class ProductBody(title: Option[String], price_cents: Option[Long], tax_class: Option[String])

object CatalogApi {
  implicit val system: ActorSystem = ActorSystem("product-catalog")
  implicit val bodyFormat: RootJsonFormat[ProductBody] = jsonFormat3(ProductBody)

  val RequiredFields = List("title", "price_cents", "tax_class")
  val store = CatalogStore.open()

  def published(productId: String, version: Int): String =
    s"""{"product_id":"$productId","version":$version,"status":"published"}"""

  val route: Route =
    path("v1" / "products") {
      post {
        entity(as[ProductBody]) { body =>
          val draft = store.createDraft(body.title.getOrElse(""))
          complete(StatusCodes.Created, s"""{"product_id":"\${draft.productId}","version":\${draft.version},"status":"draft"}""")
        }
      }
    } ~
      path("v1" / "products" / Segment) { productId =>
        patch {
          entity(as[ProductBody]) { body =>
            val fields = Map(
              "title" -> body.title.getOrElse(""),
              "price_cents" -> body.price_cents.map(_.toString).getOrElse(""),
              "tax_class" -> body.tax_class.getOrElse("")
            ).filter(_._2.nonEmpty)
            val draft = store.writeDraft(productId, fields)
            complete(StatusCodes.OK, s"""{"product_id":"$productId","version":\${draft.version},"status":"draft"}""")
          }
        }
      } ~
      path("v1" / "products" / Segment / "publish") { productId =>
        post {
          optionalHeaderValueByName("Idempotency-Key") { idemOpt =>
            if (!idemOpt.exists(_.nonEmpty)) {
              complete(StatusCodes.BadRequest, """{"error":"Idempotency-Key is required"}""")
            } else {
              val idemKey = idemOpt.get
              store.publishedResult(productId, idemKey) match {
                case Some(stored) =>
                  complete(StatusCodes.OK, stored)
                case None =>
                  val draft = store.draftOf(productId)
                  val missing = RequiredFields.filterNot(name => draft.fields.get(name).exists(_.nonEmpty))
                  if (missing.nonEmpty) {
                    complete(
                      StatusCodes.UnprocessableEntity,
                      s"""{"error":"missing required field","field":"\${missing.head}"}"""
                    )
                  } else {
                    val promoted = store.publish(productId, draft.version, idemKey)
                    complete(StatusCodes.OK, published(productId, promoted.version))
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

#include <string>

using json = nlohmann::json;

struct CatalogStore {
  json upsert(const std::string& productId, const json& fields);
};

CatalogStore store;

int main() {
  httplib::Server svr;

  svr.Post("/v1/products", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft edits the published record in place, publishes with the required fields
    // missing (price, tax class), and re-publishes on every retry. Review all three.
    const json body = json::parse(req.body, nullptr, false);
    json row = store.upsert("new", body);
    row["status"] = "published";
    res.status = 200;
    res.set_content(row.dump(), "application/json");
  });

  svr.Post("/v1/products/([^/]+)/publish", [](const httplib::Request& req, httplib::Response& res) {
    json row = store.upsert(req.matches[1], json::parse(req.body, nullptr, false));
    row["version"] = 1;
    row["status"] = "published";
    res.status = 200;
    res.set_content(row.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <optional>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::vector<std::string> kRequiredFields = {"title", "price_cents", "tax_class"};

struct CatalogStore {
  json createDraft(const std::string& title);
  json draftOf(const std::string& productId);
  json writeDraft(const std::string& productId, const json& fields);
  json publish(const std::string& productId, int version, const std::string& idemKey);
  std::optional<json> publishedResult(const std::string& productId, const std::string& idemKey);
};

CatalogStore store;

json publishedBody(const std::string& productId, int version) {
  return json{{"product_id", productId}, {"version", version}, {"status", "published"}};
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/products", [](const httplib::Request& req, httplib::Response& res) {
    const json body = json::parse(req.body, nullptr, false);
    const json draft = store.createDraft(body.value("title", std::string()));
    res.status = 201;
    res.set_content(
        json{{"product_id", draft["product_id"]}, {"version", draft["version"]}, {"status", "draft"}}.dump(),
        "application/json");
  });

  svr.Patch("/v1/products/([^/]+)", [](const httplib::Request& req, httplib::Response& res) {
    const json draft = store.writeDraft(req.matches[1], json::parse(req.body, nullptr, false));
    res.status = 200;
    res.set_content(
        json{{"product_id", req.matches[1]}, {"version", draft["version"]}, {"status", "draft"}}.dump(),
        "application/json");
  });

  svr.Post("/v1/products/([^/]+)/publish", [](const httplib::Request& req, httplib::Response& res) {
    const auto idemKey = req.get_header_value("Idempotency-Key");
    if (idemKey.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"Idempotency-Key is required"})", "application/json");
      return;
    }
    const std::string productId = req.matches[1];
    const auto stored = store.publishedResult(productId, idemKey);
    if (stored) {
      res.status = 200;
      res.set_content(stored->dump(), "application/json");
      return;
    }
    const json draft = store.draftOf(productId);
    for (const auto& name : kRequiredFields) {
      if (!draft.contains(name) || draft[name].is_null() || draft[name] == "") {
        res.status = 422;
        res.set_content(json{{"error", "missing required field"}, {"field", name}}.dump(), "application/json");
        return;
      }
    }
    const json promoted = store.publish(productId, draft["version"].get<int>(), idemKey);
    res.status = 200;
    res.set_content(publishedBody(productId, promoted["version"].get<int>()).dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Two rows, not one. A create writes a draft version and a publish promotes it; an edit writes the draft and nothing else. If `PATCH` and `publish` call the same `upsert(...)` helper, every edit is live on the storefront the moment it is saved — which is the whole bug.',
    'Validate before you publish: build the list of required fields (`REQUIRED_FIELDS`) and answer `422` with the first missing name. A publish that only checks the fields it was given will happily go live with no price.',
    'The `Idempotency-Key` is the publish action’s identity. Look the recorded result up under `(product_id, key)` before promoting; on a hit, return the stored version. Without it, a client retry after a timeout mints a second published version of the same product.',
  ],
  debrief: `The interviewer is testing whether you can review a generated handler where the *data model* is the bug. Three separate defects are being checked: the draft writes the published record in place (so unpublished edits leak to the storefront), required fields are not validated before the publish (so an unpriced product goes live), and the publish action has no idempotency key (so a retry mints a second version). The immutable published version is what makes rollbacks and cache invalidation possible at all: if the published row can be rewritten, there is nothing stable to point a CDN or a stored version id at. Real catalogs add a version history with authors and timestamps, a two-person approval before a publish, and a scheduled release window per channel.`,
};
