import type {Step} from '@/lib/types';

// ---- 1. POST /v1/vehicles/positions -----------------------------------------------------------------
export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/vehicles/positions: admit a batch, or none of it',
  concept: 'http',
  guides: ['request-boundaries'],
  file: 'api',
  focus: ['device', 'api'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/vehicles/positions\` with body
\`{"batch_id": "b-1", "updates": [{"vehicle_id": "v-1", "device_timestamp_ms": 1710000000000, "sequence": 42, "lat": 47.6, "lon": -122.3}]}\`
and the tenant in \`X-Tenant-Id\`. For each update it validates the shape and ranges, hands it to
\`record_position\` (step 4, which writes the state of step 2 and publishes the event) and answers
\`{"accepted": N, "duplicate": 0}\`. It serves the demo and hides four flaws.

**Failure mode the checks target.** Devices send batches from a cell network with a clock nobody
calibrated, and replay their buffer after a reconnect. A batch is one unit: it is admitted whole
or rejected whole, with nothing written on rejection; a device cannot date a position last year;
and the response says what the state did with each update.

- A missing or empty \`X-Tenant-Id\` is **401**.
- \`vehicle_id\` non-empty string, \`device_timestamp_ms\` positive integer, \`sequence\` non-negative
  integer, \`lat\` within \`[-90, 90]\`, \`lon\` within \`[-180, 180]\`; an empty \`updates\` list or any
  invalid update is **400** for the whole batch, written nowhere.
- \`abs(server_now_ms - device_timestamp_ms) > MAX_SKEW_MS\` (300 000 ms, five minutes) is **400**
  the same way.
- \`accepted\` counts the updates \`record_position\` applied, \`duplicate\` the ones it ignored.`,
  sequence: {
    participants: ['Device', 'fleetd', 'events (step 4)'],
    messages: [
      {from: 'Device', to: 'fleetd', label: 'POST /v1/vehicles/positions · X-Tenant-Id: t-1 · 3 updates', kind: 'sync'},
      {from: 'fleetd', to: 'fleetd', label: 'validate all 3 · skew ≤ 5 min', kind: 'sync'},
      {from: 'fleetd', to: 'events (step 4)', label: 'record_position(v-1, …) → applied', kind: 'sync'},
      {from: 'fleetd', to: 'events (step 4)', label: 'record_position(v-2, …) → ignored (replay)', kind: 'sync'},
      {from: 'fleetd', to: 'Device', label: '200 {accepted: 2, duplicate: 1}', kind: 'reply'},
      {from: 'Device', to: 'fleetd', label: 'POST … update 3 has lat 200', kind: 'sync'},
      {from: 'fleetd', to: 'Device', label: '400 · nothing written', kind: 'reply'},
    ],
  },
  hints: [
    'A device with its clock a year behind is drawn on the map; after a cell reconnect its replayed batch answers "accepted: 40" though nothing moved; a batch rejected with 400 still moved two vehicles.',
    "The starter validates each update in the loop that writes it, so the third update's 400 comes after two writes; it has no skew test; it answers `len(updates)` instead of what `record_position` returned.",
    '401 without a tenant; one loop validates every update (shape, then `abs(now_ms - device_timestamp_ms) > MAX_SKEW_MS`) and returns 400 before a second loop writes; count `accepted` and `duplicate` from `record_position`.',
  ],
  checks: [
    {
      id: 'route',
      title: 'POST /v1/vehicles/positions records a valid batch',
      detail:
        'A valid batch with a tenant answers 200 `{accepted, duplicate}` and every update reaches `record_position`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/vehicles\/positions["']/, /record_position\(/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/vehicles\/positions['"]/, /recordPosition\(/]},
        go: {all: [/"POST \/v1\/vehicles\/positions"/, /recordPosition\(/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"vehicles"\s*\/\s*"positions"\s*\)/, /recordPosition\(/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/vehicles\/positions"/, /record_position\(/]},
      },
    },
    {
      id: 'tenant',
      title: 'No tenant, no write: 401',
      detail:
        'A request without `X-Tenant-Id` answers 401 and records nothing. The starter takes an empty tenant and writes.',
      match: {
        python: {all: [/status_code\s*=\s*401/], none: [/headers\.get\(\s*["']x-tenant-id["']\s*,\s*["']["']\s*\)/i]},
        typescript: {all: [/code\(\s*401\s*\)/], none: [/\?\?\s*['"]['"]/]},
        go: {all: [/http\.StatusUnauthorized|\b401\b/]},
        scala: {all: [/StatusCodes\.Unauthorized|\b401\b/], none: [/tenant\s*=\s*header\.getOrElse\(\s*""\s*\)/]},
        cpp: {all: [/status\s*=\s*401/]},
      },
    },
    {
      id: 'validate-first',
      title: 'Every update validated before any write',
      detail:
        'An invalid third update rejects the batch with 400 and the first two are not written. The starter writes each update as soon as it has validated it.',
      match: {
        python: {
          all: [/\b400\b/, /record_position\(/],
          none: [/if error[^\n]*:\s*\n\s*(return|raise)[^\n]*\n\s*(applied\s*=\s*)?record_position\(/],
        },
        typescript: {
          all: [/\b400\b/, /recordPosition\(/],
          none: [/if \(error[^\n]*\n\s*(const applied = |if \()?\s*(await )?recordPosition\(/],
        },
        go: {
          all: [/\b400\b|StatusBadRequest/, /recordPosition\(/],
          none: [/return\s*\n\s*\}\s*\n\s*(if )?(_|applied), err :?= recordPosition\(/],
        },
        scala: {
          all: [/BadRequest|\b400\b/, /recordPosition\(/],
          none: [/if \(error\.isEmpty\)\s*Events\.recordPosition\(/],
        },
        cpp: {all: [/\b400\b/, /record_position\(/], none: [/return;\s*\n\s*\}\s*\n\s*(if \()?record_position\(/]},
      },
    },
    {
      id: 'skew',
      title: 'A device timestamp more than five minutes off is 400',
      detail:
        '`abs(server_now_ms - device_timestamp_ms) > MAX_SKEW_MS` (300 000) rejects the batch with 400 and writes nothing; four minutes either way is accepted. The starter trusts the device clock.',
      match: {
        python: {all: [/MAX_SKEW_MS\s*=\s*300_?000/, /abs\(/, /MAX_SKEW_MS/]},
        typescript: {all: [/MAX_SKEW_MS\s*=\s*300_?000/, /Math\.abs\(/, /MAX_SKEW_MS/]},
        go: {all: [/maxSkewMs\s*=\s*300_?000/, /math\.Abs\(|Abs\(/, /maxSkewMs/]},
        scala: {all: [/MaxSkewMs\s*=\s*300_?000L?/, /math\.abs\(/, /MaxSkewMs/]},
        cpp: {all: [/kMaxSkewMs\s*=\s*300_?000/, /llabs\(|std::abs\(/, /kMaxSkewMs/]},
      },
    },
    {
      id: 'counts',
      title: 'accepted and duplicate come from record_position',
      detail:
        'A batch replayed after a reconnect answers `{accepted: 0, duplicate: N}`; a batch with one new and one replayed update answers 1 and 1. The starter answers the batch size and 0.',
      match: {
        python: {
          all: [/duplicate\s*\+=\s*1|duplicate\s*=\s*duplicate\s*\+\s*1/],
          none: [/["']accepted["']:\s*len\(updates\)/],
        },
        typescript: {all: [/duplicate\s*(\+=\s*1|\+\+)/], none: [/accepted:\s*updates\.length/]},
        go: {all: [/duplicate(\+\+|\s*\+=\s*1)/], none: [/"accepted":\s*len\(/]},
        scala: {all: [/count\(identity\)|duplicate\s*\+=\s*1/], none: [/Result\(\s*batch\.updates\.size\s*,\s*0\s*\)/]},
        cpp: {
          all: [/duplicate(\+\+|\s*\+=\s*1)|: duplicate\)\+\+/],
          none: [/\{"accepted",\s*accepted\},\s*\{"duplicate",\s*0\}/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from events import record_position  # built in step 4: writes the latest position and publishes the event

app = FastAPI()
log = logging.getLogger("fleet")


def validate(update) -> str | None:
    """Why the update is not a position, or None."""
    if not isinstance(update, dict):
        return "update must be an object"
    if not isinstance(update.get("vehicle_id"), str) or update["vehicle_id"] == "":
        return "vehicle_id must be a non-empty string"
    ts = update.get("device_timestamp_ms")
    if not isinstance(ts, int) or isinstance(ts, bool) or ts <= 0:
        return "device_timestamp_ms must be a positive integer"
    seq = update.get("sequence")
    if not isinstance(seq, int) or isinstance(seq, bool) or seq < 0:
        return "sequence must be a non-negative integer"
    lat = update.get("lat")
    if not isinstance(lat, (int, float)) or isinstance(lat, bool) or not -90.0 <= lat <= 90.0:
        return "lat must be within [-90, 90]"
    lon = update.get("lon")
    if not isinstance(lon, (int, float)) or isinstance(lon, bool) or not -180.0 <= lon <= 180.0:
        return "lon must be within [-180, 180]"
    return None


@app.post("/v1/vehicles/positions")
async def positions(request: Request) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    body = await request.json()
    updates = body.get("updates") if isinstance(body, dict) else None
    if not isinstance(updates, list) or len(updates) == 0:
        return JSONResponse({"error": "updates must be a non-empty list"}, status_code=400)
    for update in updates:
        error = validate(update)
        if error is not None:
            return JSONResponse({"error": error}, status_code=400)
        record_position(update["vehicle_id"], update)
    log.info("positions tenant=%s batch=%s accepted=%d", tenant, body.get("batch_id"), len(updates))
    return JSONResponse({"accepted": len(updates), "duplicate": 0})
`,
      solution: `import logging
import time

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from events import record_position  # built in step 4: writes the latest position and publishes the event

app = FastAPI()
log = logging.getLogger("fleet")

MAX_SKEW_MS = 300_000  # five minutes


def validate(update) -> str | None:
    """Why the update is not a position, or None."""
    if not isinstance(update, dict):
        return "update must be an object"
    if not isinstance(update.get("vehicle_id"), str) or update["vehicle_id"] == "":
        return "vehicle_id must be a non-empty string"
    ts = update.get("device_timestamp_ms")
    if not isinstance(ts, int) or isinstance(ts, bool) or ts <= 0:
        return "device_timestamp_ms must be a positive integer"
    seq = update.get("sequence")
    if not isinstance(seq, int) or isinstance(seq, bool) or seq < 0:
        return "sequence must be a non-negative integer"
    lat = update.get("lat")
    if not isinstance(lat, (int, float)) or isinstance(lat, bool) or not -90.0 <= lat <= 90.0:
        return "lat must be within [-90, 90]"
    lon = update.get("lon")
    if not isinstance(lon, (int, float)) or isinstance(lon, bool) or not -180.0 <= lon <= 180.0:
        return "lon must be within [-180, 180]"
    return None


@app.post("/v1/vehicles/positions")
async def positions(request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id")
    if not tenant:
        return JSONResponse({"error": "missing X-Tenant-Id"}, status_code=401)
    body = await request.json()
    updates = body.get("updates") if isinstance(body, dict) else None
    if not isinstance(updates, list) or len(updates) == 0:
        return JSONResponse({"error": "updates must be a non-empty list"}, status_code=400)
    now_ms = int(time.time() * 1000)
    for update in updates:  # the whole batch is checked before anything is written
        error = validate(update)
        if error is None and abs(now_ms - update["device_timestamp_ms"]) > MAX_SKEW_MS:
            error = "device_timestamp_ms outside the accepted skew"
        if error is not None:
            return JSONResponse({"error": error}, status_code=400)
    accepted = 0
    duplicate = 0
    for update in updates:
        if record_position(update["vehicle_id"], update):
            accepted += 1
        else:
            duplicate += 1
    log.info("positions tenant=%s batch=%s accepted=%d duplicate=%d", tenant, body.get("batch_id"), accepted, duplicate)
    return JSONResponse({"accepted": accepted, "duplicate": duplicate})
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import type {Position} from 'fleet/position';

import {recordPosition} from './events'; // built in step 4: writes the latest position and publishes the event

export const app = Fastify();

interface Batch {
  batch_id?: string;
  updates?: unknown;
}

/** Why the update is not a position, or null. */
export function validate(update: unknown): string | null {
  if (typeof update !== 'object' || update === null) return 'update must be an object';
  const u = update as Record<string, unknown>;
  if (typeof u.vehicle_id !== 'string' || u.vehicle_id === '') return 'vehicle_id must be a non-empty string';
  if (!Number.isInteger(u.device_timestamp_ms) || (u.device_timestamp_ms as number) <= 0) return 'device_timestamp_ms must be a positive integer';
  if (!Number.isInteger(u.sequence) || (u.sequence as number) < 0) return 'sequence must be a non-negative integer';
  if (typeof u.lat !== 'number' || u.lat < -90 || u.lat > 90) return 'lat must be within [-90, 90]';
  if (typeof u.lon !== 'number' || u.lon < -180 || u.lon > 180) return 'lon must be within [-180, 180]';
  return null;
}

app.post('/v1/vehicles/positions', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const tenant = (request.headers['x-tenant-id'] as string | undefined) ?? '';
  const {batch_id, updates} = (request.body ?? {}) as Batch;
  if (!Array.isArray(updates) || updates.length === 0) return reply.code(400).send({error: 'updates must be a non-empty list'});
  for (const update of updates) {
    const error = validate(update);
    if (error !== null) return reply.code(400).send({error});
    await recordPosition((update as Position).vehicle_id, update as Position);
  }
  console.log(\`positions tenant=\${tenant} batch=\${batch_id} accepted=\${updates.length}\`);
  return {accepted: updates.length, duplicate: 0};
});
`,
      solution: `import Fastify from 'fastify';

import type {Position} from 'fleet/position';

import {recordPosition} from './events'; // built in step 4: writes the latest position and publishes the event

export const app = Fastify();

export const MAX_SKEW_MS = 300_000; // five minutes

interface Batch {
  batch_id?: string;
  updates?: unknown;
}

/** Why the update is not a position, or null. */
export function validate(update: unknown): string | null {
  if (typeof update !== 'object' || update === null) return 'update must be an object';
  const u = update as Record<string, unknown>;
  if (typeof u.vehicle_id !== 'string' || u.vehicle_id === '') return 'vehicle_id must be a non-empty string';
  if (!Number.isInteger(u.device_timestamp_ms) || (u.device_timestamp_ms as number) <= 0) return 'device_timestamp_ms must be a positive integer';
  if (!Number.isInteger(u.sequence) || (u.sequence as number) < 0) return 'sequence must be a non-negative integer';
  if (typeof u.lat !== 'number' || u.lat < -90 || u.lat > 90) return 'lat must be within [-90, 90]';
  if (typeof u.lon !== 'number' || u.lon < -180 || u.lon > 180) return 'lon must be within [-180, 180]';
  return null;
}

app.post('/v1/vehicles/positions', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {batch_id, updates} = (request.body ?? {}) as Batch;
  if (!Array.isArray(updates) || updates.length === 0) return reply.code(400).send({error: 'updates must be a non-empty list'});
  const nowMs = Date.now();
  for (const update of updates) {
    // the whole batch is checked before anything is written
    let error = validate(update);
    if (error === null && Math.abs(nowMs - (update as Position).device_timestamp_ms) > MAX_SKEW_MS) error = 'device_timestamp_ms outside the accepted skew';
    if (error !== null) return reply.code(400).send({error});
  }
  let accepted = 0;
  let duplicate = 0;
  for (const update of updates as Position[]) {
    if (await recordPosition(update.vehicle_id, update)) accepted += 1;
    else duplicate += 1;
  }
  console.log(\`positions tenant=\${tenant} batch=\${batch_id} accepted=\${accepted} duplicate=\${duplicate}\`);
  return {accepted, duplicate};
});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"

	"fleet/position"
)

// Built in step 4 (events.go): writes the latest position (step 2) and publishes the event; true when applied.
var recordPosition = func(ctx context.Context, vehicleID string, p position.Position) (bool, error) {
	panic("built in step 4")
}

type batch struct {
	BatchID string              \`json:"batch_id"\`
	Updates []position.Position \`json:"updates"\`
}

// validate is why the update is not a position, or "".
func validate(p position.Position) string {
	switch {
	case p.VehicleID == "":
		return "vehicle_id must be a non-empty string"
	case p.DeviceTimestampMs <= 0:
		return "device_timestamp_ms must be a positive integer"
	case p.Sequence < 0:
		return "sequence must be a non-negative integer"
	case p.Lat < -90 || p.Lat > 90:
		return "lat must be within [-90, 90]"
	case p.Lon < -180 || p.Lon > 180:
		return "lon must be within [-180, 180]"
	}
	return ""
}

func postPositions(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	var b batch
	if err := json.NewDecoder(r.Body).Decode(&b); err != nil || len(b.Updates) == 0 {
		http.Error(rw, "updates must be a non-empty list", http.StatusBadRequest)
		return
	}
	for _, u := range b.Updates {
		if msg := validate(u); msg != "" {
			http.Error(rw, msg, http.StatusBadRequest)
			return
		}
		if _, err := recordPosition(r.Context(), u.VehicleID, u); err != nil {
			http.Error(rw, err.Error(), http.StatusInternalServerError)
			return
		}
	}
	log.Printf("positions tenant=%s batch=%s accepted=%d", tenant, b.BatchID, len(b.Updates))
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode(map[string]int{"accepted": len(b.Updates), "duplicate": 0})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/vehicles/positions", postPositions)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"math"
	"net/http"
	"time"

	"fleet/position"
)

const maxSkewMs = 300_000 // five minutes

// Built in step 4 (events.go): writes the latest position (step 2) and publishes the event; true when applied.
var recordPosition = func(ctx context.Context, vehicleID string, p position.Position) (bool, error) {
	panic("built in step 4")
}

type batch struct {
	BatchID string              \`json:"batch_id"\`
	Updates []position.Position \`json:"updates"\`
}

// validate is why the update is not a position, or "".
func validate(p position.Position) string {
	switch {
	case p.VehicleID == "":
		return "vehicle_id must be a non-empty string"
	case p.DeviceTimestampMs <= 0:
		return "device_timestamp_ms must be a positive integer"
	case p.Sequence < 0:
		return "sequence must be a non-negative integer"
	case p.Lat < -90 || p.Lat > 90:
		return "lat must be within [-90, 90]"
	case p.Lon < -180 || p.Lon > 180:
		return "lon must be within [-180, 180]"
	}
	return ""
}

func postPositions(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "missing X-Tenant-Id", http.StatusUnauthorized)
		return
	}
	var b batch
	if err := json.NewDecoder(r.Body).Decode(&b); err != nil || len(b.Updates) == 0 {
		http.Error(rw, "updates must be a non-empty list", http.StatusBadRequest)
		return
	}
	nowMs := time.Now().UnixMilli()
	for _, u := range b.Updates { // the whole batch is checked before anything is written
		msg := validate(u)
		if msg == "" && math.Abs(float64(nowMs-u.DeviceTimestampMs)) > maxSkewMs {
			msg = "device_timestamp_ms outside the accepted skew"
		}
		if msg != "" {
			http.Error(rw, msg, http.StatusBadRequest)
			return
		}
	}
	accepted, duplicate := 0, 0
	for _, u := range b.Updates {
		applied, err := recordPosition(r.Context(), u.VehicleID, u)
		if err != nil {
			http.Error(rw, err.Error(), http.StatusInternalServerError)
			return
		}
		if applied {
			accepted++
		} else {
			duplicate++
		}
	}
	log.Printf("positions tenant=%s batch=%s accepted=%d duplicate=%d", tenant, b.BatchID, accepted, duplicate)
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode(map[string]int{"accepted": accepted, "duplicate": duplicate})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/vehicles/positions", postPositions)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

import fleet.Position

object Api {
  final case class Batch(batchId: Option[String], updates: List[Position])
  implicit val batchFormat: RootJsonFormat[Batch] = jsonFormat(Batch.apply _, "batch_id", "updates")
  final case class Result(accepted: Int, duplicate: Int)
  implicit val resultFormat: RootJsonFormat[Result] = jsonFormat2(Result.apply)

  /** Why the update is not a position, or None. */
  def validate(p: Position): Option[String] =
    if (p.vehicleId.isEmpty) Some("vehicle_id must be a non-empty string")
    else if (p.deviceTimestampMs <= 0) Some("device_timestamp_ms must be a positive integer")
    else if (p.sequence < 0) Some("sequence must be a non-negative integer")
    else if (p.lat < -90 || p.lat > 90) Some("lat must be within [-90, 90]")
    else if (p.lon < -180 || p.lon > 180) Some("lon must be within [-180, 180]")
    else None

  val route: Route =
    path("v1" / "vehicles" / "positions") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { header =>
          // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
          val tenant = header.getOrElse("")
          entity(as[Batch]) { batch =>
            if (batch.updates.isEmpty) complete(StatusCodes.BadRequest -> "updates must be a non-empty list")
            else {
              var error: Option[String] = None
              val it = batch.updates.iterator
              while (error.isEmpty && it.hasNext) {
                val u = it.next()
                error = validate(u)
                if (error.isEmpty) Events.recordPosition(u.vehicleId, u) // built in step 4
              }
              error match {
                case Some(message) => complete(StatusCodes.BadRequest -> message)
                case None =>
                  println(s"positions tenant=$tenant batch=\${batch.batchId.getOrElse("")} accepted=\${batch.updates.size}")
                  complete(Result(batch.updates.size, 0))
              }
            }
          }
        }
      }
    }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

import fleet.Position

object Api {
  val MaxSkewMs = 300000L // five minutes

  final case class Batch(batchId: Option[String], updates: List[Position])
  implicit val batchFormat: RootJsonFormat[Batch] = jsonFormat(Batch.apply _, "batch_id", "updates")
  final case class Result(accepted: Int, duplicate: Int)
  implicit val resultFormat: RootJsonFormat[Result] = jsonFormat2(Result.apply)

  /** Why the update is not a position, or None. */
  def validate(p: Position): Option[String] =
    if (p.vehicleId.isEmpty) Some("vehicle_id must be a non-empty string")
    else if (p.deviceTimestampMs <= 0) Some("device_timestamp_ms must be a positive integer")
    else if (p.sequence < 0) Some("sequence must be a non-negative integer")
    else if (p.lat < -90 || p.lat > 90) Some("lat must be within [-90, 90]")
    else if (p.lon < -180 || p.lon > 180) Some("lon must be within [-180, 180]")
    else None

  val route: Route =
    path("v1" / "vehicles" / "positions") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") {
          case None | Some("") => complete(StatusCodes.Unauthorized -> "missing X-Tenant-Id")
          case Some(tenant) =>
            entity(as[Batch]) { batch =>
              val nowMs = System.currentTimeMillis()
              // the whole batch is checked before anything is written
              val error = batch.updates.iterator.flatMap { u =>
                validate(u).orElse {
                  if (math.abs(nowMs - u.deviceTimestampMs) > MaxSkewMs) Some("device_timestamp_ms outside the accepted skew") else None
                }
              }.nextOption()
              if (batch.updates.isEmpty) complete(StatusCodes.BadRequest -> "updates must be a non-empty list")
              else error match {
                case Some(message) => complete(StatusCodes.BadRequest -> message)
                case None =>
                  val applied = batch.updates.map(u => Events.recordPosition(u.vehicleId, u)) // built in step 4
                  val accepted = applied.count(identity)
                  println(s"positions tenant=$tenant batch=\${batch.batchId.getOrElse("")} accepted=$accepted duplicate=\${applied.size - accepted}")
                  complete(Result(accepted, applied.size - accepted))
              }
            }
        }
      }
    }
}
`,
    },
    cpp: {
      starter: `#define CPPHTTPLIB_OPENSSL_SUPPORT
#include <httplib.h>

#include <nlohmann/json.hpp>

#include <iostream>
#include <string>

#include "position.h"

// Built in step 4 (events.cpp): writes the latest position (step 2) and publishes the event; true when applied.
bool record_position(const std::string& vehicle_id, const Position& p);

// Why the update is not a position, or "".
std::string validate(const nlohmann::json& u) {
  if (!u.is_object()) return "update must be an object";
  if (!u.contains("vehicle_id") || !u["vehicle_id"].is_string() || u["vehicle_id"].get<std::string>().empty())
    return "vehicle_id must be a non-empty string";
  if (!u.contains("device_timestamp_ms") || !u["device_timestamp_ms"].is_number_integer() || u["device_timestamp_ms"].get<long long>() <= 0)
    return "device_timestamp_ms must be a positive integer";
  if (!u.contains("sequence") || !u["sequence"].is_number_integer() || u["sequence"].get<long long>() < 0)
    return "sequence must be a non-negative integer";
  if (!u.contains("lat") || !u["lat"].is_number() || u["lat"].get<double>() < -90 || u["lat"].get<double>() > 90)
    return "lat must be within [-90, 90]";
  if (!u.contains("lon") || !u["lon"].is_number() || u["lon"].get<double>() < -180 || u["lon"].get<double>() > 180)
    return "lon must be within [-180, 180]";
  return "";
}

Position to_position(const nlohmann::json& u) {
  return Position{u["vehicle_id"].get<std::string>(), u["device_timestamp_ms"].get<long long>(), u["sequence"].get<long long>(),
                  u["lat"].get<double>(), u["lon"].get<double>()};
}

void post_positions(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  const nlohmann::json body = nlohmann::json::parse(req.body, nullptr, false);
  if (!body.is_object() || !body.contains("updates") || !body["updates"].is_array() || body["updates"].empty()) {
    res.status = 400;
    res.set_content(R"({"error":"updates must be a non-empty list"})", "application/json");
    return;
  }
  for (const auto& u : body["updates"]) {
    const std::string error = validate(u);
    if (!error.empty()) {
      res.status = 400;
      res.set_content(nlohmann::json{{"error", error}}.dump(), "application/json");
      return;
    }
    record_position(u["vehicle_id"].get<std::string>(), to_position(u));
  }
  const int accepted = static_cast<int>(body["updates"].size());
  std::clog << "positions tenant=" << tenant << " accepted=" << accepted << "\\n";
  res.set_content(nlohmann::json{{"accepted", accepted}, {"duplicate", 0}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/vehicles/positions", post_positions);
}
`,
      solution: `#define CPPHTTPLIB_OPENSSL_SUPPORT
#include <httplib.h>

#include <nlohmann/json.hpp>

#include <chrono>
#include <cstdlib>
#include <iostream>
#include <string>

#include "position.h"

constexpr long long kMaxSkewMs = 300000;  // five minutes

// Built in step 4 (events.cpp): writes the latest position (step 2) and publishes the event; true when applied.
bool record_position(const std::string& vehicle_id, const Position& p);

// Why the update is not a position, or "".
std::string validate(const nlohmann::json& u) {
  if (!u.is_object()) return "update must be an object";
  if (!u.contains("vehicle_id") || !u["vehicle_id"].is_string() || u["vehicle_id"].get<std::string>().empty())
    return "vehicle_id must be a non-empty string";
  if (!u.contains("device_timestamp_ms") || !u["device_timestamp_ms"].is_number_integer() || u["device_timestamp_ms"].get<long long>() <= 0)
    return "device_timestamp_ms must be a positive integer";
  if (!u.contains("sequence") || !u["sequence"].is_number_integer() || u["sequence"].get<long long>() < 0)
    return "sequence must be a non-negative integer";
  if (!u.contains("lat") || !u["lat"].is_number() || u["lat"].get<double>() < -90 || u["lat"].get<double>() > 90)
    return "lat must be within [-90, 90]";
  if (!u.contains("lon") || !u["lon"].is_number() || u["lon"].get<double>() < -180 || u["lon"].get<double>() > 180)
    return "lon must be within [-180, 180]";
  return "";
}

Position to_position(const nlohmann::json& u) {
  return Position{u["vehicle_id"].get<std::string>(), u["device_timestamp_ms"].get<long long>(), u["sequence"].get<long long>(),
                  u["lat"].get<double>(), u["lon"].get<double>()};
}

void post_positions(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
    return;
  }
  const nlohmann::json body = nlohmann::json::parse(req.body, nullptr, false);
  if (!body.is_object() || !body.contains("updates") || !body["updates"].is_array() || body["updates"].empty()) {
    res.status = 400;
    res.set_content(R"({"error":"updates must be a non-empty list"})", "application/json");
    return;
  }
  const long long now_ms =
      std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  for (const auto& u : body["updates"]) {  // the whole batch is checked before anything is written
    std::string error = validate(u);
    if (error.empty() && std::llabs(now_ms - u["device_timestamp_ms"].get<long long>()) > kMaxSkewMs)
      error = "device_timestamp_ms outside the accepted skew";
    if (!error.empty()) {
      res.status = 400;
      res.set_content(nlohmann::json{{"error", error}}.dump(), "application/json");
      return;
    }
  }
  int accepted = 0;
  int duplicate = 0;
  for (const auto& u : body["updates"]) {
    if (record_position(u["vehicle_id"].get<std::string>(), to_position(u))) accepted++;
    else duplicate++;
  }
  std::clog << "positions tenant=" << tenant << " accepted=" << accepted << " duplicate=" << duplicate << "\\n";
  res.set_content(nlohmann::json{{"accepted", accepted}, {"duplicate", duplicate}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/vehicles/positions", post_positions);
}
`,
    },
  },
  harness: {
    python: `T1 = {"X-Tenant-Id": "t-1"}


def update(vehicle_id, ts, seq=1, lat=47.6, lon=-122.3):
    return {"vehicle_id": vehicle_id, "device_timestamp_ms": ts, "sequence": seq, "lat": lat, "lon": lon}


def batch(*updates):
    return {"batch_id": "b-1", "updates": list(updates)}


def now_ms(ctx):
    return int(ctx.clock.time() * 1000)


def written(ctx):
    """The vehicles with a latest record, sorted."""
    return sorted(k.split(":")[1] for k in ctx.redis.keys("vehicle:*:latest"))


async def check_route(ctx):
    m = ctx.load("api")
    async with ctx.client(m.app) as c:
        r = await c.post("/v1/vehicles/positions", json=batch(update("v-1", now_ms(ctx), 42)), headers=T1)
    assert r.status_code == 200, f"POST /v1/vehicles/positions with a valid batch answered {r.status_code}: {r.text}"
    assert r.headers.get("content-type", "").startswith("application/json"), f"the answer must be JSON, got Content-Type {r.headers.get('content-type')!r}"
    body = r.json()
    assert body.get("accepted") == 1 and body.get("duplicate") == 0, f"one new update must answer accepted 1, duplicate 0: got {body}"
    assert written(ctx) == ["v-1"], f"after the batch the latest records are {written(ctx)}, expected v-1 (record_position writes vehicle:v-1:latest)"


async def check_tenant(ctx):
    m = ctx.load("api")
    async with ctx.client(m.app) as c:
        r = await c.post("/v1/vehicles/positions", json=batch(update("v-1", now_ms(ctx))))
        assert r.status_code == 401, f"a batch without X-Tenant-Id answered {r.status_code}, expected 401"
        assert written(ctx) == [], f"a batch without a tenant wrote {written(ctx)}: nothing may be recorded for nobody"
        r = await c.post("/v1/vehicles/positions", json=batch(update("v-1", now_ms(ctx))), headers={"X-Tenant-Id": ""})
        assert r.status_code == 401, f"a batch with an empty X-Tenant-Id answered {r.status_code}, expected 401"
        r = await c.post("/v1/vehicles/positions", json=batch(update("v-1", now_ms(ctx))), headers=T1)
        assert r.status_code == 200, f"with a tenant the same batch answered {r.status_code}: {r.text}"


async def check_validate_first(ctx):
    m = ctx.load("api")
    now = now_ms(ctx)
    async with ctx.client(m.app) as c:
        r = await c.post("/v1/vehicles/positions", json=batch(update("v-1", now), update("v-2", now), update("v-3", now, lat=200.0)), headers=T1)
        assert r.status_code == 400, f"a batch whose third update has lat 200 answered {r.status_code}, expected 400"
        assert written(ctx) == [], f"the batch was rejected with 400 but {written(ctx)} were written: every update is validated before any is recorded, so the device can fix the batch and resend it"
        for bad in (update("", now), update("v-1", -5), update("v-1", now, seq=-1), update("v-1", now, lon=181.0), {"vehicle_id": "v-1"}):
            r = await c.post("/v1/vehicles/positions", json=batch(update("v-9", now), bad), headers=T1)
            assert r.status_code == 400, f"a batch with the invalid update {bad} answered {r.status_code}, expected 400"
        assert written(ctx) == [], f"rejected batches wrote {written(ctx)}"
        r = await c.post("/v1/vehicles/positions", json={"batch_id": "b-2", "updates": []}, headers=T1)
        assert r.status_code == 400, f"an empty batch answered {r.status_code}, expected 400"


async def check_skew(ctx):
    m = ctx.load("api")
    now = now_ms(ctx)
    async with ctx.client(m.app) as c:
        r = await c.post("/v1/vehicles/positions", json=batch(update("v-1", now), update("v-2", now - 10 * 60_000)), headers=T1)
        assert r.status_code == 400, f"a batch with a position dated ten minutes ago answered {r.status_code}, expected 400: a device clock that far off is not trusted"
        assert written(ctx) == [], f"the skewed batch wrote {written(ctx)}: a skewed update rejects the batch before anything is written"
        r = await c.post("/v1/vehicles/positions", json=batch(update("v-1", now + 10 * 60_000)), headers=T1)
        assert r.status_code == 400, f"a position dated ten minutes in the future answered {r.status_code}, expected 400: the skew bound is abs(now - ts)"
        r = await c.post("/v1/vehicles/positions", json=batch(update("v-1", now - 4 * 60_000), update("v-2", now + 4 * 60_000)), headers=T1)
        assert r.status_code == 200, f"positions four minutes either side of the server clock answered {r.status_code}, expected 200 (within MAX_SKEW_MS = 300 000)"
        assert written(ctx) == ["v-1", "v-2"], f"the accepted batch wrote {written(ctx)}, expected v-1 and v-2"


async def check_counts(ctx):
    m = ctx.load("api")
    now = now_ms(ctx)
    first = batch(update("v-1", now, 5), update("v-2", now, 7))
    async with ctx.client(m.app) as c:
        r = await c.post("/v1/vehicles/positions", json=first, headers=T1)
        assert r.status_code == 200 and r.json() == {"accepted": 2, "duplicate": 0}, f"two new updates answered {r.status_code} {r.text}, expected accepted 2, duplicate 0"
        r = await c.post("/v1/vehicles/positions", json=first, headers=T1)
        assert r.status_code == 200, f"the same batch again answered {r.status_code}: {r.text}"
        assert r.json() == {"accepted": 0, "duplicate": 2}, f"the same batch again (a device replaying its buffer) answered {r.text}, expected accepted 0, duplicate 2: the state ignored both, the response must say so"
        r = await c.post("/v1/vehicles/positions", json=batch(update("v-1", now + 1000, 6), update("v-2", now, 7)), headers=T1)
        assert r.json() == {"accepted": 1, "duplicate": 1}, f"one new and one replayed update answered {r.text}, expected accepted 1, duplicate 1"
`,
    typescript: `const T1 = {'X-Tenant-Id': 't-1'};

const update = (vehicle_id: string, ts: number, seq = 1, lat = 47.6, lon = -122.3) => ({vehicle_id, device_timestamp_ms: ts, sequence: seq, lat, lon});
const batch = (...updates: unknown[]) => ({batch_id: 'b-1', updates});

/** The vehicles with a latest record, sorted. */
const written = (ctx): string[] => (ctx.redis.keys('vehicle:*:latest') as string[]).map(k => k.split(':')[1]).sort();

function api(ctx) {
  const m = ctx.load('api');
  return ctx.client(m.app);
}

export async function check_route(ctx) {
  const c = api(ctx);
  const r = await c.post('/v1/vehicles/positions', {json: batch(update('v-1', ctx.clock.now(), 42)), headers: T1});
  assert.equal(r.status, 200, \`POST /v1/vehicles/positions with a valid batch answered \${r.status}: \${r.text}\`);
  assert((r.headers['content-type'] ?? '').startsWith('application/json'), \`the answer must be JSON, got Content-Type \${JSON.stringify(r.headers['content-type'])}\`);
  const body = r.json() as {accepted?: number; duplicate?: number};
  assert(body.accepted === 1 && body.duplicate === 0, \`one new update must answer accepted 1, duplicate 0: got \${r.text}\`);
  assert.deepStrictEqual(written(ctx), ['v-1'], \`after the batch the latest records are \${JSON.stringify(written(ctx))}, expected v-1 (recordPosition writes vehicle:v-1:latest)\`);
}

export async function check_tenant(ctx) {
  const c = api(ctx);
  let r = await c.post('/v1/vehicles/positions', {json: batch(update('v-1', ctx.clock.now()))});
  assert.equal(r.status, 401, \`a batch without X-Tenant-Id answered \${r.status}, expected 401\`);
  assert.deepStrictEqual(written(ctx), [], \`a batch without a tenant wrote \${JSON.stringify(written(ctx))}: nothing may be recorded for nobody\`);
  r = await c.post('/v1/vehicles/positions', {json: batch(update('v-1', ctx.clock.now())), headers: {'X-Tenant-Id': ''}});
  assert.equal(r.status, 401, \`a batch with an empty X-Tenant-Id answered \${r.status}, expected 401\`);
  r = await c.post('/v1/vehicles/positions', {json: batch(update('v-1', ctx.clock.now())), headers: T1});
  assert.equal(r.status, 200, \`with a tenant the same batch answered \${r.status}: \${r.text}\`);
}

export async function check_validate_first(ctx) {
  const c = api(ctx);
  const now = ctx.clock.now();
  let r = await c.post('/v1/vehicles/positions', {json: batch(update('v-1', now), update('v-2', now), update('v-3', now, 1, 200.0)), headers: T1});
  assert.equal(r.status, 400, \`a batch whose third update has lat 200 answered \${r.status}, expected 400\`);
  assert.deepStrictEqual(written(ctx), [], \`the batch was rejected with 400 but \${JSON.stringify(written(ctx))} were written: every update is validated before any is recorded, so the device can fix the batch and resend it\`);
  for (const bad of [update('', now), update('v-1', -5), update('v-1', now, -1), update('v-1', now, 1, 47.6, 181.0), {vehicle_id: 'v-1'}]) {
    r = await c.post('/v1/vehicles/positions', {json: batch(update('v-9', now), bad), headers: T1});
    assert.equal(r.status, 400, \`a batch with the invalid update \${JSON.stringify(bad)} answered \${r.status}, expected 400\`);
  }
  assert.deepStrictEqual(written(ctx), [], \`rejected batches wrote \${JSON.stringify(written(ctx))}\`);
  r = await c.post('/v1/vehicles/positions', {json: {batch_id: 'b-2', updates: []}, headers: T1});
  assert.equal(r.status, 400, \`an empty batch answered \${r.status}, expected 400\`);
}

export async function check_skew(ctx) {
  const c = api(ctx);
  const now = ctx.clock.now();
  let r = await c.post('/v1/vehicles/positions', {json: batch(update('v-1', now), update('v-2', now - 10 * 60_000)), headers: T1});
  assert.equal(r.status, 400, \`a batch with a position dated ten minutes ago answered \${r.status}, expected 400: a device clock that far off is not trusted\`);
  assert.deepStrictEqual(written(ctx), [], \`the skewed batch wrote \${JSON.stringify(written(ctx))}: a skewed update rejects the batch before anything is written\`);
  r = await c.post('/v1/vehicles/positions', {json: batch(update('v-1', now + 10 * 60_000)), headers: T1});
  assert.equal(r.status, 400, \`a position dated ten minutes in the future answered \${r.status}, expected 400: the skew bound is abs(now - ts)\`);
  r = await c.post('/v1/vehicles/positions', {json: batch(update('v-1', now - 4 * 60_000), update('v-2', now + 4 * 60_000)), headers: T1});
  assert.equal(r.status, 200, \`positions four minutes either side of the server clock answered \${r.status}, expected 200 (within MAX_SKEW_MS = 300 000)\`);
  assert.deepStrictEqual(written(ctx), ['v-1', 'v-2'], \`the accepted batch wrote \${JSON.stringify(written(ctx))}, expected v-1 and v-2\`);
}

export async function check_counts(ctx) {
  const c = api(ctx);
  const now = ctx.clock.now();
  const first = batch(update('v-1', now, 5), update('v-2', now, 7));
  let r = await c.post('/v1/vehicles/positions', {json: first, headers: T1});
  assert(r.status === 200 && JSON.stringify(r.json()) === JSON.stringify({accepted: 2, duplicate: 0}), \`two new updates answered \${r.status} \${r.text}, expected accepted 2, duplicate 0\`);
  r = await c.post('/v1/vehicles/positions', {json: first, headers: T1});
  assert.equal(r.status, 200, \`the same batch again answered \${r.status}: \${r.text}\`);
  assert.deepStrictEqual(r.json(), {accepted: 0, duplicate: 2}, \`the same batch again (a device replaying its buffer) answered \${r.text}, expected accepted 0, duplicate 2: the state ignored both, the response must say so\`);
  r = await c.post('/v1/vehicles/positions', {json: batch(update('v-1', now + 1000, 6), update('v-2', now, 7)), headers: T1});
  assert.deepStrictEqual(r.json(), {accepted: 1, duplicate: 1}, \`one new and one replayed update answered \${r.text}, expected accepted 1, duplicate 1\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"sort"
	"strings"

	"leetbuild/harness"

	"fleet/position"
)

// apiState stands in for step 4's recordPosition: the latest (ts, seq) per vehicle, applied when newer.
type apiState struct {
	latest map[string][2]int64
}

func newAPI(ctx *harness.Ctx) (*harness.HTTP, *apiState) {
	s := &apiState{latest: map[string][2]int64{}}
	recordPosition = func(_ context.Context, vehicleID string, p position.Position) (bool, error) {
		cur, ok := s.latest[vehicleID]
		if ok && (p.DeviceTimestampMs < cur[0] || (p.DeviceTimestampMs == cur[0] && p.Sequence <= cur[1])) {
			return false, nil
		}
		s.latest[vehicleID] = [2]int64{p.DeviceTimestampMs, p.Sequence}
		return true, nil
	}
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux), s
}

// written is the vehicles with a latest record, sorted.
func (s *apiState) written() []string {
	out := make([]string, 0, len(s.latest))
	for id := range s.latest {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

func apiUpdate(vehicleID string, ts, seq int64, latLon ...float64) map[string]any {
	lat, lon := 47.6, -122.3
	if len(latLon) > 0 {
		lat = latLon[0]
	}
	if len(latLon) > 1 {
		lon = latLon[1]
	}
	return map[string]any{"vehicle_id": vehicleID, "device_timestamp_ms": ts, "sequence": seq, "lat": lat, "lon": lon}
}

func apiBatch(updates ...map[string]any) map[string]any {
	return map[string]any{"batch_id": "b-1", "updates": updates}
}

func CheckRoute(ctx *harness.Ctx) {
	c, s := newAPI(ctx)
	r := c.Post("/v1/vehicles/positions", apiBatch(apiUpdate("v-1", ctx.Clock.Now(), 42)), "X-Tenant-Id", "t-1")
	ctx.Equal(r.Status, 200, "POST /v1/vehicles/positions with a valid batch (%s)", r.Text())
	ctype := r.Header.Get("Content-Type")
	ctx.Assert(strings.HasPrefix(ctype, "application/json"), "the answer must be JSON, got Content-Type %q", ctype)
	ctx.Equal(r.JSON(), map[string]any{"accepted": 1, "duplicate": 0}, "one new update must answer accepted 1, duplicate 0")
	ctx.Equal(s.written(), []string{"v-1"}, "after the batch the vehicles recordPosition received (it writes vehicle:v-1:latest)")
}

func CheckTenant(ctx *harness.Ctx) {
	c, s := newAPI(ctx)
	r := c.Post("/v1/vehicles/positions", apiBatch(apiUpdate("v-1", ctx.Clock.Now(), 1)))
	ctx.Equal(r.Status, 401, "a batch without X-Tenant-Id")
	ctx.Equal(s.written(), []string{}, "a batch without a tenant recorded vehicles: nothing may be recorded for nobody; the vehicles written")
	r = c.Post("/v1/vehicles/positions", apiBatch(apiUpdate("v-1", ctx.Clock.Now(), 1)), "X-Tenant-Id", "")
	ctx.Equal(r.Status, 401, "a batch with an empty X-Tenant-Id")
	r = c.Post("/v1/vehicles/positions", apiBatch(apiUpdate("v-1", ctx.Clock.Now(), 1)), "X-Tenant-Id", "t-1")
	ctx.Equal(r.Status, 200, "with a tenant the same batch (%s)", r.Text())
}

func CheckValidateFirst(ctx *harness.Ctx) {
	c, s := newAPI(ctx)
	now := ctx.Clock.Now()
	r := c.Post("/v1/vehicles/positions", apiBatch(apiUpdate("v-1", now, 1), apiUpdate("v-2", now, 1), apiUpdate("v-3", now, 1, 200.0)), "X-Tenant-Id", "t-1")
	ctx.Equal(r.Status, 400, "a batch whose third update has lat 200")
	ctx.Equal(s.written(), []string{}, "the batch was rejected with 400 but vehicles were recorded: every update is validated before any is recorded, so the device can fix the batch and resend it; the vehicles written")
	for _, bad := range []map[string]any{apiUpdate("", now, 1), apiUpdate("v-1", -5, 1), apiUpdate("v-1", now, -1), apiUpdate("v-1", now, 1, 47.6, 181.0), {"vehicle_id": "v-1"}} {
		r = c.Post("/v1/vehicles/positions", apiBatch(apiUpdate("v-9", now, 1), bad), "X-Tenant-Id", "t-1")
		ctx.Equal(r.Status, 400, "a batch with the invalid update %v", bad)
	}
	ctx.Equal(s.written(), []string{}, "rejected batches recorded vehicles; the vehicles written")
	r = c.Post("/v1/vehicles/positions", map[string]any{"batch_id": "b-2", "updates": []any{}}, "X-Tenant-Id", "t-1")
	ctx.Equal(r.Status, 400, "an empty batch")
}

func CheckSkew(ctx *harness.Ctx) {
	c, s := newAPI(ctx)
	now := ctx.Clock.Now()
	r := c.Post("/v1/vehicles/positions", apiBatch(apiUpdate("v-1", now, 1), apiUpdate("v-2", now-10*60_000, 1)), "X-Tenant-Id", "t-1")
	ctx.Equal(r.Status, 400, "a batch with a position dated ten minutes ago (a device clock that far off is not trusted)")
	ctx.Equal(s.written(), []string{}, "the skewed batch recorded vehicles: a skewed update rejects the batch before anything is written; the vehicles written")
	r = c.Post("/v1/vehicles/positions", apiBatch(apiUpdate("v-1", now+10*60_000, 1)), "X-Tenant-Id", "t-1")
	ctx.Equal(r.Status, 400, "a position dated ten minutes in the future (the skew bound is abs(now - ts))")
	r = c.Post("/v1/vehicles/positions", apiBatch(apiUpdate("v-1", now-4*60_000, 1), apiUpdate("v-2", now+4*60_000, 1)), "X-Tenant-Id", "t-1")
	ctx.Equal(r.Status, 200, "positions four minutes either side of the server clock (within maxSkewMs = 300 000): %s", r.Text())
	ctx.Equal(s.written(), []string{"v-1", "v-2"}, "the accepted batch's vehicles")
}

func CheckCounts(ctx *harness.Ctx) {
	c, _ := newAPI(ctx)
	now := ctx.Clock.Now()
	first := apiBatch(apiUpdate("v-1", now, 5), apiUpdate("v-2", now, 7))
	r := c.Post("/v1/vehicles/positions", first, "X-Tenant-Id", "t-1")
	ctx.Equal(r.Status, 200, "two new updates (%s)", r.Text())
	ctx.Equal(r.JSON(), map[string]any{"accepted": 2, "duplicate": 0}, "two new updates")
	r = c.Post("/v1/vehicles/positions", first, "X-Tenant-Id", "t-1")
	ctx.Equal(r.Status, 200, "the same batch again (%s)", r.Text())
	ctx.Equal(r.JSON(), map[string]any{"accepted": 0, "duplicate": 2}, "the same batch again (a device replaying its buffer): the state ignored both, the response must say so")
	r = c.Post("/v1/vehicles/positions", apiBatch(apiUpdate("v-1", now+1000, 6), apiUpdate("v-2", now, 7)), "X-Tenant-Id", "t-1")
	ctx.Equal(r.JSON(), map[string]any{"accepted": 1, "duplicate": 1}, "one new and one replayed update")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <map>
#include <string>
#include <utility>
#include <vector>

namespace {

// Stands in for step 4's record_position: the latest (ts, seq) per vehicle, applied when newer.
std::map<std::string, std::pair<long long, long long>> apiLatest;

// The vehicles with a latest record, sorted.
std::vector<std::string> apiWritten() {
  std::vector<std::string> out;
  for (const auto& [id, _] : apiLatest) out.push_back(id);
  return out;
}

struct Api {
  httplib::Server svr;
  harness::HTTP http;
  explicit Api(harness::Ctx& ctx) : http(ctx.HTTP(svr)) {
    apiLatest.clear();
    register_routes(svr);
  }
};

nlohmann::json apiUpdate(const std::string& vehicle_id, long long ts, long long seq = 1, double lat = 47.6, double lon = -122.3) {
  return {{"vehicle_id", vehicle_id}, {"device_timestamp_ms", ts}, {"sequence", seq}, {"lat", lat}, {"lon", lon}};
}

nlohmann::json apiBatch(std::vector<nlohmann::json> updates) {
  return {{"batch_id", "b-1"}, {"updates", updates}};
}

harness::Response post(Api& api, const nlohmann::json& body, const std::vector<std::string>& headers = {"X-Tenant-Id", "t-1"}) {
  return api.http.Send("POST", "/v1/vehicles/positions", body.dump(), headers);
}

}  // namespace

bool record_position(const std::string& vehicle_id, const Position& p) {
  const auto it = apiLatest.find(vehicle_id);
  if (it != apiLatest.end() && (p.device_timestamp_ms < it->second.first ||
                                (p.device_timestamp_ms == it->second.first && p.sequence <= it->second.second)))
    return false;
  apiLatest[vehicle_id] = {p.device_timestamp_ms, p.sequence};
  return true;
}

void CheckRoute(harness::Ctx& ctx) {
  Api api(ctx);
  const auto r = post(api, apiBatch({apiUpdate("v-1", ctx.Clock.Now(), 42)}));
  ctx.Equal(r.Status, 200, "POST /v1/vehicles/positions with a valid batch (%s)", r.Text());
  const std::string ctype = r.HeaderValue("Content-Type");
  ctx.Assert(ctype.rfind("application/json", 0) == 0, "the answer must be JSON, got Content-Type %q", ctype);
  ctx.Equal(r.JSON(), harness::ParseJSON(R"({"accepted":1,"duplicate":0})"), "one new update must answer accepted 1, duplicate 0");
  ctx.Equal(apiWritten(), {"v-1"}, "after the batch the vehicles record_position received (it writes vehicle:v-1:latest)");
}

void CheckTenant(harness::Ctx& ctx) {
  Api api(ctx);
  auto r = post(api, apiBatch({apiUpdate("v-1", ctx.Clock.Now())}), {});
  ctx.Equal(r.Status, 401, "a batch without X-Tenant-Id");
  ctx.Equal(apiWritten(), std::vector<std::string>{}, "a batch without a tenant recorded vehicles: nothing may be recorded for nobody; the vehicles written");
  r = post(api, apiBatch({apiUpdate("v-1", ctx.Clock.Now())}), {"X-Tenant-Id", ""});
  ctx.Equal(r.Status, 401, "a batch with an empty X-Tenant-Id");
  r = post(api, apiBatch({apiUpdate("v-1", ctx.Clock.Now())}));
  ctx.Equal(r.Status, 200, "with a tenant the same batch (%s)", r.Text());
}

void CheckValidateFirst(harness::Ctx& ctx) {
  Api api(ctx);
  const long long now = ctx.Clock.Now();
  auto r = post(api, apiBatch({apiUpdate("v-1", now), apiUpdate("v-2", now), apiUpdate("v-3", now, 1, 200.0)}));
  ctx.Equal(r.Status, 400, "a batch whose third update has lat 200");
  ctx.Equal(apiWritten(), std::vector<std::string>{},
            "the batch was rejected with 400 but vehicles were recorded: every update is validated before any is "
            "recorded, so the device can fix the batch and resend it; the vehicles written");
  const std::vector<nlohmann::json> bads = {apiUpdate("", now), apiUpdate("v-1", -5), apiUpdate("v-1", now, -1),
                                           apiUpdate("v-1", now, 1, 47.6, 181.0), {{"vehicle_id", "v-1"}}};
  for (const auto& bad : bads) {
    r = post(api, apiBatch({apiUpdate("v-9", now), bad}));
    ctx.Equal(r.Status, 400, "a batch with the invalid update %s", bad.dump());
  }
  ctx.Equal(apiWritten(), std::vector<std::string>{}, "rejected batches recorded vehicles; the vehicles written");
  r = post(api, nlohmann::json{{"batch_id", "b-2"}, {"updates", nlohmann::json::array()}});
  ctx.Equal(r.Status, 400, "an empty batch");
}

void CheckSkew(harness::Ctx& ctx) {
  Api api(ctx);
  const long long now = ctx.Clock.Now();
  auto r = post(api, apiBatch({apiUpdate("v-1", now), apiUpdate("v-2", now - 10 * 60000)}));
  ctx.Equal(r.Status, 400, "a batch with a position dated ten minutes ago (a device clock that far off is not trusted)");
  ctx.Equal(apiWritten(), std::vector<std::string>{},
            "the skewed batch recorded vehicles: a skewed update rejects the batch before anything is written; the vehicles written");
  r = post(api, apiBatch({apiUpdate("v-1", now + 10 * 60000)}));
  ctx.Equal(r.Status, 400, "a position dated ten minutes in the future (the skew bound is abs(now - ts))");
  r = post(api, apiBatch({apiUpdate("v-1", now - 4 * 60000), apiUpdate("v-2", now + 4 * 60000)}));
  ctx.Equal(r.Status, 200, "positions four minutes either side of the server clock (within kMaxSkewMs = 300 000): %s", r.Text());
  ctx.Equal(apiWritten(), {"v-1", "v-2"}, "the accepted batch's vehicles");
}

void CheckCounts(harness::Ctx& ctx) {
  Api api(ctx);
  const long long now = ctx.Clock.Now();
  const auto first = apiBatch({apiUpdate("v-1", now, 5), apiUpdate("v-2", now, 7)});
  auto r = post(api, first);
  ctx.Equal(r.Status, 200, "two new updates (%s)", r.Text());
  ctx.Equal(r.JSON(), harness::ParseJSON(R"({"accepted":2,"duplicate":0})"), "two new updates");
  r = post(api, first);
  ctx.Equal(r.Status, 200, "the same batch again (%s)", r.Text());
  ctx.Equal(r.JSON(), harness::ParseJSON(R"({"accepted":0,"duplicate":2})"),
            "the same batch again (a device replaying its buffer): the state ignored both, the response must say so");
  r = post(api, apiBatch({apiUpdate("v-1", now + 1000, 6), apiUpdate("v-2", now, 7)}));
  ctx.Equal(r.JSON(), harness::ParseJSON(R"({"accepted":1,"duplicate":1})"), "one new and one replayed update");
}
`,
  },
  debrief: `Two loops instead of one is the whole fix for the torn batch: the first loop can reject with nothing to undo, so the device's retry of a corrected batch starts from the same state the rejected one found. The skew bound is the endpoint's only defence against a clock, and it is deliberately loose (five minutes) because cell networks delay and devices drift; the state's compare-and-set handles order inside the window. Counting from \`record_position\` is what makes the response true rather than hopeful. Production ingest adds a per-device offset learned from arrival times so a drifted clock is corrected instead of refused, a body size limit and a per-device rate limit before any validation runs, and a dead-letter topic for rejected batches so a fleet-wide 400 is noticed.`,
};
