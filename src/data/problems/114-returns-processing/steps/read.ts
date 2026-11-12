import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/returns/{id}: the refund attached to the return',
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'db', 'refunds'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/returns/{return_id}\`, the customer's return page:
it loads the return (\`store.return_of\`, 404 when unknown) and its refund (\`store.refund_of\`
when \`refund_id\` is set), and answers \`return_id\`, \`state\` (\`refunded\` as soon as a refund
record exists), \`grade\`, \`quantity\`, \`refund\` (\`{refund_id, state, amount_cents}\`, null when
the refund failed) and \`order_line\` (\`{order_line_id, quantity}\` from the return). It serves the
demo and hides four flaws.

**Failure mode the checks target.** A customer pastes another merchant's return id and reads it;
the page says \`refunded\` while the processor is still working, and again after it failed; a failed
refund disappears from the page, so support cannot see why; the line shows an id nobody recognizes.

- \`X-Tenant-Id\` is required (**401**); a return of another tenant is **404**, the same answer as
  one that does not exist.
- \`state\` follows the processor's record through \`REFUND_STATES\`: \`initiated\` →
  \`refund_pending\`, \`confirmed\` → \`refunded\`, \`failed\` → \`refund_failed\`; with no refund it
  is the stored state.
- \`refund\` is there for every refund the return has, failed ones included.
- \`order_line\` is the line itself (\`store.line_of\`): \`order_line_id\`, \`sku\`,
  \`ordered_quantity\`, \`delivered_at\`.`,
  sequence: {
    participants: ['Customer', 'Returns API', 'returns store'],
    messages: [
      {from: 'Customer', to: 'Returns API', label: 'GET /v1/returns/ret-7 · X-Tenant-Id', kind: 'sync'},
      {from: 'Returns API', to: 'returns store', label: 'return_of(ret-7) · tenant must match, else 404', kind: 'sync'},
      {from: 'Returns API', to: 'returns store', label: 'refund_of(refund_id) · the processor’s record', kind: 'sync'},
      {from: 'Returns API', to: 'returns store', label: 'line_of(order_line_id)', kind: 'sync'},
      {from: 'Returns API', to: 'Customer', label: '200 {state from the refund, refund, order_line}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'read-route',
      title: 'Serves GET /v1/returns/{id}',
      detail:
        'Register the read on `GET /v1/returns/{id}`; the owner of a registered return reads its state, quantity and line id.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/returns\/\{return_id\}["']/, /store\.return_of\(/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/returns\/:returnId['"]/, /returnOf\(/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/returns\/\{id\}"/, /store\.ReturnOf\(/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"returns"\s*\/\s*Segment\s*\)/, /Store\.returnOf\(/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/returns\//, /store::returnOf\(/]},
      },
    },
    {
      id: 'tenant-scope',
      title: 'Scopes the read to the caller’s tenant',
      detail:
        'The tenant comes from `X-Tenant-Id` (401 without it) and a return of another tenant answers 404, like a return that does not exist, so ids cannot be probed. The starter answers any caller.',
      match: {
        python: {all: [/x-tenant-id/i, /\b401\b/, /\[["']tenant["']\]\s*!=\s*tenant/]},
        typescript: {all: [/x-tenant-id/i, /\b401\b/, /\.tenant\s*!==\s*tenant/]},
        go: {all: [/X-Tenant-Id/i, /StatusUnauthorized|\b401\b/, /\.Tenant\s*!=\s*tenant/]},
        scala: {all: [/X-Tenant-Id/i, /Unauthorized/, /_\.tenant\s*==\s*tenant/]},
        cpp: {all: [/X-Tenant-Id/i, /\b401\b/, /->tenant\s*!=\s*tenant/]},
      },
    },
    {
      id: 'refund-state',
      title: '`refunded` means the processor confirmed it',
      detail:
        'The state comes from the refund record through `REFUND_STATES` (`initiated` → `refund_pending`, `confirmed` → `refunded`, `failed` → `refund_failed`); the starter says `refunded` once any refund record exists.',
      match: {
        python: {all: [/REFUND_STATES/, /["']confirmed["']\s*:\s*["']refunded["']/]},
        typescript: {all: [/REFUND_STATES/, /confirmed:\s*'refunded'/]},
        go: {all: [/refundStates/, /"confirmed":\s*"refunded"/]},
        scala: {all: [/RefundStates/, /"confirmed"\s*->\s*"refunded"/]},
        cpp: {all: [/kRefundStates/, /\{"confirmed",\s*"refunded"\}/]},
      },
    },
    {
      id: 'failed-refund-visible',
      title: 'Shows a failed refund with its state',
      detail:
        'The `refund` object is returned for every refund the return has, with the processor’s `state`, so a failed refund reads `failed` instead of vanishing; it is null only when no refund was ever requested.',
      match: {
        python: {all: [/store\.refund_of\(/], none: [/!=\s*["']failed["']/]},
        typescript: {all: [/refundOf\(/], none: [/!==?\s*'failed'/]},
        go: {all: [/store\.RefundOf\(/], none: [/!=\s*"failed"/]},
        scala: {all: [/Store\.refundOf\(/], none: [/!=\s*"failed"/]},
        cpp: {all: [/store::refundOf\(/], none: [/!=\s*"failed"/]},
      },
    },
    {
      id: 'order-line',
      title: 'Shows the order line itself',
      detail:
        '`order_line` is loaded with `line_of`/`lineOf` and carries `order_line_id`, `sku`, `ordered_quantity` and `delivered_at`; the starter echoes the id and the return’s own quantity.',
      match: {
        python: {all: [/store\.line_of\(/, /["']sku["']/, /["']ordered_quantity["']/, /["']delivered_at["']/]},
        typescript: {all: [/lineOf\(/, /sku:/, /ordered_quantity:/, /delivered_at:/]},
        go: {all: [/store\.LineOf\(/, /"sku"/, /"ordered_quantity"/, /"delivered_at"/]},
        scala: {all: [/Store\.lineOf\(/, /"sku"/, /"ordered_quantity"/, /"delivered_at"/]},
        cpp: {all: [/store::lineOf\(/, /"sku"/, /"ordered_quantity"/, /"delivered_at"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException, Request

from returns import store  # store.return_of, refund_of, line_of

app = FastAPI()


@app.get("/v1/returns/{return_id}")
def read_return(return_id: str, request: Request) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    ret = store.return_of(return_id)
    if ret is None:
        raise HTTPException(status_code=404, detail="no such return")
    refund = store.refund_of(ret["refund_id"]) if ret["refund_id"] else None
    shown = refund if refund is not None and refund["state"] != "failed" else None
    return {
        "return_id": return_id,
        "state": "refunded" if refund is not None else ret["state"],
        "grade": ret["grade"],
        "quantity": ret["quantity"],
        "refund": None if shown is None else {"refund_id": shown["refund_id"], "state": shown["state"], "amount_cents": shown["amount_cents"]},
        "order_line": {"order_line_id": ret["order_line_id"], "quantity": ret["quantity"]},
    }
`,
      solution: `from fastapi import FastAPI, HTTPException, Request

from returns import store  # store.return_of, refund_of, line_of

app = FastAPI()

# What the customer is told follows the refund processor's record, not the request that started it.
REFUND_STATES = {"initiated": "refund_pending", "confirmed": "refunded", "failed": "refund_failed"}


@app.get("/v1/returns/{return_id}")
def read_return(return_id: str, request: Request) -> dict:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    ret = store.return_of(return_id)
    if ret is None or ret["tenant"] != tenant:
        # Another tenant's return is answered like a missing one: ids cannot be probed.
        raise HTTPException(status_code=404, detail="no such return")
    refund = store.refund_of(ret["refund_id"]) if ret["refund_id"] else None
    line = store.line_of(ret["order_line_id"])
    return {
        "return_id": return_id,
        "state": REFUND_STATES.get(refund["state"], ret["state"]) if refund is not None else ret["state"],
        "grade": ret["grade"],
        "quantity": ret["quantity"],
        "refund": None if refund is None else {"refund_id": refund["refund_id"], "state": refund["state"], "amount_cents": refund["amount_cents"]},
        "order_line": None if line is None else {
            "order_line_id": line["order_line_id"],
            "sku": line["sku"],
            "ordered_quantity": line["ordered_quantity"],
            "delivered_at": line["delivered_at"],
        },
    }
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {lineOf, refundOf, returnOf} from 'returns/store';

export const app = Fastify();

app.get('/v1/returns/:returnId', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const {returnId} = request.params as {returnId: string};
  const ret = await returnOf(returnId);
  if (ret === null) return reply.code(404).send({error: 'no such return'});
  const refund = ret.refund_id ? await refundOf(ret.refund_id) : null;
  const shown = refund !== null && refund.state !== 'failed' ? refund : null;
  return {
    return_id: returnId,
    state: refund !== null ? 'refunded' : ret.state,
    grade: ret.grade,
    quantity: ret.quantity,
    refund: shown && {refund_id: shown.refund_id, state: shown.state, amount_cents: shown.amount_cents},
    order_line: {order_line_id: ret.order_line_id, quantity: ret.quantity},
  };
});
`,
      solution: `import Fastify from 'fastify';

import {lineOf, refundOf, returnOf} from 'returns/store';

export const app = Fastify();

// What the customer is told follows the refund processor's record, not the request that started it.
const REFUND_STATES: Record<string, string> = {initiated: 'refund_pending', confirmed: 'refunded', failed: 'refund_failed'};

app.get('/v1/returns/:returnId', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {returnId} = request.params as {returnId: string};
  const ret = await returnOf(returnId);
  // Another tenant's return is answered like a missing one: ids cannot be probed.
  if (ret === null || ret.tenant !== tenant) return reply.code(404).send({error: 'no such return'});
  const refund = ret.refund_id ? await refundOf(ret.refund_id) : null;
  const line = await lineOf(ret.order_line_id);
  return {
    return_id: returnId,
    state: refund !== null ? (REFUND_STATES[refund.state] ?? ret.state) : ret.state,
    grade: ret.grade,
    quantity: ret.quantity,
    refund: refund && {refund_id: refund.refund_id, state: refund.state, amount_cents: refund.amount_cents},
    order_line: line && {order_line_id: line.order_line_id, sku: line.sku, ordered_quantity: line.ordered_quantity, delivered_at: line.delivered_at},
  };
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"returns/store" // store.ReturnOf, RefundOf, LineOf
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func readReturn(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	ret := store.ReturnOf(r.Context(), r.PathValue("id"))
	if ret == nil {
		http.Error(rw, "no such return", http.StatusNotFound)
		return
	}
	state := ret.State
	var refund any
	if ret.RefundID != "" {
		if rf := store.RefundOf(r.Context(), ret.RefundID); rf != nil {
			state = "refunded"
			if rf.State != "failed" {
				refund = map[string]any{"refund_id": rf.RefundID, "state": rf.State, "amount_cents": rf.AmountCents}
			}
		}
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"return_id":  ret.ReturnID,
		"state":      state,
		"grade":      ret.Grade,
		"quantity":   ret.Quantity,
		"refund":     refund,
		"order_line": map[string]any{"order_line_id": ret.OrderLineID, "quantity": ret.Quantity},
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/returns/{id}", readReturn)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"

	"returns/store" // store.ReturnOf, RefundOf, LineOf
)

// refundStates: what the customer is told follows the refund processor's record, not the request that started it.
var refundStates = map[string]string{"initiated": "refund_pending", "confirmed": "refunded", "failed": "refund_failed"}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func readReturn(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	ret := store.ReturnOf(r.Context(), r.PathValue("id"))
	if ret == nil || ret.Tenant != tenant {
		// Another tenant's return is answered like a missing one: ids cannot be probed.
		http.Error(rw, "no such return", http.StatusNotFound)
		return
	}
	state := ret.State
	var refund any
	if ret.RefundID != "" {
		if rf := store.RefundOf(r.Context(), ret.RefundID); rf != nil {
			if shown, ok := refundStates[rf.State]; ok {
				state = shown
			}
			refund = map[string]any{"refund_id": rf.RefundID, "state": rf.State, "amount_cents": rf.AmountCents}
		}
	}
	var orderLine any
	if line := store.LineOf(r.Context(), ret.OrderLineID); line != nil {
		orderLine = map[string]any{"order_line_id": line.OrderLineID, "sku": line.SKU, "ordered_quantity": line.OrderedQuantity, "delivered_at": line.DeliveredAt}
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"return_id":  ret.ReturnID,
		"state":      state,
		"grade":      ret.Grade,
		"quantity":   ret.Quantity,
		"refund":     refund,
		"order_line": orderLine,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/returns/{id}", readReturn)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import returns.Store // Store.returnOf, refundOf, lineOf

object Read {
  val route: Route =
    path("v1" / "returns" / Segment) { returnId =>
      get {
        // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
        Store.returnOf(returnId) match {
          case None => complete(StatusCodes.NotFound -> "no such return")
          case Some(ret) =>
            val refund = if (ret.refundId.isEmpty) None else Store.refundOf(ret.refundId)
            val shown = refund.filter(_.state != "failed")
            val body = JsObject(
              "return_id" -> JsString(ret.returnId),
              "state" -> JsString(if (refund.isDefined) "refunded" else ret.state),
              "grade" -> JsString(ret.grade),
              "quantity" -> JsNumber(ret.quantity),
              "refund" -> shown.map(r => JsObject("refund_id" -> JsString(r.refundId), "state" -> JsString(r.state), "amount_cents" -> JsNumber(r.amountCents))).getOrElse(JsNull),
              "order_line" -> JsObject("order_line_id" -> JsString(ret.orderLineId), "quantity" -> JsNumber(ret.quantity))
            )
            complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint)))
        }
      }
    }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import returns.Store // Store.returnOf, refundOf, lineOf

object Read {
  /** What the customer is told follows the refund processor's record, not the request that started it. */
  val RefundStates: Map[String, String] = Map("initiated" -> "refund_pending", "confirmed" -> "refunded", "failed" -> "refund_failed")

  val route: Route =
    path("v1" / "returns" / Segment) { returnId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") {
          case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
          case Some(tenant) =>
            // Another tenant's return is answered like a missing one: ids cannot be probed.
            Store.returnOf(returnId).filter(_.tenant == tenant) match {
              case None => complete(StatusCodes.NotFound -> "no such return")
              case Some(ret) =>
                val refund = if (ret.refundId.isEmpty) None else Store.refundOf(ret.refundId)
                val line = Store.lineOf(ret.orderLineId)
                val body = JsObject(
                  "return_id" -> JsString(ret.returnId),
                  "state" -> JsString(refund.flatMap(r => RefundStates.get(r.state)).getOrElse(ret.state)),
                  "grade" -> JsString(ret.grade),
                  "quantity" -> JsNumber(ret.quantity),
                  "refund" -> refund.map(r => JsObject("refund_id" -> JsString(r.refundId), "state" -> JsString(r.state), "amount_cents" -> JsNumber(r.amountCents))).getOrElse(JsNull),
                  "order_line" -> line.map(l => JsObject(
                    "order_line_id" -> JsString(l.orderLineId), "sku" -> JsString(l.sku),
                    "ordered_quantity" -> JsNumber(l.orderedQuantity), "delivered_at" -> JsString(l.deliveredAt))).getOrElse(JsNull)
                )
                complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint)))
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

#include <string>

#include "returns/store.h"  // store::returnOf, refundOf, lineOf

using json = nlohmann::json;

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void read_return(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string return_id = req.matches[1];
  const auto ret = store::returnOf(return_id);
  if (!ret) return reply(res, 404, {{"error", "no such return"}});
  std::string state = ret->state;
  json refund = nullptr;
  if (!ret->refund_id.empty()) {
    if (const auto rf = store::refundOf(ret->refund_id)) {
      state = "refunded";
      if (rf->state != "failed") refund = json{{"refund_id", rf->refund_id}, {"state", rf->state}, {"amount_cents", rf->amount_cents}};
    }
  }
  reply(res, 200, {{"return_id", ret->return_id}, {"state", state}, {"grade", ret->grade}, {"quantity", ret->quantity},
                   {"refund", refund}, {"order_line", {{"order_line_id", ret->order_line_id}, {"quantity", ret->quantity}}}});
}

void register_routes(httplib::Server& svr) {
  svr.Get(R"(/v1/returns/([\\w-]+))", read_return);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <map>
#include <string>

#include "returns/store.h"  // store::returnOf, refundOf, lineOf

using json = nlohmann::json;

// What the customer is told follows the refund processor's record, not the request that started it.
const std::map<std::string, std::string> kRefundStates = {{"initiated", "refund_pending"}, {"confirmed", "refunded"}, {"failed", "refund_failed"}};

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void read_return(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, {{"error", "X-Tenant-Id is required"}});
  const std::string return_id = req.matches[1];
  const auto ret = store::returnOf(return_id);
  // Another tenant's return is answered like a missing one: ids cannot be probed.
  if (!ret || ret->tenant != tenant) return reply(res, 404, {{"error", "no such return"}});
  std::string state = ret->state;
  json refund = nullptr;
  if (!ret->refund_id.empty()) {
    if (const auto rf = store::refundOf(ret->refund_id)) {
      const auto shown = kRefundStates.find(rf->state);
      if (shown != kRefundStates.end()) state = shown->second;
      refund = json{{"refund_id", rf->refund_id}, {"state", rf->state}, {"amount_cents", rf->amount_cents}};
    }
  }
  json order_line = nullptr;
  if (const auto line = store::lineOf(ret->order_line_id)) {
    order_line = json{{"order_line_id", line->order_line_id}, {"sku", line->sku}, {"ordered_quantity", line->ordered_quantity}, {"delivered_at", line->delivered_at}};
  }
  reply(res, 200, {{"return_id", ret->return_id}, {"state", state}, {"grade", ret->grade}, {"quantity", ret->quantity},
                   {"refund", refund}, {"order_line", order_line}});
}

void register_routes(httplib::Server& svr) {
  svr.Get(R"(/v1/returns/([\\w-]+))", read_return);
}
`,
    },
  },
  harness: {
    python: `from returns import store

TENANT = "t-1"
LINE = {"order_line_id": "L1", "sku": "KETTLE-2L", "ordered_quantity": 3, "delivered_at": "2026-10-20"}


def _api(ctx):
    store.put_line({**LINE, "tenant": TENANT, "unit_price_cents": 4000, "policy_window": "standard"})
    return ctx.client(ctx.load("read").app)


def _return(return_id, state="registered", grade="", refund=None):
    """A return of 1 unit of L1 in state; refund (the processor's state) adds a refund of 4000 cents."""
    fields = {"return_id": return_id, "tenant": TENANT, "order_line_id": "L1", "quantity": 1, "reason_code": "damaged",
              "photo_ref": "photos/kettle.jpg", "state": state, "grade": grade, "refund_cents": 0, "refund_id": ""}
    if refund is not None:
        fields.update(refund_cents=4000, refund_id=f"rf-{return_id}")
        store.put_refund({"refund_id": f"rf-{return_id}", "return_id": return_id, "amount_cents": 4000, "state": refund})
    store.update_return(return_id, fields)


async def _get(c, return_id, tenant=TENANT):
    return await c.get(f"/v1/returns/{return_id}", headers={"X-Tenant-Id": tenant} if tenant else {})


async def check_read_route(ctx):
    _return("ret-1")
    async with _api(ctx) as c:
        r = await _get(c, "ret-1")
    assert r.status_code == 200, f"GET /v1/returns/ret-1 by its owner answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("return_id") == "ret-1" and body.get("state") == "registered" and body.get("quantity") == 1, f"the read answered {body}, expected ret-1, registered, quantity 1"
    assert body.get("refund") is None, f"a return with no refund shows refund {body.get('refund')}"
    assert (body.get("order_line") or {}).get("order_line_id") == "L1", f"the read's order_line is {body.get('order_line')}"


async def check_tenant_scope(ctx):
    _return("ret-1")
    async with _api(ctx) as c:
        anonymous = await _get(c, "ret-1", tenant=None)
        other = await _get(c, "ret-1", tenant="t-2")
        unknown = await _get(c, "ret-404")
    assert anonymous.status_code == 401, f"a read without X-Tenant-Id answered {anonymous.status_code}, expected 401"
    assert other.status_code == 404, f"tenant t-2 reading t-1's return answered {other.status_code}: {other.text[:120]}. Another tenant's return is 404, like one that does not exist"
    assert unknown.status_code == 404, f"an unknown return answered {unknown.status_code}, expected 404"


async def check_refund_state(ctx):
    _return("ret-1", "refund_pending", "sellable", refund="initiated")
    _return("ret-2", "refund_pending", "sellable", refund="confirmed")
    _return("ret-3", "refund_pending", "damaged", refund="failed")
    _return("ret-4", "awaiting_inspection")
    want = {"ret-1": "refund_pending", "ret-2": "refunded", "ret-3": "refund_failed", "ret-4": "awaiting_inspection"}
    processor = {"ret-1": "initiated", "ret-2": "confirmed", "ret-3": "failed", "ret-4": "no refund"}
    async with _api(ctx) as c:
        for return_id, state in want.items():
            r = await _get(c, return_id)
            assert r.status_code == 200, f"GET /v1/returns/{return_id} answered {r.status_code}: {r.text}"
            shown = r.json().get("state")
            assert shown == state, f"a return whose refund the processor reports as {processor[return_id]} reads {shown!r}, expected {state!r}: refunded means the processor confirmed it"


async def check_failed_refund_visible(ctx):
    _return("ret-1", "refund_pending", "damaged", refund="failed")
    _return("ret-2")
    async with _api(ctx) as c:
        failed = (await _get(c, "ret-1")).json()
        none = (await _get(c, "ret-2")).json()
    want = {"refund_id": "rf-ret-1", "state": "failed", "amount_cents": 4000}
    assert failed.get("refund") == want, f"a return whose refund failed shows refund {failed.get('refund')}, expected {want}: support needs to see it failed"
    assert none.get("refund") is None, f"a return with no refund shows refund {none.get('refund')}, expected null"


async def check_order_line(ctx):
    _return("ret-1")
    async with _api(ctx) as c:
        body = (await _get(c, "ret-1")).json()
    line = body.get("order_line") or {}
    assert all(line.get(k) == v for k, v in LINE.items()), f"the read's order_line is {line}, expected the line itself: {LINE}"
`,
    typescript: `const TENANT = 't-1';
const LINE = {order_line_id: 'L1', sku: 'KETTLE-2L', ordered_quantity: 3, delivered_at: '2026-10-20'};

function world(ctx) {
  const store = ctx.load('/support/returns/store.ts');
  const ready = store.putLine({...LINE, tenant: TENANT, unit_price_cents: 4000, policy_window: 'standard'});
  /** A return of 1 unit of L1 in state; refund (the processor's state) adds a refund of 4000 cents. */
  const open = async (returnId: string, state = 'registered', grade = '', refund: string | null = null) => {
    await ready;
    const fields: Record<string, string | number> = {
      return_id: returnId, tenant: TENANT, order_line_id: 'L1', quantity: 1, reason_code: 'damaged',
      photo_ref: 'photos/kettle.jpg', state, grade, refund_cents: 0, refund_id: '',
    };
    if (refund !== null) {
      fields.refund_cents = 4000;
      fields.refund_id = \`rf-\${returnId}\`;
      await store.putRefund({refund_id: \`rf-\${returnId}\`, return_id: returnId, amount_cents: 4000, state: refund});
    }
    await store.updateReturn(returnId, fields);
  };
  const c = ctx.client(ctx.load('read').app);
  const get = (returnId: string, tenant: string | null = TENANT) =>
    c.get(\`/v1/returns/\${returnId}\`, {headers: tenant === null ? {} : {'X-Tenant-Id': tenant}});
  return {open, get};
}

export async function check_read_route(ctx) {
  const {open, get} = world(ctx);
  await open('ret-1');
  const r = await get('ret-1');
  assert.equal(r.status, 200, \`GET /v1/returns/ret-1 by its owner answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.return_id === 'ret-1' && body.state === 'registered' && body.quantity === 1, \`the read answered \${r.text}, expected ret-1, registered, quantity 1\`);
  assert.equal(body.refund, null, \`a return with no refund shows refund \${JSON.stringify(body.refund)}\`);
  assert.equal(body.order_line?.order_line_id, 'L1', \`the read's order_line is \${JSON.stringify(body.order_line)}\`);
}

export async function check_tenant_scope(ctx) {
  const {open, get} = world(ctx);
  await open('ret-1');
  const anonymous = await get('ret-1', null);
  assert.equal(anonymous.status, 401, \`a read without X-Tenant-Id answered \${anonymous.status}, expected 401\`);
  const other = await get('ret-1', 't-2');
  assert.equal(other.status, 404, \`tenant t-2 reading t-1's return answered \${other.status}: \${other.text.slice(0, 120)}. Another tenant's return is 404, like one that does not exist\`);
  const unknown = await get('ret-404');
  assert.equal(unknown.status, 404, \`an unknown return answered \${unknown.status}, expected 404\`);
}

export async function check_refund_state(ctx) {
  const {open, get} = world(ctx);
  await open('ret-1', 'refund_pending', 'sellable', 'initiated');
  await open('ret-2', 'refund_pending', 'sellable', 'confirmed');
  await open('ret-3', 'refund_pending', 'damaged', 'failed');
  await open('ret-4', 'awaiting_inspection');
  const want: [string, string, string][] = [
    ['ret-1', 'refund_pending', 'initiated'],
    ['ret-2', 'refunded', 'confirmed'],
    ['ret-3', 'refund_failed', 'failed'],
    ['ret-4', 'awaiting_inspection', 'no refund'],
  ];
  for (const [returnId, state, processor] of want) {
    const r = await get(returnId);
    assert.equal(r.status, 200, \`GET /v1/returns/\${returnId} answered \${r.status}: \${r.text}\`);
    const shown = r.json().state;
    assert.equal(shown, state, \`a return whose refund the processor reports as \${processor} reads \${JSON.stringify(shown)}, expected \${JSON.stringify(state)}: refunded means the processor confirmed it\`);
  }
}

export async function check_failed_refund_visible(ctx) {
  const {open, get} = world(ctx);
  await open('ret-1', 'refund_pending', 'damaged', 'failed');
  await open('ret-2');
  const failed = (await get('ret-1')).json();
  const none = (await get('ret-2')).json();
  const want = {refund_id: 'rf-ret-1', state: 'failed', amount_cents: 4000};
  assert.deepStrictEqual(failed.refund, want, \`a return whose refund failed shows refund \${JSON.stringify(failed.refund)}, expected \${JSON.stringify(want)}: support needs to see it failed\`);
  assert.equal(none.refund, null, \`a return with no refund shows refund \${JSON.stringify(none.refund)}, expected null\`);
}

export async function check_order_line(ctx) {
  const {open, get} = world(ctx);
  await open('ret-1');
  const line = (await get('ret-1')).json().order_line ?? {};
  assert(Object.entries(LINE).every(([k, v]) => line[k] === v), \`the read's order_line is \${JSON.stringify(line)}, expected the line itself: \${JSON.stringify(LINE)}\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"net/http"

	"returns/store"

	"leetbuild/harness"
)

const readTenant = "t-1"

var readBg = context.Background()

func readAPI(ctx *harness.Ctx) *harness.HTTP {
	store.PutLine(readBg, store.OrderLine{OrderLineID: "L1", Tenant: readTenant, SKU: "KETTLE-2L", OrderedQuantity: 3, UnitPriceCents: 4000, DeliveredAt: "2026-10-20", PolicyWindow: "standard"})
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

// readOpen writes a return of 1 unit of L1 in state; a non-empty refund (the processor's state) adds a refund of 4000 cents.
func readOpen(returnID, state, grade, refund string) {
	fields := map[string]any{
		"return_id": returnID, "tenant": readTenant, "order_line_id": "L1", "quantity": 1, "reason_code": "damaged",
		"photo_ref": "photos/kettle.jpg", "state": state, "grade": grade, "refund_cents": 0, "refund_id": "",
	}
	if refund != "" {
		fields["refund_cents"] = 4000
		fields["refund_id"] = "rf-" + returnID
		store.PutRefund(readBg, store.Refund{RefundID: "rf-" + returnID, ReturnID: returnID, AmountCents: 4000, State: refund})
	}
	store.UpdateReturn(readBg, returnID, fields)
}

func readGet(c *harness.HTTP, returnID, tenant string) *harness.Response {
	if tenant == "" {
		return c.Get("/v1/returns/" + returnID)
	}
	return c.Get("/v1/returns/"+returnID, "X-Tenant-Id", tenant)
}

func readBody(r *harness.Response) map[string]any {
	var v map[string]any
	json.Unmarshal([]byte(r.Text()), &v)
	return v
}

func CheckReadRoute(ctx *harness.Ctx) {
	c := readAPI(ctx)
	readOpen("ret-1", "registered", "", "")
	r := readGet(c, "ret-1", readTenant)
	ctx.Equal(r.Status, 200, "GET /v1/returns/ret-1 by its owner (%s)", r.Text())
	body := readBody(r)
	ctx.Assert(body["return_id"] == "ret-1" && body["state"] == "registered" && body["quantity"] == float64(1), "the read answered %s, expected ret-1, registered, quantity 1", r.Text())
	ctx.Assert(body["refund"] == nil, "a return with no refund shows refund %v", body["refund"])
	line, _ := body["order_line"].(map[string]any)
	ctx.Assert(line != nil && line["order_line_id"] == "L1", "the read's order_line is %v", body["order_line"])
}

func CheckTenantScope(ctx *harness.Ctx) {
	c := readAPI(ctx)
	readOpen("ret-1", "registered", "", "")
	ctx.Equal(readGet(c, "ret-1", "").Status, 401, "a read without X-Tenant-Id")
	other := readGet(c, "ret-1", "t-2")
	ctx.Equal(other.Status, 404, "tenant t-2 reading t-1's return must get 404, like a return that does not exist (%.120s)", other.Text())
	ctx.Equal(readGet(c, "ret-404", readTenant).Status, 404, "an unknown return")
}

func CheckRefundState(ctx *harness.Ctx) {
	c := readAPI(ctx)
	readOpen("ret-1", "refund_pending", "sellable", "initiated")
	readOpen("ret-2", "refund_pending", "sellable", "confirmed")
	readOpen("ret-3", "refund_pending", "damaged", "failed")
	readOpen("ret-4", "awaiting_inspection", "", "")
	for _, tc := range [][3]string{{"ret-1", "refund_pending", "initiated"}, {"ret-2", "refunded", "confirmed"}, {"ret-3", "refund_failed", "failed"}, {"ret-4", "awaiting_inspection", "no refund"}} {
		r := readGet(c, tc[0], readTenant)
		ctx.Equal(r.Status, 200, "GET /v1/returns/%s (%s)", tc[0], r.Text())
		ctx.Equal(readBody(r)["state"], tc[1], "a return whose refund the processor reports as %s (refunded means the processor confirmed it); the state", tc[2])
	}
}

func CheckFailedRefundVisible(ctx *harness.Ctx) {
	c := readAPI(ctx)
	readOpen("ret-1", "refund_pending", "damaged", "failed")
	readOpen("ret-2", "registered", "", "")
	failed := readBody(readGet(c, "ret-1", readTenant))
	ctx.Equal(failed["refund"], map[string]any{"refund_id": "rf-ret-1", "state": "failed", "amount_cents": float64(4000)}, "a return whose refund failed must show it (support needs to see it failed); the refund")
	ctx.Assert(readBody(readGet(c, "ret-2", readTenant))["refund"] == nil, "a return with no refund must show refund null")
}

func CheckOrderLine(ctx *harness.Ctx) {
	c := readAPI(ctx)
	readOpen("ret-1", "registered", "", "")
	line, _ := readBody(readGet(c, "ret-1", readTenant))["order_line"].(map[string]any)
	ctx.Assert(line != nil && line["order_line_id"] == "L1" && line["sku"] == "KETTLE-2L" && line["ordered_quantity"] == float64(3) && line["delivered_at"] == "2026-10-20",
		"the read's order_line is %v, expected the line itself: order_line_id L1, sku KETTLE-2L, ordered_quantity 3, delivered_at 2026-10-20", line)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <array>
#include <string>

#include "returns/store.h"

namespace {

const std::string kTenant = "t-1";

harness::HTTP api(harness::Ctx& ctx) {
  store::putLine(store::OrderLine{"L1", kTenant, "KETTLE-2L", 3, 4000, "2026-10-20", "standard"});
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

// A return of 1 unit of L1 in state; a non-empty refund (the processor's state) adds a refund of 4000 cents.
void open(const std::string& return_id, const std::string& state = "registered", const std::string& grade = "", const std::string& refund = "") {
  std::map<std::string, std::string> fields = {{"return_id", return_id}, {"tenant", kTenant}, {"order_line_id", "L1"}, {"quantity", "1"},
                                               {"reason_code", "damaged"}, {"photo_ref", "photos/kettle.jpg"}, {"state", state},
                                               {"grade", grade}, {"refund_cents", "0"}, {"refund_id", ""}};
  if (!refund.empty()) {
    fields["refund_cents"] = "4000";
    fields["refund_id"] = "rf-" + return_id;
    store::putRefund(store::Refund{"rf-" + return_id, return_id, 4000, refund});
  }
  store::updateReturn(return_id, fields);
}

harness::Response get(harness::HTTP& c, const std::string& return_id, const std::string& tenant = kTenant) {
  if (tenant.empty()) return c.Get("/v1/returns/" + return_id);
  return c.Get("/v1/returns/" + return_id, "X-Tenant-Id", tenant);
}

nlohmann::json body(const harness::Response& r) {
  const auto j = nlohmann::json::parse(r.Text(), nullptr, false);
  return j.is_object() ? j : nlohmann::json::object();
}

std::string text(const nlohmann::json& j, const char* name) {
  return j.is_object() && j.contains(name) && j[name].is_string() ? j[name].get<std::string>() : "";
}

}  // namespace

void CheckReadRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  open("ret-1");
  const auto r = get(c, "ret-1");
  ctx.Equal(r.Status, 200, "GET /v1/returns/ret-1 by its owner (%s)", r.Text());
  const auto b = body(r);
  ctx.Assert(text(b, "return_id") == "ret-1" && text(b, "state") == "registered" && b.value("quantity", 0LL) == 1, "the read answered %s, expected ret-1, registered, quantity 1", r.Text());
  ctx.Assert(b.contains("refund") && b["refund"].is_null(), "a return with no refund shows refund %s", b.value("refund", nlohmann::json()).dump());
  ctx.Assert(b.contains("order_line") && text(b["order_line"], "order_line_id") == "L1", "the read's order_line is %s", b.value("order_line", nlohmann::json()).dump());
}

void CheckTenantScope(harness::Ctx& ctx) {
  auto c = api(ctx);
  open("ret-1");
  ctx.Equal(get(c, "ret-1", "").Status, 401, "a read without X-Tenant-Id");
  const auto other = get(c, "ret-1", "t-2");
  ctx.Equal(other.Status, 404, "tenant t-2 reading t-1's return must get 404, like a return that does not exist (%s)", other.Text().substr(0, 120));
  ctx.Equal(get(c, "ret-404").Status, 404, "an unknown return");
}

void CheckRefundState(harness::Ctx& ctx) {
  auto c = api(ctx);
  open("ret-1", "refund_pending", "sellable", "initiated");
  open("ret-2", "refund_pending", "sellable", "confirmed");
  open("ret-3", "refund_pending", "damaged", "failed");
  open("ret-4", "awaiting_inspection");
  const std::array<std::array<std::string, 3>, 4> cases = {{{"ret-1", "refund_pending", "initiated"},
                                                             {"ret-2", "refunded", "confirmed"},
                                                             {"ret-3", "refund_failed", "failed"},
                                                             {"ret-4", "awaiting_inspection", "no refund"}}};
  for (const auto& [return_id, state, processor] : cases) {
    const auto r = get(c, return_id);
    ctx.Equal(r.Status, 200, "GET /v1/returns/%s (%s)", return_id, r.Text());
    ctx.Equal(text(body(r), "state"), state, "a return whose refund the processor reports as %s (refunded means the processor confirmed it); the state", processor);
  }
}

void CheckFailedRefundVisible(harness::Ctx& ctx) {
  auto c = api(ctx);
  open("ret-1", "refund_pending", "damaged", "failed");
  open("ret-2");
  const auto failed = body(get(c, "ret-1"));
  const nlohmann::json want = {{"refund_id", "rf-ret-1"}, {"state", "failed"}, {"amount_cents", 4000}};
  ctx.Assert(failed.contains("refund") && failed["refund"] == want, "a return whose refund failed shows refund %s, expected %s: support needs to see it failed", failed.value("refund", nlohmann::json()).dump(), want.dump());
  const auto none = body(get(c, "ret-2"));
  ctx.Assert(none.contains("refund") && none["refund"].is_null(), "a return with no refund shows refund %s, expected null", none.value("refund", nlohmann::json()).dump());
}

void CheckOrderLine(harness::Ctx& ctx) {
  auto c = api(ctx);
  open("ret-1");
  const auto b = body(get(c, "ret-1"));
  const auto line = b.contains("order_line") ? b["order_line"] : nlohmann::json();
  ctx.Assert(text(line, "order_line_id") == "L1" && text(line, "sku") == "KETTLE-2L" && line.value("ordered_quantity", 0LL) == 3 && text(line, "delivered_at") == "2026-10-20",
             "the read's order_line is %s, expected the line itself: order_line_id L1, sku KETTLE-2L, ordered_quantity 3, delivered_at 2026-10-20", line.dump());
}
`,
  },
  hints: [
    'Paste a return id from another merchant: the page opens. Look at a return whose refund the processor has only started: it says `refunded`. Fail that refund: the refund disappears from the page.',
    'The handler never reads the tenant; the state flips to `refunded` whenever a refund record exists, whatever it says; failed refunds are filtered out; the line is rebuilt from the return.',
    'Read `X-Tenant-Id` (401), 404 unless `ret["tenant"]` matches; map the refund\'s state through `REFUND_STATES`; return every refund; build `order_line` from `store.line_of`.',
  ],
  debrief: `The read answers with the record of whoever owns each fact: the tenant check uses the return's stored tenant, the state follows the refund processor's record, and the line comes from the order line itself. That is why \`refunded\` can be trusted: it is set only when the processor confirmed, so "where is my refund?" never gets an answer the bank will contradict. Answering 404 for another tenant's return keeps ids from becoming a way to probe other merchants. Production return portals also sign the customer's view with the order's own access token rather than a tenant header alone, and show the refund's expected settlement date from the processor so the customer knows when to look again.`,
};
