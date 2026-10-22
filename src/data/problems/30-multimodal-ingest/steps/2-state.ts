import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis dedupe and per-tenant ingest quota',
  concept: 'redis',
  file: 'state',
  focus: ['ingest', 'redis', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it checks whether the content
hash was seen, counts the tenant's assets for the minute, and lets the demo through. It hides a race,
a leak and a wrong order of operations. Find them, fix them, and prove the fix.

Implement the reservation every registration goes through: the dedupe of \`(tenant, content hash)\`
and the per-tenant ingest quota.

- A registration is reserved under two keys: the dedupe key
  \`ingest:dedupe:{tenant}:{content_hash}\` and the minute counter
  \`ingest:quota:{tenant}:{window}\`, where \`window\` is the UTC minute bucket
  (\`floor(unix_seconds / 60)\`). A key without the tenant lets one tenant collide with another's
  content hash; a quota key without the window never resets.
- The tenant may register at most **500** assets per minute. The **501st** registration in a minute
  is refused with **429** and \`Retry-After\` (seconds left in the window), and it must not have
  consumed any of the tenant's budget.
- Dedupe check, registration mark and quota increment happen in **one atomic Lua script** executed
  with \`EVAL\`. A \`GET\` followed by a separate \`INCR\` leaves a window in which two concurrent
  requests both observe room that only one of them has.
- Both keys expire: the quota key with its window and the dedupe key after a day, set on the first
  write inside the same script. Without a TTL the dedupe map grows forever and a tenant that had one
  busy minute stays locked out.
- A duplicate — the same content hash reserved again before its TTL — is **not** a quota rejection:
  it returns the stored asset id (200) through the cache path and spends no quota, whatever the
  tenant's counter says.

**Failure mode the checks target.** Two concurrent registrations both pass the same check and the
tenant goes over quota; the keys without a TTL never reset; and a refusal that already consumed a
unit of the counter punishes the client for retrying. The subtlest one is the last: a dedupe check
placed *after* the quota increment turns a harmless re-upload into a quota rejection.`,
  sequence: {
    participants: ['Ingest API', 'Redis', 'Client'],
    messages: [
      {
        from: 'Ingest API',
        to: 'Redis',
        label: 'EVAL reserve · KEYS[ingest:dedupe:acme:sha256:…, ingest:quota:acme:29162240]',
        kind: 'sync',
      },
      {
        from: 'Redis',
        to: 'Ingest API',
        label: "{'duplicate', asset_id} · {'reserved'} · {'refused', ttl}",
        kind: 'reply',
      },
      {from: 'Ingest API', to: 'Client', label: '429 {Retry-After: ttl} when refused', kind: 'reply'},
      {from: 'Ingest API', to: 'Client', label: '200 deduped original asset_id', kind: 'reply'},
    ],
  },
  hints: [
    'All of it belongs on the Redis side of one round trip: read the dedupe key, compare the counter, increment, mark and expire inside a single `EVAL`. Two commands from the client is the race, no matter how fast the client is.',
    'The dedupe check must come first and return early: a duplicate is a cache hit, not a request for quota. Only a hash that has never been reserved may consume a unit of the tenant’s minute.',
    'Expire the quota key with its window (`EXPIRE` on first write, so a rejected window still cleans itself up) and the dedupe key with its retention (`86_400` seconds). A key that never expires is a leak in one case and a lockout in the other.',
  ],
  checks: [
    {
      id: 'dedupe-key',
      title: 'Keys dedupe and quota by tenant, hash and window',
      detail:
        'The dedupe key is `ingest:dedupe:{tenant}:{content_hash}` and the counter is `ingest:quota:{tenant}:{window}`. The draft keys dedupe on the hash alone — so two tenants collide — and keeps one tenant-wide counter that never resets.',
      match: {
        python: {all: [/ingest:dedupe:\{tenant\}:\{content_hash\}/, /ingest:quota:\{tenant\}:\{window\}/]},
        typescript: {all: [/ingest:dedupe:\$\{tenant\}:\$\{contentHash\}/, /ingest:quota:\$\{tenant\}:\$\{window\}/]},
        go: {all: [/ingest:dedupe:%s:%s/, /ingest:quota:%s/]},
        scala: {all: [/ingest:dedupe:\$tenant:\$contentHash/, /ingest:quota:\$tenant:\$window/]},
        cpp: {all: [/"ingest:dedupe:"/, /"ingest:quota:"/]},
      },
    },
    {
      id: 'atomic-script',
      title: 'Reserves with one atomic Lua script',
      detail:
        'Dedupe check, registration mark and quota increment run inside one `EVAL` of a server-side script. A client-side read followed by an increment races: two concurrent requests can both observe room that only one of them has.',
      match: {
        python: {all: [/RESERVE_LUA/, /redis\.call/, /\.eval\(/]},
        typescript: {all: [/RESERVE_LUA/, /redis\.call/, /\.eval\(/]},
        go: {all: [/reserveScript/, /redis\.call/, /\.Eval\(/]},
        scala: {all: [/ReserveLua/, /redis\.call/, /\.eval\(/]},
        cpp: {all: [/kReserveLua/, /redis\.call/, /\.eval/]},
      },
    },
    {
      id: 'ttl',
      title: 'Both keys expire on first write',
      detail:
        'The script sets the quota key’s expiry with its window and the dedupe key’s with its retention (`DEDUPE_TTL_S` / `QUOTA_TTL_S`), reading `TTL` before writing so the expiry is set once. Without it the dedupe map grows forever and a tenant stays over quota.',
      match: {
        python: {all: [/DEDUPE_TTL_S/, /QUOTA_TTL_S/, /'expire'/]},
        typescript: {all: [/DEDUPE_TTL_S/, /QUOTA_TTL_S/, /'expire'/]},
        go: {all: [/dedupeTtlSeconds/, /quotaTtlSeconds/, /'expire'/]},
        scala: {all: [/DedupeTtlSeconds/, /QuotaTtlSeconds/, /'expire'/]},
        cpp: {all: [/kDedupeTtlSeconds/, /kQuotaTtlSeconds/, /'expire'/]},
      },
    },
    {
      id: 'quota-429',
      title: 'Refuses the 501st asset of the minute with Retry-After',
      detail:
        'The counter is capped at `500` per minute and an exhausted tenant gets **429** with `Retry-After` built from the remaining TTL, before any asset row is written.',
      match: {
        python: {all: [/QUOTA_MAX\s*=\s*500/, /status_code\s*=\s*429/, /Retry-After/]},
        typescript: {all: [/QUOTA_MAX\s*=\s*500/, /code\(\s*429\s*\)/, /Retry-After/]},
        go: {all: [/quotaMax\s*=\s*500/, /StatusTooManyRequests/, /Retry-After/]},
        scala: {all: [/QuotaMax\s*=\s*500/, /StatusCodes\.TooManyRequests/, /Retry-After/]},
        cpp: {all: [/kQuotaMax\s*=\s*500/, /\b429\b/, /Retry-After/]},
      },
    },
    {
      id: 'duplicate-first',
      title: 'A duplicate is answered before the quota is spent',
      detail:
        'The script returns the stored asset for an existing dedupe key *before* it increments the counter, so a re-upload passes through the cache path even when the tenant is over quota. The draft charges first and dedupes afterwards.',
      match: {
        python: {all: [/ingest:dedupe/], order: [/duplicate/, /'incr'/]},
        typescript: {all: [/ingest:dedupe/], order: [/duplicate/, /'incr'/]},
        go: {all: [/ingest:dedupe/], order: [/duplicate/, /'incr'/]},
        scala: {all: [/ingest:dedupe/], order: [/duplicate/, /'incr'/]},
        cpp: {all: [/ingest:dedupe/], order: [/duplicate/, /'incr'/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""state.py — Redis dedupe and the ingest quota. A model-generated draft."""

import redis
from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

QUOTA_LIMIT = 500


class AssetRequest(BaseModel):
    mime: str
    byte_size: int
    checksum: str


def reserve(tenant: str, content_hash: str) -> tuple[bool, str]:
    # TODO: this draft checks the dedupe key with one GET and increments the counter with a second
    # command, so two concurrent registrations both observe room that only one of them has; neither
    # key ever expires, and the dedupe key ignores the tenant.
    key = f"ingest:{content_hash}"
    existing = r.get(key)
    if existing:
        return True, existing
    used = int(r.get(f"ingest:quota:{tenant}") or 0)
    if used >= QUOTA_LIMIT:
        return False, ""
    r.incr(f"ingest:quota:{tenant}")
    asset_id = f"asset_{content_hash[-12:]}"
    r.set(key, asset_id)
    return False, asset_id


@app.post("/v1/assets")
def create_asset(body: AssetRequest, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    deduped, asset_id = reserve(tenant, body.checksum)
    return JSONResponse({"asset_id": asset_id, "deduped": deduped}, status_code=200 if deduped else 201)
`,
      solution: `"""state.py — the Redis reservation behind POST /v1/assets: dedupe and the tenant quota."""

import time
import uuid

import redis
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

QUOTA_MAX = 500
QUOTA_WINDOW_S = 60
QUOTA_TTL_S = 120
DEDUPE_TTL_S = 86_400

RESERVE_LUA = """
local existing = redis.call('get', KEYS[1])
if existing then
  return {'duplicate', existing, 0}
end
local used = tonumber(redis.call('get', KEYS[2])) or 0
if used >= tonumber(ARGV[1]) then
  return {'refused', '', redis.call('ttl', KEYS[2])}
end
if used == 0 then
  redis.call('expire', KEYS[2], ARGV[3])
end
redis.call('incr', KEYS[2])
local asset_id = ARGV[4]
redis.call('set', KEYS[1], asset_id)
if redis.call('ttl', KEYS[1]) < 0 then
  redis.call('expire', KEYS[1], ARGV[2])
end
return {'reserved', asset_id, 0}
"""


class AssetRequest(BaseModel):
    mime: str
    byte_size: int
    checksum: str


def reserve(tenant: str, content_hash: str) -> tuple[str, str, int]:
    window = int(time.time()) // QUOTA_WINDOW_S
    dedupe_key = f"ingest:dedupe:{tenant}:{content_hash}"
    quota_key = f"ingest:quota:{tenant}:{window}"
    asset_id = f"asset_{uuid.uuid4().hex[:12]}"
    status, stored, ttl = r.eval(
        RESERVE_LUA, 2, dedupe_key, quota_key, QUOTA_MAX, DEDUPE_TTL_S, QUOTA_TTL_S, asset_id
    )
    return str(status), str(stored), int(ttl)


@app.post("/v1/assets")
def create_asset(body: AssetRequest, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    status, asset_id, ttl = reserve(tenant, body.checksum)
    if status == "refused":
        raise HTTPException(
            status_code=429,
            detail="tenant ingest quota exhausted",
            headers={"Retry-After": str(max(ttl, 1))},
        )
    deduped = status == "duplicate"
    return JSONResponse(
        {"asset_id": asset_id, "checksum": body.checksum, "deduped": deduped},
        status_code=200 if deduped else 201,
    )
`,
    },
    typescript: {
      starter: `/** state.ts — Redis dedupe and the ingest quota. A model-generated draft. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const QUOTA_LIMIT = 500;

interface AssetBody {
  mime: string;
  byte_size: number;
  checksum: string;
}

async function reserve(tenant: string, contentHash: string): Promise<[boolean, string]> {
  // TODO: this draft checks the dedupe key with one GET and increments the counter with a second
  // command, so two concurrent registrations both observe room that only one of them has; neither
  // key ever expires, and the dedupe key ignores the tenant.
  const key = 'ingest:' + contentHash;
  const existing = await r.get(key);
  if (existing !== null) return [true, existing];
  const used = Number((await r.get('ingest:quota:' + tenant)) ?? 0);
  if (used >= QUOTA_LIMIT) return [false, ''];
  await r.incr('ingest:quota:' + tenant);
  const assetId = 'asset_' + contentHash.slice(-12);
  await r.set(key, assetId);
  return [false, assetId];
}

app.post('/v1/assets', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as AssetBody;
  const [deduped, assetId] = await reserve(tenant, body.checksum);
  return reply.code(deduped ? 200 : 201).send({asset_id: assetId, deduped});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** state.ts — the Redis reservation behind POST /v1/assets: dedupe and the tenant quota. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const QUOTA_MAX = 500;
const QUOTA_WINDOW_S = 60;
const QUOTA_TTL_S = 120;
const DEDUPE_TTL_S = 86_400;

const RESERVE_LUA = \`
local existing = redis.call('get', KEYS[1])
if existing then
  return {'duplicate', existing, 0}
end
local used = tonumber(redis.call('get', KEYS[2])) or 0
if used >= tonumber(ARGV[1]) then
  return {'refused', '', redis.call('ttl', KEYS[2])}
end
if used == 0 then
  redis.call('expire', KEYS[2], ARGV[3])
end
redis.call('incr', KEYS[2])
local assetId = ARGV[4]
redis.call('set', KEYS[1], assetId)
if redis.call('ttl', KEYS[1]) < 0 then
  redis.call('expire', KEYS[1], ARGV[2])
end
return {'reserved', assetId, 0}
\`;

interface AssetBody {
  mime: string;
  byte_size: number;
  checksum: string;
}

async function reserve(tenant: string, contentHash: string): Promise<[string, string, number]> {
  const window = Math.floor(Date.now() / 1000 / QUOTA_WINDOW_S);
  const dedupeKey = \`ingest:dedupe:\${tenant}:\${contentHash}\`;
  const quotaKey = \`ingest:quota:\${tenant}:\${window}\`;
  const assetId = 'asset_' + randomUUID().replace(/-/g, '').slice(0, 12);
  const reply = (await r.eval(
    RESERVE_LUA,
    2,
    dedupeKey,
    quotaKey,
    String(QUOTA_MAX),
    String(DEDUPE_TTL_S),
    String(QUOTA_TTL_S),
    assetId,
  )) as [string, string, number];
  return [String(reply[0]), String(reply[1]), Number(reply[2])];
}

app.post('/v1/assets', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const body = request.body as AssetBody;
  const [status, assetId, ttl] = await reserve(tenant, body.checksum);
  if (status === 'refused')
    return reply
      .code(429)
      .header('Retry-After', String(Math.max(ttl, 1)))
      .send({error: 'tenant ingest quota exhausted'});
  const deduped = status === 'duplicate';
  return reply.code(deduped ? 200 : 201).send({asset_id: assetId, checksum: body.checksum, deduped});
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

const quotaLimit = 500

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type AssetRequest struct {
	Mime     string \`json:"mime"\`
	ByteSize int64  \`json:"byte_size"\`
	Checksum string \`json:"checksum"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func reserve(ctx context.Context, tenant, contentHash string) (bool, string, error) {
	// TODO: this draft checks the dedupe key with one GET and increments the counter with a second
	// command, so two concurrent registrations both observe room that only one of them has; neither
	// key ever expires, and the dedupe key ignores the tenant.
	key := "ingest:" + contentHash
	if existing, err := rdb.Get(ctx, key).Result(); err == nil {
		return true, existing, nil
	}
	quotaKey := "ingest:quota:" + tenant
	used, _ := rdb.Get(ctx, quotaKey).Int()
	if used >= quotaLimit {
		return false, "", nil
	}
	rdb.Incr(ctx, quotaKey)
	assetID := "asset_" + contentHash[len(contentHash)-12:]
	rdb.Set(ctx, key, assetID, 0)
	return false, assetID, nil
}

func createAsset(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	var body AssetRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	deduped, assetID, err := reserve(r.Context(), tenant, body.Checksum)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	status := http.StatusCreated
	if deduped {
		status = http.StatusOK
	}
	writeJSON(rw, status, map[string]any{"asset_id": assetID, "deduped": deduped})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/assets", createAsset)
	http.ListenAndServe(":8443", mux)
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

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

const (
	quotaMax         = 500
	quotaWindowS     = 60
	quotaTtlSeconds  = 120
	dedupeTtlSeconds = 86_400
)

const reserveScript = \`
local existing = redis.call('get', KEYS[1])
if existing then
  return {'duplicate', existing, 0}
end
local used = tonumber(redis.call('get', KEYS[2])) or 0
if used >= tonumber(ARGV[1]) then
  return {'refused', '', redis.call('ttl', KEYS[2])}
end
if used == 0 then
  redis.call('expire', KEYS[2], ARGV[3])
end
redis.call('incr', KEYS[2])
local assetId = ARGV[4]
redis.call('set', KEYS[1], assetId)
if redis.call('ttl', KEYS[1]) < 0 then
  redis.call('expire', KEYS[1], ARGV[2])
end
return {'reserved', assetId, 0}
\`

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type AssetRequest struct {
	Mime     string \`json:"mime"\`
	ByteSize int64  \`json:"byte_size"\`
	Checksum string \`json:"checksum"\`
}

type reservation struct {
	status  string
	assetID string
	ttl     int64
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func reserve(ctx context.Context, tenant, contentHash string) (reservation, error) {
	window := time.Now().Unix() / quotaWindowS
	dedupeKey := fmt.Sprintf("ingest:dedupe:%s:%s", tenant, contentHash)
	quotaKey := fmt.Sprintf("ingest:quota:%s:%d", tenant, window)
	assetID := "asset_" + uuid.NewString()[:12]
	reply, err := rdb.Eval(ctx, reserveScript, []string{dedupeKey, quotaKey},
		quotaMax, dedupeTtlSeconds, quotaTtlSeconds, assetID).Slice()
	if err != nil {
		return reservation{}, err
	}
	return reservation{
		status:  reply[0].(string),
		assetID: reply[1].(string),
		ttl:     reply[2].(int64),
	}, nil
}

func createAsset(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	var body AssetRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	res, err := reserve(r.Context(), tenant, body.Checksum)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	switch res.status {
	case "refused":
		ttl := res.ttl
		if ttl < 1 {
			ttl = 1
		}
		rw.Header().Set("Retry-After", strconv.FormatInt(ttl, 10))
		writeJSON(rw, http.StatusTooManyRequests, map[string]string{"error": "tenant ingest quota exhausted"})
	case "duplicate":
		writeJSON(rw, http.StatusOK, map[string]any{"asset_id": res.assetID, "checksum": body.Checksum, "deduped": true})
	default:
		writeJSON(rw, http.StatusCreated, map[string]any{"asset_id": res.assetID, "checksum": body.Checksum, "deduped": false})
	}
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/assets", createAsset)
	http.ListenAndServe(":8443", mux)
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

final case class AssetRequest(mime: String, byte_size: Long, checksum: String)

object IngestState {
  implicit val system: ActorSystem = ActorSystem("multimodal-ingest")
  implicit val requestFormat: RootJsonFormat[AssetRequest] = jsonFormat3(AssetRequest)

  val QuotaLimit = 500
  private val jedis = new Jedis("redis", 6379)

  def reserve(tenant: String, contentHash: String): (Boolean, String) = {
    // TODO: this draft checks the dedupe key with one GET and increments the counter with a second
    // command, so two concurrent registrations both observe room that only one of them has; neither
    // key ever expires, and the dedupe key ignores the tenant.
    val key = s"ingest:$contentHash"
    val existing = jedis.get(key)
    if (existing != null) {
      (true, existing)
    } else {
      val used = Option(jedis.get(s"ingest:quota:$tenant")).map(_.toInt).getOrElse(0)
      if (used >= QuotaLimit) {
        (false, "")
      } else {
        jedis.incr(s"ingest:quota:$tenant")
        val assetId = s"asset_\${contentHash.takeRight(12)}"
        jedis.set(key, assetId)
        (false, assetId)
      }
    }
  }

  val route: Route =
    path("v1" / "assets") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[AssetRequest]) { body =>
            val (deduped, assetId) = reserve(tenant, body.checksum)
            complete(
              if (deduped) StatusCodes.OK else StatusCodes.Created,
              s"""{"asset_id":"$assetId","deduped":$deduped}"""
            )
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
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

import scala.jdk.CollectionConverters._

final case class AssetRequest(mime: String, byte_size: Long, checksum: String)
final case class Reservation(status: String, assetId: String, ttl: Long)

object IngestState {
  implicit val system: ActorSystem = ActorSystem("multimodal-ingest")
  implicit val requestFormat: RootJsonFormat[AssetRequest] = jsonFormat3(AssetRequest)

  val QuotaMax = 500
  val QuotaWindowS = 60
  val QuotaTtlSeconds = 120
  val DedupeTtlSeconds = 86_400

  val ReserveLua = """
local existing = redis.call('get', KEYS[1])
if existing then
  return {'duplicate', existing, 0}
end
local used = tonumber(redis.call('get', KEYS[2])) or 0
if used >= tonumber(ARGV[1]) then
  return {'refused', '', redis.call('ttl', KEYS[2])}
end
if used == 0 then
  redis.call('expire', KEYS[2], ARGV[3])
end
redis.call('incr', KEYS[2])
local assetId = ARGV[4]
redis.call('set', KEYS[1], assetId)
if redis.call('ttl', KEYS[1]) < 0 then
  redis.call('expire', KEYS[1], ARGV[2])
end
return {'reserved', assetId, 0}
"""

  private val jedis = new Jedis("redis", 6379)

  def reserve(tenant: String, contentHash: String): Reservation = {
    val window = System.currentTimeMillis() / 1000 / QuotaWindowS
    val dedupeKey = s"ingest:dedupe:$tenant:$contentHash"
    val quotaKey = s"ingest:quota:$tenant:$window"
    val assetId = s"asset_\${UUID.randomUUID().toString.take(12)}"
    val keys = List(dedupeKey, quotaKey).asJava
    val args = List(QuotaMax.toString, DedupeTtlSeconds.toString, QuotaTtlSeconds.toString, assetId).asJava
    val reply = jedis.eval(ReserveLua, keys, args).asInstanceOf[java.util.List[String]]
    Reservation(reply.get(0), reply.get(1), reply.get(2).toLong)
  }

  val route: Route =
    path("v1" / "assets") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[AssetRequest]) { body =>
            reserve(tenant, body.checksum) match {
              case Reservation("refused", _, ttl) =>
                complete(
                  StatusCodes.TooManyRequests,
                  headers.RawHeader("Retry-After", math.max(ttl, 1).toString),
                  """{"error":"tenant ingest quota exhausted"}"""
                )
              case Reservation("duplicate", assetId, _) =>
                complete(StatusCodes.OK, s"""{"asset_id":"$assetId","checksum":"\${body.checksum}","deduped":true}""")
              case Reservation(_, assetId, _) =>
                complete(StatusCodes.Created, s"""{"asset_id":"$assetId","checksum":"\${body.checksum}","deduped":false}""")
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

constexpr long long kQuotaLimit = 500;

auto redis = sw::redis::Redis("tcp://redis:6379");

bool reserve(const std::string& tenant, const std::string& contentHash, std::string& assetId) {
  // TODO: this draft checks the dedupe key with one GET and increments the counter with a second
  // command, so two concurrent registrations both observe room that only one of them has; neither
  // key ever expires, and the dedupe key ignores the tenant.
  const std::string key = "ingest:" + contentHash;
  if (const auto existing = redis.get(key)) {
    assetId = *existing;
    return true;
  }
  const std::string quotaKey = "ingest:quota:" + tenant;
  const long long used = std::stoll(redis.get(quotaKey).value_or("0"));
  if (used >= kQuotaLimit) {
    assetId.clear();
    return false;
  }
  redis.incr(quotaKey);
  assetId = "asset_" + contentHash.substr(contentHash.size() - 12);
  redis.set(key, assetId);
  return false;
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/assets", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    std::string assetId;
    const bool deduped = reserve(tenant, body.value("checksum", std::string()), assetId);
    res.status = deduped ? 200 : 201;
    res.set_content(json{{"asset_id", assetId}, {"deduped", deduped}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr long long kQuotaMax = 500;
constexpr long long kQuotaWindowS = 60;
constexpr long long kQuotaTtlSeconds = 120;
constexpr long long kDedupeTtlSeconds = 86'400;

const std::string kReserveLua = R"lua(
local existing = redis.call('get', KEYS[1])
if existing then
  return {'duplicate', existing, 0}
end
local used = tonumber(redis.call('get', KEYS[2])) or 0
if used >= tonumber(ARGV[1]) then
  return {'refused', '', redis.call('ttl', KEYS[2])}
end
if used == 0 then
  redis.call('expire', KEYS[2], ARGV[3])
end
redis.call('incr', KEYS[2])
local assetId = ARGV[4]
redis.call('set', KEYS[1], assetId)
if redis.call('ttl', KEYS[1]) < 0 then
  redis.call('expire', KEYS[1], ARGV[2])
end
return {'reserved', assetId, 0}
)lua";

auto redis = sw::redis::Redis("tcp://redis:6379");

struct Reservation {
  std::string status;
  std::string asset_id;
  long long ttl = 0;
};

Reservation reserve(const std::string& tenant, const std::string& contentHash) {
  const long long window =
      std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count() /
      kQuotaWindowS;
  const std::string dedupeKey = "ingest:dedupe:" + tenant + ":" + contentHash;
  const std::string quotaKey = "ingest:quota:" + tenant + ":" + std::to_string(window);
  const std::string assetId = "asset_" + contentHash.substr(7, 12);
  const std::vector<std::string> keys = {dedupeKey, quotaKey};
  const std::vector<std::string> args = {std::to_string(kQuotaMax), std::to_string(kDedupeTtlSeconds),
                                         std::to_string(kQuotaTtlSeconds), assetId};
  const auto reply = redis.eval<std::string>(kReserveLua, keys, args);
  return Reservation{reply[0], reply[1], std::stoll(reply[2])};
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/assets", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    const auto contentHash = body.value("checksum", std::string());
    const Reservation reserved = reserve(tenant, contentHash);
    if (reserved.status == "refused") {
      res.status = 429;
      res.set_header("Retry-After", std::to_string(std::max<long long>(reserved.ttl, 1)));
      res.set_content(R"({"error":"tenant ingest quota exhausted"})", "application/json");
      return;
    }
    const bool deduped = reserved.status == "duplicate";
    res.status = deduped ? 200 : 201;
    res.set_content(json{{"asset_id", reserved.asset_id}, {"checksum", contentHash}, {"deduped", deduped}}.dump(),
                    "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The interviewer is testing whether you can see the check-then-act shape in a cache path. The draft
reads like a cache-aside implementation and it passes every sequential test; under concurrency the
two commands are two decisions, and the tenant can spend a unit of quota twice. Moving them into one
Lua script makes the read, the compare and both writes one decision, which is the only way a
distributed counter is correct.

The second-order bug is the order inside that script: charge first, dedupe second, and a client that
re-uploads a file it already uploaded gets a 429 — a cache hit reported as a quota error. Expiry is
the third: the dedupe key is a memory leak without a TTL, and the quota key without the minute bucket
turns a burst into a permanent lockout. Real systems add a small Retry-After skew, a
X-RateLimit-Remaining header, and an operator-visible counter for refusals, and they keep the
reservation in the same request as the metadata write so a refused asset leaves no partial row.`,
};
