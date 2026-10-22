import type {Step} from '@/lib/types';

export const refundReadStep: Step = {
  id: 'read',
  title: 'GET /v1/payments/{id}/refunds: the balance finance trusts',
  concept: 'http',
  file: 'read',
  focus: ['finance', 'api', 'records', 'ledger', 'psp'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: the endpoint returns a number
and the support tool renders it, so the demo passes. The number is the cache, not the truth, and the
endpoint answers about anybody's payment. Find the flaws, fix them, and prove the fix.

Implement the read endpoint finance and support reconcile against:

- \`GET /v1/payments/{payment_id}/refunds\`, tenant from the authenticated \`X-Tenant-Id\` header
  (**401** when missing). A payment owned by another tenant answers **404** — a foreign payment id
  must be indistinguishable from a missing one.
- The reported \`refunded_minor\` is reconstructed from the **durable refund records**
  (\`records.sum_refunds(payment_id)\`), never from the Redis ledger alone: a crash between the PSP's
  success and the refund row must not make the customer's refunds vanish. The draft returns the
  ledger's number, so it understates every refund that is settled but not yet written.
- The Redis ledger is **matched against the records** in the same response: report
  \`drift_minor = refunded_minor - ledger.refunded_total(payment_id)\` and
  \`ledger_reconciled = drift_minor == 0\`, so the reconciliation worker can repair a cache nobody
  notices drifting.
- Every refund still \`PENDING\` is **reconciled with the PSP** before it is reported
  (\`GetRefund(refund_id)\`, 5-second deadline): a settled refund folds into the total as
  \`CONFIRMED\` with its PSP reference, a rejected one is dropped from the total, and an unanswered
  one stays \`PENDING\`. The draft hides pending refunds entirely.
- Every refund row carries \`refund_id\`, \`amount_minor\`, \`reason_code\`, \`psp_ref\` and
  \`status\`; the body also carries \`paid_minor\`, \`remaining_minor\` and \`pending_minor\` so
  support can answer "how much is still to come?" without opening the ledger.
- Log tenant, payment, totals and drift — never the customer's name or card data.

**Failure mode the checks target.** Reading the ledger alone makes the endpoint lie exactly when the
service crashed mid-refund; hiding pending refunds hides the PSP reference support needs; and
answering without an ownership check lets any tenant read another merchant's refund history.`,
  sequence: {
    participants: ['Finance client', 'Refund API', 'refund records', 'PSP', 'Redis ledger'],
    messages: [
      {from: 'Finance client', to: 'Refund API', label: 'GET /v1/payments/pay_8d1/refunds · X-Tenant-Id', kind: 'sync'},
      {from: 'Refund API', to: 'Refund API', label: 'owner check · foreign payment → 404', kind: 'sync'},
      {from: 'Refund API', to: 'refund records', label: 'listRefunds · sumRefunds(payment_id)', kind: 'sync'},
      {from: 'refund records', to: 'Refund API', label: 'durable rows · refunded total', kind: 'reply'},
      {from: 'Refund API', to: 'PSP', label: 'GetRefund(refund_id) for every pending row · 5 s', kind: 'sync'},
      {from: 'PSP', to: 'Refund API', label: 'SUCCEEDED · psp_ref / REJECTED / unknown', kind: 'reply'},
      {
        from: 'Refund API',
        to: 'Redis ledger',
        label: 'refunded_total(payment_id) · compare with the records',
        kind: 'sync',
      },
      {from: 'Redis ledger', to: 'Refund API', label: 'cached total → drift_minor', kind: 'reply'},
      {
        from: 'Refund API',
        to: 'Finance client',
        label: '200 {refunded_minor, remaining_minor, pending_minor, refunds[{psp_ref}]}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'tenant-scope',
      title: 'Authorizes the read and 404s a foreign payment',
      detail:
        'The payment is loaded and its owner compared with the authenticated tenant before anything is read; a foreign payment answers **404**. The draft serves any payment id the path names.',
      match: {
        python: {all: [/assert_tenant_owns/, /status_code\s*=\s*404/]},
        typescript: {all: [/assertTenantOwns/, /statusCode\s*=\s*404/]},
        go: {all: [/assertTenantOwns/, /StatusNotFound/]},
        scala: {all: [/assertTenantOwns/, /StatusCodes\.NotFound/]},
        cpp: {all: [/assert_tenant_owns/, /\b404\b/]},
      },
    },
    {
      id: 'durable-total',
      title: 'Reconstructs the total from the durable records',
      detail:
        'The reported total comes from the refund records (`records.sum_refunds`), so a refund that is settled at the PSP but not yet written cannot disappear from the balance. The draft reports the ledger alone.',
      match: {
        python: {all: [/records\.sum_refunds\(/, /refunded_minor/]},
        typescript: {all: [/records\.sumRefunds\(/, /refunded_minor/]},
        go: {all: [/records\.SumRefunds\(/, /refundedMinor/]},
        scala: {all: [/records\.sumRefunds\(/, /refundedMinor/]},
        cpp: {all: [/records\.sum_refunds\(/, /refunded_minor/]},
      },
    },
    {
      id: 'ledger-match',
      title: 'Matches the ledger and reports the drift',
      detail:
        'The response compares the durable total with `ledger.refunded_total(payment_id)` and carries `drift_minor` (and whether the ledger reconciled), so drift is visible instead of silent. The draft never compares the two.',
      match: {
        python: {all: [/ledger\.refunded_total\(/, /drift_minor/]},
        typescript: {all: [/ledger\.refundedTotal\(/, /drift_minor/]},
        go: {all: [/ledger\.RefundedTotal\(/, /driftMinor/]},
        scala: {all: [/ledger\.refundedTotal\(/, /driftMinor/]},
        cpp: {all: [/ledger\.refunded_total\(/, /drift_minor/]},
      },
    },
    {
      id: 'pending-reconciled',
      title: 'Reconciles pending refunds with the PSP before answering',
      detail:
        'Every row still `PENDING` is asked about at the PSP (`GetRefund`) before it is reported, and the unsettled amount is called out as `pending_minor`. The draft hides pending refunds and their references.',
      match: {
        python: {all: [/GetRefund/, /pending_minor/]},
        typescript: {all: [/GetRefund/, /pending_minor/]},
        go: {all: [/GetRefund\(/, /pendingMinor/]},
        scala: {all: [/getRefund\(/, /pendingMinor/]},
        cpp: {all: [/GetRefund\(/, /pending_minor/]},
      },
    },
    {
      id: 'refund-rows',
      title: 'Every refund carries its PSP reference and status',
      detail:
        'Each refund row carries `refund_id`, `amount_minor`, `reason_code`, `psp_ref` and `status`, so a reviewer can point at the provider reference for a specific refund. The draft returns ids and amounts only.',
      match: {
        python: {all: [/"refund_id":/, /"psp_ref":/, /"status":/]},
        typescript: {all: [/refund_id:\s*row\.refund_id/, /psp_ref:/, /status:/]},
        go: {all: [/"refund_id":\s*row\.RefundID/, /"psp_ref":\s*row\.PspRef/, /"status":\s*row\.Status/]},
        scala: {all: [/refund_id = row\.refund_id/, /psp_ref = row\.psp_ref/, /status = row\.status/]},
        cpp: {all: [/"refund_id",/, /"psp_ref",/, /"status",/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("refunds-read")


class PaymentStore:
    def get(self, payment_id: str) -> dict | None:
        """{"tenant": ..., "paid_minor": ...} for the payment, or None."""
        raise NotImplementedError


class RefundLedger:
    def refunded_total(self, payment_id: str) -> int:
        """The cached refunded total."""
        raise NotImplementedError


payments = PaymentStore()
ledger = RefundLedger()


@app.get("/v1/payments/{payment_id}/refunds")
def read_refunds(payment_id: str) -> JSONResponse:
    # TODO: this draft reports the Redis ledger alone, so a crash between the PSP's success and the
    # refund row understates the refunds; it never reconciles pending refunds with the PSP, hides
    # their references, and serves any tenant's payment. Review all four.
    refunded_minor = ledger.refunded_total(payment_id)
    logger.info("refunds read payment=%s", payment_id)
    return JSONResponse(
        {
            "payment_id": payment_id,
            "refunded_minor": refunded_minor,
            "refunds": [{"refund_id": "from-the-ledger", "amount_minor": refunded_minor}],
        },
        status_code=200,
    )
`,
      solution: `import logging

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("refunds-read")

PSP_DEADLINE_S = 5


class PaymentStore:
    def get(self, payment_id: str) -> dict | None:
        """{"tenant": ..., "paid_minor": ...} for the payment, or None."""
        raise NotImplementedError


class RefundRecords:
    def list_refunds(self, payment_id: str) -> list[dict]:
        """Every durable refund row for the payment, oldest first."""
        raise NotImplementedError

    def sum_refunds(self, payment_id: str) -> int:
        """The refunded total computed from the durable rows."""
        raise NotImplementedError

    def mark_confirmed(self, refund_id: str, psp_ref: str) -> None:
        raise NotImplementedError

    def mark_rejected(self, refund_id: str, reason: str) -> None:
        raise NotImplementedError


class RefundLedger:
    def refunded_total(self, payment_id: str) -> int:
        """The cached refunded total."""
        raise NotImplementedError


class PspClient:
    def GetRefund(self, refund_id: str):
        """The PSP's own view of the refund."""
        raise NotImplementedError


payments = PaymentStore()
records = RefundRecords()
ledger = RefundLedger()
psp = PspClient()


def assert_tenant_owns(tenant: str, payment: dict | None) -> dict:
    if payment is None or payment["tenant"] != tenant:
        raise HTTPException(status_code=404, detail="payment not found")
    return payment


def settled(rows: list[dict]) -> tuple[list[dict], int, int]:
    """Ask the PSP about every pending refund, then say how much is settled and how much is unknown."""
    resolved: list[dict] = []
    reverted_minor = 0
    pending_minor = 0
    for row in rows:
        if row["status"] != "PENDING":
            resolved.append(row)
            continue
        answer = psp.GetRefund(row["refund_id"])
        if answer.state == "SUCCEEDED":
            records.mark_confirmed(row["refund_id"], answer.psp_ref)
            resolved.append({**row, "status": "CONFIRMED", "psp_ref": answer.psp_ref})
        elif answer.state == "REJECTED":
            records.mark_rejected(row["refund_id"], "psp rejected the refund during reconciliation")
            reverted_minor += row["amount_minor"]
        else:
            pending_minor += row["amount_minor"]
            resolved.append(row)
    return resolved, reverted_minor, pending_minor


@app.get("/v1/payments/{payment_id}/refunds")
def read_refunds(
    payment_id: str, tenant: str | None = Header(default=None, alias="X-Tenant-Id")
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    payment = assert_tenant_owns(tenant, payments.get(payment_id))

    rows, reverted_minor, pending_minor = settled(records.list_refunds(payment_id))
    refunded_minor = records.sum_refunds(payment_id) - reverted_minor
    drift_minor = refunded_minor - ledger.refunded_total(payment_id)

    body = {
        "payment_id": payment_id,
        "paid_minor": payment["paid_minor"],
        "refunded_minor": refunded_minor,
        "remaining_minor": payment["paid_minor"] - refunded_minor,
        "pending_minor": pending_minor,
        "drift_minor": drift_minor,
        "ledger_reconciled": drift_minor == 0,
        "refunds": [
            {
                "refund_id": row["refund_id"],
                "amount_minor": row["amount_minor"],
                "reason_code": row["reason_code"],
                "psp_ref": row.get("psp_ref"),
                "status": row["status"],
            }
            for row in rows
        ],
    }
    logger.info(
        "refunds read tenant=%s payment=%s refunded=%d pending=%d drift=%d",
        tenant,
        payment_id,
        refunded_minor,
        pending_minor,
        drift_minor,
    )
    return JSONResponse(body, status_code=200)
`,
    },
    typescript: {
      starter: `/** GET /v1/payments/:id/refunds: a model-generated draft that reports the cache. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

app.get('/v1/payments/:paymentId/refunds', async (request, reply) => {
  const {paymentId} = request.params as {paymentId: string};
  // TODO: this draft reports the Redis ledger alone, so a crash between the PSP's success and the
  // refund row understates the refunds; it never reconciles pending refunds with the PSP, hides
  // their references, and serves any tenant's payment. Review all four.
  const cached = await r.hget(\`refunded:\${paymentId}\`, 'refunded');
  const refunded_minor = cached === null ? 0 : Number(cached);
  return reply.code(200).send({
    payment_id: paymentId,
    refunded_minor,
    refunds: [{refund_id: 'from-the-ledger', amount_minor: refunded_minor}],
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/payments/:id/refunds: the balance rebuilt from the records and matched to the ledger. */
import Fastify from 'fastify';

import {ledger} from './state';
import {payments, records} from './store';
import {psp} from './client';

export const app = Fastify();

const PSP_DEADLINE_MS = 5000;

interface RefundRecord {
  refund_id: string;
  amount_minor: number;
  reason_code: string;
  psp_ref: string | null;
  status: string;
}

async function assertTenantOwns(tenant: string, paymentId: string): Promise<void> {
  const payment = await payments.get(paymentId);
  if (payment !== null && payment.tenant === tenant) return;
  const error = new Error('payment not found') as Error & {statusCode: number};
  error.statusCode = 404;
  throw error;
}

async function settled(rows: RefundRecord[]): Promise<{rows: RefundRecord[]; reverted_minor: number; pending_minor: number}> {
  const resolved: RefundRecord[] = [];
  let reverted_minor = 0;
  let pending_minor = 0;
  for (const row of rows) {
    if (row.status !== 'PENDING') {
      resolved.push(row);
      continue;
    }
    const answer = await psp.GetRefund({refund_id: row.refund_id}, {deadline: Date.now() + PSP_DEADLINE_MS});
    if (answer.state === 'SUCCEEDED') {
      await records.markConfirmed(row.refund_id, answer.psp_ref);
      resolved.push({...row, status: 'CONFIRMED', psp_ref: answer.psp_ref});
    } else if (answer.state === 'REJECTED') {
      await records.markRejected(row.refund_id, 'psp rejected the refund during reconciliation');
      reverted_minor += row.amount_minor;
    } else {
      pending_minor += row.amount_minor;
      resolved.push(row);
    }
  }
  return {rows: resolved, reverted_minor, pending_minor};
}

app.get('/v1/payments/:paymentId/refunds', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {paymentId} = request.params as {paymentId: string};
  await assertTenantOwns(tenant, paymentId);

  const payment = await payments.get(paymentId);
  const listed = await settled(await records.listRefunds(paymentId));
  const refunded_minor = (await records.sumRefunds(paymentId)) - listed.reverted_minor;
  const drift_minor = refunded_minor - (await ledger.refundedTotal(paymentId));
  const paid_minor = payment?.paid_minor ?? 0;

  return reply.code(200).send({
    payment_id: paymentId,
    paid_minor,
    refunded_minor,
    remaining_minor: paid_minor - refunded_minor,
    pending_minor: listed.pending_minor,
    drift_minor,
    ledger_reconciled: drift_minor === 0,
    refunds: listed.rows.map(row => ({
      refund_id: row.refund_id,
      amount_minor: row.amount_minor,
      reason_code: row.reason_code,
      psp_ref: row.psp_ref,
      status: row.status,
    })),
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

	"github.com/redis/go-redis/v9"
)

var rdb *redis.Client

func readRefunds(rw http.ResponseWriter, r *http.Request) {
	ctx := context.Background()
	paymentID := r.PathValue("payment_id")
	// TODO: this draft reports the Redis ledger alone, so a crash between the PSP's success and the
	// refund row understates the refunds; it never reconciles pending refunds with the PSP, hides
	// their references, and serves any tenant's payment. Review all four.
	cached, _ := rdb.HGet(ctx, "refunded:"+paymentID, "refunded").Int64()
	body, _ := json.Marshal(map[string]any{
		"payment_id":     paymentID,
		"refunded_minor": cached,
		"refunds":        []map[string]any{{"refund_id": "from-the-ledger", "amount_minor": cached}},
	})
	rw.Header().Set("Content-Type", "application/json")
	_, _ = rw.Write(body)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/payments/{payment_id}/refunds", readRefunds)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"

	pb "refunds/psppb"
)

const pspDeadlineS = 5

var rdb *redis.Client
var psp pb.PspClient

type Payment struct {
	Tenant    string \`json:"tenant"\`
	PaidMinor int64  \`json:"paid_minor"\`
}

type RefundRecord struct {
	RefundID    string  \`json:"refund_id"\`
	AmountMinor int64   \`json:"amount_minor"\`
	ReasonCode  string  \`json:"reason_code"\`
	PspRef      *string \`json:"psp_ref"\`
	Status      string  \`json:"status"\`
}

type paymentStore struct{}

func (paymentStore) Get(ctx context.Context, paymentID string) (*Payment, error) { return nil, nil }

type recordStore struct{}

func (recordStore) ListRefunds(ctx context.Context, paymentID string) ([]RefundRecord, error) {
	return nil, nil
}
func (recordStore) SumRefunds(ctx context.Context, paymentID string) (int64, error) { return 0, nil }
func (recordStore) MarkConfirmed(ctx context.Context, refundID, pspRef string) error { return nil }
func (recordStore) MarkRejected(ctx context.Context, refundID, reason string) error  { return nil }

type ledgerStore struct{}

func (ledgerStore) RefundedTotal(ctx context.Context, paymentID string) (int64, error) { return 0, nil }

var (
	payments = paymentStore{}
	records  = recordStore{}
	ledger   = ledgerStore{}
)

func assertTenantOwns(payment *Payment, tenant string) error {
	if payment == nil || payment.Tenant != tenant {
		return errors.New("payment not found")
	}
	return nil
}

func settle(ctx context.Context, rows []RefundRecord) ([]RefundRecord, int64, int64) {
	resolved := make([]RefundRecord, 0, len(rows))
	var revertedMinor, pendingMinor int64
	for _, row := range rows {
		if row.Status != "PENDING" {
			resolved = append(resolved, row)
			continue
		}
		callCtx, cancel := context.WithTimeout(ctx, pspDeadlineS*time.Second)
		answer, err := psp.GetRefund(callCtx, &pb.GetRefundRequest{RefundId: row.RefundID})
		cancel()
		switch {
		case err != nil:
			pendingMinor += row.AmountMinor
			resolved = append(resolved, row)
		case answer.State == "SUCCEEDED":
			_ = records.MarkConfirmed(ctx, row.RefundID, answer.PspRef)
			row.Status = "CONFIRMED"
			row.PspRef = &answer.PspRef
			resolved = append(resolved, row)
		case answer.State == "REJECTED":
			_ = records.MarkRejected(ctx, row.RefundID, "psp rejected the refund during reconciliation")
			revertedMinor += row.AmountMinor
		default:
			pendingMinor += row.AmountMinor
			resolved = append(resolved, row)
		}
	}
	return resolved, revertedMinor, pendingMinor
}

func readRefunds(rw http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	paymentID := r.PathValue("payment_id")
	payment, err := payments.Get(ctx, paymentID)
	if err := assertTenantOwns(payment, tenant); err != nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "payment not found"})
		return
	}
	rows, _ := records.ListRefunds(ctx, paymentID)
	resolved, revertedMinor, pendingMinor := settle(ctx, rows)
	refundedMinor, _ := records.SumRefunds(ctx, paymentID)
	refundedMinor -= revertedMinor
	cached, _ := ledger.RefundedTotal(ctx, paymentID)
	driftMinor := refundedMinor - cached
	paidMinor := payment.PaidMinor

	out := make([]map[string]any, 0, len(resolved))
	for _, row := range resolved {
		out = append(out, map[string]any{
			"refund_id":    row.RefundID,
			"amount_minor": row.AmountMinor,
			"reason_code":  row.ReasonCode,
			"psp_ref":      row.PspRef,
			"status":       row.Status,
		})
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"payment_id":       paymentID,
		"paid_minor":       paidMinor,
		"refunded_minor":   refundedMinor,
		"remaining_minor":  paidMinor - refundedMinor,
		"pending_minor":    pendingMinor,
		"drift_minor":      driftMinor,
		"ledger_reconciled": driftMinor == 0,
		"refunds":          out,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/payments/{payment_id}/refunds", readRefunds)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis

object Read {
  implicit val system: ActorSystem = ActorSystem("refunds")
  val jedis = new Jedis("redis", 6379)

  val route: Route =
    path("v1" / "payments" / Segment / "refunds") { paymentId =>
      get {
        // TODO: this draft reports the Redis ledger alone, so a crash between the PSP's success and
        // the refund row understates the refunds; it never reconciles pending refunds with the PSP,
        // hides their references, and serves any tenant's payment. Review all four.
        val cached = Option(jedis.hget(s"refunded:$paymentId", "refunded")).map(_.toLong).getOrElse(0L)
        complete(StatusCodes.OK, s"""{"payment_id":"$paymentId","refunded_minor":$cached}""")
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class RefundRecord(
    refund_id: String,
    amount_minor: Long,
    reason_code: String,
    psp_ref: Option[String],
    status: String
)

final case class RefundRow(
    refund_id: String,
    amount_minor: Long,
    reason_code: String,
    psp_ref: String,
    status: String
)

final case class RefundView(
    payment_id: String,
    paid_minor: Long,
    refunded_minor: Long,
    remaining_minor: Long,
    pending_minor: Long,
    drift_minor: Long,
    ledger_reconciled: Boolean,
    refunds: List[RefundRow]
)

object Read {
  implicit val system: ActorSystem = ActorSystem("refunds")
  implicit val refundRecordFormat: RootJsonFormat[RefundRecord] = jsonFormat5(RefundRecord)
  implicit val refundRowFormat: RootJsonFormat[RefundRow] = jsonFormat5(RefundRow)
  implicit val refundViewFormat: RootJsonFormat[RefundView] = jsonFormat8(RefundView)

  val PspDeadlineS = 5

  object payments {
    def get(paymentId: String): Option[(String, Long)] = None
  }

  object records {
    def listRefunds(paymentId: String): List[RefundRecord] = Nil
    def sumRefunds(paymentId: String): Long = 0L
    def markConfirmed(refundId: String, pspRef: String): Unit = ()
    def markRejected(refundId: String, reason: String): Unit = ()
  }

  object ledger {
    def refundedTotal(paymentId: String): Long = 0L
  }

  def pspGetRefund(refundId: String): String =
    PspGrpc.blockingStub
      .withDeadlineAfter(PspDeadlineS, TimeUnit.SECONDS)
      .getRefund(GetRefundRequest(refundId = refundId))
      .state

  def assertTenantOwns(tenant: String, paymentId: String): Option[Long] =
    payments.get(paymentId).filter { case (owner, _) => owner == tenant }

  def settled(rows: List[RefundRecord]): (List[RefundRecord], Long, Long) = {
    var revertedMinor = 0L
    var pendingMinor = 0L
    val resolved = rows.flatMap { row =>
      if (row.status != "PENDING") {
        Some(row)
      } else {
        pspGetRefund(row.refund_id) match {
          case "SUCCEEDED" =>
            records.markConfirmed(row.refund_id, row.psp_ref.getOrElse(""))
            Some(row.copy(status = "CONFIRMED"))
          case "REJECTED" =>
            records.markRejected(row.refund_id, "psp rejected the refund during reconciliation")
            revertedMinor += row.amount_minor
            None
          case _ =>
            pendingMinor += row.amount_minor
            Some(row)
        }
      }
    }
    (resolved, revertedMinor, pendingMinor)
  }

  val route: Route =
    path("v1" / "payments" / Segment / "refunds") { paymentId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          if (!tenantOpt.exists(_.nonEmpty)) {
            complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
          } else {
            assertTenantOwns(tenantOpt.get, paymentId) match {
              case None =>
                complete(StatusCodes.NotFound, """{"error":"payment not found"}""")
              case Some(paidMinor) =>
                val (rows, revertedMinor, pendingMinor) = settled(records.listRefunds(paymentId))
                val refundedMinor = records.sumRefunds(paymentId) - revertedMinor
                val driftMinor = refundedMinor - ledger.refundedTotal(paymentId)
                val view = RefundView(
                  payment_id = paymentId,
                  paid_minor = paidMinor,
                  refunded_minor = refundedMinor,
                  remaining_minor = paidMinor - refundedMinor,
                  pending_minor = pendingMinor,
                  drift_minor = driftMinor,
                  ledger_reconciled = driftMinor == 0,
                  refunds = rows.map { row =>
                    RefundRow(
                      refund_id = row.refund_id,
                      amount_minor = row.amount_minor,
                      reason_code = row.reason_code,
                      psp_ref = row.psp_ref.getOrElse(""),
                      status = row.status
                    )
                  }
                )
                complete(StatusCodes.OK, view)
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
#include <sw/redis++/redis++.h>

#include <string>

using json = nlohmann::json;

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;

  svr.Get("/v1/payments/([^/]+)/refunds", [&redis](const httplib::Request& req, httplib::Response& res) {
    const auto payment_id = req.matches[1].str();
    // TODO: this draft reports the Redis ledger alone, so a crash between the PSP's success and the
    // refund row understates the refunds; it never reconciles pending refunds with the PSP, hides
    // their references, and serves any tenant's payment. Review all four.
    auto cached = redis.hget("refunded:" + payment_id, "refunded");
    const long long refunded_minor = cached ? std::stoll(*cached) : 0;
    res.status = 200;
    res.set_content(
        json{{"payment_id", payment_id},
             {"refunded_minor", refunded_minor},
             {"refunds", json::array({json{{"refund_id", "from-the-ledger"}, {"amount_minor", refunded_minor}}})}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include "psp.grpc.pb.h"

#include <chrono>
#include <optional>
#include <string>
#include <tuple>
#include <vector>

using json = nlohmann::json;

constexpr int kPspDeadlineS = 5;

struct Payment {
  std::string tenant;
  long long paid_minor;
};

struct RefundRecord {
  std::string refund_id;
  long long amount_minor;
  std::string reason_code;
  std::optional<std::string> psp_ref;
  std::string status;
};

struct Payments {
  std::optional<Payment> get(const std::string& paymentId);
};

struct RefundRecords {
  std::vector<RefundRecord> list_refunds(const std::string& paymentId);
  long long sum_refunds(const std::string& paymentId);
  void markConfirmed(const std::string& refundId, const std::string& pspRef);
  void markRejected(const std::string& refundId, const std::string& reason);
};

struct RefundLedger {
  long long refunded_total(const std::string& paymentId);
};

Payments payments;
RefundRecords records;
RefundLedger ledger;
std::unique_ptr<Psp::Stub> psp;

std::optional<Payment> assert_tenant_owns(const std::string& tenant, const std::string& paymentId) {
  const auto payment = payments.get(paymentId);
  if (!payment || payment->tenant != tenant) return std::nullopt;
  return payment;
}

std::tuple<std::vector<RefundRecord>, long long, long long> settled(const std::vector<RefundRecord>& rows) {
  std::vector<RefundRecord> resolved;
  long long reverted_minor = 0;
  long long pending_minor = 0;
  for (const auto& row : rows) {
    if (row.status != "PENDING") {
      resolved.push_back(row);
      continue;
    }
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(kPspDeadlineS));
    GetRefundRequest request;
    request.set_refund_id(row.refund_id);
    GetRefundReply answer;
    if (!psp->GetRefund(&ctx, request, &answer).ok()) {
      pending_minor += row.amount_minor;
      resolved.push_back(row);
      continue;
    }
    if (answer.state() == "SUCCEEDED") {
      records.markConfirmed(row.refund_id, answer.psp_ref());
      auto confirmed = row;
      confirmed.status = "CONFIRMED";
      confirmed.psp_ref = answer.psp_ref();
      resolved.push_back(confirmed);
    } else if (answer.state() == "REJECTED") {
      records.markRejected(row.refund_id, "psp rejected the refund during reconciliation");
      reverted_minor += row.amount_minor;
    } else {
      pending_minor += row.amount_minor;
      resolved.push_back(row);
    }
  }
  return {resolved, reverted_minor, pending_minor};
}

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::Server svr;
  psp = Psp::NewStub(grpc::CreateChannel("psp:9000", grpc::InsecureChannelCredentials()));

  svr.Get("/v1/payments/([^/]+)/refunds", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto payment_id = req.matches[1].str();
    const auto payment = assert_tenant_owns(tenant, payment_id);
    if (!payment) {
      res.status = 404;
      res.set_content(R"({"error":"payment not found"})", "application/json");
      return;
    }
    const auto [rows, reverted_minor, pending_minor] = settled(records.list_refunds(payment_id));
    const auto refunded_minor = records.sum_refunds(payment_id) - reverted_minor;
    const auto drift_minor = refunded_minor - ledger.refunded_total(payment_id);
    const auto paid_minor = payment->paid_minor;

    json out = json::array();
    for (const auto& row : rows) {
      out.push_back(json{
          {"refund_id", row.refund_id},
          {"amount_minor", row.amount_minor},
          {"reason_code", row.reason_code},
          {"psp_ref", row.psp_ref.value_or("")},
          {"status", row.status},
      });
    }
    res.status = 200;
    res.set_content(
        json{{"payment_id", payment_id},
             {"paid_minor", paid_minor},
             {"refunded_minor", refunded_minor},
             {"remaining_minor", paid_minor - refunded_minor},
             {"pending_minor", pending_minor},
             {"drift_minor", drift_minor},
             {"ledger_reconciled", drift_minor == 0},
             {"refunds", out}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Authorize first: `assert_tenant_owns(tenant, payments.get(payment_id))` before any key is read, and answer **404** so a foreign payment id is indistinguishable from one that does not exist.',
    'The records are the source of truth and the ledger is a cache: take `refunded_minor` from `records.sum_refunds(payment_id)`, compare it with `ledger.refunded_total(payment_id)` and publish `drift_minor`. A response that only echoes the cache can never be reconciled against the provider.',
    'Reconcile before you answer: for every row whose status is `PENDING`, ask the PSP with `GetRefund(refund_id)`, fold a settled answer in as `CONFIRMED` with its `psp_ref`, drop a rejected one from the total, and report what is still unknown as `pending_minor`. Support needs the provider reference, not a promise.',
  ],
  debrief: `The interviewer is testing whether you can tell a cache from the truth in a system whose whole job is money. The durable refund records are the ledger of record; Redis is a fast copy of it, and a read endpoint that reports the copy alone lies exactly when the service crashed between the PSP's success and the row write — the failure the reconciliation worker exists to repair. Matching the two in the response (\`drift_minor\`, \`ledger_reconciled\`) turns a silent disagreement into an alarm and gives the worker its input. Reconciling pending refunds before answering is the second half: a refund the PSP already applied must not be shown as missing, and support needs its provider reference to talk to the customer. The ownership check is the plain one that generated endpoints forget: a read is still a read of one tenant's money, and a foreign payment id answers 404. Real services add an append-only refund log with monotonic offsets, a per-payment reconciliation interval, and a metric on both drift and pending age.`,
};
