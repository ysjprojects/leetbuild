import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/series: queries bounded in both axes',
  concept: 'http',
  file: 'read',
  focus: ['client', 'query', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the series route,
reads the points and answers, so the dashboard draws. It compiles, the demo passes, and it hides four
production flaws — each one a way for a single refresh to read years of every tenant's data. Review it
like the service owner, fix it, and prove the fix with the checks below.

Implement \`GET /v1/series?series=…&from=…&to=…&cursor=…&limit=…\`:

- The caller's tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is
  **401**.
- \`from\` and \`to\` are **required** epoch seconds and \`to\` must be after \`from\` (**400**
  otherwise). The window may span at most **7 days** (\`MAX_RANGE_DAYS\`): a wider range — and a
  missing \`from\`, which is an open lower bound — is **400**, and the cap must be enforced **before**
  the store is called. An open-ended range that reaches the store is a scan of the whole retention,
  and every dashboard refresh repeats it.
- A query may name at most **50 series** (\`MAX_SERIES\`); a longer list is **400** before the store
  is touched, so one query can never multiply a scan by an unbounded number of series.
- Every name is resolved against its **owner tenant**: a series whose tenant differs from the
  caller's is **404**, exactly like a name that does not exist, so the endpoint is not an oracle for
  other tenants' metrics.
- Points are **downsampled** to at most one per **10 seconds** (\`RESOLUTION_SECONDS\`) per series,
  and the method is named in the response
  (\`"downsample": {"method": "max", "bucket_seconds": 10}\`). Raw full-resolution points are never
  returned, whatever the range.
- The page is explicit: the request takes \`limit\` and an opaque \`cursor\`, and the response carries
  the next \`cursor\` when a page fills, instead of silently truncating the series.

**Failure mode the checks target.** The draft passes an open lower bound and a far-future \`to\`
straight to the store, so one refresh reads the entire retention; it returns every raw point at full
resolution forever, so a chatty series is hundreds of thousands of rows per call; and it answers for
any series name in any tenant, which turns the query API into an enumeration oracle over everyone's
metrics.`,
  sequence: {
    participants: ['Dashboard', 'Query API', 'Redis', 'Series store'],
    messages: [
      {
        from: 'Dashboard',
        to: 'Query API',
        label: 'GET /v1/series?series=a,b&from&to&cursor&limit · X-Tenant-Id',
        kind: 'sync',
      },
      {from: 'Query API', to: 'Query API', label: '400 when the range exceeds 7 days or >50 series', kind: 'sync'},
      {from: 'Query API', to: 'Series store', label: 'owner(name) per series · foreign name → 404', kind: 'sync'},
      {from: 'Series store', to: 'Query API', label: 'owner rows / 404 for another tenant', kind: 'reply'},
      {from: 'Query API', to: 'Redis', label: 'one bounded page per series · cursor', kind: 'sync'},
      {from: 'Redis', to: 'Query API', label: 'raw points', kind: 'reply'},
      {from: 'Query API', to: 'Query API', label: 'max over RESOLUTION_SECONDS buckets, method named', kind: 'sync'},
      {
        from: 'Query API',
        to: 'Dashboard',
        label: '200 {resolution_seconds, downsample{method}, series[], cursor}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'range-cap',
      title: 'Caps the range at 7 days with 400',
      detail:
        'Both bounds are required, `to` must be after `from`, and the window may span at most **7 days** (`MAX_RANGE_DAYS`); a longer range — or a missing `from`, an open lower bound — is **400** before the store runs. The draft passes an open bound and a far-future `to` straight through, so one request scans the whole retention.',
      match: {
        python: {
          all: [/@app\.get\(\s*["']\/v1\/series["']/, /MAX_RANGE_DAYS\s*=\s*7/, /status_code\s*=\s*400/],
          order: [/MAX_RANGE_DAYS/, /store\.query\(/],
        },
        typescript: {
          all: [/app\.get\(\s*['"]\/v1\/series['"]/, /MAX_RANGE_DAYS\s*=\s*7/, /code\(\s*400\s*\)/],
          order: [/MAX_RANGE_DAYS/, /store\.query\(/],
        },
        go: {
          all: [/HandleFunc\(\s*"GET \/v1\/series"/, /maxRangeDays\s*=\s*7/, /StatusBadRequest/],
          order: [/maxRangeDays/, /store\.Query\(/],
        },
        scala: {
          all: [/path\(\s*"v1"\s*\/\s*"series"\s*\)/, /\bget\s*\{/, /MaxRangeDays\s*=\s*7/, /StatusCodes\.BadRequest/],
          order: [/MaxRangeDays/, /store\.query\(/],
        },
        cpp: {
          all: [/svr\.Get\(\s*"\/v1\/series"/, /kMaxRangeDays\s*=\s*7/, /\b400\b/],
          order: [/kMaxRangeDays/, /store\.query\(/],
        },
      },
    },
    {
      id: 'series-cap',
      title: 'Caps a query at 50 series',
      detail:
        'At most **50 series** (`MAX_SERIES`) may be named in one query; a longer list is **400** before the store is touched. The draft accepts any number of names, so a scan of one series is multiplied by an unbounded list.',
      match: {
        python: {all: [/MAX_SERIES\s*=\s*50/, /len\(names\)\s*>\s*MAX_SERIES/, /status_code\s*=\s*400/]},
        typescript: {all: [/MAX_SERIES\s*=\s*50/, /names\.length\s*>\s*MAX_SERIES/, /code\(\s*400\s*\)/]},
        go: {all: [/maxSeries\s*=\s*50/, /len\(names\)\s*>\s*maxSeries/, /StatusBadRequest/]},
        scala: {all: [/MaxSeries\s*=\s*50/, /names\.size\s*>\s*MaxSeries/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kMaxSeries\s*=\s*50/, /names\.size\(\)\s*>\s*kMaxSeries/, /\b400\b/]},
      },
    },
    {
      id: 'downsample',
      title: 'Downsamples to 10-second buckets and names the method',
      detail:
        'Points are aggregated to at most one per **10 seconds** (`RESOLUTION_SECONDS`) per series and the method is named in the response (`"downsample": {"method": "max"}`). The draft returns raw points at full resolution, so a chatty series is hundreds of thousands of rows per call.',
      match: {
        python: {all: [/RESOLUTION_SECONDS\s*=\s*10/, /downsample_max\(/, /"method":\s*"max"/]},
        typescript: {all: [/RESOLUTION_SECONDS\s*=\s*10/, /downsampleMax\(/, /method:\s*'max'/]},
        go: {all: [/resolutionSeconds\s*=\s*10/, /downsampleMax\(/, /"method":\s*"max"/]},
        scala: {all: [/ResolutionSeconds\s*=\s*10/, /downsampleMax\(/, /"method"\s*->\s*"max"/]},
        cpp: {all: [/kResolutionSeconds\s*=\s*10/, /downsampleMax\(/, /"method",\s*"max"/]},
      },
    },
    {
      id: 'cursor-pagination',
      title: 'Pages with a limit and a cursor',
      detail:
        'The request takes a `limit` and an opaque `cursor`, and the response carries the next `cursor` when a page fills. The draft returns everything it read at once, so a long series either truncates silently or arrives whole.',
      match: {
        python: {all: [/cursor/, /limit/, /"cursor":/]},
        typescript: {all: [/cursor/, /limit/, /cursor:/]},
        go: {all: [/cursor/, /limit/, /"cursor":/]},
        scala: {all: [/cursor/, /limit/, /"cursor"\s*->/]},
        cpp: {all: [/cursor/, /limit/, /"cursor"/]},
      },
    },
    {
      id: 'tenant-isolation',
      title: 'A foreign tenant series is 404',
      detail:
        "Each name is resolved with `owner(name)` and its tenant compared with the caller's `X-Tenant-Id`; a mismatch answers **404**, exactly like an unknown name. The draft serves any tenant's series by name, so the query API doubles as an existence oracle.",
      match: {
        python: {all: [/X-Tenant-Id/, /owner/, /status_code\s*=\s*404/]},
        typescript: {all: [/x-tenant-id/, /owner/, /code\(\s*404\s*\)/]},
        go: {all: [/X-Tenant-Id/, /\.Owner\(/, /StatusNotFound/]},
        scala: {all: [/X-Tenant-Id/, /\.owner\(/, /StatusCodes\.NotFound/]},
        cpp: {all: [/X-Tenant-Id/, /store\.owner\(/, /\b404\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""GET /v1/series: a model-generated draft with an open-ended range."""
from fastapi import FastAPI

app = FastAPI()


class SeriesStore:
    def query(self, names: list[str], from_s: int, to_s: int) -> dict[str, list[dict]]:
        """Raw points per series, oldest first, at full resolution."""
        raise NotImplementedError


store = SeriesStore()


@app.get("/v1/series")
def series(series: str, to_s: int | None = None) -> dict:
    # TODO: this draft takes an open lower bound and a far-future to, returns raw points at full
    # resolution, and serves any tenant's series by name. Bound the range and the series list,
    # downsample to 10 s buckets, page with a cursor and 404 a series the caller does not own.
    names = series.split(",")
    points = store.query(names, 0, to_s or 4_102_444_800)
    return {"series": names, "points": points}
`,
      solution: `"""GET /v1/series: bounded axes, 10 s buckets, a cursor and an owner check."""
from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse

app = FastAPI()

MAX_RANGE_DAYS = 7
MAX_SERIES = 50
RESOLUTION_SECONDS = 10
DEFAULT_PAGE = 1000


class SeriesStore:
    def owner(self, name: str) -> dict | None:
        """The series row: {"name", "tenant"}, or None when the name is unknown."""
        raise NotImplementedError

    def query(
        self,
        tenant: str,
        names: list[str],
        from_s: int,
        to_s: int,
        cursor: str | None,
        limit: int,
    ) -> dict:
        """One page of raw points per series, oldest first, plus the next cursor."""
        raise NotImplementedError


store = SeriesStore()


def downsample_max(points: list[dict], resolution_s: int) -> list[dict]:
    """One point per resolution_s seconds: the max of each bucket, so peaks survive."""
    buckets: dict[int, dict] = {}
    for point in points:
        start = point["ts"] // resolution_s * resolution_s
        current = buckets.get(start)
        if current is None or point["value"] > current["value"]:
            buckets[start] = {"ts": start, "value": point["value"]}
    return [buckets[start] for start in sorted(buckets)]


@app.get("/v1/series")
def series(
    series: str,
    from_s: int,
    to_s: int,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    cursor: str | None = None,
    limit: int = DEFAULT_PAGE,
) -> JSONResponse:
    if tenant is None or tenant == "":
        return JSONResponse({"error": "missing X-Tenant-Id"}, status_code=401)
    names = [name for name in series.split(",") if name]
    if to_s <= from_s:
        return JSONResponse({"error": "to must be after from"}, status_code=400)
    if to_s - from_s > MAX_RANGE_DAYS * 86_400:
        # The cap runs before the store is touched: an open lower bound is a scan of years.
        return JSONResponse({"error": "range exceeds 7 days"}, status_code=400)
    if len(names) > MAX_SERIES:
        return JSONResponse({"error": f"at most {MAX_SERIES} series per query"}, status_code=400)
    for name in names:
        owner = store.owner(name)
        if owner is None or owner["tenant"] != tenant:
            # An unknown name and another tenant's series are the same answer: 404.
            return JSONResponse({"error": "unknown series"}, status_code=404)
    page = store.query(tenant, names, from_s, to_s, cursor, limit)
    body = {
        "from": from_s,
        "to": to_s,
        "resolution_seconds": RESOLUTION_SECONDS,
        "downsample": {"method": "max", "bucket_seconds": RESOLUTION_SECONDS},
        "series": [
            {"name": name, "points": downsample_max(page["points"][name], RESOLUTION_SECONDS)}
            for name in names
        ],
        "cursor": page["cursor"],
    }
    return JSONResponse(body, status_code=200)
`,
    },
    typescript: {
      starter: `/** GET /v1/series: a model-generated draft with an open-ended range. */
import Fastify from 'fastify';

export const app = Fastify();

interface Point {
  ts: number;
  value: number;
}

export interface SeriesStore {
  query(names: string[], fromS: number, toS: number): Promise<Record<string, Point[]>>;
}

declare const store: SeriesStore;

app.get('/v1/series', async (request, reply) => {
  // TODO: this draft takes an open lower bound and a far-future to, returns raw points at full
  // resolution, and serves any tenant's series by name. Bound the range and the series list,
  // downsample to 10 s buckets, page with a cursor and 404 a series the caller does not own.
  const query = request.query as {series?: string; to?: string};
  const names = (query.series ?? '').split(',').filter(Boolean);
  const toS = Number(query.to ?? 4102444800);
  const points = await store.query(names, 0, toS);
  return reply.code(200).send({series: names, points});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/series: bounded axes, 10 s buckets, a cursor and an owner check. */
import Fastify from 'fastify';

export const app = Fastify();

const MAX_RANGE_DAYS = 7;
const MAX_SERIES = 50;
const RESOLUTION_SECONDS = 10;
const DEFAULT_PAGE = 1000;

interface Point {
  ts: number;
  value: number;
}

interface SeriesRow {
  name: string;
  tenant: string;
}

interface Page {
  points: Record<string, Point[]>;
  cursor: string | null;
}

export interface SeriesStore {
  owner(name: string): Promise<SeriesRow | null>;
  query(
    tenant: string,
    names: string[],
    fromS: number,
    toS: number,
    cursor: string | null,
    limit: number,
  ): Promise<Page>;
}

declare const store: SeriesStore;

function downsampleMax(points: Point[], resolutionS: number): Point[] {
  const buckets = new Map<number, Point>();
  for (const point of points) {
    const start = Math.floor(point.ts / resolutionS) * resolutionS;
    const current = buckets.get(start);
    if (current === undefined || point.value > current.value) buckets.set(start, {ts: start, value: point.value});
  }
  return [...buckets.values()].sort((a, b) => a.ts - b.ts);
}

app.get('/v1/series', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const query = request.query as {series?: string; from?: string; to?: string; cursor?: string; limit?: string};
  const names = (query.series ?? '').split(',').filter(Boolean);
  const fromS = Number(query.from);
  const toS = Number(query.to);
  if (!Number.isFinite(fromS) || !Number.isFinite(toS) || toS <= fromS)
    return reply.code(400).send({error: 'from and to are required and to must be after from'});
  if (toS - fromS > MAX_RANGE_DAYS * 86_400) return reply.code(400).send({error: 'range exceeds 7 days'});
  if (names.length > MAX_SERIES) return reply.code(400).send({error: 'too many series'});
  for (const name of names) {
    const owner = await store.owner(name);
    if (owner === null || owner.tenant !== tenant) return reply.code(404).send({error: 'unknown series'});
  }
  const limit = query.limit === undefined ? DEFAULT_PAGE : Number(query.limit);
  const page = await store.query(tenant, names, fromS, toS, query.cursor ?? null, limit);
  return reply.code(200).send({
    from: fromS,
    to: toS,
    resolution_seconds: RESOLUTION_SECONDS,
    downsample: {method: 'max', bucket_seconds: RESOLUTION_SECONDS},
    series: names.map(name => ({
      name,
      points: downsampleMax(page.points[name] ?? [], RESOLUTION_SECONDS),
    })),
    cursor: page.cursor,
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package read

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
)

type Point struct {
	TS    int64   \`json:"ts"\`
	Value float64 \`json:"value"\`
}

type Store interface {
	Query(ctx context.Context, names []string, fromS, toS int64) (map[string][]Point, error)
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func Series(store Store) http.HandlerFunc {
	return func(rw http.ResponseWriter, r *http.Request) {
		// TODO: this draft takes an open lower bound and a far-future to, returns raw points at
		// full resolution, and serves any tenant's series by name. Bound the range and the series
		// list, downsample to 10 s buckets, page with a cursor and 404 a series the caller does
		// not own.
		names := strings.Split(r.URL.Query().Get("series"), ",")
		toS, _ := strconv.ParseInt(r.URL.Query().Get("to"), 10, 64)
		if toS == 0 {
			toS = 4102444800
		}
		points, err := store.Query(r.Context(), names, 0, toS)
		if err != nil {
			writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
			return
		}
		writeJSON(rw, http.StatusOK, map[string]any{"series": names, "points": points})
	}
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/series", Series(nil))
	_ = http.ListenAndServe(":8443", mux)
}
`,
      solution: `package read

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"
)

const (
	maxRangeDays      = 7
	maxSeries         = 50
	resolutionSeconds = 10
	defaultPage       = 1000
)

type Point struct {
	TS    int64   \`json:"ts"\`
	Value float64 \`json:"value"\`
}

type SeriesRow struct {
	Name   string \`json:"name"\`
	Tenant string \`json:"tenant"\`
}

type Page struct {
	Points map[string][]Point \`json:"points"\`
	Cursor string             \`json:"cursor"\`
}

type Store interface {
	Owner(ctx context.Context, name string) (*SeriesRow, error)
	Query(ctx context.Context, tenant string, names []string, fromS, toS int64, cursor string, limit int) (Page, error)
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func downsampleMax(points []Point, resolutionS int64) []Point {
	buckets := map[int64]Point{}
	for _, point := range points {
		start := point.TS / resolutionS * resolutionS
		current, ok := buckets[start]
		if !ok || point.Value > current.Value {
			buckets[start] = Point{TS: start, Value: point.Value}
		}
	}
	out := make([]Point, 0, len(buckets))
	for _, point := range buckets {
		out = append(out, point)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].TS < out[j].TS })
	return out
}

func Series(store Store) http.HandlerFunc {
	return func(rw http.ResponseWriter, r *http.Request) {
		tenant := r.Header.Get("X-Tenant-Id")
		if tenant == "" {
			writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
			return
		}
		query := r.URL.Query()
		names := []string{}
		for _, name := range strings.Split(query.Get("series"), ",") {
			if name != "" {
				names = append(names, name)
			}
		}
		fromS, errFrom := strconv.ParseInt(query.Get("from"), 10, 64)
		toS, errTo := strconv.ParseInt(query.Get("to"), 10, 64)
		if errFrom != nil || errTo != nil || toS <= fromS {
			writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "from and to are required and to must be after from"})
			return
		}
		if toS-fromS > maxRangeDays*86_400 {
			// The cap runs before the store is touched: an open lower bound is a scan of years.
			writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "range exceeds 7 days"})
			return
		}
		if len(names) > maxSeries {
			writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "too many series"})
			return
		}
		for _, name := range names {
			owner, err := store.Owner(r.Context(), name)
			if err != nil || owner == nil || owner.Tenant != tenant {
				// An unknown name and another tenant's series are the same answer: 404.
				writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown series"})
				return
			}
		}
		limit := defaultPage
		if raw := query.Get("limit"); raw != "" {
			parsed, err := strconv.Atoi(raw)
			if err != nil || parsed < 1 || parsed > 5000 {
				writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "limit must be 1..5000"})
				return
			}
			limit = parsed
		}
		cursor := query.Get("cursor")
		page, err := store.Query(r.Context(), tenant, names, fromS, toS, cursor, limit)
		if err != nil {
			writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
			return
		}
		series := make([]map[string]any, 0, len(names))
		for _, name := range names {
			series = append(series, map[string]any{
				"name":   name,
				"points": downsampleMax(page.Points[name], resolutionSeconds),
			})
		}
		writeJSON(rw, http.StatusOK, map[string]any{
			"from":               fromS,
			"to":                 toS,
			"resolution_seconds": resolutionSeconds,
			"downsample":         map[string]any{"method": "max", "bucket_seconds": resolutionSeconds},
			"series":             series,
			"cursor":             page.Cursor,
		})
	}
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/series", Series(nil))
	_ = http.ListenAndServe(":8443", mux)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

object SeriesQuery {
  implicit val system: ActorSystem = ActorSystem("series")

  val route: Route =
    path("v1" / "series") {
      get {
        parameters("series".?, "to".as[Long].?) { (series, toOpt) =>
          // TODO: this draft takes an open lower bound and a far-future to, returns raw points at
          // full resolution, and serves any tenant's series by name. Bound the range and the series
          // list, downsample to 10 s buckets, page with a cursor and 404 a foreign series.
          val names = series.getOrElse("").split(",").filter(_.nonEmpty).toIndexedSeq
          val points = store.query(names, 0L, toOpt.getOrElse(4102444800L))
          complete(StatusCodes.OK, """{"series":"ok"}""")
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
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import play.api.libs.json.Json

object SeriesQuery {
  implicit val system: ActorSystem = ActorSystem("series")

  val MaxRangeDays = 7
  val MaxSeries = 50
  val ResolutionSeconds = 10
  val DefaultPage = 1000

  case class Point(ts: Long, value: Double)
  case class SeriesRow(name: String, tenant: String)
  case class Page(points: Map[String, Seq[Point]], cursor: Option[String])

  def downsampleMax(points: Seq[Point], resolutionS: Long): Seq[Point] =
    points
      .groupBy(point => point.ts / resolutionS * resolutionS)
      .map { case (start, bucket) => Point(start, bucket.map(_.value).max) }
      .toSeq
      .sortBy(_.ts)

  val route: Route =
    path("v1" / "series") {
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          parameters("series", "from".as[Long], "to".as[Long], "cursor".?, "limit".as[Int].?(DefaultPage)) {
            (seriesParam, fromS, toS, cursor, limit) =>
              tenantOpt.filter(_.nonEmpty) match {
                case None => complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
                case Some(tenant) =>
                  val names = seriesParam.split(",").filter(_.nonEmpty).toIndexedSeq
                  if (toS <= fromS) {
                    complete(StatusCodes.BadRequest, """{"error":"to must be after from"}""")
                  } else if (toS - fromS > MaxRangeDays * 86400L) {
                    // The cap runs before the store is touched: an open lower bound is a scan.
                    complete(StatusCodes.BadRequest, """{"error":"range exceeds 7 days"}""")
                  } else if (names.size > MaxSeries) {
                    complete(StatusCodes.BadRequest, """{"error":"too many series"}""")
                  } else if (names.exists(name => !store.owner(name).exists(_.tenant == tenant))) {
                    // An unknown name and another tenant's series are the same answer: 404.
                    complete(StatusCodes.NotFound, """{"error":"unknown series"}""")
                  } else {
                    val page = store.query(tenant, names, fromS, toS, cursor, limit)
                    complete(
                      StatusCodes.OK,
                      Json.stringify(
                        Json.obj(
                          "from" -> fromS,
                          "to" -> toS,
                          "resolution_seconds" -> ResolutionSeconds,
                          "downsample" -> Json.obj("method" -> "max", "bucket_seconds" -> ResolutionSeconds),
                          "series" -> names.map { name =>
                            Json.obj(
                              "name" -> name,
                              "points" -> downsampleMax(page.points.getOrElse(name, Seq.empty), ResolutionSeconds)
                                .map(point => Json.obj("ts" -> point.ts, "value" -> point.value)),
                            )
                          },
                          "cursor" -> page.cursor,
                        ),
                      ),
                    )
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

#include <map>
#include <string>
#include <vector>

using json = nlohmann::json;

struct Point {
  long long ts;
  double value;
};

struct SeriesStore {
  std::map<std::string, std::vector<Point>> query(
      const std::vector<std::string>& names, long long fromS, long long toS);
};

SeriesStore store;

void registerSeriesRoutes(httplib::Server& svr) {
  svr.Get("/v1/series", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft takes an open lower bound and a far-future to, returns raw points at full
    // resolution, and serves any tenant's series by name. Bound the range and the series list,
    // downsample to 10 s buckets, page with a cursor and 404 a series the caller does not own.
    std::vector<std::string> names;
    const auto series = req.get_param_value("series");
    std::size_t start = 0;
    while (start <= series.size()) {
      const auto comma = series.find(',', start);
      const auto name = series.substr(start, comma == std::string::npos ? std::string::npos : comma - start);
      if (!name.empty()) names.push_back(name);
      if (comma == std::string::npos) break;
      start = comma + 1;
    }
    const long long toS = req.has_param("to") ? std::stoll(req.get_param_value("to")) : 4102444800LL;
    const auto points = store.query(names, 0, toS);
    res.status = 200;
    res.set_content(json{{"series", names}, {"points", points.size()}}.dump(), "application/json");
  });
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <map>
#include <optional>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr long long kMaxRangeDays = 7;
constexpr std::size_t kMaxSeries = 50;
constexpr int kResolutionSeconds = 10;
constexpr int kDefaultPage = 1000;

struct Point {
  long long ts;
  double value;
};

struct SeriesRow {
  std::string name;
  std::string tenant;
};

struct Page {
  std::map<std::string, std::vector<Point>> points;
  std::string cursor;
};

struct SeriesStore {
  std::optional<SeriesRow> owner(const std::string& name);
  Page query(
      const std::string& tenant,
      const std::vector<std::string>& names,
      long long fromS,
      long long toS,
      const std::string& cursor,
      int limit);
};

SeriesStore store;

std::vector<Point> downsampleMax(const std::vector<Point>& points, int resolutionS) {
  std::map<long long, Point> buckets;
  for (const auto& point : points) {
    const long long start = point.ts / resolutionS * resolutionS;
    auto it = buckets.find(start);
    if (it == buckets.end() || point.value > it->second.value) buckets[start] = Point{start, point.value};
  }
  std::vector<Point> out;
  for (const auto& [start, point] : buckets) out.push_back(point);
  return out;
}

void registerSeriesRoutes(httplib::Server& svr) {
  svr.Get("/v1/series", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(json{{"error", "missing X-Tenant-Id"}}.dump(), "application/json");
      return;
    }
    std::vector<std::string> names;
    const auto series = req.get_param_value("series");
    std::size_t start = 0;
    while (start <= series.size()) {
      const auto comma = series.find(',', start);
      const auto name = series.substr(start, comma == std::string::npos ? std::string::npos : comma - start);
      if (!name.empty()) names.push_back(name);
      if (comma == std::string::npos) break;
      start = comma + 1;
    }
    if (!req.has_param("from") || !req.has_param("to")) {
      res.status = 400;
      res.set_content(json{{"error", "from and to are required"}}.dump(), "application/json");
      return;
    }
    const long long fromS = std::stoll(req.get_param_value("from"));
    const long long toS = std::stoll(req.get_param_value("to"));
    if (toS <= fromS) {
      res.status = 400;
      res.set_content(json{{"error", "to must be after from"}}.dump(), "application/json");
      return;
    }
    if (toS - fromS > kMaxRangeDays * 86'400) {
      // The cap runs before the store is touched: an open lower bound is a scan of years.
      res.status = 400;
      res.set_content(json{{"error", "range exceeds 7 days"}}.dump(), "application/json");
      return;
    }
    if (names.size() > kMaxSeries) {
      res.status = 400;
      res.set_content(json{{"error", "too many series"}}.dump(), "application/json");
      return;
    }
    for (const auto& name : names) {
      const auto owner = store.owner(name);
      if (!owner.has_value() || owner->tenant != tenant) {
        // An unknown name and another tenant's series are the same answer: 404.
        res.status = 404;
        res.set_content(json{{"error", "unknown series"}}.dump(), "application/json");
        return;
      }
    }
    const std::string cursor = req.has_param("cursor") ? req.get_param_value("cursor") : std::string();
    const int limit = req.has_param("limit") ? std::stoi(req.get_param_value("limit")) : kDefaultPage;
    const auto page = store.query(tenant, names, fromS, toS, cursor, limit);
    json seriesOut = json::array();
    for (const auto& name : names) {
      std::vector<Point> raw;
      const auto found = page.points.find(name);
      if (found != page.points.end()) raw = found->second;
      json bucket = json::array();
      for (const auto& point : downsampleMax(raw, kResolutionSeconds)) {
        bucket.push_back(json{{"ts", point.ts}, {"value", point.value}});
      }
      seriesOut.push_back(json{{"name", name}, {"points", bucket}});
    }
    res.status = 200;
    res.set_content(
        json{
            {"from", fromS},
            {"to", toS},
            {"resolution_seconds", kResolutionSeconds},
            {"downsample", json{{"method", "max"}, {"bucket_seconds", kResolutionSeconds}}},
            {"series", seriesOut},
            {"cursor", page.cursor},
        }
            .dump(),
        "application/json");
  });
}
`,
    },
  },
  hints: [
    'Bound both axes before the store is touched: `from` and `to` are required and the window may span at most `MAX_RANGE_DAYS` (7) days, and a query may name at most `MAX_SERIES` (50) series. An open lower bound (`from=0`) is not a convenience, it is a scan of the whole retention — and every dashboard refresh repeats it.',
    'Resolve ownership before you read: `owner(name)` compares the series’ tenant with `X-Tenant-Id`, and a mismatch answers **404** exactly like an unknown name, so a prober cannot learn that a series exists on another tenant.',
    'Downsample per series to `RESOLUTION_SECONDS` (10) buckets and name the method in the response (`"downsample": {"method": "max"}`), then page with the `cursor` the store hands back when a page fills — a page that fills must return a token, never a silent truncation.',
  ],
  debrief: `Four contracts, one endpoint. First, a range cap enforced in the handler means the store only ever sees a window it can answer: an open lower bound is a scan of the entire retention, and a dashboard that refreshes every five seconds repeats it until the query path is down. Second, both axes are bounded — a series list cap is what stops one scan from being multiplied by an unbounded number of names — and each name is resolved against the tenant that owns it, with a mismatch indistinguishable from an unknown name, so the endpoint never becomes an enumeration oracle over other tenants’ metrics. Third, resolution is a contract with the reader: points are max-aggregated into 10-second buckets and the method is named, so no reader receives thousands of raw points per series per minute and the spike the dashboard exists to show survives the aggregation instead of being averaged away. Fourth, the cursor makes the page explicit: a page that fills hands back an opaque token rather than silently truncating the series, and the client decides whether to continue. Real platforms add pre-aggregated rollups per resolution, per-tenant read budgets, and a separate raw path with its own tighter caps, but bounded axes, named downsampling and tenant scoping are what make a series query safe to expose.`,
};
