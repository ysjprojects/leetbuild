import type {Step} from '@/lib/types';

export const refundEndpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/refunds: no more than was paid, once per key',
  concept: 'http',
  guides: ['request-boundaries', 'idempotent-requests'],
  file: 'api',
  focus: ['client', 'api', 'ledger', 'records'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/refunds\` with body
\`{"payment_id": "pay_1", "amount_minor": 2500, "reason_code": "damaged"}\` on the refund records
(\`refunds.records\`, provided): it reads \`X-Tenant-Id\`, looks the payment up with
\`find_payment\`, writes a \`PENDING\` row with \`insert_refund\` and answers **201** with the row and
\`remaining_minor = paid_minor - amount_minor\`. It serves the demo and hides four flaws.

**Failure mode the checks target.** A caller with no tenant, or with another merchant's payment id,
gets a refund; a negative amount goes through; a payment refunds more than it collected; and a
client that retries after a timeout is refunded twice.

- Tenant from \`X-Tenant-Id\` (**401** when missing); a payment owned by another tenant answers
  **404**, the same as a missing one.
- \`amount_minor\` is at least **1** and \`reason_code\` one of \`REASON_CODES\` (\`damaged\`,
  \`not_received\`, \`duplicate\`, \`goodwill\`): **400** otherwise.
- The amount is claimed with \`ledger.claim(payment_id, refund_id, amount_minor, paid_minor)\`
  (step 2, provided as \`refunds.ledger\`); a refused claim is **422** with \`remaining_minor\` and
  writes no row.
- \`Idempotency-Key\` is required (**400**). Look \`(tenant, key)\` up with \`refund_for_key\` before
  claiming, answer the first refund on a replay, and pass the key to \`insert_refund\`.`,
  sequence: {
    participants: ['Merchant client', 'Refund API', 'refund records', 'Redis ledger'],
    messages: [
      {
        from: 'Merchant client',
        to: 'Refund API',
        label: 'POST /v1/refunds · X-Tenant-Id · Idempotency-Key',
        kind: 'sync',
      },
      {from: 'Refund API', to: 'Refund API', label: '401 · 400 key, amount, reason_code', kind: 'sync'},
      {from: 'Refund API', to: 'refund records', label: 'refund_for_key(tenant, key) · find_payment', kind: 'sync'},
      {from: 'refund records', to: 'Refund API', label: 'first refund (replay) · owner, paid_minor', kind: 'reply'},
      {from: 'Refund API', to: 'Redis ledger', label: 'claim(payment, refund_id, amount, paid_minor)', kind: 'sync'},
      {from: 'Redis ledger', to: 'Refund API', label: 'accepted · remaining_minor | refused → 422', kind: 'reply'},
      {from: 'Refund API', to: 'refund records', label: 'insert_refund(…, key) · PENDING', kind: 'sync'},
      {from: 'Refund API', to: 'Merchant client', label: '201 {refund_id, status, remaining_minor}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/refunds',
      detail:
        'A valid request answers **201** with the refund id, `PENDING` and `remaining_minor`, and the row is in the records.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/refunds["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/refunds['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/refunds"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"refunds"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/refunds"/]},
      },
    },
    {
      id: 'tenant-scope',
      title: 'Authenticates the tenant and 404s a foreign payment',
      detail:
        'No `X-Tenant-Id` is **401**; a payment of another tenant is **404** like a missing one; neither writes a row or touches the ledger. The starter refunds any payment for anyone.',
      match: {
        python: {
          all: [/\b401\b/, /payment\[["']tenant["']\]\s*!=\s*tenant|tenant\s*!=\s*payment\[["']tenant["']\]/],
        },
        typescript: {all: [/\b401\b/, /payment\.tenant\s*!==?\s*tenant|tenant\s*!==?\s*payment\.tenant/]},
        go: {all: [/StatusUnauthorized|\b401\b/, /payment\.Tenant\s*!=\s*tenant|tenant\s*!=\s*payment\.Tenant/]},
        scala: {
          all: [/Unauthorized|\b401\b/, /\.tenant\s*!=\s*tenant|tenant\s*!=\s*\w+\.tenant|\.tenant\s*==\s*tenant/],
        },
        cpp: {all: [/\b401\b/, /payment->tenant\s*!=\s*tenant|tenant\s*!=\s*payment->tenant/]},
      },
    },
    {
      id: 'amount-valid',
      title: 'Refuses a zero or negative amount and an unknown reason with 400',
      detail:
        '`amount_minor` below 1, or a `reason_code` outside `REASON_CODES`, answers **400** and writes nothing. The starter takes -2500 as a refund that grows the balance.',
      match: {
        python: {all: [/amount_minor\s*<\s*1|amount_minor\s*<=\s*0/, /REASON_CODES/]},
        typescript: {all: [/amount_minor\s*<\s*1|amount_minor\s*<=\s*0/, /REASON_CODES/]},
        go: {all: [/AmountMinor\s*<\s*1|AmountMinor\s*<=\s*0/, /reasonCodes/]},
        scala: {all: [/amountMinor\s*<\s*1|amountMinor\s*<=\s*0/, /ReasonCodes/]},
        cpp: {all: [/amount_minor\s*<\s*1|amount_minor\s*<=\s*0/, /kReasonCodes/]},
      },
    },
    {
      id: 'cap',
      title: 'Claims the amount against the payment total, 422 above it',
      detail:
        'The amount is claimed through `ledger.claim` with `paid_minor` as the cap; a refused claim answers **422** with `remaining_minor` and writes no row. The starter does not ask the ledger.',
      match: {
        python: {all: [/ledger\.claim\(/, /\b422\b/]},
        typescript: {all: [/\bclaim\(/, /\b422\b/]},
        go: {all: [/ledger\.Claim\(/, /StatusUnprocessableEntity|\b422\b/]},
        scala: {all: [/Ledger\.claim\(/, /UnprocessableEntity|\b422\b/]},
        cpp: {all: [/ledger::claim\(/, /\b422\b/]},
      },
    },
    {
      id: 'idempotency-key',
      title: 'Requires Idempotency-Key and answers the first refund on a replay',
      detail:
        'A request without `Idempotency-Key` is **400**; `refund_for_key(tenant, key)` is read before the claim and a replay answers the first refund without claiming again. The starter ignores the header.',
      match: {
        python: {all: [/idempotency-key/i], order: [/records\.refund_for_key\(/, /ledger\.claim\(/]},
        typescript: {all: [/idempotency-key/i], order: [/refundForKey\(/, /\bclaim\(/]},
        go: {all: [/Idempotency-Key/i], order: [/records\.RefundForKey\(/, /ledger\.Claim\(/]},
        scala: {all: [/Idempotency-Key/i], order: [/Records\.refundForKey\(/, /Ledger\.claim\(/]},
        cpp: {all: [/Idempotency-Key/i], order: [/records::refundForKey\(/, /ledger::claim\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

from refunds import ledger, records  # records.find_payment, new_refund_id, insert_refund, refund_for_key; ledger.claim, refunded_total

app = FastAPI()


class RefundRequest(BaseModel):
    payment_id: str
    amount_minor: int
    reason_code: str


def refund_body(refund: dict, remaining_minor: int) -> dict:
    return {
        "refund_id": refund["refund_id"],
        "payment_id": refund["payment_id"],
        "amount_minor": refund["amount_minor"],
        "reason_code": refund["reason_code"],
        "status": refund["status"],
        "remaining_minor": remaining_minor,
    }


@app.post("/v1/refunds", status_code=201)
def create_refund(body: RefundRequest, request: Request) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    payment = records.find_payment(body.payment_id)
    if payment is None:
        raise HTTPException(status_code=404, detail="no such payment")
    refund_id = records.new_refund_id()
    refund = records.insert_refund(refund_id, tenant, body.payment_id, body.amount_minor, body.reason_code, "")
    return refund_body(refund, payment["paid_minor"] - body.amount_minor)
`,
      solution: `from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from refunds import ledger, records  # records.find_payment, new_refund_id, insert_refund, refund_for_key; ledger.claim, refunded_total

app = FastAPI()

REASON_CODES = ("damaged", "not_received", "duplicate", "goodwill")


class RefundRequest(BaseModel):
    payment_id: str
    amount_minor: int
    reason_code: str


def refund_body(refund: dict, remaining_minor: int) -> dict:
    return {
        "refund_id": refund["refund_id"],
        "payment_id": refund["payment_id"],
        "amount_minor": refund["amount_minor"],
        "reason_code": refund["reason_code"],
        "status": refund["status"],
        "remaining_minor": remaining_minor,
    }


@app.post("/v1/refunds", status_code=201)
def create_refund(body: RefundRequest, request: Request):
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    idem_key = request.headers.get("idempotency-key", "")
    if not idem_key:
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    if body.amount_minor < 1 or body.reason_code not in REASON_CODES:
        raise HTTPException(status_code=400, detail=f"amount_minor must be at least 1 and reason_code one of {', '.join(REASON_CODES)}")
    first = records.refund_for_key(tenant, idem_key)
    if first is not None:
        # A retry: answer the refund this key created, without a second claim.
        paid = records.find_payment(first["payment_id"])["paid_minor"]
        return refund_body(first, paid - ledger.refunded_total(first["payment_id"]))
    payment = records.find_payment(body.payment_id)
    if payment is None or payment["tenant"] != tenant:
        raise HTTPException(status_code=404, detail="no such payment")  # another tenant's payment looks missing
    refund_id = records.new_refund_id()
    accepted, _refunded, remaining = ledger.claim(body.payment_id, refund_id, body.amount_minor, payment["paid_minor"])
    if not accepted:
        return JSONResponse({"error": "amount exceeds the remaining balance", "remaining_minor": remaining}, status_code=422)
    refund = records.insert_refund(refund_id, tenant, body.payment_id, body.amount_minor, body.reason_code, idem_key)
    return refund_body(refund, remaining)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {claim, refundedTotal} from 'refunds/ledger';
import {type Refund, findPayment, insertRefund, newRefundId, refundForKey} from 'refunds/records';

export const app = Fastify();

interface RefundRequest {
  payment_id: string;
  amount_minor: number;
  reason_code: string;
}

function refundBody(refund: Refund, remainingMinor: number) {
  const {refund_id, payment_id, amount_minor, reason_code, status} = refund;
  return {refund_id, payment_id, amount_minor, reason_code, status, remaining_minor: remainingMinor};
}

app.post('/v1/refunds', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const tenant = (request.headers['x-tenant-id'] as string | undefined) ?? '';
  const body = request.body as RefundRequest;
  const payment = await findPayment(body.payment_id);
  if (payment === null) return reply.code(404).send({error: 'no such payment'});
  const refundId = await newRefundId();
  const refund = await insertRefund(refundId, tenant, body.payment_id, body.amount_minor, body.reason_code, '');
  return reply.code(201).send(refundBody(refund, payment.paid_minor - body.amount_minor));
});
`,
      solution: `import Fastify from 'fastify';

import {claim, refundedTotal} from 'refunds/ledger';
import {type Refund, findPayment, insertRefund, newRefundId, refundForKey} from 'refunds/records';

export const app = Fastify();

export const REASON_CODES = ['damaged', 'not_received', 'duplicate', 'goodwill'];

interface RefundRequest {
  payment_id: string;
  amount_minor: number;
  reason_code: string;
}

function refundBody(refund: Refund, remainingMinor: number) {
  const {refund_id, payment_id, amount_minor, reason_code, status} = refund;
  return {refund_id, payment_id, amount_minor, reason_code, status, remaining_minor: remainingMinor};
}

app.post('/v1/refunds', async (request, reply) => {
  const tenant = (request.headers['x-tenant-id'] as string | undefined) ?? '';
  if (tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const idemKey = (request.headers['idempotency-key'] as string | undefined) ?? '';
  if (idemKey === '') return reply.code(400).send({error: 'Idempotency-Key is required'});
  const body = request.body as RefundRequest;
  if (!Number.isInteger(body.amount_minor) || body.amount_minor < 1 || !REASON_CODES.includes(body.reason_code)) {
    return reply.code(400).send({error: \`amount_minor must be at least 1 and reason_code one of \${REASON_CODES.join(', ')}\`});
  }
  const first = await refundForKey(tenant, idemKey);
  if (first !== null) {
    // A retry: answer the refund this key created, without a second claim.
    const paid = (await findPayment(first.payment_id))?.paid_minor ?? 0;
    return reply.code(201).send(refundBody(first, paid - (await refundedTotal(first.payment_id))));
  }
  const payment = await findPayment(body.payment_id);
  // Another tenant's payment looks missing.
  if (payment === null || payment.tenant !== tenant) return reply.code(404).send({error: 'no such payment'});
  const refundId = await newRefundId();
  const claimed = await claim(body.payment_id, refundId, body.amount_minor, payment.paid_minor);
  if (!claimed.accepted) {
    return reply.code(422).send({error: 'amount exceeds the remaining balance', remaining_minor: claimed.remaining_minor});
  }
  const refund = await insertRefund(refundId, tenant, body.payment_id, body.amount_minor, body.reason_code, idemKey);
  return reply.code(201).send(refundBody(refund, claimed.remaining_minor));
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"refunds/records" // records.FindPayment, NewRefundID, InsertRefund, RefundForKey
)

type refundRequest struct {
	PaymentID   string \`json:"payment_id"\`
	AmountMinor int64  \`json:"amount_minor"\`
	ReasonCode  string \`json:"reason_code"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func refundBody(refund *records.Refund, remainingMinor int64) map[string]any {
	return map[string]any{
		"refund_id": refund.RefundID, "payment_id": refund.PaymentID, "amount_minor": refund.AmountMinor,
		"reason_code": refund.ReasonCode, "status": refund.Status, "remaining_minor": remainingMinor,
	}
}

func createRefund(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	var body refundRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, "the body must be JSON", http.StatusBadRequest)
		return
	}
	payment := records.FindPayment(r.Context(), body.PaymentID)
	if payment == nil {
		http.Error(rw, "no such payment", http.StatusNotFound)
		return
	}
	refundID := records.NewRefundID(r.Context())
	refund := records.InsertRefund(r.Context(), refundID, tenant, body.PaymentID, body.AmountMinor, body.ReasonCode, "")
	writeJSON(rw, http.StatusCreated, refundBody(refund, payment.PaidMinor-body.AmountMinor))
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/refunds", createRefund)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"

	"refunds/ledger"  // ledger.Claim, RefundedTotal
	"refunds/records" // records.FindPayment, NewRefundID, InsertRefund, RefundForKey
)

var reasonCodes = map[string]bool{"damaged": true, "not_received": true, "duplicate": true, "goodwill": true}

type refundRequest struct {
	PaymentID   string \`json:"payment_id"\`
	AmountMinor int64  \`json:"amount_minor"\`
	ReasonCode  string \`json:"reason_code"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func refundBody(refund *records.Refund, remainingMinor int64) map[string]any {
	return map[string]any{
		"refund_id": refund.RefundID, "payment_id": refund.PaymentID, "amount_minor": refund.AmountMinor,
		"reason_code": refund.ReasonCode, "status": refund.Status, "remaining_minor": remainingMinor,
	}
}

func createRefund(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	idemKey := r.Header.Get("Idempotency-Key")
	if idemKey == "" {
		http.Error(rw, "Idempotency-Key is required", http.StatusBadRequest)
		return
	}
	var body refundRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, "the body must be JSON", http.StatusBadRequest)
		return
	}
	if body.AmountMinor < 1 || !reasonCodes[body.ReasonCode] {
		http.Error(rw, "amount_minor must be at least 1 and reason_code one of damaged, not_received, duplicate, goodwill", http.StatusBadRequest)
		return
	}
	if first := records.RefundForKey(r.Context(), tenant, idemKey); first != nil {
		// A retry: answer the refund this key created, without a second claim.
		paid := records.FindPayment(r.Context(), first.PaymentID).PaidMinor
		writeJSON(rw, http.StatusCreated, refundBody(first, paid-ledger.RefundedTotal(r.Context(), first.PaymentID)))
		return
	}
	payment := records.FindPayment(r.Context(), body.PaymentID)
	if payment == nil || payment.Tenant != tenant {
		http.Error(rw, "no such payment", http.StatusNotFound) // another tenant's payment looks missing
		return
	}
	refundID := records.NewRefundID(r.Context())
	claimed, err := ledger.Claim(r.Context(), body.PaymentID, refundID, body.AmountMinor, payment.PaidMinor)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusServiceUnavailable)
		return
	}
	if !claimed.Accepted {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]any{"error": "amount exceeds the remaining balance", "remaining_minor": claimed.RemainingMinor})
		return
	}
	refund := records.InsertRefund(r.Context(), refundID, tenant, body.PaymentID, body.AmountMinor, body.ReasonCode, idemKey)
	writeJSON(rw, http.StatusCreated, refundBody(refund, claimed.RemainingMinor))
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/refunds", createRefund)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import refunds.{Ledger, Records} // Records.findPayment, newRefundId, insertRefund, refundForKey; Ledger.claim, refundedTotal

object Api {
  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def refundBody(refund: Records.Refund, remainingMinor: Long): JsObject = JsObject(
    "refund_id" -> JsString(refund.refundId), "payment_id" -> JsString(refund.paymentId),
    "amount_minor" -> JsNumber(refund.amountMinor), "reason_code" -> JsString(refund.reasonCode),
    "status" -> JsString(refund.status), "remaining_minor" -> JsNumber(remainingMinor))

  private def text(body: Map[String, JsValue], name: String): String = body.get(name).collect { case JsString(s) => s }.getOrElse("")
  private def number(body: Map[String, JsValue], name: String): Long = body.get(name).collect { case JsNumber(n) => n.toLong }.getOrElse(0L)

  val route: Route = path("v1" / "refunds") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") { tenantHeader =>
        entity(as[String]) { raw =>
          // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
          val tenant = tenantHeader.getOrElse("")
          val body = raw.parseJson.asJsObject.fields
          val paymentId = text(body, "payment_id")
          val amountMinor = number(body, "amount_minor")
          Records.findPayment(paymentId) match {
            case None => complete(StatusCodes.NotFound -> "no such payment")
            case Some(payment) =>
              val refund = Records.insertRefund(Records.newRefundId(), tenant, paymentId, amountMinor, text(body, "reason_code"), "")
              complete(json(StatusCodes.Created, refundBody(refund, payment.paidMinor - amountMinor)))
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

import refunds.{Ledger, Records} // Records.findPayment, newRefundId, insertRefund, refundForKey; Ledger.claim, refundedTotal

object Api {
  val ReasonCodes: Set[String] = Set("damaged", "not_received", "duplicate", "goodwill")

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def refundBody(refund: Records.Refund, remainingMinor: Long): JsObject = JsObject(
    "refund_id" -> JsString(refund.refundId), "payment_id" -> JsString(refund.paymentId),
    "amount_minor" -> JsNumber(refund.amountMinor), "reason_code" -> JsString(refund.reasonCode),
    "status" -> JsString(refund.status), "remaining_minor" -> JsNumber(remainingMinor))

  private def text(body: Map[String, JsValue], name: String): String = body.get(name).collect { case JsString(s) => s }.getOrElse("")
  private def number(body: Map[String, JsValue], name: String): Long = body.get(name).collect { case JsNumber(n) => n.toLong }.getOrElse(0L)

  private def create(tenant: String, idemKey: String, raw: String): HttpResponse = {
    val body = raw.parseJson.asJsObject.fields
    val paymentId = text(body, "payment_id")
    val amountMinor = number(body, "amount_minor")
    val reasonCode = text(body, "reason_code")
    if (amountMinor < 1 || !ReasonCodes.contains(reasonCode))
      return json(StatusCodes.BadRequest, JsObject("error" -> JsString("amount_minor must be at least 1 and reason_code one of " + ReasonCodes.mkString(", "))))
    Records.refundForKey(tenant, idemKey) match {
      case Some(first) =>
        // A retry: answer the refund this key created, without a second claim.
        val paid = Records.findPayment(first.paymentId).map(_.paidMinor).getOrElse(0L)
        json(StatusCodes.Created, refundBody(first, paid - Ledger.refundedTotal(first.paymentId)))
      case None =>
        Records.findPayment(paymentId) match {
          // Another tenant's payment looks missing.
          case Some(payment) if payment.tenant == tenant =>
            val refundId = Records.newRefundId()
            val claimed = Ledger.claim(paymentId, refundId, amountMinor, payment.paidMinor)
            if (!claimed.accepted)
              json(StatusCodes.UnprocessableEntity, JsObject("error" -> JsString("amount exceeds the remaining balance"), "remaining_minor" -> JsNumber(claimed.remainingMinor)))
            else json(StatusCodes.Created, refundBody(Records.insertRefund(refundId, tenant, paymentId, amountMinor, reasonCode, idemKey), claimed.remainingMinor))
          case _ => json(StatusCodes.NotFound, JsObject("error" -> JsString("no such payment")))
        }
    }
  }

  val route: Route = path("v1" / "refunds") {
    post {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
        case Some(tenant) =>
          optionalHeaderValueByName("Idempotency-Key") {
            case None | Some("") => complete(StatusCodes.BadRequest -> "Idempotency-Key is required")
            case Some(idemKey) => entity(as[String]) { raw => complete(create(tenant, idemKey, raw)) }
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

#include "refunds/ledger.h"   // ledger::claim, refundedTotal
#include "refunds/records.h"  // records::findPayment, newRefundId, insertRefund, refundForKey

using json = nlohmann::json;

json refundBody(const records::Refund& refund, long long remaining_minor) {
  return json{{"refund_id", refund.refund_id},     {"payment_id", refund.payment_id}, {"amount_minor", refund.amount_minor},
              {"reason_code", refund.reason_code}, {"status", refund.status},         {"remaining_minor", remaining_minor}};
}

void create_refund(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  const json body = json::parse(req.body);
  const std::string payment_id = body.value("payment_id", "");
  const long long amount_minor = body.value("amount_minor", 0LL);
  const auto payment = records::findPayment(payment_id);
  if (!payment) {
    res.status = 404;
    res.set_content("no such payment", "text/plain");
    return;
  }
  const records::Refund refund =
      records::insertRefund(records::newRefundId(), tenant, payment_id, amount_minor, body.value("reason_code", ""), "");
  res.status = 201;
  res.set_content(refundBody(refund, payment->paid_minor - amount_minor).dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/refunds", create_refund); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <set>
#include <string>

#include "refunds/ledger.h"   // ledger::claim, refundedTotal
#include "refunds/records.h"  // records::findPayment, newRefundId, insertRefund, refundForKey

using json = nlohmann::json;

const std::set<std::string> kReasonCodes = {"damaged", "not_received", "duplicate", "goodwill"};

json refundBody(const records::Refund& refund, long long remaining_minor) {
  return json{{"refund_id", refund.refund_id},     {"payment_id", refund.payment_id}, {"amount_minor", refund.amount_minor},
              {"reason_code", refund.reason_code}, {"status", refund.status},         {"remaining_minor", remaining_minor}};
}

void answer(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void create_refund(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return answer(res, 401, json{{"error", "X-Tenant-Id is required"}});
  const std::string idem_key = req.get_header_value("Idempotency-Key");
  if (idem_key.empty()) return answer(res, 400, json{{"error", "Idempotency-Key is required"}});
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object() || !body.contains("amount_minor") || !body["amount_minor"].is_number_integer()) {
    return answer(res, 400, json{{"error", "amount_minor must be an integer"}});
  }
  const std::string payment_id = body.value("payment_id", "");
  const long long amount_minor = body["amount_minor"].get<long long>();
  const std::string reason_code = body.value("reason_code", "");
  if (amount_minor < 1 || !kReasonCodes.count(reason_code)) {
    return answer(res, 400, json{{"error", "amount_minor must be at least 1 and reason_code one of damaged, not_received, duplicate, goodwill"}});
  }
  if (const auto first = records::refundForKey(tenant, idem_key)) {
    // A retry: answer the refund this key created, without a second claim.
    const long long paid = records::findPayment(first->payment_id)->paid_minor;
    return answer(res, 201, refundBody(*first, paid - ledger::refundedTotal(first->payment_id)));
  }
  const auto payment = records::findPayment(payment_id);
  // Another tenant's payment looks missing.
  if (!payment || payment->tenant != tenant) return answer(res, 404, json{{"error", "no such payment"}});
  const std::string refund_id = records::newRefundId();
  const ledger::ClaimResult claimed = ledger::claim(payment_id, refund_id, amount_minor, payment->paid_minor);
  if (!claimed.accepted) {
    return answer(res, 422, json{{"error", "amount exceeds the remaining balance"}, {"remaining_minor", claimed.remaining_minor}});
  }
  const records::Refund refund = records::insertRefund(refund_id, tenant, payment_id, amount_minor, reason_code, idem_key);
  answer(res, 201, refundBody(refund, claimed.remaining_minor));
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/refunds", create_refund); }
`,
    },
  },
  harness: {
    python: `from refunds import ledger, records


def _api(ctx):
    records.add_payment("pay_1", "t1", 10000)
    records.add_payment("pay_2", "t2", 8000)
    return ctx.client(ctx.load("api").app)


async def _post(c, amount=2500, payment="pay_1", reason="damaged", tenant="t1", key="k-1"):
    headers = {}
    if tenant:
        headers["X-Tenant-Id"] = tenant
    if key:
        headers["Idempotency-Key"] = key
    return await c.post("/v1/refunds", json={"payment_id": payment, "amount_minor": amount, "reason_code": reason}, headers=headers)


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await _post(c, 2500)
    assert r.status_code == 201, f"POST /v1/refunds answered {r.status_code}: {r.text}, expected 201"
    body = r.json()
    assert body.get("status") == "PENDING" and body.get("amount_minor") == 2500 and body.get("payment_id") == "pay_1", f"the refund answered {body}, expected pay_1, 2500, PENDING"
    assert body.get("remaining_minor") == 7500, f"remaining_minor is {body.get('remaining_minor')!r} after 2500 of a 10000 payment, expected 7500"
    rows = records.list_refunds("pay_1")
    assert len(rows) == 1 and rows[0]["refund_id"] == body.get("refund_id"), f"the records of pay_1 hold {rows}, expected the refund {body.get('refund_id')}"


async def check_tenant_scope(ctx):
    async with _api(ctx) as c:
        anonymous = await _post(c, tenant="", key="k-1")
        foreign = await _post(c, payment="pay_2", key="k-2")
        missing = await _post(c, payment="pay_404", key="k-3")
    assert anonymous.status_code == 401, f"a refund without X-Tenant-Id answered {anonymous.status_code}, expected 401"
    assert foreign.status_code == 404, f"tenant t1 refunding t2's payment pay_2 answered {foreign.status_code}, expected 404 (a foreign payment looks missing)"
    assert missing.status_code == 404, f"a missing payment answered {missing.status_code}, expected 404"
    assert records.list_refunds("pay_2") == [] and ledger.refunded_total("pay_2") == 0, f"t1's request wrote {records.list_refunds('pay_2')} against t2's payment"
    assert records.list_refunds("pay_1") == [], f"a request without a tenant wrote {records.list_refunds('pay_1')}"


async def check_amount_valid(ctx):
    async with _api(ctx) as c:
        for n, (amount, reason) in enumerate([(0, "damaged"), (-2500, "damaged"), (2500, "because")]):
            r = await _post(c, amount=amount, reason=reason, key=f"k-{n}")
            assert r.status_code == 400, f"amount_minor={amount}, reason_code={reason!r} answered {r.status_code}, expected 400"
        assert records.list_refunds("pay_1") == [], f"refused requests wrote {records.list_refunds('pay_1')}"
        assert ledger.refunded_total("pay_1") == 0, f"refused requests moved the ledger to {ledger.refunded_total('pay_1')}"
        r = await _post(c, amount=1, reason="goodwill", key="k-9")
    assert r.status_code == 201, f"amount_minor=1 with reason goodwill answered {r.status_code}: {r.text}, expected 201"


async def check_cap(ctx):
    async with _api(ctx) as c:
        first = await _post(c, 6000, key="k-1")
        over = await _post(c, 5000, key="k-2")
        rest = await _post(c, 4000, key="k-3")
    assert first.status_code == 201 and first.json().get("remaining_minor") == 4000, f"6000 of a 10000 payment answered {first.status_code} {first.text}, expected 201 with remaining_minor 4000"
    assert over.status_code == 422, f"5000 more on a 10000 payment with 6000 refunded answered {over.status_code} {over.text}, expected 422: the payment would refund 11000"
    assert over.json().get("remaining_minor") == 4000, f"the 422 must carry remaining_minor 4000, got {over.text}"
    assert rest.status_code == 201 and rest.json().get("remaining_minor") == 0, f"the last 4000 answered {rest.status_code} {rest.text}, expected 201 with remaining_minor 0"
    assert ledger.refunded_total("pay_1") == 10000, f"the ledger of pay_1 holds {ledger.refunded_total('pay_1')} after 6000 and 4000 were accepted: claim each amount with ledger.claim"
    assert len(records.list_refunds("pay_1")) == 2, f"the records hold {len(records.list_refunds('pay_1'))} refunds, expected 2: a refused claim writes no row"


async def check_idempotency_key(ctx):
    async with _api(ctx) as c:
        none = await _post(c, key="")
        assert none.status_code == 400, f"a refund without Idempotency-Key answered {none.status_code}, expected 400"
        first = await _post(c, 2500, key="k-1")
        retry = await _post(c, 2500, key="k-1")
        other = await _post(c, 2500, key="k-2")
        t2 = await _post(c, 2500, payment="pay_2", tenant="t2", key="k-1")
    assert first.status_code == 201, f"the first refund answered {first.status_code}: {first.text}"
    assert retry.status_code in (200, 201) and retry.json().get("refund_id") == first.json().get("refund_id"), f"a retry with the same key answered {retry.text}, expected the first refund {first.json().get('refund_id')}"
    rows = records.list_refunds("pay_1")
    assert len(rows) == 2 and ledger.refunded_total("pay_1") == 5000, f"keys k-1 (twice) and k-2 left {len(rows)} refunds and a ledger of {ledger.refunded_total('pay_1')}, expected 2 refunds and 5000: a replay is not a second refund"
    assert other.json().get("refund_id") != first.json().get("refund_id"), "a new key must create a new refund"
    assert t2.status_code == 201 and t2.json().get("refund_id") not in (first.json().get("refund_id"), other.json().get("refund_id")), f"tenant t2 using key k-1 answered {t2.text}: keys belong to a tenant"
`,
    typescript: `function api(ctx) {
  const records = ctx.load('/support/refunds/records.ts');
  const ledger = ctx.load('/support/refunds/ledger.ts');
  const c = ctx.client(ctx.load('api').app);
  return {c, records, ledger};
}

async function seed(records) {
  await records.addPayment('pay_1', 't1', 10000);
  await records.addPayment('pay_2', 't2', 8000);
}

function post(c, amount = 2500, payment = 'pay_1', reason = 'damaged', tenant = 't1', key = 'k-1') {
  const headers: Record<string, string> = {};
  if (tenant !== '') headers['X-Tenant-Id'] = tenant;
  if (key !== '') headers['Idempotency-Key'] = key;
  return c.post('/v1/refunds', {json: {payment_id: payment, amount_minor: amount, reason_code: reason}, headers});
}

export async function check_route(ctx) {
  const {c, records} = api(ctx);
  await seed(records);
  const r = await post(c, 2500);
  assert.equal(r.status, 201, \`POST /v1/refunds answered \${r.status}: \${r.text}, expected 201\`);
  const body = r.json();
  assert(body.status === 'PENDING' && body.amount_minor === 2500 && body.payment_id === 'pay_1', \`the refund answered \${r.text}, expected pay_1, 2500, PENDING\`);
  assert.equal(body.remaining_minor, 7500, \`remaining_minor is \${body.remaining_minor} after 2500 of a 10000 payment, expected 7500\`);
  const rows = await records.listRefunds('pay_1');
  assert(rows.length === 1 && rows[0].refund_id === body.refund_id, \`the records of pay_1 hold \${JSON.stringify(rows)}, expected the refund \${body.refund_id}\`);
}

export async function check_tenant_scope(ctx) {
  const {c, records, ledger} = api(ctx);
  await seed(records);
  const anonymous = await post(c, 2500, 'pay_1', 'damaged', '', 'k-1');
  const foreign = await post(c, 2500, 'pay_2', 'damaged', 't1', 'k-2');
  const missing = await post(c, 2500, 'pay_404', 'damaged', 't1', 'k-3');
  assert.equal(anonymous.status, 401, \`a refund without X-Tenant-Id answered \${anonymous.status}, expected 401\`);
  assert.equal(foreign.status, 404, \`tenant t1 refunding t2's payment pay_2 answered \${foreign.status}, expected 404 (a foreign payment looks missing)\`);
  assert.equal(missing.status, 404, \`a missing payment answered \${missing.status}, expected 404\`);
  assert((await records.listRefunds('pay_2')).length === 0 && (await ledger.refundedTotal('pay_2')) === 0, "t1's request wrote a refund against t2's payment");
  assert.equal((await records.listRefunds('pay_1')).length, 0, 'a request without a tenant wrote a refund');
}

export async function check_amount_valid(ctx) {
  const {c, records, ledger} = api(ctx);
  await seed(records);
  const cases: [number, string][] = [[0, 'damaged'], [-2500, 'damaged'], [2500, 'because']];
  for (const [n, [amount, reason]] of cases.entries()) {
    const r = await post(c, amount, 'pay_1', reason, 't1', \`k-\${n}\`);
    assert.equal(r.status, 400, \`amount_minor=\${amount}, reason_code=\${reason} answered \${r.status}, expected 400\`);
  }
  assert.equal((await records.listRefunds('pay_1')).length, 0, 'refused requests wrote refunds');
  assert.equal(await ledger.refundedTotal('pay_1'), 0, 'refused requests moved the ledger');
  const r = await post(c, 1, 'pay_1', 'goodwill', 't1', 'k-9');
  assert.equal(r.status, 201, \`amount_minor=1 with reason goodwill answered \${r.status}: \${r.text}, expected 201\`);
}

export async function check_cap(ctx) {
  const {c, records, ledger} = api(ctx);
  await seed(records);
  const first = await post(c, 6000, 'pay_1', 'damaged', 't1', 'k-1');
  const over = await post(c, 5000, 'pay_1', 'damaged', 't1', 'k-2');
  const rest = await post(c, 4000, 'pay_1', 'damaged', 't1', 'k-3');
  assert(first.status === 201 && first.json().remaining_minor === 4000, \`6000 of a 10000 payment answered \${first.status} \${first.text}, expected 201 with remaining_minor 4000\`);
  assert.equal(over.status, 422, \`5000 more on a 10000 payment with 6000 refunded answered \${over.status} \${over.text}, expected 422: the payment would refund 11000\`);
  assert.equal(over.json().remaining_minor, 4000, \`the 422 must carry remaining_minor 4000, got \${over.text}\`);
  assert(rest.status === 201 && rest.json().remaining_minor === 0, \`the last 4000 answered \${rest.status} \${rest.text}, expected 201 with remaining_minor 0\`);
  const total = await ledger.refundedTotal('pay_1');
  assert.equal(total, 10000, \`the ledger of pay_1 holds \${total} after 6000 and 4000 were accepted: claim each amount with claim()\`);
  assert.equal((await records.listRefunds('pay_1')).length, 2, 'a refused claim writes no row: expected 2 refunds');
}

export async function check_idempotency_key(ctx) {
  const {c, records, ledger} = api(ctx);
  await seed(records);
  const none = await post(c, 2500, 'pay_1', 'damaged', 't1', '');
  assert.equal(none.status, 400, \`a refund without Idempotency-Key answered \${none.status}, expected 400\`);
  const first = await post(c, 2500, 'pay_1', 'damaged', 't1', 'k-1');
  const retry = await post(c, 2500, 'pay_1', 'damaged', 't1', 'k-1');
  const other = await post(c, 2500, 'pay_1', 'damaged', 't1', 'k-2');
  const t2 = await post(c, 2500, 'pay_2', 'damaged', 't2', 'k-1');
  assert.equal(first.status, 201, \`the first refund answered \${first.status}: \${first.text}\`);
  assert((retry.status === 200 || retry.status === 201) && retry.json().refund_id === first.json().refund_id, \`a retry with the same key answered \${retry.text}, expected the first refund \${first.json().refund_id}\`);
  const rows = await records.listRefunds('pay_1');
  const total = await ledger.refundedTotal('pay_1');
  assert(rows.length === 2 && total === 5000, \`keys k-1 (twice) and k-2 left \${rows.length} refunds and a ledger of \${total}, expected 2 refunds and 5000: a replay is not a second refund\`);
  assert.notEqual(other.json().refund_id, first.json().refund_id, 'a new key must create a new refund');
  assert(t2.status === 201 && ![first.json().refund_id, other.json().refund_id].includes(t2.json().refund_id), \`tenant t2 using key k-1 answered \${t2.text}: keys belong to a tenant\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"refunds/ledger"
	"refunds/records"

	"leetbuild/harness"
)

var apiBg = context.Background()

type apiReply struct {
	RefundID       string \`json:"refund_id"\`
	PaymentID      string \`json:"payment_id"\`
	AmountMinor    int64  \`json:"amount_minor"\`
	Status         string \`json:"status"\`
	RemainingMinor int64  \`json:"remaining_minor"\`
}

func apiServer(ctx *harness.Ctx) *harness.HTTP {
	records.AddPayment(apiBg, "pay_1", "t1", 10000)
	records.AddPayment(apiBg, "pay_2", "t2", 8000)
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func apiPost(c *harness.HTTP, amount int64, paymentID, reason, tenant, key string) *harness.Response {
	headers := []string{"Content-Type", "application/json"}
	if tenant != "" {
		headers = append(headers, "X-Tenant-Id", tenant)
	}
	if key != "" {
		headers = append(headers, "Idempotency-Key", key)
	}
	return c.Post("/v1/refunds", map[string]any{"payment_id": paymentID, "amount_minor": amount, "reason_code": reason}, headers...)
}

func apiDecode(r *harness.Response) apiReply {
	var body apiReply
	json.Unmarshal([]byte(r.Text()), &body)
	return body
}

func CheckRoute(ctx *harness.Ctx) {
	c := apiServer(ctx)
	r := apiPost(c, 2500, "pay_1", "damaged", "t1", "k-1")
	ctx.Equal(r.Status, 201, "POST /v1/refunds (%s)", r.Text())
	body := apiDecode(r)
	ctx.Assert(body.Status == "PENDING" && body.AmountMinor == 2500 && body.PaymentID == "pay_1", "the refund answered %s, expected pay_1, 2500, PENDING", r.Text())
	ctx.Equal(body.RemainingMinor, 7500, "remaining_minor after 2500 of a 10000 payment")
	rows := records.ListRefunds(apiBg, "pay_1")
	ctx.Assert(len(rows) == 1 && rows[0].RefundID == body.RefundID, "the records of pay_1 hold %v, expected the refund %s", rows, body.RefundID)
}

func CheckTenantScope(ctx *harness.Ctx) {
	c := apiServer(ctx)
	anonymous := apiPost(c, 2500, "pay_1", "damaged", "", "k-1")
	foreign := apiPost(c, 2500, "pay_2", "damaged", "t1", "k-2")
	missing := apiPost(c, 2500, "pay_404", "damaged", "t1", "k-3")
	ctx.Equal(anonymous.Status, 401, "a refund without X-Tenant-Id")
	ctx.Equal(foreign.Status, 404, "tenant t1 refunding t2's payment pay_2 (a foreign payment looks missing)")
	ctx.Equal(missing.Status, 404, "a missing payment")
	ctx.Assert(len(records.ListRefunds(apiBg, "pay_2")) == 0 && ledger.RefundedTotal(apiBg, "pay_2") == 0, "t1's request wrote %v against t2's payment", records.ListRefunds(apiBg, "pay_2"))
	ctx.Equal(len(records.ListRefunds(apiBg, "pay_1")), 0, "a request without a tenant must write no refund; the refunds")
}

func CheckAmountValid(ctx *harness.Ctx) {
	c := apiServer(ctx)
	cases := []struct {
		amount int64
		reason string
	}{{0, "damaged"}, {-2500, "damaged"}, {2500, "because"}}
	for n, tc := range cases {
		r := apiPost(c, tc.amount, "pay_1", tc.reason, "t1", fmt.Sprintf("k-%d", n))
		ctx.Equal(r.Status, 400, "amount_minor=%d, reason_code=%q", tc.amount, tc.reason)
	}
	ctx.Equal(len(records.ListRefunds(apiBg, "pay_1")), 0, "refused requests must write no refund; the refunds")
	ctx.Equal(ledger.RefundedTotal(apiBg, "pay_1"), 0, "refused requests must leave the ledger; its total")
	r := apiPost(c, 1, "pay_1", "goodwill", "t1", "k-9")
	ctx.Equal(r.Status, 201, "amount_minor=1 with reason goodwill (%s)", r.Text())
}

func CheckCap(ctx *harness.Ctx) {
	c := apiServer(ctx)
	first := apiPost(c, 6000, "pay_1", "damaged", "t1", "k-1")
	over := apiPost(c, 5000, "pay_1", "damaged", "t1", "k-2")
	rest := apiPost(c, 4000, "pay_1", "damaged", "t1", "k-3")
	ctx.Assert(first.Status == 201 && apiDecode(first).RemainingMinor == 4000, "6000 of a 10000 payment answered %d %s, expected 201 with remaining_minor 4000", first.Status, first.Text())
	ctx.Equal(over.Status, 422, "5000 more on a 10000 payment with 6000 refunded (the payment would refund 11000; %s)", over.Text())
	ctx.Equal(apiDecode(over).RemainingMinor, 4000, "the 422's remaining_minor (%s)", over.Text())
	ctx.Assert(rest.Status == 201 && apiDecode(rest).RemainingMinor == 0, "the last 4000 answered %d %s, expected 201 with remaining_minor 0", rest.Status, rest.Text())
	ctx.Equal(ledger.RefundedTotal(apiBg, "pay_1"), 10000, "after 6000 and 4000 were accepted the ledger of pay_1 must hold both (claim each amount with ledger.Claim)")
	ctx.Equal(len(records.ListRefunds(apiBg, "pay_1")), 2, "a refused claim writes no row; the refunds")
}

func CheckIdempotencyKey(ctx *harness.Ctx) {
	c := apiServer(ctx)
	none := apiPost(c, 2500, "pay_1", "damaged", "t1", "")
	ctx.Equal(none.Status, 400, "a refund without Idempotency-Key")
	first := apiPost(c, 2500, "pay_1", "damaged", "t1", "k-1")
	retry := apiPost(c, 2500, "pay_1", "damaged", "t1", "k-1")
	other := apiPost(c, 2500, "pay_1", "damaged", "t1", "k-2")
	t2 := apiPost(c, 2500, "pay_2", "damaged", "t2", "k-1")
	ctx.Equal(first.Status, 201, "the first refund (%s)", first.Text())
	ctx.Assert((retry.Status == 200 || retry.Status == 201) && apiDecode(retry).RefundID == apiDecode(first).RefundID, "a retry with the same key answered %s, expected the first refund %s", retry.Text(), apiDecode(first).RefundID)
	rows := records.ListRefunds(apiBg, "pay_1")
	total := ledger.RefundedTotal(apiBg, "pay_1")
	ctx.Assert(len(rows) == 2 && total == 5000, "keys k-1 (twice) and k-2 left %d refunds and a ledger of %d, expected 2 refunds and 5000: a replay is not a second refund", len(rows), total)
	ctx.Assert(apiDecode(other).RefundID != apiDecode(first).RefundID, "a new key must create a new refund")
	id := apiDecode(t2).RefundID
	ctx.Assert(t2.Status == 201 && id != apiDecode(first).RefundID && id != apiDecode(other).RefundID, "tenant t2 using key k-1 answered %s: keys belong to a tenant", t2.Text())
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "refunds/ledger.h"
#include "refunds/records.h"

namespace {

harness::HTTP apiServer(harness::Ctx& ctx) {
  records::addPayment("pay_1", "t1", 10000);
  records::addPayment("pay_2", "t2", 8000);
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response apiPost(harness::HTTP& c, long long amount, const std::string& payment_id, const std::string& reason,
                          const std::string& tenant, const std::string& key) {
  std::vector<std::string> headers = {"Content-Type", "application/json"};
  if (!tenant.empty()) headers.insert(headers.end(), {"X-Tenant-Id", tenant});
  if (!key.empty()) headers.insert(headers.end(), {"Idempotency-Key", key});
  const nlohmann::json body{{"payment_id", payment_id}, {"amount_minor", amount}, {"reason_code", reason}};
  return c.Send("POST", "/v1/refunds", body.dump(), headers);
}

nlohmann::json apiBody(const harness::Response& r) {
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  return body.is_object() ? body : nlohmann::json::object();
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = apiServer(ctx);
  const auto r = apiPost(c, 2500, "pay_1", "damaged", "t1", "k-1");
  ctx.Equal(r.Status, 201, "POST /v1/refunds (%s)", r.Text());
  const auto body = apiBody(r);
  ctx.Assert(body.value("status", "") == "PENDING" && body.value("amount_minor", 0LL) == 2500 && body.value("payment_id", "") == "pay_1",
             "the refund answered %s, expected pay_1, 2500, PENDING", r.Text());
  ctx.Equal(body.value("remaining_minor", -1LL), 7500, "remaining_minor after 2500 of a 10000 payment");
  const auto rows = records::listRefunds("pay_1");
  ctx.Assert(rows.size() == 1 && rows[0].refund_id == body.value("refund_id", ""), "the records of pay_1 hold %d refunds, expected the refund %s",
             rows.size(), body.value("refund_id", ""));
}

void CheckTenantScope(harness::Ctx& ctx) {
  auto c = apiServer(ctx);
  const auto anonymous = apiPost(c, 2500, "pay_1", "damaged", "", "k-1");
  const auto foreign = apiPost(c, 2500, "pay_2", "damaged", "t1", "k-2");
  const auto missing = apiPost(c, 2500, "pay_404", "damaged", "t1", "k-3");
  ctx.Equal(anonymous.Status, 401, "a refund without X-Tenant-Id");
  ctx.Equal(foreign.Status, 404, "tenant t1 refunding t2's payment pay_2 (a foreign payment looks missing)");
  ctx.Equal(missing.Status, 404, "a missing payment");
  ctx.Assert(records::listRefunds("pay_2").empty() && ledger::refundedTotal("pay_2") == 0, "t1's request wrote a refund against t2's payment");
  ctx.Equal(records::listRefunds("pay_1").size(), 0, "a request without a tenant must write no refund; the refunds");
}

void CheckAmountValid(harness::Ctx& ctx) {
  auto c = apiServer(ctx);
  const std::vector<std::pair<long long, std::string>> cases = {{0, "damaged"}, {-2500, "damaged"}, {2500, "because"}};
  for (size_t n = 0; n < cases.size(); n++) {
    const auto r = apiPost(c, cases[n].first, "pay_1", cases[n].second, "t1", "k-" + std::to_string(n));
    ctx.Equal(r.Status, 400, "amount_minor=%d, reason_code=%q", cases[n].first, cases[n].second);
  }
  ctx.Equal(records::listRefunds("pay_1").size(), 0, "refused requests must write no refund; the refunds");
  ctx.Equal(ledger::refundedTotal("pay_1"), 0, "refused requests must leave the ledger; its total");
  const auto r = apiPost(c, 1, "pay_1", "goodwill", "t1", "k-9");
  ctx.Equal(r.Status, 201, "amount_minor=1 with reason goodwill (%s)", r.Text());
}

void CheckCap(harness::Ctx& ctx) {
  auto c = apiServer(ctx);
  const auto first = apiPost(c, 6000, "pay_1", "damaged", "t1", "k-1");
  const auto over = apiPost(c, 5000, "pay_1", "damaged", "t1", "k-2");
  const auto rest = apiPost(c, 4000, "pay_1", "damaged", "t1", "k-3");
  ctx.Assert(first.Status == 201 && apiBody(first).value("remaining_minor", -1LL) == 4000,
             "6000 of a 10000 payment answered %d %s, expected 201 with remaining_minor 4000", first.Status, first.Text());
  ctx.Equal(over.Status, 422, "5000 more on a 10000 payment with 6000 refunded (the payment would refund 11000; %s)", over.Text());
  ctx.Equal(apiBody(over).value("remaining_minor", -1LL), 4000, "the 422's remaining_minor (%s)", over.Text());
  ctx.Assert(rest.Status == 201 && apiBody(rest).value("remaining_minor", -1LL) == 0,
             "the last 4000 answered %d %s, expected 201 with remaining_minor 0", rest.Status, rest.Text());
  ctx.Equal(ledger::refundedTotal("pay_1"), 10000,
            "after 6000 and 4000 were accepted the ledger of pay_1 must hold both (claim each amount with ledger::claim)");
  ctx.Equal(records::listRefunds("pay_1").size(), 2, "a refused claim writes no row; the refunds");
}

void CheckIdempotencyKey(harness::Ctx& ctx) {
  auto c = apiServer(ctx);
  const auto none = apiPost(c, 2500, "pay_1", "damaged", "t1", "");
  ctx.Equal(none.Status, 400, "a refund without Idempotency-Key");
  const auto first = apiPost(c, 2500, "pay_1", "damaged", "t1", "k-1");
  const auto retry = apiPost(c, 2500, "pay_1", "damaged", "t1", "k-1");
  const auto other = apiPost(c, 2500, "pay_1", "damaged", "t1", "k-2");
  const auto t2 = apiPost(c, 2500, "pay_2", "damaged", "t2", "k-1");
  const std::string first_id = apiBody(first).value("refund_id", "");
  const std::string other_id = apiBody(other).value("refund_id", "");
  ctx.Equal(first.Status, 201, "the first refund (%s)", first.Text());
  ctx.Assert((retry.Status == 200 || retry.Status == 201) && apiBody(retry).value("refund_id", "") == first_id,
             "a retry with the same key answered %s, expected the first refund %s", retry.Text(), first_id);
  const size_t rows = records::listRefunds("pay_1").size();
  const long long total = ledger::refundedTotal("pay_1");
  ctx.Assert(rows == 2 && total == 5000,
             "keys k-1 (twice) and k-2 left %d refunds and a ledger of %d, expected 2 refunds and 5000: a replay is not a second refund", rows, total);
  ctx.Assert(other_id != first_id, "a new key must create a new refund");
  const std::string t2_id = apiBody(t2).value("refund_id", "");
  ctx.Assert(t2.Status == 201 && t2_id != first_id && t2_id != other_id, "tenant t2 using key k-1 answered %s: keys belong to a tenant", t2.Text());
}
`,
  },
  hints: [
    'Post 12000 against a 10000 payment, or -2500 against any payment: both answer 201. Retry a request with the same Idempotency-Key and the customer gets two refunds; leave out X-Tenant-Id and it still goes through.',
    "The handler trusts the request: it skips comparing the payment's tenant with the caller's, checks no amount, asks no ledger, and writes a new row per call because nothing binds the key to the first refund.",
    '401 without a tenant, 400 without a key or with a bad amount or reason; answer `refund_for_key(tenant, key)` when it exists; 404 unless the tenants match; `ledger.claim(..., paid_minor)`, 422 with `remaining_minor` when refused; then `insert_refund(..., key)`.',
  ],
  debrief: `The order of the guards is the design. The replay lookup comes before the claim, so a retry never reserves twice; the ownership check comes before anything is written, so a foreign payment id costs nothing and reveals nothing; and the claim is the only place the cap is enforced, so two handlers on two servers cannot both see room that only one of them may spend. Answering a foreign payment exactly like a missing one keeps payment ids from being probed. A production refund API also stores the first response under the key with an expiry and refuses a replay whose body differs, and it checks the payment's state (captured, not disputed) before it reserves anything.`,
};
