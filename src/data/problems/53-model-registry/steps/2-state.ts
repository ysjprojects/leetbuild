import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis pointer states with atomic stage transitions',
  concept: 'redis',
  file: 'state',
  focus: ['registry', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/models/{name}/versions/{version}/promote\`: it
\`HSET\`s \`stage = promoted\` on the hash \`version:{name}:{version}\`, stores the pool pointer in
a dict on the \`Registry\` object, and answers \`{"promoted": true, "pool", "version"}\`. The
\`/active\` read answers from that dict. There is no rollback route. It compiles and
hides five flaws.

**Failure mode the checks target.** A promotion that races a rollback and half-applies, and a second
registry instance that reports a different active version than the one that promoted.

- The hash keeps a \`stage\` among \`staged\`, \`canary\`, \`promoted\`, \`rolled_back\`, plus the
  registered \`eval_id\`.
- The pool pointer is the Redis key \`active:{pool}\` holding \`"{name}:{version}"\`. No
  process-local pointer map; \`resolve_active\` reads the pointer with \`r.get\` so every instance
  agrees within a second.
- Promotion runs \`PROMOTE_LUA\` through \`r.eval\`: it swaps the stage and the pointer in one script,
  only from \`staged\` or \`canary\`, and compares the stored \`eval_id\` with the caller's so a
  rolled-back version needs a new eval record before it can serve again.
- Rollback runs \`ROLLBACK_LUA\`: \`stage = rolled_back\` and \`DEL active:{pool}\` in the same
  script.
- Key shapes and stage names stay as they are.`,
  sequence: {
    participants: ['Model Registry', 'Second instance', 'Redis'],
    messages: [
      {from: 'Model Registry', to: 'Redis', label: 'EVAL PROMOTE_LUA version:acme:v3 active:prod', kind: 'sync'},
      {from: 'Redis', to: 'Model Registry', label: 'stage = promoted · pointer = acme:v3', kind: 'reply'},
      {from: 'Second instance', to: 'Redis', label: 'GET active:prod', kind: 'sync'},
      {from: 'Redis', to: 'Second instance', label: 'acme:v3 · same answer within a second', kind: 'reply'},
      {
        from: 'Model Registry',
        to: 'Redis',
        label: 'EVAL ROLLBACK_LUA · stage = rolled_back · DEL active:prod',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Model Registry', label: 'pointer cleared in the same atomic unit', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'atomic-transition',
      title: 'Swaps the stage and the pointer in one atomic script',
      detail:
        'A single Lua `EVAL` (`PROMOTE_LUA`) writes the stage and the pool pointer together. The starter issues two separate round trips, so a promotion racing a rollback can half-apply.',
      match: {
        python: {all: [/PROMOTE_LUA/, /\.eval\(/]},
        typescript: {all: [/PROMOTE_LUA/, /\.eval\(/]},
        go: {all: [/(promoteScript|NewScript)/, /\.Run\(/]},
        scala: {all: [/PromoteLua/, /\.eval\(/]},
        cpp: {all: [/kPromoteLua/, /\.eval</]},
      },
    },
    {
      id: 'shared-pointer',
      title: 'Keeps the active pointer in Redis under active:{pool}',
      detail:
        'The pointer every instance reads lives in Redis at `active:{pool}`. The starter keeps it in a process-local map, so only the instance that promoted the version sees the new pointer.',
      match: {
        python: {all: [/active:\{pool\}/]},
        typescript: {all: [/active:\$\{pool\}/]},
        go: {all: [/active:"\s*\+\s*pool/]},
        scala: {all: [/active:\$pool/]},
        cpp: {all: [/"active:"\s*\+\s*pool/]},
      },
    },
    {
      id: 'no-process-cache',
      title: 'Resolves the active version through Redis',
      detail:
        '`resolve_active` reads the pointer from Redis, so all instances converge within a second. The starter answers from a per-process cache that never expires, so instances disagree indefinitely.',
      match: {
        python: {all: [/resolve_active/, /r\.get\(/], none: [/self\._active|registry\._active/]},
        typescript: {all: [/resolveActive/, /\.get\(/], none: [/processPointers/]},
        go: {all: [/resolveActive/, /\.Get\(/], none: [/processPointers/]},
        scala: {all: [/resolveActive/, /\.get\(/], none: [/processPointers/]},
        cpp: {all: [/resolve_active/, /\.get\(/], none: [/process_pointers/]},
      },
    },
    {
      id: 'rollback-clears',
      title: 'Clears the pointer when a version is rolled back',
      detail:
        'A rollback sets `stage = rolled_back` and deletes `active:{pool}` in the same script. The starter leaves the pointer behind, so a rolled-back version keeps receiving traffic.',
      match: {
        python: {all: [/rolled_back/, /ROLLBACK_LUA/]},
        typescript: {all: [/rolled_back/, /ROLLBACK_LUA/]},
        go: {all: [/rolled_back/, /rollbackScript/]},
        scala: {all: [/rolled_back/, /RollbackLua/]},
        cpp: {all: [/rolled_back/, /kRollbackLua/]},
      },
    },
    {
      id: 'new-eval-gate',
      title: 'Requires a new eval record to re-promote after a rollback',
      detail:
        'The promote script compares the version’s stored `eval_id` with the caller’s and refuses a stale one, and only promotes from `staged` or `canary`. The starter re-promotes a rolled-back version with its old eval.',
      match: {
        python: {all: [/eval_id/, /canary/]},
        typescript: {all: [/eval_id/, /canary/]},
        go: {all: [/eval_id/, /canary/]},
        scala: {all: [/eval_id/, /canary/]},
        cpp: {all: [/eval_id/, /canary/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class PromoteBody(BaseModel):
    name: str
    version: str
    pool: str
    eval_id: str


class Registry:
    def __init__(self) -> None:
        # Pointers are kept in this process so a promotion is fast to read.
        self._active: dict[str, str] = {}


registry = Registry()


@app.post("/v1/models/{name}/versions/{version}/promote")
def promote(name: str, version: str, body: PromoteBody) -> dict:
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    r.hset(f"version:{name}:{version}", "stage", "promoted")
    registry._active[body.pool] = f"{name}:{version}"
    return {"promoted": True, "pool": body.pool, "version": version}


@app.get("/v1/models/{name}/versions/{version}/active")
def active(pool: str) -> dict:
    return {"pool": pool, "version": registry._active[pool]}
`,
      solution: `import redis
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

POINTER_CACHE_MS = 1_000

PROMOTE_LUA = """
local stage = redis.call('HGET', KEYS[1], 'stage')
if stage ~= 'staged' and stage ~= 'canary' then
  return {0, 'bad_stage'}
end
if redis.call('HGET', KEYS[1], 'eval_id') ~= ARGV[1] then
  return {0, 'stale_eval'}
end
redis.call('HSET', KEYS[1], 'stage', 'promoted')
redis.call('SET', KEYS[2], ARGV[2])
return {1, 'ok'}
"""

ROLLBACK_LUA = """
redis.call('HSET', KEYS[1], 'stage', 'rolled_back')
redis.call('DEL', KEYS[2])
return 1
"""


class PromoteBody(BaseModel):
    name: str
    version: str
    pool: str
    eval_id: str


def pointer_key(pool: str) -> str:
    return f"active:{pool}"


def promote(pool: str, name: str, version: str, eval_id: str) -> bool:
    result = r.eval(
        PROMOTE_LUA,
        2,
        f"version:{name}:{version}",
        pointer_key(pool),
        eval_id,
        f"{name}:{version}",
    )
    return result[0] == 1


def rollback(pool: str, name: str, version: str) -> None:
    r.eval(ROLLBACK_LUA, 2, f"version:{name}:{version}", pointer_key(pool))


def resolve_active(pool: str) -> str | None:
    # Read through Redis: the value may be a second old at most, never a process lifetime.
    return r.get(pointer_key(pool))


@app.post("/v1/models/{name}/versions/{version}/promote")
def promote_endpoint(name: str, version: str, body: PromoteBody) -> dict:
    if not promote(body.pool, name, version, body.eval_id):
        return {"promoted": False, "pool": body.pool, "reason": "eval_gate"}
    return {"promoted": True, "pool": body.pool, "name": name, "version": version}


@app.get("/v1/models/{name}/versions/{version}/active")
def active(pool: str) -> dict:
    return {"pool": pool, "version": resolve_active(pool)}
`,
    },
    typescript: {
      starter: `/** Promote: writes the stage and records the pool pointer. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

interface PromoteBody {
  name: string;
  version: string;
  pool: string;
  eval_id: string;
}

const processPointers: Record<string, string> = {};

app.post('/v1/models/:name/versions/:version/promote', async (request, reply) => {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const {name, version} = request.params as {name: string; version: string};
  const body = request.body as PromoteBody;
  await r.hset(\`version:\${name}:\${version}\`, 'stage', 'promoted');
  processPointers[body.pool] = \`\${name}:\${version}\`;
  return reply.code(200).send({promoted: true, pool: body.pool, version});
});

app.get('/v1/models/:name/versions/:version/active', async (request, reply) => {
  const {pool} = request.query as {pool: string};
  return reply.code(200).send({pool, version: processPointers[pool] ?? null});
});
`,
      solution: `/** Promote: one atomic Redis script swaps the stage and the pool pointer. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const POINTER_CACHE_MS = 1_000;

const PROMOTE_LUA = \`
local stage = redis.call('HGET', KEYS[1], 'stage')
if stage ~= 'staged' and stage ~= 'canary' then
  return {0, 'bad_stage'}
end
if redis.call('HGET', KEYS[1], 'eval_id') ~= ARGV[1] then
  return {0, 'stale_eval'}
end
redis.call('HSET', KEYS[1], 'stage', 'promoted')
redis.call('SET', KEYS[2], ARGV[2])
return {1, 'ok'}
\`;

const ROLLBACK_LUA = \`
redis.call('HSET', KEYS[1], 'stage', 'rolled_back')
redis.call('DEL', KEYS[2])
return 1
\`;

interface PromoteBody {
  name: string;
  version: string;
  pool: string;
  eval_id: string;
}

function pointerKey(pool: string): string {
  return \`active:\${pool}\`;
}

export async function promote(pool: string, name: string, version: string, evalId: string): Promise<boolean> {
  const result = (await r.eval(
    PROMOTE_LUA,
    2,
    \`version:\${name}:\${version}\`,
    pointerKey(pool),
    evalId,
    \`\${name}:\${version}\`,
  )) as [number, string];
  return result[0] === 1;
}

export async function rollback(pool: string, name: string, version: string): Promise<void> {
  await r.eval(ROLLBACK_LUA, 2, \`version:\${name}:\${version}\`, pointerKey(pool));
}

export async function resolveActive(pool: string): Promise<string | null> {
  // Read through Redis: the value may be a second old at most, never a process lifetime.
  return r.get(pointerKey(pool));
}

app.post('/v1/models/:name/versions/:version/promote', async (request, reply) => {
  const {name, version} = request.params as {name: string; version: string};
  const body = request.body as PromoteBody;
  const promoted = await promote(body.pool, name, version, body.eval_id);
  return reply.code(200).send({promoted, pool: body.pool, name, version});
});

app.get('/v1/models/:name/versions/:version/active', async (request, reply) => {
  const {pool} = request.query as {pool: string};
  return reply.code(200).send({pool, version: await resolveActive(pool)});
});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/redis/go-redis/v9"
)

var rdb *redis.Client

var processPointers = map[string]string{}

type PromoteBody struct {
	Name    string \`json:"name"\`
	Version string \`json:"version"\`
	Pool    string \`json:"pool"\`
	EvalID  string \`json:"eval_id"\`
}

func promote(rw http.ResponseWriter, r *http.Request) {
	body := PromoteBody{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	rdb.HSet(r.Context(), "version:"+body.Name+":"+body.Version, "stage", "promoted")
	processPointers[body.Pool] = body.Name + ":" + body.Version
	rw.WriteHeader(http.StatusOK)
}

func active(rw http.ResponseWriter, r *http.Request) {
	pool := r.URL.Query().Get("pool")
	json.NewEncoder(rw).Encode(map[string]any{"pool": pool, "version": processPointers[pool]})
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/redis/go-redis/v9"
)

var rdb *redis.Client

const pointerCacheMs = 1000

var promoteScript = redis.NewScript(\`
local stage = redis.call('HGET', KEYS[1], 'stage')
if stage ~= 'staged' and stage ~= 'canary' then
  return {0, 'bad_stage'}
end
if redis.call('HGET', KEYS[1], 'eval_id') ~= ARGV[1] then
  return {0, 'stale_eval'}
end
redis.call('HSET', KEYS[1], 'stage', 'promoted')
redis.call('SET', KEYS[2], ARGV[2])
return {1, 'ok'}
\`)

var rollbackScript = redis.NewScript(\`
redis.call('HSET', KEYS[1], 'stage', 'rolled_back')
redis.call('DEL', KEYS[2])
return 1
\`)

type PromoteBody struct {
	Name    string \`json:"name"\`
	Version string \`json:"version"\`
	Pool    string \`json:"pool"\`
	EvalID  string \`json:"eval_id"\`
}

func pointerKey(pool string) string {
	return "active:" + pool
}

func promote(ctx context.Context, pool, name, version, evalID string) (bool, error) {
	result, err := promoteScript
		.Run(ctx, rdb, []string{"version:" + name + ":" + version, pointerKey(pool)}, evalID, name+":"+version)
		.Slice()
	if err != nil {
		return false, err
	}
	return result[0].(int64) == 1, nil
}

func rollback(ctx context.Context, pool, name, version string) error {
	return rollbackScript.Run(ctx, rdb, []string{"version:" + name + ":" + version, pointerKey(pool)}).Err()
}

func resolveActive(ctx context.Context, pool string) (string, error) {
	return rdb.Get(ctx, pointerKey(pool)).Result()
}

func promoteHandler(rw http.ResponseWriter, r *http.Request) {
	body := PromoteBody{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	ok, err := promote(r.Context(), body.Pool, body.Name, body.Version, body.EvalID)
	if err != nil {
		rw.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	json.NewEncoder(rw).Encode(map[string]any{"promoted": ok, "pool": body.Pool, "version": body.Version})
}

func active(rw http.ResponseWriter, r *http.Request) {
	pool := r.URL.Query().Get("pool")
	version, _ := resolveActive(r.Context(), pool)
	json.NewEncoder(rw).Encode(map[string]any{"pool": pool, "version": version})
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
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class PromoteBody(name: String, version: String, pool: String, eval_id: String)

object RegistryState {
  implicit val system: ActorSystem = ActorSystem("model-registry")
  implicit val promoteFormat: RootJsonFormat[PromoteBody] = jsonFormat4(PromoteBody)

  val jedis = new Jedis("redis", 6379)
  // Pointers are kept in this process so a promotion is fast to read.
  val processPointers = scala.collection.mutable.Map.empty[String, String]

  val route: Route =
    path("v1" / "models" / Segment / "versions" / Segment / "promote") { (name, version) =>
      post {
        entity(as[PromoteBody]) { body =>
          // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
          jedis.hset(s"version:$name:$version", "stage", "promoted")
          processPointers(body.pool) = s"$name:$version"
          complete(StatusCodes.OK, """{"promoted":true}""")
        }
      }
    }
}
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class PromoteBody(name: String, version: String, pool: String, eval_id: String)

object RegistryState {
  implicit val system: ActorSystem = ActorSystem("model-registry")
  implicit val promoteFormat: RootJsonFormat[PromoteBody] = jsonFormat4(PromoteBody)

  val PointerCacheMs = 1000L
  val jedis = new Jedis("redis", 6379)

  val PromoteLua =
    """
      |local stage = redis.call('HGET', KEYS[1], 'stage')
      |if stage ~= 'staged' and stage ~= 'canary' then
      |  return {0, 'bad_stage'}
      |end
      |if redis.call('HGET', KEYS[1], 'eval_id') ~= ARGV[1] then
      |  return {0, 'stale_eval'}
      |end
      |redis.call('HSET', KEYS[1], 'stage', 'promoted')
      |redis.call('SET', KEYS[2], ARGV[2])
      |return {1, 'ok'}
      |""".stripMargin

  val RollbackLua =
    """
      |redis.call('HSET', KEYS[1], 'stage', 'rolled_back')
      |redis.call('DEL', KEYS[2])
      |return 1
      |""".stripMargin

  def pointerKey(pool: String): String = s"active:$pool"

  def promote(pool: String, name: String, version: String, evalId: String): Boolean = {
    val result = jedis
      .eval(PromoteLua, 2, s"version:$name:$version", pointerKey(pool), evalId, s"$name:$version")
      .asInstanceOf[java.util.List[AnyRef]]
    result.get(0).toString == "1"
  }

  def rollback(pool: String, name: String, version: String): Unit =
    jedis.eval(RollbackLua, 2, s"version:$name:$version", pointerKey(pool))

  def resolveActive(pool: String): Option[String] =
    // Read through Redis: the value may be a second old at most, never a process lifetime.
    Option(jedis.get(pointerKey(pool)))

  val route: Route =
    path("v1" / "models" / Segment / "versions" / Segment / "promote") { (name, version) =>
      post {
        entity(as[PromoteBody]) { body =>
          val promoted = promote(body.pool, name, version, body.eval_id)
          complete(StatusCodes.OK, s"""{"promoted":$promoted,"pool":"\${body.pool}","version":"$version"}""")
        }
      }
    }

  val activeRoute: Route =
    path("v1" / "models" / Segment / "versions" / Segment / "active") { (name, version) =>
      get {
        parameter("pool") { pool =>
          complete(
            StatusCodes.OK,
            s"""{"pool":"$pool","version":"\${resolveActive(pool).getOrElse("")}"}"""
          )
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route ~ activeRoute)
  }
}
`,
    },
    cpp: {
      starter: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <map>
#include <string>

using json = nlohmann::json;

std::map<std::string, std::string> process_pointers;

void promote(sw::redis::Redis& redis, const std::string& name, const std::string& version,
             const std::string& pool, const std::string& eval_id) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  redis.hset("version:" + name + ":" + version, "stage", "promoted");
  process_pointers[pool] = name + ":" + version;
}

std::string resolve_active(sw::redis::Redis& redis, const std::string& pool) {
  const auto it = process_pointers.find(pool);
  return it == process_pointers.end() ? std::string() : it->second;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <string>
#include <vector>

constexpr long long kPointerCacheMs = 1000;

const char* kPromoteLua = R"LUA(
local stage = redis.call('HGET', KEYS[1], 'stage')
if stage ~= 'staged' and stage ~= 'canary' then
  return {0, 'bad_stage'}
end
if redis.call('HGET', KEYS[1], 'eval_id') ~= ARGV[1] then
  return {0, 'stale_eval'}
end
redis.call('HSET', KEYS[1], 'stage', 'promoted')
redis.call('SET', KEYS[2], ARGV[2])
return {1, 'ok'}
)LUA";

const char* kRollbackLua = R"LUA(
redis.call('HSET', KEYS[1], 'stage', 'rolled_back')
redis.call('DEL', KEYS[2])
return 1
)LUA";

std::string pointer_key(const std::string& pool) {
  return "active:" + pool;
}

bool promote(sw::redis::Redis& redis, const std::string& pool, const std::string& name,
             const std::string& version, const std::string& eval_id) {
  const auto result = redis.eval<std::vector<long long>>(
      kPromoteLua,
      {"version:" + name + ":" + version, pointer_key(pool)},
      {eval_id, name + ":" + version});
  return result[0] == 1;
}

void rollback(sw::redis::Redis& redis, const std::string& pool, const std::string& name,
              const std::string& version) {
  redis.eval(kRollbackLua, {"version:" + name + ":" + version, pointer_key(pool)}, {});
}

std::string resolve_active(sw::redis::Redis& redis, const std::string& pool) {
  // Read through Redis: the value may be a second old at most, never a process lifetime.
  auto value = redis.get(pointer_key(pool));
  return value ? *value : std::string();
}
`,
    },
  },
  hints: [
    'After a promotion, the instance that handled it reports the new version while the other two instances behind the load balancer still report the old one, and they keep disagreeing an hour later.',
    'The pointer lives in `registry._active`, a dict in one process. Redis holds the stage, so the two writes also leave a window where a rollback can land between them.',
    'Move the pointer to `active:{pool}` and do the swap in `PROMOTE_LUA` via `r.eval`, gated on `staged`/`canary` and a matching `eval_id`; `ROLLBACK_LUA` sets `rolled_back` and deletes the pointer. `resolve_active` reads `r.get`.',
  ],
  debrief: `The transition is one Lua script because Redis runs a script without interleaving other commands, so a rollback either sees the promotion whole or not at all, and the eval-id comparison rides inside the same unit as the state change. The pointer moves to Redis because the pointer is the thing every instance must agree on; a per-process map is correct on one instance and wrong on the rest. Production registries also record who promoted and when, keep a monotonic promotion sequence per pool so a late writer cannot overwrite a newer pointer, and expose the pointer through a read path whose cache key changes with it, which is the subject of the last step.`,
};
