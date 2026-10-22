import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Dispatch calls that never lose an alert',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'dispatch'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it opens a gRPC call to the
dispatch service, sends the position and swallows a timeout. It compiles, it serves the demo, and it
hides two production flaws. Review it like the service owner, fix it, and prove the fix with the
checks below.

Implement the geofence/route-deviation check as a gRPC call with a bounded deadline and a durable
retry contract.

- Each call carries a **2-second deadline**. A check that has not answered inside the deadline is a
  failure, not a success.
- When the call fails (deadline exceeded, unavailable, any \`RpcError\`), the position is **enqueued
  for retry**, never dropped. Losing the check means a warehouse geofence alert never fires.
- The retry uses the **position sequence as its idempotency key** — the same
  \`geofence:{vehicle_id}:{sequence}\` value on the first attempt and on every retry — so a late
  retry cannot fire the alert twice.
- Never mint a fresh key for a retry: a new key makes the dispatch service treat a replay as a new
  alert.
- Dispatch must never receive a **stale** position: when the incoming position's timestamp is not
  newer than the vehicle's last dispatched timestamp, the check is skipped.

**Failure mode the checks target.** The draft drops the check when the call times out, and the
natural "fix" — retrying with a fresh key — duplicates alerts. The checks verify the deadline, the
sequence-derived idempotency key, the enqueue on failure, the absence of a fresh key, and the stale
guard.`,
  sequence: {
    participants: ['Position API', 'Dispatch', 'Retry queue'],
    messages: [
      {from: 'Position API', to: 'Position API', label: 'skip when position is not newer', kind: 'sync'},
      {from: 'Position API', to: 'Dispatch', label: 'CheckGeofence(idempotency_key=seq, deadline=2s)', kind: 'sync'},
      {from: 'Dispatch', to: 'Position API', label: 'OK: no alert / alert fired', kind: 'reply'},
      {from: 'Dispatch', to: 'Position API', label: 'DEADLINE_EXCEEDED', kind: 'reply'},
      {from: 'Position API', to: 'Retry queue', label: 'enqueue(vehicle, position, same key)', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Uses a 2-second deadline per check',
      detail:
        'The call is bounded by a 2-second deadline, so a slow dispatch cannot hang ingest. The draft uses a one-second timeout and treats the result as final.',
      match: {
        python: {all: [/GEOFENCE_DEADLINE/, /timeout/]},
        typescript: {all: [/GEOFENCE_DEADLINE/, /deadline/]},
        go: {all: [/WithTimeout/, /time\.(Second|Millisecond)/]},
        scala: {all: [/GeofenceDeadlineMs/, /withDeadline/]},
        cpp: {all: [/kGeofenceDeadlineMs/, /set_deadline/]},
      },
    },
    {
      id: 'idempotency-key',
      title: 'Keys the check by the position sequence',
      detail:
        'The idempotency key is derived from the vehicle and the position `sequence`, so the first attempt and every retry carry the same key and an alert fires once. The draft sends no key.',
      match: {
        python: {all: [/idempotency_key/, /sequence/]},
        typescript: {all: [/idempotencyKey/, /sequence/]},
        go: {all: [/idempotencyKey/, /Sequence/]},
        scala: {all: [/idempotencyKey/, /sequence/]},
        cpp: {all: [/idempotency_key/, /sequence/]},
      },
    },
    {
      id: 'enqueue-on-failure',
      title: 'Enqueues the check when the call fails',
      detail:
        'A failed check is enqueued for retry instead of being dropped, so the alert is never lost. The draft (and the fix) must enqueue; the key choice is what the other checks test.',
      match: {
        python: {all: [/queue\.enqueue\(/]},
        typescript: {all: [/queue\.enqueue\(/]},
        go: {all: [/\.Enqueue\(/]},
        scala: {all: [/queue\.enqueue\(/]},
        cpp: {all: [/queue->enqueue\(/]},
      },
    },
    {
      id: 'no-fresh-key',
      title: 'Never mints a fresh key on retry',
      detail:
        'The key is stable across attempts. The draft generates a new identifier for each attempt, which lets a late retry fire a second alert.',
      match: {
        python: {none: [/uuid|random/]},
        typescript: {none: [/randomUUID|uuid/]},
        go: {none: [/uuid/]},
        scala: {none: [/UUID|randomUUID/]},
        cpp: {none: [/uuid|Uuid/]},
      },
    },
    {
      id: 'no-stale-dispatch',
      title: 'Never dispatches a stale position',
      detail:
        'A position whose timestamp is not newer than the vehicle last dispatched timestamp is skipped, so dispatch never acts on a rolled-back position.',
      match: {
        python: {all: [/device_timestamp_ms/, /last_dispatched/]},
        typescript: {all: [/device_timestamp_ms/, /lastDispatched/]},
        go: {all: [/DeviceTimestampMs/, /lastDispatched/]},
        scala: {all: [/deviceTimestampMs/, /lastDispatched/]},
        cpp: {all: [/device_timestamp_ms/, /lastDispatchedTs/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc
import uuid

import dispatch_pb2
import dispatch_pb2_grpc


class RetryQueue:
    def enqueue(self, vehicle_id: str, position: dict, key: str) -> None:
        """Schedule the check for a later attempt."""
        raise NotImplementedError


def check_geofence(channel, vehicle_id: str, position: dict, queue: RetryQueue) -> bool:
    # TODO: this draft drops the check when the call times out and mints a fresh key on the retry
    # path, which lets a late retry fire the alert twice. Review the deadline, the key and the
    # failure path.
    stub = dispatch_pb2_grpc.DispatchStub(channel)
    request = dispatch_pb2.GeofenceCheckRequest(
        vehicle_id=vehicle_id,
        lat=position["lat"],
        lon=position["lon"],
    )
    try:
        stub.CheckGeofence(request, timeout=1)
        return True
    except grpc.RpcError:
        queue.enqueue(vehicle_id, position, str(uuid.uuid4()))
        return False
`,
      solution: `import grpc

import dispatch_pb2
import dispatch_pb2_grpc

GEOFENCE_DEADLINE_MS = 2000


class RetryQueue:
    def enqueue(self, vehicle_id: str, position: dict, idempotency_key: str) -> None:
        """Schedule the check for a later attempt under the same key."""
        raise NotImplementedError


def check_geofence(
    channel,
    vehicle_id: str,
    position: dict,
    last_dispatched_ts: int,
    queue: RetryQueue,
) -> bool:
    if position["device_timestamp_ms"] <= last_dispatched_ts:
        return False
    stub = dispatch_pb2_grpc.DispatchStub(channel)
    idempotency_key = f"geofence:{vehicle_id}:{position['sequence']}"
    request = dispatch_pb2.GeofenceCheckRequest(
        vehicle_id=vehicle_id,
        lat=position["lat"],
        lon=position["lon"],
        sequence=position["sequence"],
        idempotency_key=idempotency_key,
    )
    try:
        stub.CheckGeofence(request, timeout=GEOFENCE_DEADLINE_MS / 1000, wait_for_ready=False)
        return True
    except grpc.RpcError:
        queue.enqueue(vehicle_id, position, idempotency_key)
        return False
`,
    },
    typescript: {
      starter: `/** Geofence check: a model-generated draft that swallows the timeout. */
import {randomUUID} from 'node:crypto';

import type {DispatchClient} from './generated/dispatch_grpc_pb';

export interface Position {
  vehicle_id: string;
  device_timestamp_ms: number;
  sequence: number;
  lat: number;
  lon: number;
}

export interface RetryQueue {
  enqueue(vehicleId: string, position: Position, key: string): Promise<void>;
}

export async function checkGeofence(
  client: DispatchClient,
  vehicleId: string,
  position: Position,
  queue: RetryQueue,
): Promise<boolean> {
  // TODO: this draft drops the check when the call times out and mints a fresh key on the retry
  // path, which lets a late retry fire the alert twice. Review the deadline, the key and the
  // failure path.
  const {promise, resolve} = Promise.withResolvers<boolean>();
  client.checkGeofence({vehicleId, lat: position.lat, lon: position.lon}, (error: Error | null) => {
    if (error === null) {
      resolve(true);
      return;
    }
    void queue.enqueue(vehicleId, position, randomUUID()).then(() => resolve(false));
  });
  return promise;
}
`,
      solution: `/** Geofence check: bounded deadline, sequence-keyed retries, stale guard. */
import type {DispatchClient} from './generated/dispatch_grpc_pb';

export interface Position {
  vehicle_id: string;
  device_timestamp_ms: number;
  sequence: number;
  lat: number;
  lon: number;
}

export interface RetryQueue {
  enqueue(vehicleId: string, position: Position, idempotencyKey: string): Promise<void>;
}

const GEOFENCE_DEADLINE_MS = 2_000;

export async function checkGeofence(
  client: DispatchClient,
  vehicleId: string,
  position: Position,
  lastDispatchedTs: number,
  queue: RetryQueue,
): Promise<boolean> {
  if (position.device_timestamp_ms <= lastDispatchedTs) return false;
  const idempotencyKey = \`geofence:\${vehicleId}:\${position.sequence}\`;
  const deadline = new Date(Date.now() + GEOFENCE_DEADLINE_MS);
  const {promise, resolve, reject} = Promise.withResolvers<void>();
  try {
    client.checkGeofence(
      {
        vehicleId,
        lat: position.lat,
        lon: position.lon,
        sequence: position.sequence,
        idempotencyKey,
      },
      {deadline},
      (error: Error | null) => (error === null ? resolve() : reject(error)),
    );
    await promise;
    return true;
  } catch {
    await queue.enqueue(vehicleId, position, idempotencyKey);
    return false;
  }
}
`,
    },
    go: {
      starter: `package client

import (
	"context"

	"github.com/google/uuid"

	pb "fleet/proto/dispatch"
)

type RetryQueue interface {
	Enqueue(vehicleID string, position Position, key string) error
}

type Position struct {
	VehicleID         string  \`json:"vehicle_id"\`
	DeviceTimestampMs int64   \`json:"device_timestamp_ms"\`
	Sequence          int     \`json:"sequence"\`
	Lat               float64 \`json:"lat"\`
	Lon               float64 \`json:"lon"\`
}

func CheckGeofence(ctx context.Context, client pb.DispatchClient, vehicleID string, pos Position, queue RetryQueue) (bool, error) {
	// TODO: this draft drops the check when the call times out and mints a fresh key on the retry
	// path, which lets a late retry fire the alert twice. Review the deadline, the key and the
	// failure path.
	_, err := client.CheckGeofence(ctx, &pb.GeofenceCheckRequest{
		VehicleId: vehicleID,
		Lat:       pos.Lat,
		Lon:       pos.Lon,
	})
	if err != nil {
		if qErr := queue.Enqueue(vehicleID, pos, uuid.NewString()); qErr != nil {
			return false, qErr
		}
		return false, nil
	}
	return true, nil
}
`,
      solution: `package client

import (
	"context"
	"fmt"
	"time"

	pb "fleet/proto/dispatch"
)

const geofenceDeadlineMs = 2_000

type RetryQueue interface {
	Enqueue(vehicleID string, position Position, idempotencyKey string) error
}

type Position struct {
	VehicleID         string  \`json:"vehicle_id"\`
	DeviceTimestampMs int64   \`json:"device_timestamp_ms"\`
	Sequence          int     \`json:"sequence"\`
	Lat               float64 \`json:"lat"\`
	Lon               float64 \`json:"lon"\`
}

func CheckGeofence(
	ctx context.Context,
	client pb.DispatchClient,
	vehicleID string,
	pos Position,
	lastDispatchedTs int64,
	queue RetryQueue,
) (bool, error) {
	if pos.DeviceTimestampMs <= lastDispatchedTs {
		return false, nil
	}
	idempotencyKey := fmt.Sprintf("geofence:%s:%d", vehicleID, pos.Sequence)
	callCtx, cancel := context.WithTimeout(ctx, time.Duration(geofenceDeadlineMs)*time.Millisecond)
	defer cancel()
	_, err := client.CheckGeofence(callCtx, &pb.GeofenceCheckRequest{
		VehicleId:      vehicleID,
		Lat:            pos.Lat,
		Lon:            pos.Lon,
		Sequence:       int32(pos.Sequence),
		IdempotencyKey: idempotencyKey,
	})
	if err != nil {
		if qErr := queue.Enqueue(vehicleID, pos, idempotencyKey); qErr != nil {
			return false, qErr
		}
		return false, nil
	}
	return true, nil
}
`,
    },
    scala: {
      starter: `import java.util.UUID

import scala.concurrent.Future

object GeofenceClient {
  final case class Position(
      vehicleId: String,
      deviceTimestampMs: Long,
      sequence: Int,
      lat: Double,
      lon: Double,
  )

  trait RetryQueue {
    def enqueue(vehicleId: String, position: Position, key: String): Future[Unit]
  }

  def checkGeofence(
      client: DispatchServiceClient,
      vehicleId: String,
      position: Position,
      queue: RetryQueue,
  )(implicit ec: scala.concurrent.ExecutionContext): Future[Boolean] = {
    // TODO: this draft drops the check when the call times out and mints a fresh key on the retry
    // path, which lets a late retry fire the alert twice. Review the deadline, the key and the
    // failure path.
    client
      .checkGeofence(GeofenceCheckRequest(vehicleId = vehicleId, lat = position.lat, lon = position.lon))
      .map(_ => true)
      .recoverWith { case _: Throwable =>
        queue.enqueue(vehicleId, position, UUID.randomUUID().toString).map(_ => false)
      }
  }
}
`,
      solution: `import scala.concurrent.Future
import scala.concurrent.duration._

object GeofenceClient {
  val GeofenceDeadlineMs = 2_000

  final case class Position(
      vehicleId: String,
      deviceTimestampMs: Long,
      sequence: Int,
      lat: Double,
      lon: Double,
  )

  trait RetryQueue {
    def enqueue(vehicleId: String, position: Position, idempotencyKey: String): Future[Unit]
  }

  def checkGeofence(
      client: DispatchServiceClient,
      vehicleId: String,
      position: Position,
      lastDispatchedTs: Long,
      queue: RetryQueue,
  )(implicit ec: scala.concurrent.ExecutionContext): Future[Boolean] = {
    if (position.deviceTimestampMs <= lastDispatchedTs) Future.successful(false)
    else {
      val idempotencyKey = s"geofence:$vehicleId:\${position.sequence}"
      val deadline = GeofenceDeadlineMs.millis
      client
        .withDeadline(deadline)
        .checkGeofence(
          GeofenceCheckRequest(
            vehicleId = vehicleId,
            lat = position.lat,
            lon = position.lon,
            sequence = position.sequence,
            idempotencyKey = idempotencyKey,
          ),
        )
        .map(_ => true)
        .recoverWith { case _: Throwable =>
          queue.enqueue(vehicleId, position, idempotencyKey).map(_ => false)
        }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <memory>
#include <string>

#include "dispatch.grpc.pb.h"

struct Position {
  std::string vehicle_id;
  long long device_timestamp_ms;
  int sequence;
  double lat;
  double lon;
};

struct RetryQueue {
  void enqueue(const std::string& vehicleId, const Position& position, const std::string& key);
};

std::string uuidString();

Position checkGeofence(grpc::ChannelInterface* channel,
                       const std::string& vehicleId,
                       const Position& position,
                       RetryQueue* queue) {
  // TODO: this draft drops the check when the call times out and mints a fresh key on the retry
  // path, which lets a late retry fire the alert twice. Review the deadline, the key and the
  // failure path.
  auto stub = DispatchService::NewStub(channel->shared_from_this());
  grpc::ClientContext context;
  GeofenceCheckRequest request;
  request.set_vehicle_id(vehicleId);
  request.set_lat(position.lat);
  request.set_lon(position.lon);
  GeofenceCheckResponse response;
  const auto status = stub->CheckGeofence(&context, request, &response);
  if (!status.ok()) {
    queue->enqueue(vehicleId, position, uuidString());
    return position;
  }
  return position;
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <memory>
#include <string>

#include "dispatch.grpc.pb.h"

constexpr long long kGeofenceDeadlineMs = 2'000;

struct Position {
  std::string vehicle_id;
  long long device_timestamp_ms;
  int sequence;
  double lat;
  double lon;
};

struct RetryQueue {
  void enqueue(const std::string& vehicleId, const Position& position, const std::string& idempotencyKey);
};

bool checkGeofence(grpc::ChannelInterface* channel,
                   const std::string& vehicleId,
                   const Position& position,
                   long long lastDispatchedTs,
                   RetryQueue* queue) {
  if (position.device_timestamp_ms <= lastDispatchedTs) return false;
  auto stub = DispatchService::NewStub(channel->shared_from_this());
  const std::string idempotencyKey =
      "geofence:" + vehicleId + ":" + std::to_string(position.sequence);
  grpc::ClientContext context;
  context.set_deadline(std::chrono::system_clock::now() +
                       std::chrono::milliseconds(kGeofenceDeadlineMs));
  GeofenceCheckRequest request;
  request.set_vehicle_id(vehicleId);
  request.set_lat(position.lat);
  request.set_lon(position.lon);
  request.set_sequence(position.sequence);
  request.set_idempotency_key(idempotencyKey);
  GeofenceCheckResponse response;
  const auto status = stub->CheckGeofence(&context, request, &response);
  if (!status.ok()) {
    queue->enqueue(vehicleId, position, idempotencyKey);
    return false;
  }
  return true;
}
`,
    },
  },
  hints: [
    'Bound the call with the deadline before you worry about the failure path: `timeout=GEOFENCE_DEADLINE_MS / 1000` in Python, `{deadline}` in grpc-js, `context.WithTimeout` in Go, `withDeadline` in Scala, `set_deadline` in C++.',
    'The idempotency key is `geofence:{vehicle_id}:{sequence}` and it is computed **before** the call, then passed both to the request and to the retry queue. The same value on every attempt is what makes the alert fire once.',
    'The stale guard is one comparison: `device_timestamp_ms <= last_dispatched_ts`. Skipping the call is correct — dispatch must not act on a position the map has already superseded.',
  ],
  debrief: `The interviewer is testing whether you can review a generated RPC call. The draft reads fine because the demo has a fast dispatch service that never times out. Two defects are being checked: dropping the check on failure (the alert is lost) and minting a fresh key on retry (the alert fires twice). The sequence-derived idempotency key is the piece that makes the retry safe: the dispatch service can dedupe on it, so "at least once" delivery becomes "exactly once" alerting. Real systems add an outbox for the enqueue itself, exponential backoff with jitter, and a per-vehicle dedupe window keyed by sequence.`,
};
