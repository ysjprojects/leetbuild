import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/models/{name}/versions/{v}: the eval record, attached',
  concept: 'http',
  guides: ['honest-reads', 'request-boundaries', 'model-output'],
  file: 'read',
  focus: ['client', 'registry', 'redis', 'eval', 'db'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/models/{name}/versions/{version}\` with
\`X-Tenant-Id\` (401 when missing): it answers from the Redis cache \`mread:{name}:{version}\` when it
can, else builds the version row from \`store.version\` with \`pools\`, the pools whose
\`active:{pool}\` names it (\`pointer.resolve_active\`), adds \`eval_record\` when the score passed, and
caches the body for \`CACHE_TTL_S\` = 3600 s. It serves the demo and hides three flaws.

**Failure mode the checks target.** A reader cannot tell a failed eval from a missing one; any tenant
reads another tenant's private model; and for an hour after a promotion the read says the version
serves nowhere.

- \`eval_record\` is always attached: \`{eval_id, score, threshold, passed}\`, with
  \`passed = score >= threshold\`.
- The model's \`owner\` and \`visibility\` come from \`store.model\`: another tenant reads only a
  \`public\` model; any other model of another tenant answers **404**, the same as a missing one,
  before any cache is read.
- The cache key carries the pools, \`mread:{name}:{version}:{pools joined by ","}\`, and the entry lives
  \`READ_TTL_S\` = 5 s.`,
  sequence: {
    participants: ['Client', 'registryd', 'Redis', 'registry.store'],
    messages: [
      {from: 'Client', to: 'registryd', label: 'GET /v1/models/fraud/versions/2 · X-Tenant-Id', kind: 'sync'},
      {
        from: 'registryd',
        to: 'registry.store',
        label: 'model(fraud): owner, visibility → 404 for others',
        kind: 'sync',
      },
      {from: 'registryd', to: 'Redis', label: 'GET active:prod · active:canary', kind: 'sync'},
      {from: 'registryd', to: 'Redis', label: 'GET mread:fraud:2:prod', kind: 'sync'},
      {from: 'registryd', to: 'registry.store', label: 'version · eval_record (failed too)', kind: 'sync'},
      {from: 'registryd', to: 'Redis', label: 'SET mread:fraud:2:prod EX 5', kind: 'sync'},
      {
        from: 'registryd',
        to: 'Client',
        label: '200 {version, pools, eval_record {score, threshold, passed}}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route-read',
      title: 'Serves GET /v1/models/{name}/versions/{version}',
      detail:
        'Register the version read; it answers the version row with its pools and its eval record, and 404 for a version that does not exist.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/models\/\{name\}\/versions\/\{version\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/models\/:name\/versions\/:version['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/models\/\{name\}\/versions\/\{version\}"/]},
        scala: {all: [/"v1"\s*\/\s*"models"\s*\/\s*Segment\s*\/\s*"versions"/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/models\/[^\n]*\/versions\//]},
      },
    },
    {
      id: 'eval-always',
      title: 'Attaches the eval record with its threshold, failed or not',
      detail:
        '`eval_record` is `{eval_id, score, threshold, passed}` with `passed` computed from the score and the threshold (a score equal to the threshold passes), attached whether the eval passed or not; the starter drops a failed one.',
      match: {
        python: {all: [/["']threshold["']\s*:/, /["']passed["']\s*:[^\n]*>=/]},
        typescript: {all: [/threshold:/, /passed:[^\n]*>=/]},
        go: {all: [/"threshold":/, /"passed":[^\n]*>=/]},
        scala: {all: [/"threshold"\s*->/, /"passed"\s*->[^\n]*>=/]},
        cpp: {all: [/\{"threshold",/, /\{"passed",[^\n]*>=/]},
      },
    },
    {
      id: 'tenant-404',
      title: "Another tenant's private model is a 404",
      detail:
        "The model's `owner` and `visibility` are checked against the tenant before the cache: another tenant's model answers **404**, indistinguishable from a missing one, unless its visibility is `public`.",
      match: {
        python: {all: [/store\.model\(/, /owner/, /visibility/]},
        typescript: {all: [/\bmodel\(/, /owner/, /visibility/]},
        go: {all: [/store\.Model\(/, /\.Owner/, /\.Visibility/]},
        scala: {all: [/Store\.model\(/, /owner/, /visibility/]},
        cpp: {all: [/store::model\(/, /owner/, /visibility/]},
      },
    },
    {
      id: 'fresh-promotion',
      title: 'The cache sees a promotion within seconds',
      detail:
        'The cache key carries the pools the version serves in and the entry is written with `READ_TTL_S` (5 s) in the same command, so a promotion changes the key at once; the starter keys by version alone for an hour.',
      match: {
        python: {all: [/READ_TTL_S\s*=\s*5\b/, /ex\s*=\s*READ_TTL_S/, /join\(\s*pools\s*\)/], none: [/3600/]},
        typescript: {all: [/READ_TTL_S\s*=\s*5\b/, /['"]EX['"],\s*READ_TTL_S/, /pools\.join\(/], none: [/3600/]},
        go: {
          all: [/readTTL\s*=\s*5\s*\*\s*time\.Second/, /\.Set\([^\n]*readTTL\)/, /strings\.Join\(\s*pools/],
          none: [/3600|time\.Hour/],
        },
        scala: {all: [/ReadTtlSeconds\s*=\s*5L?\b/, /setex\([^\n]*ReadTtlSeconds/, /pools\.mkString/], none: [/3600/]},
        cpp: {all: [/kReadTtl\{5\}/, /redis\.set\([^\n]*kReadTtl\)/, /pools_key/], none: [/3600/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from registry import pointer, store  # store.model, version, eval_record, POOLS; pointer.resolve_active

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

CACHE_TTL_S = 3600


def active_pools(name: str, version: int) -> list[str]:
    """The pools whose pointer names this version."""
    ref = f"{name}:{version}"
    return [pool for pool in store.POOLS if pointer.resolve_active(pool) == ref]


@app.get("/v1/models/{name}/versions/{version}")
def read_version(name: str, version: int, request: Request) -> JSONResponse:
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    key = f"mread:{name}:{version}"
    cached = r.get(key)
    if cached is not None:
        return JSONResponse(json.loads(cached))
    row = store.version(name, version)
    if row is None:
        raise HTTPException(status_code=404, detail="no such model version")
    body = {**row, "pools": active_pools(name, version)}
    record = store.eval_record(row["eval_id"])
    if record is not None and record["score"] >= record["threshold"]:
        body["eval_record"] = {"eval_id": record["eval_id"], "score": record["score"], "passed": True}
    r.set(key, json.dumps(body), ex=CACHE_TTL_S)
    return JSONResponse(body)
`,
      solution: `import json

import redis
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from registry import pointer, store  # store.model, version, eval_record, POOLS; pointer.resolve_active

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

READ_TTL_S = 5


def active_pools(name: str, version: int) -> list[str]:
    """The pools whose pointer names this version."""
    ref = f"{name}:{version}"
    return [pool for pool in store.POOLS if pointer.resolve_active(pool) == ref]


def eval_view(eval_id: str) -> dict | None:
    """The eval record as a reader needs it, failed or not: the score, the bar it was held to, the verdict."""
    record = store.eval_record(eval_id)
    if record is None:
        return None
    return {"eval_id": eval_id, "score": record["score"], "threshold": record["threshold"], "passed": record["score"] >= record["threshold"]}


@app.get("/v1/models/{name}/versions/{version}")
def read_version(name: str, version: int, request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    model = store.model(name)
    # Another tenant's private model reads exactly like a missing one, and is checked before any cache.
    if model is None or (model["visibility"] != "public" and model["owner"] != tenant):
        raise HTTPException(status_code=404, detail="no such model version")
    pools = active_pools(name, version)
    # Keyed on where the version serves now: a promotion changes the key, the TTL bounds the rest.
    key = f"mread:{name}:{version}:{','.join(pools)}"
    cached = r.get(key)
    if cached is not None:
        return JSONResponse(json.loads(cached))
    row = store.version(name, version)
    if row is None:
        raise HTTPException(status_code=404, detail="no such model version")
    body = {**row, "pools": pools, "eval_record": eval_view(row["eval_id"])}
    r.set(key, json.dumps(body), ex=READ_TTL_S)
    return JSONResponse(body)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';
import Redis from 'ioredis';

import {resolveActive} from 'registry/pointer';
import {POOLS, evalRecord, model, version} from 'registry/store';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

export const CACHE_TTL_S = 3600;

/** The pools whose pointer names this version. */
async function activePools(name: string, n: number): Promise<string[]> {
  const pools: string[] = [];
  for (const pool of POOLS) if ((await resolveActive(pool)) === \`\${name}:\${n}\`) pools.push(pool);
  return pools;
}

app.get('/v1/models/:name/versions/:version', async (request, reply) => {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const params = request.params as {name: string; version: string};
  const n = Number(params.version);
  const key = \`mread:\${params.name}:\${n}\`;
  const cached = await redis.get(key);
  if (cached !== null) return JSON.parse(cached);
  const row = await version(params.name, n);
  if (row === null) return reply.code(404).send({error: 'no such model version'});
  const body: Record<string, unknown> = {...row, pools: await activePools(params.name, n)};
  const record = await evalRecord(row.eval_id);
  if (record !== null && record.score >= record.threshold) body.eval_record = {eval_id: record.eval_id, score: record.score, passed: true};
  await redis.set(key, JSON.stringify(body), 'EX', CACHE_TTL_S);
  return body;
});
`,
      solution: `import Fastify from 'fastify';
import Redis from 'ioredis';

import {resolveActive} from 'registry/pointer';
import {POOLS, evalRecord, model, version} from 'registry/store';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

export const READ_TTL_S = 5;

/** The pools whose pointer names this version. */
async function activePools(name: string, n: number): Promise<string[]> {
  const pools: string[] = [];
  for (const pool of POOLS) if ((await resolveActive(pool)) === \`\${name}:\${n}\`) pools.push(pool);
  return pools;
}

/** The eval record as a reader needs it, failed or not: the score, the bar it was held to, the verdict. */
async function evalView(evalId: string): Promise<Record<string, unknown> | null> {
  const record = await evalRecord(evalId);
  if (record === null) return null;
  return {eval_id: evalId, score: record.score, threshold: record.threshold, passed: record.score >= record.threshold};
}

app.get('/v1/models/:name/versions/:version', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const params = request.params as {name: string; version: string};
  const n = Number(params.version);
  const found = await model(params.name);
  // Another tenant's private model reads exactly like a missing one, and is checked before any cache.
  if (found === null || (found.visibility !== 'public' && found.owner !== tenant)) {
    return reply.code(404).send({error: 'no such model version'});
  }
  const pools = await activePools(params.name, n);
  // Keyed on where the version serves now: a promotion changes the key, the TTL bounds the rest.
  const key = \`mread:\${params.name}:\${n}:\${pools.join(',')}\`;
  const cached = await redis.get(key);
  if (cached !== null) return JSON.parse(cached);
  const row = await version(params.name, n);
  if (row === null) return reply.code(404).send({error: 'no such model version'});
  const body = {...row, pools, eval_record: await evalView(row.eval_id)};
  await redis.set(key, JSON.stringify(body), 'EX', READ_TTL_S);
  return body;
});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"

	"registry/pointer" // pointer.ResolveActive(ctx, pool) (string, error)
	"registry/store"   // store.Model, Version, EvalRecord, Pools
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const cacheTTL = 3600 * time.Second

// activePools are the pools whose pointer names this version.
func activePools(ctx context.Context, name string, version int) ([]string, error) {
	pools := []string{}
	for _, pool := range store.Pools {
		ref, err := pointer.ResolveActive(ctx, pool)
		if err != nil {
			return nil, err
		}
		if ref == fmt.Sprintf("%s:%d", name, version) {
			pools = append(pools, pool)
		}
	}
	return pools, nil
}

func readVersion(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	if r.Header.Get("X-Tenant-Id") == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	name := r.PathValue("name")
	version, _ := strconv.Atoi(r.PathValue("version"))
	key := fmt.Sprintf("mread:%s:%d", name, version)
	rw.Header().Set("Content-Type", "application/json")
	if cached, err := rdb.Get(r.Context(), key).Result(); err == nil {
		rw.Write([]byte(cached))
		return
	}
	row := store.Version(r.Context(), name, version)
	if row == nil {
		http.Error(rw, "no such model version", http.StatusNotFound)
		return
	}
	pools, err := activePools(r.Context(), name, version)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	body := map[string]any{
		"name": row.Name, "version": row.Version, "artifact_digest": row.ArtifactDigest, "training_run_id": row.TrainingRunID,
		"eval_id": row.EvalID, "stage": row.Stage, "pools": pools,
	}
	if record := store.EvalRecord(r.Context(), row.EvalID); record != nil && record.Score >= record.Threshold {
		body["eval_record"] = map[string]any{"eval_id": record.EvalID, "score": record.Score, "passed": true}
	}
	raw, _ := json.Marshal(body)
	rdb.Set(r.Context(), key, raw, cacheTTL)
	rw.Write(raw)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/models/{name}/versions/{version}", readVersion)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"registry/pointer" // pointer.ResolveActive(ctx, pool) (string, error)
	"registry/store"   // store.Model, Version, EvalRecord, Pools
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const readTTL = 5 * time.Second

// activePools are the pools whose pointer names this version.
func activePools(ctx context.Context, name string, version int) ([]string, error) {
	pools := []string{}
	for _, pool := range store.Pools {
		ref, err := pointer.ResolveActive(ctx, pool)
		if err != nil {
			return nil, err
		}
		if ref == fmt.Sprintf("%s:%d", name, version) {
			pools = append(pools, pool)
		}
	}
	return pools, nil
}

// evalView is the eval record as a reader needs it, failed or not: the score, the bar it was held to, the verdict.
func evalView(ctx context.Context, evalID string) any {
	record := store.EvalRecord(ctx, evalID)
	if record == nil {
		return nil
	}
	return map[string]any{"eval_id": evalID, "score": record.Score, "threshold": record.Threshold, "passed": record.Score >= record.Threshold}
}

func readVersion(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	name := r.PathValue("name")
	version, _ := strconv.Atoi(r.PathValue("version"))
	// Another tenant's private model reads exactly like a missing one, and is checked before any cache.
	if m := store.Model(r.Context(), name); m == nil || (m.Visibility != "public" && m.Owner != tenant) {
		http.Error(rw, "no such model version", http.StatusNotFound)
		return
	}
	pools, err := activePools(r.Context(), name, version)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	// Keyed on where the version serves now: a promotion changes the key, the TTL bounds the rest.
	key := fmt.Sprintf("mread:%s:%d:%s", name, version, strings.Join(pools, ","))
	rw.Header().Set("Content-Type", "application/json")
	if cached, err := rdb.Get(r.Context(), key).Result(); err == nil {
		rw.Write([]byte(cached))
		return
	}
	row := store.Version(r.Context(), name, version)
	if row == nil {
		http.Error(rw, "no such model version", http.StatusNotFound)
		return
	}
	body := map[string]any{
		"name": row.Name, "version": row.Version, "artifact_digest": row.ArtifactDigest, "training_run_id": row.TrainingRunID,
		"eval_id": row.EvalID, "stage": row.Stage, "pools": pools, "eval_record": evalView(r.Context(), row.EvalID),
	}
	raw, _ := json.Marshal(body)
	rdb.Set(r.Context(), key, raw, readTTL)
	rw.Write(raw)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/models/{name}/versions/{version}", readVersion)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import spray.json._

import registry.{Pointer, Store} // Store.model, version, evalRecord, Pools, rowJson; Pointer.resolveActive

object Read {
  val CacheTtlSeconds = 3600L
  val jedis = new JedisPooled("redis", 6379)

  /** The pools whose pointer names this version. */
  def activePools(name: String, version: Long): Seq[String] = Store.Pools.filter(pool => Pointer.resolveActive(pool).contains(s"$name:$version"))

  private def render(name: String, version: Long): Option[String] =
    Store.version(name, version).map { row =>
      val record = Store.evalRecord(row.evalId).filter(r => r.score >= r.threshold)
      val evalRecord = record.map(r => "eval_record" -> JsObject("eval_id" -> JsString(r.evalId), "score" -> JsNumber(r.score), "passed" -> JsBoolean(true)))
      val pools = "pools" -> JsArray(activePools(name, version).map(JsString(_)).toVector)
      JsObject(Store.rowJson(row).fields + pools ++ evalRecord).compactPrint
    }

  val route: Route =
    path("v1" / "models" / Segment / "versions" / LongNumber) { (name, version) =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") {
          case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
          case Some(_) =>
            // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
            val key = s"mread:$name:$version"
            Option(jedis.get(key)).orElse(render(name, version).map { body => jedis.setex(key, CacheTtlSeconds, body); body }) match {
              case None => complete(StatusCodes.NotFound -> "no such model version")
              case Some(body) => complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body)))
            }
        }
      }
    }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import spray.json._

import registry.{Pointer, Store} // Store.model, version, evalRecord, Pools, rowJson; Pointer.resolveActive

object Read {
  val ReadTtlSeconds = 5L
  val jedis = new JedisPooled("redis", 6379)

  /** The pools whose pointer names this version. */
  def activePools(name: String, version: Long): Seq[String] = Store.Pools.filter(pool => Pointer.resolveActive(pool).contains(s"$name:$version"))

  /** The eval record as a reader needs it, failed or not: the score, the bar it was held to, the verdict. */
  def evalView(evalId: String): JsValue =
    Store.evalRecord(evalId).map { r =>
      JsObject("eval_id" -> JsString(evalId), "score" -> JsNumber(r.score), "threshold" -> JsNumber(r.threshold),
        "passed" -> JsBoolean(r.score >= r.threshold))
    }.getOrElse(JsNull)

  private def render(name: String, version: Long, pools: Seq[String]): Option[String] =
    Store.version(name, version).map { row =>
      val extra = Map("pools" -> JsArray(pools.map(JsString(_)).toVector), "eval_record" -> evalView(row.evalId))
      JsObject(Store.rowJson(row).fields ++ extra).compactPrint
    }

  val route: Route =
    path("v1" / "models" / Segment / "versions" / LongNumber) { (name, version) =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") {
          case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
          case Some(tenant) =>
            // Another tenant's private model reads exactly like a missing one, and is checked before any cache.
            val visible = Store.model(name).exists(m => m.visibility == "public" || m.owner == tenant)
            val pools = activePools(name, version)
            // Keyed on where the version serves now: a promotion changes the key, the TTL bounds the rest.
            val key = s"mread:$name:$version:\${pools.mkString(",")}"
            val body =
              if (!visible) None
              else Option(jedis.get(key)).orElse(render(name, version, pools).map { b => jedis.setex(key, ReadTtlSeconds, b); b })
            body match {
              case None => complete(StatusCodes.NotFound -> "no such model version")
              case Some(b) => complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, b)))
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
#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>
#include <vector>

#include "registry/pointer.h"  // pointer::resolveActive(pool) -> std::optional<std::string>
#include "registry/store.h"    // store::model, version, evalRecord, kPools, rowJson

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

constexpr std::chrono::seconds kCacheTtl{3600};

// The pools whose pointer names this version.
std::vector<std::string> activePools(const std::string& name, long version) {
  std::vector<std::string> pools;
  for (const auto& pool : store::kPools) {
    if (pointer::resolveActive(pool).value_or("") == name + ":" + std::to_string(version)) pools.push_back(pool);
  }
  return pools;
}

void read_version(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  if (req.get_header_value("X-Tenant-Id").empty()) {
    res.status = 401;
    res.set_content("X-Tenant-Id is required", "text/plain");
    return;
  }
  const std::string name = req.matches[1];
  const long version = std::stol(req.matches[2]);
  const std::string key = "mread:" + name + ":" + std::to_string(version);
  if (const auto cached = redis.get(key)) {
    res.set_content(*cached, "application/json");
    return;
  }
  const auto row = store::version(name, version);
  if (!row) {
    res.status = 404;
    res.set_content("no such model version", "text/plain");
    return;
  }
  json body = store::rowJson(*row);
  body["pools"] = activePools(name, version);
  const auto record = store::evalRecord(row->eval_id);
  if (record && record->score >= record->threshold) body["eval_record"] = {{"eval_id", record->eval_id}, {"score", record->score}, {"passed", true}};
  redis.set(key, body.dump(), kCacheTtl);
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Get(R"(/v1/models/([\\w-]+)/versions/(\\d+))", read_version);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>
#include <vector>

#include "registry/pointer.h"  // pointer::resolveActive(pool) -> std::optional<std::string>
#include "registry/store.h"    // store::model, version, evalRecord, kPools, rowJson

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

constexpr std::chrono::seconds kReadTtl{5};

// The pools whose pointer names this version.
std::vector<std::string> activePools(const std::string& name, long version) {
  std::vector<std::string> pools;
  for (const auto& pool : store::kPools) {
    if (pointer::resolveActive(pool).value_or("") == name + ":" + std::to_string(version)) pools.push_back(pool);
  }
  return pools;
}

// The eval record as a reader needs it, failed or not: the score, the bar it was held to, the verdict.
json evalView(const std::string& eval_id) {
  const auto record = store::evalRecord(eval_id);
  if (!record) return nullptr;
  return json{{"eval_id", eval_id}, {"score", record->score}, {"threshold", record->threshold}, {"passed", record->score >= record->threshold}};
}

void read_version(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content("X-Tenant-Id is required", "text/plain");
    return;
  }
  const std::string name = req.matches[1];
  const long version = std::stol(req.matches[2]);
  // Another tenant's private model reads exactly like a missing one, and is checked before any cache.
  const auto model = store::model(name);
  if (!model || (model->visibility != "public" && model->owner != tenant)) {
    res.status = 404;
    res.set_content("no such model version", "text/plain");
    return;
  }
  const std::vector<std::string> pools = activePools(name, version);
  std::string pools_key;
  for (const auto& pool : pools) pools_key += (pools_key.empty() ? "" : ",") + pool;
  // Keyed on where the version serves now: a promotion changes the key, the TTL bounds the rest.
  const std::string key = "mread:" + name + ":" + std::to_string(version) + ":" + pools_key;
  if (const auto cached = redis.get(key)) {
    res.set_content(*cached, "application/json");
    return;
  }
  const auto row = store::version(name, version);
  if (!row) {
    res.status = 404;
    res.set_content("no such model version", "text/plain");
    return;
  }
  json body = store::rowJson(*row);
  body["pools"] = pools;
  body["eval_record"] = evalView(row->eval_id);
  redis.set(key, body.dump(), kReadTtl);
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Get(R"(/v1/models/([\\w-]+)/versions/(\\d+))", read_version);
}
`,
    },
  },
  harness: {
    python: `from registry import pointer, store


def _api(ctx):
    m = ctx.load("read")
    store.create_model("fraud", "t1")
    store.create_model("embed", "t1", "public")
    store.add_eval("e-1", "fraud", "sha256:a1", 0.91, 0.85, "precision 0.91 on holdout-2026-10")
    store.add_eval("e-2", "fraud", "sha256:a2", 0.71, 0.8, "precision 0.71 on holdout-2026-10")
    store.add_eval("e-embed", "embed", "sha256:e1", 0.95, 0.9, "recall@10 0.95")
    store.register_version("t1", "fraud", "sha256:a1", "r-1", "e-1")
    store.register_version("t1", "fraud", "sha256:a2", "r-2", "e-2")
    store.register_version("t1", "embed", "sha256:e1", "r-e", "e-embed")
    return ctx.client(m.app)


async def _get(c, name, version, tenant="t1"):
    return await c.get(f"/v1/models/{name}/versions/{version}", headers={"X-Tenant-Id": tenant} if tenant else {})


async def check_route_read(ctx):
    async with _api(ctx) as c:
        r = await _get(c, "fraud", 1)
        assert r.status_code == 200, f"GET /v1/models/fraud/versions/1 answered {r.status_code}: {r.text}"
        body = r.json()
        assert body.get("name") == "fraud" and body.get("version") == 1 and body.get("artifact_digest") == "sha256:a1" and body.get("stage") == "staged", f"the read answered {body}"
        assert body.get("pools") == [], f"fraud version 1 serves no pool yet, the read says {body.get('pools')}"
        assert (body.get("eval_record") or {}).get("eval_id") == "e-1", f"the read must carry the eval record e-1, got {body.get('eval_record')}"
        missing = await _get(c, "fraud", 9)
        assert missing.status_code == 404, f"a version that does not exist answered {missing.status_code}, expected 404"
        anonymous = await _get(c, "fraud", 1, tenant="")
    assert anonymous.status_code == 401, f"a read without X-Tenant-Id answered {anonymous.status_code}, expected 401"


async def check_eval_always(ctx):
    async with _api(ctx) as c:
        store.add_eval("e-3", "fraud", "sha256:a3", 0.85, 0.85, "precision 0.85 on holdout-2026-10")
        store.register_version("t1", "fraud", "sha256:a3", "r-3", "e-3")
        failed = (await _get(c, "fraud", 2)).json().get("eval_record")
        passed = (await _get(c, "fraud", 1)).json().get("eval_record")
        level = (await _get(c, "fraud", 3)).json().get("eval_record")
    assert failed == {"eval_id": "e-2", "score": 0.71, "threshold": 0.8, "passed": False}, f"fraud version 2 failed its eval (0.71 against 0.8) and the read carries eval_record {failed}: a failed gate must read as failed, with its threshold"
    assert passed == {"eval_id": "e-1", "score": 0.91, "threshold": 0.85, "passed": True}, f"fraud version 1 passed its eval and the read carries eval_record {passed}, expected score, threshold and passed"
    assert level == {"eval_id": "e-3", "score": 0.85, "threshold": 0.85, "passed": True}, f"fraud version 3 scored exactly its threshold (0.85 against 0.85) and the read carries eval_record {level}: a score that meets the bar passes"


async def check_tenant_404(ctx):
    async with _api(ctx) as c:
        own = await _get(c, "fraud", 1)
        assert own.status_code == 200, f"the owner's read answered {own.status_code}: {own.text}"
        foreign = await _get(c, "fraud", 1, tenant="t2")
        assert foreign.status_code == 404, f"tenant t2 read t1's private model and got {foreign.status_code}: {foreign.text}. It must be a 404, like a missing model"
        assert "sha256:a1" not in foreign.text, f"the refusal leaks the version: {foreign.text}"
        nothing = await _get(c, "nosuch", 1, tenant="t2")
        assert nothing.status_code == 404, f"a model that does not exist answered {nothing.status_code}"
        public = await _get(c, "embed", 1, tenant="t2")
        assert public.status_code == 200 and public.json().get("name") == "embed", f"a public model must be readable by every tenant, t2 got {public.status_code} {public.text}"
        store.create_model("ranker", "t1", "internal")
        store.add_eval("e-rank", "ranker", "sha256:r1", 0.9, 0.8, "ndcg 0.9")
        store.register_version("t1", "ranker", "sha256:r1", "r-rank", "e-rank")
        internal = await _get(c, "ranker", 1, tenant="t2")
    assert internal.status_code == 404, f"tenant t2 read t1's model ranker, visibility internal, and got {internal.status_code}: only a public model is readable by another tenant"


async def check_fresh_promotion(ctx):
    async with _api(ctx) as c:
        before = (await _get(c, "fraud", 1)).json()
        assert before.get("pools") == [], f"before the promotion the read says pools {before.get('pools')}"
        assert pointer.promote("fraud", 1, "prod", "e-1") is True, "the promotion of fraud version 1 must move active:prod"
        # The TTL right after the cache entry is written: an entry set without one lives forever if the process dies before a second command.
        key, ttls = "mread:fraud:1:prod", []

        def watch():
            ttl = ctx.redis.ttl(key)
            if ttl == -2:
                ctx.redis_after(key, watch)  # only read so far: wait for the write
            else:
                ttls.append(ttl)

        ctx.redis_after(key, watch)
        after = (await _get(c, "fraud", 1)).json()
    assert after.get("pools") == ["prod"] and after.get("stage") == "promoted", f"right after the promotion the read answers pools {after.get('pools')} and stage {after.get('stage')}: the cache hides the promotion. Key it on the pools"
    assert ttls, f"the read after the promotion never cached its body under {key}"
    assert 0 < ttls[0] <= 5, f"{key} was written with TTL {ttls[0]}: the entry must carry READ_TTL_S = 5 from the command that writes it"
    for key in ctx.redis.keys("mread:*"):
        ttl = ctx.redis.ttl(key)
        assert 0 < ttl <= 5, f"{key} lives {ttl} s: a cached read must expire within READ_TTL_S = 5"
`,
    typescript: `async function api(ctx) {
  const m = ctx.load('read');
  const store = ctx.load('/support/registry/store.ts');
  const pointer = ctx.load('/support/registry/pointer.ts');
  await store.createModel('fraud', 't1');
  await store.createModel('embed', 't1', 'public');
  await store.addEval('e-1', 'fraud', 'sha256:a1', 0.91, 0.85, 'precision 0.91 on holdout-2026-10');
  await store.addEval('e-2', 'fraud', 'sha256:a2', 0.71, 0.8, 'precision 0.71 on holdout-2026-10');
  await store.addEval('e-embed', 'embed', 'sha256:e1', 0.95, 0.9, 'recall@10 0.95');
  await store.registerVersion('t1', 'fraud', 'sha256:a1', 'r-1', 'e-1');
  await store.registerVersion('t1', 'fraud', 'sha256:a2', 'r-2', 'e-2');
  await store.registerVersion('t1', 'embed', 'sha256:e1', 'r-e', 'e-embed');
  return {c: ctx.client(m.app), pointer, store};
}

const get = (c, name: string, version: number, tenant = 't1') =>
  c.get(\`/v1/models/\${name}/versions/\${version}\`, {headers: tenant ? {'X-Tenant-Id': tenant} : {}});

export async function check_route_read(ctx) {
  const {c} = await api(ctx);
  const r = await get(c, 'fraud', 1);
  assert.equal(r.status, 200, \`GET /v1/models/fraud/versions/1 answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.name === 'fraud' && body.version === 1 && body.artifact_digest === 'sha256:a1' && body.stage === 'staged', \`the read answered \${r.text}\`);
  assert.deepEqual(body.pools, [], \`fraud version 1 serves no pool yet, the read says \${JSON.stringify(body.pools)}\`);
  assert.equal(body.eval_record?.eval_id, 'e-1', \`the read must carry the eval record e-1, got \${JSON.stringify(body.eval_record)}\`);
  const missing = await get(c, 'fraud', 9);
  assert.equal(missing.status, 404, \`a version that does not exist answered \${missing.status}, expected 404\`);
  const anonymous = await get(c, 'fraud', 1, '');
  assert.equal(anonymous.status, 401, \`a read without X-Tenant-Id answered \${anonymous.status}, expected 401\`);
}

export async function check_eval_always(ctx) {
  const {c, store} = await api(ctx);
  await store.addEval('e-3', 'fraud', 'sha256:a3', 0.85, 0.85, 'precision 0.85 on holdout-2026-10');
  await store.registerVersion('t1', 'fraud', 'sha256:a3', 'r-3', 'e-3');
  const failed = (await get(c, 'fraud', 2)).json().eval_record;
  const passed = (await get(c, 'fraud', 1)).json().eval_record;
  const level = (await get(c, 'fraud', 3)).json().eval_record;
  assert.deepStrictEqual(failed, {eval_id: 'e-2', score: 0.71, threshold: 0.8, passed: false}, \`fraud version 2 failed its eval (0.71 against 0.8) and the read carries eval_record \${JSON.stringify(failed)}: a failed gate must read as failed, with its threshold\`);
  assert.deepStrictEqual(passed, {eval_id: 'e-1', score: 0.91, threshold: 0.85, passed: true}, \`fraud version 1 passed its eval and the read carries eval_record \${JSON.stringify(passed)}, expected score, threshold and passed\`);
  assert.deepStrictEqual(level, {eval_id: 'e-3', score: 0.85, threshold: 0.85, passed: true}, \`fraud version 3 scored exactly its threshold (0.85 against 0.85) and the read carries eval_record \${JSON.stringify(level)}: a score that meets the bar passes\`);
}

export async function check_tenant_404(ctx) {
  const {c, store} = await api(ctx);
  const own = await get(c, 'fraud', 1);
  assert.equal(own.status, 200, \`the owner's read answered \${own.status}: \${own.text}\`);
  const foreign = await get(c, 'fraud', 1, 't2');
  assert.equal(foreign.status, 404, \`tenant t2 read t1's private model and got \${foreign.status}: \${foreign.text}. It must be a 404, like a missing model\`);
  assert(!foreign.text.includes('sha256:a1'), \`the refusal leaks the version: \${foreign.text}\`);
  const nothing = await get(c, 'nosuch', 1, 't2');
  assert.equal(nothing.status, 404, \`a model that does not exist answered \${nothing.status}\`);
  const pub = await get(c, 'embed', 1, 't2');
  assert(pub.status === 200 && pub.json().name === 'embed', \`a public model must be readable by every tenant, t2 got \${pub.status} \${pub.text}\`);
  await store.createModel('ranker', 't1', 'internal');
  await store.addEval('e-rank', 'ranker', 'sha256:r1', 0.9, 0.8, 'ndcg 0.9');
  await store.registerVersion('t1', 'ranker', 'sha256:r1', 'r-rank', 'e-rank');
  const internal = await get(c, 'ranker', 1, 't2');
  assert.equal(internal.status, 404, \`tenant t2 read t1's model ranker, visibility internal, and got \${internal.status}: only a public model is readable by another tenant\`);
}

export async function check_fresh_promotion(ctx) {
  const {c, pointer} = await api(ctx);
  const before = (await get(c, 'fraud', 1)).json();
  assert.deepEqual(before.pools, [], \`before the promotion the read says pools \${JSON.stringify(before.pools)}\`);
  assert.equal(await pointer.promote('fraud', 1, 'prod', 'e-1'), true, 'the promotion of fraud version 1 must move active:prod');
  // The TTL right after the cache entry is written: an entry set without one lives forever if the process dies before a second command.
  const entry = 'mread:fraud:1:prod';
  const ttls: number[] = [];
  const watch = () => {
    const ttl = ctx.redis.ttl(entry);
    if (ttl === -2) ctx.redisAfter(entry, watch); // only read so far: wait for the write
    else ttls.push(ttl);
  };
  ctx.redisAfter(entry, watch);
  const after = (await get(c, 'fraud', 1)).json();
  assert(JSON.stringify(after.pools) === '["prod"]' && after.stage === 'promoted', \`right after the promotion the read answers pools \${JSON.stringify(after.pools)} and stage \${after.stage}: the cache hides the promotion. Key it on the pools\`);
  assert(ttls.length > 0, \`the read after the promotion never cached its body under \${entry}\`);
  assert(0 < ttls[0] && ttls[0] <= 5, \`\${entry} was written with TTL \${ttls[0]}: the entry must carry READ_TTL_S = 5 from the command that writes it\`);
  for (const key of ctx.redis.keys('mread:*')) {
    const ttl = ctx.redis.ttl(key);
    assert(0 < ttl && ttl <= 5, \`\${key} lives \${ttl} s: a cached read must expire within READ_TTL_S = 5\`);
  }
}
`,
    go: `package main

import (
	"context"
	"net/http"

	"registry/pointer"
	"registry/store"

	"leetbuild/harness"
)

var hBg = context.Background()

func hReadAPI(ctx *harness.Ctx) *harness.HTTP {
	store.CreateModel(hBg, "fraud", "t1", "private")
	store.CreateModel(hBg, "embed", "t1", "public")
	store.AddEval(hBg, "e-1", "fraud", "sha256:a1", 0.91, 0.85, "precision 0.91 on holdout-2026-10")
	store.AddEval(hBg, "e-2", "fraud", "sha256:a2", 0.71, 0.8, "precision 0.71 on holdout-2026-10")
	store.AddEval(hBg, "e-embed", "embed", "sha256:e1", 0.95, 0.9, "recall@10 0.95")
	store.RegisterVersion(hBg, "t1", "fraud", "sha256:a1", "r-1", "e-1")
	store.RegisterVersion(hBg, "t1", "fraud", "sha256:a2", "r-2", "e-2")
	store.RegisterVersion(hBg, "t1", "embed", "sha256:e1", "r-e", "e-embed")
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

type hVersionView struct {
	Name           string         \`json:"name"\`
	Version        int            \`json:"version"\`
	ArtifactDigest string         \`json:"artifact_digest"\`
	Stage          string         \`json:"stage"\`
	Pools          []string       \`json:"pools"\`
	EvalRecord     map[string]any \`json:"eval_record"\`
}

func hRead(c *harness.HTTP, name, version, tenant string) (*harness.Response, hVersionView) {
	var r *harness.Response
	if tenant == "" {
		r = c.Get("/v1/models/" + name + "/versions/" + version)
	} else {
		r = c.Get("/v1/models/"+name+"/versions/"+version, "X-Tenant-Id", tenant)
	}
	var v hVersionView
	if r.Status == 200 {
		r.Decode(&v)
	}
	return r, v
}

func CheckRouteRead(ctx *harness.Ctx) {
	c := hReadAPI(ctx)
	r, v := hRead(c, "fraud", "1", "t1")
	ctx.Equal(r.Status, 200, "GET /v1/models/fraud/versions/1 (%s)", r.Text())
	ctx.Assert(v.Name == "fraud" && v.Version == 1 && v.ArtifactDigest == "sha256:a1" && v.Stage == "staged", "the read answered %s", r.Text())
	ctx.Equal(len(v.Pools), 0, "fraud version 1 serves no pool yet; the pools in %s", r.Text())
	ctx.Equal(v.EvalRecord["eval_id"], "e-1", "the read must carry the eval record e-1 (%s)", r.Text())
	missing, _ := hRead(c, "fraud", "9", "t1")
	ctx.Equal(missing.Status, 404, "a version that does not exist")
	anonymous, _ := hRead(c, "fraud", "1", "")
	ctx.Equal(anonymous.Status, 401, "a read without X-Tenant-Id")
}

func CheckEvalAlways(ctx *harness.Ctx) {
	c := hReadAPI(ctx)
	store.AddEval(hBg, "e-3", "fraud", "sha256:a3", 0.85, 0.85, "precision 0.85 on holdout-2026-10")
	store.RegisterVersion(hBg, "t1", "fraud", "sha256:a3", "r-3", "e-3")
	_, failed := hRead(c, "fraud", "2", "t1")
	_, passed := hRead(c, "fraud", "1", "t1")
	_, level := hRead(c, "fraud", "3", "t1")
	ctx.Equal(failed.EvalRecord, map[string]any{"eval_id": "e-2", "score": 0.71, "threshold": 0.8, "passed": false}, "fraud version 2 failed its eval (0.71 against 0.8): a failed gate must read as failed, with its threshold; eval_record")
	ctx.Equal(passed.EvalRecord, map[string]any{"eval_id": "e-1", "score": 0.91, "threshold": 0.85, "passed": true}, "fraud version 1 passed its eval; eval_record")
	ctx.Equal(level.EvalRecord, map[string]any{"eval_id": "e-3", "score": 0.85, "threshold": 0.85, "passed": true}, "fraud version 3 scored exactly its threshold (0.85 against 0.85): a score that meets the bar passes; eval_record")
}

func CheckTenant404(ctx *harness.Ctx) {
	c := hReadAPI(ctx)
	own, _ := hRead(c, "fraud", "1", "t1")
	ctx.Equal(own.Status, 200, "the owner's read (%s)", own.Text())
	foreign, _ := hRead(c, "fraud", "1", "t2")
	ctx.Equal(foreign.Status, 404, "tenant t2 read t1's private model (%s): it must be a 404, like a missing model", foreign.Text())
	nothing, _ := hRead(c, "nosuch", "1", "t2")
	ctx.Equal(nothing.Status, 404, "a model that does not exist")
	public, v := hRead(c, "embed", "1", "t2")
	ctx.Assert(public.Status == 200 && v.Name == "embed", "a public model must be readable by every tenant, t2 got %d %s", public.Status, public.Text())
	store.CreateModel(hBg, "ranker", "t1", "internal")
	store.AddEval(hBg, "e-rank", "ranker", "sha256:r1", 0.9, 0.8, "ndcg 0.9")
	store.RegisterVersion(hBg, "t1", "ranker", "sha256:r1", "r-rank", "e-rank")
	internal, _ := hRead(c, "ranker", "1", "t2")
	ctx.Equal(internal.Status, 404, "tenant t2 read t1's model ranker, visibility internal (%s): only a public model is readable by another tenant", internal.Text())
}

func CheckFreshPromotion(ctx *harness.Ctx) {
	c := hReadAPI(ctx)
	_, before := hRead(c, "fraud", "1", "t1")
	ctx.Equal(len(before.Pools), 0, "before the promotion; the pools")
	moved, err := pointer.Promote(hBg, "fraud", 1, "prod", "e-1")
	ctx.Assert(err == nil && moved, "the promotion of fraud version 1 must move active:prod (%v)", err)
	// The TTL right after the cache entry is written: an entry set without one lives forever if the process dies before a second command.
	const entry = "mread:fraud:1:prod"
	var ttls []int64
	var watch func() any
	watch = func() any {
		if ttl := ctx.Redis.TTL(entry); ttl == -2 {
			ctx.Redis.After(entry, watch) // only read so far: wait for the write
		} else {
			ttls = append(ttls, ttl)
		}
		return nil
	}
	ctx.Redis.After(entry, watch)
	r, after := hRead(c, "fraud", "1", "t1")
	ctx.Assert(len(after.Pools) == 1 && after.Pools[0] == "prod" && after.Stage == "promoted", "right after the promotion the read answers %s: the cache hides the promotion. Key it on the pools", r.Text())
	ctx.Assert(len(ttls) > 0, "the read after the promotion never cached its body under %s", entry)
	ctx.Assert(len(ttls) > 0 && 0 < ttls[0] && ttls[0] <= 5, "%s was written with TTL %v: the entry must carry a 5 s TTL from the command that writes it", entry, ttls)
	for _, key := range ctx.Redis.Keys("mread:*") {
		ttl := ctx.Redis.TTL(key)
		ctx.Assert(0 < ttl && ttl <= 5, "%s lives %d s: a cached read must expire within 5 s", key, ttl)
	}
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <functional>
#include <string>
#include <vector>

namespace {

harness::HTTP hReadApi(harness::Ctx& ctx) {
  store::createModel("fraud", "t1");
  store::createModel("embed", "t1", "public");
  store::addEval("e-1", "fraud", "sha256:a1", 0.91, 0.85, "precision 0.91 on holdout-2026-10");
  store::addEval("e-2", "fraud", "sha256:a2", 0.71, 0.8, "precision 0.71 on holdout-2026-10");
  store::addEval("e-embed", "embed", "sha256:e1", 0.95, 0.9, "recall@10 0.95");
  store::registerVersion("t1", "fraud", "sha256:a1", "r-1", "e-1");
  store::registerVersion("t1", "fraud", "sha256:a2", "r-2", "e-2");
  store::registerVersion("t1", "embed", "sha256:e1", "r-e", "e-embed");
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response hGet(harness::HTTP& c, const std::string& name, long version, const std::string& tenant = "t1") {
  const std::string path = "/v1/models/" + name + "/versions/" + std::to_string(version);
  return tenant.empty() ? c.Get(path) : c.Get(path, "X-Tenant-Id", tenant);
}

nlohmann::json hBody(const harness::Response& r) {
  const auto j = nlohmann::json::parse(r.Text(), nullptr, false);
  return j.is_object() ? j : nlohmann::json::object();
}

}  // namespace

void CheckRouteRead(harness::Ctx& ctx) {
  auto c = hReadApi(ctx);
  const auto r = hGet(c, "fraud", 1);
  ctx.Equal(r.Status, 200, "GET /v1/models/fraud/versions/1 (%s)", r.Text());
  const auto b = hBody(r);
  ctx.Assert(b.value("name", "") == "fraud" && b.value("version", 0L) == 1 && b.value("artifact_digest", "") == "sha256:a1" && b.value("stage", "") == "staged",
             "the read answered %s", r.Text());
  ctx.Equal(b.value("pools", nlohmann::json::array()), nlohmann::json::array(), "fraud version 1 serves no pool yet; the pools");
  ctx.Assert(b.contains("eval_record") && b["eval_record"].is_object() && b["eval_record"].value("eval_id", "") == "e-1", "the read must carry the eval record e-1, got %s", r.Text());
  ctx.Equal(hGet(c, "fraud", 9).Status, 404, "a version that does not exist");
  ctx.Equal(hGet(c, "fraud", 1, "").Status, 401, "a read without X-Tenant-Id");
}

void CheckEvalAlways(harness::Ctx& ctx) {
  auto c = hReadApi(ctx);
  store::addEval("e-3", "fraud", "sha256:a3", 0.85, 0.85, "precision 0.85 on holdout-2026-10");
  store::registerVersion("t1", "fraud", "sha256:a3", "r-3", "e-3");
  const auto failed = hBody(hGet(c, "fraud", 2)).value("eval_record", nlohmann::json());
  const auto passed = hBody(hGet(c, "fraud", 1)).value("eval_record", nlohmann::json());
  const auto level = hBody(hGet(c, "fraud", 3)).value("eval_record", nlohmann::json());
  ctx.Equal(failed, nlohmann::json{{"eval_id", "e-2"}, {"score", 0.71}, {"threshold", 0.8}, {"passed", false}},
            "fraud version 2 failed its eval (0.71 against 0.8): a failed gate must read as failed, with its threshold; eval_record");
  ctx.Equal(passed, nlohmann::json{{"eval_id", "e-1"}, {"score", 0.91}, {"threshold", 0.85}, {"passed", true}}, "fraud version 1 passed its eval; eval_record");
  ctx.Equal(level, nlohmann::json{{"eval_id", "e-3"}, {"score", 0.85}, {"threshold", 0.85}, {"passed", true}},
            "fraud version 3 scored exactly its threshold (0.85 against 0.85): a score that meets the bar passes; eval_record");
}

void CheckTenant404(harness::Ctx& ctx) {
  auto c = hReadApi(ctx);
  const auto own = hGet(c, "fraud", 1);
  ctx.Equal(own.Status, 200, "the owner's read (%s)", own.Text());
  const auto foreign = hGet(c, "fraud", 1, "t2");
  ctx.Equal(foreign.Status, 404, "tenant t2 read t1's private model (%s): it must be a 404, like a missing model", foreign.Text());
  ctx.Assert(foreign.Text().find("sha256:a1") == std::string::npos, "the refusal leaks the version: %s", foreign.Text());
  ctx.Equal(hGet(c, "nosuch", 1, "t2").Status, 404, "a model that does not exist");
  const auto pub = hGet(c, "embed", 1, "t2");
  ctx.Assert(pub.Status == 200 && hBody(pub).value("name", "") == "embed", "a public model must be readable by every tenant, t2 got %d %s", pub.Status, pub.Text());
  store::createModel("ranker", "t1", "internal");
  store::addEval("e-rank", "ranker", "sha256:r1", 0.9, 0.8, "ndcg 0.9");
  store::registerVersion("t1", "ranker", "sha256:r1", "r-rank", "e-rank");
  const auto internal = hGet(c, "ranker", 1, "t2");
  ctx.Equal(internal.Status, 404, "tenant t2 read t1's model ranker, visibility internal (%s): only a public model is readable by another tenant", internal.Text());
}

void CheckFreshPromotion(harness::Ctx& ctx) {
  auto c = hReadApi(ctx);
  ctx.Equal(hBody(hGet(c, "fraud", 1)).value("pools", nlohmann::json::array()), nlohmann::json::array(), "before the promotion; the pools");
  ctx.Equal(pointer::promote("fraud", 1, "prod", "e-1"), true, "the promotion of fraud version 1 must move active:prod; moved");
  // The TTL right after the cache entry is written: an entry set without one lives forever if the process dies before a second command.
  const std::string entry = "mread:fraud:1:prod";
  std::vector<long long> ttls;
  std::function<void()> watch = [&] {
    const long long ttl = ctx.Redis.TTL(entry);
    if (ttl == -2) {
      ctx.Redis.After(entry, watch);  // only read so far: wait for the write
    } else {
      ttls.push_back(ttl);
    }
  };
  ctx.Redis.After(entry, watch);
  const auto r = hGet(c, "fraud", 1);
  const auto after = hBody(r);
  ctx.Assert(after.value("pools", nlohmann::json::array()) == nlohmann::json::array({"prod"}) && after.value("stage", "") == "promoted",
             "right after the promotion the read answers %s: the cache hides the promotion. Key it on the pools", r.Text());
  ctx.Assert(!ttls.empty(), "the read after the promotion never cached its body under %s", entry);
  const long long written = ttls.empty() ? -2 : ttls.front();
  ctx.Assert(0 < written && written <= 5, "%s was written with TTL %d: the entry must carry kReadTtl = 5 s from the command that writes it", entry, written);
  for (const auto& key : ctx.Redis.Keys("mread:*")) {
    const long long ttl = ctx.Redis.TTL(key);
    ctx.Assert(0 < ttl && ttl <= 5, "%s lives %d s: a cached read must expire within kReadTtl = 5 s", key, ttl);
  }
}
`,
  },
  hints: [
    "Read a version whose eval failed: no eval record at all. Read t1's private model as t2: it answers. Promote a version and read it again: it serves nowhere, for an hour.",
    "The eval record is attached only behind `score >= threshold`, nothing reads the model's owner, and the cache key names the version only, so a pointer move does not change it and the entry lives 3600 s.",
    'Attach `{eval_id, score, threshold, passed: score >= threshold}` always; 404 unless the model is public or `owner == tenant`, before the cache; key `mread:{name}:{version}:{",".join(pools)}` with `ex=READ_TTL_S` (5).',
  ],
  debrief: `A failed eval is information: the threshold next to the score says how far off the version was and that the gate was actually run, so the record is attached whatever the verdict. The tenant check comes before the cache because a cache keyed without the tenant would otherwise serve one tenant's answer to another, and 404 rather than 403 keeps a private model's existence private. Putting the pools in the cache key makes a promotion a cache miss by construction, and the five-second TTL bounds what the key does not cover, such as a rollback of an idle version. Production registries invalidate on the pointer-change event, cache the immutable parts (the row and the eval) for longer than the serving state, and log reads of private models for audit.`,
};
