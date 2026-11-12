import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/shipments: one order, one live shipment',
  concept: 'http',
  guides: ['request-boundaries', 'idempotent-requests'],
  file: 'api',
  focus: ['client', 'api', 'db', 'registry'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/shipments\` with body
\`{"order_id": "ord_8123", "carrier": "ups", "service_level": "ground"}\` on the shipments store
(\`shipments.store\`, provided): it reads the tenant from \`X-Tenant-Id\`, looks up the order's last
shipment (\`store.last_for_order\`), reuses that shipment's id (or takes \`store.new_shipment_id()\`),
saves the shipment in \`label\` (\`store.save\`) and answers **201** with it. It serves the demo and
hides four flaws.

**Failure mode the checks target.** A checkout that times out and retries buys a second label for
the same parcel; a typo in \`carrier\` produces a label no partner will scan; the replacement for a
cancelled label lands on the voided id.

- A missing tenant is **401**; \`order_id\` is required and \`service_level\` is one of \`ground\`,
  \`express\`, \`freight\` (**400** otherwise); a carrier \`registry.lookup\` does not know is **422**.
- \`Idempotency-Key\` is required (**400**). Look \`(tenant, key)\` up with \`store.get_by_key\` first
  and answer a recorded shipment with **200**; record a new one with \`store.put_by_key\`.
- One live shipment per order: when \`store.active_for_order\` finds one, answer **409**
  \`{"error": "active_shipment_exists", "shipment_id": "<its id>"}\`.
- A new shipment always takes \`store.new_shipment_id()\`; after a \`cancelled\` one it names that id
  in \`replacement_of\`.`,
  sequence: {
    participants: ['Client', 'Shipment API', 'partner registry', 'shipments store'],
    messages: [
      {from: 'Client', to: 'Shipment API', label: 'POST /v1/shipments · X-Tenant-Id · Idempotency-Key', kind: 'sync'},
      {from: 'Shipment API', to: 'partner registry', label: 'lookup("ups")', kind: 'sync'},
      {from: 'partner registry', to: 'Shipment API', label: 'partner / none → 422', kind: 'reply'},
      {from: 'Shipment API', to: 'shipments store', label: 'get_by_key(tenant, key) → recorded → 200', kind: 'sync'},
      {from: 'Shipment API', to: 'shipments store', label: 'active_for_order → live → 409', kind: 'sync'},
      {from: 'Shipment API', to: 'shipments store', label: 'last_for_order → cancelled → replacement_of', kind: 'sync'},
      {from: 'Shipment API', to: 'shipments store', label: 'new_shipment_id · save · put_by_key', kind: 'sync'},
      {from: 'Shipment API', to: 'Client', label: '201 {shipment_id, status: label}', kind: 'reply'},
    ],
  },
  hints: [
    'Retry a create whose response was lost and the order holds two labels; a create for carrier `upss` goes through; cancel a label and its replacement comes back under the voided id.',
    'Nothing asks the partner registry and nothing records the `Idempotency-Key`. `last_for_order` is read only to copy its id: a live shipment and a cancelled one look the same to the handler.',
    'Guard in order: tenant 401, key 400, body 400, `registry.lookup` 422. Then `get_by_key` (200), `active_for_order` (409 naming it), a fresh `new_shipment_id()` with `replacement_of` after a cancelled one, `save` and `put_by_key`.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Creates a shipment on POST /v1/shipments',
      detail:
        'Register `POST /v1/shipments`; a valid create answers **201** with the shipment in `label`, saved for the tenant.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/shipments["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/shipments['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/shipments"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"shipments"\s*\)/, /\bpost\b/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/shipments"/]},
      },
    },
    {
      id: 'validate',
      title: 'Refuses an unknown tenant, body or carrier before saving',
      detail:
        'A missing tenant is **401**, an empty `order_id` or a service level outside `ground`/`express`/`freight` is **400**, and a carrier code `registry.lookup` does not know is **422**; nothing is saved for a refused create.',
      match: {
        python: {all: [/registry\.lookup\(/, /\b422\b/, /\b401\b/]},
        typescript: {all: [/registry\.lookup\(/, /\b422\b/, /\b401\b/]},
        go: {all: [/registry\.Lookup\(/, /StatusUnprocessableEntity|\b422\b/, /StatusUnauthorized|\b401\b/]},
        scala: {all: [/Registry\.lookup\(/, /UnprocessableEntity|\b422\b/, /Unauthorized|\b401\b/]},
        cpp: {all: [/registry::lookup\(/, /\b422\b/, /\b401\b/]},
      },
    },
    {
      id: 'single-active',
      title: 'Answers 409 naming the live shipment',
      detail:
        'A second create for an order whose shipment is still `label`, `in_transit` or `out_for_delivery` (`active_for_order`) is **409** with `active_shipment_exists` and the live shipment id, and saves nothing.',
      match: {
        python: {all: [/store\.active_for_order\(/, /\b409\b/, /active_shipment_exists/]},
        typescript: {all: [/store\.activeForOrder\(/, /\b409\b/, /active_shipment_exists/]},
        go: {all: [/store\.ActiveForOrder\(/, /StatusConflict|\b409\b/, /active_shipment_exists/]},
        scala: {all: [/Store\.activeForOrder\(/, /Conflict|\b409\b/, /active_shipment_exists/]},
        cpp: {all: [/store::activeForOrder\(/, /\b409\b/, /active_shipment_exists/]},
      },
    },
    {
      id: 'idempotency-key',
      title: 'Keys a create by (tenant, Idempotency-Key)',
      detail:
        '`Idempotency-Key` is required (**400**); the recorded shipment is looked up (`get_by_key`) before the live-shipment rule and answered with **200** on a replay, and a new shipment is recorded (`put_by_key`).',
      match: {
        python: {
          all: [/idempotency-key/i, /store\.get_by_key\(/, /store\.put_by_key\(/],
          order: [/store\.get_by_key\(/, /store\.active_for_order\(/],
        },
        typescript: {
          all: [/idempotency-key/i, /store\.getByKey\(/, /store\.putByKey\(/],
          order: [/store\.getByKey\(/, /store\.activeForOrder\(/],
        },
        go: {
          all: [/Idempotency-Key/i, /store\.GetByKey\(/, /store\.PutByKey\(/],
          order: [/store\.GetByKey\(/, /store\.ActiveForOrder\(/],
        },
        scala: {
          all: [/Idempotency-Key/i, /Store\.getByKey\(/, /Store\.putByKey\(/],
          order: [/Store\.getByKey\(/, /Store\.activeForOrder\(/],
        },
        cpp: {
          all: [/Idempotency-Key/i, /store::getByKey\(/, /store::putByKey\(/],
          order: [/store::getByKey\(/, /store::activeForOrder\(/],
        },
      },
    },
    {
      id: 'replacement',
      title: 'Replaces a cancelled shipment under a new id',
      detail:
        'Every new shipment takes `new_shipment_id()`; after a `cancelled` shipment the new one names it in `replacement_of`. Copying the previous shipment id hands the replacement a voided label.',
      match: {
        python: {all: [/["']cancelled["']/, /replacement_of/], none: [/["']shipment_id["']\s*:\s*previous\b/]},
        typescript: {all: [/['"]cancelled['"]/, /replacement_of/], none: [/shipment_id:\s*previous\b/]},
        go: {
          all: [/"cancelled"/, /ReplacementOf/],
          none: [/ShipmentID:\s*previous\.ShipmentID|\bshipmentID\s*=\s*previous\.ShipmentID/],
        },
        scala: {all: [/"cancelled"/, /replacementOf|replacement_of/], none: [/previous\.map\(_\.shipmentId\)/]},
        cpp: {all: [/"cancelled"/], none: [/previous\s*\?\s*previous->shipment_id\s*:\s*store::newShipmentId/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from shipments import registry, store  # registry.lookup; store.new_shipment_id, save, last_for_order, active_for_order, get_by_key, put_by_key

app = FastAPI()


class CreateShipment(BaseModel):
    order_id: str = ""
    carrier: str = ""
    service_level: str = ""


@app.post("/v1/shipments")
def create_shipment(body: CreateShipment, request: Request) -> JSONResponse:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    previous = store.last_for_order(tenant, body.order_id)
    shipment = {
        "shipment_id": previous["shipment_id"] if previous is not None else store.new_shipment_id(),
        "tenant_id": tenant,
        "order_id": body.order_id,
        "carrier": body.carrier,
        "service_level": body.service_level,
        "status": "label",
        "replacement_of": "",
        "created_at": int(time.time()),
    }
    store.save(shipment)
    return JSONResponse(shipment, status_code=201)
`,
      solution: `import time

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from shipments import registry, store  # registry.lookup; store.new_shipment_id, save, last_for_order, active_for_order, get_by_key, put_by_key

app = FastAPI()

SERVICE_LEVELS = ("ground", "express", "freight")


class CreateShipment(BaseModel):
    order_id: str = ""
    carrier: str = ""
    service_level: str = ""


def refuse(status: int, message: str) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=status)


@app.post("/v1/shipments")
def create_shipment(body: CreateShipment, request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        return refuse(401, "X-Tenant-Id is required")
    key = request.headers.get("idempotency-key", "")
    if not key:
        return refuse(400, "Idempotency-Key is required")
    if not body.order_id or body.service_level not in SERVICE_LEVELS:
        return refuse(400, "order_id is required and service_level is one of ground, express, freight")
    if registry.lookup(body.carrier) is None:
        return refuse(422, f"no partner has carrier code {body.carrier!r}")
    # A replay answers what the first attempt created, before the live-shipment rule sees it.
    recorded = store.get_by_key(tenant, key)
    if recorded is not None:
        return JSONResponse(recorded, status_code=200)
    active = store.active_for_order(tenant, body.order_id)
    if active is not None:
        return JSONResponse({"error": "active_shipment_exists", "shipment_id": active["shipment_id"]}, status_code=409)
    previous = store.last_for_order(tenant, body.order_id)
    shipment = {
        "shipment_id": store.new_shipment_id(),  # a voided id stays voided
        "tenant_id": tenant,
        "order_id": body.order_id,
        "carrier": body.carrier,
        "service_level": body.service_level,
        "status": "label",
        "replacement_of": previous["shipment_id"] if previous is not None and previous["status"] == "cancelled" else "",
        "created_at": int(time.time()),
    }
    store.save(shipment)
    store.put_by_key(tenant, key, shipment)
    return JSONResponse(shipment, status_code=201)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import * as registry from 'shipments/registry'; // registry.lookup
import * as store from 'shipments/store'; // store.newShipmentId, save, lastForOrder, activeForOrder, getByKey, putByKey

export const app = Fastify();

interface CreateShipment {
  order_id?: string;
  carrier?: string;
  service_level?: string;
}

app.post('/v1/shipments', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const tenant = String(request.headers['x-tenant-id'] ?? '');
  const body = (request.body ?? {}) as CreateShipment;
  const previous = await store.lastForOrder(tenant, body.order_id ?? '');
  const shipment: store.Shipment = {
    shipment_id: previous !== null ? previous.shipment_id : await store.newShipmentId(),
    tenant_id: tenant,
    order_id: body.order_id ?? '',
    carrier: body.carrier ?? '',
    service_level: body.service_level ?? '',
    status: 'label',
    replacement_of: '',
    created_at: Math.floor(Date.now() / 1000),
  };
  await store.save(shipment);
  return reply.code(201).send(shipment);
});
`,
      solution: `import Fastify from 'fastify';

import * as registry from 'shipments/registry'; // registry.lookup
import * as store from 'shipments/store'; // store.newShipmentId, save, lastForOrder, activeForOrder, getByKey, putByKey

export const app = Fastify();

const SERVICE_LEVELS = ['ground', 'express', 'freight'];

interface CreateShipment {
  order_id?: string;
  carrier?: string;
  service_level?: string;
}

app.post('/v1/shipments', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key === '') return reply.code(400).send({error: 'Idempotency-Key is required'});
  const body = (request.body ?? {}) as CreateShipment;
  const orderId = body.order_id ?? '';
  const carrier = body.carrier ?? '';
  const serviceLevel = body.service_level ?? '';
  if (orderId === '' || !SERVICE_LEVELS.includes(serviceLevel)) {
    return reply.code(400).send({error: 'order_id is required and service_level is one of ground, express, freight'});
  }
  if (registry.lookup(carrier) === null) return reply.code(422).send({error: \`no partner has carrier code "\${carrier}"\`});
  // A replay answers what the first attempt created, before the live-shipment rule sees it.
  const recorded = await store.getByKey(tenant, key);
  if (recorded !== null) return reply.code(200).send(recorded);
  const active = await store.activeForOrder(tenant, orderId);
  if (active !== null) return reply.code(409).send({error: 'active_shipment_exists', shipment_id: active.shipment_id});
  const previous = await store.lastForOrder(tenant, orderId);
  const shipment: store.Shipment = {
    shipment_id: await store.newShipmentId(), // a voided id stays voided
    tenant_id: tenant,
    order_id: orderId,
    carrier,
    service_level: serviceLevel,
    status: 'label',
    replacement_of: previous !== null && previous.status === 'cancelled' ? previous.shipment_id : '',
    created_at: Math.floor(Date.now() / 1000),
  };
  await store.save(shipment);
  await store.putByKey(tenant, key, shipment);
  return reply.code(201).send(shipment);
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
	"time"

	"shipments/store" // store.NewShipmentID, Save, LastForOrder, ActiveForOrder, GetByKey, PutByKey; the partners: registry.Lookup in "shipments/registry"
)

type createRequest struct {
	OrderID      string \`json:"order_id"\`
	Carrier      string \`json:"carrier"\`
	ServiceLevel string \`json:"service_level"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func createShipment(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	var body createRequest
	json.NewDecoder(r.Body).Decode(&body)
	previous := store.LastForOrder(r.Context(), tenant, body.OrderID)
	shipmentID := store.NewShipmentID(r.Context())
	if previous != nil {
		shipmentID = previous.ShipmentID
	}
	s := store.Shipment{
		ShipmentID: shipmentID, TenantID: tenant, OrderID: body.OrderID, Carrier: body.Carrier,
		ServiceLevel: body.ServiceLevel, Status: "label", CreatedAt: time.Now().Unix(),
	}
	store.Save(r.Context(), s)
	writeJSON(rw, http.StatusCreated, s)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/shipments", createShipment)
}
`,
      solution: `package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"shipments/registry" // registry.Lookup
	"shipments/store"    // store.NewShipmentID, Save, LastForOrder, ActiveForOrder, GetByKey, PutByKey
)

var serviceLevels = map[string]bool{"ground": true, "express": true, "freight": true}

type createRequest struct {
	OrderID      string \`json:"order_id"\`
	Carrier      string \`json:"carrier"\`
	ServiceLevel string \`json:"service_level"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func refuse(rw http.ResponseWriter, status int, message string) {
	writeJSON(rw, status, map[string]string{"error": message})
}

func createShipment(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		refuse(rw, http.StatusUnauthorized, "X-Tenant-Id is required")
		return
	}
	key := r.Header.Get("Idempotency-Key")
	if key == "" {
		refuse(rw, http.StatusBadRequest, "Idempotency-Key is required")
		return
	}
	var body createRequest
	json.NewDecoder(r.Body).Decode(&body)
	if body.OrderID == "" || !serviceLevels[body.ServiceLevel] {
		refuse(rw, http.StatusBadRequest, "order_id is required and service_level is one of ground, express, freight")
		return
	}
	if registry.Lookup(body.Carrier) == nil {
		refuse(rw, http.StatusUnprocessableEntity, fmt.Sprintf("no partner has carrier code %q", body.Carrier))
		return
	}
	// A replay answers what the first attempt created, before the live-shipment rule sees it.
	if recorded := store.GetByKey(r.Context(), tenant, key); recorded != nil {
		writeJSON(rw, http.StatusOK, recorded)
		return
	}
	if active := store.ActiveForOrder(r.Context(), tenant, body.OrderID); active != nil {
		writeJSON(rw, http.StatusConflict, map[string]string{"error": "active_shipment_exists", "shipment_id": active.ShipmentID})
		return
	}
	s := store.Shipment{
		ShipmentID: store.NewShipmentID(r.Context()), // a voided id stays voided
		TenantID:   tenant, OrderID: body.OrderID, Carrier: body.Carrier, ServiceLevel: body.ServiceLevel,
		Status: "label", CreatedAt: time.Now().Unix(),
	}
	if previous := store.LastForOrder(r.Context(), tenant, body.OrderID); previous != nil && previous.Status == "cancelled" {
		s.ReplacementOf = previous.ShipmentID
	}
	store.Save(r.Context(), s)
	store.PutByKey(r.Context(), tenant, key, s)
	writeJSON(rw, http.StatusCreated, s)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/shipments", createShipment)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import shipments.{Registry, Store} // Registry.lookup; Store.newShipmentId, save, lastForOrder, activeForOrder, getByKey, putByKey

object Api {
  private def text(body: JsObject, name: String): String = body.fields.get(name).collect { case JsString(s) => s }.getOrElse("")

  val route: Route = path("v1" / "shipments") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") { tenantHeader =>
        entity(as[String]) { raw =>
          // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
          val tenant = tenantHeader.getOrElse("")
          val body = scala.util.Try(raw.parseJson.asJsObject).getOrElse(JsObject.empty)
          val previous = Store.lastForOrder(tenant, text(body, "order_id"))
          val shipment = Store.Shipment(previous.map(_.shipmentId).getOrElse(Store.newShipmentId()), tenant, text(body, "order_id"),
            text(body, "carrier"), text(body, "service_level"), "label", "", System.currentTimeMillis() / 1000)
          Store.save(shipment)
          complete(HttpResponse(StatusCodes.Created, entity = HttpEntity(ContentTypes.\`application/json\`, shipment.toJson.compactPrint)))
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

import shipments.{Registry, Store} // Registry.lookup; Store.newShipmentId, save, lastForOrder, activeForOrder, getByKey, putByKey

object Api {
  val ServiceLevels: Set[String] = Set("ground", "express", "freight")

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def refuse(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  private def text(body: JsObject, name: String): String = body.fields.get(name).collect { case JsString(s) => s }.getOrElse("")

  private def create(tenant: String, key: String, raw: String): HttpResponse = {
    if (tenant.isEmpty) return refuse(StatusCodes.Unauthorized, "X-Tenant-Id is required")
    if (key.isEmpty) return refuse(StatusCodes.BadRequest, "Idempotency-Key is required")
    val body = scala.util.Try(raw.parseJson.asJsObject).getOrElse(JsObject.empty)
    val orderId = text(body, "order_id")
    val carrier = text(body, "carrier")
    val serviceLevel = text(body, "service_level")
    if (orderId.isEmpty || !ServiceLevels(serviceLevel)) return refuse(StatusCodes.BadRequest, "order_id is required and service_level is one of ground, express, freight")
    if (Registry.lookup(carrier).isEmpty) return refuse(StatusCodes.UnprocessableEntity, s"no partner has carrier code $carrier")
    // A replay answers what the first attempt created, before the live-shipment rule sees it.
    Store.getByKey(tenant, key) match {
      case Some(recorded) => json(StatusCodes.OK, recorded.toJson)
      case None =>
        Store.activeForOrder(tenant, orderId) match {
          case Some(active) => json(StatusCodes.Conflict, JsObject("error" -> JsString("active_shipment_exists"), "shipment_id" -> JsString(active.shipmentId)))
          case None =>
            val replacementOf = Store.lastForOrder(tenant, orderId).filter(_.status == "cancelled").map(_.shipmentId).getOrElse("")
            // A voided id stays voided: every new shipment takes a new id.
            val shipment = Store.Shipment(Store.newShipmentId(), tenant, orderId, carrier, serviceLevel, "label", replacementOf, System.currentTimeMillis() / 1000)
            Store.save(shipment)
            Store.putByKey(tenant, key, shipment)
            json(StatusCodes.Created, shipment.toJson)
        }
    }
  }

  val route: Route = path("v1" / "shipments") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") { tenant =>
        optionalHeaderValueByName("Idempotency-Key") { key =>
          entity(as[String]) { raw =>
            complete(create(tenant.getOrElse(""), key.getOrElse(""), raw))
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

#include "shipments/registry.h"  // registry::lookup
#include "shipments/store.h"     // store::newShipmentId, save, lastForOrder, activeForOrder, getByKey, putByKey

using json = nlohmann::json;

long now_seconds() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

void create_shipment(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  const json body = json::parse(req.body, nullptr, false);
  const std::string order_id = body.is_object() ? body.value("order_id", "") : "";
  const auto previous = store::lastForOrder(tenant, order_id);
  const store::Shipment s{previous ? previous->shipment_id : store::newShipmentId(),
                          tenant,
                          order_id,
                          body.is_object() ? body.value("carrier", "") : "",
                          body.is_object() ? body.value("service_level", "") : "",
                          "label",
                          "",
                          now_seconds()};
  store::save(s);
  res.status = 201;
  res.set_content(json(s).dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/shipments", create_shipment); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <set>
#include <string>

#include "shipments/registry.h"  // registry::lookup
#include "shipments/store.h"     // store::newShipmentId, save, lastForOrder, activeForOrder, getByKey, putByKey

using json = nlohmann::json;

const std::set<std::string> kServiceLevels = {"ground", "express", "freight"};

long now_seconds() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

void reply_json(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void create_shipment(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply_json(res, 401, {{"error", "X-Tenant-Id is required"}});
  const std::string key = req.get_header_value("Idempotency-Key");
  if (key.empty()) return reply_json(res, 400, {{"error", "Idempotency-Key is required"}});
  const json body = json::parse(req.body, nullptr, false);
  const std::string order_id = body.is_object() ? body.value("order_id", "") : "";
  const std::string carrier = body.is_object() ? body.value("carrier", "") : "";
  const std::string service_level = body.is_object() ? body.value("service_level", "") : "";
  if (order_id.empty() || kServiceLevels.count(service_level) == 0) {
    return reply_json(res, 400, {{"error", "order_id is required and service_level is one of ground, express, freight"}});
  }
  if (!registry::lookup(carrier)) return reply_json(res, 422, {{"error", "no partner has carrier code " + carrier}});
  // A replay answers what the first attempt created, before the live-shipment rule sees it.
  if (const auto recorded = store::getByKey(tenant, key)) return reply_json(res, 200, json(*recorded));
  if (const auto active = store::activeForOrder(tenant, order_id)) {
    return reply_json(res, 409, {{"error", "active_shipment_exists"}, {"shipment_id", active->shipment_id}});
  }
  const auto previous = store::lastForOrder(tenant, order_id);
  const store::Shipment s{store::newShipmentId(),  // a voided id stays voided
                          tenant,
                          order_id,
                          carrier,
                          service_level,
                          "label",
                          previous && previous->status == "cancelled" ? previous->shipment_id : "",
                          now_seconds()};
  store::save(s);
  store::putByKey(tenant, key, s);
  reply_json(res, 201, json(s));
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/shipments", create_shipment); }
`,
    },
  },
  harness: {
    python: `from shipments import store

BODY = {"order_id": "ord_8123", "carrier": "ups", "service_level": "ground"}


def _api(ctx):
    return ctx.client(ctx.load("api").app)


async def _create(c, key, body=None, tenant="t-acme"):
    headers = {"Idempotency-Key": key}
    if tenant:
        headers["X-Tenant-Id"] = tenant
    return await c.post("/v1/shipments", json=BODY if body is None else body, headers=headers)


def _created(r, what):
    assert r.status_code == 201, f"{what} answered {r.status_code}: {r.text}"
    return r.json()["shipment_id"]


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await _create(c, "k-1")
    shipment_id = _created(r, "POST /v1/shipments")
    body = r.json()
    assert body.get("status") == "label" and body.get("order_id") == "ord_8123", f"a new shipment must answer status label for ord_8123, got {body}"
    saved = store.get_shipment(shipment_id)
    assert saved is not None and saved["tenant_id"] == "t-acme" and saved["carrier"] == "ups", f"the store holds {saved} for {shipment_id}, expected t-acme's ups shipment"


async def check_validate(ctx):
    async with _api(ctx) as c:
        r = await c.post("/v1/shipments", json=BODY, headers={"Idempotency-Key": "k-1"})
        assert r.status_code == 401, f"a create without X-Tenant-Id answered {r.status_code}, expected 401"
        r = await _create(c, "k-2", {**BODY, "carrier": "upss"})
        assert r.status_code == 422, f"a create for carrier 'upss' (no partner has it) answered {r.status_code}, expected 422: ask registry.lookup"
        r = await _create(c, "k-3", {**BODY, "service_level": "overnight"})
        assert r.status_code == 400, f"service_level 'overnight' answered {r.status_code}, expected 400 (ground, express, freight)"
        r = await _create(c, "k-4", {**BODY, "order_id": ""})
        assert r.status_code == 400, f"an empty order_id answered {r.status_code}, expected 400"
        saved = ctx.redis.keys("order:*")
        assert saved == [], f"refused creates still saved shipments: {sorted(saved)}"
        r = await _create(c, "k-5", {**BODY, "carrier": "fedex", "service_level": "express"})
    _created(r, "a valid fedex express create")


async def check_single_active(ctx):
    async with _api(ctx) as c:
        first_id = _created(await _create(c, "k-1"), "the first create")
        second = await _create(c, "k-2")
    assert second.status_code == 409, f"a second shipment for ord_8123 while {first_id} is live answered {second.status_code} {second.text}, expected 409"
    body = second.json()
    assert body.get("error") == "active_shipment_exists" and body.get("shipment_id") == first_id, f"the 409 must name the live shipment ({{error: active_shipment_exists, shipment_id: {first_id}}}), got {body}"
    ids = ctx.redis.lrange("order:t-acme:ord_8123", 0, -1)
    assert ids == [first_id], f"the order lists shipments {ids}: the refused create saved one"
    store.set_status(first_id, "delivered", 100)
    async with _api(ctx) as c:
        _created(await _create(c, "k-3"), "a create after the order's shipment was delivered (no longer live)")


async def check_idempotency_key(ctx):
    async with _api(ctx) as c:
        first = await _create(c, "k-1")
        first_id = _created(first, "the first create")
        replay = await _create(c, "k-1")
        assert replay.status_code == 200, f"a replay of Idempotency-Key k-1 answered {replay.status_code} {replay.text}, expected 200 with the recorded shipment"
        assert replay.json() == first.json(), f"the replay must answer the recorded shipment {first.json()}, got {replay.json()}"
        missing = await c.post("/v1/shipments", json=BODY, headers={"X-Tenant-Id": "t-acme"})
        assert missing.status_code == 400, f"a create without Idempotency-Key answered {missing.status_code}, expected 400"
        ids = ctx.redis.lrange("order:t-acme:ord_8123", 0, -1)
        assert ids == [first_id], f"one create and its replay left {ids} on the order, expected [{first_id!r}]"
        other = await _create(c, "k-1", tenant="t-globex")
    other_id = _created(other, "another tenant's create with the same key")
    assert other_id != first_id, "another tenant's key k-1 answered t-acme's shipment: keys are scoped by tenant"


async def check_replacement(ctx):
    async with _api(ctx) as c:
        first_id = _created(await _create(c, "k-1"), "the first create")
    store.set_status(first_id, "cancelled", 100)
    async with _api(ctx) as c:
        second = await _create(c, "k-2")
    second_id = _created(second, "a create after the order's shipment was cancelled")
    assert second_id != first_id, f"the replacement reused the cancelled id {first_id}: the carrier's scans for the voided label would land on it"
    assert second.json().get("replacement_of") == first_id, f"the replacement must name {first_id} in replacement_of, got {second.json()}"
    assert store.get_shipment(first_id)["status"] == "cancelled", f"the cancelled shipment now reads {store.get_shipment(first_id)}"
`,
    typescript: `const BODY = {order_id: 'ord_8123', carrier: 'ups', service_level: 'ground'};

function api(ctx) {
  return {c: ctx.client(ctx.load('api').app), store: ctx.load('/support/shipments/store.ts')};
}

function create(c, key: string, body: Record<string, string> = BODY, tenant = 't-acme') {
  const headers: Record<string, string> = {'Idempotency-Key': key};
  if (tenant !== '') headers['X-Tenant-Id'] = tenant;
  return c.post('/v1/shipments', {json: body, headers});
}

function created(r, what: string): string {
  assert.equal(r.status, 201, \`\${what} answered \${r.status}: \${r.text}\`);
  return r.json().shipment_id;
}

export async function check_route(ctx) {
  const {c, store} = api(ctx);
  const r = await create(c, 'k-1');
  const shipmentId = created(r, 'POST /v1/shipments');
  const body = r.json();
  assert(body.status === 'label' && body.order_id === 'ord_8123', \`a new shipment must answer status label for ord_8123, got \${r.text}\`);
  const saved = await store.getShipment(shipmentId);
  assert(saved !== null && saved.tenant_id === 't-acme' && saved.carrier === 'ups', \`the store holds \${JSON.stringify(saved)} for \${shipmentId}, expected t-acme's ups shipment\`);
}

export async function check_validate(ctx) {
  const {c} = api(ctx);
  let r = await c.post('/v1/shipments', {json: BODY, headers: {'Idempotency-Key': 'k-1'}});
  assert.equal(r.status, 401, \`a create without X-Tenant-Id answered \${r.status}, expected 401\`);
  r = await create(c, 'k-2', {...BODY, carrier: 'upss'});
  assert.equal(r.status, 422, \`a create for carrier 'upss' (no partner has it) answered \${r.status}, expected 422: ask registry.lookup\`);
  r = await create(c, 'k-3', {...BODY, service_level: 'overnight'});
  assert.equal(r.status, 400, \`service_level 'overnight' answered \${r.status}, expected 400 (ground, express, freight)\`);
  r = await create(c, 'k-4', {...BODY, order_id: ''});
  assert.equal(r.status, 400, \`an empty order_id answered \${r.status}, expected 400\`);
  const saved = ctx.redis.keys('order:*');
  assert.equal(saved.length, 0, \`refused creates still saved shipments: \${JSON.stringify(saved)}\`);
  created(await create(c, 'k-5', {...BODY, carrier: 'fedex', service_level: 'express'}), 'a valid fedex express create');
}

export async function check_single_active(ctx) {
  const {c, store} = api(ctx);
  const firstId = created(await create(c, 'k-1'), 'the first create');
  const second = await create(c, 'k-2');
  assert.equal(second.status, 409, \`a second shipment for ord_8123 while \${firstId} is live answered \${second.status} \${second.text}, expected 409\`);
  const body = second.json();
  assert(body.error === 'active_shipment_exists' && body.shipment_id === firstId, \`the 409 must name the live shipment (active_shipment_exists, \${firstId}), got \${second.text}\`);
  const ids = ctx.redis.lrange('order:t-acme:ord_8123', 0, -1);
  assert.deepStrictEqual(ids, [firstId], \`the order lists shipments \${JSON.stringify(ids)}: the refused create saved one\`);
  await store.setStatus(firstId, 'delivered', 100);
  created(await create(c, 'k-3'), "a create after the order's shipment was delivered (no longer live)");
}

export async function check_idempotency_key(ctx) {
  const {c} = api(ctx);
  const first = await create(c, 'k-1');
  const firstId = created(first, 'the first create');
  const replay = await create(c, 'k-1');
  assert.equal(replay.status, 200, \`a replay of Idempotency-Key k-1 answered \${replay.status} \${replay.text}, expected 200 with the recorded shipment\`);
  assert.deepStrictEqual(replay.json(), first.json(), \`the replay must answer the recorded shipment \${first.text}, got \${replay.text}\`);
  const missing = await c.post('/v1/shipments', {json: BODY, headers: {'X-Tenant-Id': 't-acme'}});
  assert.equal(missing.status, 400, \`a create without Idempotency-Key answered \${missing.status}, expected 400\`);
  const ids = ctx.redis.lrange('order:t-acme:ord_8123', 0, -1);
  assert.deepStrictEqual(ids, [firstId], \`one create and its replay left \${JSON.stringify(ids)} on the order, expected one shipment\`);
  const otherId = created(await create(c, 'k-1', BODY, 't-globex'), "another tenant's create with the same key");
  assert.notEqual(otherId, firstId, "another tenant's key k-1 answered t-acme's shipment: keys are scoped by tenant");
}

export async function check_replacement(ctx) {
  const {c, store} = api(ctx);
  const firstId = created(await create(c, 'k-1'), 'the first create');
  await store.setStatus(firstId, 'cancelled', 100);
  const second = await create(c, 'k-2');
  const secondId = created(second, "a create after the order's shipment was cancelled");
  assert.notEqual(secondId, firstId, \`the replacement reused the cancelled id \${firstId}: the carrier's scans for the voided label would land on it\`);
  assert.equal(second.json().replacement_of, firstId, \`the replacement must name \${firstId} in replacement_of, got \${second.text}\`);
  assert.equal((await store.getShipment(firstId)).status, 'cancelled', 'the cancelled shipment must stay cancelled');
}
`,
    go: `package main

import (
	"context"
	"net/http"

	"shipments/store"

	"leetbuild/harness"
)

var (
	apiBg = context.Background()
	body  = map[string]string{"order_id": "ord_8123", "carrier": "ups", "service_level": "ground"}
)

func api(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func with(field, value string) map[string]string {
	out := map[string]string{}
	for k, v := range body {
		out[k] = v
	}
	out[field] = value
	return out
}

func create(c *harness.HTTP, key string, b map[string]string, tenant string) *harness.Response {
	headers := []string{"Idempotency-Key", key}
	if tenant != "" {
		headers = append(headers, "X-Tenant-Id", tenant)
	}
	return c.Post("/v1/shipments", b, headers...)
}

func created(ctx *harness.Ctx, r *harness.Response, what string) string {
	ctx.Equal(r.Status, 201, "%s (%s); the status", what, r.Text())
	var s struct {
		ShipmentID string \`json:"shipment_id"\`
	}
	r.Decode(&s)
	return s.ShipmentID
}

func CheckRoute(ctx *harness.Ctx) {
	c := api(ctx)
	r := create(c, "k-1", body, "t-acme")
	shipmentID := created(ctx, r, "POST /v1/shipments")
	var got store.Shipment
	r.Decode(&got)
	ctx.Assert(got.Status == "label" && got.OrderID == "ord_8123", "a new shipment must answer status label for ord_8123, got %s", r.Text())
	saved := store.GetShipment(apiBg, shipmentID)
	ctx.Assert(saved != nil && saved.TenantID == "t-acme" && saved.Carrier == "ups", "the store holds %+v for %s, expected t-acme's ups shipment", saved, shipmentID)
}

func CheckValidate(ctx *harness.Ctx) {
	c := api(ctx)
	r := c.Post("/v1/shipments", body, "Idempotency-Key", "k-1")
	ctx.Equal(r.Status, 401, "a create without X-Tenant-Id; the status")
	r = create(c, "k-2", with("carrier", "upss"), "t-acme")
	ctx.Equal(r.Status, 422, "a create for carrier 'upss' (no partner has it) must be refused; ask registry.Lookup; the status")
	r = create(c, "k-3", with("service_level", "overnight"), "t-acme")
	ctx.Equal(r.Status, 400, "service_level 'overnight' (ground, express, freight); the status")
	r = create(c, "k-4", with("order_id", ""), "t-acme")
	ctx.Equal(r.Status, 400, "an empty order_id; the status")
	saved := ctx.Redis.Keys("order:*")
	ctx.Assert(len(saved) == 0, "refused creates still saved shipments: %q", saved)
	fedex := with("carrier", "fedex")
	fedex["service_level"] = "express"
	created(ctx, create(c, "k-5", fedex, "t-acme"), "a valid fedex express create")
}

func CheckSingleActive(ctx *harness.Ctx) {
	c := api(ctx)
	firstID := created(ctx, create(c, "k-1", body, "t-acme"), "the first create")
	second := create(c, "k-2", body, "t-acme")
	ctx.Equal(second.Status, 409, "a second shipment for ord_8123 while %s is live (%s); the status", firstID, second.Text())
	var conflict struct {
		Error      string \`json:"error"\`
		ShipmentID string \`json:"shipment_id"\`
	}
	second.Decode(&conflict)
	ctx.Assert(conflict.Error == "active_shipment_exists" && conflict.ShipmentID == firstID, "the 409 must name the live shipment (active_shipment_exists, %s), got %s", firstID, second.Text())
	ctx.Equal(ctx.Redis.LRange("order:t-acme:ord_8123", 0, -1), []string{firstID}, "the refused create must save nothing; the order's shipments")
	store.SetStatus(apiBg, firstID, "delivered", 100)
	created(ctx, create(c, "k-3", body, "t-acme"), "a create after the order's shipment was delivered (no longer live)")
}

func CheckIdempotencyKey(ctx *harness.Ctx) {
	c := api(ctx)
	first := create(c, "k-1", body, "t-acme")
	firstID := created(ctx, first, "the first create")
	replay := create(c, "k-1", body, "t-acme")
	ctx.Equal(replay.Status, 200, "a replay of Idempotency-Key k-1 must answer the recorded shipment (%s); the status", replay.Text())
	ctx.Equal(replay.JSON(), first.JSON(), "the replay must answer the recorded shipment")
	missing := c.Post("/v1/shipments", body, "X-Tenant-Id", "t-acme")
	ctx.Equal(missing.Status, 400, "a create without Idempotency-Key; the status")
	ctx.Equal(ctx.Redis.LRange("order:t-acme:ord_8123", 0, -1), []string{firstID}, "one create and its replay; the order's shipments")
	otherID := created(ctx, create(c, "k-1", body, "t-globex"), "another tenant's create with the same key")
	ctx.Assert(otherID != firstID, "another tenant's key k-1 answered t-acme's shipment: keys are scoped by tenant")
}

func CheckReplacement(ctx *harness.Ctx) {
	c := api(ctx)
	firstID := created(ctx, create(c, "k-1", body, "t-acme"), "the first create")
	store.SetStatus(apiBg, firstID, "cancelled", 100)
	second := create(c, "k-2", body, "t-acme")
	secondID := created(ctx, second, "a create after the order's shipment was cancelled")
	ctx.Assert(secondID != firstID, "the replacement reused the cancelled id %s: the carrier's scans for the voided label would land on it", firstID)
	var got store.Shipment
	second.Decode(&got)
	ctx.Equal(got.ReplacementOf, firstID, "the replacement must name the cancelled shipment; replacement_of")
	ctx.Equal(store.GetShipment(apiBg, firstID).Status, "cancelled", "the cancelled shipment's status")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "shipments/store.h"

using json = nlohmann::json;

namespace {

const json kBody = {{"order_id", "ord_8123"}, {"carrier", "ups"}, {"service_level", "ground"}};

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

json with(const std::string& field, const std::string& value) {
  json out = kBody;
  out[field] = value;
  return out;
}

harness::Response create(harness::HTTP& c, const std::string& key, const json& body, const std::string& tenant) {
  std::vector<std::string> headers = {"Content-Type", "application/json", "Idempotency-Key", key};
  if (!tenant.empty()) {
    headers.push_back("X-Tenant-Id");
    headers.push_back(tenant);
  }
  return c.Send("POST", "/v1/shipments", body.dump(), headers);
}

std::string created(harness::Ctx& ctx, const harness::Response& r, const std::string& what) {
  ctx.Equal(r.Status, 201, "%s (%s); the status", what, r.Text());
  return json::parse(r.Text()).value("shipment_id", "");
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = create(c, "k-1", kBody, "t-acme");
  const std::string shipment_id = created(ctx, r, "POST /v1/shipments");
  const json got = json::parse(r.Text());
  ctx.Assert(got.value("status", "") == "label" && got.value("order_id", "") == "ord_8123", "a new shipment must answer status label for ord_8123, got %s", r.Text());
  const auto saved = store::getShipment(shipment_id);
  ctx.Assert(saved && saved->tenant_id == "t-acme" && saved->carrier == "ups", "the store holds tenant %q carrier %q for %s, expected t-acme's ups shipment",
             saved ? saved->tenant_id : "", saved ? saved->carrier : "", shipment_id);
}

void CheckValidate(harness::Ctx& ctx) {
  auto c = api(ctx);
  auto r = c.Post("/v1/shipments", kBody.dump(), "Content-Type", "application/json", "Idempotency-Key", "k-1");
  ctx.Equal(r.Status, 401, "a create without X-Tenant-Id; the status");
  r = create(c, "k-2", with("carrier", "upss"), "t-acme");
  ctx.Equal(r.Status, 422, "a create for carrier 'upss' (no partner has it) must be refused; ask registry::lookup; the status");
  r = create(c, "k-3", with("service_level", "overnight"), "t-acme");
  ctx.Equal(r.Status, 400, "service_level 'overnight' (ground, express, freight); the status");
  r = create(c, "k-4", with("order_id", ""), "t-acme");
  ctx.Equal(r.Status, 400, "an empty order_id; the status");
  const auto saved = ctx.Redis.Keys("order:*");
  ctx.Assert(saved.empty(), "refused creates still saved shipments: %q", saved);
  json fedex = with("carrier", "fedex");
  fedex["service_level"] = "express";
  created(ctx, create(c, "k-5", fedex, "t-acme"), "a valid fedex express create");
}

void CheckSingleActive(harness::Ctx& ctx) {
  auto c = api(ctx);
  const std::string first_id = created(ctx, create(c, "k-1", kBody, "t-acme"), "the first create");
  const auto second = create(c, "k-2", kBody, "t-acme");
  ctx.Equal(second.Status, 409, "a second shipment for ord_8123 while %s is live (%s); the status", first_id, second.Text());
  const json conflict = json::parse(second.Text(), nullptr, false);
  ctx.Assert(conflict.is_object() && conflict.value("error", "") == "active_shipment_exists" && conflict.value("shipment_id", "") == first_id,
             "the 409 must name the live shipment (active_shipment_exists, %s), got %s", first_id, second.Text());
  ctx.Equal(ctx.Redis.LRange("order:t-acme:ord_8123", 0, -1), {first_id}, "the refused create must save nothing; the order's shipments");
  store::setStatus(first_id, "delivered", 100);
  created(ctx, create(c, "k-3", kBody, "t-acme"), "a create after the order's shipment was delivered (no longer live)");
}

void CheckIdempotencyKey(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto first = create(c, "k-1", kBody, "t-acme");
  const std::string first_id = created(ctx, first, "the first create");
  const auto replay = create(c, "k-1", kBody, "t-acme");
  ctx.Equal(replay.Status, 200, "a replay of Idempotency-Key k-1 must answer the recorded shipment (%s); the status", replay.Text());
  ctx.Equal(json::parse(replay.Text()), json::parse(first.Text()), "the replay must answer the recorded shipment");
  const auto missing = c.Post("/v1/shipments", kBody.dump(), "Content-Type", "application/json", "X-Tenant-Id", "t-acme");
  ctx.Equal(missing.Status, 400, "a create without Idempotency-Key; the status");
  ctx.Equal(ctx.Redis.LRange("order:t-acme:ord_8123", 0, -1), {first_id}, "one create and its replay; the order's shipments");
  const std::string other_id = created(ctx, create(c, "k-1", kBody, "t-globex"), "another tenant's create with the same key");
  ctx.Assert(other_id != first_id, "another tenant's key k-1 answered t-acme's shipment: keys are scoped by tenant");
}

void CheckReplacement(harness::Ctx& ctx) {
  auto c = api(ctx);
  const std::string first_id = created(ctx, create(c, "k-1", kBody, "t-acme"), "the first create");
  store::setStatus(first_id, "cancelled", 100);
  const auto second = create(c, "k-2", kBody, "t-acme");
  const std::string second_id = created(ctx, second, "a create after the order's shipment was cancelled");
  ctx.Assert(second_id != first_id, "the replacement reused the cancelled id %s: the carrier's scans for the voided label would land on it", first_id);
  ctx.Equal(json::parse(second.Text()).value("replacement_of", ""), first_id, "the replacement must name the cancelled shipment; replacement_of");
  ctx.Equal(store::getShipment(first_id)->status, "cancelled", "the cancelled shipment's status");
}
`,
  },
  debrief: `The order of the guards is the design. The cheap refusals (tenant, key, body, registry) cost nothing, and the idempotency lookup runs before the one-live-shipment rule because the replay of a create that succeeded is not a second shipment and must not read as a conflict. A cancelled label keeps its id for good, so the carrier's late scans for it can never land on the replacement; \`replacement_of\` is the link support follows from one to the other. What this step does not do: the shipment and its idempotency record are two writes, so a crash between them lets a retry create twice. A production service writes both in one transaction, expires the records after a day, and keeps a hash of the body to refuse a key reused with a different order.`,
};
