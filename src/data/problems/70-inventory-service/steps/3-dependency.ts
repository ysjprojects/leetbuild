import type {Step} from '@/lib/types';

// ---- 3. Warehouse confirmation over gRPC ------------------------------------------------------
export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Warehouse confirmation with a release on rejection',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'warehouse', 'redis'],
  task: `## Task

The warehouse is reached over gRPC with this contract:

\`\`\`proto
service Warehouse {
  rpc ConfirmReservation(ConfirmRequest) returns (ConfirmReply);
}
message ConfirmRequest { string reservation_id = 1; string sku = 2; int64 quantity = 3; }
message ConfirmReply   { string status = 1; }  // CONFIRMED, or REJECTED for FAILED_PRECONDITION (out of stock)
\`\`\`

Implement \`confirm(store, redis, reservation_id, sku, quantity)\` on top of the generated stub. The
warehouse treats \`reservation_id\` as the **idempotency id**: a retry carrying the same id is the
same confirmation, a retry that mints a fresh id is a second reservation for the same units.

- Every attempt carries a **2 second** deadline (\`CONFIRM_DEADLINE_MS = 2000\`) as the call's own
  deadline, and at most \`MAX_CONFIRM_ATTEMPTS = 2\` attempts are made.
- \`CONFIRMED\` → record the reservation as \`confirmed\` and keep the hold.
- Terminal rejection (\`FAILED_PRECONDITION\`, out of stock) → **release the Redis hold exactly
  once**: only while the reservation still reads \`reserved\`, then record it \`released\`. A replayed
  confirmation must be a no-op, not a second release.
- \`DEADLINE_EXCEEDED\` or \`UNAVAILABLE\` → the answer never came. Record the reservation as
  \`pending\`, **keep the hold**, and retry once with the **same** \`reservation_id\`; only after the
  retry also fails is the outcome \`PENDING\`. Releasing here would destroy a sale the warehouse may
  still confirm.
- Return the outcome (\`CONFIRMED\` / \`REJECTED\` / \`PENDING\`) so the caller can tell a pending retry
  from a terminal rejection.

**Failure mode the checks target.** The draft reads a deadline as a rejection: it releases the hold
when the warehouse is merely slow, so a valid sale is cancelled and the units go to the next buyer,
and it retries with a fresh \`uuid()\`, so the warehouse books a second reservation for units it
already holds. Its rejection path releases without looking at the reservation status, so a replayed
confirmation gives the units back a second time. A demo where the warehouse answers in milliseconds
never enters any of those paths.`,
  sequence: {
    participants: ['Inventory API', 'Warehouse', 'Redis'],
    messages: [
      {
        from: 'Inventory API',
        to: 'Warehouse',
        label: 'ConfirmReservation · reservation_id · deadline 2 s',
        kind: 'sync',
      },
      {from: 'Warehouse', to: 'Inventory API', label: 'DEADLINE_EXCEEDED', kind: 'reply'},
      {from: 'Inventory API', to: 'Inventory API', label: 'status = pending · hold kept', kind: 'sync'},
      {
        from: 'Inventory API',
        to: 'Warehouse',
        label: 'retry · same reservation_id (the idempotency id)',
        kind: 'sync',
      },
      {from: 'Warehouse', to: 'Inventory API', label: 'OUT_OF_STOCK → REJECTED', kind: 'reply'},
      {from: 'Inventory API', to: 'Redis', label: 'release the hold · only if status == reserved', kind: 'sync'},
      {from: 'Inventory API', to: 'Redis', label: 'status = released', kind: 'sync'},
    ],
  },
  hints: [
    'The deadline belongs to the call, not around it: `timeout=CONFIRM_DEADLINE_MS / 1000`, `{deadline: Date.now() + CONFIRM_DEADLINE_MS}`, `context.WithTimeout(ctx, confirmDeadlineMs*time.Millisecond)`, `withDeadlineAfter(ConfirmDeadlineMs, TimeUnit.MILLISECONDS)`, `ctx.set_deadline(now + milliseconds(kConfirmDeadlineMs))`. When it fires you know only that you did not hear back — that is `PENDING`, not a rejection.',
    'The retry is the *same* call: rebuild the request from the caller’s `reservation_id` on every attempt (the warehouse dedupes on it) and never mint a fresh id, or the retry reserves twice. Bound the loop with `MAX_CONFIRM_ATTEMPTS = 2` and treat only `DEADLINE_EXCEEDED` / `UNAVAILABLE` as retryable.',
    'Release is a guarded transition, not an action: `if reservation.status == "reserved"` → release the hold, then record `released`. The second confirmation of that reservation then sees `released` and returns without touching Redis.',
  ],
  checks: [
    {
      id: 'grpc-client',
      title: 'Calls ConfirmReservation under a 2 s deadline',
      detail:
        'The stub is the generated `ConfirmReservation` client and every attempt carries a deadline built from **`CONFIRM_DEADLINE_MS = 2000`** — `timeout=CONFIRM_DEADLINE_MS / 1000`, `{deadline: Date.now() + CONFIRM_DEADLINE_MS}`, `context.WithTimeout(ctx, confirmDeadlineMs*time.Millisecond)`, `withDeadlineAfter(ConfirmDeadlineMs, TimeUnit.MILLISECONDS)`, or `set_deadline(… kConfirmDeadlineMs)`. Without a deadline one stuck warehouse pins the caller.',
      match: {
        python: {
          all: [/CONFIRM_DEADLINE_MS\s*=\s*2000/, /ConfirmReservation\(/, /timeout=CONFIRM_DEADLINE_MS\s*\/\s*1000/],
        },
        typescript: {
          all: [
            /CONFIRM_DEADLINE_MS\s*=\s*2000/,
            /ConfirmReservation\(/,
            /deadline:\s*Date\.now\(\)\s*\+\s*CONFIRM_DEADLINE_MS/,
          ],
        },
        go: {
          all: [
            /confirmDeadlineMs\s*=\s*2000/,
            /ConfirmReservation\(/,
            /context\.WithTimeout\(\s*\w+\s*,\s*confirmDeadlineMs\s*\*\s*time\.Millisecond\s*\)/,
          ],
        },
        scala: {
          all: [
            /ConfirmDeadlineMs\s*=\s*2000/,
            /confirmReservation\(/,
            /withDeadlineAfter\(\s*ConfirmDeadlineMs\s*,\s*TimeUnit\.MILLISECONDS\s*\)/,
          ],
        },
        cpp: {
          all: [/kConfirmDeadlineMs\s*=\s*2000/, /ConfirmReservation\(/, /set_deadline\([^;]*kConfirmDeadlineMs/],
        },
      },
    },
    {
      id: 'timeout-pending',
      title: 'A timeout leaves the reservation pending — never releases the hold',
      detail:
        '`DEADLINE_EXCEEDED` / `UNAVAILABLE` records the reservation as `pending` and returns **`PENDING`**, with the hold left alone: the confirmation may still arrive. The draft calls `release` from the timeout branch, so a slow warehouse silently loses a valid sale.',
      match: {
        python: {
          all: [/StatusCode\.DEADLINE_EXCEEDED/, /return PENDING/, /['"]pending['"]/],
          none: [/DEADLINE_EXCEEDED[^\n]*\n(?:[^\n]*\n)?[^\n]*release_hold\(/],
          order: [/StatusCode\.DEADLINE_EXCEEDED/, /['"]pending['"]/],
        },
        typescript: {
          all: [/grpc\.status\.DEADLINE_EXCEEDED/, /return PENDING/, /['"]pending['"]/],
          none: [/DEADLINE_EXCEEDED[^\n]*\n(?:[^\n]*\n)?[^\n]*releaseHold\(/],
          order: [/grpc\.status\.DEADLINE_EXCEEDED/, /['"]pending['"]/],
        },
        go: {
          all: [/codes\.DeadlineExceeded/, /return OutcomePending/, /['"]pending['"]/],
          none: [/codes\.DeadlineExceeded[^\n]*\n(?:[^\n]*\n)?[^\n]*releaseHold\(/],
          order: [/codes\.DeadlineExceeded/, /['"]pending['"]/],
        },
        scala: {
          all: [/Status\.Code\.DEADLINE_EXCEEDED/, /return Pending/, /['"]pending['"]/],
          none: [/DEADLINE_EXCEEDED[^\n]*\n(?:[^\n]*\n)?[^\n]*releaseHold\(/],
          order: [/Status\.Code\.DEADLINE_EXCEEDED/, /['"]pending['"]/],
        },
        cpp: {
          all: [/StatusCode::DEADLINE_EXCEEDED/, /Outcome::Pending/, /['"]pending['"]/],
          none: [/StatusCode::DEADLINE_EXCEEDED[^\n]*\n(?:[^\n]*\n)?[^\n]*releaseHold\(/],
          order: [/StatusCode::DEADLINE_EXCEEDED/, /['"]pending['"]/],
        },
      },
    },
    {
      id: 'retry-same-id',
      title: 'Retries once with the same reservation id',
      detail:
        'At most **`MAX_CONFIRM_ATTEMPTS = 2`** attempts, and every attempt puts the caller’s `reservation_id` into the request — the retry never mints a fresh id (`uuid`, `randomUUID`, `uuid.NewString`, `UUID.randomUUID`), because the warehouse dedupes on that id. The draft retries once with a new id and double-reserves.',
      match: {
        python: {
          all: [/MAX_CONFIRM_ATTEMPTS\s*=\s*2/, /range\(MAX_CONFIRM_ATTEMPTS\)/, /reservation_id\s*=\s*reservation_id/],
          none: [/uuid/i],
          order: [/reservation_id\s*=\s*reservation_id/, /ConfirmReservation\(/],
        },
        typescript: {
          all: [
            /MAX_CONFIRM_ATTEMPTS\s*=\s*2/,
            /attempt\s*<\s*MAX_CONFIRM_ATTEMPTS/,
            /reservation_id:\s*reservationId/,
          ],
          none: [/uuid/i],
          order: [/reservation_id:\s*reservationId/, /ConfirmReservation\(/],
        },
        go: {
          all: [/maxConfirmAttempts\s*=\s*2/, /attempt\s*<\s*maxConfirmAttempts/, /ReservationId:\s*reservationID/],
          none: [/uuid/i],
          order: [/ReservationId:\s*reservationID/, /ConfirmReservation\(/],
        },
        scala: {
          all: [/MaxConfirmAttempts\s*=\s*2/, /attempt\s*<\s*MaxConfirmAttempts/, /reservationId\s*=\s*reservationId/],
          none: [/uuid/i],
          order: [/reservationId\s*=\s*reservationId/, /confirmReservation\(/],
        },
        cpp: {
          all: [
            /kMaxConfirmAttempts\s*=\s*2/,
            /attempt\s*<\s*kMaxConfirmAttempts/,
            /set_reservation_id\(reservation_id\)/,
          ],
          none: [/uuid/i],
          order: [/set_reservation_id\(reservation_id\)/, /ConfirmReservation\(/],
        },
      },
    },
    {
      id: 'release-once',
      title: 'Releases the hold exactly once, guarded by the reservation status',
      detail:
        'The rejection path releases only while the reservation is still `reserved` — `if reservation.status == "reserved"` → release the hold → record `released` — so a replayed confirmation is a no-op instead of a second release. The draft releases unconditionally, from both the rejection and the timeout branch.',
      match: {
        python: {
          all: [/REJECTED/, /release_hold\(redis,/, /['"]reserved['"]/],
          order: [/[Ss]tatus\s*===?\s*['"]reserved['"]/, /release_hold\(redis,/, /['"]released['"]/],
        },
        typescript: {
          all: [/REJECTED/, /releaseHold\(redis,/, /['"]reserved['"]/],
          order: [/status\s*===?\s*['"]reserved['"]/, /releaseHold\(redis,/, /['"]released['"]/],
        },
        go: {
          all: [/OutcomeRejected/, /releaseHold\(ctx, rdb,/, /['"]reserved['"]/],
          order: [/[Ss]tatus\s*===?\s*['"]reserved['"]/, /releaseHold\(ctx, rdb,/, /['"]released['"]/],
        },
        scala: {
          all: [/Rejected/, /releaseHold\(redis,/, /['"]reserved['"]/],
          order: [/status\s*===?\s*['"]reserved['"]/, /releaseHold\(redis,/, /['"]released['"]/],
        },
        cpp: {
          all: [/Outcome::Rejected/, /releaseHold\(redis,/, /['"]reserved['"]/],
          order: [/status\s*===?\s*['"]reserved['"]/, /releaseHold\(redis,/, /['"]released['"]/],
        },
      },
    },
    {
      id: 'status-model',
      title: 'Records and reports the reservation status',
      detail:
        'All four states are written through the reservation record — `reserved` → `pending` on a timeout, `confirmed` on acceptance, `released` after the hold is given back — and the return reports `PENDING` / `REJECTED` / `CONFIRMED` so the caller can tell a pending retry from a terminal rejection. The draft only ever records `confirmed` or `released` and answers `REJECTED` for a timeout.',
      match: {
        python: {
          all: [/['"]reserved['"]/, /['"]pending['"]/, /['"]confirmed['"]/, /['"]released['"]/, /return PENDING/],
        },
        typescript: {
          all: [/['"]reserved['"]/, /['"]pending['"]/, /['"]confirmed['"]/, /['"]released['"]/, /return PENDING/],
        },
        go: {
          all: [
            /['"]reserved['"]/,
            /['"]pending['"]/,
            /['"]confirmed['"]/,
            /['"]released['"]/,
            /return OutcomePending/,
          ],
        },
        scala: {
          all: [/['"]reserved['"]/, /['"]pending['"]/, /['"]confirmed['"]/, /['"]released['"]/, /return Pending/],
        },
        cpp: {
          all: [
            /['"]reserved['"]/,
            /['"]pending['"]/,
            /['"]confirmed['"]/,
            /['"]released['"]/,
            /return Outcome::Pending/,
          ],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `"""Warehouse confirmation: the model-generated draft releases the hold when the warehouse is slow."""

import uuid

import grpc

import warehouse_pb2
import warehouse_pb2_grpc

CONFIRM_DEADLINE_MS = 2000

stub = warehouse_pb2_grpc.WarehouseStub(grpc.insecure_channel("warehouse:9000"))


def release_hold(redis, reservation_id: str, sku: str, quantity: int) -> None:
    redis.incrby(f"stock:{sku}", quantity)
    redis.delete(f"hold:{reservation_id}")


def confirm(store, redis, reservation_id: str, sku: str, quantity: int) -> str:
    # TODO: a deadline is not a rejection — keep the reservation pending and the hold in place,
    # retry once with the same reservation id, and release the hold exactly once, guarded by the
    # reservation status.
    attempts = 0
    while attempts < 2:
        request = warehouse_pb2.ConfirmRequest(
            reservation_id=str(uuid.uuid4()) if attempts else reservation_id,
            sku=sku,
            quantity=quantity,
        )
        try:
            reply = stub.ConfirmReservation(request, timeout=CONFIRM_DEADLINE_MS / 1000)
        except grpc.RpcError as exc:
            if exc.code() == grpc.StatusCode.DEADLINE_EXCEEDED:
                release_hold(redis, reservation_id, sku, quantity)
                return "REJECTED"
            raise
        if reply.status == warehouse_pb2.REJECTED:
            release_hold(redis, reservation_id, sku, quantity)
            return "REJECTED"
        return "CONFIRMED"
    return "REJECTED"
`,
      solution: `"""Warehouse confirmation: a 2 s deadline, a pending hold on timeout, one release on rejection."""

import grpc

import warehouse_pb2
import warehouse_pb2_grpc

CONFIRM_DEADLINE_MS = 2000
MAX_CONFIRM_ATTEMPTS = 2

CONFIRMED = "CONFIRMED"
REJECTED = "REJECTED"
PENDING = "PENDING"

RETRYABLE = (grpc.StatusCode.DEADLINE_EXCEEDED, grpc.StatusCode.UNAVAILABLE)

stub = warehouse_pb2_grpc.WarehouseStub(grpc.insecure_channel("warehouse:9000"))


def release_once(store, redis, reservation_id: str, sku: str, quantity: int) -> None:
    """Give the units back exactly once: a replayed confirmation must be a no-op."""
    if store.get(reservation_id).status == "reserved":
        release_hold(redis, reservation_id, sku, quantity)
        store.set_status(reservation_id, "released")


def release_hold(redis, reservation_id: str, sku: str, quantity: int) -> None:
    """The one place that touches the Redis hold."""
    redis.incrby(f"stock:{sku}", quantity)
    redis.delete(f"hold:{reservation_id}")


def confirm(store, redis, reservation_id: str, sku: str, quantity: int) -> str:
    for _ in range(MAX_CONFIRM_ATTEMPTS):
        request = warehouse_pb2.ConfirmRequest(reservation_id=reservation_id, sku=sku, quantity=quantity)
        try:
            reply = stub.ConfirmReservation(request, timeout=CONFIRM_DEADLINE_MS / 1000)
        except grpc.RpcError as exc:
            if exc.code() not in RETRYABLE:
                raise
            continue
        if reply.status == warehouse_pb2.REJECTED:
            release_once(store, redis, reservation_id, sku, quantity)
            return REJECTED
        store.set_status(reservation_id, "confirmed")
        return CONFIRMED
    store.set_status(reservation_id, "pending")
    return PENDING
`,
    },
    typescript: {
      starter: `/** Warehouse confirmation: the model-generated draft releases the hold when the warehouse is slow. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import {randomUUID} from 'node:crypto';
import type {Redis} from 'ioredis';

export interface ReservationStore {
  get(reservationId: string): Promise<{status: string}>;
  setStatus(reservationId: string, status: string): Promise<void>;
}

interface ConfirmReply {
  status: string;
}

interface WarehouseClient {
  ConfirmReservation(
    request: {reservation_id: string; sku: string; quantity: number},
    metadata: grpc.Metadata,
    options: {deadline: number},
    callback: (error: grpc.ServiceError | null, reply: ConfirmReply) => void,
  ): grpc.ClientUnaryCall;
}

const CONFIRM_DEADLINE_MS = 2000;

const {warehouse} = grpc.loadPackageDefinition(protoLoader.loadSync('warehouse.proto')) as unknown as {
  warehouse: {Warehouse: new (target: string, credentials: grpc.ChannelCredentials) => WarehouseClient};
};
const stub = new warehouse.Warehouse('warehouse:9000', grpc.credentials.createInsecure());

async function releaseHold(redis: Redis, reservationId: string, sku: string, quantity: number): Promise<void> {
  await redis.incrby(\`stock:\${sku}\`, quantity);
  await redis.del(\`hold:\${reservationId}\`);
}

export async function confirm(
  store: ReservationStore,
  redis: Redis,
  reservationId: string,
  sku: string,
  quantity: number,
): Promise<string> {
  // TODO: a deadline is not a rejection — keep the reservation pending and the hold in place,
  // retry once with the same reservation id, and release the hold exactly once, guarded by the
  // reservation status.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const request = {
      reservation_id: attempt === 0 ? reservationId : randomUUID(),
      sku,
      quantity,
    };
    try {
      const reply = await new Promise<ConfirmReply>((resolve, reject) => {
        stub.ConfirmReservation(
          request,
          new grpc.Metadata(),
          {deadline: Date.now() + CONFIRM_DEADLINE_MS},
          (error, value) => {
            if (error) reject(error);
            else resolve(value);
          },
        );
      });
      if (reply.status === 'REJECTED') {
        await releaseHold(redis, reservationId, sku, quantity);
        return 'REJECTED';
      }
      return 'CONFIRMED';
    } catch (error) {
      if ((error as grpc.ServiceError).code === grpc.status.DEADLINE_EXCEEDED) {
        await releaseHold(redis, reservationId, sku, quantity);
        return 'REJECTED';
      }
      throw error;
    }
  }
  return 'REJECTED';
}
`,
      solution: `/** Warehouse confirmation: a 2 s deadline, a pending hold on timeout, one release on rejection. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import type {Redis} from 'ioredis';

export interface ReservationStore {
  get(reservationId: string): Promise<{status: string}>;
  setStatus(reservationId: string, status: string): Promise<void>;
}

interface ConfirmReply {
  status: string;
}

interface WarehouseClient {
  ConfirmReservation(
    request: {reservation_id: string; sku: string; quantity: number},
    metadata: grpc.Metadata,
    options: {deadline: number},
    callback: (error: grpc.ServiceError | null, reply: ConfirmReply) => void,
  ): grpc.ClientUnaryCall;
}

const CONFIRM_DEADLINE_MS = 2000;
const MAX_CONFIRM_ATTEMPTS = 2;

const CONFIRMED = 'CONFIRMED';
const REJECTED = 'REJECTED';
const PENDING = 'PENDING';

const RETRYABLE: Record<number, true> = {
  [grpc.status.DEADLINE_EXCEEDED]: true,
  [grpc.status.UNAVAILABLE]: true,
};

const {warehouse} = grpc.loadPackageDefinition(protoLoader.loadSync('warehouse.proto')) as unknown as {
  warehouse: {Warehouse: new (target: string, credentials: grpc.ChannelCredentials) => WarehouseClient};
};
const stub = new warehouse.Warehouse('warehouse:9000', grpc.credentials.createInsecure());

/** Give the units back exactly once: a replayed confirmation must be a no-op. */
async function releaseOnce(
  store: ReservationStore,
  redis: Redis,
  reservationId: string,
  sku: string,
  quantity: number,
): Promise<void> {
  const reservation = await store.get(reservationId);
  if (reservation.status === 'reserved') {
    await releaseHold(redis, reservationId, sku, quantity);
    await store.setStatus(reservationId, 'released');
  }
}

/** The one place that touches the Redis hold. */
async function releaseHold(redis: Redis, reservationId: string, sku: string, quantity: number): Promise<void> {
  await redis.incrby(\`stock:\${sku}\`, quantity);
  await redis.del(\`hold:\${reservationId}\`);
}

export async function confirm(
  store: ReservationStore,
  redis: Redis,
  reservationId: string,
  sku: string,
  quantity: number,
): Promise<string> {
  for (let attempt = 0; attempt < MAX_CONFIRM_ATTEMPTS; attempt += 1) {
    const request = {reservation_id: reservationId, sku, quantity};
    try {
      const reply = await new Promise<ConfirmReply>((resolve, reject) => {
        stub.ConfirmReservation(
          request,
          new grpc.Metadata(),
          {deadline: Date.now() + CONFIRM_DEADLINE_MS},
          (error, value) => {
            if (error) reject(error);
            else resolve(value);
          },
        );
      });
      if (reply.status === 'REJECTED') {
        await releaseOnce(store, redis, reservationId, sku, quantity);
        return REJECTED;
      }
      await store.setStatus(reservationId, 'confirmed');
      return CONFIRMED;
    } catch (error) {
      const serviceError = error as grpc.ServiceError;
      if (RETRYABLE[serviceError.code] !== true) throw serviceError;
    }
  }
  await store.setStatus(reservationId, 'pending');
  return PENDING;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "inventory/warehousepb"
)

const confirmDeadlineMs = 2000

// Reservation is the reservation record; the warehouse confirmation owns its status.
type Reservation struct {
	Status string
}

// ReservationStore reads and writes reservation records.
type ReservationStore interface {
	Get(ctx context.Context, reservationID string) (*Reservation, error)
	SetStatus(ctx context.Context, reservationID, status string) error
}

func releaseHold(ctx context.Context, rdb *redis.Client, reservationID, sku string, quantity int64) error {
	if err := rdb.IncrBy(ctx, "stock:"+sku, quantity).Err(); err != nil {
		return err
	}
	return rdb.Del(ctx, "hold:"+reservationID).Err()
}

// TODO: a deadline is not a rejection — keep the reservation pending and the hold in place, retry
// once with the same reservation id, and release the hold exactly once, guarded by the status.
func confirm(ctx context.Context, client pb.WarehouseClient, store ReservationStore, rdb *redis.Client, reservationID, sku string, quantity int64) (string, error) {
	for attempt := 0; attempt < 2; attempt++ {
		id := reservationID
		if attempt > 0 {
			id = uuid.NewString()
		}
		req := &pb.ConfirmRequest{ReservationId: id, Sku: sku, Quantity: quantity}
		callCtx, cancel := context.WithTimeout(ctx, confirmDeadlineMs*time.Millisecond)
		reply, err := client.ConfirmReservation(callCtx, req)
		cancel()
		if status.Code(err) == codes.DeadlineExceeded {
			releaseHold(ctx, rdb, reservationID, sku, quantity)
			return "REJECTED", nil
		}
		if err != nil {
			return "", err
		}
		if reply.Status == "REJECTED" {
			releaseHold(ctx, rdb, reservationID, sku, quantity)
			return "REJECTED", nil
		}
		return "CONFIRMED", nil
	}
	return "REJECTED", nil
}
`,
      solution: `package main

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "inventory/warehousepb"
)

const confirmDeadlineMs = 2000
const maxConfirmAttempts = 2

const (
	OutcomeConfirmed = "CONFIRMED"
	OutcomeRejected  = "REJECTED"
	OutcomePending   = "PENDING"
)

// Only these two mean "the answer never came"; everything else is an answer.
var retryable = map[codes.Code]bool{codes.DeadlineExceeded: true, codes.Unavailable: true}

// Reservation is the reservation record; the warehouse confirmation owns its status.
type Reservation struct {
	Status string
}

// ReservationStore reads and writes reservation records.
type ReservationStore interface {
	Get(ctx context.Context, reservationID string) (*Reservation, error)
	SetStatus(ctx context.Context, reservationID, status string) error
}

// releaseOnce gives the units back exactly once: a replayed confirmation must be a no-op.
func releaseOnce(ctx context.Context, store ReservationStore, rdb *redis.Client, reservationID, sku string, quantity int64) error {
	reservation, err := store.Get(ctx, reservationID)
	if err != nil {
		return err
	}
	if reservation.Status == "reserved" {
		if err := releaseHold(ctx, rdb, reservationID, sku, quantity); err != nil {
			return err
		}
		return store.SetStatus(ctx, reservationID, "released")
	}
	return nil
}

// releaseHold is the one place that touches the Redis hold.
func releaseHold(ctx context.Context, rdb *redis.Client, reservationID, sku string, quantity int64) error {
	if err := rdb.IncrBy(ctx, "stock:"+sku, quantity).Err(); err != nil {
		return err
	}
	return rdb.Del(ctx, "hold:"+reservationID).Err()
}

func confirm(ctx context.Context, client pb.WarehouseClient, store ReservationStore, rdb *redis.Client, reservationID, sku string, quantity int64) (string, error) {
	for attempt := 0; attempt < maxConfirmAttempts; attempt++ {
		req := &pb.ConfirmRequest{ReservationId: reservationID, Sku: sku, Quantity: quantity}
		callCtx, cancel := context.WithTimeout(ctx, confirmDeadlineMs*time.Millisecond)
		reply, err := client.ConfirmReservation(callCtx, req)
		cancel()
		if err != nil {
			if !retryable[status.Code(err)] {
				return "", err
			}
			continue
		}
		if reply.Status == "REJECTED" {
			if err := releaseOnce(ctx, store, rdb, reservationID, sku, quantity); err != nil {
				return "", err
			}
			return OutcomeRejected, nil
		}
		if err := store.SetStatus(ctx, reservationID, "confirmed"); err != nil {
			return "", err
		}
		return OutcomeConfirmed, nil
	}
	if err := store.SetStatus(ctx, reservationID, "pending"); err != nil {
		return "", err
	}
	return OutcomePending, nil
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}
import java.util.UUID
import java.util.concurrent.TimeUnit

import redis.clients.jedis.Jedis

object WarehouseClient {
  val ConfirmDeadlineMs = 2000

  val stub = WarehouseGrpc.blockingStub(ManagedChannelBuilder.forAddress("warehouse", 9000).usePlaintext().build())

  def releaseHold(redis: Jedis, reservationId: String, sku: String, quantity: Int): Unit = {
    redis.incrBy("stock:" + sku, quantity.toLong)
    redis.del("hold:" + reservationId)
  }

  // TODO: a deadline is not a rejection — keep the reservation pending and the hold in place,
  // retry once with the same reservation id, and release the hold exactly once, guarded by the
  // reservation status.
  def confirm(store: ReservationStore, redis: Jedis, reservationId: String, sku: String, quantity: Int): String = {
    var attempt = 0
    while (attempt < 2) {
      val request = ConfirmRequest(
        reservationId = if (attempt == 0) reservationId else UUID.randomUUID().toString,
        sku = sku,
        quantity = quantity,
      )
      try {
        val reply = stub.withDeadlineAfter(ConfirmDeadlineMs, TimeUnit.MILLISECONDS).confirmReservation(request)
        if (reply.status == "REJECTED") {
          releaseHold(redis, reservationId, sku, quantity)
          return "REJECTED"
        }
        return "CONFIRMED"
      } catch {
        case exc: StatusRuntimeException if exc.getStatus.getCode == Status.Code.DEADLINE_EXCEEDED =>
          releaseHold(redis, reservationId, sku, quantity)
          return "REJECTED"
      }
      attempt += 1
    }
    "REJECTED"
  }
}
`,
      solution: `import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}
import java.util.concurrent.TimeUnit

import redis.clients.jedis.Jedis

object WarehouseClient {
  val ConfirmDeadlineMs = 2000
  val MaxConfirmAttempts = 2

  val Confirmed = "CONFIRMED"
  val Rejected = "REJECTED"
  val Pending = "PENDING"

  // Only these two mean "the answer never came"; everything else is an answer.
  val Retryable = Set(Status.Code.DEADLINE_EXCEEDED, Status.Code.UNAVAILABLE)

  val stub = WarehouseGrpc.blockingStub(ManagedChannelBuilder.forAddress("warehouse", 9000).usePlaintext().build())

  /** Give the units back exactly once: a replayed confirmation must be a no-op. */
  def releaseOnce(store: ReservationStore, redis: Jedis, reservationId: String, sku: String, quantity: Int): Unit = {
    if (store.get(reservationId).status == "reserved") {
      releaseHold(redis, reservationId, sku, quantity)
      store.setStatus(reservationId, "released")
    }
  }

  /** The one place that touches the Redis hold. */
  def releaseHold(redis: Jedis, reservationId: String, sku: String, quantity: Int): Unit = {
    redis.incrBy("stock:" + sku, quantity.toLong)
    redis.del("hold:" + reservationId)
  }

  def confirm(store: ReservationStore, redis: Jedis, reservationId: String, sku: String, quantity: Int): String = {
    var attempt = 0
    while (attempt < MaxConfirmAttempts) {
      val request = ConfirmRequest(reservationId = reservationId, sku = sku, quantity = quantity)
      try {
        val reply = stub.withDeadlineAfter(ConfirmDeadlineMs, TimeUnit.MILLISECONDS).confirmReservation(request)
        if (reply.status == "REJECTED") {
          releaseOnce(store, redis, reservationId, sku, quantity)
          return Rejected
        }
        store.setStatus(reservationId, "confirmed")
        return Confirmed
      } catch {
        case exc: StatusRuntimeException if !Retryable.contains(exc.getStatus.getCode) => throw exc
        case _: StatusRuntimeException => ()
      }
      attempt += 1
    }
    store.setStatus(reservationId, "pending")
    return Pending
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>
#include <sw/redis++/redis++.h>

#include "warehouse.grpc.pb.h"

#include <chrono>
#include <stdexcept>
#include <string>

constexpr int kConfirmDeadlineMs = 2000;

struct Reservation {
  std::string status;
};

class ReservationStore {
 public:
  virtual Reservation get(const std::string& reservation_id) = 0;
  virtual void set_status(const std::string& reservation_id, const std::string& status) = 0;
  virtual ~ReservationStore() = default;
};

void releaseHold(sw::redis::Redis& redis, const std::string& reservation_id, const std::string& sku, int quantity);

std::string newUuid();

// TODO: a deadline is not a rejection — keep the reservation pending and the hold in place, retry
// once with the same reservation id, and release the hold exactly once, guarded by the status.
std::string confirm(
    Warehouse::Stub* stub,
    ReservationStore& store,
    sw::redis::Redis& redis,
    const std::string& reservation_id,
    const std::string& sku,
    int quantity) {
  for (int attempt = 0; attempt < 2; ++attempt) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kConfirmDeadlineMs));
    ConfirmRequest request;
    request.set_reservation_id(attempt == 0 ? reservation_id : newUuid());
    request.set_sku(sku);
    request.set_quantity(quantity);
    ConfirmReply reply;
    const grpc::Status status = stub->ConfirmReservation(&ctx, request, &reply);
    if (status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED) {
      releaseHold(redis, reservation_id, sku, quantity);
      return "REJECTED";
    }
    if (!status.ok()) throw std::runtime_error(status.error_message());
    if (reply.status() == "REJECTED") {
      releaseHold(redis, reservation_id, sku, quantity);
      return "REJECTED";
    }
    return "CONFIRMED";
  }
  return "REJECTED";
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <sw/redis++/redis++.h>

#include "warehouse.grpc.pb.h"

#include <chrono>
#include <stdexcept>
#include <string>

constexpr int kConfirmDeadlineMs = 2000;
constexpr int kMaxConfirmAttempts = 2;

enum class Outcome { Confirmed, Rejected, Pending };

const char* toString(Outcome outcome) {
  switch (outcome) {
    case Outcome::Confirmed:
      return "CONFIRMED";
    case Outcome::Rejected:
      return "REJECTED";
    case Outcome::Pending:
      return "PENDING";
  }
  return "PENDING";
}

// Only these two mean "the answer never came"; everything else is an answer.
bool retryable(const grpc::Status& status) {
  return status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED ||
         status.error_code() == grpc::StatusCode::UNAVAILABLE;
}

struct Reservation {
  std::string status;
};

class ReservationStore {
 public:
  virtual Reservation get(const std::string& reservation_id) = 0;
  virtual void set_status(const std::string& reservation_id, const std::string& status) = 0;
  virtual ~ReservationStore() = default;
};

// The one place that touches the Redis hold.
void releaseHold(sw::redis::Redis& redis, const std::string& reservation_id, const std::string& sku, int quantity) {
  redis.incrby("stock:" + sku, quantity);
  redis.del("hold:" + reservation_id);
}

// Give the units back exactly once: a replayed confirmation must be a no-op.
void releaseOnce(ReservationStore& store, sw::redis::Redis& redis, const std::string& reservation_id,
                 const std::string& sku, int quantity) {
  if (store.get(reservation_id).status == "reserved") {
    releaseHold(redis, reservation_id, sku, quantity);
    store.set_status(reservation_id, "released");
  }
}

Outcome confirm(
    Warehouse::Stub* stub,
    ReservationStore& store,
    sw::redis::Redis& redis,
    const std::string& reservation_id,
    const std::string& sku,
    int quantity) {
  for (int attempt = 0; attempt < kMaxConfirmAttempts; ++attempt) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kConfirmDeadlineMs));
    ConfirmRequest request;
    request.set_reservation_id(reservation_id);
    request.set_sku(sku);
    request.set_quantity(quantity);
    ConfirmReply reply;
    const grpc::Status status = stub->ConfirmReservation(&ctx, request, &reply);
    if (!status.ok()) {
      if (!retryable(status)) throw std::runtime_error(status.error_message());
      continue;
    }
    if (reply.status() == "REJECTED") {
      releaseOnce(store, redis, reservation_id, sku, quantity);
      return Outcome::Rejected;
    }
    store.set_status(reservation_id, "confirmed");
    return Outcome::Confirmed;
  }
  store.set_status(reservation_id, "pending");
  return Outcome::Pending;
}
`,
    },
  },
  debrief: `\`PENDING\` is the honest answer to a deadline: the client knows only that the warehouse did not answer within two seconds, and a rejection is a fact it does not have. Releasing the hold on a timeout converts "we do not know" into "sold to someone else", which is the wrong default for a sale that may still be confirmed — so the timeout path records \`pending\` and leaves the hold alone. The retry then has to be the *same* request: the reservation id is the idempotency id the warehouse dedupes on, and a retry with a fresh id turns one confirmation into two reservations, which is worse than the timeout it was meant to fix. The release itself is a guarded state transition rather than an action, so a duplicate confirmation — the client retried, the warehouse replayed — finds \`released\` and does nothing. Real services add a reconciliation sweep for reservations left pending past the hold TTL, export the pending count as a metric so a slow warehouse is visible before the units are lost, and let the warehouse push a late confirmation back over a callback instead of relying on the client's single retry.`,
};
