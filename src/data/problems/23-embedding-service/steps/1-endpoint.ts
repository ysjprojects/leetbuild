import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/embeddings: batches that stay inside their caps',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, embeds
the batch and writes the vectors. It compiles, it serves the demo, and it hides three production
flaws. Review it like the service owner, fix it, and prove the fix with the checks below.

Implement \`POST /v1/embeddings\` with body \`{"inputs": ["…", "…"]}\`.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- A batch holds **1..256** inputs; a 257th input is **400** (\`MAX_BATCH_INPUTS\`). The draft
  embeds however many the caller sends, so one request can pin a worker and the model server for
  minutes.
- Each input is at most **8 KiB** (\`MAX_INPUT_BYTES = 8192\`) of UTF-8; a longer one is **413**.
- \`Idempotency-Key\` is required (**400** when missing). The key is the SHA-256 of
  \`(tenant, model version, input)\`, so a model upgrade changes the digest instead of replaying the
  previous model's vectors. A replay returns the **stored vectors** instead of embedding again.
- Log the decision with tenant, model version and batch size — never the input text.

**Failure mode the checks target.** The draft hashes the input text alone, so after a model upgrade
every lookup is a hit and the service serves stale vectors forever; it caps neither the batch nor the
input, so one request pays for an unbounded amount of model work; and it ignores \`Idempotency-Key\`,
so the client retry every SDK performs is embedded — and billed — twice.`,
  sequence: {
    participants: ['Client', 'Embedding API', 'model server', 'vector cache'],
    messages: [
      {from: 'Client', to: 'Embedding API', label: 'POST /v1/embeddings · X-Tenant-Id · Idempotency-Key', kind: 'sync'},
      {from: 'Embedding API', to: 'Embedding API', label: 'validate batch ≤ 256 · input ≤ 8 KiB', kind: 'sync'},
      {from: 'Embedding API', to: 'vector cache', label: 'get idem:{tenant}:{key}', kind: 'sync'},
      {from: 'vector cache', to: 'Embedding API', label: 'stored vectors / none', kind: 'reply'},
      {
        from: 'Embedding API',
        to: 'model server',
        label: 'Embed(inputs) · digest = sha256(tenant, version, input)',
        kind: 'sync',
      },
      {from: 'model server', to: 'Embedding API', label: 'vectors', kind: 'reply'},
      {from: 'Embedding API', to: 'Client', label: '200 {model_version, content_hashes, vectors}', kind: 'reply'},
    ],
  },
  hints: [
    'Validate the tenant, the Idempotency-Key, the batch size and every input length before the model server is touched: a rejected request must cost nothing.',
    "Hash tenant, model version and input together — the version belongs inside the digest, not only in the cache key, or an upgrade reads the old model's vectors.",
    'Look the Idempotency-Key up before embedding; on a hit return the stored response so a retry never bills twice.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/embeddings',
      detail: 'Register the embedding route on `POST /v1/embeddings`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/embeddings["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/embeddings['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/embeddings"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"embeddings"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/embeddings"/]},
      },
    },
    {
      id: 'batch-cap',
      title: 'Caps the batch at 256 inputs',
      detail:
        'More than `MAX_BATCH_INPUTS = 256` inputs is **400**. The draft embeds any batch size, so one request can pin a worker and the model server for minutes.',
      match: {
        python: {all: [/MAX_BATCH_INPUTS/, /status_code\s*=\s*400/]},
        typescript: {all: [/MAX_BATCH_INPUTS/, /code\(\s*400\s*\)/]},
        go: {all: [/maxBatchInputs/, /StatusBadRequest/]},
        scala: {all: [/MaxBatchInputs/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kMaxBatchInputs/, /\b400\b/]},
      },
    },
    {
      id: 'input-cap',
      title: 'Caps every input at 8 KiB',
      detail:
        'An input over `MAX_INPUT_BYTES = 8192` UTF-8 bytes is **413**. The draft measures nothing, so a megabyte input reaches the model server.',
      match: {
        python: {all: [/MAX_INPUT_BYTES/, /status_code\s*=\s*413/]},
        typescript: {all: [/MAX_INPUT_BYTES/, /code\(\s*413\s*\)/]},
        go: {all: [/maxInputBytes/, /StatusRequestEntityTooLarge/]},
        scala: {all: [/MaxInputBytes/, /StatusCodes\.RequestEntityTooLarge/]},
        cpp: {all: [/kMaxInputBytes/, /\b413\b/]},
      },
    },
    {
      id: 'version-hash',
      title: 'Digests tenant, model version and input together',
      detail:
        "The digest is `sha256(tenant, model version, input)`, so a model upgrade changes every key. The draft hashes the input text alone, so the new model keeps reading the old model's vectors.",
      match: {
        python: {all: [/def content_hash\(/, /MODEL_VERSION/]},
        typescript: {all: [/function contentHash\(/, /MODEL_VERSION/]},
        go: {all: [/func contentHash\(/, /modelVersion/]},
        scala: {all: [/def contentHash\(/, /ModelVersion/]},
        cpp: {all: [/content_hash\(/, /kModelVersion/]},
      },
    },
    {
      id: 'replay',
      title: 'Replays return the stored vectors',
      detail:
        '`Idempotency-Key` is required and the stored response is returned on a replay instead of embedding again. The draft ignores the header, so every client retry is billed twice.',
      match: {
        python: {all: [/Idempotency-Key/, /def replay_key\(/, /store\.get\(/]},
        typescript: {all: [/idempotency-key/, /function replayKey\(/, /store\.get\(/]},
        go: {all: [/Idempotency-Key/, /func replayKey\(/, /store\.Get\(/]},
        scala: {all: [/Idempotency-Key/, /def replayKey\(/, /store\.get\(/]},
        cpp: {all: [/Idempotency-Key/, /replay_key\(/, /store\.get\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""Draft: POST /v1/embeddings — embeds whatever the caller sends."""
import hashlib
import json

import redis
from fastapi import FastAPI, Header
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

MODEL_VERSION = "text-embedding-v1"


class EmbedRequest(BaseModel):
    inputs: list[str]


def embed(inputs: list[str], model_version: str) -> list[list[float]]:
    """Provided: call the model server for a batch of inputs."""
    raise NotImplementedError


@app.post("/v1/embeddings")
def embeddings(body: EmbedRequest, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    # TODO: this draft embeds any batch size with no per-input cap, hashes only the input text (so a
    # model upgrade keeps serving the previous model's vectors) and ignores Idempotency-Key.
    digest = hashlib.sha256(body.inputs[0].encode("utf-8")).hexdigest()
    vectors = embed(body.inputs, MODEL_VERSION)
    r.set(f"vector:{digest}", json.dumps(vectors))
    return {"tenant": tenant, "model_version": MODEL_VERSION, "content_hash": digest, "vectors": vectors}
`,
      solution: `"""POST /v1/embeddings — bounded batches and a version-safe idempotency digest."""
import hashlib
import json

import redis
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

MODEL_VERSION = "text-embedding-v1"
MAX_BATCH_INPUTS = 256
MAX_INPUT_BYTES = 8192


class EmbedRequest(BaseModel):
    inputs: list[str]


class ResponseStore:
    """One row per (tenant, Idempotency-Key): the response a retry must get back."""

    def get(self, tenant: str, key: str) -> dict | None:
        """The stored response for a replay, if any."""
        raise NotImplementedError

    def put(self, tenant: str, key: str, response: dict) -> None:
        """Store the response under the key."""
        raise NotImplementedError


store = ResponseStore()


def embed(inputs: list[str], model_version: str) -> list[list[float]]:
    """Provided: call the model server for a batch of inputs."""
    raise NotImplementedError


def content_hash(tenant: str, model_version: str, text: str) -> str:
    """The digest a model upgrade must change: sha256(tenant, model version, input)."""
    material = "\\n".join([tenant, model_version, text])
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def replay_key(tenant: str, idem_key: str) -> str:
    """The replay key, scoped to the tenant so one tenant cannot read another's response."""
    return f"idem:{tenant}:{idem_key}"


@app.post("/v1/embeddings")
def embeddings(
    body: EmbedRequest,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    idem_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if idem_key is None or idem_key == "":
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    if len(body.inputs) == 0:
        raise HTTPException(status_code=400, detail="inputs must not be empty")
    if len(body.inputs) > MAX_BATCH_INPUTS:
        raise HTTPException(status_code=400, detail="batch exceeds MAX_BATCH_INPUTS=256")
    for text in body.inputs:
        if len(text.encode("utf-8")) > MAX_INPUT_BYTES:
            raise HTTPException(status_code=413, detail="input exceeds 8 KiB")
    stored = store.get(tenant, replay_key(tenant, idem_key))
    if stored is not None:
        return JSONResponse(stored, status_code=200)
    digests = [content_hash(tenant, MODEL_VERSION, text) for text in body.inputs]
    vectors = embed(body.inputs, MODEL_VERSION)
    payload = {
        "tenant": tenant,
        "model_version": MODEL_VERSION,
        "dimension": len(vectors[0]),
        "content_hashes": digests,
        "vectors": vectors,
    }
    store.put(tenant, replay_key(tenant, idem_key), payload)
    return JSONResponse(payload, status_code=200)
`,
    },
    typescript: {
      starter: `/** Draft: POST /v1/embeddings — embeds whatever the caller sends. */
import {createHash} from 'node:crypto';

import Fastify from 'fastify';
import Redis from 'ioredis';

export const app = Fastify();
const r = new Redis({host: 'redis', port: 6379});

const MODEL_VERSION = 'text-embedding-v1';

interface EmbedBody {
  inputs: string[];
}

declare function embed(inputs: string[], modelVersion: string): Promise<number[][]>;

app.post('/v1/embeddings', async (request, reply) => {
  // TODO: this draft embeds any batch size with no per-input cap, hashes only the input text (so a
  // model upgrade keeps serving the previous model's vectors) and ignores Idempotency-Key.
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as EmbedBody;
  const digest = createHash('sha256').update(body.inputs[0]).digest('hex');
  const vectors = await embed(body.inputs, MODEL_VERSION);
  await r.set(\`vector:\${digest}\`, JSON.stringify(vectors));
  return reply.code(200).send({tenant, model_version: MODEL_VERSION, content_hash: digest, vectors});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/embeddings — bounded batches and a version-safe idempotency digest. */
import {createHash} from 'node:crypto';

import Fastify from 'fastify';
import Redis from 'ioredis';

export const app = Fastify();
const r = new Redis({host: 'redis', port: 6379});

const MODEL_VERSION = 'text-embedding-v1';
const MAX_BATCH_INPUTS = 256;
const MAX_INPUT_BYTES = 8192;

interface EmbedBody {
  inputs: string[];
}

declare function embed(inputs: string[], modelVersion: string): Promise<number[][]>;

/** One row per (tenant, Idempotency-Key): the response a retry must get back. */
const store = {
  async get(tenant: string, key: string): Promise<Record<string, unknown> | null> {
    throw new Error('not implemented');
  },
  async put(tenant: string, key: string, response: Record<string, unknown>): Promise<void> {
    throw new Error('not implemented');
  },
};

/** The digest a model upgrade must change: sha256(tenant, model version, input). */
function contentHash(tenant: string, modelVersion: string, text: string): string {
  return createHash('sha256').update([tenant, modelVersion, text].join('\\n')).digest('hex');
}

/** The replay key, scoped to the tenant so one tenant cannot read another's response. */
function replayKey(tenant: string, idemKey: string): string {
  return \`idem:\${tenant}:\${idemKey}\`;
}

app.post('/v1/embeddings', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'] as string | undefined;
  const idemKey = request.headers['idempotency-key'] as string | undefined;
  if (tenant === undefined || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  if (idemKey === undefined || idemKey === '')
    return reply.code(400).send({error: 'Idempotency-Key is required'});
  const body = request.body as EmbedBody;
  if (body.inputs.length === 0) return reply.code(400).send({error: 'inputs must not be empty'});
  if (body.inputs.length > MAX_BATCH_INPUTS)
    return reply.code(400).send({error: \`batch exceeds MAX_BATCH_INPUTS=\${MAX_BATCH_INPUTS}\`});
  for (const text of body.inputs)
    if (Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES)
      return reply.code(413).send({error: 'input exceeds 8 KiB'});
  const stored = await store.get(tenant, replayKey(tenant, idemKey));
  if (stored !== null) return reply.code(200).send(stored);
  const contentHashes = body.inputs.map((text) => contentHash(tenant, MODEL_VERSION, text));
  const vectors = await embed(body.inputs, MODEL_VERSION);
  const payload = {
    tenant,
    model_version: MODEL_VERSION,
    dimension: vectors[0].length,
    content_hashes: contentHashes,
    vectors,
  };
  await store.put(tenant, replayKey(tenant, idemKey), payload);
  request.log.info({tenant, modelVersion: MODEL_VERSION, batch: body.inputs.length}, 'embedded');
  return reply.code(200).send(payload);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `// Draft: POST /v1/embeddings — embeds whatever the caller sends.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"

	"github.com/redis/go-redis/v9"
)

const modelVersion = "text-embedding-v1"

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type embedRequest struct {
	Inputs []string \`json:"inputs"\`
}

func embed(inputs []string, modelVersion string) ([][]float32, error) {
	// Provided: call the model server for a batch of inputs.
	return nil, nil
}

func handleEmbeddings(w http.ResponseWriter, r *http.Request) {
	// TODO: this draft embeds any batch size with no per-input cap, hashes only the input text (so
	// a model upgrade keeps serving the previous model's vectors) and ignores Idempotency-Key.
	var body embedRequest
	_ = json.NewDecoder(r.Body).Decode(&body)
	sum := sha256.Sum256([]byte(body.Inputs[0]))
	digest := hex.EncodeToString(sum[:])
	vectors, err := embed(body.Inputs, modelVersion)
	if err != nil {
		http.Error(w, "model server unavailable", http.StatusServiceUnavailable)
		return
	}
	payload, _ := json.Marshal(vectors)
	rdb.Set(r.Context(), "vector:"+digest, payload, 0)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"model_version": modelVersion,
		"content_hash":  digest,
		"vectors":       vectors,
	})
}

func main() {
	http.HandleFunc("POST /v1/embeddings", handleEmbeddings)
	_ = http.ListenAndServe(":8443", nil)
}
`,
      solution: `// POST /v1/embeddings — bounded batches and a version-safe idempotency digest.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	modelVersion   = "text-embedding-v1"
	maxBatchInputs = 256
	maxInputBytes  = 8192
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type embedRequest struct {
	Inputs []string \`json:"inputs"\`
}

type embedResponse struct {
	Tenant        string      \`json:"tenant"\`
	ModelVersion  string      \`json:"model_version"\`
	Dimension     int         \`json:"dimension"\`
	ContentHashes []string    \`json:"content_hashes"\`
	Vectors       [][]float32 \`json:"vectors"\`
}

// ResponseStore holds one row per (tenant, Idempotency-Key): the response a retry must get back.
type ResponseStore interface {
	Get(tenant, key string) (*embedResponse, bool)
	Put(tenant, key string, response embedResponse)
}

func embed(inputs []string, modelVersion string) ([][]float32, error) {
	// Provided: call the model server for a batch of inputs.
	return nil, nil
}

// contentHash is sha256(tenant, model version, input): the digest a model upgrade must change.
func contentHash(tenant, modelVersion, text string) string {
	sum := sha256.Sum256([]byte(tenant + "\\n" + modelVersion + "\\n" + text))
	return hex.EncodeToString(sum[:])
}

// replayKey is the replay key, scoped to the tenant so one tenant cannot read another's response.
func replayKey(tenant, idemKey string) string {
	return "idem:" + tenant + ":" + idemKey
}

func handleEmbeddings(store ResponseStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tenant := r.Header.Get("X-Tenant-Id")
		idemKey := r.Header.Get("Idempotency-Key")
		if tenant == "" {
			http.Error(w, "missing X-Tenant-Id", http.StatusUnauthorized)
			return
		}
		if idemKey == "" {
			http.Error(w, "Idempotency-Key is required", http.StatusBadRequest)
			return
		}
		var body embedRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "malformed body", http.StatusBadRequest)
			return
		}
		if len(body.Inputs) == 0 {
			http.Error(w, "inputs must not be empty", http.StatusBadRequest)
			return
		}
		if len(body.Inputs) > maxBatchInputs {
			http.Error(w, "batch exceeds maxBatchInputs=256", http.StatusBadRequest)
			return
		}
		for _, text := range body.Inputs {
			if len([]byte(text)) > maxInputBytes {
				http.Error(w, "input exceeds 8 KiB", http.StatusRequestEntityTooLarge)
				return
			}
		}
		if stored, ok := store.Get(tenant, replayKey(tenant, idemKey)); ok {
			writeJSON(w, http.StatusOK, stored)
			return
		}
		hashes := make([]string, 0, len(body.Inputs))
		for _, text := range body.Inputs {
			hashes = append(hashes, contentHash(tenant, modelVersion, text))
		}
		vectors, err := embed(body.Inputs, modelVersion)
		if err != nil {
			http.Error(w, "model server unavailable", http.StatusServiceUnavailable)
			return
		}
		response := embedResponse{
			Tenant:        tenant,
			ModelVersion:  modelVersion,
			Dimension:     len(vectors[0]),
			ContentHashes: hashes,
			Vectors:       vectors,
		}
		store.Put(tenant, replayKey(tenant, idemKey), response)
		log.Printf("embedded tenant=%s modelVersion=%s batch=%d", tenant, modelVersion, len(body.Inputs))
		writeJSON(w, http.StatusOK, response)
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func main() {
	handler := handleEmbeddings(&redisResponseStore{ttl: 24 * time.Hour})
	http.HandleFunc("POST /v1/embeddings", handler)
	log.Fatal(http.ListenAndServe(":8443", nil))
}

// redisResponseStore keeps the replay records in Redis so every replica answers a retry alike.
type redisResponseStore struct {
	ttl time.Duration
}

func (s *redisResponseStore) Get(tenant, key string) (*embedResponse, bool) { return nil, false }

func (s *redisResponseStore) Put(tenant, key string, response embedResponse) {}
`,
    },
    scala: {
      starter: `// Draft: POST /v1/embeddings — embeds whatever the caller sends.
import java.security.MessageDigest

import scala.concurrent.Future

import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._

object Endpoint {
  val ModelVersion = "text-embedding-v1"

  final case class EmbedRequest(inputs: List[String])

  def embed(inputs: List[String], modelVersion: String): Future[List[Vector[Float]]] =
    Future.failed(new NotImplementedError)

  val route =
    path("v1" / "embeddings") {
      post {
        // TODO: this draft embeds any batch size with no per-input cap, hashes only the input text
        // (so a model upgrade keeps serving the previous model's vectors) and ignores Idempotency-Key.
        entity(as[EmbedRequest]) { body =>
          val digest = MessageDigest
            .getInstance("SHA-256")
            .digest(body.inputs.head.getBytes("UTF-8"))
            .map("%02x".format(_))
            .mkString
          onSuccess(embed(body.inputs, ModelVersion)) { vectors =>
            store.set("vector:" + digest, vectors)
            complete(StatusCodes.OK -> Map("model_version" -> ModelVersion, "content_hash" -> digest))
          }
        }
      }
    }
}
`,
      solution: `// POST /v1/embeddings — bounded batches and a version-safe idempotency digest.
import java.nio.charset.StandardCharsets
import java.security.MessageDigest

import scala.concurrent.Future

import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

object Endpoint {
  val ModelVersion = "text-embedding-v1"
  val MaxBatchInputs = 256
  val MaxInputBytes = 8192

  final case class EmbedRequest(inputs: List[String])

  /** One row per (tenant, Idempotency-Key): the response a retry must get back. */
  trait ResponseStore {
    def get(tenant: String, key: String): Option[String]
    def put(tenant: String, key: String, response: String): Unit
  }

  var store: ResponseStore = _

  def embed(inputs: List[String], modelVersion: String): Future[List[Vector[Float]]] =
    Future.failed(new NotImplementedError)

  /** The digest a model upgrade must change: sha256(tenant, model version, input). */
  def contentHash(tenant: String, modelVersion: String, text: String): String =
    MessageDigest
      .getInstance("SHA-256")
      .digest(s"$tenant\\n$modelVersion\\n$text".getBytes(StandardCharsets.UTF_8))
      .map("%02x".format(_))
      .mkString

  /** The replay key, scoped to the tenant so one tenant cannot read another's response. */
  def replayKey(tenant: String, idemKey: String): String = s"idem:$tenant:$idemKey"

  val route: Route =
    path("v1" / "embeddings") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          optionalHeaderValueByName("Idempotency-Key") { idemOpt =>
            entity(as[EmbedRequest]) { body =>
              val tenant = tenantOpt.getOrElse("")
              val idemKey = idemOpt.getOrElse("")
              if (tenant.isEmpty) {
                complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
              } else if (idemKey.isEmpty) {
                complete(StatusCodes.BadRequest, """{"error":"Idempotency-Key is required"}""")
              } else if (body.inputs.isEmpty) {
                complete(StatusCodes.BadRequest, """{"error":"inputs must not be empty"}""")
              } else if (body.inputs.size > MaxBatchInputs) {
                complete(StatusCodes.BadRequest, """{"error":"batch exceeds MaxBatchInputs=256"}""")
              } else if (body.inputs.exists(_.getBytes(StandardCharsets.UTF_8).length > MaxInputBytes)) {
                complete(StatusCodes.RequestEntityTooLarge, """{"error":"input exceeds 8 KiB"}""")
              } else {
                store.get(tenant, replayKey(tenant, idemKey)) match {
                  case Some(stored) => complete(StatusCodes.OK, stored)
                  case None =>
                    onSuccess(embed(body.inputs, ModelVersion)) { vectors =>
                      val response =
                        s"""{"model_version":"$ModelVersion","dimension":\${vectors.head.length}}"""
                      store.put(tenant, replayKey(tenant, idemKey), response)
                      complete(StatusCodes.OK, response)
                    }
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
      starter: `// Draft: POST /v1/embeddings — embeds whatever the caller sends.
#include <crypto/sha256.h>
#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>
#include <vector>

constexpr char kModelVersion[] = "text-embedding-v1";

std::vector<std::vector<float>> embed(const std::vector<std::string>& inputs, const std::string& modelVersion);

std::string sha256Hex(const std::string& text) {
  unsigned char digest[SHA256::DIGEST_SIZE];
  SHA256 ctx;
  ctx.init();
  ctx.update(reinterpret_cast<const unsigned char*>(text.data()), text.size());
  ctx.final(digest);
  static constexpr char kHex[] = "0123456789abcdef";
  std::string out;
  for (unsigned char byte : digest) {
    out.push_back(kHex[byte >> 4]);
    out.push_back(kHex[byte & 0x0F]);
  }
  return out;
}

int main() {
  httplib::Server svr;
  svr.Post("/v1/embeddings", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft embeds any batch size with no per-input cap, hashes only the input text (so
    // a model upgrade keeps serving the previous model's vectors) and ignores Idempotency-Key.
    auto body = nlohmann::json::parse(req.body);
    const std::string digest = sha256Hex(body["inputs"][0].get<std::string>());
    auto vectors = embed(body["inputs"].get<std::vector<std::string>>(), kModelVersion);
    redis.set("vector:" + digest, nlohmann::json(vectors).dump());
    res.set_content(nlohmann::json{{"model_version", kModelVersion}, {"content_hash", digest}}.dump(),
                    "application/json");
  });
  svr.listen("0.0.0.0", 8443);
  return 0;
}
`,
      solution: `// POST /v1/embeddings — bounded batches and a version-safe idempotency digest.
#include <crypto/sha256.h>
#include <httplib.h>
#include <nlohmann/json.hpp>

#include <optional>
#include <string>
#include <vector>

constexpr char kModelVersion[] = "text-embedding-v1";
constexpr int kMaxBatchInputs = 256;
constexpr int kMaxInputBytes = 8192;

std::vector<std::vector<float>> embed(const std::vector<std::string>& inputs, const std::string& modelVersion);

// ResponseStore holds one row per (tenant, Idempotency-Key): the response a retry must get back.
struct ResponseStore {
  std::optional<std::string> get(const std::string& tenant, const std::string& key);
  void put(const std::string& tenant, const std::string& key, const std::string& response);
};

std::string sha256Hex(const std::string& text) {
  unsigned char digest[SHA256::DIGEST_SIZE];
  SHA256 ctx;
  ctx.init();
  ctx.update(reinterpret_cast<const unsigned char*>(text.data()), text.size());
  ctx.final(digest);
  static constexpr char kHex[] = "0123456789abcdef";
  std::string out;
  for (unsigned char byte : digest) {
    out.push_back(kHex[byte >> 4]);
    out.push_back(kHex[byte & 0x0F]);
  }
  return out;
}

// The digest a model upgrade must change: sha256(tenant, model version, input).
std::string content_hash(const std::string& tenant, const std::string& modelVersion, const std::string& text) {
  return sha256Hex(tenant + "\\n" + modelVersion + "\\n" + text);
}

// The replay key, scoped to the tenant so one tenant cannot read another's response.
std::string replay_key(const std::string& tenant, const std::string& idemKey) {
  return "idem:" + tenant + ":" + idemKey;
}

int main() {
  httplib::Server svr;
  ResponseStore store;
  svr.Post("/v1/embeddings", [&store](const httplib::Request& req, httplib::Response& res) {
    const std::string tenant = req.get_header_value("X-Tenant-Id");
    const std::string idemKey = req.get_header_value("Idempotency-Key");
    auto reply = [&res](int status, const nlohmann::json& body) {
      res.status = status;
      res.set_content(body.dump(), "application/json");
    };
    if (tenant.empty()) {
      reply(401, {{"error", "missing X-Tenant-Id"}});
      return;
    }
    if (idemKey.empty()) {
      reply(400, {{"error", "Idempotency-Key is required"}});
      return;
    }
    auto body = nlohmann::json::parse(req.body);
    const auto inputs = body["inputs"].get<std::vector<std::string>>();
    if (inputs.empty()) {
      reply(400, {{"error", "inputs must not be empty"}});
      return;
    }
    if (static_cast<int>(inputs.size()) > kMaxBatchInputs) {
      reply(400, {{"error", "batch exceeds kMaxBatchInputs=256"}});
      return;
    }
    for (const auto& text : inputs) {
      if (static_cast<int>(text.size()) > kMaxInputBytes) {
        reply(413, {{"error", "input exceeds 8 KiB"}});
        return;
      }
    }
    if (auto stored = store.get(tenant, replay_key(tenant, idemKey)); stored.has_value()) {
      res.status = 200;
      res.set_content(*stored, "application/json");
      return;
    }
    nlohmann::json hashes = nlohmann::json::array();
    for (const auto& text : inputs) hashes.push_back(content_hash(tenant, kModelVersion, text));
    const auto vectors = embed(inputs, kModelVersion);
    nlohmann::json payload = {
        {"tenant", tenant},
        {"model_version", kModelVersion},
        {"dimension", vectors.empty() ? 0 : static_cast<int>(vectors.front().size())},
        {"content_hashes", hashes},
    };
    store.put(tenant, replay_key(tenant, idemKey), payload.dump());
    reply(200, payload);
  });
  svr.listen("0.0.0.0", 8443);
  return 0;
}
`,
    },
  },
  debrief: `Three guards in front of the model server turn an endpoint into a contract. The version belongs
inside the digest: change the model and every key changes with it. The batch cap protects the worker
and the provider; the input cap protects the tokenizer, which truncates silently rather than refusing.
And the Idempotency-Key is what makes the retry loop every SDK runs free instead of billed.`,
};
