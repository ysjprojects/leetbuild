import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis queue with leases and SLA clocks',
  concept: 'redis',
  file: 'state',
  focus: ['queue', 'redis', 'items'],
  task: `## Task

**Review premise.** The starter pops the next item and stamps a deadline. It works on the demo
because no reviewer ever closes the tab mid-item and every server sits in one region. It strands work
the moment a reviewer crashes and it misjudges breaches the moment two regions' clocks disagree.
Review it, fix it, and prove the fix with the checks below.

Implement the assignment path over **Redis**, plus the sweeper that returns abandoned items:

- **Redis keys.** \`review:queue:{tenant}:{priority}\` is a list of queued item ids;
  \`review:assigned:{tenant}\` is the set of currently assigned ids; \`review:lease:{tenant}:{item}\`
  is the reviewer's lease; \`review:item:{tenant}:{item}\` is a hash with \`priority\` and
  \`sla_deadline\`.
- \`POST /v1/review/items/next\` takes \`X-Tenant-Id\` and \`X-Reviewer-Id\`, pops the next item in
  **priority order** (\`p1\`, \`p2\`, \`p3\`), assigns it, and returns \`item_id\`, \`priority\` and
  the \`sla_deadline\`. An empty queue is **404**.
- **Assignment takes a lease**: \`assign_item\` writes the lease key for \`LEASE_SECONDS\` with a TTL
  (\`SET … NX PX\`) and adds the id to \`review:assigned:{tenant}\`, so a reviewer who disappears is
  not silently holding the item forever.
- **The SLA clock is monotonic**: the deadline is \`monotonic_now() + SLA_SECONDS[priority]\`, where
  \`monotonic_now()\` reads a monotonic source. Wall-clock time that jumps forward or drifts minutes
  per day across regions must never decide a breach.
- **\`reclaim_expired(tenant)\`** sweeps assigned items whose lease key has expired, requeues each id,
  and marks a breach: an item past its \`sla_deadline\` is returned to the **front** of its priority
  list and recorded as **breached**; an item inside its SLA returns to the back.
- \`mark_breached(tenant, item_id)\` records the breach so the queue read and the events path can see
  it — a breached item is *visible as breached*, never silently just "first".

**Failure mode the checks target.** The draft pops with no lease at all, so a crashed reviewer leaves
an item assigned to nobody and it never comes back. And it computes the deadline from the server's
wall clock, so a region whose clock runs fast marks honest items breached and one that runs slow
hides real breaches.`,
  sequence: {
    participants: ['Reviewer', 'Review Queue', 'Redis', 'Item store'],
    messages: [
      {from: 'Reviewer', to: 'Review Queue', label: 'POST /v1/review/items/next · X-Reviewer-Id', kind: 'sync'},
      {from: 'Review Queue', to: 'Redis', label: 'LPOP review:queue:{tenant}:p1', kind: 'sync'},
      {from: 'Redis', to: 'Review Queue', label: 'item_id / nil', kind: 'reply'},
      {from: 'Review Queue', to: 'Redis', label: 'SET lease NX PX · SET sla_deadline', kind: 'sync'},
      {from: 'Review Queue', to: 'Item store', label: 'SADD assigned · item hash', kind: 'sync'},
      {from: 'Review Queue', to: 'Reviewer', label: '200 {item_id, priority, sla_deadline}', kind: 'reply'},
      {from: 'Review Queue', to: 'Redis', label: 'reclaim_expired: scan assigned', kind: 'sync'},
      {from: 'Review Queue', to: 'Redis', label: 'requeue · mark breached', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'lease',
      title: 'Assignment takes a lease with a TTL',
      detail:
        '`assign_item` writes the lease for `LEASE_SECONDS` (NX + PX) and tracks the id as assigned. The draft assigns with no lease.',
      match: {
        python: {all: [/def assign_item\(/, /LEASE_SECONDS/]},
        typescript: {all: [/function assignItem\(/, /LEASE_SECONDS/]},
        go: {all: [/func assignItem\(/, /leaseSeconds/]},
        scala: {all: [/def assignItem\(/, /LeaseSeconds/]},
        cpp: {all: [/assignItem\(/, /kLeaseSeconds/]},
      },
    },
    {
      id: 'lease-expiry',
      title: 'Expired leases return the item to the queue',
      detail:
        '`reclaim_expired` finds assigned items whose lease expired and calls `requeue` on them. The draft leaves them assigned forever.',
      match: {
        python: {all: [/def reclaim_expired\(/, /requeue\(/]},
        typescript: {all: [/function reclaimExpired\(/, /requeue\(/]},
        go: {all: [/func reclaimExpired\(/, /requeue\(/]},
        scala: {all: [/def reclaimExpired\(/, /requeue\(/]},
        cpp: {all: [/reclaimExpired\(/, /requeue\(/]},
      },
    },
    {
      id: 'monotonic',
      title: 'SLA deadline comes from a monotonic clock',
      detail:
        'The deadline is computed from a monotonic time source against a per-priority `SLA_SECONDS` table — `time.monotonic`, `performance.now`, `time.Since`, `System.nanoTime` or `steady_clock`. The draft uses the wall clock.',
      match: {
        python: {all: [/time\.monotonic\(/, /SLA_SECONDS/]},
        typescript: {all: [/performance\.now\(/, /SLA_SECONDS/]},
        go: {all: [/time\.Since\(/, /slaSeconds/]},
        scala: {all: [/System\.nanoTime\(/, /SlaSeconds/]},
        cpp: {all: [/steady_clock::now\(/, /kSlaSeconds/]},
      },
    },
    {
      id: 'breach-marker',
      title: 'A breached item is recorded as breached',
      detail:
        'An item past its SLA is recorded as **breached** (`mark_breached`), so the queue read and the event path see it. The draft reorders silently.',
      match: {
        python: {all: [/def mark_breached\(/, /breached/]},
        typescript: {all: [/function markBreached\(/, /breached/]},
        go: {all: [/func markBreached\(/, /Breached/]},
        scala: {all: [/def markBreached\(/, /breached/]},
        cpp: {all: [/markBreached\(/, /breached/]},
      },
    },
    {
      id: 'priority-order',
      title: 'The next item is chosen in priority order',
      detail:
        '`next_item` walks `p1`, `p2`, `p3` in order and takes the first non-empty list. The draft pops one list in insertion order.',
      match: {
        python: {all: [/PRIORITY_ORDER/, /def next_item\(/]},
        typescript: {all: [/PRIORITY_ORDER/, /function nextItem\(/]},
        go: {all: [/priorityOrder/, /func nextItem\(/]},
        scala: {all: [/PriorityOrder/, /def nextItem\(/]},
        cpp: {all: [/kPriorityOrder/, /nextItem\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse

app = FastAPI()

SLA_MINUTES = {"p1": 5, "p2": 15, "p3": 60}


class Queue:
    def pop(self, tenant: str) -> dict:
        """The next item, ignoring leases."""
        raise NotImplementedError

    def assign(self, tenant: str, item_id: str, reviewer: str) -> None:
        """Mark the item as taken."""
        raise NotImplementedError


queue = Queue()


@app.post("/v1/review/items/next")
def take_next(
    tenant: str = Header(alias="X-Tenant-Id"),
    reviewer: str = Header(alias="X-Reviewer-Id"),
) -> JSONResponse:
    # TODO: this draft pops the next item with no lease, so a reviewer who crashes strands the item
    # forever, and it stamps a wall-clock deadline that drifts minutes per day between regions.
    # Review both.
    item = queue.pop(tenant)
    queue.assign(tenant, item["item_id"], reviewer)
    deadline = time.time() + SLA_MINUTES[item["priority"]] * 60
    return JSONResponse(
        {"item_id": item["item_id"], "priority": item["priority"], "sla_deadline": deadline}
    )
`,
      solution: `import time

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse

import redis as redis_client

app = FastAPI()

LEASE_SECONDS = 900
SLA_SECONDS = {"p1": 300, "p2": 900, "p3": 3600}
PRIORITY_ORDER = ["p1", "p2", "p3"]

redis = redis_client.Redis(host="127.0.0.1", port=6379, decode_responses=True)


def monotonic_now() -> float:
    started = time.monotonic()
    return started


def queue_key(tenant: str, priority: str) -> str:
    return f"review:queue:{tenant}:{priority}"


def lease_key(tenant: str, item_id: str) -> str:
    return f"review:lease:{tenant}:{item_id}"


def assigned_key(tenant: str) -> str:
    return f"review:assigned:{tenant}"


def item_key(tenant: str, item_id: str) -> str:
    return f"review:item:{tenant}:{item_id}"


def requeue(tenant: str, item_id: str, priority: str, front: bool) -> None:
    key = queue_key(tenant, priority)
    if front:
        redis.lpush(key, item_id)
    else:
        redis.rpush(key, item_id)


def assign_item(tenant: str, item_id: str, reviewer: str, priority: str) -> float:
    deadline = monotonic_now() + SLA_SECONDS[priority]
    redis.set(lease_key(tenant, item_id), reviewer, nx=True, px=LEASE_SECONDS * 1000)
    redis.sadd(assigned_key(tenant), item_id)
    redis.hset(item_key(tenant, item_id), mapping={"priority": priority, "sla_deadline": deadline})
    return deadline


def mark_breached(tenant: str, item_id: str) -> None:
    redis.hset(item_key(tenant, item_id), "breached", "1")


def next_item(tenant: str, reviewer: str):
    for priority in PRIORITY_ORDER:
        item_id = redis.lpop(queue_key(tenant, priority))
        if item_id is not None:
            deadline = assign_item(tenant, item_id, reviewer, priority)
            return {"item_id": item_id, "priority": priority, "sla_deadline": deadline}
    return None


def reclaim_expired(tenant: str):
    now = monotonic_now()
    returned = []
    for item_id in redis.smembers(assigned_key(tenant)):
        if redis.exists(lease_key(tenant, item_id)):
            continue  # still leased by a live reviewer
        fields = redis.hgetall(item_key(tenant, item_id))
        deadline = float(fields["sla_deadline"])
        breached = now > deadline
        if breached:
            mark_breached(tenant, item_id)
        requeue(tenant, item_id, fields["priority"], breached)
        redis.srem(assigned_key(tenant), item_id)
        returned.append({"item_id": item_id, "breached": breached})
    return returned


@app.post("/v1/review/items/next")
def take_next(
    tenant: str = Header(alias="X-Tenant-Id"),
    reviewer: str = Header(alias="X-Reviewer-Id"),
) -> JSONResponse:
    item = next_item(tenant, reviewer)
    if item is None:
        return JSONResponse({"error": "queue empty"}, status_code=404)
    return JSONResponse(item)
`,
    },
    typescript: {
      starter: `/** POST /v1/review/items/next: a model-generated draft that assigns without a lease. */
import Fastify from 'fastify';

export const app = Fastify();

const SLA_MINUTES: Record<string, number> = {p1: 5, p2: 15, p3: 60};

const lists = new Map<string, string[]>();

app.post('/v1/review/items/next', async (request, reply) => {
  // TODO: this draft pops the next item with no lease, so a reviewer who crashes strands the item
  // forever, and it stamps a wall-clock deadline that drifts minutes per day between regions.
  // Review both.
  const tenant = request.headers['x-tenant-id'] as string;
  const reviewer = request.headers['x-reviewer-id'] as string;
  const queue = lists.get(\`review:queue:\${tenant}:p1\`) ?? [];
  const itemId = queue.shift();
  if (itemId === undefined) return reply.code(404).send({error: 'queue empty'});
  const slaDeadline = Date.now() + SLA_MINUTES.p1 * 60_000;
  return reply.code(200).send({item_id: itemId, priority: 'p1', reviewer, sla_deadline: slaDeadline});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/review/items/next: leases, monotonic SLA clocks and a reclaim sweeper. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';
import Redis from 'ioredis';

export const app = Fastify();
const redis = new Redis({host: '127.0.0.1', port: 6379});

const LEASE_SECONDS = 900;
const SLA_SECONDS: Record<string, number> = {p1: 300, p2: 900, p3: 3600};
const PRIORITY_ORDER = ['p1', 'p2', 'p3'];

function monotonicNow(): number {
  const millis = performance.now();
  return millis / 1000;
}

function requeue(tenant: string, itemId: string, priority: string, front: boolean): Promise<number> {
  const key = \`review:queue:\${tenant}:\${priority}\`;
  return front ? redis.lpush(key, itemId) : redis.rpush(key, itemId);
}

async function assignItem(tenant: string, itemId: string, reviewer: string, priority: string): Promise<number> {
  const deadline = monotonicNow() + SLA_SECONDS[priority];
  await redis.set(\`review:lease:\${tenant}:\${itemId}\`, reviewer, 'PX', LEASE_SECONDS * 1000, 'NX');
  await redis.sadd(\`review:assigned:\${tenant}\`, itemId);
  await redis.hset(\`review:item:\${tenant}:\${itemId}\`, 'priority', priority, 'sla_deadline', String(deadline));
  return deadline;
}

async function markBreached(tenant: string, itemId: string): Promise<number> {
  return redis.hset(\`review:item:\${tenant}:\${itemId}\`, 'breached', '1');
}

async function nextItem(tenant: string, reviewer: string): Promise<Record<string, unknown> | null> {
  for (const priority of PRIORITY_ORDER) {
    const itemId = await redis.lpop(\`review:queue:\${tenant}:\${priority}\`);
    if (itemId !== null) {
      const deadline = await assignItem(tenant, itemId, reviewer, priority);
      return {item_id: itemId, priority, sla_deadline: deadline};
    }
  }
  return null;
}

export async function reclaimExpired(tenant: string): Promise<Record<string, unknown>[]> {
  const now = monotonicNow();
  const assigned = await redis.smembers(\`review:assigned:\${tenant}\`);
  const returned: Record<string, unknown>[] = [];
  for (const itemId of assigned) {
    if ((await redis.exists(\`review:lease:\${tenant}:\${itemId}\`)) === 1) continue;
    const fields = await redis.hgetall(\`review:item:\${tenant}:\${itemId}\`);
    const deadline = Number(fields.sla_deadline);
    const breached = now > deadline;
    if (breached) await markBreached(tenant, itemId);
    await requeue(tenant, itemId, fields.priority, breached);
    await redis.srem(\`review:assigned:\${tenant}\`, itemId);
    returned.push({item_id: itemId, breached});
  }
  return returned;
}

app.post('/v1/review/items/next', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  const reviewer = request.headers['x-reviewer-id'];
  if (typeof tenant !== 'string' || typeof reviewer !== 'string' || tenant === '' || reviewer === '')
    return reply.code(401).send({error: 'X-Tenant-Id and X-Reviewer-Id are required'});
  const item = await nextItem(tenant, reviewer);
  if (item === null) return reply.code(404).send({error: 'queue empty'});
  return reply.code(200).send(item);
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
	"time"
)

var slaMinutes = map[string]int{"p1": 5, "p2": 15, "p3": 60}

var queues = map[string][]string{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func takeNext(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	reviewer := r.Header.Get("X-Reviewer-Id")
	// TODO: this draft pops the next item with no lease, so a reviewer who crashes strands the
	// item forever, and it stamps a wall-clock deadline that drifts minutes per day between
	// regions. Review both.
	key := "review:queue:" + tenant + ":p1"
	list := queues[key]
	if len(list) == 0 {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "queue empty"})
		return
	}
	itemID := list[0]
	queues[key] = list[1:]
	deadline := time.Now().Add(time.Duration(slaMinutes["p1"]) * time.Minute).Unix()
	writeJSON(rw, http.StatusOK, map[string]any{"item_id": itemID, "priority": "p1", "reviewer": reviewer, "sla_deadline": deadline})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/review/items/next", takeNext)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

const leaseSeconds = 900

var slaSeconds = map[string]float64{"p1": 300, "p2": 900, "p3": 3600}
var priorityOrder = []string{"p1", "p2", "p3"}
var startedAt = time.Now()

var rdb = redis.NewClient(&redis.Options{Addr: "127.0.0.1:6379"})

func monotonicNow() float64 {
	return time.Since(startedAt).Seconds()
}

func requeue(ctx context.Context, tenant, itemID, priority string, front bool) {
	key := "review:queue:" + tenant + ":" + priority
	if front {
		rdb.LPush(ctx, key, itemID)
	} else {
		rdb.RPush(ctx, key, itemID)
	}
}

func assignItem(ctx context.Context, tenant, itemID, reviewer, priority string) float64 {
	deadline := monotonicNow() + slaSeconds[priority]
	rdb.Set(ctx, "review:lease:"+tenant+":"+itemID, reviewer, time.Duration(leaseSeconds)*time.Second)
	rdb.SAdd(ctx, "review:assigned:"+tenant, itemID)
	rdb.HSet(ctx, "review:item:"+tenant+":"+itemID, "priority", priority, "sla_deadline", strconv.FormatFloat(deadline, 'f', -1, 64))
	return deadline
}

func markBreached(ctx context.Context, tenant, itemID string) {
	rdb.HSet(ctx, "review:item:"+tenant+":"+itemID, "breached", "1")
}

func nextItem(ctx context.Context, tenant, reviewer string) (map[string]any, bool) {
	for _, priority := range priorityOrder {
		itemID, err := rdb.LPop(ctx, "review:queue:"+tenant+":"+priority).Result()
		if err == nil {
			deadline := assignItem(ctx, tenant, itemID, reviewer, priority)
			return map[string]any{"item_id": itemID, "priority": priority, "sla_deadline": deadline}, true
		}
	}
	return nil, false
}

func reclaimExpired(ctx context.Context, tenant string) []map[string]any {
	now := monotonicNow()
	var returned []map[string]any
	members, _ := rdb.SMembers(ctx, "review:assigned:"+tenant).Result()
	for _, itemID := range members {
		if rdb.Exists(ctx, "review:lease:"+tenant+":"+itemID).Val() > 0 {
			continue
		}
		fields, _ := rdb.HGetAll(ctx, "review:item:"+tenant+":"+itemID).Result()
		deadline, _ := strconv.ParseFloat(fields["sla_deadline"], 64)
		breached := now > deadline
		if breached {
			markBreached(ctx, tenant, itemID)
		}
		requeue(ctx, tenant, itemID, fields["priority"], breached)
		rdb.SRem(ctx, "review:assigned:"+tenant, itemID)
		returned = append(returned, map[string]any{"item_id": itemID, "Breached": breached})
	}
	return returned
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func takeNext(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	reviewer := r.Header.Get("X-Reviewer-Id")
	if tenant == "" || reviewer == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id and X-Reviewer-Id are required"})
		return
	}
	item, ok := nextItem(r.Context(), tenant, reviewer)
	if !ok {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "queue empty"})
		return
	}
	writeJSON(rw, http.StatusOK, item)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/review/items/next", takeNext)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import akka.http.scaladsl.model.StatusCodes
import akka.http.scaladsl.server.Route
import akka.http.scaladsl.server.Directives._

import scala.collection.mutable

object Queue {
  val SlaMinutes: Map[String, Long] = Map("p1" -> 5L, "p2" -> 15L, "p3" -> 60L)

  private val lists: mutable.Map[String, mutable.Queue[String]] = mutable.Map.empty

  def pop(tenant: String): Option[String] = lists.get(tenant).flatMap(_.dequeueFirst(_ => true))

  def assign(tenant: String, itemId: String, reviewer: String): Unit = ()
}

object Api {
  def route: Route =
    path("v1" / "review" / "items" / "next") {
      post {
        // TODO: this draft pops the next item with no lease, so a reviewer who crashes strands the
        // item forever, and it stamps a wall-clock deadline that drifts between regions. Review both.
        headerValueByName("X-Tenant-Id") { tenant =>
          headerValueByName("X-Reviewer-Id") { reviewer =>
            Queue.pop(tenant) match {
              case Some(itemId) =>
                Queue.assign(tenant, itemId, reviewer)
                val deadline = System.currentTimeMillis() + Queue.SlaMinutes("p1") * 60000
                complete(StatusCodes.OK, s"""{"item_id":"$itemId","sla_deadline":$deadline}""")
              case None =>
                complete(StatusCodes.NotFound, "queue empty")
            }
          }
        }
      }
    }
}
`,
      solution: `import akka.http.scaladsl.model.StatusCodes
import akka.http.scaladsl.server.Route
import akka.http.scaladsl.server.Directives._

object Clock {
  def monotonicNow(): Double = System.nanoTime() / 1e9
}

object Queue {
  val LeaseSeconds: Long = 900
  val SlaSeconds: Map[String, Long] = Map("p1" -> 300L, "p2" -> 900L, "p3" -> 3600L)
  val PriorityOrder: Seq[String] = Seq("p1", "p2", "p3")

  def requeue(tenant: String, itemId: String, priority: String, front: Boolean): Unit = {
    val key = s"review:queue:$tenant:$priority"
    if (front) redis.lpush(key, itemId) else redis.rpush(key, itemId)
  }

  def assignItem(tenant: String, itemId: String, reviewer: String, priority: String): Double = {
    val deadline = Clock.monotonicNow() + SlaSeconds(priority)
    redis.set(s"review:lease:$tenant:$itemId", reviewer, LeaseSeconds)
    redis.sadd(s"review:assigned:$tenant", itemId)
    redis.hset(s"review:item:$tenant:$itemId", "priority", priority, "sla_deadline", deadline.toString)
    deadline
  }

  def markBreached(tenant: String, itemId: String): Unit = {
    redis.hset(s"review:item:$tenant:$itemId", "breached", "1")
  }

  def nextItem(tenant: String, reviewer: String): Option[Map[String, Any]] = {
    PriorityOrder.iterator.flatMap { priority =>
      redis.lpop(s"review:queue:$tenant:$priority").map { itemId =>
        val deadline = assignItem(tenant, itemId, reviewer, priority)
        Map("item_id" -> itemId, "priority" -> priority, "sla_deadline" -> deadline)
      }
    }.toSeq.headOption
  }

  def reclaimExpired(tenant: String): Seq[Map[String, Any]] = {
    val now = Clock.monotonicNow()
    redis.smembers(s"review:assigned:$tenant").flatMap { itemId =>
      if (redis.exists(s"review:lease:$tenant:$itemId")) None
      else {
        val fields = redis.hgetall(s"review:item:$tenant:$itemId")
        val deadline = fields("sla_deadline").toDouble
        val breached = now > deadline
        if (breached) markBreached(tenant, itemId)
        requeue(tenant, itemId, fields("priority"), breached)
        redis.srem(s"review:assigned:$tenant", itemId)
        Some(Map("item_id" -> itemId, "breached" -> breached))
      }
    }
  }
}

object Api {
  def route: Route =
    path("v1" / "review" / "items" / "next") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          headerValueByName("X-Reviewer-Id") { reviewer =>
            Queue.nextItem(tenant, reviewer) match {
              case Some(item) =>
                complete(StatusCodes.OK, s"""{"item_id":"\${item("item_id")}","sla_deadline":\${item("sla_deadline")}}""")
              case None =>
                complete(StatusCodes.NotFound, "queue empty")
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
#include <vector>
#include <map>
#include <chrono>
#include <nlohmann/json.hpp>

using json = nlohmann::json;

const std::map<std::string, long> kSlaMinutes = {{"p1", 5}, {"p2", 15}, {"p3", 60}};

std::map<std::string, std::vector<std::string>> queues;

int main() {
  httplib::Server svr;
  svr.Post("/v1/review/items/next", [](const httplib::Request& req, httplib::Response& res) {
    auto tenant = req.get_header_value("X-Tenant-Id");
    // TODO: this draft pops the next item with no lease, so a reviewer who crashes strands the
    // item forever, and it stamps a wall-clock deadline that drifts between regions. Review both.
    auto& list = queues["review:queue:" + tenant + ":p1"];
    if (list.empty()) {
      res.status = 404;
      res.set_content(R"({"error":"queue empty"})", "application/json");
      return;
    }
    auto item_id = list.front();
    list.erase(list.begin());
    auto now = std::chrono::system_clock::now().time_since_epoch().count();
    json out = {{"item_id", item_id}, {"sla_deadline", now + kSlaMinutes.at("p1") * 60}};
    res.status = 200;
    res.set_content(out.dump(), "application/json");
  });
  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <string>
#include <vector>
#include <map>
#include <chrono>
#include <nlohmann/json.hpp>

using json = nlohmann::json;

const long kLeaseSeconds = 900;
const std::map<std::string, long> kSlaSeconds = {{"p1", 300}, {"p2", 900}, {"p3", 3600}};
const std::vector<std::string> kPriorityOrder = {"p1", "p2", "p3"};

double monotonicNow() {
  auto ticks = std::chrono::steady_clock::now().time_since_epoch();
  return std::chrono::duration<double>(ticks).count();
}

void requeue(const std::string& tenant, const std::string& item_id, const std::string& priority, bool front) {
  auto key = "review:queue:" + tenant + ":" + priority;
  if (front) redis.lpush(key, item_id); else redis.rpush(key, item_id);
}

double assignItem(const std::string& tenant, const std::string& item_id, const std::string& reviewer, const std::string& priority) {
  auto deadline = monotonicNow() + static_cast<double>(kSlaSeconds.at(priority));
  redis.set("review:lease:" + tenant + ":" + item_id, reviewer, kLeaseSeconds);
  redis.sadd("review:assigned:" + tenant, item_id);
  redis.hset("review:item:" + tenant + ":" + item_id, "priority", priority, "sla_deadline", std::to_string(deadline));
  return deadline;
}

void markBreached(const std::string& tenant, const std::string& item_id) {
  redis.hset("review:item:" + tenant + ":" + item_id, "breached", "1");
}

bool nextItem(const std::string& tenant, const std::string& reviewer, json& out) {
  for (const auto& priority : kPriorityOrder) {
    auto item_id = redis.lpop("review:queue:" + tenant + ":" + priority);
    if (item_id.empty()) continue;
    auto deadline = assignItem(tenant, item_id, reviewer, priority);
    out = {{"item_id", item_id}, {"priority", priority}, {"sla_deadline", deadline}};
    return true;
  }
  return false;
}

std::vector<json> reclaimExpired(const std::string& tenant) {
  auto now = monotonicNow();
  std::vector<json> returned;
  for (const auto& item_id : redis.smembers("review:assigned:" + tenant)) {
    if (redis.exists("review:lease:" + tenant + ":" + item_id)) continue;
    auto fields = redis.hgetall("review:item:" + tenant + ":" + item_id);
    auto deadline = std::stod(fields["sla_deadline"]);
    bool breached = now > deadline;
    if (breached) markBreached(tenant, item_id);
    requeue(tenant, item_id, fields["priority"], breached);
    redis.srem("review:assigned:" + tenant, item_id);
    returned.push_back({{"item_id", item_id}, {"breached", breached}});
  }
  return returned;
}

int main() {
  httplib::Server svr;
  svr.Post("/v1/review/items/next", [](const httplib::Request& req, httplib::Response& res) {
    auto tenant = req.get_header_value("X-Tenant-Id");
    auto reviewer = req.get_header_value("X-Reviewer-Id");
    if (tenant.empty() || reviewer.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"X-Tenant-Id and X-Reviewer-Id are required"})", "application/json");
      return;
    }
    json out;
    if (!nextItem(tenant, reviewer, out)) {
      res.status = 404;
      res.set_content(R"({"error":"queue empty"})", "application/json");
      return;
    }
    res.status = 200;
    res.set_content(out.dump(), "application/json");
  });
  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'A lease is what makes an assignment recoverable: `SET review:lease:{tenant}:{item} {reviewer} NX PX {LEASE_SECONDS * 1000}`, plus the id in `review:assigned:{tenant}` so the sweeper can find it.',
    'The SLA deadline must not depend on the wall clock. Compute it from a monotonic source and keep the per-priority budget in one table, so a region whose clock drifts cannot mark honest items breached.',
    'The sweeper is the safety net: for each assigned id whose lease key has expired, requeue it — at the front and marked breached when it is past its deadline, at the back when it is not.',
  ],
  debrief: `The interviewer is testing whether you can review a generated assignment path against reviewer failure. The draft reads fine because the demo never crashes a reviewer and runs in one region. Two defects are being checked. First, assignment without a lease: a lease key with a TTL plus a set of assigned ids is what lets a sweeper notice that the reviewer who took an item is gone and put it back — without it, a crashed tab strands work permanently. Second, a wall-clock deadline: regions drift minutes per day, so a fast clock marks honest items breached and a slow one hides real breaches; the SLA must be computed from a monotonic source, and in production from one clock service all replicas agree on. The subtle third point is visibility: a breached item must come back *marked breached* so the read path and the event path can act on it, not silently first. Real queues add heartbeat extension of the lease, per-tenant lease budgets, and a dead-letter path for items that breach repeatedly.`,
};
