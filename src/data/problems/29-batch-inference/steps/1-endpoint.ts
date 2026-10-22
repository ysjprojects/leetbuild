import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/batches: submit once, run once',
  concept: 'http',
  file: 'api',
  focus: ['client', 'batchd', 'db', 'worker'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, parses
the body and starts a job, so the demo submits a batch and shards appear in the work set. It hides
three production flaws. Review it like the service owner, fix it, and prove the fix with the checks
below.

Implement \`POST /v1/batches\` with body \`{"manifest_uri": "s3://…"}\`.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- The input manifest is an object whose metadata carries \`record_count\` and \`records\`. Read that
  metadata with a **\`HEAD\`** *before* anything is stored: while the object is not readable the submit
  is a **409**, and when \`record_count\` is over **1 000 000** the submit is a **400** with no job
  written. The draft reads ten million records into memory and seeds shards before the manifest
  exists, so the first worker races a half-written input.
- \`Idempotency-Key\` is required (**400** when missing). A retry with the same \`(tenant, key)\`
  returns the stored job instead of minting a new one — the draft creates a job on every submit.
- Only after the manifest is durably readable and the count passes: create the job, write the
  manifest pointer, then enqueue one work-set entry per shard (\`ceil(record_count / 1000)\`).
- Answer **202 Accepted** with \`{job_id, status, shards}\`.

**Failure mode the checks target.** An unbounded manifest turns one submit into a ten-million-record
memory spike; a job minted per submit makes every client retry run the batch twice; and enqueueing
before the manifest is readable hands workers a half-written input, so the first shard fails for a
reason that has nothing to do with the model.

:::widget idempotency {}`,
  sequence: {
    participants: ['Client', 'Batch Service', 'batch · outbox', 'Worker pool'],
    messages: [
      {from: 'Client', to: 'Batch Service', label: 'POST /v1/batches · X-Tenant-Id · Idempotency-Key', kind: 'sync'},
      {from: 'Batch Service', to: 'batch · outbox', label: 'findByKey(tenant, idem_key)', kind: 'sync'},
      {from: 'batch · outbox', to: 'Batch Service', label: 'stored job or miss', kind: 'reply'},
      {
        from: 'Batch Service',
        to: 'batch · outbox',
        label: 'head(manifest) · 409/400 · create(job) once readable',
        kind: 'sync',
      },
      {from: 'Batch Service', to: 'Worker pool', label: 'enqueue shards after the manifest is readable', kind: 'async'},
      {from: 'Batch Service', to: 'Client', label: '202 {job_id, status, shards}', kind: 'reply'},
    ],
  },
  hints: [
    'Validate in cost order: tenant, `Idempotency-Key`, then the manifest `HEAD`. Every guard returns before any job row or Redis write, so a malformed submit never spends anything.',
    'The idempotency lookup is keyed by `(tenant, key)` and happens before the job is created; a hit returns the stored job with the same 202. Storing the whole job — not just the key — is what lets a replay answer without re-deriving the shard count.',
    'The order is the contract: `HEAD` the manifest, reject an over-cap count, write the manifest pointer, and only then seed the work set. Enqueue first and the first worker lists an object that is still being written.',
  ],
  checks: [
    {
      id: 'auth-tenant',
      title: 'Rejects a submit with no tenant',
      detail:
        'The tenant comes from `X-Tenant-Id` and a missing tenant is **401**. The draft starts a job for whoever calls.',
      match: {
        python: {all: [/X-Tenant-Id/, /401/]},
        typescript: {all: [/x-tenant-id/i, /401/]},
        go: {all: [/X-Tenant-Id/, /StatusUnauthorized/]},
        scala: {all: [/X-Tenant-Id/, /StatusCodes\.Unauthorized/]},
        cpp: {all: [/X-Tenant-Id/, /401/]},
      },
    },
    {
      id: 'idempotent-replay',
      title: 'A replayed submit returns the same job',
      detail:
        'The submit looks up `(tenant, Idempotency-Key)` before it creates a job and returns the stored job on a hit. The draft mints a new job on every submit, so a client retry runs the batch twice.',
      match: {
        python: {order: [/find_by_key\(/, /\.create\(/]},
        typescript: {order: [/findByKey\(/, /\.create\(/]},
        go: {order: [/FindByKey\(/, /\.Create\(/]},
        scala: {order: [/findByKey\(/, /\.create\(/]},
        cpp: {order: [/find_by_key\(/, /\.create\(/]},
      },
    },
    {
      id: 'record-cap',
      title: 'Rejects a manifest over one million records',
      detail:
        'The manifest record count is checked against `MAX_RECORDS` (1 000 000) and an oversized manifest is **400** before any job is written. The draft accepts an unbounded manifest.',
      match: {
        python: {all: [/MAX_RECORDS/, /1_000_000/, /400/]},
        typescript: {all: [/MAX_RECORDS/, /1_000_000/, /400/]},
        go: {all: [/maxRecords/, /1_000_000/, /StatusBadRequest/]},
        scala: {all: [/MaxRecords/, /1_000_000/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kMaxRecords/, /1000000/, /400/]},
      },
    },
    {
      id: 'durable-manifest',
      title: 'Starts only after the manifest is durably readable',
      detail:
        'The manifest object is confirmed readable (a `HEAD`/metadata read) before any shard is enqueued. The draft enqueues first and races the half-written input.',
      match: {
        python: {order: [/\.head\(/, /enqueue_shards\(/]},
        typescript: {order: [/\.head\(/, /enqueueShards\(/]},
        go: {order: [/HeadObject\(|\.Head\(/, /enqueueShards\(/]},
        scala: {order: [/\.head\(/, /enqueueShards\(/]},
        cpp: {order: [/\.head\(/, /enqueue_shards\(/]},
      },
    },
    {
      id: 'accepted-job',
      title: 'Answers 202 with the job id and shard count',
      detail:
        'A fresh submit answers **202 Accepted** with the job id and the shard count; the draft answers 200 with only a fresh id.',
      match: {
        python: {all: [/202/, /job_id/]},
        typescript: {all: [/202/, /job_id/]},
        go: {all: [/StatusAccepted/, /job_id/]},
        scala: {all: [/Accepted/, /job_id/]},
        cpp: {all: [/202/, /job_id/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import uuid

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()


class BatchRequest(BaseModel):
    manifest_uri: str
    shard_count: int = 1000


class BatchStore:
    def create(self, tenant: str, manifest_uri: str, shard_count: int) -> dict:
        """Persist the job and return its record."""
        raise NotImplementedError

    def put_manifest(self, batch_id: str, records: list[str]) -> None:
        """Write the manifest object for the job."""
        raise NotImplementedError


store = BatchStore()


def enqueue_shards(batch_id: str, shard_count: int) -> None:
    """Seed the Redis work set with one entry per shard."""
    raise NotImplementedError


@app.post("/v1/batches")
def submit(body: BatchRequest, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this draft reads the manifest into memory unbounded, mints a new job on every submit,
    # and seeds shards before the manifest is readable. Review all three.
    records = [f"record-{i}" for i in range(10_000_000)]
    job = store.create(tenant, body.manifest_uri, body.shard_count)
    enqueue_shards(job["job_id"], body.shard_count)
    store.put_manifest(job["job_id"], records)
    return JSONResponse({"job_id": job["job_id"], "status": "running"}, status_code=200)
`,
      solution: `import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()

MAX_RECORDS = 1_000_000
SHARD_SIZE = 1_000


class BatchRequest(BaseModel):
    manifest_uri: str


class BatchStore:
    def find_by_key(self, tenant: str, idem_key: str) -> dict | None:
        """The job already created for (tenant, idem_key), if any."""
        raise NotImplementedError

    def create(self, tenant: str, idem_key: str, manifest_uri: str, shard_count: int) -> dict:
        """Persist the job and return its record."""
        raise NotImplementedError

    def put_manifest(self, batch_id: str, records: list[str]) -> None:
        """Write the manifest object for the job."""
        raise NotImplementedError


class ManifestStore:
    def head(self, uri: str) -> dict | None:
        """The manifest's metadata, or None while the object is not readable."""
        raise NotImplementedError


store = BatchStore()
manifests = ManifestStore()


def enqueue_shards(batch_id: str, shard_count: int) -> None:
    """Seed the Redis work set with one entry per shard."""
    raise NotImplementedError


@app.post("/v1/batches")
def submit(
    body: BatchRequest,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    idem_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if idem_key is None or idem_key == "":
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")

    stored = store.find_by_key(tenant, idem_key)
    if stored is not None:
        return JSONResponse(stored, status_code=202)

    head = manifests.head(body.manifest_uri)
    if head is None:
        raise HTTPException(status_code=409, detail="manifest is not readable yet")
    record_count = head["record_count"]
    if record_count > MAX_RECORDS:
        raise HTTPException(status_code=400, detail="manifest exceeds one million records")

    shard_count = max(1, (record_count + SHARD_SIZE - 1) // SHARD_SIZE)
    job = store.create(tenant, idem_key, body.manifest_uri, shard_count)
    store.put_manifest(job["job_id"], head["records"])
    enqueue_shards(job["job_id"], shard_count)
    return JSONResponse(job, status_code=202)
`,
    },
    typescript: {
      starter: `/** POST /v1/batches: a model-generated draft that starts before the manifest exists. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

export const app = Fastify();

interface BatchBody {
  manifest_uri: string;
  shard_count?: number;
}

class BatchStore {
  async create(tenant: string, manifestURI: string, shardCount: number): Promise<Record<string, unknown>> {
    return {job_id: randomUUID(), status: 'running', shards: shardCount, tenant};
  }

  async putManifest(batchID: string, records: string[]): Promise<void> {
    void batchID;
    void records;
  }
}

const store = new BatchStore();

async function enqueueShards(batchID: string, shardCount: number): Promise<void> {
  void batchID;
  void shardCount;
}

app.post('/v1/batches', async (request, reply) => {
  // TODO: this draft reads the manifest into memory unbounded, mints a new job on every submit,
  // and seeds shards before the manifest is readable. Review all three.
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as BatchBody;
  const records = Array.from({length: 10_000_000}, (_, i) => 'record-' + i);
  const job = await store.create(tenant, body.manifest_uri, body.shard_count ?? 1000);
  await enqueueShards(String(job.job_id), body.shard_count ?? 1000);
  await store.putManifest(String(job.job_id), records);
  return reply.code(200).send({job_id: job.job_id, status: 'running'});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/batches: authenticated, capped and idempotent submission. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

export const app = Fastify();

const MAX_RECORDS = 1_000_000;
const SHARD_SIZE = 1_000;

interface BatchBody {
  manifest_uri: string;
}

interface Job {
  job_id: string;
  status: string;
  shards: number;
}

class BatchStore {
  async findByKey(tenant: string, idemKey: string): Promise<Job | null> {
    void tenant;
    void idemKey;
    return null;
  }

  async create(tenant: string, idemKey: string, manifestURI: string, shardCount: number): Promise<Job> {
    void tenant;
    void idemKey;
    void manifestURI;
    return {job_id: randomUUID(), status: 'queued', shards: shardCount};
  }

  async putManifest(batchID: string, records: string[]): Promise<void> {
    void batchID;
    void records;
  }
}

class ManifestStore {
  async head(uri: string): Promise<{record_count: number; records: string[]} | null> {
    void uri;
    return null;
  }
}

const store = new BatchStore();
const manifests = new ManifestStore();

async function enqueueShards(batchID: string, shardCount: number): Promise<void> {
  void batchID;
  void shardCount;
}

app.post('/v1/batches', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '')
    return reply.code(400).send({error: 'Idempotency-Key is required'});

  const body = request.body as Partial<BatchBody> | null;
  if (body === null || typeof body !== 'object' || typeof body.manifest_uri !== 'string' || body.manifest_uri === '')
    return reply.code(400).send({error: 'manifest_uri is required'});

  const stored = await store.findByKey(tenant, idemKey);
  if (stored !== null) return reply.code(202).send(stored);

  const head = await manifests.head(body.manifest_uri);
  if (head === null) return reply.code(409).send({error: 'manifest is not readable yet'});
  if (head.record_count > MAX_RECORDS) return reply.code(400).send({error: 'manifest exceeds one million records'});

  const shards = Math.max(1, Math.ceil(head.record_count / SHARD_SIZE));
  const job = await store.create(tenant, idemKey, body.manifest_uri, shards);
  await store.putManifest(job.job_id, head.records);
  await enqueueShards(job.job_id, shards);
  return reply.code(202).send(job);
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

type BatchRequest struct {
	ManifestURI string \`json:"manifest_uri"\`
	ShardCount  int    \`json:"shard_count"\`
}

type BatchStore struct{}

func (s *BatchStore) Create(ctx context.Context, tenant, manifestURI string, shardCount int) (map[string]any, error) {
	return map[string]any{"job_id": "job-1", "status": "running"}, nil
}

func (s *BatchStore) PutManifest(ctx context.Context, batchID string, records []string) error {
	return nil
}

var store = &BatchStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func enqueueShards(ctx context.Context, batchID string, shardCount int) error {
	return nil
}

func submit(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	var body BatchRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft reads the manifest into memory unbounded, mints a new job on every submit,
	// and seeds shards before the manifest is readable. Review all three.
	records := make([]string, 10_000_000)
	job, _ := store.Create(r.Context(), tenant, body.ManifestURI, body.ShardCount)
	batchID := job["job_id"].(string)
	_ = enqueueShards(r.Context(), batchID, body.ShardCount)
	_ = store.PutManifest(r.Context(), batchID, records)
	writeJSON(rw, http.StatusOK, job)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/batches", submit)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"

	"github.com/google/uuid"
)

const (
	maxRecords = 1_000_000
	shardSize  = 1_000
)

type BatchRequest struct {
	ManifestURI string \`json:"manifest_uri"\`
}

type BatchStore struct{}

func (s *BatchStore) FindByKey(ctx context.Context, tenant, idemKey string) (map[string]any, error) {
	return nil, nil
}

func (s *BatchStore) Create(ctx context.Context, tenant, idemKey, manifestURI string, shardCount int) (map[string]any, error) {
	return map[string]any{
		"job_id": uuid.NewString(),
		"status": "queued",
		"shards": shardCount,
	}, nil
}

func (s *BatchStore) PutManifest(ctx context.Context, batchID string, records []string) error {
	return nil
}

type ManifestStore struct{}

func (s *ManifestStore) HeadObject(ctx context.Context, uri string) (map[string]any, error) {
	return nil, nil
}

var store = &BatchStore{}
var manifests = &ManifestStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func enqueueShards(ctx context.Context, batchID string, shardCount int) error {
	return nil
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
	var body BatchRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if body.ManifestURI == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "manifest_uri is required"})
		return
	}
	if stored, err := store.FindByKey(r.Context(), tenant, idemKey); err == nil && stored != nil {
		writeJSON(rw, http.StatusAccepted, stored)
		return
	}
	head, err := manifests.HeadObject(r.Context(), body.ManifestURI)
	if err != nil || head == nil {
		writeJSON(rw, http.StatusConflict, map[string]string{"error": "manifest is not readable yet"})
		return
	}
	recordCount, _ := head["record_count"].(int)
	if recordCount > maxRecords {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "manifest exceeds one million records"})
		return
	}
	shardCount := (recordCount + shardSize - 1) / shardSize
	job, _ := store.Create(r.Context(), tenant, idemKey, body.ManifestURI, shardCount)
	batchID := job["job_id"].(string)
	records, _ := head["records"].([]string)
	_ = store.PutManifest(r.Context(), batchID, records)
	if err := enqueueShards(r.Context(), batchID, shardCount); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	writeJSON(rw, http.StatusAccepted, job)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/batches", submit)
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

final case class BatchRequest(manifest_uri: String, shard_count: Int)
final case class Job(job_id: String, status: String, shards: Int)

object BatchApi {
  implicit val system: ActorSystem = ActorSystem("batchd")
  implicit val requestFormat: RootJsonFormat[BatchRequest] = jsonFormat2(BatchRequest)
  implicit val jobFormat: RootJsonFormat[Job] = jsonFormat3(Job)

  val route: Route =
    path("v1" / "batches") {
      post {
        entity(as[BatchRequest]) { body =>
          // TODO: this draft reads the manifest into memory unbounded, mints a new job on every
          // submit, and seeds shards before the manifest is readable. Review all three.
          val records = (0 until 10_000_000).map(i => s"record-$i").toList
          val job = store.create(body.manifest_uri, body.shard_count)
          enqueueShards(job.job_id, body.shard_count)
          store.putManifest(job.job_id, records)
          complete(StatusCodes.OK, job)
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

final case class BatchRequest(manifest_uri: String)
final case class ManifestHead(record_count: Long, records: List[String])
final case class Job(job_id: String, status: String, shards: Int)

object BatchApi {
  implicit val system: ActorSystem = ActorSystem("batchd")
  implicit val requestFormat: RootJsonFormat[BatchRequest] = jsonFormat1(BatchRequest)
  implicit val jobFormat: RootJsonFormat[Job] = jsonFormat3(Job)

  val MaxRecords = 1_000_000
  val ShardSize = 1_000

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
                store.findByKey(tenant, idemKey) match {
                  case Some(job) => complete(StatusCodes.Accepted, job)
                  case None =>
                    manifests.head(body.manifest_uri) match {
                      case None =>
                        complete(StatusCodes.Conflict, """{"error":"manifest is not readable yet"}""")
                      case Some(head) if head.record_count > MaxRecords =>
                        complete(StatusCodes.BadRequest, """{"error":"manifest exceeds one million records"}""")
                      case Some(head) =>
                        val shards = math.max(1, ((head.record_count + ShardSize - 1) / ShardSize).toInt)
                        val job = store.create(tenant, idemKey, body.manifest_uri, shards)
                        store.putManifest(job.job_id, head.records)
                        enqueueShards(job.job_id, shards)
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
#include <vector>

using json = nlohmann::json;

struct BatchStore {
  json create(const std::string& tenant, const std::string& manifestURI, int shardCount) {
    return json{{"job_id", "job-1"}, {"status", "running"}, {"shards", shardCount}};
  }
  void put_manifest(const std::string& batchID, const std::vector<std::string>& records) {}
};

BatchStore store;

void enqueue_shards(const std::string& batchID, int shardCount) {}

int main() {
  httplib::Server svr;

  svr.Post("/v1/batches", [](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this draft reads the manifest into memory unbounded, mints a new job on every submit,
    // and seeds shards before the manifest is readable. Review all three.
    const std::vector<std::string> records(10000000, "record");
    const auto manifestURI = body.value("manifest_uri", std::string());
    const int shardCount = body.value("shard_count", 1000);
    const auto job = store.create(manifestURI, shardCount);
    const auto batchID = job["job_id"].get<std::string>();
    enqueue_shards(batchID, shardCount);
    store.put_manifest(batchID, records);
    res.status = 200;
    res.set_content(job.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <optional>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr long kMaxRecords = 1000000;
constexpr long kShardSize = 1000;

struct ManifestHead {
  long record_count;
  std::vector<std::string> records;
};

struct BatchStore {
  std::optional<json> find_by_key(const std::string& tenant, const std::string& idemKey);
  json create(const std::string& tenant, const std::string& idemKey, const std::string& manifestURI, int shardCount);
  void put_manifest(const std::string& batchID, const std::vector<std::string>& records);
};

struct ManifestStore {
  std::optional<ManifestHead> head(const std::string& uri);
};

BatchStore store;
ManifestStore manifests;

void enqueue_shards(const std::string& batchID, int shardCount);

int main() {
  httplib::Server svr;

  svr.Post("/v1/batches", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto idemKey = req.get_header_value("Idempotency-Key");
    if (idemKey.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"Idempotency-Key is required"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("manifest_uri")) {
      res.status = 400;
      res.set_content(R"({"error":"manifest_uri is required"})", "application/json");
      return;
    }
    const auto manifestURI = body["manifest_uri"].get<std::string>();

    if (auto stored = store.find_by_key(tenant, idemKey)) {
      res.status = 202;
      res.set_content(stored->dump(), "application/json");
      return;
    }
    const auto head = manifests.head(manifestURI);
    if (!head) {
      res.status = 409;
      res.set_content(R"({"error":"manifest is not readable yet"})", "application/json");
      return;
    }
    if (head->record_count > kMaxRecords) {
      res.status = 400;
      res.set_content(R"({"error":"manifest exceeds one million records"})", "application/json");
      return;
    }
    const auto shards = static_cast<int>((head->record_count + kShardSize - 1) / kShardSize);
    const auto job = store.create(tenant, idemKey, manifestURI, shards);
    const auto batchID = job["job_id"].get<std::string>();
    store.put_manifest(batchID, head->records);
    enqueue_shards(batchID, shards);
    res.status = 202;
    res.set_content(job.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The interviewer is reviewing an endpoint that starts expensive work, and every defect is about the
order of operations. Authentication first, then the idempotency lookup, then the manifest gate, then
the job write, then the shards. The draft reverses the last two: it starts processing before the
input is durably readable, so the first shard is a race, not a model failure. Two more drafts hide
behind the happy path: an unbounded manifest that trusts the caller for ten million records, and a
minted job id that makes every client retry run the batch twice. The contract is that a submit is a
single, idempotent, bounded promise — a \`HEAD\` on the manifest before anything is stored is what
makes the promise true. Real services add a manifest schema version, a record-count checksum, and a
reservation on the tenant's batch quota before the job row.`,
};
