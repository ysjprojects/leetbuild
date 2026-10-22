import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis online store with point-in-time semantics',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: values are written to Redis and
read back, and the demo shows the latest number. It is wrong in two ways that only matter when it is
used for training. Find them, fix them, and prove the fix with the checks below.

Implement the online value store behind both handlers:

- \`POST /v1/features/{name}/values\` with body \`{"entity": "e-1", "version": 2, "value": 12.5, "event_ts": 1712345678}\`.
- \`GET /v1/features/{name}/values?entity=e-1&version=2&as_of=1712345678\`.

Requirements:

- Values live under **\`feature:{name}:{version}:{entity}\`**. Both the version and the entity are part
  of the key. The draft's \`feature:{name}:{entity}\` key drops the version, so a version bump reads
  the old value; and a version bump must serve the new keys **without deleting the old ones**, because
  a backfill for a past cutoff still has to read the version that was live then.
- The entry **expires after the definition's freshness SLO** seconds: read
  \`definition:{name}:{version}\` from Redis and use its \`freshness_slo\`, falling back to a small
  default when the definition is unknown. The draft hard-codes one TTL for every feature, which is
  either far too long for a 5-minute feature or uselessly short for a daily one.
- A read is **as-of**: it may only return a value whose \`event_ts\` is **at or before \`as_of\`**. The
  draft reads the key and returns whatever is there, so a value computed *after* the training cutoff
  leaks into the backfill — the offline score that looks too good and the online score that does not.
- The response carries the stored **\`event_ts\`** and an **\`age_s\`** so a consumer can decide whether
  the value is usable, and a missing or too-new value is **404** — never a zero-fill, because a zero
  is indistinguishable from a real zero.

**Failure mode the checks target.** Point-in-time correctness: a value newer than the requested
\`as_of\` must never be returned, no matter how convenient the latest key is to read.

## What to keep

The key namespace, the JSON payload and the write path are fine. The fix is the versioned key, the
SLO-derived TTL and the as-of guard on the read.`,
  sequence: {
    participants: ['Backfill job', 'Feature API', 'Redis'],
    messages: [
      {
        from: 'Backfill job',
        to: 'Feature API',
        label: 'GET /v1/features/amount_7d/values?entity=e-1&version=2&as_of=…',
        kind: 'sync',
      },
      {from: 'Feature API', to: 'Redis', label: 'GET feature:amount_7d:2:e-1', kind: 'sync'},
      {from: 'Redis', to: 'Feature API', label: '{value, event_ts}', kind: 'reply'},
      {
        from: 'Feature API',
        to: 'Feature API',
        label: 'event_ts > as_of → 404, never the newer value',
        kind: 'sync',
      },
      {from: 'Feature API', to: 'Backfill job', label: '200 {value, event_ts, age_s}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'versioned-key',
      title: 'Keys values by (feature, version, entity)',
      detail:
        'The key is `feature:{name}:{version}:{entity}`, so a version bump reads its own values and never deletes the old ones. The draft drops the version and reads the previous version’s entry.',
      match: {
        python: {all: [/f"feature:\{name\}:\{version\}:\{entity\}"/], none: [/\.delete\(/, /\.unlink\(/]},
        typescript: {all: [/feature:\$\{name\}:\$\{version\}:\$\{entity\}/], none: [/\.del\(/, /\.unlink\(/]},
        go: {all: [/feature:%s:%d:%s/], none: [/\.Del\(/, /\.Unlink\(/]},
        scala: {all: [/s"feature:\$name:\$version:\$entity"/], none: [/\.del\(/, /\.unlink\(/]},
        cpp: {
          all: [/feature:"\s*\+\s*name\s*\+\s*":"\s*\+\s*std::to_string\(version\)/],
          none: [/\.del\(/, /\.unlink\(/],
        },
      },
    },
    {
      id: 'slo-ttl',
      title: 'Expires entries at the definition’s freshness SLO',
      detail:
        'The write reads `definition:{name}:{version}` and sets the TTL from its `freshness_slo`. The draft uses one hard-coded TTL for every feature.',
      match: {
        python: {all: [/freshness_slo/, /ex=slo_seconds\(/]},
        typescript: {all: [/freshness_slo/, /'EX'/]},
        go: {all: [/freshness_slo/, /rdb\.Set\(ctx, key/]},
        scala: {all: [/freshness_slo/, /setex\(/]},
        cpp: {all: [/freshness_slo/, /redis\.set\(/]},
      },
    },
    {
      id: 'as-of-guard',
      title: 'Never returns a value newer than as_of',
      detail:
        'The stored `event_ts` is compared with `as_of` and a newer record is refused, so a backfill cannot receive information from after its cutoff. The draft returns the latest value regardless.',
      match: {
        python: {all: [/as_of/, /event_ts/, /event_ts"\]\s*>\s*as_of/]},
        typescript: {all: [/as_of/, /event_ts/, /event_ts\s*>\s*as_of/]},
        go: {all: [/as_of/, /EventTs/, /EventTs\s*>\s*asOf/]},
        scala: {all: [/as_of/, /event_ts/, /event_ts\s*>\s*as_of/]},
        cpp: {all: [/as_of/, /event_ts/, /event_ts\s*>\s*as_of/]},
      },
    },
    {
      id: 'timestamped-miss',
      title: 'Returns the event timestamp, and 404 when there is nothing',
      detail:
        'A hit answers with the stored value and its `event_ts`; a missing or too-new value is **404**. The draft hides the timestamp and returns a null-shaped body.',
      match: {
        python: {all: [/event_ts/, /status_code\s*=\s*404/]},
        typescript: {all: [/event_ts/, /code\(\s*404\s*\)/]},
        go: {all: [/EventTs/, /StatusNotFound/]},
        scala: {all: [/event_ts/, /StatusCodes\.NotFound/]},
        cpp: {all: [/event_ts/, /\b404\b/]},
      },
    },
    {
      id: 'staleness-visible',
      title: 'Reports staleness next to the value',
      detail:
        'The response carries `age_s` computed from `event_ts`, so a consumer can reject a value that is older than the feature’s SLO. The draft returns the value alone.',
      match: {
        python: {all: [/age_s/, /event_ts/]},
        typescript: {all: [/age_s/, /event_ts/]},
        go: {all: [/age_s/, /EventTs/]},
        scala: {all: [/age_s/, /event_ts/]},
        cpp: {all: [/age_s/, /event_ts/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

TTL_S = 3600


class Value(BaseModel):
    entity: str
    version: int
    value: float
    ts: int


@app.post("/v1/features/{name}/values")
def write_value(name: str, body: Value) -> dict:
    # TODO: keep the feature version in the key, derive the TTL from the definition's freshness SLO
    # instead of one constant, and honour as_of on the read so a value computed after the training
    # cutoff can never be served.
    key = f"feature:{name}:{body.entity}"
    r.set(key, json.dumps({"value": body.value, "ts": body.ts}), ex=TTL_S)
    return {"entity": body.entity}


@app.get("/v1/features/{name}/values")
def read_value(name: str, entity: str, version: int, as_of: int | None = None) -> dict:
    record = r.get(f"feature:{name}:{entity}")
    if record is None:
        return {"value": None}
    return json.loads(record)
`,
      solution: `import json
import time

import redis
from fastapi import FastAPI, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

UNKNOWN_DEFINITION_SLO = 60


class Value(BaseModel):
    entity: str
    version: int
    value: float
    event_ts: int


def slo_seconds(name: str, version: int) -> int:
    record = r.get(f"definition:{name}:{version}")
    if record is None:
        return UNKNOWN_DEFINITION_SLO
    return int(json.loads(record)["freshness_slo"])


@app.post("/v1/features/{name}/values")
def write_value(name: str, body: Value) -> JSONResponse:
    key = f"feature:{name}:{body.version}:{body.entity}"
    payload = json.dumps({"value": body.value, "event_ts": body.event_ts})
    r.set(key, payload, ex=slo_seconds(name, body.version))
    return JSONResponse(
        {"entity": body.entity, "version": body.version, "event_ts": body.event_ts}, status_code=201
    )


@app.get("/v1/features/{name}/values")
def read_value(
    name: str, entity: str, version: int, as_of: int = Query(...)
) -> JSONResponse:
    key = f"feature:{name}:{version}:{entity}"
    record = r.get(key)
    if record is None:
        return JSONResponse({"error": "no value"}, status_code=404)
    stored = json.loads(record)
    if stored["event_ts"] > as_of:
        return JSONResponse({"error": "no value as of the requested time"}, status_code=404)
    return JSONResponse(
        {
            "value": stored["value"],
            "event_ts": stored["event_ts"],
            "age_s": int(time.time()) - stored["event_ts"],
        },
        status_code=200,
    )
`,
    },
    typescript: {
      starter: `/** POST|GET /v1/features/:name/values: a model-generated draft that reads the latest key. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const TTL_S = 3600;

interface Value {
  entity: string;
  version: number;
  value: number;
  ts: number;
}

app.post('/v1/features/:name/values', async (request, reply) => {
  const {name} = request.params as {name: string};
  const body = request.body as Value;
  // TODO: keep the feature version in the key, derive the TTL from the definition's freshness SLO
  // instead of one constant, and honour as_of on the read so a value computed after the training
  // cutoff can never be served.
  await r.set(
    \`feature:\${name}:\${body.entity}\`,
    JSON.stringify({value: body.value, ts: body.ts}),
    'EX',
    TTL_S,
  );
  return reply.code(201).send({entity: body.entity});
});

app.get('/v1/features/:name/values', async (request, reply) => {
  const {name} = request.params as {name: string};
  const {entity} = request.query as {entity: string};
  const record = await r.get(\`feature:\${name}:\${entity}\`);
  return reply.code(200).send(record === null ? {value: null} : JSON.parse(record));
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST|GET /v1/features/:name/values: versioned keys and an as-of read for backfills. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const UNKNOWN_DEFINITION_SLO = 60;

interface Value {
  entity: string;
  version: number;
  value: number;
  event_ts: number;
}

async function sloSeconds(name: string, version: number): Promise<number> {
  const definition = await r.get(\`definition:\${name}:\${version}\`);
  if (definition === null) return UNKNOWN_DEFINITION_SLO;
  return Number(JSON.parse(definition).freshness_slo);
}

app.post('/v1/features/:name/values', async (request, reply) => {
  const {name} = request.params as {name: string};
  const body = request.body as Value;
  const key = \`feature:\${name}:\${body.version}:\${body.entity}\`;
  const payload = JSON.stringify({value: body.value, event_ts: body.event_ts});
  await r.set(key, payload, 'EX', await sloSeconds(name, body.version));
  return reply.code(201).send({entity: body.entity, version: body.version, event_ts: body.event_ts});
});

app.get('/v1/features/:name/values', async (request, reply) => {
  const {name} = request.params as {name: string};
  const {entity, version, as_of: as_of_raw} = request.query as {
    entity: string;
    version: string;
    as_of: string;
  };
  const key = \`feature:\${name}:\${version}:\${entity}\`;
  const record = await r.get(key);
  if (record === null) return reply.code(404).send({error: 'no value'});
  const stored = JSON.parse(record) as {value: number; event_ts: number};
  const as_of = Number(as_of_raw);
  if (stored.event_ts > as_of) return reply.code(404).send({error: 'no value as of the requested time'});
  const age_s = Math.floor(Date.now() / 1000) - stored.event_ts;
  return reply.code(200).send({value: stored.value, event_ts: stored.event_ts, age_s});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"
)

const ttlS = 3600

var rdb *redis.Client

func writeValue(rw http.ResponseWriter, r *http.Request) {
	ctx := context.Background()
	name := r.PathValue("name")
	var body map[string]any
	_ = json.NewDecoder(r.Body).Decode(&body)
	// TODO: keep the feature version in the key, derive the TTL from the definition's freshness SLO
	// instead of one constant, and honour as_of on the read so a value computed after the training
	// cutoff can never be served.
	entity, _ := body["entity"].(string)
	payload, _ := json.Marshal(body)
	rdb.Set(ctx, "feature:"+name+":"+entity, payload, ttlS*time.Second)
	rw.WriteHeader(http.StatusCreated)
	_, _ = rw.Write([]byte(\`{"stored":true}\`))
}

func readValue(rw http.ResponseWriter, r *http.Request) {
	ctx := context.Background()
	name := r.PathValue("name")
	entity := r.URL.Query().Get("entity")
	record, err := rdb.Get(ctx, "feature:"+name+":"+entity).Result()
	if err != nil {
		_, _ = rw.Write([]byte(\`{"value":null}\`))
		return
	}
	_, _ = rw.Write([]byte(record))
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/features/{name}/values", writeValue)
	mux.HandleFunc("GET /v1/features/{name}/values", readValue)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

const unknownDefinitionSlo = 60

var rdb *redis.Client

type value struct {
	Entity  string  \`json:"entity"\`
	Version int     \`json:"version"\`
	Value   float64 \`json:"value"\`
	EventTs int64   \`json:"event_ts"\`
}

type storedValue struct {
	Value   float64 \`json:"value"\`
	EventTs int64   \`json:"event_ts"\`
}

func sloSeconds(ctx context.Context, name string, version int) int {
	record, err := rdb.Get(ctx, fmt.Sprintf("definition:%s:%d", name, version)).Result()
	if err != nil {
		return unknownDefinitionSlo
	}
	var definition map[string]any
	if err := json.Unmarshal([]byte(record), &definition); err != nil {
		return unknownDefinitionSlo
	}
	if slo, ok := definition["freshness_slo"].(float64); ok {
		return int(slo)
	}
	return unknownDefinitionSlo
}

func writeValue(rw http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	name := r.PathValue("name")
	var body value
	_ = json.NewDecoder(r.Body).Decode(&body)
	key := fmt.Sprintf("feature:%s:%d:%s", name, body.Version, body.Entity)
	payload, _ := json.Marshal(storedValue{Value: body.Value, EventTs: body.EventTs})
	ttl := time.Duration(sloSeconds(ctx, name, body.Version)) * time.Second
	rdb.Set(ctx, key, payload, ttl)
	rw.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(rw).Encode(map[string]any{"entity": body.Entity, "event_ts": body.EventTs})
}

func readValue(rw http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	name := r.PathValue("name")
	query := r.URL.Query()
	entity := query.Get("entity")
	version, _ := strconv.Atoi(query.Get("version"))
	asOf, _ := strconv.ParseInt(query.Get("as_of"), 10, 64)
	key := fmt.Sprintf("feature:%s:%d:%s", name, version, entity)
	record, err := rdb.Get(ctx, key).Result()
	if err != nil {
		http.Error(rw, \`{"error":"no value"}\`, http.StatusNotFound)
		return
	}
	var stored storedValue
	if err := json.Unmarshal([]byte(record), &stored); err != nil {
		http.Error(rw, \`{"error":"corrupt value"}\`, http.StatusInternalServerError)
		return
	}
	if stored.EventTs > asOf {
		http.Error(rw, \`{"error":"no value as of the requested time"}\`, http.StatusNotFound)
		return
	}
	_ = json.NewEncoder(rw).Encode(map[string]any{
		"value":    stored.Value,
		"event_ts": stored.EventTs,
		"age_s":    time.Now().Unix() - stored.EventTs,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/features/{name}/values", writeValue)
	mux.HandleFunc("GET /v1/features/{name}/values", readValue)
	_ = http.ListenAndServe(":8443", mux)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis

object ValuesApi {
  implicit val system: ActorSystem = ActorSystem("feature-store")
  val TtlSeconds = 3600
  val jedis = new Jedis("redis", 6379)

  val route: Route =
    path("v1" / "features" / Segment / "values") { name =>
      post {
        entity(as[String]) { payload =>
          // TODO: keep the feature version in the key, derive the TTL from the definition's
          // freshness SLO instead of one constant, and honour as_of on the read so a value computed
          // after the training cutoff can never be served.
          jedis.setex(s"feature:$name:body", TtlSeconds, payload)
          complete(StatusCodes.Created, s"""{"stored":true}""")
        }
      } ~
        get {
          parameters("entity") { entity =>
            val record = jedis.get(s"feature:$name:$entity")
            complete(StatusCodes.OK, Option(record).getOrElse("null"))
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
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat
import spray.json._

final case class Value(entity: String, version: Int, value: Double, event_ts: Long)

object ValuesApi {
  implicit val system: ActorSystem = ActorSystem("feature-store")
  implicit val valueFormat: RootJsonFormat[Value] = jsonFormat4(Value)

  val UnknownDefinitionSlo = 60
  val jedis = new Jedis("redis", 6379)

  def sloSeconds(name: String, version: Int): Int = {
    val record = jedis.get(s"definition:$name:$version")
    if (record == null) UnknownDefinitionSlo
    else record.parseJson.asJsObject.fields("freshness_slo").convertTo[Int]
  }

  val route: Route =
    path("v1" / "features" / Segment / "values") { name =>
      post {
        entity(as[Value]) { body =>
          val key = s"feature:$name:\${body.version}:\${body.entity}"
          val payload = s"""{"value":\${body.value},"event_ts":\${body.event_ts}}"""
          jedis.setex(key, sloSeconds(name, body.version), payload)
          complete(StatusCodes.Created, s"""{"entity":"\${body.entity}","event_ts":\${body.event_ts}}""")
        }
      } ~
        get {
          parameters("entity", "version".as[Int], "as_of".as[Long]) { (entity, version, as_of) =>
            val key = s"feature:$name:$version:$entity"
            Option(jedis.get(key)) match {
              case None => complete(StatusCodes.NotFound, s"""{"error":"no value"}""")
              case Some(record) =>
                val stored = record.parseJson.asJsObject
                val event_ts = stored.fields("event_ts").convertTo[Long]
                if (event_ts > as_of)
                  complete(StatusCodes.NotFound, s"""{"error":"no value as of the requested time"}""")
                else {
                  val value = stored.fields("value").convertTo[Double]
                  val age_s = System.currentTimeMillis() / 1000 - event_ts
                  complete(StatusCodes.OK, s"""{"value":$value,"event_ts":$event_ts,"age_s":$age_s}""")
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
#include <sw/redis++/redis++.h>

#include <string>

using json = nlohmann::json;

constexpr long long kTtlSeconds = 3600;

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;

  svr.Post("/v1/features/:name/values", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto name = req.path_params.at("name");
    const json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(json{{"error", "invalid body"}}.dump(), "application/json");
      return;
    }
    // TODO: keep the feature version in the key, derive the TTL from the definition's freshness SLO
    // instead of one constant, and honour as_of on the read so a value computed after the training
    // cutoff can never be served.
    const auto entity = body.value("entity", std::string());
    redis.setex("feature:" + name + ":" + entity, std::chrono::seconds(kTtlSeconds), body.dump());
    res.status = 201;
    res.set_content(json{{"stored", true}}.dump(), "application/json");
  });

  svr.Get("/v1/features/:name/values", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto name = req.path_params.at("name");
    const auto entity = req.get_param_value("entity");
    const auto record = redis.get("feature:" + name + ":" + entity);
    res.set_content(record ? *record : "null", "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>

using json = nlohmann::json;

constexpr int kUnknownDefinitionSlo = 60;

int slo_seconds(sw::redis::Redis& redis, const std::string& name, long long version) {
  const auto record = redis.get("definition:" + name + ":" + std::to_string(version));
  if (!record) return kUnknownDefinitionSlo;
  const auto definition = json::parse(*record, nullptr, false);
  if (!definition.is_object()) return kUnknownDefinitionSlo;
  return definition.value("freshness_slo", kUnknownDefinitionSlo);
}

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;

  svr.Post("/v1/features/:name/values", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto name = req.path_params.at("name");
    const json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(json{{"error", "invalid body"}}.dump(), "application/json");
      return;
    }
    const auto version = body.value("version", 0LL);
    const auto entity = body.value("entity", std::string());
    const auto key = "feature:" + name + ":" + std::to_string(version) + ":" + entity;
    const auto payload =
        json{{"value", body.value("value", 0.0)}, {"event_ts", body.value("event_ts", 0LL)}}.dump();
    redis.set(key, payload, std::chrono::seconds(slo_seconds(redis, name, version)));
    res.status = 201;
    res.set_content(json{{"entity", entity}, {"event_ts", body.value("event_ts", 0LL)}}.dump(),
                    "application/json");
  });

  svr.Get("/v1/features/:name/values", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto name = req.path_params.at("name");
    const auto entity = req.get_param_value("entity");
    const auto version = std::stoll(req.get_param_value("version"));
    const auto as_of = std::stoll(req.get_param_value("as_of"));
    const auto key = "feature:" + name + ":" + std::to_string(version) + ":" + entity;
    const auto record = redis.get(key);
    if (!record) {
      res.status = 404;
      res.set_content(json{{"error", "no value"}}.dump(), "application/json");
      return;
    }
    const auto stored = json::parse(*record, nullptr, false);
    const auto event_ts = stored.value("event_ts", 0LL);
    if (event_ts > as_of) {
      res.status = 404;
      res.set_content(json{{"error", "no value as of the requested time"}}.dump(), "application/json");
      return;
    }
    const auto now = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
    res.status = 200;
    res.set_content(json{{"value", stored.value("value", 0.0)},
                         {"event_ts", event_ts},
                         {"age_s", now - event_ts}}
                        .dump(),
                    "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'The key is a scope, not a label: `feature:{name}:{version}:{entity}`. Dropping the version makes a version bump read the previous version’s value, and deleting old keys on a bump breaks every backfill that re-reads a past window — so write the new keys and leave the old ones to expire on their own SLO.',
    'The TTL is a property of the feature, not of the service: read `definition:{name}:{version}` and use its `freshness_slo`, with a small fallback when the definition is unknown. One hard-coded TTL is either far too long for a five-minute feature or uselessly short for a daily one.',
    'A read is a question about a moment, not about now: compare the stored `event_ts` with `as_of` and refuse anything newer. Return the timestamp and an `age_s` alongside the value so the caller can decide for itself, and answer 404 rather than fabricating a zero.',
  ],
  debrief: `The interview question behind this step is point-in-time correctness, which is the difference between a feature store and a cache. A cache may serve the latest value because the caller only ever asks about now; a feature store is asked about the past, so "latest" is the wrong answer whenever the request carries a cutoff. The subtle bug is that everything still looks correct: the value returned is real, it is just from the future relative to the training window, and a model trained on it scores well offline and badly in production — the classic leak. The version in the key is the other half: without it a bump silently re-points every reader at new values, and with a delete on bump a backfill cannot reproduce last week's training set at all. Real stores keep the event timestamp with the value, materialize into an offline store with the same semantics, and add a watermark so a partition that is not yet complete is never read as final.`,
};
