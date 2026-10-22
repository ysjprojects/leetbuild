import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Inspection calls that gate refunds',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'warehouse', 'refunds'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it asks the warehouse to grade
the returned item, gets an answer on the happy path, and settles the return. It compiles, it serves
the demo, and on a bad day it pays customers for items nobody inspected. Review it like the service
owner, fix it, and prove the fix with the checks below.

Implement the settlement path that runs once a return is registered — grade the item at the
warehouse, then pay what the grade allows:

- \`Warehouse.GradeItem(order_line_id, quantity)\` carries a **3-second deadline** on every attempt.
  A warehouse that stops answering must not hold a settlement open, and the deadline belongs on the
  call itself — never on a sleep or a timer around it.
- \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` are **transient**: retry them, with the loop bounded at
  **3 attempts**. \`INVALID_ARGUMENT\` and \`NOT_FOUND\` are **terminal**: asking the same question
  again gets the same refusal.
- When no grade arrives, the return is left in \`awaiting-inspection\` and the refund processor is
  **not called**. The draft reads a timeout as "nothing wrong with the item" and requests the full
  refund, so every warehouse outage pays out an unverified claim.
- The amount follows the grade: a \`sellable\` grade refunds the full line value
  (\`order_total_cents * quantity\`) while a \`damaged\` grade refunds **50%** of it. A verdict is an
  answer, not a failure: a \`damaged\` grade is never asked for again.
- The refund is requested **only after a grade arrives**, and \`refunded\` is written once the
  processor accepts the refund — the state records what happened, not what was attempted.

**Failure mode the checks target.** A warehouse outage becomes an automatic payout: the draft turns
\`DEADLINE_EXCEEDED\` into a full refund for an item that was never inspected. It also treats a
\`damaged\` verdict as if it were transient, asking again until the answer is \`sellable\`, and it
computes the refund without the grade, so the policy for damaged goods never applies.`,
  sequence: {
    participants: ['Returns API', 'Warehouse', 'Refund processor'],
    messages: [
      {from: 'Returns API', to: 'Warehouse', label: 'GradeItem(line, qty) · deadline 3 s', kind: 'sync'},
      {from: 'Warehouse', to: 'Returns API', label: 'status UNAVAILABLE → retry within 3 attempts', kind: 'reply'},
      {from: 'Warehouse', to: 'Returns API', label: 'grade = sellable', kind: 'reply'},
      {from: 'Returns API', to: 'Returns API', label: 'amount = order_total_cents × qty', kind: 'sync'},
      {from: 'Returns API', to: 'Refund processor', label: 'issue refund(return_id, amount_cents)', kind: 'sync'},
      {from: 'Refund processor', to: 'Returns API', label: 'accepted → state = refunded', kind: 'reply'},
      {from: 'Warehouse', to: 'Returns API', label: 'grade = damaged · a verdict, never retried', kind: 'reply'},
      {from: 'Returns API', to: 'Returns API', label: 'amount = 50% of the line value', kind: 'sync'},
      {from: 'Returns API', to: 'Warehouse', label: 'GradeItem(line, qty) · deadline 3 s', kind: 'sync'},
      {from: 'Warehouse', to: 'Returns API', label: 'status DEADLINE_EXCEEDED · no grade', kind: 'reply'},
      {from: 'Returns API', to: 'Returns API', label: 'state = awaiting-inspection · refund held', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every grade call carries a 3-second deadline',
      detail:
        'The deadline is set on the call itself — `timeout=3.0`, `{deadline: …}`, a context with a 3 s timeout, `withDeadlineAfter`, `set_deadline` — and on every attempt. A `sleep` or a timer after the response is not a deadline: a warehouse that stops answering would hold the settlement open.',
      match: {
        python: {
          all: [/GRADE_DEADLINE_S\s*=\s*3(\.0)?\b/, /GradeItem\([^\n]*timeout\s*=\s*(GRADE_DEADLINE_S|3(\.0)?)\b/],
        },
        typescript: {
          all: [
            /GRADE_DEADLINE_MS\s*=\s*3000\b/,
            /GradeItem\([^\n]*deadline:\s*[^\n]*Date\.now\(\)\s*\+\s*(GRADE_DEADLINE_MS|3000)\b/,
          ],
        },
        go: {
          all: [
            /gradeDeadline\s*=\s*3\s*\*\s*time\.Second/,
            /context\.WithTimeout\([^\n]*(gradeDeadline|3\s*\*\s*time\.Second)\s*\)/,
            /\.GradeItem\(/,
          ],
        },
        scala: {
          all: [/GradeDeadlineMillis\s*=\s*3000L?\b/, /withDeadlineAfter\(\s*(GradeDeadlineMillis|3000L?)/],
        },
        cpp: {
          all: [/kGradeDeadline\{3000\}/, /set_deadline\([^\n]*(kGradeDeadline|std::chrono::seconds\(\s*3\s*\))/],
        },
      },
    },
    {
      id: 'hold-on-timeout',
      title: 'A timeout holds the refund in awaiting-inspection',
      detail:
        'When the attempts end without a grade — a slow warehouse gives `DEADLINE_EXCEEDED` — the return is written as `awaiting-inspection` and the refund is held. The draft assumes the item is sellable, so the same outage pays an unverified claim in full.',
      match: {
        python: {
          all: [
            /"awaiting-inspection"/,
            /StatusCode\.DEADLINE_EXCEEDED/,
            /set_state\(return_id,\s*(AWAITING_INSPECTION|"awaiting-inspection")\)/,
          ],
          none: [/grade\s*=\s*(GRADE_SELLABLE|"sellable")/],
          order: [/set_state\(return_id,\s*(AWAITING_INSPECTION|"awaiting-inspection")\)/, /refunds\.IssueRefund\(/],
        },
        typescript: {
          all: [
            /'awaiting-inspection'/,
            /status\.DEADLINE_EXCEEDED/,
            /setState\(returnId,\s*(AWAITING_INSPECTION|'awaiting-inspection')\)/,
          ],
          none: [/grade\s*=\s*(GRADE_SELLABLE|'sellable')/],
          order: [/setState\(returnId,\s*(AWAITING_INSPECTION|'awaiting-inspection')\)/, /refunds\.IssueRefund\(/],
        },
        go: {
          all: [
            /"awaiting-inspection"/,
            /codes\.DeadlineExceeded/,
            /setState\(ctx,\s*returnID,\s*(awaitingInspection|"awaiting-inspection")\)/,
          ],
          none: [/grade\s*=\s*(gradeSellable|"sellable")/],
          order: [
            /setState\(ctx,\s*returnID,\s*(awaitingInspection|"awaiting-inspection")\)/,
            /refunds\.IssueRefund\(/,
          ],
        },
        scala: {
          all: [
            /"awaiting-inspection"/,
            /Code\.DEADLINE_EXCEEDED/,
            /setState\(returnId,\s*(AwaitingInspection|"awaiting-inspection")\)/,
          ],
          none: [/grade\s*=\s*(GradeSellable|"sellable")/],
          order: [/setState\(returnId,\s*(AwaitingInspection|"awaiting-inspection")\)/, /refunds\.issueRefund\(/],
        },
        cpp: {
          all: [
            /"awaiting-inspection"/,
            /StatusCode::DEADLINE_EXCEEDED/,
            /setState\(returnId,\s*(kAwaitingInspection|"awaiting-inspection")\)/,
          ],
          none: [/grade\s*=\s*(kGradeSellable|"sellable")/],
          order: [/setState\(returnId,\s*(kAwaitingInspection|"awaiting-inspection")\)/, /refunds->IssueRefund\(/],
        },
      },
    },
    {
      id: 'damaged-amount',
      title: 'The grade decides the amount: damaged pays half',
      detail:
        'The refund is computed from the verdict: `sellable` refunds the whole line value (`order_total_cents * quantity`), `damaged` refunds the damaged percentage (50%) of it. The draft ignores the grade and always pays the full line.',
      match: {
        python: {
          all: [
            /DAMAGED_REFUND_PERCENT\s*=\s*50\b/,
            /grade\s*==\s*GRADE_DAMAGED/,
            /return line_cents \* DAMAGED_REFUND_PERCENT/,
            /return line_cents(?!\s*\*)/,
          ],
        },
        typescript: {
          all: [
            /DAMAGED_REFUND_PERCENT\s*=\s*50\b/,
            /grade\s*===\s*GRADE_DAMAGED/,
            /lineCents\s*\*\s*DAMAGED_REFUND_PERCENT/,
            /return lineCents(?!\s*\*)/,
          ],
        },
        go: {
          all: [
            /damagedRefundPercent\s*=\s*50\b/,
            /grade\s*==\s*gradeDamaged/,
            /lineCents\s*\*\s*damagedRefundPercent\s*\/\s*100/,
            /return lineCents(?!\s*\*)/,
          ],
        },
        scala: {
          all: [
            /DamagedRefundPercent\s*=\s*50L?\b/,
            /grade\s*==\s*GradeDamaged/,
            /lineCents\s*\*\s*DamagedRefundPercent\s*\/\s*100/,
            /else \{\s*lineCents\b/,
          ],
        },
        cpp: {
          all: [
            /kDamagedRefundPercent\s*=\s*50\b/,
            /grade\s*==\s*kGradeDamaged/,
            /lineCents\s*\*\s*kDamagedRefundPercent\s*\/\s*100/,
            /return lineCents(?!\s*\*)/,
          ],
        },
      },
    },
    {
      id: 'terminal-not-retried',
      title: 'Only UNAVAILABLE and DEADLINE_EXCEEDED are retried',
      detail:
        'The attempt loop is bounded and continues only for the transient statuses (`UNAVAILABLE`, `DEADLINE_EXCEEDED`); `INVALID_ARGUMENT` and `NOT_FOUND` leave it as failures, and a `damaged` verdict ends it with an answer. The draft loops until the grade is `sellable`, so a damaged item is inspected again and a terminal refusal is retried.',
      match: {
        python: {
          all: [
            /RETRYABLE_GRADE_CODES/,
            /StatusCode\.UNAVAILABLE/,
            /StatusCode\.DEADLINE_EXCEEDED/,
            /StatusCode\.INVALID_ARGUMENT|StatusCode\.NOT_FOUND/,
            /for attempt in range\(GRADE_ATTEMPTS\)/,
          ],
          none: [/grade\s*!=\s*GRADE_SELLABLE/],
        },
        typescript: {
          all: [
            /RETRYABLE_GRADE_CODES/,
            /status\.UNAVAILABLE/,
            /status\.DEADLINE_EXCEEDED/,
            /status\.INVALID_ARGUMENT|status\.NOT_FOUND/,
            /for \(let attempt = 0; attempt < GRADE_ATTEMPTS; attempt\+\+\)/,
          ],
          none: [/grade\s*!==\s*GRADE_SELLABLE/],
        },
        go: {
          all: [
            /retryableGradeCodes/,
            /codes\.Unavailable/,
            /codes\.DeadlineExceeded/,
            /codes\.InvalidArgument|codes\.NotFound/,
            /for attempt := 0; attempt < gradeAttempts; attempt\+\+/,
          ],
          none: [/grade\s*!=\s*gradeSellable/],
        },
        scala: {
          all: [
            /RetryableGradeCodes/,
            /Code\.UNAVAILABLE/,
            /Code\.DEADLINE_EXCEEDED/,
            /Code\.INVALID_ARGUMENT|Code\.NOT_FOUND/,
            /while \(attempt < GradeAttempts\)/,
          ],
          none: [/grade\s*!=\s*GradeSellable/],
        },
        cpp: {
          all: [
            /kRetryableGradeCodes/,
            /StatusCode::UNAVAILABLE/,
            /StatusCode::DEADLINE_EXCEEDED/,
            /StatusCode::INVALID_ARGUMENT|StatusCode::NOT_FOUND/,
            /for \(int attempt = 0; attempt < kGradeAttempts; \+\+attempt\)/,
          ],
          none: [/grade\s*!=\s*kGradeSellable/],
        },
      },
    },
    {
      id: 'grade-before-refund',
      title: 'The refund is requested only after a grade arrives',
      detail:
        'The missing-grade branch holds the refund and returns, so the processor call is reachable only with a verdict in hand — and `refunded` is written after the processor accepts, never before.',
      match: {
        python: {
          order: [
            /if grade is None|if not grade/,
            /return AWAITING_INSPECTION|return "awaiting-inspection"/,
            /refunds\.IssueRefund\(/,
            /set_state\(return_id, "refunded"\)/,
          ],
        },
        typescript: {
          order: [
            /if \(grade === null\)|if \(!grade\)/,
            /return AWAITING_INSPECTION|return 'awaiting-inspection'/,
            /refunds\.IssueRefund\(/,
            /setState\(returnId, 'refunded'\)/,
          ],
        },
        go: {
          order: [
            /if grade == ""|if len\(grade\) == 0/,
            /return awaitingInspection|return "awaiting-inspection"/,
            /refunds\.IssueRefund\(/,
            /setState\(ctx, returnID, "refunded"\)/,
          ],
        },
        scala: {
          order: [
            /case None|if \(grade\.isEmpty\)/,
            /setState\(returnId, AwaitingInspection\)|setState\(returnId, "awaiting-inspection"\)/,
            /refunds\.issueRefund\(/,
            /setState\(returnId, "refunded"\)/,
          ],
        },
        cpp: {
          order: [
            /if \(!grade\.has_value\(\)\)|if \(!grade\)/,
            /return kAwaitingInspection|return "awaiting-inspection"/,
            /refunds->IssueRefund\(/,
            /setState\(returnId, "refunded"\)/,
          ],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `"""Settlement: the warehouse grades the returned item, the refund processor pays for it."""
import grpc

import refunds_pb2
import refunds_pb2_grpc
import warehouse_pb2
import warehouse_pb2_grpc

GRADE_DEADLINE_S = 3.0
GRADE_ATTEMPTS = 3
GRADE_SELLABLE = "sellable"

warehouse = warehouse_pb2_grpc.WarehouseStub(grpc.insecure_channel("warehouse:9000"))
refunds = refunds_pb2_grpc.RefundsStub(grpc.insecure_channel("refunds:9001"))


def set_state(return_id: str, state: str) -> None:
    """Persist the return's state; the read path serves this value back."""
    raise NotImplementedError


def settle_return(return_id: str, order_line_id: str, quantity: int, order_total_cents: int) -> str:
    request = warehouse_pb2.GradeItemRequest(order_line_id=order_line_id, quantity=quantity)
    # TODO: the draft keeps asking until the grade is sellable and reads a timeout as "sellable",
    # so a warehouse outage refunds the customer in full without an inspection.
    grade = None
    attempts = 0
    while grade != GRADE_SELLABLE and attempts < GRADE_ATTEMPTS:
        attempts += 1
        try:
            grade = warehouse.GradeItem(request, timeout=GRADE_DEADLINE_S).grade
        except grpc.RpcError:
            grade = GRADE_SELLABLE
            break
    amount_cents = order_total_cents * quantity
    refunds.IssueRefund(
        refunds_pb2.IssueRefundRequest(return_id=return_id, amount_cents=amount_cents),
        timeout=GRADE_DEADLINE_S,
    )
    set_state(return_id, "refunded")
    return "refunded"
`,
      solution: `"""Settlement: the warehouse grades the returned item, the refund processor pays for it."""
import time

import grpc

import refunds_pb2
import refunds_pb2_grpc
import warehouse_pb2
import warehouse_pb2_grpc

GRADE_DEADLINE_S = 3.0
GRADE_ATTEMPTS = 3
GRADE_RETRY_DELAY_S = 0.1
GRADE_DAMAGED = "damaged"
RETRYABLE_GRADE_CODES = {grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED}
TERMINAL_GRADE_CODES = {grpc.StatusCode.INVALID_ARGUMENT, grpc.StatusCode.NOT_FOUND}
DAMAGED_REFUND_PERCENT = 50
AWAITING_INSPECTION = "awaiting-inspection"

warehouse = warehouse_pb2_grpc.WarehouseStub(grpc.insecure_channel("warehouse:9000"))
refunds = refunds_pb2_grpc.RefundsStub(grpc.insecure_channel("refunds:9001"))


def set_state(return_id: str, state: str) -> None:
    """Persist the return's state; the read path serves this value back."""
    raise NotImplementedError


class GradeRejected(Exception):
    """The warehouse refused to grade this line; a retry gets the same refusal."""


def grade_item(order_line_id: str, quantity: int) -> str | None:
    """The warehouse's verdict, or None when it never answered within the attempts."""
    request = warehouse_pb2.GradeItemRequest(order_line_id=order_line_id, quantity=quantity)
    for attempt in range(GRADE_ATTEMPTS):
        try:
            reply = warehouse.GradeItem(request, timeout=GRADE_DEADLINE_S)
        except grpc.RpcError as e:
            code = e.code()
            if code in TERMINAL_GRADE_CODES:
                raise GradeRejected(f"warehouse refused the grade: {code}")
            if code not in RETRYABLE_GRADE_CODES:
                raise
            time.sleep(GRADE_RETRY_DELAY_S)
            continue
        # A verdict is an answer, not a failure: damaged is final and is never asked again.
        return reply.grade
    return None


def refund_cents_for(grade: str, order_total_cents: int, quantity: int) -> int:
    """Policy: a sellable line is paid in full, a damaged one at the damaged percentage."""
    line_cents = order_total_cents * quantity
    if grade == GRADE_DAMAGED:
        return line_cents * DAMAGED_REFUND_PERCENT // 100
    return line_cents


def settle_return(return_id: str, order_line_id: str, quantity: int, order_total_cents: int) -> str:
    grade = grade_item(order_line_id, quantity)
    if grade is None:
        # No verdict: hold the refund instead of paying for an inspection that never happened.
        set_state(return_id, AWAITING_INSPECTION)
        return AWAITING_INSPECTION
    amount_cents = refund_cents_for(grade, order_total_cents, quantity)
    refunds.IssueRefund(
        refunds_pb2.IssueRefundRequest(return_id=return_id, amount_cents=amount_cents),
        timeout=GRADE_DEADLINE_S,
    )
    set_state(return_id, "refunded")
    return "refunded"
`,
    },
    typescript: {
      starter: `/** Settlement: the warehouse grades the returned item, the refund processor pays for it. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const GRADE_DEADLINE_MS = 3000;
const GRADE_ATTEMPTS = 3;
const GRADE_SELLABLE = 'sellable';

interface GradeItemRequest {
  order_line_id: string;
  quantity: number;
}
interface GradeItemReply {
  grade: string;
}
interface IssueRefundRequest {
  return_id: string;
  amount_cents: number;
}
interface IssueRefundReply {
  accepted: boolean;
}
interface WarehouseClient {
  GradeItem(request: GradeItemRequest, options: {deadline: Date}): Promise<GradeItemReply>;
}
interface RefundsClient {
  IssueRefund(request: IssueRefundRequest, options: {deadline: Date}): Promise<IssueRefundReply>;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('returns.proto')) as unknown as {
  returns: {
    Warehouse: new (address: string, credentials: grpc.ChannelCredentials) => WarehouseClient;
    Refunds: new (address: string, credentials: grpc.ChannelCredentials) => RefundsClient;
  };
};

const warehouse = new pkg.returns.Warehouse('warehouse:9000', grpc.credentials.createInsecure());
const refunds = new pkg.returns.Refunds('refunds:9001', grpc.credentials.createInsecure());

export async function setState(returnId: string, state: string): Promise<void> {
  throw new Error('not implemented');
}

export async function settleReturn(
  returnId: string,
  orderLineId: string,
  quantity: number,
  orderTotalCents: number,
): Promise<string> {
  const request: GradeItemRequest = {order_line_id: orderLineId, quantity};
  // TODO: the draft keeps asking until the grade is sellable and reads a timeout as "sellable",
  // so a warehouse outage refunds the customer in full without an inspection.
  let grade: string | null = null;
  for (let attempt = 0; attempt < GRADE_ATTEMPTS && grade !== GRADE_SELLABLE; attempt++) {
    try {
      grade = (await warehouse.GradeItem(request, {deadline: new Date(Date.now() + GRADE_DEADLINE_MS)})).grade;
    } catch {
      grade = GRADE_SELLABLE;
      break;
    }
  }
  const amountCents = orderTotalCents * quantity;
  await refunds.IssueRefund(
    {return_id: returnId, amount_cents: amountCents},
    {deadline: new Date(Date.now() + GRADE_DEADLINE_MS)},
  );
  await setState(returnId, 'refunded');
  return 'refunded';
}
`,
      solution: `/** Settlement: the warehouse grades the returned item, the refund processor pays for it. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const GRADE_DEADLINE_MS = 3000;
const GRADE_ATTEMPTS = 3;
const GRADE_RETRY_DELAY_MS = 100;
const GRADE_DAMAGED = 'damaged';
const RETRYABLE_GRADE_CODES = [grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED];
const TERMINAL_GRADE_CODES = [grpc.status.INVALID_ARGUMENT, grpc.status.NOT_FOUND];
const DAMAGED_REFUND_PERCENT = 50;
const AWAITING_INSPECTION = 'awaiting-inspection';

interface GradeItemRequest {
  order_line_id: string;
  quantity: number;
}
interface GradeItemReply {
  grade: string;
}
interface IssueRefundRequest {
  return_id: string;
  amount_cents: number;
}
interface IssueRefundReply {
  accepted: boolean;
}
interface WarehouseClient {
  GradeItem(request: GradeItemRequest, options: {deadline: Date}): Promise<GradeItemReply>;
}
interface RefundsClient {
  IssueRefund(request: IssueRefundRequest, options: {deadline: Date}): Promise<IssueRefundReply>;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('returns.proto')) as unknown as {
  returns: {
    Warehouse: new (address: string, credentials: grpc.ChannelCredentials) => WarehouseClient;
    Refunds: new (address: string, credentials: grpc.ChannelCredentials) => RefundsClient;
  };
};

const warehouse = new pkg.returns.Warehouse('warehouse:9000', grpc.credentials.createInsecure());
const refunds = new pkg.returns.Refunds('refunds:9001', grpc.credentials.createInsecure());

export async function setState(returnId: string, state: string): Promise<void> {
  throw new Error('not implemented');
}

class GradeRejected extends Error {}

/** The warehouse's verdict, or null when it never answered within the attempts. */
async function gradeItem(orderLineId: string, quantity: number): Promise<string | null> {
  const request: GradeItemRequest = {order_line_id: orderLineId, quantity};
  for (let attempt = 0; attempt < GRADE_ATTEMPTS; attempt++) {
    try {
      const reply = await warehouse.GradeItem(request, {deadline: new Date(Date.now() + GRADE_DEADLINE_MS)});
      // A verdict is an answer, not a failure: damaged is final and is never asked again.
      return reply.grade;
    } catch (e) {
      const {code} = e as grpc.ServiceError;
      if (TERMINAL_GRADE_CODES.includes(code)) throw new GradeRejected('warehouse refused the grade: ' + String(code));
      if (!RETRYABLE_GRADE_CODES.includes(code)) throw e;
      const {promise: retryWait, resolve: retryNow} = Promise.withResolvers<void>();
      setTimeout(retryNow, GRADE_RETRY_DELAY_MS);
      await retryWait;
    }
  }
  return null;
}

/** Policy: a sellable line is paid in full, a damaged one at the damaged percentage. */
function refundCentsFor(grade: string, orderTotalCents: number, quantity: number): number {
  const lineCents = orderTotalCents * quantity;
  if (grade === GRADE_DAMAGED) return Math.floor((lineCents * DAMAGED_REFUND_PERCENT) / 100);
  return lineCents;
}

export async function settleReturn(
  returnId: string,
  orderLineId: string,
  quantity: number,
  orderTotalCents: number,
): Promise<string> {
  const grade = await gradeItem(orderLineId, quantity);
  if (grade === null) {
    // No verdict: hold the refund instead of paying for an inspection that never happened.
    await setState(returnId, AWAITING_INSPECTION);
    return AWAITING_INSPECTION;
  }
  const amountCents = refundCentsFor(grade, orderTotalCents, quantity);
  await refunds.IssueRefund(
    {return_id: returnId, amount_cents: amountCents},
    {deadline: new Date(Date.now() + GRADE_DEADLINE_MS)},
  );
  await setState(returnId, 'refunded');
  return 'refunded';
}
`,
    },
    go: {
      starter: `// Settlement: the warehouse grades the returned item, the refund processor pays for it.
package main

import (
	"context"
	"errors"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	refundspb "returns/refundspb"
	warehousepb "returns/warehousepb"
)

const (
	gradeDeadline  = 3 * time.Second
	gradeAttempts  = 3
	gradeSellable  = "sellable"
)

var warehouseConn, _ = grpc.NewClient("warehouse:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
var refundsConn, _ = grpc.NewClient("refunds:9001", grpc.WithTransportCredentials(insecure.NewCredentials()))

var warehouse = warehousepb.NewWarehouseClient(warehouseConn)
var refunds = refundspb.NewRefundsClient(refundsConn)

func setState(ctx context.Context, returnID, state string) error {
	return errors.New("not implemented")
}

func settleReturn(ctx context.Context, returnID, orderLineID string, quantity int, orderTotalCents int64) (string, error) {
	req := &warehousepb.GradeItemRequest{OrderLineId: orderLineID, Quantity: uint32(quantity)}
	// TODO: the draft keeps asking until the grade is sellable and reads a timeout as "sellable",
	// so a warehouse outage refunds the customer in full without an inspection.
	grade := ""
	for attempt := 0; attempt < gradeAttempts && grade != gradeSellable; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, gradeDeadline)
		reply, err := warehouse.GradeItem(callCtx, req)
		cancel()
		if err != nil {
			grade = gradeSellable
			break
		}
		grade = reply.GetGrade()
	}
	amountCents := orderTotalCents * int64(quantity)
	if _, err := refunds.IssueRefund(ctx, &refundspb.IssueRefundRequest{ReturnId: returnID, AmountCents: amountCents}); err != nil {
		return "", err
	}
	if err := setState(ctx, returnID, "refunded"); err != nil {
		return "", err
	}
	return "refunded", nil
}
`,
      solution: `// Settlement: the warehouse grades the returned item, the refund processor pays for it.
package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	refundspb "returns/refundspb"
	warehousepb "returns/warehousepb"
)

const (
	gradeDeadline   = 3 * time.Second
	gradeAttempts   = 3
	gradeRetryDelay = 100 * time.Millisecond

	gradeDamaged       = "damaged"
	awaitingInspection = "awaiting-inspection"
)

const damagedRefundPercent = 50

var retryableGradeCodes = map[codes.Code]bool{codes.Unavailable: true, codes.DeadlineExceeded: true}
var terminalGradeCodes = map[codes.Code]bool{codes.InvalidArgument: true, codes.NotFound: true}

var errGradeRejected = errors.New("the warehouse refused to grade this line")

var warehouseConn, _ = grpc.NewClient("warehouse:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
var refundsConn, _ = grpc.NewClient("refunds:9001", grpc.WithTransportCredentials(insecure.NewCredentials()))

var warehouse = warehousepb.NewWarehouseClient(warehouseConn)
var refunds = refundspb.NewRefundsClient(refundsConn)

func setState(ctx context.Context, returnID, state string) error {
	return errors.New("not implemented")
}

/** The warehouse's verdict, or an empty grade when none arrived within the attempts. */
func gradeItem(ctx context.Context, orderLineID string, quantity int) (string, error) {
	req := &warehousepb.GradeItemRequest{OrderLineId: orderLineID, Quantity: uint32(quantity)}
	for attempt := 0; attempt < gradeAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, gradeDeadline)
		reply, err := warehouse.GradeItem(callCtx, req)
		cancel()
		if err == nil {
			// A verdict is an answer, not a failure: damaged is final and is never asked again.
			return reply.GetGrade(), nil
		}
		code := status.Code(err)
		if terminalGradeCodes[code] {
			return "", fmt.Errorf("%w: %s", errGradeRejected, code)
		}
		if !retryableGradeCodes[code] {
			return "", err
		}
		time.Sleep(gradeRetryDelay)
	}
	return "", nil
}

/** Policy: a sellable line is paid in full, a damaged one at the damaged percentage. */
func refundCentsFor(grade string, orderTotalCents, quantity int64) int64 {
	lineCents := orderTotalCents * quantity
	if grade == gradeDamaged {
		return lineCents * damagedRefundPercent / 100
	}
	return lineCents
}

func settleReturn(ctx context.Context, returnID, orderLineID string, quantity int, orderTotalCents int64) (string, error) {
	grade, err := gradeItem(ctx, orderLineID, quantity)
	if err != nil {
		return "", err
	}
	if grade == "" {
		// No verdict: hold the refund instead of paying for an inspection that never happened.
		if err := setState(ctx, returnID, awaitingInspection); err != nil {
			return "", err
		}
		return awaitingInspection, nil
	}
	amountCents := refundCentsFor(grade, orderTotalCents, int64(quantity))
	if _, err := refunds.IssueRefund(ctx, &refundspb.IssueRefundRequest{ReturnId: returnID, AmountCents: amountCents}); err != nil {
		return "", err
	}
	if err := setState(ctx, returnID, "refunded"); err != nil {
		return "", err
	}
	return "refunded", nil
}
`,
    },
    scala: {
      starter: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}
import returns.refunds.{IssueRefundRequest, RefundsGrpc}
import returns.warehouse.{GradeItemRequest, WarehouseGrpc}

object Settlement {
  val GradeDeadlineMillis = 3000L
  val GradeAttempts = 3
  val GradeSellable = "sellable"

  private val warehouseChannel = ManagedChannelBuilder.forAddress("warehouse", 9000).usePlaintext().build()
  private val refundsChannel = ManagedChannelBuilder.forAddress("refunds", 9001).usePlaintext().build()
  private val warehouse = WarehouseGrpc.blockingStub(warehouseChannel)
  private val refunds = RefundsGrpc.blockingStub(refundsChannel)

  def setState(returnId: String, state: String): Unit =
    throw new UnsupportedOperationException("not implemented")

  def settleReturn(returnId: String, orderLineId: String, quantity: Int, orderTotalCents: Long): String = {
    val request = GradeItemRequest(orderLineId = orderLineId, quantity = quantity)
    // TODO: the draft keeps asking until the grade is sellable and reads a timeout as "sellable",
    // so a warehouse outage refunds the customer in full without an inspection.
    var grade = ""
    var attempt = 0
    while (attempt < GradeAttempts && grade != GradeSellable) {
      attempt += 1
      try {
        grade = warehouse.withDeadlineAfter(GradeDeadlineMillis, TimeUnit.MILLISECONDS).gradeItem(request).grade
      } catch {
        case _: StatusRuntimeException => grade = GradeSellable
      }
    }
    val amountCents = orderTotalCents * quantity
    refunds.issueRefund(IssueRefundRequest(returnId = returnId, amountCents = amountCents))
    setState(returnId, "refunded")
    "refunded"
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}
import returns.refunds.{IssueRefundRequest, RefundsGrpc}
import returns.warehouse.{GradeItemRequest, WarehouseGrpc}

object Settlement {
  val GradeDeadlineMillis = 3000L
  val GradeAttempts = 3
  val GradeRetryDelayMillis = 100L
  val GradeDamaged = "damaged"
  val DamagedRefundPercent = 50L
  val AwaitingInspection = "awaiting-inspection"
  val RetryableGradeCodes = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)
  val TerminalGradeCodes = Set(Status.Code.INVALID_ARGUMENT, Status.Code.NOT_FOUND)

  final class GradeRejected(code: Status.Code) extends RuntimeException(s"the warehouse refused the grade: $code")

  private val warehouseChannel = ManagedChannelBuilder.forAddress("warehouse", 9000).usePlaintext().build()
  private val refundsChannel = ManagedChannelBuilder.forAddress("refunds", 9001).usePlaintext().build()
  private val warehouse = WarehouseGrpc.blockingStub(warehouseChannel)
  private val refunds = RefundsGrpc.blockingStub(refundsChannel)

  def setState(returnId: String, state: String): Unit =
    throw new UnsupportedOperationException("not implemented")

  /** The warehouse's verdict, or None when no grade arrived within the attempts. */
  def gradeItem(orderLineId: String, quantity: Int): Option[String] = {
    val request = GradeItemRequest(orderLineId = orderLineId, quantity = quantity)
    var attempt = 0
    while (attempt < GradeAttempts) {
      attempt += 1
      try {
        val reply = warehouse.withDeadlineAfter(GradeDeadlineMillis, TimeUnit.MILLISECONDS).gradeItem(request)
        // A verdict is an answer, not a failure: damaged is final and is never asked again.
        return Some(reply.grade)
      } catch {
        case e: StatusRuntimeException =>
          val code = e.getStatus.getCode
          if (TerminalGradeCodes.contains(code)) throw new GradeRejected(code)
          if (!RetryableGradeCodes.contains(code)) throw e
          Thread.sleep(GradeRetryDelayMillis)
      }
    }
    None
  }

  /** Policy: a sellable line is paid in full, a damaged one at the damaged percentage. */
  def refundCentsFor(grade: String, orderTotalCents: Long, quantity: Int): Long = {
    val lineCents = orderTotalCents * quantity
    if (grade == GradeDamaged) {
      lineCents * DamagedRefundPercent / 100
    } else {
      lineCents
    }
  }

  def settleReturn(returnId: String, orderLineId: String, quantity: Int, orderTotalCents: Long): String =
    gradeItem(orderLineId, quantity) match {
      case None =>
        // No verdict: hold the refund instead of paying for an inspection that never happened.
        setState(returnId, AwaitingInspection)
        AwaitingInspection
      case Some(grade) =>
        val amountCents = refundCentsFor(grade, orderTotalCents, quantity)
        refunds.issueRefund(IssueRefundRequest(returnId = returnId, amountCents = amountCents))
        setState(returnId, "refunded")
        "refunded"
    }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <cstdint>
#include <stdexcept>
#include <string>

#include "returns.grpc.pb.h"

constexpr std::chrono::milliseconds kGradeDeadline{3000};
constexpr int kGradeAttempts = 3;
const std::string kGradeSellable = "sellable";

auto warehouseChannel = grpc::CreateChannel("warehouse:9000", grpc::InsecureChannelCredentials());
auto refundsChannel = grpc::CreateChannel("refunds:9001", grpc::InsecureChannelCredentials());
auto warehouse = returns::Warehouse::NewStub(warehouseChannel);
auto refunds = returns::Refunds::NewStub(refundsChannel);

void setState(const std::string& returnId, const std::string& state) {
  throw std::runtime_error("not implemented");
}

std::string settleReturn(const std::string& returnId, const std::string& orderLineId, int quantity,
                         int64_t orderTotalCents) {
  returns::GradeItemRequest request;
  request.set_order_line_id(orderLineId);
  request.set_quantity(quantity);
  // TODO: the draft keeps asking until the grade is sellable and reads a timeout as "sellable",
  // so a warehouse outage refunds the customer in full without an inspection.
  std::string grade;
  for (int attempt = 0; attempt < kGradeAttempts && grade != kGradeSellable; ++attempt) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kGradeDeadline);
    returns::GradeItemReply reply;
    const grpc::Status status = warehouse->GradeItem(&ctx, request, &reply);
    if (!status.ok()) {
      grade = kGradeSellable;
      break;
    }
    grade = reply.grade();
  }
  returns::IssueRefundRequest refundRequest;
  refundRequest.set_return_id(returnId);
  refundRequest.set_amount_cents(orderTotalCents * quantity);
  grpc::ClientContext refundCtx;
  refundCtx.set_deadline(std::chrono::system_clock::now() + kGradeDeadline);
  returns::IssueRefundReply refundReply;
  if (!refunds->IssueRefund(&refundCtx, refundRequest, &refundReply).ok()) {
    throw std::runtime_error("the refund processor rejected the refund");
  }
  setState(returnId, "refunded");
  return "refunded";
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <cstdint>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>
#include <thread>

#include "returns.grpc.pb.h"

constexpr std::chrono::milliseconds kGradeDeadline{3000};
constexpr int kGradeAttempts = 3;
constexpr std::chrono::milliseconds kGradeRetryDelay{100};
constexpr int64_t kDamagedRefundPercent = 50;
const std::string kGradeDamaged = "damaged";
const std::string kAwaitingInspection = "awaiting-inspection";

const std::set<grpc::StatusCode> kRetryableGradeCodes = {grpc::StatusCode::UNAVAILABLE,
                                                         grpc::StatusCode::DEADLINE_EXCEEDED};
const std::set<grpc::StatusCode> kTerminalGradeCodes = {grpc::StatusCode::INVALID_ARGUMENT,
                                                        grpc::StatusCode::NOT_FOUND};

auto warehouseChannel = grpc::CreateChannel("warehouse:9000", grpc::InsecureChannelCredentials());
auto refundsChannel = grpc::CreateChannel("refunds:9001", grpc::InsecureChannelCredentials());
auto warehouse = returns::Warehouse::NewStub(warehouseChannel);
auto refunds = returns::Refunds::NewStub(refundsChannel);

void setState(const std::string& returnId, const std::string& state) {
  throw std::runtime_error("not implemented");
}

struct GradeRejected : std::runtime_error {
  explicit GradeRejected(const std::string& message) : std::runtime_error(message) {}
};

/** The warehouse's verdict, or nothing when no grade arrived within the attempts. */
std::optional<std::string> gradeItem(const std::string& orderLineId, int quantity) {
  returns::GradeItemRequest request;
  request.set_order_line_id(orderLineId);
  request.set_quantity(quantity);
  for (int attempt = 0; attempt < kGradeAttempts; ++attempt) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kGradeDeadline);
    returns::GradeItemReply reply;
    const grpc::Status status = warehouse->GradeItem(&ctx, request, &reply);
    if (status.ok()) {
      // A verdict is an answer, not a failure: damaged is final and is never asked again.
      return reply.grade();
    }
    const grpc::StatusCode code = status.error_code();
    if (kTerminalGradeCodes.count(code) > 0) throw GradeRejected("the warehouse refused the grade");
    if (kRetryableGradeCodes.count(code) == 0) throw std::runtime_error(status.error_message());
    std::this_thread::sleep_for(kGradeRetryDelay);
  }
  return std::nullopt;
}

/** Policy: a sellable line is paid in full, a damaged one at the damaged percentage. */
int64_t refundCentsFor(const std::string& grade, int64_t orderTotalCents, int quantity) {
  const int64_t lineCents = orderTotalCents * quantity;
  if (grade == kGradeDamaged) return lineCents * kDamagedRefundPercent / 100;
  return lineCents;
}

std::string settleReturn(const std::string& returnId, const std::string& orderLineId, int quantity,
                         int64_t orderTotalCents) {
  const auto grade = gradeItem(orderLineId, quantity);
  if (!grade.has_value()) {
    // No verdict: hold the refund instead of paying for an inspection that never happened.
    setState(returnId, kAwaitingInspection);
    return kAwaitingInspection;
  }
  returns::IssueRefundRequest refundRequest;
  refundRequest.set_return_id(returnId);
  refundRequest.set_amount_cents(refundCentsFor(*grade, orderTotalCents, quantity));
  grpc::ClientContext refundCtx;
  refundCtx.set_deadline(std::chrono::system_clock::now() + kGradeDeadline);
  returns::IssueRefundReply refundReply;
  if (!refunds->IssueRefund(&refundCtx, refundRequest, &refundReply).ok()) {
    throw std::runtime_error("the refund processor rejected the refund");
  }
  setState(returnId, "refunded");
  return "refunded";
}
`,
    },
  },
  hints: [
    'Set the deadline on the call, not around it: `timeout=GRADE_DEADLINE_S`, `{deadline: new Date(Date.now() + GRADE_DEADLINE_MS)}`, a context built with `context.WithTimeout`, `withDeadlineAfter(GradeDeadlineMillis, …)`, `set_deadline(now + kGradeDeadline)`. It belongs on every attempt, and a `sleep` afterwards is not a deadline.',
    'One bounded attempt loop with one status decision inside it: retryable (`UNAVAILABLE`, `DEADLINE_EXCEEDED`) → wait and try again; terminal (`INVALID_ARGUMENT`, `NOT_FOUND`) → fail; a reply → return the grade. A `damaged` verdict arrives as a *successful* reply, so it never reaches the retry branch.',
    'Decide the amount from the verdict before calling the processor: the full line value for `sellable`, the damaged percentage for `damaged`. If the loop ends without a grade, write `awaiting-inspection` and return — the refund call must not be reachable from that branch, and `refunded` is written only after the processor accepts.',
  ],
  debrief: `The interviewer is testing whether you can gate a side effect on somebody else’s verdict. A grade is an answer, so the refund is a consequence of it — which means three separate things have to hold: the call has a deadline, a timeout means *unknown* rather than *fine*, and only the transient statuses are worth asking again. The draft fails all three in one direction: it reads "no answer" as "nothing wrong", pays the customer in full, and keeps re-asking after a damaged verdict until the answer is convenient. Retrying a terminal status is the same mistake in the other direction — it burns the budget on a question whose answer cannot change. Production systems park the return in \`awaiting-inspection\` (a queue a human or a second inspection pass drains), classify statuses in one place so an idempotent retry is never accidental, and reconcile refunds against the processor instead of trusting the state they wrote locally.`,
};
