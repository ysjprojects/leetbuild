import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Warehouse confirmation: a deadline, one id per reservation, a hold kept on silence',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'warehouse', 'redis'],
  task: `## Task

**Starting point.** The starter is \`confirm_reservation(reservation)\`, called once a reservation is
stored: it calls \`Warehouse.ConfirmReservation\` at \`warehouse:9000\` with a fresh id, the sku and
the quantity, tries twice on any error, and on success runs \`stock.confirm\` and records
\`confirmed\`; when both attempts fail it runs \`stock.release\` and records \`rejected\`. It serves the
demo and hides four flaws.

\`\`\`proto
service Warehouse {
  rpc ConfirmReservation(ConfirmRequest) returns (ConfirmReply);  // one allocation per reservation_id
}
\`\`\`

**Failure mode the checks target.** A warehouse that answers in 1.5 seconds, a connection dropped
once, a warehouse that never answers, and one that refuses the reservation for good.

- Every attempt carries a **2 s** deadline.
- At most \`MAX_CONFIRM_ATTEMPTS = 2\` attempts, each with the reservation's own \`reservation_id\`.
- Only \`DEADLINE_EXCEEDED\` and \`UNAVAILABLE\` are retried. When no attempt was answered the
  warehouse may have allocated: record **\`pending\`**, keep the hold, return \`"pending"\`.
- \`FAILED_PRECONDITION\` is a verdict: one call, \`stock.release\`, record and return \`"rejected"\`.`,
  sequence: {
    participants: ['Inventory API', 'Warehouse', 'Redis'],
    messages: [
      {
        from: 'Inventory API',
        to: 'Warehouse',
        label: 'ConfirmReservation(reservation_id, sku, qty) · 2 s',
        kind: 'sync',
      },
      {from: 'Warehouse', to: 'Inventory API', label: 'confirmation_id', kind: 'reply'},
      {from: 'Inventory API', to: 'Redis', label: 'stock.confirm · status confirmed', kind: 'sync'},
      {from: 'Inventory API', to: 'Warehouse', label: 'UNAVAILABLE / DEADLINE_EXCEEDED → retry, same id', kind: 'sync'},
      {
        from: 'Inventory API',
        to: 'Inventory API',
        label: 'no answer after 2 attempts → pending, hold kept',
        kind: 'sync',
      },
      {from: 'Warehouse', to: 'Inventory API', label: 'FAILED_PRECONDITION', kind: 'reply'},
      {from: 'Inventory API', to: 'Redis', label: 'stock.release · status rejected', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Bounds every attempt with a 2 s deadline',
      detail:
        'A warehouse that answers in 1.5 s confirms the reservation, and the call carries a deadline of about 2 s. The starter sends no deadline, so a hung warehouse holds the request open.',
      match: {
        python: {all: [/stub\.ConfirmReservation\([\s\S]{0,200}?timeout\s*=\s*(CONFIRM_DEADLINE_S|2(\.0)?)\b/]},
        typescript: {
          all: [/\.ConfirmReservation\([\s\S]{0,200}?deadline:\s*Date\.now\(\)\s*\+\s*(CONFIRM_DEADLINE_MS|2000)\b/],
        },
        go: {
          all: [/context\.WithTimeout\([^\n]*(confirmDeadline|2\s*\*\s*time\.Second|2000\s*\*\s*time\.Millisecond)/],
        },
        scala: {all: [/withDeadlineAfter\(\s*(ConfirmDeadlineMs|2000L?|2L?\s*,\s*TimeUnit\.SECONDS)/]},
        cpp: {
          all: [
            /set_deadline\([^\n]*(kConfirmDeadline|std::chrono::seconds[({]\s*2\s*[)}]|std::chrono::milliseconds[({]\s*2000\s*[)}])/,
          ],
        },
      },
    },
    {
      id: 'retry-same-id',
      title: "Retries with the reservation's own id",
      detail:
        'A warehouse that is UNAVAILABLE once gets two calls, both carrying the reservation id, so it allocates once. The starter mints a new id per attempt.',
      match: {
        python: {all: [/reservation_id\s*=\s*reservation\[["']reservation_id["']\]/], none: [/new_id\(/]},
        typescript: {all: [/reservation_id:\s*reservation\.reservation_id/], none: [/newId\(/]},
        go: {all: [/ReservationId:\s*(r|reservation)\.ReservationID/], none: [/store\.NewID\(/]},
        scala: {all: [/reservationId\s*=\s*reservation\.reservation_id/], none: [/Store\.newId\(/]},
        cpp: {all: [/set_reservation_id\(\s*(r|reservation)\.reservation_id\s*\)/], none: [/NewId\(/]},
      },
    },
    {
      id: 'unanswered-pending',
      title: 'Keeps the hold and records pending when the warehouse never answers',
      detail:
        'A warehouse that stays UNAVAILABLE gets two calls; the reservation ends `pending`, its hold and its units untouched. The starter releases the units the warehouse may already have allocated.',
      match: {
        python: {all: [/["']pending["']/, /UNAVAILABLE/]},
        typescript: {all: [/['"]pending['"]/, /UNAVAILABLE/]},
        go: {all: [/"pending"/, /codes\.Unavailable/]},
        scala: {all: [/"pending"/, /UNAVAILABLE/]},
        cpp: {all: [/"pending"/, /UNAVAILABLE/]},
      },
    },
    {
      id: 'rejection-final',
      title: 'Takes FAILED_PRECONDITION as final: one call, the hold released',
      detail:
        'A warehouse that cannot fill the reservation gets one call; the units go back to the counter once and the reservation is `rejected`. The starter asks again.',
      match: {
        python: {all: [/FAILED_PRECONDITION/, /stock\.release\(/, /["']rejected["']/]},
        typescript: {all: [/FAILED_PRECONDITION/, /\brelease\(/, /['"]rejected['"]/]},
        go: {all: [/codes\.FailedPrecondition/, /stock\.Release\(/, /"rejected"/]},
        scala: {all: [/FAILED_PRECONDITION/, /Stock\.release\(/, /"rejected"/]},
        cpp: {all: [/FAILED_PRECONDITION/, /stock::Release\(/, /"rejected"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import inventory_service_pb2
import inventory_service_pb2_grpc
from inventory import stock  # stock.confirm, release
from inventory.store import new_id, store

MAX_CONFIRM_ATTEMPTS = 2

channel = grpc.insecure_channel("warehouse:9000")
stub = inventory_service_pb2_grpc.WarehouseStub(channel)


def confirm_reservation(reservation: dict) -> str:
    """Ask the warehouse to allocate the reservation's units; returns the final status."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    sku, reservation_id = reservation["sku"], reservation["reservation_id"]
    for _ in range(MAX_CONFIRM_ATTEMPTS):
        request = inventory_service_pb2.ConfirmRequest(reservation_id=new_id(), sku=sku, quantity=reservation["quantity"])
        try:
            stub.ConfirmReservation(request)
        except grpc.RpcError:
            continue
        stock.confirm(sku, reservation_id)
        store.set_status(reservation_id, "confirmed")
        return "confirmed"
    stock.release(sku, reservation_id)
    store.set_status(reservation_id, "rejected")
    return "rejected"
`,
      solution: `import grpc

import inventory_service_pb2
import inventory_service_pb2_grpc
from inventory import stock  # stock.confirm, release
from inventory.store import store

CONFIRM_DEADLINE_S = 2
MAX_CONFIRM_ATTEMPTS = 2
RETRYABLE = (grpc.StatusCode.DEADLINE_EXCEEDED, grpc.StatusCode.UNAVAILABLE)
REFUSED = (grpc.StatusCode.FAILED_PRECONDITION, grpc.StatusCode.INVALID_ARGUMENT)

channel = grpc.insecure_channel("warehouse:9000")
stub = inventory_service_pb2_grpc.WarehouseStub(channel)


def confirm_reservation(reservation: dict) -> str:
    """Ask the warehouse to allocate the reservation's units; returns the final status."""
    sku, reservation_id = reservation["sku"], reservation["reservation_id"]
    # The reservation id is the warehouse's idempotency id: a retry must carry the same one.
    request = inventory_service_pb2.ConfirmRequest(
        reservation_id=reservation["reservation_id"], sku=sku, quantity=reservation["quantity"]
    )
    for _ in range(MAX_CONFIRM_ATTEMPTS):
        try:
            stub.ConfirmReservation(request, timeout=CONFIRM_DEADLINE_S)
        except grpc.RpcError as exc:
            if exc.code() in RETRYABLE:
                continue
            if exc.code() in REFUSED:
                # A verdict on this reservation: asking again cannot change it, the units go back now.
                stock.release(sku, reservation_id)
                store.set_status(reservation_id, "rejected")
                return "rejected"
            raise
        stock.confirm(sku, reservation_id)
        store.set_status(reservation_id, "confirmed")
        return "confirmed"
    # No attempt was answered: the warehouse may have allocated, so the hold stays and the
    # reservation waits for reconciliation instead of handing its units to the next buyer.
    store.set_status(reservation_id, "pending")
    return "pending"
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {confirm, release} from 'inventory/stock';
import {type Reservation, newId, store} from 'inventory/store';

export const MAX_CONFIRM_ATTEMPTS = 2;

interface ConfirmRequest {
  reservation_id: string;
  sku: string;
  quantity: number;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('inventory_service.proto')) as unknown as {
  inventoryd: {Warehouse: grpc.ServiceClientConstructor};
};
const stub = new pkg.inventoryd.Warehouse('warehouse:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  ConfirmReservation(request: ConfirmRequest, options: grpc.CallOptions): Promise<{confirmation_id: string}>;
};

/** Ask the warehouse to allocate the reservation's units; resolves to the final status. */
export async function confirmReservation(reservation: Reservation): Promise<string> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const {sku, reservation_id: reservationId} = reservation;
  for (let attempt = 0; attempt < MAX_CONFIRM_ATTEMPTS; attempt++) {
    try {
      await stub.ConfirmReservation({reservation_id: newId(), sku, quantity: reservation.quantity}, {});
    } catch {
      continue;
    }
    await confirm(sku, reservationId);
    await store.setStatus(reservationId, 'confirmed');
    return 'confirmed';
  }
  await release(sku, reservationId);
  await store.setStatus(reservationId, 'rejected');
  return 'rejected';
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {confirm, release} from 'inventory/stock';
import {type Reservation, store} from 'inventory/store';

export const CONFIRM_DEADLINE_MS = 2000;
export const MAX_CONFIRM_ATTEMPTS = 2;
const RETRYABLE = [grpc.status.DEADLINE_EXCEEDED, grpc.status.UNAVAILABLE];
const REFUSED = [grpc.status.FAILED_PRECONDITION, grpc.status.INVALID_ARGUMENT];

interface ConfirmRequest {
  reservation_id: string;
  sku: string;
  quantity: number;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('inventory_service.proto')) as unknown as {
  inventoryd: {Warehouse: grpc.ServiceClientConstructor};
};
const stub = new pkg.inventoryd.Warehouse('warehouse:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  ConfirmReservation(request: ConfirmRequest, options: grpc.CallOptions): Promise<{confirmation_id: string}>;
};

/** Ask the warehouse to allocate the reservation's units; resolves to the final status. */
export async function confirmReservation(reservation: Reservation): Promise<string> {
  const {sku, reservation_id: reservationId} = reservation;
  // The reservation id is the warehouse's idempotency id: a retry must carry the same one.
  const request = {reservation_id: reservation.reservation_id, sku, quantity: reservation.quantity};
  for (let attempt = 0; attempt < MAX_CONFIRM_ATTEMPTS; attempt++) {
    try {
      await stub.ConfirmReservation(request, {deadline: Date.now() + CONFIRM_DEADLINE_MS});
    } catch (err) {
      const code = (err as grpc.ServiceError).code;
      if (RETRYABLE.includes(code)) continue;
      if (REFUSED.includes(code)) {
        // A verdict on this reservation: asking again cannot change it, the units go back now.
        await release(sku, reservationId);
        await store.setStatus(reservationId, 'rejected');
        return 'rejected';
      }
      throw err;
    }
    await confirm(sku, reservationId);
    await store.setStatus(reservationId, 'confirmed');
    return 'confirmed';
  }
  // No attempt was answered: the warehouse may have allocated, so the hold stays and the
  // reservation waits for reconciliation instead of handing its units to the next buyer.
  await store.setStatus(reservationId, 'pending');
  return 'pending';
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "inventory/gen/inventory_service"
	"inventory/stock" // stock.Confirm, Release
	"inventory/store"
)

const maxConfirmAttempts = 2

var conn, _ = grpc.NewClient("warehouse:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewWarehouseClient(conn)

// confirmReservation asks the warehouse to allocate the reservation's units and returns the final status.
func confirmReservation(ctx context.Context, r *store.Reservation) (string, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	for attempt := 0; attempt < maxConfirmAttempts; attempt++ {
		request := &pb.ConfirmRequest{ReservationId: store.NewID(), Sku: r.SKU, Quantity: int32(r.Quantity)}
		if _, err := stub.ConfirmReservation(ctx, request); err != nil {
			continue
		}
		if _, err := stock.Confirm(ctx, r.SKU, r.ReservationID); err != nil {
			return "", err
		}
		return "confirmed", store.SetStatus(ctx, r.ReservationID, "confirmed")
	}
	if _, err := stock.Release(ctx, r.SKU, r.ReservationID); err != nil {
		return "", err
	}
	return "rejected", store.SetStatus(ctx, r.ReservationID, "rejected")
}
`,
      solution: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "inventory/gen/inventory_service"
	"inventory/stock" // stock.Confirm, Release
	"inventory/store"
)

const (
	confirmDeadline    = 2 * time.Second
	maxConfirmAttempts = 2
)

var conn, _ = grpc.NewClient("warehouse:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewWarehouseClient(conn)

func retryable(code codes.Code) bool { return code == codes.DeadlineExceeded || code == codes.Unavailable }

func refused(code codes.Code) bool { return code == codes.FailedPrecondition || code == codes.InvalidArgument }

// confirmAttempt is one call to the warehouse under its own deadline.
func confirmAttempt(ctx context.Context, request *pb.ConfirmRequest) error {
	ctx, cancel := context.WithTimeout(ctx, confirmDeadline)
	defer cancel()
	_, err := stub.ConfirmReservation(ctx, request)
	return err
}

// confirmReservation asks the warehouse to allocate the reservation's units and returns the final status.
func confirmReservation(ctx context.Context, r *store.Reservation) (string, error) {
	// The reservation id is the warehouse's idempotency id: a retry must carry the same one.
	request := &pb.ConfirmRequest{ReservationId: r.ReservationID, Sku: r.SKU, Quantity: int32(r.Quantity)}
	for attempt := 0; attempt < maxConfirmAttempts; attempt++ {
		err := confirmAttempt(ctx, request)
		if err == nil {
			if _, err := stock.Confirm(ctx, r.SKU, r.ReservationID); err != nil {
				return "", err
			}
			return "confirmed", store.SetStatus(ctx, r.ReservationID, "confirmed")
		}
		code := status.Code(err)
		if retryable(code) {
			continue
		}
		if refused(code) {
			// A verdict on this reservation: asking again cannot change it, the units go back now.
			if _, err := stock.Release(ctx, r.SKU, r.ReservationID); err != nil {
				return "", err
			}
			return "rejected", store.SetStatus(ctx, r.ReservationID, "rejected")
		}
		return "", err
	}
	// No attempt was answered: the warehouse may have allocated, so the hold stays and the
	// reservation waits for reconciliation instead of handing its units to the next buyer.
	return "pending", store.SetStatus(ctx, r.ReservationID, "pending")
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import inventory.{Reservation, Stock, Store} // Stock.confirm, release; Store.setStatus
import inventoryd.inventory_service.{ConfirmRequest, WarehouseGrpc}

object Client {
  val MaxConfirmAttempts = 2

  private val channel = ManagedChannelBuilder.forAddress("warehouse", 9000).usePlaintext().build()
  private val stub = WarehouseGrpc.blockingStub(channel)

  /** Ask the warehouse to allocate the reservation's units; returns the final status. */
  def confirmReservation(reservation: Reservation): String = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    var attempt = 0
    while (attempt < MaxConfirmAttempts) {
      attempt += 1
      try {
        stub.confirmReservation(ConfirmRequest(reservationId = Store.newId(), sku = reservation.sku, quantity = reservation.quantity))
        Stock.confirm(reservation.sku, reservation.reservation_id)
        Store.setStatus(reservation.reservation_id, "confirmed")
        return "confirmed"
      } catch {
        case _: StatusRuntimeException => ()
      }
    }
    Stock.release(reservation.sku, reservation.reservation_id)
    Store.setStatus(reservation.reservation_id, "rejected")
    "rejected"
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import inventory.{Reservation, Stock, Store} // Stock.confirm, release; Store.setStatus
import inventoryd.inventory_service.{ConfirmRequest, WarehouseGrpc}

object Client {
  val ConfirmDeadlineMs = 2000L
  val MaxConfirmAttempts = 2
  private val Retryable = Set(Status.Code.DEADLINE_EXCEEDED, Status.Code.UNAVAILABLE)
  private val Refused = Set(Status.Code.FAILED_PRECONDITION, Status.Code.INVALID_ARGUMENT)

  private val channel = ManagedChannelBuilder.forAddress("warehouse", 9000).usePlaintext().build()
  private val stub = WarehouseGrpc.blockingStub(channel)

  /** Ask the warehouse to allocate the reservation's units; returns the final status. */
  def confirmReservation(reservation: Reservation): String = {
    // The reservation id is the warehouse's idempotency id: a retry must carry the same one.
    val request = ConfirmRequest(reservationId = reservation.reservation_id, sku = reservation.sku, quantity = reservation.quantity)
    var attempt = 0
    while (attempt < MaxConfirmAttempts) {
      attempt += 1
      try {
        stub.withDeadlineAfter(ConfirmDeadlineMs, TimeUnit.MILLISECONDS).confirmReservation(request)
        Stock.confirm(reservation.sku, reservation.reservation_id)
        Store.setStatus(reservation.reservation_id, "confirmed")
        return "confirmed"
      } catch {
        case e: StatusRuntimeException if Retryable(e.getStatus.getCode) => ()
        case e: StatusRuntimeException if Refused(e.getStatus.getCode) =>
          // A verdict on this reservation: asking again cannot change it, the units go back now.
          Stock.release(reservation.sku, reservation.reservation_id)
          Store.setStatus(reservation.reservation_id, "rejected")
          return "rejected"
      }
    }
    // No attempt was answered: the warehouse may have allocated, so the hold stays and the
    // reservation waits for reconciliation instead of handing its units to the next buyer.
    Store.setStatus(reservation.reservation_id, "pending")
    "pending"
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <string>

#include "inventory/stock.h"  // stock::Confirm, Release
#include "inventory/store.h"  // store::SetStatus; NewId
#include "inventory_service.grpc.pb.h"

constexpr int kMaxConfirmAttempts = 2;

auto channel = grpc::CreateChannel("warehouse:9000", grpc::InsecureChannelCredentials());
auto stub = inventoryd::Warehouse::NewStub(channel);

// Ask the warehouse to allocate the reservation's units; returns the final status.
std::string confirmReservation(const inventory::Reservation& r) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  for (int attempt = 0; attempt < kMaxConfirmAttempts; attempt++) {
    grpc::ClientContext ctx;
    inventoryd::ConfirmRequest request;
    request.set_reservation_id(inventory::NewId());
    request.set_sku(r.sku);
    request.set_quantity(r.quantity);
    inventoryd::ConfirmReply reply;
    if (!stub->ConfirmReservation(&ctx, request, &reply).ok()) continue;
    inventory::stock::Confirm(r.sku, r.reservation_id);
    inventory::store::SetStatus(r.reservation_id, "confirmed");
    return "confirmed";
  }
  inventory::stock::Release(r.sku, r.reservation_id);
  inventory::store::SetStatus(r.reservation_id, "rejected");
  return "rejected";
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <stdexcept>
#include <string>

#include "inventory/stock.h"  // stock::Confirm, Release
#include "inventory/store.h"  // store::SetStatus; NewId
#include "inventory_service.grpc.pb.h"

constexpr std::chrono::milliseconds kConfirmDeadline{2000};
constexpr int kMaxConfirmAttempts = 2;

auto channel = grpc::CreateChannel("warehouse:9000", grpc::InsecureChannelCredentials());
auto stub = inventoryd::Warehouse::NewStub(channel);

static bool retryable(grpc::StatusCode code) {
  return code == grpc::StatusCode::DEADLINE_EXCEEDED || code == grpc::StatusCode::UNAVAILABLE;
}

static bool refused(grpc::StatusCode code) {
  return code == grpc::StatusCode::FAILED_PRECONDITION || code == grpc::StatusCode::INVALID_ARGUMENT;
}

// Ask the warehouse to allocate the reservation's units; returns the final status.
std::string confirmReservation(const inventory::Reservation& r) {
  // The reservation id is the warehouse's idempotency id: a retry must carry the same one.
  inventoryd::ConfirmRequest request;
  request.set_reservation_id(r.reservation_id);
  request.set_sku(r.sku);
  request.set_quantity(r.quantity);
  for (int attempt = 0; attempt < kMaxConfirmAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kConfirmDeadline);
    inventoryd::ConfirmReply reply;
    const grpc::Status status = stub->ConfirmReservation(&ctx, request, &reply);
    if (status.ok()) {
      inventory::stock::Confirm(r.sku, r.reservation_id);
      inventory::store::SetStatus(r.reservation_id, "confirmed");
      return "confirmed";
    }
    if (retryable(status.error_code())) continue;
    if (refused(status.error_code())) {
      // A verdict on this reservation: asking again cannot change it, the units go back now.
      inventory::stock::Release(r.sku, r.reservation_id);
      inventory::store::SetStatus(r.reservation_id, "rejected");
      return "rejected";
    }
    throw std::runtime_error(status.error_message());
  }
  // No attempt was answered: the warehouse may have allocated, so the hold stays and the
  // reservation waits for reconciliation instead of handing its units to the next buyer.
  inventory::store::SetStatus(r.reservation_id, "pending");
  return "pending";
}
`,
    },
  },
  harness: {
    python: `import grpc

import inventory_service_pb2
import inventory_service_pb2_grpc
from inventory.store import store

RESERVATION = {
    "reservation_id": "r-1",
    "tenant": "t1",
    "idempotency_key": "k-1",
    "sku": "sku-1",
    "quantity": 3,
    "status": "reserved",
    "expires_at": 0,
}


class FakeWarehouse(inventory_service_pb2_grpc.WarehouseServicer):
    """One allocation per reservation id."""

    def __init__(self):
        self.allocations = {}

    def ConfirmReservation(self, request, context):
        confirmation = self.allocations.setdefault(request.reservation_id, f"c-{len(self.allocations) + 1}")
        return inventory_service_pb2.ConfirmReply(confirmation_id=confirmation)


def _world(ctx):
    """A stored reservation of 3 units holding them in Redis, and the warehouse the harness serves."""
    warehouse = FakeWarehouse()
    ctx.grpc.serve(inventory_service_pb2_grpc.add_WarehouseServicer_to_server, warehouse)
    ctx.redis.set("stock:sku-1", 7)
    ctx.redis.hset("holds:sku-1", "r-1", 3)
    ctx.redis.set("hold:r-1", 3, ex=900)
    store.put(dict(RESERVATION))
    return ctx.load("client"), warehouse


def _status(ctx):
    return ctx.redis.hget("reservation:r-1", "status")


def _units(ctx):
    return int(ctx.redis.get("stock:sku-1"))


def check_deadline(ctx):
    m, warehouse = _world(ctx)
    ctx.grpc.set_latency("ConfirmReservation", 1.5)
    result = m.confirm_reservation(dict(RESERVATION))
    assert result == "confirmed", f"a warehouse that answers in 1.5 s ended the reservation {result!r}, expected confirmed"
    call = ctx.grpc.calls_to("ConfirmReservation")[0]
    assert call.timeout is not None, "ConfirmReservation carries no deadline: a warehouse that hangs holds the request, and the buyer, open"
    assert 1.5 <= call.timeout <= 2.5, f"the ConfirmReservation deadline is {call.timeout} s, expected about 2 s"
    assert _status(ctx) == "confirmed", f"the stored reservation's status is {_status(ctx)!r}, expected confirmed"
    assert ctx.redis.hget("holds:sku-1", "r-1") is None and _units(ctx) == 7, f"after the confirmation holds:sku-1 is {ctx.redis.hgetall('holds:sku-1')} and stock:sku-1 {_units(ctx)}: the hold must become a sale"


def check_retry_same_id(ctx):
    m, warehouse = _world(ctx)
    ctx.grpc.fail("ConfirmReservation", grpc.StatusCode.UNAVAILABLE, "warehouse restarting", times=1)
    result = m.confirm_reservation(dict(RESERVATION))
    assert result == "confirmed", f"a warehouse that was UNAVAILABLE once ended the reservation {result!r}, expected confirmed after a retry"
    ids = [c.request.reservation_id for c in ctx.grpc.calls_to("ConfirmReservation")]
    assert ids == ["r-1", "r-1"], f"the attempts carried reservation ids {ids}, expected r-1 on both: the warehouse allocates once per id, a new id is a second allocation"


def check_unanswered_pending(ctx):
    m, warehouse = _world(ctx)
    ctx.grpc.fail("ConfirmReservation", grpc.StatusCode.UNAVAILABLE, "warehouse down", times=5)
    result = m.confirm_reservation(dict(RESERVATION))
    calls = len(ctx.grpc.calls_to("ConfirmReservation"))
    assert calls == 2, f"a warehouse that stays UNAVAILABLE got {calls} calls, expected MAX_CONFIRM_ATTEMPTS = 2"
    assert result == "pending", f"no attempt was answered and the reservation ended {result!r}: the warehouse may have allocated, so it is pending"
    assert _status(ctx) == "pending", f"the stored reservation's status is {_status(ctx)!r}, expected pending"
    assert ctx.redis.hget("holds:sku-1", "r-1") == "3" and ctx.redis.exists("hold:r-1") == 1, "the hold of a pending reservation was dropped: its units may already be allocated in the warehouse"
    assert _units(ctx) == 7, f"stock:sku-1 is {_units(ctx)}: a pending reservation's units must not go back to the counter"


def check_rejection_final(ctx):
    m, warehouse = _world(ctx)
    ctx.grpc.fail("ConfirmReservation", grpc.StatusCode.FAILED_PRECONDITION, "not enough units in the warehouse", times=5)
    result = m.confirm_reservation(dict(RESERVATION))
    calls = len(ctx.grpc.calls_to("ConfirmReservation"))
    assert calls == 1, f"FAILED_PRECONDITION is a verdict, and the warehouse was asked {calls} times"
    assert result == "rejected", f"confirm_reservation returned {result!r}, expected rejected"
    assert _units(ctx) == 10 and ctx.redis.hgetall("holds:sku-1") == {}, f"after the refusal stock:sku-1 is {_units(ctx)} and holds:sku-1 {ctx.redis.hgetall('holds:sku-1')}: the 3 units go back once"
    assert _status(ctx) == "rejected", f"the stored reservation's status is {_status(ctx)!r}, expected rejected"
`,
    typescript: `import {store} from 'inventory/store';

const RESERVATION = {
  reservation_id: 'r-1',
  tenant: 't1',
  idempotency_key: 'k-1',
  sku: 'sku-1',
  quantity: 3,
  status: 'reserved',
  expires_at: 0,
};

/** A stored reservation of 3 units holding them in Redis, and the warehouse the harness serves: one allocation per reservation id. */
async function world(ctx) {
  const allocations = new Map<string, string>();
  const pkg = ctx.proto('inventory_service.proto');
  ctx.grpc.serve(pkg.inventoryd.Warehouse.service, {
    ConfirmReservation(call, callback) {
      const id = call.request.reservation_id;
      if (!allocations.has(id)) allocations.set(id, \`c-\${allocations.size + 1}\`);
      callback(null, {confirmation_id: allocations.get(id)});
    },
  });
  ctx.redis.set('stock:sku-1', '7');
  ctx.redis.hset('holds:sku-1', 'r-1', '3');
  ctx.redis.set('hold:r-1', '3', 'EX', 900);
  await store.put({...RESERVATION});
  return ctx.load('client');
}

const status = ctx => ctx.redis.hget('reservation:r-1', 'status');
const units = (ctx): number => Number(ctx.redis.get('stock:sku-1'));

export async function check_deadline(ctx) {
  const m = await world(ctx);
  ctx.grpc.setLatency('ConfirmReservation', 1.5);
  const result = await m.confirmReservation({...RESERVATION});
  assert.equal(result, 'confirmed', \`a warehouse that answers in 1.5 s ended the reservation \${JSON.stringify(result)}, expected confirmed\`);
  const call = ctx.grpc.callsTo('ConfirmReservation')[0];
  assert(call.timeout !== null, 'ConfirmReservation carries no deadline: a warehouse that hangs holds the request, and the buyer, open');
  assert(1.5 <= call.timeout && call.timeout <= 2.5, \`the ConfirmReservation deadline is \${call.timeout} s, expected about 2 s\`);
  assert.equal(status(ctx), 'confirmed', \`the stored reservation's status is \${status(ctx)}, expected confirmed\`);
  assert(ctx.redis.hget('holds:sku-1', 'r-1') === null && units(ctx) === 7, \`after the confirmation holds:sku-1 is \${JSON.stringify(ctx.redis.hgetall('holds:sku-1'))} and stock:sku-1 \${units(ctx)}: the hold must become a sale\`);
}

export async function check_retry_same_id(ctx) {
  const m = await world(ctx);
  ctx.grpc.fail('ConfirmReservation', ctx.grpc.status.UNAVAILABLE, 'warehouse restarting', 1);
  const result = await m.confirmReservation({...RESERVATION});
  assert.equal(result, 'confirmed', \`a warehouse that was UNAVAILABLE once ended the reservation \${JSON.stringify(result)}, expected confirmed after a retry\`);
  const ids = ctx.grpc.callsTo('ConfirmReservation').map(c => c.request.reservation_id);
  assert.deepEqual(ids, ['r-1', 'r-1'], \`the attempts carried reservation ids \${JSON.stringify(ids)}, expected r-1 on both: the warehouse allocates once per id, a new id is a second allocation\`);
}

export async function check_unanswered_pending(ctx) {
  const m = await world(ctx);
  ctx.grpc.fail('ConfirmReservation', ctx.grpc.status.UNAVAILABLE, 'warehouse down', 5);
  const result = await m.confirmReservation({...RESERVATION});
  const calls = ctx.grpc.callsTo('ConfirmReservation').length;
  assert.equal(calls, 2, \`a warehouse that stays UNAVAILABLE got \${calls} calls, expected MAX_CONFIRM_ATTEMPTS = 2\`);
  assert.equal(result, 'pending', \`no attempt was answered and the reservation ended \${JSON.stringify(result)}: the warehouse may have allocated, so it is pending\`);
  assert.equal(status(ctx), 'pending', \`the stored reservation's status is \${status(ctx)}, expected pending\`);
  assert(ctx.redis.hget('holds:sku-1', 'r-1') === '3' && ctx.redis.exists('hold:r-1') === 1, 'the hold of a pending reservation was dropped: its units may already be allocated in the warehouse');
  assert.equal(units(ctx), 7, \`stock:sku-1 is \${units(ctx)}: a pending reservation's units must not go back to the counter\`);
}

export async function check_rejection_final(ctx) {
  const m = await world(ctx);
  ctx.grpc.fail('ConfirmReservation', ctx.grpc.status.FAILED_PRECONDITION, 'not enough units in the warehouse', 5);
  const result = await m.confirmReservation({...RESERVATION});
  const calls = ctx.grpc.callsTo('ConfirmReservation').length;
  assert.equal(calls, 1, \`FAILED_PRECONDITION is a verdict, and the warehouse was asked \${calls} times\`);
  assert.equal(result, 'rejected', \`confirmReservation resolved \${JSON.stringify(result)}, expected rejected\`);
  assert(units(ctx) === 10 && Object.keys(ctx.redis.hgetall('holds:sku-1')).length === 0, \`after the refusal stock:sku-1 is \${units(ctx)} and holds:sku-1 \${JSON.stringify(ctx.redis.hgetall('holds:sku-1'))}: the 3 units go back once\`);
  assert.equal(status(ctx), 'rejected', \`the stored reservation's status is \${status(ctx)}, expected rejected\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"time"

	"google.golang.org/grpc/codes"

	"leetbuild/harness"

	pb "inventory/gen/inventory_service"
	"inventory/store"
)

var clientReservation = store.Reservation{
	ReservationID: "r-1", Tenant: "t1", IdempotencyKey: "k-1", SKU: "sku-1", Quantity: 3, Status: "reserved",
}

// warehousePeer keeps one allocation per reservation id.
type warehousePeer struct {
	pb.UnimplementedWarehouseServer
	allocations map[string]string
}

func (w *warehousePeer) ConfirmReservation(_ context.Context, req *pb.ConfirmRequest) (*pb.ConfirmReply, error) {
	if _, ok := w.allocations[req.GetReservationId()]; !ok {
		w.allocations[req.GetReservationId()] = fmt.Sprintf("c-%d", len(w.allocations)+1)
	}
	return &pb.ConfirmReply{ConfirmationId: w.allocations[req.GetReservationId()]}, nil
}

// clientWorld is a stored reservation of 3 units holding them in Redis, and the warehouse the harness serves.
func clientWorld(ctx *harness.Ctx) {
	pb.RegisterWarehouseServer(ctx.GRPC.Server(""), &warehousePeer{allocations: map[string]string{}})
	ctx.Redis.Set("stock:sku-1", 7)
	ctx.Redis.Do("HSET", "holds:sku-1", "r-1", 3)
	ctx.Redis.Set("hold:r-1", 3, "EX", 900)
	r := clientReservation
	ctx.NoError(store.Put(context.Background(), &r), "storing the reservation")
}

func clientConfirm(ctx *harness.Ctx) string {
	r := clientReservation
	result, err := confirmReservation(context.Background(), &r)
	ctx.NoError(err, "confirmReservation")
	return result
}

func clientStatus(ctx *harness.Ctx) string {
	status, _ := ctx.Redis.HGet("reservation:r-1", "status")
	return status
}

func clientUnits(ctx *harness.Ctx) string {
	units, _ := ctx.Redis.Get("stock:sku-1")
	return units
}

func CheckDeadline(ctx *harness.Ctx) {
	clientWorld(ctx)
	ctx.GRPC.SetLatency("ConfirmReservation", 1.5, "")
	ctx.Equal(clientConfirm(ctx), "confirmed", "a warehouse that answers in 1.5 s must confirm the reservation; the result")
	call := ctx.GRPC.CallsTo("ConfirmReservation", "")[0]
	ctx.Assert(call.HasDeadline(), "ConfirmReservation carries no deadline: a warehouse that hangs holds the request, and the buyer, open")
	ctx.Assert(1500*time.Millisecond <= call.Timeout && call.Timeout <= 2500*time.Millisecond, "the ConfirmReservation deadline is %v, expected about 2 s", call.Timeout)
	ctx.Equal(clientStatus(ctx), "confirmed", "the stored reservation's status")
	_, held := ctx.Redis.HGet("holds:sku-1", "r-1")
	ctx.Assert(!held && clientUnits(ctx) == "7", "after the confirmation holds:sku-1 is %v and stock:sku-1 %s: the hold must become a sale", ctx.Redis.HGetAll("holds:sku-1"), clientUnits(ctx))
}

func CheckRetrySameId(ctx *harness.Ctx) {
	clientWorld(ctx)
	ctx.GRPC.Fail("ConfirmReservation", codes.Unavailable, "warehouse restarting", 1, "")
	ctx.Equal(clientConfirm(ctx), "confirmed", "a warehouse that was UNAVAILABLE once must confirm the reservation after a retry; the result")
	var ids []string
	for _, c := range ctx.GRPC.CallsTo("ConfirmReservation", "") {
		req, _ := c.Request.(*pb.ConfirmRequest)
		ids = append(ids, req.GetReservationId())
	}
	ctx.Equal(ids, []string{"r-1", "r-1"}, "the attempts' reservation ids (the warehouse allocates once per id, a new id is a second allocation)")
}

func CheckUnansweredPending(ctx *harness.Ctx) {
	clientWorld(ctx)
	ctx.GRPC.Fail("ConfirmReservation", codes.Unavailable, "warehouse down", 5, "")
	result := clientConfirm(ctx)
	ctx.Equal(len(ctx.GRPC.CallsTo("ConfirmReservation", "")), 2, "a warehouse that stays UNAVAILABLE gets MAX_CONFIRM_ATTEMPTS = 2 calls; the calls")
	ctx.Equal(result, "pending", "no attempt was answered, so the warehouse may have allocated; the result")
	ctx.Equal(clientStatus(ctx), "pending", "the stored reservation's status")
	quantity, _ := ctx.Redis.HGet("holds:sku-1", "r-1")
	ctx.Assert(quantity == "3" && ctx.Redis.Exists("hold:r-1") == 1, "the hold of a pending reservation was dropped: its units may already be allocated in the warehouse")
	ctx.Equal(clientUnits(ctx), "7", "stock:sku-1 (a pending reservation's units must not go back to the counter)")
}

func CheckRejectionFinal(ctx *harness.Ctx) {
	clientWorld(ctx)
	ctx.GRPC.Fail("ConfirmReservation", codes.FailedPrecondition, "not enough units in the warehouse", 5, "")
	result := clientConfirm(ctx)
	ctx.Equal(len(ctx.GRPC.CallsTo("ConfirmReservation", "")), 1, "FAILED_PRECONDITION is a verdict; the calls to the warehouse")
	ctx.Equal(result, "rejected", "confirmReservation's result")
	ctx.Assert(clientUnits(ctx) == "10" && len(ctx.Redis.HGetAll("holds:sku-1")) == 0, "after the refusal stock:sku-1 is %s and holds:sku-1 %v: the 3 units go back once", clientUnits(ctx), ctx.Redis.HGetAll("holds:sku-1"))
	ctx.Equal(clientStatus(ctx), "rejected", "the stored reservation's status")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <map>
#include <string>
#include <vector>

#include "inventory/store.h"
#include "inventory_service.grpc.pb.h"

namespace {

const inventory::Reservation kClientReservation{"r-1", "t1", "k-1", "sku-1", 3, "reserved", 0};

// One allocation per reservation id.
class WarehousePeer final : public inventoryd::Warehouse::Service {
 public:
  std::map<std::string, std::string> allocations;

  grpc::Status ConfirmReservation(grpc::ServerContext*, const inventoryd::ConfirmRequest* req, inventoryd::ConfirmReply* reply) override {
    allocations.emplace(req->reservation_id(), "c-" + std::to_string(allocations.size() + 1));
    reply->set_confirmation_id(allocations[req->reservation_id()]);
    return grpc::Status::OK;
  }
};

// A stored reservation of 3 units holding them in Redis, and the warehouse the harness serves.
void clientWorld(harness::Ctx& ctx) {
  static WarehousePeer* warehouse = nullptr;
  delete warehouse;
  warehouse = new WarehousePeer;
  ctx.GRPC.Server("")->RegisterService(warehouse);
  ctx.Redis.Do("SET", "stock:sku-1", 7);
  ctx.Redis.Do("HSET", "holds:sku-1", "r-1", 3);
  ctx.Redis.Do("SET", "hold:r-1", 3, "EX", 900);
  inventory::store::Put(kClientReservation);
}

std::string clientStatus(harness::Ctx& ctx) { return ctx.Redis.HGet("reservation:r-1", "status").value_or(""); }

std::string clientUnits(harness::Ctx& ctx) { return ctx.Redis.Get("stock:sku-1").value_or(""); }

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  clientWorld(ctx);
  ctx.GRPC.SetLatency("ConfirmReservation", 1.5);
  ctx.Equal(confirmReservation(kClientReservation), "confirmed", "a warehouse that answers in 1.5 s must confirm the reservation; the result");
  const auto call = ctx.GRPC.CallsTo("ConfirmReservation")[0];
  ctx.Assert(call.HasDeadline(), "ConfirmReservation carries no deadline: a warehouse that hangs holds the request, and the buyer, open");
  ctx.Assert(1.5 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 2.5, "the ConfirmReservation deadline is %vs, expected about 2 s", call.TimeoutSeconds());
  ctx.Equal(clientStatus(ctx), "confirmed", "the stored reservation's status");
  ctx.Assert(!ctx.Redis.HGet("holds:sku-1", "r-1") && clientUnits(ctx) == "7",
             "after the confirmation holds:sku-1 is %v and stock:sku-1 %s: the hold must become a sale", ctx.Redis.HGetAll("holds:sku-1"), clientUnits(ctx));
}

void CheckRetrySameId(harness::Ctx& ctx) {
  clientWorld(ctx);
  ctx.GRPC.Fail("ConfirmReservation", grpc::StatusCode::UNAVAILABLE, "warehouse restarting", 1);
  ctx.Equal(confirmReservation(kClientReservation), "confirmed", "a warehouse that was UNAVAILABLE once must confirm the reservation after a retry; the result");
  std::vector<std::string> ids;
  for (const auto& c : ctx.GRPC.CallsTo("ConfirmReservation")) ids.push_back(c.Request<inventoryd::ConfirmRequest>().reservation_id());
  ctx.Equal(ids, {"r-1", "r-1"}, "the attempts' reservation ids (the warehouse allocates once per id, a new id is a second allocation)");
}

void CheckUnansweredPending(harness::Ctx& ctx) {
  clientWorld(ctx);
  ctx.GRPC.Fail("ConfirmReservation", grpc::StatusCode::UNAVAILABLE, "warehouse down", 5);
  const std::string result = confirmReservation(kClientReservation);
  ctx.Equal(ctx.GRPC.CallsTo("ConfirmReservation").size(), 2, "a warehouse that stays UNAVAILABLE gets MAX_CONFIRM_ATTEMPTS = 2 calls; the calls");
  ctx.Equal(result, "pending", "no attempt was answered, so the warehouse may have allocated; the result");
  ctx.Equal(clientStatus(ctx), "pending", "the stored reservation's status");
  ctx.Assert(ctx.Redis.HGet("holds:sku-1", "r-1").value_or("") == "3" && ctx.Redis.Exists("hold:r-1") == 1,
             "the hold of a pending reservation was dropped: its units may already be allocated in the warehouse");
  ctx.Equal(clientUnits(ctx), "7", "stock:sku-1 (a pending reservation's units must not go back to the counter)");
}

void CheckRejectionFinal(harness::Ctx& ctx) {
  clientWorld(ctx);
  ctx.GRPC.Fail("ConfirmReservation", grpc::StatusCode::FAILED_PRECONDITION, "not enough units in the warehouse", 5);
  const std::string result = confirmReservation(kClientReservation);
  ctx.Equal(ctx.GRPC.CallsTo("ConfirmReservation").size(), 1, "FAILED_PRECONDITION is a verdict; the calls to the warehouse");
  ctx.Equal(result, "rejected", "confirmReservation's result");
  ctx.Assert(clientUnits(ctx) == "10" && ctx.Redis.HGetAll("holds:sku-1").empty(),
             "after the refusal stock:sku-1 is %s and holds:sku-1 %v: the 3 units go back once", clientUnits(ctx), ctx.Redis.HGetAll("holds:sku-1"));
  ctx.Equal(clientStatus(ctx), "rejected", "the stored reservation's status");
}
`,
  },
  hints: [
    'After a slow afternoon at the warehouse, units that were already picked show as free and get sold again; a dropped connection leaves two allocations for one cart.',
    'A call that got no answer is not a call that failed: the warehouse may have allocated. Each attempt here has no deadline and a new id, so the warehouse cannot tell a retry from a second order.',
    "Build the request once with the reservation's id; give each of 2 attempts a 2 s deadline; retry only `DEADLINE_EXCEEDED`/`UNAVAILABLE`; on `FAILED_PRECONDITION` release and return rejected; after the loop record and return pending.",
  ],
  debrief: `The client is shaped by one fact about the network: an unanswered call may have succeeded. The reservation id makes the retry safe, the deadline makes a hung warehouse a bounded wait, and the pending status records "we do not know" instead of guessing in the direction that oversells. A refusal is the opposite case: the warehouse has said what it will do, so the units go back at once instead of sitting out the hold. Production services add a reconciliation job that asks the warehouse about every pending reservation by id, back retries off with jitter, and put a circuit breaker in front of the warehouse so a flash sale does not queue thousands of calls behind a dead endpoint.`,
};
