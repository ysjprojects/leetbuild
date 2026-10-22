import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/assets/{id}: signed access with tenant scope',
  concept: 'http',
  file: 'read',
  focus: ['client', 'ingest', 'objects', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it looks the asset up, returns it
and the demo gallery renders. It hides a missing tenant check, a permanent URL and an API that proxies
the original bytes. Find them, fix them, and prove the fix.

Implement \`GET /v1/assets/{id}\` — the read side of ingest.

- The tenant comes from the authenticated \`X-Tenant-Id\` header (**401** when missing), and the asset
  must belong to it: a foreign or unknown asset id is **404**, exactly like an id that does not exist.
  Never 403 — a 403 confirms that the id is real.
- The response carries the asset metadata: \`asset_id\`, \`mime\`, \`checksum\`, the \`caption\` and its
  \`caption_offsets\`, and \`degraded\` when the caption never arrived.
- The response also carries a **signed URL** to the object store and its \`expires_at\`. The signature
  covers \`checksum | tenant | expires_at\`, so a URL handed to the wrong tenant or used after its
  expiry is rejected by the store.
- The signed URL expires in **15 minutes** (\`900\` seconds). A permanent URL is a read credential for
  the lifetime of the object; nothing in the API may hand one out.
- The API **never proxies the bytes**: when a signed URL will do, streaming the object through the
  service turns one read into two network hops, blocks a worker, and loses the tenant scope the
  signature carried.

**Failure mode the checks target.** The missing tenant check is an IDOR: any authenticated caller who
learns an asset id reads another tenant's image and caption. The permanent URL is the same problem with
a longer tail — it leaks through logs, screenshots and error reports and never stops working. The proxy
is the quiet one: it looks like a convenience, and it removes the only place where access is actually
enforced.`,
  sequence: {
    participants: ['Client', 'Ingest API', 'assets DB', 'Object store'],
    messages: [
      {from: 'Client', to: 'Ingest API', label: 'GET /v1/assets/asset_9f2c · X-Tenant-Id', kind: 'sync'},
      {from: 'Ingest API', to: 'assets DB', label: 'get(tenant, asset_id)', kind: 'sync'},
      {from: 'assets DB', to: 'Ingest API', label: 'asset / none → 404', kind: 'reply'},
      {from: 'Ingest API', to: 'Ingest API', label: 'hmac(checksum | tenant | expires_at)', kind: 'sync'},
      {from: 'Ingest API', to: 'Client', label: '200 {caption, offsets, signed_url, expires_at}', kind: 'reply'},
      {from: 'Client', to: 'Object store', label: 'GET signed url (15 min, tenant-scoped)', kind: 'sync'},
    ],
  },
  hints: [
    'Look the asset up under the authenticated tenant — `store.get(tenant, asset_id)` — and map "not mine" and "does not exist" to the same 404. A separate 403 tells an attacker which ids are real.',
    'Sign the tuple the store will re-derive: `checksum | tenant | expires_at`. If the tenant is not in the message, a URL minted for one tenant works for another; if the expiry is not, it never stops working.',
    'Fifteen minutes is the whole point of the signed URL: short enough that a leaked link is stale before it is useful, long enough for a browser to load the image. Return it in the body and let the client fetch the bytes directly — never relay them through the API.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/assets/{id}',
      detail: 'Register the read route on `GET /v1/assets/{id}` with the asset id as a path parameter.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/assets\/\{asset_id\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/assets\/:assetId['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/assets\/\{assetID\}"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"assets"\s*\/\s*Segment\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(.*\/v1\/assets\//]},
      },
    },
    {
      id: 'tenant-scope',
      title: 'Scopes the read to the authenticated tenant',
      detail:
        'The handler reads `X-Tenant-Id`, looks the asset up under it, and answers **404** when it is unknown *or* foreign. The draft serves any asset id to any caller.',
      match: {
        python: {all: [/X-Tenant-Id/, /status_code\s*=\s*404/]},
        typescript: {all: [/x-tenant-id/, /code\(\s*404\s*\)/]},
        go: {all: [/X-Tenant-Id/, /StatusNotFound/]},
        scala: {all: [/X-Tenant-Id/, /StatusCodes\.NotFound/]},
        cpp: {all: [/X-Tenant-Id/, /\b404\b/]},
      },
    },
    {
      id: 'signed-url',
      title: 'Returns a signed URL that expires in 15 minutes',
      detail:
        'The response carries `signed_url` and `expires_at`, built from `SIGNED_URL_TTL_S = 900` (`signedUrlTtl`, `SignedUrlTtl`, `kSignedUrlTtlSeconds`) and a `signature`. The draft returns a permanent URL.',
      match: {
        python: {all: [/SIGNED_URL_TTL_S\s*=\s*900/, /expires_at/, /signature/]},
        typescript: {all: [/SIGNED_URL_TTL_S\s*=\s*900/, /expiresAt/, /signature/]},
        go: {all: [/signedUrlTtl\s*=\s*900/, /expires_at/, /signature/]},
        scala: {all: [/SignedUrlTtl\s*=\s*900/, /expiresAt/, /signature/]},
        cpp: {all: [/kSignedUrlTtlSeconds\s*=\s*900/, /expires_at/, /signature/]},
      },
    },
    {
      id: 'no-bytes',
      title: 'Never proxies the original bytes',
      detail:
        'The handler answers with `signed_url` and lets the client fetch from object storage; it does not stream or copy the object through the API. The draft pipes the bytes through the service, hiding where access is enforced.',
      match: {
        python: {all: [/signed_url/], none: [/FileResponse|StreamingResponse/]},
        typescript: {all: [/signed_url/], none: [/createReadStream/]},
        go: {all: [/signed_url/], none: [/http\.ServeFile|io\.Copy/]},
        scala: {all: [/signed_url/], none: [/FromFile/]},
        cpp: {all: [/signed_url/], none: [/set_content\(raw_bytes/]},
      },
    },
    {
      id: 'signature',
      title: 'Signs the checksum, tenant and expiry together',
      detail:
        'The signature is an HMAC over `checksum | tenant | expires_at`, so it cannot be replayed after expiry and cannot be moved between tenants. A signature over the path alone expires never and scopes nothing.',
      match: {
        python: {all: [/hmac\.new/, /expires_at/]},
        typescript: {all: [/createHmac/, /expiresAt/]},
        go: {all: [/hmac\.New/, /ExpiresAt/]},
        scala: {all: [/HmacSHA256/, /expiresAt/]},
        cpp: {all: [/HMAC/, /expires_at/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""read.py — GET /v1/assets/{asset_id}. A model-generated draft."""

from fastapi import FastAPI
from fastapi.responses import FileResponse

app = FastAPI()


@app.get("/v1/assets/{asset_id}")
def read_asset(asset_id: str) -> FileResponse:
    # TODO: this draft serves any asset id to any caller, hands out a permanent URL and streams the
    # original bytes through the API instead of a signed URL that expires.
    asset = store.get_by_id(asset_id)
    return FileResponse("/objects/" + asset["object_key"])
`,
      solution: `"""read.py — GET /v1/assets/{asset_id}: tenant-scoped metadata with a short-lived signed URL."""

import hashlib
import hmac
import time

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()

SIGNED_URL_TTL_S = 900
OBJECT_BASE = "objects.internal/ingest"
OBJECT_SECRET = b"rotate-me-in-kms"


def sign(content_hash: str, tenant: str, expires_at: int) -> str:
    """The signature the object store re-derives: it binds the bytes, the tenant and the expiry."""
    message = f"{content_hash}|{tenant}|{expires_at}".encode("utf-8")
    return hmac.new(OBJECT_SECRET, message, hashlib.sha256).hexdigest()


def signed_url_for(asset: dict, tenant: str) -> tuple[str, int]:
    expires_at = int(time.time()) + SIGNED_URL_TTL_S
    signature = sign(asset["checksum"], tenant, expires_at)
    url = f"{OBJECT_BASE}/{tenant}/{asset['asset_id']}?expires={expires_at}&signature={signature}"
    return url, expires_at


@app.get("/v1/assets/{asset_id}")
def read_asset(asset_id: str, tenant: str | None = Header(default=None, alias="X-Tenant-Id")) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    asset = store.get(tenant, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="asset not found")
    url, expires_at = signed_url_for(asset, tenant)
    return JSONResponse(
        {
            "asset_id": asset_id,
            "mime": asset["mime"],
            "checksum": asset["checksum"],
            "caption": asset["caption"],
            "caption_offsets": asset["caption_offsets"],
            "degraded": asset["degraded"],
            "signed_url": url,
            "expires_at": expires_at,
        }
    )
`,
    },
    typescript: {
      starter: `/** GET /v1/assets/:assetId. A model-generated draft. */
import {createReadStream} from 'node:fs';

import Fastify from 'fastify';

import {store} from './asset_store';

export const app = Fastify();

app.get('/v1/assets/:assetId', async (request, reply) => {
  // TODO: this draft serves any asset id to any caller, hands out a permanent URL and streams the
  // original bytes through the API instead of a signed URL that expires.
  const {assetId} = request.params as {assetId: string};
  const asset = await store.getById(assetId);
  return reply.code(200).header('Content-Type', asset.mime).send(createReadStream(asset.object_path));
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/assets/:assetId — tenant-scoped metadata with a short-lived signed URL. */
import {createHmac} from 'node:crypto';

import Fastify from 'fastify';

import {store} from './asset_store';

export const app = Fastify();

const SIGNED_URL_TTL_S = 900;
const OBJECT_BASE = 'objects.internal/ingest';
const OBJECT_SECRET = 'rotate-me-in-kms';

export function sign(contentHash: string, tenant: string, expiresAt: number): string {
  // Binds the bytes, the tenant and the expiry: the store re-derives exactly this string.
  return createHmac('sha256', OBJECT_SECRET).update(contentHash + '|' + tenant + '|' + String(expiresAt)).digest('hex');
}

app.get('/v1/assets/:assetId', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {assetId} = request.params as {assetId: string};
  const asset = await store.get(tenant, assetId);
  if (asset === null) return reply.code(404).send({error: 'asset not found'});
  const expiresAt = Math.floor(Date.now() / 1000) + SIGNED_URL_TTL_S;
  const signature = sign(asset.checksum, tenant, expiresAt);
  const signedUrl = \`\${OBJECT_BASE}/\${tenant}/\${assetId}?expires=\${expiresAt}&signature=\${signature}\`;
  return reply.code(200).send({
    asset_id: assetId,
    mime: asset.mime,
    checksum: asset.checksum,
    caption: asset.caption,
    caption_offsets: asset.caption_offsets,
    degraded: asset.degraded,
    signed_url: signedUrl,
    expires_at: expiresAt,
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"net/http"
)

func readAsset(rw http.ResponseWriter, r *http.Request) {
	// TODO: this draft serves any asset id to any caller, hands out a permanent URL and streams the
	// original bytes through the API instead of a signed URL that expires.
	asset, err := store.GetByID(r.Context(), r.PathValue("assetID"))
	if err != nil || asset == nil {
		rw.WriteHeader(http.StatusInternalServerError)
		return
	}
	http.ServeFile(rw, r, "/objects/"+asset.ObjectKey)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/assets/{assetID}", readAsset)
	http.ListenAndServe(":8443", mux)
}
`,
      solution: `package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"time"
)

const (
	signedUrlTtl = 900
	objectBase   = "objects.internal/ingest"
)

var objectSecret = []byte("rotate-me-in-kms")

type Asset struct {
	AssetID        string   \`json:"asset_id"\`
	Mime           string   \`json:"mime"\`
	Checksum       string   \`json:"checksum"\`
	Caption        string   \`json:"caption"\`
	CaptionOffsets []int    \`json:"caption_offsets"\`
	Degraded       bool     \`json:"degraded"\`
}

type AssetRead struct {
	AssetID        string \`json:"asset_id"\`
	Mime           string \`json:"mime"\`
	Checksum       string \`json:"checksum"\`
	Caption        string \`json:"caption"\`
	CaptionOffsets []int  \`json:"caption_offsets"\`
	Degraded       bool   \`json:"degraded"\`
	SignedURL      string \`json:"signed_url"\`
	ExpiresAt      int64  \`json:"expires_at"\`
}

// The signature the object store re-derives: it binds the bytes, the tenant and the expiry.
func sign(contentHash, tenant string, expiresAt int64) string {
	mac := hmac.New(sha256.New, objectSecret)
	fmt.Fprintf(mac, "%s|%s|%d", contentHash, tenant, expiresAt)
	return hex.EncodeToString(mac.Sum(nil))
}

func readAsset(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	assetID := r.PathValue("assetID")
	asset, err := store.Get(r.Context(), tenant, assetID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if asset == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "asset not found"})
		return
	}
	expiresAt := time.Now().Unix() + signedUrlTtl
	signedURL := fmt.Sprintf("%s/%s/%s?expires=%d&signature=%s", objectBase, tenant, assetID, expiresAt,
		sign(asset.Checksum, tenant, expiresAt))
	writeJSON(rw, http.StatusOK, AssetRead{
		AssetID:        assetID,
		Mime:           asset.Mime,
		Checksum:       asset.Checksum,
		Caption:        asset.Caption,
		CaptionOffsets: asset.CaptionOffsets,
		Degraded:       asset.Degraded,
		SignedURL:      signedURL,
		ExpiresAt:      expiresAt,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/assets/{assetID}", readAsset)
	http.ListenAndServe(":8443", mux)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

object ReadApi {
  implicit val system: ActorSystem = ActorSystem("multimodal-ingest")

  val route: Route =
    path("v1" / "assets" / Segment) { assetId =>
      get {
        // TODO: this draft serves any asset id to any caller, hands out a permanent URL and streams
        // the original bytes through the API instead of a signed URL that expires.
        getFromFile(s"/objects/$assetId.png")
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

import java.nio.charset.StandardCharsets
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

object ReadApi {
  implicit val system: ActorSystem = ActorSystem("multimodal-ingest")

  val SignedUrlTtl = 900
  val ObjectBase = "objects.internal/ingest"
  val ObjectSecret = "rotate-me-in-kms"

  // The signature the object store re-derives: it binds the bytes, the tenant and the expiry.
  def sign(contentHash: String, tenant: String, expiresAt: Long): String = {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(new SecretKeySpec(ObjectSecret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"))
    val message = s"$contentHash|$tenant|$expiresAt"
    mac.doFinal(message.getBytes(StandardCharsets.UTF_8)).map(b => f"$b%02x").mkString
  }

  val route: Route =
    path("v1" / "assets" / Segment) { assetId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          if (!tenantOpt.exists(_.nonEmpty)) {
            complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
          } else {
            val tenant = tenantOpt.get
            store.get(tenant, assetId) match {
              case None =>
                complete(StatusCodes.NotFound, """{"error":"asset not found"}""")
              case Some(asset) =>
                val expiresAt = System.currentTimeMillis() / 1000 + SignedUrlTtl
                val signature = sign(asset.checksum, tenant, expiresAt)
                val signedUrl = s"$ObjectBase/$tenant/$assetId?expires=$expiresAt&signature=$signature"
                val body =
                  s"""{"asset_id":"$assetId","checksum":"\${asset.checksum}","caption":"\${asset.caption}","signed_url":"$signedUrl","expires_at":$expiresAt}"""
                complete(StatusCodes.OK, body)
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

#include <string>

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/assets/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft serves any asset id to any caller, hands out a permanent URL and streams the
    // original bytes through the API instead of a signed URL that expires.
    const std::string assetId = req.matches[1];
    res.status = 200;
    res.set_header("Location", "https://objects.internal/" + assetId + ".png");
    res.set_content(raw_bytes(assetId), "image/png");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <openssl/hmac.h>

#include <chrono>
#include <iomanip>
#include <sstream>
#include <string>

using json = nlohmann::json;

constexpr long long kSignedUrlTtlSeconds = 900;
const std::string kObjectBase = "objects.internal/ingest";
const std::string kObjectSecret = "rotate-me-in-kms";

// The signature the object store re-derives: it binds the bytes, the tenant and the expiry.
std::string sign(const std::string& contentHash, const std::string& tenant, long long expiresAt) {
  const std::string message = contentHash + "|" + tenant + "|" + std::to_string(expiresAt);
  unsigned char digest[EVP_MAX_MD_SIZE];
  unsigned int length = 0;
  HMAC(EVP_sha256(), kObjectSecret.data(), static_cast<int>(kObjectSecret.size()),
       reinterpret_cast<const unsigned char*>(message.data()), message.size(), digest, &length);
  std::ostringstream hex;
  for (unsigned int i = 0; i < length; ++i)
    hex << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(digest[i]);
  return hex.str();
}

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/assets/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const std::string assetId = req.matches[1];
    const auto asset = store.get(tenant, assetId);
    if (!asset) {
      res.status = 404;
      res.set_content(R"({"error":"asset not found"})", "application/json");
      return;
    }
    const auto now = std::chrono::system_clock::now().time_since_epoch();
    const long long expiresAt = std::chrono::duration_cast<std::chrono::seconds>(now).count() + kSignedUrlTtlSeconds;
    const std::string checksum = asset->at("checksum").get<std::string>();
    const std::string signature = sign(checksum, tenant, expiresAt);
    const std::string signedUrl =
        kObjectBase + "/" + tenant + "/" + assetId + "?expires=" + std::to_string(expiresAt) + "&signature=" + signature;
    res.status = 200;
    res.set_content(json{{"asset_id", assetId}, {"checksum", checksum}, {"signed_url", signedUrl}, {"expires_at", expiresAt}}.dump(),
                    "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The interviewer is testing whether you know where access is enforced. The draft enforces it nowhere: any
authenticated caller with an id reads any tenant's asset, and because the response is a permanent URL,
the leak outlives the request. Both bugs are the same bug — the read path treats possession of an id as
authorization — and the fix is to scope the lookup by tenant and to mint a credential that is bound to
the tenant and to a clock.

Proxying the bytes is the third bug and the one that is easiest to defend by accident ("the client
should not need to know the bucket"). What the proxy actually does is move the authorization decision
into a service that has no reason to make it, double the egress, and take a worker out of the pool for
the duration of a slow download. Real systems sign with a per-tenant key, shorten the TTL for
thumbnails and lengthen it for large downloads, log every signature with the tenant so a leak has an
owner, and rotate the signing key on a schedule that the object store accepts both of.`,
};
