import type {Step} from '@/lib/types';

export const triageReadStep: Step = {
  id: 'read',
  title: 'GET /v1/queues/{id}/summary: figures a queue manager can act on',
  concept: 'http',
  guides: ['honest-reads', 'request-boundaries'],
  file: 'read',
  focus: ['client', 'summary', 'db'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/queues/{queue_id}/summary\`: it requires
\`X-Tenant-Id\` (401), looks the queue up (\`store.queue\`, 404 for an unknown id), reads the routing
records of the queue's tenant and name (\`store.routing_records\`, written by step 4's consumer) and
answers \`{queue_id, queue, depth, median_wait_s, fallback_count, fallback_share}\`: depth is the
number of records, the wait figure is the mean of \`now - received_at\`, and the fallback figures
count records whose \`fallback_reason\` is \`classifier_timeout\`. It serves the demo and hides four
flaws.

**Failure mode the checks target.** One tenant reads another tenant's queue by guessing its id;
resolved tickets keep the queue looking deep; one ticket stuck for two hours turns a one-minute wait
into half an hour; and an outage that sent tickets to the ruleset for any reason but a timeout
reads as a healthy classifier.

- A queue the caller's tenant does not own is **404**, the same answer as an unknown id.
- Depth and waits count **open** records only (\`status\`).
- \`median_wait_s\` is the median of the open records' waits in seconds (the mean of the middle two
  for an even count), 0 for an empty queue.
- \`fallback_count\` counts every record with a non-empty \`fallback_reason\`; \`fallback_share\` is
  it over the depth, rounded to three decimals.`,
  sequence: {
    participants: ['Queue manager', 'Queue summary', 'routing store'],
    messages: [
      {
        from: 'Queue manager',
        to: 'Queue summary',
        label: 'GET /v1/queues/q-7/summary · X-Tenant-Id acme',
        kind: 'sync',
      },
      {from: 'Queue summary', to: 'routing store', label: 'queue(q-7)', kind: 'sync'},
      {
        from: 'routing store',
        to: 'Queue summary',
        label: '{tenant: acme, name: billing} · globex → 404',
        kind: 'reply',
      },
      {from: 'Queue summary', to: 'routing store', label: 'routing_records(acme, billing)', kind: 'sync'},
      {
        from: 'routing store',
        to: 'Queue summary',
        label: 'records · status · received_at · fallback_reason',
        kind: 'reply',
      },
      {
        from: 'Queue summary',
        to: 'Queue manager',
        label: '200 {depth, median_wait_s, fallback_count, fallback_share}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Registers GET /v1/queues/{id}/summary',
      detail:
        'Register `GET /v1/queues/{id}/summary`; it answers the queue of the caller and 401 without `X-Tenant-Id`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/queues\/\{queue_id\}\/summary["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/queues\/:queueId\/summary['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/queues\/\{id\}\/summary"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"queues"\s*\/\s*Segment\s*\/\s*"summary"\s*\)/, /\bget\b/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/queues\//]},
      },
    },
    {
      id: 'tenant-scope',
      title: "Answers 404 for another tenant's queue",
      detail:
        "The queue's tenant is compared with the caller's, and a queue the caller does not own is 404 like an unknown one; the records read are the caller's.",
      match: {
        python: {all: [/\[\s*["']tenant["']\s*\]\s*[!=]=\s*tenant/, /\b404\b/]},
        typescript: {all: [/\.tenant\s*[!=]==?\s*tenant/, /\b404\b/]},
        go: {all: [/\.Tenant\s*[!=]=\s*tenant/, /StatusNotFound|\b404\b/]},
        scala: {all: [/\.tenant\s*[!=]=\s*tenant/, /NotFound|\b404\b/]},
        cpp: {all: [/(->|\.)tenant\s*[!=]=\s*tenant/, /\b404\b/]},
      },
    },
    {
      id: 'open-depth',
      title: 'Counts open tickets only',
      detail:
        'Depth and waits are computed over the records whose `status` is `open`; a closed ticket has left the queue.',
      match: {
        python: {all: [/["']open["']/]},
        typescript: {all: [/["']open["']/]},
        go: {all: [/"open"/]},
        scala: {all: [/"open"/]},
        cpp: {all: [/"open"/]},
      },
    },
    {
      id: 'median-wait',
      title: 'Reports the median wait, not the mean',
      detail:
        '`median_wait_s` comes from the sorted waits (the middle one, or the mean of the middle two), so one stuck ticket does not move it.',
      match: {
        python: {all: [/sorted\(|\.sort\(/], none: [/sum\(\s*waits\s*\)/]},
        typescript: {all: [/\.sort\(/], none: [/\.reduce\(/]},
        go: {all: [/sort\.(Slice|Ints|Sort)\(|slices\.Sort/], none: [/float64\(\s*total\s*\)/]},
        scala: {all: [/\.sorted\b/], none: [/\.sum\b/]},
        cpp: {all: [/std::(sort|nth_element)\(/], none: [/std::accumulate\(/]},
      },
    },
    {
      id: 'fallback-share',
      title: 'Counts every fallback reason',
      detail:
        '`fallback_count` and `fallback_share` count every record the ruleset routed (any non-empty `fallback_reason`), not one reason picked by name.',
      match: {
        python: {all: [/fallback_reason/], none: [/classifier_timeout/]},
        typescript: {all: [/fallback_reason/], none: [/classifier_timeout/]},
        go: {all: [/FallbackReason/], none: [/classifier_timeout/]},
        scala: {all: [/fallbackReason/], none: [/classifier_timeout/]},
        cpp: {all: [/fallback_reason/], none: [/classifier_timeout/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

from fastapi import FastAPI, HTTPException, Request

from triage import store  # store.queue(queue_id), store.routing_records(tenant, queue)

app = FastAPI()


@app.get("/v1/queues/{queue_id}/summary")
def summary(queue_id: str, request: Request) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    queue = store.queue(queue_id)
    if queue is None:
        raise HTTPException(status_code=404, detail="no such queue")
    records = store.routing_records(queue["tenant"], queue["name"])
    now = int(time.time())
    waits = [now - record["received_at"] for record in records]
    fallback = sum(1 for record in records if record["fallback_reason"] == "classifier_timeout")
    return {
        "queue_id": queue_id,
        "queue": queue["name"],
        "depth": len(records),
        "median_wait_s": sum(waits) / len(waits) if waits else 0,
        "fallback_count": fallback,
        "fallback_share": round(fallback / len(records), 3) if records else 0.0,
    }
`,
      solution: `import time

from fastapi import FastAPI, HTTPException, Request

from triage import store  # store.queue(queue_id), store.routing_records(tenant, queue)

app = FastAPI()


def median(values: list[int]) -> float:
    ordered = sorted(values)
    if not ordered:
        return 0
    middle = len(ordered) // 2
    return ordered[middle] if len(ordered) % 2 else (ordered[middle - 1] + ordered[middle]) / 2


@app.get("/v1/queues/{queue_id}/summary")
def summary(queue_id: str, request: Request) -> dict:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    queue = store.queue(queue_id)
    if queue is None or queue["tenant"] != tenant:
        raise HTTPException(status_code=404, detail="no such queue")  # another tenant's queue does not exist for this caller
    records = [record for record in store.routing_records(tenant, queue["name"]) if record["status"] == "open"]
    now = int(time.time())
    waits = [now - record["received_at"] for record in records]
    fallback = sum(1 for record in records if record["fallback_reason"])
    return {
        "queue_id": queue_id,
        "queue": queue["name"],
        "depth": len(records),
        "median_wait_s": median(waits),
        "fallback_count": fallback,
        "fallback_share": round(fallback / len(records), 3) if records else 0.0,
    }
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {queue as findQueue, routingRecords} from 'triage/store';

export const app = Fastify();

app.get('/v1/queues/:queueId/summary', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {queueId} = request.params as {queueId: string};
  const queue = await findQueue(queueId);
  if (queue === null) return reply.code(404).send({error: 'no such queue'});
  const records = await routingRecords(queue.tenant, queue.name);
  const now = Math.floor(Date.now() / 1000);
  const waits = records.map(record => now - record.received_at);
  const fallback = records.filter(record => record.fallback_reason === 'classifier_timeout').length;
  return {
    queue_id: queueId,
    queue: queue.name,
    depth: records.length,
    median_wait_s: waits.length ? waits.reduce((a, b) => a + b, 0) / waits.length : 0,
    fallback_count: fallback,
    fallback_share: records.length ? Math.round((fallback / records.length) * 1000) / 1000 : 0,
  };
});
`,
      solution: `import Fastify from 'fastify';

import {queue as findQueue, routingRecords} from 'triage/store';

export const app = Fastify();

app.get('/v1/queues/:queueId/summary', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {queueId} = request.params as {queueId: string};
  const queue = await findQueue(queueId);
  // Another tenant's queue does not exist for this caller.
  if (queue === null || queue.tenant !== tenant) return reply.code(404).send({error: 'no such queue'});
  const records = (await routingRecords(tenant, queue.name)).filter(record => record.status === 'open');
  const now = Math.floor(Date.now() / 1000);
  const waits = records.map(record => now - record.received_at).sort((a, b) => a - b);
  const middle = Math.floor(waits.length / 2);
  const median = waits.length === 0 ? 0 : waits.length % 2 === 1 ? waits[middle] : (waits[middle - 1] + waits[middle]) / 2;
  const fallback = records.filter(record => record.fallback_reason !== '').length;
  return {
    queue_id: queueId,
    queue: queue.name,
    depth: records.length,
    median_wait_s: median,
    fallback_count: fallback,
    fallback_share: records.length ? Math.round((fallback / records.length) * 1000) / 1000 : 0,
  };
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"math"
	"net/http"
	"time"

	"triage/store" // store.Queue(ctx, queueID), store.RoutingRecords(ctx, tenant, queue)
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func queueSummary(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	queueID := r.PathValue("id")
	queue := store.Queue(r.Context(), queueID)
	if queue == nil {
		http.Error(rw, "no such queue", http.StatusNotFound)
		return
	}
	records := store.RoutingRecords(r.Context(), queue.Tenant, queue.Name)
	now := time.Now().Unix()
	var total int64
	fallback := 0
	for _, rec := range records {
		total += now - rec.ReceivedAt
		if rec.FallbackReason == "classifier_timeout" {
			fallback++
		}
	}
	wait, share := 0.0, 0.0
	if len(records) > 0 {
		wait = float64(total) / float64(len(records))
		share = math.Round(float64(fallback)/float64(len(records))*1000) / 1000
	}
	writeJSON(rw, http.StatusOK, map[string]any{"queue_id": queueID, "queue": queue.Name, "depth": len(records), "median_wait_s": wait,
		"fallback_count": fallback, "fallback_share": share})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/queues/{id}/summary", queueSummary)
}
`,
      solution: `package main

import (
	"encoding/json"
	"math"
	"net/http"
	"sort"
	"time"

	"triage/store" // store.Queue(ctx, queueID), store.RoutingRecords(ctx, tenant, queue)
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

// median of the waits: the middle one, or the mean of the middle two; 0 for none.
func median(waits []int64) float64 {
	sort.Slice(waits, func(i, j int) bool { return waits[i] < waits[j] })
	n := len(waits)
	switch {
	case n == 0:
		return 0
	case n%2 == 1:
		return float64(waits[n/2])
	default:
		return float64(waits[n/2-1]+waits[n/2]) / 2
	}
}

func queueSummary(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	queueID := r.PathValue("id")
	queue := store.Queue(r.Context(), queueID)
	if queue == nil || queue.Tenant != tenant {
		http.Error(rw, "no such queue", http.StatusNotFound) // another tenant's queue does not exist for this caller
		return
	}
	now := time.Now().Unix()
	var waits []int64
	fallback := 0
	for _, rec := range store.RoutingRecords(r.Context(), tenant, queue.Name) {
		if rec.Status != "open" {
			continue
		}
		waits = append(waits, now-rec.ReceivedAt)
		if rec.FallbackReason != "" {
			fallback++
		}
	}
	share := 0.0
	if len(waits) > 0 {
		share = math.Round(float64(fallback)/float64(len(waits))*1000) / 1000
	}
	writeJSON(rw, http.StatusOK, map[string]any{"queue_id": queueID, "queue": queue.Name, "depth": len(waits), "median_wait_s": median(waits),
		"fallback_count": fallback, "fallback_share": share})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/queues/{id}/summary", queueSummary)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import triage.Store // Store.queue(queueId), Store.routingRecords(tenant, queue)

object QueueSummary {
  val route: Route = path("v1" / "queues" / Segment / "summary") { queueId =>
    get {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
        case Some(_) =>
          // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
          Store.queue(queueId) match {
            case None => complete(StatusCodes.NotFound -> "no such queue")
            case Some(queue) =>
              val records = Store.routingRecords(queue.tenant, queue.name)
              val now = System.currentTimeMillis() / 1000
              val waits = records.map(now - _.receivedAt)
              val fallback = records.count(_.fallbackReason == "classifier_timeout")
              val wait = if (waits.isEmpty) 0.0 else waits.sum.toDouble / waits.size
              val share = if (records.isEmpty) 0.0 else math.round(fallback * 1000.0 / records.size) / 1000.0
              val body = JsObject("queue_id" -> JsString(queueId), "queue" -> JsString(queue.name), "depth" -> JsNumber(records.size),
                "median_wait_s" -> JsNumber(wait), "fallback_count" -> JsNumber(fallback), "fallback_share" -> JsNumber(share))
              complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint)))
          }
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import triage.Store // Store.queue(queueId), Store.routingRecords(tenant, queue)

object QueueSummary {
  /** The middle wait, or the mean of the middle two; 0 for none. */
  def median(waits: Seq[Long]): Double = {
    val ordered = waits.sorted
    val n = ordered.size
    if (n == 0) 0.0
    else if (n % 2 == 1) ordered(n / 2).toDouble
    else (ordered(n / 2 - 1) + ordered(n / 2)) / 2.0
  }

  val route: Route = path("v1" / "queues" / Segment / "summary") { queueId =>
    get {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
        case Some(tenant) =>
          Store.queue(queueId) match {
            case Some(queue) if queue.tenant == tenant =>
              val records = Store.routingRecords(tenant, queue.name).filter(_.status == "open")
              val now = System.currentTimeMillis() / 1000
              val fallback = records.count(_.fallbackReason.nonEmpty)
              val share = if (records.isEmpty) 0.0 else math.round(fallback * 1000.0 / records.size) / 1000.0
              val body = JsObject("queue_id" -> JsString(queueId), "queue" -> JsString(queue.name), "depth" -> JsNumber(records.size),
                "median_wait_s" -> JsNumber(median(records.map(now - _.receivedAt))), "fallback_count" -> JsNumber(fallback),
                "fallback_share" -> JsNumber(share))
              complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint)))
            case _ => complete(StatusCodes.NotFound -> "no such queue") // another tenant's queue does not exist for this caller
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
#include <cmath>
#include <numeric>
#include <string>
#include <vector>

#include "triage/store.h"  // store::queue(queue_id), store::routingRecords(tenant, queue)

using json = nlohmann::json;

void queue_summary(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content("X-Tenant-Id is required", "text/plain");
    return;
  }
  const std::string queue_id = req.matches[1];
  const auto queue = store::queue(queue_id);
  if (!queue) {
    res.status = 404;
    res.set_content("no such queue", "text/plain");
    return;
  }
  const auto records = store::routingRecords(queue->tenant, queue->name);
  const long long now = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  std::vector<long long> waits;
  int fallback = 0;
  for (const auto& r : records) {
    waits.push_back(now - r.received_at);
    if (r.fallback_reason == "classifier_timeout") ++fallback;
  }
  const double wait = waits.empty() ? 0 : static_cast<double>(std::accumulate(waits.begin(), waits.end(), 0LL)) / waits.size();
  const double share = records.empty() ? 0 : std::round(1000.0 * fallback / records.size()) / 1000;
  res.set_content(json{{"queue_id", queue_id}, {"queue", queue->name}, {"depth", records.size()}, {"median_wait_s", wait},
                       {"fallback_count", fallback}, {"fallback_share", share}}
                      .dump(),
                  "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/queues/([\\w-]+)/summary)", queue_summary); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <string>
#include <vector>

#include "triage/store.h"  // store::queue(queue_id), store::routingRecords(tenant, queue)

using json = nlohmann::json;

// The middle wait, or the mean of the middle two; 0 for none.
double median(std::vector<long long> waits) {
  std::sort(waits.begin(), waits.end());
  const size_t n = waits.size();
  if (n == 0) return 0;
  return n % 2 == 1 ? static_cast<double>(waits[n / 2]) : (waits[n / 2 - 1] + waits[n / 2]) / 2.0;
}

void queue_summary(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content("X-Tenant-Id is required", "text/plain");
    return;
  }
  const std::string queue_id = req.matches[1];
  const auto queue = store::queue(queue_id);
  if (!queue || queue->tenant != tenant) {
    res.status = 404;  // another tenant's queue does not exist for this caller
    res.set_content("no such queue", "text/plain");
    return;
  }
  const long long now = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  std::vector<long long> waits;
  int fallback = 0;
  for (const auto& r : store::routingRecords(tenant, queue->name)) {
    if (r.status != "open") continue;
    waits.push_back(now - r.received_at);
    if (!r.fallback_reason.empty()) ++fallback;
  }
  const double share = waits.empty() ? 0 : std::round(1000.0 * fallback / waits.size()) / 1000;
  res.set_content(json{{"queue_id", queue_id}, {"queue", queue->name}, {"depth", waits.size()}, {"median_wait_s", median(waits)},
                       {"fallback_count", fallback}, {"fallback_share", share}}
                      .dump(),
                  "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/queues/([\\w-]+)/summary)", queue_summary); }
`,
    },
  },
  harness: {
    python: `import time

from triage import store


def _api(ctx):
    return ctx.client(ctx.load("read").app)


def _seed(tenant, queue, ticket_id, wait, reason="", closed=False):
    """A routed ticket that has waited wait seconds."""
    store.record_routing({"ticket_id": ticket_id, "tenant": tenant, "queue": queue, "priority": "normal", "confidence": 0.9, "fallback_reason": reason, "received_at": int(time.time()) - wait})
    if closed:
        store.close_ticket(tenant, ticket_id)


async def _summary(ctx, queue_id, tenant="acme"):
    async with _api(ctx) as c:
        r = await c.get(f"/v1/queues/{queue_id}/summary", headers={"X-Tenant-Id": tenant} if tenant else {})
    return r


async def check_route(ctx):
    queue_id = store.create_queue("acme", "billing")
    _seed("acme", "billing", "t-1", 60)
    _seed("acme", "billing", "t-2", 120)
    r = await _summary(ctx, queue_id)
    assert r.status_code == 200, f"GET /v1/queues/{queue_id}/summary answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("queue_id") == queue_id and body.get("queue") == "billing" and body.get("depth") == 2, f"acme's billing queue holds two open tickets, the summary says {body}"
    r = await _summary(ctx, queue_id, tenant="")
    assert r.status_code == 401, f"a summary without X-Tenant-Id answered {r.status_code}, expected 401"


async def check_tenant_scope(ctx):
    acme = store.create_queue("acme", "billing")
    globex = store.create_queue("globex", "billing")
    _seed("acme", "billing", "t-1", 60)
    _seed("acme", "billing", "t-2", 90)
    _seed("globex", "billing", "t-9", 30)
    r = await _summary(ctx, acme, tenant="globex")
    assert r.status_code == 404, f"globex asked for acme's queue {acme} and got {r.status_code} {r.text}: a queue the caller does not own is 404, the same as an unknown id"
    r = await _summary(ctx, "q-404")
    assert r.status_code == 404, f"an unknown queue id answered {r.status_code}, expected 404"
    r = await _summary(ctx, globex, tenant="globex")
    assert r.status_code == 200 and r.json().get("depth") == 1, f"globex's own billing queue holds one ticket, got {r.status_code} {r.text}"


async def check_open_depth(ctx):
    queue_id = store.create_queue("acme", "billing")
    for i, wait in enumerate((30, 60, 90)):
        _seed("acme", "billing", f"t-{i}", wait)
    _seed("acme", "billing", "t-closed-1", 5000, closed=True)
    _seed("acme", "billing", "t-closed-2", 9000, closed=True)
    _seed("acme", "delivery", "t-other", 10)
    r = await _summary(ctx, queue_id)
    body = r.json()
    assert body.get("depth") == 3, f"acme's billing queue holds 3 open tickets and 2 closed ones, the summary says depth {body.get('depth')}: a closed ticket has left the queue"
    assert abs(body.get("median_wait_s", -1) - 60) <= 1, f"the open tickets waited 30, 60 and 90 s, the summary says median_wait_s {body.get('median_wait_s')}: closed tickets do not wait"


async def check_median_wait(ctx):
    queue_id = store.create_queue("acme", "billing")
    for i, wait in enumerate((30, 60, 90, 7200)):
        _seed("acme", "billing", f"t-{i}", wait)
    body = (await _summary(ctx, queue_id)).json()
    assert abs(body.get("median_wait_s", -1) - 75) <= 1, f"four tickets waited 30, 60, 90 and 7200 s: the median is 75, the summary says {body.get('median_wait_s')}. A mean is dragged by the one stuck ticket"
    _seed("acme", "billing", "t-4", 120)
    body = (await _summary(ctx, queue_id)).json()
    assert abs(body.get("median_wait_s", -1) - 90) <= 1, f"five tickets waited 30, 60, 90, 120 and 7200 s: the median is 90, the summary says {body.get('median_wait_s')}"
    empty = store.create_queue("acme", "account")
    body = (await _summary(ctx, empty)).json()
    assert body.get("depth") == 0 and body.get("median_wait_s") == 0, f"an empty queue has depth 0 and median_wait_s 0, the summary says {body}"


async def check_fallback_share(ctx):
    queue_id = store.create_queue("acme", "billing")
    for i, reason in enumerate(("", "classifier_timeout", "classifier_unavailable", "breaker_open")):
        _seed("acme", "billing", f"t-{i}", 60, reason)
    body = (await _summary(ctx, queue_id)).json()
    assert body.get("fallback_count") == 3, f"three of four tickets were routed by the rules (a timeout, an unavailable classifier, an open breaker): fallback_count must be 3, the summary says {body.get('fallback_count')}"
    assert abs(body.get("fallback_share", -1) - 0.75) < 0.001, f"fallback_share must be 3 of 4 = 0.75, the summary says {body.get('fallback_share')}"
`,
    typescript: `function api(ctx) {
  return {c: ctx.client(ctx.load('read').app), store: ctx.load('/support/triage/store.ts')};
}

/** A routed ticket that has waited wait seconds. */
async function seed(ctx, store, tenant: string, queue: string, ticketId: string, wait: number, reason = '', closed = false): Promise<void> {
  const receivedAt = Math.floor(ctx.clock.now() / 1000) - wait;
  await store.recordRouting({ticket_id: ticketId, tenant, queue, priority: 'normal', confidence: 0.9, fallback_reason: reason, received_at: receivedAt});
  if (closed) await store.closeTicket(tenant, ticketId);
}

const summary = (c, queueId: string, tenant = 'acme') => c.get(\`/v1/queues/\${queueId}/summary\`, {headers: tenant ? {'X-Tenant-Id': tenant} : {}});

export async function check_route(ctx) {
  const {c, store} = api(ctx);
  const queueId = await store.createQueue('acme', 'billing');
  await seed(ctx, store, 'acme', 'billing', 't-1', 60);
  await seed(ctx, store, 'acme', 'billing', 't-2', 120);
  let r = await summary(c, queueId);
  assert.equal(r.status, 200, \`GET /v1/queues/\${queueId}/summary answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.queue_id === queueId && body.queue === 'billing' && body.depth === 2, \`acme's billing queue holds two open tickets, the summary says \${r.text}\`);
  r = await summary(c, queueId, '');
  assert.equal(r.status, 401, \`a summary without X-Tenant-Id answered \${r.status}, expected 401\`);
}

export async function check_tenant_scope(ctx) {
  const {c, store} = api(ctx);
  const acme = await store.createQueue('acme', 'billing');
  const globex = await store.createQueue('globex', 'billing');
  await seed(ctx, store, 'acme', 'billing', 't-1', 60);
  await seed(ctx, store, 'acme', 'billing', 't-2', 90);
  await seed(ctx, store, 'globex', 'billing', 't-9', 30);
  let r = await summary(c, acme, 'globex');
  assert.equal(r.status, 404, \`globex asked for acme's queue \${acme} and got \${r.status} \${r.text}: a queue the caller does not own is 404, the same as an unknown id\`);
  r = await summary(c, 'q-404');
  assert.equal(r.status, 404, \`an unknown queue id answered \${r.status}, expected 404\`);
  r = await summary(c, globex, 'globex');
  assert(r.status === 200 && r.json().depth === 1, \`globex's own billing queue holds one ticket, got \${r.status} \${r.text}\`);
}

export async function check_open_depth(ctx) {
  const {c, store} = api(ctx);
  const queueId = await store.createQueue('acme', 'billing');
  for (const [i, wait] of [30, 60, 90].entries()) await seed(ctx, store, 'acme', 'billing', \`t-\${i}\`, wait);
  await seed(ctx, store, 'acme', 'billing', 't-closed-1', 5000, '', true);
  await seed(ctx, store, 'acme', 'billing', 't-closed-2', 9000, '', true);
  await seed(ctx, store, 'acme', 'delivery', 't-other', 10);
  const body = (await summary(c, queueId)).json();
  assert.equal(body.depth, 3, \`acme's billing queue holds 3 open tickets and 2 closed ones, the summary says depth \${body.depth}: a closed ticket has left the queue\`);
  assert(Math.abs(body.median_wait_s - 60) <= 1, \`the open tickets waited 30, 60 and 90 s, the summary says median_wait_s \${body.median_wait_s}: closed tickets do not wait\`);
}

export async function check_median_wait(ctx) {
  const {c, store} = api(ctx);
  const queueId = await store.createQueue('acme', 'billing');
  for (const [i, wait] of [30, 60, 90, 7200].entries()) await seed(ctx, store, 'acme', 'billing', \`t-\${i}\`, wait);
  let body = (await summary(c, queueId)).json();
  assert(Math.abs(body.median_wait_s - 75) <= 1, \`four tickets waited 30, 60, 90 and 7200 s: the median is 75, the summary says \${body.median_wait_s}. A mean is dragged by the one stuck ticket\`);
  await seed(ctx, store, 'acme', 'billing', 't-4', 120);
  body = (await summary(c, queueId)).json();
  assert(Math.abs(body.median_wait_s - 90) <= 1, \`five tickets waited 30, 60, 90, 120 and 7200 s: the median is 90, the summary says \${body.median_wait_s}\`);
  const empty = await store.createQueue('acme', 'account');
  body = (await summary(c, empty)).json();
  assert(body.depth === 0 && body.median_wait_s === 0, \`an empty queue has depth 0 and median_wait_s 0, the summary says \${JSON.stringify(body)}\`);
}

export async function check_fallback_share(ctx) {
  const {c, store} = api(ctx);
  const queueId = await store.createQueue('acme', 'billing');
  for (const [i, reason] of ['', 'classifier_timeout', 'classifier_unavailable', 'breaker_open'].entries()) await seed(ctx, store, 'acme', 'billing', \`t-\${i}\`, 60, reason);
  const body = (await summary(c, queueId)).json();
  assert.equal(body.fallback_count, 3, \`three of four tickets were routed by the rules (a timeout, an unavailable classifier, an open breaker): fallback_count must be 3, the summary says \${body.fallback_count}\`);
  assert(Math.abs(body.fallback_share - 0.75) < 0.001, \`fallback_share must be 3 of 4 = 0.75, the summary says \${body.fallback_share}\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"net/http"

	"triage/store"

	"leetbuild/harness"
)

var readBg = context.Background()

func summaryAPI(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

// seed records a routed ticket that has waited wait seconds.
func seed(ctx *harness.Ctx, tenant, queue, ticketID string, wait int64, reason string, closed bool) {
	r := store.Routing{TicketID: ticketID, Tenant: tenant, Queue: queue, Priority: "normal", Confidence: 0.9, FallbackReason: reason, ReceivedAt: ctx.Clock.Now()/1000 - wait}
	ctx.NoError(store.RecordRouting(readBg, r), "recording %s", ticketID)
	if closed {
		store.CloseTicket(readBg, tenant, ticketID)
	}
}

func summaryOf(ctx *harness.Ctx, queueID, tenant string) (*harness.Response, map[string]any) {
	var header []string
	if tenant != "" {
		header = []string{"X-Tenant-Id", tenant}
	}
	r := summaryAPI(ctx).Get("/v1/queues/"+queueID+"/summary", header...)
	if r.Status != 200 {
		return r, nil
	}
	body, _ := r.JSON().(map[string]any)
	return r, body
}

func number(body map[string]any, field string) float64 {
	v, ok := body[field].(float64)
	if !ok {
		return -1
	}
	return v
}

func near(got, want float64) bool { return got >= want-1 && got <= want+1 }

func CheckRoute(ctx *harness.Ctx) {
	queueID := store.CreateQueue(readBg, "acme", "billing")
	seed(ctx, "acme", "billing", "t-1", 60, "", false)
	seed(ctx, "acme", "billing", "t-2", 120, "", false)
	r, body := summaryOf(ctx, queueID, "acme")
	ctx.Equal(r.Status, 200, "GET /v1/queues/%s/summary (%s)", queueID, r.Text())
	ctx.Assert(body["queue_id"] == queueID && body["queue"] == "billing" && number(body, "depth") == 2, "acme's billing queue holds two open tickets, the summary says %v", body)
	r, _ = summaryOf(ctx, queueID, "")
	ctx.Equal(r.Status, 401, "a summary without X-Tenant-Id")
}

func CheckTenantScope(ctx *harness.Ctx) {
	acme := store.CreateQueue(readBg, "acme", "billing")
	globex := store.CreateQueue(readBg, "globex", "billing")
	seed(ctx, "acme", "billing", "t-1", 60, "", false)
	seed(ctx, "acme", "billing", "t-2", 90, "", false)
	seed(ctx, "globex", "billing", "t-9", 30, "", false)
	r, _ := summaryOf(ctx, acme, "globex")
	ctx.Assert(r.Status == 404, "globex asked for acme's queue %s and got %d %s: a queue the caller does not own is 404, the same as an unknown id", acme, r.Status, r.Text())
	r, _ = summaryOf(ctx, "q-404", "acme")
	ctx.Equal(r.Status, 404, "an unknown queue id")
	r, body := summaryOf(ctx, globex, "globex")
	ctx.Assert(r.Status == 200 && number(body, "depth") == 1, "globex's own billing queue holds one ticket, got %d %s", r.Status, r.Text())
}

func CheckOpenDepth(ctx *harness.Ctx) {
	queueID := store.CreateQueue(readBg, "acme", "billing")
	for i, wait := range []int64{30, 60, 90} {
		seed(ctx, "acme", "billing", fmt.Sprintf("t-%d", i), wait, "", false)
	}
	seed(ctx, "acme", "billing", "t-closed-1", 5000, "", true)
	seed(ctx, "acme", "billing", "t-closed-2", 9000, "", true)
	seed(ctx, "acme", "delivery", "t-other", 10, "", false)
	_, body := summaryOf(ctx, queueID, "acme")
	ctx.Equal(number(body, "depth"), 3.0, "acme's billing queue holds 3 open tickets and 2 closed ones: a closed ticket has left the queue; the depth")
	ctx.Assert(near(number(body, "median_wait_s"), 60), "the open tickets waited 30, 60 and 90 s, the summary says median_wait_s %v: closed tickets do not wait", body["median_wait_s"])
}

func CheckMedianWait(ctx *harness.Ctx) {
	queueID := store.CreateQueue(readBg, "acme", "billing")
	for i, wait := range []int64{30, 60, 90, 7200} {
		seed(ctx, "acme", "billing", fmt.Sprintf("t-%d", i), wait, "", false)
	}
	_, body := summaryOf(ctx, queueID, "acme")
	ctx.Assert(near(number(body, "median_wait_s"), 75), "four tickets waited 30, 60, 90 and 7200 s: the median is 75, the summary says %v. A mean is dragged by the one stuck ticket", body["median_wait_s"])
	seed(ctx, "acme", "billing", "t-4", 120, "", false)
	_, body = summaryOf(ctx, queueID, "acme")
	ctx.Assert(near(number(body, "median_wait_s"), 90), "five tickets waited 30, 60, 90, 120 and 7200 s: the median is 90, the summary says %v", body["median_wait_s"])
	empty := store.CreateQueue(readBg, "acme", "account")
	_, body = summaryOf(ctx, empty, "acme")
	ctx.Assert(number(body, "depth") == 0 && number(body, "median_wait_s") == 0, "an empty queue has depth 0 and median_wait_s 0, the summary says %v", body)
}

func CheckFallbackShare(ctx *harness.Ctx) {
	queueID := store.CreateQueue(readBg, "acme", "billing")
	for i, reason := range []string{"", "classifier_timeout", "classifier_unavailable", "breaker_open"} {
		seed(ctx, "acme", "billing", fmt.Sprintf("t-%d", i), 60, reason, false)
	}
	_, body := summaryOf(ctx, queueID, "acme")
	ctx.Equal(number(body, "fallback_count"), 3.0, "three of four tickets were routed by the rules (a timeout, an unavailable classifier, an open breaker); fallback_count")
	share := number(body, "fallback_share")
	ctx.Assert(share > 0.749 && share < 0.751, "fallback_share must be 3 of 4 = 0.75, the summary says %v", body["fallback_share"])
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <cmath>
#include <string>
#include <vector>

namespace {

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

// A routed ticket that has waited wait seconds.
void seed(harness::Ctx& ctx, const std::string& tenant, const std::string& queue, const std::string& ticket_id, long long wait,
          const std::string& reason = "", bool closed = false) {
  store::recordRouting({{"ticket_id", ticket_id}, {"tenant", tenant}, {"queue", queue}, {"priority", "normal"}, {"confidence", 0.9},
                        {"fallback_reason", reason}, {"received_at", ctx.Clock.Now() / 1000 - wait}});
  if (closed) store::closeTicket(tenant, ticket_id);
}

harness::Response summary(harness::Ctx& ctx, const std::string& queue_id, const std::string& tenant = "acme") {
  auto c = api(ctx);
  const std::string path = "/v1/queues/" + queue_id + "/summary";
  return tenant.empty() ? c.Get(path) : c.Get(path, "X-Tenant-Id", tenant);
}

nlohmann::json body(const harness::Response& r) { return nlohmann::json::parse(r.Text(), nullptr, false); }

double number(const nlohmann::json& b, const std::string& field) {
  return b.is_object() && b.contains(field) && b[field].is_number() ? b[field].get<double>() : -1;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  const std::string queue_id = store::createQueue("acme", "billing");
  seed(ctx, "acme", "billing", "t-1", 60);
  seed(ctx, "acme", "billing", "t-2", 120);
  auto r = summary(ctx, queue_id);
  ctx.Equal(r.Status, 200, "GET /v1/queues/%s/summary (%s)", queue_id, r.Text());
  const auto b = body(r);
  ctx.Assert(b.value("queue_id", "") == queue_id && b.value("queue", "") == "billing" && number(b, "depth") == 2, "acme's billing queue holds two open tickets, the summary says %s", r.Text());
  r = summary(ctx, queue_id, "");
  ctx.Equal(r.Status, 401, "a summary without X-Tenant-Id");
}

void CheckTenantScope(harness::Ctx& ctx) {
  const std::string acme = store::createQueue("acme", "billing");
  const std::string globex = store::createQueue("globex", "billing");
  seed(ctx, "acme", "billing", "t-1", 60);
  seed(ctx, "acme", "billing", "t-2", 90);
  seed(ctx, "globex", "billing", "t-9", 30);
  auto r = summary(ctx, acme, "globex");
  ctx.Assert(r.Status == 404, "globex asked for acme's queue %s and got %d %s: a queue the caller does not own is 404, the same as an unknown id", acme, r.Status, r.Text());
  r = summary(ctx, "q-404");
  ctx.Equal(r.Status, 404, "an unknown queue id");
  r = summary(ctx, globex, "globex");
  ctx.Assert(r.Status == 200 && number(body(r), "depth") == 1, "globex's own billing queue holds one ticket, got %d %s", r.Status, r.Text());
}

void CheckOpenDepth(harness::Ctx& ctx) {
  const std::string queue_id = store::createQueue("acme", "billing");
  const std::vector<long long> waits = {30, 60, 90};
  for (size_t i = 0; i < waits.size(); ++i) seed(ctx, "acme", "billing", "t-" + std::to_string(i), waits[i]);
  seed(ctx, "acme", "billing", "t-closed-1", 5000, "", true);
  seed(ctx, "acme", "billing", "t-closed-2", 9000, "", true);
  seed(ctx, "acme", "delivery", "t-other", 10);
  const auto b = body(summary(ctx, queue_id));
  ctx.Equal(number(b, "depth"), 3, "acme's billing queue holds 3 open tickets and 2 closed ones: a closed ticket has left the queue; the depth");
  ctx.Assert(std::fabs(number(b, "median_wait_s") - 60) <= 1, "the open tickets waited 30, 60 and 90 s, the summary says median_wait_s %v: closed tickets do not wait", number(b, "median_wait_s"));
}

void CheckMedianWait(harness::Ctx& ctx) {
  const std::string queue_id = store::createQueue("acme", "billing");
  const std::vector<long long> waits = {30, 60, 90, 7200};
  for (size_t i = 0; i < waits.size(); ++i) seed(ctx, "acme", "billing", "t-" + std::to_string(i), waits[i]);
  auto b = body(summary(ctx, queue_id));
  ctx.Assert(std::fabs(number(b, "median_wait_s") - 75) <= 1, "four tickets waited 30, 60, 90 and 7200 s: the median is 75, the summary says %v. A mean is dragged by the one stuck ticket", number(b, "median_wait_s"));
  seed(ctx, "acme", "billing", "t-4", 120);
  b = body(summary(ctx, queue_id));
  ctx.Assert(std::fabs(number(b, "median_wait_s") - 90) <= 1, "five tickets waited 30, 60, 90, 120 and 7200 s: the median is 90, the summary says %v", number(b, "median_wait_s"));
  const std::string empty = store::createQueue("acme", "account");
  b = body(summary(ctx, empty));
  ctx.Assert(number(b, "depth") == 0 && number(b, "median_wait_s") == 0, "an empty queue has depth 0 and median_wait_s 0, the summary says %s", b.dump());
}

void CheckFallbackShare(harness::Ctx& ctx) {
  const std::string queue_id = store::createQueue("acme", "billing");
  const std::vector<std::string> reasons = {"", "classifier_timeout", "classifier_unavailable", "breaker_open"};
  for (size_t i = 0; i < reasons.size(); ++i) seed(ctx, "acme", "billing", "t-" + std::to_string(i), 60, reasons[i]);
  const auto b = body(summary(ctx, queue_id));
  ctx.Equal(number(b, "fallback_count"), 3, "three of four tickets were routed by the rules (a timeout, an unavailable classifier, an open breaker); fallback_count");
  ctx.Assert(std::fabs(number(b, "fallback_share") - 0.75) < 0.001, "fallback_share must be 3 of 4 = 0.75, the summary says %v", number(b, "fallback_share"));
}
`,
  },
  hints: [
    "Ask for another tenant's queue id and the summary answers; close half a queue's tickets and its depth does not move; add one ticket that waited two hours and the wait jumps from a minute to half an hour.",
    "The records are read for the queue's tenant, not the caller's, every record counts whatever its status, the wait is a sum over a count, and the fallback filter names one reason.",
    'Answer 404 when `queue["tenant"] != tenant` and read the caller\'s records; keep `status == "open"`; take the middle of `sorted(waits)` (the mean of the middle two for an even count); count any non-empty `fallback_reason`.',
  ],
  debrief: `A summary is only as honest as the records it is computed from, which is why it reads them rather than a counter: it inherits the consumer's idempotence and every correction a record receives. Comparing the queue's tenant before reading anything, and answering 404 rather than 403, keeps the queue ids of one tenant from telling another anything. The median is the figure a manager staffs by, because waits are long-tailed and a mean answers to the worst ticket. Counting every fallback reason makes a classifier outage visible whatever its cause. Production dashboards add a high percentile beside the median, an oldest-ticket age for the tail itself, and a precomputed rollup per minute once a queue holds too many records to scan per request.`,
};
