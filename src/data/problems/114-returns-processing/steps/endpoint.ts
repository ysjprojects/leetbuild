import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/returns: eligibility measured, not asserted',
  concept: 'http',
  guides: ['request-boundaries'],
  file: 'api',
  focus: ['client', 'api', 'db'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/returns\` with \`X-Tenant-Id\` and
\`{order_line_id, quantity, reason_code, photo_ref}\`: it loads the line (\`store.line_of\`, 404 for
an unknown line or another tenant's), refuses a request past \`RETURN_WINDOW_DAYS\` after
\`delivered_at\` unless the body says \`eligible\`, and registers the units with
\`ledger.register_return\` (409 when fewer remain), answering 201 \`{return_id, quantity, state}\`. It
serves the demo and hides four flaws.

**Failure mode the checks target.** A customer with an extended policy is refused on day 45; a
customer whose window closed asks again with \`"eligible": true\` and gets a refund; a quantity of 0
or -2 registers, and the negative one hands units back to the line; "it was late" is a reason code,
and a damage claim needs no photo.

- The window is \`POLICY_WINDOW_DAYS\` of the line's \`policy_window\` (\`standard\` 30,
  \`extended\` 60) after \`delivered_at\`; past it is **422** with \`delivered_at\` and
  \`window_ends\`. Nothing in the body widens it.
- \`quantity\` below 1 is **400**; above what remains is **409** with \`remaining\`
  (\`ledger.remaining\`).
- \`reason_code\` is one of \`REASON_CODES\` (\`damaged\`, \`wrong_item\`, \`not_as_described\`,
  \`late_delivery\`, \`changed_mind\`), else **400**; the \`PHOTO_REQUIRED\` reasons (the first
  three) without a \`photo_ref\` are **400**.`,
  sequence: {
    participants: ['Customer', 'Returns API', 'returns store', 'Redis ledger'],
    messages: [
      {
        from: 'Customer',
        to: 'Returns API',
        label: 'POST /v1/returns · X-Tenant-Id · reason_code · photo_ref',
        kind: 'sync',
      },
      {from: 'Returns API', to: 'returns store', label: 'line_of(order_line_id)', kind: 'sync'},
      {from: 'returns store', to: 'Returns API', label: 'tenant · delivered_at · policy_window', kind: 'reply'},
      {from: 'Returns API', to: 'Returns API', label: 'reason · photo · quantity ≥ 1 → 400', kind: 'sync'},
      {from: 'Returns API', to: 'Returns API', label: 'window_ends = delivered_at + 30 | 60 days → 422', kind: 'sync'},
      {
        from: 'Returns API',
        to: 'Redis ledger',
        label: 'register_return(line, return_id, quantity, fields)',
        kind: 'sync',
      },
      {from: 'Redis ledger', to: 'Returns API', label: 'registered · or too few left → 409 {remaining}', kind: 'reply'},
      {from: 'Returns API', to: 'Customer', label: '201 {return_id, quantity, state: "registered"}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Registers a return on POST /v1/returns',
      detail:
        'Register `POST /v1/returns`; an in-window return of the caller’s own line goes through `register_return`/`registerReturn` and answers 201.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/returns["']/, /ledger\.register_return\(/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/returns['"]/, /registerReturn\(/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/returns"/, /ledger\.RegisterReturn\(/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"returns"\s*\)/, /Ledger\.registerReturn\(/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/returns"/, /ledger::registerReturn\(/]},
      },
    },
    {
      id: 'window',
      title: 'Measures the window by the line’s policy',
      detail:
        'The window end is `delivered_at` plus `POLICY_WINDOW_DAYS` of the line’s `policy_window`, and a late request is **422** carrying `delivered_at` and `window_ends`; the starter gives every line 30 days.',
      match: {
        python: {
          all: [
            /POLICY_WINDOW_DAYS\[\s*line\[\s*["']policy_window["']\s*\]\s*\]/,
            /["']window_ends["']\s*:/,
            /\b422\b/,
          ],
          none: [/RETURN_WINDOW_DAYS/],
        },
        typescript: {
          all: [/POLICY_WINDOW_DAYS\[\s*line\.policy_window\s*\]/, /window_ends:/, /\b422\b/],
          none: [/RETURN_WINDOW_DAYS/],
        },
        go: {
          all: [/policyWindowDays\[\s*line\.PolicyWindow\s*\]/, /"window_ends":/, /StatusUnprocessableEntity|\b422\b/],
          none: [/returnWindowDays/],
        },
        scala: {
          all: [/PolicyWindowDays\(\s*line\.policyWindow\s*\)/, /"window_ends"\s*->/, /UnprocessableEntity/],
          none: [/ReturnWindowDays/],
        },
        cpp: {
          all: [/kPolicyWindowDays\.at\(\s*line->policy_window\s*\)/, /\{"window_ends",/, /\b422\b/],
          none: [/kReturnWindowDays/],
        },
      },
    },
    {
      id: 'no-client-flag',
      title: 'Ignores an eligibility flag in the body',
      detail:
        'Nothing the caller sends reopens a closed window: the starter skips the window check when the body carries `eligible`, so any client can assert its way to a refund.',
      match: {
        python: {none: [/body\.eligible/]},
        typescript: {none: [/body\.eligible/]},
        go: {none: [/body\.Eligible/]},
        scala: {none: [/"eligible"/]},
        cpp: {none: [/"eligible"/]},
      },
    },
    {
      id: 'quantity',
      title: 'Takes 1 up to what remains, and says what remains',
      detail:
        'A quantity below 1 is **400** before anything is registered (a negative decrement adds units to the line), and a refused registration is **409** with `remaining` read from the ledger.',
      match: {
        python: {all: [/quantity\s*<\s*1/, /["']remaining["']\s*:\s*ledger\.remaining\(/]},
        typescript: {all: [/quantity\s*<\s*1/, /remaining:\s*await remaining\(/]},
        go: {all: [/Quantity\s*<\s*1/, /ledger\.Remaining\(/]},
        scala: {all: [/quantity\s*<\s*1/, /Ledger\.remaining\(/]},
        cpp: {all: [/quantity\s*<\s*1/, /ledger::remaining\(/]},
      },
    },
    {
      id: 'reason-photo',
      title: 'Checks the reason code and its evidence',
      detail:
        '`reason_code` must be in `REASON_CODES`, and the `PHOTO_REQUIRED` reasons need a `photo_ref`; either failure is **400**. The starter stores whatever reason it is sent.',
      match: {
        python: {all: [/REASON_CODES/, /PHOTO_REQUIRED/, /\b400\b/]},
        typescript: {all: [/REASON_CODES/, /PHOTO_REQUIRED/, /\b400\b/]},
        go: {all: [/reasonCodes\[/, /photoRequired\[/, /StatusBadRequest|\b400\b/]},
        scala: {all: [/ReasonCodes/, /PhotoRequired/, /BadRequest/]},
        cpp: {all: [/kReasonCodes/, /kPhotoRequired/, /\b400\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

from returns import ledger, store  # ledger.register_return, remaining; store.line_of, new_return_id, today, add_days

app = FastAPI()

RETURN_WINDOW_DAYS = 30


class ReturnRequest(BaseModel):
    order_line_id: str
    quantity: int
    reason_code: str
    photo_ref: str | None = None
    eligible: bool = False


@app.post("/v1/returns", status_code=201)
def create_return(body: ReturnRequest, request: Request) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    line = store.line_of(body.order_line_id)
    if line is None or line["tenant"] != tenant:
        raise HTTPException(status_code=404, detail="unknown order line")
    window_ends = store.add_days(line["delivered_at"], RETURN_WINDOW_DAYS)
    if store.today() > window_ends and not body.eligible:
        raise HTTPException(status_code=422, detail="outside the return window")
    return_id = store.new_return_id()
    fields = {"tenant": tenant, "reason_code": body.reason_code, "photo_ref": body.photo_ref or ""}
    if not ledger.register_return(body.order_line_id, return_id, body.quantity, fields):
        raise HTTPException(status_code=409, detail="quantity exceeds what remains returnable")
    return {"return_id": return_id, "quantity": body.quantity, "state": "registered"}
`,
      solution: `from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from returns import ledger, store  # ledger.register_return, remaining; store.line_of, new_return_id, today, add_days

app = FastAPI()

POLICY_WINDOW_DAYS = {"standard": 30, "extended": 60}
REASON_CODES = ("damaged", "wrong_item", "not_as_described", "late_delivery", "changed_mind")
PHOTO_REQUIRED = ("damaged", "wrong_item", "not_as_described")


class ReturnRequest(BaseModel):
    order_line_id: str
    quantity: int
    reason_code: str
    photo_ref: str | None = None


@app.post("/v1/returns", status_code=201)
def create_return(body: ReturnRequest, request: Request):
    tenant = request.headers.get("x-tenant-id", "")
    line = store.line_of(body.order_line_id)
    if line is None or line["tenant"] != tenant:
        raise HTTPException(status_code=404, detail="unknown order line")
    if body.reason_code not in REASON_CODES:
        raise HTTPException(status_code=400, detail=f"unknown reason_code {body.reason_code!r}")
    if body.reason_code in PHOTO_REQUIRED and not body.photo_ref:
        raise HTTPException(status_code=400, detail=f"reason_code {body.reason_code} requires a photo_ref")
    if body.quantity < 1:
        raise HTTPException(status_code=400, detail="quantity must be at least 1")
    # The line's own policy, measured from its delivery: nothing in the body can widen it.
    window_ends = store.add_days(line["delivered_at"], POLICY_WINDOW_DAYS[line["policy_window"]])
    if store.today() > window_ends:
        return JSONResponse(
            {"error": "outside the return window", "delivered_at": line["delivered_at"], "window_ends": window_ends},
            status_code=422,
        )
    return_id = store.new_return_id()
    fields = {"tenant": tenant, "reason_code": body.reason_code, "photo_ref": body.photo_ref or ""}
    if not ledger.register_return(body.order_line_id, return_id, body.quantity, fields):
        return JSONResponse(
            {"error": "quantity exceeds what remains returnable", "remaining": ledger.remaining(body.order_line_id)},
            status_code=409,
        )
    return {"return_id": return_id, "quantity": body.quantity, "state": "registered"}
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {registerReturn, remaining} from 'returns/ledger';
import {addDays, lineOf, newReturnId, today} from 'returns/store';

export const app = Fastify();

const RETURN_WINDOW_DAYS = 30;

interface ReturnRequest {
  order_line_id: string;
  quantity: number;
  reason_code: string;
  photo_ref?: string | null;
  eligible?: boolean;
}

app.post('/v1/returns', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  const body = request.body as ReturnRequest;
  const line = await lineOf(body.order_line_id);
  if (line === null || line.tenant !== tenant) return reply.code(404).send({error: 'unknown order line'});
  const windowEnds = addDays(line.delivered_at, RETURN_WINDOW_DAYS);
  if (today() > windowEnds && !body.eligible) return reply.code(422).send({error: 'outside the return window'});
  const returnId = await newReturnId();
  const fields = {tenant: line.tenant, reason_code: body.reason_code, photo_ref: body.photo_ref ?? ''};
  if (!(await registerReturn(body.order_line_id, returnId, body.quantity, fields))) {
    return reply.code(409).send({error: 'quantity exceeds what remains returnable'});
  }
  return reply.code(201).send({return_id: returnId, quantity: body.quantity, state: 'registered'});
});
`,
      solution: `import Fastify from 'fastify';

import {registerReturn, remaining} from 'returns/ledger';
import {addDays, lineOf, newReturnId, today} from 'returns/store';

export const app = Fastify();

const POLICY_WINDOW_DAYS: Record<string, number> = {standard: 30, extended: 60};
const REASON_CODES = ['damaged', 'wrong_item', 'not_as_described', 'late_delivery', 'changed_mind'];
const PHOTO_REQUIRED = ['damaged', 'wrong_item', 'not_as_described'];

interface ReturnRequest {
  order_line_id: string;
  quantity: number;
  reason_code: string;
  photo_ref?: string | null;
}

app.post('/v1/returns', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  const body = request.body as ReturnRequest;
  const line = await lineOf(body.order_line_id);
  if (line === null || line.tenant !== tenant) return reply.code(404).send({error: 'unknown order line'});
  if (!REASON_CODES.includes(body.reason_code)) return reply.code(400).send({error: \`unknown reason_code \${body.reason_code}\`});
  if (PHOTO_REQUIRED.includes(body.reason_code) && !body.photo_ref) {
    return reply.code(400).send({error: \`reason_code \${body.reason_code} requires a photo_ref\`});
  }
  if (!Number.isInteger(body.quantity) || body.quantity < 1) return reply.code(400).send({error: 'quantity must be at least 1'});
  // The line's own policy, measured from its delivery: nothing in the body can widen it.
  const windowEnds = addDays(line.delivered_at, POLICY_WINDOW_DAYS[line.policy_window]);
  if (today() > windowEnds) {
    return reply.code(422).send({error: 'outside the return window', delivered_at: line.delivered_at, window_ends: windowEnds});
  }
  const returnId = await newReturnId();
  const fields = {tenant: line.tenant, reason_code: body.reason_code, photo_ref: body.photo_ref ?? ''};
  if (!(await registerReturn(body.order_line_id, returnId, body.quantity, fields))) {
    return reply.code(409).send({error: 'quantity exceeds what remains returnable', remaining: await remaining(body.order_line_id)});
  }
  return reply.code(201).send({return_id: returnId, quantity: body.quantity, state: 'registered'});
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"returns/ledger" // ledger.RegisterReturn, Remaining
	"returns/store"  // store.LineOf, NewReturnID, Today, AddDays
)

const returnWindowDays = 30

type returnRequest struct {
	OrderLineID string \`json:"order_line_id"\`
	Quantity    int64  \`json:"quantity"\`
	ReasonCode  string \`json:"reason_code"\`
	PhotoRef    string \`json:"photo_ref"\`
	Eligible    bool   \`json:"eligible"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func createReturn(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	var body returnRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, "invalid body", http.StatusBadRequest)
		return
	}
	line := store.LineOf(r.Context(), body.OrderLineID)
	if line == nil || line.Tenant != tenant {
		http.Error(rw, "unknown order line", http.StatusNotFound)
		return
	}
	windowEnds := store.AddDays(line.DeliveredAt, returnWindowDays)
	if store.Today() > windowEnds && !body.Eligible {
		http.Error(rw, "outside the return window", http.StatusUnprocessableEntity)
		return
	}
	returnID := store.NewReturnID(r.Context())
	fields := map[string]string{"tenant": tenant, "reason_code": body.ReasonCode, "photo_ref": body.PhotoRef}
	ok, err := ledger.RegisterReturn(r.Context(), body.OrderLineID, returnID, body.Quantity, fields)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	if !ok {
		http.Error(rw, "quantity exceeds what remains returnable", http.StatusConflict)
		return
	}
	writeJSON(rw, http.StatusCreated, map[string]any{"return_id": returnID, "quantity": body.Quantity, "state": "registered"})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/returns", createReturn)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"

	"returns/ledger" // ledger.RegisterReturn, Remaining
	"returns/store"  // store.LineOf, NewReturnID, Today, AddDays
)

var (
	policyWindowDays = map[string]int{"standard": 30, "extended": 60}
	reasonCodes      = map[string]bool{"damaged": true, "wrong_item": true, "not_as_described": true, "late_delivery": true, "changed_mind": true}
	photoRequired    = map[string]bool{"damaged": true, "wrong_item": true, "not_as_described": true}
)

type returnRequest struct {
	OrderLineID string \`json:"order_line_id"\`
	Quantity    int64  \`json:"quantity"\`
	ReasonCode  string \`json:"reason_code"\`
	PhotoRef    string \`json:"photo_ref"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func createReturn(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	var body returnRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, "invalid body", http.StatusBadRequest)
		return
	}
	line := store.LineOf(r.Context(), body.OrderLineID)
	if line == nil || line.Tenant != tenant {
		http.Error(rw, "unknown order line", http.StatusNotFound)
		return
	}
	if !reasonCodes[body.ReasonCode] {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "unknown reason_code " + body.ReasonCode})
		return
	}
	if photoRequired[body.ReasonCode] && body.PhotoRef == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "reason_code " + body.ReasonCode + " requires a photo_ref"})
		return
	}
	if body.Quantity < 1 {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "quantity must be at least 1"})
		return
	}
	// The line's own policy, measured from its delivery: nothing in the body can widen it.
	windowEnds := store.AddDays(line.DeliveredAt, policyWindowDays[line.PolicyWindow])
	if store.Today() > windowEnds {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "outside the return window", "delivered_at": line.DeliveredAt, "window_ends": windowEnds})
		return
	}
	returnID := store.NewReturnID(r.Context())
	fields := map[string]string{"tenant": tenant, "reason_code": body.ReasonCode, "photo_ref": body.PhotoRef}
	ok, err := ledger.RegisterReturn(r.Context(), body.OrderLineID, returnID, body.Quantity, fields)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	if !ok {
		left, err := ledger.Remaining(r.Context(), body.OrderLineID)
		if err != nil {
			http.Error(rw, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(rw, http.StatusConflict, map[string]any{"error": "quantity exceeds what remains returnable", "remaining": left})
		return
	}
	writeJSON(rw, http.StatusCreated, map[string]any{"return_id": returnID, "quantity": body.Quantity, "state": "registered"})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/returns", createReturn)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import returns.{Ledger, Store} // Ledger.registerReturn, remaining; Store.lineOf, newReturnId, today, addDays

object Api {
  val ReturnWindowDays = 30L

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  val route: Route =
    path("v1" / "returns") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantHeader =>
          entity(as[String]) { raw =>
            // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
            val tenant = tenantHeader.getOrElse("")
            val body = raw.parseJson.asJsObject.fields
            val orderLineId = body.get("order_line_id").collect { case JsString(s) => s }.getOrElse("")
            val quantity = body.get("quantity").collect { case JsNumber(n) => n.toLong }.getOrElse(0L)
            val reasonCode = body.get("reason_code").collect { case JsString(s) => s }.getOrElse("")
            val photoRef = body.get("photo_ref").collect { case JsString(s) => s }.getOrElse("")
            val eligible = body.get("eligible").contains(JsTrue)
            Store.lineOf(orderLineId).filter(_.tenant == tenant) match {
              case None => complete(StatusCodes.NotFound -> "unknown order line")
              case Some(line) =>
                val windowEnds = Store.addDays(line.deliveredAt, ReturnWindowDays)
                if (Store.today() > windowEnds && !eligible) complete(StatusCodes.UnprocessableEntity -> "outside the return window")
                else {
                  val returnId = Store.newReturnId()
                  val fields = Map("tenant" -> tenant, "reason_code" -> reasonCode, "photo_ref" -> photoRef)
                  if (!Ledger.registerReturn(orderLineId, returnId, quantity, fields)) complete(StatusCodes.Conflict -> "quantity exceeds what remains returnable")
                  else complete(json(StatusCodes.Created, JsObject("return_id" -> JsString(returnId), "quantity" -> JsNumber(quantity), "state" -> JsString("registered"))))
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

import returns.{Ledger, Store} // Ledger.registerReturn, remaining; Store.lineOf, newReturnId, today, addDays

object Api {
  val PolicyWindowDays: Map[String, Long] = Map("standard" -> 30L, "extended" -> 60L)
  val ReasonCodes: Set[String] = Set("damaged", "wrong_item", "not_as_described", "late_delivery", "changed_mind")
  val PhotoRequired: Set[String] = Set("damaged", "wrong_item", "not_as_described")

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  val route: Route =
    path("v1" / "returns") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantHeader =>
          entity(as[String]) { raw =>
            val tenant = tenantHeader.getOrElse("")
            val body = raw.parseJson.asJsObject.fields
            val orderLineId = body.get("order_line_id").collect { case JsString(s) => s }.getOrElse("")
            val quantity = body.get("quantity").collect { case JsNumber(n) => n.toLong }.getOrElse(0L)
            val reasonCode = body.get("reason_code").collect { case JsString(s) => s }.getOrElse("")
            val photoRef = body.get("photo_ref").collect { case JsString(s) => s }.getOrElse("")
            Store.lineOf(orderLineId).filter(_.tenant == tenant) match {
              case None => complete(StatusCodes.NotFound -> "unknown order line")
              case Some(line) =>
                if (!ReasonCodes.contains(reasonCode)) complete(error(StatusCodes.BadRequest, s"unknown reason_code $reasonCode"))
                else if (PhotoRequired.contains(reasonCode) && photoRef.isEmpty) complete(error(StatusCodes.BadRequest, s"reason_code $reasonCode requires a photo_ref"))
                else if (quantity < 1) complete(error(StatusCodes.BadRequest, "quantity must be at least 1"))
                else {
                  // The line's own policy, measured from its delivery: nothing in the body can widen it.
                  val windowEnds = Store.addDays(line.deliveredAt, PolicyWindowDays(line.policyWindow))
                  if (Store.today() > windowEnds) {
                    complete(json(StatusCodes.UnprocessableEntity, JsObject(
                      "error" -> JsString("outside the return window"), "delivered_at" -> JsString(line.deliveredAt), "window_ends" -> JsString(windowEnds))))
                  } else {
                    val returnId = Store.newReturnId()
                    val fields = Map("tenant" -> tenant, "reason_code" -> reasonCode, "photo_ref" -> photoRef)
                    if (!Ledger.registerReturn(orderLineId, returnId, quantity, fields)) {
                      complete(json(StatusCodes.Conflict, JsObject(
                        "error" -> JsString("quantity exceeds what remains returnable"), "remaining" -> JsNumber(Ledger.remaining(orderLineId)))))
                    } else complete(json(StatusCodes.Created, JsObject("return_id" -> JsString(returnId), "quantity" -> JsNumber(quantity), "state" -> JsString("registered"))))
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

#include <map>
#include <string>

#include "returns/ledger.h"  // ledger::registerReturn, remaining
#include "returns/store.h"   // store::lineOf, newReturnId, today, addDays

using json = nlohmann::json;

constexpr long long kReturnWindowDays = 30;

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

std::string text(const json& body, const char* name) {
  return body.contains(name) && body[name].is_string() ? body[name].get<std::string>() : "";
}

void create_return(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return reply(res, 400, {{"error", "invalid body"}});
  const std::string order_line_id = text(body, "order_line_id");
  const long long quantity = body.value("quantity", 0LL);
  const auto line = store::lineOf(order_line_id);
  if (!line || line->tenant != tenant) return reply(res, 404, {{"error", "unknown order line"}});
  const std::string window_ends = store::addDays(line->delivered_at, kReturnWindowDays);
  if (store::today() > window_ends && !body.value("eligible", false)) return reply(res, 422, {{"error", "outside the return window"}});
  const std::string return_id = store::newReturnId();
  const std::map<std::string, std::string> fields = {{"tenant", tenant}, {"reason_code", text(body, "reason_code")}, {"photo_ref", text(body, "photo_ref")}};
  if (!ledger::registerReturn(order_line_id, return_id, quantity, fields)) {
    return reply(res, 409, {{"error", "quantity exceeds what remains returnable"}});
  }
  reply(res, 201, {{"return_id", return_id}, {"quantity", quantity}, {"state", "registered"}});
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/returns", create_return);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <map>
#include <set>
#include <string>

#include "returns/ledger.h"  // ledger::registerReturn, remaining
#include "returns/store.h"   // store::lineOf, newReturnId, today, addDays

using json = nlohmann::json;

const std::map<std::string, long long> kPolicyWindowDays = {{"standard", 30}, {"extended", 60}};
const std::set<std::string> kReasonCodes = {"damaged", "wrong_item", "not_as_described", "late_delivery", "changed_mind"};
const std::set<std::string> kPhotoRequired = {"damaged", "wrong_item", "not_as_described"};

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

std::string text(const json& body, const char* name) {
  return body.contains(name) && body[name].is_string() ? body[name].get<std::string>() : "";
}

void create_return(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return reply(res, 400, {{"error", "invalid body"}});
  const std::string order_line_id = text(body, "order_line_id");
  const std::string reason_code = text(body, "reason_code");
  const std::string photo_ref = text(body, "photo_ref");
  const long long quantity = body.value("quantity", 0LL);
  const auto line = store::lineOf(order_line_id);
  if (!line || line->tenant != tenant) return reply(res, 404, {{"error", "unknown order line"}});
  if (!kReasonCodes.count(reason_code)) return reply(res, 400, {{"error", "unknown reason_code " + reason_code}});
  if (kPhotoRequired.count(reason_code) && photo_ref.empty()) {
    return reply(res, 400, {{"error", "reason_code " + reason_code + " requires a photo_ref"}});
  }
  if (quantity < 1) return reply(res, 400, {{"error", "quantity must be at least 1"}});
  // The line's own policy, measured from its delivery: nothing in the body can widen it.
  const std::string window_ends = store::addDays(line->delivered_at, kPolicyWindowDays.at(line->policy_window));
  if (store::today() > window_ends) {
    return reply(res, 422, {{"error", "outside the return window"}, {"delivered_at", line->delivered_at}, {"window_ends", window_ends}});
  }
  const std::string return_id = store::newReturnId();
  const std::map<std::string, std::string> fields = {{"tenant", tenant}, {"reason_code", reason_code}, {"photo_ref", photo_ref}};
  if (!ledger::registerReturn(order_line_id, return_id, quantity, fields)) {
    return reply(res, 409, {{"error", "quantity exceeds what remains returnable"}, {"remaining", ledger::remaining(order_line_id)}});
  }
  reply(res, 201, {{"return_id", return_id}, {"quantity", quantity}, {"state", "registered"}});
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/returns", create_return);
}
`,
    },
  },
  harness: {
    python: `from returns import store

TENANT = "t-1"


def _line(line_id, days_ago, window="standard", ordered=2):
    store.put_line({
        "order_line_id": line_id, "tenant": TENANT, "sku": "KETTLE-2L", "ordered_quantity": ordered, "unit_price_cents": 4000,
        "delivered_at": store.add_days(store.today(), -days_ago), "policy_window": window,
    })


def _api(ctx):
    return ctx.client(ctx.load("api").app)


async def _post(c, line_id, quantity=1, reason="changed_mind", photo=None, tenant=TENANT, **extra):
    body = {"order_line_id": line_id, "quantity": quantity, "reason_code": reason, **extra}
    if photo is not None:
        body["photo_ref"] = photo
    return await c.post("/v1/returns", json=body, headers={"X-Tenant-Id": tenant})


def _left(ctx, line_id):
    return int(ctx.redis.get(f"line:{line_id}:returnable") or 0)


def _json(r):
    try:
        return r.json()
    except ValueError:
        return {}


async def check_route(ctx):
    _line("L1", 3)
    async with _api(ctx) as c:
        r = await _post(c, "L1")
        assert r.status_code == 201, f"POST /v1/returns for a line delivered 3 days ago answered {r.status_code}: {r.text}"
        body = r.json()
        assert body.get("quantity") == 1 and body.get("state") == "registered" and body.get("return_id"), f"the 201 must carry return_id, quantity 1 and state registered, got {body}"
        record = ctx.redis.hgetall(f"return:{body['return_id']}")
        assert record.get("order_line_id") == "L1" and record.get("tenant") == TENANT and record.get("state") == "registered", f"return:{body['return_id']} holds {record}"
        assert _left(ctx, "L1") == 1, f"the line has {_left(ctx, 'L1')} returnable units after a return of 1 of 2"
        other = await _post(c, "L1", tenant="t-2")
        assert other.status_code == 404, f"another tenant's order line answered {other.status_code}, expected 404"
        unknown = await _post(c, "L-404")
    assert unknown.status_code == 404, f"an unknown order line answered {unknown.status_code}, expected 404"


async def check_window(ctx):
    _line("L-ext", 45, "extended")
    _line("L-30", 30)
    _line("L-31", 31)
    async with _api(ctx) as c:
        r = await _post(c, "L-ext")
        assert r.status_code == 201, f"an extended line delivered 45 days ago (a 60-day window) answered {r.status_code}: {r.text}. The window is the line's policy_window"
        r = await _post(c, "L-30")
        assert r.status_code == 201, f"a standard line delivered 30 days ago is on the last day of its window; it answered {r.status_code}: {r.text}"
        r = await _post(c, "L-31")
    assert r.status_code == 422, f"a standard line delivered 31 days ago answered {r.status_code}, expected 422"
    delivered = store.line_of("L-31")["delivered_at"]
    body = _json(r)
    assert body.get("delivered_at") == delivered and body.get("window_ends") == store.add_days(delivered, 30), f"the 422 must carry delivered_at {delivered} and window_ends {store.add_days(delivered, 30)}, got {r.text}"
    assert _left(ctx, "L-31") == 2, "a return outside the window took units from the line"


async def check_no_client_flag(ctx):
    _line("L1", 40)
    async with _api(ctx) as c:
        r = await _post(c, "L1", eligible=True)
    assert r.status_code == 422, f"a standard line delivered 40 days ago answered {r.status_code} to a body carrying eligible: true: the caller reopened a closed window. Eligibility comes from the line, not the request"
    assert _left(ctx, "L1") == 2 and not ctx.redis.keys("return:ret-*"), f"the refused return still took units ({_left(ctx, 'L1')} of 2 left) or left a record"


async def check_quantity(ctx):
    _line("L1", 3, ordered=2)
    async with _api(ctx) as c:
        for bad in (0, -2):
            r = await _post(c, "L1", quantity=bad)
            assert r.status_code == 400, f"quantity {bad} answered {r.status_code}, expected 400"
            assert _left(ctx, "L1") == 2, f"quantity {bad} left the line with {_left(ctx, 'L1')} returnable units of 2: a negative return hands units back"
        r = await _post(c, "L1", quantity=3)
        assert r.status_code == 409 and _json(r).get("remaining") == 2, f"3 units of a line with 2 returnable answered {r.status_code} {r.text}, expected 409 with remaining 2"
        r = await _post(c, "L1", quantity=2)
        assert r.status_code == 201, f"2 units of a line with 2 returnable answered {r.status_code}: {r.text}"
        r = await _post(c, "L1", quantity=1)
    assert r.status_code == 409 and _json(r).get("remaining") == 0, f"a line with nothing left answered {r.status_code} {r.text}, expected 409 with remaining 0"


async def check_reason_photo(ctx):
    _line("L1", 3, ordered=5)
    async with _api(ctx) as c:
        r = await _post(c, "L1", reason="it_was_late")
        assert r.status_code == 400, f"reason_code it_was_late answered {r.status_code}, expected 400: the reason codes are a fixed set"
        r = await _post(c, "L1", reason="damaged")
        assert r.status_code == 400, f"a damaged claim without a photo_ref answered {r.status_code}, expected 400"
        assert _left(ctx, "L1") == 5, f"a refused claim took units: {_left(ctx, 'L1')} of 5 left"
        r = await _post(c, "L1", reason="damaged", photo="photos/kettle-dent.jpg")
        assert r.status_code == 201, f"a damaged claim with a photo answered {r.status_code}: {r.text}"
        stored = ctx.redis.hget(f"return:{r.json()['return_id']}", "photo_ref")
        assert stored == "photos/kettle-dent.jpg", f"the return records photo_ref {stored!r}"
        r = await _post(c, "L1", reason="late_delivery")
    assert r.status_code == 201, f"late_delivery needs no photo; it answered {r.status_code}: {r.text}"
`,
    typescript: `const TENANT = 't-1';

function world(ctx) {
  const m = ctx.load('api');
  const store = ctx.load('/support/returns/store.ts');
  const line = (lineId: string, daysAgo: number, window = 'standard', ordered = 2) =>
    store.putLine({
      order_line_id: lineId, tenant: TENANT, sku: 'KETTLE-2L', ordered_quantity: ordered, unit_price_cents: 4000,
      delivered_at: store.addDays(store.today(), -daysAgo), policy_window: window,
    });
  return {c: ctx.client(m.app), store, line};
}

function post(c, lineId: string, opts: {quantity?: number; reason?: string; photo?: string; tenant?: string; extra?: object} = {}) {
  const body: Record<string, unknown> = {order_line_id: lineId, quantity: opts.quantity ?? 1, reason_code: opts.reason ?? 'changed_mind', ...opts.extra};
  if (opts.photo !== undefined) body.photo_ref = opts.photo;
  return c.post('/v1/returns', {json: body, headers: {'X-Tenant-Id': opts.tenant ?? TENANT}});
}

const left = (ctx, lineId: string): number => Number(ctx.redis.get(\`line:\${lineId}:returnable\`) ?? 0);

function json(r) {
  try {
    return r.json();
  } catch {
    return {};
  }
}

export async function check_route(ctx) {
  const {c, line} = world(ctx);
  await line('L1', 3);
  const r = await post(c, 'L1');
  assert.equal(r.status, 201, \`POST /v1/returns for a line delivered 3 days ago answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.quantity === 1 && body.state === 'registered' && body.return_id, \`the 201 must carry return_id, quantity 1 and state registered, got \${r.text}\`);
  const record = ctx.redis.hgetall(\`return:\${body.return_id}\`);
  assert(record.order_line_id === 'L1' && record.tenant === TENANT && record.state === 'registered', \`return:\${body.return_id} holds \${JSON.stringify(record)}\`);
  assert.equal(left(ctx, 'L1'), 1, 'the line must have 1 returnable unit after a return of 1 of 2');
  const other = await post(c, 'L1', {tenant: 't-2'});
  assert.equal(other.status, 404, \`another tenant's order line answered \${other.status}, expected 404\`);
  const unknown = await post(c, 'L-404');
  assert.equal(unknown.status, 404, \`an unknown order line answered \${unknown.status}, expected 404\`);
}

export async function check_window(ctx) {
  const {c, store, line} = world(ctx);
  await line('L-ext', 45, 'extended');
  await line('L-30', 30);
  await line('L-31', 31);
  let r = await post(c, 'L-ext');
  assert.equal(r.status, 201, \`an extended line delivered 45 days ago (a 60-day window) answered \${r.status}: \${r.text}. The window is the line's policy_window\`);
  r = await post(c, 'L-30');
  assert.equal(r.status, 201, \`a standard line delivered 30 days ago is on the last day of its window; it answered \${r.status}: \${r.text}\`);
  r = await post(c, 'L-31');
  assert.equal(r.status, 422, \`a standard line delivered 31 days ago answered \${r.status}, expected 422\`);
  const delivered = (await store.lineOf('L-31')).delivered_at;
  const body = json(r);
  assert(body.delivered_at === delivered && body.window_ends === store.addDays(delivered, 30), \`the 422 must carry delivered_at \${delivered} and window_ends \${store.addDays(delivered, 30)}, got \${r.text}\`);
  assert.equal(left(ctx, 'L-31'), 2, 'a return outside the window took units from the line');
}

export async function check_no_client_flag(ctx) {
  const {c, line} = world(ctx);
  await line('L1', 40);
  const r = await post(c, 'L1', {extra: {eligible: true}});
  assert.equal(r.status, 422, \`a standard line delivered 40 days ago answered \${r.status} to a body carrying eligible: true: the caller reopened a closed window. Eligibility comes from the line, not the request\`);
  assert(left(ctx, 'L1') === 2 && ctx.redis.keys('return:ret-*').length === 0, \`the refused return still took units (\${left(ctx, 'L1')} of 2 left) or left a record\`);
}

export async function check_quantity(ctx) {
  const {c, line} = world(ctx);
  await line('L1', 3, 'standard', 2);
  for (const bad of [0, -2]) {
    const r = await post(c, 'L1', {quantity: bad});
    assert.equal(r.status, 400, \`quantity \${bad} answered \${r.status}, expected 400\`);
    assert.equal(left(ctx, 'L1'), 2, \`quantity \${bad} changed the line's returnable units: a negative return hands units back\`);
  }
  let r = await post(c, 'L1', {quantity: 3});
  assert(r.status === 409 && json(r).remaining === 2, \`3 units of a line with 2 returnable answered \${r.status} \${r.text}, expected 409 with remaining 2\`);
  r = await post(c, 'L1', {quantity: 2});
  assert.equal(r.status, 201, \`2 units of a line with 2 returnable answered \${r.status}: \${r.text}\`);
  r = await post(c, 'L1', {quantity: 1});
  assert(r.status === 409 && json(r).remaining === 0, \`a line with nothing left answered \${r.status} \${r.text}, expected 409 with remaining 0\`);
}

export async function check_reason_photo(ctx) {
  const {c, line} = world(ctx);
  await line('L1', 3, 'standard', 5);
  let r = await post(c, 'L1', {reason: 'it_was_late'});
  assert.equal(r.status, 400, \`reason_code it_was_late answered \${r.status}, expected 400: the reason codes are a fixed set\`);
  r = await post(c, 'L1', {reason: 'damaged'});
  assert.equal(r.status, 400, \`a damaged claim without a photo_ref answered \${r.status}, expected 400\`);
  assert.equal(left(ctx, 'L1'), 5, 'a refused claim took units from the line');
  r = await post(c, 'L1', {reason: 'damaged', photo: 'photos/kettle-dent.jpg'});
  assert.equal(r.status, 201, \`a damaged claim with a photo answered \${r.status}: \${r.text}\`);
  const stored = ctx.redis.hget(\`return:\${r.json().return_id}\`, 'photo_ref');
  assert.equal(stored, 'photos/kettle-dent.jpg', \`the return records photo_ref \${JSON.stringify(stored)}\`);
  r = await post(c, 'L1', {reason: 'late_delivery'});
  assert.equal(r.status, 201, \`late_delivery needs no photo; it answered \${r.status}: \${r.text}\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"

	"returns/store"

	"leetbuild/harness"
)

const apiTenant = "t-1"

var apiBg = context.Background()

func apiLine(lineID string, daysAgo int, window string, ordered int64) {
	store.PutLine(apiBg, store.OrderLine{
		OrderLineID: lineID, Tenant: apiTenant, SKU: "KETTLE-2L", OrderedQuantity: ordered, UnitPriceCents: 4000,
		DeliveredAt: store.AddDays(store.Today(), -daysAgo), PolicyWindow: window,
	})
}

func api(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func apiPost(c *harness.HTTP, lineID string, quantity int, reason, photo, tenant string, extra map[string]any) *harness.Response {
	body := map[string]any{"order_line_id": lineID, "quantity": quantity, "reason_code": reason}
	if photo != "" {
		body["photo_ref"] = photo
	}
	for k, v := range extra {
		body[k] = v
	}
	return c.Post("/v1/returns", body, "X-Tenant-Id", tenant)
}

func apiJSON(r *harness.Response) map[string]any {
	var v map[string]any
	json.Unmarshal([]byte(r.Text()), &v)
	return v
}

func apiLeft(ctx *harness.Ctx, lineID string) int {
	v, _ := ctx.Redis.Get("line:" + lineID + ":returnable")
	n, _ := strconv.Atoi(v)
	return n
}

func CheckRoute(ctx *harness.Ctx) {
	apiLine("L1", 3, "standard", 2)
	c := api(ctx)
	r := apiPost(c, "L1", 1, "changed_mind", "", apiTenant, nil)
	ctx.Equal(r.Status, 201, "POST /v1/returns for a line delivered 3 days ago (%s)", r.Text())
	body := apiJSON(r)
	returnID, _ := body["return_id"].(string)
	ctx.Assert(body["quantity"] == float64(1) && body["state"] == "registered" && returnID != "", "the 201 must carry return_id, quantity 1 and state registered, got %s", r.Text())
	record := ctx.Redis.HGetAll("return:" + returnID)
	ctx.Assert(record["order_line_id"] == "L1" && record["tenant"] == apiTenant && record["state"] == "registered", "return:%s holds %v", returnID, record)
	ctx.Equal(apiLeft(ctx, "L1"), 1, "the line's returnable units after a return of 1 of 2")
	other := apiPost(c, "L1", 1, "changed_mind", "", "t-2", nil)
	ctx.Equal(other.Status, 404, "another tenant's order line")
	unknown := apiPost(c, "L-404", 1, "changed_mind", "", apiTenant, nil)
	ctx.Equal(unknown.Status, 404, "an unknown order line")
}

func CheckWindow(ctx *harness.Ctx) {
	apiLine("L-ext", 45, "extended", 2)
	apiLine("L-30", 30, "standard", 2)
	apiLine("L-31", 31, "standard", 2)
	c := api(ctx)
	r := apiPost(c, "L-ext", 1, "changed_mind", "", apiTenant, nil)
	ctx.Equal(r.Status, 201, "an extended line delivered 45 days ago (a 60-day window) must be returnable: the window is the line's policy_window (%s)", r.Text())
	r = apiPost(c, "L-30", 1, "changed_mind", "", apiTenant, nil)
	ctx.Equal(r.Status, 201, "a standard line delivered 30 days ago is on the last day of its window (%s)", r.Text())
	r = apiPost(c, "L-31", 1, "changed_mind", "", apiTenant, nil)
	ctx.Equal(r.Status, 422, "a standard line delivered 31 days ago")
	delivered := store.LineOf(apiBg, "L-31").DeliveredAt
	body := apiJSON(r)
	ctx.Assert(body["delivered_at"] == delivered && body["window_ends"] == store.AddDays(delivered, 30), "the 422 must carry delivered_at %s and window_ends %s, got %s", delivered, store.AddDays(delivered, 30), r.Text())
	ctx.Equal(apiLeft(ctx, "L-31"), 2, "a return outside the window must not take units; the line's returnable units")
}

func CheckNoClientFlag(ctx *harness.Ctx) {
	apiLine("L1", 40, "standard", 2)
	r := apiPost(api(ctx), "L1", 1, "changed_mind", "", apiTenant, map[string]any{"eligible": true})
	ctx.Equal(r.Status, 422, "a standard line delivered 40 days ago, asked with eligible: true in the body (the caller reopened a closed window; eligibility comes from the line, not the request)")
	ctx.Assert(apiLeft(ctx, "L1") == 2 && len(ctx.Redis.Keys("return:ret-*")) == 0, "the refused return still took units (%d of 2 left) or left a record", apiLeft(ctx, "L1"))
}

func CheckQuantity(ctx *harness.Ctx) {
	apiLine("L1", 3, "standard", 2)
	c := api(ctx)
	for _, bad := range []int{0, -2} {
		r := apiPost(c, "L1", bad, "changed_mind", "", apiTenant, nil)
		ctx.Equal(r.Status, 400, "quantity %d", bad)
		ctx.Equal(apiLeft(ctx, "L1"), 2, "quantity %d must leave the line alone (a negative return hands units back); the returnable units", bad)
	}
	r := apiPost(c, "L1", 3, "changed_mind", "", apiTenant, nil)
	ctx.Assert(r.Status == 409 && apiJSON(r)["remaining"] == float64(2), "3 units of a line with 2 returnable answered %d %s, expected 409 with remaining 2", r.Status, r.Text())
	r = apiPost(c, "L1", 2, "changed_mind", "", apiTenant, nil)
	ctx.Equal(r.Status, 201, "2 units of a line with 2 returnable (%s)", r.Text())
	r = apiPost(c, "L1", 1, "changed_mind", "", apiTenant, nil)
	ctx.Assert(r.Status == 409 && apiJSON(r)["remaining"] == float64(0), "a line with nothing left answered %d %s, expected 409 with remaining 0", r.Status, r.Text())
}

func CheckReasonPhoto(ctx *harness.Ctx) {
	apiLine("L1", 3, "standard", 5)
	c := api(ctx)
	r := apiPost(c, "L1", 1, "it_was_late", "", apiTenant, nil)
	ctx.Equal(r.Status, 400, "reason_code it_was_late (the reason codes are a fixed set)")
	r = apiPost(c, "L1", 1, "damaged", "", apiTenant, nil)
	ctx.Equal(r.Status, 400, "a damaged claim without a photo_ref")
	ctx.Equal(apiLeft(ctx, "L1"), 5, "a refused claim must not take units; the returnable units")
	r = apiPost(c, "L1", 1, "damaged", "photos/kettle-dent.jpg", apiTenant, nil)
	ctx.Equal(r.Status, 201, "a damaged claim with a photo (%s)", r.Text())
	returnID, _ := apiJSON(r)["return_id"].(string)
	stored, _ := ctx.Redis.HGet("return:"+returnID, "photo_ref")
	ctx.Equal(stored, "photos/kettle-dent.jpg", "the return's photo_ref")
	r = apiPost(c, "L1", 1, "late_delivery", "", apiTenant, nil)
	ctx.Equal(r.Status, 201, "late_delivery needs no photo (%s)", r.Text())
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>

#include "returns/store.h"

namespace {

const std::string kTenant = "t-1";

void line(const std::string& line_id, long long days_ago, const std::string& window = "standard", long long ordered = 2) {
  store::putLine(store::OrderLine{line_id, kTenant, "KETTLE-2L", ordered, 4000, store::addDays(store::today(), -days_ago), window});
}

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response post(harness::HTTP& c, const std::string& line_id, long long quantity = 1, const std::string& reason = "changed_mind",
                       const std::string& photo = "", const std::string& tenant = kTenant, bool eligible = false) {
  nlohmann::json body = {{"order_line_id", line_id}, {"quantity", quantity}, {"reason_code", reason}};
  if (!photo.empty()) body["photo_ref"] = photo;
  if (eligible) body["eligible"] = true;
  return c.Post("/v1/returns", body.dump(), "Content-Type", "application/json", "X-Tenant-Id", tenant);
}

nlohmann::json body(const harness::Response& r) {
  const auto j = nlohmann::json::parse(r.Text(), nullptr, false);
  return j.is_object() ? j : nlohmann::json::object();
}

long long left(harness::Ctx& ctx, const std::string& line_id) {
  const auto v = ctx.Redis.Get("line:" + line_id + ":returnable");
  return v ? std::stoll(*v) : 0;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  line("L1", 3);
  auto c = api(ctx);
  const auto r = post(c, "L1");
  ctx.Equal(r.Status, 201, "POST /v1/returns for a line delivered 3 days ago (%s)", r.Text());
  const auto b = body(r);
  const std::string return_id = b.value("return_id", "");
  ctx.Assert(b.value("quantity", 0LL) == 1 && b.value("state", "") == "registered" && !return_id.empty(), "the 201 must carry return_id, quantity 1 and state registered, got %s", r.Text());
  auto record = ctx.Redis.HGetAll("return:" + return_id);
  ctx.Assert(record["order_line_id"] == "L1" && record["tenant"] == kTenant && record["state"] == "registered", "return:%s holds order_line_id %q, tenant %q, state %q", return_id, record["order_line_id"], record["tenant"], record["state"]);
  ctx.Equal(left(ctx, "L1"), 1, "the line's returnable units after a return of 1 of 2");
  ctx.Equal(post(c, "L1", 1, "changed_mind", "", "t-2").Status, 404, "another tenant's order line");
  ctx.Equal(post(c, "L-404").Status, 404, "an unknown order line");
}

void CheckWindow(harness::Ctx& ctx) {
  line("L-ext", 45, "extended");
  line("L-30", 30);
  line("L-31", 31);
  auto c = api(ctx);
  auto r = post(c, "L-ext");
  ctx.Equal(r.Status, 201, "an extended line delivered 45 days ago (a 60-day window) must be returnable: the window is the line's policy_window (%s)", r.Text());
  r = post(c, "L-30");
  ctx.Equal(r.Status, 201, "a standard line delivered 30 days ago is on the last day of its window (%s)", r.Text());
  r = post(c, "L-31");
  ctx.Equal(r.Status, 422, "a standard line delivered 31 days ago");
  const std::string delivered = store::lineOf("L-31")->delivered_at;
  const auto b = body(r);
  ctx.Assert(b.value("delivered_at", "") == delivered && b.value("window_ends", "") == store::addDays(delivered, 30), "the 422 must carry delivered_at %s and window_ends %s, got %s", delivered, store::addDays(delivered, 30), r.Text());
  ctx.Equal(left(ctx, "L-31"), 2, "a return outside the window must not take units; the line's returnable units");
}

void CheckNoClientFlag(harness::Ctx& ctx) {
  line("L1", 40);
  auto c = api(ctx);
  const auto r = post(c, "L1", 1, "changed_mind", "", kTenant, true);
  ctx.Equal(r.Status, 422, "a standard line delivered 40 days ago, asked with eligible: true in the body (the caller reopened a closed window; eligibility comes from the line, not the request)");
  ctx.Assert(left(ctx, "L1") == 2 && ctx.Redis.Keys("return:ret-*").empty(), "the refused return still took units (%d of 2 left) or left a record", left(ctx, "L1"));
}

void CheckQuantity(harness::Ctx& ctx) {
  line("L1", 3, "standard", 2);
  auto c = api(ctx);
  for (const long long bad : {0LL, -2LL}) {
    const auto r = post(c, "L1", bad);
    ctx.Equal(r.Status, 400, "quantity %d", bad);
    ctx.Equal(left(ctx, "L1"), 2, "quantity %d must leave the line alone (a negative return hands units back); the returnable units", bad);
  }
  auto r = post(c, "L1", 3);
  ctx.Assert(r.Status == 409 && body(r).value("remaining", -1LL) == 2, "3 units of a line with 2 returnable answered %d %s, expected 409 with remaining 2", r.Status, r.Text());
  r = post(c, "L1", 2);
  ctx.Equal(r.Status, 201, "2 units of a line with 2 returnable (%s)", r.Text());
  r = post(c, "L1", 1);
  ctx.Assert(r.Status == 409 && body(r).value("remaining", -1LL) == 0, "a line with nothing left answered %d %s, expected 409 with remaining 0", r.Status, r.Text());
}

void CheckReasonPhoto(harness::Ctx& ctx) {
  line("L1", 3, "standard", 5);
  auto c = api(ctx);
  ctx.Equal(post(c, "L1", 1, "it_was_late").Status, 400, "reason_code it_was_late (the reason codes are a fixed set)");
  ctx.Equal(post(c, "L1", 1, "damaged").Status, 400, "a damaged claim without a photo_ref");
  ctx.Equal(left(ctx, "L1"), 5, "a refused claim must not take units; the returnable units");
  auto r = post(c, "L1", 1, "damaged", "photos/kettle-dent.jpg");
  ctx.Equal(r.Status, 201, "a damaged claim with a photo (%s)", r.Text());
  ctx.Equal(ctx.Redis.HGet("return:" + body(r).value("return_id", ""), "photo_ref").value_or(""), "photos/kettle-dent.jpg", "the return's photo_ref");
  r = post(c, "L1", 1, "late_delivery");
  ctx.Equal(r.Status, 201, "late_delivery needs no photo (%s)", r.Text());
}
`,
  },
  hints: [
    'A customer on an extended policy is refused on day 45, while one whose window closed weeks ago gets through by adding `"eligible": true`; a return of -2 units leaves the line with more to return than was ordered.',
    'The window comes from one constant for every line and is skipped when the body says so; `quantity` and `reason_code` go to `register_return` unchecked, and the script subtracts whatever it is given.',
    'Read `POLICY_WINDOW_DAYS[line["policy_window"]]`, drop `eligible`, 422 with `delivered_at` and `window_ends`; 400 for a quantity below 1, an unknown reason or a missing photo; 409 with `ledger.remaining(...)`.',
  ],
  debrief: `Every input that decides money now comes from a record the server owns: the window from the line's delivery date and policy, the remaining units from the ledger, the reason from a fixed set. The guards all answer before \`register_return\`, so a refused request leaves no record and no decrement behind, and the 422 and 409 bodies tell the customer exactly why. The quantity guard matters more than it looks: the script subtracts whatever it is given, so a negative number is a way to mint returnable units. Production return portals load the windows per market and product category from configuration, keep the reason codes in a table that says which need evidence, and let support grant an exception through an audited override, never a field in the customer's request.`,
};
