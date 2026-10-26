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
        typescript: {all: [/x-api-key/i, /code\(\s*401\s*\)|status\(\s*401\s*\)|statusCode:\s*401|unauthorized\(/]},
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
        typescript: {all: [/idempotency-key/i, /code\(\s*400\s*\)|status\(\s*400\s*\)|statusCode:\s*400|badRequest\(/]},
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
        typescript: {
          all: [
            /SIDES\.includes\(/,
            /price\s*(<=\s*0|>\s*0)/,
            /qty\s*(<=\s*0|>\s*0)/,
            /code\(\s*400\s*\)|status\(\s*400\s*\)|statusCode:\s*400|badRequest\(/,
          ],
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
        typescript: {
          order: [/publisher\.publishOrder\(/, /code\(\s*202\s*\)|status\(\s*202\s*\)|statusCode:\s*202/],
          all: [/['"]accepted['"]/],
        },
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
        typescript: {
          all: [
            /instanceof PublishFailed/,
            /code\(\s*503\s*\)|status\(\s*503\s*\)|statusCode:\s*503|serviceUnavailable\(/,
          ],
        },
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
    typescript: {
      starter: `import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';

export const app = Fastify();

export const SIDES = ['BUY', 'SELL'];
export const API_KEYS: Record<string, string> = {'k-1f9c': 'desk-a', 'k-77b2': 'desk-b'};

export interface Order {
  order_id: string;
  symbol: string;
  side: string;
  price: number;
  qty: number;
  client_order_id: string;
}

/** Thrown by publisher.publishOrder when Kafka does not acknowledge the order. */
export class PublishFailed extends Error {}

/** Hands the order to the engine (built in the next step); provided. */
export const publisher = {
  async publishOrder(order: Order): Promise<void> {
    throw new Error('not implemented');
  },
};

app.post('/orders', async (request, reply) => {
  // TODO: 401 unless X-Api-Key is one of API_KEYS — in an onRequest hook, before the body is parsed
  // TODO: 400 unless an Idempotency-Key header is present
  // TODO: request.body is the parsed JSON; 400 unless side in SIDES, price > 0, qty > 0, symbol and client_order_id present
  // TODO: Order with a randomUUID() order_id; await publisher.publishOrder(order) — it waits for the broker's ack
  // TODO: PublishFailed → 503; 202 {order_id, status: 'accepted'}
  void randomUUID;
  return reply.code(501).send();
});

// app.listen({port: 8443, https: {cert, key}})
`,
      solution: `import {randomUUID} from 'node:crypto';
import Fastify, {type FastifyReply, type FastifyRequest} from 'fastify';

export const app = Fastify();

export const SIDES = ['BUY', 'SELL'];
export const API_KEYS: Record<string, string> = {'k-1f9c': 'desk-a', 'k-77b2': 'desk-b'};

export interface Order {
  order_id: string;
  symbol: string;
  side: string;
  price: number;
  qty: number;
  client_order_id: string;
}

/** Thrown by publisher.publishOrder when Kafka does not acknowledge the order. */
export class PublishFailed extends Error {}

/** Hands the order to the engine (built in the next step); provided. */
export const publisher = {
  async publishOrder(order: Order): Promise<void> {
    throw new Error('not implemented');
  },
};

/** Header checks run as an onRequest hook: the body is not even parsed for a rejected request. */
async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const key = request.headers['x-api-key'];
  if (typeof key !== 'string' || !(key in API_KEYS)) {
    await reply.code(401).send({error: 'missing or unknown API key'});
    return;
  }
  if (request.headers['idempotency-key'] === undefined) {
    await reply.code(400).send({error: 'Idempotency-Key header is required'});
  }
}

app.post('/orders', {onRequest: authenticate}, async (request, reply) => {
  const body = request.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return reply.code(400).send({error: 'body must be a JSON object'});
  }
  const {symbol, side, price, qty, client_order_id} = body as Record<string, unknown>;
  if (typeof side !== 'string' || !SIDES.includes(side) || typeof price !== 'number' || price <= 0 || typeof qty !== 'number' || !Number.isInteger(qty) || qty <= 0) {
    return reply.code(400).send({error: 'side must be BUY or SELL; price and qty must be positive'});
  }
  if (typeof symbol !== 'string' || typeof client_order_id !== 'string') {
    return reply.code(400).send({error: 'symbol and client_order_id are required'});
  }
  const order: Order = {order_id: randomUUID(), symbol, side, price, qty, client_order_id};
  try {
    await publisher.publishOrder(order); // resolves only once the broker acknowledged the order
  } catch (e) {
    if (e instanceof PublishFailed) {
      return reply.code(503).send({error: 'order not accepted; retry with the same Idempotency-Key'});
    }
    throw e;
  }
  return reply.code(202).send({order_id: order.order_id, status: 'accepted'});
});

// app.listen({port: 8443, https: {cert, key}})
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
var publishOrder = func(ctx context.Context, order Order) error {
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
var publishOrder = func(ctx context.Context, order Order) error {
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
  harness: {
    python: `HEADERS = {"X-Api-Key": "k-1f9c", "Idempotency-Key": "idem-1"}
ORDER = {"symbol": "ACME", "side": "BUY", "price": 10.05, "qty": 100, "client_order_id": "c-1"}


def _gateway(ctx, fail=False):
    """The module with publish_order replaced by a recorder (the real one is built in step 2)."""
    m = ctx.load("order_gateway")
    published = []

    def publish_order(order):
        if fail:
            raise m.PublishFailed("broker did not acknowledge")
        published.append(order)

    m.publish_order = publish_order
    return m, published


async def check_auth(ctx):
    m, published = _gateway(ctx)
    async with ctx.client(m.app) as c:
        r = await c.post("/orders", json=ORDER, headers={"Idempotency-Key": "idem-1"})
        assert r.status_code == 401, f"no X-Api-Key answered {r.status_code}, expected 401"
        r = await c.post("/orders", json=ORDER, headers={"X-Api-Key": "nope", "Idempotency-Key": "idem-1"})
        assert r.status_code == 401, f"an unknown X-Api-Key answered {r.status_code}, expected 401"
        r = await c.post("/orders", content=b"not json", headers={"Content-Type": "application/json"})
        assert r.status_code == 401, f"a request without a key and with a broken body answered {r.status_code}: the key must be checked before the body is read"
        assert published == [], "rejected requests must not reach publish_order"
        r = await c.post("/orders", json=ORDER, headers=HEADERS)
        assert r.status_code != 401, "a known X-Api-Key must be accepted, got 401"


async def check_idempotency_key(ctx):
    m, published = _gateway(ctx)
    async with ctx.client(m.app) as c:
        r = await c.post("/orders", json=ORDER, headers={"X-Api-Key": "k-1f9c"})
        assert r.status_code == 400, f"a request without Idempotency-Key answered {r.status_code}, expected 400"
        assert published == [], "a request without Idempotency-Key must not be published"
        r = await c.post("/orders", json=ORDER, headers=HEADERS)
        assert r.status_code != 400, "a request with Idempotency-Key and a valid body answered 400"


async def check_validate(ctx):
    m, published = _gateway(ctx)
    bad = [
        ("side", dict(ORDER, side="HOLD")),
        ("price 0", dict(ORDER, price=0)),
        ("negative price", dict(ORDER, price=-1)),
        ("qty 0", dict(ORDER, qty=0)),
        ("missing symbol", {k: v for k, v in ORDER.items() if k != "symbol"}),
        ("missing client_order_id", {k: v for k, v in ORDER.items() if k != "client_order_id"}),
    ]
    async with ctx.client(m.app) as c:
        for label, body in bad:
            r = await c.post("/orders", json=body, headers=HEADERS)
            assert r.status_code == 400, f"an order with a bad {label} answered {r.status_code}, expected 400"
        assert published == [], "invalid orders must never reach publish_order"
        r = await c.post("/orders", json=ORDER, headers=HEADERS)
        assert r.status_code != 400, "a valid order (side BUY, price 10.05, qty 100) was rejected with 400"
        assert len(published) == 1, f"the valid order must reach publish_order; it was called {len(published)} times"


async def check_accepted(ctx):
    m, published = _gateway(ctx)
    async with ctx.client(m.app) as c:
        r = await c.post("/orders", json=ORDER, headers=HEADERS)
    assert r.status_code == 202, f"a valid order answered {r.status_code}, expected 202"
    body = r.json()
    assert body.get("status") == "accepted", f"the 202 body must say status accepted, got {body}"
    assert len(published) == 1, f"publish_order must be called exactly once, was called {len(published)} times"
    order = published[0]
    assert isinstance(order, m.Order), f"publish_order must receive an Order, got {type(order).__name__}"
    assert (order.symbol, order.side, order.price, order.qty, order.client_order_id) == ("ACME", "BUY", 10.05, 100, "c-1"), f"the published Order does not carry the request's fields: {order}"
    assert order.order_id and body.get("order_id") == order.order_id, f"the 202 must return the published order_id {order.order_id!r}, got {body.get('order_id')!r}"
    async with ctx.client(m.app) as c:
        r2 = await c.post("/orders", json=ORDER, headers=HEADERS)
    assert r2.json().get("order_id") != body["order_id"], "every order needs a fresh order_id"


async def check_unavailable(ctx):
    m, published = _gateway(ctx, fail=True)
    async with ctx.client(m.app) as c:
        r = await c.post("/orders", json=ORDER, headers=HEADERS)
    assert r.status_code == 503, f"PublishFailed answered {r.status_code}, expected 503"
`,
    typescript: `const HEADERS = {'X-Api-Key': 'k-1f9c', 'Idempotency-Key': 'idem-1'};
const ORDER = {symbol: 'ACME', side: 'BUY', price: 10.05, qty: 100, client_order_id: 'c-1'};

/** The module with publisher.publishOrder replaced by a recorder (the real one is built in step 2). */
function gateway(ctx, fail = false) {
  const m = ctx.load('order_gateway');
  const published: Record<string, unknown>[] = [];
  m.publisher.publishOrder = async (order: Record<string, unknown>) => {
    if (fail) throw new m.PublishFailed('broker did not acknowledge');
    published.push(order);
  };
  return {m, published};
}

export async function check_auth(ctx) {
  const {m, published} = gateway(ctx);
  const c = ctx.client(m.app);
  let r = await c.post('/orders', {json: ORDER, headers: {'Idempotency-Key': 'idem-1'}});
  assert.equal(r.status, 401, \`no X-Api-Key answered \${r.status}, expected 401\`);
  r = await c.post('/orders', {json: ORDER, headers: {'X-Api-Key': 'nope', 'Idempotency-Key': 'idem-1'}});
  assert.equal(r.status, 401, \`an unknown X-Api-Key answered \${r.status}, expected 401\`);
  r = await c.post('/orders', {body: 'not json', headers: {'Content-Type': 'application/json'}});
  assert.equal(r.status, 401, \`a request without a key and with a broken body answered \${r.status}: the key must be checked before the body is read\`);
  assert.deepEqual(published, [], 'rejected requests must not reach publisher.publishOrder');
  r = await c.post('/orders', {json: ORDER, headers: HEADERS});
  assert.notEqual(r.status, 401, 'a known X-Api-Key must be accepted, got 401');
}

export async function check_idempotency_key(ctx) {
  const {m, published} = gateway(ctx);
  const c = ctx.client(m.app);
  let r = await c.post('/orders', {json: ORDER, headers: {'X-Api-Key': 'k-1f9c'}});
  assert.equal(r.status, 400, \`a request without Idempotency-Key answered \${r.status}, expected 400\`);
  assert.deepEqual(published, [], 'a request without Idempotency-Key must not be published');
  r = await c.post('/orders', {json: ORDER, headers: HEADERS});
  assert.notEqual(r.status, 400, 'a request with Idempotency-Key and a valid body answered 400');
}

export async function check_validate(ctx) {
  const {m, published} = gateway(ctx);
  const {symbol: _symbol, ...noSymbol} = ORDER;
  const {client_order_id: _cid, ...noClientOrderId} = ORDER;
  const bad: [string, Record<string, unknown>][] = [
    ['side', {...ORDER, side: 'HOLD'}],
    ['price 0', {...ORDER, price: 0}],
    ['negative price', {...ORDER, price: -1}],
    ['qty 0', {...ORDER, qty: 0}],
    ['missing symbol', noSymbol],
    ['missing client_order_id', noClientOrderId],
  ];
  const c = ctx.client(m.app);
  for (const [label, body] of bad) {
    const r = await c.post('/orders', {json: body, headers: HEADERS});
    assert.equal(r.status, 400, \`an order with a bad \${label} answered \${r.status}, expected 400\`);
  }
  assert.deepEqual(published, [], 'invalid orders must never reach publisher.publishOrder');
  const r = await c.post('/orders', {json: ORDER, headers: HEADERS});
  assert.notEqual(r.status, 400, 'a valid order (side BUY, price 10.05, qty 100) was rejected with 400');
  assert.equal(published.length, 1, \`the valid order must reach publisher.publishOrder; it was called \${published.length} times\`);
}

export async function check_accepted(ctx) {
  const {m, published} = gateway(ctx);
  const c = ctx.client(m.app);
  const r = await c.post('/orders', {json: ORDER, headers: HEADERS});
  assert.equal(r.status, 202, \`a valid order answered \${r.status}, expected 202\`);
  const body = r.json() as Record<string, unknown>;
  assert.equal(body.status, 'accepted', \`the 202 body must say status accepted, got \${JSON.stringify(body)}\`);
  assert.equal(published.length, 1, \`publisher.publishOrder must be called exactly once, was called \${published.length} times\`);
  const order = published[0];
  assert(typeof order === 'object' && order !== null, \`publisher.publishOrder must receive an Order, got \${typeof order}\`);
  assert.deepEqual(
    [order.symbol, order.side, order.price, order.qty, order.client_order_id],
    ['ACME', 'BUY', 10.05, 100, 'c-1'],
    \`the published Order does not carry the request's fields: \${JSON.stringify(order)}\`,
  );
  assert(typeof order.order_id === 'string' && order.order_id !== '' && body.order_id === order.order_id, \`the 202 must return the published order_id \${JSON.stringify(order.order_id)}, got \${JSON.stringify(body.order_id)}\`);
  const r2 = await c.post('/orders', {json: ORDER, headers: HEADERS});
  assert.notEqual((r2.json() as Record<string, unknown>).order_id, body.order_id, 'every order needs a fresh order_id');
}

export async function check_unavailable(ctx) {
  const {m} = gateway(ctx, true);
  const r = await ctx.client(m.app).post('/orders', {json: ORDER, headers: HEADERS});
  assert.equal(r.status, 503, \`PublishFailed answered \${r.status}, expected 503\`);
}
`,
    go: `package main

import (
	"context"
	"errors"

	"leetbuild/harness"
)

var gatewayHeaders = []string{"X-Api-Key", "k-1f9c", "Idempotency-Key", "idem-1"}

func gatewayOrder() map[string]any {
	return map[string]any{"symbol": "ACME", "side": "BUY", "price": 10.05, "qty": 100, "client_order_id": "c-1"}
}

// gatewayUnderTest runs the learner's server with publishOrder replaced by a recorder (the real one is
// built in step 2); fail makes it return the error Kafka's missing acknowledgement would.
func gatewayUnderTest(ctx *harness.Ctx, fail bool) (*harness.HTTP, *[]Order) {
	published := &[]Order{}
	publishOrder = func(_ context.Context, order Order) error {
		if fail {
			return errors.New("broker did not acknowledge")
		}
		*published = append(*published, order)
		return nil
	}
	return ctx.Main(main).HTTP(), published
}

func CheckAuth(ctx *harness.Ctx) {
	c, published := gatewayUnderTest(ctx, false)
	r := c.Post("/orders", gatewayOrder(), "Idempotency-Key", "idem-1")
	ctx.Equal(r.Status, 401, "no X-Api-Key")
	r = c.Post("/orders", gatewayOrder(), "X-Api-Key", "nope", "Idempotency-Key", "idem-1")
	ctx.Equal(r.Status, 401, "an unknown X-Api-Key")
	r = c.Post("/orders", "not json", "Content-Type", "application/json")
	ctx.Equal(r.Status, 401, "a request without a key and with a broken body: the key must be checked before the body is read")
	ctx.Equal(len(*published), 0, "rejected requests must not reach publishOrder; calls")
	r = c.Post("/orders", gatewayOrder(), gatewayHeaders...)
	ctx.Assert(r.Status != 401, "a known X-Api-Key must be accepted, got 401")
}

func CheckIdempotencyKey(ctx *harness.Ctx) {
	c, published := gatewayUnderTest(ctx, false)
	r := c.Post("/orders", gatewayOrder(), "X-Api-Key", "k-1f9c")
	ctx.Equal(r.Status, 400, "a request without Idempotency-Key")
	ctx.Equal(len(*published), 0, "a request without Idempotency-Key must not be published; calls")
	r = c.Post("/orders", gatewayOrder(), gatewayHeaders...)
	ctx.Assert(r.Status != 400, "a request with Idempotency-Key and a valid body answered 400")
}

func CheckValidate(ctx *harness.Ctx) {
	c, published := gatewayUnderTest(ctx, false)
	with := func(key string, value any) map[string]any {
		body := gatewayOrder()
		body[key] = value
		return body
	}
	without := func(key string) map[string]any {
		body := gatewayOrder()
		delete(body, key)
		return body
	}
	bad := []struct {
		label string
		body  map[string]any
	}{
		{"side", with("side", "HOLD")},
		{"price 0", with("price", 0)},
		{"negative price", with("price", -1)},
		{"qty 0", with("qty", 0)},
		{"missing symbol", without("symbol")},
		{"missing client_order_id", without("client_order_id")},
	}
	for _, b := range bad {
		r := c.Post("/orders", b.body, gatewayHeaders...)
		ctx.Equal(r.Status, 400, "an order with a bad %s", b.label)
	}
	ctx.Equal(len(*published), 0, "invalid orders must never reach publishOrder; calls")
	r := c.Post("/orders", gatewayOrder(), gatewayHeaders...)
	ctx.Assert(r.Status != 400, "a valid order (side BUY, price 10.05, qty 100) was rejected with 400")
	ctx.Equal(len(*published), 1, "the valid order must reach publishOrder; calls")
}

func CheckAccepted(ctx *harness.Ctx) {
	c, published := gatewayUnderTest(ctx, false)
	r := c.Post("/orders", gatewayOrder(), gatewayHeaders...)
	ctx.Equal(r.Status, 202, "a valid order")
	var body map[string]any
	r.Decode(&body)
	ctx.Equal(body["status"], "accepted", "the 202 body must say status accepted, body %v; status", body)
	ctx.Equal(len(*published), 1, "publishOrder must be called exactly once; calls")
	order := (*published)[0]
	ctx.Equal([]any{order.Symbol, order.Side, order.Price, order.Qty, order.ClientOrderID}, []any{"ACME", "BUY", 10.05, int64(100), "c-1"}, "the published Order does not carry the request's fields")
	ctx.Assert(order.OrderID != "" && body["order_id"] == order.OrderID, "the 202 must return the published OrderID %q, got %v", order.OrderID, body["order_id"])
	var second map[string]any
	c.Post("/orders", gatewayOrder(), gatewayHeaders...).Decode(&second)
	ctx.Assert(second["order_id"] != body["order_id"], "every order needs a fresh OrderID")
}

func CheckUnavailable(ctx *harness.Ctx) {
	c, _ := gatewayUnderTest(ctx, true)
	r := c.Post("/orders", gatewayOrder(), gatewayHeaders...)
	ctx.Equal(r.Status, 503, "publishOrder returned an error")
}
`,
    cpp: `#include <leetbuild/harness.h>
#include <nlohmann/json.hpp>

#include <string>
#include <tuple>
#include <utility>
#include <vector>

namespace {

nlohmann::json gatewayOrder() {
  return {{"symbol", "ACME"}, {"side", "BUY"}, {"price", 10.05}, {"qty", 100}, {"client_order_id", "c-1"}};
}

// What publish_order's stand-in below (the real one is built in step 2) recorded, and whether it
// throws the PublishFailed Kafka's missing acknowledgement would.
std::vector<Order> gatewayPublished;
bool gatewayFail = false;

// gatewayUnderTest runs the learner's server with publish_order replaced by the recorder.
harness::HTTP gatewayUnderTest(harness::Ctx& ctx, bool fail) {
  gatewayPublished.clear();
  gatewayFail = fail;
  return ctx.Main().HTTP();
}

// The Go harness's c.Post("/orders", body, gatewayHeaders...): the body as JSON, with both keys.
harness::Response postOrder(harness::HTTP& c, const nlohmann::json& body) {
  return c.Post("/orders", body.dump(), "Content-Type", "application/json", "X-Api-Key", "k-1f9c", "Idempotency-Key", "idem-1");
}

// The response body decoded the way encoding/json decodes into map[string]any (nil when not JSON).
harness::Any decode(const harness::Response& r) { return harness::ParseJSON(r.Text()).value_or(harness::Any()); }

}  // namespace

void publish_order(const Order& order) {
  if (gatewayFail) throw PublishFailed("broker did not acknowledge");
  gatewayPublished.push_back(order);
}

void CheckAuth(harness::Ctx& ctx) {
  auto c = gatewayUnderTest(ctx, false);
  auto r = c.Post("/orders", gatewayOrder().dump(), "Content-Type", "application/json", "Idempotency-Key", "idem-1");
  ctx.Equal(r.Status, 401, "no X-Api-Key");
  r = c.Post("/orders", gatewayOrder().dump(), "Content-Type", "application/json", "X-Api-Key", "nope", "Idempotency-Key", "idem-1");
  ctx.Equal(r.Status, 401, "an unknown X-Api-Key");
  r = c.Post("/orders", "not json", "Content-Type", "application/json");
  ctx.Equal(r.Status, 401, "a request without a key and with a broken body: the key must be checked before the body is read");
  ctx.Equal(gatewayPublished.size(), 0, "rejected requests must not reach publish_order; calls");
  r = postOrder(c, gatewayOrder());
  ctx.Assert(r.Status != 401, "a known X-Api-Key must be accepted, got 401");
}

void CheckIdempotencyKey(harness::Ctx& ctx) {
  auto c = gatewayUnderTest(ctx, false);
  auto r = c.Post("/orders", gatewayOrder().dump(), "Content-Type", "application/json", "X-Api-Key", "k-1f9c");
  ctx.Equal(r.Status, 400, "a request without Idempotency-Key");
  ctx.Equal(gatewayPublished.size(), 0, "a request without Idempotency-Key must not be published; calls");
  r = postOrder(c, gatewayOrder());
  ctx.Assert(r.Status != 400, "a request with Idempotency-Key and a valid body answered 400");
}

void CheckValidate(harness::Ctx& ctx) {
  auto c = gatewayUnderTest(ctx, false);
  const auto with = [](const std::string& key, const nlohmann::json& value) {
    auto body = gatewayOrder();
    body[key] = value;
    return body;
  };
  const auto without = [](const std::string& key) {
    auto body = gatewayOrder();
    body.erase(key);
    return body;
  };
  const std::vector<std::pair<std::string, nlohmann::json>> bad = {
      {"side", with("side", "HOLD")},
      {"price 0", with("price", 0)},
      {"negative price", with("price", -1)},
      {"qty 0", with("qty", 0)},
      {"missing symbol", without("symbol")},
      {"missing client_order_id", without("client_order_id")},
  };
  for (const auto& [label, body] : bad) {
    const auto r = postOrder(c, body);
    ctx.Equal(r.Status, 400, "an order with a bad %s", label);
  }
  ctx.Equal(gatewayPublished.size(), 0, "invalid orders must never reach publish_order; calls");
  const auto r = postOrder(c, gatewayOrder());
  ctx.Assert(r.Status != 400, "a valid order (side BUY, price 10.05, qty 100) was rejected with 400");
  ctx.Equal(gatewayPublished.size(), 1, "the valid order must reach publish_order; calls");
}

void CheckAccepted(harness::Ctx& ctx) {
  auto c = gatewayUnderTest(ctx, false);
  const auto r = postOrder(c, gatewayOrder());
  ctx.Equal(r.Status, 202, "a valid order");
  const harness::Any body = decode(r);
  ctx.Equal(body["status"], "accepted", "the 202 body must say status accepted, body %v; status", body);
  ctx.Equal(gatewayPublished.size(), 1, "publish_order must be called exactly once; calls");
  const Order order = gatewayPublished[0];
  ctx.Equal(std::make_tuple(order.symbol, order.side, order.price, order.qty, order.client_order_id),
            std::make_tuple("ACME", "BUY", 10.05, 100, "c-1"), "the published Order does not carry the request's fields");
  ctx.Assert(!order.order_id.empty() && body["order_id"] == order.order_id,
             "the 202 must return the published order_id %q, got %v", order.order_id, body["order_id"]);
  const harness::Any second = decode(postOrder(c, gatewayOrder()));
  ctx.Assert(!(second["order_id"] == body["order_id"]), "every order needs a fresh order_id");
}

void CheckUnavailable(harness::Ctx& ctx) {
  auto c = gatewayUnderTest(ctx, true);
  const auto r = postOrder(c, gatewayOrder());
  ctx.Equal(r.Status, 503, "publish_order threw PublishFailed");
}
`,
  },
  debrief: `The handler is a funnel: cheap rejections first (headers), then the body, then the one expensive call. \`202\` is the honest status for an exchange — the request is durably accepted, the outcome (a fill, a rest on the book) arrives later on another channel — and it only becomes honest because the gateway waits for Kafka before sending it. Real gateways store the \`Idempotency-Key\` and replay the original response for a duplicate, run pre-trade risk checks (position limits, price bands) before accepting, and speak FIX with session sequence numbers that make idempotency a protocol property rather than a header.`,
};
