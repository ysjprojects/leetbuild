import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/inferences: a storage key inside the tenant, a task from the catalog',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'objects', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/inferences\` with body \`{"image", "task"}\`: it
answers 401 without \`X-Tenant-Id\`, fetches \`image\` through the provided \`fetch_object\` (404 when
there is no such object), builds a pending inference with a fresh id and the SHA-256 of the bytes as
\`content_hash\`, stores it through the provided inference store under \`(tenant, inference_id)\` and
answers 201. It serves the demo and hides four flaws.

**Failure mode the checks target.** \`image\` is a string the caller wrote, and the starter
dereferences it: another tenant's key, an \`s3://\` path to the model bucket or a \`..\` walk all come
back as a 201 with that object's digest. An unknown task fails later, at the model. And a client that
retries a slow upload starts a second inference every time.

Requirements:

- \`task\` is one of \`ALLOWED_TASKS\` (\`classify\`, \`detect\`, \`embed\`); **400** otherwise.
- \`image\` is a storage key inside \`TENANT_PREFIX\` (\`tenants/{tenant}/images/\`): a scheme
  (\`://\`), a \`..\` segment or another prefix is **403**, decided **before** \`fetch_object\` runs.
- \`Idempotency-Key\` is required (**400**). The inference is stored under \`(tenant, key)\`
  (\`store.put\`); a replay answers **200** with the stored inference (\`store.get\`).
- A new inference answers **201** with \`{inference_id, status: "pending", task, image, content_hash,
  created_at}\`.`,
  sequence: {
    participants: ['Client', 'Vision API', 'Inference store', 'Object store'],
    messages: [
      {from: 'Client', to: 'Vision API', label: 'POST /v1/inferences · X-Tenant-Id · Idempotency-Key', kind: 'sync'},
      {from: 'Vision API', to: 'Vision API', label: 'task in catalog · key inside tenants/{t}/images/', kind: 'sync'},
      {from: 'Vision API', to: 'Inference store', label: 'get(tenant, key)', kind: 'sync'},
      {from: 'Inference store', to: 'Vision API', label: 'stored inference / none', kind: 'reply'},
      {from: 'Vision API', to: 'Object store', label: 'fetch_object(image)', kind: 'sync'},
      {from: 'Vision API', to: 'Inference store', label: 'put(tenant, key, inference)', kind: 'sync'},
      {from: 'Vision API', to: 'Client', label: '201 {inference_id, status: pending, content_hash}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/inferences',
      detail:
        'A valid request answers 201 with the pending inference (inference_id, status, task, image, the SHA-256 of the bytes, created_at) and stores it; 401 without X-Tenant-Id, 404 for a key with no object.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/inferences["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/inferences['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/inferences"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"inferences"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/inferences"/]},
      },
    },
    {
      id: 'task-catalog',
      title: 'Refuses a task outside the catalog',
      detail:
        'A task other than classify, detect or embed is 400 and stores nothing. The starter stores whatever task the caller names.',
      match: {
        python: {all: [/ALLOWED_TASKS/, /status_code\s*=\s*400/]},
        typescript: {all: [/ALLOWED_TASKS/, /code\(\s*400\s*\)/]},
        go: {all: [/allowedTasks/, /StatusBadRequest/]},
        scala: {all: [/AllowedTasks/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kAllowedTasks/, /\b400\b/]},
      },
    },
    {
      id: 'tenant-scope',
      title: "Refuses a key outside the tenant's prefix with 403",
      detail:
        "A key with a scheme, a `..` segment, or outside `tenants/{tenant}/images/` is 403 and stores nothing. The starter fetches and stores any key, another tenant's included.",
      match: {
        python: {all: [/TENANT_PREFIX/, /status_code\s*=\s*403/]},
        typescript: {all: [/TENANT_PREFIX/, /code\(\s*403\s*\)/]},
        go: {all: [/tenantPrefix/, /StatusForbidden/]},
        scala: {all: [/TenantPrefix/, /StatusCodes\.Forbidden/]},
        cpp: {all: [/kTenantPrefix/, /\b403\b/]},
      },
    },
    {
      id: 'scope-before-fetch',
      title: 'Decides the 403 before the object is read',
      detail:
        'The scope test runs before fetch_object, so a forged key never reaches the object store: by the time a fetch has happened, the read already did. The starter fetches first.',
      match: {
        python: {order: [/status_code\s*=\s*403/, /fetch_object\(/]},
        typescript: {order: [/code\(\s*403\s*\)/, /fetchObject\(/]},
        go: {order: [/StatusForbidden/, /objects\.Fetch\(/]},
        scala: {order: [/StatusCodes\.Forbidden/, /Objects\.fetchObject\(/]},
        cpp: {order: [/\b403\b/, /fetch_object\(/]},
      },
    },
    {
      id: 'idempotency-key',
      title: 'Keys inferences by (tenant, Idempotency-Key)',
      detail:
        'Idempotency-Key is required (400 without it); a replay of the same (tenant, key) answers 200 with the same inference_id, and another tenant with the same key gets its own. The starter stores under a fresh id, so every retry starts a new inference.',
      match: {
        python: {all: [/Idempotency-Key/, /store\.get\(\s*tenant\s*,/, /store\.put\(\s*tenant\s*,\s*idem/]},
        typescript: {all: [/idempotency-key/, /store\.get\(\s*tenant\s*,/, /store\.put\(\s*tenant\s*,\s*idem/]},
        go: {all: [/Idempotency-Key/, /inferences\.Get\(/, /inferences\.Put\(\s*[\w.()]+,\s*tenant\s*,\s*idem/]},
        scala: {all: [/Idempotency-Key/, /Inferences\.get\(\s*tenant\s*,/, /Inferences\.put\(\s*tenant\s*,\s*idem/]},
        cpp: {all: [/Idempotency-Key/, /inferences::get\(\s*tenant\s*,/, /inferences::put\(\s*tenant\s*,\s*idem/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import hashlib
import logging
import time
import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from vision.inferences import store
from vision.objects import fetch_object

app = FastAPI()
logger = logging.getLogger("vision")


class InferenceRequest(BaseModel):
    image: str
    task: str


@app.post("/v1/inferences")
def create_inference(body: InferenceRequest, tenant: str | None = Header(default=None, alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    payload = fetch_object(body.image)
    if payload is None:
        raise HTTPException(status_code=404, detail="no such image")
    inference = {
        "inference_id": str(uuid.uuid4()),
        "status": "pending",
        "task": body.task,
        "image": body.image,
        "content_hash": hashlib.sha256(payload).hexdigest(),
        "created_at": int(time.time()),
    }
    store.put(tenant, inference["inference_id"], inference)
    logger.info("inference %s tenant=%s task=%s", inference["inference_id"], tenant, body.task)
    return JSONResponse(inference, status_code=201)
`,
      solution: `import hashlib
import logging
import time
import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from vision.inferences import store
from vision.objects import fetch_object

app = FastAPI()
logger = logging.getLogger("vision")

ALLOWED_TASKS = {"classify", "detect", "embed"}
TENANT_PREFIX = "tenants/{tenant}/images/"


class InferenceRequest(BaseModel):
    image: str
    task: str


def in_scope(tenant: str, key: str) -> bool:
    """A storage key under the tenant's own prefix: no scheme, no '..' segment."""
    return "://" not in key and ".." not in key.split("/") and key.startswith(TENANT_PREFIX.format(tenant=tenant))


@app.post("/v1/inferences")
def create_inference(
    body: InferenceRequest,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    idem_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if idem_key is None or idem_key == "":
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    if body.task not in ALLOWED_TASKS:
        raise HTTPException(status_code=400, detail="task must be classify, detect or embed")
    if not in_scope(tenant, body.image):
        raise HTTPException(status_code=403, detail="image is outside the tenant's storage prefix")

    stored = store.get(tenant, idem_key)
    if stored is not None:
        return JSONResponse(stored, status_code=200)

    payload = fetch_object(body.image)
    if payload is None:
        raise HTTPException(status_code=404, detail="no such image")
    inference = {
        "inference_id": str(uuid.uuid4()),
        "status": "pending",
        "task": body.task,
        "image": body.image,
        "content_hash": hashlib.sha256(payload).hexdigest(),
        "created_at": int(time.time()),
    }
    store.put(tenant, idem_key, inference)
    logger.info("inference %s tenant=%s task=%s", inference["inference_id"], tenant, body.task)
    return JSONResponse(inference, status_code=201)
`,
    },
    typescript: {
      starter: `import {createHash, randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import {type Inference, store} from 'vision/inferences';
import {fetchObject} from 'vision/objects';

export const app = Fastify();

interface InferenceBody {
  image: string;
  task: string;
}

app.post('/v1/inferences', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const body = request.body as InferenceBody;
  const payload = await fetchObject(body.image);
  if (payload === null) return reply.code(404).send({error: 'no such image'});
  const inference: Inference = {
    inference_id: randomUUID(),
    status: 'pending',
    task: body.task,
    image: body.image,
    content_hash: createHash('sha256').update(payload).digest('hex'),
    created_at: Math.floor(Date.now() / 1000),
  };
  await store.put(tenant, inference.inference_id, inference);
  request.log.info({tenant, inference_id: inference.inference_id, task: body.task}, 'inference queued');
  return reply.code(201).send(inference);
});
`,
      solution: `import {createHash, randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import {type Inference, store} from 'vision/inferences';
import {fetchObject} from 'vision/objects';

export const app = Fastify();

export const ALLOWED_TASKS: Record<string, true> = {classify: true, detect: true, embed: true};
export const TENANT_PREFIX = (tenant: string): string => \`tenants/\${tenant}/images/\`;

interface InferenceBody {
  image: string;
  task: string;
}

/** A storage key under the tenant's own prefix: no scheme, no '..' segment. */
function inScope(tenant: string, key: string): boolean {
  return !key.includes('://') && !key.split('/').includes('..') && key.startsWith(TENANT_PREFIX(tenant));
}

app.post('/v1/inferences', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '') return reply.code(400).send({error: 'Idempotency-Key is required'});
  const body = (request.body ?? {}) as Partial<InferenceBody>;
  if (typeof body.task !== 'string' || ALLOWED_TASKS[body.task] !== true)
    return reply.code(400).send({error: 'task must be classify, detect or embed'});
  if (typeof body.image !== 'string' || !inScope(tenant, body.image))
    return reply.code(403).send({error: "image is outside the tenant's storage prefix"});

  const stored = await store.get(tenant, idemKey);
  if (stored !== null) return reply.code(200).send(stored);

  const payload = await fetchObject(body.image);
  if (payload === null) return reply.code(404).send({error: 'no such image'});
  const inference: Inference = {
    inference_id: randomUUID(),
    status: 'pending',
    task: body.task,
    image: body.image,
    content_hash: createHash('sha256').update(payload).digest('hex'),
    created_at: Math.floor(Date.now() / 1000),
  };
  await store.put(tenant, idemKey, inference);
  request.log.info({tenant, inference_id: inference.inference_id, task: body.task}, 'inference queued');
  return reply.code(201).send(inference);
});
`,
    },
    go: {
      starter: `package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/google/uuid"

	"vision/inferences" // inferences.Inference, inferences.Get(ctx, tenant, idemKey), inferences.Put(ctx, tenant, idemKey, inf) — provided
	"vision/objects"    // objects.Fetch(ctx, key) — provided
)

type InferenceRequest struct {
	Image string \`json:"image"\`
	Task  string \`json:"task"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func createInference(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	var body InferenceRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	payload, err := objects.Fetch(r.Context(), body.Image)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if payload == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such image"})
		return
	}
	sum := sha256.Sum256(payload)
	inf := inferences.Inference{
		InferenceID: uuid.NewString(),
		Status:      "pending",
		Task:        body.Task,
		Image:       body.Image,
		ContentHash: hex.EncodeToString(sum[:]),
		CreatedAt:   time.Now().Unix(),
	}
	if err := inferences.Put(r.Context(), tenant, inf.InferenceID, inf); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("inference %s tenant=%s task=%s", inf.InferenceID, tenant, inf.Task)
	writeJSON(rw, http.StatusCreated, inf)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/inferences", createInference)
}

func main() {
	mux := http.NewServeMux()
	register(mux)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
      solution: `package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"

	"vision/inferences" // inferences.Inference, inferences.Get(ctx, tenant, idemKey), inferences.Put(ctx, tenant, idemKey, inf) — provided
	"vision/objects"    // objects.Fetch(ctx, key) — provided
)

var allowedTasks = map[string]bool{"classify": true, "detect": true, "embed": true}

// tenantPrefix is the storage prefix a tenant's images live under.
func tenantPrefix(tenant string) string { return "tenants/" + tenant + "/images/" }

type InferenceRequest struct {
	Image string \`json:"image"\`
	Task  string \`json:"task"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

// inScope: a storage key under the tenant's own prefix, with no scheme and no ".." segment.
func inScope(tenant, key string) bool {
	return !strings.Contains(key, "://") && !slices.Contains(strings.Split(key, "/"), "..") && strings.HasPrefix(key, tenantPrefix(tenant))
}

func createInference(rw http.ResponseWriter, r *http.Request) {
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
	var body InferenceRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if !allowedTasks[body.Task] {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "task must be classify, detect or embed"})
		return
	}
	if !inScope(tenant, body.Image) {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "image is outside the tenant's storage prefix"})
		return
	}

	stored, err := inferences.Get(r.Context(), tenant, idemKey)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if stored != nil {
		writeJSON(rw, http.StatusOK, stored)
		return
	}

	payload, err := objects.Fetch(r.Context(), body.Image)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if payload == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such image"})
		return
	}
	sum := sha256.Sum256(payload)
	inf := inferences.Inference{
		InferenceID: uuid.NewString(),
		Status:      "pending",
		Task:        body.Task,
		Image:       body.Image,
		ContentHash: hex.EncodeToString(sum[:]),
		CreatedAt:   time.Now().Unix(),
	}
	if err := inferences.Put(r.Context(), tenant, idemKey, inf); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("inference %s tenant=%s task=%s", inf.InferenceID, tenant, inf.Task)
	writeJSON(rw, http.StatusCreated, inf)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/inferences", createInference)
}

func main() {
	mux := http.NewServeMux()
	register(mux)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
    },
    scala: {
      starter: `import java.security.MessageDigest
import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

import vision.{Inferences, Objects}

final case class InferenceRequest(image: String, task: String)

object VisionApi {
  implicit val system: ActorSystem = ActorSystem("vision-inference")
  implicit val requestFormat: RootJsonFormat[InferenceRequest] = jsonFormat2(InferenceRequest)

  private def json(status: StatusCode, body: ujson.Value) =
    complete(HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, ujson.write(body))))

  val route: Route =
    path("v1" / "inferences") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          entity(as[InferenceRequest]) { body =>
            // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
            if (!tenantOpt.exists(_.nonEmpty)) {
              json(StatusCodes.Unauthorized, ujson.Obj("error" -> "missing X-Tenant-Id"))
            } else {
              val tenant = tenantOpt.get
              Objects.fetchObject(body.image) match {
                case None => json(StatusCodes.NotFound, ujson.Obj("error" -> "no such image"))
                case Some(payload) =>
                  val inference = ujson.Obj(
                    "inference_id" -> UUID.randomUUID().toString,
                    "status" -> "pending",
                    "task" -> body.task,
                    "image" -> body.image,
                    "content_hash" -> MessageDigest.getInstance("SHA-256").digest(payload).map("%02x".format(_)).mkString,
                    "created_at" -> System.currentTimeMillis() / 1000
                  )
                  Inferences.put(tenant, inference("inference_id").str, inference)
                  system.log.info(s"inference \${inference("inference_id").str} tenant=$tenant task=\${body.task}")
                  json(StatusCodes.Created, inference)
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
      solution: `import java.security.MessageDigest
import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

import vision.{Inferences, Objects}

final case class InferenceRequest(image: String, task: String)

object VisionApi {
  implicit val system: ActorSystem = ActorSystem("vision-inference")
  implicit val requestFormat: RootJsonFormat[InferenceRequest] = jsonFormat2(InferenceRequest)

  val AllowedTasks = Set("classify", "detect", "embed")
  def TenantPrefix(tenant: String): String = s"tenants/$tenant/images/"

  private def json(status: StatusCode, body: ujson.Value) =
    complete(HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, ujson.write(body))))

  /** A storage key under the tenant's own prefix: no scheme, no '..' segment. */
  def inScope(tenant: String, key: String): Boolean =
    !key.contains("://") && !key.split("/").contains("..") && key.startsWith(TenantPrefix(tenant))

  val route: Route =
    path("v1" / "inferences") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          optionalHeaderValueByName("Idempotency-Key") { idemOpt =>
            entity(as[InferenceRequest]) { body =>
              if (!tenantOpt.exists(_.nonEmpty)) {
                json(StatusCodes.Unauthorized, ujson.Obj("error" -> "missing X-Tenant-Id"))
              } else if (!idemOpt.exists(_.nonEmpty)) {
                json(StatusCodes.BadRequest, ujson.Obj("error" -> "Idempotency-Key is required"))
              } else if (!AllowedTasks.contains(body.task)) {
                json(StatusCodes.BadRequest, ujson.Obj("error" -> "task must be classify, detect or embed"))
              } else if (!inScope(tenantOpt.get, body.image)) {
                json(StatusCodes.Forbidden, ujson.Obj("error" -> "image is outside the tenant's storage prefix"))
              } else {
                val tenant = tenantOpt.get
                val idemKey = idemOpt.get
                Inferences.get(tenant, idemKey) match {
                  case Some(stored) => json(StatusCodes.OK, stored)
                  case None =>
                    Objects.fetchObject(body.image) match {
                      case None => json(StatusCodes.NotFound, ujson.Obj("error" -> "no such image"))
                      case Some(payload) =>
                        val inference = ujson.Obj(
                          "inference_id" -> UUID.randomUUID().toString,
                          "status" -> "pending",
                          "task" -> body.task,
                          "image" -> body.image,
                          "content_hash" -> MessageDigest.getInstance("SHA-256").digest(payload).map("%02x".format(_)).mkString,
                          "created_at" -> System.currentTimeMillis() / 1000
                        )
                        Inferences.put(tenant, idemKey, inference)
                        system.log.info(s"inference \${inference("inference_id").str} tenant=$tenant task=\${body.task}")
                        json(StatusCodes.Created, inference)
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

#include <chrono>
#include <iostream>
#include <string>

#include "digest.h"              // sha256_hex(bytes) — provided
#include "ids.h"                 // new_uuid() — provided
#include "vision/inferences.h"  // inferences::get(tenant, idem_key), inferences::put(tenant, idem_key, inference) — provided
#include "vision/objects.h"     // objects::fetch_object(key) — provided

using json = nlohmann::json;

long long now_s() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

void create_inference(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
    return;
  }
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) {
    res.status = 400;
    res.set_content(R"({"error":"invalid json"})", "application/json");
    return;
  }
  const std::string image = body.value("image", std::string());
  const auto payload = objects::fetch_object(image);
  if (!payload) {
    res.status = 404;
    res.set_content(R"({"error":"no such image"})", "application/json");
    return;
  }
  const json inference = {
      {"inference_id", new_uuid()},
      {"status", "pending"},
      {"task", body.value("task", std::string())},
      {"image", image},
      {"content_hash", sha256_hex(*payload)},
      {"created_at", now_s()},
  };
  inferences::put(tenant, inference["inference_id"].get<std::string>(), inference);
  std::cerr << "inference " << inference["inference_id"] << " tenant=" << tenant << "\\n";
  res.status = 201;
  res.set_content(inference.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/inferences", create_inference); }

int main() {
  httplib::Server svr;
  register_routes(svr);
  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <iostream>
#include <set>
#include <sstream>
#include <string>

#include "digest.h"              // sha256_hex(bytes) — provided
#include "ids.h"                 // new_uuid() — provided
#include "vision/inferences.h"  // inferences::get(tenant, idem_key), inferences::put(tenant, idem_key, inference) — provided
#include "vision/objects.h"     // objects::fetch_object(key) — provided

using json = nlohmann::json;

const std::set<std::string> kAllowedTasks = {"classify", "detect", "embed"};

// The storage prefix a tenant's images live under.
std::string kTenantPrefix(const std::string& tenant) { return "tenants/" + tenant + "/images/"; }

long long now_s() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

void reject(httplib::Response& res, int status, const std::string& error) {
  res.status = status;
  res.set_content(json({{"error", error}}).dump(), "application/json");
}

// A storage key under the tenant's own prefix: no scheme, no ".." segment.
bool in_scope(const std::string& tenant, const std::string& key) {
  if (key.find("://") != std::string::npos || key.rfind(kTenantPrefix(tenant), 0) != 0) return false;
  std::stringstream parts(key);
  for (std::string segment; std::getline(parts, segment, '/');) {
    if (segment == "..") return false;
  }
  return true;
}

void create_inference(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reject(res, 401, "missing X-Tenant-Id");
  const std::string idem_key = req.get_header_value("Idempotency-Key");
  if (idem_key.empty()) return reject(res, 400, "Idempotency-Key is required");
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return reject(res, 400, "invalid json");
  const std::string task = body.value("task", std::string());
  const std::string image = body.value("image", std::string());
  if (kAllowedTasks.count(task) == 0) return reject(res, 400, "task must be classify, detect or embed");
  if (!in_scope(tenant, image)) return reject(res, 403, "image is outside the tenant's storage prefix");

  if (const auto stored = inferences::get(tenant, idem_key)) {
    res.status = 200;
    res.set_content(stored->dump(), "application/json");
    return;
  }
  const auto payload = objects::fetch_object(image);
  if (!payload) return reject(res, 404, "no such image");
  const json inference = {
      {"inference_id", new_uuid()},
      {"status", "pending"},
      {"task", task},
      {"image", image},
      {"content_hash", sha256_hex(*payload)},
      {"created_at", now_s()},
  };
  inferences::put(tenant, idem_key, inference);
  std::cerr << "inference " << inference["inference_id"] << " tenant=" << tenant << " task=" << task << "\\n";
  res.status = 201;
  res.set_content(inference.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/inferences", create_inference); }

int main() {
  httplib::Server svr;
  register_routes(svr);
  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  harness: {
    python: `import hashlib
import json

CAT = "tenants/t1/images/cat.jpg"
CAT_BYTES = b"jpeg:tabby cat on a sofa"
FOREIGN = "tenants/t2/images/cat.jpg"
GOOD = {"image": CAT, "task": "classify"}
FIELDS = ("inference_id", "status", "task", "image", "content_hash", "created_at")
OUT_OF_SCOPE = (
    FOREIGN,
    "s3://internal-models/weights.bin",
    "https://169.254.169.254/latest/meta-data/",
    "tenants/t1/images/../../t2/images/cat.jpg",
    "tenants/t1-other/images/cat.jpg",
)


def _seed(ctx):
    ctx.redis_bytes.set(f"vision:object:{CAT}", CAT_BYTES)
    for key in OUT_OF_SCOPE:
        ctx.redis_bytes.set(f"vision:object:{key}", b"jpeg:someone else's bytes")


def _api(ctx):
    _seed(ctx)
    return ctx.client(ctx.load("api").app)


async def _post(c, body, key="k-1", tenant="t1", with_key=True):
    headers = {"X-Tenant-Id": tenant}
    if with_key:
        headers["Idempotency-Key"] = key
    return await c.post("/v1/inferences", json=body, headers=headers)


def _rows(ctx):
    return sorted(ctx.redis.keys("vision:inference:*"))


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await _post(c, GOOD)
        assert r.status_code == 201, f"a valid request answered {r.status_code}: {r.text}"
        inference = r.json()
        for key in FIELDS:
            assert key in inference, f"the 201 body lacks {key!r}: {inference}"
        assert inference["status"] == "pending" and inference["task"] == "classify" and inference["image"] == CAT, f"a new inference is pending and echoes the request: {inference}"
        assert inference["content_hash"] == hashlib.sha256(CAT_BYTES).hexdigest(), f"content_hash must be the SHA-256 of the object's bytes, got {inference['content_hash']!r}"
        raw = ctx.redis.get(f"vision:inference:{inference['inference_id']}")
        assert raw is not None, f"the inference must be in the store (vision:inference:{{id}}): keys {sorted(ctx.redis.keys('vision:*'))}"
        assert json.loads(raw).get("tenant") == "t1", f"the stored row carries the tenant: {raw}"
        r = await c.post("/v1/inferences", json=GOOD, headers={"Idempotency-Key": "k-2"})
        assert r.status_code == 401, f"without X-Tenant-Id the request must answer 401, got {r.status_code}"
        r = await _post(c, {"image": "tenants/t1/images/missing.jpg", "task": "classify"}, key="k-3")
        assert r.status_code == 404, f"a key with no object behind it answered {r.status_code}, expected 404"


async def check_task_catalog(ctx):
    async with _api(ctx) as c:
        r = await _post(c, {"image": CAT, "task": "segment-everything"}, key="k-bad")
        assert r.status_code == 400, f"task 'segment-everything' answered {r.status_code}, expected 400: the model router has no such task"
        assert _rows(ctx) == [], f"a refused task must store no inference, found {_rows(ctx)}"
        for i, task in enumerate(("classify", "detect", "embed")):
            r = await _post(c, {"image": CAT, "task": task}, key=f"k-{i}")
            assert r.status_code == 201, f"task {task!r} is in the catalog, got {r.status_code}: {r.text}"


async def check_tenant_scope(ctx):
    async with _api(ctx) as c:
        for i, key in enumerate(OUT_OF_SCOPE):
            r = await _post(c, {"image": key, "task": "classify"}, key=f"k-{i}")
            assert r.status_code == 403, f"tenant t1 asked for {key!r} and got {r.status_code}, expected 403: only keys under tenants/t1/images/ are t1's"
        assert _rows(ctx) == [], f"refused keys must store no inference, found {_rows(ctx)}"
        r = await _post(c, GOOD, key="k-ok")
        assert r.status_code == 201, f"t1's own key {CAT} answered {r.status_code}: {r.text}"


async def check_scope_before_fetch(ctx):
    async with _api(ctx) as c:
        foreign = ctx.redis_after(f"vision:object:{FOREIGN}", lambda: "fetched")
        bucket = ctx.redis_after("vision:object:s3://internal-models/weights.bin", lambda: "fetched")
        r = await _post(c, {"image": FOREIGN, "task": "classify"}, key="k-1")
        assert not foreign.fired, f"the object {FOREIGN} was read for tenant t1 (the request answered {r.status_code}): decide the 403 before fetch_object"
        assert r.status_code == 403, f"tenant t1 asked for {FOREIGN!r} and got {r.status_code}, expected 403"
        r = await _post(c, {"image": "s3://internal-models/weights.bin", "task": "classify"}, key="k-2")
        assert r.status_code == 403 and not bucket.fired, "an s3:// key reached the object store: the scope test must run before the fetch"


async def check_idempotency_key(ctx):
    async with _api(ctx) as c:
        r = await _post(c, GOOD, with_key=False)
        assert r.status_code == 400, f"a request without Idempotency-Key answered {r.status_code}, expected 400"
        first = await _post(c, GOOD, key="k-7")
        assert first.status_code == 201, f"the first request answered {first.status_code}: {first.text}"
        replay = await _post(c, GOOD, key="k-7")
        assert replay.status_code == 200, f"a replay of the same (tenant, Idempotency-Key) answered {replay.status_code}, expected 200 with the stored inference"
        assert replay.json()["inference_id"] == first.json()["inference_id"], f"the replay must answer the same inference: got {replay.json()['inference_id']}, the first made {first.json()['inference_id']}"
        assert len(_rows(ctx)) == 1, f"one key, one inference: the store holds {len(_rows(ctx))} after a request and its replay"
        ctx.redis_bytes.set("vision:object:tenants/t2/images/cat.jpg", CAT_BYTES)
        other = await _post(c, {"image": FOREIGN, "task": "classify"}, key="k-7", tenant="t2")
        assert other.status_code == 201 and other.json()["inference_id"] != first.json()["inference_id"], "another tenant reusing the key gets its own inference (keys are per tenant)"
`,
    typescript: `import {createHash} from 'node:crypto';

const CAT = 'tenants/t1/images/cat.jpg';
const CAT_BYTES = 'jpeg:tabby cat on a sofa';
const FOREIGN = 'tenants/t2/images/cat.jpg';
const GOOD = {image: CAT, task: 'classify'};
const FIELDS = ['inference_id', 'status', 'task', 'image', 'content_hash', 'created_at'];
const OUT_OF_SCOPE = [
  FOREIGN,
  's3://internal-models/weights.bin',
  'https://169.254.169.254/latest/meta-data/',
  'tenants/t1/images/../../t2/images/cat.jpg',
  'tenants/t1-other/images/cat.jpg',
];

function api(ctx) {
  ctx.redis.set(\`vision:object:\${CAT}\`, CAT_BYTES);
  for (const key of OUT_OF_SCOPE) ctx.redis.set(\`vision:object:\${key}\`, "jpeg:someone else's bytes");
  return ctx.client(ctx.load('api').app);
}

async function post(c, body, {key = 'k-1', tenant = 't1', withKey = true} = {}) {
  const headers: Record<string, string> = {'X-Tenant-Id': tenant};
  if (withKey) headers['Idempotency-Key'] = key;
  return c.post('/v1/inferences', {body, headers});
}

const rows = ctx => ctx.redis.keys('vision:inference:*').sort();

export async function check_route(ctx) {
  const c = api(ctx);
  let r = await post(c, GOOD);
  assert.equal(r.status, 201, \`a valid request answered \${r.status}: \${r.text}\`);
  const inference = r.json();
  for (const key of FIELDS) assert(key in inference, \`the 201 body lacks \${key}: \${r.text}\`);
  assert(inference.status === 'pending' && inference.task === 'classify' && inference.image === CAT, \`a new inference is pending and echoes the request: \${r.text}\`);
  assert.equal(inference.content_hash, createHash('sha256').update(CAT_BYTES).digest('hex'), "content_hash must be the SHA-256 of the object's bytes");
  const raw = ctx.redis.get(\`vision:inference:\${inference.inference_id}\`);
  assert(raw !== null, \`the inference must be in the store (vision:inference:{id}): keys \${JSON.stringify(ctx.redis.keys('vision:*').sort())}\`);
  assert.equal(JSON.parse(raw).tenant, 't1', \`the stored row carries the tenant: \${raw}\`);
  r = await c.post('/v1/inferences', {body: GOOD, headers: {'Idempotency-Key': 'k-2'}});
  assert.equal(r.status, 401, \`without X-Tenant-Id the request must answer 401, got \${r.status}\`);
  r = await post(c, {image: 'tenants/t1/images/missing.jpg', task: 'classify'}, {key: 'k-3'});
  assert.equal(r.status, 404, \`a key with no object behind it answered \${r.status}, expected 404\`);
}

export async function check_task_catalog(ctx) {
  const c = api(ctx);
  let r = await post(c, {image: CAT, task: 'segment-everything'}, {key: 'k-bad'});
  assert.equal(r.status, 400, \`task 'segment-everything' answered \${r.status}, expected 400: the model router has no such task\`);
  assert.deepEqual(rows(ctx), [], \`a refused task must store no inference, found \${JSON.stringify(rows(ctx))}\`);
  for (const [i, task] of ['classify', 'detect', 'embed'].entries()) {
    r = await post(c, {image: CAT, task}, {key: \`k-\${i}\`});
    assert.equal(r.status, 201, \`task \${task} is in the catalog, got \${r.status}: \${r.text}\`);
  }
}

export async function check_tenant_scope(ctx) {
  const c = api(ctx);
  for (const [i, key] of OUT_OF_SCOPE.entries()) {
    const r = await post(c, {image: key, task: 'classify'}, {key: \`k-\${i}\`});
    assert.equal(r.status, 403, \`tenant t1 asked for \${key} and got \${r.status}, expected 403: only keys under tenants/t1/images/ are t1's\`);
  }
  assert.deepEqual(rows(ctx), [], \`refused keys must store no inference, found \${JSON.stringify(rows(ctx))}\`);
  const r = await post(c, GOOD, {key: 'k-ok'});
  assert.equal(r.status, 201, \`t1's own key \${CAT} answered \${r.status}: \${r.text}\`);
}

export async function check_scope_before_fetch(ctx) {
  const c = api(ctx);
  const foreign = ctx.redisAfter(\`vision:object:\${FOREIGN}\`, () => 'fetched');
  const bucket = ctx.redisAfter('vision:object:s3://internal-models/weights.bin', () => 'fetched');
  let r = await post(c, {image: FOREIGN, task: 'classify'}, {key: 'k-1'});
  assert(!foreign.fired, \`the object \${FOREIGN} was read for tenant t1 (the request answered \${r.status}): decide the 403 before fetchObject\`);
  assert.equal(r.status, 403, \`tenant t1 asked for \${FOREIGN} and got \${r.status}, expected 403\`);
  r = await post(c, {image: 's3://internal-models/weights.bin', task: 'classify'}, {key: 'k-2'});
  assert(r.status === 403 && !bucket.fired, 'an s3:// key reached the object store: the scope test must run before the fetch');
}

export async function check_idempotency_key(ctx) {
  const c = api(ctx);
  const noKey = await post(c, GOOD, {withKey: false});
  assert.equal(noKey.status, 400, \`a request without Idempotency-Key answered \${noKey.status}, expected 400\`);
  const first = await post(c, GOOD, {key: 'k-7'});
  assert.equal(first.status, 201, \`the first request answered \${first.status}: \${first.text}\`);
  const replay = await post(c, GOOD, {key: 'k-7'});
  assert.equal(replay.status, 200, \`a replay of the same (tenant, Idempotency-Key) answered \${replay.status}, expected 200 with the stored inference\`);
  assert.equal(replay.json().inference_id, first.json().inference_id, 'the replay must answer the same inference');
  assert.equal(rows(ctx).length, 1, \`one key, one inference: the store holds \${rows(ctx).length} after a request and its replay\`);
  ctx.redis.set(\`vision:object:\${FOREIGN}\`, CAT_BYTES);
  const other = await post(c, {image: FOREIGN, task: 'classify'}, {key: 'k-7', tenant: 't2'});
  assert(other.status === 201 && other.json().inference_id !== first.json().inference_id, 'another tenant reusing the key gets its own inference (keys are per tenant)');
}
`,
    go: `package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strconv"

	"leetbuild/harness"
)

const (
	apiCat      = "tenants/t1/images/cat.jpg"
	apiCatBytes = "jpeg:tabby cat on a sofa"
	apiForeign  = "tenants/t2/images/cat.jpg"
)

var apiOutOfScope = []string{
	apiForeign,
	"s3://internal-models/weights.bin",
	"https://169.254.169.254/latest/meta-data/",
	"tenants/t1/images/../../t2/images/cat.jpg",
	"tenants/t1-other/images/cat.jpg",
}

func apiClient(ctx *harness.Ctx) *harness.HTTP {
	ctx.Redis.Set("vision:object:"+apiCat, apiCatBytes)
	for _, key := range apiOutOfScope {
		ctx.Redis.Set("vision:object:"+key, "jpeg:someone else's bytes")
	}
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func apiPost(c *harness.HTTP, image, task, key, tenant string) *harness.Response {
	return c.Post("/v1/inferences", map[string]any{"image": image, "task": task}, "X-Tenant-Id", tenant, "Idempotency-Key", key)
}

func apiBody(ctx *harness.Ctx, r *harness.Response) map[string]any {
	body, ok := r.JSON().(map[string]any)
	ctx.Assert(ok, "the body must be a JSON object: %s", r.Text())
	return body
}

func CheckRoute(ctx *harness.Ctx) {
	c := apiClient(ctx)
	r := apiPost(c, apiCat, "classify", "k-1", "t1")
	ctx.Equal(r.Status, 201, "a valid request (%s)", r.Text())
	inf := apiBody(ctx, r)
	for _, key := range []string{"inference_id", "status", "task", "image", "content_hash", "created_at"} {
		_, ok := inf[key]
		ctx.Assert(ok, "the 201 body lacks %s: %s", key, r.Text())
	}
	ctx.Assert(inf["status"] == "pending" && inf["task"] == "classify" && inf["image"] == apiCat, "a new inference is pending and echoes the request: %s", r.Text())
	sum := sha256.Sum256([]byte(apiCatBytes))
	ctx.Equal(inf["content_hash"], hex.EncodeToString(sum[:]), "content_hash must be the SHA-256 of the object's bytes")
	id, _ := inf["inference_id"].(string)
	raw, ok := ctx.Redis.Get("vision:inference:" + id)
	ctx.Assert(ok, "the inference must be in the store (vision:inference:{id}): keys %v", ctx.Redis.Keys("vision:*"))
	var row map[string]any
	json.Unmarshal([]byte(raw), &row)
	ctx.Equal(row["tenant"], "t1", "the stored row carries the tenant")
	noTenant := c.Post("/v1/inferences", map[string]any{"image": apiCat, "task": "classify"}, "Idempotency-Key", "k-2")
	ctx.Equal(noTenant.Status, 401, "without X-Tenant-Id the request")
	missing := apiPost(c, "tenants/t1/images/missing.jpg", "classify", "k-3", "t1")
	ctx.Equal(missing.Status, 404, "a key with no object behind it")
}

func CheckTaskCatalog(ctx *harness.Ctx) {
	c := apiClient(ctx)
	r := apiPost(c, apiCat, "segment-everything", "k-bad", "t1")
	ctx.Equal(r.Status, 400, "task segment-everything: the model router has no such task")
	ctx.Equal(len(ctx.Redis.Keys("vision:inference:*")), 0, "a refused task must store no inference; inferences stored")
	for i, task := range []string{"classify", "detect", "embed"} {
		r = apiPost(c, apiCat, task, "k-"+strconv.Itoa(i), "t1")
		ctx.Equal(r.Status, 201, "task %s is in the catalog (%s)", task, r.Text())
	}
}

func CheckTenantScope(ctx *harness.Ctx) {
	c := apiClient(ctx)
	for i, key := range apiOutOfScope {
		r := apiPost(c, key, "classify", "k-"+strconv.Itoa(i), "t1")
		ctx.Equal(r.Status, 403, "tenant t1 asked for %s: only keys under tenants/t1/images/ are t1's", key)
	}
	ctx.Equal(len(ctx.Redis.Keys("vision:inference:*")), 0, "refused keys must store no inference; inferences stored")
	r := apiPost(c, apiCat, "classify", "k-ok", "t1")
	ctx.Equal(r.Status, 201, "t1's own key %s (%s)", apiCat, r.Text())
}

func CheckScopeBeforeFetch(ctx *harness.Ctx) {
	c := apiClient(ctx)
	foreign, bucket := false, false
	ctx.Redis.After("vision:object:"+apiForeign, func() any {
		foreign = true
		return nil
	})
	ctx.Redis.After("vision:object:s3://internal-models/weights.bin", func() any {
		bucket = true
		return nil
	})
	r := apiPost(c, apiForeign, "classify", "k-1", "t1")
	ctx.Assert(!foreign, "the object %s was read for tenant t1 (the request answered %d): decide the 403 before objects.Fetch", apiForeign, r.Status)
	ctx.Equal(r.Status, 403, "tenant t1 asked for %s", apiForeign)
	r = apiPost(c, "s3://internal-models/weights.bin", "classify", "k-2", "t1")
	ctx.Assert(r.Status == 403 && !bucket, "an s3:// key reached the object store: the scope test must run before the fetch")
}

func CheckIdempotencyKey(ctx *harness.Ctx) {
	c := apiClient(ctx)
	noKey := c.Post("/v1/inferences", map[string]any{"image": apiCat, "task": "classify"}, "X-Tenant-Id", "t1")
	ctx.Equal(noKey.Status, 400, "a request without Idempotency-Key")
	first := apiPost(c, apiCat, "classify", "k-7", "t1")
	ctx.Equal(first.Status, 201, "the first request (%s)", first.Text())
	replay := apiPost(c, apiCat, "classify", "k-7", "t1")
	ctx.Equal(replay.Status, 200, "a replay of the same (tenant, Idempotency-Key) must answer the stored inference")
	ctx.Equal(apiBody(ctx, replay)["inference_id"], apiBody(ctx, first)["inference_id"], "the replay must answer the same inference")
	ctx.Equal(len(ctx.Redis.Keys("vision:inference:*")), 1, "one key, one inference: inferences stored after a request and its replay")
	ctx.Redis.Set("vision:object:"+apiForeign, apiCatBytes)
	other := apiPost(c, apiForeign, "classify", "k-7", "t2")
	ctx.Assert(other.Status == 201 && apiBody(ctx, other)["inference_id"] != apiBody(ctx, first)["inference_id"], "another tenant reusing the key gets its own inference (keys are per tenant)")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "digest.h"

namespace {

using json = nlohmann::json;

const std::string kCat = "tenants/t1/images/cat.jpg";
const std::string kCatBytes = "jpeg:tabby cat on a sofa";
const std::string kForeign = "tenants/t2/images/cat.jpg";
const std::vector<std::string> kOutOfScope = {
    kForeign,
    "s3://internal-models/weights.bin",
    "https://169.254.169.254/latest/meta-data/",
    "tenants/t1/images/../../t2/images/cat.jpg",
    "tenants/t1-other/images/cat.jpg",
};

struct Api {
  httplib::Server svr;
  harness::HTTP http;
  explicit Api(harness::Ctx& ctx) : http(ctx.HTTP(svr)) {
    ctx.Redis.Set("vision:object:" + kCat, kCatBytes);
    for (const auto& key : kOutOfScope) ctx.Redis.Set("vision:object:" + key, "jpeg:someone else's bytes");
    register_routes(svr);
  }

  harness::Response post(const std::string& image, const std::string& task, const std::string& key = "k-1", const std::string& tenant = "t1") {
    return http.Post("/v1/inferences", json({{"image", image}, {"task", task}}).dump(), "X-Tenant-Id", tenant, "Idempotency-Key", key);
  }
};

json bodyOf(harness::Ctx& ctx, const harness::Response& r) {
  const json body = json::parse(r.Text(), nullptr, false);
  ctx.Assert(body.is_object(), "the body must be a JSON object: %s", r.Text());
  return body;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  Api api(ctx);
  const auto r = api.post(kCat, "classify");
  ctx.Equal(r.Status, 201, "a valid request (%s)", r.Text());
  const json inf = bodyOf(ctx, r);
  for (const char* key : {"inference_id", "status", "task", "image", "content_hash", "created_at"}) {
    ctx.Assert(inf.contains(key), "the 201 body lacks %s: %s", key, r.Text());
  }
  ctx.Assert(inf["status"] == "pending" && inf["task"] == "classify" && inf["image"] == kCat, "a new inference is pending and echoes the request: %s", r.Text());
  ctx.Equal(inf.value("content_hash", ""), sha256_hex(kCatBytes), "content_hash must be the SHA-256 of the object's bytes");
  const auto raw = ctx.Redis.Get("vision:inference:" + inf.value("inference_id", ""));
  ctx.Assert(raw.has_value(), "the inference must be in the store (vision:inference:{id}): keys %v", ctx.Redis.Keys("vision:*"));
  ctx.Equal(json::parse(*raw).value("tenant", ""), "t1", "the stored row carries the tenant");
  const auto noTenant = api.http.Post("/v1/inferences", json({{"image", kCat}, {"task", "classify"}}).dump(), "Idempotency-Key", "k-2");
  ctx.Equal(noTenant.Status, 401, "without X-Tenant-Id the request");
  ctx.Equal(api.post("tenants/t1/images/missing.jpg", "classify", "k-3").Status, 404, "a key with no object behind it");
}

void CheckTaskCatalog(harness::Ctx& ctx) {
  Api api(ctx);
  ctx.Equal(api.post(kCat, "segment-everything", "k-bad").Status, 400, "task segment-everything: the model router has no such task");
  ctx.Equal(ctx.Redis.Keys("vision:inference:*").size(), 0, "a refused task must store no inference; inferences stored");
  int i = 0;
  for (const char* task : {"classify", "detect", "embed"}) {
    const auto r = api.post(kCat, task, "k-" + std::to_string(i++));
    ctx.Equal(r.Status, 201, "task %s is in the catalog (%s)", task, r.Text());
  }
}

void CheckTenantScope(harness::Ctx& ctx) {
  Api api(ctx);
  int i = 0;
  for (const auto& key : kOutOfScope) {
    ctx.Equal(api.post(key, "classify", "k-" + std::to_string(i++)).Status, 403, "tenant t1 asked for %s: only keys under tenants/t1/images/ are t1's", key);
  }
  ctx.Equal(ctx.Redis.Keys("vision:inference:*").size(), 0, "refused keys must store no inference; inferences stored");
  const auto r = api.post(kCat, "classify", "k-ok");
  ctx.Equal(r.Status, 201, "t1's own key %s (%s)", kCat, r.Text());
}

void CheckScopeBeforeFetch(harness::Ctx& ctx) {
  Api api(ctx);
  bool foreign = false;
  bool bucket = false;
  ctx.Redis.After("vision:object:" + kForeign, [&foreign] { foreign = true; });
  ctx.Redis.After("vision:object:s3://internal-models/weights.bin", [&bucket] { bucket = true; });
  const auto first = api.post(kForeign, "classify", "k-1");
  ctx.Assert(!foreign, "the object %s was read for tenant t1 (the request answered %d): decide the 403 before objects::fetch_object", kForeign, first.Status);
  ctx.Equal(first.Status, 403, "tenant t1 asked for %s", kForeign);
  const auto r = api.post("s3://internal-models/weights.bin", "classify", "k-2");
  ctx.Assert(r.Status == 403 && !bucket, "an s3:// key reached the object store: the scope test must run before the fetch");
}

void CheckIdempotencyKey(harness::Ctx& ctx) {
  Api api(ctx);
  const auto noKey = api.http.Post("/v1/inferences", json({{"image", kCat}, {"task", "classify"}}).dump(), "X-Tenant-Id", "t1");
  ctx.Equal(noKey.Status, 400, "a request without Idempotency-Key");
  const auto first = api.post(kCat, "classify", "k-7");
  ctx.Equal(first.Status, 201, "the first request (%s)", first.Text());
  const auto replay = api.post(kCat, "classify", "k-7");
  ctx.Equal(replay.Status, 200, "a replay of the same (tenant, Idempotency-Key) must answer the stored inference");
  ctx.Equal(bodyOf(ctx, replay)["inference_id"], bodyOf(ctx, first)["inference_id"], "the replay must answer the same inference");
  ctx.Equal(ctx.Redis.Keys("vision:inference:*").size(), 1, "one key, one inference: inferences stored after a request and its replay");
  ctx.Redis.Set("vision:object:" + kForeign, kCatBytes);
  const auto other = api.post(kForeign, "classify", "k-7", "t2");
  ctx.Assert(other.Status == 201 && bodyOf(ctx, other)["inference_id"] != bodyOf(ctx, first)["inference_id"], "another tenant reusing the key gets its own inference (keys are per tenant)");
}
`,
  },
  hints: [
    "Symptom: tenant t1 posts another tenant's image key, or `s3://internal-models/weights.bin`, and gets a 201 with that object's digest; a client that retried a slow request finds two inferences.",
    'Mechanism: nothing stands between the decoded body and `fetch_object`: the key is dereferenced as given, the task is copied as given, and the store key is a fresh id the client never sends again.',
    'Change: guards in order (tenant 401, Idempotency-Key 400, `ALLOWED_TASKS` 400, `TENANT_PREFIX` with no `://` and no `..` 403), then `store.get(tenant, key)`, then the fetch, then `store.put(tenant, key, inference)`.',
  ],
  debrief: `The guards run in cost order and every one returns before the object store is touched, which is why the 403 has to come before the fetch: once the bytes are read, the cross-tenant read already happened, whatever the response says. The scope test is an allow-list (the tenant's own prefix, no scheme, no \`..\`) rather than a deny-list of internal hosts, because a deny-list loses to the next URL form. Keying by \`(tenant, Idempotency-Key)\` makes a retry answer the inference it already started. Production services go further: presigned uploads that put the bytes under the prefix in the first place, a media-type sniff on the object, and a per-tenant byte quota checked before the GPU is asked for anything.`,
};
