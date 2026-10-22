import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/devices/{id}/series: bounded reads with real staleness',
  concept: 'http',
  file: 'read',
  focus: ['dashboard', 'ingest', 'registry', 'tsdb'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: a dashboard asks for a
device's series and gets points back, so the chart draws. It hides three production flaws, and the
first one is the outage the on-call engineer caused by refreshing a dashboard. Find them, fix them,
and prove the fix with the checks below.

Implement \`GET /v1/devices/{device_id}/series?metric=…&from=…&to=…\`:

- The caller's fleet comes from the \`X-Fleet-Id\` header; a missing fleet is **401**.
- \`from\` and \`to\` are **required** epoch seconds and \`to\` must be after \`from\` (**400**
  otherwise). The range is capped at **24 hours** (\`86400\` seconds): a longer range is **400**,
  and the cap must be enforced **before** the store is called — an open-ended range that reaches the
  store is a scan of years, and it takes the query path down for everyone.
- The device must exist **and belong to the caller's fleet**: an unknown device and a device from
  another fleet are both **404**, so the endpoint never confirms that an id exists elsewhere.
- When the store returns more than **1000** points, **downsample** to at most that many and name the
  method in the response (\`"downsample": {"method": "lttb", "points": …}\`). A reader that silently
  returns 400 000 points is a reader that is down; and the method matters — a bucket mean flattens
  the spike the dashboard exists to show, which is exactly how the graph scaled to zero unnoticed.
- Report the **newest point's age**: \`age_seconds\` (null when there are no points) and \`stale\`
  (\`true\` when the newest point is older than **300** seconds, or when there are none). A silent
  device must be visible as silent, not as a flat line.

**Failure mode the checks target.** The draft passes \`from=0\` and a far-future \`to\` straight to
the store, returns raw points without downsampling, and answers for any device id in any fleet —
three ways for one dashboard to read another team's fleet, and one way to take the store down.`,
  sequence: {
    participants: ['Dashboard', 'Telemetry Ingest', 'Device registry', 'Time-series store'],
    messages: [
      {
        from: 'Dashboard',
        to: 'Telemetry Ingest',
        label: 'GET /v1/devices/{id}/series?metric&from&to · X-Fleet-Id',
        kind: 'sync',
      },
      {
        from: 'Telemetry Ingest',
        to: 'Telemetry Ingest',
        label: 'cap the range at 24 h — before the store is touched',
        kind: 'sync',
      },
      {from: 'Telemetry Ingest', to: 'Device registry', label: 'lookup(device_id) · fleet must match', kind: 'sync'},
      {from: 'Device registry', to: 'Telemetry Ingest', label: 'device row / another fleet → 404', kind: 'reply'},
      {from: 'Telemetry Ingest', to: 'Time-series store', label: 'Query · bounded range only', kind: 'sync'},
      {from: 'Time-series store', to: 'Telemetry Ingest', label: 'points → LTTB to ≤ 1000 when longer', kind: 'reply'},
      {
        from: 'Telemetry Ingest',
        to: 'Dashboard',
        label: '200 {points, downsample:{method}, age_seconds, stale}',
        kind: 'reply',
      },
    ],
  },
  hints: [
    'Validate the range before you touch the store: `from` and `to` present, `to > from`, and `to - from ≤ 86400`. A missing cap is not a slow query, it is an open-ended one, and every dashboard refresh repeats it — the rejection has to happen in the handler, not in the store.',
    'The fleet check is a 404, not a 403: `registry.lookup(device_id)` and compare the device’s fleet with `X-Fleet-Id`, answering "unknown device" either way. A 403 tells a caller that the id exists somewhere else, which is an enumeration oracle.',
    'Downsampling is a contract with the reader: name the method you used (`lttb`) and the number of points you returned, and prefer a shape-preserving method. Then report `age_seconds` from the newest point and set `stale` — a device that stopped reporting an hour ago must look silent, not flat.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/devices/{id}/series',
      detail: 'Register the series read on `GET /v1/devices/{device_id}/series`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/devices\/\{device_id\}\/series["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/devices\/(:device_id|\{device_id\})\/series['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/devices\/\{device_id\}\/series"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"devices"\s*\/\s*Segment\s*\/\s*"series"\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(/, /\/v1\/devices\//, /\/series/]},
      },
    },
    {
      id: 'range-cap',
      title: 'Caps the range at 24 hours before the store call',
      detail:
        'A range longer than `86400` seconds is **400**, and the check runs before `store.query` — the store must never see an unbounded window. The draft passes `from = 0` and a far-future `to` straight through, so one request scans years.',
      match: {
        python: {all: [/MAX_RANGE_S\s*=\s*86400/, /status_code\s*=\s*400/], order: [/MAX_RANGE_S/, /store\.query\(/]},
        typescript: {all: [/MAX_RANGE_S\s*=\s*86400/, /code\(\s*400\s*\)/], order: [/MAX_RANGE_S/, /store\.query\(/]},
        go: {all: [/maxRangeSeconds\s*=\s*86400/, /StatusBadRequest/], order: [/maxRangeSeconds/, /store\.Query\(/]},
        scala: {
          all: [/MaxRangeSeconds\s*=\s*86400/, /StatusCodes\.BadRequest/],
          order: [/MaxRangeSeconds/, /store\.query\(/],
        },
        cpp: {all: [/kMaxRangeSeconds\s*=\s*86400/, /\b400\b/], order: [/kMaxRangeSeconds/, /store\.query\(/]},
      },
    },
    {
      id: 'downsample',
      title: 'Downsamples past 1000 points and names the method',
      detail:
        'A series longer than `MAX_POINTS = 1000` is downsampled and the response names the method (`lttb`). The draft returns every raw point, so a day of a chatty device is hundreds of thousands of rows and a spike-preserving method is never involved.',
      match: {
        python: {all: [/MAX_POINTS\s*=\s*1000/, /lttb/]},
        typescript: {all: [/MAX_POINTS\s*=\s*1000/, /lttb/]},
        go: {all: [/maxPoints\s*=\s*1000/, /lttb/]},
        scala: {all: [/MaxPoints\s*=\s*1000/, /lttb/]},
        cpp: {all: [/kMaxPoints\s*=\s*1000/, /lttb/]},
      },
    },
    {
      id: 'staleness',
      title: 'Reports the newest point’s age and staleness',
      detail:
        'The response carries `age_seconds` (the age of the newest point) and `stale` (true when it is old, or when there are no points). The draft reports neither, so a device that went silent an hour ago is indistinguishable from a steady one.',
      match: {
        python: {all: [/age_seconds/, /stale/]},
        typescript: {all: [/age_seconds/, /stale/]},
        go: {all: [/age_seconds/, /stale/]},
        scala: {all: [/age_seconds/, /stale/]},
        cpp: {all: [/age_seconds/, /stale/]},
      },
    },
    {
      id: 'fleet-scope',
      title: 'Scopes the lookup to the caller’s fleet',
      detail:
        'The device row’s fleet is compared with the `X-Fleet-Id` header and a mismatch is **404**, exactly like an unknown device. The draft serves any device id it is given, so one fleet can read another fleet’s series.',
      match: {
        python: {all: [/device\["fleet"\]/, /status_code\s*=\s*404/]},
        typescript: {all: [/device\.fleet/, /code\(\s*404\s*\)/]},
        go: {all: [/device\.Fleet/, /StatusNotFound/]},
        scala: {all: [/device\.fleet/, /StatusCodes\.NotFound/]},
        cpp: {all: [/device->fleet/, /\b404\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI

app = FastAPI()


class SeriesStore:
    def query(self, device_id: str, metric: str, from_s: int, to_s: int) -> list[dict]:
        """The stored points in [from_s, to_s], oldest first."""
        raise NotImplementedError


store = SeriesStore()


@app.get("/v1/devices/{device_id}/series")
def series(device_id: str, metric: str, to_s: int | None = None) -> dict:
    # TODO: the draft accepts an open-ended range that scans years, returns every raw point without
    # downsampling, and serves any device id it is given, including one from another fleet.
    points = store.query(device_id, metric, 0, to_s or 4_102_444_800)
    return {"device_id": device_id, "metric": metric, "points": points}
`,
      solution: `import time

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse

app = FastAPI()

MAX_RANGE_S = 86400
MAX_POINTS = 1000
STALE_AFTER_S = 300


class DeviceRegistry:
    def lookup(self, device_id: str) -> dict | None:
        """The device row: {"id", "fleet"}, or None."""
        raise NotImplementedError


class SeriesStore:
    def query(self, device_id: str, metric: str, from_s: int, to_s: int) -> list[dict]:
        """The stored points in [from_s, to_s], oldest first."""
        raise NotImplementedError


registry = DeviceRegistry()
store = SeriesStore()


def downsample_lttb(points: list[dict], target: int) -> list[dict]:
    """Largest-Triangle-Three-Buckets: keeps the peaks a bucket mean would smooth away."""
    raise NotImplementedError


@app.get("/v1/devices/{device_id}/series")
def series(
    device_id: str,
    metric: str,
    from_s: int,
    to_s: int,
    fleet: str | None = Header(default=None, alias="X-Fleet-Id"),
) -> JSONResponse:
    if fleet is None or fleet == "":
        return JSONResponse({"error": "missing X-Fleet-Id"}, status_code=401)
    if to_s <= from_s:
        return JSONResponse({"error": "to must be after from"}, status_code=400)
    if to_s - from_s > MAX_RANGE_S:
        return JSONResponse({"error": "range exceeds 24 h"}, status_code=400)

    device = registry.lookup(device_id)
    if device is None or device["fleet"] != fleet:
        # An unknown device and another fleet's device are the same answer: 404 tells the caller
        # nothing about ids that exist elsewhere.
        return JSONResponse({"error": "unknown device"}, status_code=404)

    # The cap is already enforced, so the store only ever sees a bounded window.
    points = store.query(device_id, metric, from_s, to_s)
    body: dict = {"device_id": device_id, "metric": metric, "from": from_s, "to": to_s}
    if len(points) > MAX_POINTS:
        points = downsample_lttb(points, MAX_POINTS)
        body["downsample"] = {"method": "lttb", "points": len(points)}
    body["points"] = points

    newest = max((point["ts"] for point in points), default=None)
    body["age_seconds"] = None if newest is None else int(time.time()) - newest
    body["stale"] = newest is None or body["age_seconds"] > STALE_AFTER_S
    return JSONResponse(body, status_code=200)
`,
    },
    typescript: {
      starter: `/** GET /v1/devices/{id}/series: a model-generated draft with an open-ended range. */
import Fastify from 'fastify';

import {store} from './deps';

export const app = Fastify();

app.get('/v1/devices/:device_id/series', async (request, reply) => {
  // TODO: the draft accepts an open-ended range that scans years, returns every raw point without
  // downsampling, and serves any device id it is given, including one from another fleet.
  const params = request.params as {device_id: string};
  const query = request.query as {metric?: string; to?: string};
  const toS = Number(query.to ?? 4102444800);
  const points = await store.query(params.device_id, query.metric ?? '', 0, toS);
  return reply.code(200).send({device_id: params.device_id, metric: query.metric, points});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/devices/{id}/series: capped ranges, named downsampling, honest staleness. */
import Fastify from 'fastify';

import {registry, store} from './deps';

export const app = Fastify();

const MAX_RANGE_S = 86400;
const MAX_POINTS = 1000;
const STALE_AFTER_S = 300;

app.get('/v1/devices/:device_id/series', async (request, reply) => {
  const fleetId = request.headers['x-fleet-id'];
  if (typeof fleetId !== 'string' || fleetId === '')
    return reply.code(401).send({error: 'missing X-Fleet-Id'});

  const query = request.query as {metric?: string; from?: string; to?: string};
  const fromS = Number(query.from);
  const toS = Number(query.to);
  if (!Number.isInteger(fromS) || !Number.isInteger(toS))
    return reply.code(400).send({error: 'from and to are required'});
  if (toS <= fromS) return reply.code(400).send({error: 'to must be after from'});
  if (toS - fromS > MAX_RANGE_S) return reply.code(400).send({error: 'range exceeds 24 h'});

  const params = request.params as {device_id: string};
  const device = await registry.lookup(params.device_id);
  // An unknown device and another fleet's device are the same answer: 404.
  if (device === null || device.fleet !== fleetId) return reply.code(404).send({error: 'unknown device'});

  // The cap is already enforced, so the store only ever sees a bounded window.
  const raw = await store.query(params.device_id, query.metric ?? '', fromS, toS);
  const body: Record<string, unknown> = {
    device_id: params.device_id,
    metric: query.metric,
    from: fromS,
    to: toS,
  };
  let points = raw;
  if (raw.length > MAX_POINTS) {
    points = await store.downsampleLttb(raw, MAX_POINTS);
    body.downsample = {method: 'lttb', points: points.length};
  }
  body.points = points;

  const newest = points.length === 0 ? null : Math.max(...points.map(point => point.ts));
  const ageSeconds = newest === null ? null : Math.floor(Date.now() / 1000) - newest;
  body.age_seconds = ageSeconds;
  body.stale = ageSeconds === null || ageSeconds > STALE_AFTER_S;
  return reply.code(200).send(body);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"net/http"
	"strconv"
)

const (
	maxPoints = 1000
)

type Point struct {
	TS    int64   \`json:"ts"\`
	Value float64 \`json:"value"\`
}

type SeriesStore struct{}

func (s *SeriesStore) Query(ctx context.Context, deviceID, metric string, fromS, toS int64) ([]Point, error) {
	return nil, nil
}

var store = &SeriesStore{}

func series(rw http.ResponseWriter, r *http.Request) {
	// TODO: the draft accepts an open-ended range that scans years, returns every raw point without
	// downsampling, and serves any device id it is given, including one from another fleet.
	deviceID := r.PathValue("device_id")
	toS, _ := strconv.ParseInt(r.URL.Query().Get("to"), 10, 64)
	if toS == 0 {
		toS = 4102444800
	}
	points, _ := store.Query(r.Context(), deviceID, r.URL.Query().Get("metric"), 0, toS)
	writeJSON(rw, http.StatusOK, map[string]any{"device_id": deviceID, "points": points})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/devices/{device_id}/series", series)
	_ = http.ListenAndServe(":8443", mux)
}
`,
      solution: `package main

import (
	"context"
	"net/http"
	"strconv"
	"time"
)

const (
	maxRangeSeconds  = 86400
	maxPoints        = 1000
	staleAfterSecond = 300
)

type Point struct {
	TS    int64   \`json:"ts"\`
	Value float64 \`json:"value"\`
}

type Device struct {
	ID    string
	Fleet string
}

type DeviceRegistry struct{}

// Lookup returns nil when the device id is not in the registry.
func (d *DeviceRegistry) Lookup(ctx context.Context, deviceID string) (*Device, error) { return nil, nil }

type SeriesStore struct{}

func (s *SeriesStore) Query(ctx context.Context, deviceID, metric string, fromS, toS int64) ([]Point, error) {
	return nil, nil
}

func (s *SeriesStore) DownsampleLttb(points []Point, target int) ([]Point, error) { return points, nil }

var registry = &DeviceRegistry{}
var store = &SeriesStore{}

func series(rw http.ResponseWriter, r *http.Request) {
	fleet := r.Header.Get("X-Fleet-Id")
	if fleet == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Fleet-Id"})
		return
	}
	deviceID := r.PathValue("device_id")
	fromS, errFrom := strconv.ParseInt(r.URL.Query().Get("from"), 10, 64)
	toS, errTo := strconv.ParseInt(r.URL.Query().Get("to"), 10, 64)
	if errFrom != nil || errTo != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "from and to are required"})
		return
	}
	if toS <= fromS {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "to must be after from"})
		return
	}
	if toS-fromS > maxRangeSeconds {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "range exceeds 24 h"})
		return
	}

	device, err := registry.Lookup(r.Context(), deviceID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "registry unavailable"})
		return
	}
	// An unknown device and another fleet's device are the same answer: 404.
	if device == nil || device.Fleet != fleet {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown device"})
		return
	}

	// The cap is already enforced, so the store only ever sees a bounded window.
	points, err := store.Query(r.Context(), deviceID, r.URL.Query().Get("metric"), fromS, toS)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "store unavailable"})
		return
	}
	body := map[string]any{"device_id": deviceID, "from": fromS, "to": toS}
	if len(points) > maxPoints {
		points = mustDownsample(points, maxPoints)
		body["downsample"] = map[string]any{"method": "lttb", "points": len(points)}
	}
	body["points"] = points

	if len(points) == 0 {
		body["age_seconds"] = nil
		body["stale"] = true
	} else {
		newest := points[0].TS
		for _, point := range points {
			if point.TS > newest {
				newest = point.TS
			}
		}
		age := time.Now().Unix() - newest
		body["age_seconds"] = age
		body["stale"] = age > staleAfterSecond
	}
	writeJSON(rw, http.StatusOK, body)
}

func mustDownsample(points []Point, target int) []Point {
	sampled, err := store.DownsampleLttb(points, target)
	if err != nil {
		return points
	}
	return sampled
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/devices/{device_id}/series", series)
	_ = http.ListenAndServe(":8443", mux)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

object DeviceSeries {
  implicit val system: ActorSystem = ActorSystem("telemetry-ingest")

  val store = SeriesStore.open()

  val route: Route =
    path("v1" / "devices" / Segment / "series") { deviceId =>
      get {
        parameter("metric", "to") { (metric, toRaw) =>
          // TODO: the draft accepts an open-ended range that scans years, returns every raw point
          // without downsampling, and serves any device id it is given, including another fleet's.
          val to = toRaw.toLong
          val points = store.query(deviceId, metric, 0, to)
          complete(StatusCodes.OK, s"""{"device_id":"$deviceId","points":\${points.length}}""")
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
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

object DeviceSeries {
  implicit val system: ActorSystem = ActorSystem("telemetry-ingest")

  val MaxRangeSeconds = 86400L
  val MaxPoints = 1000
  val StaleAfterSeconds = 300L

  val registry = DeviceRegistry.open()
  val store = SeriesStore.open()

  val route: Route =
    path("v1" / "devices" / Segment / "series") { deviceId =>
      get {
        optionalHeaderValueByName("X-Fleet-Id") { fleetOpt =>
          if (!fleetOpt.exists(_.nonEmpty)) {
            complete(StatusCodes.Unauthorized, """{"error":"missing X-Fleet-Id"}""")
          } else {
            parameter("metric", "from", "to") { (metric, fromRaw, toRaw) =>
              val from = fromRaw.toLongOption
              val to = toRaw.toLongOption
              if (from.isEmpty || to.isEmpty) {
                complete(StatusCodes.BadRequest, """{"error":"from and to are required"}""")
              } else if (to.get <= from.get) {
                complete(StatusCodes.BadRequest, """{"error":"to must be after from"}""")
              } else if (to.get - from.get > MaxRangeSeconds) {
                complete(StatusCodes.BadRequest, """{"error":"range exceeds 24 h"}""")
              } else {
                // An unknown device and another fleet's device are the same answer: 404.
                registry.lookup(deviceId) match {
                  case None =>
                    complete(StatusCodes.NotFound, """{"error":"unknown device"}""")
                  case Some(device) if device.fleet != fleetOpt.get =>
                    complete(StatusCodes.NotFound, """{"error":"unknown device"}""")
                  case Some(_) =>
                    // The cap is already enforced, so the store only ever sees a bounded window.
                    val raw = store.query(deviceId, metric, from.get, to.get)
                    val (points, method) =
                      if (raw.length > MaxPoints) (store.downsampleLttb(raw, MaxPoints), "lttb")
                      else (raw, "none")
                    val age = if (points.isEmpty) None else Some(System.currentTimeMillis() / 1000 - points.map(_.ts).max)
                    val stale = age.forall(_ > StaleAfterSeconds)
                    complete(
                      StatusCodes.OK,
                      s"""{"device_id":"$deviceId","points":\${points.length},"downsample":{"method":"$method","points":\${points.length}},"age_seconds":\${age.getOrElse(0)},"stale":$stale}"""
                    )
                }
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

#include <string>

using json = nlohmann::json;

struct SeriesStore {
  json query(const std::string& deviceId, const std::string& metric, long long fromS, long long toS);
};

SeriesStore store;

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/devices/([^/]+)/series)", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: the draft accepts an open-ended range that scans years, returns every raw point without
    // downsampling, and serves any device id it is given, including one from another fleet.
    const auto deviceId = req.matches[1].str();
    const auto toS = req.has_param("to") ? std::stoll(req.get_param_value("to")) : 4102444800LL;
    const auto points = store.query(deviceId, req.get_param_value("metric"), 0, toS);
    res.status = 200;
    res.set_content(
        json{{"device_id", deviceId}, {"metric", req.get_param_value("metric")}, {"points", points}}.dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <optional>
#include <string>

using json = nlohmann::json;

constexpr long long kMaxRangeSeconds = 86400;
constexpr std::size_t kMaxPoints = 1000;
constexpr long long kStaleAfterSeconds = 300;

struct Device {
  std::string id;
  std::string fleet;
};

struct DeviceRegistry {
  std::optional<Device> lookup(const std::string& deviceId);
};

struct SeriesStore {
  json query(const std::string& deviceId, const std::string& metric, long long fromS, long long toS);
  json downsampleLttb(const json& points, std::size_t target);
};

DeviceRegistry registry;
SeriesStore store;

bool parseEpoch(const std::string& raw, long long& out) {
  try {
    std::size_t used = 0;
    out = std::stoll(raw, &used);
    return used == raw.size() && !raw.empty();
  } catch (const std::exception&) {
    return false;
  }
}

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/devices/([^/]+)/series)", [](const httplib::Request& req, httplib::Response& res) {
    const auto fleet = req.get_header_value("X-Fleet-Id");
    if (fleet.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Fleet-Id"})", "application/json");
      return;
    }
    const auto deviceId = req.matches[1].str();
    long long fromS = 0;
    long long toS = 0;
    if (!req.has_param("from") || !req.has_param("to") || !parseEpoch(req.get_param_value("from"), fromS) ||
        !parseEpoch(req.get_param_value("to"), toS)) {
      res.status = 400;
      res.set_content(R"({"error":"from and to are required"})", "application/json");
      return;
    }
    if (toS <= fromS) {
      res.status = 400;
      res.set_content(R"({"error":"to must be after from"})", "application/json");
      return;
    }
    if (toS - fromS > kMaxRangeSeconds) {
      res.status = 400;
      res.set_content(R"({"error":"range exceeds 24 h"})", "application/json");
      return;
    }

    const auto device = registry.lookup(deviceId);
    // An unknown device and another fleet's device are the same answer: 404.
    if (!device || device->fleet != fleet) {
      res.status = 404;
      res.set_content(R"({"error":"unknown device"})", "application/json");
      return;
    }

    // The cap is already enforced, so the store only ever sees a bounded window.
    auto points = store.query(deviceId, req.get_param_value("metric"), fromS, toS);
    json body = {{"device_id", deviceId}, {"from", fromS}, {"to", toS}};
    if (points.size() > kMaxPoints) {
      points = store.downsampleLttb(points, kMaxPoints);
      body["downsample"] = {{"method", "lttb"}, {"points", points.size()}};
    }
    body["points"] = points;

    const auto now = std::chrono::duration_cast<std::chrono::seconds>(
                         std::chrono::system_clock::now().time_since_epoch())
                         .count();
    long long newest = -1;
    for (const auto& point : points) newest = std::max(newest, point.value("ts", 0LL));
    body["age_seconds"] = newest < 0 ? json(nullptr) : json(now - newest);
    body["stale"] = newest < 0 || now - newest > kStaleAfterSeconds;
    res.status = 200;
    res.set_content(body.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `Three contracts, one endpoint. First, the read is bounded: a range cap enforced in the handler means the store only ever sees a window it can answer, and the dashboard that refreshes every five seconds cannot take the query path down — a cap the store enforces is a cap the store pays for. Second, the read is scoped: the caller names a fleet, the device row carries a fleet, and a mismatch is indistinguishable from an unknown device, so the endpoint never leaks the existence of another team’s devices. Third, the read is honest: downsampling that silently drops the peak is how a fleet’s graph scaled to zero without anyone noticing, which is why the method is named in the response and why the newest point’s age travels with the data — an empty or stale series must look stale, not steady. Real platforms add per-caller read budgets, pre-aggregated materialized views for common windows, and cursor pagination for the raw path, but the cap, the scope and the staleness are what make the endpoint safe to expose.`,
};
