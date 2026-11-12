import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/devices/{id}/series: bounded, fleet-scoped, honest about age',
  concept: 'http',
  file: 'read',
  focus: ['dashboard', 'ingest', 'registry', 'tsdb'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/devices/{device_id}/series?metric=…&from=…&to=…\`:
it passes \`from\` (default \`0\`) and \`to\` (default now) to \`TimeSeries.Query\` for whatever device
id it is given, thins a series longer than \`MAX_POINTS\` by keeping every n-th point, and answers
\`{"device_id", "metric", "points": [{"ts", "value"}]}\`. The chart draws. It hides four flaws.

**Failure mode the checks target.** One fleet reads another fleet's series by guessing an id; one
refresh asks the store for years of data; the spike the dashboard exists to show is thinned away; and
a device that went silent an hour ago draws the same flat line as a healthy one.

- The caller's fleet is \`X-Fleet-Id\` (missing: **401**). A device the registry does not know, or one
  whose \`device["fleet"]\` is another fleet's, is **404**, before \`Query\`.
- \`metric\`, \`from\` and \`to\` are required, with \`0 < to - from <= MAX_RANGE_S = 86400\`; anything
  else is **400**, before \`Query\`.
- Past \`MAX_POINTS = 1000\` points, split the series into 500 buckets and keep each bucket's lowest
  and highest point in time order; name it: \`"downsample": {"method": "minmax", "points": n}\`
  (\`null\` when the series fits).
- Answer \`age_seconds\` (now minus the newest point's \`ts\`, \`null\` with no points) and \`stale\`
  (no points, or older than \`STALE_AFTER_S = 300\`).`,
  sequence: {
    participants: ['Dashboard', 'Telemetry Ingest', 'Device registry', 'Time-series store'],
    messages: [
      {
        from: 'Dashboard',
        to: 'Telemetry Ingest',
        label: 'GET /v1/devices/d-1/series?metric&from&to · X-Fleet-Id',
        kind: 'sync',
      },
      {from: 'Telemetry Ingest', to: 'Telemetry Ingest', label: 'no fleet → 401 · range > 24 h → 400', kind: 'sync'},
      {
        from: 'Telemetry Ingest',
        to: 'Device registry',
        label: 'lookup(d-1) · fleet must match → else 404',
        kind: 'sync',
      },
      {from: 'Telemetry Ingest', to: 'Time-series store', label: 'Query · bounded range', kind: 'sync'},
      {from: 'Time-series store', to: 'Telemetry Ingest', label: 'points', kind: 'reply'},
      {
        from: 'Telemetry Ingest',
        to: 'Dashboard',
        label: '200 {points ≤ 1000 (minmax), downsample, age_seconds, stale}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Serves a device’s series on GET /v1/devices/{id}/series',
      detail:
        'A request for a device of the caller’s fleet over the last hour answers `200` with its points in time order.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/devices\/\{device_id\}\/series["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/devices\/:deviceId\/series['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/devices\/\{id\}\/series"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"devices"\s*\/\s*Segment\s*\/\s*"series"\s*\)/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/devices\//]},
      },
    },
    {
      id: 'fleet-scope',
      title: 'Only the caller’s fleet, 401 without one, 404 for another fleet’s device',
      detail:
        'A request without `X-Fleet-Id` is **401**; a device of another fleet answers **404** exactly like an unknown one, and the store is never queried for it. The starter serves any device id to anyone.',
      match: {
        python: {all: [/x-fleet-id/i, /\[\s*["']fleet["']\s*\]/, /\b401\b/]},
        typescript: {all: [/x-fleet-id/i, /\.fleet\b/, /\b401\b/]},
        go: {all: [/X-Fleet-Id/i, /\.Fleet\b/, /StatusUnauthorized|\b401\b/]},
        scala: {all: [/X-Fleet-Id/i, /\.fleet\b/, /Unauthorized|\b401\b/]},
        cpp: {all: [/X-Fleet-Id/i, /->fleet\b|\.fleet\b/, /\b401\b/]},
      },
    },
    {
      id: 'range-cap',
      title: 'A range over 24 hours is 400 before the store is asked',
      detail:
        'A two-day range, a missing `from` and an empty range answer **400** with no `Query` call; exactly 24 hours is served. The starter fills in `from = 0` and passes any range to the store.',
      match: {
        python: {all: [/MAX_RANGE_S\s*=\s*86400/], order: [/>\s*MAX_RANGE_S/, /store\.Query\(/]},
        typescript: {all: [/MAX_RANGE_S\s*=\s*86400/], order: [/>\s*MAX_RANGE_S/, /store\.Query\(/]},
        go: {all: [/maxRangeS\s*=\s*86400/], order: [/>\s*maxRangeS/, /store\.Query\(/]},
        scala: {all: [/MaxRangeSeconds\s*=\s*86400/], order: [/>\s*MaxRangeSeconds/, /\.query\(QueryRequest\(/]},
        cpp: {all: [/kMaxRangeS\s*=\s*86400/], order: [/>\s*kMaxRangeS/, /store->Query\(/]},
      },
    },
    {
      id: 'downsample',
      title: 'Keeps each bucket’s extremes and names the method',
      detail:
        'A 5000-point series with one spike answers at most 1000 points that include the spike, in time order, with `downsample.method` `minmax`. The starter keeps every n-th point, so a spike between two of them disappears.',
      match: {
        python: {all: [/minmax/, /MAX_POINTS/], none: [/\[::\s*step\s*\]/]},
        typescript: {all: [/minmax/, /MAX_POINTS/], none: [/i\s*%\s*step\s*===\s*0/]},
        go: {all: [/minmax/, /maxPoints/], none: [/i\s*\+=\s*step/]},
        scala: {all: [/minmax/, /MaxPoints/], none: [/grouped\(step\)\.map\(_\.head\)/]},
        cpp: {all: [/minmax/, /kMaxPoints/], none: [/i\s*\+=\s*step/]},
      },
    },
    {
      id: 'staleness',
      title: 'Reports the newest point’s age and whether it is stale',
      detail:
        'A series whose newest point is 600 s old answers `age_seconds` 600 and `stale` true; one 30 s old is not stale; a series with no points has `age_seconds` null and is stale. The starter reports neither.',
      match: {
        python: {all: [/age_seconds/, /STALE_AFTER_S/]},
        typescript: {all: [/age_seconds/, /STALE_AFTER_S/]},
        go: {all: [/age_seconds/, /staleAfterS/]},
        scala: {all: [/age_seconds/, /StaleAfterSeconds/]},
        cpp: {all: [/age_seconds/, /kStaleAfterS/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import grpc
from fastapi import FastAPI, Request

import telemetry_ingest_pb2
import telemetry_ingest_pb2_grpc

app = FastAPI()
store = telemetry_ingest_pb2_grpc.TimeSeriesStub(grpc.insecure_channel("tsdb:9000"))

DEADLINE_S = 4.0
MAX_POINTS = 1000


@app.get("/v1/devices/{device_id}/series")
def series(device_id: str, request: Request) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    metric = request.query_params.get("metric", "")
    from_ts = int(request.query_params.get("from", 0))
    to_ts = int(request.query_params.get("to", int(time.time())))
    query = telemetry_ingest_pb2.QueryRequest(device_id=device_id, metric=metric, from_ts=from_ts, to_ts=to_ts)
    reply = store.Query(query, timeout=DEADLINE_S)
    points = [{"ts": p.ts, "value": p.value} for p in reply.points]
    if len(points) > MAX_POINTS:
        step = -(-len(points) // MAX_POINTS)
        points = points[::step]  # thin the series to what a chart can draw
    return {"device_id": device_id, "metric": metric, "points": points}
`,
      solution: `import time

import grpc
from fastapi import FastAPI, HTTPException, Request

import telemetry_ingest_pb2
import telemetry_ingest_pb2_grpc
from ingestd import registry  # registry.lookup

app = FastAPI()
store = telemetry_ingest_pb2_grpc.TimeSeriesStub(grpc.insecure_channel("tsdb:9000"))

DEADLINE_S = 4.0
MAX_POINTS = 1000
MAX_RANGE_S = 86400
STALE_AFTER_S = 300


def downsample(points: list[dict]) -> list[dict]:
    """At most MAX_POINTS: each of MAX_POINTS // 2 buckets keeps its lowest and its highest point, in time order."""
    if len(points) <= MAX_POINTS:
        return points
    size = -(-len(points) // (MAX_POINTS // 2))
    kept = []
    for i in range(0, len(points), size):
        bucket = points[i:i + size]
        low = min(bucket, key=lambda p: p["value"])
        high = max(bucket, key=lambda p: p["value"])
        kept.extend([low] if low is high else sorted([low, high], key=lambda p: p["ts"]))
    return kept


@app.get("/v1/devices/{device_id}/series")
def series(device_id: str, request: Request) -> dict:
    fleet = request.headers.get("x-fleet-id", "")
    if not fleet:
        raise HTTPException(status_code=401, detail="X-Fleet-Id is required")
    metric = request.query_params.get("metric", "")
    try:
        from_ts = int(request.query_params["from"])
        to_ts = int(request.query_params["to"])
    except (KeyError, ValueError):
        raise HTTPException(status_code=400, detail="from and to are required epoch seconds") from None
    # The cap is decided here, before the store sees the request.
    if not metric or to_ts <= from_ts or to_ts - from_ts > MAX_RANGE_S:
        raise HTTPException(status_code=400, detail=f"metric is required and the range must be 1 to {MAX_RANGE_S} seconds")
    device = registry.lookup(device_id)
    if device is None or device["fleet"] != fleet:
        # Another fleet's device is as unknown as a missing one: the answer must not confirm it exists.
        raise HTTPException(status_code=404, detail="unknown device")
    query = telemetry_ingest_pb2.QueryRequest(device_id=device_id, metric=metric, from_ts=from_ts, to_ts=to_ts)
    reply = store.Query(query, timeout=DEADLINE_S)
    raw = [{"ts": p.ts, "value": p.value} for p in reply.points]
    points = downsample(raw)
    newest = max((p["ts"] for p in raw), default=None)
    age = None if newest is None else int(time.time()) - newest
    return {
        "device_id": device_id,
        "metric": metric,
        "points": points,
        "downsample": {"method": "minmax", "points": len(points)} if len(points) < len(raw) else None,
        "age_seconds": age,
        "stale": age is None or age > STALE_AFTER_S,
    }
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Fastify from 'fastify';

export const app = Fastify();

export const DEADLINE_MS = 4000;
export const MAX_POINTS = 1000;

interface QueryRequest {
  device_id: string;
  metric: string;
  from_ts: number;
  to_ts: number;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('telemetry_ingest.proto')) as unknown as {
  tsdb: {TimeSeries: grpc.ServiceClientConstructor};
};
const store = new pkg.tsdb.TimeSeries('tsdb:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Query(request: QueryRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{points: {value: number; ts: number | string}[]}>;
};

app.get('/v1/devices/:deviceId/series', async request => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const {deviceId} = request.params as {deviceId: string};
  const query = request.query as {metric?: string; from?: string; to?: string};
  const metric = query.metric ?? '';
  const from = Number(query.from ?? 0);
  const to = Number(query.to ?? Math.floor(Date.now() / 1000));
  const reply = await store.Query({device_id: deviceId, metric, from_ts: from, to_ts: to}, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
  let points = reply.points.map(p => ({ts: Number(p.ts), value: p.value}));
  if (points.length > MAX_POINTS) {
    const step = Math.ceil(points.length / MAX_POINTS);
    points = points.filter((_, i) => i % step === 0); // thin the series to what a chart can draw
  }
  return {device_id: deviceId, metric, points};
});
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Fastify from 'fastify';

import {lookup} from 'ingestd/registry';

export const app = Fastify();

export const DEADLINE_MS = 4000;
export const MAX_POINTS = 1000;
export const MAX_RANGE_S = 86400;
export const STALE_AFTER_S = 300;

interface QueryRequest {
  device_id: string;
  metric: string;
  from_ts: number;
  to_ts: number;
}

interface SeriesPoint {
  ts: number;
  value: number;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('telemetry_ingest.proto')) as unknown as {
  tsdb: {TimeSeries: grpc.ServiceClientConstructor};
};
const store = new pkg.tsdb.TimeSeries('tsdb:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Query(request: QueryRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{points: {value: number; ts: number | string}[]}>;
};

/** At most MAX_POINTS: each of MAX_POINTS / 2 buckets keeps its lowest and its highest point, in time order. */
export function downsample(points: SeriesPoint[]): SeriesPoint[] {
  if (points.length <= MAX_POINTS) return points;
  const size = Math.ceil(points.length / (MAX_POINTS / 2));
  const kept: SeriesPoint[] = [];
  for (let start = 0; start < points.length; start += size) {
    const bucket = points.slice(start, start + size);
    const low = bucket.reduce((a, b) => (b.value < a.value ? b : a));
    const high = bucket.reduce((a, b) => (b.value > a.value ? b : a));
    if (low === high) kept.push(low);
    else kept.push(...(low.ts < high.ts ? [low, high] : [high, low]));
  }
  return kept;
}

app.get('/v1/devices/:deviceId/series', async (request, reply) => {
  const fleet = request.headers['x-fleet-id'];
  if (typeof fleet !== 'string' || fleet === '') return reply.code(401).send({error: 'X-Fleet-Id is required'});
  const {deviceId} = request.params as {deviceId: string};
  const query = request.query as {metric?: string; from?: string; to?: string};
  const metric = query.metric ?? '';
  const from = Number(query.from);
  const to = Number(query.to);
  // The cap is decided here, before the store sees the request.
  if (metric === '' || !Number.isInteger(from) || !Number.isInteger(to) || to <= from || to - from > MAX_RANGE_S) {
    return reply.code(400).send({error: \`metric, from and to are required and the range must be 1 to \${MAX_RANGE_S} seconds\`});
  }
  const device = await lookup(deviceId);
  // Another fleet's device is as unknown as a missing one: the answer must not confirm it exists.
  if (device === null || device.fleet !== fleet) return reply.code(404).send({error: 'unknown device'});
  const found = await store.Query({device_id: deviceId, metric, from_ts: from, to_ts: to}, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
  const raw = found.points.map(p => ({ts: Number(p.ts), value: p.value}));
  const points = downsample(raw);
  const newest = raw.length === 0 ? null : Math.max(...raw.map(p => p.ts));
  const age = newest === null ? null : Math.floor(Date.now() / 1000) - newest;
  return {
    device_id: deviceId,
    metric,
    points,
    downsample: points.length < raw.length ? {method: 'minmax', points: points.length} : null,
    age_seconds: age,
    stale: age === null || age > STALE_AFTER_S,
  };
});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "tsdb/gen/telemetry_ingest"
)

const (
	deadline  = 4 * time.Second
	maxPoints = 1000
)

var (
	storeConn, _ = grpc.NewClient("tsdb:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	store        = pb.NewTimeSeriesClient(storeConn)
)

type seriesPoint struct {
	TS    int64   \`json:"ts"\`
	Value float64 \`json:"value"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func series(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	q := r.URL.Query()
	metric := q.Get("metric")
	from, _ := strconv.ParseInt(q.Get("from"), 10, 64) // missing: 0
	to, err := strconv.ParseInt(q.Get("to"), 10, 64)
	if err != nil {
		to = time.Now().Unix()
	}
	callCtx, cancel := context.WithTimeout(r.Context(), deadline)
	defer cancel()
	reply, err := store.Query(callCtx, &pb.QueryRequest{DeviceId: r.PathValue("id"), Metric: metric, FromTs: from, ToTs: to})
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
		return
	}
	points := []seriesPoint{}
	for _, p := range reply.GetPoints() {
		points = append(points, seriesPoint{TS: p.GetTs(), Value: p.GetValue()})
	}
	if len(points) > maxPoints {
		step := (len(points) + maxPoints - 1) / maxPoints
		thinned := []seriesPoint{}
		for i := 0; i < len(points); i += step {
			thinned = append(thinned, points[i]) // thin the series to what a chart can draw
		}
		points = thinned
	}
	writeJSON(rw, http.StatusOK, map[string]any{"device_id": r.PathValue("id"), "metric": metric, "points": points})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/devices/{id}/series", series)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"ingestd/registry" // registry.Lookup(ctx, id)
	pb "tsdb/gen/telemetry_ingest"
)

const (
	deadline    = 4 * time.Second
	maxPoints   = 1000
	maxRangeS   = 86400
	staleAfterS = 300
)

var (
	storeConn, _ = grpc.NewClient("tsdb:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	store        = pb.NewTimeSeriesClient(storeConn)
)

type seriesPoint struct {
	TS    int64   \`json:"ts"\`
	Value float64 \`json:"value"\`
}

type downsampled struct {
	Method string \`json:"method"\`
	Points int    \`json:"points"\`
}

type seriesBody struct {
	DeviceID   string        \`json:"device_id"\`
	Metric     string        \`json:"metric"\`
	Points     []seriesPoint \`json:"points"\`
	Downsample *downsampled  \`json:"downsample"\`
	AgeSeconds *int64        \`json:"age_seconds"\`
	Stale      bool          \`json:"stale"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

// downsample keeps at most maxPoints: each of maxPoints/2 buckets keeps its lowest and its highest point, in time order.
func downsample(points []seriesPoint) []seriesPoint {
	if len(points) <= maxPoints {
		return points
	}
	size := (len(points) + maxPoints/2 - 1) / (maxPoints / 2)
	kept := []seriesPoint{}
	for start := 0; start < len(points); start += size {
		end := start + size
		if end > len(points) {
			end = len(points)
		}
		low, high := start, start
		for i := start; i < end; i++ {
			if points[i].Value < points[low].Value {
				low = i
			}
			if points[i].Value > points[high].Value {
				high = i
			}
		}
		switch {
		case low == high:
			kept = append(kept, points[low])
		case low < high:
			kept = append(kept, points[low], points[high])
		default:
			kept = append(kept, points[high], points[low])
		}
	}
	return kept
}

func series(rw http.ResponseWriter, r *http.Request) {
	fleet := r.Header.Get("X-Fleet-Id")
	if fleet == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Fleet-Id is required"})
		return
	}
	q := r.URL.Query()
	metric := q.Get("metric")
	from, errFrom := strconv.ParseInt(q.Get("from"), 10, 64)
	to, errTo := strconv.ParseInt(q.Get("to"), 10, 64)
	// The cap is decided here, before the store sees the request.
	if metric == "" || errFrom != nil || errTo != nil || to <= from || to-from > maxRangeS {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "metric, from and to are required and the range must be 1 to 86400 seconds"})
		return
	}
	device, err := registry.Lookup(r.Context(), r.PathValue("id"))
	if err != nil {
		writeJSON(rw, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if device == nil || device.Fleet != fleet {
		// Another fleet's device is as unknown as a missing one: the answer must not confirm it exists.
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown device"})
		return
	}
	callCtx, cancel := context.WithTimeout(r.Context(), deadline)
	defer cancel()
	reply, err := store.Query(callCtx, &pb.QueryRequest{DeviceId: device.ID, Metric: metric, FromTs: from, ToTs: to})
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
		return
	}
	raw := []seriesPoint{}
	for _, p := range reply.GetPoints() {
		raw = append(raw, seriesPoint{TS: p.GetTs(), Value: p.GetValue()})
	}
	body := seriesBody{DeviceID: device.ID, Metric: metric, Points: downsample(raw), Stale: true}
	if len(body.Points) < len(raw) {
		body.Downsample = &downsampled{Method: "minmax", Points: len(body.Points)}
	}
	if len(raw) > 0 {
		newest := raw[0].TS
		for _, p := range raw {
			if p.TS > newest {
				newest = p.TS
			}
		}
		age := time.Now().Unix() - newest
		body.AgeSeconds = &age
		body.Stale = age > staleAfterS
	}
	writeJSON(rw, http.StatusOK, body)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/devices/{id}/series", series)
}
`,
    },
    scala: {
      starter: `import java.util.concurrent.TimeUnit

import io.grpc.ManagedChannelBuilder
import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import tsdb.telemetry_ingest.{QueryRequest, TimeSeriesGrpc}

object SeriesRead {
  val DeadlineSeconds = 4L
  val MaxPoints = 1000

  private val store = TimeSeriesGrpc.blockingStub(ManagedChannelBuilder.forAddress("tsdb", 9000).usePlaintext().build())

  val route: Route = path("v1" / "devices" / Segment / "series") { deviceId =>
    get {
      parameters("metric".optional, "from".optional, "to".optional) { (metric, from, to) =>
        // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
        val request = QueryRequest(deviceId = deviceId, metric = metric.getOrElse(""), fromTs = from.map(_.toLong).getOrElse(0L),
          toTs = to.map(_.toLong).getOrElse(System.currentTimeMillis() / 1000))
        val raw = store.withDeadlineAfter(DeadlineSeconds, TimeUnit.SECONDS).query(request).points
        val step = math.max(1, math.ceil(raw.size.toDouble / MaxPoints).toInt)
        val points = if (raw.size > MaxPoints) raw.grouped(step).map(_.head).toSeq else raw // thin the series to what a chart can draw
        val body = JsObject(
          "device_id" -> JsString(deviceId),
          "metric" -> JsString(metric.getOrElse("")),
          "points" -> JsArray(points.map(p => JsObject("ts" -> JsNumber(p.ts), "value" -> JsNumber(p.value))).toVector))
        complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint)))
      }
    }
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import scala.util.Try

import io.grpc.ManagedChannelBuilder
import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import ingestd.Registry // Registry.lookup
import tsdb.telemetry_ingest.{Point, QueryRequest, TimeSeriesGrpc}

object SeriesRead {
  val DeadlineSeconds = 4L
  val MaxPoints = 1000
  val MaxRangeSeconds = 86400L
  val StaleAfterSeconds = 300L

  private val store = TimeSeriesGrpc.blockingStub(ManagedChannelBuilder.forAddress("tsdb", 9000).usePlaintext().build())

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def fail(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  /** At most MaxPoints: each of MaxPoints / 2 buckets keeps its lowest and its highest point, in time order. */
  def downsample(points: Seq[Point]): Seq[Point] =
    if (points.size <= MaxPoints) points
    else {
      val size = math.ceil(points.size.toDouble / (MaxPoints / 2)).toInt
      points.grouped(size).toSeq.flatMap { bucket =>
        val low = bucket.minBy(_.value)
        val high = bucket.maxBy(_.value)
        if (low eq high) Seq(low) else Seq(low, high).sortBy(_.ts)
      }
    }

  val route: Route = path("v1" / "devices" / Segment / "series") { deviceId =>
    get {
      optionalHeaderValueByName("X-Fleet-Id") { fleetHeader =>
        parameters("metric".optional, "from".optional, "to".optional) { (metric, from, to) =>
          val fleet = fleetHeader.getOrElse("")
          val range = for (f <- from.flatMap(s => Try(s.toLong).toOption); t <- to.flatMap(s => Try(s.toLong).toOption)) yield (f, t)
          if (fleet.isEmpty) complete(fail(StatusCodes.Unauthorized, "X-Fleet-Id is required"))
          // The cap is decided here, before the store sees the request.
          else if (metric.forall(_.isEmpty) || range.forall { case (f, t) => t <= f || t - f > MaxRangeSeconds })
            complete(fail(StatusCodes.BadRequest, s"metric, from and to are required and the range must be 1 to $MaxRangeSeconds seconds"))
          else
            Registry.lookup(deviceId).filter(_.fleet == fleet) match {
              // Another fleet's device is as unknown as a missing one: the answer must not confirm it exists.
              case None => complete(fail(StatusCodes.NotFound, "unknown device"))
              case Some(device) =>
                val (fromTs, toTs) = range.get
                val raw = store.withDeadlineAfter(DeadlineSeconds, TimeUnit.SECONDS)
                  .query(QueryRequest(deviceId = device.id, metric = metric.get, fromTs = fromTs, toTs = toTs)).points
                val points = downsample(raw)
                val age = if (raw.isEmpty) None else Some(System.currentTimeMillis() / 1000 - raw.map(_.ts).max)
                complete(json(StatusCodes.OK, JsObject(
                  "device_id" -> JsString(device.id),
                  "metric" -> JsString(metric.get),
                  "points" -> JsArray(points.map(p => JsObject("ts" -> JsNumber(p.ts), "value" -> JsNumber(p.value))).toVector),
                  "downsample" -> (if (points.size < raw.size) JsObject("method" -> JsString("minmax"), "points" -> JsNumber(points.size)) else JsNull),
                  "age_seconds" -> age.map(JsNumber(_)).getOrElse(JsNull),
                  "stale" -> JsBoolean(age.forall(_ > StaleAfterSeconds)))))
            }
        }
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>
#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <string>

#include "telemetry_ingest.grpc.pb.h"

using json = nlohmann::json;

constexpr std::chrono::seconds kDeadline{4};
constexpr size_t kMaxPoints = 1000;

auto store = tsdb::TimeSeries::NewStub(grpc::CreateChannel("tsdb:9000", grpc::InsecureChannelCredentials()));

void series(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string device_id = req.matches[1];
  const std::string metric = req.get_param_value("metric");
  const long long now = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  tsdb::QueryRequest query;
  query.set_device_id(device_id);
  query.set_metric(metric);
  query.set_from_ts(req.has_param("from") ? std::stoll(req.get_param_value("from")) : 0);
  query.set_to_ts(req.has_param("to") ? std::stoll(req.get_param_value("to")) : now);
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
  tsdb::QueryReply reply;
  if (!store->Query(&ctx, query, &reply).ok()) {
    res.status = 503;
    return;
  }
  const size_t step = (reply.points_size() + kMaxPoints - 1) / kMaxPoints;
  json points = json::array();
  for (size_t i = 0; i < static_cast<size_t>(reply.points_size()); i += step) {  // thin the series to what a chart can draw
    points.push_back({{"ts", reply.points(i).ts()}, {"value", reply.points(i).value()}});
  }
  res.set_content(json{{"device_id", device_id}, {"metric", metric}, {"points", points}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/devices/([\\w-]+)/series)", series); }
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <string>
#include <vector>

#include "ingestd/registry.h"  // registry::lookup(id)
#include "telemetry_ingest.grpc.pb.h"

using json = nlohmann::json;

constexpr std::chrono::seconds kDeadline{4};
constexpr size_t kMaxPoints = 1000;
constexpr long long kMaxRangeS = 86400;
constexpr long long kStaleAfterS = 300;

auto store = tsdb::TimeSeries::NewStub(grpc::CreateChannel("tsdb:9000", grpc::InsecureChannelCredentials()));

struct SeriesPoint {
  long long ts = 0;
  double value = 0;
};

// At most kMaxPoints: each of kMaxPoints / 2 buckets keeps its lowest and its highest point, in time order.
std::vector<SeriesPoint> downsample(const std::vector<SeriesPoint>& points) {
  if (points.size() <= kMaxPoints) return points;
  const size_t size = (points.size() + kMaxPoints / 2 - 1) / (kMaxPoints / 2);
  std::vector<SeriesPoint> kept;
  for (size_t start = 0; start < points.size(); start += size) {
    const size_t stop = std::min(start + size, points.size());
    size_t low = start;
    size_t high = start;
    for (size_t i = start; i < stop; i++) {
      if (points[i].value < points[low].value) low = i;
      if (points[i].value > points[high].value) high = i;
    }
    kept.push_back(points[std::min(low, high)]);
    if (low != high) kept.push_back(points[std::max(low, high)]);
  }
  return kept;
}

void answer(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void series(const httplib::Request& req, httplib::Response& res) {
  const std::string fleet = req.get_header_value("X-Fleet-Id");
  if (fleet.empty()) return answer(res, 401, {{"error", "X-Fleet-Id is required"}});
  const std::string device_id = req.matches[1];
  const std::string metric = req.get_param_value("metric");
  long long from = 0;
  long long to = 0;
  try {
    from = std::stoll(req.get_param_value("from"));
    to = std::stoll(req.get_param_value("to"));
  } catch (const std::exception&) {
    return answer(res, 400, {{"error", "from and to are required epoch seconds"}});
  }
  // The cap is decided here, before the store sees the request.
  if (metric.empty() || to <= from || to - from > kMaxRangeS) return answer(res, 400, {{"error", "the range must be 1 to 86400 seconds"}});
  const auto device = registry::lookup(device_id);
  // Another fleet's device is as unknown as a missing one: the answer must not confirm it exists.
  if (!device || device->fleet != fleet) return answer(res, 404, {{"error", "unknown device"}});
  tsdb::QueryRequest query;
  query.set_device_id(device_id);
  query.set_metric(metric);
  query.set_from_ts(from);
  query.set_to_ts(to);
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
  tsdb::QueryReply reply;
  if (!store->Query(&ctx, query, &reply).ok()) return answer(res, 503, {{"error", "the time-series store did not answer"}});
  std::vector<SeriesPoint> raw;
  for (const auto& p : reply.points()) raw.push_back({p.ts(), p.value()});
  const std::vector<SeriesPoint> points = downsample(raw);
  json body = {{"device_id", device_id}, {"metric", metric}, {"points", json::array()}, {"downsample", nullptr}, {"age_seconds", nullptr}, {"stale", true}};
  for (const SeriesPoint& p : points) body["points"].push_back({{"ts", p.ts}, {"value", p.value}});
  if (points.size() < raw.size()) body["downsample"] = {{"method", "minmax"}, {"points", points.size()}};
  if (!raw.empty()) {
    long long newest = raw.front().ts;
    for (const SeriesPoint& p : raw) newest = std::max(newest, p.ts);
    const long long now = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
    body["age_seconds"] = now - newest;
    body["stale"] = now - newest > kStaleAfterS;
  }
  answer(res, 200, body);
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/devices/([\\w-]+)/series)", series); }
`,
    },
  },
  harness: {
    python: `import telemetry_ingest_pb2
import telemetry_ingest_pb2_grpc
from ingestd import registry

RANGES = {"temp_c": [-40, 85]}


class Store(telemetry_ingest_pb2_grpc.TimeSeriesServicer):
    """series maps (device, metric) to its (ts, value) points, oldest first."""

    def __init__(self):
        self.series = {}

    def Query(self, request, context):
        points = [
            telemetry_ingest_pb2.Point(metric=request.metric, value=value, ts=ts)
            for ts, value in self.series.get((request.device_id, request.metric), [])
            if request.from_ts <= ts <= request.to_ts
        ]
        return telemetry_ingest_pb2.QueryReply(points=points)


def _api(ctx):
    store = Store()
    ctx.grpc.serve(telemetry_ingest_pb2_grpc.add_TimeSeriesServicer_to_server, store)
    registry.register_device("d-1", "f-1", RANGES)
    registry.register_device("d-2", "f-1", RANGES)
    registry.register_device("d-9", "f-2", RANGES)
    return ctx.client(ctx.load("read").app), store


def _now(ctx):
    return int(ctx.clock.time())


async def _get(c, device, frm, to, fleet="f-1"):
    params = {"metric": "temp_c"}
    if frm is not None:
        params["from"] = frm
    if to is not None:
        params["to"] = to
    return await c.get(f"/v1/devices/{device}/series", params=params, headers={"X-Fleet-Id": fleet} if fleet else {})


def _queried(ctx, device):
    return [call for call in ctx.grpc.calls_to("Query") if call.request.device_id == device]


async def check_route(ctx):
    now = _now(ctx)
    client, store = _api(ctx)
    store.series[("d-1", "temp_c")] = [(now - 300, 20.0), (now - 200, 21.0), (now - 100, 22.0)]
    async with client as c:
        r = await _get(c, "d-1", now - 3600, now)
    assert r.status_code == 200, f"GET /v1/devices/d-1/series answered {r.status_code}: {r.text}"
    points = r.json().get("points")
    assert points == [{"ts": now - 300, "value": 20.0}, {"ts": now - 200, "value": 21.0}, {"ts": now - 100, "value": 22.0}], f"the series must be d-1's three points in time order, got {points}"


async def check_fleet_scope(ctx):
    now = _now(ctx)
    client, store = _api(ctx)
    store.series[("d-9", "temp_c")] = [(now - 60, 30.0)]
    async with client as c:
        anonymous = await _get(c, "d-1", now - 3600, now, fleet=None)
        foreign = await _get(c, "d-9", now - 3600, now, fleet="f-1")
        unknown = await _get(c, "d-404", now - 3600, now, fleet="f-1")
    assert anonymous.status_code == 401, f"a request without X-Fleet-Id answered {anonymous.status_code}, expected 401"
    assert foreign.status_code == 404, f"fleet f-1 asking for d-9, a device of fleet f-2, answered {foreign.status_code}: {foreign.text}. Another fleet's device must look exactly like an unknown one (404)"
    assert unknown.status_code == 404, f"an unknown device answered {unknown.status_code}, expected 404"
    assert not _queried(ctx, "d-9"), "the store was queried for another fleet's device: decide the fleet before Query"


async def check_range_cap(ctx):
    now = _now(ctx)
    client, store = _api(ctx)
    store.series[("d-1", "temp_c")] = [(now - 100, 20.0)]
    async with client as c:
        long = await _get(c, "d-1", now - 2 * 86400, now)
        open_ended = await _get(c, "d-1", None, now)
        empty = await _get(c, "d-1", now, now)
        before = len(ctx.grpc.calls_to("Query"))
        day = await _get(c, "d-1", now - 86400, now)
    assert long.status_code == 400, f"a two-day range answered {long.status_code}, expected 400: the cap is 24 hours"
    assert open_ended.status_code == 400, f"a request without from answered {open_ended.status_code}, expected 400: a missing bound is not 'since 1970'"
    assert empty.status_code == 400, f"a range with to == from answered {empty.status_code}, expected 400"
    assert before == 0, f"the store was queried {before} times for ranges that must be refused: the cap is decided before Query"
    assert day.status_code == 200, f"exactly 24 hours answered {day.status_code}: {day.text}"


async def check_downsample(ctx):
    now = _now(ctx)
    client, store = _api(ctx)
    points = [(now - 5000 + i, 20.0 + (i % 7) * 0.1) for i in range(5000)]
    spike_ts = points[2503][0]
    points[2503] = (spike_ts, 80.0)
    store.series[("d-1", "temp_c")] = points
    async with client as c:
        r = await _get(c, "d-1", now - 6000, now)
    assert r.status_code == 200, f"the series read answered {r.status_code}: {r.text}"
    body = r.json()
    got = body.get("points") or []
    assert 0 < len(got) <= 1000, f"a 5000-point series answered {len(got)} points, expected at most MAX_POINTS = 1000"
    assert {"ts": spike_ts, "value": 80.0} in got, "the spike to 80.0 is missing from the downsampled series: keep each bucket's lowest and highest point, not every n-th one"
    assert [p["ts"] for p in got] == sorted(p["ts"] for p in got), "the downsampled points must stay in time order"
    assert (body.get("downsample") or {}).get("method") == "minmax", f"the response must name the method, downsample.method = minmax; got {body.get('downsample')}"


async def check_staleness(ctx):
    now = _now(ctx)
    client, store = _api(ctx)
    store.series[("d-1", "temp_c")] = [(now - 900, 20.0), (now - 600, 21.0)]
    store.series[("d-2", "temp_c")] = [(now - 30, 22.0)]
    async with client as c:
        silent = (await _get(c, "d-1", now - 3600, now)).json()
        live = (await _get(c, "d-2", now - 3600, now)).json()
        empty = (await _get(c, "d-2", now - 7200, now - 3600)).json()
    assert silent.get("age_seconds") == 600 and silent.get("stale") is True, f"d-1's newest point is 600 s old: expected age_seconds 600 and stale true, got age_seconds={silent.get('age_seconds')} stale={silent.get('stale')}"
    assert live.get("age_seconds") == 30 and live.get("stale") is False, f"d-2's newest point is 30 s old: expected age_seconds 30 and stale false, got age_seconds={live.get('age_seconds')} stale={live.get('stale')}"
    assert "age_seconds" in empty and empty.get("age_seconds") is None and empty.get("stale") is True, f"a range with no points must answer age_seconds null and stale true, got {empty}"
`,
    typescript: `const RANGES = {temp_c: [-40, 85]};

/** The store: series maps "device/metric" to its [ts, value] points, oldest first. */
async function api(ctx) {
  const pkg = ctx.proto('telemetry_ingest.proto');
  const series = new Map<string, [number, number][]>();
  ctx.grpc.serve(pkg.tsdb.TimeSeries.service, {
    Query(call, callback) {
      const {device_id, metric, from_ts, to_ts} = call.request;
      const points = (series.get(\`\${device_id}/\${metric}\`) ?? [])
        .filter(([ts]) => ts >= Number(from_ts) && ts <= Number(to_ts))
        .map(([ts, value]) => ({metric, value, ts}));
      callback(null, {points});
    },
  });
  const registry = ctx.load('/support/ingestd/registry.ts');
  await registry.registerDevice('d-1', 'f-1', RANGES);
  await registry.registerDevice('d-2', 'f-1', RANGES);
  await registry.registerDevice('d-9', 'f-2', RANGES);
  return {c: ctx.client(ctx.load('read').app), series};
}

const nowS = ctx => Math.floor(ctx.clock.now() / 1000);

function get(c, device: string, from: number | null, to: number | null, fleet: string | null = 'f-1') {
  const params = ['metric=temp_c'];
  if (from !== null) params.push(\`from=\${from}\`);
  if (to !== null) params.push(\`to=\${to}\`);
  return c.get(\`/v1/devices/\${device}/series?\${params.join('&')}\`, {headers: fleet === null ? {} : {'X-Fleet-Id': fleet}});
}

const queried = (ctx, device: string) => ctx.grpc.callsTo('Query').filter(call => call.request.device_id === device);

export async function check_route(ctx) {
  const now = nowS(ctx);
  const {c, series} = await api(ctx);
  series.set('d-1/temp_c', [[now - 300, 20], [now - 200, 21], [now - 100, 22]]);
  const r = await get(c, 'd-1', now - 3600, now);
  assert.equal(r.status, 200, \`GET /v1/devices/d-1/series answered \${r.status}: \${r.text}\`);
  const points = r.json().points;
  assert.deepEqual(points, [{ts: now - 300, value: 20}, {ts: now - 200, value: 21}, {ts: now - 100, value: 22}], \`the series must be d-1's three points in time order, got \${JSON.stringify(points)}\`);
}

export async function check_fleet_scope(ctx) {
  const now = nowS(ctx);
  const {c, series} = await api(ctx);
  series.set('d-9/temp_c', [[now - 60, 30]]);
  const anonymous = await get(c, 'd-1', now - 3600, now, null);
  const foreign = await get(c, 'd-9', now - 3600, now, 'f-1');
  const unknown = await get(c, 'd-404', now - 3600, now, 'f-1');
  assert.equal(anonymous.status, 401, \`a request without X-Fleet-Id answered \${anonymous.status}, expected 401\`);
  assert.equal(foreign.status, 404, \`fleet f-1 asking for d-9, a device of fleet f-2, answered \${foreign.status}: \${foreign.text}. Another fleet's device must look exactly like an unknown one (404)\`);
  assert.equal(unknown.status, 404, \`an unknown device answered \${unknown.status}, expected 404\`);
  assert.equal(queried(ctx, 'd-9').length, 0, "the store was queried for another fleet's device: decide the fleet before Query");
}

export async function check_range_cap(ctx) {
  const now = nowS(ctx);
  const {c, series} = await api(ctx);
  series.set('d-1/temp_c', [[now - 100, 20]]);
  const long = await get(c, 'd-1', now - 2 * 86400, now);
  const openEnded = await get(c, 'd-1', null, now);
  const empty = await get(c, 'd-1', now, now);
  const before = ctx.grpc.callsTo('Query').length;
  const day = await get(c, 'd-1', now - 86400, now);
  assert.equal(long.status, 400, \`a two-day range answered \${long.status}, expected 400: the cap is 24 hours\`);
  assert.equal(openEnded.status, 400, \`a request without from answered \${openEnded.status}, expected 400: a missing bound is not 'since 1970'\`);
  assert.equal(empty.status, 400, \`a range with to == from answered \${empty.status}, expected 400\`);
  assert.equal(before, 0, \`the store was queried \${before} times for ranges that must be refused: the cap is decided before Query\`);
  assert.equal(day.status, 200, \`exactly 24 hours answered \${day.status}: \${day.text}\`);
}

export async function check_downsample(ctx) {
  const now = nowS(ctx);
  const {c, series} = await api(ctx);
  const points: [number, number][] = Array.from({length: 5000}, (_, i) => [now - 5000 + i, 20 + (i % 7) * 0.1]);
  const spikeTs = points[2503][0];
  points[2503] = [spikeTs, 80];
  series.set('d-1/temp_c', points);
  const r = await get(c, 'd-1', now - 6000, now);
  assert.equal(r.status, 200, \`the series read answered \${r.status}: \${r.text}\`);
  const body = r.json();
  const got = body.points ?? [];
  assert(got.length > 0 && got.length <= 1000, \`a 5000-point series answered \${got.length} points, expected at most MAX_POINTS = 1000\`);
  assert(got.some(p => p.ts === spikeTs && p.value === 80), "the spike to 80 is missing from the downsampled series: keep each bucket's lowest and highest point, not every n-th one");
  assert(got.every((p, i) => i === 0 || got[i - 1].ts <= p.ts), 'the downsampled points must stay in time order');
  assert.equal(body.downsample?.method, 'minmax', \`the response must name the method, downsample.method = minmax; got \${JSON.stringify(body.downsample)}\`);
}

export async function check_staleness(ctx) {
  const now = nowS(ctx);
  const {c, series} = await api(ctx);
  series.set('d-1/temp_c', [[now - 900, 20], [now - 600, 21]]);
  series.set('d-2/temp_c', [[now - 30, 22]]);
  const silent = (await get(c, 'd-1', now - 3600, now)).json();
  const live = (await get(c, 'd-2', now - 3600, now)).json();
  const empty = (await get(c, 'd-2', now - 7200, now - 3600)).json();
  assert(silent.age_seconds === 600 && silent.stale === true, \`d-1's newest point is 600 s old: expected age_seconds 600 and stale true, got age_seconds=\${silent.age_seconds} stale=\${silent.stale}\`);
  assert(live.age_seconds === 30 && live.stale === false, \`d-2's newest point is 30 s old: expected age_seconds 30 and stale false, got age_seconds=\${live.age_seconds} stale=\${live.stale}\`);
  assert('age_seconds' in empty && empty.age_seconds === null && empty.stale === true, \`a range with no points must answer age_seconds null and stale true, got \${JSON.stringify(empty)}\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"net/http"
	"sort"

	"ingestd/registry"
	pb "tsdb/gen/telemetry_ingest"

	"leetbuild/harness"
)

// readPeer serves series: "device/metric" → its points, oldest first.
type readPeer struct {
	pb.UnimplementedTimeSeriesServer
	series map[string][]*pb.Point
}

func (p *readPeer) Query(_ context.Context, req *pb.QueryRequest) (*pb.QueryReply, error) {
	reply := &pb.QueryReply{}
	for _, point := range p.series[req.GetDeviceId()+"/"+req.GetMetric()] {
		if point.GetTs() >= req.GetFromTs() && point.GetTs() <= req.GetToTs() {
			reply.Points = append(reply.Points, point)
		}
	}
	return reply, nil
}

type readBody struct {
	Points     []seriesPoint  \`json:"points"\`
	Downsample map[string]any \`json:"downsample"\`
	AgeSeconds *int64         \`json:"age_seconds"\`
	Stale      *bool          \`json:"stale"\`
}

func readAPI(ctx *harness.Ctx) (*harness.HTTP, *readPeer) {
	peer := &readPeer{series: map[string][]*pb.Point{}}
	pb.RegisterTimeSeriesServer(ctx.GRPC.Server(""), peer)
	ranges := map[string][2]float64{"temp_c": {-40, 85}}
	for device, fleet := range map[string]string{"d-1": "f-1", "d-2": "f-1", "d-9": "f-2"} {
		_, err := registry.RegisterDevice(context.Background(), device, fleet, ranges)
		ctx.NoError(err, "registering %s", device)
	}
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux), peer
}

func seriesOf(points ...[2]float64) []*pb.Point {
	out := []*pb.Point{}
	for _, p := range points {
		out = append(out, &pb.Point{Metric: "temp_c", Ts: int64(p[0]), Value: p[1]})
	}
	return out
}

func readGet(c *harness.HTTP, device string, from, to *int64, fleet string) *harness.Response {
	path := "/v1/devices/" + device + "/series?metric=temp_c"
	if from != nil {
		path += fmt.Sprintf("&from=%d", *from)
	}
	if to != nil {
		path += fmt.Sprintf("&to=%d", *to)
	}
	if fleet == "" {
		return c.Get(path)
	}
	return c.Get(path, "X-Fleet-Id", fleet)
}

func ptr(v int64) *int64 { return &v }

func decodeRead(ctx *harness.Ctx, r *harness.Response) readBody {
	var body readBody
	r.Decode(&body)
	return body
}

func nowSeconds(ctx *harness.Ctx) int64 { return ctx.Clock.Now() / 1000 }

func CheckRoute(ctx *harness.Ctx) {
	now := nowSeconds(ctx)
	c, peer := readAPI(ctx)
	peer.series["d-1/temp_c"] = seriesOf([2]float64{float64(now - 300), 20}, [2]float64{float64(now - 200), 21}, [2]float64{float64(now - 100), 22})
	r := readGet(c, "d-1", ptr(now-3600), ptr(now), "f-1")
	ctx.Equal(r.Status, 200, "GET /v1/devices/d-1/series (%s)", r.Text())
	ctx.Equal(decodeRead(ctx, r).Points, []seriesPoint{{TS: now - 300, Value: 20}, {TS: now - 200, Value: 21}, {TS: now - 100, Value: 22}}, "the series must be d-1's three points in time order")
}

func CheckFleetScope(ctx *harness.Ctx) {
	now := nowSeconds(ctx)
	c, peer := readAPI(ctx)
	peer.series["d-9/temp_c"] = seriesOf([2]float64{float64(now - 60), 30})
	anonymous := readGet(c, "d-1", ptr(now-3600), ptr(now), "")
	foreign := readGet(c, "d-9", ptr(now-3600), ptr(now), "f-1")
	unknown := readGet(c, "d-404", ptr(now-3600), ptr(now), "f-1")
	ctx.Equal(anonymous.Status, 401, "a request without X-Fleet-Id")
	ctx.Equal(foreign.Status, 404, "fleet f-1 asking for d-9, a device of fleet f-2, must look exactly like an unknown device (%s)", foreign.Text())
	ctx.Equal(unknown.Status, 404, "an unknown device")
	for _, call := range ctx.GRPC.CallsTo("Query", "") {
		ctx.Assert(call.Request.(*pb.QueryRequest).GetDeviceId() != "d-9", "the store was queried for another fleet's device: decide the fleet before Query")
	}
}

func CheckRangeCap(ctx *harness.Ctx) {
	now := nowSeconds(ctx)
	c, peer := readAPI(ctx)
	peer.series["d-1/temp_c"] = seriesOf([2]float64{float64(now - 100), 20})
	long := readGet(c, "d-1", ptr(now-2*86400), ptr(now), "f-1")
	openEnded := readGet(c, "d-1", nil, ptr(now), "f-1")
	empty := readGet(c, "d-1", ptr(now), ptr(now), "f-1")
	before := len(ctx.GRPC.CallsTo("Query", ""))
	day := readGet(c, "d-1", ptr(now-86400), ptr(now), "f-1")
	ctx.Equal(long.Status, 400, "a two-day range (the cap is 24 hours)")
	ctx.Equal(openEnded.Status, 400, "a request without from (a missing bound is not 'since 1970')")
	ctx.Equal(empty.Status, 400, "a range with to == from")
	ctx.Equal(before, 0, "ranges that must be refused never reach the store: the cap is decided before Query; Query calls")
	ctx.Equal(day.Status, 200, "exactly 24 hours (%s)", day.Text())
}

func CheckDownsample(ctx *harness.Ctx) {
	now := nowSeconds(ctx)
	c, peer := readAPI(ctx)
	var raw [][2]float64
	for i := 0; i < 5000; i++ {
		raw = append(raw, [2]float64{float64(now - 5000 + int64(i)), 20 + float64(i%7)*0.1})
	}
	spikeTS := int64(raw[2503][0])
	raw[2503][1] = 80
	peer.series["d-1/temp_c"] = seriesOf(raw...)
	r := readGet(c, "d-1", ptr(now-6000), ptr(now), "f-1")
	ctx.Equal(r.Status, 200, "the series read (%s)", r.Text())
	body := decodeRead(ctx, r)
	ctx.Assert(len(body.Points) > 0 && len(body.Points) <= 1000, "a 5000-point series answered %d points, expected at most maxPoints = 1000", len(body.Points))
	spike := false
	for _, p := range body.Points {
		spike = spike || (p.TS == spikeTS && p.Value == 80)
	}
	ctx.Assert(spike, "the spike to 80 is missing from the downsampled series: keep each bucket's lowest and highest point, not every n-th one")
	ctx.Assert(sort.SliceIsSorted(body.Points, func(i, j int) bool { return body.Points[i].TS < body.Points[j].TS }), "the downsampled points must stay in time order")
	ctx.Equal(body.Downsample["method"], "minmax", "the response must name the method; downsample.method")
}

func CheckStaleness(ctx *harness.Ctx) {
	now := nowSeconds(ctx)
	c, peer := readAPI(ctx)
	peer.series["d-1/temp_c"] = seriesOf([2]float64{float64(now - 900), 20}, [2]float64{float64(now - 600), 21})
	peer.series["d-2/temp_c"] = seriesOf([2]float64{float64(now - 30), 22})
	silent := decodeRead(ctx, readGet(c, "d-1", ptr(now-3600), ptr(now), "f-1"))
	live := decodeRead(ctx, readGet(c, "d-2", ptr(now-3600), ptr(now), "f-1"))
	empty := decodeRead(ctx, readGet(c, "d-2", ptr(now-7200), ptr(now-3600), "f-1"))
	ctx.Assert(silent.AgeSeconds != nil && *silent.AgeSeconds == 600 && silent.Stale != nil && *silent.Stale, "d-1's newest point is 600 s old: expected age_seconds 600 and stale true, got %v", harness.Show(silent))
	ctx.Assert(live.AgeSeconds != nil && *live.AgeSeconds == 30 && live.Stale != nil && !*live.Stale, "d-2's newest point is 30 s old: expected age_seconds 30 and stale false, got %v", harness.Show(live))
	ctx.Assert(empty.AgeSeconds == nil && empty.Stale != nil && *empty.Stale, "a range with no points must answer age_seconds null and stale true, got %v", harness.Show(empty))
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <map>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "ingestd/registry.h"
#include "telemetry_ingest.grpc.pb.h"

using json = nlohmann::json;

namespace {

// Serves series: "device/metric" → its (ts, value) points, oldest first.
class ReadPeer final : public tsdb::TimeSeries::Service {
 public:
  std::map<std::string, std::vector<std::pair<long long, double>>> series;

  grpc::Status Query(grpc::ServerContext*, const tsdb::QueryRequest* req, tsdb::QueryReply* out) override {
    for (const auto& [ts, value] : series[req->device_id() + "/" + req->metric()]) {
      if (ts < req->from_ts() || ts > req->to_ts()) continue;
      tsdb::Point* point = out->add_points();
      point->set_metric(req->metric());
      point->set_ts(ts);
      point->set_value(value);
    }
    return grpc::Status::OK;
  }
};

struct ReadWorld {
  ReadPeer peer;
  httplib::Server svr;
};

ReadWorld& readWorld(harness::Ctx& ctx) {
  static ReadWorld* world = nullptr;
  delete world;
  world = new ReadWorld;
  ctx.GRPC.Server("")->RegisterService(&world->peer);
  registry::registerDevice("d-1", "f-1", {{"temp_c", {-40, 85}}});
  registry::registerDevice("d-2", "f-1", {{"temp_c", {-40, 85}}});
  registry::registerDevice("d-9", "f-2", {{"temp_c", {-40, 85}}});
  register_routes(world->svr);
  return *world;
}

harness::Response readGet(harness::Ctx& ctx, ReadWorld& w, const std::string& device, std::optional<long long> from, long long to, const std::string& fleet) {
  auto c = ctx.HTTP(w.svr);
  std::string path = "/v1/devices/" + device + "/series?metric=temp_c&to=" + std::to_string(to);
  if (from) path += "&from=" + std::to_string(*from);
  if (fleet.empty()) return c.Get(path);
  return c.Get(path, "X-Fleet-Id", fleet);
}

json body(const harness::Response& r) { return json::parse(r.Text(), nullptr, false); }

json field(const json& j, const std::string& name) { return j.is_object() && j.contains(name) ? j[name] : json(); }

long long nowSeconds(harness::Ctx& ctx) { return ctx.Clock.Now() / 1000; }

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  const long long now = nowSeconds(ctx);
  ReadWorld& w = readWorld(ctx);
  w.peer.series["d-1/temp_c"] = {{now - 300, 20.0}, {now - 200, 21.0}, {now - 100, 22.0}};
  const auto r = readGet(ctx, w, "d-1", now - 3600, now, "f-1");
  ctx.Equal(r.Status, 200, "GET /v1/devices/d-1/series (%s)", r.Text());
  const json want = json::array({{{"ts", now - 300}, {"value", 20.0}}, {{"ts", now - 200}, {"value", 21.0}}, {{"ts", now - 100}, {"value", 22.0}}});
  ctx.Equal(field(body(r), "points"), want, "the series must be d-1's three points in time order");
}

void CheckFleetScope(harness::Ctx& ctx) {
  const long long now = nowSeconds(ctx);
  ReadWorld& w = readWorld(ctx);
  w.peer.series["d-9/temp_c"] = {{now - 60, 30.0}};
  const auto anonymous = readGet(ctx, w, "d-1", now - 3600, now, "");
  const auto foreign = readGet(ctx, w, "d-9", now - 3600, now, "f-1");
  const auto unknown = readGet(ctx, w, "d-404", now - 3600, now, "f-1");
  ctx.Equal(anonymous.Status, 401, "a request without X-Fleet-Id");
  ctx.Equal(foreign.Status, 404, "fleet f-1 asking for d-9, a device of fleet f-2, must look exactly like an unknown device (%s)", foreign.Text());
  ctx.Equal(unknown.Status, 404, "an unknown device");
  for (const auto& call : ctx.GRPC.CallsTo("Query")) {
    ctx.Assert(call.Request<tsdb::QueryRequest>().device_id() != "d-9", "the store was queried for another fleet's device: decide the fleet before Query");
  }
}

void CheckRangeCap(harness::Ctx& ctx) {
  const long long now = nowSeconds(ctx);
  ReadWorld& w = readWorld(ctx);
  w.peer.series["d-1/temp_c"] = {{now - 100, 20.0}};
  const auto longRange = readGet(ctx, w, "d-1", now - 2 * 86400, now, "f-1");
  const auto openEnded = readGet(ctx, w, "d-1", std::nullopt, now, "f-1");
  const auto empty = readGet(ctx, w, "d-1", now, now, "f-1");
  const size_t before = ctx.GRPC.CallsTo("Query").size();
  const auto day = readGet(ctx, w, "d-1", now - 86400, now, "f-1");
  ctx.Equal(longRange.Status, 400, "a two-day range (the cap is 24 hours)");
  ctx.Equal(openEnded.Status, 400, "a request without from (a missing bound is not 'since 1970')");
  ctx.Equal(empty.Status, 400, "a range with to == from");
  ctx.Equal(before, 0, "ranges that must be refused never reach the store: the cap is decided before Query; Query calls");
  ctx.Equal(day.Status, 200, "exactly 24 hours (%s)", day.Text());
}

void CheckDownsample(harness::Ctx& ctx) {
  const long long now = nowSeconds(ctx);
  ReadWorld& w = readWorld(ctx);
  std::vector<std::pair<long long, double>> raw;
  for (int i = 0; i < 5000; i++) raw.push_back({now - 5000 + i, 20 + (i % 7) * 0.1});
  const long long spike_ts = raw[2503].first;
  raw[2503].second = 80;
  w.peer.series["d-1/temp_c"] = raw;
  const auto r = readGet(ctx, w, "d-1", now - 6000, now, "f-1");
  ctx.Equal(r.Status, 200, "the series read (%s)", r.Text());
  const json b = body(r);
  const json points = field(b, "points");
  ctx.Assert(points.is_array() && !points.empty() && points.size() <= 1000, "a 5000-point series answered %d points, expected at most kMaxPoints = 1000", points.is_array() ? points.size() : 0);
  bool spike = false;
  long long last = 0;
  bool ordered = true;
  for (const json& p : points) {
    const long long ts = field(p, "ts").is_number() ? field(p, "ts").get<long long>() : 0;
    spike = spike || (ts == spike_ts && field(p, "value") == 80);
    ordered = ordered && ts >= last;
    last = ts;
  }
  ctx.Assert(spike, "the spike to 80 is missing from the downsampled series: keep each bucket's lowest and highest point, not every n-th one");
  ctx.Assert(ordered, "the downsampled points must stay in time order");
  ctx.Equal(field(field(b, "downsample"), "method"), json("minmax"), "the response must name the method; downsample.method");
}

void CheckStaleness(harness::Ctx& ctx) {
  const long long now = nowSeconds(ctx);
  ReadWorld& w = readWorld(ctx);
  w.peer.series["d-1/temp_c"] = {{now - 900, 20.0}, {now - 600, 21.0}};
  w.peer.series["d-2/temp_c"] = {{now - 30, 22.0}};
  const json silent = body(readGet(ctx, w, "d-1", now - 3600, now, "f-1"));
  const json live = body(readGet(ctx, w, "d-2", now - 3600, now, "f-1"));
  const json empty = body(readGet(ctx, w, "d-2", now - 7200, now - 3600, "f-1"));
  ctx.Assert(field(silent, "age_seconds") == 600 && field(silent, "stale") == true, "d-1's newest point is 600 s old: expected age_seconds 600 and stale true, got %s", silent.dump());
  ctx.Assert(field(live, "age_seconds") == 30 && field(live, "stale") == false, "d-2's newest point is 30 s old: expected age_seconds 30 and stale false, got %s", live.dump());
  ctx.Assert(empty.is_object() && empty.contains("age_seconds") && empty["age_seconds"].is_null() && field(empty, "stale") == true, "a range with no points must answer age_seconds null and stale true, got %s", empty.dump());
}
`,
  },
  hints: [
    'Read d-9 with another fleet’s header and get its series; ask for two days and the store scans them; a one-minute spike vanishes from a long chart; a device silent for an hour draws a flat line.',
    'Nothing reads `X-Fleet-Id` or the registry, `from` defaults to 0 and nothing compares the range with a cap, `points[::step]` keeps fixed positions whatever their values, and the response has no notion of time since the last point.',
    'Read `X-Fleet-Id` (401), require `0 < to - from <= MAX_RANGE_S` (400), `registry.lookup` and compare `device["fleet"]` (404), all before `store.Query`; keep each bucket’s min and max past `MAX_POINTS`; add `age_seconds` and `stale`.',
  ],
  debrief: `Every guard on this path runs before the store is asked, because the store is shared: an unbounded range or another fleet's device costs every tenant, not only the caller. A foreign device answers 404 rather than 403 so the endpoint cannot be used to learn which ids exist. Keeping each bucket's minimum and maximum is the cheapest downsampling that cannot hide an extreme, which is what an operator looks for on a dashboard; naming the method tells the chart it is drawing an envelope, not samples. The age of the newest point turns "no data" into a fact the dashboard can colour. Production read paths push the downsampling into the store (pre-aggregated rollups per resolution), cache recent reads per fleet, and charge expensive queries against a per-tenant budget.`,
};
