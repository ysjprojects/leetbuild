import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/assets: metadata first, bytes later',
  concept: 'http',
  guides: ['request-boundaries'],
  file: 'api',
  focus: ['client', 'ingest', 'redis', 'objects'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/assets\` on the asset store (\`ingest.assets\`,
provided): it takes \`{"mime", "byte_size", "caption"}\`, reads the tenant from the body's
\`tenant\` or else \`X-Tenant-Id\`, uses \`Idempotency-Key\` as the checksum and answers **201** with
the pending asset \`assets.create\` returns. It serves the demo and hides four flaws.

**Failure mode the checks target.** A client names another tenant in the body and its image lands
in that tenant's library; an SVG or a 300 MB file is registered for the indexer; a 60 KB caption
becomes the vision model's input; and an uploader that retries after a timeout registers the same
image twice, so search returns it twice.

- The tenant is the authenticated \`X-Tenant-Id\` header (**401** without it); the body's \`tenant\`
  is ignored.
- \`ALLOWED_MIME_TYPES\` are \`image/png\`, \`image/jpeg\`, \`image/webp\`, \`image/gif\` and
  \`image/avif\`; any other \`mime\` is **415**.
- \`byte_size\` is at most \`MAX_ASSET_BYTES\` = 20 MiB (\`20 << 20\`), the caption at most
  \`MAX_CAPTION_BYTES\` = 4 KiB (\`4 << 10\`) of UTF-8; either over is **413**.
- \`Idempotency-Key\` is the content hash, \`sha256:<64 lowercase hex>\` (**400** otherwise). Call
  \`assets.find(tenant, checksum)\` before \`assets.create\`: a re-registration answers **200** with
  the original asset.`,
  sequence: {
    participants: ['Client', 'Ingest API', 'asset store', 'Object store'],
    messages: [
      {
        from: 'Client',
        to: 'Ingest API',
        label: 'POST /v1/assets · X-Tenant-Id · Idempotency-Key: sha256:…',
        kind: 'sync',
      },
      {from: 'Ingest API', to: 'Ingest API', label: '401 · 400 · 415 · 413 guards', kind: 'sync'},
      {from: 'Ingest API', to: 'asset store', label: 'find(tenant, checksum)', kind: 'sync'},
      {from: 'asset store', to: 'Ingest API', label: 'original asset / none', kind: 'reply'},
      {from: 'Ingest API', to: 'asset store', label: 'create(…) → a-7, state pending', kind: 'sync'},
      {from: 'Ingest API', to: 'Client', label: '201 new asset · 200 original asset', kind: 'reply'},
      {from: 'Client', to: 'Object store', label: 'PUT the bytes (they never pass through the API)', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Registers a pending asset on POST /v1/assets',
      detail: 'Register `POST /v1/assets`; a valid registration answers 201 with the pending asset.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/assets["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/assets['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/assets"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"assets"\s*\)/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/assets"/]},
      },
    },
    {
      id: 'tenant-header',
      title: 'Takes the tenant from X-Tenant-Id, never from the body',
      detail:
        "The tenant is the authenticated `X-Tenant-Id` header and a request without it is **401**; the starter prefers the body's `tenant`, so any client can register into another tenant's library.",
      match: {
        python: {all: [/headers\.get\(\s*["']x-tenant-id["']/i, /\b401\b/], none: [/body\.tenant\b/]},
        typescript: {all: [/headers\[\s*['"]x-tenant-id['"]\s*\]/i, /\b401\b/], none: [/body\.tenant\b/]},
        go: {all: [/Header\.Get\(\s*"X-Tenant-Id"\s*\)/i, /StatusUnauthorized|\b401\b/], none: [/body\.Tenant\b/]},
        scala: {
          all: [/HeaderValueByName\(\s*"X-Tenant-Id"\s*\)/i, /Unauthorized|\b401\b/],
          none: [/get\(\s*"tenant"\s*\)/],
        },
        cpp: {all: [/get_header_value\(\s*"X-Tenant-Id"\s*\)/i, /\b401\b/], none: [/value\(\s*"tenant"/]},
      },
    },
    {
      id: 'mime-allowlist',
      title: 'Refuses a mime type outside the allowlist with 415',
      detail:
        '`mime` is checked against `ALLOWED_MIME_TYPES` (png, jpeg, webp, gif, avif) and anything else is **415**; the starter registers whatever the client declared, an SVG included.',
      match: {
        python: {all: [/ALLOWED_MIME_TYPES/, /\b415\b/, /image\/avif/]},
        typescript: {all: [/ALLOWED_MIME_TYPES/, /\b415\b/, /image\/avif/]},
        go: {all: [/allowedMimeTypes/i, /StatusUnsupportedMediaType|\b415\b/, /image\/avif/]},
        scala: {all: [/AllowedMimeTypes/i, /UnsupportedMediaType|\b415\b/, /image\/avif/]},
        cpp: {all: [/kAllowedMimeTypes/i, /\b415\b/, /image\/avif/]},
      },
    },
    {
      id: 'size-caps',
      title: 'Caps the image at 20 MiB and the caption at 4 KiB of UTF-8 with 413',
      detail:
        '`byte_size` over `20 << 20` and a caption over `4 << 10` **bytes** of UTF-8 are **413**; counting the caption in characters lets a caption of multi-byte characters through at up to four times the budget.',
      match: {
        python: {all: [/20\s*<<\s*20/, /4\s*<<\s*10/, /\b413\b/, /\.encode\(/]},
        typescript: {all: [/20\s*<<\s*20/, /4\s*<<\s*10/, /\b413\b/, /TextEncoder|Buffer\.byteLength/]},
        go: {all: [/20\s*<<\s*20/, /4\s*<<\s*10/, /StatusRequestEntityTooLarge|\b413\b/], none: [/RuneCount/]},
        scala: {all: [/20L?\s*<<\s*20/, /4\s*<<\s*10/, /PayloadTooLarge|RequestEntityTooLarge|\b413\b/, /getBytes\(/]},
        cpp: {all: [/20(?:LL|L)?\s*<<\s*20/, /4\s*<<\s*10/, /\b413\b/]},
      },
    },
    {
      id: 'content-hash',
      title: 'Keys the registration by tenant and content hash',
      detail:
        '`Idempotency-Key` must be `sha256:<64 hex>` (**400** otherwise) and is looked up with `assets.find(tenant, checksum)` before `assets.create`, so a retried upload answers **200** with the original asset instead of registering a second one.',
      match: {
        python: {all: [/sha256:/, /\b400\b/], order: [/assets\.find\(/, /assets\.create\(/]},
        typescript: {all: [/sha256:/, /\b400\b/], order: [/\bfind\(/, /\bcreate\(/]},
        go: {all: [/sha256:/, /StatusBadRequest|\b400\b/], order: [/assets\.Find\(/, /assets\.Create\(/]},
        scala: {all: [/sha256:/, /BadRequest|\b400\b/], order: [/Assets\.find\(/, /Assets\.create\(/]},
        cpp: {all: [/sha256:/, /\b400\b/], order: [/assets::find\(/, /assets::create\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from ingest import assets  # assets.find(tenant, checksum), assets.create(tenant, checksum, mime, byte_size, caption)

app = FastAPI()


class AssetRegistration(BaseModel):
    mime: str
    byte_size: int
    caption: str | None = None
    tenant: str | None = None  # older uploader SDKs still send it


@app.post("/v1/assets")
def register_asset(body: AssetRegistration, request: Request) -> JSONResponse:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    tenant = body.tenant or request.headers.get("x-tenant-id", "")
    checksum = request.headers.get("idempotency-key", "")
    if body.byte_size < 1:
        raise HTTPException(status_code=400, detail="byte_size must be at least 1")
    asset = assets.create(tenant, checksum, body.mime, body.byte_size, body.caption)
    return JSONResponse(asset, status_code=201)
`,
      solution: `import re

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from ingest import assets  # assets.find(tenant, checksum), assets.create(tenant, checksum, mime, byte_size, caption)

app = FastAPI()

ALLOWED_MIME_TYPES = {"image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"}
MAX_ASSET_BYTES = 20 << 20
MAX_CAPTION_BYTES = 4 << 10
CONTENT_HASH = re.compile(r"sha256:[0-9a-f]{64}")


class AssetRegistration(BaseModel):
    mime: str
    byte_size: int
    caption: str | None = None
    tenant: str | None = None  # older uploader SDKs still send it; it says nothing about who is calling


@app.post("/v1/assets")
def register_asset(body: AssetRegistration, request: Request) -> JSONResponse:
    # The tenant is who authenticated, not what the body claims.
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    checksum = request.headers.get("idempotency-key", "")
    if not CONTENT_HASH.fullmatch(checksum):
        raise HTTPException(status_code=400, detail="Idempotency-Key must be the content hash, sha256:<64 hex>")
    if body.mime not in ALLOWED_MIME_TYPES:
        raise HTTPException(status_code=415, detail=f"{body.mime} is not an accepted image type")
    if body.byte_size < 1:
        raise HTTPException(status_code=400, detail="byte_size must be at least 1")
    if body.byte_size > MAX_ASSET_BYTES:
        raise HTTPException(status_code=413, detail="the image is larger than 20 MiB")
    # The vision model's budget is bytes, so the caption is measured in UTF-8 bytes, not characters.
    if body.caption is not None and len(body.caption.encode("utf-8")) > MAX_CAPTION_BYTES:
        raise HTTPException(status_code=413, detail="the caption is longer than 4 KiB")
    existing = assets.find(tenant, checksum)
    if existing is not None:
        return JSONResponse(existing, status_code=200)  # the same upload again: the original asset
    asset = assets.create(tenant, checksum, body.mime, body.byte_size, body.caption)
    return JSONResponse(asset, status_code=201)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {create, find} from 'ingest/assets'; // find(tenant, checksum), create(tenant, checksum, mime, byteSize, caption)

export const app = Fastify();

interface AssetRegistration {
  mime: string;
  byte_size: number;
  caption?: string | null;
  tenant?: string; // older uploader SDKs still send it
}

app.post('/v1/assets', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const body = request.body as AssetRegistration;
  const tenant = body.tenant ?? String(request.headers['x-tenant-id'] ?? '');
  const checksum = String(request.headers['idempotency-key'] ?? '');
  if (!(body.byte_size >= 1)) return reply.code(400).send({error: 'byte_size must be at least 1'});
  const asset = await create(tenant, checksum, body.mime, body.byte_size, body.caption ?? null);
  return reply.code(201).send(asset);
});
`,
      solution: `import Fastify from 'fastify';

import {create, find} from 'ingest/assets'; // find(tenant, checksum), create(tenant, checksum, mime, byteSize, caption)

export const app = Fastify();

const ALLOWED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'];
const MAX_ASSET_BYTES = 20 << 20;
const MAX_CAPTION_BYTES = 4 << 10;
const CONTENT_HASH = /^sha256:[0-9a-f]{64}$/;

interface AssetRegistration {
  mime: string;
  byte_size: number;
  caption?: string | null;
  tenant?: string; // older uploader SDKs still send it; it says nothing about who is calling
}

app.post('/v1/assets', async (request, reply) => {
  const body = request.body as AssetRegistration;
  // The tenant is who authenticated, not what the body claims.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const checksum = request.headers['idempotency-key'];
  if (typeof checksum !== 'string' || !CONTENT_HASH.test(checksum)) {
    return reply.code(400).send({error: 'Idempotency-Key must be the content hash, sha256:<64 hex>'});
  }
  if (!ALLOWED_MIME_TYPES.includes(body.mime)) return reply.code(415).send({error: \`\${body.mime} is not an accepted image type\`});
  if (!(body.byte_size >= 1)) return reply.code(400).send({error: 'byte_size must be at least 1'});
  if (body.byte_size > MAX_ASSET_BYTES) return reply.code(413).send({error: 'the image is larger than 20 MiB'});
  // The vision model's budget is bytes, so the caption is measured in UTF-8 bytes, not characters.
  const caption = body.caption ?? null;
  if (caption !== null && new TextEncoder().encode(caption).length > MAX_CAPTION_BYTES) {
    return reply.code(413).send({error: 'the caption is longer than 4 KiB'});
  }
  const existing = await find(tenant, checksum);
  if (existing !== null) return reply.code(200).send(existing); // the same upload again: the original asset
  const asset = await create(tenant, checksum, body.mime, body.byte_size, caption);
  return reply.code(201).send(asset);
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"ingest/assets" // assets.Find(ctx, tenant, checksum), assets.Create(ctx, tenant, checksum, mime, byteSize, caption)
)

type registration struct {
	Mime     string \`json:"mime"\`
	ByteSize int64  \`json:"byte_size"\`
	Caption  string \`json:"caption"\`
	Tenant   string \`json:"tenant"\` // older uploader SDKs still send it
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func registerAsset(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	var body registration
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, "invalid body", http.StatusBadRequest)
		return
	}
	tenant := body.Tenant
	if tenant == "" {
		tenant = r.Header.Get("X-Tenant-Id")
	}
	checksum := r.Header.Get("Idempotency-Key")
	if body.ByteSize < 1 {
		http.Error(rw, "byte_size must be at least 1", http.StatusBadRequest)
		return
	}
	asset, err := assets.Create(r.Context(), tenant, checksum, body.Mime, body.ByteSize, body.Caption)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(rw, http.StatusCreated, asset)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/assets", registerAsset)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"regexp"

	"ingest/assets" // assets.Find(ctx, tenant, checksum), assets.Create(ctx, tenant, checksum, mime, byteSize, caption)
)

const (
	maxAssetBytes   = 20 << 20
	maxCaptionBytes = 4 << 10
)

var allowedMimeTypes = map[string]bool{"image/png": true, "image/jpeg": true, "image/webp": true, "image/gif": true, "image/avif": true}

var contentHash = regexp.MustCompile(\`^sha256:[0-9a-f]{64}$\`)

type registration struct {
	Mime     string \`json:"mime"\`
	ByteSize int64  \`json:"byte_size"\`
	Caption  string \`json:"caption"\`
	Tenant   string \`json:"tenant"\` // older uploader SDKs still send it; it says nothing about who is calling
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func registerAsset(rw http.ResponseWriter, r *http.Request) {
	// The tenant is who authenticated, not what the body claims.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	checksum := r.Header.Get("Idempotency-Key")
	if !contentHash.MatchString(checksum) {
		http.Error(rw, "Idempotency-Key must be the content hash, sha256:<64 hex>", http.StatusBadRequest)
		return
	}
	var body registration
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, "invalid body", http.StatusBadRequest)
		return
	}
	if !allowedMimeTypes[body.Mime] {
		http.Error(rw, body.Mime+" is not an accepted image type", http.StatusUnsupportedMediaType)
		return
	}
	if body.ByteSize < 1 {
		http.Error(rw, "byte_size must be at least 1", http.StatusBadRequest)
		return
	}
	// len counts bytes: the vision model's budget is bytes, not characters.
	if body.ByteSize > maxAssetBytes || len(body.Caption) > maxCaptionBytes {
		http.Error(rw, "the image is larger than 20 MiB or the caption longer than 4 KiB", http.StatusRequestEntityTooLarge)
		return
	}
	if existing := assets.Find(r.Context(), tenant, checksum); existing != nil {
		writeJSON(rw, http.StatusOK, existing) // the same upload again: the original asset
		return
	}
	asset, err := assets.Create(r.Context(), tenant, checksum, body.Mime, body.ByteSize, body.Caption)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(rw, http.StatusCreated, asset)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/assets", registerAsset)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import ingest.Assets // Assets.find(tenant, checksum), Assets.create(tenant, checksum, mime, byteSize, caption)

object Api {
  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def text(fields: Map[String, JsValue], name: String): Option[String] = fields.get(name).collect { case JsString(s) => s }

  val route: Route = path("v1" / "assets") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") { header =>
        optionalHeaderValueByName("Idempotency-Key") { key =>
          entity(as[String]) { raw =>
            // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
            val body = raw.parseJson.asJsObject.fields
            val tenant = body.get("tenant").collect { case JsString(t) => t }.orElse(header).getOrElse("")
            val checksum = key.getOrElse("")
            val byteSize = body.get("byte_size").collect { case JsNumber(n) => n.toLong }.getOrElse(0L)
            if (byteSize < 1) complete(StatusCodes.BadRequest -> "byte_size must be at least 1")
            else {
              val asset = Assets.create(tenant, checksum, text(body, "mime").getOrElse(""), byteSize, text(body, "caption"))
              complete(json(StatusCodes.Created, Assets.toJson(asset)))
            }
          }
        }
      }
    }
  }
}
`,
      solution: `import java.nio.charset.StandardCharsets.UTF_8

import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import ingest.Assets // Assets.find(tenant, checksum), Assets.create(tenant, checksum, mime, byteSize, caption)

object Api {
  val AllowedMimeTypes: Set[String] = Set("image/png", "image/jpeg", "image/webp", "image/gif", "image/avif")
  val MaxAssetBytes: Long = 20L << 20
  val MaxCaptionBytes: Int = 4 << 10
  private val ContentHash = "sha256:[0-9a-f]{64}".r

  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def text(fields: Map[String, JsValue], name: String): Option[String] = fields.get(name).collect { case JsString(s) => s }

  val route: Route = path("v1" / "assets") {
    post {
      // The tenant is who authenticated, not what the body claims.
      optionalHeaderValueByName("X-Tenant-Id") { header =>
        optionalHeaderValueByName("Idempotency-Key") { key =>
          entity(as[String]) { raw =>
            val body = raw.parseJson.asJsObject.fields
            val tenant = header.getOrElse("")
            val checksum = key.getOrElse("")
            val mime = text(body, "mime").getOrElse("")
            val byteSize = body.get("byte_size").collect { case JsNumber(n) => n.toLong }.getOrElse(0L)
            val caption = text(body, "caption")
            if (tenant.isEmpty) complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
            else if (!ContentHash.matches(checksum)) complete(StatusCodes.BadRequest -> "Idempotency-Key must be the content hash, sha256:<64 hex>")
            else if (!AllowedMimeTypes.contains(mime)) complete(StatusCodes.UnsupportedMediaType -> s"$mime is not an accepted image type")
            else if (byteSize < 1) complete(StatusCodes.BadRequest -> "byte_size must be at least 1")
            // The vision model's budget is bytes, so the caption is measured in UTF-8 bytes, not characters.
            else if (byteSize > MaxAssetBytes || caption.exists(_.getBytes(UTF_8).length > MaxCaptionBytes))
              complete(StatusCodes.PayloadTooLarge -> "the image is larger than 20 MiB or the caption longer than 4 KiB")
            else
              Assets.find(tenant, checksum) match {
                case Some(existing) => complete(json(StatusCodes.OK, Assets.toJson(existing))) // the same upload again: the original asset
                case None => complete(json(StatusCodes.Created, Assets.toJson(Assets.create(tenant, checksum, mime, byteSize, caption))))
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

#include <string>

#include "ingest/assets.h"  // assets::find(tenant, checksum), assets::create(tenant, checksum, mime, byte_size, caption)

using json = nlohmann::json;

void refuse(httplib::Response& res, int status, const std::string& message) {
  res.status = status;
  res.set_content(json{{"error", message}}.dump(), "application/json");
}

void register_asset(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return refuse(res, 400, "invalid body");
  std::string tenant = body.value("tenant", "");
  if (tenant.empty()) tenant = req.get_header_value("X-Tenant-Id");
  const std::string checksum = req.get_header_value("Idempotency-Key");
  const long long byte_size = body.value("byte_size", 0LL);
  if (byte_size < 1) return refuse(res, 400, "byte_size must be at least 1");
  const std::string caption = body.contains("caption") && body["caption"].is_string() ? body["caption"].get<std::string>() : "";
  const assets::Asset asset = assets::create(tenant, checksum, body.value("mime", ""), byte_size, caption);
  res.status = 201;
  res.set_content(assets::toJson(asset).dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/assets", register_asset); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <set>
#include <string>

#include "ingest/assets.h"  // assets::find(tenant, checksum), assets::create(tenant, checksum, mime, byte_size, caption)

using json = nlohmann::json;

const std::set<std::string> kAllowedMimeTypes = {"image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"};
constexpr long long kMaxAssetBytes = 20LL << 20;
constexpr size_t kMaxCaptionBytes = 4 << 10;

void refuse(httplib::Response& res, int status, const std::string& message) {
  res.status = status;
  res.set_content(json{{"error", message}}.dump(), "application/json");
}

// sha256:<64 lowercase hex>, the content hash the client computed over the bytes it will upload.
bool isContentHash(const std::string& key) {
  return key.size() == 71 && key.rfind("sha256:", 0) == 0 && key.find_first_not_of("0123456789abcdef", 7) == std::string::npos;
}

void register_asset(const httplib::Request& req, httplib::Response& res) {
  // The tenant is who authenticated, not what the body claims.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return refuse(res, 401, "X-Tenant-Id is required");
  const std::string checksum = req.get_header_value("Idempotency-Key");
  if (!isContentHash(checksum)) return refuse(res, 400, "Idempotency-Key must be the content hash, sha256:<64 hex>");
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return refuse(res, 400, "invalid body");
  const std::string mime = body.value("mime", "");
  if (!kAllowedMimeTypes.count(mime)) return refuse(res, 415, mime + " is not an accepted image type");
  const long long byte_size = body.value("byte_size", 0LL);
  if (byte_size < 1) return refuse(res, 400, "byte_size must be at least 1");
  const std::string caption = body.contains("caption") && body["caption"].is_string() ? body["caption"].get<std::string>() : "";
  // size() counts bytes: the vision model's budget is bytes, not characters.
  if (byte_size > kMaxAssetBytes || caption.size() > kMaxCaptionBytes) {
    return refuse(res, 413, "the image is larger than 20 MiB or the caption longer than 4 KiB");
  }
  if (const auto existing = assets::find(tenant, checksum)) {
    res.status = 200;  // the same upload again: the original asset
    res.set_content(assets::toJson(*existing).dump(), "application/json");
    return;
  }
  const assets::Asset asset = assets::create(tenant, checksum, mime, byte_size, caption);
  res.status = 201;
  res.set_content(assets::toJson(asset).dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/assets", register_asset); }
`,
    },
  },
  harness: {
    python: `from ingest import assets

H1 = "sha256:" + "a" * 64
H2 = "sha256:" + "b" * 64
PNG = {"mime": "image/png", "byte_size": 48213, "caption": "a red kettle on a stove"}


def _key(i):
    return "sha256:" + str(i) * 64


def _api(ctx):
    return ctx.client(ctx.load("api").app)


def _headers(tenant="t1", key=H1):
    headers = {}
    if tenant is not None:
        headers["X-Tenant-Id"] = tenant
    if key is not None:
        headers["Idempotency-Key"] = key
    return headers


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await c.post("/v1/assets", json=PNG, headers=_headers())
    assert r.status_code == 201, f"POST /v1/assets answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("asset_id") and body.get("checksum") == H1 and body.get("state") == "pending" and body.get("tenant") == "t1", f"the answer must be the pending asset with its asset_id, checksum and tenant, got {body}"
    stored = assets.get(body["asset_id"])
    assert stored is not None and stored["tenant"] == "t1" and stored["mime"] == "image/png", f"the store holds {stored} for {body['asset_id']}"


async def check_tenant_header(ctx):
    async with _api(ctx) as c:
        r = await c.post("/v1/assets", json={**PNG, "tenant": "t2"}, headers=_headers("t1"))
        assert r.status_code == 201, f"a registration by t1 answered {r.status_code}: {r.text}"
        assert r.json().get("tenant") == "t1" and assets.find("t2", H1) is None, f"a request authenticated as t1 named tenant t2 in its body and the asset was registered for {r.json().get('tenant')!r}: the tenant is X-Tenant-Id, never the body"
        missing = await c.post("/v1/assets", json=PNG, headers=_headers(None, H2))
    assert missing.status_code == 401, f"a registration without X-Tenant-Id answered {missing.status_code} {missing.text}, expected 401"
    assert ctx.redis.get("asset:seq") == "1", "a registration without a tenant must not create an asset"


async def check_mime_allowlist(ctx):
    async with _api(ctx) as c:
        for i, mime in enumerate(("image/svg+xml", "text/html", "application/pdf")):
            r = await c.post("/v1/assets", json={**PNG, "mime": mime}, headers=_headers(key=_key(i)))
            assert r.status_code == 415, f"a registration declaring {mime} answered {r.status_code}, expected 415: only ALLOWED_MIME_TYPES reach the indexer"
            assert assets.find("t1", _key(i)) is None, f"the {mime} registration was stored"
        for i, mime in enumerate(("image/jpeg", "image/webp", "image/gif", "image/avif"), start=3):
            r = await c.post("/v1/assets", json={**PNG, "mime": mime}, headers=_headers(key=_key(i)))
            assert r.status_code == 201, f"a registration declaring {mime} answered {r.status_code}: {r.text}"


async def check_size_caps(ctx):
    cases = [
        ({**PNG, "byte_size": 20 << 20}, 201, "an image of exactly 20 MiB"),
        ({**PNG, "byte_size": (20 << 20) + 1}, 413, "an image one byte over 20 MiB"),
        ({**PNG, "caption": "k" * 4096}, 201, "a caption of exactly 4096 bytes"),
        ({**PNG, "caption": "\\u20ac" * 1366}, 413, "a caption of 1366 euro signs (1366 characters, 4098 bytes of UTF-8)"),
    ]
    async with _api(ctx) as c:
        for i, (body, want, what) in enumerate(cases):
            r = await c.post("/v1/assets", json=body, headers=_headers(key=_key(i)))
            assert r.status_code == want, f"{what} answered {r.status_code}, expected {want}"


async def check_content_hash(ctx):
    async with _api(ctx) as c:
        first = await c.post("/v1/assets", json=PNG, headers=_headers())
        assert first.status_code == 201, f"the first registration answered {first.status_code}: {first.text}"
        retry = await c.post("/v1/assets", json={**PNG, "caption": "retried"}, headers=_headers())
        assert retry.status_code == 200 and retry.json().get("asset_id") == first.json()["asset_id"], f"a retry with the same content hash answered {retry.status_code} {retry.text}; expected 200 with the original asset {first.json()['asset_id']}, or search returns the image twice"
        other = await c.post("/v1/assets", json=PNG, headers=_headers("t2"))
        assert other.status_code == 201 and other.json().get("asset_id") != first.json()["asset_id"], f"the same image registered by another tenant answered {other.status_code} {other.text}: each tenant gets its own asset"
        for key in (None, "md5:0cc175b9c0f1b6a831c399e269772661", "sha256:" + "z" * 64):
            r = await c.post("/v1/assets", json=PNG, headers=_headers(key=key))
            assert r.status_code == 400, f"Idempotency-Key {key!r} answered {r.status_code}, expected 400: the key is the content hash, sha256:<64 hex>"
    assert ctx.redis.get("asset:seq") == "2", f"{ctx.redis.get('asset:seq')} assets were created, expected 2 (t1's and t2's)"
`,
    typescript: `const H1 = 'sha256:' + 'a'.repeat(64);
const H2 = 'sha256:' + 'b'.repeat(64);
const PNG = {mime: 'image/png', byte_size: 48213, caption: 'a red kettle on a stove'};

const key = (i: number): string => 'sha256:' + String(i).repeat(64);

function api(ctx) {
  return {c: ctx.client(ctx.load('api').app), assets: ctx.load('/support/ingest/assets.ts')};
}

function headers(tenant: string | null = 't1', k: string | null = H1): Record<string, string> {
  const h: Record<string, string> = {};
  if (tenant !== null) h['X-Tenant-Id'] = tenant;
  if (k !== null) h['Idempotency-Key'] = k;
  return h;
}

export async function check_route(ctx) {
  const {c, assets} = api(ctx);
  const r = await c.post('/v1/assets', {json: PNG, headers: headers()});
  assert.equal(r.status, 201, \`POST /v1/assets answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.asset_id && body.checksum === H1 && body.state === 'pending' && body.tenant === 't1', \`the answer must be the pending asset with its asset_id, checksum and tenant, got \${r.text}\`);
  const stored = await assets.get(body.asset_id);
  assert(stored !== null && stored.tenant === 't1' && stored.mime === 'image/png', \`the store holds \${JSON.stringify(stored)} for \${body.asset_id}\`);
}

export async function check_tenant_header(ctx) {
  const {c, assets} = api(ctx);
  const r = await c.post('/v1/assets', {json: {...PNG, tenant: 't2'}, headers: headers('t1')});
  assert.equal(r.status, 201, \`a registration by t1 answered \${r.status}: \${r.text}\`);
  assert(r.json().tenant === 't1' && (await assets.find('t2', H1)) === null, \`a request authenticated as t1 named tenant t2 in its body and the asset was registered for \${r.json().tenant}: the tenant is X-Tenant-Id, never the body\`);
  const missing = await c.post('/v1/assets', {json: PNG, headers: headers(null, H2)});
  assert.equal(missing.status, 401, \`a registration without X-Tenant-Id answered \${missing.status} \${missing.text}, expected 401\`);
  assert.equal(ctx.redis.get('asset:seq'), '1', 'a registration without a tenant must not create an asset');
}

export async function check_mime_allowlist(ctx) {
  const {c, assets} = api(ctx);
  for (const [i, mime] of ['image/svg+xml', 'text/html', 'application/pdf'].entries()) {
    const r = await c.post('/v1/assets', {json: {...PNG, mime}, headers: headers('t1', key(i))});
    assert.equal(r.status, 415, \`a registration declaring \${mime} answered \${r.status}, expected 415: only ALLOWED_MIME_TYPES reach the indexer\`);
    assert.equal(await assets.find('t1', key(i)), null, \`the \${mime} registration was stored\`);
  }
  for (const [i, mime] of ['image/jpeg', 'image/webp', 'image/gif', 'image/avif'].entries()) {
    const r = await c.post('/v1/assets', {json: {...PNG, mime}, headers: headers('t1', key(i + 3))});
    assert.equal(r.status, 201, \`a registration declaring \${mime} answered \${r.status}: \${r.text}\`);
  }
}

export async function check_size_caps(ctx) {
  const {c} = api(ctx);
  const cases: [Record<string, unknown>, number, string][] = [
    [{...PNG, byte_size: 20 << 20}, 201, 'an image of exactly 20 MiB'],
    [{...PNG, byte_size: (20 << 20) + 1}, 413, 'an image one byte over 20 MiB'],
    [{...PNG, caption: 'k'.repeat(4096)}, 201, 'a caption of exactly 4096 bytes'],
    [{...PNG, caption: '\\u20ac'.repeat(1366)}, 413, 'a caption of 1366 euro signs (1366 characters, 4098 bytes of UTF-8)'],
  ];
  for (const [i, [body, want, what]] of cases.entries()) {
    const r = await c.post('/v1/assets', {json: body, headers: headers('t1', key(i))});
    assert.equal(r.status, want, \`\${what} answered \${r.status}, expected \${want}\`);
  }
}

export async function check_content_hash(ctx) {
  const {c} = api(ctx);
  const first = await c.post('/v1/assets', {json: PNG, headers: headers()});
  assert.equal(first.status, 201, \`the first registration answered \${first.status}: \${first.text}\`);
  const original = first.json().asset_id;
  const retry = await c.post('/v1/assets', {json: {...PNG, caption: 'retried'}, headers: headers()});
  assert(retry.status === 200 && retry.json().asset_id === original, \`a retry with the same content hash answered \${retry.status} \${retry.text}; expected 200 with the original asset \${original}, or search returns the image twice\`);
  const other = await c.post('/v1/assets', {json: PNG, headers: headers('t2')});
  assert(other.status === 201 && other.json().asset_id !== original, \`the same image registered by another tenant answered \${other.status} \${other.text}: each tenant gets its own asset\`);
  for (const k of [null, 'md5:0cc175b9c0f1b6a831c399e269772661', 'sha256:' + 'z'.repeat(64)]) {
    const r = await c.post('/v1/assets', {json: PNG, headers: headers('t1', k)});
    assert.equal(r.status, 400, \`Idempotency-Key \${JSON.stringify(k)} answered \${r.status}, expected 400: the key is the content hash, sha256:<64 hex>\`);
  }
  assert.equal(ctx.redis.get('asset:seq'), '2', \`\${ctx.redis.get('asset:seq')} assets were created, expected 2 (t1's and t2's)\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"strings"

	"ingest/assets"

	"leetbuild/harness"
)

var (
	apiBg  = context.Background()
	apiH1  = "sha256:" + strings.Repeat("a", 64)
	apiH2  = "sha256:" + strings.Repeat("b", 64)
	apiPNG = map[string]any{"mime": "image/png", "byte_size": 48213, "caption": "a red kettle on a stove"}
)

func apiKey(i int) string { return "sha256:" + strings.Repeat(string(rune('0'+i)), 64) }

func apiWith(name string, value any) map[string]any {
	body := map[string]any{}
	for k, v := range apiPNG {
		body[k] = v
	}
	body[name] = value
	return body
}

func apiServer(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func postAsset(c *harness.HTTP, body map[string]any, tenant, key string) *harness.Response {
	header := []string{}
	if tenant != "" {
		header = append(header, "X-Tenant-Id", tenant)
	}
	if key != "" {
		header = append(header, "Idempotency-Key", key)
	}
	return c.Post("/v1/assets", body, header...)
}

func assetOf(r *harness.Response) assets.Asset {
	var a assets.Asset
	r.Decode(&a)
	return a
}

func seq(ctx *harness.Ctx) string {
	n, _ := ctx.Redis.Get("asset:seq")
	return n
}

func CheckRoute(ctx *harness.Ctx) {
	c := apiServer(ctx)
	r := postAsset(c, apiPNG, "t1", apiH1)
	ctx.Equal(r.Status, 201, "POST /v1/assets (%s)", r.Text())
	body := assetOf(r)
	ctx.Assert(body.AssetID != "" && body.Checksum == apiH1 && body.State == "pending" && body.Tenant == "t1", "the answer must be the pending asset with its asset_id, checksum and tenant, got %s", r.Text())
	stored := assets.Get(apiBg, body.AssetID)
	ctx.Assert(stored != nil && stored.Tenant == "t1" && stored.Mime == "image/png", "the store holds %+v for %s", stored, body.AssetID)
}

func CheckTenantHeader(ctx *harness.Ctx) {
	c := apiServer(ctx)
	r := postAsset(c, apiWith("tenant", "t2"), "t1", apiH1)
	ctx.Equal(r.Status, 201, "a registration by t1 (%s)", r.Text())
	ctx.Assert(assetOf(r).Tenant == "t1" && assets.Find(apiBg, "t2", apiH1) == nil, "a request authenticated as t1 named tenant t2 in its body and the asset was registered for %q: the tenant is X-Tenant-Id, never the body", assetOf(r).Tenant)
	missing := postAsset(c, apiPNG, "", apiH2)
	ctx.Equal(missing.Status, 401, "a registration without X-Tenant-Id (%s)", missing.Text())
	ctx.Equal(seq(ctx), "1", "a registration without a tenant must not create an asset; the assets created")
}

func CheckMimeAllowlist(ctx *harness.Ctx) {
	c := apiServer(ctx)
	for i, mime := range []string{"image/svg+xml", "text/html", "application/pdf"} {
		r := postAsset(c, apiWith("mime", mime), "t1", apiKey(i))
		ctx.Equal(r.Status, 415, "a registration declaring %s (only the allowed mime types reach the indexer)", mime)
		ctx.Assert(assets.Find(apiBg, "t1", apiKey(i)) == nil, "the %s registration was stored", mime)
	}
	for i, mime := range []string{"image/jpeg", "image/webp", "image/gif", "image/avif"} {
		r := postAsset(c, apiWith("mime", mime), "t1", apiKey(i+3))
		ctx.Equal(r.Status, 201, "a registration declaring %s (%s)", mime, r.Text())
	}
}

func CheckSizeCaps(ctx *harness.Ctx) {
	c := apiServer(ctx)
	cases := []struct {
		body map[string]any
		want int
		what string
	}{
		{apiWith("byte_size", 20<<20), 201, "an image of exactly 20 MiB"},
		{apiWith("byte_size", 20<<20+1), 413, "an image one byte over 20 MiB"},
		{apiWith("caption", strings.Repeat("k", 4096)), 201, "a caption of exactly 4096 bytes"},
		{apiWith("caption", strings.Repeat("\\u20ac", 1366)), 413, "a caption of 1366 euro signs (1366 characters, 4098 bytes of UTF-8)"},
	}
	for i, tc := range cases {
		r := postAsset(c, tc.body, "t1", apiKey(i))
		ctx.Equal(r.Status, tc.want, "%s", tc.what)
	}
}

func CheckContentHash(ctx *harness.Ctx) {
	c := apiServer(ctx)
	first := postAsset(c, apiPNG, "t1", apiH1)
	ctx.Equal(first.Status, 201, "the first registration (%s)", first.Text())
	original := assetOf(first).AssetID
	retry := postAsset(c, apiWith("caption", "retried"), "t1", apiH1)
	ctx.Assert(retry.Status == 200 && assetOf(retry).AssetID == original, "a retry with the same content hash answered %d %s; expected 200 with the original asset %s, or search returns the image twice", retry.Status, retry.Text(), original)
	other := postAsset(c, apiPNG, "t2", apiH1)
	ctx.Assert(other.Status == 201 && assetOf(other).AssetID != original, "the same image registered by another tenant answered %d %s: each tenant gets its own asset", other.Status, other.Text())
	for _, key := range []string{"", "md5:0cc175b9c0f1b6a831c399e269772661", "sha256:" + strings.Repeat("z", 64)} {
		r := postAsset(c, apiPNG, "t1", key)
		ctx.Equal(r.Status, 400, "Idempotency-Key %q (the key is the content hash, sha256:<64 hex>)", key)
	}
	ctx.Equal(seq(ctx), "2", "the assets created (t1's and t2's)")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

namespace {

const std::string kH1 = "sha256:" + std::string(64, 'a');
const std::string kH2 = "sha256:" + std::string(64, 'b');
const nlohmann::json kPng = {{"mime", "image/png"}, {"byte_size", 48213}, {"caption", "a red kettle on a stove"}};

std::string keyOf(int i) { return "sha256:" + std::string(64, static_cast<char>('0' + i)); }

nlohmann::json with(const std::string& name, const nlohmann::json& value) {
  nlohmann::json body = kPng;
  body[name] = value;
  return body;
}

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response postAsset(harness::HTTP& c, const nlohmann::json& body, const std::string& tenant, const std::string& key) {
  const std::string text = body.dump();
  if (tenant.empty() && key.empty()) return c.Post("/v1/assets", text, "Content-Type", "application/json");
  if (tenant.empty()) return c.Post("/v1/assets", text, "Content-Type", "application/json", "Idempotency-Key", key);
  if (key.empty()) return c.Post("/v1/assets", text, "Content-Type", "application/json", "X-Tenant-Id", tenant);
  return c.Post("/v1/assets", text, "Content-Type", "application/json", "X-Tenant-Id", tenant, "Idempotency-Key", key);
}

nlohmann::json bodyOf(const harness::Response& r) {
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  return body.is_object() ? body : nlohmann::json::object();
}

std::string seq(harness::Ctx& ctx) { return ctx.Redis.Get("asset:seq").value_or(""); }

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = postAsset(c, kPng, "t1", kH1);
  ctx.Equal(r.Status, 201, "POST /v1/assets (%s)", r.Text());
  const auto body = bodyOf(r);
  const std::string asset_id = body.value("asset_id", "");
  ctx.Assert(!asset_id.empty() && body.value("checksum", "") == kH1 && body.value("state", "") == "pending" && body.value("tenant", "") == "t1",
             "the answer must be the pending asset with its asset_id, checksum and tenant, got %s", r.Text());
  const auto stored = assets::get(asset_id);
  ctx.Assert(stored && stored->tenant == "t1" && stored->mime == "image/png", "the store holds no image/png asset of t1 under %s", asset_id);
}

void CheckTenantHeader(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = postAsset(c, with("tenant", "t2"), "t1", kH1);
  ctx.Equal(r.Status, 201, "a registration by t1 (%s)", r.Text());
  ctx.Assert(bodyOf(r).value("tenant", "") == "t1" && !assets::find("t2", kH1),
             "a request authenticated as t1 named tenant t2 in its body and the asset was registered for %q: the tenant is X-Tenant-Id, never the body",
             bodyOf(r).value("tenant", ""));
  const auto missing = postAsset(c, kPng, "", kH2);
  ctx.Equal(missing.Status, 401, "a registration without X-Tenant-Id (%s)", missing.Text());
  ctx.Equal(seq(ctx), "1", "a registration without a tenant must not create an asset; the assets created");
}

void CheckMimeAllowlist(harness::Ctx& ctx) {
  auto c = api(ctx);
  const std::vector<std::string> refused = {"image/svg+xml", "text/html", "application/pdf"};
  for (int i = 0; i < static_cast<int>(refused.size()); i++) {
    const auto r = postAsset(c, with("mime", refused[i]), "t1", keyOf(i));
    ctx.Equal(r.Status, 415, "a registration declaring %s (only the allowed mime types reach the indexer)", refused[i]);
    ctx.Assert(!assets::find("t1", keyOf(i)), "the %s registration was stored", refused[i]);
  }
  const std::vector<std::string> accepted = {"image/jpeg", "image/webp", "image/gif", "image/avif"};
  for (int i = 0; i < static_cast<int>(accepted.size()); i++) {
    const auto r = postAsset(c, with("mime", accepted[i]), "t1", keyOf(i + 3));
    ctx.Equal(r.Status, 201, "a registration declaring %s (%s)", accepted[i], r.Text());
  }
}

void CheckSizeCaps(harness::Ctx& ctx) {
  auto c = api(ctx);
  std::string euros;
  for (int i = 0; i < 1366; i++) euros += "\\xe2\\x82\\xac";
  const std::vector<std::tuple<nlohmann::json, int, std::string>> cases = {
      {with("byte_size", 20LL << 20), 201, "an image of exactly 20 MiB"},
      {with("byte_size", (20LL << 20) + 1), 413, "an image one byte over 20 MiB"},
      {with("caption", std::string(4096, 'k')), 201, "a caption of exactly 4096 bytes"},
      {with("caption", euros), 413, "a caption of 1366 euro signs (1366 characters, 4098 bytes of UTF-8)"},
  };
  for (int i = 0; i < static_cast<int>(cases.size()); i++) {
    const auto& [body, want, what] = cases[i];
    const auto r = postAsset(c, body, "t1", keyOf(i));
    ctx.Equal(r.Status, want, "%s", what);
  }
}

void CheckContentHash(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto first = postAsset(c, kPng, "t1", kH1);
  ctx.Equal(first.Status, 201, "the first registration (%s)", first.Text());
  const std::string original = bodyOf(first).value("asset_id", "");
  const auto retry = postAsset(c, with("caption", "retried"), "t1", kH1);
  ctx.Assert(retry.Status == 200 && bodyOf(retry).value("asset_id", "") == original,
             "a retry with the same content hash answered %d %s; expected 200 with the original asset %s, or search returns the image twice",
             retry.Status, retry.Text(), original);
  const auto other = postAsset(c, kPng, "t2", kH1);
  ctx.Assert(other.Status == 201 && bodyOf(other).value("asset_id", "") != original,
             "the same image registered by another tenant answered %d %s: each tenant gets its own asset", other.Status, other.Text());
  for (const std::string key : {std::string(), std::string("md5:0cc175b9c0f1b6a831c399e269772661"), "sha256:" + std::string(64, 'z')}) {
    const auto r = postAsset(c, kPng, "t1", key);
    ctx.Equal(r.Status, 400, "Idempotency-Key %q (the key is the content hash, sha256:<64 hex>)", key);
  }
  ctx.Equal(seq(ctx), "2", "the assets created (t1's and t2's)");
}
`,
  },
  hints: [
    'Register the same image twice with one `Idempotency-Key`: two asset ids come back. Send `"tenant": "t2"` in the body of a t1 request: the asset belongs to t2. An SVG and a 300 MB file are both accepted.',
    'The handler prefers the body for the tenant, calls `assets.create` on every request and compares `mime`, `byte_size` and the caption against nothing, so every request is a new asset and every value passes.',
    "Read `X-Tenant-Id` (401), match the key against `sha256:[0-9a-f]{64}` (400), check `ALLOWED_MIME_TYPES` (415), `20 << 20` and the caption's UTF-8 length against `4 << 10` (413), then `assets.find`: 200 on a hit, else `assets.create` and 201.",
  ],
  debrief: `The guards run in the order of trust: who is calling, which upload this is, then whether its contents are acceptable, so a refused request never touches the store. The content hash is the idempotency key because it names the bytes, not the attempt: a client that retries after a timeout, or uploads the same photo again next week, lands on the asset it already has, and search keeps one vector per image. The caption is measured in UTF-8 bytes because that is the model's budget; a character count lets emoji through at four times the size. Production ingest also verifies the hash when the bytes arrive in object storage, since here the client only claims it, and sniffs the file's magic bytes rather than trusting the declared mime.`,
};
