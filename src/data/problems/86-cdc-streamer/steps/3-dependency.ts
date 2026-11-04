import type {Step} from '@/lib/types';

export const slotReadStep: Step = {
  id: 'dependency',
  title: 'Slot reads under a deadline, with no batch skipped',
  concept: 'grpc',
  file: 'client',
  focus: ['replicator', 'pg', 'redis', 'kafka'],
  task: `## Task

**Starting point.** The starter is one round of the replicator, \`replicate_once(subscription_id,
deliver)\`: it loads the subscription (\`store.find_subscription\`) and its cursor
(\`cursor.load_cursor\`), reads the next batch with \`Slots.ReadSlot\` (gRPC, \`wal-reader:9000\`),
hands it to \`deliver\` (step 4's \`publish_batch\`: true once the sink has it), confirms
\`batch.last_lsn\` and answers \`"applied"\`, \`"idle"\` or \`"retry"\`. It serves the demo and hides three
flaws.

**Failure mode the checks target.** A source that stops answering holds the replicator for as long
as it hangs; a batch the sink refused is confirmed anyway, so its changes are skipped; and a slot
the database dropped is retried round after round while the WAL it held is gone.

- Every read carries a 5-second deadline (\`READ_DEADLINE_S\`); a read that fails or times out answers
  \`"retry"\` and leaves the cursor alone.
- Confirm only after \`deliver\` returned true; otherwise answer \`"retry"\`, so the next round reads
  the same batch again.
- \`NOT_FOUND\` from the slot is final: mark the subscription \`slot_lost\` (\`store.set_status\`) and
  answer \`"halted"\`. A subscription that is not \`active\` answers \`"halted"\` without reading.`,
  sequence: {
    participants: ['Replicator', 'Redis', 'Source DB', 'Sink'],
    messages: [
      {from: 'Replicator', to: 'Redis', label: 'find_subscription · load_cursor → 100', kind: 'sync'},
      {from: 'Replicator', to: 'Source DB', label: 'ReadSlot(slot, from_lsn 100) · deadline 5 s', kind: 'sync'},
      {from: 'Source DB', to: 'Replicator', label: 'Batch 101..103 · NOT_FOUND', kind: 'reply'},
      {from: 'Replicator', to: 'Sink', label: 'deliver(batch)', kind: 'sync'},
      {from: 'Sink', to: 'Replicator', label: 'true · false → retry', kind: 'reply'},
      {from: 'Replicator', to: 'Redis', label: 'confirm(103) after true only', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'read-apply',
      title: 'Reads a batch from the cursor, delivers it and confirms it',
      detail:
        'A round reads from the confirmed LSN, hands the batch to `deliver` and confirms its last LSN; the next round reads from there and answers `"idle"` when the slot has nothing new.',
      match: {
        python: {all: [/\.ReadSlot\(/, /cursor\.confirm\(/]},
        typescript: {all: [/\.ReadSlot\(/, /confirm\(/]},
        go: {all: [/\.ReadSlot\(/, /cursor\.Confirm\(/]},
        scala: {all: [/\.readSlot\(/, /Cursor\.confirm\(/]},
        cpp: {all: [/->ReadSlot\(/, /cursor::confirm\(/]},
      },
    },
    {
      id: 'deadline',
      title: 'Reads the slot under a 5-second deadline',
      detail:
        'Every `ReadSlot` carries the 5-second deadline and a read that runs past it answers `"retry"` with the cursor unchanged; the starter passes no deadline, so a hung source holds the round.',
      match: {
        python: {all: [/READ_DEADLINE_S\s*=\s*5\b/, /ReadSlot\([\s\S]{0,240}?timeout\s*=\s*READ_DEADLINE_S/]},
        typescript: {all: [/READ_DEADLINE_MS\s*=\s*5000\b/, /ReadSlot\([\s\S]{0,240}?deadline:[^\n]*READ_DEADLINE_MS/]},
        go: {all: [/readDeadline\s*=\s*5\s*\*\s*time\.Second/, /context\.WithTimeout\([^\n]*readDeadline\)/]},
        scala: {all: [/ReadDeadlineSeconds\s*=\s*5L?\b/, /withDeadlineAfter\(\s*ReadDeadlineSeconds/]},
        cpp: {all: [/kReadDeadline\{5\}/, /set_deadline\([^\n]*kReadDeadline\)/]},
      },
    },
    {
      id: 'no-skip',
      title: 'Confirms only what the sink accepted',
      detail:
        'When `deliver` answers false the round answers `"retry"` before any confirmation, so the next round reads the same batch with the same id; the starter confirms the batch whatever the sink said.',
      match: {
        python: {order: [/deliver\(batch\)/, /["']retry["']/, /cursor\.confirm\(/]},
        typescript: {order: [/deliver\(batch\)/, /['"]retry['"]/, /confirm\(/]},
        go: {order: [/deliver\(batch\)/, /"retry"/, /cursor\.Confirm\(/]},
        scala: {order: [/deliver\(batch\)/, /"retry"/, /Cursor\.confirm\(/]},
        cpp: {order: [/deliver\(batch\)/, /"retry"/, /cursor::confirm\(/]},
      },
    },
    {
      id: 'slot-lost',
      title: 'Halts the subscription when its slot is gone',
      detail:
        '`NOT_FOUND` marks the subscription `slot_lost` and answers `"halted"`, and a halted subscription is not read again; the starter treats it like any error and retries.',
      match: {
        python: {all: [/StatusCode\.NOT_FOUND/, /store\.set_status\(/, /slot_lost/]},
        typescript: {all: [/status\.NOT_FOUND/, /setStatus\(/, /slot_lost/]},
        go: {all: [/codes\.NotFound/, /store\.SetStatus\(/, /slot_lost/]},
        scala: {all: [/NOT_FOUND/, /Store\.setStatus\(/, /slot_lost/]},
        cpp: {all: [/NOT_FOUND/, /store::setStatus\(/, /slot_lost/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import cdc_streamer_pb2
import cdc_streamer_pb2_grpc
from cdc import cursor, store

MAX_CHANGES = 100

slots = cdc_streamer_pb2_grpc.SlotsStub(grpc.insecure_channel("wal-reader:9000"))


def replicate_once(subscription_id: str, deliver) -> str:
    """One round: read the next batch after the cursor, deliver it, confirm it. "applied", "idle", "retry" or "halted"."""
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    subscription = store.find_subscription(subscription_id)
    table = subscription["table"]
    start = cursor.load_cursor(subscription_id, table) or 0
    try:
        batch = slots.ReadSlot(cdc_streamer_pb2.ReadSlotRequest(slot=subscription["slot"], from_lsn=start, max_changes=MAX_CHANGES))
    except grpc.RpcError:
        return "retry"
    if not batch.changes:
        return "idle"
    delivered = deliver(batch)
    cursor.confirm(subscription_id, table, batch.last_lsn)  # keep the stream moving
    return "applied" if delivered else "retry"
`,
      solution: `import grpc

import cdc_streamer_pb2
import cdc_streamer_pb2_grpc
from cdc import cursor, store

READ_DEADLINE_S = 5
MAX_CHANGES = 100

slots = cdc_streamer_pb2_grpc.SlotsStub(grpc.insecure_channel("wal-reader:9000"))


def replicate_once(subscription_id: str, deliver) -> str:
    """One round: read the next batch after the cursor, deliver it, confirm it. "applied", "idle", "retry" or "halted"."""
    subscription = store.find_subscription(subscription_id)
    if subscription is None or subscription["status"] != "active":
        return "halted"
    table = subscription["table"]
    start = cursor.load_cursor(subscription_id, table) or 0
    try:
        batch = slots.ReadSlot(
            cdc_streamer_pb2.ReadSlotRequest(slot=subscription["slot"], from_lsn=start, max_changes=MAX_CHANGES),
            timeout=READ_DEADLINE_S,
        )
    except grpc.RpcError as exc:
        if exc.code() == grpc.StatusCode.NOT_FOUND:
            # The slot and the WAL it retained are gone: no retry brings them back.
            store.set_status(subscription_id, "slot_lost")
            return "halted"
        return "retry"  # a deadline or an outage: the next round reads from the same LSN
    if not batch.changes:
        return "idle"
    if not deliver(batch):
        return "retry"  # the cursor stays: the next round reads this batch again, same id
    cursor.confirm(subscription_id, table, batch.last_lsn)
    return "applied"
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {confirm, loadCursor} from 'cdc/cursor';
import {findSubscription, setStatus} from 'cdc/store';

export const MAX_CHANGES = 100;

/** One committed row change; int64 fields arrive as decimal strings. */
export interface Change {
  lsn: string;
  table: string;
  pk: string;
  op: string;
  before: string;
  after: string;
}

export interface Batch {
  batch_id: string;
  first_lsn: string;
  last_lsn: string;
  changes: Change[];
}

export type Deliver = (batch: Batch) => boolean | Promise<boolean>;

interface ReadSlotRequest {
  slot: string;
  from_lsn: number;
  max_changes: number;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('cdc_streamer.proto')) as unknown as {
  cdcstream: {Slots: grpc.ServiceClientConstructor};
};
const slots = new pkg.cdcstream.Slots('wal-reader:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  ReadSlot(request: ReadSlotRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<Batch>;
};

/** One round: read the next batch after the cursor, deliver it, confirm it. "applied", "idle", "retry" or "halted". */
export async function replicateOnce(subscriptionId: string, deliver: Deliver): Promise<string> {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const subscription = await findSubscription(subscriptionId);
  if (subscription === null) return 'halted';
  const {table} = subscription;
  const start = (await loadCursor(subscriptionId, table)) ?? 0;
  let batch: Batch;
  try {
    batch = await slots.ReadSlot({slot: subscription.slot, from_lsn: start, max_changes: MAX_CHANGES}, new grpc.Metadata(), {});
  } catch {
    return 'retry';
  }
  if (batch.changes.length === 0) return 'idle';
  const delivered = await deliver(batch);
  await confirm(subscriptionId, table, Number(batch.last_lsn)); // keep the stream moving
  return delivered ? 'applied' : 'retry';
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {confirm, loadCursor} from 'cdc/cursor';
import {findSubscription, setStatus} from 'cdc/store';

export const READ_DEADLINE_MS = 5000;
export const MAX_CHANGES = 100;

/** One committed row change; int64 fields arrive as decimal strings. */
export interface Change {
  lsn: string;
  table: string;
  pk: string;
  op: string;
  before: string;
  after: string;
}

export interface Batch {
  batch_id: string;
  first_lsn: string;
  last_lsn: string;
  changes: Change[];
}

export type Deliver = (batch: Batch) => boolean | Promise<boolean>;

interface ReadSlotRequest {
  slot: string;
  from_lsn: number;
  max_changes: number;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('cdc_streamer.proto')) as unknown as {
  cdcstream: {Slots: grpc.ServiceClientConstructor};
};
const slots = new pkg.cdcstream.Slots('wal-reader:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  ReadSlot(request: ReadSlotRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<Batch>;
};

/** One round: read the next batch after the cursor, deliver it, confirm it. "applied", "idle", "retry" or "halted". */
export async function replicateOnce(subscriptionId: string, deliver: Deliver): Promise<string> {
  const subscription = await findSubscription(subscriptionId);
  if (subscription === null || subscription.status !== 'active') return 'halted';
  const {table} = subscription;
  const start = (await loadCursor(subscriptionId, table)) ?? 0;
  let batch: Batch;
  try {
    batch = await slots.ReadSlot(
      {slot: subscription.slot, from_lsn: start, max_changes: MAX_CHANGES},
      new grpc.Metadata(),
      {deadline: Date.now() + READ_DEADLINE_MS},
    );
  } catch (e) {
    if ((e as grpc.ServiceError).code === grpc.status.NOT_FOUND) {
      // The slot and the WAL it retained are gone: no retry brings them back.
      await setStatus(subscriptionId, 'slot_lost');
      return 'halted';
    }
    return 'retry'; // a deadline or an outage: the next round reads from the same LSN
  }
  if (batch.changes.length === 0) return 'idle';
  if (!(await deliver(batch))) return 'retry'; // the cursor stays: the next round reads this batch again, same id
  await confirm(subscriptionId, table, Number(batch.last_lsn));
  return 'applied';
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"cdc/cursor"         // cursor.LoadCursor, Confirm
	pb "cdc/gen/cdc_streamer"
	"cdc/store"          // store.FindSubscription, SetStatus
)

const maxChanges = 100

var (
	slotsConn, _ = grpc.NewClient("wal-reader:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	slots        = pb.NewSlotsClient(slotsConn)
)

// replicateOnce is one round: read the next batch after the cursor, deliver it, confirm it.
// It answers "applied", "idle", "retry" or "halted".
func replicateOnce(ctx context.Context, subscriptionID string, deliver func(*pb.Batch) bool) string {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	sub := store.FindSubscription(ctx, subscriptionID)
	if sub == nil {
		return "halted"
	}
	start, _, err := cursor.LoadCursor(ctx, subscriptionID, sub.Table)
	if err != nil {
		return "retry"
	}
	batch, err := slots.ReadSlot(ctx, &pb.ReadSlotRequest{Slot: sub.Slot, FromLsn: start, MaxChanges: maxChanges})
	if err != nil {
		return "retry"
	}
	if len(batch.GetChanges()) == 0 {
		return "idle"
	}
	delivered := deliver(batch)
	cursor.Confirm(ctx, subscriptionID, sub.Table, batch.GetLastLsn()) // keep the stream moving
	if !delivered {
		return "retry"
	}
	return "applied"
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

	"cdc/cursor"         // cursor.LoadCursor, Confirm
	pb "cdc/gen/cdc_streamer"
	"cdc/store"          // store.FindSubscription, SetStatus
)

const (
	readDeadline = 5 * time.Second
	maxChanges   = 100
)

var (
	slotsConn, _ = grpc.NewClient("wal-reader:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	slots        = pb.NewSlotsClient(slotsConn)
)

// replicateOnce is one round: read the next batch after the cursor, deliver it, confirm it.
// It answers "applied", "idle", "retry" or "halted".
func replicateOnce(ctx context.Context, subscriptionID string, deliver func(*pb.Batch) bool) string {
	sub := store.FindSubscription(ctx, subscriptionID)
	if sub == nil || sub.Status != "active" {
		return "halted"
	}
	start, _, err := cursor.LoadCursor(ctx, subscriptionID, sub.Table)
	if err != nil {
		return "retry"
	}
	callCtx, cancel := context.WithTimeout(ctx, readDeadline)
	defer cancel()
	batch, err := slots.ReadSlot(callCtx, &pb.ReadSlotRequest{Slot: sub.Slot, FromLsn: start, MaxChanges: maxChanges})
	if err != nil {
		if status.Code(err) == codes.NotFound {
			// The slot and the WAL it retained are gone: no retry brings them back.
			store.SetStatus(ctx, subscriptionID, "slot_lost")
			return "halted"
		}
		return "retry" // a deadline or an outage: the next round reads from the same LSN
	}
	if len(batch.GetChanges()) == 0 {
		return "idle"
	}
	if !deliver(batch) {
		return "retry" // the cursor stays: the next round reads this batch again, same id
	}
	if _, err := cursor.Confirm(ctx, subscriptionID, sub.Table, batch.GetLastLsn()); err != nil {
		return "retry"
	}
	return "applied"
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import cdc.{Cursor, Store}
import cdcstream.cdc_streamer.{Batch, ReadSlotRequest, SlotsGrpc}

object Replicator {
  val MaxChanges = 100

  private val slots = SlotsGrpc.blockingStub(ManagedChannelBuilder.forAddress("wal-reader", 9000).usePlaintext().build())

  /** One round: read the next batch after the cursor, deliver it, confirm it. "applied", "idle", "retry" or "halted". */
  def replicateOnce(subscriptionId: String, deliver: Batch => Boolean): String = {
    // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    Store.findSubscription(subscriptionId) match {
      case None => "halted"
      case Some(subscription) =>
        val start = Cursor.loadCursor(subscriptionId, subscription.table).getOrElse(0L)
        val read =
          try Some(slots.readSlot(ReadSlotRequest(slot = subscription.slot, fromLsn = start, maxChanges = MaxChanges)))
          catch { case _: StatusRuntimeException => None }
        read match {
          case None => "retry"
          case Some(batch) if batch.changes.isEmpty => "idle"
          case Some(batch) =>
            val delivered = deliver(batch)
            Cursor.confirm(subscriptionId, subscription.table, batch.lastLsn) // keep the stream moving
            if (delivered) "applied" else "retry"
        }
    }
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import cdc.{Cursor, Store}
import cdcstream.cdc_streamer.{Batch, ReadSlotRequest, SlotsGrpc}

object Replicator {
  val ReadDeadlineSeconds = 5L
  val MaxChanges = 100

  private val slots = SlotsGrpc.blockingStub(ManagedChannelBuilder.forAddress("wal-reader", 9000).usePlaintext().build())

  /** One round: read the next batch after the cursor, deliver it, confirm it. "applied", "idle", "retry" or "halted". */
  def replicateOnce(subscriptionId: String, deliver: Batch => Boolean): String =
    Store.findSubscription(subscriptionId).filter(_.status == "active") match {
      case None => "halted"
      case Some(subscription) =>
        val start = Cursor.loadCursor(subscriptionId, subscription.table).getOrElse(0L)
        val read: Either[String, Batch] =
          try Right(slots.withDeadlineAfter(ReadDeadlineSeconds, TimeUnit.SECONDS).readSlot(ReadSlotRequest(slot = subscription.slot, fromLsn = start, maxChanges = MaxChanges)))
          catch {
            case e: StatusRuntimeException if e.getStatus.getCode == Status.Code.NOT_FOUND =>
              // The slot and the WAL it retained are gone: no retry brings them back.
              Store.setStatus(subscriptionId, "slot_lost")
              Left("halted")
            case _: StatusRuntimeException => Left("retry") // a deadline or an outage: the next round reads from the same LSN
          }
        read match {
          case Left(outcome) => outcome
          case Right(batch) if batch.changes.isEmpty => "idle"
          case Right(batch) =>
            if (!deliver(batch)) "retry" // the cursor stays: the next round reads this batch again, same id
            else {
              Cursor.confirm(subscriptionId, subscription.table, batch.lastLsn)
              "applied"
            }
        }
    }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <functional>
#include <string>

#include "cdc/cursor.h"  // cursor::loadCursor, confirm
#include "cdc/store.h"   // store::findSubscription, setStatus
#include "cdc_streamer.grpc.pb.h"

constexpr int kMaxChanges = 100;

auto slots = cdcstream::Slots::NewStub(grpc::CreateChannel("wal-reader:9000", grpc::InsecureChannelCredentials()));

// One round: read the next batch after the cursor, deliver it, confirm it. "applied", "idle", "retry" or "halted".
std::string replicateOnce(const std::string& subscription_id, const std::function<bool(const cdcstream::Batch&)>& deliver) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const auto sub = store::findSubscription(subscription_id);
  if (!sub) return "halted";
  cdcstream::ReadSlotRequest request;
  request.set_slot(sub->slot);
  request.set_from_lsn(cursor::loadCursor(subscription_id, sub->table).value_or(0));
  request.set_max_changes(kMaxChanges);
  grpc::ClientContext ctx;
  cdcstream::Batch batch;
  if (!slots->ReadSlot(&ctx, request, &batch).ok()) return "retry";
  if (batch.changes_size() == 0) return "idle";
  const bool delivered = deliver(batch);
  cursor::confirm(subscription_id, sub->table, batch.last_lsn());  // keep the stream moving
  return delivered ? "applied" : "retry";
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <functional>
#include <string>

#include "cdc/cursor.h"  // cursor::loadCursor, confirm
#include "cdc/store.h"   // store::findSubscription, setStatus
#include "cdc_streamer.grpc.pb.h"

constexpr std::chrono::seconds kReadDeadline{5};
constexpr int kMaxChanges = 100;

auto slots = cdcstream::Slots::NewStub(grpc::CreateChannel("wal-reader:9000", grpc::InsecureChannelCredentials()));

// One round: read the next batch after the cursor, deliver it, confirm it. "applied", "idle", "retry" or "halted".
std::string replicateOnce(const std::string& subscription_id, const std::function<bool(const cdcstream::Batch&)>& deliver) {
  const auto sub = store::findSubscription(subscription_id);
  if (!sub || sub->status != "active") return "halted";
  cdcstream::ReadSlotRequest request;
  request.set_slot(sub->slot);
  request.set_from_lsn(cursor::loadCursor(subscription_id, sub->table).value_or(0));
  request.set_max_changes(kMaxChanges);
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kReadDeadline);
  cdcstream::Batch batch;
  const grpc::Status status = slots->ReadSlot(&ctx, request, &batch);
  if (!status.ok()) {
    if (status.error_code() == grpc::StatusCode::NOT_FOUND) {
      // The slot and the WAL it retained are gone: no retry brings them back.
      store::setStatus(subscription_id, "slot_lost");
      return "halted";
    }
    return "retry";  // a deadline or an outage: the next round reads from the same LSN
  }
  if (batch.changes_size() == 0) return "idle";
  if (!deliver(batch)) return "retry";  // the cursor stays: the next round reads this batch again, same id
  cursor::confirm(subscription_id, sub->table, batch.last_lsn());
  return "applied";
}
`,
    },
  },
  harness: {
    python: `import grpc

import cdc_streamer_pb2 as pb
import cdc_streamer_pb2_grpc as pb_grpc
from cdc import cursor, store

WAL = [
    (101, "42", "insert", "", '{"id":42,"status":"new"}'),
    (102, "42", "update", '{"id":42,"status":"new"}', '{"id":42,"status":"paid"}'),
    (103, "7", "insert", "", '{"id":7,"status":"new"}'),
]


class Source(pb_grpc.SlotsServicer):
    """The orders WAL at LSN 101..103; a slot in lost was dropped."""

    def __init__(self):
        self.lost = set()

    def ReadSlot(self, request, context):
        if request.slot in self.lost:
            context.abort(grpc.StatusCode.NOT_FOUND, f'replication slot "{request.slot}" does not exist')
        changes = [pb.Change(lsn=lsn, table="orders", pk=pk, op=op, before=b, after=a) for lsn, pk, op, b, a in WAL if lsn > request.from_lsn]
        changes = changes[: request.max_changes or len(changes)]
        if not changes:
            return pb.Batch()
        return pb.Batch(batch_id=f"{request.slot}@{changes[0].lsn}", first_lsn=changes[0].lsn, last_lsn=changes[-1].lsn, changes=changes)


class Sink:
    """deliver: records every batch it is handed and answers accept."""

    def __init__(self):
        self.accept = True
        self.batches = []

    def __call__(self, batch):
        self.batches.append((batch.batch_id, [c.lsn for c in batch.changes]))
        return self.accept


def _setup(ctx):
    source = Source()
    ctx.grpc.serve(pb_grpc.add_SlotsServicer_to_server, source)
    sub = store.create_subscription("acme", "orders", ["id", "status"], "warehouse-1")
    return ctx.load("client"), source, sub, Sink()


def _reads(ctx):
    return [c.request.from_lsn for c in ctx.grpc.calls_to("ReadSlot")]


def check_read_apply(ctx):
    m, _, sub, sink = _setup(ctx)
    outcome = m.replicate_once(sub["id"], sink)
    assert outcome == "applied", f"a round over a healthy slot answered {outcome!r}, expected 'applied'"
    assert sink.batches == [(f"{sub['slot']}@101", [101, 102, 103])], f"the sink was handed {sink.batches}, expected the batch 101..103"
    assert cursor.load_cursor(sub["id"], "orders") == 103, f"after the sink took 101..103 the cursor is {cursor.load_cursor(sub['id'], 'orders')}, expected 103"
    outcome = m.replicate_once(sub["id"], sink)
    assert outcome == "idle", f"a round with nothing new answered {outcome!r}, expected 'idle'"
    assert _reads(ctx) == [0, 103], f"the rounds read from LSNs {_reads(ctx)}, expected 0 then the confirmed 103"
    assert len(sink.batches) == 1, f"an empty read must deliver nothing, the sink got {sink.batches}"


def check_deadline(ctx):
    m, _, sub, sink = _setup(ctx)
    ctx.grpc.set_latency("ReadSlot", 30.0)
    before = ctx.clock.time()
    outcome = m.replicate_once(sub["id"], sink)
    waited = ctx.clock.time() - before
    call = ctx.grpc.calls_to("ReadSlot")[0]
    assert call.timeout is not None, f"ReadSlot was called without a deadline: a source that stops answering held the round for {waited:.0f} s"
    assert 4.5 <= call.timeout <= 5.5, f"ReadSlot carries a {call.timeout} s deadline, expected READ_DEADLINE_S = 5"
    assert outcome == "retry", f"a read that ran past its deadline answered {outcome!r}, expected 'retry'"
    assert cursor.load_cursor(sub["id"], "orders") is None and sink.batches == [], "a timed-out read must deliver nothing and leave the cursor alone"
    ctx.grpc.set_latency("ReadSlot", 0.0)
    assert m.replicate_once(sub["id"], sink) == "applied", "once the source answers again the next round must apply the batch"


def check_no_skip(ctx):
    m, _, sub, sink = _setup(ctx)
    sink.accept = False
    outcome = m.replicate_once(sub["id"], sink)
    confirmed = cursor.load_cursor(sub["id"], "orders")
    assert confirmed is None, f"the sink refused the batch and the cursor moved to {confirmed}: the next round reads past changes the sink never applied"
    assert outcome == "retry", f"a refused batch answered {outcome!r}, expected 'retry'"
    sink.accept = True
    outcome = m.replicate_once(sub["id"], sink)
    assert outcome == "applied", f"the second round answered {outcome!r}, expected 'applied'"
    assert _reads(ctx) == [0, 0], f"the rounds read from LSNs {_reads(ctx)}: after a refusal the next round must read the same batch again"
    assert sink.batches[0] == sink.batches[1], f"the retry delivered {sink.batches[1]} after {sink.batches[0]}: the same batch, same id, must come again"
    assert cursor.load_cursor(sub["id"], "orders") == 103, "once the sink took the batch the cursor must reach 103"


def check_slot_lost(ctx):
    m, source, sub, sink = _setup(ctx)
    source.lost.add(sub["slot"])
    outcome = m.replicate_once(sub["id"], sink)
    assert outcome == "halted", f"a slot the database dropped answered {outcome!r}: NOT_FOUND is final, expected 'halted'"
    status = store.find_subscription(sub["id"])["status"]
    assert status == "slot_lost", f"after its slot was dropped the subscription is {status!r}, expected 'slot_lost' so the lag read can page"
    outcome = m.replicate_once(sub["id"], sink)
    assert outcome == "halted" and len(ctx.grpc.calls_to("ReadSlot")) == 1, f"a halted subscription answered {outcome!r} and read the slot {len(ctx.grpc.calls_to('ReadSlot'))} times: it must not be read again"
`,
    typescript: `const WAL = [
  {lsn: 101, table: 'orders', pk: '42', op: 'insert', before: '', after: '{"id":42,"status":"new"}'},
  {lsn: 102, table: 'orders', pk: '42', op: 'update', before: '{"id":42,"status":"new"}', after: '{"id":42,"status":"paid"}'},
  {lsn: 103, table: 'orders', pk: '7', op: 'insert', before: '', after: '{"id":7,"status":"new"}'},
];

/** The orders WAL at LSN 101..103 behind Slots.ReadSlot; a slot in lost was dropped. */
async function setup(ctx) {
  const pkg = ctx.proto('cdc_streamer.proto');
  const lost = new Set<string>();
  ctx.grpc.serve(pkg.cdcstream.Slots.service, {
    ReadSlot(call, callback) {
      const {slot, from_lsn, max_changes} = call.request;
      if (lost.has(slot)) return callback({code: ctx.grpc.status.NOT_FOUND, details: \`replication slot "\${slot}" does not exist\`});
      const changes = WAL.filter(c => c.lsn > Number(from_lsn)).slice(0, Number(max_changes) || WAL.length);
      if (changes.length === 0) return callback(null, {});
      callback(null, {batch_id: \`\${slot}@\${changes[0].lsn}\`, first_lsn: changes[0].lsn, last_lsn: changes[changes.length - 1].lsn, changes});
    },
  });
  const store = ctx.load('/support/cdc/store.ts');
  const cursor = ctx.load('/support/cdc/cursor.ts');
  const sub = await store.createSubscription('acme', 'orders', ['id', 'status'], 'warehouse-1');
  const sink = {
    accept: true,
    batches: [] as string[],
    deliver: batch => {
      sink.batches.push(\`\${batch.batch_id}:\${batch.changes.map(c => Number(c.lsn)).join(',')}\`);
      return sink.accept;
    },
  };
  return {m: ctx.load('client'), lost, store, cursor, sub, sink};
}

const reads = (ctx): number[] => ctx.grpc.callsTo('ReadSlot').map(c => Number(c.request.from_lsn));

export async function check_read_apply(ctx) {
  const {m, cursor, sub, sink} = await setup(ctx);
  let outcome = await m.replicateOnce(sub.id, sink.deliver);
  assert.equal(outcome, 'applied', \`a round over a healthy slot answered \${outcome}, expected applied\`);
  assert.deepStrictEqual(sink.batches, [\`\${sub.slot}@101:101,102,103\`], \`the sink was handed \${JSON.stringify(sink.batches)}, expected the batch 101..103\`);
  assert.equal(await cursor.loadCursor(sub.id, 'orders'), 103, 'after the sink took 101..103 the cursor must be 103');
  outcome = await m.replicateOnce(sub.id, sink.deliver);
  assert.equal(outcome, 'idle', \`a round with nothing new answered \${outcome}, expected idle\`);
  assert.deepStrictEqual(reads(ctx), [0, 103], \`the rounds read from LSNs \${JSON.stringify(reads(ctx))}, expected 0 then the confirmed 103\`);
  assert.equal(sink.batches.length, 1, 'an empty read must deliver nothing');
}

export async function check_deadline(ctx) {
  const {m, cursor, sub, sink} = await setup(ctx);
  ctx.grpc.setLatency('ReadSlot', 30.0);
  const before = ctx.clock.now();
  const outcome = await m.replicateOnce(sub.id, sink.deliver);
  const waited = (ctx.clock.now() - before) / 1000;
  const call = ctx.grpc.callsTo('ReadSlot')[0];
  assert(call.timeout !== null, \`ReadSlot was called without a deadline: a source that stops answering held the round for \${waited.toFixed(0)} s\`);
  assert(4.5 <= call.timeout && call.timeout <= 5.5, \`ReadSlot carries a \${call.timeout} s deadline, expected READ_DEADLINE_MS = 5000\`);
  assert.equal(outcome, 'retry', \`a read that ran past its deadline answered \${outcome}, expected retry\`);
  assert(sink.batches.length === 0 && (await cursor.loadCursor(sub.id, 'orders')) === null, 'a timed-out read must deliver nothing and leave the cursor alone');
  ctx.grpc.setLatency('ReadSlot', 0);
  assert.equal(await m.replicateOnce(sub.id, sink.deliver), 'applied', 'once the source answers again the next round must apply the batch');
}

export async function check_no_skip(ctx) {
  const {m, cursor, sub, sink} = await setup(ctx);
  sink.accept = false;
  let outcome = await m.replicateOnce(sub.id, sink.deliver);
  const confirmed = await cursor.loadCursor(sub.id, 'orders');
  assert.equal(confirmed, null, \`the sink refused the batch and the cursor moved to \${confirmed}: the next round reads past changes the sink never applied\`);
  assert.equal(outcome, 'retry', \`a refused batch answered \${outcome}, expected retry\`);
  sink.accept = true;
  outcome = await m.replicateOnce(sub.id, sink.deliver);
  assert.equal(outcome, 'applied', \`the second round answered \${outcome}, expected applied\`);
  assert.deepStrictEqual(reads(ctx), [0, 0], \`the rounds read from LSNs \${JSON.stringify(reads(ctx))}: after a refusal the next round must read the same batch again\`);
  assert.equal(sink.batches[1], sink.batches[0], \`the retry delivered \${sink.batches[1]} after \${sink.batches[0]}: the same batch, same id, must come again\`);
  assert.equal(await cursor.loadCursor(sub.id, 'orders'), 103, 'once the sink took the batch the cursor must reach 103');
}

export async function check_slot_lost(ctx) {
  const {m, lost, store, sub, sink} = await setup(ctx);
  lost.add(sub.slot);
  let outcome = await m.replicateOnce(sub.id, sink.deliver);
  assert.equal(outcome, 'halted', \`a slot the database dropped answered \${outcome}: NOT_FOUND is final, expected halted\`);
  const {status} = await store.findSubscription(sub.id);
  assert.equal(status, 'slot_lost', \`after its slot was dropped the subscription is \${status}, expected slot_lost so the lag read can page\`);
  outcome = await m.replicateOnce(sub.id, sink.deliver);
  const calls = ctx.grpc.callsTo('ReadSlot').length;
  assert(outcome === 'halted' && calls === 1, \`a halted subscription answered \${outcome} and read the slot \${calls} times: it must not be read again\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"cdc/cursor"
	pb "cdc/gen/cdc_streamer"
	"cdc/store"

	"leetbuild/harness"
)

var replBg = context.Background()

type walEntry struct {
	lsn                   int64
	pk, op, before, after string
}

var wal = []walEntry{
	{101, "42", "insert", "", \`{"id":42,"status":"new"}\`},
	{102, "42", "update", \`{"id":42,"status":"new"}\`, \`{"id":42,"status":"paid"}\`},
	{103, "7", "insert", "", \`{"id":7,"status":"new"}\`},
}

// sourcePeer serves the orders WAL at LSN 101..103; a slot in lost was dropped.
type sourcePeer struct {
	pb.UnimplementedSlotsServer
	lost map[string]bool
}

func (s *sourcePeer) ReadSlot(_ context.Context, req *pb.ReadSlotRequest) (*pb.Batch, error) {
	if s.lost[req.GetSlot()] {
		return nil, status.Errorf(codes.NotFound, "replication slot %q does not exist", req.GetSlot())
	}
	batch := &pb.Batch{}
	for _, e := range wal {
		if e.lsn > req.GetFromLsn() && (req.GetMaxChanges() == 0 || len(batch.Changes) < int(req.GetMaxChanges())) {
			batch.Changes = append(batch.Changes, &pb.Change{Lsn: e.lsn, Table: "orders", Pk: e.pk, Op: e.op, Before: e.before, After: e.after})
		}
	}
	if n := len(batch.Changes); n > 0 {
		batch.BatchId = fmt.Sprintf("%s@%d", req.GetSlot(), batch.Changes[0].Lsn)
		batch.FirstLsn, batch.LastLsn = batch.Changes[0].Lsn, batch.Changes[n-1].Lsn
	}
	return batch, nil
}

// recorder is a deliver that records every batch it is handed and answers accept.
type recorder struct {
	accept  bool
	batches []string
}

func (r *recorder) deliver(b *pb.Batch) bool {
	lsns := ""
	for _, c := range b.GetChanges() {
		lsns += fmt.Sprintf(",%d", c.GetLsn())
	}
	r.batches = append(r.batches, b.GetBatchId()+":"+lsns)
	return r.accept
}

func setup(ctx *harness.Ctx) (*sourcePeer, *store.Subscription, *recorder) {
	source := &sourcePeer{lost: map[string]bool{}}
	pb.RegisterSlotsServer(ctx.GRPC.Server(""), source)
	sub, err := store.CreateSubscription(replBg, "acme", "orders", []string{"id", "status"}, "warehouse-1")
	ctx.NoError(err, "creating the subscription")
	return source, sub, &recorder{accept: true}
}

func confirmedLsn(ctx *harness.Ctx, sub *store.Subscription) (int64, bool) {
	lsn, ok, err := cursor.LoadCursor(replBg, sub.ID, "orders")
	ctx.NoError(err, "cursor.LoadCursor")
	return lsn, ok
}

func reads(ctx *harness.Ctx) []int64 {
	out := []int64{}
	for _, c := range ctx.GRPC.CallsTo("ReadSlot", "") {
		out = append(out, c.Request.(*pb.ReadSlotRequest).GetFromLsn())
	}
	return out
}

func CheckReadApply(ctx *harness.Ctx) {
	_, sub, sink := setup(ctx)
	ctx.Equal(replicateOnce(replBg, sub.ID, sink.deliver), "applied", "a round over a healthy slot")
	ctx.Equal(sink.batches, []string{sub.Slot + "@101:,101,102,103"}, "the sink must be handed the batch 101..103; the batches")
	lsn, _ := confirmedLsn(ctx, sub)
	ctx.Equal(lsn, int64(103), "after the sink took 101..103, the cursor")
	ctx.Equal(replicateOnce(replBg, sub.ID, sink.deliver), "idle", "a round with nothing new")
	ctx.Equal(reads(ctx), []int64{0, 103}, "the rounds must read from 0, then from the confirmed 103; the from LSNs")
	ctx.Equal(len(sink.batches), 1, "an empty read must deliver nothing; the batches")
}

func CheckDeadline(ctx *harness.Ctx) {
	_, sub, sink := setup(ctx)
	ctx.GRPC.SetLatency("ReadSlot", 30, "")
	before := ctx.Clock.Now()
	outcome := replicateOnce(replBg, sub.ID, sink.deliver)
	waited := float64(ctx.Clock.Now()-before) / 1000
	call := ctx.GRPC.CallsTo("ReadSlot", "")[0]
	ctx.Assert(call.HasDeadline(), "ReadSlot was called without a deadline: a source that stops answering held the round for %.0f s", waited)
	ctx.Assert(call.Timeout.Seconds() >= 4.5 && call.Timeout.Seconds() <= 5.5, "ReadSlot carries a %v deadline, expected readDeadline = 5 s", call.Timeout)
	ctx.Equal(outcome, "retry", "a read that ran past its deadline")
	_, ok := confirmedLsn(ctx, sub)
	ctx.Assert(!ok && len(sink.batches) == 0, "a timed-out read must deliver nothing and leave the cursor alone")
	ctx.GRPC.SetLatency("ReadSlot", 0, "")
	ctx.Equal(replicateOnce(replBg, sub.ID, sink.deliver), "applied", "once the source answers again the next round")
}

func CheckNoSkip(ctx *harness.Ctx) {
	_, sub, sink := setup(ctx)
	sink.accept = false
	outcome := replicateOnce(replBg, sub.ID, sink.deliver)
	lsn, ok := confirmedLsn(ctx, sub)
	ctx.Assert(!ok, "the sink refused the batch and the cursor moved to %d: the next round reads past changes the sink never applied", lsn)
	ctx.Equal(outcome, "retry", "a refused batch")
	sink.accept = true
	ctx.Equal(replicateOnce(replBg, sub.ID, sink.deliver), "applied", "the second round")
	ctx.Equal(reads(ctx), []int64{0, 0}, "after a refusal the next round must read the same batch again; the from LSNs")
	ctx.Equal(sink.batches[1], sink.batches[0], "the retry must deliver the same batch, same id")
	lsn, _ = confirmedLsn(ctx, sub)
	ctx.Equal(lsn, int64(103), "once the sink took the batch, the cursor")
}

func CheckSlotLost(ctx *harness.Ctx) {
	source, sub, sink := setup(ctx)
	source.lost[sub.Slot] = true
	ctx.Equal(replicateOnce(replBg, sub.ID, sink.deliver), "halted", "a slot the database dropped (NOT_FOUND is final)")
	ctx.Equal(store.FindSubscription(replBg, sub.ID).Status, "slot_lost", "after its slot was dropped the subscription must be slot_lost so the lag read can page; the status")
	outcome := replicateOnce(replBg, sub.ID, sink.deliver)
	calls := len(ctx.GRPC.CallsTo("ReadSlot", ""))
	ctx.Assert(outcome == "halted" && calls == 1, "a halted subscription answered %q and read the slot %d times: it must not be read again", outcome, calls)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <cstdint>
#include <memory>
#include <set>
#include <string>
#include <tuple>
#include <vector>

#include "cdc/cursor.h"
#include "cdc/store.h"
#include "cdc_streamer.grpc.pb.h"

namespace {

const std::vector<std::tuple<int64_t, std::string, std::string, std::string, std::string>> kWal = {
    {101, "42", "insert", "", R"({"id":42,"status":"new"})"},
    {102, "42", "update", R"({"id":42,"status":"new"})", R"({"id":42,"status":"paid"})"},
    {103, "7", "insert", "", R"({"id":7,"status":"new"})"}};

// The orders WAL at LSN 101..103; a slot in lost was dropped.
class SourcePeer final : public cdcstream::Slots::Service {
 public:
  std::set<std::string> lost;
  grpc::Status ReadSlot(grpc::ServerContext*, const cdcstream::ReadSlotRequest* req, cdcstream::Batch* out) override {
    if (lost.count(req->slot())) return grpc::Status(grpc::StatusCode::NOT_FOUND, "replication slot \\"" + req->slot() + "\\" does not exist");
    for (const auto& [lsn, pk, op, before, after] : kWal) {
      if (lsn <= req->from_lsn() || (req->max_changes() > 0 && out->changes_size() >= req->max_changes())) continue;
      cdcstream::Change* change = out->add_changes();
      change->set_lsn(lsn);
      change->set_table("orders");
      change->set_pk(pk);
      change->set_op(op);
      change->set_before(before);
      change->set_after(after);
    }
    if (out->changes_size() > 0) {
      out->set_batch_id(req->slot() + "@" + std::to_string(out->changes(0).lsn()));
      out->set_first_lsn(out->changes(0).lsn());
      out->set_last_lsn(out->changes(out->changes_size() - 1).lsn());
    }
    return grpc::Status::OK;
  }
};

// A deliver that records every batch it is handed and answers accept.
struct Recorder {
  bool accept = true;
  std::vector<std::string> batches;
  bool operator()(const cdcstream::Batch& batch) {
    std::string lsns;
    for (const auto& c : batch.changes()) lsns += "," + std::to_string(c.lsn());
    batches.push_back(batch.batch_id() + ":" + lsns);
    return accept;
  }
};

struct World {
  SourcePeer source;
  Recorder sink;
  store::Subscription sub;
};

World& setup(harness::Ctx& ctx) {
  static World* world = nullptr;
  delete world;
  world = new World;
  ctx.GRPC.Server("")->RegisterService(&world->source);
  world->sub = store::createSubscription("acme", "orders", {"id", "status"}, "warehouse-1");
  return *world;
}

std::string runRound(World& w) {
  return replicateOnce(w.sub.id, [&w](const cdcstream::Batch& b) { return w.sink(b); });
}

std::vector<int64_t> reads(harness::Ctx& ctx) {
  std::vector<int64_t> out;
  for (const auto& c : ctx.GRPC.CallsTo("ReadSlot")) out.push_back(c.Request<cdcstream::ReadSlotRequest>().from_lsn());
  return out;
}

}  // namespace

void CheckReadApply(harness::Ctx& ctx) {
  World& w = setup(ctx);
  ctx.Equal(runRound(w), "applied", "a round over a healthy slot");
  ctx.Equal(w.sink.batches, {w.sub.slot + "@101:,101,102,103"}, "the sink must be handed the batch 101..103; the batches");
  ctx.Equal(cursor::loadCursor(w.sub.id, "orders"), std::optional<int64_t>(103), "after the sink took 101..103, the cursor");
  ctx.Equal(runRound(w), "idle", "a round with nothing new");
  ctx.Equal(reads(ctx), std::vector<int64_t>{0, 103}, "the rounds must read from 0, then from the confirmed 103; the from LSNs");
  ctx.Equal(w.sink.batches.size(), 1, "an empty read must deliver nothing; the batches");
}

void CheckDeadline(harness::Ctx& ctx) {
  World& w = setup(ctx);
  ctx.GRPC.SetLatency("ReadSlot", 30.0);
  const int64_t before = ctx.Clock.Now();
  const std::string outcome = runRound(w);
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  const auto call = ctx.GRPC.CallsTo("ReadSlot").at(0);
  ctx.Assert(call.HasDeadline(), "ReadSlot was called without a deadline: a source that stops answering held the round for %.0f s", waited);
  ctx.Assert(4.5 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 5.5, "ReadSlot carries a %v s deadline, expected kReadDeadline = 5 s", call.TimeoutSeconds());
  ctx.Equal(outcome, "retry", "a read that ran past its deadline");
  ctx.Assert(!cursor::loadCursor(w.sub.id, "orders") && w.sink.batches.empty(), "a timed-out read must deliver nothing and leave the cursor alone");
  ctx.GRPC.SetLatency("ReadSlot", 0);
  ctx.Equal(runRound(w), "applied", "once the source answers again the next round");
}

void CheckNoSkip(harness::Ctx& ctx) {
  World& w = setup(ctx);
  w.sink.accept = false;
  const std::string outcome = runRound(w);
  const auto confirmed = cursor::loadCursor(w.sub.id, "orders");
  ctx.Assert(!confirmed, "the sink refused the batch and the cursor moved to %d: the next round reads past changes the sink never applied", confirmed.value_or(0));
  ctx.Equal(outcome, "retry", "a refused batch");
  w.sink.accept = true;
  ctx.Equal(runRound(w), "applied", "the second round");
  ctx.Equal(reads(ctx), std::vector<int64_t>{0, 0}, "after a refusal the next round must read the same batch again; the from LSNs");
  ctx.Equal(w.sink.batches.at(1), w.sink.batches.at(0), "the retry must deliver the same batch, same id");
  ctx.Equal(cursor::loadCursor(w.sub.id, "orders"), std::optional<int64_t>(103), "once the sink took the batch, the cursor");
}

void CheckSlotLost(harness::Ctx& ctx) {
  World& w = setup(ctx);
  w.source.lost.insert(w.sub.slot);
  ctx.Equal(runRound(w), "halted", "a slot the database dropped (NOT_FOUND is final)");
  ctx.Equal(store::findSubscription(w.sub.id)->status, "slot_lost", "after its slot was dropped the subscription must be slot_lost so the lag read can page; the status");
  const std::string outcome = runRound(w);
  const size_t calls = ctx.GRPC.CallsTo("ReadSlot").size();
  ctx.Assert(outcome == "halted" && calls == 1, "a halted subscription answered %q and read the slot %d times: it must not be read again", outcome, calls);
}
`,
  },
  hints: [
    'Make the slot answer after 30 s: the round waits it out. Make the sink refuse a batch: the cursor still moves to its last LSN and the next round reads past it. Drop the slot: every round answers retry and nothing records it.',
    'The read passes no deadline, so it lasts as long as the source does. The confirm runs whatever `deliver` returned. Every gRPC error lands in one branch, so a NOT_FOUND, which no retry can fix, looks like a blip.',
    'Pass `timeout=READ_DEADLINE_S`; return `"retry"` when `deliver(batch)` is false, before `cursor.confirm`; on `NOT_FOUND` call `store.set_status(id, "slot_lost")` and return `"halted"`, and return `"halted"` first for a subscription that is not active.',
  ],
  debrief: `The cursor may only name a position the sink has, so every failure path leaves it where it was and the next round reads the same batch with the same id: a duplicate the sink can absorb, instead of a hole it cannot see. The deadline turns a hung source into an ordinary retry. NOT_FOUND is different because nothing brings the slot back: the WAL it retained is gone, and the honest state is a halted subscription that needs a new snapshot. Production replicators back off between retries, cap the attempts on one batch before paging, and resnapshot a table whose slot was lost, as Debezium does with \`snapshot.mode=when_needed\`.`,
};
