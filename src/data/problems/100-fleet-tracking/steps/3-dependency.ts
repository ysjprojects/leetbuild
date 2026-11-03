import type {Step} from '@/lib/types';

// ---- 3. Geofence check on a deadline, retried under the position's key ----------------------------
export const dependencyStep: Step = {
  id: 'dependency',
  title: 'A geofence check that times out, retries, and alerts once',
  concept: 'grpc',
  file: 'geofence',
  focus: ['api', 'dispatch'],
  task: `## Task

**Starting point.** The starter's \`check_geofence(vehicle_id, position)\` calls
\`Dispatch.CheckGeofence\` with the position and a fresh random \`idempotency_key\`, under a 30 s
deadline. On \`UNAVAILABLE\` it appends the position to \`retry_queue\`; on \`DEADLINE_EXCEEDED\`
it logs and drops it, reasoning that dispatch may have seen it. \`retry_pending()\` calls
\`check_geofence\` again for every queued position. It serves the demo and hides four flaws.

\`\`\`proto
service Dispatch { rpc CheckGeofence(GeofenceCheckRequest) returns (GeofenceCheckResponse); }
message GeofenceCheckRequest { string vehicle_id = 1; double lat = 2; double lon = 3; int64 device_timestamp_ms = 4; int64 sequence = 5; string idempotency_key = 6; }
message GeofenceCheckResponse { bool alert = 1; string zone = 2; }
\`\`\`

**Failure mode the checks target.** Dispatch is slow, restarts, and raises an alert the first time
it sees a key. A check must not hang ingest, must not be lost when it fails, must not alert twice
when retried, and must not tell dispatch about a position older than one it already saw.

- Every call carries a **2 s deadline**; past it the check has failed.
- Any failed call, \`DEADLINE_EXCEEDED\` included, goes to \`retry_queue\`.
- The key is \`geofence:{vehicle_id}:{sequence}\`, the same on every attempt.
- A queued position whose timestamp is not newer than the vehicle's last successfully checked one
  is dropped by the retry instead of sent.

:::widget deadline-retry {"base": 200, "deadline": 2000, "attempts": 2}`,
  sequence: {
    participants: ['fleetd', 'Dispatch', 'retry_queue'],
    messages: [
      {from: 'fleetd', to: 'Dispatch', label: 'CheckGeofence(v-1, seq 42, key geofence:v-1:42) · 2 s', kind: 'sync'},
      {from: 'Dispatch', to: 'fleetd', label: 'DEADLINE_EXCEEDED', kind: 'reply'},
      {from: 'fleetd', to: 'retry_queue', label: 'queue (v-1, seq 42)', kind: 'async'},
      {from: 'fleetd', to: 'Dispatch', label: 'CheckGeofence(v-1, seq 43, key geofence:v-1:43)', kind: 'sync'},
      {from: 'Dispatch', to: 'fleetd', label: '{alert: true, zone: warehouse-7}', kind: 'reply'},
      {from: 'retry_queue', to: 'fleetd', label: 'retry_pending: seq 42 is older than 43 → dropped', kind: 'async'},
    ],
  },
  hints: [
    'A truck sat inside the warehouse geofence for a minute and no alert fired, because dispatch was slow that minute; another time the same alert fired twice, five minutes apart.',
    'A 30 s deadline holds the ingest thread; a timed-out call is dropped with its alert; the retry sends a fresh key, so dispatch alerts again; a retry can carry a position dispatch has moved past.',
    'Deadline 2 s; every failure appends to `retry_queue`; `idempotency_key` is `geofence:{vehicle_id}:{sequence}` computed from the position; remember the last timestamp dispatch answered per vehicle and skip anything not newer.',
  ],
  checks: [
    {
      id: 'deadline',
      title: 'Every call carries a 2 s deadline',
      detail:
        'A dispatch that answers after 5 s fails the check within 2 s of virtual time instead of holding ingest. The starter waits 30 s.',
      match: {
        python: {all: [/GEOFENCE_DEADLINE_S\s*=\s*2(\.0)?\b/, /timeout\s*=\s*GEOFENCE_DEADLINE_S/]},
        typescript: {all: [/GEOFENCE_DEADLINE_MS\s*=\s*2_?000\b/, /deadline:/]},
        go: {all: [/geofenceDeadline\s*=\s*2\s*\*\s*time\.Second/, /context\.WithTimeout\(/]},
        scala: {all: [/GeofenceDeadlineMs\s*=\s*2000L?\b/, /withDeadlineAfter\(/]},
        cpp: {all: [/kGeofenceDeadline\{2\}/, /set_deadline\(/]},
      },
    },
    {
      id: 'enqueue-on-failure',
      title: 'A timed-out check is queued and retried',
      detail:
        'After `DEADLINE_EXCEEDED` the position is in `retry_queue` and `retry_pending` calls dispatch again for it. The starter drops a timed-out check, so a warehouse alert is lost.',
      match: {
        python: {all: [/retry_queue\.append\(/], none: [/==\s*grpc\.StatusCode\.DEADLINE_EXCEEDED/]},
        typescript: {all: [/retryQueue\.push\(/], none: [/===\s*grpc\.status\.DEADLINE_EXCEEDED/]},
        go: {all: [/retryQueue\s*=\s*append\(/], none: [/codes\.DeadlineExceeded/]},
        scala: {all: [/retryQueue\.enqueue\(/], none: [/Status\.Code\.DEADLINE_EXCEEDED/]},
        cpp: {all: [/retry_queue\.(emplace_back|push_back)\(/], none: [/StatusCode::DEADLINE_EXCEEDED/]},
      },
    },
    {
      id: 'idempotency-key',
      title: 'The same key on every attempt: geofence:{vehicle_id}:{sequence}',
      detail:
        'The first attempt and its retry carry the key computed from the position, so dispatch raises the alert once. The starter mints a random key per attempt.',
      match: {
        python: {all: [/f["']geofence:\{vehicle_id\}:\{position\[["']sequence["']\]\}["']/], none: [/uuid/]},
        typescript: {all: [/`geofence:\$\{vehicleId\}:\$\{position\.sequence\}`/], none: [/randomUUID|uuid/]},
        go: {all: [/"geofence:%s:%d"/], none: [/UnixNano\(\)/]},
        scala: {all: [/s"geofence:\$vehicleId:\$\{p\.sequence\}"/], none: [/randomUUID/]},
        cpp: {
          all: [/"geofence:"\s*\+\s*vehicle_id\s*\+\s*":"\s*\+\s*std::to_string\(p\.sequence\)/],
          none: [/attempt\+\+|nanoseconds/],
        },
      },
    },
    {
      id: 'no-stale-dispatch',
      title: 'A retry older than the last checked position is dropped',
      detail:
        'When dispatch has already answered for a newer position of the vehicle, the queued older one is not sent. The starter retries it, and dispatch acts on where the vehicle was.',
      match: {
        python: {all: [/last_dispatched/, /<=\s*last_dispatched|last_dispatched[^\n]*>=/]},
        typescript: {all: [/lastDispatched/, /device_timestamp_ms\s*<=\s*/]},
        go: {all: [/lastDispatched/, /DeviceTimestampMs\s*<=\s*/]},
        scala: {all: [/lastDispatched/, /deviceTimestampMs\s*<=\s*/]},
        cpp: {all: [/last_dispatched/, /device_timestamp_ms\s*<=\s*/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
import uuid

import grpc

import dispatch_pb2
import dispatch_pb2_grpc

log = logging.getLogger("fleet")

GEOFENCE_DEADLINE_S = 30.0

channel = grpc.insecure_channel("dispatch:9000")
stub = dispatch_pb2_grpc.DispatchStub(channel)

retry_queue: list[tuple[str, dict]] = []  # (vehicle_id, position) awaiting another attempt


def check_geofence(vehicle_id: str, position: dict) -> bool:
    """One geofence check for an applied position: True when dispatch answered, False when it was queued."""
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    request = dispatch_pb2.GeofenceCheckRequest(
        vehicle_id=vehicle_id,
        lat=position["lat"],
        lon=position["lon"],
        device_timestamp_ms=position["device_timestamp_ms"],
        sequence=position["sequence"],
        idempotency_key=str(uuid.uuid4()),
    )
    try:
        stub.CheckGeofence(request, timeout=GEOFENCE_DEADLINE_S)
    except grpc.RpcError as e:
        if e.code() == grpc.StatusCode.DEADLINE_EXCEEDED:
            log.warning("geofence check for %s timed out; dispatch may have it", vehicle_id)
            return False
        retry_queue.append((vehicle_id, position))
        return False
    return True


def retry_pending() -> None:
    """Another attempt for every queued check; called by the retry ticker."""
    pending = list(retry_queue)
    retry_queue.clear()
    for vehicle_id, position in pending:
        check_geofence(vehicle_id, position)
`,
      solution: `import logging

import grpc

import dispatch_pb2
import dispatch_pb2_grpc

log = logging.getLogger("fleet")

GEOFENCE_DEADLINE_S = 2.0

channel = grpc.insecure_channel("dispatch:9000")
stub = dispatch_pb2_grpc.DispatchStub(channel)

retry_queue: list[tuple[str, dict]] = []  # (vehicle_id, position) awaiting another attempt
last_dispatched: dict[str, int] = {}  # vehicle_id → device_timestamp_ms of the last position dispatch answered for


def check_geofence(vehicle_id: str, position: dict) -> bool:
    """One geofence check for an applied position: True when dispatch answered, False when it was queued or stale."""
    ts = position["device_timestamp_ms"]
    if ts <= last_dispatched.get(vehicle_id, -1):
        return False  # dispatch already acted on a newer position: this one is history
    request = dispatch_pb2.GeofenceCheckRequest(
        vehicle_id=vehicle_id,
        lat=position["lat"],
        lon=position["lon"],
        device_timestamp_ms=ts,
        sequence=position["sequence"],
        idempotency_key=f"geofence:{vehicle_id}:{position['sequence']}",  # the same on every attempt
    )
    try:
        stub.CheckGeofence(request, timeout=GEOFENCE_DEADLINE_S)
    except grpc.RpcError as e:
        log.warning("geofence check for %s failed (%s): queued", vehicle_id, e.code())
        retry_queue.append((vehicle_id, position))
        return False
    last_dispatched[vehicle_id] = ts
    return True


def retry_pending() -> None:
    """Another attempt for every queued check; called by the retry ticker."""
    pending = list(retry_queue)
    retry_queue.clear()
    for vehicle_id, position in pending:
        check_geofence(vehicle_id, position)
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import type {Position} from 'fleet/position';

export const GEOFENCE_DEADLINE_MS = 30_000;

interface GeofenceCheckRequest {
  vehicle_id: string;
  lat: number;
  lon: number;
  device_timestamp_ms: number;
  sequence: number;
  idempotency_key: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('dispatch.proto')) as unknown as {
  fleet: {Dispatch: grpc.ServiceClientConstructor};
};
const stub = new pkg.fleet.Dispatch('dispatch:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  CheckGeofence(request: GeofenceCheckRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{alert: boolean; zone: string}>;
};

/** Positions awaiting another attempt. */
export const retryQueue: {vehicleId: string; position: Position}[] = [];

/** One geofence check for an applied position: true when dispatch answered, false when it was queued. */
export async function checkGeofence(vehicleId: string, position: Position): Promise<boolean> {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const request: GeofenceCheckRequest = {
    vehicle_id: vehicleId,
    lat: position.lat,
    lon: position.lon,
    device_timestamp_ms: position.device_timestamp_ms,
    sequence: position.sequence,
    idempotency_key: crypto.randomUUID(),
  };
  try {
    await stub.CheckGeofence(request, new grpc.Metadata(), {deadline: Date.now() + GEOFENCE_DEADLINE_MS});
  } catch (e) {
    if ((e as grpc.ServiceError).code === grpc.status.DEADLINE_EXCEEDED) {
      console.warn(\`geofence check for \${vehicleId} timed out; dispatch may have it\`);
      return false;
    }
    retryQueue.push({vehicleId, position});
    return false;
  }
  return true;
}

/** Another attempt for every queued check; called by the retry ticker. */
export async function retryPending(): Promise<void> {
  const pending = retryQueue.splice(0);
  for (const {vehicleId, position} of pending) await checkGeofence(vehicleId, position);
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import type {Position} from 'fleet/position';

export const GEOFENCE_DEADLINE_MS = 2000;

interface GeofenceCheckRequest {
  vehicle_id: string;
  lat: number;
  lon: number;
  device_timestamp_ms: number;
  sequence: number;
  idempotency_key: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('dispatch.proto')) as unknown as {
  fleet: {Dispatch: grpc.ServiceClientConstructor};
};
const stub = new pkg.fleet.Dispatch('dispatch:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  CheckGeofence(request: GeofenceCheckRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{alert: boolean; zone: string}>;
};

/** Positions awaiting another attempt. */
export const retryQueue: {vehicleId: string; position: Position}[] = [];
/** Per vehicle, the device timestamp of the last position dispatch answered for. */
export const lastDispatched = new Map<string, number>();

/** One geofence check for an applied position: true when dispatch answered, false when it was queued or stale. */
export async function checkGeofence(vehicleId: string, position: Position): Promise<boolean> {
  if (position.device_timestamp_ms <= (lastDispatched.get(vehicleId) ?? -1)) return false; // dispatch already acted on a newer position
  const request: GeofenceCheckRequest = {
    vehicle_id: vehicleId,
    lat: position.lat,
    lon: position.lon,
    device_timestamp_ms: position.device_timestamp_ms,
    sequence: position.sequence,
    idempotency_key: \`geofence:\${vehicleId}:\${position.sequence}\`, // the same on every attempt
  };
  try {
    await stub.CheckGeofence(request, new grpc.Metadata(), {deadline: Date.now() + GEOFENCE_DEADLINE_MS});
  } catch (e) {
    console.warn(\`geofence check for \${vehicleId} failed (\${(e as grpc.ServiceError).code}): queued\`);
    retryQueue.push({vehicleId, position});
    return false;
  }
  lastDispatched.set(vehicleId, position.device_timestamp_ms);
  return true;
}

/** Another attempt for every queued check; called by the retry ticker. */
export async function retryPending(): Promise<void> {
  const pending = retryQueue.splice(0);
  for (const {vehicleId, position} of pending) await checkGeofence(vehicleId, position);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"fmt"
	"log"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "fleet/gen/dispatch"
	"fleet/position"
)

const geofenceDeadline = 30 * time.Second

var conn, _ = grpc.NewClient("dispatch:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewDispatchClient(conn)

type pendingCheck struct {
	vehicleID string
	p         position.Position
}

// retryQueue holds the positions awaiting another attempt.
var retryQueue []pendingCheck

// checkGeofence runs one geofence check for an applied position: true when dispatch answered, false when it was queued.
func checkGeofence(ctx context.Context, vehicleID string, p position.Position) bool {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	callCtx, cancel := context.WithTimeout(ctx, geofenceDeadline)
	defer cancel()
	_, err := stub.CheckGeofence(callCtx, &pb.GeofenceCheckRequest{
		VehicleId:         vehicleID,
		Lat:               p.Lat,
		Lon:               p.Lon,
		DeviceTimestampMs: p.DeviceTimestampMs,
		Sequence:          p.Sequence,
		IdempotencyKey:    fmt.Sprintf("%s-%d", vehicleID, time.Now().UnixNano()),
	})
	if err != nil {
		if status.Code(err) == codes.DeadlineExceeded {
			log.Printf("geofence check for %s timed out; dispatch may have it", vehicleID)
			return false
		}
		retryQueue = append(retryQueue, pendingCheck{vehicleID, p})
		return false
	}
	return true
}

// retryPending makes another attempt for every queued check; called by the retry ticker.
func retryPending(ctx context.Context) {
	pending := retryQueue
	retryQueue = nil
	for _, c := range pending {
		checkGeofence(ctx, c.vehicleID, c.p)
	}
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"log"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "fleet/gen/dispatch"
	"fleet/position"
)

const geofenceDeadline = 2 * time.Second

var conn, _ = grpc.NewClient("dispatch:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewDispatchClient(conn)

type pendingCheck struct {
	vehicleID string
	p         position.Position
}

var (
	// retryQueue holds the positions awaiting another attempt.
	retryQueue []pendingCheck
	// lastDispatched is, per vehicle, the device timestamp of the last position dispatch answered for.
	lastDispatched = map[string]int64{}
)

// checkGeofence runs one geofence check for an applied position: true when dispatch answered, false when it was queued or stale.
func checkGeofence(ctx context.Context, vehicleID string, p position.Position) bool {
	if last, ok := lastDispatched[vehicleID]; ok && p.DeviceTimestampMs <= last {
		return false // dispatch already acted on a newer position: this one is history
	}
	callCtx, cancel := context.WithTimeout(ctx, geofenceDeadline)
	defer cancel()
	_, err := stub.CheckGeofence(callCtx, &pb.GeofenceCheckRequest{
		VehicleId:         vehicleID,
		Lat:               p.Lat,
		Lon:               p.Lon,
		DeviceTimestampMs: p.DeviceTimestampMs,
		Sequence:          p.Sequence,
		IdempotencyKey:    fmt.Sprintf("geofence:%s:%d", vehicleID, p.Sequence), // the same on every attempt
	})
	if err != nil {
		log.Printf("geofence check for %s failed (%s): queued", vehicleID, status.Code(err))
		retryQueue = append(retryQueue, pendingCheck{vehicleID, p})
		return false
	}
	lastDispatched[vehicleID] = p.DeviceTimestampMs
	return true
}

// retryPending makes another attempt for every queued check; called by the retry ticker.
func retryPending(ctx context.Context) {
	pending := retryQueue
	retryQueue = nil
	for _, c := range pending {
		checkGeofence(ctx, c.vehicleID, c.p)
	}
}
`,
    },
    scala: {
      starter: `import java.util.UUID
import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import scala.collection.mutable

import fleet.Position
import fleet.dispatch.{DispatchGrpc, GeofenceCheckRequest}

object Geofence {
  val GeofenceDeadlineMs = 30000L

  private val channel = ManagedChannelBuilder.forAddress("dispatch", 9000).usePlaintext().build()
  private val stub = DispatchGrpc.blockingStub(channel)

  /** Positions awaiting another attempt. */
  val retryQueue: mutable.Queue[(String, Position)] = mutable.Queue.empty

  /** One geofence check for an applied position: true when dispatch answered, false when it was queued. */
  def checkGeofence(vehicleId: String, p: Position): Boolean = {
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    val request = GeofenceCheckRequest(
      vehicleId = vehicleId,
      lat = p.lat,
      lon = p.lon,
      deviceTimestampMs = p.deviceTimestampMs,
      sequence = p.sequence,
      idempotencyKey = UUID.randomUUID().toString
    )
    try {
      stub.withDeadlineAfter(GeofenceDeadlineMs, TimeUnit.MILLISECONDS).checkGeofence(request)
      true
    } catch {
      case e: StatusRuntimeException if e.getStatus.getCode == Status.Code.DEADLINE_EXCEEDED =>
        System.err.println(s"geofence check for $vehicleId timed out; dispatch may have it")
        false
      case _: StatusRuntimeException =>
        retryQueue.enqueue((vehicleId, p))
        false
    }
  }

  /** Another attempt for every queued check; called by the retry ticker. */
  def retryPending(): Unit =
    retryQueue.dequeueAll(_ => true).foreach { case (vehicleId, p) => checkGeofence(vehicleId, p) }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import scala.collection.mutable

import fleet.Position
import fleet.dispatch.{DispatchGrpc, GeofenceCheckRequest}

object Geofence {
  val GeofenceDeadlineMs = 2000L

  private val channel = ManagedChannelBuilder.forAddress("dispatch", 9000).usePlaintext().build()
  private val stub = DispatchGrpc.blockingStub(channel)

  /** Positions awaiting another attempt. */
  val retryQueue: mutable.Queue[(String, Position)] = mutable.Queue.empty
  /** Per vehicle, the device timestamp of the last position dispatch answered for. */
  val lastDispatched: mutable.Map[String, Long] = mutable.Map.empty

  /** One geofence check for an applied position: true when dispatch answered, false when it was queued or stale. */
  def checkGeofence(vehicleId: String, p: Position): Boolean = {
    if (lastDispatched.get(vehicleId).exists(p.deviceTimestampMs <= _)) return false // dispatch already acted on a newer position
    val request = GeofenceCheckRequest(
      vehicleId = vehicleId,
      lat = p.lat,
      lon = p.lon,
      deviceTimestampMs = p.deviceTimestampMs,
      sequence = p.sequence,
      idempotencyKey = s"geofence:$vehicleId:\${p.sequence}" // the same on every attempt
    )
    try {
      stub.withDeadlineAfter(GeofenceDeadlineMs, TimeUnit.MILLISECONDS).checkGeofence(request)
      lastDispatched(vehicleId) = p.deviceTimestampMs
      true
    } catch {
      case e: StatusRuntimeException =>
        System.err.println(s"geofence check for $vehicleId failed (\${e.getStatus.getCode}): queued")
        retryQueue.enqueue((vehicleId, p))
        false
    }
  }

  /** Another attempt for every queued check; called by the retry ticker. */
  def retryPending(): Unit =
    retryQueue.dequeueAll(_ => true).foreach { case (vehicleId, p) => checkGeofence(vehicleId, p) }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <iostream>
#include <string>
#include <utility>
#include <vector>

#include "dispatch.grpc.pb.h"
#include "position.h"

constexpr std::chrono::seconds kGeofenceDeadline{30};

auto channel = grpc::CreateChannel("dispatch:9000", grpc::InsecureChannelCredentials());
auto stub = fleet::Dispatch::NewStub(channel);

// Positions awaiting another attempt.
std::vector<std::pair<std::string, Position>> retry_queue;
long long attempt = 0;

// One geofence check for an applied position: true when dispatch answered, false when it was queued.
bool check_geofence(const std::string& vehicle_id, const Position& p) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kGeofenceDeadline);
  fleet::GeofenceCheckRequest request;
  request.set_vehicle_id(vehicle_id);
  request.set_lat(p.lat);
  request.set_lon(p.lon);
  request.set_device_timestamp_ms(p.device_timestamp_ms);
  request.set_sequence(p.sequence);
  request.set_idempotency_key(vehicle_id + "-" + std::to_string(attempt++));
  fleet::GeofenceCheckResponse response;
  const grpc::Status status = stub->CheckGeofence(&ctx, request, &response);
  if (!status.ok()) {
    if (status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED) {
      std::cerr << "geofence check for " << vehicle_id << " timed out; dispatch may have it\\n";
      return false;
    }
    retry_queue.emplace_back(vehicle_id, p);
    return false;
  }
  return true;
}

// Another attempt for every queued check; called by the retry ticker.
void retry_pending() {
  const auto pending = std::move(retry_queue);
  retry_queue.clear();
  for (const auto& [vehicle_id, p] : pending) check_geofence(vehicle_id, p);
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <iostream>
#include <map>
#include <string>
#include <utility>
#include <vector>

#include "dispatch.grpc.pb.h"
#include "position.h"

constexpr std::chrono::seconds kGeofenceDeadline{2};

auto channel = grpc::CreateChannel("dispatch:9000", grpc::InsecureChannelCredentials());
auto stub = fleet::Dispatch::NewStub(channel);

// Positions awaiting another attempt.
std::vector<std::pair<std::string, Position>> retry_queue;
// Per vehicle, the device timestamp of the last position dispatch answered for.
std::map<std::string, long long> last_dispatched;

// One geofence check for an applied position: true when dispatch answered, false when it was queued or stale.
bool check_geofence(const std::string& vehicle_id, const Position& p) {
  const auto last = last_dispatched.find(vehicle_id);
  if (last != last_dispatched.end() && p.device_timestamp_ms <= last->second) return false;  // dispatch already acted on a newer position
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kGeofenceDeadline);
  fleet::GeofenceCheckRequest request;
  request.set_vehicle_id(vehicle_id);
  request.set_lat(p.lat);
  request.set_lon(p.lon);
  request.set_device_timestamp_ms(p.device_timestamp_ms);
  request.set_sequence(p.sequence);
  request.set_idempotency_key("geofence:" + vehicle_id + ":" + std::to_string(p.sequence));  // the same on every attempt
  fleet::GeofenceCheckResponse response;
  const grpc::Status status = stub->CheckGeofence(&ctx, request, &response);
  if (!status.ok()) {
    std::cerr << "geofence check for " << vehicle_id << " failed (" << status.error_code() << "): queued\\n";
    retry_queue.emplace_back(vehicle_id, p);
    return false;
  }
  last_dispatched[vehicle_id] = p.device_timestamp_ms;
  return true;
}

// Another attempt for every queued check; called by the retry ticker.
void retry_pending() {
  const auto pending = std::move(retry_queue);
  retry_queue.clear();
  for (const auto& [vehicle_id, p] : pending) check_geofence(vehicle_id, p);
}
`,
    },
  },
  harness: {
    python: `import grpc

import dispatch_pb2
import dispatch_pb2_grpc


class FakeDispatch(dispatch_pb2_grpc.DispatchServicer):
    """Dispatch: the warehouse geofence is north of latitude 48; the first sight of a key raises the alert."""

    def __init__(self):
        self.alerts = []

    def CheckGeofence(self, request, context):
        alert = request.lat > 48.0 and request.idempotency_key not in self.alerts
        if alert:
            self.alerts.append(request.idempotency_key)
        return dispatch_pb2.GeofenceCheckResponse(alert=alert, zone="warehouse-7" if request.lat > 48.0 else "")


def _geofence(ctx):
    peer = FakeDispatch()
    ctx.grpc.serve(dispatch_pb2_grpc.add_DispatchServicer_to_server, peer)
    return ctx.load("geofence"), peer


def pos(ts, seq, lat=47.6, lon=-122.3):
    return {"vehicle_id": "v-1", "device_timestamp_ms": ts, "sequence": seq, "lat": lat, "lon": lon}


def calls(ctx):
    return ctx.grpc.calls_to("CheckGeofence")


def check_deadline(ctx):
    m, _ = _geofence(ctx)
    assert m.check_geofence("v-1", pos(1000, 42)) is True, "a check dispatch answers must return True"
    call = calls(ctx)[-1]
    assert call.timeout is not None, "the CheckGeofence call carries no deadline: a stalled dispatch would hold ingest forever"
    assert 1.5 <= call.timeout <= 2.5, f"the deadline must be about 2 s, got {call.timeout} s"
    ctx.grpc.set_latency("CheckGeofence", 5.0)
    before = ctx.clock.time()
    checked = m.check_geofence("v-1", pos(2000, 43))
    waited = ctx.clock.time() - before
    assert waited < 3, f"check_geofence waited {waited:.1f} s for a dispatch that answers after 5 s: the 2 s deadline must end the call"
    assert checked is False, "a dispatch slower than the deadline is a failed check, not an answered one"


def check_enqueue_on_failure(ctx):
    m, _ = _geofence(ctx)
    ctx.grpc.fail("CheckGeofence", grpc.StatusCode.DEADLINE_EXCEEDED, "deadline exceeded", times=1)
    assert m.check_geofence("v-1", pos(1000, 42)) is False, "a timed-out check must return False"
    assert len(calls(ctx)) == 1, f"the first attempt made {len(calls(ctx))} calls, expected 1"
    m.retry_pending()
    assert len(calls(ctx)) == 2, f"after a check timed out, retry_pending made {len(calls(ctx)) - 1} new calls, expected 1: a timed-out check is queued and retried, not dropped (a warehouse alert would never fire)"
    last = calls(ctx)[-1].request
    assert last.vehicle_id == "v-1" and last.sequence == 42, f"the retry carried vehicle {last.vehicle_id!r} sequence {last.sequence}, expected the queued position v-1 / 42"
    m.retry_pending()
    assert len(calls(ctx)) == 2, "once the retry succeeded the queue is empty: nothing to send again"


def check_idempotency_key(ctx):
    m, peer = _geofence(ctx)
    ctx.grpc.fail("CheckGeofence", grpc.StatusCode.UNAVAILABLE, "dispatch restarting", times=1)
    m.check_geofence("v-1", pos(1000, 42, lat=48.5))
    m.retry_pending()
    keys = [c.request.idempotency_key for c in calls(ctx)]
    assert len(keys) == 2, f"a failed check and its retry made {len(keys)} calls, expected 2"
    assert keys[0] == "geofence:v-1:42", f"the first attempt carried idempotency_key {keys[0]!r}, expected geofence:v-1:42: dispatch dedupes alerts by this key"
    assert keys[1] == keys[0], f"the retry carried idempotency_key {keys[1]!r} after {keys[0]!r}: a fresh key makes dispatch treat the retry as a new alert"
    ctx.grpc.fail("CheckGeofence", grpc.StatusCode.UNAVAILABLE, "dispatch restarting", times=1)
    m.check_geofence("v-2", {**pos(1000, 7, lat=48.5), "vehicle_id": "v-2"})
    m.retry_pending()
    assert calls(ctx)[-1].request.idempotency_key == "geofence:v-2:7", f"another vehicle's retry carried {calls(ctx)[-1].request.idempotency_key!r}, expected geofence:v-2:7"
    assert len(peer.alerts) == 2, f"dispatch raised {len(peer.alerts)} alerts for two vehicles inside the geofence, expected one each"


def check_no_stale_dispatch(ctx):
    m, _ = _geofence(ctx)
    ctx.grpc.fail("CheckGeofence", grpc.StatusCode.UNAVAILABLE, "dispatch restarting", times=1)
    assert m.check_geofence("v-1", pos(1000, 42)) is False, "a failed check must return False"
    assert m.check_geofence("v-1", pos(2000, 43)) is True, "the next position must be checked while the older one waits in the queue"
    m.retry_pending()
    assert len(calls(ctx)) == 2, f"retry_pending sent the position at ts 1000 after dispatch had answered for ts 2000 ({len(calls(ctx))} calls): a queued position older than the last one dispatch saw is stale, drop it"
    m.retry_pending()
    assert len(calls(ctx)) == 2, "the stale position must leave the queue, not stay for the next retry"
    assert m.check_geofence("v-1", pos(3000, 44)) is True, "a newer position after the stale one must still be checked"
`,
    typescript: `/** Dispatch: the warehouse geofence is north of latitude 48; the first sight of a key raises the alert. */
function geofence(ctx) {
  const alerts: string[] = [];
  const pkg = ctx.proto('dispatch.proto');
  ctx.grpc.serve(pkg.fleet.Dispatch.service, {
    CheckGeofence(call, callback) {
      const {lat, idempotency_key} = call.request;
      const alert = lat > 48.0 && !alerts.includes(idempotency_key);
      if (alert) alerts.push(idempotency_key);
      callback(null, {alert, zone: lat > 48.0 ? 'warehouse-7' : ''});
    },
  });
  return {m: ctx.load('geofence'), alerts};
}

const pos = (ts: number, seq: number, lat = 47.6, lon = -122.3, vehicle_id = 'v-1') => ({vehicle_id, device_timestamp_ms: ts, sequence: seq, lat, lon});

const calls = ctx => ctx.grpc.callsTo('CheckGeofence');

export async function check_deadline(ctx) {
  const {m} = geofence(ctx);
  assert.strictEqual(await m.checkGeofence('v-1', pos(1000, 42)), true, 'a check dispatch answers must return true');
  const call = calls(ctx).at(-1);
  assert(call.timeout !== null, 'the CheckGeofence call carries no deadline: a stalled dispatch would hold ingest forever');
  assert(1.5 <= call.timeout && call.timeout <= 2.5, \`the deadline must be about 2 s, got \${call.timeout} s\`);
  ctx.grpc.setLatency('CheckGeofence', 5.0);
  const before = ctx.clock.now();
  const checked = await m.checkGeofence('v-1', pos(2000, 43));
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited < 3, \`checkGeofence waited \${waited.toFixed(1)} s for a dispatch that answers after 5 s: the 2 s deadline must end the call\`);
  assert.strictEqual(checked, false, 'a dispatch slower than the deadline is a failed check, not an answered one');
}

export async function check_enqueue_on_failure(ctx) {
  const {m} = geofence(ctx);
  ctx.grpc.fail('CheckGeofence', ctx.grpc.status.DEADLINE_EXCEEDED, 'deadline exceeded', 1);
  assert.strictEqual(await m.checkGeofence('v-1', pos(1000, 42)), false, 'a timed-out check must return false');
  assert.equal(calls(ctx).length, 1, \`the first attempt made \${calls(ctx).length} calls, expected 1\`);
  await m.retryPending();
  assert.equal(calls(ctx).length, 2, \`after a check timed out, retryPending made \${calls(ctx).length - 1} new calls, expected 1: a timed-out check is queued and retried, not dropped (a warehouse alert would never fire)\`);
  const last = calls(ctx).at(-1).request;
  assert(last.vehicle_id === 'v-1' && Number(last.sequence) === 42, \`the retry carried vehicle \${JSON.stringify(last.vehicle_id)} sequence \${last.sequence}, expected the queued position v-1 / 42\`);
  await m.retryPending();
  assert.equal(calls(ctx).length, 2, 'once the retry succeeded the queue is empty: nothing to send again');
}

export async function check_idempotency_key(ctx) {
  const {m, alerts} = geofence(ctx);
  ctx.grpc.fail('CheckGeofence', ctx.grpc.status.UNAVAILABLE, 'dispatch restarting', 1);
  await m.checkGeofence('v-1', pos(1000, 42, 48.5));
  await m.retryPending();
  const keys = calls(ctx).map(c => c.request.idempotency_key);
  assert.equal(keys.length, 2, \`a failed check and its retry made \${keys.length} calls, expected 2\`);
  assert.equal(keys[0], 'geofence:v-1:42', \`the first attempt carried idempotency_key \${JSON.stringify(keys[0])}, expected geofence:v-1:42: dispatch dedupes alerts by this key\`);
  assert.equal(keys[1], keys[0], \`the retry carried idempotency_key \${JSON.stringify(keys[1])} after \${JSON.stringify(keys[0])}: a fresh key makes dispatch treat the retry as a new alert\`);
  ctx.grpc.fail('CheckGeofence', ctx.grpc.status.UNAVAILABLE, 'dispatch restarting', 1);
  await m.checkGeofence('v-2', pos(1000, 7, 48.5, -122.3, 'v-2'));
  await m.retryPending();
  assert.equal(calls(ctx).at(-1).request.idempotency_key, 'geofence:v-2:7', \`another vehicle's retry carried \${JSON.stringify(calls(ctx).at(-1).request.idempotency_key)}, expected geofence:v-2:7\`);
  assert.equal(alerts.length, 2, \`dispatch raised \${alerts.length} alerts for two vehicles inside the geofence, expected one each\`);
}

export async function check_no_stale_dispatch(ctx) {
  const {m} = geofence(ctx);
  ctx.grpc.fail('CheckGeofence', ctx.grpc.status.UNAVAILABLE, 'dispatch restarting', 1);
  assert.strictEqual(await m.checkGeofence('v-1', pos(1000, 42)), false, 'a failed check must return false');
  assert.strictEqual(await m.checkGeofence('v-1', pos(2000, 43)), true, 'the next position must be checked while the older one waits in the queue');
  await m.retryPending();
  assert.equal(calls(ctx).length, 2, \`retryPending sent the position at ts 1000 after dispatch had answered for ts 2000 (\${calls(ctx).length} calls): a queued position older than the last one dispatch saw is stale, drop it\`);
  await m.retryPending();
  assert.equal(calls(ctx).length, 2, 'the stale position must leave the queue, not stay for the next retry');
  assert.strictEqual(await m.checkGeofence('v-1', pos(3000, 44)), true, 'a newer position after the stale one must still be checked');
}
`,
    go: `package main

import (
	"context"
	"slices"
	"sync"
	"time"

	"google.golang.org/grpc/codes"

	"leetbuild/harness"

	pb "fleet/gen/dispatch"
	"fleet/position"
)

// dispatchPeer is dispatch: the warehouse geofence is north of latitude 48; the first sight of a key raises the alert.
type dispatchPeer struct {
	pb.UnimplementedDispatchServer
	mu     sync.Mutex
	alerts []string
}

func (d *dispatchPeer) CheckGeofence(_ context.Context, req *pb.GeofenceCheckRequest) (*pb.GeofenceCheckResponse, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	inside := req.GetLat() > 48.0
	alert := inside && !slices.Contains(d.alerts, req.GetIdempotencyKey())
	if alert {
		d.alerts = append(d.alerts, req.GetIdempotencyKey())
	}
	zone := ""
	if inside {
		zone = "warehouse-7"
	}
	return &pb.GeofenceCheckResponse{Alert: alert, Zone: zone}, nil
}

func newDispatch(ctx *harness.Ctx) *dispatchPeer {
	peer := &dispatchPeer{}
	pb.RegisterDispatchServer(ctx.GRPC.Server(""), peer)
	return peer
}

func geofencePos(ts, seq int64, lat float64, vehicleID string) position.Position {
	return position.Position{VehicleID: vehicleID, DeviceTimestampMs: ts, Sequence: seq, Lat: lat, Lon: -122.3}
}

func geofenceCalls(ctx *harness.Ctx) []harness.Call { return ctx.GRPC.CallsTo("CheckGeofence", "") }

func CheckDeadline(ctx *harness.Ctx) {
	newDispatch(ctx)
	ctx.Equal(checkGeofence(context.Background(), "v-1", geofencePos(1000, 42, 47.6, "v-1")), true, "a check dispatch answers must return true; checked")
	calls := geofenceCalls(ctx)
	call := calls[len(calls)-1]
	ctx.Assert(call.HasDeadline(), "the CheckGeofence call carries no deadline: a stalled dispatch would hold ingest forever")
	ctx.Assert(1500*time.Millisecond <= call.Timeout && call.Timeout <= 2500*time.Millisecond, "the deadline must be about 2 s, got %v", call.Timeout)
	ctx.GRPC.SetLatency("CheckGeofence", 5.0, "")
	before := ctx.Clock.Now()
	checked := checkGeofence(context.Background(), "v-1", geofencePos(2000, 43, 47.6, "v-1"))
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited < 3, "checkGeofence waited %.1f s for a dispatch that answers after 5 s: the 2 s deadline must end the call", waited)
	ctx.Equal(checked, false, "a dispatch slower than the deadline is a failed check, not an answered one; checked")
}

func CheckEnqueueOnFailure(ctx *harness.Ctx) {
	newDispatch(ctx)
	ctx.GRPC.Fail("CheckGeofence", codes.DeadlineExceeded, "deadline exceeded", 1, "")
	ctx.Equal(checkGeofence(context.Background(), "v-1", geofencePos(1000, 42, 47.6, "v-1")), false, "a timed-out check must return false; checked")
	ctx.Equal(len(geofenceCalls(ctx)), 1, "the first attempt's calls")
	retryPending(context.Background())
	ctx.Equal(len(geofenceCalls(ctx)), 2, "after a check timed out, retryPending must make one new call: a timed-out check is queued and retried, not dropped (a warehouse alert would never fire); the calls so far")
	calls := geofenceCalls(ctx)
	last, _ := calls[len(calls)-1].Request.(*pb.GeofenceCheckRequest)
	ctx.Assert(last.GetVehicleId() == "v-1" && last.GetSequence() == 42, "the retry carried vehicle %q sequence %d, expected the queued position v-1 / 42", last.GetVehicleId(), last.GetSequence())
	retryPending(context.Background())
	ctx.Equal(len(geofenceCalls(ctx)), 2, "once the retry succeeded the queue is empty: nothing to send again; the calls")
}

func CheckIdempotencyKey(ctx *harness.Ctx) {
	peer := newDispatch(ctx)
	ctx.GRPC.Fail("CheckGeofence", codes.Unavailable, "dispatch restarting", 1, "")
	checkGeofence(context.Background(), "v-1", geofencePos(1000, 42, 48.5, "v-1"))
	retryPending(context.Background())
	var keys []string
	for _, c := range geofenceCalls(ctx) {
		req, _ := c.Request.(*pb.GeofenceCheckRequest)
		keys = append(keys, req.GetIdempotencyKey())
	}
	ctx.Equal(len(keys), 2, "a failed check and its retry; the calls")
	ctx.Equal(keys[0], "geofence:v-1:42", "the first attempt's idempotency_key (dispatch dedupes alerts by this key)")
	ctx.Equal(keys[1], keys[0], "the retry's idempotency_key must repeat the first attempt's: a fresh key makes dispatch treat the retry as a new alert")
	ctx.GRPC.Fail("CheckGeofence", codes.Unavailable, "dispatch restarting", 1, "")
	checkGeofence(context.Background(), "v-2", geofencePos(1000, 7, 48.5, "v-2"))
	retryPending(context.Background())
	calls := geofenceCalls(ctx)
	req, _ := calls[len(calls)-1].Request.(*pb.GeofenceCheckRequest)
	ctx.Equal(req.GetIdempotencyKey(), "geofence:v-2:7", "another vehicle's retry's idempotency_key")
	ctx.Equal(len(peer.alerts), 2, "dispatch's alerts for two vehicles inside the geofence (one each)")
}

func CheckNoStaleDispatch(ctx *harness.Ctx) {
	newDispatch(ctx)
	ctx.GRPC.Fail("CheckGeofence", codes.Unavailable, "dispatch restarting", 1, "")
	ctx.Equal(checkGeofence(context.Background(), "v-1", geofencePos(1000, 42, 47.6, "v-1")), false, "a failed check must return false; checked")
	ctx.Equal(checkGeofence(context.Background(), "v-1", geofencePos(2000, 43, 47.6, "v-1")), true, "the next position must be checked while the older one waits in the queue; checked")
	retryPending(context.Background())
	ctx.Equal(len(geofenceCalls(ctx)), 2, "retryPending sent the position at ts 1000 after dispatch had answered for ts 2000: a queued position older than the last one dispatch saw is stale, drop it; the calls")
	retryPending(context.Background())
	ctx.Equal(len(geofenceCalls(ctx)), 2, "the stale position must leave the queue, not stay for the next retry; the calls")
	ctx.Equal(checkGeofence(context.Background(), "v-1", geofencePos(3000, 44, 47.6, "v-1")), true, "a newer position after the stale one must still be checked; checked")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <algorithm>
#include <mutex>
#include <string>
#include <vector>

namespace {

// Dispatch: the warehouse geofence is north of latitude 48; the first sight of a key raises the alert.
class DispatchPeer final : public fleet::Dispatch::Service {
 public:
  std::mutex mu;
  std::vector<std::string> alerts;

  grpc::Status CheckGeofence(grpc::ServerContext*, const fleet::GeofenceCheckRequest* req,
                             fleet::GeofenceCheckResponse* res) override {
    std::lock_guard<std::mutex> lock(mu);
    const bool inside = req->lat() > 48.0;
    const bool alert = inside && std::find(alerts.begin(), alerts.end(), req->idempotency_key()) == alerts.end();
    if (alert) alerts.push_back(req->idempotency_key());
    res->set_alert(alert);
    res->set_zone(inside ? "warehouse-7" : "");
    return grpc::Status::OK;
  }
};

DispatchPeer* newDispatch(harness::Ctx& ctx) {
  static DispatchPeer* peer = nullptr;
  delete peer;
  peer = new DispatchPeer;
  ctx.GRPC.Server("")->RegisterService(peer);
  return peer;
}

Position geofencePos(long long ts, long long seq, double lat = 47.6, const std::string& vehicle_id = "v-1") {
  return Position{vehicle_id, ts, seq, lat, -122.3};
}

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  newDispatch(ctx);
  ctx.Equal(check_geofence("v-1", geofencePos(1000, 42)), true, "a check dispatch answers must return true; checked");
  const auto calls = ctx.GRPC.CallsTo("CheckGeofence");
  const auto& call = calls.back();
  ctx.Assert(call.HasDeadline(), "the CheckGeofence call carries no deadline: a stalled dispatch would hold ingest forever");
  ctx.Assert(1.5 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 2.5, "the deadline must be about 2 s, got %vs",
             call.TimeoutSeconds());
  ctx.GRPC.SetLatency("CheckGeofence", 5.0);
  const int64_t before = ctx.Clock.Now();
  const bool checked = check_geofence("v-1", geofencePos(2000, 43));
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited < 3, "check_geofence waited %.1f s for a dispatch that answers after 5 s: the 2 s deadline must end the call",
             waited);
  ctx.Equal(checked, false, "a dispatch slower than the deadline is a failed check, not an answered one; checked");
}

void CheckEnqueueOnFailure(harness::Ctx& ctx) {
  newDispatch(ctx);
  ctx.GRPC.Fail("CheckGeofence", grpc::StatusCode::DEADLINE_EXCEEDED, "deadline exceeded", 1);
  ctx.Equal(check_geofence("v-1", geofencePos(1000, 42)), false, "a timed-out check must return false; checked");
  ctx.Equal(ctx.GRPC.CallsTo("CheckGeofence").size(), 1, "the first attempt's calls");
  retry_pending();
  ctx.Equal(ctx.GRPC.CallsTo("CheckGeofence").size(), 2,
            "after a check timed out, retry_pending must make one new call: a timed-out check is queued and retried, "
            "not dropped (a warehouse alert would never fire); the calls so far");
  const auto last = ctx.GRPC.CallsTo("CheckGeofence").back().Request<fleet::GeofenceCheckRequest>();
  ctx.Assert(last.vehicle_id() == "v-1" && last.sequence() == 42,
             "the retry carried vehicle %q sequence %d, expected the queued position v-1 / 42", last.vehicle_id(),
             last.sequence());
  retry_pending();
  ctx.Equal(ctx.GRPC.CallsTo("CheckGeofence").size(), 2, "once the retry succeeded the queue is empty: nothing to send again; the calls");
}

void CheckIdempotencyKey(harness::Ctx& ctx) {
  auto* peer = newDispatch(ctx);
  ctx.GRPC.Fail("CheckGeofence", grpc::StatusCode::UNAVAILABLE, "dispatch restarting", 1);
  check_geofence("v-1", geofencePos(1000, 42, 48.5));
  retry_pending();
  std::vector<std::string> keys;
  for (const auto& c : ctx.GRPC.CallsTo("CheckGeofence")) keys.push_back(c.Request<fleet::GeofenceCheckRequest>().idempotency_key());
  ctx.Equal(keys.size(), 2, "a failed check and its retry; the calls");
  ctx.Equal(keys[0], "geofence:v-1:42", "the first attempt's idempotency_key (dispatch dedupes alerts by this key)");
  ctx.Equal(keys[1], keys[0],
            "the retry's idempotency_key must repeat the first attempt's: a fresh key makes dispatch treat the retry as a new alert");
  ctx.GRPC.Fail("CheckGeofence", grpc::StatusCode::UNAVAILABLE, "dispatch restarting", 1);
  check_geofence("v-2", geofencePos(1000, 7, 48.5, "v-2"));
  retry_pending();
  ctx.Equal(ctx.GRPC.CallsTo("CheckGeofence").back().Request<fleet::GeofenceCheckRequest>().idempotency_key(), "geofence:v-2:7",
            "another vehicle's retry's idempotency_key");
  ctx.Equal(peer->alerts.size(), 2, "dispatch's alerts for two vehicles inside the geofence (one each)");
}

void CheckNoStaleDispatch(harness::Ctx& ctx) {
  newDispatch(ctx);
  ctx.GRPC.Fail("CheckGeofence", grpc::StatusCode::UNAVAILABLE, "dispatch restarting", 1);
  ctx.Equal(check_geofence("v-1", geofencePos(1000, 42)), false, "a failed check must return false; checked");
  ctx.Equal(check_geofence("v-1", geofencePos(2000, 43)), true, "the next position must be checked while the older one waits in the queue; checked");
  retry_pending();
  ctx.Equal(ctx.GRPC.CallsTo("CheckGeofence").size(), 2,
            "retry_pending sent the position at ts 1000 after dispatch had answered for ts 2000: a queued position older "
            "than the last one dispatch saw is stale, drop it; the calls");
  retry_pending();
  ctx.Equal(ctx.GRPC.CallsTo("CheckGeofence").size(), 2, "the stale position must leave the queue, not stay for the next retry; the calls");
  ctx.Equal(check_geofence("v-1", geofencePos(3000, 44)), true, "a newer position after the stale one must still be checked; checked");
}
`,
  },
  debrief: `The key is derived from the position rather than minted per attempt because an idempotency key names the work, and the work is "check sequence 42 of v-1"; any attempt that names it the same lets dispatch recognise a repeat. Once retries are safe, dropping a timed-out call stops being prudent and becomes the bug: the deadline decides when to give up on this attempt, the queue decides that the work is still owed. The staleness test sits on the retry path because that is the only place an old position can reach dispatch after a newer one. Production systems keep the queue durable (a Redis list or a retry topic), back off between attempts, and keep the per-vehicle watermark in Redis so every replica agrees on what dispatch has seen.`,
};
