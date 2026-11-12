import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/products: drafts and published versions are different things',
  concept: 'http',
  guides: ['request-boundaries', 'idempotent-requests'],
  file: 'api',
  focus: ['client', 'api', 'db'],
  task: `## Task

**Starting point.** The starter serves the write side of the catalog on the versions store
(\`catalog.store\`, provided): \`POST /v1/products\` creates a product whose version 1 is a draft,
\`PATCH /v1/products/{id}\` edits it through \`store.upsert\`, and \`POST /v1/products/{id}/publish\`
promotes the latest version and answers \`{product_id, version, status: "published"}\`. It serves the
demo and hides three flaws.

**Failure mode the checks target.** An edit after a publish rewrites the row the storefront is
serving; a publish goes through with the price or the tax class unset; and a client that times out
and retries its publish mints a second version.

- An edit writes the **draft** row only (\`store.write_draft\`): a published version is immutable.
  The publish reads the draft (\`store.draft_of\`) and promotes exactly that version.
- \`REQUIRED_FIELDS\` are \`title\`, \`price_cents\` and \`tax_class\`; a publish whose draft lacks one is
  **422** with a body naming the missing field.
- A publish carries an \`Idempotency-Key\`; a missing key is **400**. Look the \`(product, key)\` up in
  \`store.publish_result\` before promoting, answer the recorded result on a replay, and record the
  result (\`store.record_publish\`) once the draft is promoted.`,
  sequence: {
    participants: ['Admin', 'Catalog API', 'versions store'],
    messages: [
      {from: 'Admin', to: 'Catalog API', label: 'POST /v1/products · title', kind: 'sync'},
      {from: 'Catalog API', to: 'versions store', label: 'create(title) → version 1, draft', kind: 'sync'},
      {from: 'Admin', to: 'Catalog API', label: 'PATCH /v1/products/{id} · price, tax class', kind: 'sync'},
      {from: 'Catalog API', to: 'versions store', label: 'write_draft(id, fields)', kind: 'sync'},
      {from: 'Admin', to: 'Catalog API', label: 'POST /v1/products/{id}/publish · Idempotency-Key', kind: 'sync'},
      {from: 'Catalog API', to: 'versions store', label: 'publish_result(id, key) → recorded / none', kind: 'sync'},
      {from: 'Catalog API', to: 'Catalog API', label: 'draft_of(id) · REQUIRED_FIELDS → 422', kind: 'sync'},
      {from: 'Catalog API', to: 'versions store', label: 'promote(id, version) · record_publish', kind: 'sync'},
      {from: 'Catalog API', to: 'Admin', label: '200 {version, status: "published"}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Registers the product, edit and publish routes',
      detail: 'Register `POST /v1/products`, `PATCH /v1/products/{id}` and `POST /v1/products/{id}/publish`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/products["']/, /@app\.patch\(/, /\/publish["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/products['"]/, /app\.patch\(/, /\/publish['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/products"/, /"PATCH \/v1\/products\/\{/, /\/publish"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"products"\s*\)/, /\bpatch\s*\{/, /"publish"/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/products"/, /svr\.Patch\(/, /\/publish/]},
      },
    },
    {
      id: 'draft-write',
      title: 'Edits write the draft row, never the published version',
      detail:
        'An edit goes through `write_draft`/`writeDraft` and the publish promotes the row `draft_of`/`draftOf` returns; nothing calls `upsert`, which rewrites the latest row whatever its status.',
      match: {
        python: {all: [/store\.write_draft\(/, /store\.draft_of\(/], none: [/\bupsert\(/]},
        typescript: {all: [/writeDraft\(/, /draftOf\(/], none: [/\bupsert\(/]},
        go: {all: [/store\.WriteDraft\(/, /store\.DraftOf\(/], none: [/\bUpsert\(/]},
        scala: {all: [/Store\.writeDraft\(/, /Store\.draftOf\(/], none: [/\bupsert\(/]},
        cpp: {all: [/store::writeDraft\(/, /store::draftOf\(/], none: [/\bupsert\(/]},
      },
    },
    {
      id: 'required-fields',
      title: 'A publish missing a required field is 422 naming it',
      detail:
        'The required fields are declared (`REQUIRED_FIELDS`) and checked on the draft before the promote: a missing one answers **422** with the name of the field in the body.',
      match: {
        python: {all: [/REQUIRED_FIELDS/, /\b422\b/, /missing/]},
        typescript: {all: [/REQUIRED_FIELDS/, /\b422\b/, /missing/]},
        go: {all: [/requiredFields/, /StatusUnprocessableEntity|\b422\b/, /missing/]},
        scala: {all: [/RequiredFields/, /UnprocessableEntity|\b422\b/, /missing/]},
        cpp: {all: [/kRequiredFields/, /\b422\b/, /missing/]},
      },
    },
    {
      id: 'publish-idempotency',
      title: 'Keys a publish by (product, Idempotency-Key)',
      detail:
        '`Idempotency-Key` is read from the request (a missing one is 400) and the recorded result is looked up (`publish_result`/`publishResult`) before the promote; a replay answers the recorded version, and a fresh publish records its result.',
      match: {
        python: {
          all: [/idempotency-key/i, /store\.publish_result\(/, /store\.record_publish\(/, /\b400\b/],
          order: [/store\.publish_result\(/, /store\.promote\(/],
        },
        typescript: {
          all: [/idempotency-key/i, /publishResult\(/, /recordPublish\(/, /\b400\b/],
          order: [/publishResult\(/, /promote\(/],
        },
        go: {
          all: [/Idempotency-Key/i, /store\.PublishResult\(/, /store\.RecordPublish\(/, /StatusBadRequest|\b400\b/],
          order: [/store\.PublishResult\(/, /store\.Promote\(/],
        },
        scala: {
          all: [/Idempotency-Key/i, /Store\.publishResult\(/, /Store\.recordPublish\(/, /BadRequest|\b400\b/],
          order: [/Store\.publishResult\(/, /Store\.promote\(/],
        },
        cpp: {
          all: [/Idempotency-Key/i, /store::publishResult\(/, /store::recordPublish\(/, /\b400\b/],
          order: [/store::publishResult\(/, /store::promote\(/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

from catalog import store  # create, latest, draft_of, write_draft, upsert, promote, publish_result, record_publish

app = FastAPI()


class ProductCreate(BaseModel):
    title: str


class ProductEdit(BaseModel):
    title: str | None = None
    price_cents: int | None = None
    tax_class: str | None = None


@app.post("/v1/products", status_code=201)
def create_product(body: ProductCreate) -> dict:
    row = store.create(body.title)
    return {"product_id": row["product_id"], "version": row["version"], "status": "draft"}


@app.patch("/v1/products/{product_id}")
def edit_product(product_id: str, body: ProductEdit) -> dict:
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    row = store.upsert(product_id, body.model_dump(exclude_none=True))
    return {"product_id": product_id, "version": row["version"], "status": row["status"]}


@app.post("/v1/products/{product_id}/publish")
def publish_product(product_id: str, request: Request) -> dict:
    row = store.latest(product_id)
    if row is None:
        raise HTTPException(status_code=404, detail="no such product")
    promoted = store.promote(product_id, row["version"])
    return {"product_id": product_id, "version": promoted["version"], "status": "published"}
`,
      solution: `from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from catalog import store  # create, latest, draft_of, write_draft, upsert, promote, publish_result, record_publish

app = FastAPI()

REQUIRED_FIELDS = ("title", "price_cents", "tax_class")


class ProductCreate(BaseModel):
    title: str


class ProductEdit(BaseModel):
    title: str | None = None
    price_cents: int | None = None
    tax_class: str | None = None


@app.post("/v1/products", status_code=201)
def create_product(body: ProductCreate) -> dict:
    row = store.create(body.title)
    return {"product_id": row["product_id"], "version": row["version"], "status": "draft"}


@app.patch("/v1/products/{product_id}")
def edit_product(product_id: str, body: ProductEdit) -> dict:
    # The published row is immutable: an edit opens or extends the draft.
    row = store.write_draft(product_id, body.model_dump(exclude_none=True))
    return {"product_id": product_id, "version": row["version"], "status": "draft"}


@app.post("/v1/products/{product_id}/publish")
def publish_product(product_id: str, request: Request) -> JSONResponse:
    key = request.headers.get("idempotency-key", "")
    if not key:
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    recorded = store.publish_result(product_id, key)
    if recorded is not None:
        return JSONResponse(recorded)  # a replay answers what the first attempt answered
    draft = store.draft_of(product_id)
    if draft is None:
        raise HTTPException(status_code=409, detail="nothing to publish: no draft")
    missing = [name for name in REQUIRED_FIELDS if draft.get(name) in (None, "")]
    if missing:
        raise HTTPException(status_code=422, detail={"missing": missing[0]})
    promoted = store.promote(product_id, draft["version"])
    result = {"product_id": product_id, "version": promoted["version"], "status": "published"}
    store.record_publish(product_id, key, result)
    return JSONResponse(result)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {type Fields, create, draftOf, latest, promote, publishResult, recordPublish, upsert, writeDraft} from 'catalog/store';

export const app = Fastify();

app.post('/v1/products', async (request, reply) => {
  const {title} = request.body as {title: string};
  const row = await create(title);
  return reply.code(201).send({product_id: row.product_id, version: row.version, status: 'draft'});
});

app.patch('/v1/products/:productId', async request => {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const {productId} = request.params as {productId: string};
  const row = await upsert(productId, request.body as Fields);
  return {product_id: productId, version: row.version, status: row.status};
});

app.post('/v1/products/:productId/publish', async (request, reply) => {
  const {productId} = request.params as {productId: string};
  const row = await latest(productId);
  if (row === null) return reply.code(404).send({error: 'no such product'});
  const promoted = await promote(productId, row.version);
  return {product_id: productId, version: promoted.version, status: 'published'};
});
`,
      solution: `import Fastify from 'fastify';

import {type Fields, create, draftOf, latest, promote, publishResult, recordPublish, upsert, writeDraft} from 'catalog/store';

export const app = Fastify();

const REQUIRED_FIELDS = ['title', 'price_cents', 'tax_class'] as const;

app.post('/v1/products', async (request, reply) => {
  const {title} = request.body as {title: string};
  const row = await create(title);
  return reply.code(201).send({product_id: row.product_id, version: row.version, status: 'draft'});
});

app.patch('/v1/products/:productId', async request => {
  const {productId} = request.params as {productId: string};
  // The published row is immutable: an edit opens or extends the draft.
  const row = await writeDraft(productId, request.body as Fields);
  return {product_id: productId, version: row.version, status: 'draft'};
});

app.post('/v1/products/:productId/publish', async (request, reply) => {
  const {productId} = request.params as {productId: string};
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key === '') return reply.code(400).send({error: 'Idempotency-Key is required'});
  const recorded = await publishResult(productId, key);
  if (recorded !== null) return recorded; // a replay answers what the first attempt answered
  const draft = await draftOf(productId);
  if (draft === null) return reply.code(409).send({error: 'nothing to publish: no draft'});
  const missing = REQUIRED_FIELDS.find(name => draft[name] === null || draft[name] === '');
  if (missing !== undefined) return reply.code(422).send({error: 'missing required field', missing});
  const promoted = await promote(productId, draft.version);
  const result = {product_id: productId, version: promoted.version, status: 'published'};
  await recordPublish(productId, key, result);
  return result;
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"catalog/store" // store.Create, Latest, DraftOf, WriteDraft, Upsert, Promote, PublishResult, RecordPublish
)

type publishResult struct {
	ProductID string \`json:"product_id"\`
	Version   int    \`json:"version"\`
	Status    string \`json:"status"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func createProduct(rw http.ResponseWriter, r *http.Request) {
	var body struct {
		Title string \`json:"title"\`
	}
	json.NewDecoder(r.Body).Decode(&body)
	row := store.Create(r.Context(), body.Title)
	writeJSON(rw, http.StatusCreated, publishResult{ProductID: row.ProductID, Version: row.Version, Status: "draft"})
}

func editProduct(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	productID := r.PathValue("id")
	fields := store.Fields{}
	json.NewDecoder(r.Body).Decode(&fields)
	row, err := store.Upsert(r.Context(), productID, fields)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusNotFound)
		return
	}
	writeJSON(rw, http.StatusOK, publishResult{ProductID: productID, Version: row.Version, Status: row.Status})
}

func publishProduct(rw http.ResponseWriter, r *http.Request) {
	productID := r.PathValue("id")
	row := store.Latest(r.Context(), productID)
	if row == nil {
		http.Error(rw, "no such product", http.StatusNotFound)
		return
	}
	promoted := store.Promote(r.Context(), productID, row.Version)
	writeJSON(rw, http.StatusOK, publishResult{ProductID: productID, Version: promoted.Version, Status: "published"})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/products", createProduct)
	mux.HandleFunc("PATCH /v1/products/{id}", editProduct)
	mux.HandleFunc("POST /v1/products/{id}/publish", publishProduct)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"

	"catalog/store" // store.Create, Latest, DraftOf, WriteDraft, Upsert, Promote, PublishResult, RecordPublish
)

var requiredFields = []string{"title", "price_cents", "tax_class"}

type publishResult struct {
	ProductID string \`json:"product_id"\`
	Version   int    \`json:"version"\`
	Status    string \`json:"status"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func createProduct(rw http.ResponseWriter, r *http.Request) {
	var body struct {
		Title string \`json:"title"\`
	}
	json.NewDecoder(r.Body).Decode(&body)
	row := store.Create(r.Context(), body.Title)
	writeJSON(rw, http.StatusCreated, publishResult{ProductID: row.ProductID, Version: row.Version, Status: "draft"})
}

func editProduct(rw http.ResponseWriter, r *http.Request) {
	productID := r.PathValue("id")
	fields := store.Fields{}
	json.NewDecoder(r.Body).Decode(&fields)
	// The published row is immutable: an edit opens or extends the draft.
	row, err := store.WriteDraft(r.Context(), productID, fields)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusNotFound)
		return
	}
	writeJSON(rw, http.StatusOK, publishResult{ProductID: productID, Version: row.Version, Status: "draft"})
}

// missingField is the first required field the draft lacks, or "".
func missingField(draft *store.Row) string {
	values := map[string]bool{"title": draft.Title != "", "price_cents": draft.PriceCents != 0, "tax_class": draft.TaxClass != ""}
	for _, name := range requiredFields {
		if !values[name] {
			return name
		}
	}
	return ""
}

func publishProduct(rw http.ResponseWriter, r *http.Request) {
	productID := r.PathValue("id")
	key := r.Header.Get("Idempotency-Key")
	if key == "" {
		http.Error(rw, "Idempotency-Key is required", http.StatusBadRequest)
		return
	}
	if recorded := store.PublishResult(r.Context(), productID, key); recorded != nil {
		writeJSON(rw, http.StatusOK, recorded) // a replay answers what the first attempt answered
		return
	}
	draft := store.DraftOf(r.Context(), productID)
	if draft == nil {
		http.Error(rw, "nothing to publish: no draft", http.StatusConflict)
		return
	}
	if missing := missingField(draft); missing != "" {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "missing required field", "missing": missing})
		return
	}
	promoted := store.Promote(r.Context(), productID, draft.Version)
	result := map[string]any{"product_id": productID, "version": promoted.Version, "status": "published"}
	store.RecordPublish(r.Context(), productID, key, result)
	writeJSON(rw, http.StatusOK, result)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/products", createProduct)
	mux.HandleFunc("PATCH /v1/products/{id}", editProduct)
	mux.HandleFunc("POST /v1/products/{id}/publish", publishProduct)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import catalog.Store // Store.create, latest, draftOf, writeDraft, upsert, promote, publishResult, recordPublish

object Api {
  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def result(productId: String, version: Long, status: String): JsObject =
    JsObject("product_id" -> JsString(productId), "version" -> JsNumber(version), "status" -> JsString(status))

  /** The editable fields of a request body, as the store takes them (a price as its digits). */
  private def fields(raw: String): Map[String, String] = raw.parseJson.asJsObject.fields.collect {
    case (name, JsString(s)) => name -> s
    case (name, JsNumber(n)) => name -> n.toBigInt.toString
  }

  val route: Route = concat(
    path("v1" / "products") {
      post {
        entity(as[String]) { raw =>
          val row = Store.create(raw.parseJson.asJsObject.fields("title").convertTo[String](DefaultJsonProtocol.StringJsonFormat))
          complete(json(StatusCodes.Created, result(row.productId, row.version, "draft")))
        }
      }
    },
    path("v1" / "products" / Segment) { productId =>
      patch {
        entity(as[String]) { raw =>
          // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
          val row = Store.upsert(productId, fields(raw))
          complete(json(StatusCodes.OK, result(productId, row.version, row.status)))
        }
      }
    },
    path("v1" / "products" / Segment / "publish") { productId =>
      post {
        Store.latest(productId) match {
          case None => complete(StatusCodes.NotFound -> "no such product")
          case Some(row) =>
            val promoted = Store.promote(productId, row.version)
            complete(json(StatusCodes.OK, result(productId, promoted.version, "published")))
        }
      }
    },
  )
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import catalog.Store // Store.create, latest, draftOf, writeDraft, upsert, promote, publishResult, recordPublish

object Api {
  val RequiredFields: Seq[String] = Seq("title", "price_cents", "tax_class")

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def result(productId: String, version: Long, status: String): JsObject =
    JsObject("product_id" -> JsString(productId), "version" -> JsNumber(version), "status" -> JsString(status))

  /** The editable fields of a request body, as the store takes them (a price as its digits). */
  private def fields(raw: String): Map[String, String] = raw.parseJson.asJsObject.fields.collect {
    case (name, JsString(s)) => name -> s
    case (name, JsNumber(n)) => name -> n.toBigInt.toString
  }

  /** The first required field the draft lacks. */
  private def missingField(draft: Store.Row): Option[String] = {
    val present = Map("title" -> draft.title, "price_cents" -> draft.priceCents.map(_.toString), "tax_class" -> draft.taxClass)
    RequiredFields.find(name => present(name).forall(_.isEmpty))
  }

  val route: Route = concat(
    path("v1" / "products") {
      post {
        entity(as[String]) { raw =>
          val row = Store.create(raw.parseJson.asJsObject.fields("title").convertTo[String](DefaultJsonProtocol.StringJsonFormat))
          complete(json(StatusCodes.Created, result(row.productId, row.version, "draft")))
        }
      }
    },
    path("v1" / "products" / Segment) { productId =>
      patch {
        entity(as[String]) { raw =>
          // The published row is immutable: an edit opens or extends the draft.
          val row = Store.writeDraft(productId, fields(raw))
          complete(json(StatusCodes.OK, result(productId, row.version, "draft")))
        }
      }
    },
    path("v1" / "products" / Segment / "publish") { productId =>
      post {
        optionalHeaderValueByName("Idempotency-Key") {
          case None | Some("") => complete(StatusCodes.BadRequest -> "Idempotency-Key is required")
          case Some(key) =>
            Store.publishResult(productId, key) match {
              case Some(recorded) => complete(json(StatusCodes.OK, recorded)) // a replay answers what the first attempt answered
              case None =>
                Store.draftOf(productId) match {
                  case None => complete(StatusCodes.Conflict -> "nothing to publish: no draft")
                  case Some(draft) =>
                    missingField(draft) match {
                      case Some(missing) =>
                        complete(json(StatusCodes.UnprocessableEntity, JsObject("error" -> JsString("missing required field"), "missing" -> JsString(missing))))
                      case None =>
                        val promoted = Store.promote(productId, draft.version)
                        val recorded = result(productId, promoted.version, "published")
                        Store.recordPublish(productId, key, recorded)
                        complete(json(StatusCodes.OK, recorded))
                    }
                }
            }
        }
      }
    },
  )
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

#include "catalog/store.h"  // store::create, latest, draftOf, writeDraft, upsert, promote, publishResult, recordPublish

using json = nlohmann::json;

json result(const std::string& product_id, long version, const std::string& status) {
  return json{{"product_id", product_id}, {"version", version}, {"status", status}};
}

void create_product(const httplib::Request& req, httplib::Response& res) {
  const store::Row row = store::create(json::parse(req.body).value("title", ""));
  res.status = 201;
  res.set_content(result(row.product_id, row.version, "draft").dump(), "application/json");
}

void edit_product(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const std::string product_id = req.matches[1];
  const store::Row row = store::upsert(product_id, json::parse(req.body));
  res.set_content(result(product_id, row.version, row.status).dump(), "application/json");
}

void publish_product(const httplib::Request& req, httplib::Response& res) {
  const std::string product_id = req.matches[1];
  const auto row = store::latest(product_id);
  if (!row) {
    res.status = 404;
    res.set_content("no such product", "text/plain");
    return;
  }
  const store::Row promoted = store::promote(product_id, row->version);
  res.set_content(result(product_id, promoted.version, "published").dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/products", create_product);
  svr.Patch(R"(/v1/products/([\\w-]+))", edit_product);
  svr.Post(R"(/v1/products/([\\w-]+)/publish)", publish_product);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "catalog/store.h"  // store::create, latest, draftOf, writeDraft, upsert, promote, publishResult, recordPublish

using json = nlohmann::json;

const std::vector<std::string> kRequiredFields = {"title", "price_cents", "tax_class"};

json result(const std::string& product_id, long version, const std::string& status) {
  return json{{"product_id", product_id}, {"version", version}, {"status", status}};
}

void create_product(const httplib::Request& req, httplib::Response& res) {
  const store::Row row = store::create(json::parse(req.body).value("title", ""));
  res.status = 201;
  res.set_content(result(row.product_id, row.version, "draft").dump(), "application/json");
}

void edit_product(const httplib::Request& req, httplib::Response& res) {
  const std::string product_id = req.matches[1];
  // The published row is immutable: an edit opens or extends the draft.
  const store::Row row = store::writeDraft(product_id, json::parse(req.body));
  res.set_content(result(product_id, row.version, "draft").dump(), "application/json");
}

// The first required field the draft lacks, or "".
std::string missing_field(const store::Row& draft) {
  for (const std::string& name : kRequiredFields) {
    const bool present = name == "title" ? !draft.title.empty() : name == "price_cents" ? draft.price_cents != 0 : !draft.tax_class.empty();
    if (!present) return name;
  }
  return "";
}

void publish_product(const httplib::Request& req, httplib::Response& res) {
  const std::string product_id = req.matches[1];
  const std::string key = req.get_header_value("Idempotency-Key");
  if (key.empty()) {
    res.status = 400;
    res.set_content("Idempotency-Key is required", "text/plain");
    return;
  }
  if (const auto recorded = store::publishResult(product_id, key)) {
    res.set_content(recorded->dump(), "application/json");  // a replay answers what the first attempt answered
    return;
  }
  const auto draft = store::draftOf(product_id);
  if (!draft) {
    res.status = 409;
    res.set_content("nothing to publish: no draft", "text/plain");
    return;
  }
  const std::string missing = missing_field(*draft);
  if (!missing.empty()) {
    res.status = 422;
    res.set_content(json{{"error", "missing required field"}, {"missing", missing}}.dump(), "application/json");
    return;
  }
  const store::Row promoted = store::promote(product_id, draft->version);
  const json recorded = result(product_id, promoted.version, "published");
  store::recordPublish(product_id, key, recorded);
  res.set_content(recorded.dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/products", create_product);
  svr.Patch(R"(/v1/products/([\\w-]+))", edit_product);
  svr.Post(R"(/v1/products/([\\w-]+)/publish)", publish_product);
}
`,
    },
  },
  harness: {
    python: `from catalog import store

FULL = {"price_cents": 3499, "tax_class": "standard"}


def _api(ctx):
    m = ctx.load("api")
    return ctx.client(m.app)


async def _create(c, title="Kettle"):
    r = await c.post("/v1/products", json={"title": title})
    assert r.status_code in (200, 201), f"POST /v1/products answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("status") == "draft", f"a new product must be a draft, got {body}"
    return body["product_id"]


async def _publish(c, product_id, key="k-1"):
    return await c.post(f"/v1/products/{product_id}/publish", headers={"Idempotency-Key": key})


async def check_route(ctx):
    async with _api(ctx) as c:
        product_id = await _create(c)
        r = await c.patch(f"/v1/products/{product_id}", json=FULL)
        assert r.status_code == 200, f"PATCH /v1/products/{product_id} answered {r.status_code}: {r.text}"
        r = await _publish(c, product_id)
    assert r.status_code == 200, f"POST /v1/products/{product_id}/publish answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("status") == "published" and body.get("version") == 1, f"the publish must answer version 1 as published, got {body}"
    published = store.published_of(product_id)
    assert published is not None and published["version"] == 1, f"after the publish the store holds published version {published}"


async def check_draft_write(ctx):
    async with _api(ctx) as c:
        product_id = await _create(c)
        await c.patch(f"/v1/products/{product_id}", json=FULL)
        await _publish(c, product_id)
        r = await c.patch(f"/v1/products/{product_id}", json={"title": "Kettle, 2 L"})
        assert r.status_code == 200, f"an edit after a publish answered {r.status_code}: {r.text}"
        assert r.json().get("status") == "draft", f"an edit must answer a draft, got {r.json()}"
    published = store.published_of(product_id)
    assert published is not None and published["title"] == "Kettle", f"the published row changed under the storefront: {published}. An edit must write the draft row only"
    draft = store.draft_of(product_id)
    assert draft is not None and draft["title"] == "Kettle, 2 L" and draft["version"] == 2, f"the edit must open version 2 as the draft, the store holds {draft}"
    assert draft["price_cents"] == 3499, f"a new draft starts from the published row, got {draft}"


async def check_required_fields(ctx):
    async with _api(ctx) as c:
        product_id = await _create(c)
        r = await _publish(c, product_id)
        assert r.status_code == 422, f"a publish with no price and no tax class answered {r.status_code}, expected 422"
        assert "price_cents" in r.text, f"the 422 must name the missing field (price_cents), got {r.text}"
        assert store.published_of(product_id) is None, "nothing may be published with required fields unset"
        await c.patch(f"/v1/products/{product_id}", json={"price_cents": 3499})
        r = await _publish(c, product_id, "k-2")
        assert r.status_code == 422 and "tax_class" in r.text, f"with the price set and the tax class unset the publish answered {r.status_code} {r.text}, expected 422 naming tax_class"
        await c.patch(f"/v1/products/{product_id}", json={"tax_class": "standard"})
        r = await _publish(c, product_id, "k-3")
    assert r.status_code == 200, f"with every required field set the publish answered {r.status_code}: {r.text}"


async def check_publish_idempotency(ctx):
    async with _api(ctx) as c:
        product_id = await _create(c)
        await c.patch(f"/v1/products/{product_id}", json=FULL)
        first = await _publish(c, product_id, "k-1")
        assert first.status_code == 200, f"the first publish answered {first.status_code}: {first.text}"
        replay = await _publish(c, product_id, "k-1")
        assert replay.status_code == 200 and replay.json() == first.json(), f"a replay of the same Idempotency-Key must answer the same result: first {first.json()}, replay {replay.json()}"
        await c.patch(f"/v1/products/{product_id}", json={"title": "Kettle, 2 L"})
        late = await _publish(c, product_id, "k-1")
        assert late.json().get("version") == 1, f"a retry of the first publish after an edit minted version {late.json().get('version')}: the recorded result for (product, key) must be answered instead"
        assert store.published_of(product_id)["version"] == 1, f"the retry promoted the new draft; published is {store.published_of(product_id)}"
        fresh = await _publish(c, product_id, "k-2")
        assert fresh.status_code == 200 and fresh.json().get("version") == 2, f"a publish with a new key must promote the new draft (version 2), got {fresh.status_code} {fresh.text}"
        none = await c.post(f"/v1/products/{product_id}/publish")
    assert none.status_code == 400, f"a publish without Idempotency-Key answered {none.status_code}, expected 400"
`,
    typescript: `const FULL = {price_cents: 3499, tax_class: 'standard'};

function api(ctx) {
  const m = ctx.load('api');
  return {c: ctx.client(m.app), store: ctx.load('/support/catalog/store.ts')};
}

async function create(c, title = 'Kettle'): Promise<string> {
  const r = await c.post('/v1/products', {json: {title}});
  assert(r.status === 200 || r.status === 201, \`POST /v1/products answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert.equal(body.status, 'draft', \`a new product must be a draft, got \${r.text}\`);
  return body.product_id;
}

const publish = (c, productId: string, key = 'k-1') => c.post(\`/v1/products/\${productId}/publish\`, {headers: {'Idempotency-Key': key}});

export async function check_route(ctx) {
  const {c, store} = api(ctx);
  const productId = await create(c);
  let r = await c.patch(\`/v1/products/\${productId}\`, {json: FULL});
  assert.equal(r.status, 200, \`PATCH /v1/products/\${productId} answered \${r.status}: \${r.text}\`);
  r = await publish(c, productId);
  assert.equal(r.status, 200, \`POST /v1/products/\${productId}/publish answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.status === 'published' && body.version === 1, \`the publish must answer version 1 as published, got \${r.text}\`);
  const published = await store.publishedOf(productId);
  assert(published !== null && published.version === 1, \`after the publish the store holds published version \${JSON.stringify(published)}\`);
}

export async function check_draft_write(ctx) {
  const {c, store} = api(ctx);
  const productId = await create(c);
  await c.patch(\`/v1/products/\${productId}\`, {json: FULL});
  await publish(c, productId);
  const r = await c.patch(\`/v1/products/\${productId}\`, {json: {title: 'Kettle, 2 L'}});
  assert.equal(r.status, 200, \`an edit after a publish answered \${r.status}: \${r.text}\`);
  assert.equal(r.json().status, 'draft', \`an edit must answer a draft, got \${r.text}\`);
  const published = await store.publishedOf(productId);
  assert(published !== null && published.title === 'Kettle', \`the published row changed under the storefront: \${JSON.stringify(published)}. An edit must write the draft row only\`);
  const draft = await store.draftOf(productId);
  assert(draft !== null && draft.title === 'Kettle, 2 L' && draft.version === 2, \`the edit must open version 2 as the draft, the store holds \${JSON.stringify(draft)}\`);
  assert.equal(draft.price_cents, 3499, \`a new draft starts from the published row, got \${JSON.stringify(draft)}\`);
}

export async function check_required_fields(ctx) {
  const {c, store} = api(ctx);
  const productId = await create(c);
  let r = await publish(c, productId);
  assert.equal(r.status, 422, \`a publish with no price and no tax class answered \${r.status}, expected 422\`);
  assert(r.text.includes('price_cents'), \`the 422 must name the missing field (price_cents), got \${r.text}\`);
  assert.equal(await store.publishedOf(productId), null, 'nothing may be published with required fields unset');
  await c.patch(\`/v1/products/\${productId}\`, {json: {price_cents: 3499}});
  r = await publish(c, productId, 'k-2');
  assert(r.status === 422 && r.text.includes('tax_class'), \`with the price set and the tax class unset the publish answered \${r.status} \${r.text}, expected 422 naming tax_class\`);
  await c.patch(\`/v1/products/\${productId}\`, {json: {tax_class: 'standard'}});
  r = await publish(c, productId, 'k-3');
  assert.equal(r.status, 200, \`with every required field set the publish answered \${r.status}: \${r.text}\`);
}

export async function check_publish_idempotency(ctx) {
  const {c, store} = api(ctx);
  const productId = await create(c);
  await c.patch(\`/v1/products/\${productId}\`, {json: FULL});
  const first = await publish(c, productId, 'k-1');
  assert.equal(first.status, 200, \`the first publish answered \${first.status}: \${first.text}\`);
  const replay = await publish(c, productId, 'k-1');
  assert(replay.status === 200 && replay.text === first.text, \`a replay of the same Idempotency-Key must answer the same result: first \${first.text}, replay \${replay.text}\`);
  await c.patch(\`/v1/products/\${productId}\`, {json: {title: 'Kettle, 2 L'}});
  const late = await publish(c, productId, 'k-1');
  assert.equal(late.json().version, 1, \`a retry of the first publish after an edit minted version \${late.json().version}: the recorded result for (product, key) must be answered instead\`);
  assert.equal((await store.publishedOf(productId)).version, 1, 'the retry promoted the new draft');
  const fresh = await publish(c, productId, 'k-2');
  assert(fresh.status === 200 && fresh.json().version === 2, \`a publish with a new key must promote the new draft (version 2), got \${fresh.status} \${fresh.text}\`);
  const none = await c.post(\`/v1/products/\${productId}/publish\`);
  assert.equal(none.status, 400, \`a publish without Idempotency-Key answered \${none.status}, expected 400\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"strings"

	"catalog/store"

	"leetbuild/harness"
)

var full = map[string]any{"price_cents": 3499, "tax_class": "standard"}

func api(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func create(ctx *harness.Ctx, c *harness.HTTP) string {
	r := c.Post("/v1/products", map[string]string{"title": "Kettle"})
	ctx.Assert(r.Status == 200 || r.Status == 201, "POST /v1/products answered %d: %s", r.Status, r.Text())
	var body struct {
		ProductID string \`json:"product_id"\`
		Status    string \`json:"status"\`
	}
	r.Decode(&body)
	ctx.Equal(body.Status, "draft", "a new product must be a draft (%s)", r.Text())
	return body.ProductID
}

func publish(c *harness.HTTP, productID, key string) *harness.Response {
	return c.Post("/v1/products/"+productID+"/publish", nil, "Idempotency-Key", key)
}

func versionOf(ctx *harness.Ctx, r *harness.Response) int {
	var body struct {
		Version int    \`json:"version"\`
		Status  string \`json:"status"\`
	}
	r.Decode(&body)
	return body.Version
}

func CheckRoute(ctx *harness.Ctx) {
	c := api(ctx)
	productID := create(ctx, c)
	r := c.Patch("/v1/products/"+productID, full)
	ctx.Equal(r.Status, 200, "PATCH /v1/products/%s (%s)", productID, r.Text())
	r = publish(c, productID, "k-1")
	ctx.Equal(r.Status, 200, "POST /v1/products/%s/publish (%s)", productID, r.Text())
	ctx.Assert(strings.Contains(r.Text(), \`"published"\`) && versionOf(ctx, r) == 1, "the publish must answer version 1 as published, got %s", r.Text())
	published := store.PublishedOf(context.Background(), productID)
	ctx.Assert(published != nil && published.Version == 1, "after the publish the store holds published version %v", published)
}

func CheckDraftWrite(ctx *harness.Ctx) {
	c := api(ctx)
	productID := create(ctx, c)
	c.Patch("/v1/products/"+productID, full)
	publish(c, productID, "k-1")
	r := c.Patch("/v1/products/"+productID, map[string]string{"title": "Kettle, 2 L"})
	ctx.Equal(r.Status, 200, "an edit after a publish (%s)", r.Text())
	ctx.Assert(strings.Contains(r.Text(), \`"draft"\`), "an edit must answer a draft, got %s", r.Text())
	published := store.PublishedOf(context.Background(), productID)
	ctx.Assert(published != nil && published.Title == "Kettle", "the published row changed under the storefront: %+v. An edit must write the draft row only", published)
	draft := store.DraftOf(context.Background(), productID)
	ctx.Assert(draft != nil && draft.Title == "Kettle, 2 L" && draft.Version == 2, "the edit must open version 2 as the draft, the store holds %+v", draft)
	ctx.Equal(draft.PriceCents, 3499, "a new draft starts from the published row; its price")
}

func CheckRequiredFields(ctx *harness.Ctx) {
	c := api(ctx)
	productID := create(ctx, c)
	r := publish(c, productID, "k-1")
	ctx.Equal(r.Status, 422, "a publish with no price and no tax class")
	ctx.Assert(strings.Contains(r.Text(), "price_cents"), "the 422 must name the missing field (price_cents), got %s", r.Text())
	ctx.Assert(store.PublishedOf(context.Background(), productID) == nil, "nothing may be published with required fields unset")
	c.Patch("/v1/products/"+productID, map[string]any{"price_cents": 3499})
	r = publish(c, productID, "k-2")
	ctx.Assert(r.Status == 422 && strings.Contains(r.Text(), "tax_class"), "with the price set and the tax class unset the publish answered %d %s, expected 422 naming tax_class", r.Status, r.Text())
	c.Patch("/v1/products/"+productID, map[string]any{"tax_class": "standard"})
	r = publish(c, productID, "k-3")
	ctx.Equal(r.Status, 200, "with every required field set the publish (%s)", r.Text())
}

func CheckPublishIdempotency(ctx *harness.Ctx) {
	c := api(ctx)
	productID := create(ctx, c)
	c.Patch("/v1/products/"+productID, full)
	first := publish(c, productID, "k-1")
	ctx.Equal(first.Status, 200, "the first publish (%s)", first.Text())
	replay := publish(c, productID, "k-1")
	ctx.Assert(replay.Status == 200 && versionOf(ctx, replay) == versionOf(ctx, first), "a replay of the same Idempotency-Key must answer the same result: first %s, replay %s", first.Text(), replay.Text())
	c.Patch("/v1/products/"+productID, map[string]string{"title": "Kettle, 2 L"})
	late := publish(c, productID, "k-1")
	ctx.Equal(versionOf(ctx, late), 1, "a retry of the first publish after an edit must answer the recorded result for (product, key), not mint a version; the version")
	ctx.Equal(store.PublishedOf(context.Background(), productID).Version, 1, "the retry promoted the new draft; the published version")
	fresh := publish(c, productID, "k-2")
	ctx.Assert(fresh.Status == 200 && versionOf(ctx, fresh) == 2, "a publish with a new key must promote the new draft (version 2), got %d %s", fresh.Status, fresh.Text())
	none := c.Post("/v1/products/"+productID+"/publish", nil)
	ctx.Equal(none.Status, 400, "a publish without Idempotency-Key")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <string>

namespace {

const std::string kFull = R"({"price_cents": 3499, "tax_class": "standard"})";

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

std::string create(harness::Ctx& ctx, harness::HTTP& c) {
  const auto r = c.Post("/v1/products", R"({"title": "Kettle"})", "Content-Type", "application/json");
  ctx.Assert(r.Status == 200 || r.Status == 201, "POST /v1/products answered %d: %s", r.Status, r.Text());
  const auto body = nlohmann::json::parse(r.Text());
  ctx.Equal(body.value("status", ""), "draft", "a new product must be a draft (%s)", r.Text());
  return body.value("product_id", "");
}

harness::Response publish(harness::HTTP& c, const std::string& product_id, const std::string& key) {
  return c.Post("/v1/products/" + product_id + "/publish", "", "Idempotency-Key", key);
}

long versionOf(const harness::Response& r) { return nlohmann::json::parse(r.Text()).value("version", 0L); }

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  const std::string product_id = create(ctx, c);
  auto r = c.Patch("/v1/products/" + product_id, kFull, "Content-Type", "application/json");
  ctx.Equal(r.Status, 200, "PATCH /v1/products/%s (%s)", product_id, r.Text());
  r = publish(c, product_id, "k-1");
  ctx.Equal(r.Status, 200, "POST /v1/products/%s/publish (%s)", product_id, r.Text());
  ctx.Assert(r.Text().find("published") != std::string::npos && versionOf(r) == 1, "the publish must answer version 1 as published, got %s", r.Text());
  const auto published = store::publishedOf(product_id);
  ctx.Assert(published && published->version == 1, "after the publish the store holds published version %v", published ? published->version : 0L);
}

void CheckDraftWrite(harness::Ctx& ctx) {
  auto c = api(ctx);
  const std::string product_id = create(ctx, c);
  c.Patch("/v1/products/" + product_id, kFull, "Content-Type", "application/json");
  publish(c, product_id, "k-1");
  const auto r = c.Patch("/v1/products/" + product_id, R"({"title": "Kettle, 2 L"})", "Content-Type", "application/json");
  ctx.Equal(r.Status, 200, "an edit after a publish (%s)", r.Text());
  ctx.Assert(r.Text().find("draft") != std::string::npos, "an edit must answer a draft, got %s", r.Text());
  const auto published = store::publishedOf(product_id);
  ctx.Assert(published && published->title == "Kettle", "the published row changed under the storefront (title %q). An edit must write the draft row only", published ? published->title : "");
  const auto draft = store::draftOf(product_id);
  ctx.Assert(draft && draft->title == "Kettle, 2 L" && draft->version == 2, "the edit must open version 2 as the draft, the store holds version %v title %q", draft ? draft->version : 0L, draft ? draft->title : "");
  ctx.Equal(draft->price_cents, 3499, "a new draft starts from the published row; its price");
}

void CheckRequiredFields(harness::Ctx& ctx) {
  auto c = api(ctx);
  const std::string product_id = create(ctx, c);
  auto r = publish(c, product_id, "k-1");
  ctx.Equal(r.Status, 422, "a publish with no price and no tax class");
  ctx.Assert(r.Text().find("price_cents") != std::string::npos, "the 422 must name the missing field (price_cents), got %s", r.Text());
  ctx.Assert(!store::publishedOf(product_id), "nothing may be published with required fields unset");
  c.Patch("/v1/products/" + product_id, R"({"price_cents": 3499})", "Content-Type", "application/json");
  r = publish(c, product_id, "k-2");
  ctx.Assert(r.Status == 422 && r.Text().find("tax_class") != std::string::npos, "with the price set and the tax class unset the publish answered %d %s, expected 422 naming tax_class", r.Status, r.Text());
  c.Patch("/v1/products/" + product_id, R"({"tax_class": "standard"})", "Content-Type", "application/json");
  r = publish(c, product_id, "k-3");
  ctx.Equal(r.Status, 200, "with every required field set the publish (%s)", r.Text());
}

void CheckPublishIdempotency(harness::Ctx& ctx) {
  auto c = api(ctx);
  const std::string product_id = create(ctx, c);
  c.Patch("/v1/products/" + product_id, kFull, "Content-Type", "application/json");
  const auto first = publish(c, product_id, "k-1");
  ctx.Equal(first.Status, 200, "the first publish (%s)", first.Text());
  const auto replay = publish(c, product_id, "k-1");
  ctx.Assert(replay.Status == 200 && versionOf(replay) == versionOf(first), "a replay of the same Idempotency-Key must answer the same result: first %s, replay %s", first.Text(), replay.Text());
  c.Patch("/v1/products/" + product_id, R"({"title": "Kettle, 2 L"})", "Content-Type", "application/json");
  const auto late = publish(c, product_id, "k-1");
  ctx.Equal(versionOf(late), 1, "a retry of the first publish after an edit must answer the recorded result for (product, key), not mint a version; the version");
  ctx.Equal(store::publishedOf(product_id)->version, 1, "the retry promoted the new draft; the published version");
  const auto fresh = publish(c, product_id, "k-2");
  ctx.Assert(fresh.Status == 200 && versionOf(fresh) == 2, "a publish with a new key must promote the new draft (version 2), got %d %s", fresh.Status, fresh.Text());
  const auto none = c.Post("/v1/products/" + product_id + "/publish", "");
  ctx.Equal(none.Status, 400, "a publish without Idempotency-Key");
}
`,
  },
  hints: [
    'Publish a product, edit its title, then read the published row back: the title the storefront serves has changed, and a publish with no price goes through.',
    'The store keeps one row per version with a draft, published and latest pointer. `upsert` writes the latest row whatever its status; `write_draft` opens the next version instead. The publish never looks at the key, so each retry promotes again.',
    'Edit through `write_draft`; before promoting, read `draft_of`, 422 on the first `REQUIRED_FIELDS` entry that is unset, read `publish_result(product, key)` and answer it when recorded, else `promote` and `record_publish`.',
  ],
  debrief: `The data model is the fix: once the published row is immutable and every edit lands in a draft, rollback, preview and cache invalidation all have something stable to point at. The idempotency record sits in the same store as the versions, keyed by the product and the client's key, so a retry after a timeout reads the first attempt's answer instead of promoting again. Reading the draft before the required-fields check is what keeps an unpriced product from going live. Production catalogs keep the publish record with an expiry, store who promoted what and when, and run the required-field rules per channel, since a marketplace listing needs fields a brand store does not.`,
};
