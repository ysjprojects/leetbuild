import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/assets: metadata first, bytes later',
  concept: 'http',
  file: 'api',
  focus: ['client', 'ingest', 'db', 'objects'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers an asset, returns
a pending record and serves the demo. It compiles, and it hides three production flaws. Review it
like the service owner, fix it, and prove the fix with the checks below.

Implement \`POST /v1/assets\` — the registration half of ingest. The bytes never travel through this
endpoint: it registers metadata under a content hash, and the client then uploads with a signed PUT.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- Body: \`{"mime": "image/png", "byte_size": 812345, "caption": "a red bicycle"}\`.
- \`mime\` is checked against the allowlist \`image/png\`, \`image/jpeg\`, \`image/webp\`,
  \`image/gif\`, \`image/avif\`; anything else is **415**. The client's declaration is not evidence.
- \`byte_size\` must be at least 1 and at most **20 MiB** (\`20 << 20\`); a larger size is **413**.
- \`caption\` is optional and capped at **4 KiB** (\`4 << 10\`) of UTF-8 — the vision model's input
  budget — and a longer one is **413**.
- \`Idempotency-Key\` is required and must be the content hash of the bytes as \`sha256:<64 hex>\`
  (**400** otherwise). It keys the registration: re-registering the same content hash for the same
  tenant returns the **original** \`asset_id\` with **200** instead of creating a second asset.
- The stored record carries \`asset_id\`, \`checksum\`, \`mime\`, \`byte_size\`, \`caption\` and
  \`state: "pending"\`, and that record is the response body.

**Failure mode the checks target.** Trusting the client's \`mime\` puts an SVG or a polyglot file in
front of the indexer; an uncapped caption turns one request into an unbounded vision bill; and a
registration that ignores the content hash duplicates the asset *and its embeddings* on every retry,
so search returns the same image twice with two different scores. The draft also writes
\`store.put(tenant, body.mime, …)\` — keyed by a value the caller controls, which is how one tenant's
re-upload can collide with another's.`,
  sequence: {
    participants: ['Client', 'Ingest API', 'assets DB', 'Object store'],
    messages: [
      {
        from: 'Client',
        to: 'Ingest API',
        label: 'POST /v1/assets · X-Tenant-Id · Idempotency-Key: sha256:…',
        kind: 'sync',
      },
      {from: 'Ingest API', to: 'Ingest API', label: 'mime allowlist · 20 MiB · 4 KiB caption', kind: 'sync'},
      {from: 'Ingest API', to: 'assets DB', label: 'get(tenant, content_hash)', kind: 'sync'},
      {from: 'assets DB', to: 'Ingest API', label: 'existing asset / none', kind: 'reply'},
      {from: 'Ingest API', to: 'assets DB', label: 'put(asset, state=pending)', kind: 'sync'},
      {from: 'Ingest API', to: 'Object store', label: 'presign PUT (bytes never pass through)', kind: 'async'},
      {from: 'Ingest API', to: 'Client', label: '200 original asset_id / 201 new asset · 415 · 413', kind: 'reply'},
    ],
  },
  hints: [
    'Order the guard clauses by cost: tenant, Idempotency-Key shape, mime allowlist, byte cap, caption cap. Each one returns before the store is touched, so a malformed request can never register anything.',
    'The content hash is the identity of the bytes, not of the request. Look the hash up under `(tenant, hash)` before you mint an id; a hit returns the stored record with 200, so a retry answers without writing a second asset or a second set of embeddings.',
    'A caption is a vision-model input, so it gets a byte budget like a prompt does: measure it in UTF-8 bytes, not characters, or a 4 KiB cap becomes 16 KiB of emoji.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/assets',
      detail: 'Register the registration route on `POST /v1/assets`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/assets["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/assets['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/assets"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"assets"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/assets"/]},
      },
    },
    {
      id: 'mime',
      title: 'Rejects a mime type outside the allowlist with 415',
      detail:
        'The mime type is matched against an allowlist and anything else is **415 Unsupported Media Type**. The draft stores whatever the client declared, so the indexer receives formats it cannot embed.',
      match: {
        python: {all: [/ALLOWED_MIME_TYPES/, /status_code\s*=\s*415/]},
        typescript: {all: [/ALLOWED_MIME_TYPES/, /code\(\s*415\s*\)/]},
        go: {all: [/allowedMimeTypes/, /StatusUnsupportedMediaType/]},
        scala: {all: [/AllowedMimeTypes/, /StatusCodes\.UnsupportedMediaType/]},
        cpp: {all: [/kAllowedMimeTypes/, /\b415\b/]},
      },
    },
    {
      id: 'caps',
      title: 'Caps the bytes at 20 MiB and the caption at 4 KiB with 413',
      detail:
        '`byte_size` is bounded by `20 << 20` and the UTF-8 caption by `4 << 10`, and both refusals are **413**. The draft accepts any size and any caption length.',
      match: {
        python: {all: [/MAX_ASSET_BYTES/, /MAX_CAPTION_BYTES/, /20 << 20/, /4 << 10/, /status_code\s*=\s*413/]},
        typescript: {all: [/MAX_ASSET_BYTES/, /MAX_CAPTION_BYTES/, /20 << 20/, /4 << 10/, /code\(\s*413\s*\)/]},
        go: {all: [/maxAssetBytes/, /maxCaptionBytes/, /20 << 20/, /4 << 10/, /StatusRequestEntityTooLarge/]},
        scala: {all: [/MaxAssetBytes/, /MaxCaptionBytes/, /20 << 20/, /4 << 10/, /StatusCodes\.RequestEntityTooLarge/]},
        cpp: {all: [/kMaxAssetBytes/, /kMaxCaptionBytes/, /20 << 20/, /4 << 10/, /\b413\b/]},
      },
    },
    {
      id: 'content-hash',
      title: 'Keys the registration by the content hash',
      detail:
        '`Idempotency-Key` is required and carries the `sha256:<64 hex>` content hash; the record is stored and looked up under `(tenant, hash)`, so a re-registration returns the original asset id. The draft hashes nothing and stores under the mime type.',
      match: {
        python: {all: [/sha256/, /Idempotency-Key/, /store\.get\(/, /store\.put\(/]},
        typescript: {all: [/sha256/, /idempotency-key/, /store\.get\(/, /store\.put\(/]},
        go: {all: [/sha256/, /Idempotency-Key/, /store\.Get\(/, /store\.Put\(/]},
        scala: {all: [/sha256/, /Idempotency-Key/, /store\.get\(/, /store\.put\(/]},
        cpp: {all: [/sha256/, /Idempotency-Key/, /store\.get\(/, /store\.put\(/]},
      },
    },
    {
      id: 'metadata',
      title: 'Returns the pending asset record, never the bytes',
      detail:
        'The response is the stored record — `asset_id` and `checksum` included — with `state: "pending"`; the endpoint registers metadata and lets the client PUT the bytes to object storage, so no byte payload enters or leaves the API.',
      match: {
        python: {all: [/asset_id/, /checksum/, /"pending"/]},
        typescript: {all: [/asset_id/, /checksum/, /'pending'/]},
        go: {all: [/asset_id/, /checksum/, /"pending"/]},
        scala: {all: [/asset_id/, /checksum/, /"pending"/]},
        cpp: {all: [/asset_id/, /checksum/, /"pending"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""POST /v1/assets: registers asset metadata. A model-generated draft."""

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()


class AssetRequest(BaseModel):
    mime: str
    byte_size: int
    caption: str | None = None


class AssetStore:
    def get(self, tenant: str, content_hash: str) -> dict | None:
        """The asset registered for (tenant, content_hash), if any."""
        raise NotImplementedError

    def put(self, tenant: str, content_hash: str, asset: dict) -> None:
        """Store the asset under (tenant, content_hash)."""
        raise NotImplementedError


store = AssetStore()


@app.post("/v1/assets")
def create_asset(body: AssetRequest, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this draft trusts the client-declared mime, accepts a caption of any length, and keys
    # the registration by the mime type instead of the content hash, so re-uploading the same bytes
    # registers a second asset and a second set of embeddings.
    store.put(tenant, body.mime, {"mime": body.mime, "byte_size": body.byte_size, "caption": body.caption})
    return JSONResponse(
        {"state": "pending", "mime": body.mime, "byte_size": body.byte_size},
        status_code=201,
    )
`,
      solution: `"""POST /v1/assets: register asset metadata under the content hash, before the bytes arrive."""

import re

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()

MAX_ASSET_BYTES = 20 << 20
MAX_CAPTION_BYTES = 4 << 10
ALLOWED_MIME_TYPES = {"image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"}
CONTENT_HASH_RE = re.compile(r"^sha256:[0-9a-f]{64}$")


class AssetRequest(BaseModel):
    mime: str
    byte_size: int
    caption: str | None = None


class AssetStore:
    def get(self, tenant: str, content_hash: str) -> dict | None:
        """The asset registered for (tenant, content_hash), if any."""
        raise NotImplementedError

    def put(self, tenant: str, content_hash: str, asset: dict) -> None:
        """Store the asset under (tenant, content_hash)."""
        raise NotImplementedError


store = AssetStore()


def asset_id_for(content_hash: str) -> str:
    return f"asset_{content_hash[7:19]}"


@app.post("/v1/assets")
def create_asset(
    body: AssetRequest,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    idem_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if idem_key is None or CONTENT_HASH_RE.match(idem_key) is None:
        raise HTTPException(status_code=400, detail="Idempotency-Key must be sha256:<64 hex>")
    if body.mime not in ALLOWED_MIME_TYPES:
        raise HTTPException(status_code=415, detail="unsupported mime type")
    if body.byte_size < 1 or body.byte_size > MAX_ASSET_BYTES:
        raise HTTPException(status_code=413, detail="asset larger than 20 MiB")
    caption = body.caption or ""
    if len(caption.encode("utf-8")) > MAX_CAPTION_BYTES:
        raise HTTPException(status_code=413, detail="caption larger than 4 KiB")

    content_hash = idem_key
    existing = store.get(tenant, content_hash)
    if existing is not None:
        return JSONResponse(existing, status_code=200)

    asset = {
        "asset_id": asset_id_for(content_hash),
        "checksum": content_hash,
        "mime": body.mime,
        "byte_size": body.byte_size,
        "caption": caption or None,
        "state": "pending",
    }
    store.put(tenant, content_hash, asset)
    return JSONResponse(asset, status_code=201)
`,
    },
    typescript: {
      starter: `/** POST /v1/assets: registers asset metadata. A model-generated draft. */
import Fastify from 'fastify';

import {store} from './asset_store';

export const app = Fastify();

interface AssetBody {
  mime: string;
  byte_size: number;
  caption?: string;
}

app.post('/v1/assets', async (request, reply) => {
  // TODO: this draft trusts the client-declared mime, accepts a caption of any length, and keys
  // the registration by the mime type instead of the content hash, so re-uploading the same bytes
  // registers a second asset and a second set of embeddings.
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as AssetBody;
  await store.put(tenant, body.mime, {mime: body.mime, byte_size: body.byte_size, caption: body.caption ?? null});
  return reply
    .code(201)
    .send({state: 'pending', mime: body.mime, byte_size: body.byte_size});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/assets: register asset metadata under the content hash, before the bytes arrive. */
import Fastify from 'fastify';

import {store} from './asset_store';

export const app = Fastify();

const MAX_ASSET_BYTES = 20 << 20;
const MAX_CAPTION_BYTES = 4 << 10;
const ALLOWED_MIME_TYPES: Record<string, true> = {
  'image/png': true,
  'image/jpeg': true,
  'image/webp': true,
  'image/gif': true,
  'image/avif': true,
};
const CONTENT_HASH_RE = /^sha256:[0-9a-f]{64}$/;

interface AssetBody {
  mime: string;
  byte_size: number;
  caption?: string;
}

interface Asset {
  asset_id: string;
  checksum: string;
  mime: string;
  byte_size: number;
  caption: string | null;
  state: string;
}

app.post('/v1/assets', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || !CONTENT_HASH_RE.test(idemKey))
    return reply.code(400).send({error: 'Idempotency-Key must be sha256:<64 hex>'});

  const body = request.body as Partial<AssetBody> | null;
  if (body === null || typeof body !== 'object' || typeof body.mime !== 'string')
    return reply.code(400).send({error: 'mime must be a string'});
  if (ALLOWED_MIME_TYPES[body.mime] !== true) return reply.code(415).send({error: 'unsupported mime type'});
  const byteSize = body.byte_size;
  if (typeof byteSize !== 'number' || !Number.isInteger(byteSize) || byteSize < 1 || byteSize > MAX_ASSET_BYTES)
    return reply.code(413).send({error: 'asset larger than 20 MiB'});
  const caption = body.caption ?? '';
  if (typeof caption !== 'string' || Buffer.byteLength(caption, 'utf8') > MAX_CAPTION_BYTES)
    return reply.code(413).send({error: 'caption larger than 4 KiB'});

  const contentHash = idemKey;
  const existing: Asset | null = await store.get(tenant, contentHash);
  if (existing !== null) return reply.code(200).send(existing);

  const asset: Asset = {
    asset_id: 'asset_' + contentHash.slice(7, 19),
    checksum: contentHash,
    mime: body.mime,
    byte_size: byteSize,
    caption: caption === '' ? null : caption,
    state: 'pending',
  };
  await store.put(tenant, contentHash, asset);
  return reply.code(201).send(asset);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
)

type AssetRequest struct {
	Mime     string \`json:"mime"\`
	ByteSize int64  \`json:"byte_size"\`
	Caption  string \`json:"caption"\`
}

type Asset struct {
	Mime     string \`json:"mime"\`
	ByteSize int64  \`json:"byte_size"\`
	Caption  string \`json:"caption"\`
}

type AssetStore struct{}

func (s *AssetStore) Get(ctx context.Context, tenant, contentHash string) (*Asset, error) {
	return nil, nil
}

func (s *AssetStore) Put(ctx context.Context, tenant, contentHash string, asset Asset) error {
	return nil
}

var store = &AssetStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func createAsset(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	var body AssetRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft trusts the client-declared mime, accepts a caption of any length, and keys
	// the registration by the mime type instead of the content hash, so re-uploading the same bytes
	// registers a second asset and a second set of embeddings.
	asset := Asset{Mime: body.Mime, ByteSize: body.ByteSize, Caption: body.Caption}
	if err := store.Put(r.Context(), tenant, body.Mime, asset); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	writeJSON(rw, http.StatusCreated, map[string]any{"state": "pending", "mime": body.Mime})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/assets", createAsset)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"regexp"
	"unicode/utf8"
)

const (
	maxAssetBytes   = 20 << 20
	maxCaptionBytes = 4 << 10
)

var (
	allowedMimeTypes = map[string]bool{
		"image/png":  true,
		"image/jpeg": true,
		"image/webp": true,
		"image/gif":  true,
		"image/avif": true,
	}
	contentHashRE = regexp.MustCompile(\`^sha256:[0-9a-f]{64}$\`)
)

type AssetRequest struct {
	Mime     string \`json:"mime"\`
	ByteSize int64  \`json:"byte_size"\`
	Caption  string \`json:"caption"\`
}

type Asset struct {
	AssetID  string \`json:"asset_id"\`
	Checksum string \`json:"checksum"\`
	Mime     string \`json:"mime"\`
	ByteSize int64  \`json:"byte_size"\`
	Caption  string \`json:"caption"\`
	State    string \`json:"state"\`
}

type AssetStore struct{}

func (s *AssetStore) Get(ctx context.Context, tenant, contentHash string) (*Asset, error) {
	return nil, nil
}

func (s *AssetStore) Put(ctx context.Context, tenant, contentHash string, asset Asset) error {
	return nil
}

var store = &AssetStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func createAsset(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	idemKey := r.Header.Get("Idempotency-Key")
	if !contentHashRE.MatchString(idemKey) {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "Idempotency-Key must be sha256:<64 hex>"})
		return
	}
	var body AssetRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if !allowedMimeTypes[body.Mime] {
		writeJSON(rw, http.StatusUnsupportedMediaType, map[string]string{"error": "unsupported mime type"})
		return
	}
	if body.ByteSize < 1 || body.ByteSize > maxAssetBytes {
		writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]string{"error": "asset larger than 20 MiB"})
		return
	}
	if utf8.RuneCountInString(body.Caption) > 0 && len([]byte(body.Caption)) > maxCaptionBytes {
		writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]string{"error": "caption larger than 4 KiB"})
		return
	}
	contentHash := idemKey
	existing, err := store.Get(r.Context(), tenant, contentHash)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if existing != nil {
		writeJSON(rw, http.StatusOK, existing)
		return
	}
	asset := Asset{
		AssetID:  "asset_" + contentHash[7:19],
		Checksum: contentHash,
		Mime:     body.Mime,
		ByteSize: body.ByteSize,
		Caption:  body.Caption,
		State:    "pending",
	}
	if err := store.Put(r.Context(), tenant, contentHash, asset); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	writeJSON(rw, http.StatusCreated, asset)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/assets", createAsset)
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
import spray.json.RootJsonFormat

final case class AssetRequest(mime: String, byte_size: Long, caption: Option[String])

object AssetApi {
  implicit val system: ActorSystem = ActorSystem("multimodal-ingest")
  implicit val requestFormat: RootJsonFormat[AssetRequest] = jsonFormat3(AssetRequest)

  val store = AssetStore.open()

  val route: Route =
    path("v1" / "assets") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[AssetRequest]) { body =>
            // TODO: this draft trusts the client-declared mime, accepts a caption of any length,
            // and keys the registration by the mime type instead of the content hash, so a
            // re-upload registers a second asset and a second set of embeddings.
            store.put(tenant, body.mime, body)
            complete(StatusCodes.Created, s"""{"state":"pending","mime":"\${body.mime}"}""")
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.nio.charset.StandardCharsets

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class AssetRequest(mime: String, byte_size: Long, caption: Option[String])
final case class Asset(asset_id: String, checksum: String, mime: String, byte_size: Long, caption: Option[String], state: String)

object AssetApi {
  implicit val system: ActorSystem = ActorSystem("multimodal-ingest")
  implicit val requestFormat: RootJsonFormat[AssetRequest] = jsonFormat3(AssetRequest)

  val MaxAssetBytes = 20 << 20
  val MaxCaptionBytes = 4 << 10
  val AllowedMimeTypes = Set("image/png", "image/jpeg", "image/webp", "image/gif", "image/avif")
  val ContentHashPattern = "^sha256:[0-9a-f]{64}$".r

  val store = AssetStore.open()

  val route: Route =
    path("v1" / "assets") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          optionalHeaderValueByName("Idempotency-Key") { idemOpt =>
            entity(as[AssetRequest]) { body =>
              if (!tenantOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
              } else if (!idemOpt.exists(ContentHashPattern.matches)) {
                complete(StatusCodes.BadRequest, """{"error":"Idempotency-Key must be sha256:<64 hex>"}""")
              } else if (!AllowedMimeTypes.contains(body.mime)) {
                complete(StatusCodes.UnsupportedMediaType, """{"error":"unsupported mime type"}""")
              } else if (body.byte_size < 1 || body.byte_size > MaxAssetBytes) {
                complete(StatusCodes.RequestEntityTooLarge, """{"error":"asset larger than 20 MiB"}""")
              } else if (body.caption.exists(_.getBytes(StandardCharsets.UTF_8).length > MaxCaptionBytes)) {
                complete(StatusCodes.RequestEntityTooLarge, """{"error":"caption larger than 4 KiB"}""")
              } else {
                val tenant = tenantOpt.get
                val contentHash = idemOpt.get
                store.get(tenant, contentHash) match {
                  case Some(existing) =>
                    complete(StatusCodes.OK, existing)
                  case None =>
                    val asset = Asset(
                      "asset_" + contentHash.slice(7, 19),
                      contentHash,
                      body.mime,
                      body.byte_size,
                      body.caption.filter(_.nonEmpty),
                      "pending"
                    )
                    store.put(tenant, contentHash, asset)
                    complete(StatusCodes.Created, asset)
                }
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

#include <optional>
#include <string>

using json = nlohmann::json;

struct AssetStore {
  std::optional<json> get(const std::string& tenant, const std::string& contentHash);
  void put(const std::string& tenant, const std::string& contentHash, const json& asset);
};

AssetStore store;

int main() {
  httplib::Server svr;

  svr.Post("/v1/assets", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this draft trusts the client-declared mime, accepts a caption of any length, and keys
    // the registration by the mime type instead of the content hash, so re-uploading the same
    // bytes registers a second asset and a second set of embeddings.
    const auto mime = body.value("mime", std::string());
    store.put(tenant, mime, body);
    res.status = 201;
    res.set_content(json{{"state", "pending"}, {"mime", mime}, {"byte_size", body.value("byte_size", 0)}}.dump(),
                    "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <optional>
#include <set>
#include <string>

using json = nlohmann::json;

constexpr std::size_t kMaxAssetBytes = 20 << 20;
constexpr std::size_t kMaxCaptionBytes = 4 << 10;
const std::set<std::string> kAllowedMimeTypes = {"image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"};

struct AssetStore {
  std::optional<json> get(const std::string& tenant, const std::string& contentHash);
  void put(const std::string& tenant, const std::string& contentHash, const json& asset);
};

AssetStore store;

// sha256:<64 lowercase hex> — the content hash the client computed over the bytes.
bool isContentHash(const std::string& value) {
  if (value.size() != 7 + 64 || value.compare(0, 7, "sha256:") != 0) return false;
  for (std::size_t i = 7; i < value.size(); ++i)
    if (!((value[i] >= '0' && value[i] <= '9') || (value[i] >= 'a' && value[i] <= 'f'))) return false;
  return true;
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/assets", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto idemKey = req.get_header_value("Idempotency-Key");
    if (!isContentHash(idemKey)) {
      res.status = 400;
      res.set_content(R"({"error":"Idempotency-Key must be sha256"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("mime") || !body["mime"].is_string()) {
      res.status = 400;
      res.set_content(R"({"error":"mime must be a string"})", "application/json");
      return;
    }
    const auto mime = body["mime"].get<std::string>();
    if (kAllowedMimeTypes.count(mime) == 0) {
      res.status = 415;
      res.set_content(R"({"error":"unsupported mime type"})", "application/json");
      return;
    }
    const auto byteSize = body.value("byte_size", static_cast<std::size_t>(0));
    if (byteSize < 1 || byteSize > kMaxAssetBytes) {
      res.status = 413;
      res.set_content(R"({"error":"asset larger than 20 MiB"})", "application/json");
      return;
    }
    const auto caption = body.value("caption", std::string());
    if (caption.size() > kMaxCaptionBytes) {
      res.status = 413;
      res.set_content(R"({"error":"caption larger than 4 KiB"})", "application/json");
      return;
    }
    const auto contentHash = idemKey;
    if (const auto existing = store.get(tenant, contentHash)) {
      res.status = 200;
      res.set_content(existing->dump(), "application/json");
      return;
    }
    const json asset = {
        {"asset_id", "asset_" + contentHash.substr(7, 12)},
        {"checksum", contentHash},
        {"mime", mime},
        {"byte_size", byteSize},
        {"caption", caption.empty() ? json(nullptr) : json(caption)},
        {"state", "pending"},
    };
    store.put(tenant, contentHash, asset);
    res.status = 201;
    res.set_content(asset.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The interviewer is testing the trust boundary of an upload path. The draft reads fine because the
demo uploads one PNG with no caption and never retries; four defects sit underneath. The mime
allowlist is a security control, not a nicety — SVG and polyglot files are how an "image" becomes a
script. The two caps are cost controls: a caption is a model input and a byte size is a bill. The
idempotency key is the one candidates miss: the client's retry after a timeout must not create a
second asset, and since the bytes are identical, their hash is the natural key — the endpoint has to
key on it rather than on anything the caller can vary. Real systems also verify the declared
\`byte_size\` against what object storage actually received, presign the PUT with the same tenant
scope, and reject an upload whose content hash does not match the bytes it wrote.`,
};
