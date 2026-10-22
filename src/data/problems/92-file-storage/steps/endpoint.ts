import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/files: a size nobody trusts',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'redis', 'store'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers \`POST /v1/files\`,
reads \`size\` and \`mime\` from the body, and returns an upload id. It compiles, it serves the demo, and
it hides three production flaws. Review it like the service owner, fix it, and prove the fix with the
checks below.

Implement the upload handshake:

- \`POST /v1/files\` with body \`{"size": 1048576, "mime": "image/png"}\`.
- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- \`size\` is an integer from **1** to **5 GiB** (\`5 << 30\` bytes); anything else is **413**.
- \`mime\` must be in the server's allowlist (\`image/png\`, \`image/jpeg\`, \`application/pdf\`,
  \`text/plain\`); anything else is **415**.
- The declared size is checked against the tenant's remaining quota before the session exists; a
  declaration over quota is **413** and creates nothing.
- The response is \`{"upload_id": "up_<tenant>_<uuid>", "declared_size": <bytes>}\` — the upload id is
  scoped to the tenant that created it.
- \`PUT /v1/uploads/{upload_id}\` streams the bytes. The server counts what actually arrives and, the
  moment the count passes the declared size, aborts the upload (**413**) and releases the session —
  the declared size is a contract the stream must honour, not a fact the server trusts.
- \`POST /v1/uploads/{upload_id}/finalize\` sniffs the mime from the object's leading bytes, records the
  **sniffed** type rather than the declared one, and requires the stored byte count to equal the
  declared size (**409** when it does not).
- An upload id presented by a different tenant is **403** on both the stream and the finalize path.

**Failure mode the checks target.** Trusting the declared size means a client can declare 1 KiB,
stream 4 GiB, and pay for neither the quota nor the object store. Accepting the declared mime without
sniffing lets an executable be stored as \`image/png\`. And an upload id that is not bound to its
tenant is a capability anyone who guesses or leaks the id can use.`,
  sequence: {
    participants: ['Client', 'Upload API', 'Redis', 'Object store'],
    messages: [
      {from: 'Client', to: 'Upload API', label: 'POST /v1/files · X-Tenant-Id · size · mime', kind: 'sync'},
      {from: 'Upload API', to: 'Upload API', label: 'validate size · mime allowlist', kind: 'sync'},
      {from: 'Upload API', to: 'Redis', label: 'quota:remaining(tenant)', kind: 'sync'},
      {from: 'Redis', to: 'Upload API', label: 'remaining bytes', kind: 'reply'},
      {from: 'Upload API', to: 'Client', label: '201 {upload_id, declared_size}', kind: 'reply'},
      {from: 'Client', to: 'Upload API', label: 'PUT /v1/uploads/{upload_id} · stream', kind: 'sync'},
      {from: 'Upload API', to: 'Upload API', label: 'count bytes · abort past declared', kind: 'sync'},
      {from: 'Client', to: 'Upload API', label: 'POST /v1/uploads/{upload_id}/finalize', kind: 'sync'},
      {from: 'Upload API', to: 'Upload API', label: 'sniff mime · compare stored bytes', kind: 'sync'},
      {from: 'Upload API', to: 'Object store', label: 'PutObject(committed)', kind: 'async'},
      {from: 'Upload API', to: 'Client', label: '200 {file_id, mime}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/files',
      detail: 'Register the upload handshake on `POST /v1/files`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/files["']\)/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/files['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/files"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"files"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/files"/]},
      },
    },
    {
      id: 'tenant-scope',
      title: 'Binds every upload to the tenant that created it',
      detail:
        'A missing tenant is **401** and an upload id used by another tenant is **403**. The draft stores no tenant on the session and answers a foreign upload id happily.',
      match: {
        python: {all: [/status_code\s*=\s*401/, /status_code\s*=\s*403/, /session\["tenant"\]/]},
        typescript: {all: [/code\(\s*401\s*\)/, /code\(\s*403\s*\)/, /session\.tenant/]},
        go: {all: [/StatusUnauthorized/, /StatusForbidden/, /session\.Tenant/]},
        scala: {all: [/StatusCodes\.Unauthorized/, /StatusCodes\.Forbidden/, /session\.tenant/]},
        cpp: {all: [/\b401\b/, /\b403\b/, /session\.tenant/]},
      },
    },
    {
      id: 'mime-sniff',
      title: 'Sniffs the mime instead of trusting the declaration',
      detail:
        'The mime must be in the allowlist (**415** otherwise) and the finalize path records the type sniffed from the bytes. The draft accepts any mime and never sniffs.',
      match: {
        python: {all: [/ALLOWED_MIME/, /sniff_mime/, /status_code\s*=\s*415/]},
        typescript: {all: [/ALLOWED_MIME/, /sniffMime/, /code\(\s*415\s*\)/]},
        go: {all: [/AllowedMime/, /SniffMime/, /StatusUnsupportedMediaType/]},
        scala: {all: [/AllowedMime/, /sniffMime/, /StatusCodes\.UnsupportedMediaType/]},
        cpp: {all: [/kAllowedMime/, /sniffMime/, /\b415\b/]},
      },
    },
    {
      id: 'declared-size',
      title: 'Aborts a stream that exceeds its declared size',
      detail:
        'The declared size is capped at 5 GiB and the stream is counted as it arrives; passing the declared size aborts the upload with **413**. The draft lets the stream run and never compares the counts.',
      match: {
        python: {all: [/declared_size/, /actual_bytes/, /MAX_UPLOAD_BYTES/, /status_code\s*=\s*413/]},
        typescript: {all: [/declaredSize/, /actualBytes/, /MAX_UPLOAD_BYTES/, /code\(\s*413\s*\)/]},
        go: {all: [/DeclaredSize/, /ActualBytes/, /MaxUploadBytes/, /StatusRequestEntityTooLarge/]},
        scala: {all: [/declaredSize/, /actualBytes/, /MaxUploadBytes/, /StatusCodes\.RequestEntityTooLarge/]},
        cpp: {all: [/declaredSize/, /actualBytes/, /kMaxUploadBytes/, /\b413\b/]},
      },
    },
    {
      id: 'quota-reserve',
      title: 'Checks the declaration against the tenant quota',
      detail:
        'The declared size is compared with the tenant’s remaining quota and an over-quota declaration is rejected before the session is created. The draft creates the upload without ever reading the quota.',
      match: {
        python: {all: [/quota_remaining/, /declared_size/]},
        typescript: {all: [/quotaRemaining/, /declaredSize/]},
        go: {all: [/QuotaRemaining/, /DeclaredSize/]},
        scala: {all: [/quotaRemaining/, /declaredSize/]},
        cpp: {all: [/quotaRemaining/, /declaredSize/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import uuid

from fastapi import FastAPI, Header, Request
from fastapi.responses import JSONResponse

app = FastAPI()


class UploadStore:
    def create(self, upload_id, size, mime):
        raise NotImplementedError

    def get(self, upload_id):
        raise NotImplementedError

    def mark_uploaded(self, upload_id):
        raise NotImplementedError


store = UploadStore()


@app.post("/v1/files")
async def initiate(request: Request, x_tenant_id: str = Header(default="")):
    if not x_tenant_id:
        return JSONResponse({"error": "missing X-Tenant-Id"}, status_code=401)
    body = await request.json()
    size = body.get("size", 0)
    mime = body.get("mime", "application/octet-stream")
    # TODO: this draft trusts the declared size, sniffs no mime and stores no tenant on the
    # session. The quota is never read and a stream may run past its declared size.
    upload_id = "up_" + uuid.uuid4().hex
    store.create(upload_id, size, mime)
    return JSONResponse({"upload_id": upload_id, "size": size}, status_code=201)


@app.put("/v1/uploads/{upload_id}")
async def stream_body(upload_id: str, request: Request):
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        store.mark_uploaded(upload_id)
    return JSONResponse({"received": total}, status_code=200)


@app.post("/v1/uploads/{upload_id}/finalize")
async def finalize(upload_id: str):
    store.mark_uploaded(upload_id)
    return JSONResponse({"file_id": "f_" + upload_id}, status_code=200)
`,
      solution: `import uuid

from fastapi import FastAPI, Header, Request
from fastapi.responses import JSONResponse

app = FastAPI()

MAX_UPLOAD_BYTES = 5 << 30
ALLOWED_MIME = {"image/png", "image/jpeg", "application/pdf", "text/plain"}
MAGIC = {b"\\x89PNG": "image/png", b"%PDF": "application/pdf"}


def sniff_mime(head: bytes) -> str:
    for magic, mime in MAGIC.items():
        if head.startswith(magic):
            return mime
    return "application/octet-stream"


class UploadStore:
    def create(self, session):
        raise NotImplementedError

    def get(self, upload_id):
        raise NotImplementedError

    def quota_remaining(self, tenant):
        raise NotImplementedError

    def add_bytes(self, upload_id, n):
        raise NotImplementedError

    def abort(self, upload_id):
        raise NotImplementedError

    def finalize(self, upload_id, mime, size):
        raise NotImplementedError


store = UploadStore()


@app.post("/v1/files")
async def initiate(request: Request, x_tenant_id: str = Header(default="")):
    if not x_tenant_id:
        return JSONResponse({"error": "missing X-Tenant-Id"}, status_code=401)
    body = await request.json()
    size = body.get("size")
    mime = body.get("mime", "")
    if not isinstance(size, int) or size <= 0 or size > MAX_UPLOAD_BYTES:
        return JSONResponse({"error": "size out of range"}, status_code=413)
    if mime not in ALLOWED_MIME:
        return JSONResponse({"error": "mime not allowed"}, status_code=415)
    if size > store.quota_remaining(x_tenant_id):
        return JSONResponse({"error": "quota exceeded"}, status_code=413)
    upload_id = "up_" + x_tenant_id + "_" + uuid.uuid4().hex
    session = {
        "upload_id": upload_id,
        "tenant": x_tenant_id,
        "declared_size": size,
        "actual_bytes": 0,
        "mime": mime,
    }
    store.create(session)
    return JSONResponse({"upload_id": upload_id, "declared_size": size}, status_code=201)


@app.put("/v1/uploads/{upload_id}")
async def stream_body(upload_id: str, request: Request, x_tenant_id: str = Header(default="")):
    session = store.get(upload_id)
    if session is None:
        return JSONResponse({"error": "unknown upload"}, status_code=404)
    if session["tenant"] != x_tenant_id:
        return JSONResponse({"error": "forbidden"}, status_code=403)
    written = 0
    async for chunk in request.stream():
        written += len(chunk)
        if written > session["declared_size"]:
            store.abort(upload_id)
            return JSONResponse({"error": "stream exceeds declared size"}, status_code=413)
        store.add_bytes(upload_id, len(chunk))
    return JSONResponse({"received": written}, status_code=200)


@app.post("/v1/uploads/{upload_id}/finalize")
async def finalize(upload_id: str, request: Request, x_tenant_id: str = Header(default="")):
    session = store.get(upload_id)
    if session is None:
        return JSONResponse({"error": "unknown upload"}, status_code=404)
    if session["tenant"] != x_tenant_id:
        return JSONResponse({"error": "forbidden"}, status_code=403)
    body = await request.json()
    mime = sniff_mime(bytes.fromhex(body.get("head_hex", "")))
    if session["actual_bytes"] != session["declared_size"]:
        return JSONResponse({"error": "size mismatch"}, status_code=409)
    store.finalize(upload_id, mime, session["actual_bytes"])
    return JSONResponse({"file_id": "f_" + upload_id, "mime": mime}, status_code=200)
`,
    },
    typescript: {
      starter: `import type {FastifyInstance} from 'fastify';
import {randomUUID} from 'node:crypto';

interface Session {
  uploadId: string;
  size: number;
  mime: string;
}

const store = {
  create(session: Session): void {},
  get(uploadId: string): Session | undefined {
    return undefined;
  },
  markUploaded(uploadId: string): void {},
};

export function registerUploadApi(app: FastifyInstance): void {
  app.post('/v1/files', async (req, reply) => {
    const tenant = req.headers['x-tenant-id'] as string | undefined;
    if (!tenant) return reply.code(401).send({error: 'missing X-Tenant-Id'});
    const body = req.body as {size?: number; mime?: string};
    // TODO: this draft trusts the declared size, sniffs no mime and stores no tenant on the
    // session. The quota is never read and a stream may run past its declared size.
    const uploadId = 'up_' + randomUUID();
    store.create({uploadId, size: body.size ?? 0, mime: body.mime ?? ''});
    return reply.code(201).send({upload_id: uploadId, size: body.size ?? 0});
  });

  app.put('/v1/uploads/:uploadId', async (req, reply) => {
    const {uploadId} = req.params as {uploadId: string};
    let written = 0;
    for await (const part of req.raw) {
      written += part.length;
      store.markUploaded(uploadId);
    }
    return reply.code(200).send({received: written});
  });

  app.post('/v1/uploads/:uploadId/finalize', async (req, reply) => {
    const {uploadId} = req.params as {uploadId: string};
    store.markUploaded(uploadId);
    return reply.code(200).send({file_id: 'f_' + uploadId});
  });
}
`,
      solution: `import type {FastifyInstance} from 'fastify';
import {randomUUID} from 'node:crypto';

const MAX_UPLOAD_BYTES = 5 << 30;
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'application/pdf', 'text/plain']);
const MAGIC: [number[], string][] = [[[0x89, 0x50, 0x4e, 0x47], 'image/png']];

function sniffMime(head: Buffer): string {
  for (const [magic, mime] of MAGIC)
    if (head.subarray(0, magic.length).equals(Buffer.from(magic))) return mime;
  return 'application/octet-stream';
}

interface Session {
  uploadId: string;
  tenant: string;
  declaredSize: number;
  actualBytes: number;
  mime: string;
}

const store = {
  create(session: Session): void {},
  get(uploadId: string): Session | undefined {
    return undefined;
  },
  quotaRemaining(tenant: string): number {
    return 0;
  },
  addBytes(uploadId: string, n: number): void {},
  abort(uploadId: string): void {},
  finalize(uploadId: string, mime: string, size: number): void {},
};

export function registerUploadApi(app: FastifyInstance): void {
  app.post('/v1/files', async (req, reply) => {
    const tenant = req.headers['x-tenant-id'] as string | undefined;
    if (!tenant) return reply.code(401).send({error: 'missing X-Tenant-Id'});
    const body = req.body as {size?: unknown; mime?: string};
    const size = body.size;
    if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0 || size > MAX_UPLOAD_BYTES)
      return reply.code(413).send({error: 'size out of range'});
    if (!ALLOWED_MIME.has(body.mime ?? '')) return reply.code(415).send({error: 'mime not allowed'});
    if (size > store.quotaRemaining(tenant)) return reply.code(413).send({error: 'quota exceeded'});
    const uploadId = 'up_' + tenant + '_' + randomUUID();
    store.create({uploadId, tenant, declaredSize: size, actualBytes: 0, mime: body.mime ?? ''});
    return reply.code(201).send({upload_id: uploadId, declared_size: size});
  });

  app.put('/v1/uploads/:uploadId', async (req, reply) => {
    const {uploadId} = req.params as {uploadId: string};
    const tenant = req.headers['x-tenant-id'] as string | undefined;
    const session = store.get(uploadId);
    if (session === undefined) return reply.code(404).send({error: 'unknown upload'});
    if (session.tenant !== tenant) return reply.code(403).send({error: 'forbidden'});
    let written = 0;
    for await (const part of req.raw) {
      written += part.length;
      if (written > session.declaredSize) {
        store.abort(uploadId);
        return reply.code(413).send({error: 'stream exceeds declared size'});
      }
      store.addBytes(uploadId, part.length);
    }
    return reply.code(200).send({received: written});
  });

  app.post('/v1/uploads/:uploadId/finalize', async (req, reply) => {
    const {uploadId} = req.params as {uploadId: string};
    const tenant = req.headers['x-tenant-id'] as string | undefined;
    const session = store.get(uploadId);
    if (session === undefined) return reply.code(404).send({error: 'unknown upload'});
    if (session.tenant !== tenant) return reply.code(403).send({error: 'forbidden'});
    const body = req.body as {headHex?: string};
    const mime = sniffMime(Buffer.from(body.headHex ?? '', 'hex'));
    if (session.actualBytes !== session.declaredSize) return reply.code(409).send({error: 'size mismatch'});
    store.finalize(uploadId, mime, session.actualBytes);
    return reply.code(200).send({file_id: 'f_' + uploadId, mime});
  });
}
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"
)

