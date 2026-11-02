import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/services/{id}/completeness: gaps you can see',
  concept: 'http',
  file: 'read',
  focus: ['dash', 'api', 'ledger'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/services/{service}/completeness\`: it reads the
tenant header, asks the ledger for the service's all-time \`total_count\`, and returns that total next
to a global constant \`EXPECTED_PER_HOUR\`. It compiles, the page renders, and it hides four flaws,
the ones that let the incident review conclude "100 %".

- Missing \`X-Tenant-Id\` is **401**.
- The report is **per hour**: buckets over the last **24 hours** (\`HOUR_MS\`), each with the
  \`indexed\` count for that tenant's service.
- Each hour carries an \`expected\` count from **that tenant's own service history**
  (\`hourly_expectation(tenant, service, hours)\`), not a global average.
- An hour below its expectation by more than **\`GAP_THRESHOLD\`** is flagged (\`gap\`), and the
  response counts the flagged hours.
- A \`service\` outside the caller's registry is **404**.
- Return the service id, the hours, the gap count and the threshold; never the log text.

**Failure mode the checks target.** One number makes a service that indexed ten records in an outage
hour and a million in a normal hour "look fine"; a global constant makes one tenant's volume every
tenant's baseline, so genuine drops stop flagging; nothing is marked as a gap; and answering for any
service id turns the completeness page into an existence oracle for other tenants' pipelines.`,
  sequence: {
    participants: ['Completeness UI', 'Ingest API', 'Index ledger'],
    messages: [
      {
        from: 'Completeness UI',
        to: 'Ingest API',
        label: 'GET /v1/services/{id}/completeness · X-Tenant-Id',
        kind: 'sync',
      },
      {from: 'Ingest API', to: 'Ingest API', label: 'registry lookup → 404 when foreign', kind: 'sync'},
      {from: 'Ingest API', to: 'Index ledger', label: 'hourly_counts(tenant, service, 24)', kind: 'sync'},
      {from: 'Index ledger', to: 'Ingest API', label: 'counts per hour bucket', kind: 'reply'},
      {from: 'Ingest API', to: 'Ingest API', label: 'expected = tenant history · flag gaps', kind: 'sync'},
      {from: 'Ingest API', to: 'Completeness UI', label: '200 {hours[], gaps, threshold}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/services/{id}/completeness',
      detail: 'Register the completeness route with the service id as a path parameter.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/services\/\{service\}\/completeness["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/services\/:service\/completeness['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/services\/\{service\}\/completeness"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"services"\s*\/\s*Segment\s*\/\s*"completeness"\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\([^;]*completeness/]},
      },
    },
    {
      id: 'hourly',
      title: 'Reports indexed counts per hour bucket',
      detail:
        'The report buckets by `HOUR_MS` over a 24-hour window, so it shows *when* the pipeline stopped, not only that the total is low. The starter returns one number for the whole window.',
      match: {
        python: {all: [/HOUR_MS/, /hour_bucket\(/]},
        typescript: {all: [/HOUR_MS/, /hourBucket\(/]},
        go: {all: [/hourMS/, /hourBucket\(/]},
        scala: {all: [/HourMs/, /hourBucket\(/]},
        cpp: {all: [/kHourMs/, /hourBucket\(/]},
      },
    },
    {
      id: 'expectation-per-tenant',
      title: "Computes the expectation from the tenant's own history",
      detail:
        'The expected count is read for `(tenant, service)` over the same window, not a global constant or a cross-tenant average. The starter compares every tenant with one global expectation, which hides real drops and invents fake ones.',
      match: {
        python: {all: [/hourly_expectation\(tenant,\s*service/]},
        typescript: {all: [/hourlyExpectation\(tenant,\s*service/]},
        go: {all: [/HourlyExpectation\(ctx,\s*tenant,\s*service/]},
        scala: {all: [/hourlyExpectation\(tenant,\s*service/]},
        cpp: {all: [/hourlyExpectation\(tenant,\s*service/]},
      },
    },
    {
      id: 'foreign-404',
      title: "Answers 404 for a service outside the tenant's registry",
      detail:
        "A `service` that is not in the caller's registry is **404**. The starter answers for any id, so the completeness page doubles as an existence oracle for other tenants' pipelines.",
      match: {
        python: {all: [/status_code\s*=\s*404/, /[Rr]egistry/]},
        typescript: {all: [/code\(\s*404\s*\)/, /[Rr]egistry/]},
        go: {all: [/StatusNotFound/, /[Rr]egistry/]},
        scala: {all: [/StatusCodes\.NotFound/, /[Rr]egistry/]},
        cpp: {all: [/\b404\b/, /[Rr]egistry/]},
      },
    },
    {
      id: 'gap-threshold',
      title: 'Flags hours below the expectation by more than the threshold',
      detail:
        'Each hour is marked `gap` when the indexed count falls more than `GAP_THRESHOLD` below its expectation, and the response totals the flagged hours. The starter has no per-hour comparison at all, which is why an outage looked complete.',
      match: {
        python: {all: [/GAP_THRESHOLD/, /"gap"/]},
        typescript: {all: [/GAP_THRESHOLD/, /\bgap\b/]},
        go: {all: [/gapThreshold/, /"gap"/]},
        scala: {all: [/GapThreshold/, /"gap"/]},
        cpp: {all: [/kGapThreshold/, /"gap"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""GET /v1/services/{id}/completeness."""
from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse

app = FastAPI()

EXPECTED_PER_HOUR = 1000


class IndexLedger:
    def total_count(self, tenant: str, service: str) -> int:
        """Every record this tenant's service ever indexed."""
        raise NotImplementedError


ledger = IndexLedger()


@app.get("/v1/services/{service}/completeness")
def completeness(service: str, tenant: str | None = Header(default=None, alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    total = ledger.total_count(tenant, service)
    return JSONResponse({"service": service, "indexed": total, "expected": EXPECTED_PER_HOUR})
`,
      solution: `"""GET /v1/services/{id}/completeness: hourly indexed counts against a tenanted expectation."""
import time

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()

HOUR_MS = 60 * 60 * 1000
WINDOW_HOURS = 24
GAP_THRESHOLD = 0.5  # an hour under half of its expectation is a gap


class ServiceRegistry:
    def services(self, tenant: str) -> set[str]:
        """The service ids this tenant has registered."""
        raise NotImplementedError


class IndexLedger:
    def hourly_counts(self, tenant: str, service: str, hours: int) -> dict[int, int]:
        """Indexed records per hour bucket for one tenant's service."""
        raise NotImplementedError


class ExpectationStore:
    def hourly_expectation(self, tenant: str, service: str, hours: int) -> dict[int, int]:
        """What this tenant's own service normally indexes in an hour."""
        raise NotImplementedError


registry = ServiceRegistry()
ledger = IndexLedger()
expectations = ExpectationStore()


def hour_bucket(epoch_ms: int) -> int:
    return epoch_ms // HOUR_MS


@app.get("/v1/services/{service}/completeness")
def completeness(service: str, tenant: str | None = Header(default=None, alias="X-Tenant-Id")) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    # A service that is not in the caller's registry is not the caller's to read.
    if service not in registry.services(tenant):
        raise HTTPException(status_code=404, detail=f"service '{service}' is not in the tenant registry")

    newest = hour_bucket(int(time.time() * 1000))
    indexed = ledger.hourly_counts(tenant, service, WINDOW_HOURS)
    # The expectation comes from this tenant's own service history, never a global average.
    expected = expectations.hourly_expectation(tenant, service, WINDOW_HOURS)

    hours = []
    gaps = 0
    for offset in range(WINDOW_HOURS - 1, -1, -1):
        bucket = newest - offset
        count = indexed.get(bucket, 0)
        want = expected.get(bucket, 0)
        gap = want > 0 and count < want * (1 - GAP_THRESHOLD)
        gaps += 1 if gap else 0
        hours.append({"hour": bucket, "indexed": count, "expected": want, "gap": gap})

    return JSONResponse({"service": service, "hours": hours, "gaps": gaps, "threshold": GAP_THRESHOLD})
`,
    },
    typescript: {
      starter: `/** GET /v1/services/:service/completeness: flawed code with one total. */
import Fastify from 'fastify';

export const app = Fastify();

const EXPECTED_PER_HOUR = 1000;

export interface IndexLedger {
  totalCount(tenant: string, service: string): Promise<number>;
}

export const ledger: IndexLedger = {totalCount: async () => 0};

app.get('/v1/services/:service/completeness', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const {service} = request.params as {service: string};
  const tenant = request.headers['x-tenant-id'] as string;
  const total = await ledger.totalCount(tenant, service);
  return reply.code(200).send({service, indexed: total, expected: EXPECTED_PER_HOUR});
});
`,
      solution: `/** GET /v1/services/:service/completeness: hourly counts against a tenanted expectation. */
import Fastify from 'fastify';

export const app = Fastify();

const HOUR_MS = 60 * 60 * 1000;
const WINDOW_HOURS = 24;
const GAP_THRESHOLD = 0.5; // an hour under half of its expectation is a gap

export interface ServiceRegistry {
  services(tenant: string): Promise<Set<string>>;
}

export interface IndexLedger {
  hourlyCounts(tenant: string, service: string, hours: number): Promise<Record<string, number>>;
}

export interface ExpectationStore {
  hourlyExpectation(tenant: string, service: string, hours: number): Promise<Record<string, number>>;
}

export const registry: ServiceRegistry = {services: async () => new Set<string>()};
export const ledger: IndexLedger = {hourlyCounts: async () => ({})};
export const expectations: ExpectationStore = {hourlyExpectation: async () => ({})};

const hourBucket = (epochMs: number): number => Math.floor(epochMs / HOUR_MS);

app.get('/v1/services/:service/completeness', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {service} = request.params as {service: string};

  // A service that is not in the caller's registry is not the caller's to read.
  const registered = await registry.services(tenant);
  if (!registered.has(service))
    return reply.code(404).send({error: \`service '\${service}' is not in the tenant registry\`});

  const newest = hourBucket(Date.now());
  const indexed = await ledger.hourlyCounts(tenant, service, WINDOW_HOURS);
  // The expectation comes from this tenant's own service history, never a global average.
  const expected = await expectations.hourlyExpectation(tenant, service, WINDOW_HOURS);

  const hours: {hour: number; indexed: number; expected: number; gap: boolean}[] = [];
  let gaps = 0;
  for (let offset = WINDOW_HOURS - 1; offset >= 0; offset--) {
    const bucket = newest - offset;
    const count = indexed[String(bucket)] ?? 0;
    const want = expected[String(bucket)] ?? 0;
    const gap = want > 0 && count < want * (1 - GAP_THRESHOLD);
    if (gap) gaps += 1;
    hours.push({hour: bucket, indexed: count, expected: want, gap});
  }
  return reply.code(200).send({service, hours, gaps, threshold: GAP_THRESHOLD});
});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"net/http"
)

const expectedPerHour = 1000

type IndexLedger struct{}

func (l *IndexLedger) TotalCount(ctx context.Context, tenant, service string) (int64, error) {
	return 0, nil
}

var ledger = &IndexLedger{}

func completeness(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	service := r.PathValue("service")
	total, _ := ledger.TotalCount(r.Context(), tenant, service)
	writeJSON(rw, http.StatusOK, map[string]any{
		"service":  service,
		"indexed":  total,
		"expected": expectedPerHour,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/services/{service}/completeness", completeness)
	_ = http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux)
}
`,
      solution: `package main

import (
	"context"
	"net/http"
	"time"
)

const (
	hourMS       = 60 * 60 * 1000
	windowHours  = 24
	gapThreshold = 0.5
)

type ServiceRegistry struct{}

func (s *ServiceRegistry) Services(ctx context.Context, tenant string) (map[string]bool, error) {
	return nil, nil
}

type IndexLedger struct{}

func (l *IndexLedger) HourlyCounts(ctx context.Context, tenant, service string, hours int) (map[int64]int64, error) {
	return nil, nil
}

type ExpectationStore struct{}

func (e *ExpectationStore) HourlyExpectation(ctx context.Context, tenant, service string, hours int) (map[int64]int64, error) {
	return nil, nil
}

var (
	registry     = &ServiceRegistry{}
	ledger       = &IndexLedger{}
	expectations = &ExpectationStore{}
)

func hourBucket(epochMS int64) int64 { return epochMS / hourMS }

func completeness(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	service := r.PathValue("service")
	ctx := r.Context()

	// A service that is not in the caller's registry is not the caller's to read.
	registered, err := registry.Services(ctx, tenant)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "registry unavailable"})
		return
	}
	if !registered[service] {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "service is not in the tenant registry"})
		return
	}

	newest := hourBucket(time.Now().UnixMilli())
	indexed, err := ledger.HourlyCounts(ctx, tenant, service, windowHours)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "ledger unavailable"})
		return
	}
	// The expectation comes from this tenant's own service history, never a global average.
	expected, err := expectations.HourlyExpectation(ctx, tenant, service, windowHours)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "expectation unavailable"})
		return
	}

	hours := make([]map[string]any, 0, windowHours)
	gaps := 0
	for offset := windowHours - 1; offset >= 0; offset-- {
		bucket := newest - int64(offset)
		count := indexed[bucket]
		want := expected[bucket]
		gap := want > 0 && float64(count) < float64(want)*(1-gapThreshold)
		if gap {
			gaps++
		}
		hours = append(hours, map[string]any{"hour": bucket, "indexed": count, "expected": want, "gap": gap})
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"service":   service,
		"hours":     hours,
		"gaps":      gaps,
		"threshold": gapThreshold,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/services/{service}/completeness", completeness)
	_ = http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

object Read {
  implicit val system: ActorSystem = ActorSystem("log-indexer")

  val ExpectedPerHour = 1000L
  val ledger = IndexLedger.open()

  val route: Route =
    path("v1" / "services" / Segment / "completeness") { service =>
      get {
        // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
        val total = ledger.totalCount(service)
        complete(StatusCodes.OK, s"""{"service":"$service","indexed":$total,"expected":$ExpectedPerHour}""")
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

final case class HourBucket(bucket: Long, count: Long, want: Long, gap: Boolean)

object Read {
  implicit val system: ActorSystem = ActorSystem("log-indexer")

  val HourMs = 60 * 60 * 1000L
  val WindowHours = 24
  val GapThreshold = 0.5

  val registry = ServiceRegistry.open()
  val ledger = IndexLedger.open()
  val expectations = ExpectationStore.open()

  def hourBucket(epochMs: Long): Long = epochMs / HourMs

  val route: Route =
    path("v1" / "services" / Segment / "completeness") { service =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          val tenant = tenantOpt.getOrElse("")
          if (tenant.isEmpty) {
            complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
          } else if (!registry.services(tenant).contains(service)) {
            // A service that is not in the caller's registry is not the caller's to read.
            complete(StatusCodes.NotFound, """{"error":"service is not in the tenant registry"}""")
          } else {
            val newest = hourBucket(System.currentTimeMillis())
            val indexed = ledger.hourlyCounts(tenant, service, WindowHours)
            // The expectation comes from this tenant's own service history, never a global average.
            val expected = expectations.hourlyExpectation(tenant, service, WindowHours)
            val hours = (WindowHours - 1 to 0 by -1).map { offset =>
              val bucket = newest - offset
              val count = indexed.getOrElse(bucket, 0L)
              val want = expected.getOrElse(bucket, 0L)
              val gap = want > 0 && count < (want * (1 - GapThreshold)).toLong
              HourBucket(bucket, count, want, gap)
            }.toList
            val gapCount = hours.count(_.gap)
            val hourJson = hours
              .map { entry =>
                val b = entry.bucket
                val indexed = entry.count
                val want = entry.want
                val gap = entry.gap
                s"""{"hour":$b,"indexed":$indexed,"expected":$want,"gap":$gap}"""
              }
              .mkString(",")
            complete(
              StatusCodes.OK,
              s"""{"service":"$service","hours":[$hourJson],"gaps":$gapCount,"threshold":$GapThreshold}"""
            )
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

constexpr long long kExpectedPerHour = 1000;

struct IndexLedger {
  long long totalCount(const std::string& tenant, const std::string& service);
};

IndexLedger ledger;

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/services/([^/]+)/completeness)", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    const auto tenant = req.get_header_value("X-Tenant-Id");
    const auto service = req.matches[1].str();
    const auto total = ledger.totalCount(tenant, service);
    res.status = 200;
    res.set_content(
        json{{"service", service}, {"indexed", total}, {"expected", kExpectedPerHour}}.dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <map>
#include <set>
#include <string>

using json = nlohmann::json;

constexpr long long kHourMs = 60 * 60 * 1000;
constexpr int kWindowHours = 24;
constexpr double kGapThreshold = 0.5;

struct ServiceRegistry {
  std::set<std::string> services(const std::string& tenant);
};

struct IndexLedger {
  std::map<long long, long long> hourlyCounts(const std::string& tenant, const std::string& service, int hours);
};

struct ExpectationStore {
  std::map<long long, long long> hourlyExpectation(const std::string& tenant, const std::string& service, int hours);
};

ServiceRegistry registry;
IndexLedger ledger;
ExpectationStore expectations;

long long hourBucket(long long epochMs) { return epochMs / kHourMs; }

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/services/([^/]+)/completeness)", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto service = req.matches[1].str();

    // A service that is not in the caller's registry is not the caller's to read.
    const auto registered = registry.services(tenant);
    if (registered.count(service) == 0) {
      res.status = 404;
      res.set_content(R"({"error":"service is not in the tenant registry"})", "application/json");
      return;
    }

    const auto now = std::chrono::duration_cast<std::chrono::milliseconds>(
                         std::chrono::system_clock::now().time_since_epoch())
                         .count();
    const auto newest = hourBucket(now);
    const auto indexed = ledger.hourlyCounts(tenant, service, kWindowHours);
    // The expectation comes from this tenant's own service history, never a global average.
    const auto expected = expectations.hourlyExpectation(tenant, service, kWindowHours);

    json hours = json::array();
    int gaps = 0;
    for (int offset = kWindowHours - 1; offset >= 0; offset--) {
      const long long bucket = newest - offset;
      const auto count = indexed.count(bucket) > 0 ? indexed.at(bucket) : 0;
      const auto want = expected.count(bucket) > 0 ? expected.at(bucket) : 0;
      const bool gap = want > 0 && static_cast<double>(count) < static_cast<double>(want) * (1 - kGapThreshold);
      if (gap) gaps += 1;
      hours.push_back(json{{"hour", bucket}, {"indexed", count}, {"expected", want}, {"gap", gap}});
    }
    res.status = 200;
    res.set_content(
        json{{"service", service}, {"hours", hours}, {"gaps", gaps}, {"threshold", kGapThreshold}}.dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    "A service that shipped nothing for six hours shows `indexed: 2400000, expected: 1000` and reads as healthy; a GET for a competitor's service id returns 200 with their count.",
    'The handler calls `total_count` once, so time is collapsed into one number; `EXPECTED_PER_HOUR` is a constant shared by every tenant; the service id is used without a registry lookup, so any id is answered.',
    'Look the service up in the registry and answer 404 when absent; build 24 `hour_bucket` windows of `HOUR_MS`, read `hourly_expectation(tenant, service, hours)`, and mark `"gap"` where indexed falls below expected by more than `GAP_THRESHOLD`.',
  ],
  debrief: `The report is a list of buckets rather than a total because a total answers "how much" and hides "when", and "when" is the only question an operator has during an outage. The expectation is per tenant and per service because a shared baseline makes a quiet tenant look broken and a broken tenant look fine. The threshold turns the comparison into a signal instead of a judgement made by eye. The 404 scopes the read to the caller's registry like every other read, because a completeness page that answers for any id leaks which pipelines exist and how healthy they are. Production platforms go further: retention and sampling context per hour, an explicit "expected from N days of history" note, anomaly detection on the bucket series, and an alert on the gap count rather than a page someone has to open.`,
};
