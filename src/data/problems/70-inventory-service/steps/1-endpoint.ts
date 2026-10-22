import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/reservations: quantity and sku that are checked',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, parses
the body and answers \`201\` with a reservation. It compiles, it serves the demo, and it hides three
production flaws. Review it like the service owner, fix it, and prove the fix with the checks below.

Implement \`POST /v1/reservations\` with body \`{"sku": "sku-123", "quantity": 2}\`.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing or empty tenant is **401**.
- \`Idempotency-Key\` is required (**400** when missing or empty) — it is a header, never a body field.
- \`sku\` must be a non-empty string (**400** otherwise) **and** must be a sku this tenant sells:
  the catalog lookup decides, and an unknown sku is **404** with no reservation created and no stock
  touched.
- \`quantity\` must be an integer from **1** to **MAX_ORDER_QUANTITY** (**1000**). \`0\`, a negative
  value, \`2.5\` and \`1000000\` are all **400** \`quantity out of range\`. The cap is per order, and a
  negative quantity is not "a small order" — it is how a caller *adds* stock while pretending to
  take some.
- Only once those guards have passed may the service call the stock collaborator
  (\`stock.reserve(sku, quantity)\`). Validation, the catalog lookup and the idempotency lookup all
  run **before** it: a rejected request must never move a counter.
- Idempotency is keyed by \`(tenant, Idempotency-Key)\`: the record
  \`{reservation_id, sku, quantity, status: "reserved", expires_at}\` is stored under that pair, and
  \`expires_at\` is \`now + RESERVATION_TTL_S\` (**900**) in epoch seconds. A replay of the key returns
  the **stored** record — same \`reservation_id\`, same \`expires_at\` — with **200**, and does not
  reserve a second time.
- A fresh reservation answers **201** with the reservation id, the sku, the quantity and \`expires_at\`.

**Failure mode the checks target.** The draft trusts the raw \`quantity\`, so a negative value
quietly *increases* stock and \`1e6\` walks past a cap that does not exist; it never looks the sku up,
so any string becomes a reservation; and it ignores \`Idempotency-Key\`, so a client retry after a
timeout holds the units twice and the shopper is charged for both. None of that shows up in a demo
that sends one well-formed request per key.`,
  sequence: {
    participants: ['Client', 'Inventory API', 'catalog', 'stock store', 'reservations'],
    messages: [
      {
        from: 'Client',
        to: 'Inventory API',
        label: 'POST /v1/reservations · X-Tenant-Id · Idempotency-Key',
        kind: 'sync',
      },
      {
        from: 'Inventory API',
        to: 'Inventory API',
        label: '401 tenant · 400 key/sku/quantity — before any hold',
        kind: 'sync',
      },
      {from: 'Inventory API', to: 'catalog', label: 'lookup(sku)', kind: 'sync'},
      {from: 'catalog', to: 'Inventory API', label: 'known / unknown', kind: 'reply'},
      {from: 'Inventory API', to: 'reservations', label: 'get(tenant, Idempotency-Key)', kind: 'sync'},
      {from: 'reservations', to: 'Inventory API', label: 'stored reservation / none', kind: 'reply'},
      {from: 'Inventory API', to: 'stock store', label: 'reserve(sku, quantity)', kind: 'sync'},
      {
        from: 'Inventory API',
        to: 'reservations',
        label: 'put(tenant, key, {reservation_id, expires_at})',
        kind: 'async',
      },
      {from: 'Inventory API', to: 'Client', label: '201 fresh · 200 replayed · 404 unknown sku', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/reservations',
      detail: 'Register the reservation route on `POST /v1/reservations`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/reservations["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/reservations['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/reservations"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"reservations"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/reservations"/]},
      },
    },
    {
      id: 'quantity-range',
      title: 'Quantity is an integer in 1..1000, rejected with 400 before the reserve',
      detail:
        '`MAX_ORDER_QUANTITY` is 1000 and the guard rejects a non-integer, `0`, a negative value and anything above the cap with **400** `quantity out of range` — and it sits above the stock call. The draft passes `body["quantity"]` straight through, so `-5` adds stock and `1e6` is never capped.',
      match: {
        python: {
          all: [/MAX_ORDER_QUANTITY/, /status_code\s*=\s*400/],
          order: [/quantity[^\n]{0,60}MAX_ORDER_QUANTITY/, /stock\.reserve\(/],
        },
        typescript: {
          all: [/MAX_ORDER_QUANTITY/, /code\(\s*400\s*\)/],
          order: [/quantity[^\n]{0,60}MAX_ORDER_QUANTITY/, /stock\.reserve\(/],
        },
        go: {
          all: [/maxOrderQuantity/, /StatusBadRequest/],
          order: [/[Qq]uantity[^\n]{0,60}maxOrderQuantity/, /stock\.Reserve\(/],
        },
        scala: {
          all: [/MaxOrderQuantity/, /StatusCodes\.BadRequest/],
          order: [/quantity[^\n]{0,60}MaxOrderQuantity/, /stock\.reserve\(/],
        },
        cpp: {
          all: [/kMaxOrderQuantity/, /\b400\b/],
          order: [/quantity[^\n]{0,60}kMaxOrderQuantity/, /stock\.reserve\(/],
        },
      },
    },
    {
      id: 'sku-unknown',
      title: 'Unknown sku is 404 and touches nothing',
      detail:
        'The catalog decides: a sku the tenant does not sell is **404** `unknown sku`, no reservation row is written and no stock moves — the lookup runs before the reserve call. The draft never looks the sku up, so `sku-nope` reserves happily.',
      match: {
        python: {
          all: [/catalog\.lookup\(/, /status_code\s*=\s*404/],
          order: [/catalog\.lookup\(/, /status_code\s*=\s*404/, /stock\.reserve\(/],
        },
        typescript: {
          all: [/catalog\.lookup\(/, /code\(\s*404\s*\)/],
          order: [/catalog\.lookup\(/, /code\(\s*404\s*\)/, /stock\.reserve\(/],
        },
        go: {
          all: [/catalog\.Lookup\(/, /StatusNotFound/],
          order: [/catalog\.Lookup\(/, /StatusNotFound/, /stock\.Reserve\(/],
        },
        scala: {
          all: [/catalog\.lookup\(/, /StatusCodes\.NotFound/],
          order: [/catalog\.lookup\(/, /StatusCodes\.NotFound/, /stock\.reserve\(/],
        },
        cpp: {all: [/catalog\.lookup\(/, /\b404\b/], order: [/catalog\.lookup\(/, /\b404\b/, /stock\.reserve\(/]},
      },
    },
    {
      id: 'idempotency',
      title: 'A replay returns the stored reservation under (tenant, key)',
      detail:
        'The record with `reservation_id` and `expires_at = now + RESERVATION_TTL_S` is stored under `(tenant, Idempotency-Key)`; a second request with the same key answers **200** with the stored record — the same reservation id and the same expiry — and never reaches the stock call again. The draft mints a new id and reserves again on every retry.',
      match: {
        python: {
          all: [/Idempotency-Key/, /reservations\.get\(/, /reservations\.put\(/, /RESERVATION_TTL_S/, /reservation_id/],
          order: [/reservations\.get\(/, /stock\.reserve\(/],
        },
        typescript: {
          all: [/idempotency-key/, /reservations\.get\(/, /reservations\.put\(/, /RESERVATION_TTL_S/, /reservation_id/],
          order: [/reservations\.get\(/, /stock\.reserve\(/],
        },
        go: {
          all: [/Idempotency-Key/, /reservations\.Get\(/, /reservations\.Put\(/, /reservationTTLS/, /reservation_id/],
          order: [/reservations\.Get\(/, /stock\.Reserve\(/],
        },
        scala: {
          all: [
            /Idempotency-Key/,
            /reservations\.get\(/,
            /reservations\.put\(/,
            /ReservationTtlSeconds/,
            /reservation_id/,
          ],
          order: [/reservations\.get\(/, /stock\.reserve\(/],
        },
        cpp: {
          all: [
            /Idempotency-Key/,
            /reservations\.get\(/,
            /reservations\.put\(/,
            /kReservationTtlSeconds/,
            /reservation_id/,
          ],
          order: [/reservations\.get\(/, /stock\.reserve\(/],
        },
      },
    },
    {
      id: 'no-decrement-on-reject',
      title: 'Every rejection precedes the stock mutation',
      detail:
        'The checks read the first `400`, the first `404` and the first stock call in order: a malformed request, an unknown sku or a replayed key is answered before `stock.reserve(...)` can touch a counter. Lifting the reserve above the guards — the draft does exactly that — fails this check even while the status codes look right, because a rejected request has already decremented.',
      match: {
        python: {order: [/status_code\s*=\s*400/, /status_code\s*=\s*404/, /stock\.reserve\(/]},
        typescript: {order: [/code\(\s*400\s*\)/, /code\(\s*404\s*\)/, /stock\.reserve\(/]},
        go: {order: [/StatusBadRequest/, /StatusNotFound/, /stock\.Reserve\(/]},
        scala: {order: [/StatusCodes\.BadRequest/, /StatusCodes\.NotFound/, /stock\.reserve\(/]},
        cpp: {order: [/\b400\b/, /\b404\b/, /stock\.reserve\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time
import uuid

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

app = FastAPI()


class StockStore:
    def reserve(self, sku: str, quantity: int) -> None:
        """Atomically take \`quantity\` units of \`sku\`; raise when fewer are left."""
        raise NotImplementedError


stock = StockStore()


@app.post("/v1/reservations")
async def create_reservation(request: Request) -> JSONResponse:
    # TODO: this draft hands the raw quantity to the store (so -5 adds stock and 1000000 skips the
    # 1000-unit cap), never looks the sku up, and ignores Idempotency-Key, so a retry reserves
    # twice. Review all four.
    tenant = request.headers.get("X-Tenant-Id")
    if not tenant:
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    body = await request.json()
    reservation = {
        "reservation_id": str(uuid.uuid4()),
        "sku": body["sku"],
        "quantity": body["quantity"],
        "status": "reserved",
        "expires_at": int(time.time()) + 900,
    }
    stock.reserve(body["sku"], body["quantity"])
    return JSONResponse(reservation, status_code=201)
`,
      solution: `import time
import uuid

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

app = FastAPI()

MAX_ORDER_QUANTITY = 1000
RESERVATION_TTL_S = 900


class Catalog:
    def lookup(self, sku: str) -> dict | None:
        """The catalog record for \`sku\` when this tenant sells it, else None."""
        raise NotImplementedError


class StockStore:
    def reserve(self, sku: str, quantity: int) -> None:
        """Atomically take \`quantity\` units of \`sku\`; raise when fewer are left."""
        raise NotImplementedError


class ReservationStore:
    def get(self, tenant: str, idem_key: str) -> dict | None:
        """The reservation stored for (tenant, idem_key), if any."""
        raise NotImplementedError

    def put(self, tenant: str, idem_key: str, reservation: dict) -> None:
        """Store \`reservation\` under (tenant, idem_key)."""
        raise NotImplementedError


catalog = Catalog()
stock = StockStore()
reservations = ReservationStore()


@app.post("/v1/reservations")
async def create_reservation(request: Request) -> JSONResponse:
    tenant = request.headers.get("X-Tenant-Id")
    if not tenant:
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    idem_key = request.headers.get("Idempotency-Key")
    if not idem_key:
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    try:
        body = await request.json()
    except ValueError:
        raise HTTPException(status_code=400, detail="body must be JSON")
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="body must be a JSON object")

    sku = body.get("sku")
    if not isinstance(sku, str) or sku == "":
        raise HTTPException(status_code=400, detail="sku must be a non-empty string")
    quantity = body.get("quantity")
    if not isinstance(quantity, int) or isinstance(quantity, bool) or not 1 <= quantity <= MAX_ORDER_QUANTITY:
        raise HTTPException(status_code=400, detail="quantity out of range")

    if catalog.lookup(sku) is None:
        raise HTTPException(status_code=404, detail="unknown sku")

    stored = reservations.get(tenant, idem_key)
    if stored is not None:
        return JSONResponse(stored, status_code=200)

    stock.reserve(sku, quantity)
    reservation = {
        "reservation_id": str(uuid.uuid4()),
        "sku": sku,
        "quantity": quantity,
        "status": "reserved",
        "expires_at": int(time.time()) + RESERVATION_TTL_S,
    }
    reservations.put(tenant, idem_key, reservation)
    return JSONResponse(reservation, status_code=201)
`,
    },
    typescript: {
      starter: `/** POST /v1/reservations: a model-generated draft that trusts the caller's quantity. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

export const app = Fastify();

interface Reservation {
  reservation_id: string;
  sku: string;
  quantity: number;
  status: string;
  expires_at: number;
}

interface StockStore {
  reserve(sku: string, quantity: number): void;
}

const stock: StockStore = {
  reserve() {
    throw new Error('not implemented');
  },
};

app.post('/v1/reservations', async (request, reply) => {
  // TODO: this draft hands the raw quantity to the store (so -5 adds stock and 1000000 skips the
  // 1000-unit cap), never looks the sku up, and ignores Idempotency-Key, so a retry reserves
  // twice. Review all four.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const body = request.body as {sku: string; quantity: number};
  const reservation: Reservation = {
    reservation_id: randomUUID(),
    sku: body.sku,
    quantity: body.quantity,
    status: 'reserved',
    expires_at: Math.floor(Date.now() / 1000) + 900,
  };
  stock.reserve(body.sku, body.quantity);
  return reply.code(201).send(reservation);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/reservations: validated, catalogued and idempotent stock reservations. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

export const app = Fastify();

const MAX_ORDER_QUANTITY = 1000;
const RESERVATION_TTL_S = 900;

interface Reservation {
  reservation_id: string;
  sku: string;
  quantity: number;
  status: string;
  expires_at: number;
}

interface Catalog {
  lookup(sku: string): {sku: string} | null;
}

interface StockStore {
  reserve(sku: string, quantity: number): void;
}

interface ReservationStore {
  get(tenant: string, idemKey: string): Reservation | null;
  put(tenant: string, idemKey: string, reservation: Reservation): void;
}

const catalog: Catalog = {
  lookup() {
    throw new Error('not implemented');
  },
};

const stock: StockStore = {
  reserve() {
    throw new Error('not implemented');
  },
};

const reservations: ReservationStore = {
  get() {
    throw new Error('not implemented');
  },
  put() {
    throw new Error('not implemented');
  },
};

app.post('/v1/reservations', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '')
    return reply.code(400).send({error: 'Idempotency-Key is required'});

  const body = request.body as {sku?: unknown; quantity?: unknown} | null;
  if (body === null || typeof body !== 'object' || typeof body.sku !== 'string' || body.sku === '')
    return reply.code(400).send({error: 'sku must be a non-empty string'});
  const quantity = body.quantity;
  if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_ORDER_QUANTITY)
    return reply.code(400).send({error: 'quantity out of range'});

  if (catalog.lookup(body.sku) === null) return reply.code(404).send({error: 'unknown sku'});

  const stored = reservations.get(tenant, idemKey);
  if (stored !== null) return reply.code(200).send(stored);

  stock.reserve(body.sku, quantity);
  const reservation: Reservation = {
    reservation_id: randomUUID(),
    sku: body.sku,
    quantity,
    status: 'reserved',
    expires_at: Math.floor(Date.now() / 1000) + RESERVATION_TTL_S,
  };
  reservations.put(tenant, idemKey, reservation);
  return reply.code(201).send(reservation);
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

	"github.com/google/uuid"
)

const holdSeconds = 900

type Reservation struct {
	ReservationID string \`json:"reservation_id"\`
	SKU           string \`json:"sku"\`
	Quantity      int    \`json:"quantity"\`
	Status        string \`json:"status"\`
	ExpiresAt     int64  \`json:"expires_at"\`
}

type StockStore struct{}

func (s *StockStore) Reserve(ctx context.Context, sku string, quantity int) error { return nil }

var stock = &StockStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

// TODO: this draft hands the raw quantity to the store (so -5 adds stock and 1000000 skips the
// 1000-unit cap), never looks the sku up, and ignores Idempotency-Key, so a retry reserves twice.
func createReservation(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	var body struct {
		SKU      string \`json:"sku"\`
		Quantity int    \`json:"quantity"\`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "body must be JSON"})
		return
	}
	reservation := Reservation{
		ReservationID: uuid.NewString(),
		SKU:           body.SKU,
		Quantity:      body.Quantity,
		Status:        "reserved",
		ExpiresAt:     time.Now().Unix() + holdSeconds,
	}
	stock.Reserve(r.Context(), body.SKU, body.Quantity)
	writeJSON(rw, http.StatusCreated, reservation)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/reservations", createReservation)
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

	"github.com/google/uuid"
)

const (
	maxOrderQuantity = 1000
	reservationTTLS  = 900
)

type Reservation struct {
	ReservationID string \`json:"reservation_id"\`
	SKU           string \`json:"sku"\`
	Quantity      int    \`json:"quantity"\`
	Status        string \`json:"status"\`
	ExpiresAt     int64  \`json:"expires_at"\`
}

type Catalog struct{}

func (c *Catalog) Lookup(ctx context.Context, sku string) (bool, error) { return false, nil }

type StockStore struct{}

func (s *StockStore) Reserve(ctx context.Context, sku string, quantity int) error { return nil }

type ReservationStore struct{}

func (s *ReservationStore) Get(ctx context.Context, tenant, idemKey string) (*Reservation, error) {
	return nil, nil
}

func (s *ReservationStore) Put(ctx context.Context, tenant, idemKey string, reservation *Reservation) error {
	return nil
}

var (
	catalog      = &Catalog{}
	stock        = &StockStore{}
	reservations = &ReservationStore{}
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func createReservation(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	idemKey := r.Header.Get("Idempotency-Key")
	if idemKey == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "Idempotency-Key is required"})
		return
	}
	var body struct {
		SKU      string \`json:"sku"\`
		Quantity *int   \`json:"quantity"\`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "body must be JSON"})
		return
	}
	if body.SKU == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "sku must be a non-empty string"})
		return
	}
	if body.Quantity == nil || *body.Quantity < 1 || *body.Quantity > maxOrderQuantity {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "quantity out of range"})
		return
	}

	known, err := catalog.Lookup(r.Context(), body.SKU)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if !known {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown sku"})
		return
	}

	stored, err := reservations.Get(r.Context(), tenant, idemKey)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if stored != nil {
		writeJSON(rw, http.StatusOK, stored)
		return
	}

	quantity := *body.Quantity
	if err := stock.Reserve(r.Context(), body.SKU, quantity); err != nil {
		writeJSON(rw, http.StatusConflict, map[string]string{"error": "insufficient stock"})
		return
	}
	reservation := &Reservation{
		ReservationID: uuid.NewString(),
		SKU:           body.SKU,
		Quantity:      quantity,
		Status:        "reserved",
		ExpiresAt:     time.Now().Unix() + reservationTTLS,
	}
	if err := reservations.Put(r.Context(), tenant, idemKey, reservation); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	writeJSON(rw, http.StatusCreated, reservation)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/reservations", createReservation)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import java.time.Instant
import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class ReserveRequest(sku: String, quantity: Int)
final case class Reservation(reservation_id: String, sku: String, quantity: Int, status: String, expires_at: Long)

trait StockStore {
  def reserve(sku: String, quantity: Int): Boolean
}

object stock extends StockStore {
  def reserve(sku: String, quantity: Int): Boolean = throw new UnsupportedOperationException("stock not wired")
}

object ReservationApi {
  implicit val system: ActorSystem = ActorSystem("inventory")
  implicit val reserveFormat: RootJsonFormat[ReserveRequest] = jsonFormat2(ReserveRequest)
  implicit val reservationFormat: RootJsonFormat[Reservation] = jsonFormat5(Reservation)

  // TODO: this draft hands the raw quantity to the store (so -5 adds stock and 1000000 skips the
  // 1000-unit cap), never looks the sku up, and ignores Idempotency-Key, so a retry reserves twice.
  val route: Route =
    path("v1" / "reservations") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          entity(as[ReserveRequest]) { body =>
            if (!tenantOpt.exists(_.nonEmpty)) {
              complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
            } else {
              stock.reserve(body.sku, body.quantity)
              val reservation =
                Reservation(UUID.randomUUID().toString, body.sku, body.quantity, "reserved", Instant.now.getEpochSecond + 900)
              complete(StatusCodes.Created, reservation)
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
      solution: `import java.time.Instant
import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class ReserveRequest(sku: String, quantity: Int)
final case class Reservation(reservation_id: String, sku: String, quantity: Int, status: String, expires_at: Long)

trait Catalog {
  def lookup(sku: String): Boolean
}

trait StockStore {
  def reserve(sku: String, quantity: Int): Boolean
}

trait ReservationStore {
  def get(tenant: String, idemKey: String): Option[Reservation]
  def put(tenant: String, idemKey: String, reservation: Reservation): Unit
}

object catalog extends Catalog {
  def lookup(sku: String): Boolean = throw new UnsupportedOperationException("catalog not wired")
}

object stock extends StockStore {
  def reserve(sku: String, quantity: Int): Boolean = throw new UnsupportedOperationException("stock not wired")
}

object reservations extends ReservationStore {
  def get(tenant: String, idemKey: String): Option[Reservation] =
    throw new UnsupportedOperationException("store not wired")
  def put(tenant: String, idemKey: String, reservation: Reservation): Unit =
    throw new UnsupportedOperationException("store not wired")
}

object ReservationApi {
  implicit val system: ActorSystem = ActorSystem("inventory")
  implicit val reserveFormat: RootJsonFormat[ReserveRequest] = jsonFormat2(ReserveRequest)
  implicit val reservationFormat: RootJsonFormat[Reservation] = jsonFormat5(Reservation)

  val MaxOrderQuantity = 1000
  val ReservationTtlSeconds = 900L

  val route: Route =
    path("v1" / "reservations") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          optionalHeaderValueByName("Idempotency-Key") { idemOpt =>
            entity(as[ReserveRequest]) { body =>
              if (!tenantOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
              } else if (!idemOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.BadRequest, """{"error":"Idempotency-Key is required"}""")
              } else if (body.sku.isEmpty) {
                complete(StatusCodes.BadRequest, """{"error":"sku must be a non-empty string"}""")
              } else if (body.quantity < 1 || body.quantity > MaxOrderQuantity) {
                complete(StatusCodes.BadRequest, """{"error":"quantity out of range"}""")
              } else if (!catalog.lookup(body.sku)) {
                complete(StatusCodes.NotFound, """{"error":"unknown sku"}""")
              } else {
                val tenant = tenantOpt.get
                val idemKey = idemOpt.get
                reservations.get(tenant, idemKey) match {
                  case Some(stored) =>
                    complete(StatusCodes.OK, stored)
                  case None =>
                    stock.reserve(body.sku, body.quantity)
                    val reservation = Reservation(
                      UUID.randomUUID().toString,
                      body.sku,
                      body.quantity,
                      "reserved",
                      Instant.now.getEpochSecond + ReservationTtlSeconds,
                    )
                    reservations.put(tenant, idemKey, reservation)
                    complete(StatusCodes.Created, reservation)
                }
              }
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

#include <chrono>
#include <string>

using json = nlohmann::json;

struct StockStore {
  bool reserve(const std::string& sku, int quantity);
};

StockStore stock;
std::string uuidString();

int main() {
  httplib::Server svr;

  svr.Post("/v1/reservations", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    // TODO: this draft hands the raw quantity to the store (so -5 adds stock and 1000000 skips the
    // 1000-unit cap), never looks the sku up, and ignores Idempotency-Key, so a retry reserves twice.
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"body must be JSON"})", "application/json");
      return;
    }
    const auto sku = body.value("sku", std::string());
    const int quantity = body.value("quantity", 0);
    stock.reserve(sku, quantity);
    const auto now = std::chrono::duration_cast<std::chrono::seconds>(
                         std::chrono::system_clock::now().time_since_epoch())
                         .count();
    res.status = 201;
    res.set_content(json{{"reservation_id", uuidString()},
                         {"sku", sku},
                         {"quantity", quantity},
                         {"status", "reserved"},
                         {"expires_at", now + 900}}
                        .dump(),
                    "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <optional>
#include <string>

using json = nlohmann::json;

constexpr int kMaxOrderQuantity = 1000;
constexpr int kReservationTtlSeconds = 900;

struct Catalog {
  bool lookup(const std::string& sku);
};

struct StockStore {
  bool reserve(const std::string& sku, int quantity);
};

struct ReservationStore {
  std::optional<json> get(const std::string& tenant, const std::string& idemKey);
  void put(const std::string& tenant, const std::string& idemKey, const json& reservation);
};

Catalog catalog;
StockStore stock;
ReservationStore reservations;
std::string uuidString();

int main() {
  httplib::Server svr;

  svr.Post("/v1/reservations", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto idemKey = req.get_header_value("Idempotency-Key");
    if (idemKey.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"Idempotency-Key is required"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("sku") || !body["sku"].is_string() ||
        body["sku"].get<std::string>().empty()) {
      res.status = 400;
      res.set_content(R"({"error":"sku must be a non-empty string"})", "application/json");
      return;
    }
    const auto sku = body["sku"].get<std::string>();
    if (!body.contains("quantity") || !body["quantity"].is_number_integer()) {
      res.status = 400;
      res.set_content(R"({"error":"quantity out of range"})", "application/json");
      return;
    }
    const int quantity = body["quantity"].get<int>();
    if (quantity < 1 || quantity > kMaxOrderQuantity) {
      res.status = 400;
      res.set_content(R"({"error":"quantity out of range"})", "application/json");
      return;
    }

    if (!catalog.lookup(sku)) {
      res.status = 404;
      res.set_content(R"({"error":"unknown sku"})", "application/json");
      return;
    }

    const auto stored = reservations.get(tenant, idemKey);
    if (stored) {
      res.status = 200;
      res.set_content(stored->dump(), "application/json");
      return;
    }

    if (!stock.reserve(sku, quantity)) {
      res.status = 409;
      res.set_content(R"({"error":"insufficient stock"})", "application/json");
      return;
    }
    const auto now = std::chrono::duration_cast<std::chrono::seconds>(
                         std::chrono::system_clock::now().time_since_epoch())
                         .count();
    const json reservation = {
        {"reservation_id", uuidString()},
        {"sku", sku},
        {"quantity", quantity},
        {"status", "reserved"},
        {"expires_at", now + kReservationTtlSeconds},
    };
    reservations.put(tenant, idemKey, reservation);
    res.status = 201;
    res.set_content(reservation.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'The cheapest guard is the quantity: one comparison against `MAX_ORDER_QUANTITY` (1000) that rejects a non-integer, `0`, a negative value and anything above the cap with **400** `quantity out of range`. The draft never compares — it hands `body["quantity"]` to the store, so a negative quantity *adds* stock while looking like a reservation.',
    'The 404 gate is a catalog lookup before anything that mutates stock: `catalog.lookup(sku)` returns nothing for a sku this tenant does not sell, and the handler answers **404** `unknown sku` without writing a reservation or moving a counter.',
    'Idempotency is a lookup keyed by `(tenant, Idempotency-Key)` placed *before* the reserve call: on a hit return the stored record with **200** so the retry carries the original `reservation_id` and `expires_at`; on a miss reserve once, store `expires_at = now + RESERVATION_TTL_S` (900) under the same pair, and answer **201**.',
  ],
  debrief: `The interviewer is reviewing a generated handler against the two failure modes that cost real money: a value that is believed before it is checked, and a request that is executed twice. The draft is plausible because the demo sends \`{"sku": "sku-123", "quantity": 2}\` once, from one tenant, with one key — under that traffic there is nothing to notice. The defects only appear at the edges: a negative quantity turns the reserve into a credit and inflates the shelf count, a quantity of a million bypasses a cap that was never written, an unknown sku becomes a reservation for something nobody sells, and a client retry after a timeout holds the same units a second time. The ordering matters as much as the guards: validation, catalog and idempotency all run *before* the stock call, so a rejected request can never have moved a counter — which is why the checks read the first \`400\`, the first \`404\` and the first reserve call in order rather than just grepping for their presence. Real services add a per-tenant rate limit on the reservation path, a request fingerprint so a replayed key with a *different* body is a \`409\` instead of a silent replay, and a background sweep that releases holds whose \`expires_at\` has passed.`,
};
