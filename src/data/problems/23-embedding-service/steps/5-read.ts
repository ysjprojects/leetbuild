import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/embeddings/{content_hash}: the tenant’s vector, under the model asked for',
  concept: 'http',
  guides: ['honest-reads', 'request-boundaries'],
  file: 'read',
  focus: ['indexer', 'api', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/embeddings/{content_hash}?model_version=\` (default
\`MODEL_VERSION\`), the read the indexer and the retriever use: it takes the tenant from
\`X-Tenant-Id\`, reads \`cache.read_vector(tenant, model_version, hash)\`, and on a miss looks for any
key matching \`emb:*:{hash}\` before answering \`200 {content_hash, vector}\`, with \`[]\` when nothing
matched. It serves the demo and hides 4 flaws.

**Failure mode the checks target.** A caller with no tenant, or another tenant's, reading a vector
by its hash; an \`embed-v2\` request served an \`embed-v1\` vector; and an empty 200 that callers
cache as a real vector.

- A missing \`X-Tenant-Id\` is **401**.
- The read is the exact key \`vector_key(tenant, model_version, hash)\` through \`cache.read_vector\`,
  and nothing else: no pattern over other tenants or models.
- A miss is **404** \`{"error": "not_embedded"}\`.
- A hit answers \`{content_hash, model_version, dimension, vector}\`, so the caller can check the
  vector's space and shape.`,
  sequence: {
    participants: ['Indexer', 'Embedding API', 'Vector cache'],
    messages: [
      {
        from: 'Indexer',
        to: 'Embedding API',
        label: 'GET /v1/embeddings/{hash}?model_version · X-Tenant-Id',
        kind: 'sync',
      },
      {from: 'Embedding API', to: 'Embedding API', label: 'no tenant → 401', kind: 'sync'},
      {from: 'Embedding API', to: 'Vector cache', label: 'GET emb:{tenant}:{model}:{hash}', kind: 'sync'},
      {from: 'Vector cache', to: 'Embedding API', label: 'vector / nil', kind: 'reply'},
      {
        from: 'Embedding API',
        to: 'Indexer',
        label: '200 {model_version, dimension, vector} · 404 not_embedded',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Serves a cached vector on GET /v1/embeddings/{content_hash}',
      detail: 'The route reads the vector through `cache.read_vector` and answers it on a hit.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/embeddings\/\{/, /cache\.read_vector\(/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/embeddings\/:/, /cache\.readVector\(/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/embeddings\/\{/, /cache\.ReadVector\(/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"embeddings"\s*\/\s*Segment\s*\)/, /Cache\.readVector\(/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/embeddings\//, /cache::readVector\(/]},
      },
    },
    {
      id: 'tenant-required',
      title: 'A read without a tenant is 401',
      detail: 'A missing `X-Tenant-Id` answers **401** before Redis is read.',
      match: {
        python: {all: [/x-tenant-id/i, /\b401\b/]},
        typescript: {all: [/x-tenant-id/i, /code\(\s*401\s*\)/]},
        go: {all: [/X-Tenant-Id/i, /StatusUnauthorized|\b401\b/]},
        scala: {all: [/X-Tenant-Id/i, /StatusCodes\.Unauthorized/]},
        cpp: {all: [/X-Tenant-Id/i, /\b401\b/]},
      },
    },
    {
      id: 'exact-key',
      title: 'Reads one exact key, never a pattern',
      detail:
        'Only `vector_key(tenant, model_version, hash)` is read; a `KEYS`/`SCAN` over `emb:*:{hash}` serves other tenants’ and other models’ vectors.',
      match: {
        python: {none: [/\.keys\(|scan_iter\(|\.scan\(/]},
        typescript: {none: [/\.keys\(|\.scan\(|scanStream\(/]},
        go: {none: [/\.Keys\(|\.Scan\(/]},
        scala: {none: [/\.keys\(|\.scan\(/]},
        cpp: {none: [/\.keys\(|\.scan\(/]},
      },
    },
    {
      id: 'miss-404',
      title: 'A miss is 404 not_embedded',
      detail:
        'No vector under the exact key answers **404** `{"error": "not_embedded"}`, not a 200 with an empty vector.',
      match: {
        python: {all: [/\b404\b/, /not_embedded/]},
        typescript: {all: [/code\(\s*404\s*\)/, /not_embedded/]},
        go: {all: [/StatusNotFound|\b404\b/, /not_embedded/]},
        scala: {all: [/StatusCodes\.NotFound/, /not_embedded/]},
        cpp: {all: [/\b404\b/, /not_embedded/]},
      },
    },
    {
      id: 'reports-shape',
      title: 'Answers the model version and dimension with the vector',
      detail: 'A hit carries `model_version` and `dimension` (the vector’s length) beside the vector.',
      match: {
        python: {all: [/["']dimension["']/, /["']model_version["']/]},
        typescript: {all: [/\bdimension:/, /\bmodel_version:/]},
        go: {all: [/"dimension"/, /"model_version"/]},
        scala: {all: [/"dimension"/, /"model_version"/]},
        cpp: {all: [/"dimension"/, /"model_version"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis
from fastapi import FastAPI, Request

from embedding import cache
from embedding.config import MODEL_VERSION

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


@app.get("/v1/embeddings/{digest}")
def read_embedding(digest: str, request: Request) -> dict:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    version = request.query_params.get("model_version", MODEL_VERSION)
    vector = cache.read_vector(tenant, version, digest)
    if vector is None:
        for key in r.keys(f"emb:*:{digest}"):
            vector = json.loads(r.get(key))
            break
    return {"content_hash": digest, "vector": vector or []}
`,
      solution: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from embedding import cache
from embedding.config import MODEL_VERSION

app = FastAPI()


@app.get("/v1/embeddings/{digest}")
def read_embedding(digest: str, request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        return JSONResponse({"error": "missing_tenant"}, status_code=401)
    version = request.query_params.get("model_version", MODEL_VERSION)
    vector = cache.read_vector(tenant, version, digest)  # the exact key: this tenant, this model
    if vector is None:
        return JSONResponse({"error": "not_embedded", "content_hash": digest, "model_version": version}, status_code=404)
    return JSONResponse({"content_hash": digest, "model_version": version, "dimension": len(vector), "vector": vector})
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';
import Redis from 'ioredis';

import {cache} from 'embedding/cache';
import {MODEL_VERSION} from 'embedding/config';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

app.get('/v1/embeddings/:digest', async request => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const tenant = (request.headers['x-tenant-id'] as string | undefined) ?? '';
  const {digest} = request.params as {digest: string};
  const version = (request.query as {model_version?: string}).model_version ?? MODEL_VERSION;
  let vector = await cache.readVector(tenant, version, digest);
  if (vector === null) {
    const [key] = await redis.keys(\`emb:*:\${digest}\`);
    const raw = key === undefined ? null : await redis.get(key);
    if (raw !== null) vector = JSON.parse(raw) as number[];
  }
  return {content_hash: digest, vector: vector ?? []};
});
`,
      solution: `import Fastify from 'fastify';

import {cache} from 'embedding/cache';
import {MODEL_VERSION} from 'embedding/config';

export const app = Fastify();

app.get('/v1/embeddings/:digest', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing_tenant'});
  const {digest} = request.params as {digest: string};
  const version = (request.query as {model_version?: string}).model_version ?? MODEL_VERSION;
  const vector = await cache.readVector(tenant, version, digest); // the exact key: this tenant, this model
  if (vector === null) return reply.code(404).send({error: 'not_embedded', content_hash: digest, model_version: version});
  return {content_hash: digest, model_version: version, dimension: vector.length, vector};
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"github.com/redis/go-redis/v9"

	"embedding/cache"  // cache.ReadVector — provided
	"embedding/config" // config.ModelVersion — provided
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func readEmbedding(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	digest := r.PathValue("hash")
	version := r.URL.Query().Get("model_version")
	if version == "" {
		version = config.ModelVersion
	}
	vector, err := cache.ReadVector(r.Context(), tenant, version, digest)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
		return
	}
	if vector == nil {
		if keys, _ := rdb.Keys(r.Context(), "emb:*:"+digest).Result(); len(keys) > 0 {
			raw, _ := rdb.Get(r.Context(), keys[0]).Result()
			json.Unmarshal([]byte(raw), &vector)
		}
	}
	if vector == nil {
		vector = []float32{}
	}
	writeJSON(rw, http.StatusOK, map[string]any{"content_hash": digest, "vector": vector})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/embeddings/{hash}", readEmbedding)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"

	"embedding/cache"  // cache.ReadVector — provided
	"embedding/config" // config.ModelVersion — provided
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func readEmbedding(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing_tenant"})
		return
	}
	digest := r.PathValue("hash")
	version := r.URL.Query().Get("model_version")
	if version == "" {
		version = config.ModelVersion
	}
	vector, err := cache.ReadVector(r.Context(), tenant, version, digest) // the exact key: this tenant, this model
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
		return
	}
	if vector == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "not_embedded", "content_hash": digest, "model_version": version})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{"content_hash": digest, "model_version": version, "dimension": len(vector), "vector": vector})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/embeddings/{hash}", readEmbedding)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import embedding.{Cache, Config} // Cache.readVector, Config.ModelVersion — provided

object ReadApi {
  private val jedis = new JedisPooled("redis", 6379)

  def read(tenant: String, version: String, digest: String): HttpResponse = {
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    val vector = Cache.readVector(tenant, version, digest).orElse {
      jedis.keys(s"emb:*:$digest").asScala.headOption.flatMap(key => Option(jedis.get(key))).map(raw => ujson.read(raw).arr.map(_.num.toFloat).toSeq)
    }
    val body = ujson.Obj("content_hash" -> digest, "vector" -> ujson.Arr.from(vector.getOrElse(Seq.empty[Float]).map(v => ujson.Num(v.toDouble))))
    HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, ujson.write(body)))
  }

  val route: Route = path("v1" / "embeddings" / Segment) { digest =>
    get {
      optionalHeaderValueByName("X-Tenant-Id") { tenant =>
        parameter("model_version".optional) { version =>
          complete(read(tenant.getOrElse(""), version.getOrElse(Config.ModelVersion), digest))
        }
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

import embedding.{Cache, Config} // Cache.readVector, Config.ModelVersion — provided

object ReadApi {
  private def json(status: StatusCode, body: ujson.Value): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, ujson.write(body)))

  def read(tenant: String, version: String, digest: String): HttpResponse = {
    if (tenant.isEmpty) return json(StatusCodes.Unauthorized, ujson.Obj("error" -> "missing_tenant"))
    Cache.readVector(tenant, version, digest) match { // the exact key: this tenant, this model
      case None => json(StatusCodes.NotFound, ujson.Obj("error" -> "not_embedded", "content_hash" -> digest, "model_version" -> version))
      case Some(vector) =>
        json(
          StatusCodes.OK,
          ujson.Obj(
            "content_hash" -> digest,
            "model_version" -> version,
            "dimension" -> vector.size,
            "vector" -> ujson.Arr.from(vector.map(v => ujson.Num(v.toDouble)))
          )
        )
    }
  }

  val route: Route = path("v1" / "embeddings" / Segment) { digest =>
    get {
      optionalHeaderValueByName("X-Tenant-Id") { tenant =>
        parameter("model_version".optional) { version =>
          complete(read(tenant.getOrElse(""), version.getOrElse(Config.ModelVersion), digest))
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
#include <vector>

#include "embedding/cache.h"   // cache::readVector — provided
#include "embedding/config.h"  // config::kModelVersion, redis — provided

using json = nlohmann::json;

void read_embedding(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  const std::string digest = req.matches[1];
  const std::string version = req.has_param("model_version") ? req.get_param_value("model_version") : config::kModelVersion;
  auto vector = cache::readVector(tenant, version, digest);
  if (!vector) {
    const std::vector<std::string> keys = config::redis().keys("emb:*:" + digest);
    if (!keys.empty()) {
      if (const auto raw = config::redis().get(keys.front())) vector = json::parse(*raw).get<std::vector<float>>();
    }
  }
  res.set_content(json{{"content_hash", digest}, {"vector", vector.value_or(std::vector<float>{})}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Get(R"(/v1/embeddings/([0-9a-f]+))", read_embedding);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

#include "embedding/cache.h"   // cache::readVector — provided
#include "embedding/config.h"  // config::kModelVersion — provided

using json = nlohmann::json;

void read_embedding(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content(json{{"error", "missing_tenant"}}.dump(), "application/json");
    return;
  }
  const std::string digest = req.matches[1];
  const std::string version = req.has_param("model_version") ? req.get_param_value("model_version") : config::kModelVersion;
  const auto vector = cache::readVector(tenant, version, digest);  // the exact key: this tenant, this model
  if (!vector) {
    res.status = 404;
    res.set_content(json{{"error", "not_embedded"}, {"content_hash", digest}, {"model_version", version}}.dump(), "application/json");
    return;
  }
  res.set_content(json{{"content_hash", digest}, {"model_version", version}, {"dimension", vector->size()}, {"vector", *vector}}.dump(),
                  "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Get(R"(/v1/embeddings/([0-9a-f]+))", read_embedding);
}
`,
    },
  },
  harness: {
    python: `import json

from embedding import model
from embedding.config import MODEL_VERSION, PREVIOUS_VERSION, VECTOR_TTL_S, content_hash, vector_key

TEXT = "Rotate keys every 90 days."
OTHER = "Revoke a leaked key at once."


def _seed(ctx, tenant, version, text):
    vector = model.vector_for(version, text)
    ctx.redis.set(vector_key(tenant, version, content_hash(text)), json.dumps(vector), ex=VECTOR_TTL_S)
    return vector


def _api(ctx):
    return ctx.client(ctx.load("read").app)


async def _get(c, text, tenant="acme", version=None):
    headers = {"X-Tenant-Id": tenant} if tenant else {}
    params = {"model_version": version} if version else {}
    return await c.get(f"/v1/embeddings/{content_hash(text)}", headers=headers, params=params)


async def check_route(ctx):
    vector = _seed(ctx, "acme", MODEL_VERSION, TEXT)
    async with _api(ctx) as c:
        r = await _get(c, TEXT)
    assert r.status_code == 200, f"GET /v1/embeddings/{{hash}} of a cached vector answered {r.status_code}: {r.text}"
    assert r.json().get("vector") == vector, f"the read must answer the stored vector {vector}, got {r.json().get('vector')}"


async def check_tenant_required(ctx):
    _seed(ctx, "acme", MODEL_VERSION, TEXT)
    async with _api(ctx) as c:
        r = await _get(c, TEXT, tenant=None)
    assert r.status_code == 401, f"a read without X-Tenant-Id answered {r.status_code}: {r.text[:160]}; it must be 401"


async def check_exact_key(ctx):
    _seed(ctx, "acme", MODEL_VERSION, TEXT)
    v1 = _seed(ctx, "acme", PREVIOUS_VERSION, OTHER)
    async with _api(ctx) as c:
        other_tenant = await _get(c, TEXT, tenant="globex")
        assert other_tenant.status_code == 404, f"globex read acme's vector by its hash ({other_tenant.status_code} {other_tenant.text[:120]}): the read must be the exact key of the caller's tenant"
        newer = await _get(c, OTHER)
        assert newer.status_code == 404, f"an {MODEL_VERSION} read of a text cached only under {PREVIOUS_VERSION} answered {newer.status_code} {newer.text[:120]}: a vector from another model is not this model's vector"
        older = await _get(c, OTHER, version=PREVIOUS_VERSION)
    assert older.status_code == 200 and older.json().get("vector") == v1, f"?model_version={PREVIOUS_VERSION} must answer the {PREVIOUS_VERSION} vector, got {older.status_code} {older.text[:120]}"


async def check_miss_404(ctx):
    async with _api(ctx) as c:
        r = await _get(c, "Never embedded.")
    assert r.status_code == 404, f"a hash with no vector answered {r.status_code} {r.text[:120]}: a miss is 404, and a 200 with [] gets cached as a real vector"
    assert r.json().get("error") == "not_embedded", f"the 404 must say not_embedded, got {r.text}"


async def check_reports_shape(ctx):
    _seed(ctx, "acme", MODEL_VERSION, TEXT)
    _seed(ctx, "acme", PREVIOUS_VERSION, OTHER)
    async with _api(ctx) as c:
        current = (await _get(c, TEXT)).json()
        older = (await _get(c, OTHER, version=PREVIOUS_VERSION)).json()
    assert current.get("model_version") == MODEL_VERSION and current.get("dimension") == 8, f"a hit must carry model_version={MODEL_VERSION} and dimension=8, got {current}"
    assert older.get("model_version") == PREVIOUS_VERSION and older.get("dimension") == 4, f"an {PREVIOUS_VERSION} hit must carry model_version={PREVIOUS_VERSION} and dimension=4, got {older}"
`,
    typescript: `const TEXT = 'Rotate keys every 90 days.';
const OTHER = 'Revoke a leaked key at once.';

function world(ctx) {
  const config = ctx.load('/support/embedding/config.ts');
  const model = ctx.load('/support/embedding/model.ts');
  const seed = (tenant: string, version: string, text: string) => {
    const vector = model.vectorFor(version, text);
    ctx.redis.set(config.vectorKey(tenant, version, config.contentHash(text)), JSON.stringify(vector), 'EX', config.VECTOR_TTL_S);
    return vector;
  };
  const c = ctx.client(ctx.load('read').app);
  const get = (text: string, tenant: string | null = 'acme', version: string | null = null) =>
    c.get(\`/v1/embeddings/\${config.contentHash(text)}\`, {headers: tenant ? {'X-Tenant-Id': tenant} : {}, query: version ? {model_version: version} : {}});
  return {config, seed, get};
}

export async function check_route(ctx) {
  const {config, seed, get} = world(ctx);
  const vector = seed('acme', config.MODEL_VERSION, TEXT);
  const r = await get(TEXT);
  assert.equal(r.status, 200, \`GET /v1/embeddings/{hash} of a cached vector answered \${r.status}: \${r.text}\`);
  assert.deepEqual(r.json().vector, vector, \`the read must answer the stored vector, got \${JSON.stringify(r.json().vector)}\`);
}

export async function check_tenant_required(ctx) {
  const {config, seed, get} = world(ctx);
  seed('acme', config.MODEL_VERSION, TEXT);
  const r = await get(TEXT, null);
  assert.equal(r.status, 401, \`a read without X-Tenant-Id answered \${r.status}: \${r.text.slice(0, 160)}; it must be 401\`);
}

export async function check_exact_key(ctx) {
  const {config, seed, get} = world(ctx);
  seed('acme', config.MODEL_VERSION, TEXT);
  const v1 = seed('acme', config.PREVIOUS_VERSION, OTHER);
  const otherTenant = await get(TEXT, 'globex');
  assert.equal(otherTenant.status, 404, \`globex read acme's vector by its hash (\${otherTenant.status} \${otherTenant.text.slice(0, 120)}): the read must be the exact key of the caller's tenant\`);
  const newer = await get(OTHER);
  assert.equal(newer.status, 404, \`an embed-v2 read of a text cached only under embed-v1 answered \${newer.status} \${newer.text.slice(0, 120)}: a vector from another model is not this model's vector\`);
  const older = await get(OTHER, 'acme', config.PREVIOUS_VERSION);
  assert(older.status === 200 && JSON.stringify(older.json().vector) === JSON.stringify(v1), \`?model_version=embed-v1 must answer the embed-v1 vector, got \${older.status} \${older.text.slice(0, 120)}\`);
}

export async function check_miss_404(ctx) {
  const {get} = world(ctx);
  const r = await get('Never embedded.');
  assert.equal(r.status, 404, \`a hash with no vector answered \${r.status} \${r.text.slice(0, 120)}: a miss is 404, and a 200 with [] gets cached as a real vector\`);
  assert.equal(r.json().error, 'not_embedded', \`the 404 must say not_embedded, got \${r.text}\`);
}

export async function check_reports_shape(ctx) {
  const {config, seed, get} = world(ctx);
  seed('acme', config.MODEL_VERSION, TEXT);
  seed('acme', config.PREVIOUS_VERSION, OTHER);
  const current = (await get(TEXT)).json();
  const older = (await get(OTHER, 'acme', config.PREVIOUS_VERSION)).json();
  assert(current.model_version === config.MODEL_VERSION && current.dimension === 8, \`a hit must carry model_version=embed-v2 and dimension=8, got \${JSON.stringify(current)}\`);
  assert(older.model_version === config.PREVIOUS_VERSION && older.dimension === 4, \`an embed-v1 hit must carry model_version=embed-v1 and dimension=4, got \${JSON.stringify(older)}\`);
}
`,
    go: `package main

import (
	"encoding/json"
	"net/http"

	"embedding/config"
	"embedding/model"

	"leetbuild/harness"
)

const (
	readText  = "Rotate keys every 90 days."
	readOther = "Revoke a leaked key at once."
)

func readSeed(ctx *harness.Ctx, tenant, version, text string) []float32 {
	vector := model.VectorFor(version, text)
	doc, _ := json.Marshal(vector)
	ctx.Redis.Set(config.VectorKey(tenant, version, config.ContentHash(text)), string(doc), "EX", config.VectorTTLSeconds)
	return vector
}

func readAPI(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func readGet(c *harness.HTTP, text, tenant, version string) *harness.Response {
	path := "/v1/embeddings/" + config.ContentHash(text)
	if version != "" {
		path += "?model_version=" + version
	}
	if tenant == "" {
		return c.Get(path)
	}
	return c.Get(path, "X-Tenant-Id", tenant)
}

type readBody struct {
	Error        string    \`json:"error"\`
	ModelVersion string    \`json:"model_version"\`
	Dimension    int       \`json:"dimension"\`
	Vector       []float32 \`json:"vector"\`
}

func readDecode(r *harness.Response) readBody {
	var body readBody
	json.Unmarshal(r.Body, &body)
	return body
}

func CheckRoute(ctx *harness.Ctx) {
	vector := readSeed(ctx, "acme", config.ModelVersion, readText)
	r := readGet(readAPI(ctx), readText, "acme", "")
	ctx.Equal(r.Status, 200, "GET /v1/embeddings/{hash} of a cached vector (%s)", r.Text())
	ctx.Equal(readDecode(r).Vector, vector, "the read must answer the stored vector")
}

func CheckTenantRequired(ctx *harness.Ctx) {
	readSeed(ctx, "acme", config.ModelVersion, readText)
	r := readGet(readAPI(ctx), readText, "", "")
	ctx.Equal(r.Status, 401, "a read without X-Tenant-Id must be 401 (%s)", r.Text())
}

func CheckExactKey(ctx *harness.Ctx) {
	readSeed(ctx, "acme", config.ModelVersion, readText)
	v1 := readSeed(ctx, "acme", config.PreviousVersion, readOther)
	c := readAPI(ctx)
	otherTenant := readGet(c, readText, "globex", "")
	ctx.Assert(otherTenant.Status == 404, "globex read acme's vector by its hash (%d %s): the read must be the exact key of the caller's tenant", otherTenant.Status, otherTenant.Text())
	newer := readGet(c, readOther, "acme", "")
	ctx.Assert(newer.Status == 404, "an embed-v2 read of a text cached only under embed-v1 answered %d %s: a vector from another model is not this model's vector", newer.Status, newer.Text())
	older := readGet(c, readOther, "acme", config.PreviousVersion)
	ctx.Equal(older.Status, 200, "?model_version=embed-v1 must answer the embed-v1 vector (%s)", older.Text())
	ctx.Equal(readDecode(older).Vector, v1, "the embed-v1 vector")
}

func CheckMiss404(ctx *harness.Ctx) {
	r := readGet(readAPI(ctx), "Never embedded.", "acme", "")
	ctx.Assert(r.Status == 404, "a hash with no vector answered %d %s: a miss is 404, and a 200 with [] gets cached as a real vector", r.Status, r.Text())
	ctx.Equal(readDecode(r).Error, "not_embedded", "the 404's error")
}

func CheckReportsShape(ctx *harness.Ctx) {
	readSeed(ctx, "acme", config.ModelVersion, readText)
	readSeed(ctx, "acme", config.PreviousVersion, readOther)
	c := readAPI(ctx)
	current := readDecode(readGet(c, readText, "acme", ""))
	older := readDecode(readGet(c, readOther, "acme", config.PreviousVersion))
	ctx.Assert(current.ModelVersion == config.ModelVersion && current.Dimension == 8, "a hit must carry model_version=embed-v2 and dimension=8, got %+v", current)
	ctx.Assert(older.ModelVersion == config.PreviousVersion && older.Dimension == 4, "an embed-v1 hit must carry model_version=embed-v1 and dimension=4, got %+v", older)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "embedding/config.h"
#include "embedding/model.h"

namespace {

const std::string kText = "Rotate keys every 90 days.";
const std::string kOther = "Revoke a leaked key at once.";

std::vector<float> seed(harness::Ctx& ctx, const std::string& tenant, const std::string& version, const std::string& text) {
  const auto vector = model::vectorFor(version, text);
  ctx.Redis.Set(config::vectorKey(tenant, version, config::contentHash(text)), nlohmann::json(vector).dump(), "EX", config::kVectorTtlSeconds);
  return vector;
}

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response get(harness::HTTP& c, const std::string& text, const std::string& tenant, const std::string& version = "") {
  std::string path = "/v1/embeddings/" + config::contentHash(text);
  if (!version.empty()) path += "?model_version=" + version;
  if (tenant.empty()) return c.Get(path);
  return c.Get(path, "X-Tenant-Id", tenant);
}

nlohmann::json parsed(const harness::Response& r) { return nlohmann::json::parse(r.Text(), nullptr, false); }

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  const auto vector = seed(ctx, "acme", config::kModelVersion, kText);
  auto c = api(ctx);
  const auto r = get(c, kText, "acme");
  ctx.Equal(r.Status, 200, "GET /v1/embeddings/{hash} of a cached vector (%s)", r.Text());
  ctx.Equal(parsed(r).value("vector", nlohmann::json::array()), nlohmann::json(vector), "the read must answer the stored vector");
}

void CheckTenantRequired(harness::Ctx& ctx) {
  seed(ctx, "acme", config::kModelVersion, kText);
  auto c = api(ctx);
  const auto r = get(c, kText, "");
  ctx.Equal(r.Status, 401, "a read without X-Tenant-Id must be 401 (%s)", r.Text());
}

void CheckExactKey(harness::Ctx& ctx) {
  seed(ctx, "acme", config::kModelVersion, kText);
  const auto v1 = seed(ctx, "acme", config::kPreviousVersion, kOther);
  auto c = api(ctx);
  const auto other_tenant = get(c, kText, "globex");
  ctx.Assert(other_tenant.Status == 404, "globex read acme's vector by its hash (%d %s): the read must be the exact key of the caller's tenant", other_tenant.Status, other_tenant.Text());
  const auto newer = get(c, kOther, "acme");
  ctx.Assert(newer.Status == 404, "an embed-v2 read of a text cached only under embed-v1 answered %d %s: a vector from another model is not this model's vector", newer.Status, newer.Text());
  const auto older = get(c, kOther, "acme", config::kPreviousVersion);
  ctx.Equal(older.Status, 200, "?model_version=embed-v1 must answer the embed-v1 vector (%s)", older.Text());
  ctx.Equal(parsed(older).value("vector", nlohmann::json::array()), nlohmann::json(v1), "the embed-v1 vector");
}

void CheckMiss404(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = get(c, "Never embedded.", "acme");
  ctx.Assert(r.Status == 404, "a hash with no vector answered %d %s: a miss is 404, and a 200 with [] gets cached as a real vector", r.Status, r.Text());
  ctx.Equal(parsed(r).value("error", ""), "not_embedded", "the 404's error");
}

void CheckReportsShape(harness::Ctx& ctx) {
  seed(ctx, "acme", config::kModelVersion, kText);
  seed(ctx, "acme", config::kPreviousVersion, kOther);
  auto c = api(ctx);
  const auto current = parsed(get(c, kText, "acme"));
  const auto older = parsed(get(c, kOther, "acme", config::kPreviousVersion));
  ctx.Assert(current.value("model_version", "") == config::kModelVersion && current.value("dimension", 0) == 8, "a hit must carry model_version=embed-v2 and dimension=8, got %v", current);
  ctx.Assert(older.value("model_version", "") == config::kPreviousVersion && older.value("dimension", 0) == 4, "an embed-v1 hit must carry model_version=embed-v1 and dimension=4, got %v", older);
}
`,
  },
  hints: [
    'A read with no tenant header, or with another tenant’s, comes back 200 with a vector; an `embed-v2` read returns four values; an unknown hash answers 200 with an empty vector.',
    'On a miss the starter scans `emb:*:{hash}`, a pattern that matches every tenant and every model, and nothing checks the tenant first. The empty fallback hides the miss, and the body never says which model produced the vector.',
    'Return 401 on an empty tenant; keep only `cache.read_vector(tenant, version, digest)` and drop the scan; on `None` answer 404 `{"error": "not_embedded"}`; on a hit add `"model_version": version` and `"dimension": len(vector)`.',
  ],
  debrief: `The read is one exact key because the key is the access rule: tenant, model and hash each narrow what a caller may see, and a pattern that widens any of them hands out vectors that belong to someone else or to another model’s space. A 404 lets the caller tell "not embedded yet" from a vector, where a 200 with \`[]\` gets cached and ranked as if it were real. Naming the model and the dimension in the body lets a retriever refuse a vector from the wrong space before it scores anything. Production reads add a batch endpoint for many hashes, a short private cache header, and a metric of misses per model during a migration.`,
};
