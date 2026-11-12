import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Inspection calls that gate refunds',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'warehouse', 'refunds'],
  task: `## Task

**Starting point.** The starter is \`settle_return(return_id)\`: it loads the return and its line
(\`store.return_of\`, \`store.line_of\`), asks \`Warehouse.GradeItem\` for a grade up to
\`MAX_ATTEMPTS\` (3) times with a \`GRADE_DEADLINE_S\` of 30 s, starting from \`sellable\` and asking
again until it hears \`sellable\`, then calls \`Refunds.IssueRefund\` for \`unit_price_cents ×
quantity\` and writes \`state\` \`refund_pending\`, \`grade\`, \`refund_cents\` and \`refund_id\`
(\`store.update_return\`). With a healthy warehouse it settles returns, and it hides four flaws.

**Failure mode the checks target.** A stalled warehouse holds each settlement for a minute and a
half; on the day the warehouse is down, every return is refunded in full without a grade; a dented
kettle is paid as new; and an item that has not arrived is asked about three times.

\`\`\`proto
service Warehouse { rpc GradeItem(GradeRequest) returns (GradeReply); }       // NOT_FOUND: not received
service Refunds   { rpc IssueRefund(RefundRequest) returns (RefundReply); }
\`\`\`

- \`GRADE_DEADLINE_S\` is **3 s** on every attempt.
- Only \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` are asked again; any other status, and any grade,
  ends the attempts.