type Session struct {
	UploadID string \`json:"upload_id"\`
	Size     int    \`json:"size"\`
	Mime     string \`json:"mime"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

var store UploadStore

func initiate(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	var body struct {
		Size int    \`json:"size"\`
		Mime string \`json:"mime"\`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft trusts the declared size, sniffs no mime and stores no tenant on the
	// session. The quota is never read and a stream may run past its declared size.
	session := Session{UploadID: "up_" + uuidString(), Size: body.Size, Mime: body.Mime}
	store.Create(session)
	writeJSON(rw, http.StatusCreated, map[string]any{"upload_id": session.UploadID, "size": session.Size})
}

func streamBody(rw http.ResponseWriter, r *http.Request) {
	uploadID := r.PathValue("uploadId")
	buf := make([]byte, 32*1024)
	total := 0
	for {
		n, err := r.Body.Read(buf)
		total += n
		store.AddBytes(uploadID, n)
		if err != nil {
			break
		}
	}
	writeJSON(rw, http.StatusOK, map[string]int{"received": total})
}

func finalizeUpload(rw http.ResponseWriter, r *http.Request) {
	uploadID := r.PathValue("uploadId")
	store.Finalize(uploadID, "application/octet-stream", 0)
	writeJSON(rw, http.StatusOK, map[string]any{"file_id": "f_" + uploadID})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/files", initiate)
	mux.HandleFunc("PUT /v1/uploads/{uploadId}", streamBody)
	mux.HandleFunc("POST /v1/uploads/{uploadId}/finalize", finalizeUpload)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"encoding/json"
	"log"
	"net/http"
)

const MaxUploadBytes = 5 << 30

var AllowedMime = map[string]bool{
	"image/png": true, "image/jpeg": true, "application/pdf": true, "text/plain": true,
}

func SniffMime(head []byte) string {
	if len(head) >= 4 && head[0] == 0x89 && head[1] == 'P' && head[2] == 'N' && head[3] == 'G' {
		return "image/png"
	}
	return "application/octet-stream"
}

type Session struct {
	UploadID     string \`json:"upload_id"\`
	Tenant       string \`json:"tenant"\`
	DeclaredSize int    \`json:"declared_size"\`
	ActualBytes  int    \`json:"actual_bytes"\`
	Mime         string \`json:"mime"\`
}

type UploadStore interface {
	Create(session Session)
	Get(uploadID string) (Session, bool)
	QuotaRemaining(tenant string) int
	AddBytes(uploadID string, n int)
	Abort(uploadID string)
	Finalize(uploadID string, mime string, size int)
}

var store UploadStore

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func initiate(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	var body struct {
		Size int    \`json:"size"\`
		Mime string \`json:"mime"\`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if body.Size <= 0 || body.Size > MaxUploadBytes {
		writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]string{"error": "size out of range"})
		return
	}
	if !AllowedMime[body.Mime] {
		writeJSON(rw, http.StatusUnsupportedMediaType, map[string]string{"error": "mime not allowed"})
		return
	}
	if body.Size > store.QuotaRemaining(tenant) {
		writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]string{"error": "quota exceeded"})
		return
	}
	session := Session{
		UploadID:     "up_" + tenant + "_" + uuidString(),
		Tenant:       tenant,
		DeclaredSize: body.Size,
		Mime:         body.Mime,
	}
	store.Create(session)
	writeJSON(rw, http.StatusCreated, map[string]any{"upload_id": session.UploadID, "declared_size": session.DeclaredSize})
}

func streamBody(rw http.ResponseWriter, r *http.Request) {
	uploadID := r.PathValue("uploadId")
	tenant := r.Header.Get("X-Tenant-Id")
	session, ok := store.Get(uploadID)
	if !ok {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown upload"})
		return
	}
	if session.Tenant != tenant {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}
	written := 0
	buf := make([]byte, 32*1024)
	for {
		n, err := r.Body.Read(buf)
		written += n
		if written > session.DeclaredSize {
			store.Abort(uploadID)
			writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]string{"error": "stream exceeds declared size"})
			return
		}
		store.AddBytes(uploadID, n)
		if err != nil {
			break
		}
	}
	writeJSON(rw, http.StatusOK, map[string]int{"received": written})
}

func finalizeUpload(rw http.ResponseWriter, r *http.Request) {
	uploadID := r.PathValue("uploadId")
	tenant := r.Header.Get("X-Tenant-Id")
	session, ok := store.Get(uploadID)
	if !ok {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown upload"})
		return
	}
	if session.Tenant != tenant {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "forbidden"})
		return
	}
	var body struct {
		HeadHex string \`json:"head_hex"\`
	}
	json.NewDecoder(r.Body).Decode(&body)
	mime := SniffMime(decodeHex(body.HeadHex))
	if session.ActualBytes != session.DeclaredSize {
		writeJSON(rw, http.StatusConflict, map[string]string{"error": "size mismatch"})
		return
	}
	store.Finalize(uploadID, mime, session.ActualBytes)
	writeJSON(rw, http.StatusOK, map[string]any{"file_id": "f_" + uploadID, "mime": mime})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/files", initiate)
	mux.HandleFunc("PUT /v1/uploads/{uploadId}", streamBody)
	mux.HandleFunc("POST /v1/uploads/{uploadId}/finalize", finalizeUpload)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class InitiateRequest(size: Long, mime: String)

object UploadApi {
  implicit val system: ActorSystem = ActorSystem("file-storage")
  implicit val initiateFormat: RootJsonFormat[InitiateRequest] = jsonFormat2(InitiateRequest)

  val store = UploadStore.open()

  val route: Route =
    path("v1" / "files") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          entity(as[InitiateRequest]) { body =>
            if (!tenantOpt.exists(_.nonEmpty)) {
              complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
            } else {
              // TODO: this draft trusts the declared size, sniffs no mime and stores no tenant
              // on the session. The quota is never read and a stream may run past its size.
              val uploadId = "up_" + UUID.randomUUID().toString
              store.create(Session(uploadId, "", body.size, 0, body.mime))
              complete(StatusCodes.Created, """{"upload_id":""" + uploadId + """}""")
            }
          }
        }
      }
    } ~
    path("v1" / "uploads" / Segment) { uploadId =>
      put {
        entity(as[String]) { _ =>
          store.finalize(uploadId, "application/octet-stream", 0)
          complete(StatusCodes.OK, """{"file_id":""" + uploadId + """}""")
        }
      }
    } ~
    path("v1" / "uploads" / Segment / "finalize") { uploadId =>
      post {
        store.finalize(uploadId, "application/octet-stream", 0)
        complete(StatusCodes.OK, """{"file_id":""" + uploadId + """}""")
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class InitiateRequest(size: Long, mime: String)
final case class Session(uploadId: String, tenant: String, declaredSize: Long, actualBytes: Long, mime: String)
final case class UploadCreated(upload_id: String, declared_size: Long)

object UploadApi {
  implicit val system: ActorSystem = ActorSystem("file-storage")
  implicit val initiateFormat: RootJsonFormat[InitiateRequest] = jsonFormat2(InitiateRequest)
  implicit val createdFormat: RootJsonFormat[UploadCreated] = jsonFormat2(UploadCreated)

  val MaxUploadBytes = 5L << 30
  val AllowedMime = Set("image/png", "image/jpeg", "application/pdf", "text/plain")

  val store = UploadStore.open()

  def sniffMime(head: Array[Byte]): String =
    if (head.length >= 4 && head(0) == 0x89.toByte) "image/png" else "application/octet-stream"

  val route: Route =
    path("v1" / "files") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          entity(as[InitiateRequest]) { body =>
            if (!tenantOpt.exists(_.nonEmpty)) {
              complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
            } else if (body.size <= 0 || body.size > MaxUploadBytes) {
              complete(StatusCodes.RequestEntityTooLarge, """{"error":"size out of range"}""")
            } else if (!AllowedMime.contains(body.mime)) {
              complete(StatusCodes.UnsupportedMediaType, """{"error":"mime not allowed"}""")
            } else if (body.size > store.quotaRemaining(tenantOpt.get)) {
              complete(StatusCodes.RequestEntityTooLarge, """{"error":"quota exceeded"}""")
            } else {
              val tenant = tenantOpt.get
              val session = Session("up_" + tenant + "_" + UUID.randomUUID().toString, tenant, body.size, 0, body.mime)
              store.create(session)
              complete(StatusCodes.Created, UploadCreated(session.uploadId, session.declaredSize))
            }
          }
        }
      }
    } ~
    path("v1" / "uploads" / Segment) { uploadId =>
      put {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          entity(as[String]) { body =>
            store.get(uploadId) match {
              case None =>
                complete(StatusCodes.NotFound, """{"error":"unknown upload"}""")
              case Some(session) if session.tenant != tenantOpt.getOrElse("") =>
                complete(StatusCodes.Forbidden, """{"error":"forbidden"}""")
              case Some(session) =>
                if (body.length > session.declaredSize) {
                  store.abort(uploadId)
                  complete(StatusCodes.RequestEntityTooLarge, """{"error":"stream exceeds declared size"}""")
                } else {
                  store.addBytes(uploadId, body.length)
                  complete(StatusCodes.OK, """{"received":true}""")
                }
            }
          }
        }
      }
    } ~
    path("v1" / "uploads" / Segment / "finalize") { uploadId =>
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          entity(as[String]) { _ =>
            store.get(uploadId) match {
              case None =>
                complete(StatusCodes.NotFound, """{"error":"unknown upload"}""")
              case Some(session) if session.tenant != tenantOpt.getOrElse("") =>
                complete(StatusCodes.Forbidden, """{"error":"forbidden"}""")
              case Some(session) =>
                val mime = sniffMime(Array[Byte](0))
                if (session.actualBytes != session.declaredSize) {
                  complete(StatusCodes.Conflict, """{"error":"size mismatch"}""")
                } else {
                  store.finalize(uploadId, mime, session.actualBytes)
                  complete(StatusCodes.OK, """{"file_id":""" + uploadId + """}""")
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
  void create(const std::string& uploadId, long size, const std::string& mime);
  void finalize(const std::string& uploadId, const std::string& mime, long size);
};

UploadStore store;

int main() {
  httplib::Server svr;

  svr.Post("/v1/files", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    // TODO: this draft trusts the declared size, sniffs no mime and stores no tenant on the
    // session. The quota is never read and a stream may run past its declared size.
    const auto uploadId = "up_" + uuidString();
    store.create(uploadId, body.value("size", 0L), body.value("mime", std::string()));
    res.status = 201;
    res.set_content(json{{"upload_id", uploadId}, {"size", body.value("size", 0L)}}.dump(), "application/json");
  });

  svr.Put("/v1/uploads/([^/]+)", [](const httplib::Request& req, httplib::Response& res) {
    store.finalize(req.matches[1], "application/octet-stream", 0);
    res.status = 200;
  });

  svr.Post("/v1/uploads/([^/]+)/finalize", [](const httplib::Request& req, httplib::Response& res) {
    store.finalize(req.matches[1], "application/octet-stream", 0);
    res.status = 200;
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <map>
#include <optional>
#include <string>

using json = nlohmann::json;

constexpr long kMaxUploadBytes = 5L << 30;
const std::map<std::string, bool> kAllowedMime = {
    {"image/png", true}, {"image/jpeg", true}, {"application/pdf", true}, {"text/plain", true}};

std::string sniffMime(const std::string& head) {
  if (head.size() >= 4 && static_cast<unsigned char>(head[0]) == 0x89) return "image/png";
  return "application/octet-stream";
}

struct Session {
  std::string uploadId;
  std::string tenant;
  long declaredSize = 0;
  long actualBytes = 0;
  std::string mime;
};

struct UploadStore {
  void create(const Session& session);
  std::optional<Session> get(const std::string& uploadId);
  long quotaRemaining(const std::string& tenant);
  void addBytes(const std::string& uploadId, long n);
  void abort(const std::string& uploadId);
  void finalize(const std::string& uploadId, const std::string& mime, long size);
};

UploadStore store;
std::string uuidString();

int main() {
  httplib::Server svr;

  svr.Post("/v1/files", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    const long size = body.value("size", 0L);
    const auto mime = body.value("mime", std::string());
    if (size <= 0 || size > kMaxUploadBytes) {
      res.status = 413;
      res.set_content(R"({"error":"size out of range"})", "application/json");
      return;
    }
    if (kAllowedMime.count(mime) == 0) {
      res.status = 415;
      res.set_content(R"({"error":"mime not allowed"})", "application/json");
      return;
    }
    if (size > store.quotaRemaining(tenant)) {
      res.status = 413;
      res.set_content(R"({"error":"quota exceeded"})", "application/json");
      return;
    }
    Session session;
    session.uploadId = "up_" + tenant + "_" + uuidString();
    session.tenant = tenant;
    session.declaredSize = size;
    session.mime = mime;
    store.create(session);
    res.status = 201;
    res.set_content(
        json{{"upload_id", session.uploadId}, {"declared_size", session.declaredSize}}.dump(), "application/json");
  });

  svr.Put("/v1/uploads/([^/]+)", [](const httplib::Request& req, httplib::Response& res) {
    const auto found = store.get(req.matches[1]);
    if (!found) {
      res.status = 404;
      return;
    }
    const Session& session = *found;
    if (session.tenant != req.get_header_value("X-Tenant-Id")) {
      res.status = 403;
      return;
    }
    if (static_cast<long>(req.body.size()) > session.declaredSize) {
      store.abort(session.uploadId);
      res.status = 413;
      res.set_content(R"({"error":"stream exceeds declared size"})", "application/json");
      return;
    }
    store.addBytes(session.uploadId, static_cast<long>(req.body.size()));
    res.status = 200;
  });

  svr.Post("/v1/uploads/([^/]+)/finalize", [](const httplib::Request& req, httplib::Response& res) {
    const auto found = store.get(req.matches[1]);
    if (!found) {
      res.status = 404;
      return;
    }
    const Session& session = *found;
    if (session.tenant != req.get_header_value("X-Tenant-Id")) {
      res.status = 403;
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    const auto mime = sniffMime(body.value("head_hex", std::string()));
    if (session.actualBytes != session.declaredSize) {
      res.status = 409;
      return;
    }
    store.finalize(session.uploadId, mime, session.actualBytes);
    res.status = 200;
    res.set_content(json{{"file_id", "f_" + session.uploadId}, {"mime", mime}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Write the guard clauses in cost order: tenant, size range, mime allowlist, quota. Each one returns before the session exists, so a malformed declaration cannot reserve anything.',
    'The declared size is a promise, not a fact. Count bytes as the stream arrives and abort the moment the count passes the declaration — otherwise the client decides how much it stores and how much quota it spends.',
    'The finalize response records the type sniffed from the leading bytes. If the object says `image/png` but the magic bytes say `%PDF`, the sniffed type is the truth you store and index on.',
  ],
  debrief: `The interviewer is testing whether you can review a generated upload handshake at the trust boundary. The draft reads fine because the demo declares an honest size, sends a friendly mime, and never leaks an upload id. Three separate defects are being checked: the declared size is verified against the stream rather than trusted; the mime is sniffed rather than echoed; and the upload id is bound to its tenant so a leaked id is not a capability. Real services add a per-tenant quota reservation that is released on abort, a pre-signed URL with a short TTL so the API never proxies the bytes, and an object-store-side size check so a bypassed API cannot store more than it promised.`,
};
