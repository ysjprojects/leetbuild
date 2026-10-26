import type {Step} from '@/lib/types';

// ---- 2. Idempotency-Key with a request fingerprint ---------------------------------------------
export const idempotentPostStep: Step = {
  id: 'idempotent-post',
  title: 'One Idempotency-Key, one outcome',
  concept: 'redis',
  file: 'idempotent_api',
  focus: ['client', 'api', 'redis'],
  task: `## Task

The systems that post to the ledger retry on every timeout. A retried \`POST /transactions\` that books
the money twice is the worst bug a ledger can have, so every request carries an **\`Idempotency-Key\`**
header and the server promises: one key, one outcome. \`handle(body)\` from step 1 returns the outcome
as \`(status, payload)\`; wrap it:

- No \`Idempotency-Key\` header → **400**.
- Compute a **fingerprint** of the body — SHA-256 of its canonical JSON (keys sorted, no whitespace) —
  and reserve the key with one atomic command: \`SET idem:{key} {fingerprint} NX EX 86400\`.
- If the SET is refused, the key has been used. Read the stored fingerprint: a **different body** under
  the same key is a **409** — the client is reusing a key for a new request, which is a bug on their side.
  The same body means a retry: replay the stored outcome from the hash \`idem:{key}:response\` with its
  original status and body and an \`Idempotent-Replayed: true\` header. No stored outcome yet means the
  first request is still running → **409**.
- Otherwise run \`handle\`, store its outcome — **whatever the status**, a 422 included — with
  \`HSET idem:{key}:response status … body …\` and the same 24 h expiry, and answer with it.
- If \`handle\` throws, release the key before re-raising so the client's retry can go through.

:::widget idempotency {}

> The fingerprint is what makes the key safe: without it, a client that generates keys badly (or a proxy
> that mixes requests up) gets a confident 201 for a transaction that was never checked. Stripe stores the
> error outcomes too — a retry of a request that was rejected must be rejected the same way, not re-run.`,
  sequence: {
    participants: ['Caller', 'ledger', 'Redis'],
    messages: [
      {from: 'Caller', to: 'ledger', label: 'POST /transactions · Idempotency-Key: k1', kind: 'sync'},
      {from: 'ledger', to: 'Redis', label: 'SET idem:k1 sha256(body) NX EX 86400 → OK', kind: 'sync'},
      {from: 'ledger', to: 'ledger', label: 'handle(body) → (201, payload)', kind: 'sync'},
      {from: 'ledger', to: 'Redis', label: 'HSET idem:k1:response status 201 body {…} · EXPIRE 86400', kind: 'sync'},
      {from: 'ledger', to: 'Caller', label: '201 {transaction_id: tx_7f3a}', kind: 'reply'},
      {from: 'Caller', to: 'ledger', label: 'POST /transactions · Idempotency-Key: k1 (retry)', kind: 'sync'},
      {from: 'ledger', to: 'Redis', label: 'SET NX refused · GET idem:k1 = same fingerprint · HGETALL', kind: 'sync'},
      {from: 'ledger', to: 'Caller', label: '201 {transaction_id: tx_7f3a} · Idempotent-Replayed: true', kind: 'reply'},
      {from: 'Caller', to: 'ledger', label: 'POST /transactions · Idempotency-Key: k1 (other body)', kind: 'sync'},
      {from: 'ledger', to: 'Caller', label: '409 key reused with a different request', kind: 'reply'},
    ],
  },
  hints: [
    'Four outcomes of the SET NX: it succeeds (you own the key), or it is refused and the stored fingerprint differs (409), or it matches and a response hash exists (replay), or it matches and there is no response yet (409 in progress). Branch in that order.',
    'Canonical JSON is `json.dumps(body, sort_keys=True, separators=(",", ":"))` in Python; in Go `json.Marshal` of a map sorts keys, in Scala use `sortedPrint`, in C++ `json::dump()` already orders keys.',
    'The response hash carries two fields, `status` and `body`, and gets its own EXPIRE: a hash has no NX EX form, so set it after `handle` returned and give it the same TTL as the reservation.',
  ],
  checks: [
    {
      id: 'header-required',
      title: 'Rejects requests without an Idempotency-Key with 400',
      detail:
        'Read the `Idempotency-Key` header and answer `400 Bad Request` when it is missing; without it the ledger can promise nothing about retries.',
      match: {
        python: {all: [/idempotency-key/i, /status_code\s*=\s*400|HTTP_400/]},
        typescript: {all: [/idempotency-key/i, /code\(\s*400\s*\)|status\(\s*400\s*\)/]},
        go: {all: [/Idempotency-Key/i, /http\.StatusBadRequest|\b400\b/]},
        scala: {all: [/Idempotency-Key/i, /StatusCodes\.BadRequest|\b400\b/]},
        cpp: {all: [/Idempotency-Key/i, /status\s*=\s*400/]},
      },
    },
    {
      id: 'fingerprint-nx',
      title: 'Reserves idem:{key} with the SHA-256 fingerprint of the body, NX EX 86400',
      detail:
        'One `SET idem:{key} {sha256 of the canonical body} NX EX 86400` both claims the key and records what request it belongs to; two retries can never both win.',
      match: {
        python: {
          all: [
            /f["']idem:\{/,
            /hashlib\.sha256\(/,
            /\.set\(\s*\w+\s*,\s*\w+\s*,[^\n]*nx\s*=\s*True/,
            /\.set\(\s*\w+\s*,\s*\w+\s*,[^\n]*ex\s*=\s*IDEM_TTL_S/,
          ],
        },
        typescript: {
          all: [
            /`idem:\$\{/,
            /createHash\(\s*['"]sha256['"]\s*\)/,
            /\.set\(\s*\w+\s*,\s*\w+\s*,[^\n]*['"]NX['"]/,
            /\.set\(\s*\w+\s*,\s*\w+\s*,[^\n]*['"]EX['"]\s*,\s*IDEM_TTL_S/,
          ],
        },
        go: {
          all: [/"idem:"\s*\+/, /sha256\.Sum256\(/, /rdb\.SetNX\(\s*[\w.()]+\s*,\s*\w+\s*,\s*\w+\s*,\s*idemTTL\s*\)/],
        },
        scala: {
          all: [
            /s"idem:\$/,
            /MessageDigest\.getInstance\(\s*"SHA-256"\s*\)/,
            /jedis\.set\(\s*\w+\s*,\s*\w+\s*,[^\n]*\.nx\(\)/,
            /\.ex\(\s*IdemTtlSeconds\s*\)/,
          ],
        },
        cpp: {
          all: [
            /"idem:"\s*\+/,
            /sha256_hex\(/,
            /redis\.set\(\s*\w+\s*,\s*\w+\s*,\s*kIdemTtl\s*,\s*sw::redis::UpdateType::NOT_EXIST\s*\)/,
          ],
        },
      },
    },
    {
      id: 'mismatch-409',
      title: 'Answers 409 when the key is reused with a different body',
      detail:
        "When the stored fingerprint differs from this request's, the client is reusing a key for a new request: `409 Conflict`, and `handle` must not run.",
      match: {
        python: {all: [/\br\.get\(\s*key\s*\)\s*!=\s*digest/, /status_code\s*=\s*409/]},
        typescript: {all: [/\bredis\.get\(\s*key\s*\)\)?\s*!==\s*digest/, /code\(\s*409\s*\)|status\(\s*409\s*\)/]},
        go: {all: [/rdb\.Get\(/, /!=\s*digest/, /http\.StatusConflict|\b409\b/]},
        scala: {all: [/jedis\.get\(/, /!=\s*digest/, /StatusCodes\.Conflict|\b409\b/]},
        cpp: {all: [/redis\.get\(/, /!=\s*digest/, /status\s*=\s*409/]},
      },
    },
    {
      id: 'replay',
      title: 'Replays the stored outcome with Idempotent-Replayed: true',
      detail:
        'A retry with the same fingerprint gets the stored status and body back from `idem:{key}:response` and an `Idempotent-Replayed: true` header; `handle` never runs again.',
      match: {
        python: {all: [/\.hgetall\(/, /Idempotent-Replayed/]},
        typescript: {all: [/\.hgetall\(/, /Idempotent-Replayed/]},
        go: {all: [/rdb\.HGetAll\(/, /Idempotent-Replayed/]},
        scala: {all: [/jedis\.hgetAll\(/, /Idempotent-Replayed/]},
        cpp: {all: [/redis\.hgetall\(/, /Idempotent-Replayed/]},
      },
    },
    {
      id: 'store-outcome',
      title: 'Stores every outcome, errors included, with the same TTL',
      detail:
        'After `handle` returns, `HSET idem:{key}:response status … body …` and `EXPIRE` it for 86400 s — a 422 is stored and replayed as a 422. If `handle` throws, DEL the reservation.',
      match: {
        python: {
          order: [/= await handle\(/, /\.hset\(/, /\.expire\(\s*\w+\s*,\s*IDEM_TTL_S\s*\)/],
          all: [/\.delete\(\s*key\s*\)/],
        },
        typescript: {
          order: [/= await handle\(/, /\.hset\(/, /\.expire\(\s*\w+\s*,\s*IDEM_TTL_S\s*\)/],
          all: [/\.del\(\s*key\s*\)/],
        },
        go: {order: [/:= handle\(/, /\.HSet\(/, /\.Expire\(\s*ctx\s*,\s*\w+\s*,\s*idemTTL\s*\)/], all: [/rdb\.Del\(/]},
        scala: {
          order: [/try handle\(|= handle\(/, /\.hset\(/, /\.expire\(\s*\w+\s*,\s*IdemTtlSeconds\s*\)/],
          all: [/jedis\.del\(/],
        },
        cpp: {order: [/= handle\(/, /\.hset\(/, /\.expire\(\s*\w+\s*,\s*kIdemTtl\s*\)/], all: [/redis\.del\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import hashlib
import json

import redis
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from ledger_api import handle  # built in step 1: (status, payload) of posting a body

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

IDEM_TTL_S = 86400


def fingerprint(body: dict) -> str:
    """SHA-256 of the canonical JSON of the body: keys sorted, no whitespace."""
    raise NotImplementedError  # TODO: hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


@app.post("/transactions")
async def create_transaction(request: Request) -> JSONResponse:
    body = await request.json()
    # TODO: 400 when the Idempotency-Key header is missing
    # TODO: SET idem:{key} fingerprint NX EX IDEM_TTL_S
    # TODO: refused → stored fingerprint differs: 409; same: replay idem:{key}:response (status, body) with Idempotent-Replayed: true, or 409 while in progress
    # TODO: handle(body) (DEL the key and re-raise on failure), HSET idem:{key}:response status/body + EXPIRE IDEM_TTL_S, answer with the outcome
    raise HTTPException(status_code=501)


# uvicorn idempotent_api:app --port 8443 --ssl-certfile cert.pem --ssl-keyfile key.pem
`,
      solution: `import hashlib
import json

import redis
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from ledger_api import handle  # built in step 1: (status, payload) of posting a body

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

IDEM_TTL_S = 86400


def fingerprint(body: dict) -> str:
    """SHA-256 of the canonical JSON of the body: keys sorted, no whitespace."""
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


@app.post("/transactions")
async def create_transaction(request: Request) -> JSONResponse:
    body = await request.json()
    idem_key = request.headers.get("idempotency-key")
    if not idem_key:
        raise HTTPException(status_code=400, detail="Idempotency-Key header is required")
    key = f"idem:{idem_key}"
    digest = fingerprint(body)
    if not r.set(key, digest, nx=True, ex=IDEM_TTL_S):
        if r.get(key) != digest:
            raise HTTPException(status_code=409, detail="Idempotency-Key reused with a different request body")
        stored = r.hgetall(f"{key}:response")
        if not stored:
            raise HTTPException(status_code=409, detail="a request with this Idempotency-Key is in progress")
        return JSONResponse(json.loads(stored["body"]), status_code=int(stored["status"]), headers={"Idempotent-Replayed": "true"})
    try:
        status, payload = await handle(body)
    except Exception:
        r.delete(key)  # let the client retry with the same key
        raise
    response_key = f"{key}:response"
    pipe = r.pipeline()
    pipe.hset(response_key, mapping={"status": status, "body": json.dumps(payload)})
    pipe.expire(response_key, IDEM_TTL_S)
    pipe.execute()
    return JSONResponse(payload, status_code=status)


# uvicorn idempotent_api:app --port 8443 --ssl-certfile cert.pem --ssl-keyfile key.pem
`,
    },
    typescript: {
      starter: `import {createHash} from 'node:crypto';

import Fastify from 'fastify';
import Redis from 'ioredis';

import {handle} from './ledger_api'; // built in step 1: [status, payload] of posting a body

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

export const IDEM_TTL_S = 86400;

/** Canonical JSON: keys sorted at every level, no whitespace. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return \`[\${value.map(canonical).join(',')}]\`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return \`{\${keys.map(k => \`\${JSON.stringify(k)}:\${canonical(record[k])}\`).join(',')}}\`;
  }
  return JSON.stringify(value);
}

/** SHA-256 hex digest of the canonical JSON of the body. */
export function fingerprint(body: unknown): string {
  throw new Error('not implemented'); // TODO: createHash('sha256').update(canonical(body)).digest('hex')
}

app.post('/transactions', async (request, reply) => {
  const body = request.body as Record<string, unknown>;
  // TODO: 400 when the Idempotency-Key header is missing
  // TODO: SET idem:{key} fingerprint EX IDEM_TTL_S NX
  // TODO: refused → stored fingerprint differs: 409; same: replay idem:{key}:response (status, body) with Idempotent-Replayed: true, or 409 while in progress
  // TODO: handle(body) (DEL the key and rethrow on failure), HSET idem:{key}:response status/body + EXPIRE IDEM_TTL_S, answer with the outcome
  return reply.code(501).send();
});
`,
      solution: `import {createHash} from 'node:crypto';

import Fastify from 'fastify';
import Redis from 'ioredis';

import {handle} from './ledger_api'; // built in step 1: [status, payload] of posting a body

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

export const IDEM_TTL_S = 86400;

/** Canonical JSON: keys sorted at every level, no whitespace. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return \`[\${value.map(canonical).join(',')}]\`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return \`{\${keys.map(k => \`\${JSON.stringify(k)}:\${canonical(record[k])}\`).join(',')}}\`;
  }
  return JSON.stringify(value);
}

/** SHA-256 hex digest of the canonical JSON of the body. */
export function fingerprint(body: unknown): string {
  return createHash('sha256').update(canonical(body)).digest('hex');
}

app.post('/transactions', async (request, reply) => {
  const body = request.body as Record<string, unknown>;
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '') {
    return reply.code(400).send({error: 'Idempotency-Key header is required'});
  }
  const key = \`idem:\${idemKey}\`;
  const digest = fingerprint(body);
  const reserved = await redis.set(key, digest, 'EX', IDEM_TTL_S, 'NX');
  if (reserved === null) {
    if ((await redis.get(key)) !== digest) {
      return reply.code(409).send({error: 'Idempotency-Key reused with a different request body'});
    }
    const stored = await redis.hgetall(\`\${key}:response\`);
    if (stored.status === undefined) {
      return reply.code(409).send({error: 'a request with this Idempotency-Key is in progress'});
    }
    return reply.code(Number(stored.status)).header('Idempotent-Replayed', 'true').send(JSON.parse(stored.body));
  }
  let status: number;
  let payload: Record<string, unknown>;
  try {
    [status, payload] = await handle(body);
  } catch (error) {
    await redis.del(key); // let the client retry with the same key
    throw error;
  }
  const responseKey = \`\${key}:response\`;
  await redis.multi().hset(responseKey, {status, body: JSON.stringify(payload)}).expire(responseKey, IDEM_TTL_S).exec();
  return reply.code(status).send(payload);
});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const idemTTL = 24 * time.Hour

// handle is the outcome of posting body: (status, payload) — built in step 1 (ledger_api.go).
var handle = func(ctx context.Context, body map[string]any) (int, map[string]any) { panic("not implemented") }

// fingerprint is the SHA-256 of the canonical JSON of the body (json.Marshal sorts map keys).
func fingerprint(body map[string]any) string {
	// TODO: canonical, _ := json.Marshal(body); hex of sha256.Sum256(canonical)
	_ = sha256.Sum256
	_ = hex.EncodeToString
	return ""
}

func createTransaction(rw http.ResponseWriter, r *http.Request) {
	dec := json.NewDecoder(r.Body)
	dec.UseNumber()
	var body map[string]any
	if err := dec.Decode(&body); err != nil {
		http.Error(rw, "invalid JSON", http.StatusBadRequest)
		return
	}
	// TODO: 400 when the Idempotency-Key header is missing
	// TODO: SetNX idem:{key} fingerprint idemTTL
	// TODO: refused → stored fingerprint differs: 409; same: replay idem:{key}:response (status, body) with Idempotent-Replayed: true, or 409 while in progress
	// TODO: handle(ctx, body) (Del the key on panic), HSet idem:{key}:response status/body + Expire idemTTL, answer with the outcome
	http.Error(rw, "not implemented", http.StatusNotImplemented)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /transactions", createTransaction)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const idemTTL = 24 * time.Hour

// handle is the outcome of posting body: (status, payload) — built in step 1 (ledger_api.go).
var handle = func(ctx context.Context, body map[string]any) (int, map[string]any) { panic("not implemented") }

// fingerprint is the SHA-256 of the canonical JSON of the body (json.Marshal sorts map keys).
func fingerprint(body map[string]any) string {
	canonical, _ := json.Marshal(body)
	sum := sha256.Sum256(canonical)
	return hex.EncodeToString(sum[:])
}

func writeJSON(rw http.ResponseWriter, status int, body []byte) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	rw.Write(body)
}

func createTransaction(rw http.ResponseWriter, r *http.Request) {
	dec := json.NewDecoder(r.Body)
	dec.UseNumber()
	var body map[string]any
	if err := dec.Decode(&body); err != nil {
		http.Error(rw, "invalid JSON", http.StatusBadRequest)
		return
	}
	idemKey := r.Header.Get("Idempotency-Key")
	if idemKey == "" {
		http.Error(rw, "Idempotency-Key header is required", http.StatusBadRequest)
		return
	}
	ctx := r.Context()
	key := "idem:" + idemKey
	digest := fingerprint(body)
	won, err := rdb.SetNX(ctx, key, digest, idemTTL).Result()
	if err != nil {
		http.Error(rw, "idempotency store unavailable", http.StatusServiceUnavailable)
		return
	}
	if !won {
		stored, _ := rdb.Get(ctx, key).Result()
		if stored != digest {
			http.Error(rw, "Idempotency-Key reused with a different request body", http.StatusConflict)
			return
		}
		outcome, _ := rdb.HGetAll(ctx, key+":response").Result()
		if len(outcome) == 0 {
			http.Error(rw, "a request with this Idempotency-Key is in progress", http.StatusConflict)
			return
		}
		status, _ := strconv.Atoi(outcome["status"])
		rw.Header().Set("Idempotent-Replayed", "true")
		writeJSON(rw, status, []byte(outcome["body"]))
		return
	}
	defer func() {
		if rec := recover(); rec != nil {
			rdb.Del(ctx, key) // let the client retry with the same key
			http.Error(rw, "ledger unavailable", http.StatusServiceUnavailable)
		}
	}()
	status, payload := handle(ctx, body)
	encoded, _ := json.Marshal(payload)
	responseKey := key + ":response"
	pipe := rdb.TxPipeline()
	pipe.HSet(ctx, responseKey, "status", status, "body", string(encoded))
	pipe.Expire(ctx, responseKey, idemTTL)
	pipe.Exec(ctx)
	writeJSON(rw, status, encoded)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /transactions", createTransaction)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import java.security.MessageDigest

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.{ConnectionContext, Http}
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import ledger.Tls // Tls.serverContext — provided
import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams
import spray.json._
import scala.jdk.CollectionConverters._

object IdempotentApi {
  val jedis = new JedisPooled("redis", 6379)
  val IdemTtlSeconds = 86400L

  /** The outcome of posting \`body\`: (status, payload) — built in step 1 (LedgerApi). */
  def handle(body: JsObject): (StatusCode, JsObject) = ???

  /** SHA-256 of the canonical JSON of the body: keys sorted, no whitespace (\`sortedPrint\`). */
  def fingerprint(body: JsObject): String = ??? // TODO: MessageDigest.getInstance("SHA-256") over body.sortedPrint, hex-encoded

  private def json(status: StatusCode, body: String, headers: List[HttpHeader] = Nil): Route =
    complete(HttpResponse(status, headers = headers, entity = HttpEntity(ContentTypes.\`application/json\`, body)))

  val route: Route =
    path("transactions") {
      post {
        entity(as[String]) { raw =>
          val body = scala.util.Try(raw.parseJson.asJsObject).getOrElse(JsObject())
          optionalHeaderValueByName("Idempotency-Key") { idemKey =>
            // TODO: 400 when idemKey is None
            // TODO: SET idem:{key} fingerprint NX EX IdemTtlSeconds
            // TODO: refused → stored fingerprint differs: 409; same: replay idem:{key}:response (status, body) with Idempotent-Replayed: true, or 409 while in progress
            // TODO: handle(body) (del the key and rethrow on failure), HSET idem:{key}:response status/body + EXPIRE IdemTtlSeconds, answer with the outcome
            complete(StatusCodes.NotImplemented)
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("ledger")
    val https = ConnectionContext.httpsServer(Tls.serverContext("cert.pem", "key.pem"))
    Http().newServerAt("0.0.0.0", 8443).enableHttps(https).bind(route)
  }
}
`,
      solution: `import java.security.MessageDigest

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.{ConnectionContext, Http}
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import ledger.Tls // Tls.serverContext — provided
import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams
import spray.json._
import scala.jdk.CollectionConverters._

object IdempotentApi {
  val jedis = new JedisPooled("redis", 6379)
  val IdemTtlSeconds = 86400L

  /** The outcome of posting \`body\`: (status, payload) — built in step 1 (LedgerApi). */
  def handle(body: JsObject): (StatusCode, JsObject) = ???

  /** SHA-256 of the canonical JSON of the body: keys sorted, no whitespace (\`sortedPrint\`). */
  def fingerprint(body: JsObject): String =
    MessageDigest.getInstance("SHA-256").digest(body.sortedPrint.getBytes("UTF-8")).map("%02x".format(_)).mkString

  private def json(status: StatusCode, body: String, headers: List[HttpHeader] = Nil): Route =
    complete(HttpResponse(status, headers = headers, entity = HttpEntity(ContentTypes.\`application/json\`, body)))

  val route: Route =
    path("transactions") {
      post {
        entity(as[String]) { raw =>
          val body = scala.util.Try(raw.parseJson.asJsObject).getOrElse(JsObject())
          optionalHeaderValueByName("Idempotency-Key") {
            case None => complete(StatusCodes.BadRequest -> "Idempotency-Key header is required")
            case Some(idemKey) =>
              val key = s"idem:$idemKey"
              val digest = fingerprint(body)
              val won = jedis.set(key, digest, SetParams.setParams().nx().ex(IdemTtlSeconds)) != null
              if (!won) {
                if (jedis.get(key) != digest)
                  complete(StatusCodes.Conflict -> "Idempotency-Key reused with a different request body")
                else {
                  val stored = jedis.hgetAll(s"$key:response").asScala
                  if (stored.isEmpty) complete(StatusCodes.Conflict -> "a request with this Idempotency-Key is in progress")
                  else json(StatusCode.int2StatusCode(stored("status").toInt), stored("body"), List(RawHeader("Idempotent-Replayed", "true")))
                }
              } else {
                val (status, payload) =
                  try handle(body)
                  catch { case e: Exception => jedis.del(key); throw e } // let the client retry with the same key
                val responseKey = s"$key:response"
                jedis.hset(responseKey, Map("status" -> status.intValue.toString, "body" -> payload.compactPrint).asJava)
                jedis.expire(responseKey, IdemTtlSeconds)
                json(status, payload.compactPrint)
              }
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("ledger")
    val https = ConnectionContext.httpsServer(Tls.serverContext("cert.pem", "key.pem"))
    Http().newServerAt("0.0.0.0", 8443).enableHttps(https).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#define CPPHTTPLIB_OPENSSL_SUPPORT
#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>
#include <unordered_map>
#include <utility>

#include "digest.h"  // std::string sha256_hex(const std::string& bytes);

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

constexpr std::chrono::seconds kIdemTtl{86400};

// The outcome of posting body: {status, payload} — built in step 1 (ledger_api.cpp).
std::pair<int, json> handle(const json& body);

// SHA-256 of the canonical JSON of the body (json::dump() orders keys and emits no whitespace).
std::string fingerprint(const json& body) {
  // TODO: sha256_hex(body.dump())
  return "";
}

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Post("/transactions", [](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    // TODO: 400 when the Idempotency-Key header is missing
    // TODO: SET idem:{key} fingerprint NX EX kIdemTtl
    // TODO: refused → stored fingerprint differs: 409; same: replay idem:{key}:response (status, body) with Idempotent-Replayed: true, or 409 while in progress
    // TODO: handle(body) (del the key and rethrow on failure), HSET idem:{key}:response status/body + EXPIRE kIdemTtl, answer with the outcome
    res.status = 501;
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#define CPPHTTPLIB_OPENSSL_SUPPORT
#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>
#include <unordered_map>
#include <utility>

#include "digest.h"  // std::string sha256_hex(const std::string& bytes);

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

constexpr std::chrono::seconds kIdemTtl{86400};

// The outcome of posting body: {status, payload} — built in step 1 (ledger_api.cpp).
std::pair<int, json> handle(const json& body);

// SHA-256 of the canonical JSON of the body (json::dump() orders keys and emits no whitespace).
std::string fingerprint(const json& body) { return sha256_hex(body.dump()); }

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Post("/transactions", [](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    if (!req.has_header("Idempotency-Key")) {
      res.status = 400;
      res.set_content("Idempotency-Key header is required", "text/plain");
      return;
    }
    const std::string key = "idem:" + req.get_header_value("Idempotency-Key");
    const std::string digest = fingerprint(body);
    const bool won = redis.set(key, digest, kIdemTtl, sw::redis::UpdateType::NOT_EXIST);
    if (!won) {
      const auto stored = redis.get(key);
      if (!stored || *stored != digest) {
        res.status = 409;
        res.set_content("Idempotency-Key reused with a different request body", "text/plain");
        return;
      }
      std::unordered_map<std::string, std::string> outcome;
      redis.hgetall(key + ":response", std::inserter(outcome, outcome.begin()));
      if (outcome.empty()) {
        res.status = 409;
        res.set_content("a request with this Idempotency-Key is in progress", "text/plain");
        return;
      }
      res.status = std::stoi(outcome["status"]);
      res.set_header("Idempotent-Replayed", "true");
      res.set_content(outcome["body"], "application/json");
      return;
    }
    std::pair<int, json> outcome;
    try {
      outcome = handle(body);
    } catch (...) {
      redis.del(key);  // let the client retry with the same key
      throw;
    }
    const std::string response_key = key + ":response";
    const std::string encoded = outcome.second.dump();
    auto tx = redis.transaction();
    tx.hset(response_key, {std::make_pair("status", std::to_string(outcome.first)), std::make_pair("body", encoded)})
        .expire(response_key, kIdemTtl)
        .exec();
    res.status = outcome.first;
    res.set_content(encoded, "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  harness: {
    python: `import asyncio
import hashlib
import json
import types

SCHEMA = """
CREATE TABLE transactions (
    id text PRIMARY KEY,
    event_id text UNIQUE,
    description text NOT NULL,
    settles text,
    posted_at bigint NOT NULL
);
CREATE TABLE entries (
    transaction_id text NOT NULL REFERENCES transactions (id),
    account text NOT NULL,
    currency text NOT NULL,
    amount bigint NOT NULL,
    posted_at bigint NOT NULL
);
"""

BODY = {
    "description": "capture ch_1",
    "entries": [
        {"account": "cash:acquirer", "currency": "EUR", "amount": 4999},
        {"account": "clearing:payments", "currency": "EUR", "amount": -4999},
    ],
}
REORDERED = {"entries": [{"amount": 4999, "currency": "EUR", "account": "cash:acquirer"}, {"amount": -4999, "currency": "EUR", "account": "clearing:payments"}], "description": "capture ch_1"}
UNBALANCED = {"description": "oops", "entries": [{"account": "cash:acquirer", "currency": "EUR", "amount": 4999}, {"account": "clearing:payments", "currency": "EUR", "amount": -4000}]}
OTHER = dict(BODY, description="capture ch_2")
DAY = 86400


def _digest(body):
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


async def _api(ctx):
    """The learner's idempotency layer over the real step 1 handler and the real journal writer, on an empty ledger."""
    await ctx.db.reset(SCHEMA)
    return ctx.load("idempotent_api")


async def _post(c, key=None, body=BODY):
    headers = {} if key is None else {"Idempotency-Key": key}
    return await c.post("/transactions", json=body, headers=headers)


async def _transactions(ctx):
    return await ctx.db.execute("SELECT id, description FROM transactions ORDER BY posted_at, id")


@types.coroutine
def _resume(coro, pending):
    while True:
        try:
            yield pending
        except BaseException as exc:
            try:
                pending = coro.throw(exc)
            except StopIteration as done:
                return done.value
            continue
        try:
            pending = coro.send(None)
        except StopIteration as done:
            return done.value


def _land_now(coro):
    """Another app server's request arriving at this very instant: it runs until it first has to wait
    (on the database, say) and the rest of it continues as a task, which is returned."""
    loop = asyncio.get_running_loop()
    try:
        pending = coro.send(None)
    except StopIteration as done:
        future = loop.create_future()
        future.set_result(done.value)
        return future

    async def finish():
        return await _resume(coro, pending)

    return asyncio.ensure_future(finish())


async def check_header_required(ctx):
    m = await _api(ctx)
    async with ctx.client(m.app) as c:
        r = await _post(c)
        assert r.status_code == 400, f"POST /transactions without Idempotency-Key answered {r.status_code}, expected 400"
        assert await _transactions(ctx) == [], "a request without a key must not reach the journal, but a transaction was written"
        r = await _post(c, "k1")
    assert r.status_code == 201, f"POST /transactions with a fresh key answered {r.status_code}, expected 201"
    rows = await _transactions(ctx)
    assert len(rows) == 1 and r.json().get("transaction_id") == rows[0]["id"], f"a fresh key must post the transaction once: the journal holds {rows}, the answer was {r.json()}"


async def check_fingerprint_nx(ctx):
    m = await _api(ctx)
    async with ctx.client(m.app) as c:
        # A retry from the client's other connection lands on another app server right after this
        # request's first Redis command on idem:k1 — the window a check-then-set leaves open.
        racer = ctx.redis_after("idem:k1", lambda: _land_now(_post(c, "k1")))
        first = await _post(c, "k1")
        assert racer.fired, "idem:k1 was never touched: the key must be reserved in Redis as idem:{Idempotency-Key}"
        assert racer.error is None, f"the concurrent retry failed to run: {racer.error!r}"
        try:
            other = await racer.result
        except Exception as exc:
            raise AssertionError(f"the concurrent retry crashed the service with {type(exc).__name__}: {exc}")
    rows = await _transactions(ctx)
    assert len(rows) == 1, f"two requests with key k1 arrived together and the journal booked {len(rows)} transactions: reserving the key must be one atomic SET NX, so only one of them can win"
    statuses = sorted([first.status_code, other.status_code])
    assert statuses == [201, 409], f"the two concurrent requests answered {statuses}: one creates the transaction (201), the other finds the key reserved with no outcome yet (409)"
    stored = ctx.redis.get("idem:k1")
    assert stored is not None, "after the request idem:k1 must hold the fingerprint of the body"
    assert stored == _digest(BODY), f"idem:k1 holds {stored!r}, expected the SHA-256 hex digest of the canonical JSON body (sort_keys, no whitespace)"
    ttl = ctx.redis.ttl("idem:k1")
    assert DAY - 400 <= ttl <= DAY, f"the reservation TTL was {ttl}, expected {DAY} s"
    ctx.clock.advance(DAY - 60)
    assert ctx.redis.get("idem:k1") == stored, "the reservation must still be there just under 24 h later"
    ctx.clock.advance(120)
    assert ctx.redis.get("idem:k1") is None, "24 h after the request the reservation must have expired"


async def check_mismatch_409(ctx):
    m = await _api(ctx)
    async with ctx.client(m.app) as c:
        first = await _post(c, "k1")
        assert first.status_code == 201, f"the first request answered {first.status_code}, expected 201"
        r = await _post(c, "k1", OTHER)
        assert r.status_code == 409, f"the same key with a different body answered {r.status_code}, expected 409"
        rows = await _transactions(ctx)
        assert [t["description"] for t in rows] == ["capture ch_1"], f"a mismatching body must not be posted, the journal holds {[t['description'] for t in rows]}"
        assert ctx.redis.get("idem:k1") == _digest(BODY), "the mismatching request must not overwrite the stored fingerprint"
        again = await _post(c, "k1")
    assert again.status_code == 201 and again.json() == first.json(), f"after the 409 the original request must still replay under its key, got {again.status_code} {again.json()}"


async def check_replay(ctx):
    m = await _api(ctx)
    async with ctx.client(m.app) as c:
        first = await _post(c, "k1")
        assert first.status_code == 201, f"the first request answered {first.status_code}, expected 201"
        assert first.headers.get("idempotent-replayed") is None, "the first response is not a replay"
        again = await _post(c, "k1")
        assert again.status_code == 201, f"the retry answered {again.status_code}, expected the stored 201"
        assert again.json() == first.json(), f"the replay must return the same body: {again.json()} != {first.json()}"
        assert again.headers.get("idempotent-replayed") == "true", f"a replay carries Idempotent-Replayed: true, got {dict(again.headers)}"
        rows = await _transactions(ctx)
        assert len(rows) == 1, f"a retry must not post again: the journal holds {len(rows)} transactions after one request and its retry"
        reordered = await _post(c, "k1", REORDERED)
        assert reordered.status_code == 201 and reordered.headers.get("idempotent-replayed") == "true", "the same body with its keys in another order is the same request: canonical JSON before hashing"
        assert reordered.json() == first.json(), "the reordered retry must replay the first outcome"
        assert len(await _transactions(ctx)) == 1, "the reordered retry must not post again"
        other = await _post(c, "k2")
    assert other.status_code == 201 and other.json().get("transaction_id") != first.json().get("transaction_id"), "a different key is a new transaction"
    assert len(await _transactions(ctx)) == 2, "a different key must post a second transaction"


async def check_store_outcome(ctx):
    m = await _api(ctx)
    async with ctx.client(m.app) as c:
        r = await _post(c, "k1")
        assert r.status_code == 201, f"POST /transactions with a fresh key answered {r.status_code}, expected 201"
        stored = ctx.redis.hgetall("idem:k1:response")
        assert stored, "after the response idem:k1:response must hold the outcome as a hash"
        assert stored.get("status") == "201", f"idem:k1:response.status is {stored.get('status')!r}, expected '201'"
        assert json.loads(stored.get("body", "null")) == r.json(), f"idem:k1:response.body {stored.get('body')!r} differs from the response body"
        ttl = ctx.redis.ttl("idem:k1:response")
        assert DAY - 400 <= ttl <= DAY, f"the stored outcome has TTL {ttl}, expected {DAY} s (same as the reservation)"
        r = await _post(c, "k2", UNBALANCED)
        assert r.status_code == 422, f"an unbalanced body must be answered 422, got {r.status_code}"
        again = await _post(c, "k2", UNBALANCED)
        assert again.status_code == 422, f"the retry of a rejected request must replay the stored 422, got {again.status_code}"
        assert again.headers.get("idempotent-replayed") == "true", "the replayed 422 is a replay too: error outcomes are stored as well"
        assert again.json() == r.json(), f"the replayed 422 must carry the stored reason, got {again.json()} != {r.json()}"
        # Two first requests with one key at once: the second finds the key reserved and no outcome yet.
        both = await asyncio.gather(_post(c, "k3"), _post(c, "k3"))
        statuses = sorted(x.status_code for x in both)
        assert statuses == [201, 409], f"two simultaneous first requests with key k3 answered {statuses}: one posts (201), the other is still in progress (409)"
        assert len(await _transactions(ctx)) == 2, "k1 and k3 must have posted one transaction each"
        # The journal breaks mid-write: from now on an entry of 4999 violates a constraint and the database rolls back.
        await ctx.db.execute("ALTER TABLE entries ADD CONSTRAINT journal_down CHECK (amount <> 4999) NOT VALID")
        try:
            r = await _post(c, "k4")
            assert r.status_code >= 500, f"a write that failed in the database answered {r.status_code}, expected a 5xx"
        except AssertionError:
            raise
        except Exception:
            pass
        assert len(await _transactions(ctx)) == 2, "the failed write must leave nothing in the journal"
        assert ctx.redis.get("idem:k4") is None, "when the write fails the reservation must be released (DEL), or every retry gets 409 for a day"
        assert not ctx.redis.exists("idem:k4:response"), "a failure is not an outcome: nothing may be stored for k4"
        await ctx.db.execute("ALTER TABLE entries DROP CONSTRAINT journal_down")
        retry = await _post(c, "k4")
    assert retry.status_code == 201, f"once the database is back, the client's retry with the same key must go through, got {retry.status_code} {retry.text}"
    assert len(await _transactions(ctx)) == 3, "the retry must post the k4 transaction exactly once"
`,
    typescript: `import {createHash} from 'node:crypto';

const SCHEMA = \`
CREATE TABLE transactions (
    id text PRIMARY KEY,
    event_id text UNIQUE,
    description text NOT NULL,
    settles text,
    posted_at bigint NOT NULL
);
CREATE TABLE entries (
    transaction_id text NOT NULL REFERENCES transactions (id),
    account text NOT NULL,
    currency text NOT NULL,
    amount bigint NOT NULL,
    posted_at bigint NOT NULL
);
\`;

const BODY = {
  description: 'capture ch_1',
  entries: [
    {account: 'cash:acquirer', currency: 'EUR', amount: 4999},
    {account: 'clearing:payments', currency: 'EUR', amount: -4999},
  ],
};
const REORDERED = {
  entries: [
    {amount: 4999, currency: 'EUR', account: 'cash:acquirer'},
    {amount: -4999, currency: 'EUR', account: 'clearing:payments'},
  ],
  description: 'capture ch_1',
};
const UNBALANCED = {
  description: 'oops',
  entries: [
    {account: 'cash:acquirer', currency: 'EUR', amount: 4999},
    {account: 'clearing:payments', currency: 'EUR', amount: -4000},
  ],
};
const OTHER = {...BODY, description: 'capture ch_2'};
const DAY = 86400;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return \`[\${value.map(canonical).join(',')}]\`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return \`{\${Object.keys(record).sort().map(k => \`\${JSON.stringify(k)}:\${canonical(record[k])}\`).join(',')}}\`;
  }
  return JSON.stringify(value);
}

const digestOf = (body: unknown): string => createHash('sha256').update(canonical(body)).digest('hex');

/** The learner's idempotency layer over the real step 1 handler and the real journal writer, on an empty ledger. */
async function api(ctx) {
  await ctx.db.reset(SCHEMA);
  return ctx.load('idempotent_api');
}

const post = (c, key: string | null = null, body: unknown = BODY) =>
  c.post('/transactions', {json: body, headers: key === null ? {} : {'Idempotency-Key': key}});

const transactions = (ctx) => ctx.db.execute('SELECT id, description FROM transactions ORDER BY posted_at, id');

export async function check_header_required(ctx) {
  const m = await api(ctx);
  const c = ctx.client(m.app);
  let r = await post(c);
  assert.equal(r.status, 400, \`POST /transactions without Idempotency-Key answered \${r.status}, expected 400\`);
  assert.deepEqual(await transactions(ctx), [], 'a request without a key must not reach the journal, but a transaction was written');
  r = await post(c, 'k1');
  assert.equal(r.status, 201, \`POST /transactions with a fresh key answered \${r.status}, expected 201\`);
  const rows = await transactions(ctx);
  assert(rows.length === 1 && r.json()?.transaction_id === rows[0].id, \`a fresh key must post the transaction once: the journal holds \${JSON.stringify(rows)}, the answer was \${r.text}\`);
}

export async function check_fingerprint_nx(ctx) {
  const m = await api(ctx);
  const c = ctx.client(m.app);
  // A retry from the client's other connection lands on another app server right after this
  // request's first Redis command on idem:k1 — the window a check-then-set leaves open.
  let fired = false;
  let racer: Promise<{status: number}> | null = null;
  ctx.redisAfter('idem:k1', () => {
    fired = true;
    racer = post(c, 'k1');
  });
  const first = await post(c, 'k1');
  assert(fired, 'idem:k1 was never touched: the key must be reserved in Redis as idem:{Idempotency-Key}');
  const other = await racer;
  const rows = await transactions(ctx);
  assert.equal(rows.length, 1, \`two requests with key k1 arrived together and the journal booked \${rows.length} transactions: reserving the key must be one atomic SET NX, so only one of them can win\`);
  const statuses = [first.status, other.status].sort();
  assert.deepEqual(statuses, [201, 409], \`the two concurrent requests answered \${JSON.stringify(statuses)}: one creates the transaction (201), the other finds the key reserved with no outcome yet (409)\`);
  const stored = ctx.redis.get('idem:k1');
  assert(stored !== null, 'after the request idem:k1 must hold the fingerprint of the body');
  assert.equal(stored, digestOf(BODY), \`idem:k1 holds \${JSON.stringify(stored)}, expected the SHA-256 hex digest of the canonical JSON body (keys sorted, no whitespace)\`);
  const ttl = ctx.redis.ttl('idem:k1');
  assert(DAY - 400 <= ttl && ttl <= DAY, \`the reservation TTL was \${ttl}, expected \${DAY} s\`);
  ctx.clock.advance(DAY - 60);
  assert.equal(ctx.redis.get('idem:k1'), stored, 'the reservation must still be there just under 24 h later');
  ctx.clock.advance(120);
  assert.equal(ctx.redis.get('idem:k1'), null, '24 h after the request the reservation must have expired');
}

export async function check_mismatch_409(ctx) {
  const m = await api(ctx);
  const c = ctx.client(m.app);
  const first = await post(c, 'k1');
  assert.equal(first.status, 201, \`the first request answered \${first.status}, expected 201\`);
  const r = await post(c, 'k1', OTHER);
  assert.equal(r.status, 409, \`the same key with a different body answered \${r.status}, expected 409\`);
  const rows = await transactions(ctx);
  assert.deepEqual(rows.map(t => t.description), ['capture ch_1'], \`a mismatching body must not be posted, the journal holds \${JSON.stringify(rows.map(t => t.description))}\`);
  assert.equal(ctx.redis.get('idem:k1'), digestOf(BODY), 'the mismatching request must not overwrite the stored fingerprint');
  const again = await post(c, 'k1');
  assert(again.status === 201 && again.text === first.text, \`after the 409 the original request must still replay under its key, got \${again.status} \${again.text}\`);
}

export async function check_replay(ctx) {
  const m = await api(ctx);
  const c = ctx.client(m.app);
  const first = await post(c, 'k1');
  assert.equal(first.status, 201, \`the first request answered \${first.status}, expected 201\`);
  assert.equal(first.headers['idempotent-replayed'], undefined, 'the first response is not a replay');
  const again = await post(c, 'k1');
  assert.equal(again.status, 201, \`the retry answered \${again.status}, expected the stored 201\`);
  assert.deepEqual(again.json(), first.json(), \`the replay must return the same body: \${again.text} != \${first.text}\`);
  assert.equal(again.headers['idempotent-replayed'], 'true', \`a replay carries Idempotent-Replayed: true, got \${JSON.stringify(again.headers)}\`);
  let rows = await transactions(ctx);
  assert.equal(rows.length, 1, \`a retry must not post again: the journal holds \${rows.length} transactions after one request and its retry\`);
  const reordered = await post(c, 'k1', REORDERED);
  assert(reordered.status === 201 && reordered.headers['idempotent-replayed'] === 'true', 'the same body with its keys in another order is the same request: canonical JSON before hashing');
  assert.deepEqual(reordered.json(), first.json(), 'the reordered retry must replay the first outcome');
  assert.equal((await transactions(ctx)).length, 1, 'the reordered retry must not post again');
  const other = await post(c, 'k2');
  assert(other.status === 201 && other.json()?.transaction_id !== first.json()?.transaction_id, 'a different key is a new transaction');
  rows = await transactions(ctx);
  assert.equal(rows.length, 2, 'a different key must post a second transaction');
}

export async function check_store_outcome(ctx) {
  const m = await api(ctx);
  const c = ctx.client(m.app);
  let r = await post(c, 'k1');
  assert.equal(r.status, 201, \`POST /transactions with a fresh key answered \${r.status}, expected 201\`);
  const stored = ctx.redis.hgetall('idem:k1:response');
  assert(Object.keys(stored).length > 0, 'after the response idem:k1:response must hold the outcome as a hash');
  assert.equal(stored.status, '201', \`idem:k1:response.status is \${JSON.stringify(stored.status)}, expected '201'\`);
  assert.deepEqual(JSON.parse(stored.body ?? 'null'), r.json(), \`idem:k1:response.body \${JSON.stringify(stored.body)} differs from the response body\`);
  const ttl = ctx.redis.ttl('idem:k1:response');
  assert(DAY - 400 <= ttl && ttl <= DAY, \`the stored outcome has TTL \${ttl}, expected \${DAY} s (same as the reservation)\`);
  r = await post(c, 'k2', UNBALANCED);
  assert.equal(r.status, 422, \`an unbalanced body must be answered 422, got \${r.status}\`);
  const again = await post(c, 'k2', UNBALANCED);
  assert.equal(again.status, 422, \`the retry of a rejected request must replay the stored 422, got \${again.status}\`);
  assert.equal(again.headers['idempotent-replayed'], 'true', 'the replayed 422 is a replay too: error outcomes are stored as well');
  assert.deepEqual(again.json(), r.json(), \`the replayed 422 must carry the stored reason, got \${again.text} != \${r.text}\`);
  // Two first requests with one key at once: the second finds the key reserved and no outcome yet.
  const both = await Promise.all([post(c, 'k3'), post(c, 'k3')]);
  const statuses = both.map(x => x.status).sort();
  assert.deepEqual(statuses, [201, 409], \`two simultaneous first requests with key k3 answered \${JSON.stringify(statuses)}: one posts (201), the other is still in progress (409)\`);
  assert.equal((await transactions(ctx)).length, 2, 'k1 and k3 must have posted one transaction each');
  // The journal breaks mid-write: from now on an entry of 4999 violates a constraint and the database rolls back.
  await ctx.db.execute('ALTER TABLE entries ADD CONSTRAINT journal_down CHECK (amount <> 4999) NOT VALID');
  r = await post(c, 'k4');
  assert(r.status >= 500, \`a write that failed in the database answered \${r.status}, expected a 5xx\`);
  assert.equal((await transactions(ctx)).length, 2, 'the failed write must leave nothing in the journal');
  assert.equal(ctx.redis.get('idem:k4'), null, 'when the write fails the reservation must be released (DEL), or every retry gets 409 for a day');
  assert(!ctx.redis.exists('idem:k4:response'), 'a failure is not an outcome: nothing may be stored for k4');
  await ctx.db.execute('ALTER TABLE entries DROP CONSTRAINT journal_down');
  const retry = await post(c, 'k4');
  assert.equal(retry.status, 201, \`once the database is back, the client's retry with the same key must go through, got \${retry.status} \${retry.text}\`);
  assert.equal((await transactions(ctx)).length, 3, 'the retry must post the k4 transaction exactly once');
}
`,
    go: `package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"regexp"
	"sort"
	"time"

	"github.com/google/uuid"

	ledgerdb "ledger/db"
	"leetbuild/harness"
)

const idemSchema = \`
CREATE TABLE transactions (
    id text PRIMARY KEY,
    event_id text UNIQUE,
    description text NOT NULL,
    settles text,
    posted_at bigint NOT NULL
);
CREATE TABLE entries (
    transaction_id text NOT NULL REFERENCES transactions (id),
    account text NOT NULL,
    currency text NOT NULL,
    amount bigint NOT NULL,
    posted_at bigint NOT NULL
);
\`

const idemDay = 86400

func idemBody() map[string]any {
	return map[string]any{
		"description": "capture ch_1",
		"entries": []any{
			map[string]any{"account": "cash:acquirer", "currency": "EUR", "amount": 4999},
			map[string]any{"account": "clearing:payments", "currency": "EUR", "amount": -4999},
		},
	}
}

// idemReordered is idemBody with its keys in another order, sent as it is written.
const idemReordered = \`{"entries":[{"amount":4999,"currency":"EUR","account":"cash:acquirer"},{"amount":-4999,"currency":"EUR","account":"clearing:payments"}],"description":"capture ch_1"}\`

func idemUnbalanced() map[string]any {
	return map[string]any{
		"description": "oops",
		"entries": []any{
			map[string]any{"account": "cash:acquirer", "currency": "EUR", "amount": 4999},
			map[string]any{"account": "clearing:payments", "currency": "EUR", "amount": -4000},
		},
	}
}

func idemOther() map[string]any {
	body := idemBody()
	body["description"] = "capture ch_2"
	return body
}

// idemDigestOf is the SHA-256 hex digest of the canonical JSON (keys sorted, no whitespace).
func idemDigestOf(body map[string]any) string {
	canonical, _ := json.Marshal(body)
	sum := sha256.Sum256(canonical)
	return hex.EncodeToString(sum[:])
}

var idemCurrencyRe = regexp.MustCompile(\`^[A-Z]{3}$\`)

// idemLedgerHandle is step 1's handle (ledger_api.go) over step 4's journal writer: 422 with a
// reason for anything but balanced double entry, otherwise one database transaction and 201. A
// write that fails in the database panics, as the real writer's failure propagates out of handle.
func idemLedgerHandle(ctx context.Context, body map[string]any) (int, map[string]any) {
	rawEntries, _ := body["entries"].([]any)
	if len(rawEntries) < 2 {
		return 422, map[string]any{"error": "a transaction needs at least two entries"}
	}
	entries := []map[string]any{}
	currencies := map[string]bool{}
	var sum int64
	for _, raw := range rawEntries {
		obj, _ := raw.(map[string]any)
		account, _ := obj["account"].(string)
		if account == "" {
			return 422, map[string]any{"error": "every entry needs an account"}
		}
		number, _ := obj["amount"].(json.Number)
		amount, err := number.Int64()
		if err != nil || amount == 0 {
			return 422, map[string]any{"error": "amount must be a non-zero integer in minor units"}
		}
		currency, _ := obj["currency"].(string)
		if !idemCurrencyRe.MatchString(currency) {
			return 422, map[string]any{"error": "currency must be a three-letter ISO code"}
		}
		currencies[currency] = true
		sum += amount
		entries = append(entries, map[string]any{"account": account, "currency": currency, "amount": amount})
	}
	if len(currencies) != 1 {
		return 422, map[string]any{"error": "all entries of a transaction share one currency"}
	}
	if sum != 0 {
		return 422, map[string]any{"error": "debits and credits must net to zero"}
	}
	description, _ := body["description"].(string)
	transactionID := uuid.NewString()
	postedAt := time.Now().UnixMilli()
	err := ledgerdb.Transaction(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx,
			"INSERT INTO transactions (id, event_id, description, settles, posted_at) VALUES ($1, NULL, $2, NULL, $3)",
			transactionID, description, postedAt); err != nil {
			return err
		}
		for _, e := range entries {
			if _, err := tx.ExecContext(ctx,
				"INSERT INTO entries (transaction_id, account, currency, amount, posted_at) VALUES ($1, $2, $3, $4, $5)",
				transactionID, e["account"], e["currency"], e["amount"], postedAt); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		panic(err)
	}
	return 201, map[string]any{"transaction_id": transactionID, "posted_at": postedAt, "entries": entries}
}

// idemAPI is the learner's idempotency layer over the real step 1 handler and the real journal
// writer, on an empty ledger.
func idemAPI(ctx *harness.Ctx) *harness.HTTP {
	ctx.DB.Reset(idemSchema)
	handle = idemLedgerHandle
	return ctx.Main(main).HTTP()
}

// idemPost posts body ("" for no Idempotency-Key header); a string body goes as it is written.
func idemPost(c *harness.HTTP, key string, body any) *harness.Response {
	header := []string{"Content-Type", "application/json"}
	if key != "" {
		header = append(header, "Idempotency-Key", key)
	}
	if text, ok := body.(string); ok {
		return c.Post("/transactions", text, header...)
	}
	data, _ := json.Marshal(body)
	return c.Post("/transactions", data, header...)
}

func idemTransactions(ctx *harness.Ctx) []harness.Row {
	return ctx.DB.Query("SELECT id, description FROM transactions ORDER BY posted_at, id")
}

func idemJSON(r *harness.Response) map[string]any {
	var body map[string]any
	json.Unmarshal(r.Body, &body)
	return body
}

func CheckHeaderRequired(ctx *harness.Ctx) {
	c := idemAPI(ctx)
	r := idemPost(c, "", idemBody())
	ctx.Equal(r.Status, 400, "POST /transactions without Idempotency-Key")
	ctx.Equal(len(idemTransactions(ctx)), 0, "a request without a key must not reach the journal, but a transaction was written")
	r = idemPost(c, "k1", idemBody())
	ctx.Equal(r.Status, 201, "POST /transactions with a fresh key")
	rows := idemTransactions(ctx)
	ctx.Assert(len(rows) == 1 && idemJSON(r)["transaction_id"] == rows[0]["id"], "a fresh key must post the transaction once: the journal holds %v, the answer was %s", rows, r.Text())
}

func CheckFingerprintNx(ctx *harness.Ctx) {
	c := idemAPI(ctx)
	// A retry from the client's other connection lands on another app server right after this
	// request's first Redis command on idem:k1 — the window a check-then-set leaves open.
	fired := false
	racer := make(chan *harness.Response, 1)
	ctx.Redis.After("idem:k1", func() any {
		fired = true
		go func() { racer <- idemPost(c, "k1", idemBody()) }()
		return nil
	})
	first := idemPost(c, "k1", idemBody())
	ctx.Assert(fired, "idem:k1 was never touched: the key must be reserved in Redis as idem:{Idempotency-Key}")
	other := <-racer
	rows := idemTransactions(ctx)
	ctx.Equal(len(rows), 1, "two requests with key k1 arrived together and the journal booked that many transactions: reserving the key must be one atomic SetNX, so only one of them can win")
	statuses := []int{first.Status, other.Status}
	sort.Ints(statuses)
	ctx.Equal(statuses, []int{201, 409}, "the two concurrent requests: one creates the transaction (201), the other finds the key reserved with no outcome yet (409)")
	stored, ok := ctx.Redis.Get("idem:k1")
	ctx.Assert(ok, "after the request idem:k1 must hold the fingerprint of the body")
	ctx.Equal(stored, idemDigestOf(idemBody()), "idem:k1 must hold the SHA-256 hex digest of the canonical JSON body (keys sorted, no whitespace)")
	ttl := ctx.Redis.TTL("idem:k1")
	ctx.Assert(idemDay-400 <= ttl && ttl <= idemDay, "the reservation TTL was %d, expected %d s", ttl, idemDay)
	ctx.Clock.Advance(idemDay - 60)
	still, _ := ctx.Redis.Get("idem:k1")
	ctx.Equal(still, stored, "the reservation must still be there just under 24 h later")
	ctx.Clock.Advance(120)
	_, ok = ctx.Redis.Get("idem:k1")
	ctx.Assert(!ok, "24 h after the request the reservation must have expired")
}

func CheckMismatch409(ctx *harness.Ctx) {
	c := idemAPI(ctx)
	first := idemPost(c, "k1", idemBody())
	ctx.Equal(first.Status, 201, "the first request")
	r := idemPost(c, "k1", idemOther())
	ctx.Equal(r.Status, 409, "the same key with a different body")
	descriptions := []string{}
	for _, t := range idemTransactions(ctx) {
		description, _ := t["description"].(string)
		descriptions = append(descriptions, description)
	}
	ctx.Equal(descriptions, []string{"capture ch_1"}, "a mismatching body must not be posted")
	stored, _ := ctx.Redis.Get("idem:k1")
	ctx.Equal(stored, idemDigestOf(idemBody()), "the mismatching request must not overwrite the stored fingerprint")
	again := idemPost(c, "k1", idemBody())
	ctx.Assert(again.Status == 201 && again.Text() == first.Text(), "after the 409 the original request must still replay under its key, got %d %s", again.Status, again.Text())
}

func CheckReplay(ctx *harness.Ctx) {
	c := idemAPI(ctx)
	first := idemPost(c, "k1", idemBody())
	ctx.Equal(first.Status, 201, "the first request")
	ctx.Equal(first.Header.Get("Idempotent-Replayed"), "", "the first response is not a replay")
	again := idemPost(c, "k1", idemBody())
	ctx.Equal(again.Status, 201, "the retry must answer the stored status")
	ctx.Equal(again.JSON(), first.JSON(), "the replay must return the same body")
	ctx.Equal(again.Header.Get("Idempotent-Replayed"), "true", "a replay carries Idempotent-Replayed: true (headers %v)", again.Header)
	ctx.Equal(len(idemTransactions(ctx)), 1, "a retry must not post again: transactions in the journal after one request and its retry")
	reordered := idemPost(c, "k1", idemReordered)
	ctx.Assert(reordered.Status == 201 && reordered.Header.Get("Idempotent-Replayed") == "true", "the same body with its keys in another order is the same request: canonical JSON before hashing")
	ctx.Equal(reordered.JSON(), first.JSON(), "the reordered retry must replay the first outcome")
	ctx.Equal(len(idemTransactions(ctx)), 1, "the reordered retry must not post again")
	other := idemPost(c, "k2", idemBody())
	ctx.Assert(other.Status == 201 && idemJSON(other)["transaction_id"] != idemJSON(first)["transaction_id"], "a different key is a new transaction")
	ctx.Equal(len(idemTransactions(ctx)), 2, "a different key must post a second transaction")
}

func CheckStoreOutcome(ctx *harness.Ctx) {
	c := idemAPI(ctx)
	r := idemPost(c, "k1", idemBody())
	ctx.Equal(r.Status, 201, "POST /transactions with a fresh key")
	stored := ctx.Redis.HGetAll("idem:k1:response")
	ctx.Assert(len(stored) > 0, "after the response idem:k1:response must hold the outcome as a hash")
	ctx.Equal(stored["status"], "201", "idem:k1:response status")
	var storedBody any
	json.Unmarshal([]byte(stored["body"]), &storedBody)
	ctx.Equal(storedBody, r.JSON(), "idem:k1:response body %q differs from the response body", stored["body"])
	ttl := ctx.Redis.TTL("idem:k1:response")
	ctx.Assert(idemDay-400 <= ttl && ttl <= idemDay, "the stored outcome has TTL %d, expected %d s (same as the reservation)", ttl, idemDay)
	r = idemPost(c, "k2", idemUnbalanced())
	ctx.Equal(r.Status, 422, "an unbalanced body must be answered 422")
	again := idemPost(c, "k2", idemUnbalanced())
	ctx.Equal(again.Status, 422, "the retry of a rejected request must replay the stored 422")
	ctx.Equal(again.Header.Get("Idempotent-Replayed"), "true", "the replayed 422 is a replay too: error outcomes are stored as well")
	ctx.Equal(again.JSON(), r.JSON(), "the replayed 422 must carry the stored reason")
	// Two first requests with one key at once: the second finds the key reserved and no outcome yet.
	both := make(chan int, 2)
	for range 2 {
		go func() { both <- idemPost(c, "k3", idemBody()).Status }()
	}
	a := <-both
	b := <-both
	statuses := []int{a, b}
	sort.Ints(statuses)
	ctx.Equal(statuses, []int{201, 409}, "two simultaneous first requests with key k3: one posts (201), the other is still in progress (409)")
	ctx.Equal(len(idemTransactions(ctx)), 2, "k1 and k3 must have posted one transaction each")
	// The journal breaks mid-write: from now on an entry of 4999 violates a constraint and the database rolls back.
	ctx.DB.Exec("ALTER TABLE entries ADD CONSTRAINT journal_down CHECK (amount <> 4999) NOT VALID")
	r = idemPost(c, "k4", idemBody())
	ctx.Assert(r.Status >= 500, "a write that failed in the database answered %d, expected a 5xx", r.Status)
	ctx.Equal(len(idemTransactions(ctx)), 2, "the failed write must leave nothing in the journal")
	_, reserved := ctx.Redis.Get("idem:k4")
	ctx.Assert(!reserved, "when the write fails the reservation must be released (Del), or every retry gets 409 for a day")
	ctx.Equal(ctx.Redis.Exists("idem:k4:response"), 0, "a failure is not an outcome: nothing may be stored for k4")
	ctx.DB.Exec("ALTER TABLE entries DROP CONSTRAINT journal_down")
	retry := idemPost(c, "k4", idemBody())
	ctx.Equal(retry.Status, 201, "once the database is back, the client's retry with the same key must go through (answer %s)", retry.Text())
	ctx.Equal(len(idemTransactions(ctx)), 3, "the retry must post the k4 transaction exactly once")
}
`,
    cpp: `#include <leetbuild/harness.h>
#include <nlohmann/json.hpp>
#include <pqxx/pqxx>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <regex>
#include <set>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "db.h"
#include "digest.h"
#include "ids.h"

namespace {

const std::string idemSchema = R"(
CREATE TABLE transactions (
    id text PRIMARY KEY,
    event_id text UNIQUE,
    description text NOT NULL,
    settles text,
    posted_at bigint NOT NULL
);
CREATE TABLE entries (
    transaction_id text NOT NULL REFERENCES transactions (id),
    account text NOT NULL,
    currency text NOT NULL,
    amount bigint NOT NULL,
    posted_at bigint NOT NULL
);
)";

constexpr int64_t idemDay = 86400;

nlohmann::json idemBody() {
  return {
      {"description", "capture ch_1"},
      {"entries",
       nlohmann::json::array({
           {{"account", "cash:acquirer"}, {"currency", "EUR"}, {"amount", 4999}},
           {{"account", "clearing:payments"}, {"currency", "EUR"}, {"amount", -4999}},
       })},
  };
}

// idemReordered is idemBody with its keys in another order, sent as it is written.
const std::string idemReordered =
    R"({"entries":[{"amount":4999,"currency":"EUR","account":"cash:acquirer"},{"amount":-4999,"currency":"EUR","account":"clearing:payments"}],"description":"capture ch_1"})";

nlohmann::json idemUnbalanced() {
  return {
      {"description", "oops"},
      {"entries",
       nlohmann::json::array({
           {{"account", "cash:acquirer"}, {"currency", "EUR"}, {"amount", 4999}},
           {{"account", "clearing:payments"}, {"currency", "EUR"}, {"amount", -4000}},
       })},
  };
}

nlohmann::json idemOther() {
  auto body = idemBody();
  body["description"] = "capture ch_2";
  return body;
}

// idemDigestOf is the SHA-256 hex digest of the canonical JSON (keys sorted, no whitespace).
std::string idemDigestOf(const nlohmann::json& body) { return sha256_hex(body.dump()); }

const std::regex idemCurrencyRe("^[A-Z]{3}$");

}  // namespace

// Step 1's handle (ledger_api.cpp) over step 4's journal writer: 422 with a reason for anything but
// balanced double entry, otherwise one database transaction and 201. A write that fails in the
// database throws (pqxx's exception), as the real writer's failure propagates out of handle. (Go
// swaps the handle variable in; here the step's declared handle is defined by the harness.)
std::pair<int, nlohmann::json> handle(const nlohmann::json& body) {
  using nlohmann::json;
  const json rawEntries = body.contains("entries") && body["entries"].is_array() ? body["entries"] : json::array();
  if (rawEntries.size() < 2) return {422, json{{"error", "a transaction needs at least two entries"}}};
  json entries = json::array();
  std::set<std::string> currencies;
  int64_t sum = 0;
  for (const auto& raw : rawEntries) {
    const json obj = raw.is_object() ? raw : json::object();
    const std::string account = obj.contains("account") && obj["account"].is_string() ? obj["account"].get<std::string>() : "";
    if (account.empty()) return {422, json{{"error", "every entry needs an account"}}};
    // Go's json.Number.Int64: only an integer literal is an amount.
    const bool integer = obj.contains("amount") && obj["amount"].is_number_integer();
    const int64_t amount = integer ? obj["amount"].get<int64_t>() : 0;
    if (amount == 0) return {422, json{{"error", "amount must be a non-zero integer in minor units"}}};
    const std::string currency = obj.contains("currency") && obj["currency"].is_string() ? obj["currency"].get<std::string>() : "";
    if (!std::regex_match(currency, idemCurrencyRe)) return {422, json{{"error", "currency must be a three-letter ISO code"}}};
    currencies.insert(currency);
    sum += amount;
    entries.push_back(json{{"account", account}, {"currency", currency}, {"amount", amount}});
  }
  if (currencies.size() != 1) return {422, json{{"error", "all entries of a transaction share one currency"}}};
  if (sum != 0) return {422, json{{"error", "debits and credits must net to zero"}}};
  const std::string description = body.contains("description") && body["description"].is_string() ? body["description"].get<std::string>() : "";
  const std::string transactionID = new_uuid();
  const int64_t postedAt =
      std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  db::transaction([&](pqxx::work& tx) {
    tx.exec_params("INSERT INTO transactions (id, event_id, description, settles, posted_at) VALUES ($1, NULL, $2, NULL, $3)",
                   transactionID, description, postedAt);
    for (const auto& e : entries) {
      tx.exec_params("INSERT INTO entries (transaction_id, account, currency, amount, posted_at) VALUES ($1, $2, $3, $4, $5)",
                     transactionID, e["account"].get<std::string>(), e["currency"].get<std::string>(), e["amount"].get<int64_t>(),
                     postedAt);
    }
  });
  return {201, json{{"transaction_id", transactionID}, {"posted_at", postedAt}, {"entries", entries}}};
}

namespace {

// idemAPI is the learner's idempotency layer over the real step 1 handler and the real journal
// writer, on an empty ledger.
harness::HTTP idemAPI(harness::Ctx& ctx) {
  ctx.DB.Reset(idemSchema);
  return ctx.Main().HTTP();
}

// idemPost posts body text as it is written ("" key for no Idempotency-Key header).
harness::Response idemPostText(harness::HTTP& c, const std::string& key, const std::string& body) {
  std::vector<std::string> header = {"Content-Type", "application/json"};
  if (!key.empty()) {
    header.push_back("Idempotency-Key");
    header.push_back(key);
  }
  return c.Send("POST", "/transactions", body, header);
}

harness::Response idemPost(harness::HTTP& c, const std::string& key, const nlohmann::json& body) {
  return idemPostText(c, key, body.dump());
}

std::vector<harness::Row> idemTransactions(harness::Ctx& ctx) {
  return ctx.DB.Query("SELECT id, description FROM transactions ORDER BY posted_at, id");
}

harness::Any idemJSON(const harness::Response& r) { return harness::ParseJSON(r.Text()).value_or(harness::Any()); }

// Go's goroutine: a thread joined when the check is done with it (or leaves early).
struct idemThread {
  std::thread t;
  void Join() {
    if (t.joinable()) t.join();
  }
  ~idemThread() { Join(); }
};

}  // namespace

void CheckHeaderRequired(harness::Ctx& ctx) {
  auto c = idemAPI(ctx);
  auto r = idemPost(c, "", idemBody());
  ctx.Equal(r.Status, 400, "POST /transactions without Idempotency-Key");
  ctx.Equal(idemTransactions(ctx).size(), 0, "a request without a key must not reach the journal, but a transaction was written");
  r = idemPost(c, "k1", idemBody());
  ctx.Equal(r.Status, 201, "POST /transactions with a fresh key");
  auto rows = idemTransactions(ctx);
  ctx.Assert(rows.size() == 1 && idemJSON(r)["transaction_id"] == rows[0]["id"],
             "a fresh key must post the transaction once: the journal holds %v, the answer was %s", rows, r.Text());
}

void CheckFingerprintNx(harness::Ctx& ctx) {
  auto c = idemAPI(ctx);
  // A retry from the client's other connection lands on another app server right after this
  // request's first Redis command on idem:k1 — the window a check-then-set leaves open.
  bool fired = false;
  harness::Response other;
  idemThread racer;
  ctx.Redis.After("idem:k1", [&] {
    fired = true;
    racer.t = std::thread([&] { other = idemPost(c, "k1", idemBody()); });
  });
  const auto first = idemPost(c, "k1", idemBody());
  ctx.Assert(fired, "idem:k1 was never touched: the key must be reserved in Redis as idem:{Idempotency-Key}");
  racer.Join();
  const auto rows = idemTransactions(ctx);
  ctx.Equal(rows.size(), 1, "two requests with key k1 arrived together and the journal booked that many transactions: reserving the key must be one atomic SET NX, so only one of them can win");
  std::vector<int> statuses = {first.Status, other.Status};
  std::sort(statuses.begin(), statuses.end());
  ctx.Equal(statuses, {201, 409}, "the two concurrent requests: one creates the transaction (201), the other finds the key reserved with no outcome yet (409)");
  const auto stored = ctx.Redis.Get("idem:k1");
  ctx.Assert(stored.has_value(), "after the request idem:k1 must hold the fingerprint of the body");
  ctx.Equal(stored, idemDigestOf(idemBody()), "idem:k1 must hold the SHA-256 hex digest of the canonical JSON body (keys sorted, no whitespace)");
  const auto ttl = ctx.Redis.TTL("idem:k1");
  ctx.Assert(idemDay - 400 <= ttl && ttl <= idemDay, "the reservation TTL was %d, expected %d s", ttl, idemDay);
  ctx.Clock.Advance(idemDay - 60);
  const auto still = ctx.Redis.Get("idem:k1");
  ctx.Equal(still.value_or(""), *stored, "the reservation must still be there just under 24 h later");
  ctx.Clock.Advance(120);
  ctx.Assert(!ctx.Redis.Get("idem:k1").has_value(), "24 h after the request the reservation must have expired");
}

void CheckMismatch409(harness::Ctx& ctx) {
  auto c = idemAPI(ctx);
  const auto first = idemPost(c, "k1", idemBody());
  ctx.Equal(first.Status, 201, "the first request");
  const auto r = idemPost(c, "k1", idemOther());
  ctx.Equal(r.Status, 409, "the same key with a different body");
  std::vector<std::string> descriptions;
  for (const auto& t : idemTransactions(ctx)) descriptions.push_back(t.at("description").String());
  ctx.Equal(descriptions, {"capture ch_1"}, "a mismatching body must not be posted");
  const auto stored = ctx.Redis.Get("idem:k1");
  ctx.Equal(stored.value_or(""), idemDigestOf(idemBody()), "the mismatching request must not overwrite the stored fingerprint");
  const auto again = idemPost(c, "k1", idemBody());
  ctx.Assert(again.Status == 201 && again.Text() == first.Text(), "after the 409 the original request must still replay under its key, got %d %s",
             again.Status, again.Text());
}

void CheckReplay(harness::Ctx& ctx) {
  auto c = idemAPI(ctx);
  const auto first = idemPost(c, "k1", idemBody());
  ctx.Equal(first.Status, 201, "the first request");
  ctx.Equal(first.HeaderValue("Idempotent-Replayed"), "", "the first response is not a replay");
  const auto again = idemPost(c, "k1", idemBody());
  ctx.Equal(again.Status, 201, "the retry must answer the stored status");
  ctx.Equal(again.JSON(), first.JSON(), "the replay must return the same body");
  ctx.Equal(again.HeaderValue("Idempotent-Replayed"), "true", "a replay carries Idempotent-Replayed: true (headers %v)", again.Header);
  ctx.Equal(idemTransactions(ctx).size(), 1, "a retry must not post again: transactions in the journal after one request and its retry");
  const auto reordered = idemPostText(c, "k1", idemReordered);
  ctx.Assert(reordered.Status == 201 && reordered.HeaderValue("Idempotent-Replayed") == "true",
             "the same body with its keys in another order is the same request: canonical JSON before hashing");
  ctx.Equal(reordered.JSON(), first.JSON(), "the reordered retry must replay the first outcome");
  ctx.Equal(idemTransactions(ctx).size(), 1, "the reordered retry must not post again");
  const auto other = idemPost(c, "k2", idemBody());
  ctx.Assert(other.Status == 201 && !(idemJSON(other)["transaction_id"] == idemJSON(first)["transaction_id"]),
             "a different key is a new transaction");
  ctx.Equal(idemTransactions(ctx).size(), 2, "a different key must post a second transaction");
}

void CheckStoreOutcome(harness::Ctx& ctx) {
  auto c = idemAPI(ctx);
  auto r = idemPost(c, "k1", idemBody());
  ctx.Equal(r.Status, 201, "POST /transactions with a fresh key");
  auto stored = ctx.Redis.HGetAll("idem:k1:response");
  ctx.Assert(!stored.empty(), "after the response idem:k1:response must hold the outcome as a hash");
  ctx.Equal(stored["status"], "201", "idem:k1:response status");
  const auto storedBody = harness::ParseJSON(stored["body"]).value_or(harness::Any());
  ctx.Equal(storedBody, r.JSON(), "idem:k1:response body %q differs from the response body", stored["body"]);
  const auto ttl = ctx.Redis.TTL("idem:k1:response");
  ctx.Assert(idemDay - 400 <= ttl && ttl <= idemDay, "the stored outcome has TTL %d, expected %d s (same as the reservation)", ttl, idemDay);
  r = idemPost(c, "k2", idemUnbalanced());
  ctx.Equal(r.Status, 422, "an unbalanced body must be answered 422");
  const auto again = idemPost(c, "k2", idemUnbalanced());
  ctx.Equal(again.Status, 422, "the retry of a rejected request must replay the stored 422");
  ctx.Equal(again.HeaderValue("Idempotent-Replayed"), "true", "the replayed 422 is a replay too: error outcomes are stored as well");
  ctx.Equal(again.JSON(), r.JSON(), "the replayed 422 must carry the stored reason");
  // Two first requests with one key at once: the second finds the key reserved and no outcome yet.
  std::vector<int> statuses(2);
  {
    idemThread a, b;
    a.t = std::thread([&] { statuses[0] = idemPost(c, "k3", idemBody()).Status; });
    b.t = std::thread([&] { statuses[1] = idemPost(c, "k3", idemBody()).Status; });
  }
  std::sort(statuses.begin(), statuses.end());
  ctx.Equal(statuses, {201, 409}, "two simultaneous first requests with key k3: one posts (201), the other is still in progress (409)");
  ctx.Equal(idemTransactions(ctx).size(), 2, "k1 and k3 must have posted one transaction each");
  // The journal breaks mid-write: from now on an entry of 4999 violates a constraint and the database rolls back.
  ctx.DB.Exec("ALTER TABLE entries ADD CONSTRAINT journal_down CHECK (amount <> 4999) NOT VALID");
  r = idemPost(c, "k4", idemBody());
  ctx.Assert(r.Status >= 500, "a write that failed in the database answered %d, expected a 5xx", r.Status);
  ctx.Equal(idemTransactions(ctx).size(), 2, "the failed write must leave nothing in the journal");
  ctx.Assert(!ctx.Redis.Get("idem:k4").has_value(), "when the write fails the reservation must be released (DEL), or every retry gets 409 for a day");
  ctx.Equal(ctx.Redis.Exists("idem:k4:response"), 0, "a failure is not an outcome: nothing may be stored for k4");
  ctx.DB.Exec("ALTER TABLE entries DROP CONSTRAINT journal_down");
  const auto retry = idemPost(c, "k4", idemBody());
  ctx.Equal(retry.Status, 201, "once the database is back, the client's retry with the same key must go through (answer %s)", retry.Text());
  ctx.Equal(idemTransactions(ctx).size(), 3, "the retry must post the k4 transaction exactly once");
}
`,
  },
  debrief: `The key turns the network's at-least-once into exactly-once at the API, and the fingerprint turns the key into a *promise about a request* rather than a promise about a string: a mismatch is refused instead of silently returning somebody else's transaction. Storing the outcome whatever the status matters for a ledger in particular — a rejected posting that is re-run on retry might pass a second time if the rules or the data changed in between, and the caller would never learn it had been rejected. Stripe's post scopes keys per API key, answers a mismatched body with a 400 rather than a 409, and keeps keys for 24 hours; it also recommends that clients retry with exponential backoff and jitter, and that the key be generated once per *intent* (a UUID stored next to the order), not per attempt.`,
};
