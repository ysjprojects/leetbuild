import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/shipments/{id}: customer view versus operations view',
  concept: 'http',
  file: 'read',
  focus: ['client', 'ops', 'api', 'redis', 'projection'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: the tracking page fetches a
shipment and renders a status and an ETA, so the demo looks finished. It serves any shipment to any
caller, it hands internal flags and the carrier's error payload to customers, and it trusts a stored
\`status\` field that is written when the label is created. Review it, fix it, and prove the fix with
the checks below.

Implement \`GET /v1/shipments/{shipment_id}\`, the read the tracking page and the operations console
both call:

- The tenant comes from \`X-Tenant-Id\` (**401** when missing). A shipment that does not exist **or
  belongs to another tenant** is **404** — never 403: a customer must not be able to probe which
  shipment ids exist.
- The customer view is \`{"shipment_id", "status", "timeline", "estimated_delivery", "delivered"}\`:
  the derived status, the scans in chronological order at **city granularity**, and the ETA.
- \`status\` is derived from the **scans** by \`status_from_scans()\`, not read from the stored
  status field: \`delivered\` requires a **delivered scan**. A shipment whose label was just created
  is \`label\`, however the stored field was initialized — and if the scans and the stored field
  disagree, the scans win.
- Operations, presenting \`X-Ops-Token\` equal to \`OPS_TOKEN\`, get the same view **plus**
  \`poll_health\`, \`reconciliation\` and \`carrier_error\` — the fields \`operations_view()\` adds.
  Customers' responses come from \`customer_view()\`, which has no access to them: internal
  reconciliation flags and carrier error payloads are never customer-visible.
- Log the read with the shipment id and whether it is the operations view; never the token.

**Failure mode the checks target.** Three silent leaks. Without the tenant check, any customer can
read any shipment id, and 403-versus-404 differences tell them which ids are real. Deriving
\`delivered\` from a stored field means a shipment can report delivered before any carrier has
scanned it. And returning carrier error payloads and reconciliation flags to customers exposes
internal carrier integrations and the platform's own disagreements with them — the same fields that
make the console useful make the customer API a liability.`,
  sequence: {
    participants: ['Customer', 'Operations console', 'Shipment API', 'Redis'],
    messages: [
      {from: 'Customer', to: 'Shipment API', label: 'GET /v1/shipments/shp_8f · X-Tenant-Id', kind: 'sync'},
      {from: 'Shipment API', to: 'Redis', label: 'load the shipment and its scans', kind: 'sync'},
      {from: 'Redis', to: 'Shipment API', label: 'scans + stored status', kind: 'reply'},
      {from: 'Shipment API', to: 'Shipment API', label: 'foreign or unknown → 404, not 403', kind: 'sync'},
      {from: 'Shipment API', to: 'Shipment API', label: 'status_from_scans() wins over the stored field', kind: 'sync'},
      {from: 'Shipment API', to: 'Customer', label: '200 {status, timeline, estimated_delivery}', kind: 'reply'},
      {from: 'Operations console', to: 'Shipment API', label: 'GET /v1/shipments/shp_8f · X-Ops-Token', kind: 'sync'},
      {
        from: 'Shipment API',
        to: 'Operations console',
        label: '+ {poll_health, reconciliation, carrier_error}',
        kind: 'reply',
      },
    ],
  },
  hints: [
    'Scope the read at the loader: `load_shipment(shipment_id, tenant)` returns 404 when the shipment is missing **or** its `tenant_id` is someone else’s. Answering 403 for the other tenant’s shipment confirms the id exists, so the refusal must be the same shape as "no such shipment".',
    'The stored status field is a cache of the scans, and the scans are the truth: `status_from_scans()` walks the shipment’s scans in order and returns the furthest one, so a shipment with no scans is `label` and `delivered` requires an actual delivered scan. A field written at label creation can say anything.',
    'Build two payloads from one read: `customer_view(shipment)` returns the timeline, the derived status and the ETA, and `operations_view(shipment, view)` adds `poll_health`, `reconciliation` and `carrier_error` for a caller presenting `X-Ops-Token`. Keeping the customer builder free of those fields is what makes the leak impossible rather than unlikely.',
  ],
  checks: [
    {
      id: 'read-route',
      title: 'Serves GET /v1/shipments/{id} with the timeline and an ETA',
      detail:
        'The read is registered on `GET /v1/shipments/{id}` (the language’s path-parameter route) and its response carries the status and `estimated_delivery` for that shipment. The draft already answers this route, so this check passes on it — the four below are where it fails.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/shipments\/\{shipment_id\}["']/, /"status"/, /"estimated_delivery"/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/shipments\/:shipmentId['"]/, /status/, /estimated_delivery/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/shipments\/\{id\}"/, /"status"/, /"estimated_delivery"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"shipments"\s*\/\s*Segment\s*\)/, /\bget\s*\{/, /estimated_delivery/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/shipments\//, /"estimated_delivery"/]},
      },
    },
    {
      id: 'delivered-scan',
      title: 'Derives delivered from a delivered scan',
      detail:
        'The status comes from `status_from_scans()`, which walks the shipment’s scans, so `delivered` requires a delivered scan and a fresh label reads `label`. The draft returns the stored status field, which reports delivered when only the label was created.',
      match: {
        python: {all: [/def status_from_scans\(/, /DELIVERED/]},
        typescript: {all: [/function statusFromScans\(/, /DELIVERED/]},
        go: {all: [/func statusFromScans\(/, /deliveredStatus/]},
        scala: {all: [/def statusFromScans\(/, /Delivered/]},
        cpp: {all: [/statusFromScans\(/, /kDelivered/]},
      },
    },
    {
      id: 'tenant-scope',
      title: 'Answers 404 for a shipment of another tenant',
      detail:
        '`load_shipment(shipment_id, tenant)` returns **404** when the shipment is missing or its `tenant_id` is not the caller’s — the same refusal in both cases, so a foreign id cannot be probed. The draft serves any shipment to any caller.',
      match: {
        python: {all: [/status_code\s*=\s*404/, /def load_shipment\(/, /tenant_id/]},
        typescript: {all: [/\b404\b/, /function loadShipment\(/, /tenant_id/]},
        go: {all: [/StatusNotFound/, /func loadShipment\(/, /tenant_id/]},
        scala: {all: [/StatusCodes\.NotFound/, /def loadShipment\(/, /tenant_id/]},
        cpp: {all: [/\b404\b/, /loadShipment\(/, /tenant_id/]},
      },
    },
    {
      id: 'ops-view',
      title: 'Adds poll health and reconciliation only for operations',
      detail:
        'A caller presenting `X-Ops-Token` equal to `OPS_TOKEN` gets `operations_view()`, which adds the poll health and the reconciliation flag. The draft exposes nothing to operators and everything to customers.',
      match: {
        python: {all: [/X-Ops-Token/, /OPS_TOKEN/, /def operations_view\(/]},
        typescript: {all: [/x-ops-token/, /OPS_TOKEN/, /function operationsView\(/]},
        go: {all: [/X-Ops-Token/, /opsToken/, /func operationsView\(/]},
        scala: {all: [/X-Ops-Token/, /OpsToken/, /def operationsView\(/]},
        cpp: {all: [/X-Ops-Token/, /kOpsToken/, /operationsView\(/]},
      },
    },
    {
      id: 'no-error-leak',
      title: 'Never hands carrier errors or reconciliation flags to customers',
      detail:
        'The carrier’s error payload and the internal reconciliation flag are built in `operations_view()`; `customer_view()` never touches them, so a customer response cannot contain them. The draft returns both to every caller.',
      match: {
        python: {all: [/operations_view\(/, /carrier_error/], none: [/customer_view\([\s\S]{0,200}?carrier_error/]},
        typescript: {all: [/operationsView\(/, /carrier_error/], none: [/customerView\([\s\S]{0,200}?carrier_error/]},
        go: {all: [/operationsView\(/, /carrier_error/], none: [/customerView\([\s\S]{0,200}?carrier_error/]},
        scala: {all: [/operationsView\(/, /carrier_error/], none: [/customerView\([\s\S]{0,200}?carrier_error/]},
        cpp: {all: [/operationsView\(/, /carrier_error/], none: [/customerView\([\s\S]{0,200}?carrier_error/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("shipment-read")


class ShipmentRead:
    def get(self, shipment_id: str) -> dict | None:
        """The stored shipment: its status field, its scans, its poll health, its flags."""
        raise NotImplementedError


store = ShipmentRead()


@app.get("/v1/shipments/{shipment_id}")
def read_shipment(shipment_id: str) -> JSONResponse:
    # TODO: this draft serves any shipment to any caller, hands the internal reconciliation flag and
    # the carrier's error payload to customers, and reports the stored status as delivered when only
    # a label was created. Scope the read to the tenant with a 404, derive the status from the scans,
    # and keep poll health, the reconciliation flag and carrier errors in the operations view.
    shipment = store.get(shipment_id) or {}
    return JSONResponse(
        {
            "shipment_id": shipment_id,
            "status": shipment.get("status", "delivered"),
            "estimated_delivery": shipment.get("estimated_delivery"),
            "reconciliation": shipment.get("reconciliation"),
            "carrier_error": shipment.get("carrier_error"),
        },
        status_code=200,
    )
`,
      solution: `import logging

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("shipment-read")

OPS_TOKEN = "ops-secret"
DELIVERED = "delivered"
SIMPLIFIED = {
    "label": "label_created",
    "in_transit": "in_transit",
    "out_for_delivery": "out_for_delivery",
    "delivered": "delivered",
    "returned": "returned",
}


class ShipmentRead:
    def get(self, shipment_id: str) -> dict | None:
        """The stored shipment: its tenant, its status field, its scans and its poll health."""
        raise NotImplementedError


store = ShipmentRead()


def status_from_scans(shipment: dict) -> str:
    """The status the scans support, in order — the stored field never overrides them."""
    status = "label"
    for scan in sorted(shipment.get("scans", []), key=lambda scan: scan["scan_at"]):
        status = scan["status"]
    return status


def load_shipment(shipment_id: str, tenant: str) -> dict:
    """The shipment as this tenant may see it; anything else is a 404, never a 403."""
    shipment = store.get(shipment_id)
    if shipment is None or shipment["tenant_id"] != tenant:
        raise HTTPException(status_code=404, detail="shipment not found")
    return shipment


def timeline(shipment: dict) -> list[dict]:
    """The scans a tracking page may render: a status, a city and a time."""
    return [
        {"status": scan["status"], "city": scan["scan_city"], "occurred_at": scan["scan_at"]}
        for scan in sorted(shipment.get("scans", []), key=lambda scan: scan["scan_at"])
    ]


def customer_view(shipment: dict) -> dict:
    """What the tracking page sees: the timeline, the derived status and the ETA."""
    status = status_from_scans(shipment)
    return {
        "shipment_id": shipment["shipment_id"],
        "status": SIMPLIFIED[status],
        "timeline": timeline(shipment),
        "estimated_delivery": shipment.get("estimated_delivery"),
        "delivered": status == DELIVERED,
    }


def operations_view(shipment: dict, view: dict) -> dict:
    """What the console sees: the customer view plus poll health and the reconciliation flag."""
    return {
        **view,
        "poll_health": shipment.get("poll_health"),
        "reconciliation": shipment.get("reconciliation"),
        "carrier_error": shipment.get("carrier_error"),
    }


@app.get("/v1/shipments/{shipment_id}")
def read_shipment(
    shipment_id: str,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    ops_token: str | None = Header(default=None, alias="X-Ops-Token"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    shipment = load_shipment(shipment_id, tenant)
    view = customer_view(shipment)
    if ops_token == OPS_TOKEN:
        logger.info("shipment read shipment=%s ops=true", shipment_id)
        return JSONResponse(operations_view(shipment, view), status_code=200)
    logger.info("shipment read shipment=%s ops=false", shipment_id)
    return JSONResponse(view, status_code=200)
`,
    },
    typescript: {
      starter: `/** GET /v1/shipments/:shipmentId: a model-generated draft that leaks the internals. */
import Fastify from 'fastify';

export const app = Fastify();

interface StoredShipment {
  status?: string;
  estimated_delivery?: string;
  reconciliation?: Record<string, unknown>;
  carrier_error?: string;
}

class ShipmentRead {
  /** The stored shipment: its status field, its scans, its poll health, its flags. */
  async get(shipmentId: string): Promise<StoredShipment | null> {
    throw new Error('not implemented');
  }
}

const store = new ShipmentRead();

app.get('/v1/shipments/:shipmentId', async (request, reply) => {
  // TODO: this draft serves any shipment to any caller, hands the internal reconciliation flag and
  // the carrier's error payload to customers, and reports the stored status as delivered when only
  // a label was created. Scope the read to the tenant with a 404, derive the status from the scans,
  // and keep poll health, the reconciliation flag and carrier errors in the operations view.
  const {shipmentId} = request.params as {shipmentId: string};
  const shipment = (await store.get(shipmentId)) ?? {};
  return reply.code(200).send({
    shipment_id: shipmentId,
    status: shipment.status ?? 'delivered',
    estimated_delivery: shipment.estimated_delivery,
    reconciliation: shipment.reconciliation,
    carrier_error: shipment.carrier_error,
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/shipments/:shipmentId: tenant-scoped, scans win, internals only for operations. */
import Fastify from 'fastify';

export const app = Fastify();

const OPS_TOKEN = 'ops-secret';
const DELIVERED = 'delivered';
const SIMPLIFIED: Record<string, string> = {
  label: 'label_created',
  in_transit: 'in_transit',
  out_for_delivery: 'out_for_delivery',
  delivered: 'delivered',
  returned: 'returned',
};

interface Scan {
  status: string;
  scan_at: number;
  scan_city: string;
}

interface StoredShipment {
  shipment_id: string;
  tenant_id: string;
  status: string;
  scans?: Scan[];
  estimated_delivery?: string;
  poll_health?: Record<string, unknown>;
  reconciliation?: Record<string, unknown>;
  carrier_error?: string;
}

class ShipmentRead {
  /** The stored shipment: its tenant, its status field, its scans and its poll health. */
  async get(shipmentId: string): Promise<StoredShipment | null> {
    throw new Error('not implemented');
  }
}

const store = new ShipmentRead();

function statusFromScans(shipment: StoredShipment): string {
  const scans = [...(shipment.scans ?? [])].sort((left, right) => left.scan_at - right.scan_at);
  return scans.length === 0 ? 'label' : scans[scans.length - 1].status;
}

async function loadShipment(shipmentId: string, tenant: string): Promise<StoredShipment> {
  const shipment = await store.get(shipmentId);
  if (shipment === null || shipment.tenant_id !== tenant) throw new HttpError(404, 'shipment not found');
  return shipment;
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function timeline(shipment: StoredShipment): Record<string, unknown>[] {
  return [...(shipment.scans ?? [])]
    .sort((left, right) => left.scan_at - right.scan_at)
    .map(scan => ({status: scan.status, city: scan.scan_city, occurred_at: scan.scan_at}));
}

function customerView(shipment: StoredShipment): Record<string, unknown> {
  const status = statusFromScans(shipment);
  return {
    shipment_id: shipment.shipment_id,
    status: SIMPLIFIED[status],
    timeline: timeline(shipment),
    estimated_delivery: shipment.estimated_delivery,
    delivered: status === DELIVERED,
  };
}

function operationsView(shipment: StoredShipment, view: Record<string, unknown>): Record<string, unknown> {
  return {
    ...view,
    poll_health: shipment.poll_health,
    reconciliation: shipment.reconciliation,
    carrier_error: shipment.carrier_error,
  };
}

app.get('/v1/shipments/:shipmentId', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {shipmentId} = request.params as {shipmentId: string};
  let shipment: StoredShipment;
  try {
    shipment = await loadShipment(shipmentId, tenant);
  } catch (error) {
    if (error instanceof HttpError) return reply.code(error.statusCode).send({error: error.message});
    throw error;
  }
  const view = customerView(shipment);
  const ops = request.headers['x-ops-token'] === OPS_TOKEN;
  request.log.info({shipmentId, ops}, 'shipment read');
  return reply.code(200).send(ops ? operationsView(shipment, view) : view);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"net/http"
)

type StoredShipment struct {
	Status            string         \`json:"status"\`
	EstimatedDelivery string         \`json:"estimated_delivery"\`
	Reconciliation    map[string]any \`json:"reconciliation"\`
	CarrierError      string         \`json:"carrier_error"\`
}

type shipmentRead struct{}

// Get returns the stored shipment: its status field, its scans, its poll health, its flags.
func (s *shipmentRead) Get(ctx context.Context, shipmentID string) (*StoredShipment, error) {
	return nil, nil
}

var store = &shipmentRead{}

func readShipment(rw http.ResponseWriter, r *http.Request) {
	// TODO: this draft serves any shipment to any caller, hands the internal reconciliation flag and
	// the carrier's error payload to customers, and reports the stored status as delivered when only
	// a label was created. Scope the read to the tenant with a 404, derive the status from the scans,
	// and keep poll health, the reconciliation flag and carrier errors in the operations view.
	shipmentID := r.PathValue("id")
	shipment, _ := store.Get(r.Context(), shipmentID)
	if shipment == nil {
		shipment = &StoredShipment{Status: "delivered"}
	}
	rw.Header().Set("Content-Type", "application/json")
	_, _ = rw.Write([]byte(\`{"shipment_id":"\` + shipmentID + \`","status":"\` + shipment.Status +
		\`","estimated_delivery":"\` + shipment.EstimatedDelivery +
		\`","reconciliation":null,"carrier_error":"\` + shipment.CarrierError + \`"}\`))
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/shipments/{id}", readShipment)
	_ = http.ListenAndServe(":8080", mux)
}

var _ = json.Marshal
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
)

const opsToken = "ops-secret"
const deliveredStatus = "delivered"

var simplified = map[string]string{
	"label":            "label_created",
	"in_transit":       "in_transit",
	"out_for_delivery": "out_for_delivery",
	"delivered":        "delivered",
	"returned":         "returned",
}

type Scan struct {
	Status   string \`json:"status"\`
	ScanAt   int64  \`json:"scan_at"\`
	ScanCity string \`json:"scan_city"\`
}

type StoredShipment struct {
	ShipmentID        string         \`json:"shipment_id"\`
	TenantID          string         \`json:"tenant_id"\`
	Status            string         \`json:"status"\`
	Scans             []Scan         \`json:"scans"\`
	EstimatedDelivery string         \`json:"estimated_delivery"\`
	PollHealth        map[string]any \`json:"poll_health"\`
	Reconciliation    map[string]any \`json:"reconciliation"\`
	CarrierError      string         \`json:"carrier_error"\`
}

type shipmentRead struct{}

// Get returns the stored shipment: its tenant, its status field, its scans and its poll health.
func (s *shipmentRead) Get(ctx context.Context, shipmentID string) (*StoredShipment, error) {
	return nil, nil
}

var store = &shipmentRead{}

var errNotFound = errors.New("shipment not found")

// statusFromScans returns the status the scans support, in order; the stored field never overrides.
func statusFromScans(shipment *StoredShipment) string {
	scans := sortedScans(shipment)
	if len(scans) == 0 {
		return "label"
	}
	return scans[len(scans)-1].Status
}

func sortedScans(shipment *StoredShipment) []Scan {
	scans := append([]Scan(nil), shipment.Scans...)
	sort.Slice(scans, func(i, j int) bool { return scans[i].ScanAt < scans[j].ScanAt })
	return scans
}

// loadShipment returns the shipment as this tenant may see it; anything else is a 404, never a 403.
func loadShipment(ctx context.Context, shipmentID, tenant string) (*StoredShipment, error) {
	shipment, err := store.Get(ctx, shipmentID)
	if err != nil {
		return nil, err
	}
	if shipment == nil || shipment.TenantID != tenant {
		return nil, errNotFound
	}
	return shipment, nil
}

func timeline(shipment *StoredShipment) []map[string]any {
	rows := make([]map[string]any, 0, len(shipment.Scans))
	for _, scan := range sortedScans(shipment) {
		rows = append(rows, map[string]any{"status": scan.Status, "city": scan.ScanCity, "occurred_at": scan.ScanAt})
	}
	return rows
}

func customerView(shipment *StoredShipment) map[string]any {
	status := statusFromScans(shipment)
	return map[string]any{
		"shipment_id":        shipment.ShipmentID,
		"status":             simplified[status],
		"timeline":           timeline(shipment),
		"estimated_delivery": shipment.EstimatedDelivery,
		"delivered":          status == deliveredStatus,
	}
}

// operationsView adds poll health and the reconciliation flag to the customer view.
func operationsView(shipment *StoredShipment, view map[string]any) map[string]any {
	view["poll_health"] = shipment.PollHealth
	view["reconciliation"] = shipment.Reconciliation
	view["carrier_error"] = shipment.CarrierError
	return view
}

func readShipment(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	shipmentID := r.PathValue("id")
	shipment, err := loadShipment(r.Context(), shipmentID, tenant)
	if errors.Is(err, errNotFound) {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "shipment not found"})
		return
	}
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	view := customerView(shipment)
	ops := r.Header.Get("X-Ops-Token") == opsToken
	body := view
	if ops {
		body = operationsView(shipment, view)
	}
	writeJSON(rw, http.StatusOK, body)
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/shipments/{id}", readShipment)
	_ = http.ListenAndServe(":8080", mux)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

case class StoredShipment(
    shipment_id: String,
    status: String,
    estimated_delivery: String,
    reconciliation: String,
    carrier_error: String
)

object ReadApi {
  implicit val system: ActorSystem = ActorSystem("shipments")

  /** The stored shipment: its status field, its scans, its poll health, its flags. */
  def get(shipmentId: String): Option[StoredShipment] = None

  val route: Route =
    path("v1" / "shipments" / Segment) { shipmentId =>
      get {
        // TODO: this draft serves any shipment to any caller, hands the internal reconciliation
        // flag and the carrier's error payload to customers, and reports the stored status as
        // delivered when only a label was created. Scope the read to the tenant with a 404, derive
        // the status from the scans, and keep poll health, the reconciliation flag and carrier
        // errors in the operations view.
        val shipment = get(shipmentId).getOrElse(StoredShipment(shipmentId, "delivered", "", "", ""))
        complete(
          StatusCodes.OK,
          "{\\"shipment_id\\":\\"" + shipmentId + "\\",\\"status\\":\\"" + shipment.status +
            "\\",\\"estimated_delivery\\":\\"" + shipment.estimated_delivery +
            "\\",\\"reconciliation\\":\\"" + shipment.reconciliation +
            "\\",\\"carrier_error\\":\\"" + shipment.carrier_error + "\\"}"
        )
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

case class Scan(status: String, scan_at: Long, scan_city: String)

case class StoredShipment(
    shipment_id: String,
    tenant_id: String,
    status: String,
    scans: List[Scan],
    estimated_delivery: String,
    poll_health: String,
    reconciliation: String,
    carrier_error: String
)

object ReadApi {
  implicit val system: ActorSystem = ActorSystem("shipments")

  val OpsToken = "ops-secret"
  val Delivered = "delivered"
  val Simplified = Map(
    "label" -> "label_created",
    "in_transit" -> "in_transit",
    "out_for_delivery" -> "out_for_delivery",
    "delivered" -> "delivered",
    "returned" -> "returned"
  )

  /** The stored shipment: its tenant, its status field, its scans and its poll health. */
  def get(shipmentId: String): Option[StoredShipment] = None

  /** The status the scans support, in order; the stored field never overrides them. */
  def statusFromScans(shipment: StoredShipment): String =
    shipment.scans.sortBy(_.scan_at).lastOption.map(_.status).getOrElse("label")

  /** The shipment as this tenant may see it; anything else is a 404, never a 403. */
  def loadShipment(shipmentId: String, tenant: String): Either[Int, StoredShipment] =
    get(shipmentId) match {
      case Some(shipment) if shipment.tenant_id == tenant => Right(shipment)
      case _ => Left(StatusCodes.NotFound.intValue)
    }

  def timeline(shipment: StoredShipment): List[String] =
    shipment.scans.sortBy(_.scan_at).map { scan =>
      "{\\"status\\":\\"" + scan.status + "\\",\\"city\\":\\"" + scan.scan_city +
        "\\",\\"occurred_at\\":" + scan.scan_at + "}"
    }

  def customerView(shipment: StoredShipment): String = {
    val status = statusFromScans(shipment)
    "{\\"shipment_id\\":\\"" + shipment.shipment_id + "\\",\\"status\\":\\"" + Simplified(status) +
      "\\",\\"timeline\\":[" + timeline(shipment).mkString(",") + "],\\"estimated_delivery\\":\\"" +
      shipment.estimated_delivery + "\\",\\"delivered\\":" + (status == Delivered) + "}"
  }

  /** What the console sees: the customer view plus poll health and the reconciliation flag. */
  def operationsView(shipment: StoredShipment, view: String): String =
    view.dropRight(1) + ",\\"poll_health\\":\\"" + shipment.poll_health + "\\",\\"reconciliation\\":\\"" +
      shipment.reconciliation + "\\",\\"carrier_error\\":\\"" + shipment.carrier_error + "\\"}"

  val route: Route =
    path("v1" / "shipments" / Segment) { shipmentId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          optionalHeaderValueByName("X-Ops-Token") { opsOpt =>
            if (!tenantOpt.exists(_.nonEmpty)) {
              complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
            } else {
              loadShipment(shipmentId, tenantOpt.get) match {
                case Left(_) =>
                  complete(StatusCodes.NotFound, """{"error":"shipment not found"}""")
                case Right(shipment) =>
                  val view = customerView(shipment)
                  if (opsOpt.contains(OpsToken)) {
                    complete(StatusCodes.OK, operationsView(shipment, view))
                  } else {
                    complete(StatusCodes.OK, view)
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

#include <optional>
#include <string>

using json = nlohmann::json;

struct ShipmentStore {
  std::optional<json> get(const std::string& shipmentId);
};

ShipmentStore store;

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/shipments/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    const auto shipmentId = req.matches[1].str();
    // TODO: this draft serves any shipment to any caller, hands the internal reconciliation flag
    // and the carrier's error payload to customers, and reports the stored status as delivered when
    // only a label was created. Scope the read to the tenant with a 404, derive the status from the
    // scans, and keep poll health, the reconciliation flag and carrier errors in the operations
    // view.
    const auto shipment = store.get(shipmentId);
    const json body = {
        {"shipment_id", shipmentId},
        {"status", shipment ? shipment->value("status", "delivered") : "delivered"},
        {"estimated_delivery", shipment ? shipment->value("estimated_delivery", "") : ""},
        {"reconciliation", shipment ? (*shipment)["reconciliation"] : json(nullptr)},
        {"carrier_error", shipment ? (*shipment)["carrier_error"] : json(nullptr)},
    };
    res.status = 200;
    res.set_content(body.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <optional>
#include <string>
#include <vector>

using json = nlohmann::json;

const std::string kOpsToken = "ops-secret";
const std::string kDelivered = "delivered";

const json kSimplified = {
    {"label", "label_created"},
    {"in_transit", "in_transit"},
    {"out_for_delivery", "out_for_delivery"},
    {"delivered", "delivered"},
    {"returned", "returned"},
};

struct ShipmentStore {
  std::optional<json> get(const std::string& shipmentId);
};

ShipmentStore store;

json sortedScans(const json& shipment) {
  auto scans = shipment.value("scans", json::array());
  std::sort(scans.begin(), scans.end(), [](const json& left, const json& right) {
    return left.value("scan_at", 0LL) < right.value("scan_at", 0LL);
  });
  return scans;
}

/** The status the scans support, in order; the stored field never overrides them. */
std::string statusFromScans(const json& shipment) {
  const auto scans = sortedScans(shipment);
  if (scans.empty()) return "label";
  return scans.back().value("status", "label");
}

/** The shipment as this tenant may see it; anything else is a 404, never a 403. */
bool loadShipment(const std::string& shipmentId, const std::string& tenant, json* out) {
  const auto shipment = store.get(shipmentId);
  if (!shipment || shipment->value("tenant_id", std::string()) != tenant) return false;
  *out = *shipment;
  return true;
}

json timeline(const json& shipment) {
  json rows = json::array();
  for (const auto& scan : sortedScans(shipment)) {
    rows.push_back(json{
        {"status", scan.value("status", "")},
        {"city", scan.value("scan_city", "")},
        {"occurred_at", scan.value("scan_at", 0LL)},
    });
  }
  return rows;
}

/** What the tracking page sees: the timeline, the derived status and the ETA. */
json customerView(const json& shipment) {
  const auto status = statusFromScans(shipment);
  return json{
      {"shipment_id", shipment.value("shipment_id", std::string())},
      {"status", kSimplified.value(status, status)},
      {"timeline", timeline(shipment)},
      {"estimated_delivery", shipment.value("estimated_delivery", std::string())},
      {"delivered", status == kDelivered},
  };
}

/** What the console sees: the customer view plus poll health and the reconciliation flag. */
json operationsView(const json& shipment, json view) {
  view["poll_health"] = shipment.value("poll_health", json(nullptr));
  view["reconciliation"] = shipment.value("reconciliation", json(nullptr));
  view["carrier_error"] = shipment.value("carrier_error", json(nullptr));
  return view;
}

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/shipments/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto shipmentId = req.matches[1].str();
    json shipment;
    if (!loadShipment(shipmentId, tenant, &shipment)) {
      res.status = 404;
      res.set_content(R"({"error":"shipment not found"})", "application/json");
      return;
    }
    const auto view = customerView(shipment);
    const bool ops = req.get_header_value("X-Ops-Token") == kOpsToken;
    res.status = 200;
    res.set_content(ops ? operationsView(shipment, view).dump() : view.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The interview question is what a read owes each of its callers. The customer needs a truthful status and a coarse timeline — which is why the status must be derived from the scans rather than from a field that was initialized optimistically, and why the location is a city. The operations console needs the parts of the truth the customer must not see: whether the carrier feed is stale, whether the timeline disagrees with the carriers, and what the carrier's API said when it failed. Two builders over one load make that boundary explicit; one shared payload makes it a leak waiting for a field to be added. And the 404-versus-403 difference is the same boundary applied to ids: an API that distinguishes "not yours" from "not found" is an enumeration oracle. Real platforms add per-tenant shipment search indexes, signed tracking links for recipients who are not the buyer, and a separate internal service for the operations fields.`,
};
