import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/series: bounded in range, page size and resolution',
  concept: 'http',
  guides: ['honest-reads', 'request-boundaries'],
  file: 'read',
  focus: ['client', 'query', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/series?metric=…&from=…&to=…\`: it takes the tenant
from a \`tenant\` query parameter, falling back to \`X-Tenant-Id\` (401 without either), defaults
\`from\` to 0 and \`to\` to now, lists the metric's series with \`series_in_range\`, reads every
window with \`read_windows\` (both \`metrics.windows\`) and answers \`{"series": [{"series", "points":
[{"t", "count", "sum"}]}]}\` with one point per 10-second window. The dashboard renders, and it hides
4 flaws.

**Failure mode the checks target.** A request with no \`from\` scans a day of windows; a metric with
thousands of series comes back in one response; a six-hour chart carries 2,160 points per series;
and anyone can read another tenant's series by adding \`?tenant=\`.

- The tenant is \`X-Tenant-Id\` only.
- \`from\` and \`to\` are required integers with \`to > from\` and \`to - from <= MAX_RANGE_SECONDS\`
  (6 hours); anything else is **400** \`invalid_range\`.
- At most \`PAGE_SERIES\` (50) series per response, in series order after \`cursor\`; \`next_cursor\`
  is the last series of a full page when more follow, else \`null\`.
- Points are summed into \`RESOLUTION_SECONDS\` (60) buckets, \`t = start - start % 60\`, and the
  body says so: \`"resolution": 60, "method": "sum"\`.`,
  sequence: {
    participants: ['Dashboard', 'Series API', 'Redis'],
    messages: [
      {from: 'Dashboard', to: 'Series API', label: 'GET /v1/series?metric&from&to&cursor · X-Tenant-Id', kind: 'sync'},
      {from: 'Series API', to: 'Series API', label: 'to - from ≤ 6 h · else 400', kind: 'sync'},
      {from: 'Series API', to: 'Redis', label: 'series_in_range → next 50 after cursor', kind: 'sync'},
      {from: 'Series API', to: 'Redis', label: 'read_windows(page)', kind: 'sync'},
      {from: 'Series API', to: 'Series API', label: 'sum into 60 s buckets', kind: 'sync'},
      {
        from: 'Series API',
        to: 'Dashboard',
        label: '200 {series, resolution: 60, method: sum, next_cursor}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/series for a tenant',
      detail:
        "Register `GET /v1/series`, answer **401** without a tenant, and return the metric's series with their points.",
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/series["']/, /read_windows\(/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/series['"]/, /readWindows\(/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/series"/, /windows\.ReadWindows\(/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"series"\s*\)/, /Windows\.readWindows\(/]},
        cpp: {all: [/svr\.Get\(\s*"\/v1\/series"/, /metrics::readWindows\(/]},
      },
    },
    {
      id: 'range-cap',
      title: 'Requires a range of at most 6 hours',
      detail:
        '`from` and `to` are required, `to` must be after `from` and the span at most `MAX_RANGE_SECONDS` (6 hours); otherwise **400** `invalid_range` before Redis is read. The starter defaults `from` to 0, so a bare request scans every window the index holds.',
      match: {
        python: {
          all: [/MAX_RANGE_SECONDS\s*=\s*(6\s*\*\s*3600|21600)\b/, /invalid_range/],
          none: [/get\(\s*["']from["']\s*,\s*0\s*\)/],
        },
        typescript: {
          all: [/MAX_RANGE_SECONDS\s*=\s*(6\s*\*\s*3600|21600)\b/, /invalid_range/],
          none: [/q\.from\s*\?\?\s*0/],
        },
        go: {all: [/maxRangeSeconds\s*=\s*(6\s*\*\s*3600|21600)\b/, /invalid_range/], none: [/start\s*=\s*0\b/]},
        scala: {all: [/MaxRangeSeconds\s*=\s*(6\s*\*\s*3600|21600)L?\b/, /invalid_range/], none: [/getOrElse\(0L\)/]},
        cpp: {all: [/kMaxRangeSeconds\s*=\s*(6\s*\*\s*3600|21600)\b/, /invalid_range/], none: [/:\s*0LL;/]},
      },
    },
    {
      id: 'series-page',
      title: 'Pages the series 50 at a time with a cursor',
      detail:
        'At most `PAGE_SERIES` (50) series per response, the ones after `cursor` in series order, with `next_cursor` set while more follow. The starter returns every series of the metric at once.',
      match: {
        python: {all: [/PAGE_SERIES\s*=\s*50\b/, /next_cursor/, /["']cursor["']/]},
        typescript: {all: [/PAGE_SERIES\s*=\s*50\b/, /next_cursor/, /q\.cursor/]},
        go: {all: [/pageSeries\s*=\s*50\b/, /next_cursor/, /Get\("cursor"\)/]},
        scala: {all: [/PageSeries\s*=\s*50\b/, /next_cursor/, /"cursor"/]},
        cpp: {all: [/kPageSeries\s*=\s*50\b/, /next_cursor/, /"cursor"/]},
      },
    },
    {
      id: 'downsample',
      title: 'Sums points into 60-second buckets and names the method',
      detail:
        'Windows are summed into `RESOLUTION_SECONDS` (60) buckets and the body carries `"resolution": 60, "method": "sum"`. The starter returns one point per 10-second window, six times the points a chart can draw, with nothing saying what a point is.',
      match: {
        python: {all: [/RESOLUTION_SECONDS\s*=\s*60\b/, /%\s*RESOLUTION_SECONDS/, /["']method["']\s*:\s*["']sum["']/]},
        typescript: {all: [/RESOLUTION_SECONDS\s*=\s*60\b/, /%\s*RESOLUTION_SECONDS/, /method:\s*['"]sum['"]/]},
        go: {all: [/resolutionSeconds\s*=\s*60\b/, /%\s*resolutionSeconds/, /"method":\s*"sum"/]},
        scala: {all: [/ResolutionSeconds\s*=\s*60L?\b/, /%\s*ResolutionSeconds/, /"method"\s*->\s*JsString\("sum"\)/]},
        cpp: {all: [/kResolutionSeconds\s*=\s*60\b/, /%\s*kResolutionSeconds/, /\{"method",\s*"sum"\}/]},
      },
    },
    {
      id: 'tenant-isolation',
      title: 'Reads the tenant from X-Tenant-Id only',
      detail:
        "The tenant comes from `X-Tenant-Id`; a `tenant` query parameter is ignored. The starter prefers the query parameter, so any caller reads any tenant's series.",
      match: {
        python: {all: [/headers\.get\(\s*["']x-tenant-id["']/i], none: [/params\.get\(\s*["']tenant["']/]},
        typescript: {all: [/headers\[\s*['"]x-tenant-id['"]\s*\]/i], none: [/\bq\.tenant\b/]},
        go: {all: [/Header\.Get\(\s*"X-Tenant-Id"\s*\)/], none: [/Get\("tenant"\)/]},
        scala: {all: [/HeaderValueByName\(\s*"X-Tenant-Id"\s*\)/], none: [/params\.get\("tenant"\)/]},
        cpp: {all: [/get_header_value\(\s*"X-Tenant-Id"\s*\)/], none: [/get_param_value\("tenant"\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from metrics.windows import read_windows, series_in_range  # (tenant, metric, start, end) · (tenant, metric, names, start, end)

app = FastAPI()


@app.get("/v1/series")
def query(request: Request) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    params = request.query_params
    tenant = params.get("tenant") or request.headers.get("x-tenant-id", "")
    if not tenant:
        return JSONResponse({"error": "missing_tenant"}, status_code=401)
    metric = params.get("metric", "")
    start = int(params.get("from", 0))
    end = int(params.get("to", int(time.time())))
    names = series_in_range(tenant, metric, start, end)
    points = {name: [] for name in names}
    for w in read_windows(tenant, metric, names, start, end):
        points[w["series"]].append({"t": w["start"], "count": w["count"], "sum": w["sum"]})
    return JSONResponse({"series": [{"series": name, "points": points[name]} for name in names]})
`,
      solution: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from metrics.windows import read_windows, series_in_range  # (tenant, metric, start, end) · (tenant, metric, names, start, end)

app = FastAPI()

MAX_RANGE_SECONDS = 6 * 3600
PAGE_SERIES = 50
RESOLUTION_SECONDS = 60


def downsample(windows: list) -> list:
    """Sum the 10-second windows into RESOLUTION_SECONDS buckets, oldest first."""
    buckets = {}
    for w in windows:
        t = w["start"] - w["start"] % RESOLUTION_SECONDS
        point = buckets.setdefault(t, {"t": t, "count": 0, "sum": 0.0})
        point["count"] += w["count"]
        point["sum"] += w["sum"]
    return [buckets[t] for t in sorted(buckets)]


@app.get("/v1/series")
def query(request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id", "")  # never from the query: the caller does not choose its tenant
    if not tenant:
        return JSONResponse({"error": "missing_tenant"}, status_code=401)
    params = request.query_params
    try:
        start, end = int(params["from"]), int(params["to"])
    except (KeyError, ValueError):
        start, end = 0, -1
    if end <= start or end - start > MAX_RANGE_SECONDS:
        return JSONResponse({"error": "invalid_range", "max_seconds": MAX_RANGE_SECONDS}, status_code=400)
    metric = params.get("metric", "")
    cursor = params.get("cursor", "")
    names = [name for name in series_in_range(tenant, metric, start, end) if name > cursor]
    page = names[:PAGE_SERIES]
    windows = {name: [] for name in page}
    for w in read_windows(tenant, metric, page, start, end):
        windows[w["series"]].append(w)
    return JSONResponse({
        "series": [{"series": name, "points": downsample(windows[name])} for name in page],
        "resolution": RESOLUTION_SECONDS,
        "method": "sum",
        "next_cursor": page[-1] if len(names) > PAGE_SERIES else None,
    })
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {readWindows, seriesInRange} from 'metrics/windows'; // (tenant, metric, start, end) · (tenant, metric, names, start, end)

export const app = Fastify();

app.get('/v1/series', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const q = request.query as Record<string, string | undefined>;
  const tenant = q.tenant ?? request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing_tenant'});
  const metric = q.metric ?? '';
  const start = Number(q.from ?? 0);
  const end = Number(q.to ?? Math.floor(Date.now() / 1000));
  const names = await seriesInRange(tenant, metric, start, end);
  const windows = await readWindows(tenant, metric, names, start, end);
  return {
    series: names.map(name => ({
      series: name,
      points: windows.filter(w => w.series === name).map(w => ({t: w.start, count: w.count, sum: w.sum})),
    })),
  };
});
`,
      solution: `import Fastify from 'fastify';

import type {Window} from 'metrics/model';
import {readWindows, seriesInRange} from 'metrics/windows'; // (tenant, metric, start, end) · (tenant, metric, names, start, end)

export const app = Fastify();

const MAX_RANGE_SECONDS = 6 * 3600;
const PAGE_SERIES = 50;
const RESOLUTION_SECONDS = 60;

interface Point {
  t: number;
  count: number;
  sum: number;
}

/** Sum the 10-second windows into RESOLUTION_SECONDS buckets, oldest first. */
function downsample(windows: Window[]): Point[] {
  const buckets = new Map<number, Point>();
  for (const w of windows) {
    const t = w.start - (w.start % RESOLUTION_SECONDS);
    const point = buckets.get(t) ?? {t, count: 0, sum: 0};
    point.count += w.count;
    point.sum += w.sum;
    buckets.set(t, point);
  }
  return [...buckets.values()].sort((a, b) => a.t - b.t);
}

app.get('/v1/series', async (request, reply) => {
  // Never from the query: the caller does not choose its tenant.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing_tenant'});
  const q = request.query as Record<string, string | undefined>;
  const start = Number(q.from);
  const end = Number(q.to);
  if (q.from === undefined || q.to === undefined || !Number.isInteger(start) || !Number.isInteger(end) || end <= start || end - start > MAX_RANGE_SECONDS) {
    return reply.code(400).send({error: 'invalid_range', max_seconds: MAX_RANGE_SECONDS});
  }
  const metric = q.metric ?? '';
  const cursor = q.cursor ?? '';
  const names = (await seriesInRange(tenant, metric, start, end)).filter(name => name > cursor);
  const page = names.slice(0, PAGE_SERIES);
  const windows = await readWindows(tenant, metric, page, start, end);
  return {
    series: page.map(name => ({series: name, points: downsample(windows.filter(w => w.series === name))})),
    resolution: RESOLUTION_SECONDS,
    method: 'sum',
    next_cursor: names.length > PAGE_SERIES ? page[page.length - 1] : null,
  };
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"metrics/windows" // windows.SeriesInRange(ctx, tenant, metric, start, end) · windows.ReadWindows(ctx, tenant, metric, names, start, end)
)

type point struct {
	T     int64   \`json:"t"\`
	Count int64   \`json:"count"\`
	Sum   float64 \`json:"sum"\`
}

type seriesPoints struct {
	Series string  \`json:"series"\`
	Points []point \`json:"points"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func query(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	q := r.URL.Query()
	tenant := q.Get("tenant")
	if tenant == "" {
		tenant = r.Header.Get("X-Tenant-Id")
	}
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing_tenant"})
		return
	}
	metric := q.Get("metric")
	var start int64 = 0
	if v, err := strconv.ParseInt(q.Get("from"), 10, 64); err == nil {
		start = v
	}
	end := time.Now().Unix()
	if v, err := strconv.ParseInt(q.Get("to"), 10, 64); err == nil {
		end = v
	}
	names, err := windows.SeriesInRange(r.Context(), tenant, metric, start, end)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	ws, err := windows.ReadWindows(r.Context(), tenant, metric, names, start, end)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	out := []seriesPoints{}
	for _, name := range names {
		s := seriesPoints{Series: name, Points: []point{}}
		for _, w := range ws {
			if w.Series == name {
				s.Points = append(s.Points, point{T: w.Start, Count: w.Count, Sum: w.Sum})
			}
		}
		out = append(out, s)
	}
	writeJSON(rw, http.StatusOK, map[string]any{"series": out})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/series", query)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"sort"
	"strconv"

	"metrics/model"   // model.Window
	"metrics/windows" // windows.SeriesInRange(ctx, tenant, metric, start, end) · windows.ReadWindows(ctx, tenant, metric, names, start, end)
)

const (
	maxRangeSeconds   = 6 * 3600
	pageSeries        = 50
	resolutionSeconds = 60
)

type point struct {
	T     int64   \`json:"t"\`
	Count int64   \`json:"count"\`
	Sum   float64 \`json:"sum"\`
}

type seriesPoints struct {
	Series string  \`json:"series"\`
	Points []point \`json:"points"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

// downsample sums the 10-second windows into resolutionSeconds buckets, oldest first.
func downsample(ws []model.Window) []point {
	buckets := map[int64]*point{}
	for _, w := range ws {
		t := w.Start - w.Start%resolutionSeconds
		p, ok := buckets[t]
		if !ok {
			p = &point{T: t}
			buckets[t] = p
		}
		p.Count += w.Count
		p.Sum += w.Sum
	}
	out := make([]point, 0, len(buckets))
	for _, p := range buckets {
		out = append(out, *p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].T < out[j].T })
	return out
}

func query(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id") // never from the query: the caller does not choose its tenant
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing_tenant"})
		return
	}
	q := r.URL.Query()
	start, errFrom := strconv.ParseInt(q.Get("from"), 10, 64)
	end, errTo := strconv.ParseInt(q.Get("to"), 10, 64)
	if errFrom != nil || errTo != nil || end <= start || end-start > maxRangeSeconds {
		writeJSON(rw, http.StatusBadRequest, map[string]any{"error": "invalid_range", "max_seconds": maxRangeSeconds})
		return
	}
	metric, cursor := q.Get("metric"), q.Get("cursor")
	all, err := windows.SeriesInRange(r.Context(), tenant, metric, start, end)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	names := []string{}
	for _, name := range all {
		if name > cursor {
			names = append(names, name)
		}
	}
	page := names
	if len(page) > pageSeries {
		page = page[:pageSeries]
	}
	ws, err := windows.ReadWindows(r.Context(), tenant, metric, page, start, end)
	if err != nil {
		http.Error(rw, err.Error(), http.StatusInternalServerError)
		return
	}
	bySeries := map[string][]model.Window{}
	for _, w := range ws {
		bySeries[w.Series] = append(bySeries[w.Series], w)
	}
	out := []seriesPoints{}
	for _, name := range page {
		out = append(out, seriesPoints{Series: name, Points: downsample(bySeries[name])})
	}
	var next any
	if len(names) > pageSeries {
		next = page[len(page)-1]
	}
	writeJSON(rw, http.StatusOK, map[string]any{"series": out, "resolution": resolutionSeconds, "method": "sum", "next_cursor": next})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/series", query)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import metrics.Windows // Windows.seriesInRange(tenant, metric, start, end) · Windows.readWindows(tenant, metric, names, start, end)

object Read {
  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  val route: Route = path("v1" / "series") {
    get {
      parameterMap { params =>
        optionalHeaderValueByName("X-Tenant-Id") { header =>
          // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
          params.get("tenant").orElse(header).filter(_.nonEmpty) match {
            case None => complete(json(StatusCodes.Unauthorized, JsObject("error" -> JsString("missing_tenant"))))
            case Some(tenant) =>
              val metric = params.getOrElse("metric", "")
              val start = params.get("from").flatMap(_.toLongOption).getOrElse(0L)
              val end = params.get("to").flatMap(_.toLongOption).getOrElse(System.currentTimeMillis() / 1000)
              val names = Windows.seriesInRange(tenant, metric, start, end)
              val bySeries = Windows.readWindows(tenant, metric, names, start, end).groupBy(_.series)
              val series = names.map { name =>
                val points = bySeries.getOrElse(name, Seq.empty).map(w => JsObject("t" -> JsNumber(w.start), "count" -> JsNumber(w.count), "sum" -> JsNumber(w.sum)))
                JsObject("series" -> JsString(name), "points" -> JsArray(points.toVector))
              }
              complete(json(StatusCodes.OK, JsObject("series" -> JsArray(series.toVector))))
          }
        }
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import metrics.Model.Window
import metrics.Windows // Windows.seriesInRange(tenant, metric, start, end) · Windows.readWindows(tenant, metric, names, start, end)

object Read {
  val MaxRangeSeconds = 6 * 3600L
  val PageSeries = 50
  val ResolutionSeconds = 60L

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  /** Sum the 10-second windows into ResolutionSeconds buckets, oldest first. */
  def downsample(windows: Seq[Window]): Vector[JsObject] =
    windows.groupBy(w => w.start - w.start % ResolutionSeconds).toVector.sortBy(_._1).map { case (t, ws) =>
      JsObject("t" -> JsNumber(t), "count" -> JsNumber(ws.map(_.count).sum), "sum" -> JsNumber(ws.map(_.sum).sum))
    }

  val route: Route = path("v1" / "series") {
    get {
      // Never from the query: the caller does not choose its tenant.
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(json(StatusCodes.Unauthorized, JsObject("error" -> JsString("missing_tenant"))))
        case Some(tenant) =>
          parameterMap { params =>
            val range = for {
              start <- params.get("from").flatMap(_.toLongOption)
              end <- params.get("to").flatMap(_.toLongOption)
              if end > start && end - start <= MaxRangeSeconds
            } yield (start, end)
            range match {
              case None => complete(json(StatusCodes.BadRequest, JsObject("error" -> JsString("invalid_range"), "max_seconds" -> JsNumber(MaxRangeSeconds))))
              case Some((start, end)) =>
                val metric = params.getOrElse("metric", "")
                val cursor = params.getOrElse("cursor", "")
                val names = Windows.seriesInRange(tenant, metric, start, end).filter(_ > cursor)
                val page = names.take(PageSeries)
                val bySeries = Windows.readWindows(tenant, metric, page, start, end).groupBy(_.series)
                val series = page.map(name => JsObject("series" -> JsString(name), "points" -> JsArray(downsample(bySeries.getOrElse(name, Seq.empty)))))
                complete(json(StatusCodes.OK, JsObject(
                  "series" -> JsArray(series.toVector),
                  "resolution" -> JsNumber(ResolutionSeconds),
                  "method" -> JsString("sum"),
                  "next_cursor" -> (if (names.size > PageSeries) JsString(page.last) else JsNull)
                )))
            }
          }
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <map>
#include <string>
#include <vector>

#include "metrics/windows.h"  // metrics::seriesInRange(tenant, metric, start, end) · metrics::readWindows(tenant, metric, names, start, end)

using json = nlohmann::json;

void query(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.has_param("tenant") ? req.get_param_value("tenant") : req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content(R"({"error":"missing_tenant"})", "application/json");
    return;
  }
  const std::string metric = req.get_param_value("metric");
  const long long now = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  const long long start = req.has_param("from") ? std::stoll(req.get_param_value("from")) : 0LL;
  const long long end = req.has_param("to") ? std::stoll(req.get_param_value("to")) : now;
  const std::vector<std::string> names = metrics::seriesInRange(tenant, metric, start, end);
  std::map<std::string, json> points;
  for (const metrics::Window& w : metrics::readWindows(tenant, metric, names, start, end)) {
    points[w.series].push_back({{"t", w.start}, {"count", w.count}, {"sum", w.sum}});
  }
  json series = json::array();
  for (const std::string& name : names) series.push_back({{"series", name}, {"points", points.count(name) ? points[name] : json::array()}});
  res.set_content(json{{"series", series}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get("/v1/series", query); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <map>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "metrics/windows.h"  // metrics::seriesInRange(tenant, metric, start, end) · metrics::readWindows(tenant, metric, names, start, end)

using json = nlohmann::json;

constexpr long long kMaxRangeSeconds = 6 * 3600;
constexpr size_t kPageSeries = 50;
constexpr long long kResolutionSeconds = 60;

// Sum the 10-second windows into kResolutionSeconds buckets, oldest first.
json downsample(const std::vector<metrics::Window>& windows) {
  std::map<long long, std::pair<long long, double>> buckets;
  for (const metrics::Window& w : windows) {
    auto& bucket = buckets[w.start - w.start % kResolutionSeconds];
    bucket.first += w.count;
    bucket.second += w.sum;
  }
  json out = json::array();
  for (const auto& [t, bucket] : buckets) out.push_back({{"t", t}, {"count", bucket.first}, {"sum", bucket.second}});
  return out;
}

std::optional<long long> intParam(const httplib::Request& req, const std::string& name) {
  if (!req.has_param(name)) return std::nullopt;
  const std::string text = req.get_param_value(name);
  try {
    size_t used = 0;
    const long long n = std::stoll(text, &used);
    if (used == text.size()) return n;
  } catch (const std::exception&) {
  }
  return std::nullopt;
}

void query(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");  // never from the query: the caller does not choose its tenant
  if (tenant.empty()) {
    res.status = 401;
    res.set_content(R"({"error":"missing_tenant"})", "application/json");
    return;
  }
  const auto start = intParam(req, "from");
  const auto end = intParam(req, "to");
  if (!start || !end || *end <= *start || *end - *start > kMaxRangeSeconds) {
    res.status = 400;
    res.set_content(json{{"error", "invalid_range"}, {"max_seconds", kMaxRangeSeconds}}.dump(), "application/json");
    return;
  }
  const std::string metric = req.get_param_value("metric");
  const std::string cursor = req.get_param_value("cursor");
  std::vector<std::string> names;
  for (const std::string& name : metrics::seriesInRange(tenant, metric, *start, *end)) {
    if (name > cursor) names.push_back(name);
  }
  const std::vector<std::string> page(names.begin(), names.begin() + std::min(names.size(), kPageSeries));
  std::map<std::string, std::vector<metrics::Window>> bySeries;
  for (const metrics::Window& w : metrics::readWindows(tenant, metric, page, *start, *end)) bySeries[w.series].push_back(w);
  json series = json::array();
  for (const std::string& name : page) series.push_back({{"series", name}, {"points", downsample(bySeries[name])}});
  const json next = names.size() > kPageSeries ? json(page.back()) : json(nullptr);
  res.set_content(json{{"series", series}, {"resolution", kResolutionSeconds}, {"method", "sum"}, {"next_cursor", next}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get("/v1/series", query); }
`,
    },
  },
  harness: {
    python: `import time

from metrics.windows import merge_batch


def _sample(host, ts, value=1.0):
    return {"metric": "cpu_seconds", "labels": {"host": host}, "timestamp": ts, "value": value}


def _range(now, span=3600):
    return {"metric": "cpu_seconds", "from": now - span, "to": now}


async def _get(c, params, tenant="acme"):
    return await c.get("/v1/series", params=params, headers={"X-Tenant-Id": tenant} if tenant else {})


def _names(r):
    return [s["series"] for s in r.json()["series"]]


async def check_route(ctx):
    now = int(time.time())
    merge_batch("acme", "seed", [_sample("a", now - 100), _sample("a", now - 95), _sample("a", now - 40)])
    async with ctx.client(ctx.load("read").app) as c:
        r = await _get(c, _range(now))
        assert r.status_code == 200, f"GET /v1/series answered {r.status_code}: {r.text}"
        series = r.json().get("series", [])
        assert [s.get("series") for s in series] == ["cpu_seconds{host=a}"], f"the response lists {[s.get('series') for s in series]}, expected cpu_seconds{{host=a}}"
        total = sum(p["count"] for p in series[0]["points"])
        assert total == 3, f"the points of cpu_seconds{{host=a}} count {total} samples, expected 3"
        r = await _get(c, _range(now), tenant="")
    assert r.status_code == 401, f"a query without X-Tenant-Id answered {r.status_code}, expected 401"


async def check_range_cap(ctx):
    now = int(time.time())
    merge_batch("acme", "seed", [_sample("a", now - 100)])
    async with ctx.client(ctx.load("read").app) as c:
        cases = [
            ({"metric": "cpu_seconds", "to": now}, "without from"),
            ({"metric": "cpu_seconds", "from": now - 60}, "without to"),
            ({"metric": "cpu_seconds", "from": now, "to": now - 60}, "with to before from"),
            (_range(now, 7 * 3600), "spanning 7 hours"),
        ]
        for params, what in cases:
            r = await _get(c, params)
            assert r.status_code == 400 and "invalid_range" in r.text, f"a query {what} answered {r.status_code} {r.text[:120]}, expected 400 invalid_range: an open range scans every window the index holds"
        r = await _get(c, _range(now, 6 * 3600))
    assert r.status_code == 200, f"a query spanning exactly 6 hours answered {r.status_code}: {r.text}"


async def check_series_page(ctx):
    now = int(time.time())
    merge_batch("acme", "seed", [_sample(f"h{i:03d}", now - 100) for i in range(120)])
    pages, seen, cursor = [], [], None
    async with ctx.client(ctx.load("read").app) as c:
        for _ in range(5):
            r = await _get(c, {**_range(now), **({"cursor": cursor} if cursor else {})})
            assert r.status_code == 200, f"a page query answered {r.status_code}: {r.text}"
            names = _names(r)
            pages.append(len(names))
            seen += names
            cursor = r.json().get("next_cursor")
            if not cursor:
                break
    assert pages == [50, 50, 20], f"120 series came back in pages of {pages}, expected [50, 50, 20] following next_cursor: one response with every series is one scan per series"
    assert seen == sorted(set(seen)) and len(seen) == 120, "the pages must list each series once, in series order"


async def check_downsample(ctx):
    now = int(time.time())
    bucket = (now - 600) - (now - 600) % 60
    merge_batch("acme", "seed", [_sample("a", bucket + 10 * i) for i in range(6)] + [_sample("a", bucket + 60, 2.0)])
    async with ctx.client(ctx.load("read").app) as c:
        r = await _get(c, _range(now))
    body = r.json()
    points = body["series"][0]["points"]
    want = [{"t": bucket, "count": 6, "sum": 6.0}, {"t": bucket + 60, "count": 1, "sum": 2.0}]
    assert points == want, f"seven 10-second windows across two minutes came back as {points}, expected one point per 60 s: {want}"
    assert body.get("resolution") == 60 and body.get("method") == "sum", f"the body says resolution {body.get('resolution')!r} and method {body.get('method')!r}, expected 60 and sum: a chart must know what a point is"


async def check_tenant_isolation(ctx):
    now = int(time.time())
    merge_batch("acme", "seed", [_sample("a", now - 100)])
    merge_batch("globex", "seed", [_sample("g", now - 100)])
    async with ctx.client(ctx.load("read").app) as c:
        r = await _get(c, {**_range(now), "tenant": "globex"})
        assert r.status_code == 200 and _names(r) == ["cpu_seconds{host=a}"], f"acme asked with ?tenant=globex and got {r.status_code} {r.text[:160]}: the tenant comes from X-Tenant-Id, never from the query"
        r = await _get(c, {**_range(now), "tenant": "acme"}, tenant="")
    assert r.status_code == 401, f"a query with ?tenant=acme and no X-Tenant-Id answered {r.status_code}, expected 401"
`,
    typescript: `function setup(ctx) {
  return {c: ctx.client(ctx.load('read').app), windows: ctx.load('/support/metrics/windows.ts'), now: Math.floor(ctx.clock.now() / 1000)};
}

const sample = (host: string, timestamp: number, value = 1) => ({metric: 'cpu_seconds', labels: {host}, timestamp, value});

const range = (now: number, span = 3600) => ({metric: 'cpu_seconds', from: now - span, to: now});

const get = (c, query, tenant = 'acme') => c.get('/v1/series', {query, headers: tenant ? {'X-Tenant-Id': tenant} : {}});

const names = r => r.json().series.map(s => s.series);

export async function check_route(ctx) {
  const {c, windows, now} = setup(ctx);
  await windows.mergeBatch('acme', 'seed', [sample('a', now - 100), sample('a', now - 95), sample('a', now - 40)]);
  let r = await get(c, range(now));
  assert.equal(r.status, 200, \`GET /v1/series answered \${r.status}: \${r.text}\`);
  const series = r.json().series ?? [];
  assert.deepStrictEqual(series.map(s => s.series), ['cpu_seconds{host=a}'], \`the response lists \${JSON.stringify(series.map(s => s.series))}, expected cpu_seconds{host=a}\`);
  const total = series[0].points.reduce((n, p) => n + p.count, 0);
  assert.equal(total, 3, \`the points of cpu_seconds{host=a} count \${total} samples, expected 3\`);
  r = await get(c, range(now), '');
  assert.equal(r.status, 401, \`a query without X-Tenant-Id answered \${r.status}, expected 401\`);
}

export async function check_range_cap(ctx) {
  const {c, windows, now} = setup(ctx);
  await windows.mergeBatch('acme', 'seed', [sample('a', now - 100)]);
  const cases: [Record<string, string | number>, string][] = [
    [{metric: 'cpu_seconds', to: now}, 'without from'],
    [{metric: 'cpu_seconds', from: now - 60}, 'without to'],
    [{metric: 'cpu_seconds', from: now, to: now - 60}, 'with to before from'],
    [range(now, 7 * 3600), 'spanning 7 hours'],
  ];
  for (const [query, what] of cases) {
    const r = await get(c, query);
    assert(r.status === 400 && r.text.includes('invalid_range'), \`a query \${what} answered \${r.status} \${r.text.slice(0, 120)}, expected 400 invalid_range: an open range scans every window the index holds\`);
  }
  const r = await get(c, range(now, 6 * 3600));
  assert.equal(r.status, 200, \`a query spanning exactly 6 hours answered \${r.status}: \${r.text}\`);
}

export async function check_series_page(ctx) {
  const {c, windows, now} = setup(ctx);
  await windows.mergeBatch('acme', 'seed', Array.from({length: 120}, (_, i) => sample(\`h\${String(i).padStart(3, '0')}\`, now - 100)));
  const pages: number[] = [];
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 5; i += 1) {
    const r = await get(c, {...range(now), ...(cursor ? {cursor} : {})});
    assert.equal(r.status, 200, \`a page query answered \${r.status}: \${r.text}\`);
    const page = names(r);
    pages.push(page.length);
    seen.push(...page);
    cursor = r.json().next_cursor ?? null;
    if (!cursor) break;
  }
  assert.deepStrictEqual(pages, [50, 50, 20], \`120 series came back in pages of \${JSON.stringify(pages)}, expected [50, 50, 20] following next_cursor: one response with every series is one scan per series\`);
  assert.deepStrictEqual(seen, [...new Set(seen)].sort(), 'the pages must list each series once, in series order');
  assert.equal(seen.length, 120, 'the pages must list all 120 series');
}

export async function check_downsample(ctx) {
  const {c, windows, now} = setup(ctx);
  const bucket = now - 600 - ((now - 600) % 60);
  await windows.mergeBatch('acme', 'seed', [...Array.from({length: 6}, (_, i) => sample('a', bucket + 10 * i)), sample('a', bucket + 60, 2)]);
  const body = (await get(c, range(now))).json();
  const points = body.series[0].points;
  const want = [{t: bucket, count: 6, sum: 6}, {t: bucket + 60, count: 1, sum: 2}];
  assert.deepStrictEqual(points, want, \`seven 10-second windows across two minutes came back as \${JSON.stringify(points)}, expected one point per 60 s: \${JSON.stringify(want)}\`);
  assert(body.resolution === 60 && body.method === 'sum', \`the body says resolution \${JSON.stringify(body.resolution)} and method \${JSON.stringify(body.method)}, expected 60 and sum: a chart must know what a point is\`);
}

export async function check_tenant_isolation(ctx) {
  const {c, windows, now} = setup(ctx);
  await windows.mergeBatch('acme', 'seed', [sample('a', now - 100)]);
  await windows.mergeBatch('globex', 'seed', [sample('g', now - 100)]);
  let r = await get(c, {...range(now), tenant: 'globex'});
  assert(r.status === 200 && JSON.stringify(names(r)) === JSON.stringify(['cpu_seconds{host=a}']), \`acme asked with ?tenant=globex and got \${r.status} \${r.text.slice(0, 160)}: the tenant comes from X-Tenant-Id, never from the query\`);
  r = await get(c, {...range(now), tenant: 'acme'}, '');
  assert.equal(r.status, 401, \`a query with ?tenant=acme and no X-Tenant-Id answered \${r.status}, expected 401\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"metrics/model"
	"metrics/windows"

	"leetbuild/harness"
)

type readBody struct {
	Series []struct {
		Series string           \`json:"series"\`
		Points []map[string]any \`json:"points"\`
	} \`json:"series"\`
	Resolution any     \`json:"resolution"\`
	Method     any     \`json:"method"\`
	NextCursor *string \`json:"next_cursor"\`
}

func readClient(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func readSeed(ctx *harness.Ctx, tenant string, samples ...model.Sample) {
	_, err := windows.MergeBatch(context.Background(), tenant, "seed", samples)
	ctx.NoError(err, "seeding the windows")
}

func readSample(host string, ts int64, value float64) model.Sample {
	return model.Sample{Metric: "cpu_seconds", Labels: map[string]string{"host": host}, Timestamp: ts, Value: value}
}

func readGet(c *harness.HTTP, params url.Values, tenant string) *harness.Response {
	path := "/v1/series?" + params.Encode()
	if tenant == "" {
		return c.Get(path)
	}
	return c.Get(path, "X-Tenant-Id", tenant)
}

func readRange(now, span int64) url.Values {
	return url.Values{"metric": {"cpu_seconds"}, "from": {fmt.Sprint(now - span)}, "to": {fmt.Sprint(now)}}
}

func readNames(r *harness.Response) []string {
	var body readBody
	r.Decode(&body)
	out := []string{}
	for _, s := range body.Series {
		out = append(out, s.Series)
	}
	return out
}

func CheckRoute(ctx *harness.Ctx) {
	now := ctx.Clock.Now() / 1000
	readSeed(ctx, "acme", readSample("a", now-100, 1), readSample("a", now-95, 1), readSample("a", now-40, 1))
	c := readClient(ctx)
	r := readGet(c, readRange(now, 3600), "acme")
	ctx.Equal(r.Status, 200, "GET /v1/series (%s)", r.Text())
	var body readBody
	r.Decode(&body)
	ctx.Equal(readNames(r), []string{"cpu_seconds{host=a}"}, "the series listed")
	total := 0.0
	for _, p := range body.Series[0].Points {
		n, _ := p["count"].(float64)
		total += n
	}
	ctx.Equal(total, 3, "the samples counted by the points of cpu_seconds{host=a}")
	r = readGet(c, readRange(now, 3600), "")
	ctx.Equal(r.Status, 401, "a query without X-Tenant-Id")
}

func CheckRangeCap(ctx *harness.Ctx) {
	now := ctx.Clock.Now() / 1000
	readSeed(ctx, "acme", readSample("a", now-100, 1))
	c := readClient(ctx)
	cases := []struct {
		params url.Values
		what   string
	}{
		{url.Values{"metric": {"cpu_seconds"}, "to": {fmt.Sprint(now)}}, "without from"},
		{url.Values{"metric": {"cpu_seconds"}, "from": {fmt.Sprint(now - 60)}}, "without to"},
		{url.Values{"metric": {"cpu_seconds"}, "from": {fmt.Sprint(now)}, "to": {fmt.Sprint(now - 60)}}, "with to before from"},
		{readRange(now, 7*3600), "spanning 7 hours"},
	}
	for _, tc := range cases {
		r := readGet(c, tc.params, "acme")
		ctx.Assert(r.Status == 400 && strings.Contains(r.Text(), "invalid_range"), "a query %s answered %d %.120s, expected 400 invalid_range: an open range scans every window the index holds", tc.what, r.Status, r.Text())
	}
	r := readGet(c, readRange(now, 6*3600), "acme")
	ctx.Equal(r.Status, 200, "a query spanning exactly 6 hours (%s)", r.Text())
}

func CheckSeriesPage(ctx *harness.Ctx) {
	now := ctx.Clock.Now() / 1000
	samples := []model.Sample{}
	for i := 0; i < 120; i++ {
		samples = append(samples, readSample(fmt.Sprintf("h%03d", i), now-100, 1))
	}
	readSeed(ctx, "acme", samples...)
	c := readClient(ctx)
	pages := []int{}
	seen := []string{}
	cursor := ""
	for i := 0; i < 5; i++ {
		params := readRange(now, 3600)
		if cursor != "" {
			params.Set("cursor", cursor)
		}
		r := readGet(c, params, "acme")
		ctx.Equal(r.Status, 200, "a page query (%s)", r.Text())
		var body readBody
		r.Decode(&body)
		pages = append(pages, len(body.Series))
		for _, s := range body.Series {
			seen = append(seen, s.Series)
		}
		if body.NextCursor == nil || *body.NextCursor == "" {
			break
		}
		cursor = *body.NextCursor
	}
	ctx.Equal(pages, []int{50, 50, 20}, "120 series must come back in pages of 50 following next_cursor (one response with every series is one scan per series); the page sizes")
	for i := 1; i < len(seen); i++ {
		ctx.Assert(seen[i-1] < seen[i], "the pages must list each series once, in series order: %s came before %s", seen[i-1], seen[i])
	}
}

func CheckDownsample(ctx *harness.Ctx) {
	now := ctx.Clock.Now() / 1000
	bucket := (now - 600) - (now-600)%60
	samples := []model.Sample{}
	for i := int64(0); i < 6; i++ {
		samples = append(samples, readSample("a", bucket+10*i, 1))
	}
	readSeed(ctx, "acme", append(samples, readSample("a", bucket+60, 2))...)
	r := readGet(readClient(ctx), readRange(now, 3600), "acme")
	var body readBody
	r.Decode(&body)
	ctx.Assert(len(body.Series) == 1, "the query must list one series, got %s", r.Text())
	want := []map[string]any{{"t": bucket, "count": 6, "sum": 6}, {"t": bucket + 60, "count": 1, "sum": 2}}
	ctx.Equal(body.Series[0].Points, want, "seven 10-second windows across two minutes must come back as one point per 60 s; the points")
	ctx.Assert(fmt.Sprint(body.Resolution) == "60" && body.Method == "sum", "the body says resolution %v and method %v, expected 60 and sum: a chart must know what a point is", body.Resolution, body.Method)
}

func CheckTenantIsolation(ctx *harness.Ctx) {
	now := ctx.Clock.Now() / 1000
	readSeed(ctx, "acme", readSample("a", now-100, 1))
	readSeed(ctx, "globex", readSample("g", now-100, 1))
	c := readClient(ctx)
	params := readRange(now, 3600)
	params.Set("tenant", "globex")
	r := readGet(c, params, "acme")
	ctx.Assert(r.Status == 200 && strings.Join(readNames(r), ",") == "cpu_seconds{host=a}", "acme asked with ?tenant=globex and got %d %.160s: the tenant comes from X-Tenant-Id, never from the query", r.Status, r.Text())
	params.Set("tenant", "acme")
	r = readGet(c, params, "")
	ctx.Equal(r.Status, 401, "a query with ?tenant=acme and no X-Tenant-Id")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <cctype>
#include <cstdio>
#include <map>
#include <string>
#include <utility>
#include <vector>

#include "metrics/model.h"
#include "metrics/windows.h"

namespace {

using Params = std::vector<std::pair<std::string, std::string>>;

harness::HTTP readClient(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

metrics::Sample readSample(const std::string& host, long long ts, double value = 1) { return metrics::Sample{"cpu_seconds", {{"host", host}}, ts, value}; }

std::string escape(const std::string& text) {
  std::string out;
  for (unsigned char c : text) {
    if (std::isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') {
      out += static_cast<char>(c);
    } else {
      char hex[4];
      std::snprintf(hex, sizeof hex, "%%%02X", c);
      out += hex;
    }
  }
  return out;
}

harness::Response readGet(harness::HTTP& c, const Params& params, const std::string& tenant = "acme") {
  std::string path = "/v1/series?";
  for (const auto& [k, v] : params) path += k + "=" + escape(v) + "&";
  if (tenant.empty()) return c.Get(path);
  return c.Get(path, "X-Tenant-Id", tenant);
}

Params readRange(long long now, long long span = 3600) {
  return {{"metric", "cpu_seconds"}, {"from", std::to_string(now - span)}, {"to", std::to_string(now)}};
}

nlohmann::json body(const harness::Response& r) { return nlohmann::json::parse(r.Text(), nullptr, false); }

std::vector<std::string> readNames(const harness::Response& r) {
  std::vector<std::string> out;
  const auto b = body(r);
  if (b.is_object() && b.contains("series")) {
    for (const auto& s : b["series"]) out.push_back(s.value("series", ""));
  }
  return out;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  const long long now = ctx.Clock.Now() / 1000;
  metrics::mergeBatch("acme", "seed", {readSample("a", now - 100), readSample("a", now - 95), readSample("a", now - 40)});
  auto c = readClient(ctx);
  auto r = readGet(c, readRange(now));
  ctx.Equal(r.Status, 200, "GET /v1/series (%s)", r.Text());
  ctx.Equal(readNames(r), std::vector<std::string>{"cpu_seconds{host=a}"}, "the series listed");
  long long total = 0;
  const auto listed = body(r);
  for (const auto& p : listed["series"][0]["points"]) total += p.value("count", 0LL);
  ctx.Equal(total, 3, "the samples counted by the points of cpu_seconds{host=a}");
  r = readGet(c, readRange(now), "");
  ctx.Equal(r.Status, 401, "a query without X-Tenant-Id");
}

void CheckRangeCap(harness::Ctx& ctx) {
  const long long now = ctx.Clock.Now() / 1000;
  metrics::mergeBatch("acme", "seed", {readSample("a", now - 100)});
  auto c = readClient(ctx);
  const std::vector<std::pair<Params, std::string>> cases = {
      {{{"metric", "cpu_seconds"}, {"to", std::to_string(now)}}, "without from"},
      {{{"metric", "cpu_seconds"}, {"from", std::to_string(now - 60)}}, "without to"},
      {{{"metric", "cpu_seconds"}, {"from", std::to_string(now)}, {"to", std::to_string(now - 60)}}, "with to before from"},
      {readRange(now, 7 * 3600), "spanning 7 hours"},
  };
  for (const auto& [params, what] : cases) {
    const auto r = readGet(c, params);
    ctx.Assert(r.Status == 400 && r.Text().find("invalid_range") != std::string::npos, "a query %s answered %d %s, expected 400 invalid_range: an open range scans every window the index holds", what, r.Status, r.Text().substr(0, 120));
  }
  const auto r = readGet(c, readRange(now, 6 * 3600));
  ctx.Equal(r.Status, 200, "a query spanning exactly 6 hours (%s)", r.Text());
}

void CheckSeriesPage(harness::Ctx& ctx) {
  const long long now = ctx.Clock.Now() / 1000;
  std::vector<metrics::Sample> samples;
  for (int i = 0; i < 120; i++) {
    char host[8];
    std::snprintf(host, sizeof host, "h%03d", i);
    samples.push_back(readSample(host, now - 100));
  }
  metrics::mergeBatch("acme", "seed", samples);
  auto c = readClient(ctx);
  std::vector<int> pages;
  std::vector<std::string> seen;
  std::string cursor;
  for (int i = 0; i < 5; i++) {
    Params params = readRange(now);
    if (!cursor.empty()) params.push_back({"cursor", cursor});
    const auto r = readGet(c, params);
    ctx.Equal(r.Status, 200, "a page query (%s)", r.Text());
    const auto names = readNames(r);
    pages.push_back(static_cast<int>(names.size()));
    seen.insert(seen.end(), names.begin(), names.end());
    const auto b = body(r);
    if (!b.contains("next_cursor") || !b["next_cursor"].is_string() || b["next_cursor"].get<std::string>().empty()) break;
    cursor = b["next_cursor"].get<std::string>();
  }
  ctx.Equal(pages, {50, 50, 20}, "120 series must come back in pages of 50 following next_cursor (one response with every series is one scan per series); the page sizes");
  for (size_t i = 1; i < seen.size(); i++) {
    ctx.Assert(seen[i - 1] < seen[i], "the pages must list each series once, in series order: %s came before %s", seen[i - 1], seen[i]);
  }
}

void CheckDownsample(harness::Ctx& ctx) {
  const long long now = ctx.Clock.Now() / 1000;
  const long long bucket = (now - 600) - (now - 600) % 60;
  std::vector<metrics::Sample> samples;
  for (int i = 0; i < 6; i++) samples.push_back(readSample("a", bucket + 10 * i));
  samples.push_back(readSample("a", bucket + 60, 2));
  metrics::mergeBatch("acme", "seed", samples);
  auto c = readClient(ctx);
  const auto r = readGet(c, readRange(now));
  const auto b = body(r);
  ctx.Assert(b.is_object() && b.contains("series") && b["series"].size() == 1, "the query must list one series, got %s", r.Text());
  const auto points = b["series"][0]["points"];
  const nlohmann::json want = nlohmann::json::array({{{"t", bucket}, {"count", 6}, {"sum", 6.0}}, {{"t", bucket + 60}, {"count", 1}, {"sum", 2.0}}});
  ctx.Assert(points == want, "seven 10-second windows across two minutes came back as %s, expected one point per 60 s: %s", points.dump(), want.dump());
  ctx.Assert(b.value("resolution", 0) == 60 && b.value("method", "") == "sum", "the body says resolution %s and method %s, expected 60 and sum: a chart must know what a point is",
             b.contains("resolution") ? b["resolution"].dump() : "none", b.contains("method") ? b["method"].dump() : "none");
}

void CheckTenantIsolation(harness::Ctx& ctx) {
  const long long now = ctx.Clock.Now() / 1000;
  metrics::mergeBatch("acme", "seed", {readSample("a", now - 100)});
  metrics::mergeBatch("globex", "seed", {readSample("g", now - 100)});
  auto c = readClient(ctx);
  Params params = readRange(now);
  params.push_back({"tenant", "globex"});
  auto r = readGet(c, params);
  ctx.Assert(r.Status == 200 && readNames(r) == std::vector<std::string>{"cpu_seconds{host=a}"}, "acme asked with ?tenant=globex and got %d %s: the tenant comes from X-Tenant-Id, never from the query", r.Status, r.Text().substr(0, 160));
  params.back().second = "acme";
  r = readGet(c, params, "");
  ctx.Equal(r.Status, 401, "a query with ?tenant=acme and no X-Tenant-Id");
}
`,
  },
  hints: [
    "Ask for a metric with no `from`, or one with two thousand series: the response is huge and slow. Add `?tenant=` with another tenant name and you read that tenant's chart.",
    'The handler fills a missing bound instead of refusing it, hands every series to `read_windows`, copies each 10-second window into a point, and lets the query string pick the tenant.',
    'Tenant from `X-Tenant-Id` only; 400 `invalid_range` unless `from < to <= from + MAX_RANGE_SECONDS`; take the first `PAGE_SERIES` names after `cursor` and set `next_cursor`; sum windows into `t = start - start % 60` buckets; add `resolution` and `method`.',
  ],
  debrief: `Every bound here is a bound on work: the range caps how many windows the index returns, the page caps how many series are read, the resolution caps how many points travel, and they multiply, so dropping any one of them lets a single dashboard panel cost what thousands should. The cursor is the last series of the page rather than an offset, so a series created between two pages does not shift the next one. The tenant comes from the authenticated header because a query parameter is the caller's choice, and reading another tenant's series is the leak. Production query layers also choose the resolution from the range instead of fixing it, cache the closed buckets, and cap total samples per query as the final guard.`,
};
