import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis latest-version pointers with atomic promotion',
  concept: 'redis',
  file: 'state',
  focus: ['registry', 'redis', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft of the registry state module: it
keeps a latest-version pointer, records an audit entry, and moves consumer pins. It runs against a
local Redis, it serves the demo, and it hides three production flaws. Review it like the owner of the
pointer every training run reads, fix it, and prove the fix.

Implement \`POST /v1/datasets/{dataset}/promote\` over the dataset state below.

- \`latest_key(dataset)\` is the pointer training reads. It is **durable**: nothing ever sets a TTL on
  it, because a quiet week must not silently reset a dataset to "no version".
- \`promote(dataset, version, validator)\` swaps the pointer **and appends the audit record in one
  atomic unit** (one \`EVAL\`/\`MULTI\`) and returns the previous version. The draft does \`GET\`,
  \`SET\`, \`RPUSH\` and the pin rewrite as separate commands, so a promotion racing a purge leaves
  consumers pointing at purged bytes.
- \`pin(dataset, consumer, version)\` pins one consumer to a concrete version. A promotion must
  **never move a pin**: consumers that pinned a version keep reading that version.
- \`purge(dataset, version)\` refuses to delete a version any consumer still pins (\`VersionPinned\`).
- \`latest(dataset)\` **fails closed**: a missing pointer raises \`LatestVersionMissing\` rather than
  returning an empty string that would look like an unversioned dataset.

**Failure mode the checks target.** Two writes that must be one are a race: between the \`SET\` of the
pointer and the pin rewrite, a purge sees pins it is about to move and deletes bytes a consumer is
still reading. The expiring pointer is quieter — the dataset does not break loudly, it just stops
having a latest version after an idle period, and training silently starts from nothing.`,
  sequence: {
    participants: ['Registry API', 'Registry state', 'Redis'],
    messages: [
      {from: 'Registry API', to: 'Registry state', label: 'promote(dataset, version, validator)', kind: 'sync'},
      {from: 'Registry state', to: 'Redis', label: 'EVAL promote.lua · GET+SET pointer · RPUSH audit', kind: 'sync'},
      {from: 'Redis', to: 'Registry state', label: 'previous version', kind: 'reply'},
      {from: 'Registry API', to: 'Registry state', label: 'latest(dataset)', kind: 'sync'},
      {from: 'Registry state', to: 'Redis', label: 'GET ds:{dataset}:latest (durable)', kind: 'sync'},
      {from: 'Registry state', to: 'Registry API', label: 'version · or LatestVersionMissing', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Registers POST /v1/datasets/{dataset}/promote',
      detail: 'Expose promotion on `POST /v1/datasets/{dataset}/promote`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/datasets\/\{dataset\}\/promote["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/datasets\/:dataset\/promote['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/datasets\/\{dataset\}\/promote"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"datasets"\s*\/\s*Segment\s*\/\s*"promote"\s*\)/]},
        cpp: {all: [/svr\.Post\(/, /\/v1\/datasets/, /promote/]},
      },
    },
    {
      id: 'atomic-promotion',
      title: 'Pointer swap and audit record are one unit',
      detail:
        'The pointer swap and the audit append run in one server-side script (`_PROMOTE_LUA`), so a purge cannot observe a half-applied promotion. The draft separates them into independent commands.',
      match: {
        python: {all: [/_PROMOTE_LUA/, /redis\.eval\(\s*_PROMOTE_LUA/]},
        typescript: {all: [/PROMOTE_LUA/, /\.eval\(\s*PROMOTE_LUA/]},
        go: {all: [/promoteLua/, /\.Eval\(/]},
        scala: {all: [/PromoteLua/, /\.eval\(/]},
        cpp: {all: [/kPromoteLua/, /\.eval\b/]},
      },
    },
    {
      id: 'durable-pointer',
      title: 'The latest pointer never expires',
      detail:
        '`latest_key(dataset)` is written without a TTL and nothing calls `expire`/`EXPIRE` on it. The draft sets a 3600-second expiry, so an idle dataset loses its latest version.',
      match: {
        python: {all: [/def latest_key\(/], none: [/\.expire\(\s*[^)]*latest_key\(/]},
        typescript: {all: [/function latestKey\(/], none: [/\.expire\(\s*[^)]*latestKey\(/]},
        go: {all: [/func latestKey\(/], none: [/\.Expire\(\s*[^)]*latestKey\(/]},
        scala: {all: [/def latestKey\(/], none: [/\.expire\(\s*[^)]*latestKey\(/]},
        cpp: {all: [/latestKey\(/], none: [/\.expire\(\s*[^)]*latestKey\(/]},
      },
    },
    {
      id: 'fail-closed',
      title: 'A missing pointer fails closed',
      detail:
        'Reading the latest version raises `LatestVersionMissing` when the pointer is absent instead of serving an unversioned view. The draft returns an empty string, which a caller reads as "latest".',
      match: {
        python: {all: [/LatestVersionMissing/, /is None/]},
        typescript: {all: [/LatestVersionMissing/, /===\s*null/]},
        go: {all: [/ErrLatestVersionMissing/, /!= nil/]},
        scala: {all: [/LatestVersionMissing/, /case None/]},
        cpp: {all: [/LatestVersionMissing/, /has_value\(\)/]},
      },
    },
    {
      id: 'pins-independent',
      title: 'Pins survive promotion and block purge',
      detail:
        'Consumers pin a version under their own key, and `purge` refuses a version any consumer still pins (`VersionPinned`). The draft rewrites every pin to the new version inside the promotion, so a pinned consumer silently moves.',
      match: {
        python: {all: [/def purge\(/, /VersionPinned/]},
        typescript: {all: [/function purge\(/, /VersionPinned/]},
        go: {all: [/func purge\(/, /ErrVersionPinned/]},
        scala: {all: [/def purge\(/, /VersionPinned/]},
        cpp: {all: [/void purge\(/, /VersionPinned/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import logging

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from redis import Redis

app = FastAPI()
logger = logging.getLogger("registry-state")
redis = Redis(host="127.0.0.1", port=6379, decode_responses=True)

POINTER_TTL_S = 3600


class PromoteRequest(BaseModel):
    version: str
    validator: str


def latest_key(dataset: str) -> str:
    return f"ds:{dataset}:latest"


def audit_key(dataset: str) -> str:
    return f"ds:{dataset}:audit"


def pins_key(dataset: str) -> str:
    return f"ds:{dataset}:pins"


def promote(dataset: str, version: str, validator: str) -> str:
    # TODO: this draft writes the pointer, the audit record and the consumer pins in separate
    # commands, so a promotion racing a purge leaves consumers pointing at purged data, and it
    # expires the pointer key so a quiet period resets the dataset to nothing. Review both.
    previous = redis.get(latest_key(dataset))
    redis.set(latest_key(dataset), version)
    redis.expire(latest_key(dataset), POINTER_TTL_S)
    redis.rpush(audit_key(dataset), json.dumps({"dataset": dataset, "version": version, "validator": validator}))
    for consumer in redis.hkeys(pins_key(dataset)):
        redis.hset(pins_key(dataset), consumer, version)
    return previous if previous is None else str(previous)


def latest(dataset: str) -> str:
    current = redis.get(latest_key(dataset))
    return current if current is not None else ""


@app.post("/v1/datasets/{dataset}/promote")
def promote_version(
    dataset: str, body: PromoteRequest, tenant: str = Header(alias="X-Tenant-Id")
) -> JSONResponse:
    previous = promote(dataset, body.version, body.validator)
    logger.info("promoted dataset=%s version=%s", dataset, body.version)
    return JSONResponse({"dataset": dataset, "version": body.version, "previous": previous}, status_code=200)
`,
      solution: `import json
import logging

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from redis import Redis

app = FastAPI()
logger = logging.getLogger("registry-state")
redis = Redis(host="127.0.0.1", port=6379, decode_responses=True)

PIN_TTL_S = 60 * 60 * 24 * 90

# one round trip: read the old pointer, swap it and append the audit record
_PROMOTE_LUA = """
local current = redis.call('GET', KEYS[1])
redis.call('SET', KEYS[1], ARGV[1])
redis.call('RPUSH', KEYS[2], ARGV[2])
return current
"""


class LatestVersionMissing(RuntimeError):
    """The dataset has no promoted version, so there is nothing to serve."""


class VersionPinned(RuntimeError):
    """A consumer still pins this version, so purging it would break that consumer."""


class PromoteRequest(BaseModel):
    version: str
    validator: str


def latest_key(dataset: str) -> str:
    """The pointer training reads. Durable by contract: never given a TTL."""
    return f"ds:{dataset}:latest"


def audit_key(dataset: str) -> str:
    return f"ds:{dataset}:audit"


def pins_key(dataset: str) -> str:
    return f"ds:{dataset}:pins"


def promote(dataset: str, version: str, validator: str) -> str | None:
    """Swap the pointer and append the audit record as one atomic unit."""
    audit = json.dumps({"dataset": dataset, "version": version, "validator": validator})
    previous = redis.eval(_PROMOTE_LUA, 2, latest_key(dataset), audit_key(dataset), version, audit)
    return previous if previous is None else str(previous)


def latest(dataset: str) -> str:
    """Fail closed: never serve an unversioned view of a dataset."""
    current = redis.get(latest_key(dataset))
    if current is None:
        raise LatestVersionMissing(dataset)
    return current


def pin(dataset: str, consumer: str, version: str) -> None:
    """Pin one consumer to a concrete version; a promotion never moves it."""
    redis.hset(pins_key(dataset), consumer, version)
    redis.expire(pins_key(dataset), PIN_TTL_S)


def purge(dataset: str, version: str) -> None:
    """Refuse to purge a version any consumer still pins."""
    pinned = redis.hvals(pins_key(dataset))
    if version in pinned:
        raise VersionPinned(version)
    redis.delete(f"ds:{dataset}:objects:{version}")


@app.post("/v1/datasets/{dataset}/promote")
def promote_version(
    dataset: str, body: PromoteRequest, tenant: str | None = Header(default=None, alias="X-Tenant-Id")
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    previous = promote(dataset, body.version, body.validator)
    logger.info("promoted dataset=%s version=%s", dataset, body.version)
    return JSONResponse({"dataset": dataset, "version": body.version, "previous": previous}, status_code=200)
`,
    },
    typescript: {
      starter: `/** Latest-version pointers and consumer pins: a model-generated draft. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
export const redis = new Redis({host: '127.0.0.1', port: 6379});

const POINTER_TTL_S = 3600;

interface PromoteBody {
  version: string;
  validator: string;
}

function latestKey(dataset: string): string {
  return \`ds:\${dataset}:latest\`;
}

function auditKey(dataset: string): string {
  return \`ds:\${dataset}:audit\`;
}

function pinsKey(dataset: string): string {
  return \`ds:\${dataset}:pins\`;
}

async function promote(dataset: string, version: string, validator: string): Promise<string> {
  // TODO: this draft writes the pointer, the audit record and the consumer pins in separate
  // commands, so a promotion racing a purge leaves consumers pointing at purged data, and it
  // expires the pointer key so a quiet period resets the dataset to nothing. Review both.
  const previous = await redis.get(latestKey(dataset));
  await redis.set(latestKey(dataset), version);
  await redis.expire(latestKey(dataset), POINTER_TTL_S);
  await redis.rpush(auditKey(dataset), JSON.stringify({dataset, version, validator}));
  for (const consumer of await redis.hkeys(pinsKey(dataset)))
    await redis.hset(pinsKey(dataset), consumer, version);
  return previous ?? '';
}

async function latest(dataset: string): Promise<string> {
  const current = await redis.get(latestKey(dataset));
  return current ?? '';
}

app.post('/v1/datasets/:dataset/promote', async (request, reply) => {
  const dataset = (request.params as {dataset: string}).dataset;
  const body = request.body as PromoteBody;
  const previous = await promote(dataset, body.version, body.validator);
  return reply.code(200).send({dataset, version: body.version, previous});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** Latest-version pointers with atomic promotion and pins that never move. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
export const redis = new Redis({host: '127.0.0.1', port: 6379});

const PIN_TTL_S = 60 * 60 * 24 * 90;

// one round trip: read the old pointer, swap it and append the audit record
const PROMOTE_LUA = [
  "local current = redis.call('GET', KEYS[1])",
  "redis.call('SET', KEYS[1], ARGV[1])",
  "redis.call('RPUSH', KEYS[2], ARGV[2])",
  'return current',
].join('\\n');

export class LatestVersionMissing extends Error {}
export class VersionPinned extends Error {}

interface PromoteBody {
  version: string;
  validator: string;
}

function latestKey(dataset: string): string {
  // The pointer training reads. Durable by contract: never given a TTL.
  return \`ds:\${dataset}:latest\`;
}

function auditKey(dataset: string): string {
  return \`ds:\${dataset}:audit\`;
}

function pinsKey(dataset: string): string {
  return \`ds:\${dataset}:pins\`;
}

async function promote(dataset: string, version: string, validator: string): Promise<string | null> {
  const audit = JSON.stringify({dataset, version, validator});
  const previous = await redis.eval(PROMOTE_LUA, 2, latestKey(dataset), auditKey(dataset), version, audit);
  return typeof previous === 'string' ? previous : null;
}

async function latest(dataset: string): Promise<string> {
  const current = await redis.get(latestKey(dataset));
  if (current === null) throw new LatestVersionMissing(dataset);
  return current;
}

async function pin(dataset: string, consumer: string, version: string): Promise<void> {
  await redis.hset(pinsKey(dataset), consumer, version);
  await redis.expire(pinsKey(dataset), PIN_TTL_S);
}

async function purge(dataset: string, version: string): Promise<void> {
  const pinned = await redis.hvals(pinsKey(dataset));
  if (pinned.includes(version)) throw new VersionPinned(version);
  await redis.del(\`ds:\${dataset}:objects:\${version}\`);
}

app.post('/v1/datasets/:dataset/promote', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '')
    return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const dataset = (request.params as {dataset: string}).dataset;
  const body = request.body as PromoteBody;
  const previous = await promote(dataset, body.version, body.validator);
  request.log.info({dataset, version: body.version}, 'promoted');
  return reply.code(200).send({dataset, version: body.version, previous});
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

const pointerTTLS = 3600 * time.Second

func latestKey(dataset string) string { return "ds:" + dataset + ":latest" }
func auditKey(dataset string) string  { return "ds:" + dataset + ":audit" }
func pinsKey(dataset string) string   { return "ds:" + dataset + ":pins" }

func promote(ctx context.Context, rdb *redis.Client, dataset, version, validator string) (string, error) {
	// TODO: this draft writes the pointer, the audit record and the consumer pins in separate
	// commands, so a promotion racing a purge leaves consumers pointing at purged data, and it
	// expires the pointer key so a quiet period resets the dataset to nothing. Review both.
	previous, err := rdb.Get(ctx, latestKey(dataset)).Result()
	if err != nil && err != redis.Nil {
		return "", err
	}
	if err := rdb.Set(ctx, latestKey(dataset), version, 0).Err(); err != nil {
		return "", err
	}
	if err := rdb.Expire(ctx, latestKey(dataset), pointerTTLS).Err(); err != nil {
		return "", err
	}
	audit, _ := json.Marshal(map[string]string{"dataset": dataset, "version": version, "validator": validator})
	if err := rdb.RPush(ctx, auditKey(dataset), audit).Err(); err != nil {
		return "", err
	}
	consumers, err := rdb.HKeys(ctx, pinsKey(dataset)).Result()
	if err != nil {
		return "", err
	}
	for _, consumer := range consumers {
		if err := rdb.HSet(ctx, pinsKey(dataset), consumer, version).Err(); err != nil {
			return "", err
		}
	}
	return previous, nil
}

func latest(ctx context.Context, rdb *redis.Client, dataset string) (string, error) {
	current, err := rdb.Get(ctx, latestKey(dataset)).Result()
	if err != nil {
		return "", err
	}
	return current, nil
}

func main() {
	rdb := redis.NewClient(&redis.Options{Addr: "127.0.0.1:6379"})
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/datasets/{dataset}/promote", func(rw http.ResponseWriter, r *http.Request) {
		var body map[string]string
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(rw, "invalid json", http.StatusBadRequest)
			return
		}
		previous, err := promote(r.Context(), rdb, r.PathValue("dataset"), body["version"], body["validator"])
		if err != nil {
			http.Error(rw, "TRY_AGAIN", http.StatusServiceUnavailable)
			return
		}
		rw.Header().Set("Content-Type", "application/json")
		json.NewEncoder(rw).Encode(map[string]any{"previous": previous})
	})
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"
)

const pinTTLS = 60 * 60 * 24 * 90 * time.Second

// one round trip: read the old pointer, swap it and append the audit record
const promoteLua = \`
local current = redis.call('GET', KEYS[1])
redis.call('SET', KEYS[1], ARGV[1])
redis.call('RPUSH', KEYS[2], ARGV[2])
return current
\`

var (
	ErrLatestVersionMissing = errors.New("no promoted version for this dataset")
	ErrVersionPinned        = errors.New("version is still pinned by a consumer")
)

func latestKey(dataset string) string { return "ds:" + dataset + ":latest" }
func auditKey(dataset string) string  { return "ds:" + dataset + ":audit" }
func pinsKey(dataset string) string   { return "ds:" + dataset + ":pins" }

func promote(ctx context.Context, rdb *redis.Client, dataset, version, validator string) (string, error) {
	audit, err := json.Marshal(map[string]string{"dataset": dataset, "version": version, "validator": validator})
	if err != nil {
		return "", err
	}
	previous, err := rdb.Eval(ctx, promoteLua, []string{latestKey(dataset), auditKey(dataset)}, version, string(audit)).Result()
	if err != nil {
		return "", err
	}
	if previous == nil {
		return "", nil
	}
	return previous.(string), nil
}

func latest(ctx context.Context, rdb *redis.Client, dataset string) (string, error) {
	current, err := rdb.Get(ctx, latestKey(dataset)).Result()
	if err == redis.Nil || current == "" {
		return "", ErrLatestVersionMissing
	}
	if err != nil {
		return "", err
	}
	return current, nil
}

func pin(ctx context.Context, rdb *redis.Client, dataset, consumer, version string) error {
	if err := rdb.HSet(ctx, pinsKey(dataset), consumer, version).Err(); err != nil {
		return err
	}
	return rdb.Expire(ctx, pinsKey(dataset), pinTTLS).Err()
}

func purge(ctx context.Context, rdb *redis.Client, dataset, version string) error {
	consumers, err := rdb.HVals(ctx, pinsKey(dataset)).Result()
	if err != nil {
		return err
	}
	for _, pinned := range consumers {
		if pinned == version {
			return ErrVersionPinned
		}
	}
	return rdb.Del(ctx, "ds:"+dataset+":objects:"+version).Err()
}

func main() {
	rdb := redis.NewClient(&redis.Options{Addr: "127.0.0.1:6379"})
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/datasets/{dataset}/promote", func(rw http.ResponseWriter, r *http.Request) {
		var body map[string]string
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(rw, "invalid json", http.StatusBadRequest)
			return
		}
		previous, err := promote(r.Context(), rdb, r.PathValue("dataset"), body["version"], body["validator"])
		if err != nil {
			http.Error(rw, "TRY_AGAIN", http.StatusServiceUnavailable)
			return
		}
		rw.Header().Set("Content-Type", "application/json")
		json.NewEncoder(rw).Encode(map[string]any{"previous": previous})
	})
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
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

final case class PromoteRequest(version: String, validator: String)

object DatasetStateApi {
  implicit val system: ActorSystem = ActorSystem("dataset-registry")
  implicit val promoteFormat: RootJsonFormat[PromoteRequest] = jsonFormat2(PromoteRequest)

  val PointerTtlSeconds = 3600
  val jedis = new Jedis("127.0.0.1", 6379)

  def latestKey(dataset: String): String = s"ds:$dataset:latest"
  def auditKey(dataset: String): String = s"ds:$dataset:audit"
  def pinsKey(dataset: String): String = s"ds:$dataset:pins"

  def promote(dataset: String, version: String, validator: String): Option[String] = {
    // TODO: this draft writes the pointer, the audit record and the consumer pins in separate
    // commands, so a promotion racing a purge leaves consumers pointing at purged data, and it
    // expires the pointer key so a quiet period resets the dataset to nothing. Review both.
    val previous = Option(jedis.get(latestKey(dataset)))
    jedis.set(latestKey(dataset), version)
    jedis.expire(latestKey(dataset), PointerTtlSeconds)
    jedis.rpush(auditKey(dataset), s"""{"dataset":"$dataset","version":"$version","validator":"$validator"}""")
    val consumers = jedis.hkeys(pinsKey(dataset)).toArray(new Array[String](0))
    for (consumer <- consumers) jedis.hset(pinsKey(dataset), consumer, version)
    previous
  }

  def latest(dataset: String): String = Option(jedis.get(latestKey(dataset))).getOrElse("")

  val route: Route =
    path("v1" / "datasets" / Segment / "promote") { dataset =>
      post {
        entity(as[PromoteRequest]) { body =>
          val previous = promote(dataset, body.version, body.validator)
          system.log.info(s"promoted dataset=$dataset version=$previous")
          complete(StatusCodes.OK, s"""{"dataset":"$dataset","version":"\${body.version}"}""")
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
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class PromoteRequest(version: String, validator: String)

class LatestVersionMissing(dataset: String) extends RuntimeException(s"no promoted version for $dataset")
class VersionPinned(version: String) extends RuntimeException(s"$version is still pinned by a consumer")

object DatasetStateApi {
  implicit val system: ActorSystem = ActorSystem("dataset-registry")
  implicit val promoteFormat: RootJsonFormat[PromoteRequest] = jsonFormat2(PromoteRequest)

  val PinTtlSeconds = 60 * 60 * 24 * 90
  val jedis = new Jedis("127.0.0.1", 6379)

  // one round trip: read the old pointer, swap it and append the audit record
  val PromoteLua =
    """local current = redis.call('GET', KEYS[1])
      |redis.call('SET', KEYS[1], ARGV[1])
      |redis.call('RPUSH', KEYS[2], ARGV[2])
      |return current""".stripMargin

  def latestKey(dataset: String): String = s"ds:$dataset:latest"
  def auditKey(dataset: String): String = s"ds:$dataset:audit"
  def pinsKey(dataset: String): String = s"ds:$dataset:pins"

  def promote(dataset: String, version: String, validator: String): Option[String] = {
    val audit = s"""{"dataset":"$dataset","version":"$version","validator":"$validator"}"""
    Option(jedis.eval(PromoteLua, 2, latestKey(dataset), auditKey(dataset), version, audit)).map(_.toString)
  }

  def latest(dataset: String): String = jedis.get(latestKey(dataset)) match {
    case None => throw new LatestVersionMissing(dataset)
    case Some(version) => version
  }

  def pin(dataset: String, consumer: String, version: String): Unit = {
    jedis.hset(pinsKey(dataset), consumer, version)
    jedis.expire(pinsKey(dataset), PinTtlSeconds)
  }

  def purge(dataset: String, version: String): Unit = {
    val pinned = jedis.hvals(pinsKey(dataset)).toArray(new Array[String](0))
    if (pinned.contains(version)) throw new VersionPinned(version)
    jedis.del(s"ds:$dataset:objects:$version")
  }

  val route: Route =
    path("v1" / "datasets" / Segment / "promote") { dataset =>
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          entity(as[PromoteRequest]) { body =>
            if (!tenantOpt.exists(_.nonEmpty)) {
              complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
            } else {
              val previous = promote(dataset, body.version, body.validator)
              system.log.info(s"promoted dataset=$dataset version=\${body.version}")
              complete(StatusCodes.OK, s"""{"dataset":"$dataset","version":"\${body.version}"}""")
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

#include <iostream>
#include <optional>
#include <string>
#include <vector>

using json = nlohmann::json;
namespace redis = sw::redis;

const long kPointerTtlSeconds = 3600;

std::string latestKey(const std::string& dataset) { return "ds:" + dataset + ":latest"; }
std::string auditKey(const std::string& dataset) { return "ds:" + dataset + ":audit"; }
std::string pinsKey(const std::string& dataset) { return "ds:" + dataset + ":pins"; }

static std::optional<std::string> promote(redis::Redis& rdb, const std::string& dataset, const std::string& version,
                                         const std::string& validator) {
  // TODO: this draft writes the pointer, the audit record and the consumer pins in separate
  // commands, so a promotion racing a purge leaves consumers pointing at purged data, and it
  // expires the pointer key so a quiet period resets the dataset to nothing. Review both.
  const auto previous = rdb.get(latestKey(dataset));
  rdb.set(latestKey(dataset), version);
  rdb.expire(latestKey(dataset), kPointerTtlSeconds);
  rdb.rpush(auditKey(dataset), json{{"dataset", dataset}, {"version", version}, {"validator", validator}}.dump());
  const auto consumers = rdb.hkeys(pinsKey(dataset));
  for (const auto& consumer : consumers) rdb.hset(pinsKey(dataset), consumer, version);
  return previous;
}

static std::string latest(redis::Redis& rdb, const std::string& dataset) {
  const auto current = rdb.get(latestKey(dataset));
  return current ? *current : std::string();
}

int main() {
  redis::Redis rdb("tcp://127.0.0.1:6379");
  httplib::Server svr;

  svr.Post(R"(/v1/datasets/([^/]+)/promote)", [&rdb](const httplib::Request& req, httplib::Response& res) {
    const std::string dataset = req.matches[1];
    const json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    const auto previous = promote(rdb, dataset, body.value("version", std::string()),
                                  body.value("validator", std::string()));
    res.status = 200;
    res.set_content(json{{"dataset", dataset}, {"previous", previous ? *previous : ""}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <iostream>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

using json = nlohmann::json;
namespace redis = sw::redis;

const long kPinTtlSeconds = 60 * 60 * 24 * 90;

// one round trip: read the old pointer, swap it and append the audit record
const std::string kPromoteLua =
    "local current = redis.call('GET', KEYS[1])\\n"
    "redis.call('SET', KEYS[1], ARGV[1])\\n"
    "redis.call('RPUSH', KEYS[2], ARGV[2])\\n"
    "return current";

struct LatestVersionMissing : std::runtime_error {
  using std::runtime_error::runtime_error;
};
struct VersionPinned : std::runtime_error {
  using std::runtime_error::runtime_error;
};

std::string latestKey(const std::string& dataset) { return "ds:" + dataset + ":latest"; }
std::string auditKey(const std::string& dataset) { return "ds:" + dataset + ":audit"; }
std::string pinsKey(const std::string& dataset) { return "ds:" + dataset + ":pins"; }

static redis::OptionalString promote(redis::Redis& rdb, const std::string& dataset, const std::string& version,
                                     const std::string& validator) {
  const std::string audit = json{{"dataset", dataset}, {"version", version}, {"validator", validator}}.dump();
  return rdb.eval<redis::OptionalString>(kPromoteLua, {latestKey(dataset), auditKey(dataset)}, {version, audit});
}

static std::string latest(redis::Redis& rdb, const std::string& dataset) {
  const auto current = rdb.get(latestKey(dataset));
  if (!current.has_value()) throw LatestVersionMissing(dataset);
  return *current;
}

static void pin(redis::Redis& rdb, const std::string& dataset, const std::string& consumer,
                const std::string& version) {
  rdb.hset(pinsKey(dataset), consumer, version);
  rdb.expire(pinsKey(dataset), kPinTtlSeconds);
}

static void purge(redis::Redis& rdb, const std::string& dataset, const std::string& version) {
  const auto pinned = rdb.hvals(pinsKey(dataset));
  for (const auto& candidate : pinned) {
    if (candidate == version) throw VersionPinned(version);
  }
  rdb.del("ds:" + dataset + ":objects:" + version);
}

int main() {
  redis::Redis rdb("tcp://127.0.0.1:6379");
  httplib::Server svr;

  svr.Post(R"(/v1/datasets/([^/]+)/promote)", [&rdb](const httplib::Request& req, httplib::Response& res) {
    const std::string dataset = req.matches[1];
    const json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    const auto previous = promote(rdb, dataset, body.value("version", std::string()),
                                  body.value("validator", std::string()));
    res.status = 200;
    res.set_content(json{{"dataset", dataset}, {"previous", previous ? *previous : ""}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'One write, not four. Read the old pointer, `SET` the new one and `RPUSH` the audit entry inside a single Lua script, so no other client can observe the pointer swapped before the audit row exists.',
    'The pointer key has no expiry. Consumers move because they read the pointer, not because you rewrite their pins: a promotion that edits `pins` is moving a consumer that explicitly asked to stay put.',
    'A purge is only safe for a version nobody pins. `hvals(pins)` then `VersionPinned` is the guard; a read with no pointer is not an empty string, it is `LatestVersionMissing`, because an unversioned view is worse than an error.',
  ],
  debrief: `The interviewer is watching how you reason about Redis as a multi-writer store. The draft looks correct because the happy path has one writer and no purge. Three defects are checked: the promotion is not atomic (four commands where one script belongs, so a purge can interleave), the pointer expires (an idle dataset silently loses its latest version), and a read of a missing pointer returns an empty string, which callers treat as a version. Pins are the fourth idea, expressed through \`purge\` refusing a pinned version: a consumer pin is a lease, and leases are released by the consumer, never by a promotion. Real registries add a promotion token so a stale writer cannot promote over a newer one, a monotonic generation counter in the audit record, and lag-aware reads so a replica cannot serve an older pointer than the client already saw.`,
};
