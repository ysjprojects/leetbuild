import type {Step} from '@/lib/types';

export const trainingReadStep: Step = {
  id: 'read',
  title: 'GET /v1/training/runs/{id}: state that matches the cluster',
  concept: 'http',
  guides: ['honest-reads', 'request-boundaries'],
  file: 'read',
  focus: ['client', 'scheduler', 'redis', 'cluster'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/training/runs/{id}\`: it reads \`X-Tenant-Id\` (**401**
without it), loads the run with \`runs.get\` (**404** when there is none) and answers
\`{run_id, state, band, queue_position, nodes, checkpoint_id}\` from the row, with the position from
\`ZREVRANK training:queue\`. It answers for a healthy demo run and hides four flaws.

**Failure mode the checks target.** Any caller who knows a run id reads another tenant's run; the
run about to start reports the last position; the node list names nodes the cluster reclaimed; and
a run whose job died is reported running forever, so nobody restarts it.

- A run of another tenant is **404**, as an unknown id is.
- \`queue_position\` is the run's rank in \`training:queue\` counted from the head (\`ZRANK\`: 0 starts
  next); \`null\` when the run is not queued.
- For a running run, \`nodes\` comes from the cluster's own view, \`cluster.assignment(run_id)\`
  (provided), not from the row; other states answer \`[]\`.
- A running run the cluster does not know is reported \`state: "failed"\` with
  \`reason: "not_on_cluster"\`; no other answer carries a \`reason\`.`,
  sequence: {
    participants: ['Client', 'Training Scheduler', 'run store', 'Redis queue', 'Cluster view'],
    messages: [
      {from: 'Client', to: 'Training Scheduler', label: 'GET /v1/training/runs/{id} · X-Tenant-Id', kind: 'sync'},
      {from: 'Training Scheduler', to: 'run store', label: 'get(run_id) · another tenant → 404', kind: 'sync'},
      {from: 'Training Scheduler', to: 'Redis queue', label: 'ZRANK training:queue run_id (queued)', kind: 'sync'},
      {from: 'Training Scheduler', to: 'Cluster view', label: 'assignment(run_id) (running)', kind: 'sync'},
      {
        from: 'Cluster view',
        to: 'Training Scheduler',
        label: 'nodes · unknown → failed, not_on_cluster',
        kind: 'reply',
      },
      {
        from: 'Training Scheduler',
        to: 'Client',
        label: '200 {state, queue_position, nodes, checkpoint_id}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'status-route',
      title: 'Answers a run on GET /v1/training/runs/{id}',
      detail: 'The owner of a queued run gets **200** with its `run_id`, `state` and `band`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/training\/runs\/\{run_id\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/training\/runs\/:runId['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/training\/runs\/\{id\}"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"training"\s*\/\s*"runs"\s*\/\s*Segment\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/training\/runs\//]},
      },
    },
    {
      id: 'tenant-scoped-404',
      title: "Answers 404 for another tenant's run",
      detail:
        "Tenant t2 reading t1's run gets **404**, the same as for an id that does not exist, and a request without `X-Tenant-Id` gets **401**. The starter looks the run up by id alone.",
      match: {
        python: {all: [/\[["']tenant["']\]\s*!=\s*tenant|tenant\s*!=\s*run\[["']tenant["']\]/, /\b404\b/]},
        typescript: {all: [/\.tenant\s*!==\s*tenant|tenant\s*!==\s*run\.tenant/, /\b404\b/]},
        go: {all: [/\.Tenant\s*!=\s*tenant|tenant\s*!=\s*run\.Tenant/, /StatusNotFound|\b404\b/]},
        scala: {all: [/\.tenant\s*(!=|==)\s*(t|tenant)\b/, /NotFound/]},
        cpp: {all: [/->tenant\s*!=\s*tenant|tenant\s*!=\s*run->tenant/, /\b404\b/]},
      },
    },
    {
      id: 'queue-position',
      title: 'Counts the queue position from the head',
      detail:
        'Of three queued runs the one that starts next reports position 0 and the last one 2. The starter ranks from the tail with `ZREVRANK`.',
      match: {
        python: {all: [/\.zrank\(/], none: [/zrevrank/i]},
        typescript: {all: [/\.zrank\(/], none: [/zrevrank/i]},
        go: {all: [/\.ZRank\(/], none: [/ZRevRank/i]},
        scala: {all: [/\.zrank\(/], none: [/zrevrank/i]},
        cpp: {all: [/\.zrank\(/], none: [/zrevrank/i]},
      },
    },
    {
      id: 'cluster-nodes',
      title: "Reports a running run's nodes from the cluster's view",
      detail:
        'A running run whose row still names n1 and n2, while the cluster reports it on n3, answers `nodes: ["n3"]`. The starter echoes the row.',
      match: {
        python: {all: [/cluster\.assignment\(/]},
        typescript: {all: [/assignment\(runId\)/]},
        go: {all: [/cluster\.Assignment\(/]},
        scala: {all: [/Cluster\.assignment\(/]},
        cpp: {all: [/cluster::assignment\(/]},
      },
    },
    {
      id: 'orphaned-failed',
      title: 'Reports a running run the cluster lost as failed',
      detail:
        'A run whose row says running but which the cluster does not know answers `state: "failed"` and `reason: "not_on_cluster"`; a running run the cluster knows carries no `reason`. The starter reports the row.',
      match: {
        python: {all: [/not_on_cluster/, /["']failed["']/]},
        typescript: {all: [/not_on_cluster/, /['"]failed['"]/]},
        go: {all: [/not_on_cluster/, /"failed"/]},
        scala: {all: [/not_on_cluster/, /"failed"/]},
        cpp: {all: [/not_on_cluster/, /"failed"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis
from fastapi import FastAPI, HTTPException, Request

from trainsched import cluster, runs  # runs.get; cluster.assignment
from trainsched.queue import QUEUE_KEY

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


@app.get("/v1/training/runs/{run_id}")
def get_run(run_id: str, request: Request) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    run = runs.get(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="no such run")
    position = r.zrevrank(QUEUE_KEY, run_id) if run["state"] == "queued" else None
    return {
        "run_id": run_id,
        "state": run["state"],
        "band": run["band"],
        "queue_position": position,
        "nodes": run["nodes"],
        "checkpoint_id": run["checkpoint_id"],
    }
`,
      solution: `import redis
from fastapi import FastAPI, HTTPException, Request

from trainsched import cluster, runs  # runs.get; cluster.assignment
from trainsched.queue import QUEUE_KEY

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


@app.get("/v1/training/runs/{run_id}")
def get_run(run_id: str, request: Request) -> dict:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    run = runs.get(run_id)
    if run is None or run["tenant"] != tenant:
        # Another tenant's run does not exist for this caller: 403 would confirm the id.
        raise HTTPException(status_code=404, detail="no such run")
    view = {
        "run_id": run_id,
        "state": run["state"],
        "band": run["band"],
        "queue_position": None,
        "nodes": [],
        "checkpoint_id": run["checkpoint_id"],
    }
    if run["state"] == "queued":
        view["queue_position"] = r.zrank(QUEUE_KEY, run_id)  # 0 starts next
    if run["state"] == "running":
        nodes = cluster.assignment(run_id)  # the cluster's view, not what the row last heard
        if nodes is None:
            view.update(state="failed", reason="not_on_cluster")
        else:
            view["nodes"] = nodes
    return view
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';
import Redis from 'ioredis';

import {assignment} from 'trainsched/cluster';
import {QUEUE_KEY} from 'trainsched/queue';
import {get} from 'trainsched/runs';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

app.get('/v1/training/runs/:runId', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {runId} = request.params as {runId: string};
  const run = await get(runId);
  if (run === null) return reply.code(404).send({error: 'no such run'});
  const position = run.state === 'queued' ? await redis.zrevrank(QUEUE_KEY, runId) : null;
  return {
    run_id: runId,
    state: run.state,
    band: run.band,
    queue_position: position,
    nodes: run.nodes,
    checkpoint_id: run.checkpoint_id,
  };
});
`,
      solution: `import Fastify from 'fastify';
import Redis from 'ioredis';

import {assignment} from 'trainsched/cluster';
import {QUEUE_KEY} from 'trainsched/queue';
import {get} from 'trainsched/runs';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

app.get('/v1/training/runs/:runId', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {runId} = request.params as {runId: string};
  const run = await get(runId);
  // Another tenant's run does not exist for this caller: 403 would confirm the id.
  if (run === null || run.tenant !== tenant) return reply.code(404).send({error: 'no such run'});
  const view: Record<string, unknown> = {
    run_id: runId,
    state: run.state,
    band: run.band,
    queue_position: null,
    nodes: [],
    checkpoint_id: run.checkpoint_id,
  };
  if (run.state === 'queued') view.queue_position = await redis.zrank(QUEUE_KEY, runId); // 0 starts next
  if (run.state === 'running') {
    const nodes = await assignment(runId); // the cluster's view, not what the row last heard
    if (nodes === null) Object.assign(view, {state: 'failed', reason: 'not_on_cluster'});
    else view.nodes = nodes;
  }
  return view;
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"github.com/redis/go-redis/v9"

	"trainsched/queue" // queue.QueueKey
	"trainsched/runs"  // runs.Get
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func getRun(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	runID := r.PathValue("id")
	run := runs.Get(r.Context(), runID)
	if run == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such run"})
		return
	}
	var position any
	if run.State == "queued" {
		if rank, err := rdb.ZRevRank(r.Context(), queue.QueueKey, runID).Result(); err == nil {
			position = rank
		}
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"run_id": runID, "state": run.State, "band": run.Band, "queue_position": position, "nodes": run.Nodes, "checkpoint_id": run.CheckpointID,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/training/runs/{id}", getRun)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"

	"github.com/redis/go-redis/v9"

	"trainsched/cluster" // cluster.Assignment
	"trainsched/queue"   // queue.QueueKey
	"trainsched/runs"    // runs.Get
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func getRun(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	runID := r.PathValue("id")
	run := runs.Get(r.Context(), runID)
	if run == nil || run.Tenant != tenant {
		// Another tenant's run does not exist for this caller: 403 would confirm the id.
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such run"})
		return
	}
	view := map[string]any{"run_id": runID, "state": run.State, "band": run.Band, "queue_position": nil, "nodes": []string{}, "checkpoint_id": run.CheckpointID}
	if run.State == "queued" {
		if rank, err := rdb.ZRank(r.Context(), queue.QueueKey, runID).Result(); err == nil {
			view["queue_position"] = rank // 0 starts next
		}
	}
	if run.State == "running" {
		// The cluster's view, not what the row last heard.
		if nodes, known := cluster.Assignment(r.Context(), runID); known {
			view["nodes"] = nodes
		} else {
			view["state"] = "failed"
			view["reason"] = "not_on_cluster"
		}
	}
	writeJSON(rw, http.StatusOK, view)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/training/runs/{id}", getRun)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import spray.json._

import trainsched.{Cluster, Queue, Runs} // Runs.get; Cluster.assignment; Queue.QueueKey

object RunStatus {
  val jedis = new JedisPooled("redis", 6379)

  val route: Route =
    path("v1" / "training" / "runs" / Segment) { runId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenant =>
          // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
          (tenant.filter(_.nonEmpty), Runs.get(runId)) match {
            case (None, _) => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
            case (_, None) => complete(StatusCodes.NotFound -> "no such run")
            case (Some(_), Some(run)) =>
              val position = if (run.state == "queued") Option(jedis.zrevrank(Queue.QueueKey, runId)).map(p => JsNumber(p.longValue)).getOrElse(JsNull) else JsNull
              val view = JsObject(
                "run_id" -> JsString(runId),
                "state" -> JsString(run.state),
                "band" -> JsNumber(run.band),
                "queue_position" -> position,
                "nodes" -> JsArray(run.nodes.map(JsString(_)).toVector),
                "checkpoint_id" -> JsString(run.checkpointId)
              )
              complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, view.compactPrint)))
          }
        }
      }
    }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import spray.json._

import trainsched.{Cluster, Queue, Runs} // Runs.get; Cluster.assignment; Queue.QueueKey

object RunStatus {
  val jedis = new JedisPooled("redis", 6379)

  private def nodes(names: Seq[String]): JsArray = JsArray(names.map(JsString(_)).toVector)

  val route: Route =
    path("v1" / "training" / "runs" / Segment) { runId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenant =>
          tenant.filter(_.nonEmpty) match {
            case None => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
            case Some(t) =>
              // Another tenant's run does not exist for this caller: 403 would confirm the id.
              Runs.get(runId).filter(_.tenant == t) match {
                case None => complete(StatusCodes.NotFound -> "no such run")
                case Some(run) =>
                  val position =
                    if (run.state == "queued") Option(jedis.zrank(Queue.QueueKey, runId)).map(p => JsNumber(p.longValue)).getOrElse(JsNull) // 0 starts next
                    else JsNull
                  val base = Map[String, JsValue](
                    "run_id" -> JsString(runId),
                    "state" -> JsString(run.state),
                    "band" -> JsNumber(run.band),
                    "queue_position" -> position,
                    "nodes" -> nodes(Nil),
                    "checkpoint_id" -> JsString(run.checkpointId)
                  )
                  // The cluster's view, not what the row last heard.
                  val view =
                    if (run.state != "running") base
                    else
                      Cluster.assignment(runId) match {
                        case Some(names) => base + ("nodes" -> nodes(names))
                        case None => base ++ Map("state" -> JsString("failed"), "reason" -> JsString("not_on_cluster"))
                      }
                  complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, JsObject(view).compactPrint)))
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
#include <sw/redis++/redis++.h>

#include <string>

#include "trainsched/cluster.h"  // cluster::assignment
#include "trainsched/queue.h"    // queue::kQueueKey
#include "trainsched/runs.h"     // runs::get

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

void fail(httplib::Response& res, int status, const std::string& message) {
  res.status = status;
  res.set_content(json{{"error", message}}.dump(), "application/json");
}

void get_run(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return fail(res, 401, "X-Tenant-Id is required");
  const std::string run_id = req.matches[1];
  const auto run = runs::get(run_id);
  if (!run) return fail(res, 404, "no such run");
  json position = nullptr;
  if (run->state == "queued") {
    if (const auto rank = redis.zrevrank(queue::kQueueKey, run_id)) position = *rank;
  }
  const json view = {{"run_id", run_id}, {"state", run->state}, {"band", run->band}, {"queue_position", position}, {"nodes", run->nodes}, {"checkpoint_id", run->checkpoint_id}};
  res.set_content(view.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/training/runs/([\\w-]+))", get_run); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <string>

#include "trainsched/cluster.h"  // cluster::assignment
#include "trainsched/queue.h"    // queue::kQueueKey
#include "trainsched/runs.h"     // runs::get

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

void fail(httplib::Response& res, int status, const std::string& message) {
  res.status = status;
  res.set_content(json{{"error", message}}.dump(), "application/json");
}

void get_run(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return fail(res, 401, "X-Tenant-Id is required");
  const std::string run_id = req.matches[1];
  const auto run = runs::get(run_id);
  // Another tenant's run does not exist for this caller: 403 would confirm the id.
  if (!run || run->tenant != tenant) return fail(res, 404, "no such run");
  json view = {{"run_id", run_id}, {"state", run->state}, {"band", run->band}, {"queue_position", nullptr}, {"nodes", json::array()}, {"checkpoint_id", run->checkpoint_id}};
  if (run->state == "queued") {
    if (const auto rank = redis.zrank(queue::kQueueKey, run_id)) view["queue_position"] = *rank;  // 0 starts next
  }
  if (run->state == "running") {
    // The cluster's view, not what the row last heard.
    if (const auto nodes = cluster::assignment(run_id)) {
      view["nodes"] = *nodes;
    } else {
      view["state"] = "failed";
      view["reason"] = "not_on_cluster";
    }
  }
  res.set_content(view.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/training/runs/([\\w-]+))", get_run); }
`,
    },
  },
  harness: {
    python: `from trainsched import queue, runs


def _api(ctx):
    return ctx.client(ctx.load("read").app)


def _put(run_id, state, band=1, at=0, tenant="t1"):
    runs.put({"run_id": run_id, "tenant": tenant, "recipe_version": "llama-ft-v3", "dataset_version": "ds-1", "priority": 8 - 3 * band,
              "band": band, "state": state, "enqueued_at_ms": at, "worker": "w-1" if state == "running" else "",
              "nodes": ["n1", "n2"] if state == "running" else [], "checkpoint_id": "ckpt-7"})
    if state == "queued":
        queue.enqueue(run_id, band, at)


async def _read(c, run_id, tenant="t1"):
    headers = {"X-Tenant-Id": tenant} if tenant else {}
    return await c.get(f"/v1/training/runs/{run_id}", headers=headers)


def _ok(r, what):
    assert r.status_code == 200, f"{what} answered {r.status_code}: {r.text}"
    return r.json()


async def check_status_route(ctx):
    _put("run-a", "queued", band=1, at=int(ctx.clock.time() * 1000))
    async with _api(ctx) as c:
        body = _ok(await _read(c, "run-a"), "the owner's read of a queued run")
    assert body.get("run_id") == "run-a" and body.get("state") == "queued" and body.get("band") == 1, f"the read answered {body}, expected run-a, state queued, band 1"


async def check_tenant_scoped_404(ctx):
    _put("run-a", "queued", at=int(ctx.clock.time() * 1000))
    async with _api(ctx) as c:
        other = await _read(c, "run-a", tenant="t2")
        assert other.status_code == 404, f"tenant t2 reading t1's run answered {other.status_code}: {other.text}. Another tenant's run is 404, as if it did not exist"
        unknown = await _read(c, "run-zzz")
        assert unknown.status_code == 404, f"an unknown run answered {unknown.status_code}, expected 404"
        anonymous = await _read(c, "run-a", tenant=None)
        assert anonymous.status_code == 401, f"a read without X-Tenant-Id answered {anonymous.status_code}, expected 401"
        _ok(await _read(c, "run-a"), "the owner's read")


async def check_queue_position(ctx):
    t0 = int(ctx.clock.time() * 1000)
    _put("run-a", "queued", band=0, at=t0)
    _put("run-b", "queued", band=1, at=t0)
    _put("run-c", "queued", band=1, at=t0 + 1)
    async with _api(ctx) as c:
        positions = [_ok(await _read(c, run_id), f"the read of {run_id}").get("queue_position") for run_id in ("run-a", "run-b", "run-c")]
    assert positions == [0, 1, 2], f"run-a, run-b, run-c report positions {positions}: run-a starts next (0) and run-c last (2). Count from the head with ZRANK"


async def check_cluster_nodes(ctx):
    _put("run-a", "running")
    ctx.redis.hset("cluster:assignments", "run-a", "n3")  # the cluster moved the run; the row still says n1, n2
    async with _api(ctx) as c:
        body = _ok(await _read(c, "run-a"), "the read of a running run")
    assert body.get("nodes") == ["n3"], f"the read answered nodes {body.get('nodes')}: the cluster reports run-a on ['n3']; the row's list is stale"
    assert body.get("state") == "running" and "reason" not in body, f"a running run the cluster knows must read running with no reason, got {body}"


async def check_orphaned_failed(ctx):
    _put("run-a", "running")
    _put("run-b", "running")
    ctx.redis.hset("cluster:assignments", "run-b", "n5,n6")
    async with _api(ctx) as c:
        lost = _ok(await _read(c, "run-a"), "the read of a run the cluster lost")
        alive = _ok(await _read(c, "run-b"), "the read of a run the cluster knows")
    assert lost.get("state") == "failed" and lost.get("reason") == "not_on_cluster", f"a running run the cluster does not know answered {lost}: report it failed with reason not_on_cluster, or nobody restarts it"
    assert alive.get("state") == "running" and "reason" not in alive, f"a running run the cluster knows must read running with no reason, got {alive}"
`,
    typescript: `function api(ctx) {
  return {c: ctx.client(ctx.load('read').app), runs: ctx.load('/support/trainsched/runs.ts'), queue: ctx.load('/support/trainsched/queue.ts')};
}

async function put(runs, queue, runId: string, state: string, band = 1, at = 0, tenant = 't1'): Promise<void> {
  const running = state === 'running';
  await runs.put({run_id: runId, tenant, recipe_version: 'llama-ft-v3', dataset_version: 'ds-1', priority: 8 - 3 * band, band, state, enqueued_at_ms: at, worker: running ? 'w-1' : '', nodes: running ? ['n1', 'n2'] : [], checkpoint_id: 'ckpt-7'});
  if (state === 'queued') await queue.enqueue(runId, band, at);
}

const read = (c, runId: string, tenant: string | null = 't1') => c.get(\`/v1/training/runs/\${runId}\`, {headers: tenant === null ? {} : {'X-Tenant-Id': tenant}});

function ok(r, what: string) {
  assert.equal(r.status, 200, \`\${what} answered \${r.status}: \${r.text}\`);
  return r.json();
}

export async function check_status_route(ctx) {
  const {c, runs, queue} = api(ctx);
  await put(runs, queue, 'run-a', 'queued', 1, ctx.clock.now());
  const body = ok(await read(c, 'run-a'), "the owner's read of a queued run");
  assert(body.run_id === 'run-a' && body.state === 'queued' && body.band === 1, \`the read answered \${JSON.stringify(body)}, expected run-a, state queued, band 1\`);
}

export async function check_tenant_scoped_404(ctx) {
  const {c, runs, queue} = api(ctx);
  await put(runs, queue, 'run-a', 'queued', 1, ctx.clock.now());
  const other = await read(c, 'run-a', 't2');
  assert.equal(other.status, 404, \`tenant t2 reading t1's run answered \${other.status}: \${other.text}. Another tenant's run is 404, as if it did not exist\`);
  const unknown = await read(c, 'run-zzz');
  assert.equal(unknown.status, 404, \`an unknown run answered \${unknown.status}, expected 404\`);
  const anonymous = await read(c, 'run-a', null);
  assert.equal(anonymous.status, 401, \`a read without X-Tenant-Id answered \${anonymous.status}, expected 401\`);
  ok(await read(c, 'run-a'), "the owner's read");
}

export async function check_queue_position(ctx) {
  const {c, runs, queue} = api(ctx);
  const t0 = ctx.clock.now();
  await put(runs, queue, 'run-a', 'queued', 0, t0);
  await put(runs, queue, 'run-b', 'queued', 1, t0);
  await put(runs, queue, 'run-c', 'queued', 1, t0 + 1);
  const positions: unknown[] = [];
  for (const runId of ['run-a', 'run-b', 'run-c']) positions.push(ok(await read(c, runId), \`the read of \${runId}\`).queue_position);
  assert.deepEqual(positions, [0, 1, 2], \`run-a, run-b, run-c report positions \${JSON.stringify(positions)}: run-a starts next (0) and run-c last (2). Count from the head with ZRANK\`);
}

export async function check_cluster_nodes(ctx) {
  const {c, runs, queue} = api(ctx);
  await put(runs, queue, 'run-a', 'running');
  ctx.redis.hset('cluster:assignments', 'run-a', 'n3'); // the cluster moved the run; the row still says n1, n2
  const body = ok(await read(c, 'run-a'), 'the read of a running run');
  assert.deepEqual(body.nodes, ['n3'], \`the read answered nodes \${JSON.stringify(body.nodes)}: the cluster reports run-a on ["n3"]; the row's list is stale\`);
  assert(body.state === 'running' && !('reason' in body), \`a running run the cluster knows must read running with no reason, got \${JSON.stringify(body)}\`);
}

export async function check_orphaned_failed(ctx) {
  const {c, runs, queue} = api(ctx);
  await put(runs, queue, 'run-a', 'running');
  await put(runs, queue, 'run-b', 'running');
  ctx.redis.hset('cluster:assignments', 'run-b', 'n5,n6');
  const lost = ok(await read(c, 'run-a'), 'the read of a run the cluster lost');
  const alive = ok(await read(c, 'run-b'), 'the read of a run the cluster knows');
  assert(lost.state === 'failed' && lost.reason === 'not_on_cluster', \`a running run the cluster does not know answered \${JSON.stringify(lost)}: report it failed with reason not_on_cluster, or nobody restarts it\`);
  assert(alive.state === 'running' && !('reason' in alive), \`a running run the cluster knows must read running with no reason, got \${JSON.stringify(alive)}\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"

	"trainsched/queue"
	"trainsched/runs"

	"leetbuild/harness"
)

var readBg = context.Background()

func readAPI(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func putRun(ctx *harness.Ctx, runID, state string, band int, at int64) {
	run := &runs.Run{RunID: runID, Tenant: "t1", RecipeVersion: "llama-ft-v3", DatasetVersion: "ds-1", Priority: 8 - 3*band, Band: band, State: state, EnqueuedAtMs: at, CheckpointID: "ckpt-7"}
	if state == "running" {
		run.Worker = "w-1"
		run.Nodes = []string{"n1", "n2"}
	}
	ctx.NoError(runs.Put(readBg, run), "runs.Put")
	if state == "queued" {
		ctx.NoError(queue.Enqueue(readBg, runID, band, at), "queue.Enqueue")
	}
}

func readAs(c *harness.HTTP, runID, tenant string) *harness.Response {
	if tenant == "" {
		return c.Get("/v1/training/runs/" + runID)
	}
	return c.Get("/v1/training/runs/"+runID, "X-Tenant-Id", tenant)
}

type runView struct {
	RunID         string   \`json:"run_id"\`
	State         string   \`json:"state"\`
	Band          int      \`json:"band"\`
	QueuePosition *int     \`json:"queue_position"\`
	Nodes         []string \`json:"nodes"\`
	Reason        *string  \`json:"reason"\`
}

func readOK(ctx *harness.Ctx, r *harness.Response, what string) runView {
	ctx.Equal(r.Status, 200, "%s (%s)", what, r.Text())
	var v runView
	r.Decode(&v)
	return v
}

func CheckStatusRoute(ctx *harness.Ctx) {
	putRun(ctx, "run-a", "queued", 1, ctx.Clock.Now())
	v := readOK(ctx, readAs(readAPI(ctx), "run-a", "t1"), "the owner's read of a queued run")
	ctx.Assert(v.RunID == "run-a" && v.State == "queued" && v.Band == 1, "the read answered %+v, expected run-a, state queued, band 1", v)
}

func CheckTenantScoped404(ctx *harness.Ctx) {
	putRun(ctx, "run-a", "queued", 1, ctx.Clock.Now())
	c := readAPI(ctx)
	other := readAs(c, "run-a", "t2")
	ctx.Equal(other.Status, 404, "tenant t2 reading t1's run (%s): another tenant's run is 404, as if it did not exist; the status", other.Text())
	ctx.Equal(readAs(c, "run-zzz", "t1").Status, 404, "an unknown run; the status")
	ctx.Equal(readAs(c, "run-a", "").Status, 401, "a read without X-Tenant-Id; the status")
	readOK(ctx, readAs(c, "run-a", "t1"), "the owner's read")
}

func CheckQueuePosition(ctx *harness.Ctx) {
	t0 := ctx.Clock.Now()
	putRun(ctx, "run-a", "queued", 0, t0)
	putRun(ctx, "run-b", "queued", 1, t0)
	putRun(ctx, "run-c", "queued", 1, t0+1)
	c := readAPI(ctx)
	positions := []int{}
	for _, runID := range []string{"run-a", "run-b", "run-c"} {
		v := readOK(ctx, readAs(c, runID, "t1"), "the read of "+runID)
		p := -1
		if v.QueuePosition != nil {
			p = *v.QueuePosition
		}
		positions = append(positions, p)
	}
	ctx.Equal(positions, []int{0, 1, 2}, "run-a starts next (0) and run-c last (2): count from the head with ZRANK; the positions")
}

func CheckClusterNodes(ctx *harness.Ctx) {
	putRun(ctx, "run-a", "running", 1, 0)
	ctx.Redis.Do("HSET", "cluster:assignments", "run-a", "n3") // the cluster moved the run; the row still says n1, n2
	v := readOK(ctx, readAs(readAPI(ctx), "run-a", "t1"), "the read of a running run")
	ctx.Equal(v.Nodes, []string{"n3"}, "the cluster reports run-a on n3 and the row's list is stale; the nodes")
	ctx.Assert(v.State == "running" && v.Reason == nil, "a running run the cluster knows must read running with no reason, got %+v", v)
}

func CheckOrphanedFailed(ctx *harness.Ctx) {
	putRun(ctx, "run-a", "running", 1, 0)
	putRun(ctx, "run-b", "running", 1, 0)
	ctx.Redis.Do("HSET", "cluster:assignments", "run-b", "n5,n6")
	c := readAPI(ctx)
	lost := readOK(ctx, readAs(c, "run-a", "t1"), "the read of a run the cluster lost")
	alive := readOK(ctx, readAs(c, "run-b", "t1"), "the read of a run the cluster knows")
	ctx.Assert(lost.State == "failed" && lost.Reason != nil && *lost.Reason == "not_on_cluster", "a running run the cluster does not know answered state %q: report it failed with reason not_on_cluster, or nobody restarts it", lost.State)
	ctx.Assert(alive.State == "running" && alive.Reason == nil, "a running run the cluster knows must read running with no reason, got %+v", alive)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>

namespace {

harness::HTTP readApi(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

void putRun(const std::string& run_id, const std::string& state, int band, long long at) {
  runs::Run run;
  run.run_id = run_id;
  run.tenant = "t1";
  run.recipe_version = "llama-ft-v3";
  run.dataset_version = "ds-1";
  run.priority = 8 - 3 * band;
  run.band = band;
  run.state = state;
  run.enqueued_at_ms = at;
  run.checkpoint_id = "ckpt-7";
  if (state == "running") {
    run.worker = "w-1";
    run.nodes = {"n1", "n2"};
  }
  runs::put(run);
  if (state == "queued") queue::enqueue(run_id, band, at);
}

harness::Response readAs(harness::HTTP& c, const std::string& run_id, const std::string& tenant) {
  if (tenant.empty()) return c.Get("/v1/training/runs/" + run_id);
  return c.Get("/v1/training/runs/" + run_id, "X-Tenant-Id", tenant);
}

nlohmann::json readOk(harness::Ctx& ctx, const harness::Response& r, const std::string& what) {
  ctx.Equal(r.Status, 200, "%s (%s)", what, r.Text());
  return nlohmann::json::parse(r.Text(), nullptr, false);
}

std::string text(const nlohmann::json& j, const std::string& field) {
  return j.is_object() && j.contains(field) && j[field].is_string() ? j[field].get<std::string>() : "";
}

}  // namespace

void CheckStatusRoute(harness::Ctx& ctx) {
  putRun("run-a", "queued", 1, ctx.Clock.Now());
  auto c = readApi(ctx);
  const auto v = readOk(ctx, readAs(c, "run-a", "t1"), "the owner's read of a queued run");
  ctx.Assert(text(v, "run_id") == "run-a" && text(v, "state") == "queued" && v.value("band", -1) == 1, "the read answered %s, expected run-a, state queued, band 1", v.dump());
}

void CheckTenantScoped404(harness::Ctx& ctx) {
  putRun("run-a", "queued", 1, ctx.Clock.Now());
  auto c = readApi(ctx);
  const auto other = readAs(c, "run-a", "t2");
  ctx.Equal(other.Status, 404, "tenant t2 reading t1's run (%s): another tenant's run is 404, as if it did not exist; the status", other.Text());
  ctx.Equal(readAs(c, "run-zzz", "t1").Status, 404, "an unknown run; the status");
  ctx.Equal(readAs(c, "run-a", "").Status, 401, "a read without X-Tenant-Id; the status");
  readOk(ctx, readAs(c, "run-a", "t1"), "the owner's read");
}

void CheckQueuePosition(harness::Ctx& ctx) {
  const long long t0 = ctx.Clock.Now();
  putRun("run-a", "queued", 0, t0);
  putRun("run-b", "queued", 1, t0);
  putRun("run-c", "queued", 1, t0 + 1);
  auto c = readApi(ctx);
  nlohmann::json positions = nlohmann::json::array();
  for (const std::string run_id : {"run-a", "run-b", "run-c"}) {
    const auto v = readOk(ctx, readAs(c, run_id, "t1"), "the read of " + run_id);
    positions.push_back(v.is_object() && v.contains("queue_position") ? v["queue_position"] : nlohmann::json());
  }
  ctx.Equal(positions, nlohmann::json{0, 1, 2}, "run-a starts next (0) and run-c last (2): count from the head with ZRANK; the positions");
}

void CheckClusterNodes(harness::Ctx& ctx) {
  putRun("run-a", "running", 1, 0);
  ctx.Redis.Do("HSET", "cluster:assignments", "run-a", "n3");  // the cluster moved the run; the row still says n1, n2
  auto c = readApi(ctx);
  const auto v = readOk(ctx, readAs(c, "run-a", "t1"), "the read of a running run");
  ctx.Equal(v.value("nodes", nlohmann::json()), nlohmann::json{"n3"}, "the cluster reports run-a on n3 and the row's list is stale; the nodes");
  ctx.Assert(text(v, "state") == "running" && !v.contains("reason"), "a running run the cluster knows must read running with no reason, got %s", v.dump());
}

void CheckOrphanedFailed(harness::Ctx& ctx) {
  putRun("run-a", "running", 1, 0);
  putRun("run-b", "running", 1, 0);
  ctx.Redis.Do("HSET", "cluster:assignments", "run-b", "n5,n6");
  auto c = readApi(ctx);
  const auto lost = readOk(ctx, readAs(c, "run-a", "t1"), "the read of a run the cluster lost");
  const auto alive = readOk(ctx, readAs(c, "run-b", "t1"), "the read of a run the cluster knows");
  ctx.Assert(text(lost, "state") == "failed" && text(lost, "reason") == "not_on_cluster",
             "a running run the cluster does not know answered %s: report it failed with reason not_on_cluster, or nobody restarts it", lost.dump());
  ctx.Assert(text(alive, "state") == "running" && !alive.contains("reason"), "a running run the cluster knows must read running with no reason, got %s", alive.dump());
}
`,
  },
  hints: [
    'Another tenant can read any run whose id it guesses; the run about to start says it is last in line; a run whose node rebooted an hour ago still shows running on that node.',
    'The handler loads by id and never compares the tenant, `ZREVRANK` counts from the tail of a queue that serves from the head, and every field comes from the row, which nobody updates when the cluster loses or moves a job.',
    'Answer 404 when `run["tenant"] != tenant`; use `ZRANK` for queued runs; for running runs call `cluster.assignment(run_id)`: its nodes when known, else `state: "failed"` and `reason: "not_on_cluster"`.',
  ],
  debrief: `The status endpoint is where the scheduler admits what it does not control: the row records what the scheduler last decided, the cluster records what is actually running, and the answer has to come from the second for anything the cluster owns. That is also why a lost run is reported failed instead of quietly running: the caller's next move, a retry, depends on it. The 404 for another tenant's run keeps run ids from being an oracle, and \`ZRANK\` is simply the queue read the way the claim script reads it. Production schedulers also run a reconciler that writes the cluster's answer back into the row and requeues lost runs from their last checkpoint, so the read stops having to correct the record every time.`,
};
