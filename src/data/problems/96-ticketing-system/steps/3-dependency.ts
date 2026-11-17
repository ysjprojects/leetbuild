import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'CRM sync through an outbox, one key per note',
  concept: 'grpc',
  guides: ['deadlines-and-retries', 'failing-dependencies'],
  file: 'crm_sync',
  focus: ['api', 'store', 'worker', 'crm'],
  task: `## Task

**Starting point.** The starter is ticketd's CRM sync over gRPC (\`Crm.SyncNote\`):
\`post_note(ticket_id, author, visibility, body)\` appends the note with \`store.append_note\` and calls
\`sync_note(note)\` before it answers; \`sync_note\` sends \`SyncNoteRequest\` and retries any error,
sleeping a second between attempts, until the CRM takes it; \`drain_outbox()\` syncs the notes in
\`crm:outbox\` and marks them synced. With the CRM healthy it works, and it hides 5 flaws.

**Failure mode the checks target.** A slow CRM makes every agent wait on their own post, a CRM that
never answers holds the sync forever, a lost reply records the agent's note twice in the customer's
CRM record, an outage is retried without end, and a note the CRM refuses is sent again and again.

\`\`\`proto
service Crm { rpc SyncNote(SyncNoteRequest) returns (SyncNoteReply); }  // INVALID_ARGUMENT: schema refused
\`\`\`

- \`post_note\` commits the note with its outbox entry (\`store.commit_note\`) and answers; only
  \`drain_outbox\` calls the CRM.
- Every attempt carries a \`DEADLINE_S\` = 3 s deadline and \`idempotency_key\` = the note id.
- At most \`MAX_ATTEMPTS\` = 3 attempts, retrying only \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\`; when
  they run out \`sync_note\` answers \`False\` and the note stays in the outbox.
- Any other status is permanent: \`store.quarantine(note_id, reason)\` and answer \`False\`.`,
  sequence: {
    participants: ['Ticket API', 'Ticket store', 'Outbox drain', 'CRM'],
    messages: [
      {from: 'Ticket API', to: 'Ticket store', label: 'commit_note: note + crm:outbox, one script', kind: 'sync'},
      {from: 'Ticket store', to: 'Ticket API', label: 'note N-7 · answered before any CRM call', kind: 'reply'},
      {from: 'Outbox drain', to: 'Ticket store', label: 'pending_syncs()', kind: 'sync'},
      {
        from: 'Outbox drain',
        to: 'CRM',
        label: 'SyncNote{idempotency_key: N-7} · deadline 3 s · ≤ 3 attempts',
        kind: 'sync',
      },
      {
        from: 'CRM',
        to: 'Outbox drain',
        label: 'reply · UNAVAILABLE → same key again · INVALID_ARGUMENT',
        kind: 'reply',
      },
      {from: 'Outbox drain', to: 'Ticket store', label: 'mark_synced · quarantine(N-7, reason)', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'nonblocking-sync',
      title: 'Posting a note never waits on the CRM',
      detail:
        '`post_note` commits the note together with its `crm:outbox` entry (`store.commit_note`) and answers; the drain makes the RPC. The starter calls `sync_note` before answering, so the agent waits on the CRM and an outage fails their post.',
      match: {
        python: {all: [/store\.commit_note\(/], none: [/def post_note(?:(?!\ndef )[\s\S])*?sync_note\(/]},
        typescript: {
          all: [/\bcommitNote\(/],
          none: [/function postNote\((?:(?!\n(?:export )?(?:async )?function )[\s\S])*?syncNote\(/],
        },
        go: {all: [/store\.CommitNote\(/], none: [/func postNote\((?:(?!\nfunc )[\s\S])*?syncNote\(/]},
        scala: {all: [/Store\.commitNote\(/], none: [/def postNote\((?:(?!\n {2}(?:def|\/\*\*) )[\s\S])*?syncNote\(/]},
        cpp: {all: [/store::commitNote\(/], none: [/store::Note postNote\((?:(?!\n\})[\s\S])*?syncNote\(/]},
      },
    },
    {
      id: 'sync-deadline',
      title: 'Every attempt carries a 3-second deadline',
      detail:
        'Each `SyncNote` attempt is made with its own `DEADLINE_S` (3 s), so a CRM that accepts the connection and never answers costs one attempt, not the drain, and the attempts after it still get their full 3 s; the starter sets no deadline.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*3\b/, /SyncNote\([^)]*timeout\s*=\s*DEADLINE_S/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*3000\b/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/]},
        go: {all: [/deadline\s*=\s*3\s*\*\s*time\.Second/, /context\.WithTimeout\([^\n]*deadline\)/]},
        scala: {all: [/DeadlineSeconds\s*=\s*3L?\b/, /withDeadlineAfter\(\s*DeadlineSeconds/]},
        cpp: {all: [/kDeadline\{3\}/, /set_deadline\([^\n]*kDeadline\)/]},
      },
    },
    {
      id: 'idempotent-sync',
      title: 'The note id is the idempotency key',
      detail:
        'Every attempt sends `idempotency_key` = the note id, so when a reply is lost after the CRM recorded the note, the retry updates that record instead of adding a second; the starter sends no key.',
      match: {
        python: {all: [/idempotency_key\s*=\s*note\[["']id["']\]/]},
        typescript: {all: [/idempotency_key:\s*note\.id\b/]},
        go: {all: [/IdempotencyKey:\s*note\.ID\b/]},
        scala: {all: [/idempotencyKey\s*=\s*note\.id\b/]},
        cpp: {all: [/set_idempotency_key\(\s*note\.id\s*\)/]},
      },
    },
    {
      id: 'retry-policy',
      title: 'Three attempts, on transient statuses only',
      detail:
        'Attempts are bounded by `MAX_ATTEMPTS` (3) and only `UNAVAILABLE` and `DEADLINE_EXCEEDED` earn another; when they run out the note stays in the outbox for the next drain. The starter loops until the CRM answers.',
      match: {
        python: {
          all: [/MAX_ATTEMPTS\s*=\s*3\b/, /range\(MAX_ATTEMPTS\)/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/],
          none: [/while\s+True/],
        },
        typescript: {
          all: [/MAX_ATTEMPTS\s*=\s*3\b/, /attempt\s*<\s*MAX_ATTEMPTS/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/],
          none: [/for\s*\(\s*;\s*;\s*\)/, /while\s*\(\s*true\s*\)/],
        },
        go: {
          all: [/maxAttempts\s*=\s*3\b/, /attempt\s*<\s*maxAttempts/, /codes\.Unavailable/, /codes\.DeadlineExceeded/],
          none: [/\bfor\s*\{/],
        },
        scala: {
          all: [/MaxAttempts\s*=\s*3\b/, /attempt\s*<\s*MaxAttempts/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/],
          none: [/while\s*\(\s*true\s*\)/],
        },
        cpp: {
          all: [/kMaxAttempts\s*=\s*3\b/, /attempt\s*<\s*kMaxAttempts/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/],
          none: [/while\s*\(\s*true\s*\)/, /for\s*\(\s*;\s*;\s*\)/],
        },
      },
    },
    {
      id: 'quarantine-schema',
      title: 'A refused note is quarantined',
      detail:
        'A status other than the two transient ones is permanent: the note goes to `store.quarantine` with the status as its reason and leaves the outbox after one attempt; the starter sends it again until the CRM gives in.',
      match: {
        python: {all: [/store\.quarantine\(\s*note\[["']id["']\]/]},
        typescript: {all: [/\bquarantine\(\s*note\.id/]},
        go: {all: [/store\.Quarantine\([^\n]*note\.ID/]},
        scala: {all: [/Store\.quarantine\(\s*note\.id/]},
        cpp: {all: [/store::quarantine\(\s*note\.id/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""ticketd's CRM sync: every note an agent posts is recorded against the customer's CRM record."""
import time

import grpc

import ticketing_system_pb2 as pb
import ticketing_system_pb2_grpc as pb_grpc
from tickets import store  # append_note, commit_note, pending_syncs, mark_synced, quarantine

BACKOFF_S = 1.0

crm = pb_grpc.CrmStub(grpc.insecure_channel("crm:9000"))


def post_note(ticket_id: str, author: str, visibility: str, body: str) -> dict:
    """POST /v1/tickets/{id}/notes: store the note and get it to the CRM; returns the note."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    note = store.append_note(ticket_id, author, visibility, body)
    sync_note(note)
    return note


def sync_note(note: dict) -> bool:
    """Push one note to the CRM; True once the CRM holds it."""
    request = pb.SyncNoteRequest(note_id=note["id"], ticket_id=note["ticket_id"], author=note["author"], body=note["body"])
    while True:
        try:
            crm.SyncNote(request)
            return True
        except grpc.RpcError:
            time.sleep(BACKOFF_S)


def drain_outbox() -> int:
    """The worker's pass over crm:outbox; returns how many notes the CRM took."""
    synced = 0
    for note in store.pending_syncs():
        if sync_note(note):
            store.mark_synced(note["id"])
            synced += 1
    return synced
`,
      solution: `"""ticketd's CRM sync: every note an agent posts is recorded against the customer's CRM record."""
import grpc

import ticketing_system_pb2 as pb
import ticketing_system_pb2_grpc as pb_grpc
from tickets import store  # append_note, commit_note, pending_syncs, mark_synced, quarantine

DEADLINE_S = 3
MAX_ATTEMPTS = 3
RETRYABLE = (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED)

crm = pb_grpc.CrmStub(grpc.insecure_channel("crm:9000"))


def post_note(ticket_id: str, author: str, visibility: str, body: str) -> dict:
    """POST /v1/tickets/{id}/notes: store the note and get it to the CRM; returns the note."""
    # The note and the promise to sync it commit together; the drain talks to the CRM.
    return store.commit_note(ticket_id, author, visibility, body)


def sync_note(note: dict) -> bool:
    """Push one note to the CRM; True once the CRM holds it, False when it stays pending or was quarantined."""
    request = pb.SyncNoteRequest(
        note_id=note["id"], ticket_id=note["ticket_id"], author=note["author"], body=note["body"], idempotency_key=note["id"]
    )
    for _ in range(MAX_ATTEMPTS):
        try:
            crm.SyncNote(request, timeout=DEADLINE_S)
            return True
        except grpc.RpcError as err:
            if err.code() not in RETRYABLE:
                store.quarantine(note["id"], f"{err.code().name}: {err.details()}")
                return False
    return False


def drain_outbox() -> int:
    """The worker's pass over crm:outbox; returns how many notes the CRM took."""
    synced = 0
    for note in store.pending_syncs():
        if sync_note(note):
            store.mark_synced(note["id"])
            synced += 1
    return synced
`,
    },
    typescript: {
      starter: `/** ticketd's CRM sync: every note an agent posts is recorded against the customer's CRM record. */
import {setTimeout as sleep} from 'node:timers/promises';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {type Note, appendNote, markSynced, pendingSyncs} from 'tickets/store';

export const BACKOFF_MS = 1000;

interface SyncNoteRequest {
  note_id: string;
  ticket_id: string;
  author: string;
  body: string;
  idempotency_key?: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('ticketing_system.proto')) as unknown as {
  ticketcrm: {Crm: grpc.ServiceClientConstructor};
};
const crm = new pkg.ticketcrm.Crm('crm:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  SyncNote(request: SyncNoteRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{crm_note_id: string; duplicate: boolean}>;
};

/** POST /v1/tickets/{id}/notes: store the note and get it to the CRM; returns the note. */
export async function postNote(ticketId: string, author: string, visibility: string, body: string): Promise<Note> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const note = await appendNote(ticketId, author, visibility, body);
  await syncNote(note);
  return note;
}

/** Push one note to the CRM; true once the CRM holds it. */
export async function syncNote(note: Note): Promise<boolean> {
  const request = {note_id: note.id, ticket_id: note.ticket_id, author: note.author, body: note.body};
  for (;;) {
    try {
      await crm.SyncNote(request, new grpc.Metadata(), {});
      return true;
    } catch {
      await sleep(BACKOFF_MS);
    }
  }
}

/** The worker's pass over crm:outbox; returns how many notes the CRM took. */
export async function drainOutbox(): Promise<number> {
  let synced = 0;
  for (const note of await pendingSyncs()) {
    if (await syncNote(note)) {
      await markSynced(note.id);
      synced += 1;
    }
  }
  return synced;
}
`,
      solution: `/** ticketd's CRM sync: every note an agent posts is recorded against the customer's CRM record. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {type Note, commitNote, markSynced, pendingSyncs, quarantine} from 'tickets/store';

export const DEADLINE_MS = 3000;
export const MAX_ATTEMPTS = 3;
const RETRYABLE = [grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED];

interface SyncNoteRequest {
  note_id: string;
  ticket_id: string;
  author: string;
  body: string;
  idempotency_key?: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('ticketing_system.proto')) as unknown as {
  ticketcrm: {Crm: grpc.ServiceClientConstructor};
};
const crm = new pkg.ticketcrm.Crm('crm:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  SyncNote(request: SyncNoteRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{crm_note_id: string; duplicate: boolean}>;
};

/** POST /v1/tickets/{id}/notes: store the note and get it to the CRM; returns the note. */
export async function postNote(ticketId: string, author: string, visibility: string, body: string): Promise<Note> {
  // The note and the promise to sync it commit together; the drain talks to the CRM.
  return commitNote(ticketId, author, visibility, body);
}

/** Push one note to the CRM; true once the CRM holds it, false when it stays pending or was quarantined. */
export async function syncNote(note: Note): Promise<boolean> {
  const request = {note_id: note.id, ticket_id: note.ticket_id, author: note.author, body: note.body, idempotency_key: note.id};
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      await crm.SyncNote(request, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
      return true;
    } catch (e) {
      const {code, details} = e as grpc.ServiceError;
      if (!RETRYABLE.includes(code)) {
        await quarantine(note.id, \`\${grpc.status[code]}: \${details}\`);
        return false;
      }
    }
  }
  return false;
}

/** The worker's pass over crm:outbox; returns how many notes the CRM took. */
export async function drainOutbox(): Promise<number> {
  let synced = 0;
  for (const note of await pendingSyncs()) {
    if (await syncNote(note)) {
      await markSynced(note.id);
      synced += 1;
    }
  }
  return synced;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "tickets/gen/ticketing_system"
	"tickets/store" // store.AppendNote, CommitNote, PendingSyncs, MarkSynced, Quarantine
)

const backoff = time.Second

var (
	crmConn, _ = grpc.NewClient("crm:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	crm        = pb.NewCrmClient(crmConn)
)

// postNote stores an agent's note and gets it to the CRM; it returns the note.
func postNote(ctx context.Context, ticketID, author, visibility, body string) (*store.Note, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	note, err := store.AppendNote(ctx, ticketID, author, visibility, body)
	if err != nil {
		return nil, err
	}
	syncNote(ctx, *note)
	return note, nil
}

// syncNote pushes one note to the CRM; true once the CRM holds it.
func syncNote(ctx context.Context, note store.Note) bool {
	request := &pb.SyncNoteRequest{NoteId: note.ID, TicketId: note.TicketID, Author: note.Author, Body: note.Body}
	for {
		if _, err := crm.SyncNote(ctx, request); err == nil {
			return true
		}
		time.Sleep(backoff)
	}
}

// drainOutbox is the worker's pass over crm:outbox; it returns how many notes the CRM took.
func drainOutbox(ctx context.Context) int {
	synced := 0
	for _, note := range store.PendingSyncs(ctx) {
		if syncNote(ctx, note) {
			store.MarkSynced(ctx, note.ID)
			synced++
		}
	}
	return synced
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

	pb "tickets/gen/ticketing_system"
	"tickets/store" // store.AppendNote, CommitNote, PendingSyncs, MarkSynced, Quarantine
)

const (
	deadline    = 3 * time.Second
	maxAttempts = 3
)

var (
	crmConn, _ = grpc.NewClient("crm:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	crm        = pb.NewCrmClient(crmConn)
)

// postNote stores an agent's note and gets it to the CRM; it returns the note.
func postNote(ctx context.Context, ticketID, author, visibility, body string) (*store.Note, error) {
	// The note and the promise to sync it commit together; the drain talks to the CRM.
	return store.CommitNote(ctx, ticketID, author, visibility, body)
}

// syncNote pushes one note to the CRM; true once the CRM holds it, false when it stays pending or was quarantined.
func syncNote(ctx context.Context, note store.Note) bool {
	request := &pb.SyncNoteRequest{NoteId: note.ID, TicketId: note.TicketID, Author: note.Author, Body: note.Body, IdempotencyKey: note.ID}
	for attempt := 0; attempt < maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		_, err := crm.SyncNote(callCtx, request)
		cancel()
		if err == nil {
			return true
		}
		if code := status.Code(err); code != codes.Unavailable && code != codes.DeadlineExceeded {
			store.Quarantine(ctx, note.ID, code.String()+": "+status.Convert(err).Message())
			return false
		}
	}
	return false
}

// drainOutbox is the worker's pass over crm:outbox; it returns how many notes the CRM took.
func drainOutbox(ctx context.Context) int {
	synced := 0
	for _, note := range store.PendingSyncs(ctx) {
		if syncNote(ctx, note) {
			store.MarkSynced(ctx, note.ID)
			synced++
		}
	}
	return synced
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import ticketcrm.ticketing_system.{CrmGrpc, SyncNoteRequest}
import tickets.Store // Store.appendNote, commitNote, pendingSyncs, markSynced, quarantine

object CrmSync {
  val BackoffMillis = 1000L

  private val crm = CrmGrpc.blockingStub(ManagedChannelBuilder.forAddress("crm", 9000).usePlaintext().build())

  /** POST /v1/tickets/{id}/notes: store the note and get it to the CRM; returns the note. */
  def postNote(ticketId: String, author: String, visibility: String, body: String): Store.Note = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    val note = Store.appendNote(ticketId, author, visibility, body)
    syncNote(note)
    note
  }

  /** Push one note to the CRM; true once the CRM holds it. */
  def syncNote(note: Store.Note): Boolean = {
    val request = SyncNoteRequest(noteId = note.id, ticketId = note.ticketId, author = note.author, body = note.body)
    while (true) {
      try {
        crm.syncNote(request)
        return true
      } catch {
        case _: StatusRuntimeException => Thread.sleep(BackoffMillis)
      }
    }
    false
  }

  /** The worker's pass over crm:outbox; returns how many notes the CRM took. */
  def drainOutbox(): Int =
    Store.pendingSyncs().count { note =>
      val synced = syncNote(note)
      if (synced) Store.markSynced(note.id)
      synced
    }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import ticketcrm.ticketing_system.{CrmGrpc, SyncNoteRequest}
import tickets.Store // Store.appendNote, commitNote, pendingSyncs, markSynced, quarantine

object CrmSync {
  val DeadlineSeconds = 3L
  val MaxAttempts = 3
  private val Retryable = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)

  private val crm = CrmGrpc.blockingStub(ManagedChannelBuilder.forAddress("crm", 9000).usePlaintext().build())

  /** POST /v1/tickets/{id}/notes: store the note and get it to the CRM; returns the note. */
  def postNote(ticketId: String, author: String, visibility: String, body: String): Store.Note =
    // The note and the promise to sync it commit together; the drain talks to the CRM.
    Store.commitNote(ticketId, author, visibility, body)

  /** Push one note to the CRM; true once the CRM holds it, false when it stays pending or was quarantined. */
  def syncNote(note: Store.Note): Boolean = {
    val request = SyncNoteRequest(noteId = note.id, ticketId = note.ticketId, author = note.author, body = note.body, idempotencyKey = note.id)
    var attempt = 0
    while (attempt < MaxAttempts) {
      try {
        crm.withDeadlineAfter(DeadlineSeconds, TimeUnit.SECONDS).syncNote(request)
        return true
      } catch {
        case e: StatusRuntimeException if !Retryable.contains(e.getStatus.getCode) =>
          Store.quarantine(note.id, s"\${e.getStatus.getCode}: \${e.getStatus.getDescription}")
          return false
        case _: StatusRuntimeException => attempt += 1
      }
    }
    false
  }

  /** The worker's pass over crm:outbox; returns how many notes the CRM took. */
  def drainOutbox(): Int =
    Store.pendingSyncs().count { note =>
      val synced = syncNote(note)
      if (synced) Store.markSynced(note.id)
      synced
    }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <string>
#include <thread>

#include "ticketing_system.grpc.pb.h"
#include "tickets/store.h"  // store::appendNote, commitNote, pendingSyncs, markSynced, quarantine

constexpr std::chrono::seconds kBackoff{1};

auto crm = ticketcrm::Crm::NewStub(grpc::CreateChannel("crm:9000", grpc::InsecureChannelCredentials()));

bool syncNote(const store::Note& note);

// POST /v1/tickets/{id}/notes: store the note and get it to the CRM; returns the note.
store::Note postNote(const std::string& ticket_id, const std::string& author, const std::string& visibility,
                     const std::string& body) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const store::Note note = store::appendNote(ticket_id, author, visibility, body);
  syncNote(note);
  return note;
}

// Push one note to the CRM; true once the CRM holds it.
bool syncNote(const store::Note& note) {
  ticketcrm::SyncNoteRequest request;
  request.set_note_id(note.id);
  request.set_ticket_id(note.ticket_id);
  request.set_author(note.author);
  request.set_body(note.body);
  while (true) {
    grpc::ClientContext ctx;
    ticketcrm::SyncNoteReply reply;
    if (crm->SyncNote(&ctx, request, &reply).ok()) return true;
    std::this_thread::sleep_for(kBackoff);
  }
}

// The worker's pass over crm:outbox; returns how many notes the CRM took.
int drainOutbox() {
  int synced = 0;
  for (const store::Note& note : store::pendingSyncs()) {
    if (syncNote(note)) {
      store::markSynced(note.id);
      ++synced;
    }
  }
  return synced;
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <string>

#include "ticketing_system.grpc.pb.h"
#include "tickets/store.h"  // store::appendNote, commitNote, pendingSyncs, markSynced, quarantine

constexpr std::chrono::seconds kDeadline{3};
constexpr int kMaxAttempts = 3;

auto crm = ticketcrm::Crm::NewStub(grpc::CreateChannel("crm:9000", grpc::InsecureChannelCredentials()));

// POST /v1/tickets/{id}/notes: store the note and get it to the CRM; returns the note.
store::Note postNote(const std::string& ticket_id, const std::string& author, const std::string& visibility,
                     const std::string& body) {
  // The note and the promise to sync it commit together; the drain talks to the CRM.
  return store::commitNote(ticket_id, author, visibility, body);
}

// Push one note to the CRM; true once the CRM holds it, false when it stays pending or was quarantined.
bool syncNote(const store::Note& note) {
  ticketcrm::SyncNoteRequest request;
  request.set_note_id(note.id);
  request.set_ticket_id(note.ticket_id);
  request.set_author(note.author);
  request.set_body(note.body);
  request.set_idempotency_key(note.id);
  for (int attempt = 0; attempt < kMaxAttempts; ++attempt) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    ticketcrm::SyncNoteReply reply;
    const grpc::Status status = crm->SyncNote(&ctx, request, &reply);
    if (status.ok()) return true;
    const grpc::StatusCode code = status.error_code();
    if (code != grpc::StatusCode::UNAVAILABLE && code != grpc::StatusCode::DEADLINE_EXCEEDED) {
      store::quarantine(note.id, "status " + std::to_string(static_cast<int>(code)) + ": " + status.error_message());
      return false;
    }
  }
  return false;
}

// The worker's pass over crm:outbox; returns how many notes the CRM took.
int drainOutbox() {
  int synced = 0;
  for (const store::Note& note : store::pendingSyncs()) {
    if (syncNote(note)) {
      store::markSynced(note.id);
      ++synced;
    }
  }
  return synced;
}
`,
    },
  },
  harness: {
    python: `import re

import grpc

import ticketing_system_pb2 as pb
import ticketing_system_pb2_grpc as pb_grpc
from tickets import store

REPLY = "We refunded the second charge."


class Crm(pb_grpc.CrmServicer):
    """The CRM: one record per idempotency key (a request without one is always a new record).
    drop_replies: how many of the next calls are recorded but answered UNAVAILABLE, a reply lost on its way back."""

    def __init__(self):
        self.records = []
        self.keys = {}
        self.drop_replies = 0

    def SyncNote(self, request, context):
        key = request.idempotency_key
        if key and key in self.keys:
            reply = pb.SyncNoteReply(crm_note_id=self.keys[key], duplicate=True)
        else:
            self.records.append(request.note_id)
            reply = pb.SyncNoteReply(crm_note_id=f"crm-{len(self.records)}")
            if key:
                self.keys[key] = reply.crm_note_id
        if self.drop_replies > 0:
            self.drop_replies -= 1
            context.abort(grpc.StatusCode.UNAVAILABLE, "connection reset before the reply")
        return reply


def _crm(ctx):
    crm = Crm()
    ctx.grpc.serve(pb_grpc.add_CrmServicer_to_server, crm)
    return ctx.load("crm_sync"), crm


def _note():
    ticket_id = store.create_ticket("R-1", "Invoice 4471 charged twice")["id"]
    return store.commit_note(ticket_id, "A-1", "public", REPLY)


def _pending():
    return [n["id"] for n in store.pending_syncs()]


def check_nonblocking_sync(ctx):
    m, crm = _crm(ctx)
    ticket_id = store.create_ticket("R-1", "Invoice 4471 charged twice")["id"]
    ctx.grpc.set_latency("SyncNote", 2.0)
    note = m.post_note(ticket_id, "A-1", "public", REPLY)
    calls = len(ctx.grpc.calls_to("SyncNote"))
    assert calls == 0, f"post_note called the CRM {calls} time(s) before answering: the agent waits on the CRM and an outage fails their post. Commit the note with its outbox entry and answer"
    assert _pending() == [note["id"]], f"the posted note must wait in crm:outbox, which holds {_pending()}"
    ctx.grpc.set_latency("SyncNote", 0.0)
    assert m.drain_outbox() == 1, "the drain must sync the one pending note"
    assert _pending() == [], f"a synced note must leave crm:outbox, which holds {_pending()}"
    assert ctx.redis.sismember("crm:synced", note["id"]), "the drain must mark the note synced"
    assert crm.records == [note["id"]], f"the CRM holds {crm.records}, expected the one note"


def check_sync_deadline(ctx):
    m, _ = _crm(ctx)
    note = _note()
    assert m.sync_note(note) is True, "with the CRM healthy the sync must succeed"
    timeout = ctx.grpc.calls_to("SyncNote")[0].timeout
    assert timeout is not None, "a SyncNote call carries no deadline: a CRM that accepts the connection and never answers holds the drain forever"
    assert 2.5 <= timeout <= 3.5, f"a SyncNote call carries a {timeout} s deadline, expected DEADLINE_S = 3"
    ctx.grpc.set_latency("SyncNote", 30.0)
    started = ctx.clock.time()
    assert m.sync_note(note) is False, "a CRM that takes 30 s per call must not count as synced"
    took = ctx.clock.time() - started
    assert took <= 10, f"sync_note spent {took:.0f} s on a CRM that does not answer, expected at most MAX_ATTEMPTS × DEADLINE_S"
    slow = ctx.grpc.calls_to("SyncNote")[1:]
    assert len(slow) == 3, f"a CRM that never answers got {len(slow)} attempts: a deadline exceeded is transient, so the sync makes MAX_ATTEMPTS = 3"
    timeouts = [c.timeout for c in slow]
    assert all(t is not None and 2.5 <= t <= 3.5 for t in timeouts), f"the attempts carried deadlines {timeouts}: every attempt gets its own DEADLINE_S = 3, not what is left of the first one's"
    assert not ctx.redis.hexists("crm:quarantine", note["id"]), "a note whose attempts ran out of time was quarantined: DEADLINE_EXCEEDED is transient, the note stays in crm:outbox"
    assert _pending() == [note["id"]], f"a note whose attempts ran out of time must stay in crm:outbox, which holds {_pending()}"


def check_idempotent_sync(ctx):
    m, crm = _crm(ctx)
    note = _note()
    crm.drop_replies = 1
    assert m.sync_note(note) is True, "after one lost reply the retry must land"
    assert crm.records == [note["id"]], f"the CRM recorded the note {len(crm.records)} times after one lost reply: the retry made a second record. Send the note id as idempotency_key"
    keys = [c.request.idempotency_key for c in ctx.grpc.calls_to("SyncNote")]
    assert keys == [note["id"]] * len(keys), f"the attempts carried idempotency keys {keys}, expected the note id {note['id']} on each"


def check_retry_policy(ctx):
    m, _ = _crm(ctx)
    note = _note()
    ctx.grpc.fail("SyncNote", grpc.StatusCode.UNAVAILABLE, "crm restarting", times=5)
    assert m.sync_note(note) is False, "five UNAVAILABLE in a row: the sync must give up after MAX_ATTEMPTS = 3 and answer False"
    calls = len(ctx.grpc.calls_to("SyncNote"))
    assert calls == 3, f"the sync made {calls} attempts, expected MAX_ATTEMPTS = 3"
    assert _pending() == [note["id"]], f"a note whose attempts ran out must stay in crm:outbox for the next drain, which holds {_pending()}"
    assert m.drain_outbox() == 1, "the next drain (two more failures, then a healthy CRM) must sync the note"
    assert _pending() == [], f"crm:outbox holds {_pending()} after the note was synced"
    note = _note()
    before = len(ctx.grpc.calls_to("SyncNote"))
    ctx.grpc.fail("SyncNote", grpc.StatusCode.DEADLINE_EXCEEDED, "crm too slow", times=2)
    assert m.sync_note(note) is True, "two DEADLINE_EXCEEDED then a healthy CRM: DEADLINE_EXCEEDED is transient, so the third attempt must land"
    calls = len(ctx.grpc.calls_to("SyncNote")) - before
    assert calls == 3, f"the sync made {calls} attempts after two DEADLINE_EXCEEDED, expected 3"


def check_quarantine_schema(ctx):
    m, _ = _crm(ctx)
    note = _note()
    before = len(ctx.grpc.calls_to("SyncNote"))
    ctx.grpc.fail("SyncNote", grpc.StatusCode.INVALID_ARGUMENT, "author A-1 is not a CRM user", times=1)
    assert m.sync_note(note) is False, "a note the CRM's schema refuses must not count as synced"
    calls = len(ctx.grpc.calls_to("SyncNote")) - before
    assert calls == 1, f"a note the CRM refused with INVALID_ARGUMENT was sent {calls} times: the refusal is permanent, another attempt gets the same answer"
    reason = ctx.redis.hget("crm:quarantine", note["id"])
    assert reason, "the refused note is not in crm:quarantine: store.quarantine(note id, reason) parks it with the reason for a person to look at"
    assert re.search(r"invalid[_ ]?argument|\\b3\\b", reason, re.I), f"the quarantine reason is {reason!r}: it must name the status the CRM answered (INVALID_ARGUMENT)"
    assert _pending() == [], f"a quarantined note must leave crm:outbox, or every drain sends it again; it holds {_pending()}"
    for code in (grpc.StatusCode.PERMISSION_DENIED, grpc.StatusCode.FAILED_PRECONDITION, grpc.StatusCode.INTERNAL):
        note = _note()
        before = len(ctx.grpc.calls_to("SyncNote"))
        ctx.grpc.fail("SyncNote", code, "refused", times=1)
        assert m.sync_note(note) is False, f"a note the CRM refused with {code.name} must not count as synced"
        calls = len(ctx.grpc.calls_to("SyncNote")) - before
        assert calls == 1, f"a note the CRM refused with {code.name} was sent {calls} times: only UNAVAILABLE and DEADLINE_EXCEEDED are transient"
        assert ctx.redis.hexists("crm:quarantine", note["id"]), f"a note the CRM refused with {code.name} is not in crm:quarantine: every status but the two transient ones is permanent"
`,
    typescript: `const REPLY = 'We refunded the second charge.';

/** The CRM: one record per idempotency key (a request without one is always a new record); dropReplies of the next calls are recorded but answered UNAVAILABLE. */
function crmSync(ctx) {
  const pkg = ctx.proto('ticketing_system.proto');
  const crm = {records: [] as string[], keys: new Map<string, string>(), dropReplies: 0};
  ctx.grpc.serve(pkg.ticketcrm.Crm.service, {
    SyncNote(call, callback) {
      const {note_id, idempotency_key} = call.request;
      let reply;
      if (idempotency_key && crm.keys.has(idempotency_key)) {
        reply = {crm_note_id: crm.keys.get(idempotency_key), duplicate: true};
      } else {
        crm.records.push(note_id);
        reply = {crm_note_id: \`crm-\${crm.records.length}\`, duplicate: false};
        if (idempotency_key) crm.keys.set(idempotency_key, reply.crm_note_id);
      }
      if (crm.dropReplies > 0) {
        crm.dropReplies -= 1;
        return callback({code: ctx.grpc.status.UNAVAILABLE, details: 'connection reset before the reply'});
      }
      callback(null, reply);
    },
  });
  return {m: ctx.load('crm_sync'), store: ctx.load('/support/tickets/store.ts'), crm};
}

async function newNote(store) {
  const ticket = await store.createTicket('R-1', 'Invoice 4471 charged twice');
  return store.commitNote(ticket.id, 'A-1', 'public', REPLY);
}

const pending = async store => (await store.pendingSyncs()).map(n => n.id);

export async function check_nonblocking_sync(ctx) {
  const {m, store, crm} = crmSync(ctx);
  const ticket = await store.createTicket('R-1', 'Invoice 4471 charged twice');
  ctx.grpc.setLatency('SyncNote', 2.0);
  const note = await m.postNote(ticket.id, 'A-1', 'public', REPLY);
  const calls = ctx.grpc.callsTo('SyncNote').length;
  assert.equal(calls, 0, \`postNote called the CRM \${calls} time(s) before answering: the agent waits on the CRM and an outage fails their post. Commit the note with its outbox entry and answer\`);
  assert.deepStrictEqual(await pending(store), [note.id], \`the posted note must wait in crm:outbox, which holds \${JSON.stringify(await pending(store))}\`);
  ctx.grpc.setLatency('SyncNote', 0);
  assert.equal(await m.drainOutbox(), 1, 'the drain must sync the one pending note');
  assert.deepStrictEqual(await pending(store), [], 'a synced note must leave crm:outbox');
  assert.equal(ctx.redis.sismember('crm:synced', note.id), 1, 'the drain must mark the note synced');
  assert.deepStrictEqual(crm.records, [note.id], \`the CRM holds \${JSON.stringify(crm.records)}, expected the one note\`);
}

export async function check_sync_deadline(ctx) {
  const {m, store} = crmSync(ctx);
  const note = await newNote(store);
  assert.equal(await m.syncNote(note), true, 'with the CRM healthy the sync must succeed');
  const timeout = ctx.grpc.callsTo('SyncNote')[0].timeout;
  assert(timeout !== null && timeout !== undefined, 'a SyncNote call carries no deadline: a CRM that accepts the connection and never answers holds the drain forever');
  assert(timeout >= 2.5 && timeout <= 3.5, \`a SyncNote call carries a \${timeout} s deadline, expected DEADLINE_MS = 3000\`);
  ctx.grpc.setLatency('SyncNote', 30.0);
  const started = ctx.clock.now();
  assert.equal(await m.syncNote(note), false, 'a CRM that takes 30 s per call must not count as synced');
  const took = (ctx.clock.now() - started) / 1000;
  assert(took <= 10, \`syncNote spent \${took} s on a CRM that does not answer, expected at most MAX_ATTEMPTS × DEADLINE_MS\`);
  const slow = ctx.grpc.callsTo('SyncNote').slice(1);
  assert.equal(slow.length, 3, \`a CRM that never answers got \${slow.length} attempts: a deadline exceeded is transient, so the sync makes MAX_ATTEMPTS = 3\`);
  const timeouts = slow.map(c => c.timeout);
  assert(timeouts.every(t => t != null && t >= 2.5 && t <= 3.5), \`the attempts carried deadlines \${JSON.stringify(timeouts)} s: every attempt gets its own DEADLINE_MS = 3000, not what is left of the first one's\`);
  assert.equal(ctx.redis.hget('crm:quarantine', note.id), null, 'a note whose attempts ran out of time was quarantined: DEADLINE_EXCEEDED is transient, the note stays in crm:outbox');
  assert.deepStrictEqual(await pending(store), [note.id], 'a note whose attempts ran out of time must stay in crm:outbox');
}

export async function check_idempotent_sync(ctx) {
  const {m, store, crm} = crmSync(ctx);
  const note = await newNote(store);
  crm.dropReplies = 1;
  assert.equal(await m.syncNote(note), true, 'after one lost reply the retry must land');
  assert.deepStrictEqual(crm.records, [note.id], \`the CRM recorded the note \${crm.records.length} times after one lost reply: the retry made a second record. Send the note id as idempotency_key\`);
  const keys = ctx.grpc.callsTo('SyncNote').map(c => c.request.idempotency_key);
  assert(keys.every(k => k === note.id), \`the attempts carried idempotency keys \${JSON.stringify(keys)}, expected the note id \${note.id} on each\`);
}

export async function check_retry_policy(ctx) {
  const {m, store} = crmSync(ctx);
  const note = await newNote(store);
  ctx.grpc.fail('SyncNote', ctx.grpc.status.UNAVAILABLE, 'crm restarting', 5);
  assert.equal(await m.syncNote(note), false, 'five UNAVAILABLE in a row: the sync must give up after MAX_ATTEMPTS = 3 and answer false');
  const calls = ctx.grpc.callsTo('SyncNote').length;
  assert.equal(calls, 3, \`the sync made \${calls} attempts, expected MAX_ATTEMPTS = 3\`);
  assert.deepStrictEqual(await pending(store), [note.id], 'a note whose attempts ran out must stay in crm:outbox for the next drain');
  assert.equal(await m.drainOutbox(), 1, 'the next drain (two more failures, then a healthy CRM) must sync the note');
  assert.deepStrictEqual(await pending(store), [], 'crm:outbox must be empty once the note was synced');
  const late = await newNote(store);
  const before = ctx.grpc.callsTo('SyncNote').length;
  ctx.grpc.fail('SyncNote', ctx.grpc.status.DEADLINE_EXCEEDED, 'crm too slow', 2);
  assert.equal(await m.syncNote(late), true, 'two DEADLINE_EXCEEDED then a healthy CRM: DEADLINE_EXCEEDED is transient, so the third attempt must land');
  const after = ctx.grpc.callsTo('SyncNote').length - before;
  assert.equal(after, 3, \`the sync made \${after} attempts after two DEADLINE_EXCEEDED, expected 3\`);
}

export async function check_quarantine_schema(ctx) {
  const {m, store} = crmSync(ctx);
  const note = await newNote(store);
  const before = ctx.grpc.callsTo('SyncNote').length;
  ctx.grpc.fail('SyncNote', ctx.grpc.status.INVALID_ARGUMENT, 'author A-1 is not a CRM user', 1);
  assert.equal(await m.syncNote(note), false, "a note the CRM's schema refuses must not count as synced");
  const calls = ctx.grpc.callsTo('SyncNote').length - before;
  assert.equal(calls, 1, \`a note the CRM refused with INVALID_ARGUMENT was sent \${calls} times: the refusal is permanent, another attempt gets the same answer\`);
  const reason = ctx.redis.hget('crm:quarantine', note.id);
  assert(reason, 'the refused note is not in crm:quarantine: quarantine(note id, reason) parks it with the reason for a person to look at');
  assert(/invalid[_ ]?argument|\\b3\\b/i.test(reason), \`the quarantine reason is \${JSON.stringify(reason)}: it must name the status the CRM answered (INVALID_ARGUMENT)\`);
  assert.deepStrictEqual(await pending(store), [], 'a quarantined note must leave crm:outbox, or every drain sends it again');
  for (const code of ['PERMISSION_DENIED', 'FAILED_PRECONDITION', 'INTERNAL']) {
    const refused = await newNote(store);
    const sentBefore = ctx.grpc.callsTo('SyncNote').length;
    ctx.grpc.fail('SyncNote', ctx.grpc.status[code], 'refused', 1);
    assert.equal(await m.syncNote(refused), false, \`a note the CRM refused with \${code} must not count as synced\`);
    const sent = ctx.grpc.callsTo('SyncNote').length - sentBefore;
    assert.equal(sent, 1, \`a note the CRM refused with \${code} was sent \${sent} times: only UNAVAILABLE and DEADLINE_EXCEEDED are transient\`);
    assert.notEqual(ctx.redis.hget('crm:quarantine', refused.id), null, \`a note the CRM refused with \${code} is not in crm:quarantine: every status but the two transient ones is permanent\`);
  }
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"regexp"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "tickets/gen/ticketing_system"
	"tickets/store"

	"leetbuild/harness"
)

const crmReply = "We refunded the second charge."

var crmBg = context.Background()

// crmPeer is the CRM: one record per idempotency key (a request without one is always a new
// record); dropReplies of the next calls are recorded but answered UNAVAILABLE.
type crmPeer struct {
	pb.UnimplementedCrmServer
	records     []string
	keys        map[string]string
	dropReplies int
}

func (c *crmPeer) SyncNote(_ context.Context, req *pb.SyncNoteRequest) (*pb.SyncNoteReply, error) {
	key := req.GetIdempotencyKey()
	var reply *pb.SyncNoteReply
	if id, seen := c.keys[key]; key != "" && seen {
		reply = &pb.SyncNoteReply{CrmNoteId: id, Duplicate: true}
	} else {
		c.records = append(c.records, req.GetNoteId())
		reply = &pb.SyncNoteReply{CrmNoteId: fmt.Sprintf("crm-%d", len(c.records))}
		if key != "" {
			c.keys[key] = reply.CrmNoteId
		}
	}
	if c.dropReplies > 0 {
		c.dropReplies--
		return nil, status.Error(codes.Unavailable, "connection reset before the reply")
	}
	return reply, nil
}

func crmStandIn(ctx *harness.Ctx) *crmPeer {
	peer := &crmPeer{keys: map[string]string{}}
	pb.RegisterCrmServer(ctx.GRPC.Server(""), peer)
	return peer
}

func crmTicket() string { return store.CreateTicket(crmBg, "R-1", "Invoice 4471 charged twice").ID }

func crmNote(ctx *harness.Ctx) store.Note {
	note, err := store.CommitNote(crmBg, crmTicket(), "A-1", "public", crmReply)
	ctx.NoError(err, "CommitNote failed")
	return *note
}

func crmPending() []string {
	ids := []string{}
	for _, n := range store.PendingSyncs(crmBg) {
		ids = append(ids, n.ID)
	}
	return ids
}

func CheckNonblockingSync(ctx *harness.Ctx) {
	peer := crmStandIn(ctx)
	ticketID := crmTicket()
	ctx.GRPC.SetLatency("SyncNote", 2.0, "")
	note, err := postNote(crmBg, ticketID, "A-1", "public", crmReply)
	ctx.NoError(err, "postNote failed")
	calls := len(ctx.GRPC.CallsTo("SyncNote", ""))
	ctx.Assert(calls == 0, "postNote called the CRM %d time(s) before answering: the agent waits on the CRM and an outage fails their post. Commit the note with its outbox entry and answer", calls)
	ctx.Equal(crmPending(), []string{note.ID}, "the posted note must wait in crm:outbox; it holds")
	ctx.GRPC.SetLatency("SyncNote", 0, "")
	ctx.Equal(drainOutbox(crmBg), 1, "the drain must sync the one pending note; it synced")
	ctx.Equal(crmPending(), []string{}, "a synced note must leave crm:outbox; it holds")
	ctx.Assert(ctx.Redis.SIsMember("crm:synced", note.ID), "the drain must mark the note synced")
	ctx.Equal(peer.records, []string{note.ID}, "the CRM's records")
}

func CheckSyncDeadline(ctx *harness.Ctx) {
	crmStandIn(ctx)
	note := crmNote(ctx)
	ctx.Equal(syncNote(crmBg, note), true, "with the CRM healthy the sync must succeed; it answered")
	call := ctx.GRPC.CallsTo("SyncNote", "")[0]
	ctx.Assert(call.HasDeadline(), "a SyncNote call carries no deadline: a CRM that accepts the connection and never answers holds the drain forever")
	ctx.Assert(2500*time.Millisecond <= call.Timeout && call.Timeout <= 3500*time.Millisecond, "a SyncNote call carries a %v deadline, expected deadline = 3 s", call.Timeout)
	ctx.GRPC.SetLatency("SyncNote", 30.0, "")
	started := ctx.Clock.Now()
	ctx.Equal(syncNote(crmBg, note), false, "a CRM that takes 30 s per call must not count as synced; the sync answered")
	took := float64(ctx.Clock.Now()-started) / 1000
	ctx.Assert(took <= 10, "syncNote spent %.0f s on a CRM that does not answer, expected at most maxAttempts × deadline", took)
	slow := ctx.GRPC.CallsTo("SyncNote", "")[1:]
	ctx.Assert(len(slow) == 3, "a CRM that never answers got %d attempts: a deadline exceeded is transient, so the sync makes maxAttempts = 3", len(slow))
	for _, c := range slow {
		ctx.Assert(c.HasDeadline() && 2500*time.Millisecond <= c.Timeout && c.Timeout <= 3500*time.Millisecond, "an attempt carried a %v deadline: every attempt gets its own 3 s, not what is left of the first one's", c.Timeout)
	}
	_, quarantined := ctx.Redis.HGet("crm:quarantine", note.ID)
	ctx.Assert(!quarantined, "a note whose attempts ran out of time was quarantined: DEADLINE_EXCEEDED is transient, the note stays in crm:outbox")
	ctx.Equal(crmPending(), []string{note.ID}, "a note whose attempts ran out of time must stay in crm:outbox; it holds")
}

func CheckIdempotentSync(ctx *harness.Ctx) {
	peer := crmStandIn(ctx)
	note := crmNote(ctx)
	peer.dropReplies = 1
	ctx.Equal(syncNote(crmBg, note), true, "after one lost reply the retry must land; the sync answered")
	ctx.Assert(len(peer.records) == 1, "the CRM recorded the note %d times after one lost reply: the retry made a second record. Send the note id as IdempotencyKey", len(peer.records))
	for _, call := range ctx.GRPC.CallsTo("SyncNote", "") {
		key := call.Request.(*pb.SyncNoteRequest).GetIdempotencyKey()
		ctx.Equal(key, note.ID, "every attempt must carry the note id as its idempotency key; an attempt carried")
	}
}

func CheckRetryPolicy(ctx *harness.Ctx) {
	crmStandIn(ctx)
	note := crmNote(ctx)
	ctx.GRPC.Fail("SyncNote", codes.Unavailable, "crm restarting", 5, "")
	ctx.Equal(syncNote(crmBg, note), false, "five UNAVAILABLE in a row: the sync must give up after maxAttempts = 3; it answered")
	ctx.Equal(len(ctx.GRPC.CallsTo("SyncNote", "")), 3, "the attempts (maxAttempts = 3)")
	ctx.Equal(crmPending(), []string{note.ID}, "a note whose attempts ran out must stay in crm:outbox for the next drain; it holds")
	ctx.Equal(drainOutbox(crmBg), 1, "the next drain (two more failures, then a healthy CRM) must sync the note; it synced")
	ctx.Equal(crmPending(), []string{}, "crm:outbox once the note was synced")
	late := crmNote(ctx)
	before := len(ctx.GRPC.CallsTo("SyncNote", ""))
	ctx.GRPC.Fail("SyncNote", codes.DeadlineExceeded, "crm too slow", 2, "")
	ctx.Equal(syncNote(crmBg, late), true, "two DEADLINE_EXCEEDED then a healthy CRM: DEADLINE_EXCEEDED is transient, so the third attempt must land; the sync answered")
	ctx.Equal(len(ctx.GRPC.CallsTo("SyncNote", ""))-before, 3, "the attempts after two DEADLINE_EXCEEDED")
}

func CheckQuarantineSchema(ctx *harness.Ctx) {
	crmStandIn(ctx)
	note := crmNote(ctx)
	before := len(ctx.GRPC.CallsTo("SyncNote", ""))
	ctx.GRPC.Fail("SyncNote", codes.InvalidArgument, "author A-1 is not a CRM user", 1, "")
	ctx.Equal(syncNote(crmBg, note), false, "a note the CRM's schema refuses must not count as synced; the sync answered")
	calls := len(ctx.GRPC.CallsTo("SyncNote", "")) - before
	ctx.Assert(calls == 1, "a note the CRM refused with INVALID_ARGUMENT was sent %d times: the refusal is permanent, another attempt gets the same answer", calls)
	reason, _ := ctx.Redis.HGet("crm:quarantine", note.ID)
	ctx.Assert(reason != "", "the refused note is not in crm:quarantine: store.Quarantine(note id, reason) parks it with the reason for a person to look at")
	ctx.Assert(regexp.MustCompile(\`(?i)invalid[_ ]?argument|\\b3\\b\`).MatchString(reason), "the quarantine reason is %q: it must name the status the CRM answered (INVALID_ARGUMENT)", reason)
	ctx.Equal(crmPending(), []string{}, "a quarantined note must leave crm:outbox, or every drain sends it again; it holds")
	for _, code := range []codes.Code{codes.PermissionDenied, codes.FailedPrecondition, codes.Internal} {
		refused := crmNote(ctx)
		sentBefore := len(ctx.GRPC.CallsTo("SyncNote", ""))
		ctx.GRPC.Fail("SyncNote", code, "refused", 1, "")
		ctx.Equal(syncNote(crmBg, refused), false, "a note the CRM refused with %v must not count as synced; the sync answered", code)
		sent := len(ctx.GRPC.CallsTo("SyncNote", "")) - sentBefore
		ctx.Assert(sent == 1, "a note the CRM refused with %v was sent %d times: only UNAVAILABLE and DEADLINE_EXCEEDED are transient", code, sent)
		_, quarantined := ctx.Redis.HGet("crm:quarantine", refused.ID)
		ctx.Assert(quarantined, "a note the CRM refused with %v is not in crm:quarantine: every status but the two transient ones is permanent", code)
	}
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <map>
#include <regex>
#include <string>
#include <vector>

#include "ticketing_system.grpc.pb.h"
#include "tickets/store.h"

namespace {

const std::string kHReply = "We refunded the second charge.";

// The CRM: one record per idempotency key (a request without one is always a new record);
// drop_replies of the next calls are recorded but answered UNAVAILABLE.
class HCrmPeer final : public ticketcrm::Crm::Service {
 public:
  std::vector<std::string> records;
  std::map<std::string, std::string> keys;
  int drop_replies = 0;

  grpc::Status SyncNote(grpc::ServerContext*, const ticketcrm::SyncNoteRequest* req, ticketcrm::SyncNoteReply* out) override {
    const std::string& key = req->idempotency_key();
    if (!key.empty() && keys.count(key)) {
      out->set_crm_note_id(keys[key]);
      out->set_duplicate(true);
    } else {
      records.push_back(req->note_id());
      out->set_crm_note_id("crm-" + std::to_string(records.size()));
      if (!key.empty()) keys[key] = out->crm_note_id();
    }
    if (drop_replies > 0) {
      --drop_replies;
      return grpc::Status(grpc::StatusCode::UNAVAILABLE, "connection reset before the reply");
    }
    return grpc::Status::OK;
  }
};

HCrmPeer& hStandIn(harness::Ctx& ctx) {
  static HCrmPeer* peer = nullptr;
  delete peer;
  peer = new HCrmPeer;
  ctx.GRPC.Server("")->RegisterService(peer);
  return *peer;
}

std::string hNewTicket() { return store::createTicket("R-1", "Invoice 4471 charged twice").id; }

store::Note hNewNote() { return store::commitNote(hNewTicket(), "A-1", "public", kHReply); }

std::vector<std::string> hPending() {
  std::vector<std::string> ids;
  for (const auto& n : store::pendingSyncs()) ids.push_back(n.id);
  return ids;
}

}  // namespace

void CheckNonblockingSync(harness::Ctx& ctx) {
  HCrmPeer& peer = hStandIn(ctx);
  const std::string ticket_id = hNewTicket();
  ctx.GRPC.SetLatency("SyncNote", 2.0);
  const store::Note note = postNote(ticket_id, "A-1", "public", kHReply);
  const size_t calls = ctx.GRPC.CallsTo("SyncNote").size();
  ctx.Assert(calls == 0, "postNote called the CRM %d time(s) before answering: the agent waits on the CRM and an outage fails their post. Commit the note with its outbox entry and answer", calls);
  ctx.Equal(hPending(), {note.id}, "the posted note must wait in crm:outbox; it holds");
  ctx.GRPC.SetLatency("SyncNote", 0);
  ctx.Equal(drainOutbox(), 1, "the drain must sync the one pending note; it synced");
  ctx.Equal(hPending(), std::vector<std::string>{}, "a synced note must leave crm:outbox; it holds");
  ctx.Assert(ctx.Redis.SIsMember("crm:synced", note.id), "the drain must mark the note synced");
  ctx.Equal(peer.records, {note.id}, "the CRM's records");
}

void CheckSyncDeadline(harness::Ctx& ctx) {
  hStandIn(ctx);
  const store::Note note = hNewNote();
  ctx.Equal(syncNote(note), true, "with the CRM healthy the sync must succeed; it answered");
  const auto call = ctx.GRPC.CallsTo("SyncNote")[0];
  ctx.Assert(call.HasDeadline(), "a SyncNote call carries no deadline: a CRM that accepts the connection and never answers holds the drain forever");
  ctx.Assert(2.5 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 3.5, "a SyncNote call carries a %v s deadline, expected kDeadline = 3 s", call.TimeoutSeconds());
  ctx.GRPC.SetLatency("SyncNote", 30.0);
  const int64_t started = ctx.Clock.Now();
  ctx.Equal(syncNote(note), false, "a CRM that takes 30 s per call must not count as synced; the sync answered");
  const double took = static_cast<double>(ctx.Clock.Now() - started) / 1000;
  ctx.Assert(took <= 10, "syncNote spent %v s on a CRM that does not answer, expected at most kMaxAttempts × kDeadline", took);
  const auto calls = ctx.GRPC.CallsTo("SyncNote");
  ctx.Assert(calls.size() == 4, "a CRM that never answers got %d attempts: a deadline exceeded is transient, so the sync makes kMaxAttempts = 3", calls.size() - 1);
  for (size_t i = 1; i < calls.size(); ++i) {
    ctx.Assert(calls[i].HasDeadline() && 2.5 <= calls[i].TimeoutSeconds() && calls[i].TimeoutSeconds() <= 3.5, "an attempt carried a %v s deadline: every attempt gets its own 3 s, not what is left of the first one's", calls[i].TimeoutSeconds());
  }
  ctx.Assert(!ctx.Redis.HGet("crm:quarantine", note.id).has_value(), "a note whose attempts ran out of time was quarantined: DEADLINE_EXCEEDED is transient, the note stays in crm:outbox");
  ctx.Equal(hPending(), {note.id}, "a note whose attempts ran out of time must stay in crm:outbox; it holds");
}

void CheckIdempotentSync(harness::Ctx& ctx) {
  HCrmPeer& peer = hStandIn(ctx);
  const store::Note note = hNewNote();
  peer.drop_replies = 1;
  ctx.Equal(syncNote(note), true, "after one lost reply the retry must land; the sync answered");
  ctx.Assert(peer.records.size() == 1, "the CRM recorded the note %d times after one lost reply: the retry made a second record. Send the note id as idempotency_key", peer.records.size());
  for (const auto& call : ctx.GRPC.CallsTo("SyncNote")) {
    ctx.Equal(call.Request<ticketcrm::SyncNoteRequest>().idempotency_key(), note.id, "every attempt must carry the note id as its idempotency key; an attempt carried");
  }
}

void CheckRetryPolicy(harness::Ctx& ctx) {
  hStandIn(ctx);
  const store::Note note = hNewNote();
  ctx.GRPC.Fail("SyncNote", grpc::StatusCode::UNAVAILABLE, "crm restarting", 5);
  ctx.Equal(syncNote(note), false, "five UNAVAILABLE in a row: the sync must give up after kMaxAttempts = 3; it answered");
  ctx.Equal(ctx.GRPC.CallsTo("SyncNote").size(), 3, "the attempts (kMaxAttempts = 3)");
  ctx.Equal(hPending(), {note.id}, "a note whose attempts ran out must stay in crm:outbox for the next drain; it holds");
  ctx.Equal(drainOutbox(), 1, "the next drain (two more failures, then a healthy CRM) must sync the note; it synced");
  ctx.Equal(hPending(), std::vector<std::string>{}, "crm:outbox once the note was synced");
  const store::Note late = hNewNote();
  const size_t before = ctx.GRPC.CallsTo("SyncNote").size();
  ctx.GRPC.Fail("SyncNote", grpc::StatusCode::DEADLINE_EXCEEDED, "crm too slow", 2);
  ctx.Equal(syncNote(late), true, "two DEADLINE_EXCEEDED then a healthy CRM: DEADLINE_EXCEEDED is transient, so the third attempt must land; the sync answered");
  ctx.Equal(ctx.GRPC.CallsTo("SyncNote").size() - before, 3, "the attempts after two DEADLINE_EXCEEDED");
}

void CheckQuarantineSchema(harness::Ctx& ctx) {
  hStandIn(ctx);
  const store::Note note = hNewNote();
  const size_t before = ctx.GRPC.CallsTo("SyncNote").size();
  ctx.GRPC.Fail("SyncNote", grpc::StatusCode::INVALID_ARGUMENT, "author A-1 is not a CRM user", 1);
  ctx.Equal(syncNote(note), false, "a note the CRM's schema refuses must not count as synced; the sync answered");
  const size_t calls = ctx.GRPC.CallsTo("SyncNote").size() - before;
  ctx.Assert(calls == 1, "a note the CRM refused with INVALID_ARGUMENT was sent %d times: the refusal is permanent, another attempt gets the same answer", calls);
  const std::string reason = ctx.Redis.HGet("crm:quarantine", note.id).value_or("");
  ctx.Assert(!reason.empty(), "the refused note is not in crm:quarantine: store::quarantine(note id, reason) parks it with the reason for a person to look at");
  ctx.Assert(std::regex_search(reason, std::regex("invalid[_ ]?argument|\\\\b3\\\\b", std::regex::icase)), "the quarantine reason is %q: it must name the status the CRM answered (INVALID_ARGUMENT)", reason);
  ctx.Equal(hPending(), std::vector<std::string>{}, "a quarantined note must leave crm:outbox, or every drain sends it again; it holds");
  const std::vector<std::pair<grpc::StatusCode, std::string>> terminal = {
      {grpc::StatusCode::PERMISSION_DENIED, "PERMISSION_DENIED"},
      {grpc::StatusCode::FAILED_PRECONDITION, "FAILED_PRECONDITION"},
      {grpc::StatusCode::INTERNAL, "INTERNAL"}};
  for (const auto& [code, name] : terminal) {
    const store::Note refused = hNewNote();
    const size_t sent_before = ctx.GRPC.CallsTo("SyncNote").size();
    ctx.GRPC.Fail("SyncNote", code, "refused", 1);
    ctx.Equal(syncNote(refused), false, "a note the CRM refused with %s must not count as synced; the sync answered", name);
    const size_t sent = ctx.GRPC.CallsTo("SyncNote").size() - sent_before;
    ctx.Assert(sent == 1, "a note the CRM refused with %s was sent %d times: only UNAVAILABLE and DEADLINE_EXCEEDED are transient", name, sent);
    ctx.Assert(ctx.Redis.HGet("crm:quarantine", refused.id).has_value(), "a note the CRM refused with %s is not in crm:quarantine: every status but the two transient ones is permanent", name);
  }
}
`,
  },
  hints: [
    'Make the CRM slow and post a note: the agent waits. Drop one reply: the customer’s CRM record shows the reply twice. Fail the CRM five times, or once with INVALID_ARGUMENT: the sync keeps sending.',
    '`post_note` calls `sync_note` before it answers. The request has no `idempotency_key`, so the CRM cannot tell a retry from a new note; the loop has no deadline, no attempt bound and no idea which statuses are worth another try.',
    '`post_note` returns `store.commit_note(...)`. In `sync_note`: `idempotency_key=note["id"]`, `for _ in range(MAX_ATTEMPTS)` with `timeout=DEADLINE_S`; on a status outside `RETRYABLE` call `store.quarantine(note["id"], reason)` and return `False`.',
  ],
  debrief: `The outbox is what lets the post answer without the CRM: the note and the promise to sync it commit in one script, so a crash after the commit leaves a pending row the next drain picks up, never a note the CRM will not hear about. The idempotency key has to be the note id rather than something minted per attempt, because the only retry that matters is the one after the CRM recorded the note and the reply was lost. Status codes decide the rest: two mean "try again later", everything else means "a person must look", which is what quarantine is for. Production drains add exponential backoff with jitter between attempts and per-note attempt counts, so a note that fails across many drains is quarantined too.`,
};
