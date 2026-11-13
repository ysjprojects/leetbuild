import type {Step} from '@/lib/types';

export const bookingClientStep: Step = {
  id: 'dependency',
  title: 'Calendar sync calls that confirm idempotently',
  concept: 'grpc',
  guides: ['deadlines-and-retries'],
  file: 'client',
  focus: ['api', 'calendar', 'redis'],
  task: `## Task

**Starting point.** The starter is \`confirm_booking(booking)\`: it calls \`Calendar.Sync\` at
\`calendar:9000\` with the booking id, the resource and the range, retries when the call fails,
cancels the booking on a timeout, and on success converts the hold with \`confirm_hold\` and marks the
booking \`confirmed\` with the event id. It serves the demo and hides five flaws.

**Failure mode the checks target.** A calendar that answers in two seconds, one that drops a
connection once, one that refuses the booking for good, and one that received the sync but whose
acknowledgement never came back.

\`\`\`proto
service Calendar {
  rpc Sync(SyncRequest) returns (SyncReply);          // upsert on idempotency_key
  rpc GetEvent(GetEventRequest) returns (GetEventReply);  // found, event_id
}
\`\`\`

- Every attempt carries a **3000 ms** deadline and the booking's \`idempotency_key\`: the calendar keeps
  one event per key, so a retried sync updates the event instead of creating a second one.
- At most **3** attempts, and only \`DEADLINE_EXCEEDED\` and \`UNAVAILABLE\` are retried.
- \`INVALID_ARGUMENT\` and \`PERMISSION_DENIED\` are verdicts: \`release_hold\`, state \`rejected\`.
- When every attempt failed the event may exist: record \`sync_unknown\`, then \`GetEvent\` by the same
  key. Found: confirm with its event id and return \`reconciled\`. Not found: release the hold, state
  \`cancelled\`. A \`GetEvent\` that fails answers neither: the booking stays \`sync_unknown\` with its
  hold, for a sweeper to reconcile later.`,
  sequence: {
    participants: ['Booking API', 'Calendar service'],
    messages: [
      {from: 'Booking API', to: 'Calendar service', label: 'Sync(idempotency_key, range) · 3 s deadline', kind: 'sync'},
      {from: 'Calendar service', to: 'Booking API', label: 'event_id (one event per key)', kind: 'reply'},
      {
        from: 'Booking API',
        to: 'Booking API',
        label: 'UNAVAILABLE / DEADLINE_EXCEEDED → retry, 3 attempts',
        kind: 'sync',
      },
      {
        from: 'Calendar service',
        to: 'Booking API',
        label: 'INVALID_ARGUMENT / PERMISSION_DENIED → release the hold, rejected',
        kind: 'reply',
      },
      {from: 'Booking API', to: 'Booking API', label: 'every attempt failed → sync_unknown', kind: 'sync'},
      {from: 'Booking API', to: 'Calendar service', label: 'GetEvent(idempotency_key)', kind: 'sync'},
      {from: 'Calendar service', to: 'Booking API', label: 'found → reconciled · not found → cancelled', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Bounds every attempt with a 3000 ms deadline',
      detail:
        'A calendar that answers in two seconds confirms the booking; each Sync carries a deadline of about 3 s, and so does every retry against a calendar that never answers in time. The starter gives every attempt one second.',
      match: {
        python: {all: [/stub\.Sync\([\s\S]{0,300}?timeout\s*=\s*(SYNC_DEADLINE_MS\s*\/\s*1000|3(\.0)?)\b/]},
        typescript: {all: [/\.Sync\([\s\S]{0,300}?deadline:\s*Date\.now\(\)\s*\+\s*(SYNC_DEADLINE_MS|3000)\b/]},
        go: {all: [/context\.WithTimeout\([^\n]*(syncDeadline|3\s*\*\s*time\.Second|3000\s*\*\s*time\.Millisecond)/]},
        scala: {all: [/withDeadlineAfter\(\s*(SyncDeadlineMs|3000L?|3L?\s*,\s*TimeUnit\.SECONDS)/]},
        cpp: {
          all: [
            /set_deadline\([^\n]*(kSyncDeadline|std::chrono::seconds[({]\s*3\s*[)}]|std::chrono::milliseconds[({]\s*3000\s*[)}]|\b3s\b|\b3000ms\b)/,
          ],
        },
      },
    },
    {
      id: 'idempotency-key',
      title: 'Sends the booking idempotency key so a retry updates one event',
      detail:
        'A Sync that fails UNAVAILABLE once is retried, and the calendar ends with exactly one event, because both calls carried the booking’s `idempotency_key`. The starter sends the booking id only.',
      match: {
        python: {all: [/idempotency_key\s*=\s*booking\[["']idempotency_key["']\]/]},
        typescript: {all: [/idempotency_key:\s*booking\.idempotency_key/]},
        go: {all: [/IdempotencyKey:\s*(b|booking)\.IdempotencyKey/]},
        scala: {all: [/idempotencyKey\s*=\s*booking\.idempotency_key/]},
        cpp: {all: [/set_idempotency_key\(\s*(b|booking)\.idempotency_key\s*\)/]},
      },
    },
    {
      id: 'timeout-reconcile',
      title: 'Records an unknown state and reconciles before cancelling',
      detail:
        'When all 3 attempts timed out the booking is marked `sync_unknown`, `GetEvent` is asked, and an event that exists confirms the booking as `reconciled`. A `GetEvent` that fails cancels nothing: the booking stays `sync_unknown` and keeps its hold. The starter cancels on the first timeout.',
      match: {
        python: {
          all: [/sync_unknown/, /stub\.GetEvent\(/],
          order: [/sync_unknown/, /stub\.GetEvent\(/, /["']cancelled["']/],
        },
        typescript: {
          all: [/sync_unknown/, /\.GetEvent\(/],
          order: [/sync_unknown/, /\.GetEvent\(/, /['"]cancelled['"]/],
        },
        go: {all: [/sync_unknown/, /\.GetEvent\(/], order: [/sync_unknown/, /\.GetEvent\(/, /"cancelled"/]},
        scala: {all: [/sync_unknown/, /\.getEvent\(/], order: [/sync_unknown/, /\.getEvent\(/, /"cancelled"/]},
        cpp: {all: [/sync_unknown/, /->GetEvent\(/], order: [/sync_unknown/, /->GetEvent\(/, /"cancelled"/]},
      },
    },
    {
      id: 'non-retryable-release',
      title: 'Releases the hold when the calendar refuses the booking',
      detail:
        'INVALID_ARGUMENT and PERMISSION_DENIED are not retried: one Sync call each, the slots freed, the booking `rejected`. The starter retries them like any other error.',
      match: {
        python: {all: [/INVALID_ARGUMENT/, /PERMISSION_DENIED/, /release_hold\(/, /["']rejected["']/]},
        typescript: {all: [/INVALID_ARGUMENT/, /PERMISSION_DENIED/, /releaseHold\(/, /['"]rejected['"]/]},
        go: {all: [/codes\.InvalidArgument/, /codes\.PermissionDenied/, /releaseHold\(/, /"rejected"/]},
        scala: {all: [/INVALID_ARGUMENT/, /PERMISSION_DENIED/, /releaseHold\(/, /"rejected"/]},
        cpp: {all: [/INVALID_ARGUMENT/, /PERMISSION_DENIED/, /releaseHold\(/, /"rejected"/]},
      },
    },
    {
      id: 'bounded-retry',
      title: 'Retries only retryable failures, at most 3 times',
      detail:
        'A calendar that stays UNAVAILABLE gets exactly 3 Sync calls, then the booking is marked `sync_unknown` and `GetEvent` decides; with no event it is `cancelled`. An INTERNAL failure gets one call: only DEADLINE_EXCEEDED and UNAVAILABLE are retried. The starter loops until something works.',
      match: {
        python: {all: [/MAX_SYNC_ATTEMPTS\s*=\s*3|range\(\s*3\s*\)/, /UNAVAILABLE/], none: [/while\s+True/]},
        typescript: {
          all: [/MAX_SYNC_ATTEMPTS\s*=\s*3|<\s*3\b/, /UNAVAILABLE/],
          none: [/while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\)/],
        },
        go: {all: [/maxSyncAttempts\s*=\s*3|<\s*3\b|range 3\b/, /codes\.Unavailable/], none: [/for\s*\{/]},
        scala: {all: [/MaxSyncAttempts\s*=\s*3|<\s*3\b|until 3\b/, /UNAVAILABLE/], none: [/while\s*\(\s*true\s*\)/]},
        cpp: {
          all: [/kMaxSyncAttempts\s*=\s*3|<\s*3\b/, /UNAVAILABLE/],
          none: [/while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\)/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import calendar_pb2
import calendar_pb2_grpc
from booking.slots import slot_fields
from booking.store import store
from booking.tz import parse_instant
from state import confirm_hold, release_hold  # step 2

channel = grpc.insecure_channel("calendar:9000")
stub = calendar_pb2_grpc.CalendarStub(channel)


def _fields(booking: dict) -> list[str]:
    return slot_fields(parse_instant(booking["start"]), parse_instant(booking["end"]))


def sync_event(booking: dict) -> str:
    """One attempt at the calendar; the event id it answers."""
    request = calendar_pb2.SyncRequest(
        booking_id=booking["booking_id"],
        resource_id=booking["resource_id"],
        start=booking["start"],
        end=booking["end"],
    )
    return stub.Sync(request, timeout=1).event_id


def confirm_booking(booking: dict) -> str:
    """The booking becomes a calendar event; returns the booking's final state."""
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    while True:
        try:
            event_id = sync_event(booking)
        except grpc.RpcError as exc:
            if exc.code() == grpc.StatusCode.DEADLINE_EXCEEDED:
                release_hold(booking["resource_id"], _fields(booking), booking["hold_id"])
                store.set_state(booking["booking_id"], "cancelled")
                return "cancelled"
            continue
        confirm_hold(booking["resource_id"], _fields(booking), booking["hold_id"], booking["booking_id"])
        store.set_state(booking["booking_id"], "confirmed", event_id)
        return "confirmed"
`,
      solution: `import grpc

import calendar_pb2
import calendar_pb2_grpc
from booking.slots import slot_fields
from booking.store import store
from booking.tz import parse_instant
from state import confirm_hold, release_hold  # step 2

SYNC_DEADLINE_MS = 3000
MAX_SYNC_ATTEMPTS = 3
SYNC_UNKNOWN = "sync_unknown"
RETRYABLE = (grpc.StatusCode.DEADLINE_EXCEEDED, grpc.StatusCode.UNAVAILABLE)
PERMANENT = (grpc.StatusCode.INVALID_ARGUMENT, grpc.StatusCode.PERMISSION_DENIED)

channel = grpc.insecure_channel("calendar:9000")
stub = calendar_pb2_grpc.CalendarStub(channel)


def _fields(booking: dict) -> list[str]:
    return slot_fields(parse_instant(booking["start"]), parse_instant(booking["end"]))


def sync_event(booking: dict) -> str:
    """One attempt at the calendar; the key makes a retry update the one event instead of adding one."""
    request = calendar_pb2.SyncRequest(
        booking_id=booking["booking_id"],
        idempotency_key=booking["idempotency_key"],
        resource_id=booking["resource_id"],
        start=booking["start"],
        end=booking["end"],
    )
    return stub.Sync(request, timeout=SYNC_DEADLINE_MS / 1000).event_id


def reconcile_event(idempotency_key: str) -> str | None:
    """The event the calendar holds under the key, if any: asked before the booking is touched."""
    reply = stub.GetEvent(calendar_pb2.GetEventRequest(idempotency_key=idempotency_key), timeout=SYNC_DEADLINE_MS / 1000)
    return reply.event_id if reply.found else None


def _confirmed(booking: dict, event_id: str) -> None:
    confirm_hold(booking["resource_id"], _fields(booking), booking["hold_id"], booking["booking_id"])
    store.set_state(booking["booking_id"], "confirmed", event_id)


def _released(booking: dict, state: str) -> str:
    release_hold(booking["resource_id"], _fields(booking), booking["hold_id"])
    store.set_state(booking["booking_id"], state)
    return state


def confirm_booking(booking: dict) -> str:
    """The booking becomes a calendar event; returns the booking's final state."""
    for _ in range(MAX_SYNC_ATTEMPTS):
        try:
            event_id = sync_event(booking)
        except grpc.RpcError as exc:
            if exc.code() in PERMANENT:
                # The calendar refused this booking for good and created nothing: give the slots back
                # now instead of leaking them for the rest of the payment window.
                return _released(booking, "rejected")
            if exc.code() in RETRYABLE:
                continue
            raise
        _confirmed(booking, event_id)
        return "confirmed"

    # Every attempt timed out or found the calendar down: the event may exist, so say so and ask.
    store.set_state(booking["booking_id"], SYNC_UNKNOWN)
    event_id = reconcile_event(booking["idempotency_key"])
    if event_id is None:
        return _released(booking, "cancelled")
    _confirmed(booking, event_id)
    return "reconciled"
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {slotFields} from 'booking/slots';
import {type Booking, store} from 'booking/store';
import {parseInstant} from 'booking/tz';
import {confirmHold, releaseHold} from './state'; // step 2

interface SyncRequest {
  booking_id: string;
  idempotency_key?: string;
  resource_id: string;
  start: string;
  end: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('calendar.proto')) as unknown as {
  booking: {Calendar: grpc.ServiceClientConstructor};
};
const stub = new pkg.booking.Calendar('calendar:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Sync(request: SyncRequest, options: grpc.CallOptions): Promise<{event_id: string}>;
  GetEvent(request: {idempotency_key: string}, options: grpc.CallOptions): Promise<{found: boolean; event_id: string}>;
};

const fields = (booking: Booking): string[] => slotFields(parseInstant(booking.start)!, parseInstant(booking.end)!);

/** One attempt at the calendar; the event id it answers. */
export async function syncEvent(booking: Booking): Promise<string> {
  const request = {booking_id: booking.booking_id, resource_id: booking.resource_id, start: booking.start, end: booking.end};
  const reply = await stub.Sync(request, {deadline: Date.now() + 1000});
  return reply.event_id;
}

/** The booking becomes a calendar event; resolves to the booking's final state. */
export async function confirmBooking(booking: Booking): Promise<string> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  while (true) {
    let eventId: string;
    try {
      eventId = await syncEvent(booking);
    } catch (err) {
      if ((err as grpc.ServiceError).code === grpc.status.DEADLINE_EXCEEDED) {
        await releaseHold(booking.resource_id, fields(booking), booking.hold_id);
        await store.setState(booking.booking_id, 'cancelled');
        return 'cancelled';
      }
      continue;
    }
    await confirmHold(booking.resource_id, fields(booking), booking.hold_id, booking.booking_id);
    await store.setState(booking.booking_id, 'confirmed', eventId);
    return 'confirmed';
  }
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {slotFields} from 'booking/slots';
import {type Booking, store} from 'booking/store';
import {parseInstant} from 'booking/tz';
import {confirmHold, releaseHold} from './state'; // step 2

export const SYNC_DEADLINE_MS = 3000;
export const MAX_SYNC_ATTEMPTS = 3;
export const SYNC_UNKNOWN = 'sync_unknown';
const RETRYABLE = [grpc.status.DEADLINE_EXCEEDED, grpc.status.UNAVAILABLE];
const PERMANENT = [grpc.status.INVALID_ARGUMENT, grpc.status.PERMISSION_DENIED];

interface SyncRequest {
  booking_id: string;
  idempotency_key?: string;
  resource_id: string;
  start: string;
  end: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('calendar.proto')) as unknown as {
  booking: {Calendar: grpc.ServiceClientConstructor};
};
const stub = new pkg.booking.Calendar('calendar:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Sync(request: SyncRequest, options: grpc.CallOptions): Promise<{event_id: string}>;
  GetEvent(request: {idempotency_key: string}, options: grpc.CallOptions): Promise<{found: boolean; event_id: string}>;
};

const fields = (booking: Booking): string[] => slotFields(parseInstant(booking.start)!, parseInstant(booking.end)!);

/** One attempt at the calendar; the key makes a retry update the one event instead of adding one. */
export async function syncEvent(booking: Booking): Promise<string> {
  const request = {
    booking_id: booking.booking_id,
    idempotency_key: booking.idempotency_key,
    resource_id: booking.resource_id,
    start: booking.start,
    end: booking.end,
  };
  const reply = await stub.Sync(request, {deadline: Date.now() + SYNC_DEADLINE_MS});
  return reply.event_id;
}

/** The event the calendar holds under the key, if any: asked before the booking is touched. */
export async function reconcileEvent(idempotencyKey: string): Promise<string | null> {
  const reply = await stub.GetEvent({idempotency_key: idempotencyKey}, {deadline: Date.now() + SYNC_DEADLINE_MS});
  return reply.found ? reply.event_id : null;
}

async function confirmed(booking: Booking, eventId: string): Promise<void> {
  await confirmHold(booking.resource_id, fields(booking), booking.hold_id, booking.booking_id);
  await store.setState(booking.booking_id, 'confirmed', eventId);
}

async function released(booking: Booking, state: string): Promise<string> {
  await releaseHold(booking.resource_id, fields(booking), booking.hold_id);
  await store.setState(booking.booking_id, state);
  return state;
}

/** The booking becomes a calendar event; resolves to the booking's final state. */
export async function confirmBooking(booking: Booking): Promise<string> {
  for (let attempt = 0; attempt < MAX_SYNC_ATTEMPTS; attempt += 1) {
    let eventId: string;
    try {
      eventId = await syncEvent(booking);
    } catch (err) {
      const code = (err as grpc.ServiceError).code;
      // The calendar refused this booking for good and created nothing: give the slots back now
      // instead of leaking them for the rest of the payment window.
      if (PERMANENT.includes(code)) return released(booking, 'rejected');
      if (RETRYABLE.includes(code)) continue;
      throw err;
    }
    await confirmed(booking, eventId);
    return 'confirmed';
  }

  // Every attempt timed out or found the calendar down: the event may exist, so say so and ask.
  await store.setState(booking.booking_id, SYNC_UNKNOWN);
  const eventId = await reconcileEvent(booking.idempotency_key);
  if (eventId === null) return released(booking, 'cancelled');
  await confirmed(booking, eventId);
  return 'reconciled';
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "booking/gen/calendar"
	"booking/slots"
	"booking/store"
	"booking/tz"
)

// Built in step 2 (state.go): the hold map's transitions.
var (
	confirmHold = func(ctx context.Context, resourceID string, slotFields []string, holdID, bookingID string) (int, error) {
		panic("not implemented")
	}
	releaseHold = func(ctx context.Context, resourceID string, slotFields []string, holdID string) (int, error) {
		panic("not implemented")
	}
)

var conn, _ = grpc.NewClient("calendar:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewCalendarClient(conn)

func fields(b *store.Booking) []string {
	start, _ := tz.ParseInstant(b.Start)
	end, _ := tz.ParseInstant(b.End)
	return slots.Fields(start, end)
}

// syncEvent is one attempt at the calendar; the event id it answers.
func syncEvent(ctx context.Context, b *store.Booking) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	reply, err := stub.Sync(ctx, &pb.SyncRequest{BookingId: b.BookingID, ResourceId: b.ResourceID, Start: b.Start, End: b.End})
	if err != nil {
		return "", err
	}
	return reply.GetEventId(), nil
}

// confirmBooking makes the booking a calendar event and returns the booking's final state.
func confirmBooking(ctx context.Context, b *store.Booking) (string, error) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	for {
		eventID, err := syncEvent(ctx, b)
		if err != nil {
			if status.Code(err) == codes.DeadlineExceeded {
				if _, err := releaseHold(ctx, b.ResourceID, fields(b), b.HoldID); err != nil {
					return "", err
				}
				return "cancelled", store.SetState(ctx, b.BookingID, "cancelled", "")
			}
			continue
		}
		if _, err := confirmHold(ctx, b.ResourceID, fields(b), b.HoldID, b.BookingID); err != nil {
			return "", err
		}
		return "confirmed", store.SetState(ctx, b.BookingID, "confirmed", eventID)
	}
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

	pb "booking/gen/calendar"
	"booking/slots"
	"booking/store"
	"booking/tz"
)

const (
	syncDeadline    = 3 * time.Second
	maxSyncAttempts = 3
	syncUnknown     = "sync_unknown"
)

// Built in step 2 (state.go): the hold map's transitions.
var (
	confirmHold = func(ctx context.Context, resourceID string, slotFields []string, holdID, bookingID string) (int, error) {
		panic("not implemented")
	}
	releaseHold = func(ctx context.Context, resourceID string, slotFields []string, holdID string) (int, error) {
		panic("not implemented")
	}
)

var conn, _ = grpc.NewClient("calendar:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewCalendarClient(conn)

func fields(b *store.Booking) []string {
	start, _ := tz.ParseInstant(b.Start)
	end, _ := tz.ParseInstant(b.End)
	return slots.Fields(start, end)
}

func retryable(code codes.Code) bool { return code == codes.DeadlineExceeded || code == codes.Unavailable }

func permanent(code codes.Code) bool { return code == codes.InvalidArgument || code == codes.PermissionDenied }

// syncEvent is one attempt at the calendar; the key makes a retry update the one event instead of adding one.
func syncEvent(ctx context.Context, b *store.Booking) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, syncDeadline)
	defer cancel()
	reply, err := stub.Sync(ctx, &pb.SyncRequest{
		BookingId: b.BookingID, IdempotencyKey: b.IdempotencyKey, ResourceId: b.ResourceID, Start: b.Start, End: b.End,
	})
	if err != nil {
		return "", err
	}
	return reply.GetEventId(), nil
}

// reconcileEvent is the event the calendar holds under the key, if any: asked before the booking is touched.
func reconcileEvent(ctx context.Context, idempotencyKey string) (string, bool, error) {
	ctx, cancel := context.WithTimeout(ctx, syncDeadline)
	defer cancel()
	reply, err := stub.GetEvent(ctx, &pb.GetEventRequest{IdempotencyKey: idempotencyKey})
	if err != nil {
		return "", false, err
	}
	return reply.GetEventId(), reply.GetFound(), nil
}

func confirmed(ctx context.Context, b *store.Booking, eventID string) error {
	if _, err := confirmHold(ctx, b.ResourceID, fields(b), b.HoldID, b.BookingID); err != nil {
		return err
	}
	return store.SetState(ctx, b.BookingID, "confirmed", eventID)
}

func released(ctx context.Context, b *store.Booking, state string) (string, error) {
	if _, err := releaseHold(ctx, b.ResourceID, fields(b), b.HoldID); err != nil {
		return "", err
	}
	return state, store.SetState(ctx, b.BookingID, state, "")
}

// confirmBooking makes the booking a calendar event and returns the booking's final state.
func confirmBooking(ctx context.Context, b *store.Booking) (string, error) {
	for attempt := 0; attempt < maxSyncAttempts; attempt++ {
		eventID, err := syncEvent(ctx, b)
		if err == nil {
			return "confirmed", confirmed(ctx, b, eventID)
		}
		code := status.Code(err)
		if permanent(code) {
			// The calendar refused this booking for good and created nothing: give the slots back now
			// instead of leaking them for the rest of the payment window.
			return released(ctx, b, "rejected")
		}
		if !retryable(code) {
			return "", err
		}
	}

	// Every attempt timed out or found the calendar down: the event may exist, so say so and ask.
	if err := store.SetState(ctx, b.BookingID, syncUnknown, ""); err != nil {
		return "", err
	}
	eventID, found, err := reconcileEvent(ctx, b.IdempotencyKey)
	if err != nil {
		return "", err
	}
	if !found {
		return released(ctx, b, "cancelled")
	}
	return "reconciled", confirmed(ctx, b, eventID)
}
`,
    },
    scala: {
      starter: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import booking.{Booking, Slots, Store, Tz}
import booking.calendar.{CalendarGrpc, GetEventRequest, SyncRequest}

object CalendarClient {
  private val channel = ManagedChannelBuilder.forAddress("calendar", 9000).usePlaintext().build()
  private val stub = CalendarGrpc.blockingStub(channel)

  private def fields(booking: Booking): Seq[String] =
    Slots.fields(Tz.parseInstant(booking.start).getOrElse(0L), Tz.parseInstant(booking.end).getOrElse(0L))

  /** One attempt at the calendar; the event id it answers. */
  def syncEvent(booking: Booking): String =
    stub
      .withDeadlineAfter(1000L, TimeUnit.MILLISECONDS)
      .sync(SyncRequest(bookingId = booking.booking_id, resourceId = booking.resource_id, start = booking.start, end = booking.end))
      .eventId

  /** The booking becomes a calendar event; returns the booking's final state. */
  def confirmBooking(booking: Booking): String = {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    while (true) {
      try {
        val eventId = syncEvent(booking)
        HoldMap.confirmHold(booking.resource_id, fields(booking), booking.hold_id, booking.booking_id) // step 2
        Store.setState(booking.booking_id, "confirmed", eventId)
        return "confirmed"
      } catch {
        case e: StatusRuntimeException if e.getStatus.getCode == Status.Code.DEADLINE_EXCEEDED =>
          HoldMap.releaseHold(booking.resource_id, fields(booking), booking.hold_id)
          Store.setState(booking.booking_id, "cancelled")
          return "cancelled"
        case _: StatusRuntimeException => ()
      }
    }
    "confirmed"
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import booking.{Booking, Slots, Store, Tz}
import booking.calendar.{CalendarGrpc, GetEventRequest, SyncRequest}

object CalendarClient {
  val SyncDeadlineMs = 3000L
  val MaxSyncAttempts = 3
  val SyncUnknown = "sync_unknown"
  private val Retryable = Set(Status.Code.DEADLINE_EXCEEDED, Status.Code.UNAVAILABLE)
  private val Permanent = Set(Status.Code.INVALID_ARGUMENT, Status.Code.PERMISSION_DENIED)

  private val channel = ManagedChannelBuilder.forAddress("calendar", 9000).usePlaintext().build()
  private val stub = CalendarGrpc.blockingStub(channel)

  private def fields(booking: Booking): Seq[String] =
    Slots.fields(Tz.parseInstant(booking.start).getOrElse(0L), Tz.parseInstant(booking.end).getOrElse(0L))

  /** One attempt at the calendar; the key makes a retry update the one event instead of adding one. */
  def syncEvent(booking: Booking): String =
    stub
      .withDeadlineAfter(SyncDeadlineMs, TimeUnit.MILLISECONDS)
      .sync(
        SyncRequest(
          bookingId = booking.booking_id,
          idempotencyKey = booking.idempotency_key,
          resourceId = booking.resource_id,
          start = booking.start,
          end = booking.end
        )
      )
      .eventId

  /** The event the calendar holds under the key, if any: asked before the booking is touched. */
  def reconcileEvent(idempotencyKey: String): Option[String] = {
    val reply = stub.withDeadlineAfter(SyncDeadlineMs, TimeUnit.MILLISECONDS).getEvent(GetEventRequest(idempotencyKey = idempotencyKey))
    if (reply.found) Some(reply.eventId) else None
  }

  private def confirmed(booking: Booking, eventId: String): Unit = {
    HoldMap.confirmHold(booking.resource_id, fields(booking), booking.hold_id, booking.booking_id) // step 2
    Store.setState(booking.booking_id, "confirmed", eventId)
  }

  private def released(booking: Booking, state: String): String = {
    HoldMap.releaseHold(booking.resource_id, fields(booking), booking.hold_id)
    Store.setState(booking.booking_id, state)
    state
  }

  /** The booking becomes a calendar event; returns the booking's final state. */
  def confirmBooking(booking: Booking): String = {
    var attempt = 0
    while (attempt < MaxSyncAttempts) {
      attempt += 1
      try {
        confirmed(booking, syncEvent(booking))
        return "confirmed"
      } catch {
        case e: StatusRuntimeException if Permanent(e.getStatus.getCode) =>
          // The calendar refused this booking for good and created nothing: give the slots back now
          // instead of leaking them for the rest of the payment window.
          return released(booking, "rejected")
        case e: StatusRuntimeException if Retryable(e.getStatus.getCode) => ()
      }
    }
    // Every attempt timed out or found the calendar down: the event may exist, so say so and ask.
    Store.setState(booking.booking_id, SyncUnknown)
    reconcileEvent(booking.idempotency_key) match {
      case None => released(booking, "cancelled")
      case Some(eventId) =>
        confirmed(booking, eventId)
        "reconciled"
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <string>
#include <vector>

#include "booking/slots.h"
#include "booking/store.h"
#include "booking/tz.h"
#include "calendar.grpc.pb.h"

// Built in step 2 (state.cpp): the hold map's transitions.
long long confirmHold(const std::string& resource_id, const std::vector<std::string>& slot_fields,
                      const std::string& hold_id, const std::string& booking_id);
long long releaseHold(const std::string& resource_id, const std::vector<std::string>& slot_fields,
                      const std::string& hold_id);

auto channel = grpc::CreateChannel("calendar:9000", grpc::InsecureChannelCredentials());
auto stub = booking::Calendar::NewStub(channel);

static std::vector<std::string> fields(const booking::Booking& b) {
  return booking::slots::Fields(booking::tz::ParseInstant(b.start).value_or(0), booking::tz::ParseInstant(b.end).value_or(0));
}

// One attempt at the calendar: the status, and the event id it answered.
grpc::Status syncEvent(const booking::Booking& b, std::string& event_id) {
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(1));
  booking::SyncRequest request;
  request.set_booking_id(b.booking_id);
  request.set_resource_id(b.resource_id);
  request.set_start(b.start);
  request.set_end(b.end);
  booking::SyncReply reply;
  const grpc::Status status = stub->Sync(&ctx, request, &reply);
  if (status.ok()) event_id = reply.event_id();
  return status;
}

// The booking becomes a calendar event; returns the booking's final state.
std::string confirmBooking(const booking::Booking& b) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  while (true) {
    std::string event_id;
    const grpc::Status status = syncEvent(b, event_id);
    if (status.ok()) {
      confirmHold(b.resource_id, fields(b), b.hold_id, b.booking_id);
      booking::store::SetState(b.booking_id, "confirmed", event_id);
      return "confirmed";
    }
    if (status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED) {
      releaseHold(b.resource_id, fields(b), b.hold_id);
      booking::store::SetState(b.booking_id, "cancelled");
      return "cancelled";
    }
  }
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <optional>
#include <string>
#include <vector>

#include "booking/slots.h"
#include "booking/store.h"
#include "booking/tz.h"
#include "calendar.grpc.pb.h"

constexpr std::chrono::milliseconds kSyncDeadline{3000};
constexpr int kMaxSyncAttempts = 3;
const std::string kSyncUnknown = "sync_unknown";

// Built in step 2 (state.cpp): the hold map's transitions.
long long confirmHold(const std::string& resource_id, const std::vector<std::string>& slot_fields,
                      const std::string& hold_id, const std::string& booking_id);
long long releaseHold(const std::string& resource_id, const std::vector<std::string>& slot_fields,
                      const std::string& hold_id);

auto channel = grpc::CreateChannel("calendar:9000", grpc::InsecureChannelCredentials());
auto stub = booking::Calendar::NewStub(channel);

static std::vector<std::string> fields(const booking::Booking& b) {
  return booking::slots::Fields(booking::tz::ParseInstant(b.start).value_or(0), booking::tz::ParseInstant(b.end).value_or(0));
}

static bool retryable(grpc::StatusCode code) {
  return code == grpc::StatusCode::DEADLINE_EXCEEDED || code == grpc::StatusCode::UNAVAILABLE;
}

static bool permanent(grpc::StatusCode code) {
  return code == grpc::StatusCode::INVALID_ARGUMENT || code == grpc::StatusCode::PERMISSION_DENIED;
}

// One attempt at the calendar: the status, and the event id it answered. The key makes a retry
// update the one event instead of adding one.
grpc::Status syncEvent(const booking::Booking& b, std::string& event_id) {
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kSyncDeadline);
  booking::SyncRequest request;
  request.set_booking_id(b.booking_id);
  request.set_idempotency_key(b.idempotency_key);
  request.set_resource_id(b.resource_id);
  request.set_start(b.start);
  request.set_end(b.end);
  booking::SyncReply reply;
  const grpc::Status status = stub->Sync(&ctx, request, &reply);
  if (status.ok()) event_id = reply.event_id();
  return status;
}

// The event the calendar holds under the key, if any: asked before the booking is touched. A failed
// GetEvent answers neither found nor not found, so it throws and the booking stays sync_unknown.
std::optional<std::string> reconcileEvent(const std::string& idempotency_key) {
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kSyncDeadline);
  booking::GetEventRequest request;
  request.set_idempotency_key(idempotency_key);
  booking::GetEventReply reply;
  const grpc::Status status = stub->GetEvent(&ctx, request, &reply);
  if (!status.ok()) throw std::runtime_error(status.error_message());
  if (!reply.found()) return std::nullopt;
  return reply.event_id();
}

static void confirmed(const booking::Booking& b, const std::string& event_id) {
  confirmHold(b.resource_id, fields(b), b.hold_id, b.booking_id);
  booking::store::SetState(b.booking_id, "confirmed", event_id);
}

static std::string released(const booking::Booking& b, const std::string& state) {
  releaseHold(b.resource_id, fields(b), b.hold_id);
  booking::store::SetState(b.booking_id, state);
  return state;
}

// The booking becomes a calendar event; returns the booking's final state.
std::string confirmBooking(const booking::Booking& b) {
  for (int attempt = 0; attempt < kMaxSyncAttempts; attempt++) {
    std::string event_id;
    const grpc::Status status = syncEvent(b, event_id);
    if (status.ok()) {
      confirmed(b, event_id);
      return "confirmed";
    }
    // The calendar refused this booking for good and created nothing: give the slots back now
    // instead of leaking them for the rest of the payment window.
    if (permanent(status.error_code())) return released(b, "rejected");
    if (!retryable(status.error_code())) throw std::runtime_error(status.error_message());
  }

  // Every attempt timed out or found the calendar down: the event may exist, so say so and ask.
  booking::store::SetState(b.booking_id, kSyncUnknown);
  const auto event_id = reconcileEvent(b.idempotency_key);
  if (!event_id) return released(b, "cancelled");
  confirmed(b, *event_id);
  return "reconciled";
}
`,
    },
  },
  harness: {
    python: `import grpc

import calendar_pb2
import calendar_pb2_grpc
from booking.slots import hold_key, slot_fields, slots_key
from booking.store import store
from booking.tz import parse_instant

BOOKING = {
    "booking_id": "b-1",
    "tenant": "t1",
    "resource_id": "r1",
    "start": "2026-03-10T09:00:00Z",
    "end": "2026-03-10T10:00:00Z",
    "hold_id": "h-1",
    "idempotency_key": "k-1",
    "state": "held",
}
FIELDS = slot_fields(parse_instant(BOOKING["start"]), parse_instant(BOOKING["end"]))


class FakeCalendar(calendar_pb2_grpc.CalendarServicer):
    """One event per idempotency key; a sync without a key creates a new event every time."""

    def __init__(self, ctx):
        self.ctx = ctx
        self.events = {}
        self.created = 0
        self.state_at_get_event = None

    def Sync(self, request, context):
        self.created += 1
        if request.idempotency_key == "":
            return calendar_pb2.SyncReply(event_id=f"evt-{self.created}")
        event_id = self.events.setdefault(request.idempotency_key, f"evt-{self.created}")
        return calendar_pb2.SyncReply(event_id=event_id)

    def GetEvent(self, request, context):
        self.state_at_get_event = self.ctx.redis.hget("booking:b-1", "state")
        event_id = self.events.get(request.idempotency_key)
        return calendar_pb2.GetEventReply(found=event_id is not None, event_id=event_id or "")


def _hold(ctx):
    """The booking held again: its slots in the map, its hold key alive, its row in the store."""
    for f in FIELDS:
        ctx.redis.hset(slots_key("r1"), f, "h-1")
    ctx.redis.set(hold_key("h-1"), "held", ex=900)
    store.put(BOOKING)


def _world(ctx):
    """A held booking in the store and the map, and the calendar the harness serves."""
    calendar = FakeCalendar(ctx)
    ctx.grpc.serve(calendar_pb2_grpc.add_CalendarServicer_to_server, calendar)
    _hold(ctx)
    return ctx.load("client"), calendar


def _confirm(ctx, m):
    result = ctx.drain(m.confirm_booking, dict(BOOKING))
    assert result is not None, "confirm_booking never returned: it kept retrying until the runtime stopped it"
    return result


def _state(ctx):
    return ctx.redis.hgetall("booking:b-1")


def _owners(ctx):
    return [ctx.redis.hget(slots_key("r1"), f) for f in FIELDS]


def check_deadline(ctx):
    m, calendar = _world(ctx)
    ctx.grpc.set_latency("Sync", 2.0)
    result = _confirm(ctx, m)
    assert result == "confirmed", f"a calendar that answers in 2 s ended the booking {result!r}, expected confirmed: the deadline per attempt is 3000 ms"
    call = ctx.grpc.calls_to("Sync")[0]
    assert call.timeout is not None, "the Sync call carries no deadline: a hanging calendar would hold the request and the payment window open"
    assert 2.5 <= call.timeout <= 3.5, f"the Sync deadline is {call.timeout} s, expected about 3 s"
    assert _state(ctx).get("state") == "confirmed" and _state(ctx).get("event_id") == "evt-1", f"the stored booking is {_state(ctx)}, expected state confirmed with event_id evt-1"
    assert _owners(ctx) == ["booked:b-1"] * len(FIELDS), f"after confirmation the slots point at {_owners(ctx)}, expected booked:b-1"
    # A calendar that never answers in time: every attempt, the retries included, gets its own 3 s.
    _hold(ctx)
    ctx.grpc.set_latency("Sync", 5.0)
    ctx.drain(m.confirm_booking, dict(BOOKING))
    timeouts = [c.timeout for c in ctx.grpc.calls_to("Sync")[1:]]
    assert all(t is not None and 2.5 <= t <= 3.5 for t in timeouts), f"against a calendar that never answers in time the Sync deadlines were {timeouts} s, expected about 3 s on every attempt: a retry needs a deadline of its own, not what is left of the first one's"


def check_idempotency_key(ctx):
    m, calendar = _world(ctx)
    ctx.grpc.fail("Sync", grpc.StatusCode.UNAVAILABLE, "calendar restarting", times=1)
    result = _confirm(ctx, m)
    assert result == "confirmed", f"a calendar that was UNAVAILABLE once ended the booking {result!r}, expected confirmed after a retry"
    calls = ctx.grpc.calls_to("Sync")
    assert len(calls) == 2, f"one failure then success should be 2 Sync calls, got {len(calls)}"
    keys = [c.request.idempotency_key for c in calls]
    assert keys == ["k-1", "k-1"], f"the Sync requests carried idempotency_key {keys}, expected the booking's k-1 on every attempt"
    assert calendar.created == 1 and calendar.events == {"k-1": "evt-1"}, f"the calendar created {calendar.created} events for one booking: a retry without the key is a second invitation"


def check_timeout_reconcile(ctx):
    m, calendar = _world(ctx)
    # The first sync reached the calendar, its answer did not come back: the event exists.
    calendar.events["k-1"] = "evt-7"
    ctx.grpc.set_latency("Sync", 5.0)
    result = _confirm(ctx, m)
    assert result != "cancelled", "every attempt timed out and the booking was cancelled: the calendar has the event, the guest will arrive to a booking the system forgot. Ask GetEvent first"
    assert result == "reconciled", f"confirm_booking returned {result!r}, expected reconciled"
    calls = len(ctx.grpc.calls_to("Sync"))
    assert calls == 3, f"every Sync timed out and {calls} were made, expected 3 attempts, each with a deadline of its own"
    gets = ctx.grpc.calls_to("GetEvent")
    assert len(gets) == 1 and gets[0].request.idempotency_key == "k-1", f"GetEvent must be asked once by the booking's key, got {[(c.request.idempotency_key) for c in gets]}"
    assert calendar.state_at_get_event == "sync_unknown", f"when GetEvent was asked the booking's state was {calendar.state_at_get_event!r}, expected sync_unknown: record the unknown state before reconciling, so a crash mid-way leaves a booking a sweeper can find"
    assert _state(ctx).get("state") == "confirmed" and _state(ctx).get("event_id") == "evt-7", f"the stored booking is {_state(ctx)}, expected confirmed with the calendar's event evt-7"
    assert _owners(ctx) == ["booked:b-1"] * len(FIELDS), f"the slots point at {_owners(ctx)}, expected booked:b-1"
    # Every attempt times out again, and GetEvent itself fails: the event may or may not exist.
    _hold(ctx)
    ctx.grpc.fail("GetEvent", grpc.StatusCode.UNAVAILABLE, "calendar down", times=10)
    try:
        result = ctx.drain(m.confirm_booking, dict(BOOKING))
    except Exception:
        result = None  # the error reaching the caller is fine
    assert result != "cancelled" and _state(ctx).get("state") == "sync_unknown", f"GetEvent failed and the booking ended {result!r} with state {_state(ctx).get('state')!r}: a failed GetEvent says nothing about the event, so the booking stays sync_unknown for a sweeper"
    assert _owners(ctx) == ["h-1"] * len(FIELDS) and ctx.redis.exists(hold_key("h-1")) == 1, f"GetEvent failed and the slots point at {_owners(ctx)}: the hold must stay until the calendar answers"


def check_non_retryable_release(ctx):
    m, calendar = _world(ctx)
    ctx.grpc.fail("Sync", grpc.StatusCode.INVALID_ARGUMENT, "resource unknown to this calendar", times=1)
    result = _confirm(ctx, m)
    assert len(ctx.grpc.calls_to("Sync")) == 1, f"INVALID_ARGUMENT is a verdict, not a retryable failure: {len(ctx.grpc.calls_to('Sync'))} Sync calls were made"
    assert result == "rejected", f"confirm_booking returned {result!r}, expected rejected"
    assert ctx.redis.hgetall(slots_key("r1")) == {}, f"the refused booking still holds {ctx.redis.hgetall(slots_key('r1'))}: release the hold, or the slots stay blocked for the rest of the payment window"
    assert ctx.redis.exists(hold_key("h-1")) == 0, "the hold key must be gone after the release"
    assert _state(ctx).get("state") == "rejected", f"the stored booking is {_state(ctx)}, expected state rejected"
    # PERMISSION_DENIED is the calendar's other verdict.
    _hold(ctx)
    ctx.grpc.fail("Sync", grpc.StatusCode.PERMISSION_DENIED, "calendar not shared with this tenant", times=1)
    result = _confirm(ctx, m)
    assert len(ctx.grpc.calls_to("Sync")) == 2, f"PERMISSION_DENIED is a verdict, not a retryable failure: {len(ctx.grpc.calls_to('Sync')) - 1} Sync calls were made for it"
    assert result == "rejected", f"after PERMISSION_DENIED confirm_booking returned {result!r}, expected rejected"
    assert ctx.redis.hgetall(slots_key("r1")) == {}, f"the booking refused with PERMISSION_DENIED still holds {ctx.redis.hgetall(slots_key('r1'))}: release the hold"
    assert _state(ctx).get("state") == "rejected", f"after PERMISSION_DENIED the stored booking is {_state(ctx)}, expected state rejected"


def check_bounded_retry(ctx):
    m, calendar = _world(ctx)
    # Only DEADLINE_EXCEEDED and UNAVAILABLE are retried: an INTERNAL error is not.
    ctx.grpc.fail("Sync", grpc.StatusCode.INTERNAL, "calendar bug", times=1)
    try:
        ctx.drain(m.confirm_booking, dict(BOOKING))
    except Exception:
        pass  # the error reaching the caller is fine
    made = len(ctx.grpc.calls_to("Sync"))
    assert made == 1, f"an INTERNAL failure got {made} Sync calls, expected 1: only DEADLINE_EXCEEDED and UNAVAILABLE are retried"
    _hold(ctx)
    gets_before = len(ctx.grpc.calls_to("GetEvent"))
    ctx.grpc.fail("Sync", grpc.StatusCode.UNAVAILABLE, "calendar down", times=10)
    result = _confirm(ctx, m)
    calls = len(ctx.grpc.calls_to("Sync")) - made
    assert calls == 3, f"a calendar that stays UNAVAILABLE got {calls} Sync calls, expected exactly 3 attempts"
    assert result == "cancelled", f"confirm_booking returned {result!r}, expected cancelled: GetEvent found no event"
    gets = len(ctx.grpc.calls_to("GetEvent")) - gets_before
    assert gets == 1 and calendar.state_at_get_event == "sync_unknown", f"after three UNAVAILABLE attempts GetEvent was asked {gets} times with the booking {calendar.state_at_get_event!r}, expected once with sync_unknown: an earlier attempt may have reached the calendar before the connection dropped"
    assert ctx.redis.hgetall(slots_key("r1")) == {}, f"the cancelled booking still holds {ctx.redis.hgetall(slots_key('r1'))}"
    assert _state(ctx).get("state") == "cancelled", f"the stored booking is {_state(ctx)}, expected state cancelled"
`,
    typescript: `import {holdKey, slotFields, slotsKey} from 'booking/slots';
import {store} from 'booking/store';
import {parseInstant} from 'booking/tz';

const BOOKING = {
  booking_id: 'b-1',
  tenant: 't1',
  resource_id: 'r1',
  start: '2026-03-10T09:00:00Z',
  end: '2026-03-10T10:00:00Z',
  hold_id: 'h-1',
  idempotency_key: 'k-1',
  state: 'held',
  event_id: '',
};
const FIELDS = slotFields(parseInstant(BOOKING.start), parseInstant(BOOKING.end));

/** A held booking in the store and the map, and the calendar the harness serves: one event per idempotency key. */
async function world(ctx) {
  const calendar = {events: new Map<string, string>(), created: 0, stateAtGetEvent: null as string | null};
  const pkg = ctx.proto('calendar.proto');
  ctx.grpc.serve(pkg.booking.Calendar.service, {
    Sync(call, callback) {
      calendar.created += 1;
      const key = call.request.idempotency_key;
      if (key === '') return callback(null, {event_id: \`evt-\${calendar.created}\`});
      if (!calendar.events.has(key)) calendar.events.set(key, \`evt-\${calendar.created}\`);
      callback(null, {event_id: calendar.events.get(key)});
    },
    GetEvent(call, callback) {
      calendar.stateAtGetEvent = ctx.redis.hget('booking:b-1', 'state');
      const eventId = calendar.events.get(call.request.idempotency_key);
      callback(null, {found: eventId !== undefined, event_id: eventId ?? ''});
    },
  });
  await hold(ctx);
  return {m: ctx.load('client'), calendar};
}

/** The booking held again: its slots in the map, its hold key alive, its row in the store. */
async function hold(ctx) {
  for (const f of FIELDS) ctx.redis.hset(slotsKey('r1'), f, 'h-1');
  ctx.redis.set(holdKey('h-1'), 'held', 'EX', 900);
  await store.put({...BOOKING});
}

async function confirm(ctx, m): Promise<string> {
  const result = await ctx.drain(m.confirmBooking({...BOOKING}));
  assert(result !== undefined, 'confirmBooking never resolved: it kept retrying until the runtime stopped it');
  return result;
}

const state = ctx => ctx.redis.hgetall('booking:b-1');
const owners = ctx => FIELDS.map(f => ctx.redis.hget(slotsKey('r1'), f));
const booked = (): string[] => FIELDS.map(() => 'booked:b-1');

export async function check_deadline(ctx) {
  const {m} = await world(ctx);
  ctx.grpc.setLatency('Sync', 2.0);
  const result = await confirm(ctx, m);
  assert.equal(result, 'confirmed', \`a calendar that answers in 2 s ended the booking \${JSON.stringify(result)}, expected confirmed: the deadline per attempt is 3000 ms\`);
  const call = ctx.grpc.callsTo('Sync')[0];
  assert(call.timeout !== null, 'the Sync call carries no deadline: a hanging calendar would hold the request and the payment window open');
  assert(2.5 <= call.timeout && call.timeout <= 3.5, \`the Sync deadline is \${call.timeout} s, expected about 3 s\`);
  assert(state(ctx).state === 'confirmed' && state(ctx).event_id === 'evt-1', \`the stored booking is \${JSON.stringify(state(ctx))}, expected state confirmed with event_id evt-1\`);
  assert.deepEqual(owners(ctx), booked(), \`after confirmation the slots point at \${JSON.stringify(owners(ctx))}, expected booked:b-1\`);
  // A calendar that never answers in time: every attempt, the retries included, gets its own 3 s.
  await hold(ctx);
  ctx.grpc.setLatency('Sync', 5.0);
  await ctx.drain(m.confirmBooking({...BOOKING}));
  const timeouts = ctx.grpc.callsTo('Sync').slice(1).map(c => c.timeout);
  assert(timeouts.every(t => t !== null && 2.5 <= t && t <= 3.5), \`against a calendar that never answers in time the Sync deadlines were \${JSON.stringify(timeouts)} s, expected about 3 s on every attempt: a retry needs a deadline of its own, not what is left of the first one's\`);
}

export async function check_idempotency_key(ctx) {
  const {m, calendar} = await world(ctx);
  ctx.grpc.fail('Sync', ctx.grpc.status.UNAVAILABLE, 'calendar restarting', 1);
  const result = await confirm(ctx, m);
  assert.equal(result, 'confirmed', \`a calendar that was UNAVAILABLE once ended the booking \${JSON.stringify(result)}, expected confirmed after a retry\`);
  const calls = ctx.grpc.callsTo('Sync');
  assert.equal(calls.length, 2, \`one failure then success should be 2 Sync calls, got \${calls.length}\`);
  const keys = calls.map(c => c.request.idempotency_key);
  assert.deepEqual(keys, ['k-1', 'k-1'], \`the Sync requests carried idempotency_key \${JSON.stringify(keys)}, expected the booking's k-1 on every attempt\`);
  assert(calendar.created === 1 && calendar.events.get('k-1') === 'evt-1', \`the calendar created \${calendar.created} events for one booking: a retry without the key is a second invitation\`);
}

export async function check_timeout_reconcile(ctx) {
  const {m, calendar} = await world(ctx);
  // The first sync reached the calendar, its answer did not come back: the event exists.
  calendar.events.set('k-1', 'evt-7');
  ctx.grpc.setLatency('Sync', 5.0);
  const result = await confirm(ctx, m);
  assert(result !== 'cancelled', 'every attempt timed out and the booking was cancelled: the calendar has the event, the guest will arrive to a booking the system forgot. Ask GetEvent first');
  assert.equal(result, 'reconciled', \`confirmBooking resolved \${JSON.stringify(result)}, expected reconciled\`);
  const calls = ctx.grpc.callsTo('Sync').length;
  assert.equal(calls, 3, \`every Sync timed out and \${calls} were made, expected 3 attempts, each with a deadline of its own\`);
  const gets = ctx.grpc.callsTo('GetEvent');
  assert(gets.length === 1 && gets[0].request.idempotency_key === 'k-1', \`GetEvent must be asked once by the booking's key, got \${JSON.stringify(gets.map(c => c.request.idempotency_key))}\`);
  assert.equal(calendar.stateAtGetEvent, 'sync_unknown', \`when GetEvent was asked the booking's state was \${JSON.stringify(calendar.stateAtGetEvent)}, expected sync_unknown: record the unknown state before reconciling, so a crash mid-way leaves a booking a sweeper can find\`);
  assert(state(ctx).state === 'confirmed' && state(ctx).event_id === 'evt-7', \`the stored booking is \${JSON.stringify(state(ctx))}, expected confirmed with the calendar's event evt-7\`);
  assert.deepEqual(owners(ctx), booked(), \`the slots point at \${JSON.stringify(owners(ctx))}, expected booked:b-1\`);
  // Every attempt times out again, and GetEvent itself fails: the event may or may not exist.
  await hold(ctx);
  ctx.grpc.fail('GetEvent', ctx.grpc.status.UNAVAILABLE, 'calendar down', 10);
  const unknown = await ctx.drain(m.confirmBooking({...BOOKING})).catch(() => null); // the error reaching the caller is fine
  assert(unknown !== 'cancelled' && state(ctx).state === 'sync_unknown', \`GetEvent failed and the booking ended \${JSON.stringify(unknown)} with state \${JSON.stringify(state(ctx).state)}: a failed GetEvent says nothing about the event, so the booking stays sync_unknown for a sweeper\`);
  assert(owners(ctx).every(o => o === 'h-1') && ctx.redis.exists(holdKey('h-1')) === 1, \`GetEvent failed and the slots point at \${JSON.stringify(owners(ctx))}: the hold must stay until the calendar answers\`);
}

export async function check_non_retryable_release(ctx) {
  const {m} = await world(ctx);
  ctx.grpc.fail('Sync', ctx.grpc.status.INVALID_ARGUMENT, 'resource unknown to this calendar', 1);
  const result = await confirm(ctx, m);
  assert.equal(ctx.grpc.callsTo('Sync').length, 1, \`INVALID_ARGUMENT is a verdict, not a retryable failure: \${ctx.grpc.callsTo('Sync').length} Sync calls were made\`);
  assert.equal(result, 'rejected', \`confirmBooking resolved \${JSON.stringify(result)}, expected rejected\`);
  assert.deepEqual(ctx.redis.hgetall(slotsKey('r1')), {}, \`the refused booking still holds \${JSON.stringify(ctx.redis.hgetall(slotsKey('r1')))}: release the hold, or the slots stay blocked for the rest of the payment window\`);
  assert.equal(ctx.redis.exists(holdKey('h-1')), 0, 'the hold key must be gone after the release');
  assert.equal(state(ctx).state, 'rejected', \`the stored booking is \${JSON.stringify(state(ctx))}, expected state rejected\`);
  // PERMISSION_DENIED is the calendar's other verdict.
  await hold(ctx);
  ctx.grpc.fail('Sync', ctx.grpc.status.PERMISSION_DENIED, 'calendar not shared with this tenant', 1);
  const denied = await confirm(ctx, m);
  assert.equal(ctx.grpc.callsTo('Sync').length, 2, \`PERMISSION_DENIED is a verdict, not a retryable failure: \${ctx.grpc.callsTo('Sync').length - 1} Sync calls were made for it\`);
  assert.equal(denied, 'rejected', \`after PERMISSION_DENIED confirmBooking resolved \${JSON.stringify(denied)}, expected rejected\`);
  assert.deepEqual(ctx.redis.hgetall(slotsKey('r1')), {}, \`the booking refused with PERMISSION_DENIED still holds \${JSON.stringify(ctx.redis.hgetall(slotsKey('r1')))}: release the hold\`);
  assert.equal(state(ctx).state, 'rejected', \`after PERMISSION_DENIED the stored booking is \${JSON.stringify(state(ctx))}, expected state rejected\`);
}

export async function check_bounded_retry(ctx) {
  const {m, calendar} = await world(ctx);
  // Only DEADLINE_EXCEEDED and UNAVAILABLE are retried: an INTERNAL error is not.
  ctx.grpc.fail('Sync', ctx.grpc.status.INTERNAL, 'calendar bug', 1);
  await ctx.drain(m.confirmBooking({...BOOKING})).catch(() => undefined); // the error reaching the caller is fine
  const made = ctx.grpc.callsTo('Sync').length;
  assert.equal(made, 1, \`an INTERNAL failure got \${made} Sync calls, expected 1: only DEADLINE_EXCEEDED and UNAVAILABLE are retried\`);
  await hold(ctx);
  const getsBefore = ctx.grpc.callsTo('GetEvent').length;
  ctx.grpc.fail('Sync', ctx.grpc.status.UNAVAILABLE, 'calendar down', 10);
  const result = await confirm(ctx, m);
  const calls = ctx.grpc.callsTo('Sync').length - made;
  assert.equal(calls, 3, \`a calendar that stays UNAVAILABLE got \${calls} Sync calls, expected exactly 3 attempts\`);
  assert.equal(result, 'cancelled', \`confirmBooking resolved \${JSON.stringify(result)}, expected cancelled: GetEvent found no event\`);
  const gets = ctx.grpc.callsTo('GetEvent').length - getsBefore;
  assert(gets === 1 && calendar.stateAtGetEvent === 'sync_unknown', \`after three UNAVAILABLE attempts GetEvent was asked \${gets} times with the booking \${JSON.stringify(calendar.stateAtGetEvent)}, expected once with sync_unknown: an earlier attempt may have reached the calendar before the connection dropped\`);
  assert.deepEqual(ctx.redis.hgetall(slotsKey('r1')), {}, \`the cancelled booking still holds \${JSON.stringify(ctx.redis.hgetall(slotsKey('r1')))}\`);
  assert.equal(state(ctx).state, 'cancelled', \`the stored booking is \${JSON.stringify(state(ctx))}, expected state cancelled\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"time"

	"google.golang.org/grpc/codes"

	"leetbuild/harness"

	pb "booking/gen/calendar"
	"booking/slots"
	"booking/store"
	"booking/tz"
)

var clientBooking = store.Booking{
	BookingID: "b-1", Tenant: "t1", ResourceID: "r1", Start: "2026-03-10T09:00:00Z", End: "2026-03-10T10:00:00Z",
	HoldID: "h-1", IdempotencyKey: "k-1", State: "held",
}

func clientFields() []string {
	start, _ := tz.ParseInstant(clientBooking.Start)
	end, _ := tz.ParseInstant(clientBooking.End)
	return slots.Fields(start, end)
}

// calendarPeer keeps one event per idempotency key; a sync without a key creates a new event every time.
type calendarPeer struct {
	pb.UnimplementedCalendarServer
	ctx             *harness.Ctx
	events          map[string]string
	created         int
	stateAtGetEvent string
}

func (c *calendarPeer) Sync(_ context.Context, req *pb.SyncRequest) (*pb.SyncReply, error) {
	c.created++
	if req.GetIdempotencyKey() == "" {
		return &pb.SyncReply{EventId: fmt.Sprintf("evt-%d", c.created)}, nil
	}
	if _, ok := c.events[req.GetIdempotencyKey()]; !ok {
		c.events[req.GetIdempotencyKey()] = fmt.Sprintf("evt-%d", c.created)
	}
	return &pb.SyncReply{EventId: c.events[req.GetIdempotencyKey()]}, nil
}

func (c *calendarPeer) GetEvent(_ context.Context, req *pb.GetEventRequest) (*pb.GetEventReply, error) {
	c.stateAtGetEvent, _ = c.ctx.Redis.HGet("booking:b-1", "state")
	eventID, found := c.events[req.GetIdempotencyKey()]
	return &pb.GetEventReply{Found: found, EventId: eventID}, nil
}

// clientWorld is a held booking in the store and the map, the calendar the harness serves, and step
// 2's transitions, which the harness stands in for.
func clientWorld(ctx *harness.Ctx) *calendarPeer {
	calendar := &calendarPeer{ctx: ctx, events: map[string]string{}}
	pb.RegisterCalendarServer(ctx.GRPC.Server(""), calendar)
	clientHold(ctx)
	confirmHold = func(_ context.Context, resourceID string, fields []string, holdID, bookingID string) (int, error) {
		n := 0
		for _, f := range fields {
			if owner, _ := ctx.Redis.HGet(slots.Key(resourceID), f); owner == holdID {
				ctx.Redis.Do("HSET", slots.Key(resourceID), f, "booked:"+bookingID)
				n++
			}
		}
		ctx.Redis.Del(slots.HoldKey(holdID))
		return n, nil
	}
	releaseHold = func(_ context.Context, resourceID string, fields []string, holdID string) (int, error) {
		n := 0
		for _, f := range fields {
			if owner, _ := ctx.Redis.HGet(slots.Key(resourceID), f); owner == holdID {
				ctx.Redis.Do("HDEL", slots.Key(resourceID), f)
				n++
			}
		}
		ctx.Redis.Del(slots.HoldKey(holdID))
		return n, nil
	}
	return calendar
}

// clientHold holds the booking again: its slots in the map, its hold key alive, its row in the store.
func clientHold(ctx *harness.Ctx) {
	for _, f := range clientFields() {
		ctx.Redis.Do("HSET", slots.Key("r1"), f, "h-1")
	}
	ctx.Redis.Set(slots.HoldKey("h-1"), "held", "EX", 900)
	b := clientBooking
	ctx.NoError(store.Put(context.Background(), &b), "storing the booking")
}

func clientConfirm(ctx *harness.Ctx) string {
	result, err := "", error(nil)
	returned := ctx.Drain(func() {
		b := clientBooking
		result, err = confirmBooking(context.Background(), &b)
	})
	ctx.Assert(returned, "confirmBooking never returned: it kept retrying until the runtime stopped it")
	ctx.NoError(err, "confirmBooking")
	return result
}

func clientState(ctx *harness.Ctx) map[string]string { return ctx.Redis.HGetAll("booking:b-1") }

func clientOwners(ctx *harness.Ctx) []string {
	var out []string
	for _, f := range clientFields() {
		owner, _ := ctx.Redis.HGet(slots.Key("r1"), f)
		out = append(out, owner)
	}
	return out
}

func clientBooked() []string {
	var out []string
	for range clientFields() {
		out = append(out, "booked:b-1")
	}
	return out
}

func CheckDeadline(ctx *harness.Ctx) {
	clientWorld(ctx)
	ctx.GRPC.SetLatency("Sync", 2.0, "")
	result := clientConfirm(ctx)
	ctx.Equal(result, "confirmed", "a calendar that answers in 2 s must confirm the booking (the deadline per attempt is 3000 ms); the result")
	call := ctx.GRPC.CallsTo("Sync", "")[0]
	ctx.Assert(call.HasDeadline(), "the Sync call carries no deadline: a hanging calendar would hold the request and the payment window open")
	ctx.Assert(2500*time.Millisecond <= call.Timeout && call.Timeout <= 3500*time.Millisecond, "the Sync deadline is %v, expected about 3 s", call.Timeout)
	s := clientState(ctx)
	ctx.Assert(s["state"] == "confirmed" && s["event_id"] == "evt-1", "the stored booking is %v, expected state confirmed with event_id evt-1", s)
	ctx.Equal(clientOwners(ctx), clientBooked(), "the slots after confirmation")
	// A calendar that never answers in time: every attempt, the retries included, gets its own 3 s.
	clientHold(ctx)
	ctx.GRPC.SetLatency("Sync", 5.0, "")
	ctx.Drain(func() {
		b := clientBooking
		_, _ = confirmBooking(context.Background(), &b)
	})
	var timeouts []time.Duration
	ok := true
	for _, c := range ctx.GRPC.CallsTo("Sync", "")[1:] {
		timeouts = append(timeouts, c.Timeout)
		ok = ok && c.HasDeadline() && 2500*time.Millisecond <= c.Timeout && c.Timeout <= 3500*time.Millisecond
	}
	ctx.Assert(ok, "against a calendar that never answers in time the Sync deadlines were %v, expected about 3 s on every attempt: a retry needs a deadline of its own, not what is left of the first one's", timeouts)
}

func CheckIdempotencyKey(ctx *harness.Ctx) {
	calendar := clientWorld(ctx)
	ctx.GRPC.Fail("Sync", codes.Unavailable, "calendar restarting", 1, "")
	result := clientConfirm(ctx)
	ctx.Equal(result, "confirmed", "a calendar that was UNAVAILABLE once must confirm the booking after a retry; the result")
	calls := ctx.GRPC.CallsTo("Sync", "")
	ctx.Equal(len(calls), 2, "one failure then success should be 2 Sync calls; the calls")
	var keys []string
	for _, c := range calls {
		req, _ := c.Request.(*pb.SyncRequest)
		keys = append(keys, req.GetIdempotencyKey())
	}
	ctx.Equal(keys, []string{"k-1", "k-1"}, "the Sync requests must carry the booking's idempotency_key on every attempt")
	ctx.Assert(calendar.created == 1 && calendar.events["k-1"] == "evt-1", "the calendar created %d events for one booking: a retry without the key is a second invitation", calendar.created)
}

func CheckTimeoutReconcile(ctx *harness.Ctx) {
	calendar := clientWorld(ctx)
	// The first sync reached the calendar, its answer did not come back: the event exists.
	calendar.events["k-1"] = "evt-7"
	ctx.GRPC.SetLatency("Sync", 5.0, "")
	result := clientConfirm(ctx)
	ctx.Assert(result != "cancelled", "every attempt timed out and the booking was cancelled: the calendar has the event, the guest will arrive to a booking the system forgot. Ask GetEvent first")
	ctx.Equal(result, "reconciled", "confirmBooking's result")
	ctx.Equal(len(ctx.GRPC.CallsTo("Sync", "")), 3, "every Sync timed out: 3 attempts, each with a deadline of its own; the Sync calls")
	gets := ctx.GRPC.CallsTo("GetEvent", "")
	ctx.Equal(len(gets), 1, "GetEvent must be asked once by the booking's key; the calls")
	req, _ := gets[0].Request.(*pb.GetEventRequest)
	ctx.Equal(req.GetIdempotencyKey(), "k-1", "GetEvent's key")
	ctx.Equal(calendar.stateAtGetEvent, "sync_unknown", "the booking's state when GetEvent was asked (record the unknown state before reconciling, so a crash mid-way leaves a booking a sweeper can find)")
	s := clientState(ctx)
	ctx.Assert(s["state"] == "confirmed" && s["event_id"] == "evt-7", "the stored booking is %v, expected confirmed with the calendar's event evt-7", s)
	ctx.Equal(clientOwners(ctx), clientBooked(), "the slots")
	// Every attempt times out again, and GetEvent itself fails: the event may or may not exist.
	clientHold(ctx)
	ctx.GRPC.Fail("GetEvent", codes.Unavailable, "calendar down", 10, "")
	unknown := ""
	ctx.Drain(func() {
		b := clientBooking
		unknown, _ = confirmBooking(context.Background(), &b) // the error reaching the caller is fine
	})
	state := clientState(ctx)["state"]
	ctx.Assert(unknown != "cancelled" && state == "sync_unknown", "GetEvent failed and the booking ended %q with state %q: a failed GetEvent says nothing about the event, so the booking stays sync_unknown for a sweeper", unknown, state)
	held := true
	for _, o := range clientOwners(ctx) {
		held = held && o == "h-1"
	}
	ctx.Assert(held && ctx.Redis.Exists(slots.HoldKey("h-1")) == 1, "GetEvent failed and the slots point at %v: the hold must stay until the calendar answers", clientOwners(ctx))
}

func CheckNonRetryableRelease(ctx *harness.Ctx) {
	clientWorld(ctx)
	ctx.GRPC.Fail("Sync", codes.InvalidArgument, "resource unknown to this calendar", 1, "")
	result := clientConfirm(ctx)
	ctx.Equal(len(ctx.GRPC.CallsTo("Sync", "")), 1, "INVALID_ARGUMENT is a verdict, not a retryable failure; the Sync calls")
	ctx.Equal(result, "rejected", "confirmBooking's result")
	ctx.Equal(ctx.Redis.HGetAll(slots.Key("r1")), map[string]string{}, "the refused booking's slots (release the hold, or they stay blocked for the rest of the payment window)")
	ctx.Equal(ctx.Redis.Exists(slots.HoldKey("h-1")), 0, "the hold key after the release")
	ctx.Equal(clientState(ctx)["state"], "rejected", "the stored booking's state")
	// PERMISSION_DENIED is the calendar's other verdict.
	clientHold(ctx)
	ctx.GRPC.Fail("Sync", codes.PermissionDenied, "calendar not shared with this tenant", 1, "")
	result = clientConfirm(ctx)
	ctx.Equal(len(ctx.GRPC.CallsTo("Sync", ""))-1, 1, "PERMISSION_DENIED is a verdict, not a retryable failure; the Sync calls made for it")
	ctx.Equal(result, "rejected", "confirmBooking's result after PERMISSION_DENIED")
	ctx.Equal(ctx.Redis.HGetAll(slots.Key("r1")), map[string]string{}, "the slots of the booking refused with PERMISSION_DENIED (release the hold)")
	ctx.Equal(clientState(ctx)["state"], "rejected", "the stored booking's state after PERMISSION_DENIED")
}

func CheckBoundedRetry(ctx *harness.Ctx) {
	calendar := clientWorld(ctx)
	// Only DEADLINE_EXCEEDED and UNAVAILABLE are retried: an INTERNAL error is not.
	ctx.GRPC.Fail("Sync", codes.Internal, "calendar bug", 1, "")
	ctx.Drain(func() {
		b := clientBooking
		_, _ = confirmBooking(context.Background(), &b) // the error reaching the caller is fine
	})
	made := len(ctx.GRPC.CallsTo("Sync", ""))
	ctx.Equal(made, 1, "an INTERNAL failure is not retried (only DEADLINE_EXCEEDED and UNAVAILABLE are); the Sync calls")
	clientHold(ctx)
	getsBefore := len(ctx.GRPC.CallsTo("GetEvent", ""))
	ctx.GRPC.Fail("Sync", codes.Unavailable, "calendar down", 10, "")
	result := clientConfirm(ctx)
	ctx.Equal(len(ctx.GRPC.CallsTo("Sync", ""))-made, 3, "a calendar that stays UNAVAILABLE gets exactly 3 attempts; the Sync calls")
	ctx.Equal(result, "cancelled", "confirmBooking's result (GetEvent found no event)")
	gets := len(ctx.GRPC.CallsTo("GetEvent", "")) - getsBefore
	ctx.Assert(gets == 1 && calendar.stateAtGetEvent == "sync_unknown", "after three UNAVAILABLE attempts GetEvent was asked %d times with the booking %q, expected once with sync_unknown: an earlier attempt may have reached the calendar before the connection dropped", gets, calendar.stateAtGetEvent)
	ctx.Equal(ctx.Redis.HGetAll(slots.Key("r1")), map[string]string{}, "the cancelled booking's slots")
	ctx.Equal(clientState(ctx)["state"], "cancelled", "the stored booking's state")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <chrono>
#include <map>
#include <string>
#include <vector>

#include "state.cpp"

namespace {

const booking::Booking kClientBooking{"b-1", "t1", "r1", "2026-03-10T09:00:00Z", "2026-03-10T10:00:00Z",
                                      "h-1", "k-1", "held", ""};

std::vector<std::string> clientFields() {
  return booking::slots::Fields(*booking::tz::ParseInstant(kClientBooking.start), *booking::tz::ParseInstant(kClientBooking.end));
}

// One event per idempotency key; a sync without a key creates a new event every time.
class CalendarPeer final : public booking::Calendar::Service {
 public:
  explicit CalendarPeer(harness::Ctx& ctx) : ctx_(ctx) {}
  std::map<std::string, std::string> events;
  int created = 0;
  std::string stateAtGetEvent;

  grpc::Status Sync(grpc::ServerContext*, const booking::SyncRequest* req, booking::SyncReply* reply) override {
    created++;
    if (req->idempotency_key().empty()) {
      reply->set_event_id("evt-" + std::to_string(created));
      return grpc::Status::OK;
    }
    events.emplace(req->idempotency_key(), "evt-" + std::to_string(created));
    reply->set_event_id(events[req->idempotency_key()]);
    return grpc::Status::OK;
  }

  grpc::Status GetEvent(grpc::ServerContext*, const booking::GetEventRequest* req, booking::GetEventReply* reply) override {
    stateAtGetEvent = ctx_.Redis.HGet("booking:b-1", "state").value_or("");
    const auto it = events.find(req->idempotency_key());
    reply->set_found(it != events.end());
    reply->set_event_id(it == events.end() ? "" : it->second);
    return grpc::Status::OK;
  }

 private:
  harness::Ctx& ctx_;
};

// The booking held again: its slots in the map, its hold key alive, its row in the store.
void clientHold(harness::Ctx& ctx) {
  for (const auto& f : clientFields()) ctx.Redis.Do("HSET", booking::slots::Key("r1"), f, "h-1");
  ctx.Redis.Do("SET", booking::slots::HoldKey("h-1"), "held", "EX", 900);
  booking::store::Put(kClientBooking);
}

// A held booking in the store and the map, and the calendar the harness serves.
CalendarPeer* clientWorld(harness::Ctx& ctx) {
  static CalendarPeer* calendar = nullptr;
  delete calendar;
  calendar = new CalendarPeer(ctx);
  ctx.GRPC.Server("")->RegisterService(calendar);
  clientHold(ctx);
  return calendar;
}

std::string clientConfirm(harness::Ctx& ctx) {
  std::string result;
  const bool returned = ctx.Drain([&] { result = confirmBooking(kClientBooking); });
  ctx.Assert(returned, "confirmBooking never returned: it kept retrying until the runtime stopped it");
  return result;
}

std::map<std::string, std::string> clientState(harness::Ctx& ctx) { return ctx.Redis.HGetAll("booking:b-1"); }

std::vector<std::string> clientOwners(harness::Ctx& ctx) {
  std::vector<std::string> out;
  for (const auto& f : clientFields()) out.push_back(ctx.Redis.HGet(booking::slots::Key("r1"), f).value_or(""));
  return out;
}

std::vector<std::string> clientBooked() { return std::vector<std::string>(clientFields().size(), "booked:b-1"); }

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  clientWorld(ctx);
  ctx.GRPC.SetLatency("Sync", 2.0);
  const std::string result = clientConfirm(ctx);
  ctx.Equal(result, "confirmed", "a calendar that answers in 2 s must confirm the booking (the deadline per attempt is 3000 ms); the result");
  const auto call = ctx.GRPC.CallsTo("Sync")[0];
  ctx.Assert(call.HasDeadline(), "the Sync call carries no deadline: a hanging calendar would hold the request and the payment window open");
  ctx.Assert(2.5 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 3.5, "the Sync deadline is %vs, expected about 3 s", call.TimeoutSeconds());
  const auto s = clientState(ctx);
  ctx.Assert(s.count("state") && s.at("state") == "confirmed" && s.count("event_id") && s.at("event_id") == "evt-1",
             "the stored booking is %v, expected state confirmed with event_id evt-1", s);
  ctx.Equal(clientOwners(ctx), clientBooked(), "the slots after confirmation");
  // A calendar that never answers in time: every attempt, the retries included, gets its own 3 s.
  clientHold(ctx);
  ctx.GRPC.SetLatency("Sync", 5.0);
  ctx.Drain([&] { confirmBooking(kClientBooking); });
  const auto calls = ctx.GRPC.CallsTo("Sync");
  std::vector<double> timeouts;
  bool fresh = true;
  for (size_t i = 1; i < calls.size(); ++i) {
    timeouts.push_back(calls[i].HasDeadline() ? calls[i].TimeoutSeconds() : -1);
    fresh = fresh && calls[i].HasDeadline() && 2.5 <= calls[i].TimeoutSeconds() && calls[i].TimeoutSeconds() <= 3.5;
  }
  ctx.Assert(fresh,
             "against a calendar that never answers in time the Sync deadlines were %v s, expected about 3 s on every "
             "attempt: a retry needs a deadline of its own, not what is left of the first one's",
             timeouts);
}

void CheckIdempotencyKey(harness::Ctx& ctx) {
  auto* calendar = clientWorld(ctx);
  ctx.GRPC.Fail("Sync", grpc::StatusCode::UNAVAILABLE, "calendar restarting", 1);
  const std::string result = clientConfirm(ctx);
  ctx.Equal(result, "confirmed", "a calendar that was UNAVAILABLE once must confirm the booking after a retry; the result");
  const auto calls = ctx.GRPC.CallsTo("Sync");
  ctx.Equal(calls.size(), 2, "one failure then success should be 2 Sync calls; the calls");
  std::vector<std::string> keys;
  for (const auto& c : calls) keys.push_back(c.Request<booking::SyncRequest>().idempotency_key());
  ctx.Equal(keys, {"k-1", "k-1"}, "the Sync requests must carry the booking's idempotency_key on every attempt");
  ctx.Assert(calendar->created == 1 && calendar->events["k-1"] == "evt-1",
             "the calendar created %d events for one booking: a retry without the key is a second invitation", calendar->created);
}

void CheckTimeoutReconcile(harness::Ctx& ctx) {
  auto* calendar = clientWorld(ctx);
  // The first sync reached the calendar, its answer did not come back: the event exists.
  calendar->events["k-1"] = "evt-7";
  ctx.GRPC.SetLatency("Sync", 5.0);
  const std::string result = clientConfirm(ctx);
  ctx.Assert(result != "cancelled",
             "every attempt timed out and the booking was cancelled: the calendar has the event, the guest will arrive to a "
             "booking the system forgot. Ask GetEvent first");
  ctx.Equal(result, "reconciled", "confirmBooking's result");
  ctx.Equal(ctx.GRPC.CallsTo("Sync").size(), 3, "every Sync timed out: 3 attempts, each with a deadline of its own; the Sync calls");
  const auto gets = ctx.GRPC.CallsTo("GetEvent");
  ctx.Equal(gets.size(), 1, "GetEvent must be asked once by the booking's key; the calls");
  ctx.Equal(gets[0].Request<booking::GetEventRequest>().idempotency_key(), "k-1", "GetEvent's key");
  ctx.Equal(calendar->stateAtGetEvent, "sync_unknown",
            "the booking's state when GetEvent was asked (record the unknown state before reconciling, so a crash mid-way "
            "leaves a booking a sweeper can find)");
  const auto s = clientState(ctx);
  ctx.Assert(s.count("state") && s.at("state") == "confirmed" && s.count("event_id") && s.at("event_id") == "evt-7",
             "the stored booking is %v, expected confirmed with the calendar's event evt-7", s);
  ctx.Equal(clientOwners(ctx), clientBooked(), "the slots");
  // Every attempt times out again, and GetEvent itself fails: the event may or may not exist.
  clientHold(ctx);
  ctx.GRPC.Fail("GetEvent", grpc::StatusCode::UNAVAILABLE, "calendar down", 10);
  std::string unknown;
  ctx.Drain([&] {
    try {
      unknown = confirmBooking(kClientBooking);
    } catch (const std::exception&) {
      // the error reaching the caller is fine
    }
  });
  const std::string unknownState = clientState(ctx)["state"];
  ctx.Assert(unknown != "cancelled" && unknownState == "sync_unknown",
             "GetEvent failed and the booking ended %q with state %q: a failed GetEvent says nothing about the event, so the "
             "booking stays sync_unknown for a sweeper",
             unknown, unknownState);
  ctx.Assert(clientOwners(ctx) == std::vector<std::string>(clientFields().size(), "h-1") &&
                 ctx.Redis.Exists(booking::slots::HoldKey("h-1")) == 1,
             "GetEvent failed and the slots point at %v: the hold must stay until the calendar answers", clientOwners(ctx));
}

void CheckNonRetryableRelease(harness::Ctx& ctx) {
  clientWorld(ctx);
  ctx.GRPC.Fail("Sync", grpc::StatusCode::INVALID_ARGUMENT, "resource unknown to this calendar", 1);
  const std::string result = clientConfirm(ctx);
  ctx.Equal(ctx.GRPC.CallsTo("Sync").size(), 1, "INVALID_ARGUMENT is a verdict, not a retryable failure; the Sync calls");
  ctx.Equal(result, "rejected", "confirmBooking's result");
  ctx.Equal(ctx.Redis.HGetAll(booking::slots::Key("r1")), std::map<std::string, std::string>{},
            "the refused booking's slots (release the hold, or they stay blocked for the rest of the payment window)");
  ctx.Equal(ctx.Redis.Exists(booking::slots::HoldKey("h-1")), 0, "the hold key after the release");
  ctx.Equal(clientState(ctx)["state"], "rejected", "the stored booking's state");
  // PERMISSION_DENIED is the calendar's other verdict.
  clientHold(ctx);
  ctx.GRPC.Fail("Sync", grpc::StatusCode::PERMISSION_DENIED, "calendar not shared with this tenant", 1);
  const std::string denied = clientConfirm(ctx);
  ctx.Equal(ctx.GRPC.CallsTo("Sync").size() - 1, 1, "PERMISSION_DENIED is a verdict, not a retryable failure; the Sync calls made for it");
  ctx.Equal(denied, "rejected", "confirmBooking's result after PERMISSION_DENIED");
  ctx.Equal(ctx.Redis.HGetAll(booking::slots::Key("r1")), std::map<std::string, std::string>{},
            "the slots of the booking refused with PERMISSION_DENIED (release the hold)");
  ctx.Equal(clientState(ctx)["state"], "rejected", "the stored booking's state after PERMISSION_DENIED");
}

void CheckBoundedRetry(harness::Ctx& ctx) {
  auto* calendar = clientWorld(ctx);
  // Only DEADLINE_EXCEEDED and UNAVAILABLE are retried: an INTERNAL error is not.
  ctx.GRPC.Fail("Sync", grpc::StatusCode::INTERNAL, "calendar bug", 1);
  ctx.Drain([&] {
    try {
      confirmBooking(kClientBooking);
    } catch (const std::exception&) {
      // the error reaching the caller is fine
    }
  });
  const size_t made = ctx.GRPC.CallsTo("Sync").size();
  ctx.Equal(made, 1, "an INTERNAL failure is not retried (only DEADLINE_EXCEEDED and UNAVAILABLE are); the Sync calls");
  clientHold(ctx);
  const size_t getsBefore = ctx.GRPC.CallsTo("GetEvent").size();
  ctx.GRPC.Fail("Sync", grpc::StatusCode::UNAVAILABLE, "calendar down", 10);
  const std::string result = clientConfirm(ctx);
  ctx.Equal(ctx.GRPC.CallsTo("Sync").size() - made, 3, "a calendar that stays UNAVAILABLE gets exactly 3 attempts; the Sync calls");
  ctx.Equal(result, "cancelled", "confirmBooking's result (GetEvent found no event)");
  const size_t gets = ctx.GRPC.CallsTo("GetEvent").size() - getsBefore;
  ctx.Assert(gets == 1 && calendar->stateAtGetEvent == "sync_unknown",
             "after three UNAVAILABLE attempts GetEvent was asked %d times with the booking %q, expected once with "
             "sync_unknown: an earlier attempt may have reached the calendar before the connection dropped",
             gets, calendar->stateAtGetEvent);
  ctx.Equal(ctx.Redis.HGetAll(booking::slots::Key("r1")), std::map<std::string, std::string>{}, "the cancelled booking's slots");
  ctx.Equal(clientState(ctx)["state"], "cancelled", "the stored booking's state");
}
`,
  },
  hints: [
    'Guests find two invitations for one booking in their calendar, and after a slow afternoon at the calendar vendor a room shows free while its booking is on the vendor side.',
    'A retry is only safe when the calendar can tell it is the same booking; without the key each attempt is a new event. A timeout says nothing about whether the event exists: it may have been created.',
    'Send `idempotency_key` and a 3000 ms deadline on every attempt; retry `DEADLINE_EXCEEDED`/`UNAVAILABLE` at most 3 times; release on `INVALID_ARGUMENT` or `PERMISSION_DENIED`; after the last failure record `sync_unknown`, then `GetEvent` decides.',
  ],
  debrief: `The sync is written around one fact about the network: a call that did not answer is not a call that did not happen. The idempotency key makes the retry safe, the attempt cap makes the failure finite, and the reconciliation step turns "unknown" into "known" before the booking is touched. The permanent-rejection path exists because a hold that is not released costs the slot for the whole payment window, which for a refused booking is pure loss. The recorded \`sync_unknown\` state is what a crash in the middle of all this leaves behind for a sweeper to pick up. Production systems run that sweeper on a schedule, back the retries off with jitter, put a circuit breaker in front of each calendar vendor, and send a delete to the external calendar when a reconciled booking is later cancelled.`,
};
