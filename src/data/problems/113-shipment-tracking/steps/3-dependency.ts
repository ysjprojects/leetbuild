import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Carrier polls with schedule-based fallback',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'carrier', 'scheduler'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: when the carrier answers, the
status flows and the shipment moves. It has no deadline, it retries inside the request, and it
treats a failed poll as "still in transit", so a carrier that has been unreachable for a day looks
identical to a parcel sitting at a depot. Review it, fix it, and prove the fix with the checks below.

Implement \`poll_carrier(shipment_id)\`, the only path that talks to the carrier gateway:

- Every attempt carries a **4-second deadline** (\`DEADLINE_S = 4\`): one hung carrier call must not
  pin a worker for the rest of the hour.
- **A failed poll never writes a status.** The shipment keeps the status the state store last
  accepted; the poll path only records the failure. Inventing \`in_transit\` on a failure is what
  makes a stalled feed look healthy.
- A failure calls \`mark_poll_failed(shipment_id, at, error)\` (which increments the consecutive
  failure count and keeps the last error) and **hands the next attempt to the scheduler**:
  \`schedule_retry(shipment_id, attempt, backoff_s)\` with an increasing backoff. The request returns
  immediately — a retry loop inside the request is how one slow carrier becomes a hot loop.
- A successful poll calls \`mark_poll_ok(shipment_id, now)\`; the returned status is handed to the
  state store (step 2's monotonic apply), never written here.
- A shipment whose last successful poll is older than \`STALE_AFTER_S = 900\` is **stale**.
  \`poll_health(shipment_id, now)\` reports \`{"stale", "last_ok_at", "failures"}\`, and
  \`stale_shipments(now)\` lists the stale ids so the operations view can surface the shipments whose
  carrier feed has gone quiet.

**Failure mode the checks target.** Three ways a stuck shipment hides. Without the deadline, one
unresponsive carrier holds the request open until the client gives up. Treating a failure as "still
in transit" with the previous timestamp is worse: nothing is stale, nothing is listed, and the
tracking page keeps promising a delivery for a parcel nobody has scanned. And retrying the carrier
in a tight loop inside the request turns a carrier outage into self-inflicted load exactly when the
carrier is least able to answer.`,
  sequence: {
    participants: ['Poll scheduler', 'Shipment API', 'Carrier gateway'],
    messages: [
      {from: 'Poll scheduler', to: 'Shipment API', label: 'tick · poll(shp_8f) · attempt 2', kind: 'sync'},
      {from: 'Shipment API', to: 'Shipment API', label: 'poll health: last_ok_at · failures', kind: 'sync'},
      {from: 'Shipment API', to: 'Carrier gateway', label: 'PollStatus(shp_8f) · deadline 4 s', kind: 'sync'},
      {from: 'Carrier gateway', to: 'Shipment API', label: 'UNAVAILABLE after the deadline', kind: 'reply'},
      {from: 'Shipment API', to: 'Shipment API', label: 'mark_poll_failed · no status written', kind: 'sync'},
      {from: 'Shipment API', to: 'Poll scheduler', label: 'schedule_retry(attempt + 1, backoff)', kind: 'async'},
      {from: 'Shipment API', to: 'Shipment API', label: 'now - last_ok_at > STALE_AFTER_S → stale', kind: 'sync'},
    ],
  },
  hints: [
    'The deadline belongs on the call, not around the loop: `timeout=`, the third argument with `deadline:`, `context.WithTimeout`, `withDeadlineAfter`, `set_deadline`. Without one, a carrier that accepts the connection and never answers holds the worker as long as the client waits — and the worker is holding a request.',
    "A failed poll is a fact about the poll, not about the parcel. Record it (`mark_poll_failed` increments the consecutive count and keeps the error), leave the shipment's status exactly as the state store has it, and let the reply say the status is unchanged. A caller that receives `in_transit` cannot tell a scan from an outage.",
    'Staleness is a derived fact: `last_ok_at` plus `STALE_AFTER_S` answers it, so `poll_health()` and `stale_shipments()` can be computed without another write. And the retry belongs to the scheduler: `schedule_retry(shipment_id, attempt, backoff_s)` with a growing backoff returns the request now and lets the tick pick the shipment up when the carrier is more likely to answer.',
  ],
  checks: [
    {
      id: 'deadline',
      title: 'Every poll carries a 4-second deadline',
      detail:
        'The carrier call is created with a 4-second deadline (`DEADLINE_S` / `DEADLINE_MS` / `deadlineMS` / `DeadlineMs` / `kDeadlineMs`). The draft calls the carrier with no deadline, so one unresponsive gateway holds the request open indefinitely.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*4/, /timeout=DEADLINE_S/, /\.PollStatus\(/]},
        typescript: {
          all: [/DEADLINE_MS\s*=\s*4_000/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/, /\.PollStatus\(/],
        },
        go: {all: [/deadlineMS\s*=\s*4000/, /context\.WithTimeout/, /\.PollStatus\(/]},
        scala: {all: [/DeadlineMs\s*=\s*4000/, /withDeadlineAfter/, /\.pollStatus\(/]},
        cpp: {all: [/kDeadlineMs\s*=\s*4000/, /set_deadline\(/, /->PollStatus\(/]},
      },
    },
    {
      id: 'no-invented-status',
      title: 'A failed poll never invents a status',
      detail:
        'On failure the poll path records the failure (`mark_poll_failed`) and writes no status at all. The draft writes `in_transit` with the previous timestamp, so a stalled carrier feed is indistinguishable from a healthy shipment.',
      match: {
        python: {all: [/mark_poll_failed\(/], none: [/write_status\([^)]*"in_transit"/]},
        typescript: {all: [/markPollFailed\(/], none: [/writeStatus\([^)]*'in_transit'/]},
        go: {all: [/MarkPollFailed\(/], none: [/WriteStatus\([^)]*"in_transit"/]},
        scala: {all: [/markPollFailed\(/], none: [/writeStatus\([^)]*"in_transit"/]},
        cpp: {all: [/markPollFailed\(/], none: [/writeStatus\([^)]*"in_transit"/]},
      },
    },
    {
      id: 'stale-threshold',
      title: 'Marks a shipment stale after STALE_AFTER_S without a successful poll',
      detail:
        '`poll_health(shipment_id, now)` compares `now - last_ok_at` against `STALE_AFTER_S` (900) and reports `stale` with the last success and the failure count. The draft keeps the previous timestamp on failure, so nothing ever goes stale.',
      match: {
        python: {all: [/STALE_AFTER_S/, /last_ok_at/, /def poll_health\(/]},
        typescript: {all: [/STALE_AFTER_S/, /lastOkAt/, /function pollHealth\(/]},
        go: {all: [/staleAfterS/, /lastOKAt/, /func pollHealth\(/]},
        scala: {all: [/StaleAfterS/, /lastOkAt/, /def pollHealth\(/]},
        cpp: {all: [/kStaleAfterS/, /last_ok_at/, /pollHealth\(/]},
      },
    },
    {
      id: 'ops-surface',
      title: 'Surfaces stale shipments for operations',
      detail:
        '`stale_shipments(now)` returns the ids whose carrier feed is stale and `poll_health()` is the same derived view the operations console reads. The draft exposes nothing: a shipment with a dead poll looks like any other.',
      match: {
        python: {all: [/def stale_shipments\(/, /poll_health\(/]},
        typescript: {all: [/function staleShipments\(/, /pollHealth\(/]},
        go: {all: [/func staleShipments\(/, /pollHealth\(/]},
        scala: {all: [/def staleShipments\(/, /pollHealth\(/]},
        cpp: {all: [/staleShipments\(/, /pollHealth\(/]},
      },
    },
    {
      id: 'scheduler',
      title: 'Moves the retry to the scheduler with a backoff',
      detail:
        'A failed poll calls `schedule_retry(shipment_id, attempt, backoff_s)` and returns instead of looping on the carrier inside the request. The draft retries the carrier five times in the request and turns a carrier outage into self-inflicted load.',
      match: {
        python: {all: [/schedule_retry\(/, /backoff/], none: [/for\s+attempt\s+in\s+range\(/, /while\s+True/]},
        typescript: {all: [/scheduleRetry\(/, /backoff/], none: [/for\s*\(\s*let\s+attempt/, /while\s*\(\s*true\s*\)/]},
        go: {all: [/scheduleRetry\(/, /backoff/], none: [/for\s+attempt\s*:=\s*0;/, /for\s*\{/]},
        scala: {all: [/scheduleRetry\(/, /backoff/], none: [/while \(attempt/, /while\s*\(\s*true\s*\)/]},
        cpp: {all: [/scheduleRetry\(/, /backoff/], none: [/for \(int attempt/, /while \(true\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import grpc

import carriers_pb2
import carriers_pb2_grpc
from fastapi import FastAPI

app = FastAPI()
carriers = carriers_pb2_grpc.CarrierStub(grpc.insecure_channel("carriers:9000"))


class PollStore:
    def current_status(self, shipment_id: str) -> str:
        """The status the state store last accepted for the shipment."""
        raise NotImplementedError

    def write_status(self, shipment_id: str, status: str, at: int) -> None:
        """Write the shipment's status."""
        raise NotImplementedError

    def mark_poll_ok(self, shipment_id: str, at: int) -> None:
        """Record a successful poll."""
        raise NotImplementedError


polls = PollStore()


@app.post("/v1/shipments/{shipment_id}/poll")
def poll(shipment_id: str) -> dict:
    # TODO: this draft has no deadline, retries the carrier in a tight loop inside the request, and
    # treats a failed poll as "still in transit" at the previous timestamp, so a stalled feed looks
    # healthy. Add the 4-second deadline, record the failure and its staleness instead of inventing
    # a status, and move the next attempt to the scheduler with a backoff.
    current = polls.current_status(shipment_id)
    for attempt in range(5):
        try:
            reply = carriers.PollStatus(carriers_pb2.PollRequest(shipment_id=shipment_id))
            polls.mark_poll_ok(shipment_id, int(time.time()))
            return {"status": reply.status, "carrier_ref": reply.carrier_ref}
        except grpc.RpcError:
            continue
    polls.write_status(shipment_id, current or "in_transit", int(time.time()))
    return {"status": current or "in_transit", "poll": "failed"}
`,
      solution: `import logging
import time

import grpc

import carriers_pb2
import carriers_pb2_grpc

logger = logging.getLogger("shipment-polls")

DEADLINE_S = 4
STALE_AFTER_S = 900
BACKOFF_S = (30, 60, 120, 300, 900)

carriers = carriers_pb2_grpc.CarrierStub(grpc.insecure_channel("carriers:9000"))


class PollStore:
    """Poll health per shipment, as operations reads it."""

    def last_ok_at(self, shipment_id: str) -> int | None:
        """Unix seconds of the last successful poll, or None when there never was one."""
        raise NotImplementedError

    def failures(self, shipment_id: str) -> int:
        """Consecutive failed polls since the last success."""
        raise NotImplementedError

    def mark_poll_ok(self, shipment_id: str, at: int) -> None:
        """Record a successful poll."""
        raise NotImplementedError

    def mark_poll_failed(self, shipment_id: str, at: int, error: str) -> None:
        """Record a failed poll: the status is left exactly as the state store has it."""
        raise NotImplementedError

    def stale_ids(self, before: int) -> list[str]:
        """Shipment ids with no successful poll since the given instant."""
        raise NotImplementedError


polls = PollStore()


def poll_health(shipment_id: str, now: int) -> dict:
    last_ok_at = polls.last_ok_at(shipment_id)
    stale = last_ok_at is None or now - last_ok_at > STALE_AFTER_S
    return {"stale": stale, "last_ok_at": last_ok_at, "failures": polls.failures(shipment_id)}


def stale_shipments(now: int) -> list[str]:
    """The shipments operations must look at: their carrier feed has gone quiet."""
    return polls.stale_ids(now - STALE_AFTER_S)


def schedule_retry(shipment_id: str, attempt: int, backoff_s: int) -> None:
    """Hand the next attempt to the scheduler instead of looping inside the request."""
    raise NotImplementedError


def poll_carrier(shipment_id: str) -> dict:
    now = int(time.time())
    try:
        reply = carriers.PollStatus(
            carriers_pb2.PollRequest(shipment_id=shipment_id), timeout=DEADLINE_S
        )
    except grpc.RpcError as exc:
        attempt = polls.failures(shipment_id) + 1
        backoff_s = BACKOFF_S[min(attempt, len(BACKOFF_S)) - 1]
        polls.mark_poll_failed(shipment_id, now, exc.details() or str(exc))
        schedule_retry(shipment_id, attempt, backoff_s)
        logger.warning(
            "poll failed shipment=%s attempt=%d backoff=%ds stale=%s",
            shipment_id,
            attempt,
            backoff_s,
            poll_health(shipment_id, now)["stale"],
        )
        return {"status": "unchanged", "poll": "failed", "retry_in_s": backoff_s}

    polls.mark_poll_ok(shipment_id, now)
    return {"status": reply.status, "carrier_ref": reply.carrier_ref}
`,
    },
    typescript: {
      starter: `/** Carrier polls: a model-generated draft with no deadline and a tight retry loop. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

interface PollReply {
  status: string;
  carrier_ref: string;
}

interface CarrierClient {
  PollStatus(
    request: {shipment_id: string},
    metadata: grpc.Metadata,
    options: {deadline?: number},
    callback: (error: grpc.ServiceError | null, reply: PollReply) => void,
  ): grpc.ClientUnaryCall;
}

const {carriers} = grpc.loadPackageDefinition(protoLoader.loadSync('carriers.proto')) as unknown as {
  carriers: {Carrier: new (target: string, credentials: grpc.ChannelCredentials) => CarrierClient};
};
const carrier = new carriers.Carrier('carriers:9000', grpc.credentials.createInsecure());

class PollStore {
  /** The status the state store last accepted for the shipment. */
  async currentStatus(shipmentId: string): Promise<string> {
    throw new Error('not implemented');
  }

  async writeStatus(shipmentId: string, status: string, at: number): Promise<void> {
    throw new Error('not implemented');
  }

  async markPollOk(shipmentId: string, at: number): Promise<void> {
    throw new Error('not implemented');
  }
}

const polls = new PollStore();

function pollOnce(client: CarrierClient, shipmentId: string): Promise<PollReply> {
  const {promise, resolve, reject} = Promise.withResolvers<PollReply>();
  client.PollStatus({shipment_id: shipmentId}, new grpc.Metadata(), {}, (error, reply) => {
    if (error !== null) reject(error);
    else resolve(reply);
  });
  return promise;
}

export async function pollCarrier(shipmentId: string): Promise<{status: string}> {
  // TODO: this draft has no deadline, retries the carrier in a tight loop inside the request, and
  // treats a failed poll as "still in transit" at the previous timestamp, so a stalled feed looks
  // healthy. Add the 4-second deadline, record the failure and its staleness instead of inventing
  // a status, and move the next attempt to the scheduler with a backoff.
  const current = await polls.currentStatus(shipmentId);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const reply = await pollOnce(carrier, shipmentId);
      await polls.markPollOk(shipmentId, Math.floor(Date.now() / 1000));
      return {status: reply.status};
    } catch {
      continue;
    }
  }
  await polls.writeStatus(shipmentId, current === '' ? 'in_transit' : current, Math.floor(Date.now() / 1000));
  return {status: current === '' ? 'in_transit' : current};
}
`,
      solution: `/** Carrier polls: 4-second deadline, failures recorded, retries handed to the scheduler. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const DEADLINE_MS = 4_000;
const STALE_AFTER_S = 900;
const BACKOFF_S = [30, 60, 120, 300, 900];

interface PollReply {
  status: string;
  carrier_ref: string;
}

interface CarrierClient {
  PollStatus(
    request: {shipment_id: string},
    metadata: grpc.Metadata,
    options: {deadline?: number},
    callback: (error: grpc.ServiceError | null, reply: PollReply) => void,
  ): grpc.ClientUnaryCall;
}

const {carriers} = grpc.loadPackageDefinition(protoLoader.loadSync('carriers.proto')) as unknown as {
  carriers: {Carrier: new (target: string, credentials: grpc.ChannelCredentials) => CarrierClient};
};
const carrier = new carriers.Carrier('carriers:9000', grpc.credentials.createInsecure());

class PollStore {
  /** Unix seconds of the last successful poll, or null when there never was one. */
  async lastOkAt(shipmentId: string): Promise<number | null> {
    throw new Error('not implemented');
  }

  /** Consecutive failed polls since the last success. */
  async failures(shipmentId: string): Promise<number> {
    throw new Error('not implemented');
  }

  async markPollOk(shipmentId: string, at: number): Promise<void> {
    throw new Error('not implemented');
  }

  /** Record a failed poll: the status is left exactly as the state store has it. */
  async markPollFailed(shipmentId: string, at: number, error: string): Promise<void> {
    throw new Error('not implemented');
  }

  /** Shipment ids with no successful poll since the given instant. */
  async staleIds(before: number): Promise<string[]> {
    throw new Error('not implemented');
  }
}

const polls = new PollStore();

export async function pollHealth(shipmentId: string, now: number): Promise<Record<string, unknown>> {
  const last_ok_at = await polls.lastOkAt(shipmentId);
  const stale = last_ok_at === null || now - last_ok_at > STALE_AFTER_S;
  return {stale, last_ok_at, failures: await polls.failures(shipmentId)};
}

export async function staleShipments(now: number): Promise<string[]> {
  return polls.staleIds(now - STALE_AFTER_S);
}

export function scheduleRetry(shipmentId: string, attempt: number, backoffS: number): void {
  // The tick picks the shipment up after backoffS instead of looping on the carrier here.
  void shipmentId;
  void attempt;
  void backoffS;
}

function pollOnce(client: CarrierClient, shipmentId: string): Promise<PollReply> {
  const {promise, resolve, reject} = Promise.withResolvers<PollReply>();
  client.PollStatus(
    {shipment_id: shipmentId},
    new grpc.Metadata(),
    {deadline: Date.now() + DEADLINE_MS},
    (error, reply) => {
      if (error !== null) reject(error);
      else resolve(reply);
    },
  );
  return promise;
}

export async function pollCarrier(shipmentId: string): Promise<Record<string, unknown>> {
  const now = Math.floor(Date.now() / 1000);
  try {
    const reply = await pollOnce(carrier, shipmentId);
    await polls.markPollOk(shipmentId, now);
    return {status: reply.status, carrier_ref: reply.carrier_ref};
  } catch (error) {
    const attempt = (await polls.failures(shipmentId)) + 1;
    const backoff_s = BACKOFF_S[Math.min(attempt, BACKOFF_S.length) - 1];
    await polls.markPollFailed(shipmentId, now, (error as grpc.ServiceError).details ?? String(error));
    scheduleRetry(shipmentId, attempt, backoff_s);
    const health = await pollHealth(shipmentId, now);
    return {status: 'unchanged', poll: 'failed', retry_in_s: backoff_s, stale: health.stale};
  }
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"time"

	pb "router/carrierspb"
)

type pollStore struct{}

// CurrentStatus returns the status the state store last accepted for the shipment.
func (s *pollStore) CurrentStatus(ctx context.Context, shipmentID string) (string, error) {
	return "", nil
}

func (s *pollStore) WriteStatus(ctx context.Context, shipmentID, status string, at int64) error {
	return nil
}

func (s *pollStore) MarkPollOk(ctx context.Context, shipmentID string, at int64) error {
	return nil
}

var polls = &pollStore{}

func pollCarrier(ctx context.Context, carrier pb.CarrierClient, shipmentID string) (string, error) {
	// TODO: this draft has no deadline, retries the carrier in a tight loop inside the request, and
	// treats a failed poll as "still in transit" at the previous timestamp, so a stalled feed looks
	// healthy. Add the 4-second deadline, record the failure and its staleness instead of inventing
	// a status, and move the next attempt to the scheduler with a backoff.
	current, _ := polls.CurrentStatus(ctx, shipmentID)
	for attempt := 0; attempt < 5; attempt++ {
		reply, err := carrier.PollStatus(ctx, &pb.PollRequest{ShipmentId: shipmentID})
		if err != nil {
			continue
		}
		_ = polls.MarkPollOk(ctx, shipmentID, time.Now().Unix())
		return reply.Status, nil
	}
	if current == "" {
		current = "in_transit"
	}
	_ = polls.WriteStatus(ctx, shipmentID, current, time.Now().Unix())
	return current, nil
}
`,
      solution: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc"

	pb "router/carrierspb"
)

const (
	deadlineMS  = 4000
	staleAfterS = 900
)

var backoffS = []int{30, 60, 120, 300, 900}

type pollHealthView struct {
	Stale    bool
	LastOKAt int64
	Failures int
}

type pollStore struct{}

// LastOKAt returns the unix seconds of the last successful poll, or 0 when there never was one.
func (s *pollStore) LastOKAt(ctx context.Context, shipmentID string) (int64, error) {
	return 0, nil
}

func (s *pollStore) Failures(ctx context.Context, shipmentID string) (int, error) {
	return 0, nil
}

func (s *pollStore) MarkPollOk(ctx context.Context, shipmentID string, at int64) error {
	return nil
}

// MarkPollFailed records a failed poll; the status is left exactly as the state store has it.
func (s *pollStore) MarkPollFailed(ctx context.Context, shipmentID string, at int64, error string) error {
	return nil
}

// StaleIDs returns the shipment ids with no successful poll since before.
func (s *pollStore) StaleIDs(ctx context.Context, before int64) ([]string, error) {
	return nil, nil
}

var polls = &pollStore{}

func pollHealth(ctx context.Context, shipmentID string, now int64) (pollHealthView, error) {
	lastOKAt, err := polls.LastOKAt(ctx, shipmentID)
	if err != nil {
		return pollHealthView{}, err
	}
	failures, err := polls.Failures(ctx, shipmentID)
	if err != nil {
		return pollHealthView{}, err
	}
	stale := lastOKAt == 0 || now-lastOKAt > staleAfterS
	return pollHealthView{Stale: stale, LastOKAt: lastOKAt, Failures: failures}, nil
}

func staleShipments(ctx context.Context, now int64) ([]string, error) {
	return polls.StaleIDs(ctx, now-staleAfterS)
}

// ScheduleRetry hands the next attempt to the scheduler instead of looping here.
func scheduleRetry(shipmentID string, attempt, backoff int) {
}

func pollCarrier(ctx context.Context, carrier pb.CarrierClient, shipmentID string, now int64) (string, error) {
	callCtx, cancel := context.WithTimeout(ctx, deadlineMS*time.Millisecond)
	defer cancel()
	reply, err := carrier.PollStatus(callCtx, &pb.PollRequest{ShipmentId: shipmentID})
	if err != nil {
		attempt, _ := polls.Failures(ctx, shipmentID)
		attempt++
		backoff := backoffS[min(attempt, len(backoffS))-1]
		_ = polls.MarkPollFailed(ctx, shipmentID, now, grpc.Code(err).String())
		scheduleRetry(shipmentID, attempt, backoff)
		return "unchanged", nil
	}
	if err := polls.MarkPollOk(ctx, shipmentID, now); err != nil {
		return "", err
	}
	return reply.Status, nil
}
`,
    },
    scala: {
      starter: `import io.grpc.ManagedChannelBuilder

object PollCarrier {
  val carrier = CarriersGrpc.blockingStub(ManagedChannelBuilder.forAddress("carriers", 9000).usePlaintext().build())

  /** The status the state store last accepted for the shipment. */
  def currentStatus(shipmentId: String): String = ""

  def writeStatus(shipmentId: String, status: String, at: Long): Unit = ()

  def markPollOk(shipmentId: String, at: Long): Unit = ()

  // TODO: this draft has no deadline, retries the carrier in a tight loop inside the request, and
  // treats a failed poll as "still in transit" at the previous timestamp, so a stalled feed looks
  // healthy. Add the 4-second deadline, record the failure and its staleness instead of inventing
  // a status, and move the next attempt to the scheduler with a backoff.
  def pollCarrier(shipmentId: String): String = {
    val current = currentStatus(shipmentId)
    var attempt = 0
    while (attempt < 5) {
      try {
        val reply = carrier.pollStatus(PollRequest(shipmentId = shipmentId))
        markPollOk(shipmentId, System.currentTimeMillis() / 1000)
        return reply.status
      } catch {
        case _: io.grpc.StatusRuntimeException => ()
      }
      attempt += 1
    }
    val fallback = if (current.isEmpty) "in_transit" else current
    writeStatus(shipmentId, fallback, System.currentTimeMillis() / 1000)
    fallback
  }
}
`,
      solution: `import io.grpc.ManagedChannelBuilder

import java.util.concurrent.TimeUnit

object PollCarrier {
  val DeadlineMs = 4000
  val StaleAfterS = 900L
  val BackoffS = List(30, 60, 120, 300, 900)

  val carrier = CarriersGrpc.blockingStub(ManagedChannelBuilder.forAddress("carriers", 9000).usePlaintext().build())

  /** Unix seconds of the last successful poll, or None when there never was one. */
  def lastOkAt(shipmentId: String): Option[Long] = None

  /** Consecutive failed polls since the last success. */
  def failures(shipmentId: String): Int = 0

  def markPollOk(shipmentId: String, at: Long): Unit = ()

  /** Record a failed poll; the status is left exactly as the state store has it. */
  def markPollFailed(shipmentId: String, at: Long, error: String): Unit = ()

  /** Shipment ids with no successful poll since before. */
  def staleIds(before: Long): List[String] = Nil

  def pollHealth(shipmentId: String, now: Long): (Boolean, Option[Long], Int) = {
    val lastOk = lastOkAt(shipmentId)
    val stale = lastOk.forall(now - _ > StaleAfterS)
    (stale, lastOk, failures(shipmentId))
  }

  def staleShipments(now: Long): List[String] = staleIds(now - StaleAfterS)

  /** Hand the next attempt to the scheduler instead of looping here. */
  def scheduleRetry(shipmentId: String, attempt: Int, backoff: Int): Unit = ()

  def pollCarrier(shipmentId: String): String = {
    val now = System.currentTimeMillis() / 1000
    try {
      val reply = carrier
        .withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS)
        .pollStatus(PollRequest(shipmentId = shipmentId))
      markPollOk(shipmentId, now)
      reply.status
    } catch {
      case exc: io.grpc.StatusRuntimeException =>
        val attempt = failures(shipmentId) + 1
        val backoff = BackoffS(math.min(attempt, BackoffS.size) - 1)
        markPollFailed(shipmentId, now, exc.getStatus.getDescription)
        scheduleRetry(shipmentId, attempt, backoff)
        "unchanged"
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include "carriers.grpc.pb.h"

#include <string>

struct PollStore {
  std::string currentStatus(const std::string& shipmentId);
  void writeStatus(const std::string& shipmentId, const std::string& status, long at);
  void markPollOk(const std::string& shipmentId, long at);
};

PollStore polls;

// TODO: this draft has no deadline, retries the carrier in a tight loop inside the request, and
// treats a failed poll as "still in transit" at the previous timestamp, so a stalled feed looks
// healthy. Add the 4-second deadline, record the failure and its staleness instead of inventing a
// status, and move the next attempt to the scheduler with a backoff.
std::string pollCarrier(Carrier::Stub* carrier, const std::string& shipmentId) {
  const auto current = polls.currentStatus(shipmentId);
  for (int attempt = 0; attempt < 5; ++attempt) {
    grpc::ClientContext ctx;
    PollRequest request;
    request.set_shipment_id(shipmentId);
    PollReply reply;
    if (carrier->PollStatus(&ctx, request, &reply).ok()) {
      polls.markPollOk(shipmentId, 0);
      return reply.status();
    }
  }
  const auto fallback = current.empty() ? std::string("in_transit") : current;
  polls.writeStatus(shipmentId, fallback, 0);
  return fallback;
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include "carriers.grpc.pb.h"

#include <algorithm>
#include <chrono>
#include <string>
#include <vector>

constexpr int kDeadlineMs = 4000;
constexpr long long kStaleAfterS = 900;
const std::vector<int> kBackoffS = {30, 60, 120, 300, 900};

struct PollStore {
  /** Unix seconds of the last successful poll, or 0 when there never was one. */
  long long last_ok_at(const std::string& shipmentId);
  /** Consecutive failed polls since the last success. */
  int failures(const std::string& shipmentId);
  void markPollOk(const std::string& shipmentId, long long at);
  /** Record a failed poll; the status is left exactly as the state store has it. */
  void markPollFailed(const std::string& shipmentId, long long at, const std::string& error);
  /** Shipment ids with no successful poll since before. */
  std::vector<std::string> staleIds(long long before);
};

PollStore polls;

long long nowSeconds() {
  return std::chrono::duration_cast<std::chrono::seconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

bool pollHealth(const std::string& shipmentId, long long now, bool* stale, long long* lastOk, int* failures) {
  *lastOk = polls.last_ok_at(shipmentId);
  *failures = polls.failures(shipmentId);
  *stale = *lastOk == 0 || now - *lastOk > kStaleAfterS;
  return true;
}

std::vector<std::string> staleShipments(long long now) {
  return polls.staleIds(now - kStaleAfterS);
}

/** Hand the next attempt to the scheduler instead of looping here. */
void scheduleRetry(const std::string& shipmentId, int attempt, int backoff) {
  (void)shipmentId;
  (void)attempt;
  (void)backoff;
}

std::string pollCarrier(Carrier::Stub* carrier, const std::string& shipmentId) {
  const auto now = nowSeconds();
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kDeadlineMs));
  PollRequest request;
  request.set_shipment_id(shipmentId);
  PollReply reply;
  const grpc::Status status = carrier->PollStatus(&ctx, request, &reply);
  if (status.ok()) {
    polls.markPollOk(shipmentId, now);
    return reply.status();
  }
  const int attempt = polls.failures(shipmentId) + 1;
  const int backoff = kBackoffS[std::min<std::size_t>(attempt, kBackoffS.size()) - 1];
  polls.markPollFailed(shipmentId, now, status.error_message());
  scheduleRetry(shipmentId, attempt, backoff);
  return "unchanged";
}
`,
    },
  },
  debrief: `The interviewer is probing one question under many names: what does this code do when the carrier stops answering? A deadline bounds one attempt, a recorded failure keeps the failure visible, staleness turns "no successful poll for fifteen minutes" into something operations can query, and the scheduler keeps the retry off the request path so a carrier outage cannot be amplified by the callers waiting on it. The subtle defect is the invented status: mapping a failure to the previous status with the previous timestamp destroys the only evidence that anything is wrong, and the shipment then looks healthy for exactly as long as the outage lasts. Real pollers add jittered backoff, per-carrier concurrency limits, and a reconciliation job that compares the carrier's own scan history with what the state store recorded.`,
};
