import type {Step} from '@/lib/types';

export const billingCursorStep: Step = {
  id: 'state',
  title: 'Redis billing cursors with atomic period idempotency',
  concept: 'redis',
  file: 'state',
  focus: ['billing', 'redis', 'processor', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it bills a period, records a
marker and returns the charge reference, so the happy path passes. The run hides a lost race, a
marker that cannot be reconciled, and an expiry that reopens a closed period. Find them, fix them,
and prove the fix with the checks below.

Implement the billing run for one \`(subscription, period)\`:

- The run key is \`billing:run:{subscription_id}:{period_start}\` — per subscription **and** per
  period. A subscription-wide key blocks the next period; a period-less key lets two periods share
  one marker.
- The marker is claimed **atomically** with \`SET … NX\` **before** the charge. A read followed by a
  later write lets two runners both see "no marker" and both charge the customer. Claim first,
  charge second.
- After the charge, the marker is **confirmed with the invoice reference** (\`charged:{invoice_ref}\`),
  so the marker and the charge reconcile. A marker whose value is a bare \`done\` proves nothing —
  when support asks "was this period charged, and under which charge?", the marker has to answer.
- A claim that exists but was never confirmed is an **in-flight or crashed run**: the retry must
  reconcile with the processor (\`GetInvoice\` for the period's invoice) and adopt the charge
  reference it reports, then confirm the marker. It must never charge again.
- A **closed period** — one whose \`period_end\` is in the past — refuses a re-charge with **409** and
  \`{"action_required": "adjustment"}\` unless the caller passes the explicit adjustment action. A
  billing retry is not an adjustment.
- The marker **must not expire with the period or the month**: no TTL on the run marker. A marker
  that lives for thirty days cannot tell a closed period from an unbilled one, so a late retry
  recharges a period that was already billed and closed.
- Log the run with subscription, period and reference — never the customer's payment details.

**Failure mode the checks target.** The draft charges before it claims anything, writes a bare
\`done\` marker afterwards, and gives that marker a month-long expiry. Every one of those is
invisible in a demo that runs once and never crashes: the second run of the demo sees the marker, and
the demo never crosses a month boundary.`,
  sequence: {
    participants: ['Billing Service', 'Redis', 'billing db', 'Payment processor'],
    messages: [
      {
        from: 'Billing Service',
        to: 'Redis',
        label: 'SET billing:run:{subscription}:{period_start} NX · no expiry',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Billing Service', label: 'OK (claimed) / nil (already claimed)', kind: 'reply'},
      {
        from: 'Billing Service',
        to: 'billing db',
        label: 'load the period, the invoice and the marker value',
        kind: 'sync',
      },
      {from: 'billing db', to: 'Billing Service', label: 'period bounds · invoice · charged:{ref}', kind: 'reply'},
      {from: 'Billing Service', to: 'Payment processor', label: 'Charge(invoice_id, key = invoice id)', kind: 'sync'},
      {from: 'Payment processor', to: 'Billing Service', label: 'charge reference', kind: 'reply'},
      {from: 'Billing Service', to: 'Redis', label: 'SET marker charged:{invoice_ref}', kind: 'sync'},
      {from: 'Billing Service', to: 'Billing Service', label: 'closed period → 409 unless adjustment', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'atomic-claim',
      title: 'Claims the run marker atomically before doing anything else',
      detail:
        'The marker is claimed with a single `SET … NX` (one round trip), so exactly one runner per `(subscription, period)` can proceed. The draft has no claim at all — it charges first and writes the marker afterwards, so two retries can both charge.',
      match: {
        python: {all: [/claim_marker\(/, /nx=True/]},
        typescript: {all: [/claimMarker\(/, /['"]NX['"]/]},
        go: {all: [/ClaimMarker\(/, /SetNX/]},
        scala: {all: [/claimMarker\(/, /\.nx\(\)/]},
        cpp: {all: [/claimMarker\(/, /UpdateType::NOT_EXIST/]},
      },
    },
    {
      id: 'claim-before-charge',
      title: 'Claims the marker before the charge',
      detail:
        'The claim happens before the processor call in the source order, so a run that cannot claim never charges. The draft charges first and records the marker afterwards.',
      match: {
        python: {order: [/claim_marker\(/, /charge_invoice\(/]},
        typescript: {order: [/claimMarker\(/, /chargeInvoice\(/]},
        go: {order: [/ClaimMarker\(/, /ChargeInvoice\(/]},
        scala: {order: [/claimMarker\(/, /chargeInvoice\(/]},
        cpp: {order: [/claimMarker\(/, /chargeInvoice\(/]},
      },
    },
    {
      id: 'confirm-reference',
      title: 'Confirms the marker with the invoice reference',
      detail:
        'After the charge the marker records the charge reference (`charged:{invoice_ref}`), so the marker and the charge reconcile. The draft writes a bare `done`, which cannot answer “was this period charged, and under which charge?”.',
      match: {
        python: {all: [/confirm_marker\(/, /invoice_ref/], order: [/charge_invoice\(/, /confirm_marker\(/]},
        typescript: {all: [/confirmMarker\(/, /invoiceRef/], order: [/chargeInvoice\(/, /confirmMarker\(/]},
        go: {all: [/ConfirmMarker\(/, /invoiceRef/], order: [/ChargeInvoice\(/, /ConfirmMarker\(/]},
        scala: {all: [/confirmMarker\(/, /invoiceRef/], order: [/chargeInvoice\(/, /confirmMarker\(/]},
        cpp: {all: [/confirmMarker\(/, /invoice_reference/], order: [/chargeInvoice\(/, /confirmMarker\(/]},
      },
    },
    {
      id: 'closed-period-guard',
      title: 'Refuses a closed period without an explicit adjustment',
      detail:
        'A period whose end is in the past answers **409** with `{"action_required": "adjustment"}` unless the caller passes the adjustment action, and an unconfirmed claim is reconciled with the processor instead of being charged again. The draft has neither guard.',
      match: {
        python: {all: [/PERIOD_CLOSED/, /adjustment/, /409/]},
        typescript: {all: [/PERIOD_CLOSED/, /adjustment/, /409/]},
        go: {all: [/periodClosed/, /adjustment/, /StatusConflict/]},
        scala: {all: [/PeriodClosed/, /adjustment/, /StatusCodes\.Conflict/]},
        cpp: {all: [/kPeriodClosed/, /adjustment/, /\b409\b/]},
      },
    },
    {
      id: 'marker-persists',
      title: 'The marker outlives the period it guards',
      detail:
        'The run marker is keyed by `(subscription, period_start)` and carries no expiry, so a late retry can still see that the period was billed. The draft expires it after a month, and a retry after that expiry recharges a closed period.',
      match: {
        python: {all: [/marker_key\(/, /subscription_id/, /period_start/], none: [/MONTH_TTL_S/]},
        typescript: {all: [/markerKey\(/, /subscriptionId/, /periodStart/], none: [/MONTH_TTL_S/]},
        go: {all: [/markerKey\(/, /subscriptionID/, /periodStart/], none: [/monthTTL/]},
        scala: {all: [/markerKey\(/, /subscriptionId/, /periodStart/], none: [/monthTtl/]},
        cpp: {all: [/markerKey\(/, /subscription_id/, /period_start/], none: [/kMonthTtl/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
from datetime import date

import redis
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

import processor_pb2
import processor_pb2_grpc

app = FastAPI()
logger = logging.getLogger("billing")
r = redis.Redis(host="redis", port=6379, decode_responses=True)

processor = processor_pb2_grpc.ProcessorStub(__import__("grpc").insecure_channel("processor:9000"))

MONTH_TTL_S = 30 * 24 * 3600


class RunRequest(BaseModel):
    subscription_id: str
    period_start: str
    action: str | None = None


def marker_key(subscription_id: str, period_start: date) -> str:
    return f"billing:run:{subscription_id}:{period_start.isoformat()}"


def charge_invoice(invoice) -> str:
    reply = processor.Charge(
        processor_pb2.ChargeRequest(invoice_id=invoice.id, amount_cents=invoice.amount_cents),
        timeout=5.0,
    )
    return reply.charge_id


def run_billing(subscription_id: str, period, action: str | None = None) -> dict:
    # TODO: a model-generated draft. It charges first and only then writes the marker, claims
    # nothing atomically, records a bare "done" with no charge reference, expires the marker after a
    # month, and has no guard for a closed period and no reconciliation for an in-flight run.
    invoice_ref = charge_invoice(period.invoice)
    r.set(marker_key(subscription_id, period.period_start), "done", ex=MONTH_TTL_S)
    logger.info("billed subscription=%s period=%s", subscription_id, period.period_start)
    return {"status": "charged", "reference": invoice_ref}


@app.post("/v1/billing-runs")
def start_run(body: RunRequest, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    period = load_period(body.subscription_id, body.period_start)
    return run_billing(body.subscription_id, period, body.action)
`,
      solution: `import logging
from datetime import date

import grpc
import redis
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

import processor_pb2
import processor_pb2_grpc

app = FastAPI()
logger = logging.getLogger("billing")
r = redis.Redis(host="redis", port=6379, decode_responses=True)

processor = processor_pb2_grpc.ProcessorStub(grpc.insecure_channel("processor:9000"))

RUN_KEY = "billing:run:{subscription_id}:{period_start}"
CLAIMED = "claimed"
CHARGED = "charged:"
PERIOD_CLOSED = "period_closed"
ADJUSTMENT_ACTION = "adjustment"
PROCESSOR_DEADLINE_S = 5.0


class RunRequest(BaseModel):
    subscription_id: str
    period_start: str
    action: str | None = None


def marker_key(subscription_id: str, period_start: date) -> str:
    return RUN_KEY.format(subscription_id=subscription_id, period_start=period_start.isoformat())


def claim_marker(subscription_id: str, period_start: date) -> bool:
    """Claim the run. No TTL: a closed period must stay identifiable months after it ended."""
    return bool(r.set(marker_key(subscription_id, period_start), CLAIMED, nx=True))


def confirm_marker(subscription_id: str, period_start: date, invoice_ref: str) -> None:
    """Record the charge reference, so the marker and the charge reconcile."""
    r.set(marker_key(subscription_id, period_start), f"{CHARGED}{invoice_ref}")


def charge_invoice(invoice) -> str:
    reply = processor.Charge(
        processor_pb2.ChargeRequest(
            invoice_id=invoice.id,
            amount_cents=invoice.amount_cents,
            idempotency_key=invoice.id,
        ),
        timeout=PROCESSOR_DEADLINE_S,
    )
    return reply.charge_id


def run_billing(subscription_id: str, period, action: str | None = None) -> dict:
    if period.period_end < date.today() and action != ADJUSTMENT_ACTION:
        return {"status": PERIOD_CLOSED, "action_required": ADJUSTMENT_ACTION}
    if not claim_marker(subscription_id, period.period_start):
        stored = r.get(marker_key(subscription_id, period.period_start)) or ""
        if stored.startswith(CHARGED):
            return {"status": "already_charged", "reference": stored[len(CHARGED) :]}
        state = processor.GetInvoice(processor_pb2.GetInvoiceRequest(invoice_id=period.invoice.id))
        if state.charge_id:
            confirm_marker(subscription_id, period.period_start, state.charge_id)
            return {"status": "reconciled", "reference": state.charge_id}
        return {"status": "in_flight", "action_required": "retry_after_reconcile"}
    invoice_ref = charge_invoice(period.invoice)
    confirm_marker(subscription_id, period.period_start, invoice_ref)
    logger.info("billed subscription=%s period=%s ref=%s", subscription_id, period.period_start, invoice_ref)
    return {"status": "charged", "reference": invoice_ref}


@app.post("/v1/billing-runs")
def start_run(body: RunRequest, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    period = load_period(body.subscription_id, body.period_start)
    result = run_billing(body.subscription_id, period, body.action)
    if result["status"] == PERIOD_CLOSED:
        raise HTTPException(status_code=409, detail={"action_required": ADJUSTMENT_ACTION})
    return result
`,
    },
    typescript: {
      starter: `/** The billing run for one (subscription, period): a model-generated draft. */
import {Redis} from 'ioredis';
import Fastify from 'fastify';

export const app = Fastify();
export const r = new Redis('redis://redis:6379');

const MONTH_TTL_S = 30 * 24 * 3600;

interface RunRequest {
  subscription_id: string;
  period_start: string;
  action?: string;
}

interface Period {
  period_start: string;
  period_end: string;
  invoice: {id: string; amount_cents: number};
}

export function markerKey(subscriptionId: string, periodStart: string): string {
  return \`billing:run:\${subscriptionId}:\${periodStart}\`;
}

export async function chargeInvoice(invoice: {id: string; amount_cents: number}): Promise<string> {
  const reply = await processor.Charge({invoice_id: invoice.id, amount_cents: invoice.amount_cents});
  return reply.charge_id;
}

export async function runBilling(
  subscriptionId: string,
  period: Period,
  action?: string,
): Promise<{status: string; reference?: string}> {
  // TODO: a model-generated draft. It charges first and only then writes the marker, claims nothing
  // atomically, records a bare 'done' with no charge reference, expires the marker after a month,
  // and has no guard for a closed period and no reconciliation for an in-flight run.
  const invoiceRef = await chargeInvoice(period.invoice);
  await r.set(markerKey(subscriptionId, period.period_start), 'done', 'EX', MONTH_TTL_S);
  return {status: 'charged', reference: invoiceRef};
}

app.post('/v1/billing-runs', async (request, reply) => {
  const body = request.body as RunRequest;
  const period = await loadPeriod(body.subscription_id, body.period_start);
  return reply.code(200).send(await runBilling(body.subscription_id, period, body.action));
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** The billing run for one (subscription, period): one atomic claim, one charge, one confirmation. */
import {Redis} from 'ioredis';
import Fastify from 'fastify';

export const app = Fastify();
export const r = new Redis('redis://redis:6379');

const RUN_KEY = (subscriptionId: string, periodStart: string): string =>
  \`billing:run:\${subscriptionId}:\${periodStart}\`;
const CLAIMED = 'claimed';
const CHARGED = 'charged:';
const PERIOD_CLOSED = 'period_closed';
const ADJUSTMENT_ACTION = 'adjustment';
const PROCESSOR_DEADLINE_MS = 5000;

interface RunRequest {
  subscription_id: string;
  period_start: string;
  action?: string;
}

interface Period {
  period_start: string;
  period_end: string;
  invoice: {id: string; amount_cents: number};
}

export const markerKey = RUN_KEY;

export async function claimMarker(subscriptionId: string, periodStart: string): Promise<boolean> {
  const claimed = await r.set(markerKey(subscriptionId, periodStart), CLAIMED, 'NX');
  return claimed === 'OK';
}

export async function confirmMarker(subscriptionId: string, periodStart: string, invoiceRef: string): Promise<void> {
  await r.set(markerKey(subscriptionId, periodStart), \`\${CHARGED}\${invoiceRef}\`);
}

export async function chargeInvoice(invoice: {id: string; amount_cents: number}): Promise<string> {
  const reply = await processor.Charge(
    {invoice_id: invoice.id, amount_cents: invoice.amount_cents, idempotency_key: invoice.id},
    {deadline: Date.now() + PROCESSOR_DEADLINE_MS},
  );
  return reply.charge_id;
}

export async function runBilling(
  subscriptionId: string,
  period: Period,
  action?: string,
): Promise<{status: string; reference?: string; action_required?: string}> {
  if (Date.parse(period.period_end) < Date.now() && action !== ADJUSTMENT_ACTION)
    return {status: PERIOD_CLOSED, action_required: ADJUSTMENT_ACTION};
  if (!(await claimMarker(subscriptionId, period.period_start))) {
    const stored = (await r.get(markerKey(subscriptionId, period.period_start))) ?? '';
    if (stored.startsWith(CHARGED)) return {status: 'already_charged', reference: stored.slice(CHARGED.length)};
    const state = await processor.GetInvoice({invoice_id: period.invoice.id});
    if (state.charge_id) {
      await confirmMarker(subscriptionId, period.period_start, state.charge_id);
      return {status: 'reconciled', reference: state.charge_id};
    }
    return {status: 'in_flight', action_required: 'retry_after_reconcile'};
  }
  const invoiceRef = await chargeInvoice(period.invoice);
  await confirmMarker(subscriptionId, period.period_start, invoiceRef);
  return {status: 'charged', reference: invoiceRef};
}

app.post('/v1/billing-runs', async (request, reply) => {
  const body = request.body as RunRequest;
  const period = await loadPeriod(body.subscription_id, body.period_start);
  const result = await runBilling(body.subscription_id, period, body.action);
  if (result.status === PERIOD_CLOSED)
    return reply.code(409).send({status: PERIOD_CLOSED, action_required: ADJUSTMENT_ACTION});
  return reply.code(200).send(result);
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
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const monthTTL = 30 * 24 * time.Hour

type RunRequest struct {
	SubscriptionID string \`json:"subscription_id"\`
	PeriodStart    string \`json:"period_start"\`
	Action         string \`json:"action"\`
}

func markerKey(subscriptionID, periodStart string) string {
	return "billing:run:" + subscriptionID + ":" + periodStart
}

func ChargeInvoice(invoice Invoice) (string, error) {
	reply, err := processor.Charge(context.Background(), &pb.ChargeRequest{
		InvoiceId:   invoice.ID,
		AmountCents: invoice.AmountCents,
	})
	if err != nil {
		return "", err
	}
	return reply.ChargeId, nil
}

// RunBilling bills one period of one subscription.
func RunBilling(ctx context.Context, subscriptionID string, period Period, action string) (map[string]any, error) {
	// TODO: a model-generated draft. It charges first and only then writes the marker, claims
	// nothing atomically, records a bare "done" with no charge reference, expires the marker after a
	// month, and has no guard for a closed period and no reconciliation for an in-flight run.
	invoiceRef, err := ChargeInvoice(period.Invoice)
	if err != nil {
		return nil, err
	}
	rdb.Set(ctx, markerKey(subscriptionID, period.PeriodStart), "done", monthTTL)
	log.Printf("billed subscription=%s period=%s", subscriptionID, period.PeriodStart)
	return map[string]any{"status": "charged", "reference": invoiceRef}, nil
}

func startRun(rw http.ResponseWriter, r *http.Request) {
	var body RunRequest
	_ = json.NewDecoder(r.Body).Decode(&body)
	period := loadPeriod(r.Context(), body.SubscriptionID, body.PeriodStart)
	result, _ := RunBilling(r.Context(), body.SubscriptionID, period, body.Action)
	writeJSON(rw, http.StatusOK, result)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/billing-runs", startRun)
	log.Fatal(http.ListenAndServe(":8080", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	claimed          = "claimed"
	charged          = "charged:"
	periodClosed     = "period_closed"
	adjustmentAction = "adjustment"
)

type RunRequest struct {
	SubscriptionID string \`json:"subscription_id"\`
	PeriodStart    string \`json:"period_start"\`
	Action         string \`json:"action"\`
}

func markerKey(subscriptionID, periodStart string) string {
	return "billing:run:" + subscriptionID + ":" + periodStart
}

// ClaimMarker claims the run with one SET NX. No TTL: a closed period must stay identifiable.
func ClaimMarker(ctx context.Context, subscriptionID, periodStart string) (bool, error) {
	return rdb.SetNX(ctx, markerKey(subscriptionID, periodStart), claimed, 0).Result()
}

func ConfirmMarker(ctx context.Context, subscriptionID, periodStart, invoiceRef string) error {
	return rdb.Set(ctx, markerKey(subscriptionID, periodStart), charged+invoiceRef, 0).Err()
}

func ChargeInvoice(invoice Invoice) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	reply, err := processor.Charge(ctx, &pb.ChargeRequest{
		InvoiceId:      invoice.ID,
		AmountCents:    invoice.AmountCents,
		IdempotencyKey: invoice.ID,
	})
	if err != nil {
		return "", err
	}
	return reply.ChargeId, nil
}

// RunBilling bills one period of one subscription exactly once.
func RunBilling(ctx context.Context, subscriptionID string, period Period, action string) (map[string]any, error) {
	if period.PeriodEnd.Before(time.Now()) && action != adjustmentAction {
		return map[string]any{"status": periodClosed, "action_required": adjustmentAction}, nil
	}
	ok, err := ClaimMarker(ctx, subscriptionID, period.PeriodStart)
	if err != nil {
		return nil, err
	}
	if !ok {
		stored, _ := rdb.Get(ctx, markerKey(subscriptionID, period.PeriodStart)).Result()
		if strings.HasPrefix(stored, charged) {
			return map[string]any{"status": "already_charged", "reference": strings.TrimPrefix(stored, charged)}, nil
		}
		state, err := processor.GetInvoice(ctx, &pb.GetInvoiceRequest{InvoiceId: period.Invoice.ID})
		if err != nil {
			return nil, err
		}
		if state.ChargeId != "" {
			if err := ConfirmMarker(ctx, subscriptionID, period.PeriodStart, state.ChargeId); err != nil {
				return nil, err
			}
			return map[string]any{"status": "reconciled", "reference": state.ChargeId}, nil
		}
		return map[string]any{"status": "in_flight", "action_required": "retry_after_reconcile"}, nil
	}
	invoiceRef, err := ChargeInvoice(period.Invoice)
	if err != nil {
		return nil, err
	}
	if err := ConfirmMarker(ctx, subscriptionID, period.PeriodStart, invoiceRef); err != nil {
		return nil, err
	}
	log.Printf("billed subscription=%s period=%s ref=%s", subscriptionID, period.PeriodStart, invoiceRef)
	return map[string]any{"status": "charged", "reference": invoiceRef}, nil
}

func startRun(rw http.ResponseWriter, r *http.Request) {
	var body RunRequest
	_ = json.NewDecoder(r.Body).Decode(&body)
	period := loadPeriod(r.Context(), body.SubscriptionID, body.PeriodStart)
	result, err := RunBilling(r.Context(), body.SubscriptionID, period, body.Action)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if result["status"] == periodClosed {
		rw.WriteHeader(http.StatusConflict)
		writeJSON(rw, http.StatusConflict, map[string]string{"action_required": adjustmentAction})
		return
	}
	writeJSON(rw, http.StatusOK, result)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/billing-runs", startRun)
	log.Fatal(http.ListenAndServe(":8080", mux))
}
`,
    },
    scala: {
      starter: `import java.time.{Duration, LocalDate}

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class RunRequest(subscription_id: String, period_start: String, action: Option[String])

object BillingRun {
  implicit val system: ActorSystem = ActorSystem("billing")
  implicit val runFormat: RootJsonFormat[RunRequest] = jsonFormat3(RunRequest)

  val monthTtl = Duration.ofDays(30).getSeconds
  val jedis = new Jedis("redis", 6379)

  def markerKey(subscriptionId: String, periodStart: LocalDate): String =
    s"billing:run:$subscriptionId:$periodStart"

  def chargeInvoice(invoice: Invoice): String =
    processor.Charge(ChargeRequest(invoice.id, invoice.amount_cents)).chargeId

  def runBilling(subscriptionId: String, period: Period, action: Option[String]): Map[String, String] = {
    // TODO: a model-generated draft. It charges first and only then writes the marker, claims
    // nothing atomically, records a bare "done" with no charge reference, expires the marker after a
    // month, and has no guard for a closed period and no reconciliation for an in-flight run.
    val invoiceRef = chargeInvoice(period.invoice)
    jedis.setex(markerKey(subscriptionId, period.period_start), monthTtl, "done")
    Map("status" -> "charged", "reference" -> invoiceRef)
  }

  val route: Route =
    path("v1" / "billing-runs") {
      post {
        entity(as[RunRequest]) { body =>
          val period = loadPeriod(body.subscription_id, body.period_start)
          complete(StatusCodes.OK, runBilling(body.subscription_id, period, body.action))
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.time.{Duration, LocalDate}

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import redis.clients.jedis.params.SetParams
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class RunRequest(subscription_id: String, period_start: String, action: Option[String])

object BillingRun {
  implicit val system: ActorSystem = ActorSystem("billing")
  implicit val runFormat: RootJsonFormat[RunRequest] = jsonFormat3(RunRequest)

  val Claimed = "claimed"
  val ChargedPrefix = "charged:"
  val PeriodClosed = "period_closed"
  val AdjustmentAction = "adjustment"
  val jedis = new Jedis("redis", 6379)

  def markerKey(subscriptionId: String, periodStart: LocalDate): String =
    s"billing:run:$subscriptionId:$periodStart"

  // One SET NX, no expiry: a closed period stays identifiable months after it ended.
  def claimMarker(subscriptionId: String, periodStart: LocalDate): Boolean =
    jedis.set(markerKey(subscriptionId, periodStart), Claimed, SetParams.setParams().nx()) == "OK"

  def confirmMarker(subscriptionId: String, periodStart: LocalDate, invoiceRef: String): Unit =
    jedis.set(markerKey(subscriptionId, periodStart), ChargedPrefix + invoiceRef)

  def chargeInvoice(invoice: Invoice): String =
    processor.Charge(ChargeRequest(invoice.id, invoice.amount_cents, invoice.id)).chargeId

  def runBilling(subscriptionId: String, period: Period, action: Option[String]): Map[String, String] = {
    if (period.period_end.isBefore(LocalDate.now()) && !action.contains(AdjustmentAction))
      return Map("status" -> PeriodClosed, "action_required" -> AdjustmentAction)
    if (!claimMarker(subscriptionId, period.period_start)) {
      val stored = Option(jedis.get(markerKey(subscriptionId, period.period_start))).getOrElse("")
      if (stored.startsWith(ChargedPrefix))
        return Map("status" -> "already_charged", "reference" -> stored.stripPrefix(ChargedPrefix))
      val state = processor.GetInvoice(GetInvoiceRequest(period.invoice.id))
      if (state.chargeId.nonEmpty) {
        confirmMarker(subscriptionId, period.period_start, state.chargeId)
        return Map("status" -> "reconciled", "reference" -> state.chargeId)
      }
      return Map("status" -> "in_flight", "action_required" -> "retry_after_reconcile")
    }
    val invoiceRef = chargeInvoice(period.invoice)
    confirmMarker(subscriptionId, period.period_start, invoiceRef)
    Map("status" -> "charged", "reference" -> invoiceRef)
  }

  val route: Route =
    path("v1" / "billing-runs") {
      post {
        entity(as[RunRequest]) { body =>
          val period = loadPeriod(body.subscription_id, body.period_start)
          runBilling(body.subscription_id, period, body.action) match {
            case result if result("status") == PeriodClosed =>
              complete(
                StatusCodes.Conflict,
                """{"status":"period_closed","action_required":"adjustment"}"""
              )
            case result => complete(StatusCodes.OK, result)
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

#include <chrono>
#include <iostream>
#include <string>

using json = nlohmann::json;

constexpr long kMonthTtl = 30L * 24L * 3600L;

std::unique_ptr<sw::redis::Redis> redis = std::make_unique<sw::redis::Redis>("tcp://redis:6379");

struct Period {
  std::string period_start;
  std::string period_end;
  Invoice invoice;
};

std::string markerKey(const std::string& subscription_id, const std::string& period_start) {
  return "billing:run:" + subscription_id + ":" + period_start;
}

std::string chargeInvoice(const Invoice& invoice) {
  ChargeRequest request;
  request.set_invoice_id(invoice.id());
  request.set_amount_cents(invoice.amount_cents());
  ChargeReply reply;
  grpc::ClientContext ctx;
  processor->Charge(&ctx, request, &reply);
  return reply.charge_id();
}

// RunBilling bills one period of one subscription.
json runBilling(const std::string& subscription_id, const Period& period, const std::string& action) {
  // TODO: a model-generated draft. It charges first and only then writes the marker, claims nothing
  // atomically, records a bare "done" with no charge reference, expires the marker after a month,
  // and has no guard for a closed period and no reconciliation for an in-flight run.
  const auto invoice_reference = chargeInvoice(period.invoice);
  redis->setex(markerKey(subscription_id, period.period_start), kMonthTtl, "done");
  std::cout << "billed subscription=" << subscription_id << " period=" << period.period_start << "\\n";
  return json{{"status", "charged"}, {"reference", invoice_reference}};
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/billing-runs", [](const httplib::Request& req, httplib::Response& res) {
    const json body = json::parse(req.body, nullptr, false);
    const auto subscription_id = body.value("subscription_id", std::string());
    const auto period = loadPeriod(subscription_id, body.value("period_start", std::string()));
    res.status = 200;
    res.set_content(runBilling(subscription_id, period, body.value("action", std::string())).dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <iostream>
#include <string>

using json = nlohmann::json;

const std::string kClaimed = "claimed";
const std::string kChargedPrefix = "charged:";
const std::string kPeriodClosed = "period_closed";
const std::string kAdjustmentAction = "adjustment";

std::unique_ptr<sw::redis::Redis> redis = std::make_unique<sw::redis::Redis>("tcp://redis:6379");

struct Period {
  std::string period_start;
  std::string period_end;
  Invoice invoice;
};

std::string markerKey(const std::string& subscription_id, const std::string& period_start) {
  return "billing:run:" + subscription_id + ":" + period_start;
}

// One SET NX (UpdateType::NOT_EXIST) and no TTL: a closed period stays identifiable for good.
bool claimMarker(const std::string& subscription_id, const std::string& period_start) {
  return redis->set(markerKey(subscription_id, period_start), kClaimed, std::chrono::seconds(0),
                    sw::redis::UpdateType::NOT_EXIST);
}

void confirmMarker(const std::string& subscription_id, const std::string& period_start,
                   const std::string& invoice_reference) {
  redis->set(markerKey(subscription_id, period_start), kChargedPrefix + invoice_reference);
}

std::string chargeInvoice(const Invoice& invoice) {
  ChargeRequest request;
  request.set_invoice_id(invoice.id());
  request.set_amount_cents(invoice.amount_cents());
  request.set_idempotency_key(invoice.id());
  ChargeReply reply;
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(5));
  processor->Charge(&ctx, request, &reply);
  return reply.charge_id();
}

json runBilling(const std::string& subscription_id, const Period& period, const std::string& action) {
  if (period.period_end < todayIso() && action != kAdjustmentAction) {
    return json{{"status", kPeriodClosed}, {"action_required", kAdjustmentAction}};
  }
  if (!claimMarker(subscription_id, period.period_start)) {
    const auto stored = redis->get(markerKey(subscription_id, period.period_start)).value_or("");
    if (stored.rfind(kChargedPrefix, 0) == 0) {
      return json{{"status", "already_charged"}, {"reference", stored.substr(kChargedPrefix.size())}};
    }
    grpc::ClientContext rctx;
    GetInvoiceRequest request;
    request.set_invoice_id(period.invoice.id());
    GetInvoiceReply state;
    processor->GetInvoice(&rctx, request, &state);
    if (!state.charge_id().empty()) {
      confirmMarker(subscription_id, period.period_start, state.charge_id());
      return json{{"status", "reconciled"}, {"reference", state.charge_id()}};
    }
    return json{{"status", "in_flight"}, {"action_required", "retry_after_reconcile"}};
  }
  const auto invoice_reference = chargeInvoice(period.invoice);
  confirmMarker(subscription_id, period.period_start, invoice_reference);
  std::cout << "billed subscription=" << subscription_id << " period=" << period.period_start
            << " ref=" << invoice_reference << "\\n";
  return json{{"status", "charged"}, {"reference", invoice_reference}};
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/billing-runs", [](const httplib::Request& req, httplib::Response& res) {
    const json body = json::parse(req.body, nullptr, false);
    const auto subscription_id = body.value("subscription_id", std::string());
    const auto period = loadPeriod(subscription_id, body.value("period_start", std::string()));
    const auto result = runBilling(subscription_id, period, body.value("action", std::string()));
    if (result.at("status") == kPeriodClosed) {
      res.status = 409;
      res.set_content(
          json{{"status", kPeriodClosed}, {"action_required", kAdjustmentAction}}.dump(),
          "application/json");
      return;
    }
    res.status = 200;
    res.set_content(result.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Order is the whole fix: claim, then charge, then confirm. `SET key claimed NX` is one round trip and exactly one runner gets `OK`; everything after the claim is work that only that runner may do. Anything that charges before it claims can be reached by two retries at once.',
    'The marker value is evidence: store the charge reference (`charged:{invoice_ref}`) so the marker and the charge reconcile. A claim with no reference is an unknown outcome — the retry must read the processor invoice (`GetInvoice`) and adopt what it finds instead of charging again.',
    'Never give the run marker an expiry. A marker that dies with the month cannot distinguish a closed period from an unbilled one, and the late retry that finds an empty key charges a period that was already billed and closed. The key is per `(subscription, period_start)` for the same reason: one subscription has many periods.',
  ],
  debrief: `The interviewer is testing idempotency under crashes, which is the one property a demo never exercises. Four things are being checked: the claim is atomic (\`SET NX\`, not read-then-write), the claim happens before the charge (so a lost race cannot spend money), the marker carries the charge reference (so a run can be reconciled instead of repeated), and the marker outlives its period (so a closed period stays closed). The subtle one is the TTL: it looks like hygiene, and it silently converts idempotency into "idempotent for thirty days". Real billing systems add a claim lease with a heartbeat for the in-flight case, a separate adjustment workflow with its own audit trail, reconciliation jobs that compare markers with processor settlement files, and per-run trace ids so on-call can tell a replay from a first attempt.`,
};
