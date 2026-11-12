import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/reservations: a quantity, a sku and a key that are checked',
  concept: 'http',
  guides: ['request-boundaries', 'idempotent-requests'],
  file: 'api',
  focus: ['client', 'api', 'db'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/reservations\` with \`X-Tenant-Id\`, \`Idempotency-Key\`
and a body \`{"sku": "sku-1", "quantity": 2}\`: it calls \`stock.reserve\` with a new reservation id,
answers 409 when the units are not there, and otherwise stores the reservation (\`store.put\`) and
answers 201 with it. It serves the demo and hides three flaws.

**Failure mode the checks target.** A quantity of -3 that adds three units to the counter, a tenant
reserving another tenant's sku, and a client that times out and retries, holding the units twice.

- \`MAX_ORDER_QUANTITY = 1000\`: a quantity that is not an integer from 1 to 1000 is **400**, before
  any stock moves.
- \`catalog.owner(sku)\` must be the caller's tenant; anything else, an unknown sku included, is
  **404** and touches nothing.
- A missing \`Idempotency-Key\` is **400**. Look \`(tenant, key)\` up with \`store.get_by_key\` before
  reserving, and answer a replay with the stored reservation and **200**.`,
  sequence: {
    participants: ['Storefront', 'Inventory API', 'Reservation store', 'Redis'],
    messages: [
      {
        from: 'Storefront',
        to: 'Inventory API',
        label: 'POST /v1/reservations · Idempotency-Key · {sku, quantity}',
        kind: 'sync',
      },
      {from: 'Inventory API', to: 'Inventory API', label: 'quantity outside 1..1000 → 400', kind: 'sync'},
      {from: 'Inventory API', to: 'Reservation store', label: 'get_by_key(tenant, key) → replay: 200', kind: 'sync'},
      {from: 'Inventory API', to: 'Inventory API', label: 'catalog.owner(sku) ≠ tenant → 404', kind: 'sync'},
      {from: 'Inventory API', to: 'Redis', label: 'stock.reserve(sku, quantity, id) → false: 409', kind: 'sync'},
      {from: 'Inventory API', to: 'Reservation store', label: 'put(reservation)', kind: 'sync'},
      {
        from: 'Inventory API',
        to: 'Storefront',
        label: '201 {reservation_id, status: "reserved", expires_at}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Reserves through POST /v1/reservations',
      detail:
        'A reservation of 3 units answers 201 with the reservation, takes 3 units off `stock:{sku}` and stores the record.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/reservations["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/reservations['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/reservations"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"reservations"\s*\)/, /\bpost\b/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/reservations"/]},
      },
    },
    {
      id: 'quantity-range',
      title: 'Rejects a quantity outside 1..1000 with 400 before the reserve',
      detail:
        'Quantities -3, 0 and 1001 answer **400** and leave the counter alone; 1000 is reserved. The starter hands any quantity to the reserve, and a negative one adds stock.',
      match: {
        python: {
          all: [/MAX_ORDER_QUANTITY\s*=\s*1000/, /\b400\b/],
          order: [/[<>]=?\s*MAX_ORDER_QUANTITY\b/, /stock\.reserve\(/],
        },
        typescript: {
          all: [/MAX_ORDER_QUANTITY\s*=\s*1000/, /\b400\b/],
          order: [/[<>]=?\s*MAX_ORDER_QUANTITY\b/, /\breserve\(/],
        },
        go: {
          all: [/maxOrderQuantity\s*=\s*1000/, /StatusBadRequest|\b400\b/],
          order: [/[<>]=?\s*maxOrderQuantity\b/, /stock\.Reserve\(/],
        },
        scala: {
          all: [/MaxOrderQuantity\s*=\s*1000/, /BadRequest|\b400\b/],
          order: [/[<>]=?\s*MaxOrderQuantity\b/, /Stock\.reserve\(/],
        },
        cpp: {
          all: [/kMaxOrderQuantity\s*=\s*1000/, /\b400\b/],
          order: [/[<>]=?\s*kMaxOrderQuantity\b/, /stock::Reserve\(/],
        },
      },
    },
    {
      id: 'sku-tenant',
      title: "Answers 404 for a sku the caller's tenant does not sell",
      detail:
        "A reservation of another tenant's sku, or of a sku the catalogue does not know, is **404** with no stock moved and no reservation stored. The starter reserves whatever sku it is sent.",
      match: {
        python: {all: [/catalog\.owner\(/, /\b404\b/], order: [/catalog\.owner\(/, /stock\.reserve\(/]},
        typescript: {all: [/\bowner\(/, /\b404\b/], order: [/\bowner\(/, /\breserve\(/]},
        go: {all: [/catalog\.Owner\(/, /StatusNotFound|\b404\b/], order: [/catalog\.Owner\(/, /stock\.Reserve\(/]},
        scala: {all: [/Catalog\.owner\(/, /NotFound|\b404\b/], order: [/Catalog\.owner\(/, /Stock\.reserve\(/]},
        cpp: {all: [/catalog::Owner\(/, /\b404\b/], order: [/catalog::Owner\(/, /stock::Reserve\(/]},
      },
    },
    {
      id: 'idempotency',
      title: 'Answers a replayed Idempotency-Key with the first reservation',
      detail:
        'The same key twice answers the same `reservation_id` (201, then 200) and takes the units once; a request without the key is **400**. The starter stores the key and never reads it back.',
      match: {
        python: {all: [/idempotency-key/i, /store\.get_by_key\(/], order: [/store\.get_by_key\(/, /stock\.reserve\(/]},
        typescript: {all: [/idempotency-key/i, /store\.getByKey\(/], order: [/store\.getByKey\(/, /\breserve\(/]},
        go: {all: [/Idempotency-Key/i, /store\.GetByKey\(/], order: [/store\.GetByKey\(/, /stock\.Reserve\(/]},
        scala: {all: [/Idempotency-Key/i, /Store\.getByKey\(/], order: [/Store\.getByKey\(/, /Stock\.reserve\(/]},
        cpp: {all: [/Idempotency-Key/i, /store::GetByKey\(/], order: [/store::GetByKey\(/, /stock::Reserve\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from inventory import catalog, stock  # catalog.owner; stock.reserve, RESERVATION_TTL_S
from inventory.store import new_id, store  # store.get_by_key, put

app = FastAPI()


class ReservationIn(BaseModel):
    sku: str
    quantity: int


@app.post("/v1/reservations", status_code=201)
def create_reservation(body: ReservationIn, request: Request) -> dict:
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    reservation_id = new_id()
    if not stock.reserve(body.sku, body.quantity, reservation_id):
        raise HTTPException(status_code=409, detail="insufficient stock")
    reservation = {
        "reservation_id": reservation_id,
        "tenant": tenant,
        "idempotency_key": request.headers.get("idempotency-key", ""),
        "sku": body.sku,
        "quantity": body.quantity,
        "status": "reserved",
        "expires_at": int(time.time()) + stock.RESERVATION_TTL_S,
    }
    store.put(reservation)
    return reservation
`,
      solution: `import time

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from inventory import catalog, stock  # catalog.owner; stock.reserve, RESERVATION_TTL_S
from inventory.store import new_id, store  # store.get_by_key, put

app = FastAPI()

MAX_ORDER_QUANTITY = 1000


class ReservationIn(BaseModel):
    sku: str
    quantity: int


@app.post("/v1/reservations", status_code=201)
def create_reservation(body: ReservationIn, request: Request) -> dict:
    tenant = request.headers.get("x-tenant-id", "")
    # Every guard runs before the one call that moves stock: the counter subtracts whatever it is given.
    if not 1 <= body.quantity <= MAX_ORDER_QUANTITY:
        raise HTTPException(status_code=400, detail="quantity out of range")
    key = request.headers.get("idempotency-key", "")
    if not key:
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    recorded = store.get_by_key(tenant, key)
    if recorded is not None:
        return JSONResponse(recorded)  # a replay answers the first reservation and reserves nothing
    if catalog.owner(body.sku) != tenant:
        raise HTTPException(status_code=404, detail="unknown sku")
    reservation_id = new_id()
    if not stock.reserve(body.sku, body.quantity, reservation_id):
        raise HTTPException(status_code=409, detail="insufficient stock")
    reservation = {
        "reservation_id": reservation_id,
        "tenant": tenant,
        "idempotency_key": key,
        "sku": body.sku,
        "quantity": body.quantity,
        "status": "reserved",
        "expires_at": int(time.time()) + stock.RESERVATION_TTL_S,
    }
    store.put(reservation)
    return reservation
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {owner} from 'inventory/catalog';
import {RESERVATION_TTL_S, reserve} from 'inventory/stock';
import {type Reservation, newId, store} from 'inventory/store';

export const app = Fastify();

app.post('/v1/reservations', async (request, reply) => {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const tenant = String(request.headers['x-tenant-id'] ?? '');
  const {sku, quantity} = request.body as {sku: string; quantity: number};
  const reservationId = newId();
  if (!(await reserve(sku, quantity, reservationId))) return reply.code(409).send({error: 'insufficient stock'});
  const reservation: Reservation = {
    reservation_id: reservationId,
    tenant,
    idempotency_key: String(request.headers['idempotency-key'] ?? ''),
    sku,
    quantity,
    status: 'reserved',
    expires_at: Math.floor(Date.now() / 1000) + RESERVATION_TTL_S,
  };
  await store.put(reservation);
  return reply.code(201).send(reservation);
});
`,
      solution: `import Fastify from 'fastify';

import {owner} from 'inventory/catalog';
import {RESERVATION_TTL_S, reserve} from 'inventory/stock';
import {type Reservation, newId, store} from 'inventory/store';

export const app = Fastify();

export const MAX_ORDER_QUANTITY = 1000;

app.post('/v1/reservations', async (request, reply) => {
  const tenant = String(request.headers['x-tenant-id'] ?? '');
  const {sku, quantity} = request.body as {sku: string; quantity: number};
  // Every guard runs before the one call that moves stock: the counter subtracts whatever it is given.
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_ORDER_QUANTITY) {
    return reply.code(400).send({error: 'quantity out of range'});
  }
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key === '') return reply.code(400).send({error: 'Idempotency-Key is required'});
  const recorded = await store.getByKey(tenant, key);
  if (recorded !== null) return reply.code(200).send(recorded); // a replay answers the first reservation and reserves nothing
  if ((await owner(sku)) !== tenant) return reply.code(404).send({error: 'unknown sku'});
  const reservationId = newId();
  if (!(await reserve(sku, quantity, reservationId))) return reply.code(409).send({error: 'insufficient stock'});
  const reservation: Reservation = {
    reservation_id: reservationId,
    tenant,
    idempotency_key: key,
    sku,
    quantity,
    status: 'reserved',
    expires_at: Math.floor(Date.now() / 1000) + RESERVATION_TTL_S,
  };
  await store.put(reservation);
  return reply.code(201).send(reservation);
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
	"time"

	"inventory/stock" // stock.Reserve, ReservationTTLS
	"inventory/store" // store.NewID, GetByKey, Put
)

type reservationRequest struct {
	SKU      string \`json:"sku"\`
	Quantity int    \`json:"quantity"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func createReservation(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	var body reservationRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, "malformed body", http.StatusBadRequest)
		return
	}
	reservationID := store.NewID()
	held, err := stock.Reserve(r.Context(), body.SKU, body.Quantity, reservationID)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	if !held {
		http.Error(rw, "insufficient stock", http.StatusConflict)
		return
	}
	reservation := &store.Reservation{
		ReservationID: reservationID, Tenant: tenant, IdempotencyKey: r.Header.Get("Idempotency-Key"),
		SKU: body.SKU, Quantity: body.Quantity, Status: "reserved", ExpiresAt: time.Now().Unix() + stock.ReservationTTLS,
	}
	if err := store.Put(r.Context(), reservation); err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(rw, http.StatusCreated, reservation)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/reservations", createReservation)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"time"

	"inventory/catalog"
	"inventory/stock" // stock.Reserve, ReservationTTLS
	"inventory/store" // store.NewID, GetByKey, Put
)

const maxOrderQuantity = 1000

type reservationRequest struct {
	SKU      string \`json:"sku"\`
	Quantity int    \`json:"quantity"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func createReservation(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	var body reservationRequest
	// Every guard runs before the one call that moves stock: the counter subtracts whatever it is given.
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Quantity < 1 || body.Quantity > maxOrderQuantity {
		http.Error(rw, "quantity out of range", http.StatusBadRequest)
		return
	}
	key := r.Header.Get("Idempotency-Key")
	if key == "" {
		http.Error(rw, "Idempotency-Key is required", http.StatusBadRequest)
		return
	}
	recorded, err := store.GetByKey(r.Context(), tenant, key)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	if recorded != nil {
		writeJSON(rw, http.StatusOK, recorded) // a replay answers the first reservation and reserves nothing
		return
	}
	if owner := catalog.Owner(r.Context(), body.SKU); owner == "" || owner != tenant {
		http.Error(rw, "unknown sku", http.StatusNotFound)
		return
	}
	reservationID := store.NewID()
	held, err := stock.Reserve(r.Context(), body.SKU, body.Quantity, reservationID)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	if !held {
		http.Error(rw, "insufficient stock", http.StatusConflict)
		return
	}
	reservation := &store.Reservation{
		ReservationID: reservationID, Tenant: tenant, IdempotencyKey: key,
		SKU: body.SKU, Quantity: body.Quantity, Status: "reserved", ExpiresAt: time.Now().Unix() + stock.ReservationTTLS,
	}
	if err := store.Put(r.Context(), reservation); err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(rw, http.StatusCreated, reservation)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/reservations", createReservation)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import inventory.{Catalog, Reservation, Stock, Store} // Catalog.owner; Stock.reserve; Store.getByKey, put

object Api {
  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  val route: Route = path("v1" / "reservations") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") { tenantHeader =>
        optionalHeaderValueByName("Idempotency-Key") { keyHeader =>
          entity(as[String]) { raw =>
            // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
            val body = raw.parseJson.asJsObject.fields
            val sku = body.get("sku").collect { case JsString(s) => s }.getOrElse("")
            val quantity = body.get("quantity").collect { case JsNumber(n) => n.toInt }.getOrElse(0)
            val tenant = tenantHeader.getOrElse("")
            val reservationId = Store.newId()
            if (!Stock.reserve(sku, quantity, reservationId)) complete(StatusCodes.Conflict -> "insufficient stock")
            else {
              val reservation = Reservation(reservationId, tenant, keyHeader.getOrElse(""), sku, quantity, "reserved", System.currentTimeMillis() / 1000 + Stock.ReservationTtlS)
              Store.put(reservation)
              complete(json(StatusCodes.Created, reservation.toJson))
            }
          }
        }
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import inventory.{Catalog, Reservation, Stock, Store} // Catalog.owner; Stock.reserve; Store.getByKey, put

object Api {
  val MaxOrderQuantity = 1000

  private def json(status: StatusCode, body: JsValue): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  val route: Route = path("v1" / "reservations") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") { tenantHeader =>
        optionalHeaderValueByName("Idempotency-Key") { keyHeader =>
          entity(as[String]) { raw =>
            val body = raw.parseJson.asJsObject.fields
            val sku = body.get("sku").collect { case JsString(s) => s }.getOrElse("")
            val quantity = body.get("quantity").collect { case JsNumber(n) if n.isValidInt => n.toInt }.getOrElse(0)
            val tenant = tenantHeader.getOrElse("")
            val key = keyHeader.getOrElse("")
            // Every guard runs before the one call that moves stock: the counter subtracts whatever it is given.
            if (quantity < 1 || quantity > MaxOrderQuantity) complete(StatusCodes.BadRequest -> "quantity out of range")
            else if (key.isEmpty) complete(StatusCodes.BadRequest -> "Idempotency-Key is required")
            else
              Store.getByKey(tenant, key) match {
                case Some(recorded) => complete(json(StatusCodes.OK, recorded.toJson)) // a replay answers the first reservation and reserves nothing
                case None if !Catalog.owner(sku).contains(tenant) => complete(StatusCodes.NotFound -> "unknown sku")
                case None =>
                  val reservationId = Store.newId()
                  if (!Stock.reserve(sku, quantity, reservationId)) complete(StatusCodes.Conflict -> "insufficient stock")
                  else {
                    val reservation = Reservation(reservationId, tenant, key, sku, quantity, "reserved", System.currentTimeMillis() / 1000 + Stock.ReservationTtlS)
                    Store.put(reservation)
                    complete(json(StatusCodes.Created, reservation.toJson))
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

#include <chrono>
#include <string>

#include "inventory/catalog.h"  // catalog::Owner
#include "inventory/stock.h"    // stock::Reserve, kReservationTtlS
#include "inventory/store.h"    // store::GetByKey, Put; NewId

using json = nlohmann::json;

long long epochSeconds() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

void create_reservation(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  const json body = json::parse(req.body);
  const std::string sku = body.value("sku", "");
  const int quantity = body.value("quantity", 0);
  const std::string reservation_id = inventory::NewId();
  if (!inventory::stock::Reserve(sku, quantity, reservation_id)) {
    res.status = 409;
    res.set_content("insufficient stock", "text/plain");
    return;
  }
  const inventory::Reservation reservation{reservation_id, tenant, req.get_header_value("Idempotency-Key"), sku, quantity, "reserved",
                                           epochSeconds() + inventory::stock::kReservationTtlS};
  inventory::store::Put(reservation);
  res.status = 201;
  res.set_content(json(reservation).dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/reservations", create_reservation); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <string>

#include "inventory/catalog.h"  // catalog::Owner
#include "inventory/stock.h"    // stock::Reserve, kReservationTtlS
#include "inventory/store.h"    // store::GetByKey, Put; NewId

using json = nlohmann::json;

constexpr int kMaxOrderQuantity = 1000;

long long epochSeconds() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

void reply(httplib::Response& res, int status, const std::string& text) {
  res.status = status;
  res.set_content(text, "text/plain");
}

void create_reservation(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  const json body = json::parse(req.body, nullptr, false);
  const bool whole = body.is_object() && body.contains("quantity") && body["quantity"].is_number_integer();
  const long long quantity = whole ? body["quantity"].get<long long>() : 0;
  // Every guard runs before the one call that moves stock: the counter subtracts whatever it is given.
  if (quantity < 1 || quantity > kMaxOrderQuantity) return reply(res, 400, "quantity out of range");
  const std::string key = req.get_header_value("Idempotency-Key");
  if (key.empty()) return reply(res, 400, "Idempotency-Key is required");
  if (const auto recorded = inventory::store::GetByKey(tenant, key)) {
    res.set_content(json(*recorded).dump(), "application/json");  // a replay answers the first reservation and reserves nothing
    return;
  }
  const std::string sku = body.value("sku", "");
  if (inventory::catalog::Owner(sku) != tenant) return reply(res, 404, "unknown sku");
  const std::string reservation_id = inventory::NewId();
  if (!inventory::stock::Reserve(sku, static_cast<int>(quantity), reservation_id)) return reply(res, 409, "insufficient stock");
  const inventory::Reservation reservation{reservation_id, tenant, key, sku, static_cast<int>(quantity), "reserved",
                                           epochSeconds() + inventory::stock::kReservationTtlS};
  inventory::store::Put(reservation);
  res.status = 201;
  res.set_content(json(reservation).dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/reservations", create_reservation); }
`,
    },
  },
  harness: {
    python: `from inventory.store import store


async def _world(ctx, units=10):
    ctx.redis.hset("sku:sku-1", mapping={"tenant": "t1"})
    ctx.redis.hset("sku:sku-9", mapping={"tenant": "t2"})
    ctx.redis.set("stock:sku-1", units)
    ctx.redis.set("stock:sku-9", units)
    return ctx.client(ctx.load("api").app)


async def _reserve(c, sku="sku-1", quantity=3, key="k-1", tenant="t1"):
    headers = {"X-Tenant-Id": tenant}
    if key:
        headers["Idempotency-Key"] = key
    return await c.post("/v1/reservations", json={"sku": sku, "quantity": quantity}, headers=headers)


def _units(ctx, sku="sku-1"):
    return int(ctx.redis.get(f"stock:{sku}"))


async def check_route(ctx):
    async with await _world(ctx) as c:
        r = await _reserve(c)
    assert r.status_code == 201, f"POST /v1/reservations answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("status") == "reserved" and body.get("quantity") == 3 and body.get("sku") == "sku-1", f"the reservation must answer sku-1, 3 units, reserved; got {body}"
    assert _units(ctx) == 7, f"stock:sku-1 is {_units(ctx)} after reserving 3 of 10, expected 7"
    stored = store.get(body.get("reservation_id", ""))
    assert stored is not None and stored["status"] == "reserved", f"the reservation store holds {stored} for {body.get('reservation_id')!r}"


async def check_quantity_range(ctx):
    async with await _world(ctx, units=5000) as c:
        for n, quantity in enumerate((-3, 0, 1001)):
            r = await _reserve(c, quantity=quantity, key=f"k-{n}")
            assert r.status_code == 400, f"a quantity of {quantity} answered {r.status_code} and stock:sku-1 is now {_units(ctx)}: a quantity outside 1..1000 is 400, before any stock moves"
            assert _units(ctx) == 5000, f"a rejected quantity of {quantity} moved the counter to {_units(ctx)}"
        r = await _reserve(c, quantity=1000, key="k-9")
    assert r.status_code == 201, f"a quantity of 1000 (the cap) answered {r.status_code}: {r.text}"
    assert _units(ctx) == 4000, f"stock:sku-1 is {_units(ctx)} after reserving 1000 of 5000"


async def check_sku_tenant(ctx):
    async with await _world(ctx) as c:
        other = await _reserve(c, sku="sku-9", key="k-1")
        unknown = await _reserve(c, sku="sku-404", key="k-2")
    assert other.status_code == 404, f"tenant t1 reserving t2's sku-9 answered {other.status_code}, expected 404"
    assert _units(ctx, "sku-9") == 10, f"t1's request moved t2's stock:sku-9 to {_units(ctx, 'sku-9')}"
    assert unknown.status_code == 404, f"a sku the catalogue does not know answered {unknown.status_code}, expected 404"
    assert ctx.redis.keys("reservation:*") == [], f"rejected requests stored reservations: {ctx.redis.keys('reservation:*')}"


async def check_idempotency(ctx):
    async with await _world(ctx) as c:
        first = await _reserve(c, key="k-1")
        replay = await _reserve(c, key="k-1")
        missing = await _reserve(c, key="")
    assert first.status_code == 201, f"the first reservation answered {first.status_code}: {first.text}"
    assert replay.status_code == 200, f"a replay of Idempotency-Key k-1 answered {replay.status_code}, expected 200 with the first reservation"
    assert replay.json().get("reservation_id") == first.json().get("reservation_id"), f"the replay answered reservation {replay.json().get('reservation_id')!r}, the first was {first.json().get('reservation_id')!r}"
    assert _units(ctx) == 7, f"stock:sku-1 is {_units(ctx)} after one reservation of 3 and its replay: the retry held the units again"
    assert missing.status_code == 400, f"a reservation without Idempotency-Key answered {missing.status_code}, expected 400"
`,
    typescript: `import {store} from 'inventory/store';

function world(ctx, units = 10) {
  ctx.redis.hset('sku:sku-1', 'tenant', 't1');
  ctx.redis.hset('sku:sku-9', 'tenant', 't2');
  ctx.redis.set('stock:sku-1', String(units));
  ctx.redis.set('stock:sku-9', String(units));
  return ctx.client(ctx.load('api').app);
}

function reserveReq(c, {sku = 'sku-1', quantity = 3, key = 'k-1', tenant = 't1'} = {}) {
  const headers: Record<string, string> = {'X-Tenant-Id': tenant};
  if (key) headers['Idempotency-Key'] = key;
  return c.post('/v1/reservations', {json: {sku, quantity}, headers});
}

const units = (ctx, sku = 'sku-1'): number => Number(ctx.redis.get(\`stock:\${sku}\`));

export async function check_route(ctx) {
  const c = world(ctx);
  const r = await reserveReq(c);
  assert.equal(r.status, 201, \`POST /v1/reservations answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.status === 'reserved' && body.quantity === 3 && body.sku === 'sku-1', \`the reservation must answer sku-1, 3 units, reserved; got \${r.text}\`);
  assert.equal(units(ctx), 7, \`stock:sku-1 is \${units(ctx)} after reserving 3 of 10, expected 7\`);
  const stored = await store.get(body.reservation_id ?? '');
  assert(stored !== null && stored.status === 'reserved', \`the reservation store holds \${JSON.stringify(stored)} for \${body.reservation_id}\`);
}

export async function check_quantity_range(ctx) {
  const c = world(ctx, 5000);
  for (const [n, quantity] of [-3, 0, 1001].entries()) {
    const r = await reserveReq(c, {quantity, key: \`k-\${n}\`});
    assert.equal(r.status, 400, \`a quantity of \${quantity} answered \${r.status} and stock:sku-1 is now \${units(ctx)}: a quantity outside 1..1000 is 400, before any stock moves\`);
    assert.equal(units(ctx), 5000, \`a rejected quantity of \${quantity} moved the counter to \${units(ctx)}\`);
  }
  const r = await reserveReq(c, {quantity: 1000, key: 'k-9'});
  assert.equal(r.status, 201, \`a quantity of 1000 (the cap) answered \${r.status}: \${r.text}\`);
  assert.equal(units(ctx), 4000, \`stock:sku-1 is \${units(ctx)} after reserving 1000 of 5000\`);
}

export async function check_sku_tenant(ctx) {
  const c = world(ctx);
  const other = await reserveReq(c, {sku: 'sku-9', key: 'k-1'});
  const unknown = await reserveReq(c, {sku: 'sku-404', key: 'k-2'});
  assert.equal(other.status, 404, \`tenant t1 reserving t2's sku-9 answered \${other.status}, expected 404\`);
  assert.equal(units(ctx, 'sku-9'), 10, \`t1's request moved t2's stock:sku-9 to \${units(ctx, 'sku-9')}\`);
  assert.equal(unknown.status, 404, \`a sku the catalogue does not know answered \${unknown.status}, expected 404\`);
  assert.deepEqual(ctx.redis.keys('reservation:*'), [], \`rejected requests stored reservations: \${JSON.stringify(ctx.redis.keys('reservation:*'))}\`);
}

export async function check_idempotency(ctx) {
  const c = world(ctx);
  const first = await reserveReq(c, {key: 'k-1'});
  const replay = await reserveReq(c, {key: 'k-1'});
  const missing = await reserveReq(c, {key: ''});
  assert.equal(first.status, 201, \`the first reservation answered \${first.status}: \${first.text}\`);
  assert.equal(replay.status, 200, \`a replay of Idempotency-Key k-1 answered \${replay.status}, expected 200 with the first reservation\`);
  assert.equal(replay.json().reservation_id, first.json().reservation_id, \`the replay answered reservation \${replay.json().reservation_id}, the first was \${first.json().reservation_id}\`);
  assert.equal(units(ctx), 7, \`stock:sku-1 is \${units(ctx)} after one reservation of 3 and its replay: the retry held the units again\`);
  assert.equal(missing.status, 400, \`a reservation without Idempotency-Key answered \${missing.status}, expected 400\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"net/http"
	"strconv"

	"leetbuild/harness"

	"inventory/store"
)

func apiWorld(ctx *harness.Ctx, units int) *harness.HTTP {
	ctx.Redis.Do("HSET", "sku:sku-1", "tenant", "t1")
	ctx.Redis.Do("HSET", "sku:sku-9", "tenant", "t2")
	ctx.Redis.Set("stock:sku-1", units)
	ctx.Redis.Set("stock:sku-9", units)
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func apiReserve(c *harness.HTTP, sku string, quantity int, key string) *harness.Response {
	body := map[string]any{"sku": sku, "quantity": quantity}
	if key == "" {
		return c.Post("/v1/reservations", body, "X-Tenant-Id", "t1")
	}
	return c.Post("/v1/reservations", body, "X-Tenant-Id", "t1", "Idempotency-Key", key)
}

func apiUnits(ctx *harness.Ctx, sku string) int {
	value, _ := ctx.Redis.Get("stock:" + sku)
	n, _ := strconv.Atoi(value)
	return n
}

type apiReservation struct {
	ReservationID string \`json:"reservation_id"\`
	SKU           string \`json:"sku"\`
	Quantity      int    \`json:"quantity"\`
	Status        string \`json:"status"\`
}

func apiBody(r *harness.Response) apiReservation {
	var body apiReservation
	r.Decode(&body)
	return body
}

func CheckRoute(ctx *harness.Ctx) {
	c := apiWorld(ctx, 10)
	r := apiReserve(c, "sku-1", 3, "k-1")
	ctx.Equal(r.Status, 201, "POST /v1/reservations (%s)", r.Text())
	body := apiBody(r)
	ctx.Assert(body.Status == "reserved" && body.Quantity == 3 && body.SKU == "sku-1", "the reservation must answer sku-1, 3 units, reserved; got %s", r.Text())
	ctx.Equal(apiUnits(ctx, "sku-1"), 7, "stock:sku-1 after reserving 3 of 10")
	stored, err := store.Get(context.Background(), body.ReservationID)
	ctx.NoError(err, "reading the reservation store")
	ctx.Assert(stored != nil && stored.Status == "reserved", "the reservation store holds %+v for %q", stored, body.ReservationID)
}

func CheckQuantityRange(ctx *harness.Ctx) {
	c := apiWorld(ctx, 5000)
	for n, quantity := range []int{-3, 0, 1001} {
		r := apiReserve(c, "sku-1", quantity, fmt.Sprintf("k-%d", n))
		ctx.Assert(r.Status == 400, "a quantity of %d answered %d and stock:sku-1 is now %d: a quantity outside 1..1000 is 400, before any stock moves", quantity, r.Status, apiUnits(ctx, "sku-1"))
		ctx.Equal(apiUnits(ctx, "sku-1"), 5000, "stock:sku-1 after a rejected quantity of %d", quantity)
	}
	r := apiReserve(c, "sku-1", 1000, "k-9")
	ctx.Equal(r.Status, 201, "a quantity of 1000, the cap (%s)", r.Text())
	ctx.Equal(apiUnits(ctx, "sku-1"), 4000, "stock:sku-1 after reserving 1000 of 5000")
}

func CheckSkuTenant(ctx *harness.Ctx) {
	c := apiWorld(ctx, 10)
	other := apiReserve(c, "sku-9", 3, "k-1")
	unknown := apiReserve(c, "sku-404", 3, "k-2")
	ctx.Equal(other.Status, 404, "tenant t1 reserving t2's sku-9")
	ctx.Equal(apiUnits(ctx, "sku-9"), 10, "t2's stock:sku-9 after t1's request")
	ctx.Equal(unknown.Status, 404, "a sku the catalogue does not know")
	ctx.Equal(len(ctx.Redis.Keys("reservation:*")), 0, "reservations stored by rejected requests")
}

func CheckIdempotency(ctx *harness.Ctx) {
	c := apiWorld(ctx, 10)
	first := apiReserve(c, "sku-1", 3, "k-1")
	replay := apiReserve(c, "sku-1", 3, "k-1")
	missing := apiReserve(c, "sku-1", 3, "")
	ctx.Equal(first.Status, 201, "the first reservation (%s)", first.Text())
	ctx.Equal(replay.Status, 200, "a replay of Idempotency-Key k-1 must answer the first reservation; the status")
	ctx.Equal(apiBody(replay).ReservationID, apiBody(first).ReservationID, "the replay must answer the first reservation's id")
	ctx.Equal(apiUnits(ctx, "sku-1"), 7, "stock:sku-1 after one reservation of 3 and its replay (the retry must not hold the units again)")
	ctx.Equal(missing.Status, 400, "a reservation without Idempotency-Key")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>

#include "inventory/store.h"

namespace {

harness::HTTP apiWorld(harness::Ctx& ctx, int units) {
  ctx.Redis.Do("HSET", "sku:sku-1", "tenant", "t1");
  ctx.Redis.Do("HSET", "sku:sku-9", "tenant", "t2");
  ctx.Redis.Do("SET", "stock:sku-1", units);
  ctx.Redis.Do("SET", "stock:sku-9", units);
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response apiReserve(harness::HTTP& c, const std::string& sku, int quantity, const std::string& key) {
  const std::string body = nlohmann::json{{"sku", sku}, {"quantity", quantity}}.dump();
  if (key.empty()) return c.Post("/v1/reservations", body, "Content-Type", "application/json", "X-Tenant-Id", "t1");
  return c.Post("/v1/reservations", body, "Content-Type", "application/json", "X-Tenant-Id", "t1", "Idempotency-Key", key);
}

long long apiUnits(harness::Ctx& ctx, const std::string& sku) {
  const auto value = ctx.Redis.Get("stock:" + sku);
  return value ? std::stoll(*value) : 0;
}

nlohmann::json apiBody(const harness::Response& r) {
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  return body.is_object() ? body : nlohmann::json::object();
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = apiWorld(ctx, 10);
  const auto r = apiReserve(c, "sku-1", 3, "k-1");
  ctx.Equal(r.Status, 201, "POST /v1/reservations (%s)", r.Text());
  const auto body = apiBody(r);
  ctx.Assert(body.value("status", "") == "reserved" && body.value("quantity", 0) == 3 && body.value("sku", "") == "sku-1",
             "the reservation must answer sku-1, 3 units, reserved; got %s", r.Text());
  ctx.Equal(apiUnits(ctx, "sku-1"), 7, "stock:sku-1 after reserving 3 of 10");
  const auto stored = inventory::store::Get(body.value("reservation_id", ""));
  ctx.Assert(stored && stored->status == "reserved", "the reservation store holds no reserved record for %q", body.value("reservation_id", ""));
}

void CheckQuantityRange(harness::Ctx& ctx) {
  auto c = apiWorld(ctx, 5000);
  int n = 0;
  for (const int quantity : {-3, 0, 1001}) {
    const auto r = apiReserve(c, "sku-1", quantity, "k-" + std::to_string(n++));
    ctx.Assert(r.Status == 400, "a quantity of %d answered %d and stock:sku-1 is now %d: a quantity outside 1..1000 is 400, before any stock moves",
               quantity, r.Status, apiUnits(ctx, "sku-1"));
    ctx.Equal(apiUnits(ctx, "sku-1"), 5000, "stock:sku-1 after a rejected quantity of %d", quantity);
  }
  const auto r = apiReserve(c, "sku-1", 1000, "k-9");
  ctx.Equal(r.Status, 201, "a quantity of 1000, the cap (%s)", r.Text());
  ctx.Equal(apiUnits(ctx, "sku-1"), 4000, "stock:sku-1 after reserving 1000 of 5000");
}

void CheckSkuTenant(harness::Ctx& ctx) {
  auto c = apiWorld(ctx, 10);
  const auto other = apiReserve(c, "sku-9", 3, "k-1");
  const auto unknown = apiReserve(c, "sku-404", 3, "k-2");
  ctx.Equal(other.Status, 404, "tenant t1 reserving t2's sku-9");
  ctx.Equal(apiUnits(ctx, "sku-9"), 10, "t2's stock:sku-9 after t1's request");
  ctx.Equal(unknown.Status, 404, "a sku the catalogue does not know");
  ctx.Equal(ctx.Redis.Keys("reservation:*").size(), 0, "reservations stored by rejected requests");
}

void CheckIdempotency(harness::Ctx& ctx) {
  auto c = apiWorld(ctx, 10);
  const auto first = apiReserve(c, "sku-1", 3, "k-1");
  const auto replay = apiReserve(c, "sku-1", 3, "k-1");
  const auto missing = apiReserve(c, "sku-1", 3, "");
  ctx.Equal(first.Status, 201, "the first reservation (%s)", first.Text());
  ctx.Equal(replay.Status, 200, "a replay of Idempotency-Key k-1 must answer the first reservation; the status");
  ctx.Equal(apiBody(replay).value("reservation_id", ""), apiBody(first).value("reservation_id", ""), "the replay must answer the first reservation's id");
  ctx.Equal(apiUnits(ctx, "sku-1"), 7, "stock:sku-1 after one reservation of 3 and its replay (the retry must not hold the units again)");
  ctx.Equal(missing.Status, 400, "a reservation without Idempotency-Key");
}
`,
  },
  hints: [
    "A buyer orders -3 units and the sku shows three more in stock; a phone that retried after a timeout holds six units for a three-unit cart; one tenant can empty another tenant's shelf.",
    'The handler hands the body straight to `stock.reserve`, and the script subtracts whatever it is given, for any sku. The key header is stored with the reservation but never looked up, so every retry is a new reservation.',
    'Before `stock.reserve`: 400 unless 1 ≤ quantity ≤ `MAX_ORDER_QUANTITY`; 400 without a key; answer `store.get_by_key(tenant, key)` with 200 when it exists; 404 unless `catalog.owner(sku)` equals the tenant.',
  ],
  debrief: `Every guard sits in front of the one call that moves stock, because the counter cannot tell a bad request from a good one: a negative quantity is arithmetic it will happily do. The tenant check is the same idea for ownership, and it answers 404 rather than 403 so a caller cannot probe which skus other tenants sell. The idempotency lookup comes before any side effect because a retry is the normal case on mobile networks. Two retries that arrive at the same moment can still both miss the index; production services claim the key with \`SET NX\` before reserving, expire the record after a day, and reject a replay whose body differs from the first request.`,
};
