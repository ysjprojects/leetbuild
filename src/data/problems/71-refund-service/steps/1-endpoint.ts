import type {Step} from '@/lib/types';

export const refundEndpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/refunds: never more than was paid',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'ledger', 'records', 'psp'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, reads
the payment's refundable balance and returns a refund. It compiles, it returns a body the console
renders, and it hides four production flaws. Review it like the payments engineer on call, fix it,
and prove the fix with the checks below.

Implement \`POST /v1/refunds\` with body
\`{"payment_id": "pay_8d1", "amount_minor": 2500, "reason_code": "damaged"}\`.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**. A
  payment that belongs to another tenant answers **404** — the same answer as one that does not
  exist, so a foreign payment id is never distinguishable from a missing one.
- \`amount_minor\` is an integer of at least **1** (**400** otherwise) and \`reason_code\` is one of
  \`damaged\`, \`not_received\`, \`duplicate\`, \`goodwill\` (**400** otherwise).
- The refundable balance is \`paid_minor - refunded_minor\` for that payment. An amount **above the
  remaining balance is 422**, and the refusal carries the remaining balance. A refund may never take
  more than the customer paid, no matter how the client sequences its requests.
- \`Idempotency-Key\` is required (**400** when missing) and the refund is stored under
  \`(tenant, key)\`: a replay returns the first refund with the same \`refund_id\` instead of
  refunding a second time.
- The amount is claimed through the ledger's **atomic check-and-add** (the next step builds it),
  never by reading a balance here. Two concurrent partial refunds that together exceed the balance
  must leave exactly one accepted.
- A partial refund must **leave the reduced balance visible immediately**: the response carries the
  new \`remaining_minor\`, so the merchant support tool shows the same number finance will see.
- Log the decision with tenant, payment and amount; never the reason text, card data or customer
  name.

**Failure mode the checks target.** Reading the balance and then refunding is check-then-act: two
concurrent requests both see the same remaining balance and both refund, so one payment pays out
twice. Ignoring \`Idempotency-Key\` turns every client retry into a second refund — the exact bug the
mock interview opens with. And trusting the path's payment id lets any authenticated tenant refund
someone else's charge.`,
  sequence: {
    participants: ['Client', 'Refund API', 'Redis ledger', 'refund records'],
    messages: [
      {from: 'Client', to: 'Refund API', label: 'POST /v1/refunds · X-Tenant-Id · Idempotency-Key', kind: 'sync'},
      {from: 'Refund API', to: 'Refund API', label: 'guards: tenant · key · amount · reason_code', kind: 'sync'},
      {from: 'Refund API', to: 'refund records', label: 'replay? (tenant, idem_key) · payment owner', kind: 'sync'},
      {from: 'refund records', to: 'Refund API', label: 'stored refund / tenant · paid_minor', kind: 'reply'},
      {
        from: 'Refund API',
        to: 'Redis ledger',
        label: 'EVAL check-and-add(amount ≤ paid_minor − refunded)',
        kind: 'sync',
      },
      {
        from: 'Redis ledger',
        to: 'Refund API',
        label: '{accepted, refunded_minor, remaining_minor} | refused',
        kind: 'reply',
      },
      {from: 'Refund API', to: 'refund records', label: 'insert refund row · store (tenant, key)', kind: 'async'},
      {
        from: 'Refund API',
        to: 'Client',
        label: '201 {refund_id, remaining_minor} · 422 over the balance',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/refunds',
      detail: 'Register the refund route on `POST /v1/refunds`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/refunds["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/refunds['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/refunds"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"refunds"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/refunds"/]},
      },
    },
    {
      id: 'cap',
      title: 'Refuses an amount above the remaining balance with 422',
      detail:
        'An amount larger than `paid_minor` minus the refunded total is answered **422** with the remaining balance in the body; the draft refunds whatever the caller asks for. The cap is `paid_minor`, enforced at the claim.',
      match: {
        python: {all: [/status_code\s*=\s*422/, /paid_minor/]},
        typescript: {all: [/\.code\(\s*422\s*\)/, /paid_minor/]},
        go: {all: [/StatusUnprocessableEntity/, /paidMinor/]},
        scala: {all: [/StatusCodes\.UnprocessableEntity/, /paidMinor/]},
        cpp: {all: [/\b422\b/, /paid_minor/]},
      },
    },
    {
      id: 'tenant-scope',
      title: 'Authenticates the tenant and 404s a foreign payment',
      detail:
        'A missing `X-Tenant-Id` is **401** and a payment owned by another tenant is **404**, checked before the ledger is touched. The draft refunds whatever payment id the path or body names.',
      match: {
        python: {all: [/status_code\s*=\s*401/, /status_code\s*=\s*404/]},
        typescript: {all: [/\.code\(\s*401\s*\)/, /\.code\(\s*404\s*\)/]},
        go: {all: [/StatusUnauthorized/, /StatusNotFound/]},
        scala: {all: [/StatusCodes\.Unauthorized/, /StatusCodes\.NotFound/]},
        cpp: {all: [/\b401\b/, /\b404\b/]},
      },
    },
    {
      id: 'idempotency-key',
      title: 'Requires Idempotency-Key and replays the first refund',
      detail:
        '`Idempotency-Key` is required (**400** when absent) and the refund is stored under `(tenant, key)`; a replay returns the stored refund instead of refunding again. The draft never reads the header.',
      match: {
        python: {all: [/Idempotency-Key/, /status_code\s*=\s*400/, /refunds\.get\(/, /refunds\.put\(/]},
        typescript: {all: [/'idempotency-key'/, /\.code\(\s*400\s*\)/, /refunds\.get\(/, /refunds\.put\(/]},
        go: {all: [/Idempotency-Key/, /StatusBadRequest/, /refunds\.Get\(/, /refunds\.Put\(/]},
        scala: {all: [/Idempotency-Key/, /StatusCodes\.BadRequest/, /refunds\.get\(/, /refunds\.put\(/]},
        cpp: {all: [/Idempotency-Key/, /\b400\b/, /refunds\.get\(/, /refunds\.put\(/]},
      },
    },
    {
      id: 'remaining-balance',
      title: 'Leaves the reduced balance visible immediately',
      detail:
        'The accepted response carries the new `remaining_minor` computed from the payment total and the refunded amount, so a partial refund shows the reduced balance at once. The draft returns no balance at all.',
      match: {
        python: {all: [/remaining_minor/, /paid_minor/]},
        typescript: {all: [/remaining_minor/, /paid_minor/]},
        go: {all: [/remainingMinor/, /paidMinor/]},
        scala: {all: [/remainingMinor/, /paidMinor/]},
        cpp: {all: [/remaining_minor/, /paid_minor/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("refunds")


class RefundRequest(BaseModel):
    payment_id: str
    amount_minor: int
    reason_code: str


class RefundStore:
    def get(self, tenant: str, idem_key: str) -> dict | None:
        """The refund stored for (tenant, idem_key), if any."""
        raise NotImplementedError

    def put(self, tenant: str, idem_key: str, refund: dict) -> None:
        """Store the refund under (tenant, idem_key)."""
        raise NotImplementedError


refunds = RefundStore()


@app.post("/v1/refunds")
def create_refund(body: RefundRequest, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this draft refunds whatever the client asks for. It reads the balance and never checks
    # it, ignores Idempotency-Key, never proves the payment belongs to the tenant, and lets two
    # concurrent requests refund the same payment twice. Review all four.
    logger.info("refund tenant=%s payment=%s amount=%d", tenant, body.payment_id, body.amount_minor)
    return JSONResponse(
        {
            "payment_id": body.payment_id,
            "amount_minor": body.amount_minor,
            "reason_code": body.reason_code,
            "status": "PENDING",
        },
        status_code=200,
    )
`,
      solution: `import logging
import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("refunds")

REASON_CODES = {"damaged", "not_received", "duplicate", "goodwill"}


class RefundRequest(BaseModel):
    payment_id: str
    amount_minor: int
    reason_code: str


class RefundStore:
    def get(self, tenant: str, idem_key: str) -> dict | None:
        """The refund stored for (tenant, idem_key), if any."""
        raise NotImplementedError

    def put(self, tenant: str, idem_key: str, refund: dict) -> None:
        """Store the refund under (tenant, idem_key)."""
        raise NotImplementedError


class Payments:
    def get(self, payment_id: str) -> dict | None:
        """{"tenant": ..., "paid_minor": ...} for the payment, or None."""
        raise NotImplementedError

    def insert_refund(self, refund: dict) -> None:
        """Append the durable refund row."""
        raise NotImplementedError


class Ledger:
    def check_and_add_refund(
        self, payment_id: str, amount_minor: int, cap_minor: int
    ) -> tuple[bool, int, int]:
        """(accepted, refunded_minor, remaining_minor) — one atomic check-and-add capped at cap_minor."""
        raise NotImplementedError


refunds = RefundStore()
payments = Payments()
ledger = Ledger()


@app.post("/v1/refunds")
def create_refund(
    body: RefundRequest,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    idem_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if idem_key is None or idem_key == "":
        raise HTTPException(status_code=400, detail="Idempotency-Key is required")
    if body.amount_minor < 1:
        raise HTTPException(status_code=400, detail="amount_minor must be at least 1")
    if body.reason_code not in REASON_CODES:
        raise HTTPException(status_code=400, detail="unknown reason_code")

    stored = refunds.get(tenant, idem_key)
    if stored is not None:
        return JSONResponse(stored, status_code=200)

    payment = payments.get(body.payment_id)
    if payment is None or payment["tenant"] != tenant:
        raise HTTPException(status_code=404, detail="payment not found")

    ok, refunded_total, remaining_minor = ledger.check_and_add_refund(
        body.payment_id, body.amount_minor, payment["paid_minor"]
    )
    if not ok:
        raise HTTPException(
            status_code=422,
            detail={
                "error": "amount exceeds the remaining refundable balance",
                "remaining_minor": remaining_minor,
            },
        )

    refund = {
        "refund_id": str(uuid.uuid4()),
        "payment_id": body.payment_id,
        "amount_minor": body.amount_minor,
        "reason_code": body.reason_code,
        "status": "PENDING",
        "refunded_minor": refunded_total,
        "remaining_minor": remaining_minor,
    }
    payments.insert_refund(refund)
    refunds.put(tenant, idem_key, refund)
    logger.info(
        "refund tenant=%s payment=%s amount=%d remaining=%d",
        tenant,
        body.payment_id,
        body.amount_minor,
        remaining_minor,
    )
    return JSONResponse(refund, status_code=201)
`,
    },
    typescript: {
      starter: `/** POST /v1/refunds: a model-generated draft that refunds whatever the client asks for. */
import Fastify from 'fastify';

export const app = Fastify();

interface RefundBody {
  payment_id: string;
  amount_minor: number;
  reason_code: string;
}

app.post('/v1/refunds', async (request, reply) => {
  // TODO: this draft refunds whatever the client asks for. It reads the balance and never checks
  // it, ignores Idempotency-Key, never proves the payment belongs to the tenant, and lets two
  // concurrent requests refund the same payment twice. Review all four.
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as RefundBody;
  request.log.info({tenant, payment_id: body.payment_id, amount_minor: body.amount_minor}, 'refund accepted');
  return reply.code(200).send({
    payment_id: body.payment_id,
    amount_minor: body.amount_minor,
    reason_code: body.reason_code,
    status: 'PENDING',
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/refunds: capped by what was paid, keyed by (tenant, Idempotency-Key). */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import {ledger} from './state';
import {payments, refunds} from './store';

export const app = Fastify();

const REASON_CODES: Record<string, true> = {
  damaged: true,
  not_received: true,
  duplicate: true,
  goodwill: true,
};

interface RefundBody {
  payment_id: string;
  amount_minor: number;
  reason_code: string;
}

app.post('/v1/refunds', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const idemKey = request.headers['idempotency-key'];
  if (typeof idemKey !== 'string' || idemKey === '')
    return reply.code(400).send({error: 'Idempotency-Key is required'});

  const body = request.body as Partial<RefundBody> | null;
  if (body === null || typeof body !== 'object' || typeof body.payment_id !== 'string')
    return reply.code(400).send({error: 'payment_id must be a string'});
  const amountMinor = body.amount_minor;
  if (typeof amountMinor !== 'number' || !Number.isInteger(amountMinor) || amountMinor < 1)
    return reply.code(400).send({error: 'amount_minor must be at least 1'});
  const reasonCode = body.reason_code ?? '';
  if (REASON_CODES[reasonCode] !== true) return reply.code(400).send({error: 'unknown reason_code'});

  const stored = await refunds.get(tenant, idemKey);
  if (stored !== null) return reply.code(200).send(stored);

  const payment = await payments.get(body.payment_id);
  if (payment === null || payment.tenant !== tenant) return reply.code(404).send({error: 'payment not found'});

  const claim = await ledger.checkAndAddRefund(body.payment_id, amountMinor, payment.paid_minor);
  if (!claim.accepted)
    return reply
      .code(422)
      .send({error: 'amount exceeds the remaining refundable balance', remaining_minor: claim.remaining_minor});

  const refund = {
    refund_id: randomUUID(),
    payment_id: body.payment_id,
    amount_minor: amountMinor,
    reason_code: reasonCode,
    status: 'PENDING',
    refunded_minor: claim.refunded_minor,
    remaining_minor: claim.remaining_minor,
  };
  await payments.insertRefund(refund);
  await refunds.put(tenant, idemKey, refund);
  request.log.info(
    {tenant, payment_id: body.payment_id, amount_minor: amountMinor, remaining_minor: claim.remaining_minor},
    'refund accepted',
  );
  return reply.code(201).send(refund);
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
)

type RefundRequest struct {
	PaymentID   string \`json:"payment_id"\`
	AmountMinor int64  \`json:"amount_minor"\`
	ReasonCode  string \`json:"reason_code"\`
}

type RefundStore struct{}

func (s *RefundStore) Get(ctx context.Context, tenant, idemKey string) (map[string]any, error) {
	return nil, nil
}

func (s *RefundStore) Put(ctx context.Context, tenant, idemKey string, refund map[string]any) error {
	return nil
}

var refunds = &RefundStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func createRefund(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	body := RefundRequest{}
	_ = json.NewDecoder(r.Body).Decode(&body)
	// TODO: this draft refunds whatever the client asks for. It reads the balance and never checks
	// it, ignores Idempotency-Key, never proves the payment belongs to the tenant, and lets two
	// concurrent requests refund the same payment twice. Review all four.
	log.Printf("refund tenant=%s payment=%s amount=%d", tenant, body.PaymentID, body.AmountMinor)
	writeJSON(rw, http.StatusOK, map[string]any{
		"payment_id":   body.PaymentID,
		"amount_minor": body.AmountMinor,
		"reason_code":  body.ReasonCode,
		"status":       "PENDING",
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/refunds", createRefund)
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

var reasonCodes = map[string]bool{"damaged": true, "not_received": true, "duplicate": true, "goodwill": true}

type RefundRequest struct {
	PaymentID   string \`json:"payment_id"\`
	AmountMinor int64  \`json:"amount_minor"\`
	ReasonCode  string \`json:"reason_code"\`
}

type Payment struct {
	Tenant    string \`json:"tenant"\`
	PaidMinor int64  \`json:"paid_minor"\`
}

type RefundStore struct{}

func (s *RefundStore) Get(ctx context.Context, tenant, idemKey string) (map[string]any, error) {
	return nil, nil
}

func (s *RefundStore) Put(ctx context.Context, tenant, idemKey string, refund map[string]any) error {
	return nil
}

type Payments struct{}

func (p *Payments) Get(ctx context.Context, paymentID string) (*Payment, error) {
	return nil, nil
}

func (p *Payments) InsertRefund(ctx context.Context, refund map[string]any) error {
	return nil
}

type Ledger struct{}

func (l *Ledger) CheckAndAddRefund(
	ctx context.Context,
	paymentID string,
	amountMinor, capMinor int64,
) (bool, int64, int64) {
	return true, amountMinor, capMinor - amountMinor
}

var (
	refunds  = &RefundStore{}
	payments = &Payments{}
	ledger   = &Ledger{}
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func createRefund(rw http.ResponseWriter, r *http.Request) {
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
	body := RefundRequest{}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if body.AmountMinor < 1 {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "amount_minor must be at least 1"})
		return
	}
	if !reasonCodes[body.ReasonCode] {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "unknown reason_code"})
		return
	}
	if stored, err := refunds.Get(r.Context(), tenant, idemKey); err == nil && stored != nil {
		writeJSON(rw, http.StatusOK, stored)
		return
	}
	payment, err := payments.Get(r.Context(), body.PaymentID)
	if err != nil || payment == nil || payment.Tenant != tenant {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "payment not found"})
		return
	}
	paidMinor := payment.PaidMinor
	accepted, refundedTotal, remainingMinor := ledger.CheckAndAddRefund(r.Context(), body.PaymentID, body.AmountMinor, paidMinor)
	if !accepted {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]any{
			"error":           "amount exceeds the remaining refundable balance",
			"remaining_minor": remainingMinor,
		})
		return
	}
	refund := map[string]any{
		"refund_id":      uuid.NewString(),
		"payment_id":     body.PaymentID,
		"amount_minor":   body.AmountMinor,
		"reason_code":    body.ReasonCode,
		"status":         "PENDING",
		"refunded_minor": refundedTotal,
		"remaining_minor": remainingMinor,
	}
	if err := payments.InsertRefund(r.Context(), refund); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if err := refunds.Put(r.Context(), tenant, idemKey, refund); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("refund tenant=%s payment=%s amount=%d remaining=%d", tenant, body.PaymentID, body.AmountMinor, remainingMinor)
	writeJSON(rw, http.StatusCreated, refund)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/refunds", createRefund)
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

final case class RefundRequest(payment_id: String, amount_minor: Long, reason_code: String)

object Api {
  implicit val system: ActorSystem = ActorSystem("refunds")
  implicit val refundFormat: RootJsonFormat[RefundRequest] = jsonFormat3(RefundRequest)

  val refunds = RefundStore.open()

  val route: Route =
    path("v1" / "refunds") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[RefundRequest]) { body =>
            // TODO: this draft refunds whatever the client asks for. It reads the balance and never
            // checks it, ignores Idempotency-Key, never proves the payment belongs to the tenant,
            // and lets two concurrent requests refund the same payment twice. Review all four.
            system.log.info(s"refund tenant=$tenant payment=\${body.payment_id} amount=\${body.amount_minor}")
            complete(
              StatusCodes.OK,
              s"""{"payment_id":"\${body.payment_id}","amount_minor":\${body.amount_minor},"status":"PENDING"}"""
            )
          }
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

final case class RefundRequest(payment_id: String, amount_minor: Long, reason_code: String)
final case class Refund(
    refund_id: String,
    payment_id: String,
    amount_minor: Long,
    reason_code: String,
    status: String,
    refunded_minor: Long,
    remaining_minor: Long
)

object Api {
  implicit val system: ActorSystem = ActorSystem("refunds")
  implicit val refundRequestFormat: RootJsonFormat[RefundRequest] = jsonFormat3(RefundRequest)
  implicit val refundFormat: RootJsonFormat[Refund] = jsonFormat7(Refund)

  val ReasonCodes = Set("damaged", "not_received", "duplicate", "goodwill")

  val refunds = RefundStore.open()
  val payments = Payments.open()
  val ledger = Ledger.open()

  val route: Route =
    path("v1" / "refunds") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          optionalHeaderValueByName("Idempotency-Key") { idemOpt =>
            entity(as[RefundRequest]) { body =>
              if (!tenantOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
              } else if (!idemOpt.exists(_.nonEmpty)) {
                complete(StatusCodes.BadRequest, """{"error":"Idempotency-Key is required"}""")
              } else if (body.amount_minor < 1) {
                complete(StatusCodes.BadRequest, """{"error":"amount_minor must be at least 1"}""")
              } else if (!ReasonCodes.contains(body.reason_code)) {
                complete(StatusCodes.BadRequest, """{"error":"unknown reason_code"}""")
              } else {
                val tenant = tenantOpt.get
                val idemKey = idemOpt.get
                refunds.get(tenant, idemKey) match {
                  case Some(stored) =>
                    complete(StatusCodes.OK, stored)
                  case None =>
                    payments.get(body.payment_id) match {
                      case Some(payment) if payment.tenant == tenant =>
                        val (accepted, refundedTotal, remainingMinor) =
                          ledger.checkAndAddRefund(body.payment_id, body.amount_minor, payment.paidMinor)
                        if (!accepted) {
                          complete(
                            StatusCodes.UnprocessableEntity,
                            s"""{"error":"amount exceeds the remaining refundable balance","remaining_minor":$remainingMinor}"""
                          )
                        } else {
                          val refund = Refund(
                            UUID.randomUUID().toString,
                            body.payment_id,
                            body.amount_minor,
                            body.reason_code,
                            "PENDING",
                            refundedTotal,
                            remainingMinor
                          )
                          payments.insertRefund(refund)
                          refunds.put(tenant, idemKey, refund)
                          system.log.info(
                            s"refund tenant=$tenant payment=\${body.payment_id} amount=\${body.amount_minor} remaining=$remainingMinor"
                          )
                          complete(StatusCodes.Created, refund)
                        }
                      case _ =>
                        complete(StatusCodes.NotFound, """{"error":"payment not found"}""")
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
#include <string>

using json = nlohmann::json;

struct RefundStore {
  std::optional<json> get(const std::string& tenant, const std::string& idemKey);
  void put(const std::string& tenant, const std::string& idemKey, const json& refund);
};

RefundStore refunds;

int main() {
  httplib::Server svr;

  svr.Post("/v1/refunds", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this draft refunds whatever the client asks for. It reads the balance and never checks
    // it, ignores Idempotency-Key, never proves the payment belongs to the tenant, and lets two
    // concurrent requests refund the same payment twice. Review all four.
    std::cerr << "refund tenant=" << tenant << " payment=" << body.value("payment_id", std::string()) << "\\n";
    res.status = 200;
    res.set_content(
        json{{"payment_id", body.value("payment_id", std::string())},
             {"amount_minor", body.value("amount_minor", 0)},
             {"status", "PENDING"}}
            .dump(),
        "application/json");
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

const std::set<std::string> kReasonCodes = {"damaged", "not_received", "duplicate", "goodwill"};

struct RefundStore {
  std::optional<json> get(const std::string& tenant, const std::string& idemKey);
  void put(const std::string& tenant, const std::string& idemKey, const json& refund);
};

struct Payment {
  std::string tenant;
  long long paid_minor;
};

struct Payments {
  std::optional<Payment> get(const std::string& paymentId);
  void insertRefund(const json& refund);
};

struct Ledger {
  std::tuple<bool, long long, long long> checkAndAddRefund(
      const std::string& paymentId,
      long long amountMinor,
      long long capMinor);
};

RefundStore refunds;
Payments payments;
Ledger ledger;
std::string uuidString();

int main() {
  httplib::Server svr;

  svr.Post("/v1/refunds", [](const httplib::Request& req, httplib::Response& res) {
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
    if (!body.is_object() || !body.contains("payment_id")) {
      res.status = 400;
      res.set_content(R"({"error":"payment_id is required"})", "application/json");
      return;
    }
    const auto paymentId = body["payment_id"].get<std::string>();
    const long long amountMinor = body.value("amount_minor", 0LL);
    if (amountMinor < 1) {
      res.status = 400;
      res.set_content(R"({"error":"amount_minor must be at least 1"})", "application/json");
      return;
    }
    const auto reasonCode = body.value("reason_code", std::string());
    if (kReasonCodes.count(reasonCode) == 0) {
      res.status = 400;
      res.set_content(R"({"error":"unknown reason_code"})", "application/json");
      return;
    }
    if (const auto stored = refunds.get(tenant, idemKey)) {
      res.status = 200;
      res.set_content(stored->dump(), "application/json");
      return;
    }
    const auto payment = payments.get(paymentId);
    if (!payment || payment->tenant != tenant) {
      res.status = 404;
      res.set_content(R"({"error":"payment not found"})", "application/json");
      return;
    }
    const auto paid_minor = payment->paid_minor;
    const auto [accepted, refundedTotal, remaining_minor] = ledger.checkAndAddRefund(paymentId, amountMinor, paid_minor);
    if (!accepted) {
      res.status = 422;
      res.set_content(
          json{{"error", "amount exceeds the remaining refundable balance"}, {"remaining_minor", remaining_minor}}.dump(),
          "application/json");
      return;
    }
    const json refund = {
        {"refund_id", uuidString()},
        {"payment_id", paymentId},
        {"amount_minor", amountMinor},
        {"reason_code", reasonCode},
        {"status", "PENDING"},
        {"refunded_minor", refundedTotal},
        {"remaining_minor", remaining_minor},
    };
    payments.insertRefund(refund);
    refunds.put(tenant, idemKey, refund);
    std::cerr << "refund tenant=" << tenant << " payment=" << paymentId << " amount=" << amountMinor << "\\n";
    res.status = 201;
    res.set_content(refund.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Order the guards by cost and by authority: tenant (**401**), `Idempotency-Key` (**400**), amount and reason code (**400**), then the payment row and its owner (**404**). A guard that runs after the ledger has been touched is a guard that can leave the balance wrong.',
    'The cap belongs to the payment, not to the request: pass `paid_minor` into the ledger call as the cap and answer **422** — not 400, not 200 — when the atomic check-and-add refuses. Reading the balance here and comparing it is check-then-act: two concurrent requests both see room that only one of them can spend.',
    'The replay lookup is `(tenant, key)` → the stored refund, resolved **before** anything is claimed, and the refund is written under the same key immediately after the claim. Return the stored body unchanged on a replay, so one client intent keeps one `refund_id`.',
  ],
  debrief: `The interviewer is testing whether you can review a generated handler at the trust boundary and at the money boundary. The draft reads fine because the demo posts well-formed requests from one tenant with one refund. Four defects are being checked: authentication and payment ownership (tenant always required, a foreign payment is 404), input validation (cheap rejections before any ledger work), the lifetime cap (an amount above the remaining balance is 422, decided by the atomic claim rather than by a read), and idempotency keyed by \`(tenant, key)\` so a retry returns the first refund instead of paying twice. The response shape is the fifth: a partial refund must show the reduced balance immediately, because the support tool and finance reconcile against the same number. Real refund services add a refund window (only within N days of capture), per-reason approval limits, and a manual-approval queue above an amount threshold.`,
};
