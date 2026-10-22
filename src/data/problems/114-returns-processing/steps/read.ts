import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/returns/{id}: the refund attached to the return',
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'db', 'refunds'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: the return page fetches a
return and renders a state, so the demo looks finished. It reports a return refunded the moment a
refund is initiated, it hides the refund whenever the processor failed it, and it serves any return
to any caller. Review it, fix it, and prove the fix with the checks below.

Implement \`GET /v1/returns/{return_id}\`, the read behind the customer's return page:

- The tenant comes from \`X-Tenant-Id\` (**401** when missing). A return that does not exist **or
  belongs to another tenant** is **404** — never 403: a customer must not be able to probe which
  return ids exist.
- The response carries \`return_id\`, \`state\`, \`grade\`, the \`refund\` linkage and the
  \`order_line\` the return was registered against.
- \`state\` follows the refund processor's record: **\`refunded\` requires a confirmed refund**; a
  refund merely initiated reads \`awaiting_refund\`; a failed one reads \`refund_failed\`; and a
  return that was never handed to the processor keeps its stored \`pending\` state.
- The \`refund\` object — \`{"refund_id", "state"}\` — is returned for **every** refund the return
  has, failures included: a failed refund is the case support opens the return for, not the one to
  hide. It is \`null\` only when no refund was ever initiated.
- \`order_line\` carries the original line's facts — \`order_line_id\`, \`sku\`,
  \`ordered_quantity\`, \`delivered_at\` — loaded by the return's \`order_line_id\`, so the page can
  show what was actually bought.
- Log the read with the tenant and the return id; never the reason code or the photo reference.

**Failure mode the checks target.** Three quiet defects. \`state\` is written when the refund is
*initiated*, so the page promises money the processor has not confirmed. The linkage is dropped in
the failed branch, so the one outcome customers call about is the one the page cannot show. And
without the owner check any caller can read any return id — a leak and an enumeration oracle in
one.`,
  sequence: {
    participants: ['Customer', 'Returns API', 'orders · returns', 'refunds'],
    messages: [
      {from: 'Customer', to: 'Returns API', label: 'GET /v1/returns/ret_91 · X-Tenant-Id', kind: 'sync'},
      {from: 'Returns API', to: 'orders · returns', label: 'load the return row · tenant_id · refund_id', kind: 'sync'},
      {from: 'orders · returns', to: 'Returns API', label: 'state · grade · order_line_id', kind: 'reply'},
      {from: 'Returns API', to: 'orders · returns', label: 'load the original order line', kind: 'sync'},
      {from: 'orders · returns', to: 'Returns API', label: 'sku · ordered_quantity · delivered_at', kind: 'reply'},
      {from: 'Returns API', to: 'refunds', label: 'refund by refund_id', kind: 'sync'},
      {from: 'refunds', to: 'Returns API', label: 'initiated · confirmed · failed', kind: 'reply'},
      {
        from: 'Returns API',
        to: 'Returns API',
        label: 'foreign or unknown → 404; refunded only once confirmed',
        kind: 'sync',
      },
      {from: 'Returns API', to: 'Customer', label: '200 {state, grade, refund, order_line} · 404', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'read-route',
      title: 'Serves GET /v1/returns/{id} with the return and its order line',
      detail:
        'The read is registered on `GET /v1/returns/{id}` and the payload names the return and the order line it was registered against. The draft already answers this route, so this check passes on it — the four below are where it fails.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/returns\/\{return_id\}["']/, /order_line_id/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/returns\/:returnId['"]/, /order_line_id/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/returns\/\{return_id\}"/, /order_line_id/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"returns"\s*\/\s*Segment\s*\)/, /\bget\s*\{/, /order_line_id/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/returns\//, /order_line_id/]},
      },
    },
    {
      id: 'confirmed-state',
      title: 'Calls a return refunded only once the processor confirmed',
      detail:
        "`state_from_refund()` derives the state from the processor's record: `confirmed` → `refunded`, `failed` → `refund_failed`, an initiated refund → `awaiting_refund`. The draft reports `refunded` the moment a refund exists, so the page promises money that has not moved.",
      match: {
        python: {all: [/def state_from_refund\(/, /CONFIRMED/, /"refunded"/, /awaiting_refund/]},
        typescript: {all: [/function stateFromRefund\(/, /CONFIRMED/, /refunded/, /awaiting_refund/]},
        go: {all: [/func stateFromRefund\(/, /refundConfirmed/, /"refunded"/, /awaiting_refund/]},
        scala: {all: [/def stateFromRefund\(/, /\bConfirmed\b/, /"refunded"/, /awaiting_refund/]},
        cpp: {all: [/stateFromRefund\(/, /kConfirmed/, /"refunded"/, /awaiting_refund/]},
      },
    },
    {
      id: 'refund-linkage',
      title: 'Keeps the refund linkage visible when the refund failed',
      detail:
        '`refund_linkage()` returns `{refund_id, state}` for every refund the return has, failed ones included, and no branch drops it. The draft omits the linkage when the refund state is `failed`, hiding exactly the outcome a support agent opens the return for.',
      match: {
        python: {
          all: [/def refund_linkage\(/, /refund_id/, /FAILED/],
          none: [/\[["']state["']\]\s*!=\s*["']failed["']/],
        },
        typescript: {
          all: [/function refundLinkage\(/, /refund_id/, /FAILED/],
          none: [/\.state\s*!==?\s*['"]failed['"]/],
        },
        go: {all: [/func refundLinkage\(/, /refund_id/, /refundFailed/], none: [/\.State\s*!=\s*"failed"/]},
        scala: {all: [/def refundLinkage\(/, /refund_id/, /\bFailed\b/], none: [/\.state\s*!=\s*"failed"/]},
        cpp: {all: [/refundLinkage\(/, /refund_id/, /kFailed/], none: [/!=\s*"failed"/]},
      },
    },
    {
      id: 'owner-scope',
      title: 'Answers 404 for a return that belongs to another tenant',
      detail:
        "`load_return(return_id, tenant)` returns **404** when the row is missing **or** its `tenant_id` is not the caller's — the same refusal in both cases, so a foreign id cannot be probed. The draft serves any return to any caller.",
      match: {
        python: {all: [/status_code\s*=\s*404/, /def load_return\(/, /tenant_id/]},
        typescript: {all: [/\b404\b/, /function loadReturn\(/, /tenant_id/]},
        go: {all: [/StatusNotFound/, /func loadReturn\(/, /tenant_id/]},
        scala: {all: [/StatusCodes\.NotFound/, /def loadReturn\(/, /tenant_id/]},
        cpp: {all: [/\b404\b/, /loadReturn\(/, /tenant_id/]},
      },
    },
    {
      id: 'order-line',
      title: 'Carries the original order line: its id and its facts',
      detail:
        "`order_line_facts()` loads the line by `order_line_id` and the payload carries the line's `sku`, `ordered_quantity` and `delivered_at`. The draft echoes the id it snapshotted at registration and nothing the customer can recognize.",
      match: {
        python: {all: [/def order_line_facts\(/, /order_line_id/, /"sku"/, /delivered_at/]},
        typescript: {all: [/function orderLineFacts\(/, /order_line_id/, /sku/, /delivered_at/]},
        go: {all: [/func orderLineFacts\(/, /order_line_id/, /"sku"/, /delivered_at/]},
        scala: {all: [/def orderLineFacts\(/, /order_line_id/, /sku/, /delivered_at/]},
        cpp: {all: [/orderLineFacts\(/, /order_line_id/, /"sku"/, /"delivered_at"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("returns-read")


class ReturnsStore:
    def get(self, return_id: str) -> dict | None:
        """The return row: state, grade, refund_id and order_line_id."""
        raise NotImplementedError

    def refund(self, refund_id: str) -> dict | None:
        """The refund processor's record."""
        raise NotImplementedError


store = ReturnsStore()


@app.get("/v1/returns/{return_id}")
def read_return(return_id: str) -> JSONResponse:
    # TODO: this draft calls a return refunded as soon as a refund is initiated, drops the refund
    # linkage when the refund failed, and serves any return to any caller. Confirm the refund with
    # the processor, keep failed linkages visible, and scope the read to the order's owner.
    row = store.get(return_id) or {}
    refund = store.refund(row["refund_id"]) if "refund_id" in row else None
    body = {
        "return_id": row.get("return_id", return_id),
        "state": "refunded" if refund is not None else row.get("state", "pending"),
        "grade": row.get("grade"),
        "order_line": {"order_line_id": row.get("order_line_id"), "quantity": row.get("quantity")},
    }
    if refund is not None and refund["state"] != "failed":
        body["refund"] = {"refund_id": refund["refund_id"], "state": refund["state"]}
    logger.info("return read return=%s", return_id)
    return JSONResponse(body, status_code=200)
`,
      solution: `import logging

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("returns-read")

CONFIRMED = "confirmed"
FAILED = "failed"


class ReturnsStore:
    def get(self, return_id: str) -> dict | None:
        """The return row: tenant_id, state, grade, refund_id and order_line_id."""
        raise NotImplementedError

    def refund(self, refund_id: str) -> dict | None:
        """The refund processor's record."""
        raise NotImplementedError

    def order_line(self, order_line_id: str) -> dict | None:
        """The original order line the return belongs to."""
        raise NotImplementedError


store = ReturnsStore()


def load_return(return_id: str, tenant: str) -> dict:
    """The return as this tenant may see it; anything else is a 404, never a 403."""
    row = store.get(return_id)
    if row is None or row["tenant_id"] != tenant:
        raise HTTPException(status_code=404, detail="return not found")
    return row


def state_from_refund(refund: dict | None) -> str:
    """How the return reads now: refunded only once the processor confirmed it."""
    if refund is None:
        return "pending"
    if refund["state"] == CONFIRMED:
        return "refunded"
    if refund["state"] == FAILED:
        return "refund_failed"
    return "awaiting_refund"


def refund_linkage(refund: dict | None) -> dict | None:
    """The refund the processor owns, however it ended — failures stay visible."""
    if refund is None:
        return None
    return {"refund_id": refund["refund_id"], "state": refund["state"]}


def order_line_facts(order_line_id: str) -> dict:
    """The original line: what was bought and when it landed, loaded by the line id."""
    line = store.order_line(order_line_id) or {}
    return {
        "order_line_id": order_line_id,
        "sku": line.get("sku"),
        "ordered_quantity": line.get("ordered_quantity"),
        "delivered_at": line.get("delivered_at"),
    }


@app.get("/v1/returns/{return_id}")
def read_return(return_id: str, tenant: str | None = Header(default=None, alias="X-Tenant-Id")) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    row = load_return(return_id, tenant)
    refund = store.refund(row["refund_id"]) if row.get("refund_id") else None
    body = {
        "return_id": row["return_id"],
        "state": state_from_refund(refund),
        "grade": row.get("grade"),
        "refund": refund_linkage(refund),
        "order_line": order_line_facts(row["order_line_id"]),
    }
    logger.info("return read return=%s tenant=%s", return_id, tenant)
    return JSONResponse(body, status_code=200)
`,
    },
    typescript: {
      starter: `/** GET /v1/returns/:returnId: a model-generated draft that trusts the refund as it is initiated. */
import Fastify from 'fastify';

export const app = Fastify();

interface StoredRefund {
  refund_id: string;
  state: string;
}

interface StoredReturn {
  return_id: string;
  order_line_id: string;
  quantity: number;
  state: string;
  grade?: string;
  refund_id?: string;
}

class ReturnsStore {
  /** The return row: state, grade, refund_id and order_line_id. */
  async get(returnId: string): Promise<StoredReturn | null> {
    throw new Error('not implemented');
  }

  /** The original order line. */
  async orderLine(orderLineId: string): Promise<Record<string, unknown> | null> {
    throw new Error('not implemented');
  }

  /** The refund processor's record. */
  async refund(refundId: string): Promise<StoredRefund | null> {
    throw new Error('not implemented');
  }
}

const store = new ReturnsStore();

app.get('/v1/returns/:returnId', async (request, reply) => {
  // TODO: this draft calls a return refunded as soon as a refund is initiated, drops the refund
  // linkage when the refund failed, and serves any return to any caller. Confirm the refund with
  // the processor, keep failed linkages visible, and scope the read to the order's owner.
  const {returnId} = request.params as {returnId: string};
  const row = (await store.get(returnId)) ?? {};
  const refund = row.refund_id ? await store.refund(row.refund_id) : null;
  const body: Record<string, unknown> = {
    return_id: row.return_id ?? returnId,
    state: refund !== null ? 'refunded' : (row.state ?? 'pending'),
    grade: row.grade,
    order_line: {order_line_id: row.order_line_id, quantity: row.quantity},
  };
  if (refund !== null && refund.state !== 'failed') {
    body.refund = {refund_id: refund.refund_id, state: refund.state};
  }
  return reply.code(200).send(body);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/returns/:returnId: confirmed state, linkage kept, owner-scoped. */
import Fastify from 'fastify';

export const app = Fastify();

const CONFIRMED = 'confirmed';
const FAILED = 'failed';

interface StoredRefund {
  refund_id: string;
  state: string;
}

interface StoredReturn {
  return_id: string;
  tenant_id: string;
  order_line_id: string;
  state: string;
  grade?: string;
  refund_id?: string;
}

class ReturnsStore {
  /** The return row: tenant_id, state, grade, refund_id and order_line_id. */
  async get(returnId: string): Promise<StoredReturn | null> {
    throw new Error('not implemented');
  }

  /** The original order line. */
  async orderLine(orderLineId: string): Promise<Record<string, unknown> | null> {
    throw new Error('not implemented');
  }

  /** The refund processor's record. */
  async refund(refundId: string): Promise<StoredRefund | null> {
    throw new Error('not implemented');
  }
}

const store = new ReturnsStore();

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

/** The return as this tenant may see it; anything else is a 404, never a 403. */
async function loadReturn(returnId: string, tenant: string): Promise<StoredReturn> {
  const row = await store.get(returnId);
  if (row === null || row.tenant_id !== tenant) throw new HttpError(404, 'return not found');
  return row;
}

/** How the return reads now: refunded only once the processor confirmed it. */
function stateFromRefund(refund: StoredRefund | null): string {
  if (refund === null) return 'pending';
  if (refund.state === CONFIRMED) return 'refunded';
  if (refund.state === FAILED) return 'refund_failed';
  return 'awaiting_refund';
}

/** The refund the processor owns, however it ended — a failure stays visible. */
function refundLinkage(refund: StoredRefund | null): Record<string, unknown> | null {
  if (refund === null) return null;
  return {refund_id: refund.refund_id, state: refund.state};
}

/** The original line: what was bought and when it landed, loaded by the line id. */
async function orderLineFacts(orderLineId: string): Promise<Record<string, unknown>> {
  const line = (await store.orderLine(orderLineId)) ?? {};
  return {
    order_line_id: orderLineId,
    sku: line.sku,
    ordered_quantity: line.ordered_quantity,
    delivered_at: line.delivered_at,
  };
}

app.get('/v1/returns/:returnId', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {returnId} = request.params as {returnId: string};
  let row: StoredReturn;
  try {
    row = await loadReturn(returnId, tenant);
  } catch (error) {
    if (error instanceof HttpError) return reply.code(error.statusCode).send({error: error.message});
    throw error;
  }
  const refund = row.refund_id ? await store.refund(row.refund_id) : null;
  request.log.info({returnId, tenant}, 'return read');
  return reply.code(200).send({
    return_id: row.return_id,
    state: stateFromRefund(refund),
    grade: row.grade,
    refund: refundLinkage(refund),
    order_line: await orderLineFacts(row.order_line_id),
  });
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

type Refund struct {
	RefundID string \`json:"refund_id"\`
	State    string \`json:"state"\`
}

type ReturnRow struct {
	ReturnID    string \`json:"return_id"\`
	OrderLineID string \`json:"order_line_id"\`
	Quantity    int    \`json:"quantity"\`
	State       string \`json:"state"\`
	Grade       string \`json:"grade"\`
	RefundID    string \`json:"refund_id"\`
}

type ReturnsStore struct{}

// Get returns the return row: state, grade, refund_id and order_line_id.
func (s *ReturnsStore) Get(ctx context.Context, returnID string) (*ReturnRow, error) {
	return nil, nil
}

// OrderLine returns the original order line.
func (s *ReturnsStore) OrderLine(ctx context.Context, orderLineID string) (map[string]any, error) {
	return nil, nil
}

// Refund returns the refund processor's record.
func (s *ReturnsStore) Refund(ctx context.Context, refundID string) (*Refund, error) {
	return nil, nil
}

var store = &ReturnsStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

func readReturn(rw http.ResponseWriter, r *http.Request) {
	// TODO: this draft calls a return refunded as soon as a refund is initiated, drops the refund
	// linkage when the refund failed, and serves any return to any caller. Confirm the refund with
	// the processor, keep failed linkages visible, and scope the read to the order's owner.
	returnID := r.PathValue("return_id")
	row, _ := store.Get(r.Context(), returnID)
	if row == nil {
		row = &ReturnRow{ReturnID: returnID, State: "pending"}
	}
	var refund *Refund
	if row.RefundID != "" {
		refund, _ = store.Refund(r.Context(), row.RefundID)
	}
	state := row.State
	if refund != nil {
		state = "refunded"
	}
	body := map[string]any{
		"return_id":  row.ReturnID,
		"state":      state,
		"grade":      row.Grade,
		"order_line": map[string]any{"order_line_id": row.OrderLineID, "quantity": row.Quantity},
	}
	if refund != nil && refund.State != "failed" {
		body["refund"] = map[string]any{"refund_id": refund.RefundID, "state": refund.State}
	}
	writeJSON(rw, http.StatusOK, body)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/returns/{return_id}", readReturn)
	_ = http.ListenAndServe(":8080", mux)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
)

const refundConfirmed = "confirmed"
const refundFailed = "failed"

var errReturnNotFound = errors.New("return not found")

type Refund struct {
	RefundID string \`json:"refund_id"\`
	State    string \`json:"state"\`
}

type ReturnRow struct {
	ReturnID    string \`json:"return_id"\`
	TenantID    string \`json:"tenant_id"\`
	OrderLineID string \`json:"order_line_id"\`
	State       string \`json:"state"\`
	Grade       string \`json:"grade"\`
	RefundID    string \`json:"refund_id"\`
}

type ReturnsStore struct{}

// Get returns the return row: tenant_id, state, grade, refund_id and order_line_id.
func (s *ReturnsStore) Get(ctx context.Context, returnID string) (*ReturnRow, error) {
	return nil, nil
}

// OrderLine returns the original order line.
func (s *ReturnsStore) OrderLine(ctx context.Context, orderLineID string) (map[string]any, error) {
	return nil, nil
}

// Refund returns the refund processor's record.
func (s *ReturnsStore) Refund(ctx context.Context, refundID string) (*Refund, error) {
	return nil, nil
}

var store = &ReturnsStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

// loadReturn returns the return as this tenant may see it; anything else is a 404, never a 403.
func loadReturn(ctx context.Context, returnID, tenant string) (*ReturnRow, error) {
	row, err := store.Get(ctx, returnID)
	if err != nil {
		return nil, err
	}
	if row == nil || row.TenantID != tenant {
		return nil, errReturnNotFound
	}
	return row, nil
}

// stateFromRefund derives the state from the processor's record: refunded only once confirmed.
func stateFromRefund(refund *Refund) string {
	if refund == nil {
		return "pending"
	}
	switch refund.State {
	case refundConfirmed:
		return "refunded"
	case refundFailed:
		return "refund_failed"
	default:
		return "awaiting_refund"
	}
}

// refundLinkage keeps the refund's identity and state visible, however it ended.
func refundLinkage(refund *Refund) any {
	if refund == nil {
		return nil
	}
	return map[string]any{"refund_id": refund.RefundID, "state": refund.State}
}

// orderLineFacts loads the original line: what was bought and when it landed.
func orderLineFacts(ctx context.Context, orderLineID string) (map[string]any, error) {
	line, err := store.OrderLine(ctx, orderLineID)
	if err != nil {
		return nil, err
	}
	if line == nil {
		line = map[string]any{}
	}
	return map[string]any{
		"order_line_id":    orderLineID,
		"sku":              line["sku"],
		"ordered_quantity": line["ordered_quantity"],
		"delivered_at":     line["delivered_at"],
	}, nil
}

func readReturn(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	returnID := r.PathValue("return_id")
	row, err := loadReturn(r.Context(), returnID, tenant)
	if errors.Is(err, errReturnNotFound) {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "return not found"})
		return
	}
	if err != nil {
		writeJSON(rw, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return
	}
	var refund *Refund
	if row.RefundID != "" {
		refund, err = store.Refund(r.Context(), row.RefundID)
		if err != nil {
			writeJSON(rw, http.StatusInternalServerError, map[string]string{"error": "internal"})
			return
		}
	}
	line, err := orderLineFacts(r.Context(), row.OrderLineID)
	if err != nil {
		writeJSON(rw, http.StatusInternalServerError, map[string]string{"error": "internal"})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"return_id":  row.ReturnID,
		"state":      stateFromRefund(refund),
		"grade":      row.Grade,
		"refund":     refundLinkage(refund),
		"order_line": line,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/returns/{return_id}", readReturn)
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
import spray.json._

final case class StoredRefund(refund_id: String, state: String)

object ReadApi {
  implicit val system: ActorSystem = ActorSystem("returns-read")

  /** The return row: state, grade, refund_id and order_line_id. */
  def get(returnId: String): Option[Map[String, String]] = None

  /** The original order line. */
  def orderLine(orderLineId: String): Option[Map[String, String]] = None

  /** The refund processor's record. */
  def refund(refundId: String): Option[StoredRefund] = None

  def optString(row: Map[String, String], key: String): JsValue =
    row.get(key).map(JsString(_)).getOrElse(JsNull)

  val route: Route =
    path("v1" / "returns" / Segment) { returnId =>
      get {
        // TODO: this draft calls a return refunded as soon as a refund is initiated, drops the
        // refund linkage when the refund failed, and serves any return to any caller. Confirm the
        // refund with the processor, keep failed linkages visible, and scope the read to the
        // order's owner.
        val row = get(returnId).getOrElse(Map.empty)
        val refundRecord = row.get("refund_id").flatMap(refund)
        val state = if (refundRecord.isDefined) "refunded" else row.getOrElse("state", "pending")
        val body = JsObject(
          "return_id" -> JsString(row.getOrElse("return_id", returnId)),
          "state" -> JsString(state),
          "grade" -> optString(row, "grade"),
          "order_line" -> JsObject("order_line_id" -> JsString(row.getOrElse("order_line_id", returnId)))
        )
        val withRefund = refundRecord match {
          case Some(r) if r.state != "failed" =>
            JsObject(
              body.fields + ("refund" -> JsObject("refund_id" -> JsString(r.refund_id), "state" -> JsString(r.state)))
            )
          case _ => body
        }
        complete(StatusCodes.OK, withRefund.compactPrint)
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

final case class StoredRefund(refund_id: String, state: String)

object ReadApi {
  implicit val system: ActorSystem = ActorSystem("returns-read")

  val Confirmed = "confirmed"
  val Failed = "failed"

  /** The return row: tenant_id, state, grade, refund_id and order_line_id. */
  def get(returnId: String): Option[Map[String, String]] = None

  /** The original order line. */
  def orderLine(orderLineId: String): Option[Map[String, String]] = None

  /** The refund processor's record. */
  def refund(refundId: String): Option[StoredRefund] = None

  /** The return as this tenant may see it; anything else is a 404, never a 403. */
  def loadReturn(returnId: String, tenant: String): Either[Int, Map[String, String]] =
    get(returnId) match {
      case Some(row) if row.get("tenant_id").contains(tenant) => Right(row)
      case _ => Left(StatusCodes.NotFound.intValue)
    }

  /** How the return reads now: refunded only once the processor confirmed it. */
  def stateFromRefund(record: Option[StoredRefund]): String = record match {
    case None => "pending"
    case Some(r) if r.state == Confirmed => "refunded"
    case Some(r) if r.state == Failed => "refund_failed"
    case _ => "awaiting_refund"
  }

  /** The refund the processor owns, however it ended — a failure stays visible. */
  def refundLinkage(record: Option[StoredRefund]): JsValue = record match {
    case None => JsNull
    case Some(r) => JsObject("refund_id" -> JsString(r.refund_id), "state" -> JsString(r.state))
  }

  def optString(row: Map[String, String], key: String): JsValue =
    row.get(key).map(JsString(_)).getOrElse(JsNull)

  def optNumber(row: Map[String, String], key: String): JsValue =
    row.get(key).flatMap(value => scala.util.Try(BigDecimal(value)).toOption).map(JsNumber(_)).getOrElse(JsNull)

  /** The original line: what was bought and when it landed, loaded by the line id. */
  def orderLineFacts(orderLineId: String): JsValue = {
    val line = orderLine(orderLineId).getOrElse(Map.empty)
    JsObject(
      "order_line_id" -> JsString(orderLineId),
      "sku" -> optString(line, "sku"),
      "ordered_quantity" -> optNumber(line, "ordered_quantity"),
      "delivered_at" -> optString(line, "delivered_at")
    )
  }

  val route: Route =
    path("v1" / "returns" / Segment) { returnId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          if (!tenantOpt.exists(_.nonEmpty)) {
            complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
          } else {
            loadReturn(returnId, tenantOpt.get) match {
              case Left(_) =>
                complete(StatusCodes.NotFound, """{"error":"return not found"}""")
              case Right(row) =>
                val refundRecord = row.get("refund_id").flatMap(refund)
                val body = JsObject(
                  "return_id" -> JsString(row.getOrElse("return_id", returnId)),
                  "state" -> JsString(stateFromRefund(refundRecord)),
                  "grade" -> optString(row, "grade"),
                  "refund" -> refundLinkage(refundRecord),
                  "order_line" -> orderLineFacts(row.getOrElse("order_line_id", returnId))
                )
                system.log.info(s"return read return=$returnId tenant=\${tenantOpt.get}")
                complete(StatusCodes.OK, body.compactPrint)
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

struct ReturnsStore {
  std::optional<json> get(const std::string& returnId);
  std::optional<json> orderLine(const std::string& orderLineId);
  std::optional<json> refund(const std::string& refundId);
};

ReturnsStore store;

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/returns/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft calls a return refunded as soon as a refund is initiated, drops the refund
    // linkage when the refund failed, and serves any return to any caller. Confirm the refund with
    // the processor, keep failed linkages visible, and scope the read to the order's owner.
    const auto returnId = req.matches[1].str();
    const json row = store.get(returnId).value_or(json::object());
    std::optional<json> refund;
    if (row.contains("refund_id")) refund = store.refund(row.value("refund_id", std::string()));
    const std::string state = refund ? "refunded" : row.value("state", "pending");
    json body = {
        {"return_id", row.value("return_id", returnId)},
        {"state", state},
        {"grade", row.value("grade", json(nullptr))},
        {"order_line", json{{"order_line_id", row.value("order_line_id", std::string())},
                            {"quantity", row.value("quantity", 0)}}},
    };
    if (refund && refund->value("state", std::string()) != "failed") {
      body["refund"] = json{{"refund_id", refund->value("refund_id", std::string())},
                            {"state", refund->value("state", std::string())}};
    }
    res.status = 200;
    res.set_content(body.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <optional>
#include <string>

using json = nlohmann::json;

const std::string kConfirmed = "confirmed";
const std::string kFailed = "failed";

struct ReturnsStore {
  std::optional<json> get(const std::string& returnId);
  std::optional<json> orderLine(const std::string& orderLineId);
  std::optional<json> refund(const std::string& refundId);
};

ReturnsStore store;

/** The return as this tenant may see it; anything else is a 404, never a 403. */
bool loadReturn(const std::string& returnId, const std::string& tenant, json* out) {
  const auto row = store.get(returnId);
  if (!row || row->value("tenant_id", std::string()) != tenant) return false;
  *out = *row;
  return true;
}

/** How the return reads now: refunded only once the processor confirmed it. */
std::string stateFromRefund(const std::optional<json>& refund) {
  if (!refund) return "pending";
  const auto state = refund->value("state", std::string());
  if (state == kConfirmed) return "refunded";
  if (state == kFailed) return "refund_failed";
  return "awaiting_refund";
}

/** The refund the processor owns, however it ended — a failure stays visible. */
json refundLinkage(const std::optional<json>& refund) {
  if (!refund) return json(nullptr);
  return json{{"refund_id", refund->value("refund_id", std::string())},
              {"state", refund->value("state", std::string())}};
}

/** The original line: what was bought and when it landed, loaded by the line id. */
json orderLineFacts(const std::string& orderLineId) {
  const auto line = store.orderLine(orderLineId).value_or(json::object());
  return json{
      {"order_line_id", orderLineId},
      {"sku", line.value("sku", std::string())},
      {"ordered_quantity", line.value("ordered_quantity", 0)},
      {"delivered_at", line.value("delivered_at", std::string())},
  };
}

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/returns/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto returnId = req.matches[1].str();
    json row;
    if (!loadReturn(returnId, tenant, &row)) {
      res.status = 404;
      res.set_content(R"({"error":"return not found"})", "application/json");
      return;
    }
    std::optional<json> refund;
    if (row.contains("refund_id")) refund = store.refund(row.value("refund_id", std::string()));
    const json body = {
        {"return_id", row.value("return_id", returnId)},
        {"state", stateFromRefund(refund)},
        {"grade", row.value("grade", json(nullptr))},
        {"refund", refundLinkage(refund)},
        {"order_line", orderLineFacts(row.value("order_line_id", std::string()))},
    };
    res.status = 200;
    res.set_content(body.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Scope the read in the loader: `load_return(return_id, tenant)` answers 404 when the row is missing **or** its `tenant_id` is someone else’s. Answering 403 for the other tenant’s return confirms the id exists, which is exactly what an enumeration attempt is looking for.',
    'Initiation is not confirmation. `state_from_refund()` reads the processor’s record: `confirmed` → `refunded`, `failed` → `refund_failed`, anything else → `awaiting_refund`. The moment a refund id exists the page may say *awaiting*, never *refunded*.',
    'Carry the linkage however the refund ended: `refund_linkage()` always yields `{refund_id, state}` — a failed refund is the case a support agent opens the return for. And build `order_line` from the line loader, not from the snapshot the draft took at registration.',
  ],
  debrief: `The interview question is what a read owes its callers. The state a customer sees must be the state the money is in: initiation is an event, confirmation is the fact, and only the processor can confirm — so the read derives \`refunded\` from the refund record instead of recording optimism at registration. Failures are the same argument in reverse: hiding a failed refund hides the support ticket, so the linkage travels with the return however the refund ended. The owner check is the third half of the contract: a read scoped to the order's owner answers 404 for a foreign id, because 403 confirms that the id exists. Real services add a refund-status callback so the read never polls the processor on the request path, and keep an \`order_line\` join so the page can show what was actually bought.`,
};
