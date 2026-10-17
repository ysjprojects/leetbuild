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
func handle(ctx context.Context, body map[string]any) (int, map[string]any) { panic("not implemented") }

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
func handle(ctx context.Context, body map[string]any) (int, map[string]any) { panic("not implemented") }

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
  },
  debrief: `The key turns the network's at-least-once into exactly-once at the API, and the fingerprint turns the key into a *promise about a request* rather than a promise about a string: a mismatch is refused instead of silently returning somebody else's transaction. Storing the outcome whatever the status matters for a ledger in particular — a rejected posting that is re-run on retry might pass a second time if the rules or the data changed in between, and the caller would never learn it had been rejected. Stripe's post scopes keys per API key, answers a mismatched body with a 400 rather than a 409, and keeps keys for 24 hours; it also recommends that clients retry with exponential backoff and jitter, and that the key be generated once per *intent* (a UUID stored next to the order), not per attempt.`,
};
