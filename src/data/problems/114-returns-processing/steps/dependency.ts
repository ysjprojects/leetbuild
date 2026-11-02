import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Inspection calls that gate refunds',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'warehouse', 'refunds'],
  task: `## Task

**Starting point.** The starter's \`settle_return\` calls \`Warehouse.GradeItem(order_line_id,
quantity)\` with a 3-second deadline in a loop of up to 3 attempts, then calls
\`Refunds.IssueRefund\` for the full line value and writes \`refunded\`. It compiles, serves the
demo, and hides 4 flaws.

**Failure mode the checks target.** On the day the warehouse goes down, every return settles in
full within seconds: the customer is paid for an item nobody graded, and a damaged item that was
graded is paid as if it were sellable.

- \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` are **transient**: retry them, bounded at **3
  attempts**. \`INVALID_ARGUMENT\` and \`NOT_FOUND\` are **terminal**: asking again gets the same
  refusal. A \`damaged\` verdict is an answer, not a failure, and is not asked for again.
- When no grade arrives, the return is written as \`awaiting-inspection\` and the refund processor
  is **not called**.
- The amount follows the grade: \`sellable\` refunds the full line value
  (\`order_total_cents * quantity\`), \`damaged\` refunds **50%** of it.
- The refund is requested **only after a grade arrives**, and \`refunded\` is written once the
  processor accepts the refund: the state records what happened, not what was attempted.`,
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
        'When the attempts end without a grade — a slow warehouse gives `DEADLINE_EXCEEDED` — the return is written as `awaiting-inspection` and the refund is held. The starter assumes the item is sellable, so the same outage pays an unverified claim in full.',
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
        'The refund is computed from the verdict: `sellable` refunds the whole line value (`order_total_cents * quantity`), `damaged` refunds the damaged percentage (50%) of it. The starter ignores the grade and always pays the full line.',
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
        'The attempt loop is bounded and continues only for the transient statuses (`UNAVAILABLE`, `DEADLINE_EXCEEDED`); `INVALID_ARGUMENT` and `NOT_FOUND` leave it as failures, and a `damaged` verdict ends it with an answer. The starter loops until the grade is `sellable`, so a damaged item is inspected again and a terminal refusal is retried.',
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
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
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
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
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
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
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
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
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
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
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
    'Finance sees a spike of full refunds during the warehouse outage, and items graded damaged are refunded at the sellable price.',
    'The `except grpc.RpcError` branch sets `grade = sellable`, the loop condition retries anything that is not `sellable`, and the amount is computed before the grade is looked at.',
    'Classify the status: retryable codes continue, terminal codes fail, a reply ends the loop. No grade: `set_state(return_id, AWAITING_INSPECTION)` and return. Otherwise compute the amount from the grade, call `IssueRefund`, then write `refunded`.',
  ],
  debrief: `The fix gates a side effect on somebody else's verdict. A timeout means *unknown*, not *fine*, so the no-grade branch parks the return and returns before the processor call is reachable; that ordering is what the checks pin down. The status decision lives in one place: the transient codes are worth asking again, the terminal ones are not, and a successful reply ends the loop whatever the grade says, so a damaged item is paid at the damaged rate instead of being inspected until the answer is convenient. What this step leaves out: a queue that a human or a second inspection pass drains for returns left in \`awaiting-inspection\`, backoff with jitter between attempts, and a reconciliation of local \`refunded\` rows against the processor's ledger.`,
};
