import type {Step} from '@/lib/types';

// ---- 1. Idempotent checkout endpoint ------------------------------------------------------------
export const checkoutIdempotencyStep: Step = {
  id: 'checkout-idempotency',
  title: 'POST /checkout with an Idempotency-Key',
  concept: 'http',
  file: 'checkout_api',
  focus: ['client', 'checkout', 'redis'],
  task: `## Task

A merchant's app retries \`POST /checkout\` whenever the network hiccups. Charging a card twice is the one
bug a payments API may not have, so every request carries an **\`Idempotency-Key\`** header and the server
guarantees that one key produces one charge. \`process_checkout(body)\` is provided (you build it in the next
steps): it authorizes, captures and records the order, and returns the response document.

- No \`Idempotency-Key\` header → **400**.
- Reserve the key in Redis with a single atomic command: \`SET idem:{key} "processing" NX EX 86400\`.
- If the SET is refused, read the stored value: a finished response is **replayed** with **200** and the
  same body; the \`processing\` marker means a request with that key is still running → **409 Conflict**.
- Otherwise run \`process_checkout\`, store its JSON response over the key with the **same TTL**, and answer
  **201**.

:::widget idempotency {}

> The reservation and the check are one command on purpose. A \`GET\` followed by a \`SET\` leaves a window in
> which two retries both see "nothing stored" and both charge the card.

:::widget status-codes {}`,
  sequence: {
    participants: ['Merchant app', 'checkout', 'Redis'],
    messages: [
      {from: 'Merchant app', to: 'checkout', label: 'POST /checkout · Idempotency-Key: k1', kind: 'sync'},
      {from: 'checkout', to: 'Redis', label: 'SET idem:k1 processing NX EX 86400 → OK', kind: 'sync'},
      {from: 'checkout', to: 'checkout', label: 'process_checkout(body)', kind: 'sync'},
      {from: 'checkout', to: 'Redis', label: 'SET idem:k1 {response} EX 86400', kind: 'sync'},
      {from: 'checkout', to: 'Merchant app', label: '201 {order_id, status}', kind: 'reply'},
      {from: 'Merchant app', to: 'checkout', label: 'POST /checkout · Idempotency-Key: k1 (retry)', kind: 'sync'},
      {from: 'checkout', to: 'Merchant app', label: '200 {order_id, status} (replayed)', kind: 'reply'},
    ],
  },
  hints: [
    'Three outcomes of the SET NX: it succeeds (you own the key), or it is refused and the value is either the processing marker or a stored response. Branch on that, not on a separate GET-first check.',
    'Storing the response is a plain SET with the same expiry over the same key: the marker is overwritten by the document the replay will send.',
    'If `process_checkout` throws, delete the key before re-raising — otherwise every retry with that key gets a 409 for a day.',
  ],
  checks: [
    {
      id: 'header-required',
      title: 'Rejects requests without an Idempotency-Key with 400',
      detail:
        'Read the `Idempotency-Key` header and answer `400 Bad Request` when it is missing; without it the server cannot promise anything.',
      match: {
        python: {all: [/idempotency-key/i, /status_code\s*=\s*400|HTTP_400/]},
        go: {all: [/Idempotency-Key/i, /http\.StatusBadRequest|\b400\b/]},
        scala: {all: [/Idempotency-Key/i, /StatusCodes\.BadRequest|\b400\b/]},
        cpp: {all: [/Idempotency-Key/i, /status\s*=\s*400/]},
      },
    },
    {
      id: 'reserve-nx',
      title: 'Reserves idem:{key} atomically with SET NX EX',
      detail:
        'One `SET idem:{key} processing NX EX 86400` both checks and claims the key; a separate GET then SET has a race between two retries.',
      match: {
        python: {
          all: [
            /f["']idem:\{/,
            /\.set\(\s*\w+\s*,\s*PROCESSING\s*,[^\n]*nx\s*=\s*True/,
            /\.set\(\s*\w+\s*,\s*PROCESSING\s*,[^\n]*ex\s*=\s*IDEM_TTL_S/,
          ],
        },
        go: {all: [/"idem:"\s*\+/, /rdb\.SetNX\(\s*[\w.()]+\s*,\s*\w+\s*,\s*processing\s*,\s*idemTTL\s*\)/]},
        scala: {
          all: [/s"idem:\$/, /jedis\.set\(\s*\w+\s*,\s*Processing\s*,[^\n]*\.nx\(\)/, /\.ex\(\s*IdemTtlSeconds\s*\)/],
        },
        cpp: {
          all: [
            /"idem:"\s*\+/,
            /redis\.set\(\s*\w+\s*,\s*kProcessing\s*,\s*kIdemTtl\s*,\s*sw::redis::UpdateType::NOT_EXIST\s*\)/,
          ],
        },
      },
    },
    {
      id: 'in-flight',
      title: 'Answers 409 while the first request is still running',
      detail:
        'When the stored value is the `processing` marker, another request with the same key is in flight: `409 Conflict`, not a second charge.',
      match: {
        python: {all: [/status_code\s*=\s*409|HTTP_409/, /[=!]=\s*PROCESSING/]},
        go: {all: [/http\.StatusConflict|\b409\b/, /[=!]=\s*processing/]},
        scala: {all: [/StatusCodes\.Conflict|\b409\b/, /[=!]=\s*Processing/]},
        cpp: {all: [/status\s*=\s*409/, /[=!]=\s*kProcessing/]},
      },
    },
    {
      id: 'replay',
      title: 'Replays the stored response with 200',
      detail:
        'A retry after completion gets the original response body back from Redis with status `200`; the handler never runs again.',
      match: {
        python: {all: [/\br\.get\(/, /status_code\s*=\s*200/]},
        go: {all: [/rdb\.Get\(/, /http\.StatusOK|\b200\b/]},
        scala: {all: [/jedis\.get\(/, /StatusCodes\.OK|\b200\b/]},
        cpp: {all: [/redis\.get\(/, /status\s*=\s*200/]},
      },
    },
    {
      id: 'store-response',
      title: 'Stores the response over the key with the same TTL',
      detail:
        'After `process_checkout` returns, SET the JSON response over `idem:{key}` with the 86400 s expiry so replays outlive the marker.',
      match: {
        python: {order: [/=\s*process_checkout\(/, /\.set\(\s*\w+\s*,\s*[^,\n]+,\s*ex\s*=\s*IDEM_TTL_S\s*\)/]},
        go: {order: [/=\s*processCheckout\(/, /rdb\.Set\(\s*[\w.()]+\s*,\s*\w+\s*,\s*[^,\n]+,\s*idemTTL\s*\)/]},
        scala: {
          order: [
            /processCheckout\(\s*\w+\s*\)/,
            /jedis\.set\(\s*\w+\s*,\s*[^,\n]+,[^\n]*\.ex\(\s*IdemTtlSeconds\s*\)/,
          ],
        },
        cpp: {order: [/=\s*process_checkout\(/, /redis\.set\(\s*\w+\s*,\s*[^,\n]+,\s*kIdemTtl\s*\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis
from fastapi import FastAPI, HTTPException, Request, Response

app = FastAPI()
r = redis.Redis(host="redis", port=6379)

IDEM_TTL_S = 86400
PROCESSING = b"processing"


def process_checkout(body: dict) -> dict:
    """Authorize, capture and record the order (built in the next steps); returns the response document."""
    raise NotImplementedError


@app.post("/checkout")
async def checkout(request: Request) -> Response:
    body = await request.json()
    # TODO: 400 when the Idempotency-Key header is missing
    # TODO: SET idem:{key} PROCESSING NX EX IDEM_TTL_S; refused → replay the stored response (200) or 409 while processing
    # TODO: process_checkout(body), SET the JSON response over the key with the same TTL, answer 201
    raise HTTPException(status_code=501)


# uvicorn checkout_api:app --port 8443 --ssl-certfile cert.pem --ssl-keyfile key.pem
`,
      solution: `import json

import redis
from fastapi import FastAPI, HTTPException, Request, Response

app = FastAPI()
r = redis.Redis(host="redis", port=6379)

IDEM_TTL_S = 86400
PROCESSING = b"processing"


def process_checkout(body: dict) -> dict:
    """Authorize, capture and record the order (built in the next steps); returns the response document."""
    raise NotImplementedError


@app.post("/checkout")
async def checkout(request: Request) -> Response:
    body = await request.json()
    idem_key = request.headers.get("idempotency-key")
    if not idem_key:
        raise HTTPException(status_code=400, detail="Idempotency-Key header is required")
    key = f"idem:{idem_key}"
    if not r.set(key, PROCESSING, nx=True, ex=IDEM_TTL_S):
        stored = r.get(key)
        if stored is None or stored == PROCESSING:
            raise HTTPException(status_code=409, detail="a request with this Idempotency-Key is in progress")
        return Response(content=stored, media_type="application/json", status_code=200)
    try:
        result = process_checkout(body)
    except Exception:
        r.delete(key)  # let the client retry with the same key
        raise
    encoded = json.dumps(result)
    r.set(key, encoded, ex=IDEM_TTL_S)
    return Response(content=encoded, media_type="application/json", status_code=201)


# uvicorn checkout_api:app --port 8443 --ssl-certfile cert.pem --ssl-keyfile key.pem
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

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	idemTTL    = 24 * time.Hour
	processing = "processing"
)

// processCheckout authorizes, captures and records the order (built in the next steps); returns the response document.
func processCheckout(ctx context.Context, body map[string]any) (map[string]any, error) {
	panic("not implemented")
}

func checkout(rw http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, "invalid JSON", http.StatusBadRequest)
		return
	}
	// TODO: 400 when the Idempotency-Key header is missing
	// TODO: SetNX idem:{key} processing idemTTL; refused → replay the stored response (200) or 409 while processing
	// TODO: processCheckout(body), Set the JSON response over the key with the same TTL, answer 201
	http.Error(rw, "not implemented", http.StatusNotImplemented)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /checkout", checkout)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
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

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	idemTTL    = 24 * time.Hour
	processing = "processing"
)

// processCheckout authorizes, captures and records the order (built in the next steps); returns the response document.
func processCheckout(ctx context.Context, body map[string]any) (map[string]any, error) {
	panic("not implemented")
}

func checkout(rw http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
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
	won, err := rdb.SetNX(ctx, key, processing, idemTTL).Result()
	if err != nil {
		http.Error(rw, "idempotency store unavailable", http.StatusServiceUnavailable)
		return
	}
	if !won {
		stored, err := rdb.Get(ctx, key).Bytes()
		if err != nil || string(stored) == processing {
			http.Error(rw, "a request with this Idempotency-Key is in progress", http.StatusConflict)
			return
		}
		rw.Header().Set("Content-Type", "application/json")
		rw.WriteHeader(http.StatusOK)
		rw.Write(stored)
		return
	}
	result, err := processCheckout(ctx, body)
	if err != nil {
		rdb.Del(ctx, key) // let the client retry with the same key
		http.Error(rw, err.Error(), http.StatusBadGateway)
		return
	}
	encoded, _ := json.Marshal(result)
	rdb.Set(ctx, key, encoded, idemTTL)
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(http.StatusCreated)
	rw.Write(encoded)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /checkout", checkout)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.{ConnectionContext, Http}
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

object CheckoutApi {
  val jedis = new JedisPooled("redis", 6379)
  val IdemTtlSeconds = 86400L
  val Processing = "processing"

  /** Authorize, capture and record the order (built in the next steps); returns the response JSON. */
  def processCheckout(body: String): String = ???

  val route: Route =
    path("checkout") {
      post {
        entity(as[String]) { body =>
          optionalHeaderValueByName("Idempotency-Key") { idemKey =>
            // TODO: 400 when idemKey is None
            // TODO: SET idem:{key} Processing NX EX IdemTtlSeconds; refused → replay the stored response (200) or 409 while processing
            // TODO: processCheckout(body), SET the JSON response over the key with the same TTL, answer 201
            complete(StatusCodes.NotImplemented)
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("checkout")
    val https = ConnectionContext.httpsServer(Tls.serverContext("cert.pem", "key.pem"))
    Http().newServerAt("0.0.0.0", 8443).enableHttps(https).bind(route)
  }
}
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.{ConnectionContext, Http}
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

object CheckoutApi {
  val jedis = new JedisPooled("redis", 6379)
  val IdemTtlSeconds = 86400L
  val Processing = "processing"

  /** Authorize, capture and record the order (built in the next steps); returns the response JSON. */
  def processCheckout(body: String): String = ???

  private def json(status: StatusCode, body: String) =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body))

  val route: Route =
    path("checkout") {
      post {
        entity(as[String]) { body =>
          optionalHeaderValueByName("Idempotency-Key") {
            case None => complete(StatusCodes.BadRequest -> "Idempotency-Key header is required")
            case Some(idemKey) =>
              val key = s"idem:$idemKey"
              val won = jedis.set(key, Processing, SetParams.setParams().nx().ex(IdemTtlSeconds)) != null
              if (!won) {
                Option(jedis.get(key)) match {
                  case Some(stored) if stored != Processing => complete(json(StatusCodes.OK, stored))
                  case _ => complete(StatusCodes.Conflict -> "a request with this Idempotency-Key is in progress")
                }
              } else {
                val encoded =
                  try processCheckout(body)
                  catch { case e: Exception => jedis.del(key); throw e } // let the client retry with the same key
                jedis.set(key, encoded, SetParams.setParams().ex(IdemTtlSeconds))
                complete(json(StatusCodes.Created, encoded))
              }
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("checkout")
    val https = ConnectionContext.httpsServer(Tls.serverContext("cert.pem", "key.pem"))
    Http().newServerAt("0.0.0.0", 8443).enableHttps(https).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#define CPPHTTPLIB_OPENSSL_SUPPORT
#include <httplib.h>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>

sw::redis::Redis redis("tcp://redis:6379");

constexpr std::chrono::seconds kIdemTtl{86400};
const std::string kProcessing = "processing";

// Authorize, capture and record the order (built in the next steps); returns the response JSON.
std::string process_checkout(const std::string& body);

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Post("/checkout", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: 400 when the Idempotency-Key header is missing
    // TODO: SET idem:{key} kProcessing NX EX kIdemTtl; refused → replay the stored response (200) or 409 while processing
    // TODO: process_checkout(req.body), SET the JSON response over the key with the same TTL, answer 201
    res.status = 501;
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#define CPPHTTPLIB_OPENSSL_SUPPORT
#include <httplib.h>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>

sw::redis::Redis redis("tcp://redis:6379");

constexpr std::chrono::seconds kIdemTtl{86400};
const std::string kProcessing = "processing";

// Authorize, capture and record the order (built in the next steps); returns the response JSON.
std::string process_checkout(const std::string& body);

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Post("/checkout", [](const httplib::Request& req, httplib::Response& res) {
    if (!req.has_header("Idempotency-Key")) {
      res.status = 400;
      res.set_content("Idempotency-Key header is required", "text/plain");
      return;
    }
    const std::string key = "idem:" + req.get_header_value("Idempotency-Key");
    const bool won = redis.set(key, kProcessing, kIdemTtl, sw::redis::UpdateType::NOT_EXIST);
    if (!won) {
      const auto stored = redis.get(key);
      if (!stored || *stored == kProcessing) {
        res.status = 409;
        res.set_content("a request with this Idempotency-Key is in progress", "text/plain");
        return;
      }
      res.status = 200;
      res.set_content(*stored, "application/json");
      return;
    }
    std::string encoded;
    try {
      encoded = process_checkout(req.body);
    } catch (...) {
      redis.del(key);  // let the client retry with the same key
      throw;
    }
    redis.set(key, encoded, kIdemTtl);
    res.status = 201;
    res.set_content(encoded, "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The idempotency key turns "at least once" from the network into "exactly once" at the API: the atomic \`SET NX EX\` is both the check and the claim, the stored body makes the replay byte-identical, and the TTL bounds how long the promise is kept. Stripe's implementation adds a fingerprint of the request body (same key, different body → 422), scopes keys per API key, and stores the response even when it was an error so a retry does not accidentally succeed.`,
};
