import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/assets/{id}: signed access with tenant scope',
  concept: 'http',
  file: 'read',
  focus: ['client', 'ingest', 'redis', 'objects'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/assets/{id}\`: it looks the asset up by id with
\`assets.get\`, signs an object-store URL with \`objects.mac(f"{checksum}|{expires_at}")\` valid for
seven days (\`SIGNED_URL_TTL_S\`), and answers \`asset_id\`, \`mime\`, \`checksum\`, \`caption\`,
\`degraded\`, the \`url\` and its \`expires_at\`, plus the image itself, base64 in \`content\`. It
serves the demo gallery and hides four flaws.

**Failure mode the checks target.** Any caller who learns an asset id reads another tenant's image
and caption; a leaked link works for a week; a URL handed to one tenant can be edited to name
another, or a later expiry, and the store still honours it; and every gallery view pulls the whole
image through the API, a third larger as base64.

- The tenant is \`X-Tenant-Id\` (**401** without it). Another tenant's asset is **404**, the answer
  for an id that does not exist; a 403 would confirm the id is real.
- \`SIGNED_URL_TTL_S\` = 900 (15 minutes).
- The URL is \`{BASE_URL}/{checksum}?tenant={tenant}&expires={expires_at}&sig={sig}\` with
  \`sig = objects.mac(f"{checksum}|{tenant}|{expires_at}")\`, so the store's \`verify\` refuses any
  edited part.
- No bytes: the answer is metadata and the URL; the client fetches the image from the store.`,
  sequence: {
    participants: ['Client', 'Ingest API', 'asset store', 'Object store'],
    messages: [
      {from: 'Client', to: 'Ingest API', label: 'GET /v1/assets/a-7 · X-Tenant-Id: t1', kind: 'sync'},
      {from: 'Ingest API', to: 'asset store', label: 'get(a-7) · tenant must be t1, else 404', kind: 'sync'},
      {from: 'Ingest API', to: 'Ingest API', label: 'mac(checksum | t1 | now + 900)', kind: 'sync'},
      {from: 'Ingest API', to: 'Client', label: '200 metadata · url · expires_at (no bytes)', kind: 'reply'},
      {from: 'Client', to: 'Object store', label: 'GET signed url → verify(url, t1)', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Answers the owner with the asset and a URL',
      detail:
        'Register `GET /v1/assets/{id}`; the owner gets 200 with `asset_id`, `mime`, `checksum`, `caption`, `degraded` and a `url`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/assets\/\{asset_id\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/assets\/:/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/assets\/\{/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"assets"\s*\/\s*Segment\s*\)/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/assets\//]},
      },
    },
    {
      id: 'tenant-scope',
      title: "Answers another tenant's asset with 404",
      detail:
        "A request without `X-Tenant-Id` is **401**, and an asset whose tenant is not the caller's is **404**, exactly like an unknown id; the starter serves any asset to anyone who knows its id.",
      match: {
        python: {all: [/\b401\b/, /\[["']tenant["']\]\s*!=\s*tenant|tenant\s*!=\s*\w+\[["']tenant["']\]/]},
        typescript: {all: [/\b401\b/, /\.tenant\s*!==\s*tenant|tenant\s*!==\s*\w+\.tenant/]},
        go: {all: [/StatusUnauthorized|\b401\b/, /\.Tenant\s*!=\s*tenant|tenant\s*!=\s*\w+\.Tenant/]},
        scala: {all: [/Unauthorized|\b401\b/, /filter\(_\.tenant\s*==\s*tenant\)|\.tenant\s*!=\s*tenant/]},
        cpp: {all: [/\b401\b/, /->tenant\s*!=\s*tenant|\.tenant\s*!=\s*tenant/]},
      },
    },
    {
      id: 'url-expiry',
      title: 'Signs the URL for 15 minutes',
      detail:
        '`expires_at` is 900 s after the request (`SIGNED_URL_TTL_S`), so a leaked link dies quickly; the starter signs for seven days.',
      match: {
        python: {all: [/SIGNED_URL_TTL_S\s*=\s*(?:900|15\s*\*\s*60)\b/]},
        typescript: {all: [/SIGNED_URL_TTL_S\s*=\s*(?:900|15\s*\*\s*60)\b/]},
        go: {all: [/signedURLTTLSeconds\s*=\s*(?:900|15\s*\*\s*60)\b/]},
        scala: {all: [/SignedUrlTtlSeconds(?::\s*Long)?\s*=\s*(?:900|15\s*\*\s*60)L?\b/]},
        cpp: {all: [/kSignedUrlTtlSeconds\s*=\s*(?:900|15\s*\*\s*60)\b/]},
      },
    },
    {
      id: 'signature-binds',
      title: 'Signs checksum, tenant and expiry together',
      detail:
        "The MAC covers `checksum|tenant|expires_at`, so a URL edited to name another tenant or a later expiry fails the store's `verify`; the starter signs the checksum and the expiry only.",
      match: {
        python: {all: [/mac\([^\n]*checksum[^\n]*tenant[^\n]*expires/i]},
        typescript: {all: [/mac\([^\n]*checksum[^\n]*tenant[^\n]*expires/i]},
        go: {all: [/Mac\([^\n]*checksum[^\n]*tenant[^\n]*expires/i]},
        scala: {all: [/mac\([^\n]*checksum[^\n]*tenant[^\n]*expires/i]},
        cpp: {all: [/mac\([^\n]*checksum[^\n]*tenant[^\n]*expires/i]},
      },
    },
    {
      id: 'no-bytes',
      title: 'Answers metadata and a URL, never the bytes',
      detail:
        'The answer carries no image data: the client fetches the bytes from the object store with the signed URL. The starter reads the object and inlines it as base64.',
      match: {
        python: {none: [/objects\.read\(/, /b64encode/]},
        typescript: {none: [/\bread\(/, /base64/]},
        go: {none: [/objects\.Read\(/, /base64\./]},
        scala: {none: [/Objects\.read\(/, /Base64/]},
        cpp: {none: [/objects::read\(/, /base64/i]},
      },
    },
  ],
  code: {
    python: {
      starter: `import base64
import time

from fastapi import FastAPI, HTTPException, Request

from ingest import assets, objects  # assets.get(asset_id); objects.BASE_URL, objects.mac(message), objects.read(checksum)

app = FastAPI()

SIGNED_URL_TTL_S = 7 * 24 * 3600


@app.get("/v1/assets/{asset_id}")
def read_asset(asset_id: str, request: Request) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    asset = assets.get(asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="no such asset")
    expires_at = int(time.time()) + SIGNED_URL_TTL_S
    sig = objects.mac(f"{asset['checksum']}|{expires_at}")
    data = objects.read(asset["checksum"]) or b""
    return {
        "asset_id": asset["asset_id"],
        "mime": asset["mime"],
        "checksum": asset["checksum"],
        "caption": asset["caption"],
        "degraded": asset["degraded"],
        "url": f"{objects.BASE_URL}/{asset['checksum']}?tenant={tenant}&expires={expires_at}&sig={sig}",
        "expires_at": expires_at,
        "content": base64.b64encode(data).decode(),  # the gallery renders inline, without a second request
    }
`,
      solution: `import time

from fastapi import FastAPI, HTTPException, Request

from ingest import assets, objects  # assets.get(asset_id); objects.BASE_URL, objects.mac(message), objects.read(checksum)

app = FastAPI()

SIGNED_URL_TTL_S = 15 * 60


@app.get("/v1/assets/{asset_id}")
def read_asset(asset_id: str, request: Request) -> dict:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    asset = assets.get(asset_id)
    # Another tenant's asset is answered like one that does not exist: a 403 would confirm the id.
    if asset is None or asset["tenant"] != tenant:
        raise HTTPException(status_code=404, detail="no such asset")
    expires_at = int(time.time()) + SIGNED_URL_TTL_S
    # The MAC covers everything the URL grants: these bytes, to this tenant, until then.
    sig = objects.mac(f"{asset['checksum']}|{tenant}|{expires_at}")
    return {
        "asset_id": asset["asset_id"],
        "mime": asset["mime"],
        "checksum": asset["checksum"],
        "caption": asset["caption"],
        "degraded": asset["degraded"],
        "url": f"{objects.BASE_URL}/{asset['checksum']}?tenant={tenant}&expires={expires_at}&sig={sig}",
        "expires_at": expires_at,
    }
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {get} from 'ingest/assets';
import {BASE_URL, mac, read} from 'ingest/objects';

export const app = Fastify();

export const SIGNED_URL_TTL_S = 7 * 24 * 3600;

app.get('/v1/assets/:assetId', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const {assetId} = request.params as {assetId: string};
  const tenant = String(request.headers['x-tenant-id'] ?? '');
  const asset = await get(assetId);
  if (asset === null) return reply.code(404).send({error: 'no such asset'});
  const expiresAt = Math.floor(Date.now() / 1000) + SIGNED_URL_TTL_S;
  const sig = mac(\`\${asset.checksum}|\${expiresAt}\`);
  const data = await read(asset.checksum);
  return {
    asset_id: asset.asset_id,
    mime: asset.mime,
    checksum: asset.checksum,
    caption: asset.caption,
    degraded: asset.degraded,
    url: \`\${BASE_URL}/\${asset.checksum}?tenant=\${tenant}&expires=\${expiresAt}&sig=\${sig}\`,
    expires_at: expiresAt,
    content: data === null ? '' : data.toString('base64'), // the gallery renders inline, without a second request
  };
});
`,
      solution: `import Fastify from 'fastify';

import {get} from 'ingest/assets';
import {BASE_URL, mac} from 'ingest/objects';

export const app = Fastify();

export const SIGNED_URL_TTL_S = 15 * 60;

app.get('/v1/assets/:assetId', async (request, reply) => {
  const {assetId} = request.params as {assetId: string};
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const asset = await get(assetId);
  // Another tenant's asset is answered like one that does not exist: a 403 would confirm the id.
  if (asset === null || asset.tenant !== tenant) return reply.code(404).send({error: 'no such asset'});
  const expiresAt = Math.floor(Date.now() / 1000) + SIGNED_URL_TTL_S;
  // The MAC covers everything the URL grants: these bytes, to this tenant, until then.
  const sig = mac(\`\${asset.checksum}|\${tenant}|\${expiresAt}\`);
  return {
    asset_id: asset.asset_id,
    mime: asset.mime,
    checksum: asset.checksum,
    caption: asset.caption,
    degraded: asset.degraded,
    url: \`\${BASE_URL}/\${asset.checksum}?tenant=\${tenant}&expires=\${expiresAt}&sig=\${sig}\`,
    expires_at: expiresAt,
  };
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"ingest/assets"  // assets.Get(ctx, assetID)
	"ingest/objects" // objects.BaseURL, objects.Mac(message), objects.Read(ctx, checksum)
)

const signedURLTTLSeconds = 7 * 24 * 3600

func readAsset(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	asset := assets.Get(r.Context(), r.PathValue("id"))
	if asset == nil {
		http.Error(rw, "no such asset", http.StatusNotFound)
		return
	}
	expiresAt := time.Now().Unix() + signedURLTTLSeconds
	sig := objects.Mac(fmt.Sprintf("%s|%d", asset.Checksum, expiresAt))
	data := objects.Read(r.Context(), asset.Checksum)
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode(map[string]any{
		"asset_id":   asset.AssetID,
		"mime":       asset.Mime,
		"checksum":   asset.Checksum,
		"caption":    asset.Caption,
		"degraded":   asset.Degraded,
		"url":        fmt.Sprintf("%s/%s?tenant=%s&expires=%d&sig=%s", objects.BaseURL, asset.Checksum, tenant, expiresAt, sig),
		"expires_at": expiresAt,
		"content":    base64.StdEncoding.EncodeToString(data), // the gallery renders inline, without a second request
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/assets/{id}", readAsset)
}
`,
      solution: `package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"ingest/assets"  // assets.Get(ctx, assetID)
	"ingest/objects" // objects.BaseURL, objects.Mac(message), objects.Read(ctx, checksum)
)

const signedURLTTLSeconds = 15 * 60

func readAsset(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	asset := assets.Get(r.Context(), r.PathValue("id"))
	// Another tenant's asset is answered like one that does not exist: a 403 would confirm the id.
	if asset == nil || asset.Tenant != tenant {
		http.Error(rw, "no such asset", http.StatusNotFound)
		return
	}
	expiresAt := time.Now().Unix() + signedURLTTLSeconds
	// The MAC covers everything the URL grants: these bytes, to this tenant, until then.
	sig := objects.Mac(fmt.Sprintf("%s|%s|%d", asset.Checksum, tenant, expiresAt))
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode(map[string]any{
		"asset_id":   asset.AssetID,
		"mime":       asset.Mime,
		"checksum":   asset.Checksum,
		"caption":    asset.Caption,
		"degraded":   asset.Degraded,
		"url":        fmt.Sprintf("%s/%s?tenant=%s&expires=%d&sig=%s", objects.BaseURL, asset.Checksum, tenant, expiresAt, sig),
		"expires_at": expiresAt,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/assets/{id}", readAsset)
}
`,
    },
    scala: {
      starter: `import java.util.Base64

import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import ingest.{Assets, Objects} // Assets.get(assetId); Objects.BaseUrl, Objects.mac(message), Objects.read(checksum)

object Read {
  val SignedUrlTtlSeconds: Long = 7 * 24 * 3600

  val route: Route = path("v1" / "assets" / Segment) { assetId =>
    get {
      optionalHeaderValueByName("X-Tenant-Id") { header =>
        // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
        val tenant = header.getOrElse("")
        Assets.get(assetId) match {
          case None => complete(StatusCodes.NotFound -> "no such asset")
          case Some(asset) =>
            val expiresAt = System.currentTimeMillis() / 1000 + SignedUrlTtlSeconds
            val sig = Objects.mac(s"\${asset.checksum}|$expiresAt")
            val content = Objects.read(asset.checksum).map(Base64.getEncoder.encodeToString).getOrElse("")
            val body = JsObject(
              "asset_id" -> JsString(asset.assetId),
              "mime" -> JsString(asset.mime),
              "checksum" -> JsString(asset.checksum),
              "caption" -> asset.caption.map(JsString(_)).getOrElse(JsNull),
              "degraded" -> JsBoolean(asset.degraded),
              "url" -> JsString(s"\${Objects.BaseUrl}/\${asset.checksum}?tenant=$tenant&expires=$expiresAt&sig=$sig"),
              "expires_at" -> JsNumber(expiresAt),
              "content" -> JsString(content)) // the gallery renders inline, without a second request
            complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint)))
        }
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import ingest.{Assets, Objects} // Assets.get(assetId); Objects.BaseUrl, Objects.mac(message), Objects.read(checksum)

object Read {
  val SignedUrlTtlSeconds: Long = 15 * 60

  val route: Route = path("v1" / "assets" / Segment) { assetId =>
    get {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
        case Some(tenant) =>
          // Another tenant's asset is answered like one that does not exist: a 403 would confirm the id.
          Assets.get(assetId).filter(_.tenant == tenant) match {
            case None => complete(StatusCodes.NotFound -> "no such asset")
            case Some(asset) =>
              val expiresAt = System.currentTimeMillis() / 1000 + SignedUrlTtlSeconds
              // The MAC covers everything the URL grants: these bytes, to this tenant, until then.
              val sig = Objects.mac(s"\${asset.checksum}|$tenant|$expiresAt")
              val body = JsObject(
                "asset_id" -> JsString(asset.assetId),
                "mime" -> JsString(asset.mime),
                "checksum" -> JsString(asset.checksum),
                "caption" -> asset.caption.map(JsString(_)).getOrElse(JsNull),
                "degraded" -> JsBoolean(asset.degraded),
                "url" -> JsString(s"\${Objects.BaseUrl}/\${asset.checksum}?tenant=$tenant&expires=$expiresAt&sig=$sig"),
                "expires_at" -> JsNumber(expiresAt))
              complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint)))
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

#include <chrono>
#include <string>

#include "ingest/assets.h"   // assets::get(asset_id)
#include "ingest/objects.h"  // objects::kBaseUrl, objects::mac(message), objects::read(checksum)

using json = nlohmann::json;

constexpr long long kSignedUrlTtlSeconds = 7 * 24 * 3600;

std::string base64Of(const std::string& data) {
  static const char* alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  for (size_t i = 0; i < data.size(); i += 3) {
    const unsigned n = (static_cast<unsigned char>(data[i]) << 16) | (i + 1 < data.size() ? static_cast<unsigned char>(data[i + 1]) << 8 : 0) |
                       (i + 2 < data.size() ? static_cast<unsigned char>(data[i + 2]) : 0);
    out += alphabet[(n >> 18) & 63];
    out += alphabet[(n >> 12) & 63];
    out += i + 1 < data.size() ? alphabet[(n >> 6) & 63] : '=';
    out += i + 2 < data.size() ? alphabet[n & 63] : '=';
  }
  return out;
}

void read_asset(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  const auto asset = assets::get(req.matches[1]);
  if (!asset) {
    res.status = 404;
    res.set_content(json{{"error", "no such asset"}}.dump(), "application/json");
    return;
  }
  const long long now = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  const long long expires_at = now + kSignedUrlTtlSeconds;
  const std::string sig = objects::mac(asset->checksum + "|" + std::to_string(expires_at));
  const json body = {
      {"asset_id", asset->asset_id},
      {"mime", asset->mime},
      {"checksum", asset->checksum},
      {"caption", asset->caption.empty() ? json(nullptr) : json(asset->caption)},
      {"degraded", asset->degraded},
      {"url", objects::kBaseUrl + "/" + asset->checksum + "?tenant=" + tenant + "&expires=" + std::to_string(expires_at) + "&sig=" + sig},
      {"expires_at", expires_at},
      {"content", base64Of(objects::read(asset->checksum).value_or(""))},  // the gallery renders inline, without a second request
  };
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/assets/([\\w-]+))", read_asset); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <string>

#include "ingest/assets.h"   // assets::get(asset_id)
#include "ingest/objects.h"  // objects::kBaseUrl, objects::mac(message), objects::read(checksum)

using json = nlohmann::json;

constexpr long long kSignedUrlTtlSeconds = 15 * 60;

void read_asset(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content(json{{"error", "X-Tenant-Id is required"}}.dump(), "application/json");
    return;
  }
  const auto asset = assets::get(req.matches[1]);
  // Another tenant's asset is answered like one that does not exist: a 403 would confirm the id.
  if (!asset || asset->tenant != tenant) {
    res.status = 404;
    res.set_content(json{{"error", "no such asset"}}.dump(), "application/json");
    return;
  }
  const long long now = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  const long long expires_at = now + kSignedUrlTtlSeconds;
  // The MAC covers everything the URL grants: these bytes, to this tenant, until then.
  const std::string sig = objects::mac(asset->checksum + "|" + tenant + "|" + std::to_string(expires_at));
  const json body = {
      {"asset_id", asset->asset_id},
      {"mime", asset->mime},
      {"checksum", asset->checksum},
      {"caption", asset->caption.empty() ? json(nullptr) : json(asset->caption)},
      {"degraded", asset->degraded},
      {"url", objects::kBaseUrl + "/" + asset->checksum + "?tenant=" + tenant + "&expires=" + std::to_string(expires_at) + "&sig=" + sig},
      {"expires_at", expires_at},
  };
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/assets/([\\w-]+))", read_asset); }
`,
    },
  },
  harness: {
    python: `import re
import time

from ingest import assets, objects

H1 = "sha256:" + "a" * 64
H2 = "sha256:" + "b" * 64
IMAGE = b"\\x89PNG" + bytes(range(256)) * 256


def _seed(ctx):
    assets.create("t1", H1, "image/png", len(IMAGE), "a red kettle on a stove")
    assets.create("t2", H2, "image/jpeg", 1024, "t2's private photo")
    ctx.redis_bytes.set(f"object:{H1}", IMAGE)


def _api(ctx):
    return ctx.client(ctx.load("read").app)


async def _get(c, asset_id, tenant="t1"):
    return await c.get(f"/v1/assets/{asset_id}", headers={"X-Tenant-Id": tenant} if tenant else {})


async def check_route(ctx):
    _seed(ctx)
    async with _api(ctx) as c:
        r = await _get(c, "a-1")
    assert r.status_code == 200, f"GET /v1/assets/a-1 by its owner answered {r.status_code}: {r.text}"
    body = r.json()
    want = {"asset_id": "a-1", "mime": "image/png", "checksum": H1, "caption": "a red kettle on a stove", "degraded": False}
    got = {k: body.get(k) for k in want}
    assert got == want, f"the answer carries {got}, expected {want}"
    assert str(body.get("url", "")).startswith(objects.BASE_URL + "/"), f"the answer's url is {body.get('url')!r}, expected an object-store URL"


async def check_tenant_scope(ctx):
    _seed(ctx)
    async with _api(ctx) as c:
        foreign = await _get(c, "a-2", "t1")
        unknown = await _get(c, "a-404", "t1")
        anonymous = await _get(c, "a-1", None)
    assert foreign.status_code == 404, f"t1 reading t2's asset a-2 answered {foreign.status_code}: {foreign.text[:200]}. Another tenant's asset is 404, the answer for an id that does not exist"
    assert "private" not in foreign.text, "the refusal leaked t2's caption"
    assert unknown.status_code == 404, f"an unknown asset id answered {unknown.status_code}, expected 404"
    assert anonymous.status_code == 401, f"a request without X-Tenant-Id answered {anonymous.status_code}, expected 401"


async def check_url_expiry(ctx):
    _seed(ctx)
    now = time.time()
    async with _api(ctx) as c:
        r = await _get(c, "a-1")
    body = r.json()
    expires_at = body.get("expires_at")
    assert isinstance(expires_at, int) and now + 890 <= expires_at <= now + 910, f"the signed URL expires at {expires_at!r}, {(expires_at or now) - now:.0f} s from now: a read URL lives 15 minutes (SIGNED_URL_TTL_S = 900), so a leaked link dies quickly"
    assert f"expires={expires_at}" in body.get("url", ""), f"the URL {body.get('url')} does not carry expires={expires_at}"
    ctx.clock.advance(901)
    assert not objects.verify(body["url"], "t1"), "fifteen minutes later the object store still serves the URL"


async def check_signature_binds(ctx):
    _seed(ctx)
    async with _api(ctx) as c:
        r = await _get(c, "a-1")
    url = r.json().get("url", "")
    assert objects.verify(url, "t1"), f"the object store refuses {url} for t1: sig must be objects.mac(f'{{checksum}}|{{tenant}}|{{expires_at}}')"
    other = url.replace("tenant=t1", "tenant=t2")
    assert not objects.verify(other, "t2"), "a URL handed to t1, edited to name t2, is served to t2: the MAC must cover the tenant"
    later = re.sub(r"expires=(\\d+)", lambda m: f"expires={int(m.group(1)) + 86400}", url)
    assert not objects.verify(later, "t1"), "a URL whose expiry was pushed a day later is still served: the MAC must cover expires_at"


async def check_no_bytes(ctx):
    _seed(ctx)
    async with _api(ctx) as c:
        r = await _get(c, "a-1")
    assert r.status_code == 200, f"GET /v1/assets/a-1 answered {r.status_code}"
    assert len(r.content) < 4096, f"GET /v1/assets/a-1 answered {len(r.content)} bytes for a {len(IMAGE)}-byte image: the API carried the image itself. Answer metadata and the signed URL; the client fetches the bytes from the object store"
    bulky = [k for k, v in r.json().items() if isinstance(v, str) and len(v) > 1024]
    assert not bulky, f"the answer carries {bulky}: no image data in the API's answer"
`,
    typescript: `const H1 = 'sha256:' + 'a'.repeat(64);
const H2 = 'sha256:' + 'b'.repeat(64);
const IMAGE = new Uint8Array(4 + 65536).map((_, i) => (i < 4 ? [0x89, 0x50, 0x4e, 0x47][i] : (i - 4) % 256));

async function api(ctx) {
  const assets = ctx.load('/support/ingest/assets.ts');
  await assets.create('t1', H1, 'image/png', IMAGE.length, 'a red kettle on a stove');
  await assets.create('t2', H2, 'image/jpeg', 1024, "t2's private photo");
  ctx.redis.set(\`object:\${H1}\`, IMAGE);
  return {c: ctx.client(ctx.load('read').app), objects: ctx.load('/support/ingest/objects.ts')};
}

const get = (c, assetId: string, tenant: string | null = 't1') =>
  c.get(\`/v1/assets/\${assetId}\`, {headers: tenant === null ? {} : {'X-Tenant-Id': tenant}});

export async function check_route(ctx) {
  const {c, objects} = await api(ctx);
  const r = await get(c, 'a-1');
  assert.equal(r.status, 200, \`GET /v1/assets/a-1 by its owner answered \${r.status}: \${r.text}\`);
  const body = r.json();
  const want = {asset_id: 'a-1', mime: 'image/png', checksum: H1, caption: 'a red kettle on a stove', degraded: false};
  const got = Object.fromEntries(Object.keys(want).map(k => [k, body[k]]));
  assert.deepStrictEqual(got, want, \`the answer carries \${JSON.stringify(got)}, expected \${JSON.stringify(want)}\`);
  assert(String(body.url ?? '').startsWith(objects.BASE_URL + '/'), \`the answer's url is \${body.url}, expected an object-store URL\`);
}

export async function check_tenant_scope(ctx) {
  const {c} = await api(ctx);
  const foreign = await get(c, 'a-2', 't1');
  const unknown = await get(c, 'a-404', 't1');
  const anonymous = await get(c, 'a-1', null);
  assert.equal(foreign.status, 404, \`t1 reading t2's asset a-2 answered \${foreign.status}: \${foreign.text.slice(0, 200)}. Another tenant's asset is 404, the answer for an id that does not exist\`);
  assert(!foreign.text.includes('private'), "the refusal leaked t2's caption");
  assert.equal(unknown.status, 404, \`an unknown asset id answered \${unknown.status}, expected 404\`);
  assert.equal(anonymous.status, 401, \`a request without X-Tenant-Id answered \${anonymous.status}, expected 401\`);
}

export async function check_url_expiry(ctx) {
  const {c, objects} = await api(ctx);
  const now = ctx.clock.now() / 1000;
  const body = (await get(c, 'a-1')).json();
  const expiresAt = body.expires_at;
  assert(typeof expiresAt === 'number' && expiresAt >= now + 890 && expiresAt <= now + 910, \`the signed URL expires at \${expiresAt}, \${Math.round((expiresAt ?? now) - now)} s from now: a read URL lives 15 minutes (SIGNED_URL_TTL_S = 900), so a leaked link dies quickly\`);
  assert(String(body.url).includes(\`expires=\${expiresAt}\`), \`the URL \${body.url} does not carry expires=\${expiresAt}\`);
  ctx.clock.advance(901);
  assert(!objects.verify(body.url, 't1'), 'fifteen minutes later the object store still serves the URL');
}

export async function check_signature_binds(ctx) {
  const {c, objects} = await api(ctx);
  const url = String((await get(c, 'a-1')).json().url ?? '');
  assert(objects.verify(url, 't1'), \`the object store refuses \${url} for t1: sig must be objects.mac(\\\`\\\${checksum}|\\\${tenant}|\\\${expiresAt}\\\`)\`);
  assert(!objects.verify(url.replace('tenant=t1', 'tenant=t2'), 't2'), 'a URL handed to t1, edited to name t2, is served to t2: the MAC must cover the tenant');
  const later = url.replace(/expires=(\\d+)/, (_, n) => \`expires=\${Number(n) + 86400}\`);
  assert(!objects.verify(later, 't1'), 'a URL whose expiry was pushed a day later is still served: the MAC must cover expires_at');
}

export async function check_no_bytes(ctx) {
  const {c} = await api(ctx);
  const r = await get(c, 'a-1');
  assert.equal(r.status, 200, \`GET /v1/assets/a-1 answered \${r.status}\`);
  assert(r.text.length < 4096, \`GET /v1/assets/a-1 answered \${r.text.length} bytes for a \${IMAGE.length}-byte image: the API carried the image itself. Answer metadata and the signed URL; the client fetches the bytes from the object store\`);
  const bulky = Object.entries(r.json()).filter(([, v]) => typeof v === 'string' && v.length > 1024).map(([k]) => k);
  assert.deepStrictEqual(bulky, [], \`the answer carries \${JSON.stringify(bulky)}: no image data in the API's answer\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"ingest/assets"
	"ingest/objects"

	"leetbuild/harness"
)

var (
	readBg = context.Background()
	readH1 = "sha256:" + strings.Repeat("a", 64)
	readH2 = "sha256:" + strings.Repeat("b", 64)
)

func readImage() []byte {
	image := []byte{0x89, 'P', 'N', 'G'}
	for i := 0; i < 65536; i++ {
		image = append(image, byte(i%256))
	}
	return image
}

func readServer(ctx *harness.Ctx) *harness.HTTP {
	_, err := assets.Create(readBg, "t1", readH1, "image/png", int64(len(readImage())), "a red kettle on a stove")
	ctx.NoError(err, "seeding a-1")
	_, err = assets.Create(readBg, "t2", readH2, "image/jpeg", 1024, "t2's private photo")
	ctx.NoError(err, "seeding a-2")
	ctx.Redis.Set("object:"+readH1, readImage())
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func readGet(c *harness.HTTP, assetID, tenant string) *harness.Response {
	if tenant == "" {
		return c.Get("/v1/assets/" + assetID)
	}
	return c.Get("/v1/assets/"+assetID, "X-Tenant-Id", tenant)
}

func readBody(ctx *harness.Ctx, r *harness.Response) map[string]any {
	body, ok := r.JSON().(map[string]any)
	ctx.Assert(ok, "the answer must be a JSON object, got %s", r.Text())
	return body
}

func CheckRoute(ctx *harness.Ctx) {
	c := readServer(ctx)
	r := readGet(c, "a-1", "t1")
	ctx.Equal(r.Status, 200, "GET /v1/assets/a-1 by its owner (%s)", r.Text())
	body := readBody(ctx, r)
	got := map[string]any{}
	for _, k := range []string{"asset_id", "mime", "checksum", "caption", "degraded"} {
		got[k] = body[k]
	}
	ctx.Equal(got, map[string]any{"asset_id": "a-1", "mime": "image/png", "checksum": readH1, "caption": "a red kettle on a stove", "degraded": false}, "the answer's fields")
	url, _ := body["url"].(string)
	ctx.Assert(strings.HasPrefix(url, objects.BaseURL+"/"), "the answer's url is %q, expected an object-store URL", url)
}

func CheckTenantScope(ctx *harness.Ctx) {
	c := readServer(ctx)
	foreign := readGet(c, "a-2", "t1")
	ctx.Equal(foreign.Status, 404, "t1 reading t2's asset a-2 (another tenant's asset is 404, the answer for an id that does not exist)")
	ctx.Assert(!strings.Contains(foreign.Text(), "private"), "the refusal leaked t2's caption")
	ctx.Equal(readGet(c, "a-404", "t1").Status, 404, "an unknown asset id")
	ctx.Equal(readGet(c, "a-1", "").Status, 401, "a request without X-Tenant-Id")
}

func CheckUrlExpiry(ctx *harness.Ctx) {
	c := readServer(ctx)
	now := float64(ctx.Clock.Now()) / 1000
	body := readBody(ctx, readGet(c, "a-1", "t1"))
	expiresAt, _ := body["expires_at"].(float64)
	ctx.Assert(expiresAt >= now+890 && expiresAt <= now+910, "the signed URL expires %.0f s from now: a read URL lives 15 minutes (900 s), so a leaked link dies quickly", expiresAt-now)
	url, _ := body["url"].(string)
	ctx.Assert(strings.Contains(url, "expires="+strconv.FormatInt(int64(expiresAt), 10)), "the URL %s does not carry its expires_at", url)
	ctx.Clock.Advance(901)
	ctx.Assert(!objects.Verify(url, "t1"), "fifteen minutes later the object store still serves the URL")
}

func CheckSignatureBinds(ctx *harness.Ctx) {
	c := readServer(ctx)
	url, _ := readBody(ctx, readGet(c, "a-1", "t1"))["url"].(string)
	ctx.Assert(objects.Verify(url, "t1"), "the object store refuses %s for t1: sig must be objects.Mac(checksum|tenant|expires_at)", url)
	ctx.Assert(!objects.Verify(strings.Replace(url, "tenant=t1", "tenant=t2", 1), "t2"), "a URL handed to t1, edited to name t2, is served to t2: the MAC must cover the tenant")
	later := regexp.MustCompile(\`expires=(\\d+)\`).ReplaceAllStringFunc(url, func(m string) string {
		n, _ := strconv.ParseInt(strings.TrimPrefix(m, "expires="), 10, 64)
		return "expires=" + strconv.FormatInt(n+86400, 10)
	})
	ctx.Assert(!objects.Verify(later, "t1"), "a URL whose expiry was pushed a day later is still served: the MAC must cover expires_at")
}

func CheckNoBytes(ctx *harness.Ctx) {
	c := readServer(ctx)
	r := readGet(c, "a-1", "t1")
	ctx.Equal(r.Status, 200, "GET /v1/assets/a-1")
	ctx.Assert(len(r.Body) < 4096, "GET /v1/assets/a-1 answered %d bytes for a %d-byte image: the API carried the image itself. Answer metadata and the signed URL; the client fetches the bytes from the object store", len(r.Body), len(readImage()))
	for k, v := range readBody(ctx, r) {
		s, isText := v.(string)
		ctx.Assert(!isText || len(s) <= 1024, "the answer carries %s (%d characters): no image data in the API's answer", k, len(s))
	}
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <regex>
#include <string>

namespace {

const std::string kH1 = "sha256:" + std::string(64, 'a');
const std::string kH2 = "sha256:" + std::string(64, 'b');

std::string image() {
  std::string data = "\\x89PNG";
  for (int i = 0; i < 65536; i++) data += static_cast<char>(i % 256);
  return data;
}

harness::HTTP api(harness::Ctx& ctx) {
  assets::create("t1", kH1, "image/png", static_cast<long long>(image().size()), "a red kettle on a stove");
  assets::create("t2", kH2, "image/jpeg", 1024, "t2's private photo");
  ctx.Redis.Set("object:" + kH1, image());
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response readGet(harness::HTTP& c, const std::string& asset_id, const std::string& tenant) {
  if (tenant.empty()) return c.Get("/v1/assets/" + asset_id);
  return c.Get("/v1/assets/" + asset_id, "X-Tenant-Id", tenant);
}

nlohmann::json bodyOf(harness::Ctx& ctx, const harness::Response& r) {
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  ctx.Assert(body.is_object(), "the answer must be a JSON object, got %s", r.Text().substr(0, 200));
  return body;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = readGet(c, "a-1", "t1");
  ctx.Equal(r.Status, 200, "GET /v1/assets/a-1 by its owner (%s)", r.Text().substr(0, 200));
  const auto body = bodyOf(ctx, r);
  nlohmann::json got = nlohmann::json::object();
  for (const std::string k : {"asset_id", "mime", "checksum", "caption", "degraded"}) got[k] = body.contains(k) ? body[k] : nlohmann::json();
  const nlohmann::json want = {{"asset_id", "a-1"}, {"mime", "image/png"}, {"checksum", kH1}, {"caption", "a red kettle on a stove"}, {"degraded", false}};
  ctx.Equal(got, want, "the answer's fields");
  const std::string url = body.value("url", "");
  ctx.Assert(url.rfind(objects::kBaseUrl + "/", 0) == 0, "the answer's url is %q, expected an object-store URL", url);
}

void CheckTenantScope(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto foreign = readGet(c, "a-2", "t1");
  ctx.Equal(foreign.Status, 404, "t1 reading t2's asset a-2 (another tenant's asset is 404, the answer for an id that does not exist)");
  ctx.Assert(foreign.Text().find("private") == std::string::npos, "the refusal leaked t2's caption");
  ctx.Equal(readGet(c, "a-404", "t1").Status, 404, "an unknown asset id");
  ctx.Equal(readGet(c, "a-1", "").Status, 401, "a request without X-Tenant-Id");
}

void CheckUrlExpiry(harness::Ctx& ctx) {
  auto c = api(ctx);
  const double now = static_cast<double>(ctx.Clock.Now()) / 1000;
  const auto body = bodyOf(ctx, readGet(c, "a-1", "t1"));
  const long long expires_at = body.value("expires_at", 0LL);
  ctx.Assert(expires_at >= now + 890 && expires_at <= now + 910, "the signed URL expires %.0f s from now: a read URL lives 15 minutes (900 s), so a leaked link dies quickly",
             static_cast<double>(expires_at) - now);
  const std::string url = body.value("url", "");
  ctx.Assert(url.find("expires=" + std::to_string(expires_at)) != std::string::npos, "the URL %s does not carry its expires_at", url);
  ctx.Clock.Advance(901);
  ctx.Assert(!objects::verify(url, "t1"), "fifteen minutes later the object store still serves the URL");
}

void CheckSignatureBinds(harness::Ctx& ctx) {
  auto c = api(ctx);
  const std::string url = bodyOf(ctx, readGet(c, "a-1", "t1")).value("url", "");
  ctx.Assert(objects::verify(url, "t1"), "the object store refuses %s for t1: sig must be objects::mac(checksum|tenant|expires_at)", url);
  std::string other = url;
  const size_t at = other.find("tenant=t1");
  if (at != std::string::npos) other.replace(at, 9, "tenant=t2");
  ctx.Assert(!objects::verify(other, "t2"), "a URL handed to t1, edited to name t2, is served to t2: the MAC must cover the tenant");
  std::smatch m;
  std::string later = url;
  if (std::regex_search(url, m, std::regex("expires=(\\\\d+)"))) later = m.prefix().str() + "expires=" + std::to_string(std::stoll(m[1].str()) + 86400) + m.suffix().str();
  ctx.Assert(!objects::verify(later, "t1"), "a URL whose expiry was pushed a day later is still served: the MAC must cover expires_at");
}

void CheckNoBytes(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = readGet(c, "a-1", "t1");
  ctx.Equal(r.Status, 200, "GET /v1/assets/a-1");
  ctx.Assert(r.Text().size() < 4096,
             "GET /v1/assets/a-1 answered %d bytes for a %d-byte image: the API carried the image itself. Answer metadata and the signed URL; the client fetches the bytes from the object store",
             r.Text().size(), image().size());
  for (const auto& [k, v] : bodyOf(ctx, r).items()) {
    ctx.Assert(!v.is_string() || v.get<std::string>().size() <= 1024, "the answer carries %s (%d characters): no image data in the API's answer", k,
               v.is_string() ? v.get<std::string>().size() : 0);
  }
}
`,
  },
  hints: [
    "Read t2's asset with t1's header: the caption and the image come back. Change `tenant=t1` in a URL to `tenant=t2`: the store serves it, and will for a week. A gallery of 40 images moves every byte through the API.",
    "The handler never compares the asset's tenant with the caller's, the MAC covers only the checksum and the expiry, the TTL is seven days, and `objects.read` copies the object into the response.",
    '401 without `X-Tenant-Id`; 404 when `asset["tenant"] != tenant`; `SIGNED_URL_TTL_S = 900`; `objects.mac(f"{checksum}|{tenant}|{expires_at}")`; drop `objects.read` and `content`.',
  ],
  debrief: `The 404 is the access check and the privacy check at once: answering a foreign id exactly like a missing one tells a caller nothing about which ids exist. The signature has to cover everything the URL grants, the object, the tenant and the deadline, because a MAC protects only what it hashes; any part left out can be edited for free. A short TTL bounds what a link leaked into a log or a screenshot is worth, and keeping the bytes off the API keeps the heavy path on storage built for it. Production object stores add the client's address range or a single-use nonce to the signed string, and serve through a CDN that checks signatures at the edge.`,
};
