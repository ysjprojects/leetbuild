import type {Step} from '@/lib/types';

export const checkoutEndpointStep: Step = {
  id: 'checkout-endpoint',
  title: 'POST /checkout: say no fast',
  concept: 'http',
  file: 'checkout_api',
  focus: ['client', 'checkout', 'redis'],
  task: `## Task

Implement \`POST /checkout\` with body \`{"sku": "…", "qty": n, "user": "…"}\`. \`reserve\`, \`release\` and
\`enqueue_order\` are provided (steps 1, 5 and 3). During a drop the endpoint's job is to say **no** as
cheaply as possible and to promise only what it can keep:

- Missing \`sku\`/\`user\` or \`qty\` outside **1–5** → **400**.
- Per-user attempt limit: \`INCR attempts:{user}\`; when the result is 1 (first attempt in the window)
  set \`EXPIRE … 60\`. More than **20** attempts → **429** with \`Retry-After: 60\`. Do this *before*
  touching stock: a bot must not cost a Lua call per request.
- \`reserve\` returned 0 → **409** with \`{"error": "SOLD_OUT"}\`.
- Otherwise call \`enqueue_order(order)\` with \`{order_id, sku, qty, user}\` and answer **202**
  \`{"order_id": …, "status": "reserved"}\`. Nothing is paid yet: 202 says "accepted for processing",
  not "done".
- If \`enqueue_order\` fails the promise cannot be kept: \`release(order_id)\` and answer **503**.

:::widget status-codes {}

> INCR + EXPIRE is a fixed window: 20 per minute, refilled all at once. The bucket below is the
> smoother version (1 token/s, burst 20) that gateways use; both live in Redis so every API replica
> shares the count.

:::widget token-bucket {"rate": 1, "burst": 20}`,
  sequence: {
    participants: ['Client', 'checkout', 'Redis'],
    messages: [
      {from: 'Client', to: 'checkout', label: 'POST /checkout {shoe-42, qty 2, u9}', kind: 'sync'},
      {from: 'checkout', to: 'Redis', label: 'INCR attempts:u9 → 1 · EXPIRE 60', kind: 'sync'},
      {from: 'checkout', to: 'Redis', label: 'EVALSHA reserve → 1', kind: 'sync'},
      {from: 'checkout', to: 'checkout', label: 'enqueue_order(order)', kind: 'sync'},
      {from: 'checkout', to: 'Client', label: '202 {order_id, status: reserved}', kind: 'reply'},
      {from: 'Client', to: 'checkout', label: 'POST /checkout (21st attempt)', kind: 'sync'},
      {from: 'checkout', to: 'Client', label: '429 · Retry-After: 60', kind: 'reply'},
    ],
  },
  hints: [
    'Order the branches by cost: validation (free), the attempt counter (one INCR), the reservation (a Lua script), the Kafka ack (a network round trip). Each rejection returns before the next, more expensive step.',
    'INCR returns the new value; `== 1` means you created the key this request and must set its TTL. Anything above the limit gets 429 with a `Retry-After` header in seconds.',
    'Generate the order id before calling `reserve` — it is the hold key — and reuse the same id in the record you hand to `enqueue_order` and in the 202 body. Wrap only the enqueue in the error path that releases and answers 503.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles POST /checkout',
      detail: 'A handler must be registered for `POST` on the `/checkout` path.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/checkout["']/]},
        go: {all: [/HandleFunc\(\s*"POST \/checkout"/]},
        scala: {all: [/path\(\s*"checkout"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/checkout"/]},
      },
    },
    {
      id: 'validate',
      title: 'Rejects bad bodies with 400',
      detail:
        'A missing `sku`/`user` or a `qty` outside 1..5 is answered with `400 Bad Request` before anything is touched.',
      match: {
        python: {all: [/(>|<=)\s*MAX_QTY\b|\bMAX_QTY\s*(<|>=)/, /status_code\s*=\s*400|HTTP_400/]},
        go: {all: [/(>|<=)\s*maxQty\b|\bmaxQty\s*(<|>=)/, /http\.StatusBadRequest|\b400\b/]},
        scala: {all: [/(>|<=)\s*MaxQty\b|\bMaxQty\s*(<|>=)/, /StatusCodes\.BadRequest|\b400\b/]},
        cpp: {all: [/(>|<=)\s*kMaxQty\b|\bkMaxQty\s*(<|>=)/, /status\s*=\s*400/]},
      },
    },
    {
      id: 'attempt-limit',
      title: 'Limits attempts per user with INCR + EXPIRE and answers 429',
      detail:
        'Count attempts in `attempts:{user}`, set the 60 s window when the counter is created (`INCR` returned 1), and answer `429` with `Retry-After` past 20.',
      match: {
        python: {
          all: [
            /f["']attempts:\{|["']attempts:["']\s*\+/,
            /\br\.incr\(/,
            /\br\.expire\(/,
            /==\s*1\b/,
            /status_code\s*=\s*429/,
            /Retry-After/,
          ],
        },
        go: {
          all: [
            /"attempts:(%s"|"\s*\+)/,
            /rdb\.Incr\(/,
            /rdb\.Expire\(/,
            /==\s*1\b/,
            /http\.StatusTooManyRequests|\b429\b/,
            /Retry-After/,
          ],
        },
        scala: {
          all: [
            /s"attempts:\$|"attempts:"\s*\+/,
            /jedis\.incr\(/,
            /jedis\.expire\(/,
            /==\s*1L?\b/,
            /StatusCodes\.TooManyRequests|\b429\b/,
            /Retry-After/,
          ],
        },
        cpp: {
          all: [
            /"attempts:"\)?\s*\+/,
            /redis\.incr\(/,
            /redis\.expire\(/,
            /==\s*1\b/,
            /status\s*=\s*429/,
            /Retry-After/,
          ],
        },
      },
    },
    {
      id: 'sold-out',
      title: 'Answers 409 SOLD_OUT when the reservation fails',
      detail:
        'A reservation that returns 0 is a conflict with the current state of stock, not a client error: `409` with `{"error": "SOLD_OUT"}`.',
      match: {
        python: {all: [/status_code\s*=\s*409/, /SOLD_OUT/]},
        go: {all: [/http\.StatusConflict|\b409\b/, /SOLD_OUT/]},
        scala: {all: [/StatusCodes\.Conflict|\b409\b/, /SOLD_OUT/]},
        cpp: {all: [/status\s*=\s*409/, /SOLD_OUT/]},
      },
    },
    {
      id: 'accepted',
      title: 'Enqueues after reserving, answers 202, releases on failure',
      detail:
        'Reserve first, then hand the order to `enqueue_order`, then answer `202`; when the enqueue fails, `release(order_id)` and answer `503` so the 202 is never a lie.',
      match: {
        python: {
          all: [/status_code\s*=\s*503/, /release\(\s*order_id\s*\)/],
          order: [/not reserve\(|=\s*reserve\(/, /enqueue_order\(\s*order\s*\)/, /status_code\s*=\s*202/],
        },
        go: {
          all: [/http\.StatusServiceUnavailable|\b503\b/, /release\(\s*ctx\s*,\s*\w+(\.OrderID)?\s*\)/],
          order: [/=\s*reserve\(/, /enqueueOrder\(\s*ctx\s*,\s*order\s*\)/, /http\.StatusAccepted|\b202\b/],
        },
        scala: {
          all: [/StatusCodes\.ServiceUnavailable|\b503\b/, /release\(\s*\w+(\.orderId)?\s*\)/],
          order: [/!reserve\(|=\s*reserve\(/, /enqueueOrder\(\s*order\s*\)/, /StatusCodes\.Accepted|\b202\b/],
        },
        cpp: {
          all: [/status\s*=\s*503/, /release\(\s*order_id\s*\)/],
          order: [/!reserve\(|=\s*reserve\(/, /enqueue_order\(\s*order\s*\)/, /status\s*=\s*202/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import uuid

import redis
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379)

MAX_QTY = 5
MAX_ATTEMPTS = 20
WINDOW_S = 60


class CheckoutRequest(BaseModel):
    sku: str = ""
    qty: int = 0
    user: str = ""


def reserve(sku: str, order_id: str, qty: int) -> bool:
    """Atomic stock reservation (step 1); False when sold out."""
    raise NotImplementedError


def release(order_id: str) -> None:
    """Gives a hold back to stock (step 5)."""
    raise NotImplementedError


def enqueue_order(order: dict) -> None:
    """Durable intake through Kafka (step 3); raises RuntimeError when the broker did not acknowledge."""
    raise NotImplementedError


@app.post("/checkout")
def checkout(body: CheckoutRequest) -> JSONResponse:
    # TODO: 400 unless sku, user and 1 <= qty <= MAX_QTY
    # TODO: INCR attempts:{user}; EXPIRE WINDOW_S when it is the first; > MAX_ATTEMPTS → 429 + Retry-After
    # TODO: order_id = uuid4().hex; reserve() returned False → 409 SOLD_OUT
    # TODO: enqueue_order({order_id, sku, qty, user}) → 202; on RuntimeError release() and 503
    raise HTTPException(status_code=501)


# uvicorn checkout_api:app --port 8443 --ssl-certfile cert.pem --ssl-keyfile key.pem
`,
      solution: `import uuid

import redis
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379)

MAX_QTY = 5
MAX_ATTEMPTS = 20
WINDOW_S = 60


class CheckoutRequest(BaseModel):
    sku: str = ""
    qty: int = 0
    user: str = ""


def reserve(sku: str, order_id: str, qty: int) -> bool:
    """Atomic stock reservation (step 1); False when sold out."""
    raise NotImplementedError


def release(order_id: str) -> None:
    """Gives a hold back to stock (step 5)."""
    raise NotImplementedError


def enqueue_order(order: dict) -> None:
    """Durable intake through Kafka (step 3); raises RuntimeError when the broker did not acknowledge."""
    raise NotImplementedError


@app.post("/checkout")
def checkout(body: CheckoutRequest) -> JSONResponse:
    if not body.sku or not body.user or body.qty < 1 or body.qty > MAX_QTY:
        raise HTTPException(status_code=400, detail=f"sku, user and qty 1..{MAX_QTY} are required")
    attempts = r.incr(f"attempts:{body.user}")
    if attempts == 1:
        r.expire(f"attempts:{body.user}", WINDOW_S)
    if attempts > MAX_ATTEMPTS:
        return JSONResponse({"error": "TOO_MANY_ATTEMPTS"}, status_code=429, headers={"Retry-After": str(WINDOW_S)})
    order_id = uuid.uuid4().hex
    if not reserve(body.sku, order_id, body.qty):
        return JSONResponse({"error": "SOLD_OUT"}, status_code=409)
    order = {"order_id": order_id, "sku": body.sku, "qty": body.qty, "user": body.user}
    try:
        enqueue_order(order)
    except RuntimeError:
        release(order_id)
        return JSONResponse({"error": "TRY_AGAIN"}, status_code=503)
    return JSONResponse({"order_id": order_id, "status": "reserved"}, status_code=202)


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
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

const (
	maxQty      = 5
	maxAttempts = 20
	window      = time.Minute
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type Order struct {
	OrderID string \`json:"order_id"\`
	SKU     string \`json:"sku"\`
	Qty     int    \`json:"qty"\`
	User    string \`json:"user"\`
}

// reserve is the atomic stock reservation (step 1); false when sold out.
func reserve(ctx context.Context, sku, orderID string, qty int) (bool, error) { panic("not implemented") }

// release gives a hold back to stock (step 5).
func release(ctx context.Context, orderID string) error { panic("not implemented") }

// enqueueOrder is the durable intake through Kafka (step 3); it errors when the broker did not acknowledge.
func enqueueOrder(ctx context.Context, order Order) error { panic("not implemented") }

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func checkout(rw http.ResponseWriter, r *http.Request) {
	var req struct {
		SKU  string \`json:"sku"\`
		Qty  int    \`json:"qty"\`
		User string \`json:"user"\`
	}
	err := json.NewDecoder(r.Body).Decode(&req)
	// TODO: 400 unless err == nil, SKU, User and 1 <= Qty <= maxQty
	// TODO: Incr attempts:{user}; Expire window when it is the first; > maxAttempts → 429 + Retry-After
	// TODO: order := Order{OrderID: uuid.NewString(), …}; reserve() returned false → 409 SOLD_OUT
	// TODO: enqueueOrder(ctx, order) → 202; on error release() and 503
	_, _ = err, strconv.Itoa
	_ = uuid.NewString
	writeJSON(rw, http.StatusNotImplemented, map[string]string{"error": "not implemented"})
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
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

const (
	maxQty      = 5
	maxAttempts = 20
	window      = time.Minute
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type Order struct {
	OrderID string \`json:"order_id"\`
	SKU     string \`json:"sku"\`
	Qty     int    \`json:"qty"\`
	User    string \`json:"user"\`
}

// reserve is the atomic stock reservation (step 1); false when sold out.
func reserve(ctx context.Context, sku, orderID string, qty int) (bool, error) { panic("not implemented") }

// release gives a hold back to stock (step 5).
func release(ctx context.Context, orderID string) error { panic("not implemented") }

// enqueueOrder is the durable intake through Kafka (step 3); it errors when the broker did not acknowledge.
func enqueueOrder(ctx context.Context, order Order) error { panic("not implemented") }

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func checkout(rw http.ResponseWriter, r *http.Request) {
	var req struct {
		SKU  string \`json:"sku"\`
		Qty  int    \`json:"qty"\`
		User string \`json:"user"\`
	}
	err := json.NewDecoder(r.Body).Decode(&req)
	if err != nil || req.SKU == "" || req.User == "" || req.Qty < 1 || req.Qty > maxQty {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "sku, user and qty 1..5 are required"})
		return
	}
	ctx := r.Context()
	attempts, err := rdb.Incr(ctx, "attempts:"+req.User).Result()
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if attempts == 1 {
		rdb.Expire(ctx, "attempts:"+req.User, window)
	}
	if attempts > maxAttempts {
		rw.Header().Set("Retry-After", strconv.Itoa(int(window.Seconds())))
		writeJSON(rw, http.StatusTooManyRequests, map[string]string{"error": "TOO_MANY_ATTEMPTS"})
		return
	}
	order := Order{OrderID: uuid.NewString(), SKU: req.SKU, Qty: req.Qty, User: req.User}
	ok, err := reserve(ctx, order.SKU, order.OrderID, order.Qty)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if !ok {
		writeJSON(rw, http.StatusConflict, map[string]string{"error": "SOLD_OUT"})
		return
	}
	if err := enqueueOrder(ctx, order); err != nil {
		release(ctx, order.OrderID)
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	writeJSON(rw, http.StatusAccepted, map[string]string{"order_id": order.OrderID, "status": "reserved"})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /checkout", checkout)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.{ConnectionContext, Http}
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class CheckoutRequest(sku: String, qty: Int, user: String)
final case class Order(orderId: String, sku: String, qty: Int, user: String)

object CheckoutApi {
  val jedis = new JedisPooled("redis", 6379)
  val MaxQty = 5
  val MaxAttempts = 20L
  val WindowSeconds = 60L

  implicit val checkoutFormat: RootJsonFormat[CheckoutRequest] = jsonFormat3(CheckoutRequest)

  /** Atomic stock reservation (step 1); false when sold out. */
  def reserve(sku: String, orderId: String, qty: Int): Boolean = ???
  /** Gives a hold back to stock (step 5). */
  def release(orderId: String): Unit = ???
  /** Durable intake through Kafka (step 3); throws a RuntimeException when the broker did not acknowledge. */
  def enqueueOrder(order: Order): Unit = ???

  private def json(status: StatusCode, body: String, headers: List[HttpHeader] = Nil): Route =
    complete(HttpResponse(status, headers = headers, entity = HttpEntity(ContentTypes.\`application/json\`, body)))

  val route: Route =
    path("checkout") {
      post {
        entity(as[CheckoutRequest]) { req =>
          // TODO: 400 unless sku, user and 1 <= qty <= MaxQty
          // TODO: incr attempts:{user}; expire WindowSeconds when it is the first; > MaxAttempts → 429 + Retry-After
          // TODO: Order(UUID.randomUUID().toString, …); reserve() returned false → 409 SOLD_OUT
          // TODO: enqueueOrder(order) → 202; on RuntimeException release() and 503
          json(StatusCodes.NotImplemented, """{"error":"not implemented"}""")
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
      solution: `import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.{ConnectionContext, Http}
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class CheckoutRequest(sku: String, qty: Int, user: String)
final case class Order(orderId: String, sku: String, qty: Int, user: String)

object CheckoutApi {
  val jedis = new JedisPooled("redis", 6379)
  val MaxQty = 5
  val MaxAttempts = 20L
  val WindowSeconds = 60L

  implicit val checkoutFormat: RootJsonFormat[CheckoutRequest] = jsonFormat3(CheckoutRequest)

  /** Atomic stock reservation (step 1); false when sold out. */
  def reserve(sku: String, orderId: String, qty: Int): Boolean = ???
  /** Gives a hold back to stock (step 5). */
  def release(orderId: String): Unit = ???
  /** Durable intake through Kafka (step 3); throws a RuntimeException when the broker did not acknowledge. */
  def enqueueOrder(order: Order): Unit = ???

  private def json(status: StatusCode, body: String, headers: List[HttpHeader] = Nil): Route =
    complete(HttpResponse(status, headers = headers, entity = HttpEntity(ContentTypes.\`application/json\`, body)))

  val route: Route =
    path("checkout") {
      post {
        entity(as[CheckoutRequest]) { req =>
          if (req.sku.isEmpty || req.user.isEmpty || req.qty < 1 || req.qty > MaxQty)
            json(StatusCodes.BadRequest, """{"error":"sku, user and qty 1..5 are required"}""")
          else {
            val attempts = jedis.incr(s"attempts:\${req.user}")
            if (attempts == 1L) jedis.expire(s"attempts:\${req.user}", WindowSeconds)
            if (attempts > MaxAttempts)
              json(StatusCodes.TooManyRequests, """{"error":"TOO_MANY_ATTEMPTS"}""", List(RawHeader("Retry-After", WindowSeconds.toString)))
            else {
              val order = Order(UUID.randomUUID().toString, req.sku, req.qty, req.user)
              if (!reserve(order.sku, order.orderId, order.qty)) json(StatusCodes.Conflict, """{"error":"SOLD_OUT"}""")
              else
                try {
                  enqueueOrder(order)
                  json(StatusCodes.Accepted, s"""{"order_id":"\${order.orderId}","status":"reserved"}""")
                } catch {
                  case _: RuntimeException =>
                    release(order.orderId)
                    json(StatusCodes.ServiceUnavailable, """{"error":"TRY_AGAIN"}""")
                }
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
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>

#include "ids.h"  // std::string new_order_id()

using json = nlohmann::json;

constexpr int kMaxQty = 5;
constexpr long long kMaxAttempts = 20;
constexpr std::chrono::seconds kWindow{60};

sw::redis::Redis redis("tcp://redis:6379");

// Atomic stock reservation (step 1); false when sold out.
bool reserve(const std::string& sku, const std::string& order_id, int qty);
// Gives a hold back to stock (step 5).
void release(const std::string& order_id);
// Durable intake through Kafka (step 3); throws when the broker did not acknowledge.
struct Order {
  std::string order_id, sku, user;
  int qty;
};
void enqueue_order(const Order& order);

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Post("/checkout", [](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    const std::string sku = body.value("sku", ""), user = body.value("user", "");
    const int qty = body.value("qty", 0);
    // TODO: 400 unless sku, user and 1 <= qty <= kMaxQty
    // TODO: incr attempts:{user}; expire kWindow when it is the first; > kMaxAttempts → 429 + Retry-After
    // TODO: order_id = new_order_id(); reserve() returned false → 409 SOLD_OUT
    // TODO: enqueue_order(Order{order_id, sku, user, qty}) → 202; on exception release() and 503
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

#include "ids.h"  // std::string new_order_id()

using json = nlohmann::json;

constexpr int kMaxQty = 5;
constexpr long long kMaxAttempts = 20;
constexpr std::chrono::seconds kWindow{60};

sw::redis::Redis redis("tcp://redis:6379");

// Atomic stock reservation (step 1); false when sold out.
bool reserve(const std::string& sku, const std::string& order_id, int qty);
// Gives a hold back to stock (step 5).
void release(const std::string& order_id);
// Durable intake through Kafka (step 3); throws when the broker did not acknowledge.
struct Order {
  std::string order_id, sku, user;
  int qty;
};
void enqueue_order(const Order& order);

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Post("/checkout", [](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    const std::string sku = body.value("sku", ""), user = body.value("user", "");
    const int qty = body.value("qty", 0);
    if (sku.empty() || user.empty() || qty < 1 || qty > kMaxQty) {
      res.status = 400;
      res.set_content(R"({"error":"sku, user and qty 1..5 are required"})", "application/json");
      return;
    }
    const long long attempts = redis.incr("attempts:" + user);
    if (attempts == 1) redis.expire("attempts:" + user, kWindow);
    if (attempts > kMaxAttempts) {
      res.status = 429;
      res.set_header("Retry-After", std::to_string(kWindow.count()));
      res.set_content(R"({"error":"TOO_MANY_ATTEMPTS"})", "application/json");
      return;
    }
    const std::string order_id = new_order_id();
    if (!reserve(sku, order_id, qty)) {
      res.status = 409;
      res.set_content(R"({"error":"SOLD_OUT"})", "application/json");
      return;
    }
    const Order order{order_id, sku, user, qty};
    try {
      enqueue_order(order);
    } catch (const std::exception&) {
      release(order_id);
      res.status = 503;
      res.set_content(R"({"error":"TRY_AGAIN"})", "application/json");
      return;
    }
    res.status = 202;
    res.set_content(json{{"order_id", order_id}, {"status", "reserved"}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `Every branch is ordered by what it costs: a 400 costs nothing, a 429 costs one INCR, a 409 costs the Lua script, and only a 202 pays for a Kafka round trip. The status codes carry meaning a client can act on — 429 says *wait*, 409 says *stop*, 503 says *try again* — and the 202 is honest: the order is accepted, not fulfilled. Real checkouts put a virtual waiting room in front of this endpoint, score requests for bot likelihood instead of counting them, and return a status URL the client polls.`,
};
