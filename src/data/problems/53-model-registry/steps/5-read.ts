import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/models/{name}/versions/{v}: eval record attached',
  concept: 'http',
  file: 'read',
  focus: ['client', 'registry', 'redis', 'eval', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: a version comes back and the
demo shows the lineage. It hides the two fields that decide a serving decision and it serves any
tenant's model. Review it like the service owner, fix it, and prove the fix with the checks below.

Implement the read endpoint consumers resolve their serving decision through:

- \`GET /v1/models/{name}/versions/{v}\`. The tenant comes from the authenticated
  \`X-Tenant-Id\` header; a missing tenant is **401**.
- The response carries the version, its \`lineage_tag\`, its \`artifact_digest\`, its
  \`pools\` (each with the \`active:{pool}\` pointer it currently resolves to) and the
  \`eval_record\` that opened its gate: \`{eval_id, score, threshold, passed}\`.
- The \`eval_record\` is **always** attached, including when the score is **below** threshold. The
  draft attaches it only when \`passed\` is true, so a consumer cannot tell a gate that was never
  opened from one that was opened and failed.
- A **private model is 404 for a foreign tenant** — the registry is per-tenant and a foreign name
  must be indistinguishable from a missing one. The draft serves any tenant’s private metadata.
- The read is served through a cache keyed on the **active pointer**, with a **short TTL**
  (\`READ_TTL_S = 5\`): a promotion changes the pointer, so the next read misses the stale entry and
  the new version is visible within seconds. The draft caches per version for an hour, so a
  promotion is invisible to consumers for most of an hour.

**Failure mode the checks target.** A read after a promotion must return the new active version, a
foreign tenant must get 404 rather than another tenant's model, and the eval record must be present
even when its score failed — the failures are exactly the records a reviewer needs.

## What to keep

The response shape and the pointer reads are fine. The fix is authorization, the always-present eval
record, and a cache key that follows the promotion.`,
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
        'The eval record is attached unconditionally, not only when `passed` is true. The draft gates it behind `if passed`, so a failing eval vanishes and a reviewer cannot tell the gate was never opened.',
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
        'The eval record carries `score` and `threshold` (and the derived `passed`), so a consumer sees how close a failing eval was. The draft returns nothing when the score was low.',
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
        'The model’s owner is compared with the request tenant and a foreign model answers **404**, indistinguishable from a missing one. The draft serves any tenant’s private metadata.',
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
        'The cache key carries the current `active:{pool}` pointer and the entry expires in 5 seconds, so a promotion invalidates the stale read. The draft caches per version for an hour, hiding promotions.',
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
    # TODO: the draft omits the eval record when its score was below threshold, serves any tenant's
    # private model, and caches per version for an hour. Attach the eval record unconditionally,
    # answer 404 for a foreign tenant, and key the cache on the active:{pool} pointer with a short
    # READ_TTL_S so a promotion is visible within seconds.
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
      starter: `/** GET /v1/models/{name}/versions/{v}: a model-generated draft that caches for an hour. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

import {models} from './registry';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const CACHE_TTL_S = 3600;

app.get('/v1/models/:name/versions/:v', async (request, reply) => {
  // TODO: the draft omits the eval record when its score was below threshold, serves any tenant's
  // private model, and caches per version for an hour. Attach the eval record unconditionally,
  // answer 404 for a foreign tenant, and key the cache on the active:{pool} pointer with a short
  // READ_TTL_S so a promotion is visible within seconds.
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
	// TODO: the draft omits the eval record when its score was below threshold, serves any tenant's
	// private model, and caches per version for an hour. Attach the eval record unconditionally,
	// answer 404 for a foreign tenant, and key the cache on the active:{pool} pointer with a short
	// readTTLS so a promotion is visible within seconds.
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
        // TODO: the draft omits the eval record when its score was below threshold, serves any
        // tenant's private model, and caches per version for an hour. Attach the eval record
        // unconditionally, answer 404 for a foreign tenant, and key the cache on the
        // active:{pool} pointer with a short ReadTtlS so a promotion is visible within seconds.
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
    // TODO: the draft omits the eval record when its score was below threshold, serves any
    // tenant's private model, and caches per version for an hour. Attach the eval record
    // unconditionally, answer 404 for a foreign tenant, and key the cache on the active:{pool}
    // pointer with a short kReadTtlS so a promotion is visible within seconds.
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
    'Attach the eval record unconditionally — a score below threshold is the record a reviewer most needs. The draft’s `if passed` gate is what turns a failed eval into a missing one, and a consumer cannot tell a gate that never opened from one that opened and failed.',
    'Authorize the read exactly like the write: compare `record.owner_tenant` with the request tenant before a single key is read, and answer `404` so a foreign model is indistinguishable from a missing one.',
    'Put the active pointer in the cache key and keep the TTL short. `mread:{tenant}:{name}:{v}:{pointer}` changes the moment a promotion swaps `active:{pool}`, so the next read misses the stale entry and the new version is visible within `READ_TTL_S` seconds — not within an hour.',
  ],
  debrief: `The interview question behind this step is whether the read path tells the truth. Two fields decide a serving decision and the draft hides both: the eval record disappears whenever it failed, and the active pointer is missing entirely, so a consumer cannot see which version a pool is actually serving. The cache is the subtle one: an hourly TTL keyed per version makes a promotion invisible for most of an hour, which is long enough for a fleet to look healthy while half of it serves the old bytes. Keying the cache on the pointer and a five-second TTL makes the promotion visible within seconds. Real registries add an immutable view per version, a signed lineage document, and a read that returns the promotion history so a consumer can reconstruct why a version is serving.`,
};
