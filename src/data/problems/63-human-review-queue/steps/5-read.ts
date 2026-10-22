import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/review/queues/{p}: depth and age that an operator can act on',
  concept: 'http',
  file: 'read',
  focus: ['console', 'queue', 'items'],
  task: `## Task

**Review premise.** The starter serves a queue summary from a cached counter. On the demo the counter
matches the store. After a batch of lease expiries it does not — items the sweeper returned are in the
store but not in the cache — and the operator staffing the queue acts on the wrong number. Review it,
fix it, and prove the fix with the checks below.

Implement \`GET /v1/review/queues/{priority}\` for the operator console:

- **Depth per priority, from the item store.** \`queue_depth(tenant, priority)\` counts the items
  actually queued — including the ones the lease-expiry sweeper returned — by asking the item store
  (\`store.count(tenant, priority, "queued")\`), never a cached counter that goes stale when a lease
  expires.
- **Oldest age, always reported.** \`oldest_age(tenant, priority)\` returns the age in seconds of the
  oldest queued item, or \`null\` when the queue is empty. It must be present in the response every
  time — never hidden, never omitted, never \`-1\`.
- **SLA breach count.** The response carries \`breach_count\`: how many items in this queue have
  breached their SLA, so an operator can see the queue degrading before reviewers notice.
- **Assignment state distribution.** The response carries \`assignment_states\`: how many items are
  \`queued\`, \`assigned\` and \`breached\`, so an operator can see whether work is stuck assigned.
- **Tenant scope.** A queue belongs to one tenant. The caller's \`X-Tenant-Id\` owns it; asking for
  another tenant's queue (\`?tenant=…\` different from the header) is **403**, never that tenant's
  data. A missing header is **401**.

**Failure mode the checks target.** Three defects. The draft reads depth from a cached counter that
misses items returned by lease expiry, so the operator under-counts exactly when the queue is under
stress. It hides the oldest age, so nobody sees the item that has been waiting longest. And it serves
any tenant's queue, so one tenant can read another's review backlog.`,
  sequence: {
    participants: ['Operator', 'Review Queue', 'Item store'],
    messages: [
      {from: 'Operator', to: 'Review Queue', label: 'GET /v1/review/queues/{p} · X-Tenant-Id', kind: 'sync'},
      {from: 'Review Queue', to: 'Review Queue', label: 'tenant owns the queue? else 403', kind: 'sync'},
      {from: 'Review Queue', to: 'Item store', label: 'count(tenant, priority, "queued")', kind: 'sync'},
      {from: 'Review Queue', to: 'Item store', label: 'oldest · breach count · states', kind: 'sync'},
      {from: 'Item store', to: 'Review Queue', label: 'depth · age · breaches · states', kind: 'reply'},
      {
        from: 'Review Queue',
        to: 'Operator',
        label: '200 {depth, oldest_age_seconds, breach_count, assignment_states}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'depth',
      title: 'Depth comes from the item store',
      detail:
        '`queue_depth` counts queued items through `store.count(tenant, priority, "queued")`, so lease-expiry returns are included. The draft reads a cached counter.',
      match: {
        python: {all: [/def queue_depth\(/, /store\.count\(/]},
        typescript: {all: [/function queueDepth\(/, /store\.count\(/]},
        go: {all: [/func queueDepth\(/, /store\.Count\(/]},
        scala: {all: [/def queueDepth\(/, /store\.count\(/]},
        cpp: {all: [/queueDepth\(/, /store\.count\(/]},
      },
    },
    {
      id: 'oldest-age',
      title: 'The oldest age is always reported',
      detail:
        '`oldest_age` reports the age of the oldest queued item (or `null` for an empty queue) in the response. The draft hides it.',
      match: {
        python: {all: [/def oldest_age\(/]},
        typescript: {all: [/function oldestAge\(/]},
        go: {all: [/func oldestAge\(/]},
        scala: {all: [/def oldestAge\(/]},
        cpp: {all: [/oldestAge\(/]},
      },
    },
    {
      id: 'breach-count',
      title: 'Reports the SLA breach count',
      detail: 'The response carries `breach_count` for the queue. The draft reports zero always.',
      match: {
        python: {all: [/breach_count/]},
        typescript: {all: [/breachCount/]},
        go: {all: [/BreachCount/]},
        scala: {all: [/breachCount/]},
        cpp: {all: [/breach_count/]},
      },
    },
    {
      id: 'distribution',
      title: 'Reports the assignment state distribution',
      detail:
        'The response carries `assignment_states` (queued / assigned / breached). The draft reports nothing about assignment.',
      match: {
        python: {all: [/assignment_states/]},
        typescript: {all: [/assignmentStates/]},
        go: {all: [/AssignmentStates/]},
        scala: {all: [/assignmentStates/]},
        cpp: {all: [/assignment_states/]},
      },
    },
    {
      id: 'tenant-scope',
      title: 'Foreign queues are forbidden',
      detail: 'A queue read for another tenant is **403**. The draft serves any tenant’s queue.',
      match: {
        python: {all: [/status_code\s*=\s*403/]},
        typescript: {all: [/code\(\s*403\s*\)/]},
        go: {all: [/StatusForbidden/]},
        scala: {all: [/StatusCodes\.Forbidden/]},
        cpp: {all: [/\b403\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse

app = FastAPI()

depth_cache = {"p1": 12, "p2": 40, "p3": 3}


@app.get("/v1/review/queues/{priority}")
def read_queue(
    priority: str,
    tenant: str = Header(alias="X-Tenant-Id"),
) -> JSONResponse:
    # TODO: this draft computes depth from a cached counter that misses items returned by lease
    # expiry, hides the oldest age and serves any tenant's queues. Review all three.
    return JSONResponse(
        {
            "priority": priority,
            "depth": depth_cache.get(priority, 0),
            "sla_breaches": 0,
        }
    )
`,
      solution: `import time

from fastapi import FastAPI, Header, Query
from fastapi.responses import JSONResponse

app = FastAPI()

PRIORITIES = ["p1", "p2", "p3"]


def queue_depth(tenant: str, priority: str) -> int:
    """Queued items for this tenant and priority, straight from the item store."""
    return store.count(tenant, priority, "queued")


def oldest_age(tenant: str, priority: str):
    """Age in seconds of the oldest queued item, or None when the queue is empty."""
    oldest = store.oldest_queued_at(tenant, priority)
    if oldest is None:
        return None
    return max(0, int(time.time() - oldest))


@app.get("/v1/review/queues/{priority}")
def read_queue(
    priority: str,
    tenant: str = Header(alias="X-Tenant-Id"),
    requested: str | None = Query(default=None, alias="tenant"),
) -> JSONResponse:
    if requested is not None and requested != tenant:
        return JSONResponse({"error": "forbidden"}, status_code=403)
    if priority not in PRIORITIES:
        return JSONResponse({"error": "unknown priority"}, status_code=400)
    return JSONResponse(
        {
            "priority": priority,
            "depth": queue_depth(tenant, priority),
            "oldest_age_seconds": oldest_age(tenant, priority),
            "breach_count": store.count(tenant, priority, "breached"),
            "assignment_states": store.assignment_states(tenant, priority),
        }
    )
`,
    },
    typescript: {
      starter: `/** GET /v1/review/queues/{p}: a model-generated draft that reads a stale cache. */
import Fastify from 'fastify';

export const app = Fastify();

const depthCache: Record<string, number> = {p1: 12, p2: 40, p3: 3};

app.get('/v1/review/queues/:priority', async (request, reply) => {
  // TODO: this draft computes depth from a cached counter that misses items returned by lease
  // expiry, hides the oldest age and serves any tenant's queues. Review all three.
  const priority = request.params['priority'];
  return reply.code(200).send({priority, depth: depthCache[priority] ?? 0, sla_breaches: 0});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/review/queues/{p}: depth, oldest age, breaches and states, scoped to the tenant. */
import Fastify from 'fastify';

export const app = Fastify();

const PRIORITIES = ['p1', 'p2', 'p3'];

function queueDepth(tenant: string, priority: string): number {
  const queued = store.count(tenant, priority, 'queued');
  return queued;
}

function oldestAge(tenant: string, priority: string): number | null {
  const oldest = store.oldestQueuedAt(tenant, priority);
  if (oldest === null) return null;
  return Math.max(0, Math.round(Date.now() / 1000 - oldest));
}

app.get('/v1/review/queues/:priority', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const requested = request.query['tenant'];
  if (typeof requested === 'string' && requested !== tenant)
    return reply.code(403).send({error: 'forbidden'});
  const priority = request.params['priority'];
  if (!PRIORITIES.includes(priority)) return reply.code(400).send({error: 'unknown priority'});
  return reply.code(200).send({
    priority,
    depth: queueDepth(tenant, priority),
    oldest_age_seconds: oldestAge(tenant, priority),
    breachCount: store.count(tenant, priority, 'breached'),
    assignmentStates: store.assignmentStates(tenant, priority),
  });
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

var depthCache = map[string]int{"p1": 12, "p2": 40, "p3": 3}

func readQueue(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	// TODO: this draft computes depth from a cached counter that misses items returned by lease
	// expiry, hides the oldest age and serves any tenant's queues. Review all three.
	priority := r.PathValue("priority")
	body := map[string]any{
		"priority":     priority,
		"depth":        depthCache[priority],
		"sla_breaches": 0,
		"tenant":       tenant,
	}
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode(body)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/review/queues/{priority}", readQueue)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"encoding/json"
	"log"
	"net/http"
	"time"
)

var priorities = map[string]bool{"p1": true, "p2": true, "p3": true}

func queueDepth(tenant, priority string) int {
	depth, _ := store.Count(tenant, priority, "queued")
	return depth
}

func oldestAge(tenant, priority string) any {
	oldest, ok := store.OldestQueuedAt(tenant, priority)
	if !ok {
		return nil
	}
	age := time.Now().Unix() - oldest
	if age < 0 {
		age = 0
	}
	return age
}

func readQueue(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		rw.WriteHeader(http.StatusUnauthorized)
		return
	}
	requested := r.URL.Query().Get("tenant")
	if requested != "" && requested != tenant {
		rw.WriteHeader(http.StatusForbidden)
		return
	}
	priority := r.PathValue("priority")
	if !priorities[priority] {
		rw.WriteHeader(http.StatusBadRequest)
		return
	}
	breaches, _ := store.Count(tenant, priority, "breached")
	states, _ := store.AssignmentStates(tenant, priority)
	body := map[string]any{
		"priority":           priority,
		"depth":              queueDepth(tenant, priority),
		"oldest_age_seconds": oldestAge(tenant, priority),
		"BreachCount":        breaches,
		"AssignmentStates":   states,
	}
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode(body)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/review/queues/{priority}", readQueue)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import akka.http.scaladsl.model.StatusCodes
import akka.http.scaladsl.server.Route
import akka.http.scaladsl.server.Directives._

object Api {
  val DepthCache: Map[String, Int] = Map("p1" -> 12, "p2" -> 40, "p3" -> 3)

  def route: Route =
    path("v1" / "review" / "queues" / Segment) { priority =>
      get {
        // TODO: this draft computes depth from a cached counter that misses items returned by
        // lease expiry, hides the oldest age and serves any tenant's queues. Review all three.
        headerValueByName("X-Tenant-Id") { _ =>
          val body = s"""{"priority":"$priority","depth":\${DepthCache.getOrElse(priority, 0)},"sla_breaches":0}"""
          complete(StatusCodes.OK, body)
        }
      }
    }
}
`,
      solution: `import akka.http.scaladsl.model.StatusCodes
import akka.http.scaladsl.server.Route
import akka.http.scaladsl.server.Directives._

object Api {
  val Priorities: Seq[String] = Seq("p1", "p2", "p3")

  def queueDepth(tenant: String, priority: String): Int = {
    store.count(tenant, priority, "queued")
  }

  def oldestAge(tenant: String, priority: String): String = {
    store.oldestQueuedAt(tenant, priority) match {
      case None      => "null"
      case Some(ts)  => math.max(0L, System.currentTimeMillis() / 1000 - ts).toString
    }
  }

  def route: Route =
    path("v1" / "review" / "queues" / Segment) { priority =>
      get {
        headerValueByName("X-Tenant-Id") { tenant =>
          parameter("tenant".?) { requested =>
            if (requested.exists(_ != tenant)) {
              complete(StatusCodes.Forbidden, "forbidden")
            } else if (!Priorities.contains(priority)) {
              complete(StatusCodes.BadRequest, "unknown priority")
            } else {
              val body =
                s"""{"priority":"$priority","depth":\${queueDepth(tenant, priority)},"oldest_age_seconds":\${oldestAge(tenant, priority)},"breachCount":\${store.count(tenant, priority, "breached")},"assignmentStates":\${store.assignmentStates(tenant, priority)}}"""
              complete(StatusCodes.OK, body)
            }
          }
        }
      }
    }
}
`,
    },
    cpp: {
      starter: `#include <string>
#include <map>
#include <nlohmann/json.hpp>

using json = nlohmann::json;

const std::map<std::string, int> depth_cache = {{"p1", 12}, {"p2", 40}, {"p3", 3}};

int main() {
  httplib::Server svr;
  svr.Get("/v1/review/queues/([^/]+)", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft computes depth from a cached counter that misses items returned by lease
    // expiry, hides the oldest age and serves any tenant's queues. Review all three.
    auto priority = req.matches[1].str();
    auto it = depth_cache.find(priority);
    json body = {
        {"priority", priority},
        {"depth", it == depth_cache.end() ? 0 : it->second},
        {"sla_breaches", 0},
    };
    res.status = 200;
    res.set_content(body.dump(), "application/json");
  });
  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <string>
#include <vector>
#include <algorithm>
#include <chrono>
#include <nlohmann/json.hpp>

using json = nlohmann::json;

const std::vector<std::string> kPriorities = {"p1", "p2", "p3"};

int queueDepth(const std::string& tenant, const std::string& priority) {
  auto depth = store.count(tenant, priority, "queued");
  return depth;
}

json oldestAge(const std::string& tenant, const std::string& priority) {
  long oldest = store.oldestQueuedAt(tenant, priority);
  if (oldest < 0) return json(nullptr);
  long now = std::chrono::system_clock::now().time_since_epoch().count() / 1000000000;
  return json(std::max(0L, now - oldest));
}

int main() {
  httplib::Server svr;
  svr.Get("/v1/review/queues/([^/]+)", [](const httplib::Request& req, httplib::Response& res) {
    auto tenant = req.get_header_value("X-Tenant-Id");
    auto requested = req.get_param_value("tenant");
    if (!requested.empty() && requested != tenant) {
      res.status = 403;
      res.set_content(R"({"error":"forbidden"})", "application/json");
      return;
    }
    auto priority = req.matches[1].str();
    if (std::find(kPriorities.begin(), kPriorities.end(), priority) == kPriorities.end()) {
      res.status = 400;
      res.set_content(R"({"error":"unknown priority"})", "application/json");
      return;
    }
    json body = {
        {"priority", priority},
        {"depth", queueDepth(tenant, priority)},
        {"oldest_age_seconds", oldestAge(tenant, priority)},
        {"breach_count", store.count(tenant, priority, "breached")},
        {"assignment_states", store.assignmentStates(tenant, priority)},
    };
    res.status = 200;
    res.set_content(body.dump(), "application/json");
  });
  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Depth is a fact about the item store, not a cached number. Count the queued items per priority on read, so the items the sweeper returned after a lease expiry are included instead of lost.',
    'The oldest age is what tells an operator where the pain is. Always return it — the age of the oldest queued item, or `null` when the queue is empty — never hide it behind a placeholder.',
    'A queue belongs to one tenant. The `X-Tenant-Id` owns it; a request naming a different tenant’s queue is 403, and the breach count and assignment distribution come from the same store as the depth.',
  ],
  debrief: `The interviewer is testing whether you can review a generated read path, which is where operators make staffing decisions. Three defects are being checked. First, the source of truth: a cached depth counter goes stale exactly when lease expiry returns items to the queue, so the operator under-counts when the queue is most stressed — count from the item store on read. Second, the oldest age: it is the single most actionable number on the page and the draft hides it, so nobody sees the item that has been waiting longest. Third, the tenant scope: a queue read must be scoped to the caller's tenant, or one tenant can read another's review backlog — a cross-tenant leak that looks like a convenience feature in the draft. The subtle point candidates miss is that depth, breach count and assignment distribution must all come from the same store and the same read, or the operator sees a summary that disagrees with itself. Real consoles add per-priority SLA targets beside the age, a trend of depth over time, and a drill-down that lists the items behind each number.`,
};
