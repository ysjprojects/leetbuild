import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/uploads: a bounded part plan, created once',
  concept: 'http',
  guides: ['request-boundaries', 'idempotent-requests'],
  file: 'api',
  focus: ['client', 'api', 'db'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/uploads\` on the upload records (\`uploads.store\`,
provided): it reads the tenant from \`X-Tenant-Id\` (401 without one), takes \`{total_bytes,
part_bytes, content_type}\`, computes \`part_count = total_bytes // part_bytes\`, creates the upload
with \`store.create_upload\` and answers 201 \`{upload_id, part_bytes, part_count, status}\`. It serves
the demo and hides four flaws.

**Failure mode the checks target.** A test tool declares 1-byte parts and the manifest grows to ten
million rows; an 11 MiB file planned in 5 MiB parts gets two parts, so its tail can never be sent;
one tenant initiates a terabyte; a client that timed out and retried starts a second upload.

- \`part_bytes\` lies between \`MIN_PART_BYTES\` (5 MiB) and \`MAX_PART_BYTES\` (64 MiB), else **400**.
- \`part_count\` is \`ceil(total_bytes / part_bytes)\`: the last part may be short.
- \`total_bytes\` is positive (**400**) and at most \`MAX_UPLOAD_BYTES\`, the 5 GiB tenant quota
  (**413**).
- \`Idempotency-Key\` is required (**400**). Look \`(tenant, key)\` up with \`store.initiation\` before
  creating, answer the recorded upload on a replay, and call \`store.record_initiation\` after a
  create.`,
  sequence: {
    participants: ['Uploader', 'uploadd', 'upload records'],
    messages: [
      {from: 'Uploader', to: 'uploadd', label: 'POST /v1/uploads · X-Tenant-Id · Idempotency-Key', kind: 'sync'},
      {from: 'uploadd', to: 'upload records', label: 'initiation(tenant, key)', kind: 'sync'},
      {from: 'upload records', to: 'uploadd', label: 'recorded upload → answer it again', kind: 'reply'},
      {from: 'uploadd', to: 'uploadd', label: 'part size 5–64 MiB · quota 5 GiB · ceil part count', kind: 'sync'},
      {from: 'uploadd', to: 'upload records', label: 'create_upload · record_initiation', kind: 'sync'},
      {from: 'uploadd', to: 'Uploader', label: '201 {upload_id, part_bytes, part_count, status}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Creates an upload on POST /v1/uploads',
      detail:
        'Register `POST /v1/uploads`: a tenant without `X-Tenant-Id` is 401, and a valid initiation answers 201 with the upload id and its part plan.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/uploads["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/uploads['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/uploads"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"uploads"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/uploads"/]},
      },
    },
    {
      id: 'part-size',
      title: 'Bounds the part size',
      detail:
        '`part_bytes` outside `MIN_PART_BYTES`..`MAX_PART_BYTES` (5 MiB to 64 MiB) is **400** and creates nothing; the starter takes any part size, so 1-byte parts make a manifest of millions of entries.',
      match: {
        python: {all: [/MIN_PART_BYTES/, /MAX_PART_BYTES/, /\b400\b/]},
        typescript: {all: [/MIN_PART_BYTES/, /MAX_PART_BYTES/, /\b400\b/]},
        go: {all: [/minPartBytes/, /maxPartBytes/, /StatusBadRequest|\b400\b/]},
        scala: {all: [/MinPartBytes/, /MaxPartBytes/, /BadRequest|\b400\b/]},
        cpp: {all: [/kMinPartBytes/, /kMaxPartBytes/, /\b400\b/]},
      },
    },
    {
      id: 'part-count',
      title: 'Rounds the part count up',
      detail:
        '`part_count` is `ceil(total_bytes / part_bytes)`, so a short last part has a number; the starter divides with the floor, so an 11 MiB file in 5 MiB parts gets two parts and its last megabyte has nowhere to go.',
      match: {
        python: {all: [/math\.ceil\(|-\s*\(\s*-|\+\s*[\w.]*part_bytes\s*-\s*1|divmod\(/]},
        typescript: {all: [/Math\.ceil\(|\+\s*[\w.]*part_bytes\s*-\s*1/], none: [/Math\.floor\(/]},
        go: {all: [/math\.Ceil\(|\+\s*[\w.]*PartBytes\s*-\s*1/]},
        scala: {all: [/math\.ceil\(|Math\.ceil\(|ceilDiv\(|\+\s*[\w.]*partBytes\s*-\s*1/]},
        cpp: {all: [/std::ceil\(|\+\s*[\w.]*part_bytes\s*-\s*1/]},
      },
    },
    {
      id: 'quota',
      title: 'Holds an upload to the 5 GiB tenant quota',
      detail:
        'A `total_bytes` above `MAX_UPLOAD_BYTES` (5 GiB) is **413**, one that is not positive is **400**, and neither creates an upload; the starter checks no total, so one tenant can reserve unlimited storage.',
      match: {
        python: {all: [/MAX_UPLOAD_BYTES/, /\b413\b/]},
        typescript: {all: [/MAX_UPLOAD_BYTES/, /\b413\b/]},
        go: {all: [/maxUploadBytes/, /StatusRequestEntityTooLarge|\b413\b/]},
        scala: {all: [/MaxUploadBytes/, /PayloadTooLarge|ContentTooLarge|RequestEntityTooLarge|\b413\b/]},
        cpp: {all: [/kMaxUploadBytes/, /\b413\b/]},
      },
    },
    {
      id: 'idempotency',
      title: 'Keys an initiation by (tenant, Idempotency-Key)',
      detail:
        '`Idempotency-Key` is required (400 without it) and looked up with `initiation` before the upload is created; a replay answers the recorded upload, and a create is recorded with `record_initiation`/`recordInitiation`.',
      match: {
        python: {
          all: [/idempotency-key/i, /store\.initiation\(/, /store\.record_initiation\(/],
          order: [/store\.initiation\(/, /store\.create_upload\(/],
        },
        typescript: {
          all: [/idempotency-key/i, /\binitiation\(/, /recordInitiation\(/],
          order: [/\binitiation\(/, /createUpload\(/],
        },
        go: {
          all: [/Idempotency-Key/i, /store\.Initiation\(/, /store\.RecordInitiation\(/],
          order: [/store\.Initiation\(/, /store\.CreateUpload\(/],
        },
        scala: {
          all: [/Idempotency-Key/i, /Store\.initiation\(/, /Store\.recordInitiation\(/],
          order: [/Store\.initiation\(/, /Store\.createUpload\(/],
        },
        cpp: {
          all: [/Idempotency-Key/i, /store::initiation\(/, /store::recordInitiation\(/],
          order: [/store::initiation\(/, /store::createUpload\(/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

from uploads import store  # create_upload, get_upload, initiation, record_initiation

app = FastAPI()


class InitUpload(BaseModel):
    total_bytes: int
    part_bytes: int
    content_type: str


def view(upload: dict) -> dict:
    return {
        "upload_id": upload["upload_id"],
        "part_bytes": upload["part_bytes"],
        "part_count": upload["part_count"],
        "status": upload["status"],
    }


@app.post("/v1/uploads", status_code=201)
def init_upload(body: InitUpload, request: Request) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    part_count = body.total_bytes // body.part_bytes
    upload = store.create_upload(tenant, body.total_bytes, body.part_bytes, part_count, body.content_type)
    return view(upload)
`,
      solution: `from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

from uploads import store  # create_upload, get_upload, initiation, record_initiation

app = FastAPI()

MIN_PART_BYTES = 5 << 20  # 5 MiB: smaller parts make a manifest of millions of entries
MAX_PART_BYTES = 64 << 20  # 64 MiB: a failed part costs at most this much to send again
MAX_UPLOAD_BYTES = 5 << 30  # the tenant quota: 5 GiB


class InitUpload(BaseModel):
    total_bytes: int
    part_bytes: int
    content_type: str


def view(upload: dict) -> dict:
    return {
        "upload_id": upload["upload_id"],
        "part_bytes": upload["part_bytes"],
        "part_count": upload["part_count"],
        "status": upload["status"],
    }


@app.post("/v1/uploads", status_code=201)
def init_upload(body: InitUpload, request: Request) -> dict:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    key = request.headers.get("idempotency-key", "")
    if not key:
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    recorded = store.initiation(tenant, key)
    if recorded is not None:
        return view(recorded)  # a retry answers the upload the first attempt created
    if body.total_bytes <= 0:
        raise HTTPException(status_code=400, detail="total_bytes must be positive")
    if body.total_bytes > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="total_bytes is over the 5 GiB tenant quota")
    if not MIN_PART_BYTES <= body.part_bytes <= MAX_PART_BYTES:
        raise HTTPException(status_code=400, detail="part_bytes must be between 5 MiB and 64 MiB")
    part_count = -(-body.total_bytes // body.part_bytes)  # rounded up: the last part may be short
    upload = store.create_upload(tenant, body.total_bytes, body.part_bytes, part_count, body.content_type)
    store.record_initiation(tenant, key, upload["upload_id"])
    return view(upload)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {type Upload, createUpload, initiation, recordInitiation} from 'uploads/store';

export const app = Fastify();

interface InitUpload {
  total_bytes: number;
  part_bytes: number;
  content_type: string;
}

const view = (upload: Upload) => ({
  upload_id: upload.upload_id,
  part_bytes: upload.part_bytes,
  part_count: upload.part_count,
  status: upload.status,
});

app.post('/v1/uploads', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const body = request.body as InitUpload;
  const partCount = Math.floor(body.total_bytes / body.part_bytes);
  const upload = await createUpload(tenant, body.total_bytes, body.part_bytes, partCount, body.content_type);
  return reply.code(201).send(view(upload));
});
`,
      solution: `import Fastify from 'fastify';

import {type Upload, createUpload, initiation, recordInitiation} from 'uploads/store';

export const app = Fastify();

export const MIN_PART_BYTES = 5 * 2 ** 20; // 5 MiB: smaller parts make a manifest of millions of entries
export const MAX_PART_BYTES = 64 * 2 ** 20; // 64 MiB: a failed part costs at most this much to send again
export const MAX_UPLOAD_BYTES = 5 * 2 ** 30; // the tenant quota: 5 GiB

interface InitUpload {
  total_bytes: number;
  part_bytes: number;
  content_type: string;
}

const view = (upload: Upload) => ({
  upload_id: upload.upload_id,
  part_bytes: upload.part_bytes,
  part_count: upload.part_count,
  status: upload.status,
});

app.post('/v1/uploads', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key === '') return reply.code(400).send({error: 'Idempotency-Key is required'});
  const recorded = await initiation(tenant, key);
  if (recorded !== null) return reply.code(201).send(view(recorded)); // a retry answers the upload the first attempt created
  const body = request.body as InitUpload;
  if (!(body.total_bytes > 0)) return reply.code(400).send({error: 'total_bytes must be positive'});
  if (body.total_bytes > MAX_UPLOAD_BYTES) return reply.code(413).send({error: 'total_bytes is over the 5 GiB tenant quota'});
  if (!(body.part_bytes >= MIN_PART_BYTES && body.part_bytes <= MAX_PART_BYTES)) {
    return reply.code(400).send({error: 'part_bytes must be between 5 MiB and 64 MiB'});
  }
  const partCount = Math.ceil(body.total_bytes / body.part_bytes); // rounded up: the last part may be short
  const upload = await createUpload(tenant, body.total_bytes, body.part_bytes, partCount, body.content_type);
  await recordInitiation(tenant, key, upload.upload_id);
  return reply.code(201).send(view(upload));
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"uploads/store" // store.CreateUpload, GetUpload, Initiation, RecordInitiation
)

type initRequest struct {
	TotalBytes  int64  \`json:"total_bytes"\`
	PartBytes   int64  \`json:"part_bytes"\`
	ContentType string \`json:"content_type"\`
}

type uploadView struct {
	UploadID  string \`json:"upload_id"\`
	PartBytes int64  \`json:"part_bytes"\`
	PartCount int    \`json:"part_count"\`
	Status    string \`json:"status"\`
}

func view(u *store.Upload) uploadView {
	return uploadView{UploadID: u.UploadID, PartBytes: u.PartBytes, PartCount: u.PartCount, Status: u.Status}
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func initUpload(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	var body initRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.PartBytes == 0 {
		http.Error(rw, "a JSON body with total_bytes, part_bytes and content_type is required", http.StatusBadRequest)
		return
	}
	partCount := int(body.TotalBytes / body.PartBytes)
	upload := store.CreateUpload(r.Context(), tenant, body.TotalBytes, body.PartBytes, partCount, body.ContentType)
	writeJSON(rw, http.StatusCreated, view(upload))
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/uploads", initUpload)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"

	"uploads/store" // store.CreateUpload, GetUpload, Initiation, RecordInitiation
)

const (
	minPartBytes   = 5 << 20  // 5 MiB: smaller parts make a manifest of millions of entries
	maxPartBytes   = 64 << 20 // 64 MiB: a failed part costs at most this much to send again
	maxUploadBytes = 5 << 30  // the tenant quota: 5 GiB
)

type initRequest struct {
	TotalBytes  int64  \`json:"total_bytes"\`
	PartBytes   int64  \`json:"part_bytes"\`
	ContentType string \`json:"content_type"\`
}

type uploadView struct {
	UploadID  string \`json:"upload_id"\`
	PartBytes int64  \`json:"part_bytes"\`
	PartCount int    \`json:"part_count"\`
	Status    string \`json:"status"\`
}

func view(u *store.Upload) uploadView {
	return uploadView{UploadID: u.UploadID, PartBytes: u.PartBytes, PartCount: u.PartCount, Status: u.Status}
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func initUpload(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	key := r.Header.Get("Idempotency-Key")
	if key == "" {
		http.Error(rw, "Idempotency-Key is required", http.StatusBadRequest)
		return
	}
	if recorded := store.Initiation(r.Context(), tenant, key); recorded != nil {
		writeJSON(rw, http.StatusCreated, view(recorded)) // a retry answers the upload the first attempt created
		return
	}
	var body initRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, "a JSON body with total_bytes, part_bytes and content_type is required", http.StatusBadRequest)
		return
	}
	if body.TotalBytes <= 0 {
		http.Error(rw, "total_bytes must be positive", http.StatusBadRequest)
		return
	}
	if body.TotalBytes > maxUploadBytes {
		http.Error(rw, "total_bytes is over the 5 GiB tenant quota", http.StatusRequestEntityTooLarge)
		return
	}
	if body.PartBytes < minPartBytes || body.PartBytes > maxPartBytes {
		http.Error(rw, "part_bytes must be between 5 MiB and 64 MiB", http.StatusBadRequest)
		return
	}
	partCount := int((body.TotalBytes + body.PartBytes - 1) / body.PartBytes) // rounded up: the last part may be short
	upload := store.CreateUpload(r.Context(), tenant, body.TotalBytes, body.PartBytes, partCount, body.ContentType)
	store.RecordInitiation(r.Context(), tenant, key, upload.UploadID)
	writeJSON(rw, http.StatusCreated, view(upload))
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/uploads", initUpload)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import uploads.{Store, Upload} // Store.createUpload, getUpload, initiation, recordInitiation

object Api {
  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def view(upload: Upload): JsObject = JsObject(
    "upload_id" -> JsString(upload.uploadId), "part_bytes" -> JsNumber(upload.partBytes),
    "part_count" -> JsNumber(upload.partCount), "status" -> JsString(upload.status))

  val route: Route = path("v1" / "uploads") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
        case Some(tenant) =>
          entity(as[String]) { raw =>
            // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
            val body = raw.parseJson.asJsObject.fields
            def long(name: String): Long = body.get(name).collect { case JsNumber(n) => n.toLong }.getOrElse(0L)
            val totalBytes = long("total_bytes")
            val partBytes = long("part_bytes")
            val contentType = body.get("content_type").collect { case JsString(s) => s }.getOrElse("")
            val partCount = (totalBytes / partBytes).toInt
            val upload = Store.createUpload(tenant, totalBytes, partBytes, partCount, contentType)
            complete(json(StatusCodes.Created, view(upload)))
          }
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import uploads.{Store, Upload} // Store.createUpload, getUpload, initiation, recordInitiation

object Api {
  val MinPartBytes: Long = 5L << 20 // 5 MiB: smaller parts make a manifest of millions of entries
  val MaxPartBytes: Long = 64L << 20 // 64 MiB: a failed part costs at most this much to send again
  val MaxUploadBytes: Long = 5L << 30 // the tenant quota: 5 GiB

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def view(upload: Upload): JsObject = JsObject(
    "upload_id" -> JsString(upload.uploadId), "part_bytes" -> JsNumber(upload.partBytes),
    "part_count" -> JsNumber(upload.partCount), "status" -> JsString(upload.status))

  val route: Route = path("v1" / "uploads") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
        case Some(tenant) =>
          optionalHeaderValueByName("Idempotency-Key") {
            case None | Some("") => complete(StatusCodes.BadRequest -> "Idempotency-Key is required")
            case Some(key) =>
              Store.initiation(tenant, key) match {
                case Some(recorded) => complete(json(StatusCodes.Created, view(recorded))) // a retry answers the upload the first attempt created
                case None =>
                  entity(as[String]) { raw =>
                    val body = raw.parseJson.asJsObject.fields
                    def long(name: String): Long = body.get(name).collect { case JsNumber(n) => n.toLong }.getOrElse(0L)
                    val totalBytes = long("total_bytes")
                    val partBytes = long("part_bytes")
                    val contentType = body.get("content_type").collect { case JsString(s) => s }.getOrElse("")
                    if (totalBytes <= 0) complete(StatusCodes.BadRequest -> "total_bytes must be positive")
                    else if (totalBytes > MaxUploadBytes) complete(StatusCodes.PayloadTooLarge -> "total_bytes is over the 5 GiB tenant quota")
                    else if (partBytes < MinPartBytes || partBytes > MaxPartBytes) complete(StatusCodes.BadRequest -> "part_bytes must be between 5 MiB and 64 MiB")
                    else {
                      val partCount = ((totalBytes + partBytes - 1) / partBytes).toInt // rounded up: the last part may be short
                      val upload = Store.createUpload(tenant, totalBytes, partBytes, partCount, contentType)
                      Store.recordInitiation(tenant, key, upload.uploadId)
                      complete(json(StatusCodes.Created, view(upload)))
                    }
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

#include "uploads/store.h"  // store::createUpload, getUpload, initiation, recordInitiation

using json = nlohmann::json;

json view(const store::Upload& upload) {
  return json{{"upload_id", upload.upload_id}, {"part_bytes", upload.part_bytes}, {"part_count", upload.part_count}, {"status", upload.status}};
}

void init_upload(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content("X-Tenant-Id is required", "text/plain");
    return;
  }
  const json body = json::parse(req.body, nullptr, false);
  const long long total_bytes = body.is_object() ? body.value("total_bytes", 0LL) : 0;
  const long long part_bytes = body.is_object() ? body.value("part_bytes", 0LL) : 0;
  if (part_bytes == 0) {
    res.status = 400;
    res.set_content("a JSON body with total_bytes, part_bytes and content_type is required", "text/plain");
    return;
  }
  const int part_count = static_cast<int>(total_bytes / part_bytes);
  const store::Upload upload = store::createUpload(tenant, total_bytes, part_bytes, part_count, body.value("content_type", ""));
  res.status = 201;
  res.set_content(view(upload).dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/uploads", init_upload); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

#include "uploads/store.h"  // store::createUpload, getUpload, initiation, recordInitiation

using json = nlohmann::json;

constexpr long long kMinPartBytes = 5LL << 20;    // 5 MiB: smaller parts make a manifest of millions of entries
constexpr long long kMaxPartBytes = 64LL << 20;   // 64 MiB: a failed part costs at most this much to send again
constexpr long long kMaxUploadBytes = 5LL << 30;  // the tenant quota: 5 GiB

json view(const store::Upload& upload) {
  return json{{"upload_id", upload.upload_id}, {"part_bytes", upload.part_bytes}, {"part_count", upload.part_count}, {"status", upload.status}};
}

void reject(httplib::Response& res, int status, const std::string& message) {
  res.status = status;
  res.set_content(message, "text/plain");
}

void init_upload(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reject(res, 401, "X-Tenant-Id is required");
  const std::string key = req.get_header_value("Idempotency-Key");
  if (key.empty()) return reject(res, 400, "Idempotency-Key is required");
  if (const auto recorded = store::initiation(tenant, key)) {
    res.status = 201;
    res.set_content(view(*recorded).dump(), "application/json");  // a retry answers the upload the first attempt created
    return;
  }
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return reject(res, 400, "a JSON body with total_bytes, part_bytes and content_type is required");
  const long long total_bytes = body.value("total_bytes", 0LL);
  const long long part_bytes = body.value("part_bytes", 0LL);
  if (total_bytes <= 0) return reject(res, 400, "total_bytes must be positive");
  if (total_bytes > kMaxUploadBytes) return reject(res, 413, "total_bytes is over the 5 GiB tenant quota");
  if (part_bytes < kMinPartBytes || part_bytes > kMaxPartBytes) return reject(res, 400, "part_bytes must be between 5 MiB and 64 MiB");
  const int part_count = static_cast<int>((total_bytes + part_bytes - 1) / part_bytes);  // rounded up: the last part may be short
  const store::Upload upload = store::createUpload(tenant, total_bytes, part_bytes, part_count, body.value("content_type", ""));
  store::recordInitiation(tenant, key, upload.upload_id);
  res.status = 201;
  res.set_content(view(upload).dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/uploads", init_upload); }
`,
    },
  },
  harness: {
    python: `from uploads import store

MIB = 1 << 20


def _api(ctx):
    return ctx.client(ctx.load("api").app)


async def _init(c, total, part, key="k-1", tenant="t1"):
    body = {"total_bytes": total, "part_bytes": part, "content_type": "video/mp4"}
    return await c.post("/v1/uploads", json=body, headers={"X-Tenant-Id": tenant, "Idempotency-Key": key})


def _created(ctx):
    return int(ctx.redis.get("upload:seq") or 0)


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await _init(c, 10 * MIB, 5 * MIB)
        anonymous = await c.post("/v1/uploads", json={"total_bytes": 10 * MIB, "part_bytes": 5 * MIB, "content_type": "video/mp4"}, headers={"Idempotency-Key": "k-2"})
    assert r.status_code == 201, f"POST /v1/uploads answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("part_count") == 2 and body.get("part_bytes") == 5 * MIB and body.get("status") == "pending", f"10 MiB in 5 MiB parts must answer part_count 2, part_bytes 5 MiB, status pending; got {body}"
    upload = store.get_upload(body.get("upload_id", ""))
    assert upload is not None and upload["tenant"] == "t1" and upload["total_bytes"] == 10 * MIB, f"the upload record of {body.get('upload_id')} is {upload}"
    assert anonymous.status_code == 401, f"an initiation without X-Tenant-Id answered {anonymous.status_code}, expected 401"


async def check_part_size(ctx):
    async with _api(ctx) as c:
        tiny = await _init(c, 10 * MIB, 1, "k-1")
        small = await _init(c, 10 * MIB, 4 * MIB, "k-2")
        huge = await _init(c, 1 << 30, 128 * MIB, "k-3")
        assert tiny.status_code == 400, f"part_bytes 1 answered {tiny.status_code}: {tiny.text}. Ten million 1-byte parts would be ten million manifest entries; expected 400"
        assert small.status_code == 400, f"part_bytes 4 MiB (under MIN_PART_BYTES, 5 MiB) answered {small.status_code}, expected 400"
        assert huge.status_code == 400, f"part_bytes 128 MiB (over MAX_PART_BYTES, 64 MiB) answered {huge.status_code}, expected 400"
        assert _created(ctx) == 0, f"{_created(ctx)} upload(s) were created from part sizes out of range"
        low = await _init(c, 10 * MIB, 5 * MIB, "k-4")
        high = await _init(c, 1 << 30, 64 * MIB, "k-5")
    assert low.status_code == 201 and high.status_code == 201, f"part_bytes of exactly 5 MiB and 64 MiB must be accepted, got {low.status_code} and {high.status_code}"


async def check_part_count(ctx):
    async with _api(ctx) as c:
        tail = await _init(c, 11 * MIB, 5 * MIB, "k-1")
        short = await _init(c, 3 * MIB, 5 * MIB, "k-2")
        even = await _init(c, 10 * MIB, 5 * MIB, "k-3")
    assert tail.status_code == 201 and tail.json().get("part_count") == 3, f"11 MiB in 5 MiB parts answered {tail.status_code} {tail.text}: it needs part_count 3 (the last part holds 1 MiB), or that megabyte can never be sent"
    assert short.status_code == 201 and short.json().get("part_count") == 1, f"a 3 MiB file in 5 MiB parts answered {short.status_code} {short.text}: it is one short part, part_count 1"
    assert even.json().get("part_count") == 2, f"10 MiB in 5 MiB parts must be 2 parts, got {even.text}"
    upload = store.get_upload(tail.json()["upload_id"])
    assert upload["part_count"] == 3, f"the upload record holds part_count {upload['part_count']}, expected 3"


async def check_quota(ctx):
    async with _api(ctx) as c:
        over = await _init(c, (5 << 30) + 1, 64 * MIB, "k-1")
        empty = await _init(c, 0, 5 * MIB, "k-2")
        assert over.status_code == 413, f"total_bytes 5 GiB + 1 answered {over.status_code}: {over.text}. Over the tenant quota is 413"
        assert empty.status_code == 400, f"total_bytes 0 answered {empty.status_code}, expected 400"
        assert _created(ctx) == 0, f"{_created(ctx)} upload(s) were created for a total over the quota or not positive"
        full = await _init(c, 5 << 30, 64 * MIB, "k-3")
    assert full.status_code == 201 and full.json().get("part_count") == 80, f"exactly 5 GiB in 64 MiB parts must be accepted as 80 parts, got {full.status_code} {full.text}"


async def check_idempotency(ctx):
    async with _api(ctx) as c:
        first = await _init(c, 10 * MIB, 5 * MIB, "k-1")
        retry = await _init(c, 10 * MIB, 5 * MIB, "k-1")
        assert first.status_code == 201, f"the first initiation answered {first.status_code}: {first.text}"
        assert retry.status_code in (200, 201) and retry.json().get("upload_id") == first.json().get("upload_id"), f"a retry with the same Idempotency-Key answered {retry.status_code} {retry.text}, expected the first upload {first.json().get('upload_id')}: a second upload orphans every part the client sent to the first"
        assert _created(ctx) == 1, f"the retry created a second upload ({_created(ctx)} created)"
        other = await _init(c, 10 * MIB, 5 * MIB, "k-1", tenant="t2")
        fresh = await _init(c, 10 * MIB, 5 * MIB, "k-2")
        assert other.json().get("upload_id") != first.json().get("upload_id"), "another tenant's initiation with the same key got the first tenant's upload: the key is scoped to the tenant"
        assert fresh.json().get("upload_id") not in (first.json().get("upload_id"), other.json().get("upload_id")), "a new Idempotency-Key must create a new upload"
        none = await c.post("/v1/uploads", json={"total_bytes": 10 * MIB, "part_bytes": 5 * MIB, "content_type": "video/mp4"}, headers={"X-Tenant-Id": "t1"})
    assert none.status_code == 400, f"an initiation without Idempotency-Key answered {none.status_code}, expected 400"
    assert _created(ctx) == 3, f"{_created(ctx)} uploads were created, expected 3 (k-1 for t1, k-1 for t2, k-2)"
`,
    typescript: `const MIB = 2 ** 20;

function api(ctx) {
  return {c: ctx.client(ctx.load('api').app), store: ctx.load('/support/uploads/store.ts')};
}

const init = (c, total: number, part: number, key = 'k-1', tenant = 't1') =>
  c.post('/v1/uploads', {json: {total_bytes: total, part_bytes: part, content_type: 'video/mp4'}, headers: {'X-Tenant-Id': tenant, 'Idempotency-Key': key}});

const created = (ctx): number => Number(ctx.redis.get('upload:seq') ?? 0);

export async function check_route(ctx) {
  const {c, store} = api(ctx);
  const r = await init(c, 10 * MIB, 5 * MIB);
  assert.equal(r.status, 201, \`POST /v1/uploads answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.part_count === 2 && body.part_bytes === 5 * MIB && body.status === 'pending', \`10 MiB in 5 MiB parts must answer part_count 2, part_bytes 5 MiB, status pending; got \${r.text}\`);
  const upload = await store.getUpload(body.upload_id ?? '');
  assert(upload !== null && upload.tenant === 't1' && upload.total_bytes === 10 * MIB, \`the upload record of \${body.upload_id} is \${JSON.stringify(upload)}\`);
  const anonymous = await c.post('/v1/uploads', {json: {total_bytes: 10 * MIB, part_bytes: 5 * MIB, content_type: 'video/mp4'}, headers: {'Idempotency-Key': 'k-2'}});
  assert.equal(anonymous.status, 401, \`an initiation without X-Tenant-Id answered \${anonymous.status}, expected 401\`);
}

export async function check_part_size(ctx) {
  const {c} = api(ctx);
  const tiny = await init(c, 10 * MIB, 1, 'k-1');
  const small = await init(c, 10 * MIB, 4 * MIB, 'k-2');
  const huge = await init(c, 2 ** 30, 128 * MIB, 'k-3');
  assert.equal(tiny.status, 400, \`part_bytes 1 answered \${tiny.status}: \${tiny.text}. Ten million 1-byte parts would be ten million manifest entries; expected 400\`);
  assert.equal(small.status, 400, \`part_bytes 4 MiB (under MIN_PART_BYTES, 5 MiB) answered \${small.status}, expected 400\`);
  assert.equal(huge.status, 400, \`part_bytes 128 MiB (over MAX_PART_BYTES, 64 MiB) answered \${huge.status}, expected 400\`);
  assert.equal(created(ctx), 0, \`\${created(ctx)} upload(s) were created from part sizes out of range\`);
  const low = await init(c, 10 * MIB, 5 * MIB, 'k-4');
  const high = await init(c, 2 ** 30, 64 * MIB, 'k-5');
  assert(low.status === 201 && high.status === 201, \`part_bytes of exactly 5 MiB and 64 MiB must be accepted, got \${low.status} and \${high.status}\`);
}

export async function check_part_count(ctx) {
  const {c, store} = api(ctx);
  const tail = await init(c, 11 * MIB, 5 * MIB, 'k-1');
  const short = await init(c, 3 * MIB, 5 * MIB, 'k-2');
  const even = await init(c, 10 * MIB, 5 * MIB, 'k-3');
  assert(tail.status === 201 && tail.json().part_count === 3, \`11 MiB in 5 MiB parts answered \${tail.status} \${tail.text}: it needs part_count 3 (the last part holds 1 MiB), or that megabyte can never be sent\`);
  assert(short.status === 201 && short.json().part_count === 1, \`a 3 MiB file in 5 MiB parts answered \${short.status} \${short.text}: it is one short part, part_count 1\`);
  assert.equal(even.json().part_count, 2, \`10 MiB in 5 MiB parts must be 2 parts, got \${even.text}\`);
  const upload = await store.getUpload(tail.json().upload_id);
  assert.equal(upload.part_count, 3, \`the upload record holds part_count \${upload.part_count}, expected 3\`);
}

export async function check_quota(ctx) {
  const {c} = api(ctx);
  const over = await init(c, 5 * 2 ** 30 + 1, 64 * MIB, 'k-1');
  const empty = await init(c, 0, 5 * MIB, 'k-2');
  assert.equal(over.status, 413, \`total_bytes 5 GiB + 1 answered \${over.status}: \${over.text}. Over the tenant quota is 413\`);
  assert.equal(empty.status, 400, \`total_bytes 0 answered \${empty.status}, expected 400\`);
  assert.equal(created(ctx), 0, \`\${created(ctx)} upload(s) were created for a total over the quota or not positive\`);
  const full = await init(c, 5 * 2 ** 30, 64 * MIB, 'k-3');
  assert(full.status === 201 && full.json().part_count === 80, \`exactly 5 GiB in 64 MiB parts must be accepted as 80 parts, got \${full.status} \${full.text}\`);
}

export async function check_idempotency(ctx) {
  const {c} = api(ctx);
  const first = await init(c, 10 * MIB, 5 * MIB, 'k-1');
  const retry = await init(c, 10 * MIB, 5 * MIB, 'k-1');
  assert.equal(first.status, 201, \`the first initiation answered \${first.status}: \${first.text}\`);
  assert((retry.status === 200 || retry.status === 201) && retry.json().upload_id === first.json().upload_id, \`a retry with the same Idempotency-Key answered \${retry.status} \${retry.text}, expected the first upload \${first.json().upload_id}: a second upload orphans every part the client sent to the first\`);
  assert.equal(created(ctx), 1, \`the retry created a second upload (\${created(ctx)} created)\`);
  const other = await init(c, 10 * MIB, 5 * MIB, 'k-1', 't2');
  const fresh = await init(c, 10 * MIB, 5 * MIB, 'k-2');
  assert.notEqual(other.json().upload_id, first.json().upload_id, "another tenant's initiation with the same key got the first tenant's upload: the key is scoped to the tenant");
  assert(![first.json().upload_id, other.json().upload_id].includes(fresh.json().upload_id), 'a new Idempotency-Key must create a new upload');
  const none = await c.post('/v1/uploads', {json: {total_bytes: 10 * MIB, part_bytes: 5 * MIB, content_type: 'video/mp4'}, headers: {'X-Tenant-Id': 't1'}});
  assert.equal(none.status, 400, \`an initiation without Idempotency-Key answered \${none.status}, expected 400\`);
  assert.equal(created(ctx), 3, \`\${created(ctx)} uploads were created, expected 3 (k-1 for t1, k-1 for t2, k-2)\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"strconv"

	"uploads/store"

	"leetbuild/harness"
)

const mib = int64(1) << 20

type initView struct {
	UploadID  string \`json:"upload_id"\`
	PartBytes int64  \`json:"part_bytes"\`
	PartCount int    \`json:"part_count"\`
	Status    string \`json:"status"\`
}

func api(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func initAs(c *harness.HTTP, total, part int64, key, tenant string) *harness.Response {
	body := map[string]any{"total_bytes": total, "part_bytes": part, "content_type": "video/mp4"}
	return c.Post("/v1/uploads", body, "X-Tenant-Id", tenant, "Idempotency-Key", key)
}

func decoded(r *harness.Response) initView {
	var v initView
	r.Decode(&v)
	return v
}

func created(ctx *harness.Ctx) int {
	seq, _ := ctx.Redis.Get("upload:seq")
	n, _ := strconv.Atoi(seq)
	return n
}

func CheckRoute(ctx *harness.Ctx) {
	c := api(ctx)
	r := initAs(c, 10*mib, 5*mib, "k-1", "t1")
	ctx.Equal(r.Status, 201, "POST /v1/uploads (%s)", r.Text())
	body := decoded(r)
	ctx.Assert(body.PartCount == 2 && body.PartBytes == 5*mib && body.Status == "pending", "10 MiB in 5 MiB parts must answer part_count 2, part_bytes 5 MiB, status pending; got %s", r.Text())
	upload := store.GetUpload(context.Background(), body.UploadID)
	ctx.Assert(upload != nil && upload.Tenant == "t1" && upload.TotalBytes == 10*mib, "the upload record of %s is %+v", body.UploadID, upload)
	anonymous := c.Post("/v1/uploads", map[string]any{"total_bytes": 10 * mib, "part_bytes": 5 * mib, "content_type": "video/mp4"}, "Idempotency-Key", "k-2")
	ctx.Equal(anonymous.Status, 401, "an initiation without X-Tenant-Id")
}

func CheckPartSize(ctx *harness.Ctx) {
	c := api(ctx)
	tiny := initAs(c, 10*mib, 1, "k-1", "t1")
	small := initAs(c, 10*mib, 4*mib, "k-2", "t1")
	huge := initAs(c, 1<<30, 128*mib, "k-3", "t1")
	ctx.Equal(tiny.Status, 400, "part_bytes 1 (ten million 1-byte parts would be ten million manifest entries; %s)", tiny.Text())
	ctx.Equal(small.Status, 400, "part_bytes 4 MiB (under minPartBytes, 5 MiB)")
	ctx.Equal(huge.Status, 400, "part_bytes 128 MiB (over maxPartBytes, 64 MiB)")
	ctx.Equal(created(ctx), 0, "uploads created from part sizes out of range")
	low := initAs(c, 10*mib, 5*mib, "k-4", "t1")
	high := initAs(c, 1<<30, 64*mib, "k-5", "t1")
	ctx.Assert(low.Status == 201 && high.Status == 201, "part_bytes of exactly 5 MiB and 64 MiB must be accepted, got %d and %d", low.Status, high.Status)
}

func CheckPartCount(ctx *harness.Ctx) {
	c := api(ctx)
	tail := initAs(c, 11*mib, 5*mib, "k-1", "t1")
	short := initAs(c, 3*mib, 5*mib, "k-2", "t1")
	even := initAs(c, 10*mib, 5*mib, "k-3", "t1")
	ctx.Assert(tail.Status == 201 && decoded(tail).PartCount == 3, "11 MiB in 5 MiB parts answered %d %s: it needs part_count 3 (the last part holds 1 MiB), or that megabyte can never be sent", tail.Status, tail.Text())
	ctx.Assert(short.Status == 201 && decoded(short).PartCount == 1, "a 3 MiB file in 5 MiB parts answered %d %s: it is one short part, part_count 1", short.Status, short.Text())
	ctx.Equal(decoded(even).PartCount, 2, "10 MiB in 5 MiB parts; the part count")
	upload := store.GetUpload(context.Background(), decoded(tail).UploadID)
	ctx.Assert(upload != nil && upload.PartCount == 3, "the upload record must hold part_count 3, got %+v", upload)
}

func CheckQuota(ctx *harness.Ctx) {
	c := api(ctx)
	over := initAs(c, 5<<30+1, 64*mib, "k-1", "t1")
	empty := initAs(c, 0, 5*mib, "k-2", "t1")
	ctx.Equal(over.Status, 413, "total_bytes 5 GiB + 1 is over the tenant quota (%s)", over.Text())
	ctx.Equal(empty.Status, 400, "total_bytes 0")
	ctx.Equal(created(ctx), 0, "uploads created for a total over the quota or not positive")
	full := initAs(c, 5<<30, 64*mib, "k-3", "t1")
	ctx.Assert(full.Status == 201 && decoded(full).PartCount == 80, "exactly 5 GiB in 64 MiB parts must be accepted as 80 parts, got %d %s", full.Status, full.Text())
}

func CheckIdempotency(ctx *harness.Ctx) {
	c := api(ctx)
	first := initAs(c, 10*mib, 5*mib, "k-1", "t1")
	retry := initAs(c, 10*mib, 5*mib, "k-1", "t1")
	ctx.Equal(first.Status, 201, "the first initiation (%s)", first.Text())
	firstID := decoded(first).UploadID
	ctx.Assert((retry.Status == 200 || retry.Status == 201) && decoded(retry).UploadID == firstID, "a retry with the same Idempotency-Key answered %d %s, expected the first upload %s: a second upload orphans every part the client sent to the first", retry.Status, retry.Text(), firstID)
	ctx.Equal(created(ctx), 1, "the retry must not create a second upload; uploads created")
	other := decoded(initAs(c, 10*mib, 5*mib, "k-1", "t2")).UploadID
	fresh := decoded(initAs(c, 10*mib, 5*mib, "k-2", "t1")).UploadID
	ctx.Assert(other != firstID, "another tenant's initiation with the same key got the first tenant's upload: the key is scoped to the tenant")
	ctx.Assert(fresh != firstID && fresh != other, "a new Idempotency-Key must create a new upload")
	none := c.Post("/v1/uploads", map[string]any{"total_bytes": 10 * mib, "part_bytes": 5 * mib, "content_type": "video/mp4"}, "X-Tenant-Id", "t1")
	ctx.Equal(none.Status, 400, "an initiation without Idempotency-Key")
	ctx.Equal(created(ctx), 3, "uploads created (k-1 for t1, k-1 for t2, k-2)")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>

#include "uploads/store.h"

namespace {

constexpr long long kMib = 1LL << 20;

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

std::string body(long long total, long long part) {
  return nlohmann::json{{"total_bytes", total}, {"part_bytes", part}, {"content_type", "video/mp4"}}.dump();
}

harness::Response initAs(harness::HTTP& c, long long total, long long part, const std::string& key, const std::string& tenant = "t1") {
  return c.Post("/v1/uploads", body(total, part), "Content-Type", "application/json", "X-Tenant-Id", tenant, "Idempotency-Key", key);
}

nlohmann::json parsed(const harness::Response& r) {
  const auto j = nlohmann::json::parse(r.Text(), nullptr, false);
  return j.is_object() ? j : nlohmann::json::object();
}

long long created(harness::Ctx& ctx) {
  const auto seq = ctx.Redis.Get("upload:seq");
  return seq ? std::stoll(*seq) : 0;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = initAs(c, 10 * kMib, 5 * kMib, "k-1");
  ctx.Equal(r.Status, 201, "POST /v1/uploads (%s)", r.Text());
  const auto b = parsed(r);
  ctx.Assert(b.value("part_count", 0) == 2 && b.value("part_bytes", 0LL) == 5 * kMib && b.value("status", "") == "pending",
             "10 MiB in 5 MiB parts must answer part_count 2, part_bytes 5 MiB, status pending; got %s", r.Text());
  const auto upload = store::getUpload(b.value("upload_id", ""));
  ctx.Assert(upload && upload->tenant == "t1" && upload->total_bytes == 10 * kMib, "the upload record of %s is missing or wrong (%s)", b.value("upload_id", ""), r.Text());
  const auto anonymous = c.Post("/v1/uploads", body(10 * kMib, 5 * kMib), "Content-Type", "application/json", "Idempotency-Key", "k-2");
  ctx.Equal(anonymous.Status, 401, "an initiation without X-Tenant-Id");
}

void CheckPartSize(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto tiny = initAs(c, 10 * kMib, 1, "k-1");
  const auto small = initAs(c, 10 * kMib, 4 * kMib, "k-2");
  const auto huge = initAs(c, 1LL << 30, 128 * kMib, "k-3");
  ctx.Equal(tiny.Status, 400, "part_bytes 1 (ten million 1-byte parts would be ten million manifest entries; %s)", tiny.Text());
  ctx.Equal(small.Status, 400, "part_bytes 4 MiB (under kMinPartBytes, 5 MiB)");
  ctx.Equal(huge.Status, 400, "part_bytes 128 MiB (over kMaxPartBytes, 64 MiB)");
  ctx.Equal(created(ctx), 0, "uploads created from part sizes out of range");
  const auto low = initAs(c, 10 * kMib, 5 * kMib, "k-4");
  const auto high = initAs(c, 1LL << 30, 64 * kMib, "k-5");
  ctx.Assert(low.Status == 201 && high.Status == 201, "part_bytes of exactly 5 MiB and 64 MiB must be accepted, got %d and %d", low.Status, high.Status);
}

void CheckPartCount(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto tail = initAs(c, 11 * kMib, 5 * kMib, "k-1");
  const auto short_ = initAs(c, 3 * kMib, 5 * kMib, "k-2");
  const auto even = initAs(c, 10 * kMib, 5 * kMib, "k-3");
  ctx.Assert(tail.Status == 201 && parsed(tail).value("part_count", 0) == 3,
             "11 MiB in 5 MiB parts answered %d %s: it needs part_count 3 (the last part holds 1 MiB), or that megabyte can never be sent", tail.Status, tail.Text());
  ctx.Assert(short_.Status == 201 && parsed(short_).value("part_count", 0) == 1, "a 3 MiB file in 5 MiB parts answered %d %s: it is one short part, part_count 1", short_.Status, short_.Text());
  ctx.Equal(parsed(even).value("part_count", 0), 2, "10 MiB in 5 MiB parts; the part count");
  const auto upload = store::getUpload(parsed(tail).value("upload_id", ""));
  ctx.Assert(upload && upload->part_count == 3, "the upload record must hold part_count 3, got %d", upload ? upload->part_count : 0);
}

void CheckQuota(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto over = initAs(c, (5LL << 30) + 1, 64 * kMib, "k-1");
  const auto empty = initAs(c, 0, 5 * kMib, "k-2");
  ctx.Equal(over.Status, 413, "total_bytes 5 GiB + 1 is over the tenant quota (%s)", over.Text());
  ctx.Equal(empty.Status, 400, "total_bytes 0");
  ctx.Equal(created(ctx), 0, "uploads created for a total over the quota or not positive");
  const auto full = initAs(c, 5LL << 30, 64 * kMib, "k-3");
  ctx.Assert(full.Status == 201 && parsed(full).value("part_count", 0) == 80, "exactly 5 GiB in 64 MiB parts must be accepted as 80 parts, got %d %s", full.Status, full.Text());
}

void CheckIdempotency(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto first = initAs(c, 10 * kMib, 5 * kMib, "k-1");
  const auto retry = initAs(c, 10 * kMib, 5 * kMib, "k-1");
  ctx.Equal(first.Status, 201, "the first initiation (%s)", first.Text());
  const std::string first_id = parsed(first).value("upload_id", "");
  ctx.Assert((retry.Status == 200 || retry.Status == 201) && parsed(retry).value("upload_id", "") == first_id,
             "a retry with the same Idempotency-Key answered %d %s, expected the first upload %s: a second upload orphans every part the client sent to the first", retry.Status, retry.Text(), first_id);
  ctx.Equal(created(ctx), 1, "the retry must not create a second upload; uploads created");
  const std::string other = parsed(initAs(c, 10 * kMib, 5 * kMib, "k-1", "t2")).value("upload_id", "");
  const std::string fresh = parsed(initAs(c, 10 * kMib, 5 * kMib, "k-2")).value("upload_id", "");
  ctx.Assert(other != first_id, "another tenant's initiation with the same key got the first tenant's upload: the key is scoped to the tenant");
  ctx.Assert(fresh != first_id && fresh != other, "a new Idempotency-Key must create a new upload");
  const auto none = c.Post("/v1/uploads", body(10 * kMib, 5 * kMib), "Content-Type", "application/json", "X-Tenant-Id", "t1");
  ctx.Equal(none.Status, 400, "an initiation without Idempotency-Key");
  ctx.Equal(created(ctx), 3, "uploads created (k-1 for t1, k-1 for t2, k-2)");
}
`,
  },
  hints: [
    'Declare 1-byte parts and the upload is accepted with millions of parts; declare 11 MiB in 5 MiB parts and the plan has two; retry an initiation and a second upload id comes back.',
    'Nothing compares `part_bytes` or `total_bytes` with a limit, the floor division drops the short last part, and the handler mints an upload on every call because it never reads the `Idempotency-Key`.',
    'Read the key (400 when absent) and answer `store.initiation(tenant, key)` when it is set; check the total (400, 413) and the part size (400); `part_count = -(-total // part)`; `create_upload`, then `record_initiation`.',
  ],
  debrief: `Initiation is where an upload's cost is decided, so the bounds belong there: the part size fixes how many manifest entries and how many requests the upload will take, and the quota fixes how much storage one tenant can reserve before sending a byte. Rounding up gives the short tail a part number of its own. The idempotency record turns a client's timeout into a replay of the first answer instead of a second session that strands the parts already sent. Production services expire the idempotency record with the upload, store the request's fingerprint beside the key to refuse a reused key with a different body, and count the quota against bytes reserved by open uploads as well as committed ones.`,
};
