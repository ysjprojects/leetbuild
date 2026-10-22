import type {Step} from '@/lib/types';

export const bookingClientStep: Step = {
  id: 'dependency',
  title: 'Calendar sync calls that confirm idempotently',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'calendar'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it calls the calendar, retries
when something goes wrong, and cancels the booking if it cannot. It is also how you get two calendar
events for one booking and a cancelled booking whose invitation is still in everyone's inbox. Review
it like the service owner, fix it, and prove the fix with the checks below.

Confirmation calls the external calendar over gRPC. That call is where a local booking becomes a real
reservation, so it needs a deadline, an identity, and a failure policy that never guesses.

- Every attempt carries a **3000 ms** deadline. A calendar that hangs must not hold your request, the
  caller's connection and your payment window open.
- The request carries the booking's **idempotency key**, and the calendar is an upsert on that key: a
  retried sync **updates the one event** instead of creating a second one. Retrying without the key
  is what duplicates invitations.
- Only **retryable** failures are retried — \`DEADLINE_EXCEEDED\` and \`UNAVAILABLE\` — and at most
  **3** attempts in total. There is no unbounded loop: an external service that is down must fail the
  booking, not spin.
- A failure that is **permanent** (\`INVALID_ARGUMENT\`, \`PERMISSION_DENIED\`) means the calendar
  refused this booking for good and created nothing. Free the hold — otherwise the slot is leaked
  until the payment window closes as if the guest had abandoned checkout.
- A **timeout after every attempt** is not a failure you may act on: the event may exist. Record the
  booking as \`sync_unknown\`, then **reconcile** — look the event up by the same idempotency key —
  and only cancel the local booking when the calendar confirms no event exists. Cancelling on a
  timeout is how a guest arrives to a booking the system no longer believes in.

**Failure mode the checks target.** The draft loops until it succeeds, sends no idempotency key (so
every retry creates another event), and treats a timeout as proof that nothing happened — it cancels
the booking while the invitation is already in the calendar.`,
  sequence: {
    participants: ['Booking API', 'Calendar service'],
    messages: [
      {
        from: 'Booking API',
        to: 'Calendar service',
        label: 'Sync(booking_id, idempotency_key) · 3 s deadline',
        kind: 'sync',
      },
      {from: 'Calendar service', to: 'Booking API', label: 'event_id — one event per key', kind: 'reply'},
      {from: 'Booking API', to: 'Booking API', label: 'retryable → retry, at most 3 attempts', kind: 'sync'},
      {from: 'Calendar service', to: 'Booking API', label: 'DEADLINE_EXCEEDED', kind: 'reply'},
      {from: 'Booking API', to: 'Booking API', label: 'record sync_unknown — the event may exist', kind: 'sync'},
      {from: 'Booking API', to: 'Calendar service', label: 'GetEvent(idempotency_key)', kind: 'sync'},
      {from: 'Calendar service', to: 'Booking API', label: 'event found / no event', kind: 'reply'},
      {from: 'Booking API', to: 'Booking API', label: 'reconciled → confirm · absent → cancel', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Bounds every attempt with a 3000 ms deadline',
      detail:
        'Each sync attempt carries a `3000` ms deadline, so a hanging calendar cannot hold the request open. The draft calls with a one-second timeout on some paths and none on others.',
      match: {
        python: {all: [/SYNC_DEADLINE_MS\s*=\s*3000/, /timeout=SYNC_DEADLINE_MS/]},
        typescript: {all: [/SYNC_DEADLINE_MS\s*=\s*3000/, /Date\.now\(\) \+ SYNC_DEADLINE_MS/]},
        go: {all: [/syncDeadlineMs\s*=\s*3000/, /context\.WithTimeout/]},
        scala: {all: [/SyncDeadlineMs\s*=\s*3000/, /SyncDeadlineMs\.millis/]},
        cpp: {all: [/kSyncDeadlineMs\s*=\s*3000/, /set_deadline/]},
      },
    },
    {
      id: 'idempotency-key',
      title: 'Sends the booking idempotency key so a retry updates one event',
      detail:
        'The sync request carries the booking’s `idempotency_key`, which makes the calendar upsert: a retried sync updates the same event. The draft sends the booking id only, so every retry creates another event.',
      match: {
        python: {all: [/idempotency_key/, /def sync_event\(/, /timeout=SYNC_DEADLINE_MS/]},
        typescript: {all: [/idempotency_key/, /function syncEvent\(/, /SYNC_DEADLINE_MS/]},
        go: {all: [/IdempotencyKey/, /func syncEvent\(/, /context\.WithTimeout/]},
        scala: {all: [/idempotency_key/, /def syncEvent\(/, /SyncDeadlineMs\.millis/]},
        cpp: {all: [/idempotencyKey/, /syncEvent\(/, /set_deadline/]},
      },
    },
    {
      id: 'timeout-reconcile',
      title: 'Records an unknown state and reconciles before cancelling',
      detail:
        'A timeout after every attempt records `sync_unknown`, looks the event up by the idempotency key, and only then decides. The draft cancels the local booking on the first timeout.',
      match: {
        python: {
          all: [/SYNC_UNKNOWN/, /def reconcile_event\(/],
          order: [/SYNC_UNKNOWN/, /reconcile_event\(/, /cancel_booking\(/],
        },
        typescript: {
          all: [/SYNC_UNKNOWN/, /function reconcileEvent\(/],
          order: [/SYNC_UNKNOWN/, /reconcileEvent\(/, /cancelBooking\(/],
        },
        go: {
          all: [/syncUnknown/, /func reconcileEvent\(/],
          order: [/syncUnknown/, /reconcileEvent\(/, /cancelBooking\(/],
        },
        scala: {
          all: [/SyncUnknown/, /def reconcileEvent\(/],
          order: [/SyncUnknown/, /reconcileEvent\(/, /cancelBooking\(/],
        },
        cpp: {
          all: [/kSyncUnknown/, /reconcileEvent\(/],
          order: [/kSyncUnknown/, /reconcileEvent\(/, /cancelBooking\(/],
        },
      },
    },
    {
      id: 'non-retryable-release',
      title: 'Releases the hold when the calendar refuses the booking',
      detail:
        'A permanent rejection is not retried: the code frees the hold instead of leaving it to expire, so a refused booking does not block the slot for the payment window. The draft treats every error the same.',
      match: {
        python: {all: [/INVALID_ARGUMENT/, /release_hold\(/]},
        typescript: {all: [/INVALID_ARGUMENT/, /releaseHold\(/]},
        go: {all: [/codes\.InvalidArgument/, /releaseHold\(/]},
        scala: {all: [/INVALID_ARGUMENT/, /releaseHold\(/]},
        cpp: {all: [/INVALID_ARGUMENT/, /releaseHold\(/]},
      },
    },
    {
      id: 'bounded-retry',
      title: 'Retries only retryable failures, at most 3 times',
      detail:
        'Only `DEADLINE_EXCEEDED` and `UNAVAILABLE` are retried, with a `3`-attempt cap. The draft loops forever on every error.',
      match: {
        python: {all: [/MAX_SYNC_ATTEMPTS\s*=\s*3/, /UNAVAILABLE/], none: [/while\s+True/]},
        typescript: {all: [/MAX_SYNC_ATTEMPTS\s*=\s*3/, /UNAVAILABLE/], none: [/while\s*\(\s*true\s*\)/]},
        go: {all: [/maxSyncAttempts\s*=\s*3/, /codes\.Unavailable/], none: [/for\s*\{/]},
        scala: {all: [/MaxSyncAttempts\s*=\s*3/, /UNAVAILABLE/], none: [/while\s*\(/]},
        cpp: {all: [/kMaxSyncAttempts\s*=\s*3/, /UNAVAILABLE/], none: [/while\s*\(\s*true\s*\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc


def sync_event(stub, booking, attempt: int):
    # TODO: this draft sends no idempotency_key, so every retry creates another calendar event,
    # and its timeout is inconsistent.
    request = {"booking_id": booking["booking_id"], "start": booking["start"], "end": booking["end"]}
    return stub.Sync(request, timeout=1)


def confirm_booking(store, stub, booking) -> str:
    # TODO: this draft retries every error forever and cancels the local booking on the first
    # timeout, even though the external event may already exist. Bound the attempts, send the
    # idempotency key, and reconcile before cancelling.
    while True:
        try:
            reply = sync_event(stub, booking, 0)
            store.mark_confirmed(booking["booking_id"], reply["event_id"])
            return "confirmed"
        except grpc.RpcError as exc:
            if exc.code() == grpc.StatusCode.DEADLINE_EXCEEDED:
                store.cancel_booking(booking["booking_id"])
                return "cancelled"
            continue
`,
      solution: `import grpc

SYNC_DEADLINE_MS = 3000
MAX_SYNC_ATTEMPTS = 3
SYNC_UNKNOWN = "sync_unknown"
RETRYABLE = (grpc.StatusCode.DEADLINE_EXCEEDED, grpc.StatusCode.UNAVAILABLE)
PERMANENT = (grpc.StatusCode.INVALID_ARGUMENT, grpc.StatusCode.PERMISSION_DENIED)


def sync_event(stub, booking, idempotency_key: str):
    """One attempt: the key makes a retried sync update the one event, never create a second."""
    request = {
        "booking_id": booking["booking_id"],
        "idempotency_key": idempotency_key,
        "resource_id": booking["resource_id"],
        "start": booking["start"],
        "end": booking["end"],
    }
    return stub.Sync(request, timeout=SYNC_DEADLINE_MS / 1000)


def reconcile_event(stub, idempotency_key: str):
    """Look the event up by the same key before the local booking is touched."""
    return stub.GetEvent({"idempotency_key": idempotency_key}, timeout=SYNC_DEADLINE_MS / 1000)


def confirm_booking(store, stub, booking, idempotency_key: str) -> str:
    for _ in range(MAX_SYNC_ATTEMPTS):
        try:
            reply = sync_event(stub, booking, idempotency_key)
            store.mark_confirmed(booking["booking_id"], reply["event_id"])
            return "confirmed"
        except grpc.RpcError as exc:
            if exc.code() in PERMANENT:
                # The calendar refused this booking for good and created nothing: free the hold
                # instead of leaking the slot for the whole payment window.
                release_hold(booking)
                store.mark_rejected(booking["booking_id"])
                return "rejected"
            if exc.code() not in RETRYABLE:
                raise

    # Every attempt timed out or was unavailable: the event may exist, so record the unknown state
    # and reconcile before cancelling anything.
    store.record_state(booking["booking_id"], SYNC_UNKNOWN)
    if reconcile_event(stub, idempotency_key) is None:
        cancel_booking(store, booking["booking_id"])
        return "cancelled"
    store.mark_confirmed(booking["booking_id"], reconcile_event(stub, idempotency_key)["event_id"])
    return "reconciled"
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';

export interface Booking {
  bookingId: string;
  resourceId: string;
  start: string;
  end: string;
}

export function syncEvent(client: grpc.Client, booking: Booking, attempt: number): Promise<{event_id: string}> {
  // TODO: this draft sends no idempotency_key, so every retry creates another calendar event.
  return callSync(client, {booking_id: booking.bookingId, start: booking.start, end: booking.end}, 1000);
}

export async function confirmBooking(store: BookingStore, client: grpc.Client, booking: Booking): Promise<string> {
  // TODO: this draft retries every error forever and cancels the local booking on the first
  // timeout, even though the external event may already exist. Bound the attempts, send the
  // idempotency key, and reconcile before cancelling.
  while (true) {
    try {
      const reply = await syncEvent(client, booking, 0);
      await store.markConfirmed(booking.bookingId, reply.event_id);
      return 'confirmed';
    } catch (err) {
      if ((err as grpc.ServiceError).code === grpc.status.DEADLINE_EXCEEDED) {
        await store.cancelBooking(booking.bookingId);
        return 'cancelled';
      }
    }
  }
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';

export const SYNC_DEADLINE_MS = 3000;
export const MAX_SYNC_ATTEMPTS = 3;
export const SYNC_UNKNOWN = 'sync_unknown';

const RETRYABLE = [grpc.status.DEADLINE_EXCEEDED, grpc.status.UNAVAILABLE];
const PERMANENT = [grpc.status.INVALID_ARGUMENT, grpc.status.PERMISSION_DENIED];

export interface Booking {
  bookingId: string;
  resourceId: string;
  start: string;
  end: string;
}

export interface CalendarEvent {
  event_id: string;
}

/** One attempt: the key makes a retried sync update the one event, never create a second. */
export function syncEvent(client: grpc.Client, booking: Booking, idempotencyKey: string): Promise<CalendarEvent> {
  return callSync(
    client,
    {
      booking_id: booking.bookingId,
      idempotency_key: idempotencyKey,
      resource_id: booking.resourceId,
      start: booking.start,
      end: booking.end,
    },
    Date.now() + SYNC_DEADLINE_MS,
  );
}

/** Look the event up by the same key before the local booking is touched. */
export function reconcileEvent(client: grpc.Client, idempotencyKey: string): Promise<CalendarEvent | null> {
  return callGetEvent(client, {idempotency_key: idempotencyKey}, Date.now() + SYNC_DEADLINE_MS);
}

export async function confirmBooking(
  store: BookingStore,
  client: grpc.Client,
  booking: Booking,
  idempotencyKey: string,
): Promise<string> {
  for (let attempt = 0; attempt < MAX_SYNC_ATTEMPTS; attempt += 1) {
    try {
      const reply = await syncEvent(client, booking, idempotencyKey);
      await store.markConfirmed(booking.bookingId, reply.event_id);
      return 'confirmed';
    } catch (err) {
      const code = (err as grpc.ServiceError).code;
      if (PERMANENT.includes(code)) {
        // The calendar refused this booking for good and created nothing: free the hold instead of
        // leaking the slot for the whole payment window.
        await releaseHold(booking);
        await store.markRejected(booking.bookingId);
        return 'rejected';
      }
      if (!RETRYABLE.includes(code)) throw err;
    }
  }

  // Every attempt timed out or was unavailable: the event may exist, so record the unknown state
  // and reconcile before cancelling anything.
  await store.recordState(booking.bookingId, SYNC_UNKNOWN);
  const event = await reconcileEvent(client, idempotencyKey);
  if (event === null) {
    await cancelBooking(store, booking.bookingId);
    return 'cancelled';
  }
  await store.markConfirmed(booking.bookingId, event.event_id);
  return 'reconciled';
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func syncEvent(ctx context.Context, client CalendarClient, booking Booking, attempt int) (*Event, error) {
	// TODO: this draft sends no idempotency_key, so every retry creates another calendar event,
	// and its timeout is inconsistent.
	callCtx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	return client.Sync(callCtx, &SyncRequest{BookingId: booking.ID, Start: booking.Start, End: booking.End})
}

func confirmBooking(store BookingStore, client CalendarClient, booking Booking) (string, error) {
	// TODO: this draft retries every error forever and cancels the local booking on the first
	// timeout, even though the external event may already exist. Bound the attempts, send the
	// idempotency key, and reconcile before cancelling.
	for {
		reply, err := syncEvent(context.Background(), client, booking, 0)
		if err == nil {
			store.MarkConfirmed(booking.ID, reply.EventId)
			return "confirmed", nil
		}
		if status.Code(err) == codes.DeadlineExceeded {
			store.CancelBooking(booking.ID)
			return "cancelled", nil
		}
	}
}
`,
      solution: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	syncDeadlineMs  = 3000
	maxSyncAttempts = 3
	syncUnknown     = "sync_unknown"
)

func retryable(err error) bool {
	switch status.Code(err) {
	case codes.DeadlineExceeded, codes.Unavailable:
		return true
	}
	return false
}

func permanent(err error) bool {
	switch status.Code(err) {
	case codes.InvalidArgument, codes.PermissionDenied, codes.FailedPrecondition:
		return true
	}
	return false
}

// syncEvent makes one attempt: the key makes a retried sync update the one event, never create a
// second.
func syncEvent(ctx context.Context, client CalendarClient, booking Booking, idempotencyKey string) (*Event, error) {
	callCtx, cancel := context.WithTimeout(ctx, time.Duration(syncDeadlineMs)*time.Millisecond)
	defer cancel()
	return client.Sync(callCtx, &SyncRequest{
		BookingId:      booking.ID,
		IdempotencyKey: idempotencyKey,
		ResourceId:     booking.ResourceID,
		Start:          booking.Start,
		End:            booking.End,
	})
}

// reconcileEvent looks the event up by the same key before the local booking is touched.
func reconcileEvent(ctx context.Context, client CalendarClient, idempotencyKey string) (*Event, error) {
	callCtx, cancel := context.WithTimeout(ctx, time.Duration(syncDeadlineMs)*time.Millisecond)
	defer cancel()
	event, err := client.GetEvent(callCtx, &GetEventRequest{IdempotencyKey: idempotencyKey})
	if status.Code(err) == codes.NotFound {
		return nil, nil
	}
	return event, err
}

func confirmBooking(store BookingStore, client CalendarClient, booking Booking, idempotencyKey string) (string, error) {
	for attempt := 0; attempt < maxSyncAttempts; attempt++ {
		reply, err := syncEvent(context.Background(), client, booking, idempotencyKey)
		if err == nil {
			store.MarkConfirmed(booking.ID, reply.EventId)
			return "confirmed", nil
		}
		if permanent(err) {
			// The calendar refused this booking for good and created nothing: free the hold instead
			// of leaking the slot for the whole payment window.
			releaseHold(booking)
			store.MarkRejected(booking.ID)
			return "rejected", nil
		}
		if !retryable(err) {
			return "", err
		}
	}

	// Every attempt timed out or was unavailable: the event may exist, so record the unknown state
	// and reconcile before cancelling anything.
	store.RecordState(booking.ID, syncUnknown)
	event, err := reconcileEvent(context.Background(), client, idempotencyKey)
	if err != nil {
		return "", err
	}
	if event == nil {
		cancelBooking(store, booking.ID)
		return "cancelled", nil
	}
	store.MarkConfirmed(booking.ID, event.EventId)
	return "reconciled", nil
}
`,
    },
    scala: {
      starter: `import scala.concurrent.duration._
import scala.concurrent.Await

final case class CalendarError(status: io.grpc.Status.Code) extends RuntimeException(status.toString)

object CalendarSync {
  def syncEvent(client: CalendarClient, booking: Booking, attempt: Int): Event =
    // TODO: this draft sends no idempotency_key, so every retry creates another calendar event.
    Await.result(client.sync(SyncRequest(bookingId = booking.id, start = booking.start, end = booking.end)), 1.second)

  def confirmBooking(store: BookingStore, client: CalendarClient, booking: Booking): String = {
    // TODO: this draft retries every error forever and cancels the local booking on the first
    // timeout, even though the external event may already exist. Bound the attempts, send the
    // idempotency key, and reconcile before cancelling.
    var outcome = ""
    while (outcome.isEmpty) {
      try {
        val event = syncEvent(client, booking, 0)
        store.markConfirmed(booking.id, event.id)
        outcome = "confirmed"
      } catch {
        case err: CalendarError if err.status == io.grpc.Status.Code.DEADLINE_EXCEEDED =>
          store.cancelBooking(booking.id)
          outcome = "cancelled"
        case _: CalendarError => ()
      }
    }
    outcome
  }
}
`,
      solution: `import scala.concurrent.duration._
import scala.concurrent.Await

final case class CalendarError(status: io.grpc.Status.Code) extends RuntimeException(status.toString)

object CalendarSync {
  val SyncDeadlineMs = 3000
  val MaxSyncAttempts = 3
  val SyncUnknown = "sync_unknown"

  def retryable(err: CalendarError): Boolean =
    err.status == io.grpc.Status.Code.DEADLINE_EXCEEDED || err.status == io.grpc.Status.Code.UNAVAILABLE

  def permanent(err: CalendarError): Boolean =
    err.status == io.grpc.Status.Code.INVALID_ARGUMENT || err.status == io.grpc.Status.Code.PERMISSION_DENIED

  /** One attempt: the key makes a retried sync update the one event, never create a second. */
  def syncEvent(client: CalendarClient, booking: Booking, idempotencyKey: String): Event =
    Await.result(
      client.sync(
        SyncRequest(
          bookingId = booking.id,
          idempotency_key = idempotencyKey,
          resourceId = booking.resourceId,
          start = booking.start,
          end = booking.end
        )
      ),
      SyncDeadlineMs.millis
    )

  /** Look the event up by the same key before the local booking is touched. */
  def reconcileEvent(client: CalendarClient, idempotencyKey: String): Option[Event] =
    Await.result(client.getEvent(idempotencyKey), SyncDeadlineMs.millis)

  def confirmBooking(
      store: BookingStore,
      client: CalendarClient,
      booking: Booking,
      idempotencyKey: String,
  ): String = {
    @annotation.tailrec
    def attempt(n: Int, lastError: Option[CalendarError]): Either[CalendarError, Event] =
      if (n >= MaxSyncAttempts) Left(lastError.getOrElse(CalendarError(io.grpc.Status.Code.UNKNOWN)))
      else {
        try Right(syncEvent(client, booking, idempotencyKey))
        catch {
          case err: CalendarError if permanent(err) => Left(err)
          case err: CalendarError if retryable(err) => attempt(n + 1, Some(err))
          case err: CalendarError => Left(err)
        }
      }

    attempt(0, None) match {
      case Right(event) =>
        store.markConfirmed(booking.id, event.id)
        "confirmed"
      case Left(err) if permanent(err) =>
        // The calendar refused this booking for good and created nothing: free the hold instead of
        // leaking the slot for the whole payment window.
        releaseHold(booking)
        store.markRejected(booking.id)
        "rejected"
      case Left(_) =>
        // Every attempt timed out or was unavailable: the event may exist, so record the unknown
        // state and reconcile before cancelling anything.
        store.recordState(booking.id, SyncUnknown)
        reconcileEvent(client, idempotencyKey) match {
          case Some(event) =>
            store.markConfirmed(booking.id, event.id)
            "reconciled"
          case None =>
            cancelBooking(store, booking.id)
            "cancelled"
        }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <string>

std::string syncEvent(Calendar::Stub* stub, const Booking& booking, int attempt) {
  // TODO: this draft sends no idempotency_key, so every retry creates another calendar event,
  // and its deadline is inconsistently short.
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(1));
  SyncReply reply;
  stub->Sync(&ctx, buildRequest(booking.booking_id, booking.start, booking.end), &reply);
  return reply.event_id();
}

std::string confirmBooking(BookingStore& store, Calendar::Stub* stub, const Booking& booking) {
  // TODO: this draft retries every error forever and cancels the local booking on the first
  // timeout, even though the external event may already exist. Bound the attempts, send the
  // idempotency key, and reconcile before cancelling.
  while (true) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(1));
    SyncReply reply;
    const auto status = stub->Sync(&ctx, buildRequest(booking.booking_id, booking.start, booking.end), &reply);
    if (status.ok()) {
      store.markConfirmed(booking.booking_id, reply.event_id());
      return "confirmed";
    }
    if (status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED) {
      store.cancelBooking(booking.booking_id);
      return "cancelled";
    }
  }
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <string>

constexpr int kSyncDeadlineMs = 3000;
constexpr int kMaxSyncAttempts = 3;
constexpr const char* kSyncUnknown = "sync_unknown";

bool retryable(grpc::StatusCode code) {
  return code == grpc::StatusCode::DEADLINE_EXCEEDED || code == grpc::StatusCode::UNAVAILABLE;
}

bool permanent(grpc::StatusCode code) {
  return code == grpc::StatusCode::INVALID_ARGUMENT || code == grpc::StatusCode::PERMISSION_DENIED;
}

// One attempt: the key makes a retried sync update the one event, never create a second.
std::string syncEvent(Calendar::Stub* stub, const Booking& booking, const std::string& idempotencyKey) {
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kSyncDeadlineMs));
  SyncReply reply;
  const auto status = stub->Sync(&ctx, buildRequest(booking.booking_id, idempotencyKey, booking.start, booking.end),
                                 &reply);
  if (!status.ok()) throw CalendarError(status.error_code());
  return reply.event_id();
}

// Look the event up by the same key before the local booking is touched.
std::optional<std::string> reconcileEvent(Calendar::Stub* stub, const std::string& idempotencyKey) {
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kSyncDeadlineMs));
  GetEventReply reply;
  const auto status = stub->GetEvent(&ctx, buildGetEventRequest(idempotencyKey), &reply);
  if (status.error_code() == grpc::StatusCode::NOT_FOUND) return std::nullopt;
  if (!status.ok()) throw CalendarError(status.error_code());
  return reply.event_id();
}

std::string confirmBooking(BookingStore& store, Calendar::Stub* stub, const Booking& booking,
                           const std::string& idempotencyKey) {
  for (int attempt = 0; attempt < kMaxSyncAttempts; ++attempt) {
    try {
      const auto eventId = syncEvent(stub, booking, idempotencyKey);
      store.markConfirmed(booking.booking_id, eventId);
      return "confirmed";
    } catch (const CalendarError& err) {
      if (permanent(err.code)) {
        // The calendar refused this booking for good and created nothing: free the hold instead of
        // leaking the slot for the whole payment window.
        releaseHold(booking);
        store.markRejected(booking.booking_id);
        return "rejected";
      }
      if (!retryable(err.code)) throw;
    }
  }

  // Every attempt timed out or was unavailable: the event may exist, so record the unknown state
  // and reconcile before cancelling anything.
  store.recordState(booking.booking_id, kSyncUnknown);
  const auto event = reconcileEvent(stub, idempotencyKey);
  if (!event.has_value()) {
    cancelBooking(store, booking.booking_id);
    return "cancelled";
  }
  store.markConfirmed(booking.booking_id, event.value());
  return "reconciled";
}
`,
    },
  },
  hints: [
    'The idempotency key is what turns a retry into an update. Without it, every attempt that you cannot observe is a second event in somebody’s calendar.',
    'Split failures by who caused them: `UNAVAILABLE` and `DEADLINE_EXCEEDED` are retryable; `INVALID_ARGUMENT` and `PERMISSION_DENIED` are verdicts and must not be retried. Bound the loop with an attempt constant, never with "until it works".',
    'A timeout is not a "no": the event may exist. Record `sync_unknown`, look the event up by the same key, and only cancel the local booking when the calendar says there is no event.',
  ],
  debrief: `The interviewer is testing the contract between your booking and somebody else's calendar, which is the
classic place where a distributed system duplicates and loses facts at the same time. Three defects
are checked: the missing idempotency key (duplicate events), the unbounded retry (a hot loop against a
down dependency), and the cancel-on-timeout (the local system forgets a booking the calendar has
already accepted). The permanent-rejection path is the quiet fourth: a refusal that is not retried
must still give the slot back, or the platform keeps a reservation for a guest who is never coming.
Real systems add a reconciliation job that sweeps every \`sync_unknown\` booking, a circuit breaker per
calendar vendor, and a tombstone so a cancelled event is deleted from the external calendar too.`,
};
