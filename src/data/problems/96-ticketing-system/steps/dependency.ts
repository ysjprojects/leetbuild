import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'CRM sync calls with per-note idempotency',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'crm', 'worker', 'store'],
  task: `## Task

**Starting point.** The starter is \`ticketd\`'s CRM client: \`post_note\` appends the note, calls
\`sync_note\`, and answers **201** once the CRM has taken it; \`sync_note\` builds a \`SyncNoteRequest\`
from the ticket id and body and loops on any \`RpcError\` until the call succeeds. It serves the demo
and hides 5 flaws.

**Failure mode the checks target.** An inline sync means one CRM outage blocks every agent's post.
A request without a key means each retry creates a new CRM note, duplicating the agent's reply in
the customer's record. Retrying \`INVALID_ARGUMENT\` spins forever, and a call with no deadline can
hang the worker. All of it is invisible while the CRM is healthy and fast.

Requirements:

- **Off the request path.** Commit the note and its outbox row together (\`store.commit_note\`,
  \`commitNote\`, \`CommitNote\`), answer **201**; a separate \`drain_outbox\` / \`drainOutbox\` makes
  the RPC.
- **A 3-second deadline per attempt** on \`SyncNote\` (\`DEADLINE_S = 3\`, \`DEADLINE_MS = 3000\`,
  \`context.WithTimeout(ctx, deadlineS*time.Second)\`, \`withDeadlineAfter(DeadlineS,
  TimeUnit.SECONDS)\`, \`set_deadline\`).
- **The note id is the idempotency key.** Every attempt sends \`idempotency_key = note.id\`; no key
  is minted per attempt.
- **Bounded retries.** \`MAX_ATTEMPTS = 3\`; only \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` earn another.
- **A schema rejection is quarantined.** On \`INVALID_ARGUMENT\` (or any permanent status) call
  \`store.quarantine(note.id, reason)\` and stop; exhausted retries leave the row pending
  (\`return False\` / \`return false\`).`,
  sequence: {
    participants: ['Ticket API', 'Ticket store', 'Event worker', 'CRM'],
    messages: [
      {
        from: 'Ticket API',
        to: 'Ticket store',
        label: 'commit_note(note) · note + sync_outbox row, one transaction',
        kind: 'sync',
      },
      {from: 'Ticket store', to: 'Ticket API', label: 'committed — 201 before the CRM is called', kind: 'reply'},
      {from: 'Event worker', to: 'Ticket store', label: 'pending_syncs() · notes the CRM has not taken', kind: 'sync'},
      {
        from: 'Event worker',
        to: 'CRM',
        label: 'SyncNote{note_id, idempotency_key = note.id} · deadline 3 s · attempt ≤ 3',
        kind: 'sync',
      },
      {from: 'CRM', to: 'Event worker', label: 'INVALID_ARGUMENT — the note’s shape was rejected', kind: 'reply'},
      {
        from: 'Event worker',
        to: 'Ticket store',
        label: 'quarantine(note_id, reason) — no further attempts',
        kind: 'sync',
      },
      {
        from: 'Event worker',
        to: 'CRM',
        label: 'UNAVAILABLE → retry with the same key: update, never a second note',
        kind: 'sync',
      },
    ],
  },
  hints: [
    'With the CRM down, every agent’s note post fails; with it flapping, the customer’s CRM record shows the same agent reply three times; with one malformed note, the worker spins at full CPU.',
    'The handler calls `sync_note` before answering, the request carries no note id or key so the CRM cannot match attempts, the `while True` catches every `RpcError` alike, and the call has no deadline.',
    'Commit note plus outbox row in `store.commit_note`, answer 201, drain in `drain_outbox`; call `SyncNote(..., idempotency_key=note.id, timeout=DEADLINE_S)` for `range(MAX_ATTEMPTS)`, retry only `UNAVAILABLE`/`DEADLINE_EXCEEDED`, `store.quarantine` on `INVALID_ARGUMENT`.',
  ],
  checks: [
    {
      id: 'sync-deadline',
      title: 'Every sync attempt carries a 3 s deadline',
      detail:
        'The `SyncNote` call is created with a **3-second** deadline — `timeout=DEADLINE_S`, `deadline: Date.now() + DEADLINE_MS`, `context.WithTimeout(ctx, deadlineS*time.Second)`, `withDeadlineAfter(DeadlineS, TimeUnit.SECONDS)` or `set_deadline`. The starter calls with no deadline at all: one CRM that accepts the connection and then says nothing pins the sync worker forever.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*3/, /timeout=DEADLINE_S/, /\.SyncNote\(/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*3000/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/, /\.syncNote\(/]},
        go: {
          all: [/deadlineS\s*=\s*3/, /context\.WithTimeout\(ctx,\s*deadlineS\s*\*\s*time\.Second\)/, /\.SyncNote\(/],
        },
        scala: {all: [/DeadlineS\s*=\s*3/, /withDeadlineAfter\(DeadlineS,\s*TimeUnit\.SECONDS\)/, /\.syncNote\(/]},
        cpp: {all: [/kDeadlineS\s*=\s*3/, /set_deadline\(/, /->SyncNote\(/]},
      },
    },
    {
      id: 'idempotent-sync',
      title: 'The note id is the idempotency key, so a retry updates one record',
      detail:
        'The note id travels with the request as the idempotency key (`idempotency_key=note.id`, `idempotencyKey: note.id`, `IdempotencyKey: note.ID`, `set_idempotency_key(note.id)`), so the CRM can dedupe a retry onto the record it already made. No key is minted per attempt. The starter sends neither the note id nor a key, so every attempt is a new CRM note and the agent’s reply duplicates in the customer’s record.',
      match: {
        python: {all: [/idempotency_key=note\.id/], none: [/uuid4\(/]},
        typescript: {all: [/idempotencyKey:\s*note\.id/], none: [/randomUUID\(/]},
        go: {all: [/IdempotencyKey:\s*note\.ID/], none: [/uuid\.NewString\(/]},
        scala: {all: [/idempotencyKey\s*=\s*note\.id/], none: [/UUID\.randomUUID\(/]},
        cpp: {all: [/set_idempotency_key\(note\.id\)/], none: [/uuid/]},
      },
    },
    {
      id: 'quarantine-schema',
      title: 'A schema rejection is quarantined with a reason',
      detail:
        '`INVALID_ARGUMENT` is a permanent refusal, not a transient failure: the note is quarantined with the status as its reason (`store.quarantine(note.id, …)` / `Quarantine(ctx, note.ID, …)`) and the sync stops instead of retrying. The starter catches every error and loops forever, so a note the CRM will never accept is retried until the worker is killed.',
      match: {
        python: {
          all: [/StatusCode\.INVALID_ARGUMENT/, /quarantine\(note\.id,/, /return False/],
          none: [/while\s+True/, /RETRYABLE\s*=\s*\{[^}]*INVALID_ARGUMENT/],
        },
        typescript: {
          all: [/grpc\.status\.INVALID_ARGUMENT/, /quarantine\(\s*note\.id\s*,/, /return false/],
          none: [/while\s*\(\s*true\s*\)/, /for\s*\(\s*;\s*;\s*\)/],
        },
        go: {
          all: [/codes\.InvalidArgument/, /Quarantine\(ctx,\s*note\.ID,/, /return false/],
          none: [/retryable\[codes\.InvalidArgument\]/],
        },
        scala: {
          all: [/Status\.Code\.INVALID_ARGUMENT/, /quarantine\(note\.id,/, /return false/],
          none: [/Retryable[^\n]*INVALID_ARGUMENT/],
        },
        cpp: {
          all: [/StatusCode::INVALID_ARGUMENT/, /\.quarantine\(note\.id,/, /return false/],
          none: [/kRetryable\s*=\s*\{[^}]*INVALID_ARGUMENT/],
        },
      },
    },
    {
      id: 'nonblocking-sync',
      title: 'The CRM never blocks the ticket UI',
      detail:
        'The handler commits the note and its outbox row in one transaction (`store.commit_note` / `store.commitNote` / `Store.CommitNote`) and answers without touching the CRM; a separate drain (`drain_outbox` / `drainOutbox` / `DrainOutbox`) reads the pending rows and makes the RPC. The starter calls the CRM from the handler, so a CRM outage is a failed post for the agent and a stalled ticket page.',
      match: {
        python: {
          all: [/def post_note\(/, /store\.commit_note\(/, /def drain_outbox\(/],
          none: [/def post_note(?:(?!\ndef )[\s\S])*?(\.SyncNote\(|sync_note\()/],
        },
        typescript: {
          all: [/async function postNote\(/, /store\.commitNote\(/, /drainOutbox\(/],
          none: [
            /async function postNote\((?:(?!\n(?:export )?(?:async )?function )[\s\S])*?(\.syncNote\(|syncNote\()/,
          ],
        },
        go: {
          all: [/func postNote\(/, /store\.CommitNote\(/, /func drainOutbox\(/],
          none: [/func postNote\((?:(?!\nfunc )[\s\S])*?(\.SyncNote\(|syncNote\()/],
        },
        scala: {
          all: [/def postNote\(/, /store\.commitNote\(/, /def drainOutbox\(/],
          none: [/def postNote\((?:(?!\n {2}def )[\s\S])*?(\.syncNote\(|syncNote\()/],
        },
        cpp: {
          all: [/int postNote\(/, /store\.commit_note\(/, /void drain_outbox\(/],
          none: [/int postNote\((?:(?!\n\w)[\s\S])*?(->SyncNote\(|sync_note\()/],
        },
      },
    },
    {
      id: 'retry-policy',
      title: 'Bounded attempts on the retryable statuses only',
      detail:
        'Attempts are capped by `MAX_ATTEMPTS = 3` and only `UNAVAILABLE` and `DEADLINE_EXCEEDED` are retried, with the same idempotency key each time; a permanent status exits instead of spinning. There is no unbounded `while True` / `for (;;)` / `for (;; attempt++)` loop. The starter retries every failure forever.',
      match: {
        python: {
          all: [
            /MAX_ATTEMPTS\s*=\s*3/,
            /range\(MAX_ATTEMPTS\)/,
            /StatusCode\.UNAVAILABLE/,
            /StatusCode\.DEADLINE_EXCEEDED/,
          ],
          none: [/while\s+True/],
        },
        typescript: {
          all: [/MAX_ATTEMPTS\s*=\s*3/, /attempt\s*<\s*MAX_ATTEMPTS/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/],
          none: [/while\s*\(\s*true\s*\)/, /for\s*\(\s*;\s*;\s*\)/],
        },
        go: {
          all: [/maxAttempts\s*=\s*3/, /attempt\s*<\s*maxAttempts/, /codes\.Unavailable/, /codes\.DeadlineExceeded/],
          none: [/for\s+attempt\s*:=\s*0;\s*;\s*attempt\+\+/],
        },
        scala: {
          all: [/MaxAttempts\s*=\s*3/, /attempt\s*<\s*MaxAttempts/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/],
          none: [/while\s*\(\s*true\s*\)/],
        },
        cpp: {
          all: [
            /kMaxAttempts\s*=\s*3/,
            /attempt\s*<\s*kMaxAttempts/,
            /StatusCode::UNAVAILABLE/,
            /StatusCode::DEADLINE_EXCEEDED/,
          ],
          none: [/while\s*\(\s*true\s*\)/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `"""ticketd's CRM client."""
import grpc

import crm_pb2
import crm_pb2_grpc

crm = crm_pb2_grpc.CrmStub(grpc.insecure_channel("crm:9000"))


def post_note(note, store) -> int:
    """POST /v1/tickets/{id}/notes: answers only after the CRM has taken the note."""
    store.append_note(note)
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    sync_note(note)
    return 201


def sync_note(note) -> bool:
    """Push the note to the CRM and keep trying until it lands."""
    while True:
        try:
            request = crm_pb2.SyncNoteRequest(ticket_id=note.ticket_id, body=note.body)
            crm.SyncNote(request)
            return True
        except grpc.RpcError:
            continue
`,
      solution: `"""ticketd's CRM client: notes reach the CRM through the outbox, never from the request path."""
import grpc

import crm_pb2
import crm_pb2_grpc

DEADLINE_S = 3
MAX_ATTEMPTS = 3
RETRYABLE = {grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED}

crm = crm_pb2_grpc.CrmStub(grpc.insecure_channel("crm:9000"))


class TicketStore:
    """Provided. commit_note inserts the note row and its sync_outbox row in one transaction."""

    def commit_note(self, note) -> None:
        raise NotImplementedError

    def pending_syncs(self) -> list:
        """Notes whose outbox row is not synced yet, oldest first."""
        raise NotImplementedError

    def mark_synced(self, note_id: str) -> None:
        raise NotImplementedError

    def quarantine(self, note_id: str, reason: str) -> None:
        """Park the note with a reason; it leaves the pending set."""
        raise NotImplementedError


def post_note(note, store) -> int:
    """POST /v1/tickets/{id}/notes — commit the note and its outbox row, then answer 201.

    The CRM is not on this path: an outage leaves the outbox row pending, never a failed request.
    """
    store.commit_note(note)
    return 201


def sync_note(note, store, crm_stub=crm) -> bool:
    """One bounded sync. The note id is the idempotency key on every attempt."""
    request = crm_pb2.SyncNoteRequest(
        note_id=note.id,
        ticket_id=note.ticket_id,
        body=note.body,
        idempotency_key=note.id,
    )
    for _ in range(MAX_ATTEMPTS):
        try:
            crm_stub.SyncNote(request, timeout=DEADLINE_S)
            return True
        except grpc.RpcError as exc:
            if exc.code() == grpc.StatusCode.INVALID_ARGUMENT:
                store.quarantine(note.id, "crm schema rejected: " + str(exc.details()))
                return False
            if exc.code() not in RETRYABLE:
                store.quarantine(note.id, "crm rejected: " + str(exc.code().name))
                return False
    return False


def drain_outbox(store, crm_stub=crm) -> None:
    """The worker's pass: sync the pending notes, mark the synced, quarantine the rejected."""
    for note in store.pending_syncs():
        if sync_note(note, store, crm_stub):
            store.mark_synced(note.id)
`,
    },
    typescript: {
      starter: `/** ticketd's CRM client. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

interface Note {
  id: string;
  ticketId: string;
  body: string;
}

interface TicketStore {
  appendNote(note: Note): Promise<void>;
}

interface CrmClient {
  syncNote(request: {ticketId: string; body: string}): Promise<{noteId: string}>;
}

const {crm} = grpc.loadPackageDefinition(protoLoader.loadSync('crm.proto')) as unknown as {
  crm: {Crm: new (target: string, credentials: grpc.ChannelCredentials) => CrmClient};
};
const crmClient = new crm.Crm('crm:9000', grpc.credentials.createInsecure());

export async function postNote(note: Note, store: TicketStore): Promise<number> {
  await store.appendNote(note);
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  await syncNote(note);
  return 201;
}

async function syncNote(note: Note): Promise<boolean> {
  for (;;) {
    try {
      await crmClient.syncNote({ticketId: note.ticketId, body: note.body});
      return true;
    } catch {
      continue;
    }
  }
}
`,
      solution: `/** ticketd's CRM client: notes reach the CRM through the outbox, never from the request path. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const DEADLINE_MS = 3000;
const MAX_ATTEMPTS = 3;
const RETRYABLE: Record<number, true> = {
  [grpc.status.UNAVAILABLE]: true,
  [grpc.status.DEADLINE_EXCEEDED]: true,
};

interface Note {
  id: string;
  ticketId: string;
  body: string;
}

interface TicketStore {
  /** INSERT the note and its sync_outbox row in one transaction. */
  commitNote(note: Note): Promise<void>;
  /** Notes whose outbox row is not synced yet, oldest first. */
  pendingSyncs(): Promise<Note[]>;
  markSynced(noteId: string): Promise<void>;
  /** Park the note with a reason; it leaves the pending set. */
  quarantine(noteId: string, reason: string): Promise<void>;
}

interface CrmClient {
  syncNote(
    request: {noteId: string; ticketId: string; body: string; idempotencyKey: string},
    metadata: grpc.Metadata,
    options: {deadline: number},
  ): Promise<{noteId: string}>;
}

const {crm} = grpc.loadPackageDefinition(protoLoader.loadSync('crm.proto')) as unknown as {
  crm: {Crm: new (target: string, credentials: grpc.ChannelCredentials) => CrmClient};
};
const crmClient = new crm.Crm('crm:9000', grpc.credentials.createInsecure());

export async function postNote(note: Note, store: TicketStore): Promise<number> {
  await store.commitNote(note);
  return 201;
}

export async function syncNote(note: Note, store: TicketStore, client: CrmClient): Promise<boolean> {
  const request = {noteId: note.id, ticketId: note.ticketId, body: note.body, idempotencyKey: note.id};
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      await client.syncNote(request, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
      return true;
    } catch (error) {
      const status = error as grpc.ServiceError;
      if (status.code === grpc.status.INVALID_ARGUMENT) {
        await store.quarantine(note.id, 'crm schema rejected: ' + status.details);
        return false;
      }
      if (RETRYABLE[status.code] !== true) {
        await store.quarantine(note.id, 'crm rejected: ' + status.details);
        return false;
      }
    }
  }
  return false;
}

export async function drainOutbox(store: TicketStore, client: CrmClient): Promise<void> {
  for (const note of await store.pendingSyncs()) {
    if (await syncNote(note, store, client)) await store.markSynced(note.id);
  }
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	pb "ticketd/crmpb"
)

type Note struct {
	ID       string
	TicketID string
	Body     string
}

type TicketStore interface {
	AppendNote(ctx context.Context, note Note) error
}

var crm pb.CrmClient

// postNote answers the agent only after the CRM has taken the note.
func postNote(ctx context.Context, note Note, store TicketStore) int {
	if err := store.AppendNote(ctx, note); err != nil {
		return 500
	}
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	syncNote(ctx, note)
	return 201
}

func syncNote(ctx context.Context, note Note) bool {
	for attempt := 0; ; attempt++ {
		_, err := crm.SyncNote(ctx, &pb.SyncNoteRequest{TicketId: note.TicketID, Body: note.Body})
		if err == nil {
			return true
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

	pb "ticketd/crmpb"
)

const (
	deadlineS   = 3
	maxAttempts = 3
)

var retryable = map[codes.Code]bool{
	codes.Unavailable:      true,
	codes.DeadlineExceeded: true,
}

var crm pb.CrmClient

type Note struct {
	ID       string
	TicketID string
	Body     string
}

type TicketStore interface {
	// CommitNote inserts the note row and its sync_outbox row in one transaction.
	CommitNote(ctx context.Context, note Note) error
	// PendingSyncs returns notes whose outbox row is not synced yet, oldest first.
	PendingSyncs(ctx context.Context) ([]Note, error)
	MarkSynced(ctx context.Context, noteID string) error
	// Quarantine parks the note with a reason; it leaves the pending set.
	Quarantine(ctx context.Context, noteID, reason string) error
}

// postNote commits the note and its outbox row, then answers: the CRM is not on this path.
func postNote(ctx context.Context, note Note, store TicketStore) int {
	if err := store.CommitNote(ctx, note); err != nil {
		return 500
	}
	return 201
}

func syncNote(ctx context.Context, note Note, client pb.CrmClient, store TicketStore) bool {
	request := &pb.SyncNoteRequest{
		NoteId:         note.ID,
		TicketId:       note.TicketID,
		Body:           note.Body,
		IdempotencyKey: note.ID,
	}
	for attempt := 0; attempt < maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadlineS*time.Second)
		_, err := client.SyncNote(callCtx, request)
		cancel()
		if err == nil {
			return true
		}
		switch status.Code(err) {
		case codes.Unavailable, codes.DeadlineExceeded:
			// worth another attempt, with the same idempotency key
		case codes.InvalidArgument:
			store.Quarantine(ctx, note.ID, "crm schema rejected: "+status.Convert(err).Message())
			return false
		default:
			store.Quarantine(ctx, note.ID, "crm rejected: "+status.Code(err).String())
			return false
		}
	}
	return false
}

func drainOutbox(ctx context.Context, store TicketStore, client pb.CrmClient) {
	notes, err := store.PendingSyncs(ctx)
	if err != nil {
		return
	}
	for _, note := range notes {
		if syncNote(ctx, note, client, store) {
			store.MarkSynced(ctx, note.ID)
		}
	}
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

object Client {
  val crm = CrmGrpc.blockingStub(ManagedChannelBuilder.forAddress("crm", 9000).usePlaintext().build())

  // postNote answers the agent only after the CRM has taken the note.
  def postNote(note: Note, store: TicketStore): Int = {
    store.appendNote(note)
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    syncNote(note)
    201
  }

  def syncNote(note: Note): Boolean = {
    var synced = false
    while (true) {
      try {
        crm.syncNote(SyncNoteRequest(ticketId = note.ticketId, body = note.body))
        synced = true
      } catch {
        case _: StatusRuntimeException => ()
      }
    }
    synced
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

object Client {
  val DeadlineS = 3
  val MaxAttempts = 3
  val Retryable = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)

  val crm = CrmGrpc.blockingStub(ManagedChannelBuilder.forAddress("crm", 9000).usePlaintext().build())

  // commit the note and its outbox row, then answer: the CRM is not on this path
  def postNote(note: Note, store: TicketStore): Int = {
    store.commitNote(note)
    201
  }

  def syncNote(note: Note, store: TicketStore): Boolean = {
    val request = SyncNoteRequest(
      noteId = note.id,
      ticketId = note.ticketId,
      body = note.body,
      idempotencyKey = note.id,
    )
    var attempt = 0
    while (attempt < MaxAttempts) {
      try {
        crm.withDeadlineAfter(DeadlineS, TimeUnit.SECONDS).syncNote(request)
        return true
      } catch {
        case exc: StatusRuntimeException if exc.getStatus.getCode == Status.Code.INVALID_ARGUMENT =>
          store.quarantine(note.id, "crm schema rejected: " + exc.getStatus.getDescription)
          return false
        case exc: StatusRuntimeException =>
          if (!Retryable.contains(exc.getStatus.getCode)) {
            store.quarantine(note.id, "crm rejected: " + exc.getStatus.getCode)
            return false
          }
      }
      attempt += 1
    }
    false
  }

  // the worker's pass: sync the pending notes, mark the synced, quarantine the rejected
  def drainOutbox(store: TicketStore): Unit =
    store.pendingSyncs().foreach { note =>
      if (syncNote(note, store)) store.markSynced(note.id)
    }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include "crm.grpc.pb.h"

#include <string>

// postNote answers the agent only after the CRM has taken the note.
int postNote(const Note& note, TicketStore& store) {
  store.append_note(note);
  sync_note(note);
  return 201;
}

bool sync_note(const Note& note, Crm::Stub* crm) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  while (true) {
    grpc::ClientContext ctx;
    SyncNoteRequest request;
    request.set_ticket_id(note.ticket_id);
    request.set_body(note.body);
    SyncNoteReply reply;
    if (crm->SyncNote(&ctx, request, &reply).ok()) return true;
  }
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include "crm.grpc.pb.h"

#include <chrono>
#include <string>
#include <vector>

constexpr int kDeadlineS = 3;
constexpr int kMaxAttempts = 3;

class TicketStore {
 public:
  // commit_note inserts the note row and its sync_outbox row in one transaction.
  virtual void commit_note(const Note& note) = 0;
  // pending_syncs returns notes whose outbox row is not synced yet, oldest first.
  virtual std::vector<Note> pending_syncs() = 0;
  virtual void mark_synced(const std::string& note_id) = 0;
  // quarantine parks the note with a reason; it leaves the pending set.
  virtual void quarantine(const std::string& note_id, const std::string& reason) = 0;
  virtual ~TicketStore() = default;
};

// commit the note and its outbox row, then answer: the CRM is not on this path.
int postNote(const Note& note, TicketStore& store) {
  store.commit_note(note);
  return 201;
}

bool sync_note(const Note& note, Crm::Stub* crm, TicketStore& store) {
  SyncNoteRequest request;
  request.set_note_id(note.id);
  request.set_ticket_id(note.ticket_id);
  request.set_body(note.body);
  request.set_idempotency_key(note.id);
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(kDeadlineS));
    SyncNoteReply reply;
    const grpc::Status status = crm->SyncNote(&ctx, request, &reply);
    if (status.ok()) return true;
    if (status.error_code() == grpc::StatusCode::INVALID_ARGUMENT) {
      store.quarantine(note.id, "crm schema rejected: " + status.error_message());
      return false;
    }
    if (status.error_code() != grpc::StatusCode::UNAVAILABLE &&
        status.error_code() != grpc::StatusCode::DEADLINE_EXCEEDED) {
      store.quarantine(note.id, "crm rejected: " + status.error_message());
      return false;
    }
  }
  return false;
}

// the worker's pass: sync the pending notes, mark the synced, quarantine the rejected
void drain_outbox(TicketStore& store, Crm::Stub* crm) {
  for (const auto& note : store.pending_syncs()) {
    if (sync_note(note, crm, store)) store.mark_synced(note.id);
  }
}
`,
    },
  },
  debrief: `The fix answers one question four ways: what does a retry mean here? The note id is the idempotency key because it is the identity of the thing being created, so the CRM updates the record it already made instead of appending a copy. The deadline stops one silent dependency from pinning the worker. The retryable set separates "the CRM was briefly away" from "the CRM will not accept this note", and quarantine parks the second kind with a reason. The outbox commits the note with its pending-sync row, so a CRM outage degrades the sync rather than the ticket page.

Production clients add jittered backoff and reconcile CRM note ids against the store.`,
};
