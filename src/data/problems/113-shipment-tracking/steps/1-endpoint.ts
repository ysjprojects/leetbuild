import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/shipments: one order, one live shipment',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'db', 'registry'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, reads
the body and returns a shipment, so the demo prints a tracking number and the happy path looks
complete. Three production contracts around it are broken. Review it like the service owner, fix
it, and prove the fix with the checks below.

Implement \`POST /v1/shipments\` with body
\`{"order_id": "ord_8123", "carrier": "ups", "service_level": "ground"}\`.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401** and a
  missing \`Idempotency-Key\` is **400**.
- \`order_id\` is a non-empty string and \`service_level\` is one of \`ground\`, \`express\`,
  \`freight\` (**400** otherwise). The \`carrier\` code must exist in the **partner registry**
  (\`registry.lookup\`): an unknown code is **422**, never a shipment whose label no carrier will
  ever scan.
- An order may have **one active shipment at a time**. When the order already has a shipment in
  \`label\`, \`in_transit\` or \`out_for_delivery\`, answer **409** with
  \`{"error": "active_shipment_exists", "shipment_id": "<the existing one>"}\`: the second label is
  never created and never charged.
- A **cancelled** shipment does not block a replacement, but the replacement is a **new shipment
  id** (\`new_shipment_id()\`) with \`replacement_of\` naming the cancelled one. A retry must never
  resurrect a cancelled shipment id — the label that id belongs to was voided at the carrier.
- A replay with the same \`Idempotency-Key\` returns the shipment created under that key (**200**)
  instead of creating a second one.

**Failure mode the checks target.** Three silent ways to charge twice or ship nothing. Without the
active check, a retried checkout creates a second label for the same parcel, and the carrier bills
for both. Without the registry lookup, the API accepts \`carrier: "ups"\` typed by a caller and the
label is born broken. Without idempotency keyed by \`(tenant, key)\`, a client retry after a timeout
creates the second label the active check was supposed to prevent — and after a cancellation, the
draft hands the replacement the voided id, so its first scan lands on a shipment the carrier has
already closed.`,
  sequence: {
    participants: ['Client', 'Shipment API', 'partner registry', 'shipments'],
    messages: [
      {from: 'Client', to: 'Shipment API', label: 'POST /v1/shipments · X-Tenant-Id · Idempotency-Key', kind: 'sync'},
      {from: 'Shipment API', to: 'partner registry', label: 'lookup("ups") before a label exists', kind: 'sync'},
      {from: 'partner registry', to: 'Shipment API', label: 'partner / none → 422', kind: 'reply'},
      {from: 'Shipment API', to: 'shipments', label: 'get_by_key(tenant, idem_key)', kind: 'sync'},
      {from: 'shipments', to: 'Shipment API', label: 'the stored shipment / none', kind: 'reply'},
      {from: 'Shipment API', to: 'shipments', label: 'active_for_order(tenant, order_id)', kind: 'sync'},
      {from: 'shipments', to: 'Shipment API', label: 'the live shipment / none', kind: 'reply'},
      {from: 'Shipment API', to: 'Shipment API', label: '409 {active_shipment_exists, shipment_id}', kind: 'sync'},
      {from: 'Shipment API', to: 'shipments', label: 'put_by_key · new_shipment_id() · replacement_of', kind: 'async'},
      {from: 'Shipment API', to: 'Client', label: '201 {shipment_id, status: label}', kind: 'reply'},
    ],
  },
  hints: [
    'Order the guards by cost: tenant, Idempotency-Key, body shape, service level, then the registry lookup — the lookup is the first one that can be a network call, so it runs after the cheap rejections. The idempotency lookup comes next: a replay must return the stored shipment before anyone asks whether the order already has one.',
    'The active check and the create are two different questions about the same order. `active_for_order(tenant, order_id)` answers the first — a shipment in `label`, `in_transit` or `out_for_delivery` means 409 with **that** shipment id, because the client needs the id it already has to poll it. The cancelled shipment answers a different question: it is the one being replaced, so it goes into `replacement_of` while the new shipment gets a fresh id.',
    '`Idempotency-Key` is what makes the 409 safe to return on a retry: the first call stored the shipment under `(tenant, key)`, so the replay returns it instead of re-running the registry and the active check. Without that store, a client that times out and retries can arrive after the first shipment was cancelled and quietly create another.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/shipments',
      detail:
        'Register the create route on `POST /v1/shipments`. The draft already answers this route, so this check passes on it — the four below are where it fails.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/shipments["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/shipments['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/shipments"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"shipments"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/shipments"/]},
      },
    },
    {
      id: 'validate',
      title: 'Authenticates the tenant and validates the carrier against the registry',
      detail:
        'A missing tenant is **401**, a missing `Idempotency-Key` or a service level outside the allowed set is **400**, and a carrier code the partner registry does not know is **422**. The draft accepts any carrier string, so labels are created for carriers that will never scan them.',
      match: {
        python: {
          all: [/status_code\s*=\s*401/, /status_code\s*=\s*400/, /status_code\s*=\s*422/, /registry\.lookup\(/],
        },
        typescript: {all: [/code\(\s*401\s*\)/, /code\(\s*400\s*\)/, /code\(\s*422\s*\)/, /registry\.lookup\(/]},
        go: {all: [/StatusUnauthorized/, /StatusBadRequest/, /StatusUnprocessableEntity/, /registry\.Lookup\(/]},
        scala: {
          all: [
            /StatusCodes\.Unauthorized/,
            /StatusCodes\.BadRequest/,
            /StatusCodes\.UnprocessableEntity/,
            /registry\.lookup\(/,
          ],
        },
        cpp: {all: [/\b401\b/, /\b400\b/, /\b422\b/, /registry\.lookup\(/]},
      },
    },
    {
      id: 'single-active',
      title: 'Answers 409 with the existing shipment for a second active shipment',
      detail:
        'A second shipment for an order that already has one in `label`, `in_transit` or `out_for_delivery` is **409** with `active_shipment_exists` and the existing shipment id, decided by `active_for_order`. The draft creates the second label and bills it.',
      match: {
        python: {all: [/status_code\s*=\s*409/, /active_shipment_exists/, /store\.active_for_order\(/]},
        typescript: {all: [/code\(\s*409\s*\)/, /active_shipment_exists/, /store\.activeForOrder\(/]},
        go: {all: [/StatusConflict/, /active_shipment_exists/, /store\.ActiveForOrder\(/]},
        scala: {all: [/StatusCodes\.Conflict/, /active_shipment_exists/, /store\.activeForOrder\(/]},
        cpp: {all: [/\b409\b/, /active_shipment_exists/, /store\.activeForOrder\(/]},
      },
    },
    {
      id: 'idempotency-key',
      title: 'Keys creations by (tenant, Idempotency-Key)',
      detail:
        '`Idempotency-Key` is required and the shipment is stored under `(tenant, key)`; a replay returns the stored shipment with **200** instead of creating a second one. The draft ignores the header entirely.',
      match: {
        python: {all: [/Idempotency-Key/, /store\.get_by_key\(/, /store\.put_by_key\(/]},
        typescript: {all: [/idempotency-key/, /store\.getByKey\(/, /store\.putByKey\(/]},
        go: {all: [/Idempotency-Key/, /store\.GetByKey\(/, /store\.PutByKey\(/]},
        scala: {all: [/Idempotency-Key/, /store\.getByKey\(/, /store\.putByKey\(/]},
        cpp: {all: [/Idempotency-Key/, /store\.getByKey\(/, /store\.putByKey\(/]},
      },
    },
    {
      id: 'replacement',
      title: 'Replaces a cancelled shipment with a new id',
      detail:
        'A cancelled shipment does not block a replacement, but the replacement carries a fresh `new_shipment_id()` and records `replacement_of` instead of reusing the voided id. The draft hands the cancelled shipment id to the replacement, so its first scan lands on a closed shipment.',
      match: {
        python: {all: [/CANCELLED/, /replacement_of/, /new_shipment_id\(\)/]},
        typescript: {all: [/CANCELLED/, /replacement_of/, /newShipmentId\(\)/]},
        go: {all: [/cancelledStatus/, /replacement_of/, /newShipmentID\(\)/]},
        scala: {all: [/Cancelled/, /replacement_of/, /newShipmentId\(\)/]},
        cpp: {all: [/kCancelled/, /replacement_of/, /newShipmentId\(\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("shipments")


class CreateShipment(BaseModel):
    order_id: str
    carrier: str
    service_level: str


class PartnerRegistry:
    def lookup(self, carrier: str) -> dict | None:
        """The partner record for a carrier code, or None when the code is unknown."""
        raise NotImplementedError


class ShipmentStore:
    def last_for_order(self, tenant: str, order_id: str) -> dict | None:
        """The order's most recent shipment, cancelled or not."""
        raise NotImplementedError

    def put(self, tenant: str, shipment: dict) -> None:
        """Store the shipment for the order."""
        raise NotImplementedError


registry = PartnerRegistry()
store = ShipmentStore()


@app.post("/v1/shipments")
def create_shipment(body: CreateShipment) -> JSONResponse:
    # TODO: this draft never checks the tenant, the Idempotency-Key, the carrier registry or the
    # service level; it lets an order hold a second active shipment, and on a retry it reuses the
    # id of the order's previous (possibly cancelled) shipment instead of minting a new one.
    previous = store.last_for_order("", body.order_id)
    shipment = {
        "shipment_id": (previous or {}).get("shipment_id") or body.order_id,
        "order_id": body.order_id,
        "carrier": body.carrier,
        "service_level": body.service_level,
        "status": "label",
    }
    store.put("", shipment)
    logger.info("shipment created order=%s", body.order_id)
    return JSONResponse(shipment, status_code=201)
`,
      solution: `import logging
import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("shipments")

SERVICE_LEVELS = {"ground", "express", "freight"}
CANCELLED = "cancelled"


class CreateShipment(BaseModel):
    order_id: str
    carrier: str
    service_level: str


class PartnerRegistry:
    def lookup(self, carrier: str) -> dict | None:
        """The partner record for a carrier code, or None when the code is unknown."""
        raise NotImplementedError


class ShipmentStore:
    def get_by_key(self, tenant: str, idem_key: str) -> dict | None:
        """The shipment created under (tenant, idem_key), if any."""
        raise NotImplementedError

    def put_by_key(self, tenant: str, idem_key: str, shipment: dict) -> None:
        """Store the shipment under (tenant, idem_key)."""
        raise NotImplementedError

    def active_for_order(self, tenant: str, order_id: str) -> dict | None:
        """The order's one live shipment: the one still in label / in_transit / out_for_delivery."""
        raise NotImplementedError

    def last_for_order(self, tenant: str, order_id: str) -> dict | None:
        """The order's most recent shipment, cancelled or not."""
        raise NotImplementedError


registry = PartnerRegistry()
store = ShipmentStore()


def new_shipment_id() -> str:
    return f"shp_{uuid.uuid4().hex}"


@app.post("/v1/shipments")
def create_shipment(
    body: CreateShipment,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    idem_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if idem_key is None or idem_key == "":
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    if body.order_id == "":
        raise HTTPException(status_code=400, detail="order_id is required")
    if body.service_level not in SERVICE_LEVELS:
        raise HTTPException(status_code=400, detail="unknown service level")
    if registry.lookup(body.carrier) is None:
        raise HTTPException(status_code=422, detail="unknown carrier code")

    stored = store.get_by_key(tenant, idem_key)
    if stored is not None:
        return JSONResponse(stored, status_code=200)

    active = store.active_for_order(tenant, body.order_id)
    if active is not None:
        return JSONResponse(
            {"error": "active_shipment_exists", "shipment_id": active["shipment_id"]},
            status_code=409,
        )

    previous = store.last_for_order(tenant, body.order_id)
    replaced = previous if previous is not None and previous["status"] == CANCELLED else None
    shipment = {
        "shipment_id": new_shipment_id(),
        "order_id": body.order_id,
        "carrier": body.carrier,
        "service_level": body.service_level,
        "status": "label",
        "replacement_of": replaced["shipment_id"] if replaced is not None else None,
    }
    store.put_by_key(tenant, idem_key, shipment)
    logger.info(
        "shipment created tenant=%s order=%s shipment=%s replacement_of=%s",
        tenant,
        body.order_id,
        shipment["shipment_id"],
        shipment["replacement_of"],
    )
    return JSONResponse(shipment, status_code=201)
`,
    },
    typescript: {
      starter: `/** POST /v1/shipments: a model-generated draft that lets an order hold two labels. */
import Fastify from 'fastify';

export const app = Fastify();

interface CreateShipment {
  order_id: string;
  carrier: string;
  service_level: string;
}

class PartnerRegistry {
  /** The partner record for a carrier code, or null when the code is unknown. */
  async lookup(carrier: string): Promise<Record<string, unknown> | null> {
    throw new Error('not implemented');
  }
}

class ShipmentStore {
  /** The order's most recent shipment, cancelled or not. */
  async lastForOrder(tenant: string, orderId: string): Promise<{shipment_id: string} | null> {
    throw new Error('not implemented');
  }

  async put(tenant: string, shipment: Record<string, unknown>): Promise<void> {
    throw new Error('not implemented');
  }
}

const registry = new PartnerRegistry();
const store = new ShipmentStore();

app.post('/v1/shipments', async (request, reply) => {
  // TODO: this draft never checks the tenant, the Idempotency-Key, the carrier registry or the
  // service level; it lets an order hold a second active shipment, and on a retry it reuses the
  // id of the order's previous (possibly cancelled) shipment instead of minting a new one.
  const body = request.body as CreateShipment;
  const previous = await store.lastForOrder('', body.order_id);
  const shipment = {
    shipment_id: previous?.shipment_id ?? body.order_id,
    order_id: body.order_id,
    carrier: body.carrier,
    service_level: body.service_level,
    status: 'label',
  };
  await store.put('', shipment);
  request.log.info({order_id: body.order_id}, 'shipment created');
  return reply.code(201).send(shipment);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/shipments: one live shipment per order, idempotent, carrier checked. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

export const app = Fastify();

const SERVICE_LEVELS: Record<string, true> = {ground: true, express: true, freight: true};
const CANCELLED = 'cancelled';

interface CreateShipment {
  order_id: string;
  carrier: string;
  service_level: string;
}

class PartnerRegistry {
  /** The partner record for a carrier code, or null when the code is unknown. */
  async lookup(carrier: string): Promise<Record<string, unknown> | null> {
    throw new Error('not implemented');
  }
}

class ShipmentStore {
  /** The shipment created under (tenant, idemKey), if any. */
  async getByKey(tenant: string, idemKey: string): Promise<Record<string, unknown> | null> {
    throw new Error('not implemented');
  }

  async putByKey(tenant: string, idemKey: string, shipment: Record<string, unknown>): Promise<void> {
    throw new Error('not implemented');
  }

  /** The order's one live shipment: the one still in label / in_transit / out_for_delivery. */
  async activeForOrder(tenant: string, orderId: string): Promise<{shipment_id: string} | null> {
    throw new Error('not implemented');
  }

  /** The order's most recent shipment, cancelled or not. */
  async lastForOrder(tenant: string, orderId: string): Promise<Record<string, unknown> | null> {
    throw new Error('not implemented');
  }
}

const registry = new PartnerRegistry();
const store = new ShipmentStore();

function newShipmentId(): string {
  return 'shp_' + randomUUID().replace(/-/g, '');
}

app.post('/v1/shipments', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '')
    return reply.code(400).send({error: 'Idempotency-Key is required'});

  const body = request.body as Partial<CreateShipment> | null;
  if (body === null || typeof body !== 'object' || typeof body.order_id !== 'string' || body.order_id === '')
    return reply.code(400).send({error: 'order_id is required'});
  if (body.service_level === undefined || SERVICE_LEVELS[body.service_level] !== true)
    return reply.code(400).send({error: 'unknown service level'});
  if ((await registry.lookup(body.carrier as string)) === null)
    return reply.code(422).send({error: 'unknown carrier code'});

  const stored = await store.getByKey(tenant, idemKey);
  if (stored !== null) return reply.code(200).send(stored);

  const active = await store.activeForOrder(tenant, body.order_id);
  if (active !== null)
    return reply.code(409).send({error: 'active_shipment_exists', shipment_id: active.shipment_id});

  const previous = await store.lastForOrder(tenant, body.order_id);
  const replaced = previous !== null && previous.status === CANCELLED ? previous : null;
  const shipment = {
    shipment_id: newShipmentId(),
    order_id: body.order_id,
    carrier: body.carrier,
    service_level: body.service_level,
    status: 'label',
    replacement_of: replaced === null ? null : replaced.shipment_id,
  };
  await store.putByKey(tenant, idemKey, shipment);
  request.log.info({tenant, order_id: body.order_id, shipment_id: shipment.shipment_id}, 'shipment created');
  return reply.code(201).send(shipment);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"
)

type createShipment struct {
	OrderID      string \`json:"order_id"\`
	Carrier      string \`json:"carrier"\`
	ServiceLevel string \`json:"service_level"\`
}

type partnerRegistry struct{}

func (r *partnerRegistry) Lookup(carrier string) (map[string]any, error) {
	return nil, nil
}

type shipmentStore struct{}

// LastForOrder returns the order's most recent shipment, cancelled or not.
func (s *shipmentStore) LastForOrder(tenant, orderID string) (map[string]any, error) {
	return nil, nil
}

func (s *shipmentStore) Put(tenant string, shipment map[string]any) error {
	return nil
}

var (
	registry = &partnerRegistry{}
	store    = &shipmentStore{}
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func createShipmentRoute(rw http.ResponseWriter, r *http.Request) {
	// TODO: this draft never checks the tenant, the Idempotency-Key, the carrier registry or the
	// service level; it lets an order hold a second active shipment, and on a retry it reuses the
	// id of the order's previous (possibly cancelled) shipment instead of minting a new one.
	var body createShipment
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	previous, _ := store.LastForOrder("", body.OrderID)
	shipmentID := body.OrderID
	if previous != nil {
		shipmentID, _ = previous["shipment_id"].(string)
	}
	shipment := map[string]any{
		"shipment_id":   shipmentID,
		"order_id":      body.OrderID,
		"carrier":       body.Carrier,
		"service_level": body.ServiceLevel,
		"status":        "label",
	}
	_ = store.Put("", shipment)
	log.Printf("shipment created order=%s", body.OrderID)
	writeJSON(rw, http.StatusCreated, shipment)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/shipments", createShipmentRoute)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
)

const cancelledStatus = "cancelled"

var serviceLevels = map[string]bool{"ground": true, "express": true, "freight": true}

type createShipment struct {
	OrderID      string \`json:"order_id"\`
	Carrier      string \`json:"carrier"\`
	ServiceLevel string \`json:"service_level"\`
}

type partnerRegistry struct{}

func (r *partnerRegistry) Lookup(carrier string) (map[string]any, error) {
	return nil, nil
}

type shipmentStore struct{}

// GetByKey returns the shipment created under (tenant, idemKey), if any.
func (s *shipmentStore) GetByKey(tenant, idemKey string) (map[string]any, error) {
	return nil, nil
}

func (s *shipmentStore) PutByKey(tenant, idemKey string, shipment map[string]any) error {
	return nil
}

// ActiveForOrder returns the order's one live shipment: the one still in
// label / in_transit / out_for_delivery.
func (s *shipmentStore) ActiveForOrder(tenant, orderID string) (map[string]any, error) {
	return nil, nil
}

// LastForOrder returns the order's most recent shipment, cancelled or not.
func (s *shipmentStore) LastForOrder(tenant, orderID string) (map[string]any, error) {
	return nil, nil
}

var (
	registry = &partnerRegistry{}
	store    = &shipmentStore{}
)

func newShipmentID() string {
	buf := make([]byte, 16)
	_, _ = rand.Read(buf)
	return "shp_" + hex.EncodeToString(buf)
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func createShipmentRoute(rw http.ResponseWriter, r *http.Request) {
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
	var body createShipment
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if body.OrderID == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "order_id is required"})
		return
	}
	if !serviceLevels[body.ServiceLevel] {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "unknown service level"})
		return
	}
	partner, err := registry.Lookup(body.Carrier)
	if err != nil || partner == nil {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "unknown carrier code"})
		return
	}
	stored, err := store.GetByKey(tenant, idemKey)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if stored != nil {
		writeJSON(rw, http.StatusOK, stored)
		return
	}
	active, err := store.ActiveForOrder(tenant, body.OrderID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if active != nil {
		writeJSON(rw, http.StatusConflict, map[string]any{
			"error":       "active_shipment_exists",
			"shipment_id": active["shipment_id"],
		})
		return
	}
	previous, err := store.LastForOrder(tenant, body.OrderID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	shipment := map[string]any{
		"shipment_id":   newShipmentID(),
		"order_id":      body.OrderID,
		"carrier":       body.Carrier,
		"service_level": body.ServiceLevel,
		"status":        "label",
		"replacement_of": nil,
	}
	if previous != nil && previous["status"] == cancelledStatus {
		shipment["replacement_of"] = previous["shipment_id"]
	}
	if err := store.PutByKey(tenant, idemKey, shipment); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("shipment created tenant=%s order=%s shipment=%s", tenant, body.OrderID, shipment["shipment_id"])
	writeJSON(rw, http.StatusCreated, shipment)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/shipments", createShipmentRoute)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
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
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class CreateShipment(order_id: String, carrier: String, service_level: String)

class PartnerRegistry {
  /** The partner record for a carrier code, or None when the code is unknown. */
  def lookup(carrier: String): Option[Map[String, String]] = None
}

object PartnerRegistry {
  def open(): PartnerRegistry = new PartnerRegistry
}

class ShipmentStore {
  /** The order's most recent shipment, cancelled or not. */
  def lastForOrder(tenant: String, orderId: String): Option[Map[String, String]] = None

  def put(tenant: String, shipment: Map[String, String]): Unit = ()
}

object ShipmentStore {
  def open(): ShipmentStore = new ShipmentStore
}

object ShipmentApi {
  implicit val system: ActorSystem = ActorSystem("shipments")
  implicit val createFormat: RootJsonFormat[CreateShipment] = jsonFormat3(CreateShipment)

  val registry = PartnerRegistry.open()
  val store = ShipmentStore.open()

  val route: Route =
    path("v1" / "shipments") {
      post {
        entity(as[CreateShipment]) { body =>
          // TODO: this draft never checks the tenant, the Idempotency-Key, the carrier registry or
          // the service level; it lets an order hold a second active shipment, and on a retry it
          // reuses the id of the order's previous (possibly cancelled) shipment.
          val previous = store.lastForOrder("", body.order_id)
          val shipmentId = previous.flatMap(_.get("shipment_id")).getOrElse(body.order_id)
          val shipment = Map(
            "shipment_id" -> shipmentId,
            "order_id" -> body.order_id,
            "carrier" -> body.carrier,
            "service_level" -> body.service_level,
            "status" -> "label"
          )
          store.put("", shipment)
          system.log.info(s"shipment created order=" + body.order_id)
          complete(StatusCodes.Created, shipment)
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
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class CreateShipment(order_id: String, carrier: String, service_level: String)

class PartnerRegistry {
  /** The partner record for a carrier code, or None when the code is unknown. */
  def lookup(carrier: String): Option[Map[String, String]] = None
}

object PartnerRegistry {
  def open(): PartnerRegistry = new PartnerRegistry
}

class ShipmentStore {
  /** The shipment created under (tenant, idemKey), if any. */
  def getByKey(tenant: String, idemKey: String): Option[Map[String, String]] = None

  def putByKey(tenant: String, idemKey: String, shipment: Map[String, String]): Unit = ()

  /** The order's one live shipment: the one still in label / in_transit / out_for_delivery. */
  def activeForOrder(tenant: String, orderId: String): Option[Map[String, String]] = None

  /** The order's most recent shipment, cancelled or not. */
  def lastForOrder(tenant: String, orderId: String): Option[Map[String, String]] = None
}

object ShipmentStore {
  def open(): ShipmentStore = new ShipmentStore
}

object ShipmentApi {
  implicit val system: ActorSystem = ActorSystem("shipments")
  implicit val createFormat: RootJsonFormat[CreateShipment] = jsonFormat3(CreateShipment)

  val ServiceLevels = Set("ground", "express", "freight")
  val Cancelled = "cancelled"

  val registry = PartnerRegistry.open()
  val store = ShipmentStore.open()

  def newShipmentId(): String = "shp_" + UUID.randomUUID().toString.replace("-", "")

  val route: Route =
    path("v1" / "shipments") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          optionalHeaderValueByName("Idempotency-Key") { idemOpt =>
            entity(as[CreateShipment]) { body =>
              if (!tenantOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
              } else if (!idemOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.BadRequest, """{"error":"Idempotency-Key is required"}""")
              } else if (body.order_id.isEmpty || !ServiceLevels.contains(body.service_level)) {
                complete(StatusCodes.BadRequest, """{"error":"invalid order_id or service_level"}""")
              } else if (registry.lookup(body.carrier).isEmpty) {
                complete(StatusCodes.UnprocessableEntity, """{"error":"unknown carrier code"}""")
              } else {
                val tenant = tenantOpt.get
                val idemKey = idemOpt.get
                store.getByKey(tenant, idemKey) match {
                  case Some(stored) =>
                    complete(StatusCodes.OK, stored)
                  case None =>
                    store.activeForOrder(tenant, body.order_id) match {
                      case Some(active) =>
                        complete(
                          StatusCodes.Conflict,
                          """{"error":"active_shipment_exists","shipment_id":"""" + active
                            .getOrElse("shipment_id", "") + """"}"""
                        )
                      case None =>
                        val replaced = store
                          .lastForOrder(tenant, body.order_id)
                          .filter(_.getOrElse("status", "") == Cancelled)
                        val shipment = Map(
                          "shipment_id" -> newShipmentId(),
                          "order_id" -> body.order_id,
                          "carrier" -> body.carrier,
                          "service_level" -> body.service_level,
                          "status" -> "label",
                          "replacement_of" -> replaced.flatMap(_.get("shipment_id")).getOrElse("")
                        )
                        store.putByKey(tenant, idemKey, shipment)
                        system.log.info(
                          "shipment created tenant=" + tenant + " order=" + body.order_id +
                            " shipment=" + shipment("shipment_id") + " replacement_of=" + shipment("replacement_of")
                        )
                        complete(StatusCodes.Created, shipment)
                    }
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

#include <iostream>
#include <optional>
#include <string>

using json = nlohmann::json;

struct PartnerRegistry {
  std::optional<json> lookup(const std::string& carrier);
};

struct ShipmentStore {
  std::optional<json> lastForOrder(const std::string& tenant, const std::string& orderId);
  void put(const std::string& tenant, const json& shipment);
};

PartnerRegistry registry;
ShipmentStore store;

int main() {
  httplib::Server svr;

  svr.Post("/v1/shipments", [](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this draft never checks the tenant, the Idempotency-Key, the carrier registry or the
    // service level; it lets an order hold a second active shipment, and on a retry it reuses the
    // id of the order's previous (possibly cancelled) shipment instead of minting a new one.
    const auto orderId = body.value("order_id", std::string());
    const auto previous = store.lastForOrder("", orderId);
    json shipment = {
        {"shipment_id", previous ? previous->value("shipment_id", orderId) : orderId},
        {"order_id", orderId},
        {"carrier", body.value("carrier", std::string())},
        {"service_level", body.value("service_level", std::string())},
        {"status", "label"},
    };
    store.put("", shipment);
    std::cerr << "shipment created order=" << orderId << "\\n";
    res.status = 201;
    res.set_content(shipment.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <optional>
#include <set>
#include <string>

using json = nlohmann::json;

const std::set<std::string> kServiceLevels = {"ground", "express", "freight"};
const std::string kCancelled = "cancelled";

struct PartnerRegistry {
  std::optional<json> lookup(const std::string& carrier);
};

struct ShipmentStore {
  std::optional<json> getByKey(const std::string& tenant, const std::string& idemKey);
  void putByKey(const std::string& tenant, const std::string& idemKey, const json& shipment);
  std::optional<json> activeForOrder(const std::string& tenant, const std::string& orderId);
  std::optional<json> lastForOrder(const std::string& tenant, const std::string& orderId);
};

PartnerRegistry registry;
ShipmentStore store;
std::string newShipmentId();

int main() {
  httplib::Server svr;

  svr.Post("/v1/shipments", [](const httplib::Request& req, httplib::Response& res) {
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
    if (!body.is_object() || !body.contains("order_id")) {
      res.status = 400;
      res.set_content(R"({"error":"order_id is required"})", "application/json");
      return;
    }
    const auto orderId = body["order_id"].get<std::string>();
    const auto serviceLevel = body.value("service_level", std::string());
    if (orderId.empty() || kServiceLevels.count(serviceLevel) == 0) {
      res.status = 400;
      res.set_content(R"({"error":"invalid order_id or service_level"})", "application/json");
      return;
    }
    if (!registry.lookup(body.value("carrier", std::string()))) {
      res.status = 422;
      res.set_content(R"({"error":"unknown carrier code"})", "application/json");
      return;
    }
    const auto stored = store.getByKey(tenant, idemKey);
    if (stored) {
      res.status = 200;
      res.set_content(stored->dump(), "application/json");
      return;
    }
    const auto active = store.activeForOrder(tenant, orderId);
    if (active) {
      res.status = 409;
      res.set_content(
          json{{"error", "active_shipment_exists"}, {"shipment_id", active->value("shipment_id", "")}}.dump(),
          "application/json");
      return;
    }
    const auto previous = store.lastForOrder(tenant, orderId);
    json shipment = {
        {"shipment_id", newShipmentId()},
        {"order_id", orderId},
        {"carrier", body.value("carrier", std::string())},
        {"service_level", serviceLevel},
        {"status", "label"},
        {"replacement_of", nullptr},
    };
    if (previous && previous->value("status", std::string()) == kCancelled) {
      shipment["replacement_of"] = (*previous)["shipment_id"];
    }
    store.putByKey(tenant, idemKey, shipment);
    std::cerr << "shipment created tenant=" << tenant << " order=" << orderId
              << " shipment=" << shipment["shipment_id"] << "\\n";
    res.status = 201;
    res.set_content(shipment.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The interviewer is reviewing a generated handler at the trust boundary. The draft reads fine because the demo sends well-formed requests from one tenant and never retries. Four separate contracts are being checked: authentication (the tenant is never optional), the partner registry as the authority on carrier codes (a caller cannot invent a partner), the one-active-shipment invariant that protects the customer from paying for two labels, and idempotency keyed by \`(tenant, key)\` so a client retry cannot slip past that invariant. The subtle one is the cancelled shipment: the naive fix reuses the order's last id, but that id was voided at the carrier, so the replacement must be a new shipment that names its predecessor in \`replacement_of\`. Real platforms add per-carrier credential checks, label voiding as an explicit API call, and a shipment ledger that ties every replacement back to the claim that caused it.`,
};
