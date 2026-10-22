import type {Step} from '@/lib/types';

export const slotReadStep: Step = {
  id: 'dependency',
  title: 'Replication reads with a no-skip rule',
  concept: 'grpc',
  file: 'client',
  focus: ['replicator', 'pg', 'redis', 'sink'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it reads batches from the slot,
applies them to the sink and keeps the lag chart flat by moving the cursor on after anything that
fails. It compiles, it serves the demo, and it hides the flaw that costs a tenant its changes.
Review it like the service owner, fix it, and prove the fix with the checks below.

Replication slots are read over gRPC with a 5-second deadline, and a batch that fails is retried
from its first LSN with the same batch id; no batch is ever skipped to keep up. The draft drops a
failed batch and advances the cursor to avoid back-pressure, so a database blip silently loses
tenant changes, and it retries a slot-lost error forever. The fix must prove a failed batch is
retried from its first LSN until it succeeds or the subscription halts, a slot loss surfaces as a
page-worthy state, and back-pressure applies at the sink instead of dropped batches.

- \`ReadSlot\` is called with a **5-second deadline**: \`timeout=DEADLINE_S\` with \`DEADLINE_S = 5\`
  in Python, \`deadline: Date.now() + DEADLINE_MS\` with \`DEADLINE_MS = 5000\` in TypeScript,
  \`readSlotTimeout = 5 * time.Second\` with \`context.WithTimeout\` in Go,
  \`withDeadlineAfter(DeadlineSeconds.seconds)\` with \`DeadlineSeconds = 5\` in Scala, and
  \`set_deadline(\` with \`kDeadlineMs = 5000\` in C++.
- A failed batch is retried **from its first LSN with the same batch id**
  (\`batch_id\`/\`batchId\`/\`batchID\`, \`first_lsn\`/\`firstLsn\`/\`firstLSN\`), bounded by
  \`MAX_BATCH_RETRIES\`/\`maxBatchRetries\`/\`MaxBatchRetries\`/\`kMaxBatchRetries\` = **5**, and never
  dropped or jumped over.
- When the attempts are exhausted the subscription **HALTS** (\`HALTED\`/\`StateHalted\`/\`Halted\`,
  \`halt(\`) instead of moving the cursor.
- An **inactive or lost slot** surfaces as a page-worthy state
  (\`SLOT_LOST\`/\`SlotLost\`/\`kSlotLost\` plus \`page_oncall\`/\`pageOncall\` and
  \`CRITICAL\`/\`SeverityCritical\`/\`Critical\`/\`kCritical\`) rather than being retried forever.
- The sink applies each batch **before** the cursor is confirmed, so back-pressure lands on the
  sink (\`sink.apply_batch(...)\` or \`sink.applyBatch(...)\` then \`confirm(...)\`).

**Failure mode the checks target.** The draft drops a failed batch and advances the cursor to avoid
back-pressure, so a database blip silently loses tenant changes, and it retries a slot-lost error
forever. The quiet one is the cursor itself: a confirmed LSN is a promise that everything up to it
is durably downstream, so moving it past a batch that never applied turns at-least-once delivery
into loss that no metric shows — the lag chart stays flat while the tenant's changes are gone, and
the slot keeps discarding the segments the stream still needs.`,
  sequence: {
    participants: ['Replicator', 'Slot reader', 'pg slot', 'sink', 'oncall'],
    messages: [
      {
        from: 'Replicator',
        to: 'Slot reader',
        label: 'ReadSlot(slot, from_lsn, batch_id) · 5 s deadline',
        kind: 'sync',
      },
      {from: 'Slot reader', to: 'pg slot', label: 'read WAL after from_lsn', kind: 'sync'},
      {from: 'pg slot', to: 'Slot reader', label: 'batch · batch_id · first_lsn → last_lsn', kind: 'reply'},
      {from: 'Slot reader', to: 'Replicator', label: 'batch · or slot inactive', kind: 'reply'},
      {from: 'Replicator', to: 'sink', label: 'apply_batch(batch) · back-pressure lands here', kind: 'sync'},
      {from: 'sink', to: 'Replicator', label: 'applied', kind: 'reply'},
      {
        from: 'Replicator',
        to: 'Replicator',
        label: 'confirm cursor · or retry same batch_id from first_lsn, then HALTED',
        kind: 'async',
      },
      {from: 'Replicator', to: 'oncall', label: 'page SLOT_LOST · CRITICAL', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Reads a batch under a 5-second deadline',
      detail:
        'Every `ReadSlot` carries a five-second deadline: `timeout=DEADLINE_S` with `DEADLINE_S = 5`, `deadline: Date.now() + DEADLINE_MS` with `DEADLINE_MS = 5000`, `context.WithTimeout` with `readSlotTimeout = 5 * time.Second`, `withDeadlineAfter(DeadlineSeconds.seconds)` with `DeadlineSeconds = 5`, `set_deadline(...)` with `kDeadlineMs = 5000`. The draft calls the reader with no deadline at all, so one stalled slot pins the replicator for the life of the process.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*5/, /timeout=DEADLINE_S/, /\.ReadSlot\(/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*5000/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/, /\.ReadSlot\(/]},
        go: {all: [/readSlotTimeout\s*=\s*5\s*\*\s*time\.Second/, /context\.WithTimeout/, /\.ReadSlot\(/]},
        scala: {all: [/DeadlineSeconds\s*=\s*5/, /withDeadlineAfter/, /\.readSlot\(/]},
        cpp: {all: [/kDeadlineMs\s*=\s*5000/, /set_deadline\(/, /->ReadSlot\(/]},
      },
    },
    {
      id: 'same-batch-retry',
      title: 'Retries a failed batch from its first LSN with the same batch id',
      detail:
        'A batch that fails is retried from `first_lsn` under the same `batch_id`, at most `MAX_BATCH_RETRIES` (5) times, so a re-delivery is a duplicate the sink can absorb and a loss is impossible. The draft reads the next batch instead, which is how a blip in the source becomes a hole in the tenant stream.',
      match: {
        python: {all: [/MAX_BATCH_RETRIES\s*=\s*5/, /range\(MAX_BATCH_RETRIES\)/, /batch_id/, /first_lsn/]},
        typescript: {
          all: [
            /MAX_BATCH_RETRIES\s*=\s*5/,
            /attempt\s*<\s*MAX_BATCH_RETRIES/,
            /batch_id|batchId/,
            /first_lsn|firstLsn/,
          ],
        },
        go: {all: [/maxBatchRetries\s*=\s*5/, /attempt\s*<\s*maxBatchRetries/, /batchID/, /firstLSN/]},
        scala: {all: [/MaxBatchRetries\s*=\s*5/, /attempt\s*<\s*MaxBatchRetries/, /batchId/, /firstLsn/]},
        cpp: {all: [/kMaxBatchRetries\s*=\s*5/, /attempt\s*<\s*kMaxBatchRetries/, /batchId/, /firstLsn/]},
      },
    },
    {
      id: 'no-skip',
      title: 'Halts the subscription when the attempts are exhausted',
      detail:
        'When the retries run out the subscription stops in a `HALTED` state through `halt(...)`; nothing may advance the cursor past a batch that never applied. The draft moves the cursor to the next batch to keep the lag chart flat, and the tenant never learns which changes are missing.',
      match: {
        python: {all: [/HALTED/, /def halt\(/], none: [/skip/]},
        typescript: {all: [/HALTED/, /function halt\(/], none: [/skip/]},
        go: {all: [/StateHalted/, /func halt\(/], none: [/skip/]},
        scala: {all: [/Halted/, /def halt\(/], none: [/skip/]},
        cpp: {all: [/Halted/, /halt\(/], none: [/skip/]},
      },
    },
    {
      id: 'slot-lost',
      title: 'Surfaces a lost slot as a page-worthy state',
      detail:
        'An inactive or lost slot becomes `SLOT_LOST` and a `CRITICAL` `page_oncall`, because the source database discards the segments the stream still needs while the slot is unread — a permanent condition, not a retry. The draft loops on it forever and pages nobody.',
      match: {
        python: {all: [/SLOT_LOST/, /def page_oncall\(/, /CRITICAL/]},
        typescript: {all: [/SLOT_LOST/, /function pageOncall\(/, /CRITICAL/]},
        go: {all: [/SlotLost/, /func pageOncall\(/, /SeverityCritical/]},
        scala: {all: [/SlotLost/, /def pageOncall\(/, /Critical/]},
        cpp: {all: [/kSlotLost/, /pageOncall\(/, /kCritical/]},
      },
    },
    {
      id: 'back-pressure',
      title: 'Applies the batch before confirming the cursor',
      detail:
        '`sink.apply_batch(...)` (or `sink.applyBatch(...)`) runs before `confirm(...)`: the slow consumer takes the back-pressure and the cursor stays behind it. Confirming first would promise data the sink never took.',
      match: {
        python: {order: [/sink\.apply_batch\(/, /confirm\(/]},
        typescript: {order: [/sink\.applyBatch\(/, /confirm\(/]},
        go: {order: [/sink\.ApplyBatch\(/, /confirm\(/]},
        scala: {order: [/sink\.applyBatch\(/, /confirm\(/]},
        cpp: {order: [/sink\.applyBatch\(|sink->applyBatch\(/, /confirm\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

import grpc

import slots_pb2
import slots_pb2_grpc

logger = logging.getLogger("cdcd.grpc")

channel = grpc.insecure_channel("pg-slots:9000")
slots = slots_pb2_grpc.SlotReaderStub(channel)


def run(subscription: str, slot: str, sink, start_lsn: int) -> None:
    # TODO: read each batch with a 5 s deadline, retry a batch that failed from its first LSN with
    # the same batch id instead of dropping it and moving the cursor on, page on a lost slot, and
    # let the sink apply the batch before the cursor is confirmed.
    cursor = start_lsn
    while True:
        reply = slots.ReadSlot(slots_pb2.ReadSlotRequest(slot=slot, from_lsn=cursor))
        if not reply.slot_active:
            logger.warning("slot %s is not active, retrying", slot)
            continue
        if not reply.changes:
            continue
        try:
            sink.apply_batch(reply)
        except Exception as exc:
            logger.warning("batch %s at lsn %s failed, moving on: %s", reply.batch_id, cursor, exc)
        cursor = reply.last_lsn
`,
      solution: `"""Slot reader: five seconds per read, a failed batch retried from its first LSN under the same
batch id, a halt instead of a moved cursor, and a page when the slot is gone."""

import logging
import time

import grpc

import slots_pb2
import slots_pb2_grpc

from .cursors import cursors

logger = logging.getLogger("cdcd.grpc")

DEADLINE_S = 5
MAX_BATCH_RETRIES = 5
BATCH_MAX_CHANGES = 500
IDLE_SLEEP_S = 1.0

OK = "OK"
IDLE = "IDLE"
HALTED = "HALTED"
SLOT_LOST = "SLOT_LOST"
CRITICAL = "CRITICAL"

channel = grpc.insecure_channel("pg-slots:9000")
slots = slots_pb2_grpc.SlotReaderStub(channel)


class SlotLost(Exception):
    """The slot is inactive: the source will discard the segments this stream still needs."""


def page_oncall(severity: str, reason: str, subscription: str) -> None:
    """A lost slot is a page, not a metric: retention keeps dropping while nothing reads it."""
    logger.error(
        "oncall page",
        extra={"severity": severity, "reason": reason, "subscription": subscription},
    )


def halt(subscription: str, state: str, reason: str) -> None:
    """Stop in a named state: a change delivered twice is cheaper than a change lost."""
    logger.error(
        "subscription halted",
        extra={"subscription": subscription, "state": state, "reason": reason},
    )
    cursors.set_state(subscription, state)


def new_batch_id(subscription: str, first_lsn: int) -> str:
    return f"{subscription}:{first_lsn}"


def read_batch(slot: str, first_lsn: int, batch_id: str):
    """One read of one batch, from its first LSN, under the same batch id on every attempt."""
    request = slots_pb2.ReadSlotRequest(
        slot=slot,
        from_lsn=first_lsn,
        batch_id=batch_id,
        max_changes=BATCH_MAX_CHANGES,
    )
    reply = slots.ReadSlot(request, timeout=DEADLINE_S)
    if not reply.slot_active:
        raise SlotLost(f"slot {slot} went inactive at lsn {first_lsn}")
    return reply


def deliver(subscription: str, slot: str, sink, first_lsn: int) -> tuple[str, int]:
    """One batch, retried from its first LSN under the same batch id, until the sink has it."""
    batch_id = new_batch_id(subscription, first_lsn)
    last_error: Exception | None = None
    for attempt in range(MAX_BATCH_RETRIES):
        try:
            batch = read_batch(slot, first_lsn, batch_id)
        except SlotLost as lost:
            page_oncall(CRITICAL, f"{SLOT_LOST}: {lost}", subscription)
            halt(subscription, SLOT_LOST, str(lost))
            return SLOT_LOST, first_lsn
        except grpc.RpcError as exc:
            last_error = exc
            continue
        if not batch.changes:
            return IDLE, first_lsn
        try:
            sink.apply_batch(batch)
            cursors.confirm(subscription, batch)
        except Exception as exc:
            last_error = exc
            logger.warning(
                "batch %s from lsn %s not applied, retrying from its first LSN",
                batch.batch_id,
                batch.first_lsn,
            )
            continue
        return OK, batch.last_lsn
    halt(
        subscription,
        HALTED,
        f"batch {batch_id} at lsn {first_lsn} failed {MAX_BATCH_RETRIES} attempts: {last_error}",
    )
    return HALTED, first_lsn


def run(subscription: str, slot: str, sink, start_lsn: int) -> str:
    cursor = start_lsn
    while True:
        state, cursor = deliver(subscription, slot, sink, cursor)
        if state in (HALTED, SLOT_LOST):
            return state
        if state == IDLE:
            time.sleep(IDLE_SLEEP_S)
`,
    },
    typescript: {
      starter: `/** Slot reader: a model-generated draft that moves the cursor on past whatever fails. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {logger} from './logger';

const BATCH_MAX_CHANGES = 500;

interface Change {
  table: string;
  key: string;
  lsn: string;
}

interface Batch {
  batchId: string;
  firstLsn: string;
  lastLsn: string;
  changes: Change[];
}

interface SlotReply extends Batch {
  slotActive: boolean;
}

interface SlotClient {
  ReadSlot(
    request: {slot: string; fromLsn: string; batchId: string; maxChanges: number},
    metadata: grpc.Metadata,
    options: {deadline?: number},
    callback: (error: grpc.ServiceError | null, reply: SlotReply) => void,
  ): void;
}

interface Sink {
  applyBatch(batch: Batch): Promise<void>;
}

const {slots} = grpc.loadPackageDefinition(protoLoader.loadSync('slots.proto')) as unknown as {
  slots: {SlotReader: new (target: string, credentials: grpc.ChannelCredentials) => SlotClient};
};

const slotReader = new slots.SlotReader('pg-slots:9000', grpc.credentials.createInsecure());

function read(slot: string, fromLsn: string): Promise<SlotReply> {
  return new Promise<SlotReply>((resolve, reject) => {
    slotReader.ReadSlot(
      {slot, fromLsn, batchId: '', maxChanges: BATCH_MAX_CHANGES},
      new grpc.Metadata(),
      {},
      (error: grpc.ServiceError | null, reply: SlotReply) => {
        if (error) reject(error);
        else resolve(reply);
      },
    );
  });
}

export async function run(subscription: string, slot: string, sink: Sink, startLsn: string): Promise<void> {
  // TODO: add the 5 s deadline, retry a failed batch from its first LSN with the same batch id
  // instead of dropping it and moving the cursor on, page on a lost slot, and let the sink apply
  // the batch before the cursor is confirmed.
  let cursor = startLsn;
  for (;;) {
    const reply = await read(slot, cursor);
    if (!reply.slotActive) {
      logger.warn({slot, subscription}, 'slot is not active, retrying');
      continue;
    }
    if (reply.changes.length === 0) continue;
    try {
      await sink.applyBatch(reply);
    } catch (error) {
      logger.warn({error, cursor}, 'batch failed, moving on');
    }
    cursor = reply.lastLsn;
  }
}
`,
      solution: `/**
 * Slot reader: five seconds per read, a failed batch retried from its first LSN under the same
 * batch id, a halt instead of a moved cursor, and a page when the slot is gone.
 */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {cursors} from './cursors';
import {logger} from './logger';

const DEADLINE_MS = 5000;
const MAX_BATCH_RETRIES = 5;
const BATCH_MAX_CHANGES = 500;
const IDLE_SLEEP_MS = 1000;

const OK = 'OK';
const IDLE = 'IDLE';
const HALTED = 'HALTED';
const SLOT_LOST = 'SLOT_LOST';
const CRITICAL = 'CRITICAL';

interface Change {
  table: string;
  key: string;
  lsn: string;
}

interface Batch {
  batchId: string;
  firstLsn: string;
  lastLsn: string;
  changes: Change[];
}

interface SlotReply extends Batch {
  slotActive: boolean;
}

interface SlotClient {
  ReadSlot(
    request: {slot: string; fromLsn: string; batchId: string; maxChanges: number},
    metadata: grpc.Metadata,
    options: {deadline: number},
    callback: (error: grpc.ServiceError | null, reply: SlotReply) => void,
  ): void;
}

interface Sink {
  applyBatch(batch: Batch): Promise<void>;
}

class SlotLost extends Error {}

const {slots} = grpc.loadPackageDefinition(protoLoader.loadSync('slots.proto')) as unknown as {
  slots: {SlotReader: new (target: string, credentials: grpc.ChannelCredentials) => SlotClient};
};

const slotReader = new slots.SlotReader('pg-slots:9000', grpc.credentials.createInsecure());

function pageOncall(severity: string, reason: string, subscription: string): void {
  logger.error({severity, reason, subscription}, 'oncall page');
}

function halt(subscription: string, state: string, reason: string): void {
  logger.error({subscription, state, reason}, 'subscription halted');
  void cursors.setState(subscription, state);
}

function newBatchId(subscription: string, firstLsn: string): string {
  return subscription + ':' + firstLsn;
}

async function readBatch(slot: string, firstLsn: string, batchId: string): Promise<Batch | null> {
  const reply = await new Promise<SlotReply>((resolve, reject) => {
    slotReader.ReadSlot(
      {slot, fromLsn: firstLsn, batchId, maxChanges: BATCH_MAX_CHANGES},
      new grpc.Metadata(),
      {deadline: Date.now() + DEADLINE_MS},
      (error: grpc.ServiceError | null, value: SlotReply) => {
        if (error) reject(error);
        else resolve(value);
      },
    );
  });
  if (!reply.slotActive) throw new SlotLost('slot ' + slot + ' went inactive at lsn ' + firstLsn);
  if (reply.changes.length === 0) return null;
  return {batchId: reply.batchId, firstLsn: reply.firstLsn, lastLsn: reply.lastLsn, changes: reply.changes};
}

async function deliver(
  subscription: string,
  slot: string,
  sink: Sink,
  firstLsn: string,
): Promise<{state: string; cursor: string}> {
  const batchId = newBatchId(subscription, firstLsn);
  let lastError: unknown = null;
  for (let attempt = 0; attempt < MAX_BATCH_RETRIES; attempt++) {
    let batch: Batch | null = null;
    try {
      batch = await readBatch(slot, firstLsn, batchId);
    } catch (error) {
      if (error instanceof SlotLost) {
        pageOncall(CRITICAL, SLOT_LOST + ': ' + error.message, subscription);
        halt(subscription, SLOT_LOST, error.message);
        return {state: SLOT_LOST, cursor: firstLsn};
      }
      lastError = error;
      continue;
    }
    if (batch === null) return {state: IDLE, cursor: firstLsn};
    try {
      await sink.applyBatch(batch);
      await cursors.confirm(subscription, batch);
    } catch (error) {
      lastError = error;
      logger.warn({error, batchId}, 'batch not applied, retrying from its first LSN');
      continue;
    }
    return {state: OK, cursor: batch.lastLsn};
  }
  halt(
    subscription,
    HALTED,
    'batch ' + batchId + ' at lsn ' + firstLsn + ' failed ' + MAX_BATCH_RETRIES + ' attempts: ' + String(lastError),
  );
  return {state: HALTED, cursor: firstLsn};
}

export async function run(subscription: string, slot: string, sink: Sink, startLsn: string): Promise<string> {
  let cursor = startLsn;
  for (;;) {
    const result = await deliver(subscription, slot, sink, cursor);
    cursor = result.cursor;
    if (result.state === HALTED || result.state === SLOT_LOST) return result.state;
    if (result.state === IDLE) await new Promise((resolve) => setTimeout(resolve, IDLE_SLEEP_MS));
  }
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"log/slog"

	pb "cdcd/slotspb"
)

type Sink interface {
	ApplyBatch(ctx context.Context, batch *pb.SlotBatch) error
}

// TODO: add the 5 s deadline, retry a failed batch from its first LSN with the same batch id
// instead of dropping it and moving the cursor on, page on a lost slot, and let the sink apply the
// batch before the cursor is confirmed.
func run(
	ctx context.Context,
	reader pb.SlotReaderClient,
	subscription, slot string,
	sink Sink,
	startLSN string,
) {
	cursor := startLSN
	for {
		reply, err := reader.ReadSlot(ctx, &pb.ReadSlotRequest{Slot: slot, FromLsn: cursor})
		if err != nil {
			slog.Warn("read failed, retrying", "subscription", subscription, "err", err)
			continue
		}
		if !reply.GetSlotActive() {
			slog.Warn("slot is not active, retrying", "subscription", subscription, "slot", slot)
			continue
		}
		if len(reply.GetChanges()) == 0 {
			continue
		}
		if err := sink.ApplyBatch(ctx, reply); err != nil {
			slog.Warn("batch failed, moving on", "subscription", subscription, "batch_id", reply.GetBatchId(), "err", err)
		}
		cursor = reply.GetLastLsn()
	}
}
`,
      solution: `package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	pb "cdcd/slotspb"
)

const (
	readSlotTimeout = 5 * time.Second
	maxBatchRetries = 5
	batchMaxChanges = 500
	idleSleep       = time.Second
)

const (
	StateOK       = "OK"
	StateIdle     = "IDLE"
	StateHalted   = "HALTED"
	StateSlotLost = "SLOT_LOST"

	SeverityCritical = "CRITICAL"
)

type Sink interface {
	ApplyBatch(ctx context.Context, batch *pb.SlotBatch) error
}

// SlotLost means the source slot is inactive: it will keep discarding the segments this stream
// still needs, so the condition is paged, never retried forever.
type SlotLost struct {
	Slot     string
	BatchID  string
	FirstLSN string
}

func (e *SlotLost) Error() string {
	return fmt.Sprintf("slot %s went inactive at lsn %s (batch %s)", e.Slot, e.FirstLSN, e.BatchID)
}

func pageOncall(severity, reason, subscription string) {
	slog.Error("oncall page", "severity", severity, "reason", reason, "subscription", subscription)
}

func halt(subscription, state, reason string) {
	slog.Error("subscription halted", "subscription", subscription, "state", state, "reason", reason)
	cursors.setState(context.Background(), subscription, state, reason)
}

func newBatchID(subscription, firstLSN string) string {
	return subscription + ":" + firstLSN
}

func readBatch(
	ctx context.Context,
	reader pb.SlotReaderClient,
	slot, firstLSN, batchID string,
) (*pb.SlotBatch, error) {
	callCtx, cancel := context.WithTimeout(ctx, readSlotTimeout)
	defer cancel()
	reply, err := reader.ReadSlot(callCtx, &pb.ReadSlotRequest{
		Slot:       slot,
		FromLsn:    firstLSN,
		BatchId:    batchID,
		MaxChanges: batchMaxChanges,
	})
	if err != nil {
		return nil, err
	}
	if !reply.GetSlotActive() {
		return nil, &SlotLost{Slot: slot, BatchID: batchID, FirstLSN: firstLSN}
	}
	return reply, nil
}

func deliver(
	ctx context.Context,
	reader pb.SlotReaderClient,
	subscription, slot string,
	sink Sink,
	firstLSN string,
) (string, string) {
	batchID := newBatchID(subscription, firstLSN)
	var lastErr error
	for attempt := 0; attempt < maxBatchRetries; attempt++ {
		batch, err := readBatch(ctx, reader, slot, firstLSN, batchID)
		if err != nil {
			var lost *SlotLost
			if errors.As(err, &lost) {
				pageOncall(SeverityCritical, StateSlotLost+": "+err.Error(), subscription)
				halt(subscription, StateSlotLost, err.Error())
				return StateSlotLost, firstLSN
			}
			lastErr = err
			continue
		}
		if len(batch.GetChanges()) == 0 {
			return StateIdle, firstLSN
		}
		if err := sink.ApplyBatch(ctx, batch); err != nil {
			lastErr = err
			continue
		}
		if err := cursors.confirm(ctx, subscription, batch); err != nil {
			lastErr = err
			continue
		}
		return StateOK, batch.GetLastLsn()
	}
	halt(
		subscription,
		StateHalted,
		fmt.Sprintf("batch %s at lsn %s failed %d attempts: %v", batchID, firstLSN, maxBatchRetries, lastErr),
	)
	return StateHalted, firstLSN
}

func run(
	ctx context.Context,
	reader pb.SlotReaderClient,
	subscription, slot string,
	sink Sink,
	startLSN string,
) string {
	cursor := startLSN
	for {
		state, next := deliver(ctx, reader, subscription, slot, sink, cursor)
		cursor = next
		switch state {
		case StateHalted, StateSlotLost:
			return state
		case StateIdle:
			time.Sleep(idleSleep)
		}
	}
}

// cursorStore is the durable LSN cursor: confirm advances it only after the sink has applied the
// batch, and it is the promise a restarted replicator resumes from.
type cursorStore interface {
	confirm(ctx context.Context, subscription string, batch *pb.SlotBatch) error
	setState(ctx context.Context, subscription, state, reason string) error
}

var cursors cursorStore
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}
import org.slf4j.LoggerFactory

object SlotReader {
  private val logger = LoggerFactory.getLogger("cdcd.grpc")
  private val reader = SlotGrpc.blockingStub(ManagedChannelBuilder.forAddress("pg-slots", 9000).usePlaintext().build())

  trait Sink {
    def applyBatch(batch: SlotBatch): Unit
  }

  // TODO: read each batch with a 5 s deadline, retry a batch that failed from its first LSN with
  // the same batch id instead of dropping it and moving the cursor on, page on a lost slot, and let
  // the sink apply the batch before the cursor is confirmed.
  def run(subscription: String, slot: String, sink: Sink, startLsn: Long): Unit = {
    var cursor = startLsn
    while (true) {
      try {
        val reply = reader.readSlot(ReadSlotRequest(slot = slot, fromLsn = cursor))
        if (!reply.slotActive) {
          logger.warn(s"slot $slot is not active, retrying")
        } else if (reply.changes.nonEmpty) {
          try {
            sink.applyBatch(reply)
          } catch {
            case _: RuntimeException => logger.warn("batch " + reply.batchId + " failed, moving on")
          }
          cursor = reply.lastLsn
        }
      } catch {
        case _: StatusRuntimeException => ()
      }
    }
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}
import org.slf4j.LoggerFactory

import cdcd.cursors.CursorStore

object SlotReader {
  val DeadlineSeconds = 5
  val MaxBatchRetries = 5
  val BatchMaxChanges = 500
  val IdleSleepMs = 1000

  val Ok = "OK"
  val Idle = "IDLE"
  val Halted = "HALTED"
  val SlotLost = "SLOT_LOST"
  val SeverityCritical = "CRITICAL"

  private val logger = LoggerFactory.getLogger("cdcd.grpc")
  private val reader = SlotGrpc.blockingStub(ManagedChannelBuilder.forAddress("pg-slots", 9000).usePlaintext().build())
  private val cursors = new CursorStore()

  trait Sink {
    def applyBatch(batch: SlotBatch): Unit
  }

  class SlotLostException(val batchId: String, val firstLsn: Long, val slot: String)
      extends RuntimeException(s"slot $slot went inactive at lsn $firstLsn (batch $batchId)")

  def pageOncall(severity: String, reason: String, subscription: String): Unit =
    logger.error(s"oncall page severity=$severity reason=$reason subscription=$subscription")

  def halt(subscription: String, state: String, reason: String): Unit = {
    logger.error(s"subscription halted state=$state reason=$reason subscription=$subscription")
    cursors.setState(subscription, state, reason)
  }

  def newBatchId(subscription: String, firstLsn: Long): String = s"$subscription:$firstLsn"

  def readBatch(slot: String, firstLsn: Long, batchId: String): Option[SlotBatch] = {
    val reply = reader
      .withDeadlineAfter(DeadlineSeconds, TimeUnit.SECONDS)
      .readSlot(ReadSlotRequest(slot = slot, fromLsn = firstLsn, batchId = batchId, maxChanges = BatchMaxChanges))
    if (!reply.slotActive) throw new SlotLostException(batchId, firstLsn, slot)
    if (reply.changes.isEmpty) None else Some(reply)
  }

  private def readOrLost(slot: String, firstLsn: Long, batchId: String): Either[Exception, Option[SlotBatch]] =
    try Right(readBatch(slot, firstLsn, batchId))
    catch { case exc: Exception => Left(exc) }

  def deliver(subscription: String, slot: String, sink: Sink, firstLsn: Long): (String, Long) = {
    val batchId = newBatchId(subscription, firstLsn)
    var lastError: Option[Exception] = None
    var outcome: Option[(String, Long)] = None
    var attempt = 0
    while (attempt < MaxBatchRetries && outcome.isEmpty) {
      attempt += 1
      readOrLost(slot, firstLsn, batchId) match {
        case Left(lost: SlotLostException) =>
          pageOncall(SeverityCritical, s"$SlotLost: " + lost.getMessage, subscription)
          halt(subscription, SlotLost, lost.getMessage)
          outcome = Some((SlotLost, firstLsn))
        case Left(other) =>
          lastError = Some(other)
          logger.warn(s"read of batch $batchId at lsn $firstLsn failed, retrying")
        case Right(None) =>
          outcome = Some((Idle, firstLsn))
        case Right(Some(batch)) =>
          try {
            sink.applyBatch(batch)
            cursors.confirm(subscription, batch)
            outcome = Some((Ok, batch.lastLsn))
          } catch {
            case exc: Exception =>
              lastError = Some(exc)
              logger.warn(s"batch $batchId from lsn $firstLsn not applied, retrying from its first LSN")
          }
      }
    }
    outcome.getOrElse {
      halt(
        subscription,
        Halted,
        s"batch $batchId at lsn $firstLsn failed $MaxBatchRetries attempts: " +
          lastError.map(_.getMessage).getOrElse(""),
      )
      (Halted, firstLsn)
    }
  }

  def run(subscription: String, slot: String, sink: Sink, startLsn: Long): String = {
    var cursor = startLsn
    var state = Ok
    while (state == Ok || state == Idle) {
      val (nextState, nextCursor) = deliver(subscription, slot, sink, cursor)
      state = nextState
      cursor = nextCursor
      if (state == Idle) Thread.sleep(IdleSleepMs)
    }
    state
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include "sink.h"
#include "slots.grpc.pb.h"

#include <cstdint>
#include <iostream>
#include <string>

// TODO: add the 5 s deadline, retry a failed batch from its first LSN with the same batch id
// instead of dropping it and moving the cursor on, page on a lost slot, and let the sink apply the
// batch before the cursor is confirmed.
void run(
    SlotReader::Stub* reader,
    const std::string& subscription,
    const std::string& slot,
    Sink* sink,
    std::int64_t startLsn) {
  std::int64_t cursor = startLsn;
  for (;;) {
    grpc::ClientContext ctx;
    ReadSlotRequest request;
    request.set_slot(slot);
    request.set_from_lsn(cursor);
    SlotBatch batch;
    const grpc::Status status = reader->ReadSlot(&ctx, request, &batch);
    if (!status.ok()) {
      std::cerr << "read failed, retrying: " << status.error_message() << std::endl;
      continue;
    }
    if (!batch.slot_active()) {
      std::cerr << "slot " << slot << " is not active, retrying" << std::endl;
      continue;
    }
    if (batch.changes_size() == 0) continue;
    if (!sink->applyBatch(batch)) {
      std::cerr << "batch " << batch.batch_id() << " failed, moving on" << std::endl;
    }
    cursor = batch.last_lsn();
  }
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include "cursor_store.h"
#include "sink.h"
#include "slots.grpc.pb.h"

#include <chrono>
#include <cstdint>
#include <iostream>
#include <string>
#include <thread>
#include <utility>

constexpr int kDeadlineMs = 5000;
constexpr int kMaxBatchRetries = 5;
constexpr int kBatchMaxChanges = 500;
constexpr int kIdleSleepMs = 1000;

constexpr char kOk[] = "OK";
constexpr char kIdle[] = "IDLE";
constexpr char kHalted[] = "HALTED";
constexpr char kSlotLost[] = "SLOT_LOST";
constexpr char kCritical[] = "CRITICAL";

CursorStore cursors;

void pageOncall(const std::string& severity, const std::string& reason, const std::string& subscription) {
  // A lost slot is a page, not a metric: the source keeps dropping segments while nothing reads.
  std::cerr << "oncall page severity=" << severity << " subscription=" << subscription
            << " reason=" << reason << std::endl;
}

void halt(const std::string& subscription, const std::string& state, const std::string& reason) {
  std::cerr << "subscription halted state=" << state << " subscription=" << subscription
            << " reason=" << reason << std::endl;
  cursors.setState(subscription, state, reason);
}

std::string newBatchId(const std::string& subscription, std::int64_t firstLsn) {
  return subscription + ":" + std::to_string(firstLsn);
}

std::pair<std::string, std::int64_t> deliver(
    SlotReader::Stub* reader,
    const std::string& subscription,
    const std::string& slot,
    Sink* sink,
    std::int64_t firstLsn) {
  const std::string batchId = newBatchId(subscription, firstLsn);
  std::string lastError;
  for (int attempt = 0; attempt < kMaxBatchRetries; ++attempt) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kDeadlineMs));
    ReadSlotRequest request;
    request.set_slot(slot);
    request.set_from_lsn(firstLsn);
    request.set_batch_id(batchId);
    request.set_max_changes(kBatchMaxChanges);
    SlotBatch batch;
    const grpc::Status status = reader->ReadSlot(&ctx, request, &batch);
    if (status.error_code() == grpc::StatusCode::NOT_FOUND) {
      const std::string reason = "slot " + slot + " is gone (batch " + batchId + ")";
      pageOncall(kCritical, std::string(kSlotLost) + ": " + reason, subscription);
      halt(subscription, kSlotLost, reason);
      return {kSlotLost, firstLsn};
    }
    if (!status.ok()) {
      lastError = status.error_message();
      continue;
    }
    if (!batch.slot_active()) {
      const std::string reason =
          "slot " + slot + " went inactive at lsn " + std::to_string(firstLsn) + " (batch " + batchId + ")";
      pageOncall(kCritical, std::string(kSlotLost) + ": " + reason, subscription);
      halt(subscription, kSlotLost, reason);
      return {kSlotLost, firstLsn};
    }
    if (batch.changes_size() == 0) return {kIdle, firstLsn};
    if (!sink->applyBatch(batch)) {
      lastError = "sink refused batch " + batchId;
      continue;
    }
    cursors.confirm(subscription, batch);
    return {kOk, batch.last_lsn()};
  }
  const std::string reason = "batch " + batchId + " at lsn " + std::to_string(firstLsn) + " failed " +
                             std::to_string(kMaxBatchRetries) + " attempts: " + lastError;
  halt(subscription, kHalted, reason);
  return {kHalted, firstLsn};
}

std::string run(
    SlotReader::Stub* reader,
    const std::string& subscription,
    const std::string& slot,
    Sink* sink,
    std::int64_t startLsn) {
  std::int64_t cursor = startLsn;
  for (;;) {
    const std::pair<std::string, std::int64_t> outcome = deliver(reader, subscription, slot, sink, cursor);
    cursor = outcome.second;
    if (outcome.first == kHalted || outcome.first == kSlotLost) return outcome.first;
    if (outcome.first == kIdle) std::this_thread::sleep_for(std::chrono::milliseconds(kIdleSleepMs));
  }
}
`,
    },
  },
  hints: [
    'A deadline is a property of the call, not of the retry around it: `timeout=DEADLINE_S` on `ReadSlot`, `deadline: Date.now() + DEADLINE_MS` in the call options, `context.WithTimeout(ctx, readSlotTimeout)` before the RPC, `withDeadlineAfter(DeadlineSeconds, ...)`, `ctx.set_deadline(... + milliseconds(kDeadlineMs))`. Without one, a slot that stalls pins the replicator for the life of the process.',
    'The retry loop is around the batch, not around the read: keep `batch_id` and `first_lsn` fixed across attempts, loop `for attempt in range(MAX_BATCH_RETRIES)` (or `attempt < MAX_BATCH_RETRIES`), and when the attempts run out call `halt(` and return `HALTED`. Advancing the cursor past a batch that never applied is how a tenant loses changes while the dashboard stays green.',
    'An inactive slot is not a transient error: page it (`pageOncall(CRITICAL, SLOT_LOST, ...)`) and stop, because the source will discard the segments the stream still needs. And order the write side as `sink.apply_batch(...)` (or `sink.applyBatch(...)`) then `confirm(...)`: the cursor is a promise that everything below it is downstream, so it moves only after the sink took the batch — back-pressure belongs to the sink, not to a dropped batch.',
  ],
  debrief: `The interviewer is testing whether you can review a replication reader that owns the cursor. The draft reads fine because the demo's sink never fails and its slot never dies: every happy path is correct and every failure path silently destroys data. Five defects are being checked. The deadline bounds one read, so a stalled slot cannot pin the worker. The same-batch retry is the delivery rule: a batch that failed is retried from its first LSN under the same batch id and the batch id is what makes the sink's re-apply idempotent. The halt is the one candidates get wrong under pressure — when the attempts run out the subscription stops in a named state, because moving the cursor is the same as deleting the changes it passed. Slot loss is the operational defect: an inactive slot is permanent and page-worthy, since the source keeps discarding segments while nothing reads, and an infinite retry loop is how a data-loss incident stays invisible. The last one is ordering: the sink applies the batch before the cursor is confirmed, so back-pressure slows the reader instead of costing the tenant rows. Real replicators add jittered backoff between attempts, a per-subscription lag budget, an alert on the distance between the confirmed LSN and the slot's retention, and an operator-approved quarantine path for a batch that can never apply.`,
};
