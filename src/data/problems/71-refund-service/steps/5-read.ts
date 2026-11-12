import type {Step} from '@/lib/types';

export const refundReadStep: Step = {
  id: 'read',
  title: 'GET /v1/payments/{id}/refunds: the totals finance trusts',
  concept: 'http',
  guides: ['honest-reads', 'request-boundaries'],
  file: 'read',
  focus: ['finance', 'api', 'records', 'ledger', 'psp'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/payments/{payment_id}/refunds\`: it loads the
payment, reads \`ledger.refunded_total(payment_id)\` and answers \`{payment_id, paid_minor,
refunded_minor, remaining_minor, refunds: [{refund_id, amount_minor}]}\` with the ledger's total as
\`refunded_minor\`. It serves the demo and hides four flaws.

**Failure mode the checks target.** Any caller reading any merchant's refunds, a total that counts a
pending refund as paid, a ledger that lost a write with nobody told, and a refund the PSP already
paid still shown as pending.

- Tenant from \`X-Tenant-Id\` (**401** when missing); another tenant's payment answers **404**, like
  a missing one.
- Totals come from \`records.list_refunds\`: \`refunded_minor\` sums the \`CONFIRMED\` rows,
  \`pending_minor\` the \`PENDING\` ones, \`remaining_minor = paid_minor - refunded_minor -
  pending_minor\`.
- \`drift_minor = refunded_minor + pending_minor - ledger.refunded_total(payment_id)\`, reported and
  left for a repair to act on.
- Every \`PENDING\` row first goes through \`psp.reconcile(refund_id)\` (step 3, provided as
  \`refunds.psp\`) and is reported as its record then stands.
- Each row carries \`refund_id\`, \`amount_minor\`, \`reason_code\`, \`status\` and \`psp_ref\`.`,
  sequence: {
    participants: ['Finance', 'Refund API', 'refund records', 'PSP', 'Redis ledger'],
    messages: [
      {from: 'Finance', to: 'Refund API', label: 'GET /v1/payments/pay_1/refunds · X-Tenant-Id', kind: 'sync'},
      {from: 'Refund API', to: 'refund records', label: 'find_payment · owner check · list_refunds', kind: 'sync'},
      {from: 'Refund API', to: 'PSP', label: 'reconcile(rf-4) → GetRefund · 5 s', kind: 'sync'},
      {from: 'PSP', to: 'Refund API', label: 'SUCCEEDED re_4 | NOT_FOUND', kind: 'reply'},
      {from: 'Refund API', to: 'Redis ledger', label: 'refunded_total(pay_1) → drift_minor', kind: 'sync'},
      {
        from: 'Refund API',
        to: 'Finance',
        label: '200 {refunded_minor, pending_minor, remaining_minor, drift_minor, refunds}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'tenant-scope',
      title: 'Authenticates the tenant and 404s a foreign payment',
      detail:
        'No `X-Tenant-Id` is **401** and another tenant’s payment is **404** like a missing one. The starter serves any payment to anyone.',
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
      id: 'durable-total',
      title: 'Totals the records: confirmed, pending, remaining',
      detail:
        'A CONFIRMED 3000, a REJECTED 2000 and a PENDING 1000 report refunded_minor 3000, pending_minor 1000, remaining_minor 6000, each row with its status, reason code and PSP reference. The starter reports the ledger’s 4000 as refunded.',
      match: {
        python: {all: [/["']CONFIRMED["']/, /pending_minor/, /psp_ref/]},
        typescript: {all: [/['"]CONFIRMED['"]/, /pending_minor/, /psp_ref/]},
        go: {all: [/"CONFIRMED"/, /"pending_minor"/, /"psp_ref"/]},
        scala: {all: [/"CONFIRMED"/, /"pending_minor"/, /"psp_ref"/]},
        cpp: {all: [/"CONFIRMED"/, /"pending_minor"/, /"psp_ref"/]},
      },
    },
    {
      id: 'drift',
      title: 'Reports how far the ledger drifted from the records',
      detail:
        'With the ledger in step the response says drift_minor 0; after the ledger lost a 3000 claim it says 3000. The starter never compares the two.',
      match: {
        python: {all: [/drift_minor/, /ledger\.refunded_total\(/]},
        typescript: {all: [/drift_minor/, /refundedTotal\(/]},
        go: {all: [/"drift_minor"/, /ledger\.RefundedTotal\(/]},
        scala: {all: [/"drift_minor"/, /Ledger\.refundedTotal\(/]},
        cpp: {all: [/"drift_minor"/, /ledger::refundedTotal\(/]},
      },
    },
    {
      id: 'pending-reconciled',
      title: 'Reconciles pending refunds with the PSP before answering',
      detail:
        'A PENDING refund the PSP has paid is reported CONFIRMED with its reference and counted as refunded; one the PSP never saw stays pending. The starter reports whatever the records said.',
      match: {
        python: {all: [/psp\.reconcile\(/]},
        typescript: {all: [/\breconcile\(/]},
        go: {all: [/psp\.Reconcile\(/]},
        scala: {all: [/Psp\.reconcile\(/]},
        cpp: {all: [/psp::reconcile\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException

from refunds import ledger, psp, records  # records.find_payment, list_refunds, find_refund; ledger.refunded_total; psp.reconcile

app = FastAPI()


@app.get("/v1/payments/{payment_id}/refunds")
def read_refunds(payment_id: str) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    payment = records.find_payment(payment_id)
    if payment is None:
        raise HTTPException(status_code=404, detail="no such payment")
    refunded = ledger.refunded_total(payment_id)
    rows = [{"refund_id": row["refund_id"], "amount_minor": row["amount_minor"]} for row in records.list_refunds(payment_id)]
    return {
        "payment_id": payment_id,
        "paid_minor": payment["paid_minor"],
        "refunded_minor": refunded,
        "remaining_minor": payment["paid_minor"] - refunded,
        "refunds": rows,
    }
`,
      solution: `from fastapi import FastAPI, HTTPException, Request

from refunds import ledger, psp, records  # records.find_payment, list_refunds, find_refund; ledger.refunded_total; psp.reconcile

app = FastAPI()


@app.get("/v1/payments/{payment_id}/refunds")
def read_refunds(payment_id: str, request: Request) -> dict:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    payment = records.find_payment(payment_id)
    if payment is None or payment["tenant"] != tenant:
        raise HTTPException(status_code=404, detail="no such payment")  # another tenant's payment looks missing
    rows = []
    for row in records.list_refunds(payment_id):
        if row["status"] == "PENDING":
            # The PSP may have settled it since: ask before reporting it.
            psp.reconcile(row["refund_id"])
            row = records.find_refund(row["refund_id"])
        rows.append(row)
    refunded = sum(row["amount_minor"] for row in rows if row["status"] == "CONFIRMED")
    pending = sum(row["amount_minor"] for row in rows if row["status"] == "PENDING")
    return {
        "payment_id": payment_id,
        "paid_minor": payment["paid_minor"],
        "refunded_minor": refunded,
        "pending_minor": pending,
        "remaining_minor": payment["paid_minor"] - refunded - pending,
        # What the records hold minus what the ledger holds: reported, for a repair to act on.
        "drift_minor": refunded + pending - ledger.refunded_total(payment_id),
        "refunds": [
            {name: row[name] for name in ("refund_id", "amount_minor", "reason_code", "status", "psp_ref")} for row in rows
        ],
    }
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {refundedTotal} from 'refunds/ledger';
import {reconcile} from 'refunds/psp';
import {findPayment, findRefund, listRefunds} from 'refunds/records';

export const app = Fastify();

app.get('/v1/payments/:paymentId/refunds', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const {paymentId} = request.params as {paymentId: string};
  const payment = await findPayment(paymentId);
  if (payment === null) return reply.code(404).send({error: 'no such payment'});
  const refunded = await refundedTotal(paymentId);
  const rows = (await listRefunds(paymentId)).map(row => ({refund_id: row.refund_id, amount_minor: row.amount_minor}));
  return {payment_id: paymentId, paid_minor: payment.paid_minor, refunded_minor: refunded, remaining_minor: payment.paid_minor - refunded, refunds: rows};
});
`,
      solution: `import Fastify from 'fastify';

import {refundedTotal} from 'refunds/ledger';
import {reconcile} from 'refunds/psp';
import {type Refund, findPayment, findRefund, listRefunds} from 'refunds/records';

export const app = Fastify();

app.get('/v1/payments/:paymentId/refunds', async (request, reply) => {
  const tenant = (request.headers['x-tenant-id'] as string | undefined) ?? '';
  if (tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {paymentId} = request.params as {paymentId: string};
  const payment = await findPayment(paymentId);
  // Another tenant's payment looks missing.
  if (payment === null || payment.tenant !== tenant) return reply.code(404).send({error: 'no such payment'});
  const rows: Refund[] = [];
  for (const row of await listRefunds(paymentId)) {
    if (row.status !== 'PENDING') {
      rows.push(row);
      continue;
    }
    // The PSP may have settled it since: ask before reporting it.
    await reconcile(row.refund_id);
    rows.push((await findRefund(row.refund_id)) as Refund);
  }
  const total = (status: string) => rows.filter(row => row.status === status).reduce((sum, row) => sum + row.amount_minor, 0);
  const refunded = total('CONFIRMED');
  const pending = total('PENDING');
  return {
    payment_id: paymentId,
    paid_minor: payment.paid_minor,
    refunded_minor: refunded,
    pending_minor: pending,
    remaining_minor: payment.paid_minor - refunded - pending,
    // What the records hold minus what the ledger holds: reported, for a repair to act on.
    drift_minor: refunded + pending - (await refundedTotal(paymentId)),
    refunds: rows.map(({refund_id, amount_minor, reason_code, status, psp_ref}) => ({refund_id, amount_minor, reason_code, status, psp_ref})),
  };
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"refunds/ledger"  // ledger.RefundedTotal
	"refunds/records" // records.FindPayment, ListRefunds, FindRefund
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func readRefunds(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	paymentID := r.PathValue("id")
	payment := records.FindPayment(r.Context(), paymentID)
	if payment == nil {
		http.Error(rw, "no such payment", http.StatusNotFound)
		return
	}
	refunded := ledger.RefundedTotal(r.Context(), paymentID)
	rows := []map[string]any{}
	for _, row := range records.ListRefunds(r.Context(), paymentID) {
		rows = append(rows, map[string]any{"refund_id": row.RefundID, "amount_minor": row.AmountMinor})
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"payment_id": paymentID, "paid_minor": payment.PaidMinor, "refunded_minor": refunded,
		"remaining_minor": payment.PaidMinor - refunded, "refunds": rows,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/payments/{id}/refunds", readRefunds)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"

	"refunds/ledger"  // ledger.RefundedTotal
	"refunds/psp"     // psp.Reconcile
	"refunds/records" // records.FindPayment, ListRefunds, FindRefund
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func readRefunds(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	paymentID := r.PathValue("id")
	payment := records.FindPayment(r.Context(), paymentID)
	if payment == nil || payment.Tenant != tenant {
		http.Error(rw, "no such payment", http.StatusNotFound) // another tenant's payment looks missing
		return
	}
	var refunded, pending int64
	rows := []map[string]any{}
	for _, row := range records.ListRefunds(r.Context(), paymentID) {
		if row.Status == "PENDING" {
			// The PSP may have settled it since: ask before reporting it.
			if _, err := psp.Reconcile(r.Context(), row.RefundID); err != nil {
				http.Error(rw, err.Error(), http.StatusServiceUnavailable)
				return
			}
			row = *records.FindRefund(r.Context(), row.RefundID)
		}
		switch row.Status {
		case "CONFIRMED":
			refunded += row.AmountMinor
		case "PENDING":
			pending += row.AmountMinor
		}
		rows = append(rows, map[string]any{
			"refund_id": row.RefundID, "amount_minor": row.AmountMinor, "reason_code": row.ReasonCode, "status": row.Status, "psp_ref": row.PspRef,
		})
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"payment_id": paymentID, "paid_minor": payment.PaidMinor, "refunded_minor": refunded, "pending_minor": pending,
		"remaining_minor": payment.PaidMinor - refunded - pending,
		// What the records hold minus what the ledger holds: reported, for a repair to act on.
		"drift_minor": refunded + pending - ledger.RefundedTotal(r.Context(), paymentID),
		"refunds":     rows,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/payments/{id}/refunds", readRefunds)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import refunds.{Ledger, Psp, Records} // Records.findPayment, listRefunds, findRefund; Ledger.refundedTotal; Psp.reconcile

object Read {
  val route: Route = path("v1" / "payments" / Segment / "refunds") { paymentId =>
    get {
      // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
      Records.findPayment(paymentId) match {
        case None => complete(StatusCodes.NotFound -> "no such payment")
        case Some(payment) =>
          val refunded = Ledger.refundedTotal(paymentId)
          val rows = Records.listRefunds(paymentId).map(row => JsObject("refund_id" -> JsString(row.refundId), "amount_minor" -> JsNumber(row.amountMinor)))
          val body = JsObject(
            "payment_id" -> JsString(paymentId), "paid_minor" -> JsNumber(payment.paidMinor), "refunded_minor" -> JsNumber(refunded),
            "remaining_minor" -> JsNumber(payment.paidMinor - refunded), "refunds" -> JsArray(rows.toVector))
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

import refunds.{Ledger, Psp, Records} // Records.findPayment, listRefunds, findRefund; Ledger.refundedTotal; Psp.reconcile

object Read {
  private def report(payment: Records.Payment): JsObject = {
    val paymentId = payment.paymentId
    val rows = Records.listRefunds(paymentId).map { row =>
      if (row.status != "PENDING") row
      else {
        // The PSP may have settled it since: ask before reporting it.
        Psp.reconcile(row.refundId)
        Records.findRefund(row.refundId).get
      }
    }
    def total(status: String): Long = rows.filter(_.status == status).map(_.amountMinor).sum
    val refunded = total("CONFIRMED")
    val pending = total("PENDING")
    JsObject(
      "payment_id" -> JsString(paymentId), "paid_minor" -> JsNumber(payment.paidMinor),
      "refunded_minor" -> JsNumber(refunded), "pending_minor" -> JsNumber(pending),
      "remaining_minor" -> JsNumber(payment.paidMinor - refunded - pending),
      // What the records hold minus what the ledger holds: reported, for a repair to act on.
      "drift_minor" -> JsNumber(refunded + pending - Ledger.refundedTotal(paymentId)),
      "refunds" -> JsArray(rows.toVector.map(row => JsObject(
        "refund_id" -> JsString(row.refundId), "amount_minor" -> JsNumber(row.amountMinor), "reason_code" -> JsString(row.reasonCode),
        "status" -> JsString(row.status), "psp_ref" -> JsString(row.pspRef)))))
  }

  val route: Route = path("v1" / "payments" / Segment / "refunds") { paymentId =>
    get {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
        case Some(tenant) =>
          Records.findPayment(paymentId) match {
            // Another tenant's payment looks missing.
            case Some(payment) if payment.tenant == tenant =>
              complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, report(payment).compactPrint)))
            case _ => complete(StatusCodes.NotFound -> "no such payment")
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

#include "refunds/ledger.h"   // ledger::refundedTotal
#include "refunds/psp.h"      // psp::reconcile
#include "refunds/records.h"  // records::findPayment, listRefunds, findRefund

using json = nlohmann::json;

void read_refunds(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string payment_id = req.matches[1];
  const auto payment = records::findPayment(payment_id);
  if (!payment) {
    res.status = 404;
    res.set_content("no such payment", "text/plain");
    return;
  }
  const long long refunded = ledger::refundedTotal(payment_id);
  json rows = json::array();
  for (const records::Refund& row : records::listRefunds(payment_id)) {
    rows.push_back(json{{"refund_id", row.refund_id}, {"amount_minor", row.amount_minor}});
  }
  const json body{{"payment_id", payment_id},
                  {"paid_minor", payment->paid_minor},
                  {"refunded_minor", refunded},
                  {"remaining_minor", payment->paid_minor - refunded},
                  {"refunds", rows}};
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/payments/([\\w-]+)/refunds)", read_refunds); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

#include "refunds/ledger.h"   // ledger::refundedTotal
#include "refunds/psp.h"      // psp::reconcile
#include "refunds/records.h"  // records::findPayment, listRefunds, findRefund

using json = nlohmann::json;

void read_refunds(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content("X-Tenant-Id is required", "text/plain");
    return;
  }
  const std::string payment_id = req.matches[1];
  const auto payment = records::findPayment(payment_id);
  if (!payment || payment->tenant != tenant) {
    res.status = 404;  // another tenant's payment looks missing
    res.set_content("no such payment", "text/plain");
    return;
  }
  long long refunded = 0;
  long long pending = 0;
  json rows = json::array();
  for (records::Refund row : records::listRefunds(payment_id)) {
    if (row.status == "PENDING") {
      // The PSP may have settled it since: ask before reporting it.
      psp::reconcile(row.refund_id);
      row = *records::findRefund(row.refund_id);
    }
    if (row.status == "CONFIRMED") refunded += row.amount_minor;
    if (row.status == "PENDING") pending += row.amount_minor;
    rows.push_back(json{{"refund_id", row.refund_id},
                        {"amount_minor", row.amount_minor},
                        {"reason_code", row.reason_code},
                        {"status", row.status},
                        {"psp_ref", row.psp_ref}});
  }
  const json body{{"payment_id", payment_id},
                  {"paid_minor", payment->paid_minor},
                  {"refunded_minor", refunded},
                  {"pending_minor", pending},
                  {"remaining_minor", payment->paid_minor - refunded - pending},
                  // What the records hold minus what the ledger holds: reported, for a repair to act on.
                  {"drift_minor", refunded + pending - ledger::refundedTotal(payment_id)},
                  {"refunds", rows}};
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/payments/([\\w-]+)/refunds)", read_refunds); }
`,
    },
  },
  harness: {
    python: `import grpc

import refund_service_pb2
import refund_service_pb2_grpc
from refunds import ledger, records


class Psp(refund_service_pb2_grpc.PspServicer):
    """The PSP stand-in: it has paid the refunds in applied and never saw any other."""

    def __init__(self):
        self.applied = {"rf-4": "re_4"}

    def Refund(self, request, context):
        context.abort(grpc.StatusCode.UNIMPLEMENTED, "the read path does not pay refunds out")

    def GetRefund(self, request, context):
        ref = self.applied.get(request.refund_id)
        if ref is None:
            context.abort(grpc.StatusCode.NOT_FOUND, f"no refund {request.refund_id}")
        return refund_service_pb2.RefundStatus(refund_id=request.refund_id, status="SUCCEEDED", psp_ref=ref)


def _read(ctx, pending_paid=False):
    ctx.grpc.serve(refund_service_pb2_grpc.add_PspServicer_to_server, Psp())
    records.add_payment("pay_1", "t1", 10000)
    records.add_payment("pay_2", "t2", 8000)
    seeds = [("rf-1", 3000, "CONFIRMED"), ("rf-2", 2000, "REJECTED"), ("rf-3", 1000, "PENDING")]
    if pending_paid:
        seeds.append(("rf-4", 2000, "PENDING"))
    for refund_id, amount, status in seeds:
        ledger.claim("pay_1", refund_id, amount, 10000)
        records.insert_refund(refund_id, "t1", "pay_1", amount, "damaged", "")
        if status == "CONFIRMED":
            records.mark_confirmed(refund_id, "re_" + refund_id[3:])
        if status == "REJECTED":
            records.mark_rejected(refund_id)
            ledger.release("pay_1", refund_id)
    return ctx.client(ctx.load("read").app)


async def _get(c, payment="pay_1", tenant="t1"):
    headers = {"X-Tenant-Id": tenant} if tenant else {}
    return await c.get(f"/v1/payments/{payment}/refunds", headers=headers)


async def check_tenant_scope(ctx):
    async with _read(ctx) as c:
        anonymous = await _get(c, tenant="")
        foreign = await _get(c, tenant="t2")
        missing = await _get(c, payment="pay_404")
        own = await _get(c)
    assert anonymous.status_code == 401, f"a read without X-Tenant-Id answered {anonymous.status_code}, expected 401"
    assert foreign.status_code == 404, f"tenant t2 reading t1's payment answered {foreign.status_code}, expected 404 (a foreign payment looks missing)"
    assert missing.status_code == 404, f"a missing payment answered {missing.status_code}, expected 404"
    assert own.status_code == 200, f"t1 reading its own payment answered {own.status_code}: {own.text}"


async def check_durable_total(ctx):
    async with _read(ctx) as c:
        r = await _get(c)
    assert r.status_code == 200, f"the read answered {r.status_code}: {r.text}"
    body = r.json()
    got = (body.get("refunded_minor"), body.get("pending_minor"), body.get("remaining_minor"))
    assert got == (3000, 1000, 6000), f"refunded, pending, remaining are {got} for a CONFIRMED 3000, a REJECTED 2000 and a PENDING 1000 of 10000, expected (3000, 1000, 6000): total the records by status"
    rows = {row.get("refund_id"): row for row in body.get("refunds", [])}
    assert set(rows) == {"rf-1", "rf-2", "rf-3"}, f"the rows are {sorted(rows)}, expected rf-1, rf-2, rf-3"
    first = rows["rf-1"]
    assert first.get("status") == "CONFIRMED" and first.get("reason_code") == "damaged" and first.get("psp_ref") == "re_1", f"the row of rf-1 is {first}, expected status CONFIRMED, reason_code damaged and psp_ref re_1"
    assert rows["rf-2"].get("status") == "REJECTED", f"the row of rf-2 is {rows['rf-2']}, expected status REJECTED"


async def check_drift(ctx):
    async with _read(ctx) as c:
        steady = (await _get(c)).json()
        assert steady.get("drift_minor") == 0, f"with the ledger in step with the records drift_minor is {steady.get('drift_minor')!r}, expected 0"
        ctx.redis.delete("refunded:pay_1")
        ctx.redis.hset("refunded:pay_1", mapping={"total": 1000, "rf-3": 1000})  # the ledger lost rf-1's claim
        drifted = (await _get(c)).json()
    assert drifted.get("drift_minor") == 3000, f"the ledger holds 1000 against 4000 in the records and drift_minor is {drifted.get('drift_minor')!r}, expected 3000"
    assert drifted.get("refunded_minor") == 3000, f"refunded_minor followed the ledger to {drifted.get('refunded_minor')!r}; it comes from the records (3000)"


async def check_pending_reconciled(ctx):
    async with _read(ctx, pending_paid=True) as c:
        r = await _get(c)
    body = r.json()
    rows = {row.get("refund_id"): row for row in body.get("refunds", [])}
    paid = rows.get("rf-4", {})
    assert paid.get("status") == "CONFIRMED" and paid.get("psp_ref") == "re_4", f"the PSP paid rf-4 as re_4 and the read reports it as {paid}: reconcile PENDING rows before reporting them"
    assert records.find_refund("rf-4")["status"] == "CONFIRMED", "the reconciled refund must be CONFIRMED in the records too"
    assert body.get("refunded_minor") == 5000 and body.get("pending_minor") == 1000, f"refunded and pending are {body.get('refunded_minor')!r} and {body.get('pending_minor')!r}, expected 5000 (rf-1 and rf-4) and 1000 (rf-3, which the PSP never saw)"
    for call in ctx.grpc.calls_to("GetRefund"):
        assert call.timeout is not None and call.timeout <= 5.5, f"a GetRefund call carries a {call.timeout} s deadline, expected 5"
`,
    typescript: `function read(ctx, pendingPaid = false) {
  const applied = new Map([['rf-4', 're_4']]);
  const pkg = ctx.proto('refund_service.proto');
  ctx.grpc.serve(pkg.refundd.Psp.service, {
    Refund(call, callback) {
      callback({code: ctx.grpc.status.UNIMPLEMENTED, details: 'the read path does not pay refunds out'});
    },
    GetRefund(call, callback) {
      const ref = applied.get(call.request.refund_id);
      if (ref === undefined) return callback({code: ctx.grpc.status.NOT_FOUND, details: \`no refund \${call.request.refund_id}\`});
      callback(null, {refund_id: call.request.refund_id, status: 'SUCCEEDED', psp_ref: ref});
    },
  });
  const records = ctx.load('/support/refunds/records.ts');
  const ledger = ctx.load('/support/refunds/ledger.ts');
  const seed = async () => {
    await records.addPayment('pay_1', 't1', 10000);
    await records.addPayment('pay_2', 't2', 8000);
    const seeds: [string, number, string][] = [['rf-1', 3000, 'CONFIRMED'], ['rf-2', 2000, 'REJECTED'], ['rf-3', 1000, 'PENDING']];
    if (pendingPaid) seeds.push(['rf-4', 2000, 'PENDING']);
    for (const [refundId, amount, status] of seeds) {
      await ledger.claim('pay_1', refundId, amount, 10000);
      await records.insertRefund(refundId, 't1', 'pay_1', amount, 'damaged', '');
      if (status === 'CONFIRMED') await records.markConfirmed(refundId, \`re_\${refundId.slice(3)}\`);
      if (status === 'REJECTED') {
        await records.markRejected(refundId);
        await ledger.release('pay_1', refundId);
      }
    }
  };
  return {c: ctx.client(ctx.load('read').app), records, seed};
}

const get = (c, payment = 'pay_1', tenant = 't1') =>
  c.get(\`/v1/payments/\${payment}/refunds\`, {headers: tenant === '' ? {} : {'X-Tenant-Id': tenant}});

const byId = body => Object.fromEntries((body.refunds ?? []).map(row => [row.refund_id, row]));

export async function check_tenant_scope(ctx) {
  const {c, seed} = read(ctx);
  await seed();
  const anonymous = await get(c, 'pay_1', '');
  const foreign = await get(c, 'pay_1', 't2');
  const missing = await get(c, 'pay_404');
  const own = await get(c);
  assert.equal(anonymous.status, 401, \`a read without X-Tenant-Id answered \${anonymous.status}, expected 401\`);
  assert.equal(foreign.status, 404, \`tenant t2 reading t1's payment answered \${foreign.status}, expected 404 (a foreign payment looks missing)\`);
  assert.equal(missing.status, 404, \`a missing payment answered \${missing.status}, expected 404\`);
  assert.equal(own.status, 200, \`t1 reading its own payment answered \${own.status}: \${own.text}\`);
}

export async function check_durable_total(ctx) {
  const {c, seed} = read(ctx);
  await seed();
  const r = await get(c);
  assert.equal(r.status, 200, \`the read answered \${r.status}: \${r.text}\`);
  const body = r.json();
  const got = [body.refunded_minor, body.pending_minor, body.remaining_minor];
  assert.deepEqual(got, [3000, 1000, 6000], \`refunded, pending, remaining are \${JSON.stringify(got)} for a CONFIRMED 3000, a REJECTED 2000 and a PENDING 1000 of 10000, expected [3000, 1000, 6000]: total the records by status\`);
  const rows = byId(body);
  assert.deepEqual(Object.keys(rows).sort(), ['rf-1', 'rf-2', 'rf-3'], \`the rows are \${JSON.stringify(Object.keys(rows))}, expected rf-1, rf-2, rf-3\`);
  const first = rows['rf-1'];
  assert(first.status === 'CONFIRMED' && first.reason_code === 'damaged' && first.psp_ref === 're_1', \`the row of rf-1 is \${JSON.stringify(first)}, expected status CONFIRMED, reason_code damaged and psp_ref re_1\`);
  assert.equal(rows['rf-2'].status, 'REJECTED', \`the row of rf-2 is \${JSON.stringify(rows['rf-2'])}, expected status REJECTED\`);
}

export async function check_drift(ctx) {
  const {c, seed} = read(ctx);
  await seed();
  const steady = (await get(c)).json();
  assert.equal(steady.drift_minor, 0, \`with the ledger in step with the records drift_minor is \${steady.drift_minor}, expected 0\`);
  ctx.redis.del('refunded:pay_1');
  ctx.redis.hset('refunded:pay_1', 'total', 1000, 'rf-3', 1000); // the ledger lost rf-1's claim
  const drifted = (await get(c)).json();
  assert.equal(drifted.drift_minor, 3000, \`the ledger holds 1000 against 4000 in the records and drift_minor is \${drifted.drift_minor}, expected 3000\`);
  assert.equal(drifted.refunded_minor, 3000, \`refunded_minor followed the ledger to \${drifted.refunded_minor}; it comes from the records (3000)\`);
}

export async function check_pending_reconciled(ctx) {
  const {c, records, seed} = read(ctx, true);
  await seed();
  const body = (await get(c)).json();
  const paid = byId(body)['rf-4'] ?? {};
  assert(paid.status === 'CONFIRMED' && paid.psp_ref === 're_4', \`the PSP paid rf-4 as re_4 and the read reports it as \${JSON.stringify(paid)}: reconcile PENDING rows before reporting them\`);
  assert.equal((await records.findRefund('rf-4')).status, 'CONFIRMED', 'the reconciled refund must be CONFIRMED in the records too');
  assert(body.refunded_minor === 5000 && body.pending_minor === 1000, \`refunded and pending are \${body.refunded_minor} and \${body.pending_minor}, expected 5000 (rf-1 and rf-4) and 1000 (rf-3, which the PSP never saw)\`);
  for (const call of ctx.grpc.callsTo('GetRefund')) {
    assert(call.timeout !== null && call.timeout <= 5.5, \`a GetRefund call carries a \${call.timeout} s deadline, expected 5\`);
  }
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "refunds/gen/refund_service"
	"refunds/ledger"
	"refunds/records"

	"leetbuild/harness"
)

var readBg = context.Background()

// readPsp has paid the refunds in applied and never saw any other.
type readPsp struct {
	pb.UnimplementedPspServer
	applied map[string]string
}

func (p *readPsp) GetRefund(_ context.Context, req *pb.GetRefundRequest) (*pb.RefundStatus, error) {
	ref, ok := p.applied[req.GetRefundId()]
	if !ok {
		return nil, status.Errorf(codes.NotFound, "no refund %s", req.GetRefundId())
	}
	return &pb.RefundStatus{RefundId: req.GetRefundId(), Status: "SUCCEEDED", PspRef: ref}, nil
}

type readRow struct {
	RefundID    string \`json:"refund_id"\`
	AmountMinor int64  \`json:"amount_minor"\`
	ReasonCode  string \`json:"reason_code"\`
	Status      string \`json:"status"\`
	PspRef      string \`json:"psp_ref"\`
}

type readBody struct {
	RefundedMinor  *int64    \`json:"refunded_minor"\`
	PendingMinor   *int64    \`json:"pending_minor"\`
	RemainingMinor *int64    \`json:"remaining_minor"\`
	DriftMinor     *int64    \`json:"drift_minor"\`
	Refunds        []readRow \`json:"refunds"\`
}

func readServe(ctx *harness.Ctx, pendingPaid bool) *harness.HTTP {
	pb.RegisterPspServer(ctx.GRPC.Server(""), &readPsp{applied: map[string]string{"rf-4": "re_4"}})
	records.AddPayment(readBg, "pay_1", "t1", 10000)
	records.AddPayment(readBg, "pay_2", "t2", 8000)
	type seed struct {
		id     string
		amount int64
		status string
	}
	seeds := []seed{{"rf-1", 3000, "CONFIRMED"}, {"rf-2", 2000, "REJECTED"}, {"rf-3", 1000, "PENDING"}}
	if pendingPaid {
		seeds = append(seeds, seed{"rf-4", 2000, "PENDING"})
	}
	for _, s := range seeds {
		ledger.Claim(readBg, "pay_1", s.id, s.amount, 10000)
		records.InsertRefund(readBg, s.id, "t1", "pay_1", s.amount, "damaged", "")
		if s.status == "CONFIRMED" {
			records.MarkConfirmed(readBg, s.id, "re_"+s.id[3:])
		}
		if s.status == "REJECTED" {
			records.MarkRejected(readBg, s.id)
			ledger.Release(readBg, "pay_1", s.id)
		}
	}
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func readGet(c *harness.HTTP, payment, tenant string) *harness.Response {
	if tenant == "" {
		return c.Get("/v1/payments/" + payment + "/refunds")
	}
	return c.Get("/v1/payments/"+payment+"/refunds", "X-Tenant-Id", tenant)
}

func readDecode(r *harness.Response) readBody {
	var body readBody
	json.Unmarshal([]byte(r.Text()), &body)
	return body
}

func readNum(v *int64) any {
	if v == nil {
		return "absent"
	}
	return *v
}

func readRows(body readBody) map[string]readRow {
	rows := map[string]readRow{}
	for _, row := range body.Refunds {
		rows[row.RefundID] = row
	}
	return rows
}

func CheckTenantScope(ctx *harness.Ctx) {
	c := readServe(ctx, false)
	ctx.Equal(readGet(c, "pay_1", "").Status, 401, "a read without X-Tenant-Id")
	ctx.Equal(readGet(c, "pay_1", "t2").Status, 404, "tenant t2 reading t1's payment (a foreign payment looks missing)")
	ctx.Equal(readGet(c, "pay_404", "t1").Status, 404, "a missing payment")
	own := readGet(c, "pay_1", "t1")
	ctx.Equal(own.Status, 200, "t1 reading its own payment (%s)", own.Text())
}

func CheckDurableTotal(ctx *harness.Ctx) {
	c := readServe(ctx, false)
	r := readGet(c, "pay_1", "t1")
	ctx.Equal(r.Status, 200, "the read (%s)", r.Text())
	body := readDecode(r)
	got := []any{readNum(body.RefundedMinor), readNum(body.PendingMinor), readNum(body.RemainingMinor)}
	ctx.Equal(got, []any{int64(3000), int64(1000), int64(6000)}, "refunded, pending, remaining for a CONFIRMED 3000, a REJECTED 2000 and a PENDING 1000 of 10000 (total the records by status)")
	rows := readRows(body)
	ctx.Equal(len(rows), 3, "the rows (rf-1, rf-2, rf-3)")
	first := rows["rf-1"]
	ctx.Assert(first.Status == "CONFIRMED" && first.ReasonCode == "damaged" && first.PspRef == "re_1", "the row of rf-1 is %+v, expected status CONFIRMED, reason_code damaged and psp_ref re_1", first)
	ctx.Equal(rows["rf-2"].Status, "REJECTED", "the status of rf-2's row")
}

func CheckDrift(ctx *harness.Ctx) {
	c := readServe(ctx, false)
	ctx.Equal(readNum(readDecode(readGet(c, "pay_1", "t1")).DriftMinor), int64(0), "with the ledger in step with the records, drift_minor")
	ctx.Redis.Del("refunded:pay_1")
	ctx.Redis.Do("HSET", "refunded:pay_1", "total", 1000, "rf-3", 1000) // the ledger lost rf-1's claim
	drifted := readDecode(readGet(c, "pay_1", "t1"))
	ctx.Equal(readNum(drifted.DriftMinor), int64(3000), "the ledger holds 1000 against 4000 in the records; drift_minor")
	ctx.Equal(readNum(drifted.RefundedMinor), int64(3000), "refunded_minor comes from the records, not the ledger")
}

func CheckPendingReconciled(ctx *harness.Ctx) {
	c := readServe(ctx, true)
	body := readDecode(readGet(c, "pay_1", "t1"))
	paid := readRows(body)["rf-4"]
	ctx.Assert(paid.Status == "CONFIRMED" && paid.PspRef == "re_4", "the PSP paid rf-4 as re_4 and the read reports it as %+v: reconcile PENDING rows before reporting them", paid)
	ctx.Equal(records.FindRefund(readBg, "rf-4").Status, "CONFIRMED", "the reconciled refund's status in the records")
	ctx.Assert(readNum(body.RefundedMinor) == int64(5000) && readNum(body.PendingMinor) == int64(1000), "refunded and pending are %v and %v, expected 5000 (rf-1 and rf-4) and 1000 (rf-3, which the PSP never saw)", readNum(body.RefundedMinor), readNum(body.PendingMinor))
	for _, call := range ctx.GRPC.CallsTo("GetRefund", "") {
		ctx.Assert(call.HasDeadline() && call.Timeout <= 5500*time.Millisecond, "a GetRefund call carries a %v deadline, expected 5 s", call.Timeout)
	}
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <map>
#include <string>
#include <tuple>
#include <vector>

#include "refund_service.grpc.pb.h"
#include "refunds/ledger.h"
#include "refunds/records.h"

namespace {

// Has paid the refunds in applied and never saw any other.
class ReadPsp final : public refundd::Psp::Service {
 public:
  std::map<std::string, std::string> applied{{"rf-4", "re_4"}};

  grpc::Status GetRefund(grpc::ServerContext*, const refundd::GetRefundRequest* req, refundd::RefundStatus* out) override {
    if (!applied.count(req->refund_id())) return grpc::Status(grpc::StatusCode::NOT_FOUND, "no refund " + req->refund_id());
    out->set_refund_id(req->refund_id());
    out->set_status("SUCCEEDED");
    out->set_psp_ref(applied[req->refund_id()]);
    return grpc::Status::OK;
  }
};

harness::HTTP readServe(harness::Ctx& ctx, bool pending_paid) {
  static ReadPsp* peer = nullptr;
  delete peer;
  peer = new ReadPsp;
  ctx.GRPC.Server("")->RegisterService(peer);
  records::addPayment("pay_1", "t1", 10000);
  records::addPayment("pay_2", "t2", 8000);
  std::vector<std::tuple<std::string, long long, std::string>> seeds = {
      {"rf-1", 3000, "CONFIRMED"}, {"rf-2", 2000, "REJECTED"}, {"rf-3", 1000, "PENDING"}};
  if (pending_paid) seeds.emplace_back("rf-4", 2000, "PENDING");
  for (const auto& [refund_id, amount, status] : seeds) {
    ledger::claim("pay_1", refund_id, amount, 10000);
    records::insertRefund(refund_id, "t1", "pay_1", amount, "damaged", "");
    if (status == "CONFIRMED") records::markConfirmed(refund_id, "re_" + refund_id.substr(3));
    if (status == "REJECTED") {
      records::markRejected(refund_id);
      ledger::release("pay_1", refund_id);
    }
  }
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response readGet(harness::HTTP& c, const std::string& payment, const std::string& tenant) {
  if (tenant.empty()) return c.Get("/v1/payments/" + payment + "/refunds");
  return c.Get("/v1/payments/" + payment + "/refunds", "X-Tenant-Id", tenant);
}

nlohmann::json readBody(const harness::Response& r) {
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  return body.is_object() ? body : nlohmann::json::object();
}

std::map<std::string, nlohmann::json> readRows(const nlohmann::json& body) {
  std::map<std::string, nlohmann::json> rows;
  if (body.contains("refunds") && body["refunds"].is_array()) {
    for (const auto& row : body["refunds"]) rows[row.value("refund_id", "")] = row;
  }
  return rows;
}

}  // namespace

void CheckTenantScope(harness::Ctx& ctx) {
  auto c = readServe(ctx, false);
  ctx.Equal(readGet(c, "pay_1", "").Status, 401, "a read without X-Tenant-Id");
  ctx.Equal(readGet(c, "pay_1", "t2").Status, 404, "tenant t2 reading t1's payment (a foreign payment looks missing)");
  ctx.Equal(readGet(c, "pay_404", "t1").Status, 404, "a missing payment");
  const auto own = readGet(c, "pay_1", "t1");
  ctx.Equal(own.Status, 200, "t1 reading its own payment (%s)", own.Text());
}

void CheckDurableTotal(harness::Ctx& ctx) {
  auto c = readServe(ctx, false);
  const auto r = readGet(c, "pay_1", "t1");
  ctx.Equal(r.Status, 200, "the read (%s)", r.Text());
  const auto body = readBody(r);
  const long long refunded = body.value("refunded_minor", -1LL);
  const long long pending = body.value("pending_minor", -1LL);
  const long long remaining = body.value("remaining_minor", -1LL);
  ctx.Assert(refunded == 3000 && pending == 1000 && remaining == 6000,
             "refunded, pending, remaining are %d, %d, %d for a CONFIRMED 3000, a REJECTED 2000 and a PENDING 1000 of 10000, expected 3000, 1000, 6000: total the records by status",
             refunded, pending, remaining);
  auto rows = readRows(body);
  ctx.Equal(rows.size(), 3, "the rows (rf-1, rf-2, rf-3)");
  const auto first = rows["rf-1"];
  ctx.Assert(first.value("status", "") == "CONFIRMED" && first.value("reason_code", "") == "damaged" && first.value("psp_ref", "") == "re_1",
             "the row of rf-1 is %s, expected status CONFIRMED, reason_code damaged and psp_ref re_1", first.dump());
  ctx.Equal(rows["rf-2"].value("status", ""), "REJECTED", "the status of rf-2's row");
}

void CheckDrift(harness::Ctx& ctx) {
  auto c = readServe(ctx, false);
  ctx.Equal(readBody(readGet(c, "pay_1", "t1")).value("drift_minor", -1LL), 0, "with the ledger in step with the records, drift_minor");
  ctx.Redis.Do("DEL", "refunded:pay_1");
  ctx.Redis.Do("HSET", "refunded:pay_1", "total", 1000, "rf-3", 1000);  // the ledger lost rf-1's claim
  const auto drifted = readBody(readGet(c, "pay_1", "t1"));
  ctx.Equal(drifted.value("drift_minor", -1LL), 3000, "the ledger holds 1000 against 4000 in the records; drift_minor");
  ctx.Equal(drifted.value("refunded_minor", -1LL), 3000, "refunded_minor comes from the records, not the ledger");
}

void CheckPendingReconciled(harness::Ctx& ctx) {
  auto c = readServe(ctx, true);
  const auto body = readBody(readGet(c, "pay_1", "t1"));
  auto rows = readRows(body);
  const auto paid = rows["rf-4"];
  ctx.Assert(paid.is_object() && paid.value("status", "") == "CONFIRMED" && paid.value("psp_ref", "") == "re_4",
             "the PSP paid rf-4 as re_4 and the read reports it as %s: reconcile PENDING rows before reporting them", paid.dump());
  ctx.Equal(records::findRefund("rf-4")->status, "CONFIRMED", "the reconciled refund's status in the records");
  const long long refunded = body.value("refunded_minor", -1LL);
  const long long pending = body.value("pending_minor", -1LL);
  ctx.Assert(refunded == 5000 && pending == 1000, "refunded and pending are %d and %d, expected 5000 (rf-1 and rf-4) and 1000 (rf-3, which the PSP never saw)", refunded, pending);
  for (const auto& call : ctx.GRPC.CallsTo("GetRefund")) {
    ctx.Assert(call.HasDeadline() && call.TimeoutSeconds() <= 5.5, "a GetRefund call carries a %v s deadline, expected 5", call.TimeoutSeconds());
  }
}
`,
  },
  hints: [
    "Read another merchant's payment, or none at all: it answers. A pending refund shows as already paid, a refund the PSP settled an hour ago still shows as pending, and when the ledger lost a write nobody hears of it.",
    "The starter trusts the ledger, a cache of reservations that counts pending refunds and can lose writes, and never looks at the rows' statuses, the caller's tenant or the PSP.",
    'Check the tenant (401/404); for each `PENDING` row call `psp.reconcile` and re-read it; sum `CONFIRMED` and `PENDING` rows from `records.list_refunds`; report `drift_minor` against `ledger.refunded_total`; return each row with status, reason code and `psp_ref`.',
  ],
  debrief: `Finance reconciles against the records because the records are what the PSP confirmed; the ledger is a cache of reservations, useful for admission and wrong as a report, since it counts pending refunds and can lose a write. Reporting the drift instead of quietly rebuilding keeps a read from racing claims in flight, and gives an operator the number that says a repair is due. Reconciling pending rows on the read means a refund the PSP settled shows as settled the next time anyone looks. A production read pages through refunds, caps how many PSP lookups one request may make (a sweep does the rest), and exports the drift as a metric with an alert instead of leaving it in a response body.`,
};
