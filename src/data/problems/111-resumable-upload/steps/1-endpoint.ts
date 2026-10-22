import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/uploads: an upload that declares its parts',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the initiation
route, parses the body and hands back an upload id. It compiles, it serves the demo, and it hides
four production flaws. Review it like the service owner, fix it, and prove the fix with the checks
below.

Implement \`POST /v1/uploads\`, the initiation call a client makes before it sends any bytes. The body
declares \`{"total_bytes": 10485760, "part_bytes": 1048576, "content_type": "image/jpeg"}\` and the
headers carry \`X-Tenant-Id\` and \`Idempotency-Key\`.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- \`total_bytes\` is a positive integer and must not exceed the tenant's quota of **5 GiB**
  (\`5 << 30\`); anything larger is **413**.
- \`part_bytes\` must sit inside the platform's range, **1 MiB** (\`1 << 20\`) to **64 MiB**
  (\`1 << 26\`) (**400** otherwise). A 1-byte part size would create a manifest with a million rows.
- The number of parts is \`ceil(total_bytes / part_bytes)\` and must not exceed **10 000**
  (**400** otherwise). This is what bounds the manifest: part count is the total divided by the
  minimum part size.
- \`content_type\` must be one of the allowed types — \`image/jpeg\`, \`image/png\`, \`video/mp4\`,
  \`application/pdf\`, \`application/octet-stream\` (**415** otherwise). The declared type is a hint:
  the server **sniffs the leading bytes at completion** and records the sniffed type, so a client
  cannot upload a PDF while claiming \`image/png\`.
- \`Idempotency-Key\` is required (**400** when missing). A replay with the same \`(tenant, key)\`
  returns the **original upload id** — it must not start a second session.

**Failure mode the checks target.** Trusting the caller's \`part_bytes\` lets a 1-byte part create a
million-row manifest; skipping the quota check lets one tenant pin unlimited storage; accepting the
declared \`content_type\` without sniffing at completion means the recorded type is whatever the
caller said; and an initiation without an idempotency key starts a second session on every retry, so
the bytes uploaded to the first session are orphaned.`,
  sequence: {
    participants: ['Uploader', 'Upload API', 'upload store'],
    messages: [
      {from: 'Uploader', to: 'Upload API', label: 'POST /v1/uploads · X-Tenant-Id · Idempotency-Key', kind: 'sync'},
      {from: 'Upload API', to: 'Upload API', label: 'validate tenant · quota · part size · type', kind: 'sync'},
      {from: 'Upload API', to: 'upload store', label: 'get(tenant, idem_key)', kind: 'sync'},
      {from: 'upload store', to: 'Upload API', label: 'existing upload / none', kind: 'reply'},
      {from: 'Upload API', to: 'upload store', label: 'put(tenant, idem_key, upload)', kind: 'async'},
      {from: 'Upload API', to: 'Uploader', label: '201 {upload_id, part_bytes, part_count}', kind: 'reply'},
    ],
  },
  hints: [
    'Order the guards by cost: tenant, Idempotency-Key, shape, quota, part size, part count, type. Each returns before anything is stored, so a malformed initiation can never leave an orphaned session behind.',
    'The manifest size is decided here, not when parts arrive. `part_count = ceil(total_bytes / part_bytes)` and the check that matters is against `MAX_PART_COUNT`, with `MIN_PART_SIZE` stopping the 1-byte case before the division.',
    'The declared type is only a hint. Sniff the first bytes when the upload completes — `ff d8 ff` is JPEG, `89 50 4e 47 0d 0a 1a 0a` is PNG — and record the sniffed type beside the declared one. A replay keyed by `(tenant, key)` must return the stored upload, not mint a new id.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/uploads',
      detail: 'Register the initiation route on `POST /v1/uploads`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/uploads["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/uploads['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/uploads"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"uploads"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/uploads"/]},
      },
    },
    {
      id: 'part-bounds',
      title: 'Bounds the part size and the resulting part count',
      detail:
        '`part_bytes` sits in `MIN_PART_SIZE..MAX_PART_SIZE` (1 MiB..64 MiB) and `part_count = ceil(total_bytes / part_bytes)` stays under `MAX_PART_COUNT` (10 000). The draft trusts the caller’s part size, so a 1-byte part creates a million-row manifest.',
      match: {
        python: {all: [/MIN_PART_SIZE/, /MAX_PART_SIZE/, /MAX_PART_COUNT/, /part_count\s*=/]},
        typescript: {all: [/MIN_PART_SIZE/, /MAX_PART_SIZE/, /MAX_PART_COUNT/, /partCount\s*=/]},
        go: {all: [/minPartSize/, /maxPartSize/, /maxPartCount/, /partCount\s*:=/]},
        scala: {all: [/MinPartSize/, /MaxPartSize/, /MaxPartCount/, /val partCount/]},
        cpp: {all: [/kMinPartSize/, /kMaxPartSize/, /kMaxPartCount/, /partCount\s*=/]},
      },
    },
    {
      id: 'quota',
      title: 'Rejects a total size over the tenant quota',
      detail:
        'A `total_bytes` above the 5 GiB tenant quota is **413**. The draft checks no quota, so one tenant can initiate unlimited storage.',
      match: {
        python: {all: [/MAX_UPLOAD_BYTES/, /status_code\s*=\s*413/]},
        typescript: {all: [/MAX_UPLOAD_BYTES/, /code\(\s*413\s*\)/]},
        go: {all: [/maxUploadBytes/, /StatusRequestEntityTooLarge/]},
        scala: {all: [/MaxUploadBytes/, /StatusCodes\.RequestEntityTooLarge/]},
        cpp: {all: [/kMaxUploadBytes/, /\b413\b/]},
      },
    },
    {
      id: 'content-type',
      title: 'Validates the declared type and sniffs at completion',
      detail:
        '`content_type` is checked against `ALLOWED_CONTENT_TYPES`, and `sniff_content_type` reads the leading bytes at completion so the recorded type is the sniffed one. The draft trusts the declared type and never sniffs.',
      match: {
        python: {all: [/ALLOWED_CONTENT_TYPES/, /def sniff_content_type\(/]},
        typescript: {all: [/ALLOWED_CONTENT_TYPES/, /function sniffContentType\(/]},
        go: {all: [/allowedContentTypes/, /func sniffContentType\(/]},
        scala: {all: [/AllowedContentTypes/, /def sniffContentType\(/]},
        cpp: {all: [/kAllowedContentTypes/, /SniffContentType\(/]},
      },
    },
    {
      id: 'idempotency',
      title: 'Keys initiation by (tenant, Idempotency-Key)',
      detail:
        '`Idempotency-Key` is required and the upload is stored under `(tenant, key)`; a replay returns the original upload id instead of starting a second session. The draft ignores the header entirely.',
      match: {
        python: {all: [/Idempotency-Key/, /store\.get\(/, /store\.put\(/]},
        typescript: {all: [/idempotency-key/, /store\.get\(/, /store\.put\(/]},
        go: {all: [/Idempotency-Key/, /store\.Get\(/, /store\.Put\(/]},
        scala: {all: [/Idempotency-Key/, /store\.get\(/, /store\.put\(/]},
        cpp: {all: [/Idempotency-Key/, /store\.get\(/, /store\.put\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
import uuid

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("upload")


class InitUploadRequest(BaseModel):
    total_bytes: int
    part_bytes: int
    content_type: str


class UploadStore:
    def get(self, tenant: str, key: str):
        """The upload recorded for (tenant, key), if any."""
        raise NotImplementedError

    def put(self, tenant: str, key: str, upload: dict) -> None:
        """Record the upload under (tenant, key)."""
        raise NotImplementedError


store = UploadStore()


@app.post("/v1/uploads")
def init_upload(body: InitUploadRequest, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this draft trusts the caller's part size and content type, never checks the tenant
    # quota, and creates a new upload session on every retry. Review all four.
    upload_id = uuid.uuid4().hex
    logger.info("upload init tenant=%s total=%d", tenant, body.total_bytes)
    return JSONResponse(
        {
            "upload_id": upload_id,
            "part_bytes": body.part_bytes,
            "part_count": -(-body.total_bytes // body.part_bytes),
            "content_type": body.content_type,
        },
        status_code=201,
    )
`,
      solution: `import logging
import uuid

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("upload")

MIN_PART_SIZE = 1 << 20
MAX_PART_SIZE = 1 << 26
MAX_PART_COUNT = 10_000
MAX_UPLOAD_BYTES = 5 << 30
ALLOWED_CONTENT_TYPES = {
    "image/jpeg",
    "image/png",
    "video/mp4",
    "application/pdf",
    "application/octet-stream",
}


class InitUploadRequest(BaseModel):
    total_bytes: int
    part_bytes: int
    content_type: str


class UploadStore:
    def get(self, tenant: str, key: str):
        """The upload recorded for (tenant, key), if any."""
        raise NotImplementedError

    def put(self, tenant: str, key: str, upload: dict) -> None:
        """Record the upload under (tenant, key)."""
        raise NotImplementedError


store = UploadStore()


def sniff_content_type(first_bytes: bytes) -> str:
    """The type from the leading bytes, ignoring what the client declared."""
    if first_bytes.startswith(b"\\xff\\xd8\\xff"):
        return "image/jpeg"
    if first_bytes.startswith(b"\\x89PNG\\r\\n\\x1a\\n"):
        return "image/png"
    return "application/octet-stream"


@app.post("/v1/uploads")
def init_upload(
    body: InitUploadRequest,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    idem_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        return JSONResponse({"error": "missing X-Tenant-Id"}, status_code=401)
    if idem_key is None or idem_key == "":
        return JSONResponse({"error": "Idempotency-Key is required"}, status_code=400)
    stored = store.get(tenant, idem_key)
    if stored is not None:
        return JSONResponse(stored, status_code=201)
    if body.total_bytes <= 0:
        return JSONResponse({"error": "total_bytes must be positive"}, status_code=400)
    if body.total_bytes > MAX_UPLOAD_BYTES:
        return JSONResponse({"error": "upload exceeds tenant quota"}, status_code=413)
    if body.part_bytes < MIN_PART_SIZE or body.part_bytes > MAX_PART_SIZE:
        return JSONResponse({"error": "part_bytes out of range"}, status_code=400)
    part_count = -(-body.total_bytes // body.part_bytes)
    if part_count > MAX_PART_COUNT:
        return JSONResponse({"error": "too many parts"}, status_code=400)
    if body.content_type not in ALLOWED_CONTENT_TYPES:
        return JSONResponse({"error": "unsupported content type"}, status_code=415)
    upload = {
        "upload_id": uuid.uuid4().hex,
        "tenant": tenant,
        "total_bytes": body.total_bytes,
        "part_bytes": body.part_bytes,
        "part_count": part_count,
        "content_type": body.content_type,
        "sniffed_content_type": None,
        "status": "pending",
    }
    store.put(tenant, idem_key, upload)
    logger.info("upload init tenant=%s upload=%s parts=%d", tenant, upload["upload_id"], part_count)
    return JSONResponse(upload, status_code=201)


@app.post("/v1/uploads/{upload_id}/complete")
def complete_upload(
    upload_id: str,
    first_bytes: bytes,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
) -> JSONResponse:
    stored = store.get(tenant, upload_id)
    if stored is None:
        return JSONResponse({"error": "unknown upload"}, status_code=404)
    stored["sniffed_content_type"] = sniff_content_type(first_bytes)
    store.put(tenant, upload_id, stored)
    return JSONResponse({"upload_id": upload_id, "content_type": stored["sniffed_content_type"]}, status_code=200)
`,
    },
    typescript: {
      starter: `/** POST /v1/uploads: a model-generated draft that trusts the caller's declaration. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

export const app = Fastify();

interface InitUploadBody {
  total_bytes: number;
  part_bytes: number;
  content_type: string;
}

app.post('/v1/uploads', async (request, reply) => {
  // TODO: this draft trusts the caller's part size and content type, never checks the tenant
  // quota, and creates a new upload session on every retry. Review all four.
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as InitUploadBody;
  request.log.info({tenant, total: body.total_bytes}, 'upload init');
  return reply.code(201).send({
    upload_id: randomUUID(),
    part_bytes: body.part_bytes,
    part_count: Math.ceil(body.total_bytes / body.part_bytes),
    content_type: body.content_type,
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/uploads: bounded, quota-checked, idempotent initiation. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

export const app = Fastify();

const MIN_PART_SIZE = 1 << 20;
const MAX_PART_SIZE = 1 << 26;
const MAX_PART_COUNT = 10_000;
const MAX_UPLOAD_BYTES = 5 << 30;
const ALLOWED_CONTENT_TYPES: Record<string, true> = {
  'image/jpeg': true,
  'image/png': true,
  'video/mp4': true,
  'application/pdf': true,
  'application/octet-stream': true,
};

interface InitUploadBody {
  total_bytes: number;
  part_bytes: number;
  content_type: string;
}

interface Upload {
  upload_id: string;
  tenant: string;
  total_bytes: number;
  part_bytes: number;
  part_count: number;
  content_type: string;
  sniffed_content_type: string | null;
  status: string;
}

interface UploadStore {
  get(tenant: string, key: string): Promise<Upload | null>;
  put(tenant: string, key: string, upload: Upload): Promise<void>;
}

declare const store: UploadStore;

function sniffContentType(firstBytes: Buffer): string {
  if (firstBytes.length >= 3 && firstBytes[0] === 0xff && firstBytes[1] === 0xd8 && firstBytes[2] === 0xff)
    return 'image/jpeg';
  if (firstBytes.length >= 8 && firstBytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png';
  return 'application/octet-stream';
}

app.post('/v1/uploads', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '')
    return reply.code(400).send({error: 'Idempotency-Key is required'});

  const stored = await store.get(tenant, idemKey);
  if (stored !== null) return reply.code(201).send(stored);

  const body = request.body as Partial<InitUploadBody> | null;
  if (body === null || typeof body !== 'object')
    return reply.code(400).send({error: 'invalid body'});
  const totalBytes = body.total_bytes ?? 0;
  const partBytes = body.part_bytes ?? 0;
  const contentType = body.content_type ?? '';
  if (!Number.isInteger(totalBytes) || totalBytes <= 0)
    return reply.code(400).send({error: 'total_bytes must be positive'});
  if (totalBytes > MAX_UPLOAD_BYTES) return reply.code(413).send({error: 'upload exceeds tenant quota'});
  if (partBytes < MIN_PART_SIZE || partBytes > MAX_PART_SIZE)
    return reply.code(400).send({error: 'part_bytes out of range'});
  const partCount = Math.ceil(totalBytes / partBytes);
  if (partCount > MAX_PART_COUNT) return reply.code(400).send({error: 'too many parts'});
  if (ALLOWED_CONTENT_TYPES[contentType] !== true)
    return reply.code(415).send({error: 'unsupported content type'});

  const upload: Upload = {
    upload_id: randomUUID(),
    tenant,
    total_bytes: totalBytes,
    part_bytes: partBytes,
    part_count: partCount,
    content_type: contentType,
    sniffed_content_type: null,
    status: 'pending',
  };
  await store.put(tenant, idemKey, upload);
  request.log.info({tenant, upload: upload.upload_id, parts: partCount}, 'upload init');
  return reply.code(201).send(upload);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package api

import (
	"context"
	"encoding/json"
	"log"
	"net/http"

	"github.com/google/uuid"
)

type initUploadBody struct {
	TotalBytes  int64  \`json:"total_bytes"\`
	PartBytes   int64  \`json:"part_bytes"\`
	ContentType string \`json:"content_type"\`
}

type uploadStore interface {
	Get(ctx context.Context, tenant, key string) (map[string]any, error)
	Put(ctx context.Context, tenant, key string, upload map[string]any) error
}

var store uploadStore

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func initUpload(w http.ResponseWriter, r *http.Request) {
	// TODO: this draft trusts the caller's part size and content type, never checks the tenant
	// quota, and creates a new upload session on every retry. Review all four.
	tenant := r.Header.Get("X-Tenant-Id")
	var body initUploadBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	log.Printf("upload init tenant=%s total=%d", tenant, body.TotalBytes)
	writeJSON(w, http.StatusCreated, map[string]any{
		"upload_id":    uuid.NewString(),
		"part_bytes":   body.PartBytes,
		"part_count":   (body.TotalBytes + body.PartBytes - 1) / body.PartBytes,
		"content_type": body.ContentType,
	})
}

func Register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/uploads", initUpload)
}
`,
      solution: `package api

import (
	"context"
	"encoding/json"
	"log"
	"net/http"

	"github.com/google/uuid"
)

const (
	minPartSize    int64 = 1 << 20
	maxPartSize    int64 = 1 << 26
	maxPartCount   int64 = 10000
	maxUploadBytes int64 = 5 << 30
)

var allowedContentTypes = map[string]bool{
	"image/jpeg":               true,
	"image/png":                true,
	"video/mp4":                true,
	"application/pdf":          true,
	"application/octet-stream": true,
}

type initUploadBody struct {
	TotalBytes  int64  \`json:"total_bytes"\`
	PartBytes   int64  \`json:"part_bytes"\`
	ContentType string \`json:"content_type"\`
}

type uploadStore interface {
	Get(ctx context.Context, tenant, key string) (map[string]any, error)
	Put(ctx context.Context, tenant, key string, upload map[string]any) error
}

var store uploadStore

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func sniffContentType(firstBytes []byte) string {
	if len(firstBytes) >= 3 && firstBytes[0] == 0xff && firstBytes[1] == 0xd8 && firstBytes[2] == 0xff {
		return "image/jpeg"
	}
	if len(firstBytes) >= 8 && string(firstBytes[:8]) == "\\x89PNG\\r\\n\\x1a\\n" {
		return "image/png"
	}
	return "application/octet-stream"
}

func initUpload(w http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	idemKey := r.Header.Get("Idempotency-Key")
	if idemKey == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Idempotency-Key is required"})
		return
	}
	stored, err := store.Get(r.Context(), tenant, idemKey)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if stored != nil {
		writeJSON(w, http.StatusCreated, stored)
		return
	}
	var body initUploadBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid body"})
		return
	}
	if body.TotalBytes <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "total_bytes must be positive"})
		return
	}
	if body.TotalBytes > maxUploadBytes {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "upload exceeds tenant quota"})
		return
	}
	if body.PartBytes < minPartSize || body.PartBytes > maxPartSize {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "part_bytes out of range"})
		return
	}
	partCount := (body.TotalBytes + body.PartBytes - 1) / body.PartBytes
	if partCount > maxPartCount {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "too many parts"})
		return
	}
	if !allowedContentTypes[body.ContentType] {
		writeJSON(w, http.StatusUnsupportedMediaType, map[string]string{"error": "unsupported content type"})
		return
	}
	upload := map[string]any{
		"upload_id":           uuid.NewString(),
		"tenant":              tenant,
		"total_bytes":         body.TotalBytes,
		"part_bytes":          body.PartBytes,
		"part_count":          partCount,
		"content_type":        body.ContentType,
		"sniffed_content_type": nil,
		"status":              "pending",
	}
	if err := store.Put(r.Context(), tenant, idemKey, upload); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("upload init tenant=%s upload=%v parts=%d", tenant, upload["upload_id"], partCount)
	writeJSON(w, http.StatusCreated, upload)
}

func Register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/uploads", initUpload)
}
`,
    },
    scala: {
      starter: `package upload

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

import java.util.UUID

final case class InitUploadRequest(total_bytes: Long, part_bytes: Long, content_type: String)

object UploadApi {
  implicit val system: ActorSystem = ActorSystem("upload")
  implicit val uploadFormat: RootJsonFormat[InitUploadRequest] = jsonFormat3(InitUploadRequest)

  val store = UploadStore.open()

  val route: Route =
    path("v1" / "uploads") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[InitUploadRequest]) { body =>
            // TODO: this draft trusts the caller's part size and content type, never checks the
            // tenant quota, and creates a new upload session on every retry. Review all four.
            val parts = (body.total_bytes + body.part_bytes - 1) / body.part_bytes
            system.log.info(s"upload init tenant=$tenant total=\${body.total_bytes}")
            complete(
              StatusCodes.Created,
              s"""{"upload_id":"\${UUID.randomUUID()}","part_bytes":\${body.part_bytes},"part_count":$parts,"content_type":"\${body.content_type}"}"""
            )
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `package upload

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

import java.util.UUID

final case class InitUploadRequest(total_bytes: Long, part_bytes: Long, content_type: String)
final case class Upload(
    upload_id: String,
    tenant: String,
    total_bytes: Long,
    part_bytes: Long,
    part_count: Long,
    content_type: String,
    sniffed_content_type: Option[String],
    status: String,
)

object UploadApi {
  implicit val system: ActorSystem = ActorSystem("upload")
  implicit val uploadFormat: RootJsonFormat[InitUploadRequest] = jsonFormat3(InitUploadRequest)
  implicit val storedUploadFormat: RootJsonFormat[Upload] = jsonFormat8(Upload)

  val MinPartSize: Long = 1L << 20
  val MaxPartSize: Long = 1L << 26
  val MaxPartCount: Long = 10000
  val MaxUploadBytes: Long = 5L << 30
  val AllowedContentTypes: Set[String] =
    Set("image/jpeg", "image/png", "video/mp4", "application/pdf", "application/octet-stream")

  val store = UploadStore.open()

  def sniffContentType(firstBytes: Array[Byte]): String = {
    if (
      firstBytes.length >= 3 &&
      firstBytes(0) == 0xff.toByte && firstBytes(1) == 0xd8.toByte && firstBytes(2) == 0xff.toByte
    ) "image/jpeg"
    else if (firstBytes.length >= 8 && new String(firstBytes.take(8), "ISO-8859-1") == "\\u0089PNG\\r\\n\\u001a\\n")
      "image/png"
    else "application/octet-stream"
  }

  val route: Route =
    path("v1" / "uploads") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          optionalHeaderValueByName("Idempotency-Key") { idemOpt =>
            entity(as[InitUploadRequest]) { body =>
              if (!tenantOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
              } else if (!idemOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.BadRequest, """{"error":"Idempotency-Key is required"}""")
              } else {
                val tenant = tenantOpt.get
                val idemKey = idemOpt.get
                store.get(tenant, idemKey) match {
                  case Some(stored) =>
                    complete(StatusCodes.Created, stored)
                  case None if body.total_bytes <= 0 =>
                    complete(StatusCodes.BadRequest, """{"error":"total_bytes must be positive"}""")
                  case None if body.total_bytes > MaxUploadBytes =>
                    complete(StatusCodes.RequestEntityTooLarge, """{"error":"upload exceeds tenant quota"}""")
                  case None if body.part_bytes < MinPartSize || body.part_bytes > MaxPartSize =>
                    complete(StatusCodes.BadRequest, """{"error":"part_bytes out of range"}""")
                  case None =>
                    val partCount: Long = (body.total_bytes + body.part_bytes - 1) / body.part_bytes
                    if (partCount > MaxPartCount) {
                      complete(StatusCodes.BadRequest, """{"error":"too many parts"}""")
                    } else if (!AllowedContentTypes.contains(body.content_type)) {
                      complete(StatusCodes.UnsupportedMediaType, """{"error":"unsupported content type"}""")
                    } else {
                      val upload = Upload(
                        UUID.randomUUID().toString,
                        tenant,
                        body.total_bytes,
                        body.part_bytes,
                        partCount,
                        body.content_type,
                        None,
                        "pending",
                      )
                      store.put(tenant, idemKey, upload)
                      system.log.info(s"upload init tenant=$tenant upload=\${upload.upload_id} parts=$partCount")
                      complete(StatusCodes.Created, upload)
                    }
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

#include <iostream>
#include <string>

using json = nlohmann::json;

struct UploadStore {
  std::optional<json> get(const std::string& tenant, const std::string& key);
  void put(const std::string& tenant, const std::string& key, const json& upload);
};

UploadStore store;
std::string uuidString();

int main() {
  httplib::Server svr;

  svr.Post("/v1/uploads", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(json{{"error", "invalid json"}}.dump(), "application/json");
      return;
    }
    // TODO: this draft trusts the caller's part size and content type, never checks the tenant
    // quota, and creates a new upload session on every retry. Review all four.
    const auto totalBytes = body.value("total_bytes", 0LL);
    const auto partBytes = body.value("part_bytes", 0LL);
    std::cerr << "upload init tenant=" << tenant << " total=" << totalBytes << "\\n";
    res.status = 201;
    res.set_content(
        json{{"upload_id", uuidString()},
             {"part_bytes", partBytes},
             {"part_count", (totalBytes + partBytes - 1) / partBytes},
             {"content_type", body.value("content_type", std::string())}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <optional>
#include <set>
#include <string>

using json = nlohmann::json;

constexpr long long kMinPartSize = 1LL << 20;
constexpr long long kMaxPartSize = 1LL << 26;
constexpr long long kMaxPartCount = 10000;
constexpr long long kMaxUploadBytes = 5LL << 30;
const std::set<std::string> kAllowedContentTypes = {
    "image/jpeg", "image/png", "video/mp4", "application/pdf", "application/octet-stream"};

struct UploadStore {
  std::optional<json> get(const std::string& tenant, const std::string& key);
  void put(const std::string& tenant, const std::string& key, const json& upload);
};

UploadStore store;
std::string uuidString();

std::string SniffContentType(const std::string& firstBytes) {
  if (firstBytes.size() >= 3 && static_cast<unsigned char>(firstBytes[0]) == 0xff &&
      static_cast<unsigned char>(firstBytes[1]) == 0xd8 && static_cast<unsigned char>(firstBytes[2]) == 0xff)
    return "image/jpeg";
  if (firstBytes.size() >= 8 && firstBytes.compare(0, 8, "\\x89PNG\\r\\n\\x1a\\n") == 0) return "image/png";
  return "application/octet-stream";
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/uploads", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(json{{"error", "missing X-Tenant-Id"}}.dump(), "application/json");
      return;
    }
    const auto idemKey = req.get_header_value("Idempotency-Key");
    if (idemKey.empty()) {
      res.status = 400;
      res.set_content(json{{"error", "Idempotency-Key is required"}}.dump(), "application/json");
      return;
    }
    const auto stored = store.get(tenant, idemKey);
    if (stored) {
      res.status = 201;
      res.set_content(stored->dump(), "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(json{{"error", "invalid json"}}.dump(), "application/json");
      return;
    }
    const long long totalBytes = body.value("total_bytes", 0LL);
    const long long partBytes = body.value("part_bytes", 0LL);
    const auto contentType = body.value("content_type", std::string());
    if (totalBytes <= 0) {
      res.status = 400;
      res.set_content(json{{"error", "total_bytes must be positive"}}.dump(), "application/json");
      return;
    }
    if (totalBytes > kMaxUploadBytes) {
      res.status = 413;
      res.set_content(json{{"error", "upload exceeds tenant quota"}}.dump(), "application/json");
      return;
    }
    if (partBytes < kMinPartSize || partBytes > kMaxPartSize) {
      res.status = 400;
      res.set_content(json{{"error", "part_bytes out of range"}}.dump(), "application/json");
      return;
    }
    const long long partCount = (totalBytes + partBytes - 1) / partBytes;
    if (partCount > kMaxPartCount) {
      res.status = 400;
      res.set_content(json{{"error", "too many parts"}}.dump(), "application/json");
      return;
    }
    if (kAllowedContentTypes.count(contentType) == 0) {
      res.status = 415;
      res.set_content(json{{"error", "unsupported content type"}}.dump(), "application/json");
      return;
    }
    const json upload = {
        {"upload_id", uuidString()},
        {"tenant", tenant},
        {"total_bytes", totalBytes},
        {"part_bytes", partBytes},
        {"part_count", partCount},
        {"content_type", contentType},
        {"sniffed_content_type", nullptr},
        {"status", "pending"},
    };
    store.put(tenant, idemKey, upload);
    std::cerr << "upload init tenant=" << tenant << " upload=" << upload["upload_id"] << "\\n";
    res.status = 201;
    res.set_content(upload.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The interviewer is testing whether you can review a generated handler at the trust boundary. The draft reads fine because the demo sends well-formed requests from one tenant and never retries. Four defects are being checked: the tenant is never optional; the part size and the resulting part count are bounded so the manifest cannot blow up; the total is checked against the tenant quota; and the initiation is idempotent, so a client retry returns the original upload id instead of orphaning the first session's bytes. The quiet one is the declared type: a client can send \`image/png\` and then upload a PDF, so the server sniffs the leading bytes at completion and records what it saw. Real upload services add per-tenant storage accounting, a signed initiation token, and a declared-part-count cross-check against the object store's multipart metadata.`,
};
