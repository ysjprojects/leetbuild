import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/batches: a sealed manifest, a cap and a key',
  concept: 'http',
  file: 'api',
  focus: ['client', 'batchd', 'store', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/batches\` with body \`{"manifest_uri", "model"}\`: it
answers 401 without \`X-Tenant-Id\`, reads the manifest's metadata with \`manifests.head\` (404 when there
is none), stores a batch with a fresh \`batch_id\`, \`record_count // SHARD_SIZE\` shards and status
\`queued\` through the provided store under \`(tenant, batch_id)\`, seeds the shards with \`shards.seed\` and
answers 202. It serves the demo and hides 4 flaws.

**Failure mode the checks target.** The submit decides what a batch costs. A client that retries a slow
submit starts a second run over the same million records; a manifest whose upload is still in flight
is sized from the parts that landed so far; nothing stops a batch past the cap; and the last partial
shard of records belongs to no shard at all.

Requirements:

- \`Idempotency-Key\` is required (**400** without it). A replay of the same \`(tenant, key)\` answers
  **200** with the stored batch (\`store.get\`); a new batch is stored with \`store.put(tenant, key, job)\`.
- \`manifests.head(uri)\` is the only source of \`record_count\`. No object is **404**; \`sealed\` false
  is **409** with nothing stored, so the client's retry after the upload starts the batch.
- \`record_count\` above \`MAX_RECORDS\` (1 000 000) is **400**, before anything is stored.
- \`shards = ceil(record_count / SHARD_SIZE)\`, seeded after \`store.put\`.
- A new batch answers **202** with \`{batch_id, status: "queued", model, manifest_uri, record_count,
  shards}\`.`,
  sequence: {
    participants: ['Client', 'batchd', 'Object store', 'Redis'],
    messages: [
      {from: 'Client', to: 'batchd', label: 'POST /v1/batches · X-Tenant-Id · Idempotency-Key', kind: 'sync'},
      {from: 'batchd', to: 'Redis', label: 'store.get(tenant, key)', kind: 'sync'},
      {from: 'Redis', to: 'batchd', label: 'stored batch / none', kind: 'reply'},
      {from: 'batchd', to: 'Object store', label: 'HEAD manifest', kind: 'sync'},
      {from: 'Object store', to: 'batchd', label: '{record_count, sealed}', kind: 'reply'},
      {from: 'batchd', to: 'Redis', label: 'store.put(tenant, key, job) · seed shards', kind: 'sync'},
      {from: 'batchd', to: 'Client', label: '202 {batch_id, status, shards, …}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/batches',
      detail:
        'A batch over a sealed 2000-record manifest answers 202 with batch_id, status queued, model, manifest_uri, record_count and shards, is stored, and has its two shards pending; without X-Tenant-Id the submit is 401.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/batches["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/batches['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/batches"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"batches"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/batches"/]},
      },
    },
    {
      id: 'idempotency-key',
      title: 'Keys batches by (tenant, Idempotency-Key)',
      detail:
        'Idempotency-Key is required (400 without it); a replay of the same (tenant, key) answers 200 with the same batch_id and seeds nothing again; another tenant with the same key gets its own batch. The starter stores each batch under its own fresh id, so every retry starts another run.',
      match: {
        python: {all: [/Idempotency-Key/i, /store\.get\(\s*tenant\s*,/, /store\.put\(\s*tenant\s*,\s*idem/]},
        typescript: {all: [/idempotency-key/i, /store\.get\(\s*tenant\s*,/, /store\.put\(\s*tenant\s*,\s*idem/]},
        go: {all: [/Idempotency-Key/, /jobs\.Get\(/, /jobs\.Put\([^,]+,\s*tenant\s*,\s*idem/]},
        scala: {all: [/Idempotency-Key/, /Jobs\.get\(\s*tenant\s*,/, /Jobs\.put\(\s*tenant\s*,\s*idem/]},
        cpp: {all: [/Idempotency-Key/, /jobs::get\(\s*tenant\s*,/, /jobs::put\(\s*tenant\s*,\s*idem/]},
      },
    },
    {
      id: 'record-cap',
      title: 'Refuses a manifest over one million records',
      detail:
        'A manifest of 1 000 001 records is 400 with no batch stored and no shard queued; exactly 1 000 000 is accepted with 1000 shards. The starter accepts any size.',
      match: {
        python: {order: [/record_count\s*>\s*MAX_RECORDS|MAX_RECORDS\s*<\s*\w/, /store\.put\(/]},
        typescript: {order: [/\w+\s*>\s*MAX_RECORDS|MAX_RECORDS\s*<\s*\w/, /store\.put\(/]},
        go: {order: [/\w+\s*>\s*config\.MaxRecords|config\.MaxRecords\s*<\s*\w/, /jobs\.Put\(/]},
        scala: {order: [/\w+\s*>\s*Config\.MaxRecords|Config\.MaxRecords\s*<\s*\w/, /Jobs\.put\(/]},
        cpp: {order: [/\w+\s*>\s*config::kMaxRecords|config::kMaxRecords\s*<\s*\w/, /jobs::put\(/]},
      },
    },
    {
      id: 'sealed-manifest',
      title: 'Answers 409 while the manifest is still uploading',
      detail:
        'A manifest whose sealed flag is false is 409 and stores nothing; once the uploader seals it, the same request and key start the batch with the full record count. The starter sizes the batch from the parts uploaded so far.',
      match: {
        python: {all: [/\[\s*["']sealed["']\s*\]|\.get\(\s*["']sealed["']/, /status_code\s*=\s*409/]},
        typescript: {all: [/\.sealed\b/, /code\(\s*409\s*\)/]},
        go: {all: [/\.Sealed\b/, /StatusConflict/]},
        scala: {all: [/\.isSealed\b/, /StatusCodes\.Conflict/]},
        cpp: {all: [/(\.|->)sealed\b/, /\b409\b/]},
      },
    },
    {
      id: 'shard-count',
      title: 'Rounds the shard count up',
      detail:
        'A manifest of 2500 records is three shards (0, 1, 2) on the pending list, and 999 records is one; the last partial shard is a shard. The starter divides with the floor, so the last 500 records are never run.',
      match: {
        python: {
          all: [/math\.ceil\(|SHARD_SIZE\s*-\s*1|-\s*\(\s*-\s*\w+/],
          none: [/record_count["'\]]*\s*\/\/\s*SHARD_SIZE/],
        },
        typescript: {all: [/Math\.ceil\(|SHARD_SIZE\s*-\s*1/], none: [/Math\.floor\(\s*[\w.]+\s*\/\s*SHARD_SIZE/]},
        go: {all: [/math\.Ceil\(|config\.ShardSize\s*-\s*1/], none: [/RecordCount\s*\/\s*config\.ShardSize/]},
        scala: {all: [/math\.ceil\(|Config\.ShardSize\s*-\s*1/], none: [/record_count\s*\/\s*Config\.ShardSize/]},
        cpp: {all: [/std::ceil\(|config::kShardSize\s*-\s*1/], none: [/record_count\s*\/\s*config::kShardSize/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
import uuid

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from batch import manifests, shards
from batch.config import SHARD_SIZE
from batch.jobs import store

app = FastAPI()
logger = logging.getLogger("batchd")


class BatchRequest(BaseModel):
    manifest_uri: str
    model: str


@app.post("/v1/batches")
def submit(body: BatchRequest, request: Request) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("X-Tenant-Id", "")
    if tenant == "":
        return JSONResponse({"error": "missing X-Tenant-Id"}, status_code=401)
    meta = manifests.head(body.manifest_uri)
    if meta is None:
        return JSONResponse({"error": "no manifest at manifest_uri"}, status_code=404)
    record_count = meta["record_count"]
    job = {
        "batch_id": str(uuid.uuid4()),
        "status": "queued",
        "model": body.model,
        "manifest_uri": body.manifest_uri,
        "record_count": record_count,
        "shards": record_count // SHARD_SIZE,
    }
    store.put(tenant, job["batch_id"], job)
    shards.seed(job["batch_id"], job["shards"])
    logger.info("batch %s queued: %d records, %d shards", job["batch_id"], record_count, job["shards"])
    return JSONResponse(job, status_code=202)
`,
      solution: `import logging
import math
import uuid

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from batch import manifests, shards
from batch.config import MAX_RECORDS, SHARD_SIZE
from batch.jobs import store

app = FastAPI()
logger = logging.getLogger("batchd")


class BatchRequest(BaseModel):
    manifest_uri: str
    model: str


@app.post("/v1/batches")
def submit(body: BatchRequest, request: Request) -> JSONResponse:
    tenant = request.headers.get("X-Tenant-Id", "")
    if tenant == "":
        return JSONResponse({"error": "missing X-Tenant-Id"}, status_code=401)
    idem_key = request.headers.get("Idempotency-Key", "")
    if idem_key == "":
        return JSONResponse({"error": "Idempotency-Key is required"}, status_code=400)
    stored = store.get(tenant, idem_key)
    if stored is not None:
        return JSONResponse(stored, status_code=200)

    meta = manifests.head(body.manifest_uri)
    if meta is None:
        return JSONResponse({"error": "no manifest at manifest_uri"}, status_code=404)
    if not meta["sealed"]:
        return JSONResponse({"error": "the manifest is still uploading"}, status_code=409)
    record_count = meta["record_count"]
    if record_count > MAX_RECORDS:
        return JSONResponse({"error": f"a batch holds at most {MAX_RECORDS} records"}, status_code=400)

    job = {
        "batch_id": str(uuid.uuid4()),
        "status": "queued",
        "model": body.model,
        "manifest_uri": body.manifest_uri,
        "record_count": record_count,
        "shards": math.ceil(record_count / SHARD_SIZE),
    }
    store.put(tenant, idem_key, job)
    shards.seed(job["batch_id"], job["shards"])
    logger.info("batch %s queued: %d records, %d shards", job["batch_id"], record_count, job["shards"])
    return JSONResponse(job, status_code=202)
`,
    },
    typescript: {
      starter: `import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import {SHARD_SIZE} from 'batch/config';
import {type Job, store} from 'batch/jobs';
import {manifests} from 'batch/manifests';
import {shards} from 'batch/shards';

export const app = Fastify();

interface BatchBody {
  manifest_uri: string;
  model: string;
}

app.post('/v1/batches', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const body = request.body as BatchBody;
  const meta = await manifests.head(body.manifest_uri);
  if (meta === null) return reply.code(404).send({error: 'no manifest at manifest_uri'});
  const job: Job = {
    batch_id: randomUUID(),
    status: 'queued',
    model: body.model,
    manifest_uri: body.manifest_uri,
    record_count: meta.record_count,
    shards: Math.floor(meta.record_count / SHARD_SIZE),
  };
  await store.put(tenant, job.batch_id, job);
  await shards.seed(job.batch_id, job.shards);
  request.log.info({batch_id: job.batch_id, records: job.record_count, shards: job.shards}, 'batch queued');
  return reply.code(202).send(job);
});
`,
      solution: `import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import {MAX_RECORDS, SHARD_SIZE} from 'batch/config';
import {type Job, store} from 'batch/jobs';
import {manifests} from 'batch/manifests';
import {shards} from 'batch/shards';

export const app = Fastify();

interface BatchBody {
  manifest_uri: string;
  model: string;
}

app.post('/v1/batches', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '') return reply.code(400).send({error: 'Idempotency-Key is required'});
  const stored = await store.get(tenant, idemKey);
  if (stored !== null) return reply.code(200).send(stored);

  const body = request.body as BatchBody;
  const meta = await manifests.head(body.manifest_uri);
  if (meta === null) return reply.code(404).send({error: 'no manifest at manifest_uri'});
  if (!meta.sealed) return reply.code(409).send({error: 'the manifest is still uploading'});
  if (meta.record_count > MAX_RECORDS) return reply.code(400).send({error: \`a batch holds at most \${MAX_RECORDS} records\`});

  const job: Job = {
    batch_id: randomUUID(),
    status: 'queued',
    model: body.model,
    manifest_uri: body.manifest_uri,
    record_count: meta.record_count,
    shards: Math.ceil(meta.record_count / SHARD_SIZE),
  };
  await store.put(tenant, idemKey, job);
  await shards.seed(job.batch_id, job.shards);
  request.log.info({batch_id: job.batch_id, records: job.record_count, shards: job.shards}, 'batch queued');
  return reply.code(202).send(job);
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/google/uuid"

	"batch/config"    // config.ShardSize, config.MaxRecords — provided
	"batch/jobs"      // jobs.Job, jobs.Get(ctx, tenant, idemKey), jobs.Put(ctx, tenant, idemKey, job) — provided
	"batch/manifests" // manifests.Head(ctx, uri) → *manifests.Meta{RecordCount, Sealed}, nil when absent — provided
	"batch/shards"    // shards.Seed(ctx, batchID, shardCount) — provided
)

type BatchRequest struct {
	ManifestURI string \`json:"manifest_uri"\`
	Model       string \`json:"model"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func submit(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	var body BatchRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	meta, err := manifests.Head(r.Context(), body.ManifestURI)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if meta == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no manifest at manifest_uri"})
		return
	}
	job := jobs.Job{
		BatchID:     uuid.NewString(),
		Status:      "queued",
		Model:       body.Model,
		ManifestURI: body.ManifestURI,
		RecordCount: meta.RecordCount,
		Shards:      meta.RecordCount / config.ShardSize,
	}
	if err := jobs.Put(r.Context(), tenant, job.BatchID, job); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if err := shards.Seed(r.Context(), job.BatchID, job.Shards); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("batch %s queued: %d records, %d shards", job.BatchID, job.RecordCount, job.Shards)
	writeJSON(rw, http.StatusAccepted, job)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/batches", submit)
}

func main() {
	mux := http.NewServeMux()
	register(mux)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
      solution: `package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"

	"github.com/google/uuid"

	"batch/config"    // config.ShardSize, config.MaxRecords — provided
	"batch/jobs"      // jobs.Job, jobs.Get(ctx, tenant, idemKey), jobs.Put(ctx, tenant, idemKey, job) — provided
	"batch/manifests" // manifests.Head(ctx, uri) → *manifests.Meta{RecordCount, Sealed}, nil when absent — provided
	"batch/shards"    // shards.Seed(ctx, batchID, shardCount) — provided
)

type BatchRequest struct {
	ManifestURI string \`json:"manifest_uri"\`
	Model       string \`json:"model"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func submit(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	idemKey := r.Header.Get("Idempotency-Key")
	if idemKey == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "Idempotency-Key is required"})
		return
	}
	stored, err := jobs.Get(r.Context(), tenant, idemKey)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if stored != nil {
		writeJSON(rw, http.StatusOK, stored)
		return
	}

	var body BatchRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	meta, err := manifests.Head(r.Context(), body.ManifestURI)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if meta == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no manifest at manifest_uri"})
		return
	}
	if !meta.Sealed {
		writeJSON(rw, http.StatusConflict, map[string]string{"error": "the manifest is still uploading"})
		return
	}
	if meta.RecordCount > config.MaxRecords {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("a batch holds at most %d records", config.MaxRecords)})
		return
	}

	job := jobs.Job{
		BatchID:     uuid.NewString(),
		Status:      "queued",
		Model:       body.Model,
		ManifestURI: body.ManifestURI,
		RecordCount: meta.RecordCount,
		Shards:      (meta.RecordCount + config.ShardSize - 1) / config.ShardSize,
	}
	if err := jobs.Put(r.Context(), tenant, idemKey, job); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if err := shards.Seed(r.Context(), job.BatchID, job.Shards); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("batch %s queued: %d records, %d shards", job.BatchID, job.RecordCount, job.Shards)
	writeJSON(rw, http.StatusAccepted, job)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/batches", submit)
}

func main() {
	mux := http.NewServeMux()
	register(mux)
	log.Fatal(http.ListenAndServe(":8443", mux))
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

import batch.{Config, Job, Jobs, Manifests, Shards}

final case class BatchRequest(manifest_uri: String, model: String)

object BatchApi {
  implicit val system: ActorSystem = ActorSystem("batch-inference")
  implicit val requestFormat: RootJsonFormat[BatchRequest] = jsonFormat2(BatchRequest)
  implicit val jobFormat: RootJsonFormat[Job] = jsonFormat6(Job)

  val route: Route =
    path("v1" / "batches") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          entity(as[BatchRequest]) { body =>
            // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
            if (!tenantOpt.exists(_.nonEmpty)) {
              complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
            } else {
              Manifests.head(body.manifest_uri) match {
                case None =>
                  complete(StatusCodes.NotFound, """{"error":"no manifest at manifest_uri"}""")
                case Some(meta) =>
                  val job = Job(
                    UUID.randomUUID().toString,
                    "queued",
                    body.model,
                    body.manifest_uri,
                    meta.record_count,
                    meta.record_count / Config.ShardSize
                  )
                  Jobs.put(tenantOpt.get, job.batch_id, job)
                  Shards.seed(job.batch_id, job.shards)
                  system.log.info(s"batch \${job.batch_id} queued: \${job.record_count} records, \${job.shards} shards")
                  complete(StatusCodes.Accepted, job)
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
      solution: `import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

import batch.{Config, Job, Jobs, Manifests, Shards}

final case class BatchRequest(manifest_uri: String, model: String)

object BatchApi {
  implicit val system: ActorSystem = ActorSystem("batch-inference")
  implicit val requestFormat: RootJsonFormat[BatchRequest] = jsonFormat2(BatchRequest)
  implicit val jobFormat: RootJsonFormat[Job] = jsonFormat6(Job)

  val route: Route =
    path("v1" / "batches") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          optionalHeaderValueByName("Idempotency-Key") { idemOpt =>
            entity(as[BatchRequest]) { body =>
              if (!tenantOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
              } else if (!idemOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.BadRequest, """{"error":"Idempotency-Key is required"}""")
              } else {
                val tenant = tenantOpt.get
                val idemKey = idemOpt.get
                Jobs.get(tenant, idemKey) match {
                  case Some(stored) => complete(StatusCodes.OK, stored.job)
                  case None =>
                    Manifests.head(body.manifest_uri) match {
                      case None =>
                        complete(StatusCodes.NotFound, """{"error":"no manifest at manifest_uri"}""")
                      case Some(meta) if !meta.isSealed =>
                        complete(StatusCodes.Conflict, """{"error":"the manifest is still uploading"}""")
                      case Some(meta) if meta.record_count > Config.MaxRecords =>
                        complete(StatusCodes.BadRequest, """{"error":"a batch holds at most 1000000 records"}""")
                      case Some(meta) =>
                        val job = Job(
                          UUID.randomUUID().toString,
                          "queued",
                          body.model,
                          body.manifest_uri,
                          meta.record_count,
                          (meta.record_count + Config.ShardSize - 1) / Config.ShardSize
                        )
                        Jobs.put(tenant, idemKey, job)
                        Shards.seed(job.batch_id, job.shards)
                        system.log.info(s"batch \${job.batch_id} queued: \${job.record_count} records, \${job.shards} shards")
                        complete(StatusCodes.Accepted, job)
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

#include "batch/config.h"     // config::kShardSize, config::kMaxRecords — provided
#include "batch/jobs.h"       // jobs::get(tenant, idem_key), jobs::put(tenant, idem_key, job) — provided
#include "batch/manifests.h"  // manifests::head(uri) → std::optional<manifests::Head>{record_count, sealed} — provided
#include "batch/shards.h"     // shards::seed(batch_id, shard_count) — provided
#include "ids.h"              // new_uuid() — provided

using json = nlohmann::json;

void reject(httplib::Response& res, int status, const std::string& error) {
  res.status = status;
  res.set_content(json({{"error", error}}).dump(), "application/json");
}

void submit(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reject(res, 401, "missing X-Tenant-Id");
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return reject(res, 400, "invalid json");
  const std::string manifest_uri = body.value("manifest_uri", std::string());
  const auto meta = manifests::head(manifest_uri);
  if (!meta) return reject(res, 404, "no manifest at manifest_uri");
  const json job = {
      {"batch_id", new_uuid()},
      {"status", "queued"},
      {"model", body.value("model", std::string())},
      {"manifest_uri", manifest_uri},
      {"record_count", meta->record_count},
      {"shards", meta->record_count / config::kShardSize},
  };
  const std::string batch_id = job["batch_id"].get<std::string>();
  jobs::put(tenant, batch_id, job);
  shards::seed(batch_id, job["shards"].get<long long>());
  std::cerr << "batch " << batch_id << " queued: " << meta->record_count << " records\\n";
  res.status = 202;
  res.set_content(job.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/batches", submit); }

int main() {
  httplib::Server svr;
  register_routes(svr);
  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <string>

#include "batch/config.h"     // config::kShardSize, config::kMaxRecords — provided
#include "batch/jobs.h"       // jobs::get(tenant, idem_key), jobs::put(tenant, idem_key, job) — provided
#include "batch/manifests.h"  // manifests::head(uri) → std::optional<manifests::Head>{record_count, sealed} — provided
#include "batch/shards.h"     // shards::seed(batch_id, shard_count) — provided
#include "ids.h"              // new_uuid() — provided

using json = nlohmann::json;

void reject(httplib::Response& res, int status, const std::string& error) {
  res.status = status;
  res.set_content(json({{"error", error}}).dump(), "application/json");
}

void submit(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reject(res, 401, "missing X-Tenant-Id");
  const std::string idem_key = req.get_header_value("Idempotency-Key");
  if (idem_key.empty()) return reject(res, 400, "Idempotency-Key is required");
  if (const auto stored = jobs::get(tenant, idem_key)) {
    res.status = 200;
    res.set_content(stored->dump(), "application/json");
    return;
  }

  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return reject(res, 400, "invalid json");
  const std::string manifest_uri = body.value("manifest_uri", std::string());
  const auto meta = manifests::head(manifest_uri);
  if (!meta) return reject(res, 404, "no manifest at manifest_uri");
  if (!meta->sealed) return reject(res, 409, "the manifest is still uploading");
  if (meta->record_count > config::kMaxRecords) return reject(res, 400, "a batch holds at most 1000000 records");

  const json job = {
      {"batch_id", new_uuid()},
      {"status", "queued"},
      {"model", body.value("model", std::string())},
      {"manifest_uri", manifest_uri},
      {"record_count", meta->record_count},
      {"shards", (meta->record_count + config::kShardSize - 1) / config::kShardSize},
  };
  const std::string batch_id = job["batch_id"].get<std::string>();
  jobs::put(tenant, idem_key, job);
  shards::seed(batch_id, job["shards"].get<long long>());
  std::cerr << "batch " << batch_id << " queued: " << meta->record_count << " records\\n";
  res.status = 202;
  res.set_content(job.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/batches", submit); }

int main() {
  httplib::Server svr;
  register_routes(svr);
  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  harness: {
    python: `MANIFEST = "s3://acme-batches/2026-11/support-tickets.jsonl"
GOOD = {"manifest_uri": MANIFEST, "model": "sum-v7"}
FIELDS = ("batch_id", "status", "model", "manifest_uri", "record_count", "shards")


def _api(ctx):
    return ctx.client(ctx.load("api").app)


def _manifest(ctx, records, sealed=True, uri=MANIFEST):
    """What the uploader leaves in the object store's metadata."""
    ctx.redis.hset(f"batch:manifest:{uri}", mapping={"record_count": records, "sealed": "1" if sealed else "0"})


async def _post(c, body=GOOD, key="k-1", tenant="t1", with_key=True):
    headers = {"X-Tenant-Id": tenant}
    if with_key:
        headers["Idempotency-Key"] = key
    return await c.post("/v1/batches", json=body, headers=headers)


def _jobs(ctx):
    return ctx.redis.keys("batch:job:*")


def _pending(ctx, batch_id):
    return ctx.redis.lrange(f"batch:pending:{batch_id}", 0, -1)


async def check_route(ctx):
    _manifest(ctx, 2000)
    async with _api(ctx) as c:
        r = await _post(c)
        assert r.status_code == 202, f"a submit over a sealed 2000-record manifest answered {r.status_code}: {r.text}"
        job = r.json()
        for key in FIELDS:
            assert key in job, f"the 202 body lacks {key!r}: {job}"
        assert job["status"] == "queued" and job["model"] == "sum-v7" and job["manifest_uri"] == MANIFEST, f"the batch echoes the request with status queued: {job}"
        assert job["record_count"] == 2000 and job["shards"] == 2, f"2000 records are 2 shards of 1000: {job}"
        assert ctx.redis.get(f"batch:job:{job['batch_id']}") is not None, f"the batch must be in the store (batch:job:{{id}}): keys {sorted(ctx.redis.keys('batch:*'))}"
        assert _pending(ctx, job["batch_id"]) == ["0", "1"], f"shards 0 and 1 must be pending, batch:pending holds {_pending(ctx, job['batch_id'])}"
        r = await c.post("/v1/batches", json=GOOD, headers={"Idempotency-Key": "k-1"})
        assert r.status_code == 401, f"without X-Tenant-Id the submit must answer 401, got {r.status_code}"


async def check_idempotency_key(ctx):
    _manifest(ctx, 2000)
    async with _api(ctx) as c:
        r = await _post(c, with_key=False)
        assert r.status_code == 400, f"a submit without Idempotency-Key answered {r.status_code}, expected 400"
        assert _jobs(ctx) == [], f"a refused submit must store no batch, found {_jobs(ctx)}"
        first = await _post(c, key="k-7")
        assert first.status_code == 202, f"the first submit answered {first.status_code}: {first.text}"
        replay = await _post(c, key="k-7")
        assert replay.status_code == 200, f"a replay of the same (tenant, Idempotency-Key) answered {replay.status_code}, expected 200 with the stored batch: the client retried, it must not start a second run"
        batch_id = first.json()["batch_id"]
        assert replay.json()["batch_id"] == batch_id, f"the replay must answer the same batch: got {replay.json()['batch_id']}, the first submit made {batch_id}"
        assert len(_jobs(ctx)) == 1, f"one key, one batch: the store holds {len(_jobs(ctx))} batches after a submit and its replay"
        assert _pending(ctx, batch_id) == ["0", "1"], f"the replay must not seed the shards again: batch:pending holds {_pending(ctx, batch_id)}"
        other = await _post(c, key="k-7", tenant="t2")
        assert other.status_code == 202 and other.json()["batch_id"] != batch_id, "another tenant reusing the key gets its own batch (keys are per tenant)"


async def check_record_cap(ctx):
    big = "s3://acme-batches/2026-11/everything.jsonl"
    _manifest(ctx, 1_000_001, uri=big)
    async with _api(ctx) as c:
        r = await _post(c, {"manifest_uri": big, "model": "sum-v7"}, key="k-big")
        assert r.status_code == 400, f"a manifest of 1 000 001 records answered {r.status_code}, expected 400: a batch holds at most MAX_RECORDS"
        assert _jobs(ctx) == [] and ctx.redis.keys("batch:pending:*") == [], f"a refused batch must store nothing and queue nothing, found {sorted(ctx.redis.keys('batch:*'))}"
        at_cap = "s3://acme-batches/2026-11/one-million.jsonl"
        _manifest(ctx, 1_000_000, uri=at_cap)
        r = await _post(c, {"manifest_uri": at_cap, "model": "sum-v7"}, key="k-cap")
        assert r.status_code == 202, f"exactly 1 000 000 records is within the cap, got {r.status_code}: {r.text}"
        assert r.json()["shards"] == 1000 and ctx.redis.llen(f"batch:pending:{r.json()['batch_id']}") == 1000, f"1 000 000 records are 1000 shards: {r.json()}"


async def check_sealed_manifest(ctx):
    _manifest(ctx, 1200, sealed=False)
    async with _api(ctx) as c:
        r = await _post(c, key="k-up")
        assert r.status_code == 409, f"a manifest still uploading (1200 records so far, sealed false) answered {r.status_code}, expected 409: the batch would be sized from the parts that landed"
        assert _jobs(ctx) == [] and ctx.redis.keys("batch:pending:*") == [], f"a 409 must store nothing and queue nothing, found {sorted(ctx.redis.keys('batch:*'))}"
        _manifest(ctx, 2500, sealed=True)
        r = await _post(c, key="k-up")
        assert r.status_code == 202, f"once the manifest is sealed the same request and key must start the batch, got {r.status_code}: {r.text}"
        assert r.json()["record_count"] == 2500, f"the batch must be sized from the sealed manifest (2500 records): {r.json()}"
        r = await _post(c, {"manifest_uri": "s3://acme-batches/missing.jsonl", "model": "sum-v7"}, key="k-none")
        assert r.status_code == 404, f"no object at manifest_uri must answer 404, got {r.status_code}"


async def check_shard_count(ctx):
    _manifest(ctx, 2500)
    async with _api(ctx) as c:
        r = await _post(c, key="k-2500")
        assert r.status_code == 202, f"a 2500-record submit answered {r.status_code}: {r.text}"
        job = r.json()
        assert job["shards"] == 3, f"2500 records at 1000 per shard are 3 shards, the batch says {job['shards']}: the last 500 records belong to no shard and are never run"
        assert _pending(ctx, job["batch_id"]) == ["0", "1", "2"], f"shards 0, 1 and 2 must be pending, batch:pending holds {_pending(ctx, job['batch_id'])}"
        small = "s3://acme-batches/2026-11/small.jsonl"
        _manifest(ctx, 999, uri=small)
        r = await _post(c, {"manifest_uri": small, "model": "sum-v7"}, key="k-999")
        assert r.status_code == 202 and r.json()["shards"] == 1, f"999 records are one shard: {r.text}"
`,
    typescript: `const MANIFEST = 's3://acme-batches/2026-11/support-tickets.jsonl';
const GOOD = {manifest_uri: MANIFEST, model: 'sum-v7'};
const FIELDS = ['batch_id', 'status', 'model', 'manifest_uri', 'record_count', 'shards'];

function api(ctx) {
  return ctx.client(ctx.load('api').app);
}

/** What the uploader leaves in the object store's metadata. */
function manifest(ctx, records: number, sealed = true, uri = MANIFEST) {
  ctx.redis.hset(\`batch:manifest:\${uri}\`, 'record_count', String(records), 'sealed', sealed ? '1' : '0');
}

async function post(c, body: object = GOOD, {key = 'k-1', tenant = 't1', withKey = true} = {}) {
  const headers: Record<string, string> = {'X-Tenant-Id': tenant};
  if (withKey) headers['Idempotency-Key'] = key;
  return c.post('/v1/batches', {body, headers});
}

const jobs = ctx => ctx.redis.keys('batch:job:*');
const pending = (ctx, batchId: string) => ctx.redis.lrange(\`batch:pending:\${batchId}\`, 0, -1);

export async function check_route(ctx) {
  manifest(ctx, 2000);
  const c = api(ctx);
  const r = await post(c);
  assert.equal(r.status, 202, \`a submit over a sealed 2000-record manifest answered \${r.status}: \${r.text}\`);
  const job = r.json();
  for (const key of FIELDS) assert(key in job, \`the 202 body lacks \${key}: \${r.text}\`);
  assert(job.status === 'queued' && job.model === 'sum-v7' && job.manifest_uri === MANIFEST, \`the batch echoes the request with status queued: \${r.text}\`);
  assert(job.record_count === 2000 && job.shards === 2, \`2000 records are 2 shards of 1000: \${r.text}\`);
  assert(ctx.redis.get(\`batch:job:\${job.batch_id}\`) !== null, \`the batch must be in the store (batch:job:{id}): keys \${JSON.stringify(ctx.redis.keys('batch:*').sort())}\`);
  assert.deepEqual(pending(ctx, job.batch_id), ['0', '1'], \`shards 0 and 1 must be pending, batch:pending holds \${JSON.stringify(pending(ctx, job.batch_id))}\`);
  const noTenant = await c.post('/v1/batches', {body: GOOD, headers: {'Idempotency-Key': 'k-1'}});
  assert.equal(noTenant.status, 401, \`without X-Tenant-Id the submit must answer 401, got \${noTenant.status}\`);
}

export async function check_idempotency_key(ctx) {
  manifest(ctx, 2000);
  const c = api(ctx);
  const noKey = await post(c, GOOD, {withKey: false});
  assert.equal(noKey.status, 400, \`a submit without Idempotency-Key answered \${noKey.status}, expected 400\`);
  assert.deepEqual(jobs(ctx), [], \`a refused submit must store no batch, found \${JSON.stringify(jobs(ctx))}\`);
  const first = await post(c, GOOD, {key: 'k-7'});
  assert.equal(first.status, 202, \`the first submit answered \${first.status}: \${first.text}\`);
  const replay = await post(c, GOOD, {key: 'k-7'});
  assert.equal(replay.status, 200, \`a replay of the same (tenant, Idempotency-Key) answered \${replay.status}, expected 200 with the stored batch: the client retried, it must not start a second run\`);
  const batchId = first.json().batch_id;
  assert.equal(replay.json().batch_id, batchId, \`the replay must answer the same batch: got \${replay.json().batch_id}, the first submit made \${batchId}\`);
  assert.equal(jobs(ctx).length, 1, \`one key, one batch: the store holds \${jobs(ctx).length} batches after a submit and its replay\`);
  assert.deepEqual(pending(ctx, batchId), ['0', '1'], \`the replay must not seed the shards again: batch:pending holds \${JSON.stringify(pending(ctx, batchId))}\`);
  const other = await post(c, GOOD, {key: 'k-7', tenant: 't2'});
  assert(other.status === 202 && other.json().batch_id !== batchId, 'another tenant reusing the key gets its own batch (keys are per tenant)');
}

export async function check_record_cap(ctx) {
  const big = 's3://acme-batches/2026-11/everything.jsonl';
  manifest(ctx, 1_000_001, true, big);
  const c = api(ctx);
  let r = await post(c, {manifest_uri: big, model: 'sum-v7'}, {key: 'k-big'});
  assert.equal(r.status, 400, \`a manifest of 1 000 001 records answered \${r.status}, expected 400: a batch holds at most MAX_RECORDS\`);
  assert(jobs(ctx).length === 0 && ctx.redis.keys('batch:pending:*').length === 0, \`a refused batch must store nothing and queue nothing, found \${JSON.stringify(ctx.redis.keys('batch:*').sort())}\`);
  const atCap = 's3://acme-batches/2026-11/one-million.jsonl';
  manifest(ctx, 1_000_000, true, atCap);
  r = await post(c, {manifest_uri: atCap, model: 'sum-v7'}, {key: 'k-cap'});
  assert.equal(r.status, 202, \`exactly 1 000 000 records is within the cap, got \${r.status}: \${r.text}\`);
  assert(r.json().shards === 1000 && Number(ctx.redis.llen(\`batch:pending:\${r.json().batch_id}\`)) === 1000, \`1 000 000 records are 1000 shards: \${r.text}\`);
}

export async function check_sealed_manifest(ctx) {
  manifest(ctx, 1200, false);
  const c = api(ctx);
  let r = await post(c, GOOD, {key: 'k-up'});
  assert.equal(r.status, 409, \`a manifest still uploading (1200 records so far, sealed false) answered \${r.status}, expected 409: the batch would be sized from the parts that landed\`);
  assert(jobs(ctx).length === 0 && ctx.redis.keys('batch:pending:*').length === 0, \`a 409 must store nothing and queue nothing, found \${JSON.stringify(ctx.redis.keys('batch:*').sort())}\`);
  manifest(ctx, 2500, true);
  r = await post(c, GOOD, {key: 'k-up'});
  assert.equal(r.status, 202, \`once the manifest is sealed the same request and key must start the batch, got \${r.status}: \${r.text}\`);
  assert.equal(r.json().record_count, 2500, \`the batch must be sized from the sealed manifest (2500 records): \${r.text}\`);
  r = await post(c, {manifest_uri: 's3://acme-batches/missing.jsonl', model: 'sum-v7'}, {key: 'k-none'});
  assert.equal(r.status, 404, \`no object at manifest_uri must answer 404, got \${r.status}\`);
}

export async function check_shard_count(ctx) {
  manifest(ctx, 2500);
  const c = api(ctx);
  let r = await post(c, GOOD, {key: 'k-2500'});
  assert.equal(r.status, 202, \`a 2500-record submit answered \${r.status}: \${r.text}\`);
  const job = r.json();
  assert.equal(job.shards, 3, \`2500 records at 1000 per shard are 3 shards, the batch says \${job.shards}: the last 500 records belong to no shard and are never run\`);
  assert.deepEqual(pending(ctx, job.batch_id), ['0', '1', '2'], \`shards 0, 1 and 2 must be pending, batch:pending holds \${JSON.stringify(pending(ctx, job.batch_id))}\`);
  const small = 's3://acme-batches/2026-11/small.jsonl';
  manifest(ctx, 999, true, small);
  r = await post(c, {manifest_uri: small, model: 'sum-v7'}, {key: 'k-999'});
  assert(r.status === 202 && r.json().shards === 1, \`999 records are one shard: \${r.text}\`);
}
`,
    go: `package main

import (
	"fmt"
	"net/http"

	"leetbuild/harness"
)

const apiManifest = "s3://acme-batches/2026-11/support-tickets.jsonl"

func apiClient(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

// apiSeedManifest is what the uploader leaves in the object store's metadata.
func apiSeedManifest(ctx *harness.Ctx, uri string, records int, sealed bool) {
	flag := "0"
	if sealed {
		flag = "1"
	}
	ctx.Redis.Do("HSET", "batch:manifest:"+uri, "record_count", records, "sealed", flag)
}

func apiBody(uri string) map[string]any { return map[string]any{"manifest_uri": uri, "model": "sum-v7"} }

func apiPost(c *harness.HTTP, body map[string]any, key, tenant string) *harness.Response {
	return c.Post("/v1/batches", body, "X-Tenant-Id", tenant, "Idempotency-Key", key)
}

func apiJob(ctx *harness.Ctx, r *harness.Response) map[string]any {
	job, ok := r.JSON().(map[string]any)
	ctx.Assert(ok, "the body must be a JSON object: %s", r.Text())
	return job
}

func apiPending(ctx *harness.Ctx, batchID any) []string {
	return ctx.Redis.LRange(fmt.Sprint("batch:pending:", batchID), 0, -1)
}

func CheckRoute(ctx *harness.Ctx) {
	apiSeedManifest(ctx, apiManifest, 2000, true)
	c := apiClient(ctx)
	r := apiPost(c, apiBody(apiManifest), "k-1", "t1")
	ctx.Equal(r.Status, 202, "a submit over a sealed 2000-record manifest (%s)", r.Text())
	job := apiJob(ctx, r)
	for _, key := range []string{"batch_id", "status", "model", "manifest_uri", "record_count", "shards"} {
		_, ok := job[key]
		ctx.Assert(ok, "the 202 body lacks %s: %s", key, r.Text())
	}
	ctx.Assert(job["status"] == "queued" && job["model"] == "sum-v7" && job["manifest_uri"] == apiManifest, "the batch echoes the request with status queued: %s", r.Text())
	ctx.Assert(job["record_count"] == float64(2000) && job["shards"] == float64(2), "2000 records are 2 shards of 1000: %s", r.Text())
	_, stored := ctx.Redis.Get(fmt.Sprint("batch:job:", job["batch_id"]))
	ctx.Assert(stored, "the batch must be in the store (batch:job:{id}): keys %v", ctx.Redis.Keys("batch:*"))
	ctx.Equal(apiPending(ctx, job["batch_id"]), []string{"0", "1"}, "shards 0 and 1 must be pending; batch:pending holds")
	noTenant := c.Post("/v1/batches", apiBody(apiManifest), "Idempotency-Key", "k-1")
	ctx.Equal(noTenant.Status, 401, "without X-Tenant-Id the submit")
}

func CheckIdempotencyKey(ctx *harness.Ctx) {
	apiSeedManifest(ctx, apiManifest, 2000, true)
	c := apiClient(ctx)
	noKey := c.Post("/v1/batches", apiBody(apiManifest), "X-Tenant-Id", "t1")
	ctx.Equal(noKey.Status, 400, "a submit without Idempotency-Key")
	ctx.Equal(len(ctx.Redis.Keys("batch:job:*")), 0, "a refused submit must store no batch; batches stored")
	first := apiPost(c, apiBody(apiManifest), "k-7", "t1")
	ctx.Equal(first.Status, 202, "the first submit (%s)", first.Text())
	replay := apiPost(c, apiBody(apiManifest), "k-7", "t1")
	ctx.Equal(replay.Status, 200, "a replay of the same (tenant, Idempotency-Key) must answer the stored batch (the client retried, it must not start a second run)")
	batchID := apiJob(ctx, first)["batch_id"]
	ctx.Equal(apiJob(ctx, replay)["batch_id"], batchID, "the replay must answer the same batch")
	ctx.Equal(len(ctx.Redis.Keys("batch:job:*")), 1, "one key, one batch: batches stored after a submit and its replay")
	ctx.Equal(apiPending(ctx, batchID), []string{"0", "1"}, "the replay must not seed the shards again; batch:pending holds")
	other := apiPost(c, apiBody(apiManifest), "k-7", "t2")
	ctx.Assert(other.Status == 202 && apiJob(ctx, other)["batch_id"] != batchID, "another tenant reusing the key gets its own batch (keys are per tenant)")
}

func CheckRecordCap(ctx *harness.Ctx) {
	big := "s3://acme-batches/2026-11/everything.jsonl"
	apiSeedManifest(ctx, big, 1_000_001, true)
	c := apiClient(ctx)
	r := apiPost(c, apiBody(big), "k-big", "t1")
	ctx.Equal(r.Status, 400, "a manifest of 1 000 001 records: a batch holds at most MaxRecords")
	ctx.Assert(len(ctx.Redis.Keys("batch:job:*")) == 0 && len(ctx.Redis.Keys("batch:pending:*")) == 0, "a refused batch must store nothing and queue nothing, found %v", ctx.Redis.Keys("batch:*"))
	atCap := "s3://acme-batches/2026-11/one-million.jsonl"
	apiSeedManifest(ctx, atCap, 1_000_000, true)
	r = apiPost(c, apiBody(atCap), "k-cap", "t1")
	ctx.Equal(r.Status, 202, "exactly 1 000 000 records is within the cap (%s)", r.Text())
	job := apiJob(ctx, r)
	ctx.Assert(job["shards"] == float64(1000) && len(apiPending(ctx, job["batch_id"])) == 1000, "1 000 000 records are 1000 shards: %s", r.Text())
}

func CheckSealedManifest(ctx *harness.Ctx) {
	apiSeedManifest(ctx, apiManifest, 1200, false)
	c := apiClient(ctx)
	r := apiPost(c, apiBody(apiManifest), "k-up", "t1")
	ctx.Equal(r.Status, 409, "a manifest still uploading (1200 records so far, sealed false): the batch would be sized from the parts that landed")
	ctx.Assert(len(ctx.Redis.Keys("batch:job:*")) == 0 && len(ctx.Redis.Keys("batch:pending:*")) == 0, "a 409 must store nothing and queue nothing, found %v", ctx.Redis.Keys("batch:*"))
	apiSeedManifest(ctx, apiManifest, 2500, true)
	r = apiPost(c, apiBody(apiManifest), "k-up", "t1")
	ctx.Equal(r.Status, 202, "once the manifest is sealed the same request and key must start the batch (%s)", r.Text())
	ctx.Equal(apiJob(ctx, r)["record_count"], float64(2500), "the batch must be sized from the sealed manifest; record_count")
	r = apiPost(c, apiBody("s3://acme-batches/missing.jsonl"), "k-none", "t1")
	ctx.Equal(r.Status, 404, "no object at manifest_uri")
}

func CheckShardCount(ctx *harness.Ctx) {
	apiSeedManifest(ctx, apiManifest, 2500, true)
	c := apiClient(ctx)
	r := apiPost(c, apiBody(apiManifest), "k-2500", "t1")
	ctx.Equal(r.Status, 202, "a 2500-record submit (%s)", r.Text())
	job := apiJob(ctx, r)
	ctx.Equal(job["shards"], float64(3), "2500 records at 1000 per shard are 3 shards (with fewer, the last 500 records belong to no shard and are never run); shards")
	ctx.Equal(apiPending(ctx, job["batch_id"]), []string{"0", "1", "2"}, "shards 0, 1 and 2 must be pending; batch:pending holds")
	small := "s3://acme-batches/2026-11/small.jsonl"
	apiSeedManifest(ctx, small, 999, true)
	r = apiPost(c, apiBody(small), "k-999", "t1")
	ctx.Assert(r.Status == 202 && apiJob(ctx, r)["shards"] == float64(1), "999 records are one shard: %s", r.Text())
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

namespace {

using json = nlohmann::json;

const std::string kManifest = "s3://acme-batches/2026-11/support-tickets.jsonl";

struct Api {
  httplib::Server svr;
  harness::HTTP http;
  explicit Api(harness::Ctx& ctx) : http(ctx.HTTP(svr)) { register_routes(svr); }

  harness::Response post(const std::string& uri, const std::string& key, const std::string& tenant = "t1") {
    return http.Post("/v1/batches", json{{"manifest_uri", uri}, {"model", "sum-v7"}}.dump(), "X-Tenant-Id", tenant, "Idempotency-Key", key);
  }
};

// What the uploader leaves in the object store's metadata.
void seedManifest(harness::Ctx& ctx, const std::string& uri, long long records, bool sealed) {
  ctx.Redis.Do("HSET", "batch:manifest:" + uri, "record_count", records, "sealed", sealed ? "1" : "0");
}

json jobOf(harness::Ctx& ctx, const harness::Response& r) {
  const json job = json::parse(r.Text(), nullptr, false);
  ctx.Assert(job.is_object(), "the body must be a JSON object: %s", r.Text());
  return job;
}

std::vector<std::string> pendingOf(harness::Ctx& ctx, const json& batchId) {
  return ctx.Redis.LRange("batch:pending:" + (batchId.is_string() ? batchId.get<std::string>() : std::string()), 0, -1);
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  seedManifest(ctx, kManifest, 2000, true);
  Api api(ctx);
  const auto r = api.post(kManifest, "k-1");
  ctx.Equal(r.Status, 202, "a submit over a sealed 2000-record manifest (%s)", r.Text());
  const json job = jobOf(ctx, r);
  for (const char* key : {"batch_id", "status", "model", "manifest_uri", "record_count", "shards"}) {
    ctx.Assert(job.contains(key), "the 202 body lacks %s: %s", key, r.Text());
  }
  ctx.Assert(job["status"] == "queued" && job["model"] == "sum-v7" && job["manifest_uri"] == kManifest, "the batch echoes the request with status queued: %s", r.Text());
  ctx.Assert(job["record_count"] == 2000 && job["shards"] == 2, "2000 records are 2 shards of 1000: %s", r.Text());
  ctx.Assert(ctx.Redis.Get("batch:job:" + job["batch_id"].get<std::string>()).has_value(), "the batch must be in the store (batch:job:{id}): keys %v", ctx.Redis.Keys("batch:*"));
  ctx.Equal(pendingOf(ctx, job["batch_id"]), {"0", "1"}, "shards 0 and 1 must be pending; batch:pending holds");
  const auto noTenant = api.http.Post("/v1/batches", json{{"manifest_uri", kManifest}, {"model", "sum-v7"}}.dump(), "Idempotency-Key", "k-1");
  ctx.Equal(noTenant.Status, 401, "without X-Tenant-Id the submit");
}

void CheckIdempotencyKey(harness::Ctx& ctx) {
  seedManifest(ctx, kManifest, 2000, true);
  Api api(ctx);
  const auto noKey = api.http.Post("/v1/batches", json{{"manifest_uri", kManifest}, {"model", "sum-v7"}}.dump(), "X-Tenant-Id", "t1");
  ctx.Equal(noKey.Status, 400, "a submit without Idempotency-Key");
  ctx.Equal(ctx.Redis.Keys("batch:job:*").size(), 0, "a refused submit must store no batch; batches stored");
  const auto first = api.post(kManifest, "k-7");
  ctx.Equal(first.Status, 202, "the first submit (%s)", first.Text());
  const auto replay = api.post(kManifest, "k-7");
  ctx.Equal(replay.Status, 200, "a replay of the same (tenant, Idempotency-Key) must answer the stored batch (the client retried, it must not start a second run)");
  const json batchId = jobOf(ctx, first)["batch_id"];
  ctx.Equal(jobOf(ctx, replay)["batch_id"], batchId, "the replay must answer the same batch");
  ctx.Equal(ctx.Redis.Keys("batch:job:*").size(), 1, "one key, one batch: batches stored after a submit and its replay");
  ctx.Equal(pendingOf(ctx, batchId), {"0", "1"}, "the replay must not seed the shards again; batch:pending holds");
  const auto other = api.post(kManifest, "k-7", "t2");
  ctx.Assert(other.Status == 202 && jobOf(ctx, other)["batch_id"] != batchId, "another tenant reusing the key gets its own batch (keys are per tenant)");
}

void CheckRecordCap(harness::Ctx& ctx) {
  const std::string big = "s3://acme-batches/2026-11/everything.jsonl";
  seedManifest(ctx, big, 1000001, true);
  Api api(ctx);
  auto r = api.post(big, "k-big");
  ctx.Equal(r.Status, 400, "a manifest of 1 000 001 records: a batch holds at most kMaxRecords");
  ctx.Assert(ctx.Redis.Keys("batch:job:*").empty() && ctx.Redis.Keys("batch:pending:*").empty(), "a refused batch must store nothing and queue nothing, found %v", ctx.Redis.Keys("batch:*"));
  const std::string atCap = "s3://acme-batches/2026-11/one-million.jsonl";
  seedManifest(ctx, atCap, 1000000, true);
  r = api.post(atCap, "k-cap");
  ctx.Equal(r.Status, 202, "exactly 1 000 000 records is within the cap (%s)", r.Text());
  const json job = jobOf(ctx, r);
  ctx.Assert(job["shards"] == 1000 && pendingOf(ctx, job["batch_id"]).size() == 1000, "1 000 000 records are 1000 shards: %s", r.Text());
}

void CheckSealedManifest(harness::Ctx& ctx) {
  seedManifest(ctx, kManifest, 1200, false);
  Api api(ctx);
  auto r = api.post(kManifest, "k-up");
  ctx.Equal(r.Status, 409, "a manifest still uploading (1200 records so far, sealed false): the batch would be sized from the parts that landed");
  ctx.Assert(ctx.Redis.Keys("batch:job:*").empty() && ctx.Redis.Keys("batch:pending:*").empty(), "a 409 must store nothing and queue nothing, found %v", ctx.Redis.Keys("batch:*"));
  seedManifest(ctx, kManifest, 2500, true);
  r = api.post(kManifest, "k-up");
  ctx.Equal(r.Status, 202, "once the manifest is sealed the same request and key must start the batch (%s)", r.Text());
  ctx.Equal(jobOf(ctx, r)["record_count"], 2500, "the batch must be sized from the sealed manifest; record_count");
  r = api.post("s3://acme-batches/missing.jsonl", "k-none");
  ctx.Equal(r.Status, 404, "no object at manifest_uri");
}

void CheckShardCount(harness::Ctx& ctx) {
  seedManifest(ctx, kManifest, 2500, true);
  Api api(ctx);
  auto r = api.post(kManifest, "k-2500");
  ctx.Equal(r.Status, 202, "a 2500-record submit (%s)", r.Text());
  const json job = jobOf(ctx, r);
  ctx.Equal(job["shards"], 3, "2500 records at 1000 per shard are 3 shards (with fewer, the last 500 records belong to no shard and are never run); shards");
  ctx.Equal(pendingOf(ctx, job["batch_id"]), {"0", "1", "2"}, "shards 0, 1 and 2 must be pending; batch:pending holds");
  const std::string small = "s3://acme-batches/2026-11/small.jsonl";
  seedManifest(ctx, small, 999, true);
  r = api.post(small, "k-999");
  ctx.Assert(r.Status == 202 && jobOf(ctx, r)["shards"] == 1, "999 records are one shard: %s", r.Text());
}
`,
  },
  hints: [
    'Symptom: a client that retried a slow submit sees two batches over one manifest, a submit made while the upload was still running gets a batch of 1200 records out of 2500, and a 2500-record batch ends after 2000.',
    'Mechanism: the batch is stored under its own fresh id, so a replayed key finds nothing; the record count is taken from `head` without looking at `sealed`; nothing compares it with `MAX_RECORDS`; and `//` drops the partial last shard.',
    'Change: guard in order (tenant 401, Idempotency-Key 400, `store.get` hit 200, no manifest 404, not sealed 409, over `MAX_RECORDS` 400), then `ceil(record_count / SHARD_SIZE)`, `store.put(tenant, key, job)`, `shards.seed`.',
  ],
  debrief: `Everything a batch costs is decided before its first model call, so the submit is a series of guards ordered by what they protect. The key belongs to the client on purpose: keyed by \`(tenant, Idempotency-Key)\`, a retry finds the batch it already started instead of paying for a second run. A manifest is sized only once it is sealed, because an object still uploading reports the parts written so far; 409 tells the client to come back, and storing nothing makes that retry clean. Rounding the shard count up is what makes the last 500 records somebody's job. Production services also validate the manifest's lines before queueing anything, as OpenAI's Batch API does in its \`validating\` state, and enforce a per-tenant quota on records in flight.`,
};
