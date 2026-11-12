import type {Step} from '@/lib/types';

// ---- 5. GET /v1/fleets/{id}/positions -----------------------------------------------------------
export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/fleets/{id}/positions: one instant, flagged, capped, paged',
  concept: 'http',
  guides: ['honest-reads', 'request-boundaries'],
  file: 'snapshot',
  focus: ['dispatcher', 'api', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/fleets/{fleet_id}/positions\` with the tenant in
\`X-Tenant-Id\`: it reads the fleet's members from the set \`fleet:{tenant}:{fleet_id}\` (404 when
empty), then \`HGETALL\`s each vehicle's \`vehicle:{id}:latest\` in turn and answers
\`{"fleet_id", "snapshot_at_ms", "vehicles": [{"vehicle_id", "device_timestamp_ms", "sequence",
"lat", "lon"}]}\`. It serves the demo and hides five flaws.

**Failure mode the checks target.** A dispatcher's map redraws from this response every few
seconds for fleets of thousands of vehicles that keep reporting while it is read. The map must not
mix two instants, must not draw a vehicle that stopped reporting an hour ago as current, and must
not be answered with 5 000 records at once.

- A missing or empty \`X-Tenant-Id\` is **401**; a fleet the tenant does not have is **404**.
- The records are read in **one round trip** (\`MULTI\`/\`EXEC\`), so the snapshot is one instant.
- Each vehicle carries \`"stale": true\` when its record is missing or older than
  \`FRESHNESS_BOUND_MS\` (60 000) at \`snapshot_at_ms\`; the response carries the \`stale\` count.
- At most \`MAX_VEHICLES\` (5 000) of the fleet, in vehicle-id order, with \`"truncated": true\` past it.
- \`limit\` (1..1000, default 500) and \`cursor\` (the last vehicle id of a page) page through them;
  the response carries the next \`cursor\` or \`null\`, and \`max_vehicles\`.`,
  sequence: {
    participants: ['Dispatcher', 'fleetd', 'Redis'],
    messages: [
      {
        from: 'Dispatcher',
        to: 'fleetd',
        label: 'GET /v1/fleets/f-1/positions?limit=2 · X-Tenant-Id: t-1',
        kind: 'sync',
      },
      {from: 'fleetd', to: 'Redis', label: 'SMEMBERS fleet:t-1:f-1 → v-1 v-2 v-3', kind: 'sync'},
      {
        from: 'fleetd',
        to: 'Redis',
        label: 'MULTI · HGETALL vehicle:v-1:latest · HGETALL vehicle:v-2:latest · EXEC',
        kind: 'sync',
      },
      {from: 'Redis', to: 'fleetd', label: '[{ts, seq, lat, lon}, {}]', kind: 'reply'},
      {
        from: 'fleetd',
        to: 'Dispatcher',
        label: '200 {vehicles: [v-1, v-2 stale], stale: 1, cursor: "v-2"}',
        kind: 'reply',
      },
    ],
  },
  hints: [
    'The map shows a truck in two places after a redraw, a van parked for the weekend is still drawn as live on Monday, and the first request for a 5 000-vehicle fleet times out.',
    'One `HGETALL` per vehicle is thousands of round trips during which positions keep landing, so vehicle 1 is read before an update and vehicle 900 after it; nothing compares `ts` with now; everything is returned.',
    '`SMEMBERS`, sort, cap at `MAX_VEHICLES`, slice the page after `cursor`; queue every `HGETALL` of the page in a `MULTI` and `EXEC` once; flag `snapshot_at_ms - ts > FRESHNESS_BOUND_MS`; answer the next cursor.',
  ],
  checks: [
    {
      id: 'route',
      title: 'GET /v1/fleets/{id}/positions answers the fleet',
      detail: "A tenant reading its fleet gets 200 with every member's latest position.",
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/fleets\/\{fleet_id\}\/positions["']/, /smembers\(/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/fleets\/:fleetId\/positions['"]/, /smembers\(/]},
        go: {all: [/"GET \/v1\/fleets\/\{fleetID\}\/positions"/, /SMembers\(/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"fleets"\s*\/\s*Segment\s*\/\s*"positions"\s*\)/, /smembers\(/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/fleets\//, /smembers\(/]},
      },
    },
    {
      id: 'tenant-scope',
      title: "No tenant 401, another tenant's fleet 404",
      detail:
        'Without `X-Tenant-Id` the read is 401; with one, only `fleet:{tenant}:{fleet_id}` is read, so a fleet of another tenant is 404. The starter reads for an empty tenant.',
      match: {
        python: {
          all: [/status_code\s*=\s*401/, /status_code\s*=\s*404/],
          none: [/headers\.get\(\s*["']x-tenant-id["']\s*,\s*["']["']\s*\)/i],
        },
        typescript: {all: [/code\(\s*401\s*\)/, /code\(\s*404\s*\)/], none: [/\?\?\s*['"]['"]/]},
        go: {all: [/http\.StatusUnauthorized|\b401\b/, /http\.StatusNotFound|\b404\b/]},
        scala: {
          all: [/StatusCodes\.Unauthorized|\b401\b/, /StatusCodes\.NotFound|\b404\b/],
          none: [/tenant\s*=\s*header\.getOrElse\(\s*""\s*\)/],
        },
        cpp: {all: [/status\s*=\s*401/, /status\s*=\s*404/]},
      },
    },
    {
      id: 'freshness',
      title: 'stale past FRESHNESS_BOUND_MS',
      detail:
        'A record older than 60 000 ms at `snapshot_at_ms`, or missing, is `"stale": true`; the response counts them in `stale`. The starter draws an hour-old position as current.',
      match: {
        python: {all: [/FRESHNESS_BOUND_MS\s*=\s*60_?000/, /["']stale["']/, />\s*FRESHNESS_BOUND_MS/]},
        typescript: {all: [/FRESHNESS_BOUND_MS\s*=\s*60_?000/, /stale/, />\s*FRESHNESS_BOUND_MS/]},
        go: {all: [/freshnessBoundMs\s*=\s*60_?000/, /"stale"/, />\s*freshnessBoundMs/]},
        scala: {all: [/FreshnessBoundMs\s*=\s*60000L?/, /"stale"/, />\s*FreshnessBoundMs/]},
        cpp: {all: [/kFreshnessBoundMs\s*=\s*60000/, /"stale"/, />\s*kFreshnessBoundMs/]},
      },
    },
    {
      id: 'cap',
      title: 'At most 5 000 vehicles, truncated past it',
      detail:
        'A fleet of 5 002 is answered as its first 5 000 vehicles in id order over the pages, with `"truncated": true`. The starter answers them all.',
      match: {
        python: {all: [/MAX_VEHICLES\s*=\s*5000/, /truncated/, /MAX_VEHICLES\s*\]/]},
        typescript: {all: [/MAX_VEHICLES\s*=\s*5000/, /truncated/, /slice\(\s*0\s*,\s*MAX_VEHICLES\s*\)/]},
        go: {all: [/maxVehicles\s*=\s*5000/, /truncated/, /\[:maxVehicles\]/]},
        scala: {all: [/MaxVehicles\s*=\s*5000/, /truncated/, /take\(\s*MaxVehicles\s*\)/]},
        cpp: {
          all: [/kMaxVehicles\s*=\s*5000/, /truncated/, /resize\(\s*kMaxVehicles\s*\)|begin\(\)\s*\+\s*kMaxVehicles/],
        },
      },
    },
    {
      id: 'pagination',
      title: 'limit and cursor page through the fleet',
      detail:
        '`limit` 1..1000 (default 500, else 400) and `cursor` chain the pages without gap or overlap; the last page answers `"cursor": null`. The starter answers the whole fleet.',
      match: {
        python: {all: [/MAX_LIMIT\s*=\s*1000/, /DEFAULT_LIMIT\s*=\s*500/, /cursor/]},
        typescript: {all: [/MAX_LIMIT\s*=\s*1000/, /DEFAULT_LIMIT\s*=\s*500/, /cursor/]},
        go: {all: [/maxLimit\s*=\s*1000/, /defaultLimit\s*=\s*500/, /cursor/]},
        scala: {all: [/MaxLimit\s*=\s*1000/, /DefaultLimit\s*=\s*500/, /cursor/]},
        cpp: {all: [/kMaxLimit\s*=\s*1000/, /kDefaultLimit\s*=\s*500/, /cursor/]},
      },
    },
    {
      id: 'one-instant',
      title: "The page's records are read in one MULTI/EXEC",
      detail:
        'A position that lands while the page is read is either in every record of the snapshot or in none. The starter reads vehicle by vehicle, one round trip each.',
      match: {
        python: {all: [/\.pipeline\(/, /\.execute\(\)/], none: [/\br\.hgetall\(/]},
        typescript: {all: [/redis\.(multi|pipeline)\(\)/, /\.exec\(\)/], none: [/await redis\.hgetall\(/]},
        go: {all: [/TxPipelined\(|Pipelined\(/], none: [/rdb\.HGetAll\(/]},
        scala: {all: [/\.multi\(\)|\.pipelined\(\)/, /\.exec\(\)|\.sync\(\)/], none: [/jedis\.hgetAll\(/]},
        cpp: {all: [/redis\.(transaction|pipeline)\(/, /\.exec\(\)/], none: [/redis\.hgetall\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import redis
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


def view(vehicle_id: str, rec: dict) -> dict:
    """One vehicle of the response from its latest record (empty when it has none)."""
    return {
        "vehicle_id": vehicle_id,
        "device_timestamp_ms": int(rec["ts"]) if rec else None,
        "sequence": int(rec["seq"]) if rec else None,
        "lat": float(rec["lat"]) if rec else None,
        "lon": float(rec["lon"]) if rec else None,
    }


@app.get("/v1/fleets/{fleet_id}/positions")
def snapshot(fleet_id: str, request: Request) -> Response:
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    members = sorted(r.smembers(f"fleet:{tenant}:{fleet_id}"))
    if not members:
        return JSONResponse({"error": "no such fleet"}, status_code=404)
    vehicles = [view(vehicle_id, r.hgetall(f"vehicle:{vehicle_id}:latest")) for vehicle_id in members]
    return JSONResponse({"fleet_id": fleet_id, "snapshot_at_ms": int(time.time() * 1000), "vehicles": vehicles})
`,
      solution: `import time
from bisect import bisect_right

import redis
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

FRESHNESS_BOUND_MS = 60_000
MAX_VEHICLES = 5000
DEFAULT_LIMIT = 500
MAX_LIMIT = 1000


def view(vehicle_id: str, rec: dict, snapshot_at_ms: int) -> dict:
    """One vehicle of the response from its latest record (empty when it has none), flagged stale past the bound."""
    ts = int(rec["ts"]) if rec else None
    return {
        "vehicle_id": vehicle_id,
        "device_timestamp_ms": ts,
        "sequence": int(rec["seq"]) if rec else None,
        "lat": float(rec["lat"]) if rec else None,
        "lon": float(rec["lon"]) if rec else None,
        "stale": ts is None or snapshot_at_ms - ts > FRESHNESS_BOUND_MS,
    }


@app.get("/v1/fleets/{fleet_id}/positions")
def snapshot(fleet_id: str, request: Request) -> Response:
    tenant = request.headers.get("x-tenant-id")
    if not tenant:
        return JSONResponse({"error": "missing X-Tenant-Id"}, status_code=401)
    try:
        limit = int(request.query_params.get("limit", DEFAULT_LIMIT))
    except ValueError:
        limit = 0
    if not 1 <= limit <= MAX_LIMIT:
        return JSONResponse({"error": f"limit must be within [1, {MAX_LIMIT}]"}, status_code=400)
    cursor = request.query_params.get("cursor")
    members = sorted(r.smembers(f"fleet:{tenant}:{fleet_id}"))
    if not members:
        return JSONResponse({"error": "no such fleet"}, status_code=404)
    truncated = len(members) > MAX_VEHICLES
    members = members[:MAX_VEHICLES]
    start = bisect_right(members, cursor) if cursor else 0  # the page after the cursor
    page = members[start : start + limit]
    next_cursor = page[-1] if start + limit < len(members) else None
    pipe = r.pipeline(transaction=True)  # one round trip, one instant
    for vehicle_id in page:
        pipe.hgetall(f"vehicle:{vehicle_id}:latest")
    records = pipe.execute()
    snapshot_at_ms = int(time.time() * 1000)
    vehicles = [view(vehicle_id, rec, snapshot_at_ms) for vehicle_id, rec in zip(page, records)]
    return JSONResponse(
        {
            "fleet_id": fleet_id,
            "snapshot_at_ms": snapshot_at_ms,
            "vehicles": vehicles,
            "stale": sum(1 for v in vehicles if v["stale"]),
            "cursor": next_cursor,
            "max_vehicles": MAX_VEHICLES,
            "truncated": truncated,
        }
    )
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';
import Redis from 'ioredis';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

/** One vehicle of the response from its latest record (empty when it has none). */
function view(vehicle_id: string, rec: Record<string, string>) {
  const has = rec.ts !== undefined;
  return {
    vehicle_id,
    device_timestamp_ms: has ? Number(rec.ts) : null,
    sequence: has ? Number(rec.seq) : null,
    lat: has ? Number(rec.lat) : null,
    lon: has ? Number(rec.lon) : null,
  };
}

app.get('/v1/fleets/:fleetId/positions', async (request, reply) => {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const tenant = (request.headers['x-tenant-id'] as string | undefined) ?? '';
  const {fleetId} = request.params as {fleetId: string};
  const members = (await redis.smembers(\`fleet:\${tenant}:\${fleetId}\`)).sort();
  if (members.length === 0) return reply.code(404).send({error: 'no such fleet'});
  const vehicles = [];
  for (const vehicleId of members) vehicles.push(view(vehicleId, await redis.hgetall(\`vehicle:\${vehicleId}:latest\`)));
  return {fleet_id: fleetId, snapshot_at_ms: Date.now(), vehicles};
});
`,
      solution: `import Fastify from 'fastify';
import Redis from 'ioredis';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

export const FRESHNESS_BOUND_MS = 60_000;
export const MAX_VEHICLES = 5000;
export const DEFAULT_LIMIT = 500;
export const MAX_LIMIT = 1000;

/** One vehicle of the response from its latest record (empty when it has none), flagged stale past the bound. */
function view(vehicle_id: string, rec: Record<string, string>, snapshotAtMs: number) {
  const ts = rec.ts === undefined ? null : Number(rec.ts);
  return {
    vehicle_id,
    device_timestamp_ms: ts,
    sequence: ts === null ? null : Number(rec.seq),
    lat: ts === null ? null : Number(rec.lat),
    lon: ts === null ? null : Number(rec.lon),
    stale: ts === null || snapshotAtMs - ts > FRESHNESS_BOUND_MS,
  };
}

app.get('/v1/fleets/:fleetId/positions', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {fleetId} = request.params as {fleetId: string};
  const query = request.query as {limit?: string; cursor?: string};
  const limit = query.limit === undefined ? DEFAULT_LIMIT : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return reply.code(400).send({error: \`limit must be within [1, \${MAX_LIMIT}]\`});
  const all = (await redis.smembers(\`fleet:\${tenant}:\${fleetId}\`)).sort();
  if (all.length === 0) return reply.code(404).send({error: 'no such fleet'});
  const truncated = all.length > MAX_VEHICLES;
  const members = all.slice(0, MAX_VEHICLES);
  const start = query.cursor === undefined ? 0 : members.filter(id => id <= query.cursor!).length; // the page after the cursor
  const page = members.slice(start, start + limit);
  const nextCursor = start + limit < members.length ? page[page.length - 1] : null;
  const multi = redis.multi(); // one round trip, one instant
  for (const vehicleId of page) multi.hgetall(\`vehicle:\${vehicleId}:latest\`);
  const replies = (await multi.exec()) ?? [];
  const snapshotAtMs = Date.now();
  const vehicles = page.map((vehicleId, i) => view(vehicleId, (replies[i]?.[1] ?? {}) as Record<string, string>, snapshotAtMs));
  return {
    fleet_id: fleetId,
    snapshot_at_ms: snapshotAtMs,
    vehicles,
    stale: vehicles.filter(v => v.stale).length,
    cursor: nextCursor,
    max_vehicles: MAX_VEHICLES,
    truncated,
  };
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// view is one vehicle of the response from its latest record (empty when it has none).
func view(vehicleID string, rec map[string]string) map[string]any {
	v := map[string]any{"vehicle_id": vehicleID, "device_timestamp_ms": nil, "sequence": nil, "lat": nil, "lon": nil}
	if len(rec) > 0 {
		v["device_timestamp_ms"], _ = strconv.ParseInt(rec["ts"], 10, 64)
		v["sequence"], _ = strconv.ParseInt(rec["seq"], 10, 64)
		v["lat"], _ = strconv.ParseFloat(rec["lat"], 64)
		v["lon"], _ = strconv.ParseFloat(rec["lon"], 64)
	}
	return v
}

func getSnapshot(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	fleetID := r.PathValue("fleetID")
	members, err := rdb.SMembers(r.Context(), "fleet:"+tenant+":"+fleetID).Result()
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	sort.Strings(members)
	if len(members) == 0 {
		http.Error(rw, "no such fleet", http.StatusNotFound)
		return
	}
	vehicles := make([]map[string]any, 0, len(members))
	for _, vehicleID := range members {
		rec, _ := rdb.HGetAll(r.Context(), "vehicle:"+vehicleID+":latest").Result()
		vehicles = append(vehicles, view(vehicleID, rec))
	}
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode(map[string]any{"fleet_id": fleetID, "snapshot_at_ms": time.Now().UnixMilli(), "vehicles": vehicles})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/fleets/{fleetID}/positions", getSnapshot)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	freshnessBoundMs = 60_000
	maxVehicles      = 5000
	defaultLimit     = 500
	maxLimit         = 1000
)

// view is one vehicle of the response from its latest record (empty when it has none), flagged stale past the bound.
func view(vehicleID string, rec map[string]string, snapshotAtMs int64) map[string]any {
	v := map[string]any{"vehicle_id": vehicleID, "device_timestamp_ms": nil, "sequence": nil, "lat": nil, "lon": nil, "stale": true}
	if len(rec) > 0 {
		ts, _ := strconv.ParseInt(rec["ts"], 10, 64)
		v["device_timestamp_ms"] = ts
		v["sequence"], _ = strconv.ParseInt(rec["seq"], 10, 64)
		v["lat"], _ = strconv.ParseFloat(rec["lat"], 64)
		v["lon"], _ = strconv.ParseFloat(rec["lon"], 64)
		v["stale"] = snapshotAtMs-ts > freshnessBoundMs
	}
	return v
}

func getSnapshot(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "missing X-Tenant-Id", http.StatusUnauthorized)
		return
	}
	fleetID := r.PathValue("fleetID")
	limit := defaultLimit
	if s := r.URL.Query().Get("limit"); s != "" {
		n, err := strconv.Atoi(s)
		if err != nil || n < 1 || n > maxLimit {
			http.Error(rw, "limit must be within [1, 1000]", http.StatusBadRequest)
			return
		}
		limit = n
	}
	cursor := r.URL.Query().Get("cursor")
	all, err := rdb.SMembers(r.Context(), "fleet:"+tenant+":"+fleetID).Result()
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	sort.Strings(all)
	if len(all) == 0 {
		http.Error(rw, "no such fleet", http.StatusNotFound)
		return
	}
	truncated := len(all) > maxVehicles
	members := all
	if truncated {
		members = all[:maxVehicles]
	}
	start := 0
	if cursor != "" { // the page after the cursor
		start = sort.SearchStrings(members, cursor)
		if start < len(members) && members[start] == cursor {
			start++
		}
	}
	end := start + limit
	if end > len(members) {
		end = len(members)
	}
	page := members[start:end]
	var nextCursor any
	if end < len(members) {
		nextCursor = page[len(page)-1]
	}
	cmds := make([]*redis.MapStringStringCmd, len(page))
	_, err = rdb.TxPipelined(r.Context(), func(pipe redis.Pipeliner) error { // one round trip, one instant
		for i, vehicleID := range page {
			cmds[i] = pipe.HGetAll(r.Context(), "vehicle:"+vehicleID+":latest")
		}
		return nil
	})
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	snapshotAtMs := time.Now().UnixMilli()
	vehicles := make([]map[string]any, 0, len(page))
	stale := 0
	for i, vehicleID := range page {
		v := view(vehicleID, cmds[i].Val(), snapshotAtMs)
		if v["stale"] == true {
			stale++
		}
		vehicles = append(vehicles, v)
	}
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode(map[string]any{
		"fleet_id":       fleetID,
		"snapshot_at_ms": snapshotAtMs,
		"vehicles":       vehicles,
		"stale":          stale,
		"cursor":         nextCursor,
		"max_vehicles":   maxVehicles,
		"truncated":      truncated,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/fleets/{fleetID}/positions", getSnapshot)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import scala.jdk.CollectionConverters._

object Snapshot {
  /** One vehicle of the response from its latest record (empty when it has none). */
  def view(vehicleId: String, rec: Map[String, String]): JsObject =
    JsObject(
      "vehicle_id"          -> JsString(vehicleId),
      "device_timestamp_ms" -> rec.get("ts").map(ts => JsNumber(ts.toLong)).getOrElse(JsNull),
      "sequence"            -> rec.get("seq").map(s => JsNumber(s.toLong)).getOrElse(JsNull),
      "lat"                 -> rec.get("lat").map(v => JsNumber(v.toDouble)).getOrElse(JsNull),
      "lon"                 -> rec.get("lon").map(v => JsNumber(v.toDouble)).getOrElse(JsNull)
    )

  val route: Route =
    path("v1" / "fleets" / Segment / "positions") { fleetId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { header =>
          // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
          val tenant  = header.getOrElse("")
          val members = State.jedis.smembers(s"fleet:$tenant:$fleetId").asScala.toList.sorted
          if (members.isEmpty) complete(StatusCodes.NotFound -> "no such fleet")
          else {
            val vehicles = members.map(id => view(id, State.jedis.hgetAll(s"vehicle:$id:latest").asScala.toMap))
            val body = JsObject(
              "fleet_id"       -> JsString(fleetId),
              "snapshot_at_ms" -> JsNumber(System.currentTimeMillis()),
              "vehicles"       -> JsArray(vehicles.toVector)
            )
            complete(HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))
          }
        }
      }
    }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import scala.jdk.CollectionConverters._

object Snapshot {
  val FreshnessBoundMs = 60000L
  val MaxVehicles      = 5000
  val DefaultLimit     = 500
  val MaxLimit         = 1000

  /** One vehicle of the response from its latest record (empty when it has none), flagged stale past the bound. */
  def view(vehicleId: String, rec: Map[String, String], snapshotAtMs: Long): JsObject = {
    val ts = rec.get("ts").map(_.toLong)
    JsObject(
      "vehicle_id"          -> JsString(vehicleId),
      "device_timestamp_ms" -> ts.map(JsNumber(_)).getOrElse(JsNull),
      "sequence"            -> rec.get("seq").map(s => JsNumber(s.toLong)).getOrElse(JsNull),
      "lat"                 -> rec.get("lat").map(v => JsNumber(v.toDouble)).getOrElse(JsNull),
      "lon"                 -> rec.get("lon").map(v => JsNumber(v.toDouble)).getOrElse(JsNull),
      "stale"               -> JsBoolean(ts.forall(t => snapshotAtMs - t > FreshnessBoundMs))
    )
  }

  val route: Route =
    path("v1" / "fleets" / Segment / "positions") { fleetId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") {
          case None | Some("") => complete(StatusCodes.Unauthorized -> "missing X-Tenant-Id")
          case Some(tenant) =>
            parameters("limit".as[Int].?, "cursor".?) { (limitParam, cursor) =>
              val limit = limitParam.getOrElse(DefaultLimit)
              val all   = State.jedis.smembers(s"fleet:$tenant:$fleetId").asScala.toList.sorted
              if (limit < 1 || limit > MaxLimit) complete(StatusCodes.BadRequest -> s"limit must be within [1, $MaxLimit]")
              else if (all.isEmpty) complete(StatusCodes.NotFound -> "no such fleet")
              else {
                val truncated  = all.size > MaxVehicles
                val members    = all.take(MaxVehicles)
                val start      = cursor.map(c => members.count(_ <= c)).getOrElse(0) // the page after the cursor
                val page       = members.slice(start, start + limit)
                val nextCursor = if (start + limit < members.size) JsString(page.last) else JsNull
                val tx         = State.jedis.multi() // one round trip, one instant
                val replies    = page.map(id => tx.hgetAll(s"vehicle:$id:latest"))
                tx.exec()
                val snapshotAtMs = System.currentTimeMillis()
                val vehicles     = page.zip(replies).map { case (id, reply) => view(id, reply.get.asScala.toMap, snapshotAtMs) }
                val body = JsObject(
                  "fleet_id"       -> JsString(fleetId),
                  "snapshot_at_ms" -> JsNumber(snapshotAtMs),
                  "vehicles"       -> JsArray(vehicles.toVector),
                  "stale"          -> JsNumber(vehicles.count(_.fields("stale") == JsTrue)),
                  "cursor"         -> nextCursor,
                  "max_vehicles"   -> JsNumber(MaxVehicles),
                  "truncated"      -> JsBoolean(truncated)
                )
                complete(HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))
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
#include <sw/redis++/redis++.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <string>
#include <unordered_map>
#include <vector>

sw::redis::Redis redis("tcp://redis:6379");

// One vehicle of the response from its latest record (empty when it has none).
nlohmann::json view(const std::string& vehicle_id, const std::unordered_map<std::string, std::string>& rec) {
  nlohmann::json v = {{"vehicle_id", vehicle_id}, {"device_timestamp_ms", nullptr}, {"sequence", nullptr}, {"lat", nullptr}, {"lon", nullptr}};
  if (!rec.empty()) {
    v["device_timestamp_ms"] = std::stoll(rec.at("ts"));
    v["sequence"] = std::stoll(rec.at("seq"));
    v["lat"] = std::stod(rec.at("lat"));
    v["lon"] = std::stod(rec.at("lon"));
  }
  return v;
}

void get_snapshot(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  const std::string fleet_id = req.matches[1].str();
  std::vector<std::string> members = redis.smembers("fleet:" + tenant + ":" + fleet_id);
  std::sort(members.begin(), members.end());
  if (members.empty()) {
    res.status = 404;
    res.set_content(R"({"error":"no such fleet"})", "application/json");
    return;
  }
  nlohmann::json vehicles = nlohmann::json::array();
  for (const auto& vehicle_id : members) {
    vehicles.push_back(view(vehicle_id, redis.hgetall("vehicle:" + vehicle_id + ":latest")));
  }
  const long long snapshot_at_ms =
      std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  res.set_content(nlohmann::json{{"fleet_id", fleet_id}, {"snapshot_at_ms", snapshot_at_ms}, {"vehicles", vehicles}}.dump(),
                  "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Get(R"(/v1/fleets/([^/]+)/positions)", get_snapshot);
}
`,
      solution: `#define CPPHTTPLIB_OPENSSL_SUPPORT
#include <httplib.h>
#include <sw/redis++/redis++.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <iterator>
#include <string>
#include <unordered_map>
#include <vector>

sw::redis::Redis redis("tcp://redis:6379");

constexpr long long kFreshnessBoundMs = 60000;
constexpr size_t kMaxVehicles = 5000;
constexpr int kDefaultLimit = 500;
constexpr int kMaxLimit = 1000;

// One vehicle of the response from its latest record (empty when it has none), flagged stale past the bound.
nlohmann::json view(const std::string& vehicle_id, const std::unordered_map<std::string, std::string>& rec, long long snapshot_at_ms) {
  nlohmann::json v = {{"vehicle_id", vehicle_id}, {"device_timestamp_ms", nullptr}, {"sequence", nullptr}, {"lat", nullptr},
                      {"lon", nullptr},           {"stale", true}};
  if (!rec.empty()) {
    const long long ts = std::stoll(rec.at("ts"));
    v["device_timestamp_ms"] = ts;
    v["sequence"] = std::stoll(rec.at("seq"));
    v["lat"] = std::stod(rec.at("lat"));
    v["lon"] = std::stod(rec.at("lon"));
    v["stale"] = snapshot_at_ms - ts > kFreshnessBoundMs;
  }
  return v;
}

void get_snapshot(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
    return;
  }
  const std::string fleet_id = req.matches[1].str();
  int limit = kDefaultLimit;
  if (req.has_param("limit")) {
    try {
      limit = std::stoi(req.get_param_value("limit"));
    } catch (const std::exception&) {
      limit = 0;
    }
  }
  if (limit < 1 || limit > kMaxLimit) {
    res.status = 400;
    res.set_content(R"({"error":"limit must be within [1, 1000]"})", "application/json");
    return;
  }
  std::vector<std::string> all = redis.smembers("fleet:" + tenant + ":" + fleet_id);
  std::sort(all.begin(), all.end());
  if (all.empty()) {
    res.status = 404;
    res.set_content(R"({"error":"no such fleet"})", "application/json");
    return;
  }
  const bool truncated = all.size() > kMaxVehicles;
  std::vector<std::string> members(all.begin(), truncated ? all.begin() + kMaxVehicles : all.end());
  size_t start = 0;  // the page after the cursor
  if (req.has_param("cursor")) {
    start = std::upper_bound(members.begin(), members.end(), req.get_param_value("cursor")) - members.begin();
  }
  const size_t end = std::min(start + static_cast<size_t>(limit), members.size());
  const std::vector<std::string> page(members.begin() + start, members.begin() + end);
  auto tx = redis.transaction();  // one round trip, one instant
  for (const auto& vehicle_id : page) tx.hgetall("vehicle:" + vehicle_id + ":latest");
  auto replies = tx.exec();
  const long long snapshot_at_ms =
      std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  nlohmann::json vehicles = nlohmann::json::array();
  int stale = 0;
  for (size_t i = 0; i < page.size(); i++) {
    std::unordered_map<std::string, std::string> rec;
    replies.get(i, std::inserter(rec, rec.begin()));
    nlohmann::json v = view(page[i], rec, snapshot_at_ms);
    if (v["stale"].get<bool>()) stale++;
    vehicles.push_back(v);
  }
  nlohmann::json body = {{"fleet_id", fleet_id},     {"snapshot_at_ms", snapshot_at_ms}, {"vehicles", vehicles},
                         {"stale", stale},           {"cursor", nullptr},                {"max_vehicles", kMaxVehicles},
                         {"truncated", truncated}};
  if (end < members.size()) body["cursor"] = page.back();
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Get(R"(/v1/fleets/([^/]+)/positions)", get_snapshot);
}
`,
    },
  },
  harness: {
    python: `from leetbuild.metrics import METRICS

T1 = {"X-Tenant-Id": "t-1"}
FLEET = "fleet:t-1:f-1"


def now_ms(ctx):
    return int(ctx.clock.time() * 1000)


def seed(ctx, vehicles):
    """A fleet of the given vehicles: id → device timestamp of its latest record (None: no record)."""
    ctx.redis.sadd(FLEET, *vehicles)
    for vehicle_id, ts in vehicles.items():
        if ts is not None:
            ctx.redis.hset(f"vehicle:{vehicle_id}:latest", mapping={"ts": ts, "seq": 1, "lat": 47.6, "lon": -122.3})


async def get(ctx, m, path, headers=T1):
    async with ctx.client(m.app) as c:
        return await c.get(path, headers=headers)


def ids(body):
    return [v["vehicle_id"] for v in body["vehicles"]]


async def check_route(ctx):
    now = now_ms(ctx)
    seed(ctx, {"v-1": now - 1000, "v-2": now - 2000})
    m = ctx.load("snapshot")
    r = await get(ctx, m, "/v1/fleets/f-1/positions")
    assert r.status_code == 200, f"GET /v1/fleets/f-1/positions answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("fleet_id") == "f-1" and "snapshot_at_ms" in body, f"the response must carry fleet_id and snapshot_at_ms: {body}"
    assert ids(body) == ["v-1", "v-2"], f"the fleet's vehicles are {ids(body)}, expected v-1 and v-2 in id order"
    v1 = body["vehicles"][0]
    assert v1.get("lat") == 47.6 and v1.get("lon") == -122.3 and v1.get("device_timestamp_ms") == now - 1000 and v1.get("sequence") == 1, f"v-1's position is {v1}, expected its latest record (lat 47.6, lon -122.3, ts {now - 1000}, sequence 1)"


async def check_tenant_scope(ctx):
    now = now_ms(ctx)
    seed(ctx, {"v-1": now - 1000})
    m = ctx.load("snapshot")
    r = await get(ctx, m, "/v1/fleets/f-1/positions", headers={})
    assert r.status_code == 401, f"a read without X-Tenant-Id answered {r.status_code}, expected 401"
    r = await get(ctx, m, "/v1/fleets/f-1/positions", headers={"X-Tenant-Id": "t-2"})
    assert r.status_code == 404, f"tenant t-2 reading t-1's fleet f-1 answered {r.status_code}, expected 404: the fleet is read from fleet:{{tenant}}:{{fleet_id}}, and t-2 has no f-1"
    assert "v-1" not in r.text, f"tenant t-2's read of t-1's fleet leaked v-1: {r.text}"
    r = await get(ctx, m, "/v1/fleets/f-1/positions")
    assert r.status_code == 200 and ids(r.json()) == ["v-1"], f"t-1 reading its own fleet answered {r.status_code}: {r.text}"


async def check_freshness(ctx):
    now = now_ms(ctx)
    seed(ctx, {"v-1": now - 1000, "v-2": now - 120_000, "v-3": None})
    m = ctx.load("snapshot")
    r = await get(ctx, m, "/v1/fleets/f-1/positions")
    assert r.status_code == 200, f"GET answered {r.status_code}: {r.text}"
    body = r.json()
    flags = [v.get("stale") for v in body["vehicles"]]
    assert flags == [False, True, True], f"stale flags for (1 s old, 2 min old, no record) are {flags}, expected [False, True, True]: a position older than FRESHNESS_BOUND_MS (60 000 ms) at snapshot_at_ms, or missing, is not current"
    assert body.get("stale") == 2, f"the response's stale count is {body.get('stale')!r}, expected 2"
    assert abs(body["snapshot_at_ms"] - now) < 1000, f"snapshot_at_ms is {body['snapshot_at_ms']}, expected the server clock ({now})"
    ctx.clock.advance(120)
    body = (await get(ctx, m, "/v1/fleets/f-1/positions")).json()
    assert [v.get("stale") for v in body["vehicles"]] == [True, True, True] and body.get("stale") == 3, f"two minutes later every record is older than the bound: got {[v.get('stale') for v in body['vehicles']]}"


async def check_cap(ctx):
    seed(ctx, {f"v-{i:04d}": None for i in range(5002)})
    m = ctx.load("snapshot")
    seen = []
    cursor = None
    pages = 0
    truncated = None
    while True:
        path = "/v1/fleets/f-1/positions?limit=1000" + (f"&cursor={cursor}" if cursor else "")
        r = await get(ctx, m, path)
        assert r.status_code == 200, f"GET {path} answered {r.status_code}: {r.text}"
        body = r.json()
        seen += ids(body)
        truncated = body.get("truncated")
        pages += 1
        cursor = body.get("cursor")
        assert pages <= 7, f"after {pages} pages the cursor is still {cursor!r}: the pages must end"
        if not cursor:
            break
    assert len(seen) == 5000, f"a fleet of 5 002 vehicles was answered with {len(seen)} over {pages} pages, expected MAX_VEHICLES = 5 000 (the first 5 000 in id order)"
    assert seen == sorted(seen) and seen[-1] == "v-4999", f"the pages must cover v-0000 … v-4999 in order (last was {seen[-1]})"
    assert truncated is True, f"the last page says truncated {truncated!r}, expected true: the caller must learn the fleet is larger than the cap"
    assert body.get("max_vehicles") == 5000, f"max_vehicles is {body.get('max_vehicles')!r}, expected 5000"


async def check_pagination(ctx):
    now = now_ms(ctx)
    seed(ctx, {f"v-{i}": now - 1000 for i in range(1, 6)})
    m = ctx.load("snapshot")
    r = await get(ctx, m, "/v1/fleets/f-1/positions?limit=2")
    assert r.status_code == 200, f"GET ?limit=2 answered {r.status_code}: {r.text}"
    body = r.json()
    assert ids(body) == ["v-1", "v-2"], f"the first page with limit=2 holds {ids(body)}, expected v-1 and v-2"
    assert body.get("cursor"), f"with three vehicles left the first page carries cursor {body.get('cursor')!r}, expected the last vehicle id of the page"
    r = await get(ctx, m, f"/v1/fleets/f-1/positions?limit=2&cursor={body['cursor']}")
    second = r.json()
    assert ids(second) == ["v-3", "v-4"], f"the second page holds {ids(second)}, expected v-3 and v-4: pages must chain without gap or overlap"
    third = (await get(ctx, m, f"/v1/fleets/f-1/positions?limit=2&cursor={second['cursor']}")).json()
    assert ids(third) == ["v-5"] and third.get("cursor") is None, f"the last page holds {ids(third)} with cursor {third.get('cursor')!r}, expected v-5 and cursor null"
    body = (await get(ctx, m, "/v1/fleets/f-1/positions")).json()
    assert len(ids(body)) == 5 and body.get("cursor") is None, f"without a limit the default (500) covers all five: got {ids(body)} cursor {body.get('cursor')!r}"
    for bad in ("0", "1001", "-1"):
        r = await get(ctx, m, f"/v1/fleets/f-1/positions?limit={bad}")
        assert r.status_code == 400, f"limit={bad} answered {r.status_code}, expected 400 (limit is 1..1000)"


async def check_one_instant(ctx):
    now = now_ms(ctx)
    seed(ctx, {"v-1": now - 1000, "v-2": now - 1000, "v-3": now - 1000})
    m = ctx.load("snapshot")
    # A position for v-3 lands while the page is being read, right after v-1's record was fetched.
    probe = ctx.redis_after("vehicle:v-1:latest", lambda: ctx.redis.hset("vehicle:v-3:latest", mapping={"ts": now, "seq": 2, "lat": 9.0, "lon": 9.0}))
    trips = METRICS.redis_trips
    r = await get(ctx, m, "/v1/fleets/f-1/positions")
    trips = METRICS.redis_trips - trips
    assert r.status_code == 200, f"GET answered {r.status_code}: {r.text}"
    assert probe.fired, "the read touched no vehicle:v-1:latest"
    v3 = [v for v in r.json()["vehicles"] if v["vehicle_id"] == "v-3"][0]
    assert v3.get("lat") == 47.6, f"v-3 shows lat {v3.get('lat')} although v-1 was read before v-3's new position landed: the snapshot mixes two instants. Read every record of the page in one MULTI/EXEC"
    assert trips <= 3, f"the read cost {trips} Redis round trips for three vehicles, expected the members and one MULTI/EXEC: a 5 000-vehicle fleet must not cost 5 000 round trips"
`,
    typescript: `const T1 = {'X-Tenant-Id': 't-1'};
const FLEET = 'fleet:t-1:f-1';

/** A fleet of the given vehicles: id → device timestamp of its latest record (null: no record). */
function seed(ctx, vehicles: Record<string, number | null>) {
  ctx.redis.sadd(FLEET, ...Object.keys(vehicles));
  for (const [vehicleId, ts] of Object.entries(vehicles)) {
    if (ts !== null) ctx.redis.hset(\`vehicle:\${vehicleId}:latest\`, 'ts', ts, 'seq', 1, 'lat', 47.6, 'lon', -122.3);
  }
}

function snapshot(ctx) {
  const m = ctx.load('snapshot');
  return ctx.client(m.app);
}

interface Vehicle {
  vehicle_id: string;
  device_timestamp_ms: number | null;
  sequence: number | null;
  lat: number | null;
  lon: number | null;
  stale?: boolean;
}

/** The snapshot as the step answers it; the fields past vehicles are what the checks look for. */
interface Snapshot {
  fleet_id?: string;
  snapshot_at_ms?: number;
  vehicles: Vehicle[];
  stale?: number;
  cursor?: string | null;
  max_vehicles?: number;
  truncated?: boolean;
}

const ids = (body: Snapshot): string[] => body.vehicles.map(v => v.vehicle_id);

export async function check_route(ctx) {
  const now = ctx.clock.now();
  seed(ctx, {'v-1': now - 1000, 'v-2': now - 2000});
  const c = snapshot(ctx);
  const r = await c.get('/v1/fleets/f-1/positions', {headers: T1});
  assert.equal(r.status, 200, \`GET /v1/fleets/f-1/positions answered \${r.status}: \${r.text}\`);
  const body = r.json() as Snapshot;
  assert(body.fleet_id === 'f-1' && 'snapshot_at_ms' in body, \`the response must carry fleet_id and snapshot_at_ms: \${r.text}\`);
  assert.deepStrictEqual(ids(body), ['v-1', 'v-2'], \`the fleet's vehicles are \${JSON.stringify(ids(body))}, expected v-1 and v-2 in id order\`);
  const v1 = body.vehicles[0];
  assert(v1.lat === 47.6 && v1.lon === -122.3 && v1.device_timestamp_ms === now - 1000 && v1.sequence === 1, \`v-1's position is \${JSON.stringify(v1)}, expected its latest record (lat 47.6, lon -122.3, ts \${now - 1000}, sequence 1)\`);
}

export async function check_tenant_scope(ctx) {
  const now = ctx.clock.now();
  seed(ctx, {'v-1': now - 1000});
  const c = snapshot(ctx);
  let r = await c.get('/v1/fleets/f-1/positions');
  assert.equal(r.status, 401, \`a read without X-Tenant-Id answered \${r.status}, expected 401\`);
  r = await c.get('/v1/fleets/f-1/positions', {headers: {'X-Tenant-Id': 't-2'}});
  assert.equal(r.status, 404, \`tenant t-2 reading t-1's fleet f-1 answered \${r.status}, expected 404: the fleet is read from fleet:{tenant}:{fleet_id}, and t-2 has no f-1\`);
  assert(!r.text.includes('v-1'), \`tenant t-2's read of t-1's fleet leaked v-1: \${r.text}\`);
  r = await c.get('/v1/fleets/f-1/positions', {headers: T1});
  assert(r.status === 200 && JSON.stringify(ids(r.json())) === '["v-1"]', \`t-1 reading its own fleet answered \${r.status}: \${r.text}\`);
}

export async function check_freshness(ctx) {
  const now = ctx.clock.now();
  seed(ctx, {'v-1': now - 1000, 'v-2': now - 120_000, 'v-3': null});
  const c = snapshot(ctx);
  let r = await c.get('/v1/fleets/f-1/positions', {headers: T1});
  assert.equal(r.status, 200, \`GET answered \${r.status}: \${r.text}\`);
  let body = r.json() as Snapshot;
  const flags = body.vehicles.map(v => v.stale);
  assert.deepStrictEqual(flags, [false, true, true], \`stale flags for (1 s old, 2 min old, no record) are \${JSON.stringify(flags)}, expected [false, true, true]: a position older than FRESHNESS_BOUND_MS (60 000 ms) at snapshot_at_ms, or missing, is not current\`);
  assert.equal(body.stale, 2, \`the response's stale count is \${JSON.stringify(body.stale)}, expected 2\`);
  assert(Math.abs(body.snapshot_at_ms - now) < 1000, \`snapshot_at_ms is \${body.snapshot_at_ms}, expected the server clock (\${now})\`);
  ctx.clock.advance(120);
  body = (await c.get('/v1/fleets/f-1/positions', {headers: T1})).json() as Snapshot;
  assert(JSON.stringify(body.vehicles.map(v => v.stale)) === '[true,true,true]' && body.stale === 3, \`two minutes later every record is older than the bound: got \${JSON.stringify(body.vehicles.map(v => v.stale))}\`);
}

export async function check_cap(ctx) {
  const vehicles: Record<string, null> = {};
  for (let i = 0; i < 5002; i += 1) vehicles[\`v-\${String(i).padStart(4, '0')}\`] = null;
  seed(ctx, vehicles);
  const c = snapshot(ctx);
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  let body: Snapshot = {vehicles: []};
  for (;;) {
    const path = '/v1/fleets/f-1/positions?limit=1000' + (cursor ? \`&cursor=\${cursor}\` : '');
    const r = await c.get(path, {headers: T1});
    assert.equal(r.status, 200, \`GET \${path} answered \${r.status}: \${r.text}\`);
    body = r.json();
    seen.push(...ids(body));
    pages += 1;
    cursor = body.cursor ?? null;
    assert(pages <= 7, \`after \${pages} pages the cursor is still \${JSON.stringify(cursor)}: the pages must end\`);
    if (!cursor) break;
  }
  assert.equal(seen.length, 5000, \`a fleet of 5 002 vehicles was answered with \${seen.length} over \${pages} pages, expected MAX_VEHICLES = 5 000 (the first 5 000 in id order)\`);
  assert(seen.every((id, i) => i === 0 || seen[i - 1] < id) && seen[seen.length - 1] === 'v-4999', \`the pages must cover v-0000 … v-4999 in order (last was \${seen[seen.length - 1]})\`);
  assert.strictEqual(body.truncated, true, \`the last page says truncated \${JSON.stringify(body.truncated)}, expected true: the caller must learn the fleet is larger than the cap\`);
  assert.equal(body.max_vehicles, 5000, \`max_vehicles is \${JSON.stringify(body.max_vehicles)}, expected 5000\`);
}

export async function check_pagination(ctx) {
  const now = ctx.clock.now();
  seed(ctx, {'v-1': now - 1000, 'v-2': now - 1000, 'v-3': now - 1000, 'v-4': now - 1000, 'v-5': now - 1000});
  const c = snapshot(ctx);
  let r = await c.get('/v1/fleets/f-1/positions?limit=2', {headers: T1});
  assert.equal(r.status, 200, \`GET ?limit=2 answered \${r.status}: \${r.text}\`);
  const first = r.json() as Snapshot;
  assert.deepStrictEqual(ids(first), ['v-1', 'v-2'], \`the first page with limit=2 holds \${JSON.stringify(ids(first))}, expected v-1 and v-2\`);
  assert(first.cursor, \`with three vehicles left the first page carries cursor \${JSON.stringify(first.cursor)}, expected the last vehicle id of the page\`);
  const second = (await c.get(\`/v1/fleets/f-1/positions?limit=2&cursor=\${first.cursor}\`, {headers: T1})).json() as Snapshot;
  assert.deepStrictEqual(ids(second), ['v-3', 'v-4'], \`the second page holds \${JSON.stringify(ids(second))}, expected v-3 and v-4: pages must chain without gap or overlap\`);
  const third = (await c.get(\`/v1/fleets/f-1/positions?limit=2&cursor=\${second.cursor}\`, {headers: T1})).json() as Snapshot;
  assert(JSON.stringify(ids(third)) === '["v-5"]' && third.cursor === null, \`the last page holds \${JSON.stringify(ids(third))} with cursor \${JSON.stringify(third.cursor)}, expected v-5 and cursor null\`);
  const all = (await c.get('/v1/fleets/f-1/positions', {headers: T1})).json() as Snapshot;
  assert(ids(all).length === 5 && all.cursor === null, \`without a limit the default (500) covers all five: got \${JSON.stringify(ids(all))} cursor \${JSON.stringify(all.cursor)}\`);
  for (const bad of ['0', '1001', '-1']) {
    r = await c.get(\`/v1/fleets/f-1/positions?limit=\${bad}\`, {headers: T1});
    assert.equal(r.status, 400, \`limit=\${bad} answered \${r.status}, expected 400 (limit is 1..1000)\`);
  }
}

export async function check_one_instant(ctx) {
  const now = ctx.clock.now();
  seed(ctx, {'v-1': now - 1000, 'v-2': now - 1000, 'v-3': now - 1000});
  const c = snapshot(ctx);
  // A position for v-3 lands while the page is being read, right after v-1's record was fetched.
  const probe = ctx.redisAfter('vehicle:v-1:latest', () => ctx.redis.hset('vehicle:v-3:latest', 'ts', now, 'seq', 2, 'lat', 9.0, 'lon', 9.0));
  const before = ctx.redisRoundTrips().length;
  const r = await c.get('/v1/fleets/f-1/positions', {headers: T1});
  const trips = ctx.redisRoundTrips().length - before;
  assert.equal(r.status, 200, \`GET answered \${r.status}: \${r.text}\`);
  assert(probe.fired, 'the read touched no vehicle:v-1:latest');
  const v3 = (r.json() as Snapshot).vehicles.find(v => v.vehicle_id === 'v-3');
  assert.equal(v3?.lat, 47.6, \`v-3 shows lat \${v3?.lat} although v-1 was read before v-3's new position landed: the snapshot mixes two instants. Read every record of the page in one MULTI/EXEC\`);
  assert(trips <= 3, \`the read cost \${trips} Redis round trips for three vehicles, expected the members and one MULTI/EXEC: a 5 000-vehicle fleet must not cost 5 000 round trips\`);
}
`,
    go: `package main

import (
	"fmt"
	"net/http"
	"sort"

	"leetbuild/harness"
)

const snapshotFleet = "fleet:t-1:f-1"

// snapshotSeed is a fleet of the given vehicles: id → device timestamp of its latest record (-1: no record).
func snapshotSeed(ctx *harness.Ctx, vehicles map[string]int64) {
	args := []any{"SADD", snapshotFleet}
	for id := range vehicles {
		args = append(args, id)
	}
	ctx.Redis.Do(args...)
	for id, ts := range vehicles {
		if ts >= 0 {
			ctx.Redis.Do("HSET", "vehicle:"+id+":latest", "ts", ts, "seq", 1, "lat", 47.6, "lon", -122.3)
		}
	}
}

func snapshotAPI(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

type snapshotBody struct {
	FleetID      string           \`json:"fleet_id"\`
	SnapshotAtMs int64            \`json:"snapshot_at_ms"\`
	Vehicles     []map[string]any \`json:"vehicles"\`
	Stale        *int             \`json:"stale"\`
	Cursor       *string          \`json:"cursor"\`
	MaxVehicles  *int             \`json:"max_vehicles"\`
	Truncated    *bool            \`json:"truncated"\`
}

func snapshotGet(ctx *harness.Ctx, c *harness.HTTP, path string) (*harness.Response, snapshotBody) {
	r := c.Get(path, "X-Tenant-Id", "t-1")
	ctx.Equal(r.Status, 200, "GET %s (%s)", path, r.Text())
	var body snapshotBody
	r.Decode(&body)
	return r, body
}

func (b snapshotBody) ids() []string {
	out := make([]string, 0, len(b.Vehicles))
	for _, v := range b.Vehicles {
		out = append(out, fmt.Sprint(v["vehicle_id"]))
	}
	return out
}

func (b snapshotBody) stale() []any {
	out := make([]any, 0, len(b.Vehicles))
	for _, v := range b.Vehicles {
		out = append(out, v["stale"])
	}
	return out
}

func CheckRoute(ctx *harness.Ctx) {
	now := ctx.Clock.Now()
	snapshotSeed(ctx, map[string]int64{"v-1": now - 1000, "v-2": now - 2000})
	c := snapshotAPI(ctx)
	r, body := snapshotGet(ctx, c, "/v1/fleets/f-1/positions")
	ctx.Assert(body.FleetID == "f-1" && body.SnapshotAtMs > 0, "the response must carry fleet_id and snapshot_at_ms: %s", r.Text())
	ctx.Equal(body.ids(), []string{"v-1", "v-2"}, "the fleet's vehicles in id order")
	v1 := body.Vehicles[0]
	ctx.Assert(v1["lat"] == 47.6 && v1["lon"] == -122.3 && v1["device_timestamp_ms"] == float64(now-1000) && v1["sequence"] == float64(1), "v-1's position is %v, expected its latest record (lat 47.6, lon -122.3, ts %d, sequence 1)", v1, now-1000)
}

func CheckTenantScope(ctx *harness.Ctx) {
	now := ctx.Clock.Now()
	snapshotSeed(ctx, map[string]int64{"v-1": now - 1000})
	c := snapshotAPI(ctx)
	r := c.Get("/v1/fleets/f-1/positions")
	ctx.Equal(r.Status, 401, "a read without X-Tenant-Id")
	r = c.Get("/v1/fleets/f-1/positions", "X-Tenant-Id", "t-2")
	ctx.Equal(r.Status, 404, "tenant t-2 reading t-1's fleet f-1 (the fleet is read from fleet:{tenant}:{fleet_id}, and t-2 has no f-1)")
	ctx.Assert(!contains(r.Text(), "v-1"), "tenant t-2's read of t-1's fleet leaked v-1: %s", r.Text())
	_, body := snapshotGet(ctx, c, "/v1/fleets/f-1/positions")
	ctx.Equal(body.ids(), []string{"v-1"}, "t-1 reading its own fleet")
}

func CheckFreshness(ctx *harness.Ctx) {
	now := ctx.Clock.Now()
	snapshotSeed(ctx, map[string]int64{"v-1": now - 1000, "v-2": now - 120_000, "v-3": -1})
	c := snapshotAPI(ctx)
	_, body := snapshotGet(ctx, c, "/v1/fleets/f-1/positions")
	ctx.Equal(body.stale(), []any{false, true, true}, "stale flags for (1 s old, 2 min old, no record): a position older than freshnessBoundMs (60 000 ms) at snapshot_at_ms, or missing, is not current")
	ctx.Assert(body.Stale != nil && *body.Stale == 2, "the response's stale count is %v, expected 2", body.Stale)
	ctx.Assert(body.SnapshotAtMs-now < 1000 && now-body.SnapshotAtMs < 1000, "snapshot_at_ms is %d, expected the server clock (%d)", body.SnapshotAtMs, now)
	ctx.Clock.Advance(120)
	_, body = snapshotGet(ctx, c, "/v1/fleets/f-1/positions")
	ctx.Equal(body.stale(), []any{true, true, true}, "two minutes later every record is older than the bound")
	ctx.Assert(body.Stale != nil && *body.Stale == 3, "the stale count two minutes later is %v, expected 3", body.Stale)
}

func CheckCap(ctx *harness.Ctx) {
	vehicles := map[string]int64{}
	for i := 0; i < 5002; i++ {
		vehicles[fmt.Sprintf("v-%04d", i)] = -1
	}
	snapshotSeed(ctx, vehicles)
	c := snapshotAPI(ctx)
	var seen []string
	cursor := ""
	pages := 0
	var body snapshotBody
	for {
		path := "/v1/fleets/f-1/positions?limit=1000"
		if cursor != "" {
			path += "&cursor=" + cursor
		}
		_, body = snapshotGet(ctx, c, path)
		seen = append(seen, body.ids()...)
		pages++
		cursor = ""
		if body.Cursor != nil {
			cursor = *body.Cursor
		}
		ctx.Assert(pages <= 7, "after %d pages the cursor is still %q: the pages must end", pages, cursor)
		if cursor == "" {
			break
		}
	}
	ctx.Equal(len(seen), 5000, "a fleet of 5 002 vehicles over %d pages must answer maxVehicles = 5 000 (the first 5 000 in id order); the vehicles answered", pages)
	ctx.Assert(sort.StringsAreSorted(seen) && seen[len(seen)-1] == "v-4999", "the pages must cover v-0000 … v-4999 in order (last was %s)", seen[len(seen)-1])
	ctx.Assert(body.Truncated != nil && *body.Truncated, "the last page says truncated %v, expected true: the caller must learn the fleet is larger than the cap", body.Truncated)
	ctx.Assert(body.MaxVehicles != nil && *body.MaxVehicles == 5000, "max_vehicles is %v, expected 5000", body.MaxVehicles)
}

func CheckPagination(ctx *harness.Ctx) {
	now := ctx.Clock.Now()
	snapshotSeed(ctx, map[string]int64{"v-1": now - 1000, "v-2": now - 1000, "v-3": now - 1000, "v-4": now - 1000, "v-5": now - 1000})
	c := snapshotAPI(ctx)
	_, first := snapshotGet(ctx, c, "/v1/fleets/f-1/positions?limit=2")
	ctx.Equal(first.ids(), []string{"v-1", "v-2"}, "the first page with limit=2")
	ctx.Assert(first.Cursor != nil && *first.Cursor != "", "with three vehicles left the first page carries cursor %v, expected the last vehicle id of the page", first.Cursor)
	_, second := snapshotGet(ctx, c, "/v1/fleets/f-1/positions?limit=2&cursor="+*first.Cursor)
	ctx.Equal(second.ids(), []string{"v-3", "v-4"}, "the second page (pages must chain without gap or overlap)")
	_, third := snapshotGet(ctx, c, "/v1/fleets/f-1/positions?limit=2&cursor="+*second.Cursor)
	ctx.Equal(third.ids(), []string{"v-5"}, "the last page")
	ctx.Assert(third.Cursor == nil, "the last page's cursor is %v, expected null", third.Cursor)
	_, all := snapshotGet(ctx, c, "/v1/fleets/f-1/positions")
	ctx.Assert(len(all.ids()) == 5 && all.Cursor == nil, "without a limit the default (500) covers all five: got %v cursor %v", all.ids(), all.Cursor)
	for _, bad := range []string{"0", "1001", "-1"} {
		r := c.Get("/v1/fleets/f-1/positions?limit="+bad, "X-Tenant-Id", "t-1")
		ctx.Equal(r.Status, 400, "limit=%s (limit is 1..1000)", bad)
	}
}

func CheckOneInstant(ctx *harness.Ctx) {
	now := ctx.Clock.Now()
	snapshotSeed(ctx, map[string]int64{"v-1": now - 1000, "v-2": now - 1000, "v-3": now - 1000})
	c := snapshotAPI(ctx)
	// A position for v-3 lands while the page is being read, right after v-1's record was fetched.
	probe := ctx.Redis.After("vehicle:v-1:latest", func() any {
		return ctx.Redis.Do("HSET", "vehicle:v-3:latest", "ts", now, "seq", 2, "lat", 9.0, "lon", 9.0)
	})
	before := len(ctx.Redis.RoundTrips())
	_, body := snapshotGet(ctx, c, "/v1/fleets/f-1/positions")
	trips := len(ctx.Redis.RoundTrips()) - before
	ctx.Assert(probe.Fired, "the read touched no vehicle:v-1:latest")
	var v3 map[string]any
	for _, v := range body.Vehicles {
		if v["vehicle_id"] == "v-3" {
			v3 = v
		}
	}
	ctx.Equal(v3["lat"], 47.6, "v-3's lat: v-1 was read before v-3's new position landed, so the snapshot mixes two instants. Read every record of the page in one MULTI/EXEC")
	ctx.Assert(trips <= 3, "the read cost %d Redis round trips for three vehicles, expected the members and one MULTI/EXEC: a 5 000-vehicle fleet must not cost 5 000 round trips", trips)
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cstdio>
#include <map>
#include <string>
#include <vector>

namespace {

const std::string kSnapshotFleet = "fleet:t-1:f-1";

// A fleet of the given vehicles: id → device timestamp of its latest record (-1: no record).
void snapshotSeed(harness::Ctx& ctx, const std::map<std::string, long long>& vehicles) {
  std::vector<std::string> args = {"SADD", kSnapshotFleet};
  for (const auto& [id, _] : vehicles) args.push_back(id);
  ctx.Redis.Must(args);
  for (const auto& [id, ts] : vehicles) {
    if (ts >= 0) ctx.Redis.Do("HSET", "vehicle:" + id + ":latest", "ts", ts, "seq", 1, "lat", 47.6, "lon", -122.3);
  }
}

struct SnapshotApi {
  httplib::Server svr;
  harness::HTTP http;
  explicit SnapshotApi(harness::Ctx& ctx) : http(ctx.HTTP(svr)) { register_routes(svr); }
};

nlohmann::json snapshotGet(harness::Ctx& ctx, SnapshotApi& api, const std::string& path) {
  const auto r = api.http.Get(path, "X-Tenant-Id", "t-1");
  ctx.Equal(r.Status, 200, "GET %s (%s)", path, r.Text());
  return nlohmann::json::parse(r.Text(), nullptr, false);
}

std::vector<std::string> ids(const nlohmann::json& body) {
  std::vector<std::string> out;
  if (body.contains("vehicles")) {
    for (const auto& v : body["vehicles"]) out.push_back(v.value("vehicle_id", ""));
  }
  return out;
}

std::vector<nlohmann::json> stale(const nlohmann::json& body) {
  std::vector<nlohmann::json> out;
  for (const auto& v : body["vehicles"]) out.push_back(v.value("stale", nlohmann::json()));
  return out;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  const long long now = ctx.Clock.Now();
  snapshotSeed(ctx, {{"v-1", now - 1000}, {"v-2", now - 2000}});
  SnapshotApi api(ctx);
  const auto body = snapshotGet(ctx, api, "/v1/fleets/f-1/positions");
  ctx.Assert(body.value("fleet_id", "") == "f-1" && body.contains("snapshot_at_ms"),
             "the response must carry fleet_id and snapshot_at_ms: %s", body.dump());
  ctx.Equal(ids(body), {"v-1", "v-2"}, "the fleet's vehicles in id order");
  const auto v1 = body["vehicles"][0];
  ctx.Assert(v1.value("lat", 0.0) == 47.6 && v1.value("lon", 0.0) == -122.3 && v1.value("device_timestamp_ms", 0LL) == now - 1000 &&
                 v1.value("sequence", 0LL) == 1,
             "v-1's position is %s, expected its latest record (lat 47.6, lon -122.3, ts %d, sequence 1)", v1.dump(), now - 1000);
}

void CheckTenantScope(harness::Ctx& ctx) {
  const long long now = ctx.Clock.Now();
  snapshotSeed(ctx, {{"v-1", now - 1000}});
  SnapshotApi api(ctx);
  auto r = api.http.Get("/v1/fleets/f-1/positions");
  ctx.Equal(r.Status, 401, "a read without X-Tenant-Id");
  r = api.http.Get("/v1/fleets/f-1/positions", "X-Tenant-Id", "t-2");
  ctx.Equal(r.Status, 404, "tenant t-2 reading t-1's fleet f-1 (the fleet is read from fleet:{tenant}:{fleet_id}, and t-2 has no f-1)");
  ctx.Assert(r.Text().find("v-1") == std::string::npos, "tenant t-2's read of t-1's fleet leaked v-1: %s", r.Text());
  ctx.Equal(ids(snapshotGet(ctx, api, "/v1/fleets/f-1/positions")), {"v-1"}, "t-1 reading its own fleet");
}

void CheckFreshness(harness::Ctx& ctx) {
  const long long now = ctx.Clock.Now();
  snapshotSeed(ctx, {{"v-1", now - 1000}, {"v-2", now - 120000}, {"v-3", -1}});
  SnapshotApi api(ctx);
  auto body = snapshotGet(ctx, api, "/v1/fleets/f-1/positions");
  ctx.Equal(stale(body), {nlohmann::json(false), nlohmann::json(true), nlohmann::json(true)},
            "stale flags for (1 s old, 2 min old, no record): a position older than kFreshnessBoundMs (60 000 ms) at "
            "snapshot_at_ms, or missing, is not current");
  ctx.Equal(body.value("stale", nlohmann::json()), nlohmann::json(2), "the response's stale count");
  const long long at = body.value("snapshot_at_ms", 0LL);
  ctx.Assert(at - now < 1000 && now - at < 1000, "snapshot_at_ms is %d, expected the server clock (%d)", at, now);
  ctx.Clock.Advance(120);
  body = snapshotGet(ctx, api, "/v1/fleets/f-1/positions");
  ctx.Equal(stale(body), {nlohmann::json(true), nlohmann::json(true), nlohmann::json(true)},
            "two minutes later every record is older than the bound");
  ctx.Equal(body.value("stale", nlohmann::json()), nlohmann::json(3), "the stale count two minutes later");
}

void CheckCap(harness::Ctx& ctx) {
  std::map<std::string, long long> vehicles;
  for (int i = 0; i < 5002; i++) {
    char id[16];
    std::snprintf(id, sizeof id, "v-%04d", i);
    vehicles[id] = -1;
  }
  snapshotSeed(ctx, vehicles);
  SnapshotApi api(ctx);
  std::vector<std::string> seen;
  std::string cursor;
  int pages = 0;
  nlohmann::json body;
  for (;;) {
    std::string path = "/v1/fleets/f-1/positions?limit=1000";
    if (!cursor.empty()) path += "&cursor=" + cursor;
    body = snapshotGet(ctx, api, path);
    const auto page = ids(body);
    seen.insert(seen.end(), page.begin(), page.end());
    pages++;
    cursor = body.contains("cursor") && body["cursor"].is_string() ? body["cursor"].get<std::string>() : "";
    ctx.Assert(pages <= 7, "after %d pages the cursor is still %q: the pages must end", pages, cursor);
    if (cursor.empty()) break;
  }
  ctx.Equal(seen.size(), 5000,
            "a fleet of 5 002 vehicles over %d pages must answer kMaxVehicles = 5 000 (the first 5 000 in id order); the "
            "vehicles answered",
            pages);
  ctx.Assert(std::is_sorted(seen.begin(), seen.end()) && seen.back() == "v-4999",
             "the pages must cover v-0000 … v-4999 in order (last was %s)", seen.back());
  ctx.Assert(body.value("truncated", false), "the last page says truncated %s, expected true: the caller must learn the fleet is larger than the cap",
             body.value("truncated", nlohmann::json()).dump());
  ctx.Equal(body.value("max_vehicles", nlohmann::json()), nlohmann::json(5000), "max_vehicles");
}

void CheckPagination(harness::Ctx& ctx) {
  const long long now = ctx.Clock.Now();
  snapshotSeed(ctx, {{"v-1", now - 1000}, {"v-2", now - 1000}, {"v-3", now - 1000}, {"v-4", now - 1000}, {"v-5", now - 1000}});
  SnapshotApi api(ctx);
  const auto first = snapshotGet(ctx, api, "/v1/fleets/f-1/positions?limit=2");
  ctx.Equal(ids(first), {"v-1", "v-2"}, "the first page with limit=2");
  ctx.Assert(first.contains("cursor") && first["cursor"].is_string() && !first["cursor"].get<std::string>().empty(),
             "with three vehicles left the first page carries cursor %s, expected the last vehicle id of the page",
             first.value("cursor", nlohmann::json()).dump());
  const auto second = snapshotGet(ctx, api, "/v1/fleets/f-1/positions?limit=2&cursor=" + first["cursor"].get<std::string>());
  ctx.Equal(ids(second), {"v-3", "v-4"}, "the second page (pages must chain without gap or overlap)");
  ctx.Assert(second.contains("cursor") && second["cursor"].is_string(), "the second page carries no cursor: %s", second.dump());
  const auto third = snapshotGet(ctx, api, "/v1/fleets/f-1/positions?limit=2&cursor=" + second["cursor"].get<std::string>());
  ctx.Equal(ids(third), {"v-5"}, "the last page");
  ctx.Assert(third.contains("cursor") && third["cursor"].is_null(), "the last page's cursor is %s, expected null",
             third.value("cursor", nlohmann::json()).dump());
  const auto all = snapshotGet(ctx, api, "/v1/fleets/f-1/positions");
  ctx.Assert(ids(all).size() == 5 && all.contains("cursor") && all["cursor"].is_null(),
             "without a limit the default (500) covers all five: got %v cursor %s", ids(all), all.value("cursor", nlohmann::json()).dump());
  for (const std::string bad : {"0", "1001", "-1"}) {
    const auto r = api.http.Get("/v1/fleets/f-1/positions?limit=" + bad, "X-Tenant-Id", "t-1");
    ctx.Equal(r.Status, 400, "limit=%s (limit is 1..1000)", bad);
  }
}

void CheckOneInstant(harness::Ctx& ctx) {
  const long long now = ctx.Clock.Now();
  snapshotSeed(ctx, {{"v-1", now - 1000}, {"v-2", now - 1000}, {"v-3", now - 1000}});
  SnapshotApi api(ctx);
  // A position for v-3 lands while the page is being read, right after v-1's record was fetched.
  bool fired = false;
  ctx.Redis.After("vehicle:v-1:latest", [&] {
    fired = true;
    ctx.Redis.Do("HSET", "vehicle:v-3:latest", "ts", now, "seq", 2, "lat", 9.0, "lon", 9.0);
  });
  const size_t before = ctx.Redis.RoundTrips().size();
  const auto body = snapshotGet(ctx, api, "/v1/fleets/f-1/positions");
  const size_t trips = ctx.Redis.RoundTrips().size() - before;
  ctx.Assert(fired, "the read touched no vehicle:v-1:latest");
  nlohmann::json v3;
  for (const auto& v : body["vehicles"]) {
    if (v.value("vehicle_id", "") == "v-3") v3 = v;
  }
  ctx.Equal(v3.value("lat", nlohmann::json()), nlohmann::json(47.6),
            "v-3's lat: v-1 was read before v-3's new position landed, so the snapshot mixes two instants. Read every "
            "record of the page in one MULTI/EXEC");
  ctx.Assert(trips <= 3,
             "the read cost %d Redis round trips for three vehicles, expected the members and one MULTI/EXEC: a 5 000-vehicle "
             "fleet must not cost 5 000 round trips",
             static_cast<int>(trips));
}
`,
  },
  debrief: `The transaction turns "the latest positions" into "the positions at \`snapshot_at_ms\`": Redis runs the queued \`HGETALL\`s with nothing in between, so a vehicle that reports during the read is before the snapshot in every record or after it in every record, and the map does not draw two instants. The staleness flag is computed against that same instant rather than against each read, which is why it belongs in the response and not in the client. Cap and cursor exist because the fleet's size is the tenant's choice, and a page that fits in one round trip keeps the read's cost proportional to what the map can draw. Production snapshot APIs serve this from a read replica, filter by map viewport instead of paging the fleet, and push deltas over a WebSocket after the first page.`,
};
