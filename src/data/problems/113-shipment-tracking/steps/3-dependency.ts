import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Carrier polls with a deadline, recorded failures and scheduled retries',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'carrier', 'scheduler'],
  task: `## Task

**Starting point.** The starter is the poll the scheduler runs per shipment:
\`poll_shipment(shipment_id, attempt)\` calls the carrier gateway's \`PollStatus\` (gRPC, no
deadline) up to five times in a loop with a one-second sleep, calls \`store.mark_poll_ok\`,
schedules the next routine poll (\`store.schedule_poll\`, \`POLL_INTERVAL_S\`), writes the carrier's
status with \`store.set_status\` and answers \`{"polled", "status"}\`. It serves the demo and hides
four flaws.

**Failure mode the checks target.** One hung carrier pins a worker; a carrier down since morning
looks like a parcel sitting at a depot, since nothing goes stale; the retry loop adds load to a
carrier that cannot answer; a stale carrier answer rolls the status backward.

- Every \`PollStatus\` carries a **4-second deadline** (\`DEADLINE_S = 4\`).
- A failed poll writes no status: \`store.mark_poll_failed(shipment_id, now, details)\` with the
  carrier's error message, then \`store.schedule_poll(shipment_id, now + backoff_s(attempt))\`
  with \`backoff_s(attempt) = min(30 * 2**attempt, 1800)\`, and one call per poll.
- A good poll goes through \`apply_scan\` (\`shipments.timeline\`, step 2), then \`mark_poll_ok\` and
  the routine \`schedule_poll\`.`,
  sequence: {
    participants: ['Poll scheduler', 'Shipment API', 'Carrier gateway', 'Redis'],
    messages: [
      {from: 'Poll scheduler', to: 'Shipment API', label: 'poll_shipment(shp_1, attempt 2)', kind: 'sync'},
      {from: 'Shipment API', to: 'Carrier gateway', label: 'PollStatus · deadline 4 s', kind: 'sync'},
      {
        from: 'Carrier gateway',
        to: 'Shipment API',
        label: 'UNAVAILABLE · "carrier gateway unreachable"',
        kind: 'reply',
      },
      {from: 'Shipment API', to: 'Redis', label: 'mark_poll_failed · no status written', kind: 'sync'},
      {from: 'Shipment API', to: 'Redis', label: 'schedule_poll(now + 120 s)', kind: 'sync'},
      {from: 'Poll scheduler', to: 'Shipment API', label: 'poll_shipment(shp_1, attempt 3)', kind: 'sync'},
      {from: 'Carrier gateway', to: 'Shipment API', label: 'CarrierScan{in_transit, Leeds}', kind: 'reply'},
      {
        from: 'Shipment API',
        to: 'Redis',
        label: 'apply_scan · mark_poll_ok · schedule_poll(now + 3600 s)',
        kind: 'sync',
      },
    ],
  },
  hints: [
    'Take the carrier gateway down: every shipment on it keeps a fresh poll time and never shows stale, the poll takes seconds of retries, and a stale carrier answer moves an out-for-delivery parcel back to in transit.',
    'The call has no deadline, the loop retries inside the request, `mark_poll_ok` runs whether or not the carrier answered, and `set_status` writes whatever the carrier said, bypassing the forward-only apply.',
    'One call with `timeout=DEADLINE_S`; on `RpcError`: `mark_poll_failed(id, now, details)`, `schedule_poll(id, now + backoff_s(attempt))`, return. On success: `apply_scan`, `mark_poll_ok`, `schedule_poll(id, now + POLL_INTERVAL_S)`.',
  ],
  checks: [
    {
      id: 'deadline',
      title: 'Every poll carries a 4-second deadline',
      detail:
        'The `PollStatus` call is made with a 4-second deadline; without one a carrier that stops answering holds the poll, and the worker running it, open.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*4\b/, /timeout\s*=\s*DEADLINE_S/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*4_?000\b/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/]},
        go: {all: [/deadline\s*=\s*4\s*\*\s*time\.Second/, /context\.WithTimeout\(/]},
        scala: {all: [/DeadlineSeconds\s*=\s*4L?\b/, /withDeadlineAfter\(/]},
        cpp: {all: [/kDeadline\{4\}|kDeadline\s*=\s*std::chrono::seconds\{?\(?4/, /set_deadline\(/]},
      },
    },
    {
      id: 'failure-recorded',
      title: 'Records a failed poll instead of calling it fresh',
      detail:
        'A failed poll records `mark_poll_failed` with the carrier error and never calls `mark_poll_ok`, so the shipment goes stale after `STALE_AFTER_S` and operations see the error.',
      match: {
        python: {all: [/store\.mark_poll_failed\(/], order: [/except\s+grpc\.RpcError/, /store\.mark_poll_failed\(/]},
        typescript: {all: [/store\.markPollFailed\(/], order: [/catch\s*\(/, /store\.markPollFailed\(/]},
        go: {all: [/store\.MarkPollFailed\(/], order: [/if\s+err\s*!=\s*nil/, /store\.MarkPollFailed\(/]},
        scala: {
          all: [/Store\.markPollFailed\(/],
          order: [/case\s+e:\s*StatusRuntimeException/, /Store\.markPollFailed\(/],
        },
        cpp: {all: [/store::markPollFailed\(/], order: [/!status\.ok\(\)/, /store::markPollFailed\(/]},
      },
    },
    {
      id: 'scheduler',
      title: 'Hands the retry to the scheduler with a backoff',
      detail:
        'One call per poll: a failure schedules the next attempt at `now + backoff_s(attempt)` (30 s doubling, at most 1800 s) instead of sleeping and calling again inside the poll.',
      match: {
        python: {all: [/backoff/i, /store\.schedule_poll\(/], none: [/time\.sleep\(/, /for\s+_?\w*\s+in\s+range\(/]},
        typescript: {all: [/backoff/i, /store\.schedulePoll\(/], none: [/setTimeout\(/, /for\s*\(\s*let\s+attempt/]},
        go: {all: [/backoff/i, /store\.SchedulePoll\(/], none: [/time\.Sleep\(/, /for\s+try\s*:=/]},
        scala: {all: [/backoff/i, /Store\.schedulePoll\(/], none: [/Thread\.sleep\(/]},
        cpp: {all: [/backoff/i, /store::schedulePoll\(/], none: [/sleep_for\(/]},
      },
    },
    {
      id: 'apply-through-state',
      title: "Applies the carrier's answer through the forward-only apply",
      detail:
        "The carrier's scan goes through `apply_scan` (step 2), never `set_status`: a carrier answer older than the status the shipment holds is dropped and recorded, not written.",
      match: {
        python: {all: [/apply_scan\(/], none: [/store\.set_status\(/]},
        typescript: {all: [/applyScan\(/], none: [/store\.setStatus\(/]},
        go: {all: [/timeline\.ApplyScan\(/], none: [/store\.SetStatus\(/]},
        scala: {all: [/Timeline\.applyScan\(/], none: [/Store\.setStatus\(/]},
        cpp: {all: [/timeline::applyScan\(/], none: [/store::setStatus\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import grpc

import shipment_tracking_pb2
import shipment_tracking_pb2_grpc
from shipments import store  # store.get_shipment, set_status, mark_poll_ok, mark_poll_failed, schedule_poll
from shipments.timeline import apply_scan

POLL_INTERVAL_S = 3600

carrier = shipment_tracking_pb2_grpc.CarrierGatewayStub(grpc.insecure_channel("carriers:9000"))


def poll_shipment(shipment_id: str, attempt: int = 0) -> dict:
    """One poll of the carrier for the shipment; the scheduler runs it again when it is next due."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    shipment = store.get_shipment(shipment_id)
    now = int(time.time())
    request = shipment_tracking_pb2.PollRequest(carrier=shipment["carrier"], shipment_id=shipment_id)
    scan = None
    for _ in range(5):
        try:
            scan = carrier.PollStatus(request)
            break
        except grpc.RpcError:
            time.sleep(1)
    store.mark_poll_ok(shipment_id, now)
    store.schedule_poll(shipment_id, now + POLL_INTERVAL_S)
    if scan is None:
        return {"polled": False, "status": shipment["status"]}
    store.set_status(shipment_id, scan.status, scan.scan_at)
    return {"polled": True, "status": scan.status}
`,
      solution: `import time

import grpc

import shipment_tracking_pb2
import shipment_tracking_pb2_grpc
from shipments import store  # store.get_shipment, set_status, mark_poll_ok, mark_poll_failed, schedule_poll
from shipments.timeline import apply_scan

DEADLINE_S = 4
POLL_INTERVAL_S = 3600
BACKOFF_BASE_S = 30
BACKOFF_MAX_S = 1800

carrier = shipment_tracking_pb2_grpc.CarrierGatewayStub(grpc.insecure_channel("carriers:9000"))


def backoff_s(attempt: int) -> int:
    return min(BACKOFF_BASE_S * 2**attempt, BACKOFF_MAX_S)


def poll_shipment(shipment_id: str, attempt: int = 0) -> dict:
    """One poll of the carrier for the shipment; the scheduler runs it again when it is next due."""
    shipment = store.get_shipment(shipment_id)
    now = int(time.time())
    request = shipment_tracking_pb2.PollRequest(carrier=shipment["carrier"], shipment_id=shipment_id)
    try:
        scan = carrier.PollStatus(request, timeout=DEADLINE_S)
    except grpc.RpcError as exc:
        # A failed poll says nothing about the parcel: record it, write no status, let the scheduler retry.
        store.mark_poll_failed(shipment_id, now, exc.details() or exc.code().name)
        store.schedule_poll(shipment_id, now + backoff_s(attempt))
        return {"polled": False, "status": shipment["status"]}
    result = apply_scan(shipment_id, scan.status, scan.scan_at, scan.city)
    store.mark_poll_ok(shipment_id, now)
    store.schedule_poll(shipment_id, now + POLL_INTERVAL_S)
    return {"polled": True, "status": result["status"]}
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import * as store from 'shipments/store'; // store.getShipment, setStatus, markPollOk, markPollFailed, schedulePoll
import {applyScan} from 'shipments/timeline';

export const POLL_INTERVAL_S = 3600;

interface CarrierScan {
  status: string;
  scan_at: number | string;
  city: string;
  carrier_ref: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('shipment_tracking.proto')) as unknown as {
  shiptrack: {CarrierGateway: grpc.ServiceClientConstructor};
};
const carrier = new pkg.shiptrack.CarrierGateway('carriers:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  PollStatus(request: {carrier: string; shipment_id: string}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<CarrierScan>;
};

/** One poll of the carrier for the shipment; the scheduler runs it again when it is next due. */
export async function pollShipment(shipmentId: string, attempt = 0): Promise<{polled: boolean; status: string}> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const shipment = await store.getShipment(shipmentId);
  if (shipment === null) throw new Error(\`no shipment \${shipmentId}\`);
  const now = Math.floor(Date.now() / 1000);
  let scan: CarrierScan | null = null;
  for (let tries = 0; tries < 5 && scan === null; tries++) {
    try {
      scan = await carrier.PollStatus({carrier: shipment.carrier, shipment_id: shipmentId}, new grpc.Metadata(), {});
    } catch {
      const pause = Promise.withResolvers<void>();
      setTimeout(pause.resolve, 1000);
      await pause.promise;
    }
  }
  await store.markPollOk(shipmentId, now);
  await store.schedulePoll(shipmentId, now + POLL_INTERVAL_S);
  if (scan === null) return {polled: false, status: shipment.status};
  await store.setStatus(shipmentId, scan.status, Number(scan.scan_at));
  return {polled: true, status: scan.status};
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import * as store from 'shipments/store'; // store.getShipment, setStatus, markPollOk, markPollFailed, schedulePoll
import {applyScan} from 'shipments/timeline';

export const DEADLINE_MS = 4000;
export const POLL_INTERVAL_S = 3600;
const BACKOFF_BASE_S = 30;
const BACKOFF_MAX_S = 1800;

interface CarrierScan {
  status: string;
  scan_at: number | string;
  city: string;
  carrier_ref: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('shipment_tracking.proto')) as unknown as {
  shiptrack: {CarrierGateway: grpc.ServiceClientConstructor};
};
const carrier = new pkg.shiptrack.CarrierGateway('carriers:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  PollStatus(request: {carrier: string; shipment_id: string}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<CarrierScan>;
};

export const backoffS = (attempt: number): number => Math.min(BACKOFF_BASE_S * 2 ** attempt, BACKOFF_MAX_S);

/** One poll of the carrier for the shipment; the scheduler runs it again when it is next due. */
export async function pollShipment(shipmentId: string, attempt = 0): Promise<{polled: boolean; status: string}> {
  const shipment = await store.getShipment(shipmentId);
  if (shipment === null) throw new Error(\`no shipment \${shipmentId}\`);
  const now = Math.floor(Date.now() / 1000);
  let scan: CarrierScan;
  try {
    scan = await carrier.PollStatus({carrier: shipment.carrier, shipment_id: shipmentId}, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
  } catch (e) {
    // A failed poll says nothing about the parcel: record it, write no status, let the scheduler retry.
    const {code, details} = e as grpc.ServiceError;
    await store.markPollFailed(shipmentId, now, details || grpc.status[code]);
    await store.schedulePoll(shipmentId, now + backoffS(attempt));
    return {polled: false, status: shipment.status};
  }
  const result = await applyScan(shipmentId, scan.status, Number(scan.scan_at), scan.city);
  await store.markPollOk(shipmentId, now);
  await store.schedulePoll(shipmentId, now + POLL_INTERVAL_S);
  return {polled: true, status: result.status};
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

	pb "shipments/gen/shipment_tracking"
	"shipments/store" // store.GetShipment, SetStatus, MarkPollOK, MarkPollFailed, SchedulePoll; the forward-only apply: timeline.ApplyScan in "shipments/timeline"
)

const pollIntervalS = 3600

var (
	carrierConn, _ = grpc.NewClient("carriers:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	carrier        = pb.NewCarrierGatewayClient(carrierConn)
)

// PollResult is what one poll did.
type PollResult struct {
	Polled bool   \`json:"polled"\`
	Status string \`json:"status"\`
}

// pollShipment is one poll of the carrier for the shipment; the scheduler runs it again when it is next due.
func pollShipment(ctx context.Context, shipmentID string, attempt int) (PollResult, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	shipment := store.GetShipment(ctx, shipmentID)
	now := time.Now().Unix()
	var scan *pb.CarrierScan
	for try := 0; try < 5; try++ {
		got, err := carrier.PollStatus(ctx, &pb.PollRequest{Carrier: shipment.Carrier, ShipmentId: shipmentID})
		if err == nil {
			scan = got
			break
		}
		time.Sleep(time.Second)
	}
	store.MarkPollOK(ctx, shipmentID, now)
	store.SchedulePoll(ctx, shipmentID, now+pollIntervalS)
	if scan == nil {
		return PollResult{Polled: false, Status: shipment.Status}, nil
	}
	store.SetStatus(ctx, shipmentID, scan.GetStatus(), scan.GetScanAt())
	return PollResult{Polled: true, Status: scan.GetStatus()}, nil
}
`,
      solution: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "shipments/gen/shipment_tracking"
	"shipments/store"    // store.GetShipment, SetStatus, MarkPollOK, MarkPollFailed, SchedulePoll
	"shipments/timeline" // timeline.ApplyScan
)

const (
	deadline      = 4 * time.Second
	pollIntervalS = 3600
	backoffBaseS  = 30
	backoffMaxS   = 1800
)

var (
	carrierConn, _ = grpc.NewClient("carriers:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	carrier        = pb.NewCarrierGatewayClient(carrierConn)
)

// PollResult is what one poll did.
type PollResult struct {
	Polled bool   \`json:"polled"\`
	Status string \`json:"status"\`
}

func backoffS(attempt int) int64 {
	wait := int64(backoffBaseS)
	for i := 0; i < attempt && wait < backoffMaxS; i++ {
		wait *= 2
	}
	return min(wait, backoffMaxS)
}

// pollShipment is one poll of the carrier for the shipment; the scheduler runs it again when it is next due.
func pollShipment(ctx context.Context, shipmentID string, attempt int) (PollResult, error) {
	shipment := store.GetShipment(ctx, shipmentID)
	now := time.Now().Unix()
	callCtx, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()
	scan, err := carrier.PollStatus(callCtx, &pb.PollRequest{Carrier: shipment.Carrier, ShipmentId: shipmentID})
	if err != nil {
		// A failed poll says nothing about the parcel: record it, write no status, let the scheduler retry.
		store.MarkPollFailed(ctx, shipmentID, now, status.Convert(err).Message())
		store.SchedulePoll(ctx, shipmentID, now+backoffS(attempt))
		return PollResult{Polled: false, Status: shipment.Status}, nil
	}
	result, err := timeline.ApplyScan(ctx, shipmentID, scan.GetStatus(), scan.GetScanAt(), scan.GetCity())
	if err != nil {
		return PollResult{}, err
	}
	store.MarkPollOK(ctx, shipmentID, now)
	store.SchedulePoll(ctx, shipmentID, now+pollIntervalS)
	return PollResult{Polled: true, Status: result.Status}, nil
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import shipments.{Store, Timeline} // Store.getShipment, setStatus, markPollOk, markPollFailed, schedulePoll; Timeline.applyScan
import shiptrack.shipment_tracking.{CarrierGatewayGrpc, CarrierScan, PollRequest}

object Client {
  final case class PollResult(polled: Boolean, status: String)

  val PollIntervalS = 3600L

  private val carrier = CarrierGatewayGrpc.blockingStub(ManagedChannelBuilder.forAddress("carriers", 9000).usePlaintext().build())

  /** One poll of the carrier for the shipment; the scheduler runs it again when it is next due. */
  def pollShipment(shipmentId: String, attempt: Int = 0): PollResult = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val shipment = Store.getShipment(shipmentId).getOrElse(throw new NoSuchElementException(s"no shipment $shipmentId"))
    val now = System.currentTimeMillis() / 1000
    var scan: Option[CarrierScan] = None
    var tries = 0
    while (scan.isEmpty && tries < 5) {
      tries += 1
      try scan = Some(carrier.pollStatus(PollRequest(shipment.carrier, shipmentId)))
      catch { case _: StatusRuntimeException => Thread.sleep(1000) }
    }
    Store.markPollOk(shipmentId, now)
    Store.schedulePoll(shipmentId, now + PollIntervalS)
    scan match {
      case None => PollResult(polled = false, shipment.status)
      case Some(s) =>
        Store.setStatus(shipmentId, s.status, s.scanAt)
        PollResult(polled = true, s.status)
    }
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import shipments.{Store, Timeline} // Store.getShipment, setStatus, markPollOk, markPollFailed, schedulePoll; Timeline.applyScan
import shiptrack.shipment_tracking.{CarrierGatewayGrpc, PollRequest}

object Client {
  final case class PollResult(polled: Boolean, status: String)

  val DeadlineSeconds = 4L
  val PollIntervalS = 3600L
  val BackoffBaseS = 30L
  val BackoffMaxS = 1800L

  private val carrier = CarrierGatewayGrpc.blockingStub(ManagedChannelBuilder.forAddress("carriers", 9000).usePlaintext().build())

  def backoffS(attempt: Int): Long = math.min(BackoffBaseS << math.min(attempt, 16), BackoffMaxS)

  /** One poll of the carrier for the shipment; the scheduler runs it again when it is next due. */
  def pollShipment(shipmentId: String, attempt: Int = 0): PollResult = {
    val shipment = Store.getShipment(shipmentId).getOrElse(throw new NoSuchElementException(s"no shipment $shipmentId"))
    val now = System.currentTimeMillis() / 1000
    try {
      val scan = carrier.withDeadlineAfter(DeadlineSeconds, TimeUnit.SECONDS).pollStatus(PollRequest(shipment.carrier, shipmentId))
      val result = Timeline.applyScan(shipmentId, scan.status, scan.scanAt, scan.city)
      Store.markPollOk(shipmentId, now)
      Store.schedulePoll(shipmentId, now + PollIntervalS)
      PollResult(polled = true, result.status)
    } catch {
      // A failed poll says nothing about the parcel: record it, write no status, let the scheduler retry.
      case e: StatusRuntimeException =>
        Store.markPollFailed(shipmentId, now, Option(e.getStatus.getDescription).getOrElse(e.getStatus.getCode.toString))
        Store.schedulePoll(shipmentId, now + backoffS(attempt))
        PollResult(polled = false, shipment.status)
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>

#include "shipment_tracking.grpc.pb.h"
#include "shipments/store.h"     // store::getShipment, setStatus, markPollOk, markPollFailed, schedulePoll
#include "shipments/timeline.h"  // timeline::applyScan

constexpr long kPollIntervalS = 3600;

auto carrier = shiptrack::CarrierGateway::NewStub(grpc::CreateChannel("carriers:9000", grpc::InsecureChannelCredentials()));

struct PollResult {
  bool polled = false;
  std::string status;
};

long now_seconds() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

// One poll of the carrier for the shipment; the scheduler runs it again when it is next due.
PollResult pollShipment(const std::string& shipment_id, int attempt) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const auto shipment = store::getShipment(shipment_id);
  if (!shipment) throw std::out_of_range("no shipment " + shipment_id);
  const long now = now_seconds();
  shiptrack::PollRequest request;
  request.set_carrier(shipment->carrier);
  request.set_shipment_id(shipment_id);
  std::optional<shiptrack::CarrierScan> scan;
  for (int tries = 0; tries < 5 && !scan; tries++) {
    grpc::ClientContext ctx;
    shiptrack::CarrierScan got;
    if (carrier->PollStatus(&ctx, request, &got).ok()) {
      scan = got;
    } else {
      std::this_thread::sleep_for(std::chrono::seconds{1});
    }
  }
  store::markPollOk(shipment_id, now);
  store::schedulePoll(shipment_id, now + kPollIntervalS);
  if (!scan) return PollResult{false, shipment->status};
  store::setStatus(shipment_id, scan->status(), scan->scan_at());
  return PollResult{true, scan->status()};
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <algorithm>
#include <chrono>
#include <stdexcept>
#include <string>

#include "shipment_tracking.grpc.pb.h"
#include "shipments/store.h"     // store::getShipment, setStatus, markPollOk, markPollFailed, schedulePoll
#include "shipments/timeline.h"  // timeline::applyScan

constexpr std::chrono::seconds kDeadline{4};
constexpr long kPollIntervalS = 3600;
constexpr long kBackoffBaseS = 30;
constexpr long kBackoffMaxS = 1800;

auto carrier = shiptrack::CarrierGateway::NewStub(grpc::CreateChannel("carriers:9000", grpc::InsecureChannelCredentials()));

struct PollResult {
  bool polled = false;
  std::string status;
};

long now_seconds() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

long backoffS(int attempt) { return std::min(kBackoffBaseS << std::min(attempt, 16), kBackoffMaxS); }

// One poll of the carrier for the shipment; the scheduler runs it again when it is next due.
PollResult pollShipment(const std::string& shipment_id, int attempt) {
  const auto shipment = store::getShipment(shipment_id);
  if (!shipment) throw std::out_of_range("no shipment " + shipment_id);
  const long now = now_seconds();
  shiptrack::PollRequest request;
  request.set_carrier(shipment->carrier);
  request.set_shipment_id(shipment_id);
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
  shiptrack::CarrierScan scan;
  const grpc::Status status = carrier->PollStatus(&ctx, request, &scan);
  if (!status.ok()) {
    // A failed poll says nothing about the parcel: record it, write no status, let the scheduler retry.
    store::markPollFailed(shipment_id, now, status.error_message());
    store::schedulePoll(shipment_id, now + backoffS(attempt));
    return PollResult{false, shipment->status};
  }
  const timeline::Result result = timeline::applyScan(shipment_id, scan.status(), scan.scan_at(), scan.city());
  store::markPollOk(shipment_id, now);
  store::schedulePoll(shipment_id, now + kPollIntervalS);
  return PollResult{true, result.status};
}
`,
    },
  },
  harness: {
    python: `import time

import grpc

import shipment_tracking_pb2
import shipment_tracking_pb2_grpc
from shipments import store

SHIP = "shp_1"
DOWN = "carrier gateway unreachable"


class Carrier(shipment_tracking_pb2_grpc.CarrierGatewayServicer):
    """Answers the scan in self.scan for every shipment."""

    def __init__(self):
        self.scan = ("in_transit", 100, "Memphis")

    def PollStatus(self, request, context):
        status, at, city = self.scan
        return shipment_tracking_pb2.CarrierScan(status=status, scan_at=at, city=city, carrier_ref="1Z999")


def _client(ctx, status="label"):
    carrier = Carrier()
    ctx.grpc.serve(shipment_tracking_pb2_grpc.add_CarrierGatewayServicer_to_server, carrier)
    store.save({"shipment_id": SHIP, "tenant_id": "t-acme", "order_id": "ord_1", "carrier": "ups", "service_level": "ground", "status": status, "replacement_of": "", "created_at": int(time.time())})
    return ctx.load("client"), carrier


def _due(ctx):
    score = ctx.redis.zscore("poll:due", SHIP)
    return None if score is None else int(score)


def check_deadline(ctx):
    m, _ = _client(ctx)
    assert m.poll_shipment(SHIP, 0).get("polled") is True, "with the carrier answering, the poll must succeed"
    calls = ctx.grpc.calls_to("PollStatus")
    assert calls, "no PollStatus call was made"
    for call in calls:
        assert call.timeout is not None, "PollStatus carries no deadline: a carrier that stops answering holds the poll open"
        assert 3.5 <= call.timeout <= 4.5, f"PollStatus carries a {call.timeout} s deadline, expected DEADLINE_S = 4"
    ctx.grpc.set_latency("PollStatus", 30.0)
    started = time.time()
    result = m.poll_shipment(SHIP, 0)
    assert result.get("polled") is False, f"a carrier slower than the deadline must fail the poll, got {result}"
    assert time.time() - started <= 5, f"a poll of a carrier that takes 30 s held on for {time.time() - started:.0f} s"


def check_failure_recorded(ctx):
    m, _ = _client(ctx)
    ctx.clock.advance(1000)
    ctx.grpc.fail("PollStatus", grpc.StatusCode.UNAVAILABLE, DOWN, times=10)
    result = m.poll_shipment(SHIP, 0)
    assert result.get("polled") is False, f"a poll the carrier refused must answer polled False, got {result}"
    health = store.poll_health(SHIP, int(time.time()))
    assert health["last_ok_at"] == 0, f"a failed poll recorded a good one at {health['last_ok_at']}: the feed must go stale, not look fresh"
    assert health["failures"] >= 1 and health["last_error"] == DOWN, f"a failed poll must record the failure and the carrier's error ({DOWN!r}), poll health is {health}"
    assert health["stale"] is True, f"1000 s after the label with no good poll the shipment must be stale (STALE_AFTER_S = 900), poll health is {health}"
    assert store.get_shipment(SHIP)["status"] == "label", f"a failed poll wrote status {store.get_shipment(SHIP)['status']}"
    ctx.grpc.failures.clear()
    assert m.poll_shipment(SHIP, 1).get("polled") is True, "once the carrier answers again the poll must succeed"
    health = store.poll_health(SHIP, int(time.time()))
    assert health["failures"] == 0 and health["stale"] is False, f"a good poll must reset the failures and the staleness, poll health is {health}"


def check_scheduler(ctx):
    m, _ = _client(ctx)
    ctx.grpc.fail("PollStatus", grpc.StatusCode.UNAVAILABLE, DOWN, times=1)
    now = int(time.time())
    m.poll_shipment(SHIP, 0)
    calls = len(ctx.grpc.calls_to("PollStatus"))
    assert calls == 1, f"one poll made {calls} PollStatus calls: a failure is retried by the scheduler, not inside the poll"
    assert ctx.clock.sleeps == 0, f"the poll slept {ctx.clock.sleeps} times: a worker must not wait on a carrier that is down"
    assert _due(ctx) == now + 30, f"after a failed attempt 0 the next poll is due at {_due(ctx)}, expected now + 30 s ({now + 30})"
    for attempt, wait in ((3, 240), (10, 1800)):
        ctx.grpc.fail("PollStatus", grpc.StatusCode.UNAVAILABLE, DOWN, times=1)
        now = int(time.time())
        m.poll_shipment(SHIP, attempt)
        assert _due(ctx) == now + wait, f"after a failed attempt {attempt} the next poll is due {_due(ctx) - now} s out, expected {wait} s (30 s doubling, at most 1800 s)"
    now = int(time.time())
    m.poll_shipment(SHIP, 0)
    assert _due(ctx) == now + 3600, f"after a good poll the next one is due {_due(ctx) - now} s out, expected the routine POLL_INTERVAL_S = 3600"


def check_apply_through_state(ctx):
    m, carrier = _client(ctx, "out_for_delivery")
    carrier.scan = ("in_transit", 500, "Leeds")
    result = m.poll_shipment(SHIP, 0)
    status = store.get_shipment(SHIP)["status"]
    assert status == "out_for_delivery", f"the carrier answered an in_transit scan for a shipment out for delivery and the poll wrote {status}: the answer goes through apply_scan, which drops it"
    assert result.get("status") == "out_for_delivery", f"the poll must answer the status the shipment holds, got {result}"
    assert store.rejects(SHIP) == ["out_for_delivery->in_transit"], f"the dropped answer must be recorded, rejects are {store.rejects(SHIP)}"
    carrier.scan = ("delivered", 600, "Leeds")
    m.poll_shipment(SHIP, 0)
    assert store.get_shipment(SHIP)["status"] == "delivered", f"a delivered answer must apply, the shipment reads {store.get_shipment(SHIP)['status']}"
    assert [s["status"] for s in store.scans(SHIP)] == ["delivered"], f"the applied scan must join the timeline, scans are {store.scans(SHIP)}"
`,
    typescript: `const SHIP = 'shp_1';
const DOWN = 'carrier gateway unreachable';

async function client(ctx, status = 'label') {
  const pkg = ctx.proto('shipment_tracking.proto');
  const carrier = {scan: ['in_transit', 100, 'Memphis'] as [string, number, string]};
  ctx.grpc.serve(pkg.shiptrack.CarrierGateway.service, {
    PollStatus(_call, callback) {
      const [s, at, city] = carrier.scan;
      callback(null, {status: s, scan_at: at, city, carrier_ref: '1Z999'});
    },
  });
  const store = ctx.load('/support/shipments/store.ts');
  await store.save({shipment_id: SHIP, tenant_id: 't-acme', order_id: 'ord_1', carrier: 'ups', service_level: 'ground', status, replacement_of: '', created_at: Math.floor(Date.now() / 1000)});
  return {m: ctx.load('client'), carrier, store};
}

const nowS = (): number => Math.floor(Date.now() / 1000);

function due(ctx): number | null {
  const score = ctx.redis.zscore('poll:due', SHIP);
  return score === null ? null : Number(score);
}

export async function check_deadline(ctx) {
  const {m} = await client(ctx);
  assert.equal((await m.pollShipment(SHIP, 0)).polled, true, 'with the carrier answering, the poll must succeed');
  const calls = ctx.grpc.callsTo('PollStatus');
  assert(calls.length > 0, 'no PollStatus call was made');
  for (const call of calls) {
    assert(call.timeout !== null, 'PollStatus carries no deadline: a carrier that stops answering holds the poll open');
    assert(3.5 <= call.timeout && call.timeout <= 4.5, \`PollStatus carries a \${call.timeout} s deadline, expected DEADLINE_MS = 4000\`);
  }
  ctx.grpc.setLatency('PollStatus', 30.0);
  const started = Date.now();
  const result = await m.pollShipment(SHIP, 0);
  assert.equal(result.polled, false, \`a carrier slower than the deadline must fail the poll, got \${JSON.stringify(result)}\`);
  assert(Date.now() - started <= 5000, \`a poll of a carrier that takes 30 s held on for \${(Date.now() - started) / 1000} s\`);
}

export async function check_failure_recorded(ctx) {
  const {m, store} = await client(ctx);
  ctx.clock.advance(1000);
  ctx.grpc.fail('PollStatus', ctx.grpc.status.UNAVAILABLE, DOWN, 10);
  const result = await m.pollShipment(SHIP, 0);
  assert.equal(result.polled, false, \`a poll the carrier refused must answer polled false, got \${JSON.stringify(result)}\`);
  let health = await store.pollHealth(SHIP, nowS());
  assert.equal(health.last_ok_at, 0, \`a failed poll recorded a good one at \${health.last_ok_at}: the feed must go stale, not look fresh\`);
  assert(health.failures >= 1 && health.last_error === DOWN, \`a failed poll must record the failure and the carrier's error (\${DOWN}), poll health is \${JSON.stringify(health)}\`);
  assert.equal(health.stale, true, \`1000 s after the label with no good poll the shipment must be stale (STALE_AFTER_S = 900), poll health is \${JSON.stringify(health)}\`);
  assert.equal((await store.getShipment(SHIP)).status, 'label', 'a failed poll must write no status');
  ctx.grpc.clearFailures();
  assert.equal((await m.pollShipment(SHIP, 1)).polled, true, 'once the carrier answers again the poll must succeed');
  health = await store.pollHealth(SHIP, nowS());
  assert(health.failures === 0 && health.stale === false, \`a good poll must reset the failures and the staleness, poll health is \${JSON.stringify(health)}\`);
}

export async function check_scheduler(ctx) {
  const {m} = await client(ctx);
  ctx.grpc.fail('PollStatus', ctx.grpc.status.UNAVAILABLE, DOWN, 1);
  let now = nowS();
  await m.pollShipment(SHIP, 0);
  const calls = ctx.grpc.callsTo('PollStatus').length;
  assert.equal(calls, 1, \`one poll made \${calls} PollStatus calls: a failure is retried by the scheduler, not inside the poll\`);
  assert.equal(ctx.clock.sleeps, 0, \`the poll slept \${ctx.clock.sleeps} times: a worker must not wait on a carrier that is down\`);
  assert.equal(due(ctx), now + 30, \`after a failed attempt 0 the next poll is due at \${due(ctx)}, expected now + 30 s (\${now + 30})\`);
  for (const [attempt, wait] of [[3, 240], [10, 1800]]) {
    ctx.grpc.fail('PollStatus', ctx.grpc.status.UNAVAILABLE, DOWN, 1);
    now = nowS();
    await m.pollShipment(SHIP, attempt);
    assert.equal(due(ctx), now + wait, \`after a failed attempt \${attempt} the next poll is due \${(due(ctx) ?? 0) - now} s out, expected \${wait} s (30 s doubling, at most 1800 s)\`);
  }
  now = nowS();
  await m.pollShipment(SHIP, 0);
  assert.equal(due(ctx), now + 3600, \`after a good poll the next one is due \${(due(ctx) ?? 0) - now} s out, expected the routine POLL_INTERVAL_S = 3600\`);
}

export async function check_apply_through_state(ctx) {
  const {m, carrier, store} = await client(ctx, 'out_for_delivery');
  carrier.scan = ['in_transit', 500, 'Leeds'];
  const result = await m.pollShipment(SHIP, 0);
  const status = (await store.getShipment(SHIP)).status;
  assert.equal(status, 'out_for_delivery', \`the carrier answered an in_transit scan for a shipment out for delivery and the poll wrote \${status}: the answer goes through applyScan, which drops it\`);
  assert.equal(result.status, 'out_for_delivery', \`the poll must answer the status the shipment holds, got \${JSON.stringify(result)}\`);
  assert.deepStrictEqual(await store.rejects(SHIP), ['out_for_delivery->in_transit'], 'the dropped answer must be recorded on shipment:shp_1:rejects');
  carrier.scan = ['delivered', 600, 'Leeds'];
  await m.pollShipment(SHIP, 0);
  assert.equal((await store.getShipment(SHIP)).status, 'delivered', 'a delivered answer must apply');
  assert.deepStrictEqual((await store.scans(SHIP)).map(s => s.status), ['delivered'], 'the applied scan must join the timeline');
}
`,
    go: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc/codes"

	pb "shipments/gen/shipment_tracking"
	"shipments/store"

	"leetbuild/harness"
)

var clientBg = context.Background()

const down = "carrier gateway unreachable"

// carrierPeer answers the scan it holds for every shipment.
type carrierPeer struct {
	pb.UnimplementedCarrierGatewayServer
	status string
	at     int64
	city   string
}

func (c *carrierPeer) PollStatus(_ context.Context, _ *pb.PollRequest) (*pb.CarrierScan, error) {
	return &pb.CarrierScan{Status: c.status, ScanAt: c.at, City: c.city, CarrierRef: "1Z999"}, nil
}

func client(ctx *harness.Ctx, status string) *carrierPeer {
	peer := &carrierPeer{status: "in_transit", at: 100, city: "Memphis"}
	pb.RegisterCarrierGatewayServer(ctx.GRPC.Server(""), peer)
	store.Save(clientBg, store.Shipment{ShipmentID: "shp_1", TenantID: "t-acme", OrderID: "ord_1", Carrier: "ups", ServiceLevel: "ground", Status: status, CreatedAt: time.Now().Unix()})
	return peer
}

func mustPoll(ctx *harness.Ctx, attempt int) PollResult {
	result, err := pollShipment(clientBg, "shp_1", attempt)
	ctx.NoError(err, "pollShipment(shp_1, %d) failed", attempt)
	return result
}

func due(ctx *harness.Ctx) int64 {
	score, _ := ctx.Redis.ZScore("poll:due", "shp_1")
	return int64(score)
}

func CheckDeadline(ctx *harness.Ctx) {
	client(ctx, "label")
	ctx.Equal(mustPoll(ctx, 0).Polled, true, "with the carrier answering, the poll must succeed; polled")
	calls := ctx.GRPC.CallsTo("PollStatus", "")
	ctx.Assert(len(calls) > 0, "no PollStatus call was made")
	for _, call := range calls {
		ctx.Assert(call.HasDeadline(), "PollStatus carries no deadline: a carrier that stops answering holds the poll open")
		ctx.Assert(3500*time.Millisecond <= call.Timeout && call.Timeout <= 4500*time.Millisecond, "PollStatus carries a %v deadline, expected 4 s", call.Timeout)
	}
	ctx.GRPC.SetLatency("PollStatus", 30.0, "")
	started := time.Now()
	result := mustPoll(ctx, 0)
	ctx.Equal(result.Polled, false, "a carrier slower than the deadline must fail the poll; polled")
	ctx.Assert(time.Since(started) <= 5*time.Second, "a poll of a carrier that takes 30 s held on for %v", time.Since(started))
}

func CheckFailureRecorded(ctx *harness.Ctx) {
	client(ctx, "label")
	ctx.Clock.Advance(1000)
	ctx.GRPC.Fail("PollStatus", codes.Unavailable, down, 10, "")
	ctx.Equal(mustPoll(ctx, 0).Polled, false, "a poll the carrier refused; polled")
	health := store.PollHealth(clientBg, "shp_1", time.Now().Unix())
	ctx.Equal(health.LastOKAt, 0, "a failed poll must not record a good one (the feed must go stale, not look fresh); last_ok_at")
	ctx.Assert(health.Failures >= 1 && health.LastError == down, "a failed poll must record the failure and the carrier's error (%q), poll health is %+v", down, health)
	ctx.Equal(health.Stale, true, "1000 s after the label with no good poll the shipment must be stale (StaleAfterS = 900); stale")
	ctx.Equal(store.GetShipment(clientBg, "shp_1").Status, "label", "a failed poll must write no status; the status")
	ctx.GRPC.ClearFailures()
	ctx.Equal(mustPoll(ctx, 1).Polled, true, "once the carrier answers again the poll must succeed; polled")
	health = store.PollHealth(clientBg, "shp_1", time.Now().Unix())
	ctx.Assert(health.Failures == 0 && !health.Stale, "a good poll must reset the failures and the staleness, poll health is %+v", health)
}

func CheckScheduler(ctx *harness.Ctx) {
	client(ctx, "label")
	ctx.GRPC.Fail("PollStatus", codes.Unavailable, down, 1, "")
	now := time.Now().Unix()
	mustPoll(ctx, 0)
	ctx.Equal(len(ctx.GRPC.CallsTo("PollStatus", "")), 1, "a failure is retried by the scheduler, not inside the poll; PollStatus calls in one poll")
	ctx.Equal(ctx.Clock.Sleeps(), 0, "a worker must not wait on a carrier that is down; the poll's sleeps")
	ctx.Equal(due(ctx), now+30, "after a failed attempt 0 the next poll must be due at now + 30 s")
	for _, c := range []struct{ attempt, wait int64 }{{3, 240}, {10, 1800}} {
		ctx.GRPC.Fail("PollStatus", codes.Unavailable, down, 1, "")
		now = time.Now().Unix()
		mustPoll(ctx, int(c.attempt))
		ctx.Equal(due(ctx)-now, c.wait, "after a failed attempt %d, seconds until the next poll (30 s doubling, at most 1800 s)", c.attempt)
	}
	now = time.Now().Unix()
	mustPoll(ctx, 0)
	ctx.Equal(due(ctx)-now, 3600, "after a good poll, seconds until the routine poll (pollIntervalS)")
}

func CheckApplyThroughState(ctx *harness.Ctx) {
	peer := client(ctx, "out_for_delivery")
	peer.status, peer.at, peer.city = "in_transit", 500, "Leeds"
	result := mustPoll(ctx, 0)
	ctx.Equal(store.GetShipment(clientBg, "shp_1").Status, "out_for_delivery", "the carrier answered an in_transit scan for a shipment out for delivery: the answer goes through timeline.ApplyScan, which drops it; the status")
	ctx.Equal(result.Status, "out_for_delivery", "the poll must answer the status the shipment holds; the answered status")
	ctx.Equal(store.Rejects(clientBg, "shp_1"), []string{"out_for_delivery->in_transit"}, "the dropped answer must be recorded; the rejects")
	peer.status, peer.at = "delivered", 600
	mustPoll(ctx, 0)
	ctx.Equal(store.GetShipment(clientBg, "shp_1").Status, "delivered", "a delivered answer must apply; the status")
	scans := store.Scans(clientBg, "shp_1")
	ctx.Assert(len(scans) == 1 && scans[0].Status == "delivered", "the applied scan must join the timeline, scans are %+v", scans)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <chrono>
#include <string>
#include <vector>

#include "shipments/store.h"

namespace {

const std::string kDown = "carrier gateway unreachable";

// Answers the scan it holds for every shipment.
class CarrierPeer final : public shiptrack::CarrierGateway::Service {
 public:
  std::string status = "in_transit";
  long at = 100;
  std::string city = "Memphis";
  grpc::Status PollStatus(grpc::ServerContext*, const shiptrack::PollRequest*, shiptrack::CarrierScan* out) override {
    out->set_status(status);
    out->set_scan_at(at);
    out->set_city(city);
    out->set_carrier_ref("1Z999");
    return grpc::Status::OK;
  }
};

CarrierPeer& client(harness::Ctx& ctx, const std::string& status) {
  static CarrierPeer* peer = nullptr;
  delete peer;
  peer = new CarrierPeer;
  ctx.GRPC.Server("")->RegisterService(peer);
  store::save(store::Shipment{"shp_1", "t-acme", "ord_1", "ups", "ground", status, "", now_seconds()});
  return *peer;
}

PollResult mustPoll(harness::Ctx& ctx, int attempt) {
  try {
    return pollShipment("shp_1", attempt);
  } catch (const std::exception& e) {
    ctx.Fatalf("pollShipment(shp_1, %d) threw %s: %s", attempt, harness::CurrentExceptionType(), e.what());
  }
  return {};
}

long due(harness::Ctx& ctx) { return static_cast<long>(ctx.Redis.ZScore("poll:due", "shp_1").value_or(0)); }

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  client(ctx, "label");
  ctx.Equal(mustPoll(ctx, 0).polled, true, "with the carrier answering, the poll must succeed; polled");
  const auto calls = ctx.GRPC.CallsTo("PollStatus");
  ctx.Assert(!calls.empty(), "no PollStatus call was made");
  for (const auto& call : calls) {
    ctx.Assert(call.HasDeadline(), "PollStatus carries no deadline: a carrier that stops answering holds the poll open");
    ctx.Assert(3.5 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 4.5, "PollStatus carries a %v s deadline, expected kDeadline = 4 s", call.TimeoutSeconds());
  }
  ctx.GRPC.SetLatency("PollStatus", 30.0);
  const long started = now_seconds();
  const PollResult result = mustPoll(ctx, 0);
  ctx.Equal(result.polled, false, "a carrier slower than the deadline must fail the poll; polled");
  ctx.Assert(now_seconds() - started <= 5, "a poll of a carrier that takes 30 s held on for %d s", now_seconds() - started);
}

void CheckFailureRecorded(harness::Ctx& ctx) {
  client(ctx, "label");
  ctx.Clock.Advance(1000);
  ctx.GRPC.Fail("PollStatus", grpc::StatusCode::UNAVAILABLE, kDown, 10);
  ctx.Equal(mustPoll(ctx, 0).polled, false, "a poll the carrier refused; polled");
  auto health = store::pollHealth("shp_1", now_seconds());
  ctx.Equal(health.last_ok_at, 0, "a failed poll must not record a good one (the feed must go stale, not look fresh); last_ok_at");
  ctx.Assert(health.failures >= 1 && health.last_error == kDown, "a failed poll must record the failure and the carrier's error (%q), got failures %d last_error %q", kDown, health.failures, health.last_error);
  ctx.Equal(health.stale, true, "1000 s after the label with no good poll the shipment must be stale (kStaleAfterS = 900); stale");
  ctx.Equal(store::getShipment("shp_1")->status, "label", "a failed poll must write no status; the status");
  ctx.GRPC.ClearFailures();
  ctx.Equal(mustPoll(ctx, 1).polled, true, "once the carrier answers again the poll must succeed; polled");
  health = store::pollHealth("shp_1", now_seconds());
  ctx.Assert(health.failures == 0 && !health.stale, "a good poll must reset the failures and the staleness, got failures %d stale %t", health.failures, health.stale);
}

void CheckScheduler(harness::Ctx& ctx) {
  client(ctx, "label");
  ctx.GRPC.Fail("PollStatus", grpc::StatusCode::UNAVAILABLE, kDown, 1);
  long now = now_seconds();
  mustPoll(ctx, 0);
  ctx.Equal(ctx.GRPC.CallsTo("PollStatus").size(), 1, "a failure is retried by the scheduler, not inside the poll; PollStatus calls in one poll");
  ctx.Equal(ctx.Clock.Sleeps(), 0, "a worker must not wait on a carrier that is down; the poll's sleeps");
  ctx.Equal(due(ctx), now + 30, "after a failed attempt 0 the next poll must be due at now + 30 s");
  for (const auto& [attempt, wait] : std::vector<std::pair<int, long>>{{3, 240}, {10, 1800}}) {
    ctx.GRPC.Fail("PollStatus", grpc::StatusCode::UNAVAILABLE, kDown, 1);
    now = now_seconds();
    mustPoll(ctx, attempt);
    ctx.Equal(due(ctx) - now, wait, "after a failed attempt %d, seconds until the next poll (30 s doubling, at most 1800 s)", attempt);
  }
  now = now_seconds();
  mustPoll(ctx, 0);
  ctx.Equal(due(ctx) - now, 3600, "after a good poll, seconds until the routine poll (kPollIntervalS)");
}

void CheckApplyThroughState(harness::Ctx& ctx) {
  CarrierPeer& peer = client(ctx, "out_for_delivery");
  peer.status = "in_transit";
  peer.at = 500;
  peer.city = "Leeds";
  const PollResult result = mustPoll(ctx, 0);
  ctx.Equal(store::getShipment("shp_1")->status, "out_for_delivery", "the carrier answered an in_transit scan for a shipment out for delivery: the answer goes through timeline::applyScan, which drops it; the status");
  ctx.Equal(result.status, "out_for_delivery", "the poll must answer the status the shipment holds; the answered status");
  ctx.Equal(store::rejects("shp_1"), {"out_for_delivery->in_transit"}, "the dropped answer must be recorded; the rejects");
  peer.status = "delivered";
  peer.at = 600;
  mustPoll(ctx, 0);
  ctx.Equal(store::getShipment("shp_1")->status, "delivered", "a delivered answer must apply; the status");
  const auto scans = store::scans("shp_1");
  ctx.Assert(scans.size() == 1 && scans[0].status == "delivered", "the applied scan must join the timeline, got %d scan(s)", scans.size());
}
`,
  },
  debrief: `A poll is a question to a system that may not answer, so it gets a deadline, one attempt, and an honest record of how it went. The deadline bounds what a dead carrier costs one worker; handing the retry to the scheduler with a growing backoff bounds what it costs the carrier, and the worker moves on to shipments whose carriers answer. Recording the failure, instead of calling the poll fresh, is what lets a shipment go stale and show up in the operations view. The answer goes through the same forward-only apply as every other scan, because a carrier's API serves cached data too. A production poller adds jitter to the backoff, a per-carrier circuit breaker that stops polling a carrier that is down, and a webhook path for carriers that push.`,
};
