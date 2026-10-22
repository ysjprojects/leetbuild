import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/vehicles/positions: a position that carries its own time',
  concept: 'http',
  file: 'api',
  focus: ['device', 'gateway', 'api', 'state'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it accepts a batch of
position updates, parses them and writes them straight through. It compiles, it serves the demo,
and it hides three production flaws. Review it like the service owner, fix it, and prove the fix
with the checks below.

Implement \`POST /v1/vehicles/positions\` with body
\`{"batch_id": "abc", "updates": [{"vehicle_id": "v-1", "device_timestamp_ms": 1710000000000, "sequence": 42, "lat": 47.6, "lon": -122.3}]}\`.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- Every update in the batch is validated before any store write: \`vehicle_id\` is a non-empty
  string, \`device_timestamp_ms\` is a positive integer, \`sequence\` is a non-negative integer,
  \`lat\` is within \`[-90, 90]\`, \`lon\` is within \`[-180, 180]\`. An invalid update makes the
  whole batch **400**.
- Reject a device timestamp outside the accepted skew: when
  \`abs(server_now_ms - device_timestamp_ms) > MAX_SKEW_MS\` (**300 000 ms**, five minutes), the
  update is rejected with **400**. A device with a wrong clock can never write a position dated
  last year.
- Dedup replay by sequence: the server tracks the high-water sequence per vehicle. An update whose
  \`sequence\` is **less than or equal to** the high-water mark is a replay; it is not applied and
  is counted under \`duplicate\` in a **200** response.
- A position must never regress a vehicle's latest state: an update is only forwarded when its
  timestamp is newer than the vehicle's last acknowledged timestamp, or equal to it with a larger
  sequence.
- Log accepted updates with tenant, vehicle id, sequence and timestamp — never raw coordinates and
  never driver identity.

**Failure mode the checks target.** The draft accepts any timestamp and any sequence, so a device
with a wrong clock writes positions dated last year and a replayed batch re-applies old positions;
it also logs raw coordinates. The checks verify the skew bound, the sequence high-water dedupe, the
no-regression rule, and log hygiene.`,
  sequence: {
    participants: ['Vehicle Device', 'Fleet Gateway', 'Position API', 'Redis'],
    messages: [
      {from: 'Vehicle Device', to: 'Fleet Gateway', label: 'POST /v1/vehicles/positions (batch)', kind: 'sync'},
      {from: 'Fleet Gateway', to: 'Position API', label: 'validated batch', kind: 'sync'},
      {from: 'Position API', to: 'Position API', label: 'skew + sequence high-water check', kind: 'sync'},
      {from: 'Position API', to: 'Redis', label: 'upsert if newer', kind: 'sync'},
      {from: 'Redis', to: 'Position API', label: 'accepted', kind: 'reply'},
      {from: 'Position API', to: 'Vehicle Device', label: '200 {accepted, duplicate}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/vehicles/positions',
      detail: 'Register the batch position route on `POST /v1/vehicles/positions`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/vehicles\/positions["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/vehicles\/positions['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/vehicles\/positions"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"vehicles"\s*\/\s*"positions"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/vehicles\/positions"/]},
      },
    },
    {
      id: 'skew',
      title: 'Rejects timestamps outside the accepted skew',
      detail:
        'A device timestamp more than `MAX_SKEW_MS` (300 000 ms) from the server clock is rejected with **400**. The draft accepts any timestamp, so a wrong-clock device writes positions dated last year.',
      match: {
        python: {all: [/MAX_SKEW_MS/, /abs\([^)]*device_timestamp_ms[^)]*\)/, /status_code\s*=\s*400/]},
        typescript: {all: [/MAX_SKEW_MS/, /Math\.abs\(/, /code\(\s*400\s*\)/]},
        go: {all: [/maxSkewMs/, /StatusBadRequest/]},
        scala: {all: [/MaxSkewMs/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kMaxSkewMs/, /\b400\b/]},
      },
    },
    {
      id: 'sequence',
      title: 'Dedupes replayed sequences by a per-vehicle high-water mark',
      detail:
        'The server tracks the highest accepted `sequence` per vehicle and drops any update at or below it, counting it as `duplicate`. The draft applies every sequence, so a replayed batch re-applies old positions.',
      match: {
        python: {all: [/high_water/, /duplicate/, /sequence/]},
        typescript: {all: [/highWater/, /duplicate/, /sequence/]},
        go: {all: [/highWater/, /duplicate/, /sequence/]},
        scala: {all: [/highWater/, /duplicate/, /sequence/]},
        cpp: {all: [/highWater/, /duplicate/, /sequence/]},
      },
    },
    {
      id: 'no-regression',
      title: 'Never regresses a vehicle latest state',
      detail:
        'An update is forwarded only when its timestamp is newer than the vehicle last timestamp, or equal with a larger sequence. The draft writes whatever arrives last.',
      match: {
        python: {all: [/last_timestamp_ms/, />/, /sequence/]},
        typescript: {all: [/lastTimestampMs/, />/, /sequence/]},
        go: {all: [/lastTimestampMs/, />/, /sequence/]},
        scala: {all: [/lastTimestampMs/, />/, /sequence/]},
        cpp: {all: [/lastTimestampMs/, />/, /sequence/]},
      },
    },
    {
      id: 'no-dump-log',
      title: 'Logs ids, never raw coordinates or driver identity',
      detail:
        'Accepted updates are logged with tenant, vehicle id, sequence and timestamp; raw coordinates and driver identity never reach a log line. The draft logs latitude and longitude.',
      match: {
        python: {all: [/logger\.info\(/], none: [/logger\.\w+\([^)]*(lat|lon|driver)/]},
        typescript: {all: [/log\.info\(/], none: [/log\.\w+\([^)]*(lat|lon|driver)/]},
        go: {all: [/log\.Printf\(/], none: [/log\.\w+\([^)]*(lat|lon|driver)/]},
        scala: {all: [/log\.info\(/], none: [/log\.info\([^)]*(lat|lon|driver)/]},
        cpp: {all: [/(std::)?(cerr|clog)\s*<</], none: [/(std::)?(cerr|clog)[^;]*(lat|lon|driver)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("fleet")


class PositionStore:
    def upsert(self, tenant: str, vehicle_id: str, update: dict) -> None:
        """Write the position for the vehicle."""
        raise NotImplementedError


store = PositionStore()


@app.post("/v1/vehicles/positions")
def positions(body: dict, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this draft accepts any timestamp and any sequence, writes every update through, and
    # logs raw coordinates. Review the skew bound, the sequence high-water mark and log hygiene.
    updates = body.get("updates", [])
    for u in updates:
        store.upsert(tenant, u["vehicle_id"], u)
    first = updates[0] if updates else {}
    logger.info("positions tenant=%s lat=%s lon=%s", tenant, first.get("lat"), first.get("lon"))
    return JSONResponse({"accepted": len(updates), "duplicate": 0}, status_code=200)
`,
      solution: `import logging
import time

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("fleet")

MAX_SKEW_MS = 300_000  # five minutes


class PositionStore:
    def high_water(self, tenant: str, vehicle_id: str) -> int:
        """Highest accepted sequence for the vehicle, or -1."""
        raise NotImplementedError

    def last_timestamp_ms(self, tenant: str, vehicle_id: str) -> int:
        """Timestamp of the vehicle's latest accepted position, or 0."""
        raise NotImplementedError

    def upsert(self, tenant: str, vehicle_id: str, update: dict) -> None:
        """Write the position for the vehicle."""
        raise NotImplementedError


store = PositionStore()


def validate(update: dict) -> str | None:
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
def positions(body: dict, tenant: str | None = Header(default=None, alias="X-Tenant-Id")) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    updates = body.get("updates") if isinstance(body, dict) else None
    if not isinstance(updates, list) or len(updates) == 0:
        raise HTTPException(status_code=400, detail="updates must be a non-empty list")
    now_ms = int(time.time() * 1000)
    accepted = 0
    duplicate = 0
    for update in updates:
        error = validate(update)
        if error is not None:
            raise HTTPException(status_code=400, detail=error)
        ts = update["device_timestamp_ms"]
        if abs(now_ms - update["device_timestamp_ms"]) > MAX_SKEW_MS:
            raise HTTPException(status_code=400, detail="device_timestamp_ms outside accepted skew")
        vehicle_id = update["vehicle_id"]
        sequence = update["sequence"]
        high_water = store.high_water(tenant, vehicle_id)
        if sequence <= high_water:
            duplicate += 1
            continue
        last_timestamp_ms = store.last_timestamp_ms(tenant, vehicle_id)
        if ts > last_timestamp_ms or (ts == last_timestamp_ms and sequence > high_water):
            store.upsert(tenant, vehicle_id, update)
            accepted += 1
        else:
            duplicate += 1
    logger.info("positions tenant=%s accepted=%d duplicate=%d", tenant, accepted, duplicate)
    return JSONResponse({"accepted": accepted, "duplicate": duplicate}, status_code=200)
`,
    },
    typescript: {
      starter: `/** POST /v1/vehicles/positions: a model-generated draft that writes every update. */
import Fastify from 'fastify';

export const app = Fastify();

interface Update {
  vehicle_id: string;
  device_timestamp_ms: number;
  sequence: number;
  lat: number;
  lon: number;
}

app.post('/v1/vehicles/positions', async (request, reply) => {
  // TODO: this draft accepts any timestamp and any sequence, writes every update through, and
  // logs raw coordinates. Review the skew bound, the sequence high-water mark and log hygiene.
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as {updates?: Update[]} | null;
  const updates = body?.updates ?? [];
  const first = updates[0];
  request.log.info({tenant, lat: first?.lat, lon: first?.lon}, 'positions');
  return reply.code(200).send({accepted: updates.length, duplicate: 0});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/vehicles/positions: skew-bounded, replay-safe batch ingestion. */
import Fastify from 'fastify';

import {store} from './state';

export const app = Fastify();

const MAX_SKEW_MS = 300_000;

interface Update {
  vehicle_id: string;
  device_timestamp_ms: number;
  sequence: number;
  lat: number;
  lon: number;
}

function validate(u: unknown): string | null {
  if (typeof u !== 'object' || u === null) return 'update must be an object';
  const update = u as Record<string, unknown>;
  if (typeof update.vehicle_id !== 'string' || update.vehicle_id === '')
    return 'vehicle_id must be a non-empty string';
  const ts = update.device_timestamp_ms;
  if (typeof ts !== 'number' || !Number.isInteger(ts) || ts <= 0)
    return 'device_timestamp_ms must be a positive integer';
  const seq = update.sequence;
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0)
    return 'sequence must be a non-negative integer';
  const lat = update.lat;
  if (typeof lat !== 'number' || lat < -90 || lat > 90) return 'lat must be within [-90, 90]';
  const lon = update.lon;
  if (typeof lon !== 'number' || lon < -180 || lon > 180) return 'lon must be within [-180, 180]';
  return null;
}

app.post('/v1/vehicles/positions', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '')
    return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const body = request.body as {updates?: unknown[]} | null;
  const updates = body?.updates;
  if (!Array.isArray(updates) || updates.length === 0)
    return reply.code(400).send({error: 'updates must be a non-empty list'});
  const nowMs = Date.now();
  let accepted = 0;
  let duplicate = 0;
  for (const raw of updates) {
    const error = validate(raw);
    if (error !== null) return reply.code(400).send({error});
    const update = raw as Update;
    if (Math.abs(nowMs - update.device_timestamp_ms) > MAX_SKEW_MS)
      return reply.code(400).send({error: 'device_timestamp_ms outside accepted skew'});
    const highWater = await store.highWater(tenant, update.vehicle_id);
    if (update.sequence <= highWater) {
      duplicate += 1;
      continue;
    }
    const lastTimestampMs = await store.lastTimestampMs(tenant, update.vehicle_id);
    if (
      update.device_timestamp_ms > lastTimestampMs ||
      (update.device_timestamp_ms === lastTimestampMs && update.sequence > highWater)
    ) {
      await store.upsert(tenant, update.vehicle_id, update);
      accepted += 1;
    } else {
      duplicate += 1;
    }
  }
  request.log.info({tenant, accepted, duplicate}, 'positions');
  return reply.code(200).send({accepted, duplicate});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"
)

type Update struct {
	VehicleID         string  \`json:"vehicle_id"\`
	DeviceTimestampMs int64   \`json:"device_timestamp_ms"\`
	Sequence          int     \`json:"sequence"\`
	Lat               float64 \`json:"lat"\`
	Lon               float64 \`json:"lon"\`
}

type Batch struct {
	Updates []Update \`json:"updates"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func positions(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	var batch Batch
	if err := json.NewDecoder(r.Body).Decode(&batch); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft accepts any timestamp and any sequence, writes every update through, and
	// logs raw coordinates. Review the skew bound, the sequence high-water mark and log hygiene.
	log.Printf("positions tenant=%s lat=%f lon=%f", tenant, batch.Updates[0].Lat, batch.Updates[0].Lon)
	writeJSON(rw, http.StatusOK, map[string]any{"accepted": len(batch.Updates), "duplicate": 0})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/vehicles/positions", positions)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
      solution: `package main

import (
	"encoding/json"
	"log"
	"net/http"
	"time"
)

const maxSkewMs = 300_000

type Update struct {
	VehicleID         string  \`json:"vehicle_id"\`
	DeviceTimestampMs int64   \`json:"device_timestamp_ms"\`
	Sequence          int     \`json:"sequence"\`
	Lat               float64 \`json:"lat"\`
	Lon               float64 \`json:"lon"\`
}

type Batch struct {
	Updates []Update \`json:"updates"\`
}

type PositionStore struct{}

func (s *PositionStore) HighWater(tenant, vehicleID string) (int, error) { return -1, nil }
func (s *PositionStore) LastTimestampMs(tenant, vehicleID string) (int64, error) { return 0, nil }
func (s *PositionStore) Upsert(tenant string, u Update) error { return nil }

var store = &PositionStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func valid(u Update) string {
	if u.VehicleID == "" {
		return "vehicle_id must be a non-empty string"
	}
	if u.DeviceTimestampMs <= 0 {
		return "device_timestamp_ms must be a positive integer"
	}
	if u.Sequence < 0 {
		return "sequence must be a non-negative integer"
	}
	if u.Lat < -90 || u.Lat > 90 {
		return "lat must be within [-90, 90]"
	}
	if u.Lon < -180 || u.Lon > 180 {
		return "lon must be within [-180, 180]"
	}
	return ""
}

func positions(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	var batch Batch
	if err := json.NewDecoder(r.Body).Decode(&batch); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if len(batch.Updates) == 0 {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "updates must be a non-empty list"})
		return
	}
	nowMs := time.Now().UnixMilli()
	accepted, duplicate := 0, 0
	for _, u := range batch.Updates {
		if msg := valid(u); msg != "" {
			writeJSON(rw, http.StatusBadRequest, map[string]string{"error": msg})
			return
		}
		if diff := nowMs - u.DeviceTimestampMs; diff > maxSkewMs || diff < -maxSkewMs {
			writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "device_timestamp_ms outside accepted skew"})
			return
		}
		highWater, err := store.HighWater(tenant, u.VehicleID)
		if err != nil {
			writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
			return
		}
		sequence := u.Sequence
		if sequence <= highWater {
			duplicate++
			continue
		}
		lastTimestampMs, err := store.LastTimestampMs(tenant, u.VehicleID)
		if err != nil {
			writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
			return
		}
		if u.DeviceTimestampMs > lastTimestampMs || (u.DeviceTimestampMs == lastTimestampMs && sequence > highWater) {
			if err := store.Upsert(tenant, u); err != nil {
				writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
				return
			}
			accepted++
		} else {
			duplicate++
		}
	}
	log.Printf("positions tenant=%s accepted=%d duplicate=%d", tenant, accepted, duplicate)
	writeJSON(rw, http.StatusOK, map[string]any{"accepted": accepted, "duplicate": duplicate})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/vehicles/positions", positions)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class Update(vehicle_id: String, device_timestamp_ms: Long, sequence: Int, lat: Double, lon: Double)
final case class Batch(updates: List[Update])

object PositionApi {
  implicit val system: ActorSystem = ActorSystem("fleet")
  implicit val updateFormat: RootJsonFormat[Update] = jsonFormat5(Update)
  implicit val batchFormat: RootJsonFormat[Batch] = jsonFormat1(Batch)

  val route: Route =
    path("v1" / "vehicles" / "positions") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[Batch]) { batch =>
            // TODO: this draft accepts any timestamp and any sequence, writes every update
            // through, and logs raw coordinates. Review the skew bound, the sequence high-water
            // mark and log hygiene.
            system.log.info(s"positions tenant=$tenant lat=\${batch.updates.headOption.map(_.lat)} lon=\${batch.updates.headOption.map(_.lon)}")
            complete(StatusCodes.OK, s"""{"accepted":\${batch.updates.size},"duplicate":0}""")
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class Update(vehicle_id: String, device_timestamp_ms: Long, sequence: Int, lat: Double, lon: Double)
final case class Batch(updates: List[Update])

object PositionApi {
  implicit val system: ActorSystem = ActorSystem("fleet")
  implicit val updateFormat: RootJsonFormat[Update] = jsonFormat5(Update)
  implicit val batchFormat: RootJsonFormat[Batch] = jsonFormat1(Batch)

  val MaxSkewMs = 300_000L

  val store = PositionStore.open()

  def validate(u: Update): Option[String] = {
    if (u.vehicle_id.isEmpty) Some("vehicle_id must be a non-empty string")
    else if (u.device_timestamp_ms <= 0) Some("device_timestamp_ms must be a positive integer")
    else if (u.sequence < 0) Some("sequence must be a non-negative integer")
    else if (u.lat < -90 || u.lat > 90) Some("lat must be within [-90, 90]")
    else if (u.lon < -180 || u.lon > 180) Some("lon must be within [-180, 180]")
    else None
  }

  val route: Route =
    path("v1" / "vehicles" / "positions") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          entity(as[Batch]) { batch =>
            tenantOpt.filter(_.nonEmpty) match {
              case None =>
                complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
              case Some(tenant) if batch.updates.isEmpty =>
                complete(StatusCodes.BadRequest, """{"error":"updates must be a non-empty list"}""")
              case Some(tenant) =>
                val nowMs = System.currentTimeMillis()
                val results = batch.updates.foldLeft((0, 0, Option.empty[String])) {
                  case ((acc, duplicate, Some(err)), _) => (acc, duplicate, Some(err))
                  case ((acc, duplicate, None), u) =>
                    validate(u) match {
                      case Some(err) => (acc, duplicate, Some(err))
                      case None if math.abs(nowMs - u.device_timestamp_ms) > MaxSkewMs =>
                        (acc, duplicate, Some("device_timestamp_ms outside accepted skew"))
                      case None =>
                        val highWater = store.highWater(tenant, u.vehicle_id)
                        val sequence = u.sequence
                        if (sequence <= highWater) (acc, duplicate + 1, None)
                        else {
                          val lastTimestampMs = store.lastTimestampMs(tenant, u.vehicle_id)
                          if (u.device_timestamp_ms > lastTimestampMs ||
                              (u.device_timestamp_ms == lastTimestampMs && sequence > highWater)) {
                            store.upsert(tenant, u)
                            (acc + 1, duplicate, None)
                          } else (acc, duplicate + 1, None)
                        }
                    }
                }
                results match {
                  case (_, _, Some(err)) =>
                    complete(StatusCodes.BadRequest, s"""{"error":"$err"}""")
                  case (accepted, duplicate, None) =>
                    system.log.info(s"positions tenant=$tenant accepted=$accepted duplicate=$duplicate")
                    complete(StatusCodes.OK, s"""{"accepted":$accepted,"duplicate":$duplicate}""")
                }
            }
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <string>

using json = nlohmann::json;

struct PositionStore {
  void upsert(const std::string& tenant, const std::string& vehicleId, const json& update);
};

PositionStore store;

int main() {
  httplib::Server svr;

  svr.Post("/v1/vehicles/positions", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this draft accepts any timestamp and any sequence, writes every update through, and
    // logs raw coordinates. Review the skew bound, the sequence high-water mark and log hygiene.
    const auto updates = body.value("updates", json::array());
    for (const auto& u : updates) {
      store.upsert(tenant, u.value("vehicle_id", std::string()), u);
    }
    if (!updates.empty()) {
      std::cerr << "positions tenant=" << tenant << " lat=" << updates[0].value("lat", 0.0)
                << " lon=" << updates[0].value("lon", 0.0) << "\\n";
    }
    res.status = 200;
    res.set_content(json{{"accepted", updates.size()}, {"duplicate", 0}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <cmath>
#include <iostream>
#include <string>

using json = nlohmann::json;

constexpr long long kMaxSkewMs = 300'000;

struct PositionStore {
  int highWater(const std::string& tenant, const std::string& vehicleId);
  long long lastTimestampMs(const std::string& tenant, const std::string& vehicleId);
  void upsert(const std::string& tenant, const std::string& vehicleId, const json& update);
};

PositionStore store;

long long nowMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

std::string validate(const json& u) {
  if (!u.is_object()) return "update must be an object";
  if (!u.contains("vehicle_id") || !u["vehicle_id"].is_string() || u["vehicle_id"].get<std::string>().empty())
    return "vehicle_id must be a non-empty string";
  if (!u.contains("device_timestamp_ms") || !u["device_timestamp_ms"].is_number_integer() ||
      u["device_timestamp_ms"].get<long long>() <= 0)
    return "device_timestamp_ms must be a positive integer";
  if (!u.contains("sequence") || !u["sequence"].is_number_integer() || u["sequence"].get<int>() < 0)
    return "sequence must be a non-negative integer";
  if (!u.contains("lat") || !u["lat"].is_number() || u["lat"].get<double>() < -90 || u["lat"].get<double>() > 90)
    return "lat must be within [-90, 90]";
  if (!u.contains("lon") || !u["lon"].is_number() || u["lon"].get<double>() < -180 || u["lon"].get<double>() > 180)
    return "lon must be within [-180, 180]";
  return "";
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/vehicles/positions", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("updates") || !body["updates"].is_array() || body["updates"].empty()) {
      res.status = 400;
      res.set_content(R"({"error":"updates must be a non-empty list"})", "application/json");
      return;
    }
    const long long now = nowMs();
    int accepted = 0;
    int duplicate = 0;
    for (const auto& u : body["updates"]) {
      const std::string err = validate(u);
      if (!err.empty()) {
        res.status = 400;
        res.set_content(json{{"error", err}}.dump(), "application/json");
        return;
      }
      const auto vehicleId = u["vehicle_id"].get<std::string>();
      const auto ts = u["device_timestamp_ms"].get<long long>();
      const int sequence = u["sequence"].get<int>();
      if (std::llabs(now - ts) > kMaxSkewMs) {
        res.status = 400;
        res.set_content(R"({"error":"device_timestamp_ms outside accepted skew"})", "application/json");
        return;
      }
      const int highWater = store.highWater(tenant, vehicleId);
      if (sequence <= highWater) {
        ++duplicate;
        continue;
      }
      const long long lastTimestampMs = store.lastTimestampMs(tenant, vehicleId);
      if (ts > lastTimestampMs || (ts == lastTimestampMs && sequence > highWater)) {
        store.upsert(tenant, vehicleId, u);
        ++accepted;
      } else {
        ++duplicate;
      }
    }
    std::cerr << "positions tenant=" << tenant << " accepted=" << accepted << " duplicate=" << duplicate << "\\n";
    res.status = 200;
    res.set_content(json{{"accepted", accepted}, {"duplicate", duplicate}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Validate every update before touching the store: shape, ranges, then the two time rules. The skew bound is `abs(server_now_ms - device_timestamp_ms) > MAX_SKEW_MS`; reject the whole batch with 400 rather than writing a bad time.',
    'The high-water sequence is what makes replays idempotent: keep the largest accepted `sequence` per vehicle and drop any update at or below it, counting it as `duplicate` while still returning **200**.',
    'Never log raw coordinates or driver identity. Log the tenant, vehicle id, sequence and timestamp; if you need coordinates for debugging, log a coarse cell or a hash.',
  ],
  debrief: `The interviewer is testing whether you can review a generated batch-ingestion endpoint. The draft reads fine because the demo sends well-formed updates from one device with a correct clock and never replays a batch. Three defects are being checked: the skew bound (a wrong-clock device cannot write the past), the sequence high-water mark (a replay cannot re-apply old positions), and log hygiene (coordinates are sensitive and never reach a log line). Real fleets add per-device skew allowances, a server-assigned monotonic sequence for devices that cannot be trusted, and back-pressure on the batch size.`,
};
