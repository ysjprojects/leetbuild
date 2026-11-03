import type {Step} from '@/lib/types';

export const triageReadStep: Step = {
  id: 'read',
  title: 'GET /v1/queues/{id}/summary: aggregates a manager can act on',
  concept: 'http',
  file: 'read',
  focus: ['client', 'summary', 'db'],
  task: `## Task

**Starting point.** The starter registers \`GET /v1/queues/{queue_id}/summary\`, reads the tenant
header, and answers \`{"queue_id", "depth"}\` from \`store.depth_counter(queue_id)\` for any queue
id it is handed. It serves the demo and hides four flaws.

**Failure mode the checks target.** A cached counter is a second source of truth that drifts from
the records it summarizes; a summary without the fallback share hides the single most important
failure of a triage service; a mean wait is moved by one stuck ticket; and an unscoped read
endpoint leaks one tenant's queue depth and wait times to another.

- **Computed from routing records.** Depth, median wait and the fallback share are derived from the
  routing records, not from a cached counter.
- **Depth** is the number of routing records in the queue for this tenant. **Median wait**
  (\`median_wait_s\`) is the median of the records' wait times, 0 when the queue is empty.
- **Fallback share is mandatory.** The response reports the share of tickets the rules routed
  (\`fallback_share\`) and the raw count (\`fallback_count\`).
- **Tenant scope.** The queue must belong to the caller's tenant: an unknown queue id, or one owned
  by another tenant, is **404**.
- Missing tenant is **401**.`,
  sequence: {
    participants: ['Manager', 'Queue summary', 'routing records'],
    messages: [
      {from: 'Manager', to: 'Queue summary', label: 'GET /v1/queues/billing/summary · X-Tenant-Id', kind: 'sync'},
      {from: 'Queue summary', to: 'routing records', label: 'queueTenant(queue_id)', kind: 'sync'},
      {from: 'routing records', to: 'Queue summary', label: 'acme / none', kind: 'reply'},
      {from: 'Queue summary', to: 'routing records', label: 'routingRecords(queue_id, tenant)', kind: 'sync'},
      {
        from: 'routing records',
        to: 'Queue summary',
        label: 'records[] · wait_seconds · fallback_reason',
        kind: 'reply',
      },
      {
        from: 'Queue summary',
        to: 'Manager',
        label: '200 {depth, median_wait_s, fallback_share, fallback_count} · 404 for a foreign queue',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/queues/{id}/summary',
      detail: 'Register the summary route on `GET /v1/queues/{id}/summary`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/queues\/\{queue_id\}\/summary["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/queues\/:queueId\/summary['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/queues\/\{id\}\/summary"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"queues"\s*\/\s*Segment\s*\/\s*"summary"\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/queues\//]},
      },
    },
    {
      id: 'depth-from-records',
      title: 'Depth is the routing record count',
      detail:
        'Depth is the length of the queue’s routing records for this tenant, not a cached counter. The starter reads a counter that misses rejected dedupe hits, so depth reads low whenever it matters.',
      match: {
        python: {all: [/routing_records\(/, /depth\s*=\s*len\(/], none: [/depth_counter/]},
        typescript: {all: [/routingRecords\(/, /depth\s*=\s*records\.length/], none: [/depthCounter/]},
        go: {all: [/RoutingRecords\(/, /depth\s*:=\s*len\(records\)/], none: [/depthCounter/]},
        scala: {all: [/routingRecords\(/, /depth\s*=\s*records\.size/], none: [/DepthCounter/]},
        cpp: {all: [/routingRecords\(/, /depth\s*=\s*records\.size\(\)/], none: [/depthCounter/]},
      },
    },
    {
      id: 'fallback-share',
      title: 'Reports the fallback share and count',
      detail:
        'The response carries `fallback_share` and the raw `fallback_count`, computed from the records’ `fallback_reason`. The starter omits both, so a classifier outage looks like extra demand.',
      match: {
        python: {all: [/fallback_share/, /fallback_count/]},
        typescript: {all: [/fallback_share/, /fallbackCount/]},
        go: {all: [/"fallback_share"/, /FallbackCount/]},
        scala: {all: [/fallback_share/, /fallbackCount/]},
        cpp: {all: [/fallback_share/, /fallbackCount/]},
      },
    },
    {
      id: 'median-wait',
      title: 'Median wait is computed from the records',
      detail:
        '`median_wait_s` is the median of the records’ wait times, sorted rather than averaged, and 0 for an empty queue. The starter reports no wait figure at all.',
      match: {
        python: {all: [/median_wait_s/, /sorted\(/]},
        typescript: {all: [/median_wait_s/, /\.sort\(/]},
        go: {all: [/"median_wait_s"/, /sort\.Slice/]},
        scala: {all: [/median_wait_s/, /\.sorted/]},
        cpp: {all: [/median_wait_s/, /std::sort/]},
      },
    },
    {
      id: 'tenant-scope',
      title: 'Answers 404 for a queue of another tenant',
      detail:
        'The queue’s owning tenant is checked against the caller; an unknown or foreign queue id is **404**. The starter serves any queue id to any caller.',
      match: {
        python: {all: [/status_code\s*=\s*404/, /queue_tenant\(/]},
        typescript: {all: [/code\(\s*404\s*\)/, /queueTenant\(/]},
        go: {all: [/StatusNotFound/, /QueueTenant\(/]},
        scala: {all: [/StatusCodes\.NotFound/, /queueTenant\(/]},
        cpp: {all: [/status\s*=\s*404/, /queueTenant\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse

app = FastAPI()


class QueueStore:
    def depth_counter(self, queue_id: str) -> int:
        """The cached depth for the queue."""
        raise NotImplementedError


store = QueueStore()


@app.get("/v1/queues/{queue_id}/summary")
def summary(queue_id: str, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    return JSONResponse({"queue_id": queue_id, "depth": store.depth_counter(queue_id)}, status_code=200)
`,
      solution: `from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()


class QueueStore:
    def queue_tenant(self, queue_id: str) -> str | None:
        """The tenant that owns the queue, if the queue exists."""
        raise NotImplementedError

    def routing_records(self, queue_id: str, tenant: str) -> list[dict]:
        """Every routing record for the tenant's queue."""
        raise NotImplementedError


store = QueueStore()


def median(values: list[float]) -> float:
    """The middle value of the sorted series, 0.0 when there is nothing to summarize."""
    if not values:
        return 0.0
    ordered = sorted(values)
    return ordered[len(ordered) // 2]


@app.get("/v1/queues/{queue_id}/summary")
def summary(
    queue_id: str, tenant: str | None = Header(default=None, alias="X-Tenant-Id")
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    owner = store.queue_tenant(queue_id)
    if owner != tenant:
        raise HTTPException(status_code=404, detail="unknown queue")

    records = store.routing_records(queue_id, tenant)
    depth = len(records)
    median_wait_s = median([record["wait_seconds"] for record in records])
    fallback_count = sum(1 for record in records if record["fallback_reason"] != "")
    fallback_share = round(fallback_count / depth, 4) if depth else 0.0
    return JSONResponse(
        {
            "queue_id": queue_id,
            "depth": depth,
            "median_wait_s": median_wait_s,
            "fallback_share": fallback_share,
            "fallback_count": fallback_count,
        },
        status_code=200,
    )
`,
    },
    typescript: {
      starter: `/** Queue summary. */
import Fastify from 'fastify';

export const app = Fastify();

interface QueueStore {
  depthCounter(queueId: string): Promise<number>;
}

export function routes(store: QueueStore): void {
  app.get('/v1/queues/:queueId/summary', async (request, reply) => {
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    const {queueId} = request.params as {queueId: string};
    return reply.code(200).send({queue_id: queueId, depth: await store.depthCounter(queueId)});
  });
}

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** Queue summary: depth, median wait and fallback share, read from the routing records. */
import Fastify from 'fastify';

export const app = Fastify();

interface RoutingRecord {
  queue_id: string;
  tenant: string;
  wait_seconds: number;
  fallback_reason: string;
}

interface QueueStore {
  queueTenant(queueId: string): Promise<string | null>;
  routingRecords(queueId: string, tenant: string): Promise<RoutingRecord[]>;
}

function median(values: number[]): number {
  /** The middle value of the sorted series, 0 when there is nothing to summarize. */
  if (values.length === 0) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 2)];
}

export function routes(store: QueueStore): void {
  app.get('/v1/queues/:queueId/summary', async (request, reply) => {
    const tenant = request.headers['x-tenant-id'];
    if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
    const {queueId} = request.params as {queueId: string};
    const owner = await store.queueTenant(queueId);
    if (owner !== tenant) return reply.code(404).send({error: 'unknown queue'});

    const records = await store.routingRecords(queueId, tenant);
    const depth = records.length;
    const median_wait_s = median(records.map(record => record.wait_seconds));
    const fallbackCount = records.filter(record => record.fallback_reason !== '').length;
    const fallback_share = depth === 0 ? 0 : Number((fallbackCount / depth).toFixed(4));
    return reply.code(200).send({queue_id: queueId, depth, median_wait_s, fallback_share, fallback_count: fallbackCount});
  });
}

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
)

type QueueStore struct{}

func (s *QueueStore) DepthCounter(ctx context.Context, queueID string) int {
	return 0
}

var store = &QueueStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func summary(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	queueID := r.PathValue("id")
	writeJSON(rw, http.StatusOK, map[string]any{"queue_id": queueID, "depth": store.DepthCounter(r.Context(), queueID)})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/queues/{id}/summary", summary)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"sort"
)

// RoutingRecord is one ticket's journey through triage, the only source of the summary numbers.
type RoutingRecord struct {
	QueueID        string  \`json:"queue_id"\`
	Tenant         string  \`json:"tenant"\`
	WaitSeconds    float64 \`json:"wait_seconds"\`
	FallbackReason string  \`json:"fallback_reason"\`
}

type Summary struct {
	QueueID       string  \`json:"queue_id"\`
	Depth         int     \`json:"depth"\`
	MedianWaitS   float64 \`json:"median_wait_s"\`
	FallbackShare float64 \`json:"fallback_share"\`
	FallbackCount int     \`json:"fallback_count"\`
}

type QueueStore struct{}

func (s *QueueStore) QueueTenant(ctx context.Context, queueID string) (string, error) {
	return "", nil
}

func (s *QueueStore) RoutingRecords(ctx context.Context, queueID, tenant string) ([]RoutingRecord, error) {
	return nil, nil
}

var store = &QueueStore{}

func median(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	ordered := append([]float64(nil), values...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i] < ordered[j] })
	return ordered[len(ordered)/2]
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func summary(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	queueID := r.PathValue("id")
	owner, err := store.QueueTenant(r.Context(), queueID)
	if err != nil || owner != tenant {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown queue"})
		return
	}
	records, err := store.RoutingRecords(r.Context(), queueID, tenant)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	depth := len(records)
	waits := make([]float64, 0, depth)
	fallbackCount := 0
	for _, record := range records {
		waits = append(waits, record.WaitSeconds)
		if record.FallbackReason != "" {
			fallbackCount++
		}
	}
	share := 0.0
	if depth > 0 {
		share = float64(fallbackCount) / float64(depth)
	}
	writeJSON(rw, http.StatusOK, Summary{
		QueueID:       queueID,
		Depth:         depth,
		MedianWaitS:   median(waits),
		FallbackShare: share,
		FallbackCount: fallbackCount,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/queues/{id}/summary", summary)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
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

trait QueueStore {
  def depthCounter(queueId: String): Long
}

object QueueSummary {
  implicit val system: ActorSystem = ActorSystem("ticket-triage")

  val store: QueueStore = new QueueStore {
    def depthCounter(queueId: String): Long = 0L
  }

  val route: Route =
    path("v1" / "queues" / Segment / "summary") { queueId =>
      get {
        headerValueByName("X-Tenant-Id") { _ =>
          // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
          complete(StatusCodes.OK, s"""{"queue_id":"$queueId","depth":\${store.depthCounter(queueId)}}""")
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

final case class RoutingRecord(
    queue_id: String,
    tenant: String,
    wait_seconds: Double,
    fallback_reason: String
)

trait QueueStore {
  def queueTenant(queueId: String): Option[String]
  def routingRecords(queueId: String, tenant: String): Seq[RoutingRecord]
}

object QueueSummary {
  implicit val system: ActorSystem = ActorSystem("ticket-triage")

  val store: QueueStore = new QueueStore {
    def queueTenant(queueId: String): Option[String] = None
    def routingRecords(queueId: String, tenant: String): Seq[RoutingRecord] = Nil
  }

  /** The middle value of the sorted series, 0.0 when there is nothing to summarize. */
  def median(values: Seq[Double]): Double =
    if (values.isEmpty) 0.0
    else {
      val ordered = values.sorted
      ordered(ordered.size / 2)
    }

  val route: Route =
    path("v1" / "queues" / Segment / "summary") { queueId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          val tenant = tenantOpt.filter(_.nonEmpty)
          if (tenant.isEmpty) {
            complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
          } else if (!store.queueTenant(queueId).contains(tenant.get)) {
            complete(StatusCodes.NotFound, """{"error":"unknown queue"}""")
          } else {
            val records = store.routingRecords(queueId, tenant.get)
            val depth = records.size
            val median_wait_s = median(records.map(_.wait_seconds))
            val fallbackCount = records.count(_.fallback_reason.nonEmpty)
            val fallback_share = if (depth == 0) 0.0 else fallbackCount.toDouble / depth
            complete(
              StatusCodes.OK,
              s"""{"queue_id":"$queueId","depth":$depth,"median_wait_s":$median_wait_s,""" +
                s""""fallback_share":$fallback_share,"fallback_count":$fallbackCount}"""
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

struct QueueStore {
  long long depthCounter(const std::string& queueId);
};

QueueStore store;

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/queues/([^/]+)/summary)", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    const std::string queueId = req.matches[1];
    res.status = 200;
    res.set_content(json{{"queue_id", queueId}, {"depth", store.depthCounter(queueId)}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <optional>
#include <string>
#include <vector>

using json = nlohmann::json;

/** One ticket's journey through triage: the only source of the summary numbers. */
struct RoutingRecord {
  std::string queue_id;
  std::string tenant;
  double wait_seconds;
  std::string fallback_reason;
};

struct QueueStore {
  std::optional<std::string> queueTenant(const std::string& queueId);
  std::vector<RoutingRecord> routingRecords(const std::string& queueId, const std::string& tenant);
};

QueueStore store;

/** The middle value of the sorted series, 0 when there is nothing to summarize. */
double median(std::vector<double> values) {
  if (values.empty()) return 0.0;
  std::sort(values.begin(), values.end());
  return values[values.size() / 2];
}

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/queues/([^/]+)/summary)", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const std::string queueId = req.matches[1];
    const auto owner = store.queueTenant(queueId);
    if (!owner || *owner != tenant) {
      res.status = 404;
      res.set_content(R"({"error":"unknown queue"})", "application/json");
      return;
    }

    const auto records = store.routingRecords(queueId, tenant);
    const std::size_t depth = records.size();
    std::vector<double> waits;
    waits.reserve(records.size());
    long long fallbackCount = 0;
    for (const auto& record : records) {
      waits.push_back(record.wait_seconds);
      if (!record.fallback_reason.empty()) fallbackCount += 1;
    }
    const double fallback_share = depth == 0 ? 0.0 : static_cast<double>(fallbackCount) / static_cast<double>(depth);
    res.status = 200;
    res.set_content(
        json{{"queue_id", queueId},
             {"depth", depth},
             {"median_wait_s", median(waits)},
             {"fallback_share", fallback_share},
             {"fallback_count", fallbackCount}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'During a classifier outage the dashboard shows a normal depth and no sign that rules are routing; a manager from tenant B can read `/v1/queues/billing/summary` for tenant A by guessing the name.',
    'The handler is one line: `depth_counter` is a counter beside the records rather than a count of them, no wait or fallback figure is derived, and `tenant` is read but compared with nothing.',
    'Resolve `queue_tenant(queue_id)` and 404 on mismatch, then load `routing_records(queue_id, tenant)`: `depth = len(records)`, `median_wait_s` from `sorted` waits, `fallback_count`/`fallback_share` from `fallback_reason`.',
  ],
  debrief: `Every figure comes from the routing records in one pass because a counter kept beside them is a cache with no invalidation: it disagrees with the records after any rejection or fallback, which is exactly when a manager is deciding whether to add agents. The median rather than the mean keeps one three-day ticket from making a healthy queue look broken, and the fallback share is the number that distinguishes a classifier outage from a busy day. Scoping the queue to the caller's tenant and answering 404 for both a missing and a foreign queue keeps the endpoint from being used to enumerate other tenants' queue names. Production platforms add a time window to the summary, a per-queue SLO breach count, and a cached aggregate invalidated by the routing events rather than by a timer.`,
};