- No grade after the attempts: write \`awaiting_inspection\`, return it, and call no refund.
- \`damaged\` pays \`DAMAGED_REFUND_PERCENT\` (50) of the line value; \`sellable\` pays all of it.`,
  sequence: {
    participants: ['Returns API', 'Warehouse', 'Refund processor', 'returns store'],
    messages: [
      {
        from: 'Returns API',
        to: 'Warehouse',
        label: 'GradeItem(return_id, sku, quantity) · deadline 3 s · ≤ 3 attempts',
        kind: 'sync',
      },
      {
        from: 'Warehouse',
        to: 'Returns API',
        label: 'sellable | damaged · NOT_FOUND ends it · UNAVAILABLE retried',
        kind: 'reply',
      },
      {from: 'Returns API', to: 'returns store', label: 'no grade → state awaiting_inspection', kind: 'sync'},
      {from: 'Returns API', to: 'Refund processor', label: 'IssueRefund(return_id, value × 100% | 50%)', kind: 'sync'},
      {from: 'Refund processor', to: 'Returns API', label: 'refund_id · initiated', kind: 'reply'},
      {
        from: 'Returns API',
        to: 'returns store',
        label: 'refund_pending · grade · refund_cents · refund_id',
        kind: 'sync',
      },
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every grade call carries a 3-second deadline',
      detail:
        'Each `GradeItem` attempt is made with `GRADE_DEADLINE_S` (3 s), so a stalled warehouse costs at most three short waits; the starter allows 30 s per attempt.',
      match: {
        python: {all: [/GRADE_DEADLINE_S\s*=\s*3\b/, /GradeItem\([\s\S]{0,200}?timeout\s*=\s*GRADE_DEADLINE_S/]},
        typescript: {
          all: [/GRADE_DEADLINE_MS\s*=\s*3_?000\b/, /GradeItem\([\s\S]{0,300}?deadline:[^\n]*GRADE_DEADLINE_MS/],
        },
        go: {all: [/gradeDeadline\s*=\s*3\s*\*\s*time\.Second/, /context\.WithTimeout\([^\n]*gradeDeadline\)/]},
        scala: {all: [/GradeDeadlineSeconds\s*=\s*3L?\b/, /withDeadlineAfter\(\s*GradeDeadlineSeconds/]},
        cpp: {all: [/kGradeDeadline\{3\}/, /set_deadline\([^\n]*kGradeDeadline\)/]},
      },
    },
    {
      id: 'hold-on-outage',
      title: 'No grade holds the return in awaiting_inspection',
      detail:
        'When the attempts end without a grade, the return is written `awaiting_inspection` and the refund processor is not called; the starter starts from `sellable`, so an outage pays every claim in full.',
      match: {
        python: {all: [/["']awaiting_inspection["']/], none: [/\bgrade\s*:?=\s*["']sellable["']/]},
        typescript: {all: [/["']awaiting_inspection["']/], none: [/\bgrade\s*:?=\s*["']sellable["']/]},
        go: {all: [/"awaiting_inspection"/], none: [/\bgrade\s*:?=\s*"sellable"/]},
        scala: {all: [/"awaiting_inspection"/], none: [/\bgrade\s*:?=\s*"sellable"/]},
        cpp: {all: [/"awaiting_inspection"/], none: [/\bgrade\s*:?=\s*"sellable"/]},
      },
    },
    {
      id: 'damaged-amount',
      title: 'A damaged grade pays half',
      detail:
        'The refund follows the grade: `sellable` pays `unit_price_cents × quantity`, `damaged` pays `DAMAGED_REFUND_PERCENT` (50) of it, both in the `IssueRefund` request and in `refund_cents`.',
      match: {
        python: {all: [/DAMAGED_REFUND_PERCENT/, /==\s*["']damaged["']/]},
        typescript: {all: [/DAMAGED_REFUND_PERCENT/, /===?\s*["']damaged["']/]},
        go: {all: [/damagedRefundPercent/, /==\s*"damaged"/]},
        scala: {all: [/DamagedRefundPercent/, /==\s*"damaged"/]},
        cpp: {all: [/kDamagedRefundPercent/, /==\s*"damaged"/]},
      },
    },
    {
      id: 'terminal-not-retried',
      title: 'Only UNAVAILABLE and DEADLINE_EXCEEDED are asked again',
      detail:
        'An attempt is repeated only for `UNAVAILABLE` or `DEADLINE_EXCEEDED`; `NOT_FOUND` and `INVALID_ARGUMENT` end the attempts, and so does any grade. The starter retries every error and asks again until the grade is `sellable`.',
      match: {
        python: {all: [/UNAVAILABLE/, /DEADLINE_EXCEEDED/], none: [/==\s*["']sellable["']/, /\bcontinue\b/]},
        typescript: {all: [/UNAVAILABLE/, /DEADLINE_EXCEEDED/], none: [/===?\s*["']sellable["']/, /\bcontinue;/]},
        go: {all: [/codes\.Unavailable/, /codes\.DeadlineExceeded/], none: [/==\s*"sellable"/, /\bcontinue\b/]},
        scala: {all: [/UNAVAILABLE/, /DEADLINE_EXCEEDED/], none: [/==\s*"sellable"/]},
        cpp: {all: [/UNAVAILABLE/, /DEADLINE_EXCEEDED/], none: [/==\s*"sellable"/, /\bcontinue;/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import returns_processing_pb2 as pb
import returns_processing_pb2_grpc as pb_grpc
from returns import store  # store.return_of, line_of, update_return

GRADE_DEADLINE_S = 30
REFUND_DEADLINE_S = 5
MAX_ATTEMPTS = 3

warehouse = pb_grpc.WarehouseStub(grpc.insecure_channel("warehouse:9000"))
refunds = pb_grpc.RefundsStub(grpc.insecure_channel("refunds:9000"))


def grade_item(ret: dict, line: dict) -> str:
    """The warehouse's grade of the returned item."""
    request = pb.GradeRequest(return_id=ret["return_id"], sku=line["sku"], quantity=ret["quantity"])
    grade = "sellable"
    for _ in range(MAX_ATTEMPTS):
        try:
            grade = warehouse.GradeItem(request, timeout=GRADE_DEADLINE_S).grade
        except grpc.RpcError:
            continue
        if grade == "sellable":
            break
    return grade


def settle_return(return_id: str) -> str:
    """Grade the returned item and request its refund; the state the return is left in."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    ret = store.return_of(return_id)
    line = store.line_of(ret["order_line_id"])
    grade = grade_item(ret, line)
    amount = line["unit_price_cents"] * ret["quantity"]
    reply = refunds.IssueRefund(pb.RefundRequest(return_id=return_id, amount_cents=amount), timeout=REFUND_DEADLINE_S)
    store.update_return(return_id, {"state": "refund_pending", "grade": grade, "refund_cents": amount, "refund_id": reply.refund_id})
    return "refund_pending"
`,
      solution: `import grpc

import returns_processing_pb2 as pb
import returns_processing_pb2_grpc as pb_grpc
from returns import store  # store.return_of, line_of, update_return

GRADE_DEADLINE_S = 3
REFUND_DEADLINE_S = 5
MAX_ATTEMPTS = 3
DAMAGED_REFUND_PERCENT = 50
# A restarting or slow warehouse may answer the next attempt; any other status will not change.
TRANSIENT = (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED)

warehouse = pb_grpc.WarehouseStub(grpc.insecure_channel("warehouse:9000"))
refunds = pb_grpc.RefundsStub(grpc.insecure_channel("refunds:9000"))


def grade_item(ret: dict, line: dict) -> str | None:
    """The warehouse's grade of the returned item, or None when no grade arrived."""
    request = pb.GradeRequest(return_id=ret["return_id"], sku=line["sku"], quantity=ret["quantity"])
    for _ in range(MAX_ATTEMPTS):
        try:
            return warehouse.GradeItem(request, timeout=GRADE_DEADLINE_S).grade
        except grpc.RpcError as exc:
            if exc.code() not in TRANSIENT:
                return None  # NOT_FOUND, INVALID_ARGUMENT: asking again gets the same answer
    return None


def refund_cents(line: dict, ret: dict, grade: str) -> int:
    value = line["unit_price_cents"] * ret["quantity"]
    return value * DAMAGED_REFUND_PERCENT // 100 if grade == "damaged" else value


def settle_return(return_id: str) -> str:
    """Grade the returned item and request its refund; the state the return is left in."""
    ret = store.return_of(return_id)
    line = store.line_of(ret["order_line_id"])
    grade = grade_item(ret, line)
    if grade is None:
        # Nobody has looked at the item: the money waits for the grade.
        store.update_return(return_id, {"state": "awaiting_inspection"})
        return "awaiting_inspection"
    amount = refund_cents(line, ret, grade)
    reply = refunds.IssueRefund(pb.RefundRequest(return_id=return_id, amount_cents=amount), timeout=REFUND_DEADLINE_S)
    store.update_return(return_id, {"state": "refund_pending", "grade": grade, "refund_cents": amount, "refund_id": reply.refund_id})
    return "refund_pending"
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {type OrderLine, type Return, lineOf, returnOf, updateReturn} from 'returns/store';

export const GRADE_DEADLINE_MS = 30_000;
export const REFUND_DEADLINE_MS = 5000;
export const MAX_ATTEMPTS = 3;

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('returns_processing.proto')) as unknown as {
  returnsd: {Warehouse: grpc.ServiceClientConstructor; Refunds: grpc.ServiceClientConstructor};
};
const warehouse = new pkg.returnsd.Warehouse('warehouse:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  GradeItem(
    request: {return_id: string; sku: string; quantity: number},
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
  ): Promise<{return_id: string; grade: string}>;
};
const refunds = new pkg.returnsd.Refunds('refunds:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  IssueRefund(
    request: {return_id: string; amount_cents: number},
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
  ): Promise<{refund_id: string; state: string}>;
};

/** The warehouse's grade of the returned item. */
async function gradeItem(ret: Return, line: OrderLine): Promise<string> {
  let grade = 'sellable';
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const reply = await warehouse.GradeItem({return_id: ret.return_id, sku: line.sku, quantity: ret.quantity}, new grpc.Metadata(), {
        deadline: Date.now() + GRADE_DEADLINE_MS,
      });
      grade = reply.grade;
    } catch {
      continue;
    }
    if (grade === 'sellable') break;
  }
  return grade;
}

/** Grade the returned item and request its refund; the state the return is left in. */
export async function settleReturn(returnId: string): Promise<string> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const ret = (await returnOf(returnId)) as Return;
  const line = (await lineOf(ret.order_line_id)) as OrderLine;
  const grade = await gradeItem(ret, line);
  const amount = line.unit_price_cents * ret.quantity;
  const reply = await refunds.IssueRefund({return_id: returnId, amount_cents: amount}, new grpc.Metadata(), {deadline: Date.now() + REFUND_DEADLINE_MS});
  await updateReturn(returnId, {state: 'refund_pending', grade, refund_cents: amount, refund_id: reply.refund_id});
  return 'refund_pending';
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {type OrderLine, type Return, lineOf, returnOf, updateReturn} from 'returns/store';

export const GRADE_DEADLINE_MS = 3000;
export const REFUND_DEADLINE_MS = 5000;
export const MAX_ATTEMPTS = 3;
export const DAMAGED_REFUND_PERCENT = 50;
// A restarting or slow warehouse may answer the next attempt; any other status will not change.
const TRANSIENT: number[] = [grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED];

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('returns_processing.proto')) as unknown as {
  returnsd: {Warehouse: grpc.ServiceClientConstructor; Refunds: grpc.ServiceClientConstructor};
};
const warehouse = new pkg.returnsd.Warehouse('warehouse:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  GradeItem(
    request: {return_id: string; sku: string; quantity: number},
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
  ): Promise<{return_id: string; grade: string}>;
};
const refunds = new pkg.returnsd.Refunds('refunds:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  IssueRefund(
    request: {return_id: string; amount_cents: number},
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
  ): Promise<{refund_id: string; state: string}>;
};

/** The warehouse's grade of the returned item, or null when no grade arrived. */
async function gradeItem(ret: Return, line: OrderLine): Promise<string | null> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const reply = await warehouse.GradeItem({return_id: ret.return_id, sku: line.sku, quantity: ret.quantity}, new grpc.Metadata(), {
        deadline: Date.now() + GRADE_DEADLINE_MS,
      });
      return reply.grade;
    } catch (e) {
      // NOT_FOUND, INVALID_ARGUMENT: asking again gets the same answer.
      if (!TRANSIENT.includes((e as grpc.ServiceError).code)) return null;
    }
  }
  return null;
}

function refundCents(line: OrderLine, ret: Return, grade: string): number {
  const value = line.unit_price_cents * ret.quantity;
  return grade === 'damaged' ? Math.floor((value * DAMAGED_REFUND_PERCENT) / 100) : value;
}

/** Grade the returned item and request its refund; the state the return is left in. */
export async function settleReturn(returnId: string): Promise<string> {
  const ret = (await returnOf(returnId)) as Return;
  const line = (await lineOf(ret.order_line_id)) as OrderLine;
  const grade = await gradeItem(ret, line);
  if (grade === null) {
    // Nobody has looked at the item: the money waits for the grade.
    await updateReturn(returnId, {state: 'awaiting_inspection'});
    return 'awaiting_inspection';
  }
  const amount = refundCents(line, ret, grade);
  const reply = await refunds.IssueRefund({return_id: returnId, amount_cents: amount}, new grpc.Metadata(), {deadline: Date.now() + REFUND_DEADLINE_MS});
  await updateReturn(returnId, {state: 'refund_pending', grade, refund_cents: amount, refund_id: reply.refund_id});
  return 'refund_pending';
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"fmt"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"returns/store" // store.ReturnOf, LineOf, UpdateReturn
	pb "returnsd/gen/returns_processing"
)

const (
	gradeDeadline  = 30 * time.Second
	refundDeadline = 5 * time.Second
	maxAttempts    = 3
)

var (
	warehouseConn, _ = grpc.NewClient("warehouse:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	refundsConn, _   = grpc.NewClient("refunds:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	warehouse        = pb.NewWarehouseClient(warehouseConn)
	refunds          = pb.NewRefundsClient(refundsConn)
)

// gradeItem is the warehouse's grade of the returned item.
func gradeItem(ctx context.Context, ret *store.Return, line *store.OrderLine) string {
	grade := "sellable"
	for attempt := 0; attempt < maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, gradeDeadline)
		reply, err := warehouse.GradeItem(callCtx, &pb.GradeRequest{ReturnId: ret.ReturnID, Sku: line.SKU, Quantity: ret.Quantity})
		cancel()
		if err != nil {
			continue
		}
		grade = reply.GetGrade()
		if grade == "sellable" {
			break
		}
	}
	return grade
}

// settleReturn grades the returned item and requests its refund; the state the return is left in.
func settleReturn(ctx context.Context, returnID string) (string, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	ret := store.ReturnOf(ctx, returnID)
	if ret == nil {
		return "", fmt.Errorf("no return %s", returnID)
	}
	line := store.LineOf(ctx, ret.OrderLineID)
	grade := gradeItem(ctx, ret, line)
	amount := line.UnitPriceCents * ret.Quantity
	callCtx, cancel := context.WithTimeout(ctx, refundDeadline)
	defer cancel()
	reply, err := refunds.IssueRefund(callCtx, &pb.RefundRequest{ReturnId: returnID, AmountCents: amount})
	if err != nil {
		return "", err
	}
	store.UpdateReturn(ctx, returnID, map[string]any{"state": "refund_pending", "grade": grade, "refund_cents": amount, "refund_id": reply.GetRefundId()})
	return "refund_pending", nil
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"returns/store" // store.ReturnOf, LineOf, UpdateReturn
	pb "returnsd/gen/returns_processing"
)

const (
	gradeDeadline        = 3 * time.Second
	refundDeadline       = 5 * time.Second
	maxAttempts          = 3
	damagedRefundPercent = 50
)

var (
	warehouseConn, _ = grpc.NewClient("warehouse:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	refundsConn, _   = grpc.NewClient("refunds:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	warehouse        = pb.NewWarehouseClient(warehouseConn)
	refunds          = pb.NewRefundsClient(refundsConn)
)

// gradeItem is the warehouse's grade of the returned item, or "" when no grade arrived.
func gradeItem(ctx context.Context, ret *store.Return, line *store.OrderLine) string {
	for attempt := 0; attempt < maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, gradeDeadline)
		reply, err := warehouse.GradeItem(callCtx, &pb.GradeRequest{ReturnId: ret.ReturnID, Sku: line.SKU, Quantity: ret.Quantity})
		cancel()
		if err == nil {
			return reply.GetGrade()
		}
		// A restarting or slow warehouse may answer the next attempt; NOT_FOUND or INVALID_ARGUMENT will not change.
		if code := status.Code(err); code != codes.Unavailable && code != codes.DeadlineExceeded {
			return ""
		}
	}
	return ""
}

func refundCents(line *store.OrderLine, ret *store.Return, grade string) int64 {
	value := line.UnitPriceCents * ret.Quantity
	if grade == "damaged" {
		return value * damagedRefundPercent / 100
	}
	return value
}

// settleReturn grades the returned item and requests its refund; the state the return is left in.
func settleReturn(ctx context.Context, returnID string) (string, error) {
	ret := store.ReturnOf(ctx, returnID)
	if ret == nil {
		return "", fmt.Errorf("no return %s", returnID)
	}
	line := store.LineOf(ctx, ret.OrderLineID)
	grade := gradeItem(ctx, ret, line)
	if grade == "" {
		// Nobody has looked at the item: the money waits for the grade.
		store.UpdateReturn(ctx, returnID, map[string]any{"state": "awaiting_inspection"})
		return "awaiting_inspection", nil
	}
	amount := refundCents(line, ret, grade)
	callCtx, cancel := context.WithTimeout(ctx, refundDeadline)
	defer cancel()
	reply, err := refunds.IssueRefund(callCtx, &pb.RefundRequest{ReturnId: returnID, AmountCents: amount})
	if err != nil {
		return "", err
	}
	store.UpdateReturn(ctx, returnID, map[string]any{"state": "refund_pending", "grade": grade, "refund_cents": amount, "refund_id": reply.GetRefundId()})
	return "refund_pending", nil
}
`,
    },
    scala: {
      starter: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import returns.Store // Store.returnOf, lineOf, updateReturn
import returnsd.returns_processing.{GradeRequest, RefundRequest, RefundsGrpc, WarehouseGrpc}

object Client {
  val GradeDeadlineSeconds = 30L
  val RefundDeadlineSeconds = 5L
  val MaxAttempts = 3

  private val warehouse = WarehouseGrpc.blockingStub(ManagedChannelBuilder.forAddress("warehouse", 9000).usePlaintext().build())
  private val refunds = RefundsGrpc.blockingStub(ManagedChannelBuilder.forAddress("refunds", 9000).usePlaintext().build())

  /** The warehouse's grade of the returned item. */
  def gradeItem(ret: Store.Return, line: Store.OrderLine): String = {
    val request = GradeRequest(returnId = ret.returnId, sku = line.sku, quantity = ret.quantity)
    var grade = "sellable"
    var attempt = 0
    var done = false
    while (attempt < MaxAttempts && !done) {
      attempt += 1
      try {
        grade = warehouse.withDeadlineAfter(GradeDeadlineSeconds, TimeUnit.SECONDS).gradeItem(request).grade
        done = grade == "sellable"
      } catch { case _: StatusRuntimeException => () }
    }
    grade
  }

  /** Grade the returned item and request its refund; the state the return is left in. */
  def settleReturn(returnId: String): String = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val ret = Store.returnOf(returnId).getOrElse(throw new NoSuchElementException(s"no return $returnId"))
    val line = Store.lineOf(ret.orderLineId).getOrElse(throw new NoSuchElementException(s"no order line \${ret.orderLineId}"))
    val grade = gradeItem(ret, line)
    val amount = line.unitPriceCents * ret.quantity
    val reply = refunds.withDeadlineAfter(RefundDeadlineSeconds, TimeUnit.SECONDS).issueRefund(RefundRequest(returnId = returnId, amountCents = amount))
    Store.updateReturn(returnId, Map("state" -> "refund_pending", "grade" -> grade, "refund_cents" -> amount.toString, "refund_id" -> reply.refundId))
    "refund_pending"
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import returns.Store // Store.returnOf, lineOf, updateReturn
import returnsd.returns_processing.{GradeRequest, RefundRequest, RefundsGrpc, WarehouseGrpc}

object Client {
  val GradeDeadlineSeconds = 3L
  val RefundDeadlineSeconds = 5L
  val MaxAttempts = 3
  val DamagedRefundPercent = 50L
  /** A restarting or slow warehouse may answer the next attempt; any other status will not change. */
  private val Transient = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)

  private val warehouse = WarehouseGrpc.blockingStub(ManagedChannelBuilder.forAddress("warehouse", 9000).usePlaintext().build())
  private val refunds = RefundsGrpc.blockingStub(ManagedChannelBuilder.forAddress("refunds", 9000).usePlaintext().build())

  /** The warehouse's grade of the returned item, or None when no grade arrived. */
  def gradeItem(ret: Store.Return, line: Store.OrderLine): Option[String] = {
    val request = GradeRequest(returnId = ret.returnId, sku = line.sku, quantity = ret.quantity)
    def attempt(n: Int): Option[String] =
      try Some(warehouse.withDeadlineAfter(GradeDeadlineSeconds, TimeUnit.SECONDS).gradeItem(request).grade)
      catch {
        case e: StatusRuntimeException if Transient.contains(e.getStatus.getCode) && n < MaxAttempts => attempt(n + 1)
        case _: StatusRuntimeException => None
      }
    attempt(1)
  }

  def refundCents(line: Store.OrderLine, ret: Store.Return, grade: String): Long = {
    val value = line.unitPriceCents * ret.quantity
    if (grade == "damaged") value * DamagedRefundPercent / 100 else value
  }

  /** Grade the returned item and request its refund; the state the return is left in. */
  def settleReturn(returnId: String): String = {
    val ret = Store.returnOf(returnId).getOrElse(throw new NoSuchElementException(s"no return $returnId"))
    val line = Store.lineOf(ret.orderLineId).getOrElse(throw new NoSuchElementException(s"no order line \${ret.orderLineId}"))
    gradeItem(ret, line) match {
      case None =>
        // Nobody has looked at the item: the money waits for the grade.
        Store.updateReturn(returnId, Map("state" -> "awaiting_inspection"))
        "awaiting_inspection"
      case Some(grade) =>
        val amount = refundCents(line, ret, grade)
        val reply = refunds.withDeadlineAfter(RefundDeadlineSeconds, TimeUnit.SECONDS).issueRefund(RefundRequest(returnId = returnId, amountCents = amount))
        Store.updateReturn(returnId, Map("state" -> "refund_pending", "grade" -> grade, "refund_cents" -> amount.toString, "refund_id" -> reply.refundId))
        "refund_pending"
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <stdexcept>
#include <string>

#include "returns/store.h"  // store::returnOf, lineOf, updateReturn
#include "returns_processing.grpc.pb.h"

constexpr std::chrono::seconds kGradeDeadline{30};
constexpr std::chrono::seconds kRefundDeadline{5};
constexpr int kMaxAttempts = 3;

auto warehouse = returnsd::Warehouse::NewStub(grpc::CreateChannel("warehouse:9000", grpc::InsecureChannelCredentials()));
auto refunds = returnsd::Refunds::NewStub(grpc::CreateChannel("refunds:9000", grpc::InsecureChannelCredentials()));

// The warehouse's grade of the returned item.
std::string gradeItem(const store::Return& ret, const store::OrderLine& line) {
  returnsd::GradeRequest request;
  request.set_return_id(ret.return_id);
  request.set_sku(line.sku);
  request.set_quantity(ret.quantity);
  std::string grade = "sellable";
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kGradeDeadline);
    returnsd::GradeReply reply;
    if (!warehouse->GradeItem(&ctx, request, &reply).ok()) continue;
    grade = reply.grade();
    if (grade == "sellable") break;
  }
  return grade;
}

// Grade the returned item and request its refund; the state the return is left in.
std::string settleReturn(const std::string& return_id) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const auto ret = store::returnOf(return_id);
  if (!ret) throw std::out_of_range("no return " + return_id);
  const auto line = store::lineOf(ret->order_line_id);
  if (!line) throw std::out_of_range("no order line " + ret->order_line_id);
  const std::string grade = gradeItem(*ret, *line);
  const long long amount = line->unit_price_cents * ret->quantity;
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kRefundDeadline);
  returnsd::RefundRequest request;
  request.set_return_id(return_id);
  request.set_amount_cents(amount);
  returnsd::RefundReply reply;
  const grpc::Status status = refunds->IssueRefund(&ctx, request, &reply);
  if (!status.ok()) throw std::runtime_error("refund processor: " + status.error_message());
  store::updateReturn(return_id, {{"state", "refund_pending"}, {"grade", grade}, {"refund_cents", std::to_string(amount)}, {"refund_id", reply.refund_id()}});
  return "refund_pending";
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <optional>
#include <stdexcept>
#include <string>

#include "returns/store.h"  // store::returnOf, lineOf, updateReturn
#include "returns_processing.grpc.pb.h"

constexpr std::chrono::seconds kGradeDeadline{3};
constexpr std::chrono::seconds kRefundDeadline{5};
constexpr int kMaxAttempts = 3;
constexpr long long kDamagedRefundPercent = 50;

auto warehouse = returnsd::Warehouse::NewStub(grpc::CreateChannel("warehouse:9000", grpc::InsecureChannelCredentials()));
auto refunds = returnsd::Refunds::NewStub(grpc::CreateChannel("refunds:9000", grpc::InsecureChannelCredentials()));

// The warehouse's grade of the returned item, or none when no grade arrived.
std::optional<std::string> gradeItem(const store::Return& ret, const store::OrderLine& line) {
  returnsd::GradeRequest request;
  request.set_return_id(ret.return_id);
  request.set_sku(line.sku);
  request.set_quantity(ret.quantity);
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kGradeDeadline);
    returnsd::GradeReply reply;
    const grpc::Status status = warehouse->GradeItem(&ctx, request, &reply);
    if (status.ok()) return reply.grade();
    // A restarting or slow warehouse may answer the next attempt; NOT_FOUND or INVALID_ARGUMENT will not change.
    if (status.error_code() != grpc::StatusCode::UNAVAILABLE && status.error_code() != grpc::StatusCode::DEADLINE_EXCEEDED) {
      return std::nullopt;
    }
  }
  return std::nullopt;
}

long long refundCents(const store::OrderLine& line, const store::Return& ret, const std::string& grade) {
  const long long value = line.unit_price_cents * ret.quantity;
  return grade == "damaged" ? value * kDamagedRefundPercent / 100 : value;
}

// Grade the returned item and request its refund; the state the return is left in.
std::string settleReturn(const std::string& return_id) {
  const auto ret = store::returnOf(return_id);
  if (!ret) throw std::out_of_range("no return " + return_id);
  const auto line = store::lineOf(ret->order_line_id);
  if (!line) throw std::out_of_range("no order line " + ret->order_line_id);
  const auto grade = gradeItem(*ret, *line);
  if (!grade) {
    // Nobody has looked at the item: the money waits for the grade.
    store::updateReturn(return_id, {{"state", "awaiting_inspection"}});
    return "awaiting_inspection";
  }
  const long long amount = refundCents(*line, *ret, *grade);
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kRefundDeadline);
  returnsd::RefundRequest request;
  request.set_return_id(return_id);
  request.set_amount_cents(amount);
  returnsd::RefundReply reply;
  const grpc::Status status = refunds->IssueRefund(&ctx, request, &reply);
  if (!status.ok()) throw std::runtime_error("refund processor: " + status.error_message());
  store::updateReturn(return_id, {{"state", "refund_pending"}, {"grade", *grade}, {"refund_cents", std::to_string(amount)}, {"refund_id", reply.refund_id()}});
  return "refund_pending";
}
`,
    },
  },
  harness: {
    python: `import grpc

import returns_processing_pb2 as pb
import returns_processing_pb2_grpc as pb_grpc
from returns import ledger, store


class Warehouse(pb_grpc.WarehouseServicer):
    """Grades every item sellable, except those in grades (return_id → grade); those in missing have not arrived."""

    def __init__(self):
        self.grades = {}
        self.missing = set()

    def GradeItem(self, request, context):
        if request.return_id in self.missing:
            context.abort(grpc.StatusCode.NOT_FOUND, f"{request.return_id} has not arrived at the warehouse")
        return pb.GradeReply(return_id=request.return_id, grade=self.grades.get(request.return_id, "sellable"))


class Refunds(pb_grpc.RefundsServicer):
    def IssueRefund(self, request, context):
        return pb.RefundReply(refund_id=f"rf-{request.return_id}", state="initiated")


def _world(ctx):
    warehouse = Warehouse()
    ctx.grpc.serve(pb_grpc.add_WarehouseServicer_to_server, warehouse)
    ctx.grpc.serve(pb_grpc.add_RefundsServicer_to_server, Refunds())
    store.put_line({
        "order_line_id": "L1", "tenant": "t-1", "sku": "KETTLE-2L", "ordered_quantity": 9, "unit_price_cents": 4000,
        "delivered_at": store.today(), "policy_window": "standard",
    })
    return ctx.load("client"), warehouse


def _return(return_id, quantity=1):
    ledger.register_return("L1", return_id, quantity, {"tenant": "t-1", "reason_code": "damaged", "photo_ref": "photos/kettle.jpg"})


def _calls(ctx, method, return_id):
    return [c for c in ctx.grpc.calls_to(method) if c.request.return_id == return_id]


def check_deadline(ctx):
    m, _ = _world(ctx)
    _return("ret-1")
    assert m.settle_return("ret-1") == "refund_pending", "with a healthy warehouse the return must move on to its refund"
    for call in ctx.grpc.calls_to("GradeItem"):
        assert call.timeout is not None, "a GradeItem call carries no deadline: a stalled warehouse holds the settlement open"
        assert 2.5 <= call.timeout <= 3.5, f"a GradeItem call carries a {call.timeout} s deadline, expected GRADE_DEADLINE_S = 3"
    _return("ret-2")
    ctx.grpc.set_latency("GradeItem", 60.0)
    before = ctx.clock.time()
    m.settle_return("ret-2")
    waited = ctx.clock.time() - before
    assert waited <= 10, f"settle_return waited {waited:.0f} s on a stalled warehouse: three attempts of 3 s each is the most it may spend"


def check_hold_on_outage(ctx):
    m, _ = _world(ctx)
    _return("ret-1")
    ctx.grpc.fail("GradeItem", grpc.StatusCode.UNAVAILABLE, times=3)
    state = m.settle_return("ret-1")
    paid = [c.request.amount_cents for c in _calls(ctx, "IssueRefund", "ret-1")]
    assert not paid, f"with the warehouse unavailable on every attempt the refund processor was asked to pay {paid}: an item nobody graded was refunded"
    assert state == "awaiting_inspection", f"with no grade settle_return answered {state!r}, expected awaiting_inspection"
    record = store.return_of("ret-1")
    assert record["state"] == "awaiting_inspection" and record["refund_id"] == "" and record["refund_cents"] == 0, f"the return holds {record}, expected state awaiting_inspection and no refund"
    _return("ret-2")
    ctx.grpc.fail("GradeItem", grpc.StatusCode.UNAVAILABLE, times=1)
    assert m.settle_return("ret-2") == "refund_pending", "after one UNAVAILABLE the next attempt gets the grade: the return must move on to its refund"
    assert len(_calls(ctx, "GradeItem", "ret-2")) == 2, f"one UNAVAILABLE then a grade took {len(_calls(ctx, 'GradeItem', 'ret-2'))} GradeItem calls, expected 2"


def check_damaged_amount(ctx):
    m, warehouse = _world(ctx)
    _return("ret-1", quantity=2)
    warehouse.grades["ret-1"] = "damaged"
    assert m.settle_return("ret-1") == "refund_pending", "a graded return must move on to its refund"
    paid = [c.request.amount_cents for c in _calls(ctx, "IssueRefund", "ret-1")]
    assert paid == [4000], f"a damaged return of 2 units at 4000 cents asked the refund processor for {paid}, expected [4000]: DAMAGED_REFUND_PERCENT (50) of the line value"
    record = store.return_of("ret-1")
    assert record["grade"] == "damaged" and record["refund_cents"] == 4000 and record["refund_id"] == "rf-ret-1", f"the return holds {record}, expected grade damaged, refund_cents 4000, refund_id rf-ret-1"
    _return("ret-2")
    m.settle_return("ret-2")
    record = store.return_of("ret-2")
    assert record["grade"] == "sellable" and record["refund_cents"] == 4000, f"a sellable return of 1 unit at 4000 cents holds {record}, expected the full 4000"


def check_terminal_not_retried(ctx):
    m, warehouse = _world(ctx)
    _return("ret-1")
    warehouse.missing.add("ret-1")
    state = m.settle_return("ret-1")
    asked = len(_calls(ctx, "GradeItem", "ret-1"))
    assert asked == 1, f"the warehouse answered NOT_FOUND (the item has not arrived) and was asked {asked} times: only UNAVAILABLE and DEADLINE_EXCEEDED are asked again"
    assert state == "awaiting_inspection", f"an item that has not arrived left the return {state!r}, expected awaiting_inspection"
    _return("ret-2")
    warehouse.grades["ret-2"] = "damaged"
    m.settle_return("ret-2")
    asked = len(_calls(ctx, "GradeItem", "ret-2"))
    assert asked == 1, f"the warehouse graded the item damaged and was asked {asked} times: a grade is an answer"
    _return("ret-3")
    ctx.grpc.fail("GradeItem", grpc.StatusCode.INVALID_ARGUMENT, times=3)
    m.settle_return("ret-3")
    asked = len(_calls(ctx, "GradeItem", "ret-3"))
    assert asked == 1, f"INVALID_ARGUMENT was asked again {asked - 1} times: the same request gets the same refusal"
`,
    typescript: `function world(ctx) {
  const pkg = ctx.proto('returns_processing.proto');
  const grades = new Map<string, string>();
  const missing = new Set<string>();
  ctx.grpc.serve(pkg.returnsd.Warehouse.service, {
    GradeItem(call, callback) {
      const {return_id} = call.request;
      if (missing.has(return_id)) return callback({code: ctx.grpc.status.NOT_FOUND, details: \`\${return_id} has not arrived at the warehouse\`});
      callback(null, {return_id, grade: grades.get(return_id) ?? 'sellable'});
    },
  });
  ctx.grpc.serve(pkg.returnsd.Refunds.service, {
    IssueRefund(call, callback) {
      callback(null, {refund_id: \`rf-\${call.request.return_id}\`, state: 'initiated'});
    },
  });
  const store = ctx.load('/support/returns/store.ts');
  const ledger = ctx.load('/support/returns/ledger.ts');
  const m = ctx.load('client');
  const ready = store.putLine({
    order_line_id: 'L1', tenant: 't-1', sku: 'KETTLE-2L', ordered_quantity: 9, unit_price_cents: 4000,
    delivered_at: store.today(), policy_window: 'standard',
  });
  const open = async (returnId: string, quantity = 1) => {
    await ready;
    await ledger.registerReturn('L1', returnId, quantity, {tenant: 't-1', reason_code: 'damaged', photo_ref: 'photos/kettle.jpg'});
  };
  return {m, store, grades, missing, open};
}

const calls = (ctx, method: string, returnId: string) => ctx.grpc.callsTo(method).filter(c => c.request.return_id === returnId);

export async function check_deadline(ctx) {
  const {m, open} = world(ctx);
  await open('ret-1');
  assert.equal(await m.settleReturn('ret-1'), 'refund_pending', 'with a healthy warehouse the return must move on to its refund');
  for (const call of ctx.grpc.callsTo('GradeItem')) {
    assert(call.timeout !== null, 'a GradeItem call carries no deadline: a stalled warehouse holds the settlement open');
    assert(2.5 <= call.timeout && call.timeout <= 3.5, \`a GradeItem call carries a \${call.timeout} s deadline, expected GRADE_DEADLINE_MS = 3000\`);
  }
  await open('ret-2');
  ctx.grpc.setLatency('GradeItem', 60.0);
  const before = ctx.clock.now();
  await m.settleReturn('ret-2');
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 10, \`settleReturn waited \${waited.toFixed(0)} s on a stalled warehouse: three attempts of 3 s each is the most it may spend\`);
}

export async function check_hold_on_outage(ctx) {
  const {m, store, open} = world(ctx);
  await open('ret-1');
  ctx.grpc.fail('GradeItem', ctx.grpc.status.UNAVAILABLE, '', 3);
  const state = await m.settleReturn('ret-1');
  const paid = calls(ctx, 'IssueRefund', 'ret-1').map(c => Number(c.request.amount_cents));
  assert.equal(paid.length, 0, \`with the warehouse unavailable on every attempt the refund processor was asked to pay \${JSON.stringify(paid)}: an item nobody graded was refunded\`);
  assert.equal(state, 'awaiting_inspection', \`with no grade settleReturn answered \${JSON.stringify(state)}, expected awaiting_inspection\`);
  const record = await store.returnOf('ret-1');
  assert(record.state === 'awaiting_inspection' && record.refund_id === '' && record.refund_cents === 0, \`the return holds \${JSON.stringify(record)}, expected state awaiting_inspection and no refund\`);
  await open('ret-2');
  ctx.grpc.fail('GradeItem', ctx.grpc.status.UNAVAILABLE, '', 1);
  assert.equal(await m.settleReturn('ret-2'), 'refund_pending', 'after one UNAVAILABLE the next attempt gets the grade: the return must move on to its refund');
  assert.equal(calls(ctx, 'GradeItem', 'ret-2').length, 2, 'one UNAVAILABLE then a grade must take 2 GradeItem calls');
}

export async function check_damaged_amount(ctx) {
  const {m, store, grades, open} = world(ctx);
  await open('ret-1', 2);
  grades.set('ret-1', 'damaged');
  assert.equal(await m.settleReturn('ret-1'), 'refund_pending', 'a graded return must move on to its refund');
  const paid = calls(ctx, 'IssueRefund', 'ret-1').map(c => Number(c.request.amount_cents));
  assert.deepStrictEqual(paid, [4000], \`a damaged return of 2 units at 4000 cents asked the refund processor for \${JSON.stringify(paid)}, expected [4000]: DAMAGED_REFUND_PERCENT (50) of the line value\`);
  let record = await store.returnOf('ret-1');
  assert(record.grade === 'damaged' && record.refund_cents === 4000 && record.refund_id === 'rf-ret-1', \`the return holds \${JSON.stringify(record)}, expected grade damaged, refund_cents 4000, refund_id rf-ret-1\`);
  await open('ret-2');
  await m.settleReturn('ret-2');
  record = await store.returnOf('ret-2');
  assert(record.grade === 'sellable' && record.refund_cents === 4000, \`a sellable return of 1 unit at 4000 cents holds \${JSON.stringify(record)}, expected the full 4000\`);
}

export async function check_terminal_not_retried(ctx) {
  const {m, grades, missing, open} = world(ctx);
  await open('ret-1');
  missing.add('ret-1');
  const state = await m.settleReturn('ret-1');
  let asked = calls(ctx, 'GradeItem', 'ret-1').length;
  assert.equal(asked, 1, \`the warehouse answered NOT_FOUND (the item has not arrived) and was asked \${asked} times: only UNAVAILABLE and DEADLINE_EXCEEDED are asked again\`);
  assert.equal(state, 'awaiting_inspection', \`an item that has not arrived left the return \${JSON.stringify(state)}, expected awaiting_inspection\`);
  await open('ret-2');
  grades.set('ret-2', 'damaged');
  await m.settleReturn('ret-2');
  asked = calls(ctx, 'GradeItem', 'ret-2').length;
  assert.equal(asked, 1, \`the warehouse graded the item damaged and was asked \${asked} times: a grade is an answer\`);
  await open('ret-3');
  ctx.grpc.fail('GradeItem', ctx.grpc.status.INVALID_ARGUMENT, '', 3);
  await m.settleReturn('ret-3');
  asked = calls(ctx, 'GradeItem', 'ret-3').length;
  assert.equal(asked, 1, \`INVALID_ARGUMENT was asked again \${asked - 1} times: the same request gets the same refusal\`);
}
`,
    go: `package main

import (
	"context"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"returns/ledger"
	"returns/store"
	pb "returnsd/gen/returns_processing"

	"leetbuild/harness"
)

var clientBg = context.Background()

// warehousePeer grades every item sellable, except those in grades; those in missing have not arrived.
type warehousePeer struct {
	pb.UnimplementedWarehouseServer
	grades  map[string]string
	missing map[string]bool
}

func (w *warehousePeer) GradeItem(_ context.Context, req *pb.GradeRequest) (*pb.GradeReply, error) {
	if w.missing[req.GetReturnId()] {
		return nil, status.Errorf(codes.NotFound, "%s has not arrived at the warehouse", req.GetReturnId())
	}
	grade := w.grades[req.GetReturnId()]
	if grade == "" {
		grade = "sellable"
	}
	return &pb.GradeReply{ReturnId: req.GetReturnId(), Grade: grade}, nil
}

type refundsPeer struct {
	pb.UnimplementedRefundsServer
}

func (refundsPeer) IssueRefund(_ context.Context, req *pb.RefundRequest) (*pb.RefundReply, error) {
	return &pb.RefundReply{RefundId: "rf-" + req.GetReturnId(), State: "initiated"}, nil
}

func clientWorld(ctx *harness.Ctx) *warehousePeer {
	w := &warehousePeer{grades: map[string]string{}, missing: map[string]bool{}}
	pb.RegisterWarehouseServer(ctx.GRPC.Server("warehouse:9000"), w)
	pb.RegisterRefundsServer(ctx.GRPC.Server("refunds:9000"), refundsPeer{})
	store.PutLine(clientBg, store.OrderLine{OrderLineID: "L1", Tenant: "t-1", SKU: "KETTLE-2L", OrderedQuantity: 9, UnitPriceCents: 4000, DeliveredAt: store.Today(), PolicyWindow: "standard"})
	return w
}

func clientOpen(ctx *harness.Ctx, returnID string, quantity int64) {
	_, err := ledger.RegisterReturn(clientBg, "L1", returnID, quantity, map[string]string{"tenant": "t-1", "reason_code": "damaged", "photo_ref": "photos/kettle.jpg"})
	ctx.NoError(err, "registering %s", returnID)
}

func clientSettle(ctx *harness.Ctx, returnID string) string {
	state, err := settleReturn(clientBg, returnID)
	ctx.NoError(err, "settleReturn(%s) failed", returnID)
	return state
}

func gradeCalls(ctx *harness.Ctx, returnID string) int {
	n := 0
	for _, c := range ctx.GRPC.CallsTo("GradeItem", "") {
		if c.Request.(*pb.GradeRequest).GetReturnId() == returnID {
			n++
		}
	}
	return n
}

func refundAmounts(ctx *harness.Ctx, returnID string) []int64 {
	var out []int64
	for _, c := range ctx.GRPC.CallsTo("IssueRefund", "") {
		if req := c.Request.(*pb.RefundRequest); req.GetReturnId() == returnID {
			out = append(out, req.GetAmountCents())
		}
	}
	return out
}

func CheckDeadline(ctx *harness.Ctx) {
	clientWorld(ctx)
	clientOpen(ctx, "ret-1", 1)
	ctx.Equal(clientSettle(ctx, "ret-1"), "refund_pending", "with a healthy warehouse the return must move on to its refund; the state")
	for _, call := range ctx.GRPC.CallsTo("GradeItem", "") {
		ctx.Assert(call.HasDeadline(), "a GradeItem call carries no deadline: a stalled warehouse holds the settlement open")
		ctx.Assert(call.Timeout.Seconds() >= 2.5 && call.Timeout.Seconds() <= 3.5, "a GradeItem call carries a %v deadline, expected gradeDeadline = 3 s", call.Timeout)
	}
	clientOpen(ctx, "ret-2", 1)
	ctx.GRPC.SetLatency("GradeItem", 60.0, "")
	before := ctx.Clock.Now()
	settleReturn(clientBg, "ret-2")
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 10, "settleReturn waited %.0f s on a stalled warehouse: three attempts of 3 s each is the most it may spend", waited)
}

func CheckHoldOnOutage(ctx *harness.Ctx) {
	clientWorld(ctx)
	clientOpen(ctx, "ret-1", 1)
	ctx.GRPC.Fail("GradeItem", codes.Unavailable, "", 3, "")
	state := clientSettle(ctx, "ret-1")
	paid := refundAmounts(ctx, "ret-1")
	ctx.Assert(len(paid) == 0, "with the warehouse unavailable on every attempt the refund processor was asked to pay %v: an item nobody graded was refunded", paid)
	ctx.Equal(state, "awaiting_inspection", "with no grade, settleReturn's state")
	record := store.ReturnOf(clientBg, "ret-1")
	ctx.Assert(record.State == "awaiting_inspection" && record.RefundID == "" && record.RefundCents == 0, "the return holds %+v, expected state awaiting_inspection and no refund", *record)
	clientOpen(ctx, "ret-2", 1)
	ctx.GRPC.Fail("GradeItem", codes.Unavailable, "", 1, "")
	ctx.Equal(clientSettle(ctx, "ret-2"), "refund_pending", "after one UNAVAILABLE the next attempt gets the grade: the return must move on to its refund; the state")
	ctx.Equal(gradeCalls(ctx, "ret-2"), 2, "one UNAVAILABLE then a grade; the GradeItem calls")
}

func CheckDamagedAmount(ctx *harness.Ctx) {
	w := clientWorld(ctx)
	clientOpen(ctx, "ret-1", 2)
	w.grades["ret-1"] = "damaged"
	ctx.Equal(clientSettle(ctx, "ret-1"), "refund_pending", "a graded return must move on to its refund; the state")
	ctx.Equal(refundAmounts(ctx, "ret-1"), []int64{4000}, "a damaged return of 2 units at 4000 cents must ask for DAMAGED_REFUND_PERCENT (50) of the line value; the IssueRefund amounts")
	record := store.ReturnOf(clientBg, "ret-1")
	ctx.Assert(record.Grade == "damaged" && record.RefundCents == 4000 && record.RefundID == "rf-ret-1", "the return holds %+v, expected grade damaged, refund_cents 4000, refund_id rf-ret-1", *record)
	clientOpen(ctx, "ret-2", 1)
	clientSettle(ctx, "ret-2")
	record = store.ReturnOf(clientBg, "ret-2")
	ctx.Assert(record.Grade == "sellable" && record.RefundCents == 4000, "a sellable return of 1 unit at 4000 cents holds %+v, expected the full 4000", *record)
}

func CheckTerminalNotRetried(ctx *harness.Ctx) {
	w := clientWorld(ctx)
	clientOpen(ctx, "ret-1", 1)
	w.missing["ret-1"] = true
	state := clientSettle(ctx, "ret-1")
	ctx.Equal(gradeCalls(ctx, "ret-1"), 1, "the warehouse answered NOT_FOUND (the item has not arrived): only UNAVAILABLE and DEADLINE_EXCEEDED are asked again; the GradeItem calls")
	ctx.Equal(state, "awaiting_inspection", "an item that has not arrived; the state")
	clientOpen(ctx, "ret-2", 1)
	w.grades["ret-2"] = "damaged"
	clientSettle(ctx, "ret-2")
	ctx.Equal(gradeCalls(ctx, "ret-2"), 1, "the warehouse graded the item damaged, and a grade is an answer; the GradeItem calls")
	clientOpen(ctx, "ret-3", 1)
	ctx.GRPC.Fail("GradeItem", codes.InvalidArgument, "", 3, "")
	clientSettle(ctx, "ret-3")
	ctx.Equal(gradeCalls(ctx, "ret-3"), 1, "INVALID_ARGUMENT: the same request gets the same refusal; the GradeItem calls")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <map>
#include <set>
#include <string>
#include <vector>

#include "returns/ledger.h"
#include "returns/store.h"

namespace {

// Grades every item sellable, except those in grades; those in missing have not arrived.
class WarehousePeer final : public returnsd::Warehouse::Service {
 public:
  std::map<std::string, std::string> grades;
  std::set<std::string> missing;
  grpc::Status GradeItem(grpc::ServerContext*, const returnsd::GradeRequest* req, returnsd::GradeReply* out) override {
    if (missing.count(req->return_id())) return grpc::Status(grpc::StatusCode::NOT_FOUND, req->return_id() + " has not arrived at the warehouse");
    out->set_return_id(req->return_id());
    out->set_grade(grades.count(req->return_id()) ? grades[req->return_id()] : "sellable");
    return grpc::Status::OK;
  }
};

class RefundsPeer final : public returnsd::Refunds::Service {
 public:
  grpc::Status IssueRefund(grpc::ServerContext*, const returnsd::RefundRequest* req, returnsd::RefundReply* out) override {
    out->set_refund_id("rf-" + req->return_id());
    out->set_state("initiated");
    return grpc::Status::OK;
  }
};

struct Peers {
  WarehousePeer warehouse;
  RefundsPeer refunds;
};

WarehousePeer& world(harness::Ctx& ctx) {
  static Peers* peers = nullptr;
  delete peers;
  peers = new Peers;
  ctx.GRPC.Server("warehouse:9000")->RegisterService(&peers->warehouse);
  ctx.GRPC.Server("refunds:9000")->RegisterService(&peers->refunds);
  store::putLine(store::OrderLine{"L1", "t-1", "KETTLE-2L", 9, 4000, store::today(), "standard"});
  return peers->warehouse;
}

void open(const std::string& return_id, long long quantity = 1) {
  ledger::registerReturn("L1", return_id, quantity, {{"tenant", "t-1"}, {"reason_code", "damaged"}, {"photo_ref", "photos/kettle.jpg"}});
}

std::string settle(harness::Ctx& ctx, const std::string& return_id) {
  try {
    return settleReturn(return_id);
  } catch (const std::exception& e) {
    ctx.Fatalf("settleReturn(%s) threw %s: %s", return_id, harness::CurrentExceptionType(), e.what());
  }
  return "";
}

int gradeCalls(harness::Ctx& ctx, const std::string& return_id) {
  int n = 0;
  for (const auto& c : ctx.GRPC.CallsTo("GradeItem")) {
    if (c.Request<returnsd::GradeRequest>().return_id() == return_id) n++;
  }
  return n;
}

std::vector<long long> refundAmounts(harness::Ctx& ctx, const std::string& return_id) {
  std::vector<long long> out;
  for (const auto& c : ctx.GRPC.CallsTo("IssueRefund")) {
    const auto req = c.Request<returnsd::RefundRequest>();
    if (req.return_id() == return_id) out.push_back(req.amount_cents());
  }
  return out;
}

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  world(ctx);
  open("ret-1");
  ctx.Equal(settle(ctx, "ret-1"), "refund_pending", "with a healthy warehouse the return must move on to its refund; the state");
  for (const auto& call : ctx.GRPC.CallsTo("GradeItem")) {
    ctx.Assert(call.HasDeadline(), "a GradeItem call carries no deadline: a stalled warehouse holds the settlement open");
    ctx.Assert(2.5 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 3.5, "a GradeItem call carries a %v s deadline, expected kGradeDeadline = 3 s", call.TimeoutSeconds());
  }
  open("ret-2");
  ctx.GRPC.SetLatency("GradeItem", 60.0);
  const int64_t before = ctx.Clock.Now();
  try {
    settleReturn("ret-2");
  } catch (const std::exception&) {
  }
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 10, "settleReturn waited %.0f s on a stalled warehouse: three attempts of 3 s each is the most it may spend", waited);
}

void CheckHoldOnOutage(harness::Ctx& ctx) {
  world(ctx);
  open("ret-1");
  ctx.GRPC.Fail("GradeItem", grpc::StatusCode::UNAVAILABLE, "", 3);
  const std::string state = settle(ctx, "ret-1");
  const auto paid = refundAmounts(ctx, "ret-1");
  ctx.Assert(paid.empty(), "with the warehouse unavailable on every attempt the refund processor was asked to pay %v: an item nobody graded was refunded", paid);
  ctx.Equal(state, "awaiting_inspection", "with no grade, settleReturn's state");
  const auto record = store::returnOf("ret-1");
  ctx.Assert(record->state == "awaiting_inspection" && record->refund_id.empty() && record->refund_cents == 0, "the return holds state %q, refund_id %q, refund_cents %d, expected awaiting_inspection and no refund", record->state, record->refund_id, record->refund_cents);
  open("ret-2");
  ctx.GRPC.Fail("GradeItem", grpc::StatusCode::UNAVAILABLE, "", 1);
  ctx.Equal(settle(ctx, "ret-2"), "refund_pending", "after one UNAVAILABLE the next attempt gets the grade: the return must move on to its refund; the state");
  ctx.Equal(gradeCalls(ctx, "ret-2"), 2, "one UNAVAILABLE then a grade; the GradeItem calls");
}

void CheckDamagedAmount(harness::Ctx& ctx) {
  WarehousePeer& warehouse = world(ctx);
  open("ret-1", 2);
  warehouse.grades["ret-1"] = "damaged";
  ctx.Equal(settle(ctx, "ret-1"), "refund_pending", "a graded return must move on to its refund; the state");
  ctx.Equal(refundAmounts(ctx, "ret-1"), std::vector<long long>{4000}, "a damaged return of 2 units at 4000 cents must ask for DAMAGED_REFUND_PERCENT (50) of the line value; the IssueRefund amounts");
  auto record = store::returnOf("ret-1");
  ctx.Assert(record->grade == "damaged" && record->refund_cents == 4000 && record->refund_id == "rf-ret-1", "the return holds grade %q, refund_cents %d, refund_id %q, expected damaged, 4000, rf-ret-1", record->grade, record->refund_cents, record->refund_id);
  open("ret-2");
  settle(ctx, "ret-2");
  record = store::returnOf("ret-2");
  ctx.Assert(record->grade == "sellable" && record->refund_cents == 4000, "a sellable return of 1 unit at 4000 cents holds grade %q and refund_cents %d, expected the full 4000", record->grade, record->refund_cents);
}

void CheckTerminalNotRetried(harness::Ctx& ctx) {
  WarehousePeer& warehouse = world(ctx);
  open("ret-1");
  warehouse.missing.insert("ret-1");
  const std::string state = settle(ctx, "ret-1");
  ctx.Equal(gradeCalls(ctx, "ret-1"), 1, "the warehouse answered NOT_FOUND (the item has not arrived): only UNAVAILABLE and DEADLINE_EXCEEDED are asked again; the GradeItem calls");
  ctx.Equal(state, "awaiting_inspection", "an item that has not arrived; the state");
  open("ret-2");
  warehouse.grades["ret-2"] = "damaged";
  settle(ctx, "ret-2");
  ctx.Equal(gradeCalls(ctx, "ret-2"), 1, "the warehouse graded the item damaged, and a grade is an answer; the GradeItem calls");
  open("ret-3");
  ctx.GRPC.Fail("GradeItem", grpc::StatusCode::INVALID_ARGUMENT, "", 3);
  settle(ctx, "ret-3");
  ctx.Equal(gradeCalls(ctx, "ret-3"), 1, "INVALID_ARGUMENT: the same request gets the same refusal; the GradeItem calls");
}
`,
  },
  hints: [
    'Take the warehouse down and settle a return: it is refunded in full within seconds. Grade one damaged: the warehouse is asked three times and the refund is the full price.',
    'The grade starts as `sellable` and the loop retries every error, then asks again until it hears `sellable`; the amount never looks at the grade, and each attempt may wait 30 s.',
    'Set `GRADE_DEADLINE_S = 3`; return the first grade; on an error return None unless the code is UNAVAILABLE or DEADLINE_EXCEEDED; None → `awaiting_inspection`, no refund; `damaged` → 50%.',
  ],
  debrief: `The client's job is to keep three outcomes apart: a grade (an answer, even when it is bad news), a refusal that will not change (\`NOT_FOUND\`, \`INVALID_ARGUMENT\`), and a failure that might (\`UNAVAILABLE\`, \`DEADLINE_EXCEEDED\`). Only the last earns another attempt, and the 3-second deadline caps what those attempts cost. Starting from "no grade" rather than "sellable" is what turns an outage into a held return instead of a payout. Production returns systems make the hold visible: an \`awaiting_inspection\` return goes to a queue that re-asks the warehouse with backoff, the refund call carries the return id as an idempotency key so a retried settlement pays once, and the grade percentages live per category in the refund policy.`,
};
