import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/models/{name}/versions/{v}: eval record attached',
  concept: 'http',
  file: 'read',
  focus: ['client', 'registry', 'redis', 'eval', 'db'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/models/{name}/versions/{v}\`: it loads the version
record, answers from a Redis cache keyed \`mread:{name}:{v}\`, builds
\`{name, version, stage, lineage_tag}\`, adds \`eval_record\` only when the record's \`passed\`
flag is set, and caches the body for \`CACHE_TTL_S = 3600\`. It reads no tenant header and no
pool pointer. It compiles and hides four flaws.

**Failure mode the checks target.** A consumer that reads a version after a promotion and still
sees the old serving state for most of an hour, and one that cannot distinguish a gate that failed
from a gate that was never evaluated.

- The tenant comes from \`X-Tenant-Id\`; missing is **401**. \`assert_visible\` compares the
  record's owner with the request tenant and answers **404** for a foreign private model.
- The response carries the version, \`lineage_tag\`, \`artifact_digest\`, \`pools\` (each with the
  \`active:{pool}\` pointer it resolves to) and \`eval_record = {eval_id, score, threshold, passed}\`,
  attached unconditionally, including when the score was below \`threshold\`.
- The cache key includes the active pointer (\`mread:{tenant}:{name}:{v}:{pointer}\`) and the
  entry expires after \`READ_TTL_S = 5\`, so a promotion is visible within seconds.
- The response shape otherwise stays as it is.`,
  sequence: {
    participants: ['Client', 'Model Registry', 'Redis', 'Eval store'],
    messages: [
      {from: 'Client', to: 'Model Registry', label: 'GET /v1/models/acme/versions/v3 · X-Tenant-Id', kind: 'sync'},
      {from: 'Model Registry', to: 'Eval store', label: 'eval_record(eval_id)', kind: 'sync'},
      {from: 'Eval store', to: 'Model Registry', label: 'score · threshold (even when failed)', kind: 'reply'},
      {from: 'Model Registry', to: 'Redis', label: 'GET active:prod', kind: 'sync'},
      {from: 'Redis', to: 'Model Registry', label: 'acme:v3 · the current pointer', kind: 'reply'},
      {from: 'Model Registry', to: 'Redis', label: 'SET mread:{tenant}:{name}:{v}:{pointer} EX 5', kind: 'sync'},
      {from: 'Model Registry', to: 'Client', label: '200 {version, lineage, pools, eval_record}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route-read',
      title: 'Handles GET /v1/models/{name}/versions/{v}',
      detail: 'Register the version read on `GET /v1/models/{name}/versions/{v}`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/models\/\{name\}\/versions\/\{v\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/models\/:name\/versions\/:v['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/models\/\{name\}\/versions\/\{v\}"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"models"/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*"\/v1\/models/]},
      },
    },
    {
      id: 'eval-always',
      title: 'Attaches the eval record even when the score failed',
      detail:
        'The eval record is attached unconditionally, not only when `passed` is true. The starter gates it behind `if passed`, so a failing eval vanishes and a reviewer cannot tell the gate was never opened.',
      match: {
        python: {all: [/eval_record/], none: [/if\s+record[^\n]*passed/]},
        typescript: {all: [/eval_record/], none: [/if\s*\(\s*record[^\n]*passed/]},
        go: {all: [/eval_record/], none: [/if\s+record[^\n]*[Pp]assed/]},
        scala: {all: [/eval_record/], none: [/if\s*\(\s*record[^\n]*passed/]},
        cpp: {all: [/eval_record/], none: [/if\s*\(\s*record[^\n]*passed/]},
      },
    },
    {
      id: 'threshold-included',
      title: 'Returns the eval threshold alongside the score',
      detail:
        'The eval record carries `score` and `threshold` (and the derived `passed`), so a consumer sees how close a failing eval was. The starter returns nothing when the score was low.',
      match: {
        python: {all: [/threshold/]},
        typescript: {all: [/threshold/]},
        go: {all: [/threshold/]},
        scala: {all: [/threshold/]},
        cpp: {all: [/threshold/]},
      },
    },
    {
      id: 'tenant-404',
      title: 'Answers 404 for a foreign tenant’s private model',
      detail:
        'The model’s owner is compared with the request tenant and a foreign model answers **404**, indistinguishable from a missing one. The starter serves any tenant’s private metadata.',
      match: {
        python: {all: [/assert_visible/, /404/]},
        typescript: {all: [/assertVisible/, /404/]},
        go: {all: [/assertVisible/, /StatusNotFound|404/]},
        scala: {all: [/assertVisible/, /NotFound|404/]},
        cpp: {all: [/assert_visible/, /404/]},
      },
    },
    {
      id: 'fresh-promotion',
      title: 'Keys the cache on the active pointer with a short TTL',
      detail:
        'The cache key carries the current `active:{pool}` pointer and the entry expires in 5 seconds, so a promotion invalidates the stale read. The starter caches per version for an hour, hiding promotions.',
      match: {
        python: {all: [/active:\{pool\}/, /READ_TTL_S\s*=\s*5/]},
        typescript: {all: [/active:\$\{pool\}/, /READ_TTL_S\s*=\s*5/]},
        go: {all: [/active:"\s*\+\s*pool/, /readTTLS\s*=\s*5/]},
        scala: {all: [/active:\$pool/, /ReadTtlS\s*=\s*5/]},
        cpp: {all: [/"active:"\s*\+\s*pool/, /kReadTtlS\s*=\s*5/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis
from fastapi import FastAPI

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

CACHE_TTL_S = 3600


class ModelStore:
    def get(self, name: str, version: str) -> dict | None:
        """The version record, if any."""
        raise NotImplementedError

    def eval_record(self, eval_id: str) -> dict | None:
        """The eval record, if any."""
        raise NotImplementedError


models = ModelStore()


@app.get("/v1/models/{name}/versions/{v}")
def read_version(name: str, v: str) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    record = models.get(name, v) or {}
    cached = r.get(f"mread:{name}:{v}")
    if cached is not None:
        return json.loads(cached)
    body = {"name": name, "version": v, "stage": record.get("stage"), "lineage_tag": record.get("lineage_tag")}
    if record.get("passed"):
        body["eval_record"] = models.eval_record(record.get("eval_id"))
    r.set(f"mread:{name}:{v}", json.dumps(body), ex=CACHE_TTL_S)
    return body
`,
      solution: `import json

import redis
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

READ_TTL_S = 5


class ModelStore:
    def get(self, name: str, version: str) -> dict | None:
        """The version record, if any."""
        raise NotImplementedError

    def eval_record(self, eval_id: str) -> dict | None:
        """The eval record, if any."""
        raise NotImplementedError


models = ModelStore()


def assert_visible(tenant: str, record: dict) -> None:
    if record.get("owner_tenant") != tenant:
        raise HTTPException(status_code=404, detail="model not found")


@app.get("/v1/models/{name}/versions/{v}")
def read_version(
    name: str,
    v: str,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    record = models.get(name, v)
    if record is None:
        raise HTTPException(status_code=404, detail="model not found")
    assert_visible(tenant, record)

    pools = {pool: r.get(f"active:{pool}") for pool in record.get("pools", [])}
    pointer = r.get(f"active:{record['primary_pool']}")
    cache_key = f"mread:{tenant}:{name}:{v}:{pointer}"

    cached = r.get(cache_key)
    if cached is not None:
        return JSONResponse(json.loads(cached), status_code=200)

    eval_record = models.eval_record(record["eval_id"]) or {}
    score = eval_record.get("score")
    threshold = eval_record.get("threshold")
    body = {
        "name": name,
        "version": v,
        "stage": record.get("stage"),
        "lineage_tag": record.get("lineage_tag"),
        "artifact_digest": record.get("artifact_digest"),
        "pools": pools,
        "eval_record": {
            "eval_id": record["eval_id"],
            "score": score,
            "threshold": threshold,
            "passed": score is not None and threshold is not None and score >= threshold,
        },
    }
    r.set(cache_key, json.dumps(body), ex=READ_TTL_S)
    return JSONResponse(body, status_code=200)
`,
    },
    typescript: {
      starter: `/** GET /v1/models/{name}/versions/{v}: reads a version through a cache. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

import {models} from './registry';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const CACHE_TTL_S = 3600;

app.get('/v1/models/:name/versions/:v', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const {name, v} = request.params as {name: string; v: string};
  const cached = await r.get(\`mread:\${name}:\${v}\`);
  if (cached !== null) return reply.code(200).send(JSON.parse(cached));
  const record = await models.get(name, v);
  const body: Record<string, unknown> = {
    name,
    version: v,
    stage: record.stage,
    lineage_tag: record.lineage_tag,
  };
  if (record.passed) body.eval_record = await models.evalRecord(record.eval_id);
  await r.set(\`mread:\${name}:\${v}\`, JSON.stringify(body), 'EX', CACHE_TTL_S);
  return reply.code(200).send(body);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/models/{name}/versions/{v}: lineage, pools and the eval record, always attached. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

import {models} from './registry';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const READ_TTL_S = 5;

function assertVisible(tenant: string, record: {owner_tenant: string}): void {
  if (record.owner_tenant !== tenant) throw Object.assign(new Error('model not found'), {statusCode: 404});
}

app.get('/v1/models/:name/versions/:v', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {name, v} = request.params as {name: string; v: string};
  const record = await models.get(name, v);
  if (record === null) return reply.code(404).send({error: 'model not found'});
  assertVisible(tenant, record);

  const pools: Record<string, string | null> = {};
  for (const pool of record.pools) pools[pool] = await r.get(\`active:\${pool}\`);
  const pointer = await r.get(\`active:\${record.primary_pool}\`);
  const cacheKey = \`mread:\${tenant}:\${name}:\${v}:\${pointer}\`;

  const cached = await r.get(cacheKey);
  if (cached !== null) return reply.code(200).send(JSON.parse(cached));

  const evalRecord = (await models.evalRecord(record.eval_id)) ?? {};
  const body = {
    name,
    version: v,
    stage: record.stage,
    lineage_tag: record.lineage_tag,
    artifact_digest: record.artifact_digest,
    pools,
    eval_record: {
      eval_id: record.eval_id,
      score: evalRecord.score,
      threshold: evalRecord.threshold,
      passed: (evalRecord.score ?? 0) >= (evalRecord.threshold ?? 0),
    },
  };
  await r.set(cacheKey, JSON.stringify(body), 'EX', READ_TTL_S);
  return reply.code(200).send(body);
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
	"time"

	"github.com/redis/go-redis/v9"
)

const cacheTTLS = 3600

var rdb *redis.Client

type ModelStore struct{}

func (s *ModelStore) Get(ctx context.Context, name, version string) (map[string]any, error) {
	return nil, nil
}

func (s *ModelStore) EvalRecord(ctx context.Context, evalID string) (map[string]any, error) {
	return nil, nil
}

var models = &ModelStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func readVersion(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	name := r.PathValue("name")
	version := r.PathValue("v")
	record, _ := models.Get(r.Context(), name, version)
	if cached, err := rdb.Get(r.Context(), "mread:"+name+":"+version).Result(); err == nil {
		rw.Header().Set("Content-Type", "application/json")
		rw.WriteHeader(http.StatusOK)
		rw.Write([]byte(cached))
		return
	}
	body := map[string]any{"name": name, "version": version, "stage": record["stage"]}
	if record["passed"] == true {
		evalRecord, _ := models.EvalRecord(r.Context(), record["eval_id"].(string))
		body["eval_record"] = evalRecord
	}
	payload, _ := json.Marshal(body)
	rdb.Set(r.Context(), "mread:"+name+":"+version, payload, time.Duration(cacheTTLS)*time.Second)
	writeJSON(rw, http.StatusOK, body)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/models/{name}/versions/{v}", readVersion)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"
)

const readTTLS = 5

var rdb *redis.Client

type ModelStore struct{}

func (s *ModelStore) Get(ctx context.Context, name, version string) (map[string]any, error) {
	return nil, nil
}

func (s *ModelStore) EvalRecord(ctx context.Context, evalID string) (map[string]any, error) {
	return nil, nil
}

var models = &ModelStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func assertVisible(tenant string, record map[string]any) bool {
	return record["owner_tenant"] == tenant
}

func readVersion(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	name := r.PathValue("name")
	version := r.PathValue("v")
	record, err := models.Get(r.Context(), name, version)
	if err != nil || record == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "model not found"})
		return
	}
	if !assertVisible(tenant, record) {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "model not found"})
		return
	}
	pools := map[string]any{}
	for _, pool := range record["pools"].([]string) {
		active, _ := rdb.Get(r.Context(), "active:"+pool).Result()
		pools[pool] = active
	}
	pointer, _ := rdb.Get(r.Context(), "active:"+record["primary_pool"].(string)).Result()
	cacheKey := "mread:" + tenant + ":" + name + ":" + version + ":" + pointer

	if cached, err := rdb.Get(r.Context(), cacheKey).Result(); err == nil {
		rw.Header().Set("Content-Type", "application/json")
		rw.WriteHeader(http.StatusOK)
		rw.Write([]byte(cached))
		return
	}
	evalRecord, _ := models.EvalRecord(r.Context(), record["eval_id"].(string))
	body := map[string]any{
		"name":            name,
		"version":         version,
		"stage":           record["stage"],
		"lineage_tag":     record["lineage_tag"],
		"artifact_digest": record["artifact_digest"],
		"pools":           pools,
		"eval_record": map[string]any{
			"eval_id":   record["eval_id"],
			"score":     evalRecord["score"],
			"threshold": evalRecord["threshold"],
			"passed":    evalRecord["score"].(float64) >= evalRecord["threshold"].(float64),
		},
	}
	payload, _ := json.Marshal(body)
	rdb.Set(r.Context(), cacheKey, payload, time.Duration(readTTLS)*time.Second)
	writeJSON(rw, http.StatusOK, body)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/models/{name}/versions/{v}", readVersion)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json._

object VersionRead {
  implicit val system: ActorSystem = ActorSystem("model-registry")
  val CacheTtlS = 3600L
  val jedis = new Jedis("redis", 6379)

  val route: Route =
    path("v1" / "models" / Segment / "versions" / Segment) { (name, version) =>
      get {
        // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
        val key = s"mread:$name:$version"
        Option(jedis.get(key)) match {
          case Some(cached) =>
            complete(StatusCodes.OK, cached)
          case None =>
            val record = ModelStore.get(name, version)
            val body = Map("name" -> name, "version" -> version, "stage" -> record("stage"))
            val withEval =
              if (record("passed") == "true") body + ("eval_record" -> ModelStore.evalRecord(record("eval_id")))
              else body
            val json = withEval.toJson.compactPrint
            jedis.setex(key, CacheTtlS, json)
            complete(StatusCodes.OK, json)
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json._

object VersionRead {
  implicit val system: ActorSystem = ActorSystem("model-registry")
  val ReadTtlS = 5L
  val jedis = new Jedis("redis", 6379)

  def assertVisible(tenant: String, record: Map[String, String]): Unit =
    if (record.get("owner_tenant") != Some(tenant))
      throw new NotFoundException("model not found")

  val route: Route =
    path("v1" / "models" / Segment / "versions" / Segment) { (name, version) =>
      get {
        headerValueByName("X-Tenant-Id") { tenant =>
          val record = ModelStore.get(name, version)
          assertVisible(tenant, record)
          val pools = record
            .getOrElse("pools", "")
            .split(",")
            .filter(_.nonEmpty)
            .map(pool => pool -> Option(jedis.get(s"active:$pool")).getOrElse(""))
            .toMap
          val pointer = Option(jedis.get(s"active:\${record("primary_pool")}")).getOrElse("")
          val cacheKey = s"mread:$tenant:$name:$version:$pointer"
          val body = Option(jedis.get(cacheKey)).getOrElse {
            val evalRecord = ModelStore.evalRecord(record("eval_id"))
            val json = Map(
              "name" -> name,
              "version" -> version,
              "stage" -> record.getOrElse("stage", ""),
              "lineage_tag" -> record.getOrElse("lineage_tag", ""),
              "artifact_digest" -> record.getOrElse("artifact_digest", ""),
              "pools" -> pools,
              "eval_record" -> Map(
                "eval_id" -> record("eval_id"),
                "score" -> evalRecord.getOrElse("score", "0"),
                "threshold" -> evalRecord.getOrElse("threshold", "0"),
                "passed" -> (evalRecord.getOrElse("score", "0").toDouble >= evalRecord.getOrElse("threshold", "0").toDouble)
              )
            ).toJson.compactPrint
            jedis.setex(cacheKey, ReadTtlS, json)
            json
          }
          complete(StatusCodes.OK, body)
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
#include <sw/redis++/redis++.h>

#include <string>

using json = nlohmann::json;

constexpr long long kCacheTtlS = 3600;

struct ModelStore {
  json get(const std::string& name, const std::string& version);
  json eval_record(const std::string& eval_id);
};

ModelStore models;

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;

  svr.Get("/v1/models/([^/]+)/versions/([^/]+)", [&redis](const httplib::Request& req, httplib::Response& res) {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    const auto name = req.matches[1].str();
    const auto version = req.matches[2].str();
    const auto cache_key = "mread:" + name + ":" + version;
    auto cached = redis.get(cache_key);
    if (cached) {
      res.status = 200;
      res.set_content(*cached, "application/json");
      return;
    }
    const json record = models.get(name, version);
    json body = {{"name", name}, {"version", version}, {"stage", record.value("stage", std::string())}};
    if (record.value("passed", false)) body["eval_record"] = models.eval_record(record.value("eval_id", std::string()));
    res.status = 200;
    res.set_content(body.dump(), "application/json");
    redis.setex(cache_key, kCacheTtlS, body.dump());
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <string>
#include <vector>

using json = nlohmann::json;

constexpr long long kReadTtlS = 5;

struct NotFoundError {
  std::string message;
};

struct ModelStore {
  json get(const std::string& name, const std::string& version);
  json eval_record(const std::string& eval_id);
};

ModelStore models;

void assert_visible(const std::string& tenant, const json& record) {
  if (record.value("owner_tenant", std::string()) != tenant) throw NotFoundError{"model not found"};
}

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;

  svr.Get("/v1/models/([^/]+)/versions/([^/]+)", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto name = req.matches[1].str();
    const auto version = req.matches[2].str();
    const json record = models.get(name, version);
    if (record.is_null()) {
      res.status = 404;
      res.set_content(R"({"error":"model not found"})", "application/json");
      return;
    }
    try {
      assert_visible(tenant, record);
    } catch (const NotFoundError& error) {
      res.status = 404;
      res.set_content(json{{"error", error.message}}.dump(), "application/json");
      return;
    }
    json pools = json::object();
    for (const auto& pool : record.value("pools", std::vector<std::string>{})) {
      auto active = redis.get("active:" + pool);
      pools[pool] = active ? *active : "";
    }
    auto pointer = redis.get("active:" + record.value("primary_pool", std::string()));
    const auto cache_key = "mread:" + tenant + ":" + name + ":" + version + ":" + (pointer ? *pointer : "");
    auto cached = redis.get(cache_key);
    if (cached) {
      res.status = 200;
      res.set_content(*cached, "application/json");
      return;
    }
    const json eval_record = models.eval_record(record.value("eval_id", std::string()));
    const json body = {
        {"name", name},
        {"version", version},
        {"stage", record.value("stage", std::string())},
        {"lineage_tag", record.value("lineage_tag", std::string())},
        {"artifact_digest", record.value("artifact_digest", std::string())},
        {"pools", pools},
        {"eval_record",
         {{"eval_id", record.value("eval_id", std::string())},
          {"score", eval_record.value("score", 0.0)},
          {"threshold", eval_record.value("threshold", 0.0)},
          {"passed", eval_record.value("score", 0.0) >= eval_record.value("threshold", 0.0)}}},
    };
    res.status = 200;
    res.set_content(body.dump(), "application/json");
    redis.setex(cache_key, kReadTtlS, body.dump());
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'A team promoted v4 at 09:02 and the deploy dashboard, which polls this endpoint, kept showing v3 as serving until 09:58. A failed eval on v5 showed no eval record at all.',
    'The cache key is `mread:{name}:{v}` with a 3600 s TTL, so nothing about a promotion changes the key or expires the entry; the `if record.get("passed")` branch drops failed evals.',
    'Key the cache `mread:{tenant}:{name}:{v}:{pointer}` from `active:{pool}` with `READ_TTL_S = 5`; attach `eval_record` with `score`, `threshold`, `passed` unconditionally; add `assert_visible` returning 404 for a foreign tenant.',
  ],
  debrief: `The pointer goes into the cache key because a promotion changes the pointer and nothing else about the version, so the key is the cheapest signal that the cached body is stale; the five-second TTL covers the gap for readers that cached before the swap. The eval record is attached regardless of outcome because a failed score is the record an auditor asks for first, and a missing field cannot be told apart from a gate that was skipped. Tenant scoping answers 404 rather than 403 so a foreign tenant cannot enumerate model names. Production registries also serve the promotion history of a version, with who promoted it and which eval opened each gate, and expose an ETag on this read so a poller can short-circuit unchanged responses.`,
};
