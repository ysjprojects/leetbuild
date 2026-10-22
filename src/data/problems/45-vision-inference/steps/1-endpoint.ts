import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/inferences: an image contract that is validated up front',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'store'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, decodes
the body and returns an inference id. It compiles, it serves the demo, and it hides three production
flaws. Review it like the service owner, fix it, and prove the fix with the checks below.

Implement \`POST /v1/inferences\` with body
\`{"image": "tenants/acme/images/9f2c…c41.jpg", "task": "classify"}\`.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- \`image\` is a **storage key, never a URL**. Reject anything with a scheme (\`http://\`,
  \`https://\`, \`s3://\`, \`gs://\`), anything with a \`..\` segment, and any key that does not start
  with the tenant's prefix \`tenants/{tenant}/images/\` with **403 — before the object is fetched**.
  The endpoint is not a proxy: a caller must never be able to make the service dereference a key in
  another tenant's bucket, an internal bucket, or the metadata service.
- \`task\` is one of \`classify\`, \`detect\`, \`embed\`; anything else is **400**.
- \`Idempotency-Key\` is required (**400** when missing). The storage key ends with the image's
  **content hash** (\`…/<sha256>.jpg\`), so the digest is known before the fetch: read and write the
  inference store under \`(tenant, content_hash)\`, and a replay with the same key returns the
  **stored inference** with 200 instead of running the model a second time.
- Log the decision with tenant, task and digest — never the caller's raw reference.

**Failure mode the checks target.** The draft hands the caller's string straight to the fetch helper,
so a crafted reference is a server-side request forgery probe against every bucket the service can
reach. It accepts any task name, so an unknown task reaches the model router and fails there instead
of at the boundary. And it keys nothing: every client retry re-runs inference on the same bytes, which
bills the tenant twice for one image.`,
  sequence: {
    participants: ['Client', 'Vision API', 'Inference store', 'Object store'],
    messages: [
      {from: 'Client', to: 'Vision API', label: 'POST /v1/inferences · X-Tenant-Id · Idempotency-Key', kind: 'sync'},
      {from: 'Vision API', to: 'Vision API', label: 'validate tenant · task · tenant prefix (403)', kind: 'sync'},
      {from: 'Vision API', to: 'Inference store', label: 'get(tenant, content_hash)', kind: 'sync'},
      {from: 'Inference store', to: 'Vision API', label: 'stored inference / none', kind: 'reply'},
      {from: 'Vision API', to: 'Object store', label: 'fetch tenants/acme/images/<sha>.jpg', kind: 'async'},
      {from: 'Vision API', to: 'Inference store', label: 'put(tenant, content_hash, inference)', kind: 'sync'},
      {from: 'Vision API', to: 'Client', label: '200 {id, task, content_hash}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/inferences',
      detail: 'Register the inference route on `POST /v1/inferences`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/inferences["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/inferences['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/inferences"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"inferences"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/inferences"/]},
      },
    },
    {
      id: 'tenant',
      title: 'Authenticates the tenant before anything else',
      detail:
        'A request without `X-Tenant-Id` is **401**. The draft reads the header and uses it as a label, so an anonymous caller still gets a fetch.',
      match: {
        python: {all: [/X-Tenant-Id/, /status_code\s*=\s*401/]},
        typescript: {all: [/x-tenant-id/, /code\(\s*401\s*\)/]},
        go: {all: [/X-Tenant-Id/, /StatusUnauthorized/]},
        scala: {all: [/X-Tenant-Id/, /StatusCodes\.Unauthorized/]},
        cpp: {all: [/X-Tenant-Id/, /\b401\b/]},
      },
    },
    {
      id: 'task',
      title: 'Whitelists the task',
      detail:
        '`task` is checked against `classify` / `detect` / `embed` and an unknown value is **400**. The draft forwards whatever string the caller sent to the model.',
      match: {
        python: {all: [/ALLOWED_TASKS/, /status_code\s*=\s*400/]},
        typescript: {all: [/ALLOWED_TASKS/, /code\(\s*400\s*\)/]},
        go: {all: [/allowedTasks/, /StatusBadRequest/]},
        scala: {all: [/AllowedTasks/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kAllowedTasks/, /\b400\b/]},
      },
    },
    {
      id: 'scope',
      title: 'Refuses a foreign storage prefix with 403 before the fetch',
      detail:
        'The key must start with the tenant prefix and must not carry a scheme or a `..` segment; a violation is **403** and the check lands before `fetch_object` is called. The draft fetches first, so this order is the whole point.',
      match: {
        python: {all: [/TENANT_PREFIX/, /status_code\s*=\s*403/], order: [/status_code\s*=\s*403/, /fetch_object\(/]},
        typescript: {all: [/TENANT_PREFIX/, /code\(\s*403\s*\)/], order: [/code\(\s*403\s*\)/, /fetchObject\(/]},
        go: {all: [/tenantPrefix/, /StatusForbidden/], order: [/StatusForbidden/, /fetchObject\(/]},
        scala: {all: [/TenantPrefix/, /StatusCodes\.Forbidden/], order: [/StatusCodes\.Forbidden/, /fetchObject\(/]},
        cpp: {all: [/kTenantPrefix/, /\b403\b/], order: [/\b403\b/, /fetchObject\(/]},
      },
    },
    {
      id: 'idempotency',
      title: 'Keys retries by (tenant, content hash)',
      detail:
        '`Idempotency-Key` is required and the inference is stored under `(tenant, content_hash)`; a replay returns the stored inference instead of running the model again. The draft ignores the header and the digest entirely.',
      match: {
        python: {all: [/Idempotency-Key/, /content_hash/, /store\.get\(/, /store\.put\(/]},
        typescript: {all: [/idempotency-key/, /content_hash/, /store\.get\(/, /store\.put\(/]},
        go: {all: [/Idempotency-Key/, /contentHash/, /store\.Get\(/, /store\.Put\(/]},
        scala: {all: [/Idempotency-Key/, /contentHash/, /store\.get\(/, /store\.put\(/]},
        cpp: {all: [/Idempotency-Key/, /contentHash/, /store\.get\(/, /store\.put\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""POST /v1/inferences: a model-generated draft that fetches whatever the caller names."""
from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()


class InferenceRequest(BaseModel):
    image: str
    task: str = "classify"


class InferenceStore:
    def get(self, tenant: str, key: str):
        """The inference stored for (tenant, key), if any."""
        raise NotImplementedError

    def put(self, tenant: str, key: str, inference: dict) -> None:
        """Store the inference under (tenant, key)."""
        raise NotImplementedError


store = InferenceStore()


@app.post("/v1/inferences")
def create_inference(body: InferenceRequest, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this draft dereferences whatever object URL the caller sends, accepts any task name,
    # and collapses nothing — every retry runs the model again. Review all three.
    payload = fetch_object(body.image)
    return JSONResponse(
        {"id": "inf-1", "tenant": tenant, "task": body.task, "bytes": len(payload)},
        status_code=200,
    )


def fetch_object(reference: str) -> bytes:
    """Dereference any reference the caller supplied."""
    raise NotImplementedError
`,
      solution: `"""POST /v1/inferences: validated, tenant-scoped and idempotent inference requests."""
import logging
import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("vision")

ALLOWED_TASKS = {"classify", "detect", "embed"}
TENANT_PREFIX = "tenants/{tenant}/images/"


class InferenceRequest(BaseModel):
    image: str
    task: str = "classify"


class InferenceStore:
    def get(self, tenant: str, content_hash: str) -> dict | None:
        """The inference stored for (tenant, content_hash), if any."""
        raise NotImplementedError

    def put(self, tenant: str, content_hash: str, inference: dict) -> None:
        """Store the inference under (tenant, content_hash)."""
        raise NotImplementedError


store = InferenceStore()


def scoped_key(tenant: str, image: str) -> str:
    """The tenant's object key for \`image\`, or 403 when it leaves the tenant's prefix."""
    prefix = TENANT_PREFIX.format(tenant=tenant)
    if "://" in image or ".." in image or not image.startswith(prefix):
        raise HTTPException(status_code=403, detail="image reference is outside the tenant prefix")
    return image


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
        raise HTTPException(status_code=400, detail=f"unknown task {body.task}")

    key = scoped_key(tenant, body.image)
    # The scoped key ends with the image's content hash, so the lookup precedes the fetch.
    digest = key.rsplit("/", 1)[-1].split(".", 1)[0]
    stored = store.get(tenant, digest)
    if stored is not None:
        return JSONResponse(stored, status_code=200)

    payload = fetch_object(key)
    inference = {
        "id": str(uuid.uuid4()),
        "tenant": tenant,
        "task": body.task,
        "content_hash": digest,
        "bytes": len(payload),
    }
    store.put(tenant, digest, inference)
    logger.info("inference tenant=%s task=%s digest=%s", tenant, body.task, digest)
    return JSONResponse(inference, status_code=200)


def fetch_object(key: str) -> bytes:
    """Read \`key\` from the tenant's bucket — only ever called with a scoped key."""
    raise NotImplementedError
`,
    },
    typescript: {
      starter: `/** POST /v1/inferences: a model-generated draft that fetches whatever the caller names. */
import Fastify from 'fastify';

export const app = Fastify();

interface InferenceBody {
  image: string;
  task?: string;
}

app.post('/v1/inferences', async (request, reply) => {
  // TODO: this draft dereferences whatever object URL the caller sends, accepts any task name,
  // and collapses nothing — every retry runs the model again. Review all three.
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as InferenceBody;
  const payload = await fetchObject(body.image);
  return reply.code(200).send({id: 'inf-1', tenant, task: body.task ?? 'classify', bytes: payload.length});
});

async function fetchObject(reference: string): Promise<Buffer> {
  throw new Error(\`dereference \${reference}\`);
}

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/inferences: validated, tenant-scoped and idempotent inference requests. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import {store} from './store';

export const app = Fastify();

const ALLOWED_TASKS: Record<string, true> = {classify: true, detect: true, embed: true};
const TENANT_PREFIX = 'tenants/';

interface InferenceBody {
  image: string;
  task?: string;
}

interface Inference {
  id: string;
  tenant: string;
  task: string;
  content_hash: string;
  bytes: number;
}

app.post('/v1/inferences', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '') return reply.code(400).send({error: 'Idempotency-Key is required'});
  const body = request.body as Partial<InferenceBody> | null;
  if (body === null || typeof body !== 'object' || typeof body.image !== 'string' || body.image === '')
    return reply.code(400).send({error: 'image must be a non-empty storage key'});
  const task = body.task ?? 'classify';
  if (ALLOWED_TASKS[task] !== true) return reply.code(400).send({error: 'unknown task'});

  // The caller names a key inside its own prefix — never an object URL the service would dereference.
  const prefix = \`\${TENANT_PREFIX}\${tenant}/images/\`;
  if (body.image.includes('://') || body.image.includes('..') || !body.image.startsWith(prefix))
    return reply.code(403).send({error: 'image reference is outside the tenant prefix'});

  const contentHash = body.image.split('/').pop()!.split('.')[0];
  const stored: Inference | null = await store.get(tenant, contentHash);
  if (stored !== null) return reply.code(200).send(stored);

  const payload = fetchObject(body.image);
  const inference: Inference = {
    id: randomUUID(),
    tenant,
    task,
    content_hash: contentHash,
    bytes: payload.byteLength,
  };
  await store.put(tenant, contentHash, inference);
  request.log.info({tenant, task, digest: contentHash}, 'inference accepted');
  return reply.code(200).send(inference);
});

/** Reads the object; only ever called with a key that passed the tenant prefix check. */
function fetchObject(key: string): Buffer {
  throw new Error(\`not implemented for \${key}\`);
}

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"
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
	// TODO: this draft dereferences whatever object URL the caller sends, accepts any task name,
	// and collapses nothing — every retry runs the model again. Review all three.
	tenant := r.Header.Get("X-Tenant-Id")
	var body InferenceRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	payload, _ := fetchObject(r.Context(), body.Image)
	writeJSON(rw, http.StatusOK, map[string]any{
		"id":     "inf-1",
		"tenant": tenant,
		"task":   body.Task,
		"bytes":  len(payload),
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/inferences", createInference)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}

func fetchObject(ctx context.Context, reference string) ([]byte, error) {
	return nil, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"

	"github.com/google/uuid"
)

const tenantPrefix = "tenants/"

var allowedTasks = map[string]bool{"classify": true, "detect": true, "embed": true}

type InferenceRequest struct {
	Image string \`json:"image"\`
	Task  string \`json:"task"\`
}

type InferenceStore struct{}

func (s *InferenceStore) Get(ctx context.Context, tenant, contentHash string) (map[string]any, error) {
	return nil, nil
}

func (s *InferenceStore) Put(ctx context.Context, tenant, contentHash string, inference map[string]any) error {
	return nil
}

var store = &InferenceStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

// scopedKey returns the tenant's object key, or ok=false when the reference leaves the prefix.
func scopedKey(tenant, image string) (string, bool) {
	if strings.Contains(image, "://") || strings.Contains(image, "..") {
		return "", false
	}
	return image, strings.HasPrefix(image, tenantPrefix+tenant+"/images/")
}

// contentHash reads the digest the storage key ends with, so the lookup can precede the fetch.
func contentHash(key string) string {
	base := key[strings.LastIndex(key, "/")+1:]
	return strings.SplitN(base, ".", 2)[0]
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
	if body.Task == "" {
		body.Task = "classify"
	}
	if !allowedTasks[body.Task] {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "unknown task"})
		return
	}
	key, ok := scopedKey(tenant, body.Image)
	if !ok {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "image reference is outside the tenant prefix"})
		return
	}
	digest := contentHash(key)
	stored, err := store.Get(r.Context(), tenant, digest)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if stored != nil {
		writeJSON(rw, http.StatusOK, stored)
		return
	}
	payload, err := fetchObject(r.Context(), key)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "STORAGE_UNAVAILABLE"})
		return
	}
	inference := map[string]any{
		"id":           uuid.NewString(),
		"tenant":       tenant,
		"task":         body.Task,
		"content_hash": digest,
		"bytes":        len(payload),
	}
	if err := store.Put(r.Context(), tenant, digest, inference); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("inference tenant=%s task=%s digest=%s", tenant, body.Task, digest)
	writeJSON(rw, http.StatusOK, inference)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/inferences", createInference)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}

// fetchObject reads a key from the object store; the caller has already scoped it to the tenant.
func fetchObject(ctx context.Context, key string) ([]byte, error) {
	return nil, nil
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

final case class InferenceRequest(image: String, task: String)

object VisionApi {
  implicit val system: ActorSystem = ActorSystem("vision-api")
  implicit val inferenceRequestFormat: RootJsonFormat[InferenceRequest] = jsonFormat2(InferenceRequest)

  val route: Route =
    path("v1" / "inferences") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[InferenceRequest]) { body =>
            // TODO: this draft dereferences whatever object URL the caller sends, accepts any task
            // name, and collapses nothing — every retry runs the model again.
            val payload = fetchObject(body.image)
            complete(
              StatusCodes.OK,
              s"""{"id":"inf-1","tenant":"$tenant","task":"\${body.task}","bytes":\${payload.length}}"""
            )
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}

object ObjectStore {
  def fetchObject(reference: String): Array[Byte] = Array.emptyByteArray
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

final case class InferenceRequest(image: String, task: String)
final case class Inference(id: String, tenant: String, task: String, content_hash: String, bytes: Int)

object VisionApi {
  implicit val system: ActorSystem = ActorSystem("vision-api")
  implicit val inferenceRequestFormat: RootJsonFormat[InferenceRequest] = jsonFormat2(InferenceRequest)
  implicit val inferenceFormat: RootJsonFormat[Inference] = jsonFormat5(Inference)

  val AllowedTasks = Set("classify", "detect", "embed")
  val TenantPrefix = "tenants/"

  val store = InferenceStore.open()

  val route: Route =
    path("v1" / "inferences") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          optionalHeaderValueByName("Idempotency-Key") { idemOpt =>
            entity(as[InferenceRequest]) { body =>
              val tenant = tenantOpt.getOrElse("")
              val task = if (body.task.isEmpty) "classify" else body.task
              if (tenant.isEmpty) {
                complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
              } else if (!idemOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.BadRequest, """{"error":"Idempotency-Key is required"}""")
              } else if (!AllowedTasks.contains(task)) {
                complete(StatusCodes.BadRequest, """{"error":"unknown task"}""")
              } else if (body.image.contains("://") || body.image.contains("..") ||
                         !body.image.startsWith(s"$TenantPrefix$tenant/images/")) {
                complete(StatusCodes.Forbidden, """{"error":"image reference is outside the tenant prefix"}""")
              } else {
                // The scoped key ends with the image's content hash, so the lookup precedes the fetch.
                val contentHash = body.image.split("/").last.split("\\.").head
                store.get(tenant, contentHash) match {
                  case Some(stored) =>
                    complete(StatusCodes.OK, stored)
                  case None =>
                    val payload = fetchObject(body.image)
                    val inference =
                      Inference(UUID.randomUUID().toString, tenant, task, contentHash, payload.length)
                    store.put(tenant, contentHash, inference)
                    system.log.info(s"inference tenant=$tenant task=$task digest=$contentHash")
                    complete(StatusCodes.OK, inference)
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

object ObjectStore {
  /** Reads a key from the object store; the caller has already scoped it to the tenant. */
  def fetchObject(key: String): Array[Byte] = Array.emptyByteArray
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <string>

using json = nlohmann::json;

int main() {
  httplib::Server svr;

  svr.Post("/v1/inferences", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft dereferences whatever object URL the caller sends, accepts any task name,
    // and collapses nothing — every retry runs the model again. Review all three.
    const auto tenant = req.get_header_value("X-Tenant-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    const auto payload = fetchObject(body.value("image", std::string()));
    res.status = 200;
    res.set_content(
        json{{"id", "inf-1"}, {"tenant", tenant}, {"task", body.value("task", std::string("classify"))},
             {"bytes", payload.size()}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}

std::string fetchObject(const std::string& reference) { return reference; }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <optional>
#include <set>
#include <string>

using json = nlohmann::json;

const std::set<std::string> kAllowedTasks = {"classify", "detect", "embed"};
const std::string kTenantPrefix = "tenants/";

struct InferenceStore {
  std::optional<json> get(const std::string& tenant, const std::string& contentHash);
  void put(const std::string& tenant, const std::string& contentHash, const json& inference);
};

InferenceStore store;
std::string uuidString();

/** The scoped key ends with the image's content hash, so the lookup can precede the fetch. */
std::string contentHash(const std::string& key) {
  const auto slash = key.find_last_of('/');
  const auto dot = key.find('.', slash);
  return key.substr(slash + 1, dot - slash - 1);
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/inferences", [](const httplib::Request& req, httplib::Response& res) {
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
    if (!body.is_object() || !body.contains("image") || !body["image"].is_string()) {
      res.status = 400;
      res.set_content(R"({"error":"image must be a non-empty storage key"})", "application/json");
      return;
    }
    const auto image = body["image"].get<std::string>();
    const auto task = body.value("task", std::string("classify"));
    if (kAllowedTasks.count(task) == 0) {
      res.status = 400;
      res.set_content(R"({"error":"unknown task"})", "application/json");
      return;
    }
    const auto prefix = kTenantPrefix + tenant + "/images/";
    if (image.find("://") != std::string::npos || image.find("..") != std::string::npos ||
        image.rfind(prefix, 0) != 0) {
      res.status = 403;
      res.set_content(R"({"error":"image reference is outside the tenant prefix"})", "application/json");
      return;
    }
    const auto digest = contentHash(image);
    const auto stored = store.get(tenant, digest);
    if (stored) {
      res.status = 200;
      res.set_content(stored->dump(), "application/json");
      return;
    }
    const auto payload = fetchObject(image);
    const json inference = {
        {"id", uuidString()},
        {"tenant", tenant},
        {"task", task},
        {"content_hash", digest},
        {"bytes", payload.size()},
    };
    store.put(tenant, digest, inference);
    std::cerr << "inference tenant=" << tenant << " task=" << task << " digest=" << digest << "\\n";
    res.status = 200;
    res.set_content(inference.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}

/** Reads a key from the object store; the caller has already scoped it to the tenant. */
std::string fetchObject(const std::string& key) { return key; }
`,
    },
  },
  hints: [
    'Order the guards by cost: tenant, Idempotency-Key, task, key scope, then the store lookup. Every one of them returns before the object store or the model is touched, so a malformed request cannot make the service read anything.',
    "The scope check is a prefix test on the tenant's own key space — `tenants/{tenant}/images/` — plus a refusal of any scheme or `..` segment. It is not a deny-list of internal hostnames: a deny-list loses to the next URL form you did not think of.",
    'The digest is already in the key (`…/<sha256>.jpg`), which is what lets the idempotency lookup happen before the fetch: `store.get(tenant, content_hash)` on a replay answers with the first inference and never re-reads the object.',
  ],
  debrief: `The interviewer is testing whether you can review a generated handler at the trust boundary. The
draft reads fine because the demo posts one well-formed key from one tenant and never retries. Three
separate defects are being checked: authentication (the tenant is never optional), a scoped key
contract (the caller names a key inside its own prefix, never a URL the service dereferences), and
idempotency keyed by the content hash so a retry cannot bill the same bytes twice. The subtle one is
the ordering: the 403 has to land before the fetch, and a deny-list of "internal" hosts is not a
scope. Real vision services add short-lived presigned uploads, a per-tenant byte quota, a media type
check on the object, and a signed digest so a caller cannot claim a hash its bytes do not produce.`,
};
