import type {Step} from '@/lib/types';

export const orderGatewayStep: Step = {
  id: 'order-gateway',
  title: 'Accept orders over HTTPS',
  concept: 'http',
  file: 'order_gateway',
  focus: ['client', 'gateway'],
  task: `## Task

Implement \`POST /orders\`, the only door into the exchange. \`publish_order(order)\` is provided (you build it in
the next step): it hands the order to the engine, blocks until Kafka acknowledges it, and raises \`PublishFailed\`
when it does not — in an async handler keep that blocking call off the event loop.

- Require an \`X-Api-Key\` header that is one of \`API_KEYS\`; otherwise **401**. Check it before reading the body.
- Require an \`Idempotency-Key\` header; otherwise **400**. A client that times out re-sends with the same key,
  so the same order is never placed twice.
- The JSON body is \`{symbol, side, price, qty, client_order_id}\`: \`side\` must be one of \`SIDES\`, \`price\` and
  \`qty\` must be **> 0**, \`symbol\` and \`client_order_id\` must be present. Anything else → **400**.
- Build the \`Order\` with a fresh \`order_id\`, call \`publish_order\`, and answer **202 Accepted** with
  \`{"order_id": …, "status": "accepted"}\`. A **202** is a promise, not a fill: the match happens later.
- \`PublishFailed\` → **503**: the order was not durably accepted and the client should retry with the same
  \`Idempotency-Key\`.

:::widget http-lifecycle {}

> The gateway terminates TLS itself (a cert and key are on disk): in a trading system the API key travels in
> the clear inside the TLS tunnel, so there is no gateway without HTTPS.

:::widget status-codes {}`,
  sequence: {
    participants: ['Client', 'gateway', 'publish_order'],
    messages: [
      {from: 'Client', to: 'gateway', label: 'POST /orders · X-Api-Key · Idempotency-Key', kind: 'sync'},
      {from: 'gateway', to: 'gateway', label: 'auth · validate side/price/qty', kind: 'sync'},
      {from: 'gateway', to: 'publish_order', label: 'publish_order(order)', kind: 'sync'},
      {from: 'publish_order', to: 'gateway', label: 'acknowledged', kind: 'reply'},
      {from: 'gateway', to: 'Client', label: '202 {order_id, status: accepted}', kind: 'reply'},
      {from: 'Client', to: 'gateway', label: 'POST /orders (no X-Api-Key)', kind: 'sync'},
      {from: 'gateway', to: 'Client', label: '401 Unauthorized', kind: 'reply'},
    ],
  },
  hints: [
    'Order the checks by cost: the API key and the Idempotency-Key are header lookups and reject before the body is even parsed; validation comes next; publishing is last.',
    'Validation is a single condition over the parsed fields: side in SIDES, price > 0, qty > 0, symbol and client_order_id present. One 400 with a clear message beats five.',
    'Wrap only the publish call in the error handler: PublishFailed → 503, then build the 202 body from the order you already have — the order id is yours, not the broker’s.',
  ],
  checks: [
    {
      id: 'auth',
      title: 'Rejects requests without a valid X-Api-Key with 401',
      detail:
        'Read the `X-Api-Key` header, look it up in the known keys, and answer `401 Unauthorized` before touching the body.',
      match: {
        python: {all: [/x-api-key/i, /status_code\s*=\s*401|HTTP_401/]},
        go: {all: [/X-Api-Key/i, /http\.StatusUnauthorized|\b401\b/]},
        scala: {all: [/X-Api-Key/i, /StatusCodes\.Unauthorized|\b401\b/]},
        cpp: {all: [/X-Api-Key/i, /\b401\b/]},
      },
    },
    {
      id: 'idempotency-key',
      title: 'Requires an Idempotency-Key header',
      detail:
        'Without an `Idempotency-Key` a retried request is a second order; answer `400 Bad Request` when the header is missing.',
      match: {
        python: {all: [/idempotency-key/i, /status_code\s*=\s*400|HTTP_400/]},
        go: {all: [/Idempotency-Key/i, /http\.StatusBadRequest|\b400\b/]},
        scala: {all: [/Idempotency-Key/i, /StatusCodes\.BadRequest|\b400\b/]},
        cpp: {all: [/Idempotency-Key/i, /\b400\b/]},
      },
    },
    {
      id: 'validate',
      title: 'Rejects a bad side, price or qty with 400',
      detail:
        'Check `side` against the allowed sides and require `price > 0` and `qty > 0` before the order goes anywhere near the engine.',
      match: {
        python: {
          all: [/in SIDES\b/, /price\s*(<=\s*0|>\s*0)/, /qty\s*(<=\s*0|>\s*0)/, /status_code\s*=\s*400|HTTP_400/],
        },
        go: {
          all: [
            /sides\[\s*order\.Side\s*\]/,
            /Price\s*(<=\s*0|>\s*0)/,
            /Qty\s*(<=\s*0|>\s*0)/,
            /http\.StatusBadRequest|\b400\b/,
          ],
        },
        scala: {
          all: [
            /Sides\.contains\(|Sides\(/,
            /price\s*(<=\s*0|>\s*0)/,
            /qty\s*(<=\s*0|>\s*0)/,
            /StatusCodes\.BadRequest|\b400\b/,
          ],
        },
        cpp: {all: [/kSides\.(count|contains|find)\(/, /price\s*(<=\s*0|>\s*0)/, /qty\s*(<=\s*0|>\s*0)/, /\b400\b/]},
      },
    },
    {
      id: 'accepted',
      title: 'Answers 202 with the order id after publishing',
      detail:
        'Call `publish_order` first, then respond `202 Accepted` with `{order_id, status: "accepted"}` — the order is durable but not yet matched.',
      match: {
        python: {order: [/(?<!def )\bpublish_order\s*[,(]/, /status_code\s*=\s*202|HTTP_202/], all: [/"accepted"/]},
        go: {order: [/(?<!func )publishOrder\(/, /http\.StatusAccepted|\b202\b/], all: [/"accepted"/]},
        scala: {order: [/(?<!def )publishOrder\(/, /StatusCodes\.Accepted|\b202\b/], all: [/"accepted"/]},
        cpp: {order: [/(?<!void )publish_order\(/, /\b202\b/], all: [/"accepted"/]},
      },
    },
    {
      id: 'unavailable',
      title: 'Answers 503 when the order cannot be published',
      detail:
        'A `PublishFailed` means the broker never acknowledged the order: `503 Service Unavailable` tells the client to retry with the same `Idempotency-Key`.',
      match: {
        python: {all: [/except PublishFailed/, /status_code\s*=\s*503|HTTP_503/]},
        go: {order: [/(?<!func )publishOrder\(/, /http\.StatusServiceUnavailable|\b503\b/]},
        scala: {all: [/case \w+: PublishFailed/, /StatusCodes\.ServiceUnavailable|\b503\b/]},
        cpp: {all: [/catch\s*\(\s*(const\s+)?PublishFailed\s*&/, /\b503\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import asyncio
import uuid
from dataclasses import dataclass

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

app = FastAPI()

SIDES = {"BUY", "SELL"}
API_KEYS = {"k-1f9c": "desk-a", "k-77b2": "desk-b"}


@dataclass
class Order:
    order_id: str
    symbol: str
    side: str
    price: float
    qty: int
    client_order_id: str


class PublishFailed(Exception):
    """Raised by publish_order when Kafka does not acknowledge the order."""


def publish_order(order: Order) -> None:
    """Hand the order to the engine (built in the next step)."""
    raise NotImplementedError


@app.post("/orders")
async def place_order(request: Request) -> JSONResponse:
    # TODO: 401 unless X-Api-Key is one of API_KEYS (before reading the body)
    # TODO: 400 unless an Idempotency-Key header is present
    # TODO: parse the JSON body; 400 unless side in SIDES, price > 0, qty > 0, symbol and client_order_id present
    # TODO: Order with a uuid4 order_id; await asyncio.to_thread(publish_order, order) — it blocks on the broker's ack
    # TODO: PublishFailed → 503; 202 {order_id, status: "accepted"}
    _ = uuid.uuid4
    raise HTTPException(status_code=501)


# uvicorn order_gateway:app --port 8443 --ssl-certfile cert.pem --ssl-keyfile key.pem
`,
      solution: `import asyncio
import uuid
from dataclasses import dataclass

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

app = FastAPI()

SIDES = {"BUY", "SELL"}
API_KEYS = {"k-1f9c": "desk-a", "k-77b2": "desk-b"}


@dataclass
class Order:
    order_id: str
    symbol: str
    side: str
    price: float
    qty: int
    client_order_id: str


class PublishFailed(Exception):
    """Raised by publish_order when Kafka does not acknowledge the order."""


def publish_order(order: Order) -> None:
    """Hand the order to the engine (built in the next step)."""
    raise NotImplementedError


@app.post("/orders")
async def place_order(request: Request) -> JSONResponse:
    if request.headers.get("x-api-key") not in API_KEYS:
        raise HTTPException(status_code=401, detail="missing or unknown API key")
    if request.headers.get("idempotency-key") is None:
        raise HTTPException(status_code=400, detail="Idempotency-Key header is required")
    try:
        body = await request.json()
    except ValueError:
        raise HTTPException(status_code=400, detail="body must be JSON")
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="body must be a JSON object")
    side, price, qty = body.get("side"), body.get("price", 0), body.get("qty", 0)
    if side not in SIDES or not isinstance(price, (int, float)) or price <= 0 or not isinstance(qty, int) or qty <= 0:
        raise HTTPException(status_code=400, detail="side must be BUY or SELL; price and qty must be positive")
    if not isinstance(body.get("symbol"), str) or not isinstance(body.get("client_order_id"), str):
        raise HTTPException(status_code=400, detail="symbol and client_order_id are required")
    order = Order(str(uuid.uuid4()), body["symbol"], side, float(price), qty, body["client_order_id"])
    try:
        await asyncio.to_thread(publish_order, order)  # blocks on the broker's ack: keep it off the event loop
    except PublishFailed:
        raise HTTPException(status_code=503, detail="order not accepted; retry with the same Idempotency-Key")
    return JSONResponse(status_code=202, content={"order_id": order.order_id, "status": "accepted"})


# uvicorn order_gateway:app --port 8443 --ssl-certfile cert.pem --ssl-keyfile key.pem
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"

	"github.com/google/uuid"
)

var (
	apiKeys = map[string]string{"k-1f9c": "desk-a", "k-77b2": "desk-b"}
	sides   = map[string]bool{"BUY": true, "SELL": true}
)

type Order struct {
	OrderID       string  \`json:"order_id"\`
	Symbol        string  \`json:"symbol"\`
	Side          string  \`json:"side"\`
	Price         float64 \`json:"price"\`
	Qty           int64   \`json:"qty"\`
	ClientOrderID string  \`json:"client_order_id"\`
}

// publishOrder hands the order to the engine (built in the next step); it returns an error when Kafka
// does not acknowledge the order.
func publishOrder(ctx context.Context, order Order) error {
	panic("not implemented")
}

func placeOrder(rw http.ResponseWriter, r *http.Request) {
	// TODO: 401 unless X-Api-Key is one of apiKeys (before reading the body)
	// TODO: 400 unless an Idempotency-Key header is present
	// TODO: decode the JSON body into an Order; 400 unless sides[order.Side], Price > 0, Qty > 0, Symbol and ClientOrderID set
	// TODO: OrderID = uuid.NewString(); publishOrder (error → 503); 202 {order_id, status: "accepted"}
	_ = json.NewDecoder
	_ = uuid.NewString
	http.Error(rw, "not implemented", http.StatusNotImplemented)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /orders", placeOrder)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"

	"github.com/google/uuid"
)

var (
	apiKeys = map[string]string{"k-1f9c": "desk-a", "k-77b2": "desk-b"}
	sides   = map[string]bool{"BUY": true, "SELL": true}
)

type Order struct {
	OrderID       string  \`json:"order_id"\`
	Symbol        string  \`json:"symbol"\`
	Side          string  \`json:"side"\`
	Price         float64 \`json:"price"\`
	Qty           int64   \`json:"qty"\`
	ClientOrderID string  \`json:"client_order_id"\`
}

// publishOrder hands the order to the engine (built in the next step); it returns an error when Kafka
// does not acknowledge the order.
func publishOrder(ctx context.Context, order Order) error {
	panic("not implemented")
}

func placeOrder(rw http.ResponseWriter, r *http.Request) {
	if _, ok := apiKeys[r.Header.Get("X-Api-Key")]; !ok {
		http.Error(rw, "missing or unknown API key", http.StatusUnauthorized)
		return
	}
	if r.Header.Get("Idempotency-Key") == "" {
		http.Error(rw, "Idempotency-Key header is required", http.StatusBadRequest)
		return
	}
	var order Order
	if err := json.NewDecoder(r.Body).Decode(&order); err != nil {
		http.Error(rw, "body must be JSON", http.StatusBadRequest)
		return
	}
	if !sides[order.Side] || order.Price <= 0 || order.Qty <= 0 || order.Symbol == "" || order.ClientOrderID == "" {
		http.Error(rw, "side must be BUY or SELL; price and qty must be positive", http.StatusBadRequest)
		return
	}
	order.OrderID = uuid.NewString()
	if err := publishOrder(r.Context(), order); err != nil {
		http.Error(rw, "order not accepted; retry with the same Idempotency-Key", http.StatusServiceUnavailable)
		return
	}
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(http.StatusAccepted)
	json.NewEncoder(rw).Encode(map[string]string{"order_id": order.OrderID, "status": "accepted"})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /orders", placeOrder)
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
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

object OrderGateway {
  val Sides = Set("BUY", "SELL")
  val ApiKeys = Map("k-1f9c" -> "desk-a", "k-77b2" -> "desk-b")

  final case class NewOrder(symbol: String, side: String, price: Double, qty: Long, client_order_id: String)
  final case class Order(orderId: String, symbol: String, side: String, price: Double, qty: Long, clientOrderId: String)
  implicit val newOrderFormat: RootJsonFormat[NewOrder] = jsonFormat5(NewOrder)

  /** Thrown by publishOrder when Kafka does not acknowledge the order. */
  final class PublishFailed(message: String) extends RuntimeException(message)

  /** Hand the order to the engine (built in the next step). */
  def publishOrder(order: Order): Unit = ???

  val route: Route =
    path("orders") {
      post {
        entity(as[NewOrder]) { in =>
          // TODO: 401 unless the X-Api-Key header is one of ApiKeys (optionalHeaderValueByName, before the entity)
          // TODO: 400 unless an Idempotency-Key header is present
          // TODO: 400 unless Sides contains in.side, in.price > 0, in.qty > 0, symbol non-empty
          // TODO: Order with a random UUID; publishOrder (PublishFailed → 503); 202 {order_id, status: "accepted"}
          val _ = UUID.randomUUID
          complete(StatusCodes.NotImplemented)
        }
      }
    }

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("gateway")
    // Tls (provided) builds an SSLContext from the PEM certificate and key.
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
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

object OrderGateway {
  val Sides = Set("BUY", "SELL")
  val ApiKeys = Map("k-1f9c" -> "desk-a", "k-77b2" -> "desk-b")

  final case class NewOrder(symbol: String, side: String, price: Double, qty: Long, client_order_id: String)
  final case class Order(orderId: String, symbol: String, side: String, price: Double, qty: Long, clientOrderId: String)
  implicit val newOrderFormat: RootJsonFormat[NewOrder] = jsonFormat5(NewOrder)

  /** Thrown by publishOrder when Kafka does not acknowledge the order. */
  final class PublishFailed(message: String) extends RuntimeException(message)

  /** Hand the order to the engine (built in the next step). */
  def publishOrder(order: Order): Unit = ???

  val route: Route =
    path("orders") {
      post {
        optionalHeaderValueByName("X-Api-Key") { apiKey =>
          optionalHeaderValueByName("Idempotency-Key") { idemKey =>
            if (!apiKey.exists(ApiKeys.contains)) complete(StatusCodes.Unauthorized -> "missing or unknown API key")
            else if (idemKey.isEmpty) complete(StatusCodes.BadRequest -> "Idempotency-Key header is required")
            else
              entity(as[NewOrder]) { in =>
                if (!Sides.contains(in.side) || in.price <= 0 || in.qty <= 0 || in.symbol.isEmpty || in.client_order_id.isEmpty)
                  complete(StatusCodes.BadRequest -> "side must be BUY or SELL; price and qty must be positive")
                else {
                  val order = Order(UUID.randomUUID().toString, in.symbol, in.side, in.price, in.qty, in.client_order_id)
                  try {
                    publishOrder(order)
                    complete(StatusCodes.Accepted -> Map("order_id" -> order.orderId, "status" -> "accepted"))
                  } catch {
                    case _: PublishFailed =>
                      complete(StatusCodes.ServiceUnavailable -> "order not accepted; retry with the same Idempotency-Key")
                  }
                }
              }
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("gateway")
    // Tls (provided) builds an SSLContext from the PEM certificate and key.
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
#include <set>
#include <stdexcept>
#include <string>

#include "ids.h"  // std::string new_uuid()

using json = nlohmann::json;

const std::set<std::string> kSides{"BUY", "SELL"};
const std::set<std::string> kApiKeys{"k-1f9c", "k-77b2"};

struct Order {
  std::string order_id, symbol, side, client_order_id;
  double price;
  long qty;
};

// Thrown by publish_order when Kafka does not acknowledge the order.
struct PublishFailed : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// Hands the order to the engine (built in the next step).
void publish_order(const Order& order);

void reply(httplib::Response& res, int status, const std::string& text) {
  res.status = status;
  res.set_content(text, "text/plain");
}

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Post("/orders", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: 401 unless X-Api-Key is one of kApiKeys (before parsing the body)
    // TODO: 400 unless an Idempotency-Key header is present
    // TODO: json::parse the body; 400 unless kSides has side, price > 0, qty > 0, symbol and client_order_id present
    // TODO: Order with new_uuid(); publish_order (PublishFailed → 503); 202 {order_id, status: "accepted"}
    reply(res, 501, "not implemented");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#define CPPHTTPLIB_OPENSSL_SUPPORT
#include <httplib.h>

#include <nlohmann/json.hpp>
#include <set>
#include <stdexcept>
#include <string>

#include "ids.h"  // std::string new_uuid()

using json = nlohmann::json;

const std::set<std::string> kSides{"BUY", "SELL"};
const std::set<std::string> kApiKeys{"k-1f9c", "k-77b2"};

struct Order {
  std::string order_id, symbol, side, client_order_id;
  double price;
  long qty;
};

// Thrown by publish_order when Kafka does not acknowledge the order.
struct PublishFailed : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// Hands the order to the engine (built in the next step).
void publish_order(const Order& order);

void reply(httplib::Response& res, int status, const std::string& text) {
  res.status = status;
  res.set_content(text, "text/plain");
}

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Post("/orders", [](const httplib::Request& req, httplib::Response& res) {
    if (!kApiKeys.count(req.get_header_value("X-Api-Key"))) return reply(res, 401, "missing or unknown API key");
    if (!req.has_header("Idempotency-Key")) return reply(res, 400, "Idempotency-Key header is required");
    const json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) return reply(res, 400, "body must be a JSON object");
    const std::string side = body.value("side", "");
    const double price = body.value("price", 0.0);
    const long qty = body.value("qty", 0L);
    if (!kSides.count(side) || price <= 0 || qty <= 0 || !body.contains("symbol") || !body.contains("client_order_id"))
      return reply(res, 400, "side must be BUY or SELL; price and qty must be positive");
    const Order order{new_uuid(), body["symbol"].get<std::string>(), side, body["client_order_id"].get<std::string>(), price, qty};
    try {
      publish_order(order);
    } catch (const PublishFailed&) {
      return reply(res, 503, "order not accepted; retry with the same Idempotency-Key");
    }
    res.status = 202;
    res.set_content(json{{"order_id", order.order_id}, {"status", "accepted"}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The handler is a funnel: cheap rejections first (headers), then the body, then the one expensive call. \`202\` is the honest status for an exchange — the request is durably accepted, the outcome (a fill, a rest on the book) arrives later on another channel — and it only becomes honest because the gateway waits for Kafka before sending it. Real gateways store the \`Idempotency-Key\` and replay the original response for a duplicate, run pre-trade risk checks (position limits, price bands) before accepting, and speak FIX with session sequence numbers that make idempotency a protocol property rather than a header.`,
};
