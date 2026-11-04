import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/files: a declared size and type the bytes must match',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'redis'],
  task: `## Task

**Starting point.** The starter serves the upload API on \`files.sessions\` (step 2) and \`files.store\`
(provided): \`POST /v1/files\` with \`X-Tenant-Id\` and \`{size, mime, name}\` opens a session through
\`sessions.open_session\` and answers 201 \`{upload_id, declared_size}\` (413 over quota);
\`PUT /v1/uploads/{upload_id}/parts/{n}\` takes the part as \`application/octet-stream\`, stages it with
\`store.stage_part\` and counts it with \`sessions.ack_part\`. It serves the demo and hides three flaws.

**Failure mode the checks target.** A tenant who learns another tenant's upload id writes into it; a
client declares zero bytes, or 4 KiB and then sends far more; and an executable declared as
\`image/png\` is stored as a PNG.

- A missing \`X-Tenant-Id\` is **401**; a part sent by a tenant other than the session's is **403**.
- \`size\` is an integer from 1 to \`MAX_UPLOAD_BYTES\` (5 GiB), else **413**; a part that would take
  \`actual_bytes\` past \`declared_size\` is **413** (a retried part replaces its earlier count).
- \`mime\` must be in \`ALLOWED_MIME\`, else **415**; part 1's leading bytes must sniff
  (\`store.sniff_mime\`) to the declared mime, else **415**.
- A refused part is neither staged nor counted.`,
  sequence: {
    participants: ['Client', 'Upload API', 'Redis'],
    messages: [
      {from: 'Client', to: 'Upload API', label: 'POST /v1/files · X-Tenant-Id · {size, mime, name}', kind: 'sync'},
      {from: 'Upload API', to: 'Upload API', label: '1 ≤ size ≤ 5 GiB · mime in ALLOWED_MIME', kind: 'sync'},
      {from: 'Upload API', to: 'Redis', label: 'open_session → reserve quota', kind: 'sync'},
      {from: 'Upload API', to: 'Client', label: '201 {upload_id, declared_size}', kind: 'reply'},
      {from: 'Client', to: 'Upload API', label: 'PUT /v1/uploads/{id}/parts/1 · bytes', kind: 'sync'},
      {
        from: 'Upload API',
        to: 'Upload API',
        label: "session's tenant · sniff part 1 · fits the declaration",
        kind: 'sync',
      },
      {from: 'Upload API', to: 'Redis', label: 'stage_part · ack_part', kind: 'sync'},
      {from: 'Upload API', to: 'Client', label: '200 {part, actual_bytes}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Registers the upload and part routes',
      detail: 'Register `POST /v1/files` and `PUT /v1/uploads/{upload_id}/parts/{n}`.',
      match: {
        python: {
          all: [
            /@app\.post\(\s*["']\/v1\/files["']/,
            /@app\.put\(\s*["']\/v1\/uploads\/\{upload_id\}\/parts\/\{n\}["']/,
          ],
        },
        typescript: {
          all: [/app\.post\(\s*['"]\/v1\/files['"]/, /app\.put\(\s*['"]\/v1\/uploads\/:uploadId\/parts\/:n['"]/],
        },
        go: {all: [/HandleFunc\(\s*"POST \/v1\/files"/, /HandleFunc\(\s*"PUT \/v1\/uploads\/\{id\}\/parts\/\{n\}"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"files"\s*\)/, /"uploads"\s*\/\s*Segment\s*\/\s*"parts"\s*\/\s*IntNumber/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/files"/, /svr\.Put\(\s*R"\(\/v1\/uploads\//]},
      },
    },
    {
      id: 'tenant-scope',
      title: "A part is accepted only from the session's tenant",
      detail:
        "The part route compares the caller's `X-Tenant-Id` with the session's tenant and answers **403** on a mismatch; an upload id alone is not a credential.",
      match: {
        python: {
          all: [
            /session\[["']tenant["']\]\s*!=\s*tenant|tenant\s*!=\s*session\[["']tenant["']\]/,
            /status_code\s*=\s*403/,
          ],
        },
        typescript: {all: [/session\.tenant\s*!==?\s*tenant|tenant\s*!==?\s*session\.tenant/, /code\(\s*403\s*\)/]},
        go: {all: [/session\.Tenant\s*!=\s*tenant|tenant\s*!=\s*session\.Tenant/, /StatusForbidden/]},
        scala: {all: [/session\.tenant\s*!=\s*tenant|tenant\s*!=\s*session\.tenant/, /StatusCodes\.Forbidden/]},
        cpp: {all: [/session->tenant\s*!=\s*tenant|tenant\s*!=\s*session->tenant/, /\b403\b/]},
      },
    },
    {
      id: 'declared-size',
      title: 'Bounds the declaration and holds the parts to it',
      detail:
        'The declared size is checked against 1 and `MAX_UPLOAD_BYTES` before a session opens (**413**), and a part that would take the session past its `declared_size` is refused with **413** before it is staged.',
      match: {
        python: {all: [/store\.MAX_UPLOAD_BYTES/, /session\[["']declared_size["']\]/]},
        typescript: {all: [/store\.MAX_UPLOAD_BYTES/, /session\.declared_size/]},
        go: {all: [/store\.MaxUploadBytes/, /session\.DeclaredSize/]},
        scala: {all: [/Store\.MaxUploadBytes/, /session\.declaredSize/]},
        cpp: {all: [/store::kMaxUploadBytes/, /session->declared_size/]},
      },
    },
    {
      id: 'mime-sniff',
      title: 'Allowlists the declared type and sniffs the bytes',
      detail:
        'A declared mime outside `ALLOWED_MIME` is **415**, and part 1 is sniffed (`sniff_mime`) and refused with **415** when its bytes are not the declared type.',
      match: {
        python: {all: [/store\.ALLOWED_MIME/, /store\.sniff_mime\(/, /status_code\s*=\s*415/]},
        typescript: {all: [/store\.ALLOWED_MIME/, /store\.sniffMime\(/, /code\(\s*415\s*\)/]},
        go: {all: [/store\.AllowedMime/, /store\.SniffMime\(/, /StatusUnsupportedMediaType/]},
        scala: {all: [/Store\.AllowedMime/, /Store\.sniffMime\(/, /StatusCodes\.UnsupportedMediaType/]},
        cpp: {all: [/store::kAllowedMime/, /store::sniffMime\(/, /\b415\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException, Request

from files import sessions, store  # sessions.open_session, find_session, ack_part; store.stage_part, sniff_mime, MAX_UPLOAD_BYTES, ALLOWED_MIME

app = FastAPI()


def _tenant(request: Request) -> str:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    return tenant


@app.post("/v1/files", status_code=201)
async def create_upload(request: Request) -> dict:
    tenant = _tenant(request)
    body = await request.json()
    size, mime = body.get("size"), body.get("mime")
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    upload_id = sessions.open_session(tenant, size, mime, body.get("name", ""))
    if upload_id is None:
        raise HTTPException(status_code=413, detail="the upload does not fit the tenant's quota")
    return {"upload_id": upload_id, "declared_size": size}


@app.put("/v1/uploads/{upload_id}/parts/{n}")
async def put_part(upload_id: str, n: int, request: Request) -> dict:
    tenant = _tenant(request)
    session = sessions.find_session(upload_id)
    if session is None:
        raise HTTPException(status_code=404, detail="no such upload")
    data = await request.body()
    store.stage_part(upload_id, n, data)
    return {"part": n, "actual_bytes": sessions.ack_part(upload_id, n, len(data))}
`,
      solution: `from fastapi import FastAPI, HTTPException, Request

from files import sessions, store  # sessions.open_session, find_session, ack_part; store.stage_part, sniff_mime, MAX_UPLOAD_BYTES, ALLOWED_MIME

app = FastAPI()


def _tenant(request: Request) -> str:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    return tenant


@app.post("/v1/files", status_code=201)
async def create_upload(request: Request) -> dict:
    tenant = _tenant(request)
    body = await request.json()
    size, mime = body.get("size"), body.get("mime")
    if type(size) is not int or not 1 <= size <= store.MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail=f"size must be an integer from 1 to {store.MAX_UPLOAD_BYTES}")
    if mime not in store.ALLOWED_MIME:
        raise HTTPException(status_code=415, detail=f"{mime} is not an accepted type")
    upload_id = sessions.open_session(tenant, size, mime, body.get("name", ""))
    if upload_id is None:
        raise HTTPException(status_code=413, detail="the upload does not fit the tenant's quota")
    return {"upload_id": upload_id, "declared_size": size}


@app.put("/v1/uploads/{upload_id}/parts/{n}")
async def put_part(upload_id: str, n: int, request: Request) -> dict:
    tenant = _tenant(request)
    session = sessions.find_session(upload_id)
    if session is None:
        raise HTTPException(status_code=404, detail="no such upload")
    if session["tenant"] != tenant:
        raise HTTPException(status_code=403, detail="this upload belongs to another tenant")
    data = await request.body()
    # A retried part replaces its earlier count; the total may not pass the declaration.
    if session["actual_bytes"] - session["parts"].get(n, 0) + len(data) > session["declared_size"]:
        raise HTTPException(status_code=413, detail="the parts exceed the declared size")
    if n == 1 and store.sniff_mime(data[:16]) != session["mime"]:
        raise HTTPException(status_code=415, detail=f"the bytes are not {session['mime']}")
    store.stage_part(upload_id, n, data)
    return {"part": n, "actual_bytes": sessions.ack_part(upload_id, n, len(data))}
`,
    },
    typescript: {
      starter: `import Fastify, {type FastifyReply, type FastifyRequest} from 'fastify';

import * as sessions from 'files/sessions'; // openSession, findSession, ackPart
import * as store from 'files/store'; // stagePart, sniffMime, MAX_UPLOAD_BYTES, ALLOWED_MIME

export const app = Fastify();
app.addContentTypeParser('application/octet-stream', {parseAs: 'buffer'}, (_request, body, done) => done(null, body));

function tenantOf(request: FastifyRequest, reply: FastifyReply): string | null {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant === 'string' && tenant !== '') return tenant;
  void reply.code(401).send({error: 'X-Tenant-Id is required'});
  return null;
}

app.post('/v1/files', async (request, reply) => {
  const tenant = tenantOf(request, reply);
  if (tenant === null) return reply;
  const {size, mime, name = ''} = request.body as {size: number; mime: string; name?: string};
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const uploadId = await sessions.openSession(tenant, size, mime, name);
  if (uploadId === null) return reply.code(413).send({error: "the upload does not fit the tenant's quota"});
  return reply.code(201).send({upload_id: uploadId, declared_size: size});
});

app.put('/v1/uploads/:uploadId/parts/:n', async (request, reply) => {
  const tenant = tenantOf(request, reply);
  if (tenant === null) return reply;
  const {uploadId, n} = request.params as {uploadId: string; n: string};
  const part = Number(n);
  const session = await sessions.findSession(uploadId);
  if (session === null) return reply.code(404).send({error: 'no such upload'});
  const data = request.body as Buffer;
  await store.stagePart(uploadId, part, data);
  return {part, actual_bytes: await sessions.ackPart(uploadId, part, data.length)};
});
`,
      solution: `import Fastify, {type FastifyReply, type FastifyRequest} from 'fastify';

import * as sessions from 'files/sessions'; // openSession, findSession, ackPart
import * as store from 'files/store'; // stagePart, sniffMime, MAX_UPLOAD_BYTES, ALLOWED_MIME

export const app = Fastify();
app.addContentTypeParser('application/octet-stream', {parseAs: 'buffer'}, (_request, body, done) => done(null, body));

function tenantOf(request: FastifyRequest, reply: FastifyReply): string | null {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant === 'string' && tenant !== '') return tenant;
  void reply.code(401).send({error: 'X-Tenant-Id is required'});
  return null;
}

app.post('/v1/files', async (request, reply) => {
  const tenant = tenantOf(request, reply);
  if (tenant === null) return reply;
  const {size, mime, name = ''} = request.body as {size: number; mime: string; name?: string};
  if (!Number.isInteger(size) || size < 1 || size > store.MAX_UPLOAD_BYTES) {
    return reply.code(413).send({error: \`size must be an integer from 1 to \${store.MAX_UPLOAD_BYTES}\`});
  }
  if (!store.ALLOWED_MIME.includes(mime)) return reply.code(415).send({error: \`\${mime} is not an accepted type\`});
  const uploadId = await sessions.openSession(tenant, size, mime, name);
  if (uploadId === null) return reply.code(413).send({error: "the upload does not fit the tenant's quota"});
  return reply.code(201).send({upload_id: uploadId, declared_size: size});
});

app.put('/v1/uploads/:uploadId/parts/:n', async (request, reply) => {
  const tenant = tenantOf(request, reply);
  if (tenant === null) return reply;
  const {uploadId, n} = request.params as {uploadId: string; n: string};
  const part = Number(n);
  const session = await sessions.findSession(uploadId);
  if (session === null) return reply.code(404).send({error: 'no such upload'});
  if (session.tenant !== tenant) return reply.code(403).send({error: 'this upload belongs to another tenant'});
  const data = request.body as Buffer;
  // A retried part replaces its earlier count; the total may not pass the declaration.
  if (session.actual_bytes - (session.parts[part] ?? 0) + data.length > session.declared_size) {
    return reply.code(413).send({error: 'the parts exceed the declared size'});
  }
  if (part === 1 && store.sniffMime(data.subarray(0, 16)) !== session.mime) {
    return reply.code(415).send({error: \`the bytes are not \${session.mime}\`});
  }
  await store.stagePart(uploadId, part, data);
  return {part, actual_bytes: await sessions.ackPart(uploadId, part, data.length)};
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"io"
	"net/http"
	"strconv"

	"files/sessions" // sessions.OpenSession, FindSession, AckPart
	"files/store"    // store.StagePart, SniffMime, MaxUploadBytes, AllowedMime
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func createUpload(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	var body struct {
		Size int64  \`json:"size"\`
		Mime string \`json:"mime"\`
		Name string \`json:"name"\`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, "the body is not an upload declaration", http.StatusBadRequest)
		return
	}
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	uploadID, err := sessions.OpenSession(r.Context(), tenant, body.Size, body.Mime, body.Name)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	if uploadID == "" {
		http.Error(rw, "the upload does not fit the tenant's quota", http.StatusRequestEntityTooLarge)
		return
	}
	writeJSON(rw, http.StatusCreated, map[string]any{"upload_id": uploadID, "declared_size": body.Size})
}

func putPart(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	uploadID := r.PathValue("id")
	n, err := strconv.Atoi(r.PathValue("n"))
	if err != nil || n < 1 {
		http.Error(rw, "the part number is a positive integer", http.StatusBadRequest)
		return
	}
	session, err := sessions.FindSession(r.Context(), uploadID)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	if session == nil {
		http.Error(rw, "no such upload", http.StatusNotFound)
		return
	}
	data, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusBadRequest)
		return
	}
	if err := store.StagePart(r.Context(), uploadID, n, data); err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	actual, err := sessions.AckPart(r.Context(), uploadID, n, int64(len(data)))
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{"part": n, "actual_bytes": actual})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/files", createUpload)
	mux.HandleFunc("PUT /v1/uploads/{id}/parts/{n}", putPart)
}
`,
      solution: `package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"

	"files/sessions" // sessions.OpenSession, FindSession, AckPart
	"files/store"    // store.StagePart, SniffMime, MaxUploadBytes, AllowedMime
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func allowedMime(mime string) bool {
	for _, m := range store.AllowedMime {
		if m == mime {
			return true
		}
	}
	return false
}

func createUpload(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	var body struct {
		Size int64  \`json:"size"\`
		Mime string \`json:"mime"\`
		Name string \`json:"name"\`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, "the body is not an upload declaration", http.StatusBadRequest)
		return
	}
	if body.Size < 1 || body.Size > store.MaxUploadBytes {
		http.Error(rw, fmt.Sprintf("size must be from 1 to %d", store.MaxUploadBytes), http.StatusRequestEntityTooLarge)
		return
	}
	if !allowedMime(body.Mime) {
		http.Error(rw, body.Mime+" is not an accepted type", http.StatusUnsupportedMediaType)
		return
	}
	uploadID, err := sessions.OpenSession(r.Context(), tenant, body.Size, body.Mime, body.Name)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	if uploadID == "" {
		http.Error(rw, "the upload does not fit the tenant's quota", http.StatusRequestEntityTooLarge)
		return
	}
	writeJSON(rw, http.StatusCreated, map[string]any{"upload_id": uploadID, "declared_size": body.Size})
}

func putPart(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	uploadID := r.PathValue("id")
	n, err := strconv.Atoi(r.PathValue("n"))
	if err != nil || n < 1 {
		http.Error(rw, "the part number is a positive integer", http.StatusBadRequest)
		return
	}
	session, err := sessions.FindSession(r.Context(), uploadID)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	if session == nil {
		http.Error(rw, "no such upload", http.StatusNotFound)
		return
	}
	if session.Tenant != tenant {
		http.Error(rw, "this upload belongs to another tenant", http.StatusForbidden)
		return
	}
	data, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusBadRequest)
		return
	}
	// A retried part replaces its earlier count; the total may not pass the declaration.
	if session.ActualBytes-session.Parts[n]+int64(len(data)) > session.DeclaredSize {
		http.Error(rw, "the parts exceed the declared size", http.StatusRequestEntityTooLarge)
		return
	}
	if n == 1 && store.SniffMime(data) != session.Mime {
		http.Error(rw, "the bytes are not "+session.Mime, http.StatusUnsupportedMediaType)
		return
	}
	if err := store.StagePart(r.Context(), uploadID, n, data); err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	actual, err := sessions.AckPart(r.Context(), uploadID, n, int64(len(data)))
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{"part": n, "actual_bytes": actual})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/files", createUpload)
	mux.HandleFunc("PUT /v1/uploads/{id}/parts/{n}", putPart)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import files.{Sessions, Store} // Sessions.openSession, findSession, ackPart; Store.stagePart, sniffMime, MaxUploadBytes, AllowedMime

object Api {
  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private val tenantHeader = optionalHeaderValueByName("X-Tenant-Id")

  val route: Route = concat(
    path("v1" / "files") {
      post {
        tenantHeader {
          case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
          case Some(tenant) =>
            entity(as[String]) { raw =>
              val body = raw.parseJson.asJsObject.fields
              val size = body.get("size").collect { case JsNumber(n) if n.isValidLong => n.toLong }.getOrElse(0L)
              val mime = body.get("mime").collect { case JsString(s) => s }.getOrElse("")
              val name = body.get("name").collect { case JsString(s) => s }.getOrElse("")
              // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
              Sessions.openSession(tenant, size, mime, name) match {
                case None => complete(StatusCodes.PayloadTooLarge -> "the upload does not fit the tenant's quota")
                case Some(uploadId) => complete(json(StatusCodes.Created, JsObject("upload_id" -> JsString(uploadId), "declared_size" -> JsNumber(size))))
              }
            }
        }
      }
    },
    path("v1" / "uploads" / Segment / "parts" / IntNumber) { (uploadId, n) =>
      put {
        tenantHeader {
          case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
          case Some(tenant) =>
            entity(as[Array[Byte]]) { data =>
              Sessions.findSession(uploadId) match {
                case None => complete(StatusCodes.NotFound -> "no such upload")
                case Some(session) =>
                  Store.stagePart(uploadId, n, data)
                  val actual = Sessions.ackPart(uploadId, n, data.length.toLong)
                  complete(json(StatusCodes.OK, JsObject("part" -> JsNumber(n), "actual_bytes" -> JsNumber(actual))))
              }
            }
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

import files.{Sessions, Store} // Sessions.openSession, findSession, ackPart; Store.stagePart, sniffMime, MaxUploadBytes, AllowedMime

object Api {
  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private val tenantHeader = optionalHeaderValueByName("X-Tenant-Id")

  val route: Route = concat(
    path("v1" / "files") {
      post {
        tenantHeader {
          case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
          case Some(tenant) =>
            entity(as[String]) { raw =>
              val body = raw.parseJson.asJsObject.fields
              val size = body.get("size").collect { case JsNumber(n) if n.isValidLong => n.toLong }.getOrElse(0L)
              val mime = body.get("mime").collect { case JsString(s) => s }.getOrElse("")
              val name = body.get("name").collect { case JsString(s) => s }.getOrElse("")
              if (size < 1 || size > Store.MaxUploadBytes) complete(StatusCodes.PayloadTooLarge -> s"size must be an integer from 1 to \${Store.MaxUploadBytes}")
              else if (!Store.AllowedMime.contains(mime)) complete(StatusCodes.UnsupportedMediaType -> s"$mime is not an accepted type")
              else
                Sessions.openSession(tenant, size, mime, name) match {
                  case None => complete(StatusCodes.PayloadTooLarge -> "the upload does not fit the tenant's quota")
                  case Some(uploadId) => complete(json(StatusCodes.Created, JsObject("upload_id" -> JsString(uploadId), "declared_size" -> JsNumber(size))))
                }
            }
        }
      }
    },
    path("v1" / "uploads" / Segment / "parts" / IntNumber) { (uploadId, n) =>
      put {
        tenantHeader {
          case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
          case Some(tenant) =>
            entity(as[Array[Byte]]) { data =>
              Sessions.findSession(uploadId) match {
                case None => complete(StatusCodes.NotFound -> "no such upload")
                case Some(session) if session.tenant != tenant => complete(StatusCodes.Forbidden -> "this upload belongs to another tenant")
                // A retried part replaces its earlier count; the total may not pass the declaration.
                case Some(session) if session.actualBytes - session.parts.getOrElse(n, 0L) + data.length > session.declaredSize =>
                  complete(StatusCodes.PayloadTooLarge -> "the parts exceed the declared size")
                case Some(session) if n == 1 && Store.sniffMime(data.take(16)) != session.mime =>
                  complete(StatusCodes.UnsupportedMediaType -> s"the bytes are not \${session.mime}")
                case Some(_) =>
                  Store.stagePart(uploadId, n, data)
                  val actual = Sessions.ackPart(uploadId, n, data.length.toLong)
                  complete(json(StatusCodes.OK, JsObject("part" -> JsNumber(n), "actual_bytes" -> JsNumber(actual))))
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

#include "files/sessions.h"  // sessions::openSession, findSession, ackPart
#include "files/store.h"     // store::stagePart, sniffMime, kMaxUploadBytes, kAllowedMime

using json = nlohmann::json;

void send_error(httplib::Response& res, int status, const std::string& message) {
  res.status = status;
  res.set_content(json{{"error", message}}.dump(), "application/json");
}

void create_upload(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return send_error(res, 401, "X-Tenant-Id is required");
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return send_error(res, 400, "the body is not an upload declaration");
  const long long size = body.value("size", 0LL);
  const std::string mime = body.value("mime", "");
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const auto upload_id = sessions::openSession(tenant, size, mime, body.value("name", ""));
  if (!upload_id) return send_error(res, 413, "the upload does not fit the tenant's quota");
  res.status = 201;
  res.set_content(json{{"upload_id", *upload_id}, {"declared_size", size}}.dump(), "application/json");
}

void put_part(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return send_error(res, 401, "X-Tenant-Id is required");
  const std::string upload_id = req.matches[1];
  const int n = std::stoi(req.matches[2]);
  const auto session = sessions::findSession(upload_id);
  if (!session) return send_error(res, 404, "no such upload");
  store::stagePart(upload_id, n, req.body);
  const long long actual = sessions::ackPart(upload_id, n, static_cast<long long>(req.body.size()));
  res.set_content(json{{"part", n}, {"actual_bytes", actual}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/files", create_upload);
  svr.Put(R"(/v1/uploads/([\\w-]+)/parts/(\\d+))", put_part);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <string>

#include "files/sessions.h"  // sessions::openSession, findSession, ackPart
#include "files/store.h"     // store::stagePart, sniffMime, kMaxUploadBytes, kAllowedMime

using json = nlohmann::json;

void send_error(httplib::Response& res, int status, const std::string& message) {
  res.status = status;
  res.set_content(json{{"error", message}}.dump(), "application/json");
}

void create_upload(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return send_error(res, 401, "X-Tenant-Id is required");
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return send_error(res, 400, "the body is not an upload declaration");
  const long long size = body.value("size", 0LL);
  const std::string mime = body.value("mime", "");
  if (!body.contains("size") || !body["size"].is_number_integer() || size < 1 || size > store::kMaxUploadBytes) {
    return send_error(res, 413, "size must be an integer from 1 to " + std::to_string(store::kMaxUploadBytes));
  }
  if (std::find(store::kAllowedMime.begin(), store::kAllowedMime.end(), mime) == store::kAllowedMime.end()) {
    return send_error(res, 415, mime + " is not an accepted type");
  }
  const auto upload_id = sessions::openSession(tenant, size, mime, body.value("name", ""));
  if (!upload_id) return send_error(res, 413, "the upload does not fit the tenant's quota");
  res.status = 201;
  res.set_content(json{{"upload_id", *upload_id}, {"declared_size", size}}.dump(), "application/json");
}

void put_part(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return send_error(res, 401, "X-Tenant-Id is required");
  const std::string upload_id = req.matches[1];
  const int n = std::stoi(req.matches[2]);
  const auto session = sessions::findSession(upload_id);
  if (!session) return send_error(res, 404, "no such upload");
  if (session->tenant != tenant) return send_error(res, 403, "this upload belongs to another tenant");
  // A retried part replaces its earlier count; the total may not pass the declaration.
  const long long earlier = session->parts.count(n) ? session->parts.at(n) : 0;
  if (session->actual_bytes - earlier + static_cast<long long>(req.body.size()) > session->declared_size) {
    return send_error(res, 413, "the parts exceed the declared size");
  }
  if (n == 1 && store::sniffMime(req.body.substr(0, 16)) != session->mime) return send_error(res, 415, "the bytes are not " + session->mime);
  store::stagePart(upload_id, n, req.body);
  const long long actual = sessions::ackPart(upload_id, n, static_cast<long long>(req.body.size()));
  res.set_content(json{{"part", n}, {"actual_bytes", actual}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/files", create_upload);
  svr.Put(R"(/v1/uploads/([\\w-]+)/parts/(\\d+))", put_part);
}
`,
    },
  },
  harness: {
    python: `from files import sessions, store

PNG = b"\\x89PNG\\r\\n\\x1a\\n" + bytes(24)  # 32 bytes that sniff as image/png
EXE = b"MZ\\x90\\x00" + bytes(28)  # 32 bytes of a Windows executable


def _api(ctx):
    return ctx.client(ctx.load("api").app)


async def _open(c, tenant="t1", size=64, mime="image/png"):
    headers = {"X-Tenant-Id": tenant} if tenant else {}
    return await c.post("/v1/files", json={"size": size, "mime": mime, "name": "holiday.png"}, headers=headers)


async def _opened(c, size=64, mime="image/png"):
    r = await _open(c, size=size, mime=mime)
    assert r.status_code == 201, f"POST /v1/files (size {size}, {mime}) answered {r.status_code}: {r.text}"
    return r.json()["upload_id"]


async def _put(c, upload_id, n, data, tenant="t1"):
    return await c.put(f"/v1/uploads/{upload_id}/parts/{n}", content=data, headers={"X-Tenant-Id": tenant, "Content-Type": "application/octet-stream"})


def _actual(upload_id):
    session = sessions.find_session(upload_id)
    return None if session is None else session["actual_bytes"]


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await _open(c)
        assert r.status_code == 201, f"POST /v1/files answered {r.status_code}: {r.text}"
        body = r.json()
        assert body.get("declared_size") == 64 and body.get("upload_id"), f"the upload must answer upload_id and declared_size 64, got {body}"
        upload_id = body["upload_id"]
        first = await _put(c, upload_id, 1, PNG)
        assert first.status_code == 200 and first.json().get("actual_bytes") == 32, f"part 1 (32 bytes) answered {first.status_code} {first.text}, expected 200 with actual_bytes 32"
        second = await _put(c, upload_id, 2, bytes(32))
        assert second.status_code == 200 and second.json().get("actual_bytes") == 64, f"part 2 (32 bytes) answered {second.status_code} {second.text}, expected 200 with actual_bytes 64"
    staged = store.staged_parts(upload_id)
    assert staged == [(1, PNG), (2, bytes(32))], f"the staged parts are {[(n, len(b)) for n, b in staged]}, expected parts 1 and 2 of 32 bytes"


async def check_tenant_scope(ctx):
    async with _api(ctx) as c:
        r = await _open(c, tenant="")
        assert r.status_code == 401, f"POST /v1/files without X-Tenant-Id answered {r.status_code}, expected 401"
        upload_id = await _opened(c)
        foreign = await _put(c, upload_id, 1, PNG, tenant="t2")
        assert foreign.status_code == 403, f"tenant t2 sent a part of t1's upload {upload_id} and got {foreign.status_code}: an upload id is not a credential, expected 403"
        assert store.staged_parts(upload_id) == [] and _actual(upload_id) == 0, f"t2's part was staged or counted (actual_bytes {_actual(upload_id)})"
        own = await _put(c, upload_id, 1, PNG)
        assert own.status_code == 200, f"t1's own part answered {own.status_code}: {own.text}"


async def check_declared_size(ctx):
    ctx.redis.set("quota:limit:t1", 10 << 30)  # room beyond the 5 GiB cap
    async with _api(ctx) as c:
        for size in (0, -5, store.MAX_UPLOAD_BYTES + 1):
            r = await _open(c, size=size)
            assert r.status_code == 413, f"a declared size of {size} answered {r.status_code}, expected 413 (1 to 5 GiB)"
        assert ctx.redis.keys("session:*") == [], f"a refused declaration opened {ctx.redis.keys('session:*')}"
        upload_id = await _opened(c, size=40)
        assert (await _put(c, upload_id, 1, PNG)).status_code == 200, "part 1 (32 of 40 declared bytes) must be accepted"
        over = await _put(c, upload_id, 2, bytes(16))
        assert over.status_code == 413, f"part 2 would take a 40-byte upload to 48 bytes and answered {over.status_code}, expected 413"
        assert _actual(upload_id) == 32 and len(store.staged_parts(upload_id)) == 1, f"the refused part was staged or counted (actual_bytes {_actual(upload_id)})"
        fits = await _put(c, upload_id, 2, bytes(8))
        assert fits.status_code == 200 and _actual(upload_id) == 40, f"an 8-byte part 2 fits the declaration and answered {fits.status_code} {fits.text}"
        retry = await _put(c, upload_id, 2, bytes(8))
        assert retry.status_code == 200, f"a retried part 2 replaces its earlier count and must be accepted, got {retry.status_code}: {retry.text}"


async def check_mime_sniff(ctx):
    async with _api(ctx) as c:
        r = await _open(c, mime="application/x-msdownload")
        assert r.status_code == 415, f"a declared mime of application/x-msdownload answered {r.status_code}, expected 415"
        assert ctx.redis.keys("session:*") == [], "a refused mime opened a session"
        upload_id = await _opened(c)
        exe = await _put(c, upload_id, 1, EXE)
        assert exe.status_code == 415, f"an executable sent as part 1 of an image/png upload answered {exe.status_code}, expected 415: sniff the leading bytes"
        assert store.staged_parts(upload_id) == [] and _actual(upload_id) == 0, "the refused executable was staged or counted"
        png = await _put(c, upload_id, 1, PNG)
        assert png.status_code == 200, f"real PNG bytes answered {png.status_code}: {png.text}"
`,
    typescript: `const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24)]);
const EXE = Buffer.concat([Buffer.from([0x4d, 0x5a, 0x90, 0x00]), Buffer.alloc(28)]);

function api(ctx) {
  return {
    c: ctx.client(ctx.load('api').app),
    store: ctx.load('/support/files/store.ts'),
    sessions: ctx.load('/support/files/sessions.ts'),
  };
}

const open = (c, {tenant = 't1', size = 64, mime = 'image/png'} = {}) =>
  c.post('/v1/files', {json: {size, mime, name: 'holiday.png'}, headers: tenant ? {'X-Tenant-Id': tenant} : {}});

async function opened(c, size = 64): Promise<string> {
  const r = await open(c, {size});
  assert.equal(r.status, 201, \`POST /v1/files (size \${size}) answered \${r.status}: \${r.text}\`);
  return r.json().upload_id;
}

const put = (c, uploadId: string, n: number, data: Uint8Array, tenant = 't1') =>
  c.put(\`/v1/uploads/\${uploadId}/parts/\${n}\`, {body: data, headers: {'X-Tenant-Id': tenant, 'content-type': 'application/octet-stream'}});

async function actual(sessions, uploadId: string): Promise<number | null> {
  const session = await sessions.findSession(uploadId);
  return session === null ? null : session.actual_bytes;
}

export async function check_route(ctx) {
  const {c, store} = api(ctx);
  const r = await open(c);
  assert.equal(r.status, 201, \`POST /v1/files answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.declared_size === 64 && body.upload_id, \`the upload must answer upload_id and declared_size 64, got \${r.text}\`);
  const first = await put(c, body.upload_id, 1, PNG);
  assert(first.status === 200 && first.json().actual_bytes === 32, \`part 1 (32 bytes) answered \${first.status} \${first.text}, expected 200 with actual_bytes 32\`);
  const second = await put(c, body.upload_id, 2, Buffer.alloc(32));
  assert(second.status === 200 && second.json().actual_bytes === 64, \`part 2 (32 bytes) answered \${second.status} \${second.text}, expected 200 with actual_bytes 64\`);
  const staged = await store.stagedParts(body.upload_id);
  assert(staged.length === 2 && Buffer.compare(staged[0][1], PNG) === 0 && staged[1][1].length === 32, \`the staged parts are \${JSON.stringify(staged.map(([n, b]) => [n, b.length]))}, expected parts 1 and 2 of 32 bytes\`);
}

export async function check_tenant_scope(ctx) {
  const {c, store, sessions} = api(ctx);
  const r = await open(c, {tenant: ''});
  assert.equal(r.status, 401, \`POST /v1/files without X-Tenant-Id answered \${r.status}, expected 401\`);
  const uploadId = await opened(c);
  const foreign = await put(c, uploadId, 1, PNG, 't2');
  assert.equal(foreign.status, 403, \`tenant t2 sent a part of t1's upload \${uploadId} and got \${foreign.status}: an upload id is not a credential, expected 403\`);
  assert((await store.stagedParts(uploadId)).length === 0 && (await actual(sessions, uploadId)) === 0, "t2's part was staged or counted");
  const own = await put(c, uploadId, 1, PNG);
  assert.equal(own.status, 200, \`t1's own part answered \${own.status}: \${own.text}\`);
}

export async function check_declared_size(ctx) {
  const {c, store, sessions} = api(ctx);
  ctx.redis.set('quota:limit:t1', 10 * 1024 ** 3); // room beyond the 5 GiB cap
  for (const size of [0, -5, store.MAX_UPLOAD_BYTES + 1]) {
    const r = await open(c, {size});
    assert.equal(r.status, 413, \`a declared size of \${size} answered \${r.status}, expected 413 (1 to 5 GiB)\`);
  }
  assert.deepStrictEqual(ctx.redis.keys('session:*'), [], 'a refused declaration opened a session');
  const uploadId = await opened(c, 40);
  assert.equal((await put(c, uploadId, 1, PNG)).status, 200, 'part 1 (32 of 40 declared bytes) must be accepted');
  const over = await put(c, uploadId, 2, Buffer.alloc(16));
  assert.equal(over.status, 413, \`part 2 would take a 40-byte upload to 48 bytes and answered \${over.status}, expected 413\`);
  assert((await actual(sessions, uploadId)) === 32 && (await store.stagedParts(uploadId)).length === 1, 'the refused part was staged or counted');
  const fits = await put(c, uploadId, 2, Buffer.alloc(8));
  assert(fits.status === 200 && (await actual(sessions, uploadId)) === 40, \`an 8-byte part 2 fits the declaration and answered \${fits.status} \${fits.text}\`);
  const retry = await put(c, uploadId, 2, Buffer.alloc(8));
  assert.equal(retry.status, 200, \`a retried part 2 replaces its earlier count and must be accepted, got \${retry.status}: \${retry.text}\`);
}

export async function check_mime_sniff(ctx) {
  const {c, store, sessions} = api(ctx);
  const r = await open(c, {mime: 'application/x-msdownload'});
  assert.equal(r.status, 415, \`a declared mime of application/x-msdownload answered \${r.status}, expected 415\`);
  assert.deepStrictEqual(ctx.redis.keys('session:*'), [], 'a refused mime opened a session');
  const uploadId = await opened(c);
  const exe = await put(c, uploadId, 1, EXE);
  assert.equal(exe.status, 415, \`an executable sent as part 1 of an image/png upload answered \${exe.status}, expected 415: sniff the leading bytes\`);
  assert((await store.stagedParts(uploadId)).length === 0 && (await actual(sessions, uploadId)) === 0, 'the refused executable was staged or counted');
  const png = await put(c, uploadId, 1, PNG);
  assert.equal(png.status, 200, \`real PNG bytes answered \${png.status}: \${png.text}\`);
}
`,
    go: `package main

import (
	"bytes"
	"context"
	"fmt"
	"net/http"

	"files/sessions"
	"files/store"

	"leetbuild/harness"
)

var (
	apiBg = context.Background()
	png   = append([]byte("\\x89PNG\\r\\n\\x1a\\n"), make([]byte, 24)...)
	exe   = append([]byte("MZ\\x90\\x00"), make([]byte, 28)...)
)

func api(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func open(c *harness.HTTP, tenant string, size int64, mime string) *harness.Response {
	body := map[string]any{"size": size, "mime": mime, "name": "holiday.png"}
	if tenant == "" {
		return c.Post("/v1/files", body)
	}
	return c.Post("/v1/files", body, "X-Tenant-Id", tenant)
}

func opened(ctx *harness.Ctx, c *harness.HTTP, size int64) string {
	r := open(c, "t1", size, "image/png")
	ctx.Equal(r.Status, 201, "POST /v1/files (size %d) (%s)", size, r.Text())
	var body struct {
		UploadID string \`json:"upload_id"\`
	}
	r.Decode(&body)
	return body.UploadID
}

func put(c *harness.HTTP, uploadID string, n int, data []byte, tenant string) *harness.Response {
	return c.Put(fmt.Sprintf("/v1/uploads/%s/parts/%d", uploadID, n), data, "X-Tenant-Id", tenant, "Content-Type", "application/octet-stream")
}

func actualOf(ctx *harness.Ctx, uploadID string) int64 {
	s, err := sessions.FindSession(apiBg, uploadID)
	ctx.NoError(err, "FindSession(%s) failed", uploadID)
	if s == nil {
		return -1
	}
	return s.ActualBytes
}

func stagedOf(ctx *harness.Ctx, uploadID string) []store.Part {
	parts, err := store.StagedParts(apiBg, uploadID)
	ctx.NoError(err, "StagedParts(%s) failed", uploadID)
	return parts
}

func answered(r *harness.Response) int64 {
	var body struct {
		ActualBytes int64 \`json:"actual_bytes"\`
	}
	r.Decode(&body)
	return body.ActualBytes
}

func CheckRoute(ctx *harness.Ctx) {
	c := api(ctx)
	r := open(c, "t1", 64, "image/png")
	ctx.Equal(r.Status, 201, "POST /v1/files (%s)", r.Text())
	var body struct {
		UploadID     string \`json:"upload_id"\`
		DeclaredSize int64  \`json:"declared_size"\`
	}
	r.Decode(&body)
	ctx.Assert(body.UploadID != "" && body.DeclaredSize == 64, "the upload must answer upload_id and declared_size 64, got %s", r.Text())
	first := put(c, body.UploadID, 1, png, "t1")
	ctx.Assert(first.Status == 200 && answered(first) == 32, "part 1 (32 bytes) answered %d %s, expected 200 with actual_bytes 32", first.Status, first.Text())
	second := put(c, body.UploadID, 2, make([]byte, 32), "t1")
	ctx.Assert(second.Status == 200 && answered(second) == 64, "part 2 (32 bytes) answered %d %s, expected 200 with actual_bytes 64", second.Status, second.Text())
	staged := stagedOf(ctx, body.UploadID)
	ctx.Assert(len(staged) == 2 && bytes.Equal(staged[0].Data, png) && len(staged[1].Data) == 32, "the staged parts are %d, expected parts 1 and 2 of 32 bytes", len(staged))
}

func CheckTenantScope(ctx *harness.Ctx) {
	c := api(ctx)
	ctx.Equal(open(c, "", 64, "image/png").Status, 401, "POST /v1/files without X-Tenant-Id")
	uploadID := opened(ctx, c, 64)
	foreign := put(c, uploadID, 1, png, "t2")
	ctx.Equal(foreign.Status, 403, "tenant t2 sent a part of t1's upload %s: an upload id is not a credential", uploadID)
	ctx.Assert(len(stagedOf(ctx, uploadID)) == 0 && actualOf(ctx, uploadID) == 0, "t2's part was staged or counted (actual_bytes %d)", actualOf(ctx, uploadID))
	own := put(c, uploadID, 1, png, "t1")
	ctx.Equal(own.Status, 200, "t1's own part (%s)", own.Text())
}

func CheckDeclaredSize(ctx *harness.Ctx) {
	c := api(ctx)
	ctx.Redis.Set("quota:limit:t1", fmt.Sprint(int64(10)<<30)) // room beyond the 5 GiB cap
	for _, size := range []int64{0, -5, store.MaxUploadBytes + 1} {
		r := open(c, "t1", size, "image/png")
		ctx.Equal(r.Status, 413, "a declared size of %d must be refused (1 to 5 GiB)", size)
	}
	ctx.Equal(len(ctx.Redis.Keys("session:*")), 0, "a refused declaration must not open a session; the sessions")
	uploadID := opened(ctx, c, 40)
	ctx.Equal(put(c, uploadID, 1, png, "t1").Status, 200, "part 1 (32 of 40 declared bytes)")
	over := put(c, uploadID, 2, make([]byte, 16), "t1")
	ctx.Equal(over.Status, 413, "part 2 would take a 40-byte upload to 48 bytes")
	ctx.Assert(actualOf(ctx, uploadID) == 32 && len(stagedOf(ctx, uploadID)) == 1, "the refused part was staged or counted (actual_bytes %d)", actualOf(ctx, uploadID))
	fits := put(c, uploadID, 2, make([]byte, 8), "t1")
	ctx.Assert(fits.Status == 200 && actualOf(ctx, uploadID) == 40, "an 8-byte part 2 fits the declaration and answered %d %s", fits.Status, fits.Text())
	retry := put(c, uploadID, 2, make([]byte, 8), "t1")
	ctx.Equal(retry.Status, 200, "a retried part 2 replaces its earlier count and must be accepted (%s)", retry.Text())
}

func CheckMimeSniff(ctx *harness.Ctx) {
	c := api(ctx)
	ctx.Equal(open(c, "t1", 64, "application/x-msdownload").Status, 415, "a declared mime of application/x-msdownload")
	ctx.Equal(len(ctx.Redis.Keys("session:*")), 0, "a refused mime must not open a session; the sessions")
	uploadID := opened(ctx, c, 64)
	ctx.Equal(put(c, uploadID, 1, exe, "t1").Status, 415, "an executable sent as part 1 of an image/png upload (sniff the leading bytes)")
	ctx.Assert(len(stagedOf(ctx, uploadID)) == 0 && actualOf(ctx, uploadID) == 0, "the refused executable was staged or counted")
	pngPart := put(c, uploadID, 1, png, "t1")
	ctx.Equal(pngPart.Status, 200, "real PNG bytes (%s)", pngPart.Text())
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <string>

#include "files/sessions.h"
#include "files/store.h"

namespace {

const std::string kPng = std::string("\\x89PNG\\r\\n\\x1a\\n", 8) + std::string(24, '\\0');
const std::string kExe = std::string("MZ\\x90\\0", 4) + std::string(28, '\\0');

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response open(harness::HTTP& c, const std::string& tenant, long long size, const std::string& mime) {
  const std::string body = nlohmann::json{{"size", size}, {"mime", mime}, {"name", "holiday.png"}}.dump();
  if (tenant.empty()) return c.Post("/v1/files", body, "Content-Type", "application/json");
  return c.Post("/v1/files", body, "Content-Type", "application/json", "X-Tenant-Id", tenant);
}

std::string opened(harness::Ctx& ctx, harness::HTTP& c, long long size) {
  const auto r = open(c, "t1", size, "image/png");
  ctx.Equal(r.Status, 201, "POST /v1/files (size %d) (%s)", size, r.Text());
  return nlohmann::json::parse(r.Text()).value("upload_id", "");
}

harness::Response put(harness::HTTP& c, const std::string& upload_id, int n, const std::string& data, const std::string& tenant = "t1") {
  return c.Put("/v1/uploads/" + upload_id + "/parts/" + std::to_string(n), data, "X-Tenant-Id", tenant, "Content-Type", "application/octet-stream");
}

long long actualOf(const std::string& upload_id) {
  const auto s = sessions::findSession(upload_id);
  return s ? s->actual_bytes : -1;
}

long long answered(const harness::Response& r) { return nlohmann::json::parse(r.Text(), nullptr, false).value("actual_bytes", -1LL); }

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = open(c, "t1", 64, "image/png");
  ctx.Equal(r.Status, 201, "POST /v1/files (%s)", r.Text());
  const auto body = nlohmann::json::parse(r.Text());
  const std::string upload_id = body.value("upload_id", "");
  ctx.Assert(!upload_id.empty() && body.value("declared_size", 0LL) == 64, "the upload must answer upload_id and declared_size 64, got %s", r.Text());
  const auto first = put(c, upload_id, 1, kPng);
  ctx.Assert(first.Status == 200 && answered(first) == 32, "part 1 (32 bytes) answered %d %s, expected 200 with actual_bytes 32", first.Status, first.Text());
  const auto second = put(c, upload_id, 2, std::string(32, '\\0'));
  ctx.Assert(second.Status == 200 && answered(second) == 64, "part 2 (32 bytes) answered %d %s, expected 200 with actual_bytes 64", second.Status, second.Text());
  const auto staged = store::stagedParts(upload_id);
  ctx.Assert(staged.size() == 2 && staged[0].second == kPng && staged[1].second.size() == 32, "the staged parts are %d, expected parts 1 and 2 of 32 bytes", staged.size());
}

void CheckTenantScope(harness::Ctx& ctx) {
  auto c = api(ctx);
  ctx.Equal(open(c, "", 64, "image/png").Status, 401, "POST /v1/files without X-Tenant-Id");
  const std::string upload_id = opened(ctx, c, 64);
  ctx.Equal(put(c, upload_id, 1, kPng, "t2").Status, 403, "tenant t2 sent a part of t1's upload %s: an upload id is not a credential", upload_id);
  ctx.Assert(store::stagedParts(upload_id).empty() && actualOf(upload_id) == 0, "t2's part was staged or counted (actual_bytes %d)", actualOf(upload_id));
  const auto own = put(c, upload_id, 1, kPng);
  ctx.Equal(own.Status, 200, "t1's own part (%s)", own.Text());
}

void CheckDeclaredSize(harness::Ctx& ctx) {
  auto c = api(ctx);
  ctx.Redis.Set("quota:limit:t1", std::to_string(10LL << 30));  // room beyond the 5 GiB cap
  for (const long long size : {0LL, -5LL, store::kMaxUploadBytes + 1}) {
    ctx.Equal(open(c, "t1", size, "image/png").Status, 413, "a declared size of %d must be refused (1 to 5 GiB)", size);
  }
  ctx.Equal(ctx.Redis.Keys("session:*").size(), 0, "a refused declaration must not open a session; the sessions");
  const std::string upload_id = opened(ctx, c, 40);
  ctx.Equal(put(c, upload_id, 1, kPng).Status, 200, "part 1 (32 of 40 declared bytes)");
  ctx.Equal(put(c, upload_id, 2, std::string(16, '\\0')).Status, 413, "part 2 would take a 40-byte upload to 48 bytes");
  ctx.Assert(actualOf(upload_id) == 32 && store::stagedParts(upload_id).size() == 1, "the refused part was staged or counted (actual_bytes %d)", actualOf(upload_id));
  const auto fits = put(c, upload_id, 2, std::string(8, '\\0'));
  ctx.Assert(fits.Status == 200 && actualOf(upload_id) == 40, "an 8-byte part 2 fits the declaration and answered %d %s", fits.Status, fits.Text());
  const auto retry = put(c, upload_id, 2, std::string(8, '\\0'));
  ctx.Equal(retry.Status, 200, "a retried part 2 replaces its earlier count and must be accepted (%s)", retry.Text());
}

void CheckMimeSniff(harness::Ctx& ctx) {
  auto c = api(ctx);
  ctx.Equal(open(c, "t1", 64, "application/x-msdownload").Status, 415, "a declared mime of application/x-msdownload");
  ctx.Equal(ctx.Redis.Keys("session:*").size(), 0, "a refused mime must not open a session; the sessions");
  const std::string upload_id = opened(ctx, c, 64);
  ctx.Equal(put(c, upload_id, 1, kExe).Status, 415, "an executable sent as part 1 of an image/png upload (sniff the leading bytes)");
  ctx.Assert(store::stagedParts(upload_id).empty() && actualOf(upload_id) == 0, "the refused executable was staged or counted");
  const auto png = put(c, upload_id, 1, kPng);
  ctx.Equal(png.Status, 200, "real PNG bytes (%s)", png.Text());
}
`,
  },
  hints: [
    'Open an upload as t1 and send its first part as t2: it is accepted. Declare 0 bytes, or 40 and send 48: both go through. Send an executable as part 1 of an image/png upload: it is stored.',
    'The handlers trust what the request says. The size and mime are passed to `open_session` unchecked, and the part route loads the session but never reads its tenant, its declared size or its mime before staging.',
    'In `POST`, 413 unless `1 <= size <= store.MAX_UPLOAD_BYTES`, 415 unless `mime in store.ALLOWED_MIME`. In `PUT`, before staging: 403 on a foreign tenant, 413 when `actual_bytes - parts.get(n, 0) + len(data)` passes `declared_size`, 415 when part 1 does not sniff to the declared mime.',
  ],
  debrief: `Every check sits before the first byte is staged, because a staged byte already costs storage and a counted one costs quota. The tenant comparison makes the upload id an address rather than a capability, the declared size becomes a contract the parts are held to as they arrive, and sniffing part 1 means the type the file index records is one the bytes support. A retried part is measured against the declaration minus its own earlier count, so a client's retry does not trip the limit it already met. Production upload services also cap the number of parts per upload and scan the assembled object before it becomes downloadable, since a valid PNG header can still front a hostile payload.`,
};
