import type {Step} from '@/lib/types';

// ---- 5. POST /v1/policies/{policy}/rollout ---------------------------------------------------------
export const rolloutStep: Step = {
  id: 'rollout',
  title: 'Canary rollout: gated by evals, safe to roll back',
  concept: 'http',
  file: 'rollout',
  focus: ['client', 'router', 'redis', 'eval'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/policies/{policy}/rollout\` with body
\`{"version", "percentage"}\` for an operator authenticated through \`authenticate\`. It reads the
hash \`rollout:{policy}\` (\`stable\`, \`canary\`, \`percentage\`), answers **409** to a change with
traffic above 0 whose eval record \`eval:{policy}:{version}\` does not say \`status: passed\`,
writes \`canary\` and \`percentage\` with \`HSET\`, logs the change and answers the record as
\`{policy, stable, canary, percentage}\`. It serves the demo and hides 4 flaws.

**Failure mode the checks target.** A share of 150 % pushed by a script, a version that passed with
a score nobody would ship, a regressed canary that cannot be rolled back because its eval now fails,
and another operator's rollback overwritten by a raise that read the record before it.

- The policy matches \`^[a-z0-9][a-z0-9_-]{1,31}$\`, \`version\` is at least 1 and \`percentage\` is
  0…100; otherwise **400** and no write.
- A change with traffic above 0 needs \`eval:{policy}:{version}\` with \`status\` \`passed\` and
  \`score\` of at least **MIN_EVAL_SCORE = 0.85**, otherwise **409**. Lowering the current canary's
  share (a rollback) skips the gate.
- Read, gate and write run in **one Lua script**, so a change that lands meanwhile is not
  overwritten.`,
  sequence: {
    participants: ['Operator', 'routerd', 'Redis'],
    messages: [
      {
        from: 'Operator',
        to: 'routerd',
        label: 'POST /v1/policies/auto/rollout {version: 4, percentage: 25}',
        kind: 'sync',
      },
      {from: 'routerd', to: 'routerd', label: 'policy name · 1 ≤ version · 0 ≤ percentage ≤ 100', kind: 'sync'},
      {from: 'routerd', to: 'Redis', label: 'EVALSHA rollout rollout:auto eval:auto:4 4 25 0.85', kind: 'sync'},
      {from: 'Redis', to: 'routerd', label: '{1, 10}  (applied, previous share)', kind: 'reply'},
      {from: 'routerd', to: 'Redis', label: 'HGETALL rollout:auto', kind: 'sync'},
      {from: 'routerd', to: 'Operator', label: '200 {policy, stable: 3, canary: 4, percentage: 25}', kind: 'reply'},
    ],
  },
  hints: [
    'A script sets a canary to 150 %; a version that passed with score 0.62 reaches half the traffic; during an incident the rollback answers 409; a rollback made at 10:02 is gone at 10:03 though nobody undid it.',
    'Nothing checks the path or the body; the gate compares `status` and ignores `score`; it applies to every change above 0, a lower share of the current canary included; HGETALL and HSET are separate round trips, so a write in between is overwritten.',
    'Validate first (400). Move the read, the gate (the same canary at `percentage <= current` skips it; anything else needs `status == "passed"` and `score >= MIN_EVAL_SCORE`) and `HSET canary … percentage …` into one script that returns whether it applied; 409 when it did not.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/policies/{policy}/rollout',
      detail:
        'A handler is registered for `POST /v1/policies/{policy}/rollout`; it authenticates the operator and answers the rollout record `{policy, stable, canary, percentage}` as it stands after the change.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/policies\/\{policy\}\/rollout["']/, /authenticate\(/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/policies\/:policy\/rollout['"]/, /authenticate\(/]},
        go: {all: [/"POST \/v1\/policies\/\{policy\}\/rollout"/, /auth\.Tenant\(/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"policies"\s*\/\s*Segment\s*\/\s*"rollout"\s*\)/, /Auth\.tenant\(/]},
        cpp: {all: [/svr\.Post\(\s*R?"\(?\/v1\/policies\//, /routerd::tenant\(/]},
      },
    },
    {
      id: 'validate',
      title: 'Rejects a bad policy name, version or percentage with 400',
      detail:
        'The policy name matches `^[a-z0-9][a-z0-9_-]{1,31}$`, the version is at least 1 and the percentage is 0…100; anything else answers 400 and writes nothing.',
      match: {
        python: {all: [/re\.compile\(|re\.(full)?match\(/, /[<>]=?\s*100\b/]},
        typescript: {all: [/\.test\(/, /[<>]=?\s*100\b/]},
        go: {all: [/regexp\.MustCompile\(/, /[<>]=?\s*100\b/]},
        scala: {all: [/\.matches\(|findFirstIn|\.r\b/, /[<>]=?\s*100\b/]},
        cpp: {all: [/std::regex_match\(/, /[<>]=?\s*100\b/]},
      },
    },
    {
      id: 'eval-gate',
      title: 'Raising traffic needs a passing eval with score ≥ 0.85',
      detail:
        'A change with traffic above 0 (other than a rollback) needs `eval:{policy}:{version}` to say `passed` with a score of at least `MIN_EVAL_SCORE`; otherwise 409 and no change. `passed` alone only says the eval finished.',
      match: {
        python: {all: [/MIN_EVAL_SCORE(?!\s*=)/]},
        typescript: {all: [/MIN_EVAL_SCORE(?!\s*=)/]},
        go: {all: [/minEvalScore(?!\s*=)/]},
        scala: {all: [/MinEvalScore(?!\s*=)/]},
        cpp: {all: [/kMinEvalScore(?!\s*=)/]},
      },
    },
    {
      id: 'rollback',
      title: 'Lowering the current canary is never gated',
      detail:
        "Lowering the current canary's share, to 0 or to anything below what it has now, applies even when its eval has since failed; a rollback that waits for a passing eval keeps a regressed version in front of users.",
      match: {
        python: {all: [/<=\s*current\b/]},
        typescript: {all: [/<=\s*current\b/]},
        go: {all: [/<=\s*current\b/]},
        scala: {all: [/<=\s*current\b/]},
        cpp: {all: [/<=\s*current\b/]},
      },
    },
    {
      id: 'no-lost-update',
      title: 'Reads, gates and writes in one Lua script',
      detail:
        'The read of `rollout:{policy}`, the gate and the HSET run inside one script (`EVAL` / `EVALSHA`); a client-side HGETALL followed by HSET overwrites a rollback another operator made in between.',
      match: {
        python: {
          all: [/redis\.call\(\s*['"]HSET['"]/, /register_script\(|\.eval\(|\.evalsha\(/],
          none: [/\br\.hset\(/],
        },
        typescript: {
          all: [/redis\.call\(\s*['"]HSET['"]/, /defineCommand\(|\.eval\(|\.evalsha\(/],
          none: [/redis\.hset\(/],
        },
        go: {all: [/redis\.call\(\s*['"]HSET['"]/, /redis\.NewScript\(|\.Eval\(|\.EvalSha\(/], none: [/rdb\.HSet\(/]},
        scala: {all: [/redis\.call\(\s*['"]HSET['"]/, /jedis\.eval(sha)?\(/], none: [/jedis\.hset\(/]},
        cpp: {all: [/redis\.call\(\s*['"]HSET['"]/, /redis\.eval(sha)?[<(]/], none: [/redis\.hset\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

import redis
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

from routerd.auth import authenticate

app = FastAPI()
logger = logging.getLogger("routerd")
r = redis.Redis(host="redis", port=6379, decode_responses=True)

MIN_EVAL_SCORE = 0.85


class RolloutRequest(BaseModel):
    version: int
    percentage: int


def assignment(policy: str) -> dict:
    """The policy's rollout record as it stands."""
    record = r.hgetall(f"rollout:{policy}")
    return {"policy": policy, **{field: int(record.get(field, 0)) for field in ("stable", "canary", "percentage")}}


# TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
@app.post("/v1/policies/{policy}/rollout")
def rollout(policy: str, body: RolloutRequest, request: Request) -> dict:
    operator = authenticate(request.headers.get("authorization"))
    key = f"rollout:{policy}"
    current = r.hgetall(key)
    if body.percentage > 0:
        evaluation = r.hgetall(f"eval:{policy}:{body.version}")
        if evaluation.get("status") != "passed":
            raise HTTPException(status_code=409, detail=f"version {body.version} has not passed its eval")
    r.hset(key, mapping={"canary": body.version, "percentage": body.percentage})
    logger.info("rollout %s by %s: v%s %s%% -> %s%%", policy, operator, body.version, current.get("percentage", 0), body.percentage)
    return assignment(policy)
`,
      solution: `import logging
import re

import redis
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

from routerd.auth import authenticate

app = FastAPI()
logger = logging.getLogger("routerd")
r = redis.Redis(host="redis", port=6379, decode_responses=True)

MIN_EVAL_SCORE = 0.85
POLICY_NAME = re.compile(r"^[a-z0-9][a-z0-9_-]{1,31}$")

# KEYS: rollout:{policy}, eval:{policy}:{version}; ARGV: version, percentage, minimum score.
ROLLOUT_LUA = """
local canary = redis.call('HGET', KEYS[1], 'canary')
local current = tonumber(redis.call('HGET', KEYS[1], 'percentage') or '0')
local percentage = tonumber(ARGV[2])
local rollback = canary == ARGV[1] and percentage <= current
if percentage > 0 and not rollback then
  local status = redis.call('HGET', KEYS[2], 'status')
  local score = tonumber(redis.call('HGET', KEYS[2], 'score') or '0')
  if status ~= 'passed' or score < tonumber(ARGV[3]) then
    return {0, current}
  end
end
redis.call('HSET', KEYS[1], 'canary', ARGV[1], 'percentage', ARGV[2])
return {1, current}
"""
rollout_script = r.register_script(ROLLOUT_LUA)


class RolloutRequest(BaseModel):
    version: int
    percentage: int


def assignment(policy: str) -> dict:
    """The policy's rollout record as it stands."""
    record = r.hgetall(f"rollout:{policy}")
    return {"policy": policy, **{field: int(record.get(field, 0)) for field in ("stable", "canary", "percentage")}}


@app.post("/v1/policies/{policy}/rollout")
def rollout(policy: str, body: RolloutRequest, request: Request) -> dict:
    operator = authenticate(request.headers.get("authorization"))
    if not POLICY_NAME.match(policy):
        raise HTTPException(status_code=400, detail="policy must match ^[a-z0-9][a-z0-9_-]{1,31}$")
    if body.version < 1:
        raise HTTPException(status_code=400, detail="version must be at least 1")
    if not 0 <= body.percentage <= 100:
        raise HTTPException(status_code=400, detail="percentage must be between 0 and 100")
    keys = [f"rollout:{policy}", f"eval:{policy}:{body.version}"]
    applied, previous = rollout_script(keys=keys, args=[body.version, body.percentage, MIN_EVAL_SCORE])
    if not applied:
        raise HTTPException(status_code=409, detail=f"version {body.version} has no passing eval at {MIN_EVAL_SCORE}")
    logger.info("rollout %s by %s: v%s %s%% -> %s%%", policy, operator, body.version, previous, body.percentage)
    return assignment(policy)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';
import Redis from 'ioredis';
import {authenticate} from 'routerd/auth';

export const app = Fastify();

export const MIN_EVAL_SCORE = 0.85;

const redis = new Redis({host: 'redis', port: 6379});

interface RolloutRequest {
  version: number;
  percentage: number;
}

/** The policy's rollout record as it stands. */
async function assignment(policy: string) {
  const record = await redis.hgetall(\`rollout:\${policy}\`);
  return {policy, stable: Number(record.stable ?? 0), canary: Number(record.canary ?? 0), percentage: Number(record.percentage ?? 0)};
}

// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
app.post('/v1/policies/:policy/rollout', async (request, reply) => {
  const operator = authenticate(request.headers.authorization);
  const {policy} = request.params as {policy: string};
  const body = request.body as RolloutRequest;
  const key = \`rollout:\${policy}\`;
  const current = await redis.hgetall(key);
  if (body.percentage > 0) {
    const evaluation = await redis.hgetall(\`eval:\${policy}:\${body.version}\`);
    if (evaluation.status !== 'passed') {
      return reply.code(409).send({error: \`version \${body.version} has not passed its eval\`});
    }
  }
  await redis.hset(key, 'canary', body.version, 'percentage', body.percentage);
  console.log('rollout', policy, 'by', operator, \`v\${body.version}\`, current.percentage ?? 0, '->', body.percentage);
  return assignment(policy);
});
`,
      solution: `import Fastify from 'fastify';
import Redis from 'ioredis';
import {authenticate} from 'routerd/auth';

export const app = Fastify();

export const MIN_EVAL_SCORE = 0.85;
const POLICY_NAME = /^[a-z0-9][a-z0-9_-]{1,31}$/;

// KEYS: rollout:{policy}, eval:{policy}:{version}; ARGV: version, percentage, minimum score.
const ROLLOUT_LUA = \`
local canary = redis.call('HGET', KEYS[1], 'canary')
local current = tonumber(redis.call('HGET', KEYS[1], 'percentage') or '0')
local percentage = tonumber(ARGV[2])
local rollback = canary == ARGV[1] and percentage <= current
if percentage > 0 and not rollback then
  local status = redis.call('HGET', KEYS[2], 'status')
  local score = tonumber(redis.call('HGET', KEYS[2], 'score') or '0')
  if status ~= 'passed' or score < tonumber(ARGV[3]) then
    return {0, current}
  end
end
redis.call('HSET', KEYS[1], 'canary', ARGV[1], 'percentage', ARGV[2])
return {1, current}
\`;

interface RolloutRedis extends Redis {
  rollout(key: string, evalKey: string, version: number, percentage: number, minScore: number): Promise<[number, number]>;
}

const redis = new Redis({host: 'redis', port: 6379}) as RolloutRedis;
redis.defineCommand('rollout', {numberOfKeys: 2, lua: ROLLOUT_LUA});

interface RolloutRequest {
  version: number;
  percentage: number;
}

/** The policy's rollout record as it stands. */
async function assignment(policy: string) {
  const record = await redis.hgetall(\`rollout:\${policy}\`);
  return {policy, stable: Number(record.stable ?? 0), canary: Number(record.canary ?? 0), percentage: Number(record.percentage ?? 0)};
}

app.post('/v1/policies/:policy/rollout', async (request, reply) => {
  const operator = authenticate(request.headers.authorization);
  const {policy} = request.params as {policy: string};
  const body = request.body as RolloutRequest;
  if (!POLICY_NAME.test(policy)) return reply.code(400).send({error: 'policy must match ^[a-z0-9][a-z0-9_-]{1,31}$'});
  if (!Number.isInteger(body.version) || body.version < 1) return reply.code(400).send({error: 'version must be at least 1'});
  if (!Number.isInteger(body.percentage) || body.percentage < 0 || body.percentage > 100) {
    return reply.code(400).send({error: 'percentage must be between 0 and 100'});
  }
  const [applied, previous] = await redis.rollout(
    \`rollout:\${policy}\`,
    \`eval:\${policy}:\${body.version}\`,
    body.version,
    body.percentage,
    MIN_EVAL_SCORE,
  );
  if (applied !== 1) {
    return reply.code(409).send({error: \`version \${body.version} has no passing eval at \${MIN_EVAL_SCORE}\`});
  }
  console.log('rollout', policy, 'by', operator, \`v\${body.version}\`, previous, '->', body.percentage);
  return assignment(policy);
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
	"strconv"

	"github.com/redis/go-redis/v9"

	"routerd/auth"
)

const minEvalScore = 0.85

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type rolloutRequest struct {
	Version    int \`json:"version"\`
	Percentage int \`json:"percentage"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

// assignment is the policy's rollout record as it stands.
func assignment(ctx context.Context, policy string) map[string]any {
	record, _ := rdb.HGetAll(ctx, "rollout:"+policy).Result()
	out := map[string]any{"policy": policy}
	for _, field := range []string{"stable", "canary", "percentage"} {
		n, _ := strconv.Atoi(record[field])
		out[field] = n
	}
	return out
}

// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
func rollout(rw http.ResponseWriter, r *http.Request) {
	operator, ok := auth.Tenant(r)
	if !ok {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing bearer token"})
		return
	}
	policy := r.PathValue("policy")
	var body rolloutRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	key := "rollout:" + policy
	current, err := rdb.HGetAll(r.Context(), key).Result()
	if err != nil {
		writeJSON(rw, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if body.Percentage > 0 {
		evaluation, _ := rdb.HGetAll(r.Context(), "eval:"+policy+":"+strconv.Itoa(body.Version)).Result()
		if evaluation["status"] != "passed" {
			writeJSON(rw, http.StatusConflict, map[string]string{"error": "the version has not passed its eval"})
			return
		}
	}
	if err := rdb.HSet(r.Context(), key, "canary", body.Version, "percentage", body.Percentage).Err(); err != nil {
		writeJSON(rw, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	log.Printf("rollout %s by %s: v%d %s%% -> %d%%", policy, operator, body.Version, current["percentage"], body.Percentage)
	writeJSON(rw, http.StatusOK, assignment(r.Context(), policy))
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/policies/{policy}/rollout", rollout)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"regexp"
	"strconv"

	"github.com/redis/go-redis/v9"

	"routerd/auth"
)

const minEvalScore = 0.85

var policyName = regexp.MustCompile(\`^[a-z0-9][a-z0-9_-]{1,31}$\`)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// KEYS: rollout:{policy}, eval:{policy}:{version}; ARGV: version, percentage, minimum score.
var rolloutScript = redis.NewScript(\`
local canary = redis.call('HGET', KEYS[1], 'canary')
local current = tonumber(redis.call('HGET', KEYS[1], 'percentage') or '0')
local percentage = tonumber(ARGV[2])
local rollback = canary == ARGV[1] and percentage <= current
if percentage > 0 and not rollback then
  local status = redis.call('HGET', KEYS[2], 'status')
  local score = tonumber(redis.call('HGET', KEYS[2], 'score') or '0')
  if status ~= 'passed' or score < tonumber(ARGV[3]) then
    return {0, current}
  end
end
redis.call('HSET', KEYS[1], 'canary', ARGV[1], 'percentage', ARGV[2])
return {1, current}
\`)

type rolloutRequest struct {
	Version    int \`json:"version"\`
	Percentage int \`json:"percentage"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

// assignment is the policy's rollout record as it stands.
func assignment(ctx context.Context, policy string) map[string]any {
	record, _ := rdb.HGetAll(ctx, "rollout:"+policy).Result()
	out := map[string]any{"policy": policy}
	for _, field := range []string{"stable", "canary", "percentage"} {
		n, _ := strconv.Atoi(record[field])
		out[field] = n
	}
	return out
}

func rollout(rw http.ResponseWriter, r *http.Request) {
	operator, ok := auth.Tenant(r)
	if !ok {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing bearer token"})
		return
	}
	policy := r.PathValue("policy")
	var body rolloutRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if !policyName.MatchString(policy) {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "policy must match ^[a-z0-9][a-z0-9_-]{1,31}$"})
		return
	}
	if body.Version < 1 || body.Percentage < 0 || body.Percentage > 100 {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "version must be at least 1 and percentage between 0 and 100"})
		return
	}
	keys := []string{"rollout:" + policy, "eval:" + policy + ":" + strconv.Itoa(body.Version)}
	res, err := rolloutScript.Run(r.Context(), rdb, keys, body.Version, body.Percentage, minEvalScore).Int64Slice()
	if err != nil {
		writeJSON(rw, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if res[0] != 1 {
		writeJSON(rw, http.StatusConflict, map[string]string{"error": "the version has no passing eval"})
		return
	}
	log.Printf("rollout %s by %s: v%d %d%% -> %d%%", policy, operator, body.Version, res[1], body.Percentage)
	writeJSON(rw, http.StatusOK, assignment(r.Context(), policy))
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/policies/{policy}/rollout", rollout)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import routerd.Auth

import scala.jdk.CollectionConverters._

object Rollout {
  val MinEvalScore = 0.85

  private val jedis = new JedisPooled("redis", 6379)

  case class RolloutRequest(version: Int, percentage: Int)

  def parse(body: String): RolloutRequest = {
    val json = ujson.read(body)
    RolloutRequest(json.obj.get("version").map(_.num.toInt).getOrElse(0), json.obj.get("percentage").map(_.num.toInt).getOrElse(-1))
  }

  private def answer(status: StatusCode, body: String): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body))

  /** The policy's rollout record as it stands. */
  def assignment(policy: String): String = {
    val record = jedis.hgetAll(s"rollout:$policy").asScala
    val fields = Seq("stable", "canary", "percentage").map(f => f -> ujson.Num(record.get(f).map(_.toDouble).getOrElse(0.0)))
    ujson.write(ujson.Obj.from(("policy" -> ujson.Str(policy)) +: fields))
  }

  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  val route: Route =
    path("v1" / "policies" / Segment / "rollout") { policy =>
      post {
        optionalHeaderValueByName("Authorization") { authorization =>
          Auth.tenant(authorization) match {
            case None => complete(answer(StatusCodes.Unauthorized, """{"error":"missing bearer token"}"""))
            case Some(operator) =>
              entity(as[String]) { raw =>
                val body = parse(raw)
                val key = s"rollout:$policy"
                val current = jedis.hgetAll(key)
                val evaluation = jedis.hgetAll(s"eval:$policy:\${body.version}")
                if (body.percentage > 0 && evaluation.get("status") != "passed")
                  complete(answer(StatusCodes.Conflict, """{"error":"the version has not passed its eval"}"""))
                else {
                  jedis.hset(key, Map("canary" -> body.version.toString, "percentage" -> body.percentage.toString).asJava)
                  println(s"rollout $policy by $operator: v\${body.version} \${current.get("percentage")}% -> \${body.percentage}%")
                  complete(answer(StatusCodes.OK, assignment(policy)))
                }
              }
          }
        }
      }
    }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import routerd.Auth

import scala.jdk.CollectionConverters._

object Rollout {
  val MinEvalScore = 0.85
  val PolicyName = "^[a-z0-9][a-z0-9_-]{1,31}$"

  private val jedis = new JedisPooled("redis", 6379)

  // KEYS: rollout:{policy}, eval:{policy}:{version}; ARGV: version, percentage, minimum score.
  val RolloutLua: String =
    """local canary = redis.call('HGET', KEYS[1], 'canary')
      |local current = tonumber(redis.call('HGET', KEYS[1], 'percentage') or '0')
      |local percentage = tonumber(ARGV[2])
      |local rollback = canary == ARGV[1] and percentage <= current
      |if percentage > 0 and not rollback then
      |  local status = redis.call('HGET', KEYS[2], 'status')
      |  local score = tonumber(redis.call('HGET', KEYS[2], 'score') or '0')
      |  if status ~= 'passed' or score < tonumber(ARGV[3]) then
      |    return {0, current}
      |  end
      |end
      |redis.call('HSET', KEYS[1], 'canary', ARGV[1], 'percentage', ARGV[2])
      |return {1, current}
      |""".stripMargin
  private val sha = jedis.scriptLoad(RolloutLua)

  case class RolloutRequest(version: Int, percentage: Int)

  def parse(body: String): RolloutRequest = {
    val json = ujson.read(body)
    RolloutRequest(json.obj.get("version").map(_.num.toInt).getOrElse(0), json.obj.get("percentage").map(_.num.toInt).getOrElse(-1))
  }

  private def answer(status: StatusCode, body: String): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body))

  /** The policy's rollout record as it stands. */
  def assignment(policy: String): String = {
    val record = jedis.hgetAll(s"rollout:$policy").asScala
    val fields = Seq("stable", "canary", "percentage").map(f => f -> ujson.Num(record.get(f).map(_.toDouble).getOrElse(0.0)))
    ujson.write(ujson.Obj.from(("policy" -> ujson.Str(policy)) +: fields))
  }

  val route: Route =
    path("v1" / "policies" / Segment / "rollout") { policy =>
      post {
        optionalHeaderValueByName("Authorization") { authorization =>
          Auth.tenant(authorization) match {
            case None => complete(answer(StatusCodes.Unauthorized, """{"error":"missing bearer token"}"""))
            case Some(operator) =>
              entity(as[String]) { raw =>
                val body = parse(raw)
                if (!policy.matches(PolicyName) || body.version < 1 || body.percentage < 0 || body.percentage > 100)
                  complete(answer(StatusCodes.BadRequest, """{"error":"invalid policy, version or percentage"}"""))
                else {
                  val keys = List(s"rollout:$policy", s"eval:$policy:\${body.version}").asJava
                  val args = List(body.version.toString, body.percentage.toString, MinEvalScore.toString).asJava
                  val reply = jedis.evalsha(sha, keys, args).asInstanceOf[java.util.List[java.lang.Long]].asScala
                  if (reply(0) != 1L) complete(answer(StatusCodes.Conflict, """{"error":"the version has no passing eval"}"""))
                  else {
                    println(s"rollout $policy by $operator: v\${body.version} \${reply(1)}% -> \${body.percentage}%")
                    complete(answer(StatusCodes.OK, assignment(policy)))
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
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <iostream>
#include <string>
#include <unordered_map>

#include "routerd/auth.h"

constexpr double kMinEvalScore = 0.85;

sw::redis::Redis redis("tcp://redis:6379");

void answer(httplib::Response& res, int status, const nlohmann::json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

// The policy's rollout record as it stands.
nlohmann::json assignment(const std::string& policy) {
  const auto record = redis.hgetall("rollout:" + policy);
  nlohmann::json out = {{"policy", policy}};
  for (const std::string field : {"stable", "canary", "percentage"}) {
    const auto it = record.find(field);
    out[field] = it == record.end() ? 0 : std::stoi(it->second);
  }
  return out;
}

// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
void rollout(const httplib::Request& req, httplib::Response& res) {
  const auto operator_name = routerd::tenant(req);
  if (!operator_name) return answer(res, 401, {{"error", "missing bearer token"}});
  const std::string policy = req.matches[1];
  const auto body = nlohmann::json::parse(req.body, nullptr, false);
  if (!body.is_object()) return answer(res, 400, {{"error", "invalid json"}});
  const int version = body.value("version", 0);
  const int percentage = body.value("percentage", -1);
  const std::string key = "rollout:" + policy;
  const auto current = redis.hgetall(key);
  if (percentage > 0) {
    const auto evaluation = redis.hgetall("eval:" + policy + ":" + std::to_string(version));
    const auto status = evaluation.find("status");
    if (status == evaluation.end() || status->second != "passed") {
      return answer(res, 409, {{"error", "the version has not passed its eval"}});
    }
  }
  redis.hset(key, "canary", std::to_string(version), "percentage", std::to_string(percentage));
  const auto previous = current.find("percentage");
  std::cout << "rollout " << policy << " by " << *operator_name << ": v" << version << " "
            << (previous == current.end() ? "0" : previous->second) << "% -> " << percentage << "%\\n";
  answer(res, 200, assignment(policy));
}

void register_routes(httplib::Server& svr) {
  svr.Post(R"(/v1/policies/([^/]+)/rollout)", rollout);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <iostream>
#include <iterator>
#include <regex>
#include <string>
#include <unordered_map>
#include <vector>

#include "routerd/auth.h"

constexpr double kMinEvalScore = 0.85;
const std::regex kPolicyName("^[a-z0-9][a-z0-9_-]{1,31}$");

sw::redis::Redis redis("tcp://redis:6379");

// KEYS: rollout:{policy}, eval:{policy}:{version}; ARGV: version, percentage, minimum score.
const std::string kRolloutLua = R"lua(
local canary = redis.call('HGET', KEYS[1], 'canary')
local current = tonumber(redis.call('HGET', KEYS[1], 'percentage') or '0')
local percentage = tonumber(ARGV[2])
local rollback = canary == ARGV[1] and percentage <= current
if percentage > 0 and not rollback then
  local status = redis.call('HGET', KEYS[2], 'status')
  local score = tonumber(redis.call('HGET', KEYS[2], 'score') or '0')
  if status ~= 'passed' or score < tonumber(ARGV[3]) then
    return {0, current}
  end
end
redis.call('HSET', KEYS[1], 'canary', ARGV[1], 'percentage', ARGV[2])
return {1, current}
)lua";
const std::string kRolloutSha = redis.script_load(kRolloutLua);

void answer(httplib::Response& res, int status, const nlohmann::json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

// The policy's rollout record as it stands.
nlohmann::json assignment(const std::string& policy) {
  const auto record = redis.hgetall("rollout:" + policy);
  nlohmann::json out = {{"policy", policy}};
  for (const std::string field : {"stable", "canary", "percentage"}) {
    const auto it = record.find(field);
    out[field] = it == record.end() ? 0 : std::stoi(it->second);
  }
  return out;
}

void rollout(const httplib::Request& req, httplib::Response& res) {
  const auto operator_name = routerd::tenant(req);
  if (!operator_name) return answer(res, 401, {{"error", "missing bearer token"}});
  const std::string policy = req.matches[1];
  const auto body = nlohmann::json::parse(req.body, nullptr, false);
  if (!body.is_object()) return answer(res, 400, {{"error", "invalid json"}});
  const int version = body.value("version", 0);
  const int percentage = body.value("percentage", -1);
  if (!std::regex_match(policy, kPolicyName)) return answer(res, 400, {{"error", "policy must match ^[a-z0-9][a-z0-9_-]{1,31}$"}});
  if (version < 1 || percentage < 0 || percentage > 100) {
    return answer(res, 400, {{"error", "version must be at least 1 and percentage between 0 and 100"}});
  }
  std::vector<long long> reply;
  redis.evalsha(kRolloutSha, {"rollout:" + policy, "eval:" + policy + ":" + std::to_string(version)},
                {std::to_string(version), std::to_string(percentage), std::to_string(kMinEvalScore)},
                std::back_inserter(reply));
  if (reply[0] != 1) return answer(res, 409, {{"error", "the version has no passing eval"}});
  std::cout << "rollout " << policy << " by " << *operator_name << ": v" << version << " " << reply[1] << "% -> "
            << percentage << "%\\n";
  answer(res, 200, assignment(policy));
}

void register_routes(httplib::Server& svr) {
  svr.Post(R"(/v1/policies/([^/]+)/rollout)", rollout);
}
`,
    },
  },
  harness: {
    python: `AUTH = {"Authorization": "Bearer ops"}
KEY = "rollout:auto"


def _seed(ctx, canary=4, percentage=10):
    ctx.redis.hset(KEY, mapping={"stable": 3, "canary": canary, "percentage": percentage})


def _eval(ctx, version, status, score):
    ctx.redis.hset(f"eval:auto:{version}", mapping={"status": status, "score": score})


async def _rollout(ctx, m, version, percentage, policy="auto", headers=AUTH):
    async with ctx.client(m.app) as c:
        return await c.post(f"/v1/policies/{policy}/rollout", json={"version": version, "percentage": percentage}, headers=headers)


def _record(ctx):
    return ctx.redis.hgetall(KEY)


async def check_route(ctx):
    m = ctx.load("rollout")
    _seed(ctx)
    _eval(ctx, 4, "passed", 0.92)
    r = await _rollout(ctx, m, 4, 25)
    assert r.status_code == 200, f"raising v4 from 10 % to 25 % with a passing eval answered {r.status_code}: {r.text}"
    expected = {"policy": "auto", "stable": 3, "canary": 4, "percentage": 25}
    assert r.json() == expected, f"the answer is {r.json()}, expected the rollout record after the change {expected}"
    assert _record(ctx).get("percentage") == "25", f"{KEY} is {_record(ctx)} after the change, expected percentage 25"
    anonymous = await _rollout(ctx, m, 4, 30, headers={})
    assert anonymous.status_code == 401, f"a rollout without a bearer token answered {anonymous.status_code}, expected 401"


async def check_validate(ctx):
    m = ctx.load("rollout")
    _seed(ctx)
    _eval(ctx, 4, "passed", 0.92)
    bad = [
        ("percentage 101", "auto", 4, 101),
        ("percentage -5", "auto", 4, -5),
        ("version 0", "auto", 0, 10),
        ("the policy name AUTO", "AUTO", 4, 20),
        ("the policy name x", "x", 4, 20),
    ]
    for what, policy, version, percentage in bad:
        r = await _rollout(ctx, m, version, percentage, policy=policy)
        assert r.status_code == 400, f"{what} answered {r.status_code}, expected 400"
    assert _record(ctx) == {"stable": "3", "canary": "4", "percentage": "10"}, f"rejected requests changed {KEY}: {_record(ctx)}"
    assert sorted(ctx.redis.keys("rollout:*")) == [KEY], f"rejected requests wrote rollout records: {sorted(ctx.redis.keys('rollout:*'))}"


async def check_eval_gate(ctx):
    m = ctx.load("rollout")
    _seed(ctx)
    _eval(ctx, 5, "passed", 0.70)
    r = await _rollout(ctx, m, 5, 20)
    assert r.status_code == 409, f"v5 passed its eval with score 0.70 and a rollout to 20 % answered {r.status_code}, expected 409: the score must be at least 0.85"
    r = await _rollout(ctx, m, 6, 20)
    assert r.status_code == 409, f"v6 has no eval record and a rollout to 20 % answered {r.status_code}, expected 409"
    _eval(ctx, 4, "failed", 0.91)
    r = await _rollout(ctx, m, 4, 30)
    assert r.status_code == 409, f"raising v4 from 10 % to 30 % with a failed eval answered {r.status_code}, expected 409"
    assert _record(ctx) == {"stable": "3", "canary": "4", "percentage": "10"}, f"refused rollouts changed {KEY}: {_record(ctx)}"
    _eval(ctx, 5, "passed", 0.85)
    r = await _rollout(ctx, m, 5, 20)
    assert r.status_code == 200, f"v5 with a passing eval at exactly 0.85 answered {r.status_code}: {r.text}"
    assert _record(ctx).get("canary") == "5" and _record(ctx).get("percentage") == "20", f"{KEY} is {_record(ctx)}, expected canary 5 at 20 %"


async def check_rollback(ctx):
    m = ctx.load("rollout")
    _seed(ctx, canary=4, percentage=25)
    _eval(ctx, 4, "failed", 0.41)
    r = await _rollout(ctx, m, 4, 5)
    assert r.status_code == 200, f"lowering canary v4 from 25 % to 5 % (its eval now fails) answered {r.status_code}: a rollback must not wait for a passing eval"
    assert _record(ctx).get("percentage") == "5", f"{KEY} is {_record(ctx)} after the rollback to 5 %"
    r = await _rollout(ctx, m, 4, 0)
    assert r.status_code == 200 and _record(ctx).get("percentage") == "0", f"rolling v4 back to 0 % answered {r.status_code} and left {_record(ctx)}"
    r = await _rollout(ctx, m, 7, 3)
    assert r.status_code == 409, f"sending 3 % to v7, which has no eval, answered {r.status_code}: only lowering the current canary skips the gate"


async def check_no_lost_update(ctx):
    m = ctx.load("rollout")
    _seed(ctx)
    _eval(ctx, 4, "passed", 0.92)
    warm = await _rollout(ctx, m, 4, 10)
    assert warm.status_code == 200, f"re-applying v4 at its current 10 % answered {warm.status_code}: {warm.text}"
    # Another operator rolls the canary back to 0 right after the first command of this raise touches the record.
    probe = ctx.redis_after(KEY, lambda: ctx.redis.hset(KEY, "percentage", 0))
    r = await _rollout(ctx, m, 4, 50)
    assert probe.fired, f"the raise never touched {KEY}"
    assert r.status_code in (200, 409), f"the raise answered {r.status_code}: {r.text}"
    assert _record(ctx).get("percentage") == "0", f"another operator rolled v4 back to 0 % while this raise to 50 % was in flight, and {KEY} now says {_record(ctx).get('percentage')} %: the raise read the record, then overwrote the rollback. Read, gate and write in one Lua script"
`,
    typescript: `const AUTH = {Authorization: 'Bearer ops'};
const KEY = 'rollout:auto';

const seed = (ctx, canary = 4, percentage = 10) => ctx.redis.hset(KEY, 'stable', 3, 'canary', canary, 'percentage', percentage);
const evaluation = (ctx, version: number, status: string, score: number) => ctx.redis.hset(\`eval:auto:\${version}\`, 'status', status, 'score', score);
const record = (ctx): Record<string, string> => ctx.redis.hgetall(KEY);

function rollouts(ctx) {
  const m = ctx.load('rollout');
  const c = ctx.client(m.app);
  return (version: number, percentage: number, policy = 'auto', headers: Record<string, string> = AUTH) =>
    c.post(\`/v1/policies/\${policy}/rollout\`, {body: {version, percentage}, headers});
}

export async function check_route(ctx) {
  const rollout = rollouts(ctx);
  seed(ctx);
  evaluation(ctx, 4, 'passed', 0.92);
  const r = await rollout(4, 25);
  assert.equal(r.status, 200, \`raising v4 from 10 % to 25 % with a passing eval answered \${r.status}: \${r.text}\`);
  const expected = {policy: 'auto', stable: 3, canary: 4, percentage: 25};
  assert.deepStrictEqual(r.json(), expected, \`the answer is \${r.text}, expected the rollout record after the change \${JSON.stringify(expected)}\`);
  assert.equal(record(ctx).percentage, '25', \`\${KEY} is \${JSON.stringify(record(ctx))} after the change, expected percentage 25\`);
  const anonymous = await rollout(4, 30, 'auto', {});
  assert.equal(anonymous.status, 401, \`a rollout without a bearer token answered \${anonymous.status}, expected 401\`);
}

export async function check_validate(ctx) {
  const rollout = rollouts(ctx);
  seed(ctx);
  evaluation(ctx, 4, 'passed', 0.92);
  const bad: [string, string, number, number][] = [
    ['percentage 101', 'auto', 4, 101],
    ['percentage -5', 'auto', 4, -5],
    ['version 0', 'auto', 0, 10],
    ['the policy name AUTO', 'AUTO', 4, 20],
    ['the policy name x', 'x', 4, 20],
  ];
  for (const [what, policy, version, percentage] of bad) {
    const r = await rollout(version, percentage, policy);
    assert.equal(r.status, 400, \`\${what} answered \${r.status}, expected 400\`);
  }
  assert.deepStrictEqual(record(ctx), {stable: '3', canary: '4', percentage: '10'}, \`rejected requests changed \${KEY}: \${JSON.stringify(record(ctx))}\`);
  assert.deepStrictEqual(ctx.redis.keys('rollout:*').sort(), [KEY], \`rejected requests wrote rollout records: \${JSON.stringify(ctx.redis.keys('rollout:*').sort())}\`);
}

export async function check_eval_gate(ctx) {
  const rollout = rollouts(ctx);
  seed(ctx);
  evaluation(ctx, 5, 'passed', 0.7);
  let r = await rollout(5, 20);
  assert.equal(r.status, 409, \`v5 passed its eval with score 0.70 and a rollout to 20 % answered \${r.status}, expected 409: the score must be at least 0.85\`);
  r = await rollout(6, 20);
  assert.equal(r.status, 409, \`v6 has no eval record and a rollout to 20 % answered \${r.status}, expected 409\`);
  evaluation(ctx, 4, 'failed', 0.91);
  r = await rollout(4, 30);
  assert.equal(r.status, 409, \`raising v4 from 10 % to 30 % with a failed eval answered \${r.status}, expected 409\`);
  assert.deepStrictEqual(record(ctx), {stable: '3', canary: '4', percentage: '10'}, \`refused rollouts changed \${KEY}: \${JSON.stringify(record(ctx))}\`);
  evaluation(ctx, 5, 'passed', 0.85);
  r = await rollout(5, 20);
  assert.equal(r.status, 200, \`v5 with a passing eval at exactly 0.85 answered \${r.status}: \${r.text}\`);
  assert(record(ctx).canary === '5' && record(ctx).percentage === '20', \`\${KEY} is \${JSON.stringify(record(ctx))}, expected canary 5 at 20 %\`);
}

export async function check_rollback(ctx) {
  const rollout = rollouts(ctx);
  seed(ctx, 4, 25);
  evaluation(ctx, 4, 'failed', 0.41);
  let r = await rollout(4, 5);
  assert.equal(r.status, 200, \`lowering canary v4 from 25 % to 5 % (its eval now fails) answered \${r.status}: a rollback must not wait for a passing eval\`);
  assert.equal(record(ctx).percentage, '5', \`\${KEY} is \${JSON.stringify(record(ctx))} after the rollback to 5 %\`);
  r = await rollout(4, 0);
  assert(r.status === 200 && record(ctx).percentage === '0', \`rolling v4 back to 0 % answered \${r.status} and left \${JSON.stringify(record(ctx))}\`);
  r = await rollout(7, 3);
  assert.equal(r.status, 409, \`sending 3 % to v7, which has no eval, answered \${r.status}: only lowering the current canary skips the gate\`);
}

export async function check_no_lost_update(ctx) {
  const rollout = rollouts(ctx);
  seed(ctx);
  evaluation(ctx, 4, 'passed', 0.92);
  const warm = await rollout(4, 10);
  assert.equal(warm.status, 200, \`re-applying v4 at its current 10 % answered \${warm.status}: \${warm.text}\`);
  // Another operator rolls the canary back to 0 right after the first command of this raise touches the record.
  const probe = ctx.redisAfter(KEY, () => ctx.redis.hset(KEY, 'percentage', 0));
  const r = await rollout(4, 50);
  assert(probe.fired, \`the raise never touched \${KEY}\`);
  assert([200, 409].includes(r.status), \`the raise answered \${r.status}: \${r.text}\`);
  assert.equal(record(ctx).percentage, '0', \`another operator rolled v4 back to 0 % while this raise to 50 % was in flight, and \${KEY} now says \${record(ctx).percentage} %: the raise read the record, then overwrote the rollback. Read, gate and write in one Lua script\`);
}
`,
    go: `package main

import (
	"fmt"
	"net/http"

	"leetbuild/harness"
)

const rolloutKey = "rollout:auto"

func rolloutServer(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func rolloutSeed(ctx *harness.Ctx, canary, percentage int) {
	ctx.Redis.Do("HSET", rolloutKey, "stable", 3, "canary", canary, "percentage", percentage)
}

func rolloutEval(ctx *harness.Ctx, version int, status string, score float64) {
	ctx.Redis.Do("HSET", fmt.Sprintf("eval:auto:%d", version), "status", status, "score", score)
}

func rolloutPost(c *harness.HTTP, policy string, version, percentage int) *harness.Response {
	return c.Post("/v1/policies/"+policy+"/rollout", map[string]any{"version": version, "percentage": percentage}, "Authorization", "Bearer ops", "Content-Type", "application/json")
}

func CheckRoute(ctx *harness.Ctx) {
	c := rolloutServer(ctx)
	rolloutSeed(ctx, 4, 10)
	rolloutEval(ctx, 4, "passed", 0.92)
	r := rolloutPost(c, "auto", 4, 25)
	ctx.Equal(r.Status, 200, "raising v4 from 10 %% to 25 %% with a passing eval (%s)", r.Text())
	ctx.Equal(r.JSON(), map[string]any{"policy": "auto", "stable": 3, "canary": 4, "percentage": 25}, "the answer must be the rollout record after the change")
	ctx.Equal(ctx.Redis.HGetAll(rolloutKey)["percentage"], "25", "%s percentage after the change", rolloutKey)
	anonymous := c.Post("/v1/policies/auto/rollout", map[string]any{"version": 4, "percentage": 30}, "Content-Type", "application/json")
	ctx.Equal(anonymous.Status, 401, "a rollout without a bearer token")
}

func CheckValidate(ctx *harness.Ctx) {
	c := rolloutServer(ctx)
	rolloutSeed(ctx, 4, 10)
	rolloutEval(ctx, 4, "passed", 0.92)
	bad := []struct {
		what                string
		policy              string
		version, percentage int
	}{
		{"percentage 101", "auto", 4, 101},
		{"percentage -5", "auto", 4, -5},
		{"version 0", "auto", 0, 10},
		{"the policy name AUTO", "AUTO", 4, 20},
		{"the policy name x", "x", 4, 20},
	}
	for _, b := range bad {
		r := rolloutPost(c, b.policy, b.version, b.percentage)
		ctx.Equal(r.Status, 400, "%s", b.what)
	}
	ctx.Equal(ctx.Redis.HGetAll(rolloutKey), map[string]string{"stable": "3", "canary": "4", "percentage": "10"}, "rejected requests must not change %s", rolloutKey)
	ctx.Equal(ctx.Redis.Keys("rollout:*"), []string{rolloutKey}, "rejected requests must write no rollout record; the records")
}

func CheckEvalGate(ctx *harness.Ctx) {
	c := rolloutServer(ctx)
	rolloutSeed(ctx, 4, 10)
	rolloutEval(ctx, 5, "passed", 0.70)
	r := rolloutPost(c, "auto", 5, 20)
	ctx.Equal(r.Status, 409, "v5 passed its eval with score 0.70 and a rollout to 20 %% (the score must be at least 0.85)")
	r = rolloutPost(c, "auto", 6, 20)
	ctx.Equal(r.Status, 409, "v6 has no eval record and a rollout to 20 %%")
	rolloutEval(ctx, 4, "failed", 0.91)
	r = rolloutPost(c, "auto", 4, 30)
	ctx.Equal(r.Status, 409, "raising v4 from 10 %% to 30 %% with a failed eval")
	ctx.Equal(ctx.Redis.HGetAll(rolloutKey), map[string]string{"stable": "3", "canary": "4", "percentage": "10"}, "refused rollouts must not change %s", rolloutKey)
	rolloutEval(ctx, 5, "passed", 0.85)
	r = rolloutPost(c, "auto", 5, 20)
	ctx.Equal(r.Status, 200, "v5 with a passing eval at exactly 0.85 (%s)", r.Text())
	record := ctx.Redis.HGetAll(rolloutKey)
	ctx.Assert(record["canary"] == "5" && record["percentage"] == "20", "%s is %v, expected canary 5 at 20 %%", rolloutKey, record)
}

func CheckRollback(ctx *harness.Ctx) {
	c := rolloutServer(ctx)
	rolloutSeed(ctx, 4, 25)
	rolloutEval(ctx, 4, "failed", 0.41)
	r := rolloutPost(c, "auto", 4, 5)
	ctx.Equal(r.Status, 200, "lowering canary v4 from 25 %% to 5 %% (its eval now fails; a rollback must not wait for a passing eval)")
	ctx.Equal(ctx.Redis.HGetAll(rolloutKey)["percentage"], "5", "%s percentage after the rollback to 5 %%", rolloutKey)
	r = rolloutPost(c, "auto", 4, 0)
	ctx.Assert(r.Status == 200 && ctx.Redis.HGetAll(rolloutKey)["percentage"] == "0", "rolling v4 back to 0 %% answered %d and left %v", r.Status, ctx.Redis.HGetAll(rolloutKey))
	r = rolloutPost(c, "auto", 7, 3)
	ctx.Equal(r.Status, 409, "sending 3 %% to v7, which has no eval (only lowering the current canary skips the gate)")
}

func CheckNoLostUpdate(ctx *harness.Ctx) {
	c := rolloutServer(ctx)
	rolloutSeed(ctx, 4, 10)
	rolloutEval(ctx, 4, "passed", 0.92)
	warm := rolloutPost(c, "auto", 4, 10)
	ctx.Equal(warm.Status, 200, "re-applying v4 at its current 10 %% (%s)", warm.Text())
	// Another operator rolls the canary back to 0 right after the first command of this raise touches the record.
	fired := false
	ctx.Redis.After(rolloutKey, func() any {
		fired = true
		return ctx.Redis.Do("HSET", rolloutKey, "percentage", 0)
	})
	r := rolloutPost(c, "auto", 4, 50)
	ctx.Assert(fired, "the raise never touched %s", rolloutKey)
	ctx.Assert(r.Status == 200 || r.Status == 409, "the raise answered %d: %s", r.Status, r.Text())
	got := ctx.Redis.HGetAll(rolloutKey)["percentage"]
	ctx.Assert(got == "0", "another operator rolled v4 back to 0 %% while this raise to 50 %% was in flight, and %s now says %s %%: the raise read the record, then overwrote the rollback. Read, gate and write in one Lua script", rolloutKey, got)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <map>
#include <string>
#include <vector>

namespace {

const std::string kRolloutKey = "rollout:auto";

harness::HTTP rolloutServer(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

void rolloutSeed(harness::Ctx& ctx, int canary = 4, int percentage = 10) {
  ctx.Redis.Do("HSET", kRolloutKey, "stable", 3, "canary", canary, "percentage", percentage);
}

void rolloutEval(harness::Ctx& ctx, int version, const std::string& status, const std::string& score) {
  ctx.Redis.Do("HSET", "eval:auto:" + std::to_string(version), "status", status, "score", score);
}

harness::Response rolloutPost(harness::HTTP& c, int version, int percentage, const std::string& policy = "auto") {
  const std::string body = R"({"version":)" + std::to_string(version) + R"(,"percentage":)" + std::to_string(percentage) + "}";
  return c.Post("/v1/policies/" + policy + "/rollout", body, "Authorization", "Bearer ops", "Content-Type", "application/json");
}

std::map<std::string, std::string> rolloutRecord(harness::Ctx& ctx) { return ctx.Redis.HGetAll(kRolloutKey); }

const std::map<std::string, std::string> kSeeded = {{"stable", "3"}, {"canary", "4"}, {"percentage", "10"}};

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = rolloutServer(ctx);
  rolloutSeed(ctx);
  rolloutEval(ctx, 4, "passed", "0.92");
  const auto r = rolloutPost(c, 4, 25);
  ctx.Equal(r.Status, 200, "raising v4 from 10 %% to 25 %% with a passing eval (%s)", r.Text());
  const nlohmann::json expected = {{"policy", "auto"}, {"stable", 3}, {"canary", 4}, {"percentage", 25}};
  const auto out = nlohmann::json::parse(r.Text(), nullptr, false);
  ctx.Assert(out == expected, "the answer is %s, expected the rollout record after the change %s", r.Text(), expected.dump());
  ctx.Equal(rolloutRecord(ctx)["percentage"], "25", "%s percentage after the change", kRolloutKey);
  const auto anonymous = c.Post("/v1/policies/auto/rollout", R"({"version":4,"percentage":30})", "Content-Type", "application/json");
  ctx.Equal(anonymous.Status, 401, "a rollout without a bearer token");
}

void CheckValidate(harness::Ctx& ctx) {
  auto c = rolloutServer(ctx);
  rolloutSeed(ctx);
  rolloutEval(ctx, 4, "passed", "0.92");
  struct Bad {
    std::string what, policy;
    int version, percentage;
  };
  const std::vector<Bad> bad = {
      {"percentage 101", "auto", 4, 101},
      {"percentage -5", "auto", 4, -5},
      {"version 0", "auto", 0, 10},
      {"the policy name AUTO", "AUTO", 4, 20},
      {"the policy name x", "x", 4, 20},
  };
  for (const auto& b : bad) {
    const auto r = rolloutPost(c, b.version, b.percentage, b.policy);
    ctx.Equal(r.Status, 400, "%s", b.what);
  }
  ctx.Assert(rolloutRecord(ctx) == kSeeded, "rejected requests changed %s: %v", kRolloutKey, rolloutRecord(ctx));
  ctx.Equal(ctx.Redis.Keys("rollout:*"), {kRolloutKey}, "rejected requests must write no rollout record; the records");
}

void CheckEvalGate(harness::Ctx& ctx) {
  auto c = rolloutServer(ctx);
  rolloutSeed(ctx);
  rolloutEval(ctx, 5, "passed", "0.70");
  auto r = rolloutPost(c, 5, 20);
  ctx.Equal(r.Status, 409, "v5 passed its eval with score 0.70 and a rollout to 20 %% (the score must be at least 0.85)");
  r = rolloutPost(c, 6, 20);
  ctx.Equal(r.Status, 409, "v6 has no eval record and a rollout to 20 %%");
  rolloutEval(ctx, 4, "failed", "0.91");
  r = rolloutPost(c, 4, 30);
  ctx.Equal(r.Status, 409, "raising v4 from 10 %% to 30 %% with a failed eval");
  ctx.Assert(rolloutRecord(ctx) == kSeeded, "refused rollouts changed %s: %v", kRolloutKey, rolloutRecord(ctx));
  rolloutEval(ctx, 5, "passed", "0.85");
  r = rolloutPost(c, 5, 20);
  ctx.Equal(r.Status, 200, "v5 with a passing eval at exactly 0.85 (%s)", r.Text());
  auto record = rolloutRecord(ctx);
  ctx.Assert(record["canary"] == "5" && record["percentage"] == "20", "%s is %v, expected canary 5 at 20 %%", kRolloutKey, record);
}

void CheckRollback(harness::Ctx& ctx) {
  auto c = rolloutServer(ctx);
  rolloutSeed(ctx, 4, 25);
  rolloutEval(ctx, 4, "failed", "0.41");
  auto r = rolloutPost(c, 4, 5);
  ctx.Equal(r.Status, 200, "lowering canary v4 from 25 %% to 5 %% (its eval now fails; a rollback must not wait for a passing eval)");
  ctx.Equal(rolloutRecord(ctx)["percentage"], "5", "%s percentage after the rollback to 5 %%", kRolloutKey);
  r = rolloutPost(c, 4, 0);
  ctx.Assert(r.Status == 200 && rolloutRecord(ctx)["percentage"] == "0", "rolling v4 back to 0 %% answered %d and left %v", r.Status, rolloutRecord(ctx));
  r = rolloutPost(c, 7, 3);
  ctx.Equal(r.Status, 409, "sending 3 %% to v7, which has no eval (only lowering the current canary skips the gate)");
}

void CheckNoLostUpdate(harness::Ctx& ctx) {
  auto c = rolloutServer(ctx);
  rolloutSeed(ctx);
  rolloutEval(ctx, 4, "passed", "0.92");
  const auto warm = rolloutPost(c, 4, 10);
  ctx.Equal(warm.Status, 200, "re-applying v4 at its current 10 %% (%s)", warm.Text());
  // Another operator rolls the canary back to 0 right after the first command of this raise touches the record.
  bool fired = false;
  ctx.Redis.After(kRolloutKey, [&] {
    fired = true;
    ctx.Redis.Do("HSET", kRolloutKey, "percentage", 0);
  });
  const auto r = rolloutPost(c, 4, 50);
  ctx.Assert(fired, "the raise never touched %s", kRolloutKey);
  ctx.Assert(r.Status == 200 || r.Status == 409, "the raise answered %d: %s", r.Status, r.Text());
  const std::string got = rolloutRecord(ctx)["percentage"];
  ctx.Assert(got == "0", "another operator rolled v4 back to 0 %% while this raise to 50 %% was in flight, and %s now says %s %%: the raise read the record, then overwrote the rollback. Read, gate and write in one Lua script", kRolloutKey, got);
}
`,
  },
  debrief: `The gate belongs to the change, not to the request: raising traffic or switching versions asks the eval to vouch for the target version, while lowering the current canary only reduces exposure, which is why a rollback skips it even after the eval has started failing. The score threshold is part of the gate because \`passed\` says the eval finished, not that the version is good enough. One script for the read, the decision and the write makes the decision about the record as it is, not as it was a round trip ago. Progressive-delivery controllers such as Argo Rollouts add analysis runs between weight steps that abort the rollout on a failed metric, and an audit trail of who moved the weight.`,
};
