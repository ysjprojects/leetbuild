import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/embeddings: batches that stay inside their caps',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'model'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/embeddings\` with body \`{"inputs": [...]}\`: it
reads the tenant from \`X-Tenant-Id\`, cuts every input to \`MAX_INPUT_BYTES\`, calls step 3's
\`embed(text, MODEL_VERSION)\` once per input and answers \`{model_version, dimension,
content_hashes, vectors}\`. It serves the demo and hides 4 flaws.

**Failure mode the checks target.** A request with no tenant that is embedded anyway, one request
that buys an unbounded amount of model work, an oversized input embedded as a different text, and
a client retry that pays the model server twice.

- A missing \`X-Tenant-Id\` is **401**, before any work.
- A batch holds **1..256** inputs (\`MAX_BATCH_INPUTS\`); anything else is **400**.
- An input over **8192 UTF-8 bytes** (\`MAX_INPUT_BYTES\`) is **413** with its \`index\`; nothing in
  the batch is embedded. Count bytes, not characters.
- \`Idempotency-Key\` is required (**400**). Look \`(tenant, key)\` up in \`replays.get\` before
  embedding and answer the recorded response; record a fresh one with \`replays.put\`.`,
  sequence: {
    participants: ['Client', 'Embedding API', 'replays', 'Model server'],
    messages: [
      {from: 'Client', to: 'Embedding API', label: 'POST /v1/embeddings · X-Tenant-Id · Idempotency-Key', kind: 'sync'},
      {from: 'Embedding API', to: 'Embedding API', label: '401 · 400 (1..256) · 413 (> 8192 bytes)', kind: 'sync'},
      {from: 'Embedding API', to: 'replays', label: 'get(tenant, key)', kind: 'sync'},
      {from: 'replays', to: 'Embedding API', label: 'recorded response → 200', kind: 'reply'},
      {from: 'Embedding API', to: 'Model server', label: 'embed(text, embed-v2) per input', kind: 'sync'},
      {from: 'Embedding API', to: 'replays', label: 'put(tenant, key, response)', kind: 'sync'},
      {
        from: 'Embedding API',
        to: 'Client',
        label: '200 {model_version, dimension, content_hashes, vectors}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Embeds a batch on POST /v1/embeddings',
      detail: 'The route answers one vector per input, in order, through step 3’s `embed`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/embeddings["']/, /embed\(text/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/embeddings['"]/, /embed\(text/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/embeddings"/, /embed\(r\.Context\(\)/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"embeddings"\s*\)/, /ModelClient\.embed\(/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/embeddings"/, /embed\(text/]},
      },
    },
    {
      id: 'tenant-required',
      title: 'A request without a tenant is 401',
      detail: 'A missing `X-Tenant-Id` answers **401** before anything is embedded.',
      match: {
        python: {all: [/x-tenant-id/i, /\b401\b/]},
        typescript: {all: [/x-tenant-id/i, /code\(\s*401\s*\)/]},
        go: {all: [/X-Tenant-Id/i, /StatusUnauthorized|\b401\b/]},
        scala: {all: [/X-Tenant-Id/i, /StatusCodes\.Unauthorized/]},
        cpp: {all: [/X-Tenant-Id/i, /\b401\b/]},
      },
    },
    {
      id: 'batch-cap',
      title: 'Caps the batch at 256 inputs',
      detail: '`MAX_BATCH_INPUTS = 256`: an empty batch or a 257th input is **400**, with no model call.',
      match: {
        python: {all: [/MAX_BATCH_INPUTS\s*=\s*256\b/, /\b400\b/]},
        typescript: {all: [/MAX_BATCH_INPUTS\s*=\s*256\b/, /code\(\s*400\s*\)/]},
        go: {all: [/maxBatchInputs\s*=\s*256\b/, /StatusBadRequest|\b400\b/]},
        scala: {all: [/MaxBatchInputs\s*=\s*256\b/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kMaxBatchInputs\s*=\s*256\b/, /\b400\b/]},
      },
    },
    {
      id: 'input-bytes',
      title: 'An input over 8 KiB is 413, not cut',
      detail:
        'Every input is measured in UTF-8 bytes before anything is embedded; one over `MAX_INPUT_BYTES` answers **413** with its `index`. Cutting it embeds a different text under the caller’s name.',
      match: {
        python: {all: [/\b413\b/, /\.encode\(/], none: [/\[\s*:\s*MAX_INPUT_BYTES\s*\]/]},
        typescript: {
          all: [/code\(\s*413\s*\)/, /byteLength|TextEncoder/],
          none: [/slice\(\s*0\s*,\s*MAX_INPUT_BYTES\s*\)/],
        },
        go: {all: [/StatusRequestEntityTooLarge|\b413\b/], none: [/\[\s*:\s*maxInputBytes\s*\]/]},
        scala: {all: [/PayloadTooLarge|RequestEntityTooLarge/, /getBytes\(/], none: [/\.take\(\s*MaxInputBytes\s*\)/]},
        cpp: {all: [/\b413\b/], none: [/substr\(\s*0\s*,\s*kMaxInputBytes\s*\)/]},
      },
    },
    {
      id: 'replay',
      title: 'A replay answers the recorded response',
      detail:
        '`Idempotency-Key` is required, `replays.get(tenant, key)` runs before the first `embed` call, and a fresh response is recorded with `replays.put`.',
      match: {
        python: {all: [/idempotency-key/i, /replays\.put\(/], order: [/replays\.get\(/, /embed\(text/]},
        typescript: {all: [/idempotency-key/i, /replays\.put\(/], order: [/replays\.get\(/, /embed\(text/]},
        go: {all: [/Idempotency-Key/i, /replays\.Put\(/], order: [/replays\.Get\(/, /embed\(r\.Context\(\)/]},
        scala: {all: [/Idempotency-Key/i, /Replays\.put\(/], order: [/Replays\.get\(/, /ModelClient\.embed\(/]},
        cpp: {all: [/Idempotency-Key/i, /replays::put\(/], order: [/replays::get\(/, /embed\(text/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI, Header
from pydantic import BaseModel

from client import embed  # step 3: the model server's vector of one input
from embedding.config import MODEL_VERSION, content_hash

app = FastAPI()
log = logging.getLogger("embedd")

MAX_INPUT_BYTES = 8192


class EmbedRequest(BaseModel):
    inputs: list[str]


@app.post("/v1/embeddings")
def create_embeddings(body: EmbedRequest, x_tenant_id: str = Header(default="")) -> dict:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    inputs = [text[:MAX_INPUT_BYTES] for text in body.inputs]
    vectors = [embed(text, MODEL_VERSION) for text in inputs]
    log.info("embedded tenant=%s model=%s inputs=%d", x_tenant_id, MODEL_VERSION, len(inputs))
    return {
        "model_version": MODEL_VERSION,
        "dimension": len(vectors[0]) if vectors else 0,
        "content_hashes": [content_hash(text) for text in inputs],
        "vectors": vectors,
    }
`,
      solution: `import logging

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from client import embed  # step 3: the model server's vector of one input
from embedding import replays
from embedding.config import MODEL_VERSION, content_hash

app = FastAPI()
log = logging.getLogger("embedd")

MAX_BATCH_INPUTS = 256
MAX_INPUT_BYTES = 8192


class EmbedRequest(BaseModel):
    inputs: list[str]


@app.post("/v1/embeddings")
def create_embeddings(body: EmbedRequest, request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        return JSONResponse({"error": "missing_tenant"}, status_code=401)
    idem_key = request.headers.get("idempotency-key", "")
    if not idem_key:
        return JSONResponse({"error": "missing_idempotency_key"}, status_code=400)
    if not 1 <= len(body.inputs) <= MAX_BATCH_INPUTS:
        return JSONResponse({"error": "batch_size", "max": MAX_BATCH_INPUTS}, status_code=400)
    for index, text in enumerate(body.inputs):
        if len(text.encode("utf-8")) > MAX_INPUT_BYTES:
            return JSONResponse({"error": "input_too_large", "index": index, "max_bytes": MAX_INPUT_BYTES}, status_code=413)
    recorded = replays.get(tenant, idem_key)
    if recorded is not None:
        return JSONResponse(recorded)  # a retry gets what the first attempt got, at no model cost
    vectors = [embed(text, MODEL_VERSION) for text in body.inputs]
    response = {
        "model_version": MODEL_VERSION,
        "dimension": len(vectors[0]),
        "content_hashes": [content_hash(text) for text in body.inputs],
        "vectors": vectors,
    }
    replays.put(tenant, idem_key, response)
    log.info("embedded tenant=%s model=%s inputs=%d", tenant, MODEL_VERSION, len(body.inputs))
    return JSONResponse(response)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {MODEL_VERSION, contentHash} from 'embedding/config';

import {embed} from './client'; // step 3: the model server's vector of one input

export const app = Fastify();

const MAX_INPUT_BYTES = 8192;

app.post('/v1/embeddings', async request => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'] as string;
  const inputs = (request.body as {inputs: string[]}).inputs.map(text => text.slice(0, MAX_INPUT_BYTES));
  const vectors: number[][] = [];
  for (const text of inputs) vectors.push(await embed(text, MODEL_VERSION));
  console.log(\`embedded tenant=\${tenant} model=\${MODEL_VERSION} inputs=\${inputs.length}\`);
  return {
    model_version: MODEL_VERSION,
    dimension: vectors.length > 0 ? vectors[0].length : 0,
    content_hashes: inputs.map(contentHash),
    vectors,
  };
});
`,
      solution: `import Fastify from 'fastify';

import {MODEL_VERSION, contentHash} from 'embedding/config';
import {replays} from 'embedding/replays';

import {embed} from './client'; // step 3: the model server's vector of one input

export const app = Fastify();

const MAX_BATCH_INPUTS = 256;
const MAX_INPUT_BYTES = 8192;

app.post('/v1/embeddings', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing_tenant'});
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '') return reply.code(400).send({error: 'missing_idempotency_key'});
  const {inputs} = request.body as {inputs: string[]};
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > MAX_BATCH_INPUTS) {
    return reply.code(400).send({error: 'batch_size', max: MAX_BATCH_INPUTS});
  }
  const index = inputs.findIndex(text => Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES);
  if (index !== -1) return reply.code(413).send({error: 'input_too_large', index, max_bytes: MAX_INPUT_BYTES});
  const recorded = await replays.get(tenant, idemKey);
  if (recorded !== null) return recorded; // a retry gets what the first attempt got, at no model cost
  const vectors: number[][] = [];
  for (const text of inputs) vectors.push(await embed(text, MODEL_VERSION));
  const response = {model_version: MODEL_VERSION, dimension: vectors[0].length, content_hashes: inputs.map(contentHash), vectors};
  await replays.put(tenant, idemKey, response);
  console.log(\`embedded tenant=\${tenant} model=\${MODEL_VERSION} inputs=\${inputs.length}\`);
  return response;
});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"

	"embedding/config" // config.ModelVersion, ContentHash — provided
)

const maxInputBytes = 8192

// Built in step 3 (client.go): the model server's vector of one input.
var embed = func(ctx context.Context, text, modelVersion string) ([]float32, error) {
	panic("embed is built in step 3")
}

type embeddingsResponse struct {
	ModelVersion  string      \`json:"model_version"\`
	Dimension     int         \`json:"dimension"\`
	ContentHashes []string    \`json:"content_hashes"\`
	Vectors       [][]float32 \`json:"vectors"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func createEmbeddings(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	var body struct {
		Inputs []string \`json:"inputs"\`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid_body"})
		return
	}
	resp := embeddingsResponse{ModelVersion: config.ModelVersion, ContentHashes: []string{}, Vectors: [][]float32{}}
	for _, text := range body.Inputs {
		if len(text) > maxInputBytes {
			text = text[:maxInputBytes]
		}
		vector, err := embed(r.Context(), text, config.ModelVersion)
		if err != nil {
			writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
			return
		}
		resp.ContentHashes = append(resp.ContentHashes, config.ContentHash(text))
		resp.Vectors = append(resp.Vectors, vector)
	}
	if len(resp.Vectors) > 0 {
		resp.Dimension = len(resp.Vectors[0])
	}
	log.Printf("embedded tenant=%s model=%s inputs=%d", tenant, config.ModelVersion, len(body.Inputs))
	writeJSON(rw, http.StatusOK, resp)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/embeddings", createEmbeddings)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"

	"embedding/config"  // config.ModelVersion, ContentHash — provided
	"embedding/replays" // replays.Get, Put — provided
)

const (
	maxBatchInputs = 256
	maxInputBytes  = 8192
)

// Built in step 3 (client.go): the model server's vector of one input.
var embed = func(ctx context.Context, text, modelVersion string) ([]float32, error) {
	panic("embed is built in step 3")
}

type embeddingsResponse struct {
	ModelVersion  string      \`json:"model_version"\`
	Dimension     int         \`json:"dimension"\`
	ContentHashes []string    \`json:"content_hashes"\`
	Vectors       [][]float32 \`json:"vectors"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func createEmbeddings(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing_tenant"})
		return
	}
	idemKey := r.Header.Get("Idempotency-Key")
	if idemKey == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "missing_idempotency_key"})
		return
	}
	var body struct {
		Inputs []string \`json:"inputs"\`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid_body"})
		return
	}
	if len(body.Inputs) < 1 || len(body.Inputs) > maxBatchInputs {
		writeJSON(rw, http.StatusBadRequest, map[string]any{"error": "batch_size", "max": maxBatchInputs})
		return
	}
	for i, text := range body.Inputs {
		if len(text) > maxInputBytes { // len counts the UTF-8 bytes
			writeJSON(rw, http.StatusRequestEntityTooLarge, map[string]any{"error": "input_too_large", "index": i, "max_bytes": maxInputBytes})
			return
		}
	}
	recorded, err := replays.Get(r.Context(), tenant, idemKey)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
		return
	}
	if recorded != nil {
		// A retry gets what the first attempt got, at no model cost.
		rw.Header().Set("Content-Type", "application/json")
		rw.Write(recorded)
		return
	}
	resp := embeddingsResponse{ModelVersion: config.ModelVersion}
	for _, text := range body.Inputs {
		vector, err := embed(r.Context(), text, config.ModelVersion)
		if err != nil {
			writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
			return
		}
		resp.ContentHashes = append(resp.ContentHashes, config.ContentHash(text))
		resp.Vectors = append(resp.Vectors, vector)
	}
	resp.Dimension = len(resp.Vectors[0])
	doc, _ := json.Marshal(resp)
	if err := replays.Put(r.Context(), tenant, idemKey, doc); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
		return
	}
	log.Printf("embedded tenant=%s model=%s inputs=%d", tenant, config.ModelVersion, len(body.Inputs))
	rw.Header().Set("Content-Type", "application/json")
	rw.Write(doc)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/embeddings", createEmbeddings)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

import embedding.Config // Config.ModelVersion, contentHash — provided

object EmbeddingsApi {
  val MaxInputBytes = 8192

  private def vectorJson(vector: Seq[Float]): ujson.Value = ujson.Arr.from(vector.map(v => ujson.Num(v.toDouble)))

  def handle(tenant: String, raw: String): HttpResponse = {
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    val inputs = ujson.read(raw)("inputs").arr.map(_.str.take(MaxInputBytes)).toSeq
    val vectors = inputs.map(text => ModelClient.embed(text, Config.ModelVersion))
    System.err.println(s"embedded tenant=$tenant model=\${Config.ModelVersion} inputs=\${inputs.size}")
    val body = ujson.Obj(
      "model_version" -> Config.ModelVersion,
      "dimension" -> (if (vectors.isEmpty) 0 else vectors.head.size),
      "content_hashes" -> ujson.Arr.from(inputs.map(Config.contentHash)),
      "vectors" -> ujson.Arr.from(vectors.map(vectorJson))
    )
    HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, ujson.write(body)))
  }

  val route: Route = path("v1" / "embeddings") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") { tenant =>
        entity(as[String]) { raw =>
          complete(handle(tenant.getOrElse(""), raw))
        }
      }
    }
  }
}
`,
      solution: `import java.nio.charset.StandardCharsets.UTF_8

import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

import embedding.{Config, Replays} // Config.ModelVersion, contentHash; Replays.get, put — provided

object EmbeddingsApi {
  val MaxBatchInputs = 256
  val MaxInputBytes = 8192

  private def json(status: StatusCode, body: String): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body))

  private def vectorJson(vector: Seq[Float]): ujson.Value = ujson.Arr.from(vector.map(v => ujson.Num(v.toDouble)))

  def handle(tenant: String, idemKey: String, raw: String): HttpResponse = {
    if (tenant.isEmpty) return json(StatusCodes.Unauthorized, ujson.write(ujson.Obj("error" -> "missing_tenant")))
    if (idemKey.isEmpty) return json(StatusCodes.BadRequest, ujson.write(ujson.Obj("error" -> "missing_idempotency_key")))
    val inputs = ujson.read(raw)("inputs").arr.map(_.str).toSeq
    if (inputs.isEmpty || inputs.size > MaxBatchInputs)
      return json(StatusCodes.BadRequest, ujson.write(ujson.Obj("error" -> "batch_size", "max" -> MaxBatchInputs)))
    val tooLarge = inputs.indexWhere(_.getBytes(UTF_8).length > MaxInputBytes)
    if (tooLarge >= 0)
      return json(StatusCodes.PayloadTooLarge, ujson.write(ujson.Obj("error" -> "input_too_large", "index" -> tooLarge, "max_bytes" -> MaxInputBytes)))
    Replays.get(tenant, idemKey) match {
      case Some(recorded) => json(StatusCodes.OK, recorded) // a retry gets what the first attempt got, at no model cost
      case None =>
        val vectors = inputs.map(text => ModelClient.embed(text, Config.ModelVersion))
        val body = ujson.write(
          ujson.Obj(
            "model_version" -> Config.ModelVersion,
            "dimension" -> vectors.head.size,
            "content_hashes" -> ujson.Arr.from(inputs.map(Config.contentHash)),
            "vectors" -> ujson.Arr.from(vectors.map(vectorJson))
          )
        )
        Replays.put(tenant, idemKey, body)
        System.err.println(s"embedded tenant=$tenant model=\${Config.ModelVersion} inputs=\${inputs.size}")
        json(StatusCodes.OK, body)
    }
  }

  val route: Route = path("v1" / "embeddings") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") { tenant =>
        optionalHeaderValueByName("Idempotency-Key") { idemKey =>
          entity(as[String]) { raw =>
            complete(handle(tenant.getOrElse(""), idemKey.getOrElse(""), raw))
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

#include <iostream>
#include <string>
#include <vector>

#include "embedding/config.h"  // config::kModelVersion, contentHash — provided

using json = nlohmann::json;

constexpr size_t kMaxInputBytes = 8192;

// Built in step 3 (client.cpp): the model server's vector of one input.
std::vector<float> embed(const std::string& text, const std::string& model_version);

void create_embeddings(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  const json body = json::parse(req.body);
  json response = {{"model_version", config::kModelVersion}, {"dimension", 0}, {"content_hashes", json::array()}, {"vectors", json::array()}};
  for (const auto& input : body.at("inputs")) {
    const std::string text = input.get<std::string>().substr(0, kMaxInputBytes);
    response["content_hashes"].push_back(config::contentHash(text));
    response["vectors"].push_back(embed(text, config::kModelVersion));
  }
  if (!response["vectors"].empty()) response["dimension"] = response["vectors"][0].size();
  std::cerr << "embedded tenant=" << tenant << " model=" << config::kModelVersion << " inputs=" << response["vectors"].size() << "\\n";
  res.set_content(response.dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/embeddings", create_embeddings);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <string>
#include <vector>

#include "embedding/config.h"   // config::kModelVersion, contentHash — provided
#include "embedding/replays.h"  // replays::get, put — provided

using json = nlohmann::json;

constexpr size_t kMaxBatchInputs = 256;
constexpr size_t kMaxInputBytes = 8192;

// Built in step 3 (client.cpp): the model server's vector of one input.
std::vector<float> embed(const std::string& text, const std::string& model_version);

static void fail(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void create_embeddings(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return fail(res, 401, {{"error", "missing_tenant"}});
  const std::string idem_key = req.get_header_value("Idempotency-Key");
  if (idem_key.empty()) return fail(res, 400, {{"error", "missing_idempotency_key"}});
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object() || !body.contains("inputs") || !body["inputs"].is_array()) return fail(res, 400, {{"error", "invalid_body"}});
  const std::vector<std::string> inputs = body["inputs"].get<std::vector<std::string>>();
  if (inputs.empty() || inputs.size() > kMaxBatchInputs) return fail(res, 400, {{"error", "batch_size"}, {"max", kMaxBatchInputs}});
  for (size_t i = 0; i < inputs.size(); i++) {
    // size() counts the UTF-8 bytes.
    if (inputs[i].size() > kMaxInputBytes) return fail(res, 413, {{"error", "input_too_large"}, {"index", i}, {"max_bytes", kMaxInputBytes}});
  }
  if (const auto recorded = replays::get(tenant, idem_key)) {
    res.set_content(recorded->dump(), "application/json");  // a retry gets what the first attempt got, at no model cost
    return;
  }
  json response = {{"model_version", config::kModelVersion}, {"content_hashes", json::array()}, {"vectors", json::array()}};
  for (const std::string& text : inputs) {
    response["content_hashes"].push_back(config::contentHash(text));
    response["vectors"].push_back(embed(text, config::kModelVersion));
  }
  response["dimension"] = response["vectors"][0].size();
  replays::put(tenant, idem_key, response);
  std::cerr << "embedded tenant=" << tenant << " model=" << config::kModelVersion << " inputs=" << inputs.size() << "\\n";
  res.set_content(response.dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/embeddings", create_embeddings);
}
`,
    },
  },
  harness: {
    python: `import embedder_pb2
import embedder_pb2_grpc
from embedding import model
from embedding.config import MODEL_SERVER, MODEL_VERSION, content_hash

TEXTS = ["Rotate keys every 90 days.", "Revoke a leaked key at once."]


class ModelServer(embedder_pb2_grpc.EmbedderServicer):
    """The stand-in model server: answers from embedding.model."""

    def Embed(self, request, context):
        return embedder_pb2.EmbedReply(model_version=request.model_version, values=model.vector_for(request.model_version, request.text))


def _api(ctx):
    ctx.grpc.serve(embedder_pb2_grpc.add_EmbedderServicer_to_server, ModelServer(), MODEL_SERVER)
    return ctx.client(ctx.load("api").app)


def _calls(ctx):
    return len(ctx.grpc.calls_to("Embed"))


async def _post(c, inputs, tenant="acme", key="k-1"):
    headers = {}
    if tenant is not None:
        headers["X-Tenant-Id"] = tenant
    if key is not None:
        headers["Idempotency-Key"] = key
    return await c.post("/v1/embeddings", json={"inputs": inputs}, headers=headers)


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await _post(c, TEXTS)
    assert r.status_code == 200, f"POST /v1/embeddings answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("model_version") == MODEL_VERSION, f"the response must name the model ({MODEL_VERSION}), got {body.get('model_version')}"
    assert body.get("vectors") == [model.vector_for(MODEL_VERSION, t) for t in TEXTS], f"one vector per input, in input order, got {body.get('vectors')}"
    assert body.get("content_hashes") == [content_hash(t) for t in TEXTS], f"content_hashes must be the SHA-256 of each input, got {body.get('content_hashes')}"
    assert body.get("dimension") == 8, f"dimension must be the vectors' length (8), got {body.get('dimension')}"


async def check_tenant_required(ctx):
    async with _api(ctx) as c:
        r = await _post(c, TEXTS, tenant=None)
    assert r.status_code == 401, f"a request without X-Tenant-Id answered {r.status_code}: {r.text[:120]}; it must be 401"
    assert _calls(ctx) == 0, f"a request without a tenant cost {_calls(ctx)} Embed calls before it was refused"


async def check_batch_cap(ctx):
    async with _api(ctx) as c:
        big = await _post(c, [f"input {i}" for i in range(257)])
        assert big.status_code == 400, f"a batch of 257 inputs answered {big.status_code} after {_calls(ctx)} Embed calls: MAX_BATCH_INPUTS = 256, and the 257th is 400"
        assert _calls(ctx) == 0, f"a refused batch cost {_calls(ctx)} Embed calls"
        empty = await _post(c, [], key="k-2")
        assert empty.status_code == 400, f"an empty batch answered {empty.status_code}, expected 400"
        ok = await _post(c, TEXTS, key="k-3")
    assert ok.status_code == 200, f"a batch of two inputs answered {ok.status_code}: {ok.text}"


async def check_input_bytes(ctx):
    wide = "日" * 3000  # 3000 characters, 9000 bytes of UTF-8
    async with _api(ctx) as c:
        r = await _post(c, ["short", wide])
        assert r.status_code == 413, f"an input of 9000 UTF-8 bytes (3000 characters) answered {r.status_code}: MAX_INPUT_BYTES counts bytes, and an input over it is 413, not cut and embedded as another text"
        assert _calls(ctx) == 0, f"nothing in a refused batch is embedded, yet {_calls(ctx)} Embed calls were made"
        assert r.json().get("index") == 1, f"the 413 must name the index of the input (1), got {r.text}"
        edge = await _post(c, ["a" * 8192], key="k-2")
    assert edge.status_code == 200, f"an input of exactly 8192 bytes answered {edge.status_code}: {edge.text[:120]}"


async def check_replay(ctx):
    async with _api(ctx) as c:
        first = await _post(c, TEXTS, key="k-1")
        assert first.status_code == 200, f"the first request answered {first.status_code}: {first.text}"
        n = _calls(ctx)
        again = await _post(c, TEXTS, key="k-1")
        assert _calls(ctx) == n, f"a retry with the same Idempotency-Key embedded again ({_calls(ctx) - n} more Embed calls): the model server is paid twice for one request"
        assert again.status_code == 200 and again.json() == first.json(), f"the replay must answer the recorded response, got {again.status_code} {again.text[:120]}"
        other = await _post(c, TEXTS, tenant="globex", key="k-1")
        assert other.status_code == 200 and _calls(ctx) == n + 2, f"the key is the tenant's: another tenant's k-1 is a request of its own (expected 2 new Embed calls, saw {_calls(ctx) - n})"
        missing = await _post(c, TEXTS, key=None)
    assert missing.status_code == 400, f"a request without Idempotency-Key answered {missing.status_code}, expected 400"
`,
    typescript: `const TEXTS = ['Rotate keys every 90 days.', 'Revoke a leaked key at once.'];

/** The stand-in model server at MODEL_SERVER, and the app with step 3's real client. */
function world(ctx) {
  const {embedding} = ctx.proto('embedder.proto');
  const config = ctx.load('/support/embedding/config.ts');
  const model = ctx.load('/support/embedding/model.ts');
  ctx.grpc.serve(embedding.Embedder.service, {
    Embed(call, callback) {
      callback(null, {model_version: call.request.model_version, values: model.vectorFor(call.request.model_version, call.request.text)});
    },
  }, config.MODEL_SERVER);
  return {c: ctx.client(ctx.load('api').app), config, model};
}

const calls = ctx => ctx.grpc.callsTo('Embed').length;

function post(c, inputs: string[], tenant: string | null = 'acme', key: string | null = 'k-1') {
  const headers: Record<string, string> = {};
  if (tenant !== null) headers['X-Tenant-Id'] = tenant;
  if (key !== null) headers['Idempotency-Key'] = key;
  return c.post('/v1/embeddings', {json: {inputs}, headers});
}

export async function check_route(ctx) {
  const {c, config, model} = world(ctx);
  const r = await post(c, TEXTS);
  assert.equal(r.status, 200, \`POST /v1/embeddings answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert.equal(body.model_version, config.MODEL_VERSION, \`the response must name the model (\${config.MODEL_VERSION}), got \${body.model_version}\`);
  assert.deepEqual(body.vectors, TEXTS.map(t => model.vectorFor(config.MODEL_VERSION, t)), \`one vector per input, in input order, got \${JSON.stringify(body.vectors)}\`);
  assert.deepEqual(body.content_hashes, TEXTS.map(config.contentHash), \`content_hashes must be the SHA-256 of each input, got \${JSON.stringify(body.content_hashes)}\`);
  assert.equal(body.dimension, 8, \`dimension must be the vectors' length (8), got \${body.dimension}\`);
}

export async function check_tenant_required(ctx) {
  const {c} = world(ctx);
  const r = await post(c, TEXTS, null);
  assert.equal(r.status, 401, \`a request without X-Tenant-Id answered \${r.status}: \${r.text.slice(0, 120)}; it must be 401\`);
  assert.equal(calls(ctx), 0, \`a request without a tenant cost \${calls(ctx)} Embed calls before it was refused\`);
}

export async function check_batch_cap(ctx) {
  const {c} = world(ctx);
  const big = await post(c, Array.from({length: 257}, (_, i) => \`input \${i}\`));
  assert.equal(big.status, 400, \`a batch of 257 inputs answered \${big.status} after \${calls(ctx)} Embed calls: MAX_BATCH_INPUTS = 256, and the 257th is 400\`);
  assert.equal(calls(ctx), 0, \`a refused batch cost \${calls(ctx)} Embed calls\`);
  const empty = await post(c, [], 'acme', 'k-2');
  assert.equal(empty.status, 400, \`an empty batch answered \${empty.status}, expected 400\`);
  const ok = await post(c, TEXTS, 'acme', 'k-3');
  assert.equal(ok.status, 200, \`a batch of two inputs answered \${ok.status}: \${ok.text}\`);
}

export async function check_input_bytes(ctx) {
  const {c} = world(ctx);
  const wide = '日'.repeat(3000); // 3000 characters, 9000 bytes of UTF-8
  const r = await post(c, ['short', wide]);
  assert.equal(r.status, 413, \`an input of 9000 UTF-8 bytes (3000 characters) answered \${r.status}: MAX_INPUT_BYTES counts bytes, and an input over it is 413, not cut and embedded as another text\`);
  assert.equal(calls(ctx), 0, \`nothing in a refused batch is embedded, yet \${calls(ctx)} Embed calls were made\`);
  assert.equal(r.json().index, 1, \`the 413 must name the index of the input (1), got \${r.text}\`);
  const edge = await post(c, ['a'.repeat(8192)], 'acme', 'k-2');
  assert.equal(edge.status, 200, \`an input of exactly 8192 bytes answered \${edge.status}: \${edge.text.slice(0, 120)}\`);
}

export async function check_replay(ctx) {
  const {c} = world(ctx);
  const first = await post(c, TEXTS, 'acme', 'k-1');
  assert.equal(first.status, 200, \`the first request answered \${first.status}: \${first.text}\`);
  const n = calls(ctx);
  const again = await post(c, TEXTS, 'acme', 'k-1');
  assert.equal(calls(ctx), n, \`a retry with the same Idempotency-Key embedded again (\${calls(ctx) - n} more Embed calls): the model server is paid twice for one request\`);
  assert(again.status === 200, \`the replay must answer the recorded response, got \${again.status} \${again.text.slice(0, 120)}\`);
  assert.deepEqual(again.json(), first.json(), 'the replay must answer the recorded response');
  const other = await post(c, TEXTS, 'globex', 'k-1');
  assert(other.status === 200 && calls(ctx) === n + 2, \`the key is the tenant's: another tenant's k-1 is a request of its own (expected 2 new Embed calls, saw \${calls(ctx) - n})\`);
  const missing = await post(c, TEXTS, 'acme', null);
  assert.equal(missing.status, 400, \`a request without Idempotency-Key answered \${missing.status}, expected 400\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"embedding/config"
	"embedding/model"

	"leetbuild/harness"
)

var (
	apiTexts = []string{"Rotate keys every 90 days.", "Revoke a leaked key at once."}
	// apiEmbeds counts the model calls: step 3's embed, stood in for by embedding/model.
	apiEmbeds int
)

func apiWorld(ctx *harness.Ctx) *harness.HTTP {
	apiEmbeds = 0
	embed = func(_ context.Context, text, modelVersion string) ([]float32, error) {
		apiEmbeds++
		return model.VectorFor(modelVersion, text), nil
	}
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func apiPost(c *harness.HTTP, inputs []string, tenant, key string) *harness.Response {
	var header []string
	if tenant != "" {
		header = append(header, "X-Tenant-Id", tenant)
	}
	if key != "" {
		header = append(header, "Idempotency-Key", key)
	}
	return c.Post("/v1/embeddings", map[string]any{"inputs": inputs}, header...)
}

type apiBody struct {
	ModelVersion  string      \`json:"model_version"\`
	Dimension     int         \`json:"dimension"\`
	ContentHashes []string    \`json:"content_hashes"\`
	Vectors       [][]float32 \`json:"vectors"\`
	Index         *int        \`json:"index"\`
}

func CheckRoute(ctx *harness.Ctx) {
	c := apiWorld(ctx)
	r := apiPost(c, apiTexts, "acme", "k-1")
	ctx.Equal(r.Status, 200, "POST /v1/embeddings (%s)", r.Text())
	var body apiBody
	r.Decode(&body)
	ctx.Equal(body.ModelVersion, config.ModelVersion, "the response must name the model")
	ctx.Equal(body.Vectors, [][]float32{model.VectorFor(config.ModelVersion, apiTexts[0]), model.VectorFor(config.ModelVersion, apiTexts[1])}, "one vector per input, in input order")
	ctx.Equal(body.ContentHashes, []string{config.ContentHash(apiTexts[0]), config.ContentHash(apiTexts[1])}, "content_hashes must be the SHA-256 of each input")
	ctx.Equal(body.Dimension, 8, "dimension must be the vectors' length")
}

func CheckTenantRequired(ctx *harness.Ctx) {
	c := apiWorld(ctx)
	r := apiPost(c, apiTexts, "", "k-1")
	ctx.Equal(r.Status, 401, "a request without X-Tenant-Id must be 401 (%s)", r.Text())
	ctx.Equal(apiEmbeds, 0, "a request without a tenant must cost no model call; Embed calls")
}

func CheckBatchCap(ctx *harness.Ctx) {
	c := apiWorld(ctx)
	inputs := make([]string, 257)
	for i := range inputs {
		inputs[i] = fmt.Sprintf("input %d", i)
	}
	big := apiPost(c, inputs, "acme", "k-1")
	ctx.Assert(big.Status == 400, "a batch of 257 inputs answered %d after %d Embed calls: maxBatchInputs = 256, and the 257th is 400", big.Status, apiEmbeds)
	ctx.Equal(apiEmbeds, 0, "a refused batch must cost no model call; Embed calls")
	empty := apiPost(c, []string{}, "acme", "k-2")
	ctx.Equal(empty.Status, 400, "an empty batch")
	ok := apiPost(c, apiTexts, "acme", "k-3")
	ctx.Equal(ok.Status, 200, "a batch of two inputs (%s)", ok.Text())
}

func CheckInputBytes(ctx *harness.Ctx) {
	c := apiWorld(ctx)
	wide := strings.Repeat("日", 3000) // 3000 characters, 9000 bytes of UTF-8
	r := apiPost(c, []string{"short", wide}, "acme", "k-1")
	ctx.Assert(r.Status == 413, "an input of 9000 UTF-8 bytes answered %d: an input over maxInputBytes is 413, not cut and embedded as another text", r.Status)
	ctx.Equal(apiEmbeds, 0, "nothing in a refused batch is embedded; Embed calls")
	var body apiBody
	r.Decode(&body)
	ctx.Assert(body.Index != nil && *body.Index == 1, "the 413 must name the index of the input (1), got %s", r.Text())
	edge := apiPost(c, []string{strings.Repeat("a", 8192)}, "acme", "k-2")
	ctx.Equal(edge.Status, 200, "an input of exactly 8192 bytes")
}

func CheckReplay(ctx *harness.Ctx) {
	c := apiWorld(ctx)
	first := apiPost(c, apiTexts, "acme", "k-1")
	ctx.Equal(first.Status, 200, "the first request (%s)", first.Text())
	n := apiEmbeds
	again := apiPost(c, apiTexts, "acme", "k-1")
	ctx.Assert(apiEmbeds == n, "a retry with the same Idempotency-Key embedded again (%d more Embed calls): the model server is paid twice for one request", apiEmbeds-n)
	ctx.Equal(again.Status, 200, "the replay")
	ctx.Equal(again.JSON(), first.JSON(), "the replay must answer the recorded response")
	other := apiPost(c, apiTexts, "globex", "k-1")
	ctx.Assert(other.Status == 200 && apiEmbeds == n+2, "the key is the tenant's: another tenant's k-1 is a request of its own (expected 2 new Embed calls, saw %d)", apiEmbeds-n)
	missing := apiPost(c, apiTexts, "acme", "")
	ctx.Equal(missing.Status, 400, "a request without Idempotency-Key")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "embedding/config.h"
#include "embedding/model.h"

namespace {

// The model calls: step 3's embed, stood in for by embedding/model.h.
int g_embeds = 0;

}  // namespace

std::vector<float> embed(const std::string& text, const std::string& model_version) {
  g_embeds++;
  return model::vectorFor(model_version, text);
}

namespace {

const std::vector<std::string> kTexts = {"Rotate keys every 90 days.", "Revoke a leaked key at once."};

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  g_embeds = 0;
  return ctx.HTTP(*svr);
}

harness::Response post(harness::HTTP& c, const std::vector<std::string>& inputs, const std::string& tenant, const std::string& key) {
  const std::string body = nlohmann::json{{"inputs", inputs}}.dump();
  if (!tenant.empty() && !key.empty())
    return c.Post("/v1/embeddings", body, "Content-Type", "application/json", "X-Tenant-Id", tenant, "Idempotency-Key", key);
  if (!tenant.empty()) return c.Post("/v1/embeddings", body, "Content-Type", "application/json", "X-Tenant-Id", tenant);
  return c.Post("/v1/embeddings", body, "Content-Type", "application/json", "Idempotency-Key", key);
}

nlohmann::json parsed(const harness::Response& r) { return nlohmann::json::parse(r.Text(), nullptr, false); }

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = post(c, kTexts, "acme", "k-1");
  ctx.Equal(r.Status, 200, "POST /v1/embeddings (%s)", r.Text());
  const auto body = parsed(r);
  ctx.Equal(body.value("model_version", ""), config::kModelVersion, "the response must name the model");
  const std::vector<std::vector<float>> want = {model::vectorFor(config::kModelVersion, kTexts[0]), model::vectorFor(config::kModelVersion, kTexts[1])};
  ctx.Equal(body.value("vectors", nlohmann::json::array()), nlohmann::json(want), "one vector per input, in input order");
  ctx.Equal(body.value("content_hashes", nlohmann::json::array()), nlohmann::json({config::contentHash(kTexts[0]), config::contentHash(kTexts[1])}), "content_hashes must be the SHA-256 of each input");
  ctx.Equal(body.value("dimension", 0), 8, "dimension must be the vectors' length");
}

void CheckTenantRequired(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = post(c, kTexts, "", "k-1");
  ctx.Equal(r.Status, 401, "a request without X-Tenant-Id must be 401 (%s)", r.Text());
  ctx.Equal(g_embeds, 0, "a request without a tenant must cost no model call; Embed calls");
}

void CheckBatchCap(harness::Ctx& ctx) {
  auto c = api(ctx);
  std::vector<std::string> inputs;
  for (int i = 0; i < 257; i++) inputs.push_back("input " + std::to_string(i));
  const auto big = post(c, inputs, "acme", "k-1");
  ctx.Assert(big.Status == 400, "a batch of 257 inputs answered %d after %d Embed calls: kMaxBatchInputs = 256, and the 257th is 400", big.Status, g_embeds);
  ctx.Equal(g_embeds, 0, "a refused batch must cost no model call; Embed calls");
  const auto empty = post(c, {}, "acme", "k-2");
  ctx.Equal(empty.Status, 400, "an empty batch");
  const auto ok = post(c, kTexts, "acme", "k-3");
  ctx.Equal(ok.Status, 200, "a batch of two inputs (%s)", ok.Text());
}

void CheckInputBytes(harness::Ctx& ctx) {
  auto c = api(ctx);
  std::string wide;
  for (int i = 0; i < 3000; i++) wide += "\\u65e5";  // 3000 characters, 9000 bytes of UTF-8
  const auto r = post(c, {"short", wide}, "acme", "k-1");
  ctx.Assert(r.Status == 413, "an input of 9000 UTF-8 bytes answered %d: an input over kMaxInputBytes is 413, not cut and embedded as another text", r.Status);
  ctx.Equal(g_embeds, 0, "nothing in a refused batch is embedded; Embed calls");
  ctx.Equal(parsed(r).value("index", -1), 1, "the 413 must name the index of the input (%s)", r.Text());
  const auto edge = post(c, {std::string(8192, 'a')}, "acme", "k-2");
  ctx.Equal(edge.Status, 200, "an input of exactly 8192 bytes");
}

void CheckReplay(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto first = post(c, kTexts, "acme", "k-1");
  ctx.Equal(first.Status, 200, "the first request (%s)", first.Text());
  const int n = g_embeds;
  const auto again = post(c, kTexts, "acme", "k-1");
  ctx.Assert(g_embeds == n, "a retry with the same Idempotency-Key embedded again (%d more Embed calls): the model server is paid twice for one request", g_embeds - n);
  ctx.Equal(again.Status, 200, "the replay");
  ctx.Equal(parsed(again), parsed(first), "the replay must answer the recorded response");
  const auto other = post(c, kTexts, "globex", "k-1");
  ctx.Assert(other.Status == 200 && g_embeds == n + 2, "the key is the tenant's: another tenant's k-1 is a request of its own (expected 2 new Embed calls, saw %d)", g_embeds - n);
  const auto missing = post(c, kTexts, "acme", "");
  ctx.Equal(missing.Status, 400, "a request without Idempotency-Key");
}
`,
  },
  hints: [
    'A request with no tenant header still comes back 200; a 300-input batch runs for minutes; a long input in Japanese comes back with a vector for a shorter text; a client retry shows up twice on the model bill.',
    'Nothing checks the tenant or measures the batch, the slice cuts inputs instead of refusing them (and in Python counts characters), and nobody reads `Idempotency-Key`, so a retry is a fresh request.',
    'Return 401 on an empty tenant, 400 on a missing key or a batch outside 1..`MAX_BATCH_INPUTS`, 413 with `index` when `len(text.encode("utf-8")) > MAX_INPUT_BYTES`; answer `replays.get(tenant, key)` when set, else embed and `replays.put`.',
  ],
  debrief: `The checks run in cost order: a missing tenant, a missing key, a batch too large and an input too long are all refused before the first model call, so a bad request costs a header read and not a minute of GPU time. Refusing an oversized input instead of cutting it keeps the vector honest; a cut input returns a vector for text the caller never sent, under the hash of that cut text. The replay record is keyed by tenant and key, so a retry after a timeout reads the first answer rather than paying the model again. Production APIs add per-tenant rate limits on inputs per minute, count tokens rather than bytes, and keep a fingerprint of the body so a reused key with a different batch is a 422.`,
};
