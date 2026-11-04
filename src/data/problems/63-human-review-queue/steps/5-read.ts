import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/review/queues/{tenant}/{priority}: numbers an operator can staff from',
  concept: 'http',
  file: 'read',
  focus: ['console', 'queue', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/review/queues/{tenant}/{priority}\` from the review
store (\`review.store\`, provided): \`depth\` is \`store.enqueued_total(tenant, priority)\`,
\`oldest_age_seconds\` is the age of the last item in \`store.queued(tenant, priority)\`, and
\`sla_breaches\` counts the queued items whose \`breached\` field is \`"1"\`. It answers any caller.
The dashboard renders; it hides 4 flaws.

**Failure mode the checks target.** The queue drains and the depth keeps climbing; the oldest item
has waited an hour and the age says a minute; a p1 item that sat untouched past its SLA is not a
breach because nobody reclaimed it; one tenant reads another's backlog.

- \`depth\` is the number of items in the queue now.
- \`oldest_age_seconds\` is now minus the smallest \`enqueued_at\` in the queue (\`null\` when empty);
  a reclaimed item can sit behind newer ones.
- \`sla_breaches\` counts queued items whose \`sla_deadline\` has passed.
- \`X-Tenant-Id\` must name the path's tenant: missing is **401**, another tenant **403**.`,
  sequence: {
    participants: ['Operator', 'Review Queue', 'Review store'],
    messages: [
      {from: 'Operator', to: 'Review Queue', label: 'GET /v1/review/queues/t1/p1 · X-Tenant-Id', kind: 'sync'},
      {from: 'Review Queue', to: 'Review Queue', label: 'caller owns t1? else 401 / 403', kind: 'sync'},
      {from: 'Review Queue', to: 'Review store', label: 'queued(t1, p1)', kind: 'sync'},
      {from: 'Review store', to: 'Review Queue', label: 'items · enqueued_at · sla_deadline', kind: 'reply'},
      {from: 'Review Queue', to: 'Operator', label: '200 {depth, oldest_age_seconds, sla_breaches}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'depth',
      title: 'Depth is what is in the queue now',
      detail:
        '`depth` counts the items `queued` returns; the starter reports the billing counter `enqueued_total`, which only ever grows.',
      match: {
        python: {all: [/len\(items\)/], none: [/enqueued_total/]},
        typescript: {all: [/items\.length/], none: [/enqueuedTotal/]},
        go: {all: [/len\(items\)/], none: [/EnqueuedTotal/]},
        scala: {all: [/items\.(size|length)/], none: [/enqueuedTotal/]},
        cpp: {all: [/items\.size\(\)/], none: [/enqueuedTotal/]},
      },
    },
    {
      id: 'oldest-age',
      title: 'The oldest age is the oldest item',
      detail:
        '`oldest_age_seconds` is measured from the smallest `enqueued_at` in the queue, `null` when it is empty; the starter measures the last item in the list, the newest.',
      match: {
        python: {all: [/min\(/, /enqueued_at/], none: [/items\[-1\]/]},
        typescript: {
          all: [/Math\.min\(|\.reduce\(/, /enqueued_at/],
          none: [/items\[items\.length - 1\]|items\.at\(-1\)/],
        },
        go: {all: [/enqueued_at/, /<\s*oldest|oldest\s*>/], none: [/items\[len\(items\)\s*-\s*1\]/]},
        scala: {all: [/\.min\b|minOption/, /enqueued_at/], none: [/items\.last/]},
        cpp: {all: [/std::min/, /enqueued_at/], none: [/items\.back\(\)/]},
      },
    },
    {
      id: 'sla-breaches',
      title: 'A breach is a deadline passed, marked or not',
      detail:
        '`sla_breaches` counts queued items whose `sla_deadline` is past; the starter counts only items `reclaim_expired` marked, missing every item that breached while waiting.',
      match: {
        python: {all: [/sla_deadline/], none: [/\[["']breached["']\]\s*==/]},
        typescript: {all: [/sla_deadline/], none: [/\.breached\s*===/]},
        go: {all: [/sla_deadline/], none: [/\["breached"\]\s*==/]},
        scala: {all: [/sla_deadline/], none: [/\("breached"\)\s*==/]},
        cpp: {all: [/sla_deadline/], none: [/at\("breached"\)\s*==/]},
      },
    },
    {
      id: 'tenant-scope',
      title: 'Only the tenant reads its queue',
      detail:
        "A missing `X-Tenant-Id` is **401** and one that does not name the path's tenant **403**; the starter serves any caller.",
      match: {
        python: {all: [/x-tenant-id/i, /\b401\b/, /\b403\b/]},
        typescript: {all: [/x-tenant-id/i, /code\(\s*401\s*\)/, /code\(\s*403\s*\)/]},
        go: {all: [/X-Tenant-Id/i, /StatusUnauthorized|\b401\b/, /StatusForbidden|\b403\b/]},
        scala: {all: [/X-Tenant-Id/i, /Unauthorized/, /Forbidden/]},
        cpp: {all: [/X-Tenant-Id/i, /\b401\b/, /\b403\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from review import store  # queued, enqueued_total

app = FastAPI()


@app.get("/v1/review/queues/{tenant}/{priority}")
def queue_stats(tenant: str, priority: str, request: Request) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    now = int(time.time())
    items = store.queued(tenant, priority)
    return JSONResponse(
        {
            "tenant": tenant,
            "priority": priority,
            "depth": store.enqueued_total(tenant, priority),
            "oldest_age_seconds": now - int(items[-1]["enqueued_at"]) if items else None,
            "sla_breaches": sum(1 for item in items if item["breached"] == "1"),
        }
    )
`,
      solution: `import time

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from review import store  # queued, enqueued_total

app = FastAPI()


@app.get("/v1/review/queues/{tenant}/{priority}")
def queue_stats(tenant: str, priority: str, request: Request) -> JSONResponse:
    caller = request.headers.get("x-tenant-id", "")
    if not caller:
        return JSONResponse({"error": "X-Tenant-Id is required"}, status_code=401)
    if caller != tenant:
        return JSONResponse({"error": "not your queue"}, status_code=403)
    now = int(time.time())
    # Everything comes from the queue as it is now.
    items = store.queued(tenant, priority)
    oldest = min((int(item["enqueued_at"]) for item in items), default=None)
    return JSONResponse(
        {
            "tenant": tenant,
            "priority": priority,
            "depth": len(items),
            "oldest_age_seconds": None if oldest is None else now - oldest,
            # A breach is a deadline that passed, whether or not a sweep has marked it yet.
            "sla_breaches": sum(1 for item in items if now >= int(item["sla_deadline"])),
        }
    )
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {enqueuedTotal, queued} from 'review/store';

export const app = Fastify();

app.get('/v1/review/queues/:tenant/:priority', async request => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const {tenant, priority} = request.params as {tenant: string; priority: string};
  const now = Math.floor(Date.now() / 1000);
  const items = await queued(tenant, priority);
  return {
    tenant,
    priority,
    depth: await enqueuedTotal(tenant, priority),
    oldest_age_seconds: items.length > 0 ? now - Number(items[items.length - 1].enqueued_at) : null,
    sla_breaches: items.filter(item => item.breached === '1').length,
  };
});
`,
      solution: `import Fastify from 'fastify';

import {queued} from 'review/store';

export const app = Fastify();

app.get('/v1/review/queues/:tenant/:priority', async (request, reply) => {
  const {tenant, priority} = request.params as {tenant: string; priority: string};
  const caller = request.headers['x-tenant-id'];
  if (typeof caller !== 'string' || caller === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  if (caller !== tenant) return reply.code(403).send({error: 'not your queue'});
  const now = Math.floor(Date.now() / 1000);
  // Everything comes from the queue as it is now.
  const items = await queued(tenant, priority);
  const oldest = items.length > 0 ? Math.min(...items.map(item => Number(item.enqueued_at))) : null;
  return {
    tenant,
    priority,
    depth: items.length,
    oldest_age_seconds: oldest === null ? null : now - oldest,
    // A breach is a deadline that passed, whether or not a sweep has marked it yet.
    sla_breaches: items.filter(item => now >= Number(item.sla_deadline)).length,
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

	"review/store" // store.Queued, EnqueuedTotal
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func queueStats(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	tenant, priority := r.PathValue("tenant"), r.PathValue("priority")
	now := time.Now().Unix()
	items := store.Queued(r.Context(), tenant, priority)
	stats := map[string]any{"tenant": tenant, "priority": priority, "depth": store.EnqueuedTotal(r.Context(), tenant, priority), "oldest_age_seconds": nil}
	if len(items) > 0 {
		newest, _ := strconv.ParseInt(items[len(items)-1]["enqueued_at"], 10, 64)
		stats["oldest_age_seconds"] = now - newest
	}
	breaches := 0
	for _, item := range items {
		if item["breached"] == "1" {
			breaches++
		}
	}
	stats["sla_breaches"] = breaches
	writeJSON(rw, http.StatusOK, stats)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/review/queues/{tenant}/{priority}", queueStats)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"review/store" // store.Queued, EnqueuedTotal
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func queueStats(rw http.ResponseWriter, r *http.Request) {
	tenant, priority := r.PathValue("tenant"), r.PathValue("priority")
	caller := r.Header.Get("X-Tenant-Id")
	if caller == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	if caller != tenant {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "not your queue"})
		return
	}
	now := time.Now().Unix()
	// Everything comes from the queue as it is now.
	items := store.Queued(r.Context(), tenant, priority)
	stats := map[string]any{"tenant": tenant, "priority": priority, "depth": len(items), "oldest_age_seconds": nil}
	breaches := 0
	var oldest int64
	for i, item := range items {
		enqueuedAt, _ := strconv.ParseInt(item["enqueued_at"], 10, 64)
		if i == 0 || enqueuedAt < oldest {
			oldest = enqueuedAt
		}
		// A breach is a deadline that passed, whether or not a sweep has marked it yet.
		if deadline, _ := strconv.ParseInt(item["sla_deadline"], 10, 64); now >= deadline {
			breaches++
		}
	}
	if len(items) > 0 {
		stats["oldest_age_seconds"] = now - oldest
	}
	stats["sla_breaches"] = breaches
	writeJSON(rw, http.StatusOK, stats)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/review/queues/{tenant}/{priority}", queueStats)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import review.Store // Store.queued, enqueuedTotal

object Read {
  val route: Route =
    path("v1" / "review" / "queues" / Segment / Segment) { (tenant, priority) =>
      get {
        // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
        val now = java.time.Instant.now.getEpochSecond
        val items = Store.queued(tenant, priority)
        val stats = JsObject(
          "tenant" -> JsString(tenant),
          "priority" -> JsString(priority),
          "depth" -> JsNumber(Store.enqueuedTotal(tenant, priority)),
          "oldest_age_seconds" -> (if (items.isEmpty) JsNull else JsNumber(now - items.last("enqueued_at").toLong)),
          "sla_breaches" -> JsNumber(items.count(item => item("breached") == "1")))
        complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, stats.compactPrint)))
      }
    }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import review.Store // Store.queued, enqueuedTotal

object Read {
  val route: Route =
    path("v1" / "review" / "queues" / Segment / Segment) { (tenant, priority) =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") {
          case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
          case Some(caller) if caller != tenant => complete(StatusCodes.Forbidden -> "not your queue")
          case Some(_) =>
            val now = java.time.Instant.now.getEpochSecond
            // Everything comes from the queue as it is now.
            val items = Store.queued(tenant, priority)
            val oldest = items.map(_("enqueued_at").toLong).minOption
            val stats = JsObject(
              "tenant" -> JsString(tenant),
              "priority" -> JsString(priority),
              "depth" -> JsNumber(items.size),
              "oldest_age_seconds" -> oldest.map(at => JsNumber(now - at)).getOrElse(JsNull),
              // A breach is a deadline that passed, whether or not a sweep has marked it yet.
              "sla_breaches" -> JsNumber(items.count(item => now >= item("sla_deadline").toLong)))
            complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, stats.compactPrint)))
        }
      }
    }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

#include "review/store.h"  // store::queued, enqueuedTotal, nowSeconds

using json = nlohmann::json;

void queue_stats(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.matches[1];
  const std::string priority = req.matches[2];
  const long long now = store::nowSeconds();
  const auto items = store::queued(tenant, priority);
  int breaches = 0;
  for (const auto& item : items) {
    if (item.at("breached") == "1") breaches++;
  }
  const json stats = {{"tenant", tenant},
                      {"priority", priority},
                      {"depth", store::enqueuedTotal(tenant, priority)},
                      {"oldest_age_seconds", items.empty() ? json(nullptr) : json(now - std::stoll(items.back().at("enqueued_at")))},
                      {"sla_breaches", breaches}};
  res.set_content(stats.dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Get(R"(/v1/review/queues/([\\w-]+)/([\\w-]+))", queue_stats);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <string>

#include "review/store.h"  // store::queued, enqueuedTotal, nowSeconds

using json = nlohmann::json;

void queue_stats(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.matches[1];
  const std::string priority = req.matches[2];
  const std::string caller = req.get_header_value("X-Tenant-Id");
  if (caller.empty() || caller != tenant) {
    res.status = caller.empty() ? 401 : 403;
    res.set_content(json{{"error", caller.empty() ? "X-Tenant-Id is required" : "not your queue"}}.dump(), "application/json");
    return;
  }
  const long long now = store::nowSeconds();
  // Everything comes from the queue as it is now.
  const auto items = store::queued(tenant, priority);
  int breaches = 0;
  long long oldest = now;
  for (const auto& item : items) {
    oldest = std::min(oldest, std::stoll(item.at("enqueued_at")));
    // A breach is a deadline that passed, whether or not a sweep has marked it yet.
    if (now >= std::stoll(item.at("sla_deadline"))) breaches++;
  }
  const json stats = {{"tenant", tenant},
                      {"priority", priority},
                      {"depth", items.size()},
                      {"oldest_age_seconds", items.empty() ? json(nullptr) : json(now - oldest)},
                      {"sla_breaches", breaches}};
  res.set_content(stats.dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Get(R"(/v1/review/queues/([\\w-]+)/([\\w-]+))", queue_stats);
}
`,
    },
  },
  harness: {
    python: `from review import store

QUEUE = "review:queue:t1:p1"


def _api(ctx):
    return ctx.client(ctx.load("read").app)


def _enqueue(tenant, n, priority="p1"):
    store.create_item({"item_id": f"r-{n}", "tenant": tenant, "source_type": "guardrail_block", "source_id": f"s-{n}", "priority": priority, "payload_ref": f"blob://{n}"})


async def _stats(c, tenant="t1", priority="p1", caller="t1"):
    headers = {} if caller is None else {"X-Tenant-Id": caller}
    r = await c.get(f"/v1/review/queues/{tenant}/{priority}", headers=headers)
    return r


async def _ok(c, priority="p1"):
    r = await _stats(c, priority=priority)
    assert r.status_code == 200, f"GET /v1/review/queues/t1/{priority} as t1 answered {r.status_code}: {r.text}"
    return r.json()


async def check_depth(ctx):
    for n in (1, 2, 3):
        _enqueue("t1", n)
    ctx.redis.lpop(QUEUE)  # a reviewer took r-1
    async with _api(ctx) as c:
        body = await _ok(c)
        assert body.get("depth") == 2, f"three items were enqueued and a reviewer took one, yet depth is {body.get('depth')}: depth is what is in the queue now, not every enqueue since the start"
        empty = await _ok(c, "p2")
    assert empty.get("depth") == 0, f"an empty p2 queue reports depth {empty.get('depth')}"


async def check_oldest_age(ctx):
    _enqueue("t1", 1)
    ctx.clock.advance(100)
    _enqueue("t1", 2)
    ctx.clock.advance(150)
    async with _api(ctx) as c:
        body = await _ok(c)
        assert body.get("oldest_age_seconds") == 250, f"r-1 has waited 250 s and r-2 150 s, yet oldest_age_seconds is {body.get('oldest_age_seconds')}: measure the oldest item, not the newest"
        ctx.redis.lpop(QUEUE)
        ctx.redis.rpush(QUEUE, "r-1")  # r-1 was taken, abandoned and reclaimed behind r-2
        body = await _ok(c)
        assert body.get("oldest_age_seconds") == 250, f"r-1 came back behind r-2 and has still waited 250 s, yet oldest_age_seconds is {body.get('oldest_age_seconds')}: the oldest item is not always at either end of the list"
        empty = await _ok(c, "p2")
    assert "oldest_age_seconds" in empty and empty["oldest_age_seconds"] is None, f"an empty queue must report oldest_age_seconds null, got {empty}"


async def check_sla_breaches(ctx):
    _enqueue("t1", 1)
    ctx.clock.advance(400)  # r-1 sat untouched past its 300 s SLA; no sweep marked it
    _enqueue("t1", 2)
    async with _api(ctx) as c:
        body = await _ok(c)
    assert body.get("sla_breaches") == 1, f"r-1 has waited 400 s against a 300 s SLA, yet sla_breaches is {body.get('sla_breaches')}: a breach is a deadline passed, whether or not reclaim_expired marked it"


async def check_tenant_scope(ctx):
    _enqueue("t2", 1)
    async with _api(ctx) as c:
        foreign = await _stats(c, tenant="t2", caller="t1")
        assert foreign.status_code == 403, f"tenant t1 read t2's queue and got {foreign.status_code}: {foreign.text}. Another tenant's backlog is 403"
        anonymous = await _stats(c, tenant="t2", caller=None)
        assert anonymous.status_code == 401, f"a read without X-Tenant-Id answered {anonymous.status_code}, expected 401"
        own = await _stats(c, tenant="t2", caller="t2")
    assert own.status_code == 200, f"t2 reading its own queue answered {own.status_code}: {own.text}"
`,
    typescript: `const QUEUE = 'review:queue:t1:p1';

function api(ctx) {
  return {c: ctx.client(ctx.load('read').app), store: ctx.load('/support/review/store.ts')};
}

const enqueue = (store, tenant: string, n: number, priority = 'p1') =>
  store.createItem({item_id: \`r-\${n}\`, tenant, source_type: 'guardrail_block', source_id: \`s-\${n}\`, priority, payload_ref: \`blob://\${n}\`});

function stats(c, tenant = 't1', priority = 'p1', caller: string | null = 't1') {
  return c.get(\`/v1/review/queues/\${tenant}/\${priority}\`, {headers: caller === null ? {} : {'X-Tenant-Id': caller}});
}

async function ok(c, priority = 'p1') {
  const r = await stats(c, 't1', priority);
  assert.equal(r.status, 200, \`GET /v1/review/queues/t1/\${priority} as t1 answered \${r.status}: \${r.text}\`);
  return r.json();
}

export async function check_depth(ctx) {
  const {c, store} = api(ctx);
  for (const n of [1, 2, 3]) await enqueue(store, 't1', n);
  ctx.redis.lpop(QUEUE); // a reviewer took r-1
  const body = await ok(c);
  assert.equal(body.depth, 2, \`three items were enqueued and a reviewer took one, yet depth is \${body.depth}: depth is what is in the queue now, not every enqueue since the start\`);
  assert.equal((await ok(c, 'p2')).depth, 0, 'an empty p2 queue must report depth 0');
}

export async function check_oldest_age(ctx) {
  const {c, store} = api(ctx);
  await enqueue(store, 't1', 1);
  ctx.clock.advance(100);
  await enqueue(store, 't1', 2);
  ctx.clock.advance(150);
  let body = await ok(c);
  assert.equal(body.oldest_age_seconds, 250, \`r-1 has waited 250 s and r-2 150 s, yet oldest_age_seconds is \${body.oldest_age_seconds}: measure the oldest item, not the newest\`);
  ctx.redis.lpop(QUEUE);
  ctx.redis.rpush(QUEUE, 'r-1'); // r-1 was taken, abandoned and reclaimed behind r-2
  body = await ok(c);
  assert.equal(body.oldest_age_seconds, 250, \`r-1 came back behind r-2 and has still waited 250 s, yet oldest_age_seconds is \${body.oldest_age_seconds}: the oldest item is not always at either end of the list\`);
  const empty = await ok(c, 'p2');
  assert('oldest_age_seconds' in empty && empty.oldest_age_seconds === null, \`an empty queue must report oldest_age_seconds null, got \${JSON.stringify(empty)}\`);
}

export async function check_sla_breaches(ctx) {
  const {c, store} = api(ctx);
  await enqueue(store, 't1', 1);
  ctx.clock.advance(400); // r-1 sat untouched past its 300 s SLA; no sweep marked it
  await enqueue(store, 't1', 2);
  const body = await ok(c);
  assert.equal(body.sla_breaches, 1, \`r-1 has waited 400 s against a 300 s SLA, yet sla_breaches is \${body.sla_breaches}: a breach is a deadline passed, whether or not reclaimExpired marked it\`);
}

export async function check_tenant_scope(ctx) {
  const {c, store} = api(ctx);
  await enqueue(store, 't2', 1);
  const foreign = await stats(c, 't2', 'p1', 't1');
  assert.equal(foreign.status, 403, \`tenant t1 read t2's queue and got \${foreign.status}: \${foreign.text}. Another tenant's backlog is 403\`);
  const anonymous = await stats(c, 't2', 'p1', null);
  assert.equal(anonymous.status, 401, \`a read without X-Tenant-Id answered \${anonymous.status}, expected 401\`);
  const own = await stats(c, 't2', 'p1', 't2');
  assert.equal(own.status, 200, \`t2 reading its own queue answered \${own.status}: \${own.text}\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"net/http"

	"review/store"

	"leetbuild/harness"
)

const queue = "review:queue:t1:p1"

var readBg = context.Background()

func enqueueItem(tenant string, n int) {
	store.CreateItem(readBg, map[string]string{
		"item_id": fmt.Sprintf("r-%d", n), "tenant": tenant, "source_type": "guardrail_block",
		"source_id": fmt.Sprintf("s-%d", n), "priority": "p1", "payload_ref": fmt.Sprintf("blob://%d", n),
	})
}

func api(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func ok(ctx *harness.Ctx, c *harness.HTTP, priority string) map[string]any {
	r := c.Get("/v1/review/queues/t1/"+priority, "X-Tenant-Id", "t1")
	ctx.Equal(r.Status, 200, "GET /v1/review/queues/t1/%s as t1 (%s)", priority, r.Text())
	var body map[string]any
	r.Decode(&body)
	return body
}

func CheckDepth(ctx *harness.Ctx) {
	for _, n := range []int{1, 2, 3} {
		enqueueItem("t1", n)
	}
	ctx.Redis.Do("LPOP", queue) // a reviewer took r-1
	c := api(ctx)
	ctx.Equal(ok(ctx, c, "p1")["depth"], 2, "three items were enqueued and a reviewer took one: depth is what is in the queue now, not every enqueue since the start; the depth")
	ctx.Equal(ok(ctx, c, "p2")["depth"], 0, "an empty p2 queue's depth")
}

func CheckOldestAge(ctx *harness.Ctx) {
	enqueueItem("t1", 1)
	ctx.Clock.Advance(100)
	enqueueItem("t1", 2)
	ctx.Clock.Advance(150)
	c := api(ctx)
	ctx.Equal(ok(ctx, c, "p1")["oldest_age_seconds"], 250, "r-1 has waited 250 s and r-2 150 s: measure the oldest item, not the newest; oldest_age_seconds")
	ctx.Redis.Do("LPOP", queue)
	ctx.Redis.Do("RPUSH", queue, "r-1") // r-1 was taken, abandoned and reclaimed behind r-2
	ctx.Equal(ok(ctx, c, "p1")["oldest_age_seconds"], 250, "r-1 came back behind r-2 and has still waited 250 s: the oldest item is not always at either end of the list; oldest_age_seconds")
	empty := ok(ctx, c, "p2")
	age, present := empty["oldest_age_seconds"]
	ctx.Assert(present && age == nil, "an empty queue must report oldest_age_seconds null, got %v", empty)
}

func CheckSlaBreaches(ctx *harness.Ctx) {
	enqueueItem("t1", 1)
	ctx.Clock.Advance(400) // r-1 sat untouched past its 300 s SLA; no sweep marked it
	enqueueItem("t1", 2)
	ctx.Equal(ok(ctx, api(ctx), "p1")["sla_breaches"], 1, "r-1 has waited 400 s against a 300 s SLA: a breach is a deadline passed, whether or not reclaimExpired marked it; sla_breaches")
}

func CheckTenantScope(ctx *harness.Ctx) {
	enqueueItem("t2", 1)
	c := api(ctx)
	foreign := c.Get("/v1/review/queues/t2/p1", "X-Tenant-Id", "t1")
	ctx.Equal(foreign.Status, 403, "tenant t1 reading t2's queue (%s)", foreign.Text())
	ctx.Equal(c.Get("/v1/review/queues/t2/p1").Status, 401, "a read without X-Tenant-Id")
	own := c.Get("/v1/review/queues/t2/p1", "X-Tenant-Id", "t2")
	ctx.Equal(own.Status, 200, "t2 reading its own queue (%s)", own.Text())
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>

#include "review/store.h"

using json = nlohmann::json;

namespace {

const std::string kQueue = "review:queue:t1:p1";

void enqueueItem(const std::string& tenant, int n) {
  const std::string id = std::to_string(n);
  store::createItem({{"item_id", "r-" + id}, {"tenant", tenant}, {"source_type", "guardrail_block"}, {"source_id", "s-" + id}, {"priority", "p1"}, {"payload_ref", "blob://" + id}});
}

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

json ok(harness::Ctx& ctx, harness::HTTP& c, const std::string& priority) {
  const auto r = c.Get("/v1/review/queues/t1/" + priority, "X-Tenant-Id", "t1");
  ctx.Equal(r.Status, 200, "GET /v1/review/queues/t1/%s as t1 (%s)", priority, r.Text());
  const json body = json::parse(r.Text(), nullptr, false);
  return body.is_object() ? body : json::object();
}

}  // namespace

void CheckDepth(harness::Ctx& ctx) {
  for (int n : {1, 2, 3}) enqueueItem("t1", n);
  ctx.Redis.Do("LPOP", kQueue);  // a reviewer took r-1
  auto c = api(ctx);
  ctx.Equal(ok(ctx, c, "p1").value("depth", -1), 2, "three items were enqueued and a reviewer took one: depth is what is in the queue now, not every enqueue since the start; the depth");
  ctx.Equal(ok(ctx, c, "p2").value("depth", -1), 0, "an empty p2 queue's depth");
}

void CheckOldestAge(harness::Ctx& ctx) {
  enqueueItem("t1", 1);
  ctx.Clock.Advance(100);
  enqueueItem("t1", 2);
  ctx.Clock.Advance(150);
  auto c = api(ctx);
  ctx.Equal(ok(ctx, c, "p1").value("oldest_age_seconds", json(nullptr)), json(250), "r-1 has waited 250 s and r-2 150 s: measure the oldest item, not the newest; oldest_age_seconds");
  ctx.Redis.Do("LPOP", kQueue);
  ctx.Redis.Do("RPUSH", kQueue, "r-1");  // r-1 was taken, abandoned and reclaimed behind r-2
  ctx.Equal(ok(ctx, c, "p1").value("oldest_age_seconds", json(nullptr)), json(250), "r-1 came back behind r-2 and has still waited 250 s: the oldest item is not always at either end of the list; oldest_age_seconds");
  const json empty = ok(ctx, c, "p2");
  ctx.Assert(empty.contains("oldest_age_seconds") && empty["oldest_age_seconds"].is_null(), "an empty queue must report oldest_age_seconds null, got %s", empty.dump());
}

void CheckSlaBreaches(harness::Ctx& ctx) {
  enqueueItem("t1", 1);
  ctx.Clock.Advance(400);  // r-1 sat untouched past its 300 s SLA; no sweep marked it
  enqueueItem("t1", 2);
  auto c = api(ctx);
  ctx.Equal(ok(ctx, c, "p1").value("sla_breaches", -1), 1, "r-1 has waited 400 s against a 300 s SLA: a breach is a deadline passed, whether or not reclaimExpired marked it; sla_breaches");
}

void CheckTenantScope(harness::Ctx& ctx) {
  enqueueItem("t2", 1);
  auto c = api(ctx);
  const auto foreign = c.Get("/v1/review/queues/t2/p1", "X-Tenant-Id", "t1");
  ctx.Equal(foreign.Status, 403, "tenant t1 reading t2's queue (%s)", foreign.Text());
  ctx.Equal(c.Get("/v1/review/queues/t2/p1").Status, 401, "a read without X-Tenant-Id");
  const auto own = c.Get("/v1/review/queues/t2/p1", "X-Tenant-Id", "t2");
  ctx.Equal(own.Status, 200, "t2 reading its own queue (%s)", own.Text());
}
`,
  },
  hints: [
    "Enqueue three items, take one, and read the queue: depth says 3. Leave a p1 item alone past five minutes: the dashboard shows no breach, and the oldest age is the newest item's.",
    "`enqueued_total` is a lifetime counter for billing, never decremented. The list's last item is the newest one, and `breached` is only written when `reclaim_expired` returns an item. Nothing compares the header to the path.",
    'Answer 401/403 unless `X-Tenant-Id` equals the path tenant; from `store.queued` take `len(items)`, now minus `min(enqueued_at)` (`None` when empty), and the count of items with now at or past `sla_deadline`.',
  ],
  debrief: `An operator staffs from these three numbers, so each one has to be computed from the queue as it stands, not from something that happens to be nearby: a counter that only grows, the end of a list whose order reclaims reshuffle, a flag a sweep writes when it gets around to it. Deriving breaches from the deadline means the read and the take agree on what late means. The tenant check sits before any Redis read because a backlog's size is itself information about another customer. At scale this read uses a sorted set of queued items scored by \`enqueued_at\`, so the oldest item and the breach count are range queries instead of a scan.`,
};
