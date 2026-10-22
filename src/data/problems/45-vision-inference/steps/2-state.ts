import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis GPU admission tokens per tenant',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'state', 'worker'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: a tenant with room left gets a
token and the happy path works. Two failures hide under it — an admission race and a leak — and
neither shows up in a serial demo. Find them, fix them, and prove the fix.

Implement the per-tenant **GPU admission pool** that decides how many inferences may run at once.

- Each tenant holds \`GPU_TOKENS_PER_TENANT = 10\` concurrent inference tokens in Redis:
  \`gpu:tokens:{tenant}\` counts the tokens still available and \`gpu:holders:{tenant}\` is the hash of
  the tickets currently holding one.
- Admission is **one atomic Lua \`EVAL\`**: read the counter, reject when it is empty, decrement when
  it is not, and record the ticket in the same call. A client-side \`GET\` followed by \`DECR\` lets a
  burst read the same room twice and over-admits past the GPU's capacity.
- The TTL (\`TOKEN_TTL_S\`) is set **at first write, inside the script** (\`SET key value EX ttl\`).
  Tokens heat the pool back up on their own: a worker that dies holding a token never releases it,
  and without an expiry the pool leaks until someone restarts Redis.
- Admission returns a **lock id**; release runs through \`RELEASE_LUA\`, which decrements only when the
  caller still holds that ticket (\`HDEL\` returns 1). A late release from a retried worker must not
  hand out a token that already expired and went to someone else.
- When the pool is empty answer **429** with \`Retry-After\` (seconds) and **do not queue** the request:
  the caller backs off instead of the service growing an unbounded work queue.

**Failure mode the checks target.** A check-then-decrement pair is correct in a serial test and
over-admits the moment two requests arrive together; a token with no TTL and no owner-checked release
leaks one slot per crashed worker until the pool is permanently empty.`,
  sequence: {
    participants: ['Vision API', 'Redis', 'Inference worker'],
    messages: [
      {from: 'Vision API', to: 'Redis', label: 'EVAL admit · KEYS[gpu:tokens:acme] · lock id', kind: 'sync'},
      {from: 'Redis', to: 'Vision API', label: '{1, 9, 900} admitted · {0, 0, 900} full', kind: 'reply'},
      {from: 'Vision API', to: 'Inference worker', label: 'dispatch only after admission', kind: 'sync'},
      {from: 'Inference worker', to: 'Inference worker', label: 'result lock held for the inference', kind: 'sync'},
      {from: 'Inference worker', to: 'Redis', label: 'EVAL release · HDEL holder · INCR tokens', kind: 'async'},
      {from: 'Vision API', to: 'Vision API', label: '429 + Retry-After when the pool is empty', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'atomic',
      title: 'Admits with one atomic Lua script',
      detail:
        'The read, the rejection and the decrement happen inside a single `EVAL`/`NewScript` call. The draft reads the counter with `GET` and decrements it afterwards, so two concurrent admissions both observe the same room and the pool over-admits.',
      match: {
        python: {all: [/ADMIT_LUA/, /\.eval\(/, /DECR/, /GET/]},
        typescript: {all: [/ADMIT_LUA/, /\.eval\(/, /DECR/, /GET/]},
        go: {all: [/NewScript\(/, /\.Run\(/, /DECR/, /GET/]},
        scala: {all: [/AdmitLua/, /\.eval\(/, /DECR/, /GET/]},
        cpp: {all: [/kAdmitLua/, /\.eval</, /DECR/, /GET/]},
      },
    },
    {
      id: 'ttl',
      title: 'Sets the token TTL at first write',
      detail:
        'The script creates the counter with `SET … EX TOKEN_TTL_S`, so the tokens a crashed worker never released expire back into the pool. The draft never sets an expiry, so one crashed worker removes a slot until Redis restarts.',
      match: {
        python: {all: [/TOKEN_TTL_S/, /'EX'/]},
        typescript: {all: [/TOKEN_TTL_S/, /'EX'/]},
        go: {all: [/tokenTTLSeconds/, /'EX'/]},
        scala: {all: [/TokenTtlSeconds/, /'EX'/]},
        cpp: {all: [/kTokenTtlSeconds/, /'EX'/]},
      },
    },
    {
      id: 'release',
      title: 'Releases only for the worker holding the ticket',
      detail:
        'Release runs through a second script that removes the ticket with `HDEL` and increments the counter only when the caller still held it. The draft never releases at all, and an unguarded `INCR` would hand a token to whoever replays a stale lock id.',
      match: {
        python: {all: [/RELEASE_LUA/, /HDEL/, /lock_id/]},
        typescript: {all: [/RELEASE_LUA/, /HDEL/, /lockId/]},
        go: {all: [/releaseScript/, /HDEL/, /lockID/]},
        scala: {all: [/ReleaseLua/, /HDEL/, /lockId/]},
        cpp: {all: [/kReleaseLua/, /HDEL/, /lockId/]},
      },
    },
    {
      id: 'guard',
      title: 'Refuses to hand out a token that is not there',
      detail:
        'The script returns a rejection tuple when the counter has run out instead of decrementing below zero. The draft checks in Python and then decrements, so the counter can go negative and the pool admits more than the GPU can take.',
      match: {
        python: {all: [/left\s*<=\s*0/, /return\s*\{\s*0/]},
        typescript: {all: [/left\s*<=\s*0/, /return\s*\{\s*0/]},
        go: {all: [/left\s*<=\s*0/, /return\s*\{\s*0/]},
        scala: {all: [/left\s*<=\s*0/, /return\s*\{\s*0/]},
        cpp: {all: [/left\s*<=\s*0/, /return\s*\{\s*0/]},
      },
    },
    {
      id: 'full-pool',
      title: 'Answers 429 with Retry-After instead of queueing',
      detail:
        'An exhausted pool returns **429** with `Retry-After` in seconds; the request is refused immediately and no work is buffered behind it.',
      match: {
        python: {all: [/Retry-After/, /status_code\s*=\s*429/]},
        typescript: {all: [/Retry-After/, /code\(\s*429\s*\)/]},
        go: {all: [/Retry-After/, /StatusTooManyRequests/]},
        scala: {all: [/Retry-After/, /StatusCodes\.TooManyRequests/]},
        cpp: {all: [/Retry-After/, /\b429\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""GPU admission tokens: a model-generated draft that checks and then decrements."""
import redis
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

GPU_TOKENS_PER_TENANT = 10


class InferenceRequest(BaseModel):
    image: str
    task: str = "classify"


def admit(tenant: str) -> bool:
    # TODO: this draft reads the counter and decrements it in two round trips, so a burst
    # over-admits, and it never releases a token when a worker dies — the pool leaks until Redis
    # restarts. Move both into scripts. Review all of it.
    left = int(r.get(f"gpu:tokens:{tenant}") or GPU_TOKENS_PER_TENANT)
    if left <= 0:
        return False
    r.decr(f"gpu:tokens:{tenant}")
    return True


@app.post("/v1/inferences")
def create_inference(body: InferenceRequest, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    if not admit(tenant):
        raise HTTPException(
            status_code=429,
            detail="gpu pool is full for this tenant",
            headers={"Retry-After": "5"},
        )
    return JSONResponse({"id": "inf-1", "tenant": tenant, "task": body.task}, status_code=200)
`,
      solution: `"""GPU admission tokens: one atomic Lua acquire with a TTL, released by the ticket's owner."""
import uuid

import redis
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

GPU_TOKENS_PER_TENANT = 10
TOKEN_TTL_S = 15 * 60

# KEYS[1] = gpu:tokens:{tenant}   KEYS[2] = gpu:holders:{tenant}
# ARGV[1] = capacity   ARGV[2] = lock id   ARGV[3] = token TTL seconds
ADMIT_LUA = """
local left = tonumber(redis.call('GET', KEYS[1]))
if left == nil then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
  left = tonumber(ARGV[1])
end
if left <= 0 then
  return {0, 0, redis.call('TTL', KEYS[1])}
end
redis.call('DECR', KEYS[1])
redis.call('HSET', KEYS[2], ARGV[2], 1)
redis.call('EXPIRE', KEYS[2], ARGV[3])
return {1, left - 1, redis.call('TTL', KEYS[1])}
"""

# Give the token back only when the caller still holds the ticket it was issued with.
RELEASE_LUA = """
if redis.call('HDEL', KEYS[2], ARGV[1]) == 1 then
  redis.call('INCR', KEYS[1])
  return 1
end
return 0
"""


class InferenceRequest(BaseModel):
    image: str
    task: str = "classify"


def admit(tenant: str, lock_id: str) -> tuple[bool, int, int]:
    ok, left, ttl = r.eval(
        ADMIT_LUA,
        2,
        f"gpu:tokens:{tenant}",
        f"gpu:holders:{tenant}",
        GPU_TOKENS_PER_TENANT,
        lock_id,
        TOKEN_TTL_S,
    )
    return bool(ok), int(left), int(ttl)


def release(tenant: str, lock_id: str) -> None:
    r.eval(RELEASE_LUA, 2, f"gpu:tokens:{tenant}", f"gpu:holders:{tenant}", lock_id)


@app.post("/v1/inferences")
def create_inference(body: InferenceRequest, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    lock_id = str(uuid.uuid4())
    ok, left, ttl = admit(tenant, lock_id)
    if not ok:
        raise HTTPException(
            status_code=429,
            detail="gpu pool is full for this tenant",
            headers={"Retry-After": str(max(ttl, 1)), "X-GPU-Tokens-Remaining": str(left)},
        )
    try:
        result = {"id": lock_id, "tenant": tenant, "task": body.task}
    finally:
        # The worker holding the result lock is the only one that may give the token back.
        release(tenant, lock_id)
    return JSONResponse(result, status_code=200)
`,
    },
    typescript: {
      starter: `/** GPU admission tokens: a model-generated draft that checks and then decrements. */
import Fastify from 'fastify';
import Redis from 'ioredis';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

const GPU_TOKENS_PER_TENANT = 10;

async function admit(tenant: string): Promise<boolean> {
  // TODO: this draft reads the counter and decrements it in two round trips, so a burst
  // over-admits, and it never releases a token when a worker dies — the pool leaks until Redis
  // restarts. Move both into scripts. Review all of it.
  const raw = await redis.get(\`gpu:tokens:\${tenant}\`);
  const left = raw === null ? GPU_TOKENS_PER_TENANT : Number(raw);
  if (left <= 0) return false;
  await redis.decr(\`gpu:tokens:\${tenant}\`);
  return true;
}

app.post('/v1/inferences', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  if (!(await admit(tenant)))
    return reply.code(429).header('Retry-After', '5').send({error: 'gpu pool is full for this tenant'});
  return reply.code(200).send({id: 'inf-1', tenant});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GPU admission tokens: one atomic Lua acquire with a TTL, released by the ticket's owner. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';
import Redis from 'ioredis';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

const GPU_TOKENS_PER_TENANT = 10;
const TOKEN_TTL_S = 15 * 60;

// KEYS[1] = gpu:tokens:{tenant}   KEYS[2] = gpu:holders:{tenant}
// ARGV[1] = capacity   ARGV[2] = lock id   ARGV[3] = token TTL seconds
const ADMIT_LUA = \`
local left = tonumber(redis.call('GET', KEYS[1]))
if left == nil then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
  left = tonumber(ARGV[1])
end
if left <= 0 then
  return {0, 0, redis.call('TTL', KEYS[1])}
end
redis.call('DECR', KEYS[1])
redis.call('HSET', KEYS[2], ARGV[2], 1)
redis.call('EXPIRE', KEYS[2], ARGV[3])
return {1, left - 1, redis.call('TTL', KEYS[1])}
\`;

// Give the token back only when the caller still holds the ticket it was issued with.
const RELEASE_LUA = \`
if redis.call('HDEL', KEYS[2], ARGV[1]) == 1 then
  redis.call('INCR', KEYS[1])
  return 1
end
return 0
\`;

async function admit(tenant: string, lockId: string): Promise<[boolean, number, number]> {
  const reply = (await redis.eval(
    ADMIT_LUA,
    2,
    \`gpu:tokens:\${tenant}\`,
    \`gpu:holders:\${tenant}\`,
    String(GPU_TOKENS_PER_TENANT),
    lockId,
    String(TOKEN_TTL_S),
  )) as number[];
  return [reply[0] === 1, reply[1], reply[2]];
}

async function release(tenant: string, lockId: string): Promise<void> {
  await redis.eval(RELEASE_LUA, 2, \`gpu:tokens:\${tenant}\`, \`gpu:holders:\${tenant}\`, lockId);
}

app.post('/v1/inferences', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const lockId = randomUUID();
  const [ok, left, ttl] = await admit(tenant, lockId);
  if (!ok)
    return reply
      .code(429)
      .header('Retry-After', String(Math.max(ttl, 1)))
      .header('X-GPU-Tokens-Remaining', String(left))
      .send({error: 'gpu pool is full for this tenant'});
  try {
    return reply.code(200).send({id: lockId, tenant});
  } finally {
    // The worker holding the result lock is the only one that may give the token back.
    await release(tenant, lockId);
  }
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

	"github.com/redis/go-redis/v9"
)

const gpuTokensPerTenant = 10

var rdb *redis.Client

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func admit(ctx context.Context, tenant string) bool {
	// TODO: this draft reads the counter and decrements it in two round trips, so a burst
	// over-admits, and it never releases a token when a worker dies — the pool leaks until Redis
	// restarts. Move both into scripts. Review all of it.
	key := "gpu:tokens:" + tenant
	left, err := rdb.Get(ctx, key).Int()
	if err == redis.Nil {
		left = gpuTokensPerTenant
	}
	if left <= 0 {
		return false
	}
	rdb.Decr(ctx, key)
	return true
}

func createInference(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	if !admit(r.Context(), tenant) {
		rw.Header().Set("Retry-After", "5")
		writeJSON(rw, http.StatusTooManyRequests, map[string]string{"error": "gpu pool is full for this tenant"})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]string{"id": "inf-1", "tenant": tenant})
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

const (
	gpuTokensPerTenant = 10
	tokenTTLSeconds    = 15 * 60
)

var rdb *redis.Client

// KEYS[1] = gpu:tokens:{tenant}   KEYS[2] = gpu:holders:{tenant}
// ARGV[1] = capacity   ARGV[2] = lock id   ARGV[3] = token TTL seconds
var admitScript = redis.NewScript(\`
local left = tonumber(redis.call('GET', KEYS[1]))
if left == nil then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
  left = tonumber(ARGV[1])
end
if left <= 0 then
  return {0, 0, redis.call('TTL', KEYS[1])}
end
redis.call('DECR', KEYS[1])
redis.call('HSET', KEYS[2], ARGV[2], 1)
redis.call('EXPIRE', KEYS[2], ARGV[3])
return {1, left - 1, redis.call('TTL', KEYS[1])}
\`)

// Give the token back only when the caller still holds the ticket it was issued with.
var releaseScript = redis.NewScript(\`
if redis.call('HDEL', KEYS[2], ARGV[1]) == 1 then
  redis.call('INCR', KEYS[1])
  return 1
end
return 0
\`)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func admit(ctx context.Context, tenant, lockID string) (bool, int64, int64) {
	keys := []string{"gpu:tokens:" + tenant, "gpu:holders:" + tenant}
	values, err := admitScript.Run(ctx, rdb, keys, gpuTokensPerTenant, lockID, tokenTTLSeconds).Int64Slice()
	if err != nil {
		panic(err)
	}
	return values[0] == 1, values[1], values[2]
}

func release(ctx context.Context, tenant, lockID string) {
	keys := []string{"gpu:tokens:" + tenant, "gpu:holders:" + tenant}
	if _, err := releaseScript.Run(ctx, rdb, keys, lockID).Result(); err != nil {
		panic(err)
	}
}

func createInference(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	lockID := uuid.NewString()
	ok, left, ttl := admit(r.Context(), tenant, lockID)
	if !ok {
		rw.Header().Set("Retry-After", fmt.Sprintf("%d", ttl))
		rw.Header().Set("X-GPU-Tokens-Remaining", fmt.Sprintf("%d", left))
		writeJSON(rw, http.StatusTooManyRequests, map[string]string{"error": "gpu pool is full for this tenant"})
		return
	}
	// The worker holding the result lock is the only one that may give the token back.
	defer release(r.Context(), tenant, lockID)
	writeJSON(rw, http.StatusOK, map[string]string{"id": lockID, "tenant": tenant})
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled

object Admission {
  val GpuTokensPerTenant = 10
  val jedis = new JedisPooled("redis", 6379)

  // TODO: this draft reads the counter and decrements it in two round trips, so a burst
  // over-admits, and it never releases a token when a worker dies — the pool leaks until Redis
  // restarts. Move both into scripts. Review all of it.
  def admit(tenant: String): Boolean = {
    val key = s"gpu:tokens:$tenant"
    val left = Option(jedis.get(key)).map(_.toLong).getOrElse(GpuTokensPerTenant.toLong)
    if (left <= 0) false
    else {
      jedis.decr(key)
      true
    }
  }
}

object VisionApi {
  implicit val system: ActorSystem = ActorSystem("vision-api")

  val route: Route =
    path("v1" / "inferences") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[String]) { _ =>
            if (!Admission.admit(tenant)) {
              respondWithHeaders(RawHeader("Retry-After", "5")) {
                complete(StatusCodes.TooManyRequests, """{"error":"gpu pool is full for this tenant"}""")
              }
            } else {
              complete(StatusCodes.OK, s"""{"id":"inf-1","tenant":"$tenant"}""")
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
      solution: `import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import scala.jdk.CollectionConverters._

object Admission {
  val GpuTokensPerTenant = 10
  val TokenTtlSeconds = 15L * 60

  val jedis = new JedisPooled("redis", 6379)

  // KEYS[1] = gpu:tokens:{tenant}   KEYS[2] = gpu:holders:{tenant}
  // ARGV[1] = capacity   ARGV[2] = lock id   ARGV[3] = token TTL seconds
  val AdmitLua: String =
    """
      |local left = tonumber(redis.call('GET', KEYS[1]))
      |if left == nil then
      |  redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
      |  left = tonumber(ARGV[1])
      |end
      |if left <= 0 then
      |  return {0, 0, redis.call('TTL', KEYS[1])}
      |end
      |redis.call('DECR', KEYS[1])
      |redis.call('HSET', KEYS[2], ARGV[2], 1)
      |redis.call('EXPIRE', KEYS[2], ARGV[3])
      |return {1, left - 1, redis.call('TTL', KEYS[1])}
      |""".stripMargin

  // Give the token back only when the caller still holds the ticket it was issued with.
  val ReleaseLua: String =
    """
      |if redis.call('HDEL', KEYS[2], ARGV[1]) == 1 then
      |  redis.call('INCR', KEYS[1])
      |  return 1
      |end
      |return 0
      |""".stripMargin

  def admit(tenant: String, lockId: String): (Boolean, Long, Long) = {
    val keys = List(s"gpu:tokens:$tenant", s"gpu:holders:$tenant").asJava
    val args = List(GpuTokensPerTenant.toString, lockId, TokenTtlSeconds.toString).asJava
    val reply = jedis.eval(AdmitLua, keys, args).asInstanceOf[java.util.List[Long]]
    (reply.get(0) == 1L, reply.get(1), reply.get(2))
  }

  def release(tenant: String, lockId: String): Unit = {
    val keys = List(s"gpu:tokens:$tenant", s"gpu:holders:$tenant").asJava
    jedis.eval(ReleaseLua, keys, List(lockId).asJava)
  }
}

object VisionApi {
  implicit val system: ActorSystem = ActorSystem("vision-api")

  val route: Route =
    path("v1" / "inferences") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[String]) { _ =>
            val lockId = UUID.randomUUID().toString
            val (ok, left, ttl) = Admission.admit(tenant, lockId)
            if (!ok) {
              respondWithHeaders(
                RawHeader("Retry-After", ttl.toString),
                RawHeader("X-GPU-Tokens-Remaining", left.toString)
              ) {
                complete(StatusCodes.TooManyRequests, """{"error":"gpu pool is full for this tenant"}""")
              }
            } else {
              // The worker holding the result lock is the only one that may give the token back.
              Admission.release(tenant, lockId)
              complete(StatusCodes.OK, s"""{"id":"$lockId","tenant":"$tenant"}""")
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

sw::redis::Redis redis("tcp://redis:6379");

constexpr int kGpuTokensPerTenant = 10;

// TODO: this draft reads the counter and decrements it in two round trips, so a burst over-admits,
// and it never releases a token when a worker dies — the pool leaks until Redis restarts. Move both
// into scripts. Review all of it.
bool admit(const std::string& tenant) {
  const auto key = "gpu:tokens:" + tenant;
  const auto raw = redis.get(key);
  const long long left = raw ? std::stoll(*raw) : kGpuTokensPerTenant;
  if (left <= 0) return false;
  redis.decr(key);
  return true;
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
    if (!admit(tenant)) {
      res.set_header("Retry-After", "5");
      res.status = 429;
      res.set_content(R"({"error":"gpu pool is full for this tenant"})", "application/json");
      return;
    }
    res.status = 200;
    res.set_content(json{{"id", "inf-1"}, {"tenant", tenant}}.dump(), "application/json");
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

sw::redis::Redis redis("tcp://redis:6379");

constexpr int kGpuTokensPerTenant = 10;
constexpr long long kTokenTtlSeconds = 15 * 60;

// KEYS[1] = gpu:tokens:{tenant}   KEYS[2] = gpu:holders:{tenant}
// ARGV[1] = capacity   ARGV[2] = lock id   ARGV[3] = token TTL seconds
const std::string kAdmitLua = R"lua(
local left = tonumber(redis.call('GET', KEYS[1]))
if left == nil then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
  left = tonumber(ARGV[1])
end
if left <= 0 then
  return {0, 0, redis.call('TTL', KEYS[1])}
end
redis.call('DECR', KEYS[1])
redis.call('HSET', KEYS[2], ARGV[2], 1)
redis.call('EXPIRE', KEYS[2], ARGV[3])
return {1, left - 1, redis.call('TTL', KEYS[1])}
)lua";

// Give the token back only when the caller still holds the ticket it was issued with.
const std::string kReleaseLua = R"lua(
if redis.call('HDEL', KEYS[2], ARGV[1]) == 1 then
  redis.call('INCR', KEYS[1])
  return 1
end
return 0
)lua";

bool admit(const std::string& tenant, const std::string& lockId, long long& left, long long& ttl) {
  const std::vector<std::string> keys{"gpu:tokens:" + tenant, "gpu:holders:" + tenant};
  const std::vector<std::string> args{std::to_string(kGpuTokensPerTenant), lockId,
                                      std::to_string(kTokenTtlSeconds)};
  const auto reply = redis.eval<std::vector<long long>>(kAdmitLua, keys.begin(), keys.end(), args.begin(), args.end());
  left = reply[1];
  ttl = reply[2];
  return reply[0] == 1;
}

void release(const std::string& tenant, const std::string& lockId) {
  const std::vector<std::string> keys{"gpu:tokens:" + tenant, "gpu:holders:" + tenant};
  const std::vector<std::string> args{lockId};
  redis.eval<long long>(kReleaseLua, keys.begin(), keys.end(), args.begin(), args.end());
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
    const auto lockId = uuidString();
    long long left = 0;
    long long ttl = 0;
    if (!admit(tenant, lockId, left, ttl)) {
      res.set_header("Retry-After", std::to_string(ttl > 0 ? ttl : 1));
      res.set_header("X-GPU-Tokens-Remaining", std::to_string(left));
      res.status = 429;
      res.set_content(R"({"error":"gpu pool is full for this tenant"})", "application/json");
      return;
    }
    // The worker holding the result lock is the only one that may give the token back.
    release(tenant, lockId);
    res.status = 200;
    res.set_content(json{{"id", lockId}, {"tenant", tenant}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Every decision the pool makes has to happen on the Redis side, in one script: read the counter, refuse when it is empty, decrement, and record the ticket. Sending `GET` and then `DECR` leaves a window in which a second request sees the same room and both are admitted.',
    "The TTL is what makes a crash self-healing. Set it with the first write (`SET key capacity EX TOKEN_TTL_S`) rather than in a follow-up `EXPIRE` that a failed request can skip — and never refresh it on release, or a busy tenant's counter would never expire.",
    'Release is not a bare `INCR`: it must prove the caller still holds the ticket (`HDEL` on the holder hash, increment only when it removed something). Otherwise a retried worker that already lost its ticket to the TTL hands the pool an eleventh token.',
  ],
  debrief: `The interviewer is testing whether you can review a quota that looks right in a serial test. Two
defects are being checked and both are invisible to a demo: a check-then-decrement windows (two
requests read the same free slot), and a token that is never returned when a worker dies. The fix is
the same shape as every well-built limiter — one atomic server-side decision, an expiry so a crash is
self-healing, and an owner-checked release so a stale ticket cannot inflate the pool. The interview
follow-up is usually about the number: 10 tokens per tenant is a fair-share policy, and the real
systems add a global cap, a queue *inside* the worker for admitted-but-not-started work, and a metric
on how long a ticket is held, because a pool that is never full is often a pool that is too big.`,
};
